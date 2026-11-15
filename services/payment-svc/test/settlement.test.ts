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
  SettlementDueWorker,
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

  test('A1-H3 CANCELED 전액 취소는 매출 0·환급 원금 전액·지급 0이다', () => {
    const { record } = calculateEventStatement({
      promoterId: A,
      eventId: EVENT,
      pg: 'TOSS',
      pgStore: 'STANDARD',
      commissionRateBp: 1000,
      payments: [fact({ amount: 10_000, cancelledAmount: 0, status: 'CANCELED' })],
      kyc: kyc(A, 'VERIFIED'),
      account: undefined,
      now: NOW,
      statementId: randomUUID(),
    });
    expect(record).toMatchObject({ grossAmount: 0, refundAmount: 10_000, commissionAmount: 0, commissionVat: 0, payoutAmount: 0, status: 'CARRIED_OVER' });
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

  @Module({ imports: [SettlementModule.register({ store, payments, eventCommission: { rateBp: async () => 1000 }, gateways: [new ManualPortonePayoutGateway(), new UnavailableTossPayoutGateway()], reauth: new MemoryReauthVerifier() })] })
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
    expect((await settlements.approveBatch(batch.batchId, approved.approvalId!)).status).toBe('APPROVED');
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

  test('CONS-01 같은 회차를 동시에 계산해도 정산서와 원본 목록은 한 장만 남는다', async () => {
    const [first, second] = await Promise.all([
      settlements.calculateEvent({ promoterId: A, eventId: EVENT, pg: 'TOSS', pgStore: 'STANDARD' }),
      settlements.calculateEvent({ promoterId: A, eventId: EVENT, pg: 'TOSS', pgStore: 'STANDARD' }),
    ]);
    expect(second.statementId).toBe(first.statementId);
    expect(store.statements.size).toBe(1);
    expect(store.sources.size).toBe(1);
  });

  test('A1-H2 같은 회차라도 STANDARD와 ESCROW 결제는 각 정산서에 한 번씩만 잡힌다', async () => {
    const standard = fact({ amount: 10_000_000 });
    const escrow = fact({ amount: 7_000_000 });
    payments.set(EVENT, 'TOSS', [standard], 'STANDARD');
    payments.set(EVENT, 'TOSS', [escrow], 'ESCROW');
    const a = await settlements.calculateEvent({ promoterId: A, eventId: EVENT, pg: 'TOSS', pgStore: 'STANDARD' });
    const b = await settlements.calculateEvent({ promoterId: A, eventId: EVENT, pg: 'TOSS', pgStore: 'ESCROW' });
    expect(a.grossAmount).toBe(10_000_000);
    expect(b.grossAmount).toBe(7_000_000);
    expect(store.statements.size).toBe(2);
  });

  test('CONS-02 승인 뒤 새로 확정된 정산서는 실행에 끼지 않고, 묶인 정산서만 지급한다', async () => {
    const s = await settlements.calculateEvent({ promoterId: A, eventId: EVENT, pg: 'PORTONE', pgStore: 'STANDARD' });
    await store.saveStatement({ ...(await store.findStatementById(s.statementId))!, status: 'CONFIRMED' });
    const batch = await settlements.createPayoutBatch({ pg: 'PORTONE', pgStore: 'STANDARD', payoutDate: s.payoutDate!, portoneBalance: { amount: s.payoutAmount, observedAt: NOW.toISOString() }, actor: randomUUID() });
    expect((await store.findStatementById(s.statementId))?.status).toBe('SCHEDULED');
    expect((await store.listConfirmed('PORTONE', 'STANDARD', s.payoutDate!))).toHaveLength(0);

    const extraEvent = randomUUID();
    const extra = calculateEventStatement({
      promoterId: A,
      eventId: extraEvent,
      pg: 'PORTONE',
      pgStore: 'STANDARD',
      commissionRateBp: 1000,
      payments: [fact({ amount: 5_000_000 })],
      kyc: kyc(A, 'VERIFIED'),
      account: undefined,
      now: NOW,
      statementId: randomUUID(),
    });
    await store.insertStatement({ ...extra.record, status: 'CONFIRMED', payoutDate: s.payoutDate }, extra.sources);

    await settlements.approveBatch(batch.batchId, randomUUID());
    expect((await settlements.executeBatch(batch.batchId)).status).toBe('SUBMITTED');
    const payouts = await store.listPayouts(batch.batchId);
    expect(payouts.map((p) => p.statementId)).toEqual([s.statementId]);
    expect((await store.findStatementById(extra.record.statementId))?.status).toBe('CONFIRMED');
  });

  test('CONS-02 묶인 정산서 합계가 승인 금액과 다르면 409 payout-batch-amount-mismatch다', async () => {
    const s = await settlements.calculateEvent({ promoterId: A, eventId: EVENT, pg: 'TOSS', pgStore: 'STANDARD' });
    await store.saveStatement({ ...(await store.findStatementById(s.statementId))!, status: 'CONFIRMED' });
    const batch = await settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: s.payoutDate!, actor: randomUUID() });
    await settlements.approveBatch(batch.batchId, randomUUID());
    await store.saveStatement({ ...(await store.findStatementById(s.statementId))!, payoutAmount: s.payoutAmount + 1 });
    await expect(settlements.executeBatch(batch.batchId)).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-batch-amount-mismatch') });
    expect(await store.listPayouts(batch.batchId)).toHaveLength(0);
  });

  test('CONS-02 승인 금액의 25%를 더 지급하려 하면 409로 멈춘다', async () => {
    const s = await settlements.calculateEvent({ promoterId: A, eventId: EVENT, pg: 'TOSS', pgStore: 'STANDARD' });
    await store.saveStatement({ ...(await store.findStatementById(s.statementId))!, status: 'CONFIRMED' });
    const batch = await settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: s.payoutDate!, actor: randomUUID() });
    await settlements.approveBatch(batch.batchId, randomUUID());
    await store.saveStatement({ ...(await store.findStatementById(s.statementId))!, payoutAmount: Math.floor(s.payoutAmount * 1.25) });
    await expect(settlements.executeBatch(batch.batchId)).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-batch-amount-mismatch') });
  });

  test('CONS-02 두 요청이 동시에 배치를 만들면 한쪽만 성공한다', async () => {
    const s = await settlements.calculateEvent({ promoterId: A, eventId: EVENT, pg: 'PORTONE', pgStore: 'STANDARD' });
    await store.saveStatement({ ...(await store.findStatementById(s.statementId))!, status: 'CONFIRMED' });
    const input = { pg: 'PORTONE' as const, pgStore: 'STANDARD' as const, payoutDate: s.payoutDate!, portoneBalance: { amount: s.payoutAmount, observedAt: NOW.toISOString() }, actor: randomUUID() };
    const results = await Promise.allSettled([settlements.createPayoutBatch(input), settlements.createPayoutBatch(input)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', reason: { status: 409 } });
    expect(await store.listPayoutBatches({ pg: 'PORTONE', pgStore: 'STANDARD', payoutDate: s.payoutDate!, limit: 10 })).toHaveLength(1);
  });

  test('A2-05 HELD·DISPUTED는 다시 CONFIRMED가 되고 PAID·SCHEDULED는 건드리지 않는다', async () => {
    const held = await settlements.calculateEvent({ promoterId: B, eventId: HOLD_EVENT, pg: 'TOSS', pgStore: 'STANDARD' });
    expect(held.status).toBe('HELD');
    await expect(settlements.reconfirmStatement(held.statementId)).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-kyc-required') });
    await settlements.recordKyc(B, 'VERIFIED');
    expect((await settlements.reconfirmStatement(held.statementId)).status).toBe('CONFIRMED');

    const disputed = await settlements.calculateEvent({ promoterId: A, eventId: EVENT, pg: 'TOSS', pgStore: 'STANDARD' });
    await store.saveStatement({ ...(await store.findStatementById(disputed.statementId))!, status: 'DISPUTED' });
    const viaHttp = await svc.http.inject({ method: 'POST', url: `/internal/v1/settlements/statements/${disputed.statementId}/reconfirm` });
    expect(viaHttp.statusCode).toBe(200);
    expect(JSON.parse(viaHttp.payload)).toMatchObject({ status: 'CONFIRMED' });

    await store.saveStatement({ ...(await store.findStatementById(disputed.statementId))!, status: 'SCHEDULED' });
    await expect(settlements.reconfirmStatement(disputed.statementId)).rejects.toMatchObject({ status: 409, type: expect.stringContaining('settlement-not-reconfirmable') });
    expect((await store.findStatementById(disputed.statementId))?.status).toBe('SCHEDULED');
  });

  test('A1-H7 예금주를 KYC 상호·대표자와 대조하고 미확인 계좌는 지급을 막는다', async () => {
    await settlements.recordKyc(A, 'VERIFIED', { legalName: '주식회사 에이', representative: '김대표' });
    const saved = await settlements.putPayoutAccount(A, 'sid', { bankCode: '004', accountNumber: '98765432101234', holderName: '㈜에이' }, '"0"', 'test-reauth');
    expect(saved.holderVerified).toBe(true);
    const mismatch = await settlements.putPayoutAccount(A, 'sid', { bankCode: '004', accountNumber: '98765432101234', holderName: '다른회사' }, '"1"', 'test-reauth');
    expect(mismatch.holderVerified).toBe(false);

    const s = await settlements.calculateEvent({ promoterId: A, eventId: EVENT, pg: 'TOSS', pgStore: 'STANDARD' });
    await store.saveStatement({ ...(await store.findStatementById(s.statementId))!, status: 'CONFIRMED' });
    await store.savePayoutAccount({ ...(await store.findPayoutAccount(A))!, holdUntil: new Date(NOW.getTime() - 1), holderVerified: false });
    await expect(settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: s.payoutDate!, actor: randomUUID() })).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-account-mismatch') });
  });

  test('A1-H10 회차 수수료율이 없으면 임의 10% 대신 503으로 닫는다', async () => {
    const store2 = new MemorySettlementStore();
    store2.kycs.set(A, kyc(A, 'VERIFIED'));
    const payments2 = new MemorySettlementPaymentSource();
    payments2.set(EVENT, 'TOSS', [fact({ amount: 10_000_000 })]);
    const svc2 = new Settlements({ store: store2, payments: payments2, gateways: [new ManualPortonePayoutGateway(), new UnavailableTossPayoutGateway()], reauth: new MemoryReauthVerifier(), clock: fakeClock({ now: NOW.getTime() }) });
    await expect(svc2.calculateEvent({ promoterId: A, eventId: EVENT, pg: 'TOSS', pgStore: 'STANDARD' })).rejects.toMatchObject({ status: 503, type: expect.stringContaining('event-commission-rate-unavailable') });
    expect(store2.statements.size).toBe(0);
  });

  test('A2-06 내부 회차 정산 경로가 실제 정산서를 만든다', async () => {
    const res = await svc.http.inject({
      method: 'POST',
      url: '/internal/v1/settlements/event-calculations',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ promoterId: A, eventId: EVENT, pg: 'TOSS', pgStore: 'STANDARD' }),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toMatchObject({ kind: 'EVENT', status: 'NOTIFIED', payoutAmount: 24_920_000 });
    expect(store.statements.size).toBe(1);
  });

  test('A2-06 스케줄러는 리더일 때만 회차 종료 5영업일 뒤 회차를 계산한다', async () => {
    const store2 = new MemorySettlementStore();
    store2.kycs.set(A, kyc(A, 'VERIFIED'));
    const payments2 = new MemorySettlementPaymentSource();
    payments2.set(EVENT, 'TOSS', [fact({ amount: 10_000_000 })]);
    let through: string | undefined;
    const settlements2 = new Settlements({
      store: store2,
      payments: payments2,
      events: {
        async listDue(t) {
          through = t;
          return [{ promoterId: A, eventId: EVENT, endsAt: '2026-11-08T00:00:00.000Z' }];
        },
      },
      eventCommission: { rateBp: async () => 1000 },
      gateways: [new ManualPortonePayoutGateway(), new UnavailableTossPayoutGateway()],
      reauth: new MemoryReauthVerifier(),
      clock: fakeClock({ now: NOW.getTime() }),
    });
    let leader = false;
    const worker = new SettlementDueWorker({ settlements: settlements2, leader: { isLeader: () => leader }, clock: fakeClock({ now: NOW.getTime() }) });
    await worker.tick();
    expect(store2.statements.size).toBe(0);
    leader = true;
    await worker.tick();
    expect(through).toBe('2026-11-09');
    expect(store2.statements.size).toBe(1);
  });

  test('CONS-V02 배치를 풀면 정산서가 CONFIRMED로 돌아가 같은 지급일 새 배치를 만들 수 있다', async () => {
    const s = await settlements.calculateEvent({ promoterId: A, eventId: EVENT, pg: 'PORTONE', pgStore: 'STANDARD' });
    await store.saveStatement({ ...(await store.findStatementById(s.statementId))!, status: 'CONFIRMED' });
    const input = { pg: 'PORTONE' as const, pgStore: 'STANDARD' as const, payoutDate: s.payoutDate!, portoneBalance: { amount: s.payoutAmount, observedAt: NOW.toISOString() }, actor: randomUUID() };
    const batch = await settlements.createPayoutBatch(input);
    expect(await settlements.releasePayoutBatch(batch.batchId)).toEqual({ released: true });
    expect((await store.findStatementById(s.statementId))?.status).toBe('CONFIRMED');
    expect((await store.findStatementById(s.statementId))?.payoutBatchId).toBeNull();
    expect((await settlements.createPayoutBatch(input)).batchId).not.toBe(batch.batchId);
  });

  test('KYC가 없으면 지급 묶음은 409 payout-kyc-required다', async () => {
    const s = await settlements.calculateEvent({ promoterId: B, eventId: EVENT, pg: 'TOSS', pgStore: 'STANDARD' });
    await store.saveStatement({ ...(await store.findStatementById(s.statementId))!, status: 'CONFIRMED' });
    await expect(settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: s.payoutDate!, actor: randomUUID() })).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-kyc-required') });
  });
});

describe('상품 정산·미수금 상계', () => {
  const store = new MemorySettlementStore();
  const payments = new MemorySettlementPaymentSource();
  const products = {
    rows: [] as import('../src/modules/settlement/index.js').ProductSettlementItem[],
    async listProductItems(from: string, to: string) {
      return this.rows.filter((r) => r.basisDate >= from && r.basisDate <= to);
    },
  };
  const svc = new Settlements({ store, payments, products, eventCommission: { rateBp: async () => 1000 }, gateways: [new ManualPortonePayoutGateway(), new UnavailableTossPayoutGateway()], reauth: new MemoryReauthVerifier(), clock: fakeClock({ now: NOW.getTime() }) });

  const productItem = (o: Partial<import('../src/modules/settlement/index.js').ProductSettlementItem> = {}) => ({
    itemId: randomUUID(),
    orderId: randomUUID(),
    promoterId: A,
    eventId: null,
    pg: 'TOSS' as const,
    pgStore: 'STANDARD' as const,
    productId: randomUUID(),
    productName: '응원봉',
    quantity: 2,
    grossAmount: 30_000,
    refundedAmount: 0,
    commissionRateBp: 1000,
    basisDate: '2026-11-09',
    returnStatus: 'DELIVERED',
    eventEndsAt: null,
    ...o,
  });

  beforeEach(() => {
    store.statements.clear();
    store.sources.clear();
    store.receivables.clear();
    store.receivableMoves.length = 0;
    products.rows = [];
    store.kycs.set(A, kyc(A, 'VERIFIED'));
  });

  test('J-T18 상품 정산서는 항목별 수수료율로 계산하고 지급일이 4영업일 뒤다', async () => {
    products.rows = [productItem({ grossAmount: 30_000, refundedAmount: 0, commissionRateBp: 1000 }), productItem({ itemId: randomUUID(), grossAmount: 20_000, refundedAmount: 2_000, commissionRateBp: 500 })];
    const out = await svc.calculateProduct({ periodStart: '2026-11-09', periodEnd: '2026-11-15' });
    expect(out.created).toBe(1);
    expect(out.items[0]).toMatchObject({ kind: 'PRODUCT', grossAmount: 50_000, refundAmount: 2_000, commissionAmount: 3_900, commissionVat: 390, payoutAmount: 43_710, status: 'NOTIFIED', payoutDate: '2026-11-19' });
    // 같은 주를 다시 계산하지 않는다
    expect((await svc.calculateProduct({ periodStart: '2026-11-09', periodEnd: '2026-11-15' })).created).toBe(0);
    // 동시에 계산해도 상품 정산서는 한 장만 남는다(CONS-01)
    store.statements.clear();
    store.sources.clear();
    const [one, two] = await Promise.all([svc.calculateProduct({ periodStart: '2026-11-09', periodEnd: '2026-11-15' }), svc.calculateProduct({ periodStart: '2026-11-09', periodEnd: '2026-11-15' })]);
    expect(one.created + two.created).toBe(1);
    expect(store.statements.size).toBe(1);
    // KYC가 없으면 HELD
    store.kycs.delete(A);
    products.rows = [productItem({ itemId: randomUUID(), promoterId: B })];
    const held = await svc.calculateProduct({ periodStart: '2026-11-09', periodEnd: '2026-11-15' });
    expect(held.items[0]).toMatchObject({ status: 'HELD', holdReason: 'KYC' });
  });

  test('M1-F2 배상금 미리 지급 미수금은 다른 결제사 정산서에서도 상계된다', async () => {
    payments.set(HOLD_EVENT, 'PORTONE', [fact({ amount: 10_000_000 })]);
    const calculated = await svc.calculateEvent({ promoterId: A, eventId: HOLD_EVENT, pg: 'PORTONE', pgStore: 'STANDARD' });
    await store.saveStatement({ ...(await store.findStatementById(calculated.statementId))!, status: 'CONFIRMED' });
    const r = await svc.recordReceivable({ promoterId: A, pg: 'TOSS', cause: 'COMPENSATION_ADVANCE', amount: 445_000 });
    const batch = await svc.createPayoutBatch({ pg: 'PORTONE', pgStore: 'STANDARD', payoutDate: calculated.payoutDate!, portoneBalance: { amount: calculated.payoutAmount, observedAt: NOW.toISOString() }, actor: randomUUID() });
    expect(batch.totalAmount).toBe(calculated.payoutAmount - 445_000);
    expect(store.receivables.get(r.receivableId)).toMatchObject({ remaining: 0, status: 'CLOSED' });
  });

  test('M1-F3 이의 기간이 끝난 NOTIFIED만 자동 확정하고 DISPUTED는 두지 않는다', async () => {
    payments.set(EVENT, 'TOSS', [fact({ amount: 10_000_000 })]);
    const s = await svc.calculateEvent({ promoterId: A, eventId: EVENT, pg: 'TOSS', pgStore: 'STANDARD' });
    expect((await svc.confirmDueStatements()).confirmed).toBe(0);
    await store.saveStatement({ ...(await store.findStatementById(s.statementId))!, disputeDueAt: new Date(NOW.getTime() - 1) });
    expect((await svc.confirmDueStatements()).confirmed).toBe(1);
    expect((await store.findStatementById(s.statementId))?.status).toBe('CONFIRMED');

    const disputed = await svc.calculateEvent({ promoterId: A, eventId: randomUUID(), pg: 'TOSS', pgStore: 'STANDARD' });
    await store.saveStatement({ ...(await store.findStatementById(disputed.statementId))!, status: 'DISPUTED', disputeDueAt: new Date(NOW.getTime() - 1) });
    expect((await svc.confirmDueStatements()).confirmed).toBe(0);
    expect((await store.findStatementById(disputed.statementId))?.status).toBe('DISPUTED');
  });

  test('J-T18 미수금은 같은 결제사의 다음 지급에서 상계되고 이동 기록이 남는다', async () => {
    payments.set(HOLD_EVENT, 'TOSS', [fact({ amount: 10_000_000, cancelledAmount: 0, status: 'APPROVED' })]);
    const calculated = await svc.calculateEvent({ promoterId: A, eventId: HOLD_EVENT, pg: 'TOSS', pgStore: 'STANDARD' });
    await store.saveStatement({ ...(await store.findStatementById(calculated.statementId))!, status: 'CONFIRMED' });
    const r = await svc.recordReceivable({ promoterId: A, pg: 'TOSS', cause: 'REFUND_AFTER_PAYOUT', amount: 445_000 });
    const batch = await svc.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: calculated.payoutDate!, actor: randomUUID() });
    expect(batch.totalAmount).toBe(calculated.payoutAmount - 445_000);
    expect(store.receivables.get(r.receivableId)).toMatchObject({ remaining: 0, status: 'CLOSED' });
    const moves = await store.listReceivableMoves(calculated.statementId);
    expect(moves).toEqual([expect.objectContaining({ receivableId: r.receivableId, amount: 445_000 })]);
    const after = await store.findStatementById(calculated.statementId);
    expect(after).toMatchObject({ offsetAmount: 445_000, payoutAmount: calculated.payoutAmount - 445_000 });
  });
});
