// purchase-svc 시작. 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK가 node:http보다 먼저 서야 한다, docs/devops.md §4.4)
// 앱 포트(REST: 좌석 홀드 POST /v1/events/{eventId}/holds, 좌석 스냅샷 GET /v1/events/{eventId}/seatmap-snapshot)·관리 포트(/metrics, /ready)는 서비스 뼈대가 연다.
// 주문 생성 POST /v1/orders(BUILD_ORDER PRF-161)는 purchase DB(PEAKET_DATABASE_URL)가 있을 때만 연다. 그때는 PEAKET_ORDER_CONSENT_VERSION이 있어야 하고,
// identity-svc(PEAKET_IDENTITY_GRPC_ADDR, host:port)가 없으면 로컬·CI만 재확인은 토큰 판정·가명은 비움으로 뜨고(시작 로그 경고), 그 밖의 환경은 시작하지 않는다.
// 1초 만료 반복(ExpirySweeper, BUILD_ORDER PRF-135)과 구매 세션 정리 반복(SessionSweeper, PRF-138)을 듣기 시작한 뒤 켜고 SIGTERM 때 끈다. 좌석 Lua 지표(seat_lua_errors_total)를 /metrics에 붙인다.
// purchase DB가 있으면 주문 Saga 1단계 실행기(OrderSagaRunner, PRF-165)도 같이 켜고 끈다. 승인 명령 주소는 PEAKET_PAYMENT_GRPC_ADDR(없으면 local·ci만 '늘 접수' 대역).
// 구매 세션은 좌석 Redis의 s:jti·s:session과 서버 고정 ECDH 개인키(PEAKET_PURCHASE_ECDH_KEY)로 확인한다(BUILD_ORDER PRF-136). 입장 토큰은 공개키 묶음
// (PEAKET_ADMISSION_JWKS)과 발급자(PEAKET_ADMISSION_ISSUER)로 확인하고, 스냅샷 API가 입장 토큰의 첫 사용에 구매 세션을 연다(PRF-137).
// 좌석맵 판은 환경 값 PEAKET_SEATMAP_DIR 폴더의 {eventId}.json이다(docs/features/seat-hold.md §2 '운영 좌석맵 판'). 30초 [가정]마다 읽은 회차를 다시 읽는다.
// HoldAttempt 보내기(BAS-030)는 아직 없어 시도 기록은 버린다.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { CircuitBreaker, createDatabase, createHotRedis, createService, systemClock } from '@peaket/platform';
import { AppModule } from './app.module.js';
import {
  type BookingModuleDeps,
  CONSENT_VERSION_ENV,
  type ContactRefs,
  DrizzleOrderAccepts,
  DrizzleOrderStore,
  DrizzleOrderWrites,
  DrizzleSaga,
  type IdentityRecheck,
  identityClientsFromEnv,
  InventoryOrderSeatPins,
  InventoryOrderSessions,
  InventorySeatSlots,
  LoggerSagaLog,
  missingContactRefs,
  OrderSagaRunner,
  paymentConfirmsFromEnv,
  PromOrderSignals,
  RedisBookingRestrictions,
  SeatMapSagaConfigs,
  SeatMapSaleConfigs,
  unavailableIdentityRecheck,
} from './modules/booking/index.js';
import {
  DrizzleSeatSales,
  ExpirySweeper,
  FileSeatMapSource,
  LayoutSeatMap,
  PromSeatSignals,
  RedisOrderHolds,
  RedisPurchaseSessionStore,
  RedisSeatSlots,
  RedisSeatStore,
  RedisSessionEndedLog,
  RedisSessionIndex,
  RedisSessionStartedLog,
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
    }
  : undefined;
const service = await createService({
  name: SERVICE,
  module: AppModule.register({
    redis,
    seatMap,
    attempts: discardHoldAttempts,
    sessions,
    podId,
    signals,
    ...(database ? { seatSales: new DrizzleSeatSales(database) } : {}),
    ...(booking ? { booking } : {}),
    admission: {
      store: sessionStore,
      startedLog: new RedisSessionStartedLog(redis),
      endedLog: new RedisSessionEndedLog(redis),
      index: new RedisSessionIndex(redis),
      keys: admissionKeys,
      issuer: admissionIssuer,
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
// 주문 Saga 1단계 실행기(OrderSagaRunner, BUILD_ORDER PRF-165): purchase DB가 있을 때(booking이 있을 때) 이 API 파드에서 켠다.
// 승인 명령(payment-svc ConfirmPayment)은 차단기로 감싸고, 주소(PEAKET_PAYMENT_GRPC_ADDR)가 없으면 local·ci만 '늘 접수' 대역과 경고 한 줄이다.
// 그 밖의 환경은 주소가 없으면 여기서 던진다(시작 실패, 듣기 전). 듣기 시작한 뒤 1초 반복을 켜고 SIGTERM 때 끈다
let payment: ReturnType<typeof paymentConfirmsFromEnv> | undefined;
let paymentBreaker: CircuitBreaker | undefined;
if (booking && database) {
  paymentBreaker = new CircuitBreaker({ service: SERVICE, dependency: 'payment-svc', registry: service.metrics.registry, logger: service.logger });
  payment = paymentConfirmsFromEnv(process.env, { profile: service.config.grpcLbProfile, breaker: paymentBreaker });
  for (const w of payment.warnings) service.logger.warn({ dep: 'payment-svc' }, w);
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
  });
}
await service.listen();
const sweeper = service.app.get(ExpirySweeper);
sweeper.start();
sagaRunner?.start();
// 구매 세션 정리 반복(유휴·최대 체류, BUILD_ORDER PRF-138). 만료 반복과 같이 켜고 끈다
const sessionSweeper = service.app.get(SessionSweeper);
sessionSweeper.start();
const seatMapRefresh = setInterval(() => void seatMap.refresh(), SEATMAP_REFRESH_MS);
seatMapRefresh.unref();

process.once('SIGTERM', () => {
  // 좌석맵 판 다시 읽기를 멈추고, 만료 반복을 멈추고(돌던 틱을 기다린다) 서비스를 닫은 뒤 연결을 닫는다. 어느 단계가 실패해도 연결은 닫는다
  clearInterval(seatMapRefresh);
  // Saga 실행기도 함께 멈춘다(돌던 틱·kick을 기다린다. 멈춘 뒤의 접수 깨우기는 부르지 않고, 남은 작업은 다른 파드의 폴링이 줍는다)
  void Promise.all([sweeper.stop(), sessionSweeper.stop(), sagaRunner?.stop()])
    .then(() => service.close())
    .catch((err: unknown) => service.logger.error({ err }, 'purchase-svc 종료 실패'))
    .finally(() => {
      // 서비스를 닫은 뒤(새 요청이 없다) identity-svc·payment-svc 클라이언트와 차단기를 닫는다
      try {
        identity?.close();
        for (const b of identityBreakers) b.shutdown();
      } catch (err) {
        service.logger.error({ err }, 'identity-svc 클라이언트 닫기 실패');
      }
      try {
        payment?.close();
        paymentBreaker?.shutdown();
      } catch (err) {
        service.logger.error({ err }, 'payment-svc 클라이언트 닫기 실패');
      }
      return Promise.all([redis.close(), database?.close()]);
    });
});
