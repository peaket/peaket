// 굿즈 반품 요청 HTTP 시험(메모리 어댑터, ADR-0315, POL-016 §1.4, P-T62 ①).
// 정본: 배송 완료 + 7일 − 1ms·정각에 200이고 + 1ms에는 409 merch-return-not-allowed다.
// 응답은 항목 RETURN_REQUESTED·returnReason·returnDueAt(받은 날 + 7일)·반품 배송비(returnPolicy.returnShippingFee)를 싣는다.
// 반품 요청은 결제사를 부르지 않고 merch_refund 행도 만들지 않는다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import {
  MemoryHeldTickets,
  MemoryMerchPayments,
  MemoryMerchStock,
  MemoryProductStore,
  MemoryShopOrderStore,
  type ProductRecord,
  type ShopOrder,
  type ShopOrderItem,
} from '../src/modules/shop/index.js';
import { FakeIdentity, fan, NOW_MS, quiet } from './support.js';

const CONSENT = 'v2026.11-10';
const DAY = 86_400_000;
const clock = fakeClock({ now: NOW_MS });
const products = new MemoryProductStore();
const orders = new MemoryShopOrderStore(products);
const stock = new MemoryMerchStock();
const payments = new MemoryMerchPayments(() => clock.now());
const held = new MemoryHeldTickets();
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, shop: { store: products, orders, stock, payments, held, consentVersion: CONSENT, sleep: async () => {} } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: new FakeIdentity(),
  });
});
afterAll(async () => {
  await svc?.close();
});

function product(price: number, returnShippingFee: number): ProductRecord {
  const p: ProductRecord = {
    productId: randomUUID(),
    promoterId: randomUUID(),
    type: 'MERCH',
    name: 'P-T62 ① 반품 상품',
    status: 'PUBLISHED',
    price,
    shippingFee: 3_000,
    returnShippingFee,
    returnAddress: '서울특별시 마포구 월드컵로 1',
    limitedQty: null,
    stock: null,
    transferable: false,
    ticketLinked: false,
    linkedEventId: null,
    fulfillments: ['DELIVERY'],
    saleStartsAt: null,
    saleEndsAt: null,
    commissionRateBp: 1000,
    attributes: {},
    schemaVersion: 1,
    version: 1,
    publishedAt: new Date(NOW_MS - 10 * DAY),
    updatedAt: new Date(NOW_MS - 10 * DAY),
  };
  products.rows.set(p.productId, p);
  return p;
}

/** 배송 완료된 PAID 주문 하나. deliveredAt이 null이면 받은 날 기록이 없다 */
function deliveredOrder(deliveredAt: number | null) {
  const p = product(12_300, 2_500);
  const accountId = randomUUID();
  const orderId = randomUUID();
  const itemId = randomUUID();
  const order: ShopOrder = {
    orderId,
    accountId,
    promoterId: p.promoterId,
    eventId: null,
    fulfillment: 'DELIVERY',
    status: 'PAID',
    amount: 12_300,
    shippingFee: 0,
    pgStore: 'ESCROW',
    pg: 'TOSS',
    paymentId: randomUUID(),
    stockReservedUntil: new Date(NOW_MS - 8 * DAY),
    consentVersion: CONSENT,
    recipientName: '김피켓',
    recipientPhone: '01012345678',
    deliveryAddress: '04001 서울특별시 마포구 월드컵로 1',
    pickupSlotId: null,
    escrow: false,
    orderedAt: new Date(NOW_MS - 9 * DAY),
    paidAt: new Date(NOW_MS - 9 * DAY),
    purchaseConfirmedAt: null,
  };
  orders.orders.set(orderId, order);
  const item: ShopOrderItem = {
    itemId,
    orderId,
    promoterId: p.promoterId,
    eventId: null,
    productId: p.productId,
    productName: p.name,
    quantity: 1,
    unitAmount: 12_300,
    commissionRateBp: 1000,
    status: 'DELIVERED',
    fulfillment: 'DELIVERY',
    ticketLinked: false,
    limited: false,
    optionSnapshot: { options: {}, name: p.name, type: 'MERCH', schemaVersion: 1 },
    linkedTicketId: null,
    cancelReason: null,
    refundedAmount: 0,
    pickedUpAt: null,
    eventEndsAt: null,
    shippedAt: new Date(NOW_MS - 2 * DAY),
    deliveredAt: deliveredAt === null ? null : new Date(deliveredAt),
  };
  orders.items.set(itemId, item);
  return { accountId, orderId, itemId };
}

const h = (account: string) => ({ ...fan(account), 'content-type': 'application/json', 'idempotency-key': randomUUID() });
const post = (account: string, url: string, body: unknown) => svc.http.inject({ method: 'POST', url, headers: h(account), payload: JSON.stringify(body) });

const typeOf = (res: { payload: string }) => String(JSON.parse(res.payload).type);

describe('굿즈 반품 요청 HTTP(P-T62 ①)', () => {
  test('P-T62 ① 배송 완료 7일 − 1ms·정각은 200이고 RETURN_REQUESTED·returnReason·returnDueAt·반품 배송비를 싣는다', async () => {
    for (const [what, deliveredAt] of [
      ['7일 − 1ms', NOW_MS - 7 * DAY + 1],
      ['7일 정각', NOW_MS - 7 * DAY],
    ] as const) {
      const f = deliveredOrder(deliveredAt);
      const writes = orders.writes;
      const refunds = orders.refunds.size;
      const calls = payments.calls.cancel.length;
      const res = await post(f.accountId, `/v1/shop/orders/${f.orderId}/returns`, { itemIds: [f.itemId], reason: 'CHANGE_OF_MIND', returnTrackingNo: '123456789012' });
      expect(res.statusCode, `${what}: ${res.payload}`).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.status, what).toBe('PAID');
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({ itemId: f.itemId, status: 'RETURN_REQUESTED', returnReason: 'CHANGE_OF_MIND', returnTrackingNo: '123456789012' });
      expect(body.items[0].returnDueAt, what).toBe(new Date(deliveredAt + 7 * DAY).toISOString());
      // 택배 반품 배송비는 상품 설정대로 보인다
      expect(body.returnPolicy.returnShippingFee, what).toBe(2_500);
      // 결제사 호출·환급 행 없음(접수만 한다)
      expect(payments.calls.cancel.length, what).toBe(calls);
      expect(orders.refunds.size, what).toBe(refunds);
      expect(orders.writes, what).toBe(writes + 1);
      expect(orders.items.get(f.itemId)!.returnRequestedAt?.getTime()).toBe(NOW_MS);
    }
  });

  test('P-T62 ① 7일 + 1ms에는 409 merch-return-not-allowed이고 항목이 그대로다', async () => {
    const f = deliveredOrder(NOW_MS - 7 * DAY - 1);
    const writes = orders.writes;
    const res = await post(f.accountId, `/v1/shop/orders/${f.orderId}/returns`, { itemIds: [f.itemId], reason: 'CHANGE_OF_MIND' });
    expect(res.statusCode, res.payload).toBe(409);
    expect(typeOf(res)).toContain('merch-return-not-allowed');
    expect(orders.writes).toBe(writes);
    expect(orders.items.get(f.itemId)!.status).toBe('DELIVERED');
    expect(orders.items.get(f.itemId)!.returnReason ?? null).toBe(null);
    expect(orders.items.get(f.itemId)!.returnRequestedAt ?? null).toBe(null);
    expect(payments.calls.cancel).toEqual([]);
  });

  test('P-T62 ③ 다른 계정·없는 주문·남의 항목은 같은 404 not-found이고 쓰기가 없다', async () => {
    const owner = deliveredOrder(NOW_MS - DAY);
    const other = deliveredOrder(NOW_MS - DAY);
    const writes = orders.writes;
    const refunds = orders.refunds.size;
    const calls = payments.calls.cancel.length;
    const cases: [string, string, string, string[]][] = [
      ['다른 계정의 주문', other.accountId, owner.orderId, [owner.itemId]],
      ['없는 주문', owner.accountId, randomUUID(), [randomUUID()]],
      ['다른 주문의 항목', owner.accountId, owner.orderId, [other.itemId]],
    ];
    for (const [what, account, orderId, itemIds] of cases) {
      const res = await post(account, `/v1/shop/orders/${orderId}/returns`, { itemIds, reason: 'CHANGE_OF_MIND' });
      expect(res.statusCode, `${what}: ${res.payload}`).toBe(404);
      expect(typeOf(res), what).toContain('not-found');
    }
    expect(orders.writes).toBe(writes);
    expect(orders.refunds.size).toBe(refunds);
    expect(payments.calls.cancel.length).toBe(calls);
    expect(orders.items.get(owner.itemId)!.status).toBe('DELIVERED');
    expect(orders.items.get(other.itemId)!.status).toBe('DELIVERED');
  });
});
