// ticket-svc 조립(BUILD_ORDER HOT-160). main.ts와 서비스 묶음(services/bundle)이 같은 함수를 부른다.
// gRPC 포트는 서비스 안에서 따로 열고, health/management HTTP는 플랫폼 createService가 연다.
import 'reflect-metadata';
import type { Writable } from 'node:stream';
import { type AdminAuthzPort, Counter, createDatabase, createExternalHttpClient, createHotRedis, createService, Gauge, loadPlatformConfig, MemoryDpopReplayStore, type ScannerSessionCheck, systemClock } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { GrpcAdminAuthz } from './adapters/identity-admin-authz.js';
import { loadTicketServiceConfig, TICKET_DB_POOL_MAX } from './config.js';
import { startGrpcServer } from './grpc-server.js';
import { DrizzleDeviceKeyStore } from './modules/ticket/adapters/db/drizzle-device-key-store.js';
import { DrizzleTicketStore } from './modules/ticket/adapters/db/drizzle-ticket-store.js';
import { DeviceKeys } from './modules/ticket/application/device-keys.js';
import { TicketService } from './modules/ticket/application/ticket-service.js';
import { ticketPackage, ticketServiceHandlers } from './modules/ticket/inbound/ticket.grpc.js';
import { scannerDeviceHandlers } from './modules/scanner/inbound/scanner-device.grpc.js';
import { scannerDeviceLookupHandlers } from './modules/scanner/inbound/scanner-device-lookup.grpc.js';
import {
  DrizzleScannerDeviceCommandStore,
  DrizzleScannerDeviceStore,
  DrizzleScannerGateStore,
  DrizzleScannerShiftStore,
  GrpcScannerSessionCheck,
  HttpCoreEventPolicy,
  HttpOpsAlertSink,
  MemoryEnrollmentAttemptLimiter,
  MemoryEnrollmentCodeStore,
  RedisDpopReplayStore,
  RedisEnrollmentAttemptLimiter,
  RedisEnrollmentCodeStore,
  ScannerDevices,
  ScannerFreshness,
  SCANNER_FRESHNESS_ALERT_MS,
} from './modules/scanner/index.js';

const SERVICE = 'ticket-svc';

export interface StartOptions {
  env: Record<string, string | undefined>;
  logDestination?: Writable;
}

export interface StartedService {
  close(): Promise<void>;
  ports: { appPort: number; managementPort: number; grpcPort: number };
}

export async function start(o: StartOptions): Promise<StartedService> {
  const { env } = o;
  const config = loadTicketServiceConfig(env);
  const database = createDatabase({ url: config.databaseUrl, profile: 'hot', max: TICKET_DB_POOL_MAX, applicationName: SERVICE });
  const lbProfile = loadPlatformConfig(env).grpcLbProfile;
  let redis: Awaited<ReturnType<typeof createHotRedis>> | undefined;
  let adminAuthz: (AdminAuthzPort & { close?(): void }) | undefined;
  let scannerSessions: (ScannerSessionCheck & { terminateByDevice(i: { deviceId: string; reason: 'DEVICE_REVOKED'; atMs: number }): Promise<number>; close?(): void }) | undefined;
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let grpc: Awaited<ReturnType<typeof startGrpcServer>> | undefined;
  let alert: ((message: string, fields: Record<string, unknown>) => void) | undefined;
  let freshnessTimer: ReturnType<typeof setInterval> | undefined;
  try {
    const gateStore = new DrizzleScannerGateStore(database);
    const shiftStore = new DrizzleScannerShiftStore(database);
    const deviceKeyStore = new DrizzleDeviceKeyStore({ database, changes: gateStore });
    const store = new DrizzleTicketStore({ database, changes: gateStore, deviceKeys: deviceKeyStore });
    const ticket = new TicketService({ store, clock: systemClock });
    const deviceKeys = new DeviceKeys({ store: deviceKeyStore, clock: systemClock });
    const scannerStore = new DrizzleScannerDeviceStore(database);
    const scannerCommands = new DrizzleScannerDeviceCommandStore(database);
    redis = config.redisUrl ? await createHotRedis({ url: config.redisUrl }) : undefined;
    const codes = redis ? new RedisEnrollmentCodeStore(redis) : new MemoryEnrollmentCodeStore(systemClock);
    const replay = redis ? new RedisDpopReplayStore(redis) : new MemoryDpopReplayStore(systemClock);
    const limiter = redis ? new RedisEnrollmentAttemptLimiter(redis) : new MemoryEnrollmentAttemptLimiter(() => systemClock.now());
    const policy = config.coreHttpUrl
      ? new HttpCoreEventPolicy({
          client: createExternalHttpClient({ provider: 'core-svc', baseUrl: config.coreHttpUrl, timeoutCapMs: 300, clock: systemClock }),
          clock: systemClock,
          ...(config.internalToken ? { internalToken: config.internalToken } : {}),
        })
      : undefined;
    // identity 주소가 없으면 스캐너 세션 확인은 503, 관제 역할 판정은 401로 닫는다(대역으로 통과시키지 않는다)
    adminAuthz = config.identityGrpcUrl ? new GrpcAdminAuthz(config.identityGrpcUrl, lbProfile) : { getAdminAuthz: async () => ({ valid: false, role: '' }) };
    scannerSessions = config.identityGrpcUrl
      ? new GrpcScannerSessionCheck(config.identityGrpcUrl, lbProfile)
      : {
          check: async () => {
            throw new Error('PEAKET_IDENTITY_GRPC_URL이 없어 스캐너 세션을 확인하지 못한다');
          },
          terminateByDevice: async () => {
            throw new Error('PEAKET_IDENTITY_GRPC_URL이 없어 스캐너 세션을 끝내지 못한다');
          },
        };
    service = await createService({
      name: SERVICE,
      env,
      module: AppModule.register({
        scanner: {
          store: scannerStore,
          codes,
          replay,
          gate: gateStore,
          shift: shiftStore,
          ...(policy ? { policy } : {}),
          limiter,
          sessions: scannerSessions,
          commands: scannerCommands,
          alert: (message, fields) => alert?.(message, fields),
          maxOfflineMs: config.scannerMaxOfflineMs,
        },
        ticket: { deviceKeys },
      }),
      adminAuthz,
      scanner: {
        devices: scannerStore,
        sessions: scannerSessions,
        replay,
        ...(config.scannerMtlsSecret ? { mtls: { secret: config.scannerMtlsSecret } } : {}),
      },
      ...(o.logDestination ? { logDestination: o.logDestination } : {}),
    });
    alert = (message, fields) => service!.logger.warn(fields, message);
    // O-T20: 입장 시간대에 2분 넘게 변경분을 받지 못한 스캐너를 ops-svc SEV2 경보로 넘긴다(기존 ops_alert 경로).
    if (config.opsHttpUrl) {
      const freshnessAlerts = new Counter({
        name: 'scanner_freshness_alerts_total',
        help: '스캐너 변경분 신선도 경보 수(O-T20, result=open·resolve·error)',
        labelNames: ['service', 'result'],
        registers: [service.metrics.registry],
      });
      const freshnessOpen = new Gauge({
        name: 'scanner_freshness_open_alerts',
        help: '지금 열려 있는 스캐너 변경분 신선도 경보 수(O-T20)',
        labelNames: ['service'],
        registers: [service.metrics.registry],
      });
      const freshness = new ScannerFreshness({
        devices: scannerStore,
        shifts: shiftStore,
        ...(policy ? { policy } : {}),
        sink: new HttpOpsAlertSink(createExternalHttpClient({ provider: 'ops-svc', baseUrl: config.opsHttpUrl, timeoutCapMs: 2_000, clock: systemClock }), config.internalToken),
        clock: systemClock,
        log: service.logger,
        metric: (result) => freshnessAlerts.inc({ service: SERVICE, result }),
      });
      const tick = (): void => {
        void freshness
          .run()
          .then(() => freshnessOpen.set({ service: SERVICE }, freshness.openAlerts()))
          .catch((err: unknown) => service!.logger.warn({ err: err instanceof Error ? err.message : String(err) }, '스캐너 신선도 감시가 실패했다'));
      };
      freshnessTimer = setInterval(tick, 30_000);
      freshnessTimer.unref?.();
      tick();
      if (!config.internalToken) service.logger.warn({}, 'PEAKET_INTERNAL_TOKEN이 없어 스캐너 신선도 경보가 ops-svc에서 401로 거절될 수 있다');
      service.logger.info({ thresholdMs: SCANNER_FRESHNESS_ALERT_MS, everyMs: 30_000 }, '스캐너 변경분 신선도 감시를 켰다(O-T20)');
    } else {
      service.logger.warn({}, 'PEAKET_OPS_HTTP_URL이 없어 스캐너 신선도 경보(O-T20)를 내지 않는다');
    }
    service.readiness.register('grpc');
    const httpPorts = await service.listen();
    grpc = await startGrpcServer({
      host: config.grpcHost,
      port: config.grpcPort,
      services: [
        {
          definition: ticketPackage().TicketService.service,
          handlers: ticketServiceHandlers({ ticket, nowMs: () => systemClock.now() }, (method, err, orderId) => {
            service!.logger.error({ method, ...(orderId ? { orderId } : {}), err }, 'TicketService 처리 실패');
          }),
        },
        {
          definition: ticketPackage().ScannerDeviceLookupService.service,
          handlers: scannerDeviceLookupHandlers({ store: scannerStore }, (method, err) => {
            service!.logger.error({ method, err }, 'ScannerDeviceLookupService 처리 실패');
          }),
        },
        {
          definition: ticketPackage().ScannerDeviceService.service,
          handlers: scannerDeviceHandlers(service.app.get(ScannerDevices), (method, err) => {
            service!.logger.error({ method, err }, 'ScannerDeviceService 처리 실패');
          }),
        },
      ],
    });
    service.readiness.complete('grpc');
    service.logger.info({ port: grpc.port }, '업무 gRPC 포트를 열었다');

    const started = service;
    const startedGrpc = grpc;
    const ports = { appPort: httpPorts.port, managementPort: httpPorts.managementPort, grpcPort: grpc.port };
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      started.readiness.register('shutting-down');
      if (freshnessTimer) clearInterval(freshnessTimer);
      return (closing ??= (async () => {
        try {
          await startedGrpc.close();
          await started.close();
        } finally {
          adminAuthz?.close?.();
          scannerSessions?.close?.();
          await redis?.close().catch(() => {});
          await database.close();
        }
      })());
    };
    return { close, ports };
  } catch (err) {
    if (freshnessTimer) clearInterval(freshnessTimer);
    await grpc?.close().catch(() => {});
    await service?.close().catch(() => {});
    adminAuthz?.close?.();
    scannerSessions?.close?.();
    await redis?.close().catch(() => {});
    await database.close().catch(() => {});
    throw err;
  }
}
