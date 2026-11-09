// asvs-report: ignore(이 파일의 태그는 시험 자료다)
// ASVS 추적 시험 태그 수집 리포트(tools/ci/asvs-report.mjs, docs/architecture.md §8.2 4번, BUILD_ORDER BOT-160) 시험.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildReport, readAsvsDocs, scanTaggedSources, summaryMarkdown } from './asvs-report.mjs';

const TOOL = fileURLToPath(new URL('./asvs-report.mjs', import.meta.url));
const HEADER = '| ASVS ID | 레벨 | 요구사항 요약 | 적용 여부 | 구현 위치 | 테스트 결과 | 미적용 사유 |\n| --- | --- | --- | --- | --- | --- | --- |\n';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'asvs-report-'));
  const docs = join(root, 'asvs');
  mkdirSync(docs);
  writeFileSync(
    join(docs, 'auth.md'),
    `# 인증\n\n${HEADER}| v5.0.0-6.2.1 | L1 | 길이 | 적용 | identity | 미실행 | — |\n| v5.0.0-7.2.4 | L1 | 회전 | 적용 | identity | 미실행 | — |\n| v5.0.0-7.3.9 | L2 | 무엇 | 적용 | identity | 미실행 | — |\n| v5.0.0-9.9.9 | L3 | 안 함 | 미적용 | — | — | 해당 없음 |\n`,
  );
  writeFileSync(join(docs, 'pay.md'), `# 결제\n\n${HEADER}| v5.0.0-7.2.4 | L1 | 회전 | 적용 | payment | 미실행 | — |\n`);
  const src = join(root, 'svc', 'test');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'a.test.ts'), "test('길이 [ASVS v5.0.0-6.2.1]', () => {});\ntest('회전 [ASVS v5.0.0-7.2.4]', () => {});\ntest('설계만 [ASVS v5.0.0-7.3.9]', () => {});\n");
  writeFileSync(join(src, 'b.test.mjs'), "test('모르는 번호 [ASVS v5.0.0-1.1.1]', () => {});\n");
  const report = join(root, 'vitest.json');
  writeFileSync(
    report,
    JSON.stringify({
      testResults: [
        {
          assertionResults: [
            { fullName: '길이 [ASVS v5.0.0-6.2.1]', status: 'passed' },
            { fullName: '회전 [ASVS v5.0.0-7.2.4]', status: 'failed' },
            { fullName: '회전 다시 [ASVS v5.0.0-7.2.4]', status: 'passed' },
          ],
        },
      ],
    }),
  );
  return { root, docs, src: join(root, 'svc'), report };
}

test('문서 표의 행을 읽는다(같은 ID가 두 문서에 있으면 둘 다)', () => {
  const f = fixture();
  const rows = readAsvsDocs(f.docs);
  assert.deepEqual(
    rows.map((r) => `${r.doc} ${r.id} ${r.applied}`),
    ['auth.md v5.0.0-6.2.1 적용', 'auth.md v5.0.0-7.2.4 적용', 'auth.md v5.0.0-7.3.9 적용', 'auth.md v5.0.0-9.9.9 미적용', 'pay.md v5.0.0-7.2.4 적용'],
  );
});

test('원본에서 태그를 센다(실행하지 않아도 달린 시험)', () => {
  const f = fixture();
  assert.deepEqual(Object.fromEntries(scanTaggedSources([f.src])), { 'v5.0.0-6.2.1': 1, 'v5.0.0-7.2.4': 1, 'v5.0.0-7.3.9': 1, 'v5.0.0-1.1.1': 1 });
});

test('리포트_행마다통과·실패·미실행·태그없음을가르고_실패한태그시험과문서에없는ID를알린다', () => {
  const f = fixture();
  const r = buildReport({ docsDir: f.docs, reports: [f.report], scan: [f.src] });
  const by = Object.fromEntries(r.rows.map((x) => [`${x.doc} ${x.id}`, x.result]));
  assert.deepEqual(by, {
    'auth.md v5.0.0-6.2.1': '통과',
    'auth.md v5.0.0-7.2.4': '실패',
    'auth.md v5.0.0-7.3.9': '미실행',
    'auth.md v5.0.0-9.9.9': '—',
    'pay.md v5.0.0-7.2.4': '실패',
  });
  assert.deepEqual(r.failed, ['회전 [ASVS v5.0.0-7.2.4]']);
  assert.deepEqual(r.unknownIds, ['v5.0.0-1.1.1']);
  assert.deepEqual(r.totals, { rows: 5, applied: 4, passed: 1, failed: 2, notRun: 1, untagged: 0, designCheck: 0 });
});

test('명령_요약을markdown으로쓰고JSON을남기며_실패한태그시험이있으면종료코드1·strict면모르는ID도1이다', () => {
  const f = fixture();
  const md = join(f.root, 'summary.md');
  const json = join(f.root, 'report.json');
  let code = 0;
  try {
    execFileSync(process.execPath, [TOOL, '--docs', f.docs, '--report', f.report, '--scan', f.src, '--summary', md, '--json', json], { encoding: 'utf8' });
  } catch (e) {
    code = e.status;
  }
  assert.equal(code, 1);
  const text = readFileSync(md, 'utf8');
  assert.match(text, /적용 4행/);
  assert.match(text, /실패한 태그 시험/);
  assert.match(text, /회전 \[ASVS v5\.0\.0-7\.2\.4\]/);
  assert.equal(JSON.parse(readFileSync(json, 'utf8')).totals.applied, 4);
  // 실패가 없으면 0, 모르는 ID는 strict에서만 1
  const ok = join(f.root, 'ok.json');
  writeFileSync(ok, JSON.stringify({ testResults: [{ assertionResults: [{ fullName: '길이 [ASVS v5.0.0-6.2.1]', status: 'passed' }] }] }));
  execFileSync(process.execPath, [TOOL, '--docs', f.docs, '--report', ok, '--scan', f.src]);
  assert.throws(() => execFileSync(process.execPath, [TOOL, '--docs', f.docs, '--report', ok, '--scan', f.src, '--strict'], { stdio: 'pipe' }), (e) => e.status === 1);
  assert.throws(() => execFileSync(process.execPath, [TOOL, '--bogus'], { stdio: 'pipe' }), (e) => e.status === 2);
});

test('재검토_부분적용행도적용으로세고_설계검사행은따로세며_대괄호없는꼴의태그도읽되꼴이다르다고알리고_cases파일도훑고_ignore표시파일은건너뛴다', () => {
  const f = fixture();
  const rowsMd = ['| v5.0.0-2.3.4 | L2 | 부분 | 부분 적용 | gate | 미실행 | — |', '| v5.0.0-3.4.5 | L2 | 설계 | 적용 | infra 헤더(운영 설계만) | 미실행 | — |', '| v5.0.0-4.5.6 | L2 | 케이스 | 적용 | x | 미실행 | — |'].join('\n');
  writeFileSync(join(f.docs, 'gate.md'), `# 게이트\n\n${HEADER}${rowsMd}\n`);
  writeFileSync(join(f.src, 'test', 'login-cases.ts'), "export const cases = [{ name: '케이스 [ASVS v5.0.0-4.5.6]' }];\n");
  writeFileSync(join(f.src, 'test', 'loose.test.mjs'), "test('대괄호 없이 ASVS v5.0.0-2.3.4 그리고 ASVS-v5.0.0-2.3.4', () => {});\n");
  // ignore 표시는 tools/ci 아래 파일에만 듣는다(다른 곳의 시험 파일은 이 표시로 빠지지 않는다)
  const toolDir = join(f.root, 'tools', 'ci');
  mkdirSync(toolDir, { recursive: true });
  writeFileSync(join(toolDir, 'fixture.test.mjs'), "// asvs-report: ignore\ntest('자료 [ASVS v5.0.0-8.8.8]', () => {});\n");
  writeFileSync(join(f.src, 'test', 'marked.test.mjs'), "// asvs-report: ignore\ntest('진짜 [ASVS v5.0.0-7.7.7]', () => {});\n");
  const report = join(f.root, 'r2.json');
  writeFileSync(report, JSON.stringify({ testResults: [{ assertionResults: [{ fullName: '대괄호 없이 ASVS v5.0.0-2.3.4', status: 'failed' }, { fullName: '설계 [ASVS v5.0.0-3.4.5]', status: 'passed' }] }] }));
  const r = buildReport({ docsDir: f.docs, reports: [report], scan: [f.src, join(f.root, 'tools')] });
  assert.ok(r.unknownIds.includes('v5.0.0-7.7.7'));
  const by = Object.fromEntries(r.rows.filter((x) => x.doc === 'gate.md').map((x) => [x.id, x.result]));
  assert.deepEqual(by, { 'v5.0.0-2.3.4': '실패', 'v5.0.0-3.4.5': '설계 검사', 'v5.0.0-4.5.6': '미실행' });
  assert.equal(r.totals.designCheck, 1);
  assert.ok(!r.unknownIds.includes('v5.0.0-8.8.8'));
  assert.deepEqual(r.looseTags, ['대괄호 없이 ASVS v5.0.0-2.3.4']);
  // 원본에서 본 꼴이 다른 태그도 알린다(파일과 꼴)
  assert.deepEqual(r.looseSources.map((x) => x.tag).sort(), ['ASVS v5.0.0-2.3.4', 'ASVS-v5.0.0-2.3.4']);
});

test('재검토2_판번호없는꼴(ASVS2.1.1_·ASVS-6.1.2·ASVS 14.3.2)도읽어꼴이다르다고알리고_요약에보고서수를적는다', () => {
  const f = fixture();
  writeFileSync(join(f.src, 'test', 'nover.test.mjs'), "test('ASVS-6.2.1_길이', () => {});\ntest('ASVS7.2.4_회전', () => {});\ndescribe('묶음(ASVS 7.3.9)', () => {});\ntest('ASVS v5.0.0 L2 기준선 문장', () => {});\n");
  const r = buildReport({ docsDir: f.docs, reports: [f.report], scan: [f.src] });
  assert.deepEqual(r.looseSources.filter((x) => x.file.endsWith('nover.test.mjs')).map((x) => x.tag), ['ASVS-6.2.1', 'ASVS7.2.4', 'ASVS 7.3.9']);
  assert.ok(!r.unknownIds.includes('v5.0.0-5.0.0'));
  assert.equal(r.reportCount, 1);
  assert.match(summaryMarkdown(r), /보고서 1개/);
});

test('재검토3_이름하나안의같은태그는한번세고_옛판표기(4.0.3)는태그가아니며_문장끝마침표·v없는판표기도읽는다', () => {
  const f = fixture();
  writeFileSync(join(f.src, 'test', 'r3.test.mjs'), "test('두 번 [ASVS v5.0.0-6.2.1] 다시 [ASVS v5.0.0-6.2.1]', () => {});\n// OWASP ASVS 4.0.3 기준\n// 끝 (ASVS 7.3.9.)\n// 판 ASVS 5.0.0-7.2.4 표기\n");
  const report = join(f.root, 'r3.json');
  writeFileSync(report, JSON.stringify({ testResults: [{ assertionResults: [{ fullName: '두 번 [ASVS v5.0.0-6.2.1] 다시 [ASVS v5.0.0-6.2.1]', status: 'passed' }] }] }));
  const r = buildReport({ docsDir: f.docs, reports: [report], scan: [f.src] });
  assert.equal(r.rows.find((x) => x.doc === 'auth.md' && x.id === 'v5.0.0-6.2.1').passed, 1);
  assert.ok(!r.unknownIds.includes('v5.0.0-4.0.3'));
  const tags = r.looseSources.filter((x) => x.file.endsWith('r3.test.mjs')).map((x) => x.tag);
  assert.ok(tags.includes('ASVS 7.3.9'));
  assert.ok(tags.includes('ASVS 5.0.0-7.2.4'));
});

test('재검토4_밑줄꼴(ASVS8_2_3_·ASVS_16_2_5_)도읽고_꼴알림은겹침을지우기전에보며_뒤에붙은빼기표도읽는다', () => {
  const f = fixture();
  writeFileSync(join(f.src, 'test', 'r4.test.mjs'), "test('ASVS6_2_1_길이', () => {});\ntest('ASVS_7_2_4_회전', () => {});\n// 범위 ASVS 7.3.9-7.3.10\n// 판 ASVS_5_0_0_ 표기\n");
  const report = join(f.root, 'r4.json');
  const names = ['앞 ASVS v5.0.0-6.2.1 끝 [ASVS v5.0.0-6.2.1]', '앞 [ASVS v5.0.0-7.2.4] 끝 ASVS v5.0.0-7.2.4', '정본만 [ASVS v5.0.0-7.3.9]'];
  writeFileSync(report, JSON.stringify({ testResults: [{ assertionResults: names.map((fullName) => ({ fullName, status: 'passed' })) }] }));
  const r = buildReport({ docsDir: f.docs, reports: [report], scan: [f.src] });
  const tags = r.looseSources.filter((x) => x.file.endsWith('r4.test.mjs')).map((x) => x.tag);
  assert.deepEqual(tags.sort(), ['ASVS 7.3.9', 'ASVS6_2_1', 'ASVS_7_2_4']);
  assert.ok(!r.unknownIds.includes('v5.0.0-5.0.0'));
  // 같은 ID가 겹친 이름은 순서와 관계없이 꼴 알림이 나고, 정본 꼴만 있는 이름은 알리지 않는다
  assert.deepEqual(r.looseTags, names.slice(0, 2).sort());
  assert.equal(r.rows.find((x) => x.doc === 'auth.md' && x.id === 'v5.0.0-6.2.1').passed, 1);
});
