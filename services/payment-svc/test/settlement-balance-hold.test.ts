// J-T13 잔액 부족 HELD(BAT-630 LCH-110). 잔액이 모자라면 묶음을 만들지 않고 그 정산서를 HELD·BALANCE로
// 저장하는지, 증빙 없이는 재확정하지 않는지, 잔액이 생긴 뒤 다음 묶음에 다시 잡히는지 본다.
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { Settlements } from '../src/modules/settlement/application/settlements.js';
import type { StatementRecord } from '../src/modules/settlement/domain/settlement.js';
import type { PgBalanceSource, PayoutApprovalVerifier, SaleSuspensionSource } from '../src/modules/settlement/domain/ports.js';
import { MemoryReauthVerifier, MemorySettlementPaymentSource, MemorySettlementStore, UnavailableTossPayoutGateway } from '../src/modules/settlement/index.js';
import { seedTossSellers } from './settlement-support.js';

const NOW = new Date('2026-11-22T00:00:00.000Z');
const PROMOTER = randomUUID();
const EVENT = randomUUID();
const PAYOUT_DATE = '2026-12-01';

class FakeApprovals implements PayoutApprovalVerifier {
  async verify(): Promise<undefined> {
    return undefined;
  }
}
class FakeSuspensions implements SaleSuspensionSource {
  async listSuspended(): Promise<ReadonlySet<string>> {
    return new Set();
  }
}
class FakeBalance implements PgBalanceSource {
  amount: number | undefined = 20_000_000;
  calls = 0;
  failure = false;
  async available() {
    this.calls += 1;
    if (this.failure) throw new Error('balance-api-down');
    if (this.amount === undefined) return undefined;
    return { availableAmount: this.amount, pendingAmount: 0 };
  }
}

const store = new MemorySettlementStore();
const payments = new MemorySettlementPaymentSource();
const balance = new FakeBalance();

const settlements = new Settlements({
  store,
  payments,
  approvals: new FakeApprovals(),
  saleSuspensions: new FakeSuspensions(),
  pgBalance: balance,
  gateways: [new UnavailableTossPayoutGateway()],
  reauth: new MemoryReauthVerifier(),
  clock: { now: () => NOW.getTime(), monotonicMs: () => 0 },
});

const statement = (over: Partial<StatementRecord> = {}): StatementRecord => ({
  statementId: randomUUID(),
  promoterId: PROMOTER,
  kind: 'EVENT',
  eventId: EVENT,
  pg: 'TOSS',
  pgStore: 'STANDARD',
  periodStart: null,
  periodEnd: null,
  grossAmount: 100_000_000,
  refundAmount: 0,
  commissionAmount: 10_000_000,
  commissionVat: 1_000_000,
  offsetAmount: 0,
  payoutAmount: 15_000_000,
  revision: 1,
  supersedesId: null,
  excludedPayments: [],
  status: 'CONFIRMED',
  holdReason: null,
  disputeDueAt: null,
  payoutDate: PAYOUT_DATE,
  payoutBankCode: '004',
  payoutAccountLast4: '1234',
  payoutBatchId: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const seed = async (): Promise<StatementRecord[]> => {
  await settlements.recordKyc(PROMOTER, 'VERIFIED');
  await seedTossSellers(store, PROMOTER); // F-07-6: 토스 정산서는 그 상점 토스 셀러가 PARTIALLY_APPROVED 이상이어야 묶인다(ADR-0369 결정 4)
  const first = statement();
  const second = statement({ eventId: randomUUID(), payoutAmount: 12_000_000 });
  await store.insertStatement(first, []);
  await store.insertStatement(second, []);
  return [first, second];
};

beforeEach(async () => {
  store.statements.clear();
  store.sources.clear();
  store.batches.clear();
  store.payouts.clear();
  store.kycs.clear();
  payments.rows.clear();
  balance.amount = 20_000_000;
  balance.calls = 0;
  balance.failure = false;
});

describe('J-T13 잔액 부족 HELD', () => {
  test('J-T13 ① 토스 availableAmount가 묶음 합계보다 작으면 정산서를 HELD·BALANCE로 남기고 409', async () => {
    const [first, second] = await seed();
    // 토스 잔액 2,000만 원 < 묶음 2,700만 원
    await expect(settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: PAYOUT_DATE, actor: randomUUID() })).rejects.toMatchObject({
      status: 409,
      slug: 'payout-balance-insufficient',
    });
    expect(balance.calls).toBe(1);
    expect(store.batches.size).toBe(0);
    expect((await store.findStatementById(first.statementId))?.status).toBe('HELD');
    expect((await store.findStatementById(first.statementId))?.holdReason).toBe('BALANCE');
    expect((await store.findStatementById(second.statementId))?.status).toBe('HELD');
    expect((await store.findStatementById(second.statementId))?.holdReason).toBe('BALANCE');
  });

  test('J-T13 ② 포트원 운영자 입력값이 작으면 같은 보류·409이고 묶음이 없다', async () => {
    const [first] = await seed();
    await store.saveStatement({ ...(await store.findStatementById(first.statementId))!, pg: 'PORTONE' });
    await expect(
      settlements.createPayoutBatch({
        pg: 'PORTONE',
        pgStore: 'STANDARD',
        payoutDate: PAYOUT_DATE,
        portoneBalance: { amount: 10_000_000, observedAt: NOW.toISOString() },
        actor: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 409, slug: 'payout-balance-insufficient' });
    expect(store.batches.size).toBe(0);
    expect((await store.findStatementById(first.statementId))?.status).toBe('HELD');
    expect((await store.findStatementById(first.statementId))?.holdReason).toBe('BALANCE');
  });

  test('J-T13 ③ 잔액 확인 증빙이 없으면 재확정 409, 있으면 CONFIRMED', async () => {
    const [first] = await seed();
    await expect(settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: PAYOUT_DATE, actor: randomUUID() })).rejects.toMatchObject({ status: 409, slug: 'payout-balance-insufficient' });
    await expect(settlements.reconfirmStatement(first.statementId)).rejects.toMatchObject({ status: 409, slug: 'payout-balance-unconfirmed' });
    const confirmed = await settlements.reconfirmStatement(first.statementId, { actor: 'commander-1', reason: '잔액 확인', evidence: { balanceConfirmed: true } });
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.holdReason).toBeNull();
    expect(store.statementAudits.at(-1)?.reason).toBe('잔액 확인');
  });

  test('J-T13 ④ 잔액이 생긴 뒤 재확정한 정산서만 다음 묶음에 다시 잡힌다', async () => {
    const [first, second] = await seed();
    await expect(settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: PAYOUT_DATE, actor: randomUUID() })).rejects.toMatchObject({ status: 409, slug: 'payout-balance-insufficient' });
    // 아직 HELD라 listConfirmed에 없고, 잔액이 생겨도 묶음에 들어가지 않는다.
    expect((await store.listConfirmed('TOSS', 'STANDARD', PAYOUT_DATE)).length).toBe(0);
    balance.amount = 30_000_000;
    await expect(settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: PAYOUT_DATE, actor: randomUUID() })).rejects.toMatchObject({ status: 409, slug: 'payout-batch-empty' });
    // 하나만 증빙으로 풀면 그 정산서만 다음 묶음에 잡힌다.
    await settlements.reconfirmStatement(first.statementId, { evidence: { balanceConfirmed: true } });
    const batch = await settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: PAYOUT_DATE, actor: randomUUID() });
    expect(batch.statementCount).toBe(1);
    expect(batch.totalAmount).toBe(first.payoutAmount);
    expect((await store.findStatementById(second.statementId))?.status).toBe('HELD');
  });

  test('J-T13 ⑤ 잔액 원천이 실패하면 503이고 정산서·묶음을 바꾸지 않는다', async () => {
    const [first] = await seed();
    balance.failure = true;
    await expect(settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: PAYOUT_DATE, actor: randomUUID() })).rejects.toMatchObject({
      status: 503,
      slug: 'pg-balance-unavailable',
    });
    expect(store.batches.size).toBe(0);
    expect((await store.findStatementById(first.statementId))?.status).toBe('CONFIRMED');
  });
});
