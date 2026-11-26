// ticket-svc 조립(BUILD_ORDER HOT-160). main.ts와 서비스 묶음(services/bundle)이 같은 함수를 부른다.
// gRPC 포트는 서비스 안에서 따로 열고, health/management HTTP는 플랫폼 createService가 연다.
// 종료 세션 목록(ADR-0333 결정 2): 듣기 전에 제어 토픽(설정·종료 세션) 소비를 켜고, 서비스를 닫은 뒤 끈다.
import 'reflect-metadata';
import type { Writable } from 'node:stream';
import { type AdminAuthzPort, type Clock, Counter, createDatabase, SCANNER_AUTH_REJECTIONS, type ScannerAuthRejection, createExternalHttpClient, createHotRedis, createService, Gauge, internalGrpcTokenFromEnv, loadPlatformConfig, MemoryDpopReplayStore, outboxHealth, reauthJtiStoreFromEnv, type ScannerSessionCheck, systemClock } from '@peaket/platform';
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
import { TransferWithdrawal } from './modules/ticket/application/account-withdrawal.js';
import { TRANSFER_NOTICE_EVERY_MS, TransferNoticeSender } from './modules/ticket/application/transfer-notices.js';
import { HttpTransferNoticeSink } from './modules/ticket/adapters/http-transfer-notice-sink.js';
import { createAvroEncoder, readSchemaIdsFile } from '@peaket/platform/avro';
import { avroSchemas, localSchemaIds } from '@peaket/contracts/avro';
import { ticketEventCodec } from './modules/ticket/adapters/ticket-event-codec.js';
import { transferEventWithdrawalHandlers, transferWithdrawalHandlers } from './modules/ticket/inbound/transfer-withdrawal.grpc.js';
import { DeviceKeys, type DeviceKeysDeps } from './modules/ticket/application/device-keys.js';
import { DEVICE_KEY_NOTICE_EVERY_MS, DeviceKeyNoticeSender } from './modules/ticket/application/device-key-notices.js';
import { HttpDeviceKeyNoticeSink } from './modules/ticket/adapters/http-key-notice-sink.js';
import type { DeviceKeyNoticeStore, DeviceKeyStore } from './modules/ticket/domain/ports.js';
import { TicketService } from './modules/ticket/application/ticket-service.js';
import { ticketPackage, ticketServiceHandlers, transferLockHandlers } from './modules/ticket/inbound/ticket.grpc.js';
import { scannerDeviceHandlers } from './modules/scanner/inbound/scanner-device.grpc.js';
import { scannerDeviceLookupHandlers } from './modules/scanner/inbound/scanner-device-lookup.grpc.js';
import {
  DrizzleEntryCloseStore,
  DrizzleScannerDeviceCommandStore,
  DrizzleScannerDeviceStore,
  DrizzleScannerGateStore,
  DrizzleScannerShiftStore,
  EntryCloseTick,
  ENTRY_CLOSE_EVERY_MS,
  GrpcScannerSessionCheck,
  HttpCoreEntryClose,
  HttpCoreEventPolicy,
  HttpOpsAlertSink,
  HttpOpsCaseSink,
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
  /** 입장 기록 마감 판단 주기(기본 ENTRY_CLOSE_EVERY_MS). 시험이 줄인다 */
  entryCloseEveryMs?: number;
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
  let transferNoticeTimer: ReturnType<typeof setInterval> | undefined;
  let transferNoticeMetric: ((o: { readonly type: string; readonly result: 'sent' | 'retry' }) => void) | undefined;
  let entryCloseTimer: ReturnType<typeof setInterval> | undefined;
  let controlSync: { close(): Promise<void> } | undefined;
  // 스캐너 가드 거절 이유 지표(O-T37 ⑨). 서비스 지표 묶음은 createService 뒤에 생기므로 그때 잇는다
  let scannerRejections: Counter<'service' | 'reason'> | undefined;
  try {
    const gateStore = new DrizzleScannerGateStore(database);
    // trade.tickets Outbox 값은 Confluent Avro다(ADR-0357). local·ci·demo는 계약의 고정 스키마 ID, 그 밖은 ConfigMap이 필수다
    const localEnv = env.PEAKET_ENV === 'local' || env.PEAKET_ENV === 'ci' || env.PEAKET_ENV === 'demo';
    const schemaIds = localEnv ? localSchemaIds : readSchemaIdsFile(env);
    const transferEventCodec = ticketEventCodec(
      createAvroEncoder({ schemaIds, schemas: avroSchemas, produces: [{ topic: 'trade.tickets', record: 'peaket.trade.TicketEvent' }] }),
    );
    const shiftStore = new DrizzleScannerShiftStore(database);
    const entryCloseStore = new DrizzleEntryCloseStore(database);
    const deviceKeyStore = new DrizzleDeviceKeyStore({ database, changes: gateStore });
    const store = new DrizzleTicketStore({ database, changes: gateStore, deviceKeys: deviceKeyStore, clock: systemClock, outboxCodec: transferEventCodec });
    const ticket = new TicketService({ store, clock: systemClock });
    const scannerStore = new DrizzleScannerDeviceStore(database);
    const scannerCommands = new DrizzleScannerDeviceCommandStore(database);
    redis = config.redisUrl ? await createHotRedis({ url: config.redisUrl }) : undefined;
    // 양도·돌려주기(GAT-050·055): 행 잠금 저장소, 재인증 확인기, 회원 코드 찾기.
    // 팬 공개키 묶음 주소가 없으면 local·ci만 닫힌 대역(늘 403)이고, 그 밖 환경은 설정이 시작을 막는다
    const transferStore = new DrizzleTransferStore({ database, deviceKeys: deviceKeyStore, clock: systemClock, outboxCodec: transferEventCodec });
    const jti = reauthJtiStoreFromEnv(env, redis);
    const reauth: TransferReauthGate = config.identityFanJwksUrl
      ? new JwksFanReauthGate({ jwksUrl: config.identityFanJwksUrl, issuer: config.identityIssuer ?? 'https://identity.peaket.example', jti, clock: systemClock })
      : { verify: async () => false };
    // 기기 키 등록(GAT-020, ADR-0363 결정 1·4): 양도와 같은 재인증 확인기를 꽂고, 알림 보내기 반복을 core-svc 내부 입구에 잇는다.
    // 지표는 서비스를 만든 뒤 잇는다(registrationMetric·noticeMetric)
    let registrationMetric: DeviceKeysDeps['observe'];
    let noticeMetric: ((result: 'sent' | 'retry') => void) | undefined;
    // 스캔 판정·POLICY 지표(offline-gate §10.2). 서비스 지표 묶음은 createService 뒤에 생기므로 그때 잇는다
    let scanStored: ((result: 'PASS' | 'REJECT' | 'CHECK' | 'duplicate') => void) | undefined;
    let policyChanged: ((i: { eventId: string; reentryAllowed: boolean; seq: number }) => void) | undefined;
    let queueReported: ((result: 'empty' | 'pending' | 'no_placement') => void) | undefined;
    const { deviceKeys, notices } = assembleDeviceKeys({
      store: deviceKeyStore,
      reauth,
      clock: systemClock,
      ...(config.coreHttpUrl ? { coreHttpUrl: config.coreHttpUrl } : {}),
      ...(config.internalToken ? { internalToken: config.internalToken } : {}),
      observe: (r) => registrationMetric?.(r),
      observeNotice: (r) => noticeMetric?.(r),
    });
    const memberCodes = config.identityGrpcUrl ? new GrpcMemberCodeDirectory(config.identityGrpcUrl, lbProfile, { ...(internalGrpcToken ? { internalToken: internalGrpcToken } : {}) }) : undefined;
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
        resolvePhone: async (digits: string) => {
          if (!memberCodes) throw new Error('PEAKET_IDENTITY_GRPC_URL이 없어 휴대폰 번호를 찾지 못한다');
          return memberCodes.resolvePhone!(digits);
        },
        resolveNicknames: async (ids: readonly string[]) => {
          if (!memberCodes) throw new Error('PEAKET_IDENTITY_GRPC_URL이 없어 닉네임을 찾지 못한다');
          return memberCodes.resolveNicknames!(ids);
        },
      },
    });
    const transferWithdrawal = new TransferWithdrawal({ transfers, store: transferStore, clock: systemClock });
    const transferNotices = config.coreHttpUrl
      ? new TransferNoticeSender({
          store: transferStore,
          sink: new HttpTransferNoticeSink(
            createExternalHttpClient({ provider: 'core-svc', baseUrl: config.coreHttpUrl, timeoutCapMs: DEVICE_KEY_NOTICE_TIMEOUT_MS, clock: systemClock }),
            config.internalToken,
          ),
          clock: systemClock,
          observe: (o) => transferNoticeMetric?.(o),
        })
      : undefined;
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
          onScanStored: (result) => scanStored?.(result),
          onPolicyChanged: (i) => policyChanged?.(i),
          onQueueReport: (result) => queueReported?.(result),
          entryClose: entryCloseStore,
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
    // 양도 알림·Outbox 지표(정본 §13). 계정·티켓 ID는 싣지 않는다
    const transferNoticeCounter = new Counter({
      name: 'ticket_transfer_notices_total',
      help: '양도 알림 보내기 결과(type, result)',
      labelNames: ['service', 'type', 'result'],
      registers: [service.metrics.registry],
    });
    transferNoticeMetric = (o) => transferNoticeCounter.inc({ service: SERVICE, type: o.type, result: o.result });
    const transferOutboxLag = new Gauge({
      name: 'ticket_transfer_outbox_lag_seconds',
      help: '보내지 않은 trade.tickets Outbox 행의 가장 오래된 나이(초)',
      labelNames: ['service'],
      registers: [service.metrics.registry],
    });
    const transferWithdrawalPending = new Gauge({
      name: 'ticket_transfer_withdrawal_pending_seconds',
      help: '탈퇴 참여자가 PENDING으로 남긴 가장 오래된 나이(초). 지금은 0으로 두고 참여자 응답 로그로 본다',
      labelNames: ['service'],
      registers: [service.metrics.registry],
    });
    transferOutboxLag.set({ service: SERVICE }, 0);
    transferWithdrawalPending.set({ service: SERVICE }, 0);
    // 양도 알림 보내기 반복(docs/features/notify.md §4.8): 5초 [가정]마다 transfer_notice의 보낼 때가 된 행을 core-svc로 보낸다
    if (transferNotices) {
      const sendTransferNotices = (): void => {
        void transferNotices
          .runOnce()
          .then((r) => {
            if (r.sent > 0 || r.retried > 0) service!.logger.info({ sent: r.sent, retried: r.retried, purged: r.purged }, '양도 알림을 보냈다');
          })
          .catch((err: unknown) => service!.logger.warn({ err }, '양도 알림 보내기가 실패했다(다음 틱에 다시 한다)'));
        void transferNotices
          .backlog()
          .then((b) => {
            if (b.count > 0 && b.oldestSeconds >= 3_600) service!.logger.warn({ count: b.count, oldestSeconds: b.oldestSeconds }, '보내지 못한 양도 알림이 1시간을 넘었다(SEV3)');
          })
          .catch(() => undefined);
        void outboxHealth(database, systemClock)
          .then((h) => {
            transferOutboxLag.set({ service: SERVICE }, h.lagSeconds);
            if (h.lagSeconds >= 300) service!.logger.warn({ lagSeconds: h.lagSeconds }, 'trade.tickets Outbox 지연이 5분을 넘었다(SEV3)');
          })
          .catch(() => undefined);
      };
      transferNoticeTimer = setInterval(sendTransferNotices, TRANSFER_NOTICE_EVERY_MS);
      transferNoticeTimer.unref?.();
      sendTransferNotices();
    } else {
      service.logger.warn({}, 'PEAKET_CORE_HTTP_URL이 없어 양도 알림을 보내지 않는다(transfer_notice 행만 쌓인다)');
    }
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
    // 스캔 판정·중복·POLICY 변경 지표(offline-gate §10.2). 티켓·기기·계정 ID는 이름표에 싣지 않는다
    const scansReceived = new Counter({
      name: 'scanner_scans_received_total',
      help: '스캔 기록 수(result: 처음 저장한 PASS·REJECT·CHECK, duplicate는 이미 있던 클라이언트 ID, offline-gate §10.2)',
      labelNames: ['service', 'result'],
      registers: [service.metrics.registry],
    });
    scanStored = (result) => scansReceived.inc({ service: SERVICE, result });
    const policyChanges = new Counter({
      name: 'scanner_policy_changes_total',
      help: '스캐너 입장 정책 사본이 바뀌어 POLICY 변경분을 적은 수(offline-gate §10.2)',
      labelNames: ['service'],
      registers: [service.metrics.registry],
    });
    policyChanged = ({ eventId, reentryAllowed, seq }) => {
      policyChanges.inc({ service: SERVICE });
      service!.logger.info({ kind: 'scanner.policy-changed', eventId, reentryAllowed, seq }, 'scanner.policy-changed');
    };
    // 큐 비움 보고·입장 기록 마감 지표(offline-gate §7.4). 회차·기기 ID는 이름표에 싣지 않는다
    const queueReports = new Counter({
      name: 'ticket_scanner_queue_reports_total',
      help: '스캐너 큐 비움 보고 수(result: empty·pending·no_placement, offline-gate §7.4)',
      labelNames: ['service', 'result'],
      registers: [service.metrics.registry],
    });
    queueReported = (result) => queueReports.inc({ service: SERVICE, result });
    const entryCloses = new Counter({
      name: 'ticket_entry_closes_total',
      help: '입장 기록 마감 수(reason: ALL_REPORTED·TIMEOUT, offline-gate §7.4)',
      labelNames: ['service', 'reason'],
      registers: [service.metrics.registry],
    });
    const coreSyncFailures = new Counter({
      name: 'ticket_entry_close_core_sync_failures_total',
      help: 'core-svc에 마감 시각을 알리지 못한 수(offline-gate §7.4)',
      labelNames: ['service'],
      registers: [service.metrics.registry],
    });
    const unreportedTotal = new Counter({
      name: 'ticket_scanner_unreported_total',
      help: 'TIMEOUT 마감에서 만든 미보고 스캐너 건 수(offline-gate §7.4)',
      labelNames: ['service'],
      registers: [service.metrics.registry],
    });
    const caseSendFailures = new Counter({
      name: 'ticket_cs_case_send_failures_total',
      help: 'ops-svc CS 처리함에 보내지 못한 수(kind: SCANNER_UNREPORTED, offline-gate §7.4)',
      labelNames: ['service', 'kind'],
      registers: [service.metrics.registry],
    });
    const entryCloseSkipped = new Counter({
      name: 'ticket_entry_close_skipped_total',
      help: '마감 판단에서 건너뛴 회차 수(reason: ends_unknown, offline-gate §7.4)',
      labelNames: ['service', 'reason'],
      registers: [service.metrics.registry],
    });
    if (config.coreHttpUrl && policy) {
      const coreClient = createExternalHttpClient({ provider: 'core-svc', baseUrl: config.coreHttpUrl, timeoutCapMs: 2_000, clock: systemClock });
      const opsClient = config.opsHttpUrl ? createExternalHttpClient({ provider: 'ops-svc', baseUrl: config.opsHttpUrl, timeoutCapMs: 2_000, clock: systemClock }) : undefined;
      const closeTick = new EntryCloseTick({
        store: entryCloseStore,
        policy,
        core: new HttpCoreEntryClose(coreClient, config.internalToken),
        // ops 주소가 없으면 건 행을 보내지 않고 남긴다(주소가 생기면 다음 판단이 보낸다)
        ...(opsClient ? { cases: new HttpOpsCaseSink(opsClient, config.internalToken) } : {}),
        clock: systemClock,
        log: service.logger,
        metrics: {
          closed: (reason) => entryCloses.inc({ service: SERVICE, reason }),
          coreSyncFailure: () => coreSyncFailures.inc({ service: SERVICE }),
          unreported: (count) => unreportedTotal.inc({ service: SERVICE }, count),
          caseSendFailure: (kind) => caseSendFailures.inc({ service: SERVICE, kind }),
          skipped: (reason) => entryCloseSkipped.inc({ service: SERVICE, reason }),
        },
      });
      let closeRunning = false;
      const runClose = (): void => {
        if (closeRunning) return;
        closeRunning = true;
        void closeTick
          .run()
          .catch((err: unknown) => service!.logger.warn({ err: err instanceof Error ? err.message : String(err) }, '입장 기록 마감 판단이 실패했다(다음 틱에 다시 한다)'))
          .finally(() => {
            closeRunning = false;
          });
      };
      entryCloseTimer = setInterval(runClose, o.entryCloseEveryMs ?? ENTRY_CLOSE_EVERY_MS);
      entryCloseTimer.unref?.();
      runClose();
      service.logger.info({ everyMs: o.entryCloseEveryMs ?? ENTRY_CLOSE_EVERY_MS }, '입장 기록 마감 판단을 켰다(GAT-180)');
    } else {
      service.logger.warn({}, 'PEAKET_CORE_HTTP_URL이 없어 입장 기록 마감 판단을 켜지 않는다');
    }
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
        {
          // 탈퇴 참여자(identity-svc만, I-T43 ①)
          definition: ticketPackage().WithdrawalParticipantService.service,
          handlers: transferWithdrawalHandlers(
            {
              process: (i) =>
                transferWithdrawal.run({ accountId: i.accountId, ...(i.deadlineAtMs > 0 ? { deadlineAtMs: i.deadlineAtMs } : {}) }).then((r) => {
                  if (r.state === 'PENDING') {
                    service!.logger.warn(
                      { pendingReceivedTickets: r.pendingReceivedTickets, pendingSentOffers: r.pendingSentOffers, pendingReceivedOffers: r.pendingReceivedOffers },
                      '탈퇴 참여자가 PENDING이다(입장 동결·입장 기록·쓰기 실패. 마감 뒤 고리가 다시 부른다, SEV3 후보)',
                    );
                  }
                  return r;
                }),
            },
            (method, err) => {
              service!.logger.error({ method, err }, 'WithdrawalParticipantService 처리 실패');
            },
            { ...(internalGrpcToken ? { internalToken: internalGrpcToken } : {}) },
          ),
        },
        {
          // 연기 철회(purchase-svc만, R-T25 ③)
          definition: ticketPackage().TicketTransferService.service,
          handlers: transferEventWithdrawalHandlers(
            { withdrawForEvent: (i) => transfers.withdrawForEvent(i) },
            (method, err) => {
              service!.logger.error({ method, err }, 'TicketTransferService 처리 실패');
            },
            { ...(internalGrpcToken ? { internalToken: internalGrpcToken } : {}) },
          ),
        },
      ],
      internal: {
        ...(internalGrpcToken ? { token: internalGrpcToken } : {}),
        services: ['peaket.ticket.v1.ScannerDeviceService', 'peaket.ticket.v1.WithdrawalParticipantService'],
      },
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
      if (transferNoticeTimer) clearInterval(transferNoticeTimer);
      if (entryCloseTimer) clearInterval(entryCloseTimer);
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
    if (transferNoticeTimer) clearInterval(transferNoticeTimer);
    if (entryCloseTimer) clearInterval(entryCloseTimer);
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
