// payment-svc 조립(BUILD_ORDER PRF-180, 나눔 PRF-215·ADR-0262 결정 4). 서비스 시작 파일 main.ts와 한 프로세스 합본(services/bundle)이 같은 함수를 부른다.
// 환경 값은 인자로만 받는다(process.env를 읽지 않는다. 합본은 서비스마다 다른 환경 값을 넘긴다). 조립과 종료 차례는 나누기 전의 main.ts 그대로다.
// 앱·관리 포트(건강·지표)는 서비스 뼈대(createService)가, 업무 gRPC 포트는 이 파일이 grpc-server.ts로 연다(identity-svc main.ts와 같은 꼴).
// 조립: 핫패스 풀(applicationName payment-svc)·일반 풀(payment-svc-batch)·승인 실행기 전용 풀(payment-svc-confirm), PromPaymentCommandSignals·PromPaymentConfirmSignals를 서비스 레지스트리에 붙이고,
// paymentServiceHandlers를 PaymentService에 묶는다. 준비 상태는 gRPC 포트를 연 뒤에 켠다. 승인 실행기와 UNKNOWN 조회 실행기(승인 실행기의 풀과 채널별 호출 보호기를 함께 쓴다)는 그 뒤에 켠다(BUILD_ORDER PRF-181·PRF-182·PRF-183).
// 앱 포트에는 결제사 웹훅 경로가 있다(웹훅 전용 풀 payment-svc-webhook, BUILD_ORDER HOT-150).
// 종료(close, 시작 파일은 SIGTERM에 부른다): 준비 상태를 내리고(docs/devops.md §6.4) gRPC 포트를 닫으면서 두 실행기를 멈춘 뒤(돌던 호출과 그 뒤 쓰기를 기다린다) 서비스를 닫고 DB 풀 넷을 닫는다.
// 종료 세션 목록(ADR-0333 결정 2): 듣기 전에 제어 토픽(설정·종료 세션) 소비를 켜고, 서비스를 닫은 뒤 연결과 함께 끈다.
// 같은 설정 저장소의 PG_ASSIGNMENT(명령 12) 변경은 회차 지정 쓰임새로 쓰고, 명령 12 사전 판정 CheckEventPgAssignment를 업무 gRPC에 묶는다(BUILD_ORDER BAT-360, ADR-0349 결정 3·5).
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import type { Writable } from 'node:stream';
import { type Clock, createDatabase, createHotRedis, createService, HotPathMetrics, inClusterLeaseApi, internalGrpcTokenFromEnv, type LeaseApi, LeaseElector, memoryLeaseApi, type PlatformLogger, reauthJtiStoreFromEnv, systemClock, tenantRateLimitRedisUrlFromEnv } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { assertPgAdapters, checkoutAdapterWarnings, loadCheckoutConfig, loadEntryPausePrometheusUrl, loadPaymentServiceConfig, loadPgApprovalTps, loadPgCallGuardConfig, loadPortoneChannelMap, loadPortoneGatewayConfig, loadSimulatorGatewayConfig, loadTossGatewayConfig, PAYMENT_BATCH_POOL_MAX, PAYMENT_HOT_POOL_MAX, webhookAcceptsSimulator } from './config.js';
import { startGrpcServer } from './grpc-server.js';
import { paymentControlPlane } from './control/payment-control.js';
import { SimulatorPaymentGateway } from './modules/payment/adapters/pg/simulator-gateway.js';
import { CompensationRefreshLoop, CompensationTransfers, DrizzleCompensationTransfers, FakeCompensationTransfer, compensationTransferHandlers, compensationTransferPackage } from './modules/compensation/index.js';
import {
  AcceptPaymentCommand,
  AssignEventPg,
  assertPlatformSubProviders,
  BatchGetPaymentStates,
  BreakerPgCircuits,
  CachedEntryPauseReader,
  CachedPgChannelObservations,
  CachedPgSelectionReader,
  CancelConfirmedPayment,
  CancelDepositPayment,
  CancelPayment,
  channelTableOf,
  CheckEventPgAssignment,
  confirmRunnerDatabaseOptions,
  createPgHttp,
  DrizzleConfirmJobs,
  DrizzleEntryPause,
  DrizzlePaymentStore,
  DrizzlePgChannelLimit,
  DrizzlePgChannelObserved,
  DrizzlePgSelection,
  DrizzlePgSelectionBatch,
  DrizzleWebhookStore,
  ENTRY_PAUSE_LEASE_NAME,
  EntryPauseJudge,
  entryPauseLog,
  EntryPauseReleaseWatcher,
  GetNewPaymentPause,
  GetPaymentDetail,
  paymentCheckoutLog,
  type PaymentCommandLog,
  paymentCommandLog,
  NO_ENTRY_PAUSE_CLUSTER_INPUTS,
  paymentConfirmLog,
  paymentDepositLog,
  PaymentConfirmRunner,
  paymentPackage,
  paymentServiceHandlers,
  PaymentUnknownResolver,
  paymentUnknownLog,
  type PaymentWebhookLog,
  paymentWebhookLog,
  PayRefKeyRing,
  perPodBulkhead,
  PG_CHANNEL_BULKHEAD,
  PgAssignmentSettingHandler,
  pgAssignmentSettingLog,
  PgCallGuards,
  pgCallGuardLog,
  pgChannelLog,
  PgChannelLimitSync,
  PgChannelObserver,
  type PgCircuits,
  PortoneFallbackExclusions,
  PortoneGateway,
  PrepareCheckout,
  PrometheusEntryPauseInputs,
  PromEntryPauseSignals,
  PromPaymentCheckoutSignals,
  PromPaymentCommandSignals,
  PromPaymentConfirmSignals,
  PromPaymentDepositSignals,
  PromPaymentMethodRefSignals,
  PromPaymentResolutionSignals,
  PromPaymentUnknownSignals,
  PromPaymentWebhookSignals,
  PromPgCallGuardSignals,
  PromPgChannelSignals,
  StaticPaymentGateways,
  TossPaymentGateway,
  virtualAccountCipherFromEnv,
  UNKNOWN_QUERY_CONCURRENCY,
  WEBHOOK_REQUEST_TIMEOUT_MS,
  webhookDatabaseOptions,
} from './modules/payment/server.js';
import {
  DenyAllAdminAuthz,
  HttpAdjustmentApprovalVerifier,
  HttpSettlementCaseNotice,
  parseHolidayCalendar,
  UnavailableAdjustmentApprovalVerifier,
  DrizzleSettlementPaymentSource,
  DrizzleSettlementStore,
  GrpcAdminAuthz,
  HttpDueEventSettlementSource,
  HttpEventCommissionRateSource,
  HttpPayoutApprovalVerifier,
  HttpPgBalanceSource,
  HttpPromoterContractSource,
  HttpSaleSuspensionSource,
  JwksReauthVerifier,
  ManualPortonePayoutGateway,
  SETTLEMENT_DUE_LEASE_NAME,
  SettlementDueWorker,
  Settlements,
  settlementApprovalLog,
  UnavailablePayoutApprovalVerifier,
  UnavailableProductSettlementSource,
  UnavailableReauthVerifier,
  UnavailableSaleSuspensionSource,
  UnavailableTossPayoutGateway,
  HttpProductSettlementSource,
  type SettlementApprovalLog,
  DrizzlePgLedgerSource,
  HttpTossPayoutTransport,
  PayoutSubmitWorker,
  PromSettlementSignals,
  ReceiveSettlementWebhook,
  TossPayoutGateway,
  tossPayoutConfigured,
  tossPayoutTerms,
  UnconfiguredSettlementWebhook,
  type PayoutGateway,
  type PgBalanceSource,
  type SettlementSignals,
  type SettlementStore,
  type SettlementWebhookReceiver,
  type TossPayoutTransport,
} from './modules/settlement/index.js';
import { HttpOpsAlerts, UnavailableOpsAlerts } from './modules/settlement/adapters/http-ops-alerts.js';
import { HttpOpsAuditRecords, UnavailableOpsAuditRecords } from './modules/settlement/adapters/http-ops-audit-records.js';
import { HttpPortonePlatformTransport } from './modules/settlement/adapters/http-portone-platform-transport.js';
import { PortonePlatformPayoutGateway } from './modules/settlement/adapters/portone-platform-payout-gateway.js';
import { portonePayoutConfigured } from './modules/settlement/domain/payout-adapters.js';
import type { PayoutAccountAuditSink, PortonePlatformTransport, SettlementAlertSink } from './modules/settlement/domain/ports.js';
import { safeErrorCode } from './safe-error-code.js';
import { shutdownInOrder } from './shutdown.js';

const SERVICE = 'payment-svc';
/** 토스페이먼츠 지급대행 API 주소(ASVS 13.2.4 허용 목록). PEAKET_PG_TOSS_PAYOUT_BASE_URL은 local·ci에서만 읽는다(대역 서버) */
const TOSS_PAYOUT_BASE_URL = 'https://api.tosspayments.com';

/**
 * 토스 지급대행 조립(F-07-6 ADR-0369 결정 2·5). 결제 상점별 설정(시크릿 키·보안 키)이 있으면 실제 전송·지급 어댑터·잔액 원천과 서명 수신기를,
 * 없으면 503 어댑터·잔액 확인 생략·'설정 없음' 수신기(정산 사건 400)를 준다. 설정이 반만 있거나 보안 키 모양이 틀리면 던진다(시작 실패, 메시지에 키 값 없음).
 * 수신기는 Settlements·저장소가 생긴 뒤 createWebhook으로 만든다.
 */
export function assembleTossPayout(
  env: Record<string, string | undefined>,
  deps: { baseUrl?: string; clock: Clock; log: Pick<PlatformLogger, 'info' | 'warn'>; /** 있으면 전송의 보안 로그를 이것으로 남긴다(start()는 서비스 로거를 늦게 잇는다) */ approvalLog?: SettlementApprovalLog },
): {
  gateway: PayoutGateway;
  pgBalance: PgBalanceSource | undefined;
  transport: TossPayoutTransport | undefined;
  baseUrl: string;
  createWebhook(o: { settlements: Settlements; store: SettlementStore; log: SettlementApprovalLog; signals?: SettlementSignals }): SettlementWebhookReceiver;
} {
  const config = tossPayoutConfigured(env);
  const override = env.PEAKET_ENV === 'local' || env.PEAKET_ENV === 'ci' ? env.PEAKET_PG_TOSS_PAYOUT_BASE_URL?.trim() : undefined;
  const baseUrl = deps.baseUrl ?? (override ? override : TOSS_PAYOUT_BASE_URL);
  const now = () => new Date(deps.clock.now());
  if (!config) {
    return { gateway: new UnavailableTossPayoutGateway(), pgBalance: undefined, transport: undefined, baseUrl, createWebhook: (o) => new UnconfiguredSettlementWebhook({ log: o.log, now }) };
  }
  const transport = new HttpTossPayoutTransport(config, { baseUrl, clock: deps.clock, log: deps.approvalLog ?? settlementApprovalLog(deps.log) });
  return {
    gateway: new TossPayoutGateway(transport),
    pgBalance: new HttpPgBalanceSource(transport),
    transport,
    baseUrl,
    createWebhook: (o) => new ReceiveSettlementWebhook({ config, transport, settlements: o.settlements, store: o.store, now, log: o.log, ...(o.signals ? { signals: o.signals } : {}) }),
  };
}
/**
 * 포트원 지급대행(파트너 정산) 조립(F-07-7 계획 §5.1 (가), ADR-0370 결정 3·7). 설정(portonePayoutConfigured)이 있으면 플랫폼 HTTP 전송과 수기 정산건 갈래를,
 * 없으면 전송 없음과 지금의 콘솔 실행 기록 갈래(ManualPortonePayoutGateway)를 준다. 설정이 반만 있으면 던진다(시작 실패, 메시지에 값 없음).
 * baseUrl은 시험이 대역 서버 주소를 넘길 때만 쓴다(없으면 결제 포트원 주소).
 */
export function assemblePortonePlatform(
  env: Record<string, string | undefined>,
  deps: { baseUrl?: string; clock: Clock; log: Pick<PlatformLogger, 'info' | 'warn'> },
): { transport: PortonePlatformTransport | undefined; gateway: PayoutGateway } {
  const config = portonePayoutConfigured(env);
  if (!config) return { transport: undefined, gateway: new ManualPortonePayoutGateway() };
  const transport = new HttpPortonePlatformTransport(deps.baseUrl ? { ...config, baseUrl: deps.baseUrl } : config, { clock: deps.clock });
  return { transport, gateway: new PortonePlatformPayoutGateway(transport) };
}

/**
 * ops 받기 둘(정산 계좌 변경 감사·운영 경보) 조립(F-07-7 계획 §5.1 (가)). PEAKET_OPS_HTTP_URL이 있으면 HTTP 어댑터, 없으면 늘 503인 대역이다
 * (행은 남고 보낸 시각이 빈 채로 다시 보내기를 기다린다). 내부 토큰은 PEAKET_INTERNAL_TOKEN.
 */
export function assembleOpsSettlementSinks(env: Record<string, string | undefined>, deps: { clock: Clock; log?: Pick<PlatformLogger, 'info' | 'warn'> }): { audit: PayoutAccountAuditSink; alerts: SettlementAlertSink } {
  const url = env.PEAKET_OPS_HTTP_URL?.trim();
  if (!url) return { audit: new UnavailableOpsAuditRecords(), alerts: new UnavailableOpsAlerts() };
  const token = env.PEAKET_INTERNAL_TOKEN;
  return { audit: new HttpOpsAuditRecords(url, token, { clock: deps.clock }), alerts: new HttpOpsAlerts(url, token, { clock: deps.clock }) };
}

export interface StartOptions {
  /** 이 서비스의 환경 값(시작 파일은 process.env, 합본은 공통 값과 이 서비스의 환경 파일을 합친 값) */
  env: Record<string, string | undefined>;
  /** 로그 목적지(기본 표준 출력, 시험에서 바꿔 끼운다) */
  logDestination?: Writable;
}

export interface StartedService {
  /** 종료 차례대로 닫는다. 여러 번 불러도 한 번만 닫고 같은 약속을 돌려준다 */
  close(): Promise<void>;
  /** 실제로 연 포트(PORT·PEAKET_MANAGEMENT_PORT·PEAKET_GRPC_PORT=0일 때 시험이 읽는다) */
  ports: { appPort: number; managementPort: number; grpcPort: number; controlPort?: number };
}

export async function start(o: StartOptions): Promise<StartedService> {
  const { env } = o;
  const config = loadPaymentServiceConfig(env);
  // 토스 지급대행 설정(ADR-0369 결정 2). 반만 있거나 보안 키 모양이 틀리면 듣기 전에(DB·포트보다 먼저) 시작 실패다. 전송의 보안 로그는 서비스가 선 뒤 잇는 승인 로그로 남긴다
  let approvalLog: SettlementApprovalLog | undefined;
  const lateTossLog: SettlementApprovalLog = {
    approved: (e) => approvalLog?.approved(e),
    rejected: (e) => approvalLog?.rejected(e),
    tossJweInvalid: (e) => approvalLog?.tossJweInvalid?.(e),
  };
  const tossPayout = assembleTossPayout(env, { clock: systemClock, log: { info: () => undefined, warn: () => undefined }, approvalLog: lateTossLog });
  const tossTerms = tossPayoutTerms(env);
  // 포트원 지급대행(F-07-7 ADR-0370 결정 3·7). 설정이 반만 있으면 여기서 시작 실패다. ops 감사·운영 경보 받기는 ops 주소가 없으면 늘 503인 대역이다
  const portonePlatform = assemblePortonePlatform(env, { clock: systemClock, log: { info: () => undefined, warn: () => undefined } });
  const portonePayoutConfig = portonePayoutConfigured(env);
  const opsSinks = assembleOpsSettlementSinks(env, { clock: systemClock });
  const internalGrpcToken = internalGrpcTokenFromEnv(env);
  const reauthRedisUrl = env.PEAKET_REAUTH_REDIS_URL;
  const reauthRedis = reauthRedisUrl ? await createHotRedis({ url: reauthRedisUrl }) : undefined;
  // 테넌트 한도 Redis(BAT-173 리뷰 RV-01): 재인증 jti Redis는 서비스별 Redis일 수 있어 테넌트 카운터를 두면 `rl:tenant:*`가 쪼개진다.
  // `PEAKET_TENANT_REDIS_URL`(세션·캐시 클러스터)이 먼저이고 staging·prod·demo는 없으면 시작하지 않는다. local·ci만 재인증 Redis로 닫힌 대역을 쓴다.
  const tenantRedisUrl = tenantRateLimitRedisUrlFromEnv(env, { fallbackUrl: reauthRedisUrl });
  const tenantRedis = tenantRedisUrl ? await createHotRedis({ url: tenantRedisUrl }) : undefined;
  // 잘못된 주소·빠진 키·환경과 어긋난 키 접두사는 여기서, 듣기 전에 시작 실패다. 어댑터 없이 켜지는 것은 local·ci뿐이다(아래 경고 한 줄과 no_adapter 지표, BUILD_ORDER PRF-184)
  const simulator = loadSimulatorGatewayConfig(env);
  const toss = loadTossGatewayConfig(env);
  const portone = loadPortoneGatewayConfig(env);
  assertPgAdapters(env, { simulator: simulator !== undefined, toss: toss !== undefined });
  const guardConfig = loadPgCallGuardConfig(env);
  // 플랫폼 기본 결제사와 결제창 복귀 출처. 잘못된 값은 듣기 전에 시작 실패다(BUILD_ORDER PRF-190)
  const checkoutConfig = loadCheckoutConfig(env);
  // 포트원 채널의 하위 결제사 표. local·ci 밖에서 값이 빠졌거나, 플랫폼 기본값이 하위 결제사 규칙에 걸리면 듣기 전에 시작 실패다(배포 검사, P-T46 ③, BUILD_ORDER PRF-203)
  const portoneChannels = loadPortoneChannelMap(env, portone);
  assertPlatformSubProviders(checkoutConfig.defaults, portoneChannels);
  // 결제사별 승인 상한(선택, 명령 12 사전 판정이 싣는다). 틀린 값은 듣기 전에 시작 실패다(ADR-0349 결정 4, BUILD_ORDER BAT-360)
  const approvalTps = loadPgApprovalTps(env);
  // 정산 이의 기한·상품 정산서 주의 첫 영업일을 세는 KST 공휴일(purchase-svc와 같은 파일, ADR-0368 결정 4). 없으면 주말만 빼고, 형식이 틀리면 듣기 전에 시작 실패다
  const settlementHolidays = env.PEAKET_HOLIDAY_CALENDAR_FILE ? parseHolidayCalendar(readFileSync(env.PEAKET_HOLIDAY_CALENDAR_FILE, 'utf8')) : new Set<string>();
  // 정지 판정자의 입력을 읽을 클러스터 Prometheus 주소. local·ci 밖에서 없으면 듣기 전에 시작 실패다(BUILD_ORDER PRF-202 코드 리뷰)
  const promUrl = loadEntryPausePrometheusUrl(env);
  // 결제 수단 연결값의 라벨 키 pay. 없으면 경고만 하고 칸을 비운다(결제는 막지 않는다, BUILD_ORDER HOT-145). 잘못된 설정은 듣기 전에 시작 실패다
  const { ring: methodRefs, warnings: methodRefWarnings } = PayRefKeyRing.fromEnv(env);
  // 가상계좌 번호 필드 암호화 키(local·ci·demo는 환경 값, 운영 KMS는 HOT-146). 없으면 경고만 하고 번호를 저장하지 않는다(결제는 막지 않는다, BUILD_ORDER HOT-151). 잘못된 설정은 듣기 전에 시작 실패다
  const { cipher: virtualAccountCipher, warnings: virtualAccountWarnings } = virtualAccountCipherFromEnv(env);
  // 어댑터마다 승인 묶음(연결 수 = 처음의 파드당 벌크헤드)과 조회 전용 묶음(연결 수 = 파드의 동시 조회 수) 둘. 승인 호출이 연결을 다 쥐어도 조회가 막히지 않는다. 연결 시간 초과 3초 [가정]. v0 모놀리스는 이 옵션을 쓰지 않는다(BUILD_ORDER PRF-183)
  const pgHttp = simulator ? createPgHttp({ connections: perPodBulkhead(PG_CHANNEL_BULKHEAD.SIMULATOR, guardConfig.podCount) }) : undefined;
  const pgQueryHttp = simulator ? createPgHttp({ connections: UNKNOWN_QUERY_CONCURRENCY }) : undefined;
  const tossHttp = toss ? createPgHttp({ connections: perPodBulkhead(PG_CHANNEL_BULKHEAD.TOSS, guardConfig.podCount) }) : undefined;
  const tossQueryHttp = toss ? createPgHttp({ connections: UNKNOWN_QUERY_CONCURRENCY }) : undefined;
  const portoneHttp = portone ? createPgHttp({ connections: perPodBulkhead(PG_CHANNEL_BULKHEAD.PORTONE, guardConfig.podCount) }) : undefined;
  const portoneQueryHttp = portone ? createPgHttp({ connections: UNKNOWN_QUERY_CONCURRENCY }) : undefined;
  // 포트원 답의 하위 결제사 관측기는 로거가 선 뒤에 생겨 늦게 잇는다(어댑터는 포트를 연 뒤에야 불린다, BUILD_ORDER PRF-203)
  let channelObserver: PgChannelObserver | undefined;
  const gateways = new StaticPaymentGateways([
    ...(simulator ? [new SimulatorPaymentGateway({ ...simulator, fetch: pgHttp!.fetch, queryFetch: pgQueryHttp!.fetch })] : []),
    ...(toss ? [new TossPaymentGateway({ ...toss, fetch: tossHttp!.fetch, queryFetch: tossQueryHttp!.fetch })] : []),
    ...(portone ? [new PortoneGateway({ ...portone, fetch: portoneHttp!.fetch, queryFetch: portoneQueryHttp!.fetch, onChannel: (c) => channelObserver?.observe(c) })] : []),
  ]);
  // 플랫폼 기본 결제사의 어댑터가 없으면 듣기 전에 시작 실패이고, 대체의 어댑터가 없으면 경고다(BUILD_ORDER PRF-190 코드 리뷰)
  const checkoutWarnings = checkoutAdapterWarnings(env, checkoutConfig.defaults, (pg) => gateways.of(pg) !== undefined);

  const database = createDatabase({ url: config.databaseUrl, profile: 'hot', max: PAYMENT_HOT_POOL_MAX, applicationName: SERVICE });
  const batchDatabase = createDatabase({ url: config.databaseUrl, max: PAYMENT_BATCH_POOL_MAX, applicationName: `${SERVICE}-batch` });
  const confirmDatabase = createDatabase(confirmRunnerDatabaseOptions(config.databaseUrl));
  const webhookDatabase = createDatabase(webhookDatabaseOptions(config.databaseUrl));
  const store = new DrizzlePaymentStore({ database, batchDatabase });
  const signals = new PromPaymentCommandSignals();
  const confirmSignals = new PromPaymentConfirmSignals();
  const unknownSignals = new PromPaymentUnknownSignals();
  const guardSignals = new PromPgCallGuardSignals();
  const methodRefSignals = new PromPaymentMethodRefSignals();
  const webhookSignals = new PromPaymentWebhookSignals();
  const depositSignals = new PromPaymentDepositSignals();
  const checkoutSignals = new PromPaymentCheckoutSignals();
  const channelSignals = new PromPgChannelSignals();
  // 핫패스 구간 진단(BAT-027): 레지스트리는 createService 뒤에 생기므로 지표 객체만 먼저 만들고, 듣기 전에 붙인다
  const hotPath = new HotPathMetrics(SERVICE);
  // 포트원 채널의 관측 하위 결제사 표는 핫패스 풀에서 1초 [가정] 캐시로 읽는다(전환으로 포트원을 고른 결제창 준비와 관측기만, BUILD_ORDER PRF-203)
  const channelObservations = new CachedPgChannelObservations({ reader: new DrizzlePgChannelObserved({ database }), clock: systemClock, signals: channelSignals });
  // 전환의 대체 후보 빼기: 결제창 준비와 정지 조회가 같은 읽기를 쓴다(BUILD_ORDER PRF-203 코드 리뷰 F2)
  const fallbackExclusions = portoneChannels ? new PortoneFallbackExclusions({ portone: portoneChannels, observations: channelObservations }) : undefined;
  // 전환·회차 지정 읽기는 핫패스 풀이고 회차마다 1초 [가정] 캐시한다(BUILD_ORDER PRF-190)
  const pgSelection = new CachedPgSelectionReader({ reader: new DrizzlePgSelection({ database }), clock: systemClock });
  // GetNewPaymentPause의 회차 목록은 일반 풀의 한 문장으로 읽는다(BUILD_ORDER PRF-201 코드 리뷰)
  const pgSelectionBatch = new DrizzlePgSelectionBatch({ database: batchDatabase });
  // 새 결제 일시 정지 행은 핫패스 풀에서 1초 [가정]마다 읽어 파드 메모리에 둔다. 시험 재개 행은 정지 때만 기본 키로 읽는다(BUILD_ORDER PRF-201)
  const entryPauseStore = new DrizzleEntryPause({ database });
  // 읽은 행에서 사람이 푼 해제를 보면 이 파드의 서킷을 닫는다(보호기는 서비스가 선 뒤에 생겨 늦게 잇는다, BUILD_ORDER PRF-202 코드 리뷰)
  let entryPauseReleaseWatcher: EntryPauseReleaseWatcher | undefined;
  const entryPauses = new CachedEntryPauseReader({ reader: entryPauseStore, clock: systemClock, signals: checkoutSignals, onLoaded: (rows) => entryPauseReleaseWatcher?.observe(rows) });
  const channels = channelTableOf(gateways);

  // 로거는 서비스가 선 뒤에 생긴다. 쓰임새에는 늦게 잇는 로그를 넣는다(gRPC·앱 포트는 그 뒤에 열려 그 전에 불리지 않는다)
  let log: PaymentCommandLog | undefined;
/** 서킷 등록부는 createService 뒤에 만들어 늦게 묶는다(내부 /internal/v1/circuits). */
let circuitsRef: PgCircuits | undefined;
  const lateLog: PaymentCommandLog = { mismatch: (e) => log?.mismatch(e) };
  const lateApprovalLog: SettlementApprovalLog = {
    approved: (e) => approvalLog?.approved(e),
    rejected: (e) => approvalLog?.rejected(e),
    authzDenied: (e) => approvalLog?.authzDenied?.(e),
    caseNoticeFailed: (e) => approvalLog?.caseNoticeFailed?.(e),
    payoutCaseNoticeFailed: (e) => approvalLog?.payoutCaseNoticeFailed?.(e),
    webhookSignatureInvalid: (e) => approvalLog?.webhookSignatureInvalid?.(e),
    webhookLate: (e) => approvalLog?.webhookLate?.(e),
    webhookUnconfigured: (e) => approvalLog?.webhookUnconfigured?.(e),
    tossJweInvalid: (e) => approvalLog?.tossJweInvalid?.(e),
    payoutJobFailed: (e) => approvalLog?.payoutJobFailed?.(e),
  };
  // 정산 웹훅 수신기는 Settlements가 선 뒤에 묶는다(createWebhook, 시험 리뷰 TR-16). 그 전에는 오지 않는다(포트가 열리기 전)
  let settlementReceiver: SettlementWebhookReceiver | undefined;
  const lateSettlementWebhook: SettlementWebhookReceiver = { receive: (headers, rawBody) => (settlementReceiver ? settlementReceiver.receive(headers, rawBody) : Promise.resolve('STORE_FAILED' as const)) };
  const settlementStore = new DrizzleSettlementStore(batchDatabase, systemClock);
  const settlementSignals = new PromSettlementSignals();
  let webhookLog: PaymentWebhookLog | undefined;
  const lateWebhookLog: PaymentWebhookLog = {
    invalid: (e) => webhookLog?.invalid(e),
    pgMismatch: (e) => webhookLog?.pgMismatch(e),
    storeFailed: (e) => webhookLog?.storeFailed(e),
    depositSecretMismatch: (e) => webhookLog?.depositSecretMismatch(e),
  };

  const service = await createService({
    name: SERVICE,
    env,
    hotPath,
    // 파트너 테넌트당 600회/분 공용 가드(BAT-173, D-T50 ⑦). 재인증 Redis가 아니라 `PEAKET_TENANT_REDIS_URL`의 세션·캐시 Redis다(RV-01)
    ...(tenantRedis ? { tenantRateLimit: { redis: tenantRedis } } : {}),
    adminAuthz: env.PEAKET_IDENTITY_GRPC_URL
      ? new GrpcAdminAuthz(env.PEAKET_IDENTITY_GRPC_URL)
      : env.PEAKET_ENV === 'local' || env.PEAKET_ENV === 'ci'
        ? new DenyAllAdminAuthz()
        : (() => {
            throw new Error('PEAKET_IDENTITY_GRPC_URL이 없다(파트너 정산 경로의 관리자 인증)');
          })(),
    ...(o.logDestination ? { logDestination: o.logDestination } : {}),
    module: AppModule.register({
      store,
      reader: store,
      log: lateLog,
      signals,
      webhook: { store: new DrizzleWebhookStore({ database: webhookDatabase }), gateways, log: lateWebhookLog, signals: webhookSignals, allowSimulator: webhookAcceptsSimulator(env) },
      circuits: () => circuitsRef,
      // 토스 지급·셀러 웹훅(payout.changed·seller.changed)은 늘 정산 수신기가 받는다. 설정이 없으면 400이고 결제 웹훅 처리로 넘기지 않는다(ADR-0369 결정 5)
      settlementWebhook: lateSettlementWebhook,
      settlement: {
        // 정산서 전이는 상태·감사·trade.settlements Outbox를 한 트랜잭션에 쓴다(ADR-0368 결정 2). Outbox 릴레이가 그대로 보낸다
        store: settlementStore,
        payments: new DrizzleSettlementPaymentSource(batchDatabase),
        products: env.PEAKET_CORE_HTTP_URL ? new HttpProductSettlementSource(env.PEAKET_CORE_HTTP_URL, env.PEAKET_INTERNAL_TOKEN) : new UnavailableProductSettlementSource(),
        ...(env.PEAKET_CORE_HTTP_URL ? { events: new HttpDueEventSettlementSource(env.PEAKET_CORE_HTTP_URL, env.PEAKET_INTERNAL_TOKEN), eventCommission: new HttpEventCommissionRateSource(env.PEAKET_CORE_HTTP_URL, env.PEAKET_INTERNAL_TOKEN) } : {}),
        approvals: env.PEAKET_OPS_HTTP_URL ? new HttpPayoutApprovalVerifier(env.PEAKET_OPS_HTTP_URL, env.PEAKET_INTERNAL_TOKEN) : new UnavailablePayoutApprovalVerifier(),
        // 수기 조정 적용은 ops 승인 기록과 대조하고(ADR-0368 결정 8), 이의는 ops CS 처리함 건을 연다(결정 5). ops 주소가 없으면 조정 적용은 503, 이의는 건 없이 남는다
        adjustmentApprovals: env.PEAKET_OPS_HTTP_URL ? new HttpAdjustmentApprovalVerifier(env.PEAKET_OPS_HTTP_URL, env.PEAKET_INTERNAL_TOKEN) : new UnavailableAdjustmentApprovalVerifier(),
        ...(env.PEAKET_OPS_HTTP_URL ? { caseNotice: new HttpSettlementCaseNotice(env.PEAKET_OPS_HTTP_URL, env.PEAKET_INTERNAL_TOKEN) } : {}),
        holidays: settlementHolidays,
        saleSuspensions: env.PEAKET_CORE_HTTP_URL ? new HttpSaleSuspensionSource(env.PEAKET_CORE_HTTP_URL, env.PEAKET_INTERNAL_TOKEN) : new UnavailableSaleSuspensionSource(),
        ...(env.PEAKET_CORE_HTTP_URL ? { promoterContracts: new HttpPromoterContractSource(env.PEAKET_CORE_HTTP_URL, env.PEAKET_INTERNAL_TOKEN) } : {}),
        // 토스 지급대행(F-07-6 ADR-0369): 설정이 있으면 JWE 전송·지급 어댑터·잔액 원천·셀러 등록·잔액 대사 장부를, 없으면 503 어댑터·잔액 확인 생략
        pgBalance: tossPayout.pgBalance ?? new HttpPgBalanceSource(undefined),
        log: lateApprovalLog,
        gateways: [portonePlatform.gateway, tossPayout.gateway],
        ...(tossPayout.transport ? { tossTransport: tossPayout.transport } : {}),
        ...(portonePlatform.transport && portonePayoutConfig ? { portone: portonePlatform.transport, portoneConfig: portonePayoutConfig } : {}),
        payoutAccountAudit: opsSinks.audit,
        alerts: opsSinks.alerts,
        signals: settlementSignals,
        tossTerms,
        pgLedger: new DrizzlePgLedgerSource(batchDatabase),
        reauth: env.PEAKET_IDENTITY_JWKS_URL
          ? new JwksReauthVerifier({
              jwksUrl: env.PEAKET_IDENTITY_JWKS_URL,
              issuer: env.PEAKET_IDENTITY_ISSUER ?? 'https://identity.peaket.example',
              clock: systemClock,
              jti: reauthJtiStoreFromEnv(env, reauthRedis),
            })
          : new UnavailableReauthVerifier(),
      },
    }),
    // 이 앱 포트의 HTTP 경로는 웹훅뿐이라 웹훅에 맞춘 시한을 서버 전체에 건다
    requestTimeoutMs: WEBHOOK_REQUEST_TIMEOUT_MS,
  });
  log = paymentCommandLog(service.logger);
  approvalLog = settlementApprovalLog(service.logger);
  // 정산 지급 지표(ADR-0369 결정 12). 승인 실행기 지표 묶음과 따로 붙인다
  const { registry: settlementRegistry } = service.metrics;
  settlementSignals.register(settlementRegistry);
  settlementReceiver = tossPayout.createWebhook({ settlements: service.app.get(Settlements), store: settlementStore, log: lateApprovalLog, signals: settlementSignals });
  webhookLog = paymentWebhookLog(service.logger, systemClock);
  signals.register(service.metrics.registry);
  hotPath.register(service.metrics.registry);
  confirmSignals.register(service.metrics.registry);
  unknownSignals.register(service.metrics.registry);
  guardSignals.register(service.metrics.registry);
  methodRefSignals.register(service.metrics.registry);
  webhookSignals.register(service.metrics.registry);
  depositSignals.register(service.metrics.registry);
  checkoutSignals.register(service.metrics.registry);
  channelSignals.register(service.metrics.registry);
  const channelLogs = pgChannelLog(service.logger, systemClock);
  channelObserver = portoneChannels ? new PgChannelObserver({ portone: portoneChannels, observations: channelObservations, store: new DrizzlePgChannelObserved({ database: batchDatabase }), clock: systemClock, signals: channelSignals, log: channelLogs }) : undefined;
  // 단계 지표는 모든 파드가 캐시한 행에서 낸다(BUILD_ORDER PRF-202)
  const entryPauseSignals = new PromEntryPauseSignals().register(service.metrics.registry, entryPauses);
  for (const warning of methodRefWarnings) service.logger.warn({ kind: 'payment-method-ref-key' }, warning);
  for (const warning of virtualAccountWarnings) service.logger.warn({ kind: 'payment-virtual-account-key' }, warning);
  for (const warning of checkoutWarnings) service.logger.warn({ kind: 'payment-checkout-adapter' }, warning);
  const depositLog = paymentDepositLog(service.logger);
  const deposit = { cipher: virtualAccountCipher, log: depositLog, signals: depositSignals };
  const confirmJobs = new DrizzleConfirmJobs({ database: confirmDatabase, clock: systemClock });
  // 결제사 서킷은 채널마다 하나이고 승인·조회·취소가 함께 쓴다. 값은 플랫폼 기본값 [가정](docs/features/payment.md §2 '결제사 서킷의 첫 구현', BUILD_ORDER PRF-200)
  const circuits = new BreakerPgCircuits({ service: SERVICE, registry: service.metrics.registry, logger: service.logger, clock: systemClock }).register(service.metrics.registry);
  circuitsRef = circuits;
  // 첫 승인 호출 429로 낮춘 상한은 표에 판 번호 조건으로 써서 모든 파드가 1초 [가정] 안에 따른다(일반 풀, BUILD_ORDER PRF-203)
  let limitSync: PgChannelLimitSync | undefined;
  const guards = new PgCallGuards({ gateways, podCount: guardConfig.podCount, clock: systemClock, signals: guardSignals, log: pgCallGuardLog(service.logger), circuits, share: { lowered: (e) => limitSync?.lowered(e) } });
  limitSync = new PgChannelLimitSync({ store: new DrizzlePgChannelLimit({ database: batchDatabase }), guards, clock: systemClock, signals: channelSignals, log: channelLogs });
  const depositCancel = new CancelDepositPayment({ store: confirmJobs, gateways, guards, signals: depositSignals, clock: systemClock });
  // 결제 후 일반 취소(GAT-080). 입금 전 취소와 같은 차단기·호출 보호기를 쓰고, 원장 상태로 갈래를 고른다
  // 가상계좌가 아닌 결제에 온 환불 계좌를 버린 수는 입금 지표가 함께 낸다(BUILD_ORDER GAT-090)
  const confirmedCancel = new CancelConfirmedPayment({ store: confirmJobs, gateways, guards, clock: systemClock, refundAccountSignals: depositSignals });
  const cancelPayment = new CancelPayment(depositCancel, confirmedCancel, confirmJobs);
  const VIRTUAL_ACCOUNT_DISALLOWED_REASON = '가상계좌를 받지 않는 공연의 입금 대기';
  entryPauseReleaseWatcher = new EntryPauseReleaseWatcher({ closeCircuit: (pg) => guards.of(pg)?.closeCircuit() });
  // 명령 6 결제 갈래 받는 쪽(F-02-2 OPS-310, ADR-0366): pg_switch를 한 번 읽어야 준비 상태이고, 제어 포트(PEAKET_PAYMENT_CONTROL_GRPC_PORT)와 ResolvePgSwitch를 잇는다
  const paymentControl = paymentControlPlane({ env, readiness: service.readiness, logger: service.logger, metrics: service.metrics, profile: service.config.grpcLbProfile, database: batchDatabase, selection: pgSelection, pauses: entryPauses, guards, defaults: checkoutConfig.defaults, approvalTps, entryLog: entryPauseLog(service.logger), entrySignals: entryPauseSignals, clock: systemClock, podName: env.PEAKET_POD?.trim() || hostname() });
  const resolutionSignals = new PromPaymentResolutionSignals().register(service.metrics.registry);
  service.readiness.register('grpc');
  if (!simulator && !toss && !portone) service.logger.warn({ kind: 'payment-confirm-no-adapter' }, '결제사 어댑터 설정이 없어 어댑터 없이 켰다(승인 명령은 미뤄지고 no_adapter 지표가 드러낸다)');

  // 배상 송금(ADR-0317): 가짜 지급대행이 REQUESTED/UNAVAILABLE을 답하고, 기록은 compensation_transfer에 남긴다.
  // PAID일 때만 정산 모듈이 partner_receivable(COMPENSATION_ADVANCE) 한 행을 만든다. 계좌 원문은 저장하지 않는다(POL-014)
  const compensationTransfers = new CompensationTransfers(
    new FakeCompensationTransfer(env),
    new DrizzleCompensationTransfers({ database: batchDatabase, clock: systemClock }),
    { recordCompensationAdvance: (i) => service.app.get(Settlements).recordCompensationAdvance(i) },
    // 송금 결과 확정 실패(compensation_transfer_refresh_failed): 송금 ID와 까닭 종류만. 계좌·예금주는 싣지 않는다
    { refreshFailed: ({ transferId, reason }) => service.logger.warn({ kind: 'compensation_transfer_refresh_failed', transferId, reason }, '배상 송금 결과를 확정하지 못했다(다음 바퀴가 다시 본다)') },
  );
  // 종료 세션 목록(ADR-0333 결정 2): 듣기 전에 두 제어 토픽을 읽기 시작한다(다 읽어야 /ready 200). 브로커가 없으면 local·ci만 경고로 끄고 그 밖은 여기서 시작에 실패한다.
  // Kafka 클라이언트(네이티브 모듈)는 이 시작 함수를 부를 때 싣는다(시작 파일을 읽기만 하는 곳은 싣지 않는다)
  const { startServiceControlSync } = await import('@peaket/platform/stream-worker');
  const controlSync = startServiceControlSync(service, env);
  // 설정 사건 PG_ASSIGNMENT(명령 12): 설정 저장소의 변경마다 회차 지정을 쓴다. 지정 시각은 사건의 occurredAt이다(일반 풀, ADR-0349 결정 5, BUILD_ORDER BAT-360).
  // 읽기는 listen 전에 시작한 소비가 비동기로 하므로, 여기서 바로 붙이면 첫 레코드부터 듣는다. 제어 토픽 소비가 꺼진 local·ci는 받는 쪽도 없다
  const pgAssignmentSettings = new PgAssignmentSettingHandler({
    assign: new AssignEventPg({ store: new DrizzlePgSelection({ database: batchDatabase }), ...(portoneChannels ? { portone: portoneChannels } : {}), clock: systemClock }),
    log: pgAssignmentSettingLog(service.logger),
  });
  if (controlSync) pgAssignmentSettings.subscribe(controlSync.sync.settings);
  const httpPorts = await service.listen();
  const grpc = await startGrpcServer({
    host: config.grpcHost,
    // 포트는 payment-svc 설정(기본 50051, 공용 설정과 같은 값)이다. 부하 분산 프로필·호출 지표는 공용 설정·지표 묶음을 쓴다(BUILD_ORDER BAS-080)
    port: config.grpcPort,
    profile: service.config.grpcLbProfile,
    metrics: service.metrics,
    services: [
      {
        definition: paymentPackage().PaymentService.service,
        handlers: paymentControl.extend(paymentServiceHandlers({ accept: service.app.get(AcceptPaymentCommand), batchGet: service.app.get(BatchGetPaymentStates), getPayment: new GetPaymentDetail({ reader: store, signals: depositSignals, cipher: virtualAccountCipher, depositLog, depositSignals, clock: systemClock }), cancelPayment, prepareCheckout: new PrepareCheckout({ selection: pgSelection, pauses: entryPauses, trials: entryPauseStore, trialSignals: entryPauseSignals, gateways, channels, defaults: checkoutConfig.defaults, webOrigin: checkoutConfig.webOrigin, virtualAccountReady: virtualAccountCipher.ready, clock: systemClock, log: paymentCheckoutLog(service.logger), signals: checkoutSignals, ...(fallbackExclusions ? { fallbackExclusions } : {}) }), getNewPaymentPause: new GetNewPaymentPause({ selection: pgSelectionBatch, pauses: entryPauses, channels, defaults: checkoutConfig.defaults, ...(fallbackExclusions ? { fallbackExclusions } : {}) }), checkEventPgAssignment: new CheckEventPgAssignment({ selection: new DrizzlePgSelection({ database: batchDatabase }), ...(portoneChannels ? { portone: portoneChannels } : {}), approvalTps }) }, (method, err, orderId) =>
          // 오류 객체를 싣지 않는다: 드라이버 오류의 글에 문장 값(결제 키·토큰)이 실릴 수 있다
          service.logger.error({ method, code: safeErrorCode(err), ...(orderId ? { orderId } : {}) }, 'PaymentService 처리 실패'),
        ), (method, err) => service.logger.error({ method, code: safeErrorCode(err) }, 'PaymentService 처리 실패')),
      },
      {
        definition: compensationTransferPackage().CompensationTransferService.service,
        handlers: compensationTransferHandlers(compensationTransfers),
      },
    ],
    internal: { ...(internalGrpcToken ? { token: internalGrpcToken } : {}), services: ['peaket.payment.v1.CompensationTransferService'] },
  });
  const controlPort = await paymentControl.listen();
  service.readiness.complete('grpc');
  service.logger.info({ port: grpc.port }, '업무 gRPC 포트를 열었다');

  // lease_owner에 적는 파드 이름(쿠버네티스가 PEAKET_POD를 넣는다. 없으면 호스트 이름)
  const podId = env.PEAKET_POD?.trim() || hostname();
  // 채널별 호출 보호기는 두 실행기가 하나를 함께 쓴다(토큰 버킷은 승인과 단독 조회를 함께 센다, BUILD_ORDER PRF-183)
  // 시험 재개의 첫 승인 결과는 승인 실행기 풀에서 쓴다(BUILD_ORDER PRF-202)
  const entryTrialResults = new DrizzleEntryPause({ database: confirmDatabase });
  // 가상계좌를 끈 회차의 입금 대기 답을 입금 전 취소로 끝낸다(POL-014, H2, HOT-152 경로). 실패하면 입금 기한 경과가 받친다(T17)
  const disallowedDeposit = async (x: { readonly paymentId: string; readonly orderId: string }): Promise<void> => {
    try {
      await depositCancel.execute({ paymentId: x.paymentId, cancellationId: x.paymentId, reason: VIRTUAL_ACCOUNT_DISALLOWED_REASON });
    } catch (err) {
      service.logger.error({ orderId: x.orderId, code: safeErrorCode(err) }, '가상계좌를 끈 회차의 입금 전 취소 실패(입금 기한이 끝나면 풀린다)');
    }
  };
  // 다시 띄운 파드는 승인 실행기를 켜기 전에 표를 한 번 읽어 낮춘 상한으로 이어 간다. 읽지 못하면 경고 한 줄(맞추기가 남긴다)이고 1초 [가정] 뒤 다시 읽는다(BUILD_ORDER PRF-203)
  await limitSync.refresh();
  limitSync.start();
  const confirmRunner = new PaymentConfirmRunner({ jobs: confirmJobs, gateways, guards, log: paymentConfirmLog(service.logger), signals: confirmSignals, clock: systemClock, podId, hotPath, methodRefs, methodRefSignals, deposit, disallowedDeposit, resolution: resolutionSignals, trialResults: entryTrialResults, pauses: entryPauses, trialSignals: entryPauseSignals });
  confirmRunner.start();
  const unknownResolver = new PaymentUnknownResolver({ queries: confirmJobs, gateways, guards, log: paymentUnknownLog(service.logger), signals: unknownSignals, clock: systemClock, methodRefs, methodRefSignals, deposit, disallowedDeposit, resolution: resolutionSignals });
  unknownResolver.start();

  // 새 결제 진입 정지 판정자(BUILD_ORDER PRF-202, ADR-0105 결정 8): Lease로 뽑은 파드 하나가 돈다. 파드 밖(local·ci)은 이 프로세스 하나만 리더다
  const entryPauseLeaseApi: LeaseApi = env.KUBERNETES_SERVICE_HOST ? inClusterLeaseApi(ENTRY_PAUSE_LEASE_NAME, env) : memoryLeaseApi();
  // 판정자가 없으면 합이 0으로 보인다(BUILD_ORDER PRF-202 코드 리뷰)
  const entryPauseElector = new LeaseElector({ api: entryPauseLeaseApi, identity: podId, clock: systemClock, onChange: (leader) => entryPauseSignals.judgeLeader(leader) });
  // 주소가 없는 것은 local·ci뿐이다. 그때는 '입력 없음'이고 판정자 파드의 서킷만으로 멈추며 자동으로는 다시 열지 않는다(ADR-0069)
  if (!promUrl) service.logger.warn({ kind: 'payment-entry-pause-no-inputs' }, 'PEAKET_PROMETHEUS_URL이 없어 정지 판정자가 제어 입력 없이 돈다(자기 파드의 서킷만으로 멈추고 자동으로 다시 열지 않는다)');
  const entryPauseInputs = promUrl ? new PrometheusEntryPauseInputs({ baseUrl: promUrl }) : NO_ENTRY_PAUSE_CLUSTER_INPUTS;
  const entryPauseJudgeStore = new DrizzleEntryPause({ database: batchDatabase });
  const entryPauseJudge = new EntryPauseJudge({ store: entryPauseJudgeStore, inputs: entryPauseInputs, gateways, guards, leader: entryPauseElector, podCount: guardConfig.podCount, clock: systemClock, signals: entryPauseSignals, log: entryPauseLog(service.logger) });
  entryPauseElector.start();
  entryPauseJudge.start();

  // 회차 정산 스케줄러(A2-06): Lease로 뽑힌 파드 하나가 회차 종료 다음 영업일 06시(KST)에 끝난 회차를 계산한다.
  // 첫 실행은 리더가 된 직후 onChange가 force로 부른다(A1V-07).
  const settlementDueLeaseApi: LeaseApi = env.KUBERNETES_SERVICE_HOST ? inClusterLeaseApi(SETTLEMENT_DUE_LEASE_NAME, env) : memoryLeaseApi();
  let settlementDueWorker: SettlementDueWorker | undefined;
  const settlementDueElector = new LeaseElector({
    api: settlementDueLeaseApi,
    identity: podId,
    clock: systemClock,
    onChange: (leader) => {
      if (leader) void settlementDueWorker?.tick(true);
    },
  });
  settlementDueWorker = env.PEAKET_CORE_HTTP_URL
    ? new SettlementDueWorker({
        settlements: service.app.get(Settlements),
        leader: settlementDueElector,
        clock: systemClock,
        log: {
          ticked: ({ through, calculated }) => service.logger.info({ kind: 'settlement-due-ticked', through, calculated }, '회차 정산 스케줄러가 돌았다'),
          failed: (err) => service.logger.error({ kind: 'settlement-due-failed', code: safeErrorCode(err) }, '회차 정산 스케줄러 실패'),
          productSkipped: ({ periodStart, periodEnd }) => service.logger.warn({ kind: 'settlement-product-skipped', periodStart, periodEnd }, '상품 정산서 주 계산을 건너뛰었다(다음 점검에서 다시 본다)'),
        },
      })
    : undefined;
  // 토스 지급 전송 일꾼(ADR-0369 결정 7): 같은 리더가 1분 [가정]마다 다시 보낼 묶음을 보낸다. 토스 지급대행 설정이 있을 때만 뜬다
  const payoutSubmitWorker = tossPayout.transport
    ? new PayoutSubmitWorker({
        settlements: service.app.get(Settlements),
        leader: settlementDueElector,
        clock: systemClock,
        onError: (err) => service.logger.error({ kind: 'settlement-payout-submit-failed', code: safeErrorCode(err) }, '토스 지급 전송 일꾼 실패'),
      })
    : undefined;
  // 배상 송금 결과 확정 바퀴(F-07-8 I-06, transfer-refund §6 '송금 결과 확정'): 같은 리더가 1분 [가정]마다 REQUESTED 송금을 PAID·FAILED로 확정한다
  const compensationRefreshLoop = new CompensationRefreshLoop({
    transfers: compensationTransfers,
    leader: settlementDueElector,
    onError: (err) => service.logger.error({ kind: 'compensation_transfer_refresh_failed', code: safeErrorCode(err) }, '배상 송금 결과 확정 바퀴 실패'),
  });
  settlementDueElector.start();
  settlementDueWorker?.start();
  payoutSubmitWorker?.start();
  compensationRefreshLoop.start();

  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    service.readiness.register('shutting-down');
    // gRPC 포트를 닫아 새 호출을 받지 않으면서 두 실행기를 멈춘다(돌던 호출과 그 뒤 쓰기를 기다린다). 그 뒤에 표 맞추기와 관측기를 멈추고(마무리 중의 낮춤도 표에 쓴다, BUILD_ORDER PRF-203 코드 리뷰 F5),
    // 모두 끝나면 서비스와 DB 풀을 닫는다. 앞 단계가 실패해도 뒤 단계를 한다
    return shutdownInOrder({
      stop: () => [
        grpc.close(),
        paymentControl.stop(),
        confirmRunner.stop(),
        unknownResolver.stop(),
        entryPauseJudge.stop().then(() => entryPauseElector.stop()),
        Promise.all([settlementDueWorker?.stop() ?? Promise.resolve(), payoutSubmitWorker?.stop() ?? Promise.resolve(), compensationRefreshLoop.stop()]).then(() => settlementDueElector.stop()),
      ],
      drain: () => [limitSync!.stop(), channelObserver?.whenIdle() ?? Promise.resolve(), pgAssignmentSettings.stop()],
      closeService: () => service.close(),
      closeConnections: () => [controlSync?.close(), Promise.resolve(circuits.shutdown()), database.close(), batchDatabase.close(), confirmDatabase.close(), webhookDatabase.close(), pgHttp?.close(), pgQueryHttp?.close(), tossHttp?.close(), tossQueryHttp?.close(), portoneHttp?.close(), portoneQueryHttp?.close(), tenantRedis?.close(), reauthRedis?.close()],
      onError: (err) => service.logger.error({ code: safeErrorCode(err) }, 'payment-svc 종료 실패'),
    });
  };
  return { close: () => (closing ??= shutdown()), ports: { appPort: httpPorts.port, managementPort: httpPorts.managementPort, grpcPort: grpc.port, ...(controlPort !== undefined ? { controlPort } : {}) } };
}
