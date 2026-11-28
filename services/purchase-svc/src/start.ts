// purchase-svc 조립(BUILD_ORDER PRF-215, ADR-0262 결정 4). 서비스 시작 파일 main.ts와 한 프로세스 합본(services/bundle)이 같은 함수를 부른다.
// 환경 값은 인자로만 받는다(process.env를 읽지 않는다. 합본은 서비스마다 다른 환경 값을 넘긴다). 조립과 종료 차례는 나누기 전의 main.ts 그대로다.
// 앱 포트(REST: 좌석 홀드 POST /v1/events/{eventId}/holds, 좌석 스냅샷 GET /v1/events/{eventId}/seatmap-snapshot)·관리 포트(/metrics, /ready)는 서비스 뼈대가 연다.
// 주문 생성 POST /v1/orders(BUILD_ORDER PRF-161)는 purchase DB(PEAKET_DATABASE_URL)가 있을 때만 연다. 그때는 PEAKET_ORDER_CONSENT_VERSION이 있어야 하고,
// identity-svc(PEAKET_IDENTITY_GRPC_ADDR, host:port)가 없으면 로컬·CI만 재확인은 토큰 판정·가명은 비움으로 뜨고(시작 로그 경고), 그 밖의 환경은 시작하지 않는다.
// 1초 만료 반복(ExpirySweeper, BUILD_ORDER PRF-135)과 구매 세션 정리 반복(SessionSweeper, PRF-138)을 듣기 시작한 뒤 켜고 SIGTERM 때 끈다. 좌석 Lua 지표(seat_lua_errors_total)를 /metrics에 붙인다.
// purchase DB가 있으면 주문 Saga 1단계 실행기(OrderSagaRunner, PRF-165)도 같이 켜고 끈다. 승인 명령 주소는 PEAKET_PAYMENT_GRPC_ADDR(없으면 local·ci만 '늘 접수' 대역).
// purchase DB가 있으면 발권 실행기(TicketIssueRunner, PRF-170)도 Saga 실행기와 같은 자리에서 켜고 끈다(발권 재시도 큐 ticket_issue_job, ADR-0106 결정 2).
// 발권 주소는 PEAKET_TICKET_GRPC_ADDR(차단기 ticket-svc, 없으면 local·ci만 '늘 발권' 대역과 경고 한 줄, 그 밖은 시작 실패)이고, 지표 ticket_issue_*를 /metrics에 붙인다.
// 발권 큐 쓰기는 실행기 전용 일반 풀(연결 4개 [가정], purchase-svc-ticket-issue)을 쓴다(ticket-svc가 멈춰 실패가 몰려도 핫패스 풀을 잠그지 않게, 리뷰 고침 H1).
// 결제 결과 반영이 승인을 커밋하면 그 주문을 곧바로 깨우고(onApproved → kick), 발권해 CONFIRMED가 되면 이 파드의 결제 결과 기다림을 깨운다(onOrderChanged → notify).
// purchase DB가 있으면 결제 결과 당기기(PaymentResultPuller, PRF-171, ADR-0140)도 이 API 파드에서 켜고 끈다. 결과 사건이 늦은 주문(order_saga_job CONFIRM·AWAIT 행)을
// payment-svc BatchGetPayments(주소 PEAKET_PAYMENT_GRPC_ADDR, 차단기 payment-svc-batch, 없으면 local·ci만 '기록 없음' 대역과 경고 한 줄)로 묻고, trade.payments 소비자와
// 같은 결제 결과 반영 쓰임새(ApplyPaymentResult)로 반영한다. 그래서 그 쓰임새와 소비자 전용 풀은 소비자를 켜지 않은 local·ci에서도 만든다.
// 잡기·미루기는 당기기 전용 일반 풀(연결 2개 [가정], purchase-svc-payment-pull)을 쓰고, 지표 payment_result_pull*를 /metrics에 붙인다.
// purchase DB가 있으면 결제하지 않은 주문의 만료 판정(OrderExpiry, PRF-172, ADR-0107)을 만들어 구매 세션 종료·홀드 만료 고리에 꽂는다. 고리 전용 일반 풀(연결 4개 [가정], purchase-svc-order-expiry)을 쓰고
// 지표 purchase_order_expir*·purchase_order_open_stale을 /metrics에 붙인다. 안전망 반복(OrderExpirySweep)은 릴레이 프로세스가 돈다.
// 구매 세션은 좌석 Redis의 s:jti·s:session과 서버 고정 ECDH 개인키(PEAKET_PURCHASE_ECDH_KEY)로 확인한다(BUILD_ORDER PRF-136). 입장 토큰은 공개키 묶음
// (운영은 PEAKET_ADMISSION_JWKS_URL 주기 읽기, local·ci는 정적 PEAKET_ADMISSION_JWKS도, BAT-057)과 발급자(PEAKET_ADMISSION_ISSUER)로 확인하고, 스냅샷 API가 입장 토큰의 첫 사용에 구매 세션을 연다(PRF-137).
// 좌석맵 판은 환경 값 PEAKET_SEATMAP_DIR 폴더의 {eventId}.json이다(docs/features/seat-hold.md §2 '운영 좌석맵 판'). 30초 [가정]마다 읽은 회차를 다시 읽는다.
// purchase DB가 있으면 Kafka 소비자 둘(결제 결과 반영 trade.payments·홀드 원장 적재 trade.seats, BUILD_ORDER PRF-164, src/consumers.ts)을 듣기 시작한 뒤 켠다.
// 두 소비자는 핫패스 풀과 따로 소비자 전용 일반 풀(연결 4개 [가정], purchase-svc-consumers)을 쓴다(밀린 사건을 한꺼번에 처리해도 홀드·주문 요청이 풀 대기 초과를 받지 않게).
// 브로커 주소(PEAKET_KAFKA_BROKERS)가 없으면 local·ci만 소비자 없이 뜨고(시작 로그 경고), 그 밖의 환경은 시작하지 않는다. SIGTERM에서는 소비자와 결과 당기기 실행기를
// 가장 먼저 멈추고(둘 다 결제 결과를 반영해 뒤의 셋을 깨운다), 그다음 Saga·발권 실행기·기다림 표(돌던 호출과 그 뒤 쓰기를 기다린다)를, 서비스를 닫은 뒤
// gRPC 클라이언트·차단기와 연결을 닫는다.
// 오류 로그에는 플랫폼 errorSummary(이름·글, 쿼리 매개변수 값은 뺀다)만 싣는다.
// purchase DB가 있으면 회차 판매 상태 판정(SaleStateJudge, PRF-144, ADR-0122)도 듣기 시작한 뒤 켜고 SIGTERM 때 끈다. 판정 전용 일반 풀(연결 2개 [가정], purchase-svc-sale-state)을 쓰고 지표 purchase_event_sale_*를 /metrics에 붙인다.
// 좌석 Stream 릴레이·다시 만들기 반복·정비 일은 이 파일이 아니라 릴레이 프로세스(src/relay.ts, purchase-svc-outbox-relay 배포)가 돈다.
// 사건 값은 공용 Avro 인코더(@peaket/platform/avro, ADR-0357)로 만든다: 주문 사건(trade.orders Outbox), 홀드 시도(telemetry.purchase), 좌석·결제 화면 행동 신호(telemetry.behavior).
// 내는 주제가 있으면 PEAKET_SCHEMA_IDS_FILE(ConfigMap schema-ids)을 시작할 때 읽고(없거나 틀리면 시작하지 않는다), 듣기 전에 레지스트리 시작 확인을 한다
// (다름·404는 시작 실패, 닿지 못하면 설정의 ID로 계속하고 schema_startup_check_unavailable 1, 준비 상태에 넣지 않는다, ST-T16 ②).
// 회차 환급 팬 알림도 같은 trade.orders 코덱으로 만든다(한 토픽 한 형식, ADR-0357 결정 9).
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { Writable } from 'node:stream';
import { CircuitBreaker, createDatabase, createExternalHttpClient, createHotRedis, createService, type Database, errorSummary, HotPathMetrics, internalGrpcTokenFromEnv, kafkaTelemetrySend, type KafkaTelemetrySender, RedisReauthJtiStore, runbookGateConfigFromProcess, systemClock, telemetryDroppedCounter, telemetryKafkaFromEnv, TelemetrySink } from '@peaket/platform';
import { createKafkaProducer, type KafkaProducer, startServiceControlSync } from '@peaket/platform/stream-worker';
import { checkProducerSchemas, createAvroEncoder, readSchemaIdsFile, type AvroEncoder } from '@peaket/platform/avro';
import { avroSchemas } from '@peaket/contracts/avro';
import { AppModule } from './app.module.js';
import {
  DrizzleCancelledTickets,
  DrizzlePriorityGrantStore,
  DrizzlePrioritySeatSales,
  GrantPriorityPurchase,
  GrpcQueuePriorityGrants,
  priorityPurchaseHandlers,
  priorityPurchasePackage,
  PriorityGrantSync,
  PromPriorityGrantSignals,
  SeatMapPriorityCandidates,
  WithdrawPriorityGrant,
  type PriorityModuleDeps,
} from './modules/priority/index.js';
import { DrizzleSaleControlStore, RedisSaleControlCopies, SaleControlMemory, SaleControlReconciler, SetSalePause, SetSaleSuspension, type SaleControlModuleDeps } from './modules/sale-control/index.js';
import { startControlServer } from './control/control-server.js';
import {
  AccountWithdrawalTickets,
  CancelFraudTickets,
  CancelTicket,
  CancelTicketEventRefund,
  DrizzleCancellationOrders,
  DrizzleCancellationWrites,
  DrizzleCompensations,
  DrizzleCsCaseOutbox,
  DrizzleDeductionGapCancellations,
  DrizzleEventCancellationLookup,
  DrizzleEventOpenOrders,
  DrizzleEventRefundAttempts,
  DrizzleEventRefundClaims,
  DrizzleEventRefundHolds,
  DrizzleEventRefundStore,
  DrizzleEventRefundTargets,
  DrizzleFraudCancellationStore,
  DrizzlePendingCancellationConversions,
  DrizzleSeatReturns,
  DrizzleWithdrawalTickets,
  EVENT_REFUND_TICKET_DEADLINE_MS,
  EventRefundCancellerRouter,
  EventRefundGrpcController,
  EventRefundService,
  EventTicketCanceller,
  eventRefundPackage,
  fraudCancellationHandlers,
  fraudCancellationPackage,
  GetFraudCancellation,
  GrpcCompensationTransfer,
  GrpcPaymentCancellations,
  GrpcTicketCancellations,
  HttpCompensationCaseNotice,
  HttpDeductionGapNotice,
  HttpEventRefundAlert,
  HttpPgCircuits,
  eventRefundPgRateOf,
  HttpSettlementRecalculation,
  PgTokenBuckets,
  unsentSettlementRecalculation,
  HttpRefundFailureNotice,
  OutboxEventRefundFanNotifier,
  parseHolidayCalendar,
  PromCsCaseSignals,
  PromRefundAccountSignals,
  RedisSeatReturnNotices,
  type RefundModuleDeps,
  WeekendBusinessCalendar,
} from './modules/refund/index.js';
import { fanReauthGateFromEnv, fanReauthResultLogger, requireOpsInternalToken } from './refund-wiring.js';
import { startPurchaseGrpcServer } from './grpc-server.js';
import { consumerDatabaseOptions, kafkaConsumersFromEnv, paymentConsumerDatabaseOptions, paymentResultApply, type PurchaseConsumersOptions, startPurchaseConsumers } from './consumers.js';
import { hotConnectTimeoutMsFromEnv } from './db-pool.js';
import { acceptBulkheadLimitFromEnv, setAcceptBulkheadLimit, setWriteBulkheadLimit, writeBulkheadLimitFromEnv } from './write-bulkhead.js';
import {
  avroOrderEventCodec,
  BEHAVIOR_SIGNAL_RECORD,
  ORDER_EVENT_RECORD,
  TELEMETRY_BEHAVIOR_TOPIC,
  TRADE_ORDERS_TOPIC,
  type BehaviorSignalPublisher,
  type BookingModuleDeps,
  CancelCompensation,
  CONSENT_VERSION_ENV,
  type ContactRefs,
  CompensationRunner,
  discardBehaviorSignals,
  DrizzleOrderAccepts,
  DrizzleOrderStarts,
  DrizzleOrderExpiry,
  DrizzleOrderStore,
  DrizzleOrderWrites,
  DrizzlePaymentPull,
  DrizzlePaymentStatus,
  DrizzleSaga,
  DrizzleSalePaying,
  DrizzleTicketIssue,
  DrizzleCompensation,
  EventCompensationQueue,
  FenceCompensation,
  type IdentityRecheck,
  identityClientsFromEnv,
  InventoryOrderSeatPins,
  InventoryOrderSessions,
  InventoryOrderExpiry,
  InventorySeatSlots,
  InventoryOrderHoldExpiries,
  KafkaBehaviorSignals,
  LoggerCompensationLog,
  LoggerPaymentPullLog,
  LoggerSagaLog,
  LoggerTicketIssueLog,
  missingContactRefs,
  OrderExpiry,
  orderExpiryDatabaseOptions,
  OrderSagaRunner,
  noPaymentDepositReader,
  PAYMENT_DEPOSIT_BREAKER,
  PAYMENT_PULL_BREAKER,
  PAYMENT_CHECKOUT_BREAKER,
  PAYMENT_CHECKOUT_BREAKER_OPTIONS,
  type PaymentCheckouts,
  paymentCheckoutsFromEnv,
  newPaymentPausesFromEnv,
  PAYMENT_PAUSE_BREAKER_OPTIONS,
  paymentConfirmsFromEnv,
  paymentCompensatorFromEnv,
  paymentDepositReaderFromEnv,
  paymentPullDatabaseOptions,
  paymentStatusWaitTableDatabaseOptions,
  paymentResultReaderFromEnv,
  PaymentResultPuller,
  PaymentStatusWaitTable,
  PromCompensationSignals,
  sagaDatabaseOptions,
  PromOrderExpirySignals,
  PromOrderSignals,
  PromPaymentPullSignals,
  PromTicketIssueSignals,
  RedisBookingRestrictions,
  bookingRestrictionHandlers,
  bookingRestrictionPackage,
  DrizzleWithdrawalOrders,
  ProcessAccountWithdrawal,
  PromWithdrawalParticipantSignals,
  QuoteAccountWithdrawal,
  StartCompensation,
  ticketFenceFromEnv,
  type WithdrawalDepositCancellations,
  type WithdrawalTickets,
  withdrawalParticipantHandlers,
  withdrawalParticipantPackage,
  SeatMapSagaConfigs,
  SeatMapSaleConfigs,
  simulatorPaymentCheckouts,
  TICKET_DEPENDENCY,
  ticketIssueDatabaseOptions,
  ticketIssuerFromEnv,
  TicketIssueRunner,
  TicketVoidRunner,
  DrizzleTicketVoid,
  LoggerTicketVoidLog,
  PromTicketVoidSignals,
  unavailableIdentityRecheck,
  type SeatSlotReads,
} from './modules/booking/index.js';
import {
  CoreSaleConfigs,
  DrizzleEventSale,
  DrizzleSeatHoldLedger,
  DrizzleSeatRebuildSource,
  DrizzleSeatSales,
  EndPurchaseSession,
  ExpirySweeper,
  FileSeatMapSource,
  LayoutSeatMap,
  PromSaleStateSignals,
  PromSeatSignals,
  ManageHolds,
  RedisHoldLifecycle,
  HoldPauseView,
  type PaymentPauseSource,
  RedisOrderHolds,
  RedisPurchaseSessionStore,
  RedisSaleCounts,
  RedisSeatSlots,
  RedisSeatStore,
  RedisSessionEndedLog,
  RedisSessionIndex,
  RedisSessionStartedLog,
  RedisSweepLeases,
  SaleStateJudge,
  saleStateDatabaseOptions,
  SessionSweeper,
  ServerEcdhKey,
  OpenPurchaseSession,
  StoredPurchaseSessions,
  isAdmissionKeysUnavailable,
  SeatStoreUnavailable,
  discardBehaviorSignals as discardSeatBehaviorSignals,
  discardHoldAttempts,
  AvroBehaviorSignals,
  HOLD_ATTEMPT_RECORD,
  type HoldAttempts,
  KafkaHoldAttempts,
  TELEMETRY_PURCHASE_TOPIC,
  SeatBehaviorReporter,
  type BehaviorSignals,
  admissionKeysFromEnv,
  podIdFrom,
} from './modules/inventory/index.js';

const SERVICE = 'purchase-svc';
/** 종료 때 남은 텔레메트리를 보내는 시간 [가정] */
const TELEMETRY_CLOSE_MS = 2_000;
/** 좌석맵 판 파일을 다시 읽는 주기 30초 [가정](docs/features/seat-hold.md §2 '운영 좌석맵 판') */
const SEATMAP_REFRESH_MS = 30_000;

export interface StartOptions {
  /** 이 서비스의 환경 값(시작 파일은 process.env, 합본은 공통 값과 이 서비스의 환경 파일을 합친 값) */
  env: Record<string, string | undefined>;
  /** 로그 목적지(기본 표준 출력, 시험에서 바꿔 끼운다) */
  logDestination?: Writable;
  /** 듣기 시작한 뒤의 치명적 실패(Kafka 소비자를 켜지 못함). 서비스는 이미 종료 차례를 시작했다. 시작 파일은 종료 코드 1을 둔다 */
  onFatal?: (err: unknown) => void;
}

export interface StartedService {
  /** 종료 차례대로 닫는다. 여러 번 불러도 한 번만 닫고 같은 약속을 돌려준다 */
  close(): Promise<void>;
}

export async function start(o: StartOptions): Promise<StartedService> {
  const { env } = o;
  // BAT-037: 주문 생성·결제 시도 시작의 동시 처리 칸막이. BAT-038: 결제 접수는 별도 이름(purchase-accept)으로 보호한다
  setWriteBulkheadLimit(writeBulkheadLimitFromEnv(env));
  setAcceptBulkheadLimit(acceptBulkheadLimitFromEnv(env));
  // 좌석 Redis: 로컬·CI는 단일 노드 주소, 운영은 클러스터 시작 노드 주소들(쉼표)
  const clusterUrls = (env.PEAKET_SEAT_REDIS_CLUSTER_URLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const url = env.PEAKET_SEAT_REDIS_URL;
  if (!url && clusterUrls.length === 0) throw new Error('PEAKET_SEAT_REDIS_URL이나 PEAKET_SEAT_REDIS_CLUSTER_URLS가 없다(비밀 관리에서 넣는다)');

  const need = (name: string, what: string): string => {
    const v = env[name];
    if (!v) throw new Error(`${name}가 없다(${what})`);
    return v;
  };
  // 입장 토큰 공개키 묶음과 발급자, 좌석맵 판 폴더(docs/features/seat-hold.md §2). 묶음은 운영이 queue-svc 묶음 주기 읽기(PEAKET_ADMISSION_JWKS_URL),
  // local·ci는 정적 PEAKET_ADMISSION_JWKS도 받는다(두 값을 함께 두거나 local·ci 밖에서 주소가 없으면 시작하지 않는다, '입장 토큰 공개키 묶음 주기 읽기', BAT-057).
  // 주기 읽기의 로거·지표는 서비스가 생긴 뒤 붙이고 그때 첫 읽기를 시작한다(준비 상태는 막지 않는다)
  const { keys: admissionKeys, loader: admissionLoader } = admissionKeysFromEnv(env, { logger: { warn: (obj: object, msg: string) => log?.warn(obj, msg) } });
  const admissionIssuer = need('PEAKET_ADMISSION_ISSUER', '입장 토큰 발급자 iss');
  const seatMapDir = need('PEAKET_SEATMAP_DIR', '회차별 좌석맵 판 파일 {eventId}.json이 있는 폴더');
  // 판매 설정 사본(event_sale_config)을 core-svc 내부 HTTP 경로에서 읽는다(BAT-051). 주소가 없으면 파일 설정만 쓴다(로컬·CI).
  // 운영은 반드시 넣는다: 없으면 승인한 판매 정책 규칙을 평가하지 못한다(services/README.md).
  const coreHttpUrl = env.PEAKET_CORE_HTTP_URL;
  const envName = env.PEAKET_ENV ?? 'local';
  const internalGrpcToken = internalGrpcTokenFromEnv(env);
  // ops 주소가 있는데 내부 토큰이 없으면 운영은 시작하지 않는다(모든 CS 건이 401로 막힘, 웨이브 끝 리뷰 S1). local·ci는 경고(서비스 로거가 생기면 남긴다)
  const opsTokenWarnings: string[] = [];
  requireOpsInternalToken({ env, warn: (m) => void opsTokenWarnings.push(m) });
  if (!coreHttpUrl && envName !== 'local' && envName !== 'ci' && envName !== 'demo') throw new Error('PEAKET_CORE_HTTP_URL이 없다(core-svc 판매 설정 사본 읽기, 운영 필수)');

  // 만료 임대 값: {HOSTNAME 앞 57자}-{무작위 16진 6자리}. HOSTNAME이 없거나 키 조각 모양이 아니면 무작위 UUID(이 프로세스 안에서만 같다, L5)
  const podId = podIdFrom(env, (n) => randomBytes(n));

  // 서버 고정 ECDH 개인키: Secrets Manager에서 시작 때 메모리로만 읽는다(없거나 틀리면 시작하지 않는다, docs/security/secrets-and-keys.md)
  const ecdh = ServerEcdhKey.fromEnv(env);

  // purchase DB(PostgreSQL): 판매 확정 저장소 SeatSales의 연결(BUILD_ORDER PRF-140 ①). 핫패스 풀(기본 대기 250ms, BAT-034)이다. 홀드 원장 적재(PRF-141)와 결제 접수 Saga(PRF-160)가 필수로 만들 때까지
  // PEAKET_DATABASE_URL이 없으면 DB 없이 뜬다(좌석 홀드·구매 세션은 좌석 Redis만 쓴다). 풀 크기는 PgBouncer 배치와 함께 정한다(wbs 2.11.2)
  const databaseUrl = env.PEAKET_DATABASE_URL;
  // 핫패스 풀 16개 [가정](BAT-029: 10개에서 올려 홀드·주문·결제 접수·상태 읽기가 서로의 연결을 덜 기다리게 한다).
  // BAT-031 진단: 32개는 100/s 혼합 부하에서 이벤트 루프·PostgreSQL 연결 압박만 키우고 429를 줄이지 못해 16으로 되돌린다.
  // BAT-034: 연결 대기 100ms는 짧은 포화를 429로 거절했다. PEAKET_DB_HOT_CONNECT_TIMEOUT_MS 기본 250ms로 늘려 흡수한다(풀 크기는 16 유지).
  const database = databaseUrl
    ? createDatabase({ url: databaseUrl, profile: 'hot', applicationName: SERVICE, max: 16, connectionTimeoutMillis: hotConnectTimeoutMsFromEnv(env) })
    : undefined;
  const redis = await createHotRedis(clusterUrls.length > 0 ? { clusterUrls } : { url });
  const sessionStore = new RedisPurchaseSessionStore(redis);
  const bookingRestrictions = new RedisBookingRestrictions(redis);
  // 자동 배정 공연은 스냅샷을 받지 않아 첫 홀드 요청이 입장 토큰의 첫 사용이다(HOT-080).
  // 본문의 clientEphemeralPublicKey로 그 요청에서 구매 세션을 열고, 그 뒤 요청 인증 키를 같은 세션에서 꺼낸다.
  const firstUseOpener = new OpenPurchaseSession({ store: sessionStore, log: new RedisSessionStartedLog(redis), keys: admissionKeys, issuer: admissionIssuer, clock: systemClock });
  const sessions = new StoredPurchaseSessions({
    store: sessionStore,
    ecdh,
    clock: systemClock,
    openFirstUse: (i) =>
      firstUseOpener
        .execute({ token: i.token, accountId: i.accountId, loginSessionId: i.loginSessionId, eventId: i.eventId, clientKey: i.clientKey })
        .then((r) => r.sessionId === i.jti)
        .catch((e: unknown) => {
          // 좌석 Redis 장애와 공개키 묶음을 받지 못함(503 dependency-unavailable, BAT-057 리뷰 반영 R057-2)은 그대로 올리고, 그 밖의 열기 거절은 세션 없음(401)이다
          if (e instanceof SeatStoreUnavailable || isAdmissionKeysUnavailable(e)) throw e;
          return false;
        }),
  });
  // 좌석 화면 행동 요약(BUILD_ORDER BOT-055, ADR-0249): 텔레메트리 클러스터로 낸다. 주소가 없거나 틀리면 경고하고 그 기능만 끈다(값 있음은 배포 검사가 막는다)
  const telemetryKafka = telemetryKafkaFromEnv(SERVICE, env);
  // 공용 Avro 인코더(ADR-0357 결정 1·4·9): purchase DB가 있으면 주문 사건과 결제 화면 행동 신호, 텔레메트리 Kafka가 켜졌으면 홀드 시도와 좌석 화면 행동 신호를 낸다.
  // 낼 주제가 하나라도 있으면 설정 파일이 있어야 하고 그 주제가 모두 파일에 있어야 한다(없으면 여기서 시작하지 않는다, D-T39 ③)
  const produces: { topic: string; record: string }[] = [];
  if (databaseUrl) produces.push({ topic: TRADE_ORDERS_TOPIC, record: ORDER_EVENT_RECORD }, { topic: TELEMETRY_BEHAVIOR_TOPIC, record: BEHAVIOR_SIGNAL_RECORD });
  if (telemetryKafka.enabled) produces.push({ topic: TELEMETRY_PURCHASE_TOPIC, record: HOLD_ATTEMPT_RECORD }, { topic: TELEMETRY_BEHAVIOR_TOPIC, record: BEHAVIOR_SIGNAL_RECORD });
  const avroEncoder: AvroEncoder | undefined = produces.length > 0 ? createAvroEncoder({ schemaIds: readSchemaIdsFile(env), schemas: avroSchemas, produces }) : undefined;
  const orderCodec = databaseUrl && avroEncoder ? avroOrderEventCodec(avroEncoder) : undefined;
  const orderStoreOptions = { clock: systemClock, ...(orderCodec ? { codec: orderCodec } : {}) };
  let behaviorSignals: BehaviorSignals = discardSeatBehaviorSignals;
  // 홀드 시도 보내기는 서비스 지표·로거가 생긴 뒤 묶는다(그 전에는 홀드 요청이 오지 않는다)
  let holdAttempts: HoldAttempts = discardHoldAttempts;
  const behaviorPending = new Set<Promise<void>>();
  const seatBehavior = new SeatBehaviorReporter({
    claims: sessionStore,
    signals: { record: (r) => behaviorSignals.record(r) },
    clock: systemClock,
    after: (work) => {
      const p = work().finally(() => behaviorPending.delete(p));
      behaviorPending.add(p);
    },
    onFailed: (err) => service.logger.warn({ err: errorSummary(err) }, '좌석 행동 요약 표시를 잡지 못했다(요약은 잃는다, 홀드는 그대로다)'),
  });
  const signals = new PromSeatSignals();
  // 서비스 로거는 서비스를 만든 뒤에야 생기므로, 좌석맵 판은 늦게 묶는 로거로 경고를 남긴다(판 파일은 처음 요청 때 읽는다)
  let log: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void } | undefined;
  const coreSaleConfigs = coreHttpUrl
    ? new CoreSaleConfigs({ client: createExternalHttpClient({ provider: 'core-svc', baseUrl: coreHttpUrl, timeoutCapMs: 200, clock: systemClock }), clock: systemClock, ...(env.PEAKET_INTERNAL_TOKEN ? { internalToken: env.PEAKET_INTERNAL_TOKEN } : {}) })
    : undefined;
  const seatMap = new LayoutSeatMap({
    source: new FileSeatMapSource(seatMapDir),
    clock: systemClock,
    logger: { warn: (o, m) => log?.warn(o, m) },
    ...(coreSaleConfigs ? { overlay: coreSaleConfigs } : {}),
  });
  // 예매 취소 견적·취소(GAT-070·GAT-080). purchase DB가 있을 때만 연다.
  // 팬 취소의 재인증 토큰은 팬 공개키 묶음(PEAKET_IDENTITY_FAN_JWKS_URL)과 좌석 Redis의 jti 한 번 쓰기로 본다(docs/features/transfer-refund.md §3.1
  // '팬 취소의 재인증 확인'). 주소가 없으면 local·ci는 닫힌 대역(늘 403)과 시작 경고, 그 밖 환경은 시작하지 않는다(fanReauthGateFromEnv가 던짐).
  let refund: RefundModuleDeps | undefined;
  const fanReauthWarnings: string[] = [];
  let refundTickets: GrpcTicketCancellations | undefined;
  let refundPayments: GrpcPaymentCancellations | undefined;
  /**
   * 회차 취소 실행기가 쓰는 보상 큐(BAT-011). 보상 저장소는 booking 조립(아래)에서 생기므로 늦게 묶는다.
   * 그 전이면(듣기 전) 0을 준다(회차 취소도 그 전에 시작되지 않는다)
   */
  const compensationQueueLate: { queue(eventId: string): Promise<number> } = { queue: async () => 0 };
  /** BAT-425 지표: 계좌 다시 받기·배상·서킷 멈춤. 서비스를 만든 뒤 레지스트리에 붙인다 */
  const refundSignals = new PromRefundAccountSignals();
  let compensationTransfers: GrpcCompensationTransfer | undefined;
  let pgCircuits: HttpPgCircuits | undefined;
  const ticketGrpcAddr = env.PEAKET_TICKET_GRPC_ADDR;
  const paymentGrpcAddr = env.PEAKET_PAYMENT_GRPC_ADDR;
  // 탈퇴 참여자의 미사용 티켓 견적도 같은 달력을 쓴다(공제 없음 24시간 특례의 비영업일 계산). refund가 없으면(주소 없는 local·ci) 여기서 만든다
  const holidayFile = env.PEAKET_HOLIDAY_CALENDAR_FILE;
  const withdrawalCalendar = holidayFile ? parseHolidayCalendar(readFileSync(holidayFile, 'utf8')) : new WeekendBusinessCalendar();
  if (database && ticketGrpcAddr && paymentGrpcAddr) {
    const calendar = withdrawalCalendar;
    // ticket-svc 운영자 취소는 내부 토큰 + 호출자 purchase-svc만 받는다(리뷰 B6)
    refundTickets = new GrpcTicketCancellations({ address: ticketGrpcAddr, ...(internalGrpcToken ? { internalToken: internalGrpcToken } : {}) });
    refundPayments = new GrpcPaymentCancellations({ address: paymentGrpcAddr });
    // BAT-425: 배상 송금(같은 payment-svc gRPC)과 서킷 읽기(payment-svc 내부 HTTP). 주소가 없으면 local·ci는 닫힌 대역이고 그 밖은 시작 실패다(아래)
    compensationTransfers = new GrpcCompensationTransfer({ address: paymentGrpcAddr });
    const refundOpsUrl = env.PEAKET_OPS_HTTP_URL;
    const refundOpsClient = refundOpsUrl ? createExternalHttpClient({ provider: 'ops-svc', baseUrl: refundOpsUrl, timeoutCapMs: 5_000 }) : undefined;
    // 403·503마다 까닭 이름표 하나만 남긴다(403 info, 503 warn. 토큰·jti·계정 ID·세션 ID는 싣지 않는다, §3.1 '거절 기록'). 로거는 서비스를 만든 뒤 묶인다
    const fanReauth = fanReauthGateFromEnv({
      env,
      jti: new RedisReauthJtiStore(redis),
      clock: systemClock,
      warn: (m) => void fanReauthWarnings.push(m),
      onResult: fanReauthResultLogger({
        info: (o) => log?.info(o, '팬 취소의 재인증 토큰을 거절했다'),
        warn: (o) => log?.warn(o, '팬 취소의 재인증 토큰을 확인하지 못했다'),
      }),
    });
    const cancellationWrites = new DrizzleCancellationWrites(database, new DrizzleOrderStore(orderStoreOptions));
    refund = {
      orders: new DrizzleCancellationOrders(database, new SeatMapSaleConfigs(seatMap)),
      writes: cancellationWrites,
      seats: new DrizzleSeatReturns(new DrizzleSeatSales(database), seatMap, new RedisSeatReturnNotices(redis)),
      tickets: refundTickets,
      payments: refundPayments,
      calendar,
      // 회차 취소가 확정된 회차의 팬 취소·견적은 키 폐기 전에 409 event-cancelled(BAT-420 리뷰 D5)
      eventCancellations: new DrizzleEventCancellationLookup(database),
      // 견적·팬 취소의 가상계좌 판정은 같은 payment-svc 클라이언트의 GetPayment다(BUILD_ORDER GAT-090). 차단기 payment-svc-get은 서비스를 만든 뒤 묶는다
      paymentMethods: refundPayments,
      // BAT-425: 지연 환급 계좌 다시 받기·배상 목록·계좌 입력(ADR-0316·0317). 송금 기록은 purchase compensation 표에 남긴다
      refundAccountWrites: cancellationWrites,
      compensationStore: new DrizzleCompensations(database),
      compensationTransfer: compensationTransfers,
      ...(refundOpsClient ? { compensationNotice: new HttpCompensationCaseNotice(refundOpsClient, env.PEAKET_INTERNAL_TOKEN) } : {}),
      refundAccountSignals: { inc: (result) => refundSignals.refundAccount(result) },
      compensationSignals: { inc: (result) => refundSignals.compensation(result) },
      ...(fanReauth ? { reauth: fanReauth } : {}),
    };
  }
  if (database && (!ticketGrpcAddr || !paymentGrpcAddr) && envName !== 'local' && envName !== 'ci' && envName !== 'demo') {
    throw new Error('PEAKET_TICKET_GRPC_ADDR·PEAKET_PAYMENT_GRPC_ADDR가 없다(예매 취소, 운영 필수)');
  }
  // BAT-425 GAT-120: 회차 취소 일괄 환불의 자동 정지가 payment-svc 내부 `GET /internal/v1/circuits`를 읽는다.
  // 주소가 없으면 local·ci는 닫힌 대역(늘 거짓)이고 그 밖 환경은 시작하지 않는다(서킷이 늘 닫힌 채 조용히 도는 것을 막는다)
  const paymentHttpUrl = env.PEAKET_PAYMENT_HTTP_URL;
  if (paymentHttpUrl) {
    pgCircuits = new HttpPgCircuits({
      client: createExternalHttpClient({ provider: 'payment-svc', baseUrl: paymentHttpUrl, timeoutCapMs: 3_000 }),
      ...(env.PEAKET_INTERNAL_TOKEN ? { internalToken: env.PEAKET_INTERNAL_TOKEN } : {}),
      nowMs: () => systemClock.now(),
      log: { warn: (o: object, msg: string) => log?.warn(o, msg) },
    });
  }
  if (database && !paymentHttpUrl && envName !== 'local' && envName !== 'ci' && envName !== 'demo') {
    throw new Error('PEAKET_PAYMENT_HTTP_URL이 없다(회차 취소 서킷 읽기, 운영 필수)');
  }
  // F-07-8(ADR-0380 결정 1·2): Start 커밋 뒤 정산 보류 열기(payment-svc 내부 HTTP, 한도 3초 [가정]). 다시 하기·완료는 릴레이 리더 틱이 이어 간다.
  // 주소가 없으면 local·ci·test·demo만 '보내지 않음' 대역이고 그 밖은 시작 실패다
  const settlementRecalculation = paymentHttpUrl
    ? new HttpSettlementRecalculation(createExternalHttpClient({ provider: 'payment-svc', baseUrl: paymentHttpUrl, timeoutCapMs: 3_000 }), env.PEAKET_INTERNAL_TOKEN)
    : database
      ? unsentSettlementRecalculation(envName, (o: object, msg: string) => log?.warn(o, msg))
      : undefined;
  // F-07-8 I-07(R-T52): Start 첫 묶음·재개·신청도 결제사 몫마다 토큰 버킷 안에서 보낸다(PEAKET_EVENT_REFUND_PG_RATE, 기본 300 [가정]). 버킷은 이 파드 것이다(C-01)
  const eventRefundPgRate = eventRefundPgRateOf(env.PEAKET_EVENT_REFUND_PG_RATE);
  const eventRefundBuckets = new PgTokenBuckets({ ratePerSecond: eventRefundPgRate, burst: eventRefundPgRate, clock: systemClock });
  // 회차 취소 일괄 환불(BAT-425 GAT-120·GAT-130). 기존 예매 취소 Saga를 티켓마다 부르고, 진행률·부분 실패·수동 일시정지·재개,
  // 자동 정지(실패율·실패 금액·연속 실패·거절률), 연기 신청 창, 백그라운드 실행기, 팬 알림 Outbox를 남긴다.
  // CS 처리함·경보 연결은 ops-svc 내부 HTTP다. 주소가 없으면 로그 대역이다.
  let eventRefundService: EventRefundService | undefined;
  // CS 건 열기 실패·다시 열기 멈춤 지표(purchase_cs_case_open_failures_total{kind}·purchase_cs_case_reopen_cut_total{reason}, 웨이브 끝 리뷰 C2·다시 보기 2 N1).
  // 서비스를 만든 뒤 레지스트리에 붙인다
  const csCaseSignals = new PromCsCaseSignals();
  if (database && refund && refundTickets) {
    const opsUrl = env.PEAKET_OPS_HTTP_URL;
    const opsClient = opsUrl ? createExternalHttpClient({ provider: 'ops-svc', baseUrl: opsUrl, timeoutCapMs: 5_000 }) : undefined;
    // 회차 취소(CANCEL)는 전용 취소기(견적·좌석 되돌림 없음, 보류 취소 전환), 연기(POSTPONE) 신청 환급은 예매 취소 Saga로 간다(BAT-420 GAT-110, ADR-0280 결정 3).
    // 확정 뒤 끝난 주문은 쓸어 담고, 끝나지 않은 주문이 있으면 COMPLETED로 가지 않는다(결정 4·5)
    eventRefundService = new EventRefundService({
      store: new DrizzleEventRefundStore(database),
      targets: new DrizzleEventRefundTargets(database, new SeatMapSaleConfigs(seatMap)),
      canceller: new EventRefundCancellerRouter({
        cancel: new EventTicketCanceller({
          tickets: refundTickets,
          conversions: new DrizzlePendingCancellationConversions(database),
          orders: refund.orders,
          writes: refund.writes,
          payments: refund.payments,
          calendar: refund.calendar,
        }),
        postpone: new CancelTicketEventRefund(new CancelTicket(refund)),
      }),
      items: new DrizzleEventRefundStore(database),
      openOrders: new DrizzleEventOpenOrders(database),
      // 릴레이 리더의 runDue와 겹쳐도 주문 단위 잡기를 거친 쪽만 처리한다(Start 첫 묶음·Resume·Apply·CloseWindow, 웨이브 끝 리뷰 K2)
      claims: new DrizzleEventRefundClaims(database),
      // 확정 때 표시한 차액 건은 릴레이 리더의 runDue가 행마다 연다(C2·S1). ops 주소가 없으면 꽂지 않아 표시와 함께 로그 대역으로 간다
      ...(opsClient ? { csOutbox: new DrizzleCsCaseOutbox(database) } : {}),
      csCaseOpenFailures: csCaseSignals,
      attempts: new DrizzleEventRefundAttempts(database),
      fanNotifier: new OutboxEventRefundFanNotifier(orderCodec),
      // 회차 취소 요청 중 보류 취소의 환급 미룸(gRPC SetEventRefundHold)과 확정 때 남는 공제 차액 CS 건(BAT-420 몫 D, OPEN[45])
      holds: new DrizzleEventRefundHolds(database),
      gaps: new DrizzleDeductionGapCancellations(database),
      gapNotice: opsClient
        ? new HttpDeductionGapNotice(opsClient, env.PEAKET_INTERNAL_TOKEN)
        : {
            open: async (q) => {
              log?.warn({ event: 'event_refund_deduction_gap', cancellationId: q.cancellationId, requestId: q.requestId }, '회차 취소 확정 때 남는 공제 차액(CS 처리함 주소 없음)');
            },
          },
      configs: new SeatMapSaleConfigs(seatMap),
      log: { warn: (obj: object, msg: string) => log?.warn(obj, msg) },
      // BAT-425 GAT-120: 결제사 서킷이 열린 몫만 AUTO_CIRCUIT_OPEN으로 멈춘다. 읽기 실패는 거짓(환급은 계속한다, R-T45)
      ...(pgCircuits ? { circuitOpen: (pg) => pgCircuits!.circuitOpen(pg) } : {}),
      circuitPauses: { inc: (pg) => refundSignals.circuitPause(pg) },
      // 다시 열기 포트가 꽂히면 Start·Resume·Apply·CloseWindow는 표시만 하고 건은 릴레이 리더 틱 끝이 연다(다시 보기 2 N1). 내부 토큰은 생성자로 넘긴다(N2)
      notice: opsClient
        ? new HttpRefundFailureNotice(opsClient, env.PEAKET_INTERNAL_TOKEN)
        : {
            open: async (q) => {
              log?.warn(
                { event: 'event_refund_failed', requestId: q.requestId, orderId: q.orderId, ticketId: q.ticketId, cancellationId: q.cancellationId, attempts: q.attempts, error: q.lastError },
                '회차 취소 환불 실패(CS 처리함 주소 없음)',
              );
            },
          },
      alert: opsClient
        ? new HttpEventRefundAlert(opsClient)
        : {
            raise: async (q) => {
              log?.warn({ event: 'event_refund_alert', ...q }, '회차 취소 환불 경보(ops-svc 주소 없음)');
            },
          },
      nowMs: () => systemClock.now(),
      deadlineMs: () => systemClock.now() + EVENT_REFUND_TICKET_DEADLINE_MS,
      concurrency: 8,
      // 발권 대기(APPROVED) 주문은 보상 세 걸음으로 끝낸다(BAT-011, PRF-173). 실제 큐는 booking 조립이 채운다
      compensation: compensationQueueLate,
      ...(settlementRecalculation ? { settlement: settlementRecalculation } : {}),
      buckets: eventRefundBuckets,
    });
    refund.eventRefund = eventRefundService;
  }
  // 부정 예매 운영자 취소(BUILD_ORDER GAT-080, fraud_cancellation.proto, docs/features/transfer-refund.md §7.4, ADR-0171·ADR-0197).
  // 부르는 쪽은 ops-svc뿐이다(내부 토큰 + 호출자 ops-svc + 처리자 approved_by 증명). 결제사는 부르지 않고 환급 재시도 실행기가 REFUND_PENDING을 집는다.
  let fraudCancellation: { cancel: CancelFraudTickets; get: GetFraudCancellation } | undefined;
  if (database && refund && refundTickets) {
    const fraudStore = new DrizzleFraudCancellationStore(database);
    fraudCancellation = {
      cancel: new CancelFraudTickets({
        store: fraudStore,
        tickets: refundTickets,
        orders: refund.orders,
        configs: new SeatMapSaleConfigs(seatMap),
        writes: refund.writes,
        calendar: refund.calendar,
        ...(refund.seats ? { seats: refund.seats } : {}),
      }),
      get: new GetFraudCancellation(fraudStore),
    };
  }

  // 우선 구매 권리 발급·회수(GAT-135, POL-046 ⑦, ADR-0171). purchase DB가 있을 때만 연다.
  // 권리 발급은 좌석 Redis의 우선 구매 보류 Lua를 쓰고, 취소한 표는 purchase DB의 order_cancellation·order_item에서 읽는다.
  const prioritySeats = database ? new RedisSeatStore(redis, undefined, systemClock) : undefined;
  const priority: PriorityModuleDeps | undefined =
    database && prioritySeats
      ? {
          grants: new DrizzlePriorityGrantStore(database),
          cancelled: new DrizzleCancelledTickets(database, coreSaleConfigs),
          seats: prioritySeats,
          candidates: new SeatMapPriorityCandidates(seatMap),
          seatMap,
          sales: new DrizzlePrioritySeatSales(database),
          logger: { grantFailed: (i) => log?.warn({ ...i }, '우선 구매 권리 보상(보류 해제)에 실패해 재시도가 필요하다') },
        }
      : undefined;
  // 우선 구매 권리 회수(팔린 좌석 대조·소명 인정 뒤). 주문 생성이 팔린 좌석의 권리를 거절할 때도 같은 길을 쓴다
  const priorityWithdraw = priority ? new WithdrawPriorityGrant(priority.grants, () => systemClock.now(), { seats: priority.seats, seatMap }) : undefined;

  // 판매 중지·재개 사본(BAT-465 R-584, ADR-0123). 원본은 purchase DB sale_control, 사본은 좌석 Redis s:{event:E}:ctl이다.
  // purchase DB가 없으면 내부 HTTP 경로를 열지 않는다(홀드 Lua가 읽을 사본도 쓸 곳이 없다).
  // 명령 3(판매 일시정지)도 같은 원본·사본이고 판 칸은 따로다(F-02-1 OPS-300, ADR-0365 결정 6). 파드 메모리(saleMemory)는 받는 쪽 쓰기와 2초 다시 맞춤이 채우고,
  // 결제 시도·결제 접수의 정지 확인(booking slots 앞)과 구매 세션 정리의 유휴 시계가 읽는다(결정 7·8)
  const saleMemory = database ? new SaleControlMemory() : undefined;
  const saleControl: SaleControlModuleDeps | undefined =
    database && saleMemory ? { store: new DrizzleSaleControlStore(database), copies: new RedisSaleControlCopies(redis), memory: saleMemory } : undefined;
  // 제어 gRPC 받는 쪽(peaket.control.v1.ControlReceiver, ADR-0102·0103). 주소가 있을 때만 제어 전용 포트를 연다.
  const controlPort = Number(env.PEAKET_PURCHASE_CONTROL_GRPC_PORT ?? '');
  const controlServer =
    saleControl && Number.isInteger(controlPort) && controlPort > 0
      ? await startControlServer({
          host: env.PEAKET_CONTROL_GRPC_HOST ?? '0.0.0.0',
          port: controlPort,
          deps: {
            setSuspension: new SetSaleSuspension(saleControl.store, saleControl.copies, saleControl.memory),
            setPause: new SetSalePause(saleControl.store, saleControl.copies, saleControl.memory),
            podName: podId,
            nowMs: () => systemClock.now(),
            runbook: runbookGateConfigFromProcess(env, 'purchase-svc', (e) => service.logger.warn({ runbookSecurity: e }, '런북 묶음을 거부했다')),
          },
        })
      : undefined;

  // 주문 생성(booking, POST /v1/orders, BUILD_ORDER PRF-161). purchase DB가 있을 때만 연다(DB 없이 뜬 파드는 주문 경로를 열지 않는다, 뜨는 동작은 그대로다).
  // - 동의 문안 판: PEAKET_ORDER_CONSENT_VERSION(없거나 ^[0-9A-Za-z._-]{1,32}$가 아니면 시작하지 않는다. 모양은 BookingModule.register가 본다)
  // - identity-svc 클라이언트(재확인·가명)는 차단기가 서비스 지표·로거를 쓰므로 서비스를 만든 뒤 만든다. 그때까지(듣기 전) 부르면 '답 없음'과 같다
  // - 로그는 넘기지 않는다(모듈이 서비스 로거로 LoggerOrderLog를 만든다). 지표 PromOrderSignals는 서비스 레지스트리에 붙인다
  const orderSignals = new PromOrderSignals();
  // 핫패스 구간 진단(BAT-027): 서비스 레지스트리는 createService 뒤에 생기므로 지표 객체만 먼저 만들고, 듣기 전에 붙인다
  const hotPath = new HotPathMetrics(SERVICE);
  const identityLate: { recheck?: IdentityRecheck; contactRefs?: ContactRefs } = {};
  // - 결제 접수(POST /v1/orders/{orderId}/payment-acceptance, PRF-162)는 주문 생성과 같은 주문 전이 함수(DrizzleOrderStore)를 쓰고, 회차 슬롯 읽기는 좌석 Redis(RedisSeatSlots)다
  // - 접수를 커밋한 직후 Saga 실행기를 한 번 깨운다(onAccepted → OrderSagaRunner.kick, PRF-165). 실행기는 서비스 로거로 만들므로 늦게 묶는다(그 전이면 부르지 않는다)
  const orderStore = new DrizzleOrderStore(orderStoreOptions);
  let sagaRunner: OrderSagaRunner | undefined;
  // - 결제 결과 long polling(GET /v1/orders/{orderId}/payment-status, PRF-166): 읽기는 같은 핫패스 풀(쓰기 인스턴스), 기다림 표는 이 파드 하나다.
  //   Saga 실행기와 결제 결과 처리기(ApplyPaymentResult, trade.payments 소비자, PRF-164)의 onOrderChanged에 그 notify를 넘긴다(같은 파드가 주문을 바로 답할 상태로
  //   바꾸면 곧바로 깨운다). 다른 파드가 반영한 주문은 묶음 조회가 깨운다.
  //   기다림 표는 듣기 시작한 뒤 200ms 반복을 켜고, SIGTERM에서 Saga 실행기와 함께 끈다(남은 기다림은 STOPPED로 깨어 다시 읽지 않고 마지막 본문으로 답한다)
  // 입금 대기의 은행·계좌번호·입금 기한은 payment-svc GetPayment에서 읽어 응답에만 싣는다(차단기 payment-svc-get, 서비스를 만든 뒤 잇는다. 그때까지는 칸 없이 답한다, BUILD_ORDER HOT-151)
  let depositReader: ReturnType<typeof paymentDepositReaderFromEnv> | undefined;
  let depositBreaker: CircuitBreaker | undefined;
  const paymentStatusReads = database ? new DrizzlePaymentStatus({ database }) : undefined;
  // 기다림 표의 200ms 묶음 조회는 전용 일반 풀을 쓴다(BAT-029): 기다리는 주문이 많을 때 묶음 조회가 핫패스 풀(홀드·주문·상태 단건 읽기)을 빼앗지 않게.
  // 요청 경로의 단건 읽기(paymentStatusReads)는 핫패스 풀 그대로다
  let paymentStatusWaitDatabase: Database | undefined;
  let paymentStatusWaiters: PaymentStatusWaitTable | undefined;
  if (databaseUrl) {
    const waitDb = createDatabase(paymentStatusWaitTableDatabaseOptions(databaseUrl));
    paymentStatusWaitDatabase = waitDb;
    paymentStatusWaiters = new PaymentStatusWaitTable({ reads: new DrizzlePaymentStatus({ database: waitDb }), clock: systemClock, signals: orderSignals, hotPath });
  }
  // 결제 시도 시작(POST /v1/orders/{orderId}/payments, BUILD_ORDER PRF-191): 결제창 준비 클라이언트와 행동 신호 생산자는 서비스 지표·로거를 쓰므로 서비스를 만든 뒤 묶는다.
  // 그 전이면(듣기 전) 불리지 않는다. 행동 신호는 브로커 주소가 없으면(local·ci) 버린다
  const startLate: { checkouts?: PaymentCheckouts; behavior?: BehaviorSignalPublisher } = {};
  // 홀드 해제·연장·다시 읽기와 결제 정지 멈춤(BUILD_ORDER HOT-070). 주문 만료 고리와 정지 조회 클라이언트는 서비스를 만든 뒤 묶는다
  const holdLifecycle = new RedisHoldLifecycle(redis);
  const manageHolds = new ManageHolds({ lifecycle: holdLifecycle, seatMap, sessions: sessionStore, keys: admissionKeys, issuer: admissionIssuer, clock: systemClock, signals, onReleased: (e) => orderExpiry?.onHoldsExpired(e), logger: { warn: (o: object, m: string) => log?.warn(o, m) } as never });
  const pauseLate: { source?: PaymentPauseSource } = {};
  const holdPauseView = new HoldPauseView({ read: (ids, o) => (pauseLate.source ? pauseLate.source.read(ids, o) : Promise.resolve({ status: 'OK' as const, pauses: [] })) }, systemClock, (r) => signals.pauseRead(r));
  // 주문 생성의 홀드 확인과 Saga 예약의 1인 한도 읽기가 같은 어댑터를 쓴다(BAT-051)
  const orderHolds = new RedisOrderHolds(redis, seatMap);
  const booking: BookingModuleDeps | undefined = database
    ? {
        startPayment: {
          starts: new DrizzleOrderStarts({ database, store: orderStore, clock: systemClock }),
          checkouts: { prepare: (q) => (startLate.checkouts ?? simulatorPaymentCheckouts).prepare(q) },
          holdExpiries: new InventoryOrderHoldExpiries(orderHolds),
          behavior: { publish: (m) => (startLate.behavior ?? discardBehaviorSignals).publish(m) },
          signals: orderSignals,
        },
        writes: new DrizzleOrderWrites({ database, store: orderStore, clock: systemClock }),
        accepts: new DrizzleOrderAccepts({ database, store: orderStore, clock: systemClock }),
        // 파드 메모리가 정지(명령 3 회차·전체, 판매 중지)라 하면 좌석 Redis를 부르지 않고 PAUSED(423 sale-paused)다(ADR-0365 결정 7)
        slots: pauseAwareSlots(new InventorySeatSlots(new RedisSeatSlots(redis)), saleMemory),
        holds: orderHolds,
        holdMarks: manageHolds,
        saleConfigs: new SeatMapSaleConfigs(seatMap),
        sessions: new InventoryOrderSessions({ sessions, store: sessionStore }),
        identity: { check: (q) => (identityLate.recheck ?? unavailableIdentityRecheck).check(q) },
        contactRefs: { compute: (phone, ms) => (identityLate.contactRefs ?? missingContactRefs).compute(phone, ms) },
        restrictions: bookingRestrictions,
        priorityGrants: priority!.grants,
        ...(priority?.sales ? { prioritySeatSales: priority.sales } : {}),
        ...(priorityWithdraw ? { priorityWithdraw: (grantId: string) => priorityWithdraw.run(grantId, 'system:order-create') } : {}),
        signals: orderSignals,
        consentVersion: need(CONSENT_VERSION_ENV, '주문 동의 두 개에 보인 고지 문안의 판, 1~32자의 영문·숫자·._-'),
        onAccepted: (orderId) => sagaRunner?.kick(orderId),
        ...(paymentStatusReads && paymentStatusWaiters ? { paymentStatus: { reads: paymentStatusReads, waiters: paymentStatusWaiters, deposits: { read: (id, o) => (depositReader?.reader ?? noPaymentDepositReader).read(id, o) } } } : {}),
        hotPath,
      }
    : undefined;
  // 주문 만료 고리(PRF-172): 판정기는 서비스 로거·지표로 만들므로 늦게 묶는다(그 전이면 부르지 않는다. 고리를 부르는 반복·요청은 듣기 시작한 뒤에만 돈다).
  // purchase DB 없이 뜬 파드는 판정기가 없어 고리가 아무것도 하지 않는다
  let orderExpiry: OrderExpiry | undefined;
  const onSessionEnded = (e: { readonly purchaseSessionId: string }): void => orderExpiry?.onSessionEnded(e);
  const service = await createService({
    name: SERVICE,
    env,
    hotPath,
    ...(o.logDestination ? { logDestination: o.logDestination } : {}),
    module: AppModule.register({
      redis,
      seatMap,
      attempts: { record: (a) => holdAttempts.record(a) },
      seatBehavior,
      sessions,
      podId,
      signals,
      onHoldsExpired: (e) => orderExpiry?.onHoldsExpired(e),
      holdFreeze: { pauseView: holdPauseView, lifecycle: holdLifecycle },
      ...(database ? { seatSales: new DrizzleSeatSales(database) } : {}),
      // 판매 열기 내부 경로(BAT-616): core-svc 승인이 부르면 event_sale UPCOMING·seat_rebuild 판 1·좌석 Redis를 차례로 연다
      ...(database ? { saleOpen: { events: new DrizzleEventSale({ database, clock: systemClock }), marks: new DrizzleSeatRebuildSource(database) } } : {}),
      ...(booking ? { booking } : {}),
      ...(refund ? { refund } : {}),
      ...(priority ? { priority } : {}),
      ...(priority && prioritySeats
        ? {
            priorityExpiries: prioritySeats,
            onPriorityGrantsExpired: async (e: { eventId: string; grantIds: readonly string[] }) => {
              for (const grantId of e.grantIds) await priority.grants.expire(grantId, systemClock.now());
            },
          }
        : {}),
      ...(saleControl ? { saleControl } : {}),
      ...(database ? { attendeeExport: { database } } : {}),
      hotPath,
      admission: {
        store: sessionStore,
        startedLog: new RedisSessionStartedLog(redis),
        endedLog: new RedisSessionEndedLog(redis),
        index: new RedisSessionIndex(redis),
        keys: admissionKeys,
        issuer: admissionIssuer,
        onSessionEnded,
        manageHolds,
        ...(saleMemory ? { salePauses: saleMemory } : {}),
      },
    }),
    purchaseSessions: sessions,
  });
  log = service.logger;
  // 입장 토큰 공개키 묶음 주기 읽기: 지표를 붙이고 첫 읽기를 시작한다(기다리지 않는다. 받기 전의 서명 확인 요청은 1초까지 기다린 뒤 503이다)
  if (admissionLoader) {
    admissionLoader.register(service.metrics.registry);
    void admissionLoader.start();
  }
  for (const m of opsTokenWarnings) service.logger.warn({ event: 'purchase-ops-internal-token-missing' }, m);
  for (const m of fanReauthWarnings) service.logger.warn({ dep: 'identity-jwks', event: 'purchase-fan-reauth-jwks-missing' }, m);
  // DB 없이 뜬 것을 시작 로그에 남긴다(운영에서 비밀이 빠진 것을 결제 접수 연결(PRF-160) 전에도 알아채게, PRF-140 ① 리뷰)
  if (!database) service.logger.warn({ dep: 'postgres' }, 'PEAKET_DATABASE_URL이 없어 purchase DB 없이 떴다(판매 확정 저장소 SeatSales와 주문 생성 POST /v1/orders를 내놓지 않는다)');
  signals.register(service.metrics.registry);
  hotPath.register(service.metrics.registry);

  // 우선 구매 권리 상태 대조(ADR-0385, GAT-135 A13·A14). purchase DB와 queue-svc 주소가 있을 때만 켠다.
  // 주소가 없으면 local·ci·demo는 경고 한 줄로 끄고, 그 밖의 환경은 시작하지 않는다(사본이 조용히 어긋나는 것을 막는다).
  const queueGrpcAddr = env.PEAKET_QUEUE_GRPC_ADDR;
  let prioritySync: PriorityGrantSync | undefined;
  let priorityCopies: GrpcQueuePriorityGrants | undefined;
  if (priority) {
    if (queueGrpcAddr) {
      priorityCopies = new GrpcQueuePriorityGrants(queueGrpcAddr);
      const prioritySignals = new PromPriorityGrantSignals().register(service.metrics.registry);
      prioritySync = new PriorityGrantSync({ grants: priority.grants, copies: priorityCopies, clock: systemClock, logger: service.logger, signals: prioritySignals });
    } else if (envName === 'local' || envName === 'ci' || envName === 'demo') {
      service.logger.warn({ dep: 'queue-svc' }, 'PEAKET_QUEUE_GRPC_ADDR가 없어 우선 구매 권리 상태 대조를 끈다');
    } else {
      throw new Error('PEAKET_QUEUE_GRPC_ADDR가 없다(우선 구매 권리 상태 대조, 운영 필수)');
    }
  }
  csCaseSignals.register(service.metrics.registry);
  refundSignals.register(service.metrics.registry);
  // 첫 환급 판정 전에 서킷 상태를 한 번 읽는다(기다리지 않는다). 읽기 실패는 모든 몫을 거짓으로 두고 경고만 남긴다
  if (pgCircuits) void pgCircuits.refresh();
  // 주문 생성의 identity-svc 클라이언트(듣기 전에 붙인다). 재확인은 차단기로 감싼다(열리면 부르지 않고 토큰 판정, ADR-0055). 주소가 없으면 대역과 경고 한 줄
  // 가명 계산은 재확인과 따로인 차단기다(identity-svc-contact-ref: 가명이 막혀도 재확인 차단기를 열지 않는다). local·ci가 아닌데 주소가 없으면 여기서 던진다(시작 실패, 듣기 전)
  let identity: ReturnType<typeof identityClientsFromEnv> | undefined;
  const identityBreakers: CircuitBreaker[] = [];
  if (booking) {
    orderSignals.register(service.metrics.registry);
    const breakerOf = (dependency: string) => new CircuitBreaker({ service: SERVICE, dependency, registry: service.metrics.registry, logger: service.logger });
    const breaker = breakerOf('identity-svc');
    const contactRefBreaker = breakerOf('identity-svc-contact-ref');
    identityBreakers.push(breaker, contactRefBreaker);
    identity = identityClientsFromEnv(env, { profile: service.config.grpcLbProfile, breaker, contactRefBreaker });
    for (const w of identity.warnings) service.logger.warn({ dep: 'identity-svc' }, w);
    identityLate.recheck = identity.recheck;
    identityLate.contactRefs = identity.contactRefs;
  }
  // 결제하지 않은 주문의 만료 판정(OrderExpiry, BUILD_ORDER PRF-172, ADR-0107, docs/features/payment.md §2 '결제하지 않은 주문 만료의 첫 구현'): purchase DB가 있을 때 이 API 파드에서 만든다.
  // 구현에서 정한 것: 트랜잭션은 핫패스 풀이 아니라 고리 전용 일반 풀(orderExpiryDatabaseOptions, 연결 4개 [가정] = 고리 동시 수)을 쓰고 종료 때 닫는다(만료가 몰려도 홀드·주문 요청이 풀 대기 초과를 받지 않게).
  // 판정기에는 따로 켜는 반복이 없다(고리가 불릴 때만 돈다). 고리를 부르는 만료 반복·정리 반복·나가기 경로가 듣기 시작한 뒤에 돌므로 듣기 시작 뒤에 켜진 것과 같고, SIGTERM 때 멈춘다
  let orderExpiryDatabase: Database | undefined;
  if (database && databaseUrl) {
    const expiryDb = createDatabase(orderExpiryDatabaseOptions(databaseUrl));
    orderExpiryDatabase = expiryDb;
    orderExpiry = new OrderExpiry({
      store: new DrizzleOrderExpiry({ database: expiryDb, store: orderStore, clock: systemClock }),
      inventory: new InventoryOrderExpiry({ sessions: sessionStore, holds: new RedisOrderHolds(redis, seatMap), clock: systemClock }),
      signals: new PromOrderExpirySignals().register(service.metrics.registry),
      clock: systemClock,
      logger: service.logger,
    });
  }
  // 주문 Saga 1단계 실행기(OrderSagaRunner, BUILD_ORDER PRF-165): purchase DB가 있을 때(booking이 있을 때) 이 API 파드에서 켠다.
  // 승인 명령(payment-svc ConfirmPayment)은 차단기로 감싸고, 주소(PEAKET_PAYMENT_GRPC_ADDR)가 없으면 local·ci만 '늘 접수' 대역과 경고 한 줄이다.
  // 그 밖의 환경은 주소가 없으면 여기서 던진다(시작 실패, 듣기 전). 듣기 시작한 뒤 1초 반복을 켜고 SIGTERM 때 끈다
  let payment: ReturnType<typeof paymentConfirmsFromEnv> | undefined;
  let paymentBreaker: CircuitBreaker | undefined;
  let sagaDatabase: Database | undefined;
  // 새 결제 일시 정지 조회(GetNewPaymentPause, BUILD_ORDER HOT-070). 주소가 없으면 local·ci만 '정지 없음' 대역이고 그 밖의 환경은 시작을 실패시킨다
  const pauseBreaker = new CircuitBreaker({ service: SERVICE, ...PAYMENT_PAUSE_BREAKER_OPTIONS, registry: service.metrics.registry, logger: service.logger });
  const pauseClient = newPaymentPausesFromEnv(env, { profile: service.config.grpcLbProfile, breaker: pauseBreaker, onRejected: (reason) => service.logger.error({ dep: 'payment-svc', reason }, 'GetNewPaymentPause가 요청을 거절했다(부르는 쪽 결함)') });
  for (const w of pauseClient.warnings) service.logger.warn({ dep: 'payment-svc' }, w);
  pauseLate.source = { read: async (ids, o) => { const r = await pauseClient.pauses.read(ids, o); return r.status === 'OK' ? { status: 'OK', pauses: r.pauses } : { status: 'FAILED' }; } };
  let paymentCheckouts: ReturnType<typeof paymentCheckoutsFromEnv> | undefined;
  let checkoutBreaker: CircuitBreaker | undefined;
  if (booking && database && databaseUrl) {
    paymentBreaker = new CircuitBreaker({ service: SERVICE, dependency: 'payment-svc', registry: service.metrics.registry, logger: service.logger });
    payment = paymentConfirmsFromEnv(env, { profile: service.config.grpcLbProfile, breaker: paymentBreaker });
    for (const w of payment.warnings) service.logger.warn({ dep: 'payment-svc' }, w);
    depositBreaker = new CircuitBreaker({ service: SERVICE, dependency: PAYMENT_DEPOSIT_BREAKER, registry: service.metrics.registry, logger: service.logger });
    // 견적·팬 취소의 결제 수단 읽기도 같은 GetPayment라 같은 차단기(payment-svc-get)를 쓴다(docs/features/payment.md §6 'purchase-svc 견적', BUILD_ORDER GAT-090)
    refundPayments?.useMethodBreaker(depositBreaker);
    depositReader = paymentDepositReaderFromEnv(env, {
      profile: service.config.grpcLbProfile,
      breaker: depositBreaker,
      onFailure: (code) => orderSignals.depositReadFailed(code),
      // 주문 ID만 싣는다. 답의 계좌 칸과 답의 주문 ID는 싣지 않는다
      onOrderMismatch: (orderId) => service.logger.warn({ kind: 'payment-deposit-order-mismatch', orderId }, 'GetPayment 답의 주문 ID가 요청과 달라 계좌 칸을 버렸다'),
    });
    // 결제창 준비(PrepareCheckout, PRF-191): 승인 명령과 따로인 차단기(payment-svc-checkout, 실패 분류·파드당 동시 상한은 옵션에 있다)이고, 주소가 없으면 local·ci만 시뮬레이터 대역과 경고 한 줄이다(그 밖은 여기서 던진다)
    checkoutBreaker = new CircuitBreaker({ service: SERVICE, ...PAYMENT_CHECKOUT_BREAKER_OPTIONS, registry: service.metrics.registry, logger: service.logger });
    paymentCheckouts = paymentCheckoutsFromEnv(env, { profile: service.config.grpcLbProfile, breaker: checkoutBreaker });
    for (const w of paymentCheckouts.warnings) service.logger.warn({ dep: PAYMENT_CHECKOUT_BREAKER }, w);
    startLate.checkouts = paymentCheckouts.checkouts;
    // Saga 실행기는 전용 일반 풀을 쓴다(BAT-029): 예약·승인 명령·실패 기록 트랜잭션이 HTTP 요청의 핫패스 풀을 기다리지 않게
    const sagaDb = createDatabase(sagaDatabaseOptions(databaseUrl));
    sagaDatabase = sagaDb;
    const saga = new DrizzleSaga({ database: sagaDb, store: orderStore, sales: new DrizzleSeatSales(sagaDb), clock: systemClock });
    sagaRunner = new OrderSagaRunner({
      jobs: saga,
      orders: saga,
      reserve: saga,
      failures: saga,
      confirmSent: saga,
      pins: new InventoryOrderSeatPins({ pins: new RedisSeatStore(redis, service.logger), seatMap }),
      holds: orderHolds,
      confirms: payment.confirms,
      configs: new SeatMapSagaConfigs(seatMap),
      log: new LoggerSagaLog(service.logger),
      clock: systemClock,
      hotPath,
      ...(paymentStatusWaiters ? { onOrderChanged: (orderId: string) => paymentStatusWaiters.notify(orderId) } : {}),
    });
  }
  // 발권 실행기(TicketIssueRunner, BUILD_ORDER PRF-170, docs/features/payment.md §2 '발권 호출과 재시도 큐의 첫 구현'): Saga 실행기와 같은 자리(purchase DB가 있을 때, 이 API 파드).
  // ticket-svc IssueTickets는 차단기(ticket-svc)로 감싸고, 주소(PEAKET_TICKET_GRPC_ADDR)가 없으면 local·ci만 '늘 발권' 대역과 경고 한 줄이다.
  // 그 밖의 환경은 주소가 없으면 여기서 던진다(시작 실패, 듣기 전). 큐 쓰기는 핫패스 풀이 아니라 실행기 전용 일반 풀(ticketIssueDatabaseOptions, 연결 4개 [가정])이고
  // 종료 때 닫는다(리뷰 고침 H1: ticket-svc가 멈춰 실패가 한꺼번에 몰려도 홀드·주문 요청이 풀 대기 초과를 받지 않게). 지표(ticket_issue_*)는 서비스 레지스트리에 붙인다.
  // CONFIRMED가 되면 이 파드의 결제 결과 기다림을 깨운다(onOrderChanged → notify). 듣기 시작한 뒤 1초 반복을 켜고 SIGTERM 때 끈다
  let ticketIssuer: ReturnType<typeof ticketIssuerFromEnv> | undefined;
  let ticketBreaker: CircuitBreaker | undefined;
  let ticketRunner: TicketIssueRunner | undefined;
  // 티켓 무효 실행기(입금 오류 되돌림 뒤, BUILD_ORDER HOT-152): 발권 실행기와 같은 자리·같은 풀·같은 ticket-svc 주소를 쓴다
  let ticketVoidRunner: TicketVoidRunner | undefined;
  let ticketIssueDatabase: Database | undefined;
  // 보상 세 걸음(BAT-011, PRF-173): 회차 취소 확정 뒤 발권 대기 주문의 발권을 막고 결제를 취소한다. 발권 실행기와 같은 자리·같은 풀을 쓴다
  let compensationRunner: CompensationRunner | undefined;
  let compensationQueue: EventCompensationQueue | undefined;
  let compensationFenceClient: ReturnType<typeof ticketFenceFromEnv> | undefined;
  let compensationPaymentClient: ReturnType<typeof paymentCompensatorFromEnv> | undefined;
  let compensationPaymentBreaker: CircuitBreaker | undefined;
  if (booking && database && databaseUrl) {
    ticketBreaker = new CircuitBreaker({ service: SERVICE, dependency: TICKET_DEPENDENCY, registry: service.metrics.registry, logger: service.logger });
    ticketIssuer = ticketIssuerFromEnv(env, { profile: service.config.grpcLbProfile, breaker: ticketBreaker });
    for (const w of ticketIssuer.warnings) service.logger.warn({ dep: TICKET_DEPENDENCY }, w);
    const ticketDb = createDatabase(ticketIssueDatabaseOptions(databaseUrl));
    ticketIssueDatabase = ticketDb;
    ticketRunner = new TicketIssueRunner({
      jobs: new DrizzleTicketIssue({ database: ticketDb, store: orderStore, clock: systemClock, ...(orderCodec ? { codec: orderCodec } : {}) }),
      issuer: ticketIssuer.issuer,
      log: new LoggerTicketIssueLog(service.logger),
      signals: new PromTicketIssueSignals().register(service.metrics.registry),
      clock: systemClock,
      ...(paymentStatusWaiters ? { onOrderChanged: (orderId: string) => paymentStatusWaiters.notify(orderId) } : {}),
    });
    ticketVoidRunner = new TicketVoidRunner({ jobs: new DrizzleTicketVoid({ database: ticketDb, clock: systemClock }), voider: ticketIssuer.voider, log: new LoggerTicketVoidLog(service.logger), signals: new PromTicketVoidSignals().register(service.metrics.registry), clock: systemClock });
    // 보상 세 걸음(BAT-011, PRF-173, ADR-0354): 발권 막기는 ticket-svc, 결제 취소는 payment-svc다.
    // 저장소는 발권 실행기와 같은 실행기 전용 풀을 쓰고, 지표 purchase_order_compensation_total·order_compensation_jobs를 붙인다
    const compensationSignalsOf = new PromCompensationSignals().register(service.metrics.registry);
    const compensationLog = new LoggerCompensationLog(service.logger);
    compensationFenceClient = ticketFenceFromEnv(env, {
      profile: service.config.grpcLbProfile,
      breaker: ticketBreaker,
      ...(internalGrpcToken ? { internalToken: internalGrpcToken } : {}),
    });
    for (const w of compensationFenceClient.warnings) service.logger.warn({ dep: TICKET_DEPENDENCY }, w);
    compensationPaymentBreaker = new CircuitBreaker({ service: SERVICE, dependency: 'payment-svc-compensation', registry: service.metrics.registry, logger: service.logger });
    const compensationPayment = paymentCompensatorFromEnv(env, { profile: service.config.grpcLbProfile, breaker: compensationPaymentBreaker });
    for (const w of compensationPayment.warnings) service.logger.warn({ dep: 'payment-svc' }, w);
    compensationPaymentClient = compensationPayment;
    const compensationStore = new DrizzleCompensation({ database: ticketDb, store: orderStore, clock: systemClock });
    const compensationStart = new StartCompensation({ store: compensationStore, clock: systemClock, log: compensationLog, signals: compensationSignalsOf });
    const compensationFence = new FenceCompensation({ store: compensationStore, fence: compensationFenceClient.fence, clock: systemClock, log: compensationLog, signals: compensationSignalsOf });
    const compensationCancel = new CancelCompensation({ store: compensationStore, payments: compensationPayment.compensator, clock: systemClock, log: compensationLog, signals: compensationSignalsOf });
    compensationQueue = new EventCompensationQueue({ jobs: compensationStore, start: compensationStart, log: compensationLog });
    compensationQueueLate.queue = async (eventId) => (compensationQueue ? compensationQueue.queue(eventId) : 0);
    compensationRunner = new CompensationRunner({
      jobs: compensationStore,
      fence: compensationFence,
      cancel: compensationCancel,
      log: compensationLog,
      signals: compensationSignalsOf,
      clock: systemClock,
    });
  }
  // Kafka 소비자 둘(BUILD_ORDER PRF-164, docs/features/seat-hold.md §6 '릴레이 프로세스와 조립의 첫 구현'): purchase DB(와 Saga·발권 실행기·결제 결과 기다림 표)가 있을 때만
  // 설정을 읽는다(DB 없이 뜨는 동작은 그대로다). 브로커 주소가 없으면 local·ci만 경고 한 줄로 끄고, 그 밖의 환경은 여기서 던진다(시작 실패, 듣기 전).
  // 결제 결과 반영 쓰임새는 소비자와 결제 결과 당기기(PRF-171)가 함께 쓰므로 소비자를 켜는지와 상관없이 만든다: 소비자 전용 일반 풀(consumerDatabaseOptions)을 만들어
  // 결제 결과 반영(결과·판매 저장소)에 쓰고, 소비자를 켜면 원장 적재·보류 표도 같은 풀을 쓴다. 종료 때 닫는다(리뷰 고침 M4).
  // 결제 결과 반영은 paymentResultApply로 조립한다(test-int/consumers.int.test.ts와 같은 함수. onOrderChanged = 이 파드의 기다림 표 notify, 필수.
  // onApproved = 이 파드의 발권 실행기 kick: 승인 커밋 뒤 그 주문을 곧바로 발권한다, PRF-170)
  let consumerOptions: PurchaseConsumersOptions | undefined;
  let behaviorProducer: KafkaProducer | undefined;
  let consumerDatabase: Database | undefined;
  let paymentConsumerDatabase: Database | undefined;
  let applyPaymentResult: ReturnType<typeof paymentResultApply> | undefined;
  if (databaseUrl && database && sagaRunner && ticketRunner && paymentStatusWaiters) {
    const issueRunner = ticketRunner;
    const voidRunner = ticketVoidRunner;
    const kafka = kafkaConsumersFromEnv(env, SERVICE);
    if (!kafka.enabled) service.logger.warn({ dep: 'kafka' }, kafka.warning);
    // 홀드 원장 소비자와 결제 결과 소비자의 풀을 나눈다(BAT-029): 회차 키 하나에 결제 사건이 몰려도 서로의 연결을 기다리지 않는다
    const consumerDb = createDatabase(consumerDatabaseOptions(databaseUrl));
    consumerDatabase = consumerDb;
    const paymentConsumerDb = createDatabase(paymentConsumerDatabaseOptions(databaseUrl));
    paymentConsumerDatabase = paymentConsumerDb;
    applyPaymentResult = paymentResultApply({
      database: paymentConsumerDb,
      store: orderStore,
      sessions: {
        // 결제 확정(COMPLETED)도 모듈의 끝내기와 같은 고리를 지난다(그 세션의 다른 열린 주문을 다시 본다, PRF-172)
        end: new EndPurchaseSession({ store: sessionStore, ended: new RedisSessionEndedLog(redis), clock: systemClock, signals, logger: service.logger, onEnded: onSessionEnded, releaseHolds: manageHolds }),
        store: sessionStore,
      },
      saga: sagaRunner,
      logger: service.logger,
      clock: systemClock,
      onOrderChanged: (orderId) => paymentStatusWaiters.notify(orderId),
      onApproved: (orderId) => issueRunner.kick(orderId),
      ...(voidRunner ? { onDepositReversed: (orderId: string) => voidRunner.kick(orderId) } : {}),
      hotPath,
    });
    if (kafka.enabled) {
      // 행동 신호 생산자(telemetry.behavior, PRF-191). 메시지 값은 공용 Avro 인코더로 만들고, 연결 실패는 시작을 막지 않는다(보내기가 실패하면 telemetry_dropped_total만 오른다)
      const producer = createKafkaProducer({ kind: 'default', brokers: kafka.brokers, clientId: `${SERVICE}-telemetry-${kafka.env}-${podId}`, auth: kafka.auth });
      behaviorProducer = producer;
      producer.connect().catch((err: unknown) => service.logger.warn({ dep: 'kafka', err: errorSummary(err) }, '행동 신호 생산자를 잇지 못했다(요약은 버려진다)'));
      if (avroEncoder) startLate.behavior = new KafkaBehaviorSignals(producer, avroEncoder, service.logger);
      consumerOptions = {
        env: kafka.env,
        brokers: kafka.brokers,
        // client.id는 <작업자>-<환경>-<파드>(docs/streaming.md §2.6). 파드는 만료 임대 값(HOSTNAME 앞 57자 + 무작위)이다
        clientId: `${SERVICE}-${kafka.env}-${podId}`,
        auth: kafka.auth,
        database: consumerDb,
        paymentDatabase: paymentConsumerDb,
        ledger: new DrizzleSeatHoldLedger(consumerDb),
        applyPaymentResult,
        registry: service.metrics.registry,
        logger: service.logger,
      };
    }
  }
  // 결제 결과 당기기(PaymentResultPuller, BUILD_ORDER PRF-171, ADR-0140, docs/features/payment.md §2 '결제 결과 당기기의 첫 구현'): purchase DB가 있을 때 이 API 파드에서 켠다.
  // 소비자를 켜지 않은 local·ci에서도 켠다(사건 길과 같은 반영 쓰임새 applyPaymentResult를 쓴다. 이미 반영한 순번은 건너뛰므로 두 길이 겹쳐도 한 번만 반영된다).
  // BatchGetPayments는 승인 명령과 따로인 차단기(payment-svc-batch)로 감싸고, 주소(PEAKET_PAYMENT_GRPC_ADDR)가 없으면 local·ci만 '기록 없음' 대역과 경고 한 줄이다.
  // 그 밖의 환경은 주소가 없으면 여기서 던진다(시작 실패, 듣기 전). 잡기·미루기는 당기기 전용 일반 풀(paymentPullDatabaseOptions, 연결 2개 [가정])이고 종료 때 닫는다.
  // 지표(payment_result_pull*)는 서비스 레지스트리에 붙인다. 듣기 시작한 뒤 1초 반복을 켜고 SIGTERM 때 소비자와 함께 가장 먼저 끈다(Saga·발권 실행기·기다림 표보다 먼저)
  let paymentPull: ReturnType<typeof paymentResultReaderFromEnv> | undefined;
  let paymentPullBreaker: CircuitBreaker | undefined;
  let paymentPuller: PaymentResultPuller | undefined;
  let paymentPullDatabase: Database | undefined;
  if (databaseUrl && applyPaymentResult) {
    paymentPullBreaker = new CircuitBreaker({ service: SERVICE, dependency: PAYMENT_PULL_BREAKER, registry: service.metrics.registry, logger: service.logger });
    paymentPull = paymentResultReaderFromEnv(env, { profile: service.config.grpcLbProfile, breaker: paymentPullBreaker });
    for (const w of paymentPull.warnings) service.logger.warn({ dep: PAYMENT_PULL_BREAKER }, w);
    const pullDb = createDatabase(paymentPullDatabaseOptions(databaseUrl));
    paymentPullDatabase = pullDb;
    paymentPuller = new PaymentResultPuller({
      targets: new DrizzlePaymentPull({ database: pullDb, clock: systemClock }),
      reader: paymentPull.reader,
      apply: applyPaymentResult,
      log: new LoggerPaymentPullLog(service.logger),
      signals: new PromPaymentPullSignals().register(service.metrics.registry),
      clock: systemClock,
    });
  }
  // 회차 판매 상태 판정(SaleStateJudge, BUILD_ORDER PRF-144, ADR-0122, docs/features/seat-hold.md §4 '판정의 첫 구현'): purchase DB가 있을 때 이 API 파드에서 켠다.
  // event_sale·seat_sale 읽기와 쓰기는 핫패스 풀이 아니라 판정 전용 일반 풀(saleStateDatabaseOptions, 연결 2개 [가정])이고 종료 때 닫는다. 결제 중 셈은 booking의 DrizzleSalePaying을 잇는다.
  // 듣기 시작한 뒤 1초 반복을 켜고 SIGTERM 때 만료 반복과 함께 끈다
  let saleStateDatabase: Database | undefined;
  let saleStateJudge: SaleStateJudge | undefined;
  if (database && databaseUrl) {
    const saleDb = createDatabase(saleStateDatabaseOptions(databaseUrl));
    saleStateDatabase = saleDb;
    saleStateJudge = new SaleStateJudge({
      events: new RedisSeatStore(redis, service.logger),
      counts: new RedisSaleCounts(redis),
      paying: new DrizzleSalePaying({ database: saleDb }),
      store: new DrizzleEventSale({ database: saleDb, clock: systemClock }),
      seatMap,
      leases: new RedisSweepLeases(redis),
      signals: new PromSaleStateSignals().register(service.metrics.registry),
      clock: systemClock,
      podId,
      logger: service.logger,
    });
  }
  // 꺼져 있어도 낼 기록은 버린 수로 센다(지표로 드러난다)
  const telemetryDropped = telemetryDroppedCounter(service.metrics.registry);
  let telemetrySink: TelemetrySink | undefined;
  let telemetrySender: KafkaTelemetrySender | undefined;
  const telemetryOff = (warning: string): void => {
    // 꺼져 있으면 내지 않고 버린 수만 센다(지금까지와 같다)
    behaviorSignals = { record: () => telemetryDropped('BehaviorSignal', 1) };
    holdAttempts = { record: () => telemetryDropped('HoldAttempt', 1) };
    service.logger.warn({ dep: 'telemetry-kafka' }, warning);
  };
  if (telemetryKafka.enabled) {
    try {
      // 네이티브 모듈은 켤 때만 싣는다. 싣지 못해도 시작은 막지 않는다
      const { createKafkaProducer } = await import('@peaket/platform/stream-worker');
      // 연결은 보낼 때 맺고, 실패하면 새 생산자로 다시 잇는다: 브로커가 멈춰도 파드는 뜨고 홀드는 이어진다
      const { brokers, auth, env: kafkaEnv } = telemetryKafka;
      const pod = (env.PEAKET_POD ?? env.HOSTNAME ?? 'local').slice(0, 64);
      const sender = kafkaTelemetrySend(() => createKafkaProducer({ kind: 'default', brokers, clientId: `${SERVICE}-${kafkaEnv}-${pod}`, auth }));
      telemetrySender = sender;
      const sink = new TelemetrySink({ send: sender, onDropped: telemetryDropped });
      telemetrySink = sink;
      const encoder = avroEncoder!;
      const offer = (record: string, topic: string, m: { key: string | null; value: Buffer }) => sink.offer(record, topic, m);
      behaviorSignals = new AvroBehaviorSignals({ offer, encoder, dropped: telemetryDropped, logger: service.logger });
      // 홀드 시도(ADR-0357 결정 7): 응답 뒤 시도 세기(hn)·인코딩·버퍼 넣기. 종료 때 남은 일을 기다린다
      holdAttempts = new KafkaHoldAttempts({
        encoder,
        offer,
        dropped: telemetryDropped,
        logger: service.logger,
        sessions: sessionStore,
        clock: systemClock,
        after: (work) => {
          const p = work().finally(() => behaviorPending.delete(p));
          behaviorPending.add(p);
        },
      });
    } catch {
      telemetryOff('Kafka 클라이언트를 싣지 못해 좌석 행동 요약을 Kafka로 보내지 않는다');
    }
  } else {
    telemetryOff(telemetryKafka.warning);
  }
  // 서비스 닫기가 실패해도 남은 기록은 닫는다(시간 안에서만)
  const closeTelemetry = async (): Promise<void> => {
    await Promise.all(behaviorPending);
    await telemetrySink?.close(TELEMETRY_CLOSE_MS);
    await telemetrySender?.disconnect(TELEMETRY_CLOSE_MS);
  };
  // 종료 세션 목록(ADR-0333 결정 2): 듣기 전에 두 제어 토픽을 읽기 시작한다(다 읽어야 /ready 200). 브로커가 없으면 local·ci만 경고로 끄고 그 밖은 여기서 시작에 실패한다
  const controlSync = startServiceControlSync(service, env);
  // purchase-svc 제어 상태 시작 작업(ADR-0365 결정 7, C-T50): sale_control을 읽어야 /ready가 200이고, 그 뒤 2초 [가정]마다 메모리와 좌석 Redis 사본을 원본대로 맞춘다
  const saleReconciler = saleControl && saleMemory ? new SaleControlReconciler({ store: saleControl.store, memory: saleMemory, ...(saleControl.copies ? { copies: saleControl.copies } : {}), logger: service.logger }) : undefined;
  saleReconciler?.start(service.readiness);
  // 생산자 시작 확인(ADR-0357 결정 5, ST-T16 ②): 듣기 전에 한 번. 다름·404·주소 없음(local·ci 밖)은 던진다(시작 실패). 준비 상태에는 넣지 않는다
  if (avroEncoder) {
    await checkProducerSchemas({
      env,
      encoder: avroEncoder,
      schemas: avroSchemas,
      metrics: service.metrics.registry,
      logger: { info: (x) => service.logger.info(x, '레지스트리 시작 확인을 건너뛴다(주소 없음, local·ci)'), warn: (x) => service.logger.warn(x, '레지스트리에 닿지 못해 설정의 스키마 ID로 계속한다') },
    });
  }
  await service.listen();
  // 회차 취소 일괄 환불 gRPC(refund.proto, BAT-425 GAT-130). PEAKET_GRPC_PORT가 있을 때만 연다.
  // 없으면 ops-svc는 내부 HTTP 호환 경로를 쓴다(같은 쓰임새·같은 멱등 키).
  let refundGrpc: Awaited<ReturnType<typeof startPurchaseGrpcServer>> | undefined;
  const grpcServices: Parameters<typeof startPurchaseGrpcServer>[0]['services'] = [];
  if (eventRefundService) {
    // SetEventRefundHold는 내부 토큰이 있으면 호출자 ops-svc만 받는다(BAT-420 몫 D). 기한 검사의 지금은 서버 시계다
    grpcServices.push({
      definition: eventRefundPackage().EventRefundService.service,
      handlers: new EventRefundGrpcController(eventRefundService, { ...(internalGrpcToken ? { internalToken: internalGrpcToken } : {}), nowMs: () => systemClock.now() }).handlers(),
    });
  }
  if (fraudCancellation) {
    grpcServices.push({
      definition: fraudCancellationPackage().FraudCancellationService.service,
      handlers: fraudCancellationHandlers(fraudCancellation, {
        ...(internalGrpcToken ? { internalToken: internalGrpcToken } : {}),
        onError: (method, err) => service.logger.error({ err: errorSummary(err), method }, 'FraudCancellationService 처리 실패'),
      }),
    });
  }
  if (priority) {
    grpcServices.push({
      definition: priorityPurchasePackage().PriorityPurchaseService.service,
      handlers: priorityPurchaseHandlers({ grant: service.app.get(GrantPriorityPurchase), withdraw: service.app.get(WithdrawPriorityGrant) }),
    });
  }
  // 탈퇴 참여자(identity-svc만 부른다, payment §4.1 '탈퇴 참여자의 첫 구현', ADR-0284, PRF-169). purchase DB가 있을 때만 연다.
  // 입금 전 취소는 예매 취소와 같은 payment-svc 일반 취소 어댑터를 쓴다(주소 PEAKET_PAYMENT_GRPC_ADDR). 주소가 없으면(local·ci·demo만, 운영은 위에서 시작하지 않는다)
  // 취소를 부르지 못해 늘 UNKNOWN이라 입금 대기 주문이 있는 탈퇴는 미뤄진다(DONE으로 접지 않는다)
  let withdrawalPayments: GrpcPaymentCancellations | undefined;
  if (database) {
    withdrawalPayments = refundPayments ? undefined : paymentGrpcAddr ? new GrpcPaymentCancellations({ address: paymentGrpcAddr }) : undefined;
    const deposits: WithdrawalDepositCancellations = refundPayments ?? withdrawalPayments ?? { cancel: async () => 'UNKNOWN' };
    if (!paymentGrpcAddr) service.logger.warn({ dep: 'payment-svc' }, 'PEAKET_PAYMENT_GRPC_ADDR가 없어 탈퇴 참여자가 입금 대기 주문을 취소하지 못한다(그런 탈퇴는 늘 미뤄진다)');
    const withdrawalSignals = new PromWithdrawalParticipantSignals().register(service.metrics.registry);
    // 결제한 미사용 티켓(payment §4.1 '미사용 티켓 견적'·'미사용 티켓 취소', I-T26). 견적은 DB와 판매 설정만 읽고,
    // 취소는 예매 취소 Saga(CancelTicket)를 그대로 쓴다. ticket-svc 주소가 없으면 취소할 표가 있는 탈퇴만 UNAVAILABLE이다
    const withdrawalTickets: WithdrawalTickets = new AccountWithdrawalTickets({
      store: new DrizzleWithdrawalTickets(database),
      configs: new SeatMapSaleConfigs(seatMap),
      calendar: refund?.calendar ?? withdrawalCalendar,
      ...(refund && refundTickets && refundPayments ? { cancelTicket: new CancelTicket(refund) } : {}),
      signals: withdrawalSignals,
      log: { warn: (obj, msg) => service.logger.warn(obj, msg) },
    });
    if (!ticketGrpcAddr) {
      service.logger.warn({ dep: 'ticket-svc' }, 'PEAKET_TICKET_GRPC_ADDR가 없어 탈퇴 참여자가 미사용 티켓을 취소하지 못한다(미사용 티켓이 있는 탈퇴는 미뤄진다)');
    }
    const withdrawalParticipant = new ProcessAccountWithdrawal({
      orders: new DrizzleWithdrawalOrders(database),
      deposits,
      tickets: withdrawalTickets,
      clock: systemClock,
      signals: withdrawalSignals,
      log: { warn: (obj, msg) => service.logger.warn(obj, msg) },
    });
    const quote = new QuoteAccountWithdrawal({ tickets: withdrawalTickets, clock: systemClock });
    grpcServices.push({
      definition: withdrawalParticipantPackage().WithdrawalParticipantService.service,
      handlers: withdrawalParticipantHandlers({ run: (i) => withdrawalParticipant.run(i), quote }, {
        ...(internalGrpcToken ? { internalToken: internalGrpcToken } : {}),
        onError: (method, err) => service.logger.error({ err: errorSummary(err), method }, 'WithdrawalParticipantService 처리 실패'),
      }),
    });
  }
  grpcServices.push({
    definition: bookingRestrictionPackage().BookingRestrictionService.service,
    handlers: bookingRestrictionHandlers({ apply: (i) => bookingRestrictions.apply(i) }, (method, err) => service.logger.error({ err: errorSummary(err), method }, 'BookingRestrictionService 처리 실패')),
  });
  if (grpcServices.length > 0 && env.PEAKET_GRPC_PORT) {
    // 포트 값은 공용 설정이 읽고 검사한다(틀리면 createService가 시작하지 않는다, BUILD_ORDER BAS-080)
    refundGrpc = await startPurchaseGrpcServer({
      host: env.PEAKET_GRPC_HOST ?? '0.0.0.0',
      port: service.config.grpcPort,
      profile: service.config.grpcLbProfile,
      metrics: service.metrics,
      services: grpcServices,
      internal: { ...(internalGrpcToken ? { token: internalGrpcToken } : {}), services: ['peaket.purchase.v1.EventRefundService', 'peaket.purchase.v1.FraudCancellationService', 'peaket.purchase.v1.WithdrawalParticipantService'] },
    });
    service.logger.info({ port: refundGrpc.port }, 'purchase-svc gRPC 포트를 열었다');
  } else if (grpcServices.length > 0) {
    service.logger.warn({ dep: 'grpc' }, 'PEAKET_GRPC_PORT가 없어 purchase-svc gRPC를 열지 않는다(내부 HTTP 호환 경로만)');
  }
  const sweeper = service.app.get(ExpirySweeper);
  sweeper.start();
  // 우선 구매 권리 상태 대조(ADR-0385). 만료 반복과 따로 도는 30초 반복이다
  prioritySync?.start();
  saleStateJudge?.start();
  sagaRunner?.start();
  ticketRunner?.start();
  ticketVoidRunner?.start();
  compensationRunner?.start();
  paymentPuller?.start();
  paymentStatusWaiters?.start();
  // 구매 세션 정리 반복(유휴·최대 체류, BUILD_ORDER PRF-138). 만료 반복과 같이 켜고 끈다
  const sessionSweeper = service.app.get(SessionSweeper);
  sessionSweeper.start();
  const seatMapRefresh = setInterval(() => void seatMap.refresh(), SEATMAP_REFRESH_MS);
  seatMapRefresh.unref();
  // Kafka 소비자 둘(PRF-164)을 듣기 시작한 뒤 켠다. 연결·구독이 실패하면 오류 한 줄 뒤 SIGTERM과 같은 차례로 끝내고 종료 코드 1로 나간다
  // (구현에서 정한 것: 소비자 없이 준비 상태로 남지 않게. 쿠버네티스가 다시 띄운다)
  const consumers = consumerOptions ? startPurchaseConsumers(consumerOptions) : undefined;
  consumers?.started.catch((err: unknown) => {
    service.logger.error({ dep: 'kafka', err: errorSummary(err) }, 'Kafka 소비자를 켜지 못해 purchase-svc를 끝낸다');
    void shutdown();
    o.onFatal?.(err);
  });

  let closing: Promise<void> | undefined;
  function shutdown(): Promise<void> {
    if (closing) return closing;
    // 좌석맵 판 다시 읽기를 멈추고, 만료 반복을 멈추고(돌던 틱을 기다린다) 서비스를 닫은 뒤 연결을 닫는다. 어느 단계가 실패해도 연결은 닫는다
    clearInterval(seatMapRefresh);
    // Kafka 소비자와 결제 결과 당기기 실행기를 가장 먼저 함께 멈춘다(소비자는 받기를 멈추고 처리 중인 키를 마친 뒤 커밋하고 나간다. 당기기는 부르던
    // BatchGetPayments와 그 뒤 반영·미루기를 기다린다. 남은 대상은 다음 점검 시각이 지나면 다른 파드가 잡는다). 둘 다 결제 결과를 반영해 Saga·발권 실행기·
    // 기다림 표를 깨우므로 그 셋보다 먼저 멈춘다(2026-11-06 코드 리뷰 L1). 그 뒤에 나머지를 멈춘다:
    // Saga 실행기(돌던 틱·kick을 기다린다. 멈춘 뒤의 접수 깨우기는 부르지 않고, 남은 작업은 다른 파드의 폴링이 줍는다),
    // 발권 실행기(부르던 발권 호출과 그 뒤 쓰기를 기다리고, 잡았지만 부르지 않은 큐 행은 임대를 놓는다. 남은 행은 다른 파드의 틱이 줍는다),
    // 결제 결과 기다림 표(돌던 묶음 조회를 기다리고 남은 기다림을 STOPPED로 깨운다. 그 요청들은 다시 읽지 않고 마지막 본문으로 곧바로 답한다).
    // 실행기 전용 풀은 실행기를 멈춘 뒤 아래에서 닫는다
    closing = Promise.all([
      (consumers?.stop() ?? Promise.resolve()).catch((err: unknown) => service.logger.error({ err: errorSummary(err) }, 'Kafka 소비자 멈추기 실패(나머지는 그대로 끝낸다)')),
      paymentPuller?.stop(),
      // 제어 gRPC 서버는 새 제어를 받지 않고 돌던 호출을 기다린다(ADR-0102의 우아한 종료)
      (controlServer?.close() ?? Promise.resolve()).catch((err: unknown) => service.logger.error({ err: errorSummary(err) }, '제어 gRPC 서버 닫기 실패')),
    ])
      .then(() => Promise.all([admissionLoader?.stop(), saleReconciler?.stop(), sweeper.stop(), sessionSweeper.stop(), prioritySync?.stop(), saleStateJudge?.stop(), sagaRunner?.stop(), ticketRunner?.stop(), ticketVoidRunner?.stop(), compensationRunner?.stop(), paymentStatusWaiters?.stop(), refundGrpc?.close()]))
      .then(() => {
        priorityCopies?.close();
      })
      .then(() => service.close())
      .finally(closeTelemetry)
      .catch((err: unknown) => service.logger.error({ err: errorSummary(err) }, 'purchase-svc 종료 실패'))
      // 주문 만료 판정기는 고리를 부르는 것들(만료·정리 반복, 소비자, 나가기 경로)이 멈춘 뒤에 멈춘다. 돌던 판정만 기다리고 줄에 남은 일은 버린다(안전망이 받친다). 전용 풀은 그 뒤에 닫는다
      .then(() => orderExpiry?.stop())
      .catch((err: unknown) => service.logger.error({ err: errorSummary(err) }, '주문 만료 판정기 멈추기 실패'))
      .finally(() => {
        // 서비스를 닫은 뒤(새 요청이 없다) identity-svc·payment-svc·ticket-svc 클라이언트와 차단기를 닫는다
        try {
          identity?.close();
          for (const b of identityBreakers) b.shutdown();
        } catch (err) {
          service.logger.error({ err: errorSummary(err) }, 'identity-svc 클라이언트 닫기 실패');
        }
        try {
          pauseClient.close();
          pauseBreaker.shutdown();
          payment?.close();
          paymentBreaker?.shutdown();
          depositReader?.close();
          depositBreaker?.shutdown();
          paymentCheckouts?.close();
          checkoutBreaker?.shutdown();
          void behaviorProducer?.disconnect().catch(() => {});
        } catch (err) {
          service.logger.error({ err: errorSummary(err) }, 'payment-svc 클라이언트 닫기 실패');
        }
        try {
          ticketIssuer?.close();
          ticketBreaker?.shutdown();
          compensationFenceClient?.close();
        } catch (err) {
          service.logger.error({ err: errorSummary(err) }, 'ticket-svc 클라이언트 닫기 실패');
        }
        try {
          compensationPaymentClient?.close();
          compensationPaymentBreaker?.shutdown();
        } catch (err) {
          service.logger.error({ err: errorSummary(err) }, 'payment-svc 보상 취소 클라이언트 닫기 실패');
        }
        try {
          paymentPull?.close();
          paymentPullBreaker?.shutdown();
        } catch (err) {
          service.logger.error({ err: errorSummary(err) }, 'payment-svc 결과 당기기 클라이언트 닫기 실패');
        }
        try {
          refundTickets?.close();
          refundPayments?.close();
          compensationTransfers?.close();
          withdrawalPayments?.close();
        } catch (err) {
          service.logger.error({ err: errorSummary(err) }, '취소 gRPC 클라이언트 닫기 실패');
        }
        // 소비자 전용 풀(결제 결과 반영도 쓴다)은 소비자와 당기기를 멈춘 뒤라, 발권·당기기 실행기 전용 풀은 실행기를 멈춘 뒤라 쓰는 연결이 없다.
        // 종료 세션 목록 소비는 서비스를 닫은 뒤(처리 중인 요청이 끝난 뒤) 끈다(ADR-0333 결정 2)
        return Promise.all([controlSync?.close(), redis.close(), database?.close(), consumerDatabase?.close(), paymentConsumerDatabase?.close(), paymentStatusWaitDatabase?.close(), sagaDatabase?.close(), ticketIssueDatabase?.close(), paymentPullDatabase?.close(), orderExpiryDatabase?.close(), saleStateDatabase?.close()]);
      })
      .then(() => undefined);
    return closing;
  }
  return { close: shutdown };
}

/** 회차 슬롯 읽기 앞에 파드 메모리의 정지 확인을 둔다(결제 시도·결제 접수, ADR-0365 결정 7). 메모리가 없으면 그대로다 */
function pauseAwareSlots(inner: SeatSlotReads, memory: { stopped(eventId: string): boolean } | undefined): SeatSlotReads {
  if (!memory) return inner;
  return { read: (eventId, o) => (memory.stopped(eventId) ? Promise.resolve({ status: 'PAUSED' as const }) : inner.read(eventId, o)) };
}
