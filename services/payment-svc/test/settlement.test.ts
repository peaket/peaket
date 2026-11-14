// 정산·지급·KYC 단위·HTTP 시험(BUILD_ORDER BAT-610 잔여, FR-062, POL-038·039, ADR-0047·0062).
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { createService, fakeClock, type AdminAuthz, type AdminAuthzPort } from '@peaket/platform';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  calculateEventStatement,
  MemoryReauthVerifier,
  MemorySettlementPaymentSource,
  MemorySettlementStore,
  ManualPortonePayoutGateway,
  SettlementModule,
  Settlements,
  UnavailableTossPayoutGateway,
  type PaymentFact,
} from '../src/modules/settlement/index.js';

const NOW = new Date('2026-11-14T00:00:00.000Z');
const A = randomUUID();
const B = randomUUID();
const EVENT = randomUUID();
const HOLD_EVENT = randomUUID();

class FakeIdentity implements AdminAuthzPort {
  readonly answers = new Map<string, AdminAuthz>();
  async getAdminAuthz(q: { adminAccountId: string; sessionId: string }): Promise<AdminAuthz> {
    return this.answers.get(`${q.adminAccountId}/${q.sessionId}`) ?? { valid: false, role: '' };
  }
  partner(tenantId: string, role: 'partner_admin' | 'partner_member' = 'partner_admin'): Record<string, string> {
    const accountId = randomUUID();
    const sessionId = randomUUID();
    this.answers.set(`${accountId}/${sessionId}`, { valid: true, role, tenantId });
    return { 'x-user-id': accountId, 'x-session-id': sessionId, 'x-user-aud': 'partner', 'x-user-scope': '' };
  }
}

const quiet = () => new Writable({ write(_c, _e, cb) { cb(); } });

const fact = (o: Partial<PaymentFact> = {}): PaymentFact => ({ paymentId: randomUUID(), amount: 10_000, cancelledAmount: 0, status: 'APPROVED', failureCategory: null, ...o });
const kyc = (promoterId: string, status: 'PENDING' | 'VERIFIED' | 'REJECTED') => ({ promoterId, status, businessVerified: status === 'VERIFIED', representativeVerified: status === 'VERIFIED', verifiedAt: status === 'VERIFIED' ? NOW : null, source: 'MANUAL', updatedAt: NOW });

describe('정산 금액 계산', () => {
  test('J-T18 판매 대금·환급·수수료·부가세·지급액을 식대로 계산한다', () => {
    const { record, sources } = calculateEventStatement({
      promoterId: A,
      eventId: EVENT,
      pg: 'TOSS',
      pgStore: 'STANDARD',
      commissionRateBp: 1000,
      payments: [fact({ amount: 30_000_000, cancelledAmount: 2_000_000, status: 'PARTIAL_CANCELED' })],
      kyc: kyc(A, 'VERIFIED'),
      account: undefined,
      now: NOW,
      statementId: randomUUID(),
    });
    expect(record).toMatchObject({ grossAmount: 30_000_000, refundAmount: 2_000_000, commissionAmount: 2_800_000, commissionVat: 280_000, payoutAmount: 24_920_000, status: 'NOTIFIED', payoutDate: '2026-11-20' });
    expect(record.disputeDueAt?.toISOString()).toBe('2026-11-17T00:00:00.000Z');
    expect(sources).toHaveLength(2);
  });

  test('J-T18 지급액이 0이면 CARRIED_OVER이고, KYC 전이면 HELD/KYC다', () => {
    const zero = calculateEventStatement({
      promoterId: A,
      eventId: EVENT,
      pg: 'TOSS',
      pgStore: 'STANDARD',
      commissionRateBp: 1000,
      payments: [fact({ amount: 1000, cancelledAmount: 1000, status: 'CANCELED' })],
      kyc: kyc(A, 'VERIFIED'),
      account: undefined,
      now: NOW,
      statementId: randomUUID(),
    }).record;
    expect(zero).toMatchObject({ payoutAmount: 0, status: 'CARRIED_OVER' });

    const held = calculateEventStatement({
      promoterId: A,
      eventId: EVENT,
      pg: 'TOSS',
      pgStore: 'STANDARD',
      commissionRateBp: 1000,
      payments: [fact()],
      kyc: kyc(A, 'PENDING'),
      account: undefined,
      now: NOW,
      statementId: randomUUID(),
    }).record;
    expect(held).toMatchObject({ status: 'HELD', holdReason: 'KYC' });

    const partialKyc = calculateEventStatement({
      promoterId: A,
      eventId: EVENT,
      pg: 'TOSS',
      pgStore: 'STANDARD',
      commissionRateBp: 1000,
      payments: [fact()],
      kyc: { ...kyc(A, 'VERIFIED'), businessVerified: false },
      account: undefined,
      now: NOW,
      statementId: randomUUID(),
    }).record;
    expect(partialKyc).toMatchObject({ status: 'HELD', holdReason: 'KYC' });
  });
});

describe('정산 HTTP·유스케이스', () => {
  const store = new MemorySettlementStore();
  const payments = new MemorySettlementPaymentSource();
  const identity = new FakeIdentity();
  let svc: Awaited<ReturnType<typeof createService>>;
  let settlements: Settlements;

  @Module({ imports: [SettlementModule.register({ store, payments, gateways: [new ManualPortonePayoutGateway(), new UnavailableTossPayoutGateway()], reauth: new MemoryReauthVerifier() })] })
  class TestModule {}

  beforeEach(async () => {
    await svc?.close();
    store.statements.clear();
    store.sources.clear();
    store.disputes.clear();
    store.batches.clear();
    store.payouts.clear();
    store.kycs.clear();
    store.accounts.clear();
    payments.rows.clear();
    svc = await createService({
      name: 'payment-svc',
      module: TestModule,
      env: { PEAKET_ENV: 'ci' },
      clock: fakeClock({ now: NOW.getTime() }),
      logDestination: quiet(),
      adminAuthz: identity,
    });
    settlements = svc.app.get(Settlements);
    await settlements.recordKyc(A, 'VERIFIED');
    await settlements.recordKyc(B, 'PENDING');
    payments.set(EVENT, 'TOSS', [fact({ amount: 30_000_000, cancelledAmount: 2_000_000, status: 'PARTIAL_CANCELED' })]);
    payments.set(EVENT, 'PORTONE', [fact({ amount: 30_000_000, cancelledAmount: 2_000_000, status: 'PARTIAL_CANCELED' })]);
    payments.set(HOLD_EVENT, 'TOSS', [fact({ amount: 10_000_000, cancelledAmount: 0, status: 'APPROVED' })]);
  });

  const headers = (tenant = A) => ({ ...identity.partner(tenant), 'content-type': 'application/json' });

  test('J-T18 회차 정산서를 계산해 파트너 목록으로 주고, 상품 정산서는 빈 목록이다', async () => {
    const calculated = await settlements.calculateEvent({ promoterId: A, eventId: EVENT, pg: 'TOSS', pgStore: 'STANDARD' });
    expect(calculated.status).toBe('NOTIFIED');
    const again = await settlements.calculateEvent({ promoterId: A, eventId: EVENT, pg: 'TOSS', pgStore: 'STANDARD' });
    expect(again.statementId).toBe(calculated.statementId);
    const event = await svc.http.inject({ method: 'GET', url: `/v1/partner/events/${EVENT}/settlements`, headers: headers() });
    expect(event.statusCode).toBe(200);
    expect(JSON.parse(event.payload)).toHaveLength(1);
    expect(event.headers['cache-control']).toBe('no-store');
    const product = await svc.http.inject({ method: 'GET', url: '/v1/partner/product-settlements?limit=20', headers: headers() });
    expect(JSON.parse(product.payload)).toEqual({ items: [], nextCursor: null, awaitingSettlementAmount: 0 });
    const other = await svc.http.inject({ method: 'GET', url: `/v1/partner/events/${EVENT}/settlements`, headers: headers(B) });
    expect(JSON.parse(other.payload)).toEqual([]);
  });

  test('이의는 파트너 관리자만, 기간 안에, OTHER는 설명과 함께 받는다', async () => {
    const s = await settlements.calculateEvent({ promoterId: A, eventId: EVENT, pg: 'TOSS', pgStore: 'STANDARD' });
    const url = `/v1/partner/settlements/${s.statementId}/disputes`;
    const key = randomUUID();
    const noDetail = await svc.http.inject({ method: 'POST', url, headers: { ...headers(), 'idempotency-key': key }, payload: JSON.stringify({ reasonCode: 'OTHER' }) });
    expect(noDetail.statusCode).toBe(422);
    const ok = await svc.http.inject({ method: 'POST', url, headers: { ...headers(), 'idempotency-key': randomUUID() }, payload: JSON.stringify({ reasonCode: 'GROSS_AMOUNT' }) });
    expect(ok.statusCode).toBe(202);
    const again = await svc.http.inject({ method: 'POST', url, headers: { ...headers(), 'idempotency-key': randomUUID() }, payload: JSON.stringify({ reasonCode: 'GROSS_AMOUNT' }) });
    expect(again.statusCode).toBe(409);
    const missing = await svc.http.inject({ method: 'POST', url, headers: headers() });
    expect(missing.statusCode).toBe(400);
    const other = await svc.http.inject({ method: 'POST', url, headers: { ...headers(B), 'idempotency-key': randomUUID() }, payload: JSON.stringify({ reasonCode: 'GROSS_AMOUNT' }) });
    expect(other.statusCode).toBe(404);
  });

  test('정산 계좌 변경은 If-Match·패스키 재인증이 필요하고 계좌 원문을 저장하지 않는다', async () => {
    const body = { bankCode: '004', accountNumber: '98765432101234', holderName: '주식회사 에이' };
    const invalid = await svc.http.inject({ method: 'PUT', url: '/v1/partner/payout-account', headers: { ...headers(), 'if-match': '"0"', 'x-reauth-token': 'test-reauth' }, payload: JSON.stringify({ ...body, accountNumber: '123' }) });
    expect(invalid.statusCode).toBe(422);
    const missing = await svc.http.inject({ method: 'PUT', url: '/v1/partner/payout-account', headers: { ...headers(), 'if-match': '"0"' }, payload: JSON.stringify(body) });
    expect(missing.statusCode).toBe(403);
    const ok = await svc.http.inject({ method: 'PUT', url: '/v1/partner/payout-account', headers: { ...headers(), 'if-match': '"0"', 'x-reauth-token': 'test-reauth' }, payload: JSON.stringify(body) });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.payload)).toMatchObject({ bankCode: '004', payoutAccountLast4: '1234', version: 1 });
    expect(JSON.parse(ok.payload).holdUntil).toBe('2026-11-18T00:00:00.000Z');
    const stale = await svc.http.inject({ method: 'PUT', url: '/v1/partner/payout-account', headers: { ...headers(), 'if-match': '"0"', 'x-reauth-token': 'test-reauth' }, payload: JSON.stringify(body) });
    expect(stale.statusCode).toBe(412);
    const hs = await settlements.calculateEvent({ promoterId: A, eventId: HOLD_EVENT, pg: 'TOSS', pgStore: 'STANDARD' });
    await store.saveStatement({ ...(await store.findStatementById(hs.statementId))!, status: 'CONFIRMED' });
    await expect(settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: hs.payoutDate!, actor: randomUUID() })).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-account-change-hold') });
    const stored = store.accounts.get(A)!;
    expect(stored.accountLast4).toBe('1234');
    expect(JSON.stringify(stored)).not.toContain('98765432101234');
  });

  test('J-T18 지급 묶음은 KYC·잔액을 보고, 포트원은 수기 실행으로 SUBMITTED가 된다', async () => {
    const s = await settlements.calculateEvent({ promoterId: A, eventId: EVENT, pg: 'PORTONE', pgStore: 'STANDARD' });
    await store.saveStatement({ ...(await store.findStatementById(s.statementId))!, status: 'CONFIRMED' });
    await expect(settlements.createPayoutBatch({ pg: 'PORTONE', pgStore: 'STANDARD', payoutDate: s.payoutDate!, portoneBalance: { amount: 1, observedAt: NOW.toISOString() }, actor: randomUUID() })).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-balance-insufficient') });
    const batch = await settlements.createPayoutBatch({ pg: 'PORTONE', pgStore: 'STANDARD', payoutDate: s.payoutDate!, portoneBalance: { amount: s.payoutAmount, observedAt: NOW.toISOString() }, actor: randomUUID() });
    expect(batch.status).toBe('PENDING_APPROVAL');
    await expect(settlements.executeBatch(batch.batchId)).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-batch-not-approved') });
    const approved = await settlements.approveBatch(batch.batchId, randomUUID());
    expect(approved.status).toBe('APPROVED');
    await expect(settlements.approveBatch(batch.batchId, randomUUID())).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-batch-not-approved') });
    const executed = await settlements.executeBatch(batch.batchId);
    expect(executed.status).toBe('SUBMITTED');
    await store.savePayoutBatch({ ...(await store.findPayoutBatch(batch.batchId))!, status: 'APPROVED' });
    expect((await settlements.executeBatch(batch.batchId)).status).toBe('SUBMITTED');
    const payouts = await store.listPayouts(batch.batchId);
    expect(payouts).toHaveLength(1);
    expect(payouts.map((p) => p.status)).toEqual(['REQUESTED']);
    await expect(settlements.retryPayout(payouts[0]!.payoutId)).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-not-retryable') });
    await store.savePayout({ ...payouts[0]!, status: 'FAILED', errorCode: 'PG_ERROR' });
    const retried = await settlements.retryPayout(payouts[0]!.payoutId);
    expect(retried).toMatchObject({ seq: 2, refPayoutId: `${s.statementId}-2`, status: 'REQUESTED' });
    expect((await store.findStatementById(s.statementId))?.status).toBe('SCHEDULED');
  });

  test('KYC가 없으면 지급 묶음은 409 payout-kyc-required다', async () => {
    const s = await settlements.calculateEvent({ promoterId: B, eventId: EVENT, pg: 'TOSS', pgStore: 'STANDARD' });
    await store.saveStatement({ ...(await store.findStatementById(s.statementId))!, status: 'CONFIRMED' });
    await expect(settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: s.payoutDate!, actor: randomUUID() })).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-kyc-required') });
  });

  test('토스 지급대행 어댑터가 없으면 실행은 503이고 묶음은 승인 상태로 남는다', async () => {
    const s = await settlements.calculateEvent({ promoterId: A, eventId: EVENT, pg: 'TOSS', pgStore: 'STANDARD' });
    await store.saveStatement({ ...(await store.findStatementById(s.statementId))!, status: 'CONFIRMED' });
    const batch = await settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: s.payoutDate!, actor: randomUUID() });
    await settlements.approveBatch(batch.batchId, randomUUID());
    await expect(settlements.executeBatch(batch.batchId)).rejects.toMatchObject({ status: 503, type: expect.stringContaining('payout-gateway-unavailable') });
    expect((await store.findPayoutBatch(batch.batchId))?.status).toBe('APPROVED');
  });
});
