// SCR-021 5단계 판매 승인 요청의 순수 함수 시험(BAT-617, LCH-080, d5 §6.4).
// 앱에 시험 도구가 없어 Node 내장 시험 실행기로 돌린다(`pnpm --filter @peaket/partner test`). 타입 지우기로 .ts를 그대로 읽는다.
// 요청 본문은 계약 세 칸(seller·payoutAccount·accessibleSeating)만 내고, 계좌는 저장하지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  emptySaleReviewForm,
  formFromStatus,
  problemOf,
  saleReviewView,
  toSaleReviewBody,
  validateSaleReview,
} from './sale-review-live.ts';

const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));
const OPENAPI = readFileSync(join(ROOT, 'docs/api/openapi.yaml'), 'utf8');

const filled = () => {
  const f = emptySaleReviewForm();
  f.seller = {
    legalName: '(주)피켓공연',
    representative: '김대표',
    address: '서울시 송파구 올림픽로 1',
    phone: '02-1234-5678',
    email: 'seller@example.test',
    businessRegNo: '123-45-67890',
  };
  f.report = { kind: 'NUMBER', value: '2026-서울-1234' };
  f.payout = { bankCode: '88', accountNumber: '1002-345-678901', holderName: '김대표' };
  f.wheelchair = { confirmed: true, shortfallReason: '', note: '' };
  return f;
};

test('S-T41 ⑫_[ASVS v5.0.0-8.2.2] 5단계는 필수값이 비면 요청하지 않고 칸마다 이유를 보인다', () => {
  const issues = validateSaleReview(emptySaleReviewForm());
  const fields = new Set(issues.map((i) => i.field));
  for (const field of ['seller.legalName', 'seller.representative', 'seller.address', 'seller.phone', 'seller.email', 'seller.businessRegNo', 'report.value', 'payout.bankCode', 'payout.accountNumber', 'payout.holderName', 'wheelchair.confirmed']) {
    assert.ok(fields.has(field), `${field} 검사가 없다`);
  }
  assert.deepEqual(validateSaleReview(filled()), []);

  const badMail = filled();
  badMail.seller.email = 'not-an-email';
  assert.equal(validateSaleReview(badMail).some((i) => i.field === 'seller.email'), true);

  const exemption = filled();
  exemption.report = { kind: 'EXEMPTION', value: '소규모 공연 면제' };
  const body = toSaleReviewBody(exemption);
  assert.equal(body.seller.exemptionBasis, '소규모 공연 면제');
  assert.equal('mailOrderReportNo' in body.seller, false);

  const other = filled();
  other.wheelchair.shortfallReason = 'OTHER';
  assert.equal(validateSaleReview(other).some((i) => i.field === 'wheelchair.note'), true);
  other.wheelchair.note = '무대 설치로 2석을 쓰지 못했습니다';
  assert.deepEqual(validateSaleReview(other), []);
});

test('S-T41 ⑫_요청 본문은 계약의 세 칸만 내고 계좌를 저장하지 않는다', () => {
  const body = toSaleReviewBody(filled());
  assert.deepEqual(Object.keys(body).sort(), ['accessibleSeating', 'payoutAccount', 'seller']);
  assert.deepEqual(Object.keys(body.seller).sort(), ['address', 'businessRegNo', 'email', 'legalName', 'mailOrderReportNo', 'phone', 'representative']);
  assert.deepEqual(Object.keys(body.payoutAccount).sort(), ['accountNumber', 'bankCode', 'holderName']);
  assert.deepEqual(body.accessibleSeating, { confirmed: true });
  // 계좌번호는 요청 본문에만 있고, 화면이 쓰는 상태 값에는 저장하지 않는다
  assert.equal(body.payoutAccount.accountNumber, '1002-345-678901');
  const status = {
    title: '겨울 콘서트',
    saleReview: 'APPROVED',
    rejectionReason: null,
    hasApprovalHistory: true,
    submittedAt: '2026-11-20T01:00:00.000Z',
    seller: { legalName: '(주)피켓공연', representative: '김대표', address: '서울', phone: '02-1234-5678', email: 'seller@example.test', businessRegNo: '123-45-67890', mailOrderReportNo: '2026-서울-1234', exemptionBasis: null },
    events: [{ eventId: 'ev-1', openAt: '2026-12-01T11:00:00.000Z', startsAt: '2026-12-02T10:30:00.000Z' }],
  };
  const form = formFromStatus(status);
  assert.equal(form.payout.accountNumber, '');
  assert.equal(form.payout.holderName, '');
  assert.equal(form.seller.legalName, '(주)피켓공연');
});

test('S-T41 ⑫_상태와 변경 취소 가능 여부를 승인 이력으로 가른다', () => {
  const base = { title: '공연', saleReview: 'SUBMITTED', rejectionReason: null, hasApprovalHistory: false, submittedAt: '2026-11-20T01:00:00.000Z', seller: null, events: [] };
  assert.equal(saleReviewView(base).label, '승인 대기');
  assert.equal(saleReviewView(base).canCancel, false);
  assert.equal(saleReviewView({ ...base, hasApprovalHistory: true }).label, '재승인 대기');
  assert.equal(saleReviewView({ ...base, hasApprovalHistory: true }).canCancel, true);
  assert.equal(saleReviewView({ ...base, saleReview: 'REJECTED', hasApprovalHistory: true }).label, '변경 반려');
  assert.equal(saleReviewView({ ...base, saleReview: 'REJECTED', hasApprovalHistory: true }).editable, true);
  assert.equal(saleReviewView({ ...base, saleReview: 'APPROVED' }).label, '승인');
  assert.equal(saleReviewView({ ...base, saleReview: 'APPROVED' }).editable, false);
  assert.equal(saleReviewView({ ...base, saleReview: 'SUSPENDED' }).label, '판매 중지');
});

test('S-T41 ⑫_[ASVS v5.0.0-8.2.2] 403·409·422·503을 화면 문구로 가른다', () => {
  assert.deepEqual(problemOf({ status: 403, type: 'partner-admin-required' }), {
    kind: 'member',
    message: '판매 승인 요청과 변경 취소는 파트너 관리자만 할 수 있습니다.',
    reload: false,
  });
  assert.equal(problemOf({ status: 409, type: 'sale-review-not-cancellable' }).kind, 'conflict');
  assert.equal(problemOf({ status: 409, type: 'sale-review-not-cancellable' }).reload, true);
  assert.equal(problemOf({ status: 409, type: 'production-suspended' }).message.includes('판매 중지'), true);
  assert.equal(problemOf({ status: 422 }).kind, 'validation');
  assert.equal(problemOf({ status: 503 }).message.includes('잠시 뒤'), true);
  assert.equal(problemOf({ status: 404 }).kind, 'notfound');
  assert.equal(problemOf(new TypeError('fetch failed')).kind, 'unknown');
  // 화면 문구는 계약의 세 칸과 같은 이름을 쓴다(정본 openapi CreatePartnerProductionSaleReviewBody)
  for (const key of ['seller', 'payoutAccount', 'accessibleSeating']) assert.ok(OPENAPI.includes(key), key);
});
