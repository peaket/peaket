// 관제 SSE 흐름 브라우저 쪽 단위 시험(F-03-1 OPS-340, FE-T28 ①~⑤). 가짜 SSE 서버(fetch 스트림 대역)와 가짜 시계로 본다.
// 정본: ADR-0100 결정 2(35초 무소식이면 끊고 retry 10초 + 0~5초, Last-Event-ID), docs/frontend.md §4.4.4(닫힘 뒤 토큰 갱신·401이면 로그인)·§4.4.5(목록이 바뀌면 1초 묶어 위젯 흐름만),
// ADR-0360 결정 11(닫힌 뒤 갱신이 되면 1초 + 0~5초). 단언 값은 정본에서 가져오고 코드 상수를 옮기지 않는다.
// 실제 ops-svc 위 흐름은 services/ops-svc/test-int/ops-live.int.test.ts가 본다. Node 내장 시험 실행기로 .ts 원본을 그대로 읽는다.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 원본이 생성자 인자 속성을 써 타입 바꾸기 갈고리로 읽는다(live.test.resolve.mjs)
register('./live.test.resolve.mjs', import.meta.url);
const { ManagedStream } = await import('./live-stream.ts');
const { WidgetStreams, widgetStreamUrl } = await import('./widget-stream.ts');

const CANON = { silenceMs: 35_000, retryMs: 10_000, jitterMs: 5_000, reopenAfterCloseMs: 1_000, debounceMs: 1_000 };

/** 일을 다 비운다(시간이 아니라 대기 중인 Promise·I/O 차례만 돌린다) */
const drain = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
};

/** StreamTimers 가짜 시계: advance가 그 사이에 걸린 타이머를 차례로 부른다 */
class FakeTimers {
  now = 0;
  #queue = [];
  #id = 0;
  setTimeout = (fn, ms) => {
    this.#id += 1;
    this.#queue.push({ h: this.#id, at: this.now + ms, fn });
    return this.#id;
  };
  clearTimeout = (h) => {
    this.#queue = this.#queue.filter((t) => t.h !== h);
  };
  async advance(ms) {
    const end = this.now + ms;
    for (;;) {
      await drain();
      const due = this.#queue.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.h - b.h)[0];
      if (!due) break;
      this.#queue = this.#queue.filter((t) => t !== due);
      this.now = due.at;
      due.fn();
    }
    this.now = end;
    await drain();
  }
}

/** 가짜 SSE 서버: fetch를 받을 때마다 연결 하나(조각을 밀거나 닫거나 끊는다) */
function fakeServer() {
  const calls = [];
  const enc = new TextEncoder();
  let nextStatus = [];
  const fetch = async (url, init) => {
    const status = nextStatus.shift() ?? 200;
    const c = { url, init, queue: [], waiters: [], aborted: false, status };
    calls.push(c);
    init.signal.addEventListener('abort', () => {
      c.aborted = true;
      for (const w of c.waiters.splice(0)) w.reject(new DOMException('aborted', 'AbortError'));
    });
    const reader = {
      read: () =>
        new Promise((resolve, reject) => {
          if (c.queue.length) {
            const item = c.queue.shift();
            if (item.error) reject(item.error);
            else resolve(item);
          } else c.waiters.push({ resolve, reject });
        }),
      cancel: async () => undefined,
    };
    return { ok: status >= 200 && status < 300, status, body: { getReader: () => reader } };
  };
  const deliver = (c, item) => {
    const w = c.waiters.shift();
    if (!w) c.queue.push(item);
    else if (item.error) w.reject(item.error);
    else w.resolve(item);
  };
  return {
    calls,
    fetch,
    respondNext: (...statuses) => {
      nextStatus = statuses;
    },
    push: (c, text) => deliver(c, { done: false, value: enc.encode(text) }),
    end: (c) => deliver(c, { done: true }),
    fail: (c) => deliver(c, { error: new TypeError('network') }),
  };
}

function stream(o = {}) {
  const timers = new FakeTimers();
  const server = fakeServer();
  const frames = [];
  const opens = [];
  const statuses = [];
  const refresh = [];
  let unauthorized = 0;
  const s = new ManagedStream({
    url: () => 'https://ops-api.test/v1/ops/live',
    fetch: server.fetch,
    timers,
    random: o.random ?? (() => 0.5),
    refresh: async () => {
      refresh.push(timers.now);
      return o.refresh ?? 'ok';
    },
    onUnauthorized: () => {
      unauthorized += 1;
    },
    onFrame: (f) => frames.push(f),
    onOpen: (i) => opens.push(i),
    onStatus: (st) => statuses.push(st),
    resume: o.resume ?? true,
  });
  return { s, timers, server, frames, opens, statuses, refresh, unauthorized: () => unauthorized };
}

test('F-03-1 T3 FE-T28 ③-3 35초 동안 아무것도 오지 않으면 끊고(34,999ms에는 그대로) retry 10초 + 무작위 뒤 다시 연다', async () => {
  const w = stream({ random: () => 0.5 });
  w.s.start();
  await drain();
  const [c0] = w.server.calls;
  assert.equal(w.server.calls.length, 1);
  assert.equal(c0.init.credentials, 'include');
  assert.equal(c0.init.headers.accept, 'text/event-stream');
  w.server.push(c0, `retry: ${CANON.retryMs}\n\n`);
  await w.timers.advance(CANON.silenceMs - 1);
  assert.equal(c0.aborted, false);
  await w.timers.advance(1);
  assert.equal(c0.aborted, true);
  assert.equal(w.statuses.at(-1), 'retrying');
  // 무작위 0.5 → 10초 + 2.5초
  await w.timers.advance(CANON.retryMs + 0.5 * CANON.jitterMs - 1);
  assert.equal(w.server.calls.length, 1);
  await w.timers.advance(1);
  assert.equal(w.server.calls.length, 2);
  w.s.stop();
});

test('F-03-1 T3 FE-T28 ③-4 다시 열기 간격은 무작위 0이면 정확히 10초, 무작위가 1에 가까우면 15초 바로 앞이다', async () => {
  for (const [random, wait] of [
    [0, CANON.retryMs],
    [0.9998, CANON.retryMs + 0.9998 * CANON.jitterMs],
  ]) {
    const w = stream({ random: () => random });
    w.s.start();
    await drain();
    await w.timers.advance(CANON.silenceMs);
    assert.equal(w.server.calls[0].aborted, true, `무작위 ${random}: 35초에 끊는다`);
    await w.timers.advance(Math.ceil(wait) - 1);
    assert.equal(w.server.calls.length, 1, `무작위 ${random}: ${wait}ms 앞`);
    await w.timers.advance(1);
    assert.equal(w.server.calls.length, 2, `무작위 ${random}: ${wait}ms`);
    assert.ok(wait < CANON.retryMs + CANON.jitterMs);
    w.s.stop();
  }
});

test('F-03-1 T3 FE-T28 ③-5 주석 줄(: hb)도 받은 것으로 쳐 감시를 다시 건다', async () => {
  const w = stream();
  w.s.start();
  await drain();
  const [c0] = w.server.calls;
  await w.timers.advance(20_000);
  w.server.push(c0, ': hb\n\n');
  await w.timers.advance(CANON.silenceMs - 1);
  assert.equal(c0.aborted, false, '하트비트 뒤 34,999ms');
  await w.timers.advance(1);
  assert.equal(c0.aborted, true);
  w.s.stop();
});

test('F-03-1 T1 FE-T28 ①-2 네트워크가 끊기면 마지막으로 받은 id를 Last-Event-ID로 보내 다시 붙는다(첫 덩이의 id만 받은 경우 포함)', async () => {
  const w = stream({ random: () => 0 });
  w.s.start();
  await drain();
  const [c0] = w.server.calls;
  assert.equal(c0.init.headers['last-event-id'], undefined, '처음 연결은 머리가 없다');
  // 서버는 첫 덩이에 사건 없이 id만 둔다(ADR-0360 결정 2)
  w.server.push(c0, 'retry: 10000\nid: 42\n\n');
  await drain();
  w.server.fail(c0);
  await w.timers.advance(CANON.retryMs);
  const c1 = w.server.calls[1];
  assert.equal(c1.init.headers['last-event-id'], '42');
  // 두 번째 연결에서 사건 둘(같은 시각이어도 id는 순번이라 다르다)
  w.server.push(c1, 'retry: 10000\n\nid: 43\nevent: command\ndata: {"commandId":"c1","state":"ACKED"}\n\nid: 44\nevent: alert\ndata: {"alertId":"a1"}\n\n');
  await drain();
  assert.deepEqual(
    w.frames.map((f) => [f.lastEventId, f.event, JSON.parse(f.data)]),
    [
      ['43', 'command', { commandId: 'c1', state: 'ACKED' }],
      ['44', 'alert', { alertId: 'a1' }],
    ],
  );
  w.server.fail(c1);
  await w.timers.advance(CANON.retryMs);
  assert.equal(w.server.calls[2].init.headers['last-event-id'], '44');
  assert.deepEqual(
    w.opens.map((o) => o.reconnect),
    [false, true, true],
  );
  w.s.stop();
});

test('F-03-1 T1 FE-T28 ①-3 위젯 흐름(resume 없음)은 다시 붙을 때 Last-Event-ID를 보내지 않는다', async () => {
  const w = stream({ resume: false, random: () => 0 });
  w.s.start();
  await drain();
  w.server.push(w.server.calls[0], 'id: 1763000000000\nevent: widget\ndata: {"widgetKey":"k"}\n\n');
  await drain();
  w.server.fail(w.server.calls[0]);
  await w.timers.advance(CANON.retryMs);
  assert.equal(w.server.calls[1].init.headers['last-event-id'], undefined);
  w.s.stop();
});

test('F-03-1 T2 FE-T28 ②-3 reset 사건은 그대로 화면에 넘기고 그 id부터 다시 붙는다', async () => {
  const w = stream({ random: () => 0 });
  w.s.start();
  await drain();
  w.server.push(w.server.calls[0], 'retry: 10000\nid: 900\n\nid: 900\nevent: reset\ndata: {"reason":"too-old"}\n\n');
  await drain();
  assert.deepEqual(
    w.frames.map((f) => [f.event, JSON.parse(f.data)]),
    [['reset', { reason: 'too-old' }]],
  );
  w.server.fail(w.server.calls[0]);
  await w.timers.advance(CANON.retryMs);
  assert.equal(w.server.calls[1].init.headers['last-event-id'], '900');
  w.s.stop();
});

test('F-03-1 T4 FE-T28 ④-6 서버가 흐름을 닫으면 토큰을 갱신하고 1초 + 무작위 뒤 다시 붙는다(999ms에는 아직)', async () => {
  const w = stream({ random: () => 0 });
  w.s.start();
  await drain();
  w.server.push(w.server.calls[0], 'retry: 10000\nid: 5\n\n');
  w.server.end(w.server.calls[0]);
  await drain();
  assert.equal(w.refresh.length, 1);
  await w.timers.advance(CANON.reopenAfterCloseMs - 1);
  assert.equal(w.server.calls.length, 1);
  await w.timers.advance(1);
  assert.equal(w.server.calls.length, 2);
  assert.equal(w.server.calls[1].init.headers['last-event-id'], '5');
  assert.equal(w.unauthorized(), 0);
  w.s.stop();
});

test('F-03-1 T4 FE-T28 ④-7 열 때 401이어도 토큰을 갱신하고, 갱신이 401이면 로그인으로 가고 다시 열지 않는다', async () => {
  const ok = stream({ random: () => 0 });
  ok.server.respondNext(401);
  ok.s.start();
  await drain();
  assert.equal(ok.refresh.length, 1);
  await ok.timers.advance(CANON.reopenAfterCloseMs);
  assert.equal(ok.server.calls.length, 2);
  ok.s.stop();

  const w = stream({ random: () => 0, refresh: 'unauthorized' });
  w.s.start();
  await drain();
  w.server.end(w.server.calls[0]);
  await drain();
  assert.equal(w.unauthorized(), 1);
  assert.equal(w.statuses.at(-1), 'unauthorized');
  await w.timers.advance(10 * 60_000);
  assert.equal(w.server.calls.length, 1, '로그인으로 간 뒤에는 다시 열지 않는다');
  assert.equal(w.s.running, false);
});

/** 위젯 흐름 관리자의 흐름 만들기 대역: 연 주소와 닫힘을 적는다 */
function widgetWorld() {
  const timers = new FakeTimers();
  const opened = [];
  const ws = new WidgetStreams({
    origin: 'https://ops-api.test/',
    timers,
    createStream: (url, onFrame) => {
      const h = { url: url(), onFrame, started: 0, stopped: 0, start() {
        this.started += 1;
      }, stop() {
        this.stopped += 1;
      }, restart() {} };
      opened.push(h);
      return h;
    },
  });
  return { timers, opened, ws };
}

const Q = 'queue-admission-rate.summary';
const P = 'purchase-pg-status.summary';
const E = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';

test('F-03-1 T5 FE-T28 ⑤-1 보이는 위젯 목록이 바뀌면 1초 묶어 새 widgets로 한 번만 다시 연다(999ms에는 그대로)', async () => {
  const { timers, opened, ws } = widgetWorld();
  ws.setEvent(E);
  const offQ = ws.subscribe(Q, () => undefined);
  await timers.advance(CANON.debounceMs - 1);
  assert.equal(opened.length, 0);
  await timers.advance(1);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].url, `https://ops-api.test/v1/ops/events/${E}/live?widgets=${encodeURIComponent(Q)}`);
  // 1초 안에 셋이 바뀌면(넣기·빼기·넣기) 마지막 바뀜부터 1초 뒤 한 번
  const offP = ws.subscribe(P, () => undefined);
  await timers.advance(400);
  offP();
  await timers.advance(400);
  const offP2 = ws.subscribe(P, () => undefined);
  await timers.advance(CANON.debounceMs - 1);
  assert.equal(opened.length, 1);
  await timers.advance(1);
  assert.equal(opened.length, 2);
  assert.equal(opened[0].stopped, 1);
  assert.equal(opened[1].url, widgetStreamUrl('https://ops-api.test', E, [P, Q]));
  assert.equal(opened[1].url, `https://ops-api.test/v1/ops/events/${E}/live?widgets=${encodeURIComponent(`${P},${Q}`)}`);
  // 같은 키 구독이 하나 더 생겨도 목록이 같으면 다시 열지 않는다(같은 키는 한 흐름을 나눠 쓴다)
  const offQ2 = ws.subscribe(Q, () => undefined);
  await timers.advance(CANON.debounceMs);
  assert.equal(opened.length, 2);
  // 모두 떠나면 닫는다
  for (const off of [offQ, offQ2, offP2]) off();
  await timers.advance(CANON.debounceMs);
  assert.equal(opened.length, 2);
  assert.equal(opened[1].stopped, 1);
  assert.deepEqual(ws.openKeys, []);
});

test('F-03-1 T5 FE-T28 ⑤-2 회차를 바꾸면 묶지 않고 바로 새 회차로 다시 열고, 받은 값은 그 키 구독자에게만 간다', async () => {
  const { timers, opened, ws } = widgetWorld();
  ws.setEvent(E);
  const got = { q: [], p: [] };
  ws.subscribe(Q, (m) => got.q.push(m));
  ws.subscribe(P, (m) => got.p.push(m));
  await timers.advance(CANON.debounceMs);
  assert.equal(opened.length, 1);
  const F = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e02';
  ws.setEvent(F);
  assert.equal(opened.length, 2, '회차 바뀜은 바로');
  assert.ok(opened[1].url.includes(`/events/${F}/live`));
  assert.equal(opened[0].stopped, 1);
  assert.equal(ws.reopenCount, 2);
  opened[1].onFrame({ event: 'widget', lastEventId: '1', data: JSON.stringify({ widgetKey: Q, at: '2026-11-23T01:00:00.000Z', value: { ratio: 0.42 } }) });
  opened[1].onFrame({ event: 'presence', lastEventId: '1', data: JSON.stringify({ widgetKey: P }) });
  assert.deepEqual(got.q, [{ widgetKey: Q, at: '2026-11-23T01:00:00.000Z', value: { ratio: 0.42 } }]);
  assert.deepEqual(got.p, []);
});
