// 결제 사건 값의 JSON 대역(Avro 인코더 BAS-030이 오기 전, purchase-svc order-events.ts와 같은 방식, BUILD_ORDER PRF-181).
// 값은 UTF-8 JSON 바이트이고, purchase-svc 결과 반영 처리기(payment-result.handler.ts)가 같은 모양을 읽는다.
import type { PaymentEventCodec } from '../domain/ports.js';

/** trade.payments 주제 이름(키는 asyncapi대로 회차 ID) */
export const TRADE_PAYMENTS_TOPIC = 'trade.payments';

/** 값을 UTF-8 JSON 바이트로 만든다 */
export const jsonPaymentEventCodec: PaymentEventCodec = {
  encode: (message) => Buffer.from(JSON.stringify(message), 'utf8'),
};
