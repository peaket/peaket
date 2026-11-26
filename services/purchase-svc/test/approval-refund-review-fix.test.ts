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
  paymentCalls: [] as { amount: number }[],
  createOutcome: { status: 'CREATED' } as { status: string },
  created: [] as Record<string, unknown>[],
  records: new Map<string, CancellationRecord>(),
  entry: false,
};
const orders: CancellationOrders = {
  async findByTicket() {
    return state.view;
  },
  async findCancellation(id: string) {
    return state.records.get(id);
  },
  async byOrder() {
    return state.orderRows.length > 0 ? state.orderRows : [state.view];
  },
  async cancellationsOf() {
    return state.prior;
  },
} as unknown as CancellationOrders;
const writes: CancellationWrites = {
  async create(q) {
    state.created.push({ ...q });
    if (state.createOutcome.status === 'CONFLICT') return { status: 'CONFLICT' } as never;
    state.records.set(q.cancellationId, { cancellationId: q.cancellationId, orderId: q.orderId, ticketId: q.ticketId, refundAmount: q.refundAmount, state: q.status, refundAttempts: 0, ...(typeof (q as { kind?: unknown }).kind === 'string' ? { kind: (q as { kind: string }).kind } : {}) } as CancellationRecord);
    return { status: 'CREATED' };
  },
  async updateStatus() {},
  async scheduleRefundRetry() {},
  async markRefundFailed() {},
  async markRefundAccountRequired() {},
  async dueRefunds() {
    return [];
  },
};
const tickets: TicketCancellations = {
  async cancel() {
    return state.ticketAnswer as never;
  },
};
const payments: PaymentCancellations = {
  async cancel(q) {
    state.paymentCalls.push({ amount: q.amount });
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
  state.paymentCalls.length = 0;
  state.createOutcome = { status: 'CREATED' };
  state.created.length = 0;
  state.records.clear();
  state.entry = false;
});

describe('IR-10 부분 환불·이전 취소', () => {
  test('IR-10 부분 환불된 주문은 남은 환급 가능 금액만 받고 전액 요청은 422다', async () => {
    state.view = view({ orderStatus: 'PARTIALLY_REFUNDED', refundableAmount: 10_000 });
    await expect(refunds.execute(approvalId(), { kind: 'SYSTEM_FAULT_REFUND', orderId: state.view.orderId, amount: PRICE })).rejects.toMatchObject({ status: 422, type: expect.stringContaining('approval-refund-amount-mismatch') });
    const ok = await refunds.execute(approvalId(), { kind: 'SYSTEM_FAULT_REFUND', orderId: state.view.orderId, amount: 10_000 });
    expect(ok.refundAmount).toBe(10_000);
    expect(state.paymentCalls).toEqual([{ amount: 10_000 }]);
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

describe('IR-21 다중 티켓 기록', () => {
  test('IR-21 모든 티켓의 order_cancellation을 남긴다', async () => {
    const a = view({ ticketId: randomUUID(), refundableAmount: 10_000 });
    const b = view({ ticketId: randomUUID(), refundableAmount: 10_000 });
    const orderId = a.orderId;
    state.orderRows = [a, b];
    state.view = { ...a, orderId };
    const out = await refunds.execute(approvalId(), { kind: 'SYSTEM_FAULT_REFUND', orderId, amount: 20_000 });
    expect(out.refundAmount).toBe(20_000);
    expect(state.created.map((c) => c['ticketId'])).toEqual([a.ticketId, b.ticketId]);
  });
});
