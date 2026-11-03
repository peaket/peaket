// SCR-027 [부정 예매 조치] 탭(기획사 보고) 집계 모델 시험(OpenSpec apply-legal-review-to-screens tasks 4.1, design.md 결정 5).
// 앱에 시험 도구가 아직 없어 Node 내장 시험 실행기로 돌린다(`pnpm --filter @peaket/partner test`). 타입 지우기로 .ts를 그대로 읽는다.
// 기준: docs/design/d5 §6.10 '[부정 예매 조치]'와 상태 '부정 예매 집계 전'·'부정 예매 집계', openapi `PromoterFraudReport`·`FraudCountCell`과
// `GET /v1/partner/events/{eventId}/fraud-report`의 404 `fraud-report-not-ready`, docs/features/forensic-replay.md §6.7.7 '기획사 보고의 칸 합치기',
// FR-074, POL-046 ⑧(기획사에는 회차 집계만, 사람 단위 행 없음).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as fr from './fraud-report.ts';
import { SETTLEMENT_STATES } from '../../../shared/config/states/scr027.ts';

const {
  FRAUD_REPORT,
  FRAUD_REPORT_EMPTY,
  FRAUD_REPORT_INTRO,
  FRAUD_REPORT_NOT_READY,
  FRAUD_REPORT_FOOTNOTE,
  APPEAL_RATIO_HIDDEN,
  FRAUD_TILES,
  FRAUD_REASON_LABEL,
  countText,
  ratioText,
  asOfText,
  reasonRows,
} = fr;

/* ---------- 계약 원본(docs/api/openapi.yaml)에서 PromoterFraudReport를 읽는다 ---------- */

const OPENAPI = readFileSync(new URL('../../../../../../docs/api/openapi.yaml', import.meta.url), 'utf8');
const LINE = OPENAPI.split('\n').find((l) => /^\s+PromoterFraudReport: \{/.test(l));

/** 흐름 꼴 YAML 한 줄에서 `properties: { … }`의 첫 층 칸 이름을 읽는다(따옴표 안의 괄호는 건너뛴다) */
function topLevelKeys(line, from) {
  const start = line.indexOf('properties: {', from);
  assert.ok(start >= 0, 'properties가 없다');
  const keys = [];
  let depth = 0;
  let quote = null;
  let token = '';
  for (let i = start + 'properties: '.length; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '{' || c === '[') {
      depth++;
      token = '';
      continue;
    }
    if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) break;
      token = '';
      continue;
    }
    if (depth === 1 && c === ':') {
      const k = token.trim();
      if (k) keys.push(k);
      token = '';
      continue;
    }
    if (c === ',') {
      token = '';
      continue;
    }
    token += c;
  }
  return keys;
}

test('FR074_집계칸_openapi_PromoterFraudReport와_같은_이름이다', () => {
  assert.ok(LINE, 'openapi에 PromoterFraudReport가 없다');
  const keys = topLevelKeys(LINE, 0);
  assert.deepEqual(Object.keys(FRAUD_REPORT).sort(), [...keys].sort());
  assert.deepEqual(Object.keys(FRAUD_REPORT_EMPTY).sort(), [...keys].sort());
});

test('FR074_사유범주는_openapi_열거값_여섯(그_밖_포함)을_빠짐없이_덮는다', () => {
  const m = LINE.match(/category: \{ type: string, enum: \[([^\]]+)\]/);
  assert.ok(m, 'byReasonCategory.category 열거값이 없다');
  const enumValues = m[1].split(',').map((x) => x.trim());
  assert.deepEqual(Object.keys(FRAUD_REASON_LABEL).sort(), [...enumValues].sort());
  for (const row of FRAUD_REPORT.byReasonCategory) assert.ok(enumValues.includes(row.category), row.category);
});

/** 기획사에게 보이면 안 되는 사람 단위 칸 이름(계정·이름·연락처·좌석·주문·표 ID·점수) */
const PERSON_KEY = /account|name|phone|email|contact|seat|order|ticketId|score|weight|ip/i;
/** 좌석 번호·전화번호 꼴 글 */
const PERSON_TEXT = /\d+열 \d+번|01\d-\d{3,4}-\d{4}|@/;

function walk(value, path, visit) {
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`, visit));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) {
    visit(k, v, `${path}.${k}`);
    walk(v, `${path}.${k}`, visit);
  }
}

test('POL046_8_기획사_보고에는_사람_단위_칸이_없다', () => {
  for (const report of [FRAUD_REPORT, FRAUD_REPORT_EMPTY]) {
    walk(report, 'report', (k, v, p) => {
      assert.doesNotMatch(k, PERSON_KEY, p);
      if (typeof v === 'string') assert.doesNotMatch(v, PERSON_TEXT, p);
    });
  }
});

test('POL046_8_칸_합치기_목업은_1~4건을_보이지_않고_그_밖을_가리면_한_칸_더_가린다', () => {
  const cells = [
    FRAUD_REPORT.closedCaseCount,
    FRAUD_REPORT.cancelActionCount,
    FRAUD_REPORT.restrictActionCount,
    FRAUD_REPORT.cancelledTicketCount,
    FRAUD_REPORT.resoldAtFaceValueCount,
    ...FRAUD_REPORT.byReasonCategory.map((r) => r.count),
  ];
  for (const c of cells) {
    if (c.suppressed) assert.equal(c.value, null);
    else assert.ok(c.value === 0 || c.value >= 5, `보이는 칸 ${c.value}`);
  }
  const other = FRAUD_REPORT.byReasonCategory.find((r) => r.category === 'OTHER');
  assert.ok(other, '목업에 그 밖 칸이 있다');
  if (other.count.suppressed) {
    const hidden = FRAUD_REPORT.byReasonCategory.filter((r) => r.count.suppressed);
    assert.ok(hidden.length >= 2, '2차 가림: 그 밖과 그다음으로 작은 칸');
  }
  // 끝난 사건 합계에서 보이는 칸을 빼도 가린 칸 하나가 되살아나지 않는다
  const visibleSum = FRAUD_REPORT.byReasonCategory.filter((r) => !r.count.suppressed).reduce((s, r) => s + r.count.value, 0);
  const hiddenCount = FRAUD_REPORT.byReasonCategory.filter((r) => r.count.suppressed).length;
  assert.ok(FRAUD_REPORT.closedCaseCount.value - visibleSum >= 0);
  assert.notEqual(hiddenCount, 1);
});

test('FR074_고정_문구는_d5_§6.10_글_그대로다', () => {
  assert.equal(FRAUD_REPORT_INTRO, 'PEAKET이 이 회차의 부정 예매를 조사해 조치한 결과의 집계입니다. 개인을 알아볼 수 있는 정보는 없습니다.');
  assert.equal(FRAUD_REPORT_NOT_READY, '판매가 시작되고 1시간 뒤부터 집계합니다');
  assert.equal(FRAUD_REPORT_FOOTNOTE, '5건 미만인 칸과, 빼기로 그 칸을 알아낼 수 있는 칸은 가려 보입니다. 집계는 하루 한 번 바뀝니다');
  assert.equal(APPEAL_RATIO_HIDDEN, '5건 미만이라 보이지 않습니다');
});

test('FR074_타일_다섯은_d5_순서와_이름이다', () => {
  assert.deepEqual(
    FRAUD_TILES.map((t) => t.label),
    ['끝난 사건', '표 취소 조치', '이용 제한 조치', '취소한 표', '정가 재판매로 돌린 표'],
  );
  assert.deepEqual(
    FRAUD_TILES.map((t) => t.key),
    ['closedCaseCount', 'cancelActionCount', 'restrictActionCount', 'cancelledTicketCount', 'resoldAtFaceValueCount'],
  );
});

test('FR074_사유_범주_이름표는_POL046_1의_쉬운_말과_그_밖(합친_칸)이다', () => {
  assert.deepEqual(FRAUD_REASON_LABEL, {
    MACRO_BOT: '자동화 프로그램(매크로·봇)',
    QUEUE_BYPASS: '대기열 우회 링크',
    CAPTCHA_BYPASS: '보안문자 우회',
    ACCOUNT_LENDING: '명의 대여·사들인 계정',
    LIMIT_EVASION: '1인 매수 제한 회피',
    OTHER: '그 밖(합친 칸)',
  });
});

test('FR074_칸_글: 가린 칸은_가림, 0은_0, 그_밖은_천_단위_쉼표와_단위', () => {
  assert.equal(countText({ value: null, suppressed: true }, '건'), '가림');
  assert.equal(countText({ value: 0, suppressed: false }, '건'), '0건');
  assert.equal(countText({ value: 27, suppressed: false }, '장'), '27장');
  assert.equal(countText({ value: 1204, suppressed: false }, '장'), '1,204장');
});

test('FR074_소명_인정_비율: 분모가_5건_미만(null)이면_보이지_않고_아니면_백분율', () => {
  assert.equal(ratioText(null), '5건 미만이라 보이지 않습니다');
  assert.equal(ratioText(0.4), '40%');
  assert.equal(ratioText(1 / 3), '33%');
  assert.equal(ratioText(0), '0%');
  assert.equal(ratioText(1), '100%');
});

test('FR074_집계_시각은_KST로_적는다(하루_한_번_06:00)', () => {
  assert.equal(asOfText('2026-10-25T21:00:00Z'), '10/26(월) 06:00 KST');
  assert.equal(asOfText('2026-10-31T21:00:00.000Z'), '11/1(일) 06:00 KST');
  assert.equal(asOfText(FRAUD_REPORT.asOf), '10/26(월) 06:00 KST');
});

test('FR074_사유_범주_표는_여섯_줄을_정해진_순서로, 합친_범주는_그_밖에_합침이다', () => {
  const rows = reasonRows({
    byReasonCategory: [
      { category: 'MACRO_BOT', count: { value: 6, suppressed: false } },
      { category: 'CAPTCHA_BYPASS', count: { value: 0, suppressed: false } },
      { category: 'LIMIT_EVASION', count: { value: null, suppressed: true } },
      { category: 'OTHER', count: { value: null, suppressed: true } },
    ],
  });
  assert.deepEqual(rows, [
    { category: 'MACRO_BOT', label: '자동화 프로그램(매크로·봇)', text: '6건' },
    { category: 'QUEUE_BYPASS', label: '대기열 우회 링크', text: '그 밖에 합침' },
    { category: 'CAPTCHA_BYPASS', label: '보안문자 우회', text: '0건' },
    { category: 'ACCOUNT_LENDING', label: '명의 대여·사들인 계정', text: '그 밖에 합침' },
    { category: 'LIMIT_EVASION', label: '1인 매수 제한 회피', text: '가림' },
    { category: 'OTHER', label: '그 밖(합친 칸)', text: '가림' },
  ]);
});

test('FR074_끝난_사건이_없으면_타일_모두_0이고_비율은_보이지_않는다', () => {
  for (const t of FRAUD_TILES) assert.deepEqual(FRAUD_REPORT_EMPTY[t.key], { value: 0, suppressed: false }, t.key);
  assert.equal(FRAUD_REPORT_EMPTY.appealAcceptedRatio, null);
});

test('FR074_상태_목록에_d5_상태_표의_부정_예매_두_상태가_있다', () => {
  assert.ok(SETTLEMENT_STATES.includes('부정 예매 집계 전'));
  assert.ok(SETTLEMENT_STATES.includes('부정 예매 집계'));
});
