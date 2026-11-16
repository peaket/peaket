// 공유 캐시 저장소·처리기 단위 시험(BAT-170 웨이브 7 T13, docs/frontend.md §5.17 '공유 캐시 처리기 세부', docs/data.md 세션·캐시 클러스터 키 이름).
// 시험 담당(l2w7-BAT170-test)이 구현 전에 썼다(ADR-0270 결정 3). 가짜 Redis(아래 fakeRedis)와 가짜 시계(node:test mock.timers)로 돈다.
// 단언 값은 정본의 값이다: 키 꼴 web:isr:<캐시 키>·web:data:<캐시 키>·web:{tag}:<태그>(docs/frontend.md §5.17, 계획 §11 1), TTL 상한 30일, Redis 시간 한도 100ms.
// 주입하는 한도·상한은 일부러 정본 값과 다르게 골라(250ms, 3600초) 주입 값을 무시하는 결함도 잡는다.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, mock, test } from 'node:test';
import {
  assertCacheEnv,
  CACHE_KEY_BUDGET,
  cacheConfig,
  createCacheStore,
  createMemoryStore,
  DEFAULT_MAX_TTL_SECONDS,
  DEFAULT_WRITE_RATE,
  parseCacheUrls,
  selectRuntime,
  TRANSIENT_TAG,
} from './cache-store.mjs';
import { CACHE_BUILD_ENV, readBuildTag } from './cache-env.mjs';
import { createCacheHandler } from './cache-handler.mjs';
import { createUseCacheHandler } from './use-cache-handler.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 정본: 태그 시각·값 TTL 상한 30일 [가정](docs/frontend.md §5.17) */
const DAYS_30_S = 30 * 24 * 60 * 60;
/** 정본: Redis가 이 안에 답하지 않으면 읽기는 없음·쓰기는 버림 100ms [가정] */
const CANON_TIMEOUT_MS = 100;
/** 정본(W7L2-S10): 값 TTL 상한 기본 1시간 [가정] */
const HOUR_S = 3_600;

/**
 * 가짜 Redis. node-redis(6.3.0)의 get·set·mGet·expire·pExpire와 sendCommand(GET·SET EX|PX·MGET·EXPIRE·PEXPIRE)를 받는다.
 * delayMs: 답하는 데 걸리는 시간(Infinity면 답하지 않음), fail: 연결 끊김으로 거절. ttlMs가 null이면 TTL 없는 키다.
 */
function fakeRedis() {
  /** @type {Map<string, { value: unknown, ttlMs: number | null }>} */
  const data = new Map();
  const ctl = { delayMs: 0, fail: false };
  /** 받은 명령 기록: { cmd, keys } */
  const calls = [];
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
  const log = (cmd, keys) => calls.push({ cmd, keys });
  const client = {
    get: (k) => (log('GET', [k]), respond(() => data.get(k)?.value ?? null)),
    mGet: (keys) => (log('MGET', [...keys]), respond(() => keys.map((k) => data.get(k)?.value ?? null))),
    set: (k, v, o) => (
      log('SET', [k]),
      respond(() => {
        data.set(k, { value: v, ttlMs: ttlOf(o) });
        return 'OK';
      })
    ),
    expire: (k, s) => (log('EXPIRE', [k]), respond(() => raw(['EXPIRE', k, s]))),
    pExpire: (k, ms) => (log('PEXPIRE', [k]), respond(() => raw(['PEXPIRE', k, ms]))),
    sendCommand: (args) => {
      const cmd = String(args[0]).toUpperCase();
      log(cmd, cmd === 'MGET' ? args.slice(1).map(String) : [String(args[1])]);
      return respond(() => raw(args));
    },
  };
  return { client, data, ctl, calls };
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

  assert.deepEqual([...data.keys()].sort(), ['web:data:abc123', 'web:data:edge', 'web:isr:/events/evt-lumen-1025', 'web:{tag}:event:evt-lumen-1025', 'web:{tag}:events']);
  assert.equal(data.get('web:isr:/events/evt-lumen-1025').ttlMs, 60_000, '값 TTL은 만료(60초)');
  assert.equal(data.get('web:data:abc123').ttlMs, 3_600_000, '만료가 상한보다 길면 상한');
  assert.equal(data.get('web:data:edge').ttlMs, 3_600_000);
  assert.equal(data.get('web:{tag}:events').ttlMs, 3_600_000, '태그 시각 TTL은 상한');
  assert.equal(data.get('web:{tag}:event:evt-lumen-1025').ttlMs, 3_600_000);
  for (const [k, e] of data) assert.ok(e.ttlMs !== null && e.ttlMs > 0, `TTL 없는 키: ${k}`);

  // 저장소 응답은 정확한 값까지
  assert.equal(text(await store.getEntry('isr', '/events/evt-lumen-1025')), 'isr-value');
  assert.equal(text(await store.getEntry('data', 'abc123')), 'data-value');
  assert.equal(await store.getEntry('isr', 'abc123') ?? null, null, '종류가 다르면 다른 키다');
  assert.equal(await store.getEntry('data', 'never') ?? null, null);
  assert.equal(Number(text(data.get('web:{tag}:events').value)), 5_000);
  assert.deepEqual(timesOf(await store.tagTimes(['events', 'event:evt-lumen-1025', 'never']), ['events', 'event:evt-lumen-1025', 'never']), [5_000, 5_000, 0]);
});

// BAT-170 시험 뒤 정한 것(계획 §11 1): 값 키와 태그 키는 둘째 칸(isr·data·{tag})이 달라 겹치지 않는다
test('HOT-390 값 키와 태그 키는 겹치지 않는다', async () => {
  const { client, data } = fakeRedis();
  const store = createCacheStore({ client, timeoutMs: 250, now: () => 1_000, maxTtlSeconds: 3_600 });
  // 'tag:'로 시작하는 캐시 키와, 그 뒤 글자와 같은 이름의 태그를 함께 쓴다
  await store.setEntry('data', 'tag:events', 'data-value', 60);
  await store.setEntry('isr', 'tag:events', 'isr-value', 60);
  await store.markTags(['events', 'tag:events'], 7_000);
  assert.deepEqual([...data.keys()].sort(), ['web:data:tag:events', 'web:isr:tag:events', 'web:{tag}:events', 'web:{tag}:tag:events']);
  assert.equal(text(await store.getEntry('data', 'tag:events')), 'data-value');
  assert.equal(text(await store.getEntry('isr', 'tag:events')), 'isr-value');
  assert.deepEqual(timesOf(await store.tagTimes(['events', 'tag:events']), ['events', 'tag:events']), [7_000, 7_000]);
  // 값 쓰기가 태그 시각을 덮지 않고, 태그 쓰기가 값을 덮지 않는다
  await store.setEntry('data', '{tag}:events', 'brace-value', 60);
  assert.deepEqual(timesOf(await store.tagTimes(['events']), ['events']), [7_000]);
  assert.equal(text(await store.getEntry('data', 'tag:events')), 'data-value');
});

// BAT-170 시험 뒤 정한 것(계획 §11 1): 태그 키는 한 해시 태그 슬롯에 모여 MGET 한 번으로 읽는다(클러스터 모드 CROSSSLOT 막기)
test('HOT-390 여러 태그는 한 번에 읽는다(같은 해시 태그 슬롯)', async () => {
  const { client, calls } = fakeRedis();
  const store = createCacheStore({ client, timeoutMs: 250, now: () => 1_000, maxTtlSeconds: 3_600 });
  await store.markTags(['a', 'b'], 9_000);
  calls.length = 0;
  const tags = ['a', 'b', 'never'];
  assert.deepEqual(timesOf(await store.tagTimes(tags), tags), [9_000, 9_000, 0]);
  assert.equal(calls.length, 1, `태그 읽기 명령 ${calls.length}번: ${JSON.stringify(calls)}`);
  assert.equal(calls[0].cmd, 'MGET');
  assert.deepEqual([...calls[0].keys].sort(), ['web:{tag}:a', 'web:{tag}:b', 'web:{tag}:never']);
  // 태그 쓰기 키도 모두 같은 해시 태그다
  calls.length = 0;
  await store.markTags(['c', 'd'], 9_500);
  const written = calls.flatMap((c) => c.keys);
  assert.ok(written.length > 0);
  for (const k of written) assert.match(k, /^web:\{tag\}:/, k);
});

// BAT-170 W7L2-S10(계획 §16 S10-6, docs/frontend.md §5.18 TTL 문장): 값 TTL 상한 기본은 1시간 [가정]으로 줄었고 태그 시각은 30일 그대로다
test('HOT-390 공유 캐시 TTL 상한을 주지 않으면 값은 정본의 1시간, 태그는 30일이다', async () => {
  const { client, data } = fakeRedis();
  const store = createCacheStore({ client, now: () => 1_000 });
  await store.setEntry('data', 'long', 'v', 40 * 24 * 60 * 60);
  await store.setEntry('data', 'edge', 'v', HOUR_S);
  await store.setEntry('data', 'short', 'v', HOUR_S - 1);
  await store.markTags(['events'], 1_000);
  assert.equal(data.get('web:data:long').ttlMs, HOUR_S * 1000);
  assert.equal(data.get('web:data:edge').ttlMs, HOUR_S * 1000);
  assert.equal(data.get('web:data:short').ttlMs, (HOUR_S - 1) * 1000);
  assert.equal(data.get('web:{tag}:events').ttlMs, DAYS_30_S * 1000);
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

// BAT-170 리뷰 R170-1(계획 §12, docs/frontend.md §5.18 '공유 캐시 처리기 세부'): 처리기를 걸지가 빌드 때 굳지 않게, next 설정은 늘 두 처리기를 건다
test('HOT-390 R170-1 next 설정은 환경 값과 관계없이 두 처리기와 cacheMaxMemorySize 0을 건다', () => {
  const configs = [{ PEAKET_WEB_CACHE_REDIS_URL: 'redis://cache.internal:6379' }, {}, { PEAKET_WEB_CACHE_REDIS_URL: '' }, { PEAKET_WEB_CACHE_REDIS_URL: '   ' }].map((env) => cacheConfig(env));
  for (const c of configs) {
    assert.deepEqual(Object.keys(c).sort(), ['cacheHandler', 'cacheHandlers', 'cacheMaxMemorySize']);
    assert.equal(c.cacheMaxMemorySize, 0);
    assert.ok(isAbsolute(c.cacheHandler), c.cacheHandler);
    assert.match(c.cacheHandler.replaceAll('\\', '/'), /\/apps\/web\/server\/cache-handler\.mjs$/);
    assert.deepEqual(Object.keys(c.cacheHandlers), ['default']);
    assert.ok(isAbsolute(c.cacheHandlers.default));
    assert.match(c.cacheHandlers.default.replaceAll('\\', '/'), /\/apps\/web\/server\/use-cache-handler\.mjs$/);
  }
  for (const c of configs.slice(1)) assert.deepEqual(c, configs[0]);
});

/**
 * 두 처리기 모듈을 그 환경으로 새 프로세스에서 불러 '쓰고 읽기'를 한 번 한다. 소켓 연결 시도 수(net.Socket connect)를 함께 센다.
 * @returns {Promise<{ code: number | null, out: string, result?: { importError?: string, useGet?: string | null, isrGet?: string | null, connects: number } }>}
 */
async function probeHandlers(env) {
  const dir = mkdtempSync(join(tmpdir(), 'bat170-probe-'));
  const serverDir = pathToFileURL(join(appDir, 'server') + '/').href;
  writeFileSync(
    join(dir, 'probe.mjs'),
    `import net from 'node:net';
let connects = 0;
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...a) { connects += 1; return connect.apply(this, a); };
const done = (r) => { console.log('BAT170-PROBE ' + JSON.stringify({ ...r, connects })); process.exit(0); };
let useMod, isrMod;
try {
  useMod = (await import(${JSON.stringify(serverDir + 'use-cache-handler.mjs')})).default;
  isrMod = (await import(${JSON.stringify(serverDir + 'cache-handler.mjs')})).default;
} catch (e) { done({ importError: String(e && e.message || e) }); }
const entry = { value: new Blob(['probe-body']).stream(), tags: ['probe'], stale: 30, timestamp: Date.now() - 10, expire: 300, revalidate: 60 };
let useGet = null, isrGet = null;
try {
  await useMod.set('probe-key', Promise.resolve(entry));
  const got = await useMod.get('probe-key', []);
  useGet = got ? await new Response(got.value).text() : null;
  const h = new isrMod({ revalidatedTags: [], _requestHeaders: {} });
  await h.set('/probe', { kind: 'APP_PAGE', html: '<p>probe</p>', rscData: Buffer.from('rsc'), headers: { 'x-next-cache-tags': 'probe-isr' }, postponed: undefined, status: 200, segmentData: new Map() }, { cacheControl: { revalidate: 60, expire: 300 }, isFallback: false });
  const hit = await h.get('/probe', { kind: 'APP_PAGE', isFallback: false });
  isrGet = hit?.value?.html ?? null;
} catch (e) { done({ importError: 'run: ' + String(e && e.message || e) }); }
done({ useGet, isrGet });
`,
  );
  const clean = { ...process.env };
  for (const k of ['PEAKET_WEB_CACHE_REDIS_URL', 'PEAKET_WEB_CACHE_BUILD', 'PEAKET_ENV']) delete clean[k];
  const child = spawn(process.execPath, [join(dir, 'probe.mjs')], { cwd: appDir, env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const code = await new Promise((ok) => {
    const t = setTimeout(() => {
      child.kill();
      ok(null);
    }, 15_000);
    child.on('exit', (c) => {
      clearTimeout(t);
      ok(c);
    });
  });
  rmSync(dir, { recursive: true, force: true });
  const line = out.split('\n').find((l) => l.startsWith('BAT170-PROBE '));
  return { code, out, result: line ? JSON.parse(line.slice('BAT170-PROBE '.length)) : undefined };
}

test('HOT-390 R170-1 처리기는 실행 때 저장소를 고른다: 주소 없음은 메모리, 있음은 Redis', async () => {
  // 주소 없음(local, 빌드 칸 없음 → dev): 메모리 저장소라 쓴 값을 읽고 Redis에 붙지 않는다
  const mem = await probeHandlers({ PEAKET_ENV: 'local' });
  assert.ok(mem.result, mem.out);
  assert.equal(mem.result.importError, undefined, mem.out);
  assert.equal(mem.result.useGet, 'probe-body', "'use cache' 처리기가 메모리 저장소로 쓰고 읽지 않았다");
  assert.equal(mem.result.isrGet, '<p>probe</p>', '미리 그린 화면 처리기가 메모리 저장소로 쓰고 읽지 않았다');
  assert.equal(mem.result.connects, 0, 'Redis 연결을 만들었다');
  // 주소 있음(닿지 않는 Redis, 빌드 칸 있음): Redis를 쓰므로 붙으려 하고, 메모리처럼 값을 돌려주지 않는다
  const redis = await probeHandlers({ PEAKET_ENV: 'prod', PEAKET_WEB_CACHE_REDIS_URL: 'redis://127.0.0.1:1', PEAKET_WEB_CACHE_BUILD: 'bat170probe' });
  assert.ok(redis.result, redis.out);
  assert.equal(redis.result.importError, undefined, redis.out);
  assert.ok(redis.result.connects > 0, 'Redis에 붙으려 하지 않았다');
  assert.equal(redis.result.useGet, null);
  assert.equal(redis.result.isrGet, null);
  // 주소가 있는데 빌드 칸이 없거나 꼴 밖이면 처리기 모듈을 불러올 때 던진다(조용히 빌드 칸 없이 쓰지 않는다)
  for (const build of [undefined, '', 'bad build', 'a:b']) {
    const r = await probeHandlers({ PEAKET_ENV: 'prod', PEAKET_WEB_CACHE_REDIS_URL: 'redis://127.0.0.1:1', ...(build === undefined ? {} : { PEAKET_WEB_CACHE_BUILD: build }) });
    assert.ok(r.result?.importError, `빌드 칸 ${JSON.stringify(build)}: 불러올 때 던지지 않았다 ${r.out}`);
    assert.doesNotMatch(r.result.importError, /^run:/, `빌드 칸 ${JSON.stringify(build)}`);
  }
});

test('HOT-390 R170-1 메모리 저장소는 같은 키 꼴·TTL을 따르고 1,000개를 넘으면 먼저 넣은 것부터 지운다', async () => {
  let clock = 1_000;
  const store = createMemoryStore({ now: () => clock, maxTtlSeconds: 3_600, maxEntries: 5 });
  // TTL: 값은 만료와 상한 가운데 짧은 쪽, 경계 직전에는 있고 경계에서는 없다
  await store.setEntry('data', 'short', 'v-short', 60);
  await store.setEntry('isr', 'long', 'v-long', 7_200);
  await store.markTags(['events'], 1_000);
  clock = 1_000 + 60_000 - 1;
  assert.equal(text(await store.getEntry('data', 'short')), 'v-short');
  clock = 1_000 + 60_000;
  assert.equal((await store.getEntry('data', 'short')) ?? null, null, '만료(60초)에 지워지지 않았다');
  clock = 1_000 + 3_600_000 - 1;
  assert.equal(text(await store.getEntry('isr', 'long')), 'v-long');
  assert.deepEqual(timesOf(await store.tagTimes(['events']), ['events']), [1_000]);
  clock = 1_000 + 3_600_000;
  assert.equal((await store.getEntry('isr', 'long')) ?? null, null, '상한(3,600초)에 지워지지 않았다');
  assert.deepEqual(timesOf(await store.tagTimes(['events']), ['events']), [0], '태그 시각이 상한에 지워지지 않았다');

  // 같은 키 꼴: 종류가 다르거나 태그와 같은 이름이어도 겹치지 않는다
  const kinds = createMemoryStore({ now: () => 1_000, maxTtlSeconds: 3_600, maxEntries: 5 });
  await kinds.setEntry('data', 'tag:events', 'data-value', 60);
  await kinds.setEntry('isr', 'tag:events', 'isr-value', 60);
  await kinds.markTags(['tag:events'], 7_000);
  assert.equal(text(await kinds.getEntry('data', 'tag:events')), 'data-value');
  assert.equal(text(await kinds.getEntry('isr', 'tag:events')), 'isr-value');
  assert.deepEqual(timesOf(await kinds.tagTimes(['tag:events', 'events']), ['tag:events', 'events']), [7_000, 0]);

  // 상한(주입 5): 5개째까지 모두 남고, 6개째를 넣으면 처음 것만 사라진다
  const lim = createMemoryStore({ now: () => 1_000, maxTtlSeconds: 3_600, maxEntries: 5 });
  for (let i = 1; i <= 5; i++) await lim.setEntry('data', `k${i}`, `v${i}`, 60);
  for (let i = 1; i <= 5; i++) assert.equal(text(await lim.getEntry('data', `k${i}`)), `v${i}`, `k${i}`);
  await lim.setEntry('data', 'k6', 'v6', 60);
  assert.equal((await lim.getEntry('data', 'k1')) ?? null, null, '처음 넣은 것이 남았다');
  for (let i = 2; i <= 6; i++) assert.equal(text(await lim.getEntry('data', `k${i}`)), `v${i}`, `k${i}`);

  // 상한을 주지 않으면 정본의 1,000개다
  const def = createMemoryStore({ now: () => 1_000 });
  for (let i = 1; i <= 1_000; i++) await def.setEntry('data', `d${i}`, `v${i}`, 60);
  assert.equal(text(await def.getEntry('data', 'd1')), 'v1', '1,000개째까지는 남아야 한다');
  await def.setEntry('data', 'd1001', 'v1001', 60);
  assert.equal((await def.getEntry('data', 'd1')) ?? null, null, '1,001개째에 처음 것이 지워지지 않았다');
  assert.equal(text(await def.getEntry('data', 'd2')), 'v2');
  assert.equal(text(await def.getEntry('data', 'd1001')), 'v1001');
});

// BAT-170 리뷰 R170-2(계획 §12): 미리 그린 화면 키에 빌드 칸을 넣어 판을 넘어 옛 HTML을 내보내지 않는다. 태그 시각은 판을 넘는다
const isrPage = (html, tag) => ({ kind: 'APP_PAGE', html, rscData: Buffer.from(`rsc:${html}`), headers: { 'x-next-cache-tags': tag }, postponed: undefined, status: 200, segmentData: new Map() });
const isrSetCtx = { cacheControl: { revalidate: 60, expire: 300 }, isFallback: false };
const isrGetCtx = { kind: 'APP_PAGE', isFallback: false };

test('HOT-390 R170-2 미리 그린 화면 키는 web:isr:<빌드 칸>:<캐시 키>이고 빌드가 다르면 서로의 값을 읽지 않는다', async () => {
  let clock = 1_000;
  const { client, data } = fakeRedis();
  const store = createCacheStore({ client, timeoutMs: 250, now: () => clock, maxTtlSeconds: 3_600 });
  const a = createCacheHandler({ store, build: 'a1b2c3d4', now: () => clock });
  const b = createCacheHandler({ store, build: 'a1b2c3d5', now: () => clock });
  await a.set('/search', isrPage('<p>A 검색</p>', 'search'), isrSetCtx);
  assert.deepEqual([...data.keys()].filter((k) => k.startsWith('web:isr:')), ['web:isr:a1b2c3d4:/search']);
  assert.equal((await a.get('/search', isrGetCtx))?.value?.html, '<p>A 검색</p>');
  assert.equal((await b.get('/search', isrGetCtx)) ?? null, null, '다른 빌드의 화면을 읽었다');

  // 태그 무효화는 판을 넘는다: B가 쓴 화면을 A의 revalidateTag가 없는 것으로 만든다
  await b.set('/help', isrPage('<p>B 도움말</p>', 't'), isrSetCtx);
  assert.equal((await b.get('/help', isrGetCtx))?.value?.html, '<p>B 도움말</p>');
  clock = 2_000;
  await a.revalidateTag('t');
  assert.equal((await b.get('/help', isrGetCtx)) ?? null, null, 'A의 태그 무효화가 B의 화면에 닿지 않았다');

  // 'use cache' 값 키에는 빌드 칸을 붙이지 않는다
  const u = createUseCacheHandler({ store, now: () => clock });
  await u.set('data-key', Promise.resolve({ value: new Blob(['d']).stream(), tags: [], stale: 30, timestamp: clock, expire: 300, revalidate: 60 }));
  assert.ok(data.has('web:data:data-key'), [...data.keys()].join(', '));
});

test('HOT-390 R170-2 빌드 칸 꼴: [A-Za-z0-9_-] 1~64자만 받는다', () => {
  const dirs = [];
  const dist = ({ buildId, deploymentId }) => {
    const d = mkdtempSync(join(tmpdir(), 'bat170-build-'));
    dirs.push(d);
    writeFileSync(join(d, 'required-server-files.json'), JSON.stringify({ version: 1, config: deploymentId === undefined ? {} : { deploymentId } }));
    if (buildId !== undefined) writeFileSync(join(d, 'BUILD_ID'), buildId);
    return d;
  };
  try {
    const max = 'A'.repeat(32) + 'z_9-'.repeat(8); // 64자
    assert.equal(max.length, 64);
    assert.equal(readBuildTag(dist({ buildId: max })), max);
    assert.equal(readBuildTag(dist({ buildId: 'qB1bkfBfEP64sJDWyhDVH' })), 'qB1bkfBfEP64sJDWyhDVH');
    // deploymentId가 있으면 BUILD_ID보다 앞선다
    assert.equal(readBuildTag(dist({ buildId: 'bid', deploymentId: 'dep_1-A' })), 'dep_1-A');
    const bad = [`${max}x`, '', 'a:b', 'a/b', 'a b', '한글빌드', 'a\nb'];
    for (const v of bad) assert.throws(() => readBuildTag(dist({ buildId: v })), Error, `BUILD_ID ${JSON.stringify(v)}`);
    // 꼴 밖의 deploymentId는 맞는 BUILD_ID가 있어도 받지 않는다
    for (const v of bad.filter((x) => x !== '')) assert.throws(() => readBuildTag(dist({ buildId: 'ok-build', deploymentId: v })), Error, `deploymentId ${JSON.stringify(v)}`);
    // 둘 다 없으면 던진다
    assert.throws(() => readBuildTag(dist({})), Error);
    // 처리기도 같은 꼴만 받는다
    const { client } = fakeRedis();
    const store = createCacheStore({ client, timeoutMs: 250, now: () => 1_000, maxTtlSeconds: 3_600 });
    assert.doesNotThrow(() => createCacheHandler({ store, build: max }));
    for (const v of bad) assert.throws(() => createCacheHandler({ store, build: v }), Error, `처리기 빌드 칸 ${JSON.stringify(v)}`);
    assert.throws(() => createCacheHandler({ store, build: undefined }), Error);
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
});

test('HOT-390 R170-2 빌드 칸을 넘기는 환경 값 이름은 PEAKET_WEB_CACHE_BUILD다', () => {
  assert.equal(CACHE_BUILD_ENV, 'PEAKET_WEB_CACHE_BUILD');
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

// BAT-170 시험 뒤 정한 것(계획 §11 5, docs/frontend.md §5.17 공유 캐시 처리기 세부): 닫힌 규칙. local·ci·demo만 주소 없이 뜬다
test('HOT-390 PEAKET_ENV가 local·ci·demo가 아니면(없음·빈 값·오타·대소문자 다름) 주소 없이 시작하지 않는다', () => {
  const cases = [{}, { PEAKET_ENV: '' }, { PEAKET_ENV: '   ' }, { PEAKET_ENV: 'production' }, { PEAKET_ENV: 'dev' }, { PEAKET_ENV: 'PROD' }, { PEAKET_ENV: 'Local' }, { PEAKET_ENV: 'CI' }, { PEAKET_ENV: 'test' }];
  for (const env of cases) assert.throws(() => assertCacheEnv(env), /PEAKET_WEB_CACHE_REDIS_URL/, JSON.stringify(env));
  for (const env of cases) assert.doesNotThrow(() => assertCacheEnv({ ...env, PEAKET_WEB_CACHE_REDIS_URL: 'rediss://cache.internal:6379' }), `${JSON.stringify(env)} + 주소`);
  for (const PEAKET_ENV of ['local', 'ci', 'demo']) assert.doesNotThrow(() => assertCacheEnv({ PEAKET_ENV, PEAKET_WEB_CACHE_REDIS_URL: '' }), `${PEAKET_ENV} 빈 주소`);
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

// BAT-170 리뷰 다시 보기 R170-8(docs/frontend.md §5.18 '공유 캐시 처리기 세부' ② 메모리 저장소는 local·ci·demo 전용, ⑤ 닫힌 규칙):
// start.mjs를 거치지 않고 떠도(standalone 기본 진입점 node server.js, next start) 주소 없는 운영에서 처리기가 메모리 저장소로 조용히 돌지 않는다.
// 정본에 던지는 때(불러올 때·첫 호출)가 정해져 있지 않아, 불러오기나 첫 get·set 가운데 어느 쪽에서 던져도 통과로 본다.
/**
 * 처리기 모듈 하나를 그 환경으로 새 프로세스에서 불러 쓰고 읽는다.
 * @returns {Promise<{ out: string, result?: { threw: 'import' | 'call' | null, error?: string, value?: string | null } }>}
 */
async function probeOne(file, env) {
  const dir = mkdtempSync(join(tmpdir(), 'bat170-r8-'));
  const href = pathToFileURL(join(appDir, 'server', file)).href;
  writeFileSync(
    join(dir, 'probe.mjs'),
    `const done = (r) => { console.log('BAT170-R8 ' + JSON.stringify(r)); process.exit(0); };
let mod;
try { mod = (await import(${JSON.stringify(href)})).default; } catch (e) { done({ threw: 'import', error: String(e && e.message || e) }); }
try {
  if (${JSON.stringify(file)} === 'use-cache-handler.mjs') {
    await mod.set('r8-key', Promise.resolve({ value: new Blob(['r8-body']).stream(), tags: [], stale: 30, timestamp: Date.now() - 10, expire: 300, revalidate: 60 }));
    const got = await mod.get('r8-key', []);
    done({ threw: null, value: got ? await new Response(got.value).text() : null });
  } else {
    const h = new mod({ revalidatedTags: [], _requestHeaders: {} });
    await h.set('/r8', { kind: 'APP_PAGE', html: '<p>r8</p>', rscData: Buffer.from('rsc'), headers: {}, postponed: undefined, status: 200, segmentData: new Map() }, { cacheControl: { revalidate: 60, expire: 300 }, isFallback: false });
    const hit = await h.get('/r8', { kind: 'APP_PAGE', isFallback: false });
    done({ threw: null, value: hit?.value?.html ?? null });
  }
} catch (e) { done({ threw: 'call', error: String(e && e.message || e) }); }
`,
  );
  const clean = { ...process.env };
  for (const k of ['PEAKET_WEB_CACHE_REDIS_URL', 'PEAKET_WEB_CACHE_BUILD', 'PEAKET_ENV']) delete clean[k];
  const child = spawn(process.execPath, [join(dir, 'probe.mjs')], { cwd: appDir, env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  await new Promise((ok) => {
    const t = setTimeout(() => {
      child.kill();
      ok(undefined);
    }, 15_000);
    child.on('exit', () => {
      clearTimeout(t);
      ok(undefined);
    });
  });
  rmSync(dir, { recursive: true, force: true });
  const line = out.split('\n').find((l) => l.startsWith('BAT170-R8 '));
  return { out, result: line ? JSON.parse(line.slice('BAT170-R8 '.length)) : undefined };
}

test('HOT-390 R170-8 주소 없는 운영(PEAKET_ENV가 local·ci·demo 밖)에서는 두 처리기가 메모리 저장소로 조용히 돌지 않는다', async () => {
  const modules = [
    ['use-cache-handler.mjs', 'r8-body'],
    ['cache-handler.mjs', '<p>r8</p>'],
  ];
  // 운영으로 보는 환경: 주소가 없으면 불러오기나 첫 get·set이 던진다
  for (const env of [{ PEAKET_ENV: 'prod' }, {}, { PEAKET_ENV: '' }, { PEAKET_ENV: 'production' }, { PEAKET_ENV: 'PROD' }]) {
    for (const [file] of modules) {
      const r = await probeOne(file, env);
      assert.ok(r.result, `${file} ${JSON.stringify(env)}: 결과 없음\n${r.out}`);
      assert.ok(r.result.threw === 'import' || r.result.threw === 'call', `${file} ${JSON.stringify(env)}: 던지지 않고 돌았다(값 ${JSON.stringify(r.result.value)})`);
    }
  }
  // 대조군: local·ci·demo는 메모리 저장소로 쓰고 읽는다
  for (const PEAKET_ENV of ['local', 'ci', 'demo']) {
    for (const [file, want] of modules) {
      const r = await probeOne(file, { PEAKET_ENV });
      assert.ok(r.result, `${file} ${PEAKET_ENV}: 결과 없음\n${r.out}`);
      assert.equal(r.result.threw, null, `${file} ${PEAKET_ENV}: ${r.result.error}`);
      assert.equal(r.result.value, want, `${file} ${PEAKET_ENV}: 메모리 저장소로 쓰고 읽지 않았다`);
    }
  }
});

// BAT-170 R170-8 고침의 예외 경계(계획 §12 'R170-8 고침의 예외 판정' R8-1~R8-3, docs/frontend.md §5.18 '공유 캐시 처리기 세부' ②′):
// 주소가 없을 때 닫힌 규칙을 보지 않는 때는 Next.js 운영 빌드 단계(NEXT_PHASE가 정확히 phase-production-build)와 개발 서버(__NEXT_DEV_SERVER)뿐이다.
// 시험 담당(l2w7-BAT170-test)이 구현 dbef5e1f 뒤에 썼다. 예외를 넓히거나 빼는 틀린 구현을 잡는다.
/** 저장소가 메모리로 쓰고 읽는지(true), 거절하는지(false) */
async function storeServes(store) {
  try {
    await store.setEntry('data', 'r8-probe', 'r8-value', 60);
    return text(await store.getEntry('data', 'r8-probe')) === 'r8-value';
  } catch {
    return false;
  }
}

test('HOT-390 R170-8 빌드 단계와 개발 서버만 닫힌 규칙에서 빠진다', async () => {
  // 주소 없음·PEAKET_ENV 없음
  assert.equal(await storeServes(selectRuntime({ NEXT_PHASE: 'phase-production-build' }).store), true, '빌드 단계가 메모리 저장소가 아니다');
  assert.equal(await storeServes(selectRuntime({ __NEXT_DEV_SERVER: '1' }).store), true, '개발 서버가 메모리 저장소가 아니다');
  // 목록 밖 값마다 거절하는 저장소다
  for (const NEXT_PHASE of ['phase-production-server', 'phase-export', 'phase-development-server', 'PHASE-PRODUCTION-BUILD', 'phase-production-build ', ' phase-production-build', 'phase-production-build-x']) {
    const { store } = selectRuntime({ NEXT_PHASE });
    await assert.rejects(store.getEntry('data', 'x'), Error, `NEXT_PHASE ${JSON.stringify(NEXT_PHASE)}`);
    assert.equal(await storeServes(store), false, `NEXT_PHASE ${JSON.stringify(NEXT_PHASE)}`);
  }
  // 운영으로 보는 PEAKET_ENV는 예외 표시가 없으면 거절, 대조군 local·ci·demo는 메모리
  for (const env of [{}, { PEAKET_ENV: 'prod' }, { PEAKET_ENV: 'staging' }]) assert.equal(await storeServes(selectRuntime(env).store), false, JSON.stringify(env));
  for (const PEAKET_ENV of ['local', 'ci', 'demo']) assert.equal(await storeServes(selectRuntime({ PEAKET_ENV }).store), true, PEAKET_ENV);
});

test('HOT-390 R170-8 주소가 있으면 빌드 단계·개발 서버 표시와 관계없이 Redis와 빌드 칸 규칙이다', () => {
  const url = 'redis://127.0.0.1:1';
  for (const mark of [{ NEXT_PHASE: 'phase-production-build' }, { __NEXT_DEV_SERVER: '1' }, { PEAKET_ENV: 'local' }, {}]) {
    // 빌드 칸이 없거나 꼴 밖이면 던지고 메모리로 떨어지지 않는다
    for (const build of [undefined, '', 'a:b']) {
      const env = { PEAKET_WEB_CACHE_REDIS_URL: url, ...mark, ...(build === undefined ? {} : { PEAKET_WEB_CACHE_BUILD: build }) };
      assert.throws(() => selectRuntime(env), Error, JSON.stringify(env));
    }
  }
  // 빌드 칸이 맞으면 그 칸을 쓴다(메모리의 'dev'가 아니다)
  const r = selectRuntime({ PEAKET_WEB_CACHE_REDIS_URL: url, PEAKET_WEB_CACHE_BUILD: 'bat170r8', NEXT_PHASE: 'phase-production-build' });
  assert.equal(r.build, 'bat170r8');
});

test('HOT-390 R170-8 거절하는 저장소는 네 메서드 모두 거절하고 까닭을 싣는다', async () => {
  const { store } = selectRuntime({});
  for (const [name, call] of [
    ['getEntry', () => store.getEntry('data', 'k')],
    ['setEntry', () => store.setEntry('isr', 'k', 'v', 60)],
    ['tagTimes', () => store.tagTimes(['t'])],
    ['markTags', () => store.markTags(['t'], 1_000)],
  ]) {
    await assert.rejects(call, /PEAKET_WEB_CACHE_REDIS_URL/, name);
  }
  // 불러오기는 던지지 않는다(거절은 첫 읽기·쓰기 때). 두 처리기 모듈 모두
  for (const file of ['use-cache-handler.mjs', 'cache-handler.mjs']) {
    const r = await probeOne(file, {});
    assert.ok(r.result, `${file}: 결과 없음\n${r.out}`);
    assert.notEqual(r.result.threw, 'import', `${file}: 불러올 때 던졌다 ${r.result.error}`);
    assert.equal(r.result.threw, 'call', `${file}: 첫 읽기·쓰기가 거절하지 않았다`);
    assert.match(r.result.error, /PEAKET_WEB_CACHE_REDIS_URL/, file);
  }
});

// BAT-170 검증 뒤 시험(d02b8d19 '## 검증'에서 살아남은 틀린 구현을 잡는다). 시험 담당(l2w7-BAT170-test)이 썼다.
// 정본: docs/frontend.md §5.18 '공유 캐시 처리기 세부'(닫힌 규칙, 태그 시각보다 먼저 만든 값은 없음, 늦거나 끊기면 읽기는 없음),
// docs/data.md 세션·캐시 클러스터 키 규칙(ISR 항목 크기 상한 1MB [가정]).
test('HOT-390 V170-7 PEAKET_ENV는 앞뒤 빈칸까지 그대로 본다(" local "·"ci "는 운영으로 본다)', async () => {
  for (const PEAKET_ENV of [' local ', 'ci ', ' demo', 'local\n', '\tci']) {
    assert.throws(() => assertCacheEnv({ PEAKET_ENV }), /PEAKET_WEB_CACHE_REDIS_URL/, JSON.stringify(PEAKET_ENV));
    assert.equal(await storeServes(selectRuntime({ PEAKET_ENV }).store), false, JSON.stringify(PEAKET_ENV));
  }
});

test('HOT-390 V170-13 미리 그린 화면도 태그 시각이 만든 시각과 같은 ms면 남고 +1ms면 없다', async () => {
  for (const [tagAt, kept] of [
    [1_000, true],
    [1_001, false],
  ]) {
    let clock = 1_000;
    const { client } = fakeRedis();
    const store = createCacheStore({ client, timeoutMs: 250, now: () => clock, maxTtlSeconds: 3_600 });
    const h = createCacheHandler({ store, build: 'v170b13', now: () => clock });
    await h.set('/search', isrPage('<p>검색</p>', 'search'), isrSetCtx);
    clock = tagAt;
    await h.revalidateTag('search');
    const hit = await h.get('/search', isrGetCtx);
    assert.equal(hit?.value?.html ?? null, kept ? '<p>검색</p>' : null, `태그 시각 ${tagAt}, 만든 시각 1000`);
  }
});

test('HOT-390 V170-23 값 크기 상한은 1MB(1,048,576바이트)이고 바이트로 센다', async () => {
  const { client, data } = fakeRedis();
  const store = createCacheStore({ client, timeoutMs: 250, now: () => 1_000, maxTtlSeconds: 3_600 });
  await store.setEntry('isr', 'at-cap', 'x'.repeat(1_048_576), 60);
  await store.setEntry('isr', 'over-cap', 'x'.repeat(1_048_577), 60);
  // 한글 한 글자는 3바이트: 글자 수는 상한 아래여도 바이트가 넘으면 쓰지 않는다
  await store.setEntry('isr', 'ko-under', '가'.repeat(349_525), 60); // 1,048,575바이트
  await store.setEntry('isr', 'ko-over', '가'.repeat(349_526), 60); // 1,048,578바이트
  assert.equal(data.has('web:isr:at-cap'), true, '정확히 1MB가 쓰이지 않았다');
  assert.equal(data.has('web:isr:over-cap'), false, '1MB + 1바이트가 쓰였다');
  assert.equal(data.has('web:isr:ko-under'), true);
  assert.equal(data.has('web:isr:ko-over'), false, '글자 수로 셌다');
});

test('HOT-390 V170-24 미리 그린 화면은 태그 시각을 못 읽으면(늦음·끊김) 값을 내지 않는다', async () => {
  const { client } = fakeRedis();
  const fast = createCacheStore({ client, timeoutMs: 30, now: () => 1_000, maxTtlSeconds: 3_600 });
  await createCacheHandler({ store: fast, build: 'v170b24', now: () => 1_000 }).set('/search', isrPage('<p>검색</p>', 'search'), isrSetCtx);
  // 대조군: 태그 시각을 읽으면 값을 낸다
  assert.equal((await createCacheHandler({ store: fast, build: 'v170b24' }).get('/search', isrGetCtx))?.value?.html, '<p>검색</p>');
  const isMget = (args) => String(args[0]).toUpperCase() === 'MGET';
  for (const [label, tagRead] of [
    ['늦음(답하지 않음)', () => new Promise(() => {})],
    ['끊김(거절)', () => Promise.reject(new Error('연결이 끊겼다'))],
  ]) {
    // 값 읽기(GET)는 되고 태그 읽기(MGET)만 늦거나 끊긴다
    const slow = { ...client, mGet: tagRead, sendCommand: (args) => (isMget(args) ? tagRead() : client.sendCommand(args)) };
    const store = createCacheStore({ client: slow, timeoutMs: 30, now: () => 1_000, maxTtlSeconds: 3_600 });
    const hit = await createCacheHandler({ store, build: 'v170b24' }).get('/search', isrGetCtx);
    assert.equal(hit ?? null, null, `${label}: 태그 시각을 못 읽었는데 값을 냈다`);
  }
});

test('HOT-390 V170-25 미리 그린 화면은 경로 무효화 태그(softTags)도 본다', async () => {
  let clock = 1_000;
  const { client } = fakeRedis();
  const store = createCacheStore({ client, timeoutMs: 250, now: () => clock, maxTtlSeconds: 3_600 });
  const h = createCacheHandler({ store, build: 'v170b25', now: () => clock });
  await h.set('/search', isrPage('<p>검색</p>', 'search'), isrSetCtx);
  clock = 2_000;
  await store.markTags(['_N_T_/search'], 2_000);
  assert.equal((await h.get('/search', { ...isrGetCtx, softTags: ['_N_T_/search'] })) ?? null, null, '경로 무효화 뒤에도 값을 냈다');
  // 대조군: 무효화하지 않은 경로 태그나 softTags가 없으면 값이 남는다
  assert.equal((await h.get('/search', { ...isrGetCtx, softTags: ['_N_T_/other'] }))?.value?.html, '<p>검색</p>');
  assert.equal((await h.get('/search', isrGetCtx))?.value?.html, '<p>검색</p>');
});

test('HOT-390 V170-26 미리 그린 화면 처리기는 요청 안에서 무효화한 태그(revalidatedTags)를 없는 것으로 본다', async () => {
  // 기본 내보내기 클래스(Next.js가 부르는 바깥 경계)를 메모리 저장소(local)로 불러온다
  const saved = { PEAKET_ENV: process.env.PEAKET_ENV, URL: process.env.PEAKET_WEB_CACHE_REDIS_URL, BUILD: process.env.PEAKET_WEB_CACHE_BUILD };
  process.env.PEAKET_ENV = 'local';
  delete process.env.PEAKET_WEB_CACHE_REDIS_URL;
  delete process.env.PEAKET_WEB_CACHE_BUILD;
  let Handler;
  try {
    Handler = (await import('./cache-handler.mjs?v170-26')).default;
  } finally {
    for (const [k, v] of [['PEAKET_ENV', saved.PEAKET_ENV], ['PEAKET_WEB_CACHE_REDIS_URL', saved.URL], ['PEAKET_WEB_CACHE_BUILD', saved.BUILD]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  await new Handler({ revalidatedTags: [] }).set('/v170-26', isrPage('<p>요청 안</p>', 't'), isrSetCtx);
  assert.equal((await new Handler({ revalidatedTags: [] }).get('/v170-26', isrGetCtx))?.value?.html, '<p>요청 안</p>', '대조군');
  assert.equal((await new Handler({ revalidatedTags: ['u'] }).get('/v170-26', isrGetCtx))?.value?.html, '<p>요청 안</p>', '다른 태그 대조군');
  assert.equal((await new Handler({ revalidatedTags: ['t'] }).get('/v170-26', isrGetCtx)) ?? null, null, '요청 안에서 무효화한 태그의 값을 냈다');
});

// BAT-170 웨이브 끝 리뷰 재현(계획 §14, 보안 8fd2505c·동시 실행 c27a4620). 시험 담당(l2w7-BAT170-test)이 구현 전에 썼다(ADR-0270 결정 3).
// 정본: docs/frontend.md §5.18 '공유 캐시 처리기 세부'의 TTL 문장·'키 수 막기'·'클러스터 연결과 회복'.
// 주입 값(상한·쓰기 몫·시간 한도)은 정본 값과 다르게 골라 주입을 무시하는 결함을 잡고, 기본값(12배·30일·초당 50·몫 100)은 따로 본다.
test('HOT-390 W7L2-S1 값 TTL은 만료·간격의 12배·상한 가운데 가장 짧은 쪽이다', async () => {
  const ttl = async (o, expire, revalidate) => {
    const { client, data } = fakeRedis();
    const store = createCacheStore({ client, timeoutMs: 250, now: () => 1_000, ...o });
    await store.setEntry('data', 'k', 'v', expire, revalidate);
    return data.get('web:data:k').ttlMs / 1000;
  };
  const cap = { maxTtlSeconds: 7_200 };
  assert.equal(await ttl(cap, 0xfffffffe, 300), 3_600, '간격 300 × 12');
  assert.equal(await ttl(cap, 1_000, 300), 1_000, '만료가 더 짧다');
  assert.equal(await ttl(cap, 5_000, undefined), 5_000, '간격 없음: 만료와 상한 가운데 짧은 쪽');
  assert.equal(await ttl(cap, 0xfffffffe, undefined), 7_200, '간격 없음·만료 무한: 상한');
  // 간격 × 12가 상한과 같을 때와 1초 클 때(경계 양쪽)
  assert.equal(await ttl({ maxTtlSeconds: 7_200 }, 0xfffffffe, 600), 7_200);
  assert.equal(await ttl({ maxTtlSeconds: 7_199 }, 0xfffffffe, 600), 7_199);
  assert.equal(await ttl({ maxTtlSeconds: 7_201 }, 0xfffffffe, 600), 7_200);
  // 기본 배수 12와 기본 상한(W7L2-S10부터 1시간 [가정])
  assert.equal(await ttl({}, 0xfffffffe, 300), 3_600);
  assert.equal(await ttl({}, 0xfffffffe, 300_000), HOUR_S, '간격 × 12가 기본 상한(1시간)보다 길면 1시간');
  assert.equal(await ttl({}, 0xfffffffe, undefined), HOUR_S, '간격 없음·만료 무한: 기본 상한 1시간');
});

test('HOT-390 W7L2-S1 web-transient 태그 항목은 공유 캐시에 쓰지 않고 파드 메모리에 60초만 둔다', async () => {
  assert.equal(TRANSIENT_TAG, 'web-transient');
  let clock = 10_000;
  const { client, calls } = fakeRedis();
  const store = createCacheStore({ client, timeoutMs: 250, now: () => clock, maxTtlSeconds: 3_600 });
  const h = createUseCacheHandler({ store, now: () => clock });
  const entry = (body, tags) => ({ value: new Blob([body]).stream(), tags, stale: 30, timestamp: clock, expire: 300, revalidate: 60 });
  const read = async (e) => (e ? await new Response(e.value).text() : undefined);
  await h.set('missing-event', Promise.resolve(entry('없음', ['web-transient', 'event:x'])));
  assert.equal(calls.filter((c) => c.cmd === 'SET').length, 0, '공유하지 않을 항목을 Redis에 썼다');
  clock = 10_000 + 59_999;
  assert.equal(await read(await h.get('missing-event', [])), '없음', '60초 안인데 파드 메모리에 없다');
  clock = 10_000 + 60_000;
  assert.equal(await h.get('missing-event', []), undefined, '60초가 지났는데 남았다');
  // 파드 메모리는 1,000개까지: 1,001개째를 넣으면 처음 것이 빠진다
  clock = 100_000;
  for (let i = 1; i <= 1_000; i++) await h.set(`t${i}`, Promise.resolve(entry(`v${i}`, ['web-transient'])));
  assert.equal(await read(await h.get('t1', [])), 'v1', '1,000개째까지는 남아야 한다');
  await h.set('t1001', Promise.resolve(entry('v1001', ['web-transient'])));
  assert.equal(await h.get('t1', []), undefined, '1,001개째에 처음 것이 빠지지 않았다');
  assert.equal(await read(await h.get('t1001', [])), 'v1001');
  assert.equal(calls.filter((c) => c.cmd === 'SET').length, 0);
  // 대조군: 태그가 없는 항목은 Redis에 쓴다
  await h.set('found-event', Promise.resolve(entry('있음', [])));
  assert.ok(calls.some((c) => c.cmd === 'SET' && c.keys.includes('web:data:found-event')), '보통 항목을 Redis에 쓰지 않았다');
});

test('HOT-390 W7L2-S1 상태가 200이 아닌 미리 그린 화면은 공유 캐시에 쓰지 않는다', async () => {
  const { client, data } = fakeRedis();
  const store = createCacheStore({ client, timeoutMs: 250, now: () => 1_000, maxTtlSeconds: 3_600 });
  const h = createCacheHandler({ store, build: 'w7l2s1', now: () => 1_000 });
  const pageWith = (status) => ({ ...isrPage(`<p>${status}</p>`, 'event'), status });
  for (const status of [404, 410, 500]) {
    await h.set(`/events/s${status}`, pageWith(status), isrSetCtx);
    assert.equal(data.has(`web:isr:w7l2s1:/events/s${status}`), false, `${status} 화면을 Redis에 썼다`);
    assert.equal((await h.get(`/events/s${status}`, isrGetCtx))?.value?.html, `<p>${status}</p>`, `${status} 화면이 파드 메모리에서 읽히지 않는다`);
  }
  // 대조군: 200과 상태 칸 없음은 Redis에 쓴다
  await h.set('/events/s200', pageWith(200), isrSetCtx);
  const noStatus = isrPage('<p>none</p>', 'event');
  delete noStatus.status;
  await h.set('/events/none', noStatus, isrSetCtx);
  assert.equal(data.has('web:isr:w7l2s1:/events/s200'), true);
  assert.equal(data.has('web:isr:w7l2s1:/events/none'), true);
});

test('HOT-390 W7L2-S1 파드마다 공유 캐시 쓰기는 초당 몫을 넘으면 버리고 센다', async () => {
  let clock = 1_000;
  const { client, data } = fakeRedis();
  const store = createCacheStore({ client, timeoutMs: 250, now: () => clock, maxTtlSeconds: 3_600, writeRate: { perSecond: 5, burst: 10 } });
  for (let i = 1; i <= 10; i++) await store.setEntry('data', `w${i}`, `v${i}`, 60);
  assert.equal([...data.keys()].filter((k) => k.startsWith('web:data:w')).length, 10, '몫 10개가 다 가지 않았다');
  await store.setEntry('data', 'w11', 'v11', 60);
  assert.equal(data.has('web:data:w11'), false, '11번째가 갔다');
  assert.equal(store.stats().droppedWrites, 1);
  // 초당 5 = 200ms마다 하나: 199ms 뒤엔 버리고 200ms 뒤엔 간다
  clock = 1_199;
  await store.setEntry('data', 'w12', 'v12', 60);
  assert.equal(data.has('web:data:w12'), false, '199ms 뒤에 갔다');
  assert.equal(store.stats().droppedWrites, 2);
  clock = 1_200;
  await store.setEntry('data', 'w13', 'v13', 60);
  assert.equal(data.has('web:data:w13'), true, '200ms 뒤에 가지 않았다');
  // 버린 쓰기에도 읽기는 그대로다
  assert.equal(text(await store.getEntry('data', 'w1')), 'v1');
  assert.equal((await store.getEntry('data', 'w11')) ?? null, null);
  // 기본값(W7L2-S10부터 새 키 초당 2·몫 100 [가정]): 같은 시각에 새 키 100개는 가고 101번째는 버린다
  const d = fakeRedis();
  const def = createCacheStore({ client: d.client, timeoutMs: 250, now: () => 5_000, maxTtlSeconds: 3_600 });
  for (let i = 1; i <= 101; i++) await def.setEntry('data', `d${i}`, 'v', 60);
  assert.equal(d.data.has('web:data:d100'), true);
  assert.equal(d.data.has('web:data:d101'), false);
  assert.equal(def.stats().droppedWrites, 1);
});

/** 가짜 클러스터 연결: get의 동작을 바꿔 가며 쓴다 */
function fakeCluster() {
  const state = { mode: 'ok', error: null, attempts: [] };
  const client = {
    get: () => (state.mode === 'hang' ? new Promise(() => {}) : state.mode === 'error' ? Promise.reject(state.error) : Promise.resolve('v')),
    set: () => Promise.resolve('OK'),
    mGet: (keys) => Promise.resolve(keys.map(() => null)),
    on: () => client,
    close: async () => {},
    destroy: () => {},
    disconnect: async () => {},
    quit: async () => {},
  };
  return { state, client };
}
const replyError = (message) => Object.assign(new Error(message), { name: 'ErrorReply' });
const lines = () => {
  const out = [];
  const push = (...a) => void out.push(a.map(String).join(' '));
  return { out, logger: Object.assign(push, { info: push, warn: push, error: push, log: push, debug: push }) };
};
const CRED_URL = 'redis://cacheuser:s3cr3t-pw@cache-0.internal:6379';

test('HOT-390 W7L2-K2 다시 붙기 간격은 50ms에서 두 배씩 1초까지이고 한 번에 하나만 시도한다', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  // 붙지 못하는 클러스터: 1ms마다 요청을 보내 연결 시도 시각을 모은다
  const attempts = [];
  const down = createCacheStore({ urls: [CRED_URL], connect: () => (attempts.push(Date.now()), Promise.reject(new Error('ECONNREFUSED'))), timeoutMs: 250, maxTtlSeconds: 3_600 });
  for (let t = 0; t <= 3_700; t++) {
    void down.getEntry('data', 'k');
    await flush();
    mock.timers.tick(1);
    await flush();
  }
  const gaps = attempts.slice(1, 8).map((x, i) => x - attempts[i]);
  assert.deepEqual(gaps, [50, 100, 200, 400, 800, 1_000, 1_000], `연결 시도 시각 ${attempts.slice(0, 9).join(', ')}`);
  // 붙는 동안 동시에 온 요청 둘: 연결 시도는 1번이고, 둘 다 기다리지 않고 없음이다
  let calls = 0;
  const pending = createCacheStore({ urls: [CRED_URL], connect: () => (calls++, new Promise(() => {})), timeoutMs: 250, maxTtlSeconds: 3_600 });
  const a = settled(pending.getEntry('data', 'k'));
  const b = settled(pending.getEntry('data', 'k'));
  await flush();
  await flush();
  assert.equal(calls, 1, '동시에 연결을 둘 시도했다');
  assert.equal(a.done && b.done, true, '붙는 동안 요청이 기다렸다(명령을 쌓았다)');
  assert.equal(a.value ?? null, null);
  assert.equal(b.value ?? null, null);
});

test('HOT-390 W7L2-K2 연속 시간 초과 5번이나 READONLY·CLUSTERDOWN·TRYAGAIN·LOADING이면 연결을 버린다', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const timedOut = async (store) => {
    const p = settled(store.getEntry('data', 'k'));
    await flush();
    mock.timers.tick(250);
    await flush();
    assert.equal(p.done, true);
  };
  {
    const c = fakeCluster();
    const store = createCacheStore({ urls: [CRED_URL], connect: () => Promise.resolve(c.client), timeoutMs: 250, maxTtlSeconds: 3_600 });
    c.state.mode = 'hang';
    for (let i = 0; i < 4; i++) await timedOut(store);
    assert.equal(store.stats().consecutiveTimeouts, 4);
    assert.equal(store.stats().resets, 0, '4번에 버렸다');
    await timedOut(store);
    assert.equal(store.stats().resets, 1, '5번째에 버리지 않았다');
  }
  {
    // 사이에 성공이 끼면 다시 센다
    const c = fakeCluster();
    const store = createCacheStore({ urls: [CRED_URL], connect: () => Promise.resolve(c.client), timeoutMs: 250, maxTtlSeconds: 3_600 });
    c.state.mode = 'hang';
    for (let i = 0; i < 4; i++) await timedOut(store);
    c.state.mode = 'ok';
    assert.equal(await store.getEntry('data', 'k'), 'v');
    assert.equal(store.stats().consecutiveTimeouts, 0, '성공 뒤 연속 수가 0이 아니다');
    c.state.mode = 'hang';
    for (let i = 0; i < 4; i++) await timedOut(store);
    assert.equal(store.stats().resets, 0);
    await timedOut(store);
    assert.equal(store.stats().resets, 1);
  }
  // 네 응답 오류마다 1번씩 버리고, 그 밖의 응답 오류는 버리지 않는다
  for (const [message, reset] of [
    ["READONLY You can't write against a read only replica.", 1],
    ['CLUSTERDOWN The cluster is down', 1],
    ['TRYAGAIN Multiple keys request during rehashing of slot', 1],
    ['LOADING Valkey is loading the dataset in memory', 1],
    ['ERR unknown command', 0],
    ['WRONGTYPE Operation against a key holding the wrong kind of value', 0],
  ]) {
    const c = fakeCluster();
    const store = createCacheStore({ urls: [CRED_URL], connect: () => Promise.resolve(c.client), timeoutMs: 250, maxTtlSeconds: 3_600 });
    c.state.mode = 'error';
    c.state.error = replyError(message);
    assert.equal((await store.getEntry('data', 'k')) ?? null, null, message);
    assert.equal(store.stats().resets, reset, message);
  }
});

test('HOT-390 W7L2-K2 회복 로그는 1분에 한 번이고 주소·비밀번호를 싣지 않는다', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const c = fakeCluster();
  c.state.mode = 'error';
  c.state.error = replyError("READONLY You can't write against a read only replica.");
  const { out, logger } = lines();
  const store = createCacheStore({ urls: [CRED_URL], connect: () => Promise.resolve(c.client), logger, timeoutMs: 250, maxTtlSeconds: 3_600 });
  /** 그 시각에 연결을 한 번 버리게 한다(다시 붙는 요청이 먼저 올 수 있어 몇 번 보낸다) */
  const resetAt = async () => {
    const before = store.stats().resets;
    for (let i = 0; i < 5 && store.stats().resets === before; i++) {
      await store.getEntry('data', 'k');
      await flush();
    }
    assert.equal(store.stats().resets, before + 1, `${Date.now()}ms에 연결을 버리지 않았다`);
  };
  await resetAt();
  mock.timers.tick(59_999);
  await resetAt();
  assert.equal(out.length, 1, `59,999ms 안의 두 번이 로그 ${out.length}줄`);
  mock.timers.tick(1);
  await resetAt();
  assert.equal(out.length, 2, '60,000ms에 2줄째가 없다');
  for (const l of out) {
    assert.doesNotMatch(l, /cache-0\.internal/, '로그에 호스트가 있다');
    assert.doesNotMatch(l, /s3cr3t-pw/, '로그에 비밀번호가 있다');
  }
});

test('HOT-390 W7L2-K1 시작 주소는 쉼표로 나눈 하나 이상이고 빈칸은 뺀다', () => {
  assert.deepEqual(parseCacheUrls({ PEAKET_WEB_CACHE_REDIS_URL: 'rediss://a:6379' }), ['rediss://a:6379']);
  assert.deepEqual(parseCacheUrls({ PEAKET_WEB_CACHE_REDIS_URL: ' rediss://a:6379 , rediss://b:6379,,rediss://c:6379 ' }), ['rediss://a:6379', 'rediss://b:6379', 'rediss://c:6379']);
  for (const v of [undefined, '', ' , ']) assert.deepEqual(parseCacheUrls(v === undefined ? {} : { PEAKET_WEB_CACHE_REDIS_URL: v }), [], String(v));
});

// BAT-170 W7L2-S10 재현(계획 §16 S10-4·S10-5, 보안 다시 보기 0dc4054b, docs/frontend.md §5.18 '키 수 막기' ③·TTL 문장).
// 시험 담당(l2w7-BAT170-test)이 구현 전에 썼다(ADR-0270 결정 3). 몫은 새 키만 센다. 아는 키(그 파드가 TTL 안에 읽어 맞았거나 직접 쓴 키)를 다시 쓰는 것은 몫을 쓰지 않는다.
// 주입: writeRate { perSecond, burst, knownKeys }(knownKeys는 최근 키 목록 크기). 주입 값은 정본 값과 다르게 고른다.
test('HOT-390 W7L2-S10 새 키 몫: 아는 키 다시 쓰기는 몫을 쓰지 않고, 새 키는 초당 몫·모아 둘 몫을 넘으면 버린다', async () => {
  let clock = 1_000;
  const { client, data } = fakeRedis();
  const store = createCacheStore({ client, timeoutMs: 250, now: () => clock, maxTtlSeconds: 3_600, writeRate: { perSecond: 1, burst: 3, knownKeys: 10 } });
  for (const k of ['k1', 'k2', 'k3']) await store.setEntry('data', k, `${k}-v1`, 60);
  await store.setEntry('data', 'k4', 'k4-v1', 60);
  assert.equal(data.has('web:data:k4'), false, '몫(3)을 넘은 새 키가 갔다');
  assert.equal(store.stats().droppedWrites, 1);
  // 같은 시각에 이미 쓴 키를 다시 쓰면 간다
  await store.setEntry('data', 'k1', 'k1-v2', 60);
  assert.equal(text(data.get('web:data:k1').value), 'k1-v2', '직접 쓴 키를 다시 쓰는데 몫을 썼다');
  // 다른 파드가 쓴 키를 읽어 맞았으면 그 키를 다시 쓰는 것도 몫을 쓰지 않는다
  data.set('web:data:other', { value: 'other-v1', ttlMs: 60_000 });
  assert.equal(text(await store.getEntry('data', 'other')), 'other-v1');
  await store.setEntry('data', 'other', 'other-v2', 60);
  assert.equal(text(data.get('web:data:other').value), 'other-v2', '읽어 맞은 키를 다시 쓰는데 몫을 썼다');
  assert.equal(store.stats().droppedWrites, 1);
  // 초당 1: 999ms 뒤 새 키는 버리고, 1,000ms 뒤 새 키는 간다
  clock = 1_999;
  await store.setEntry('data', 'k5', 'v', 60);
  assert.equal(data.has('web:data:k5'), false, '999ms 뒤에 새 키가 갔다');
  clock = 2_000;
  await store.setEntry('data', 'k6', 'v', 60);
  assert.equal(data.has('web:data:k6'), true, '1,000ms 뒤에 새 키가 가지 않았다');

  // 최근 키 목록(주입 3): 넷째 키를 넣으면 처음 것이 빠지고, 그 키를 다시 쓰면 새 키로 센다
  const d = fakeRedis();
  const lim = createCacheStore({ client: d.client, timeoutMs: 250, now: () => 5_000, maxTtlSeconds: 3_600, writeRate: { perSecond: 1, burst: 4, knownKeys: 3 } });
  for (const k of ['a', 'b', 'c', 'd']) await lim.setEntry('data', k, `${k}-1`, 60);
  assert.equal(d.data.size, 4);
  await lim.setEntry('data', 'd', 'd-2', 60);
  assert.equal(text(d.data.get('web:data:d').value), 'd-2', '목록 안의 키(d)를 다시 쓰지 못했다');
  await lim.setEntry('data', 'a', 'a-2', 60);
  assert.equal(text(d.data.get('web:data:a').value), 'a-1', '목록에서 빠진 키(a)를 아는 키로 셌다');
  assert.equal(lim.stats().droppedWrites, 1);
});

test('HOT-390 W7L2-S10 상한 식: 기본 몫은 P × (r × T + b) × S ≤ W를 지킨다', () => {
  // 정본 값(docs/frontend.md §5.18 '키 수 막기' ③): P 10, T 1시간, S 60kB, W 약 6GB, r 초당 2, b 100, 최근 키 목록 2만 개 [가정]
  const P = 10;
  const T = 3_600;
  const S = 60_000;
  const W = 6_000_000_000;
  assert.deepEqual(CACHE_KEY_BUDGET, { pods: P, entryBytes: S, budgetBytes: W }, '식의 상수가 정본 값과 다르다');
  assert.equal(DEFAULT_MAX_TTL_SECONDS, T);
  assert.equal(DEFAULT_WRITE_RATE.perSecond, 2);
  assert.equal(DEFAULT_WRITE_RATE.burst, 100);
  assert.equal(DEFAULT_WRITE_RATE.knownKeys, 20_000);
  const left = (r) => P * (r * DEFAULT_MAX_TTL_SECONDS + DEFAULT_WRITE_RATE.burst) * S;
  assert.ok(left(DEFAULT_WRITE_RATE.perSecond) <= W, `기본 몫의 왼쪽 ${left(DEFAULT_WRITE_RATE.perSecond)} > W ${W}`);
  // 경계: r을 1 올리면 식이 깨진다
  assert.ok(left(DEFAULT_WRITE_RATE.perSecond + 1) > W, 'r을 1 올려도 식이 깨지지 않는다(몫이 너무 낮게 잡혔거나 식이 틀렸다)');
});

test('HOT-390 W7L2-S10 값 TTL 상한 기본은 1시간, 태그는 30일이다', async () => {
  const { client, data } = fakeRedis();
  const store = createCacheStore({ client, timeoutMs: 250, now: () => 1_000 });
  await store.setEntry('data', 'interval', 'v', 0xfffffffe, 300);
  await store.setEntry('data', 'none', 'v', 0xfffffffe);
  await store.markTags(['events'], 1_000);
  assert.equal(data.get('web:data:interval').ttlMs, 3_600_000, '간격 300초 항목');
  assert.equal(data.get('web:data:none').ttlMs, 3_600_000, '간격 없음·만료 무한 항목');
  assert.equal(data.get('web:{tag}:events').ttlMs, 2_592_000_000, '태그 TTL');
});

// BAT-170 웨이브 끝 재검증 V170-R9(2bf0a549, docs/frontend.md §5.18 '키 수 막기' ③): 몫은 새 값 키 쓰기만 센다. 태그 무효화 쓰기를 몫에 넣으면
// 몫을 넘었을 때 무효화가 버려져 옛 화면이 남는다. 시험 담당(l2w7-BAT170-test)이 썼다.
test('HOT-390 V170-R9 태그 무효화 쓰기는 새 키 몫에 걸리지 않는다', async () => {
  const { client, data } = fakeRedis();
  const store = createCacheStore({ client, timeoutMs: 250, now: () => 1_000, maxTtlSeconds: 3_600, writeRate: { perSecond: 1, burst: 1, knownKeys: 10 } });
  await store.setEntry('data', 'n1', 'v', 60);
  await store.setEntry('data', 'n2', 'v', 60);
  assert.equal(data.has('web:data:n2'), false, '몫을 다 쓰지 않았다(대조군이 뜻이 없다)');
  const dropped = store.stats().droppedWrites;
  assert.equal(dropped, 1);
  await store.markTags(['t', 'u'], 1_000);
  assert.equal(Number(text(data.get('web:{tag}:t')?.value ?? 0)), 1_000, '몫을 다 쓴 뒤 태그 무효화가 쓰이지 않았다');
  assert.equal(Number(text(data.get('web:{tag}:u')?.value ?? 0)), 1_000);
  assert.equal(store.stats().droppedWrites, dropped, '태그 무효화를 버린 쓰기로 셌다');
});
