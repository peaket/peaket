// 운영 빌드 standalone 산출물의 소스 관리 메타데이터 검사(BAT-170 계획 §13 V13-6, docs/security/asvs/frontend.md 13.4.1, docs/frontend.md §5.18 '앱 서버 실행').
// 시험 담당(l2w7-BAT170-test)이 썼다. 무거운 게이트 몫이다: 게이트의 운영 빌드(tools/web-checks에서 `node seed-css/build.mjs web`이 만든
// apps/web/.next/standalone)가 있어야 한다. Docker는 쓰지 않는다. start.mjs가 하는 복사(prepareStandalone: .next/static·public)를 한 뒤 훑는다.
// 산출물이 없으면 건너뛰지 않고 실패하고, 훑은 파일이 0개여도 실패한다(빈 결과 막기).
// 파일 이름 꼴(계획 §14 W7L2-W1, docs/devops.md §3.1): *.build.test.mjs는 운영 빌드만 써 ci-web reflow 잡이 빌드 뒤 돈다.
// 실행: apps/web에서 node --test test-int/standalone-scm.build.test.mjs
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { prepareStandalone } from '../server/standalone.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = '.next';
/** 소스 관리 메타데이터 폴더(ASVS 13.4.1: .git·.svn 같은 것) */
const SCM = new Set(['.git', '.svn', '.hg']);

/** 폴더를 끝까지 훑는다(링크는 따라가지 않는다) */
function walk(dir, out = { files: 0, scm: [] }) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (SCM.has(name)) out.scm.push(p);
    if (st.isDirectory()) walk(p, out);
    else out.files += 1;
  }
  return out;
}

test('[ASVS v5.0.0-13.4.1] 운영 빌드의 standalone 산출물 어디에도 .git·.svn·.hg 폴더가 없다', () => {
  const standalone = join(appDir, DIST, 'standalone');
  assert.ok(existsSync(join(standalone, 'apps', 'web', 'server.js')), `운영 빌드 standalone 산출물이 없다: apps/web/${DIST}/standalone (tools/web-checks에서 node seed-css/build.mjs web)`);
  assert.equal(prepareStandalone(appDir, DIST), true);
  const r = walk(standalone);
  assert.ok(r.files > 0, '훑은 파일이 없다(빈 결과)');
  assert.deepEqual(r.scm.map((p) => relative(standalone, p)), [], '소스 관리 메타데이터가 산출물에 있다');
});

// BAT-170 첫 JS 예산(계획 §15 J-1, docs/frontend.md §5.18 '앱 서버 실행'): 공유 캐시 처리기가 쓰는 redis와 그 하위 패키지는 serverExternalPackages로
// 서버 묶음 밖에 두고 standalone node_modules에서 불러온다. 시험 담당(l2w7-BAT170-test)이 구현 전에 썼다(ADR-0270 결정 3).
/**
 * @redis/client 소스 표식: 그 패키지만 쓰는 오류 글(@redis/client 6.3.0 dist/lib/errors.js의 RootNodesUnavailableError·
 * SentinelScanIterationInterruptedError·ClientClosedError). 클래스 이름(RedisClusterSlots 등)은 묶을 때 줄여 쓰여 표식이 되지 못한다
 */
const REDIS_CLIENT_MARKER = /All the root nodes are unavailable|Scan iteration was interrupted by a Sentinel master change|The client is closed|RedisClusterSlots/;

/** 폴더 아래 .js 파일 경로 */
function jsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) jsFiles(p, out);
    else if (/\.(c|m)?js$/.test(name)) out.push(p);
  }
  return out;
}

test('HOT-390 첫 JS 예산: redis는 서버 묶음 밖에 두고 standalone node_modules에서 불러온다', () => {
  const app = join(appDir, DIST, 'standalone', 'apps', 'web');
  assert.ok(existsSync(join(app, 'server.js')), `운영 빌드 standalone 산출물이 없다: apps/web/${DIST}/standalone (tools/web-checks에서 node seed-css/build.mjs web)`);
  // standalone 앱 폴더 기준으로 redis·@redis/client를 풀 수 있고 @redis/client에 createCluster가 있다
  const fromApp = createRequire(join(app, 'server.js'));
  const redisPath = fromApp.resolve('redis');
  assert.ok(redisPath.startsWith(join(appDir, DIST, 'standalone')) || /[\\/]standalone[\\/]/.test(redisPath), `redis를 standalone 밖에서 풀었다: ${redisPath}`);
  const clientPath = createRequire(redisPath).resolve('@redis/client');
  const client = createRequire(redisPath)('@redis/client');
  assert.equal(typeof client.createCluster, 'function', `@redis/client(${clientPath})에 createCluster가 없다`);
  // 서버 묶음 파일 어디에도 @redis/client 소스가 들어 있지 않다
  const files = jsFiles(join(app, DIST, 'server'));
  assert.ok(files.length > 0, '훑은 서버 묶음 파일이 없다(빈 결과)');
  const bundled = files.filter((f) => REDIS_CLIENT_MARKER.test(readFileSync(f, 'utf8'))).map((f) => relative(app, f));
  assert.deepEqual(bundled, [], '@redis/client가 서버 묶음에 들어 있다');
});
