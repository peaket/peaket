// F-11-2 표본 검토 마감 기록과 봇 블로그 초안의 정적 시험.
// 실행: node --test tools/ci/f11-2-docs.test.mjs
//
// 제품 동작이 없는 문서 기능이라 실행 시험 대신 내용 검사로 증명한다.
// B등급의 '틀린 구현 표본'은 실행 코드 대신 틀린 초안 표본 10개로 대신한다.
// 표본은 검사기 안에서 문자열을 망가뜨려 만들고, 실제 문서는 건드리지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RECORD = 'docs/review/measurements/F-11-2-bot-sample-review.md';
const BLOG = 'docs/blog/m3-bot-evaluation.md';
const README = 'docs/blog/README.md';

const read = (relative) => readFileSync(join(REPO, relative), 'utf8');
const linesOf = (text) => text.split(/\r?\n/);

function headings(text) {
  return linesOf(text)
    .filter((line) => /^#{2,4}\s/.test(line))
    .map((line) => line.replace(/^#+\s*/, '').trim());
}

function hasHeading(text, keyword) {
  return headings(text).some((heading) => heading.includes(keyword));
}

// 키워드가 든 절의 본문을 다음 같은 높이(또는 더 높은) 제목 전까지 돌려준다.
function section(text, keyword) {
  const lines = linesOf(text);
  const start = lines.findIndex((line) => /^#{2,4}\s/.test(line) && line.includes(keyword));
  if (start < 0) return '';
  const level = lines[start].match(/^#+/)[0].length;
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const match = lines[i].match(/^(#{1,6})\s/);
    if (match && match[1].length <= level) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

function missingTokens(text, tokens) {
  return tokens.filter((token) => !text.includes(token));
}

// `%`나 `퍼센트`가 있는 줄은 목표·상한·하한·구간·정본·[가정] 가운데 하나를 같은 줄에 둔다.
// 측정하지 않은 비율을 실측처럼 쓰는 것을 막는다.
const PERCENT_MARKERS = ['목표', '상한', '하한', 'Wilson', '구간', '정본', '[가정]', '비율'];

function percentLinesWithoutMarker(text) {
  return linesOf(text).filter(
    (line) => (line.includes('%') || line.includes('퍼센트')) && !PERCENT_MARKERS.some((marker) => line.includes(marker)),
  );
}

// 숫자 뒤에 성과 동사가 붙는 문장을 막는다. 금지 문장을 인용한 줄은 예외로 둔다.
function performanceClaims(text) {
  const claim = /달성했다|달성하였다|달성함|지켰다|넘었다|통과했다|마쳤다|절반으로/;
  const exempt = /쓰지 않는다|금지|아니다|말하지 않는다|주장하지 않는다|재지 못/;
  return linesOf(text).filter((line) => claim.test(line) && !exempt.test(line));
}

// 측정하지 않은 수치를 새로 주장하는 줄을 찾는다. 같은 줄에 미측정·금지·보류 표시가 있으면 설명으로 본다.
function numberClaimLines(text, patterns) {
  const context = ['재지', '재지 못', '주장하지', '미측정', '보류', '금지', '동결', '측정하지 않'];
  return linesOf(text).filter(
    (line) => patterns.some((pattern) => pattern.test(line)) && !context.some((word) => line.includes(word)),
  );
}

function measuredValueLines(text) {
  const value = [
    /(탐지율|오탐률|봇 점유율)\s*(은|는|이|가)?\s*[0-9]/,
    /[0-9]+(\.[0-9]+)?\s*(%|퍼센트)/,
    /(상한|목표)을?\s*(지켰|넘었|통과했)/,
    /검토를 모두 마쳤|마쳤다/,
    /절반으로|절반이/,
  ];
  return linesOf(text).filter(
    (line) => value.some((pattern) => pattern.test(line)) && !PERCENT_MARKERS.some((marker) => line.includes(marker)),
  );
}

function checklistRows(text) {
  return linesOf(section(text, '마감 체크리스트')).filter((line) => /^\|\s*\d+\s*\|/.test(line));
}

function numberTableRows(text, keyword) {
  const rows = linesOf(section(text, keyword)).filter((line) => /^\|/.test(line) && !/^\|\s*-+/.test(line));
  return rows.slice(1);
}

function validateNumberTable(text, keyword) {
  const errors = [];
  const rows = numberTableRows(text, keyword);
  if (rows.length === 0) errors.push(`${keyword}의 숫자 행이 없다`);
  for (const row of rows) {
    const cells = row.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 3) {
      errors.push(`숫자 행의 칸이 모자란다: ${row.trim()}`);
      continue;
    }
    if (!/docs\/|§|NFR-|ADR-|https?:/.test(cells[2])) errors.push(`숫자 행에 정본 자리가 없다: ${row.trim()}`);
  }
  return errors;
}

// 실제 값처럼 보이는 개인정보·가명이 문서에 들어가지 않았는지 본다. 필드 이름은 보지 않는다.
function piiFindings(text) {
  const patterns = [
    ['UUID', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
    ['이메일', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
    ['전화번호', /\b01[016789][- ]?\d{3,4}[- ]?\d{4}\b/],
    ['기기 가명', /\bk\d\.[A-Za-z0-9_-]{40,}\b/],
    ['세션 가명', /\bsess-[A-Za-z0-9-]{8,}\b/],
  ];
  const findings = [];
  for (const line of linesOf(text)) {
    for (const [label, pattern] of patterns) {
      if (pattern.test(line)) findings.push(`${label}: ${line.trim()}`);
    }
  }
  return findings;
}

function validateK6Lines(text) {
  const errors = [];
  for (const line of linesOf(text)) {
    if (/\bK6\b/.test(line) && !/못|재지|동결|없|미실행/.test(line)) errors.push(`K6를 실측처럼 쓴 줄: ${line.trim()}`);
    if (line.includes('F-11-1') && !/못|재지|동결|없|미실행/.test(line)) errors.push(`F-11-1을 실측처럼 쓴 줄: ${line.trim()}`);
  }
  return errors;
}

const FORBIDDEN_NUMBERS = [/30,000/, /30000/, /\b30k\b/, /100만/, /1,000,000/, /\bK1\b/, /\bK2\b/, /\bK7\b/, /Q-T20/, /Q-T57/, /Q-T58/];

function validateMeasurement(text) {
  const errors = [];
  for (const keyword of ['상태', '표본 선택', 'fp_review.csv 행 매핑', '검토자', '판정', '보존', '마감 체크리스트', '수치와 한계', '숫자 표', '경계와 하지 않은 것', '출처']) {
    if (!hasHeading(text, keyword)) errors.push(`${keyword} 절이 없다`);
  }
  const missing = missingTokens(text, [
    'PASSED_SAMPLE',
    'HUMAN_BASELINE',
    '200건',
    '[가정]',
    '무작위',
    '가림',
    '가림 미완',
    '중복',
    'UNDECIDED',
    '30일',
    '7일',
    'R2',
    'ApplyLabel',
    'review_batch',
    'applied_verdict',
    'verdict_event_key',
    'cs_agent',
    'cs_lead',
    'F-11-1',
    'K6',
    '절차 마감·판정 보류',
    '검토 완료가 아니다',
    'pass',
    'shadow_challenge',
    'fp_review.csv',
    'seed',
    'population',
    'ORDER BY rand()',
    '재현',
    '표본 밖',
    '20건',
    '한 사람만 기록',
    '503',
    'FRAUD_ACTIONED',
    '410',
    'retention-ended',
    'F-11-3',
    'F-04-18',
    '원장 적재 주인',
    '미정',
    'bot_sample_review',
    'BOT-080',
    '표본 배정 대기',
    'CONFIRMED_SIGNAL',
    'SHARED_DEVICE_OR_PAYMENT',
    'POST_LABEL',
    'VERIFICATION_FAILED',
    'riskBand',
    'behaviorSummaryBand',
    'evidenceRequired',
    'reviewKind',
    'OTHER',
    '15줄',
    '검토자 목록',
    '이해관계',
  ]);
  for (const token of missing) errors.push(`${token}가 없다`);
  if (/검토 완료했다|검토를 완료했다|판정 완료했다|마감 완료/.test(text)) errors.push('검토·판정을 완료했다고 읽히는 문장이 있다');
  if (!text.includes('검토 완료가 아니다')) errors.push('검토 완료가 아니라는 문장이 없다');
  const rows = checklistRows(text);
  if (rows.length !== 15) errors.push(`마감 체크리스트가 15줄이 아니다: ${rows.length}줄`);
  errors.push(...validateNumberTable(text, '숫자 표'));
  for (const line of percentLinesWithoutMarker(text)) errors.push(`표시 없는 비율: ${line.trim()}`);
  for (const line of performanceClaims(text)) errors.push(`성과 문장: ${line.trim()}`);
  for (const line of numberClaimLines(text, FORBIDDEN_NUMBERS)) errors.push(`주장하면 안 되는 수치: ${line.trim()}`);
  for (const line of measuredValueLines(text)) errors.push(`측정값으로 읽히는 수치: ${line.trim()}`);
  for (const line of linesOf(text)) {
    if (line.includes('실측') && !line.includes('없') && !line.includes('미측정') && !line.includes('아니다')) {
      errors.push(`실측값처럼 읽히는 줄: ${line.trim()}`);
    }
  }
  errors.push(...validateK6Lines(text));
  errors.push(...piiFindings(text).map((finding) => `개인정보·가명 의심: ${finding}`));
  return errors;
}

function validateBlog(text) {
  const errors = [];
  for (const keyword of ['여는 질문', '무엇을 만들었나', '무엇을 재려 했나', '이번에 잰 것', '어떻게 재면', '사람을 막지 않는다는 뜻', '한계', '숫자 표', '참고한 정본']) {
    if (!hasHeading(text, keyword)) errors.push(`${keyword} 절이 없다`);
  }
  const missing = missingTokens(text, [
    'F-11-1',
    'K6',
    '재지 못',
    '미측정',
    '200건',
    '[가정]',
    '30일',
    '7일',
    'R2',
    'UNDECIDED',
    'Wilson',
    '0.5%',
    '95%',
    '5%',
    'BehaviorScore',
    'NFR-022',
    '§19',
    '§5.2',
    '숫자',
    '표시',
    '정본',
  ]);
  for (const token of missing) errors.push(`${token}가 없다`);
  for (const keyword of ['대여 명의', '행동 요약', '기기 식별값', '허니팟', '축소 운영', '공용 기기', '하한', '첫 온세일']) {
    if (!text.includes(keyword)) errors.push(`한계 항목이 없다: ${keyword}`);
  }
  errors.push(...validateNumberTable(text, '숫자 표'));
  for (const line of percentLinesWithoutMarker(text)) errors.push(`표시 없는 비율: ${line.trim()}`);
  for (const line of performanceClaims(text)) errors.push(`성과 문장: ${line.trim()}`);
  for (const line of numberClaimLines(text, FORBIDDEN_NUMBERS)) errors.push(`주장하면 안 되는 수치: ${line.trim()}`);
  for (const line of measuredValueLines(text)) errors.push(`측정값으로 읽히는 수치: ${line.trim()}`);
  for (const line of linesOf(text)) {
    if (line.includes('실측') && !line.includes('없') && !line.includes('미측정') && !line.includes('아니다')) {
      errors.push(`실측값처럼 읽히는 줄: ${line.trim()}`);
    }
  }
  errors.push(...validateK6Lines(text));
  errors.push(...piiFindings(text).map((finding) => `개인정보·가명 의심: ${finding}`));
  if (!/^\|\s*숫자\s*\|.*표시.*정본/m.test(text)) errors.push('숫자 표의 머리(숫자·표시·정본)가 없다');
  return errors;
}

function validMeasurement() {
  return [
    '# F-11-2 표본 검토 마감 기록(시험 표본)',
    '',
    '## 1. 상태',
    '상태: 절차 마감·판정 보류. 이 기록은 검토 완료가 아니다.',
    '',
    '## 2. 표본 선택',
    'PASSED_SAMPLE은 첫째 묶음만 200건 [가정], HUMAN_BASELINE은 두 묶음을 섞어 200+200건 [가정]이다.',
    '뽑기는 ORDER BY rand()라 재현할 수 없고, seed는 섞기 순서만 재현한다. population을 남긴다. 무작위 정렬이다.',
    'HUMAN_BASELINE 가림은 완료이고 PASSED_SAMPLE 가림 미완이다. PASSED_SAMPLE은 riskBand·behaviorSummaryBand를 보여 주고 reviewKind로 첫째 묶음이 드러난다. 두 배치의 중복을 기록한다.',
    '',
    '### 2.1 fp_review.csv 행 매핑',
    '| fp_review.csv batch | 어느 배치·묶음 | unsure 셈 |',
    '| --- | --- | --- |',
    '| pass | PASSED_SAMPLE의 PASSED 묶음 | 사람 아님 |',
    '| shadow_challenge | HUMAN_BASELINE의 SHADOW_CHALLENGED 묶음 | 사람 |',
    '',
    '## 3. 검토자',
    '검토자는 cs_agent·cs_lead 가운데 검토자 목록과 이해관계를 확인한 사람이다.',
    '교차 확인은 표본 밖 20건을 함께 보고 한 사람만 기록한다.',
    '',
    '## 4. 판정',
    'HUMAN·BOT·UNDECIDED 셋이다. ApplyLabel에 review_batch·applied_verdict·verdict_event_key를 싣는다.',
    '봇 근거는 CONFIRMED_SIGNAL·SHARED_DEVICE_OR_PAYMENT·POST_LABEL·VERIFICATION_FAILED이고, OTHER 하나만으로는 붙이지 않는다(추천 적용).',
    'PASSED_SAMPLE은 BOT 근거 0개로도 200이고, evidenceRequired는 HUMAN_BASELINE에만 걸린다(BOT-080 잔여).',
    '',
    '## 5. 보존',
    '후보 원장은 30일 [가정], R2는 7일 [가정]이고 410 retention-ended로 막는다.',
    'FRAUD_ACTIONED가 올린 키는 표본 HUMAN이 지우지 않는다. ApplyLabel 실패는 503이다.',
    '',
    '## 6. 마감 체크리스트',
    '체크리스트 15줄이다.',
    '| # | 확인할 것 | 상태 |',
    '| --- | --- | --- |',
    '| 1 | 회차 | 미완 |',
    '| 2 | 배치 | 미완 |',
    '| 3 | 원장 적재 주인 미정 | 미완 |',
    '| 4 | 표본 수 | 미완 |',
    '| 5 | 뽑기·seed | 미완 |',
    '| 6 | 가림 미완 | 미완 |',
    '| 7 | 검토자 | 미완 |',
    '| 8 | 판정 | 미완 |',
    '| 9 | 근거 | 미완 |',
    '| 10 | UNDECIDED | 미완 |',
    '| 11 | ApplyLabel | 미완 |',
    '| 12 | fp_review.csv | 미완 |',
    '| 13 | R2 | 미완 |',
    '| 14 | 수치 | 확인 |',
    '| 15 | 중복 | 미완 |',
    '',
    '## 7. 수치와 한계',
    'F-11-1 K6는 미실행·재지 못했다. 실측값 없음.',
    '### 숫자 표',
    '| 숫자 | 표시 | 정본 |',
    '| --- | --- | --- |',
    '| 200건 | [가정] | docs/features/bot-defense.md §13 |',
    '| 30일 | [가정] | docs/features/bot-defense.md §14 |',
    '| 7일 | [가정] | docs/perf-ledger.md §10.6 |',
    '| 20건 | [가정] | docs/features/bot-defense.md §13 |',
    '',
    '## 8. 경계와 하지 않은 것',
    'F-11-3과 F-04-18은 이 기능 범위 밖이다. bot_sample_review 적재 주인은 미정이고 BOT-080은 표본 배정 대기다.',
    '',
    '## 9. 출처',
    'docs/features/bot-defense.md §13, docs/perf-ledger.md §10.6',
    '',
  ].join('\n');
}

function validBlog() {
  return [
    '# 봇 평가 통계 — 사람을 막지 않으면서 봇을 줄였나',
    '',
    '## 1. 여는 질문',
    '사람을 막지 않으면서 봇을 줄였나.',
    '',
    '## 2. 무엇을 만들었나',
    'trust-svc와 BehaviorScore를 만들었다. NFR-022가 설계 목표다.',
    '',
    '## 3. 무엇을 재려 했나',
    'F-11-1 K6는 재지 못했다. 표본은 200건 [가정], 보존은 30일 [가정], R2는 7일 [가정]이다.',
    'Wilson 95% 구간은 방법이고, 설계 목표는 0.5% 상한과 95% 목표다.',
    '봇 점유율 5% 목표는 docs/features/bot-defense.md §19와 docs/planning/01-overview.md §5.2에 있다.',
    '',
    '## 4. 이번에 잰 것',
    '미측정이다. 실측 없음.',
    '',
    '## 5. 어떻게 재면 답하나',
    'UNDECIDED를 보수적으로 세고, 무작위로 섞고, 가림을 지킨다.',
    '',
    '## 6. 사람을 막지 않는다는 뜻',
    '차단이 아니라 추가 검증으로 보낸다.',
    '',
    '## 7. 한계',
    '대여 명의, 행동 요약, 기기 식별값, 허니팟, 축소 운영, 공용 기기, 하한, 첫 온세일.',
    '',
    '## 8. 숫자 표',
    '| 숫자 | 표시 | 정본 |',
    '| --- | --- | --- |',
    '| 200건 | [가정] | docs/features/bot-defense.md §13 |',
    '| 30일 | [가정] | docs/features/bot-defense.md §14 |',
    '| 7일 | [가정] | docs/perf-ledger.md §10.6 |',
    '| 20건 | [가정] | docs/features/bot-defense.md §13 |',
    '| 0.5% | 설계 목표 | NFR-022 |',
    '| 95% | 설계 목표 | NFR-022 |',
    '| 5% | 설계 목표 | docs/features/bot-defense.md §19 |',
    '',
    '## 9. 참고한 정본',
    'docs/features/bot-defense.md §13, docs/perf-ledger.md §10.6',
    '',
  ].join('\n');
}

test('F-11-2 ① 표본 검토 마감 기록이 표본·검토자·판정·보존을 담는다', () => {
  assert.ok(existsSync(join(REPO, RECORD)), `${RECORD}가 없다. 구현(문서) 단계에서 만든다.`);
  const text = read(RECORD);
  assert.match(text, /^# .*표본 검토.*마감/s, '제목에 표본 검토·마감이 없다');
  assert.deepEqual(validateMeasurement(text), []);
});

test('F-11-2 ② 봇 블로그 초안이 수치 주장 범위와 한계를 지킨다', () => {
  assert.ok(existsSync(join(REPO, BLOG)), `${BLOG}가 없다. 구현(문서) 단계에서 만든다.`);
  const text = read(BLOG);
  assert.match(text, /^# 봇 평가 통계 — 사람을 막지 않으면서 봇을 줄였나/m, '제목이 M3 제목과 다르다');
  assert.deepEqual(validateBlog(text), []);
});

test('F-11-2 ③ 블로그 목차의 M3 행이 초안을 가리킨다', () => {
  const row = linesOf(read(README)).find((line) => /^\|\s*8\s*\|\s*M3\s*\|/.test(line));
  assert.ok(row, 'docs/blog/README.md에 8번째 M3 행이 없다');
  assert.match(row, /\(m3-bot-evaluation\.md\)/, 'M3 행이 새 글을 가리키지 않는다');
  assert.match(row, /초안\(2026-11-26\)/, 'M3 행 상태가 초안(2026-11-26)이 아니다');
  assert.match(row, /게시 전/, 'M3 행 상태에 게시 전이 없다');
  assert.doesNotMatch(row, /보류\(측정 없음\)/, 'M3 행이 아직 보류(측정 없음)다');
  const title = row.match(/\[([^\]]+)\]/)?.[1];
  const blogTitle = read(BLOG).match(/^#\s+(.+)$/m)?.[1];
  assert.equal(blogTitle, title, '블로그 제목과 M3 행 제목이 다르다');
});

test('F-11-2 ④ 검사기는 틀린 표본 검토 기록 표본을 잡는다', () => {
  const good = validMeasurement();
  assert.deepEqual(validateMeasurement(good), []);

  const mutations = [
    ['보존 30일 삭제', good.replaceAll('30일', '기간'), '30일'],
    ['검토자 절 삭제', good.replace('## 3. 검토자', '## 3. 담당'), '검토자'],
    ['가림 삭제', good.replaceAll('가림', '표시'), '가림'],
    ['측정값 추가', `${good}\n오탐 0.3%를 확인했다.`, '비율'],
    ['마감 완료로 바꿈', good.replace('절차 마감·판정 보류', '마감 완료'), '절차 마감·판정 보류'],
  ];
  for (const [label, text, expected] of mutations) {
    const errors = validateMeasurement(text);
    assert.ok(errors.length > 0, `${label}: 검사기가 잡지 못했다`);
    assert.ok(errors.some((error) => error.includes(expected)), `${label}: 기대한 오류(${expected})가 없다: ${errors.join(' / ')}`);
  }
});

test('F-11-2 ⑤ 검사기는 틀린 블로그 표본을 잡는다', () => {
  const good = validBlog();
  assert.deepEqual(validateBlog(good), []);

  const mutations = [
    ['30,000건/초 주장', `${good}\n30,000건/초를 달성했다.`, '30,000'],
    ['100만 주장', `${good}\n100만 명이 몰렸다.`, '100만'],
    ['오탐률·탐지율 주장', `${good}\n오탐률은 0.3퍼센트였고 탐지율 95%를 넘었다.`, '퍼센트'],
    ['한계 절 삭제', good.replace('## 7. 한계', '## 7. 덧붙임'), '한계'],
    ['재지 못 삭제', good.replaceAll('재지 못', '쟀다'), '재지 못'],
  ];
  for (const [label, text, expected] of mutations) {
    const errors = validateBlog(text);
    assert.ok(errors.length > 0, `${label}: 검사기가 잡지 못했다`);
    assert.ok(errors.some((error) => error.includes(expected)), `${label}: 기대한 오류(${expected})가 없다: ${errors.join(' / ')}`);
  }
});
