// ticket-svc Outbox 릴레이 프로세스 진입점(계획 §6, docs/streaming.md §2.6, ADR-0116).
// `node --import @peaket/platform/telemetry/register dist/relay.js`로 띄운다(배포는 동결 로컬).
// Outbox DB(PEAKET_OUTBOX_DATABASE_URL)·정비 DB(PEAKET_MAINTENANCE_DATABASE_URL)·Kafka(PEAKET_KAFKA_BROKERS)를 읽고,
// Lease 리더 하나가 trade.tickets 행을 Kafka로 낸다. SIGTERM/SIGINT에 반복을 멈추고 Lease를 놓는다.
// Avro 값은 이미 쓰기 때 `ticketEventCodec`(createAvroEncoder·readSchemaIdsFile, ticketEventCodecFromEnv)으로 만들어져 있다.
// Outbox 보내기는 relay-app.ts의 startTicketRelay → startOutboxRelayProcess가 맡고, Kafka 발행기는 kafkaOutboxPublisher다.
import {
  createDatabase,
  createPlatformLogger,
  loadOutboxRelayProcessConfig,
  loadPlatformConfig,
  systemClock,
} from '@peaket/platform';
import { startTicketRelay, ticketRelayEventCodec, ticketRelayPublisher } from './relay-app.js';

const SERVICE = 'ticket-svc';
const env = process.env;
const config = loadOutboxRelayProcessConfig(SERVICE, env);
const platformConfig = loadPlatformConfig(env);
const log = createPlatformLogger({
  service: SERVICE,
  env: platformConfig.env,
  version: platformConfig.version,
  az: env.PEAKET_AZ,
  pod: config.pod,
  clock: systemClock,
  level: platformConfig.logLevel,
});

// 이 프로세스는 값을 다시 인코딩하지 않는다. 시작 때 계약 코덱을 만들어 스키마 ID·계약이 준비됐는지 확인한다
void ticketRelayEventCodec(env);

const database = createDatabase({ url: config.outboxDatabaseUrl, applicationName: `${SERVICE}-outbox-relay`, max: 2 });
const maintenanceDatabase = createDatabase({ url: config.maintenanceDatabaseUrl, applicationName: `${SERVICE}-maintenance`, max: 2 });
const kafka = ticketRelayPublisher(env);
const relay = await startTicketRelay({ database, maintenanceDatabase, publisher: kafka.publisher, leaseApi: kafka.leaseApi, env });
const ports = await relay.listen();
log.info({ managementPort: ports.managementPort, lease: config.leaseName }, 'ticket Outbox 릴레이 프로세스를 열었다');

let closing = false;
const shutdown = async (why: string, code: number): Promise<void> => {
  if (closing) return;
  closing = true;
  try {
    await relay.stop();
    await kafka.stop();
    await Promise.race([Promise.all([database.close(), maintenanceDatabase.close()]), new Promise((r) => setTimeout(r, 3_000).unref())]);
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, `${why} 정리 실패`);
    code = 1;
  }
  process.exit(code);
};
process.once('SIGTERM', () => void shutdown('SIGTERM', 0));
process.once('SIGINT', () => void shutdown('SIGINT', 0));
