// 현장 수령 미수령 자동 취소 단위 시험(메모리 저장소·메모리 결제 대역, ADR-0301 결정 5, P-T57 ①~⑤).
// 단언 값은 정본에서: 매일 10:00 KST, 은행 영업일(주말 건너뜀)에만, 대상은 PAID 현장 수령 주문의 READY 항목, 그 상품·그 회차의 마지막 시간대가 끝난 KST 날짜 D의
// 다음 영업일이 오늘이거나 지났으면 READY → CANCELLED(cancel_reason UNCLAIMED) → CancelPayment(취소한 항목 단가 × 수량 합, 사유 UNCLAIMED) → CANCELLED면 REFUNDED.
// CANCEL_PENDING·UNKNOWN은 10분마다 같은 취소 ID로 다시, 3일 넘게 끝나지 않으면 SEV2, REJECTED는 SEV2(kind merch-refund-rejected, 주문 ID만). 재고는 돌리지 않는다.
// 날짜: 2026-11-20은 금요일이다. 금요일 21:00 KST = 2026-11-20T12:00:00Z.
import { fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  isBusinessDay,
  kstDateOf,
  MemoryMerchPayments,
  MemoryProductStore,
  MemoryShopOrderStore,
  MerchUnclaimed,
  nextBusinessDay,
  type ProductRecord,
  type ShopLogger,
  type ShopOrder,
  type ShopOrderItem,
  unclaimedDue,
} from '../src/modules/shop/index.js';

const KST = (iso: string) => Date.parse(`${iso}+09:00`);
const FRI_2100 = KST('2026-11-20T21:00:00');
const SAT_1000 = KST('2026-11-21T10:00:00');
const SUN_1000 = KST('2026-11-22T10:00:00');
const MON_0959 = KST('2026-11-23T09:59:00');
const MON_1000 = KST('2026-11-23T10:00:00');
const TUE_1000 = KST('2026-11-24T10:00:00');
const MIN = 60_000;
const DAY = 86_400_000;

describe('영업일과 미수령 대상 판정(P-T57 ①)', () => {
  test('P-T57 ① 토·일은 영업일이 아니고 월~금은 영업일이며 금요일 다음 영업일은 월요일이다', () => {
    expect(['2026-11-21', '2026-11-22'].map(isBusinessDay)).toEqual([false, false]);
    expect(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27'].map(isBusinessDay)).toEqual([true, true, true, true, true]);
    expect(nextBusinessDay('2026-11-20')).toBe('2026-11-23');
    expect(nextBusinessDay('2026-11-21')).toBe('2026-11-23');
    expect(nextBusinessDay('2026-11-22')).toBe('2026-11-23');
    expect(nextBusinessDay('2026-11-23')).toBe('2026-11-24');
    // KST 날짜: 금요일 21:00 KST는 UTC로 같은 날 12:00이고, 토요일 08:00 KST는 UTC로 금요일 23:00이다
    expect(kstDateOf(FRI_2100)).toBe('2026-11-20');
    expect(kstDateOf(KST('2026-11-21T08:00:00'))).toBe('2026-11-21');
  });

  test('P-T57 ① 금요일 21:00 KST에 끝난 시간대는 토·일에는 대상이 아니고 월요일에 대상이다', () => {
    expect(unclaimedDue(FRI_2100, SAT_1000)).toBe(false);
    expect(unclaimedDue(FRI_2100, SUN_1000)).toBe(false);
    expect(unclaimedDue(FRI_2100, KST('2026-11-22T23:59:59'))).toBe(false);
    expect(unclaimedDue(FRI_2100, KST('2026-11-23T00:00:00'))).toBe(true);
    expect(unclaimedDue(FRI_2100, MON_1000)).toBe(true);
    // 하루를 건너뛰어도 다음 실행이 잡는다
    expect(unclaimedDue(FRI_2100, TUE_1000)).toBe(true);
  });

  test('P-T57 ① 일요일에 끝나면 월요일이 대상이고, 월요일에 끝나면 그날은 아니고 화요일이 대상이다', () => {
    const sunEnd = KST('2026-11-22T21:00:00');
    expect(unclaimedDue(sunEnd, MON_1000)).toBe(true);
    const monEnd = KST('2026-11-23T09:00:00');
    expect(unclaimedDue(monEnd, MON_1000)).toBe(false);
    expect(unclaimedDue(monEnd, KST('2026-11-23T23:59:59'))).toBe(false);
    expect(unclaimedDue(monEnd, TUE_1000)).toBe(true);
    // 목요일에 끝나면 금요일
    expect(unclaimedDue(KST('2026-11-19T20:00:00'), KST('2026-11-20T10:00:00'))).toBe(true);
    expect(unclaimedDue(KST('2026-11-19T20:00:00'), KST('2026-11-19T23:00:00'))).toBe(false);
  });

  test('P-T57 ① 시간대가 아직 끝나지 않았으면 대상이 아니다', () => {
    expect(unclaimedDue(MON_1000 + 1, MON_1000)).toBe(false);
  });
});

// ---- 정비 일 본체(메모리 저장소) ----

interface Fixture {
  clock: ReturnType<typeof fakeClock>;
  orders: MemoryShopOrderStore;
  products: MemoryProductStore;
  payments: MemoryMerchPayments;
  logs: { level: string; o: Record<string, unknown>; msg: string }[];
  job: MerchUnclaimed;
  orderId: string;
  paymentId: string;
  items: ShopOrderItem[];
  productId: string;
}

function fixture(o: { quantities?: number[]; unitAmount?: number; lastEndsAt?: number; now?: number } = {}): Fixture {
  const clock = fakeClock({ now: o.now ?? SAT_1000 });
  const products = new MemoryProductStore();
  const orders = new MemoryShopOrderStore(products);
  const payments = new MemoryMerchPayments();
  const logs: Fixture['logs'] = [];
  const logger: ShopLogger = {
    info: (x, msg) => logs.push({ level: 'info', o: x as Record<string, unknown>, msg }),
    warn: (x, msg) => logs.push({ level: 'warn', o: x as Record<string, unknown>, msg }),
    error: (x, msg) => logs.push({ level: 'error', o: x as Record<string, unknown>, msg }),
  };
  const eventId = randomUUID();
  const productId = randomUUID();
  const product: ProductRecord = {
    productId,
    promoterId: randomUUID(),
    type: 'MERCH',
    name: '현장 수령 응원봉',
    status: 'PUBLISHED',
    price: 12_300,
    shippingFee: null,
    returnShippingFee: null,
    returnAddress: null,
    limitedQty: 3,
    stock: 1,
    transferable: false,
    ticketLinked: false,
    linkedEventId: null,
    fulfillments: ['PICKUP'],
    saleStartsAt: null,
    saleEndsAt: null,
    commissionRateBp: 1000,
    attributes: {},
    schemaVersion: 1,
    version: 1,
    publishedAt: null,
    updatedAt: new Date(FRI_2100 - 10 * DAY),
  };
  products.rows.set(productId, product);
  const lastEnds = o.lastEndsAt ?? FRI_2100;
  // 같은 상품·같은 회차의 시간대 둘: 고른 시간대는 앞의 것이고 마지막 시간대는 금요일 21:00 KST에 끝난다
  const early = randomUUID();
  orders.slots.set(early, { slotId: early, productId, eventId, startsAt: new Date(lastEnds - 2 * DAY - 3_600_000), endsAt: new Date(lastEnds - 2 * DAY), ticketHoldersOnly: false });
  const last = randomUUID();
  orders.slots.set(last, { slotId: last, productId, eventId, startsAt: new Date(lastEnds - 3_600_000), endsAt: new Date(lastEnds), ticketHoldersOnly: false });
  const orderId = randomUUID();
  const paymentId = randomUUID();
  const unit = o.unitAmount ?? 12_300;
  const quantities = o.quantities ?? [2];
  const order: ShopOrder = {
    orderId,
    accountId: randomUUID(),
    promoterId: product.promoterId,
    eventId,
    fulfillment: 'PICKUP',
    status: 'PAID',
    amount: quantities.reduce((s, q) => s + q * unit, 0),
    shippingFee: 0,
    pgStore: 'STANDARD',
    pg: 'SIMULATOR',
    paymentId,
    stockReservedUntil: new Date(FRI_2100 - 5 * DAY),
    consentVersion: null,
    recipientName: null,
    recipientPhone: null,
    deliveryAddress: null,
    pickupSlotId: early,
    escrow: false,
    orderedAt: new Date(FRI_2100 - 6 * DAY),
    paidAt: new Date(FRI_2100 - 6 * DAY),
    purchaseConfirmedAt: null,
  };
  orders.orders.set(orderId, order);
  const items = quantities.map((quantity, i): ShopOrderItem => {
    const it: ShopOrderItem = {
      itemId: `${String(i).padStart(2, '0')}-${randomUUID()}`,
      orderId,
      promoterId: product.promoterId,
      eventId,
      productId,
      productName: product.name,
      quantity,
      unitAmount: unit,
      commissionRateBp: 1000,
      status: 'READY',
      fulfillment: 'PICKUP',
      ticketLinked: false,
      limited: true,
      optionSnapshot: { options: {}, name: product.name, type: 'MERCH', schemaVersion: 1 },
      linkedTicketId: null,
      cancelReason: null,
      refundedAmount: 0,
      pickedUpAt: null,
      eventEndsAt: null,
    };
    orders.items.set(it.itemId, it);
    return it;
  });
  const job = new MerchUnclaimed({ store: orders, payments, clock, logger });
  return { clock, orders, products, payments, logs, job, orderId, paymentId, items, productId };
}

const at = (f: Fixture, ms: number) => f.clock.advance(ms - f.clock.now());
const itemStates = (f: Fixture) => f.items.map((i) => f.orders.items.get(i.itemId)!);

describe('미수령 자동 취소 정비 일(P-T57)', () => {
  test('P-T57 ① 토요일 10:00 KST에는 바뀐 행이 없고 월요일 10:00 KST에 항목이 CANCELLED를 거쳐 REFUNDED가 되며 결제 금액 전액이 취소되고 재고는 그대로다', async () => {
    const f = fixture({ quantities: [2] });
    const writes = f.orders.writes;
    expect(await f.job.run()).toEqual({ skipped: 'not-business-day' });
    at(f, SUN_1000);
    expect(await f.job.run()).toEqual({ skipped: 'not-business-day' });
    expect(f.orders.writes).toBe(writes);
    expect(f.payments.calls.cancel).toEqual([]);
    expect(itemStates(f).map((i) => i.status)).toEqual(['READY']);

    at(f, MON_1000);
    f.payments.cancelOutcomes = ['CANCELLED'];
    expect(await f.job.run()).toEqual({ cancelled: 1, refunds: 1 });
    expect(f.payments.calls.cancel).toHaveLength(1);
    const call = f.payments.calls.cancel[0]!;
    expect(call).toMatchObject({ paymentId: f.paymentId, amount: 24_600, reason: 'UNCLAIMED' });
    const refund = f.orders.refunds.get(call.cancellationId)!;
    expect(refund).toMatchObject({ orderId: f.orderId, amount: 24_600, status: 'CANCELLED' });
    expect(itemStates(f)).toMatchObject([{ status: 'REFUNDED', cancelReason: 'UNCLAIMED', refundedAmount: 24_600 }]);
    expect(f.orders.orders.get(f.orderId)!.status).toBe('PAID');
    expect(f.products.rows.get(f.productId)!.stock).toBe(1);
  });

  test('P-T57 ① 월요일 10:00 KST 전(09:59)에는 미루고 아무것도 바꾸지 않는다', async () => {
    const f = fixture({ now: MON_0959 });
    const writes = f.orders.writes;
    expect(await f.job.run()).toEqual({ deferred: true });
    expect(f.orders.writes).toBe(writes);
    expect(f.payments.calls.cancel).toEqual([]);
  });

  test('P-T57 ① 대상 판정은 고른 시간대가 아니라 그 상품·그 회차의 마지막 시간대로 한다(마지막이 월요일 21:00 KST면 월요일에는 아니다)', async () => {
    const f = fixture({ lastEndsAt: KST('2026-11-23T21:00:00'), now: KST('2026-11-24T10:00:00') });
    at(f, KST('2026-11-24T10:00:00'));
    expect(await f.job.run()).toEqual({ cancelled: 1, refunds: 1 });
    const g = fixture({ lastEndsAt: KST('2026-11-23T09:00:00'), now: MON_1000 });
    expect(await g.job.run()).toEqual({ cancelled: 0, refunds: 0 });
    expect(g.payments.calls.cancel).toEqual([]);
  });

  test('P-T57 ② 월요일 실행 전에 교환권으로 확인(PICKED_UP)했으면 바뀐 행이 없고 결제 취소가 0건이다', async () => {
    const f = fixture({ now: MON_1000 });
    const it = f.orders.items.get(f.items[0]!.itemId)!;
    it.status = 'PICKED_UP';
    it.pickedUpAt = new Date(FRI_2100 - 3_600_000);
    const writes = f.orders.writes;
    expect(await f.job.run()).toEqual({ cancelled: 0, refunds: 0 });
    expect(f.orders.writes).toBe(writes);
    expect(f.payments.calls.cancel).toEqual([]);
    expect(f.orders.refunds.size).toBe(0);
  });

  test('P-T57 ③ 결제 취소가 CANCEL_PENDING을 돌려주면 10분 뒤 같은 취소 ID로 다시 불러 REFUNDED가 된다(10분 − 1ms에는 부르지 않는다)', async () => {
    const f = fixture({ now: MON_1000 });
    f.payments.cancelOutcomes = ['CANCEL_PENDING', 'CANCELLED'];
    await f.job.run();
    expect(f.payments.calls.cancel).toHaveLength(1);
    const id = f.payments.calls.cancel[0]!.cancellationId;
    expect(f.orders.refunds.get(id)!.status).toBe('CANCEL_PENDING');
    expect(itemStates(f).map((i) => i.status)).toEqual(['CANCELLED']);
    f.clock.advance(10 * MIN - 1);
    expect(await f.job.retry()).toEqual({ retried: 0 });
    f.clock.advance(1);
    expect(await f.job.retry()).toEqual({ retried: 1 });
    expect(f.payments.calls.cancel.map((c) => c.cancellationId)).toEqual([id, id]);
    expect(f.payments.calls.cancel[1]).toMatchObject({ paymentId: f.paymentId, amount: 24_600, reason: 'UNCLAIMED' });
    expect(f.orders.refunds.get(id)!.status).toBe('CANCELLED');
    expect(itemStates(f).map((i) => i.status)).toEqual(['REFUNDED']);
    f.clock.advance(10 * MIN);
    expect(await f.job.retry()).toEqual({ retried: 0 });
  });

  test('P-T57 ③ UNKNOWN도 10분 뒤 같은 취소 ID로 다시 부른다', async () => {
    const f = fixture({ now: MON_1000 });
    f.payments.cancelOutcomes = ['UNKNOWN', 'CANCELLED'];
    await f.job.run();
    f.clock.advance(10 * MIN);
    await f.job.retry();
    const ids = f.payments.calls.cancel.map((c) => c.cancellationId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
    expect(itemStates(f).map((i) => i.status)).toEqual(['REFUNDED']);
  });

  test('P-T57 ④ 항목 둘 가운데 하나만 받았으면 받지 않은 항목 금액만 취소한다', async () => {
    const f = fixture({ quantities: [1, 3], now: MON_1000 });
    const picked = f.orders.items.get(f.items[0]!.itemId)!;
    picked.status = 'PICKED_UP';
    await f.job.run();
    expect(f.payments.calls.cancel).toHaveLength(1);
    expect(f.payments.calls.cancel[0]!.amount).toBe(3 * 12_300);
    expect(f.orders.orders.get(f.orderId)!.amount).toBe(4 * 12_300);
    expect(itemStates(f).map((i) => i.status)).toEqual(['PICKED_UP', 'REFUNDED']);
    expect(itemStates(f)[1]!.refundedAmount).toBe(3 * 12_300);
    expect(itemStates(f)[0]!.refundedAmount).toBe(0);
  });

  test('P-T57 ⑤ 월요일에 정비 일을 두 번 돌려도 결제 취소는 1건이다', async () => {
    const f = fixture({ now: MON_1000 });
    await f.job.run();
    f.clock.advance(MIN);
    expect(await f.job.run()).toEqual({ cancelled: 0, refunds: 0 });
    expect(f.payments.calls.cancel).toHaveLength(1);
    expect(f.orders.refunds.size).toBe(1);
  });

  test('P-T57 ③ 3일 넘게 끝나지 않으면 SEV2 한 줄을 한 번만 남기고 3일 딱에는 남기지 않는다', async () => {
    const f = fixture({ now: MON_1000 });
    f.payments.cancelOutcomes = Array.from({ length: 1_000 }, () => 'CANCEL_PENDING' as const);
    await f.job.run();
    const sev2 = () => f.logs.filter((l) => l.o.severity === 'SEV2' && l.o.kind === 'merch-refund-overdue');
    at(f, MON_1000 + 3 * DAY);
    await f.job.retry();
    expect(sev2()).toHaveLength(0);
    f.clock.advance(10 * MIN);
    await f.job.retry();
    expect(sev2()).toHaveLength(1);
    expect(sev2()[0]!.o).toEqual({ kind: 'merch-refund-overdue', severity: 'SEV2', orderId: f.orderId });
    f.clock.advance(10 * MIN);
    await f.job.retry();
    expect(sev2()).toHaveLength(1);
  });

  test('P-T57 ③ REJECTED면 SEV2 한 줄(kind merch-refund-rejected, 주문 ID만)을 남기고 환급 행을 그대로 두며 다시 부르지 않는다', async () => {
    const f = fixture({ now: MON_1000 });
    f.payments.cancelOutcomes = ['REJECTED'];
    await f.job.run();
    const rejected = f.logs.filter((l) => l.o.kind === 'merch-refund-rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.o).toEqual({ kind: 'merch-refund-rejected', severity: 'SEV2', orderId: f.orderId });
    const id = f.payments.calls.cancel[0]!.cancellationId;
    expect(f.orders.refunds.get(id)!.status).toBe('REJECTED');
    expect(itemStates(f).map((i) => i.status)).toEqual(['CANCELLED']);
    f.clock.advance(10 * MIN);
    expect(await f.job.retry()).toEqual({ retried: 0 });
    expect(f.payments.calls.cancel).toHaveLength(1);
  });
});
