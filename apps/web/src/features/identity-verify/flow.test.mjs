// 본인확인 창 흐름의 브라우저 쪽(docs/features/identity.md §5 '모의 기관과 기관 창 흐름', BUILD_ORDER BOT-010, I-T45, [ASVS v5.0.0-3.5.5]).
// 창·BroadcastChannel·시계·API를 대역으로 바꿔 부르는 화면과 복귀 화면의 흐름을 처음부터 끝까지 돌린다(실제 브라우저 E2E는 화면 묶음 뒤, docs/architecture.md §8.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACK_WAIT_MS,
  CLOSE_FALLBACK_MS,
  CLOSED_GRACE_MS,
  createVerifyApi,
  isResultMessage,
  outcomeOfStatus,
  RETURN_STORAGE_KEY,
  REFRESH_RETRY_MS,
  RETURN_TTL_MS,
  resumeReturnedResult,
  runReturnFlow,
  startCallerFlow,
  VERIFY_WINDOW_NAME,
} from './flow.ts';

const ID = '0190f3a1-7c2e-7a00-8000-00000000b001';
const OTHER = '0190f3a1-7c2e-7a00-8000-00000000b002';
const AGENCY = { url: 'http://127.0.0.1:18920/verify', method: 'POST', fields: { verificationId: ID }, mode: 'POPUP' };

const flush = () => new Promise((r) => setImmediate(r));

/** 저절로 흐르지 않는 시계: sleep은 advance로만 끝난다. 신호(AbortSignal)가 끊기면 그 기다림을 지우고 바로 끝낸다 */
function fakeTime() {
  let now = 0;
  const waits = [];
  return {
    sleep: (ms, signal) =>
      new Promise((r) => {
        if (signal?.aborted) return r();
        const w = { at: now + ms, r };
        waits.push(w);
        signal?.addEventListener(
          'abort',
          () => {
            const i = waits.indexOf(w);
            if (i >= 0) waits.splice(i, 1);
            r();
          },
          { once: true },
        );
      }),
    /** 아직 끝나지 않은 기다림 수(지우지 않은 타이머) */
    pending: () => waits.length,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await flush();
        waits.sort((a, b) => a.at - b.at);
        const w = waits[0];
        if (!w || w.at > end) break;
        waits.shift();
        now = w.at;
        w.r();
      }
      now = end;
      await flush();
    },
  };
}

/** 같은 출처의 BroadcastChannel 흉내: 보낸 쪽을 뺀 같은 이름의 채널에 비동기로 건넨다 */
function fakeBus() {
  const open = new Set();
  const sent = [];
  return {
    sent,
    channel() {
      const ch = {
        onmessage: null,
        closed: false,
        postMessage(data) {
          sent.push({ from: ch, data: structuredClone(data) });
          for (const other of open) if (other !== ch && !other.closed) setImmediate(() => other.onmessage?.({ data: structuredClone(data) }));
        },
        close() {
          ch.closed = true;
          open.delete(ch);
        },
      };
      open.add(ch);
      return ch;
    },
    /** 바깥(다른 창·공격 코드)에서 보내기 */
    inject(data) {
      const ch = this.channel();
      ch.postMessage(data);
      ch.close();
    },
  };
}

function fakeWindow() {
  return {
    closed: false,
    close() {
      this.closed = true;
    },
  };
}

/** 기다리지 않는 sleep(갱신 다시 하기 간격을 건너뛴다) */
const noWait = async () => {};

/** 응답을 차례로 꺼내는 API 대역 */
function fakeApi(plan) {
  const calls = [];
  const take = (name) => {
    const q = plan[name];
    if (!q || q.length === 0) throw new Error(`계획에 없는 호출: ${name}`);
    return q.shift();
  };
  return {
    calls,
    start: async (next, purpose) => (calls.push(['start', next, purpose]), take('start')),
    confirm: async (id, fields) => (calls.push(['confirm', id, fields]), take('confirm')),
    result: async (id) => (calls.push(['result', id]), take('result')),
    refresh: async () => (calls.push(['refresh']), take('refresh')),
  };
}

const body = (status, next = '/events/e-1') => ({ kind: 'result', body: { verificationId: ID, purpose: 'FIRST', status, next, restrictedUntil: null } });

function callerEnv({ win = fakeWindow(), api, bus = fakeBus(), time = fakeTime(), path = '/events/e-1' } = {}) {
  const log = { submitted: [], opened: [], login: [], done: [], channels: [] };
  return {
    log,
    bus,
    time,
    win,
    /** 부르는 화면의 채널이 보낸 것 */
    callerSent: () => bus.sent.filter((x) => log.channels.includes(x.from)).map((x) => x.data),
    env: {
      api,
      openWindow: (name, features) => (log.opened.push([name, features]), win),
      channel: () => {
        const ch = bus.channel();
        log.channels.push(ch);
        return ch;
      },
      submitForm: (target, w) => log.submitted.push([target, w]),
      sleep: time.sleep,
      currentPath: () => path,
      goLogin: (next) => log.login.push(next),
    },
  };
}

test('I-T45 ①팝업 완료: 이름 붙인 창에 양식을 내고, 맞는 메시지에 받은 표시를 돌려준 뒤 결과 조회로 완료를 보인다 [ASVS v5.0.0-3.5.5]', async () => {
  const api = fakeApi({ start: [{ kind: 'started', id: ID, window: AGENCY }], result: [body('VERIFIED')] });
  const c = callerEnv({ api });
  const done = [];
  const waiting = [];
  startCallerFlow(c.env, { purpose: 'FIRST', onWaiting: () => waiting.push(1), onDone: (o) => done.push(o) });
  assert.equal(c.log.opened[0][0], VERIFY_WINDOW_NAME);
  await c.time.advance(0);
  assert.deepEqual(api.calls[0], ['start', '/events/e-1', 'FIRST']);
  assert.deepEqual(c.log.submitted, [[VERIFY_WINDOW_NAME, AGENCY]]);
  assert.equal(waiting.length, 1);
  // 복귀 화면(팝업)이 결과를 알린다
  const popup = c.bus.channel();
  const acks = [];
  popup.onmessage = (e) => acks.push(e.data);
  popup.postMessage({ type: 'result', verificationId: ID, status: 'VERIFIED' });
  await c.time.advance(10);
  assert.deepEqual(acks, [{ type: 'ack', verificationId: ID }]);
  assert.deepEqual(done, ['success']);
  assert.deepEqual(api.calls.map((x) => x[0]), ['start', 'result']);
});

test('I-T45 ②팝업을 닫음: 메시지 없이 창이 닫히면 1초 뒤 결과 조회로 확인하고, 아직 처리 중이면 창을 닫음·실패다', async () => {
  const api = fakeApi({ start: [{ kind: 'started', id: ID, window: AGENCY }], result: [body('PENDING')] });
  const c = callerEnv({ api });
  const done = [];
  startCallerFlow(c.env, { purpose: 'FIRST', onWaiting() {}, onDone: (o) => done.push(o) });
  await c.time.advance(0);
  c.win.closed = true;
  await c.time.advance(600);
  assert.deepEqual(done, [], '닫힌 뒤 1초는 메시지를 더 기다린다');
  await c.time.advance(CLOSED_GRACE_MS);
  assert.deepEqual(done, ['closed']);
});

test('I-T45 ②창이 닫혔는데 결과가 VERIFIED면(메시지를 놓침) 완료이고 토큰을 한 번 갱신한다', async () => {
  const api = fakeApi({ start: [{ kind: 'started', id: ID, window: AGENCY }], result: [body('VERIFIED')], refresh: ['ok'] });
  const c = callerEnv({ api });
  const done = [];
  startCallerFlow(c.env, { purpose: 'FIRST', onWaiting() {}, onDone: (o) => done.push(o) });
  await c.time.advance(0);
  c.win.closed = true;
  await c.time.advance(2000);
  assert.deepEqual(done, ['success']);
  assert.deepEqual(api.calls.map((x) => x[0]), ['start', 'result', 'refresh']);
});

test('I-T45 ③팝업 차단: 창을 받지 못하거나 바로 닫혔으면 지금 창에 기관 양식을 낸다(대화상자 없음)', async () => {
  for (const win of [null, Object.assign(fakeWindow(), { closed: true })]) {
    const api = fakeApi({ start: [{ kind: 'started', id: ID, window: AGENCY }] });
    const c = callerEnv({ api, win });
    const done = [];
    startCallerFlow(c.env, { purpose: 'FIRST', onWaiting() {}, onDone: (o) => done.push(o) });
    await c.time.advance(5000);
    assert.deepEqual(c.log.submitted, [['_self', AGENCY]]);
    assert.deepEqual(done, []);
  }
});

test('I-T45 ④페이지 이동 방식 기관(REDIRECT)이면 미리 연 창을 닫고 지금 창에 양식을 낸다', async () => {
  const api = fakeApi({ start: [{ kind: 'started', id: ID, window: { ...AGENCY, mode: 'REDIRECT' } }] });
  const c = callerEnv({ api });
  startCallerFlow(c.env, { purpose: 'FIRST', onWaiting() {}, onDone() {} });
  await c.time.advance(0);
  assert.equal(c.win.closed, true);
  assert.deepEqual(c.log.submitted, [['_self', { ...AGENCY, mode: 'REDIRECT' }]]);
});

test('I-T45 ⑥형식이 틀리거나 다른 건의 메시지는 버리고(받은 표시 없음), 화면은 결과 조회 API 값만 따른다 [ASVS v5.0.0-3.5.5]', async () => {
  const api = fakeApi({ start: [{ kind: 'started', id: ID, window: AGENCY }], result: [body('FAILED')] });
  const c = callerEnv({ api });
  const done = [];
  startCallerFlow(c.env, { purpose: 'FIRST', onWaiting() {}, onDone: (o) => done.push(o) });
  await c.time.advance(0);
  for (const bad of [
    'VERIFIED',
    null,
    { type: 'result', verificationId: OTHER, status: 'VERIFIED' },
    { type: 'result', verificationId: ID },
    { type: 'result', verificationId: ID, status: 'OWNED' },
    { type: 'result', verificationId: ID, status: 'VERIFIED', next: '//evil.example' },
    { type: 'ack', verificationId: ID },
  ])
    c.bus.inject(bad);
  await c.time.advance(10);
  assert.deepEqual(c.callerSent(), [], '버린 메시지에는 받은 표시를 보내지 않는다');
  assert.deepEqual(done, []);
  assert.deepEqual(api.calls.map((x) => x[0]), ['start']);
  // 맞는 꼴의 메시지가 VERIFIED라고 해도 화면은 조회 값(FAILED)을 따른다
  c.bus.inject({ type: 'result', verificationId: ID, status: 'VERIFIED' });
  await c.time.advance(10);
  assert.deepEqual(c.callerSent(), [{ type: 'ack', verificationId: ID }]);
  assert.deepEqual(done, ['closed']);
});

test('I-T45 시작이 막히면 미리 연 창을 닫는다: 401은 로그인(돌아올 주소는 부르는 화면), 이미 본인확인은 완료, 기관 장애는 기관 장애다', async () => {
  for (const [start, want] of [
    [{ kind: 'login' }, 'login'],
    [{ kind: 'already' }, 'success'],
    // 만 14세 미만으로 정리 중인 계정(BOT-020): 시작이 403 under-14
    [{ kind: 'under14' }, 'under14'],
    [{ kind: 'down' }, 'down'],
    [{ kind: 'error' }, 'down'],
  ]) {
    const api = fakeApi({ start: [start], refresh: ['ok'] });
    const c = callerEnv({ api, path: '/events/e-9?tab=info' });
    const done = [];
    startCallerFlow(c.env, { purpose: 'FIRST', onWaiting() {}, onDone: (o) => done.push(o) });
    await c.time.advance(0);
    assert.equal(c.win.closed, true);
    assert.deepEqual(c.log.submitted, []);
    if (want === 'login') assert.deepEqual(c.log.login, ['/events/e-9?tab=info']);
    else assert.deepEqual(done, [want]);
  }
});

test('[ASVS v5.0.0-3.7.2] I-T45 ⑤시작 요청의 next는 safeNext()를 거친 같은 출처 경로다', async () => {
  for (const [path, want] of [
    ['/events/e-1?x=1', '/events/e-1?x=1'],
    ['//evil.example/a', '/'],
    ['/a\\b', '/'],
  ]) {
    const api = fakeApi({ start: [{ kind: 'down' }] });
    const c = callerEnv({ api, path });
    startCallerFlow(c.env, { purpose: 'REVERIFY', onWaiting() {}, onDone() {} });
    await c.time.advance(0);
    assert.deepEqual(api.calls[0], ['start', want, 'REVERIFY']);
  }
});

function returnEnv({ api, bus = fakeBus(), time = fakeTime(), search = '', now = () => 5_000 } = {}) {
  const log = { order: [], navigated: [], closed: 0, replaced: [], storage: new Map() };
  return {
    log,
    bus,
    time,
    env: {
      api: {
        ...api,
        confirm: async (...a) => (log.order.push('confirm'), api.confirm(...a)),
      },
      channel: () => bus.channel(),
      sleep: time.sleep,
      search: () => search,
      replaceUrl: (p) => (log.order.push('replaceUrl'), log.replaced.push(p)),
      closeWindow: () => log.closed++,
      navigate: (p) => log.navigated.push(p),
      now,
      storage: {
        get: (k) => log.storage.get(k) ?? null,
        set: (k, v) => log.storage.set(k, v),
        remove: (k) => log.storage.delete(k),
      },
    },
  };
}

const SEALED = { verificationId: ID, result: 'eyJ2IjoxfQ', mac: 'm'.repeat(43) };

test('I-T45 ①복귀 화면(팝업): 받은 칸 그대로 결과 경로에 보내고, VERIFIED면 토큰을 갱신한 뒤 알리며, 받은 표시가 오면 창을 닫는다', async () => {
  const api = fakeApi({ confirm: [body('VERIFIED')], refresh: ['ok'] });
  const r = returnEnv({ api });
  const caller = r.bus.channel();
  caller.onmessage = (e) => {
    if (isResultMessage(e.data, ID)) caller.postMessage({ type: 'ack', verificationId: ID });
  };
  const run = runReturnFlow(r.env, SEALED);
  await r.time.advance(50);
  await run;
  assert.deepEqual(api.calls[0], ['confirm', ID, SEALED]);
  assert.deepEqual(api.calls.map((x) => x[0]), ['confirm', 'refresh']);
  const posted = r.bus.sent.filter((s) => s.from !== caller).map((s) => s.data);
  assert.deepEqual(posted, [{ type: 'result', verificationId: ID, status: 'VERIFIED' }]);
  assert.equal(r.log.closed, 1);
  assert.deepEqual(r.log.navigated, []);
});

test('I-T45 쿼리 복귀: 주소의 기관 값을 읽자마자 주소에서 지운 뒤에 보낸다 [ASVS v5.0.0-14.2.1]', async () => {
  const api = fakeApi({ confirm: [body('CANCELLED')] });
  const q = new URLSearchParams(SEALED).toString();
  const r = returnEnv({ api, search: `?${q}` });
  const run = runReturnFlow(r.env, null);
  await r.time.advance(ACK_WAIT_MS + 10);
  await run;
  assert.deepEqual(r.log.replaced, ['/verify/return']);
  assert.deepEqual(r.log.order.slice(0, 2), ['replaceUrl', 'confirm']);
  assert.deepEqual(api.calls[0], ['confirm', ID, SEALED]);
});

test('I-T45 ③④받은 표시가 없으면(페이지 이동) 건 ID와 남긴 시각만 탭 저장소에 두고 결과의 next로 간다', async () => {
  const api = fakeApi({ confirm: [body('VERIFIED', '/events/e-7')], refresh: ['ok'] });
  const r = returnEnv({ api });
  const run = runReturnFlow(r.env, SEALED);
  await r.time.advance(ACK_WAIT_MS - 1);
  assert.deepEqual(r.log.navigated, []);
  await r.time.advance(2);
  await run;
  assert.equal(r.log.closed, 0);
  assert.deepEqual(r.log.navigated, ['/events/e-7']);
  assert.deepEqual(JSON.parse(r.log.storage.get(RETURN_STORAGE_KEY)), { id: ID, at: 5_000, refreshed: true });
});

test('I-T45 결과 경로가 409·503이면 결과 조회로 next를 받아 같은 길로 간다', async () => {
  for (const confirm of [{ kind: 'duplicate' }, { kind: 'down' }]) {
    const api = fakeApi({ confirm: [confirm], result: [body(confirm.kind === 'duplicate' ? 'DUPLICATE_ACCOUNT' : 'PROVIDER_DOWN', '/my/settings')] });
    const r = returnEnv({ api });
    const run = runReturnFlow(r.env, SEALED);
    await r.time.advance(ACK_WAIT_MS + 10);
    await run;
    assert.deepEqual(api.calls.map((x) => x[0]), ['confirm', 'result']);
    assert.deepEqual(r.log.navigated, ['/my/settings']);
    const status = r.bus.sent.map((s) => s.data.status);
    assert.deepEqual(status, [confirm.kind === 'duplicate' ? 'DUPLICATE_ACCOUNT' : 'PROVIDER_DOWN']);
  }
});

test('[ASVS v5.0.0-3.7.2] I-T45 기관 값이 없거나 건 ID 모양이 틀리거나 next가 다른 출처면 첫 화면으로 간다', async () => {
  const none = returnEnv({ api: fakeApi({}) });
  await runReturnFlow(none.env, null);
  assert.deepEqual(none.log.navigated, ['/']);
  const bad = returnEnv({ api: fakeApi({}) });
  await runReturnFlow(bad.env, { verificationId: '../x', result: 'a', mac: 'b' });
  assert.deepEqual(bad.log.navigated, ['/']);
  const evil = returnEnv({ api: fakeApi({ confirm: [body('FAILED', '//evil.example')] }) });
  const run = runReturnFlow(evil.env, SEALED);
  await evil.time.advance(ACK_WAIT_MS + 10);
  await run;
  assert.deepEqual(evil.log.navigated, ['/']);
  const lost = returnEnv({ api: fakeApi({ confirm: [{ kind: 'notFound' }], result: [{ kind: 'notFound' }] }) });
  await runReturnFlow(lost.env, SEALED);
  assert.deepEqual(lost.log.navigated, ['/']);
});

test('I-T45 ③④부르는 화면이 다시 열리면 탭 저장소의 건 ID를 지우고 결과 조회로 대화상자를 정한다', async () => {
  const api = fakeApi({ result: [body('DUPLICATE_ACCOUNT')] });
  const saved = (id, at = 1_000) => JSON.stringify({ id, at });
  const storage = new Map([[RETURN_STORAGE_KEY, saved(ID)]]);
  const s = { get: (k) => storage.get(k) ?? null, set: (k, v) => storage.set(k, v), remove: (k) => storage.delete(k) };
  const now = () => 2_000;
  assert.equal(await resumeReturnedResult({ api, storage: s, now, sleep: noWait }), 'other');
  assert.equal(storage.has(RETURN_STORAGE_KEY), false);
  assert.equal(await resumeReturnedResult({ api, storage: s, now, sleep: noWait }), null);
  for (const bad of [saved('not-a-uuid'), 'not-json', ID]) {
    storage.set(RETURN_STORAGE_KEY, bad);
    assert.equal(await resumeReturnedResult({ api: fakeApi({}), storage: s, now, sleep: noWait }), null, bad);
    assert.equal(storage.has(RETURN_STORAGE_KEY), false);
  }
});

test('I-T45 ③④부르는 화면은 남긴 지 1분 안의 복귀 건만 믿는다: next가 본인확인 부품이 없는 화면이라 남은 값으로 나중에 다른 화면에서 지난 결과가 뜨지 않는다(BOT-010이 넘긴 것)', async () => {
  const storage = new Map();
  const s = { get: (k) => storage.get(k) ?? null, set: (k, v) => storage.set(k, v), remove: (k) => storage.delete(k) };
  // 1분이 지났거나 남긴 시각이 앞날이면 부르지 않고 지운다
  for (const at of [1_000 - RETURN_TTL_MS - 1, 1_001]) {
    storage.set(RETURN_STORAGE_KEY, JSON.stringify({ id: ID, at }));
    assert.equal(await resumeReturnedResult({ api: fakeApi({}), storage: s, now: () => 1_000, sleep: noWait }), null, String(at));
    assert.equal(storage.has(RETURN_STORAGE_KEY), false);
  }
  storage.set(RETURN_STORAGE_KEY, JSON.stringify({ id: ID, at: 1_000 - RETURN_TTL_MS, refreshed: true }));
  assert.equal(await resumeReturnedResult({ api: fakeApi({ result: [body('VERIFIED')] }), storage: s, now: () => 1_000, sleep: noWait }), 'success');
  assert.ok(RETURN_TTL_MS <= 60_000, '짧은 기한(1분 [가정])');
});

test('I-T45 복귀 화면에서 결과 확정이 401이고 갱신도 안 되면, 처리 중을 알리고 로그인 화면의 돌아올 주소는 첫 화면이다(기관 값을 잃는 복귀 화면이 아니다, BOT-010이 넘긴 것)', async () => {
  // 페이지 이동(받은 표시 없음): 로그인 화면으로, 저장소에는 남기지 않는다
  const api = fakeApi({ confirm: [{ kind: 'login' }] });
  const r = returnEnv({ api });
  const run = runReturnFlow(r.env, SEALED);
  await r.time.advance(ACK_WAIT_MS + 10);
  await run;
  assert.deepEqual(r.bus.sent.map((x) => x.data), [{ type: 'result', verificationId: ID, status: 'PENDING' }]);
  assert.deepEqual(r.log.navigated, ['/login?next=%2F']);
  assert.equal(r.log.storage.size, 0);
  assert.deepEqual(api.calls.map((x) => x[0]), ['confirm']);
  // 팝업(받은 표시가 옴): 창을 닫는다. 부르는 화면이 결과 조회로 '창을 닫음·실패'나 로그인(돌아올 주소는 부르는 화면)을 정한다
  const p = returnEnv({ api: fakeApi({ confirm: [{ kind: 'login' }] }) });
  const caller = p.bus.channel();
  caller.onmessage = (e) => {
    if (isResultMessage(e.data, ID)) caller.postMessage({ type: 'ack', verificationId: ID });
  };
  const run2 = runReturnFlow(p.env, SEALED);
  await p.time.advance(50);
  await run2;
  assert.equal(p.log.closed, 1);
  assert.deepEqual(p.log.navigated, []);
  await p.time.advance(CLOSE_FALLBACK_MS);
  assert.deepEqual(p.log.navigated, ['/login?next=%2F'], '닫을 수 없는 창이면 잠시 뒤 로그인 화면으로');
});

test('I-T45 부르는 화면은 복귀 화면이 알린 처리 중에 받은 표시를 돌려주고, 결과 조회가 로그인이면 부르는 화면을 돌아올 주소로 로그인 화면에 간다(BOT-010이 넘긴 것)', async () => {
  const api = fakeApi({ start: [{ kind: 'started', id: ID, window: AGENCY }], result: [{ kind: 'login' }] });
  const c = callerEnv({ api, path: '/events/e-3' });
  const done = [];
  startCallerFlow(c.env, { purpose: 'FIRST', onWaiting() {}, onDone: (o) => done.push(o) });
  await c.time.advance(0);
  c.bus.inject({ type: 'result', verificationId: ID, status: 'PENDING' });
  await c.time.advance(10);
  assert.deepEqual(c.callerSent(), [{ type: 'ack', verificationId: ID }]);
  assert.deepEqual(c.log.login, ['/events/e-3']);
  assert.deepEqual(done, []);
});

test('I-T45 결과 값마다 결과 대화상자가 정해져 있다(d5 §5.6 상태 표)', () => {
  assert.deepEqual(
    ['VERIFIED', 'CANCELLED', 'FAILED', 'PENDING', 'PROVIDER_DOWN', 'DUPLICATE_ACCOUNT', 'UNDER_14', 'BOOTH_MISMATCH'].map(outcomeOfStatus),
    ['success', 'closed', 'closed', 'closed', 'down', 'other', 'under14', 'mismatch'],
  );
});

/** fetch 대역: 부른 요청을 모으고 응답을 차례로 준다 */
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', credentials: init.credentials, headers: { ...(init.headers ?? {}) }, body: init.body });
    const r = responses.shift();
    if (!r) throw new Error('응답이 없다');
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': r.type ?? 'application/json' } });
  };
  return { fn, calls };
}

const problem = (status, type) => ({ status, type: 'application/problem+json', body: { type: `https://peaket.example/problems/${type}`, status, title: 't' } });

test('I-T45 API: 모든 호출은 API 출처로 자격 증명을 싣고, 시작·결과 응답을 흐름의 결과로 바꾼다', async () => {
  const f = fakeFetch([
    { status: 201, body: { verificationId: ID, window: AGENCY, expiresAt: '2026-11-04T00:10:00Z' } },
    problem(409, 'already-verified'),
    problem(403, 'under-14'),
    problem(503, 'provider-down'),
    { status: 200, body: body('VERIFIED').body },
    problem(409, 'duplicate-account'),
    problem(403, 'under-14'),
    problem(404, 'not-found'),
    problem(503, 'provider-down'),
    { status: 204 },
  ]);
  const api = createVerifyApi({ origin: 'http://localhost:18930', fetch: f.fn });
  assert.deepEqual(await api.start('/events/e-1', 'FIRST'), { kind: 'started', id: ID, window: AGENCY });
  assert.deepEqual(await api.start('/', 'FIRST'), { kind: 'already' });
  assert.deepEqual(await api.start('/', 'FIRST'), { kind: 'under14' });
  assert.deepEqual(await api.start('/', 'FIRST'), { kind: 'down' });
  assert.deepEqual(await api.confirm(ID, SEALED), body('VERIFIED'));
  assert.deepEqual(await api.confirm(ID, SEALED), { kind: 'duplicate' });
  assert.deepEqual(await api.confirm(ID, SEALED), { kind: 'under14' });
  assert.deepEqual(await api.result(ID), { kind: 'notFound' });
  assert.deepEqual(await api.result(ID), { kind: 'down' });
  assert.equal(await api.refresh(), 'ok');
  assert.equal(f.calls[0].url, 'http://localhost:18930/v1/identity/verifications');
  assert.deepEqual(JSON.parse(f.calls[0].body), { purpose: 'FIRST', next: '/events/e-1' });
  assert.equal(f.calls[4].url, `http://localhost:18930/v1/identity/verifications/${ID}/result`);
  assert.deepEqual(JSON.parse(f.calls[4].body), { providerResult: SEALED });
  assert.equal(f.calls[7].method, 'GET');
  assert.equal(f.calls[9].url, 'http://localhost:18930/v1/identity/access-tokens');
  for (const c of f.calls) assert.equal(c.credentials, 'include');
  for (const c of f.calls.filter((x) => x.body !== undefined)) assert.equal(c.headers['content-type'], 'application/json');
});

test('I-T45 API: 401이면 토큰을 한 번 갱신하고 다시 보내고, 갱신도 안 되면 로그인으로 본다', async () => {
  const f = fakeFetch([problem(401, 'unauthenticated'), { status: 204 }, { status: 200, body: body('PENDING').body }, problem(401, 'unauthenticated'), problem(401, 'refresh-token-invalid')]);
  const api = createVerifyApi({ origin: 'http://localhost:18930', fetch: f.fn });
  assert.deepEqual(await api.result(ID), body('PENDING'));
  assert.deepEqual(await api.result(ID), { kind: 'login' });
  assert.deepEqual(f.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`), [
    `GET /v1/identity/verifications/${ID}/result`,
    'POST /v1/identity/access-tokens',
    `GET /v1/identity/verifications/${ID}/result`,
    `GET /v1/identity/verifications/${ID}/result`,
    'POST /v1/identity/access-tokens',
  ]);
});

test('I-T45 API: 연결이 끊기거나 모르는 응답이면 error다', async () => {
  const f = fakeFetch([new TypeError('Failed to fetch'), { status: 500, body: {} }, { status: 200, body: { what: 1 } }]);
  const api = createVerifyApi({ origin: 'http://localhost:18930', fetch: f.fn });
  assert.deepEqual(await api.result(ID), { kind: 'error' });
  assert.deepEqual(await api.result(ID), { kind: 'error' });
  assert.deepEqual(await api.result(ID), { kind: 'error' });
});

test('I-T45 ②창이 닫힌 것으로 보였는데(COOP로 창 관계가 끊김) 맞는 메시지가 늦게 오면, 받은 표시를 돌려주고 결과 조회 값으로 대화상자를 바꾼다(새 맥락 리뷰 M1)', async () => {
  const api = fakeApi({ start: [{ kind: 'started', id: ID, window: AGENCY }], result: [body('PENDING'), body('VERIFIED')] });
  const c = callerEnv({ api });
  const done = [];
  startCallerFlow(c.env, { purpose: 'FIRST', onWaiting() {}, onDone: (o) => done.push(o) });
  await c.time.advance(0);
  c.win.closed = true;
  await c.time.advance(2000);
  assert.deepEqual(done, ['closed']);
  // 복귀 화면이 결과를 다 처리한 뒤 늦게 알린다
  c.bus.inject({ type: 'result', verificationId: ID, status: 'VERIFIED' });
  await c.time.advance(10);
  assert.deepEqual(c.callerSent(), [{ type: 'ack', verificationId: ID }]);
  assert.deepEqual(done, ['closed', 'success']);
  assert.deepEqual(api.calls.map((x) => x[0]), ['start', 'result', 'result'], '늦은 메시지로 안 완료에는 토큰을 갱신하지 않는다(복귀 화면이 했다)');
});

test('I-T45 늦은 메시지는 그 건의 결과를 받을 수 있는 동안(10분)만 기다리고, 다시 시도하면 지난 건은 그만 듣는다', async () => {
  const api = fakeApi({ start: [{ kind: 'started', id: ID, window: AGENCY }], result: [body('PENDING')] });
  const c = callerEnv({ api });
  const done = [];
  const flow = startCallerFlow(c.env, { purpose: 'FIRST', onWaiting() {}, onDone: (o) => done.push(o) });
  await c.time.advance(0);
  c.win.closed = true;
  await c.time.advance(2000);
  flow.cancel();
  c.bus.inject({ type: 'result', verificationId: ID, status: 'VERIFIED' });
  await c.time.advance(10);
  assert.deepEqual(c.callerSent(), []);
  assert.deepEqual(done, ['closed']);
  const api2 = fakeApi({ start: [{ kind: 'started', id: ID, window: AGENCY }], result: [body('PENDING')] });
  const c2 = callerEnv({ api: api2 });
  startCallerFlow(c2.env, { purpose: 'FIRST', onWaiting() {}, onDone() {} });
  await c2.time.advance(0);
  c2.win.closed = true;
  await c2.time.advance(2000 + 10 * 60_000);
  c2.bus.inject({ type: 'result', verificationId: ID, status: 'VERIFIED' });
  await c2.time.advance(10);
  assert.deepEqual(c2.callerSent(), []);
});

test('I-T45 다시 시도·화면 떠남(cancel)이면 늦은 메시지를 듣던 10분 타이머와 창 닫힘 확인 타이머를 지운다(BOT-010이 넘긴 것)', async () => {
  const api = fakeApi({ start: [{ kind: 'started', id: ID, window: AGENCY }], result: [body('PENDING')] });
  const c = callerEnv({ api });
  const flow = startCallerFlow(c.env, { purpose: 'FIRST', onWaiting() {}, onDone() {} });
  await c.time.advance(0);
  c.win.closed = true;
  await c.time.advance(2000);
  assert.equal(c.time.pending(), 1, '늦은 메시지를 듣는 10분 타이머');
  flow.cancel();
  await c.time.advance(0);
  assert.equal(c.time.pending(), 0, '취소하면 타이머가 남지 않는다');
  // 창이 열려 있는 동안(닫힘 확인 간격) 취소해도 남지 않는다
  const c2 = callerEnv({ api: fakeApi({ start: [{ kind: 'started', id: ID, window: AGENCY }] }) });
  const f2 = startCallerFlow(c2.env, { purpose: 'FIRST', onWaiting() {}, onDone() {} });
  await c2.time.advance(0);
  assert.equal(c2.time.pending(), 1);
  f2.cancel();
  await c2.time.advance(0);
  assert.equal(c2.time.pending(), 0);
});

test('I-T45 토큰 갱신은 창끼리 하나씩만 돈다(이름 잠금 안에서, 새 맥락 리뷰 M1)', async () => {
  const order = [];
  const lock = async (fn) => {
    order.push('lock');
    const out = await fn();
    order.push('unlock');
    return out;
  };
  const f = fakeFetch([{ status: 204 }, problem(401, 'unauthenticated'), { status: 204 }, { status: 200, body: body('PENDING').body }]);
  const api = createVerifyApi({ origin: 'http://localhost:18930', fetch: async (...a) => (order.push('fetch'), f.fn(...a)), lock });
  assert.equal(await api.refresh(), 'ok');
  assert.deepEqual(await api.result(ID), body('PENDING'));
  assert.deepEqual(order, ['lock', 'fetch', 'unlock', 'fetch', 'lock', 'fetch', 'unlock', 'fetch']);
});

test('I-T45 창 닫힘으로 결과를 조회하는 사이에 메시지가 오면, 받은 표시를 돌려주고 늦게 끝난 앞 조회는 버린다(새 맥락 리뷰 다시 보기 1)', async () => {
  const calls = [];
  const pending = [];
  const api = {
    start: async () => ({ kind: 'started', id: ID, window: AGENCY }),
    result: () => new Promise((r) => (calls.push('result'), pending.push(r))),
    refresh: async () => (calls.push('refresh'), 'ok'),
    confirm: async () => ({ kind: 'error' }),
  };
  const c = callerEnv({ api });
  const done = [];
  startCallerFlow(c.env, { purpose: 'FIRST', onWaiting() {}, onDone: (o) => done.push(o) });
  await c.time.advance(0);
  c.win.closed = true;
  await c.time.advance(1600);
  assert.equal(pending.length, 1, '창 닫힘 쪽 조회가 나갔다');
  c.bus.inject({ type: 'result', verificationId: ID, status: 'VERIFIED' });
  await c.time.advance(10);
  assert.deepEqual(c.callerSent(), [{ type: 'ack', verificationId: ID }]);
  assert.equal(pending.length, 2, '메시지 쪽 조회가 따로 나갔다');
  // 메시지 쪽이 먼저 VERIFIED로 끝나고, 앞의 창 닫힘 쪽 조회는 PENDING으로 늦게 끝난다
  pending[1](body('VERIFIED'));
  await c.time.advance(10);
  pending[0](body('PENDING'));
  await c.time.advance(10);
  assert.deepEqual(done, ['success']);
  assert.deepEqual(calls, ['result', 'result'], '메시지로 안 완료라 토큰을 다시 갱신하지 않는다');
});

test('I-T45 흐름 안에서 예상 밖 오류가 나면 미리 연 창을 닫고 기관 장애로 보인다(새 맥락 리뷰 L4)', async () => {
  const api = { start: async () => { throw new Error('boom'); }, result: async () => ({ kind: 'error' }), refresh: async () => 'ok', confirm: async () => ({ kind: 'error' }) };
  const c = callerEnv({ api });
  const done = [];
  startCallerFlow(c.env, { purpose: 'FIRST', onWaiting() {}, onDone: (o) => done.push(o) });
  await c.time.advance(0);
  assert.equal(c.win.closed, true);
  assert.deepEqual(done, ['down']);
});

test('I-T45 API: 토큰 갱신은 성공·거절(401)·일시 장애(연결 끊김·5xx)로 나뉘고, 401 뒤 갱신이 일시 장애면 로그인이 아니라 기관 장애(잠시 후 다시)다(새 맥락 리뷰)', async () => {
  const refreshOf = async (r) => createVerifyApi({ origin: '', fetch: fakeFetch([r]).fn }).refresh();
  assert.equal(await refreshOf({ status: 204 }), 'ok');
  assert.equal(await refreshOf(problem(401, 'refresh-token-invalid')), 'rejected');
  assert.equal(await refreshOf({ status: 503, body: {} }), 'unavailable');
  assert.equal(await refreshOf({ status: 500, body: {} }), 'unavailable');
  assert.equal(await refreshOf(new TypeError('Failed to fetch')), 'unavailable');
  // 결과 조회·확정·시작: 401 → 갱신 503 → down(로그인 아님)
  for (const run of [(a) => a.result(ID), (a) => a.confirm(ID, SEALED), (a) => a.start('/', 'FIRST')]) {
    const f = fakeFetch([problem(401, 'unauthenticated'), { status: 503, body: {} }]);
    assert.deepEqual(await run(createVerifyApi({ origin: '', fetch: f.fn })), { kind: 'down' });
    const g = fakeFetch([problem(401, 'unauthenticated'), new TypeError('Failed to fetch')]);
    assert.deepEqual(await run(createVerifyApi({ origin: '', fetch: g.fn })), { kind: 'down' });
  }
});

test('I-T45 복귀 화면에서 결과 확정과 결과 조회가 일시 장애로 끝나면 로그인 화면으로 가지 않는다: 처리 중을 알리고 팝업이면 창을 닫고, 페이지 이동이면 첫 화면이다(새 맥락 리뷰)', async () => {
  // 페이지 이동
  const api = fakeApi({ confirm: [{ kind: 'down' }], result: [{ kind: 'down' }] });
  const r = returnEnv({ api });
  const run = runReturnFlow(r.env, SEALED);
  await r.time.advance(ACK_WAIT_MS + 10);
  await run;
  assert.deepEqual(r.bus.sent.map((x) => x.data), [{ type: 'result', verificationId: ID, status: 'PENDING' }]);
  assert.deepEqual(r.log.navigated, ['/']);
  assert.equal(r.log.storage.size, 0);
  // 팝업: 창을 닫는다(부르는 화면이 결과 조회로 기관 장애나 창을 닫음·실패를 보인다)
  const p = returnEnv({ api: fakeApi({ confirm: [{ kind: 'error' }], result: [{ kind: 'error' }] }) });
  const caller = p.bus.channel();
  caller.onmessage = (e) => {
    if (isResultMessage(e.data, ID)) caller.postMessage({ type: 'ack', verificationId: ID });
  };
  const run2 = runReturnFlow(p.env, SEALED);
  await p.time.advance(50);
  await run2;
  assert.equal(p.log.closed, 1);
  await p.time.advance(CLOSE_FALLBACK_MS);
  assert.deepEqual(p.log.navigated, ['/']);
  // 결과 확정은 일시 장애였는데 결과 조회가 세션 끝(401 거절)이면 로그인 화면(돌아올 주소는 첫 화면)
  const l = returnEnv({ api: fakeApi({ confirm: [{ kind: 'down' }], result: [{ kind: 'login' }] }) });
  const run3 = runReturnFlow(l.env, SEALED);
  await l.time.advance(ACK_WAIT_MS + 10);
  await run3;
  assert.deepEqual(l.log.navigated, ['/login?next=%2F']);
});

// ── 새 맥락 재검토(2026-11-05): 부르는 화면이 스스로 VERIFIED를 확인하면 직접 갱신한다 ──

test('I-T45 재현: 서버는 VERIFIED인데 복귀 화면의 결과 확정 응답이 끊기고 결과 조회가 503이면, 처리 중 알림을 받은 부르는 화면이 결과 조회로 VERIFIED를 보고 직접 갱신한다(새 맥락 재검토)', async () => {
  const bus = fakeBus();
  // 복귀 화면(팝업): 결과 확정 응답이 끊김(error) → 결과 조회 503(down) → 처리 중 알림
  const r = returnEnv({ api: fakeApi({ confirm: [{ kind: 'error' }], result: [{ kind: 'down' }] }), bus });
  // 부르는 화면: 결과 조회는 VERIFIED(서버에는 저장됨)
  const api = fakeApi({ start: [{ kind: 'started', id: ID, window: AGENCY }], result: [body('VERIFIED')], refresh: ['ok'] });
  const c = callerEnv({ api, bus });
  const done = [];
  startCallerFlow(c.env, { purpose: 'FIRST', onWaiting() {}, onDone: (o) => done.push(o) });
  await c.time.advance(0);
  const run = runReturnFlow(r.env, SEALED);
  for (let i = 0; i < 5; i++) {
    await r.time.advance(10);
    await c.time.advance(10);
  }
  await run;
  assert.equal(r.log.closed, 1, '받은 표시가 와서 팝업을 닫았다');
  assert.deepEqual(api.calls.map((x) => x[0]), ['start', 'result', 'refresh'], '처리 중 알림이면 부르는 화면이 갱신한다');
  assert.deepEqual(done, ['success']);
});

test('I-T45 부르는 화면의 갱신이 일시 장애면 1초 뒤 한 번 더 하고, 그래도 안 되면 기관 장애(잠시 후 다시)이며, 401이면 로그인 화면이다(새 맥락 재검토)', async () => {
  for (const [plan, want, waits] of [
    [['unavailable', 'ok'], 'success', 1],
    [['unavailable', 'unavailable'], 'down', 1],
    [['rejected'], 'login', 0],
  ]) {
    const api = fakeApi({ start: [{ kind: 'started', id: ID, window: AGENCY }], result: [body('VERIFIED')], refresh: [...plan] });
    const c = callerEnv({ api, path: '/events/e-5' });
    const done = [];
    startCallerFlow(c.env, { purpose: 'FIRST', onWaiting() {}, onDone: (o) => done.push(o) });
    await c.time.advance(0);
    c.win.closed = true;
    await c.time.advance(2000);
    if (waits) {
      assert.deepEqual(done, [], '다시 하기 전에는 정하지 않는다');
      await c.time.advance(REFRESH_RETRY_MS);
    }
    if (want === 'login') assert.deepEqual(c.log.login, ['/events/e-5']);
    else assert.deepEqual(done, [want], plan.join(','));
    assert.equal(api.calls.filter((x) => x[0] === 'refresh').length, plan.length);
  }
  // 시작이 409 이미 본인확인이어도 갱신한다(기관 장애 뒤 [다시 시도]가 이 길로 갱신을 마친다)
  const again = fakeApi({ start: [{ kind: 'already' }], refresh: ['ok'] });
  const c2 = callerEnv({ api: again });
  const done2 = [];
  startCallerFlow(c2.env, { purpose: 'FIRST', onWaiting() {}, onDone: (o) => done2.push(o) });
  await c2.time.advance(0);
  assert.deepEqual(again.calls.map((x) => x[0]), ['start', 'refresh']);
  assert.deepEqual(done2, ['success']);
});

test('I-T45 복귀 화면의 VERIFIED 뒤 갱신이 일시 장애면 한 번 더 하고, 그래도 안 되면 VERIFIED 대신 처리 중으로 알리고 저장 값에 갱신 못 함을 적는다(새 맥락 재검토)', async () => {
  // 두 번 다 일시 장애: 처리 중으로 알리고 페이지 이동이면 refreshed false
  const r = returnEnv({ api: fakeApi({ confirm: [body('VERIFIED', '/events/e-7')], refresh: ['unavailable', 'unavailable'] }) });
  const run = runReturnFlow(r.env, SEALED);
  await r.time.advance(REFRESH_RETRY_MS + ACK_WAIT_MS + 20);
  await run;
  assert.deepEqual(r.bus.sent.map((x) => x.data), [{ type: 'result', verificationId: ID, status: 'PENDING' }]);
  assert.deepEqual(JSON.parse(r.log.storage.get(RETURN_STORAGE_KEY)), { id: ID, at: 5_000, refreshed: false });
  assert.deepEqual(r.log.navigated, ['/events/e-7'], '돌아갈 곳은 결과의 next');
  // 한 번 더 해서 되면 VERIFIED로 알린다
  const ok = returnEnv({ api: fakeApi({ confirm: [body('VERIFIED')], refresh: ['unavailable', 'ok'] }) });
  const run2 = runReturnFlow(ok.env, SEALED);
  await ok.time.advance(REFRESH_RETRY_MS + ACK_WAIT_MS + 20);
  await run2;
  assert.deepEqual(ok.bus.sent.map((x) => x.data.status), ['VERIFIED']);
  assert.equal(JSON.parse(ok.log.storage.get(RETURN_STORAGE_KEY)).refreshed, true);
});

test('I-T45 페이지 이동으로 돌아온 완료인데 복귀 화면이 갱신하지 못했으면 부르는 화면이 직접 갱신한다(새 맥락 재검토)', async () => {
  const storage = new Map();
  const s = { get: (k) => storage.get(k) ?? null, set: (k, v) => storage.set(k, v), remove: (k) => storage.delete(k) };
  const save = (refreshed) => storage.set(RETURN_STORAGE_KEY, JSON.stringify({ id: ID, at: 1_000, refreshed }));
  save(false);
  const api = fakeApi({ result: [body('VERIFIED')], refresh: ['ok'] });
  assert.equal(await resumeReturnedResult({ api, storage: s, now: () => 1_000, sleep: noWait }), 'success');
  assert.deepEqual(api.calls.map((x) => x[0]), ['result', 'refresh']);
  save(false);
  assert.equal(await resumeReturnedResult({ api: fakeApi({ result: [body('VERIFIED')], refresh: ['unavailable', 'unavailable'] }), storage: s, now: () => 1_000, sleep: noWait }), 'down');
  save(false);
  assert.equal(await resumeReturnedResult({ api: fakeApi({ result: [body('VERIFIED')], refresh: ['rejected'] }), storage: s, now: () => 1_000, sleep: noWait }), 'login');
  // 갱신까지 마쳤으면 하지 않는다
  save(true);
  const done = fakeApi({ result: [body('VERIFIED')] });
  assert.equal(await resumeReturnedResult({ api: done, storage: s, now: () => 1_000, sleep: noWait }), 'success');
  assert.deepEqual(done.calls.map((x) => x[0]), ['result']);
});

test('I-T45 갱신을 다시 하기 전 1초 사이에 흐름을 멈추면(다시 시도·화면 떠남) 두 번째 갱신을 보내지 않는다(새 맥락 마지막 검토)', async () => {
  const api = fakeApi({ start: [{ kind: 'started', id: ID, window: AGENCY }], result: [body('VERIFIED')], refresh: ['unavailable', 'ok'] });
  const c = callerEnv({ api });
  const done = [];
  const flow = startCallerFlow(c.env, { purpose: 'FIRST', onWaiting() {}, onDone: (o) => done.push(o) });
  await c.time.advance(0);
  c.win.closed = true;
  await c.time.advance(2000);
  assert.deepEqual(api.calls.map((x) => x[0]), ['start', 'result', 'refresh'], '첫 갱신이 일시 장애라 1초를 기다린다');
  flow.cancel();
  await c.time.advance(REFRESH_RETRY_MS + 10);
  assert.deepEqual(api.calls.map((x) => x[0]), ['start', 'result', 'refresh'], '멈춘 흐름은 두 번째 갱신을 보내지 않는다');
  assert.deepEqual(done, []);
  // 메시지 쪽 조회가 먼저 끝난 경우: 창 닫힘 쪽 조회의 다시 하기는 보내지 않는다
  const calls = [];
  const pending = [];
  const api2 = {
    start: async () => ({ kind: 'started', id: ID, window: AGENCY }),
    result: () => new Promise((r) => (calls.push('result'), pending.push(r))),
    refresh: async () => (calls.push('refresh'), 'unavailable'),
    confirm: async () => ({ kind: 'error' }),
  };
  const c2 = callerEnv({ api: api2 });
  const done2 = [];
  startCallerFlow(c2.env, { purpose: 'FIRST', onWaiting() {}, onDone: (o) => done2.push(o) });
  await c2.time.advance(0);
  c2.win.closed = true;
  await c2.time.advance(1600);
  pending[0](body('VERIFIED')); // 창 닫힘 쪽: VERIFIED → 갱신 일시 장애 → 1초 기다림
  await c2.time.advance(10);
  c2.bus.inject({ type: 'result', verificationId: ID, status: 'VERIFIED' }); // 그사이 메시지(복귀 화면이 갱신을 마침)
  await c2.time.advance(10);
  pending[1](body('VERIFIED'));
  await c2.time.advance(REFRESH_RETRY_MS + 10);
  assert.deepEqual(calls, ['result', 'refresh', 'result'], '앞 조회의 두 번째 갱신이 나가지 않는다');
  assert.deepEqual(done2, ['success']);
});

test('I-T45 복귀 화면의 VERIFIED 뒤 갱신이 401이면(세션이 끝남) 다시 하지 않고 처리 중으로 알리며 저장 값에 갱신 못 함을 적는다(새 맥락 마지막 검토)', async () => {
  const api = fakeApi({ confirm: [body('VERIFIED', '/events/e-7')], refresh: ['rejected'] });
  const r = returnEnv({ api });
  const run = runReturnFlow(r.env, SEALED);
  await r.time.advance(ACK_WAIT_MS + 10);
  await run;
  assert.deepEqual(api.calls.map((x) => x[0]), ['confirm', 'refresh'], '401은 다시 하지 않는다');
  assert.deepEqual(r.bus.sent.map((x) => x.data), [{ type: 'result', verificationId: ID, status: 'PENDING' }]);
  assert.deepEqual(JSON.parse(r.log.storage.get(RETURN_STORAGE_KEY)), { id: ID, at: 5_000, refreshed: false });
  assert.deepEqual(r.log.navigated, ['/events/e-7']);
});

test('SCR-005 [지금 본인확인]: 창을 먼저 연 뒤 앞일(가입 마무리)을 하고, 성공하면 정한 돌아갈 주소로 시작한다. 실패하면 창을 닫고 시작하지 않는다(ADR-0203 결정 5)', async () => {
  const api = fakeApi({ start: [{ kind: 'started', id: ID, window: AGENCY }] });
  const c = callerEnv({ api, path: '/signup/consent?next=%2Fevents%2Fe-1' });
  const order = [];
  startCallerFlow(c.env, {
    purpose: 'FIRST',
    next: '/events/e-1',
    before: async () => (order.push(['before', c.log.opened.length]), true),
    onWaiting() {},
    onDone() {},
  });
  await c.time.advance(0);
  assert.deepEqual(order, [['before', 1]], '창을 연 다음에 앞일');
  assert.deepEqual(api.calls[0], ['start', '/events/e-1', 'FIRST'], '돌아갈 주소는 정한 값');

  const api2 = fakeApi({});
  const c2 = callerEnv({ api: api2 });
  const done = [];
  startCallerFlow(c2.env, { purpose: 'FIRST', before: async () => false, onWaiting() {}, onDone: (o) => done.push(o) });
  await c2.time.advance(0);
  assert.equal(c2.win.closed, true, '창을 닫는다');
  assert.deepEqual(api2.calls, [], '본인확인을 시작하지 않는다');
  assert.deepEqual(done, [], '결과 대화상자도 없다(부르는 화면이 오류를 보인다)');
});
