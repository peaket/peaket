// 예매 취소 HTTP 조립 시험(GAT-070·GAT-080): RefundModule을 메모리 조립에 꽂아 견적 200과 취소의 닫힌 재인증 403을 본다.
// BAT-421(ADR-0328): 취소 POST에서 구매 세션 서명을 뗐으므로 서명 머리가 없어도 401이 아니라 재인증 403이다.
// BAT-415 몫 S: 재인증 대역을 통과로 꽂은 두 번째 조립에서 R-T3(양도 요청 중·남이 보유 → 409 transfer-pending과 안내 문구)과 S1을 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
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

  test('GAT080_취소는_구매서명_없이_본문검사를_지나_재인증_계약이_없어_403_reauth-required다', async () => {
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

  test('GAT080_구매서명이_없어도_401이_아니라_403_reauth-required다', async () => {
    const r = await svc.http.inject({ method: 'POST', url: `/v1/tickets/${TICKET}/cancellation`, headers: { ...fanHeaders, 'content-type': 'application/json', 'idempotency-key': IDEM }, payload: '{}' });
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.payload).type).toBe(`${PROBLEM_TYPE_BASE}reauth-required`);
  });
});

describe('예매 취소 HTTP: 재인증을 통과한 뒤의 거절(BAT-415 몫 S)', () => {
  const ACCOUNT2 = '0193a000-0000-7000-8000-000000000011';
  const LOGIN2 = '0193a000-0000-7000-8000-000000000012';
  const PSID2 = '0193a000-0000-7000-8000-000000000013';
  const OTHER_PAYER_TICKET = '0193a000-0000-7000-8000-000000000015';
  const sessions2 = new MemoryPurchaseSessions();
  sessions2.open({ sessionId: PSID2, accountId: ACCOUNT2, eventId: EVENT, journeyId: 'journey', loginSessionId: LOGIN2, key: KEY });
  let ticketAnswer: Awaited<ReturnType<TicketCancellations['cancel']>> = 'REFUND_NOW';
  const created: unknown[] = [];
  const paid: unknown[] = [];
  const mine: CancellationOrderView = { ...view, payerAccountId: ACCOUNT2 };
  const someoneElses: CancellationOrderView = { ...view, ticketId: OTHER_PAYER_TICKET, payerAccountId: ACCOUNT };
  let svc2: Awaited<ReturnType<typeof createService>>;
  let seq = 0;

  beforeAll(async () => {
    svc2 = await createService({
      name: 'purchase-svc',
      module: AppModule.register({
        memory: true,
        sessions: sessions2,
        refund: {
          orders: { findByTicket: async (id) => (id === TICKET ? mine : id === OTHER_PAYER_TICKET ? someoneElses : undefined), findCancellation: async () => undefined },
          tickets: { cancel: async () => ticketAnswer },
          payments: {
            cancel: async (q) => {
              paid.push(q);
              return 'CANCELLED';
            },
          },
          writes: {
            ...writes,
            create: async (q) => {
              created.push(q);
              return { status: 'CREATED' };
            },
          },
          calendar: new WeekendBusinessCalendar(),
          reauth: { verify: async () => true },
        },
      }),
      purchaseSessions: sessions2,
      env: { PEAKET_ENV: 'ci' },
      clock,
      logDestination: quiet,
    });
  });
  afterAll(async () => {
    await svc2?.close();
  });

  const cancelHttp = async (ticketId: string) => {
    const url = `/v1/tickets/${ticketId}/cancellation`;
    const payload = '{}';
    seq += 1;
    return svc2.http.inject({
      method: 'POST',
      url,
      headers: {
        'x-user-id': ACCOUNT2,
        'x-session-id': LOGIN2,
        'x-user-aud': 'fan',
        'x-user-scope': 'ticket:buy',
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
        'x-purchase-seq': String(seq),
        'x-purchase-mac': purchaseMac(KEY, purchaseMacInput('POST', url, seq, Buffer.from(payload, 'utf8'))),
        'x-reauth-token': 'reauth-ok',
      },
      payload,
    });
  };

  test('R-T3 양도 요청 중·남이 보유한 티켓 취소는 409 transfer-pending과 안내 문구이고 취소 행·결제사 호출이 없다', async () => {
    for (const answer of ['TRANSFER_PENDING', 'NOT_PAYER_HOLDER'] as const) {
      ticketAnswer = answer;
      created.length = 0;
      paid.length = 0;
      const r = await cancelHttp(TICKET);
      expect(r.statusCode, answer).toBe(409);
      const problem = JSON.parse(r.payload) as { type: string; title: string; status: number };
      expect(problem.type, answer).toBe(`${PROBLEM_TYPE_BASE}transfer-pending`);
      expect(problem.title, answer).toBe('양도 요청을 철회한 뒤 취소할 수 있습니다');
      expect(problem.status, answer).toBe(409);
      expect(created, answer).toHaveLength(0);
      expect(paid, answer).toHaveLength(0);
    }
  });

  test('R-T3 대조: 결제자가 아니면 403 not-payer, 공연이 시작됐으면 409 entry-started다(transfer-pending으로 바꾸지 않는다)', async () => {
    ticketAnswer = 'REFUND_NOW';
    const notPayer = await cancelHttp(OTHER_PAYER_TICKET);
    expect(notPayer.statusCode).toBe(403);
    expect(JSON.parse(notPayer.payload).type).toBe(`${PROBLEM_TYPE_BASE}not-payer`);

    ticketAnswer = 'EVENT_STARTED';
    const started = await cancelHttp(TICKET);
    expect(started.statusCode).toBe(409);
    expect(JSON.parse(started.payload).type).toBe(`${PROBLEM_TYPE_BASE}entry-started`);
  });

  test('GAT-080 S1 ticket-svc가 ALREADY_CANCELLED를 주면 HTTP는 409 cancellation-conflict이고 취소 행·결제사 호출이 없다', async () => {
    ticketAnswer = 'ALREADY_CANCELLED';
    created.length = 0;
    paid.length = 0;
    const r = await cancelHttp(TICKET);
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.payload).type).toBe(`${PROBLEM_TYPE_BASE}cancellation-conflict`);
    expect(created).toHaveLength(0);
    expect(paid).toHaveLength(0);
  });
});
