// tools/ci/records.mjs 시험(ADR-0190 결정 3: 기록은 한 번만 쓰고 공용 표는 스크립트가 만든다)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  parseRecords,
  applyReview,
  applySummary,
  wbsCounts,
  applyWbsCsv,
  applyWbsMd,
  nextR,
} from './records.mjs';
import { repo, commit, git } from './git-fixture.mjs';

const SEP_FIELD = '\x1f';
const SEP_REC = '\x1e';

// git log --format=%H%x1f%h%x1f%cs%x1f%s%x1f%b%x1e 꼴
function logOf(...commits) {
  return commits
    .map(({ full, hash, date, subject, body }) => [full ?? `${hash}${'0'.repeat(40)}`.slice(0, 40), hash, date, subject, body].join(SEP_FIELD))
    .join(SEP_REC) + SEP_REC;
}

const ROW_265 = '| R-265 | 단계마다 기록 문서 6개를 고쳤다 | docs/PROGRESS.md 턴 규칙 | 기록을 한 번만 쓴다 | 수정 완료 |';

// ---------- 커밋 기록 읽기 ----------
test('커밋 본문의 정합 점검 행과 변경 요약 줄을 읽는다', () => {
  const log = logOf({
    hash: 'abc1234', date: '2026-11-04', subject: 'chore(process): 기록을 줄인다(ADR-0190, R-265)',
    body: `본문 첫 줄\n\n정합 점검: ${ROW_265}\n변경 요약: 작업 절차 줄이기(R-265, 2026-11-04, ADR-0190): 기록을 한 번만 쓴다\n`,
  });
  const recs = parseRecords(log);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].r, 'R-265');
  assert.equal(recs[0].num, 265);
  assert.equal(recs[0].row, ROW_265);
  assert.equal(recs[0].summary, '작업 절차 줄이기(R-265, 2026-11-04, ADR-0190): 기록을 한 번만 쓴다');
  assert.equal(recs[0].commit, 'abc1234');
  assert.equal(recs[0].date, '2026-11-04');
});

test('기록 줄이 없는 커밋과 본문 속 다른 표 행은 건너뛴다', () => {
  const log = logOf(
    { hash: 'a1', date: '2026-11-04', subject: 'fix: x', body: '| R-200 | 정합 점검 접두가 없는 행 | a | b | 수정 완료 |\n' },
    { hash: 'a2', date: '2026-11-04', subject: 'feat: y', body: '' },
  );
  assert.deepEqual(parseRecords(log), []);
});

test('칸 수가 다섯이 아닌 정합 점검 행은 건너뛰고 경고한다(지난 커밋 하나가 스크립트를 영구히 막지 않게)', () => {
  const warns = [];
  const log = logOf(
    { hash: 'a1', date: '2026-11-04', subject: 's', body: '정합 점검: | R-266 | 칸이 | 모자라다 |\n' },
    { hash: 'a2', date: '2026-11-04', subject: 't', body: `정합 점검: ${ROW_265}\n` },
  );
  const recs = parseRecords(log, (w) => warns.push(w));
  assert.deepEqual(recs.map((r) => r.r), ['R-265']);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /R-266.*칸.*a1/);
});

test('칸 안의 코드 표시 속 |는 칸을 나누지 않는다', () => {
  const row = '| R-268 | `a | b` 꼴이 틀렸다 | x | y | 수정 완료 |';
  const recs = parseRecords(logOf({ hash: 'a1', date: '2026-11-04', subject: 's', body: `정합 점검: ${row}\n` }));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].row, row);
});

test('들여쓴 줄과 표 행이 아닌 정합 점검 글은 기록으로 읽지 않는다', () => {
  const warns = [];
  const log = logOf({ hash: 'a1', date: '2026-11-04', subject: 's', body: `    정합 점검: ${ROW_265}\n정합 점검: 없음(문서만 고쳤다)\n` });
  assert.deepEqual(parseRecords(log, (w) => warns.push(w)), []);
  assert.deepEqual(warns, []);
});

test('되돌린 커밋의 기록은 읽지 않는다', () => {
  const full = 'f'.repeat(40);
  const log = logOf(
    { full: 'e'.repeat(40), hash: 'eeee', date: '2026-11-05', subject: 'Revert "x"', body: `This reverts commit ${full}.\n` },
    { full, hash: 'ffff', date: '2026-11-04', subject: 'x', body: `정합 점검: ${ROW_265}\n` },
  );
  assert.deepEqual(parseRecords(log), []);
});

test('같은 R 번호를 두 커밋이 다른 행으로 쓰면 둘 다 남기고 경고한다', () => {
  const warns = [];
  const log = logOf(
    { hash: 'a2', date: '2026-11-05', subject: 't', body: '정합 점검: | R-265 | 다른 문제 | x | y | 수정 완료 |\n' },
    { hash: 'a1', date: '2026-11-04', subject: 's', body: `정합 점검: ${ROW_265}\n` },
  );
  const recs = parseRecords(log, (w) => warns.push(w));
  assert.deepEqual(recs.map((r) => r.commit), ['a1', 'a2']);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /R-265.*a1.*a2/);
});

test('되돌린 것을 다시 되돌리면 처음 커밋의 기록이 살아난다', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const log = logOf(
    { full: 'c'.repeat(40), hash: 'cccc', date: '2026-11-06', subject: 'Revert "Revert "x""', body: `This reverts commit ${b}.\n` },
    { full: b, hash: 'bbbb', date: '2026-11-05', subject: 'Revert "x"', body: `This reverts commit ${a}.\n` },
    { full: a, hash: 'aaaa', date: '2026-11-04', subject: 'x', body: `정합 점검: ${ROW_265}\n` },
  );
  assert.deepEqual(parseRecords(log).map((r) => r.commit), ['aaaa']);
});

test('짝이 없는 백틱 하나는 코드 표시로 보지 않는다(문서 점검과 같은 셈)', () => {
  const row = '| R-269 | 백틱 ` 하나 | x | y | 수정 완료 |';
  const recs = parseRecords(logOf({ hash: 'a1', date: '2026-11-04', subject: 's', body: `정합 점검: ${row}\n` }));
  assert.equal(recs.length, 1);
});

test('같은 R 번호의 같은 행이 두 번 나오면(작업 가지와 합친 커밋) 하나로 본다', () => {
  const log = logOf(
    { hash: 'a1', date: '2026-11-04', subject: 's', body: `정합 점검: ${ROW_265}\n` },
    { hash: 'a2', date: '2026-11-04', subject: 's', body: `정합 점검: ${ROW_265}\n` },
  );
  assert.equal(parseRecords(log).length, 1);
});

// ---------- 정합 점검 표 ----------
const REVIEW = [
  '## 3. 정합성 이슈',
  '',
  '| ID | 문제 | 고친 곳 | 방법 | 상태 |',
  '| --- | --- | --- | --- | --- |',
  '| R-263 | 가 | 나 | 다 | 수정 완료 |',
  '| R-264 | 라 | 마 | 바 | 수정 완료 |',
  '',
  '## 4. 숫자 일치표',
  '',
].join('\n');

test('정합 점검 표에 없는 R 행만 마지막 R 행 뒤에 번호 차례로 넣는다', () => {
  const recs = [
    { r: 'R-266', num: 266, row: '| R-266 | 둘째 | x | y | 수정 완료 |' },
    { r: 'R-265', num: 265, row: ROW_265 },
    { r: 'R-264', num: 264, row: '| R-264 | 라 | 마 | 바 | 수정 완료 |' },
  ];
  const { text, added } = applyReview(REVIEW, recs);
  assert.deepEqual(added, ['R-265', 'R-266']);
  const lines = text.split('\n');
  const i = lines.indexOf('| R-264 | 라 | 마 | 바 | 수정 완료 |');
  assert.equal(lines[i + 1], ROW_265);
  assert.equal(lines[i + 2], '| R-266 | 둘째 | x | y | 수정 완료 |');
  assert.equal(lines[i + 3], '');
  assert.equal(lines[i + 4], '## 4. 숫자 일치표');
});

test('표에 같은 번호가 다른 행으로 있으면 넣지 않고 경고한다', () => {
  const warns = [];
  const recs = [{ r: 'R-264', num: 264, row: '| R-264 | 다른 갈래의 문제 | x | y | 수정 완료 |', commit: 'a2' }];
  const { text, added } = applyReview(REVIEW, recs, (w) => warns.push(w));
  assert.equal(text, REVIEW);
  assert.deepEqual(added, []);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /R-264.*a2/);
});

test('같은 문제 칸이 다른 번호로 이미 표에 있으면(손으로 번호를 옮겼으면) 넣지 않고 경고도 않는다', () => {
  const review = REVIEW.replace('| R-264 | 라 | 마 | 바 | 수정 완료 |', '| R-264 | 라 | 마 | 바 | 수정 완료 |\n| R-266 | 다른 갈래의 문제 | x | y | 수정 완료 |');
  const warns = [];
  const recs = [{ r: 'R-264', num: 264, row: '| R-264 | 다른 갈래의 문제 | x | y | 수정 완료 |', commit: 'a2' }];
  const { added } = applyReview(review, recs, (w) => warns.push(w));
  assert.deepEqual(added, []);
  assert.deepEqual(warns, []);
});

test('같은 행의 상태 칸만 손으로 고쳤으면 다시 넣지 않는다', () => {
  const review = REVIEW.replace('| R-264 | 라 | 마 | 바 | 수정 완료 |', '| R-264 | 라 | 마 | 바 | 일부 남음 |');
  const { added } = applyReview(review, [{ r: 'R-264', num: 264, row: '| R-264 | 라 | 마 | 바 | 수정 완료 |', commit: 'a' }]);
  assert.deepEqual(added, []);
});

test('정합 점검 표에 넣을 것이 없으면 글을 그대로 둔다', () => {
  const { text, added } = applyReview(REVIEW, [{ r: 'R-264', num: 264, row: '| R-264 | 라 | 마 | 바 | 수정 완료 |' }]);
  assert.equal(text, REVIEW);
  assert.deepEqual(added, []);
});

// ---------- 변경 요약 §4 ----------
const SUMMARY = [
  '## 4. 변경 요약',
  '',
  '- 좌석 만료(R-263, 2026-11-04): 가',
  '- 작업 순서 개편(R-264, 2026-11-04, ADR-0189): 나',
  '',
  '',
  '## 5. [충돌] 결정 결과',
  '- R-265를 말하는 다른 절의 줄',
].join('\n');

test('변경 요약 §4에 없는 R 번호의 줄을 §4 끝에 넣는다(요약 줄이 있으면 그것을 쓴다)', () => {
  const recs = [{ r: 'R-265', num: 265, row: ROW_265, summary: '작업 절차 줄이기(R-265, 2026-11-04, ADR-0190): 다', date: '2026-11-04', commit: 'abc1234' }];
  const { text, added } = applySummary(SUMMARY, recs);
  assert.deepEqual(added, ['R-265']);
  const lines = text.split('\n');
  const i = lines.indexOf('- 작업 순서 개편(R-264, 2026-11-04, ADR-0189): 나');
  assert.equal(lines[i + 1], '- 작업 절차 줄이기(R-265, 2026-11-04, ADR-0190): 다');
  assert.equal(lines.at(-2), '## 5. [충돌] 결정 결과');
});

test('요약 줄이 없으면 정합 점검 행의 문제·방법 칸으로 줄을 만든다', () => {
  const recs = [{ r: 'R-266', num: 266, row: '| R-266 | 문제 칸 | 고친 곳 칸 | 방법 칸 | 수정 완료 |', summary: null, date: '2026-11-05', commit: 'def5678' }];
  const { text } = applySummary(SUMMARY, recs);
  assert.ok(text.includes('- R-266(2026-11-05, 커밋 def5678): 문제 칸 → 방법 칸\n'));
});

test('다른 절에만 나오는 R 번호는 §4에 없는 것으로 본다', () => {
  const recs = [{ r: 'R-265', num: 265, row: ROW_265, summary: null, date: '2026-11-04', commit: 'a' }];
  assert.deepEqual(applySummary(SUMMARY, recs).added, ['R-265']);
});

test('§4에 이미 있는 R 번호는 다시 넣지 않는다', () => {
  const recs = [{ r: 'R-264', num: 264, row: '| R-264 | a | b | c | d |', summary: null, date: '2026-11-04', commit: 'a' }];
  const { text, added } = applySummary(SUMMARY, recs);
  assert.equal(text, SUMMARY);
  assert.deepEqual(added, []);
});

// ---------- wbs 상태 칸 ----------
const BUILD = [
  '## Phase 3 — 구간 1',
  '- [x] PRF-130 wbs 2.5.1 ①: 홀드',
  '- [ ] PRF-135 wbs 2.5.1 ②: 만료',
  '- [x] PRF-085 wbs 2.2.1·2.2.2 ③: 측정 묶음',
  '- [x] FND-020 wbs 0.1.3 남은 것: 계약 검사',
  '- [ ] HOT-290 wbs 2.10.1: 셸 갈래 2(루프는 건너뛴다)',
  '- [ ] SEG-010 구간 1 마무리(ADR-0189 결정 5): wbs 9.9.9는 설명 안의 숫자라 세지 않는다',
  '- [x] FRN-010 사후 포렌식 기획 반영(문서만)',
].join('\n');

test('BUILD_ORDER 단계 머리의 wbs ID마다 끝낸 줄 수와 전체 줄 수를 센다', () => {
  const c = wbsCounts(BUILD);
  assert.deepEqual(c.get('2.5.1'), { done: 1, total: 2 });
  assert.deepEqual(c.get('2.2.1'), { done: 1, total: 1 });
  assert.deepEqual(c.get('2.2.2'), { done: 1, total: 1 });
  assert.deepEqual(c.get('0.1.3'), { done: 1, total: 1 });
  assert.deepEqual(c.get('2.10.1'), { done: 0, total: 1 });
  assert.equal(c.has('9.9.9'), false);
});

const CSV = [
  'WBS ID,레벨,Phase,작업,산출물,담당 역할(가상 팀),추정(일),"최소(일, -20%)","최대(일, +20%)",선행,마일스톤,관련 ID,상태,답변으로 늘어난 일수',
  '2.5.1,3,2,"홀드, 1인 한도 ""따옴표""",Soft Hold,구매,2.5,2,3,0.3.2,M2,"FR-010, ADR-0014",예정,0.5',
  '2.2.1,3,2,진입,진입,대기열,2,1.6,2.4,,M2,,진행,0',
  '2.2.2,3,2,대기,대기,대기열,2,1.6,2.4,,M2,,완료,0',
  '0.1.3,3,0,"계약, 검사",검사,플랫폼,1,0.8,1.2,,M0,,예정,0',
  '2.10.1,3,2,셸,셸,웹,2,1.6,2.4,,M2,,예정,0',
  '',
].join('\n');

test('wbs.csv 상태 칸을 올리기만 하고 다른 칸 글자는 그대로 둔다', () => {
  const { text, changed } = applyWbsCsv(CSV, wbsCounts(BUILD));
  const lines = text.split('\n');
  assert.equal(lines[1], '2.5.1,3,2,"홀드, 1인 한도 ""따옴표""",Soft Hold,구매,2.5,2,3,0.3.2,M2,"FR-010, ADR-0014",진행,0.5');
  assert.equal(lines[2], '2.2.1,3,2,진입,진입,대기열,2,1.6,2.4,,M2,,완료,0');
  assert.equal(lines[3], '2.2.2,3,2,대기,대기,대기열,2,1.6,2.4,,M2,,완료,0');
  assert.equal(lines[4], '0.1.3,3,0,"계약, 검사",검사,플랫폼,1,0.8,1.2,,M0,,완료,0');
  assert.equal(lines[5], '2.10.1,3,2,셸,셸,웹,2,1.6,2.4,,M2,,예정,0');
  assert.deepEqual(changed.sort(), ['0.1.3 예정→완료', '2.2.1 진행→완료', '2.5.1 예정→진행']);
  assert.ok(text.endsWith('\n'));
});

test('완료를 진행으로 내리지 않는다(뒤에 단계 줄이 더해져도)', () => {
  const build = '- [x] X-1\n- [ ] PRF-140 wbs 2.2.2 ②: 더한 줄\n- [x] PRF-141 wbs 2.2.2 ①: 앞 줄';
  const { changed } = applyWbsCsv(CSV, wbsCounts(build));
  assert.equal(changed.some((c) => c.startsWith('2.2.2')), false);
});

const MD = [
  '| WBS ID | 작업 | 산출물 | 담당 | 추정(일) | 선행 | 관련 ID | 상태 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  '| 2.5.1 | 홀드 \\| 한도 | Soft Hold | 구매 | 2.5 | 0.3.2 | FR-010 | 예정 |',
  '| 2.2.1 | 진입 | 진입 | 대기열 | 2 | | | 진행 |',
  '',
  '| WBS ID | 늘어난 까닭 | 일수 | 근거 |',
  '| --- | --- | --- | --- |',
  '| 2.5.1 | 멱등 키 | 0.25 | 예정 |',
].join('\n');

test('wbs.md는 상태 칸이 있는 작업 표의 행만 마지막 칸을 고친다', () => {
  const { text, changed } = applyWbsMd(MD, wbsCounts(BUILD));
  const lines = text.split('\n');
  assert.equal(lines[2], '| 2.5.1 | 홀드 \\| 한도 | Soft Hold | 구매 | 2.5 | 0.3.2 | FR-010 | 진행 |');
  assert.equal(lines[3], '| 2.2.1 | 진입 | 진입 | 대기열 | 2 | | | 완료 |');
  assert.equal(lines[7], '| 2.5.1 | 멱등 키 | 0.25 | 예정 |');
  assert.deepEqual(changed.sort(), ['2.2.1 진행→완료', '2.5.1 예정→진행']);
});

test('다음 R 번호는 정합 점검 표와 커밋 기록 가운데 큰 번호 다음이다', () => {
  assert.equal(nextR(REVIEW, []), 'R-265');
  assert.equal(nextR(REVIEW, [{ num: 270 }]), 'R-271');
});

// ---------- 명령줄 ----------
function seedRepo() {
  const dir = repo('records-');
  mkdirSync(join(dir, 'docs', 'review'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'wbs'), { recursive: true });
  commit(dir, {
    'docs/review/consistency-review.md': REVIEW,
    'docs/00-summary.md': SUMMARY + '\n',
    'docs/BUILD_ORDER.md': BUILD + '\n',
    'docs/wbs/wbs.csv': CSV,
    'docs/wbs/wbs.md': MD + '\n',
  }, 'docs: 처음');
  commit(dir, { 'note.txt': 'x' }, `chore(process): 기록(R-265)\n\n정합 점검: ${ROW_265}\n변경 요약: 작업 절차 줄이기(R-265, 2026-11-04, ADR-0190): 다`);
  return dir;
}

function cli(dir, ...args) {
  return spawnSync(process.execPath, [join(import.meta.dirname, 'records.mjs'), '--root', dir, ...args], { encoding: 'utf8' });
}

test('명령줄 --check는 고칠 것이 있으면 1로 끝나고 파일을 고치지 않는다', () => {
  const dir = seedRepo();
  const r = cli(dir, '--check');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /R-265/);
  assert.match(r.stdout, /2\.5\.1 예정→진행/);
  assert.equal(readFileSync(join(dir, 'docs/review/consistency-review.md'), 'utf8'), REVIEW);
});

test('명령줄은 네 파일을 맞추고, 다시 돌리면 고칠 것이 없다', () => {
  const dir = seedRepo();
  const r = cli(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(readFileSync(join(dir, 'docs/review/consistency-review.md'), 'utf8').includes(ROW_265));
  assert.ok(readFileSync(join(dir, 'docs/00-summary.md'), 'utf8').includes('- 작업 절차 줄이기(R-265'));
  assert.ok(readFileSync(join(dir, 'docs/wbs/wbs.csv'), 'utf8').includes('"FR-010, ADR-0014",진행,0.5'));
  assert.ok(readFileSync(join(dir, 'docs/wbs/wbs.md'), 'utf8').includes('| FR-010 | 진행 |'));
  const again = cli(dir, '--check');
  assert.equal(again.status, 0, again.stdout + again.stderr);
});

test('명령줄 --next-r은 다음 R 번호를 찍는다', () => {
  const dir = seedRepo();
  const r = cli(dir, '--next-r');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'R-266');
});

test('명령줄 --next-r은 다른 가지(다른 갈래의 작업 가지)의 커밋 기록도 본다', () => {
  const dir = seedRepo();
  git(dir, 'checkout', '-q', '-b', 'lane2/x');
  commit(dir, { 'l2.txt': 'z' }, 'feat: 갈래 2\n\n정합 점검: | R-266 | 갈래 2 | x | y | 수정 완료 |');
  git(dir, 'checkout', '-q', 'main');
  const r = cli(dir, '--next-r');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'R-267');
});

test('명령줄은 다른 가지에만 있는 기록을 표에 넣지 않는다(합치지 않은 작업 가지)', () => {
  const dir = seedRepo();
  git(dir, 'checkout', '-q', '-b', 'lane2/y');
  commit(dir, { 'l2.txt': 'z' }, 'feat: 갈래 2\n\n정합 점검: | R-266 | 갈래 2 | x | y | 수정 완료 |');
  git(dir, 'checkout', '-q', 'main');
  assert.equal(cli(dir).status, 0);
  assert.equal(readFileSync(join(dir, 'docs/review/consistency-review.md'), 'utf8').includes('R-266'), false);
});

test('명령줄은 같은 번호의 두 기록 가운데 먼저 것만 R 표와 요약 §4에 넣는다', () => {
  const dir = seedRepo();
  commit(dir, { 'n1.txt': '1' }, 'feat: 갈래 1\n\n정합 점검: | R-270 | 첫째 문제 | x | y | 수정 완료 |');
  commit(dir, { 'n2.txt': '2' }, 'feat: 갈래 2\n\n정합 점검: | R-270 | 둘째 문제 | x | y | 수정 완료 |');
  const r = cli(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /R-270/);
  const review = readFileSync(join(dir, 'docs/review/consistency-review.md'), 'utf8');
  assert.ok(review.includes('| R-270 | 첫째 문제 |'));
  assert.equal(review.includes('둘째 문제'), false);
  const summary = readFileSync(join(dir, 'docs/00-summary.md'), 'utf8');
  assert.equal(summary.match(/R-270/g).length, 1);
  assert.ok(summary.includes('첫째 문제'));
});

test('명령줄은 표에서 번호를 옮겨 둔 기록을 요약 §4에 옛 번호로 넣지 않는다', () => {
  const dir = seedRepo();
  assert.equal(cli(dir).status, 0);
  const p = join(dir, 'docs/review/consistency-review.md');
  writeFileSync(p, readFileSync(p, 'utf8').replace(ROW_265, '| R-264b | x | x | x | x |\n| R-271 | 단계마다 기록 문서 6개를 고쳤다 | docs/PROGRESS.md 턴 규칙 | 기록을 한 번만 쓴다 | 수정 완료 |'));
  const s = join(dir, 'docs/00-summary.md');
  writeFileSync(s, readFileSync(s, 'utf8').replace(/- 작업 절차 줄이기\(R-265[^\n]*\n/, ''));
  const r = cli(dir, '--check');
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('명령줄은 지난 커밋의 잘못된 행을 경고하고 건너뛴 채 나머지를 맞춘다', () => {
  const dir = seedRepo();
  commit(dir, { 'note2.txt': 'y' }, 'fix: 잘못된 기록\n\n정합 점검: | R-267 | 칸이 모자라다 |');
  const r = cli(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /R-267/);
  assert.ok(readFileSync(join(dir, 'docs/review/consistency-review.md'), 'utf8').includes(ROW_265));
});

test('명령줄은 읽을 파일이 없으면 2로 끝난다(--check의 1과 가른다)', () => {
  const dir = seedRepo();
  git(dir, 'rm', '-q', 'docs/wbs/wbs.md');
  const r = cli(dir, '--check');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /wbs\.md/);
});

test('CRLF로 저장된 문서도 LF 글로 다루고 LF로 쓴다', () => {
  const dir = seedRepo();
  writeFileSync(join(dir, 'docs/wbs/wbs.csv'), CSV.replaceAll('\n', '\r\n'));
  const r = cli(dir);
  assert.equal(r.status, 0, r.stderr);
  const out = readFileSync(join(dir, 'docs/wbs/wbs.csv'), 'utf8');
  assert.equal(out.includes('\r'), false);
  assert.ok(out.includes('"FR-010, ADR-0014",진행,0.5'));
});
