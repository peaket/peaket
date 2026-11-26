// J-T11 ⑤·J-T24 ④: 지급 뒤 미수금의 청구·회수·손실 수동 전이(F-07-15 I-01, settlement §7).
// 정본 값: 30일, 남은 금액, COLLECTED/WRITE_OFF 이동 한 줄, 같은 키 한 번, 한 트랜잭션.
// 기준 트리에서는 Settlements의 새 메서드가 없어 각 시험이 실행 중 TypeError로 실패한다(beforeEach는 견딘다).
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { Settlements } from '../src/modules/settlement/application/settlements.js';
import type { ReceivableRecord, StatementRecord } from '../src/modules/settlement/domain/settlement.js';
import type { PayoutApprovalVerifier, PromoterContractSource, SaleSuspensionSource } from '../src/modules/settlement/domain/ports.js';
import { MemorySettlementPaymentSource, MemorySettlementStore, UnavailableTossPayoutGateway } from '../src/modules/settlement/index.js';
import { SettlementProblem } from '../src/modules/settlement/domain/settlement.js';

const NOW = new Date('2026-11-27T03:00:00.000Z');
const PROMOTER = randomUUID();
const EVENT = randomUUID();
const DAY = 24 * 60 * 60 * 1000;
const TOKEN = 'test-reauth';

type Kind = 'BILLED' | 'COLLECTED' | 'WRITE_OFF';
interface ActionRecord {
  actionId: string;
  idempotencyKey: string;
  receivableId: string;
  kind: Kind;
  amount: number;
  remainingAfter: number;
  actor: string;
  reason: string;
  createdAt: Date;
}
interface ActionResult {
  action: ActionRecord;
  receivable: ReceivableRecord;
}
interface ActionInput {
  actor: string;
  sessionId: string;
  reauthToken?: string;
  idempotencyKey: string;
  reason: string;
}
interface ActionsApi {
  billReceivable(id: string, input: ActionInput): Promise<ActionResult>;
  collectReceivable(id: string, input: ActionInput & { amount: number }): Promise<ActionResult>;
  writeOffReceivable(id: string, input: ActionInput): Promise<ActionResult>;
}
interface StoreView {
  receivableActions: Map<string, ActionRecord>;
  failReceivableAction: boolean;
  failReceivableMovement: boolean;
  failReceivableStatus: boolean;
}

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
/** act를 기록하고 APPROVAL이 아니면 403. MemoryReauthVerifier는 act를 무시해 RV0715-05를 못 잡는다 */
class RecordingReauth {
  readonly acts: string[] = [];
  async verify(token: string | undefined, o: { sessionId: string; act: string }) {
    this.acts.push(o.act);
    if (token !== TOKEN || o.act !== 'APPROVAL') throw new SettlementProblem('reauth-required', 403, '다시 인증해 주세요');
    return { jti: 'test-jti', accountId: 'test-account', sessionId: o.sessionId, act: o.act, factors: ['password', 'totp', 'passkey'] };
  }
}

const store = new MemorySettlementStore();
const reauth = new RecordingReauth();
const settlements = new Settlements({
  store,
  payments: new MemorySettlementPaymentSource(),
  approvals: new FakeApprovals(),
  saleSuspensions: new FakeSuspensions(),
  promoterContracts: new FakeContracts(),
  gateways: [new UnavailableTossPayoutGateway()],
  reauth: reauth as never,
  clock: { now: () => NOW.getTime(), monotonicMs: () => 0 },
});
const api = settlements as unknown as ActionsApi;
let view: StoreView;

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

/** 한 시험이 실패를 주입한 뒤 action·이동·상태가 모두 그대로인지 */
const expectNoWrites = (receivableId: string, status: string, remaining: number) => {
  expect(view.receivableActions.size).toBe(0);
  expect(store.receivableMoves).toEqual([]);
  expect(store.receivables.get(receivableId)).toMatchObject({ status, remaining });
};

beforeEach(() => {
  store.statements.clear();
  store.receivables.clear();
  store.receivableMoves.length = 0;
  view = store as unknown as StoreView;
  // 기준 트리에는 이 칸이 없다. 시험 대역이 여기서 만들고, 구현은 같은 이름의 칸을 둔다
  view.receivableActions = new Map();
  view.failReceivableAction = false;
  view.failReceivableMovement = false;
  view.failReceivableStatus = false;
  reauth.acts.length = 0;
});

describe('J-T11 ⑤ 청구·회수·손실', () => {
  test('J-T11 ⑤ 청구는 30일 경계이고 청구 금액·남은 금액은 그때의 remaining이다', async () => {
    const early = receivable({ createdAt: new Date(NOW.getTime() - 30 * DAY + 1), updatedAt: new Date(NOW.getTime() - 30 * DAY + 1) });
    seed(early, statement());
    await expect(api.billReceivable(early.receivableId, input())).rejects.toMatchObject({ type: 'receivable-billing-not-due', status: 409 });
    expectNoWrites(early.receivableId, 'OPEN', 445_000);

    // 보증으로 일부를 메운 뒤처럼 amount와 remaining이 다르다(RV0715-03). 청구는 remaining을 쓴다
    const due = receivable({ amount: 500_000, remaining: 445_000, createdAt: new Date(NOW.getTime() - 30 * DAY), updatedAt: new Date(NOW.getTime() - 30 * DAY) });
    seed(due, statement());
    const result = await api.billReceivable(due.receivableId, input());
    expect(result.action.kind).toBe('BILLED');
    expect(result.action.amount).toBe(445_000);
    expect(result.action.remainingAfter).toBe(445_000);
    expect(result.receivable).toMatchObject({ status: 'BILLED', amount: 500_000, remaining: 445_000 });
    expect(store.receivableMoves).toEqual([]);
    await expect(api.billReceivable(due.receivableId, input())).rejects.toMatchObject({ type: 'receivable-not-open', status: 409 });
  });

  test('J-T11 ⑤ 같은 멱등 키는 한 번만 옮기고 종류·금액·대상을 바꾸면 422다', async () => {
    const a = receivable();
    const b = receivable();
    seed(a, statement());
    seed(b, statement());
    const key = randomUUID();
    const first = await api.billReceivable(a.receivableId, input({ idempotencyKey: key }));
    const again = await api.billReceivable(a.receivableId, input({ idempotencyKey: key }));
    expect(again.action.actionId).toBe(first.action.actionId);
    expect(view.receivableActions.size).toBe(1);
    await expect(api.collectReceivable(a.receivableId, { ...input({ idempotencyKey: key }), amount: 1 })).rejects.toMatchObject({ type: 'idempotency-key-reused', status: 422 });
    await expect(api.billReceivable(b.receivableId, input({ idempotencyKey: key }))).rejects.toMatchObject({ type: 'idempotency-key-reused', status: 422 });
    expect(store.receivables.get(b.receivableId)?.status).toBe('OPEN');

    // 같은 키·같은 종류(COLLECTED)·같은 미수금에서 금액만 바꾼 경우도 별도로 막는다
    const c = receivable({ status: 'BILLED', amount: 500_000, remaining: 445_000 });
    seed(c, statement());
    const collectKey = randomUUID();
    await api.collectReceivable(c.receivableId, { ...input({ idempotencyKey: collectKey }), amount: 100_000 });
    await expect(api.collectReceivable(c.receivableId, { ...input({ idempotencyKey: collectKey }), amount: 200_000 })).rejects.toMatchObject({ type: 'idempotency-key-reused', status: 422 });
    expect(store.receivables.get(c.receivableId)?.remaining).toBe(345_000);
  });

  test('J-T11 ⑤ 회수는 부분·전액이고 0이 되면 CLOSED다', async () => {
    const r = receivable();
    seed(r, statement());
    await api.billReceivable(r.receivableId, input());
    const part = await api.collectReceivable(r.receivableId, { ...input(), amount: 200_000 });
    expect(part.receivable.remaining).toBe(245_000);
    expect(part.receivable.status).toBe('BILLED');
    expect(store.receivableMoves).toHaveLength(1);
    expect(store.receivableMoves[0]).toMatchObject({ receivableId: r.receivableId, kind: 'COLLECTED', amount: 200_000, statementId: null });
    const rest = await api.collectReceivable(r.receivableId, { ...input(), amount: 245_000 });
    expect(rest.receivable.remaining).toBe(0);
    expect(rest.receivable.status).toBe('CLOSED');
    await expect(api.collectReceivable(r.receivableId, { ...input(), amount: 1 })).rejects.toMatchObject({ type: 'receivable-not-billed', status: 409 });
  });

  test('J-T11 ⑤ 회수 금액 경계 밖은 422이고 아무것도 쓰지 않는다', async () => {
    const r = receivable();
    seed(r, statement());
    await api.billReceivable(r.receivableId, input());
    const before = store.receivableMoves.length;
    for (const amount of [0, -1, 1.5, 445_001]) {
      await expect(api.collectReceivable(r.receivableId, { ...input(), amount })).rejects.toMatchObject({ type: 'invalid-receivable-amount', status: 422 });
    }
    expect(store.receivableMoves).toHaveLength(before);
    expect(store.receivables.get(r.receivableId)?.remaining).toBe(445_000);
  });

  test('J-T11 ⑤ 손실은 청구 뒤 남은 금액 전부이고 OPEN에서는 409다', async () => {
    const open = receivable();
    seed(open, statement());
    await expect(api.writeOffReceivable(open.receivableId, input())).rejects.toMatchObject({ type: 'receivable-not-billed', status: 409 });
    expect(store.receivableMoves).toEqual([]);

    const r = receivable();
    seed(r, statement());
    await api.billReceivable(r.receivableId, input());
    await api.collectReceivable(r.receivableId, { ...input(), amount: 100_000 });
    const lost = await api.writeOffReceivable(r.receivableId, input());
    expect(lost.receivable.remaining).toBe(0);
    expect(lost.receivable.status).toBe('WRITTEN_OFF');
    const last = store.receivableMoves.at(-1)!;
    expect(last).toMatchObject({ kind: 'WRITE_OFF', amount: 345_000, statementId: null });
  });

  test('J-T11 ⑤ 재인증은 act=APPROVAL만 받고 없거나 틀리면 403이며 쓰기 0이다', async () => {
    const r = receivable();
    seed(r, statement());
    await expect(api.billReceivable(r.receivableId, input({ reauthToken: undefined }))).rejects.toMatchObject({ type: 'reauth-required', status: 403 });
    await expect(api.billReceivable(r.receivableId, input({ reauthToken: 'wrong' }))).rejects.toMatchObject({ type: 'reauth-required', status: 403 });
    expectNoWrites(r.receivableId, 'OPEN', 445_000);
    expect(reauth.acts.length).toBe(2);
    expect(reauth.acts.every((x) => x === 'APPROVAL')).toBe(true);
  });

  test('J-T11 ⑤ 사유는 1~2,000자만 받고 멱등 키는 필수다', async () => {
    const one = receivable();
    seed(one, statement());
    await expect(api.billReceivable(one.receivableId, input({ reason: '가'.repeat(1) }))).resolves.toMatchObject({ action: { kind: 'BILLED' } });
    const max = receivable();
    seed(max, statement());
    await expect(api.billReceivable(max.receivableId, input({ reason: '가'.repeat(2_000) }))).resolves.toMatchObject({ action: { kind: 'BILLED' } });
    const over = receivable();
    seed(over, statement());
    const blank = receivable();
    seed(blank, statement());
    view.receivableActions.clear();
    store.receivableMoves.length = 0;
    await expect(api.billReceivable(over.receivableId, input({ reason: '가'.repeat(2_001) }))).rejects.toMatchObject({ status: 422 });
    await expect(api.billReceivable(blank.receivableId, input({ idempotencyKey: '' }))).rejects.toMatchObject({ status: 422 });
    expectNoWrites(over.receivableId, 'OPEN', 445_000);
    expectNoWrites(blank.receivableId, 'OPEN', 445_000);
  });

  test('J-T24 ④ 한 트랜잭션이 깨지면 action·이동·상태가 모두 없다', async () => {
    const cases: Array<{ kind: 'bill' | 'collect' | 'writeOff'; flag: 'failReceivableAction' | 'failReceivableMovement' | 'failReceivableStatus'; status: 'OPEN' | 'BILLED' }> = [
      { kind: 'bill', flag: 'failReceivableAction', status: 'OPEN' },
      { kind: 'collect', flag: 'failReceivableAction', status: 'BILLED' },
      { kind: 'collect', flag: 'failReceivableMovement', status: 'BILLED' },
      { kind: 'collect', flag: 'failReceivableStatus', status: 'BILLED' },
      { kind: 'writeOff', flag: 'failReceivableAction', status: 'BILLED' },
      { kind: 'writeOff', flag: 'failReceivableMovement', status: 'BILLED' },
      { kind: 'writeOff', flag: 'failReceivableStatus', status: 'BILLED' },
    ];
    for (const c of cases) {
      store.receivables.clear();
      store.receivableMoves.length = 0;
      view.receivableActions.clear();
      const r = receivable({ status: c.status, amount: 500_000, remaining: 445_000 });
      seed(r, statement());
      view[c.flag] = true;
      const run = c.kind === 'bill' ? api.billReceivable(r.receivableId, input()) : c.kind === 'collect' ? api.collectReceivable(r.receivableId, { ...input(), amount: 100_000 }) : api.writeOffReceivable(r.receivableId, input());
      await expect(run).rejects.toThrow();
      expectNoWrites(r.receivableId, c.status, 445_000);
      view[c.flag] = false;
    }
  });

  test('J-T24 ④ 같은 미수금에 겹친 회수는 남은 금액을 넘지 않는다', async () => {
    const r = receivable({ amount: 100_000, remaining: 100_000 });
    seed(r, statement());
    await api.billReceivable(r.receivableId, input());
    const results = await Promise.allSettled([
      api.collectReceivable(r.receivableId, { ...input(), amount: 60_000 }),
      api.collectReceivable(r.receivableId, { ...input(), amount: 60_000 }),
    ]);
    const fulfilled = results.filter((x) => x.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);
    const moves = store.receivableMoves.filter((m) => m.kind === 'COLLECTED');
    expect(moves.reduce((s, m) => s + m.amount, 0)).toBe(60_000);
    expect(store.receivables.get(r.receivableId)?.remaining).toBe(40_000);
  });

  test('[ASVS v5.0.0-2.3.3] J-T11 ⑤ 청구·회수·손실의 action·이동·상태가 한 트랜잭션에 남는다', async () => {
    const r = receivable({ amount: 500_000, remaining: 445_000 });
    seed(r, statement());
    const billed = await api.billReceivable(r.receivableId, input());
    expect(view.receivableActions.get(billed.action.idempotencyKey)).toMatchObject({ kind: 'BILLED', amount: 445_000, remainingAfter: 445_000 });
    const collected = await api.collectReceivable(r.receivableId, { ...input(), amount: 45_000 });
    expect(view.receivableActions.get(collected.action.idempotencyKey)).toMatchObject({ kind: 'COLLECTED', amount: 45_000, remainingAfter: 400_000 });
    expect(store.receivableMoves.at(-1)).toMatchObject({ kind: 'COLLECTED', amount: 45_000 });
    expect(store.receivables.get(r.receivableId)).toMatchObject({ remaining: 400_000, status: 'BILLED' });
  });
});
