// 결제 시도 시작의 값과 규칙(docs/features/payment.md §2 '결제 시도 시작의 첫 구현', BUILD_ORDER PRF-191, 명세 specs/payment.qnt `newAttempt`).
// 프레임워크·저장소를 모른다. 포트는 ports.ts에 있다.
import { uuid8 } from './order.js';
import type { BehaviorSignalMessage, BehaviorSummary, CheckoutValues } from './ports.js';

/** 멱등 작업 이름(order_idempotency의 operation, 범위 = 계정 × 이 작업, guidelines §4) */
export const START_PAYMENT_OPERATION = 'START_PAYMENT';
/** 주문 하나의 결제 시도 상한 3회 [가정](payment §4.2 7, 시도 행 수로 잰다. 4번째부터 409 payment-attempts-exceeded) */
export const PAYMENT_ATTEMPTS_MAX = 3;
/** 판 파일에 주문명이 없을 때의 고정 문구 [가정] */
export const DEFAULT_ORDER_NAME = '공연 티켓';
/** PrepareCheckout 데드라인 상한 300ms [가정](guidelines §5) */
export const PREPARE_CHECKOUT_DEADLINE_MS = 300;
/** PrepareCheckout을 부르기 전에 남아 있어야 하는 시간 50ms [가정](payment-svc가 이보다 짧으면 시작하지 않는다) */
export const PREPARE_CHECKOUT_MIN_REMAINING_MS = 50;
/** 본문 payMethod의 허용 목록(payment-svc PAY_METHODS와 같은 값) */
export const START_PAY_METHODS = ['CARD', 'EASY_PAY', 'TRANSFER', 'VIRTUAL_ACCOUNT', 'MOBILE'] as const;
export type StartPayMethod = (typeof START_PAY_METHODS)[number];

/** 결제 시도에 저장할 결제사 참조(payment_attempt.pg_order_ref): 토스·시뮬레이터는 orderId, 포트원은 paymentId */
export function pgOrderRefOf(checkout: CheckoutValues): string {
  return checkout.shape === 'TOSS' ? checkout.orderId : checkout.paymentId;
}

/** 행동 신호 eventKey: UUID 버전 8(SHA-256('BehaviorSignal:PAYMENT:' + 주문 ID)의 앞 16바이트). 같은 주문의 첫 시도는 하나라 다시 내도 같은 값이다 */
export function behaviorSignalKey(orderId: string): string {
  return uuid8(`BehaviorSignal:PAYMENT:${orderId}`);
}

/**
 * 결제 화면 행동 신호(asyncapi BehaviorSignal, screen PAYMENT). 망 정보(netClass·asn)와 기기 가명(deviceRef)은 싣지 않는다
 * (purchase-svc는 망 정보를 모르고, 기기 가명은 trust-svc·identity-svc만 계산한다, ADR-0171 결정 4).
 * @throws RangeError occurredAtMs가 날짜 범위 밖
 */
export function buildBehaviorSignal(input: { readonly orderId: string; readonly eventId: string; readonly pid: string; readonly journeyId: string; readonly features: BehaviorSummary; readonly occurredAtMs: number }): BehaviorSignalMessage {
  return {
    pid: input.pid,
    refMissing: false,
    eventId: input.eventId,
    journeyId: input.journeyId,
    screen: 'PAYMENT',
    features: input.features,
    ts: new Date(input.occurredAtMs).toISOString(),
    eventKey: behaviorSignalKey(input.orderId),
  };
}
