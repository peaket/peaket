// J-T42 ②③ SCR-027 '정산서' 탭 실제 판의 화면 모델과 배선(F-07-7 계획 §5.1(자)·I-09, ADR-0370 결정 9, d5 §6.10).
// 정본: docs/features/settlement.md §13 J-T42 ②③, docs/design/d5-screen-blueprint.md §6.10(결제사별 표·보류 사유 다섯·상태 표 '이의 기간 끝'·'KYC 예고').
// 시험이 정한 모양(계획 §5.1(자)에 함수 이름만 있어 시험 담당이 정함, 시험 리뷰가 본다):
//   settleStatementsView(raw[]) → { groups: [{ pg, title, items }], kycNotice, kycBanner }
//     groups는 토스페이먼츠 → 포트원 차례이고 정산서가 없는 결제사는 뺀다.
//     item = { statementId, storeTitle, statusText, holdReasonText, disputeDueText, payoutDateText, amounts: { gross, refund, commission, vat, offset, payout } }
//     날짜는 KST 'M/D(요일)'(d5 '이의 기간 끝 10/28(수)'·'지급 예정 10/30(금)'), 금액은 '₩1,234' 꼴.
//   disputeProblemMessage(problem) → 화면에 보일 글(string).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { disputeProblemMessage, settleStatementsView } from './settle-live.ts';

// d5 §6.10 'KYC 예고' 행의 info 배너 글(정본 원문)
const KYC_BANNER =
  '이번 지급으로 토스페이먼츠 결제분 지급이 7일 동안 1천만 원 이상이 될 수 있어, 결제사가 고객확인(KYC)을 요청할 수 있습니다. 결제사가 셀러 등록 이메일로 고객확인 신청서를 보내면 PC에서 바로 제출해 주세요(서류는 최근 3개월 안에 발급한 것). 고객확인은 미리 받을 수 없고, 요청이 오면 승인될 때까지 토스페이먼츠 결제분 지급이 보류됩니다.';

const statement = (over = {}) => ({
  statementId: 's-toss',
  kind: 'EVENT',
  eventId: 'e1',
  pg: 'TOSS',
  pgStore: 'STANDARD',
  grossAmount: 290_004_000,
  refundAmount: 2_464_000,
  commissionAmount: 28_754_000,
  commissionVat: 2_875_400,
  offsetAmount: 4_804_800,
  payoutAmount: 251_105_800,
  revision: 1,
  status: 'NOTIFIED',
  // 10/28(수) 23:59:59 KST
  disputeDueAt: '2026-10-28T14:59:59.000Z',
  payoutDate: '2026-10-30',
  kycNotice: false,
  ...over,
});
const portone = (over = {}) => statement({ statementId: 's-po', pg: 'PORTONE', pgStore: 'STANDARD', grossAmount: 22_880_000, refundAmount: 220_000, commissionAmount: 2_266_000, commissionVat: 226_600, offsetAmount: 0, payoutAmount: 20_167_400, ...over });

test('J-T42 ② 회차 정산서를 결제사별(토스페이먼츠 → 포트원)로 묶고 금액 항목을 원 단위로 보인다', () => {
  const v = settleStatementsView([portone(), statement()]);
  assert.deepEqual(
    v.groups.map((g) => [g.pg, g.title, g.items.map((i) => i.statementId)]),
    [
      ['TOSS', '토스페이먼츠', ['s-toss']],
      ['PORTONE', '포트원', ['s-po']],
    ],
  );
  assert.deepEqual(v.groups[0].items[0].amounts, {
    gross: '₩290,004,000',
    refund: '₩2,464,000',
    commission: '₩28,754,000',
    vat: '₩2,875,400',
    offset: '₩4,804,800',
    payout: '₩251,105,800',
  });
  assert.equal(v.groups[1].items[0].amounts.payout, '₩20,167,400');
});

test('J-T42 ② 정산서가 없는 결제사는 묶음을 만들지 않고 빈 목록은 빈 묶음이다', () => {
  assert.deepEqual(settleStatementsView([portone()]).groups.map((g) => g.pg), ['PORTONE']);
  assert.deepEqual(settleStatementsView([]).groups, []);
  assert.equal(settleStatementsView([]).kycNotice, false);
});

test('J-T42 ② 이의 기한·지급 예정일은 KST 날짜와 요일이다(UTC 날짜가 다른 경계 포함)', () => {
  const item = settleStatementsView([statement()]).groups[0].items[0];
  assert.equal(item.disputeDueText, '10/28(수)');
  assert.equal(item.payoutDateText, '10/30(금)');
  // UTC 10/28 15:00 = KST 10/29(목) 00:00
  assert.equal(settleStatementsView([statement({ disputeDueAt: '2026-10-28T15:00:00.000Z' })]).groups[0].items[0].disputeDueText, '10/29(목)');
});

test('J-T42 ② 보류 사유 다섯을 d5 §6.10의 말로 보이고 보류가 아니면 사유가 없다', () => {
  const text = (holdReason) => settleStatementsView([statement({ status: 'HELD', holdReason })]).groups[0].items[0].holdReasonText;
  assert.equal(text('KYC'), 'KYC 필요');
  assert.equal(text('ACCOUNT_CHANGE'), '계좌 변경 3영업일');
  assert.equal(text('BALANCE'), '잔액 부족');
  assert.equal(text('ACCOUNT_MISMATCH'), '포트원 계좌 불일치');
  assert.equal(text('SALE_SUSPENDED'), '판매 중지');
  assert.equal(settleStatementsView([statement()]).groups[0].items[0].holdReasonText, null);
});

test('J-T42 ② 상태는 통지됨·이의 처리 중 등 화면 말이다', () => {
  assert.equal(settleStatementsView([statement()]).groups[0].items[0].statusText, '통지됨');
  assert.equal(settleStatementsView([statement({ status: 'DISPUTED' })]).groups[0].items[0].statusText, '이의 처리 중');
});

test('J-T42 ② 토스페이먼츠 정산서의 kycNotice면 KYC 예고 배너(d5 원문)를 싣고, 포트원 kycNotice는 배너를 켜지 않는다', () => {
  const on = settleStatementsView([statement({ kycNotice: true }), portone()]);
  assert.equal(on.kycNotice, true);
  assert.equal(on.kycBanner, KYC_BANNER);
  const off = settleStatementsView([statement({ kycNotice: false }), portone({ kycNotice: true })]);
  assert.equal(off.kycNotice, false);
  assert.equal(off.kycBanner, null);
});

test('J-T42 ② 이의 409는 "이의 기간이 끝났습니다", 400·422는 그와 다른 입력 안내다', () => {
  const ended = disputeProblemMessage({ status: 409, type: 'settlement-dispute-window-closed', title: '이의 기간이 끝났습니다' });
  const bad = disputeProblemMessage({ status: 400, type: 'invalid-query', title: '정산 이의 사유 코드가 맞지 않습니다' });
  const noDetail = disputeProblemMessage({ status: 422, type: 'invalid-query', title: '기타 사유는 설명이 필요합니다' });
  assert.equal(ended, '이의 기간이 끝났습니다');
  assert.ok(noDetail.includes('설명'), noDetail);
  assert.equal(typeof bad, 'string');
  assert.ok(bad.length > 0);
  assert.equal(new Set([ended, bad, noDetail]).size, 3);
});

// ---- 배선(정적 소스 검사). 실제 판 자리는 계획 I-09 'SettleTab.tsx'와 ui/live/ 아래 Settle*.tsx ----
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const liveDir = new URL('../ui/live/', import.meta.url);
const liveFiles = existsSync(liveDir) ? readdirSync(liveDir).filter((f) => /Settle/.test(f) && /\.tsx?$/.test(f)) : [];
const live = liveFiles.map((f) => readFileSync(new URL(f, liveDir), 'utf8')).join('\n');
const tab = read('../ui/SettleTab.tsx');
const api = read('../../../shared/api/partner-live.ts');

test('J-T42 ② 정산서 탭 실제 판이 회차 정산서 읽기와 이의 제기(Idempotency-Key) 계약 함수만 부른다', () => {
  assert.ok(liveFiles.length > 0, 'settlement/ui/live/ 아래 정산서 탭 실제 판(Settle*.tsx)이 없다');
  assert.match(tab, /from '\.\/live\/Settle[A-Za-z]*'/);
  // listEventSettlements의 계약 호출은 shared/api/partner-live.test.mjs J-T42 ②가 본다
  assert.match(live, /\blistEventSettlements\b/);
  assert.match(live, /\bcreateSettlementDispute\b/);
  assert.match(api, /OPERATIONS\.createPartnerSettlementDispute,[\s\S]{0,120}?idempotencyKey: newIdempotencyKey\(\)/);
  assert.doesNotMatch(live, /\bfetch\s*\(/);
  assert.match(live, /settleStatementsView\(/);
  assert.match(live, /disputeProblemMessage\(/);
});

test('J-T42 ② 실무자는 이의 제기가 비활성이다', () => {
  assert.ok(liveFiles.length > 0, '실제 판 파일이 없어 이 검사가 빈 글을 본다');
  assert.match(live, /AdminOnly|aria-disabled/);
  assert.match(live, /isMember|partner_member/);
});

test('J-T42 ③ 정산서 탭 실제 판에는 목업 값이 0건이다(보드는 ?state= 미리보기에만)', () => {
  assert.ok(liveFiles.length > 0, '실제 판 파일이 없어 이 검사가 빈 글을 본다');
  // 목업 원천 가져오기와 목업 값만 금지한다(실제 판의 지역 변수 statements.map 같은 바른 코드는 막지 않는다, 시험 리뷰 TR-19)
  assert.doesNotMatch(live, /from '\.\.\/\.\.\/model\/settlement'|from '\.\.\/model\/settlement'|settleTotals|PAYOUT_HOLDS/);
  for (const mock of ['290,004,000', '251,105,800', '20,167,400', '10/30(금)', '10/28(수)', '10/25(일) 18:00 KST']) {
    assert.equal(live.includes(mock), false, `실제 판에 목업 값 ${mock}이 있다`);
  }
  // 배상 줄은 실제 판에서 그리지 않는다(F-07-8 몫)
  assert.doesNotMatch(live, /배상/);
});
