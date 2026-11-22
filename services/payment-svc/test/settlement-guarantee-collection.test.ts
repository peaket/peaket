// J-T33 보증금·이행보증보험 징수(BAT-630 LCH-110, settlement §7, ADR-0046·0320).
// 미수금 발생 30일 뒤 다음 정산서가 없을 때 계약 보증 비율만큼 GUARANTEE로 충당하는지,
// 30일 전·보증 한도 밖·재인증 실패에서는 행이 바뀌지 않는지, 같은 멱등 키가 한 번만 움직이는지 본다.
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { Settlements } from '../src/modules/settlement/application/settlements.js';
import type { ReceivableRecord, StatementRecord } from '../src/modules/settlement/domain/settlement.js';
import type { PayoutApprovalVerifier, PromoterContractSource, SaleSuspensionSource } from '../src/modules/settlement/domain/ports.js';
import { MemoryReauthVerifier, MemorySettlementPaymentSource, MemorySettlementStore, UnavailableTossPayoutGateway } from '../src/modules/settlement/index.js';

const NOW = new Date('2026-11-22T00:00:00.000Z');
const PROMOTER = randomUUID();
const EVENT = randomUUID();
const DAY = 24 * 60 * 60 * 1000;

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
class FakeContracts implements PromoterContractSource {
  guaranteeRateBp = 1000;
  guaranteeKind: 'DEPOSIT' | 'PERFORMANCE_BOND' = 'DEPOSIT';
  async current(): Promise<{ commissionRateBp: number; guaranteeRateBp: number; guaranteeKind: 'DEPOSIT' | 'PERFORMANCE_BOND' }> {
    return { commissionRateBp: 1000, guaranteeRateBp: this.guaranteeRateBp, guaranteeKind: this.guaranteeKind };
  }
}

const store = new MemorySettlementStore();
const contracts = new FakeContracts();
const settlements = new Settlements({
  store,
  payments: new MemorySettlementPaymentSource(),
  approvals: new FakeApprovals(),
  saleSuspensions: new FakeSuspensions(),
  promoterContracts: contracts,
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
  payoutAmount: 89_000_000,
  revision: 1,
  supersedesId: null,
  excludedPayments: [],
  status: 'PAID',
  holdReason: null,
  disputeDueAt: null,
  payoutDate: '2026-10-01',
  payoutBankCode: '004',
  payoutAccountLast4: '1234',
  payoutBatchId: null,
  createdAt: new Date(NOW.getTime() - 60 * DAY),
  updatedAt: new Date(NOW.getTime() - 60 * DAY),
  ...over,
});

const receivable = (over: Partial<ReceivableRecord> = {}): ReceivableRecord => ({
  receivableId: randomUUID(),
  promoterId: PROMOTER,
  pg: 'TOSS',
  cause: 'REFUND_AFTER_PAYOUT',
  eventId: EVENT,
  amount: 7_000_000,
  remaining: 7_000_000,
  status: 'OPEN',
  createdAt: new Date(NOW.getTime() - 31 * DAY),
  updatedAt: new Date(NOW.getTime() - 31 * DAY),
  ...over,
});

beforeEach(() => {
  store.statements.clear();
  store.receivables.clear();
  store.receivableMoves.length = 0;
  store.guaranteeCollections.clear();
  contracts.guaranteeRateBp = 1000;
  contracts.guaranteeKind = 'DEPOSIT';
});

describe('J-T33 보증 징수', () => {
  test('J-T33 ① 30일 지난 미수금을 계약 보증 비율만큼 GUARANTEE로 충당하고 남은 금액을 갱신한다 [ASVS v5.0.0-2.3.3] [ASVS v5.0.0-2.3.4]', async () => {
    await store.insertStatement(statement(), []);
    const row = receivable();
    await store.insertReceivable(row);
    const out = await settlements.collectGuarantee(row.receivableId, {
      actor: 'commander-1',
      sessionId: 'session-1',
      reauthToken: 'test-reauth',
      idempotencyKey: 'guarantee-1',
      reason: '30일 지나 보증금에서 충당',
    });
    expect(out.collection.amount).toBe(7_000_000);
    expect(out.collection.guaranteeKind).toBe('DEPOSIT');
    expect(out.collection.basisAmount).toBe(100_000_000);
    expect(out.receivable.remaining).toBe(0);
    expect(out.receivable.status).toBe('CLOSED');
    expect(store.receivableMoves).toHaveLength(1);
    expect(store.receivableMoves[0]).toMatchObject({ receivableId: row.receivableId, amount: 7_000_000 });
  });

  test('J-T33 ② 30일 전이거나 보증 한도를 넘으면 409, 보증 한도 안에서는 한도까지만 충당한다', async () => {
    await store.insertStatement(statement(), []);
    const early = receivable({ createdAt: new Date(NOW.getTime() - 29 * DAY) });
    await store.insertReceivable(early);
    await expect(
      settlements.collectGuarantee(early.receivableId, {
        actor: 'commander-1',
        sessionId: 'session-1',
        reauthToken: 'test-reauth',
        idempotencyKey: 'guarantee-early',
        reason: '아직 30일 전',
      }),
    ).rejects.toMatchObject({ status: 409, slug: 'guarantee-not-due' });

    const large = receivable({ amount: 12_000_000, remaining: 12_000_000 });
    await store.insertReceivable(large);
    const first = await settlements.collectGuarantee(large.receivableId, {
      actor: 'commander-1',
      sessionId: 'session-1',
      reauthToken: 'test-reauth',
      idempotencyKey: 'guarantee-limit-1',
      reason: '보증 한도까지',
    });
    expect(first.collection.amount).toBe(10_000_000);
    expect(first.receivable.remaining).toBe(2_000_000);
    expect(first.receivable.status).toBe('OPEN');
    await expect(
      settlements.collectGuarantee(large.receivableId, {
        actor: 'commander-1',
        sessionId: 'session-1',
        reauthToken: 'test-reauth',
        idempotencyKey: 'guarantee-limit-2',
        reason: '남은 보증 없음',
      }),
    ).rejects.toMatchObject({ status: 409, slug: 'guarantee-capacity-exhausted' });
    expect(store.receivableMoves).toHaveLength(1);
  });

  test('J-T33 ③ commander가 재인증하고 같은 멱등 키는 한 번만 움직인다', async () => {
    await store.insertStatement(statement(), []);
    const row = receivable();
    await store.insertReceivable(row);
    const body = {
      actor: 'commander-1',
      sessionId: 'session-1',
      reauthToken: 'wrong',
      idempotencyKey: 'guarantee-idem',
      reason: '재인증 확인',
    };
    await expect(settlements.collectGuarantee(row.receivableId, body)).rejects.toMatchObject({ status: 403, slug: 'reauth-required' });
    const ok = await settlements.collectGuarantee(row.receivableId, { ...body, reauthToken: 'test-reauth' });
    const again = await settlements.collectGuarantee(row.receivableId, { ...body, reauthToken: 'test-reauth' });
    expect(again.collection.collectionId).toBe(ok.collection.collectionId);
    expect(store.receivableMoves).toHaveLength(1);
    expect((await store.findReceivable(row.receivableId))?.remaining).toBe(0);
  });

  test('J-T33 ④ 이행보증보험 계약도 같은 규칙으로 충당한다', async () => {
    contracts.guaranteeKind = 'PERFORMANCE_BOND';
    await store.insertStatement(statement(), []);
    const row = receivable({ amount: 3_000_000, remaining: 3_000_000 });
    await store.insertReceivable(row);
    const out = await settlements.collectGuarantee(row.receivableId, {
      actor: 'commander-1',
      sessionId: 'session-1',
      reauthToken: 'test-reauth',
      idempotencyKey: 'guarantee-bond',
      reason: '이행보증보험 청구',
    });
    expect(out.collection.guaranteeKind).toBe('PERFORMANCE_BOND');
    expect(out.collection.amount).toBe(3_000_000);
  });
});
