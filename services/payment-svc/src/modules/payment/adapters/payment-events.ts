// 결제 사건 값의 JSON 대역(Avro 인코더 BAS-030이 오기 전, purchase-svc order-events.ts와 같은 방식, BUILD_ORDER PRF-181).
// 값은 UTF-8 JSON 바이트이고, purchase-svc 결과 반영 처리기(payment-result.handler.ts)가 같은 모양을 읽는다.
// 굿즈 결제(orderKind MERCH)는 회차가 없다(eventId null, ADR-0299 결정 4). JSON에서는 다른 조건부 칸처럼 칸을 빼고 싣는다(계약 zod가 null을 받지 않는다).
import type { PaymentEventCodec } from '../domain/ports.js';

/** trade.payments 주제 이름(키는 asyncapi대로 티켓은 회차 ID, 굿즈는 주문 ID, domain/confirm-runner.ts paymentEventKafkaKey) */
export const TRADE_PAYMENTS_TOPIC = 'trade.payments';

/** 값을 UTF-8 JSON 바이트로 만든다. eventId가 null이면 칸을 뺀다 */
export const jsonPaymentEventCodec: PaymentEventCodec = {
  encode: (message) => {
    if (message.eventId !== null) return Buffer.from(JSON.stringify(message), 'utf8');
    const { eventId: _eventId, ...rest } = message;
    return Buffer.from(JSON.stringify(rest), 'utf8');
  },
};
