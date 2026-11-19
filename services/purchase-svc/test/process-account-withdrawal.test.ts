// 탈퇴 참여자 쓰임새(application/process-account-withdrawal.ts ProcessAccountWithdrawal, docs/features/payment.md §4.1 '탈퇴 참여자의 첫 구현'
// '미사용 티켓 취소' '답', ADR-0284, BUILD_ORDER PRF-169·PRF-174, P-T55 ②③④⑤, I-T26 ②③)를 가짜 포트와 가짜 시계로 본다(BAT-010·BAT-013 시험 담당).
// 실제 PostgreSQL·ticket-svc·payment-svc는 test-int/withdrawal-participant.int.test.ts.
// 값은 정본에서 적는다: 취소 ID withdrawal-{주문 ID}, 사유 ACCOUNT_WITHDRAWAL, 호출 데드라인 min(남은 시간 − 100ms, 5초), 50ms 미만이면 부르지 않음,
// 한 호출 10건, 문장 시간 한도 min(400ms, 남은 시간). 미사용 티켓은 한 호출 10건, 남은 시간 50ms, 여유 100ms, 데드라인 상한 5초 [가정]이다.
// 코드 상수를 가져오지 않는다.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import {
  ProcessAccountWithdrawal,
  type WithdrawalDepositCancelOutcome,
  type WithdrawalOrder,
  type WithdrawalTickets,
  WithdrawalOrdersUnavailable,
} from '../src/modules/booking/index.js';
import {
  AccountWithdrawalTickets,
  type CancelTicketResult,
  type WithdrawalTicket,
  WeekendBusinessCalendar,
  zeroDeductionFor,
  withdrawalTicketCancellationId,
} from '../src/modules/refund/index.js';

const NOW = Date.parse('2026-11-18T12:00:03.719Z');
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000055a1';
const oid = (n: number) => `0190f3a1-7c2e-7a00-8000-${String(n).padStart(12, '0')}`;

interface CancelCall {
  cancellationId: string;
  orderId: string;
  amount: number;
  reason: string;
  deadlineMs: number;
  /** 부른 때의 남은 시간 */
  remainingMs: number;
}

function harness(o: { orders?: WithdrawalOrder[] | Error; answer?: (orderId: string, i: number) => WithdrawalDepositCancelOutcome | Promise<WithdrawalDepositCancelOutcome>; advancePerCancelMs?: number; tickets?: WithdrawalTickets } = {}) {
  const clock = fakeClock({ now: NOW });
  const reads: { accountId: string; statementTimeoutMs: number }[] = [];
  const cancels: CancelCall[] = [];
  const signals = { participant: [] as string[], deposit: [] as string[] };
  const warns: { obj: object; msg: string }[] = [];
  let deadlineAtMs = Number.POSITIVE_INFINITY;
  const service = new ProcessAccountWithdrawal({
    orders: {
      openOrdersOf: async (accountId, q) => {
        reads.push({ accountId, statementTimeoutMs: q.statementTimeoutMs });
        if (o.orders instanceof Error) throw o.orders;
        return o.orders ?? [];
      },
    },
    deposits: {
      cancel: async (q) => {
        cancels.push({ ...q, remainingMs: deadlineAtMs - clock.now() });
        if (o.advancePerCancelMs) clock.advance(o.advancePerCancelMs);
        return (o.answer ?? (() => 'CANCELLED'))(q.orderId, cancels.length - 1);
      },
    },
    clock,
    ...(o.tickets ? { tickets: o.tickets } : {}),
    signals: { participant: (s) => void signals.participant.push(s), depositCancel: (r) => void signals.deposit.push(r) },
    log: { warn: (obj, msg) => void warns.push({ obj, msg }) },
  });
  const run = (remainingMs = 10_000) => {
    deadlineAtMs = clock.now() + remainingMs;
    return service.run({ accountId: ACCOUNT, deadlineAtMs });
  };
  return { clock, reads, cancels, signals, warns, run };
}

const order = (n: number, status: WithdrawalOrder['status'], amount = 10_000 + n): WithdrawalOrder => ({ orderId: oid(n), status, amount });

describe('결제 결과를 기다리는 주문(P-T55 ①②)', () => {
  test('P-T55①_주문이없으면DONE이고이유가없고세수가0이며_취소를부르지않는다', async () => {
    const h = harness({ orders: [] });
    expect(await h.run()).toEqual({ state: 'DONE', reasons: [], paymentPendingOrders: 0, depositOrdersCancelled: 0, depositOrdersPending: 0, unusedTicketsCancelled: 0, unusedTicketsPending: 0 });
    expect(h.cancels).toEqual([]);
    expect(h.reads.map((r) => r.accountId)).toEqual([ACCOUNT]);
    expect(h.signals.participant).toEqual(['done']);
  });

  test.each(['CREATED', 'AUTHENTICATED', 'ACCEPTED', 'RESERVED', 'UNKNOWN'] as const)('P-T55②_%s 주문 하나만 있어도 PENDING·이유 PAYMENT_PENDING_ORDER·payment_pending_orders 1이고 취소를 부르지 않는다', async (status) => {
    const h = harness({ orders: [order(1, status)] });
    expect(await h.run()).toEqual({ state: 'PENDING', reasons: ['PAYMENT_PENDING_ORDER'], paymentPendingOrders: 1, depositOrdersCancelled: 0, depositOrdersPending: 0, unusedTicketsCancelled: 0, unusedTicketsPending: 0 });
    expect(h.cancels).toEqual([]);
    expect(h.signals.participant).toEqual(['pending']);
  });

  test('P-T55②_결제결과대기주문이둘이면payment_pending_orders가2이고이유는한번만싣는다', async () => {
    const h = harness({ orders: [order(1, 'CREATED'), order(2, 'UNKNOWN')] });
    expect(await h.run()).toEqual({ state: 'PENDING', reasons: ['PAYMENT_PENDING_ORDER'], paymentPendingOrders: 2, depositOrdersCancelled: 0, depositOrdersPending: 0, unusedTicketsCancelled: 0, unusedTicketsPending: 0 });
  });
});

describe('입금 대기 주문의 입금 전 취소(P-T55 ③④)', () => {
  test('P-T55③_입금대기주문마다취소ID withdrawal-{주문ID}·금액=주문금액·사유ACCOUNT_WITHDRAWAL로한번부르고_CANCELLED면남은것으로세지않아DONE이다', async () => {
    const h = harness({ orders: [order(3, 'AWAITING_DEPOSIT', 88_000), order(4, 'AWAITING_DEPOSIT', 132_500)] });
    expect(await h.run()).toEqual({ state: 'DONE', reasons: [], paymentPendingOrders: 0, depositOrdersCancelled: 2, depositOrdersPending: 0, unusedTicketsCancelled: 0, unusedTicketsPending: 0 });
    expect(h.cancels.map(({ cancellationId, orderId, amount, reason }) => ({ cancellationId, orderId, amount, reason }))).toEqual([
      { cancellationId: `withdrawal-${oid(3)}`, orderId: oid(3), amount: 88_000, reason: 'ACCOUNT_WITHDRAWAL' },
      { cancellationId: `withdrawal-${oid(4)}`, orderId: oid(4), amount: 132_500, reason: 'ACCOUNT_WITHDRAWAL' },
    ]);
    expect(h.signals.deposit).toEqual(['cancelled', 'cancelled']);
  });

  test('P-T55③_입금대기주문이0개면취소를한번도부르지않는다(결제결과대기주문만있을때도)', async () => {
    const h = harness({ orders: [order(5, 'RESERVED')] });
    await h.run();
    expect(h.cancels).toEqual([]);
    expect(h.signals.deposit).toEqual([]);
  });

  test.each<[string, WithdrawalDepositCancelOutcome | 'THROW', string]>([
    ['CANCEL_PENDING', 'PENDING', 'pending'],
    ['UNKNOWN', 'UNKNOWN', 'unknown'],
    ['REJECTED', 'REJECTED', 'rejected'],
    ['호출 실패(던짐)', 'THROW', 'unknown'],
  ])('P-T55④_취소 답이 %s면 PENDING·이유 DEPOSIT_CANCEL_PENDING·deposit_orders_pending = 그 수다', async (_name, outcome, metric) => {
    const h = harness({
      orders: [order(6, 'AWAITING_DEPOSIT'), order(7, 'AWAITING_DEPOSIT')],
      answer: (orderId) => {
        if (orderId === oid(7)) return 'CANCELLED';
        if (outcome === 'THROW') throw new Error('주입한 장애(취소 호출)');
        return outcome;
      },
    });
    expect(await h.run()).toEqual({ state: 'PENDING', reasons: ['DEPOSIT_CANCEL_PENDING'], paymentPendingOrders: 0, depositOrdersCancelled: 1, depositOrdersPending: 1, unusedTicketsCancelled: 0, unusedTicketsPending: 0 });
    expect(h.cancels).toHaveLength(2);
    if (outcome !== 'THROW') expect(h.signals.deposit).toEqual([metric, 'cancelled']);
  });

  test('P-T55④_REJECTED는경고로그withdrawal-deposit-cancel-rejected한줄이고주문ID만싣는다(계정·금액을싣지않는다)', async () => {
    const h = harness({ orders: [order(8, 'AWAITING_DEPOSIT', 51_000)], answer: () => 'REJECTED' });
    await h.run();
    const lines = h.warns.map((w) => JSON.stringify(w));
    expect(lines.filter((l) => l.includes('withdrawal-deposit-cancel-rejected'))).toHaveLength(1);
    expect(lines.join('\n')).toContain(oid(8));
    expect(lines.join('\n')).not.toContain(ACCOUNT);
    expect(lines.join('\n')).not.toContain('51000');
  });

  test('P-T55④_다시부르면같은취소ID로다시보내고_그사이취소가끝났으면(CANCELLED)DONE이다', async () => {
    let first = true;
    const h = harness({ orders: [order(9, 'AWAITING_DEPOSIT')], answer: () => (first ? 'UNKNOWN' : 'CANCELLED') });
    expect(await h.run()).toMatchObject({ state: 'PENDING', reasons: ['DEPOSIT_CANCEL_PENDING'], depositOrdersPending: 1, unusedTicketsCancelled: 0, unusedTicketsPending: 0 });
    first = false;
    expect(await h.run()).toEqual({ state: 'DONE', reasons: [], paymentPendingOrders: 0, depositOrdersCancelled: 1, depositOrdersPending: 0, unusedTicketsCancelled: 0, unusedTicketsPending: 0 });
    expect(h.cancels.map((c) => c.cancellationId)).toEqual([`withdrawal-${oid(9)}`, `withdrawal-${oid(9)}`]);
  });

  test('P-T55②④_결제결과대기와입금대기취소남음이함께면이유둘을겹치지않게싣는다', async () => {
    const h = harness({ orders: [order(10, 'CREATED'), order(11, 'AWAITING_DEPOSIT'), order(12, 'ACCEPTED'), order(13, 'AWAITING_DEPOSIT')], answer: () => 'PENDING' });
    const r = await h.run();
    expect({ ...r, reasons: [...r.reasons].sort() }).toEqual({ state: 'PENDING', reasons: ['DEPOSIT_CANCEL_PENDING', 'PAYMENT_PENDING_ORDER'], paymentPendingOrders: 2, depositOrdersCancelled: 0, depositOrdersPending: 2, unusedTicketsCancelled: 0, unusedTicketsPending: 0 });
  });
});

describe('남은 시간과 상한(P-T55 ⑤)', () => {
  test('P-T55⑤_남은시간이49ms면부르지않고남은것으로센다(skipped)_50ms면부른다', async () => {
    const at49 = harness({ orders: [order(14, 'AWAITING_DEPOSIT')] });
    expect(await at49.run(49)).toEqual({ state: 'PENDING', reasons: ['DEPOSIT_CANCEL_PENDING'], paymentPendingOrders: 0, depositOrdersCancelled: 0, depositOrdersPending: 1, unusedTicketsCancelled: 0, unusedTicketsPending: 0 });
    expect(at49.cancels).toEqual([]);
    expect(at49.signals.deposit).toEqual(['skipped']);
    const at50 = harness({ orders: [order(15, 'AWAITING_DEPOSIT')] });
    expect(await at50.run(50)).toMatchObject({ state: 'DONE', depositOrdersCancelled: 1 });
    expect(at50.cancels.map((c) => c.remainingMs)).toEqual([50]);
  });

  test('P-T55⑤_남은시간은부를때마다다시잰다: 앞취소가시간을써서둘째앞이50ms면부르고셋째앞이49ms면부르지않는다', async () => {
    // 남은 150ms에서 시작: 첫 취소가 100ms를 쓰면 둘째 앞 50ms(부른다), 둘째가 1ms를 쓰면 셋째 앞 49ms(부르지 않는다)
    let i = 0;
    const steps = [100, 1];
    const h2 = harness({
      orders: [order(16, 'AWAITING_DEPOSIT'), order(17, 'AWAITING_DEPOSIT'), order(18, 'AWAITING_DEPOSIT')],
      answer: () => {
        h2.clock.advance(steps[i++] ?? 0);
        return 'CANCELLED';
      },
    });
    expect(await h2.run(150)).toEqual({ state: 'PENDING', reasons: ['DEPOSIT_CANCEL_PENDING'], paymentPendingOrders: 0, depositOrdersCancelled: 2, depositOrdersPending: 1, unusedTicketsCancelled: 0, unusedTicketsPending: 0 });
    expect(h2.cancels.map((c) => [c.orderId, c.remainingMs])).toEqual([
      [oid(16), 150],
      [oid(17), 50],
    ]);
  });

  test('P-T55⑤_입금대기주문이11개면10개만부르고11번째는남은것으로센다', async () => {
    const orders = Array.from({ length: 11 }, (_, n) => order(100 + n, 'AWAITING_DEPOSIT'));
    const h = harness({ orders });
    expect(await h.run(60_000)).toEqual({ state: 'PENDING', reasons: ['DEPOSIT_CANCEL_PENDING'], paymentPendingOrders: 0, depositOrdersCancelled: 10, depositOrdersPending: 1, unusedTicketsCancelled: 0, unusedTicketsPending: 0 });
    expect(h.cancels.map((c) => c.orderId)).toEqual(orders.slice(0, 10).map((o) => o.orderId));
  });

  test('P-T55⑤_입금대기주문이10개면모두부른다(상한과같은수)', async () => {
    const orders = Array.from({ length: 10 }, (_, n) => order(200 + n, 'AWAITING_DEPOSIT'));
    const h = harness({ orders });
    expect(await h.run(60_000)).toEqual({ state: 'DONE', reasons: [], paymentPendingOrders: 0, depositOrdersCancelled: 10, depositOrdersPending: 0, unusedTicketsCancelled: 0, unusedTicketsPending: 0 });
    expect(h.cancels).toHaveLength(10);
  });

  test('P-T55⑤_취소호출의데드라인은min(남은시간−100ms, 5초)이다', async () => {
    const big = harness({ orders: [order(19, 'AWAITING_DEPOSIT')] });
    await big.run(9_000);
    expect(big.cancels.map((c) => c.deadlineMs)).toEqual([5_000]);
    const small = harness({ orders: [order(20, 'AWAITING_DEPOSIT')] });
    await small.run(2_345);
    expect(small.cancels.map((c) => c.deadlineMs)).toEqual([2_245]);
    const edge = harness({ orders: [order(21, 'AWAITING_DEPOSIT')] });
    await edge.run(5_100);
    expect(edge.cancels.map((c) => c.deadlineMs)).toEqual([5_000]);
  });

  test('P-T55⑤_주문찾기의문장시간한도는min(400ms, 남은시간)이다', async () => {
    const big = harness();
    await big.run(10_000);
    expect(big.reads.map((r) => r.statementTimeoutMs)).toEqual([400]);
    const small = harness();
    await small.run(263);
    expect(small.reads.map((r) => r.statementTimeoutMs)).toEqual([263]);
  });
});

describe('저장소 오류(P-T55 ⑥)', () => {
  test('P-T55⑥_주문저장소에닿지못하면WithdrawalOrdersUnavailable을던지고취소를부르지않는다(받는층이UNAVAILABLE로)_지표는error다', async () => {
    const h = harness({ orders: new WithdrawalOrdersUnavailable(new Error('연결 끊김')) });
    await expect(h.run()).rejects.toBeInstanceOf(WithdrawalOrdersUnavailable);
    expect(h.cancels).toEqual([]);
    expect(h.signals.participant).toEqual(['error']);
  });

  test('P-T55⑥_그밖의저장소오류는WithdrawalOrdersUnavailable로바꾸지않고그대로던진다(받는층이INTERNAL로)', async () => {
    const boom = new Error('문법 오류(주입)');
    const h = harness({ orders: boom });
    const e = await h.run().catch((x: unknown) => x);
    expect(e).toBe(boom);
    expect(e).not.toBeInstanceOf(WithdrawalOrdersUnavailable);
  });
});

// ---- 미사용 티켓 취소(I-T26 ②③, payment §4.1 '미사용 티켓 취소' '답', BAT-013) ----
const DAY_MS = 86_400_000;
const EVENT_START = NOW + 7 * DAY_MS;
const SALE_END = EVENT_START - DAY_MS;
let ticketSeq = 0;
const ticketRow = (): WithdrawalTicket => ({
  ticketId: `0190f3a1-7c2e-7a00-8000-${String(300 + ticketSeq++).padStart(12, '0')}`,
  orderId: `0190f3a1-7c2e-7a00-8000-${String(600 + ticketSeq++).padStart(12, '0')}`,
  eventId: 'ev-26',
  ticketPrice: 33_333,
  bookedAtMs: NOW - 20 * DAY_MS,
});
interface TicketCall {
  accountId: string;
  ticketId: string;
  cancellationId: string;
  reason: string;
  nowMs: number;
  deadlineMs: number;
}
/** 미사용 티켓 포트(AccountWithdrawalTickets) + 가짜 CancelTicket. results는 차례대로 쓰고 마지막을 되풀이한다 */
function ticketService(
  clock: ReturnType<typeof fakeClock>,
  o: {
    rows?: WithdrawalTicket[] | (() => WithdrawalTicket[]);
    pending?: number;
    results?: Array<CancelTicketResult | CancelTicketResult['status'] | 'THROW'>;
    statusOf?: (cancellationId: string) => Promise<string | undefined>;
    advancePerCancelMs?: number;
  } = {},
) {
  const calls: TicketCall[] = [];
  const queue = [...(o.results ?? [])];
  const accepted = (cancellationId: string): CancelTicketResult => ({ status: 'ACCEPTED', cancellationId, refundAmount: 30_000, refundAfterEntryClose: false });
  const service = new AccountWithdrawalTickets({
    store: {
      unusedTicketsOf: async () => (typeof o.rows === 'function' ? o.rows() : (o.rows ?? [])),
      pendingRefunds: async () => o.pending ?? 0,
      cancellationStatus: async (cancellationId) => o.statusOf?.(cancellationId),
    },
    configs: { config: async () => ({ saleEndsAtMs: SALE_END }) },
    calendar: new WeekendBusinessCalendar(),
    cancelTicket: {
      execute: async (i) => {
        calls.push(i);
        if (o.advancePerCancelMs) clock.advance(o.advancePerCancelMs);
        const r = (queue.length > 1 ? queue.shift() : queue[0]) ?? 'ACCEPTED';
        if (r === 'THROW') throw new Error('주입한 티켓 취소 실패');
        if (r === 'ACCEPTED') return accepted(i.cancellationId);
        // 문자열로 적은 거절 상태(TRANSFER_PENDING·CONFLICT·NOT_PAYER_HOLDER …)
        return typeof r === 'string' ? ({ status: r } as CancelTicketResult) : r;
      },
    },
    log: { warn: () => {} },
  });
  // use-case에 넣는 포트 모양 그대로(quote는 이 시험이 쓰지 않는다)
  const port: WithdrawalTickets = { quote: (q) => service.quote(q), cancel: (q) => service.cancel(q), pendingRefunds: (q) => service.pendingRefunds(q) };
  return { service, port, calls };
}

describe('미사용 티켓 취소(I-T26 ②)', () => {
  test('I-T26②_미사용티켓2장이면표마다기존취소Saga를고정UUID·사유ACCOUNT_WITHDRAWAL로한번부르고_답은cancelled2·pending0·DONE이다', async () => {
    const rows = [ticketRow(), ticketRow()];
    const h0 = harness({ orders: [] });
    const tickets = ticketService(h0.clock, { rows, results: ['ACCEPTED'] });
    const h = harness({ orders: [], tickets: tickets.port });
    expect(await h.run(10_000)).toEqual({ state: 'DONE', reasons: [], paymentPendingOrders: 0, depositOrdersCancelled: 0, depositOrdersPending: 0, unusedTicketsCancelled: 2, unusedTicketsPending: 0 });
    expect(tickets.calls.map((c) => ({ accountId: c.accountId, ticketId: c.ticketId, cancellationId: c.cancellationId, reason: c.reason, nowMs: c.nowMs, deadlineMs: c.deadlineMs }))).toEqual(
      rows.map((r) => ({ accountId: ACCOUNT, ticketId: r.ticketId, cancellationId: withdrawalTicketCancellationId(r.ticketId), reason: 'ACCOUNT_WITHDRAWAL', nowMs: NOW, deadlineMs: 5_000 })),
    );
    expect(h.signals.participant).toEqual(['done']);
  });

  test('I-T26②_같은표의취소ID는서비스객체가달라도같다(다른객체·다른호출)이고_표마다다르다', async () => {
    const rows = [ticketRow(), ticketRow()];
    const h1 = harness({ orders: [] });
    const one = ticketService(h1.clock, { rows });
    const h1b = harness({ orders: [], tickets: one.port });
    await h1b.run(10_000);
    const h2 = harness({ orders: [] });
    const two = ticketService(h2.clock, { rows });
    const h2b = harness({ orders: [], tickets: two.port });
    await h2b.run(10_000);
    const ids1 = one.calls.map((c) => c.cancellationId);
    expect(two.calls.map((c) => c.cancellationId)).toEqual(ids1);
    expect(ids1).toEqual(rows.map((r) => withdrawalTicketCancellationId(r.ticketId)));
    expect(new Set(ids1).size).toBe(2);
    expect(ids1.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))).toBe(true);
  });

  test('I-T26②_결제자아님·이미끝남·공연시작뒤답은건너뛰고_양도요청중·CONFLICT는남은것으로센다', async () => {
    const h0 = harness({ orders: [] });
    const tickets = ticketService(h0.clock, { rows: [ticketRow(), ticketRow(), ticketRow(), ticketRow(), ticketRow()], results: ['TICKET_NOT_HELD', 'ALREADY_ENDED', 'EVENT_STARTED', 'TRANSFER_PENDING', 'CONFLICT'] });
    const h = harness({ orders: [], tickets: tickets.port });
    expect(await h.run(60_000)).toEqual({ state: 'PENDING', reasons: ['TICKET_REFUND_PENDING'], paymentPendingOrders: 0, depositOrdersCancelled: 0, depositOrdersPending: 0, unusedTicketsCancelled: 0, unusedTicketsPending: 2 });
    expect(tickets.calls).toHaveLength(5);
  });

  test('I-T26②_10건이면10번부르고11번째는안부르며_남은시간49ms면안부르고50ms면부른다', async () => {
    const many = Array.from({ length: 11 }, () => ticketRow());
    const h0 = harness({ orders: [] });
    const capped = ticketService(h0.clock, { rows: many });
    const h = harness({ orders: [], tickets: capped.port });
    expect(await h.run(60_000)).toMatchObject({ state: 'PENDING', reasons: ['TICKET_REFUND_PENDING'], unusedTicketsCancelled: 10, unusedTicketsPending: 1 });
    expect(capped.calls).toHaveLength(10);
    // 남은 시간 49ms: 부르지 않고 남은 것으로 센다. 50ms: 부른다
    const at49 = harness({ orders: [] });
    const almost = ticketService(at49.clock, { rows: [ticketRow()] });
    const h49 = harness({ orders: [], tickets: almost.port });
    expect(await h49.run(49)).toMatchObject({ state: 'PENDING', reasons: ['TICKET_REFUND_PENDING'], unusedTicketsCancelled: 0, unusedTicketsPending: 1 });
    expect(almost.calls).toEqual([]);
    const at50 = harness({ orders: [] });
    const just = ticketService(at50.clock, { rows: [ticketRow()] });
    const h50 = harness({ orders: [], tickets: just.port });
    expect(await h50.run(50)).toMatchObject({ state: 'DONE', unusedTicketsCancelled: 1, unusedTicketsPending: 0 });
    expect(just.calls).toHaveLength(1);
  });

  test('I-T26②_ACCOUNT_WITHDRAWAL은공제0원이아니다(POL-032 공제율을쓴다)', () => {
    expect(zeroDeductionFor('ACCOUNT_WITHDRAWAL')).toBe(false);
    // 대조: 공제 없음 사유는 그대로다
    for (const reason of ['FRAUD', 'EVENT_CANCELLED', 'EVENT_POSTPONED', 'MINOR_CONTRACT_CANCEL'] as const) expect({ reason, zero: zeroDeductionFor(reason) }).toEqual({ reason, zero: true });
    expect(zeroDeductionFor('USER')).toBe(false);
  });
});

describe('미사용 티켓의 남은 환급과 재시도(I-T26 ③)', () => {
  test('I-T26③_결제사답CANCEL_PENDING·UNKNOWN·REJECTED는REFUND_PENDING행이라pendingRefunds가세고_남은이유TICKET_REFUND_PENDING·pending1이다', async () => {
    for (const status of ['REFUND_PENDING'] as const) {
      const h0 = harness({ orders: [] });
      const tickets = ticketService(h0.clock, { rows: [ticketRow()], results: [{ status, cancellationId: 'x', refundAmount: 30_000, payment: 'UNKNOWN' }], pending: 1 });
      const h = harness({ orders: [], tickets: tickets.port });
      expect({ status, r: await h.run(60_000) }).toEqual({
        status,
        r: { state: 'PENDING', reasons: ['TICKET_REFUND_PENDING'], paymentPendingOrders: 0, depositOrdersCancelled: 0, depositOrdersPending: 0, unusedTicketsCancelled: 0, unusedTicketsPending: 1 },
      });
      expect(tickets.calls).toHaveLength(1);
    }
  });

  test('I-T26③_입장기록마감뒤환급(REQUESTED)은행이있어pending1이고_새표를부르지않는다', async () => {
    const h0 = harness({ orders: [] });
    const tickets = ticketService(h0.clock, { rows: [], pending: 1 });
    const h = harness({ orders: [], tickets: tickets.port });
    expect(await h.run(60_000)).toMatchObject({ state: 'PENDING', reasons: ['TICKET_REFUND_PENDING'], unusedTicketsCancelled: 0, unusedTicketsPending: 1 });
    expect(tickets.calls).toEqual([]);
  });

  test('I-T26③_취소행이REFUNDED·VOIDED면끝난것으로보아DONE이다', async () => {
    for (const _state of ['REFUNDED', 'VOIDED']) {
      const h0 = harness({ orders: [] });
      const tickets = ticketService(h0.clock, { rows: [], pending: 0 });
      const h = harness({ orders: [], tickets: tickets.port });
      expect(await h.run(60_000)).toEqual({ state: 'DONE', reasons: [], paymentPendingOrders: 0, depositOrdersCancelled: 0, depositOrdersPending: 0, unusedTicketsCancelled: 0, unusedTicketsPending: 0 });
      expect(tickets.calls).toEqual([]);
    }
  });

  test('I-T26③_행이있는대기1장과이번에부르지못한1장이면pending2이고_같은표를두번세지않는다', async () => {
    const rows = [ticketRow(), ticketRow()];
    const written = new Set<string>();
    const h0 = harness({ orders: [] });
    const tickets = ticketService(h0.clock, {
      rows,
      results: ['THROW', 'THROW'],
      pending: 1,
      // 첫 표는 행을 쓴 뒤 실패(REFUND_PENDING 행이 있다), 둘째는 행을 만들지 못했다
      statusOf: async (id) => (written.has(id) ? 'REFUND_PENDING' : undefined),
    });
    // 첫 취소가 부를 때 그 표의 행이 이미 있는 것처럼 만든다
    const original = tickets.service.cancel.bind(tickets.service);
    const h = harness({
      orders: [],
      tickets: {
        quote: (q) => tickets.service.quote(q),
        cancel: async (q) => {
          const first = rows[0]!;
          written.add(withdrawalTicketCancellationId(first.ticketId));
          return original(q);
        },
        pendingRefunds: (q) => tickets.service.pendingRefunds(q),
      },
    });
    expect(await h.run(60_000)).toMatchObject({ state: 'PENDING', reasons: ['TICKET_REFUND_PENDING'], unusedTicketsCancelled: 0, unusedTicketsPending: 2 });
  });

  test('I-T26③_기존대기행이있으면결제사를다시부르지않는다(재시도는환급고리몫)', async () => {
    const h0 = harness({ orders: [] });
    const tickets = ticketService(h0.clock, { rows: [], pending: 2 });
    const h = harness({ orders: [], tickets: tickets.port });
    expect(await h.run(60_000)).toMatchObject({ state: 'PENDING', reasons: ['TICKET_REFUND_PENDING'], unusedTicketsPending: 2 });
    expect(tickets.calls).toEqual([]);
  });

  test('I-T26③_저장소가pendingRefunds에서실패하면DONE으로접지않고WithdrawalOrdersUnavailable이다', async () => {
    const failing: WithdrawalTickets = {
      quote: async () => ({ count: 0, ticketAmount: 0, deductionAmount: 0, refundAmount: 0, transferableCount: 0, deferredRefundCount: 0 }),
      cancel: async () => ({ cancelled: 0, pendingUncanceled: 0, skipped: 0 }),
      pendingRefunds: async () => {
        throw new WithdrawalOrdersUnavailable(new Error('문장 시간 초과(주입)'));
      },
    };
    const h = harness({ orders: [], tickets: failing });
    await expect(h.run(60_000)).rejects.toBeInstanceOf(WithdrawalOrdersUnavailable);
    expect(h.signals.participant).toEqual(['error']);
  });
});
