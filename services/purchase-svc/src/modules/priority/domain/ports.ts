// 우선 구매 모듈의 포트(도메인은 DB·Redis·HTTP를 모른다).
import type { SeatRef } from '../../inventory/index.js';
import type { CancelledTicketView, NewPriorityGrant, PriorityGrant } from './priority-grant.js';

export interface PriorityGrantStore {
  /** 취소한 표 하나에 권리 하나(UNIQUE). 같은 표로 다시 오면 처음 결과를 돌려준다 */
  findByCancelledTicket(cancelledTicketId: string): Promise<PriorityGrant | undefined>;
  find(grantId: string): Promise<PriorityGrant | undefined>;
  create(input: NewPriorityGrant): Promise<PriorityGrant>;
  /** 진행 중 주문을 적는다. OFFERED·활성 주문 없음일 때만 true */
  beginOrder(grantId: string, orderId: string, nowMs: number): Promise<boolean>;
  /** 결제 완료. USED·used_order_id를 적고 active_order_id를 비운다 */
  markUsed(grantId: string, orderId: string, nowMs: number): Promise<PriorityGrant | undefined>;
  /** 회수. OFFERED를 WITHDRAWN으로 바꾸고 판 번호를 올린다 */
  withdraw(grantId: string, nowMs: number): Promise<PriorityGrant | undefined>;
}

/** 취소한 표의 좌석·등급·가격을 읽는 포트(purchase DB order_item·order_cancellation·event 일정) */
export interface CancelledTickets {
  /** 그 취소표가 그 부정 예매 사건의 것일 때만 돌려준다(다른 사유의 취소에 우선 구매를 주지 않는다) */
  find(cancelledTicketId: string, fraudCaseId: string): Promise<CancelledTicketView | undefined>;
}

/** 우선 구매 보류를 잡는 포트. inventory의 SeatStore가 구현한다 */
export interface PrioritySeatHolds {
  holdPriority(input: { eventId: string; accountId: string; grantId: string; seat: SeatRef; expiresAtMs: number; keepUntilMs: number }): Promise<
    | { kind: 'OK'; seatId: string; fencingToken: number; heldAtMs: number; expiresAtMs: number }
    | { kind: 'CONFLICT'; seatId: string }
    | { kind: 'NOT_READY' }
    | { kind: 'EXPIRED' }
  >;
}

/** 같은 등급의 남은 좌석 후보를 찾는 포트. inventory의 SeatMapTiers·SeatMapIndex가 구현한다 */
export interface PrioritySeatCandidates {
  sameTier(eventId: string, tierId: string): Promise<readonly SeatRef[]>;
}

export interface PriorityGrantLogger {
  grantFailed(input: { eventId: string; cancelledTicketId: string; reason: string }): void;
}
