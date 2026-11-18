// 현장 수령 미수령 자동 취소 통합 시험(BUILD_ORDER LCH-020, BAT-600, P-T57 ①~⑤, 장애 주입 F-7, ADR-0301 결정 5).
// 실제 PostgreSQL 18(core_app 역할)에 PAID 현장 수령 주문·수령 시간대를 넣고 정비 일 merch-unclaimed-cancel(MerchUnclaimed.run)과 환급 다시 부르기(MerchUnclaimed.retry)를
// 가짜 시계와 시험 안의 가짜 결제 포트로 돌린다(실제 CancelPayment·시뮬레이터 취소는 payment-svc merch-path-e2e가 본다).
// 단언 값은 정본에서: 10:00 KST [가정], 은행 영업일(주말 건너뜀), 마지막 시간대가 끝난 날의 다음 영업일, 항목 READY → CANCELLED(cancel_reason UNCLAIMED) → REFUNDED,
// 취소 금액 = 취소한 항목의 단가 × 수량 합, 사유 UNCLAIMED, 같은 취소 ID로 10분 [가정]마다 다시, 3일 [가정] 넘으면 SEV2, REJECTED는 SEV2(kind merch-refund-rejected, 주문 ID만), 재고 그대로.
import { createDatabase, ensureOutboxPartitions, fakeClock, systemClock, type Database, type FakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { DrizzleShopOrderStore, MerchUnclaimed, type CancelOutcome, type MerchPayments, type ShopLogger } from '../src/modules/shop/index.js';
import { startPostgres, type PostgresContainer } from './postgres.js';
import { loginFor } from './roles.js';

let pgc: PostgresContainer;
let admin: Database;
let appDb: Database;

const PROMOTER = randomUUID();
const RETRY_MS = 10 * 60 * 1000;
const OVERDUE_MS = 3 * 24 * 60 * 60 * 1000;

// KST = UTC + 9. 2027-03-05는 금요일이다
const KST = (iso: string) => Date.parse(`${iso}+09:00`);
const THU_2100 = KST('2027-03-04T21:00:00.000');
const FRI_1000 = KST('2027-03-05T10:00:00.000');
const FRI_2100 = KST('2027-03-05T21:00:00.000');
const SAT_1000 = KST('2027-03-06T10:00:00.000');
const SUN_2100 = KST('2027-03-07T21:00:00.000');
const MON_0800 = KST('2027-03-08T08:00:00.000');
const MON_1000 = KST('2027-03-08T10:00:00.000');
const TUE_1000 = KST('2027-03-09T10:00:00.000');

beforeAll(async () => {
  pgc = await startPostgres();
  await migrateCore(pgc.url);
  admin = createDatabase({ url: pgc.url, applicationName: 'core-svc-shop-unclaimed-int', max: 4 });
  await ensureOutboxPartitions(admin, systemClock);
  appDb = await loginFor(admin, pgc, 'core_app_login', 'core_app', 4);
});
afterAll(async () => {
  await appDb?.close();
  await admin?.close();
  pgc?.stop();
});

beforeEach(async () => {
  await admin.pool.query('delete from merch_refund; delete from merch_order_item; delete from merch_order; delete from pickup_slot; delete from product');
});

// ---- 시험 대역 ----

interface CancelCall {
  paymentId: string;
  cancellationId: string;
  amount: number;
  reason: string;
  /** 부른 때 이미 커밋된 환급 행(별도 연결로 읽음) */
  refundRow: { status: string; amount: number } | undefined;
  /** 부른 때 항목 상태 */
  itemStatuses: { status: string; cancel_reason: string | null }[];
}

class FakePayments implements MerchPayments {
  readonly calls: CancelCall[] = [];
  constructor(private readonly outcomes: CancelOutcome[] = []) {}
  async prepareCheckout(): Promise<never> {
    throw new Error('부르지 않는다');
  }
  async confirm(): Promise<never> {
    throw new Error('부르지 않는다');
  }
  async batchGet(): Promise<never> {
    throw new Error('부르지 않는다');
  }
  async cancel(c: { paymentId: string; cancellationId: string; amount: number; reason: string }): Promise<CancelOutcome> {
    const r = (await admin.pool.query('select status, amount, order_id from merch_refund where id = $1', [c.cancellationId])).rows[0];
    const items = r ? (await admin.pool.query('select status, cancel_reason from merch_order_item where order_id = $1 order by id', [r.order_id])).rows : [];
    this.calls.push({ ...c, refundRow: r ? { status: r.status, amount: Number(r.amount) } : undefined, itemStatuses: items });
    return this.outcomes.shift() ?? 'CANCELLED';
  }
}

interface Line {
  level: string;
  o: Record<string, unknown>;
}
function capture(): { logger: ShopLogger; lines: Line[] } {
  const lines: Line[] = [];
  const push = (level: string) => (o: object) => {
    lines.push({ level, o: o as Record<string, unknown> });
  };
  return { logger: { info: push('info'), warn: push('warn'), error: push('error') }, lines };
}

// ---- 자료 ----

interface ItemSpec {
  quantity: number;
  unitAmount: number;
}

/**
 * PAID 현장 수령 주문 하나. 상품마다 시간대 둘(고른 시간대 = chosenEndsAt에 끝남, 그 상품·그 회차의 마지막 시간대 = lastEndsAt에 끝남).
 * 상품은 한정 수량 3, 남은 수 1(이미 2개 팔림)
 */
async function paidPickupOrder(o: { items: ItemSpec[]; lastEndsAt: number; chosenEndsAt?: number }) {
  const orderId = randomUUID();
  const eventId = randomUUID();
  const paymentId = randomUUID();
  const products: string[] = [];
  let chosenSlot: string | undefined;
  for (const _ of o.items) {
    const productId = randomUUID();
    products.push(productId);
    await admin.pool.query(
      `insert into product (id, promoter_id, type, schema_version, name, status, price, limited_qty, fulfillments, attributes, updated_at)
       values ($1, $2, 'MERCH', 1, '현장 수령 굿즈', 'PUBLISHED', 1, 3, '{PICKUP}', '{}'::jsonb, now())`,
      [productId, PROMOTER],
    );
    await admin.pool.query('insert into product_stock (product_id, stock, updated_at) values ($1, 1, now())', [productId]);
    const chosenEnds = o.chosenEndsAt ?? o.lastEndsAt;
    const s1 = randomUUID();
    await admin.pool.query('insert into pickup_slot (id, product_id, event_id, starts_at, ends_at) values ($1, $2, $3, $4, $5)', [s1, productId, eventId, new Date(chosenEnds - 3600_000), new Date(chosenEnds)]);
    if (chosenEnds !== o.lastEndsAt) {
      await admin.pool.query('insert into pickup_slot (id, product_id, event_id, starts_at, ends_at) values ($1, $2, $3, $4, $5)', [randomUUID(), productId, eventId, new Date(o.lastEndsAt - 3600_000), new Date(o.lastEndsAt)]);
    }
    chosenSlot ??= s1;
  }
  const amount = o.items.reduce((s, i) => s + i.quantity * i.unitAmount, 0);
  const orderedAt = new Date(o.lastEndsAt - 10 * 24 * 3600_000);
  await admin.pool.query(
    `insert into merch_order (id, promoter_id, event_id, status, pg, pg_store, shipping_fee, ordered_at, account_id, fulfillment, amount, stock_reserved_until, payment_id, pickup_slot_id, paid_at)
     values ($1, $2, $3, 'PAID', 'SIMULATOR', 'STANDARD', 0, $4, $5, 'PICKUP', $6, $7, $8, $9, $4)`,
    [orderId, PROMOTER, eventId, orderedAt, randomUUID(), amount, new Date(orderedAt.getTime() + 900_000), paymentId, chosenSlot],
  );
  const itemIds: string[] = [];
  for (const [k, i] of o.items.entries()) {
    const itemId = `0000000${k}-0000-4000-8000-${randomUUID().slice(-12)}`;
    itemIds.push(itemId);
    await admin.pool.query(
      `insert into merch_order_item (id, order_id, promoter_id, event_id, product_id, product_name, quantity, unit_amount, commission_rate_bp, status, fulfillment, ticket_linked)
       values ($1, $2, $3, $4, $5, '현장 수령 굿즈', $6, $7, 1000, 'READY', 'PICKUP', false)`,
      [itemId, orderId, PROMOTER, eventId, products[k], i.quantity, i.unitAmount],
    );
  }
  return { orderId, paymentId, amount, products, itemIds };
}

const items = async (orderId: string) =>
  (await admin.pool.query('select id, status, cancel_reason, refunded_amount from merch_order_item where order_id = $1 order by id', [orderId])).rows.map((r) => ({
    status: r.status as string,
    cancelReason: r.cancel_reason as string | null,
    refundedAmount: Number(r.refunded_amount),
  }));
const refunds = async (orderId: string) =>
  (await admin.pool.query('select id, status, amount, reason from merch_refund where order_id = $1', [orderId])).rows.map((r) => ({ id: r.id as string, status: r.status as string, amount: Number(r.amount), reason: r.reason as string }));
const stocks = async (productIds: string[]) => (await admin.pool.query('select stock from product_stock where product_id = any($1::uuid[]) order by product_id', [productIds])).rows.map((r) => Number(r.stock));
const pickUp = (itemId: string, at: number) => admin.pool.query(`update merch_order_item set status = 'PICKED_UP', picked_up_at = $2 where id = $1 and status = 'READY'`, [itemId, new Date(at)]);

function job(clock: FakeClock, payments: FakePayments) {
  const { logger, lines } = capture();
  return { unclaimed: new MerchUnclaimed({ store: new DrizzleShopOrderStore(appDb, clock), payments, clock, logger }), lines };
}
const moveTo = (clock: FakeClock, ms: number) => clock.advance(ms - clock.now());

describe('현장 수령 미수령 자동 취소(실제 PostgreSQL)', () => {
  test('P-T57 ① 마지막 시간대가 금요일 21:00 KST에 끝나면 금·토요일에는 바뀐 행이 없고 월요일 10:00 KST에 취소·전액 환급되며 재고는 그대로다', async () => {
    // 고른 시간대는 목요일 21:00에 끝나지만 그 상품·그 회차의 마지막 시간대는 금요일 21:00에 끝난다
    const o = await paidPickupOrder({ items: [{ quantity: 2, unitAmount: 15_000 }], lastEndsAt: FRI_2100, chosenEndsAt: THU_2100 });
    const clock = fakeClock({ now: FRI_1000 });
    const payments = new FakePayments();
    const { unclaimed } = job(clock, payments);

    expect(await unclaimed.run()).toEqual({ cancelled: 0, refunds: 0 });
    moveTo(clock, SAT_1000);
    expect(await unclaimed.run()).toEqual({ skipped: 'not-business-day' });
    moveTo(clock, MON_1000 - 1);
    expect(await unclaimed.run()).toEqual({ deferred: true });
    expect(payments.calls).toHaveLength(0);
    expect(await items(o.orderId)).toEqual([{ status: 'READY', cancelReason: null, refundedAmount: 0 }]);
    expect(await refunds(o.orderId)).toEqual([]);

    moveTo(clock, MON_1000);
    expect(await unclaimed.run()).toEqual({ cancelled: 1, refunds: 1 });
    expect(payments.calls).toHaveLength(1);
    const call = payments.calls[0]!;
    expect(call).toMatchObject({ paymentId: o.paymentId, amount: 30_000, reason: 'UNCLAIMED' });
    expect(call.amount).toBe(o.amount);
    // 결제 취소를 부르기 전에 환급 행과 CANCELLED가 이미 커밋되어 있다(CANCELLED를 거쳐 REFUNDED)
    expect(call.refundRow).toEqual({ status: 'REQUESTED', amount: 30_000 });
    expect(call.itemStatuses).toEqual([{ status: 'CANCELLED', cancel_reason: 'UNCLAIMED' }]);
    expect(await refunds(o.orderId)).toEqual([{ id: call.cancellationId, status: 'CANCELLED', amount: 30_000, reason: 'UNCLAIMED' }]);
    expect(await items(o.orderId)).toEqual([{ status: 'REFUNDED', cancelReason: 'UNCLAIMED', refundedAmount: 30_000 }]);
    // 재고는 돌리지 않는다(공연이 끝난 뒤라 다시 팔 일이 없다)
    expect(await stocks(o.products)).toEqual([1]);
  });

  test('P-T57 ① 일요일에 끝나면 월요일에, 월요일 08:00 KST에 끝나면 그날 10:00이 아니라 화요일에 취소한다', async () => {
    const sun = await paidPickupOrder({ items: [{ quantity: 1, unitAmount: 9_000 }], lastEndsAt: SUN_2100 });
    const mon = await paidPickupOrder({ items: [{ quantity: 1, unitAmount: 7_000 }], lastEndsAt: MON_0800 });
    const clock = fakeClock({ now: MON_1000 });
    const payments = new FakePayments();
    const { unclaimed } = job(clock, payments);
    expect(await unclaimed.run()).toEqual({ cancelled: 1, refunds: 1 });
    expect(payments.calls.map((c) => c.paymentId)).toEqual([sun.paymentId]);
    expect((await items(mon.orderId))[0]!.status).toBe('READY');

    moveTo(clock, TUE_1000);
    expect(await unclaimed.run()).toEqual({ cancelled: 1, refunds: 1 });
    expect(payments.calls.map((c) => c.paymentId)).toEqual([sun.paymentId, mon.paymentId]);
    expect(payments.calls[1]!.amount).toBe(7_000);
    expect(await items(mon.orderId)).toEqual([{ status: 'REFUNDED', cancelReason: 'UNCLAIMED', refundedAmount: 7_000 }]);
  });

  test('P-T57 ② 월요일 실행 전에 교환권을 확인했으면 바뀐 행이 없고 결제 취소가 0건이다', async () => {
    const o = await paidPickupOrder({ items: [{ quantity: 1, unitAmount: 15_000 }], lastEndsAt: FRI_2100 });
    await pickUp(o.itemIds[0]!, FRI_2100 - 60_000);
    const clock = fakeClock({ now: MON_1000 });
    const payments = new FakePayments();
    const { unclaimed } = job(clock, payments);
    expect(await unclaimed.run()).toEqual({ cancelled: 0, refunds: 0 });
    expect(payments.calls).toHaveLength(0);
    expect(await items(o.orderId)).toEqual([{ status: 'PICKED_UP', cancelReason: null, refundedAmount: 0 }]);
    expect(await refunds(o.orderId)).toEqual([]);
  });

  test('P-T57 ③ 결제 취소가 CANCEL_PENDING이면 10분 − 1ms에는 부르지 않고 10분에 같은 취소 ID로 다시 불러 REFUNDED가 된다(F-7)', async () => {
    const o = await paidPickupOrder({ items: [{ quantity: 1, unitAmount: 15_000 }], lastEndsAt: FRI_2100 });
    const clock = fakeClock({ now: MON_1000 });
    const payments = new FakePayments(['CANCEL_PENDING', 'CANCELLED']);
    const { unclaimed } = job(clock, payments);
    expect(await unclaimed.run()).toEqual({ cancelled: 1, refunds: 1 });
    expect(await refunds(o.orderId)).toMatchObject([{ status: 'CANCEL_PENDING', amount: 15_000 }]);
    expect(await items(o.orderId)).toEqual([{ status: 'CANCELLED', cancelReason: 'UNCLAIMED', refundedAmount: 0 }]);

    clock.advance(RETRY_MS - 1);
    expect(await unclaimed.retry()).toEqual({ retried: 0 });
    expect(payments.calls).toHaveLength(1);
    clock.advance(1);
    expect(await unclaimed.retry()).toEqual({ retried: 1 });
    expect(payments.calls).toHaveLength(2);
    expect(payments.calls[1]).toMatchObject({ paymentId: o.paymentId, cancellationId: payments.calls[0]!.cancellationId, amount: 15_000, reason: 'UNCLAIMED' });
    expect(new Set(payments.calls.map((c) => c.cancellationId)).size).toBe(1);
    expect(await items(o.orderId)).toEqual([{ status: 'REFUNDED', cancelReason: 'UNCLAIMED', refundedAmount: 15_000 }]);
    expect(await refunds(o.orderId)).toMatchObject([{ status: 'CANCELLED' }]);
    // 끝난 환급은 다시 부르지 않는다
    clock.advance(RETRY_MS);
    expect(await unclaimed.retry()).toEqual({ retried: 0 });
    expect(payments.calls).toHaveLength(2);
  });

  test('P-T57 ③ 결제 취소 호출이 실패(UNKNOWN)해도 10분 뒤 같은 취소 ID로 다시 불러 끝낸다(F-7)', async () => {
    const o = await paidPickupOrder({ items: [{ quantity: 3, unitAmount: 4_000 }], lastEndsAt: FRI_2100 });
    const clock = fakeClock({ now: MON_1000 });
    const payments = new FakePayments(['UNKNOWN', 'CANCELLED']);
    const { unclaimed } = job(clock, payments);
    await unclaimed.run();
    expect(await items(o.orderId)).toEqual([{ status: 'CANCELLED', cancelReason: 'UNCLAIMED', refundedAmount: 0 }]);
    clock.advance(RETRY_MS - 1);
    expect(await unclaimed.retry()).toEqual({ retried: 0 });
    clock.advance(1);
    expect(await unclaimed.retry()).toEqual({ retried: 1 });
    expect(payments.calls.map((c) => [c.cancellationId, c.amount])).toEqual([
      [payments.calls[0]!.cancellationId, 12_000],
      [payments.calls[0]!.cancellationId, 12_000],
    ]);
    expect(await items(o.orderId)).toEqual([{ status: 'REFUNDED', cancelReason: 'UNCLAIMED', refundedAmount: 12_000 }]);
  });

  test('P-T57 ③ 환급이 3일 넘게 끝나지 않으면 SEV2 한 줄을 한 번만 남긴다(3일 정각에는 아직 아니다)', async () => {
    const o = await paidPickupOrder({ items: [{ quantity: 1, unitAmount: 15_000 }], lastEndsAt: FRI_2100 });
    const clock = fakeClock({ now: MON_1000 });
    const payments = new FakePayments(Array.from({ length: 10 }, () => 'CANCEL_PENDING' as const));
    const { unclaimed, lines } = job(clock, payments);
    await unclaimed.run();
    const overdue = () => lines.filter((l) => l.o.kind === 'merch-refund-overdue');
    moveTo(clock, MON_1000 + OVERDUE_MS);
    expect(await unclaimed.retry()).toEqual({ retried: 1 });
    expect(overdue()).toHaveLength(0);
    clock.advance(RETRY_MS);
    expect(await unclaimed.retry()).toEqual({ retried: 1 });
    expect(overdue()).toHaveLength(1);
    expect(overdue()[0]).toMatchObject({ level: 'error', o: { kind: 'merch-refund-overdue', severity: 'SEV2', orderId: o.orderId } });
    clock.advance(RETRY_MS);
    expect(await unclaimed.retry()).toEqual({ retried: 1 });
    expect(overdue()).toHaveLength(1);
    expect(new Set(payments.calls.map((c) => c.cancellationId)).size).toBe(1);
  });

  test('P-T57 ③ 결제사가 거절(REJECTED)하면 SEV2 한 줄(kind merch-refund-rejected, 주문 ID만)이고 환급 행은 남고 다시 부르지 않는다', async () => {
    const o = await paidPickupOrder({ items: [{ quantity: 1, unitAmount: 15_000 }], lastEndsAt: FRI_2100 });
    const clock = fakeClock({ now: MON_1000 });
    const payments = new FakePayments(['REJECTED']);
    const { unclaimed, lines } = job(clock, payments);
    await unclaimed.run();
    const rejected = lines.filter((l) => l.o.kind === 'merch-refund-rejected');
    expect(rejected).toEqual([{ level: 'error', o: { kind: 'merch-refund-rejected', severity: 'SEV2', orderId: o.orderId } }]);
    const rows = await refunds(o.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: 15_000, reason: 'UNCLAIMED' });
    expect(rows[0]!.status).not.toBe('CANCELLED');
    expect(await items(o.orderId)).toEqual([{ status: 'CANCELLED', cancelReason: 'UNCLAIMED', refundedAmount: 0 }]);
    clock.advance(RETRY_MS);
    expect(await unclaimed.retry()).toEqual({ retried: 0 });
    expect(payments.calls).toHaveLength(1);
  });

  test('P-T57 ④ 항목 둘 가운데 하나만 받았으면 받지 않은 항목 금액만 취소한다', async () => {
    const o = await paidPickupOrder({ items: [{ quantity: 1, unitAmount: 12_000 }, { quantity: 2, unitAmount: 8_000 }], lastEndsAt: FRI_2100 });
    await pickUp(o.itemIds[0]!, FRI_2100 - 60_000);
    const clock = fakeClock({ now: MON_1000 });
    const payments = new FakePayments();
    const { unclaimed } = job(clock, payments);
    expect(await unclaimed.run()).toEqual({ cancelled: 1, refunds: 1 });
    expect(payments.calls).toHaveLength(1);
    expect(payments.calls[0]).toMatchObject({ paymentId: o.paymentId, amount: 16_000, reason: 'UNCLAIMED' });
    expect(payments.calls[0]!.amount).not.toBe(o.amount);
    expect(await items(o.orderId)).toEqual([
      { status: 'PICKED_UP', cancelReason: null, refundedAmount: 0 },
      { status: 'REFUNDED', cancelReason: 'UNCLAIMED', refundedAmount: 16_000 },
    ]);
    expect(await stocks(o.products)).toEqual([1, 1]);
  });

  test('P-T57 ⑤ 월요일에 정비 일을 두 번 돌려도 결제 취소는 1건이다', async () => {
    const o = await paidPickupOrder({ items: [{ quantity: 1, unitAmount: 15_000 }], lastEndsAt: FRI_2100 });
    const clock = fakeClock({ now: MON_1000 });
    const payments = new FakePayments();
    const { unclaimed } = job(clock, payments);
    expect(await unclaimed.run()).toEqual({ cancelled: 1, refunds: 1 });
    clock.advance(60_000);
    expect(await unclaimed.run()).toEqual({ cancelled: 0, refunds: 0 });
    expect(payments.calls).toHaveLength(1);
    expect(await refunds(o.orderId)).toHaveLength(1);
    expect(await items(o.orderId)).toEqual([{ status: 'REFUNDED', cancelReason: 'UNCLAIMED', refundedAmount: 15_000 }]);
  });
});
