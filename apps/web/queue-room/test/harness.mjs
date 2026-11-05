// 대기실 상태 기계 시험 틀(docs/frontend.md §3.4, ADR-0207·0208).
// 한 '세계'(가짜 시계·공유 localStorage·가짜 Web Locks·가짜 BroadcastChannel) 위에 탭을 여럿 열 수 있다.
// sleep은 가짜 시각이 되면 풀리고, run(ms)이 시각을 옮기며 차례로 푼다.
import { createHash } from 'node:crypto';
import { startQueue } from '../src/live/controller.ts';
import { createStore } from '../src/live/store.ts';
import { createClock } from '../src/live/clock.ts';
import { createTabs } from '../src/live/tabs.ts';

export const EVENT = 'e1';
export const URLS = { queue: 'https://q', files: 'https://f', event: '/events/e1', seats: '/booking/e1/seats', verify: '/queue/e1/verify' };
export const START = 1_000_000;
export const reply = (status, body, extra = {}) => ({ status, body, retryAfterMs: extra.retryAfterMs ?? null, problem: extra.problem ?? null });
export const stateFile = (over = {}) => ({ serving: 1000, servingRate: 2, saleStatus: 'ON_SALE', removedUpToServing: 0, removedBeforeSegment: 0, removedBitmap: Buffer.alloc(125).toString('base64'), generatedAtMs: 0, pollHintMs: 0, ...over });
export const sha = (s) => createHash('sha256').update(s).digest('hex');
export const iso = (ms) => new Date(ms).toISOString();

export const memory = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
    keys: () => [...m.keys()],
  };
};

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

/** Web Locks 흉내: 이름마다 하나만 쥔다. 콜백의 약속이 끝나면 놓고, 기다리던 다음 요청에 준다. signal로 기다림을 거둔다 */
function fakeLocks() {
  const held = new Set();
  const queues = new Map();
  const grant = (name) => {
    if (held.has(name)) return;
    const next = (queues.get(name) ?? []).shift();
    if (!next) return;
    held.add(name);
    Promise.resolve()
      .then(() => next.cb({ name }))
      .then(
        (v) => {
          held.delete(name);
          next.resolve(v);
          grant(name);
        },
        (e) => {
          held.delete(name);
          next.reject(e);
          grant(name);
        },
      );
  };
  return {
    request(name, opts, cb) {
      return new Promise((resolve, reject) => {
        const entry = { cb, resolve, reject };
        const signal = opts?.signal;
        if (signal?.aborted) return reject(new DOMException('거둠', 'AbortError'));
        signal?.addEventListener('abort', () => {
          const q = queues.get(name) ?? [];
          const i = q.indexOf(entry);
          if (i >= 0) {
            q.splice(i, 1);
            reject(new DOMException('거둠', 'AbortError'));
          }
        }, { once: true });
        if (!queues.has(name)) queues.set(name, []);
        queues.get(name).push(entry);
        grant(name);
      });
    },
  };
}

/** BroadcastChannel 흉내: 같은 이름의 다른 채널에만 구조화 복제(JSON 왕복)로 늦게 전한다. muted면 보내지 않는다 */
function fakeBus() {
  const chans = new Map();
  return {
    channel(name) {
      const ch = {
        listeners: new Set(),
        closed: false,
        muted: false,
        postMessage(m) {
          if (ch.muted || ch.closed) return;
          const data = JSON.parse(JSON.stringify(m));
          for (const other of chans.get(name)) {
            if (other === ch || other.closed) continue;
            setImmediate(() => {
              for (const l of other.listeners) l({ data });
            });
          }
        },
        addEventListener(type, fn) {
          if (type === 'message') ch.listeners.add(fn);
        },
        removeEventListener(type, fn) {
          ch.listeners.delete(fn);
        },
        close() {
          ch.closed = true;
          chans.get(name).delete(ch);
        },
      };
      if (!chans.has(name)) chans.set(name, new Set());
      chans.get(name).add(ch);
      return ch;
    },
  };
}

export function createWorld() {
  let now = START;
  const timers = [];
  const w = {
    local: memory(),
    locks: fakeLocks(),
    bus: fakeBus(),
    flush,
    get now() {
      return now;
    },
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        if (signal.aborted) return resolve();
        const t = { at: now + ms, resolve };
        timers.push(t);
        signal.addEventListener('abort', () => {
          const i = timers.indexOf(t);
          if (i >= 0) timers.splice(i, 1);
          resolve();
        }, { once: true });
      }),
    async run(ms) {
      const end = now + ms;
      await flush();
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        now = Math.max(now, t.at);
        t.resolve();
        await flush();
      }
      now = end;
      await flush();
    },
  };
  return w;
}

/**
 * 탭 하나. multi면 실제 탭 조정(src/live/tabs.ts)을 가짜 잠금·채널로 돌린다(없으면 한 탭).
 * schedule: 공연 공개 요약의 일정({openAtMs, lobbyOpensAtMs}) 또는 null(실패)을 돌려주는 값·함수. 기본은 이미 오픈했고 로비가 없는 회차
 * hc: 사람 확인 토큰을 돌려주는 함수(부른 횟수를 받는다). null이면 위젯 실패
 */
export function openTab(world, { handler, hidden = false, online = () => true, rec, schedule, hc, multi = false } = {}) {
  let isHidden = typeof hidden === 'function' ? null : hidden;
  const hiddenNow = () => (typeof hidden === 'function' && isHidden === null ? hidden() : isHidden);
  const wakers = new Set();
  const visibility = new Set();
  const session = memory();
  const store = createStore(EVENT, world.local, session, () => world.now, (n) => new Uint8Array(n).fill(1));
  if (rec) store.write(rec);
  const calls = [];
  const views = [];
  const navs = [];
  let hcCalls = 0;
  let refreshes = 0;
  const call = (c) => {
    calls.push(c);
    return handler({ ...c, now: world.now, tab: t });
  };
  const net = {
    postText: async (url, body) => call({ m: 'POST', url, body }),
    postJson: async (url, body) => call({ m: 'POSTJSON', url, body }),
    send: async (url, method) => call({ m: method, url }),
    getFile: async (url, noStore) => call({ m: 'GET', url, noStore }),
    getPublic: async () => reply(404),
  };
  const channel = multi ? world.bus.channel(`peaket.queue.${EVENT}`) : null;
  const tabs = multi
    ? createTabs({
        eventId: EVENT,
        locks: world.locks,
        channel,
        hidden: () => hiddenNow(),
        onVisibility: (cb) => {
          visibility.add(cb);
          return () => visibility.delete(cb);
        },
      })
    : undefined;
  const env = {
    eventId: EVENT,
    urls: URLS,
    net,
    store,
    clock: createClock(null, () => world.now),
    deviceNow: () => world.now,
    random: () => 0.5,
    sleep: world.sleep,
    hidden: () => hiddenNow(),
    online,
    onWake: (cb) => {
      wakers.add(cb);
      return () => wakers.delete(cb);
    },
    navigate: (u) => navs.push(u),
    sha256: async (s) => sha(s),
    refresh: async () => {
      refreshes++;
      return t.refreshResult ?? 'ok';
    },
    schedule: async () => {
      const s = typeof schedule === 'function' ? schedule(world.now) : schedule;
      return s === undefined ? { openAtMs: START - 60_000, lobbyOpensAtMs: null } : s;
    },
    humanCheck: async () => {
      hcCalls++;
      return hc ? hc(hcCalls) : `hc-${hcCalls}`;
    },
    ...(tabs ? { tabs } : {}),
  };
  const t = {
    env,
    store,
    calls,
    views,
    navs,
    session,
    channel,
    refreshResult: undefined,
    ctl: null,
    get now() {
      return world.now;
    },
    get refreshes() {
      return refreshes;
    },
    get hcCalls() {
      return hcCalls;
    },
    start() {
      t.ctl = startQueue(env, (v) => views.push(v));
      return flush();
    },
    run: (ms) => world.run(ms),
    wake() {
      for (const cb of [...wakers]) cb();
      return flush();
    },
    /** 보이기 바꾸기: 탭 조정에 알리고(잠금) 상태 기계를 깨운다 */
    async setHidden(v) {
      isHidden = v;
      for (const cb of [...visibility]) cb();
      await flush();
      for (const cb of [...wakers]) cb();
      return flush();
    },
    last: () => views[views.length - 1],
    states: () => views.map((v) => v.state),
    gets: () => calls.filter((c) => c.m === 'GET' && c.url.includes('/segment-states/')).length,
  };
  return t;
}

/** 한 탭짜리 세계(HOT-340 ① 시험이 쓰던 모양) */
export function harness(opts = {}) {
  const world = createWorld();
  return openTab(world, opts);
}
