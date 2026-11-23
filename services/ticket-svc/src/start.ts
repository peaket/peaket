// ticket-svc 조립(BUILD_ORDER HOT-160). main.ts와 서비스 묶음(services/bundle)이 같은 함수를 부른다.
// gRPC 포트는 서비스 안에서 따로 열고, health/management HTTP는 플랫폼 createService가 연다.
// 종료 세션 목록(ADR-0333 결정 2): 듣기 전에 제어 토픽(설정·종료 세션) 소비를 켜고, 서비스를 닫은 뒤 끈다.
import 'reflect-metadata';
import type { Writable } from 'node:stream';
import { type AdminAuthzPort, type Clock, Counter, createDatabase, SCANNER_AUTH_REJECTIONS, type ScannerAuthRejection, createExternalHttpClient, createHotRedis, createService, Gauge, internalGrpcTokenFromEnv, loadPlatformConfig, MemoryDpopReplayStore, reauthJtiStoreFromEnv, type ScannerSessionCheck, systemClock } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { GrpcAdminAuthz } from './adapters/identity-admin-authz.js';
import { loadTicketServiceConfig, TICKET_DB_POOL_MAX } from './config.js';
import { startGrpcServer } from './grpc-server.js';
import { DrizzleDeviceKeyStore } from './modules/ticket/adapters/db/drizzle-device-key-store.js';
import { DrizzleTicketStore } from './modules/ticket/adapters/db/drizzle-ticket-store.js';
import { DrizzleTransferStore } from './modules/ticket/adapters/db/drizzle-transfer-store.js';
import { GrpcMemberCodeDirectory } from './modules/ticket/adapters/identity-member-codes.js';
import { JwksFanReauthGate } from './modules/ticket/adapters/jwks-fan-reauth-gate.js';
import { Transfers, type TransferReauthGate } from './modules/ticket/application/transfers.js';
import { DeviceKeys, type DeviceKeysDeps } from './modules/ticket/application/device-keys.js';
import { DEVICE_KEY_NOTICE_EVERY_MS, DeviceKeyNoticeSender } from './modules/ticket/application/device-key-notices.js';
import { HttpDeviceKeyNoticeSink } from './modules/ticket/adapters/http-key-notice-sink.js';
import type { DeviceKeyNoticeStore, DeviceKeyStore } from './modules/ticket/domain/ports.js';
import { TicketService } from './modules/ticket/application/ticket-service.js';
import { ticketPackage, ticketServiceHandlers, transferLockHandlers } from './modules/ticket/inbound/ticket.grpc.js';
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

/** core-svc 알림 내부 입구 한 번의 시간 상한 2초 [가정](docs/review/plans/F-05-1.md §4, ADR-0363 결정 4) */
export const DEVICE_KEY_NOTICE_TIMEOUT_MS = 2_000;

export interface DeviceKeyAssemblyOptions {
  /** 기기 키 저장소이자 알림 보낼 표(DrizzleDeviceKeyStore, 시험은 MemoryDeviceKeyStore) */
  readonly store: DeviceKeyStore & DeviceKeyNoticeStore;
  /** 팬 재인증 확인기. 양도·돌려주기와 같은 인스턴스를 넘긴다(ADR-0363 결정 1) */
  readonly reauth: NonNullable<DeviceKeysDeps['reauth']>;
  readonly clock: Clock;
  /** core-svc 내부 HTTP 주소(PEAKET_CORE_HTTP_URL). 없으면 보내기 반복을 만들지 않는다(행만 쌓인다) */
  readonly coreHttpUrl?: string;
  /** x-peaket-internal-token(PEAKET_INTERNAL_TOKEN) */
  readonly internalToken?: string;
  /** 시험이 core 내부 입구 대역에 닿게 바꾸는 fetch */
  readonly fetch?: typeof fetch;
  readonly observe?: DeviceKeysDeps['observe'];
  readonly observeNotice?: (result: 'sent' | 'retry') => void;
}

/**
 * 기기 키 등록 유스케이스와 입장 키 알림 보내기를 조립한다(ADR-0363 결정 1·4). start()와 연결 시험이 같은 함수를 부른다.
 * 재인증 확인기를 꽂지 않으면 재발급·입장 시작 뒤 첫 등록이 늘 403이므로(맥락 1) reauth는 필수다
 */
export function assembleDeviceKeys(o: DeviceKeyAssemblyOptions): { deviceKeys: DeviceKeys; notices?: DeviceKeyNoticeSender } {
  const deviceKeys = new DeviceKeys({ store: o.store, clock: o.clock, reauth: o.reauth, ...(o.observe ? { observe: o.observe } : {}) });
  if (!o.coreHttpUrl) return { deviceKeys };
  const client = createExternalHttpClient({
    provider: 'core-svc',
    baseUrl: o.coreHttpUrl,
    timeoutCapMs: DEVICE_KEY_NOTICE_TIMEOUT_MS,
    clock: o.clock,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  const notices = new DeviceKeyNoticeSender({
    store: o.store,
    sink: new HttpDeviceKeyNoticeSink(client, o.internalToken),
    clock: o.clock,
    ...(o.observeNotice ? { observe: o.observeNotice } : {}),
  });
  return { deviceKeys, notices };
}

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
  const internalGrpcToken = internalGrpcTokenFromEnv(env);
  const database = createDatabase({ url: config.databaseUrl, profile: 'hot', max: TICKET_DB_POOL_MAX, applicationName: SERVICE });
  const lbProfile = loadPlatformConfig(env).grpcLbProfile;
  let redis: Awaited<ReturnType<typeof createHotRedis>> | undefined;
  let adminAuthz: (AdminAuthzPort & { close?(): void }) | undefined;
  let scannerSessions: (ScannerSessionCheck & { terminateByDevice(i: { deviceId: string; reason: 'DEVICE_REVOKED'; atMs: number }): Promise<number>; close?(): void }) | undefined;
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let grpc: Awaited<ReturnType<typeof startGrpcServer>> | undefined;
  let alert: ((message: string, fields: Record<string, unknown>) => void) | undefined;
  let freshnessTimer: ReturnType<typeof setInterval> | undefined;
  let expireTimer: ReturnType<typeof setInterval> | undefined;
  let noticeTimer: ReturnType<typeof setInterval> | undefined;
  let controlSync: { close(): Promise<void> } | undefined;
  // 스캐너 가드 거절 이유 지표(O-T37 ⑨). 서비스 지표 묶음은 createService 뒤에 생기므로 그때 잇는다
  let scannerRejections: Counter<'service' | 'reason'> | undefined;
  try {
    const gateStore = new DrizzleScannerGateStore(database);
    const shiftStore = new DrizzleScannerShiftStore(database);
    const deviceKeyStore = new DrizzleDeviceKeyStore({ database, changes: gateStore });
    const store = new DrizzleTicketStore({ database, changes: gateStore, deviceKeys: deviceKeyStore });
    const ticket = new TicketService({ store, clock: systemClock });
    const scannerStore = new DrizzleScannerDeviceStore(database);
    const scannerCommands = new DrizzleScannerDeviceCommandStore(database);
    redis = config.redisUrl ? await createHotRedis({ url: config.redisUrl }) : undefined;
    // 양도·돌려주기(GAT-050·055): 행 잠금 저장소, 재인증 확인기, 회원 코드 찾기.
    // 팬 공개키 묶음 주소가 없으면 local·ci만 닫힌 대역(늘 403)이고, 그 밖 환경은 설정이 시작을 막는다
    const transferStore = new DrizzleTransferStore({ database, deviceKeys: deviceKeyStore });
    const jti = reauthJtiStoreFromEnv(env, redis);
    const reauth: TransferReauthGate = config.identityFanJwksUrl
      ? new JwksFanReauthGate({ jwksUrl: config.identityFanJwksUrl, issuer: config.identityIssuer ?? 'https://identity.peaket.example', jti, clock: systemClock })
      : { verify: async () => false };
    // 기기 키 등록(GAT-020, ADR-0363 결정 1·4): 양도와 같은 재인증 확인기를 꽂고, 알림 보내기 반복을 core-svc 내부 입구에 잇는다.
    // 지표는 서비스를 만든 뒤 잇는다(registrationMetric·noticeMetric)
    let registrationMetric: DeviceKeysDeps['observe'];
    let noticeMetric: ((result: 'sent' | 'retry') => void) | undefined;
    const { deviceKeys, notices } = assembleDeviceKeys({
      store: deviceKeyStore,
      reauth,
      clock: systemClock,
      ...(config.coreHttpUrl ? { coreHttpUrl: config.coreHttpUrl } : {}),
      ...(config.internalToken ? { internalToken: config.internalToken } : {}),
      observe: (r) => registrationMetric?.(r),
      observeNotice: (r) => noticeMetric?.(r),
    });
    const memberCodes = config.identityGrpcUrl ? new GrpcMemberCodeDirectory(config.identityGrpcUrl, lbProfile) : undefined;
    const transfers = new Transfers({
      store: transferStore,
      reauth,
      recipientRefSecret: config.transferRefSecret,
      clock: systemClock,
      directory: {
        resolveMemberCode: async (code: string) => {
          if (!memberCodes) throw new Error('PEAKET_IDENTITY_GRPC_URL이 없어 회원 코드를 찾지 못한다');
          return memberCodes.resolveMemberCode(code);
        },
      },
    });
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
    const opsAlertSink = config.opsHttpUrl
      ? new HttpOpsAlertSink(createExternalHttpClient({ provider: 'ops-svc', baseUrl: config.opsHttpUrl, timeoutCapMs: 2_000, clock: systemClock }), config.internalToken)
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
      // 파트너 테넌트당 600회/분 공용 가드(BAT-173, D-T50 ⑦). ticket-svc의 Redis는 세션·캐시 클러스터다(architecture §3.1)
      ...(redis ? { tenantRateLimit: { redis } } : {}),
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
          sessionLookup: scannerSessions,
          commands: scannerCommands,
          ...(config.scannerMtlsSecret ? { mtlsSecret: config.scannerMtlsSecret } : {}),
          alert: (message, fields) => alert?.(message, fields),
          ...(opsAlertSink ? { opsAlert: opsAlertSink } : {}),
          maxOfflineMs: config.scannerMaxOfflineMs,
          scannerPwaOrigin: config.scannerPwaOrigin,
        },
        ticket: { deviceKeys, tickets: ticket, transfers },
      }),
      adminAuthz,
      scanner: {
        devices: scannerStore,
        sessions: scannerSessions,
        replay,
        ...(config.scannerMtlsSecret ? { mtls: { secret: config.scannerMtlsSecret } } : {}),
        ...(config.publicOrigin ? { publicOrigin: config.publicOrigin } : {}),
        onRejected: (reason: ScannerAuthRejection) => scannerRejections?.inc({ service: SERVICE, reason }),
      },
      ...(o.logDestination ? { logDestination: o.logDestination } : {}),
    });
    scannerRejections = new Counter({
      name: 'scanner_auth_rejections_total',
      help: '스캐너 기기 증명·세션 판정에서 거절하거나 닫은 요청 수(O-T37 ⑨, reason은 offline-gate §6.1 이름표)',
      labelNames: ['service', 'reason'],
      registers: [service.metrics.registry],
    });
    for (const reason of SCANNER_AUTH_REJECTIONS) scannerRejections.inc({ service: SERVICE, reason }, 0);
    alert = (message, fields) => service!.logger.warn(fields, message);
    // 양도 요청 만료 정비(RV-01): 1분 [가정]마다 기한 지난 OFFERED를 EXPIRED로 바꾸고 표시를 푼다.
    // 새 요청을 만들 때도 저장소가 먼저 만료시키므로 이 고리가 늦어도 막히지 않는다. 파드가 여럿이면 행 잠금으로 겹쳐도 한 번만 바뀐다
    const expire = (): void => {
      void transfers
        .expireOffers()
        .then((n) => {
          if (n > 0) service!.logger.info({ expired: n }, '기한 지난 양도 요청을 만료시켰다');
        })
        .catch((err: unknown) => service!.logger.warn({ err }, '양도 요청 만료 정비가 실패했다(다음 틱에 다시 한다)'));
    };
    expireTimer = setInterval(expire, 60_000);
    expireTimer.unref?.();
    expire();
    // 기기 키 등록 지표·로그 줄(docs/features/offline-gate.md §10.1). 계정·keyId는 싣지 않는다
    const registrations = new Counter({
      name: 'ticket_device_key_registrations_total',
      help: '입장용 기기 키 등록 수(reason, result, offline-gate §10.1)',
      labelNames: ['service', 'reason', 'result'],
      registers: [service.metrics.registry],
    });
    registrationMetric = ({ reason, result }) => {
      registrations.inc({ service: SERVICE, reason, result });
      if (result !== 'registered' && result !== 'unchanged') service!.logger.info({ kind: 'device-key.rejected', reason, result }, 'device-key.rejected');
    };
    // 입장 키 알림 보내기 반복(ADR-0363 결정 4). core-svc 주소가 없으면 돌지 않고 행만 쌓인다
    const noticeSent = new Counter({
      name: 'ticket_device_key_notice_sent_total',
      help: '입장 키 알림 보내기 결과 수(result=sent·retry, offline-gate §10.1)',
      labelNames: ['service', 'result'],
      registers: [service.metrics.registry],
    });
    noticeMetric = (result) => noticeSent.inc({ service: SERVICE, result });
    const noticeBacklog = new Gauge({ name: 'ticket_device_key_notice_backlog', help: '보내지 않은 입장 키 알림 행 수(offline-gate §10.1)', labelNames: ['service'], registers: [service.metrics.registry] });
    const noticeOldest = new Gauge({
      name: 'ticket_device_key_notice_oldest_seconds',
      help: '가장 오래된 보내지 않은 입장 키 알림 행의 나이(초, offline-gate §10.1)',
      labelNames: ['service'],
      registers: [service.metrics.registry],
    });
    if (notices) {
      const sendNotices = (): void => {
        void notices
          .runOnce()
          .then(() => notices.backlog())
          .then((b) => {
            noticeBacklog.set({ service: SERVICE }, b.count);
            noticeOldest.set({ service: SERVICE }, b.oldestSeconds);
          })
          .catch((err: unknown) => service!.logger.warn({ err: err instanceof Error ? err.message : String(err) }, '입장 키 알림 보내기가 실패했다(다음 틱에 다시 한다)'));
      };
      noticeTimer = setInterval(sendNotices, DEVICE_KEY_NOTICE_EVERY_MS);
      noticeTimer.unref?.();
      sendNotices();
      if (!config.internalToken) service.logger.warn({}, 'PEAKET_INTERNAL_TOKEN이 없어 입장 키 알림이 core-svc에서 401로 거절될 수 있다');
    } else {
      service.logger.warn({}, 'PEAKET_CORE_HTTP_URL이 없어 입장 키 알림을 보내지 않는다(device_key_notice 행만 쌓인다)');
    }
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
        sink: opsAlertSink!,
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
    // 종료 세션 목록(ADR-0333 결정 2): 듣기 전에 두 제어 토픽을 읽기 시작한다(다 읽어야 /ready 200). 브로커가 없으면 local·ci만 경고로 끄고 그 밖은 여기서 시작에 실패한다.
    // Kafka 클라이언트(네이티브 모듈)는 이 시작 함수를 부를 때 싣는다
    const { startServiceControlSync } = await import('@peaket/platform/stream-worker');
    controlSync = startServiceControlSync(service, env);
    const httpPorts = await service.listen();
    grpc = await startGrpcServer({
      host: config.grpcHost,
      // 포트는 ticket-svc 설정(기본 50052)이다. 부하 분산 프로필·호출 지표는 공용 설정·지표 묶음을 쓴다(BUILD_ORDER BAS-080)
      port: config.grpcPort,
      profile: service.config.grpcLbProfile,
      metrics: service.metrics,
      services: [
        {
          definition: ticketPackage().TicketService.service,
          handlers: ticketServiceHandlers(
            { ticket, nowMs: () => systemClock.now() },
            (method, err, orderId) => {
              service!.logger.error({ method, ...(orderId ? { orderId } : {}), err }, 'TicketService 처리 실패');
            },
            // 운영자 취소·회차 취소 표 끝내기·입장 기록 대조는 내부 토큰 + 호출자 purchase-svc만 받는다(리뷰 B6, BAT-420 리뷰 D4)
            { ...(internalGrpcToken ? { internalToken: internalGrpcToken } : {}) },
          ),
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
        {
          // 부정 예매 양도 잠금(ops-svc만, GAT-055). 내부 토큰·호출자 검사는 처리기가 한다
          definition: ticketPackage().TransferLockService.service,
          handlers: transferLockHandlers({ setTransferLock: (i) => transfers.setTransferLock(i) }, (method, err) => {
            service!.logger.error({ method, err }, 'TransferLockService 처리 실패');
          }, { ...(internalGrpcToken ? { internalToken: internalGrpcToken } : {}) }),
        },
      ],
      internal: { ...(internalGrpcToken ? { token: internalGrpcToken } : {}), services: ['peaket.ticket.v1.ScannerDeviceService'] },
    });
    service.readiness.complete('grpc');
    service.logger.info({ port: grpc.port }, '업무 gRPC 포트를 열었다');

    const started = service;
    const startedGrpc = grpc;
    const startedSync = controlSync;
    const ports = { appPort: httpPorts.port, managementPort: httpPorts.managementPort, grpcPort: grpc.port };
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      started.readiness.register('shutting-down');
      if (freshnessTimer) clearInterval(freshnessTimer);
      if (expireTimer) clearInterval(expireTimer);
      if (noticeTimer) clearInterval(noticeTimer);
      return (closing ??= (async () => {
        try {
          await startedGrpc.close();
          await started.close();
        } finally {
          // 종료 세션 목록 소비는 서비스를 닫은 뒤(처리 중인 요청이 끝난 뒤) 끈다
          await startedSync?.close();
          adminAuthz?.close?.();
          scannerSessions?.close?.();
          memberCodes?.close();
          await redis?.close().catch(() => {});
          await database.close();
        }
      })());
    };
    return { close, ports };
  } catch (err) {
    if (freshnessTimer) clearInterval(freshnessTimer);
    if (expireTimer) clearInterval(expireTimer);
    if (noticeTimer) clearInterval(noticeTimer);
    await grpc?.close().catch(() => {});
    await service?.close().catch(() => {});
    await controlSync?.close();
    adminAuthz?.close?.();
    scannerSessions?.close?.();
    await redis?.close().catch(() => {});
    await database.close().catch(() => {});
    throw err;
  }
}
