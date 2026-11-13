// 예매 취소 Saga(POL-032·POL-038, BUILD_ORDER GAT-080): 결제자 확인, 키 폐기, 취소표, PG 부분 취소, 부정 예매 공제 0원.
import { describe, expect, test } from 'vitest';
import {
  CancelTicket,
  QuoteCancellation,
  WeekendBusinessCalendar,
  type CancellationOrderView,
  type CancellationRecord,
  type CancellationWriteOutcome,
  type CancellationWrites,
  type PaymentCancelOutcome,
  type PaymentCancellations,
  type SeatReturns,
  type TicketCancelOutcome,
  type TicketCancellations,
} from '../src/modules/refund/index.js';

const kst = (s: string): number => Date.parse(`${s}+09:00`);
const EVENT = kst('2026-11-20T19:00:00');
const SALE_ENDS = EVENT - 24 * 60 * 60 * 1000;
const TICKET = '01900000-0000-7000-8000-000000000001';
const ORDER = '01900000-0000-7000-8000-000000000002';
const ACCOUNT = '01900000-0000-7000-8000-000000000003';
const CANCEL = '01900000-0000-4000-8000-000000000004';
const calendar = new WeekendBusinessCalendar();

const order = (over: Partial<CancellationOrderView> = {}): CancellationOrderView => ({
  orderId: ORDER,
  eventId: '01900000-0000-7000-8000-000000000005',
  ticketId: TICKET,
  seatId: '01900000-0000-7000-8000-000000000006',
  payerAccountId: ACCOUNT,
  ticketPrice: 33_333,
  bookedAtMs: kst('2026-11-01T10:00:00'),
  saleEndsAtMs: SALE_ENDS,
  entryOpensAtMs: kst('2026-11-20T18:00:00'),
  orderStatus: 'CONFIRMED',
  ...over,
});

class Orders {
  constructor(
    private readonly value: CancellationOrderView | undefined,
    private readonly existing?: CancellationRecord,
  ) {}
  async findByTicket(): Promise<CancellationOrderView | undefined> {
    return this.value;
  }
  async findCancellation(): Promise<CancellationRecord | undefined> {
    return this.existing;
  }
}

class Tickets implements TicketCancellations {
  calls: Parameters<TicketCancellations['cancel']>[0][] = [];
  constructor(private readonly outcome: TicketCancelOutcome) {}
  async cancel(q: Parameters<TicketCancellations['cancel']>[0]): Promise<TicketCancelOutcome> {
    this.calls.push(q);
    return this.outcome;
  }
}

class Payments implements PaymentCancellations {
  calls: Parameters<PaymentCancellations['cancel']>[0][] = [];
  constructor(private readonly outcome: PaymentCancelOutcome) {}
  async cancel(q: Parameters<PaymentCancellations['cancel']>[0]): Promise<PaymentCancelOutcome> {
    this.calls.push(q);
    return this.outcome;
  }
}

class Seats implements SeatReturns {
  calls: Parameters<SeatReturns['returnSold']>[0][] = [];
  async returnSold(q: Parameters<SeatReturns['returnSold']>[0]): Promise<number> {
    this.calls.push(q);
    return 1;
  }
}

class Writes implements CancellationWrites {
  created: Parameters<CancellationWrites['create']>[0][] = [];
  updates: Parameters<CancellationWrites['updateStatus']>[0][] = [];
  retries: Parameters<CancellationWrites['scheduleRefundRetry']>[0][] = [];
  failures: Parameters<CancellationWrites['markRefundFailed']>[0][] = [];
  constructor(private readonly replay?: CancellationWriteOutcome) {}
  async create(q: Parameters<CancellationWrites['create']>[0]): Promise<CancellationWriteOutcome> {
    this.created.push(q);
    return this.replay ?? { status: 'CREATED' };
  }
  async updateStatus(q: Parameters<CancellationWrites['updateStatus']>[0]): Promise<void> {
    this.updates.push(q);
  }
  async scheduleRefundRetry(q: Parameters<CancellationWrites['scheduleRefundRetry']>[0]): Promise<void> {
    this.retries.push(q);
  }
  async markRefundFailed(q: Parameters<CancellationWrites['markRefundFailed']>[0]): Promise<void> {
    this.failures.push(q);
  }
  async dueRefunds(): Promise<[]> {
    return [];
  }
}

const saga = (o: { order?: CancellationOrderView | undefined; ticket?: TicketCancelOutcome; payment?: PaymentCancelOutcome; replay?: CancellationWriteOutcome } = {}) => {
  const tickets = new Tickets(o.ticket ?? 'REFUND_NOW');
  const payments = new Payments(o.payment ?? 'CANCELLED');
  const writes = new Writes(o.replay);
  const seats = new Seats();
  const svc = new CancelTicket({ orders: new Orders(o.order ?? order()), calendar, tickets, payments, writes, seats });
  return { svc, tickets, payments, writes, seats };
};

describe('견적', () => {
  test('결제자만 견적을 보고, 공연 시작 뒤에는 409다', async () => {
    const q = new QuoteCancellation({ orders: new Orders(order()), calendar });
    const ok = await q.execute({ accountId: ACCOUNT, ticketId: TICKET, nowMs: kst('2026-11-13T10:00:00') });
    expect(ok.status).toBe('OK');
    if (ok.status !== 'OK') return;
    expect(ok.quote.daysBefore).toBe(7);
    expect(ok.quote.deductionAmount).toBe(3_333);
    expect(ok.quote.refundAmount).toBe(30_000);
    expect(await q.execute({ accountId: '01900000-0000-7000-8000-000000000099', ticketId: TICKET, nowMs: kst('2026-11-13T10:00:00') })).toEqual({ status: 'NOT_PAYER' });
    expect(await q.execute({ accountId: ACCOUNT, ticketId: TICKET, nowMs: EVENT })).toEqual({ status: 'EVENT_STARTED' });
  });
});

describe('취소 Saga', () => {
  test('R-T4 POL-032 결제자 확인 뒤 키를 폐기하고 PG 부분 취소가 끝나면 REFUNDED다', async () => {
    const { svc, tickets, payments, writes, seats } = saga();
    const r = await svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: CANCEL, reason: 'USER', nowMs: kst('2026-11-13T10:00:00'), deadlineMs: 2000 });
    expect(r).toEqual({ status: 'ACCEPTED', cancellationId: CANCEL, refundAmount: 30_000, refundAfterEntryClose: false });
    expect(tickets.calls[0]).toMatchObject({ orderId: ORDER, ticketIds: [TICKET], requestedByAccountId: ACCOUNT, cancellationId: CANCEL });
    expect(seats.calls[0]).toEqual({ eventId: order().eventId, orderId: ORDER, seatId: order().seatId, accountId: ACCOUNT, saleEndsAtMs: SALE_ENDS });
    expect(payments.calls[0]).toMatchObject({ cancellationId: CANCEL, orderId: ORDER, amount: 30_000 });
    expect(writes.created[0]).toMatchObject({ deductionBp: 1000, deductionAmount: 3_333, refundAmount: 30_000, status: 'REFUND_PENDING' });
    expect(writes.updates).toEqual([{ cancellationId: CANCEL, status: 'REFUNDED', nowMs: kst('2026-11-13T10:00:00') }]);
  });

  test('R-T31 부정 예매 취소는 공제 없이 결제자에게 돌려준다', async () => {
    const { svc, payments, writes } = saga();
    const r = await svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: CANCEL, reason: 'FRAUD', nowMs: kst('2026-11-13T10:00:00'), deadlineMs: 2000 });
    expect(r).toMatchObject({ status: 'ACCEPTED', refundAmount: 33_333 });
    expect(payments.calls[0]).toMatchObject({ amount: 33_333, reason: 'FRAUD' });
    expect(writes.created[0]).toMatchObject({ deductionBp: 0, deductionAmount: 0, refundAmount: 33_333 });
  });

  test('GAT090_다른 계정이 남의 취소 ID로 재요청하면 NOT_PAYER다', async () => {
    const existing: CancellationRecord = { cancellationId: CANCEL, orderId: ORDER, ticketId: TICKET, refundAmount: 30_000, state: 'REFUNDED', refundAttempts: 0 };
    const payments = new Payments('CANCELLED');
    const svc = new CancelTicket({ orders: new Orders(order(), existing), calendar, tickets: new Tickets('REFUND_NOW'), payments, writes: new Writes(), seats: new Seats() });
    expect(await svc.execute({ accountId: '01900000-0000-7000-8000-000000000099', ticketId: TICKET, cancellationId: CANCEL, reason: 'USER', nowMs: kst('2026-11-13T10:00:00'), deadlineMs: 2000 })).toEqual({ status: 'NOT_PAYER' });
    expect(payments.calls).toHaveLength(0);
  });

  test('R-T3 남이 보유하거나 양도 요청 중이거나 공연이 시작됐으면 쓰지 않고 거절한다', async () => {
    for (const [ticket, expected] of [
      ['NOT_PAYER_HOLDER', { status: 'TICKET_NOT_HELD' }],
      ['TRANSFER_PENDING', { status: 'TRANSFER_PENDING' }],
      ['EVENT_STARTED', { status: 'EVENT_STARTED' }],
    ] as const) {
      const { svc, writes } = saga({ ticket });
      const r = await svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: CANCEL, reason: 'USER', nowMs: kst('2026-11-13T10:00:00'), deadlineMs: 2000 });
      expect(r).toEqual(expected);
      expect(writes.created).toHaveLength(0);
    }
    const { svc } = saga();
    expect(await svc.execute({ accountId: '01900000-0000-7000-8000-000000000099', ticketId: TICKET, cancellationId: CANCEL, reason: 'USER', nowMs: kst('2026-11-13T10:00:00'), deadlineMs: 2000 })).toEqual({ status: 'NOT_PAYER' });
  });

  test('입장 시작 뒤 취소는 키만 폐기하고 환급을 입장 기록 마감 뒤로 미룬다', async () => {
    const { svc, payments, writes } = saga({ ticket: 'REFUND_AFTER_CLOSE' });
    const r = await svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: CANCEL, reason: 'USER', nowMs: kst('2026-11-20T18:30:00'), deadlineMs: 2000 });
    expect(r).toEqual({ status: 'ACCEPTED', cancellationId: CANCEL, refundAmount: 3_334, refundAfterEntryClose: true });
    expect(payments.calls).toHaveLength(0);
    expect(writes.created[0]).toMatchObject({ status: 'REQUESTED', deductionBp: 9000, refundAmount: 3_334 });
    expect(writes.updates).toHaveLength(0);
  });

  test('견적이 입장 시작 뒤라고 하면 티켓이 REFUND_NOW여도 환급을 입장 기록 마감 뒤로 미룬다', async () => {
    const { svc, payments, writes } = saga({ ticket: 'REFUND_NOW' });
    const r = await svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: CANCEL, reason: 'USER', nowMs: kst('2026-11-20T18:30:00'), deadlineMs: 2000 });
    expect(r).toEqual({ status: 'ACCEPTED', cancellationId: CANCEL, refundAmount: 3_334, refundAfterEntryClose: true });
    expect(payments.calls).toHaveLength(0);
    // 입장 기록 마감의 보수적 상한 = 공연 시작 + 50시간
    expect(writes.created[0]).toMatchObject({ status: 'REQUESTED', refundAmount: 3_334, refundDueAtMs: kst('2026-11-22T21:00:00') });
  });

  test('REFUND_PENDING 재요청은 같은 취소 ID로 결제사를 다시 부르고 CANCELLED면 REFUNDED다', async () => {
    const { svc, payments, writes } = saga({
      replay: { status: 'REPLAYED', cancellationId: CANCEL, refundAmount: 30_000, state: 'REFUND_PENDING', refundAfterEntryClose: false, refundAttempts: 1 },
    });
    const r = await svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: CANCEL, reason: 'USER', nowMs: kst('2026-11-13T10:00:00'), deadlineMs: 2000 });
    expect(r).toEqual({ status: 'ACCEPTED', cancellationId: CANCEL, refundAmount: 30_000, refundAfterEntryClose: false });
    expect(payments.calls[0]).toMatchObject({ cancellationId: CANCEL, amount: 30_000 });
    expect(writes.updates.at(-1)).toEqual({ cancellationId: CANCEL, status: 'REFUNDED', nowMs: kst('2026-11-13T10:00:00') });
  });

  test('결제사가 거절하면 바로, 결과를 모르면 재시도 예약으로 환급 대기한다', async () => {
    for (const payment of ['UNKNOWN', 'PENDING'] as const) {
      const { svc, writes } = saga({ payment });
      const r = await svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: CANCEL, reason: 'USER', nowMs: kst('2026-11-13T10:00:00'), deadlineMs: 2000 });
      expect(r).toMatchObject({ status: 'REFUND_PENDING', refundAmount: 30_000, payment });
      expect(writes.retries[0]).toMatchObject({ cancellationId: CANCEL, attempts: 1, nextRetryAtMs: kst('2026-11-13T10:01:00'), lastError: payment });
      expect(writes.updates).toHaveLength(0);
    }
    const rejected = saga({ payment: 'REJECTED' });
    expect(await rejected.svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: CANCEL, reason: 'USER', nowMs: kst('2026-11-13T10:00:00'), deadlineMs: 2000 })).toMatchObject({ status: 'REFUND_PENDING', payment: 'REJECTED' });
    expect(rejected.writes.failures[0]).toMatchObject({ cancellationId: CANCEL, attempts: 1, lastError: 'REJECTED' });
    expect(rejected.writes.retries).toHaveLength(0);
  });

  test('같은 취소 ID의 재요청은 처음 결과를 그대로 돌려준다', async () => {
    const { svc, payments } = saga({
      replay: { status: 'REPLAYED', cancellationId: CANCEL, refundAmount: 30_000, state: 'REFUNDED', refundAfterEntryClose: false, refundAttempts: 0 },
    });
    const r = await svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: CANCEL, reason: 'USER', nowMs: kst('2026-11-13T10:00:00'), deadlineMs: 2000 });
    expect(r).toEqual({ status: 'REPLAYED', cancellationId: CANCEL, refundAmount: 30_000, refundAfterEntryClose: false });
    expect(payments.calls).toHaveLength(0);
  });

  test('CS가 무효로 끝낸 취소를 다시 요청하면 CONFLICT다', async () => {
    const { svc, payments } = saga({
      replay: { status: 'REPLAYED', cancellationId: CANCEL, refundAmount: 30_000, state: 'VOIDED', refundAfterEntryClose: false, refundAttempts: 0 },
    });
    expect(await svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: CANCEL, reason: 'USER', nowMs: kst('2026-11-13T10:00:00'), deadlineMs: 2000 })).toEqual({ status: 'CONFLICT' });
    expect(payments.calls).toHaveLength(0);
  });

  test('같은 티켓의 진행 중 취소가 있으면 CONFLICT다', async () => {
    const { svc } = saga({ replay: { status: 'CONFLICT' } });
    expect(await svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: CANCEL, reason: 'USER', nowMs: kst('2026-11-13T10:00:00'), deadlineMs: 2000 })).toEqual({ status: 'CONFLICT' });
  });
});
