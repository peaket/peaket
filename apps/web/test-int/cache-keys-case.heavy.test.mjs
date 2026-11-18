// 공유 캐시 정규 주소 시험(BAT-170 보안 다시 보기 W7L2-S10 재현, 계획 §16 S10-1, docs/frontend.md §5.18 '정규 주소 하나로 모은다').
// cache-keys.heavy.test.mjs(S1-5)와 같은 틀이다.
// 시험 담당(l2w7-BAT170-test)이 구현 전에 썼다(ADR-0270 결정 3). 무거운 게이트 몫이다: 게이트의 운영 빌드(apps/web/.next, standalone 포함)와
// Valkey 클러스터(주 노드 셋·복제 셋)가 있어야 한다. 파일 이름 꼴(docs/devops.md §3.1): *.heavy.test.mjs는 로컬 무거운 게이트에서만 돈다.
// 클러스터는 컨테이너 하나 안에 노드 여섯을 서로 다른 포트로 띄우고 127.0.0.1을 알리게 해, 이 PC의 앱 서버가 노드가 알리는 주소로 바로 붙는다
// (앱 서버에는 주소 바꾸기 표가 없다). 컨테이너 이름 머리는 lane2-bat170t-이고 끝나면 docker rm -f -v로 지운다. 산출물이 없으면 실패한다.
// 실행: apps/web에서 node --test test-int/cache-keys-case.heavy.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = '.next';
const VALKEY_IMAGE = 'valkey/valkey:8.1-alpine';
const NAME = `lane2-bat170t-case-${process.pid}`;
/** 노드 포트(클러스터 버스는 +10000이라 65535를 넘지 않게 고른다) */
const BASE = 26_000 + (process.pid % 400) * 10;
const PORTS = [1, 2, 3, 4, 5, 6].map((i) => BASE + i);
const WEB_PORT = 39_000 + (process.pid % 100) * 3;
const MOCK_PORT = WEB_PORT + 2;
/** 가짜 API 고정 자료에 있는 회차 둘: 변형을 보낼 회차와 대조군 회차 */
const ID = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
const OTHER = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e02';

/** 대소문자만 다른 변형 n개(서로 다르고 모두 대문자 하나 이상) */
function caseVariants(id, n) {
  const letters = [...id].map((c, i) => (/[a-f]/.test(c) ? i : -1)).filter((i) => i >= 0);
  const out = new Set();
  for (let mask = 1; out.size < n && mask < 2 ** letters.length; mask += 1) {
    const chars = [...id];
    letters.forEach((pos, bit) => {
      if (mask & (1 << bit)) chars[pos] = chars[pos].toUpperCase();
    });
    out.add(chars.join(''));
  }
  return [...out];
}

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim();
const tryDocker = (...args) => {
  try {
    return docker(...args);
  } catch {
    return null;
  }
};
const cli = (port, ...args) => docker('exec', NAME, 'valkey-cli', '-p', String(port), ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
let out = '';

async function waitUp(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url, { method: 'HEAD' });
      if (r.status < 500) return;
    } catch {
      // 아직 뜨는 중
    }
    await sleep(300);
  }
  throw new Error(`${ms}ms 안에 뜨지 않았다: ${url}\n${out}`);
}

/** 주 노드 셋의 web:* 키 수(복제는 같은 키를 갖고 있어 세지 않는다) */
function webKeyCount() {
  let n = 0;
  let masters = 0;
  for (const p of PORTS) {
    if (!/role:master/.test(cli(p, 'INFO', 'replication'))) continue;
    masters += 1;
    n += cli(p, '--scan', '--pattern', 'web:*').split('\n').filter(Boolean).length;
  }
  assert.equal(masters, 3, `주 노드 ${masters}개`);
  return n;
}

before(async () => {
  assert.ok(existsSync(join(appDir, DIST, 'standalone', 'apps', 'web', 'server.js')), `운영 빌드 standalone 산출물이 없다: apps/web/${DIST}/standalone (tools/web-checks에서 node seed-css/build.mjs web)`);
  tryDocker('rm', '-f', '-v', NAME);
  const start = PORTS.map(
    (p) => `valkey-server --port ${p} --cluster-enabled yes --cluster-config-file nodes-${p}.conf --cluster-node-timeout 5000 --cluster-announce-ip 127.0.0.1 --appendonly no --save '' --protected-mode no --daemonize yes`,
  );
  docker('run', '-d', '--name', NAME, ...PORTS.flatMap((p) => ['-p', `127.0.0.1:${p}:${p}`]), VALKEY_IMAGE, 'sh', '-c', `${start.join(' && ')} && sleep 2147483647`);
  for (let i = 0; i < 50 && !PORTS.every((p) => tryDocker('exec', NAME, 'valkey-cli', '-p', String(p), 'PING') === 'PONG'); i += 1) await sleep(200);
  docker('exec', NAME, 'valkey-cli', '--cluster', 'create', ...PORTS.map((p) => `127.0.0.1:${p}`), '--cluster-replicas', '1', '--cluster-yes');
  let ok = false;
  for (let i = 0; i < 100 && !ok; i += 1) {
    ok = PORTS.every((p) => /cluster_state:ok/.test(tryDocker('exec', NAME, 'valkey-cli', '-p', String(p), 'CLUSTER', 'INFO') ?? ''));
    if (!ok) await sleep(300);
  }
  assert.ok(ok, '클러스터가 ok가 되지 않았다');

  const mock = spawn(process.execPath, ['scripts/mock-api.mjs', String(MOCK_PORT)], { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(mock);
  const mockOrigin = `http://127.0.0.1:${MOCK_PORT}`;
  await waitUp(`${mockOrigin}/v1/home`, 30_000);
  const env = { ...process.env };
  delete env.PEAKET_WEB_CACHE_BUILD;
  Object.assign(env, {
    PEAKET_ENV: 'prod',
    PEAKET_WEB_CACHE_REDIS_URL: PORTS.slice(0, 3).map((p) => `redis://127.0.0.1:${p}`).join(','),
    PEAKET_NEXT_DIST: DIST,
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PEAKET_API_ORIGIN: mockOrigin,
    PEAKET_CSP_ORIGINS: JSON.stringify({ img: mockOrigin }),
  });
  const web = spawn(process.execPath, ['server/start.mjs', '--port', String(WEB_PORT), '--inner-port', String(WEB_PORT + 1)], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(web);
  web.stdout.on('data', (d) => (out += d));
  web.stderr.on('data', (d) => (out += d));
  await waitUp(`http://127.0.0.1:${WEB_PORT}/__bat170-ready`, 90_000);
});

after(() => {
  for (const c of children) c.kill();
  tryDocker('rm', '-f', '-v', NAME);
});

test('HOT-390 W7L2-S10 회차 UUID의 대소문자 변형은 소문자 주소로 308이고 공유 캐시 키 수가 늘지 않는다', async () => {
  // 소문자 주소를 한 번 불러 공유 키를 만든다
  for (const path of [`/events/${ID}`, `/en/events/${ID}`, `/events/${ID}/shuffle-proof`]) {
    const r = await fetch(`http://127.0.0.1:${WEB_PORT}${path}`);
    await r.arrayBuffer();
    assert.equal(r.status, 200, `${path} ${r.status}`);
  }
  await sleep(1_000);
  const before = webKeyCount();
  // 같은 ID의 대소문자 변형 50개를 세 경로에 나눠 보낸다(따라가지 않는다)
  const variants = caseVariants(ID, 50);
  assert.equal(variants.length, 50);
  const shapes = [(v) => `/events/${v}`, (v) => `/en/events/${v}`, (v) => `/events/${v}/shuffle-proof`];
  for (const [i, v] of variants.entries()) {
    const path = shapes[i % shapes.length](v);
    const r = await fetch(`http://127.0.0.1:${WEB_PORT}${path}?v=${i}`, { redirect: 'manual' });
    await r.arrayBuffer();
    assert.equal(r.status, 308, `${path} ${r.status}`);
    const to = new URL(r.headers.get('location') ?? '', `http://127.0.0.1:${WEB_PORT}`);
    assert.equal(`${to.pathname}${to.search}`, `${shapes[i % shapes.length](ID)}?v=${i}`, `${path}: Location`);
  }
  await sleep(1_000);
  assert.equal(webKeyCount(), before, '대소문자 변형이 공유 캐시 키를 만들었다');
  // 대조군: 다른 회차 하나를 소문자로 부르면 키가 는다
  const ok = await fetch(`http://127.0.0.1:${WEB_PORT}/events/${OTHER}`);
  await ok.arrayBuffer();
  assert.equal(ok.status, 200);
  await sleep(1_000);
  assert.ok(webKeyCount() > before, `다른 회차를 불러도 키가 늘지 않았다(대조군이 뜻이 없다)
${out}`);
});
