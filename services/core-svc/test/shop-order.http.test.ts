// 굿즈 주문 HTTP 시험(메모리 어댑터, BUILD_ORDER LCH-010·LCH-020, ADR-0300 결정 4·5·8, ADR-0301 결정 4, ADR-0313·0314, P-T57 ⑥⑦, P-T56 ⑤, P-T59 ①③, P-T60 ①).
// 단언 값은 정본에서 가져온다: openapi createShopOrder 422 ①~⑥·409 type 이름, ADR-0300 결정 4(한도 = 이 주문 + PAID·결제 접수한 주문 ≤ perAccountLimit,
// 금액 = 가격 × 수량 + 택배 배송비 한 번), 결정 5(시도 3회), ADR-0313(택배는 에스크로 상점, 간편결제·휴대폰 제외, 결제창에 escrowProducts),
// ADR-0314(굿즈 가상계좌, 입금 기한 = 다음 날 23:59 KST [가정]), 결정 8(남의 주문·없는 주문은 같은 404 not-found),
// ADR-0301 결정 4(현장 수령 시간대: 끝난 시간대 ends_at ≤ 지금, 남의 상품 시간대, 티켓 소지자 전용 → 422 pickup-slot-unavailable, 확인 못 함 503).
// 한도·가격은 코드 기본값과 다르게 고른다(한도 2, 가격 12,300원, 동의 문안 판 'v2026.11-10', 입금 기한은 시계에서 계산).
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import {
  MemoryHeldTickets,
  MemoryMerchPayments,
  MemoryMerchStock,
  MemoryProductStore,
  MemoryShopOrderStore,
  type ProductRecord,
} from '../src/modules/shop/index.js';
import type { CheckoutAnswer, CheckoutQuery } from '../src/modules/shop/domain/merch-ports.js';
import { FakeIdentity, fan, NOW_MS, quiet } from './support.js';

const CONSENT = 'v2026.11-10';
const SELLER = randomUUID();
const OTHER_SELLER = randomUUID();
const EVENT = randomUUID();
const OTHER_EVENT = randomUUID();
const clock = fakeClock({ now: NOW_MS });

/** 결제사가 돌려준 허용 수단을 상점별로 거르는지 본다(에스크로면 EASY_PAY가 빠지고 가상계좌가 남는다, ADR-0313) */
class VaPayments extends MemoryMerchPayments {
  override async prepareCheckout(q: CheckoutQuery): Promise<CheckoutAnswer> {
    const a = await super.prepareCheckout(q);
    return { ...a, allowedPayMethods: ['CARD', 'VIRTUAL_ACCOUNT', 'EASY_PAY'] };
  }
}

const products = new MemoryProductStore();
const orders = new MemoryShopOrderStore(products);
const stock = new MemoryMerchStock();
const payments = new VaPayments(() => clock.now());
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
beforeEach(() => {
  held.failing = false;
  stock.failing = false;
});

function product(o: Partial<ProductRecord> = {}): ProductRecord {
  const p: ProductRecord = {
    productId: randomUUID(),
    promoterId: SELLER,
    type: 'MERCH',
    name: '응원봉',
    status: 'PUBLISHED',
    price: 12_300,
    shippingFee: 3_000,
    returnShippingFee: 3_000,
    returnAddress: '서울특별시 마포구',
    limitedQty: null,
    stock: null,
    transferable: false,
    ticketLinked: false,
    linkedEventId: null,
    fulfillments: ['DELIVERY', 'PICKUP'],
    saleStartsAt: null,
    saleEndsAt: null,
    commissionRateBp: 1000,
    attributes: {},
    schemaVersion: 1,
    version: 1,
    publishedAt: new Date(NOW_MS - 86_400_000),
    updatedAt: new Date(NOW_MS - 86_400_000),
    ...o,
  };
  products.rows.set(p.productId, p);
  return p;
}

function slot(productId: string, o: { eventId?: string; endsAt?: number; ticketHoldersOnly?: boolean } = {}): string {
  const slotId = randomUUID();
  const endsAt = o.endsAt ?? clock.now() + 3 * 86_400_000;
  orders.slots.set(slotId, { slotId, productId, eventId: o.eventId ?? EVENT, startsAt: new Date(endsAt - 3_600_000), endsAt: new Date(endsAt), ticketHoldersOnly: o.ticketHoldersOnly ?? false });
  return slotId;
}

const h = (account: string) => ({ ...fan(account), 'content-type': 'application/json', 'idempotency-key': randomUUID() });
const post = (account: string, url: string, body: unknown) => svc.http.inject({ method: 'POST', url, headers: h(account), payload: JSON.stringify(body) });
const get = (account: string, url: string) => svc.http.inject({ method: 'GET', url, headers: fan(account) });
const pickupOrder = (account: string, items: { productId: string; quantity: number; options?: Record<string, string> }[], pickupSlotId: string) =>
  post(account, '/v1/shop/orders', { fulfillment: 'PICKUP', items, pickupSlotId });
const deliveryOrder = (account: string, items: { productId: string; quantity: number; options?: Record<string, string> }[], consents?: Record<string, unknown>) =>
  post(account, '/v1/shop/orders', {
    fulfillment: 'DELIVERY',
    items,
    delivery: { recipientName: '김피켓', recipientPhone: '01012345678', postalCode: '04001', address: '서울특별시 마포구 월드컵로 1' },
    ...(consents === undefined ? {} : { consents }),
  });
const okConsent = { provisionToSeller: true, consentVersion: CONSENT };
const typeOf = (res: { payload: string }) => String(JSON.parse(res.payload).type);
const problem = (res: { statusCode: number; payload: string }) => {
  const b = JSON.parse(res.payload);
  return { status: res.statusCode, type: b.type, title: b.title };
};

/** 다음 날 23:59 KST(ms). 정본의 식(ADR-0314)으로 계산하고 구현 상수를 가져오지 않는다 */
function nextDay2359Kst(ms: number): number {
  const kst = new Date(ms + 9 * 3_600_000);
  return Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() + 1, 23, 59, 0, 0) - 9 * 3_600_000;
}

/** 결제 시도 → 결제 접수까지(시뮬레이터 결제사, 메모리 결제 대역) */
async function accept(account: string, orderId: string): Promise<void> {
  const start = await post(account, `/v1/shop/orders/${orderId}/payments`, {});
  expect(start.statusCode).toBe(201);
  const attempt = JSON.parse(start.payload);
  const amount = orders.orders.get(orderId)!.amount;
  const res = await post(account, `/v1/shop/orders/${orderId}/payment-acceptance`, { pg: attempt.pg, paymentKey: `sim_${orderId.slice(0, 8)}`, amount, attemptId: attempt.attemptId });
  expect(res.statusCode).toBe(202);
}

describe('굿즈 주문 HTTP(P-T57 ⑥⑦)', () => {
  test('P-T57 ⑥ 다른 계정이 그 주문의 상세·결제 시도·결제 접수·결제 상태를 부르면 모두 없는 주문과 같은 404 not-found이고 바뀐 행이 없다 [ASVS v5.0.0-8.2.2]', async () => {
    const owner = randomUUID();
    const intruder = randomUUID();
    const p = product({ name: 'P-T57 ⑥ 상품' });
    const created = await pickupOrder(owner, [{ productId: p.productId, quantity: 1 }], slot(p.productId));
    expect(created.statusCode).toBe(201);
    const orderId = JSON.parse(created.payload).orderId as string;
    const start = await post(owner, `/v1/shop/orders/${orderId}/payments`, {});
    expect(start.statusCode).toBe(201);
    const attempt = JSON.parse(start.payload);
    const missing = randomUUID();
    const notFound = problem(await get(intruder, `/v1/shop/orders/${missing}`));
    expect(notFound).toMatchObject({ status: 404 });
    expect(String(notFound.type)).toContain('not-found');

    const writes = orders.writes;
    const checkouts = payments.calls.checkout.length;
    const confirms = payments.calls.confirm.length;
    const amount = orders.orders.get(orderId)!.amount;
    const accBody = { pg: attempt.pg, paymentKey: 'sim_intruder', amount, attemptId: attempt.attemptId };
    const calls = [
      () => get(intruder, `/v1/shop/orders/${orderId}`),
      () => post(intruder, `/v1/shop/orders/${orderId}/payments`, {}),
      () => post(intruder, `/v1/shop/orders/${orderId}/payment-acceptance`, accBody),
      () => get(intruder, `/v1/shop/orders/${orderId}/payment-status`),
    ];
    const missingCalls = [
      () => get(intruder, `/v1/shop/orders/${missing}`),
      () => post(intruder, `/v1/shop/orders/${missing}/payments`, {}),
      () => post(intruder, `/v1/shop/orders/${missing}/payment-acceptance`, accBody),
      () => get(intruder, `/v1/shop/orders/${missing}/payment-status`),
    ];
    for (let i = 0; i < calls.length; i++) {
      const mine = problem(await calls[i]!());
      const none = problem(await missingCalls[i]!());
      expect(mine, `호출 ${i}`).toEqual(notFound);
      expect(none, `없는 주문 호출 ${i}`).toEqual(notFound);
    }
    expect(orders.writes).toBe(writes);
    expect(payments.calls.checkout.length).toBe(checkouts);
    expect(payments.calls.confirm.length).toBe(confirms);
    expect(orders.orders.get(orderId)!.status).toBe('CREATED');
    expect([...orders.attempts.values()].filter((a) => a.orderId === orderId).map((a) => a.status)).toEqual(['READY']);
    const list = JSON.parse((await get(intruder, '/v1/shop/orders')).payload);
    expect(list.items).toEqual([]);

    // 주인은 볼 수 있다(대조군). 접수 전 결제 상태는 409 payment-not-accepted
    expect((await get(owner, `/v1/shop/orders/${orderId}`)).statusCode).toBe(200);
    const st = await get(owner, `/v1/shop/orders/${orderId}/payment-status`);
    expect(st.statusCode).toBe(409);
    expect(typeOf(st)).toContain('payment-not-accepted');
  });

  test('P-T57 ⑥ 결제를 접수한 뒤에도 다른 계정의 결제 상태 조회는 404 not-found다(결제 상태의 계정 대조)', async () => {
    const owner = randomUUID();
    const p = product({ name: 'P-T57 ⑥ 접수 뒤' });
    const orderId = JSON.parse((await pickupOrder(owner, [{ productId: p.productId, quantity: 1 }], slot(p.productId))).payload).orderId as string;
    await accept(owner, orderId);
    const mine = await get(owner, `/v1/shop/orders/${orderId}/payment-status`);
    expect(mine.statusCode).toBe(200);
    expect(JSON.parse(mine.payload).status).toBe('ACCEPTED');
    const other = await get(randomUUID(), `/v1/shop/orders/${orderId}/payment-status`);
    expect(other.statusCode).toBe(404);
    expect(typeOf(other)).toContain('not-found');
  });

  test('P-T57 ⑦ 계정당 한도 2: 한 주문 2개는 통과, 3개는 422 merch-quantity-limit-exceeded다', async () => {
    const p = product({ name: '한도 2', attributes: { perAccountLimit: 2 } });
    const s = slot(p.productId);
    const three = await pickupOrder(randomUUID(), [{ productId: p.productId, quantity: 3 }], s);
    expect(three.statusCode).toBe(422);
    expect(typeOf(three)).toContain('merch-quantity-limit-exceeded');
    expect((await pickupOrder(randomUUID(), [{ productId: p.productId, quantity: 2 }], s)).statusCode).toBe(201);
  });

  test('P-T57 ⑦ 계정당 한도 2: 결제 접수했지만 아직 CREATED인 주문 1개 + 1개는 통과하고, 2개 접수 뒤 1개 더는 422다', async () => {
    const account = randomUUID();
    const p = product({ name: '한도 2 접수', attributes: { perAccountLimit: 2 } });
    const s = slot(p.productId);
    const first = JSON.parse((await pickupOrder(account, [{ productId: p.productId, quantity: 1 }], s)).payload).orderId as string;
    await accept(account, first);
    expect(orders.orders.get(first)!.status).toBe('CREATED');
    const second = await pickupOrder(account, [{ productId: p.productId, quantity: 1 }], s);
    expect(second.statusCode).toBe(201);
    await accept(account, JSON.parse(second.payload).orderId);
    const third = await pickupOrder(account, [{ productId: p.productId, quantity: 1 }], s);
    expect(third.statusCode).toBe(422);
    expect(typeOf(third)).toContain('merch-quantity-limit-exceeded');
    // 다른 계정은 한도와 무관하다
    expect((await pickupOrder(randomUUID(), [{ productId: p.productId, quantity: 2 }], s)).statusCode).toBe(201);
  });

  test('P-T57 ⑦ 계정당 한도 2: PAID 주문 2개 뒤 1개 더는 422이고, 결제 접수 전 주문은 한도에 세지 않는다', async () => {
    const account = randomUUID();
    const p = product({ name: '한도 2 PAID', attributes: { perAccountLimit: 2 } });
    const s = slot(p.productId);
    const paid = JSON.parse((await pickupOrder(account, [{ productId: p.productId, quantity: 2 }], s)).payload).orderId as string;
    // 결제 접수 전(CREATED, 시도 없음) 주문은 세지 않는다: 2개 더 주문할 수 있다
    expect((await pickupOrder(account, [{ productId: p.productId, quantity: 2 }], s)).statusCode).toBe(201);
    orders.orders.get(paid)!.status = 'PAID';
    const more = await pickupOrder(account, [{ productId: p.productId, quantity: 1 }], s);
    expect(more.statusCode).toBe(422);
    expect(typeOf(more)).toContain('merch-quantity-limit-exceeded');
  });

  // 리뷰 반영 RV-02(ADR-0300 결정 4, P-T57 ⑦): '이 주문 수량'은 상품 ID마다 그 상품의 모든 줄(옵션·수량만 다른 줄 포함) 합이다.
  test('P-T57 ⑦ 계정당 한도 2: 같은 상품을 수량만 다른 두 줄(1개·2개)로 보내면 422 merch-quantity-limit-exceeded이고 저장·예약이 없다', async () => {
    const p = product({ name: '한도 2 두 줄', attributes: { perAccountLimit: 2 }, limitedQty: 5, stock: 5 });
    const writes = orders.writes;
    const reserve = vi.spyOn(stock, 'reserve');
    try {
      const res = await pickupOrder(randomUUID(), [{ productId: p.productId, quantity: 1 }, { productId: p.productId, quantity: 2 }], slot(p.productId));
      expect(res.statusCode).toBe(422);
      expect(typeOf(res)).toContain('merch-quantity-limit-exceeded');
      expect(orders.writes).toBe(writes);
      expect(reserve).not.toHaveBeenCalled();
      expect(stock.slots.get(p.productId)?.resv.size ?? 0).toBe(0);
    } finally {
      reserve.mockRestore();
    }
  });

  test('P-T57 ⑦ 계정당 한도 2: 옵션만 다른 두 줄(1개·2개)도 422 merch-quantity-limit-exceeded다', async () => {
    const p = product({ name: '한도 2 옵션 두 줄', attributes: { perAccountLimit: 2, options: [{ name: '색상', values: ['빨강', '파랑'] }] } });
    const writes = orders.writes;
    const res = await pickupOrder(
      randomUUID(),
      [
        { productId: p.productId, quantity: 1, options: { 색상: '빨강' } },
        { productId: p.productId, quantity: 2, options: { 색상: '파랑' } },
      ],
      slot(p.productId),
    );
    expect(res.statusCode).toBe(422);
    expect(typeOf(res)).toContain('merch-quantity-limit-exceeded');
    expect(orders.writes).toBe(writes);
  });

  test('P-T57 ⑦ 계정당 한도 2: 같은 상품 두 줄 합 2(1개·1개)는 201이다', async () => {
    const p = product({ name: '한도 2 합 2', attributes: { perAccountLimit: 2, options: [{ name: '색상', values: ['빨강', '파랑'] }] } });
    const res = await pickupOrder(
      randomUUID(),
      [
        { productId: p.productId, quantity: 1, options: { 색상: '빨강' } },
        { productId: p.productId, quantity: 1, options: { 색상: '파랑' } },
      ],
      slot(p.productId),
    );
    expect(res.statusCode, res.payload).toBe(201);
  });

  test('P-T57 ⑦ 계정당 한도 2: 이미 결제한 1개가 있으면 같은 상품 두 줄(1개·1개)은 합 3이라 422 merch-quantity-limit-exceeded다', async () => {
    const account = randomUUID();
    const p = product({ name: '한도 2 결제 1 + 두 줄', attributes: { perAccountLimit: 2, options: [{ name: '색상', values: ['빨강', '파랑'] }] } });
    const s = slot(p.productId);
    const paid = await pickupOrder(account, [{ productId: p.productId, quantity: 1, options: { 색상: '빨강' } }], s);
    expect(paid.statusCode).toBe(201);
    orders.orders.get(JSON.parse(paid.payload).orderId)!.status = 'PAID';
    const writes = orders.writes;
    const res = await pickupOrder(
      account,
      [
        { productId: p.productId, quantity: 1, options: { 색상: '빨강' } },
        { productId: p.productId, quantity: 1, options: { 색상: '파랑' } },
      ],
      s,
    );
    expect(res.statusCode).toBe(422);
    expect(typeOf(res)).toContain('merch-quantity-limit-exceeded');
    expect(orders.writes).toBe(writes);
  });

  test('P-T57 ⑦ 옵션 밖의 값·옵션 빠짐·상품에 없는 옵션은 422 merch-options-invalid이고 맞는 옵션은 통과한다', async () => {
    const p = product({ name: '옵션 상품', attributes: { options: [{ name: '색상', values: ['빨강', '파랑'] }, { name: '사이즈', values: ['S'] }] } });
    const s = slot(p.productId);
    const writes = orders.writes;
    const cases: (Record<string, string> | undefined)[] = [{ 색상: '초록', 사이즈: 'S' }, { 색상: '빨강' }, undefined, { 색상: '빨강', 사이즈: 'S', 각인: '가' }];
    for (const options of cases) {
      const res = await pickupOrder(randomUUID(), [{ productId: p.productId, quantity: 1, ...(options ? { options } : {}) }], s);
      expect(res.statusCode, JSON.stringify(options)).toBe(422);
      expect(typeOf(res)).toContain('merch-options-invalid');
    }
    expect(orders.writes).toBe(writes);
    const good = await pickupOrder(randomUUID(), [{ productId: p.productId, quantity: 1, options: { 색상: '파랑', 사이즈: 'S' } }], s);
    expect(good.statusCode).toBe(201);
    const item = [...orders.items.values()].find((i) => i.orderId === JSON.parse(good.payload).orderId)!;
    expect(item.optionSnapshot.options).toEqual({ 색상: '파랑', 사이즈: 'S' });
  });

  test('P-T57 ⑦ 판매자가 다른 두 상품을 한 주문에 담으면 422 merch-order-mixed다', async () => {
    const a = product({ name: '판매자 A' });
    const b = product({ name: '판매자 B', promoterId: OTHER_SELLER });
    const res = await deliveryOrder(randomUUID(), [{ productId: a.productId, quantity: 1 }, { productId: b.productId, quantity: 1 }], okConsent);
    expect(res.statusCode).toBe(422);
    expect(typeOf(res)).toContain('merch-order-mixed');
  });

  test('P-T57 ⑦ 수령 방식이 다른 상품(택배만·현장 수령만)을 한 주문에 담으면 그 수령 방식을 받지 않는 상품이라 422 merch-product-unavailable다', async () => {
    const a = product({ name: '택배만', fulfillments: ['DELIVERY'] });
    const b = product({ name: '현장 수령만', fulfillments: ['PICKUP'] });
    const res = await deliveryOrder(randomUUID(), [{ productId: a.productId, quantity: 1 }, { productId: b.productId, quantity: 1 }], okConsent);
    expect(res.statusCode).toBe(422);
    // 수령 방식은 본문 하나라 그 수령 방식을 받지 않는 상품은 ⑥, ①(merch-order-mixed)은 판매자가 다를 때만이다(ADR-0300 결정 4, 계획 '시험 이의' E-2 판정)
    expect(typeOf(res)).toContain('merch-product-unavailable');
    expect(typeOf(res)).not.toContain('merch-order-mixed');
  });

  test('P-T57 ⑦ 판매 중이 아닌 상품(초안·숨김·판매 전·판매 끝)·티켓 연동 상품·그 수령 방식을 받지 않는 상품·없는 상품은 422 merch-product-unavailable다', async () => {
    const cases: [string, Partial<ProductRecord>][] = [
      ['초안', { status: 'DRAFT' }],
      ['숨김', { status: 'HIDDEN' }],
      ['판매 전', { saleStartsAt: new Date(clock.now() + 60_000) }],
      ['판매 끝', { saleEndsAt: new Date(clock.now() - 1) }],
      ['티켓 연동', { ticketLinked: true, linkedEventId: EVENT, fulfillments: ['WALLET', 'DELIVERY'] }],
      ['수령 방식 미지원', { fulfillments: ['PICKUP'] }],
    ];
    for (const [name, o] of cases) {
      const p = product({ name, ...o });
      const res = await deliveryOrder(randomUUID(), [{ productId: p.productId, quantity: 1 }], okConsent);
      expect(res.statusCode, name).toBe(422);
      expect(typeOf(res), name).toContain('merch-product-unavailable');
    }
    const none = await deliveryOrder(randomUUID(), [{ productId: randomUUID(), quantity: 1 }], okConsent);
    expect(none.statusCode).toBe(422);
    expect(typeOf(none)).toContain('merch-product-unavailable');
  });
});

describe('현장 수령 시간대(ADR-0301 결정 4)', () => {
  test('P-T57 ⑦ 끝난 시간대(ends_at = 지금)는 422 pickup-slot-unavailable이고 지금 + 1ms에 끝나는 시간대는 통과한다', async () => {
    const p = product({ name: '시간대 경계' });
    const ended = await pickupOrder(randomUUID(), [{ productId: p.productId, quantity: 1 }], slot(p.productId, { endsAt: clock.now() }));
    expect(ended.statusCode).toBe(422);
    expect(typeOf(ended)).toContain('pickup-slot-unavailable');
    const past = await pickupOrder(randomUUID(), [{ productId: p.productId, quantity: 1 }], slot(p.productId, { endsAt: clock.now() - 1 }));
    expect(past.statusCode).toBe(422);
    const live = await pickupOrder(randomUUID(), [{ productId: p.productId, quantity: 1 }], slot(p.productId, { endsAt: clock.now() + 1 }));
    expect(live.statusCode).toBe(201);
  });

  test('P-T57 ⑦ 남의 상품 시간대·없는 시간대는 422 pickup-slot-unavailable다', async () => {
    const p = product({ name: '내 상품' });
    const q = product({ name: '남의 상품' });
    for (const s of [slot(q.productId), randomUUID()]) {
      const res = await pickupOrder(randomUUID(), [{ productId: p.productId, quantity: 1 }], s);
      expect(res.statusCode).toBe(422);
      expect(typeOf(res)).toContain('pickup-slot-unavailable');
    }
  });

  test('P-T57 ⑦ 두 상품 주문은 다른 항목 상품에도 같은 회차의 시간대가 있어야 하고 주문 회차는 시간대의 회차다', async () => {
    const a = product({ name: '두 상품 A' });
    const b = product({ name: '두 상품 B' });
    const c = product({ name: '두 상품 C' });
    const sa = slot(a.productId, { eventId: EVENT });
    slot(b.productId, { eventId: EVENT });
    slot(c.productId, { eventId: OTHER_EVENT });
    const ok = await pickupOrder(randomUUID(), [{ productId: a.productId, quantity: 1 }, { productId: b.productId, quantity: 1 }], sa);
    expect(ok.statusCode).toBe(201);
    expect(orders.orders.get(JSON.parse(ok.payload).orderId)!.eventId).toBe(EVENT);
    const bad = await pickupOrder(randomUUID(), [{ productId: a.productId, quantity: 1 }, { productId: c.productId, quantity: 1 }], sa);
    expect(bad.statusCode).toBe(422);
    expect(typeOf(bad)).toContain('pickup-slot-unavailable');
  });

  test('P-T57 ⑦ 티켓 소지자 전용 시간대: 보유 있음은 통과, 없음은 422 pickup-slot-unavailable, 확인 못 함은 503 dependency-unavailable이고 주문·예약이 없다', async () => {
    const p = product({ name: '전용 시간대', limitedQty: 3, stock: 3 });
    stock.setCounter(p.productId, 3);
    const s = slot(p.productId, { ticketHoldersOnly: true, eventId: EVENT });
    const holder = randomUUID();
    held.set(holder, EVENT, [randomUUID()]);
    const yes = await pickupOrder(holder, [{ productId: p.productId, quantity: 1 }], s);
    expect(yes.statusCode).toBe(201);
    expect(held.calls.at(-1)).toEqual({ accountId: holder, eventId: EVENT });

    const before = orders.orders.size;
    const no = await pickupOrder(randomUUID(), [{ productId: p.productId, quantity: 1 }], s);
    expect(no.statusCode).toBe(422);
    expect(typeOf(no)).toContain('pickup-slot-unavailable');

    held.failing = true;
    const down = await pickupOrder(holder, [{ productId: p.productId, quantity: 1 }], s);
    expect(down.statusCode).toBe(503);
    expect(typeOf(down)).toContain('dependency-unavailable');
    expect(orders.orders.size).toBe(before);
    // 예약은 첫 주문 하나뿐이고 카운터는 3 − 1 = 2
    expect(stock.slots.get(p.productId)!.resv.size).toBe(1);
    expect(stock.slots.get(p.productId)!.stock).toBe(2);
  });
});

describe('택배 주문(ADR-0301 결정 4, ADR-0300 결정 4·5)', () => {
  test('P-T57 ⑦ 동의가 없거나 provisionToSeller가 false·빠짐이거나 문안 판이 없으면 422 consent-required다', async () => {
    const p = product({ name: '택배 동의' });
    const before = orders.orders.size;
    for (const c of [undefined, { provisionToSeller: false, consentVersion: CONSENT }, { consentVersion: CONSENT }, { provisionToSeller: true }]) {
      const res = await deliveryOrder(randomUUID(), [{ productId: p.productId, quantity: 1 }], c);
      expect(res.statusCode, JSON.stringify(c)).toBe(422);
      expect(typeOf(res)).toContain('consent-required');
    }
    expect(orders.orders.size).toBe(before);
  });

  test('P-T57 ⑦ 동의 문안 판이 지금 판과 다르면 422 consent-version-outdated다', async () => {
    const p = product({ name: '택배 문안 판' });
    for (const v of ['v2026.11-1', 'v2026.11-9', '2026-10-30']) {
      const res = await deliveryOrder(randomUUID(), [{ productId: p.productId, quantity: 1 }], { provisionToSeller: true, consentVersion: v });
      expect(res.statusCode, v).toBe(422);
      expect(typeOf(res)).toContain('consent-version-outdated');
    }
  });

  // BAT-605가 503을 지웠다(ADR-0313, P-T57 ⑩ 뒤집힘). 택배 주문은 201로 만들어지고 paymentStore가 ESCROW이며 한정 상품은 예약된다.
  test('P-T57 ⑩ 택배 주문은 201로 만들어지고 paymentStore가 ESCROW이며 한정 상품이 예약된다(503 pg-unavailable 없음)', async () => {
    const a = product({ name: '택배 한정 A', price: 12_300, shippingFee: 3_000, limitedQty: 3, stock: 3 });
    const b = product({ name: '택배 B', price: 4_100, shippingFee: 3_000 });
    stock.setCounter(a.productId, 3);
    const writes = orders.writes;
    const count = orders.orders.size;
    const reserve = vi.spyOn(stock, 'reserve');
    try {
      const res = await deliveryOrder(randomUUID(), [{ productId: a.productId, quantity: 2 }, { productId: b.productId, quantity: 1 }], okConsent);
      expect(res.statusCode, res.payload).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.paymentStore).toBe('ESCROW');
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(orders.writes).toBe(writes + 1);
      expect(orders.orders.size).toBe(count + 1);
      const o = orders.orders.get(body.orderId)!;
      expect(o).toMatchObject({ fulfillment: 'DELIVERY', pgStore: 'ESCROW', escrow: false, status: 'CREATED' });
      expect(o.amount).toBe(12_300 * 2 + 4_100 + 3_000);
      expect(stock.slots.get(a.productId)!.resv.size).toBe(1);
    } finally {
      reserve.mockRestore();
    }
  });

  test('P-T57 ⑩ 택배 주문의 동의 없음은 여전히 422 consent-required이고 본문 검사 400·업무 규칙 422도 결제 시도보다 먼저다', async () => {
    const p = product({ name: '택배 검사 먼저', limitedQty: 3, stock: 3, attributes: { perAccountLimit: 2 } });
    const noConsent = await deliveryOrder(randomUUID(), [{ productId: p.productId, quantity: 1 }]);
    expect(noConsent.statusCode).toBe(422);
    expect(typeOf(noConsent)).toContain('consent-required');
    const outdated = await deliveryOrder(randomUUID(), [{ productId: p.productId, quantity: 1 }], { provisionToSeller: true, consentVersion: 'v2026.11-9' });
    expect(outdated.statusCode).toBe(422);
    expect(typeOf(outdated)).toContain('consent-version-outdated');
    const overLimit = await deliveryOrder(randomUUID(), [{ productId: p.productId, quantity: 3 }], okConsent);
    expect(overLimit.statusCode).toBe(422);
    expect(typeOf(overLimit)).toContain('merch-quantity-limit-exceeded');
    const unknownField = await post(randomUUID(), '/v1/shop/orders', {
      fulfillment: 'DELIVERY',
      items: [{ productId: p.productId, quantity: 1 }],
      delivery: { recipientName: '김피켓', recipientPhone: '01012345678', postalCode: '04001', address: '서울특별시 마포구 월드컵로 1' },
      consents: okConsent,
      amount: 1,
    });
    expect(unknownField.statusCode).toBe(400);
    expect(stock.slots.get(p.productId)?.resv.size ?? 0).toBe(0);
  });

  test('P-T57 ⑦ 현장 수령 주문 금액에는 배송비가 없고 결제 상점은 일반이다', async () => {
    const a = product({ name: '현장 금액', price: 12_300, shippingFee: 3_000 });
    const res = await pickupOrder(randomUUID(), [{ productId: a.productId, quantity: 3 }], slot(a.productId));
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.payload).paymentStore).toBe('STANDARD');
    const o = orders.orders.get(JSON.parse(res.payload).orderId)!;
    expect(o.amount).toBe(36_900);
    expect(o.shippingFee).toBe(0);
  });

  // BAT-605가 뒤집었다(ADR-0313). 택배 주문의 결제 시도 시작은 201이고 결제창 준비에 에스크로 상점·상품·가상계좌 허용을 넘긴다.
  test('P-T56 ⑤ 택배 주문의 결제 시도는 201이고 PrepareCheckout에 ESCROW 상점·에스크로 상품·가상계좌 허용을 넘긴다', async () => {
    const account = randomUUID();
    const p = product({ name: '택배 결제', price: 12_300, shippingFee: 3_000 });
    const created = await deliveryOrder(account, [{ productId: p.productId, quantity: 2 }], okConsent);
    expect(created.statusCode, created.payload).toBe(201);
    const orderId = JSON.parse(created.payload).orderId as string;
    const calls = payments.calls.checkout.length;
    const res = await post(account, `/v1/shop/orders/${orderId}/payments`, {});
    expect(res.statusCode, res.payload).toBe(201);
    expect(payments.calls.checkout.length).toBe(calls + 1);
    const q = payments.calls.checkout.at(-1)!;
    expect(q).toMatchObject({ orderId, amount: 27_600, pgStore: 'ESCROW', virtualAccountAllowed: true });
    expect(q.escrowProducts).toEqual([{ id: p.productId, name: '택배 결제', code: '', unitPrice: 12_300, quantity: 2 }]);
    const body = JSON.parse(res.payload);
    expect(body.depositDueAt).toBe(new Date(nextDay2359Kst(clock.now())).toISOString());
    expect([...orders.attempts.values()].filter((a) => a.orderId === orderId).map((a) => a.status)).toEqual(['READY']);
  });
});

describe('굿즈 결제 시도(ADR-0300 결정 5, ADR-0299 결정 3)', () => {
  test('P-T56 ⑤ 결제 시도는 PrepareCheckout에 주문 금액과 시간대 회차를 넘기고 응답 허용 수단에 가상계좌가 있다(ADR-0314)', async () => {
    const account = randomUUID();
    const p = product({ name: '결제 시도', price: 12_300 });
    const orderId = JSON.parse((await pickupOrder(account, [{ productId: p.productId, quantity: 2 }], slot(p.productId, { eventId: OTHER_EVENT }))).payload).orderId as string;
    const res = await post(account, `/v1/shop/orders/${orderId}/payments`, {});
    expect(res.statusCode).toBe(201);
    const q = payments.calls.checkout.at(-1)!;
    expect(q).toMatchObject({ orderId, amount: 24_600, eventId: OTHER_EVENT });
    const body = JSON.parse(res.payload);
    expect(body.allowedPayMethods).toEqual(['CARD', 'VIRTUAL_ACCOUNT', 'EASY_PAY']);
    expect(body.checkout.successUrl).toContain('/shop/checkout/return?order=');
  });

  test('P-T56 ⑤ 수단 VIRTUAL_ACCOUNT 결제 시도는 201이고 결제창 준비를 부르며 READY 시도·입금 기한이 생긴다', async () => {
    const account = randomUUID();
    const p = product({ name: '가상계좌' });
    const orderId = JSON.parse((await pickupOrder(account, [{ productId: p.productId, quantity: 1 }], slot(p.productId))).payload).orderId as string;
    const calls = payments.calls.checkout.length;
    const res = await post(account, `/v1/shop/orders/${orderId}/payments`, { payMethod: 'VIRTUAL_ACCOUNT' });
    expect(res.statusCode, res.payload).toBe(201);
    expect(payments.calls.checkout.length).toBe(calls + 1);
    expect(payments.calls.checkout.at(-1)).toMatchObject({ payMethod: 'VIRTUAL_ACCOUNT', virtualAccountAllowed: true });
    expect(JSON.parse(res.payload).depositDueAt).toBe(new Date(nextDay2359Kst(clock.now())).toISOString());
    expect([...orders.attempts.values()].filter((a) => a.orderId === orderId).map((a) => a.status)).toEqual(['READY']);
  });

  test('P-T57 ⑦ 결제 시도는 주문마다 3회까지이고 4번째는 409 payment-attempts-exceeded이며 이전 READY 시도는 SUPERSEDED다', async () => {
    const account = randomUUID();
    const p = product({ name: '시도 3회' });
    const orderId = JSON.parse((await pickupOrder(account, [{ productId: p.productId, quantity: 1 }], slot(p.productId))).payload).orderId as string;
    for (let i = 0; i < 3; i++) expect((await post(account, `/v1/shop/orders/${orderId}/payments`, {})).statusCode, `시도 ${i + 1}`).toBe(201);
    const fourth = await post(account, `/v1/shop/orders/${orderId}/payments`, {});
    expect(fourth.statusCode).toBe(409);
    expect(typeOf(fourth)).toContain('payment-attempts-exceeded');
    const statuses = [...orders.attempts.values()].filter((a) => a.orderId === orderId).sort((a, b) => a.attemptNo - b.attemptNo).map((a) => a.status);
    expect(statuses).toEqual(['SUPERSEDED', 'SUPERSEDED', 'READY']);
  });

  test('P-T42 ① 재고 예약이 끝난 주문(주문 + 15분)의 결제 시도는 409 order-expired이고 15분 − 1ms에는 시작된다', async () => {
    const account = randomUUID();
    const p = product({ name: '예약 경계', limitedQty: 3, stock: 3 });
    stock.setCounter(p.productId, 3);
    const created = await pickupOrder(account, [{ productId: p.productId, quantity: 1 }], slot(p.productId));
    expect(created.statusCode).toBe(201);
    const body = JSON.parse(created.payload);
    expect(Date.parse(body.stockReservedUntil)).toBe(clock.now() + 15 * 60_000);
    const orderId = body.orderId as string;
    clock.advance(15 * 60_000 - 1);
    expect((await post(account, `/v1/shop/orders/${orderId}/payments`, {})).statusCode).toBe(201);
    clock.advance(1);
    const late = await post(account, `/v1/shop/orders/${orderId}/payments`, {});
    expect(late.statusCode).toBe(409);
    expect(typeOf(late)).toContain('order-expired');
  });
});

// BAT-605 택배 에스크로·굿즈 가상계좌(ADR-0313·0314, P-T59 ①③, P-T60 ①). 값은 정본에서:
// 에스크로 허용 수단은 카드·계좌이체·가상계좌(간편결제·휴대폰 없음), 결제창 상품은 상품 ID·이름·단가·수량, 입금 기한은 다음 날 23:59 KST [가정]이다.
// 결제사 대역은 EASY_PAY까지 돌려주어 코어가 상점별로 거르는지 본다.
describe('택배 결제대금예치·굿즈 가상계좌(P-T59 ①③, P-T60 ①)', () => {
  test('P-T59 ① 택배 결제 시도는 201이고 paymentStore=ESCROW·checkout.escrowProducts(이름·단가·수량)·허용 수단(가상계좌 있음, EASY_PAY·MOBILE 없음)이다', async () => {
    const account = randomUUID();
    const a = product({ name: '응원봉', price: 12_300, shippingFee: 3_000 });
    const b = product({ name: '포토카드', price: 4_100, shippingFee: 3_000 });
    const created = await deliveryOrder(account, [{ productId: a.productId, quantity: 2 }, { productId: b.productId, quantity: 1 }], okConsent);
    expect(created.statusCode, created.payload).toBe(201);
    expect(JSON.parse(created.payload).paymentStore).toBe('ESCROW');
    const orderId = JSON.parse(created.payload).orderId as string;
    const res = await post(account, `/v1/shop/orders/${orderId}/payments`, {});
    expect(res.statusCode, res.payload).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.pg).toBe('SIMULATOR');
    expect(body.checkout.escrowProducts).toHaveLength(2);
    expect(body.checkout.escrowProducts).toEqual(
      expect.arrayContaining([
        { id: a.productId, name: '응원봉', code: '', unitPrice: 12_300, quantity: 2 },
        { id: b.productId, name: '포토카드', code: '', unitPrice: 4_100, quantity: 1 },
      ]),
    );
    expect(body.allowedPayMethods).toContain('VIRTUAL_ACCOUNT');
    expect(body.allowedPayMethods).not.toContain('EASY_PAY');
    expect(body.allowedPayMethods).not.toContain('MOBILE');
    expect(body.allowedPayMethods).toEqual(['CARD', 'VIRTUAL_ACCOUNT']);
    expect(body).not.toHaveProperty('useEscrow');
    expect(body.checkout).not.toHaveProperty('useEscrow');
  });

  test('P-T59 ③ 에스크로 주문에 EASY_PAY·MOBILE을 보내면 결제사 호출 전 400 checkout_invalid이고 VIRTUAL_ACCOUNT는 201이며 useEscrow가 없다', async () => {
    const account = randomUUID();
    const p = product({ name: '에스크로 수단', shippingFee: 3_000 });
    const orderId = JSON.parse((await deliveryOrder(account, [{ productId: p.productId, quantity: 1 }], okConsent)).payload).orderId as string;
    const writes = orders.writes;
    const calls = payments.calls.checkout.length;
    // 400 본문은 guidelines §2대로 about:blank이고, 코어의 업무 이름표는 checkout_invalid다(결제사를 부르기 전에 막는다)
    for (const payMethod of ['EASY_PAY', 'MOBILE']) {
      const res = await post(account, `/v1/shop/orders/${orderId}/payments`, { payMethod });
      expect(res.statusCode, payMethod).toBe(400);
    }
    expect(payments.calls.checkout.length, '코어가 결제사를 부르기 전에 막는다').toBe(calls);
    expect([...orders.attempts.values()].filter((a) => a.orderId === orderId)).toEqual([]);
    expect(orders.writes).toBe(writes);
    const ok = await post(account, `/v1/shop/orders/${orderId}/payments`, { payMethod: 'VIRTUAL_ACCOUNT' });
    expect(ok.statusCode, ok.payload).toBe(201);
    const body = JSON.parse(ok.payload);
    expect(body.allowedPayMethods).toContain('VIRTUAL_ACCOUNT');
    expect(body).not.toHaveProperty('useEscrow');
    expect(body.checkout).not.toHaveProperty('useEscrow');
  });

  test('P-T60 ① 굿즈 현장 수령·택배 주문의 VIRTUAL_ACCOUNT 결제 시도는 201이고 허용 수단에 가상계좌, depositDueAt = 다음 날 23:59 KST다', async () => {
    const expected = new Date(nextDay2359Kst(clock.now())).toISOString();
    const pickupAccount = randomUUID();
    const pickProduct = product({ name: '현장 VA', fulfillments: ['PICKUP'] });
    const pickupId = JSON.parse((await pickupOrder(pickupAccount, [{ productId: pickProduct.productId, quantity: 1 }], slot(pickProduct.productId))).payload).orderId as string;
    const pick = await post(pickupAccount, `/v1/shop/orders/${pickupId}/payments`, { payMethod: 'VIRTUAL_ACCOUNT' });
    expect(pick.statusCode, pick.payload).toBe(201);
    const pickBody = JSON.parse(pick.payload);
    expect(pickBody.allowedPayMethods).toContain('VIRTUAL_ACCOUNT');
    expect(pickBody.depositDueAt).toBe(expected);

    const deliveryAccount = randomUUID();
    const deliveryProduct = product({ name: '택배 VA', shippingFee: 3_000 });
    const deliveryId = JSON.parse((await deliveryOrder(deliveryAccount, [{ productId: deliveryProduct.productId, quantity: 1 }], okConsent)).payload).orderId as string;
    const del = await post(deliveryAccount, `/v1/shop/orders/${deliveryId}/payments`, { payMethod: 'VIRTUAL_ACCOUNT' });
    expect(del.statusCode, del.payload).toBe(201);
    const delBody = JSON.parse(del.payload);
    expect(delBody.allowedPayMethods).toContain('VIRTUAL_ACCOUNT');
    expect(delBody.depositDueAt).toBe(expected);
  });
});

// 검증(6a675242)이 놓친 틀린 구현을 잡는 시험(메모리 어댑터). 값은 정본에서: ADR-0300 결정 4(한도는 상품 ID마다 모든 줄 합 + PAID·결제 접수한 주문, 취소·환급 항목은 세지 않음,
// 한정 상품은 상품마다 합한 수량으로 예약), ADR-0301 결정 4(고른 시간대는 주문 항목 상품 가운데 하나의 시간대), ADR-0300 결정 5(결제 접수는 READY 시도와 맞아야 함, 아니면 409)
describe('검증 놓침 보강(P-T57 ③⑦, ASVS 2.3.1)', () => {
  test('P-T57 ③⑦ 한정 상품을 옵션만 다른 두 줄(1개·1개)로 주문하면 예약 수량은 합 2이고 카운터는 5 − 2 = 3이다', async () => {
    const p = product({ name: '한정 두 줄 예약', limitedQty: 5, stock: 5, attributes: { options: [{ name: '색상', values: ['빨강', '파랑'] }] } });
    stock.setCounter(p.productId, 5);
    const res = await pickupOrder(
      randomUUID(),
      [
        { productId: p.productId, quantity: 1, options: { 색상: '빨강' } },
        { productId: p.productId, quantity: 1, options: { 색상: '파랑' } },
      ],
      slot(p.productId),
    );
    expect(res.statusCode, res.payload).toBe(201);
    const orderId = JSON.parse(res.payload).orderId as string;
    const s = stock.slots.get(p.productId)!;
    expect(s.resvQty.get(orderId)).toBe(2);
    expect(s.stock).toBe(3);
    expect(s.resv.has(orderId)).toBe(true);
  });

  test('P-T57 ⑦ 계정당 한도 2: PAID 2개 가운데 1개가 미수령 취소·환급된 뒤에는 1개 더 사면 201이고, 그다음 1개는 422 merch-quantity-limit-exceeded다', async () => {
    const account = randomUUID();
    const p = product({ name: '한도 2 취소 뒤', attributes: { perAccountLimit: 2 } });
    const s = slot(p.productId);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await pickupOrder(account, [{ productId: p.productId, quantity: 1 }], s);
      expect(r.statusCode).toBe(201);
      ids.push(JSON.parse(r.payload).orderId as string);
    }
    for (const id of ids) orders.orders.get(id)!.status = 'PAID';
    // 둘째 주문의 항목이 미수령으로 취소된 뒤 환급됐다(I2·I16)
    const item = [...orders.items.values()].find((i) => i.orderId === ids[1])!;
    item.status = 'REFUNDED';
    const more = await pickupOrder(account, [{ productId: p.productId, quantity: 1 }], s);
    expect(more.statusCode, more.payload).toBe(201);
    orders.orders.get(JSON.parse(more.payload).orderId)!.status = 'PAID';
    const over = await pickupOrder(account, [{ productId: p.productId, quantity: 1 }], s);
    expect(over.statusCode).toBe(422);
    expect(typeOf(over)).toContain('merch-quantity-limit-exceeded');
    // 취소(아직 환급 전, CANCELLED)도 세지 않는다
    item.status = 'CANCELLED';
    const firstItem = [...orders.items.values()].find((i) => i.orderId === ids[0])!;
    firstItem.status = 'CANCELLED';
    expect((await pickupOrder(account, [{ productId: p.productId, quantity: 1 }], s)).statusCode).toBe(201);
  });

  test('P-T57 ⑦ 고른 시간대가 주문 상품의 것이 아니면(같은 회차의 다른 상품 시간대) 주문 상품에 그 회차 시간대가 있어도 422 pickup-slot-unavailable다', async () => {
    const mine = product({ name: '시간대 내 상품' });
    const other = product({ name: '시간대 다른 상품' });
    const mySlot = slot(mine.productId, { eventId: EVENT });
    const otherSlot = slot(other.productId, { eventId: EVENT });
    const writes = orders.writes;
    const res = await pickupOrder(randomUUID(), [{ productId: mine.productId, quantity: 1 }], otherSlot);
    expect(res.statusCode).toBe(422);
    expect(typeOf(res)).toContain('pickup-slot-unavailable');
    expect(orders.writes).toBe(writes);
    // 대조군: 자기 상품의 시간대는 201
    expect((await pickupOrder(randomUUID(), [{ productId: mine.productId, quantity: 1 }], mySlot)).statusCode).toBe(201);
  });

  test('P-T57 ⑦ 결제 접수 본문의 attemptId가 지금 READY 시도가 아니면(앞서 대체된 시도) 409 payment-attempt-mismatch이고 승인 명령을 보내지 않는다 [ASVS v5.0.0-2.3.1]', async () => {
    const account = randomUUID();
    const p = product({ name: '시도 대조' });
    const orderId = JSON.parse((await pickupOrder(account, [{ productId: p.productId, quantity: 1 }], slot(p.productId))).payload).orderId as string;
    const first = JSON.parse((await post(account, `/v1/shop/orders/${orderId}/payments`, {})).payload);
    const second = JSON.parse((await post(account, `/v1/shop/orders/${orderId}/payments`, {})).payload);
    expect(second.attemptId).not.toBe(first.attemptId);
    const amount = orders.orders.get(orderId)!.amount;
    const confirms = payments.calls.confirm.length;
    const res = await post(account, `/v1/shop/orders/${orderId}/payment-acceptance`, { pg: first.pg, paymentKey: `sim_${orderId.slice(0, 8)}`, amount, attemptId: first.attemptId });
    expect(res.statusCode).toBe(409);
    expect(typeOf(res)).toContain('payment-attempt-mismatch');
    expect(payments.calls.confirm.length).toBe(confirms);
    expect([...orders.attempts.values()].filter((a) => a.orderId === orderId && a.status === 'ACCEPTED')).toEqual([]);
    expect(orders.orders.get(orderId)!.status).toBe('CREATED');
    // 대조군: 지금 시도의 attemptId면 202
    const ok = await post(account, `/v1/shop/orders/${orderId}/payment-acceptance`, { pg: second.pg, paymentKey: `sim_${orderId.slice(0, 8)}`, amount, attemptId: second.attemptId });
    expect(ok.statusCode, ok.payload).toBe(202);
  });
});
