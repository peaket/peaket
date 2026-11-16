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
  type TicketCancelAnswer,
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
  constructor(private readonly outcome: TicketCancelAnswer) {}
  async cancel(q: Parameters<TicketCancellations['cancel']>[0]): Promise<TicketCancelAnswer> {
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

const saga = (o: { order?: CancellationOrderView | undefined; ticket?: TicketCancelAnswer; payment?: PaymentCancelOutcome; replay?: CancellationWriteOutcome } = {}) => {
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

  test('회차 취소(EVENT_CANCELLED)는 입장 시작 뒤에도 바로 환급한다', async () => {
    const { svc, payments } = saga({ ticket: 'REFUND_AFTER_CLOSE' });
    const r = await svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: CANCEL, reason: 'EVENT_CANCELLED', nowMs: kst('2026-11-20T18:30:00'), deadlineMs: kst('2026-11-20T18:30:05') });
    expect(r).toMatchObject({ status: 'ACCEPTED', refundAfterEntryClose: false, refundAmount: 33_333 });
    expect(payments.calls).toHaveLength(1);
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

  test('GAT090_티켓이_REFUND_AFTER_CLOSE여도_견적이_입장_전이면_장_마감까지_미룬다', async () => {
    const { svc, payments, writes } = saga({ ticket: 'REFUND_AFTER_CLOSE' });
    const r = await svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: CANCEL, reason: 'USER', nowMs: kst('2026-11-13T10:00:00'), deadlineMs: 2000 });
    expect(r).toEqual({ status: 'ACCEPTED', cancellationId: CANCEL, refundAmount: 30_000, refundAfterEntryClose: true });
    expect(payments.calls).toHaveLength(0);
    expect(writes.created[0]).toMatchObject({ status: 'REQUESTED', deductionBp: 1000, refundAmount: 30_000, refundDueAtMs: EVENT + 50 * 60 * 60_000 });
    expect(writes.updates).toHaveLength(0);
  });

  test('POL-032_연기(EVENT_POSTPONED)는_입장_시작_뒤에도_공제_없이_바로_환급한다', async () => {
    const { svc, payments, writes } = saga({ ticket: 'REFUND_AFTER_CLOSE' });
    const r = await svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: CANCEL, reason: 'EVENT_POSTPONED', nowMs: kst('2026-11-20T18:30:00'), deadlineMs: 2000 });
    expect(r).toMatchObject({ status: 'ACCEPTED', refundAmount: 33_333, refundAfterEntryClose: false });
    expect(payments.calls[0]).toMatchObject({ amount: 33_333, reason: 'EVENT_POSTPONED' });
    expect(writes.created[0]).toMatchObject({ status: 'REFUND_PENDING', deductionBp: 0, deductionAmount: 0, refundAmount: 33_333 });
    expect(writes.updates).toEqual([{ cancellationId: CANCEL, status: 'REFUNDED', nowMs: kst('2026-11-20T18:30:00') }]);
  });

  test('GAT080_티켓이_REFUND_AFTER_CLOSE여도_공연_시작_뒤면_견적이_EVENT_STARTED로_먼저_거절한다', async () => {
    // 티켓의 after-close 근거가 공연 시작 거절을 덮어쓰면 안 된다(키 폐기·좌석 반환도 하지 않는다)
    const { svc, tickets, payments, writes, seats } = saga({ ticket: 'REFUND_AFTER_CLOSE' });
    expect(await svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: CANCEL, reason: 'USER', nowMs: EVENT, deadlineMs: 2000 })).toEqual({ status: 'EVENT_STARTED' });
    expect(tickets.calls).toHaveLength(0);
    expect(seats.calls).toHaveLength(0);
    expect(writes.created).toHaveLength(0);
    expect(payments.calls).toHaveLength(0);
  });

  test('GAT080_입장_뒤로_미룬_REQUESTED의_재요청은_결제사를_부르지_않고_처음_결과를_돌려준다', async () => {
    const existing: CancellationRecord = { cancellationId: CANCEL, orderId: ORDER, ticketId: TICKET, refundAmount: 30_000, state: 'REQUESTED', refundAttempts: 0 };
    const payments = new Payments('CANCELLED');
    const seats = new Seats();
    const svc = new CancelTicket({ orders: new Orders(order(), existing), calendar, tickets: new Tickets('REFUND_NOW'), payments, writes: new Writes(), seats });
    expect(await svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: CANCEL, reason: 'USER', nowMs: kst('2026-11-20T18:30:00'), deadlineMs: 2000 })).toEqual({
      status: 'REPLAYED',
      cancellationId: CANCEL,
      refundAmount: 30_000,
      refundAfterEntryClose: true,
    });
    expect(payments.calls).toHaveLength(0);
    expect(seats.calls).toHaveLength(0);
  });

  test('GAT080_입장_뒤로_미룬_취소도_좌석은_바로_돌려주고_상태는_REQUESTED로_남긴다', async () => {
    const { svc, payments, writes, seats } = saga({ ticket: 'REFUND_AFTER_CLOSE' });
    const r = await svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: CANCEL, reason: 'USER', nowMs: kst('2026-11-13T10:00:00'), deadlineMs: 2000 });
    expect(r).toMatchObject({ status: 'ACCEPTED', refundAfterEntryClose: true });
    // 좌석 재고는 환급을 미루는 동안에도 다시 팔 수 있게 돌려준다
    expect(seats.calls).toEqual([{ eventId: order().eventId, orderId: ORDER, seatId: order().seatId, accountId: ACCOUNT, saleEndsAtMs: SALE_ENDS }]);
    expect(writes.created[0]).toMatchObject({ status: 'REQUESTED' });
    expect(writes.updates).toHaveLength(0);
    expect(payments.calls).toHaveLength(0);
  });

  test('회차 취소(EVENT_CANCELLED)는_티켓이_REFUND_NOW여도_견적의_입장_뒤_판정을_무시하고_바로_환급한다', async () => {
    const { svc, payments, writes } = saga({ ticket: 'REFUND_NOW' });
    const r = await svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: CANCEL, reason: 'EVENT_CANCELLED', nowMs: kst('2026-11-20T18:30:00'), deadlineMs: kst('2026-11-20T18:30:05') });
    expect(r).toMatchObject({ status: 'ACCEPTED', refundAmount: 33_333, refundAfterEntryClose: false });
    expect(payments.calls).toHaveLength(1);
    expect(writes.created[0]).toMatchObject({ status: 'REFUND_PENDING', deductionBp: 0, refundAmount: 33_333 });
  });

  test('GAT-080 S1 ticket-svc가 ALREADY_CANCELLED(다른 취소가 먼저 끝냄)를 주면 좌석·취소 행·결제사를 건드리지 않고 ALREADY_ENDED다', async () => {
    const { svc, tickets, payments, writes, seats } = saga({ ticket: 'ALREADY_CANCELLED' });
    const r = await svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: CANCEL, reason: 'USER', nowMs: kst('2026-11-13T10:00:00'), deadlineMs: 2000 });
    expect(r).toEqual({ status: 'ALREADY_ENDED' });
    // ticket-svc까지는 갔다(그 답을 보고 멈춘다)
    expect(tickets.calls).toHaveLength(1);
    expect(seats.calls).toHaveLength(0);
    expect(writes.created).toHaveLength(0);
    expect(writes.updates).toHaveLength(0);
    expect(writes.retries).toHaveLength(0);
    expect(writes.failures).toHaveLength(0);
    expect(payments.calls).toHaveLength(0);
  });
});

// ---- BAT-415 리뷰 반영 B2(계획 §11 S2, docs/features/payment.md §4.1 '앞 시도가 티켓 단계만 마친 팬 취소 잇기') ----
describe('GAT-080 S2 앞 시도가 티켓 단계만 마친 팬 취소 잇기', () => {
  const K1 = '01900000-0000-4000-8000-0000000000a1';
  const K2 = '01900000-0000-4000-8000-0000000000a2';
  /** 공연(2026-11-20 19:00) 10일 전에 K1이 키를 폐기했다(공제 0%). K2는 9일 전에 누른다(그때 기준이면 10%) */
  const FIRST_AT = kst('2026-11-10T10:00:00');
  const K2_AT = kst('2026-11-11T10:00:00');
  const first = (result: 'REFUND_NOW' | 'REFUND_AFTER_CLOSE' = 'REFUND_NOW'): TicketCancelAnswer => ({ result: 'ALREADY_CANCELLED', firstCancellationId: K1, firstResult: result, firstCancelledAtMs: FIRST_AT });
  /** 취소 ID로 기록을 찾는 주문 가짜(K1의 기록만 있을 수 있다) */
  class OrdersById {
    constructor(private readonly byId: Map<string, CancellationRecord> = new Map()) {}
    async findByTicket(): Promise<CancellationOrderView | undefined> {
      return order();
    }
    async findCancellation(id: string): Promise<CancellationRecord | undefined> {
      return this.byId.get(id);
    }
  }
  const run = (answer: TicketCancelAnswer, existing?: CancellationRecord, payment: PaymentCancelOutcome = 'CANCELLED') => {
    const tickets = new Tickets(answer);
    const payments = new Payments(payment);
    const writes = new Writes();
    const seats = new Seats();
    const svc = new CancelTicket({ orders: new OrdersById(existing ? new Map([[existing.cancellationId, existing]]) : new Map()), calendar, tickets, payments, writes, seats });
    return { svc, tickets, payments, writes, seats };
  };

  test('GAT-080 S2 첫 팬 취소가 티켓 단계만 마친 뒤 새 키로 다시 누르면 첫 취소 ID로 좌석·취소 행·환급을 마친다(공제 기준은 첫 키 폐기 시각)', async () => {
    const f = run(first());
    const r = await f.svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: K2, reason: 'USER', nowMs: K2_AT, deadlineMs: 2000 });
    expect(r).toEqual({ status: 'ACCEPTED', cancellationId: K1, refundAmount: 33_333, refundAfterEntryClose: false });
    expect(f.seats.calls).toEqual([{ eventId: order().eventId, orderId: ORDER, seatId: order().seatId, accountId: ACCOUNT, saleEndsAtMs: SALE_ENDS }]);
    expect(f.writes.created).toHaveLength(1);
    expect(f.writes.created[0]).toMatchObject({ cancellationId: K1, orderId: ORDER, ticketId: TICKET, reason: 'USER', daysBefore: 10, deductionBp: 0, deductionAmount: 0, refundAmount: 33_333, status: 'REFUND_PENDING' });
    expect(f.payments.calls).toHaveLength(1);
    expect(f.payments.calls[0]).toMatchObject({ cancellationId: K1, orderId: ORDER, amount: 33_333 });
    expect(f.writes.updates).toEqual([{ cancellationId: K1, status: 'REFUNDED', nowMs: K2_AT }]);
  });

  test('GAT-080 S2 첫 결과가 REFUND_AFTER_CLOSE면 K1로 취소 행을 REQUESTED로 남기고 결제사를 부르지 않는다', async () => {
    const f = run(first('REFUND_AFTER_CLOSE'));
    const r = await f.svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: K2, reason: 'USER', nowMs: K2_AT, deadlineMs: 2000 });
    expect(r).toMatchObject({ status: 'ACCEPTED', cancellationId: K1, refundAfterEntryClose: true });
    expect(f.writes.created[0]).toMatchObject({ cancellationId: K1, status: 'REQUESTED' });
    expect(f.payments.calls).toHaveLength(0);
  });

  test('GAT-080 S2 K1의 order_cancellation이 이미 있으면 그 결과를 다시 주고 결제사는 REFUND_PENDING일 때만 K1으로 다시 부른다', async () => {
    const done: CancellationRecord = { cancellationId: K1, orderId: ORDER, ticketId: TICKET, refundAmount: 33_333, state: 'REFUNDED', refundAttempts: 0 };
    const a = run(first(), done);
    expect(await a.svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: K2, reason: 'USER', nowMs: K2_AT, deadlineMs: 2000 })).toEqual({
      status: 'REPLAYED',
      cancellationId: K1,
      refundAmount: 33_333,
      refundAfterEntryClose: false,
    });
    expect(a.payments.calls).toHaveLength(0);
    expect(a.seats.calls).toHaveLength(0);
    expect(a.writes.created).toHaveLength(0);

    const pending: CancellationRecord = { ...done, state: 'REFUND_PENDING', refundAttempts: 1 };
    const b = run(first(), pending);
    expect(await b.svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: K2, reason: 'USER', nowMs: K2_AT, deadlineMs: 2000 })).toMatchObject({ status: 'ACCEPTED', cancellationId: K1 });
    expect(b.payments.calls).toHaveLength(1);
    expect(b.payments.calls[0]).toMatchObject({ cancellationId: K1, amount: 33_333 });
    expect(b.seats.calls).toHaveLength(0);
    expect(b.writes.created).toHaveLength(0);
  });

  test('GAT-080 S2 운영자 취소·무효로 끝난 표(첫 칸 없는 ALREADY_CANCELLED)는 새 키로 눌러도 아무것도 쓰지 않는다', async () => {
    const f = run('ALREADY_CANCELLED');
    expect(await f.svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: K2, reason: 'USER', nowMs: K2_AT, deadlineMs: 2000 })).toEqual({ status: 'ALREADY_ENDED' });
    expect(f.seats.calls).toHaveLength(0);
    expect(f.writes.created).toHaveLength(0);
    expect(f.payments.calls).toHaveLength(0);
  });
});

// ---- BAT-415 리뷰 반영 B2 보충(계획 §11 보충, 2ab218ad, docs/features/payment.md §4.1 '공연이 시작된 뒤 다시 누른 경우') ----
describe('GAT-080 S4 공연 시작 뒤 다시 누른 팬 취소', () => {
  const K1 = '01900000-0000-4000-8000-0000000000b1';
  const K2 = '01900000-0000-4000-8000-0000000000b2';
  /** 공연 2026-11-20 19:00 시작 1분 뒤에 다시 누른다. 첫 키 폐기는 공연 4일 전(공제 20%) */
  const AFTER_START = kst('2026-11-20T19:01:00');
  const FIRST_AT = kst('2026-11-16T10:00:00');
  const make = (answer: TicketCancelAnswer) => {
    const tickets = new Tickets(answer);
    const payments = new Payments('CANCELLED');
    const writes = new Writes();
    const seats = new Seats();
    const svc = new CancelTicket({ orders: new Orders(order()), calendar, tickets, payments, writes, seats });
    return { svc, tickets, payments, writes, seats };
  };

  test('GAT-080 S4 공연 전에 키만 폐기된 팬 취소는 공연 시작 뒤 다시 눌러도 replayOnly 확인으로 첫 취소를 받아 첫 시각의 공제율로 환급을 마친다', async () => {
    const f = make({ result: 'ALREADY_CANCELLED', firstCancellationId: K1, firstResult: 'REFUND_NOW', firstCancelledAtMs: FIRST_AT });
    const r = await f.svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: K2, reason: 'USER', nowMs: AFTER_START, deadlineMs: 2000 });
    expect(r).toEqual({ status: 'ACCEPTED', cancellationId: K1, refundAmount: 26_667, refundAfterEntryClose: false });
    expect(f.tickets.calls).toHaveLength(1);
    expect(f.tickets.calls[0]).toMatchObject({ orderId: ORDER, ticketIds: [TICKET], requestedByAccountId: ACCOUNT, cancellationId: K2, replayOnly: true });
    expect(f.seats.calls).toHaveLength(1);
    expect(f.writes.created).toHaveLength(1);
    expect(f.writes.created[0]).toMatchObject({ cancellationId: K1, daysBefore: 4, deductionBp: 2_000, deductionAmount: 6_666, refundAmount: 26_667, status: 'REFUND_PENDING' });
    expect(f.payments.calls).toEqual([expect.objectContaining({ cancellationId: K1, amount: 26_667 })]);
  });

  test.each<[string, TicketCancelAnswer]>([
    ['아직 유효한 표(확인 답 EVENT_STARTED)', 'EVENT_STARTED'],
    ['첫 칸 없는 ALREADY_CANCELLED(운영자 취소·무효)', 'ALREADY_CANCELLED'],
    ['남이 보유', 'NOT_PAYER_HOLDER'],
  ])('GAT-080 S4 공연 시작 뒤 %s는 replayOnly로 확인만 하고 EVENT_STARTED이며 아무것도 쓰지 않는다', async (_name, answer) => {
    const f = make(answer);
    expect(await f.svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: K2, reason: 'USER', nowMs: AFTER_START, deadlineMs: 2000 })).toEqual({ status: 'EVENT_STARTED' });
    expect(f.tickets.calls).toHaveLength(1);
    expect(f.tickets.calls[0]!.replayOnly).toBe(true);
    expect(f.seats.calls).toHaveLength(0);
    expect(f.writes.created).toHaveLength(0);
    expect(f.payments.calls).toHaveLength(0);
  });

  test('GAT-080 S4 첫 키 폐기 시각도 공연 시작 뒤면 EVENT_STARTED이고 아무것도 쓰지 않는다', async () => {
    const f = make({ result: 'ALREADY_CANCELLED', firstCancellationId: K1, firstResult: 'REFUND_AFTER_CLOSE', firstCancelledAtMs: kst('2026-11-20T19:00:30') });
    expect(await f.svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: K2, reason: 'USER', nowMs: AFTER_START, deadlineMs: 2000 })).toEqual({ status: 'EVENT_STARTED' });
    expect(f.writes.created).toHaveLength(0);
    expect(f.payments.calls).toHaveLength(0);
  });

  test('GAT-080 S4 공연 시작 전의 취소는 확인 호출이 아니다(replayOnly를 싣지 않는다)', async () => {
    const f = make('REFUND_NOW');
    await f.svc.execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: K2, reason: 'USER', nowMs: FIRST_AT, deadlineMs: 2000 });
    expect(f.tickets.calls[0]!.replayOnly ?? false).toBe(false);
  });
});
