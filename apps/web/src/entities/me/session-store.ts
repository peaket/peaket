// 팬 세션 가게(ADR-0202 결정 2). 받는 방법은 밖에서 넣는다(session.ts가 api-client를 늦게 가져와 넣고, 시험은 대역을 넣는다).
// - 처음 듣기 시작할 때 한 번 받는다(문서마다 한 번. 개발 모드 StrictMode의 두 번 구독도 한 번이다)
// - 401(갱신 뒤에도)이면 비로그인, 그 밖의 실패는 모름. API 출처가 없으면 비로그인
// - 다시 받기(본인확인 뒤·페이지 보관에서 돌아옴)는 받는 동안 지금 값을 그대로 두고, 늦게 온 앞선 답은 버린다(세대 번호)
import { toMember, type FanAccountSummaryLike, type FanSession } from './session-model.ts';

export interface FanSessionDeps {
  apiAvailable: () => boolean;
  fetchMe: () => Promise<FanAccountSummaryLike>;
  isUnauthorized: (e: unknown) => boolean;
}

export function createFanSessionStore(deps: FanSessionDeps) {
  let current: FanSession = { status: 'loading' };
  let started = false;
  let generation = 0;
  const listeners = new Set<() => void>();

  const set = (next: FanSession) => {
    current = next;
    for (const l of listeners) l();
  };

  async function load(): Promise<void> {
    const mine = ++generation;
    if (!deps.apiAvailable()) {
      set({ status: 'guest' });
      return;
    }
    try {
      const me = await deps.fetchMe();
      if (mine === generation) set({ status: 'member', me: toMember(me) });
    } catch (e) {
      if (mine === generation) set(deps.isUnauthorized(e) ? { status: 'guest' } : { status: 'unknown' });
    }
  }

  /** 듣기만 한다(받기를 시작하지 않는다) */
  const listen = (l: () => void): (() => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };

  return {
    get: (): FanSession => current,
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
    /** 다시 받는다(받기를 시작하지 않았어도) */
    refresh(): Promise<void> {
      started = true;
      return load();
    },
    /** 이미 받기 시작했을 때만 다시 받는다(페이지 보관에서 돌아온 때) */
    refreshIfStarted(): Promise<void> {
      return started ? load() : Promise.resolve();
    },
  };
}
