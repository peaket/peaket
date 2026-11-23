// 판매 승인의 지급대행 조건과 판매자 확인 쓰기(J-T39 ⑤⑦, F-07-7 LCH-120, settlement §3, ADR-0370 결정 3·4, transfer-refund §2.1 확인 항목 5).
// 관제 승인 HTTP(POST /v1/ops/sale-reviews/{id}/approvals) 경계에서, payment 등록 읽기 대역의 답에 따라
// 켜진 결제사의 조건만 보는지, 모자라면 409·확장 칸 missing이고 공연·판매 열기·사본이 그대로인지,
// 승인 성공 때 판매자 확인을 한 번 쓰고 payment가 답하지 않으면 503으로 닫는지 본다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository, MemorySaleConfigStore, MemorySaleOpen } from '../src/modules/catalog/index.js';
import { BOTH_OFF, problem, readyView, RecordingPayoutRegistration } from './payout-registration-double.js';
import { FakeIdentity, NOW_MS, quiet } from './support.js';

const P = 'https://peaket.example/problems/';
const repo = new MemoryCatalogRepository();
const identity = new FakeIdentity();
const saleConfigs = new MemorySaleConfigStore();
const saleOpen = new MemorySaleOpen();
const payout = new RecordingPayoutRegistration();
const PLACE = randomUUID();
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  repo.places.add(PLACE);
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, catalog: repo, saleConfigs, saleOpen, payoutRegistration: payout }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW_MS }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});

afterAll(async () => {
  await svc?.close();
});

beforeEach(() => {
  payout.reset();
  saleOpen.calls.length = 0;
});

/** 판매 승인 대기 공연 하나와 그 파트너(판매자 상호·대표자는 시험마다 다르게) */
function submitted() {
  const promoterId = randomUUID();
  const legalName = `(주)스텔라-${promoterId.slice(0, 6)}`;
  repo.promoters.set(promoterId, {
    promoterId,
    legalName,
    representative: '김스텔라',
    address: '서울 어딘가 1',
    phone: '02-1234-5678',
    email: 'seller@example.test',
    businessRegNo: '123-45-67890',
    mailOrderReportNo: '2026-서울-0001',
    exemptionBasis: null,
    verifiedAt: null,
    commissionRateBp: 1000,
    pendingContractApprovalId: null,
  });
  const id = randomUUID();
  repo.productions.set(id, { id, promoterId, placeId: PLACE, title: `공연-${id.slice(0, 8)}`, genre: '콘서트', saleReview: 'SUBMITTED', saleApprovedAt: null, saleSubmittedAt: new Date(NOW_MS), rejectionReason: null });
  const eventId = randomUUID();
  repo.events.set(eventId, { id: eventId, productionId: id, venueId: null, openAt: new Date(NOW_MS + 3_600_000), startsAt: new Date(NOW_MS + 86_400_000), status: 'SCHEDULED' });
  return { id, promoterId, legalName, eventId };
}

const approve = (p: { id: string; eventId: string }, role: 'operator' | 'commander' = 'operator') =>
  svc.http.inject({
    method: 'POST',
    url: `/v1/ops/sale-reviews/${p.id}/approvals`,
    headers: { ...identity.ops(role), 'content-type': 'application/json' },
    payload: JSON.stringify({ scales: [{ eventId: p.eventId, scale: 'SMALL' }], placeId: PLACE }),
  });
const json = (r: { payload: string }) => JSON.parse(r.payload) as { type: string; status: number; missing?: string[] };

/** 승인되지 않았다: 공연 상태·판매 열기·회차 사본·규모가 그대로다 */
function untouched(p: { id: string; eventId: string }, label: string) {
  expect(repo.productions.get(p.id), label).toMatchObject({ saleReview: 'SUBMITTED', saleApprovedAt: null });
  expect(saleOpen.calls.filter((c) => c.eventId === p.eventId), label).toEqual([]);
  expect(saleConfigs.configs.has(p.eventId), label).toBe(false);
  expect(repo.eventScales.has(p.eventId), label).toBe(false);
}

describe('J-T39 ⑤ 판매 승인은 켜진 결제사의 지급대행 조건이 모두 참일 때만', () => {
  test('J-T39 ⑤ 둘 다 켜지고 일반 상점 셀러가 PARTIALLY_APPROVED·APPROVED면 200이고 승인된다 [ASVS v5.0.0-2.2.3]', async () => {
    for (const standard of ['PARTIALLY_APPROVED', 'APPROVED'] as const) {
      const p = submitted();
      payout.views.set(p.promoterId, readyView({ standard }));
      const r = await approve(p);
      expect(r.statusCode, standard).toBe(200);
      expect(repo.productions.get(p.id)?.saleReview, standard).toBe('APPROVED');
      expect(payout.reads, standard).toContain(p.promoterId);
    }
  });

  test('J-T39 ⑤ 일반 상점 셀러가 APPROVAL_REQUIRED·PENDING·KYC_REQUIRED·REJECTED이거나 없으면 409 sale-review-payout-registration-incomplete·missing [TOSS_SELLER]이고 아무것도 바뀌지 않는다 [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-16.5.3]', async () => {
    for (const standard of ['APPROVAL_REQUIRED', 'PENDING', 'KYC_REQUIRED', 'REJECTED', null] as const) {
      const label = String(standard);
      const p = submitted();
      // 에스크로 셀러가 APPROVED여도 조건은 일반 상점(STANDARD) 셀러다
      payout.views.set(p.promoterId, readyView({ standard, escrow: 'APPROVED' }));
      const r = await approve(p);
      expect(r.statusCode, label).toBe(409);
      expect(json(r), label).toMatchObject({ type: `${P}sale-review-payout-registration-incomplete`, status: 409, missing: ['TOSS_SELLER'] });
      untouched(p, label);
      // 조건이 모자라면 판매자 확인을 쓰지 않는다
      expect(payout.verifications.filter((v) => v.promoterId === p.promoterId), label).toEqual([]);
    }
  });

  test('J-T39 ⑤ 예금주 미확인·정산 계좌 없음은 HOLDER, 포트원 파트너 미등록은 PORTONE_PARTNER, 셋 다 모자라면 셋 모두가 missing이다', async () => {
    const cases = [
      { label: '예금주 미확인', view: readyView({ payoutAccount: { bankCode: '88', last4: '4321', holdUntil: null, holderVerified: false } }), missing: ['HOLDER'] },
      { label: '정산 계좌 없음', view: readyView({ payoutAccount: null }), missing: ['HOLDER'] },
      { label: '포트원 파트너 없음', view: readyView({ portonePartnerRegistered: false }), missing: ['PORTONE_PARTNER'] },
      { label: '셋 다', view: readyView({ payoutAccount: null, portonePartnerRegistered: false, standard: null }), missing: ['HOLDER', 'PORTONE_PARTNER', 'TOSS_SELLER'] },
    ];
    for (const c of cases) {
      const p = submitted();
      payout.views.set(p.promoterId, c.view);
      const r = await approve(p);
      expect(r.statusCode, c.label).toBe(409);
      const body = json(r);
      expect(body.type, c.label).toBe(`${P}sale-review-payout-registration-incomplete`);
      expect([...(body.missing ?? [])].sort(), c.label).toEqual([...c.missing].sort());
      untouched(p, c.label);
    }
  });

  test('J-T39 ⑤ 둘 다 꺼진 조립은 등록이 비어 있어도 지금처럼 승인한다', async () => {
    const p = submitted();
    payout.views.set(p.promoterId, BOTH_OFF);
    const r = await approve(p);
    expect(r.statusCode).toBe(200);
    expect(repo.productions.get(p.id)?.saleReview).toBe('APPROVED');
  });

  test('J-T39 ⑤ 토스만 켜진 조립은 포트원 조건(예금주·포트원 파트너)을 보지 않고, 셀러 조건만 본다', async () => {
    const ok = submitted();
    payout.views.set(ok.promoterId, { ...BOTH_OFF, tossEnabled: true, tossSellers: [{ pgStore: 'STANDARD', status: 'PARTIALLY_APPROVED' }] });
    expect((await approve(ok)).statusCode).toBe(200);
    expect(repo.productions.get(ok.id)?.saleReview).toBe('APPROVED');

    const noSeller = submitted();
    payout.views.set(noSeller.promoterId, { ...BOTH_OFF, tossEnabled: true });
    const r = await approve(noSeller);
    expect(r.statusCode).toBe(409);
    expect(json(r).missing).toEqual(['TOSS_SELLER']);
    untouched(noSeller, '토스만 켜짐·셀러 없음');
  });

  test('J-T39 ⑤ 포트원만 켜진 조립은 셀러 조건을 보지 않고 예금주 일치·포트원 파트너만 본다', async () => {
    const ok = submitted();
    payout.views.set(ok.promoterId, readyView({ tossEnabled: false, standard: null, escrow: null }));
    expect((await approve(ok)).statusCode).toBe(200);

    const noPartner = submitted();
    payout.views.set(noPartner.promoterId, readyView({ tossEnabled: false, standard: null, escrow: null, portonePartnerRegistered: false }));
    const r = await approve(noPartner);
    expect(r.statusCode).toBe(409);
    expect(json(r).missing).toEqual(['PORTONE_PARTNER']);
    untouched(noPartner, '포트원만 켜짐·파트너 없음');
  });

  test('J-T39 ⑤ 등록 읽기가 실패하면 승인하지 않고 503 payout-dependency-unavailable이다(fail-closed) [ASVS v5.0.0-16.5.3]', async () => {
    const p = submitted();
    payout.readError = problem('payout-dependency-unavailable', 503);
    const r = await approve(p);
    expect(r.statusCode).toBe(503);
    expect(json(r).type).toBe(`${P}payout-dependency-unavailable`);
    untouched(p, '읽기 실패');
    expect(payout.verifications).toEqual([]);
  });
});

describe('J-T39 ⑦ 승인 성공 때 payment 판매자 확인 쓰기', () => {
  test('J-T39 ⑦ 승인이 성공하면 판매자 상호·대표자·확인 시각으로 verifySeller가 한 번 불린다(조건이 켜진 조립과 둘 다 꺼진 조립)', async () => {
    for (const view of [readyView(), BOTH_OFF]) {
      payout.reset();
      const p = submitted();
      payout.views.set(p.promoterId, view);
      const r = await approve(p);
      expect(r.statusCode).toBe(200);
      expect(payout.verifications).toEqual([{ promoterId: p.promoterId, input: { legalName: p.legalName, representative: '김스텔라', verifiedAt: new Date(NOW_MS) } }]);
    }
  });

  test('J-T39 ⑦ payment가 503·시간 초과로 판매자 확인을 받지 못하면 승인은 503 payout-dependency-unavailable이고 공연은 SUBMITTED 그대로이며, 다시 승인하면 성공한다 [ASVS v5.0.0-16.5.3]', async () => {
    const p = submitted();
    payout.views.set(p.promoterId, readyView());
    // HttpPayoutRegistration은 payment의 503과 연결 실패·시간 초과를 모두 503 payout-dependency-unavailable로 다시 던진다(http-payout-registration.test.ts)
    payout.verifyError = problem('payout-dependency-unavailable', 503, 'payment-svc가 답하지 않습니다');
    const r = await approve(p);
    expect(r.statusCode).toBe(503);
    expect(json(r).type).toBe(`${P}payout-dependency-unavailable`);
    untouched(p, '판매자 확인 실패');
    expect(payout.verifications).toHaveLength(1);

    // 판매자 확인은 같은 값이면 멱등이라 다시 승인해도 안전하다
    payout.verifyError = undefined;
    const again = await approve(p, 'commander');
    expect(again.statusCode).toBe(200);
    expect(repo.productions.get(p.id)?.saleReview).toBe('APPROVED');
    expect(payout.verifications).toHaveLength(2);
    expect(payout.verifications[1]).toEqual({ promoterId: p.promoterId, input: { legalName: p.legalName, representative: '김스텔라', verifiedAt: new Date(NOW_MS) } });
  });
});
