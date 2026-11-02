// 주문 v0 포트: 저장소(PostgreSQL)와 다른 모듈의 공개 함수(좌석 판매·결제·발권).
import type { NewOrder, OrderRecord, OrderStatus } from './booking.js';

export const ORDER_STORE = Symbol.for('peaket.v0.booking.store');
export const SEAT_SALES = Symbol.for('peaket.v0.booking.seatSales');
export const PAYMENTS = Symbol.for('peaket.v0.booking.payments');
export const TICKETS = Symbol.for('peaket.v0.booking.tickets');

/** 결제 확정 ①(§13 동작 2): 주문을 잠그고 CREATED·금액이 맞으면 PAYING으로 바꾼다 */
export type StartPaymentResult =
  | { kind: 'paying'; order: OrderRecord }
  | { kind: 'order-not-found' }
  | { kind: 'order-not-payable' }
  | { kind: 'amount-mismatch' }
  | { kind: 'busy' };

export interface OrderStore {
  /** 그 회차의 등급별 가격(없는 등급은 빠진다) */
  prices(eventId: string, grades: string[]): Promise<Map<string, number>>;
  /** 주문 행·주문 좌석 행·이력 첫 행(CREATED)을 트랜잭션 하나로 넣는다. 그 홀드의 주문이 이미 있으면 order-already-exists */
  create(o: NewOrder): Promise<'created' | 'order-already-exists'>;
  /** 그 계정의 주문(남의 주문·없는 주문은 null) */
  find(orderId: string, accountId: string): Promise<OrderRecord | null>;
  startPayment(orderId: string, accountId: string, amount: number, nowMs: number): Promise<StartPaymentResult>;
  /** 상태가 from일 때만 to로 바꾸고 이력을 덧붙인다. 바꿨으면 true */
  transition(orderId: string, from: OrderStatus, to: OrderStatus, reason: string, nowMs: number): Promise<boolean>;
  /** APPROVED 주문의 좌석에 티켓 ID를 적고 CONFIRMED로 바꾼다(이력 포함). 바꿨으면 true */
  confirm(orderId: string, tickets: { seatId: string; ticketId: string }[], nowMs: number): Promise<boolean>;
  /** 가격을 넣는다(있으면 바꾼다) */
  setPrices(eventId: string, prices: Map<string, number>): Promise<void>;
}
