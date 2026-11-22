// 주문 사건 값의 코덱(ADR-0357 결정 3·8·9, docs/api/avro/README.md §3 '생산자 스키마 ID'·'Outbox 릴레이', F-04-2).
// 운영 조립(start.ts·relay-app.ts)은 공용 Avro 인코더(@peaket/platform/avro)로 만든 Confluent 형식 바이트를 Outbox payload에 넣는다.
// 인코딩 오류(AvroEncodeError)는 삼키지 않고 던져 그 업무 트랜잭션을 실패시킨다(주문이 생기지 않는다, ADR-0150 결정 5).
// JSON 대역(jsonOrderEventCodec)은 저장소 어댑터의 기본값으로만 남는다(코덱을 주지 않는 시험 조립). 운영 조립은 늘 Avro 코덱을 준다.
import type { AvroEncoder } from '@peaket/platform/avro';
import type { OrderEventCodec } from '../domain/ports.js';

/** trade.orders 주제 이름 */
export const TRADE_ORDERS_TOPIC = 'trade.orders';
/** 주문 사건의 레코드 전체 이름(docs/api/avro/peaket/trade/OrderEvent.avsc) */
export const ORDER_EVENT_RECORD = 'peaket.trade.OrderEvent';

/** 시험 조립의 JSON 대역(UTF-8 JSON 바이트). 운영 조립은 avroOrderEventCodec을 준다 */
export const jsonOrderEventCodec: OrderEventCodec = {
  encode: (message) => Buffer.from(JSON.stringify(message), 'utf8'),
};

/** asyncapi 모양의 주문 사건을 받는 코덱(회차 환급 팬 알림처럼 OrderEventMessage 밖에서 만든 같은 모양의 값도 받는다) */
export interface AvroOrderEventCodec extends OrderEventCodec {
  encode(message: object): Buffer;
}

/**
 * 공용 Avro 인코더로 trade.orders 값을 만든다. 인코더는 trade.orders의 OrderEvent 주제를 받아 만든 것이어야 한다.
 * @throws AvroEncodeError(encode) 계약을 채우지 못한 사건(그 트랜잭션을 실패시킨다)
 */
export function avroOrderEventCodec(encoder: AvroEncoder): AvroOrderEventCodec {
  return { encode: (message: object) => encoder.encode(TRADE_ORDERS_TOPIC, ORDER_EVENT_RECORD, message) };
}
