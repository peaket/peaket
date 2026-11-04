// 주문 사건 값의 JSON 대역(Avro 인코더 BAS-030이 오기 전, 좌석 사건 jsonTradeEventCodec과 같은 방식). 값은 UTF-8 JSON 바이트다(BUILD_ORDER PRF-160).
import type { OrderEventCodec } from '../domain/ports.js';

/** trade.orders 주제 이름 */
export const TRADE_ORDERS_TOPIC = 'trade.orders';

export const jsonOrderEventCodec: OrderEventCodec = {
  encode: (message) => Buffer.from(JSON.stringify(message), 'utf8'),
};
