// purchase-svc의 릴레이 프로세스 시작(BUILD_ORDER PRF-164, docs/features/seat-hold.md §6 '릴레이 프로세스와 조립의 첫 구현', ADR-0116 결정 1·2).
// 서비스와 같은 이미지를 다른 시작 명령으로 띄운다: node --import @peaket/platform/telemetry/register dist/relay.js
// 배포는 `purchase-svc-outbox-relay` Deployment(복제 2, deploy/charts/peaket-service의 outboxRelay)다. Lease 리더 하나가 Outbox 릴레이·좌석 Stream 릴레이·
// 다시 만들기 반복·세대 올리기 감시(PRF-168)·주문 만료 안전망(PRF-172)·정비 일(공용 일, 주문 이력 검사, 회차 목록 빼기)을 함께 돈다. 조립은 relay-app.ts의 startPurchaseRelay이고, 이 파일은 연결을 만들고 닫는다.
// - DB 셋: 릴레이 역할(PEAKET_OUTBOX_DATABASE_URL)·정비 역할(PEAKET_MAINTENANCE_DATABASE_URL) 각 연결 2개, 서비스 역할(PEAKET_DATABASE_URL, 다시 만들기·주문 만료 안전망)은
//   relay-app.ts relayServiceDatabaseOptions(일반 풀 모양·연결 4개 [가정], 다시 만들기가 세 읽기를 함께 보낸다, 리뷰 고침 H1)
// - 좌석 Redis·좌석맵 판 폴더는 API(main.ts)와 같은 환경 값(PEAKET_SEAT_REDIS_URL 또는 PEAKET_SEAT_REDIS_CLUSTER_URLS, PEAKET_SEATMAP_DIR)
// - Kafka 생산자 하나를 Outbox 보내기와 좌석 Stream 릴레이(거래 토픽)가 함께 쓴다(MSK IAM 세션 이름 purchase-svc-outbox-relay-<환경>)
// 구현에서 정한 것: 좌석맵 판의 경고(판 파일을 읽지 못함)는 이 파일이 만든 로거(service·pod가 붙은 같은 모양)로 남긴다(프로세스 로거는 startPurchaseRelay 안에 있다).
import {
  createDatabase,
  createHotRedis,
  createPlatformLogger,
  inClusterLeaseApi,
  kafkaAuthFromEnv,
  loadOutboxRelayProcessConfig,
  loadPlatformConfig,
  systemClock,
} from '@peaket/platform';
import { createKafkaProducer, kafkaOutboxPublisher } from '@peaket/platform/stream-worker';
import { FileSeatMapSource, KafkaTradeEventPublisher, LayoutSeatMap, SeatMapEventCatalog } from './modules/inventory/index.js';
import { relayServiceDatabaseOptions, startPurchaseRelay } from './relay-app.js';

const SERVICE = 'purchase-svc';
const config = loadOutboxRelayProcessConfig(SERVICE, process.env);
const platformConfig = loadPlatformConfig(process.env);
const env = process.env.PEAKET_ENV ?? 'local';

const need = (name: string, what: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name}가 없다(${what})`);
  return v;
};
// 다시 만들기·주문 만료 안전망의 서비스 역할 주소와 좌석맵 판 폴더(듣기 전에 본다. 빠지면 시작하지 않는다)
const serviceDatabaseUrl = need('PEAKET_DATABASE_URL', '다시 만들기와 주문 만료 안전망이 쓰는 purchase DB 서비스 역할 주소');
const seatMapDir = need('PEAKET_SEATMAP_DIR', '회차별 좌석맵 판 파일 {eventId}.json이 있는 폴더');
// 좌석 Redis: 로컬·CI는 단일 노드 주소, 운영은 클러스터 시작 노드 주소들(쉼표). main.ts와 같은 규칙
const clusterUrls = (process.env.PEAKET_SEAT_REDIS_CLUSTER_URLS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const seatRedisUrl = process.env.PEAKET_SEAT_REDIS_URL;
if (!seatRedisUrl && clusterUrls.length === 0) throw new Error('PEAKET_SEAT_REDIS_URL이나 PEAKET_SEAT_REDIS_CLUSTER_URLS가 없다(비밀 관리에서 넣는다)');

const log = createPlatformLogger({
  service: SERVICE,
  env: platformConfig.env,
  version: platformConfig.version,
  az: process.env.PEAKET_AZ,
  pod: config.pod,
  clock: systemClock,
  level: platformConfig.logLevel,
});

// 릴레이 역할(Outbox 읽기·sent_at 고치기만)과 정비 역할(PgBouncer를 거치지 않는 주소)을 따로 받는다(docs/data.md §4의 7번).
// 다시 만들기·주문 만료 안전망은 서비스 역할이다(seat_rebuild·seat_sale·seat_hold·주문 표는 서비스 자신의 데이터, docs/features/seat-hold.md §6 'DB 역할')
const database = createDatabase({ url: config.outboxDatabaseUrl, applicationName: `${SERVICE}-outbox-relay`, max: 2 });
const maintenanceDatabase = createDatabase({ url: config.maintenanceDatabaseUrl, applicationName: `${SERVICE}-maintenance`, max: 2 });
const serviceDatabase = createDatabase(relayServiceDatabaseOptions(serviceDatabaseUrl));
const redis = await createHotRedis(clusterUrls.length > 0 ? { clusterUrls } : { url: seatRedisUrl });
const source = new FileSeatMapSource(seatMapDir);
const seatMap = new LayoutSeatMap({ source, clock: systemClock, logger: log });
// 운영은 MSK IAM: 작업자 전용 역할을 세션 이름 `<서비스>-outbox-relay-<환경>`으로 맡는다(PEAKET_KAFKA_AUTH=msk-iam, docs/streaming.md §2.6)
const producer = createKafkaProducer({ kind: 'outbox-relay', brokers: config.kafkaBrokers, clientId: `${SERVICE}-${env}-${config.pod}`, auth: kafkaAuthFromEnv(`${SERVICE}-outbox-relay`) });
await producer.connect();

const relay = await startPurchaseRelay({
  database,
  maintenanceDatabase,
  serviceDatabase,
  redis,
  seatMap,
  catalog: new SeatMapEventCatalog({ files: source, seatMap }),
  outboxPublisher: kafkaOutboxPublisher(producer),
  tradePublisher: new KafkaTradeEventPublisher(producer),
  leaseApi: inClusterLeaseApi(config.leaseName),
  holder: config.pod,
});

// 종료: 반복을 멈추고 Lease를 놓은 뒤 연결을 닫는다(종료 대기 30초 안, docs/devops.md §6.4).
// 처리기는 시작 바로 뒤에 붙인다(관리 포트를 여는 중에 SIGTERM이 와도 Lease를 놓고 끝나게, 코드 리뷰 2026-11-01)
let closing = false;
const shutdown = async (why: string, code: number) => {
  if (closing) return;
  closing = true;
  try {
    await relay.stop();
    await producer.disconnect();
    // 풀·좌석 Redis 닫기는 쓰이는 연결이 돌아오기를 기다린다. 한도를 넘겨 아직 도는 문장이 있어도 3초 [가정] 뒤에는 끝낸다(코드 리뷰 2026-11-01)
    await Promise.race([
      Promise.all([redis.close(), database.close(), maintenanceDatabase.close(), serviceDatabase.close()]),
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
