// SCR-048 판매 승인 화면의 순수 함수 시험(BAT-617, LCH-080, d5 §7.9, ASVS 8.2.2·8.2.3).
// 승인 본문은 회차별 scales와 (있으면) placeId만 내고, 반려 사유는 1~1,000자다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  approvalBody,
  canAct,
  canRead,
  formatKst,
  initialScales,
  mapSaleReviewDetail,
  mapSaleReviewList,
  saleReviewProblem,
  statusLabel,
  validateApproval,
  validateRejection,
} from './sale-review.ts';

const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));
const OPENAPI = readFileSync(join(ROOT, 'docs/api/openapi.yaml'), 'utf8');

const detail = () => ({
  productionId: 'prd-1',
  title: '겨울 콘서트',
  promoterId: 'prom-1',
  promoterName: '(주)피켓공연',
  status: 'SUBMITTED',
  reapproval: false,
  submittedAt: '2026-11-20T01:00:00.000Z',
  rejectionReason: '통신판매업 신고번호를 보완해 주세요',
  seller: { legalName: '(주)피켓공연', representative: '김대표', address: '서울', phone: '02-1234-5678', email: 'seller@example.test', businessRegNo: '123-45-67890', mailOrderReportNo: '2026-서울-1234', exemptionBasis: null },
  verifiedAt: null,
  placeId: '3f1c2d9e-0000-4000-8000-000000000001',
  placeName: '피켓 아레나',
  requestedPlace: false,
  accessibleSeatingCheck: true,
  salePolicy: [{ kind: 'refundFee', from: 0, to: 10 }],
  events: [
    { eventId: 'ev-1', openAt: '2026-12-01T11:00:00.000Z', startsAt: '2026-12-02T10:30:00.000Z', status: 'SCHEDULED', scale: null, demandForecastPath: '/v1/ops/events/ev-1/demand-forecast' },
    { eventId: 'ev-2', openAt: '2026-12-03T11:00:00.000Z', startsAt: '2026-12-04T10:30:00.000Z', status: 'CANCELLED', scale: 'MEDIUM', demandForecastPath: '/v1/ops/events/ev-2/demand-forecast' },
  ],
  suspensionApprovalPending: false,
});

test('S-T41 ⑫_[ASVS v5.0.0-8.2.2] 목록·상세를 화면 값으로 바꾸고 역할을 가른다', () => {
  const page = mapSaleReviewList({
    items: [{ productionId: 'prd-1', title: '겨울 콘서트', promoterId: 'prom-1', promoterName: '(주)피켓공연', status: 'SUBMITTED', reapproval: true, submittedAt: '2026-11-20T01:00:00.000Z', firstOpenAt: null, eventCount: 2, suspensionApprovalPending: false }],
    nextCursor: 'next-1',
  });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].productionId, 'prd-1');
  assert.equal(page.items[0].reapproval, true);
  assert.equal(page.nextCursor, 'next-1');

  const d = mapSaleReviewDetail(detail());
  assert.equal(d.placeName, '피켓 아레나');
  assert.equal(d.requestedPlace, false);
  assert.equal(d.accessibleSeatingCheck, true);
  assert.deepEqual(d.events.map((e) => e.status), ['SCHEDULED', 'CANCELLED']);
  assert.equal(d.rejectionReason, '통신판매업 신고번호를 보완해 주세요');

  assert.equal(statusLabel('SUBMITTED', true), '재승인 대기');
  assert.equal(statusLabel('REJECTED', true), '변경 반려');
  assert.equal(statusLabel('APPROVED', true), '승인');
  for (const role of ['viewer', 'cs_agent', 'cs_lead']) {
    assert.equal(canRead(role), true, `${role} 읽기`);
    assert.equal(canAct(role), false, `${role} 승인`);
  }
  for (const role of ['operator', 'commander']) {
    assert.equal(canAct(role), true, `${role} 승인`);
  }
  assert.equal(canAct(null), true);
  assert.equal(canRead(null), true);
});

test('S-T41 ⑫_승인 본문은 scales와 placeId만 내고 모든 회차 규모를 요구한다', () => {
  const d = mapSaleReviewDetail(detail());
  const scales = initialScales(d.events);
  assert.deepEqual(scales, { 'ev-1': '', 'ev-2': 'MEDIUM' });
  assert.equal(validateApproval(d, scales).length > 0, true);

  scales['ev-1'] = 'LARGE';
  assert.deepEqual(validateApproval(d, scales), []);
  assert.deepEqual(approvalBody(d, scales), {
    scales: [
      { eventId: 'ev-1', scale: 'LARGE' },
      { eventId: 'ev-2', scale: 'MEDIUM' },
    ],
    placeId: '3f1c2d9e-0000-4000-8000-000000000001',
  });

  const noPlace = mapSaleReviewDetail({ ...detail(), placeId: null, placeName: '새 공연장 요청', requestedPlace: true });
  assert.deepEqual(approvalBody(noPlace, scales), {
    scales: [
      { eventId: 'ev-1', scale: 'LARGE' },
      { eventId: 'ev-2', scale: 'MEDIUM' },
    ],
  });
  const text = JSON.stringify(approvalBody(d, scales));
  assert.equal(text.includes('artistIds'), false, '승인 본문에 artistIds가 있다');
  assert.equal(text.includes('aliases'), false, '승인 본문에 aliases가 있다');
  // 계약도 같은 세 칸만 받는다(RV-05)
  const spec = OPENAPI.slice(OPENAPI.indexOf('operationId: createOpsSaleReviewApproval,'), OPENAPI.indexOf('operationId: createOpsSaleReviewRejection,'));
  assert.match(spec, /required: \[scales\]/);
  assert.equal(spec.includes('artistIds'), false);
  assert.equal(spec.includes('aliases'), false);
  assert.match(spec, /accessibleSeatingCheck/);
});

test('S-T41 ⑫_반려 사유는 1~1,000자이고 상세의 사유를 보인다', () => {
  assert.notEqual(validateRejection(''), null);
  assert.equal(validateRejection('사업자등록증을 다시 확인해 주세요'), null);
  assert.equal(validateRejection('가'.repeat(1000)), null);
  assert.notEqual(validateRejection('가'.repeat(1001)), null);
  assert.equal(mapSaleReviewDetail(detail()).rejectionReason, '통신판매업 신고번호를 보완해 주세요');
});

test('S-T41 ⑫_[ASVS v5.0.0-8.2.2] 409·422·403·503을 서로 다른 문구로 보인다', () => {
  assert.equal(saleReviewProblem({ status: 409, type: 'open-interval-conflict' }).message.includes('30분'), true);
  assert.equal(saleReviewProblem({ status: 409, type: 'sale-review-not-submitted' }).reload, true);
  assert.equal(saleReviewProblem({ status: 422, type: 'sale-review-scales-missing' }).message.includes('규모'), true);
  assert.equal(saleReviewProblem({ status: 422, type: 'sale-review-list-missing' }).message.includes('명단'), true);
  assert.equal(saleReviewProblem({ status: 403 }).kind, 'forbidden');
  assert.equal(saleReviewProblem({ status: 404 }).reload, true);
  assert.equal(saleReviewProblem({ status: 503 }).message.includes('잠시 뒤'), true);
  assert.equal(formatKst('2026-12-01T11:00:00.000Z'), '2026-12-01 20:00');
});
