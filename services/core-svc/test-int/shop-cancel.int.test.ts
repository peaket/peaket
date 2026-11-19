// 굿즈·부가 상품 구매자 취소 실제 연결 시험(BUILD_ORDER LCH-030, BAT-605, ADR-0315, POL-016 §1.4, P-T61·P-T63 ④·P-T64·V-T35 ③).
// core-svc HTTP(AppModule DB 조립) + 실제 PostgreSQL 18(core_app 로그인) + 가짜 결제 gRPC 대역(CancelPayment 입력·답을 시험이 정함).
// 정본:
// - 발송 전 택배 전체 취소는 상품 합 + 배송비, 일부 항목은 그 항목 금액만이다(배송비는 남는 항목 몫). 에스크로는 구매 확정 전 전체만.
// - 현장 수령은 PICKED_UP 전, 부가 상품(WALLET)은 연결 회차 입장 시작 전까지 받는다. 그 밖은 409(entry-started·merch-cancel-not-allowed).
// - 취소 ID는 merch_refund.id(UUIDv7)이고 결제사 취소는 그 ID로 한 번이다. 같은 Idempotency-Key는 같은 202·같은 ID·금액이고 결제사 1건이다.
// - 가상계좌 결제는 환불 계좌가 필요하고 계좌를 보내면 재인증이 필수다. 계좌는 결제사 취소 본문에만 실리고 저장·로그·사건·Outbox에 남지 않는다.
// - CANCELLED → REFUNDED·항목 CANCELLED·환급액, CANCEL_PENDING·UNKNOWN → REFUND_PENDING·항목 CANCELLED·다음 시도 1분, 계좌 거절 → 422·환급 행 REJECTED·항목 그대로.
// - 결제사 취소 커밋 뒤 항목 전이 전에 멈춰도 다음 재시도가 같은 취소 ID로 끝내고 이중 환급은 0건이다.
import 'reflect-metadata';
import { createDatabase, createService, ensureOutboxPartitions, fakeClock, systemClock, type Database } from '@peaket/platform';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import {
  DrizzleShopOrderStore,
  MemoryHeldTickets,
  MemoryMerchStock,
  MerchCancel,
  MerchRefundRetry,
  MerchUnclaimed,
  ShopSignals,
  type CancelInput,
  type CancelOutcome,
  type MerchPayments,
  type ShopLogger,
  type ShopReauthGate,
} from '../src/modules/shop/index.js';
import { FakeIdentity, fan, quiet, testMedia } from '../test/support.js';
import { startPostgres, type PostgresContainer } from './postgres.js';
import { loginFor } from './roles.js';

const CONSENT = 'v2026.11-19-bat605-int';
const DAY = 86_400_000;
/** 시험 기준 시각. 정본 값(다음 날 23:59·1분·7일)과 다른 시각에서 시작한다 */
const T0 = Date.parse('2027-01-07T01:05:00.000Z');
const clock = fakeClock({ now: T0 });
const SELLER = randomUUID();
const ACCOUNT_KEYS = { bankCode: '88', accountNumber: '110987654321', holderName: '김환불' };

type Cancel = Parameters<MerchPayments['cancel']>[0];

/** 가짜 payment-svc. GetPayment 답과 CancelPayment 답·부른 기록을 시험이 정한다 */
class FakePayments implements MerchPayments {
  readonly cancels: Cancel[] = [];
  readonly getPaymentCalls: { orderId: string; deadlineMs: number }[] = [];
  readonly virtualAccountOrders = new Set<string>();
  cancelAnswers: CancelOutcome[] = [];
  getPaymentDown = false;
  readonly wrongOrderIds = new Set<string>();
  /** 첫 요청이 결제사 취소에서 기다리게 해 두 번째 요청을 그 사이에 보낸다(부분 유일 경합 시험) */
  cancelGate: { started: (cancellationId: string) => void; wait: Promise<void> } | undefined;

  async prepareCheckout(): Promise<never> {
    throw new Error('취소 시험은 결제창을 부르지 않는다');
  }
  async confirm(): Promise<never> {
    throw new Error('취소 시험은 승인 명령을 부르지 않는다');
  }
  async batchGet(): Promise<never> {
    throw new Error('취소 시험은 결과 당기기를 부르지 않는다');
  }
  async getPayment(orderId: string, deadlineMs: number) {
    this.getPaymentCalls.push({ orderId, deadlineMs });
    if (this.getPaymentDown) throw new Error('payment-svc 원장 읽기 실패(시험)');
    return {
      status: 'APPROVED' as const,
      pg: 'SIMULATOR' as const,
      orderId: this.wrongOrderIds.has(orderId) ? randomUUID() : orderId,
      virtualAccountPaid: this.virtualAccountOrders.has(orderId),
    };
  }
  async cancel(c: Cancel): Promise<CancelOutcome> {
    this.cancels.push(c);
    this.cancelGate?.started(c.cancellationId);
    if (this.cancelGate !== undefined) await this.cancelGate.wait;
    return this.cancelAnswers.shift() ?? 'CANCELLED';
  }
  get cancelIds(): string[] {
    return this.cancels.map((c) => c.cancellationId);
  }
}

/** 가짜 재인증 확인기. 계좌 취소 시험은 통과/거절만 정한다(토큰 검증 자체는 P-T63 ② HTTP 시험 몫) */
class FakeReauth implements ShopReauthGate {
  readonly calls: { accountId: string; sessionId: string; act: string; op: string }[] = [];
  answer = true;
  async verify(_token: string | undefined, q: { readonly accountId: string; readonly sessionId: string; readonly act: 'FAN_HIGH_RISK'; readonly op: 'SHOP_CANCEL_REFUND_ACCOUNT' }): Promise<boolean> {
    this.calls.push({ accountId: q.accountId, sessionId: q.sessionId, act: q.act, op: q.op });
    return this.answer;
  }
}

const payments = new FakePayments();
const reauth = new FakeReauth();
const held = new MemoryHeldTickets();
const stock = new MemoryMerchStock();
const signals = new ShopSignals();
const logs: string[] = [];
const logger: ShopLogger = {
  info: (o) => logs.push(JSON.stringify(o)),
  warn: (o) => logs.push(JSON.stringify(o)),
  error: (o) => logs.push(JSON.stringify(o)),
};
let ignoredAccounts = 0;
(signals.refundAccountIgnored as unknown as { inc: () => void }).inc = () => {
  ignoredAccounts++;
};

let pg: PostgresContainer;
let admin: Database;
let appDb: Database;
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-shop-cancel-int', max: 6 });
  await ensureOutboxPartitions(admin, systemClock);
  appDb = await loginFor(admin, pg, 'core_app_login', 'core_app', 8);
  await admin.pool.query('insert into promoter (id, legal_name) values ($1, $2) on conflict (id) do nothing', [SELLER, '(주)시험굿즈']);
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({
      database: appDb,
      partnerDatabase: appDb,
      media: testMedia(),
      shop: { stock, payments, held, reauth, signals, logger, consentVersion: CONSENT },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: new FakeIdentity(),
  });
});
afterAll(async () => {
  await svc?.close();
  await appDb?.close();
  await admin?.close();
  pg?.stop();
});

beforeEach(async () => {
  await admin.pool.query(`
    delete from merch_refund_item;
    delete from merch_refund;
    delete from merch_confirm_job;
    delete from merch_payment_attempt;
    delete from merch_order_item;
    delete from merch_order;
    delete from pickup_slot;
    delete from product_stock;
    delete from product;
    delete from event;
    delete from production;
    delete from place;
    delete from idempotency_record;
    delete from outbox`);
  payments.cancels.length = 0;
  payments.getPaymentCalls.length = 0;
  payments.virtualAccountOrders.clear();
  payments.cancelAnswers.length = 0;
  payments.getPaymentDown = false;
  payments.wrongOrderIds.clear();
  payments.cancelGate = undefined;
  reauth.calls.length = 0;
  reauth.answer = true;
  logs.length = 0;
  ignoredAccounts = 0;
});

// ---- 자료 도우미 ----

interface ProductSpec {
  price?: number;
  shippingFee?: number | null;
  returnShippingFee?: number | null;
  returnAddress?: string | null;
  fulfillments?: string[];
  ticketLinked?: boolean;
  linkedEventId?: string | null;
}

async function seedProduct(o: ProductSpec = {}): Promise<string> {
  const id = randomUUID();
  await admin.pool.query(
    `insert into product (id, promoter_id, type, schema_version, name, status, price, shipping_fee, return_shipping_fee, return_address,
       limited_qty, transferable, ticket_linked, linked_event_id, fulfillments, commission_rate_bp, attributes, version, published_at, updated_at)
     values ($1, $2, 'MERCH', 1, '시험 굿즈', 'PUBLISHED', $3, $4, $5, $6, null, false, $7, $8, $9::text[], 1000, '{}'::jsonb, 1, $10, $10)`,
    [id, SELLER, o.price ?? 12_000, o.shippingFee ?? null, o.returnShippingFee ?? null, o.returnAddress ?? null, o.ticketLinked ?? false, o.linkedEventId ?? null, o.fulfillments ?? ['PICKUP'], new Date(clock.now() - 10 * DAY)],
  );
  return id;
}

/** 회차 하나(입장 시작·끝). WALLET 부가 상품의 자격 기준이다 */
async function seedEvent(entryOpensAtMs: number, endsAtMs: number): Promise<string> {
  const placeId = randomUUID();
  const productionId = randomUUID();
  const eventId = randomUUID();
  await admin.pool.query(
    `insert into place (id, name, address, region, created_by) values ($1, '취소 시험 공연장', '서울특별시 마포구', '서울', $2)`,
    [placeId, SELLER],
  );
  await admin.pool.query(
    `insert into production (id, promoter_id, place_id, title, genre, sale_review, sale_approved_at)
     values ($1, $2, $3, '취소 시험 공연', '콘서트', 'APPROVED', $4)`,
    [productionId, SELLER, placeId, new Date(clock.now() - 30 * DAY)],
  );
  await admin.pool.query(
    `insert into event (id, production_id, promoter_id, venue_id, open_at, entry_opens_at, starts_at, ends_at)
     values ($1, $2, $3, null, $4, $5, $6, $7)`,
    [eventId, productionId, SELLER, new Date(entryOpensAtMs - 2 * 3_600_000), new Date(entryOpensAtMs), new Date(entryOpensAtMs), new Date(endsAtMs)],
  );
  return eventId;
}

interface ItemSpec {
  productId: string;
  quantity?: number;
  unitAmount: number;
  status?: 'READY' | 'SHIPPED' | 'DELIVERED' | 'PICKED_UP' | 'LOCKED';
  shippedAt?: number | null;
  deliveredAt?: number | null;
  pickedUpAt?: number | null;
}

interface OrderSpec {
  accountId?: string;
  fulfillment: 'DELIVERY' | 'PICKUP' | 'WALLET';
  items: ItemSpec[];
  shippingFee?: number;
  pgStore?: 'STANDARD' | 'ESCROW';
  eventId?: string | null;
  purchaseConfirmedAt?: number | null;
}

/** PAID 주문과 항목을 직접 넣는다(취소·반품 경로만 보는 시험. 주문 만들기는 BAT-600 시험 몫) */
async function seedPaidOrder(o: OrderSpec): Promise<{ orderId: string; accountId: string; itemIds: string[]; amount: number; paymentId: string }> {
  const accountId = o.accountId ?? randomUUID();
  const orderId = randomUUID();
  const paymentId = randomUUID();
  const amount = o.items.reduce((s, i) => s + (i.quantity ?? 1) * i.unitAmount, 0) + (o.shippingFee ?? 0);
  const now = new Date(clock.now());
  let pickupSlotId: string | null = null;
  if (o.fulfillment === 'PICKUP') {
    pickupSlotId = randomUUID();
    await admin.pool.query(
      `insert into pickup_slot (id, product_id, event_id, starts_at, ends_at, ticket_holders_only)
       values ($1, $2, $3, $4, $5, false)`,
      [pickupSlotId, o.items[0]!.productId, o.eventId ?? randomUUID(), new Date(clock.now() + 3_600_000), new Date(clock.now() + 7_200_000)],
    );
  }
  await admin.pool.query(
    `insert into merch_order (id, promoter_id, event_id, status, pg, pg_store, shipping_fee, purchase_confirmed_at, ordered_at, account_id,
       fulfillment, amount, stock_reserved_until, payment_id, pickup_slot_id, paid_at, consent_version, recipient_name, recipient_phone,
       delivery_address, escrow)
     values ($1, $2, $3, 'PAID', 'SIMULATOR', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $7, $14, $15, $16, $17, false)`,
    [
      orderId,
      SELLER,
      o.eventId ?? null,
      o.pgStore ?? 'STANDARD',
      o.shippingFee ?? 0,
      o.purchaseConfirmedAt === undefined || o.purchaseConfirmedAt === null ? null : new Date(o.purchaseConfirmedAt),
      new Date(clock.now() - 3_600_000),
      accountId,
      o.fulfillment,
      amount,
      new Date(clock.now() - 60_000),
      paymentId,
      pickupSlotId,
      o.fulfillment === 'DELIVERY' ? CONSENT : null,
      o.fulfillment === 'DELIVERY' ? '김배송' : null,
      o.fulfillment === 'DELIVERY' ? '01098765432' : null,
      o.fulfillment === 'DELIVERY' ? '04524 서울특별시 중구 세종대로 1' : null,
    ],
  );
  const itemIds: string[] = [];
  for (const [n, spec] of o.items.entries()) {
    const itemId = `0000000${n}-0000-4000-8000-${randomUUID().slice(-12)}`;
    itemIds.push(itemId);
    await admin.pool.query(
      `insert into merch_order_item (id, order_id, promoter_id, event_id, product_id, product_name, quantity, unit_amount, commission_rate_bp,
         status, fulfillment, ticket_linked, linked_ticket_id, option_snapshot, shipped_at, delivered_at, picked_up_at, event_ends_at)
       values ($1, $2, $3, $4, $5, '시험 굿즈', $6, $7, 1000, $8, $9, $10, $11, '{"options":{},"name":"시험 굿즈","type":"MERCH","schemaVersion":1}'::jsonb, $12, $13, $14, $15)`,
      [
        itemId,
        orderId,
        SELLER,
        o.eventId ?? null,
        spec.productId,
        spec.quantity ?? 1,
        spec.unitAmount,
        spec.status ?? 'READY',
        o.fulfillment,
        o.fulfillment === 'WALLET',
        o.fulfillment === 'WALLET' ? randomUUID() : null,
        spec.shippedAt === undefined || spec.shippedAt === null ? null : new Date(spec.shippedAt),
        spec.deliveredAt === undefined || spec.deliveredAt === null ? null : new Date(spec.deliveredAt),
        spec.pickedUpAt === undefined || spec.pickedUpAt === null ? null : new Date(spec.pickedUpAt),
        o.eventId === null || o.eventId === undefined ? null : new Date(clock.now() + 7 * DAY),
      ],
    );
  }
  return { orderId, accountId, itemIds, amount, paymentId };
}

/** 상태값 한 줄(정본 문자열 그대로) */
const itemsOf = async (orderId: string) =>
  (await admin.pool.query('select id, status, cancel_reason, refunded_amount from merch_order_item where order_id = $1 order by id', [orderId])).rows.map((r) => ({
    id: r.id as string,
    status: r.status as string,
    cancelReason: r.cancel_reason as string | null,
    refundedAmount: Number(r.refunded_amount),
  }));
const refundsOf = async (orderId: string) =>
  (await admin.pool.query('select id, status, amount, reason, kind, next_at, fail_reason, attempts from merch_refund where order_id = $1 order by id', [orderId])).rows.map((r) => ({
    id: r.id as string,
    status: r.status as string,
    amount: Number(r.amount),
    reason: r.reason as string,
    kind: r.kind as string,
    nextAt: r.next_at === null ? null : new Date(r.next_at as string | Date).getTime(),
    failReason: r.fail_reason as string | null,
    attempts: Number(r.attempts),
  }));
const refundItemsOf = async (orderId: string) =>
  (await admin.pool.query('select ri.refund_id, ri.item_id, ri.resolved_at from merch_refund_item ri join merch_refund r on r.id = ri.refund_id where r.order_id = $1 order by ri.item_id', [orderId])).rows;

// ---- HTTP 도우미 ----

const fanHeaders = (accountId: string, key: string) => ({ ...fan(accountId), 'content-type': 'application/json', 'idempotency-key': key });
const cancelOrder = (accountId: string, orderId: string, body: unknown, o: { key?: string; token?: string } = {}) =>
  svc.http.inject({
    method: 'POST',
    url: `/v1/shop/orders/${orderId}/cancellations`,
    headers: { ...fanHeaders(accountId, o.key ?? randomUUID()), ...(o.token === undefined ? {} : { 'x-reauth-token': o.token }) },
    payload: JSON.stringify(body),
  });
const problem = (r: { statusCode: number; payload: string }) => {
  const b = JSON.parse(r.payload) as { type?: string; title?: string; status?: number };
  return { status: r.statusCode, type: String(b.type ?? '').replace(/^.*\/problems\//, ''), title: b.title };
};
const bodyOf = (r: { payload: string }) => JSON.parse(r.payload) as { cancellationId: string; status: string; refundAmount: number; refundAccountRequired?: boolean };
const once = (accountId: string) => ({ accountRef: accountId, operation: 'CANCEL_MERCH_ORDER', key: randomUUID(), requestHash: createHash('sha256').update(randomUUID()).digest() });

describe('구매자 취소의 자격·금액(P-T61 ①~③·V-T35 ③)', () => {
  test('P-T61 ① 발송 전 택배 전체 취소는 202 REFUNDED·상품 합+배송비이고 모든 항목 CANCELLED·merch_refund CANCELLED·CancelPayment 1건이다', async () => {
    const first = await seedProduct({ fulfillments: ['DELIVERY'], price: 12_000, shippingFee: 3_000, returnShippingFee: 2_500, returnAddress: '서울특별시 마포구' });
    const second = await seedProduct({ fulfillments: ['DELIVERY'], price: 9_000, shippingFee: 3_000, returnShippingFee: 2_500, returnAddress: '서울특별시 마포구' });
    const o = await seedPaidOrder({
      fulfillment: 'DELIVERY',
      pgStore: 'ESCROW',
      shippingFee: 3_000,
      items: [
        { productId: first, quantity: 1, unitAmount: 12_000 },
        { productId: second, quantity: 1, unitAmount: 9_000 },
      ],
    });
    const res = await cancelOrder(o.accountId, o.orderId, {});
    expect(res.statusCode, res.payload).toBe(202);
    const body = bodyOf(res);
    expect(body.status).toBe('REFUNDED');
    expect(body.refundAmount).toBe(24_000); // 12,000 + 9,000 + 택배 배송비 3,000
    expect(body.refundAmount).toBe(o.amount);
    expect(body.cancellationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // 취소 ID는 merch_refund.id이고 결제사 취소 ID도 같다
    expect(payments.cancels).toHaveLength(1);
    expect(payments.cancels[0]).toMatchObject({ paymentId: o.paymentId, cancellationId: body.cancellationId, amount: 24_000, reason: 'USER_CANCEL' });
    expect(payments.cancels[0]!.refundAccount).toBeUndefined();
    expect((await refundsOf(o.orderId)).map((r) => [r.id, r.status, r.amount, r.kind])).toEqual([[body.cancellationId, 'CANCELLED', 24_000, 'USER_CANCEL']]);
    const items = await itemsOf(o.orderId);
    expect(items.map((i) => i.status)).toEqual(['REFUNDED', 'REFUNDED']);
    expect(items.map((i) => i.cancelReason)).toEqual(['USER_CANCEL', 'USER_CANCEL']);
    expect(items.map((i) => i.refundedAmount)).toEqual([12_000, 9_000]);
    expect(await refundItemsOf(o.orderId)).toHaveLength(2);
  });

  test('P-T61 ② 두 항목 가운데 하나만 취소하면 그 항목 금액만 환급하고 나머지는 READY·주문은 PAID이며, 같은 키 재요청은 같은 취소 ID·결제사 1건이다', async () => {
    const first = await seedProduct({ fulfillments: ['DELIVERY'], price: 12_000, shippingFee: 3_000, returnShippingFee: 2_500, returnAddress: '서울특별시 마포구' });
    const second = await seedProduct({ fulfillments: ['DELIVERY'], price: 9_000, shippingFee: 3_000, returnShippingFee: 2_500, returnAddress: '서울특별시 마포구' });
    const o = await seedPaidOrder({
      fulfillment: 'DELIVERY',
      // BAT-610이 구매 확정을 읽기 전에는 에스크로 부분 취소가 열리지 않는다. 금액 규칙만 보려고 일반 상점 택배 주문을 쓴다
      pgStore: 'STANDARD',
      shippingFee: 3_000,
      items: [
        { productId: first, quantity: 2, unitAmount: 12_000 },
        { productId: second, quantity: 1, unitAmount: 9_000 },
      ],
    });
    const key = randomUUID();
    const res = await cancelOrder(o.accountId, o.orderId, { itemIds: [o.itemIds[0]!] }, { key });
    expect(res.statusCode, res.payload).toBe(202);
    const body = bodyOf(res);
    expect(body.status).toBe('REFUNDED');
    expect(body.refundAmount).toBe(24_000); // 2 × 12,000. 배송비 3,000은 남는 항목 몫이라 돌려주지 않는다
    expect(body.refundAmount).not.toBe(o.amount);
    expect(payments.cancels).toHaveLength(1);
    expect(payments.cancels[0]).toMatchObject({ cancellationId: body.cancellationId, amount: 24_000, reason: 'USER_CANCEL' });
    expect((await itemsOf(o.orderId)).map((i) => [i.status, i.refundedAmount])).toEqual([
      ['REFUNDED', 24_000],
      ['READY', 0],
    ]);
    expect((await admin.pool.query('select status from merch_order where id = $1', [o.orderId])).rows[0].status).toBe('PAID');
    // 같은 키 재요청: 같은 202·같은 취소 ID·같은 금액, 결제사는 1건 그대로다
    const replay = await cancelOrder(o.accountId, o.orderId, { itemIds: [o.itemIds[0]!] }, { key });
    expect(replay.statusCode, replay.payload).toBe(202);
    expect(bodyOf(replay)).toMatchObject({ cancellationId: body.cancellationId, status: 'REFUNDED', refundAmount: 24_000 });
    expect(payments.cancels).toHaveLength(1);
    expect(await refundsOf(o.orderId)).toHaveLength(1);
  });

  test('P-T61 ② 두 항목을 하나씩 모두 취소하면 두 번째에서 처음 배송비까지 환급한다', async () => {
    const first = await seedProduct({ fulfillments: ['DELIVERY'], price: 12_000, shippingFee: 3_000, returnShippingFee: 2_500, returnAddress: '서울특별시 마포구' });
    const second = await seedProduct({ fulfillments: ['DELIVERY'], price: 9_000, shippingFee: 3_000, returnShippingFee: 2_500, returnAddress: '서울특별시 마포구' });
    const o = await seedPaidOrder({
      fulfillment: 'DELIVERY',
      pgStore: 'STANDARD',
      shippingFee: 3_000,
      items: [
        { productId: first, quantity: 1, unitAmount: 12_000 },
        { productId: second, quantity: 1, unitAmount: 9_000 },
      ],
    });
    const one = await cancelOrder(o.accountId, o.orderId, { itemIds: [o.itemIds[0]!] });
    expect(one.statusCode, one.payload).toBe(202);
    expect(bodyOf(one).refundAmount).toBe(12_000);
    const two = await cancelOrder(o.accountId, o.orderId, { itemIds: [o.itemIds[1]!] });
    expect(two.statusCode, two.payload).toBe(202);
    // 마지막 남은 항목까지 취소했으므로 처음 배송비 3,000을 더해 12,000을 환급한다
    expect(bodyOf(two).refundAmount).toBe(12_000);
    expect(payments.cancels.map((c) => c.amount)).toEqual([12_000, 12_000]);
    expect((await refundsOf(o.orderId)).reduce((s, r) => s + r.amount, 0)).toBe(o.amount);
    expect((await itemsOf(o.orderId)).map((i) => i.status)).toEqual(['REFUNDED', 'REFUNDED']);
  });

  test('RV-36 실제 에스크로(구매 확정 전, purchase_confirmed_at null) 주문의 첫 부분 취소는 409 escrow-partial-not-allowed이고 결제사 0건이다', async () => {
    const first = await seedProduct({ fulfillments: ['DELIVERY'], price: 12_000, shippingFee: 3_000, returnShippingFee: 2_500, returnAddress: '서울특별시 마포구' });
    const second = await seedProduct({ fulfillments: ['DELIVERY'], price: 9_000, shippingFee: 3_000, returnShippingFee: 2_500, returnAddress: '서울특별시 마포구' });
    const o = await seedPaidOrder({
      fulfillment: 'DELIVERY',
      pgStore: 'ESCROW',
      shippingFee: 3_000,
      purchaseConfirmedAt: null,
      items: [
        { productId: first, quantity: 1, unitAmount: 12_000 },
        { productId: second, quantity: 1, unitAmount: 9_000 },
      ],
    });
    const res = await cancelOrder(o.accountId, o.orderId, { itemIds: [o.itemIds[0]!] });
    expect(res.statusCode, res.payload).toBe(409);
    expect(problem(res).type).toContain('escrow-partial-not-allowed');
    expect(payments.cancels).toHaveLength(0);
    expect(await refundsOf(o.orderId)).toEqual([]);
    expect((await itemsOf(o.orderId)).map((i) => i.status)).toEqual(['READY', 'READY']);
  });

  test('P-T61 ② 전체 취소면 처음 배송비까지 환급한다', async () => {
    const p = await seedProduct({ fulfillments: ['DELIVERY'], price: 9_900, shippingFee: 3_000, returnShippingFee: 2_500, returnAddress: '서울특별시 마포구' });
    const o = await seedPaidOrder({ fulfillment: 'DELIVERY', pgStore: 'ESCROW', shippingFee: 3_000, items: [{ productId: p, quantity: 2, unitAmount: 9_900 }] });
    const res = await cancelOrder(o.accountId, o.orderId, {});
    expect(res.statusCode, res.payload).toBe(202);
    expect(bodyOf(res).refundAmount).toBe(22_800); // 2 × 9,900 + 3,000
    expect(payments.cancels[0]!.amount).toBe(22_800);
    expect((await refundsOf(o.orderId))[0]!.amount).toBe(22_800);
  });

  test('P-T61 ③ 현장 수령은 PICKED_UP 전이면 202, PICKED_UP·SHIPPED·DELIVERED는 409 merch-cancel-not-allowed이고 결제사 0건이다', async () => {
    // 수령 전: 202
    const pickupProduct = await seedProduct({ fulfillments: ['PICKUP'], price: 15_000 });
    const before = await seedPaidOrder({ fulfillment: 'PICKUP', items: [{ productId: pickupProduct, quantity: 1, unitAmount: 15_000 }] });
    const ok = await cancelOrder(before.accountId, before.orderId, {});
    expect(ok.statusCode, ok.payload).toBe(202);
    expect(bodyOf(ok)).toMatchObject({ status: 'REFUNDED', refundAmount: 15_000 });
    expect((await itemsOf(before.orderId))[0]!.status).toBe('REFUNDED');
    expect(payments.cancels).toHaveLength(1);
    const calls = payments.cancels.length;

    const cases: [string, 'PICKUP' | 'DELIVERY', 'PICKED_UP' | 'SHIPPED' | 'DELIVERED'][] = [
      ['현장 수령 PICKED_UP', 'PICKUP', 'PICKED_UP'],
      ['택배 SHIPPED', 'DELIVERY', 'SHIPPED'],
      ['택배 DELIVERED', 'DELIVERY', 'DELIVERED'],
    ];
    for (const [what, fulfillment, status] of cases) {
      const p = await seedProduct({ fulfillments: [fulfillment], price: 11_000, ...(fulfillment === 'DELIVERY' ? { shippingFee: 3_000, returnShippingFee: 2_500, returnAddress: '서울특별시 마포구' } : {}) });
      const o = await seedPaidOrder({
        fulfillment,
        ...(fulfillment === 'DELIVERY' ? { pgStore: 'ESCROW' as const, shippingFee: 3_000 } : {}),
        items: [
          {
            productId: p,
            quantity: 1,
            unitAmount: 11_000,
            status,
            ...(status === 'SHIPPED' ? { shippedAt: clock.now() - 60_000 } : {}),
            ...(status === 'DELIVERED' ? { shippedAt: clock.now() - 120_000, deliveredAt: clock.now() - 60_000 } : {}),
            ...(status === 'PICKED_UP' ? { pickedUpAt: clock.now() - 60_000 } : {}),
          },
        ],
      });
      const res = await cancelOrder(o.accountId, o.orderId, {});
      expect(res.statusCode, `${what}: ${res.payload}`).toBe(409);
      expect(problem(res).type, what).toContain('merch-cancel-not-allowed');
      expect(payments.cancels.length, what).toBe(calls);
      expect(await refundsOf(o.orderId), what).toEqual([]);
      expect((await itemsOf(o.orderId))[0]!.status, what).toBe(status);
    }
  });

  test('P-T61 ③ 부가 상품(WALLET)은 연결 회차 입장 시작 전이면 202, 시작 정각부터는 409 entry-started·결제사 0건이다', async () => {
    const eventId = await seedEvent(clock.now() + 3_600_000, clock.now() + 7_200_000);
    const p = await seedProduct({ fulfillments: ['WALLET'], price: 25_000, ticketLinked: true, linkedEventId: eventId });
    const before = await seedPaidOrder({ fulfillment: 'WALLET', eventId, items: [{ productId: p, quantity: 2, unitAmount: 25_000 }] });
    const ok = await cancelOrder(before.accountId, before.orderId, {});
    expect(ok.statusCode, ok.payload).toBe(202);
    expect(bodyOf(ok).refundAmount).toBe(50_000);
    expect(payments.cancels).toHaveLength(1);

    // 입장 시작 정각: 단순 변심 취소를 받지 않는다(entry-started)
    clock.advance(3_600_000);
    const after = await seedPaidOrder({ fulfillment: 'WALLET', eventId, items: [{ productId: p, quantity: 1, unitAmount: 25_000 }] });
    const res = await cancelOrder(after.accountId, after.orderId, {});
    expect(res.statusCode, res.payload).toBe(409);
    expect(problem(res).type).toContain('entry-started');
    expect(payments.cancels).toHaveLength(1);
    expect(await refundsOf(after.orderId)).toEqual([]);
    expect((await itemsOf(after.orderId))[0]!.status).toBe('READY');

    // 입장 시작 시각을 읽지 못하면(null eventId·event 행 없음) 입장 여부를 모르므로 닫힌 쪽(409 entry-started)으로 답한다
    const callsNow = payments.cancels.length;
    for (const [what, eventId] of [
      ['eventId 없음', null],
      ['event 행 없음', randomUUID()],
    ] as const) {
      const unknown = await seedPaidOrder({ fulfillment: 'WALLET', eventId, items: [{ productId: p, quantity: 1, unitAmount: 25_000 }] });
      const res = await cancelOrder(unknown.accountId, unknown.orderId, {});
      expect(res.statusCode, `${what}: ${res.payload}`).toBe(409);
      expect(problem(res).type, what).toContain('entry-started');
      expect(payments.cancels.length, what).toBe(callsNow);
      expect(await refundsOf(unknown.orderId), what).toEqual([]);
      expect((await itemsOf(unknown.orderId))[0]!.status, what).toBe('READY');
    }
  });

  test('P-T61 ⑤ 같은 Idempotency-Key 재요청은 같은 취소 ID·금액·결제사 1건이고, 동시 두 요청의 두 번째는 409 merch-cancel-not-allowed다', async () => {
    const p = await seedProduct({ fulfillments: ['PICKUP'], price: 13_000 });
    const o = await seedPaidOrder({ fulfillment: 'PICKUP', items: [{ productId: p, quantity: 2, unitAmount: 13_000 }] });
    const key = randomUUID();
    const first = await cancelOrder(o.accountId, o.orderId, { itemIds: [o.itemIds[0]!] }, { key });
    const replay = await cancelOrder(o.accountId, o.orderId, { itemIds: [o.itemIds[0]!] }, { key });
    expect(first.statusCode, first.payload).toBe(202);
    expect(replay.statusCode, replay.payload).toBe(202);
    expect(bodyOf(replay)).toMatchObject({ cancellationId: bodyOf(first).cancellationId, refundAmount: 26_000, status: 'REFUNDED' });
    expect(payments.cancels).toHaveLength(1);
    // 같은 키 재요청은 새 환급 행을 만들지 않는다(M-26)
    expect(await refundsOf(o.orderId)).toHaveLength(1);
    expect((await refundsOf(o.orderId))[0]!.id).toBe(bodyOf(first).cancellationId);
    expect(await refundItemsOf(o.orderId)).toHaveLength(1);

    // 동시 두 요청(서로 다른 키, 같은 주문): 첫 요청이 결제사 취소에서 기다리는 사이 두 번째를 보내면
    // merch_refund_item 부분 유일이 두 번째를 409로 막고, 첫 요청만 환급한다
    const other = await seedPaidOrder({ fulfillment: 'PICKUP', items: [{ productId: p, quantity: 1, unitAmount: 13_000 }] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: (cancellationId: string) => void;
    const called = new Promise<string>((resolve) => {
      started = resolve;
    });
    payments.cancelGate = { started, wait: gate };
    const firstConcurrent = cancelOrder(other.accountId, other.orderId, {});
    const firstId = await called;
    const callsBeforeSecond = payments.cancels.length;
    let second: Awaited<ReturnType<typeof cancelOrder>>;
    let firstResult: Awaited<typeof firstConcurrent>;
    try {
      second = await cancelOrder(other.accountId, other.orderId, {});
      // 두 번째는 부분 유일(merch_refund_item)을 업무 409로 바꾼 답이어야 한다
      expect(second.statusCode, second.payload).toBe(409);
      expect(problem(second).type).toContain('merch-cancel-not-allowed');
      // 두 번째는 결제사 앞에서 막혔다(부분 유일·주문 잠금). 결제사 호출 수가 늘지 않는다(M-48)
      expect(payments.cancels, '두 번째 요청은 결제사에 닿지 않는다').toHaveLength(callsBeforeSecond);
      expect(await refundsOf(other.orderId)).toHaveLength(1);
      expect(await refundItemsOf(other.orderId)).toHaveLength(1);
    } finally {
      release();
      firstResult = await firstConcurrent;
    }
    expect(firstResult.statusCode, firstResult.payload).toBe(202);
    expect(bodyOf(firstResult)).toMatchObject({ cancellationId: firstId, status: 'REFUNDED', refundAmount: 13_000 });
    expect(payments.cancels.filter((c) => c.paymentId === other.paymentId)).toHaveLength(1);
    expect(await refundsOf(other.orderId)).toMatchObject([{ id: firstId, status: 'CANCELLED' }]);
    expect(await refundItemsOf(other.orderId)).toHaveLength(1);
    expect((await itemsOf(other.orderId))[0]!.status).toBe('REFUNDED');
  });
});

describe('환불 계좌와 재인증(P-T63 ④)', () => {
  test('P-T63 ④ 계좌는 결제사 취소 본문에 요청 본문 그대로 실리고 merch_refund·로그·사건·Outbox·응답에 남지 않는다', async () => {
    const p = await seedProduct({ fulfillments: ['PICKUP'], price: 17_500 });
    const o = await seedPaidOrder({ fulfillment: 'PICKUP', items: [{ productId: p, quantity: 1, unitAmount: 17_500 }] });
    payments.virtualAccountOrders.add(o.orderId);
    const token = 'reauth-token-va';
    const res = await cancelOrder(o.accountId, o.orderId, { refundAccount: ACCOUNT_KEYS }, { token });
    expect(res.statusCode, res.payload).toBe(202);
    expect(payments.cancels).toHaveLength(1);
    expect(payments.cancels[0]!.refundAccount).toEqual(ACCOUNT_KEYS);
    expect(reauth.calls).toHaveLength(1);
    expect(reauth.calls[0]).toMatchObject({ accountId: o.accountId, act: 'FAN_HIGH_RISK', op: 'SHOP_CANCEL_REFUND_ACCOUNT' });

    // 저장·로그·사건·Outbox·멱등 응답·주문 상세 어디에도 계좌 값이 없다
    const refundJson = JSON.stringify((await admin.pool.query('select * from merch_refund where order_id = $1', [o.orderId])).rows);
    const refundItemJson = JSON.stringify((await admin.pool.query('select ri.* from merch_refund_item ri join merch_refund r on r.id = ri.refund_id where r.order_id = $1', [o.orderId])).rows);
    const idemJson = JSON.stringify((await admin.pool.query('select * from idempotency_record')).rows);
    const outboxJson = JSON.stringify((await admin.pool.query("select encode(payload, 'escape') as payload from outbox")).rows);
    for (const [what, text] of [
      ['merch_refund', refundJson],
      ['merch_refund_item', refundItemJson],
      ['idempotency_record', idemJson],
      ['outbox', outboxJson],
      ['log', JSON.stringify(logs)],
      ['response', res.payload],
    ] as const) {
      expect(text, what).not.toContain(ACCOUNT_KEYS.accountNumber);
      expect(text, what).not.toContain(ACCOUNT_KEYS.holderName);
    }
    const detail = await svc.http.inject({ method: 'GET', url: `/v1/shop/orders/${o.orderId}`, headers: fan(o.accountId) });
    expect(detail.statusCode, detail.payload).toBe(200);
    expect(detail.payload).not.toContain(ACCOUNT_KEYS.accountNumber);

    // 메모리에 남겨 다음 요청에 쓰지 않는다: 같은 계정의 다른 가상계좌 주문을 계좌 없이 취소하면 422다
    const other = await seedPaidOrder({ accountId: o.accountId, fulfillment: 'PICKUP', items: [{ productId: p, quantity: 1, unitAmount: 17_500 }] });
    payments.virtualAccountOrders.add(other.orderId);
    const noAccount = await cancelOrder(o.accountId, other.orderId, {});
    expect(noAccount.statusCode, noAccount.payload).toBe(422);
    expect(problem(noAccount).type).toContain('refund-account-required');
    expect(payments.cancels.filter((c) => c.paymentId === other.paymentId)).toHaveLength(0);
  });

  test('RV-34 취소도 GetPayment 답의 orderId가 요청 주문과 다르면 계좌를 쓰지 않고 503 dependency-unavailable로 닫는다', async () => {
    const p = await seedProduct({ fulfillments: ['PICKUP'], price: 18_000 });
    const o = await seedPaidOrder({ fulfillment: 'PICKUP', items: [{ productId: p, quantity: 1, unitAmount: 18_000 }] });
    payments.virtualAccountOrders.add(o.orderId);
    payments.wrongOrderIds.add(o.orderId);
    const res = await cancelOrder(o.accountId, o.orderId, { refundAccount: ACCOUNT_KEYS }, { token: 'reauth-rv34' });
    expect(res.statusCode, res.payload).toBe(503);
    expect(problem(res).type).toContain('dependency-unavailable');
    expect(payments.cancels).toHaveLength(0);
    expect(await refundsOf(o.orderId)).toEqual([]);
    expect((await itemsOf(o.orderId))[0]).toMatchObject({ status: 'READY', refundedAmount: 0 });
    expect(res.payload).not.toContain(ACCOUNT_KEYS.accountNumber);
  });

  test('P-T63 ④ 카드 결제에 온 계좌는 결제사로 보내지 않고 지표 1을 올린다', async () => {
    const p = await seedProduct({ fulfillments: ['PICKUP'], price: 12_000 });
    const o = await seedPaidOrder({ fulfillment: 'PICKUP', items: [{ productId: p, quantity: 1, unitAmount: 12_000 }] });
    const res = await cancelOrder(o.accountId, o.orderId, { refundAccount: ACCOUNT_KEYS }, { token: 'reauth-token-card' });
    expect(res.statusCode, res.payload).toBe(202);
    expect(payments.cancels).toHaveLength(1);
    expect(payments.cancels[0]!.refundAccount).toBeUndefined();
    expect(ignoredAccounts).toBe(1);
    expect(reauth.calls).toHaveLength(1);
    expect(res.payload).not.toContain(ACCOUNT_KEYS.accountNumber);
    expect((await itemsOf(o.orderId))[0]!.status).toBe('REFUNDED');
  });
});

describe('환급 멱등·재시도·계좌 거절(P-T64)', () => {
  test('P-T64 ① CANCELLED는 202 REFUNDED·항목 CANCELLED·환급액, CANCEL_PENDING과 UNKNOWN은 202 REFUND_PENDING·항목 CANCELLED·다음 시도 1분·결제사 1건이다', async () => {
    for (const [answer, expected] of [
      ['CANCELLED', { status: 'REFUNDED', refundedAmount: 14_000 }],
      ['CANCEL_PENDING', { status: 'REFUND_PENDING', refundedAmount: 0 }],
      ['UNKNOWN', { status: 'REFUND_PENDING', refundedAmount: 0 }],
    ] as const) {
      const p = await seedProduct({ fulfillments: ['PICKUP'], price: 14_000 });
      const o = await seedPaidOrder({ fulfillment: 'PICKUP', items: [{ productId: p, quantity: 1, unitAmount: 14_000 }] });
      payments.cancelAnswers = [answer];
      const at = clock.now();
      const before = payments.cancels.length;
      const res = await cancelOrder(o.accountId, o.orderId, {});
      expect(res.statusCode, `${answer}: ${res.payload}`).toBe(202);
      const body = bodyOf(res);
      expect(body.status, answer).toBe(expected.status);
      expect(body.refundAmount, answer).toBe(14_000);
      expect(payments.cancels, answer).toHaveLength(before + 1);
      expect(payments.cancels.at(-1), answer).toMatchObject({ cancellationId: body.cancellationId, amount: 14_000, reason: 'USER_CANCEL' });
      const items = await itemsOf(o.orderId);
      expect(items[0]!.status, answer).toBe(answer === 'CANCELLED' ? 'REFUNDED' : 'CANCELLED');
      expect(items[0]!.refundedAmount, answer).toBe(expected.refundedAmount);
      const refund = (await refundsOf(o.orderId))[0]!;
      if (answer === 'CANCELLED') {
        expect(refund).toMatchObject({ status: 'CANCELLED', nextAt: null, failReason: null });
      } else {
        expect(refund.status).toBe('CANCEL_PENDING');
        expect(refund.nextAt).toBe(at + 60_000); // 1분 [가정]
      }
    }
  });

  test('RV-30 CANCEL_PENDING 뒤 거절이 오면 항목을 READY로 되돌려 새 키 재시도가 가능하다', async () => {
    const cardProduct = await seedProduct({ fulfillments: ['PICKUP'], price: 22_000 });
    const card = await seedPaidOrder({ fulfillment: 'PICKUP', items: [{ productId: cardProduct, quantity: 1, unitAmount: 22_000 }] });
    payments.cancelAnswers = ['CANCEL_PENDING', 'REJECTED'];
    const pending = await cancelOrder(card.accountId, card.orderId, {});
    expect(pending.statusCode, pending.payload).toBe(202);
    expect(bodyOf(pending).status).toBe('REFUND_PENDING');
    expect((await itemsOf(card.orderId))[0]!.status).toBe('CANCELLED');
    clock.advance(60_000);
    const retry = new MerchRefundRetry({ store: new DrizzleShopOrderStore(appDb, clock), payments, clock });
    expect(await retry.tick()).toMatchObject({ rejected: 1 });
    // 성공 전이 전 거절이므로 취소 효력도 되돌린다
    expect((await itemsOf(card.orderId))[0]).toMatchObject({ status: 'READY', refundedAmount: 0 });
    expect((await refundsOf(card.orderId))[0]!.status).toBe('REJECTED');
    // 새 키로 다시 취소할 수 있다(옛 환급 자리는 풀렸다)
    const again = await cancelOrder(card.accountId, card.orderId, {});
    expect(again.statusCode, again.payload).toBe(202);
    expect(bodyOf(again).status).toBe('REFUNDED');
    expect((await itemsOf(card.orderId))[0]!.status).toBe('REFUNDED');

    const vaProduct = await seedProduct({ fulfillments: ['PICKUP'], price: 23_000 });
    const va = await seedPaidOrder({ fulfillment: 'PICKUP', items: [{ productId: vaProduct, quantity: 1, unitAmount: 23_000 }] });
    payments.virtualAccountOrders.add(va.orderId);
    payments.cancelAnswers = ['CANCEL_PENDING', 'REFUND_ACCOUNT_REQUIRED'];
    const vaPending = await cancelOrder(va.accountId, va.orderId, { refundAccount: ACCOUNT_KEYS }, { token: 'reauth-rv30' });
    expect(vaPending.statusCode, vaPending.payload).toBe(202);
    expect(bodyOf(vaPending).status).toBe('REFUND_PENDING');
    clock.advance(60_000);
    expect(await retry.tick()).toMatchObject({ rejected: 1 });
    expect((await itemsOf(va.orderId))[0]!.status).toBe('READY');
    // 계좌가 필요한 주문은 새 키로 다시 보내면 409가 아니라 422다
    const noAccount = await cancelOrder(va.accountId, va.orderId, {});
    expect(noAccount.statusCode, noAccount.payload).toBe(422);
    expect(problem(noAccount).type).toContain('refund-account-required');
  });

  test('P-T64 ④ 결제 원장 읽기가 실패하면 503 dependency-unavailable이고 쓰기 0이며, 같은 키 재시도가 202 REFUNDED로 끝난다', async () => {
    const p = await seedProduct({ fulfillments: ['PICKUP'], price: 16_000 });
    const o = await seedPaidOrder({ fulfillment: 'PICKUP', items: [{ productId: p, quantity: 1, unitAmount: 16_000 }] });
    const key = randomUUID();
    payments.getPaymentDown = true;
    const first = await cancelOrder(o.accountId, o.orderId, {}, { key });
    expect(first.statusCode, first.payload).toBe(503);
    expect(problem(first).type).toContain('dependency-unavailable');
    expect(payments.cancels).toHaveLength(0);
    expect(await refundsOf(o.orderId)).toEqual([]);
    expect((await itemsOf(o.orderId))[0]).toMatchObject({ status: 'READY', refundedAmount: 0 });
    expect(Number((await admin.pool.query('select count(*)::int as n from idempotency_record')).rows[0].n)).toBe(0);

    // 재시도: 같은 키로 다시 보내면 202 REFUNDED이고 결제사 1건이다
    payments.getPaymentDown = false;
    const retry = await cancelOrder(o.accountId, o.orderId, {}, { key });
    expect(retry.statusCode, retry.payload).toBe(202);
    expect(bodyOf(retry)).toMatchObject({ status: 'REFUNDED', refundAmount: 16_000 });
    expect(payments.cancels).toHaveLength(1);
    expect((await itemsOf(o.orderId))[0]!.status).toBe('REFUNDED');
  });

  test('RV-35 계좌 거절·PG 거절 outcome의 환급 결과 DB 쓰기 실패는 202가 아니라 422다', async () => {
    const cases = [
      { label: 'REFUND_ACCOUNT_REQUIRED', outcome: 'REFUND_ACCOUNT_REQUIRED' as const, virtualAccount: true },
      { label: 'REJECTED', outcome: 'REJECTED' as const, virtualAccount: false },
    ];
    for (const c of cases) {
      payments.cancels.length = 0;
      const p = await seedProduct({ fulfillments: ['PICKUP'], price: 24_000 });
      const o = await seedPaidOrder({ fulfillment: 'PICKUP', items: [{ productId: p, quantity: 1, unitAmount: 24_000 }] });
      if (c.virtualAccount) payments.virtualAccountOrders.add(o.orderId);
      payments.cancelAnswers = [c.outcome];
      await admin.pool.query('drop trigger if exists test_reject_fail_trg on merch_refund');
      await admin.pool.query(`create or replace function test_reject_fail() returns trigger language plpgsql as $f$ begin raise exception '시험: 거절 결과 DB 쓰기 실패'; end $f$`);
      await admin.pool.query(
        `create trigger test_reject_fail_trg before update on merch_refund for each row when (old.order_id = '${o.orderId}'::uuid and new.status = 'REJECTED') execute function test_reject_fail()`,
      );
      try {
        const res = c.virtualAccount
          ? await cancelOrder(o.accountId, o.orderId, { refundAccount: ACCOUNT_KEYS }, { token: `reauth-rv35-${c.label}` })
          : await cancelOrder(o.accountId, o.orderId, {});
        expect(res.statusCode, `${c.label}: ${res.payload}`).toBe(422);
        expect(problem(res).type, c.label).toContain('refund-account-required');
        expect(payments.cancels, c.label).toHaveLength(1);
        expect((await refundsOf(o.orderId))[0]!.status, c.label).toBe('REQUESTED');
        expect((await itemsOf(o.orderId))[0]!.status, c.label).toBe('READY');
      } finally {
        await admin.pool.query('drop trigger if exists test_reject_fail_trg on merch_refund');
        await admin.pool.query('drop function if exists test_reject_fail()');
      }
    }
  });

  test('M-43 재시도 5회 소진과 결제사 REJECTED 뒤에는 결제사를 더 부르지 않는다', async () => {
    const p = await seedProduct({ fulfillments: ['PICKUP'], price: 26_000 });
    const o = await seedPaidOrder({ fulfillment: 'PICKUP', items: [{ productId: p, quantity: 1, unitAmount: 26_000 }] });
    payments.cancelAnswers = ['CANCEL_PENDING', 'CANCEL_PENDING', 'CANCEL_PENDING', 'CANCEL_PENDING', 'CANCEL_PENDING', 'CANCEL_PENDING'];
    const first = await cancelOrder(o.accountId, o.orderId, {});
    expect(first.statusCode, first.payload).toBe(202);
    expect(bodyOf(first).status).toBe('REFUND_PENDING');
    const initialCalls = payments.cancels.length;
    const retry = new MerchRefundRetry({ store: new DrizzleShopOrderStore(appDb, clock), payments, clock });
    // 1분 → 5분 → 15분 → 1시간 → 6시간. 다섯 번째 재시도에서 5회를 채워 REJECTED(RETRY_EXHAUSTED)로 끝난다
    for (const [i, interval] of [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 360 * 60_000].entries()) {
      clock.advance(interval);
      const tick = await retry.tick();
      expect(tick.picked, `재시도 ${i + 1}`).toBe(1);
      if (i < 4) expect(tick.pending, `재시도 ${i + 1}`).toBe(1);
      else expect(tick.rejected, `재시도 ${i + 1}`).toBe(1);
    }
    expect(payments.cancels).toHaveLength(initialCalls + 5);
    expect(await refundsOf(o.orderId)).toMatchObject([{ status: 'REJECTED', failReason: 'RETRY_EXHAUSTED', attempts: 5 }]);
    expect((await itemsOf(o.orderId))[0]!.status).toBe('READY');
    // 소진 뒤에는 다음 시각이 없어 6회째에도 결제사를 부르지 않는다
    const callsAfterExhaustion = payments.cancels.length;
    clock.advance(1);
    expect(await retry.tick()).toEqual({ picked: 0, cancelled: 0, pending: 0, rejected: 0 });
    expect(payments.cancels).toHaveLength(callsAfterExhaustion);

    // 결제사 REJECTED도 종결이다. 그 뒤 재시도는 0건이고 호출이 늘지 않는다
    const p2 = await seedProduct({ fulfillments: ['PICKUP'], price: 27_000 });
    const o2 = await seedPaidOrder({ fulfillment: 'PICKUP', items: [{ productId: p2, quantity: 1, unitAmount: 27_000 }] });
    payments.cancelAnswers = ['CANCEL_PENDING', 'REJECTED'];
    const second = await cancelOrder(o2.accountId, o2.orderId, {});
    expect(second.statusCode, second.payload).toBe(202);
    clock.advance(60_000);
    expect(await retry.tick()).toMatchObject({ picked: 1, rejected: 1 });
    const callsAfterRejected = payments.cancels.filter((c) => c.paymentId === o2.paymentId).length;
    expect(callsAfterRejected).toBe(2);
    clock.advance(1);
    expect(await retry.tick()).toEqual({ picked: 0, cancelled: 0, pending: 0, rejected: 0 });
    expect(payments.cancels.filter((c) => c.paymentId === o2.paymentId)).toHaveLength(callsAfterRejected);
  });

  test('P-T64 ③ 계좌 거절은 422·merch_refund REJECTED·항목 그대로·결제사 1건이고, 같은 키는 같은 422, 새 키는 새 취소 ID로 1건 더다', async () => {
    const p = await seedProduct({ fulfillments: ['PICKUP'], price: 19_000 });
    const o = await seedPaidOrder({ fulfillment: 'PICKUP', items: [{ productId: p, quantity: 1, unitAmount: 19_000 }] });
    payments.virtualAccountOrders.add(o.orderId);
    payments.cancelAnswers = ['REFUND_ACCOUNT_REQUIRED'];
    const key = randomUUID();
    const at = clock.now();
    const first = await cancelOrder(o.accountId, o.orderId, { refundAccount: ACCOUNT_KEYS }, { key, token: 'reauth-token-1' });
    expect(first.statusCode, first.payload).toBe(422);
    expect(problem(first).type).toContain('refund-account-required');
    expect(payments.cancels).toHaveLength(1);
    const firstId = payments.cancels[0]!.cancellationId;
    const rejected = (await refundsOf(o.orderId))[0]!;
    expect(rejected).toMatchObject({ id: firstId, status: 'REJECTED', amount: 19_000, failReason: 'REFUND_ACCOUNT_REQUIRED' });
    expect((await admin.pool.query('select account_required_at from merch_refund where id = $1', [firstId])).rows[0].account_required_at.getTime()).toBe(at);
    expect((await itemsOf(o.orderId))[0]).toMatchObject({ status: 'READY', refundedAmount: 0 });
    expect(payments.cancels[0]!.refundAccount).toEqual(ACCOUNT_KEYS);
    expect(first.payload).not.toContain(ACCOUNT_KEYS.accountNumber);
    expect(first.payload).not.toContain(ACCOUNT_KEYS.holderName);

    // 같은 키: 같은 422이고 결제사를 다시 부르지 않는다
    const replay = await cancelOrder(o.accountId, o.orderId, { refundAccount: ACCOUNT_KEYS }, { key, token: 'reauth-token-1' });
    expect(replay.statusCode, replay.payload).toBe(422);
    expect(payments.cancels).toHaveLength(1);
    expect(await refundsOf(o.orderId)).toHaveLength(1);

    // 새 키: 새 취소 ID로 결제사를 한 번 더 부른다(같은 취소 ID로 다른 계좌를 다시 부르지 않는다)
    payments.cancelAnswers = ['REFUND_ACCOUNT_REQUIRED'];
    const second = await cancelOrder(o.accountId, o.orderId, { refundAccount: ACCOUNT_KEYS }, { token: 'reauth-token-2' });
    expect(second.statusCode, second.payload).toBe(422);
    expect(payments.cancels).toHaveLength(2);
    const secondId = payments.cancels[1]!.cancellationId;
    expect(secondId).not.toBe(firstId);
    const rows = await refundsOf(o.orderId);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set([firstId, secondId]));
    expect(rows.every((r) => r.status === 'REJECTED')).toBe(true);
    expect((await itemsOf(o.orderId))[0]!.status).toBe('READY');
  });

  test('P-T64 ④ 결제사 취소 성공 뒤 환급 반영 DB 쓰기가 실패하면 202나 503으로 답하고 같은 취소 ID 재시도가 끝낸다', async () => {
    const p = await seedProduct({ fulfillments: ['PICKUP'], price: 21_000 });
    const o = await seedPaidOrder({ fulfillment: 'PICKUP', items: [{ productId: p, quantity: 1, unitAmount: 21_000 }] });
    await admin.pool.query('drop trigger if exists test_refund_fail_trg on merch_refund');
    await admin.pool.query(`create or replace function test_refund_fail() returns trigger language plpgsql as $f$ begin raise exception '시험: 환급 결과 DB 쓰기 실패'; end $f$`);
    await admin.pool.query(
      `create trigger test_refund_fail_trg before update on merch_refund for each row when (old.order_id = '${o.orderId}'::uuid and new.status = 'CANCELLED') execute function test_refund_fail()`,
    );
    let res: Awaited<ReturnType<typeof cancelOrder>>;
    try {
      res = await cancelOrder(o.accountId, o.orderId, {});
      // 결제사는 이미 취소했다. 환급 결과만 못 적었으므로 202 REFUND_PENDING이나 503 dependency-unavailable이어야 한다
      expect([202, 503], res.payload).toContain(res.statusCode);
      if (res.statusCode === 202) expect(bodyOf(res).status).toBe('REFUND_PENDING');
      else expect(problem(res).type).toContain('dependency-unavailable');
      expect(payments.cancels).toHaveLength(1);
      expect((await refundsOf(o.orderId))[0]!.status).toBe('REQUESTED');
      expect((await itemsOf(o.orderId))[0]!.status).toBe('READY');
    } finally {
      await admin.pool.query('drop trigger if exists test_refund_fail_trg on merch_refund');
      await admin.pool.query('drop function if exists test_refund_fail()');
    }
    // 같은 취소 ID로 다시 불러 끝낸다
    const retry = new MerchRefundRetry({ store: new DrizzleShopOrderStore(appDb, clock), payments, clock });
    clock.advance(60_000);
    expect(await retry.tick()).toMatchObject({ picked: 1, cancelled: 1 });
    expect(await refundsOf(o.orderId)).toMatchObject([{ id: payments.cancels[0]!.cancellationId, status: 'CANCELLED' }]);
    expect((await itemsOf(o.orderId))[0]).toMatchObject({ status: 'REFUNDED', refundedAmount: 21_000 });
  });

  test('M-47 취소 행·merch_refund_item만 커밋된 채 멈춰도 재시도가 같은 취소 ID로 끝내고 이중 환급 0건이다', async () => {
    const p = await seedProduct({ fulfillments: ['PICKUP'], price: 25_000 });
    const o = await seedPaidOrder({ fulfillment: 'PICKUP', items: [{ productId: p, quantity: 1, unitAmount: 25_000 }] });
    const store = new DrizzleShopOrderStore(appDb, clock);
    const refundId = randomUUID();
    const created = await store.createCancellation(once(o.accountId), {
      refundId,
      orderId: o.orderId,
      accountId: o.accountId,
      itemIds: [o.itemIds[0]!],
      nowMs: clock.now(),
    });
    expect(created.kind).toBe('created');
    // 취소 행과 항목 자리는 커밋됐고, 결제사 취소·항목 전이는 아직 없다
    expect(await refundsOf(o.orderId)).toMatchObject([{ id: refundId, status: 'REQUESTED' }]);
    expect(await refundItemsOf(o.orderId)).toHaveLength(1);
    expect((await itemsOf(o.orderId))[0]!.status).toBe('READY');
    expect(payments.cancels).toHaveLength(0);

    const retry = new MerchRefundRetry({ store, payments, clock });
    clock.advance(60_000);
    expect(await retry.tick()).toMatchObject({ picked: 1, cancelled: 1 });
    expect(payments.cancels).toHaveLength(1);
    expect(payments.cancels[0]!.cancellationId).toBe(refundId);
    expect(await refundsOf(o.orderId)).toMatchObject([{ id: refundId, status: 'CANCELLED' }]);
    expect((await itemsOf(o.orderId))[0]!.status).toBe('REFUNDED');
    expect(await refundItemsOf(o.orderId)).toHaveLength(1);
  });

  test('P-T64 ④ 결제사 취소 커밋 뒤 환급 반영이 실패해도 다음 재시도가 같은 취소 ID로 끝내고 이중 환급은 0건이다', async () => {
    const p = await seedProduct({ fulfillments: ['PICKUP'], price: 21_000 });
    const o = await seedPaidOrder({ fulfillment: 'PICKUP', items: [{ productId: p, quantity: 1, unitAmount: 21_000 }] });
    /** 결제사 취소는 나갔는데 항목 전이 커밋 전에 프로세스가 멈춘 꼴: 환급 결과 반영만 한 번 실패한다 */
    class DyingRefundStore extends DrizzleShopOrderStore {
      failOnce = true;
      override async refundResult(...args: Parameters<DrizzleShopOrderStore['refundResult']>): Promise<void> {
        if (this.failOnce) {
          this.failOnce = false;
          throw new Error('DB 쓰기 실패 주입(시험)');
        }
        return super.refundResult(...args);
      }
    }
    const dying = new DyingRefundStore(appDb, clock);
    const cancel = new MerchCancel({ store: dying, payments, reauth, clock });
    const request = once(o.accountId);
    await expect(cancel.run(o.accountId, randomUUID(), o.orderId, {}, request)).rejects.toThrow('DB 쓰기 실패 주입(시험)');
    // 끊긴 자리: 결제사 취소는 나갔고, 환급 행은 REQUESTED, 항목은 READY 그대로다
    expect(payments.cancels).toHaveLength(1);
    const cancellationId = payments.cancels[0]!.cancellationId;
    expect(payments.cancels[0]).toMatchObject({ cancellationId, amount: 21_000, reason: 'USER_CANCEL' });
    expect(await refundsOf(o.orderId)).toMatchObject([{ id: cancellationId, status: 'REQUESTED', amount: 21_000 }]);
    expect((await itemsOf(o.orderId))[0]).toMatchObject({ status: 'READY', refundedAmount: 0 });

    // 다음 재시도: 1분 − 1ms에는 부르지 않고 정각에 같은 취소 ID로 다시 불러 끝낸다
    const retry = new MerchRefundRetry({ store: dying, payments, clock });
    clock.advance(59_999);
    expect(await retry.tick()).toMatchObject({ picked: 0, cancelled: 0 });
    expect(payments.cancels).toHaveLength(1);
    clock.advance(1);
    expect(await retry.tick()).toMatchObject({ picked: 1, cancelled: 1 });
    expect(payments.cancels).toHaveLength(2);
    expect(new Set(payments.cancelIds)).toEqual(new Set([cancellationId]));
    expect(payments.cancels[1]).toMatchObject({ cancellationId, amount: 21_000, reason: 'USER_CANCEL' });
    // 항목·환급이 끝나고 이중 환급 0건(환급 행 1·환급액 21,000 한 번)
    expect((await itemsOf(o.orderId))[0]).toMatchObject({ status: 'REFUNDED', refundedAmount: 21_000 });
    expect(await refundsOf(o.orderId)).toMatchObject([{ id: cancellationId, status: 'CANCELLED', amount: 21_000 }]);
    const resolved = await refundItemsOf(o.orderId);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.resolved_at).not.toBeNull();
    // 두 번 돌려도 결제사를 더 부르지 않는다
    clock.advance(60_000);
    expect(await retry.tick()).toMatchObject({ picked: 0, cancelled: 0 });
    expect(payments.cancels).toHaveLength(2);
  });

  test('P-T64 ④ 미수령 자동 취소가 구매자 취소 대기와 겹치면 같은 항목을 두 번 환급하지 않는다', async () => {
    const p = await seedProduct({ fulfillments: ['PICKUP'], price: 12_000 });
    const eventId = randomUUID();
    const o = await seedPaidOrder({ fulfillment: 'PICKUP', eventId, items: [{ productId: p, quantity: 1, unitAmount: 12_000 }] });
    const slotId = (await admin.pool.query('select pickup_slot_id from merch_order where id = $1', [o.orderId])).rows[0].pickup_slot_id as string;
    await admin.pool.query('update pickup_slot set starts_at = $2, ends_at = $3 where id = $1', [slotId, new Date(clock.now() - 2 * DAY - 3_600_000), new Date(clock.now() - 2 * DAY)]);
    // 구매자 취소가 결제사 답을 기다리는 중: 항목은 READY, 활성 환급 자리(merch_refund_item)만 잡혀 있다
    const buyerRefund = randomUUID();
    await admin.pool.query(
      `insert into merch_refund (id, order_id, item_ids, amount, reason, status, kind, attempts, next_at, alerted, created_at, updated_at)
       values ($1, $2, $3::uuid[], $4, 'USER_CANCEL', 'REQUESTED', 'USER_CANCEL', 0, $5, false, $6, $6)`,
      [buyerRefund, o.orderId, [o.itemIds[0]!], 12_000, new Date(clock.now() + 60_000), new Date(clock.now())],
    );
    await admin.pool.query('insert into merch_refund_item (refund_id, item_id) values ($1, $2)', [buyerRefund, o.itemIds[0]!]);
    const unclaimed = new MerchUnclaimed({ store: new DrizzleShopOrderStore(appDb, clock), payments, clock });
    const before = payments.cancels.length;
    expect(await unclaimed.run()).toEqual({ cancelled: 0, refunds: 0 });
    expect(payments.cancels.length).toBe(before);
    expect(await refundsOf(o.orderId)).toMatchObject([{ id: buyerRefund, kind: 'USER_CANCEL', status: 'REQUESTED' }]);
    expect((await itemsOf(o.orderId))[0]!.status).toBe('READY');
  });
});

describe('부가 상품 구매자 취소(V-T35 ③)', () => {
  test('V-T35 ③ WALLET 취소는 입장 시작 전 202·전액 환급·공제 0이고 배송비 0, 티켓 취소·환급 호출 0이다. 입장 시작 뒤는 409 entry-started다', async () => {
    const eventId = await seedEvent(clock.now() + 2 * 3_600_000, clock.now() + 5 * 3_600_000);
    const p = await seedProduct({ fulfillments: ['WALLET'], price: 18_500, ticketLinked: true, linkedEventId: eventId });
    const o = await seedPaidOrder({ fulfillment: 'WALLET', eventId, items: [{ productId: p, quantity: 3, unitAmount: 18_500 }] });
    const heldBefore = held.calls.length;
    const res = await cancelOrder(o.accountId, o.orderId, { itemIds: [o.itemIds[0]!] });
    expect(res.statusCode, res.payload).toBe(202);
    const body = bodyOf(res);
    expect(body.status).toBe('REFUNDED');
    expect(body.refundAmount).toBe(55_500); // 3 × 18,500. POL-032 공제 없음
    expect(body.refundAmount).toBe(o.amount);
    expect((await admin.pool.query('select shipping_fee from merch_order where id = $1', [o.orderId])).rows[0].shipping_fee).toBe(0);
    expect(payments.cancels).toHaveLength(1);
    expect(payments.cancels[0]!.amount).toBe(55_500);
    expect((await refundsOf(o.orderId))[0]).toMatchObject({ amount: 55_500, kind: 'USER_CANCEL', status: 'CANCELLED' });
    expect((await itemsOf(o.orderId))[0]).toMatchObject({ status: 'REFUNDED', refundedAmount: 55_500 });
    expect(held.calls.length, '티켓 보유·취소·환급 호출 0').toBe(heldBefore);

    // 입장 시작 정각: 409 entry-started, 결제사·환급 0
    clock.advance(2 * 3_600_000);
    const after = await seedPaidOrder({ fulfillment: 'WALLET', eventId, items: [{ productId: p, quantity: 1, unitAmount: 18_500 }] });
    const blocked = await cancelOrder(after.accountId, after.orderId, {});
    expect(blocked.statusCode, blocked.payload).toBe(409);
    expect(problem(blocked).type).toContain('entry-started');
    expect(payments.cancels).toHaveLength(1);
    expect(await refundsOf(after.orderId)).toEqual([]);
    expect((await itemsOf(after.orderId))[0]!.status).toBe('READY');
    expect(held.calls.length, '티켓 보유·취소·환급 호출 0').toBe(heldBefore);
  });
});
