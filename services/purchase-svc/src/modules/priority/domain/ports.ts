// 우선 구매 모듈의 포트(도메인은 DB·Redis·HTTP를 모른다).
import type { SeatRef } from '../../inventory/index.js';
import type { CancelledTicketView, NewPriorityGrant, PriorityGrant, PriorityGrantStatus } from './priority-grant.js';

/** queue-svc가 계약 밖 상태·모양을 거절했을 때(INVALID_ARGUMENT). 대조는 같은 값을 다시 보내지 않는다 */
export class InvalidPriorityGrantState extends Error {
  constructor(readonly detail: string) {
    super(`우선 구매 권리 사본 요청이 계약과 다르다: ${detail}`);
    this.name = 'InvalidPriorityGrantState';
  }
}

export type PriorityGrantSyncResult = 'ok' | 'failed' | 'invalid';
export type PriorityGrantExpireResult = 'ok' | 'failed';

/** 대조 틱의 결과를 세는 포트(어댑터의 Prom 구현이 받는다). 어댑터가 유스케이스를 가져오지 않게 포트에 둔다 */
export interface PriorityGrantSyncSignals {
  sync(result: PriorityGrantSyncResult): void;
  expire(result: PriorityGrantExpireResult): void;
}

/** queue-svc PriorityGrantService.SetPriorityGrant(ADR-0385). purchase-svc의 상태 대조가 쓴다 */
export interface QueuePriorityGrants {
  set(input: {
    readonly accountId: string;
    readonly eventId: string;
    readonly grantId: string;
    readonly state: PriorityGrantStatus;
    readonly expiresAtMs: number;
    readonly version: number;
  }): Promise<{ readonly changed: boolean }>;
}

export interface PriorityGrantStore {
  /** 취소한 표 하나에 권리 하나(UNIQUE). 같은 표로 다시 오면 처음 결과를 돌려준다 */
  findByCancelledTicket(cancelledTicketId: string): Promise<PriorityGrant | undefined>;
  find(grantId: string): Promise<PriorityGrant | undefined>;
  create(input: NewPriorityGrant): Promise<PriorityGrant>;
  /** 진행 중 주문을 적는다. OFFERED·활성 주문 없음일 때만 true */
  beginOrder(grantId: string, orderId: string, nowMs: number): Promise<boolean>;
  /** 결제 완료. USED·used_order_id를 적고 active_order_id를 비운다 */
  markUsed(grantId: string, orderId: string, nowMs: number): Promise<PriorityGrant | undefined>;
  /** 회수. OFFERED를 WITHDRAWN으로 바꾸고 판 번호를 올린다. 진행 중 주문이 있으면 바꾸지 않는다 */
  withdraw(grantId: string, actedBy: string, nowMs: number): Promise<PriorityGrant | undefined>;
  /** 기한이 지난 OFFERED를 EXPIRED로 바꾸고 판 번호를 올린다(만료 회수, 보상 건 없음) */
  expire(grantId: string, nowMs: number): Promise<PriorityGrant | undefined>;
  /** 결제 실패로 진행 중 주문 표시를 비운다. OFFERED이고 active_order_id가 그 주문일 때만 */
  releaseOrder(grantId: string, orderId: string, nowMs: number): Promise<boolean>;
  /** 기한 지난 OFFERED(진행 중 주문 없음)를 EXPIRED로 바꾸고 바뀐 행을 돌려준다(대조 틱, ADR-0385) */
  expireDue(nowMs: number, limit: number): Promise<readonly PriorityGrant[]>;
  /** expires_at > now이고 상태가 OFFERED·USED·WITHDRAWN인 행(대조 틱, ADR-0385) */
  listSyncable(nowMs: number, limit: number): Promise<readonly PriorityGrant[]>;
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
  /** 회수·만료 때 좌석을 바로 돌려준다(권리 만료까지 좌석이 남지 않게) */
  releasePriority(input: { eventId: string; accountId: string; grantId: string; seat: SeatRef; keepUntilMs: number }): Promise<
    { kind: 'OK' } | { kind: 'NOT_FOUND' } | { kind: 'NOT_READY' } | { kind: 'IN_USE' }
  >;
}

/** 활성 판매 행(seat_sale PENDING·SOLD)을 보는 포트. purchase DB가 구현한다 */
export interface PrioritySeatSales {
  /** 그 좌석들 가운데 지금 팔렸거나 결제 중인 좌석 ID */
  active(eventId: string, seatIds: readonly string[]): Promise<ReadonlySet<string>>;
}

/** 같은 등급의 남은 좌석 후보를 찾는 포트. inventory의 SeatMapTiers·SeatMapIndex가 구현한다 */
export interface PrioritySeatCandidates {
  sameTier(eventId: string, tierId: string): Promise<readonly SeatRef[]>;
}

export interface PriorityGrantLogger {
  grantFailed(input: { eventId: string; cancelledTicketId: string; reason: string }): void;
}
