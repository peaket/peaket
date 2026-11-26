// F-07-12 SCR-063 화면 값(공연 개요·회차 허브). 정본: docs/design/d5 §6.3, docs/api/openapi.yaml
// PartnerProductionDetail·PartnerEventDetail, docs/planning/03 §2.14.
// API 개요를 공연 문맥 머리·회차 표·진행 단계로 바꾸는 순수 함수를 본다. 기준 트리에는 live.ts가 없어 각 시험이 실패한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const load = () => import('./live.ts');

const event = (over = {}) => ({
  eventId: 'e1',
  version: 1,
  pending: false,
  openAt: '2026-10-14T11:00:00.000Z',
  lobbyMinutes: 10,
  entryOpensAt: '2026-10-25T07:30:00.000Z',
  startsAt: '2026-10-25T09:00:00.000Z',
  endsAt: '2026-10-25T11:00:00.000Z',
  reentryAllowed: false,
  lobbyShuffle: true,
  openBatch: true,
  seatAssignment: 'PICK',
  perPersonLimit: 4,
  status: 'SCHEDULED',
  saleStatus: 'ON_SALE',
  soldPercent: 50,
  entryClosedAt: null,
  ...over,
});

const detail = (over = {}) => ({
  productionId: 'prod-1',
  version: 1,
  title: 'LUMEN 콘서트 2026 서울',
  genre: '콘서트',
  ageRating: '만 7세 이상',
  runningMinutes: 120,
  place: { placeId: 'place-1', name: '피켓 아레나' },
  requestedPlace: null,
  artists: [{ artistId: 'artist-1', name: '루멘' }],
  aliases: [],
  saleReview: 'APPROVED',
  hasApprovalHistory: true,
  saleApprovedAt: '2026-10-08T05:00:00.000Z',
  rejectionReason: null,
  suspensionReasonCode: null,
  hasPendingRevision: false,
  pendingRevisionFields: [],
  progressStage: 'SALE',
  images: [],
  events: [event(), event({ eventId: 'e2', openAt: '2026-10-15T11:00:00.000Z', startsAt: '2026-10-26T08:00:00.000Z', endsAt: '2026-10-26T10:00:00.000Z', saleStatus: 'UPCOMING', soldPercent: 0 })],
  ...over,
});

test('F-07-12 AC-06 UO-01 승인 이력으로 재승인 대기·변경 반려를 가른다', async () => {
  const { reviewOfDetail } = await load();
  assert.equal(reviewOfDetail(detail({ saleReview: 'SUBMITTED', hasApprovalHistory: true })), 'RESUBMITTED');
  assert.equal(reviewOfDetail(detail({ saleReview: 'REJECTED', hasApprovalHistory: true })), 'CHANGE_REJECTED');
  assert.equal(reviewOfDetail(detail({ saleReview: 'SUBMITTED', hasApprovalHistory: false })), 'SUBMITTED');
  assert.equal(reviewOfDetail(detail({ saleReview: 'REJECTED', hasApprovalHistory: false })), 'REJECTED');
  assert.equal(reviewOfDetail(detail({ saleReview: 'SUSPENDED', hasApprovalHistory: true })), 'SUSPENDED');
  assert.equal(reviewOfDetail(detail({ saleReview: 'APPROVED', hasApprovalHistory: true })), 'APPROVED');
});

test('F-07-12 AC-06 UO-02 판매 상태는 회차 값을 합쳐 판매 중·오픈 예정·매진·종료로 만든다', async () => {
  const { saleStatusOfEvents } = await load();
  assert.equal(saleStatusOfEvents([event({ saleStatus: 'ON_SALE' }), event({ eventId: 'e2', saleStatus: 'UPCOMING' })]), 'ON_SALE');
  assert.equal(saleStatusOfEvents([event({ saleStatus: 'ALL_HELD' })]), 'ON_SALE');
  assert.equal(saleStatusOfEvents([event({ saleStatus: 'UPCOMING' })]), 'UPCOMING');
  assert.equal(saleStatusOfEvents([event({ saleStatus: 'SOLD_OUT' }), event({ eventId: 'e2', saleStatus: 'SOLD_OUT' })]), 'SOLD_OUT');
  assert.equal(saleStatusOfEvents([event({ saleStatus: 'ENDED' })]), 'ENDED');
  assert.equal(saleStatusOfEvents([]), 'NONE');
});

test('F-07-12 AC-06 UO-03 회차 행은 시작·입장·종료 예정을 KST로, 판매율 null은 —로 그린다', async () => {
  const { eventRowsOf } = await load();
  const rows = eventRowsOf([
    event(),
    event({ eventId: 'e2', entryOpensAt: null, startsAt: '2026-10-26T08:00:00.000Z', endsAt: '2026-10-26T10:00:00.000Z', saleStatus: 'UPCOMING', soldPercent: null }),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].startsAt, '10/25(일) 18:00 KST');
  assert.equal(rows[0].doorsAt, '16:30 KST');
  assert.equal(rows[0].endsAt, '20:00 KST');
  assert.equal(rows[0].saleStatusText, '판매 중');
  assert.equal(rows[0].saleRateText, '50%');
  assert.equal(rows[1].doorsAt, '—');
  assert.equal(rows[1].saleStatusText, '오픈 예정');
  assert.equal(rows[1].saleRateText, '—');
});

test('F-07-12 AC-06 UO-04 공연 문맥 머리는 API 값으로 채우고 없는 값에 목업 LUMEN을 쓰지 않는다', async () => {
  const { productionOfDetail } = await load();
  const p = productionOfDetail(detail());
  assert.equal(p.id, 'prod-1');
  assert.equal(p.name, 'LUMEN 콘서트 2026 서울');
  assert.equal(p.review, 'APPROVED');
  assert.equal(p.firstOpenAt, '10/14(수) 20:00 KST');
  assert.equal(p.roundCount, 2);
  assert.equal(p.saleStatus, 'ON_SALE');
  assert.equal(p.perPersonLimit, 4);
  assert.equal(p.reentry, false);
  assert.equal(p.rounds.length, 2);
  assert.equal(p.rounds[0].startsAt, '10/25(일) 18:00 KST');
  assert.equal(p.rounds[0].doorsAt, '16:30 KST');
  assert.equal(p.rounds[0].endsAt, '20:00 KST');
  assert.equal(p.rounds[0].saleStatus, 'ON_SALE');
  assert.equal(p.rounds[0].saleRate, 50);

  const rejected = productionOfDetail(detail({ saleReview: 'REJECTED', hasApprovalHistory: false, rejectionReason: '통신판매업 신고번호 누락', events: [] }));
  assert.equal(rejected.review, 'REJECTED');
  assert.match(rejected.reviewNote, /통신판매업 신고번호 누락/);
  assert.equal(rejected.firstOpenAt, null);
  assert.equal(rejected.roundCount, 0);
  assert.equal(rejected.saleStatus, 'NONE');

  const suspended = productionOfDetail(detail({ saleReview: 'SUSPENDED', suspensionReasonCode: 'SELLER_IDENTITY' }));
  assert.equal(suspended.review, 'SUSPENDED');
  assert.match(suspended.reviewNote, /판매자 신원 확인 필요/);
});

test('F-07-12 AC-06 UO-05 진행 단계는 API progressStage를 d5 일곱 단계의 지금 위치로 바꾼다', async () => {
  const { progressOf } = await load();
  const order = ['REGISTRATION', 'SALE_REVIEW', 'OPEN', 'SALE', 'ENTRY', 'ENTRY_RECORD_CLOSED', 'SETTLEMENT'];
  const labels = ['등록', '판매 승인', '오픈', '판매', '입장', '입장 기록 마감', '정산'];
  for (const [i, stage] of order.entries()) {
    const p = progressOf(detail({ progressStage: stage }));
    assert.deepEqual(p.steps.map((s) => s.label), labels, stage);
    assert.equal(p.current, i, stage);
  }
  const unknown = progressOf(detail({ progressStage: 'NOPE' }));
  assert.equal(unknown.current, -1);
});
