// 토큰 갱신 잠금(refresh-lock.ts)과 끊을 수 있는 기다림(sleep.ts) 시험(docs/features/identity.md §5 '부르는 화면', BUILD_ORDER BOT-010이 넘긴 것).
// 브라우저 감싸개(features/*/browser.ts, shared/api)는 경로 별칭(@/)과 확장자 없는 가져오기를 써서 node가 바로 읽지 못한다.
// 이 시험 안에서만 가져오기 갈고리(module.registerHooks)로 별칭을 풀어, 세 흐름의 클라이언트가 실제로 잠금 안에서 갱신하는지 동작으로 본다(새 맥락 재검토).
// 팬 API 클라이언트(shared/api)는 @peaket/api-client가 타입 지우기로 못 읽는 문법(생성자 매개변수 속성)을 써서 소스로 본다.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { REFRESH_LOCK, refreshLock } from './refresh-lock.ts';
import { sleep } from './sleep.ts';

/** 같은 이름 잠금을 하나씩 내주는 Web Locks 흉내(LockManager.request의 배타 잠금) */
function fakeLocks() {
  const names = [];
  let tail = Promise.resolve();
  return {
    names,
    request(name, fn) {
      names.push(name);
      const run = tail.then(() => fn());
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

test('토큰 갱신은 Web Locks의 peaket.refresh 이름 잠금 안에서 돌고, 같은 이름이면 하나씩 돈다(BOT-010이 넘긴 것)', async () => {
  assert.equal(REFRESH_LOCK, 'peaket.refresh');
  const locks = fakeLocks();
  const order = [];
  let release;
  const first = refreshLock(
    () =>
      new Promise((r) => {
        order.push('first-start');
        release = () => {
          order.push('first-end');
          r(1);
        };
      }),
    locks,
  );
  const second = refreshLock(async () => {
    order.push('second');
    return 2;
  }, locks);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['first-start'], '앞 갱신이 끝나기 전에는 뒤 갱신이 돌지 않는다');
  release();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
  assert.deepEqual(locks.names, [REFRESH_LOCK, REFRESH_LOCK]);
});

test('기본값은 Web Locks(navigator.locks)다: 갱신하는 동안 peaket.refresh 잠금을 쥐고, 두 갱신은 겹치지 않는다(새 맥락 리뷰)', async () => {
  // node 24는 브라우저와 같은 navigator.locks를 준다. 대역 없이 실제 잠금으로 순서를 본다
  assert.equal(typeof navigator?.locks?.request, 'function');
  let held = [];
  await refreshLock(async () => {
    held = (await navigator.locks.query()).held.map((l) => l.name);
  });
  assert.ok(held.includes(REFRESH_LOCK), `쥔 잠금: ${held}`);
  const order = [];
  let release;
  const a = refreshLock(
    () =>
      new Promise((r) => {
        order.push('a-start');
        release = () => {
          order.push('a-end');
          r();
        };
      }),
  );
  const b = refreshLock(async () => void order.push('b'));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, ['a-start'], '앞 갱신이 끝나기 전에 뒤 갱신이 돌지 않는다');
  release();
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b']);
});

test('Web Locks가 없는 브라우저(null)는 잠금 없이 그대로 부른다', async () => {
  assert.equal(await refreshLock(async () => 'x', null), 'x');
});

/** apps/web/src. '@/x'는 여기서 찾고, 확장자가 없으면 .ts·.tsx·/index.ts를 붙여 본다(tsconfig paths와 같다) */
const SRC = new URL('../../', import.meta.url);
const withExt = (u) => [u, `${u}.ts`, `${u}.tsx`, `${u}/index.ts`].find((c) => existsSync(new URL(c)));
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@/')) {
      const found = withExt(new URL(specifier.slice(2), SRC).href);
      if (found) return next(found, context);
    }
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      const found = withExt(new URL(specifier, context.parentURL).href);
      if (found) return next(found, context);
    }
    return next(specifier, context);
  },
});

test('본인확인·탈퇴·로그인 수단의 브라우저 클라이언트가 실제로 peaket.refresh 잠금을 쥔 채 갱신 요청을 보낸다(BOT-010이 넘긴 것, 새 맥락 재검토)', async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const held = (await navigator.locks.query()).held.map((l) => l.name);
    seen.push({ path: new URL(String(url), 'https://web.test').pathname, held });
    return new Response(null, { status: 204 });
  };
  try {
    const { browserVerifyApi } = await import('../../features/identity-verify/browser.ts');
    const { browserWithdrawApi } = await import('../../features/account-withdraw/browser.ts');
    const { browserLoginMethodsApi } = await import('../../features/login-methods/browser.ts');
    for (const [name, refresh] of [
      ['본인확인', () => browserVerifyApi().refresh()],
      ['탈퇴', () => browserWithdrawApi().refresh()],
      ['로그인 수단', () => browserLoginMethodsApi().refresh()],
    ]) {
      seen.length = 0;
      assert.equal(await refresh(), 'ok', name);
      assert.equal(seen.length, 1, name);
      assert.equal(seen[0].path, '/v1/identity/access-tokens', name);
      assert.ok(seen[0].held.includes(REFRESH_LOCK), `${name}: 갱신하는 동안 쥔 잠금 ${seen[0].held}`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('끊을 수 있는 기다림: 신호가 끊기면 타이머를 지우고 바로 끝난다(늦은 메시지 10분 타이머를 남기지 않는다, BOT-010이 넘긴 것)', async () => {
  const cleared = mock.method(globalThis, 'clearTimeout');
  try {
    const ac = new AbortController();
    const started = Date.now();
    const p = sleep(10 * 60_000, ac.signal);
    ac.abort();
    await p;
    assert.ok(Date.now() - started < 1_000, '바로 끝난다');
    assert.equal(cleared.mock.callCount(), 1, '타이머를 지웠다');
    // 이미 끊긴 신호면 타이머를 걸지 않는다
    await sleep(10 * 60_000, ac.signal);
    // 신호가 없으면 그대로 기다린다
    const t0 = Date.now();
    await sleep(20);
    assert.ok(Date.now() - t0 >= 15);
  } finally {
    cleared.mock.restore();
  }
});

test('팬 API 클라이언트(shared/api)도 같은 잠금을 쓰고 따로 navigator.locks를 부르지 않는다(소스로 본다, BOT-010이 넘긴 것)', () => {
  const src = readFileSync(new URL('../api/index.ts', import.meta.url), 'utf8');
  assert.match(src, /from '@\/shared\/lib\/refresh-lock'/);
  assert.match(src, /return await refreshLock\(run\);/);
  assert.doesNotMatch(src, /navigator\.locks/);
});
