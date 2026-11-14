// 우선 구매 권리(purchase DB priority_grant, POL-046 ⑦, ADR-0171, docs/features/seat-hold.md §5).
// 부정 예매 표 취소의 이의가 인정된 계정에 ops-svc가 GrantPriorityPurchase로 만든다.
// 표를 무상으로 되살리지 않고, 같은 좌석(아직 팔리지 않았을 때)이나 같은 등급의 남은 좌석을 원래 가격으로 48시간 [가정] 안에 다시 살 기회를 준다.
export type PriorityGrantKind = 'SAME_SEAT' | 'SAME_TIER';
export type PriorityGrantStatus = 'OFFERED' | 'USED' | 'EXPIRED' | 'WITHDRAWN';
export type PriorityGrantResult = 'SAME_SEAT' | 'SAME_TIER' | 'NO_SEAT' | 'ENTRY_STARTED';

export const PRIORITY_GRANT_KINDS = ['SAME_SEAT', 'SAME_TIER'] as const;
export const PRIORITY_GRANT_STATUSES = ['OFFERED', 'USED', 'EXPIRED', 'WITHDRAWN'] as const;

/** 48시간 [가정](ADR-0171). 입장 시작이 더 이르면 그때까지다 */
export const PRIORITY_GRANT_TTL_MS = 48 * 60 * 60 * 1000;

export interface PriorityGrant {
  readonly grantId: string;
  readonly eventId: string;
  readonly accountId: string;
  readonly fraudCaseId: string;
  readonly cancelledTicketId: string;
  readonly grantKind: PriorityGrantKind;
  readonly seatId: string;
  readonly tierId: string;
  readonly price: number;
  readonly status: PriorityGrantStatus;
  readonly expiresAtMs: number;
  readonly activeOrderId?: string;
  readonly usedOrderId?: string;
  /** queue-svc `q:prio` 사본의 판 번호. 만들 때 1, 회수할 때 1 올린다 */
  readonly version: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface NewPriorityGrant {
  readonly grantId: string;
  readonly eventId: string;
  readonly accountId: string;
  readonly fraudCaseId: string;
  readonly cancelledTicketId: string;
  readonly grantKind: PriorityGrantKind;
  readonly seatId: string;
  readonly tierId: string;
  readonly price: number;
  readonly expiresAtMs: number;
  readonly nowMs: number;
}

/** 우선 구매 권리가 지금 주문에 쓸 수 있는가: OFFERED, 만료 전, 진행 중 주문 없음 */
export function priorityGrantUsable(g: PriorityGrant | undefined, nowMs: number): g is PriorityGrant {
  return g !== undefined && g.status === 'OFFERED' && nowMs < g.expiresAtMs && g.activeOrderId === undefined;
}

/** 취소한 표의 원래 좌석·등급·가격. purchase DB order_item·order_cancellation에서 읽는다 */
export interface CancelledTicketView {
  readonly eventId: string;
  readonly accountId: string;
  readonly orderId: string;
  readonly seatId: string;
  readonly tierId: string;
  readonly price: number;
  /** 그 회차 입장 시작 시각(있으면 48시간과 이른 쪽) */
  readonly entryStartsAtMs?: number;
}
