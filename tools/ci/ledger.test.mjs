// asvs-report: ignore(이 파일의 시험 ID·세부 번호·ASVS 태그는 시험 자료다. ledger.mjs도 이 표시를 보고 건너뛴다)
// tools/ci/ledger.mjs 시험(ADR-0256 결정 2: 완성 장부). 실행: node --test tools/ci/ledger.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  splitCriterion,
  scenarioItems,
  requirementItems,
  asvsItems,
  testTitles,
  marksIn,
  readNotes,
  judge,
  selectScope,
  batchScope,
  codeArea,
  ASVS_DEFAULT_AREA,
  gradeOf,
} from './ledger.mjs';
import { tempDir } from './git-fixture.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'ledger.mjs');

// ---------- 시험 자료 ----------
const PAYMENT = `# 결제

## 9. 시험

| # | 테스트 시나리오 | 검증 방법 | 합격 판정 기준 | 연결 요구사항 |
| --- | --- | --- | --- | --- |
| P-T1 | 승인 실패 | 실패 코드 주입 | 좌석 해제, 과금 0건 | FR-001 |
| P-T2 | 예매 제한 | ① 제한을 보낸다 ② 다른 좌석 ③ 결제 | ① 403 \`booking-restricted\` ② 홀드는 201(POL-038 ⑪과 같다, V-T36 ①) ③ 받는다 | FR-002, POL-001 |
| P-T3 | (없앰 2026-10-28) 헤지 요청 | — | ① 쓰지 않는다 | FR-001 |
| P-T4 | 범위 묶음 | 네 가지 | ①~③ 모두 막힌다. ④는 통과한다 | NFR-001 |
`;

const FRONTEND = `# 화면

| ID | 무엇 | 어떻게 | 언제 | 통과 기준 |
| --- | --- | --- | --- | --- |
| FE-T1 | 토큰 형식 | ① 이름 ② 형식 | PR | 위반 0 |
| FE-T2 | 단일 | 하나 | PR(§⑪ 참고) | 0건 |
`;

const SETTLEMENT = `# 정산

| ID | 시나리오 | 통과 기준 |
| --- | --- | --- |
| J-T1 | 정산서 계산 | 지급액이 맞다. 연결: FR-001~002 |
`;

const REQ = `# 요구사항

| ID | 액터 | 요구사항 | 우선순위 | 인수 조건(Given-When-Then) |
| --- | --- | --- | --- | --- |
| FR-001 | 팬 | 로그인 | Must | Given 로그인 |
| FR-002 | 팬 | 본인확인 | Must | Given 본인확인 |
| FR-003 | 팬 | 검색 | Must | Given 검색 |

| ID | 분류 | 목표치 | 측정·검증 방법 | 출처·대응 |
| --- | --- | --- | --- | --- |
| NFR-001 | 성능 | p99 200ms | 부하 | 원문 |
| NFR-002 | 가용성 | 99.9% | 측정 | 원문 |
`;

const POL = `# 정책

| ID | 정책 | 규칙 | 예외 처리 | 관련 FR |
| --- | --- | --- | --- | --- |
| POL-001 | 본인확인 | 순번 전에 | 없음 | FR-002 |
| POL-002 | 법정 고지 | 고지한다 | 없음 | FR-003 |
`;

const ASVS = `# ASVS 추적 표: 결제

| ASVS ID | 레벨 | 요구사항 요약 | 적용 여부 | 구현 위치 | 테스트 결과 | 미적용 사유 |
| --- | --- | --- | --- | --- | --- | --- |
| v5.0.0-1.2.4 | L1 | 파라미터 쿼리로 주입을 막는다 | 적용 | \`payment-svc\` | 미실행 | — |
| v5.0.0-1.2.5 | L1 | OS 명령 주입을 막는다 | 미적용 | — | — | 해당 없음(OS 명령을 부르지 않는다) |
| v5.0.0-13.1.1 | L2 | 통신 설정을 문서로 둔다 | 부분 적용 (운영자 한정) | 배포 설정(운영 설계만) | 미실행 | — |
`;

const TEST_SOURCE = `import { test, describe } from 'vitest';
// test('P-T1 주석 속 이름은 세지 않는다')
/* it('P-T1 막은 주석도 세지 않는다') */
describe('P-T2 ① 제한', () => {
  test('P-T2 ②③ 홀드는 201이다 [ASVS v5.0.0-1.2.4]', () => {});
});
test.each([[1], [2]])('P-T4 %s 막힌다', () => {});
const s = "test('FR-003 문자열 속 이름은 세지 않는다')";
`;

const NOTES = `# 장부 손 기록

| 항목 | 상태 | 등급 | 정할 곳 | 근거·사유 |
| --- | --- | --- | --- | --- |
| P-T4 ④ | 측정 | | PRF-140 | 부하 수치로 판정한다 |
| NFR-002 | 미검증 | | 클라우드 | 클라우드 계정이 없다 |
| POL-002 | | A | | 법정 의무 |
`;

const BUILD_ORDER = `# 만드는 차례

## 기능 묶음

| 묶음 | 갈래 | 구간 | 등급 | 단계 | WBS 일 | 장부 범위 | 비고 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BAT-010 | 1 | 2 | A | HOT-070 | 2 | \`P-T2\`, \`docs/security/asvs/payment.md\` | |
| BAT-020 | 1 | 2 | A | HOT-071 | 1 | P-T4 | |
`;

function fixtureRepo(over = {}) {
  const dir = tempDir('ledger-');
  const files = {
    'docs/features/payment.md': PAYMENT,
    'docs/frontend.md': FRONTEND,
    'docs/features/settlement.md': SETTLEMENT,
    'docs/planning/02-requirements.md': REQ,
    'docs/planning/03-policies-glossary.md': POL,
    'docs/security/asvs/payment.md': ASVS,
    'docs/review/ledger-notes.md': NOTES,
    'docs/BUILD_ORDER.md': BUILD_ORDER,
    // 정본이 아닌 곳의 시험 행은 항목이 아니다
    'docs/review/old.md': '| ID | 시나리오 | 기대 결과 |\n| --- | --- | --- |\n| X-T9 | 지난 기록 | 무엇 |\n',
    'services/payment-svc/test/a.test.ts': TEST_SOURCE,
    'services/payment-svc/node_modules/x/b.test.js': "test('P-T1 남의 패키지는 세지 않는다')\n",
    ...over,
  };
  for (const [p, t] of Object.entries(files)) {
    if (t === null) continue;
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), t);
  }
  return dir;
}

const run = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, '--root', dir, ...args], { encoding: 'utf8' });
const byKey = (items) => new Map(items.map((i) => [i.key, i]));

// ---------- 판정 기준 나누기 ----------
test('판정 기준을 동그라미 번호로 나누고, ID 바로 뒤의 번호(다른 행·정책의 세부)는 나누지 않는다', () => {
  const r = splitCriterion('앞말. ① 403이다 ② 홀드는 201(POL-038 ⑪과 같다, V-T36 ①) ③ 받는다');
  assert.equal(r.preamble, '앞말.');
  assert.deepEqual([...r.parts.keys()], [1, 2, 3]);
  assert.equal(r.parts.get(1), '403이다');
  assert.match(r.parts.get(2), /^홀드는 201/);
  assert.equal(r.parts.get(3), '받는다');
});

test('①~③ 범위와 ①②③·①·③ 묶음은 그 번호 모두에 같은 글을 준다', () => {
  const r = splitCriterion('①~③ 모두 막힌다. ④는 통과한다');
  assert.deepEqual([...r.parts.keys()], [1, 2, 3, 4]);
  assert.equal(r.parts.get(2), '모두 막힌다.');
  assert.equal(r.parts.get(4), '는 통과한다');
  assert.deepEqual([...splitCriterion('①②③ 동안 아니다. ①은 계속').parts.keys()], [1, 2, 3]);
  assert.match(splitCriterion('①②③ 동안 아니다. ①은 계속').parts.get(1), /동안 아니다.*은 계속/);
  assert.deepEqual([...splitCriterion('①·③은 거절한다').parts.keys()], [1, 3]);
});

test('동그라미 번호가 없으면 나누지 않는다. 조문 번호(§23의5④)와 WBS 번호(wbs 2.5.5 ①)·단계(PRF-150 ①)의 세부도 세부가 아니다', () => {
  assert.equal(splitCriterion('좌석 해제, 과금 0건').parts.size, 0);
  assert.equal(splitCriterion('정보통신망법 §23의5④를 따른다').parts.size, 0);
  assert.equal(splitCriterion('좌석 진행성(wbs 2.5.5 ①)은 반례가 나왔다(BUILD_ORDER PRF-150 ①)').parts.size, 0);
});

// ---------- 시나리오 표 뽑기 ----------
test('판정 칸을 머리 이름으로 찾아 세부 항목을 만든다(합격 판정 기준이 넷째 칸인 표)', () => {
  const { items, warnings } = scenarioItems('docs/features/payment.md', PAYMENT);
  assert.deepEqual(warnings, []);
  const m = byKey(items);
  assert.deepEqual([...m.keys()], ['P-T1', 'P-T2 ①', 'P-T2 ②', 'P-T2 ③', 'P-T3', 'P-T4 ①', 'P-T4 ②', 'P-T4 ③', 'P-T4 ④']);
  assert.equal(m.get('P-T1').sub, null);
  assert.equal(m.get('P-T1').criterion, '좌석 해제, 과금 0건');
  assert.equal(m.get('P-T1').title, '승인 실패');
  assert.equal(m.get('P-T2 ①').criterion, '403 `booking-restricted`');
  assert.equal(m.get('P-T2 ②').sub, 2);
  assert.deepEqual(m.get('P-T2 ①').refs, ['FR-002', 'POL-001', 'POL-038']);
});

test("제목에 '(없앰'이 든 행은 세부로 나누지 않고 없앰 항목 하나다", () => {
  const p3 = byKey(scenarioItems('docs/features/payment.md', PAYMENT).items).get('P-T3');
  assert.equal(p3.removed, true);
  assert.equal(p3.sub, null);
});

test('통과 기준이 마지막 칸인 표도 머리 이름으로 찾고, 판정 칸에 번호가 없으면 시나리오·방법 칸의 번호로 나눈다(연결·언제 칸은 보지 않는다)', () => {
  const m = byKey(scenarioItems('docs/frontend.md', FRONTEND).items);
  assert.deepEqual([...m.keys()], ['FE-T1 ①', 'FE-T1 ②', 'FE-T2']);
  assert.match(m.get('FE-T1 ②').criterion, /형식.*위반 0/);
  assert.equal(m.get('FE-T2').criterion, '0건');
});

test('판정 칸을 찾지 못한 표는 경고하고 행 전체를 판정 기준으로 본다', () => {
  const doc = '| ID | 하나 | 둘 |\n| --- | --- | --- |\n| Z-T1 | 가 | 나 |\n';
  const { items, warnings } = scenarioItems('docs/x.md', doc);
  assert.equal(items.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /docs\/x\.md:1.*판정/);
  assert.equal(items[0].criterion, '가 나');
});

test('시나리오 칸에는 있는데 판정 칸에 없는 번호는 세부로 세지 않고 경고한다(정본 표를 고칠 곳)', () => {
  const doc = '| ID | 시나리오 | 통과 기준 |\n| --- | --- | --- |\n| Z-T1 | ① 없는 좌석 ② 섞은 좌석 | 모두 422다. ②도 부분 홀드가 0건이다 |\n';
  const { items, warnings } = scenarioItems('docs/x.md', doc);
  assert.deepEqual(items.map((i) => i.key), ['Z-T1 ②']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /docs\/x\.md:3: Z-T1.*①.*판정 칸에 없/);
});

test('시나리오 행이 가리키지 않는 FR·NFR·POL만 요구사항 항목이다(범위 FR-001~002도 가리킨 것으로 본다)', () => {
  const refs = new Set();
  for (const [p, t] of [['docs/features/payment.md', PAYMENT], ['docs/features/settlement.md', SETTLEMENT]]) {
    for (const i of scenarioItems(p, t).items) for (const r of i.refs) refs.add(r);
  }
  const items = requirementItems(REQ, POL, refs);
  assert.deepEqual(items.map((i) => i.key), ['FR-003', 'NFR-002', 'POL-002']);
  assert.equal(items[0].doc, 'docs/planning/02-requirements.md');
  assert.equal(items[2].doc, 'docs/planning/03-policies-glossary.md');
});

test('ASVS 추적 표의 행: 적용·부분 적용은 항목, 미적용은 사유와 함께 해당 없음, 운영 설계만은 따로 표시한다', () => {
  const m = byKey(asvsItems('docs/security/asvs/payment.md', ASVS));
  assert.deepEqual([...m.keys()], ['payment:v5.0.0-1.2.4', 'payment:v5.0.0-1.2.5', 'payment:v5.0.0-13.1.1']);
  assert.equal(m.get('payment:v5.0.0-1.2.4').applied, true);
  assert.equal(m.get('payment:v5.0.0-1.2.5').applied, false);
  assert.equal(m.get('payment:v5.0.0-1.2.5').reason, '해당 없음(OS 명령을 부르지 않는다)');
  assert.equal(m.get('payment:v5.0.0-13.1.1').applied, true);
  assert.equal(m.get('payment:v5.0.0-13.1.1').designOnly, true);
});

const ASVS_HEAD = '| ASVS ID | 레벨 | 요구사항 요약 | 적용 여부 | 구현 위치 | 테스트 결과 | 미적용 사유 |\n| --- | --- | --- | --- | --- | --- | --- |\n';

test('ASVS 코드 영역: 구현 위치의 경로(앞 두 마디)·서비스·앱 이름, 없으면 문서별 기본 영역(코드가 없는 기능은 빈 목록)', () => {
  const doc = `${ASVS_HEAD}| v5.0.0-1.1.1 | L2 | 가 | 적용 | \`apps/web/src/x.ts\`·\`purchase-svc\`: 나. identity-svc가 본다. \`@peaket/ds\`, loadtest/README.md | 미실행 | — |
| v5.0.0-1.1.2 | L2 | 가 | 적용 | \`ops-svc\`: 아직 없는 서비스만 적었다 | 미실행 | — |
| v5.0.0-1.2.1 | L1 | 가 | 적용 | 공통: delivery.md 판정. \`CDN\`·\`gw-fan\` | 미실행 | — |
| v5.0.0-1.2.2 | L1 | 가 | 적용 | \`web\`·\`partner\`: 화면, \`identity\` | 미실행 | — |
`;
  const dirs = ['apps/web', 'apps/partner', 'services/purchase-svc', 'services/identity-svc', 'packages/ds'];
  const [a, b, c, d] = asvsItems('docs/security/asvs/seat-hold.md', doc);
  assert.deepEqual(codeArea(a, dirs), ['apps/web', 'loadtest', 'packages/ds', 'services/identity-svc', 'services/purchase-svc']);
  assert.deepEqual(codeArea(b, dirs), ['services/ops-svc']);
  assert.deepEqual(codeArea(c, dirs), ASVS_DEFAULT_AREA['seat-hold']);
  assert.ok(!ASVS_DEFAULT_AREA['seat-hold'].includes('packages/platform'), '공용 영역은 기본 영역에 넣지 않는다');
  assert.deepEqual(codeArea(d, dirs), ['apps/partner', 'apps/web', 'services/identity-svc']);
  // 같은 코드의 다른 진입점(seatmap-worker·image-worker)은 core-svc 폴더의 시험을 센다(ADR-0257 결정 5)
  const [w] = asvsItems('docs/security/asvs/seat-hold.md', `${ASVS_HEAD}| v5.0.0-1.5.1 | L1 | 가 | 적용 | \`seatmap-worker\`: 나. image-worker도 같다 | 미실행 | — |\n`);
  assert.deepEqual(codeArea(w, [...dirs, 'services/core-svc']), ['services/core-svc']);
  const [e] = asvsItems('docs/security/asvs/analytics.md', `${ASVS_HEAD}| v5.0.0-1.2.1 | L1 | 가 | 적용 | 공통 | 미실행 | — |\n`);
  assert.deepEqual(codeArea(e, dirs), []);
  // 아직 코드가 없는 기능은 구현 위치 칸이 다른 기능의 폴더를 가리켜도 영역이 비어 있다(남의 시험 태그로 부풀지 않게)
  const [f] = asvsItems('docs/security/asvs/transfer-refund.md', `${ASVS_HEAD}| v5.0.0-2.2.2 | L1 | 가 | 적용 | \`services/purchase-svc\` | 미실행 | — |\n`);
  assert.deepEqual(codeArea(f, dirs), []);
});

test('ASVS 상태: 그 행의 코드 영역 안 시험 파일의 태그만 자동 시험이고, 같은 ID의 태그가 영역 밖에만 있으면 ID만이다', () => {
  const pay = `${ASVS_HEAD}| v5.0.0-1.2.4 | L1 | 가 | 적용 | \`payment-svc\` | 미실행 | — |
| v5.0.0-2.2.1 | L1 | 가 | 적용 | \`apps/web\`: 화면 검사 | 미실행 | — |
| v5.0.0-3.3.1 | L1 | 가 | 적용 | 공통 | 미실행 | — |
| v5.0.0-3.3.2 | L1 | 가 | 적용 | \`payment-svc\` | 미실행 | — |
`;
  const ana = `${ASVS_HEAD}| v5.0.0-1.2.4 | L1 | 가 | 적용 | 공통 | 미실행 | — |\n`;
  const items = [...asvsItems('docs/security/asvs/payment.md', pay), ...asvsItems('docs/security/asvs/analytics.md', ana)];
  const titles = [
    { file: 'services/payment-svc/test/a.test.ts', title: '결제 [ASVS v5.0.0-1.2.4] [ASVS v5.0.0-2.2.1]' },
    { file: 'apps/web/src/b.test.mjs', title: '화면 [ASVS v5.0.0-3.3.1]' },
  ];
  const m = byKey(judge({ items, titles, dirs: ['apps/web', 'services/payment-svc'] }).items);
  assert.equal(m.get('payment:v5.0.0-1.2.4').status, '자동 시험');
  assert.deepEqual(m.get('payment:v5.0.0-1.2.4').evidence, ['services/payment-svc/test/a.test.ts']);
  assert.equal(m.get('payment:v5.0.0-2.2.1').status, 'ID만');
  assert.deepEqual(m.get('payment:v5.0.0-2.2.1').evidence, ['services/payment-svc/test/a.test.ts']);
  assert.equal(m.get('payment:v5.0.0-3.3.1').status, '자동 시험', '기본 영역(payment)에 apps/web이 든다');
  assert.equal(m.get('payment:v5.0.0-3.3.2').status, '빈칸');
  assert.equal(m.get('analytics:v5.0.0-1.2.4').status, 'ID만', '코드가 없는 기능은 다른 곳 시험만 있으니 ID만');
});

// ---------- 시험 이름 읽기 ----------
test('시험 이름: test·it·describe와 사슬(each·skip·describe), 여러 줄, 템플릿을 읽고 주석·문자열·정규식 속 호출은 읽지 않는다', () => {
  const src = [
    "test('a S-T1', () => {});",
    'it("b", () => {});',
    'describe(`c ${x} d`, () => {});',
    "test.each([['x', 1], ['y', 2]])('e %s', () => {});",
    "test.each<[string]>([['x']])('f', () => {});",
    "test.concurrent.each([])('g', () => {});",
    "test.describe.serial('h', () => {});",
    'test(\n  "i",\n  () => {},\n);',
    "// test('주석')",
    "/* it('막은 주석') */",
    "const s = \"test('문자열')\";",
    "re.test('메서드');",
    "const r = /test\\('정규식'\\)/;",
    'test(name, () => {});',
    "test.beforeEach(() => {});",
  ].join('\n');
  assert.deepEqual(testTitles(src), ['a S-T1', 'b', 'c ${x} d', 'e %s', 'f', 'g', 'h', 'i']);
});

test('이름의 ID와 바로 뒤 세부 번호 묶음: ①, ①③, ①~③, 밑줄, 여러 ID, 세부 없는 ID', () => {
  assert.deepEqual(marksIn('S-T23 ① 남은 시간'), [{ id: 'S-T23', subs: [1] }]);
  assert.deepEqual(marksIn('S-T23 ①③ 멈춘다'), [{ id: 'S-T23', subs: [1, 3] }]);
  assert.deepEqual(marksIn('S-T23 ①~③ 멈춘다'), [{ id: 'S-T23', subs: [1, 2, 3] }]);
  assert.deepEqual(marksIn('P-T36 ④_리뷰 고침'), [{ id: 'P-T36', subs: [4] }]);
  assert.deepEqual(marksIn('[x] Q-T52⑤ Q-T68② 취소'), [{ id: 'Q-T52', subs: [5] }, { id: 'Q-T68', subs: [2] }]);
  assert.deepEqual(marksIn('H3 S-T23 멈춘 홀드'), [{ id: 'S-T23', subs: null }]);
  assert.deepEqual(marksIn('P-T49 ② 다시 403이다. ③ 막지 않는다'), [{ id: 'P-T49', subs: [2] }]);
});

test('ID 경계: S-T2는 S-T27에 걸리지 않고, 가운데 -를 뺀 ST23_①·FR073_도 읽는다', () => {
  assert.deepEqual(marksIn('S-T27 처리량'), [{ id: 'S-T27', subs: null }]);
  assert.deepEqual(marksIn('ST23_② 회차'), [{ id: 'S-T23', subs: [2] }]);
  assert.deepEqual(marksIn('ST27_NFR003_상수'), [{ id: 'S-T27', subs: null }, { id: 'NFR-003', subs: null }]);
  assert.deepEqual(marksIn('FR073_사건'), [{ id: 'FR-073', subs: null }]);
  assert.deepEqual(marksIn('HOT070_ 예매 제한'), []);
});

// ---------- 상태 판정 ----------
function fixtureLedger(notesText = NOTES, source = TEST_SOURCE) {
  const sc = scenarioItems('docs/features/payment.md', PAYMENT).items;
  const refs = new Set(sc.flatMap((i) => i.refs));
  const items = [...sc, ...requirementItems(REQ, POL, refs), ...asvsItems('docs/security/asvs/payment.md', ASVS)];
  const titles = testTitles(source).map((title) => ({ file: 'services/payment-svc/test/a.test.ts', title }));
  return judge({ items, titles, notes: readNotes(notesText) });
}

test('상태: 세부 번호를 단 이름은 자동 시험, ID만 단 이름은 ID만, 주석·문자열 속 이름은 빈칸', () => {
  const r = fixtureLedger();
  assert.deepEqual(r.errors, []);
  const m = byKey(r.items);
  assert.equal(m.get('P-T1').status, '빈칸');
  assert.equal(m.get('P-T2 ①').status, '자동 시험'); // describe 이름
  assert.equal(m.get('P-T2 ②').status, '자동 시험');
  assert.equal(m.get('P-T2 ③').status, '자동 시험');
  assert.equal(m.get('P-T3').status, '없앰');
  assert.equal(m.get('P-T4 ①').status, 'ID만');
  assert.deepEqual(m.get('P-T4 ①').evidence, ['services/payment-svc/test/a.test.ts']);
  assert.equal(m.get('FR-003').status, '빈칸');
});

test('상태: ASVS는 태그가 있으면 자동 시험, 미적용은 해당 없음, 운영 설계만은 다른 단계', () => {
  const m = byKey(fixtureLedger().items);
  assert.equal(m.get('payment:v5.0.0-1.2.4').status, '자동 시험');
  assert.equal(m.get('payment:v5.0.0-1.2.5').status, '해당 없음');
  assert.equal(m.get('payment:v5.0.0-1.2.5').reason, '해당 없음(OS 명령을 부르지 않는다)');
  assert.equal(m.get('payment:v5.0.0-13.1.1').status, '다른 단계');
});

test('notes가 상태와 등급을 덮는다: 세부 행은 그 세부만, ID 행은 그 ID의 세부 전부, 등급만 적은 행은 등급만', () => {
  const notes = `| 항목 | 상태 | 등급 | 정할 곳 | 근거·사유 |
| --- | --- | --- | --- | --- |
| P-T4 | 다른 단계 | | HOT-071 | 다음 묶음 |
| P-T4 ④ | 측정 | B | PRF-140 | 부하 수치 |
| POL-002 | | C | | 문구 |
| v5.0.0-1.2.4 | 사람 확인 | | | 사람이 본다 |
`;
  const r = fixtureLedger(notes);
  assert.deepEqual(r.errors, []);
  const m = byKey(r.items);
  assert.equal(m.get('P-T4 ①').status, '다른 단계');
  assert.equal(m.get('P-T4 ①').where, 'HOT-071');
  assert.equal(m.get('P-T4 ④').status, '측정');
  assert.equal(m.get('P-T4 ④').grade, 'B');
  assert.equal(m.get('P-T4 ①').grade, 'A');
  assert.equal(m.get('POL-002').status, '빈칸');
  assert.equal(m.get('POL-002').grade, 'C');
  assert.equal(m.get('payment:v5.0.0-1.2.4').status, '사람 확인');
});

test('notes가 다른 단계라는데 이름을 단 시험이 이미 있으면 다시 볼 notes로 알린다', () => {
  const notes = '| 항목 | 상태 | 등급 | 정할 곳 | 근거·사유 |\n| --- | --- | --- | --- | --- |\n| P-T2 ① | 다른 단계 | | HOT-071 | 다음 묶음 |\n';
  const r = fixtureLedger(notes);
  assert.deepEqual(r.conflicts.map((i) => i.key), ['P-T2 ①']);
});

test('notes 오류: 사유 없는 미검증, 모르는 상태·등급, 없는 항목·세부, 같은 항목 두 번', () => {
  const notes = `| 항목 | 상태 | 등급 | 정할 곳 | 근거·사유 |
| --- | --- | --- | --- | --- |
| P-T1 | 미검증 | | 클라우드 | |
| P-T2 ① | 통과 | | | 모르는 상태 |
| P-T2 ② | 측정 | D | | 모르는 등급 |
| P-T9 | 측정 | | | 없는 항목 |
| P-T2 ⑦ | 측정 | | | 없는 세부 |
| NFR-002 | 측정 | | | 첫째 |
| NFR-002 | 측정 | | | 둘째 |
| P-T2 ③ | 자동 시험 | | | notes로 자동 시험을 적을 수 없다 |
`;
  const r = fixtureLedger(notes);
  const text = r.errors.join('\n');
  assert.match(text, /P-T1.*미검증.*사유/);
  assert.match(text, /P-T2 ①.*통과/);
  assert.match(text, /P-T2 ②.*등급.*D/);
  assert.match(text, /P-T9.*없는 항목/);
  assert.match(text, /P-T2 ⑦.*없는 항목/);
  assert.match(text, /NFR-002.*두 번/);
  assert.match(text, /P-T2 ③.*자동 시험/);
  assert.equal(r.errors.length, 7);
});

// ---------- 범위 ----------
test('범위 토큰: 정본 문서 경로, 시험 ID, ID 머리, 세부, 요구사항 ID(가리키는 시나리오 포함), ASVS 문서', () => {
  const { items } = fixtureLedger();
  const keys = (t) => {
    const r = selectScope(items, t);
    assert.deepEqual(r.errors, []);
    return r.items.map((i) => i.key);
  };
  assert.equal(keys('docs/features/payment.md').length, 9);
  assert.deepEqual(keys('P-T2'), ['P-T2 ①', 'P-T2 ②', 'P-T2 ③']);
  assert.deepEqual(keys('P-T4 ④'), ['P-T4 ④']);
  assert.equal(keys('P-T').length, 9);
  assert.deepEqual(keys('FR-002'), ['P-T2 ①', 'P-T2 ②', 'P-T2 ③']);
  assert.deepEqual(keys('NFR-002'), ['NFR-002']);
  assert.deepEqual(keys('`docs/security/asvs/payment.md`'), ['payment:v5.0.0-1.2.4', 'payment:v5.0.0-1.2.5', 'payment:v5.0.0-13.1.1']);
  assert.deepEqual(keys('P-T1, P-T3'), ['P-T1', 'P-T3']);
});

test('범위 토큰이 아무 항목에도 맞지 않으면 오류다', () => {
  const r = selectScope(fixtureLedger().items, 'P-T1, docs/features/nothing.md, Q-T');
  assert.equal(r.errors.length, 2);
  assert.match(r.errors.join('\n'), /docs\/features\/nothing\.md/);
  assert.match(r.errors.join('\n'), /Q-T/);
});

test("범위 '-'는 빈 범위이고, 항목이 없는 정본 문서(시험 표가 없는 문서)는 오류가 아니라 경고다", () => {
  const { items } = fixtureLedger();
  const empty = selectScope(items, '-');
  assert.deepEqual(empty, { items: [], errors: [], warnings: [] });
  const r = selectScope(items, 'P-T1, docs/infra.md, docs/features/nothing.md', { docs: new Set(['docs/infra.md']) });
  assert.deepEqual(r.items.map((i) => i.key), ['P-T1']);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /nothing/);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /docs\/infra\.md/);
});

test("묶음 표에서 그 묶음의 '장부 범위' 칸을 읽는다", () => {
  assert.equal(batchScope(BUILD_ORDER, 'BAT-010'), '`P-T2`, `docs/security/asvs/payment.md`');
  assert.equal(batchScope(BUILD_ORDER, 'BAT-020'), 'P-T4');
  assert.throws(() => batchScope(BUILD_ORDER, 'BAT-999'), /BAT-999/);
  assert.throws(() => batchScope('# 표 없음\n', 'BAT-010'), /기능 묶음/);
});

// ---------- 명령줄 ----------
test('인자 없이 돌리면 README와 분야별 파일을 쓰고, 다시 --check하면 0이다', () => {
  const dir = fixtureRepo();
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  const readme = readFileSync(join(dir, 'docs/review/ledger/README.md'), 'utf8');
  assert.match(readme, /빈칸 \d+/);
  assert.match(readme, /미검증 1/);
  assert.match(readme, /한계/);
  assert.match(readme, /ASVS는 다른 곳 시험만 있는 경우도 ID만/);
  const pay = readFileSync(join(dir, 'docs/review/ledger/payment.md'), 'utf8');
  assert.match(pay, /\| P-T4 \| ④ \|.*\| 측정 \| A \|/);
  assert.match(pay, /v5\.0\.0-1\.2\.5.*해당 없음/);
  assert.ok(existsSync(join(dir, 'docs/review/ledger/requirements.md')));
  assert.ok(existsSync(join(dir, 'docs/review/ledger/frontend.md')));
  assert.ok(!readme.includes('X-T9'));
  assert.equal(run(dir, '--check').status, 0);
});

test('--check는 고칠 것이 있으면 1로 끝나고 파일을 고치지 않는다(없어질 파일도 알린다)', () => {
  const dir = fixtureRepo();
  assert.equal(run(dir).status, 0);
  const before = readFileSync(join(dir, 'docs/review/ledger/payment.md'), 'utf8');
  writeFileSync(join(dir, 'services/payment-svc/test/b.test.ts'), "test('P-T1 승인 실패면 과금 0건', () => {});\n");
  writeFileSync(join(dir, 'docs/review/ledger/old-area.md'), '# 옛 분야\n');
  const r = run(dir, '--check');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /docs\/review\/ledger\/payment\.md/);
  assert.match(r.stdout, /old-area\.md/);
  assert.equal(readFileSync(join(dir, 'docs/review/ledger/payment.md'), 'utf8'), before);
  assert.equal(run(dir).status, 0);
  assert.ok(!existsSync(join(dir, 'docs/review/ledger/old-area.md')));
  assert.equal(run(dir, '--check').status, 0);
});

test('--scope --require: 범위에 빈칸이나 ID만이 있으면 목록을 찍고 1, 없으면 0. 범위만 보고 파일은 쓰지 않는다', () => {
  const dir = fixtureRepo();
  const bad = run(dir, '--scope', 'P-T1, P-T4', '--require');
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /빈칸.*P-T1/);
  assert.match(bad.stdout, /ID만.*P-T4 ①/);
  assert.ok(!bad.stdout.includes('P-T4 ④ '), '측정 항목은 목록에 없다');
  assert.ok(!existsSync(join(dir, 'docs/review/ledger/README.md')));
  assert.equal(run(dir, '--scope', 'P-T1, P-T4').status, 0);
  const ok = run(dir, '--scope', 'P-T2, NFR-002', '--require');
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /미검증 1/);
});

test('--batch는 묶음 표의 장부 범위로 판정한다', () => {
  const dir = fixtureRepo();
  const ok = run(dir, '--batch', 'BAT-010', '--require');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const bad = run(dir, '--batch', 'BAT-020', '--require');
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /P-T4 ③/);
  assert.equal(run(dir, '--batch', 'BAT-999').status, 2);
  // 범위가 '-'인 묶음(측정 창·구간 마무리)은 항목이 없어 통과한다
  const empty = fixtureRepo({ 'docs/BUILD_ORDER.md': `${BUILD_ORDER}| BAT-030 | 1 | 2 | C | SEG-010 | 0.5 | - | 혼자 |\n` });
  const none = run(empty, '--batch', 'BAT-030', '--require');
  assert.equal(none.status, 0, none.stdout + none.stderr);
  assert.match(none.stdout, /항목 0개/);
});

test('끝 코드 2: notes 오류(사유 없는 미검증), 모르는 범위 토큰, 모르는 인자. 아무것도 쓰지 않는다', () => {
  const dir = fixtureRepo({
    'docs/review/ledger-notes.md': '| 항목 | 상태 | 등급 | 정할 곳 | 근거·사유 |\n| --- | --- | --- | --- | --- |\n| P-T1 | 미검증 | | | |\n',
  });
  const r = run(dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /P-T1.*사유/);
  assert.ok(!existsSync(join(dir, 'docs/review/ledger/README.md')));
  const ok = fixtureRepo();
  assert.equal(run(ok, '--scope', 'Z-T').status, 2);
  assert.equal(run(ok, '--nope').status, 2);
});

test('원천 문서의 기본 등급(ADR-0256 결정 10): 돈·좌석·대기 순번 문서만 A, 권한·개인정보·입장·보안 통제는 B', () => {
  for (const d of ['docs/features/payment.md', 'docs/features/seat-hold.md', 'docs/features/queue-admission.md', 'docs/features/settlement.md', 'docs/features/transfer-refund.md']) assert.equal(gradeOf(d), 'A', d);
  for (const d of ['docs/features/identity.md', 'docs/features/bot-defense.md', 'docs/features/offline-gate.md', 'docs/security/asvs/payment.md', 'docs/security/authz-matrix.md', 'docs/frontend.md', 'docs/planning/02-requirements.md']) assert.equal(gradeOf(d), 'B', d);
});
