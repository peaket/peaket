// 예매 취소 HTTP 조립 시험(GAT-070·GAT-080): RefundModule을 메모리 조립에 꽂아 견적 200과 취소의 닫힌 재인증 403을 본다.
import 'reflect-metadata';
import { Writable } from 'node:stream';
import { createService, fakeClock, PROBLEM_TYPE_BASE, purchaseMac, purchaseMacInput } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryPurchaseSessions } from '../src/modules/inventory/index.js';
import { WeekendBusinessCalendar, type CancellationOrderView, type CancellationWrites, type PaymentCancellations, type TicketCancellations } from '../src/modules/refund/index.js';

const NOW = Date.parse('2026-11-13T10:00:00+09:00');
const KEY = Buffer.alloc(32, 4);
const ACCOUNT = '0193a000-0000-7000-8000-000000000001';
const LOGIN = '0193a000-0000-7000-8000-000000000002';
const PSID = '0193a000-0000-7000-8000-000000000003';
const EVENT = '0193a000-0000-7000-8000-000000000004';
const TICKET = '0193a000-0000-7000-8000-000000000005';
const SEAT = '0193a000-0000-7000-8000-000000000006';
const ORDER = '0193a000-0000-7000-8000-000000000007';
const IDEM = '0193a000-0000-4000-8000-000000000008';
const clock = fakeClock({ now: NOW });
const quiet = new Writable({ write: (_c, _e, cb) => cb() });
const sessions = new MemoryPurchaseSessions();
sessions.open({ sessionId: PSID, accountId: ACCOUNT, eventId: EVENT, journeyId: 'journey', loginSessionId: LOGIN, key: KEY });

const view: CancellationOrderView = {
  orderId: ORDER,
  eventId: EVENT,
  ticketId: TICKET,
  seatId: SEAT,
  payerAccountId: ACCOUNT,
  ticketPrice: 33_333,
  bookedAtMs: Date.parse('2026-11-01T10:00:00+09:00'),
  saleEndsAtMs: Date.parse('2026-11-19T19:00:00+09:00'),
  entryOpensAtMs: Date.parse('2026-11-20T18:00:00+09:00'),
  orderStatus: 'CONFIRMED',
};
const tickets: TicketCancellations = { cancel: async () => 'REFUND_NOW' };
const payments: PaymentCancellations = { cancel: async () => 'CANCELLED' };
const writes: CancellationWrites = {
  create: async () => ({ status: 'CREATED' }),
  updateStatus: async () => undefined,
  scheduleRefundRetry: async () => undefined,
  markRefundFailed: async () => undefined,
  dueRefunds: async () => [],
};

let svc: Awaited<ReturnType<typeof createService>>;
beforeAll(async () => {
  svc = await createService({
    name: 'purchase-svc',
    module: AppModule.register({
      memory: true,
      sessions,
      refund: {
        orders: { findByTicket: async (id) => (id === TICKET ? view : undefined), findCancellation: async () => undefined },
        tickets,
        payments,
        writes,
        calendar: new WeekendBusinessCalendar(),
      },
    }),
    purchaseSessions: sessions,
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet,
  });
});
afterAll(async () => {
  await svc?.close();
});

const fanHeaders = { 'x-user-id': ACCOUNT, 'x-session-id': LOGIN, 'x-user-aud': 'fan', 'x-user-scope': 'ticket:buy' };

describe('예매 취소 HTTP', () => {
  test('GAT070_견적은_결제자에게_공제율과_환급액을_준다', async () => {
    const r = await svc.http.inject({ method: 'GET', url: `/v1/tickets/${TICKET}/cancellation-quote`, headers: fanHeaders });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toMatchObject({ ticketId: TICKET, deductionRate: 0.1, deductionAmount: 3_333, refundAmount: 30_000 });
  });

  test('GAT080_취소는_구매서명을_지나지만_재인증_계약이_없어_403_reauth-required다', async () => {
    const url = `/v1/tickets/${TICKET}/cancellation`;
    const payload = '{}';
    const seq = 1;
    const r = await svc.http.inject({
      method: 'POST',
      url,
      headers: {
        ...fanHeaders,
        'content-type': 'application/json',
        'idempotency-key': IDEM,
        'x-purchase-seq': String(seq),
        'x-purchase-mac': purchaseMac(KEY, purchaseMacInput('POST', url, seq, Buffer.from(payload, 'utf8'))),
      },
      payload,
    });
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.payload).type).toBe(`${PROBLEM_TYPE_BASE}reauth-required`);
  });

  test('GAT080_구매서명이_없으면_401이다', async () => {
    const r = await svc.http.inject({ method: 'POST', url: `/v1/tickets/${TICKET}/cancellation`, headers: { ...fanHeaders, 'content-type': 'application/json', 'idempotency-key': IDEM }, payload: '{}' });
    expect(r.statusCode).toBe(401);
  });
});
