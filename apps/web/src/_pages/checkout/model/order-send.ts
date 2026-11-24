// 주문 생성 보내기(SCR-011, docs/features/payment.md §2, openapi createOrder). `/v1/orders`에는 주소에 회차가 없어,
// 결제 화면이 아는 회차 ID를 `x-peaket-event-id`로 싣는다(IR-24). 게이트웨이 접근 로그가 이 머리를 `eventId`로 옮긴다.
import { OPERATIONS, type ApiResponse, type Operation } from '@peaket/api-client';
import type { PurchaseSigner } from '@peaket/api-client/purchase';
import { eventIdHeaders } from '../../../shared/lib/event-id';

interface OrderSender {
  send<T = unknown>(op: Operation, o: { body: unknown; idempotencyKey: string; purchase: PurchaseSigner; headers: Record<string, string> }): Promise<ApiResponse<T>>;
}

export function sendOrder<T = unknown>(client: OrderSender, i: { eventId: string; body: unknown; idempotencyKey: string; purchase: PurchaseSigner }): Promise<ApiResponse<T>> {
  return client.send<T>(OPERATIONS.createOrder, {
    body: i.body,
    idempotencyKey: i.idempotencyKey,
    purchase: i.purchase,
    headers: eventIdHeaders(i.eventId),
  });
}
