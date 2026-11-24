// SCR-048 판매 승인 잔여 화면 모델 시험(LCH-080 잔여, d5 §7.9 ②, F-07-7 I-10).
// 아티스트·공연장 연결 값과 지급대행 등록 표시, 승인 본문, 409·422 문구를 본다. 기준 트리에는 새 함수가 없어 단언이 실패한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as model from './sale-review.ts';

const ARTIST = '3f1c2d9e-0000-4000-8000-000000000010';
const NEW_ARTIST = '3f1c2d9e-0000-4000-8000-000000000011';
const PLACE = '3f1c2d9e-0000-4000-8000-000000000001';
const NEW_PLACE = '3f1c2d9e-0000-4000-8000-000000000002';

const raw = () => ({
  productionId: 'prd-1',
  title: '겨울 콘서트',
  promoterId: 'prom-1',
  promoterName: '(주)피켓공연',
  status: 'SUBMITTED',
  reapproval: false,
  submittedAt: '2026-11-20T01:00:00.000Z',
  rejectionReason: null,
  seller: { legalName: '(주)피켓공연', representative: '김대표', address: '서울', phone: '02-1234-5678', email: 'seller@example.test', businessRegNo: '123-45-67890', mailOrderReportNo: '2026-서울-1234', exemptionBasis: null },
  verifiedAt: null,
  placeId: null,
  placeName: '새 공연장',
  requestedPlace: true,
  accessibleSeatingCheck: true,
  artists: [
    { artistId: ARTIST, name: 'LUMEN' },
    { artistId: null, name: '새 이름' },
  ],
  salePolicy: [],
  events: [{ eventId: 'ev-1', openAt: '2026-12-01T11:00:00.000Z', startsAt: '2026-12-02T10:30:00.000Z', status: 'SCHEDULED', scale: null, demandForecastPath: '/v1/ops/events/ev-1/demand-forecast' }],
  suspensionApprovalPending: false,
  payoutAccount: { bankCode: '004', last4: '6789', holdUntil: null, holderVerified: true },
  pgRegistration: { tossEnabled: true, portoneEnabled: true, tossSellers: [{ pgStore: 'STANDARD', status: 'PARTIALLY_APPROVED' }, { pgStore: 'ESCROW', status: 'APPROVAL_REQUIRED' }], portonePartnerRegistered: true },
});

test('S-T41 ⑫ LCH-080_ 상세가 아티스트와 지급대행 등록 값을 화면 값으로 옮긴다', () => {
  assert.equal(typeof model.mapSaleReviewDetail, 'function');
  const d = model.mapSaleReviewDetail(raw());
  assert.deepEqual(d.artists, [
    { artistId: ARTIST, name: 'LUMEN' },
    { artistId: null, name: '새 이름' },
  ]);
  assert.deepEqual(d.payoutAccount, { bankCode: '004', last4: '6789', holdUntil: null, holderVerified: true });
  assert.deepEqual(d.pgRegistration.tossSellers, [
    { pgStore: 'STANDARD', status: 'PARTIALLY_APPROVED' },
    { pgStore: 'ESCROW', status: 'APPROVAL_REQUIRED' },
  ]);
  assert.equal(d.pgRegistration.portonePartnerRegistered, true);
  assert.equal(d.requestedPlace, true);
});

test('S-T41 ⑫ LCH-080_ 요청 아티스트·공연장을 모두 고르기 전에는 승인하지 않고 이유를 보인다', () => {
  assert.equal(typeof model.validateLinkage, 'function');
  const d = model.mapSaleReviewDetail(raw());

  const empty = model.validateLinkage(d, { artists: {}, placeId: null });
  assert.equal(empty.length, 2);
  assert.match(empty.join(' '), /아티스트/);
  assert.match(empty.join(' '), /공연장/);

  const half = model.validateLinkage(d, { artists: { 'LUMEN': ARTIST }, placeId: null });
  assert.equal(half.length, 2);

  const done = model.validateLinkage(d, { artists: { 'LUMEN': ARTIST, '새 이름': NEW_ARTIST }, placeId: NEW_PLACE });
  assert.deepEqual(done, []);
});

test('S-T41 ⑫ LCH-080_ 승인 본문은 회차 규모·고른 공연장·요청 이름별 아티스트만 낸다', () => {
  assert.equal(typeof model.linkageBody, 'function');
  const d = model.mapSaleReviewDetail(raw());
  const body = model.linkageBody(d, { artists: { 'LUMEN': ARTIST, '새 이름': NEW_ARTIST }, placeId: NEW_PLACE }, { 'ev-1': 'MEDIUM' });
  assert.deepEqual(body, {
    scales: [{ eventId: 'ev-1', scale: 'MEDIUM' }],
    placeId: NEW_PLACE,
    artists: [
      { name: 'LUMEN', artistId: ARTIST },
      { name: '새 이름', artistId: NEW_ARTIST },
    ],
  });
  assert.equal('artistIds' in body, false);
  assert.equal('aliases' in body, false);

  const registered = model.mapSaleReviewDetail({ ...raw(), placeId: PLACE, requestedPlace: false, artists: [{ artistId: ARTIST, name: 'LUMEN' }] });
  assert.deepEqual(model.linkageBody(registered, { artists: {}, placeId: null }, { 'ev-1': 'SMALL' }), {
    scales: [{ eventId: 'ev-1', scale: 'SMALL' }],
    placeId: PLACE,
  });
});

test('S-T41 ⑫ LCH-080_ 422·409 지급대행 미완료를 서로 다른 문구로 바꾼다 [ASVS v5.0.0-8.2.2]', () => {
  const artist = model.saleReviewProblem({ status: 422, type: 'sale-review-artists-missing' });
  const place = model.saleReviewProblem({ status: 422, type: 'sale-review-place-missing' });
  const payout = model.saleReviewProblem({ status: 409, type: 'sale-review-payout-registration-incomplete' });
  const duplicate = model.saleReviewProblem({ status: 409, type: 'artist-exists' });
  assert.equal(artist.kind, 'validation');
  assert.equal(place.kind, 'validation');
  assert.equal(payout.kind, 'conflict');
  assert.equal(duplicate.kind, 'conflict');
  assert.match(artist.message, /아티스트/);
  assert.match(place.message, /공연장/);
  assert.match(payout.message, /지급대행/);
  assert.notEqual(artist.message, place.message);
  assert.notEqual(place.message, payout.message);
});
