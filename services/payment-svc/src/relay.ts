// payment-svc의 릴레이 프로세스 시작(BUILD_ORDER PRF-180, ADR-0116 결정 1·2, purchase-svc relay.ts와 같은 꼴).
// 서비스와 같은 이미지를 다른 시작 명령으로 띄운다: node --import @peaket/platform/telemetry/register dist/relay.js
// 조립은 relay-app.ts의 startPaymentRelay이고, 이 파일은 연결(릴레이·정비 역할 DB, Kafka 생산자, Lease API)을 만들고 닫는다.
import { createDatabase, inClusterLeaseApi, kafkaAuthFromEnv, loadOutboxRelayProcessConfig } from '@peaket/platform';
import { createKafkaProducer, kafkaOutboxPublisher } from '@peaket/platform/stream-worker';
import { loadPortoneGatewayConfig, loadSimulatorGatewayConfig, loadTossGatewayConfig } from './config.js';
import { PortoneGateway, createPgHttp, StaticPaymentGateways, TossPaymentGateway } from './modules/payment/server.js';
import { SimulatorPaymentGateway } from './modules/payment/adapters/pg/simulator-gateway.js';
import { relayServiceDatabaseOptions, startPaymentRelay } from './relay-app.js';
import { safeErrorCode } from './safe-error-code.js';

const SERVICE = 'payment-svc';
const config = loadOutboxRelayProcessConfig(SERVICE, process.env);
const env = process.env.PEAKET_ENV ?? 'local';

// 릴레이 역할(Outbox 읽기·sent_at 고치기만)과 정비 역할(PgBouncer를 거치지 않는 주소)을 따로 받는다(docs/data.md §4의 7번)
const database = createDatabase({ url: config.outboxDatabaseUrl, applicationName: `${SERVICE}-outbox-relay`, max: 2 });
const maintenanceDatabase = createDatabase({ url: config.maintenanceDatabaseUrl, applicationName: `${SERVICE}-maintenance`, max: 2 });
// 대사·입금 해시 지우기는 서비스 자신의 업무 데이터를 쓰므로 서비스 역할이다(purchase-svc 릴레이와 같은 나눔, BUILD_ORDER HOT-153 코드 리뷰 M14)
const serviceDatabaseUrl = process.env.PEAKET_DATABASE_URL;
if (!serviceDatabaseUrl) throw new Error('PEAKET_DATABASE_URL이 없다(대사와 입금 해시 지우기가 쓰는 payment DB 서비스 역할 주소)');
const serviceDatabase = createDatabase(relayServiceDatabaseOptions(serviceDatabaseUrl));
// 운영은 MSK IAM: 작업자 전용 역할을 세션 이름 `<서비스>-outbox-relay-<환경>`으로 맡는다(PEAKET_KAFKA_AUTH=msk-iam, docs/streaming.md §2.6)
const producer = createKafkaProducer({ kind: 'outbox-relay', brokers: config.kafkaBrokers, clientId: `${SERVICE}-${env}-${config.pod}`, auth: kafkaAuthFromEnv(`${SERVICE}-outbox-relay`) });
await producer.connect();

// 일일 대사의 결제사 어댑터(BUILD_ORDER HOT-153). 조회만 쓰므로 연결 하나씩이다
const simulator = loadSimulatorGatewayConfig(process.env);
const toss = loadTossGatewayConfig(process.env);
const portone = loadPortoneGatewayConfig(process.env);
const reconHttp = createPgHttp({ connections: 1 });
const gateways = new StaticPaymentGateways([
  ...(simulator ? [new SimulatorPaymentGateway({ ...simulator, fetch: reconHttp.fetch })] : []),
  ...(toss ? [new TossPaymentGateway({ ...toss, fetch: reconHttp.fetch })] : []),
  ...(portone ? [new PortoneGateway({ ...portone, fetch: reconHttp.fetch })] : []),
]);

const relay = await startPaymentRelay({
  database,
  maintenanceDatabase,
  serviceDatabase,
  outboxPublisher: kafkaOutboxPublisher(producer),
  leaseApi: inClusterLeaseApi(config.leaseName),
  gateways,
  holder: config.pod,
});

// 종료: 보내던 묶음을 마치고 Lease를 놓은 뒤 연결을 닫는다(종료 대기 30초 안, docs/devops.md §6.4).
// 처리기는 시작 바로 뒤에 붙인다(관리 포트를 여는 중에 SIGTERM이 와도 Lease를 놓고 끝나게)
let closing = false;
const shutdown = async (why: string, code: number) => {
  if (closing) return;
  closing = true;
  try {
    await relay.stop();
    await producer.disconnect();
    await reconHttp.close();
    // 풀 닫기는 쓰이는 연결이 돌아오기를 기다린다. 아직 도는 문장이 있어도 3초 [가정] 뒤에는 끝낸다
    await Promise.race([Promise.all([database.close(), maintenanceDatabase.close(), serviceDatabase.close()]), new Promise((r) => setTimeout(r, 3_000).unref())]);
  } catch (err) {
    console.error(JSON.stringify({ kind: 'outbox-relay', msg: `${why} 뒤 끝내기 실패`, code: safeErrorCode(err) }));
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
  console.error(JSON.stringify({ kind: 'outbox-relay', msg: '관리 포트를 열지 못했다', code: safeErrorCode(err) }));
  await shutdown('listen 실패', 1);
}
