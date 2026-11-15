// 공유 캐시 저장소·처리기 단위 시험(BAT-170 웨이브 7 T13, docs/frontend.md §5.17 '공유 캐시 처리기 세부', docs/data.md 세션·캐시 클러스터 키 이름).
// 시험 담당(l2w7-BAT170-test)이 구현 전에 썼다(ADR-0270 결정 3). 가짜 Redis(아래 fakeRedis)와 가짜 시계(node:test mock.timers)로 돈다.
// 단언 값은 정본의 값이다: 키 꼴 web:isr:{캐시 키}·web:data:{캐시 키}·web:data:tag:{태그}, TTL 상한 30일, Redis 시간 한도 100ms.
// 주입하는 한도·상한은 일부러 정본 값과 다르게 골라(250ms, 3600초) 주입 값을 무시하는 결함도 잡는다.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, mock, test } from 'node:test';
import { assertCacheEnv, cacheConfig, createCacheStore } from './cache-store.mjs';
import { createUseCacheHandler } from './use-cache-handler.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 정본: 태그 시각·값 TTL 상한 30일 [가정](docs/frontend.md §5.17) */
const DAYS_30_S = 30 * 24 * 60 * 60;
/** 정본: Redis가 이 안에 답하지 않으면 읽기는 없음·쓰기는 버림 100ms [가정] */
const CANON_TIMEOUT_MS = 100;

/**
 * 가짜 Redis. node-redis(6.3.0)의 get·set·mGet·expire·pExpire와 sendCommand(GET·SET EX|PX·MGET·EXPIRE·PEXPIRE)를 받는다.
 * delayMs: 답하는 데 걸리는 시간(Infinity면 답하지 않음), fail: 연결 끊김으로 거절. ttlMs가 null이면 TTL 없는 키다.
 */
function fakeRedis() {
  /** @type {Map<string, { value: unknown, ttlMs: number | null }>} */
  const data = new Map();
  const ctl = { delayMs: 0, fail: false };
  const respond = (fn) =>
    new Promise((ok, no) => {
      const run = () => (ctl.fail ? no(new Error('연결이 끊겼다')) : ok(fn()));
      if (ctl.delayMs === Infinity) return;
      if (ctl.delayMs > 0) setTimeout(run, ctl.delayMs);
      else queueMicrotask(run);
    });
  const ttlOf = (o) => {
    if (!o) return null;
    const e = o.expiration ?? (o.EX !== undefined ? { type: 'EX', value: o.EX } : o.PX !== undefined ? { type: 'PX', value: o.PX } : undefined);
    if (!e) return null;
    return e.type === 'EX' ? Number(e.value) * 1000 : e.type === 'PX' ? Number(e.value) : null;
  };
  const raw = (args) => {
    const [cmd, ...a] = args.map((x) => (Buffer.isBuffer(x) ? x : String(x)));
    switch (String(cmd).toUpperCase()) {
      case 'GET':
        return data.get(a[0])?.value ?? null;
      case 'MGET':
        return a.map((k) => data.get(k)?.value ?? null);
      case 'SET': {
        let ttlMs = null;
        for (let i = 2; i < a.length; i++) {
          const o = String(a[i]).toUpperCase();
          if (o === 'EX') ttlMs = Number(a[++i]) * 1000;
          else if (o === 'PX') ttlMs = Number(a[++i]);
        }
        data.set(a[0], { value: a[1], ttlMs });
        return 'OK';
      }
      case 'EXPIRE':
      case 'PEXPIRE': {
        const e = data.get(a[0]);
        if (!e) return 0;
        e.ttlMs = String(cmd).toUpperCase() === 'EXPIRE' ? Number(a[1]) * 1000 : Number(a[1]);
        return 1;
      }
      default:
        throw new Error(`가짜 Redis가 모르는 명령: ${cmd}`);
    }
  };
  const client = {
    get: (k) => respond(() => data.get(k)?.value ?? null),
    mGet: (keys) => respond(() => keys.map((k) => data.get(k)?.value ?? null)),
    set: (k, v, o) =>
      respond(() => {
        data.set(k, { value: v, ttlMs: ttlOf(o) });
        return 'OK';
      }),
    expire: (k, s) => respond(() => raw(['EXPIRE', k, s])),
    pExpire: (k, ms) => respond(() => raw(['PEXPIRE', k, ms])),
    sendCommand: (args) => respond(() => raw(args)),
  };
  return { client, data, ctl };
}

const text = (v) => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));
/** tagTimes 결과(Map이든 객체든)를 태그 차례의 숫자 목록으로. 기록 없는 태그는 0 */
const timesOf = (r, tags) => tags.map((t) => Number((r instanceof Map ? r.get(t) : r?.[t]) ?? 0));
const flush = () => new Promise((r) => setImmediate(r));
/** 약속이 끝났는지(가짜 시계를 돌리는 동안 본다) */
const settled = (p) => {
  const s = { done: false, value: undefined, error: undefined };
  p.then(
    (v) => Object.assign(s, { done: true, value: v }),
    (e) => Object.assign(s, { done: true, error: e }),
  );
  return s;
};

afterEach(() => mock.timers.reset());

test('HOT-390 공유 캐시 키 꼴과 모든 키의 TTL', async () => {
  const { client, data } = fakeRedis();
  const store = createCacheStore({ client, timeoutMs: 250, now: () => 1_000, maxTtlSeconds: 3_600 });
  await store.setEntry('isr', '/events/evt-lumen-1025', 'isr-value', 60); // 상한보다 짧다
  await store.setEntry('data', 'abc123', 'data-value', 7_200); // 상한보다 길다
  await store.setEntry('data', 'edge', 'edge-value', 3_600); // 상한과 같다
  await store.markTags(['events', 'event:evt-lumen-1025'], 5_000);

  assert.deepEqual([...data.keys()].sort(), ['web:data:abc123', 'web:data:edge', 'web:data:tag:event:evt-lumen-1025', 'web:data:tag:events', 'web:isr:/events/evt-lumen-1025']);
  assert.equal(data.get('web:isr:/events/evt-lumen-1025').ttlMs, 60_000, '값 TTL은 만료(60초)');
  assert.equal(data.get('web:data:abc123').ttlMs, 3_600_000, '만료가 상한보다 길면 상한');
  assert.equal(data.get('web:data:edge').ttlMs, 3_600_000);
  assert.equal(data.get('web:data:tag:events').ttlMs, 3_600_000, '태그 시각 TTL은 상한');
  assert.equal(data.get('web:data:tag:event:evt-lumen-1025').ttlMs, 3_600_000);
  for (const [k, e] of data) assert.ok(e.ttlMs !== null && e.ttlMs > 0, `TTL 없는 키: ${k}`);

  // 저장소 응답은 정확한 값까지
  assert.equal(text(await store.getEntry('isr', '/events/evt-lumen-1025')), 'isr-value');
  assert.equal(text(await store.getEntry('data', 'abc123')), 'data-value');
  assert.equal(await store.getEntry('isr', 'abc123') ?? null, null, '종류가 다르면 다른 키다');
  assert.equal(await store.getEntry('data', 'never') ?? null, null);
  assert.equal(Number(text(data.get('web:data:tag:events').value)), 5_000);
  assert.deepEqual(timesOf(await store.tagTimes(['events', 'event:evt-lumen-1025', 'never']), ['events', 'event:evt-lumen-1025', 'never']), [5_000, 5_000, 0]);
});

test('HOT-390 공유 캐시 TTL 상한을 주지 않으면 정본의 30일이다', async () => {
  const { client, data } = fakeRedis();
  const store = createCacheStore({ client, now: () => 1_000 });
  await store.setEntry('data', 'long', 'v', 40 * 24 * 60 * 60);
  await store.setEntry('data', 'short', 'v', 29 * 24 * 60 * 60);
  await store.markTags(['events'], 1_000);
  assert.equal(data.get('web:data:long').ttlMs, DAYS_30_S * 1000);
  assert.equal(data.get('web:data:short').ttlMs, 29 * 24 * 60 * 60 * 1000);
  assert.equal(data.get('web:data:tag:events').ttlMs, DAYS_30_S * 1000);
});

test('HOT-390 태그 시각보다 먼저 만든 값은 없는 것으로 본다', async () => {
  const entry = (timestamp) => ({ value: new Blob(['hello']).stream(), tags: ['events'], stale: 30, timestamp, expire: 300, revalidate: 60 });
  const read = async (e) => (e ? await new Response(e.value).text() : undefined);

  // 태그 시각 = 만든 시각(같은 ms): 먼저 만든 것이 아니므로 남는다
  {
    let clock = 10_000;
    const { client } = fakeRedis();
    const h = createUseCacheHandler({ store: createCacheStore({ client, now: () => clock, timeoutMs: 250, maxTtlSeconds: 3_600 }), now: () => clock });
    await h.set('k', Promise.resolve(entry(10_000)));
    // 처리기는 get마다 새 흐름을 준다(두 번 읽어도 같은 글)
    assert.equal(await read(await h.get('k', [])), 'hello');
    assert.equal(await read(await h.get('k', [])), 'hello');
    await h.updateTags(['events']);
    await h.refreshTags();
    assert.equal(await h.getExpiration(['events']), 10_000);
    assert.equal(await read(await h.get('k', [])), 'hello');
  }
  // 태그 시각 = 만든 시각 + 1ms: 먼저 만든 값이라 없는 것으로 본다
  {
    let clock = 10_001;
    const { client } = fakeRedis();
    const h = createUseCacheHandler({ store: createCacheStore({ client, now: () => clock, timeoutMs: 250, maxTtlSeconds: 3_600 }), now: () => clock });
    await h.set('k', Promise.resolve(entry(10_000)));
    await h.updateTags(['events']);
    await h.refreshTags();
    assert.equal(await h.getExpiration(['events']), 10_001);
    assert.equal(await h.get('k', []), undefined);
    // 무효화한 적 없는 태그는 0
    assert.equal(await h.getExpiration(['never']), 0);
  }
});

test('HOT-390 Redis가 시간 한도 안에 답하지 않으면 읽기는 없음, 쓰기는 버림', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { client, data, ctl } = fakeRedis();
  const store = createCacheStore({ client, timeoutMs: 250, now: () => 1_000, maxTtlSeconds: 3_600 });
  await store.setEntry('data', 'k', 'v', 60);
  await flush();

  // 한도 − 1ms에 답하면 그 값을 쓴다
  ctl.delayMs = 249;
  const early = settled(store.getEntry('data', 'k'));
  await flush();
  mock.timers.tick(249);
  await flush();
  assert.equal(early.done, true);
  assert.equal(early.error, undefined);
  assert.equal(text(early.value), 'v');

  // 답하지 않으면: 한도 − 1ms까지는 기다리고, 한도에서 '없음'으로 끝난다(던지지 않는다)
  ctl.delayMs = Infinity;
  const late = settled(store.getEntry('data', 'k'));
  await flush();
  mock.timers.tick(249);
  await flush();
  assert.equal(late.done, false, '한도 전에 끝났다');
  mock.timers.tick(1);
  await flush();
  assert.equal(late.done, true, '한도(250ms)에 끝나지 않았다');
  assert.equal(late.error, undefined);
  assert.equal(late.value ?? null, null);

  // 쓰기도 한도에서 버리고 던지지 않는다
  const write = settled(store.setEntry('data', 'k2', 'v2', 60));
  await flush();
  mock.timers.tick(249);
  await flush();
  assert.equal(write.done, false);
  mock.timers.tick(1);
  await flush();
  assert.equal(write.done, true);
  assert.equal(write.error, undefined);
  assert.equal(data.has('web:data:k2'), false);

  // 끊김(거절)도 읽기는 없음, 쓰기는 던지지 않음
  ctl.delayMs = 0;
  ctl.fail = true;
  assert.equal((await store.getEntry('data', 'k')) ?? null, null);
  await store.setEntry('data', 'k3', 'v3', 60);
});

test('HOT-390 Redis 시간 한도를 주지 않으면 정본의 100ms다', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { client, ctl } = fakeRedis();
  const store = createCacheStore({ client, now: () => 1_000 });
  await store.setEntry('data', 'k', 'v', 60);
  await flush();
  ctl.delayMs = CANON_TIMEOUT_MS - 1;
  const early = settled(store.getEntry('data', 'k'));
  await flush();
  mock.timers.tick(CANON_TIMEOUT_MS - 1);
  await flush();
  assert.equal(text(early.value), 'v');
  ctl.delayMs = Infinity;
  const late = settled(store.getEntry('data', 'k'));
  await flush();
  mock.timers.tick(CANON_TIMEOUT_MS - 1);
  await flush();
  assert.equal(late.done, false);
  mock.timers.tick(1);
  await flush();
  assert.equal(late.done, true);
  assert.equal(late.value ?? null, null);
});

test('HOT-390 주소가 있을 때만 두 처리기와 cacheMaxMemorySize 0을 건다', () => {
  const url = 'redis://cache.internal:6379';
  const c = cacheConfig({ PEAKET_WEB_CACHE_REDIS_URL: url });
  assert.deepEqual(Object.keys(c).sort(), ['cacheHandler', 'cacheHandlers', 'cacheMaxMemorySize']);
  assert.equal(c.cacheMaxMemorySize, 0);
  assert.ok(isAbsolute(c.cacheHandler), c.cacheHandler);
  assert.match(c.cacheHandler.replaceAll('\\', '/'), /\/apps\/web\/server\/cache-handler\.mjs$/);
  assert.deepEqual(Object.keys(c.cacheHandlers), ['default']);
  assert.ok(isAbsolute(c.cacheHandlers.default));
  assert.match(c.cacheHandlers.default.replaceAll('\\', '/'), /\/apps\/web\/server\/use-cache-handler\.mjs$/);
  // 값이 없으면 Next.js 기본 처리기(빈 객체)
  for (const env of [{}, { PEAKET_WEB_CACHE_REDIS_URL: '' }, { PEAKET_WEB_CACHE_REDIS_URL: '   ' }]) assert.deepEqual(cacheConfig(env), {}, JSON.stringify(env));
});

test('HOT-390 운영·스테이징에서 주소가 없으면 시작하지 않는다', () => {
  for (const PEAKET_ENV of ['prod', 'staging']) {
    assert.throws(() => assertCacheEnv({ PEAKET_ENV }), /PEAKET_WEB_CACHE_REDIS_URL/, PEAKET_ENV);
    assert.throws(() => assertCacheEnv({ PEAKET_ENV, PEAKET_WEB_CACHE_REDIS_URL: '' }), /PEAKET_WEB_CACHE_REDIS_URL/, `${PEAKET_ENV} 빈 값`);
    assert.doesNotThrow(() => assertCacheEnv({ PEAKET_ENV, PEAKET_WEB_CACHE_REDIS_URL: 'rediss://cache.internal:6379' }), PEAKET_ENV);
  }
  // local·ci·demo는 주소 없이 시작한다(Next.js 기본 처리기)
  for (const PEAKET_ENV of ['local', 'ci', 'demo']) assert.doesNotThrow(() => assertCacheEnv({ PEAKET_ENV }), PEAKET_ENV);
});

test('HOT-390 server/start.mjs는 운영에서 캐시 주소가 없으면 Next.js를 띄우기 전에 멈춘다', async () => {
  const env = { ...process.env, PEAKET_ENV: 'prod', PEAKET_NEXT_DIST: '.next-bat170-none' };
  delete env.PEAKET_WEB_CACHE_REDIS_URL;
  const child = spawn(process.execPath, ['server/start.mjs', '--port', '39171', '--inner-port', '39172'], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const code = await new Promise((ok) => {
    const t = setTimeout(() => {
      child.kill();
      ok('시간 초과');
    }, 15_000);
    child.on('exit', (c) => {
      clearTimeout(t);
      ok(c);
    });
  });
  assert.notEqual(code, 0);
  assert.notEqual(code, '시간 초과', '15초 안에 멈추지 않았다');
  assert.match(out, /PEAKET_WEB_CACHE_REDIS_URL/);
  assert.doesNotMatch(out, /production build|next start/i, 'Next.js를 띄우려 했다');
});
