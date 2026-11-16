// 소비자 웹 컨테이너 시험의 파일 이름 나눔과 CI 잡 대조(BAT-170 웨이브 끝 리뷰 W7L2-W1·W5 재현, 계획 §14 W1-2, docs/devops.md §3.1 ci-node.yml 행).
// 시험 담당(l2w7-BAT170-test)이 구현 전에 썼다(ADR-0270 결정 3). 꼴:
// - apps/web/test-int/*.int.test.mjs: Valkey만 쓴다(운영 빌드를 읽지 않는다). ci-node가 돈다(JUnit 보고서를 남긴다)
// - *.build.test.mjs: 운영 빌드만 쓴다(Docker를 부르지 않는다). ci-web reflow 잡이 빌드 뒤 돈다
// - *.heavy.test.mjs: 둘 다 쓴다. 로컬 무거운 게이트에서만 돈다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dir = join(root, 'apps/web/test-int');
const files = readdirSync(dir).filter((f) => f.endsWith('.mjs'));
const read = (p) => readFileSync(join(root, p), 'utf8');
/** 운영 빌드 산출물을 읽는 흔적(산출 폴더 이름·standalone·BUILD_ID) */
const READS_BUILD = /['"`]\.next['"`/]|standalone|BUILD_ID/;
/** docker 명령을 부르는 흔적 */
const CALLS_DOCKER = /['"`]docker['"`]/;

/** 워크플로 글에서 그 줄을 품은 단계(`- ` 항목) 글 */
function stepOf(yml, needle) {
  const lines = yml.split(/\r?\n/);
  const at = lines.findIndex((l) => l.includes(needle));
  if (at < 0) return null;
  let start = at;
  while (start > 0 && !/^\s*- /.test(lines[start])) start -= 1;
  const indent = lines[start].search(/\S/);
  let end = at + 1;
  while (end < lines.length && !(lines[end].trim() !== '' && lines[end].search(/\S/) <= indent)) end += 1;
  return lines.slice(start, end).join('\n');
}

/** 워크플로 글에서 잡 하나(두 칸 들여 쓴 `이름:`부터 다음 잡까지) */
function jobOf(yml, name) {
  const lines = yml.split(/\r?\n/);
  const at = lines.findIndex((l) => l === `  ${name}:`);
  if (at < 0) return null;
  let end = at + 1;
  while (end < lines.length && !/^ {2}[A-Za-z][\w-]*:\s*$/.test(lines[end])) end += 1;
  return lines.slice(at, end).join('\n');
}

test('W7L2-W1 웹 컨테이너 시험의 파일 이름이 필요한 것과 맞고 CI 잡이 맞는 묶음을 돈다', () => {
  // 모든 파일이 세 꼴 가운데 하나다(빈 결과 막기: 세 꼴이 모두 있다)
  const kinds = { int: [], build: [], heavy: [] };
  for (const f of files) {
    const m = /\.(int|build|heavy)\.test\.mjs$/.exec(f);
    assert.ok(m, `세 꼴 밖의 파일: ${f}`);
    kinds[m[1]].push(f);
  }
  for (const k of ['int', 'build', 'heavy']) assert.ok(kinds[k].length > 0, `*.${k}.test.mjs가 없다`);
  // *.int.test.mjs는 운영 빌드를 읽지 않는다. 읽는 파일은 build·heavy뿐이다
  for (const f of kinds.int) assert.doesNotMatch(read(`apps/web/test-int/${f}`), READS_BUILD, `${f}가 운영 빌드를 읽는다`);
  for (const f of files.filter((x) => READS_BUILD.test(read(`apps/web/test-int/${x}`)))) assert.match(f, /\.(build|heavy)\.test\.mjs$/, f);
  // *.build.test.mjs는 docker를 부르지 않는다
  for (const f of kinds.build) assert.doesNotMatch(read(`apps/web/test-int/${f}`), CALLS_DOCKER, `${f}가 docker를 부른다`);

  // apps/web/package.json의 세 스크립트가 세 꼴을 고른다
  const scripts = JSON.parse(read('apps/web/package.json')).scripts ?? {};
  for (const [name, kind] of [
    ['test:integration', 'int'],
    ['test:build', 'build'],
    ['test:heavy', 'heavy'],
  ]) {
    const s = scripts[name] ?? '';
    assert.match(s, new RegExp(`test-int/\\*\\.${kind}\\.test\\.mjs`), `${name}: ${s}`);
    for (const other of ['int', 'build', 'heavy'].filter((x) => x !== kind)) assert.doesNotMatch(s, new RegExp(`\\.${other}\\.test\\.mjs`), `${name}가 ${other}도 고른다`);
  }

  // ci-node.yml의 웹 통합 단계는 JUnit 보고서를 남긴다(W7L2-W5)
  const node = read('.github/workflows/ci-node.yml');
  const webInt = stepOf(node, 'pnpm --filter @peaket/web test:integration');
  assert.ok(webInt, 'ci-node.yml에 웹 통합 단계가 없다');
  assert.match(webInt, /NODE_OPTIONS:.*--test-reporter=junit/, `웹 통합 단계에 JUnit 보고서 환경 값이 없다\n${webInt}`);
  assert.doesNotMatch(node, /@peaket\/web test:(build|heavy)/, 'ci-node가 운영 빌드가 필요한 묶음을 돈다');

  // ci-web.yml reflow 잡은 빌드 뒤 test:build를 돈다
  const reflow = jobOf(read('.github/workflows/ci-web.yml'), 'reflow');
  assert.ok(reflow, 'ci-web.yml에 reflow 잡이 없다');
  const buildAt = reflow.indexOf('node seed-css/build.mjs');
  const testBuildAt = reflow.indexOf('pnpm --filter @peaket/web test:build');
  assert.ok(buildAt >= 0, 'reflow 잡에 운영 빌드 단계가 없다');
  assert.ok(testBuildAt > buildAt, 'reflow 잡에 빌드 뒤 test:build 단계가 없다');
  assert.doesNotMatch(reflow, /test:heavy/, 'CI가 무거운 게이트 묶음을 돈다');
});
