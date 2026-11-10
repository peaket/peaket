// asvs-report: ignore(이 파일의 시험 ID·단계 ID는 시험 자료다. ledger.mjs와 brief.mjs의 코드 자리도 이 표시를 보고 건너뛴다)
// tools/ci/brief.mjs 시험(묶음 지시서, ADR-0256 결정 9). 실행: node --test tools/ci/brief.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MAX_CHARS,
  JOBS,
  INT_PACKAGES,
  batchRow,
  stepLines,
  operationIds,
  rpcNames,
  stepRefs,
  sectionRange,
  headingIndex,
  idsInLine,
  ciJobs,
  missedDefects,
} from './brief.mjs';
import { collect, judge, selectScope, batchScope } from './ledger.mjs';
import { repo, commit, tempDir } from './git-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'brief.mjs');
const ROOT = join(HERE, '../..');

// ---------- 시험 자료 ----------
const BUILD_ORDER = `# 만드는 차례

## 기능 묶음(ADR-0256)

- **읽는 법**: 표 위의 글이다.

| 묶음 | 갈래 | 구간 | 등급 | 단계 | WBS 일 | 장부 범위 | 비고 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BAT-010 | 1 | 2 | A | HOT-070·HOT-071 | 2.5 | docs/features/payment.md, P-T20, docs/security/asvs/payment.md, NFR-001 | 선행 PRF-150(갈래 1) |
| BAT-020 | 2 | 2 | C | HOT-080 | 1 | - | 혼자: 문서 묶음 |
| BAT-030 | 2 | 2 | C | HOT-099 | 1 | - | 단계 줄이 없다 |

## Phase 3

- [x] HOT-060 wbs 2.5.1: 끝난 단계(HOT-070이 이어받는다) (1일)
- [ ] HOT-070 wbs 2.5.2 ①: 홀드 연장 \`extendHold\`과 결제 시도(P-T2, V-T3, FR-003·POL-001, SCR-012, ADR-0184). 이름이 비슷한 createPaymentLater는 작업 이름이 아니다. docs/features/payment.md §2.1을 따른다 (1.5일)
  - [ ] HOT-071 wbs 2.5.2 ②: 결제 화면(SCR-012)과 gRPC \`CreateAttempt\`, docs/architecture.md §8·§8.6, 없는 절 docs/features/payment.md §7 (1일)
- [ ] HOT-080 wbs 2.6: 문서 묶음 (1일)
- [ ] HOT-0701 wbs 2.6: 번호가 비슷한 다른 단계 (1일)
`;

const PAYMENT = `# 결제

## 1. 개요

HOT-070이 만든다. P-T2를 본다.

## 2. 흐름

### 2.1 홀드 연장

연장은 \`extendHold\`로 한다. P-T2 ① 참고. P-T200은 다른 시험이고 HOT-0701은 다른 단계다.

\`\`\`text
## 2.9 코드 펜스 속 제목은 제목이 아니다
P-T2 펜스 속 언급
\`\`\`

### 2.2 결제

결제 화면은 HOT-071이 만든다.

## 9. 시험

| # | 테스트 시나리오 | 검증 방법 | 합격 판정 기준 | 연결 요구사항 |
| --- | --- | --- | --- | --- |
| P-T1 | 승인 실패 | 실패 코드 주입 | 좌석 해제, 과금 0건 | FR-001 |
| P-T2 | 예매 제한 | ① 제한 ② 다른 좌석 | ① 403 \`booking-restricted\` ② 홀드는 201 | FR-002, POL-001 |
| P-T20 | 긴 기준 | 하나 | ${'가'.repeat(400)} 끝 | FR-001 |
`;

const VERIFICATION = `# 검증

## 3. 시험 표

| ID | 시나리오 | 통과 기준 |
| --- | --- | --- |
| V-T3 | 모델 기반 | 이름이 맞다 |

## 4. 언급

HOT-070과 SCR-012. 요구사항 FR-001~004 범위.
${Array.from({ length: 35 }, (_, k) => `P-T1 반복 ${k + 1}`).join('\n')}
`;

const ARCH = `# 설계

## 8. 품질·보안 절차

### 8.6 기능 묶음

| 차례 | 하는 일 |
| --- | --- |
| 3. 구현 | 구현 지시문에 아래 '자주 놓친 결함'을 넣는다 |

1. **범위**: 묶음을 고른다.
   - **읽는 양 줄이기**: 지시서 경로를 준다.
   - **자주 놓친 결함(구현 지시문에 넣는다, 묶음마다 더한다)**: 시범 묶음에서 놓친 모양이다.
     - Lua 응답은 정확한 값까지 단언한다.
     - 경계값은 양쪽을 다 둔다(\`<\`와 \`<=\`).
2. **다음**: HOT-070을 본다.

### 8.7 실패 목록

끝.
`;

const DEFECTS = `- **자주 놓친 결함(구현 지시문에 넣는다, 묶음마다 더한다)**: 시범 묶음에서 놓친 모양이다.
  - Lua 응답은 정확한 값까지 단언한다.
  - 경계값은 양쪽을 다 둔다(\`<\`와 \`<=\`).`;

const OPENAPI = `openapi: 3.1.0
info:
  title: 시험
  description: |
    결제: 여러 줄 설명의 콜론은 키가 아니다
    목차:
      여기도 여러 줄 글이다
paths:
  /v1/holds/{holdId}/extensions:
    post:
      operationId: extendHold
      description: HOT-070이 만든다(P-T2)
  /v1/payments:
    post:
      operationId: 'createPayment'
      description: 결제
components:
  schemas:
    Hold:
      description: P-T2 ②의 홀드
`;

const ASYNCAPI = `asyncapi: 3.0.0
channels:
  holds:
    description: HOT-070 사건
`;

const PROTO = `syntax = "proto3";

service PaymentService {
  // HOT-070: 결제 시도
  rpc CreateAttempt(CreateAttemptRequest) returns (CreateAttemptResponse);
}
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
`;

const POL = `# 정책

| ID | 정책 | 규칙 | 예외 처리 | 관련 FR |
| --- | --- | --- | --- | --- |
| POL-001 | 본인확인 | 순번 전에 | 없음 | FR-002 |
`;

const ASVS = `# ASVS 추적 표: 결제

| ASVS ID | 레벨 | 요구사항 요약 | 적용 여부 | 구현 위치 | 테스트 결과 | 미적용 사유 |
| --- | --- | --- | --- | --- | --- | --- |
| v5.0.0-1.2.4 | L1 | 파라미터 쿼리로 주입을 막는다 | 적용 | \`purchase-svc\` | 미실행 | — |
| v5.0.0-1.2.5 | L1 | OS 명령 주입을 막는다 | 미적용 | — | — | 해당 없음(OS 명령을 부르지 않는다) |
`;

const NOTES = `# 장부 손 기록

| 항목 | 상태 | 등급 | 정할 곳 | 근거·사유 |
| --- | --- | --- | --- | --- |
| P-T1 | 다른 단계 | | HOT-070 | 이 묶음이 정한다 |
`;

const FILES = {
  'docs/BUILD_ORDER.md': BUILD_ORDER,
  'docs/features/payment.md': PAYMENT,
  'docs/verification.md': VERIFICATION,
  'docs/architecture.md': ARCH,
  'docs/planning/02-requirements.md': REQ,
  'docs/planning/03-policies-glossary.md': POL,
  'docs/security/asvs/payment.md': ASVS,
  'docs/review/ledger-notes.md': NOTES,
  'docs/api/openapi.yaml': OPENAPI,
  'docs/api/asyncapi.yaml': ASYNCAPI,
  'docs/api/proto/peaket/payment/v1/payment.proto': PROTO,
  'docs/api/proto/README.md': '# proto\n\nHOT-071 안내\n',
  'docs/adr/0184-model-test.md': '# ADR-0184 모델 기반 시험\n\nHOT-070이 따른다.\n',
  // 정본이 아닌 곳과 단계 줄이 가리키지 않은 ADR은 찾지 않는다
  'docs/adr/0185-other.md': '# ADR-0185 다른 결정\n\nHOT-070 P-T2\n',
  'docs/review/old.md': 'HOT-070 P-T2\n',
  'docs/walkthrough/a.md': 'HOT-070 P-T2\n',
  'docs/wbs/x.md': 'HOT-070\n',
  'docs/lanes/lane1.md': 'HOT-070\n',
  'docs/PROGRESS.md': 'HOT-070\n',
  'docs/progress-archive.md': 'HOT-070\n',
  'docs/00-summary.md': 'HOT-070\n',
  // 코드
  'services/purchase-svc/src/hold.ts': '// HOT-070 연장\nexport function extendHold() {}\n// P-T200만 있다\nexport const useExtendHold = 1;\n',
  'services/purchase-svc/test/hold.test.ts': "test('P-T2 ② 홀드는 201', () => {});\n",
  'apps/web/src/pay.tsx': '// SCR-012 결제 화면\n',
  // 범위 칸에 이름이 적힌 시험 ID(P-T20)는 단계 줄의 ID처럼 앞에 둔다
  'services/purchase-svc/src/long.ts': '// P-T20 긴 기준\n// P-T20 다시\n',
  // 범위 문서에서만 온 ID(P-T1)는 줄이 많아도 단계·범위 칸·단계 줄의 ID가 있는 파일 뒤다
  'services/purchase-svc/src/approve.ts': '// P-T1 승인 실패\n// P-T1 과금\n// P-T1 좌석\n',
  'packages/ds/src/button.tsx': '// HOT-071 버튼\n',
  'tools/ci/real.mjs': '// HOT-070 도구\n',
  // 찾지 않는 코드: 도구 시험 자료, 생성물, 남의 패키지, 빌드 결과, 코드 폴더 밖
  'tools/ci/fake.test.mjs': "// asvs-report: ignore\nconst s = 'P-T2 HOT-070';\n",
  'packages/contracts/gen/openapi.ts': 'export const extendHold = 1;\n',
  'services/purchase-svc/node_modules/x/index.js': '// HOT-070\n',
  'apps/web/.next/x.js': '// HOT-070\n',
  'packages/ds/dist/x.js': '// HOT-070\n',
  'other/elsewhere.ts': '// HOT-070\n',
  ...Object.fromEntries(Array.from({ length: 45 }, (_, k) => [`services/queue-svc/src/f${String(k + 1).padStart(2, '0')}.ts`, '// HOT-080\n'])),
};

function fixture(over = {}) {
  const dir = repo('brief-');
  commit(dir, { ...FILES, ...over });
  return dir;
}

const run = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, '--root', dir, ...args], { encoding: 'utf8' });

// 시험 자료 저장소 하나를 여러 시험이 함께 본다(지시서는 저장소를 고치지 않는다)
let shared;
const sharedDir = () => (shared ??= fixture());
const briefs = new Map();
function brief(batch) {
  if (!briefs.has(batch)) {
    const r = run(sharedDir(), '--batch', batch);
    assert.equal(r.status, 0, r.stderr);
    briefs.set(batch, r.stdout);
  }
  return briefs.get(batch);
}

const lineOf = (text, needle, nth = 1) => {
  let seen = 0;
  return text.split('\n').findIndex((l) => l.includes(needle) && ++seen === nth) + 1;
};
const stepText = (id) => BUILD_ORDER.split('\n').find((l) => l.trimStart().startsWith(`- [ ] ${id} `));

/** '## <머리>'로 시작하는 절(다음 '## ' 앞까지) */
function section(text, head, level = '##') {
  const ls = text.split('\n');
  const k = ls.findIndex((l) => l === `${level} ${head}` || l.startsWith(`${level} ${head} `) || (level === '##' && l.startsWith(`${level} ${head}`)));
  assert.ok(k >= 0, `'${level} ${head}' 절이 없다`);
  const e = ls.findIndex((l, i) => i > k && (l.startsWith(`${level} `) || (level === '###' && l.startsWith('## '))));
  return ls.slice(k, e < 0 ? undefined : e).join('\n');
}
const sub = (text, head) => section(text, head, '###');
const entries = (text) => text.split('\n').filter((l) => l.startsWith('- '));
const rowsOf = (text) => text.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| 항목') && !l.startsWith('| ---'));

// ---------- 묶음 표·단계 줄 ----------
test('묶음 표의 행을 칸 이름으로 읽고, 들여 쓴 단계 줄도 찾으며 번호가 비슷한 단계(HOT-0701)는 고르지 않는다', () => {
  const row = batchRow(BUILD_ORDER, 'BAT-010');
  assert.equal(row.line, lineOf(BUILD_ORDER, '| BAT-010 |'));
  assert.equal(row.text, BUILD_ORDER.split('\n')[row.line - 1]);
  assert.deepEqual(row.steps, ['HOT-070', 'HOT-071']);
  assert.equal(row.cells['장부 범위'], 'docs/features/payment.md, P-T20, docs/security/asvs/payment.md, NFR-001');
  assert.equal(row.cells['비고'], '선행 PRF-150(갈래 1)');
  assert.equal(row.cells['WBS 일'], '2.5');
  const steps = stepLines(BUILD_ORDER, row.steps);
  assert.deepEqual(
    steps.map((s) => [s.id, s.line]),
    [
      ['HOT-070', lineOf(BUILD_ORDER, '- [ ] HOT-070 ')],
      ['HOT-071', lineOf(BUILD_ORDER, '- [ ] HOT-071 ')],
    ],
  );
  assert.equal(steps[1].text, BUILD_ORDER.split('\n')[steps[1].line - 1]);
  assert.throws(() => batchRow(BUILD_ORDER, 'BAT-999'), /BAT-999/);
  assert.throws(() => batchRow('# 표 없음\n', 'BAT-010'), /기능 묶음 표/);
  assert.throws(() => stepLines(BUILD_ORDER, ['HOT-099']), /HOT-099/);

  const text = brief('BAT-010');
  // 1~8 절이 차례대로 있다
  const heads = text.split('\n').filter((l) => /^## \d\. /.test(l)).map((l) => l.slice(3, 5));
  assert.deepEqual(heads, ['1.', '2.', '3.', '4.', '5.', '6.', '7.', '8.']);
  const one = section(text, '1.');
  assert.ok(one.includes(row.text));
  assert.ok(one.includes(`docs/BUILD_ORDER.md:${row.line}`));
  const two = section(text, '2.');
  for (const s of steps) {
    assert.ok(two.includes(`docs/BUILD_ORDER.md:${s.line}`));
    assert.ok(two.includes(s.text.trimStart()));
  }
  assert.doesNotMatch(two, /HOT-0701 wbs/);
});

// ---------- 판정 항목 ----------
test('판정 항목: ledger.mjs --batch와 같은 항목을 남은 것과 나머지로 나눠 적고, 긴 판정 기준은 앞 300자와 원천 자리로 자른다', () => {
  const dir = sharedDir();
  const data = collect(dir);
  const sel = selectScope(judge(data).items, batchScope(BUILD_ORDER, 'BAT-010'), { docs: data.docs });
  assert.equal(sel.items.length, 7);
  const sec = section(brief('BAT-010'), '3.');
  const rows = rowsOf(sec);
  assert.equal(rows.length, sel.items.length);
  const keyOf = (l) => l.slice(2, l.indexOf(' | '));
  assert.deepEqual(rows.map(keyOf).sort(), sel.items.map((i) => i.key).sort());
  // 남은 것: 빈칸·ID만·미검증과 정할 곳이 이 묶음의 단계인 것
  assert.deepEqual(rowsOf(sub(sec, '남은 항목')).map(keyOf), ['P-T1', 'P-T2 ①', 'P-T20', 'NFR-001', 'payment:v5.0.0-1.2.4']);
  assert.deepEqual(rowsOf(sub(sec, '나머지')).map(keyOf), ['P-T2 ②', 'payment:v5.0.0-1.2.5']);
  const row = (key) => rows.find((l) => keyOf(l) === key);
  assert.equal(row('P-T1'), `| P-T1 | 다른 단계(HOT-070) — 이 묶음 | A | docs/features/payment.md:${lineOf(PAYMENT, '| P-T1 |')} | 좌석 해제, 과금 0건 |`);
  assert.equal(row('P-T2 ①'), `| P-T2 ① | ID만 | A | docs/features/payment.md:${lineOf(PAYMENT, '| P-T2 |')} | 403 \`booking-restricted\` |`);
  assert.match(row('P-T2 ②'), /^\| P-T2 ② \| 자동 시험 \| A \|/);
  assert.match(row('NFR-001'), /^\| NFR-001 \| 빈칸 \| B \| docs\/planning\/02-requirements\.md:\d+ \| p99 200ms \|$/);
  // ASVS 행은 결정 10부터 기본 B다(보안 통제는 표본으로 증명)
  assert.match(row('payment:v5.0.0-1.2.5'), /^\| payment:v5\.0\.0-1\.2\.5 \| 해당 없음 \| B \| docs\/security\/asvs\/payment\.md:\d+ \|/);
  assert.equal(row('P-T20'), `| P-T20 | 빈칸 | A | docs/features/payment.md:${lineOf(PAYMENT, '| P-T20 |')} | ${'가'.repeat(300)}…(docs/features/payment.md:${lineOf(PAYMENT, '| P-T20 |')}) |`);
  assert.match(sec, /항목 7개/);
  assert.match(sec, /빈칸 3/);
  // 범위가 '-'인 묶음은 항목이 없다
  assert.match(section(brief('BAT-020'), '3.'), /판정 항목이 없다/);
  assert.equal(rowsOf(section(brief('BAT-020'), '3.')).length, 0);
});

// ---------- 정본 자리 ----------
test('정본 자리: ledger의 정본과 docs/api·가리킨 ADR에서 ID 경계를 지켜 찾고, 문서별 줄 차례로 가장 가까운 제목을 단다', () => {
  const sec = section(brief('BAT-010'), '4.');
  // ID 차례: 단계, 범위 칸·단계 줄에 이름이 적힌 것, 범위 문서에서만 온 것
  assert.deepEqual(
    sec.split('\n').filter((l) => l.startsWith('### ') && l !== '### 단계 줄이 가리킨 절').map((l) => l.slice(4, l.indexOf(' — '))),
    ['HOT-070', 'HOT-071', 'P-T20', 'NFR-001', 'P-T2', 'V-T3', 'FR-003', 'POL-001', 'SCR-012', 'ADR-0184', 'extendHold', 'CreateAttempt', 'P-T1'],
  );
  assert.match(sub(sec, 'HOT-070'), /^### HOT-070 — 단계 · 7곳$/m);
  // 원천 문서가 없는 ID는 묶음 범위의 문서(payment.md)를 앞에, 나머지는 경로 차례
  assert.deepEqual(entries(sub(sec, 'HOT-070')), [
    `- docs/features/payment.md:${lineOf(PAYMENT, 'HOT-070이 만든다')} — 1. 개요`,
    '- docs/adr/0184-model-test.md:3 — ADR-0184 모델 기반 시험',
    '- docs/api/asyncapi.yaml:4 — channels › holds',
    `- docs/api/openapi.yaml:${lineOf(OPENAPI, 'HOT-070이 만든다(P-T2)')} — paths › /v1/holds/{holdId}/extensions › post`,
    '- docs/api/proto/peaket/payment/v1/payment.proto:4 — service PaymentService',
    '- docs/architecture.md:16 — 8.6 기능 묶음',
    `- docs/verification.md:${lineOf(VERIFICATION, 'HOT-070과')} — 4. 언급`,
  ]);
  // 그 ID의 원천 문서가 앞이고, 같은 문서·같은 제목의 이웃한 줄은 한 줄로, 코드 펜스 속 '##'은 제목이 아니다
  assert.deepEqual(entries(sub(sec, 'P-T2')), [
    `- docs/features/payment.md:${lineOf(PAYMENT, 'P-T2를 본다')} — 1. 개요`,
    `- docs/features/payment.md:${lineOf(PAYMENT, 'P-T2 ① 참고')}, ${lineOf(PAYMENT, 'P-T2 펜스 속')} — 2.1 홀드 연장`,
    `- docs/features/payment.md:${lineOf(PAYMENT, '| P-T2 |')} — 9. 시험`,
    `- docs/api/openapi.yaml:${lineOf(OPENAPI, 'HOT-070이 만든다(P-T2)')} — paths › /v1/holds/{holdId}/extensions › post`,
    `- docs/api/openapi.yaml:${lineOf(OPENAPI, 'P-T2 ②의 홀드')} — components › schemas › Hold`,
  ]);
  // FR 범위(FR-001~004)도 FR-003의 자리다. 요구사항 ID는 요구사항 문서가 원천이다
  assert.deepEqual(entries(sub(sec, 'FR-003')), [
    `- docs/planning/02-requirements.md:${lineOf(REQ, '| FR-003 |')} — 요구사항`,
    `- docs/verification.md:${lineOf(VERIFICATION, 'FR-001~004')} — 4. 언급`,
  ]);
  assert.match(sub(sec, 'V-T3'), /^### V-T3 — 시험\(단계 줄\) · 1곳$/m);
  assert.match(sub(sec, 'SCR-012'), /^### SCR-012 — 화면 · 1곳$/m);
  assert.match(sub(sec, 'ADR-0184'), /^### ADR-0184 — ADR · 1곳$/m);
  assert.match(sub(sec, 'NFR-001'), /^### NFR-001 — 요구사항 · 1곳$/m);
  assert.doesNotMatch(sec, /docs\/(review|walkthrough|wbs|lanes)\/|PROGRESS|BUILD_ORDER|00-summary|progress-archive|0185-other/);
  assert.doesNotMatch(sec, /HOT-0701|P-T200/);
  // 정본에 자리가 없는 ID
  assert.match(section(brief('BAT-020'), '4.'), /자리가 없는 ID: HOT-080/);
});

test('정본 자리: ID 하나에 30곳을 넘으면 앞 30곳과 외 N곳(문서별 곳 수)', () => {
  const block = sub(section(brief('BAT-010'), '4.'), 'P-T1');
  assert.match(block, /^### P-T1 — 시험 · 36곳$/m);
  const e = entries(block);
  assert.equal(e.at(-1), '- 외 6곳(docs/verification.md 6곳)');
  const shown = e.slice(0, -1).flatMap((l) => /:([\d, ]+) — /.exec(l)[1].split(', '));
  assert.equal(shown.length, 30);
  assert.equal(e[0], `- docs/features/payment.md:${lineOf(PAYMENT, '| P-T1 |')} — 9. 시험`);
  assert.equal(e[1], `- docs/verification.md:${Array.from({ length: 29 }, (_, k) => lineOf(VERIFICATION, 'P-T1 반복 1') + k).join(', ')} — 4. 언급`);
});

test('정본 자리: 적지 않은 곳은 곳 수가 많은 문서부터 10개까지 적고 나머지는 문서 수로 줄인다', () => {
  const extra = Object.fromEntries(Array.from({ length: 41 }, (_, k) => [`docs/extra/d${String(k + 1).padStart(2, '0')}.md`, '# 덧\n\nP-T20 언급\n']));
  extra['docs/extra/d41.md'] = '# 덧\n\nP-T20 하나\nP-T20 둘\n';
  const r = run(fixture(extra), '--batch', 'BAT-010');
  assert.equal(r.status, 0, r.stderr);
  const e = entries(sub(section(r.stdout, '4.'), 'P-T20'));
  // 원천 문서 하나 + 경로 차례 29곳, 나머지 13곳(d30~d40 한 곳씩, d41 두 곳)
  assert.equal(e[0], `- docs/features/payment.md:${lineOf(PAYMENT, '| P-T20 |')} — 9. 시험`);
  assert.equal(e[1], '- docs/extra/d01.md:3 — 덧');
  assert.equal(e.at(-1), `- 외 13곳(docs/extra/d41.md 2곳, ${Array.from({ length: 9 }, (_, k) => `docs/extra/d${30 + k}.md 1곳`).join(', ')}, 외 문서 2개)`);
});

test('가장 가까운 제목: md는 펜스 밖의 #, YAML은 들여쓰기 4칸까지의 키 경로(여러 줄 글은 키가 아니다), proto는 service·message·rpc', () => {
  const md = headingIndex('docs/features/payment.md', PAYMENT);
  assert.equal(md(1), '결제');
  assert.equal(md(lineOf(PAYMENT, 'P-T2 펜스 속')), '2.1 홀드 연장');
  assert.equal(md(lineOf(PAYMENT, '결제 화면은')), '2.2 결제');
  const yaml = headingIndex('docs/api/openapi.yaml', OPENAPI);
  assert.equal(yaml(lineOf(OPENAPI, '결제: 여러 줄')), 'info › description');
  assert.equal(yaml(lineOf(OPENAPI, '여기도 여러 줄 글')), 'info › description');
  assert.equal(yaml(lineOf(OPENAPI, 'operationId: extendHold')), 'paths › /v1/holds/{holdId}/extensions › post');
  assert.equal(yaml(lineOf(OPENAPI, 'description: 결제')), 'paths › /v1/payments › post');
  assert.equal(yaml(lineOf(OPENAPI, 'P-T2 ②의 홀드')), 'components › schemas › Hold');
  const proto = headingIndex('docs/api/proto/peaket/payment/v1/payment.proto', PROTO);
  assert.equal(proto(1), '');
  assert.equal(proto(4), 'service PaymentService');
  assert.equal(proto(5), 'rpc CreateAttempt');
});

test('ID 경계: P-T2는 P-T20·P-T200에, FR-001은 NFR-001에, extendHold는 useExtendHold에 걸리지 않고 FR 범위는 펼친다', () => {
  const ids = new Set(['P-T2', 'P-T20', 'FR-001', 'FR-003', 'extendHold', 'HOT-070']);
  assert.deepEqual([...idsInLine('P-T2를 보고 P-T200은 아니다', ids)], ['P-T2']);
  assert.deepEqual([...idsInLine('P-T20만', ids)], ['P-T20']);
  assert.deepEqual([...idsInLine('NFR-001과 useExtendHold, HOT-0701', ids)], []);
  assert.deepEqual([...idsInLine('api.extendHold(x) // HOT-070이', ids)], ['extendHold', 'HOT-070']);
  assert.deepEqual([...idsInLine('FR-002~004 범위', ids)], ['FR-003']);
});

// ---------- operationId ----------
test('계약 작업: openapi operationId(따옴표도)와 proto rpc 이름을 읽고, 단계 줄의 낱말과 같은 것만 ID로 쓴다', () => {
  const ops = operationIds(OPENAPI);
  assert.deepEqual([...ops].sort(), ['createPayment', 'extendHold']);
  assert.deepEqual([...rpcNames(PROTO)], ['CreateAttempt']);
  assert.deepEqual(stepRefs([stepText('HOT-070'), stepText('HOT-071')], new Set([...ops, ...rpcNames(PROTO)])).operations, ['extendHold', 'CreateAttempt']);
  const refs = stepRefs([stepText('HOT-070'), stepText('HOT-071')], ops);
  assert.deepEqual(refs.operations, ['extendHold']);
  assert.deepEqual(refs.reqs, ['FR-003', 'POL-001']);
  assert.deepEqual(refs.screens, ['SCR-012']);
  assert.deepEqual(refs.adrs, ['ADR-0184']);
  assert.deepEqual(refs.tests, ['P-T2', 'V-T3']);
  const sec = section(brief('BAT-010'), '4.');
  assert.match(sub(sec, 'extendHold'), /^### extendHold — 계약 작업 · 2곳$/m);
  assert.deepEqual(entries(sub(sec, 'extendHold')), [
    `- docs/api/openapi.yaml:${lineOf(OPENAPI, 'operationId: extendHold')} — paths › /v1/holds/{holdId}/extensions › post`,
    `- docs/features/payment.md:${lineOf(PAYMENT, '연장은')} — 2.1 홀드 연장`,
  ]);
  assert.match(sub(sec, 'CreateAttempt'), /^### CreateAttempt — 계약 작업 · 1곳$/m);
  assert.deepEqual(entries(sub(sec, 'CreateAttempt')), ['- docs/api/proto/peaket/payment/v1/payment.proto:5 — rpc CreateAttempt']);
  assert.doesNotMatch(sec, /createPayment/);
});

// ---------- 절 범위 ----------
test('docs/…md §N 절: 그 번호로 시작하는 첫 제목부터 같거나 높은 단계의 다음 제목 앞까지(끝 빈 줄 뺌). 펜스 속 제목·없는 절은 고르지 않는다', () => {
  assert.deepEqual(sectionRange(PAYMENT, '2.1'), { start: lineOf(PAYMENT, '### 2.1'), end: lineOf(PAYMENT, '```', 2), title: '2.1 홀드 연장', level: 3 });
  assert.deepEqual(sectionRange(PAYMENT, '2'), { start: lineOf(PAYMENT, '## 2. 흐름'), end: lineOf(PAYMENT, '결제 화면은'), title: '2. 흐름', level: 2 });
  assert.deepEqual(sectionRange(ARCH, '8'), { start: 3, end: lineOf(ARCH, '끝.'), title: '8. 품질·보안 절차', level: 2 });
  assert.deepEqual(sectionRange(ARCH, '8.6'), { start: 5, end: lineOf(ARCH, '2. **다음**'), title: '8.6 기능 묶음', level: 3 });
  assert.equal(sectionRange(PAYMENT, '2.9'), null);
  assert.equal(sectionRange(PAYMENT, '7'), null);
  assert.equal(sectionRange(PAYMENT, '9.1'), null);
  // 번호 경계: '1'은 '1인 …'에, '1.1'은 '1.10'에 걸리지 않는다
  const T = '# 문서\n\n## 1인 1순번 설계\n\n글\n\n## 1. 개요\n\n### 1.10 덧\n\n글\n\n### 1.1 첫\n\n끝\n';
  assert.equal(sectionRange(T, '1').title, '1. 개요');
  assert.equal(sectionRange(T, '1.1').title, '1.1 첫');
  assert.deepEqual(stepRefs([stepText('HOT-070'), stepText('HOT-071')]).sections, [
    { doc: 'docs/features/payment.md', num: '2.1' },
    { doc: 'docs/architecture.md', num: '8' },
    { doc: 'docs/architecture.md', num: '8.6' },
    { doc: 'docs/features/payment.md', num: '7' },
  ]);
  const text = brief('BAT-010');
  assert.deepEqual(entries(sub(section(text, '4.'), '단계 줄이 가리킨 절')), [
    `- docs/features/payment.md:${lineOf(PAYMENT, '### 2.1')}–${lineOf(PAYMENT, '```', 2)} — 2.1 홀드 연장`,
    `- docs/architecture.md:3–${lineOf(ARCH, '끝.')} — 8. 품질·보안 절차`,
    `- docs/architecture.md:5–${lineOf(ARCH, '2. **다음**')} — 8.6 기능 묶음`,
  ]);
  assert.match(section(text, '알림'), /docs\/features\/payment\.md §7: 절을 찾지 못했다/);
});

// ---------- 코드 자리 ----------
test('코드 자리: git grep으로 코드 폴더만 찾고(node_modules·dist·.next·gen/, tools/ci 시험 자료 뺌) ID 경계를 다시 보며 파일별 줄 수로 적는다', () => {
  const sec = section(brief('BAT-010'), '5.');
  // 단계·범위 칸·단계 줄의 ID가 있는 파일이 앞이고, 그 안에서 줄이 많은 차례다
  assert.deepEqual(entries(sec), [
    '- services/purchase-svc/src/hold.ts — 2줄: HOT-070, extendHold (1, 2)',
    '- services/purchase-svc/src/long.ts — 2줄: P-T20 (1, 2)',
    '- apps/web/src/pay.tsx — 1줄: SCR-012 (1)',
    '- packages/ds/src/button.tsx — 1줄: HOT-071 (1)',
    '- services/purchase-svc/test/hold.test.ts(시험) — 1줄: P-T2 (1)',
    '- tools/ci/real.mjs — 1줄: HOT-070 (1)',
    '- services/purchase-svc/src/approve.ts — 3줄: P-T1 (1, 2, 3)',
  ]);
  assert.match(sec, /파일 7개·줄 11개/);
});

test('코드 자리: 파일 40개를 넘으면 앞 40개와 외 N개', () => {
  const e = entries(section(brief('BAT-020'), '5.'));
  assert.equal(e.length, 41);
  assert.equal(e[0], '- services/queue-svc/src/f01.ts — 1줄: HOT-080 (1)');
  assert.equal(e.at(-1), '- 외 5개 파일(5줄)');
});

// ---------- CI 잡 ----------
test('CI 잡: 영역마다 그 영역을 보는 잡을 고르고, 통합 시험이 있는 서비스·web 범위·node 전체를 알린다', () => {
  const r = ciJobs([
    { path: 'apps/web/src/a.tsx', kind: 'code', count: 2 },
    { path: 'apps/web/queue-room/src/b.ts', kind: 'code', count: 1 },
    { path: 'packages/ds/src/c.tsx', kind: 'code', count: 1 },
    { path: 'packages/seatmap/src/d.ts', kind: 'code', count: 1 },
    { path: 'services/purchase-svc/src/e.ts', kind: 'code', count: 3 },
    { path: 'services/purchase-svc/test-int/seat-model/f.ts', kind: 'code', count: 1 },
    { path: 'services/v0-monolith/src/g.ts', kind: 'code', count: 1 },
    { path: 'services/README.md', kind: 'code', count: 1 },
    { path: 'tools/ci/h.mjs', kind: 'code', count: 1 },
    { path: 'loadtest/k6/i.js', kind: 'code', count: 1 },
    { path: 'specs/seat.qnt', kind: 'code', count: 1 },
    { path: 'docs/api/openapi.yaml', kind: 'doc', count: 4 },
    { path: 'docs/features/payment.md', kind: 'doc', count: 5 },
    { path: 'docs/frontend.md', kind: 'doc', count: 1 },
  ]);
  const jobs = (area) => r.rows.find((x) => x.area === area)?.jobs;
  assert.deepEqual(jobs('apps/web'), ['web / budgets', 'web / seed-css', 'node / node']);
  assert.deepEqual(jobs('apps/web/queue-room'), ['web / queue-room', 'web / visual', 'web / budgets', 'node / node']);
  assert.deepEqual(jobs('packages/ds'), ['web / tokens', 'web / visual', 'web / ds', 'node / node']);
  assert.deepEqual(jobs('packages/seatmap'), ['web / seatmap-pkg', 'node / node']);
  assert.deepEqual(jobs('services/purchase-svc'), ['node / node', 'contract-check / contracts', 'spec-check / spec']);
  assert.deepEqual(jobs('services/v0-monolith'), ['node / node', 'contract-check / contracts', 'kind / kind', 'image / build']);
  // 둘째 마디가 파일이면 첫 마디가 영역이고, 문서 점검이 읽는 .md·.yaml·.json·.csv는 docs-check도 돈다
  assert.deepEqual(jobs('services'), ['node / node', 'contract-check / contracts', 'docs-check / docs']);
  assert.deepEqual(jobs('tools/ci'), ['tools-check / tools']);
  assert.deepEqual(jobs('loadtest'), ['loadtest-check / loadtest']);
  assert.deepEqual(jobs('specs'), ['spec-check / spec']);
  assert.deepEqual(jobs('docs/api'), ['contract-check / contracts', 'docs-check / docs', 'node / node']);
  assert.deepEqual(jobs('docs'), ['docs-check / docs']);
  assert.deepEqual(jobs('docs/frontend.md'), ['web / budgets', 'docs-check / docs']);
  const purchase = r.rows.find((x) => x.area === 'services/purchase-svc');
  assert.equal(purchase.code, 4);
  assert.match(purchase.extra, /@peaket\/purchase-svc test:integration/);
  assert.equal(r.rows.find((x) => x.area === 'services/v0-monolith').extra, '');
  assert.ok(r.notes.some((n) => /ci-web\.yml의 잡 아홉/.test(n)));
  assert.ok(r.notes.some((n) => /node \/ node는 .*전체/.test(n)));
  // 지시서: 6절 표
  const sec = section(brief('BAT-010'), '6.');
  assert.match(sec, /^\| services\/purchase-svc \| 코드 8줄\(파일 4개\) \| node \/ node · contract-check \/ contracts \| 통합 시험 `pnpm --filter @peaket\/purchase-svc test:integration` \|$/m);
  assert.match(sec, /^\| apps\/web \| 코드 1줄\(파일 1개\) \| web \/ budgets · web \/ seed-css · node \/ node \|/m);
  assert.match(sec, /^\| docs\/api \| 정본 \d+곳 \| contract-check \/ contracts · docs-check \/ docs · node \/ node \|/m);
  assert.match(sec, /^- node \/ node \(ci-node\.yml\): /m);
});

test('CI 잡 표의 잡 이름이 실제 워크플로에 있고, 통합 시험 패키지 목록이 ci-node.yml과 같다', () => {
  const wf = (f) => readFileSync(join(ROOT, '.github/workflows', f), 'utf8').replaceAll('\r\n', '\n');
  const ci = wf('ci.yml');
  for (const [label, { file }] of Object.entries(JOBS)) {
    const [caller, job] = label.split(' / ');
    assert.match(ci, new RegExp(`^  ${caller}:\\n(?:(?:    .*)?\\n)*?    uses: \\./\\.github/workflows/${file.replaceAll('.', '\\.')}$`, 'm'), `${label}: ci.yml의 ${caller} 잡이 ${file}을 부르지 않는다`);
    assert.match(wf(file), new RegExp(`^  ${job}:$`, 'm'), `${label}: ${file}에 ${job} 잡이 없다`);
  }
  const ints = [...wf('ci-node.yml').matchAll(/pnpm --filter @peaket\/([\w-]+) test:integration/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(ints)].sort(), [...INT_PACKAGES].sort());
});

// ---------- 자주 놓친 결함 ----------
test('자주 놓친 결함: 목록 줄과 더 깊이 들여 쓴 줄을 그대로(들여쓰기만 덜어) 뽑고, 표 안의 언급은 고르지 않는다. 목록이 없으면 끝 코드 2', () => {
  assert.deepEqual(missedDefects(ARCH), { start: 13, end: 15, text: DEFECTS });
  assert.equal(missedDefects("# 설계\n\n| 3. 구현 | 아래 '자주 놓친 결함'을 넣는다 |\n"), null);
  const sec = section(brief('BAT-010'), '7.');
  assert.ok(sec.includes(DEFECTS));
  assert.match(sec, /docs\/architecture\.md:13–15 — 8\.6 기능 묶음/);
  const r = run(fixture({ 'docs/architecture.md': '# 설계\n' }), '--batch', 'BAT-010');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /자주 놓친 결함/);
  assert.equal(r.stdout, '');
});

test('읽기 규칙은 고정 글 세 줄이다', () => {
  const e = entries(section(brief('BAT-010'), '8.'));
  assert.equal(e.length, 3);
  assert.match(e[0], /grep -n.*sed -n 'A,Bp'.*offset·limit/);
  assert.match(e[1], /BUILD_ORDER.*docs\/review\/ledger\//);
  assert.match(e[2], /git diff/);
});

// ---------- 크기 ----------
test('6만 자를 넘으면 3·4·5를 줄여 상한 안에 넣고 줄인 것을 끝에 적는다(항목 이름과 정본 자리의 문서 경로·줄 번호는 남긴다)', () => {
  const rows = Array.from({ length: 320 }, (_, k) => `| P-T${k + 1} | 시나리오 ${k + 1} | 방법 | ${'판정 기준 글 '.repeat(50)}${k + 1} | FR-001 |`);
  const big = `# 결제\n\n## 9. 시험\n\n| # | 테스트 시나리오 | 검증 방법 | 합격 판정 기준 | 연결 요구사항 |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`;
  const r = run(fixture({ 'docs/features/payment.md': big }), '--batch', 'BAT-010');
  assert.equal(r.status, 0, r.stderr);
  assert.ok([...r.stdout].length <= MAX_CHARS, `${[...r.stdout].length}자`);
  assert.equal(MAX_CHARS, 60000);
  const cut = section(r.stdout, '줄임');
  assert.match(cut, /6만 자/);
  assert.ok(entries(cut).length >= 1);
  const three = section(r.stdout, '3.');
  for (let k = 1; k <= 320; k++) assert.match(three, new RegExp(`(?:^\\| |: |, )P-T${k}(?: \\||,|$)`, 'm'), `P-T${k}`);
  const four = section(r.stdout, '4.');
  assert.match(four, new RegExp(`P-T320\\*\\* 시험 1곳: docs/features/payment\\.md:${6 + 320}`));
});

// ---------- 명령줄 ----------
test('--out은 파일에 쓰고 요약 한 줄을 찍는다. 표준 출력과 같은 글이다', () => {
  const out = join(tempDir('brief-out-'), 'sub', 'BAT-010.md');
  const r = run(sharedDir(), '--batch', 'BAT-010', '--out', out);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(out, 'utf8'), brief('BAT-010'));
  assert.match(r.stdout, /BAT-010: .*BAT-010\.md — [\d,]+자, 판정 항목 7개, 정본 자리 \d+곳\(ID 13개\), 코드 파일 7개/);
});

test('끝 코드 2: 없는 묶음, 단계 줄이 없는 단계, --batch 없음, 모르는 인자', () => {
  const dir = sharedDir();
  const none = run(dir, '--batch', 'BAT-999');
  assert.equal(none.status, 2);
  assert.match(none.stderr, /BAT-999/);
  assert.equal(none.stdout, '');
  const noStep = run(dir, '--batch', 'BAT-030');
  assert.equal(noStep.status, 2);
  assert.match(noStep.stderr, /HOT-099/);
  assert.equal(run(dir).status, 2);
  assert.equal(run(dir, '--batch').status, 2);
  assert.equal(run(dir, '--batch', 'BAT-010', '--nope').status, 2);
});
