// ticket-svc Outbox 릴레이 조립(계획 §6, docs/data.md §4 'outbox', docs/streaming.md §2.6).
// 배포는 동결 로컬이라 하지 않지만, 로컬·CI에서 `trade.tickets` 행을 Kafka로 내는 진입점은 이 기능 몫이다.
import {
  type Clock,
  inClusterLeaseApi,
  kafkaAuthFromEnv,
  loadOutboxRelayProcessConfig,
  type OutboxPublisher,
  type OutboxRelayProcess,
  startOutboxRelayProcess,
  systemClock,
  type Database,
  type LeaseApi,
} from '@peaket/platform';
import { createKafkaProducer, kafkaOutboxPublisher } from '@peaket/platform/stream-worker';
import { ticketEventCodecFromEnv } from './modules/ticket/adapters/ticket-event-codec.js';

const SERVICE = 'ticket-svc';

export interface TicketRelayOptions {
  readonly database: Database;
  readonly maintenanceDatabase: Database;
  readonly publisher: OutboxPublisher;
  readonly leaseApi: LeaseApi;
  readonly env?: Record<string, string | undefined>;
  readonly clock?: Clock;
}

/** 아웃박스 릴레이 프로세스를 시작한다(리더 하나가 행을 Kafka로 낸다). 종료는 반환된 stop()이 한다 */
export function startTicketRelay(o: TicketRelayOptions): Promise<OutboxRelayProcess> {
  return startOutboxRelayProcess({
    service: SERVICE,
    ...(o.env === undefined ? {} : { env: o.env }),
    database: o.database,
    maintenanceDatabase: o.maintenanceDatabase,
    publisher: o.publisher,
    leaseApi: o.leaseApi,
    clock: o.clock ?? systemClock,
  });
}

/** 운영·로컬 진입점에서 Kafka 발행기와 Lease를 만든다(시험은 가짜를 startTicketRelay에 넣는다) */
export function ticketRelayPublisher(env: Record<string, string | undefined>): { publisher: OutboxPublisher; leaseApi: LeaseApi; stop(): Promise<void> } {
  const config = loadOutboxRelayProcessConfig(SERVICE, env);
  const producer = createKafkaProducer({
    kind: 'outbox-relay',
    brokers: config.kafkaBrokers,
    clientId: `${SERVICE}-${env.PEAKET_ENV ?? 'local'}-${config.pod}`,
    auth: kafkaAuthFromEnv(`${SERVICE}-outbox-relay`),
  });
  return {
    publisher: kafkaOutboxPublisher(producer),
    leaseApi: inClusterLeaseApi(config.leaseName),
    stop: async () => producer.disconnect(),
  };
}

/** start·relay가 같이 쓰는 Avro 코덱(문자열 이름은 배선 시험이 본다: createAvroEncoder·readSchemaIdsFile·ticketEventCodec) */
export function ticketRelayEventCodec(env: Record<string, string | undefined>) {
  return ticketEventCodecFromEnv(env);
}
