// BAT-420 리뷰 D5(시험 담당, 구현 전에 씀, 계획 §11 보충 3): 회차 취소가 확정된 회차(CANCEL RUNNING·PAUSED·COMPLETED)의 팬 취소·견적은
// 티켓 단계(키 폐기) 앞에서 409 event-cancelled다. 확정 여부 판단(요청 종류·상태 목록)은 Drizzle 조회가 하고(test-int/event-refund.int.test.ts),
// 여기서는 그 답이 참일 때 Saga·견적·HTTP가 아무것도 바꾸지 않는지, 거짓이면 지금처럼 가는지 본다.
// 정본: docs/features/transfer-refund.md §5 '확정 뒤 팬 취소'(추천 적용 2026-11-16, BAT-420 리뷰 D5), openapi 팬 취소·견적 409. 시험 담당이 구현 전에 썼다(ADR-0270).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createService, fakeClock, PROBLEM_TYPE_BASE, purchaseMac, purchaseMacInput } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryPurchaseSessions } from '../src/modules/inventory/index.js';
import {
  CancelTicket,
  QuoteCancellation,
  WeekendBusinessCalendar,
  type CancellationOrderView,
  type CancellationWrites,
  type EventCancellationLookup,
  type PaymentCancellations,
  type SeatReturns,
  type TicketCancellations,
} from '../src/modules/refund/index.js';

const kst = (s: string): number => Date.parse(`${s}+09:00`);
const NOW = kst('2026-11-13T10:00:00');
const EVENT = '0194c700-0000-7000-8000-000000000001';
const TICKET = '0194c700-0000-7000-8000-000000000002';
const ORDER = '0194c700-0000-7000-8000-000000000003';
const ACCOUNT = '0194c700-0000-7000-8000-000000000004';
const calendar = new WeekendBusinessCalendar();
const view: CancellationOrderView = {
  orderId: ORDER,
  eventId: EVENT,
  ticketId: TICKET,
  seatId: '0194c700-0000-7000-8000-000000000005',
  payerAccountId: ACCOUNT,
  ticketPrice: 33_333,
  bookedAtMs: kst('2026-11-01T10:00:00'),
  saleEndsAtMs: kst('2026-11-19T19:00:00'),
  entryOpensAtMs: kst('2026-11-20T18:00:00'),
  orderStatus: 'CONFIRMED',
};

const parts = (confirmed: boolean | undefined) => {
  const calls = { tickets: 0, payments: 0, creates: 0, updates: 0, seats: 0, lookups: [] as string[] };
  const tickets: TicketCancellations = { cancel: async () => (calls.tickets++, 'REFUND_NOW') };
  const payments: PaymentCancellations = { cancel: async () => (calls.payments++, 'CANCELLED') };
  const writes: CancellationWrites = {
    create: async () => (calls.creates++, { status: 'CREATED' }),
    updateStatus: async () => void calls.updates++,
    scheduleRefundRetry: async () => undefined,
    markRefundFailed: async () => undefined,
    dueRefunds: async () => [],
  };
  const seats: SeatReturns = { returnSold: async () => (calls.seats++, 1) };
  const orders = { findByTicket: async () => view, findCancellation: async () => undefined };
  const eventCancellations: EventCancellationLookup | undefined = confirmed === undefined ? undefined : { confirmed: async (id) => (calls.lookups.push(id), confirmed) };
  return { calls, tickets, payments, writes, seats, orders, calendar, ...(eventCancellations ? { eventCancellations } : {}) };
};
const fanCancel = (p: ReturnType<typeof parts>) =>
  new CancelTicket(p).execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: randomUUID(), reason: 'USER', nowMs: NOW, deadlineMs: NOW + 5_000 });

describe('확정된 회차의 팬 취소·견적 [BAT-420 리뷰 D5]', () => {
  test('GAT-110 R5 확정된 회차의 팬 취소는 EVENT_CANCELLED이고 티켓 단계(키 폐기)·취소 행·결제사·좌석을 부르지 않는다', async () => {
    const p = parts(true);
    await expect(fanCancel(p)).resolves.toEqual({ status: 'EVENT_CANCELLED' });
    expect(p.calls).toEqual({ tickets: 0, payments: 0, creates: 0, updates: 0, seats: 0, lookups: [EVENT] });
  });

  test('GAT-110 R5 대조: 확정되지 않은 회차(판정 중·연기·요청 없음은 조회가 거짓)의 팬 취소는 지금처럼 공제해 환급한다', async () => {
    const p = parts(false);
    await expect(fanCancel(p)).resolves.toMatchObject({ status: 'ACCEPTED', refundAmount: 30_000 });
    expect(p.calls.lookups).toEqual([EVENT]);
    expect(p.calls.tickets).toBe(1);
    expect(p.calls.payments).toBe(1);
  });

  test('GAT-110 R5 확정된 회차의 견적은 EVENT_CANCELLED이고, 확정되지 않았으면 지금처럼 공제 견적이다', async () => {
    const yes = parts(true);
    await expect(new QuoteCancellation(yes).execute({ accountId: ACCOUNT, ticketId: TICKET, nowMs: NOW })).resolves.toEqual({ status: 'EVENT_CANCELLED' });
    expect(yes.calls.lookups).toEqual([EVENT]);
    const no = parts(false);
    await expect(new QuoteCancellation(no).execute({ accountId: ACCOUNT, ticketId: TICKET, nowMs: NOW })).resolves.toMatchObject({ status: 'OK', quote: { deductionAmount: 3_333, refundAmount: 30_000 } });
  });

  test('GAT-110 R5 결제자가 아니면 확정 여부와 관계없이 지금처럼 NOT_PAYER다(남의 표로 회차 상태를 알아내지 못한다)', async () => {
    const p = parts(true);
    const r = await new CancelTicket(p).execute({ accountId: randomUUID(), ticketId: TICKET, cancellationId: randomUUID(), reason: 'USER', nowMs: NOW, deadlineMs: NOW + 5_000 });
    expect(r).toEqual({ status: 'NOT_PAYER' });
    expect(p.calls.tickets).toBe(0);
  });

  // 검증(e2d565c6) 살아남은 M-R5i-q: 결제자 대조가 팬 취소에만 있어, 견적에서 확정 확인을 결제자 검사 앞으로 옮겨도 통과했다
  test('GAT-110 R5 견적도 결제자가 아니면 확정된 회차여도 NOT_PAYER이고 회차 확정 여부를 묻지 않는다(남의 표로 회차 상태를 알아내지 못한다)', async () => {
    const p = parts(true);
    await expect(new QuoteCancellation(p).execute({ accountId: randomUUID(), ticketId: TICKET, nowMs: NOW })).resolves.toEqual({ status: 'NOT_PAYER' });
    expect(p.calls.lookups).toEqual([]);
  });

  // 검증(e2d565c6) 살아남은 M-R5h: 막기는 팬 취소(USER)에만 건다(정본 '공제하는 팬 취소 길을 닫는다'). 연기 신청 환급처럼 공제 없는 사유는 확정 회차여도 막지 않는다
  test('GAT-110 R5 확정된 회차여도 팬 취소가 아닌 사유(연기 신청 환급 EVENT_POSTPONED)는 막지 않고 공제 없이 권면 33,333원을 환급한다', async () => {
    const p = parts(true);
    const r = await new CancelTicket(p).execute({ accountId: ACCOUNT, ticketId: TICKET, cancellationId: randomUUID(), reason: 'EVENT_POSTPONED', nowMs: NOW, deadlineMs: NOW + 5_000 });
    expect(r).toMatchObject({ status: 'ACCEPTED', refundAmount: 33_333 });
    expect(p.calls.tickets).toBe(1);
    expect(p.calls.payments).toBe(1);
  });
});

describe('확정된 회차의 팬 취소·견적 HTTP [BAT-420 리뷰 D5]', () => {
  const KEY = Buffer.alloc(32, 7);
  const LOGIN = '0194c700-0000-7000-8000-000000000011';
  const PSID = '0194c700-0000-7000-8000-000000000012';
  const sessions = new MemoryPurchaseSessions();
  sessions.open({ sessionId: PSID, accountId: ACCOUNT, eventId: EVENT, journeyId: 'journey', loginSessionId: LOGIN, key: KEY });
  const quiet = new Writable({ write: (_c, _e, cb) => cb() });
  const p = parts(true);
  let svc: Awaited<ReturnType<typeof createService>>;
  let seq = 0;
  const fan = { 'x-user-id': ACCOUNT, 'x-session-id': LOGIN, 'x-user-aud': 'fan', 'x-user-scope': 'ticket:buy' };

  beforeAll(async () => {
    svc = await createService({
      name: 'purchase-svc',
      module: AppModule.register({
        memory: true,
        sessions,
        refund: { orders: p.orders, tickets: p.tickets, payments: p.payments, writes: p.writes, calendar, reauth: { verify: async () => true }, eventCancellations: p.eventCancellations! },
      }),
      purchaseSessions: sessions,
      env: { PEAKET_ENV: 'ci' },
      clock: fakeClock({ now: NOW }),
      logDestination: quiet,
    });
  });
  afterAll(async () => {
    await svc?.close();
  });

  test('GAT-110 R5 확정된 회차의 견적 GET과 취소 POST는 409 event-cancelled이고 티켓 단계·취소 행·결제사가 0이다', async () => {
    const quote = await svc.http.inject({ method: 'GET', url: `/v1/tickets/${TICKET}/cancellation-quote`, headers: fan });
    expect(quote.statusCode).toBe(409);
    expect(JSON.parse(quote.payload)).toMatchObject({ type: `${PROBLEM_TYPE_BASE}event-cancelled`, status: 409 });
    const url = `/v1/tickets/${TICKET}/cancellation`;
    const payload = '{}';
    seq += 1;
    const cancel = await svc.http.inject({
      method: 'POST',
      url,
      headers: {
        ...fan,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
        'x-purchase-seq': String(seq),
        'x-purchase-mac': purchaseMac(KEY, purchaseMacInput('POST', url, seq, Buffer.from(payload, 'utf8'))),
        'x-reauth-token': 'reauth-ok',
      },
      payload,
    });
    expect(cancel.statusCode).toBe(409);
    expect(JSON.parse(cancel.payload)).toMatchObject({ type: `${PROBLEM_TYPE_BASE}event-cancelled`, status: 409 });
    expect(p.calls).toMatchObject({ tickets: 0, payments: 0, creates: 0 });
  });
});
