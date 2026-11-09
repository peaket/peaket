// 같은 회차를 연 탭끼리의 조정(docs/frontend.md §4.7·§5.1 '여러 탭'·§5.9, FE-T6, ADR-0208 결정 5).
// - 폴링 리더: Web Locks `queue-poll:{eventId}`를 보이는 탭만 청한다. 숨겨지면 쥔 잠금을 놓고 청해 둔 요청도 거둔다.
// - 방송: BroadcastChannel `peaket.queue.{eventId}`로 대기 상태 파일·저장 알림·끝 상태를 나눈다. 받은 메시지는 꼴을 다시 검사한다.
//   메시지마다 대기표 지문 k를 싣는다(원문 토큰이 아니다). 받는 탭은 자기 지문과 같을 때만 파일·끝 상태를 쓴다(새 맥락 리뷰 2026-11-05).
// - 잠금은 대기 중인 탭만 청한다(setActive). 끝 상태·로비·진입 중인 탭은 쥐지 않는다.
// Web Locks가 없는 맥락(보안 맥락이 아닌 주소)에서는 보이는 탭이 저마다 리더다.

/** 다른 탭에 알리는 끝 상태(입장 확정·파일이 낸 것). admitted를 받은 탭은 duplicate로 끝낸다 */
export const RESULT_STATES = ['admitted', 'expired', 'cancelled-elsewhere', 'restricted', 'already-admitted', 'sold-out', 'ended', 'login-expired', 'duplicate'] as const;
export type ResultState = (typeof RESULT_STATES)[number];

export type TabMessage =
  | { t: 'file'; k: string; file: unknown }
  | { t: 'stored'; k: string }
  | { t: 'result'; k: string; state: ResultState; rejoinAllowed?: boolean; via?: 'lobby' | 'queue' };

export interface Tabs {
  /** 이 탭이 폴링 리더인지 */
  leader(): boolean;
  /** 대기 중이면 true(보일 때 잠금을 청한다), 아니면 false(쥔 잠금을 놓는다) */
  setActive(on: boolean): void;
  /** 리더를 얻거나 놓으면 부른다. 돌려준 함수로 끊는다 */
  onLeader(cb: () => void): () => void;
  post(msg: TabMessage): void;
  onMessage(cb: (msg: TabMessage) => void): () => void;
  close(): void;
}

export interface LocksLike {
  request(name: string, options: { signal?: AbortSignal }, cb: (lock: unknown) => Promise<unknown> | unknown): Promise<unknown>;
}

export interface ChannelLike {
  postMessage(m: unknown): void;
  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
  close(): void;
}

/** 받은 메시지의 꼴을 검사한다(ASVS 1.5.2·3.5.5). 틀리면 null(버린다) */
export function parseTabMessage(data: unknown): TabMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Record<string, unknown>;
  if (typeof m.k !== 'string' || m.k.length === 0 || m.k.length > 80) return null;
  const k = m.k;
  if (m.t === 'file' && 'file' in m) return { t: 'file', k, file: m.file };
  if (m.t === 'stored') return { t: 'stored', k };
  if (m.t === 'result' && RESULT_STATES.includes(m.state as ResultState)) {
    return {
      t: 'result',
      k,
      state: m.state as ResultState,
      ...(typeof m.rejoinAllowed === 'boolean' ? { rejoinAllowed: m.rejoinAllowed } : {}),
      ...(m.via === 'lobby' || m.via === 'queue' ? { via: m.via } : {}),
    };
  }
  return null;
}

export function createTabs(o: { eventId: string; locks: LocksLike | null; channel: ChannelLike | null; hidden(): boolean; onVisibility(cb: () => void): () => void }): Tabs {
  const name = `queue-poll:${o.eventId}`;
  const leaders = new Set<() => void>();
  const listeners = new Set<(m: TabMessage) => void>();
  let isLeader = false;
  let release: (() => void) | null = null;
  let pending: AbortController | null = null;
  let closed = false;
  let active = false;
  const set = (v: boolean) => {
    if (isLeader === v) return;
    isLeader = v;
    for (const cb of [...leaders]) cb();
  };
  const sync = () => {
    if (closed) return;
    if (o.hidden() || !active) {
      pending?.abort();
      pending = null;
      release?.();
      set(false);
      return;
    }
    if (!o.locks) return set(true);
    if (release || pending) return;
    const ac = new AbortController();
    pending = ac;
    o.locks
      .request(name, { signal: ac.signal }, () => {
        if (pending === ac) pending = null;
        // 잠금을 받기 전에 숨겨졌거나 대기가 끝났으면 바로 놓는다
        if (closed || o.hidden() || !active) return undefined;
        return new Promise<void>((resolve) => {
          release = () => {
            release = null;
            set(false);
            resolve();
          };
          set(true);
        });
      })
      .catch(() => {
        if (pending === ac) pending = null;
      });
  };
  o.channel?.addEventListener('message', (e) => {
    const m = parseTabMessage(e.data);
    if (m) for (const cb of [...listeners]) cb(m);
  });
  const stopVisibility = o.onVisibility(sync);
  sync();
  return {
    leader: () => isLeader,
    setActive(on) {
      active = on;
      sync();
    },
    onLeader(cb) {
      leaders.add(cb);
      return () => leaders.delete(cb);
    },
    post(msg) {
      try {
        o.channel?.postMessage(msg);
      } catch {
        /* 닫힌 채널은 넘긴다 */
      }
    },
    onMessage(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    close() {
      closed = true;
      stopVisibility();
      pending?.abort();
      release?.();
      try {
        o.channel?.close();
      } catch {
        /* 넘긴다 */
      }
    },
  };
}

/** 탭 조정이 없을 때(시험·한 탭): 늘 리더이고 방송은 없다 */
export const singleTab: Tabs = {
  leader: () => true,
  setActive: () => undefined,
  onLeader: () => () => undefined,
  post: () => undefined,
  onMessage: () => () => undefined,
  close: () => undefined,
};
