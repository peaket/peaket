// 진입 판정(ADR-0261 결정 3): 로비·진입 때는 등급과 매수를 모르므로 셋값으로 본다. 진입은 거친 거름이고 정확한 강제는 홀드 때의 평가다.
import { applies, outcomes } from './conditions.js';
import type { DenyReason, SalePolicyRule } from './schema.js';

export interface EntryFacts {
  at: Date;
  round: string;
  lists: readonly string[];
}

export type EntryDecision = { allowed: true } | { allowed: false; reason: DenyReason };

/**
 * 걸리는 규칙 하나라도 나올 수 있는 결과가 모두 거부면 그 사유(규칙 차례로 먼저인 것)로 들이지 않는다.
 * 규칙끼리 엮어야만 모든 경우가 거부되는 조합은 들이고 홀드 때의 평가가 거부한다
 */
export function entryGate(rules: readonly SalePolicyRule[], facts: EntryFacts): EntryDecision {
  const at = facts.at.getTime();
  for (const r of rules) {
    if (!applies(r, facts.round, at)) continue;
    const os = outcomes(r, { round: facts.round, lists: facts.lists });
    const first = os[0];
    if (first && 'deny' in first && os.every((o) => o !== null && 'deny' in o)) return { allowed: false, reason: first.deny };
  }
  return { allowed: true };
}
