// F-06-3 구현 리뷰 IR-10·13·21 재현 시험(구현 담당, 2026-11-26).
// 부분 환불·이전 취소·티켓 결과·승인 kind 멱등·입장 기록을 ApprovalRefunds 경계에서 본다.
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { ApprovalRefunds } from '../src/modules/refund/application/approval-refund.js';
import type { CancellationOrderView, CancellationRecord } from '../src/modules/refund/domain/cancellation.js';
import type { CancellationOrders, CancellationWrites, PaymentCancellations, TicketCancellations } from '../src/modules/refund/domain/ports.js';

const NOW = Date.parse('2026-11-26T10:00:00+09:00');
const PAYER = randomUUID();
const PRICE = 33_333;
const state = {
  view: {} as CancellationOrderView,
  orderRows: [] as CancellationOrderView[],
  prior: [] as CancellationRecord[],
  ticketAnswer: 'REFUND_NOW' as unknown,
  ticketCalls: [] as Record<string, unknown>[],
  paymentCalls: [] as { amount: number; cancellationId: string }[],
  createOutcome: { status: 'CREATED' } as { status: string },
  created: [] as Record<string, unknown>[],
  records: new Map<string, CancellationRecord & { approvalId?: string }>(),
  updates: [] as { cancellationId: string; status: string }[],
  failRefunded: false,
  entry: false,
};
const orders: CancellationOrders = {
  async findByTicket() {
    return state.view;
  },
  async findCancellation(id: string) {
    return state.records.get(id);
  },
  async approvalRefundOf(approvalId: string) {
    return [...state.records.values()].filter((r) => r.approvalId === approvalId);
  },
  async byOrder(orderId: string) {
    const rows = state.orderRows.length > 0 ? state.orderRows : [state.view];
    return rows.filter((r) => r.orderId === orderId);
  },
  async cancellationsOf(orderId?: string) {
    return orderId === undefined ? state.prior : state.prior.filter((r) => r.orderId === orderId);
  },
} as unknown as CancellationOrders;
const writes: CancellationWrites = {
  async create(q) {
    state.created.push({ ...q });
    if (state.createOutcome.status === 'CONFLICT') return { status: 'CONFLICT' } as never;
    const record = { cancellationId: q.cancellationId, orderId: q.orderId, ticketId: q.ticketId, refundAmount: q.refundAmount, state: q.status, refundAttempts: 0, ...(typeof (q as { kind?: unknown }).kind === 'string' ? { kind: (q as { kind: string }).kind } : {}) } as CancellationRecord & { approvalId?: string };
    if (typeof (q as { approvalId?: unknown }).approvalId === 'string') record.approvalId = (q as { approvalId: string }).approvalId;
    state.records.set(q.cancellationId, record);
    return { status: 'CREATED' };
  },
  async updateStatus(q) {
    state.updates.push({ cancellationId: q.cancellationId, status: q.status });
    const record = state.records.get(q.cancellationId);
    if (!record) return false;
    if (q.status === 'REFUNDED') {
      if (state.failRefunded || record.state !== 'REFUND_PENDING') return false;
    }
    if (q.status === 'VOIDED' && (record.state === 'REFUNDED' || record.state === 'VOIDED')) return false;
    state.records.set(q.cancellationId, { ...record, state: q.status });
    return true;
  },
  async scheduleRefundRetry() {},
  async markRefundFailed() {},
  async markRefundAccountRequired() {},
  async dueRefunds() {
    return [];
  },
};
const tickets: TicketCancellations = {
  async cancel(q) {
    state.ticketCalls.push({ ...q });
    return state.ticketAnswer as never;
  },
};
const payments: PaymentCancellations = {
  async cancel(q) {
    state.paymentCalls.push({ amount: q.amount, cancellationId: q.cancellationId });
    return 'CANCELLED';
  },
};
const refunds = new ApprovalRefunds({
  orders,
  writes,
  tickets,
  payments,
  clock: { now: () => NOW, monotonicMs: () => NOW },
  entryRecords: { async hasEntry() { return state.entry; } },
});
const approvalId = () => randomUUID();
const view = (o: Partial<CancellationOrderView & { refundableAmount?: number }> = {}): CancellationOrderView & { refundableAmount?: number } => ({
  orderId: randomUUID(),
  eventId: randomUUID(),
  ticketId: randomUUID(),
  seatId: randomUUID(),
  payerAccountId: PAYER,
  ticketPrice: PRICE,
  bookedAtMs: NOW - 86_400_000,
  saleEndsAtMs: NOW + 86_400_000,
  entryOpensAtMs: NOW + 86_400_000,
  orderStatus: 'CONFIRMED',
  refundableAmount: PRICE,
  ...o,
});

beforeEach(() => {
  state.view = view();
  state.orderRows = [];
  state.prior = [];
  state.ticketAnswer = 'REFUND_NOW';
  state.ticketCalls.length = 0;
  state.paymentCalls.length = 0;
  state.createOutcome = { status: 'CREATED' };
  state.created.length = 0;
  state.records.clear();
  state.updates.length = 0;
  state.failRefunded = false;
  state.entry = false;
});

describe('IR-10 부분 환불·이전 취소', () => {
  test('IR-10 부분 환불된 주문은 남은 환급 가능 금액만 받고 전액 요청은 422다', async () => {
    state.view = view({ orderStatus: 'PARTIALLY_REFUNDED', refundableAmount: 10_000 });
    await expect(refunds.execute(approvalId(), { kind: 'SYSTEM_FAULT_REFUND', orderId: state.view.orderId, amount: PRICE })).rejects.toMatchObject({ status: 422, type: expect.stringContaining('approval-refund-amount-mismatch') });
    const ok = await refunds.execute(approvalId(), { kind: 'SYSTEM_FAULT_REFUND', orderId: state.view.orderId, amount: 10_000 });
    expect(ok.refundAmount).toBe(10_000);
    expect(state.paymentCalls).toEqual([{ amount: 10_000, cancellationId: expect.any(String) }]);
  });

  test('IR-10 이전 취소가 있으면 승인 환불을 거절한다', async () => {
    state.prior = [{ cancellationId: randomUUID(), orderId: state.view.orderId, ticketId: state.view.ticketId, refundAmount: 1, state: 'REFUNDED', refundAttempts: 0 }];
    await expect(refunds.execute(approvalId(), { kind: 'SYSTEM_FAULT_REFUND', orderId: state.view.orderId, amount: PRICE })).rejects.toMatchObject({ status: 409 });
  });

  test('IR-10 티켓이 ALREADY_CANCELLED면 결제사를 다시 부르지 않고 409다', async () => {
    state.ticketAnswer = { result: 'ALREADY_CANCELLED', firstCancellationId: randomUUID(), firstResult: 'REFUND_NOW', firstCancelledAtMs: NOW };
    await expect(refunds.execute(approvalId(), { kind: 'SYSTEM_FAULT_REFUND', orderId: state.view.orderId, amount: PRICE })).rejects.toMatchObject({ status: 409 });
    expect(state.paymentCalls).toHaveLength(0);
  });

  test('IR-10 취소 기록 CONFLICT를 성공으로 바꾸지 않는다', async () => {
    state.createOutcome = { status: 'CONFLICT' };
    await expect(refunds.execute(approvalId(), { kind: 'DISCRETIONARY_WAIVER', orderId: state.view.orderId, amount: 10_000 })).rejects.toMatchObject({ status: 409 });
  });
});

describe('IR-13 입장 기록', () => {
  test('IR-13 입장 시작 전이어도 입장 기록이 있으면 미성년 취소는 409다', async () => {
    state.entry = true;
    await expect(refunds.execute(approvalId(), { kind: 'MINOR_CONTRACT_CANCEL', orderId: state.view.orderId, amount: PRICE })).rejects.toMatchObject({ status: 409, type: expect.stringContaining('minor-contract-entry-started') });
  });
});

describe('IR-10 다른 티켓 부분 취소', () => {
  test('IR-10 같은 주문의 다른 티켓 취소는 남은 금액 환급을 막지 않는다', async () => {
    state.view = view({ refundableAmount: 20_000 });
    state.prior = [{ cancellationId: randomUUID(), orderId: state.view.orderId, ticketId: randomUUID(), refundAmount: 13_333, state: 'REFUNDED', refundAttempts: 0 }];
    const ok = await refunds.execute(approvalId(), { kind: 'SYSTEM_FAULT_REFUND', orderId: state.view.orderId, amount: 20_000 });
    expect(ok.refundAmount).toBe(20_000);
  });
});

describe('IR-21 멱등 kind', () => {
  test('IR-21 같은 승인 ID에 다른 kind가 오면 409다', async () => {
    const id = approvalId();
    await refunds.execute(id, { kind: 'SYSTEM_FAULT_REFUND', orderId: state.view.orderId, amount: PRICE });
    await expect(refunds.execute(id, { kind: 'MINOR_CONTRACT_CANCEL', orderId: state.view.orderId, amount: PRICE })).rejects.toMatchObject({ status: 409, type: expect.stringContaining('approval-refund-conflict') });
  });

  test('IR-21 다른 프로세스(새 인스턴스)에서도 같은 승인 ID의 다른 kind를 막는다', async () => {
    const id = approvalId();
    await refunds.execute(id, { kind: 'SYSTEM_FAULT_REFUND', orderId: state.view.orderId, amount: PRICE });
    const other = new ApprovalRefunds({ orders, writes, tickets, payments, clock: { now: () => NOW, monotonicMs: () => NOW }, entryRecords: { async hasEntry() { return state.entry; } } });
    await expect(other.execute(id, { kind: 'MINOR_CONTRACT_CANCEL', orderId: state.view.orderId, amount: PRICE })).rejects.toMatchObject({ status: 409, type: expect.stringContaining('approval-refund-conflict') });
  });
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('IR-21 다중 티켓 기록', () => {
  test('IR-21 모든 티켓의 order_cancellation을 남긴다', async () => {
    const a = view({ ticketId: randomUUID(), refundableAmount: 10_000 });
    const b = view({ orderId: a.orderId, ticketId: randomUUID(), refundableAmount: 10_000 });
    const orderId = a.orderId;
    state.orderRows = [a, b];
    state.view = { ...a, orderId };
    const out = await refunds.execute(approvalId(), { kind: 'SYSTEM_FAULT_REFUND', orderId, amount: 20_000 });
    expect(out.refundAmount).toBe(20_000);
    expect(state.created.map((c) => c['ticketId'])).toEqual([a.ticketId, b.ticketId]);
  });

  test('IR-21 둘째 행도 UUID이고 첫 행은 승인 ID다', async () => {
    const a = view({ ticketId: randomUUID(), refundableAmount: 10_000 });
    const b = view({ orderId: a.orderId, ticketId: randomUUID(), refundableAmount: 10_000 });
    const orderId = a.orderId;
    state.orderRows = [a, b];
    state.view = { ...a, orderId };
    const id = approvalId();
    await refunds.execute(id, { kind: 'SYSTEM_FAULT_REFUND', orderId, amount: 20_000 });
    const ids = state.created.map((c) => String(c['cancellationId']));
    expect(ids[0]).toBe(id);
    expect(ids[1]).toMatch(UUID);
    expect(new Set(ids).size).toBe(2);
    expect(state.created.every((c) => c['approvalId'] === id)).toBe(true);
  });

  test('IR-21 같은 승인 ID로 다시 보내면 모든 행의 합계를 돌려주고 새 행을 쓰지 않는다', async () => {
    const a = view({ ticketId: randomUUID(), refundableAmount: 10_000 });
    const b = view({ orderId: a.orderId, ticketId: randomUUID(), refundableAmount: 10_000 });
    const orderId = a.orderId;
    state.orderRows = [a, b];
    state.view = { ...a, orderId };
    const id = approvalId();
    const first = await refunds.execute(id, { kind: 'SYSTEM_FAULT_REFUND', orderId, amount: 20_000 });
    const second = await refunds.execute(id, { kind: 'SYSTEM_FAULT_REFUND', orderId, amount: 20_000 });
    expect(second).toEqual(first);
    expect(second.refundAmount).toBe(20_000);
    expect(state.created).toHaveLength(2);
    expect(state.paymentCalls).toHaveLength(1);
  });

  test('IR-21 미발권 두 좌석은 서로 다른 UUID 취소 ID와 티켓 ID를 쓴다', async () => {
    const a = view({ ticketId: '', refundableAmount: 10_000 });
    const b = view({ orderId: a.orderId, ticketId: '', refundableAmount: 10_000 });
    const orderId = a.orderId;
    state.orderRows = [a, b];
    state.view = { ...a, orderId };
    await refunds.execute(approvalId(), { kind: 'SYSTEM_FAULT_REFUND', orderId, amount: 20_000 });
    const ids = state.created.map((c) => String(c['cancellationId']));
    const ticketIds = state.created.map((c) => String(c['ticketId']));
    expect(ids.every((x) => UUID.test(x))).toBe(true);
    expect(new Set(ids).size).toBe(2);
    expect(ticketIds.every((x) => UUID.test(x))).toBe(true);
    expect(new Set(ticketIds).size).toBe(2);
    expect(state.ticketCalls).toHaveLength(0);
  });

  test('IR-21 여러 주문의 환급은 주문마다 티켓을 취소하고 결제사를 부른다', async () => {
    const a = view({ orderId: randomUUID(), ticketId: randomUUID(), refundableAmount: 10_000 });
    const b = view({ orderId: randomUUID(), ticketId: randomUUID(), refundableAmount: 12_000 });
    state.orderRows = [a, b];
    state.view = a;
    const out = await refunds.execute(approvalId(), { kind: 'SYSTEM_FAULT_REFUND', orderId: a.orderId, orderIds: [b.orderId], amount: 22_000 } as never);
    expect(out.refundAmount).toBe(22_000);
    expect(state.ticketCalls.map((c) => c['orderId'])).toEqual([a.orderId, b.orderId]);
    expect(state.paymentCalls.map((c) => c.amount)).toEqual([10_000, 12_000]);
    expect(state.created.map((c) => c['orderId'])).toEqual([a.orderId, b.orderId]);
    expect(state.created.map((c) => c['refundAmount'])).toEqual([10_000, 12_000]);
  });

  test('IR-11 FLAGGED REFUND는 이미 있는 REQUESTED 취소 행을 그대로 환급한다', async () => {
    const existing = randomUUID();
    state.prior = [{ cancellationId: existing, orderId: state.view.orderId, ticketId: state.view.ticketId, refundAmount: PRICE, state: 'REQUESTED', refundAttempts: 0 }];
    state.records.set(existing, state.prior[0]!);
    const out = await refunds.execute(approvalId(), { kind: 'SYSTEM_FAULT_REFUND', orderId: state.view.orderId, amount: PRICE });
    expect(out).toMatchObject({ status: 'REFUNDED', cancellationId: existing, refundAmount: PRICE });
    expect(state.paymentCalls).toEqual([{ amount: PRICE, cancellationId: existing }]);
    expect(state.created).toHaveLength(0);
    expect(state.updates).toEqual([
      { cancellationId: existing, status: 'REFUND_PENDING' },
      { cancellationId: existing, status: 'REFUNDED' },
    ]);
    expect(state.records.get(existing)?.state).toBe('REFUNDED');
  });

  test('IR-11 REFUNDED 전이가 실패하면 승인은 REFUNDED가 아니라 REFUND_PENDING이고 행은 다시 집을 수 있다', async () => {
    const existing = randomUUID();
    state.prior = [{ cancellationId: existing, orderId: state.view.orderId, ticketId: state.view.ticketId, refundAmount: PRICE, state: 'REQUESTED', refundAttempts: 0 }];
    state.records.set(existing, state.prior[0]!);
    state.failRefunded = true;
    const out = await refunds.execute(approvalId(), { kind: 'SYSTEM_FAULT_REFUND', orderId: existing, amount: PRICE });
    expect(out.status).toBe('REFUND_PENDING');
    expect(state.records.get(existing)?.state).toBe('REFUND_PENDING');
    expect(state.updates).toEqual([
      { cancellationId: existing, status: 'REFUND_PENDING' },
      { cancellationId: existing, status: 'REFUNDED' },
    ]);
  });

  test('IR-11 취소가 둘일 때 지정한 취소 ID 하나만 환급한다', async () => {
    const first = randomUUID();
    const second = randomUUID();
    const orderId = state.view.orderId;
    state.prior = [
      { cancellationId: first, orderId, ticketId: state.view.ticketId, refundAmount: 11_000, state: 'REQUESTED', refundAttempts: 0 },
      { cancellationId: second, orderId, ticketId: randomUUID(), refundAmount: 12_000, state: 'REQUESTED', refundAttempts: 0 },
    ];
    state.records.set(first, state.prior[0]!);
    state.records.set(second, state.prior[1]!);
    const out = await refunds.execute(approvalId(), { kind: 'SYSTEM_FAULT_REFUND', orderId: first, amount: 11_000 });
    expect(out).toMatchObject({ status: 'REFUNDED', cancellationId: first, refundAmount: 11_000 });
    expect(state.paymentCalls).toEqual([{ amount: 11_000, cancellationId: first }]);
    expect(state.created).toHaveLength(0);
  });
});
