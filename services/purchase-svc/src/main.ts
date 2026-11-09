// purchase-svc 시작. 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK가 node:http보다 먼저 서야 한다, docs/devops.md §4.4)
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
// (PEAKET_ADMISSION_JWKS)과 발급자(PEAKET_ADMISSION_ISSUER)로 확인하고, 스냅샷 API가 입장 토큰의 첫 사용에 구매 세션을 연다(PRF-137).
// 좌석맵 판은 환경 값 PEAKET_SEATMAP_DIR 폴더의 {eventId}.json이다(docs/features/seat-hold.md §2 '운영 좌석맵 판'). 30초 [가정]마다 읽은 회차를 다시 읽는다.
// purchase DB가 있으면 Kafka 소비자 둘(결제 결과 반영 trade.payments·홀드 원장 적재 trade.seats, BUILD_ORDER PRF-164, src/consumers.ts)을 듣기 시작한 뒤 켠다.
// 두 소비자는 핫패스 풀과 따로 소비자 전용 일반 풀(연결 4개 [가정], purchase-svc-consumers)을 쓴다(밀린 사건을 한꺼번에 처리해도 홀드·주문 요청이 풀 대기 초과를 받지 않게).
// 브로커 주소(PEAKET_KAFKA_BROKERS)가 없으면 local·ci만 소비자 없이 뜨고(시작 로그 경고), 그 밖의 환경은 시작하지 않는다. SIGTERM에서는 소비자와 결과 당기기 실행기를
// 가장 먼저 멈추고(둘 다 결제 결과를 반영해 뒤의 셋을 깨운다), 그다음 Saga·발권 실행기·기다림 표(돌던 호출과 그 뒤 쓰기를 기다린다)를, 서비스를 닫은 뒤
// gRPC 클라이언트·차단기와 연결을 닫는다.
// 오류 로그에는 플랫폼 errorSummary(이름·글, 쿼리 매개변수 값은 뺀다)만 싣는다.
// purchase DB가 있으면 회차 판매 상태 판정(SaleStateJudge, PRF-144, ADR-0122)도 듣기 시작한 뒤 켜고 SIGTERM 때 끈다. 판정 전용 일반 풀(연결 2개 [가정], purchase-svc-sale-state)을 쓰고 지표 purchase_event_sale_*를 /metrics에 붙인다.
// 좌석 Stream 릴레이·다시 만들기 반복·정비 일은 이 파일이 아니라 릴레이 프로세스(src/relay.ts, purchase-svc-outbox-relay 배포)가 돈다.
// HoldAttempt 보내기(BAS-030)는 아직 없어 시도 기록은 버린다.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { CircuitBreaker, createDatabase, createHotRedis, createService, type Database, errorSummary, systemClock } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { consumerDatabaseOptions, kafkaConsumersFromEnv, paymentResultApply, type PurchaseConsumersOptions, startPurchaseConsumers } from './consumers.js';
import {
  type BookingModuleDeps,
  CONSENT_VERSION_ENV,
  type ContactRefs,
  DrizzleOrderAccepts,
  DrizzleOrderExpiry,
  DrizzleOrderStore,
  DrizzleOrderWrites,
  DrizzlePaymentPull,
  DrizzlePaymentStatus,
  DrizzleSaga,
  DrizzleSalePaying,
  DrizzleTicketIssue,
  type IdentityRecheck,
  identityClientsFromEnv,
  InventoryOrderSeatPins,
  InventoryOrderSessions,
  InventoryOrderExpiry,
  InventorySeatSlots,
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
  paymentConfirmsFromEnv,
  paymentDepositReaderFromEnv,
  paymentPullDatabaseOptions,
  paymentResultReaderFromEnv,
  PaymentResultPuller,
  PaymentStatusWaitTable,
  PromOrderExpirySignals,
  PromOrderSignals,
  PromPaymentPullSignals,
  PromTicketIssueSignals,
  RedisBookingRestrictions,
  SeatMapSagaConfigs,
  SeatMapSaleConfigs,
  TICKET_DEPENDENCY,
  ticketIssueDatabaseOptions,
  ticketIssuerFromEnv,
  TicketIssueRunner,
  TicketVoidRunner,
  DrizzleTicketVoid,
  LoggerTicketVoidLog,
  PromTicketVoidSignals,
  unavailableIdentityRecheck,
} from './modules/booking/index.js';
import {
  DrizzleEventSale,
  DrizzleSeatHoldLedger,
  DrizzleSeatSales,
  EndPurchaseSession,
  ExpirySweeper,
  FileSeatMapSource,
  LayoutSeatMap,
  PromSaleStateSignals,
  PromSeatSignals,
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
  StoredPurchaseSessions,
  discardHoldAttempts,
  parseAdmissionJwks,
  podIdFrom,
} from './modules/inventory/index.js';

const SERVICE = 'purchase-svc';
/** 좌석맵 판 파일을 다시 읽는 주기 30초 [가정](docs/features/seat-hold.md §2 '운영 좌석맵 판') */
const SEATMAP_REFRESH_MS = 30_000;

// 좌석 Redis: 로컬·CI는 단일 노드 주소, 운영은 클러스터 시작 노드 주소들(쉼표)
const clusterUrls = (process.env.PEAKET_SEAT_REDIS_CLUSTER_URLS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const url = process.env.PEAKET_SEAT_REDIS_URL;
if (!url && clusterUrls.length === 0) throw new Error('PEAKET_SEAT_REDIS_URL이나 PEAKET_SEAT_REDIS_CLUSTER_URLS가 없다(비밀 관리에서 넣는다)');

const need = (name: string, what: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name}가 없다(${what})`);
  return v;
};
// 입장 토큰 공개키 묶음과 발급자(공개 값이라 설정에서 넣는다. 바꾸면 다시 시작한다, docs/features/seat-hold.md §2), 좌석맵 판 폴더
const admissionKeys = parseAdmissionJwks(need('PEAKET_ADMISSION_JWKS', '입장 토큰 공개키 묶음 JWKS JSON'));
const admissionIssuer = need('PEAKET_ADMISSION_ISSUER', '입장 토큰 발급자 iss');
const seatMapDir = need('PEAKET_SEATMAP_DIR', '회차별 좌석맵 판 파일 {eventId}.json이 있는 폴더');

// 만료 임대 값: {HOSTNAME 앞 57자}-{무작위 16진 6자리}. HOSTNAME이 없거나 키 조각 모양이 아니면 무작위 UUID(이 프로세스 안에서만 같다, L5)
const podId = podIdFrom(process.env, (n) => randomBytes(n));

// 서버 고정 ECDH 개인키: Secrets Manager에서 시작 때 메모리로만 읽는다(없거나 틀리면 시작하지 않는다, docs/security/secrets-and-keys.md)
const ecdh = ServerEcdhKey.fromEnv(process.env);

// purchase DB(PostgreSQL): 판매 확정 저장소 SeatSales의 연결(BUILD_ORDER PRF-140 ①). 핫패스 풀(대기 100ms)이다. 홀드 원장 적재(PRF-141)와 결제 접수 Saga(PRF-160)가 필수로 만들 때까지
// PEAKET_DATABASE_URL이 없으면 DB 없이 뜬다(좌석 홀드·구매 세션은 좌석 Redis만 쓴다). 풀 크기는 PgBouncer 배치와 함께 정한다(wbs 2.11.2)
const databaseUrl = process.env.PEAKET_DATABASE_URL;
const database = databaseUrl ? createDatabase({ url: databaseUrl, profile: 'hot', applicationName: SERVICE }) : undefined;
const redis = await createHotRedis(clusterUrls.length > 0 ? { clusterUrls } : { url });
const sessionStore = new RedisPurchaseSessionStore(redis);
const sessions = new StoredPurchaseSessions({ store: sessionStore, ecdh, clock: systemClock });
const signals = new PromSeatSignals();
// 서비스 로거는 서비스를 만든 뒤에야 생기므로, 좌석맵 판은 늦게 묶는 로거로 경고를 남긴다(판 파일은 처음 요청 때 읽는다)
let log: { warn(obj: object, msg: string): void } | undefined;
const seatMap = new LayoutSeatMap({ source: new FileSeatMapSource(seatMapDir), clock: systemClock, logger: { warn: (o, m) => log?.warn(o, m) } });

// 주문 생성(booking, POST /v1/orders, BUILD_ORDER PRF-161). purchase DB가 있을 때만 연다(DB 없이 뜬 파드는 주문 경로를 열지 않는다, 뜨는 동작은 그대로다).
// - 동의 문안 판: PEAKET_ORDER_CONSENT_VERSION(없거나 ^[0-9A-Za-z._-]{1,32}$가 아니면 시작하지 않는다. 모양은 BookingModule.register가 본다)
// - identity-svc 클라이언트(재확인·가명)는 차단기가 서비스 지표·로거를 쓰므로 서비스를 만든 뒤 만든다. 그때까지(듣기 전) 부르면 '답 없음'과 같다
// - 로그는 넘기지 않는다(모듈이 서비스 로거로 LoggerOrderLog를 만든다). 지표 PromOrderSignals는 서비스 레지스트리에 붙인다
const orderSignals = new PromOrderSignals();
const identityLate: { recheck?: IdentityRecheck; contactRefs?: ContactRefs } = {};
// - 결제 접수(POST /v1/orders/{orderId}/payment-acceptance, PRF-162)는 주문 생성과 같은 주문 전이 함수(DrizzleOrderStore)를 쓰고, 회차 슬롯 읽기는 좌석 Redis(RedisSeatSlots)다
// - 접수를 커밋한 직후 Saga 실행기를 한 번 깨운다(onAccepted → OrderSagaRunner.kick, PRF-165). 실행기는 서비스 로거로 만들므로 늦게 묶는다(그 전이면 부르지 않는다)
const orderStore = new DrizzleOrderStore({ clock: systemClock });
let sagaRunner: OrderSagaRunner | undefined;
// - 결제 결과 long polling(GET /v1/orders/{orderId}/payment-status, PRF-166): 읽기는 같은 핫패스 풀(쓰기 인스턴스), 기다림 표는 이 파드 하나다.
//   Saga 실행기와 결제 결과 처리기(ApplyPaymentResult, trade.payments 소비자, PRF-164)의 onOrderChanged에 그 notify를 넘긴다(같은 파드가 주문을 바로 답할 상태로
//   바꾸면 곧바로 깨운다). 다른 파드가 반영한 주문은 묶음 조회가 깨운다.
//   기다림 표는 듣기 시작한 뒤 200ms 반복을 켜고, SIGTERM에서 Saga 실행기와 함께 끈다(남은 기다림은 STOPPED로 깨어 다시 읽지 않고 마지막 본문으로 답한다)
// 입금 대기의 은행·계좌번호·입금 기한은 payment-svc GetPayment에서 읽어 응답에만 싣는다(차단기 payment-svc-get, 서비스를 만든 뒤 잇는다. 그때까지는 칸 없이 답한다, BUILD_ORDER HOT-151)
let depositReader: ReturnType<typeof paymentDepositReaderFromEnv> | undefined;
let depositBreaker: CircuitBreaker | undefined;
const paymentStatusReads = database ? new DrizzlePaymentStatus({ database }) : undefined;
const paymentStatusWaiters = paymentStatusReads ? new PaymentStatusWaitTable({ reads: paymentStatusReads, clock: systemClock, signals: orderSignals }) : undefined;
const booking: BookingModuleDeps | undefined = database
  ? {
      writes: new DrizzleOrderWrites({ database, store: orderStore, clock: systemClock }),
      accepts: new DrizzleOrderAccepts({ database, store: orderStore, clock: systemClock }),
      slots: new InventorySeatSlots(new RedisSeatSlots(redis)),
      holds: new RedisOrderHolds(redis, seatMap),
      saleConfigs: new SeatMapSaleConfigs(seatMap),
      sessions: new InventoryOrderSessions({ sessions, store: sessionStore }),
      identity: { check: (q) => (identityLate.recheck ?? unavailableIdentityRecheck).check(q) },
      contactRefs: { compute: (phone, ms) => (identityLate.contactRefs ?? missingContactRefs).compute(phone, ms) },
      restrictions: new RedisBookingRestrictions(redis),
      signals: orderSignals,
      consentVersion: need(CONSENT_VERSION_ENV, '주문 동의 두 개에 보인 고지 문안의 판, 1~32자의 영문·숫자·._-'),
      onAccepted: (orderId) => sagaRunner?.kick(orderId),
      ...(paymentStatusReads && paymentStatusWaiters ? { paymentStatus: { reads: paymentStatusReads, waiters: paymentStatusWaiters, deposits: { read: (id, o) => (depositReader?.reader ?? noPaymentDepositReader).read(id, o) } } } : {}),
    }
  : undefined;
// 주문 만료 고리(PRF-172): 판정기는 서비스 로거·지표로 만들므로 늦게 묶는다(그 전이면 부르지 않는다. 고리를 부르는 반복·요청은 듣기 시작한 뒤에만 돈다).
// purchase DB 없이 뜬 파드는 판정기가 없어 고리가 아무것도 하지 않는다
let orderExpiry: OrderExpiry | undefined;
const onSessionEnded = (e: { readonly purchaseSessionId: string }): void => orderExpiry?.onSessionEnded(e);
const service = await createService({
  name: SERVICE,
  module: AppModule.register({
    redis,
    seatMap,
    attempts: discardHoldAttempts,
    sessions,
    podId,
    signals,
    onHoldsExpired: (e) => orderExpiry?.onHoldsExpired(e),
    ...(database ? { seatSales: new DrizzleSeatSales(database) } : {}),
    ...(booking ? { booking } : {}),
    admission: {
      store: sessionStore,
      startedLog: new RedisSessionStartedLog(redis),
      endedLog: new RedisSessionEndedLog(redis),
      index: new RedisSessionIndex(redis),
      keys: admissionKeys,
      issuer: admissionIssuer,
      onSessionEnded,
    },
  }),
  purchaseSessions: sessions,
});
log = service.logger;
// DB 없이 뜬 것을 시작 로그에 남긴다(운영에서 비밀이 빠진 것을 결제 접수 연결(PRF-160) 전에도 알아채게, PRF-140 ① 리뷰)
if (!database) service.logger.warn({ dep: 'postgres' }, 'PEAKET_DATABASE_URL이 없어 purchase DB 없이 떴다(판매 확정 저장소 SeatSales와 주문 생성 POST /v1/orders를 내놓지 않는다)');
signals.register(service.metrics.registry);
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
  identity = identityClientsFromEnv(process.env, { profile: service.config.grpcLbProfile, breaker, contactRefBreaker });
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
if (booking && database) {
  paymentBreaker = new CircuitBreaker({ service: SERVICE, dependency: 'payment-svc', registry: service.metrics.registry, logger: service.logger });
  payment = paymentConfirmsFromEnv(process.env, { profile: service.config.grpcLbProfile, breaker: paymentBreaker });
  for (const w of payment.warnings) service.logger.warn({ dep: 'payment-svc' }, w);
  depositBreaker = new CircuitBreaker({ service: SERVICE, dependency: PAYMENT_DEPOSIT_BREAKER, registry: service.metrics.registry, logger: service.logger });
  depositReader = paymentDepositReaderFromEnv(process.env, {
    profile: service.config.grpcLbProfile,
    breaker: depositBreaker,
    onFailure: (code) => orderSignals.depositReadFailed(code),
    // 주문 ID만 싣는다. 답의 계좌 칸과 답의 주문 ID는 싣지 않는다
    onOrderMismatch: (orderId) => service.logger.warn({ kind: 'payment-deposit-order-mismatch', orderId }, 'GetPayment 답의 주문 ID가 요청과 달라 계좌 칸을 버렸다'),
  });
  const saga = new DrizzleSaga({ database, store: orderStore, sales: new DrizzleSeatSales(database), clock: systemClock });
  sagaRunner = new OrderSagaRunner({
    jobs: saga,
    orders: saga,
    reserve: saga,
    failures: saga,
    confirmSent: saga,
    pins: new InventoryOrderSeatPins({ pins: new RedisSeatStore(redis, service.logger), seatMap }),
    confirms: payment.confirms,
    configs: new SeatMapSagaConfigs(seatMap),
    log: new LoggerSagaLog(service.logger),
    clock: systemClock,
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
if (booking && database && databaseUrl) {
  ticketBreaker = new CircuitBreaker({ service: SERVICE, dependency: TICKET_DEPENDENCY, registry: service.metrics.registry, logger: service.logger });
  ticketIssuer = ticketIssuerFromEnv(process.env, { profile: service.config.grpcLbProfile, breaker: ticketBreaker });
  for (const w of ticketIssuer.warnings) service.logger.warn({ dep: TICKET_DEPENDENCY }, w);
  const ticketDb = createDatabase(ticketIssueDatabaseOptions(databaseUrl));
  ticketIssueDatabase = ticketDb;
  ticketRunner = new TicketIssueRunner({
    jobs: new DrizzleTicketIssue({ database: ticketDb, store: orderStore, clock: systemClock }),
    issuer: ticketIssuer.issuer,
    log: new LoggerTicketIssueLog(service.logger),
    signals: new PromTicketIssueSignals().register(service.metrics.registry),
    clock: systemClock,
    ...(paymentStatusWaiters ? { onOrderChanged: (orderId: string) => paymentStatusWaiters.notify(orderId) } : {}),
  });
  ticketVoidRunner = new TicketVoidRunner({ jobs: new DrizzleTicketVoid({ database: ticketDb, clock: systemClock }), voider: ticketIssuer.voider, log: new LoggerTicketVoidLog(service.logger), signals: new PromTicketVoidSignals().register(service.metrics.registry), clock: systemClock });
}
// Kafka 소비자 둘(BUILD_ORDER PRF-164, docs/features/seat-hold.md §6 '릴레이 프로세스와 조립의 첫 구현'): purchase DB(와 Saga·발권 실행기·결제 결과 기다림 표)가 있을 때만
// 설정을 읽는다(DB 없이 뜨는 동작은 그대로다). 브로커 주소가 없으면 local·ci만 경고 한 줄로 끄고, 그 밖의 환경은 여기서 던진다(시작 실패, 듣기 전).
// 결제 결과 반영 쓰임새는 소비자와 결제 결과 당기기(PRF-171)가 함께 쓰므로 소비자를 켜는지와 상관없이 만든다: 소비자 전용 일반 풀(consumerDatabaseOptions)을 만들어
// 결제 결과 반영(결과·판매 저장소)에 쓰고, 소비자를 켜면 원장 적재·보류 표도 같은 풀을 쓴다. 종료 때 닫는다(리뷰 고침 M4).
// 결제 결과 반영은 paymentResultApply로 조립한다(test-int/consumers.int.test.ts와 같은 함수. onOrderChanged = 이 파드의 기다림 표 notify, 필수.
// onApproved = 이 파드의 발권 실행기 kick: 승인 커밋 뒤 그 주문을 곧바로 발권한다, PRF-170)
let consumerOptions: PurchaseConsumersOptions | undefined;
let consumerDatabase: Database | undefined;
let applyPaymentResult: ReturnType<typeof paymentResultApply> | undefined;
if (databaseUrl && database && sagaRunner && ticketRunner && paymentStatusWaiters) {
  const issueRunner = ticketRunner;
  const voidRunner = ticketVoidRunner;
  const kafka = kafkaConsumersFromEnv(process.env, SERVICE);
  if (!kafka.enabled) service.logger.warn({ dep: 'kafka' }, kafka.warning);
  const consumerDb = createDatabase(consumerDatabaseOptions(databaseUrl));
  consumerDatabase = consumerDb;
  applyPaymentResult = paymentResultApply({
    database: consumerDb,
    store: orderStore,
    sessions: {
      // 결제 확정(COMPLETED)도 모듈의 끝내기와 같은 고리를 지난다(그 세션의 다른 열린 주문을 다시 본다, PRF-172)
      end: new EndPurchaseSession({ store: sessionStore, ended: new RedisSessionEndedLog(redis), clock: systemClock, signals, logger: service.logger, onEnded: onSessionEnded }),
      store: sessionStore,
    },
    saga: sagaRunner,
    logger: service.logger,
    clock: systemClock,
    onOrderChanged: (orderId) => paymentStatusWaiters.notify(orderId),
    onApproved: (orderId) => issueRunner.kick(orderId),
    ...(voidRunner ? { onDepositReversed: (orderId: string) => voidRunner.kick(orderId) } : {}),
  });
  if (kafka.enabled) {
    consumerOptions = {
      env: kafka.env,
      brokers: kafka.brokers,
      // client.id는 <작업자>-<환경>-<파드>(docs/streaming.md §2.6). 파드는 만료 임대 값(HOSTNAME 앞 57자 + 무작위)이다
      clientId: `${SERVICE}-${kafka.env}-${podId}`,
      auth: kafka.auth,
      database: consumerDb,
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
  paymentPull = paymentResultReaderFromEnv(process.env, { profile: service.config.grpcLbProfile, breaker: paymentPullBreaker });
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
await service.listen();
const sweeper = service.app.get(ExpirySweeper);
sweeper.start();
saleStateJudge?.start();
sagaRunner?.start();
ticketRunner?.start();
ticketVoidRunner?.start();
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
  process.exitCode = 1;
  shutdown();
});

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  // 좌석맵 판 다시 읽기를 멈추고, 만료 반복을 멈추고(돌던 틱을 기다린다) 서비스를 닫은 뒤 연결을 닫는다. 어느 단계가 실패해도 연결은 닫는다
  clearInterval(seatMapRefresh);
  // Kafka 소비자와 결제 결과 당기기 실행기를 가장 먼저 함께 멈춘다(소비자는 받기를 멈추고 처리 중인 키를 마친 뒤 커밋하고 나간다. 당기기는 부르던
  // BatchGetPayments와 그 뒤 반영·미루기를 기다린다. 남은 대상은 다음 점검 시각이 지나면 다른 파드가 잡는다). 둘 다 결제 결과를 반영해 Saga·발권 실행기·
  // 기다림 표를 깨우므로 그 셋보다 먼저 멈춘다(2026-11-06 코드 리뷰 L1). 그 뒤에 나머지를 멈춘다:
  // Saga 실행기(돌던 틱·kick을 기다린다. 멈춘 뒤의 접수 깨우기는 부르지 않고, 남은 작업은 다른 파드의 폴링이 줍는다),
  // 발권 실행기(부르던 발권 호출과 그 뒤 쓰기를 기다리고, 잡았지만 부르지 않은 큐 행은 임대를 놓는다. 남은 행은 다른 파드의 틱이 줍는다),
  // 결제 결과 기다림 표(돌던 묶음 조회를 기다리고 남은 기다림을 STOPPED로 깨운다. 그 요청들은 다시 읽지 않고 마지막 본문으로 곧바로 답한다).
  // 실행기 전용 풀은 실행기를 멈춘 뒤 아래에서 닫는다
  void Promise.all([
    (consumers?.stop() ?? Promise.resolve()).catch((err: unknown) => service.logger.error({ err: errorSummary(err) }, 'Kafka 소비자 멈추기 실패(나머지는 그대로 끝낸다)')),
    paymentPuller?.stop(),
  ])
    .then(() => Promise.all([sweeper.stop(), sessionSweeper.stop(), saleStateJudge?.stop(), sagaRunner?.stop(), ticketRunner?.stop(), ticketVoidRunner?.stop(), paymentStatusWaiters?.stop()]))
    .then(() => service.close())
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
        payment?.close();
        paymentBreaker?.shutdown();
        depositReader?.close();
        depositBreaker?.shutdown();
      } catch (err) {
        service.logger.error({ err: errorSummary(err) }, 'payment-svc 클라이언트 닫기 실패');
      }
      try {
        ticketIssuer?.close();
        ticketBreaker?.shutdown();
      } catch (err) {
        service.logger.error({ err: errorSummary(err) }, 'ticket-svc 클라이언트 닫기 실패');
      }
      try {
        paymentPull?.close();
        paymentPullBreaker?.shutdown();
      } catch (err) {
        service.logger.error({ err: errorSummary(err) }, 'payment-svc 결과 당기기 클라이언트 닫기 실패');
      }
      // 소비자 전용 풀(결제 결과 반영도 쓴다)은 소비자와 당기기를 멈춘 뒤라, 발권·당기기 실행기 전용 풀은 실행기를 멈춘 뒤라 쓰는 연결이 없다
      return Promise.all([redis.close(), database?.close(), consumerDatabase?.close(), ticketIssueDatabase?.close(), paymentPullDatabase?.close(), orderExpiryDatabase?.close(), saleStateDatabase?.close()]);
    });
}
process.once('SIGTERM', shutdown);
