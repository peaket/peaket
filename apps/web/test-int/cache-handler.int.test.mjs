// 공유 캐시 처리기 통합 시험(BAT-170 웨이브 7 T14, docs/frontend.md §5.17 '공유 캐시 처리기 세부', docs/data.md 세션·캐시 클러스터 키 규칙).
// 시험 담당(l2w7-BAT170-test)이 구현 전에 썼다(ADR-0270 결정 3). 실제 Valkey 컨테이너(services/identity-svc/test-int/valkey.ts와 같은 방식:
// 라이브러리 없이 docker 명령, 무작위 포트)에 처리기 인스턴스 둘(다른 파드 둘처럼 모듈을 따로 불러온다)을 붙인다.
// BAT-170 웨이브 끝 리뷰 W7L2-K1(계획 §14 K-3): 공유 캐시는 단일 노드 모드가 없으므로 Valkey를 노드 하나짜리 클러스터 모드
// (--cluster-enabled yes, 모든 슬롯 배정)로 띄운다. 노드가 알리는 주소가 이 PC에서 닿도록 같은 포트를 열고 127.0.0.1을 알린다. 단언은 그대로다.
// 실행: apps/web에서 node --test test-int/cache-handler.int.test.mjs (Docker가 있어야 한다. 끝나면 컨테이너를 docker rm -f -v로 지운다)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { after, before, test } from 'node:test';

const VALKEY_IMAGE = 'valkey/valkey:8.1-alpine';
/** 정본: 모든 키 TTL 상한 30일 [가정] */
const DAYS_30_S = 30 * 24 * 60 * 60;
/** 정본: Redis가 100ms [가정] 안에 답하지 않으면 읽기는 없음. 실제 시계라 여유를 둔다 */
const CANON_TIMEOUT_MS = 100;
const SLACK_MS = 900;

const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const NAME = `lane2-bat170t-valkey-${process.pid}`;
/** 이 시험의 빌드 칸(정본 꼴 [A-Za-z0-9_-] 1~64자) */
const BUILD = 'bat170int';
let cli;

/** 처리기 모듈을 따로 불러온다(모듈 상태·연결을 나눠 다른 파드처럼) */
const load = async (file, tag) => (await import(new URL(`../server/${file}?${tag}`, import.meta.url).href)).default;
let useA;
let useB;
let IsrA;
let IsrB;

/** 이 PC에서 그 포트가 비었는지 */
const isFree = (port) =>
  new Promise((ok) => {
    const srv = createServer();
    srv.once('error', () => ok(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => ok(true)));
  });
/** 빈 포트 하나. 클러스터 버스 포트(+10000)가 65535를 넘지 않게 20000~39999에서 고른다 */
const freePort = async () => {
  for (let i = 0; i < 50; i++) {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    if ((await isFree(port)) && (await isFree(port + 10_000))) return port;
  }
  throw new Error('빈 포트를 찾지 못했다');
};

before(async () => {
  const port = await freePort();
  docker(['run', '-d', '--name', NAME, '-p', `127.0.0.1:${port}:${port}`, VALKEY_IMAGE, 'valkey-server', '--port', String(port),
    '--cluster-enabled', 'yes', '--cluster-config-file', 'nodes.conf', '--cluster-announce-ip', '127.0.0.1',
    '--appendonly', 'no', '--save', '', '--protected-mode', 'no']);
  cli = (...a) => docker(['exec', NAME, 'valkey-cli', '-p', String(port), ...a]);
  for (let i = 0; i < 50; i++) {
    try {
      if (cli('PING') === 'PONG') break;
    } catch {
      // 아직 뜨는 중
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  cli('CLUSTER', 'ADDSLOTSRANGE', '0', '16383');
  for (let i = 0; i < 100 && !/cluster_state:ok/.test(cli('CLUSTER', 'INFO')); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(cli('CLUSTER', 'INFO'), /cluster_state:ok/, '노드 하나짜리 클러스터가 ok가 되지 않았다');
  process.env.PEAKET_WEB_CACHE_REDIS_URL = `redis://127.0.0.1:${port}`;
  // 주소가 있으면 빌드 칸(PEAKET_WEB_CACHE_BUILD)이 있어야 처리기를 불러온다(BAT-170 리뷰 R170-2, 계획 §12). 같은 판의 두 파드
  process.env.PEAKET_WEB_CACHE_BUILD = BUILD;
  useA = await load('use-cache-handler.mjs', 'pod-a');
  useB = await load('use-cache-handler.mjs', 'pod-b');
  IsrA = await load('cache-handler.mjs', 'pod-a');
  IsrB = await load('cache-handler.mjs', 'pod-b');
});

after(() => {
  try {
    docker(['rm', '-f', '-v', NAME]);
  } catch {
    // 이미 없다
  }
});

const isrCtx = () => ({ revalidatedTags: [], _requestHeaders: {} });
const entry = (body, tags, timestamp = Date.now() - 10) => ({ value: new Blob([body]).stream(), tags, stale: 30, timestamp, expire: 300, revalidate: 60 });
const read = async (e) => (e ? await new Response(e.value).text() : undefined);
const page = (html, tag) => ({
  kind: 'APP_PAGE',
  html,
  rscData: Buffer.from(`rsc:${html}`),
  headers: { 'x-next-cache-tags': tag },
  postponed: undefined,
  status: 200,
  segmentData: new Map([['/_index', Buffer.from(`seg:${html}`)]]),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('HOT-390 두 처리기 인스턴스가 같은 Valkey를 나눠 쓴다: A가 쓴 값을 B가 읽고, A의 태그 무효화 뒤 B의 refreshTags·getExpiration이 그 값을 없는 것으로 본다', async () => {
  // 'use cache' 처리기
  const e = entry('hello', ['events']);
  await useA.set('data-key-1', Promise.resolve(e));
  const got = await useB.get('data-key-1', []);
  assert.equal(await read(got), 'hello');
  assert.deepEqual(got.tags, ['events']);
  assert.equal(got.timestamp, e.timestamp);
  assert.equal(got.expire, 300);
  assert.equal(got.revalidate, 60);
  await sleep(5);
  await useA.updateTags(['events']);
  await useB.refreshTags();
  const exp = await useB.getExpiration(['events']);
  assert.ok(exp > e.timestamp, `태그 시각 ${exp}이 값을 만든 시각 ${e.timestamp}보다 늦어야 한다`);
  assert.equal(await useB.get('data-key-1', []), undefined);

  // 미리 그린 화면 처리기
  const a = new IsrA(isrCtx());
  const b = new IsrB(isrCtx());
  await a.set('/events/evt-lumen-1025', page('<p>공연</p>', 'event-isr'), { cacheControl: { revalidate: 60, expire: 300 }, isFallback: false });
  const hit = await b.get('/events/evt-lumen-1025', { kind: 'APP_PAGE', isFallback: false });
  assert.ok(hit, 'B가 A의 값을 읽지 못했다');
  assert.equal(hit.value.kind, 'APP_PAGE');
  assert.equal(hit.value.html, '<p>공연</p>');
  assert.equal(hit.value.status, 200);
  assert.equal(Buffer.from(hit.value.rscData).toString('utf8'), 'rsc:<p>공연</p>');
  assert.equal(Buffer.from(hit.value.segmentData.get('/_index')).toString('utf8'), 'seg:<p>공연</p>');
  await sleep(5);
  await a.revalidateTag('event-isr');
  assert.equal((await b.get('/events/evt-lumen-1025', { kind: 'APP_PAGE', isFallback: false })) ?? null, null);
  // 태그 시각은 두 처리기가 같은 키 꼴(web:{tag}:<태그>, 계획 §11 1)을 쓴다. valkey-cli에는 셸 없이 인자로 넘겨 {·}가 그대로 간다
  assert.ok(Number(cli('GET', 'web:{tag}:event-isr')) > 0);
  assert.ok(Number(cli('GET', 'web:{tag}:events')) > 0);
  assert.equal(cli('EXISTS', 'web:data:tag:events'), '0', '옛 키 꼴(web:data:tag:)로 썼다');
});

test('HOT-390 쓴 키를 모두 TTL과 함께 확인한다(TTL -1인 키 0)', async () => {
  await useA.set('data-key-2', Promise.resolve(entry('ttl', ['ttl-tag'])));
  await new IsrA(isrCtx()).set('/search', page('<p>검색</p>', 'search-isr'), { cacheControl: { revalidate: 60, expire: 120 }, isFallback: false });
  const keys = cli('--scan').split('\n').filter(Boolean).sort();
  assert.ok(keys.includes('web:data:data-key-2'), keys.join(', '));
  assert.ok(keys.includes(`web:isr:${BUILD}:/search`), keys.join(', '));
  for (const k of keys) {
    assert.match(k, /^web:(isr|data|\{tag\}):/, `정본 키 꼴 밖: ${k}`);
    const ttl = Number(cli('TTL', k));
    assert.ok(ttl > 0 && ttl <= DAYS_30_S, `${k}의 TTL ${ttl}`);
  }
  // 값 TTL은 만료(expire)와 30일 가운데 짧은 쪽
  assert.ok(Number(cli('TTL', `web:isr:${BUILD}:/search`)) <= 120);
  assert.ok(Number(cli('TTL', 'web:data:data-key-2')) <= 300);
});

// BAT-170 리뷰 R170-2(계획 §12 R2-4): 미리 그린 화면 키 web:isr:<빌드 칸>:<캐시 키>. 시험 담당(l2w7-BAT170-test)이 구현 전에 더했다
test('HOT-390 R170-2 실제 Valkey에서 빌드가 다른 두 처리기는 같은 경로의 미리 그린 화면을 나눠 쓰지 않는다', async () => {
  process.env.PEAKET_WEB_CACHE_BUILD = 'a1b2c3d4';
  const IsrOld = await load('cache-handler.mjs', 'build-a');
  process.env.PEAKET_WEB_CACHE_BUILD = 'a1b2c3d5';
  const IsrNew = await load('cache-handler.mjs', 'build-b');
  process.env.PEAKET_WEB_CACHE_BUILD = BUILD;
  const oldPod = new IsrOld(isrCtx());
  const newPod = new IsrNew(isrCtx());
  await oldPod.set('/events/evt-bat170', page('<p>옛 판</p>', 'event-bat170'), { cacheControl: { revalidate: 60, expire: 300 }, isFallback: false });
  assert.equal((await oldPod.get('/events/evt-bat170', { kind: 'APP_PAGE', isFallback: false }))?.value?.html, '<p>옛 판</p>');
  assert.equal((await newPod.get('/events/evt-bat170', { kind: 'APP_PAGE', isFallback: false })) ?? null, null, '새 판이 옛 판의 화면을 읽었다');
  // 키 꼴은 GET으로 확인한다(빌드 칸이 키에 그대로 있다)
  assert.notEqual(cli('GET', 'web:isr:a1b2c3d4:/events/evt-bat170'), '', '옛 판 키가 없다');
  assert.equal(cli('EXISTS', 'web:isr:a1b2c3d5:/events/evt-bat170'), '0');
  assert.equal(cli('EXISTS', 'web:isr:/events/evt-bat170'), '0', '빌드 칸 없는 키로 썼다');
});

test('HOT-390 Valkey를 멈추면 get은 없음을 돌려주고 set은 던지지 않는다', async () => {
  await useA.set('data-key-3', Promise.resolve(entry('before', ['pause-tag'])));
  const isr = new IsrA(isrCtx());
  await isr.set('/help', page('<p>도움말</p>', 'help-isr'), { cacheControl: { revalidate: 60, expire: 300 }, isFallback: false });

  // 답하지 않는 Redis(멈춤)
  docker(['pause', NAME]);
  try {
    let t = Date.now();
    assert.equal(await useA.get('data-key-3', []), undefined);
    assert.ok(Date.now() - t < CANON_TIMEOUT_MS + SLACK_MS, `읽기가 ${Date.now() - t}ms 걸렸다`);
    t = Date.now();
    await useA.set('data-key-4', Promise.resolve(entry('during', ['pause-tag'])));
    assert.ok(Date.now() - t < CANON_TIMEOUT_MS + SLACK_MS, `쓰기가 ${Date.now() - t}ms 걸렸다`);
    assert.equal((await isr.get('/help', { kind: 'APP_PAGE', isFallback: false })) ?? null, null);
    await isr.set('/help2', page('<p>x</p>', 'help-isr'), { cacheControl: { revalidate: 60, expire: 300 }, isFallback: false });
  } finally {
    docker(['unpause', NAME]);
  }

  // 끊긴 Redis(컨테이너 없음)
  docker(['rm', '-f', '-v', NAME]);
  assert.equal(await useB.get('data-key-3', []), undefined);
  await useB.set('data-key-5', Promise.resolve(entry('gone', ['pause-tag'])));
  await useB.updateTags(['pause-tag']);
  assert.equal((await new IsrB(isrCtx()).get('/help', { kind: 'APP_PAGE', isFallback: false })) ?? null, null);
});
