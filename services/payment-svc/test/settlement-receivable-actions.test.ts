// J-T11 ⑤·J-T24 ④: 지급 뒤 미수금의 청구·회수·손실 수동 전이(F-07-15 I-01, settlement §7).
// 정본 값: 30일, 남은 금액, COLLECTED/WRITE_OFF 이동 한 줄, 같은 키 한 번, 한 트랜잭션.
// 기준 트리에서는 Settlements의 새 메서드와 MemorySettlementStore의 새 칸이 없어 실패한다.
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { Settlements } from '../src/modules/settlement/application/settlements.js';
import { SettlementProblem, type ReceivableRecord, type StatementRecord } from '../src/modules/settlement/domain/settlement.js';
import type { PayoutApprovalVerifier, PromoterContractSource, SaleSuspensionSource } from '../src/modules/settlement/domain/ports.js';
import { MemoryReauthVerifier, MemorySettlementPaymentSource, MemorySettlementStore, UnavailableTossPayoutGateway } from '../src/modules/settlement/index.js';

const NOW = new Date('2026-11-27T03:00:00.000Z');
const PROMOTER = randomUUID();
const EVENT = randomUUID();
const DAY = 24 * 60 * 60 * 1000;
const TOKEN = 'test-reauth';

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
  async current(): Promise<{ commissionRateBp: number; guaranteeRateBp: number; guaranteeKind: 'DEPOSIT' }> {
    return { commissionRateBp: 1000, guaranteeRateBp: 1000, guaranteeKind: 'DEPOSIT' };
  }
}

const store = new MemorySettlementStore();
const settlements = new Settlements({
  store,
  payments: new MemorySettlementPaymentSource(),
  approvals: new FakeApprovals(),
  saleSuspensions: new FakeSuspensions(),
  promoterContracts: new FakeContracts(),
  gateways: [new UnavailableTossPayoutGateway()],
  reauth: new MemoryReauthVerifier(TOKEN),
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
  grossAmount: 30_000_000,
  refundAmount: 2_000_000,
  commissionAmount: 2_800_000,
  commissionVat: 280_000,
  offsetAmount: 0,
  payoutAmount: 24_920_000,
  revision: 1,
  supersedesId: null,
  excludedPayments: [],
  status: 'PAID',
  holdReason: null,
  disputeDueAt: null,
  payoutDate: '2026-11-20',
  payoutBankCode: '004',
  payoutAccountLast4: '1234',
  payoutBatchId: null,
  createdAt: new Date(NOW.getTime() - 40 * DAY),
  updatedAt: new Date(NOW.getTime() - 40 * DAY),
  ...over,
});

const receivable = (over: Partial<ReceivableRecord> = {}): ReceivableRecord => ({
  receivableId: randomUUID(),
  promoterId: PROMOTER,
  pg: 'TOSS',
  cause: 'REFUND_AFTER_PAYOUT',
  eventId: EVENT,
  amount: 445_000,
  remaining: 445_000,
  status: 'OPEN',
  createdAt: new Date(NOW.getTime() - 31 * DAY),
  updatedAt: new Date(NOW.getTime() - 31 * DAY),
  ...over,
});

const input = (over: Record<string, unknown> = {}) => ({
  actor: 'commander-a',
  sessionId: 'session-a',
  reauthToken: TOKEN,
  idempotencyKey: randomUUID(),
  reason: '보증 한도 뒤 남은 금액을 청구한다',
  ...over,
});

const seed = (r: ReceivableRecord, s: StatementRecord) => {
  store.receivables.set(r.receivableId, r);
  store.statements.set(s.statementId, s);
};

beforeEach(() => {
  store.statements.clear();
  store.receivables.clear();
  store.receivableMoves.length = 0;
  store.receivableActions.clear();
  store.failReceivableAction = false;
});

describe('J-T11 ⑤ 청구·회수·손실', () => {
  test('J-T11 ⑤ 청구는 30일 경계이고 청구 금액은 그때의 남은 금액이다', async () => {
    const early = receivable({ createdAt: new Date(NOW.getTime() - 30 * DAY + 1), updatedAt: new Date(NOW.getTime() - 30 * DAY + 1) });
    seed(early, statement());
    await expect(settlements.billReceivable(early.receivableId, input())).rejects.toMatchObject({ type: 'receivable-billing-not-due', status: 409 } as Partial<SettlementProblem>);
    expect(store.receivables.get(early.receivableId)?.status).toBe('OPEN');
    expect(store.receivableActions.size).toBe(0);

    const due = receivable({ createdAt: new Date(NOW.getTime() - 30 * DAY), updatedAt: new Date(NOW.getTime() - 30 * DAY) });
    seed(due, statement());
    const result = await settlements.billReceivable(due.receivableId, input());
    expect(result.action.kind).toBe('BILLED');
    expect(result.action.amount).toBe(445_000);
    expect(result.action.remainingAfter).toBe(445_000);
    expect(result.receivable.status).toBe('BILLED');
    expect(store.receivableMoves).toEqual([]);
    await expect(settlements.billReceivable(due.receivableId, input())).rejects.toMatchObject({ type: 'receivable-not-open', status: 409 });
  });

  test('J-T11 ⑤ 같은 멱등 키는 한 번만 옮기고 다른 대상에 쓰면 422다', async () => {
    const a = receivable();
    const b = receivable();
    seed(a, statement());
    seed(b, statement());
    const key = randomUUID();
    const first = await settlements.billReceivable(a.receivableId, input({ idempotencyKey: key }));
    const again = await settlements.billReceivable(a.receivableId, input({ idempotencyKey: key }));
    expect(again.action.actionId).toBe(first.action.actionId);
    expect(store.receivableActions.size).toBe(1);
    await expect(settlements.billReceivable(b.receivableId, input({ idempotencyKey: key }))).rejects.toMatchObject({ type: 'idempotency-key-reused', status: 422 });
    expect(store.receivables.get(b.receivableId)?.status).toBe('OPEN');
  });

  test('J-T11 ⑤ 회수는 부분·전액이고 0이 되면 CLOSED다', async () => {
    const r = receivable();
    seed(r, statement());
    await settlements.billReceivable(r.receivableId, input());
    const part = await settlements.collectReceivable(r.receivableId, { ...input(), amount: 200_000 });
    expect(part.receivable.remaining).toBe(245_000);
    expect(part.receivable.status).toBe('BILLED');
    expect(store.receivableMoves).toHaveLength(1);
    expect(store.receivableMoves[0]).toMatchObject({ receivableId: r.receivableId, kind: 'COLLECTED', amount: 200_000, statementId: null });
    const rest = await settlements.collectReceivable(r.receivableId, { ...input(), amount: 245_000 });
    expect(rest.receivable.remaining).toBe(0);
    expect(rest.receivable.status).toBe('CLOSED');
    await expect(settlements.collectReceivable(r.receivableId, { ...input(), amount: 1 })).rejects.toMatchObject({ type: 'receivable-not-billed', status: 409 });
  });

  test('J-T11 ⑤ 회수 금액 경계 밖은 422이고 아무것도 쓰지 않는다', async () => {
    const r = receivable();
    seed(r, statement());
    await settlements.billReceivable(r.receivableId, input());
    const before = store.receivableMoves.length;
    for (const amount of [0, -1, 1.5, 445_001]) {
      await expect(settlements.collectReceivable(r.receivableId, { ...input(), amount })).rejects.toMatchObject({ type: 'invalid-receivable-amount', status: 422 });
    }
    expect(store.receivableMoves).toHaveLength(before);
    expect(store.receivables.get(r.receivableId)?.remaining).toBe(445_000);
  });

  test('J-T11 ⑤ 손실은 청구 뒤 남은 금액 전부이고 OPEN에서는 409다', async () => {
    const open = receivable();
    seed(open, statement());
    await expect(settlements.writeOffReceivable(open.receivableId, input())).rejects.toMatchObject({ type: 'receivable-not-billed', status: 409 });
    expect(store.receivableMoves).toEqual([]);

    const r = receivable();
    seed(r, statement());
    await settlements.billReceivable(r.receivableId, input());
    await settlements.collectReceivable(r.receivableId, { ...input(), amount: 100_000 });
    const lost = await settlements.writeOffReceivable(r.receivableId, input());
    expect(lost.receivable.remaining).toBe(0);
    expect(lost.receivable.status).toBe('WRITTEN_OFF');
    const last = store.receivableMoves.at(-1)!;
    expect(last).toMatchObject({ kind: 'WRITE_OFF', amount: 345_000, statementId: null });
  });

  test('J-T11 ⑤ 재인증이 없거나 틀리면 403이고 쓰기 0이다', async () => {
    const r = receivable();
    seed(r, statement());
    await expect(settlements.billReceivable(r.receivableId, input({ reauthToken: undefined }))).rejects.toMatchObject({ type: 'reauth-required', status: 403 });
    await expect(settlements.billReceivable(r.receivableId, input({ reauthToken: 'wrong' }))).rejects.toMatchObject({ type: 'reauth-required', status: 403 });
    expect(store.receivableActions.size).toBe(0);
    expect(store.receivables.get(r.receivableId)?.status).toBe('OPEN');
  });

  test('J-T24 ④ 한 트랜잭션이 깨지면 action·이동·상태가 모두 없다', async () => {
    const r = receivable();
    seed(r, statement());
    store.failReceivableAction = true;
    await expect(settlements.billReceivable(r.receivableId, input())).rejects.toThrow();
    expect(store.receivableActions.size).toBe(0);
    expect(store.receivables.get(r.receivableId)?.status).toBe('OPEN');
    expect(store.receivableMoves).toEqual([]);
  });

  test('J-T24 ④ 같은 미수금에 겹친 회수는 남은 금액을 넘지 않는다', async () => {
    const r = receivable({ amount: 100_000, remaining: 100_000 });
    seed(r, statement());
    await settlements.billReceivable(r.receivableId, input());
    const results = await Promise.allSettled([
      settlements.collectReceivable(r.receivableId, { ...input(), amount: 60_000 }),
      settlements.collectReceivable(r.receivableId, { ...input(), amount: 60_000 }),
    ]);
    const fulfilled = results.filter((x) => x.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);
    const moves = store.receivableMoves.filter((m) => m.kind === 'COLLECTED');
    expect(moves.reduce((s, m) => s + m.amount, 0)).toBe(60_000);
    expect(store.receivables.get(r.receivableId)?.remaining).toBe(40_000);
  });

  test('J-T24 ④ 이동 합과 남은 금액이 언제나 맞는다', async () => {
    const r = receivable({ amount: 500_000, remaining: 500_000 });
    seed(r, statement());
    await settlements.billReceivable(r.receivableId, input());
    await settlements.collectReceivable(r.receivableId, { ...input(), amount: 125_000 });
    await settlements.collectReceivable(r.receivableId, { ...input(), amount: 125_000 });
    const sum = store.receivableMoves.reduce((s, m) => s + m.amount, 0);
    const now = store.receivables.get(r.receivableId)!;
    expect(now.remaining).toBe(now.amount - sum);
    expect(now.remaining).toBe(250_000);
  });

  test('[ASVS v5.0.0-2.3.3] J-T11 ⑤ 청구·회수·손실의 action·이동·상태가 한 트랜잭션에 남는다', async () => {
    const r = receivable();
    seed(r, statement());
    const billed = await settlements.billReceivable(r.receivableId, input());
    expect(store.receivableActions.get(billed.action.idempotencyKey)).toMatchObject({ kind: 'BILLED', amount: 445_000 });
    const collected = await settlements.collectReceivable(r.receivableId, { ...input(), amount: 45_000 });
    expect(store.receivableActions.get(collected.action.idempotencyKey)).toMatchObject({ kind: 'COLLECTED', amount: 45_000, remainingAfter: 400_000 });
    expect(store.receivableMoves.at(-1)).toMatchObject({ kind: 'COLLECTED', amount: 45_000 });
    expect(store.receivables.get(r.receivableId)).toMatchObject({ remaining: 400_000, status: 'BILLED' });
  });
});
