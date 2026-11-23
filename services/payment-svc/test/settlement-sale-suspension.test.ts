// R-T23 ② 판매 중지된 공연 회차의 정산서 지급 보류(BAT-625 LCH-100, ADR-0123, settlement §6·§12).
// 묶음을 만들 때 중지된 회차를 HELD/SALE_SUSPENDED로 빼고, 실행 직전에도 다시 확인하며,
// 재확정은 증빙 플래그만 믿지 않고 core의 판매 재개를 다시 본다. core가 답하지 않으면 503이고 아무것도 바꾸지 않는다.
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { Settlements } from '../src/modules/settlement/application/settlements.js';
import { SettlementProblem, payoutBatchView, type PaymentFact } from '../src/modules/settlement/domain/settlement.js';
import type { PayoutApprovalVerifier, PayoutGateway, SaleSuspensionSource, VerifiedPayoutApproval } from '../src/modules/settlement/domain/ports.js';
import { MemoryReauthVerifier, MemorySettlementPaymentSource, MemorySettlementStore } from '../src/modules/settlement/index.js';
import { HttpSaleSuspensionSource } from '../src/modules/settlement/adapters/http-sale-suspension-source.js';
import { seedTossSellers } from './settlement-support.js';

const NOW = new Date('2026-11-14T00:00:00.000Z');
const PROMOTER = randomUUID();
const SUSPENDED_EVENT = randomUUID();
const OPEN_EVENT = randomUUID();

// F-07-5 리뷰 RV-01(정본 §4.1 '전액 취소된 결제'): 판매 대금은 승인 시각이 있는 결제만 센다. 결제 원장 사실에 승인 시각을 싣는다(펼침이라 칸이 생기기 전·후 모두 타입이 맞는다)
const APPROVED = { approvedAt: new Date('2026-11-01T00:00:00.000Z') as Date | null };
const fact = (amount: number): PaymentFact => ({ paymentId: randomUUID(), amount, cancelledAmount: 0, status: 'APPROVED', failureCategory: null, ...APPROVED });

class FakeSuspensions implements SaleSuspensionSource {
  suspended = new Set<string>();
  fail = false;
  async listSuspended(eventIds: readonly string[]) {
    if (this.fail) throw new SettlementProblem('dependency-unavailable', 503, '판매 중지 상태를 확인할 수 없습니다');
    return new Set(eventIds.filter((id) => this.suspended.has(id)));
  }
}

class FakeApprovals implements PayoutApprovalVerifier {
  readonly rows = new Map<string, VerifiedPayoutApproval>();
  async verify(approvalId: string) {
    return this.rows.get(approvalId);
  }
}

const tossGateway: PayoutGateway = { pg: 'TOSS', submit: async () => ({ status: 'SUBMITTED' }) };
const store = new MemorySettlementStore();
const payments = new MemorySettlementPaymentSource();
const suspensions = new FakeSuspensions();
const approvals = new FakeApprovals();
const settlements = new Settlements({
  store,
  payments,
  approvals,
  saleSuspensions: suspensions,
  gateways: [tossGateway],
  reauth: new MemoryReauthVerifier(),
  clock: { now: () => NOW.getTime(), monotonicMs: () => 0 },
  commissionRateBp: 1000,
});

beforeEach(async () => {
  store.statements.clear();
  store.sources.clear();
  store.batches.clear();
  store.payouts.clear();
  store.payoutBatchAudits.length = 0;
  payments.rows.clear();
  suspensions.suspended.clear();
  suspensions.fail = false;
  approvals.rows.clear();
  await settlements.recordKyc(PROMOTER, 'VERIFIED');
  await seedTossSellers(store, PROMOTER); // F-07-6: 토스 정산서는 그 상점 토스 셀러가 PARTIALLY_APPROVED 이상이어야 묶인다(ADR-0369 결정 4)
  payments.set(SUSPENDED_EVENT, 'TOSS', [fact(10_000_000)], 'STANDARD');
  payments.set(OPEN_EVENT, 'TOSS', [fact(20_000_000)], 'STANDARD');
});

const confirmed = async (eventId: string) => {
  const s = await settlements.calculateEvent({ promoterId: PROMOTER, eventId, pg: 'TOSS', pgStore: 'STANDARD' });
  await store.saveStatement({ ...(await store.findStatementById(s.statementId))!, status: 'CONFIRMED' });
  return s;
};

const approvalFor = (batch: ReturnType<typeof payoutBatchView>) => {
  const approval: VerifiedPayoutApproval = {
    approvalId: randomUUID(),
    kind: 'PAYOUT_BATCH',
    targetRef: batch.batchId,
    batchId: batch.batchId,
    pg: batch.pg,
    pgStore: batch.pgStore,
    payoutDate: batch.payoutDate,
    currency: 'KRW',
    amount: batch.totalAmount,
    statementCount: batch.statementCount,
    status: 'EXECUTING',
    requiredApprovals: 2,
    requestedBy: randomUUID(),
    approvals: [randomUUID()],
    approvedAt: NOW.toISOString(),
  };
  approvals.rows.set(approval.approvalId, approval);
  return approval;
};

describe('R-T23 ② 판매 중지된 회차의 정산 지급 보류', () => {
  test('R-T23 ② 판매 중지 회차의 정산서는 HELD/SALE_SUSPENDED로 빼고 나머지 회차만 묶는다', async () => {
    const suspended = await confirmed(SUSPENDED_EVENT);
    const open = await confirmed(OPEN_EVENT);
    suspensions.suspended.add(SUSPENDED_EVENT);
    const batch = await settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: open.payoutDate!, actor: randomUUID() });
    expect(batch).toMatchObject({ totalAmount: open.payoutAmount, statementCount: 1 });
    const held = await store.findStatementById(suspended.statementId);
    expect(held).toMatchObject({ status: 'HELD', holdReason: 'SALE_SUSPENDED', payoutBatchId: null });
    expect(await store.listStatementsByBatch(batch.batchId)).toMatchObject([{ statementId: open.statementId }]);
  });

  // F-07-5 시험 담당(lane5-f075-test, 2026-11-23): 정본 settlement §6 '판매 중지 보류의 첫 구현'이 "모두 중지면 … 그 정산서들을 HELD·SALE_SUSPENDED로 저장한 뒤 409"로 바뀌었다
  // (BAT-625 RV-04, ADR-0368 결정 11, J-T35 ⑨). 옛 기대(CONFIRMED 그대로)를 정본에 맞춰 HELD로 고친다. 묶음은 여전히 만들지 않는다.
  test('R-T23 ② J-T35 ⑨ 모두 판매 중지면 409 payout-sale-suspended이고 묶음은 만들지 않으며 정산서는 HELD·SALE_SUSPENDED로 저장한다', async () => {
    const suspended = await confirmed(SUSPENDED_EVENT);
    suspensions.suspended.add(SUSPENDED_EVENT);
    await expect(settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: suspended.payoutDate!, actor: randomUUID() })).rejects.toMatchObject({
      status: 409,
      type: expect.stringContaining('payout-sale-suspended'),
    });
    expect(store.batches.size).toBe(0);
    expect(await store.findStatementById(suspended.statementId)).toMatchObject({ status: 'HELD', holdReason: 'SALE_SUSPENDED', payoutBatchId: null });
    expect(store.statementAudits.filter((a) => a.statementId === suspended.statementId).at(-1)).toMatchObject({ fromStatus: 'CONFIRMED', toStatus: 'HELD' });
  });

  test('J-T35 ⑨ KYC·계좌 변경·계좌 불일치로 확정 정산서가 모두 빠진 묶음 요청은 409이고 정산서는 HELD·그 사유로 저장된다', async () => {
    const cases = [
      { reason: 'KYC' as const, type: 'payout-kyc-required', prepare: async (p: string) => settlements.recordKyc(p, 'PENDING') },
      { reason: 'ACCOUNT_CHANGE' as const, type: 'payout-account-change-hold', prepare: async (p: string) => store.savePayoutAccount({ promoterId: p, bankCode: '004', accountLast4: '1234', version: 1, changedAt: NOW, holdUntil: new Date(NOW.getTime() + 1), holderVerified: true }) },
      { reason: 'ACCOUNT_MISMATCH' as const, type: 'payout-account-mismatch', prepare: async (p: string) => store.savePayoutAccount({ promoterId: p, bankCode: '004', accountLast4: '1234', version: 1, changedAt: NOW, holdUntil: new Date(NOW.getTime() - 1), holderVerified: false }) },
    ];
    for (const c of cases) {
      store.statements.clear();
      store.batches.clear();
      store.accounts.clear();
      const promoterId = randomUUID();
      const eventId = randomUUID();
      await settlements.recordKyc(promoterId, 'VERIFIED');
      await seedTossSellers(store, promoterId); // F-07-6: 토스 정산서는 그 상점 토스 셀러가 PARTIALLY_APPROVED 이상이어야 묶인다(ADR-0369 결정 4)
      payments.set(eventId, 'TOSS', [fact(3_000_000)], 'STANDARD');
      const s = await settlements.calculateEvent({ promoterId, eventId, pg: 'TOSS', pgStore: 'STANDARD' });
      await store.saveStatement({ ...(await store.findStatementById(s.statementId))!, status: 'CONFIRMED' });
      await c.prepare(promoterId);
      await expect(settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: s.payoutDate!, actor: randomUUID() })).rejects.toMatchObject({ status: 409, type: expect.stringContaining(c.type) });
      expect(store.batches.size).toBe(0);
      expect({ reason: c.reason, stored: await store.findStatementById(s.statementId) }).toMatchObject({ reason: c.reason, stored: { status: 'HELD', holdReason: c.reason, payoutBatchId: null } });
    }
  });

  test('R-T23 ② core가 5xx·시간 초과면 503이고 묶음·정산서를 바꾸지 않는다', async () => {
    const suspended = await confirmed(SUSPENDED_EVENT);
    suspensions.fail = true;
    await expect(settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: suspended.payoutDate!, actor: randomUUID() })).rejects.toMatchObject({
      status: 503,
      type: expect.stringContaining('dependency-unavailable'),
    });
    expect(store.batches.size).toBe(0);
    expect(await store.findStatementById(suspended.statementId)).toMatchObject({ status: 'CONFIRMED', payoutBatchId: null });
  });

  test('R-T23 ② 실행 직전에 중지되면 409로 멈추고, 재개가 확인되면 실행한다', async () => {
    const open = await confirmed(OPEN_EVENT);
    const batch = await settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: open.payoutDate!, actor: randomUUID() });
    const approval = approvalFor(batch);
    await settlements.approveBatch(batch.batchId, approval.approvalId);
    suspensions.suspended.add(OPEN_EVENT);
    await expect(settlements.executeBatch(batch.batchId)).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-sale-suspended') });
    expect(await store.findPayoutBatch(batch.batchId)).toMatchObject({ status: 'APPROVED' });
    expect(await store.listPayouts(batch.batchId)).toHaveLength(0);
    suspensions.suspended.clear();
    expect((await settlements.executeBatch(batch.batchId)).status).toBe('SUBMITTED');
  });

  test('R-T23 ② 재확정은 증빙만 믿지 않고 core에 판매 재개를 확인한다', async () => {
    const suspended = await confirmed(SUSPENDED_EVENT);
    const open = await confirmed(OPEN_EVENT);
    suspensions.suspended.add(SUSPENDED_EVENT);
    await settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: open.payoutDate!, actor: randomUUID() });
    expect(await store.findStatementById(suspended.statementId)).toMatchObject({ status: 'HELD', holdReason: 'SALE_SUSPENDED' });

    await expect(settlements.reconfirmStatement(suspended.statementId, { actor: 'ops', evidence: { saleResumed: true } })).rejects.toMatchObject({
      status: 409,
      type: expect.stringContaining('settlement-sale-still-suspended'),
    });
    suspensions.suspended.clear();
    expect((await settlements.reconfirmStatement(suspended.statementId, { actor: 'ops', evidence: { saleResumed: true } })).status).toBe('CONFIRMED');
    expect(await store.findStatementById(suspended.statementId)).toMatchObject({ status: 'CONFIRMED', holdReason: null });
  });

  test('R-T23 ② 판매 중지 확인 원천이 답하지 않으면 재확정은 503이고 보류를 유지한다', async () => {
    const suspended = await confirmed(SUSPENDED_EVENT);
    const open = await confirmed(OPEN_EVENT);
    suspensions.suspended.add(SUSPENDED_EVENT);
    await settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: open.payoutDate!, actor: randomUUID() });
    suspensions.fail = true;
    await expect(settlements.reconfirmStatement(suspended.statementId, { actor: 'ops', evidence: { saleResumed: true } })).rejects.toMatchObject({
      status: 503,
      type: expect.stringContaining('dependency-unavailable'),
    });
    expect(await store.findStatementById(suspended.statementId)).toMatchObject({ status: 'HELD', holdReason: 'SALE_SUSPENDED' });
  });

  test('R-T23 ②(어댑터) core 5xx·모양 위반은 503, 100개씩 나눠 묻고 준 차례를 지킨다', async () => {
    const calls: string[] = [];
    const response = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    const source = (fetchImpl: typeof fetch) => new HttpSaleSuspensionSource('http://core-svc:8080', 'internal-token', fetchImpl, 50);
    const ids = Array.from({ length: 120 }, () => randomUUID());
    const fetched = await source(async (input) => {
      calls.push(String(input));
      const u = new URL(String(input));
      const chunk = (u.searchParams.get('eventIds') ?? '').split(',');
      return response(200, { suspendedEventIds: chunk.filter((id) => id === ids[0] || id === ids[101]) });
    }).listSuspended(ids);
    expect(calls).toHaveLength(2);
    expect([...fetched]).toEqual([ids[0], ids[101]]);
    await expect(source(async () => response(500, {})).listSuspended([ids[0]])).rejects.toMatchObject({ status: 503, type: expect.stringContaining('dependency-unavailable') });
    await expect(source(async () => response(200, { suspendedEventIds: ['not-in-request'] })).listSuspended([ids[0]])).resolves.toEqual(new Set());
    await expect(source(async () => response(200, {})).listSuspended([ids[0]])).rejects.toMatchObject({ status: 503, type: expect.stringContaining('dependency-unavailable') });
  });
});
