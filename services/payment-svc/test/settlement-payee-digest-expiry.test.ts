// F-06-3 payment-svc 지급 대상 지문·15시 만료의 실제 경계 시험(시험 담당, 2026-11-26. 시험 리뷰 TR-01·02·13 반영).
// 정본: docs/features/settlement.md §5.1, docs/data.md payout_batch·payout_approval, docs/planning/03 §2.10·POL-038·POL-039.
// 이 파일은 가짜 포트가 아니라 실제 `Settlements`·`MemorySettlementStore`·`payoutEvent` 경계를 본다.
import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { Settlements } from '../src/modules/settlement/application/settlements.js';
import type { PayoutApprovalVerifier, SaleSuspensionSource, SettlementApprovalLog, VerifiedPayoutApproval } from '../src/modules/settlement/domain/ports.js';
import type { PayoutBatchAuditRecord, PaymentFact, SettlementEventValue } from '../src/modules/settlement/domain/settlement.js';
import { MemoryReauthVerifier, MemorySettlementPaymentSource, MemorySettlementStore, UnavailableTossPayoutGateway } from '../src/modules/settlement/index.js';
import { seedTossSellers } from './settlement-support.js';

const NOW = new Date('2026-11-14T00:00:00.000Z');
const PROMOTER = randomUUID();
const EVENT_A = randomUUID();
const EVENT_B = randomUUID();
const BANK = '004';
const LAST4 = '1234';

const APPROVED = { approvedAt: new Date('2026-11-01T00:00:00.000Z') as Date | null };
const fact = (amount = 10_000_000): PaymentFact => ({ paymentId: randomUUID(), amount, cancelledAmount: 0, status: 'APPROVED', failureCategory: null, ...APPROVED });

class FakeApprovals implements PayoutApprovalVerifier {
  readonly rows = new Map<string, VerifiedPayoutApproval>();
  async verify(approvalId: string) {
    return this.rows.get(approvalId);
  }
}
const noSuspensions: SaleSuspensionSource = { listSuspended: async () => new Set() };
class RecordingLog implements SettlementApprovalLog {
  approved(): void {}
  rejected(): void {}
}

const store = new MemorySettlementStore();
const payments = new MemorySettlementPaymentSource();
const approvals = new FakeApprovals();
const settlements = new Settlements({
  store,
  payments,
  approvals,
  saleSuspensions: noSuspensions,
  gateways: [new UnavailableTossPayoutGateway()],
  reauth: new MemoryReauthVerifier(),
  clock: { now: () => NOW.getTime(), monotonicMs: () => 0 },
  commissionRateBp: 1000,
  log: new RecordingLog(),
});

beforeEach(async () => {
  store.statements.clear();
  store.sources.clear();
  store.batches.clear();
  store.payouts.clear();
  store.payoutBatchAudits.length = 0;
  store.outbox.length = 0;
  store.accounts.clear();
  payments.rows.clear();
  approvals.rows.clear();
  await settlements.recordKyc(PROMOTER, 'VERIFIED');
  await seedTossSellers(store, PROMOTER);
  payments.set(EVENT_A, 'TOSS', [fact(10_000_000)], 'STANDARD');
  payments.set(EVENT_B, 'TOSS', [fact(20_000_000)], 'STANDARD');
  await store.savePayoutAccount({ promoterId: PROMOTER, bankCode: BANK, accountLast4: LAST4, version: 1, changedAt: NOW, holdUntil: NOW, holderVerified: true });
});

const confirmedStatements = async (count: 1 | 2 = 2): Promise<{ statementId: string; payoutAmount: number }[]> => {
  const out: { statementId: string; payoutAmount: number }[] = [];
  const events = count === 2 ? [EVENT_A, EVENT_B] : [EVENT_A];
  for (const eventId of events) {
    const s = await settlements.calculateEvent({ promoterId: PROMOTER, eventId, pg: 'TOSS', pgStore: 'STANDARD' });
    const calculated = (await store.findStatementById(s.statementId))!;
    await store.saveStatement({ ...calculated, status: 'CONFIRMED', payoutDate: '2026-12-01' });
    const row = (await store.findStatementById(s.statementId))!;
    out.push({ statementId: row.statementId, payoutAmount: row.payoutAmount });
  }
  return out;
};
const create = async (payoutDate = '2026-12-01') => settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate, actor: randomUUID() });
const approvalFor = (batch: { batchId: string; pg: 'TOSS' | 'PORTONE'; pgStore: 'STANDARD' | 'ESCROW'; payoutDate: string; totalAmount: number; statementCount: number }): VerifiedPayoutApproval => {
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
const digestOf = (rows: readonly { statementId: string; payoutAmount: number }[], account: { bankCode: string; accountLast4: string } | undefined): string =>
  createHash('sha256')
    .update(
      [...rows]
        .sort((a, b) => (a.statementId < b.statementId ? -1 : a.statementId > b.statementId ? 1 : 0))
        .map((s) => `${s.statementId}|${s.payoutAmount}|${PROMOTER}|${account?.bankCode ?? 'NO_PAYEE'}|${account?.accountLast4 ?? 'NO_PAYEE'}`)
        .join('\n'),
      'utf8',
    )
    .digest('hex');
const payoutsOf = (batchId: string) => [...store.payouts.values()].filter((p) => p.batchId === batchId);

describe('payeeDigest 계산 [ASVS v5.0.0-2.3.3]', () => {
  test('정산서를 ID 차례로 정렬한 정본 줄의 SHA-256 64자이고 응답에 실린다', async () => {
    const rows = await confirmedStatements(2);
    const batch = await create();
    expect((batch as Record<string, unknown>).payeeDigest as string).toBe(digestOf(rows, { bankCode: BANK, accountLast4: LAST4 }));
    expect((batch as Record<string, unknown>).payeeDigest as string).toMatch(/^[0-9a-f]{64}$/);
  });

  test('정산서를 넣은 차례가 달라도 같은 지문이다', async () => {
    const rows = await confirmedStatements(2);
    const first = await create();
    store.batches.clear();
    store.statements.clear();
    store.sources.clear();
    await confirmedStatements(2);
    const second = await create();
    expect((second as Record<string, unknown>).payeeDigest as string).toBe((first as Record<string, unknown>).payeeDigest as string);
    expect((first as Record<string, unknown>).payeeDigest as string).toBe(digestOf(rows, { bankCode: BANK, accountLast4: LAST4 }));
  });

  test('정산 계좌가 없으면 계좌 자리에 NO_PAYEE를 쓴다', async () => {
    store.accounts.clear();
    const rows = await confirmedStatements(1);
    const batch = await create();
    expect((batch as Record<string, unknown>).payeeDigest as string).toBe(digestOf(rows, undefined));
  });
});

describe('payeeDigest 대조 [ASVS v5.0.0-2.3.4]', () => {
  test('승인 전에 계좌가 바뀌면 409 payout-batch-payee-mismatch이고 묶음·감사가 그대로다', async () => {
    await confirmedStatements(2);
    const batch = await create();
    const approval = approvalFor(batch);
    await store.savePayoutAccount({ promoterId: PROMOTER, bankCode: BANK, accountLast4: '9999', version: 2, changedAt: NOW, holdUntil: NOW, holderVerified: true });
    await expect(settlements.approveBatch(batch.batchId, approval.approvalId)).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-batch-payee-mismatch') });
    expect(await store.findPayoutBatch(batch.batchId)).toMatchObject({ status: 'PENDING_APPROVAL', approvalId: null });
    expect(store.payoutBatchAudits.filter((a: PayoutBatchAuditRecord) => a.event === 'REJECTED')).toHaveLength(1);
  });

  test('지문이 같으면 승인되고 APPROVED 감사에 승인 ID·금액이 남는다', async () => {
    await confirmedStatements(2);
    const batch = await create();
    const approval = approvalFor(batch);
    const out = await settlements.approveBatch(batch.batchId, approval.approvalId);
    expect(out).toMatchObject({ batchId: batch.batchId, status: 'APPROVED', approvalId: approval.approvalId });
    expect(store.payoutBatchAudits).toContainEqual(expect.objectContaining({ event: 'APPROVED', approvalId: approval.approvalId, amount: batch.totalAmount, payeeDigest: (batch as Record<string, unknown>).payeeDigest }));
  });

  test('승인 뒤 실행 직전에 계좌가 바뀌면 executeBatch가 409 payout-batch-payee-mismatch로 멈추고 지급 건이 0이다 [ASVS v5.0.0-2.3.4]', async () => {
    await confirmedStatements(1);
    const batch = await create();
    const approval = approvalFor(batch);
    await settlements.approveBatch(batch.batchId, approval.approvalId);
    await store.savePayoutAccount({ promoterId: PROMOTER, bankCode: BANK, accountLast4: '9999', version: 2, changedAt: NOW, holdUntil: NOW, holderVerified: true });
    await expect(settlements.executeBatch(batch.batchId)).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-batch-payee-mismatch') });
    expect(await store.findPayoutBatch(batch.batchId)).toMatchObject({ status: 'APPROVED' });
    expect(payoutsOf(batch.batchId)).toHaveLength(0);
  });
});

describe('15시 만료의 트랜잭션 [ASVS v5.0.0-2.3.3] [ASVS v5.0.0-2.3.4]', () => {
  test('승인 대기 묶음을 풀면 정산서는 CONFIRMED·결속 없음, 감사 payout-batch-expired, PAYOUT_HELD가 남는다', async () => {
    const rows = await confirmedStatements(2);
    const batch = await create();
    const out = await (settlements as unknown as { expireBatch(id: string, i: { approvalId: string; postponedPayoutDate: string }): Promise<unknown> }).expireBatch(batch.batchId, { approvalId: randomUUID(), postponedPayoutDate: '2026-12-02' });
    expect(out).toEqual({ batchId: batch.batchId, status: 'EXPIRED', postponedPayoutDate: '2026-12-02' });
    expect(await store.findPayoutBatch(batch.batchId)).toMatchObject({ status: 'EXPIRED' });
    for (const row of rows) {
      expect(await store.findStatementById(row.statementId)).toMatchObject({ status: 'CONFIRMED', payoutBatchId: null });
    }
    expect(store.payoutBatchAudits).toContainEqual(expect.objectContaining({ batchId: batch.batchId, reason: 'payout-batch-expired' }));
    const held = store.outbox.filter((e: { value: SettlementEventValue }) => e.value.type === 'PAYOUT_HELD');
    expect(held).toHaveLength(2);
    expect(held.map((e: { value: SettlementEventValue }) => e.value.amount as number).sort((a: number, b: number) => a - b)).toEqual(rows.map((r) => r.payoutAmount).sort((a, b) => a - b));
  });

  test('같은 만료를 다시 불러도 처음 결과이고 감사·사건이 늘지 않는다', async () => {
    await confirmedStatements(1);
    const batch = await create();
    const a = await (settlements as unknown as { expireBatch(id: string, i: { approvalId: string; postponedPayoutDate: string }): Promise<unknown> }).expireBatch(batch.batchId, { approvalId: randomUUID(), postponedPayoutDate: '2026-12-02' });
    const audits = store.payoutBatchAudits.length;
    const outbox = store.outbox.length;
    const b = await (settlements as unknown as { expireBatch(id: string, i: { approvalId: string; postponedPayoutDate: string }): Promise<unknown> }).expireBatch(batch.batchId, { approvalId: randomUUID(), postponedPayoutDate: '2026-12-02' });
    expect(b).toEqual(a);
    expect(store.payoutBatchAudits).toHaveLength(audits);
    expect(store.outbox).toHaveLength(outbox);
  });

  test('지급 건이 있는 묶음은 409 payout-batch-not-expellable이고 아무것도 바꾸지 않는다', async () => {
    await confirmedStatements(1);
    const batch = await create();
    const statement = (await store.listStatementsByBatch(batch.batchId))[0]!;
    store.payouts.set('p1', {
      payoutId: 'p1',
      statementId: statement.statementId,
      batchId: batch.batchId,
      sequence: 1,
      amount: statement.payoutAmount,
      refPayoutId: `${statement.statementId}-1`,
      status: 'REQUESTED',
      errorCode: null,
      pgPayoutId: null,
      pgTransferId: null,
      transferCheck: null,
      transferCheckedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    } as never);
    await expect((settlements as unknown as { expireBatch(id: string, i: { approvalId: string; postponedPayoutDate: string }): Promise<unknown> }).expireBatch(batch.batchId, { approvalId: randomUUID(), postponedPayoutDate: '2026-12-02' })).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-batch-not-expellable') });
    expect(await store.findPayoutBatch(batch.batchId)).toMatchObject({ status: 'PENDING_APPROVAL' });
    expect(await store.findStatementById(statement.statementId)).toMatchObject({ payoutBatchId: batch.batchId });
  });

  test('09시 PREPARED 묶음도 풀리고 다음 영업일 09시 새 묶음이 만들어진다', async () => {
    await confirmedStatements(1);
    expect(await settlements.prepareTossBatches('2026-12-01')).toMatchObject({ prepared: 1 });
    const prepared = [...store.batches.values()].find((b) => b.status === 'PREPARED')!;
    await (settlements as unknown as { expireBatch(id: string, i: { approvalId: string; postponedPayoutDate: string }): Promise<unknown> }).expireBatch(prepared.batchId, { approvalId: randomUUID(), postponedPayoutDate: '2026-12-02' });
    expect(await store.findPayoutBatch(prepared.batchId)).toMatchObject({ status: 'EXPIRED' });
    expect(await settlements.prepareTossBatches('2026-12-02')).toMatchObject({ prepared: 1 });
    const next = [...store.batches.values()].find((b) => b.status === 'PREPARED' && b.batchId !== prepared.batchId);
    expect(next).toBeDefined();
    expect(next!.payoutDate).toBe('2026-12-02');
  });
});

describe('만료 시각의 정본 값', () => {
  test('15:00 경계 값은 지급일 전 영업일 15:00 KST다(2026-12-01 → 2026-11-30T06:00:00.000Z)', async () => {
    const late = await confirmedStatements(1);
    const batch = await create();
    expect(late).toHaveLength(1);
    expect((batch as Record<string, unknown>).approvalDueAt).toBe('2026-11-30T06:00:00.000Z');
  });
});
