// J-T37 ②③④·J-T7 토스 셀러 등록과 결제사·상점별 KYC 보류(F-07-6 LCH-110, settlement §3·§6, ADR-0369 결정 3·4·9).
// 진짜 Settlements·MemorySettlementStore·HttpTossPayoutTransport를 시험 안 대역 서버에 붙인다. 결제사는 부르지 않는다.
// ② 두 상점 등록·행 둘·계좌번호 0건·다시 불러도 한 번·한 상점 실패 뒤 실패한 상점만 ③ 상태는 단건 조회로만
// ④ 셀러 없음·상태 넷은 토스 HELD·KYC, 묶을 수 있는 둘, 다른 상점·포트원 무관 / J-T7 KYC_REQUIRED·APPROVED 반영
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { createHmac, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { ReceiveSettlementWebhook } from '../src/modules/settlement/application/receive-settlement-webhook.js';
import { HttpTossPayoutTransport } from '../src/modules/settlement/adapters/http-toss-payout-transport.js';
import {
  ManualPortonePayoutGateway,
  MemoryReauthVerifier,
  MemorySettlementPaymentSource,
  MemorySettlementStore,
  SettlementModule,
  Settlements,
  UnavailableTossPayoutGateway,
  type TossSellerStatus,
} from '../src/modules/settlement/index.js';
import { quiet } from './settlement-flow-support.js';
import { noApprovals, noSaleSuspensions, seedTossSeller } from './settlement-support.js';
import { configOf, kst, tossHarness, type TossHarness } from './support/toss-harness.js';
import { tossWebhookBody } from './support/toss-payout-fake.js';

const NOW = kst('2026-12-03T10:00:00.000');
const PAYOUT_DATE = '2026-12-07';
const ACCOUNT_NUMBER = '110123456789';

let h: TossHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});
const open = async (o: { noBalance?: boolean } = {}) => (h = await tossHarness({ now: NOW, noBalance: o.noBalance ?? true }));

const registration = (promoterId: string, over: Record<string, unknown> = {}) => ({
  promoterId,
  businessType: 'CORPORATE' as const,
  company: { name: '주식회사 피켓엔터', representativeName: '김대표', businessRegistrationNumber: '1234567890', email: 'settle@peaket.example', phone: '0212345678' },
  account: { bankCode: '004', accountNumber: ACCOUNT_NUMBER, holderName: '주식회사 피켓엔터' },
  ...over,
});

/** 계좌번호 원문이 남을 수 있는 모든 곳(저장소 행·사건·CS 건·감사·로그) */
const everywhere = (x: TossHarness, extra: unknown = null) =>
  JSON.stringify({ sellers: [...x.store.tossSellers.values()], kycs: [...x.store.kycs.values()], accounts: [...x.store.accounts.values()], outbox: x.store.outbox, cases: [...x.store.caseRequests.values()], audits: x.store.statementAudits, lines: x.lines, extra });

describe('J-T37 ② 셀러 등록', () => {
  test('J-T37 ② 두 상점에 한 번씩 등록하고 상점마다 toss_seller 한 행을 남기며, 응답은 은행·끝 4자리와 상점별 상태다 [ASVS v5.0.0-16.2.5]', async () => {
    const x = await open();
    const promoterId = randomUUID();
    const result = await x.settlements.registerTossSellers(registration(promoterId));
    expect(result).toEqual({
      bankCode: '004',
      accountLast4: '6789',
      sellers: [
        { pgStore: 'STANDARD', status: 'PARTIALLY_APPROVED' },
        { pgStore: 'ESCROW', status: 'PARTIALLY_APPROVED' },
      ],
    });
    const posts = x.fake.calls('POST', /^\/v2\/sellers$/);
    expect(posts.map((r) => r.store).sort()).toEqual(['ESCROW', 'STANDARD']);
    // 결제사에는 계좌번호 원문을 그대로 넘긴다(저장하지 않는다)
    expect(posts.map((r) => (r.body as { refSellerId: string; account: { accountNumber: string } })).map((b) => [b.refSellerId, b.account.accountNumber]).sort()).toEqual([
      [`${promoterId}-ESCROW`, ACCOUNT_NUMBER],
      [`${promoterId}-STANDARD`, ACCOUNT_NUMBER],
    ]);
    const fakeIds = Object.fromEntries([...x.fake.sellers.values()].map((s) => [s.store, s.id]));
    expect(x.store.tossSellers.get(`${promoterId}:STANDARD`)).toMatchObject({ promoterId, pgStore: 'STANDARD', tossSellerId: fakeIds.STANDARD, refSellerId: `${promoterId}-STANDARD`, status: 'PARTIALLY_APPROVED', businessType: 'CORPORATE', registeredAt: new Date(NOW) });
    expect(x.store.tossSellers.get(`${promoterId}:ESCROW`)).toMatchObject({ promoterId, pgStore: 'ESCROW', tossSellerId: fakeIds.ESCROW, refSellerId: `${promoterId}-ESCROW`, status: 'PARTIALLY_APPROVED' });
    expect(x.store.tossSellers.size).toBe(2);
    expect(everywhere(x, result)).not.toContain(ACCOUNT_NUMBER);
  });

  test('J-T37 ② 개인사업자는 결제사가 준 APPROVAL_REQUIRED를 그대로 남긴다', async () => {
    const x = await open();
    const promoterId = randomUUID();
    const result = await x.settlements.registerTossSellers(registration(promoterId, { businessType: 'INDIVIDUAL_BUSINESS' }));
    expect(result.sellers).toEqual([
      { pgStore: 'STANDARD', status: 'APPROVAL_REQUIRED' },
      { pgStore: 'ESCROW', status: 'APPROVAL_REQUIRED' },
    ]);
    expect(x.store.tossSellers.get(`${promoterId}:STANDARD`)?.businessType).toBe('INDIVIDUAL_BUSINESS');
  });

  test('J-T37 ② 같은 요청을 다시 보내면 등록 요청이 더 나가지 않고 단건 조회로 상태만 고친다(행은 그대로 둘)', async () => {
    const x = await open();
    const promoterId = randomUUID();
    await x.settlements.registerTossSellers(registration(promoterId));
    const before = new Map(x.store.tossSellers);
    const escrow = [...x.fake.sellers.values()].find((s) => s.store === 'ESCROW')!;
    escrow.status = 'APPROVED';
    x.clock.advance(60_000);
    const again = await x.settlements.registerTossSellers(registration(promoterId));
    expect(x.fake.calls('POST', /^\/v2\/sellers$/)).toHaveLength(2);
    expect(x.fake.calls('GET', /^\/v2\/sellers\//).map((r) => r.path).sort()).toEqual([...x.fake.sellers.values()].map((s) => `/v2/sellers/${s.id}`).sort());
    expect(again.sellers).toEqual([
      { pgStore: 'STANDARD', status: 'PARTIALLY_APPROVED' },
      { pgStore: 'ESCROW', status: 'APPROVED' },
    ]);
    expect(x.store.tossSellers.size).toBe(2);
    expect(x.store.tossSellers.get(`${promoterId}:STANDARD`)?.tossSellerId).toBe(before.get(`${promoterId}:STANDARD`)?.tossSellerId);
    expect(x.store.tossSellers.get(`${promoterId}:ESCROW`)).toMatchObject({ tossSellerId: escrow.id, status: 'APPROVED', statusCheckedAt: new Date(NOW + 60_000), registeredAt: new Date(NOW) });
  });

  test('J-T37 ② 한 상점만 실패하면 성공한 행은 남기고 502 toss-seller-registration-failed이며, 다시 부르면 실패한 상점만 등록한다', async () => {
    const x = await open();
    const promoterId = randomUUID();
    x.fake.inject({ method: 'POST', path: /^\/v2\/sellers$/, store: 'ESCROW' }, { code: 'INVALID_REQUEST', status: 400 });
    let failure: unknown;
    await x.settlements.registerTossSellers(registration(promoterId)).catch((e: unknown) => (failure = e));
    expect(failure).toMatchObject({ status: 502, type: expect.stringContaining('toss-seller-registration-failed') });
    expect(JSON.stringify(failure) + String((failure as Error).message)).not.toContain(ACCOUNT_NUMBER);
    expect([...x.store.tossSellers.keys()]).toEqual([`${promoterId}:STANDARD`]);
    const ok = await x.settlements.registerTossSellers(registration(promoterId));
    const posts = x.fake.calls('POST', /^\/v2\/sellers$/);
    // 처음 둘(STANDARD 성공, ESCROW 주입 실패, 차례는 묻지 않는다) 뒤 다시 부르기는 ESCROW 하나만
    expect(posts).toHaveLength(3);
    expect(posts.slice(0, 2).map((r) => [r.store, r.fault ?? null]).sort()).toEqual([
      ['ESCROW', 'INVALID_REQUEST'],
      ['STANDARD', null],
    ]);
    expect(posts.slice(2).map((r) => [r.store, r.fault ?? null])).toEqual([['ESCROW', null]]);
    expect(x.fake.calls('GET', /^\/v2\/sellers\//).map((r) => r.store)).toEqual(['STANDARD']);
    expect(ok.sellers.map((s) => s.pgStore)).toEqual(['STANDARD', 'ESCROW']);
    expect(x.store.tossSellers.size).toBe(2);
    expect(everywhere(x, failure)).not.toContain(ACCOUNT_NUMBER);
  });

  test('J-T37 ② 결제사가 응답하지 않은 상점도 실패한 상점으로 502다', async () => {
    const x = await open();
    const promoterId = randomUUID();
    x.fake.inject({ method: 'POST', path: /^\/v2\/sellers$/, store: 'STANDARD' }, 'NO_RESPONSE');
    await expect(x.settlements.registerTossSellers(registration(promoterId))).rejects.toMatchObject({ status: 502, type: expect.stringContaining('toss-seller-registration-failed') });
    expect([...x.store.tossSellers.keys()]).toEqual([`${promoterId}:ESCROW`]);
  });

  test('J-T37 ② 설정이 없으면 503 payout-gateway-unavailable이고 행을 만들지 않는다', async () => {
    const store = new MemorySettlementStore();
    const settlements = new Settlements({ store, payments: new MemorySettlementPaymentSource(), approvals: noApprovals, saleSuspensions: noSaleSuspensions, gateways: [new UnavailableTossPayoutGateway()], reauth: new MemoryReauthVerifier(), clock: fakeClock({ now: NOW }) });
    await expect(settlements.registerTossSellers(registration(randomUUID()))).rejects.toMatchObject({ status: 503, type: expect.stringContaining('payout-gateway-unavailable') });
    expect(store.tossSellers.size).toBe(0);
  });

  test('J-T37 ② 본문 모양이 틀리면 422 invalid-query이고 결제사를 부르지 않는다(경계: 계좌번호 6·20자리, 상호 100자는 받는다)', async () => {
    const x = await open();
    const bad: Record<string, unknown>[] = [
      { promoterId: 'not-a-uuid' },
      { businessType: 'INDIVIDUAL' },
      { company: { ...registration('p').company, businessRegistrationNumber: '123456789' } },
      { company: { ...registration('p').company, businessRegistrationNumber: '12345678901' } },
      { company: { ...registration('p').company, businessRegistrationNumber: '123456789a' } },
      { company: { ...registration('p').company, name: '' } },
      { company: { ...registration('p').company, representativeName: '가'.repeat(101) } },
      { company: { ...registration('p').company, email: 'not-an-email' } },
      { account: { ...registration('p').account, accountNumber: '12345' } },
      { account: { ...registration('p').account, accountNumber: '1'.repeat(21) } },
      { account: { ...registration('p').account, accountNumber: '1234-5678' } },
    ];
    for (const over of bad) {
      const body = { ...registration(randomUUID()), ...over };
      // type-escape: 모양이 틀린 본문(내부 HTTP가 받을 수 있는 값)을 쓰임새에 그대로 넣어 422를 본다 F-07-6
      await expect(x.settlements.registerTossSellers(body as Parameters<Settlements['registerTossSellers']>[0]), JSON.stringify(over)).rejects.toMatchObject({ status: 422, type: expect.stringContaining('invalid-query') });
    }
    expect(x.fake.calls('POST', /^\/v2\/sellers$/)).toHaveLength(0);
    for (const accountNumber of ['123456', '1'.repeat(20)]) {
      const r = await x.settlements.registerTossSellers({ ...registration(randomUUID()), account: { ...registration('p').account, accountNumber } });
      expect(r.accountLast4).toBe(accountNumber.slice(-4));
    }
    await x.settlements.registerTossSellers({ ...registration(randomUUID()), company: { ...registration('p').company, name: '가'.repeat(100) } });
    expect(x.fake.calls('POST', /^\/v2\/sellers$/)).toHaveLength(6);
  });

  test('J-T37 ② 내부 경로 POST /internal/v1/settlements/toss-sellers는 200·no-store·은행과 끝 4자리이고, 실패한 상점을 Problem에 싣는다', async () => {
    const x = await open();
    const svc = await createService({
      name: 'payment-svc',
      module: SettlementModule.register({ store: x.store, payments: x.payments, approvals: noApprovals, saleSuspensions: noSaleSuspensions, gateways: [new ManualPortonePayoutGateway(), new UnavailableTossPayoutGateway()], reauth: new MemoryReauthVerifier(), tossTransport: x.transport }),
      env: { PEAKET_ENV: 'ci' },
      clock: x.clock,
      logDestination: quiet(),
    });
    try {
      const post = (body: unknown) => svc.http.inject({ method: 'POST', url: '/internal/v1/settlements/toss-sellers', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });
      const ok = await post(registration(randomUUID()));
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['cache-control']).toContain('no-store');
      expect(JSON.parse(ok.payload)).toEqual({ bankCode: '004', accountLast4: '6789', sellers: [{ pgStore: 'STANDARD', status: 'PARTIALLY_APPROVED' }, { pgStore: 'ESCROW', status: 'PARTIALLY_APPROVED' }] });
      expect(ok.payload).not.toContain(ACCOUNT_NUMBER);
      const bad = await post({ ...registration(randomUUID()), account: { bankCode: '004', accountNumber: '12', holderName: 'x' } });
      expect(bad.statusCode).toBe(422);
      x.fake.inject({ method: 'POST', path: /^\/v2\/sellers$/, store: 'ESCROW' }, { code: 'INVALID_REQUEST', status: 400 });
      const failed = await post(registration(randomUUID()));
      expect(failed.statusCode).toBe(502);
      expect(JSON.parse(failed.payload)).toMatchObject({ type: expect.stringContaining('toss-seller-registration-failed'), status: 502, failedStores: ['ESCROW'] });
      expect(failed.payload).not.toContain(ACCOUNT_NUMBER);
    } finally {
      await svc.close();
    }
  });
});

describe('J-T37 ③ 셀러 상태는 단건 조회로만', () => {
  test('J-T37 ③ seller.changed 본문이 APPROVED여도 단건 조회가 KYC_REQUIRED면 KYC_REQUIRED로 남고, 판매자 확인(seller_kyc)은 바꾸지 않는다', async () => {
    const x = await open();
    const promoterId = randomUUID();
    await x.settlements.registerTossSellers(registration(promoterId));
    await x.settlements.recordKyc(promoterId, 'VERIFIED');
    const std = [...x.fake.sellers.values()].find((s) => s.store === 'STANDARD')!;
    std.status = 'KYC_REQUIRED';
    const receiver = new ReceiveSettlementWebhook({ config: x.config, transport: x.transport, settlements: x.settlements, store: x.store, now: () => new Date(x.clock.now()), log: x.log, signals: x.signals });
    const body = tossWebhookBody('seller.changed', { id: std.id!, status: 'APPROVED' });
    const time = new Date(x.clock.now()).toISOString();
    const signature = `v1:${createHmac('sha256', x.keys.STANDARD.current).update(`${body}:${time}`).digest('base64')}`;
    const answer = await receiver.receive({ 'tosspayments-webhook-signature': signature, 'tosspayments-webhook-transmission-time': time, 'tosspayments-webhook-transmission-id': `tx-${randomUUID()}` }, Buffer.from(body));
    expect(answer).toBe('ACCEPTED');
    expect(x.fake.calls('GET', /^\/v2\/sellers\//).map((r) => [r.path, r.store])).toEqual([[`/v2/sellers/${std.id}`, 'STANDARD']]);
    expect(x.store.tossSellers.get(`${promoterId}:STANDARD`)?.status).toBe('KYC_REQUIRED');
    expect(x.store.tossSellers.get(`${promoterId}:ESCROW`)?.status).toBe('PARTIALLY_APPROVED');
    expect(x.store.kycs.get(promoterId)).toMatchObject({ status: 'VERIFIED', businessVerified: true, representativeVerified: true });
  });
});

describe('J-T37 ④ 결제사·상점별 KYC 보류', () => {
  const batchable = async (status: TossSellerStatus | null, o: { pg?: 'TOSS' | 'PORTONE'; sellerStore?: 'STANDARD' | 'ESCROW' } = {}) => {
    const x = await open();
    const promoterId = randomUUID();
    await x.settlements.recordKyc(promoterId, 'VERIFIED');
    if (status) await seedTossSeller(x.store, promoterId, { pgStore: o.sellerStore ?? 'STANDARD', status });
    const s = await x.confirmed({ promoterId, amount: 3_210_000, payoutDate: PAYOUT_DATE, pg: o.pg ?? 'TOSS' });
    const pg = o.pg ?? 'TOSS';
    const out = await x.settlements
      .createPayoutBatch({ pg, pgStore: 'STANDARD', payoutDate: PAYOUT_DATE, actor: randomUUID(), ...(pg === 'PORTONE' ? { portoneBalance: { amount: 100_000_000, observedAt: new Date(NOW).toISOString() } } : {}) })
      .then((b) => ({ batch: b, error: undefined as unknown }))
      .catch((error: unknown) => ({ batch: undefined, error }));
    await h?.close();
    h = undefined;
    return { ...out, statement: x.store.statements.get(s.statementId)! };
  };

  test('J-T37 ④ 그 상점 셀러가 없거나 APPROVAL_REQUIRED·PENDING·REJECTED·KYC_REQUIRED면 토스 정산서는 HELD·KYC이고 409 payout-kyc-required다', async () => {
    for (const status of [null, 'APPROVAL_REQUIRED', 'PENDING', 'REJECTED', 'KYC_REQUIRED'] as const) {
      const r = await batchable(status);
      expect([status, r.batch, r.error]).toEqual([status, undefined, expect.objectContaining({ status: 409, type: expect.stringContaining('payout-kyc-required') })]);
      expect([status, r.statement.status, r.statement.holdReason, r.statement.payoutBatchId]).toEqual([status, 'HELD', 'KYC', null]);
    }
  });

  test('J-T37 ④ 셀러가 PARTIALLY_APPROVED·APPROVED면 묶인다', async () => {
    for (const status of ['PARTIALLY_APPROVED', 'APPROVED'] as const) {
      const r = await batchable(status);
      expect([status, r.error, r.batch?.statementCount, r.batch?.totalAmount]).toEqual([status, undefined, 1, 3_210_000]);
      expect(r.statement.payoutBatchId).toBe(r.batch?.batchId);
    }
  });

  test('J-T37 ④ 다른 상점(에스크로) 셀러가 APPROVED여도 일반 상점 셀러가 없으면 일반 상점 토스 정산서는 HELD·KYC다', async () => {
    const r = await batchable('APPROVED', { sellerStore: 'ESCROW' });
    expect([r.statement.status, r.statement.holdReason]).toEqual(['HELD', 'KYC']);
  });

  test('J-T37 ④ 포트원 정산서는 토스 셀러가 없어도(KYC_REQUIRED여도) 묶인다', async () => {
    expect((await batchable(null, { pg: 'PORTONE' })).batch?.statementCount).toBe(1);
    expect((await batchable('KYC_REQUIRED', { pg: 'PORTONE' })).batch?.statementCount).toBe(1);
  });

  test('J-T37 ④ 한 토스 묶음에서 셀러가 묶을 수 있는 파트너만 묶이고 나머지는 HELD·KYC로 저장된다', async () => {
    const x = await open();
    const ok = randomUUID();
    const kyc = randomUUID();
    await x.partner(ok, { STANDARD: 'PARTIALLY_APPROVED' });
    await x.partner(kyc, { STANDARD: 'KYC_REQUIRED', ESCROW: 'APPROVED' });
    const a = await x.confirmed({ promoterId: ok, amount: 1_000_000, payoutDate: PAYOUT_DATE });
    const b = await x.confirmed({ promoterId: kyc, amount: 2_000_000, payoutDate: PAYOUT_DATE });
    const batch = await x.settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: PAYOUT_DATE, actor: randomUUID() });
    expect([batch.statementCount, batch.totalAmount]).toEqual([1, 1_000_000]);
    expect(x.store.statements.get(a.statementId)?.payoutBatchId).toBe(batch.batchId);
    expect(x.store.statements.get(b.statementId)).toMatchObject({ status: 'HELD', holdReason: 'KYC', payoutBatchId: null });
  });
});

describe('J-T7 KYC 보류와 해소', () => {
  test('J-T7 KYC_REQUIRED 조회 결과면 그 상점 셀러만 바뀌고 CS SELLER_KYC_REQUIRED 한 건, 토스 정산서만 HELD·포트원·다른 상점은 그대로 묶인다', async () => {
    const x = await open();
    const promoterId = randomUUID();
    const sellers = await x.partner(promoterId, { STANDARD: 'APPROVED', ESCROW: 'APPROVED' });
    const toss = await x.confirmed({ promoterId, amount: 4_000_000, payoutDate: PAYOUT_DATE });
    const escrow = await x.confirmed({ promoterId, amount: 500_000, payoutDate: PAYOUT_DATE, pgStore: 'ESCROW' });
    const portone = await x.confirmed({ promoterId, amount: 700_000, payoutDate: PAYOUT_DATE, pg: 'PORTONE' });
    const checkedAt = new Date(NOW + 1_000);
    await x.settlements.applyTossSellerFact({ pgStore: 'STANDARD', tossSellerId: sellers.STANDARD!, status: 'KYC_REQUIRED', checkedAt });
    await x.settlements.applyTossSellerFact({ pgStore: 'STANDARD', tossSellerId: sellers.STANDARD!, status: 'KYC_REQUIRED', checkedAt });
    expect(x.store.tossSellers.get(`${promoterId}:STANDARD`)).toMatchObject({ status: 'KYC_REQUIRED', statusCheckedAt: checkedAt });
    expect(x.store.tossSellers.get(`${promoterId}:ESCROW`)?.status).toBe('APPROVED');
    expect(x.store.kycs.get(promoterId)?.status).toBe('VERIFIED');
    const kycCases = x.cases('SELLER_KYC_REQUIRED');
    expect(kycCases).toHaveLength(1);
    expect(kycCases[0]).toMatchObject({ kind: 'SELLER_KYC_REQUIRED', sourceId: sellers.STANDARD, requestedAt: null });
    expect(kycCases[0]!.eventKey.startsWith(`seller-kyc:${sellers.STANDARD}:`)).toBe(true);
    expect(await x.metricValue('settlement_seller_kyc_required', { pg: 'TOSS' })).toBe(1);

    await expect(x.settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: PAYOUT_DATE, actor: randomUUID() })).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-kyc-required') });
    expect(x.store.statements.get(toss.statementId)).toMatchObject({ status: 'HELD', holdReason: 'KYC' });
    const e = await x.settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'ESCROW', payoutDate: PAYOUT_DATE, actor: randomUUID() });
    expect([e.statementCount, e.totalAmount]).toEqual([1, 500_000]);
    const p = await x.settlements.createPayoutBatch({ pg: 'PORTONE', pgStore: 'STANDARD', payoutDate: PAYOUT_DATE, portoneBalance: { amount: 10_000_000, observedAt: new Date(NOW).toISOString() }, actor: randomUUID() });
    expect(p.statementCount).toBe(1);
    expect(x.store.statements.get(portone.statementId)?.payoutBatchId).toBe(p.batchId);
    expect(x.store.statements.get(escrow.statementId)?.payoutBatchId).toBe(e.batchId);
  });

  test('J-T7 APPROVED 조회 결과면 그 파트너·상점의 HELD·KYC 토스 정산서만 CONFIRMED(system·toss-seller-approved)로 돌아가 다음 묶음에 든다', async () => {
    const x = await open();
    const promoterId = randomUUID();
    const other = randomUUID();
    const sellers = await x.partner(promoterId, { STANDARD: 'KYC_REQUIRED', ESCROW: 'KYC_REQUIRED' });
    await x.partner(other, { STANDARD: 'KYC_REQUIRED' });
    const held = await x.confirmed({ promoterId, amount: 4_000_000, payoutDate: PAYOUT_DATE });
    const heldEscrow = await x.confirmed({ promoterId, amount: 300_000, payoutDate: PAYOUT_DATE, pgStore: 'ESCROW' });
    const heldOther = await x.confirmed({ promoterId: other, amount: 900_000, payoutDate: PAYOUT_DATE });
    await expect(x.settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: PAYOUT_DATE, actor: randomUUID() })).rejects.toMatchObject({ status: 409 });
    await expect(x.settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'ESCROW', payoutDate: PAYOUT_DATE, actor: randomUUID() })).rejects.toMatchObject({ status: 409 });
    // 같은 파트너·상점이라도 잔액 보류는 셀러 승인으로 풀지 않는다
    const balanceHeld = await x.confirmed({ promoterId, amount: 100_000, payoutDate: '2026-12-08' });
    await x.store.saveStatement({ ...x.store.statements.get(balanceHeld.statementId)!, status: 'HELD', holdReason: 'BALANCE' });
    const audits = x.store.statementAudits.length;

    x.clock.advance(5_000);
    await x.settlements.applyTossSellerFact({ pgStore: 'STANDARD', tossSellerId: sellers.STANDARD!, status: 'APPROVED', checkedAt: new Date(x.clock.now()) });
    expect(x.store.statements.get(held.statementId)).toMatchObject({ status: 'CONFIRMED' });
    expect(x.store.statementAudits.slice(audits)).toEqual([expect.objectContaining({ statementId: held.statementId, fromStatus: 'HELD', toStatus: 'CONFIRMED', reason: 'toss-seller-approved', actor: 'system' })]);
    expect(x.store.statements.get(heldEscrow.statementId)).toMatchObject({ status: 'HELD', holdReason: 'KYC' });
    expect(x.store.statements.get(heldOther.statementId)).toMatchObject({ status: 'HELD', holdReason: 'KYC' });
    expect(x.store.statements.get(balanceHeld.statementId)).toMatchObject({ status: 'HELD', holdReason: 'BALANCE' });
    const batch = await x.settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: PAYOUT_DATE, actor: randomUUID() });
    expect([batch.statementCount, batch.totalAmount]).toEqual([1, 4_000_000]);
  });

  test('J-T7 PEAKET 판매자 확인이 끝나지 않았으면 셀러가 APPROVED여도 HELD·KYC 그대로다', async () => {
    const x = await open();
    const promoterId = randomUUID();
    await x.settlements.recordKyc(promoterId, 'PENDING');
    const seller = await seedTossSeller(x.store, promoterId, { status: 'KYC_REQUIRED' });
    const s = await x.confirmed({ promoterId, amount: 1_500_000, payoutDate: PAYOUT_DATE });
    await x.store.saveStatement({ ...x.store.statements.get(s.statementId)!, status: 'HELD', holdReason: 'KYC' });
    await x.settlements.applyTossSellerFact({ pgStore: 'STANDARD', tossSellerId: seller.tossSellerId, status: 'APPROVED', checkedAt: new Date(NOW) });
    expect(x.store.tossSellers.get(`${promoterId}:STANDARD`)?.status).toBe('APPROVED');
    expect(x.store.statements.get(s.statementId)).toMatchObject({ status: 'HELD', holdReason: 'KYC' });
  });
});

// 설정 모양이 없는 Settlements에도 HttpTossPayoutTransport를 그대로 넣을 수 있는지(조립 짝): 상점 하나만 설정된 전송은 다른 상점 호출을 하지 않는다
describe('J-T37 ② 한 상점만 설정된 경우', () => {
  test('J-T37 ② 설정된 상점이 하나뿐이면 그 상점만 등록하고, 설정되지 않은 상점은 실패한 상점으로 502다', async () => {
    const x = await open();
    const transport = new HttpTossPayoutTransport(configOf(x.keys, ['STANDARD']), { baseUrl: x.fake.url, clock: x.clock });
    const store = new MemorySettlementStore();
    const settlements = new Settlements({ store, payments: new MemorySettlementPaymentSource(), approvals: noApprovals, saleSuspensions: noSaleSuspensions, gateways: [new UnavailableTossPayoutGateway()], reauth: new MemoryReauthVerifier(), clock: x.clock, tossTransport: transport });
    const promoterId = randomUUID();
    await expect(settlements.registerTossSellers(registration(promoterId))).rejects.toMatchObject({ status: 502, type: expect.stringContaining('toss-seller-registration-failed') });
    expect(x.fake.calls('POST', /^\/v2\/sellers$/).map((r) => r.store)).toEqual(['STANDARD']);
    expect([...store.tossSellers.keys()]).toEqual([`${promoterId}:STANDARD`]);
  });
});
