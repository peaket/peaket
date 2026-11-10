// 판매 정책 평가(ADR-0261 결정 3, docs/features/seat-hold.md §4 '판매 정책 규칙의 한도'). 홀드 때 purchase-svc가, 미리보기 때 화면이 같은 함수를 쓴다.
import { applies, outcomes } from './conditions.js';
import type { DenyReason, SalePolicyRule } from './schema.js';

export interface SaleFacts {
  /** 서버 지금 */
  at: Date;
  /** 회차 ID */
  round: string;
  /** 잡으려는 좌석의 등급 ID */
  grade: string;
  /** 이번 요청 매수 */
  quantity: number;
  /** 구매자가 든 판매 자격 명단 키(입장 토큰의 lst) */
  lists: readonly string[];
}

export type SaleDecision = { allowed: false; reason: DenyReason } | { allowed: true; limit: number };

/**
 * 걸리는 규칙의 결과를 합친다: 거부가 한도보다 앞서고(사유는 규칙 차례로 먼저 거부한 것), 한도끼리는 작은 값이며, allow는 한도를 바꾸지 않는다.
 * 걸리는 규칙이 없거나 모두 allow면 회차 1인 한도다. 돌려주는 한도는 회차 1인 한도를 넘지 않는다
 */
export function evaluateSalePolicy(rules: readonly SalePolicyRule[], facts: SaleFacts, roundLimit: number): SaleDecision {
  const at = facts.at.getTime();
  let limit = roundLimit;
  let denied: DenyReason | undefined;
  for (const r of rules) {
    if (!applies(r, facts.round, at)) continue;
    // 사실을 다 알므로 결과는 하나다
    const [o] = outcomes(r, { round: facts.round, lists: facts.lists, grade: facts.grade, quantity: facts.quantity });
    if (!o) continue;
    if ('deny' in o) denied ??= o.deny;
    else if ('limitPerPerson' in o) limit = Math.min(limit, o.limitPerPerson);
  }
  return denied !== undefined ? { allowed: false, reason: denied } : { allowed: true, limit };
}
