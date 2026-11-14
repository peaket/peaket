// 예매 제한 사본(queue.proto BookingRestrictionService, docs/data.md `q:rst`, docs/features/queue-admission.md §6 '예매 제한 확인').
// ops-svc가 SetBookingRestriction으로 보낸 사본을 계정마다 하나(q:rst:{account}) 둔다. 입장 확정은 ACTIVE이고 끝 시각 전이면 403 booking-restricted다.
// 칸: st(ACTIVE·LIFTED), until(끝 시각 유닉스 밀리초, 비면 끝 없음), rid(제한 ID), ver(판 번호).
export type BookingRestrictionState = 'ACTIVE' | 'LIFTED';

export interface BookingRestrictionCopy {
  readonly st: BookingRestrictionState;
  /** 끝 시각(없으면 끝 없음) */
  readonly untilMs?: number;
  /** 제한 ID(ops DB booking_restriction.id) */
  readonly rid?: string;
  /** 판 번호(계정마다 늘어나기만 한다) */
  readonly ver?: number;
}

/** ops-svc가 SetBookingRestriction으로 보내는 사본 한 판. 판 번호가 저장한 판보다 클 때만 반영한다. */
export interface BookingRestrictionApply {
  readonly accountId: string;
  readonly restrictionId: string;
  readonly state: BookingRestrictionState;
  readonly untilMs?: number;
  readonly version: number;
}

/** 계정마다 하나라 회차 해시 태그를 붙이지 않는다 */
export const bookingRestrictionKeyOf = (accountId: string): string => `q:rst:${accountId}`;

/** 지금 입장을 막는가: ACTIVE이고 until이 없거나 지금보다 뒤 */
export function bookingRestricted(r: BookingRestrictionCopy | undefined, nowMs: number): boolean {
  return r !== undefined && r.st === 'ACTIVE' && (r.untilMs === undefined || nowMs < r.untilMs);
}
