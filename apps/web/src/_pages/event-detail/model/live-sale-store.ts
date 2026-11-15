// SCR-002 공연 상세의 상태 파일 가게(ADR-0272 결정 1 '읽는 때'·'요청'). 받는 방법·시계·타이머는 밖에서 넣는다(시험은 대역을 넣는다).
// 시험 담당이 만든 빈 뼈대이고, 동작은 구현 담당이 채운다(ADR-0270 결정 1).
import type { LiveSale } from './live-sale.ts';

export const LIVE_SALE_TIMEOUT_MS = 3000;
export const LIVE_SALE_RECHECK_MS = 30_000;

export interface LiveSaleDeps {
  fetchFile: () => Promise<{ status: number; body: unknown }>;
  now: () => number;
  setTimer?: (fn: () => void, ms: number) => void;
}

export function createLiveSaleStore(deps: LiveSaleDeps): { get(): LiveSale; listen(l: () => void): () => void; start(): void; onVisible(): void } {
  void deps;
  throw new Error('아직 없음');
}
