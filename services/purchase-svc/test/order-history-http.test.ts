// F-07-2 주문 내역의 받는 층 시험: GET /v1/orders·GET /v1/orders/{orderId}(openapi listOrders·getOrder, docs/frontend.md §5.29).
// AppModule을 메모리 조립으로 띄우고 fastify inject로 부른다. 신원은 게이트웨이 내부 머리, 주문 내역 포트는 이 파일의 가짜다
// (도메인 규칙은 order-history-domain.test.ts가 본다). 판정 항목 J-T30 ①②.
import 'reflect-metadata';
import { Writable } from 'node:stream';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import type { MergedAccounts, OrderHistoryOrder, OrderHistoryReads, OrderSeatLabels } from '../src/modules/booking/index.js';
import { MemoryPurchaseSessions } from '../src/modules/inventory/index.js';
import { AcceptFakes } from './accept-cases.js';
import { ACCOUNT, CONSENT_VERSION, EVENT, JOURNEY, LOGIN, NOW, OrderFakes, PID, PSID } from './order-cases.js';

const KEY = Buffer.alloc(32, 9);
const quiet = new Writable({ write: (_c, _e, cb) => cb() });
const clock = fakeClock({ now: NOW });
const OTHER = '00000000-0000-4000-8000-0000000000ff';
/** ACCOUNT(대표)에 흡수된 계정 */
const ABSORBED = '00000000-0000-4000-8000-0000000000aa';
const ORDER_A = '0192f0aa-1111-7000-8000-000000000001';
const ORDER_B = '0192f0aa-2222-7000-8000-000000000002';
const ORDER_C = '0192f0aa-3333-7000-8000-000000000003';
const ORDER_D = '0192f0aa-4444-7000-8000-000000000004';

/** 가짜 읽기: 계정 묶음·커서·limit만 보고, 어댑터처럼 정렬은 이미 된 것으로 준다(도메인은 자르기·커서만 한다) */
class FakeHistory implements OrderHistoryReads {
  rows: OrderHistoryOrder[] = [];
  last?: { accountIds: readonly string[]; limit: number; before?: { createdAt: Date; orderId: string } };
  async list(accountIds: readonly string[], o: { limit: number; before?: { createdAt: Date; orderId: string } }): Promise<readonly OrderHistoryOrder[]> {
    this.last = { accountIds, ...o };
    const mine = this.rows.filter((r) => accountIds.includes(r.accountId)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.orderId < b.orderId ? 1 : -1));
    const start = o.before ? mine.findIndex((r) => r.createdAt.getTime() < o.before!.createdAt.getTime() || (r.createdAt.getTime() === o.before!.createdAt.getTime() && r.orderId < o.before!.orderId)) : 0;
    return mine.slice(Math.max(0, start), Math.max(0, start) + o.limit);
  }
  async find(orderId: string, accountIds: readonly string[]): Promise<OrderHistoryOrder | undefined> {
    return this.rows.find((r) => r.orderId === orderId && accountIds.includes(r.accountId));
  }
}

/** 가짜 계정 묶음: 시험이 넣은 표만 보고, 없으면 계정 하나다 */
class FakeMergedAccounts implements MergedAccounts {
  ids = new Map<string, string[]>();
  async accountIdsOf(accountId: string): Promise<readonly string[]> {
    return this.ids.get(accountId) ?? [accountId];
  }
}

const orderOf = (over: Partial<OrderHistoryOrder> = {}): OrderHistoryOrder => ({
  orderId: ORDER_A,
  accountId: ACCOUNT,
  eventId: EVENT,
  status: 'CONFIRMED',
  amount: 132_000,
  createdAt: new Date('2026-10-14T03:00:00.000Z'),
  failureReason: null,
  items: [
    { lineNo: 1, seatId: 'seat-1', tierId: 'R', unitPrice: 66_000, ticketId: 'tkt-1' },
    { lineNo: 2, seatId: 'seat-2', tierId: 'R', unitPrice: 66_000, ticketId: 'tkt-2' },
  ],
  cancellations: [
    { cancellationId: 'can-1', ticketId: 'tkt-1', requestedAt: new Date('2026-10-15T00:00:00.000Z'), deductionAmount: 6_600, refundAmount: 59_400, refundDueAt: null, status: 'REQUESTED', refundAccountRequired: false },
  ],
  ...over,
});

const reads = new FakeHistory();
const merged = new FakeMergedAccounts();
/** 서비스가 이 객체를 잡으므로, 시험은 메서드를 바꿔 끼운다(변수를 다시 대입하면 서비스에 닿지 않는다) */
const seats: OrderSeatLabels = {
  async resolve(_eventId, seatIds) {
    return seatIds.map((id) => ({ label: id === 'seat-1' ? 'A구역 3열 12' : 'A구역 3열 13', tierName: 'R석' }));
  },
};
const labelsOk = seats.resolve;
const configs = {
  async get(eventId: string) {
    return eventId === EVENT
      ? {
          saleEndsAtMs: NOW,
          tierPrices: { R: 66_000 },
          tierNames: { R: 'R석' },
          title: 'LUMEN 콘서트 2026 서울',
          startsAtMs: Date.parse('2026-10-25T09:00:00.000Z'),
          entryOpensAtMs: Date.parse('2026-10-25T08:00:00.000Z'),
        }
      : undefined;
  },
};
const sessions = new MemoryPurchaseSessions();
sessions.open({ sessionId: PSID, accountId: ACCOUNT, eventId: EVENT, journeyId: JOURNEY, loginSessionId: LOGIN, key: KEY });

let svc: Awaited<ReturnType<typeof createService>>;
let bare: Awaited<ReturnType<typeof createService>>;
beforeAll(async () => {
  svc = await createService({
    name: 'purchase-svc',
    module: AppModule.register({
      memory: true,
      sessions,
      booking: {
        ...new OrderFakes(clock).ports(),
        ...new AcceptFakes().bookingPorts(),
        consentVersion: CONSENT_VERSION,
        clock,
        orderHistory: { reads, seats, configs, accounts: merged },
      },
    }),
    purchaseSessions: sessions,
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet,
  });
  // 주문 내역 포트를 조립하지 않은 앱: 새 경로는 404(경로가 없는 것과 같은 본문)다
  bare = await createService({
    name: 'purchase-svc',
    module: AppModule.register({ memory: true, sessions, booking: { ...new OrderFakes(clock).ports(), ...new AcceptFakes().bookingPorts(), consentVersion: CONSENT_VERSION, clock } }),
    purchaseSessions: sessions,
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet,
  });
});
afterAll(async () => {
  await svc?.close();
  await bare?.close();
});
beforeEach(() => {
  reads.rows = [];
  reads.last = undefined;
  merged.ids.clear();
  seats.resolve = labelsOk;
});

const FAN: Record<string, string> = { 'x-user-id': ACCOUNT, 'x-session-id': LOGIN, 'x-user-aud': 'fan', 'x-user-pid': PID };
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const headersOf = (r: { headers: Record<string, unknown> }) => r.headers;

function get(url: string, identity: Record<string, string> | null = FAN, app: typeof svc = svc) {
  return app.http.inject({ method: 'GET', url, headers: identity ?? {} });
}

describe('F-07-2 주문 내역 받는 층', () => {
  test('ORD-HIST ① 목록은 내 티켓 주문을 최신순으로 주고 EXPIRED를 뺀다. 응답은 private, no-store다', async () => {
    reads.rows = [
      orderOf({ orderId: ORDER_A, createdAt: new Date('2026-10-14T03:00:00.000Z') }),
      orderOf({ orderId: ORDER_B, createdAt: new Date('2026-10-15T03:00:00.000Z'), status: 'AWAITING_DEPOSIT' }),
      orderOf({ orderId: ORDER_C, createdAt: new Date('2026-10-16T03:00:00.000Z'), status: 'EXPIRED' }),
      orderOf({ orderId: ORDER_D, accountId: OTHER, createdAt: new Date('2026-10-17T03:00:00.000Z') }),
    ];
    const r = await get('/v1/orders');
    expect(r.statusCode).toBe(200);
    expect(headersOf(r)['cache-control']).toBe('private, no-store');
    const body = json(r) as { items: Record<string, unknown>[]; nextCursor: string | null };
    expect(body.items.map((i) => i.orderId)).toEqual([ORDER_B, ORDER_A]);
    expect(body.nextCursor).toBeNull();
    expect(body.items[0]).toMatchObject({
      orderId: ORDER_B,
      eventId: EVENT,
      eventTitle: 'LUMEN 콘서트 2026 서울',
      eventStartsAt: '2026-10-25T09:00:00.000Z',
      amount: 132_000,
      status: 'AWAITING_DEPOSIT',
      tiers: [{ tierName: 'R석', quantity: 2 }],
    });
    expect(String(body.items[0]!.bookingNumber)).toMatch(/^\d{13}$/);
    // 어댑터에는 limit+1을 요청해 다음 페이지가 있는지 싸게 본다(돌려주는 항목은 limit개까지다)
    expect(reads.last).toMatchObject({ accountIds: [ACCOUNT], limit: 21 });
  });

  test('ORD-HIST ④ 다음 페이지는 커서로 이어지고 겹치지 않는다. 잘못된 커서·limit은 400이다', async () => {
    reads.rows = [ORDER_A, ORDER_B, ORDER_C].map((orderId, i) => orderOf({ orderId, createdAt: new Date(`2026-10-1${4 + i}T03:00:00.000Z`) }));
    const first = json(await get('/v1/orders?limit=2')) as { items: { orderId: string }[]; nextCursor: string };
    expect(first.items.map((i) => i.orderId)).toEqual([ORDER_C, ORDER_B]);
    expect(first.nextCursor).toBeTypeOf('string');
    const second = json(await get(`/v1/orders?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)) as { items: { orderId: string }[]; nextCursor: string | null };
    expect(second.items.map((i) => i.orderId)).toEqual([ORDER_A]);
    expect(second.nextCursor).toBeNull();

    for (const q of ['?limit=0', '?limit=101', '?cursor=not-a-cursor', '?limit=abc', '?cursor=a&cursor=b']) {
      const r = await get(`/v1/orders${q}`);
      expect(r.statusCode, q).toBe(400);
      expect(r.headers['content-type']).toMatch(/^application\/problem\+json/);
    }

    // IR-03: 커서 안의 주문 ID가 정확한 UUID가 아니면 DB ::uuid 캐스트(500)까지 가지 않고 400이다
    const at = '2026-10-14T03:00:00.000Z';
    const rawCursor = (orderId: string) => encodeURIComponent(Buffer.from(`${at}|${orderId}`, 'utf8').toString('base64url'));
    for (const orderId of ['-'.repeat(36), ORDER_A.toUpperCase(), '0192f0aa-1111-7000-8000-0000000000', 'not-a-uuid', ORDER_A.replace(/-/g, '')]) {
      const r = await get(`/v1/orders?cursor=${rawCursor(orderId)}`);
      expect(r.statusCode, orderId).toBe(400);
      expect(JSON.parse(r.payload)).toMatchObject({ status: 400, type: expect.stringMatching(/invalid-query$/) });
    }
  });

  test('ORD-HIST ② 상세는 내 주문만 답하고, 남의 주문·없는 주문은 같은 404다', async () => {
    reads.rows = [orderOf(), orderOf({ orderId: ORDER_B, accountId: OTHER })];
    const mine = await get(`/v1/orders/${ORDER_A}`);
    expect(mine.statusCode).toBe(200);
    expect(mine.headers['cache-control']).toBe('private, no-store');
    const detail = json(mine) as Record<string, unknown>;
    expect(detail).toMatchObject({
      orderId: ORDER_A,
      eventTitle: 'LUMEN 콘서트 2026 서울',
      entryOpensAt: '2026-10-25T08:00:00.000Z',
      tiers: [{ tierName: 'R석', quantity: 2 }],
    });
    expect(detail.seats).toEqual([
      { seatLabel: 'A구역 3열 12', tierName: 'R석', unitPrice: 66_000, gateZone: null, ticketId: 'tkt-1' },
      { seatLabel: 'A구역 3열 13', tierName: 'R석', unitPrice: 66_000, gateZone: null, ticketId: 'tkt-2' },
    ]);
    expect(detail.cancellations).toEqual([
      { cancellationId: 'can-1', ticketId: 'tkt-1', requestedAt: '2026-10-15T00:00:00.000Z', deductionAmount: 6_600, refundAmount: 59_400, refundDueAt: null, status: 'REQUESTED', refundAccountRequired: false },
    ]);

    const others = await get(`/v1/orders/${ORDER_B}`);
    const missing = await get(`/v1/orders/${ORDER_C}`);
    expect(others.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    // 본문은 instance·traceId만 다르고 나머지 Problem 필드는 같다(남의 주문과 없는 주문을 가리지 않는다)
    const problemOf = (p: string) => {
      const o = JSON.parse(p) as Record<string, unknown>;
      return { type: o.type, title: o.title, status: o.status };
    };
    expect(problemOf(others.payload)).toEqual(problemOf(missing.payload));
    expect(problemOf(others.payload).type).toMatch(/not-found$/);
    expect(Object.keys(JSON.parse(others.payload) as Record<string, unknown>)).not.toContain('orderId');
  });

  test('ORD-HIST ② 대표 계정은 흡수 계정 주문을 목록·상세에서 보고, 묶음 밖은 404다(IR-02)', async () => {
    merged.ids.set(ACCOUNT, [ACCOUNT, ABSORBED]);
    reads.rows = [
      orderOf({ orderId: ORDER_A, accountId: ACCOUNT, createdAt: new Date('2026-10-14T03:00:00.000Z') }),
      orderOf({ orderId: ORDER_B, accountId: ABSORBED, createdAt: new Date('2026-10-15T03:00:00.000Z') }),
      orderOf({ orderId: ORDER_C, accountId: OTHER, createdAt: new Date('2026-10-16T03:00:00.000Z') }),
    ];
    const list = json(await get('/v1/orders')) as { items: { orderId: string }[] };
    expect(list.items.map((i) => i.orderId)).toEqual([ORDER_B, ORDER_A]);
    expect(reads.last?.accountIds).toEqual([ACCOUNT, ABSORBED]);

    expect((await get(`/v1/orders/${ORDER_B}`)).statusCode).toBe(200);
    expect((await get(`/v1/orders/${ORDER_C}`)).statusCode).toBe(404);

    // 흡수 계정으로 로그인한 세션도 같은 묶음을 본다(대표+흡수, 포트가 정한 차례 그대로)
    merged.ids.set(ABSORBED, [ACCOUNT, ABSORBED]);
    const asAbsorbed = await svc.http.inject({ method: 'GET', url: '/v1/orders', headers: { ...FAN, 'x-user-id': ABSORBED, 'x-user-pid': 'pid-absorbed' } });
    expect(asAbsorbed.statusCode).toBe(200);
    expect((json(asAbsorbed) as { items: { orderId: string }[] }).items.map((i) => i.orderId)).toEqual([ORDER_B, ORDER_A]);
    expect((await get(`/v1/orders/${ORDER_A}`, { ...FAN, 'x-user-id': ABSORBED })).statusCode).toBe(200);

    // 섞인 목록의 커서: 1건씩 두 번 받아도 겹치지 않고 최신순이다
    const page1 = json(await get('/v1/orders?limit=1')) as { items: { orderId: string }[]; nextCursor: string };
    const page2 = json(await get(`/v1/orders?limit=1&cursor=${encodeURIComponent(page1.nextCursor)}`)) as { items: { orderId: string }[] };
    expect(page1.items.map((i) => i.orderId)).toEqual([ORDER_B]);
    expect(page2.items.map((i) => i.orderId)).toEqual([ORDER_A]);
  });

  test('ORD-HIST ③ 좌석맵 판을 읽지 못하면 좌석 ID·등급 ID로 떨어지고 500이 아니다', async () => {
    reads.rows = [orderOf()];
    seats.resolve = async () => {
      throw new Error('판 읽기 실패');
    };
    const r = await get(`/v1/orders/${ORDER_A}`);
    expect(r.statusCode).toBe(200);
    // 좌석 이름은 판이 없어 저장 값(좌석 ID)으로 떨어지고, 등급 이름은 판매 설정 사본에서 그대로 온다
    expect((json(r) as { seats: { seatLabel: string; tierName: string }[] }).seats[0]).toMatchObject({ seatLabel: 'seat-1', tierName: 'R석' });
  });

  test('ORD-HIST ⑤ 로그인하지 않으면 401이고, 포트를 조립하지 않은 앱은 404다', async () => {
    expect((await get('/v1/orders', null)).statusCode).toBe(401);
    expect((await get(`/v1/orders/${ORDER_A}`, null)).statusCode).toBe(401);
    reads.rows = [orderOf()];
    expect((await get('/v1/orders', FAN, bare)).statusCode).toBe(404);
    expect((await get(`/v1/orders/${ORDER_A}`, FAN, bare)).statusCode).toBe(404);
  });
});
