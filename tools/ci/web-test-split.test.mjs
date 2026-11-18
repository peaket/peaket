// 소비자 웹 컨테이너 시험의 파일 이름 나눔과 CI 잡 대조(BAT-170 웨이브 끝 리뷰 W7L2-W1·W5 재현, 계획 §14 W1-2, docs/devops.md §3.1 ci-node.yml 행).
// 시험 담당(l2w7-BAT170-test)이 구현 전에 썼다(ADR-0270 결정 3). 꼴:
// - apps/web/test-int/*.int.test.mjs: Valkey만 쓴다(운영 빌드를 읽지 않는다). ci-node가 돈다(JUnit 보고서를 남긴다)
// - *.build.test.mjs: 운영 빌드만 쓴다(Docker를 부르지 않는다). ci-web budgets 잡이 운영 빌드 뒤 돈다
//   (계획 §17 G-6). web / reflow 잡은 BAT-171에서 처음 켰고(소유자 결정 2026-11-16 (나)) test:build는 돌지 않는다(아래 HOT-381 시험)
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
  return stepAt(lines, at);
}

/** 줄 at을 품은 단계(`- ` 항목) 글 */
function stepAt(lines, at) {
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

  // ci-web.yml budgets 잡은 운영 빌드(node seed-css/build.mjs, PEAKET_BUILDS: prod) 뒤 test:build를 돈다(계획 §17 G-6)
  const web = read('.github/workflows/ci-web.yml');
  const budgets = jobOf(web, 'budgets');
  assert.ok(budgets, 'ci-web.yml에 budgets 잡이 없다');
  const lines = budgets.split(/\r?\n/);
  const prodBuild = lines.findIndex((l, i) => l.includes('node seed-css/build.mjs') && /PEAKET_BUILDS:\s*prod\b/.test(stepAt(lines, i)));
  assert.ok(prodBuild >= 0, 'budgets 잡에 운영 빌드 단계(node seed-css/build.mjs, PEAKET_BUILDS: prod)가 없다');
  const testBuild = lines.findIndex((l) => l.includes('pnpm --filter @peaket/web test:build'));
  assert.ok(testBuild > prodBuild, 'budgets 잡에 운영 빌드 뒤 test:build 단계가 없다');
  assert.doesNotMatch(budgets, /test:heavy/, 'CI가 무거운 게이트 묶음을 돈다');
});

// BAT-171 시험(계획 §3 T3): 시험 담당(l2-bat171-test)이 구현(9e92ae9d) 뒤에 썼다(ADR-0281 결정 3). 위 W7L2-W1의 'reflow 잡 없음' 단언을 뒤집었다.
// 기준: docs/devops.md §3.1 ci-web.yml 행, docs/frontend.md §5.17 '화면 매트릭스와 FE-T31·FE-T18 자동 몫의 세부'(PR마다 운영 빌드로 돈다),
// BUILD_ORDER HOT-381, 소유자 결정 2026-11-16 (나)(재배치 단계에 continue-on-error를 두지 않는다)
test('HOT-381 ci-web.yml에 reflow 잡이 있고 운영 빌드 뒤 pnpm run reflow를 continue-on-error 없이 돌리며 보고서를 올린다', () => {
  const web = read('.github/workflows/ci-web.yml');
  // 주석 줄은 뺀다(잡 사이의 설명 글이 단언에 걸리지 않게)
  const code = (job) => (job ?? '').split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
  const reflow = code(jobOf(web, 'reflow'));
  assert.ok(reflow, 'ci-web.yml에 reflow 잡이 없다');
  const lines = reflow.split('\n');
  const prodBuild = lines.findIndex((l, i) => l.includes('node seed-css/build.mjs') && /PEAKET_BUILDS:\s*prod\b/.test(stepAt(lines, i)));
  assert.ok(prodBuild >= 0, 'reflow 잡에 운영 빌드 단계(node seed-css/build.mjs, PEAKET_BUILDS: prod)가 없다');
  // 재배치 시험 묶음(playwright.reflow.config.mjs)을 실제로 부른다: tools/web-checks에서 pnpm run reflow
  const run = lines.findIndex((l) => /^\s*(?:- )?run:\s*pnpm run reflow\s*$/.test(l));
  assert.ok(run >= 0, 'reflow 잡에 pnpm run reflow 단계가 없다');
  assert.ok(run > prodBuild, 'reflow 잡이 운영 빌드보다 먼저 pnpm run reflow를 돈다');
  const runStep = stepAt(lines, run);
  assert.match(runStep, /working-directory:\s*tools\/web-checks\s*$/m, `pnpm run reflow 단계가 tools/web-checks에서 돌지 않는다\n${runStep}`);
  assert.doesNotMatch(runStep, /^\s*(?:- )?if:/m, `pnpm run reflow 단계에 조건이 붙어 건너뛸 수 있다\n${runStep}`);
  // 실패를 잡 실패로 낸다: 잡에도 단계에도 continue-on-error가 없다(false여도 두지 않는다)
  assert.doesNotMatch(reflow, /continue-on-error/, `reflow 잡에 continue-on-error가 있다\n${reflow}`);
  // 실패한 실행에서도 보고서를 올린다: 시험 단계 뒤 if: always()인 upload-artifact 단계가 tools/web-checks/reports/를 올린다
  const upload = lines.findIndex((l, i) => i > run && l.includes('actions/upload-artifact@'));
  assert.ok(upload > run, 'reflow 잡에 pnpm run reflow 뒤 보고서 올리기 단계가 없다');
  const uploadStep = stepAt(lines, upload);
  assert.match(uploadStep, /^\s*(?:- )?if:\s*always\(\)\s*$/m, `보고서 올리기가 실패한 실행에서 돌지 않는다\n${uploadStep}`);
  assert.match(uploadStep, /^\s*path:\s*tools\/web-checks\/reports\/?\s*$/m, `보고서 올리기가 tools/web-checks/reports를 올리지 않는다\n${uploadStep}`);
  // test:build는 지금처럼 budgets 잡에만 있다(31d356ba 전 reflow 잡에 있던 것을 다시 옮기지 않는다, 계획 F9)
  assert.doesNotMatch(reflow, /test:build/, 'reflow 잡이 test:build를 돈다(budgets 잡 몫이다)');
  const jobNames = [...web.matchAll(/^ {2}([A-Za-z][\w-]*):\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(
    jobNames.filter((name) => /test:build/.test(code(jobOf(web, name)))),
    ['budgets'],
    'test:build를 도는 잡이 budgets 하나가 아니다',
  );
});
