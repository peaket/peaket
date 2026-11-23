// 지급대행 등록 한 길 시험(J-T39 ①②③④⑥⑦, settlement §3, ADR-0370 결정 1·3·4, F-07-7 계획 §5.1(다)(라)).
// payment 쪽 몫: Settlements.registerPayoutAgencies와 내부 경로 셋(등록·등록 읽기·판매자 확인).
// 포트원 플랫폼은 대역 서버(공개 명세 모양 [가정]), 토스 지급대행은 F-07-6 전송 포트의 짝 대역이다. 결제사는 부르지 않는다.
// core 쪽(판매 승인 요청이 이 경로를 부르고 승인 조건을 보는 것)은 services/core-svc/test/sale-approval-payout.test.ts·sale-review-request.http.test.ts가 본다.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { OpsIntakeFake } from './support/ops-intake-fake.js';
import { PortonePlatformFake } from './support/portone-platform-fake.js';
import { dumpStore, harness, httpService, kyc, leaks, PORTONE_CONTRACT_ID, PORTONE_SECRET, portonePartner, tossSeller, type Harness } from './support/settlement-portone-harness.js';

const NOW = Date.parse('2026-11-23T01:00:00.000Z');
const ACCOUNT = '11012345678901';
/** PEAKET 은행 코드(토스 두 자리 표)와 포트원 Bank 열거값(payment-gateway.ts 대응표) */
const BANK = '88';
const BANK_ENUM = 'SHINHAN';
const LEGAL = '주식회사 피켓엔터';

const fake = new PortonePlatformFake(PORTONE_SECRET);
const ops = new OpsIntakeFake();
beforeAll(async () => {
  await fake.start();
  await ops.start();
});
afterAll(async () => {
  await fake.close();
  await ops.close();
});
beforeEach(() => {
  fake.reset();
  ops.reset();
});

const input = (promoterId: string, holderName = '(주)피켓엔터') => ({
  promoterId,
  businessType: 'CORPORATE' as const,
  company: { name: LEGAL, representativeName: '김대표', businessRegistrationNumber: '1234567890', email: 'pay@peaket.test', phone: '0212345678' },
  account: { bankCode: BANK, accountNumber: ACCOUNT, holderName },
});
/** 내부 경로 본문(계획 I-03 내부 경로 Zod 모양) */
const httpBody = (promoterId: string, holderName = '(주)피켓엔터') => ({
  promoterId,
  seller: { legalName: LEGAL, representative: '김대표', businessRegNo: '1234567890', businessType: 'CORPORATE', email: 'pay@peaket.test', phone: '0212345678' },
  account: { bankCode: BANK, accountNumber: ACCOUNT, holderName },
});

const on = (): Harness => harness({ now: NOW, portone: fake, toss: true, ops });
const problemOf = (e: unknown): { status?: number; type?: string } => (typeof e === 'object' && e !== null ? (e as { status?: number; type?: string }) : {});

describe('J-T39 지급대행 등록(payment 몫)', () => {
  test('J-T39 ① 예금주 조회 → 포트원 파트너 등록 → 토스 두 상점 셀러 등록이 한 번씩 차례로 나가고, 은행·끝 4자리·portone_partner 한 행·toss_seller 두 행만 남는다 [ASVS v5.0.0-16.2.5]', async () => {
    const h = on();
    const P = randomUUID();
    fake.holder(BANK_ENUM, ACCOUNT, '㈜피켓엔터');
    const order: string[] = [];
    fake.onRequest = (r) => order.push(r.template);
    h.toss!.onCall = (c) => order.push(`toss.${c.method}:${c.pgStore}`);
    const out = await h.settlements.registerPayoutAgencies(input(P));
    expect(out).toEqual({ bankCode: BANK, accountLast4: '8901', holderChecked: true, agencies: { PORTONE: 'REGISTERED', TOSS_STANDARD: 'REGISTERED', TOSS_ESCROW: 'REGISTERED' } });
    expect(order).toEqual(['GET /platform/bank-accounts/{bank}/{accountNumber}/holder', 'POST /platform/partners', 'toss.registerSeller:STANDARD', 'toss.registerSeller:ESCROW']);
    // 포트원 파트너 등록 본문: PEAKET이 정한 파트너 ID·기본 계약·계좌(결제사에만 넘긴다)
    const reg = fake.calls('POST /platform/partners')[0]!.body as { id: string; defaultContractId: string; account: { bank: string; number: string } };
    expect(reg).toMatchObject({ defaultContractId: PORTONE_CONTRACT_ID, account: { bank: BANK_ENUM, number: ACCOUNT } });
    expect([...h.store.portonePartners.values()]).toEqual([expect.objectContaining({ promoterId: P, portonePartnerId: reg.id, contractId: PORTONE_CONTRACT_ID, registeredAt: new Date(NOW) })]);
    expect([...h.store.tossSellers.values()].map((s) => [s.promoterId, s.pgStore, s.status]).sort()).toEqual([
      [P, 'ESCROW', 'PARTIALLY_APPROVED'],
      [P, 'STANDARD', 'PARTIALLY_APPROVED'],
    ]);
    // 토스 셀러 등록에는 계좌가 실렸다(결제사 요청에만)
    for (const c of h.toss!.callsOf('registerSeller')) expect(JSON.stringify(c)).toContain(ACCOUNT);
    const account = h.store.accounts.get(P)!;
    expect(account).toMatchObject({ promoterId: P, bankCode: BANK, accountLast4: '8901', holderVerified: true, agencySyncPending: false });
    expect(account.holdUntil.getTime()).toBeLessThanOrEqual(NOW);
    expect(h.store.kycs.get(P)).toMatchObject({ promoterId: P, status: 'PENDING', legalName: LEGAL, representative: '김대표' });
    // 계좌번호 원문(두 모양)은 저장소·로그·응답 어디에도 없다
    expect(leaks(dumpStore(h.store), ACCOUNT)).toEqual([]);
    expect(leaks(h.log.text(), ACCOUNT)).toEqual([]);
    expect(leaks(JSON.stringify(out), ACCOUNT)).toEqual([]);
  });

  test('J-T39 ② 예금주가 상호·대표자와 다르면 결제사 등록 호출 0번·422 payout-account-holder-mismatch이고 등록 행이 0이다 [ASVS v5.0.0-2.2.3]', async () => {
    const h = on();
    const P = randomUUID();
    fake.holder(BANK_ENUM, ACCOUNT, '피켓엔터테인먼트');
    const err = await h.settlements.registerPayoutAgencies(input(P, '피켓엔터테인먼트')).catch((e: unknown) => e);
    expect(problemOf(err)).toMatchObject({ status: 422, type: expect.stringContaining('payout-account-holder-mismatch') });
    expect(leaks(`${String(err)} ${JSON.stringify(err)}`, ACCOUNT)).toEqual([]);
    expect(fake.calls('GET /platform/bank-accounts/{bank}/{accountNumber}/holder')).toHaveLength(1);
    expect(fake.calls('POST /platform/partners')).toHaveLength(0);
    expect(h.toss!.calls).toEqual([]);
    expect([h.store.accounts.size, h.store.kycs.size, h.store.portonePartners.size, h.store.tossSellers.size]).toEqual([0, 0, 0, 0]);
  });

  test('J-T39 ② 파트너가 적은 예금주가 아니라 결제사 조회 결과로 비교한다(적은 이름이 상호와 같아도 조회가 다르면 422)', async () => {
    const h = on();
    const P = randomUUID();
    fake.holder(BANK_ENUM, ACCOUNT, '다른회사');
    await expect(h.settlements.registerPayoutAgencies(input(P, LEGAL))).rejects.toMatchObject({ status: 422 });
    expect(fake.calls('POST /platform/partners')).toHaveLength(0);
    expect(h.toss!.calls).toEqual([]);
  });

  test('J-T39 ③ 포트원 등록은 성공하고 토스 일반 상점만 실패하면 502·failedAgencies [TOSS_STANDARD]이고, 다시 부르면 일반 상점 등록만 나간다', async () => {
    const h = on();
    const P = randomUUID();
    fake.holder(BANK_ENUM, ACCOUNT, '(주)피켓엔터');
    h.toss!.fail('registerSeller', 'STANDARD', 1);
    const svc = await httpService(h);
    try {
      const first = await svc.http.inject({ method: 'POST', url: '/internal/v1/settlements/payout-registrations', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(httpBody(P)) });
      expect(first.statusCode).toBe(502);
      const problem = JSON.parse(first.payload) as { type: string; failedAgencies: string[] };
      expect(problem.type).toContain('payout-agency-update-failed');
      expect(problem.failedAgencies).toEqual(['TOSS_STANDARD']);
      expect(leaks(first.payload, ACCOUNT)).toEqual([]);
      // 성공한 곳은 남는다(포트원 파트너·에스크로 셀러), 실패한 일반 상점 행은 없다
      expect(h.store.portonePartners.size).toBe(1);
      expect([...h.store.tossSellers.values()].map((s) => s.pgStore)).toEqual(['ESCROW']);
      const before = { partnerPosts: fake.calls('POST /platform/partners').length, escrow: h.toss!.calls.filter((c) => c.pgStore === 'ESCROW').length };
      const second = await svc.http.inject({ method: 'POST', url: '/internal/v1/settlements/payout-registrations', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(httpBody(P)) });
      expect(second.statusCode).toBe(200);
      expect(JSON.parse(second.payload)).toMatchObject({ bankCode: BANK, accountLast4: '8901', holderChecked: true });
      expect(fake.calls('POST /platform/partners')).toHaveLength(before.partnerPosts);
      expect(fake.calls('PATCH /platform/partners/{id}')).toHaveLength(0);
      expect(h.toss!.calls.filter((c) => c.pgStore === 'ESCROW')).toHaveLength(before.escrow);
      expect(h.toss!.callsOf('registerSeller').filter((c) => c.pgStore === 'STANDARD')).toHaveLength(2);
      expect(h.toss!.callsOf('updateSeller')).toEqual([]);
      expect([...h.store.tossSellers.values()].map((s) => s.pgStore).sort()).toEqual(['ESCROW', 'STANDARD']);
    } finally {
      await svc.close();
    }
  });

  test('J-T39 ③ 포트원 파트너 등록만 실패하면 502·failedAgencies [PORTONE]이고 토스 두 상점은 남는다', async () => {
    const h = on();
    const P = randomUUID();
    fake.holder(BANK_ENUM, ACCOUNT, '(주)피켓엔터');
    fake.fault('POST /platform/partners', '5xx', 1);
    const err = await h.settlements.registerPayoutAgencies(input(P)).catch((e: unknown) => e);
    expect(problemOf(err)).toMatchObject({ status: 502, type: expect.stringContaining('payout-agency-update-failed') });
    expect(h.store.portonePartners.size).toBe(0);
    expect([...h.store.tossSellers.values()].map((s) => s.pgStore).sort()).toEqual(['ESCROW', 'STANDARD']);
  });

  test.each([
    ['5xx', '5xx' as const],
    ['응답 없음(연결 끊김)', 'reset' as const],
    ['모양 틀림', 'shape' as const],
  ])('J-T39 ④ 예금주 조회가 %s이면 503 payout-holder-lookup-unavailable이고 아무것도 남지 않는다', async (_name, mode) => {
    const h = on();
    const P = randomUUID();
    fake.holder(BANK_ENUM, ACCOUNT, '(주)피켓엔터');
    fake.fault('GET /platform/bank-accounts/{bank}/{accountNumber}/holder', mode);
    const err = await h.settlements.registerPayoutAgencies(input(P)).catch((e: unknown) => e);
    expect(problemOf(err)).toMatchObject({ status: 503, type: expect.stringContaining('payout-holder-lookup-unavailable') });
    expect(fake.calls('GET /platform/bank-accounts/{bank}/{accountNumber}/holder').length).toBeGreaterThanOrEqual(1);
    expect(fake.calls('POST /platform/partners')).toHaveLength(0);
    expect(h.toss!.calls).toEqual([]);
    expect([h.store.accounts.size, h.store.kycs.size, h.store.portonePartners.size, h.store.tossSellers.size]).toEqual([0, 0, 0, 0]);
    expect(leaks(`${String(err)} ${h.log.text()}`, ACCOUNT)).toEqual([]);
  });

  test('J-T39 ④ 예금주 조회가 없는 계좌(404)면 결제사 등록 없이 422 payout-account-holder-mismatch다', async () => {
    const h = on();
    const P = randomUUID();
    const err = await h.settlements.registerPayoutAgencies(input(P)).catch((e: unknown) => e);
    expect(problemOf(err)).toMatchObject({ status: 422, type: expect.stringContaining('payout-account-holder-mismatch') });
    expect(fake.calls('POST /platform/partners')).toHaveLength(0);
    expect(h.toss!.calls).toEqual([]);
  });

  test('J-T39 ⑤ 포트원 플랫폼이 꺼진 조립은 예금주를 조회하지 않고 holderChecked false·모두 SKIPPED이며 아무것도 쓰지 않는다(토스가 켜져 있어도)', async () => {
    const h = harness({ now: NOW, toss: true, ops });
    const P = randomUUID();
    await expect(h.settlements.registerPayoutAgencies(input(P))).resolves.toEqual({ bankCode: BANK, accountLast4: '8901', holderChecked: false, agencies: { PORTONE: 'SKIPPED', TOSS_STANDARD: 'SKIPPED', TOSS_ESCROW: 'SKIPPED' } });
    expect(fake.requests).toEqual([]);
    expect(h.toss!.calls).toEqual([]);
    expect([h.store.accounts.size, h.store.kycs.size, h.store.portonePartners.size, h.store.tossSellers.size]).toEqual([0, 0, 0, 0]);
  });

  test('J-T39 ⑤ 토스 지급대행이 꺼지고 포트원만 켜진 조립은 토스를 SKIPPED로 두고 포트원만 등록한다', async () => {
    const h = harness({ now: NOW, portone: fake, ops });
    const P = randomUUID();
    fake.holder(BANK_ENUM, ACCOUNT, '(주)피켓엔터');
    await expect(h.settlements.registerPayoutAgencies(input(P))).resolves.toMatchObject({ holderChecked: true, agencies: { PORTONE: 'REGISTERED', TOSS_STANDARD: 'SKIPPED', TOSS_ESCROW: 'SKIPPED' } });
    expect(h.store.tossSellers.size).toBe(0);
    expect(h.store.portonePartners.size).toBe(1);
  });

  test('J-T39 ⑥ 등록이 있던 포트원이 지금 꺼져 있으면 건너뛰지 않고 503 payout-gateway-unavailable이고 토스도 부르지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
    const h = harness({ now: NOW, toss: true, ops });
    const P = randomUUID();
    portonePartner(h.store, P, new Date(NOW - 86_400_000));
    const err = await h.settlements.registerPayoutAgencies(input(P)).catch((e: unknown) => e);
    expect(problemOf(err)).toMatchObject({ status: 503, type: expect.stringContaining('payout-gateway-unavailable') });
    expect(h.toss!.calls).toEqual([]);
    expect(h.store.accounts.size).toBe(0);
  });

  test('J-T39 ⑥ 등록이 있던 토스 셀러의 지급대행이 지금 꺼져 있으면 503이고 포트원 파트너도 등록·수정하지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
    const h = harness({ now: NOW, portone: fake, ops });
    const P = randomUUID();
    fake.holder(BANK_ENUM, ACCOUNT, '(주)피켓엔터');
    tossSeller(h.store, P, 'STANDARD', 'PARTIALLY_APPROVED', new Date(NOW - 86_400_000));
    const err = await h.settlements.registerPayoutAgencies(input(P)).catch((e: unknown) => e);
    expect(problemOf(err)).toMatchObject({ status: 503, type: expect.stringContaining('payout-gateway-unavailable') });
    expect(fake.calls('POST /platform/partners')).toHaveLength(0);
    expect(fake.calls('PATCH /platform/partners/{id}')).toHaveLength(0);
    expect(h.store.portonePartners.size).toBe(0);
    expect(h.store.accounts.size).toBe(0);
  });

  test('J-T39 ⑦ 판매자 확인 내부 경로: seller_kyc가 VERIFIED·상호·대표자·확인 시각으로 쓰이고, 같은 값을 두 번 불러도 행이 그대로다', async () => {
    const h = on();
    const P = randomUUID();
    h.store.kycs.set(P, kyc(P, new Date(NOW - 3_600_000), { status: 'PENDING', legalName: LEGAL, representative: '김대표' }));
    const svc = await httpService(h);
    try {
      const verifiedAt = '2026-11-23T00:30:00.000Z';
      const body = JSON.stringify({ legalName: LEGAL, representative: '김대표', verifiedAt });
      const first = await svc.http.inject({ method: 'PUT', url: `/internal/v1/settlements/promoters/${P}/seller-verification`, headers: { 'content-type': 'application/json' }, payload: body });
      expect(first.statusCode).toBe(200);
      expect(JSON.parse(first.payload)).toEqual({ status: 'VERIFIED' });
      const row = h.store.kycs.get(P)!;
      expect(row).toMatchObject({ promoterId: P, status: 'VERIFIED', businessVerified: true, representativeVerified: true, legalName: LEGAL, representative: '김대표', verifiedAt: new Date(verifiedAt) });
      const snapshot = JSON.stringify(row);
      h.clock.advance(60_000);
      const again = await svc.http.inject({ method: 'PUT', url: `/internal/v1/settlements/promoters/${P}/seller-verification`, headers: { 'content-type': 'application/json' }, payload: body });
      expect(again.statusCode).toBe(200);
      expect(JSON.stringify(h.store.kycs.get(P))).toBe(snapshot);
      // 모양이 틀린 본문은 쓰지 않는다
      const bad = await svc.http.inject({ method: 'PUT', url: `/internal/v1/settlements/promoters/${P}/seller-verification`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ legalName: '', representative: '김대표', verifiedAt }) });
      expect(bad.statusCode).toBe(422);
      expect(JSON.stringify(h.store.kycs.get(P))).toBe(snapshot);
    } finally {
      await svc.close();
    }
  });

  test('J-T39 ⑦ Settlements.verifySeller는 등록 요청이 남긴 PENDING을 VERIFIED로 바꾸고 결과는 { status: VERIFIED }다', async () => {
    const h = on();
    const P = randomUUID();
    fake.holder(BANK_ENUM, ACCOUNT, '(주)피켓엔터');
    await h.settlements.registerPayoutAgencies(input(P));
    expect(h.store.kycs.get(P)?.status).toBe('PENDING');
    const at = new Date('2026-11-23T00:45:00.000Z');
    await expect(h.settlements.verifySeller(P, { legalName: LEGAL, representative: '김대표', verifiedAt: at })).resolves.toEqual({ status: 'VERIFIED' });
    expect(h.store.kycs.get(P)).toMatchObject({ status: 'VERIFIED', businessVerified: true, representativeVerified: true, verifiedAt: at });
  });

  test('J-T39 ⑧ 등록 읽기 내부 경로는 은행·끝 4자리·예금주 확인·켜짐·상점별 셀러 상태·포트원 등록 여부만 주고 셀러 ID·파트너 ID 원문이 없다 [ASVS v5.0.0-14.2.6]', async () => {
    const h = on();
    const P = randomUUID();
    fake.holder(BANK_ENUM, ACCOUNT, '(주)피켓엔터');
    h.toss!.sellerStatus.ESCROW = 'APPROVAL_REQUIRED';
    await h.settlements.registerPayoutAgencies(input(P));
    const svc = await httpService(h);
    try {
      const res = await svc.http.inject({ method: 'GET', url: `/internal/v1/settlements/promoters/${P}/payout-registration` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const view = JSON.parse(res.payload) as Record<string, unknown>;
      expect(view).toEqual({
        payoutAccount: { bankCode: BANK, last4: '8901', holdUntil: null, holderVerified: true },
        agencySyncPending: false,
        tossEnabled: true,
        portoneEnabled: true,
        tossSellers: expect.arrayContaining([
          { pgStore: 'STANDARD', status: 'PARTIALLY_APPROVED' },
          { pgStore: 'ESCROW', status: 'APPROVAL_REQUIRED' },
        ]),
        portonePartnerRegistered: true,
      });
      expect((view.tossSellers as unknown[]).length).toBe(2);
      for (const s of h.store.tossSellers.values()) expect(res.payload).not.toContain(s.tossSellerId);
      for (const p of h.store.portonePartners.values()) expect(res.payload).not.toContain(p.portonePartnerId);
      await expect(h.settlements.getPayoutRegistration(P)).resolves.toEqual(view);
      // 등록이 없는 파트너는 계좌 null·셀러 빈 목록·포트원 미등록
      const none = await svc.http.inject({ method: 'GET', url: `/internal/v1/settlements/promoters/${randomUUID()}/payout-registration` });
      expect(JSON.parse(none.payload)).toEqual({ payoutAccount: null, agencySyncPending: false, tossEnabled: true, portoneEnabled: true, tossSellers: [], portonePartnerRegistered: false });
    } finally {
      await svc.close();
    }
  });

  test('J-T39 ① 등록 내부 경로는 200·no-store·은행·끝 4자리·결제사별 결과이고, 모양 틀림(사업자등록번호 9자리)은 422 invalid-query로 결제사를 부르지 않는다', async () => {
    const h = on();
    const P = randomUUID();
    fake.holder(BANK_ENUM, ACCOUNT, '(주)피켓엔터');
    const svc = await httpService(h);
    try {
      const bad = await svc.http.inject({ method: 'POST', url: '/internal/v1/settlements/payout-registrations', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ ...httpBody(P), seller: { ...httpBody(P).seller, businessRegNo: '123456789' } }) });
      expect(bad.statusCode).toBe(422);
      expect(JSON.parse(bad.payload).type).toContain('invalid-query');
      expect(fake.requests).toEqual([]);
      const ok = await svc.http.inject({ method: 'POST', url: '/internal/v1/settlements/payout-registrations', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(httpBody(P)) });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['cache-control']).toBe('no-store');
      expect(JSON.parse(ok.payload)).toEqual({ bankCode: BANK, accountLast4: '8901', holderChecked: true, agencies: { PORTONE: 'REGISTERED', TOSS_STANDARD: 'REGISTERED', TOSS_ESCROW: 'REGISTERED' } });
      expect(leaks(ok.payload + h.log.text(), ACCOUNT)).toEqual([]);
      const mismatch = await svc.http.inject({ method: 'POST', url: '/internal/v1/settlements/payout-registrations', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ ...httpBody(randomUUID(), '다른회사'), account: { bankCode: '06', accountNumber: '06498765432109', holderName: '다른회사' } }) });
      expect(mismatch.statusCode).toBe(422);
      expect(JSON.parse(mismatch.payload).type).toContain('payout-account-holder-mismatch');
    } finally {
      await svc.close();
    }
  });
});
