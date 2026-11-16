// 시작 파일(server/start.mjs) 조립 시험: 빌드 설정과 빌드 칸 확인(BAT-170 리뷰 R170-1·R170-2, 계획 §12, docs/frontend.md §5.18 '공유 캐시 처리기 세부').
// 시험 담당(l2w7-BAT170-test)이 구현 전에 썼다(ADR-0270 결정 3). '자주 놓친 결함'의 '시작 파일 조립은 따로 띄워서 본다'.
// 시험이 만든 임시 산출 폴더(PEAKET_NEXT_DIST, apps/web 아래 .next-bat170-*)에 required-server-files.json·BUILD_ID와
// 가짜 standalone server.js를 둔다. 가짜 server.js는 받은 PEAKET_WEB_CACHE_BUILD를 찍고 끝난다(Next.js를 띄우지 않는다, Docker 없음).
// 확인에 걸리면 가짜 server.js까지 가지 않아야 한다. 기존 cache-store.test.mjs의 주소 확인 시험과 겹쳐도 따로 둔다(겹친 가드를 하나씩 빼도 잡히게).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MARK = 'BAT170-STANDALONE ';
const made = [];
let seq = 0;
after(() => {
  for (const d of made) rmSync(join(appDir, d), { recursive: true, force: true });
});

/**
 * 임시 산출 폴더를 만든다. config는 Next.js가 required-server-files.json에 쓰는 꼴(처리기 경로는 산출 폴더 기준 상대 경로)이다.
 * @param {{ config?: object | null, buildId?: string | null }} o  config가 null이면 required-server-files.json을 두지 않는다
 */
function makeDist({ config, buildId = 'bat170Build01' }) {
  const name = `.next-bat170-r${process.pid}-${++seq}`;
  made.push(name);
  const dist = join(appDir, name);
  mkdirSync(join(dist, 'standalone', 'apps', 'web'), { recursive: true });
  if (config !== null) writeFileSync(join(dist, 'required-server-files.json'), JSON.stringify({ version: 1, config: config ?? goodConfig(dist) }));
  if (buildId !== null) writeFileSync(join(dist, 'BUILD_ID'), buildId);
  writeFileSync(
    join(dist, 'standalone', 'apps', 'web', 'server.js'),
    `console.log(${JSON.stringify(MARK)} + JSON.stringify({ build: process.env.PEAKET_WEB_CACHE_BUILD ?? null }));\nprocess.exit(0);\n`,
  );
  return { name, dist };
}

/** 맞는 빌드 설정: 두 처리기 파일(산출 폴더 기준 상대 경로, Next.js 16 build가 쓰는 꼴)과 메모리 캐시 0 */
const goodConfig = (dist, extra = {}) => ({
  cacheHandler: relative(dist, join(appDir, 'server', 'cache-handler.mjs')),
  cacheHandlers: { default: relative(dist, join(appDir, 'server', 'use-cache-handler.mjs')) },
  cacheMaxMemorySize: 0,
  ...extra,
});

let port = 39300 + (process.pid % 200) * 2;
/** server/start.mjs를 그 산출 폴더·환경으로 띄워 끝날 때까지 기다린다 */
async function start(name, env) {
  const clean = { ...process.env };
  for (const k of ['PEAKET_WEB_CACHE_REDIS_URL', 'PEAKET_WEB_CACHE_BUILD', 'PEAKET_ENV']) delete clean[k];
  port += 2;
  const child = spawn(process.execPath, ['server/start.mjs', '--port', String(port), '--inner-port', String(port + 1)], {
    cwd: appDir,
    env: { ...clean, PEAKET_NEXT_DIST: name, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const code = await new Promise((ok) => {
    const t = setTimeout(() => {
      child.kill();
      ok('시간 초과');
    }, 20_000);
    child.on('exit', (c) => {
      clearTimeout(t);
      ok(c);
    });
  });
  const line = out.split('\n').find((l) => l.startsWith(MARK));
  return { code, out, standalone: line ? JSON.parse(line.slice(MARK.length)) : undefined };
}

const ENVS = {
  '운영+주소': { PEAKET_ENV: 'prod', PEAKET_WEB_CACHE_REDIS_URL: 'redis://127.0.0.1:1' },
  local: { PEAKET_ENV: 'local' },
};

/** 확인에 걸려 멈췄는지: 0이 아닌 코드, 가짜 standalone까지 가지 않음, Next.js를 띄운 흔적 없음, 까닭 글 */
function assertStopped(r, why, label) {
  assert.notEqual(r.code, '시간 초과', `${label}: 20초 안에 멈추지 않았다\n${r.out}`);
  assert.notEqual(r.code, 0, `${label}: 0으로 끝났다\n${r.out}`);
  assert.equal(r.standalone, undefined, `${label}: 확인을 지나 server.js를 불렀다\n${r.out}`);
  assert.doesNotMatch(r.out, /Could not find a production build|Ready in|▲ Next\.js/, `${label}: Next.js를 띄우려 했다`);
  assert.match(r.out, why, `${label}: 까닭 글이 없다\n${r.out}`);
}

test('HOT-390 R170-1 server/start.mjs는 빌드 설정에 두 처리기가 없거나 메모리 캐시가 0이 아니면 환경과 관계없이 Next.js를 띄우기 전에 멈춘다', async () => {
  const cases = [
    ['ⓐ cacheHandlers 비어 있음', (dist) => ({ ...goodConfig(dist), cacheHandlers: {} }), /cacheHandlers\.default/],
    ['ⓑ cacheHandler 다른 경로', (dist) => ({ ...goodConfig(dist), cacheHandler: relative(dist, join(appDir, 'server', 'other-handler.mjs')) }), /cacheHandler\b/],
    ['ⓒ cacheMaxMemorySize 50MB', (dist) => ({ ...goodConfig(dist), cacheMaxMemorySize: 52_428_800 }), /cacheMaxMemorySize/],
    ['ⓓ required-server-files.json 없음', null, /required-server-files\.json/],
  ];
  for (const [label, make, why] of cases) {
    for (const [envName, env] of Object.entries(ENVS)) {
      const { name, dist } = makeDist({ config: null });
      if (make) writeFileSync(join(dist, 'required-server-files.json'), JSON.stringify({ version: 1, config: make(dist) }));
      assertStopped(await start(name, env), why, `${label} / ${envName}`);
    }
  }
  // 대조군: 맞는 설정이면 이 확인을 지나 standalone server.js까지 간다
  for (const [envName, env] of Object.entries(ENVS)) {
    const { name } = makeDist({});
    const r = await start(name, env);
    assert.ok(r.standalone, `맞는 설정 / ${envName}: server.js까지 가지 않았다\n${r.out}`);
  }
});

test('HOT-390 R170-2 운영에서 빌드 칸을 읽지 못하면 시작하지 않고, 읽으면 PEAKET_WEB_CACHE_BUILD로 넘긴다', async () => {
  const env = ENVS['운영+주소'];
  // ⓐ BUILD_ID 없음·deploymentId 없음
  {
    const { name } = makeDist({ buildId: null });
    assertStopped(await start(name, env), /BUILD_ID|빌드 칸|PEAKET_WEB_CACHE_BUILD/, 'ⓐ 빌드 칸 없음');
  }
  // ⓑ BUILD_ID가 꼴 밖
  for (const bad of ['bad build', 'a:b', 'x'.repeat(65)]) {
    const { name } = makeDist({ buildId: bad });
    assertStopped(await start(name, env), /BUILD_ID|빌드 칸|PEAKET_WEB_CACHE_BUILD/, `ⓑ BUILD_ID ${JSON.stringify(bad)}`);
  }
  // ⓒ 맞으면 시작 확인을 지나고 그 값을 Next.js 프로세스에 넘긴다(deploymentId가 BUILD_ID보다 앞선다)
  {
    const { name } = makeDist({ buildId: 'bat170Build01' });
    const r = await start(name, env);
    assert.deepEqual(r.standalone, { build: 'bat170Build01' }, r.out);
  }
  {
    const { name, dist } = makeDist({ config: null, buildId: 'bat170Build01' });
    writeFileSync(join(dist, 'required-server-files.json'), JSON.stringify({ version: 1, config: goodConfig(dist, { deploymentId: 'dep_bat170-2' }) }));
    const r = await start(name, env);
    assert.deepEqual(r.standalone, { build: 'dep_bat170-2' }, r.out);
  }
});
