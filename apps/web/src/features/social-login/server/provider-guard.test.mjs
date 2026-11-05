// 소셜 로그인 공급자 호출 보호(docs/architecture.md §5 '소셜 로그인 공급자 HTTP', docs/features/identity.md §10 ①~③, ADR-0180, BUILD_ORDER HOT-320)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderGuard, ProviderBusyError, ProviderOpenError } from './provider-guard.ts';

const ok = (status = 200, body = '{"a":1}') => new Response(body, { status, headers: { 'content-type': 'application/json' } });

function guardWith(fetchImpl, o = {}) {
  let now = 1_000_000;
  const g = createProviderGuard({ fetch: fetchImpl, now: () => now, maxConcurrent: 2, timeoutMs: 50, windowMs: 30_000, minCalls: 4, rejectRatio: 0.5, openMs: 30_000, ...o });
  return { g, tick: (ms) => (now += ms) };
}

test('공급자 응답은 본문까지 다 읽어 넘기고(읽기도 시간 상한 안), 상태·머리를 그대로 둔다', async () => {
  const { g } = guardWith(async () => ok(201, '{"x":2}'));
  const r = await g.fetchFor('kakao')('https://op/token', { method: 'POST' });
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { x: 2 });
  assert.equal(g.inflight('kakao'), 0);
});

test('① 파드의 공급자별 동시 호출 상한을 넘으면 기다리지 않고 바로 거절한다(다른 공급자는 따로 센다)', async () => {
  const pending = [];
  const { g } = guardWith(() => new Promise((r) => pending.push(r)));
  const f = g.fetchFor('kakao');
  const a = f('https://op/token');
  const b = f('https://op/token');
  await assert.rejects(f('https://op/token'), ProviderBusyError);
  assert.equal(g.inflight('kakao'), 2);
  // 네이버는 상한이 따로다
  const n = g.fetchFor('naver')('https://op/token');
  assert.equal(g.inflight('naver'), 1);
  pending.forEach((r) => r(ok()));
  await Promise.all([a, b, n]);
  assert.equal(g.inflight('kakao'), 0);
});

test('③ 시간 상한을 넘으면 끊고(같은 인가 코드로 다시 보내지 않는다) 자리를 돌려준다', async () => {
  let calls = 0;
  const { g } = guardWith((_u, init) => {
    calls += 1;
    return new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  });
  const t0 = Date.now();
  await assert.rejects(g.fetchFor('google')('https://op/token'), (e) => e.name === 'TimeoutError');
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(calls, 1, '다시 보내지 않는다');
  assert.equal(g.inflight('google'), 0);
});

test('부르는 쪽의 취소 신호도 따른다', async () => {
  const { g } = guardWith((_u, init) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))), { timeoutMs: 5_000 });
  const ctrl = new AbortController();
  const p = g.fetchFor('kakao')('https://op/token', { signal: ctrl.signal });
  ctrl.abort(new Error('bye'));
  await assert.rejects(p);
  assert.equal(g.inflight('kakao'), 0);
});

test('② 공급자가 429·403을 몰아 주면(창 안 호출이 4건 이상이고 절반 이상) 그 공급자만 잠시 끊고, 끊긴 동안은 부르지 않는다', async () => {
  let status = 429;
  let calls = 0;
  const { g, tick } = guardWith(async () => {
    calls += 1;
    return ok(status, '{}');
  });
  const f = g.fetchFor('kakao');
  for (let i = 0; i < 3; i++) assert.equal((await f('https://op/token')).status, 429);
  assert.equal(g.state('kakao'), 'closed', '최소 호출 수 전에는 끊지 않는다');
  await f('https://op/token');
  assert.equal(g.state('kakao'), 'open');
  await assert.rejects(f('https://op/token'), ProviderOpenError);
  assert.equal(calls, 4, '끊긴 동안은 부르지 않는다');
  assert.equal(g.state('naver'), 'closed', '다른 공급자는 그대로');
  // 끊긴 시간이 지나면 한 번만 시험 삼아 부른다. 성공하면 다시 잇는다
  tick(30_001);
  status = 200;
  assert.equal((await f('https://op/token')).status, 200);
  assert.equal(g.state('kakao'), 'closed');
});

test('② 시험 삼아 부른 호출이 다시 429·403이면 다시 끊는다. 시험 중에는 다른 호출을 막는다', async () => {
  let release;
  let status = 403;
  const { g, tick } = guardWith(async () => ok(status, '{}'));
  const f = g.fetchFor('google');
  for (let i = 0; i < 4; i++) await f('https://op/token');
  assert.equal(g.state('google'), 'open');
  tick(30_001);
  assert.equal((await f('https://op/token')).status, 403);
  assert.equal(g.state('google'), 'open');
  // 시험 중(답을 기다리는 동안)의 다른 호출은 막힌다
  tick(30_001);
  const slow = guardWith(() => new Promise((r) => (release = r)), {});
  const sf = slow.g.fetchFor('kakao');
  status = 429;
  for (let i = 0; i < 4; i++) {
    const p = sf('https://op/token');
    release(ok(429, '{}'));
    await p;
  }
  slow.tick(30_001);
  const probe = sf('https://op/token');
  await assert.rejects(sf('https://op/token'), ProviderOpenError);
  release(ok(200, '{}'));
  await probe;
  assert.equal(slow.g.state('kakao'), 'closed');
});

test('창(30초)이 지난 결과는 세지 않는다. 5xx는 서킷을 열지 않는다(한도·차단 응답만)', async () => {
  let status = 429;
  const { g, tick } = guardWith(async () => ok(status, '{}'));
  const f = g.fetchFor('kakao');
  for (let i = 0; i < 3; i++) await f('https://op/token');
  tick(30_001);
  status = 200;
  await f('https://op/token');
  assert.equal(g.state('kakao'), 'closed');
  status = 503;
  for (let i = 0; i < 6; i++) await f('https://op/token');
  assert.equal(g.state('kakao'), 'closed');
});

test('③ 본문이 늦게 오면 본문을 읽는 중에도 시간 상한으로 끊는다', async () => {
  const { g } = guardWith((_u, init) => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"a":'));
        init.signal.addEventListener('abort', () => c.error(init.signal.reason));
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  });
  await assert.rejects(g.fetchFor('kakao')('https://op/token'), (e) => e.name === 'TimeoutError');
  assert.equal(g.inflight('kakao'), 0);
});

test('② 시간 초과는 서킷을 열지 않는다', async () => {
  const { g } = guardWith((_u, init) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))), { timeoutMs: 5 });
  for (let i = 0; i < 6; i++) await assert.rejects(g.fetchFor('kakao')('https://op/token'));
  assert.equal(g.state('kakao'), 'closed');
});

test('② counts가 고른 호출만 센다. 세지 않는 호출도 끊긴 동안은 보내지 않고, 끊긴 남은 시간을 Retry-After로 준다', async () => {
  let calls = 0;
  const { g, tick } = guardWith(
    async () => {
      calls += 1;
      return ok(429, '{}');
    },
    { counts: (_u, init) => init?.method === 'POST' },
  );
  const f = g.fetchFor('kakao');
  for (let i = 0; i < 6; i++) await f('https://op/userinfo');
  assert.equal(g.state('kakao'), 'closed', 'GET 거절은 세지 않는다');
  for (let i = 0; i < 4; i++) await f('https://op/token', { method: 'POST' });
  assert.equal(g.state('kakao'), 'open');
  assert.equal(g.openFor('kakao'), 30_000);
  tick(10_500);
  const err = await f('https://op/userinfo').catch((e) => e);
  assert.ok(err instanceof ProviderOpenError);
  assert.equal(err.retryAfterSec, 20, '남은 19.5초를 올려 20초');
  assert.equal(calls, 10, '끊긴 동안은 세지 않는 호출도 보내지 않는다');
  tick(20_000);
  assert.equal(g.openFor('kakao'), 0, '시험 호출을 보낼 때가 되면 0');
  assert.equal(g.state('kakao'), 'half-open');
});

test('다시 만든 응답은 이미 풀린 본문에 맞지 않는 압축·길이 머리를 떼고, 본문이 없는 상태는 본문 없이 만든다', async () => {
  let res = new Response('{"a":1}', { status: 200, headers: { 'content-encoding': 'gzip', 'content-length': '27', 'x-keep': '1' } });
  const { g } = guardWith(async () => res);
  const r = await g.fetchFor('kakao')('https://op/token');
  assert.equal(r.headers.get('content-encoding'), null);
  assert.equal(r.headers.get('content-length'), null);
  assert.equal(r.headers.get('x-keep'), '1');
  assert.deepEqual(await r.json(), { a: 1 });
  res = new Response(null, { status: 204 });
  const empty = await g.fetchFor('kakao')('https://op/revoke');
  assert.equal(empty.status, 204);
  assert.equal(empty.body, null);
});
