// 결제 시도·결제창 흐름 시험(SCR-011, docs/frontend.md §5.3, BUILD_ORDER HOT-358 리뷰 H1·H3·M2·M6·L13). 시도 행·멱등 재생을 서버처럼 흉내 내는 가짜 API로 돌린다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'node:module';

register('../../../shared/lib/test-ts-resolve.mjs', import.meta.url);
const { createAttemptFlow } = await import('./attempt-flow.ts');
const { PaymentWindowError } = await import('../windows/index.ts');

class Problem extends Error {
  constructor(p) {
    super('problem');
    this.p = p;
  }
}

function fakeServer(pg = 'TOSS') {
  const s = { rows: [], keys: new Map(), next: [], pg };
  s.start = async (body, key) => {
    const queued = s.next.shift();
    if (queued) throw new Problem(queued);
    const fp = JSON.stringify(body);
    const seen = s.keys.get(key);
    if (seen) {
      if (seen.fp !== fp) throw new Problem({ status: 422, type: 'idempotency-key-reused' });
      return { data: seen.attempt, date: null };
    }
    if (s.rows.length >= 3) throw new Problem({ status: 409, type: 'payment-attempts-exceeded' });
    const attempt = { attemptId: `a${s.rows.length + 1}`, pg: s.pg, allowedPayMethods: ['CARD', 'TRANSFER'], checkout: { orderId: 'o' }, method: body.payMethod ?? 'CARD' };
    s.rows.push(attempt);
    s.keys.set(key, { fp, attempt });
    return { data: attempt, date: null };
  };
  return s;
}

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m };
}

function harness(server, over = {}) {
  const storage = over.storage ?? memoryStorage();
  const log = { windows: [], pays: [], ended: 0, gone: 0, accepted: 0, deadlines: [], sdk: [], timers: [] };
  let keyNo = over.keyStart ?? 0;
  const payResult = over.payResult ?? (() => undefined);
  const api = {
    start: server.start,
    refresh: async () => 'ok',
    loadWindow: async (a) => {
      log.windows.push(a.attemptId);
      return {
        mount: over.mount ?? (async () => {}),
        pay: async (o) => {
          log.pays.push({ attemptId: a.attemptId, attemptMethod: a.method, ...o });
          if (over.hang) await new Promise(() => {});
          const r = payResult(log.pays.length);
          if (r) throw r;
        },
      };
    },
    problem: (e) => (e instanceof Problem ? e.p : { ...(e?.keyLost ? { keyLost: e.keyLost } : {}) }),
    windowFailureOf: (e) => (e instanceof PaymentWindowError ? e.reason : 'failed'),
  };
  const flow = createAttemptFlow({
    orderId: 'o1',
    storage,
    api,
    container: { methods: '#m', agreement: '#a' },
    makeKey: () => `k${storage.m.size}-${(keyNo += 1)}`,
    random: () => 0.5,
    setTimer: (f, ms) => {
      log.timers.push({ f, ms });
      return log.timers.length;
    },
    clearTimer: () => {},
    hooks: {
      ended: () => (log.ended += 1),
      gone: () => (log.gone += 1),
      accepted: () => (log.accepted += 1),
      deadline: (ms, frozen) => log.deadlines.push([ms, frozen]),
      sdkLoadFailed: (pg) => log.sdk.push(pg),
    },
  });
  return { flow, log, storage };
}

test('P-T25 H1 결제창을 열지 않은 새로고침은 시도 행을 늘리지 않는다(같은 키 재생)', async () => {
  const server = fakeServer();
  const storage = memoryStorage();
  for (let i = 0; i < 5; i += 1) await harness(server, { storage, keyStart: i * 100 }).flow.start();
  assert.equal(server.rows.length, 1);
});

test('P-T25 H1 결제창을 연 뒤 실패로 돌아오면 새 시도이고, 세 번 뒤 네 번째는 멈춘다(d5 결제창 실패 3회 넘음)', async () => {
  const server = fakeServer();
  const storage = memoryStorage();
  for (let i = 0; i < 3; i += 1) {
    const { flow, log } = harness(server, { storage, keyStart: i * 100 });
    await flow.start();
    await flow.pay();
    assert.equal(log.pays.length, 1);
  }
  assert.equal(server.rows.length, 3);
  const last = harness(server, { storage, keyStart: 900 });
  await last.flow.start();
  assert.equal(last.flow.view().status, 'exceeded');
  assert.equal(server.rows.length, 3);
});

test('P-T25 H1 고른 수단이 400으로 거절되면 키를 되돌려 원래 수단은 같은 키를 다시 쓴다(행이 늘지 않는다)', async () => {
  const server = fakeServer();
  const { flow } = harness(server);
  await flow.start('CARD');
  assert.equal(server.rows.length, 1);
  server.next.push({ status: 400, type: 'about:blank' });
  await flow.start('TRANSFER');
  assert.equal(server.rows.length, 1);
  await flow.start('CARD');
  assert.equal(server.rows.length, 1);
});

test('P-T25 H1 결제 버튼을 두 번 눌러도 결제창은 한 번만 연다(진행 중에는 무시한다)', async () => {
  const server = fakeServer();
  const { flow, log } = harness(server, { hang: true });
  await flow.start();
  void flow.pay();
  await Promise.resolve();
  void flow.pay();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(log.pays.length, 1);
});

test('H1 늦게 온 앞 시작의 답은 버린다: 뒤 시작의 시도를 덮어쓰지 않는다', async () => {
  const server = fakeServer();
  const gates = [];
  const realStart = server.start;
  server.start = async (body, key) => {
    await new Promise((resolve) => gates.push(resolve));
    return realStart(body, key);
  };
  const { flow } = harness(server);
  const first = flow.start('CARD');
  await new Promise((r) => setTimeout(r, 0));
  const second = flow.start('TRANSFER');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(gates.length, 2);
  gates[1]();
  await second;
  const winner = flow.view().attempt;
  assert.equal(winner?.method, 'TRANSFER');
  gates[0]();
  await first;
  assert.equal(flow.view().attempt?.attemptId, winner.attemptId);
});

test('P-T25 H1 같은 화면의 결제창 취소도 시도 하나를 쓰고 새 시도로 다시 할 수 있다', async () => {
  const server = fakeServer();
  const { flow } = harness(server, { payResult: () => new PaymentWindowError('cancelled') });
  await flow.start();
  await flow.pay();
  assert.equal(server.rows.length, 2);
  assert.equal(flow.view().attempt.attemptId, 'a2');
});

test('P-T25 H1 결제창을 열기 전 실패(스크립트·값)는 시도를 쓰지 않는다', async () => {
  const server = fakeServer();
  const storage = memoryStorage();
  const a = harness(server, { storage, payResult: () => new PaymentWindowError('not-opened') });
  await a.flow.start();
  await a.flow.pay();
  assert.equal(server.rows.length, 1);
  await harness(server, { storage, keyStart: 100 }).flow.start();
  assert.equal(server.rows.length, 1);
});

test('P-T25 H1 포트원: 바꾼 수단은 실패 복귀·새로고침에도 이어져 행을 더 쓰지 않는다', async () => {
  const server = fakeServer('PORTONE');
  const storage = memoryStorage();
  const first = harness(server, { storage });
  await first.flow.start();
  first.flow.selectMethod('TRANSFER');
  await first.flow.pay();
  assert.equal(server.rows.length, 2);
  assert.equal(first.log.pays.at(-1).attemptMethod, 'TRANSFER');
  const back = harness(server, { storage, keyStart: 100 });
  await back.flow.start();
  assert.equal(back.flow.view().method, 'TRANSFER');
  await back.flow.pay();
  assert.equal(server.rows.length, 3);
  assert.equal(back.log.pays.length, 1);
  assert.equal(back.log.pays[0].attemptMethod, 'TRANSFER');
});

test('M2 수단을 바꾼 시도가 503이면 옛 결제창을 열지 않는다', async () => {
  const server = fakeServer('PORTONE');
  const { flow, log } = harness(server);
  await flow.start();
  flow.selectMethod('TRANSFER');
  server.next.push({ status: 503, type: 'pg-unavailable' });
  await flow.pay();
  assert.equal(log.pays.length, 0);
});

test('M2 수단 A→B→A: 비교는 현재 시도의 수단과 하고, B 시도의 창으로 A를 결제하지 않는다', async () => {
  const server = fakeServer('PORTONE');
  const { flow, log } = harness(server, { payResult: (n) => (n === 1 ? new PaymentWindowError('not-opened') : undefined) });
  await flow.start();
  flow.selectMethod('TRANSFER');
  await flow.pay();
  assert.equal(log.pays[0].attemptMethod, 'TRANSFER');
  flow.selectMethod('CARD');
  await flow.pay();
  assert.equal(log.pays.length, 2);
  assert.equal(log.pays[1].attemptMethod, 'CARD');
});

test('M2 서버가 수단을 거절하면(400) 결제창을 열지 않고 고를 수 없다고 알린다', async () => {
  const server = fakeServer('PORTONE');
  const { flow, log } = harness(server);
  await flow.start();
  flow.selectMethod('TRANSFER');
  server.next.push({ status: 400, type: 'pay-method-invalid' });
  await flow.pay();
  assert.equal(log.pays.length, 0);
  assert.match(flow.view().notice.text, /고를 수 없는/);
});

test('M6 위젯을 그리기 전에는 결제를 시작하지 않는다', async () => {
  const server = fakeServer();
  let release;
  const { flow, log } = harness(server, { mount: () => new Promise((f) => (release = f)) });
  const started = flow.start();
  await new Promise((f) => setImmediate(f));
  assert.equal(flow.view().windowReady, false);
  await flow.pay();
  assert.equal(log.pays.length, 0);
  release();
  await started;
  assert.equal(flow.view().windowReady, true);
});

test('M6 G-25 위젯을 싣지 못하면 sdk_load_failed를 알리고 다시 시도할 수 있다', async () => {
  const server = fakeServer();
  let fail = true;
  const { flow, log } = harness(server, {
    mount: async () => {
      if (fail) throw new PaymentWindowError('failed');
    },
  });
  await flow.start();
  assert.equal(flow.view().windowReady, false);
  assert.equal(flow.view().windowFailed, true);
  assert.deepEqual(log.sdk, ['TOSS']);
  fail = false;
  await flow.retryWindow();
  assert.equal(flow.view().windowReady, true);
  assert.equal(flow.view().windowFailed, false);
  assert.equal(server.rows.length, 1);
});

test('H3 S-T23 새 결제 일시 정지(503)면 남은 시간을 멈춘 값으로 알리고 만료로 보지 않는다', async () => {
  const server = fakeServer();
  const { flow, log } = harness(server);
  server.next.push({ status: 503, type: 'new-payment-paused', extensions: { holdRemainingSeconds: 180 }, retryAfterSeconds: 7 });
  await flow.start();
  assert.deepEqual(log.deadlines.at(-1), [180_000, true]);
  assert.equal(flow.view().status, 'paused');
  assert.equal(log.gone, 0);
});

test('L13 일시 정지의 자동 재시도는 하한 위로 흩뿌리고, 성공하면 멈춤을 푼다', async () => {
  const server = fakeServer();
  const { flow, log } = harness(server);
  server.next.push({ status: 503, type: 'new-payment-paused', retryAfterSeconds: 10 });
  await flow.start();
  assert.equal(log.timers.at(-1).ms, 11_000);
  await log.timers.at(-1).f();
  await new Promise((f) => setImmediate(f));
  assert.equal(flow.view().status, 'idle');
});

test('L13 PurchaseKeyError: 키가 없으면 세션 끝, 저장소 문제면 다시 시도다', async () => {
  const a = fakeServer();
  a.start = async () => {
    throw { keyLost: 'ended' };
  };
  const ended = harness(a);
  await ended.flow.start();
  assert.equal(ended.log.ended, 1);
  const b = fakeServer();
  b.start = async () => {
    throw { keyLost: 'storage' };
  };
  const stored = harness(b);
  await stored.flow.start();
  assert.equal(stored.log.ended, 0);
  assert.equal(stored.flow.view().status, 'unavailable');
});

test('L13 bfcache로 돌아오면 busy가 풀리고 새 시도를 준비한다', async () => {
  const server = fakeServer();
  const { flow } = harness(server, { hang: true });
  await flow.start();
  void flow.pay();
  await new Promise((f) => setImmediate(f));
  assert.equal(flow.view().busy, true);
  await flow.pageShown(true);
  assert.equal(flow.view().busy, false);
  assert.equal(server.rows.length, 2);
});
