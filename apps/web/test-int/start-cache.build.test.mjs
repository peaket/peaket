// start.mjs를 거치지 않은 standalone server.js의 공유 캐시 둘째 가드 시험(BAT-170 리뷰 R170-8, 계획 §12 R8-4, docs/frontend.md §5.18 ②′).
// 시험 담당(l2w7-BAT170-test)이 썼다(ADR-0270 결정 3). 게이트의 운영 빌드(apps/web/.next, standalone 포함)가 있어야 한다. Valkey·컨테이너는 쓰지 않는다.
// 산출물이 없으면 건너뛰지 않고 실패한다(빈 결과 막기).
// 파일 이름 꼴(계획 §14 W7L2-W1, docs/devops.md §3.1): *.build.test.mjs는 운영 빌드만 써 ci-web reflow 잡이 빌드 뒤 돈다(start-cache.int.test.mjs에서 나눔).
// 실행: apps/web에서 node --test test-int/start-cache.build.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { prepareStandalone, standaloneAppDir } from '../server/standalone.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = '.next';
const PORT = 39500 + (process.pid % 200) * 3;
let out = '';

/**
 * 서버가 뜰 때까지 기다린다. anyStatus면 상태와 관계없이 HTTP 답이 오면(연결 거부가 아니면) 뜬 것으로 본다.
 * 시험 이의 O-2(정본 docs/frontend.md §5.18 ②′): Next.js 16.4는 없는 주소의 404 화면도 미리 그린 화면 캐시에서 읽어, 거절하는 저장소로 뜬
 * bare 서버에서는 그 주소도 5xx다. 그래서 bare 쪽은 답이 오는지만 본다. 대조군 ci 쪽은 500 미만이어야 뜬 것으로 본다.
 */
async function waitUp(url, ms, { anyStatus = false } = {}) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url, { method: 'HEAD' });
      if (anyStatus || r.status < 500) return;
    } catch {
      // 아직 뜨는 중
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${ms}ms 안에 뜨지 않았다: ${url}
${out}`);
}

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
      // 준비 확인은 없는 주소(404)로 한다. bare는 그 주소도 미리 그린 화면 캐시를 읽어 5xx라 답이 오는지만 본다(시험 이의 O-2)
      await waitUp(`http://127.0.0.1:${port}/__bat170-ready`, 90_000, { anyStatus: name === 'bare' });
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
