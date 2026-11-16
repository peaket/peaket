// SCR-002 팬별 판매 자격 가게(ADR-0272 결정 3 '부르는 때'·'실패'). entities/me/restriction-store.ts와 같은 모양이다.
// 받는 방법은 밖에서 넣는다(ui/sale-live.ts가 api-client를 늦게 가져와 넣고, 시험은 대역을 넣는다).
// - 부품이 듣기 시작할 때 한 번 받는다(문서마다 한 번). 저장하지 않는다(no-store)
// - 던지면(401 갱신 뒤·404·410·5xx·연결 실패)·모양이 틀리면 자격 모름(none). 3초 [가정] 안에 답이 없어도 none이고, 늦은 답이 오면 그때 바꾼다
// - 다시 받기(페이지 보관에서 돌아옴)는 지금 값을 그대로 두고, 늦게 온 앞선 답은 버린다(세대 번호)
import { toFanEligibility, type FanEligibilityState } from './sale.ts';

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
  let current: FanEligibilityState = { status: 'idle' };
  let started = false;
  let generation = 0;
  const listeners = new Set<() => void>();
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms));

  const set = (next: FanEligibilityState) => {
    current = next;
    for (const l of listeners) l();
  };

  async function load(): Promise<void> {
    const mine = ++generation;
    if (current.status === 'idle') {
      set({ status: 'loading' });
      setTimer(() => {
        if (current.status === 'loading') set({ status: 'none' });
      }, ELIGIBILITY_TIMEOUT_MS);
    }
    try {
      const body = await deps.fetchEligibility();
      if (mine === generation) set(toFanEligibility(body));
    } catch {
      if (mine === generation) set({ status: 'none' });
    }
  }

  const listen = (l: () => void): (() => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };

  return {
    get: (): FanEligibilityState => current,
    listen,
    /** 듣기 시작하면서 아직 받지 않았으면 받는다 */
    subscribe(l: () => void): () => void {
      const off = listen(l);
      if (!started) {
        started = true;
        void load();
      }
      return off;
    },
    /** 이미 받기 시작했을 때만 다시 받는다(페이지 보관에서 돌아온 때) */
    refreshIfStarted(): Promise<void> {
      return started ? load() : Promise.resolve();
    },
  };
}
