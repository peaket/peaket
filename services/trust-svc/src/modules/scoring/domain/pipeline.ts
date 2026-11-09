// 합치기(docs/features/bot-defense.md §4.4): 값 없음은 0으로 더하고 남은 점수기의 가중치를 키우지 않는다. 확정 신호는 판정만 앞에서 정한다(점수기는 모두 돈다).
import type { Profile } from './rules.js';
import type { ScorerOutcome } from './scorers.js';
import type { HardSignal, ReasonCategory, ScorerName, Verdict } from './types.js';

export interface Decision {
  verdict: Verdict;
  reason?: ReasonCategory;
  degraded: boolean;
  missingScorers: ScorerName[];
}

const HARD_REASON: Record<Exclude<HardSignal, 'NONE'>, ReasonCategory> = { BLOCK_LIST: 'DEVICE_HISTORY', HONEYPOT: 'INTERACTION' };

/**
 * featureFailed: 피처 키 읽기가 하나라도 실패했다(degraded). noEvidence: 판정의 근거가 없다(로그인에서 근거 있는 점수기가 하나도 없음).
 * 근거 없는 로그인이 ALLOW로 적혀 안전장치를 풀지 않게 degraded로 둔다(identity §7)
 */
export function decide(outcomes: readonly ScorerOutcome[], profile: Profile, hard: HardSignal, o: { featureFailed?: boolean; noEvidence?: boolean } = {}): Decision {
  let total = 0;
  let top: { contribution: number; reason: ReasonCategory } | undefined;
  const missingScorers: ScorerName[] = [];
  let degraded = o.featureFailed === true;
  for (const s of outcomes) {
    if (s.risk === null) {
      missingScorers.push(s.name);
      if (s.missing === 'dependency') degraded = true;
      continue;
    }
    const contribution = profile.weights[s.name] * s.risk;
    total += contribution;
    if (contribution > (top?.contribution ?? 0)) top = { contribution, reason: s.reason };
  }
  if (o.noEvidence) degraded = true;
  if (hard !== 'NONE') return { verdict: 'CHALLENGE', reason: HARD_REASON[hard], degraded, missingScorers };
  if (total >= profile.threshold && top) return { verdict: 'CHALLENGE', reason: top.reason, degraded, missingScorers };
  return { verdict: 'ALLOW', degraded, missingScorers };
}
