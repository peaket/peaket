// identity-svc의 Outbox 릴레이 프로세스 시작(세션 종료 사건 control.sessions-terminated, ADR-0116 결정 1·2, ADR-0143 결정 3). 서비스 뼈대 relay.ts를 옮겼다.
// 서비스와 같은 이미지를 다른 시작 명령으로 띄운다: node --import @peaket/platform/telemetry/register dist/relay.js
// 배포는 `<서비스>-outbox-relay` Deployment(복제 2, deploy/charts/peaket-service의 outboxRelay)다. Lease 리더만 보내고 정비를 돈다.
import { createDatabase, inClusterLeaseApi, kafkaAuthFromEnv, loadOutboxRelayProcessConfig, startOutboxRelayProcess } from '@peaket/platform';
import { createKafkaProducer, kafkaOutboxPublisher } from '@peaket/platform/stream-worker';

const SERVICE = 'identity-svc';
const config = loadOutboxRelayProcessConfig(SERVICE, process.env);
const env = process.env.PEAKET_ENV ?? 'local';

// 릴레이 역할(Outbox 읽기·sent_at 고치기만)과 정비 역할(PgBouncer를 거치지 않는 주소)을 따로 받는다(docs/data.md §4의 7번)
const database = createDatabase({ url: config.outboxDatabaseUrl, applicationName: `${SERVICE}-outbox-relay`, max: 2 });
const maintenanceDatabase = createDatabase({ url: config.maintenanceDatabaseUrl, applicationName: `${SERVICE}-maintenance`, max: 2 });
// 운영은 MSK IAM: 작업자 전용 역할을 세션 이름 `<서비스>-outbox-relay-<환경>`으로 맡는다(PEAKET_KAFKA_AUTH=msk-iam, docs/streaming.md §2.6)
const producer = createKafkaProducer({ kind: 'outbox-relay', brokers: config.kafkaBrokers, clientId: `${SERVICE}-${env}-${config.pod}`, auth: kafkaAuthFromEnv(`${SERVICE}-outbox-relay`) });
await producer.connect();

const relay = await startOutboxRelayProcess({
  service: SERVICE,
  database,
  maintenanceDatabase,
  publisher: kafkaOutboxPublisher(producer),
  leaseApi: inClusterLeaseApi(config.leaseName),
});

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
    await Promise.race([Promise.all([database.close(), maintenanceDatabase.close()]), new Promise((r) => setTimeout(r, 3_000).unref())]);
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
