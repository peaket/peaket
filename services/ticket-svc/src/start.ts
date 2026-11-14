// ticket-svc 조립(BUILD_ORDER HOT-160). main.ts와 서비스 묶음(services/bundle)이 같은 함수를 부른다.
// gRPC 포트는 서비스 안에서 따로 열고, health/management HTTP는 플랫폼 createService가 연다.
import 'reflect-metadata';
import type { Writable } from 'node:stream';
import { type AdminAuthzPort, createDatabase, createExternalHttpClient, createHotRedis, createService, loadPlatformConfig, MemoryDpopReplayStore, type ScannerSessionCheck, systemClock } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { GrpcAdminAuthz } from './adapters/identity-admin-authz.js';
import { loadTicketServiceConfig, TICKET_DB_POOL_MAX } from './config.js';
import { startGrpcServer } from './grpc-server.js';
import { DrizzleDeviceKeyStore } from './modules/ticket/adapters/db/drizzle-device-key-store.js';
import { DrizzleTicketStore } from './modules/ticket/adapters/db/drizzle-ticket-store.js';
import { DeviceKeys } from './modules/ticket/application/device-keys.js';
import { TicketService } from './modules/ticket/application/ticket-service.js';
import { ticketPackage, ticketServiceHandlers } from './modules/ticket/inbound/ticket.grpc.js';
import { scannerDeviceLookupHandlers } from './modules/scanner/inbound/scanner-device-lookup.grpc.js';
import {
  DrizzleScannerDeviceStore,
  DrizzleScannerGateStore,
  DrizzleScannerShiftStore,
  GrpcScannerSessionCheck,
  HttpCoreEventPolicy,
  MemoryEnrollmentAttemptLimiter,
  MemoryEnrollmentCodeStore,
  RedisDpopReplayStore,
  RedisEnrollmentAttemptLimiter,
  RedisEnrollmentCodeStore,
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
  try {
    const gateStore = new DrizzleScannerGateStore(database);
    const shiftStore = new DrizzleScannerShiftStore(database);
    const deviceKeyStore = new DrizzleDeviceKeyStore({ database, changes: gateStore });
    const store = new DrizzleTicketStore({ database, changes: gateStore, deviceKeys: deviceKeyStore });
    const ticket = new TicketService({ store, clock: systemClock });
    const deviceKeys = new DeviceKeys({ store: deviceKeyStore, clock: systemClock });
    const scannerStore = new DrizzleScannerDeviceStore(database);
    redis = config.redisUrl ? await createHotRedis({ url: config.redisUrl }) : undefined;
    const codes = redis ? new RedisEnrollmentCodeStore(redis) : new MemoryEnrollmentCodeStore(systemClock);
    const replay = redis ? new RedisDpopReplayStore(redis) : new MemoryDpopReplayStore(systemClock);
    const limiter = redis ? new RedisEnrollmentAttemptLimiter(redis) : new MemoryEnrollmentAttemptLimiter(() => systemClock.now());
    const policy = config.coreHttpUrl
      ? new HttpCoreEventPolicy({
          client: createExternalHttpClient({ provider: 'core-svc', baseUrl: config.coreHttpUrl, timeoutCapMs: 300, clock: systemClock }),
          clock: systemClock,
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
          alert: (message, fields) => alert?.(message, fields),
          maxOfflineMs: config.scannerMaxOfflineMs,
        },
        ticket: { deviceKeys },
      }),
      adminAuthz,
      scanner: { devices: scannerStore, sessions: scannerSessions, replay },
      ...(o.logDestination ? { logDestination: o.logDestination } : {}),
    });
    alert = (message, fields) => service!.logger.warn(fields, message);
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
    await grpc?.close().catch(() => {});
    await service?.close().catch(() => {});
    adminAuthz?.close?.();
    scannerSessions?.close?.();
    await redis?.close().catch(() => {});
    await database.close().catch(() => {});
    throw err;
  }
}
