// 내 예매 제한 가게(ADR-0213 결정 2). 받는 방법은 밖에서 넣는다(restriction.ts가 api-client를 늦게 가져와 넣고, 시험은 대역을 넣는다).
// - 회원 팬의 부품이 듣기 시작할 때 한 번 받는다(문서마다 한 번). 저장하지 않는다(private, no-store)
// - 401·5xx·연결 실패는 제한 없음. 3초 [가정] 안에 답이 없어도 제한 없음으로 보고, 늦은 답이 오면 그때 바꾼다
// - 다시 받기(페이지 보관에서 돌아옴)는 지금 값을 그대로 두고, 늦게 온 앞선 답은 버린다(세대 번호)
import { toRestriction, type BookingRestrictionLike, type RestrictionState } from './restriction-model.ts';

export interface RestrictionDeps {
  fetchStatus: () => Promise<BookingRestrictionLike>;
  setTimer?: (fn: () => void, ms: number) => void;
}

export const RESTRICTION_TIMEOUT_MS = 3000;

export function createRestrictionStore(deps: RestrictionDeps) {
  let current: RestrictionState = { status: 'idle' };
  let started = false;
  let generation = 0;
  const listeners = new Set<() => void>();
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms));

  const set = (next: RestrictionState) => {
    current = next;
    for (const l of listeners) l();
  };

  async function load(): Promise<void> {
    const mine = ++generation;
    if (current.status === 'idle') {
      set({ status: 'loading' });
      setTimer(() => {
        if (current.status === 'loading') set({ status: 'none' });
      }, RESTRICTION_TIMEOUT_MS);
    }
    try {
      const s = await deps.fetchStatus();
      if (mine === generation) set(toRestriction(s));
    } catch {
      if (mine === generation) set({ status: 'none' });
    }
  }

  const listen = (l: () => void): (() => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };

  return {
    get: (): RestrictionState => current,
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
