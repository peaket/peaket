// 켜 둔 동안 안 보이는 위젯의 흐름 단위 시험(F-03-2 OPS-360 T12·T13·T14·T15·T16, FE-T26). 가짜 흐름 만들기·가짜 시계로 본다.
// 정본: docs/frontend.md §4.4.5 '구독 수명'(마지막 구독자가 떠나도 10초 [가정] 뒤에 목록에서 뺀다, 그 사이 다시 오면 다시 열지 않는다,
// 숨긴 탭 30초 [가정] 넘으면 위젯 키를 모두 뺀다(구독자는 멈춤, 다시 보이면 바로 다시 열며 키마다 위젯 조회로 15분 창을 한 번 채운다),
// 목록이 바뀌면 1초 [가정] 묶어 위젯 흐름만 다시 연다, 회차를 바꾸면 묶지 않고 바로), §4.5 '구독 수명과 보이기'(화면 밖 자리는 값을 넘기지 않고
// 마지막 값만 들고 있다가 보이면 넘긴다), §5.7·§5.8 관제 '위젯 그리기 묶음 250ms [가정]', ADR-0091 결정 3, FE-T26 판정 열.
// 단언 값은 정본에서 가져오고 코드 상수를 옮기지 않는다. 시간 경계는 양쪽(9,999·10,000, 29,999·30,000, 249·250)을 본다.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('./live.test.resolve.mjs', import.meta.url);
const { WidgetStreams } = await import('./widget-stream.ts');
const { createSlotServices } = await import('./console-services.ts');
const { hiddenTitlePrefix } = await import('../../lib/title.ts');

const CANON = { graceMs: 10_000, hiddenMs: 30_000, debounceMs: 1_000, batchMs: 250 };
const Q = 'queue-admission-rate.summary';
const P = 'purchase-pg-status.summary';
const E = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
const F = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e02';

const drain = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
};

class FakeTimers {
  now = 0;
  #q = [];
  #id = 0;
  setTimeout = (fn, ms) => {
    this.#id += 1;
    this.#q.push({ h: this.#id, at: this.now + ms, fn });
    return this.#id;
  };
  clearTimeout = (h) => {
    this.#q = this.#q.filter((t) => t.h !== h);
  };
  async advance(ms) {
    const end = this.now + ms;
    for (;;) {
      await drain();
      const due = this.#q.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.h - b.h)[0];
      if (!due) break;
      this.#q = this.#q.filter((t) => t !== due);
      this.now = due.at;
      due.fn();
    }
    this.now = end;
    await drain();
  }
}

/** 위젯 흐름 관리자 + 흐름 만들기 대역(연 주소·닫힘) + 위젯 조회 대역(받은 요청) */
function world(o = {}) {
  const timers = new FakeTimers();
  const opened = [];
  const refills = [];
  const ws = new WidgetStreams({
    origin: 'https://ops-api.test',
    timers,
    createStream: (url, onFrame) => {
      const h = { url: url(), keys: decodeURIComponent(new URL(url()).searchParams.get('widgets') ?? ''), onFrame, started: 0, stopped: 0, start() {
        this.started += 1;
      }, stop() {
        this.stopped += 1;
      }, restart() {} };
      opened.push(h);
      return h;
    },
    refill: async (key, eventId) => {
      refills.push({ key, eventId });
      return o.refillValue ? o.refillValue(key) : { widgetKey: key, at: '2026-11-23T01:00:00.000Z', ratio: 0.5 };
    },
  });
  const live = () => opened.filter((h) => h.stopped === 0);
  return { timers, opened, refills, ws, live };
}

const frame = (key, v) => ({ event: 'widget', lastEventId: '1', data: JSON.stringify({ widgetKey: key, at: '2026-11-23T01:00:01.000Z', value: v }) });

test('F-03-2 T12 FE-T26 ① 고르지 않은 탭으로 바뀌어 마지막 구독자가 떠나면 9,999ms까지 목록에 남고 10,000ms에 빠지며, 빠진 목록으로 1초 묶어 한 번만 다시 연다', async () => {
  const { timers, opened, ws, live } = world();
  ws.setEvent(E);
  ws.subscribe(Q, () => undefined);
  const offP = ws.subscribe(P, () => undefined);
  await timers.advance(CANON.debounceMs);
  assert.deepEqual(live().map((h) => h.keys), [`${P},${Q}`]);
  offP();
  await timers.advance(CANON.graceMs - 1);
  assert.deepEqual([...ws.wantedKeys], [P, Q], '9,999ms까지 목록에 남는다');
  assert.equal(opened.length, 1);
  await timers.advance(1);
  assert.deepEqual([...ws.wantedKeys], [Q], '10,000ms에 목록에서 빠진다');
  await timers.advance(CANON.debounceMs - 1);
  assert.equal(opened.length, 1, '빠진 뒤 1초 묶기 전에는 다시 열지 않는다');
  await timers.advance(1);
  assert.equal(opened.length, 2, '한 번만 다시 연다');
  assert.equal(opened[0].stopped, 1);
  assert.deepEqual(live().map((h) => h.keys), [Q]);
  await timers.advance(60_000);
  assert.equal(opened.length, 2, '그 뒤로 다시 열지 않는다');
});

test('F-03-2 T12 FE-T26 ② 유예 10초 안에 그 탭으로 돌아오면(다시 구독) 흐름을 다시 열지 않는다', async () => {
  const { timers, opened, ws } = world();
  ws.setEvent(E);
  ws.subscribe(Q, () => undefined);
  const offP = ws.subscribe(P, () => undefined);
  await timers.advance(CANON.debounceMs);
  assert.equal(opened.length, 1);
  offP();
  await timers.advance(CANON.graceMs - 1);
  const got = [];
  ws.subscribe(P, (m) => got.push(m.value));
  await timers.advance(5 * CANON.graceMs);
  assert.equal(opened.length, 1, '목록이 그대로라 다시 열지 않는다');
  assert.equal(opened[0].stopped, 0);
  assert.deepEqual([...ws.wantedKeys], [P, Q]);
  // 돌아온 구독자가 같은 흐름의 값을 받는다
  opened[0].onFrame(frame(P, { pg: 'ok' }));
  assert.deepEqual(got, [{ pg: 'ok' }]);
});

test('F-03-2 T12 FE-T26 ③ 모두 떠나면 10초 유예 뒤 목록이 비고 1초 묶기 뒤 위젯 흐름을 닫는다(떠난 뒤 10,999ms에는 열려 있다)', async () => {
  const { timers, opened, ws } = world();
  ws.setEvent(E);
  const off = ws.subscribe(Q, () => undefined);
  await timers.advance(CANON.debounceMs);
  off();
  await timers.advance(CANON.graceMs + CANON.debounceMs - 1);
  assert.equal(opened[0].stopped, 0);
  await timers.advance(1);
  assert.equal(opened[0].stopped, 1);
  assert.deepEqual([...ws.openKeys], []);
  assert.deepEqual([...ws.wantedKeys], []);
});

test('F-03-2 T13 FE-T26 ① 브라우저 탭을 숨긴 지 29,999ms까지 위젯 흐름을 두고 30,000ms에 위젯 키 0(흐름 닫힘), 구독자는 멈춤으로 남는다', async () => {
  const { timers, opened, ws, live, refills } = world();
  ws.setEvent(E);
  ws.subscribe(Q, () => undefined);
  ws.subscribe(P, () => undefined);
  await timers.advance(CANON.debounceMs);
  ws.setHidden(true);
  await timers.advance(CANON.hiddenMs - 1);
  assert.equal(live().length, 1, '29,999ms에는 위젯 흐름이 열려 있다');
  assert.deepEqual([...ws.openKeys], [P, Q]);
  await timers.advance(1);
  assert.equal(live().length, 0, '30,000ms에 위젯 흐름을 닫는다');
  assert.deepEqual([...ws.openKeys], []);
  assert.equal(ws.paused, true);
  assert.deepEqual([...ws.wantedKeys], [P, Q], '구독자는 멈춤으로 남는다(돌아오면 열 키)');
  // 숨긴 동안에는 다시 열지 않는다(목록이 바뀌어도)
  ws.subscribe('purchase-hold-p99.summary', () => undefined);
  await timers.advance(10 * CANON.hiddenMs);
  assert.equal(opened.length, 1);
  assert.deepEqual(refills, []);
});

test('F-03-2 T13 FE-T26 ② 다시 보이면 바로(묶지 않고) 위젯 흐름을 다시 열고 키마다 위젯 조회를 한 번 불러 같은 구독자에게 넘긴다', async () => {
  const { timers, opened, ws, live, refills } = world({ refillValue: (key) => ({ widgetKey: key, at: '2026-11-23T00:59:30.000Z', filled: key }) });
  ws.setEvent(E);
  const got = { q: [], p: [] };
  ws.subscribe(Q, (m) => got.q.push(m));
  ws.subscribe(P, (m) => got.p.push(m));
  await timers.advance(CANON.debounceMs);
  ws.setHidden(true);
  await timers.advance(CANON.hiddenMs);
  assert.equal(live().length, 0);
  ws.setHidden(false);
  assert.equal(opened.length, 2, '보이자마자 다시 연다(1초 묶기를 기다리지 않는다)');
  assert.equal(live()[0].keys, `${P},${Q}`);
  await drain();
  assert.deepEqual(refills.sort((a, b) => a.key.localeCompare(b.key)), [
    { key: P, eventId: E },
    { key: Q, eventId: E },
  ]);
  assert.deepEqual(got.q, [{ widgetKey: Q, at: '2026-11-23T00:59:30.000Z', value: { widgetKey: Q, at: '2026-11-23T00:59:30.000Z', filled: Q } }]);
  assert.deepEqual(got.p.map((m) => m.value.filled), [P]);
  // 그다음 흐름의 첫 값이 덮는다
  live()[0].onFrame(frame(Q, { ratio: 0.7 }));
  assert.deepEqual(got.q.at(-1).value, { ratio: 0.7 });
});

test('F-03-2 T13 FE-T26 ③ 30초가 되기 전에 다시 보이면 흐름을 닫지도 다시 열지도 않고 조회도 부르지 않는다', async () => {
  const { timers, opened, ws, refills } = world();
  ws.setEvent(E);
  ws.subscribe(Q, () => undefined);
  await timers.advance(CANON.debounceMs);
  ws.setHidden(true);
  await timers.advance(CANON.hiddenMs - 1);
  ws.setHidden(false);
  await timers.advance(10 * CANON.hiddenMs);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].stopped, 0);
  assert.equal(ws.paused, false);
  assert.deepEqual(refills, []);
});

test('F-03-2 T13 FE-T26 ④ 숨긴 동안 걸린 SEV1·SEV2 경보와 내 승인 대기 수를 탭 제목 앞에 붙이고, 없으면 붙이지 않는다', () => {
  const a = (severity, status = 'firing') => ({ severity, status });
  assert.equal(hiddenTitlePrefix({ alerts: [a('SEV1'), a('SEV3')], commands: { pending: [{}] } }), '(SEV1 1 · 승인 1) ');
  assert.equal(hiddenTitlePrefix({ alerts: [a('SEV2'), a('SEV2'), a('SEV1', 'resolved')], commands: { pending: [] } }), '(SEV2 2) ');
  assert.equal(hiddenTitlePrefix({ alerts: [a('SEV1'), a('SEV1'), a('SEV2')], commands: { pending: [{}, {}] } }), '(SEV1 2 · SEV2 1 · 승인 2) ');
  assert.equal(hiddenTitlePrefix({ alerts: [a('SEV3'), a('SEV1', 'resolved')], commands: { pending: [] } }), '');
});

test('F-03-2 T14 FE-T26 회차를 바꾸면 유예 중인 키를 버리고 이전 회차 위젯 흐름을 묶지 않고 바로 닫아 새 회차 주소로 연다', async () => {
  const { timers, opened, ws, live } = world();
  ws.setEvent(E);
  ws.subscribe(Q, () => undefined);
  const offP = ws.subscribe(P, () => undefined);
  await timers.advance(CANON.debounceMs);
  offP();
  await timers.advance(CANON.graceMs - 1);
  ws.setEvent(F);
  assert.equal(opened.length, 2, '회차 바꿈은 바로');
  assert.equal(opened[0].stopped, 1);
  assert.equal(live().length, 1);
  assert.equal(live()[0].url, `https://ops-api.test/v1/ops/events/${F}/live?widgets=${encodeURIComponent(Q)}`, '유예 중이던 P는 새 회차에 싣지 않는다');
  // 남은 유예 타이머가 뒤늦게 다시 열지 않는다
  await timers.advance(5 * CANON.graceMs);
  assert.equal(opened.length, 2);
});

test('F-03-2 T15 FE-T26 같은 키를 두 자리가 구독해도 흐름의 widgets에는 키 하나이고, 한 자리가 떠나도(접기 아님) 다른 자리는 값을 계속 받는다', async () => {
  const { timers, opened, ws, live } = world();
  ws.setEvent(E);
  const a = [];
  const b = [];
  const offA = ws.subscribe(Q, (m) => a.push(m.value));
  ws.subscribe(Q, (m) => b.push(m.value));
  await timers.advance(CANON.debounceMs);
  assert.equal(opened.length, 1);
  assert.equal(live()[0].keys, Q);
  live()[0].onFrame(frame(Q, 1));
  offA();
  await timers.advance(CANON.graceMs + CANON.debounceMs);
  assert.equal(opened.length, 1, '구독자가 남아 목록이 그대로다');
  live()[0].onFrame(frame(Q, 2));
  assert.deepEqual(a, [1]);
  assert.deepEqual(b, [1, 2]);
});

/** 자리 통로(createSlotServices) + 위젯 흐름 구독 대역 */
function slot() {
  const timers = new FakeTimers();
  const subs = new Map();
  const s = createSlotServices({
    slot: 'queue-admission-rate',
    query: async () => ({}),
    subscribe(key, next) {
      subs.set(key, next);
      return () => subs.delete(key);
    },
    on: () => () => undefined,
    host: { get: () => ({}), subscribe: () => () => undefined, use: (f) => f({}) },
    permissions: ['ops:read'],
    timers,
  });
  return { timers, subs, s, push: (key, v) => subs.get(key)(v, '2026-11-23T01:00:00.000Z') };
}

test('F-03-2 T16 FE-T26 ① 실시간 값은 자리마다 250ms에 한 번만 넘기고(처음 값은 바로) 그 사이 값은 마지막 것만 넘긴다', async () => {
  const { timers, s, push } = slot();
  const got = [];
  s.services.data.subscribe(Q, {}, (v) => got.push(v));
  push(Q, 1);
  assert.deepEqual(got, [1], '처음 값은 바로');
  push(Q, 2);
  await timers.advance(100);
  push(Q, 3);
  await timers.advance(CANON.batchMs - 100 - 1);
  assert.deepEqual(got, [1], '249ms까지 더 넘기지 않는다');
  await timers.advance(1);
  assert.deepEqual(got, [1, 3], '250ms에 마지막 값 하나');
  // 창 안에 값이 없으면 다음 창에 넘길 것이 없다
  await timers.advance(CANON.batchMs * 4);
  assert.deepEqual(got, [1, 3]);
  // 1초에 열 번(100ms마다) 와도 처음 값 바로, 그 뒤 250ms 창마다 그 창의 마지막 값 하나(0·250·500·750·1000ms)
  for (let i = 0; i < 10; i += 1) {
    push(Q, 100 + i);
    await timers.advance(100);
  }
  await timers.advance(CANON.batchMs);
  assert.deepEqual(got.slice(2), [100, 102, 104, 107, 109]);
});

test('F-03-2 T16 FE-T26 ② 화면 밖 자리에는 값을 넘기지 않고 마지막 값만 들고 있다가 보이면 한 번 넘기며, 구독은 그대로다', async () => {
  const { timers, subs, s, push } = slot();
  const got = [];
  s.services.data.subscribe(Q, {}, (v) => got.push(v));
  push(Q, 1);
  await timers.advance(CANON.batchMs);
  s.setOnScreen(false);
  push(Q, 2);
  push(Q, 3);
  await timers.advance(10 * CANON.batchMs);
  assert.deepEqual(got, [1], '화면 밖에서는 넘기지 않는다');
  assert.equal(subs.has(Q), true, '구독은 그대로다');
  s.setOnScreen(true);
  assert.deepEqual(got, [1, 3], '보이면 마지막 값 한 번');
  await timers.advance(10 * CANON.batchMs);
  assert.deepEqual(got, [1, 3]);
  // 끊으면 위젯 흐름 구독도 끊는다
  s.dispose();
});
