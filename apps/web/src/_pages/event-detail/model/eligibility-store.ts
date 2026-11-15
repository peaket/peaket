// SCR-002 팬별 판매 자격 가게(ADR-0272 결정 3 '부르는 때'·'실패'). entities/me/restriction-store.ts와 같은 모양이다.
// 시험 담당이 만든 빈 뼈대이고, 동작은 구현 담당이 채운다(ADR-0270 결정 1).
import type { FanEligibilityState } from './sale.ts';

export const ELIGIBILITY_TIMEOUT_MS = 3000;

export interface EligibilityDeps {
  fetchEligibility: () => Promise<unknown>;
  setTimer?: (fn: () => void, ms: number) => void;
}

export function createEligibilityStore(deps: EligibilityDeps): {
  get(): FanEligibilityState;
  listen(l: () => void): () => void;
  subscribe(l: () => void): () => void;
  refreshIfStarted(): Promise<void>;
} {
  void deps;
  throw new Error('아직 없음');
}
