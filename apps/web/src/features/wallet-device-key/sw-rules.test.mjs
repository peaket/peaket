// 월렛 서비스 워커 규칙 시험(BAT-170 웨이브 7 T7, docs/frontend.md §5.4 '서비스 워커'·'갱신' ①⑤, docs/security/asvs/frontend.md 14.3.2).
// 시험 담당(l2w7-BAT170-test)이 구현 전에 썼다(ADR-0270 결정 3). 단언 값은 정본의 글을 옮겨 적었고 코드 상수를 가져오지 않는다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isNetworkOnlyPath, isSkipWaitingMessage, isWalletCacheVersion, isWalletDocumentPath, rejectNoStore, rotateWalletCaches, staleWalletCaches, walletCacheName } from './sw-rules.ts';

test('[ASVS v5.0.0-14.3.2] 페이지 이동 캐시는 /my/tickets와 /my/tickets/{id}만이고 양도·취소·부가 상품은 뺀다', () => {
  // 두 꼴(끝 `/`는 같은 주소로 본다)
  for (const p of ['/my/tickets', '/my/tickets/', '/my/tickets/tkt-lumen-r1-0312', '/my/tickets/tkt-lumen-r1-0312/']) {
    assert.equal(isWalletDocumentPath(p), true, p);
  }
  // 그 밖의 /my/tickets/…(양도·취소·부가 상품)와 접두만 같은 주소는 모두 네트워크로만
  for (const p of [
    '/my/tickets/tkt-lumen-r1-0312/transfer',
    '/my/tickets/tkt-lumen-r1-0313/cancel',
    '/my/tickets/tkt-lumen-r1-0312/addons',
    '/my/tickets/tkt-lumen-r1-0312/transfer/',
    '/my/ticketsx',
    '/my/tickets-old',
    '/my',
    '/my/orders',
    '/',
    '/en/my/tickets/tkt-lumen-r1-0312/transfer',
  ]) {
    assert.equal(isWalletDocumentPath(p), false, p);
  }
});

test('[ASVS v5.0.0-14.3.2] no-store 응답은 캐시에 넣지 않는다(no-store가 다른 지시어 사이에 있어도)', async () => {
  const will = (cc) => {
    const response = new Response('<p>티켓</p>', { status: 200, headers: cc === undefined ? {} : { 'cache-control': cc } });
    return { response, result: rejectNoStore.cacheWillUpdate({ request: new Request('https://www.peaket.example/my/tickets'), response, event: undefined, state: undefined }) };
  };
  for (const cc of ['no-store', 'private, no-store, max-age=0', 'max-age=0,no-store', 'No-Store', 'private,  no-store']) {
    const { result } = will(cc);
    assert.equal(await result, null, cc);
  }
  // no-store가 없으면 그 응답을 그대로 돌려준다(같은 객체)
  for (const cc of [undefined, 'no-cache', 'private, max-age=60', 'public, s-maxage=300']) {
    const { response, result } = will(cc);
    assert.equal(await result, response, String(cc));
  }
});

test('HOT-390 SKIP_WAITING 메시지만 활성화를 부른다', () => {
  assert.equal(isSkipWaitingMessage({ type: 'SKIP_WAITING' }), true);
  for (const m of [undefined, null, 'SKIP_WAITING', {}, { type: 'skip_waiting' }, { type: 'SKIP_WAITING_NOW' }, { type: ['SKIP_WAITING'] }, { kind: 'SKIP_WAITING' }, 1, true]) {
    assert.equal(isSkipWaitingMessage(m), false, JSON.stringify(m) ?? String(m));
  }
});

test('HOT-390 API(/v1/)와 워커 자신(/serwist/)은 네트워크로만 받는다', () => {
  for (const p of ['/v1/', '/v1/tickets/me', '/serwist/sw.js', '/serwist/']) assert.equal(isNetworkOnlyPath(p), true, p);
  for (const p of ['/v10/tickets', '/v1', '/serwistx/sw.js', '/my/tickets', '/', '/_next/static/chunks/a.js']) assert.equal(isNetworkOnlyPath(p), false, p);
});

// ---------- 런타임 캐시 판(BAT-350, O-T46, docs/frontend.md §5.4 '갱신'의 런타임 캐시 판, §3.12 저장 표, ADR-0336 결정 5) ----------
// 단언 값은 정본의 글에서 적는다: 이름 `wallet-shell-{판}`, 옛 이름 `wallet-pages`·`wallet-assets`, 다시 받기 다 합쳐 10초 [가정], 5xx·no-store 거절.
// 판은 두 자리(9 → 10)까지 넣어 글자로 견주는 결함(접두만 보기)을 잡는다. Cache Storage는 워커 표준 API라 아래 메모리 대역으로 바꿔 끼운다.

const ORIGIN = 'https://www.peaket.example';
const PRECACHE = `serwist-precache-v2-${ORIGIN}/`;

/** 워커 표준 Cache의 메모리 대역(rotateWalletCaches가 쓰는 keys·put·match). 주소마다 응답 하나, 넣은 차례를 지킨다 */
class MemoryCache {
  entries = new Map();
  async keys() {
    return [...this.entries.keys()].map((u) => new Request(u));
  }
  async put(request, response) {
    const url = typeof request === 'string' ? request : request.url;
    this.entries.set(url, { body: await response.text(), status: response.status, headers: [...response.headers] });
  }
  async match(request) {
    const e = this.entries.get(typeof request === 'string' ? request : request.url);
    return e ? new Response(e.body, { status: e.status, headers: e.headers }) : undefined;
  }
}

/** 워커 표준 CacheStorage의 메모리 대역(keys·open·delete·has). open은 없으면 만든다(표준과 같다) */
class MemoryCacheStorage {
  caches = new Map();
  async keys() {
    return [...this.caches.keys()];
  }
  async open(name) {
    if (!this.caches.has(name)) this.caches.set(name, new MemoryCache());
    return this.caches.get(name);
  }
  async has(name) {
    return this.caches.has(name);
  }
  async delete(name) {
    return this.caches.delete(name);
  }
  /** 시험 준비: 이름 → { 경로: 본문 } */
  static async seeded(layout) {
    const s = new MemoryCacheStorage();
    for (const [name, entries] of Object.entries(layout)) {
      const c = await s.open(name);
      for (const [path, body] of Object.entries(entries)) await c.put(`${ORIGIN}${path}`, new Response(body, { status: 200 }));
    }
    return s;
  }
}

/** 캐시 하나의 { 경로(쿼리 포함): 본문 }. 캐시가 없으면 undefined */
function contentsOf(storage, name) {
  const c = storage.caches.get(name);
  if (!c) return undefined;
  const out = {};
  for (const [url, e] of c.entries) {
    const u = new URL(url);
    out[`${u.pathname}${u.search}`] = e.body;
  }
  return out;
}

/** 다시 받기 응답을 경로별로 주는 네트워크 대역. 부른 경로를 기록하고, 없는 경로는 연결 실패(TypeError)다 */
function network(byPath, onFetch = () => {}) {
  const fetched = [];
  const fetch = async (input) => {
    const path = new URL(typeof input === 'string' ? input : input.url).pathname;
    fetched.push(path);
    onFetch(path);
    const r = byPath[path];
    if (!r) throw new TypeError('fetch failed');
    return r();
  };
  return { fetch, fetched };
}

test('O-T46 ① 런타임 캐시는 판을 붙인 이름 하나이고 미리 저장 판과 같다(이름 꼴 wallet-shell-{판})', () => {
  // §3.12 저장 표: `wallet-shell-{판}`. 미리 저장 판과 같은지는 pwa-config.test.mjs의 O-T46 ①이 빌드 설정으로 본다
  assert.equal(walletCacheName('9'), 'wallet-shell-9');
  assert.equal(walletCacheName('10'), 'wallet-shell-10');
  assert.equal(walletCacheName('deploy_2026-11-21'), 'wallet-shell-deploy_2026-11-21');
  assert.equal(walletCacheName('wallet-dev'), 'wallet-shell-wallet-dev');
});

test('O-T46 ② 판 9→10 활성화는 지금 판이 아닌 wallet-shell-과 옛 이름 둘만 지운다', async () => {
  const names = [PRECACHE, 'wallet-pages', 'wallet-assets', 'wallet-shell-9', 'wallet-shell-1', 'wallet-shell-10', 'wallet-shell', 'wallet-shellx', 'wallet-pages-old', 'Wallet-shell-9', 'peaket-other'];
  // 순수 규칙: 지울 것은 접두 `wallet-shell-`이면서 지금 판이 아닌 것과 옛 이름 둘뿐이다(1은 10의 접두지만 다른 판이다)
  assert.deepEqual(staleWalletCaches(names, '10').sort(), ['wallet-assets', 'wallet-pages', 'wallet-shell-1', 'wallet-shell-9']);
  assert.deepEqual(staleWalletCaches(names, '1').sort(), ['wallet-assets', 'wallet-pages', 'wallet-shell-10', 'wallet-shell-9']);

  // 활성화(다시 받을 문서가 없는 경우): 실제로 지우고 나머지는 내용까지 그대로 남는다
  const storage = await MemoryCacheStorage.seeded({
    [PRECACHE]: { '/my/tickets?__WB_REVISION__=10': 'precache-list', '/~offline': 'offline' },
    'wallet-pages': { '/_next/static/chunks/legacy-pages.js': 'legacy' },
    'wallet-assets': { '/_next/static/chunks/legacy.js': 'legacy' },
    'wallet-shell-9': { '/_next/static/chunks/main-9.js': 'asset-9' },
    'wallet-shell-1': { '/_next/static/chunks/main-1.js': 'asset-1' },
    'wallet-shell-10': { '/_next/static/chunks/main-10.js': 'asset-10' },
    'wallet-shell': { '/x': 'x' },
    'wallet-shellx': { '/x': 'x' },
    'wallet-pages-old': { '/x': 'x' },
    'Wallet-shell-9': { '/x': 'x' },
    'peaket-other': { '/x': 'x' },
  });
  const net = network({});
  const r = await rotateWalletCaches({ caches: storage, fetch: net.fetch, version: '10' });
  assert.deepEqual([...r.deleted].sort(), ['wallet-assets', 'wallet-pages', 'wallet-shell-1', 'wallet-shell-9']);
  assert.deepEqual(r.warmed, []);
  assert.deepEqual(net.fetched, []);
  assert.deepEqual((await storage.keys()).sort(), [PRECACHE, 'Wallet-shell-9', 'peaket-other', 'wallet-pages-old', 'wallet-shell', 'wallet-shell-10', 'wallet-shellx'].sort());
  assert.deepEqual(contentsOf(storage, PRECACHE), { '/my/tickets?__WB_REVISION__=10': 'precache-list', '/~offline': 'offline' });
  assert.deepEqual(contentsOf(storage, 'wallet-shell-10'), { '/_next/static/chunks/main-10.js': 'asset-10' });
  for (const name of ['wallet-shell', 'wallet-shellx', 'wallet-pages-old', 'Wallet-shell-9', 'peaket-other']) assert.deepEqual(contentsOf(storage, name), { '/x': 'x' }, name);
});

test('O-T46 ③ 옛 판 문서는 네트워크로 다시 받아 넣고 실패·5xx·no-store·10초 넘김은 넣지 않으며 옛 응답을 옮기지 않는다', async () => {
  const storage = await MemoryCacheStorage.seeded({
    [PRECACHE]: { '/~offline': 'offline' },
    'wallet-pages': { '/my/tickets/tkt-e': 'legacy-e' },
    'wallet-assets': { '/_next/static/chunks/legacy.js': 'legacy' },
    'wallet-shell-9': {
      '/my/tickets': 'old-9-list',
      '/my/tickets/tkt-a': 'old-9-a',
      '/my/tickets/tkt-b': 'old-9-b',
      '/my/tickets/tkt-c': 'old-9-c',
      '/my/tickets/tkt-d': 'old-9-d',
      '/my/tickets/tkt-a/transfer': 'old-9-transfer',
      '/_next/static/chunks/main-9.js': 'asset-9',
    },
    'wallet-shell-1': { '/my/tickets/tkt-f': 'old-1-f' },
    'wallet-shell-10': { '/_next/static/chunks/main-10.js': 'asset-10' },
  });
  const ok = (body, headers = {}) => () => new Response(body, { status: 200, headers });
  const net = network({
    '/my/tickets': ok('new-10-list'),
    '/my/tickets/tkt-a': ok('new-10-a'),
    '/my/tickets/tkt-b': () => new Response('down', { status: 503 }),
    '/my/tickets/tkt-c': ok('new-10-c', { 'cache-control': 'private, no-store' }),
    // tkt-d는 연결 실패(대역에 없음 → TypeError)
    '/my/tickets/tkt-e': ok('new-10-e'),
    '/my/tickets/tkt-f': () => new Response('err', { status: 500 }),
  });
  const r = await rotateWalletCaches({ caches: storage, fetch: net.fetch, version: '10' });

  // 다시 받는 것은 옛 판 캐시에 든 월렛 문서 주소(두 꼴)뿐이다: 자산·양도 주소는 받지 않는다
  assert.deepEqual([...net.fetched].sort(), ['/my/tickets', '/my/tickets/tkt-a', '/my/tickets/tkt-b', '/my/tickets/tkt-c', '/my/tickets/tkt-d', '/my/tickets/tkt-e', '/my/tickets/tkt-f']);
  // 새 판 캐시에는 다시 받은 새 응답만 들고, 받지 못한 주소(503·no-store·끊김·500)는 없다. 옛 응답(old-*·legacy-*)은 옮기지 않았다
  assert.deepEqual(contentsOf(storage, 'wallet-shell-10'), {
    '/_next/static/chunks/main-10.js': 'asset-10',
    '/my/tickets': 'new-10-list',
    '/my/tickets/tkt-a': 'new-10-a',
    '/my/tickets/tkt-e': 'new-10-e',
  });
  assert.deepEqual(r.warmed.map((u) => new URL(u).pathname).sort(), ['/my/tickets', '/my/tickets/tkt-a', '/my/tickets/tkt-e']);
  // 다시 받기가 실패한 주소가 있어도 지우기는 한다
  assert.deepEqual([...r.deleted].sort(), ['wallet-assets', 'wallet-pages', 'wallet-shell-1', 'wallet-shell-9']);
  assert.deepEqual((await storage.keys()).sort(), [PRECACHE, 'wallet-shell-10'].sort());
});

test('O-T46 ③ 다시 받기는 다 합쳐 10초 안에 받은 주소만 넣는다: 9,999ms는 넣고 10,000ms는 넣지 않는다', async () => {
  for (const [elapsed, expected] of [
    [9_999, { '/my/tickets/tkt-a': 'new-10-a' }],
    [10_000, {}],
  ]) {
    const start = 1_795_651_215_000;
    let clock = start;
    const storage = await MemoryCacheStorage.seeded({ 'wallet-shell-9': { '/my/tickets/tkt-a': 'old-9-a' } });
    // 응답 본문까지 받는 데 elapsed가 걸린 것으로 시계를 옮긴다
    const net = network({ '/my/tickets/tkt-a': () => new Response('new-10-a', { status: 200 }) }, () => (clock = start + elapsed));
    const r = await rotateWalletCaches({ caches: storage, fetch: net.fetch, version: '10', now: () => clock });
    assert.deepEqual(net.fetched, ['/my/tickets/tkt-a'], `${elapsed}ms`);
    assert.deepEqual(contentsOf(storage, 'wallet-shell-10') ?? {}, expected, `${elapsed}ms`);
    assert.deepEqual(r.deleted, ['wallet-shell-9'], `${elapsed}ms: 시간을 넘겨도 옛 판은 지운다`);
    assert.equal(contentsOf(storage, 'wallet-shell-9'), undefined, `${elapsed}ms`);
  }
});

test('O-T46 ④ 판 값이 꼴을 벗어나면 런타임 캐시 이름을 만들지 않는다(워커가 뜨지 않는다)', () => {
  // §5.18 빌드 칸 꼴 [A-Za-z0-9_-]{1,64}: 64자까지 받고 65자·`/`·빈 값·공백·점·영문 밖 글자는 거절한다
  for (const v of ['9', '10', 'a'.repeat(64), 'Deploy_10-x']) {
    assert.equal(isWalletCacheVersion(v), true, v);
    assert.equal(walletCacheName(v), `wallet-shell-${v}`);
  }
  for (const v of ['', 'a'.repeat(65), 'a/b', ' ', 'v1.2', '9 ', 'é', '10\n']) {
    assert.equal(isWalletCacheVersion(v), false, JSON.stringify(v));
    assert.throws(() => walletCacheName(v), Error, JSON.stringify(v));
  }
});
