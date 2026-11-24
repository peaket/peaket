// 결제 시도·접수의 보내기(SCR-011, docs/frontend.md §5.3). 주소 `/v1/orders/{orderId}/payments`·`payment-acceptance`에는
// 회차가 없어, 팬 웹이 아는 회차 ID를 `x-peaket-event-id` 머리로 싣는다(IR-17). 게이트웨이 접근 로그가 이 머리를 `eventId`로 옮긴다.
import { OPERATIONS, type ApiResponse, type Operation } from '@peaket/api-client';
import type { PurchaseSigner } from '@peaket/api-client/purchase';

/** 결제 요청에 회차 ID를 싣는다 */
export const paymentEventHeaders = (eventId: string): Record<string, string> => ({ 'x-peaket-event-id': eventId });

interface PaymentSender {
  send<T = unknown>(op: Operation, o: { params: Record<string, string>; body: unknown; idempotencyKey: string; purchase: PurchaseSigner; headers: Record<string, string> }): Promise<ApiResponse<T>>;
}

/** 결제 시도 시작: 서버가 결제창 값을 준다 */
export function sendPaymentAttempt<T = unknown>(
  client: PaymentSender,
  i: { eventId: string; orderId: string; body: unknown; idempotencyKey: string; purchase: PurchaseSigner },
): Promise<ApiResponse<T>> {
  return client.send<T>(OPERATIONS.createOrderPayment, {
    params: { orderId: i.orderId },
    body: i.body,
    idempotencyKey: i.idempotencyKey,
    purchase: i.purchase,
    headers: paymentEventHeaders(i.eventId),
  });
}

/** 결제 접수: 결제사에서 돌아온 값을 서버에 확정한다 */
export function sendPaymentAcceptance<T = unknown>(
  client: PaymentSender,
  i: { eventId: string; orderId: string; body: unknown; idempotencyKey: string; purchase: PurchaseSigner },
): Promise<ApiResponse<T>> {
  return client.send<T>(OPERATIONS.createOrderPaymentAcceptance, {
    params: { orderId: i.orderId },
    body: i.body,
    idempotencyKey: i.idempotencyKey,
    purchase: i.purchase,
    headers: paymentEventHeaders(i.eventId),
  });
}
