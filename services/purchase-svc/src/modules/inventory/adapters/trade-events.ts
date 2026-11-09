// 거래 토픽 보내기의 어댑터 둘(BUILD_ORDER PRF-141).
// - jsonTradeEventCodec: Avro 인코더(BAS-030)가 오기 전의 JSON 대역. 값은 UTF-8 JSON 바이트다(받는 쪽 대역 jsonPurchaseSessionCodec과 짝)
// - KafkaTradeEventPublisher: platform stream-worker의 Kafka 생산자로 보낸다. 준 차례대로, 같은 토픽끼리 send 한 번
import type { KafkaProducer } from '@peaket/platform/stream-worker';
import type { TradeEventCodec, TradeEventPublisher, TradeRecord } from '../domain/ports.js';

export const jsonTradeEventCodec: TradeEventCodec = {
  encode: (_topic, message) => Buffer.from(JSON.stringify(message), 'utf8'),
};

export class KafkaTradeEventPublisher implements TradeEventPublisher {
  constructor(private readonly producer: Pick<KafkaProducer, 'send'>) {}

  async publish(records: TradeRecord[]): Promise<void> {
    let i = 0;
    while (i < records.length) {
      const topic = records[i]!.topic;
      const messages: { key: string; value: Buffer; headers: Record<string, string> }[] = [];
      while (i < records.length && records[i]!.topic === topic) {
        const r = records[i++]!;
        messages.push({ key: r.key, value: r.value, headers: r.headers });
      }
      await this.producer.send({ topic, messages });
    }
  }
}
