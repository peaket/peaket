// 우선 구매 권리의 대기열 사본 값·키 규칙(queue.proto PriorityGrantService, docs/data.md `q:prio`, ADR-0171).
// ops-svc가 보낸 판 번호가 저장한 판보다 클 때만 바꾼다. 수명은 권리 만료와 같고, WITHDRAWN도 만료 전까지 남겨 404 근거로 쓴다.
export type PriorityGrantState = 'OFFERED' | 'WITHDRAWN';

export interface PriorityGrantCopy {
  readonly grantId: string;
  readonly state: PriorityGrantState;
  readonly expiresAtMs: number;
  readonly version: number;
}

export interface PriorityGrantSetInput {
  readonly accountId: string;
  readonly eventId: string;
  readonly grantId: string;
  readonly state: PriorityGrantState;
  readonly expiresAtMs: number;
  readonly version: number;
  /** 메모리 저장소가 만료를 판정할 때 쓴다(Redis는 TIME을 쓴다) */
  readonly nowMs: number;
}

/** Redis 키 조각 모양(입장 확정 받는 층과 같다) */
export const PRIORITY_GRANT_KEY_PART = /^[A-Za-z0-9_-]{1,64}$/;
/** purchase DB priority_grant.id(UUID) */
export const PRIORITY_GRANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** docs/data.md `q:prio:{account}:E`. 계정마다 한 사본이라 회차 해시 태그를 붙이지 않는다 */
export const priorityGrantKeyOf = (accountId: string, eventId: string): string => `q:prio:${accountId}:${eventId}`;

/** 지금 쓸 수 있는 사본인가: 같은 권리 ID, OFFERED, 만료 전 */
export function priorityGrantUsable(copy: PriorityGrantCopy | undefined, grantId: string, nowMs: number): copy is PriorityGrantCopy {
  return copy !== undefined && copy.grantId === grantId && copy.state === 'OFFERED' && nowMs < copy.expiresAtMs;
}
