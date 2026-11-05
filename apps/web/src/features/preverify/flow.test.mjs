// 공연 상세 사전 검증 흐름(SCR-002 ⑦, ADR-0211 결정 2·4). 가짜 시계·타이머·보이기·위젯·호출로 돌린다.
// 2026-11-05 새 맥락 리뷰가 찾은 것(조용한 갱신 건너뜀·지터 사라짐·이미 줄 선 팬·저장 실패·갱신이 멈추지 않음)의 재현을 담는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPreverifyFlow } from './flow.ts';

const NOW = 1_800_000_000_000;
const KEY = 'peaket.queue.e1';
const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};
const ok = (now, ttl = 900_000) => ({ preverifyToken: `pv-${now}`, expiresAt: new Date(now + ttl).toISOString(), serverTimeMs: now });
const apiError = (status, type, retryAfter = null) => Object.assign(new Error(type), { status, type, retryAfter, date: null });

function harness(o = {}) {
  let now = NOW;
  let visible = o.visible ?? true;
  const timers = new Map();
  let seq = 0;
  const vis = new Set();
  const kv = o.kv ?? memory();
  const navs = [];
  const posts = [];
  const states = [];
  let personal = 0;
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  const f = createPreverifyFlow({
    eventId: 'e1',
    kv,
    now: () => now,
    random: () => 0.5,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    visible: () => visible,
    onVisible: (cb) => {
      vis.add(cb);
      return () => vis.delete(cb);
    },
    humanCheck: async (silent) => (o.human ? o.human(silent) : `hc-${silent ? 's' : 'v'}`),
    post: async (body) => {
      posts.push({ at: now, body });
      return o.post ? o.post(body, now) : ok(now);
    },
    body: () => ({ deviceId: 'd1', behaviorSummary: { v: 1, windowMs: 1, pointerMoves: 0, pointerEntropy: 0, scrollEvents: 0, scrollDistancePx: 0 } }),
    navigate: (u) => navs.push(u),
    refreshPersonal: () => personal++,
    queueHref: '/queue/e1',
    loginHref: '/login?next=%2Fevents%2Fe1',
    onChange: (s) => states.push(s),
  });
  return {
    f,
    kv,
    navs,
    posts,
    states,
    last: () => states[states.length - 1],
    get personal() {
      return personal;
    },
    get now() {
      return now;
    },
    flush,
    async run(ms) {
      const end = now + ms;
      await flush();
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        now = Math.max(now, next[1].at);
        next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
    async setVisible(v) {
      visible = v;
      if (v) for (const cb of [...vis]) cb();
      await flush();
    },
  };
}

test('SCR-002 [대기열 들어가기]: 사람 확인 → 사전 검증 → 저장 → 대기실. 본문에 사람 확인 토큰·기기·요약', async () => {
  const h = harness();
  h.f.enter();
  await h.flush();
  assert.deepEqual(h.navs, ['/queue/e1']);
  assert.equal(h.posts[0].body.humanCheckToken, 'hc-v');
  assert.equal(h.posts[0].body.deviceId, 'd1');
  assert.equal(h.posts[0].body.behaviorSummary.v, 1);
  assert.equal(JSON.parse(h.kv.getItem(KEY)).preverifyToken, `pv-${NOW}`);
  assert.equal(h.last().open, false);
});

test('SCR-002 이미 줄을 섰으면(대기표·참가 토큰·진행 중 진입) 사람 확인 없이 대기실로 간다', async () => {
  for (const rec of [{ ticket: { queueTicket: 'q', seq: 1, generation: 1, segment: 0 } }, { lobby: { lobbyToken: 'l' } }, { entry: { entryRequestId: 'r', token: 't' } }]) {
    const kv = memory();
    kv.setItem(KEY, JSON.stringify({ ...rec, savedAt: NOW }));
    const h = harness({ kv });
    h.f.enter();
    await h.flush();
    assert.deepEqual([h.navs, h.posts.length], [['/queue/e1'], 0], Object.keys(rec)[0]);
  }
});

test('SCR-002 일시 실패(503 Retry-After 3)는 하한 위 지터의 실제 시각(3.3초)에 다시 보낸다(화면의 초는 표시만)', async () => {
  let n = 0;
  const h = harness({ post: (b, now) => (++n === 1 ? Promise.reject(apiError(503, 'human-check-unavailable', '3')) : ok(now)) });
  h.f.enter();
  await h.flush();
  assert.equal(h.last().step, 'retry');
  assert.equal(h.last().retryAt, NOW + 3300);
  await h.run(3299);
  assert.equal(h.posts.length, 1);
  await h.run(1);
  assert.equal(h.posts.length, 2);
  assert.deepEqual(h.navs, ['/queue/e1']);
});

test('SCR-002 대화상자를 닫으면 진행 중 요청을 버리고 다시 시도도 하지 않는다', async () => {
  let release;
  const h = harness({ post: () => new Promise((r) => (release = r)) });
  h.f.enter();
  await h.flush();
  h.f.close();
  release(ok(NOW));
  await h.flush();
  assert.deepEqual(h.navs, [], '닫은 뒤 늦게 온 응답으로 떠나지 않는다');
  const g = harness({ post: () => Promise.reject(apiError(503, 'x', '2')) });
  g.f.enter();
  await g.flush();
  g.f.close();
  await g.run(10_000);
  assert.equal(g.posts.length, 1);
});

test('SCR-002 저장하지 못하면 대기실로 가지 않고 안내한다, 위젯을 못 불러온 것과 사람 확인 실패를 나눈다, 본인확인 전 403은 개인 상태를 다시 읽는다', async () => {
  const kv = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => undefined };
  let h = harness({ kv });
  h.f.enter();
  await h.flush();
  assert.deepEqual([h.last().step, h.navs], ['storage', []]);
  h = harness({ human: () => 'unavailable' });
  h.f.check();
  await h.flush();
  assert.equal(h.last().step, 'unavailable');
  h = harness({ human: () => null });
  h.f.check();
  await h.flush();
  assert.equal(h.last().step, 'failed');
  h = harness({ post: () => Promise.reject(apiError(403, 'identity-verification-required')) });
  h.f.check();
  await h.flush();
  assert.deepEqual([h.last().step, h.personal], ['verify', 1]);
});

test('SCR-002 조용한 갱신: 만료 2분 전에 숨겨져 있었으면 다시 보일 때 갱신하고, 지금 토큰을 실어 최초 발급을 잇는다', async () => {
  const h = harness({ visible: false });
  h.f.check();
  await h.flush();
  const first = JSON.parse(h.kv.getItem(KEY)).preverifyToken;
  await h.run(900_000 - 120_000 + 10);
  assert.equal(h.posts.length, 1, '숨긴 동안에는 갱신하지 않는다');
  await h.setVisible(true);
  await h.flush();
  assert.equal(h.posts.length, 2, '다시 보이면 갱신한다');
  assert.equal(h.posts[1].body.preverifyToken, first);
  assert.equal(h.posts[1].body.humanCheckToken, 'hc-s', '보이지 않는 모드');
});

test('SCR-002 조용한 갱신의 일시 실패는 만료 전까지 늘려 가며 다시, 조작이 필요하면 멈춘다', async () => {
  let fail = true;
  const h = harness({ post: (b, now) => (b.preverifyToken && fail ? Promise.reject(apiError(503, 'x')) : ok(now)) });
  h.f.check();
  await h.flush();
  await h.run(900_000 - 120_000 + 1);
  const tries = h.posts.length;
  assert.ok(tries >= 2);
  await h.run(20_000);
  assert.ok(h.posts.length > tries, '503 뒤 다시 한다');
  fail = false;
  await h.run(30_000);
  assert.ok(JSON.parse(h.kv.getItem(KEY)).preverifyExpiresAt > NOW + 900_000, '갱신된 토큰');
  const g = harness({ human: (silent) => (silent ? 'interactive' : 'hc-v') });
  g.f.check();
  await g.flush();
  await g.run(900_100);
  assert.equal(g.posts.length, 1, '조작이 필요하면 갱신하지 않는다');
  assert.equal(g.last().token, null, '만료 뒤 카드가 다시 사람 확인');
});

test('SCR-002 대기실이 키를 지웠거나(입장) 이미 줄을 섰으면 갱신으로 키를 되살리지 않는다', async () => {
  const h = harness();
  h.f.check();
  await h.flush();
  h.kv.removeItem(KEY); // 다른 탭의 대기실이 입장(ADMITTED)으로 지웠다
  await h.run(900_000);
  assert.equal(h.posts.length, 1);
  assert.equal(h.kv.getItem(KEY), null);
  const g = harness();
  g.f.check();
  await g.flush();
  const rec = JSON.parse(g.kv.getItem(KEY));
  g.kv.setItem(KEY, JSON.stringify({ ...rec, ticket: { queueTicket: 'q', seq: 1, generation: 1, segment: 0 } }));
  await g.run(900_000);
  assert.equal(g.posts.length, 1, '줄을 선 뒤에는 갱신하지 않는다');
});
