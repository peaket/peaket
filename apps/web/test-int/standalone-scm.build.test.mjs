// 운영 빌드 standalone 산출물의 소스 관리 메타데이터 검사(BAT-170 계획 §13 V13-6, docs/security/asvs/frontend.md 13.4.1, docs/frontend.md §5.18 '앱 서버 실행').
// 시험 담당(l2w7-BAT170-test)이 썼다. 무거운 게이트 몫이다: 게이트의 운영 빌드(tools/web-checks에서 `node seed-css/build.mjs web`이 만든
// apps/web/.next/standalone)가 있어야 한다. Docker는 쓰지 않는다. start.mjs가 하는 복사(prepareStandalone: .next/static·public)를 한 뒤 훑는다.
// 산출물이 없으면 건너뛰지 않고 실패하고, 훑은 파일이 0개여도 실패한다(빈 결과 막기).
// 파일 이름 꼴(계획 §14 W7L2-W1, docs/devops.md §3.1): *.build.test.mjs는 운영 빌드만 써 ci-web reflow 잡이 빌드 뒤 돈다.
// 실행: apps/web에서 node --test test-int/standalone-scm.build.test.mjs
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
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
