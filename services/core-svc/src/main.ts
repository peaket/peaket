// 서비스 시작. 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK가 node:http보다 먼저 서야 한다, docs/devops.md §4.4)
// 듣기 시작한 뒤 Kafka 소비자(탈퇴 사건의 후기 파기와 16분 뒤 다시 정리, W7-audit COV2-06·ADR-0278, docs/streaming.md §2.6 'core-svc 소비자')를 켠다. 브로커 주소(PEAKET_KAFKA_BROKERS)가 없으면
// local·ci만 경고 한 줄로 소비자 없이 뜨고 그 밖의 환경은 시작하지 않는다. 소비자를 켜지 못하면 오류 한 줄 뒤 SIGTERM과 같은 차례로 끝내고 종료 코드 1을 둔다.
import { fileURLToPath } from 'node:url';
import { assertInternalGrpcToken, createDatabase, createExternalHttpClient, createHotRedis, createService, errorSummary, loadLogPseudonymizer, loadPlatformConfig, reauthJtiStoreFromEnv, systemClock } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { kafkaConsumersFromEnv } from './consumers/index.js';
import type { CoreConsumers } from './consumers/start.js';
import {
  CompositeSaleConfigStore,
  DrizzleSaleConfigStore,
  HttpPurchaseSaleOpen,
  QueueSaleConfigStore,
  SaleConfigMetrics,
  UnwiredSaleOpen,
  assertDatabaseRole,
  DrizzleCommissionRate,
  DrizzleSearchReadModel,
  GrpcAdminAuthz,
  GrpcImageProcessing,
  GrpcMemberCodeDirectory,
  GrpcSeatmapParser,
  HttpOpsApprovals,
  LocalFolderImageStore,
  LocalFolderPublicFileStore,
  QueueSaleEligibilityCopy,
  registerSearchPoolWaiting,
  SaleEligibilityMetrics,
  SearchCatalog,
  SearchReadModelTimers,
  StaticTemplateCatalog,
  UnwiredSaleEligibilityCopy,
} from './modules/catalog/index.js';
import {
  DrizzleReviewStore,
  FAN_PROFILE,
  GrpcReviewEligibility,
  REVIEW_CASE_SINK,
  REVIEW_ELIGIBILITY,
  REVIEW_EVENT_DIRECTORY,
  REVIEW_NOTIFIER,
  ReviewAccountWithdrawnHandler,
  Reviews,
  UnavailableReviewEligibility,
  UnavailableFanProfile,
} from './modules/review/index.js';
import { DrizzleWebhookStore, FanNotificationWorker, HttpsWebhookTransport, WebhookDispatcher, WebhookWorker } from './modules/notify/index.js';
import { GrpcHeldTickets, GrpcMerchPayments, RedisMerchStock, type ShopLogger, ShopSignals, closedShopReauthGate, shopReauthGateFromEnv, unavailableHeldTickets, unavailableMerchPayments, unavailableMerchStock } from './modules/shop/index.js';

const SERVICE = 'core-svc';
assertInternalGrpcToken(process.env);
// Kafka 소비자 설정은 서비스를 만들기 전에 읽는다(운영에서 브로커 주소가 없거나 틀리면 여기서 시작에 실패한다. 탈퇴 사건을 조용히 놓치지 않는다)
const kafka = kafkaConsumersFromEnv(process.env);
/** 파트너 경로의 풀 크기 [가정](핫패스가 아니다, ADR-0241) */
const PARTNER_POOL_MAX = 4;
const url = process.env.PEAKET_DATABASE_URL;
if (!url) throw new Error('PEAKET_DATABASE_URL이 없다(비밀 관리에서 넣는다)');
// 파트너 경로의 DB 사용자(core_partner, 행 보안의 대상, ADR-0241). 없으면 시작하지 않는다
const partnerUrl = process.env.PEAKET_PARTNER_DATABASE_URL;
if (!partnerUrl) throw new Error('PEAKET_PARTNER_DATABASE_URL이 없다(비밀 관리에서 넣는다)');
// 관제 판매 승인 경로의 DB 사용자(core_ops, 판매 승인 LCH-080). 없으면 승인·설정 사본을 쓸 수 없어 시작하지 않는다
const opsUrl = process.env.PEAKET_OPS_DATABASE_URL;
if (!opsUrl) throw new Error('PEAKET_OPS_DATABASE_URL이 없다(비밀 관리에서 넣는다)');
// 검색 전용 연결의 DB 사용자(core_search, 검색 표 넷 읽기만, ADR-0271 결정 18). 운영은 읽기 전용 복제본 주소다. 앱 주소로 대신하지 않는다
const searchUrl = process.env.PEAKET_SEARCH_DATABASE_URL;
if (!searchUrl) throw new Error('PEAKET_SEARCH_DATABASE_URL이 없다(검색 전용 core_search 사용자, 비밀 관리에서 넣는다)');
// 웹훅 발송기 전용 연결의 DB 사용자(core_notify, ADR-0351). 팬 경로 주소로 조용히 되돌아가지 않는다
const notifyUrl = process.env.PEAKET_NOTIFY_DATABASE_URL;
if (!notifyUrl) throw new Error('PEAKET_NOTIFY_DATABASE_URL이 없다(웹훅 발송기 전용 core_notify 사용자, 비밀 관리에서 넣는다)');

// 파트너 경로의 역할·테넌트는 요청마다 identity에 묻는다(ADR-0172). 주소가 없으면 시작하지 않는다(대역으로 통과시키지 않는다, ADR-0198 결정 6)
const identityGrpc = process.env.PEAKET_IDENTITY_GRPC_URL;
if (!identityGrpc) throw new Error('PEAKET_IDENTITY_GRPC_URL이 없다(identity AdminAuthzService host:port)');
// 부하 분산 프로필은 다른 서비스와 같은 설정(PEAKET_GRPC_LB_PROFILE)을 따른다
const platformConfig = loadPlatformConfig(process.env);
const lbProfile = platformConfig.grpcLbProfile;
const adminAuthz = new GrpcAdminAuthz(identityGrpc, lbProfile);
// 판매 자격 명단의 회원 코드 변환(identity MemberCodeService)도 같은 주소다(ADR-0261 결정 6). 서버(GAT-050) 전에는 UNIMPLEMENTED라 올리기가 503이다
const memberCodes = new GrpcMemberCodeDirectory(identityGrpc, lbProfile);
// 명단 사본을 대기열 Redis에 쓰는 어댑터(ADR-0261 결정 9, OPEN[33] (가)). 주소가 없으면 늘 실패하는 어댑터로 시작한다
const queueRedis = process.env.PEAKET_QUEUE_REDIS_URL ? await createHotRedis({ url: process.env.PEAKET_QUEUE_REDIS_URL }) : undefined;
const eligibilityCopy = queueRedis ? new QueueSaleEligibilityCopy(queueRedis) : new UnwiredSaleEligibilityCopy();
// 명단 감사 줄의 올린 계정은 로그 가명이다. 서비스 뼈대와 같은 키(PEAKET_LOG_PSEUDONYM_KEY)로 만들어 정규 로그 줄의 accountRef와 같은 값이 된다(ADR-0053 결정 1)
const { pseudonymizer: pseudonym } = loadLogPseudonymizer(process.env);
// 명단 운영 지표(올리기 결과·사본 넘기기 결과, docs/features/queue-admission.md §3 운영 확인 표)
const eligibilityMetrics = new SaleEligibilityMetrics();

// 공연 이미지·좌석맵 가져오기의 바깥 잇기(ADR-0257). 하나라도 없으면 시작하지 않는다(대역으로 통과시키지 않는다).
// 개발 실행: image-worker(HOT-200)가 생기기 전에는 ImageService 대역 gRPC 서버를, 좌석맵은 node dist/seatmap-worker/main.js를 띄워 주소를 넣는다.
// 이미지는 PEAKET_IMAGE_STORE_DIR 폴더의 quarantine/·staging/·public/에 둔다(S3 어댑터는 HOT-200). 대역은 같은 폴더를 읽고 쓴다
const need = (name: string, what: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name}이 없다(${what})`);
  return v;
};
const imageGrpc = need('PEAKET_IMAGE_GRPC_URL', 'image-worker ImageService host:port');
const seatmapGrpc = need('PEAKET_SEATMAP_GRPC_URL', 'seatmap-worker SeatmapImportService host:port');
const imageOrigin = need('PEAKET_IMAGE_BASE_URL', '이미지 출처, 운영 https://img.peaket.example');
if (!/^https?:\/\/[^/?#]+$/.test(imageOrigin)) throw new Error(`PEAKET_IMAGE_BASE_URL은 경로 없는 출처여야 한다: ${imageOrigin}`);
const imageStoreDir = need('PEAKET_IMAGE_STORE_DIR', '개발용 이미지 폴더. S3 어댑터는 HOT-200');
// 팬 좌석맵 파일(v1/events/{회차}/seatmap-layouts/{판}.json)을 두는 폴더(ADR-0260 결정 6). 공개 위치는 public/, 재승인 대기 판의 준비 위치는 staging/ 아래이고
// 개발 서버는 public/만 정적 파일로 내준다. S3 어댑터는 HOT-200
const publicFileDir = need('PEAKET_PUBLIC_FILE_DIR', '개발용 팬 좌석맵 파일 폴더. S3 어댑터는 HOT-200');
const imageProcessing = new GrpcImageProcessing(imageGrpc, lbProfile);
const seatmapParser = new GrpcSeatmapParser(seatmapGrpc, lbProfile);
// 좌석맵 템플릿 10종은 배포 때 넣는 정적 JSON 파일이다(ADR-0066). 폴더가 없거나 파일이 틀리면 시작하지 않는다
const templateDir = process.env.PEAKET_SEATMAP_TEMPLATE_DIR ?? fileURLToPath(new URL('../seed/seatmap-templates/', import.meta.url));
const templates = StaticTemplateCatalog.load(templateDir);
// 후기 자격은 ticket-svc CheckReviewEligibility에 묻는다(BAT-585). 주소가 없으면 후기 기능만 503이고 나머지는 뜬다
const ticketGrpc = process.env.PEAKET_TICKET_GRPC_URL;
const reviewEligibility = ticketGrpc ? new GrpcReviewEligibility(ticketGrpc, lbProfile) : new UnavailableReviewEligibility();
if (!ticketGrpc) console.warn(JSON.stringify({ level: 'warn', kind: 'review-eligibility', msg: 'PEAKET_TICKET_GRPC_URL이 없어 후기 자격 확인이 503이다' }));

// 굿즈 주문의 바깥 잇기(BAT-600, ADR-0299~0301). 하나라도 없으면 그 경로만 503이고 나머지는 뜬다(후기 자격과 같은 꼴):
// 재고 Redis(세션·캐시 클러스터 PEAKET_SHOP_REDIS_URL) → 한정 상품 주문 503, payment-svc(PEAKET_PAYMENT_GRPC_ADDR) → 결제 시도 503 pg-unavailable,
// ticket-svc(PEAKET_TICKET_GRPC_URL, 후기 자격과 같은 주소) → 부가 상품·티켓 소지자 전용 시간대 503, 동의 문안 판(PEAKET_MERCH_CONSENT_VERSION) → 택배 주문 503
const shopRedis = process.env.PEAKET_SHOP_REDIS_URL ? await createHotRedis({ url: process.env.PEAKET_SHOP_REDIS_URL }) : undefined;
const merchStock = shopRedis ? new RedisMerchStock(shopRedis) : unavailableMerchStock;
const paymentAddr = process.env.PEAKET_PAYMENT_GRPC_ADDR;
const grpcPayments = paymentAddr ? new GrpcMerchPayments(paymentAddr, lbProfile) : undefined;
const heldTickets = ticketGrpc ? new GrpcHeldTickets(ticketGrpc, lbProfile) : undefined;
const merchConsentVersion = process.env.PEAKET_MERCH_CONSENT_VERSION;
for (const [name, ok] of [
  ['PEAKET_SHOP_REDIS_URL', shopRedis !== undefined],
  ['PEAKET_PAYMENT_GRPC_ADDR', grpcPayments !== undefined],
  ['PEAKET_TICKET_GRPC_URL', heldTickets !== undefined],
  ['PEAKET_MERCH_CONSENT_VERSION', merchConsentVersion !== undefined],
] as const) {
  if (!ok) console.warn(JSON.stringify({ level: 'warn', kind: 'shop-wiring', msg: `${name}이 없어 굿즈 주문의 그 경로가 503이다` }));
}
const shopSignals = new ShopSignals();
// shop 로그는 서비스 로거로 보낸다(서비스를 만든 뒤에만 불린다)
let serviceLogger: ShopLogger | undefined;
const shopLogger: ShopLogger = {
  info: (o, m) => serviceLogger?.info(o, m),
  warn: (o, m) => serviceLogger?.warn(o, m),
  error: (o, m) => serviceLogger?.error(o, m),
};

// 굿즈 취소의 재인증 확인기(ADR-0315, ADR-0293). 팬 공개키 묶음 주소가 없으면 local·ci는 닫힌 대역(늘 403), 그 밖 환경은 시작 실패.
// jti 한 번 쓰기는 샵 Redis(PEAKET_SHOP_REDIS_URL)를 쓰고, 없으면 local·ci는 메모리·그 밖은 닫힌 저장소다.
const shopReauth =
  shopReauthGateFromEnv({
    env: process.env,
    jti: reauthJtiStoreFromEnv(process.env, shopRedis),
    clock: systemClock,
    warn: (m) => console.warn(JSON.stringify({ level: 'warn', kind: 'shop-reauth', msg: m })),
    onResult: (r) => (r.outcome === 'unavailable' ? shopLogger.warn({ kind: 'shop-reauth-unavailable', reason: r.reason }, '굿즈 취소 재인증 토큰을 확인하지 못했다') : shopLogger.info({ kind: 'shop-reauth-rejected', reason: r.reason }, '굿즈 취소 재인증 토큰을 거절했다')),
  }) ?? closedShopReauthGate;

// 계약 변경 요청(BAT-615): ops-svc 내부 승인 업무 생성. 주소가 없으면 그 경로만 503이고 시작은 막지 않는다(ADR-0320)
const opsHttpUrl = process.env.PEAKET_OPS_HTTP_URL;
const opsApprovals = opsHttpUrl
  ? new HttpOpsApprovals(createExternalHttpClient({ provider: 'ops-svc', baseUrl: opsHttpUrl, timeoutCapMs: 3_000 }), process.env.PEAKET_INTERNAL_TOKEN)
  : undefined;
if (!opsApprovals) console.warn(JSON.stringify({ level: 'warn', kind: 'promoter-contract-wiring', msg: 'PEAKET_OPS_HTTP_URL이 없어 계약 변경 요청이 503 dependency-unavailable이다' }));

// 판매 승인 뒤 purchase-svc 내부 판매 열기(BAT-616, ADR-0327). 주소가 없으면 승인은 되고 열기·사본은 'unwired' 경고만 남긴다(대기열은 닫힌 채로 남는다)
const purchaseHttpUrl = process.env.PEAKET_PURCHASE_HTTP_URL;
const saleOpen = purchaseHttpUrl
  ? new HttpPurchaseSaleOpen(createExternalHttpClient({ provider: 'purchase-svc', baseUrl: purchaseHttpUrl, timeoutCapMs: 3_000 }), process.env.PEAKET_INTERNAL_TOKEN)
  : new UnwiredSaleOpen();
if (!purchaseHttpUrl) console.warn(JSON.stringify({ level: 'warn', kind: 'sale-open-wiring', msg: 'PEAKET_PURCHASE_HTTP_URL이 없어 판매 승인 뒤 판매 열기·사본 쓰기가 unwired다(대기열은 닫힌 채로 남는다)' }));
// 판매 승인 부수 효과 지표(sale_open_total·sale_config_publish_total). 서비스를 만든 뒤 등록부에 단다
const saleConfigMetrics = new SaleConfigMetrics();

const database = createDatabase({ url, applicationName: SERVICE });
const partnerDatabase = createDatabase({ url: partnerUrl, applicationName: `${SERVICE}-partner`, max: PARTNER_POOL_MAX });
const opsDatabase = createDatabase({ url: opsUrl, applicationName: `${SERVICE}-ops`, max: PARTNER_POOL_MAX });
// 판매 승인 사본을 core DB와 대기열 Redis에 함께 쓴다(BAT-616). 대기열 주소가 없으면 DB 사본만 쓴다
const saleConfigStore = queueRedis ? new CompositeSaleConfigStore(new DrizzleSaleConfigStore(opsDatabase), new QueueSaleConfigStore(queueRedis)) : undefined;
// Kafka 소비자(탈퇴 파기·다시 정리 예약·보류 표) 전용 core_app 풀. 사건이 몰려도 팬·관제 HTTP 경로의 연결을 빼앗지 않게 따로 작게 둔다(최대 2개 [가정], docs/streaming.md §2.6, 리뷰 K2)
const consumerDatabase = createDatabase({ url, applicationName: `${SERVICE}-consumer`, max: 2 });
// 검색 전용 연결 묶음(ADR-0271 결정 5·18, docs/features/search.md §7.2: 연결 10개·대기 100ms [가정]). 운영은 읽기 전용 복제본 주소(PEAKET_SEARCH_DATABASE_URL).
// 다 차면 검색만 503이고 다른 경로의 연결을 빼앗지 않는다
const SEARCH_POOL_MAX = 10;
const SEARCH_POOL_WAIT_MS = 100;
const searchDatabase = createDatabase({ url: searchUrl, applicationName: `${SERVICE}-search`, max: SEARCH_POOL_MAX, connectionTimeoutMillis: SEARCH_POOL_WAIT_MS });
// 웹훅 발송기 전용 풀(core_notify, ADR-0351 결정 2). 발송 주기 5초·한 번에 100행과 내부 입구가 함께 쓴다
const NOTIFY_POOL_MAX = 4;
const notifyDatabase = createDatabase({ url: notifyUrl, applicationName: `${SERVICE}-notify`, max: NOTIFY_POOL_MAX });
// 소유자 주소를 넣거나 역할을 겸하면 행 보안이 조용히 꺼지므로 시작하지 않는다(ADR-0241)
await assertDatabaseRole(database, 'core_app');
await assertDatabaseRole(partnerDatabase, 'core_partner');
await assertDatabaseRole(opsDatabase, 'core_ops');
await assertDatabaseRole(consumerDatabase, 'core_app');
await assertDatabaseRole(searchDatabase, 'core_search');
await assertDatabaseRole(notifyDatabase, 'core_notify');
/** 요청 하나(머리·본문)를 다 받는 시한 [가정]: 천천히 보내는 연결이 올리기 버퍼와 칸막이 자리를 오래 쥐지 않게(ADR-0257 결정 2) */
const REQUEST_TIMEOUT_MS = 100_000;
const service = await createService({
  name: SERVICE,
  adminAuthz,
  // 파트너 테넌트당 600회/분 공용 가드(BAT-173, D-T50 ⑦). 세션·캐시 클러스터(샵 Redis)의 rl:tenant:{tenantId}를 센다.
  // local·ci 밖에서 이 값이 없으면 파트너 경로가 조용히 한도를 빠져나가므로 createService가 시작을 막는다
  ...(shopRedis ? { tenantRateLimit: { redis: shopRedis } } : {}),
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  module: AppModule.register({
    database,
    notifyDatabase,
    partnerDatabase,
    opsDatabase,
    searchDatabase,
    media: { imageOrigin, processing: imageProcessing, store: new LocalFolderImageStore(imageStoreDir), seatmap: seatmapParser, publicFiles: new LocalFolderPublicFileStore(publicFileDir), memberCodes, eligibilityCopy, pseudonym, eligibilityMetrics, templates },
    review: { eligibility: reviewEligibility, fanProfile: new UnavailableFanProfile() },
    shop: {
      stock: merchStock,
      payments: grpcPayments ?? unavailableMerchPayments,
      held: heldTickets ?? unavailableHeldTickets,
      reauth: shopReauth,
      commission: new DrizzleCommissionRate(partnerDatabase),
      ...(merchConsentVersion !== undefined ? { consentVersion: merchConsentVersion } : {}),
      signals: shopSignals,
      logger: shopLogger,
    },
    ...(opsApprovals ? { opsApprovals } : {}),
    ...(saleConfigStore ? { saleConfigStore } : {}),
    saleOpen,
    saleConfigMetrics,
    ...(process.env.PEAKET_IDENTITY_JWKS_URL ? { exportJwks: { url: process.env.PEAKET_IDENTITY_JWKS_URL, issuer: process.env.PEAKET_IDENTITY_ISSUER ?? 'https://identity.peaket.example' } } : {}),
    ...(process.env.PEAKET_PURCHASE_HTTP_URL
      ? { purchaseHttp: { url: process.env.PEAKET_PURCHASE_HTTP_URL, ...(process.env.PEAKET_INTERNAL_TOKEN ? { token: process.env.PEAKET_INTERNAL_TOKEN } : {}) } }
      : {}),
    identityGrpc,
    reauthJti: reauthJtiStoreFromEnv(process.env, queueRedis),
  }),
});
serviceLogger = service.logger;
shopSignals.register(service.metrics.registry);
saleConfigMetrics.register(service.metrics.registry);
if (eligibilityCopy instanceof UnwiredSaleEligibilityCopy) eligibilityCopy.register(service.metrics.registry);
eligibilityMetrics.register(service.metrics.registry);
// 검색 전용 연결 묶음의 대기 수(게이지 search_pool_waiting, SR-T13 ①). 기본 core_app 묶음이 아니라 검색 묶음을 넘긴다
registerSearchPoolWaiting(service.metrics.registry, searchDatabase.pool);
// 검색 읽기 모델 주기 일(ADR-0271 결정 3·6): 1분 정리·1시간 관심도는 판매 승인과 같은 쓰기 역할(core_ops)로, 자동완성 사전은 검색 연결로 10초마다 갱신한다
const searchSource = new DrizzleSearchReadModel(searchDatabase, imageOrigin);
const searchTimers = new SearchReadModelTimers({
  sync: new DrizzleSearchReadModel(opsDatabase, imageOrigin),
  dictionary: service.app.get(SearchCatalog).dictionary,
  termCount: () => searchSource.termCount(),
  clock: systemClock,
  logger: service.logger,
}).register(service.metrics.registry);
// 종료 세션 목록(ADR-0333 결정 2): 듣기 전에 두 제어 토픽(설정·종료 세션)을 읽기 시작한다(다 읽어야 /ready 200). 브로커가 없으면 local·ci만 경고로 끄고
// 그 밖은 여기서 시작에 실패한다. 이 도우미가 Kafka 클라이언트(네이티브 모듈)를 싣는다. 서비스를 닫은 뒤 끈다
const { startServiceControlSync } = await import('@peaket/platform/stream-worker');
const controlSync = startServiceControlSync(service, process.env);
await service.listen();
// 시작 따라잡기(ADR-0271 결정 12) → 사전 첫 읽기 → 주기 일. 둘 다 준비 확인에 넣지 않는다: 그동안 /ready는 200이고 검색은 표에 있는 줄로, 자동완성은 빈 후보·no-store로 답한다(결정 14)
await searchTimers.start();

// 웹훅 발송기(BUILD_ORDER BAT-610 잔여). PEAKET_WEBHOOK_WORKER=off면 켜지 않는다. 저장소는 core_notify 연결이다(ADR-0351)
const webhookWorker =
  process.env.PEAKET_WEBHOOK_WORKER === 'off'
    ? undefined
    : new WebhookWorker(new WebhookDispatcher({ store: new DrizzleWebhookStore(notifyDatabase), transport: new HttpsWebhookTransport(), clock: systemClock }), systemClock);
webhookWorker?.start();

// BAT-455 팬 알림 발송기(GAT-250). PEAKET_NOTIFY_WORKER=off면 켜지 않는다. 원장 저장소는 core_notify 연결이다
const fanNotifyWorker = process.env.PEAKET_NOTIFY_WORKER === 'off' ? undefined : service.app.get(FanNotificationWorker);
fanNotifyWorker?.start();

// 탈퇴 사건 소비자(그룹 peaket.core-svc.<환경>)와 다시 정리 반복. DB는 소비자 전용 core_app 풀이다(후기 파기·다시 정리 예약과 보류 표 held_event, 리뷰 K2)
let consumers: CoreConsumers | undefined;
let closing: Promise<void> | undefined;
if (!kafka.enabled) service.logger.warn({ dep: 'kafka' }, kafka.warning);
else {
  // 탈퇴 사건 소비자는 브로커 주소가 있을 때만 싣는다(local·ci에서 브로커 없이 뜰 때는 싣지 않는다)
  const { startCoreConsumers } = await import('./consumers/start.js');
  const pod = (process.env.PEAKET_POD ?? process.env.HOSTNAME ?? 'local').slice(0, 64);
  // 파기 UPDATE·다시 정리 예약도 소비자 풀로 쓴다(처리기와 반복이 같은 Reviews). 후기 유스케이스의 나머지 의존은 서비스 조립의 것을 그대로 쓴다
  const consumerReviews = new Reviews({
    store: new DrizzleReviewStore(consumerDatabase),
    events: service.app.get(REVIEW_EVENT_DIRECTORY),
    eligibility: service.app.get(REVIEW_ELIGIBILITY),
    fanProfile: service.app.get(FAN_PROFILE),
    notifier: service.app.get(REVIEW_NOTIFIER),
    cases: service.app.get(REVIEW_CASE_SINK),
    clock: systemClock,
  });
  consumers = startCoreConsumers({
    env: kafka.env,
    brokers: kafka.brokers,
    clientId: `${SERVICE}-${kafka.env}-${pod}`,
    auth: kafka.auth,
    database: consumerDatabase,
    handler: new ReviewAccountWithdrawnHandler(consumerReviews, undefined, { logger: service.logger }),
    recheck: consumerReviews,
    registry: service.metrics.registry,
    logger: service.logger,
  });
  consumers.started.catch((err: unknown) => {
    service.logger.error({ dep: 'kafka', err: errorSummary(err) }, 'Kafka 소비자를 켜지 못해 core-svc를 끝낸다');
    process.exitCode = 1;
    void shutdown();
  });
}

process.once('SIGTERM', () => {
  void shutdown();
});

/** 종료 차례(SIGTERM, 소비자 시작 실패). 두 번 불러도 한 번만 한다 */
function shutdown(): Promise<void> {
  closing ??= (async () => {
    webhookWorker?.stop();
    fanNotifyWorker?.stop();
    searchTimers.stop();
    // Kafka 소비자를 먼저 멈춘다(받기를 멈추고 처리 중인 키를 마친 뒤 커밋). 실패해도 나머지는 그대로 끝낸다
    await consumers?.stop().catch((err: unknown) => service.logger.error({ dep: 'kafka', err: errorSummary(err) }, 'Kafka 소비자 멈추기 실패(나머지는 그대로 끝낸다)'));
    // 받는 요청을 마치고 identity 채널과 DB 연결을 닫는다
    await service
      .close()
      .catch((err: unknown) => service.logger.error({ err }, 'core-svc 종료 실패'))
      .finally(() => {
        adminAuthz.close();
        memberCodes.close();
        imageProcessing.close();
        seatmapParser.close();
        if (reviewEligibility instanceof GrpcReviewEligibility) reviewEligibility.close();
        grpcPayments?.close();
        heldTickets?.close();
        void queueRedis?.close();
        void shopRedis?.close();
        // 종료 세션 목록 소비는 서비스를 닫은 뒤(처리 중인 요청이 끝난 뒤) 끈다(ADR-0333 결정 2)
        return Promise.all([controlSync?.close(), database.close(), partnerDatabase.close(), opsDatabase.close(), consumerDatabase.close(), searchDatabase.close(), notifyDatabase.close()]);
      });
  })();
  return closing;
}
