// 결제 화면 행동 신호 보내기(telemetry.behavior, asyncapi BehaviorSignal screen PAYMENT, docs/features/payment.md §2 '결제 화면 행동 요약', BUILD_ORDER PRF-191).
import { AvroEncodeError, type AvroEncoder } from '@peaket/platform/avro';
import type { BehaviorSignalMessage, BehaviorSignalPublisher } from '../domain/ports.js';

/** 토픽 이름(asyncapi) */
export const TELEMETRY_BEHAVIOR_TOPIC = 'telemetry.behavior';

/** Kafka 생산자가 없을 때(local·ci)의 대역: 버린다 */
export const discardBehaviorSignals: BehaviorSignalPublisher = {
  publish: async () => {},
};

/** Kafka 생산자의 send 모양(네이티브 모듈을 싣지 않으려고 모양만 받는다) */
export interface BehaviorSignalProducer {
  send(record: { topic: string; messages: { key: string; value: Buffer }[] }): Promise<unknown>;
}

/** 행동 신호의 레코드 전체 이름(docs/api/avro/peaket/telemetry/BehaviorSignal.avsc) */
export const BEHAVIOR_SIGNAL_RECORD = 'peaket.telemetry.BehaviorSignal';

/**
 * 값은 공용 Avro 인코더로 만든 Confluent 형식 바이트다(ADR-0357 결정 3·9). 키는 pid다(asyncapi telemetry.behavior).
 * 만들지 못하면 경고 한 줄(레코드·칸 이름만)을 남기고 던진다. 부르는 쓰임새가 telemetry_dropped_total로 세고 삼킨다(ADR-0357 결정 8)
 */
export class KafkaBehaviorSignals implements BehaviorSignalPublisher {
  constructor(
    private readonly producer: BehaviorSignalProducer,
    private readonly encoder: AvroEncoder,
    private readonly logger?: { warn(obj: object, msg?: string): void },
  ) {}

  async publish(message: BehaviorSignalMessage): Promise<void> {
    let value: Buffer;
    try {
      value = this.encoder.encode(TELEMETRY_BEHAVIOR_TOPIC, BEHAVIOR_SIGNAL_RECORD, message);
    } catch (err) {
      if (err instanceof AvroEncodeError) this.logger?.warn({ kind: 'telemetry-encode-failed', record: err.record, fields: [...err.fields] }, '행동 신호를 Avro로 만들지 못해 버린다');
      throw err;
    }
    await this.producer.send({ topic: TELEMETRY_BEHAVIOR_TOPIC, messages: [{ key: message.pid, value }] });
  }
}
