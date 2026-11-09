// 결제 화면 행동 신호 보내기(telemetry.behavior, asyncapi BehaviorSignal screen PAYMENT, docs/features/payment.md §2 '결제 화면 행동 요약', BUILD_ORDER PRF-191).
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

/** Avro 인코더(BAS-030)가 오기 전의 JSON 대역(주문 사건 jsonOrderEventCodec과 같은 방식). 키는 pid다(asyncapi telemetry.behavior) */
export class KafkaBehaviorSignals implements BehaviorSignalPublisher {
  constructor(private readonly producer: BehaviorSignalProducer) {}

  async publish(message: BehaviorSignalMessage): Promise<void> {
    await this.producer.send({ topic: TELEMETRY_BEHAVIOR_TOPIC, messages: [{ key: message.pid, value: Buffer.from(JSON.stringify(message), 'utf8') }] });
  }
}
