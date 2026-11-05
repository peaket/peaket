// 주문·결제 v0(docs/features/payment.md §13)와 좌석 판매(docs/features/seat-hold.md §14 동작 9) 통합 시험.
// 실제 PostgreSQL 18·Valkey 컨테이너 + 모놀리스 HTTP(inject) + 프로세스 안 PG 시뮬레이터(실제 HTTP). 시계만 가짜(fakeClock)이고
// 시뮬레이터도 같은 시계를 쓴다. 결제창 인증은 시뮬레이터 시험용 인증(/sim/authenticate)으로 대신한다.
// 단언은 상태 코드만이 아니라 응답 본문, 표(v0_order·v0_order_item·v0_order_event·v0_payment·v0_ticket·v0_seat·v0_hold·v0_quota),
// 시뮬레이터 원장(/sim/ledger)과 시뮬레이터가 받은 호출, 변경분(LISTEN·WebSocket)까지 본다.
// 시험마다 회차 ID를 새로 만든다. 시뮬레이터 장애는 주문 ID로 좁히고 시험 끝에 지운다.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { orderNameOf } from '../src/modules/booking/index.js';
import { createPayments, createV0PaymentGateway } from '../src/modules/payment/index.js';
import { JSON_CONTENT_TYPE, expectProblem, fanHeaders, type Headers } from './queue-harness.js';
import {
  EXTEND_MS,
  ORDER_KEYS,
  PRICES,
  SaleHarness,
  TICKET_CODE_SHAPE,
  TTL_MS,
  changesFor,
  cmp,
  expectStatus,
  hasAll,
  problemShape,
  sleep,
  waitChanges,
  waitUntil,
  type NotifyListener,
  type OrderBody,
} from './sale-harness.js';
import { UUID_PATTERN, refKst } from './seat-harness.js';

let h: SaleHarness;
let feed: NotifyListener;

beforeAll(async () => {
  h = await SaleHarness.start();
  feed = await h.listenNotifications();
});

afterAll(async () => {
  await h?.close();
});

afterEach(async () => {
  h?.closeSockets();
  // 장애는 주문 ID로 좁혀 넣지만, 실패한 시험이 남긴 것이 있으면 지운다
  if (h) await h.clearFaults().catch(() => {});
});

const sorted = (xs: string[]) => [...xs].sort(cmp);
const acc = (pid: string) => `acc-${pid}`;
const attempt = (f: () => unknown): Promise<unknown> => (async () => f())();
const sortTickets = (ts: OrderBody['tickets']) => [...ts].sort((a, b) => cmp(a.seatId, b.seatId));

/** 그 좌석들의 행(좌석 ID 순) */
async function seatsOf(eventId: string, seatIds: string[]) {
  return (await h.saleSeats(eventId)).filter((s) => seatIds.includes(s.seatId));
}

/** 좌석들이 그 주문으로 팔린 상태인지 */
async function expectSold(eventId: string, seatIds: string[], orderId: string) {
  expect(await seatsOf(eventId, seatIds), `판 좌석 ${seatIds.join(',')}`).toEqual(sorted(seatIds).map((seatId) => ({ seatId, status: 'SOLD', holdId: null, orderId })));
}

/** 좌석들이 빈 좌석인지(홀드·주문 표시 없이) */
async function expectAvailable(eventId: string, seatIds: string[]) {
  expect(await seatsOf(eventId, seatIds), `빈 좌석 ${seatIds.join(',')}`).toEqual(sorted(seatIds).map((seatId) => ({ seatId, status: 'AVAILABLE', holdId: null, orderId: null })));
}

/** 좌석들이 그 홀드로 잡혀 있는지 */
async function expectHeld(eventId: string, seatIds: string[], holdId: string) {
  expect(await seatsOf(eventId, seatIds), `잡힌 좌석 ${seatIds.join(',')}`).toEqual(sorted(seatIds).map((seatId) => ({ seatId, status: 'HELD', holdId, orderId: null })));
}

/**
 * 결제 확정이 실패로 끝나 좌석을 돌려준 상태(§13 동작 2 ③④): 주문 FAILED(CREATED → PAYING → FAILED), 좌석 빈 좌석, 홀드 RELEASED,
 * 판 수 원복, 결제 행 FAILED(승인 시각 없음, failure에 결과), 티켓 없음
 */
async function expectReturnedAfterPayment(o: {
  eventId: string;
  orderId: string;
  holdId: string;
  seatIds: string[];
  paymentKey: string;
  amount: number;
  atMs: number;
  /** failure에 들어 있어야 할 결과·결제사 코드(payment §13 동작 2 ③ 'failure에 결과와 결제사 코드') */
  failureHas?: string[];
}) {
  expect((await h.orderRow(o.orderId))?.status).toBe('FAILED');
  expect(await h.orderTrail(o.orderId)).toEqual([
    [1, 'CREATED'],
    [2, 'PAYING'],
    [3, 'FAILED'],
  ]);
  await expectAvailable(o.eventId, o.seatIds);
  expect((await h.holdRow(o.holdId))?.status).toBe('RELEASED');
  const payments = await h.paymentRows(o.orderId);
  expect(payments).toEqual([
    {
      paymentId: expect.stringMatching(UUID_PATTERN),
      orderId: o.orderId,
      eventId: o.eventId,
      pg: 'SIMULATOR',
      paymentKey: o.paymentKey,
      amount: o.amount,
      status: 'FAILED',
      failure: expect.any(String),
      approvedAtMs: null,
      createdAtMs: o.atMs,
    },
  ]);
  expect(payments[0]!.failure!.trim(), 'failure에 결과와 결제사 코드').not.toBe('');
  for (const part of o.failureHas ?? []) expect(payments[0]!.failure, `failure에 ${part}`).toContain(part);
  expect(await h.ticketRows({ orderId: o.orderId })).toEqual([]);
  expect((await h.orderItems(o.orderId)).map((i) => i.ticketId)).toEqual(o.seatIds.map(() => null));
}

// ───────────────────────── 가격 넣기(§13 동작 4) ─────────────────────────

describe('가격 넣기 createBookingAdmin().setPrices', () => {
  test('FR011_가격넣기는등급별가격을넣고_다시부르면그등급값만바꾸며_1원과1억원을받고틀린입력은아무것도바꾸지않는다 [ASVS v5.0.0-2.2.1]', async () => {
    const e = h.newEventId();
    await h.bookingAdmin.setPrices(e, { R: 1, S: 100_000_000, VIP석: 77_000 });
    const first = [
      { grade: 'R', price: 1 },
      { grade: 'S', price: 100_000_000 },
      { grade: 'VIP석', price: 77_000 },
    ].sort((a, b) => cmp(a.grade, b.grade));
    expect(await h.priceRows(e)).toEqual(first);
    await h.bookingAdmin.setPrices(e, { R: 2_000 });
    const second = first.map((p) => (p.grade === 'R' ? { grade: 'R', price: 2_000 } : p));
    expect(await h.priceRows(e)).toEqual(second);
    // 틀린 입력(맞는 등급과 섞인 것 포함)은 거절하고 표를 바꾸지 않는다
    const bads: Record<string, number>[] = [{ R: 0 }, { R: -1 }, { R: 3_000, S: 100_000_001 }, {}, { 'R\n': 1_000 }, { R: 1.5 }];
    for (const bad of bads) {
      await expect(attempt(() => h.bookingAdmin.setPrices(e, bad)), JSON.stringify(bad)).rejects.toBeInstanceOf(RangeError);
    }
    await expect(attempt(() => h.bookingAdmin.setPrices('bad id', { R: 1 }))).rejects.toBeInstanceOf(RangeError);
    expect(await h.priceRows(e)).toEqual(second);
    expect(await h.priceRows('bad id')).toEqual([]);
  });
});

// ───────────────────────── 주문 만들기(§13 동작 1, FR-011) ─────────────────────────

describe('주문 만들기 POST /v0/orders', () => {
  test('FR011_자기홀드로주문을만들면201과주문모양이고_금액은서버가등급가격을더한값이며_주문행과좌석행과이력CREATED가생기고좌석은홀드그대로다', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['oc1']);
    const headers = fanHeaders('oc1');
    const seats = ['S-2', 'R-1', 'R-3'];
    const holdId = await h.holdOk(e, seats, headers);
    const t0 = h.clock.now();
    const calls = h.pgCalls.length;
    const r = await h.createOrder(holdId, headers);
    expect({ status: r.status, contentType: r.contentType }, r.raw).toEqual({ status: 201, contentType: JSON_CONTENT_TYPE });
    expect(Object.keys(r.body).sort()).toEqual(ORDER_KEYS);
    const amount = PRICES.S! + 2 * PRICES.R!;
    expect(amount).toBe(h.amountOf(e, seats));
    expect(r.body).toMatchObject({ eventId: e, holdId, status: 'CREATED', amount, orderName: orderNameOf(e, 3), createdAt: refKst(t0), tickets: [] });
    expect(r.body.orderId).toMatch(UUID_PATTERN);
    expect(sorted(r.body.seatIds)).toEqual(sorted(seats));
    const orderId = r.body.orderId as string;

    const row = await h.orderRow(orderId);
    expect(row).toEqual({ orderId, eventId: e, accountId: acc('oc1'), holdId, seatIds: expect.any(Array), amount, orderName: orderNameOf(e, 3), status: 'CREATED', createdAtMs: t0 });
    expect(sorted(row!.seatIds)).toEqual(sorted(seats));
    const items = await h.orderItems(orderId);
    expect(items.map((i) => i.lineNo)).toEqual([1, 2, 3]);
    expect(items.map((i) => ({ seatId: i.seatId, grade: i.grade, price: i.price, ticketId: i.ticketId })).sort((a, b) => cmp(a.seatId, b.seatId))).toEqual(
      sorted(seats).map((seatId) => ({ seatId, grade: h.gradeOf(e, seatId), price: PRICES[h.gradeOf(e, seatId)], ticketId: null })),
    );
    expect(await h.orderEvents(orderId)).toEqual([{ seq: 1, toStatus: 'CREATED', reason: expect.any(String), occurredAtMs: t0 }]);

    // 좌석은 아직 홀드 그대로다. 결제·티켓·결제사 호출이 없다
    await expectHeld(e, seats, holdId);
    expect((await h.holdRow(holdId))?.status).toBe('HELD');
    expect(await h.quota(e, acc('oc1'))).toEqual({ held: 3, sold: 0 });
    expect(await h.paymentRows(orderId)).toEqual([]);
    expect(await h.ticketRows({ orderId })).toEqual([]);
    expect(h.pgCalls.length).toBe(calls);
  });

  test('FR011_주문본문에금액이나허용밖칸이있거나holdId가UUID가아니면400이고_아무것도만들지않는다 [ASVS v5.0.0-2.2.1]', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['ob1']);
    const headers = fanHeaders('ob1');
    const holdId = await h.holdOk(e, ['R-1'], headers);
    const before = await h.snapshot(e);
    const bodies: [string, unknown][] = [
      ['금액을 함께 보냄(금액은 서버가 정한다)', { holdId, amount: 1 }],
      ['허용 밖 칸', { holdId, eventId: e }],
      ['빈 객체', {}],
      ['UUID 아님', { holdId: 'not-a-uuid' }],
      ['UUID 뒤 공백', { holdId: `${holdId} ` }],
      ['UUID 한 자 모자람', { holdId: holdId.slice(0, -1) }],
      ['숫자', { holdId: 123 }],
      ['null', { holdId: null }],
      ['배열 본문', [holdId]],
      ['SQL 조각', { holdId: "' or '1'='1" }],
    ];
    for (const [label, body] of bodies) expectStatus(await h.http('POST', '/v0/orders', headers, body), 400, label);
    expectStatus(await h.http('POST', '/v0/orders', headers, undefined, 'not json'), 400, 'JSON 아님');
    expectStatus(await h.http('POST', '/v0/orders', headers, undefined, `{"holdId":"${holdId}"`), 400, '끊긴 JSON');
    expect(await h.snapshot(e)).toEqual(before);
    expect(before.orders).toEqual([]);
    // 맞는 본문은 받는다
    expect((await h.createOrder(holdId, headers)).status).toBe(201);
  });

  test('FR011_남의홀드와없는홀드로는같은404홀드없음이고_주문을만들지않으며그홀드는그대로다 [ASVS v5.0.0-8.2.2]', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['owner1', 'thief1']);
    const holdId = await h.holdOk(e, ['R-1', 'R-2'], fanHeaders('owner1'));
    const before = await h.snapshot(e);
    const foreign = await h.createOrder(holdId, fanHeaders('thief1'));
    const missing = await h.createOrder(randomUUID(), fanHeaders('thief1'));
    expectProblem(foreign, 404, 'hold-not-found');
    expectProblem(missing, 404, 'hold-not-found');
    expect(problemShape(foreign)).toEqual(problemShape(missing));
    expect(await h.snapshot(e)).toEqual(before);
    expect(before.orders).toEqual([]);
  });

  test('FR011_POL012_놓은홀드와만료된홀드와만료시각이지난홀드로는409홀드끝남이고_주문을만들지않는다', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['he1', 'he2', 'he3']);
    const released = await h.holdOk(e, ['R-1'], fanHeaders('he1'));
    const expired = await h.holdOk(e, ['R-2'], fanHeaders('he2'));
    const lapsed = await h.holdOk(e, ['R-3'], fanHeaders('he3'));
    expect((await h.release(released, fanHeaders('he1'))).status).toBe(204);
    expectProblem(await h.createOrder(released, fanHeaders('he1')), 409, 'hold-expired');

    h.clock.advance(TTL_MS + 1_000);
    // 만료 루프가 아직 돌지 않아 HELD로 남았어도 만료 시각이 지났으면 끝난 홀드다
    expect((await h.holdRow(lapsed))?.status).toBe('HELD');
    expectProblem(await h.createOrder(lapsed, fanHeaders('he3')), 409, 'hold-expired');
    await h.seatAdmin.expire(h.clock.now());
    expect((await h.holdRow(expired))?.status).toBe('EXPIRED');
    expectProblem(await h.createOrder(expired, fanHeaders('he2')), 409, 'hold-expired');
    expect(await h.ordersOf(e)).toEqual([]);
  });

  test('FR011_같은홀드로두번째주문은409주문있음이고_같은홀드로동시에두번만들어도주문은하나다 [ASVS v5.0.0-2.3.4]', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['dup1']);
    const headers = fanHeaders('dup1');
    const first = await h.holdOk(e, ['R-1'], headers);
    const o1 = await h.createOrderOk(first, headers);
    expectProblem(await h.createOrder(first, headers), 409, 'order-already-exists');
    // 같은 계정의 다른 탭(세션)에서도 같다
    expectProblem(await h.createOrder(first, fanHeaders('dup1', { session: 'ses-dup1-tab2' })), 409, 'order-already-exists');

    const second = await h.holdOk(e, ['S-1', 'S-2'], headers);
    const rs = await Promise.all([h.createOrder(second, headers), h.createOrder(second, fanHeaders('dup1', { session: 'ses-dup1-tab3' }))]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expectProblem(rs.find((r) => r.status === 409)!, 409, 'order-already-exists');
    const orders = await h.ordersOf(e);
    expect(orders.map((o) => o.holdId).sort(cmp)).toEqual([first, second].sort(cmp));
    for (const o of orders) {
      expect((await h.orderItems(o.orderId)).length).toBe(o.seatIds.length);
      expect(await h.orderTrail(o.orderId)).toEqual([[1, 'CREATED']]);
    }
    expect(orders.find((o) => o.holdId === first)?.orderId).toBe(o1.orderId);
  });

  test('FR011_좌석등급의가격이없으면409가격없음이고_주문을만들지않으며가격을넣은뒤에는만든다', async () => {
    const e = await h.openSaleEvent({ prices: { R: 50_000 } });
    const noPrices = await h.openSaleEvent({ prices: null });
    await h.admit(e, ['np1']);
    await h.admit(noPrices, ['np1']);
    const headers = fanHeaders('np1');
    const sOnly = await h.holdOk(e, ['S-1'], headers);
    const mixed = await h.holdOk(e, ['R-1', 'S-2'], headers);
    const none = await h.holdOk(noPrices, ['R-1'], headers);
    expectProblem(await h.createOrder(sOnly, headers), 409, 'prices-not-set');
    expectProblem(await h.createOrder(mixed, headers), 409, 'prices-not-set');
    expectProblem(await h.createOrder(none, headers), 409, 'prices-not-set');
    expect(await h.ordersOf(e)).toEqual([]);
    expect(await h.ordersOf(noPrices)).toEqual([]);
    await h.bookingAdmin.setPrices(e, { S: 30_000 });
    const r = await h.createOrder(mixed, headers);
    expect(r.status, r.raw).toBe(201);
    expect(r.body.amount).toBe(80_000);
  });
});

// ───────────────────────── 권한(§13 '동작': 팬·ticket:buy·pid) ─────────────────────────

describe('주문 경로의 권한', () => {
  const withoutPid = (pid: string): Headers => {
    const x = fanHeaders(pid);
    delete x['x-user-pid'];
    return x;
  };

  test('FR011_신원머리가없거나팬대상이아니면세경로모두401이고_ticketbuy스코프나pid가없으면403이며_아무것도바꾸지않는다 [ASVS v5.0.0-8.2.1]', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['az1']);
    const prep = await h.prepareOrder(e, 'az1', ['R-1']);
    const spare = await h.holdOk(e, ['R-2'], prep.headers);
    const before = await h.snapshot(e);
    const calls = h.pgCalls.length;
    const routes = (headers: Headers) => [
      ['주문 만들기', () => h.createOrder(spare, headers)],
      ['주문 보기', () => h.viewOrder(prep.order.orderId, headers)],
      ['결제 확정', () => h.pay(prep.order.orderId, { paymentKey: prep.paymentKey, amount: prep.order.amount }, headers)],
    ] as const;
    const cases: [string, Headers, number][] = [
      ['신원 머리 없음', {}, 401],
      ['세션 없음', { 'x-user-id': acc('az1'), 'x-user-aud': 'fan', 'x-user-scope': 'ticket:buy', 'x-user-pid': 'az1' }, 401],
      ['스캐너 대상', { ...fanHeaders('az1'), 'x-user-aud': 'scanner' }, 401],
      ['파트너 대상', { ...fanHeaders('az1'), 'x-user-aud': 'partner' }, 401],
      ['관제 대상', { ...fanHeaders('az1'), 'x-user-aud': 'ops' }, 401],
      ['ticket:buy 없음', fanHeaders('az1', { scope: 'ticket:read' }), 403],
      ['pid 없음', withoutPid('az1'), 403],
    ];
    for (const [label, headers, status] of cases) {
      for (const [route, call] of routes(headers)) expectStatus(await call(), status, `${label} ${route}`);
    }
    expect(await h.snapshot(e)).toEqual(before);
    expect(h.pgCalls.length).toBe(calls);
  });
});

// ───────────────────────── 결제 확정(§13 동작 2, 동기 결제 체인) ─────────────────────────

describe('결제 확정 POST /v0/orders/{orderId}/payment', () => {
  test('FR011_FR012_K7_결제사가승인하면200CONFIRMED이고_좌석SOLD와홀드SOLD와판수와결제행APPROVED와좌석마다티켓과빈틈없는이력이남으며변경분SOLD가나간다 [ASVS v5.0.0-2.3.1]', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['pay1', 'viewer1']);
    const ws = await h.openDeltas(e, fanHeaders('viewer1'));
    const seats = ['R-2', 'S-1'];
    const prep = await h.prepareOrder(e, 'pay1', seats);
    const amount = PRICES.R! + PRICES.S!;
    expect(prep.order.amount).toBe(amount);
    h.clock.advance(5_000);
    const t1 = h.clock.now();
    const from = feed.inbox.raw.length;
    const wsFrom = ws.inbox.raw.length;

    const r = await h.pay(prep.order.orderId, { paymentKey: prep.paymentKey, amount }, prep.headers);
    expect({ status: r.status, contentType: r.contentType }, r.raw).toEqual({ status: 200, contentType: JSON_CONTENT_TYPE });
    const body = r.body as OrderBody;
    expect(Object.keys(body).sort()).toEqual(ORDER_KEYS);
    expect({ ...body, seatIds: sorted(body.seatIds), tickets: [] }).toEqual({ ...prep.order, seatIds: sorted(prep.order.seatIds), status: 'CONFIRMED', tickets: [] });
    expect(body.tickets).toHaveLength(2);
    for (const t of body.tickets) {
      expect(Object.keys(t).sort()).toEqual(['code', 'seatId', 'ticketId']);
      expect(t.ticketId).toMatch(UUID_PATTERN);
      expect(t.code).toMatch(TICKET_CODE_SHAPE);
    }
    expect(sorted(body.tickets.map((t) => t.seatId))).toEqual(sorted(seats));
    expect(new Set(body.tickets.map((t) => t.code)).size).toBe(2);
    expect(r.raw).not.toContain(prep.paymentKey);

    const orderId = prep.order.orderId;
    // 주문과 이력: CREATED → PAYING → APPROVED → CONFIRMED, 1부터 빈틈 없는 번호
    expect((await h.orderRow(orderId))?.status).toBe('CONFIRMED');
    const events = await h.orderEvents(orderId);
    expect(events.map((x) => [x.seq, x.toStatus])).toEqual([
      [1, 'CREATED'],
      [2, 'PAYING'],
      [3, 'APPROVED'],
      [4, 'CONFIRMED'],
    ]);
    expect(events.slice(1).map((x) => x.occurredAtMs)).toEqual([t1, t1, t1]);
    // 주문 좌석에 티켓 ID를 적는다
    const items = await h.orderItems(orderId);
    expect(items.map((i) => [i.seatId, i.ticketId]).sort((a, b) => cmp(a[0]!, b[0]!))).toEqual(sortTickets(body.tickets).map((t) => [t.seatId, t.ticketId]));
    // 좌석·홀드·보유 수(판 좌석은 held에서 sold로)
    await expectSold(e, seats, orderId);
    expect((await h.holdRow(prep.holdId))?.status).toBe('SOLD');
    expect(await h.quota(e, acc('pay1'))).toEqual({ held: 0, sold: 2 });
    // 결제 행: 결제사가 준 승인 시각
    const approvals = await h.approvalsOf(orderId);
    expect(approvals).toEqual([
      { kind: 'pg_charge', pg: 'SIMULATOR', payment_ref: prep.paymentKey, order_ref: orderId, amount, status: 'DONE', approved_at: refKst(t1), canceled_amount: 0 },
    ]);
    expect(await h.paymentRows(orderId)).toEqual([
      {
        paymentId: expect.stringMatching(UUID_PATTERN),
        orderId,
        eventId: e,
        pg: 'SIMULATOR',
        paymentKey: prep.paymentKey,
        amount,
        status: 'APPROVED',
        failure: null,
        approvedAtMs: Date.parse(approvals[0]!.approved_at!),
        createdAtMs: t1,
      },
    ]);
    // 티켓: 좌석마다 하나, 그 주문의 계정, 아직 입장 전
    expect(await h.ticketRows({ orderId })).toEqual(
      sortTickets(body.tickets).map((t) => ({
        ticketId: t.ticketId,
        orderId,
        eventId: e,
        seatId: t.seatId,
        accountId: acc('pay1'),
        code: t.code,
        status: 'ISSUED',
        issuedAtMs: t1,
        enteredAtMs: null,
        enteredBy: null,
      })),
    );
    // 결제사: 승인 멱등키 confirm-{주문 ID}로 한 번만 불렀다
    expect(h.pgCallsOf(orderId, prep.paymentKey)).toEqual([{ method: 'POST', path: '/v1/payments/confirm', idempotencyKey: `confirm-${orderId}` }]);
    // 변경분 SOLD: 서비스가 낸 알림(LISTEN)과 그 회차 WebSocket 연결 모두
    const cs = await waitChanges(feed.inbox, e, from, (x) => hasAll(x, seats, 'SOLD'), '변경분 SOLD');
    // 결제 확정 동안 이 회차에 나간 변경분은 판 좌석마다 SOLD 하나다(AVAILABLE로 되돌리는 변경분이 없다)
    expect([...cs].sort((a, b) => cmp(a.seatId, b.seatId))).toEqual(sorted(seats).map((seatId) => ({ seatId, status: 'SOLD', atMs: t1 })));
    await waitUntil(() => hasAll(changesFor(ws.inbox, e, wsFrom), seats, 'SOLD'), 5_000, 'WebSocket 변경분 SOLD');
  });

  test('PT7_결제확정금액이주문금액과다르면400금액다름이고_주문좌석홀드보유수가그대로이며결제행도결제사호출도변경분도없다 [ASVS v5.0.0-2.2.1]', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['pt7', 'pt7-other']);
    const prep = await h.prepareOrder(e, 'pt7', ['R-1', 'S-1']);
    const orderId = prep.order.orderId;
    const amount = prep.order.amount;
    // 변조한 금액으로 결제창 인증을 받은 결제 참조(공격자가 결제창 금액을 바꾼 경우)
    const forged = await h.authenticate(orderId, 1, prep.order.orderName);
    const before = await h.snapshot(e);
    const from = feed.inbox.raw.length;
    const tries: [string, number][] = [
      [prep.paymentKey, amount + 1],
      [prep.paymentKey, amount - 1],
      [prep.paymentKey, 1],
      [prep.paymentKey, 100_000_000],
      [prep.paymentKey, 100_000_001],
      [prep.paymentKey, Number.MAX_SAFE_INTEGER],
      [forged, 1],
    ];
    for (const [paymentKey, a] of tries) {
      const r = await h.pay(orderId, { paymentKey, amount: a }, prep.headers);
      expectProblem(r, 400, 'amount-mismatch');
      expect(r.raw).not.toContain(paymentKey);
    }
    expect(await h.snapshot(e)).toEqual(before);
    expect((await h.orderRow(orderId))?.status).toBe('CREATED');
    expect(await h.paymentRows(orderId)).toEqual([]);
    expect(h.pgCallsOf(orderId, prep.paymentKey)).toEqual([]);
    expect(h.pgCallsOf(orderId, forged)).toEqual([]);
    expect(await h.approvalsOf(orderId)).toEqual([]);
    // 변경분 없음: 뒤에 낸 표지(다른 분의 홀드)보다 앞에 SOLD가 없다(알림은 커밋 순서로 온다)
    await h.holdOk(e, ['R-4'], fanHeaders('pt7-other'));
    const cs = await waitChanges(feed.inbox, e, from, (x) => hasAll(x, ['R-4'], 'HELD'), '표지 변경분');
    expect(cs.filter((c) => c.status === 'SOLD')).toEqual([]);
    // 맞는 금액은 그대로 받는다(막힌 시도가 주문을 망가뜨리지 않았다)
    const ok = await h.pay(orderId, { paymentKey: prep.paymentKey, amount }, prep.headers);
    expect(ok.status, ok.raw).toBe(200);
  });

  test('PT2_POL013_결제사가승인을거절하면422결제거절이고_좌석이빈좌석으로돌아오고홀드RELEASED와판수원복이며과금0건이고변경분AVAILABLE이나간다 [ASVS v5.0.0-2.3.1]', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['pt2']);
    const seats = ['R-1', 'S-3'];
    // 같은 계정이 먼저 한 좌석을 샀다. 판매 되돌리기가 두 번 일어나면 이 판 수까지 줄어 드러난다
    const kept = await h.buy(e, 'pt2', ['S-4']);
    // 여러 거절 코드. 거절마다 좌석이 돌아오므로 같은 좌석을 다시 잡아 다음 코드를 본다
    for (const code of ['REJECT_CARD_COMPANY', 'EXCEED_MAX_DAILY_PAYMENT_COUNT', 'NOT_AVAILABLE_PAYMENT', 'REJECT_CARD_PAYMENT']) {
      const prep = await h.prepareOrder(e, 'pt2', seats);
      const orderId = prep.order.orderId;
      await h.addFault({ op: 'confirm', kind: 'decline', code, orderId });
      h.clock.advance(1_000);
      const t = h.clock.now();
      const from = feed.inbox.raw.length;
      const r = await h.pay(orderId, { paymentKey: prep.paymentKey, amount: prep.order.amount }, prep.headers);
      expectProblem(r, 422, 'payment-declined');
      expect(r.raw).not.toContain(prep.paymentKey);
      await expectReturnedAfterPayment({
        eventId: e,
        orderId,
        holdId: prep.holdId,
        seatIds: seats,
        paymentKey: prep.paymentKey,
        amount: prep.order.amount,
        atMs: t,
        failureHas: ['DECLINED', code],
      });
      // 판 수는 먼저 산 한 좌석만 남는다(되돌리기는 한 번)
      expect(await h.quota(e, acc('pt2')), code).toEqual({ held: 0, sold: 1 });
      await expectSold(e, ['S-4'], kept.order.orderId);
      // 과금 0건: 결제사 원장에 승인이 없다. 승인 호출은 한 번, 다시 묻지 않는다
      expect(await h.approvalsOf(orderId)).toEqual([]);
      expect(h.pgCallsOf(orderId, prep.paymentKey)).toEqual([{ method: 'POST', path: '/v1/payments/confirm', idempotencyKey: `confirm-${orderId}` }]);
      // 변경분: SOLD 뒤에 AVAILABLE
      const cs = await waitChanges(feed.inbox, e, from, (x) => hasAll(x, seats, 'SOLD') && hasAll(x, seats, 'AVAILABLE'), `${code} 변경분`);
      const lastSold = Math.max(...cs.map((c, i) => (c.status === 'SOLD' ? i : -1)));
      const firstAvailable = cs.findIndex((c) => c.status === 'AVAILABLE');
      expect(lastSold, `${code}: AVAILABLE이 SOLD 뒤에 와야 한다 ${JSON.stringify(cs)}`).toBeLessThan(firstAvailable);
      // 주문 보기도 실패로 끝난 주문이다
      const view = await h.viewOrder(orderId, prep.headers);
      expect(view.status).toBe(200);
      expect(view.body).toMatchObject({ orderId, status: 'FAILED', tickets: [] });
    }
  });

  test('K7_승인응답을잃으면502결제실패로끝내고좌석을돌려주지만_결제사원장에는승인1건이남고결제사에다시묻지않는다', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['k7a']);
    const seats = ['R-1', 'R-2'];
    const prep = await h.prepareOrder(e, 'k7a', seats);
    const orderId = prep.order.orderId;
    await h.addFault({ op: 'confirm', kind: 'drop', applied: true, orderId });
    const t = h.clock.now();
    const r = await h.pay(orderId, { paymentKey: prep.paymentKey, amount: prep.order.amount }, prep.headers);
    expectProblem(r, 502, 'payment-failed');
    expect(r.raw).not.toContain(prep.paymentKey);
    await expectReturnedAfterPayment({ eventId: e, orderId, holdId: prep.holdId, seatIds: seats, paymentKey: prep.paymentKey, amount: prep.order.amount, atMs: t, failureHas: ['UNKNOWN'] });
    expect(await h.quota(e, acc('k7a'))).toEqual({ held: 0, sold: 0 });
    // 결제사에서는 승인됐다(v0의 한계). v0는 결과 모름을 조회하지 않고, 다시 보내지도 않는다
    expect(await h.approvalsOf(orderId)).toEqual([expect.objectContaining({ order_ref: orderId, payment_ref: prep.paymentKey, amount: prep.order.amount, status: 'DONE', canceled_amount: 0 })]);
    await sleep(300);
    expect(h.pgCallsOf(orderId, prep.paymentKey)).toEqual([{ method: 'POST', path: '/v1/payments/confirm', idempotencyKey: `confirm-${orderId}` }]);
    expect(h.queryCalls().filter((c) => c.path.includes(orderId) || c.path.includes(prep.paymentKey))).toEqual([]);
  });

  test('K7_결제사5xx와처리중응답도502결제실패이고좌석을돌려준다_5xx전에승인됐으면결제사원장에만승인이남는다', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['k7b']);
    const seats = ['S-1'];
    const cases: [string, Record<string, unknown>, number, string][] = [
      ['5xx(승인 뒤)', { kind: 'pg-error', applied: true }, 1, 'UNKNOWN'],
      ['5xx(승인 전)', { kind: 'pg-error', applied: false }, 0, 'UNKNOWN'],
      ['처리 중', { kind: 'in-progress' }, 0, 'IN_PROGRESS'],
      ['응답 유실(승인 전)', { kind: 'drop', applied: false }, 0, 'UNKNOWN'],
    ];
    for (const [label, fault, approvals, outcome] of cases) {
      const prep = await h.prepareOrder(e, 'k7b', seats);
      const orderId = prep.order.orderId;
      await h.addFault({ op: 'confirm', orderId, ...fault });
      const t = h.clock.now();
      const r = await h.pay(orderId, { paymentKey: prep.paymentKey, amount: prep.order.amount }, prep.headers);
      expectProblem(r, 502, 'payment-failed');
      await expectReturnedAfterPayment({
        eventId: e,
        orderId,
        holdId: prep.holdId,
        seatIds: seats,
        paymentKey: prep.paymentKey,
        amount: prep.order.amount,
        atMs: t,
        failureHas: [outcome],
      });
      expect((await h.approvalsOf(orderId)).length, label).toBe(approvals);
      expect(h.confirmCallsOf(orderId).length, label).toBe(1);
      expect(h.queryCalls().filter((c) => c.path.includes(orderId) || c.path.includes(prep.paymentKey)), label).toEqual([]);
      expect(await h.quota(e, acc('k7b')), label).toEqual({ held: 0, sold: 0 });
    }
  });

  test('PT23_같은주문을두탭에서동시에확정하면하나만200이고나머지는409결제불가이며_결제사승인호출은1번이다 [ASVS v5.0.0-2.3.4]', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['pt23']);
    for (const seat of ['R-1', 'R-2', 'R-3']) {
      const prep = await h.prepareOrder(e, 'pt23', [seat]);
      const orderId = prep.order.orderId;
      const body = { paymentKey: prep.paymentKey, amount: prep.order.amount };
      const rs = await Promise.all([h.pay(orderId, body, prep.headers), h.pay(orderId, body, fanHeaders('pt23', { session: `ses-pt23-${seat}` }))]);
      expect(rs.map((r) => r.status).sort(), rs.map((r) => r.raw).join(' | ')).toEqual([200, 409]);
      expectProblem(rs.find((r) => r.status === 409)!, 409, 'order-not-payable');
      expect((await h.orderRow(orderId))?.status).toBe('CONFIRMED');
      expect((await h.orderTrail(orderId)).map(([, s]) => s)).toEqual(['CREATED', 'PAYING', 'APPROVED', 'CONFIRMED']);
      expect(h.confirmCallsOf(orderId)).toHaveLength(1);
      expect(await h.approvalsOf(orderId)).toHaveLength(1);
      expect(await h.paymentRows(orderId)).toHaveLength(1);
      expect(await h.ticketRows({ orderId })).toHaveLength(1);
      await expectSold(e, [seat], orderId);
    }
    expect(await h.quota(e, acc('pt23'))).toEqual({ held: 0, sold: 3 });
  });

  test('PT23_FR011_이미CONFIRMED나FAILED인주문을다시확정하면409결제불가이고_결제사를다시부르지않으며아무것도바꾸지않는다 [ASVS v5.0.0-2.3.1]', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['again1']);
    const bought = await h.buy(e, 'again1', ['R-1']);
    const declined = await h.prepareOrder(e, 'again1', ['S-1']);
    await h.addFault({ op: 'confirm', kind: 'decline', code: 'REJECT_CARD_COMPANY', orderId: declined.order.orderId });
    expectProblem(await h.pay(declined.order.orderId, { paymentKey: declined.paymentKey, amount: declined.order.amount }, declined.headers), 422, 'payment-declined');
    await h.clearFaults();
    // 실패한 주문으로 결제창 인증을 다시 받아도(시뮬레이터는 승인 전 주문 ID를 다시 받는다) 주문은 결제할 수 없다
    const retryKey = await h.authenticate(declined.order.orderId, declined.order.amount, declined.order.orderName);
    const before = await h.snapshot(e);
    const callsBefore = h.pgCalls.length;
    expectProblem(await h.pay(bought.order.orderId, { paymentKey: bought.paymentKey, amount: bought.order.amount }, bought.headers), 409, 'order-not-payable');
    expectProblem(await h.pay(declined.order.orderId, { paymentKey: retryKey, amount: declined.order.amount }, declined.headers), 409, 'order-not-payable');
    expect(await h.snapshot(e)).toEqual(before);
    expect(h.pgCalls.length).toBe(callsBefore);
    expect(await h.approvalsOf(declined.order.orderId)).toEqual([]);
  });

  test('POL012_홀드가만료된뒤의결제확정은409홀드끝남이고주문은FAILED이며_결제사를부르지않아과금이없고결제행도없다_그사이남이잡은좌석은그대로다 [ASVS v5.0.0-2.3.1]', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['ex1', 'ex2']);
    // ① 만료 루프가 홀드를 푼 뒤, 다른 분이 같은 좌석을 잡았다
    const a = await h.prepareOrder(e, 'ex1', ['R-1', 'R-2']);
    // ② 만료 시각은 지났지만 만료 루프가 아직 돌지 않았다
    const b = await h.prepareOrder(e, 'ex1', ['S-1']);
    h.clock.advance(TTL_MS + 1_000);
    expect((await h.holdRow(b.holdId))?.status).toBe('HELD');
    const callsBefore = h.pgCalls.length;

    const rb = await h.pay(b.order.orderId, { paymentKey: b.paymentKey, amount: b.order.amount }, b.headers);
    expectProblem(rb, 409, 'hold-expired');
    expect((await h.orderRow(b.order.orderId))?.status).toBe('FAILED');
    expect(await h.orderTrail(b.order.orderId)).toEqual([
      [1, 'CREATED'],
      [2, 'PAYING'],
      [3, 'FAILED'],
    ]);
    expect(await h.paymentRows(b.order.orderId)).toEqual([]);
    expect((await seatsOf(e, ['S-1']))[0]?.status).not.toBe('SOLD');

    await h.seatAdmin.expire(h.clock.now());
    expect((await h.holdRow(a.holdId))?.status).toBe('EXPIRED');
    const other = await h.holdOk(e, ['R-1'], fanHeaders('ex2'));
    const ra = await h.pay(a.order.orderId, { paymentKey: a.paymentKey, amount: a.order.amount }, a.headers);
    expectProblem(ra, 409, 'hold-expired');
    expect((await h.orderRow(a.order.orderId))?.status).toBe('FAILED');
    expect(await h.paymentRows(a.order.orderId)).toEqual([]);
    await expectHeld(e, ['R-1'], other);
    await expectAvailable(e, ['R-2', 'S-1']);
    expect(await h.quota(e, acc('ex1'))).toEqual({ held: 0, sold: 0 });
    expect(await h.quota(e, acc('ex2'))).toEqual({ held: 1, sold: 0 });
    // 결제사를 부르지 않았다(과금 0)
    expect(h.pgCalls.length).toBe(callsBefore);
    expect(await h.approvalsOf(a.order.orderId)).toEqual([]);
    expect(await h.approvalsOf(b.order.orderId)).toEqual([]);
    expect(await h.ticketRows({ eventId: e })).toEqual([]);
  });

  test('POL012_판매로바꾸는것은만료시각전일때만이라_연장한홀드는원래만료가지나도늘어난만료전이면결제가확정된다', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['ext1']);
    const prep = await h.prepareOrder(e, 'ext1', ['R-1']);
    const ext = await h.extend(prep.holdId, prep.headers);
    expect(ext.status, ext.raw).toBe(200);
    h.clock.advance(TTL_MS + EXTEND_MS - 1_000);
    const r = await h.pay(prep.order.orderId, { paymentKey: prep.paymentKey, amount: prep.order.amount }, prep.headers);
    expect(r.status, r.raw).toBe(200);
    expect(r.body.status).toBe('CONFIRMED');
    await expectSold(e, ['R-1'], prep.order.orderId);
  });

  test('POL011_판좌석도1인한도에세어_한도4에서2석을산뒤3석홀드는422한도초과이고2석은201이다 [ASVS v5.0.0-2.3.4]', async () => {
    const e = await h.openSaleEvent({ limit: 4 });
    await h.admit(e, ['lim1', 'lim2']);
    await h.buy(e, 'lim1', ['R-1', 'R-2']);
    expect(await h.quota(e, acc('lim1'))).toEqual({ held: 0, sold: 2 });
    const before = await h.snapshot(e);
    expectProblem(await h.hold(e, ['R-3', 'R-4', 'S-1'], fanHeaders('lim1')), 422, 'purchase-limit-exceeded');
    expect(await h.snapshot(e)).toEqual(before);
    const ok = await h.hold(e, ['R-3', 'R-4'], fanHeaders('lim1'));
    expect(ok.status, ok.raw).toBe(201);
    expect(await h.quota(e, acc('lim1'))).toEqual({ held: 2, sold: 2 });
    expectProblem(await h.hold(e, ['S-1'], fanHeaders('lim1')), 422, 'purchase-limit-exceeded');
    // 다른 계정의 한도는 따로 센다
    expect((await h.hold(e, ['S-1', 'S-2', 'S-3', 'S-4'], fanHeaders('lim2'))).status).toBe(201);
  });

  test('POL011_POL013_결제가거절되면판수가원래대로돌아와_한도만큼다시잡을수있다 [ASVS v5.0.0-2.3.4]', async () => {
    const e = await h.openSaleEvent({ limit: 2 });
    await h.admit(e, ['lim3']);
    const prep = await h.prepareOrder(e, 'lim3', ['R-1', 'R-2']);
    await h.addFault({ op: 'confirm', kind: 'decline', code: 'REJECT_CARD_COMPANY', orderId: prep.order.orderId });
    expectProblem(await h.pay(prep.order.orderId, { paymentKey: prep.paymentKey, amount: prep.order.amount }, prep.headers), 422, 'payment-declined');
    expect(await h.quota(e, acc('lim3'))).toEqual({ held: 0, sold: 0 });
    const again = await h.hold(e, ['R-1', 'S-1'], fanHeaders('lim3'));
    expect(again.status, again.raw).toBe(201);
    expectProblem(await h.hold(e, ['S-2'], fanHeaders('lim3')), 422, 'purchase-limit-exceeded');
  });

  test('FR011_결제확정본문의결제참조나금액형식이틀리거나허용밖칸이있으면400이고_아무것도바꾸지않으며결제사를부르지않는다 [ASVS v5.0.0-2.2.1]', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['pb1']);
    const prep = await h.prepareOrder(e, 'pb1', ['R-1']);
    const { paymentKey } = prep;
    const amount = prep.order.amount;
    const orderId = prep.order.orderId;
    const before = await h.snapshot(e);
    const callsBefore = h.pgCalls.length;
    const bodies: [string, unknown][] = [
      ['결제 참조 빈 값', { paymentKey: '', amount }],
      ['결제 참조 201자', { paymentKey: 'a'.repeat(201), amount }],
      ['결제 참조 공백', { paymentKey: 'tsim a', amount }],
      ['결제 참조 탭', { paymentKey: 'tsim\ta', amount }],
      ['결제 참조 줄바꿈', { paymentKey: `${paymentKey}\n`, amount }],
      ['결제 참조 비ASCII', { paymentKey: '결제참조', amount }],
      ['결제 참조 앞 공백', { paymentKey: ` ${paymentKey}`, amount }],
      ['결제 참조 DEL(0x7f)', { paymentKey: `${paymentKey}\u007f`, amount }],
      ['결제 참조 NUL', { paymentKey: `${paymentKey}\u0000`, amount }],
      ['결제 참조 숫자', { paymentKey: 123, amount }],
      ['결제 참조 null', { paymentKey: null, amount }],
      ['결제 참조 없음', { amount }],
      ['금액 없음', { paymentKey }],
      ['금액 0', { paymentKey, amount: 0 }],
      ['금액 -0.5', { paymentKey, amount: -0.5 }],
      ['금액 음수', { paymentKey, amount: -amount }],
      ['금액 -1', { paymentKey, amount: -1 }],
      ['금액 소수', { paymentKey, amount: amount + 0.5 }],
      ['금액 2^53(안전한 정수 밖)', { paymentKey, amount: 2 ** 53 }],
      ['금액 글', { paymentKey, amount: String(amount) }],
      ['금액 참', { paymentKey, amount: true }],
      ['금액 null', { paymentKey, amount: null }],
      ['허용 밖 칸', { paymentKey, amount, orderId }],
      ['배열 본문', [paymentKey, amount]],
    ];
    for (const [label, body] of bodies) {
      const r = await h.pay(orderId, body, prep.headers);
      expectStatus(r, 400, label);
      expect(r.raw, `${label}: 오류 문구에 결제 참조`).not.toContain(paymentKey);
    }
    expectStatus(await h.http('POST', `/v0/orders/${orderId}/payment`, prep.headers, undefined, 'not json'), 400, 'JSON 아님');
    expectStatus(await h.pay('not-a-uuid', { paymentKey, amount }, prep.headers), 400, '주문 ID가 UUID 아님');
    expectStatus(await h.pay(`${orderId.slice(0, -1)}z`, { paymentKey, amount }, prep.headers), 400, '주문 ID 끝이 16진수 아님');
    // 형식 경계 안(1자·200자·출력 가능한 ASCII 전부)은 본문 검사를 지나 ①에 닿는다: 금액만 틀려 이름 있는 400 금액 다름이다
    const printable = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) => String.fromCharCode(0x21 + i)).join('');
    for (const [label, key] of [
      ['결제 참조 1자', '!'],
      ['결제 참조 200자', '~'.repeat(200)],
      ['출력 가능한 ASCII 전부', printable],
    ] as const) {
      const r = await h.pay(orderId, { paymentKey: key, amount: amount + 1 }, prep.headers);
      expectProblem(r, 400, 'amount-mismatch');
      // 1자 참조는 아무 글에나 들어 있을 수 있어 긴 것만 본다
      if (key.length > 1) expect(r.raw, `${label}: 오류 문구에 결제 참조`).not.toContain(key);
    }
    expect(await h.snapshot(e)).toEqual(before);
    expect(h.pgCalls.length).toBe(callsBefore);
    expect((await h.pay(orderId, { paymentKey, amount }, prep.headers)).status).toBe(200);
  });

  test('FR011_결제참조는본문으로만받아_쿼리에만있으면400이고결제하지않는다 [ASVS v5.0.0-14.2.1]', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['pq1']);
    const prep = await h.prepareOrder(e, 'pq1', ['S-1']);
    const orderId = prep.order.orderId;
    const qs = `paymentKey=${encodeURIComponent(prep.paymentKey)}&amount=${prep.order.amount}`;
    const before = await h.snapshot(e);
    const callsBefore = h.pgCalls.length;
    const withEmptyBody = await h.http('POST', `/v0/orders/${orderId}/payment?${qs}`, prep.headers, {});
    expectStatus(withEmptyBody, 400, '쿼리 + 빈 본문');
    const noBody = await h.http('POST', `/v0/orders/${orderId}/payment?${qs}`, prep.headers);
    expect(noBody.status, noBody.raw).toBeGreaterThanOrEqual(400);
    expect(noBody.status, noBody.raw).toBeLessThan(500);
    expect(await h.snapshot(e)).toEqual(before);
    expect(h.pgCalls.length).toBe(callsBefore);
    expect((await h.orderRow(orderId))?.status).toBe('CREATED');
  });

  test('FR011_남의주문과없는주문의결제확정은같은404주문없음이고_그주문과좌석은그대로이며결제사를부르지않는다 [ASVS v5.0.0-8.2.2]', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['own2', 'oth2']);
    const prep = await h.prepareOrder(e, 'own2', ['R-1']);
    const before = await h.snapshot(e);
    const callsBefore = h.pgCalls.length;
    const body = { paymentKey: prep.paymentKey, amount: prep.order.amount };
    const foreign = await h.pay(prep.order.orderId, body, fanHeaders('oth2'));
    const missing = await h.pay(randomUUID(), body, fanHeaders('oth2'));
    expectProblem(foreign, 404, 'order-not-found');
    expectProblem(missing, 404, 'order-not-found');
    expect(problemShape(foreign)).toEqual(problemShape(missing));
    expect(foreign.raw).not.toContain(prep.paymentKey);
    expect(await h.snapshot(e)).toEqual(before);
    expect(h.pgCalls.length).toBe(callsBefore);
  });

  test('FR011_PT7_결제확정①은주문없음404다음결제불가409다음금액다름400순서라_남의주문이나끝난주문에틀린금액을보내도앞의오류이고아무것도바꾸지않는다 [ASVS v5.0.0-2.3.1]', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['ord1', 'ord2']);
    const mine = await h.prepareOrder(e, 'ord1', ['R-1']);
    const done = await h.buy(e, 'ord1', ['R-2']);
    const failed = await h.prepareOrder(e, 'ord1', ['S-1']);
    await h.addFault({ op: 'confirm', kind: 'decline', code: 'REJECT_CARD_COMPANY', orderId: failed.order.orderId });
    expectProblem(await h.pay(failed.order.orderId, { paymentKey: failed.paymentKey, amount: failed.order.amount }, failed.headers), 422, 'payment-declined');
    await h.clearFaults();
    const before = await h.snapshot(e);
    const calls = h.pgCalls.length;
    // 남의 주문·없는 주문은 금액이 틀려도 404(금액 비교로 그 주문이 있는지 드러내지 않는다)
    const foreign = await h.pay(mine.order.orderId, { paymentKey: mine.paymentKey, amount: mine.order.amount + 1 }, fanHeaders('ord2'));
    const missing = await h.pay(randomUUID(), { paymentKey: mine.paymentKey, amount: 1 }, mine.headers);
    expectProblem(foreign, 404, 'order-not-found');
    expectProblem(missing, 404, 'order-not-found');
    expect(problemShape(foreign)).toEqual(problemShape(missing));
    // CONFIRMED·FAILED 주문은 금액이 틀려도 409
    expectProblem(await h.pay(done.order.orderId, { paymentKey: done.paymentKey, amount: done.order.amount + 1 }, done.headers), 409, 'order-not-payable');
    expectProblem(await h.pay(failed.order.orderId, { paymentKey: failed.paymentKey, amount: 1 }, failed.headers), 409, 'order-not-payable');
    // 자기 CREATED 주문에 틀린 금액이면 그때 400
    expectProblem(await h.pay(mine.order.orderId, { paymentKey: mine.paymentKey, amount: mine.order.amount + 1 }, mine.headers), 400, 'amount-mismatch');
    expect(await h.snapshot(e)).toEqual(before);
    expect(h.pgCalls.length).toBe(calls);
  });

  test('FR011_결제확정중주문행이나홀드행이잠겨있으면429서버바쁨이고_②에서끊기면주문을CREATED로되돌리며결제사를부르지않고_잠금이풀린뒤다시확정하면200이다 [ASVS v5.0.0-2.3.3]', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['busy1']);
    const seats = ['R-1', 'S-1'];
    const prep = await h.prepareOrder(e, 'busy1', seats);
    const orderId = prep.order.orderId;
    const body = { paymentKey: prep.paymentKey, amount: prep.order.amount };
    const calls = h.pgCalls.length;
    const before = await h.snapshot(e);

    // ① 주문 행이 잠겨 있으면 ①에서 끊기고(문장 시간 상한 1초) 아무것도 바꾸지 않는다
    let unlock = await h.lockRows('select 1 from v0_order where order_id = $1 for update', [orderId]);
    let r = await h.pay(orderId, body, prep.headers);
    await unlock();
    expectProblem(r, 429, 'server-busy');
    expect(r.headers['retry-after']).toBe('1');
    expect(await h.snapshot(e)).toEqual(before);

    // ② 홀드 행이 잠겨 있으면 ①은 지나 PAYING이 되었다가 ②에서 끊기고, 주문을 CREATED로 되돌린다(좌석은 홀드 그대로)
    unlock = await h.lockRows('select 1 from v0_hold where hold_id = $1 for update', [prep.holdId]);
    r = await h.pay(orderId, body, prep.headers);
    await unlock();
    expectProblem(r, 429, 'server-busy');
    expect(r.headers['retry-after']).toBe('1');
    expect(r.raw).not.toContain(prep.paymentKey);
    expect((await h.orderRow(orderId))?.status).toBe('CREATED');
    expect(await h.orderTrail(orderId)).toEqual([
      [1, 'CREATED'],
      [2, 'PAYING'],
      [3, 'CREATED'],
    ]);
    await expectHeld(e, seats, prep.holdId);
    expect((await h.holdRow(prep.holdId))?.status).toBe('HELD');
    expect(await h.quota(e, acc('busy1'))).toEqual({ held: 2, sold: 0 });
    expect(await h.paymentRows(orderId)).toEqual([]);
    expect(await h.ticketRows({ orderId })).toEqual([]);
    // 결제사를 부르지 않았다(과금 없음)
    expect(h.pgCalls.length).toBe(calls);
    expect(await h.approvalsOf(orderId)).toEqual([]);

    // 다시 확정하면 지나가고, 이력은 빈틈 없이 이어진다
    const ok = await h.pay(orderId, body, prep.headers);
    expect(ok.status, ok.raw).toBe(200);
    expect(await h.orderTrail(orderId)).toEqual([
      [1, 'CREATED'],
      [2, 'PAYING'],
      [3, 'CREATED'],
      [4, 'PAYING'],
      [5, 'APPROVED'],
      [6, 'CONFIRMED'],
    ]);
    await expectSold(e, seats, orderId);
    expect(h.confirmCallsOf(orderId)).toHaveLength(1);
  });

  test('K7_결제사가승인이라고답해도승인금액이주문금액과다르거나없거나입금대기면502결제실패이고좌석을돌려준다_결제행은FAILED이고결제사에다시묻지않는다 [ASVS v5.0.0-2.3.1]', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['amt1']);
    const seats = ['R-3', 'S-2'];
    // 서비스가 받는 승인 응답만 바꾼다. 시뮬레이터는 주문 금액을 실제로 승인했다(그래서 원장에는 승인이 남는다)
    const cases: [string, (j: Record<string, unknown>) => Record<string, unknown>][] = [
      ['승인 금액 1원 적음', (j) => ({ ...j, totalAmount: (j.totalAmount as number) - 1 })],
      ['승인 금액 1원 많음', (j) => ({ ...j, totalAmount: (j.totalAmount as number) + 1 })],
      ['승인 금액 없음', (j) => Object.fromEntries(Object.entries(j).filter(([k]) => k !== 'totalAmount'))],
      ['입금 대기', (j) => ({ ...j, status: 'WAITING_FOR_DEPOSIT', approvedAt: null })],
    ];
    for (const [label, rewrite] of cases) {
      const prep = await h.prepareOrder(e, 'amt1', seats);
      const orderId = prep.order.orderId;
      h.tamperConfirm(orderId, ({ status, json }) => ({ status, json: rewrite(json ?? {}) }));
      const t = h.clock.now();
      const r = await h.pay(orderId, { paymentKey: prep.paymentKey, amount: prep.order.amount }, prep.headers);
      expectProblem(r, 502, 'payment-failed');
      expect(r.raw, label).not.toContain(prep.paymentKey);
      await expectReturnedAfterPayment({ eventId: e, orderId, holdId: prep.holdId, seatIds: seats, paymentKey: prep.paymentKey, amount: prep.order.amount, atMs: t });
      expect(await h.quota(e, acc('amt1')), label).toEqual({ held: 0, sold: 0 });
      expect(await h.approvalsOf(orderId), label).toEqual([expect.objectContaining({ order_ref: orderId, payment_ref: prep.paymentKey, amount: prep.order.amount, status: 'DONE' })]);
      expect(h.confirmCallsOf(orderId), label).toHaveLength(1);
      expect(h.queryCalls().filter((c) => c.path.includes(prep.paymentKey) || c.path.includes(orderId)), label).toEqual([]);
      await h.clearFaults();
    }
  });

  test('FR011_K7_결제사가이미승인된결제라고답하고조회금액이같으면ALREADY_APPROVED로승인과같이200CONFIRMED이고_결제행승인시각은결제사가준시각이다 [ASVS v5.0.0-2.3.1]', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['aa1']);
    const seats = ['S-2', 'R-4'];
    const prep = await h.prepareOrder(e, 'aa1', seats);
    const orderId = prep.order.orderId;
    const amount = prep.order.amount;
    // 서비스 밖에서(다른 멱등키로) 결제사가 먼저 승인했다
    const t0 = h.clock.now();
    const direct = await h.approveDirectly({ paymentKey: prep.paymentKey, orderId, amount });
    expect(direct.approvedAt).toBe(refKst(t0));
    h.clock.advance(45_000);
    const t1 = h.clock.now();

    const r = await h.pay(orderId, { paymentKey: prep.paymentKey, amount }, prep.headers);
    expect({ status: r.status, contentType: r.contentType }, r.raw).toEqual({ status: 200, contentType: JSON_CONTENT_TYPE });
    expect(r.body).toMatchObject({ orderId, status: 'CONFIRMED' });
    expect(sorted((r.body as OrderBody).tickets.map((t) => t.seatId))).toEqual(sorted(seats));
    expect(await h.orderTrail(orderId)).toEqual([
      [1, 'CREATED'],
      [2, 'PAYING'],
      [3, 'APPROVED'],
      [4, 'CONFIRMED'],
    ]);
    // 결제 행의 승인 시각은 결제사가 준 시각(먼저 승인한 t0)이고, 결제 행을 만든 시각(t1)이 아니다
    expect(await h.paymentRows(orderId)).toEqual([
      {
        paymentId: expect.stringMatching(UUID_PATTERN),
        orderId,
        eventId: e,
        pg: 'SIMULATOR',
        paymentKey: prep.paymentKey,
        amount,
        status: 'APPROVED',
        failure: null,
        approvedAtMs: t0,
        createdAtMs: t1,
      },
    ]);
    await expectSold(e, seats, orderId);
    expect(await h.ticketRows({ orderId })).toHaveLength(2);
    // 결제사 원장의 승인은 먼저 한 그 한 건이다(두 번 과금하지 않았다)
    expect(await h.approvalsOf(orderId)).toEqual([expect.objectContaining({ payment_ref: prep.paymentKey, amount, status: 'DONE', approved_at: refKst(t0) })]);
    expect(h.confirmCallsOf(orderId)).toHaveLength(1);
  });

  test('K7_결제사응답이요청의남은시간안에오지않으면결과모름으로502이고좌석을돌려준다_결제사는뒤늦게승인하고v0는다시묻지않는다', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['to1']);
    const seats = ['R-2'];
    const prep = await h.prepareOrder(e, 'to1', seats);
    const orderId = prep.order.orderId;
    // 결제사가 1.5초 뒤에 처리한다. 요청의 남은 시간은 0.3초다(게이트웨이가 넘기는 x-peaket-deadline-ms)
    await h.addFault({ op: 'confirm', kind: 'delay', ms: 1_500, orderId });
    const t = h.clock.now();
    const started = Date.now();
    const r = await h.pay(orderId, { paymentKey: prep.paymentKey, amount: prep.order.amount }, { ...prep.headers, 'x-peaket-deadline-ms': '300' });
    const took = Date.now() - started;
    expectProblem(r, 502, 'payment-failed');
    // 결제사 응답(1.5초 뒤)까지 기다리지 않았다
    expect(took, '결제사 응답을 요청의 남은 시간보다 오래 기다렸다').toBeLessThan(1_500);
    expect(r.raw).not.toContain(prep.paymentKey);
    await expectReturnedAfterPayment({ eventId: e, orderId, holdId: prep.holdId, seatIds: seats, paymentKey: prep.paymentKey, amount: prep.order.amount, atMs: t, failureHas: ['UNKNOWN'] });
    // 결제사는 지연 뒤 승인한다(K7의 v0 한계). v0는 조회하지 않고 다시 보내지도 않는다
    await waitUntil(async () => (await h.approvalsOf(orderId)).length === 1, 5_000, '시뮬레이터의 늦은 승인');
    await sleep(200);
    expect(h.confirmCallsOf(orderId)).toHaveLength(1);
    expect(h.queryCalls().filter((c) => c.path.includes(orderId) || c.path.includes(prep.paymentKey))).toEqual([]);
    expect((await h.paymentRows(orderId)).map((p) => [p.status, p.approvedAtMs])).toEqual([['FAILED', null]]);
    expect((await h.orderRow(orderId))?.status).toBe('FAILED');
  });

  test('FR012_K7_승인뒤발권이실패하면500이고주문은APPROVED에남는다_좌석SOLD와결제행APPROVED와결제사승인은남고티켓은없으며다시확정해도409다 [ASVS v5.0.0-2.3.3]', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['tf1']);
    const seats = ['R-1', 'R-2'];
    const prep = await h.prepareOrder(e, 'tf1', seats);
    const orderId = prep.order.orderId;
    const amount = prep.order.amount;
    const logFrom = h.logLines.length;
    const unblock = await h.blockTicketsFor(e);
    let r;
    try {
      r = await h.pay(orderId, { paymentKey: prep.paymentKey, amount }, prep.headers);
    } finally {
      await unblock();
    }
    expectStatus(r, 500, '발권 실패');
    expect(r.raw).not.toContain(prep.paymentKey);
    // 주문은 APPROVED에 남는다(다시 발권하는 장치가 없다)
    expect((await h.orderRow(orderId))?.status).toBe('APPROVED');
    expect(await h.orderTrail(orderId)).toEqual([
      [1, 'CREATED'],
      [2, 'PAYING'],
      [3, 'APPROVED'],
    ]);
    await expectSold(e, seats, orderId);
    expect((await h.holdRow(prep.holdId))?.status).toBe('SOLD');
    expect(await h.quota(e, acc('tf1'))).toEqual({ held: 0, sold: 2 });
    expect(await h.paymentRows(orderId)).toEqual([expect.objectContaining({ orderId, status: 'APPROVED', amount, failure: null })]);
    expect(await h.approvalsOf(orderId)).toHaveLength(1);
    expect(await h.ticketRows({ orderId })).toEqual([]);
    expect((await h.orderItems(orderId)).map((i) => i.ticketId)).toEqual([null, null]);
    // 막은 것을 풀어도 그대로이고, 다시 확정하면 409이며 결제사를 다시 부르지 않는다
    const calls = h.pgCalls.length;
    expectProblem(await h.pay(orderId, { paymentKey: prep.paymentKey, amount }, prep.headers), 409, 'order-not-payable');
    expect(h.pgCalls.length).toBe(calls);
    expect((await h.viewOrder(orderId, prep.headers)).body).toMatchObject({ orderId, status: 'APPROVED', tickets: [] });
    expect(await h.ticketRows({ orderId })).toEqual([]);
    await sleep(50);
    for (const secret of [prep.paymentKey, h.simKey]) expect(h.logText(logFrom), '서비스 로그에 비밀').not.toContain(secret);
  });

  test('POL012_만료시각과정확히같은때는끝난홀드라_주문만들기와결제확정모두409홀드끝남이고결제사를부르지않으며_1ms전에는주문을만든다', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['edge1']);
    const headers = fanHeaders('edge1');
    // 같은 시각에 잡은 세 홀드(만료 시각이 같다)
    const early = await h.holdOk(e, ['R-1'], headers);
    const late = await h.holdOk(e, ['R-2'], headers);
    const paid = await h.prepareOrder(e, 'edge1', ['S-1']);
    const { expiresAtMs } = (await h.holdRow(late))!;
    expect((await h.holdRow(early))!.expiresAtMs).toBe(expiresAtMs);
    expect((await h.holdRow(paid.holdId))!.expiresAtMs).toBe(expiresAtMs);

    h.clock.advance(expiresAtMs - 1 - h.clock.now());
    const r1 = await h.createOrder(early, headers);
    expect(r1.status, `만료 1ms 전 주문: ${r1.raw}`).toBe(201);

    h.clock.advance(1);
    expect(h.clock.now()).toBe(expiresAtMs);
    expect(await h.seatSales.holdForOrder(late, acc('edge1'), expiresAtMs)).toEqual({ kind: 'hold-expired' });
    expectProblem(await h.createOrder(late, headers), 409, 'hold-expired');
    const calls = h.pgCalls.length;
    for (const [orderId, holdId, paymentKey, amount] of [
      [paid.order.orderId, paid.holdId, paid.paymentKey, paid.order.amount],
      [(r1.body as OrderBody).orderId, early, await h.authenticate((r1.body as OrderBody).orderId, (r1.body as OrderBody).amount), (r1.body as OrderBody).amount],
    ] as const) {
      expectProblem(await h.pay(orderId, { paymentKey, amount }, headers), 409, 'hold-expired');
      expect((await h.orderRow(orderId))?.status).toBe('FAILED');
      expect(await h.paymentRows(orderId)).toEqual([]);
      expect((await h.holdRow(holdId))?.status).not.toBe('SOLD');
    }
    expect(h.pgCalls.length).toBe(calls);
    expect(await h.ticketRows({ eventId: e })).toEqual([]);
    expect(await h.quota(e, acc('edge1'))).toMatchObject({ sold: 0 });
  });

  test('FR011_가격경계1원과1억원좌석의주문도서버가금액을정확히더하고_결제사승인금액과결제행금액이같으며확정된다 [ASVS v5.0.0-2.2.1]', async () => {
    const e = await h.openSaleEvent({ prices: { R: 100_000_000, S: 1 } });
    await h.admit(e, ['big1', 'one1']);
    for (const [pid, seats, amount] of [
      ['big1', ['R-1', 'R-2', 'R-3', 'S-1'], 300_000_001],
      ['one1', ['S-2'], 1],
    ] as const) {
      const bought = await h.buy(e, pid, [...seats]);
      expect(bought.order.amount, pid).toBe(amount);
      expect(bought.paid.status, pid).toBe('CONFIRMED');
      expect((await h.orderRow(bought.order.orderId))?.amount, pid).toBe(amount);
      expect((await h.orderItems(bought.order.orderId)).map((i) => i.price).reduce((a, b) => a + b, 0), pid).toBe(amount);
      expect((await h.paymentRows(bought.order.orderId)).map((p) => [p.status, p.amount]), pid).toEqual([['APPROVED', amount]]);
      expect((await h.approvalsOf(bought.order.orderId)).map((a) => a.amount), pid).toEqual([amount]);
    }
  });

  test('FR011_POL012_판홀드와결제실패로돌려준홀드로는다시주문을만들수없어409홀드끝남이고_주문이늘지않는다', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['re1']);
    const bought = await h.buy(e, 're1', ['R-1']);
    const declined = await h.prepareOrder(e, 're1', ['S-1']);
    await h.addFault({ op: 'confirm', kind: 'decline', code: 'REJECT_CARD_COMPANY', orderId: declined.order.orderId });
    expectProblem(await h.pay(declined.order.orderId, { paymentKey: declined.paymentKey, amount: declined.order.amount }, declined.headers), 422, 'payment-declined');
    const before = await h.snapshot(e);
    expectProblem(await h.createOrder(bought.holdId, bought.headers), 409, 'hold-expired');
    expectProblem(await h.createOrder(declined.holdId, declined.headers), 409, 'hold-expired');
    expect(await h.snapshot(e)).toEqual(before);
  });
});

// ───────────────────────── 결제 공개 함수(§13 동작 2 ③) ─────────────────────────

describe('결제 공개 함수 createPayments', () => {
  test('FR011_결제공개함수는주문하나에결제행하나라_같은주문으로다시부르거나동시에부르면already-exists이고결제사승인호출은1번이다 [ASVS v5.0.0-2.3.4]', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['pf1']);
    const payments = createPayments(h.database, createV0PaymentGateway({ baseUrl: h.simUrl, secretKey: h.simKey }));
    // 차례로 두 번
    const a = await h.prepareOrder(e, 'pf1', ['R-1']);
    const now = h.clock.now();
    const req = { orderId: a.order.orderId, eventId: e, paymentKey: a.paymentKey, amount: a.order.amount, nowMs: now };
    const first = await payments.confirm(req);
    expect(first).toEqual({ kind: 'approved', paymentId: expect.stringMatching(UUID_PATTERN), approvedAtMs: now });
    const rows = await h.paymentRows(a.order.orderId);
    expect(rows).toEqual([
      {
        paymentId: first.kind === 'approved' ? first.paymentId : '',
        orderId: a.order.orderId,
        eventId: e,
        pg: 'SIMULATOR',
        paymentKey: a.paymentKey,
        amount: a.order.amount,
        status: 'APPROVED',
        failure: null,
        approvedAtMs: now,
        createdAtMs: now,
      },
    ]);
    const calls = h.pgCalls.length;
    expect(await payments.confirm(req)).toEqual({ kind: 'already-exists' });
    expect(await payments.confirm({ ...req, paymentKey: 'tsim_other', amount: 1 })).toEqual({ kind: 'already-exists' });
    expect(h.pgCalls.length).toBe(calls);
    expect(await h.paymentRows(a.order.orderId)).toEqual(rows);

    // 동시에 두 번: 결제 행 하나, 결제사 승인 호출 하나
    const b = await h.prepareOrder(e, 'pf1', ['R-2']);
    const reqB = { orderId: b.order.orderId, eventId: e, paymentKey: b.paymentKey, amount: b.order.amount, nowMs: now };
    const rs = await Promise.all([payments.confirm(reqB), payments.confirm(reqB)]);
    expect(rs.map((x) => x.kind).sort(), JSON.stringify(rs)).toEqual(['already-exists', 'approved']);
    expect(await h.paymentRows(b.order.orderId)).toHaveLength(1);
    expect(h.confirmCallsOf(b.order.orderId)).toHaveLength(1);
    expect(await h.approvalsOf(b.order.orderId)).toHaveLength(1);
  });
});

// ───────────────────────── 주문 보기(§13 동작 3) ─────────────────────────

describe('주문 보기 GET /v0/orders/{orderId}', () => {
  test('FR011_FR012_자기주문을보면1의모양이고_확정뒤에는좌석마다티켓ID와좌석과코드가실리며_같은계정의다른탭도본다 [ASVS v5.0.0-8.2.2]', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['vw1']);
    const prep = await h.prepareOrder(e, 'vw1', ['R-1', 'R-2', 'S-4']);
    const before = await h.viewOrder(prep.order.orderId, prep.headers);
    expect({ status: before.status, contentType: before.contentType }, before.raw).toEqual({ status: 200, contentType: JSON_CONTENT_TYPE });
    expect({ ...before.body, seatIds: sorted(before.body.seatIds) }).toEqual({ ...prep.order, seatIds: sorted(prep.order.seatIds) });

    const paid = await h.pay(prep.order.orderId, { paymentKey: prep.paymentKey, amount: prep.order.amount }, prep.headers);
    expect(paid.status, paid.raw).toBe(200);
    for (const headers of [prep.headers, fanHeaders('vw1', { session: 'ses-vw1-other-tab' })]) {
      const after = await h.viewOrder(prep.order.orderId, headers);
      expect(after.status, after.raw).toBe(200);
      const body = after.body as OrderBody;
      expect(Object.keys(body).sort()).toEqual(ORDER_KEYS);
      expect({ ...body, seatIds: sorted(body.seatIds), tickets: sortTickets(body.tickets) }).toEqual({
        ...(paid.body as OrderBody),
        seatIds: sorted((paid.body as OrderBody).seatIds),
        tickets: sortTickets((paid.body as OrderBody).tickets),
      });
      expect(body.status).toBe('CONFIRMED');
      expect(sortTickets(body.tickets)).toEqual(
        (await h.ticketRows({ orderId: prep.order.orderId })).map((t) => ({ ticketId: t.ticketId, seatId: t.seatId, code: t.code })),
      );
    }
  });

  test('FR011_남의주문과없는주문은같은404주문없음이고_티켓코드와결제참조를싣지않는다 [ASVS v5.0.0-8.2.2] [ASVS v5.0.0-14.1.1]', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['vw2', 'vw3']);
    const bought = await h.buy(e, 'vw2', ['S-1', 'S-2']);
    const foreign = await h.viewOrder(bought.order.orderId, fanHeaders('vw3'));
    const missing = await h.viewOrder(randomUUID(), fanHeaders('vw3'));
    expectProblem(foreign, 404, 'order-not-found');
    expectProblem(missing, 404, 'order-not-found');
    expect(problemShape(foreign)).toEqual(problemShape(missing));
    for (const secret of [...bought.paid.tickets.map((t) => t.code), ...bought.paid.tickets.map((t) => t.ticketId), bought.paymentKey, acc('vw2')]) {
      expect(foreign.raw).not.toContain(secret);
    }
  });

  test('FR011_주문ID가UUID꼴이아니면주문보기가400이다 [ASVS v5.0.0-2.2.1]', async () => {
    for (const bad of ['not-a-uuid', '1234', 'x'.repeat(36), "1' or '1'='1"]) {
      expectStatus(await h.viewOrder(encodeURIComponent(bad), fanHeaders('vw4')), 400, bad);
    }
  });
});

// ───────────────────────── 좌석 판매 공개 함수(seat-hold §14 동작 9) ─────────────────────────

describe('좌석 판매 공개 함수 createSeatSales', () => {
  test('POL011_홀드읽기는아무것도바꾸지않고_자기HELD홀드의회차와좌석과등급과만료시각만주며_남의것없는것끝난것은구별해답한다', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['ss1', 'ss2']);
    const holdId = await h.holdOk(e, ['S-2', 'R-1'], fanHeaders('ss1'));
    const row = (await h.holdRow(holdId))!;
    const before = await h.snapshot(e);
    const now = h.clock.now();
    expect(await h.seatSales.holdForOrder(holdId, acc('ss1'), now)).toEqual({
      kind: 'ok',
      hold: {
        holdId,
        eventId: e,
        accountId: acc('ss1'),
        // 좌석은 홀드에 적힌 순서다
        seats: row.seatIds.map((seatId) => ({ seatId, grade: h.gradeOf(e, seatId) })),
        expiresAtMs: row.expiresAtMs,
      },
    });
    expect(row.seatIds).toEqual(['S-2', 'R-1']);
    expect(await h.seatSales.holdForOrder(holdId, acc('ss2'), now)).toEqual({ kind: 'hold-not-found' });
    expect(await h.seatSales.holdForOrder(randomUUID(), acc('ss1'), now)).toEqual({ kind: 'hold-not-found' });
    expect(await h.seatSales.holdForOrder(holdId, acc('ss1'), row.expiresAtMs + 1)).toEqual({ kind: 'hold-expired' });
    // 경계: 만료 시각과 같으면 끝났고(좌석 v0의 만료·연장과 같은 기준), 1ms 전이면 살아 있다
    expect(await h.seatSales.holdForOrder(holdId, acc('ss1'), row.expiresAtMs)).toEqual({ kind: 'hold-expired' });
    expect((await h.seatSales.holdForOrder(holdId, acc('ss1'), row.expiresAtMs - 1)).kind).toBe('ok');
    expect(await h.snapshot(e)).toEqual(before);
    expect((await h.release(holdId, fanHeaders('ss1'))).status).toBe(204);
    expect(await h.seatSales.holdForOrder(holdId, acc('ss1'), now)).toEqual({ kind: 'hold-expired' });
  });

  test('POL011_판매로바꾸기는자기살아있는홀드만팔고_남의홀드와없는홀드는홀드없음이며만료시각이된홀드는홀드끝남이고아무것도바꾸지않는다 [ASVS v5.0.0-2.3.4]', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['ss3', 'ss4']);
    const seats = ['R-1', 'S-1'];
    const holdId = await h.holdOk(e, seats, fanHeaders('ss3'));
    const { expiresAtMs } = (await h.holdRow(holdId))!;
    const orderId = randomUUID();
    const before = await h.snapshot(e);
    const from = feed.inbox.raw.length;
    expect(await h.seatSales.sell(holdId, acc('ss4'), orderId, h.clock.now())).toEqual({ kind: 'hold-not-found' });
    expect(await h.seatSales.sell(randomUUID(), acc('ss3'), orderId, h.clock.now())).toEqual({ kind: 'hold-not-found' });
    // '만료 시각 전일 때만' 판다: 만료 시각과 같으면 끝난 홀드다
    expect(await h.seatSales.sell(holdId, acc('ss3'), orderId, expiresAtMs)).toEqual({ kind: 'hold-expired' });
    expect(await h.snapshot(e)).toEqual(before);

    const sold = await h.seatSales.sell(holdId, acc('ss3'), orderId, expiresAtMs - 1);
    expect(sold.kind).toBe('sold');
    expect(sold.kind === 'sold' ? { eventId: sold.eventId, seatIds: sorted(sold.seatIds) } : undefined).toEqual({ eventId: e, seatIds: sorted(seats) });
    await expectSold(e, seats, orderId);
    expect((await h.holdRow(holdId))?.status).toBe('SOLD');
    expect(await h.quota(e, acc('ss3'))).toEqual({ held: 0, sold: 2 });
    const cs = await waitChanges(feed.inbox, e, from, (x) => hasAll(x, seats, 'SOLD'), '변경분 SOLD');
    expect(cs.filter((c) => c.status === 'SOLD').map((c) => c.atMs)).toEqual(seats.map(() => expiresAtMs - 1));

    // 이미 판 홀드는 다시 팔지 않는다(다른 주문 ID로도)
    const afterSale = await h.snapshot(e);
    // 판 홀드는 그 계정의 것이고 이미 끝났으므로 '홀드 끝남'이다(seat-hold §14 동작 9 ①)
    expect(await h.seatSales.sell(holdId, acc('ss3'), randomUUID(), expiresAtMs - 1)).toEqual({ kind: 'hold-expired' });
    expect(await h.seatSales.sell(holdId, acc('ss4'), randomUUID(), expiresAtMs - 1)).toEqual({ kind: 'hold-not-found' });
    expect(await h.snapshot(e)).toEqual(afterSale);
  });

  test('POL011_같은홀드를동시에두번팔아도한번만팔고_판수는한번만는다 [ASVS v5.0.0-2.3.4]', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['ss5']);
    const seats = ['R-2', 'R-3'];
    const holdId = await h.holdOk(e, seats, fanHeaders('ss5'));
    const o1 = randomUUID();
    const o2 = randomUUID();
    const now = h.clock.now();
    const rs = await Promise.all([h.seatSales.sell(holdId, acc('ss5'), o1, now), h.seatSales.sell(holdId, acc('ss5'), o2, now)]);
    const winners = rs.filter((r) => r.kind === 'sold');
    expect(winners, JSON.stringify(rs)).toHaveLength(1);
    // 진 쪽은 잠금을 기다린 뒤 이미 판 홀드를 본다
    expect(rs.find((r) => r.kind !== 'sold'), JSON.stringify(rs)).toEqual({ kind: 'hold-expired' });
    const winner = rs[0]!.kind === 'sold' ? o1 : o2;
    await expectSold(e, seats, winner);
    expect((await h.holdRow(holdId))?.status).toBe('SOLD');
    expect(await h.quota(e, acc('ss5'))).toEqual({ held: 0, sold: 2 });
  });

  test('POL011_판매되돌리기는그주문으로판좌석만한번되돌리고_다른주문ID로는되돌리지않으며판수가음수가되지않는다 [ASVS v5.0.0-2.3.4]', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['ss6', 'ss7']);
    const seats = ['S-3', 'S-4'];
    // 같은 계정이 다른 홀드로 먼저 두 좌석을 팔았다. 되돌리기가 두 번 일어나면(0 아래로 막아 두어도) 이 판 수까지 줄어 드러난다
    const otherHold = await h.holdOk(e, ['R-1', 'R-2'], fanHeaders('ss6'));
    const otherOrder = randomUUID();
    expect((await h.seatSales.sell(otherHold, acc('ss6'), otherOrder, h.clock.now())).kind).toBe('sold');
    const holdId = await h.holdOk(e, seats, fanHeaders('ss6'));
    const orderId = randomUUID();
    expect((await h.seatSales.sell(holdId, acc('ss6'), orderId, h.clock.now())).kind).toBe('sold');
    expect(await h.quota(e, acc('ss6'))).toEqual({ held: 0, sold: 4 });
    const sold = await h.snapshot(e);
    expect(await h.seatSales.unsell(holdId, randomUUID(), h.clock.now())).toEqual({ kind: 'not-sold' });
    expect(await h.snapshot(e)).toEqual(sold);

    const from = feed.inbox.raw.length;
    const back = await h.seatSales.unsell(holdId, orderId, h.clock.now());
    expect(back.kind).toBe('returned');
    expect(back.kind === 'returned' ? sorted(back.seatIds) : []).toEqual(sorted(seats));
    await expectAvailable(e, seats);
    expect((await h.holdRow(holdId))?.status).toBe('RELEASED');
    expect(await h.quota(e, acc('ss6'))).toEqual({ held: 0, sold: 2 });
    // 다른 홀드로 판 좌석은 그대로다
    await expectSold(e, ['R-1', 'R-2'], otherOrder);
    expect((await h.holdRow(otherHold))?.status).toBe('SOLD');
    await waitChanges(feed.inbox, e, from, (x) => hasAll(x, seats, 'AVAILABLE'), '변경분 AVAILABLE');

    // 두 번째는 되돌리지 않는다: 판 수가 그대로이고 변경분이 더 없다(표지 홀드보다 앞에 AVAILABLE이 한 번뿐)
    const afterUnsell = await h.snapshot(e);
    expect(await h.seatSales.unsell(holdId, orderId, h.clock.now())).toEqual({ kind: 'not-sold' });
    expect(await h.snapshot(e)).toEqual(afterUnsell);
    // 다른 홀드를 이 주문 ID로 되돌려도 되돌리지 않는다(그 홀드는 다른 주문으로 팔렸다)
    expect(await h.seatSales.unsell(otherHold, orderId, h.clock.now())).toEqual({ kind: 'not-sold' });
    expect(await h.snapshot(e)).toEqual(afterUnsell);
    await h.holdOk(e, ['R-4'], fanHeaders('ss7'));
    const cs = await waitChanges(feed.inbox, e, from, (x) => hasAll(x, ['R-4'], 'HELD'), '표지 변경분');
    expect(cs.filter((c) => c.status === 'AVAILABLE' && seats.includes(c.seatId))).toHaveLength(seats.length);
  });

  test('POL012_판홀드는만료가건드리지않는다_만료시각이한참지나도좌석과홀드와판수와주문이그대로다', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['ss8']);
    const bought = await h.buy(e, 'ss8', ['R-1', 'S-1']);
    const before = await h.snapshot(e);
    const from = feed.inbox.raw.length;
    h.clock.advance(3 * (TTL_MS + EXTEND_MS));
    await h.seatAdmin.expire(h.clock.now());
    expect(await h.snapshot(e)).toEqual(before);
    expect((await h.holdRow(bought.holdId))?.status).toBe('SOLD');
    expect((await h.orderRow(bought.order.orderId))?.status).toBe('CONFIRMED');
    expect(changesFor(feed.inbox, e, from).filter((c) => c.status === 'AVAILABLE')).toEqual([]);
  });
});

// ───────────────────────── 저장과 비밀([ASVS v5.0.0-14.1.1]·[ASVS v5.0.0-16.2.5]) ─────────────────────────

describe('저장과 비밀', () => {
  test('FR011_FR012_주문결제티켓표의칸은정본표와같고_사람값은계정ID뿐이라pid와세션ID와카드정보가없다 [ASVS v5.0.0-14.1.1]', async () => {
    const cols = await h.inspect.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public' and table_name in ('v0_price', 'v0_order', 'v0_order_item', 'v0_order_event', 'v0_payment', 'v0_ticket', 'v0_gate_staff')`,
    );
    const tables: Record<string, string[]> = {};
    for (const c of cols.rows) (tables[c.table_name] ??= []).push(c.column_name);
    for (const t of Object.keys(tables)) tables[t]!.sort(cmp);
    const s = (xs: string[]) => [...xs].sort(cmp);
    expect(tables).toEqual({
      v0_price: s(['event_id', 'grade', 'price']),
      v0_order: s(['order_id', 'event_id', 'account_id', 'hold_id', 'seat_ids', 'amount', 'order_name', 'status', 'created_at']),
      v0_order_item: s(['order_id', 'line_no', 'seat_id', 'grade', 'price', 'ticket_id']),
      v0_order_event: s(['order_id', 'seq', 'to_status', 'reason', 'occurred_at']),
      v0_payment: s(['payment_id', 'order_id', 'event_id', 'pg', 'payment_key', 'amount', 'status', 'failure', 'approved_at', 'created_at']),
      v0_ticket: s(['ticket_id', 'order_id', 'event_id', 'seat_id', 'account_id', 'code', 'status', 'issued_at', 'entered_at', 'entered_by']),
      v0_gate_staff: s(['event_id', 'account_id']),
    });

    const e = await h.openSaleEvent();
    const pid = 'pii-pid-7f3a';
    const session = 'pii-session-91c2';
    await h.admit(e, [pid]);
    const bought = await h.buy(e, pid, ['R-1', 'R-2'], { session });
    const dump = JSON.stringify(await h.snapshot(e));
    expect(dump).toContain(acc(pid));
    for (const secret of [`"${pid}"`, session]) expect(dump, `표에 ${secret}`).not.toContain(secret);
    // 카드 정보(결제사 응답의 가린 카드 번호·승인 번호)는 저장하지 않는다
    const payments = JSON.stringify(await h.paymentRows(bought.order.orderId));
    expect(payments).not.toContain('43301234');
    expect(payments).not.toContain('카드');
  });

  test('FR011_K7_응답과오류문구와서비스로그에결제참조와시험키와티켓코드와DB주소가실리지않는다 [ASVS v5.0.0-16.2.5]', async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['sec1', 'sec2']);
    const logFrom = h.logLines.length;
    const raws: string[] = [];
    const secrets: string[] = [h.simKey, Buffer.from(`${h.simKey}:`).toString('base64'), h.databaseUrl];
    // 성공
    const ok = await h.buy(e, 'sec1', ['R-1']);
    raws.push(JSON.stringify(ok.paid));
    secrets.push(ok.paymentKey);
    // 거절
    const d = await h.prepareOrder(e, 'sec1', ['S-1']);
    await h.addFault({ op: 'confirm', kind: 'decline', code: 'REJECT_CARD_COMPANY', orderId: d.order.orderId });
    raws.push((await h.pay(d.order.orderId, { paymentKey: d.paymentKey, amount: d.order.amount }, d.headers)).raw);
    secrets.push(d.paymentKey);
    // 응답 유실
    const l = await h.prepareOrder(e, 'sec1', ['S-2']);
    await h.addFault({ op: 'confirm', kind: 'drop', applied: true, orderId: l.order.orderId });
    raws.push((await h.pay(l.order.orderId, { paymentKey: l.paymentKey, amount: l.order.amount }, l.headers)).raw);
    secrets.push(l.paymentKey);
    // 본문 검사 실패(결제 참조는 맞고 금액 형식이 틀림)·금액 다름·남의 주문
    const p = await h.prepareOrder(e, 'sec1', ['S-3']);
    secrets.push(p.paymentKey);
    raws.push((await h.pay(p.order.orderId, { paymentKey: p.paymentKey, amount: 'x' }, p.headers)).raw);
    raws.push((await h.pay(p.order.orderId, { paymentKey: p.paymentKey, amount: p.order.amount + 1 }, p.headers)).raw);
    raws.push((await h.pay(p.order.orderId, { paymentKey: p.paymentKey, amount: p.order.amount }, fanHeaders('sec2'))).raw);
    raws.push((await h.viewOrder(ok.order.orderId, fanHeaders('sec2'))).raw);
    for (const raw of raws) for (const secret of secrets) expect(raw, `응답에 비밀이 실렸다: ${raw}`).not.toContain(secret);
    // 남의 주문 보기에는 티켓 코드가 없다(자기 응답 ok.paid만 코드를 싣는다)
    for (const raw of raws.slice(1)) for (const t of ok.paid.tickets) expect(raw).not.toContain(t.code);
    // 서비스 로그
    await sleep(50);
    const logs = h.logText(logFrom);
    expect(logs.length, '서비스 로그가 비었다(로그를 모으지 못했다)').toBeGreaterThan(0);
    for (const secret of [...secrets, ...ok.paid.tickets.map((t) => t.code)]) expect(logs, '서비스 로그에 비밀이 실렸다').not.toContain(secret);
  });
});
