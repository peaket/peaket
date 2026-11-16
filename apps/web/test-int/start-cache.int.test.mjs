// 운영 빌드 시작 조립 통합 시험(BAT-170 리뷰 R170-1 재현, 계획 §12 R1-4, docs/frontend.md §5.18 '공유 캐시 처리기 세부').
// 시험 담당(l2w7-BAT170-test)이 구현 전에 썼다(ADR-0270 결정 3). 무거운 게이트 몫이다: 게이트의 운영 빌드
// (tools/web-checks에서 `node seed-css/build.mjs web`이 공유 캐시 주소 없이 만든 apps/web/.next, standalone 포함)가 있어야 하고 Docker(Valkey)를 쓴다.
// 산출물이 없으면 건너뛰지 않고 실패한다(빈 결과 막기).
// 실행: apps/web에서 node --test test-int/start-cache.int.test.mjs (끝나면 컨테이너를 docker rm -f -v로 지운다)
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { prepareStandalone, standaloneAppDir } from '../server/standalone.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = '.next';
const VALKEY_IMAGE = 'valkey/valkey:8.1-alpine';
/** 정본: 모든 키 TTL 상한 30일 [가정] */
const DAYS_30_S = 30 * 24 * 60 * 60;
const NAME = `bat170-start-valkey-${process.pid}`;
const PORT = 39500 + (process.pid % 200) * 3;
const MOCK_PORT = PORT + 2;
/** 공연 상세는 가짜 API 고정 자료의 회차(seed-css/apps.mjs와 같다) */
const DETAIL = '/events/0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';

const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const cli = (...a) => docker(['exec', NAME, 'valkey-cli', ...a]);
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
  docker(['run', '-d', '--name', NAME, '-p', '127.0.0.1::6379', VALKEY_IMAGE]);
  for (let i = 0; i < 50; i++) {
    try {
      if (cli('PING') === 'PONG') break;
    } catch {
      // 아직 뜨는 중
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const mapped = docker(['port', NAME, '6379/tcp']).split('\n')[0];
  const url = `redis://127.0.0.1:${mapped.slice(mapped.lastIndexOf(':') + 1)}`;
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
    assert.ok(ttl > 0 && ttl <= DAYS_30_S, `${k}의 TTL ${ttl}`);
  }
  // 빌드 칸 없는 미리 그린 화면 키는 없다
  for (const k of keys.filter((x) => x.startsWith('web:isr:'))) assert.ok(k.startsWith(`web:isr:${build}:`), `빌드 칸이 다른 키: ${k}`);
});
});

// BAT-170 R170-8(계획 §12 R8-4, docs/frontend.md §5.18 ②′): 진입점 start.mjs를 거치지 않고 standalone server.js를 PEAKET_ENV·주소 없이 바로 띄우면
// 처리기의 둘째 가드(거절하는 저장소)가 캐시 화면 요청을 오류로 끝내고 로그에 까닭을 남긴다. 거절이 Next.js에 삼켜져 200이면 실패다.
// Valkey는 쓰지 않는다. 같은 빌드를 PEAKET_ENV=ci로 띄운 대조군은 200이다.
describe('R170-8 start.mjs를 거치지 않은 standalone server.js', () => {
  const R8_PORT = PORT + 40;
  const R8_MOCK = R8_PORT + 2;
  const procs = [];
  const logs = { bare: '', ci: '' };
  before(async () => {
    assert.ok(existsSync(join(appDir, DIST, 'standalone', 'apps', 'web', 'server.js')), `운영 빌드 standalone 산출물이 없다: apps/web/${DIST}/standalone (tools/web-checks에서 node seed-css/build.mjs web)`);
    prepareStandalone(appDir, DIST);
    const mock = spawn(process.execPath, ['scripts/mock-api.mjs', String(R8_MOCK)], { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(mock);
    const mockOrigin = `http://127.0.0.1:${R8_MOCK}`;
    await waitUp(`${mockOrigin}/v1/home`, 30_000);
    const base = { ...process.env };
    for (const k of ['PEAKET_ENV', 'PEAKET_WEB_CACHE_REDIS_URL', 'PEAKET_WEB_CACHE_BUILD', 'NEXT_PHASE', '__NEXT_DEV_SERVER']) delete base[k];
    Object.assign(base, { HOSTNAME: '127.0.0.1', NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: randomBytes(32).toString('base64'), PEAKET_API_ORIGIN: mockOrigin, PEAKET_CSP_ORIGINS: JSON.stringify({ img: mockOrigin }) });
    const server = standaloneAppDir(appDir, DIST);
    for (const [name, port, extra] of [['bare', R8_PORT, {}], ['ci', R8_PORT + 1, { PEAKET_ENV: 'ci' }]]) {
      const p = spawn(process.execPath, ['server.js'], { cwd: server, env: { ...base, PORT: String(port), ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
      procs.push(p);
      p.stdout.on('data', (d) => (logs[name] += d));
      p.stderr.on('data', (d) => (logs[name] += d));
      // 준비 확인은 캐시를 쓰지 않는 없는 주소(404)로 한다(캐시 화면은 bare에서 5xx라 준비로 볼 수 없다)
      await waitUp(`http://127.0.0.1:${port}/__bat170-ready`, 90_000);
    }
  });
  after(() => {
    for (const p of procs) p.kill();
  });

  test('HOT-390 R170-8 start.mjs를 거치지 않고 PEAKET_ENV 없이 띄운 standalone server.js는 캐시 화면 요청이 5xx이고 로그에 까닭이 남는다', async () => {
    for (const path of ['/', '/search']) {
      const bare = await fetch(`http://127.0.0.1:${R8_PORT}${path}`);
      await bare.arrayBuffer();
      assert.ok(bare.status >= 500, `${path}: PEAKET_ENV 없이 ${bare.status}(거절이 삼켜졌다)`);
      const ci = await fetch(`http://127.0.0.1:${R8_PORT + 1}${path}`);
      await ci.arrayBuffer();
      assert.equal(ci.status, 200, `${path}: 대조군 PEAKET_ENV=ci가 ${ci.status}
${logs.ci}`);
    }
    await new Promise((r) => setTimeout(r, 500));
    assert.match(logs.bare, /공유 캐시를 쓰지 않는다/, `로그에 까닭이 없다
${logs.bare}`);
    assert.doesNotMatch(logs.ci, /공유 캐시를 쓰지 않는다/);
  });
});
