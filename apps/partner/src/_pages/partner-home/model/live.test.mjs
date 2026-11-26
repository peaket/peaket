// F-07-12 SCR-062 화면 값(파트너 홈·공연 목록). 정본: docs/design/d5 §6.2, docs/api/openapi.yaml
// PartnerProductionSummary·PartnerTodoSummary, docs/planning/03 POL-030·037.
// 목업이 아니라 API 요약을 화면 말로 바꾸는 순수 함수를 본다. 기준 트리에는 live.ts가 없어 각 시험이 실패한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const load = () => import('./live.ts');

const summary = (over = {}) => ({
  productionId: 'prod-1',
  title: 'LUMEN 콘서트 2026 서울',
  eventCount: 2,
  saleReview: 'APPROVED',
  hasApprovalHistory: true,
  rejectionReason: null,
  suspensionReasonCode: null,
  firstOpenAt: '2026-10-14T11:00:00.000Z',
  saleStatus: 'ON_SALE',
  pgPrimary: null,
  payoutHoldReason: null,
  ...over,
});

test('F-07-12 AC-05 UH-01 KST 시각은 M/D(요일) HH:mm KST로 그리고 없으면 —다', async () => {
  const { kstStamp, kstDate, kstDayText } = await import('../../../shared/lib/kst.ts');
  assert.equal(kstStamp('2026-10-14T11:00:00.000Z'), '10/14(수) 20:00 KST');
  assert.equal(kstStamp('2026-12-01T00:00:00.000Z'), '12/1(화) 09:00 KST');
  assert.equal(kstStamp(null), '—');
  assert.equal(kstStamp(undefined), '—');
  assert.equal(kstStamp('not-a-date'), '—');
  assert.equal(kstDate('2026-11-14T15:00:00.000Z'), '2026-11-15');
  assert.equal(kstDayText('2026-10-15T00:00:00.000Z'), '10/15(목)');
});

test('F-07-12 AC-05 UH-02 판매 승인은 승인 이력으로 재승인 대기·변경 반려를 가른다', async () => {
  const { reviewCellOf } = await load();
  const resub = reviewCellOf(summary({ saleReview: 'SUBMITTED', hasApprovalHistory: true }));
  assert.equal(resub.label, '재승인 대기');
  assert.equal(resub.badge, 'badge badge-warning');
  assert.match(resub.note, /판매 계속/);
  assert.equal(reviewCellOf(summary({ saleReview: 'REJECTED', hasApprovalHistory: false, rejectionReason: '통신판매업 신고번호 누락' })).label, '반려');
  assert.match(reviewCellOf(summary({ saleReview: 'REJECTED', hasApprovalHistory: false, rejectionReason: '통신판매업 신고번호 누락' })).note, /통신판매업 신고번호 누락/);
  assert.equal(reviewCellOf(summary({ saleReview: 'REJECTED', hasApprovalHistory: true })).label, '변경 반려');
  assert.equal(reviewCellOf(summary({ saleReview: 'SUBMITTED', hasApprovalHistory: false })).label, '승인 대기');
  assert.equal(reviewCellOf(summary({ saleReview: 'DRAFT', hasApprovalHistory: false })).label, '초안');
  assert.equal(reviewCellOf(summary({ saleReview: 'APPROVED', hasApprovalHistory: true })).label, '승인');
});

test('F-07-12 AC-05 UH-03 판매 중지는 사유 코드를 d5 문구로 바꾸고 원문을 싣지 않는다', async () => {
  const { reviewCellOf } = await load();
  const cases = [
    ['SELLER_IDENTITY', '판매자 신원 확인 필요'],
    ['LEGAL_REQUEST', '법적 요청'],
    ['FRAUD_SUSPECTED', '부정 판매 의심'],
    ['OTHER', '기타'],
  ];
  for (const [code, text] of cases) {
    const cell = reviewCellOf(summary({ saleReview: 'SUSPENDED', hasApprovalHistory: true, suspensionReasonCode: code }));
    assert.equal(cell.label, '판매 중지');
    assert.match(cell.note, new RegExp(text));
  }
  const noReason = reviewCellOf(summary({ saleReview: 'SUSPENDED', hasApprovalHistory: true, suspensionReasonCode: null }));
  assert.ok(noReason.note.length > 0);
  assert.doesNotMatch(noReason.note, /undefined|null/);
});

test('F-07-12 AC-05 UH-04 다음 할 일은 반려·판매 중지·승인 대기·판매 중에 따라 다르다', async () => {
  const { nextActionsOf } = await load();
  assert.deepEqual(nextActionsOf(summary({ saleReview: 'SUBMITTED', hasApprovalHistory: false })), []);
  assert.deepEqual(nextActionsOf(summary({ saleReview: 'REJECTED', hasApprovalHistory: false })), [
    { href: '/events/prod-1/edit', label: '고쳐서 다시 요청' },
  ]);
  assert.deepEqual(nextActionsOf(summary({ saleReview: 'SUSPENDED', hasApprovalHistory: true })), [
    { href: 'mailto:partners@peaket.example', label: '파트너 지원 문의' },
  ]);
  assert.deepEqual(nextActionsOf(summary({ saleReview: 'APPROVED', saleStatus: 'ON_SALE' })), [
    { href: '/events/prod-1/live', label: '판매 현황' },
    { href: '/events/prod-1/staff', label: '현장' },
  ]);
  assert.deepEqual(nextActionsOf(summary({ saleReview: 'APPROVED', saleStatus: 'SOLD_OUT' })), [
    { href: '/events/prod-1/live', label: '판매 현황' },
  ]);
});

test('F-07-12 AC-05 UH-05 필터 이름은 API 값으로 바꾸고 재승인·변경 반려는 승인 이력을 함께 보낸다', async () => {
  const { homeQueryOf } = await load();
  const now = new Date('2026-11-15T00:00:00.000Z');
  assert.deepEqual(homeQueryOf({ saleReview: '반려', saleStatus: '판매 중', period: '전체', q: '  LUMEN  ' }, now), {
    saleReview: ['REJECTED'],
    saleStatus: ['ON_SALE'],
    q: 'LUMEN',
  });
  assert.deepEqual(homeQueryOf({ saleReview: '재승인 대기', period: '전체' }, now), { saleReview: ['SUBMITTED'], hasApprovalHistory: true });
  assert.deepEqual(homeQueryOf({ saleReview: '변경 반려', period: '전체' }, now), { saleReview: ['REJECTED'], hasApprovalHistory: true });
  assert.deepEqual(homeQueryOf({ saleReview: '초안', period: '전체' }, now), { saleReview: ['DRAFT'] });
  assert.deepEqual(homeQueryOf({ saleReview: '승인', period: '전체' }, now), { saleReview: ['APPROVED'] });
  assert.deepEqual(homeQueryOf({ saleReview: '판매 중지', period: '전체' }, now), { saleReview: ['SUSPENDED'] });
  assert.deepEqual(homeQueryOf({ period: '다가오는·진행 중 공연' }, now), { from: '2026-11-15' });
  assert.deepEqual(homeQueryOf({ period: '지난 공연' }, now), { to: '2026-11-14' });
  // API 판매 상태에 없는 '오픈 예약 멈춤'은 거르지 않는다
  assert.deepEqual(homeQueryOf({ saleStatus: '오픈 예약 멈춤', period: '전체' }, now), {});
});

test('F-07-12 AC-05 UH-06 할 일 카드는 네 이름을 만들고 null은 확인할 수 없음이다', async () => {
  const { todoCardsOf } = await load();
  const cards = todoCardsOf({
    asOf: '2026-11-15T00:00:00.000Z',
    rejectedSaleReviewCount: 1,
    settlementDisputeDueCount: 2,
    settlementDisputeEarliestDueAt: '2026-11-17T14:59:59.000Z',
    openGateFlagCount: 3,
    pendingStaffInvitationCount: null,
  });
  assert.equal(cards.length, 4);
  assert.equal(cards[0].label, '반려된 판매 승인');
  assert.equal(cards[0].value, '1건');
  assert.equal(cards[1].label, '정산 이의 기한');
  assert.equal(cards[1].value, '2건');
  assert.match(cards[1].meta, /11\/17\(화\)/);
  assert.equal(cards[2].label, '미처리 이상 표시');
  assert.equal(cards[2].value, '3건');
  assert.equal(cards[3].label, '수락 안 한 스태프 초대');
  assert.equal(cards[3].value, '확인할 수 없음');

  const none = todoCardsOf({ asOf: '2026-11-15T00:00:00.000Z' });
  assert.deepEqual(
    none.map((c) => c.value),
    ['확인할 수 없음', '확인할 수 없음', '확인할 수 없음', '확인할 수 없음'],
  );
});

test('F-07-12 AC-05 UH-07 목록 행은 계약 값을 화면 순서로 옮기고 제목·사유를 글자로만 둔다 [ASVS v5.0.0-1.2.1] [ASVS v5.0.0-3.2.2]', async () => {
  const { homeRowsOf } = await load();
  const evil = '<img src=x onerror=alert(1)>';
  const rows = homeRowsOf({
    items: [
      summary({ productionId: 'prod-2', title: `공연 ${evil}`, saleReview: 'REJECTED', hasApprovalHistory: false, rejectionReason: `사유 ${evil}` }),
      summary({ productionId: 'prod-1', firstOpenAt: null, saleReview: 'DRAFT', hasApprovalHistory: false }),
    ],
    nextCursor: null,
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].productionId, 'prod-2');
  assert.equal(rows[0].name, `공연 ${evil}`);
  assert.match(rows[0].reviewNote, /<img src=x onerror=alert\(1\)>/);
  assert.equal(rows[1].firstOpenText, '—');
  assert.equal(rows[1].saleStatusText, '—');

  const html = renderToStaticMarkup(createElement('p', null, rows[0].reviewNote));
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;img/);
});
