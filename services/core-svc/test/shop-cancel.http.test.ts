// 굿즈 구매자 취소 HTTP 시험(메모리 어댑터, ADR-0315·ADR-0293, POL-016 §1.4, P-T61 ④·P-T63 ①②③).
// 정본:
// - 소유: 다른 계정·없는 주문은 같은 404 not-found이고 쓰기 0. itemIds는 1~20개·중복 없음·그 주문의 항목(아니면 404)이다.
// - 계좌: 가상계좌 결제인데 refundAccount가 없으면 422 refund-account-required이고 결제사·항목 그대로, 카드는 계좌 없이 202.
// - 재인증: 계좌를 보내면 X-Reauth-Token 필수. 없음·틀림·만료·sid/sub/act/op 어긋남·이미 쓴 jti는 403 reauth-required,
//   키 묶음·jti 저장소 장애는 503 reauth-unavailable·Retry-After 5초 [가정], TICKET_CANCEL_REFUND_ACCOUNT 토큰은 403이다.
// - 계좌 모양: packages/validation/test/fixtures/refund-account-cases.json과 같은 표를 돌린다(경계 20·30·60자 통과, 틀리면 400).
import 'reflect-metadata';
import { createService, fakeClock, RedisReauthJtiStore } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import {
  JwksShopReauthGate,
  MemoryHeldTickets,
  MemoryMerchPayments,
  MemoryMerchStock,
  MemoryProductStore,
  MemoryShopOrderStore,
  type ProductRecord,
  type ShopOrder,
  type ShopOrderItem,
} from '../src/modules/shop/index.js';
import { FakeIdentity, NOW_MS, quiet } from './support.js';
import { fanKey, fakeJwksFetch, fakeSeatRedis, ISS, JWKS_URL, OP, reauthClaims, signReauth } from './shop-reauth-fixtures.js';

const CONSENT = 'v2026.11-10';
const UNIT = 12_300;
const clock = fakeClock({ now: NOW_MS });
const products = new MemoryProductStore();
const orders = new MemoryShopOrderStore(products);
const stock = new MemoryMerchStock();
const payments = new MemoryMerchPayments(() => clock.now());
const held = new MemoryHeldTickets();
const fanKey1 = fanKey('fan-k1');
const jwks = fakeJwksFetch([fanKey1]);
const redis = fakeSeatRedis();
const gate = new JwksShopReauthGate({ jwksUrl: JWKS_URL, issuer: ISS, jti: new RedisReauthJtiStore(redis), clock, fetch: jwks.fetch });
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, shop: { store: products, orders, stock, payments, held, reauth: gate, consentVersion: CONSENT, sleep: async () => {} } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: new FakeIdentity(),
  });
});
afterAll(async () => {
  await svc?.close();
});

function registerProduct(): ProductRecord {
  const p: ProductRecord = {
    productId: randomUUID(),
    promoterId: randomUUID(),
    type: 'MERCH',
    name: 'P-T61 상품',
    status: 'PUBLISHED',
    price: UNIT,
    shippingFee: null,
    returnShippingFee: 3_000,
    returnAddress: '서울특별시 마포구 월드컵로 1',
    limitedQty: null,
    stock: null,
    transferable: false,
    ticketLinked: false,
    linkedEventId: null,
    fulfillments: ['PICKUP', 'DELIVERY'],
    saleStartsAt: null,
    saleEndsAt: null,
    commissionRateBp: 1000,
    attributes: {},
    schemaVersion: 1,
    version: 1,
    publishedAt: new Date(NOW_MS - 10 * 86_400_000),
    updatedAt: new Date(NOW_MS - 10 * 86_400_000),
  };
  products.rows.set(p.productId, p);
  return p;
}

interface Fixture {
  accountId: string;
  orderId: string;
  itemIds: string[];
}

/** PAID 주문 하나와 READY 항목을 메모리에 직접 넣는다(취소 경로만 보는 시험) */
function paidOrder(o: { accountId?: string; items?: number; unitAmount?: number; pgStore?: 'STANDARD' | 'ESCROW'; itemStatus?: ShopOrderItem['status'] } = {}): Fixture {
  const accountId = o.accountId ?? randomUUID();
  const orderId = randomUUID();
  const count = o.items ?? 1;
  const unit = o.unitAmount ?? UNIT;
  const p = registerProduct();
  const order: ShopOrder = {
    orderId,
    accountId,
    promoterId: p.promoterId,
    eventId: null,
    fulfillment: 'PICKUP',
    status: 'PAID',
    amount: count * unit,
    shippingFee: 0,
    pgStore: o.pgStore ?? 'STANDARD',
    pg: 'SIMULATOR',
    paymentId: randomUUID(),
    stockReservedUntil: new Date(NOW_MS - 60_000),
    consentVersion: null,
    recipientName: null,
    recipientPhone: null,
    deliveryAddress: null,
    pickupSlotId: null,
    escrow: false,
    orderedAt: new Date(NOW_MS - 3_600_000),
    paidAt: new Date(NOW_MS - 3_000_000),
    purchaseConfirmedAt: null,
  };
  orders.orders.set(orderId, order);
  const itemIds = Array.from({ length: count }, (_, i) => {
    const itemId = `${String(i).padStart(2, '0')}-${randomUUID()}`;
    const item: ShopOrderItem = {
      itemId,
      orderId,
      promoterId: p.promoterId,
      eventId: null,
      productId: p.productId,
      productName: p.name,
      quantity: 1,
      unitAmount: unit,
      commissionRateBp: 1000,
      status: o.itemStatus ?? 'READY',
      fulfillment: 'PICKUP',
      ticketLinked: false,
      limited: false,
      optionSnapshot: { options: {}, name: p.name, type: 'MERCH', schemaVersion: 1 },
      linkedTicketId: null,
      cancelReason: null,
      refundedAmount: 0,
      pickedUpAt: null,
      eventEndsAt: null,
    };
    orders.items.set(itemId, item);
    return itemId;
  });
  return { accountId, orderId, itemIds };
}

const cardPayment = (orderId: string) => payments.details.set(orderId, { status: 'APPROVED', pg: 'SIMULATOR', virtualAccountPaid: false });
const vaPayment = (orderId: string) => payments.details.set(orderId, { status: 'APPROVED', pg: 'SIMULATOR', virtualAccountPaid: true });

const headers = (accountId: string, o: { sessionId?: string; token?: string } = {}) => ({
  'x-user-id': accountId,
  'x-session-id': o.sessionId ?? randomUUID(),
  'x-user-aud': 'fan',
  'x-user-scope': 'openid',
  'content-type': 'application/json',
  'idempotency-key': randomUUID(),
  ...(o.token === undefined ? {} : { 'x-reauth-token': o.token }),
});
const cancel = (accountId: string, orderId: string, body: unknown, o: { sessionId?: string; token?: string } = {}) =>
  svc.http.inject({ method: 'POST', url: `/v1/shop/orders/${orderId}/cancellations`, headers: headers(accountId, o), payload: JSON.stringify(body) });

function tokenFor(o: { accountId: string; sessionId: string; act?: string; op?: string; lifeS?: number; jti?: string; over?: Record<string, unknown> }) {
  const claims = reauthClaims(
    { nowMs: clock.now(), accountId: o.accountId, sessionId: o.sessionId, act: o.act ?? 'FAN_HIGH_RISK', op: o.op ?? OP, lifeS: o.lifeS ?? 180, ...(o.jti === undefined ? {} : { jti: o.jti }) },
    o.over ?? {},
  );
  return { t: signReauth(fanKey1, claims), jti: claims.jti as string };
}

const typeOf = (res: { payload: string }) => String(JSON.parse(res.payload).type);
const problem = (res: { statusCode: number; payload: string }) => {
  const b = JSON.parse(res.payload);
  return { status: res.statusCode, type: b.type, title: b.title };
};
const ACCOUNT_BODY = { bankCode: '88', accountNumber: '110-987-6543', holderName: '김환불' };

describe('구매자 취소의 소유·입력 검사(P-T61 ④)', () => {
  test('P-T61 ④ 다른 계정·없는 주문은 같은 404 not-found이고 쓰기·결제사 호출이 0이다', async () => {
    const f = paidOrder();
    cardPayment(f.orderId);
    const missing = randomUUID();
    const writes = orders.writes;
    const refunds = orders.refunds.size;
    const calls = payments.calls.cancel.length;
    const other = problem(await cancel(randomUUID(), f.orderId, {}));
    const none = problem(await cancel(f.accountId, missing, {}));
    expect(other).toEqual(none);
    expect(other.status).toBe(404);
    expect(String(other.type)).toContain('not-found');
    expect(orders.writes).toBe(writes);
    expect(orders.refunds.size).toBe(refunds);
    expect(payments.calls.cancel.length).toBe(calls);
    expect(orders.items.get(f.itemIds[0]!)!.status).toBe('READY');
  });

  test('P-T61 ④ itemIds는 1개·20개를 받고 21개·중복·빈 배열은 400이며 쓰기가 없다', async () => {
    const one = paidOrder();
    cardPayment(one.orderId);
    const single = await cancel(one.accountId, one.orderId, { itemIds: one.itemIds });
    expect(single.statusCode, single.payload).toBe(202);
    expect(JSON.parse(single.payload).refundAmount).toBe(UNIT);

    const twenty = paidOrder({ items: 20 });
    cardPayment(twenty.orderId);
    const all = await cancel(twenty.accountId, twenty.orderId, { itemIds: twenty.itemIds });
    expect(all.statusCode, all.payload).toBe(202);
    expect(JSON.parse(all.payload).refundAmount).toBe(20 * UNIT);
    expect(twenty.itemIds.map((id) => orders.items.get(id)!.status)).toEqual(Array(20).fill('REFUNDED'));

    const bad = paidOrder({ items: 20 });
    cardPayment(bad.orderId);
    const writes = orders.writes;
    const refunds = orders.refunds.size;
    const calls = payments.calls.cancel.length;
    const cases: [string, unknown][] = [
      ['21개', [...bad.itemIds, randomUUID()]],
      ['중복', [bad.itemIds[0]!, bad.itemIds[0]!]],
      ['빈 배열', []],
    ];
    for (const [what, itemIds] of cases) {
      const res = await cancel(bad.accountId, bad.orderId, { itemIds });
      expect(res.statusCode, `${what}: ${res.payload}`).toBe(400);
    }
    expect(orders.writes).toBe(writes);
    expect(orders.refunds.size).toBe(refunds);
    expect(payments.calls.cancel.length).toBe(calls);
    expect(bad.itemIds.every((id) => orders.items.get(id)!.status === 'READY')).toBe(true);
  });

  test('P-T61 ④ 다른 계정의 항목 ID를 섞거나 그 주문에 없는 항목 ID를 보내면 404 not-found이고 쓰기가 없다', async () => {
    const a = paidOrder();
    const b = paidOrder();
    cardPayment(a.orderId);
    cardPayment(b.orderId);
    const writes = orders.writes;
    const refunds = orders.refunds.size;
    const calls = payments.calls.cancel.length;
    for (const itemIds of [[a.itemIds[0]!, b.itemIds[0]!], [randomUUID()]]) {
      const res = await cancel(a.accountId, a.orderId, { itemIds });
      expect(res.statusCode, res.payload).toBe(404);
      expect(typeOf(res)).toContain('not-found');
    }
    expect(orders.writes).toBe(writes);
    expect(orders.refunds.size).toBe(refunds);
    expect(payments.calls.cancel.length).toBe(calls);
    expect(orders.items.get(a.itemIds[0]!)!.status).toBe('READY');
    expect(orders.items.get(b.itemIds[0]!)!.status).toBe('READY');
  });
});

describe('가상계좌 결제의 환불 계좌 요구(P-T63 ①)', () => {
  test('P-T63 ① 가상계좌 결제인데 refundAccount가 없으면 422 refund-account-required이고 결제사·항목이 그대로다', async () => {
    const f = paidOrder();
    vaPayment(f.orderId);
    const writes = orders.writes;
    const refunds = orders.refunds.size;
    const calls = payments.calls.cancel.length;
    const reads = payments.calls.getPayment.length;
    const res = await cancel(f.accountId, f.orderId, {});
    expect(res.statusCode, res.payload).toBe(422);
    expect(typeOf(res)).toContain('refund-account-required');
    expect(payments.calls.cancel.length).toBe(calls);
    expect(payments.calls.getPayment.length).toBe(reads + 1);
    expect(orders.writes).toBe(writes);
    expect(orders.refunds.size).toBe(refunds);
    expect(orders.items.get(f.itemIds[0]!)!.status).toBe('READY');
    expect(res.payload).not.toContain('accountNumber');
  });

  test('P-T63 ① 카드 결제면 refundAccount 없이 202 REFUNDED이고 결제사에 계좌를 보내지 않는다', async () => {
    const f = paidOrder();
    cardPayment(f.orderId);
    const res = await cancel(f.accountId, f.orderId, {});
    expect(res.statusCode, res.payload).toBe(202);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe('REFUNDED');
    expect(body.refundAmount).toBe(UNIT);
    expect(body.cancellationId).toBe(payments.calls.cancel.at(-1)!.cancellationId);
    expect(payments.calls.cancel.at(-1)).toMatchObject({ amount: UNIT, reason: 'USER_CANCEL' });
    expect(payments.calls.cancel.at(-1)!.refundAccount).toBeUndefined();
    expect(orders.items.get(f.itemIds[0]!)!.status).toBe('REFUNDED');
  });
});

describe('환불 계좌가 있을 때의 재인증(P-T63 ②)', () => {
  test('P-T63 ② 팬 공개키 묶음 장애는 503 reauth-unavailable·Retry-After 5초이고 쓰기가 없다', async () => {
    const f = paidOrder();
    cardPayment(f.orderId);
    const sessionId = randomUUID();
    const tk = tokenFor({ accountId: f.accountId, sessionId });
    const writes = orders.writes;
    const refunds = orders.refunds.size;
    const calls = payments.calls.cancel.length;
    jwks.mode = 'throw';
    try {
      const res = await cancel(f.accountId, f.orderId, { refundAccount: ACCOUNT_BODY }, { sessionId, token: tk.t });
      expect(res.statusCode, res.payload).toBe(503);
      expect(typeOf(res)).toContain('reauth-unavailable');
      expect(res.headers['retry-after']).toBe('5');
      expect(jwks.urls.length, '장애가 실제로 끼어들었다').toBeGreaterThanOrEqual(1);
    } finally {
      jwks.mode = 'up';
    }
    expect(orders.writes).toBe(writes);
    expect(orders.refunds.size).toBe(refunds);
    expect(payments.calls.cancel.length).toBe(calls);
    expect(orders.items.get(f.itemIds[0]!)!.status).toBe('READY');
  });

  test('P-T63 ② jti 저장소 장애는 503 reauth-unavailable·Retry-After 5초이고 쓰기가 없다', async () => {
    // 먼저 정상 토큰으로 한 번 통과시켜 공개키를 받아 둔다
    const warm = paidOrder();
    cardPayment(warm.orderId);
    const warmSession = randomUUID();
    const warmToken = tokenFor({ accountId: warm.accountId, sessionId: warmSession });
    expect((await cancel(warm.accountId, warm.orderId, { refundAccount: ACCOUNT_BODY }, { sessionId: warmSession, token: warmToken.t })).statusCode).toBe(202);

    const f = paidOrder();
    cardPayment(f.orderId);
    const sessionId = randomUUID();
    const tk = tokenFor({ accountId: f.accountId, sessionId });
    const writes = orders.writes;
    const refunds = orders.refunds.size;
    const calls = payments.calls.cancel.length;
    redis.mode = 'throw';
    try {
      const res = await cancel(f.accountId, f.orderId, { refundAccount: ACCOUNT_BODY }, { sessionId, token: tk.t });
      expect(res.statusCode, res.payload).toBe(503);
      expect(typeOf(res)).toContain('reauth-unavailable');
      expect(res.headers['retry-after']).toBe('5');
    } finally {
      redis.mode = 'real';
    }
    expect(orders.writes).toBe(writes);
    expect(orders.refunds.size).toBe(refunds);
    expect(payments.calls.cancel.length).toBe(calls);
    expect(orders.items.get(f.itemIds[0]!)!.status).toBe('READY');
  });

  test('P-T63 ② 토큰 없음·틀림·만료·sid/sub/act/op 어긋남은 403 reauth-required이고 결제사를 부르지 않는다', async () => {
    const cases: [string, (o: { accountId: string; sessionId: string }) => { sessionId: string; token?: string }][] = [
      ['없음', ({ sessionId }) => ({ sessionId })],
      ['틀림', ({ sessionId }) => ({ sessionId, token: 'not-a-jwt' })],
      ['만료', ({ accountId, sessionId }) => ({ sessionId, token: tokenFor({ accountId, sessionId, lifeS: -5 }).t })],
      ['sid 어긋남', ({ accountId, sessionId }) => ({ sessionId, token: tokenFor({ accountId, sessionId: randomUUID() }).t })],
      ['sub 어긋남', ({ sessionId }) => ({ sessionId, token: tokenFor({ accountId: randomUUID(), sessionId }).t })],
      ['act 어긋남', ({ accountId, sessionId }) => ({ sessionId, token: tokenFor({ accountId, sessionId, act: 'FAN_SENSITIVE' }).t })],
      ['op가 티켓 취소', ({ accountId, sessionId }) => ({ sessionId, token: tokenFor({ accountId, sessionId, op: 'TICKET_CANCEL_REFUND_ACCOUNT' }).t })],
    ];
    for (const [what, make] of cases) {
      const f = paidOrder();
      cardPayment(f.orderId);
      const writes = orders.writes;
      const refunds = orders.refunds.size;
      const calls = payments.calls.cancel.length;
      const sessionId = randomUUID();
      const res = await cancel(f.accountId, f.orderId, { refundAccount: ACCOUNT_BODY }, make({ accountId: f.accountId, sessionId }));
      expect(res.statusCode, `${what}: ${res.payload}`).toBe(403);
      expect(typeOf(res), what).toContain('reauth-required');
      expect(orders.writes, what).toBe(writes);
      expect(orders.refunds.size, what).toBe(refunds);
      expect(payments.calls.cancel.length, what).toBe(calls);
      expect(orders.items.get(f.itemIds[0]!)!.status, what).toBe('READY');
    }
  });

  test('P-T63 ② 이미 쓴 jti는 403 reauth-required이고 두 번째 주문은 취소되지 않는다', async () => {
    const first = paidOrder();
    cardPayment(first.orderId);
    const second = paidOrder();
    cardPayment(second.orderId);
    const sessionId = randomUUID();
    const tk = tokenFor({ accountId: first.accountId, sessionId });
    expect((await cancel(first.accountId, first.orderId, { refundAccount: ACCOUNT_BODY }, { sessionId, token: tk.t })).statusCode).toBe(202);
    const writes = orders.writes;
    const calls = payments.calls.cancel.length;
    const replay = await cancel(second.accountId, second.orderId, { refundAccount: ACCOUNT_BODY }, { sessionId, token: tk.t });
    expect(replay.statusCode, replay.payload).toBe(403);
    expect(typeOf(replay)).toContain('reauth-required');
    expect(orders.writes).toBe(writes);
    expect(payments.calls.cancel.length).toBe(calls);
    expect(orders.items.get(second.itemIds[0]!)!.status).toBe('READY');
  });
});

interface ShapeRow {
  name: string;
  input: { bankCode: string; accountNumber: string; holderName: string };
  ok: boolean;
  value?: { bankCode: string; accountNumber: string; holderName: string };
}
const SHAPES = (JSON.parse(readFileSync(fileURLToPath(new URL('../../../packages/validation/test/fixtures/refund-account-cases.json', import.meta.url)), 'utf8')) as { cases: ShapeRow[] }).cases;

describe('환불 계좌 모양(P-T63 ③, 공용 표)', () => {
  test('P-T63 ③ 공용 표의 경우가 core HTTP에서도 같다: 틀리면 400·재인증·결제사 0, 경계(20·30·60자)는 202', async () => {
    for (const row of SHAPES) {
      const f = paidOrder();
      vaPayment(f.orderId);
      const writes = orders.writes;
      const refunds = orders.refunds.size;
      const calls = payments.calls.cancel.length;
      const claims = redis.commands.length;
      const sessionId = randomUUID();
      const tk = tokenFor({ accountId: f.accountId, sessionId });
      const res = await cancel(f.accountId, f.orderId, { refundAccount: row.input }, { sessionId, token: tk.t });
      const item = orders.items.get(f.itemIds[0]!)!;
      if (row.ok) {
        expect(res.statusCode, `${row.name}: ${res.payload}`).toBe(202);
        const body = JSON.parse(res.payload);
        expect(body.refundAmount, row.name).toBe(UNIT);
        expect(payments.calls.cancel.length, row.name).toBe(calls + 1);
        // 하이픈을 뺀 계좌번호와 앞뒤 공백을 뺀 예금주가 결제사로 간다
        expect(payments.calls.cancel.at(-1)!.refundAccount, row.name).toEqual(row.value);
        expect(redis.commands.length, `${row.name}: 재인증 1회`).toBe(claims + 1);
        expect(item.status, row.name).toBe('REFUNDED');
      } else {
        expect(res.statusCode, `${row.name}: ${res.payload}`).toBe(400);
        expect(payments.calls.cancel.length, `${row.name}: 결제사 0`).toBe(calls);
        expect(redis.commands.length, `${row.name}: 재인증 0`).toBe(claims);
        expect(orders.writes, row.name).toBe(writes);
        expect(orders.refunds.size, row.name).toBe(refunds);
        expect(item.status, row.name).toBe('READY');
      }
    }
  });

  test('P-T63 ③ 예금주에 제어 문자가 있으면 400이고 재인증·결제사를 부르지 않는다', async () => {
    const f = paidOrder();
    vaPayment(f.orderId);
    const writes = orders.writes;
    const calls = payments.calls.cancel.length;
    const claims = redis.commands.length;
    const sessionId = randomUUID();
    const tk = tokenFor({ accountId: f.accountId, sessionId });
    const res = await cancel(f.accountId, f.orderId, { refundAccount: { bankCode: '88', accountNumber: '110-987-6543', holderName: '김\u0007환불' } }, { sessionId, token: tk.t });
    expect(res.statusCode, res.payload).toBe(400);
    expect(payments.calls.cancel.length).toBe(calls);
    expect(redis.commands.length).toBe(claims);
    expect(orders.writes).toBe(writes);
    expect(orders.items.get(f.itemIds[0]!)!.status).toBe('READY');
  });
});
