// 티켓 연동 부가 상품 HTTP 시험(메모리 어댑터, BUILD_ORDER LCH-020, ADR-0301 결정 1~3, V-T35 ①②, FR-014).
// 단언 값은 정본에서: 지금 보유자(ListHeldTickets(세션 계정, 연결 회차))만 사고, 없는 티켓·남의 티켓은 같은 404 not-found, 확인 못 함은 503 dependency-unavailable(주문 0),
// 주문은 수령 방식 WALLET·항목 linked_ticket_id, 월렛 목록은 PAID 항목만·지금 보유자만·양도받은 보유자는 양도 가능 상품만·항목이 없으면 빈 목록(ADR-0301 결정 3),
// 주문 뒤 가격이 올라도 주문 금액·항목 단가·옵션 스냅샷과 승인 명령 금액은 그대로(V-T35 ②, ADR-0101 결정 7).
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import {
  MemoryHeldTickets,
  MemoryMerchPayments,
  MemoryMerchStock,
  MemoryProductStore,
  MemoryShopOrderStore,
  MerchPaymentResults,
  type ProductRecord,
} from '../src/modules/shop/index.js';
import { FakeIdentity, fan, NOW_MS, quiet } from './support.js';

const SELLER = randomUUID();
const EVENT = randomUUID();
const clock = fakeClock({ now: NOW_MS });
const products = new MemoryProductStore();
const orders = new MemoryShopOrderStore(products);
const stock = new MemoryMerchStock();
const payments = new MemoryMerchPayments();
const held = new MemoryHeldTickets();
const identity = new FakeIdentity();
const results = new MerchPaymentResults({ store: orders, stock, payments, clock });
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, shop: { store: products, orders, stock, payments, held, sleep: async () => {} } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
});
beforeEach(() => {
  held.failing = false;
});

function addonProduct(o: Partial<ProductRecord> = {}): ProductRecord {
  const p: ProductRecord = {
    productId: randomUUID(),
    promoterId: SELLER,
    type: 'PARKING',
    name: '공연장 주차권',
    status: 'PUBLISHED',
    price: 8_700,
    shippingFee: null,
    returnShippingFee: null,
    returnAddress: null,
    limitedQty: 3,
    stock: 3,
    transferable: false,
    ticketLinked: true,
    linkedEventId: EVENT,
    fulfillments: ['WALLET'],
    saleStartsAt: null,
    saleEndsAt: null,
    commissionRateBp: 1000,
    attributes: { options: [{ name: '차종', values: ['경차', '일반'] }] },
    schemaVersion: 1,
    version: 1,
    publishedAt: new Date(NOW_MS - 86_400_000),
    updatedAt: new Date(NOW_MS - 86_400_000),
    ...o,
  };
  products.rows.set(p.productId, p);
  if (p.limitedQty !== null) stock.setCounter(p.productId, p.stock ?? 0);
  return p;
}

const h = (account: string) => ({ ...fan(account), 'content-type': 'application/json', 'idempotency-key': randomUUID() });
const buy = (account: string, ticketId: string, body: Record<string, unknown>) =>
  svc.http.inject({ method: 'POST', url: `/v1/tickets/${ticketId}/addons`, headers: h(account), payload: JSON.stringify(body) });
const list = (account: string, ticketId: string) => svc.http.inject({ method: 'GET', url: `/v1/tickets/${ticketId}/addons`, headers: fan(account) });
const typeOf = (res: { payload: string }) => String(JSON.parse(res.payload).type);
const problem = (res: { statusCode: number; payload: string }) => {
  const b = JSON.parse(res.payload);
  return { status: res.statusCode, type: b.type, title: b.title };
};

/** 결제 시도 → 접수 → 당기기 반영으로 PAID(메모리 결제 대역이 승인으로 답함) */
async function pay(account: string, orderId: string): Promise<void> {
  const start = await svc.http.inject({ method: 'POST', url: `/v1/shop/orders/${orderId}/payments`, headers: h(account), payload: '{}' });
  expect(start.statusCode).toBe(201);
  const attempt = JSON.parse(start.payload);
  const amount = orders.orders.get(orderId)!.amount;
  const acc = await svc.http.inject({
    method: 'POST',
    url: `/v1/shop/orders/${orderId}/payment-acceptance`,
    headers: h(account),
    payload: JSON.stringify({ pg: attempt.pg, paymentKey: `sim_${orderId.slice(0, 8)}`, amount, attemptId: attempt.attemptId }),
  });
  expect(acc.statusCode).toBe(202);
  payments.states.set(orderId, { orderId, paymentId: randomUUID(), pg: 'SIMULATOR', status: 'APPROVED', approvedAtMs: clock.now(), failureCategory: undefined });
  clock.advance(2_000);
  await results.tick();
  expect(orders.orders.get(orderId)!.status).toBe('PAID');
}

describe('부가 상품 주문(V-T35 ①)', () => {
  test('V-T35 ① 그 회차 티켓을 지금 가진 계정은 201이고 주문은 WALLET·연결 회차, 항목은 linked_ticket_id가 그 티켓이다', async () => {
    const account = randomUUID();
    const ticket = randomUUID();
    held.set(account, EVENT, [ticket]);
    const p = addonProduct();
    const res = await buy(account, ticket, { productId: p.productId, quantity: 1, options: { 차종: '경차' } });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.fulfillment).toBe('WALLET');
    expect(held.calls.at(-1)).toEqual({ accountId: account, eventId: EVENT });
    const o = orders.orders.get(body.orderId)!;
    expect(o).toMatchObject({ accountId: account, fulfillment: 'WALLET', eventId: EVENT, pgStore: 'STANDARD', shippingFee: 0, amount: 8_700, status: 'CREATED' });
    const items = [...orders.items.values()].filter((i) => i.orderId === body.orderId);
    expect(items).toHaveLength(1);
    expect(items[0]!.linkedTicketId).toBe(ticket);
    expect(stock.slots.get(p.productId)!.stock).toBe(2);
  });

  test('V-T35 ① 티켓이 없는 계정·남의 티켓·없는 티켓은 같은 404 not-found이고 주문·예약이 없다 [ASVS v5.0.0-8.2.2]', async () => {
    const owner = randomUUID();
    const ticket = randomUUID();
    held.set(owner, EVENT, [ticket]);
    const p = addonProduct();
    const stranger = randomUUID();
    held.set(stranger, EVENT, [randomUUID()]); // 그 회차의 다른 티켓을 가진 계정
    const before = orders.orders.size;
    const others = [
      await buy(stranger, ticket, { productId: p.productId, quantity: 1, options: { 차종: '일반' } }),
      await buy(randomUUID(), ticket, { productId: p.productId, quantity: 1, options: { 차종: '일반' } }),
      await buy(owner, randomUUID(), { productId: p.productId, quantity: 1, options: { 차종: '일반' } }),
    ];
    const first = problem(others[0]!);
    expect(first.status).toBe(404);
    expect(String(first.type)).toContain('not-found');
    for (const r of others) expect(problem(r)).toEqual(first);
    expect(orders.orders.size).toBe(before);
    expect(stock.slots.get(p.productId)!.resv.size).toBe(0);
    expect(stock.slots.get(p.productId)!.stock).toBe(3);
  });

  test('V-T35 ① ticket-svc 보유 확인이 실패하면 503 dependency-unavailable이고 주문·예약이 없다(없음으로도 있음으로도 보지 않는다)', async () => {
    const account = randomUUID();
    const ticket = randomUUID();
    held.set(account, EVENT, [ticket]);
    const p = addonProduct();
    held.failing = true;
    const before = orders.orders.size;
    const res = await buy(account, ticket, { productId: p.productId, quantity: 1, options: { 차종: '경차' } });
    expect(res.statusCode).toBe(503);
    expect(typeOf(res)).toContain('dependency-unavailable');
    expect(orders.orders.size).toBe(before);
    expect(stock.slots.get(p.productId)!.resv.size).toBe(0);
    expect(stock.slots.get(p.productId)!.stock).toBe(3);
  });

  test('V-T35 ① 티켓 연동이 아니거나 WALLET을 받지 않거나 판매 중이 아닌 상품은 422 merch-product-unavailable다', async () => {
    const account = randomUUID();
    const ticket = randomUUID();
    held.set(account, EVENT, [ticket]);
    for (const [name, o] of [
      ['티켓 연동 아님', { ticketLinked: false, linkedEventId: null }],
      ['WALLET 없음', { fulfillments: ['PICKUP'] }],
      ['숨김', { status: 'HIDDEN' }],
    ] as [string, Partial<ProductRecord>][]) {
      const p = addonProduct({ name, ...o });
      const res = await buy(account, ticket, { productId: p.productId, quantity: 1, options: { 차종: '경차' } });
      expect(res.statusCode, name).toBe(422);
      expect(typeOf(res), name).toContain('merch-product-unavailable');
    }
  });
});

describe('월렛의 부가 상품 목록(V-T35 ①, ADR-0301 결정 3)', () => {
  test('V-T35 ① 결제 뒤 GET …/addons에 보이고 결제 전(CREATED) 주문은 보이지 않는다', async () => {
    const account = randomUUID();
    const ticket = randomUUID();
    held.set(account, EVENT, [ticket]);
    const p = addonProduct({ name: '결제 뒤 보임' });
    const orderId = JSON.parse((await buy(account, ticket, { productId: p.productId, quantity: 2, options: { 차종: '일반' } })).payload).orderId as string;
    const beforePay = await list(account, ticket);
    expect(beforePay.statusCode).toBe(200);
    expect(JSON.parse(beforePay.payload).items).toEqual([]);
    await pay(account, orderId);
    const after = JSON.parse((await list(account, ticket)).payload);
    expect(after.items).toHaveLength(1);
    expect(after.items[0]).toMatchObject({ orderId, productId: p.productId, name: '결제 뒤 보임', quantity: 2, status: 'READY' });
  });

  test('V-T35 ① 양도받은 보유자는 양도 가능 상품만 보이고, 지금 보유자가 아닌 주문자는 404 not-found다 [ASVS v5.0.0-8.2.2]', async () => {
    const buyer = randomUUID();
    const ticket = randomUUID();
    held.set(buyer, EVENT, [ticket]);
    const movable = addonProduct({ name: '양도 가능 주차권', transferable: true });
    const fixed = addonProduct({ name: '양도 불가 주차권', transferable: false });
    const o1 = JSON.parse((await buy(buyer, ticket, { productId: movable.productId, quantity: 1, options: { 차종: '경차' } })).payload).orderId as string;
    await pay(buyer, o1);
    const o2 = JSON.parse((await buy(buyer, ticket, { productId: fixed.productId, quantity: 1, options: { 차종: '경차' } })).payload).orderId as string;
    await pay(buyer, o2);
    expect(JSON.parse((await list(buyer, ticket)).payload).items).toHaveLength(2);

    // 양도: 티켓이 새 보유자에게 간다
    const receiver = randomUUID();
    held.set(buyer, EVENT, []);
    held.set(receiver, EVENT, [ticket]);
    const seen = JSON.parse((await list(receiver, ticket)).payload).items;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ productId: movable.productId, orderId: null });
    const old = await list(buyer, ticket);
    expect(old.statusCode).toBe(404);
    expect(typeOf(old)).toContain('not-found');
    const stranger = await list(randomUUID(), ticket);
    expect(problem(stranger)).toEqual(problem(old));
  });

  test('V-T35 ① 목록의 보유 확인이 실패하면 503이고, 항목이 하나도 없는 티켓은 보유 확인 없이 빈 목록이다', async () => {
    const buyer = randomUUID();
    const ticket = randomUUID();
    held.set(buyer, EVENT, [ticket]);
    const p = addonProduct({ name: '목록 503' });
    const orderId = JSON.parse((await buy(buyer, ticket, { productId: p.productId, quantity: 1, options: { 차종: '경차' } })).payload).orderId as string;
    await pay(buyer, orderId);
    held.failing = true;
    const down = await list(buyer, ticket);
    expect(down.statusCode).toBe(503);
    expect(typeOf(down)).toContain('dependency-unavailable');
    const calls = held.calls.length;
    const empty = await list(randomUUID(), randomUUID());
    expect(empty.statusCode).toBe(200);
    expect(JSON.parse(empty.payload).items).toEqual([]);
    expect(held.calls.length).toBe(calls);
  });
});

describe('주문 뒤 가격 바뀜(V-T35 ②)', () => {
  test('V-T35 ② 주문 뒤 파트너가 가격을 올리고 옵션을 바꿔도 그 주문의 금액·항목 단가·옵션 스냅샷과 승인 명령 금액이 그대로다', async () => {
    const account = randomUUID();
    const ticket = randomUUID();
    held.set(account, EVENT, [ticket]);
    const p = addonProduct({ name: '가격 오를 주차권', price: 8_700 });
    const orderId = JSON.parse((await buy(account, ticket, { productId: p.productId, quantity: 2, options: { 차종: '경차' } })).payload).orderId as string;
    const item = () => [...orders.items.values()].find((i) => i.orderId === orderId)!;
    const snapshot = structuredClone(item().optionSnapshot);
    expect(snapshot.options).toEqual({ 차종: '경차' });

    const partner = { ...identity.partner(SELLER), 'content-type': 'application/json', 'if-match': '"1"' };
    const patched = await svc.http.inject({
      method: 'PATCH',
      url: `/v1/partner/products/${p.productId}`,
      headers: partner,
      payload: JSON.stringify({ price: 15_900, attributes: { options: [{ name: '차종', values: ['일반', '대형'] }] } }),
    });
    expect(patched.statusCode).toBe(200);
    expect(products.rows.get(p.productId)!.price).toBe(15_900);

    expect(orders.orders.get(orderId)!.amount).toBe(17_400);
    expect(item().unitAmount).toBe(8_700);
    expect(item().optionSnapshot).toEqual(snapshot);
    const detail = JSON.parse((await svc.http.inject({ method: 'GET', url: `/v1/shop/orders/${orderId}`, headers: fan(account) })).payload);
    expect(detail.totalAmount).toBe(17_400);
    expect(detail.items[0]).toMatchObject({ unitPrice: 8_700, options: { 차종: '경차' } });

    const confirms = payments.calls.confirm.length;
    await pay(account, orderId);
    expect(payments.calls.confirm.length).toBe(confirms + 1);
    expect(payments.calls.confirm.at(-1)!.amount).toBe(17_400);
    expect(payments.calls.checkout.at(-1)!.amount).toBe(17_400);
    expect(orders.orders.get(orderId)!.amount).toBe(17_400);
  });
});
