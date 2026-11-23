// 관제 1초 대기 집계의 시작 조립(F-04-20). start.ts는 세 줄만 쓴다: 만들기(앱 모듈 전에), 붙이기(서비스가 생긴 뒤), 닫기(종료 때).
// - 세기 객체(QueueAggregator)는 앱 모듈보다 먼저 만들어 진입·입장 확정 모듈에 넘긴다(세기는 동기·던지지 않음·I/O 없음)
// - 텔레메트리 Kafka(PEAKET_TELEMETRY_KAFKA_BROKERS)가 꺼져 있거나 Kafka 클라이언트를 싣지 못하면 경고 한 줄 뒤 칸을 내지 않고 버린 수로 센다.
//   어느 경우에도 시작을 막지 않는다(관측은 업무 경로를 막지 않는다). 계약 판 인코더 설정(schema-ids)은 이 주제가 있어야 만든다
import { avroSchemas } from '@peaket/contracts/avro';
import { type PlatformService, type KafkaTelemetrySender, kafkaTelemetrySend, systemClock, telemetryDroppedCounter, telemetryKafkaFromEnv, TelemetrySink } from '@peaket/platform';
import { createAvroEncoder, readSchemaIdsFile } from '@peaket/platform/avro';
import { QUEUE_AGGREGATE_RECORD, QueueAggregator, TELEMETRY_QUEUE_TOPIC } from './queue-aggregate.js';

const DROPPED_RECORD = 'QueueAggregate';
/** 종료 때 남은 칸을 보내는 상한 [가정](purchase-svc 텔레메트리 닫기와 같다) */
const CLOSE_MS = 2_000;

export interface QueueAggregateWiring {
  readonly counts: QueueAggregator;
  attach(service: Pick<PlatformService, 'logger' | 'metrics'>): Promise<void>;
  close(): Promise<void>;
}

export function queueAggregateWiring(serviceName: string, env: Record<string, string | undefined>, pod: string): QueueAggregateWiring {
  let offer: (topic: string, m: { key: string; value: Buffer }) => void = () => undefined;
  let dropped: (n: number) => void = () => undefined;
  let encode: (m: Record<string, unknown>) => Buffer = () => {
    throw new Error('인코더 없음');
  };
  let sink: TelemetrySink | undefined;
  let sender: KafkaTelemetrySender | undefined;
  const counts = new QueueAggregator({ pod, now: () => systemClock.now(), encode: (m) => encode(m), offer: (t, m) => offer(t, m), dropped: (n) => dropped(n) });
  return {
    counts,
    async attach(service) {
      const count = telemetryDroppedCounter(service.metrics.registry);
      dropped = (n) => count(DROPPED_RECORD, n);
      const kafka = telemetryKafkaFromEnv(serviceName, env);
      counts.start();
      if (!kafka.enabled) {
        service.logger.warn({ dep: 'telemetry-kafka' }, `${kafka.warning}(관제 1초 대기 집계도 내지 않고 버린 수로 센다)`);
        return;
      }
      try {
        const encoder = createAvroEncoder({ schemaIds: readSchemaIdsFile(env), schemas: avroSchemas, produces: [{ topic: TELEMETRY_QUEUE_TOPIC, record: QUEUE_AGGREGATE_RECORD }] });
        const { createKafkaProducer } = await import('@peaket/platform/stream-worker');
        const { brokers, auth, env: kafkaEnv } = kafka;
        sender = kafkaTelemetrySend(() => createKafkaProducer({ kind: 'default', brokers, clientId: `${serviceName}-${kafkaEnv}-${pod}`, auth }));
        const s = new TelemetrySink({ send: sender, onDropped: count });
        sink = s;
        encode = (m) => encoder.encode(TELEMETRY_QUEUE_TOPIC, QUEUE_AGGREGATE_RECORD, m);
        offer = (topic, m) => s.offer(DROPPED_RECORD, topic, m);
      } catch (err) {
        service.logger.warn({ dep: 'telemetry-kafka', err: err instanceof Error ? err.message : String(err) }, '관제 1초 대기 집계를 내지 못해 버린 수로 센다');
      }
    },
    async close() {
      counts.stop();
      await sink?.close(CLOSE_MS);
      await sender?.disconnect(CLOSE_MS);
    },
  };
}
