// asvs-report: ignore(이 파일의 태그는 시험 자료다)
// trace-check.mjs를 바깥에서 돌려 보는 시험(docs/architecture.md §8.6의 5단계 '대조', ADR-0178 결정 4). 실행: node --test "tools/ci/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'trace-check.mjs');

/** vitest JSON 보고서(--reporter=json)의 모양 */
const vitest = (tests) =>
  JSON.stringify({ testResults: [{ name: 'a.test.ts', assertionResults: tests.map(([fullName, status]) => ({ fullName, title: fullName, ancestorTitles: [], status })) }] });

function run(args, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'trace-check-'));
  const paths = Object.entries(files).map(([name, body]) => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  });
  const r = spawnSync(process.execPath, [script, ...args, ...paths.flatMap((p) => ['--report', p])], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
}

test('범위의 시험 ID마다 통과한 시험이 있으면 통과한다', () => {
  const r = run(['--ids', 'J-T25,P-T39'], {
    'a.json': vitest([
      ['정산 돈 불변식 > J-T25 시험 데이터에서 0건', 'passed'],
      ['결제 > P-T39 ① 결제 취소 0건', 'passed'],
    ]),
  });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /J-T25 통과 1/);
});

test('통과한 시험이 없는 ID가 있으면 실패하고 그 ID를 적는다', () => {
  const r = run(['--ids', 'J-T25,J-T24'], { 'a.json': vitest([['J-T25 시험 데이터', 'passed']]) });
  assert.equal(r.status, 1);
  assert.match(r.out, /J-T24 시험 없음/);
});

test('실패하거나 건너뛴 시험만 있으면 통과로 세지 않는다', () => {
  const r = run(['--ids', 'S-T2,FE-T7'], {
    'a.json': vitest([
      ['S-T2 불변식 검사기', 'failed'],
      ['FE-T7 서명 벡터', 'skipped'],
    ]),
  });
  assert.equal(r.status, 1);
  assert.match(r.out, /S-T2 실패 1/);
  assert.match(r.out, /FE-T7 건너뜀 1/);
});

test('ID 경계: S-T2는 S-T27에 걸리지 않고, FR-073은 FR073_로 적은 시험에도 걸린다', () => {
  const r = run(['--ids', 'S-T2,FR-073'], {
    'a.json': vitest([
      ['S-T27 좌석 샤드 처리량', 'passed'],
      ['FR073_소명요청_양도잠금', 'passed'],
    ]),
  });
  assert.equal(r.status, 1);
  assert.match(r.out, /S-T2 시험 없음/);
  assert.match(r.out, /FR-073 통과 1/);
});

test('ASVS 항목은 그대로 맞추고 더 깊은 번호에 걸리지 않는다', () => {
  const r = run(['--ids', 'v5.0.0-1.2.4,v5.0.0-13.3.1'], {
    'a.json': vitest([
      ['[ASVS v5.0.0-1.2.40] 다른 항목', 'passed'],
      ['설정(ASVS v5.0.0-13.3.1·13.4.2)', 'passed'],
    ]),
  });
  assert.equal(r.status, 1);
  assert.match(r.out, /v5\.0\.0-1\.2\.4 시험 없음/);
  assert.match(r.out, /v5\.0\.0-13\.3\.1 통과 1/);
});

test('JUnit XML(node --test·pytest)도 읽고, failure·error·skipped 자식은 통과가 아니다', () => {
  const xml = `<?xml version="1.0"?>
<testsuites><testsuite name="ci">
  <testcase name="D-T47 ① 문서만 바꾸면 docs만 고른다" classname="changes" time="0.1"/>
  <testcase name="D-T48 &quot;깨짐&quot; &amp; 수준" classname="contract"><failure message="x">boom</failure></testcase>
  <testcase name="D-T41 가지 규칙" classname="branch"><skipped/></testcase>
</testsuite></testsuites>`;
  const r = run(['--ids', 'D-T47,D-T48,D-T41'], { 'r.xml': xml });
  assert.equal(r.status, 1);
  assert.match(r.out, /D-T47 통과 1/);
  assert.match(r.out, /D-T48 실패 1/);
  assert.match(r.out, /D-T41 건너뜀 1/);
});

test('실제 node --test JUnit 보고서: 이름·실패 메시지에 > 가 있어도 실패를 통과로 세지 않고 뒤 시험을 놓치지 않는다(새 맥락 리뷰)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-check-junit-'));
  const t = join(dir, 'x.test.mjs');
  writeFileSync(
    t,
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('J-T6 금액 > 0', () => {});",
      "test('J-T20 꺾쇠 실패', () => { assert.equal('<input/>', '<input>'); });",
      "test('J-T21 메시지 실패', () => { throw new Error('a/>b'); });",
      "test('J-T7 <tag> 이름', () => {});",
      "test('J-T10 뒤 시험', () => {});",
    ].join('\n'),
  );
  const xml = join(dir, 'r.xml');
  // 바깥 시험 실행기의 NODE_TEST_CONTEXT를 물려받으면 안쪽 실행이 보고서 파일을 쓰지 않는다
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  spawnSync(process.execPath, ['--test', '--test-reporter=junit', `--test-reporter-destination=${xml}`, t], { encoding: 'utf8', env });
  const r = spawnSync(process.execPath, [script, '--ids', 'J-T6,J-T20,J-T21,J-T7,J-T10', '--report', xml], { encoding: 'utf8' });
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 1, out);
  assert.match(out, /J-T6 통과 1/);
  assert.match(out, /J-T20 실패 1/);
  assert.match(out, /J-T21 실패 1/);
  assert.match(out, /J-T7 통과 1/);
  assert.match(out, /J-T10 통과 1/);
});

test('보고서 여럿을 합쳐 본다', () => {
  const r = run(['--ids', 'J-T25,D-T47'], {
    'a.json': vitest([['J-T25', 'passed']]),
    'b.xml': '<testsuites><testsuite><testcase name="D-T47 문서" classname="c"/></testsuite></testsuites>',
  });
  assert.equal(r.status, 0, r.out);
});

test('인자가 틀리면 종료 코드 2', () => {
  assert.equal(run([]).status, 2);
  assert.equal(run(['--ids', 'J-T25']).status, 2);
  assert.equal(run(['--ids', ''], { 'a.json': vitest([]) }).status, 2);
  assert.equal(run(['--ids', 'J-T25'], { 'a.txt': 'not a report' }).status, 2);
  assert.equal(run(['--ids', 'J-T25', '--what'], { 'a.json': vitest([]) }).status, 2);
});
