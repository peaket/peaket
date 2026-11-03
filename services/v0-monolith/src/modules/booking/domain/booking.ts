// 주문 v0(docs/features/payment.md §13). 결제 확정은 동기 결제 체인이다(K7의 v0).
import type { IssuedTicket } from '../../ticket/index.js';

/** 주문 상태(§13 표). CREATED → PAYING → APPROVED → CONFIRMED, PAYING → CREATED(판매가 잠금 경합·오류로 끊김), PAYING → FAILED */
export const ORDER_STATUSES = ['CREATED', 'PAYING', 'APPROVED', 'CONFIRMED', 'FAILED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** 좌석 등급별 가격 범위(원, §13 동작 4) */
export const MIN_PRICE = 1;
export const MAX_PRICE = 100_000_000;
/** 좌석 등급 이름(좌석 v0의 등급 칸과 같은 규칙: 제어 문자 없는 1~30자) */
export const GRADE_PATTERN = /^[^\p{Cc}\p{Cf}]{1,30}$/u;
/** 결제사 결제 참조(출력 가능한 ASCII 1~200자, §13 동작 2) */
export const PAYMENT_KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;
/** 판정마다 트랜잭션의 문장 시간 상한(좌석 v0와 같다) */
export const STATEMENT_TIMEOUT_MS = 1_000;

/** 결제사에 보낼 주문 이름(시뮬레이터 상한 100자 안). 회차 ID와 좌석 수로 만든다 */
export function orderNameOf(eventId: string, seatCount: number): string {
  return `${eventId} 좌석 ${seatCount}석`;
}

/** 저장소가 주는 주문(시각은 유닉스 밀리초) */
export interface OrderRecord {
  orderId: string;
  eventId: string;
  accountId: string;
  holdId: string;
  status: OrderStatus;
  amount: number;
  orderName: string;
  seatIds: string[];
  createdAtMs: number;
}

/** 주문 응답(§13 동작 1·3). 시각은 KST ISO */
export interface OrderView {
  orderId: string;
  eventId: string;
  holdId: string;
  status: OrderStatus;
  amount: number;
  orderName: string;
  seatIds: string[];
  createdAt: string;
  tickets: IssuedTicket[];
}

/** 새 주문(주문 행·주문 좌석 행·이력 첫 행 CREATED) */
export interface NewOrder {
  orderId: string;
  eventId: string;
  accountId: string;
  holdId: string;
  amount: number;
  orderName: string;
  items: { seatId: string; grade: string; price: number }[];
  nowMs: number;
}
