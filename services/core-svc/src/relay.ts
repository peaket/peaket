// 서비스별 Outbox 릴레이 프로세스 시작(ADR-0116 결정 1·2, BUILD_ORDER FND-110).
// 서비스와 같은 이미지를 다른 시작 명령으로 띄운다: node --import @peaket/platform/telemetry/register dist/relay.js
// 배포는 `<서비스>-outbox-relay` Deployment(복제 2, deploy/charts/peaket-service의 outboxRelay)다. Lease 리더만 보내고 정비를 돈다.
import {
  createDatabase,
  createHotRedis,
  createPlatformLogger,
  inClusterLeaseApi,
  kafkaAuthFromEnv,
  loadOutboxRelayProcessConfig,
  loadPlatformConfig,
  platformMaintenanceTasks,
  startOutboxRelayProcess,
  systemClock,
} from '@peaket/platform';
import { createKafkaProducer, kafkaOutboxPublisher } from '@peaket/platform/stream-worker';
import { assertDatabaseRole, CompositeSaleConfigStore, DrizzleSaleConfigStore, QueueSaleConfigStore } from './modules/catalog/index.js';
import { coreMaintenanceTasks } from './maintenance-tasks.js';
import {
  DrizzleShopOrderStore,
  GrpcMerchPayments,
  intervalLoop,
  MERCH_LOOP_INTERVAL_MS,
  MERCH_REFUND_LOOP_INTERVAL_MS,
  MerchPaymentResults,
  MerchRefundRetry,
  MerchStockExpiry,
  MerchUnclaimed,
  RedisMerchStock,
  ShopSignals,
  unavailableMerchPayments,
  unavailableMerchStock,
} from './modules/shop/index.js';

const SERVICE = 'core-svc';
const config = loadOutboxRelayProcessConfig(SERVICE, process.env);
const env = process.env.PEAKET_ENV ?? 'local';

// 릴레이 역할(Outbox 읽기·sent_at 고치기만)과 정비 역할(PgBouncer를 거치지 않는 주소)을 따로 받는다(docs/data.md §4의 7번)
const database = createDatabase({ url: config.outboxDatabaseUrl, applicationName: `${SERVICE}-outbox-relay`, max: 2 });
const maintenanceDatabase = createDatabase({ url: config.maintenanceDatabaseUrl, applicationName: `${SERVICE}-maintenance`, max: 2 });
// 운영은 MSK IAM: 작업자 전용 역할을 세션 이름 `<서비스>-outbox-relay-<환경>`으로 맡는다(PEAKET_KAFKA_AUTH=msk-iam, docs/streaming.md §2.6)
const producer = createKafkaProducer({ kind: 'outbox-relay', brokers: config.kafkaBrokers, clientId: `${SERVICE}-${env}-${config.pod}`, auth: kafkaAuthFromEnv(`${SERVICE}-outbox-relay`) });
await producer.connect();

// 관제 판매 승인·설정 사본 쓰기의 DB 역할(core_ops). 주소가 없으면 회차 판매 설정 다시 쓰기만 띄우지 않는다
const opsUrl = process.env.PEAKET_OPS_DATABASE_URL;
const opsDatabase = opsUrl ? createDatabase({ url: opsUrl, applicationName: `${SERVICE}-ops`, max: 2 }) : undefined;
// 소유자·슈퍼유저로 붙으면 행 보안이 조용히 꺼지므로 시작하지 않는다(ADR-0241)
if (opsDatabase) await assertDatabaseRole(opsDatabase, 'core_ops');
// 대기열 Redis의 회차 판매 설정 사본(판매 승인 LCH-080). 주소가 없으면 core DB 사본만 쓴다
const queueRedisUrl = process.env.PEAKET_QUEUE_REDIS_URL;
const queueRedis = queueRedisUrl ? await createHotRedis({ url: queueRedisUrl }) : undefined;
const saleConfigStore = opsDatabase
  ? queueRedis
    ? new CompositeSaleConfigStore(new DrizzleSaleConfigStore(opsDatabase), new QueueSaleConfigStore(queueRedis))
    : new DrizzleSaleConfigStore(opsDatabase)
  : undefined;
// 굿즈 주문의 리더 반복 셋(재고 예약 만료·결과 당기기와 승인 명령 다시 보내기·미수령 환급 다시 부르기)과 shop 정비 일 둘(BAT-600, ADR-0300 결정 2·6·7, ADR-0301 결정 5).
// 서비스 역할 연결(core_app, PEAKET_DATABASE_URL)이 있을 때만 돈다. 재고 Redis(PEAKET_SHOP_REDIS_URL)나 payment-svc(PEAKET_PAYMENT_GRPC_ADDR)가 없으면 그 호출이 실패로 끝나고
// 반복은 다음 바퀴에 다시 한다(경고 로그)
const platformConfig = loadPlatformConfig(process.env);
const shopLogger = createPlatformLogger({ service: SERVICE, env: platformConfig.env, version: platformConfig.version, clock: systemClock, level: platformConfig.logLevel });
const shopUrl = process.env.PEAKET_DATABASE_URL;
const shopDatabase = shopUrl ? createDatabase({ url: shopUrl, applicationName: `${SERVICE}-relay-shop`, max: 2 }) : undefined;
if (shopDatabase) await assertDatabaseRole(shopDatabase, 'core_app');
else shopLogger.warn({ kind: 'shop-relay' }, 'PEAKET_DATABASE_URL이 없어 굿즈 주문의 만료·결과 당기기·환급 반복과 shop 정비 일을 돌리지 않는다');
const shopRedis = process.env.PEAKET_SHOP_REDIS_URL ? await createHotRedis({ url: process.env.PEAKET_SHOP_REDIS_URL }) : undefined;
const merchStock = shopRedis ? new RedisMerchStock(shopRedis) : unavailableMerchStock;
const paymentAddr = process.env.PEAKET_PAYMENT_GRPC_ADDR;
const grpcPayments = paymentAddr ? new GrpcMerchPayments(paymentAddr, platformConfig.grpcLbProfile) : undefined;
const merchPayments = grpcPayments ?? unavailableMerchPayments;
const shopSignals = new ShopSignals();
// 공용 정비 일과 core-svc의 일(판매 자격 명단 파기·사본 다시 넘기기·회차 판매 설정 다시 쓰기, ADR-0261 결정 7·9, LCH-080)
const core = coreMaintenanceTasks(maintenanceDatabase, systemClock, process.env, {
  ...(saleConfigStore ? { saleConfigStore } : {}),
  ...(opsDatabase ? { opsDatabase } : {}),
  ...(shopDatabase ? { shop: { database: shopDatabase, payments: merchPayments, signals: shopSignals } } : {}),
});
const relay = await startOutboxRelayProcess({
  service: SERVICE,
  database,
  maintenanceDatabase,
  publisher: kafkaOutboxPublisher(producer),
  leaseApi: inClusterLeaseApi(config.leaseName),
  maintenanceTasks: [...platformMaintenanceTasks(maintenanceDatabase, systemClock), ...core.tasks],
  leaderLoops: ({ leader, logger }) => {
    if (!shopDatabase) return [];
    const store = new DrizzleShopOrderStore(shopDatabase, systemClock);
    const deps = { store, stock: merchStock, payments: merchPayments, clock: systemClock, signals: shopSignals, logger };
    const expiry = new MerchStockExpiry(deps);
    const results = new MerchPaymentResults(deps);
    const unclaimed = new MerchUnclaimed(deps);
    const refundRetry = new MerchRefundRetry(deps);
    return [
      intervalLoop({ name: 'merch-stock-expiry', everyMs: MERCH_LOOP_INTERVAL_MS, leader, logger, tick: () => expiry.tick() }),
      intervalLoop({ name: 'merch-payment-results', everyMs: MERCH_LOOP_INTERVAL_MS, leader, logger, tick: () => results.tick() }),
      intervalLoop({ name: 'merch-refund-retry', everyMs: MERCH_REFUND_LOOP_INTERVAL_MS, leader, logger, tick: () => unclaimed.retry() }),
      intervalLoop({ name: 'merch-user-refund-retry', everyMs: MERCH_REFUND_LOOP_INTERVAL_MS, leader, logger, tick: () => refundRetry.tick() }),
    ];
  },
});
core.copy.register(relay.registry);
core.metrics.register(relay.registry);
shopSignals.register(relay.registry);

// 종료: 보내던 묶음을 마치고 Lease를 놓은 뒤 연결을 닫는다(종료 대기 30초 안, docs/devops.md §6.4).
// 처리기는 시작 바로 뒤에 붙인다(관리 포트를 여는 중에 SIGTERM이 와도 Lease를 놓고 끝나게, 코드 리뷰 2026-11-01)
let closing = false;
const shutdown = async (why: string, code: number) => {
  if (closing) return;
  closing = true;
  try {
    await relay.stop();
    await producer.disconnect();
    // 풀 닫기는 쓰이는 연결이 돌아오기를 기다린다. 정비 한도를 넘겨 아직 도는 문장이 있어도 3초 [가정] 뒤에는 끝낸다(코드 리뷰 2026-11-01)
    grpcPayments?.close();
    await Promise.race([
      Promise.all([database.close(), maintenanceDatabase.close(), opsDatabase?.close(), queueRedis?.close(), shopDatabase?.close(), shopRedis?.close()]),
      new Promise((r) => setTimeout(r, 3_000).unref()),
    ]);
  } catch (err) {
    console.error(JSON.stringify({ kind: 'outbox-relay', msg: `${why} 뒤 끝내기 실패`, err: String(err) }));
    code = 1;
  }
  process.exit(code);
};
process.once('SIGTERM', () => void shutdown('SIGTERM', 0));
process.once('SIGINT', () => void shutdown('SIGINT', 0));

try {
  await relay.listen();
} catch (err) {
  // 관리 포트를 열지 못하면(포트 충돌 등) 반복을 멈추고 Lease를 놓은 뒤 실패로 끝낸다(Lease 기간을 기다리게 하지 않는다)
  console.error(JSON.stringify({ kind: 'outbox-relay', msg: '관리 포트를 열지 못했다', err: String(err) }));
  await shutdown('listen 실패', 1);
}
