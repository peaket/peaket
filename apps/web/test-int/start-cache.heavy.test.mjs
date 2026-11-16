// 운영 빌드 시작 조립 통합 시험(BAT-170 리뷰 R170-1 재현, 계획 §12 R1-4, docs/frontend.md §5.18 '공유 캐시 처리기 세부').
// 시험 담당(l2w7-BAT170-test)이 구현 전에 썼다(ADR-0270 결정 3). 무거운 게이트 몫이다: 게이트의 운영 빌드
// (tools/web-checks에서 `node seed-css/build.mjs web`이 공유 캐시 주소 없이 만든 apps/web/.next, standalone 포함)가 있어야 하고 Docker(Valkey)를 쓴다.
// 산출물이 없으면 건너뛰지 않고 실패한다(빈 결과 막기).
// 파일 이름 꼴(계획 §14 W7L2-W1, docs/devops.md §3.1): *.heavy.test.mjs는 운영 빌드와 Valkey를 둘 다 써 로컬 무거운 게이트에서만 돈다(start-cache.int.test.mjs에서 나눔).
// BAT-170 게이트 뒤(계획 §17 G-2): 정본 §5.18 '로컬·시험도 노드 하나짜리 클러스터 모드'에 맞춰 Valkey를 노드 하나짜리 클러스터 모드
// (--cluster-enabled yes, 모든 슬롯 배정)로 띄운다(cache-handler.int.test.mjs K-3와 같은 방식, 같은 포트를 열고 127.0.0.1을 알린다). 단언은 그대로다.
// 실행: apps/web에서 node --test test-int/start-cache.heavy.test.mjs (끝나면 컨테이너를 docker rm -f -v로 지운다)
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = '.next';
const VALKEY_IMAGE = 'valkey/valkey:8.1-alpine';
/** 정본: 모든 키 TTL 상한 30일 [가정] */
const DAYS_30_S = 30 * 24 * 60 * 60;
/** 정본(W7L2-S10, docs/frontend.md §5.18 TTL 문장): 값 TTL 상한 기본 1시간 [가정], 태그 시각은 30일 */
const HOUR_S = 3_600;
const NAME = `lane2-bat170t-start-valkey-${process.pid}`;
/** 노드 하나짜리 클러스터의 포트(before에서 정한다). 클러스터 버스(+10000)가 65535를 넘지 않게 20000~39999에서 고른다 */
let VALKEY_PORT = 0;
const PORT = 39500 + (process.pid % 200) * 3;
const MOCK_PORT = PORT + 2;
/** 공연 상세는 가짜 API 고정 자료의 회차(seed-css/apps.mjs와 같다) */
const DETAIL = '/events/0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';

const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const cli = (...a) => docker(['exec', NAME, 'valkey-cli', '-p', String(VALKEY_PORT), ...a]);
/** 이 PC에서 그 포트가 비었는지 */
const isFree = (port) =>
  new Promise((ok) => {
    const srv = createServer();
    srv.once('error', () => ok(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => ok(true)));
  });
const freePort = async () => {
  for (let i = 0; i < 50; i++) {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    if ((await isFree(port)) && (await isFree(port + 10_000))) return port;
  }
  throw new Error('빈 포트를 찾지 못했다');
};
const children = [];
let out = '';

/** 정본의 빌드 칸: 산출물의 deploymentId, 없으면 BUILD_ID */
function expectedBuildTag() {
  const rsf = JSON.parse(readFileSync(join(appDir, DIST, 'required-server-files.json'), 'utf8'));
  return rsf.config?.deploymentId || readFileSync(join(appDir, DIST, 'BUILD_ID'), 'utf8').trim();
}

async function waitUp(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url, { method: 'HEAD' });
      if (r.status < 500) return;
    } catch {
      // 아직 뜨는 중
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${ms}ms 안에 뜨지 않았다: ${url}\n${out}`);
}


describe('R170-1 시작 파일로 띄운 운영 빌드(Valkey)', () => {
before(async () => {
  // 운영 빌드 산출물(standalone 포함)이 없으면 실패한다
  assert.ok(existsSync(join(appDir, DIST, 'standalone', 'apps', 'web', 'server.js')), `운영 빌드 standalone 산출물이 없다: apps/web/${DIST}/standalone (tools/web-checks에서 node seed-css/build.mjs web)`);
  assert.ok(existsSync(join(appDir, DIST, 'required-server-files.json')), '운영 빌드 required-server-files.json이 없다');
  VALKEY_PORT = await freePort();
  docker(['run', '-d', '--name', NAME, '-p', `127.0.0.1:${VALKEY_PORT}:${VALKEY_PORT}`, VALKEY_IMAGE, 'valkey-server', '--port', String(VALKEY_PORT),
    '--cluster-enabled', 'yes', '--cluster-config-file', 'nodes.conf', '--cluster-announce-ip', '127.0.0.1',
    '--appendonly', 'no', '--save', '', '--protected-mode', 'no']);
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
  const url = `redis://127.0.0.1:${VALKEY_PORT}`;
  const mock = spawn(process.execPath, ['scripts/mock-api.mjs', String(MOCK_PORT)], { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(mock);
  const mockOrigin = `http://127.0.0.1:${MOCK_PORT}`;
  await waitUp(`${mockOrigin}/v1/home`, 30_000);
  const env = { ...process.env };
  for (const k of ['PEAKET_WEB_CACHE_BUILD']) delete env[k];
  Object.assign(env, {
    PEAKET_ENV: 'prod',
    PEAKET_WEB_CACHE_REDIS_URL: url,
    PEAKET_NEXT_DIST: DIST,
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PEAKET_API_ORIGIN: mockOrigin,
    PEAKET_CSP_ORIGINS: JSON.stringify({ img: mockOrigin }),
  });
  const web = spawn(process.execPath, ['server/start.mjs', '--port', String(PORT), '--inner-port', String(PORT + 1)], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(web);
  web.stdout.on('data', (d) => (out += d));
  web.stderr.on('data', (d) => (out += d));
  await waitUp(`http://127.0.0.1:${PORT}/`, 90_000);
});

after(() => {
  for (const c of children) c.kill();
  try {
    docker(['rm', '-f', '-v', NAME]);
  } catch {
    // 이미 없다
  }
});

test('HOT-390 R170-1 주소 없이 만든 운영 빌드를 PEAKET_ENV=prod와 Valkey 주소로 띄우면 화면 요청 뒤 공유 캐시 키가 생긴다', async () => {
  for (const path of ['/', DETAIL]) {
    for (let i = 0; i < 2; i++) {
      const r = await fetch(`http://127.0.0.1:${PORT}${path}`);
      assert.ok(r.status < 400, `${path} ${r.status}`);
      await r.arrayBuffer();
    }
  }
  // 쓰기는 응답 뒤에 끝날 수 있다
  await new Promise((r) => setTimeout(r, 1_000));
  const keys = cli('--scan').split('\n').filter(Boolean).sort();
  const build = expectedBuildTag();
  assert.ok(keys.some((k) => k.startsWith(`web:isr:${build}:`)), `web:isr:${build}: 키가 없다: [${keys.join(', ')}]\n${out}`);
  assert.ok(keys.some((k) => k.startsWith('web:data:')), `web:data: 키가 없다: [${keys.join(', ')}]`);
  for (const k of keys) {
    assert.match(k, /^web:(isr|data|\{tag\}):/, `정본 키 꼴 밖: ${k}`);
    const ttl = Number(cli('TTL', k));
    assert.ok(ttl > 0 && ttl <= (k.startsWith('web:{tag}:') ? DAYS_30_S : HOUR_S), `${k}의 TTL ${ttl}`);
  }
  // 빌드 칸 없는 미리 그린 화면 키는 없다
  for (const k of keys.filter((x) => x.startsWith('web:isr:'))) assert.ok(k.startsWith(`web:isr:${build}:`), `빌드 칸이 다른 키: ${k}`);
});
});
