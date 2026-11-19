// 굿즈·부가 상품 반품 요청 실제 연결 시험(BUILD_ORDER LCH-030, BAT-605, ADR-0315, POL-016 §1.4, P-T62 ①②③).
// core-svc HTTP(AppModule DB 조립) + 실제 PostgreSQL 18(core_app 로그인). 결제사는 부르지 않는 경로라 대역은 '부르면 실패'다.
// 정본:
// - 배송 완료는 받은 날 + 7일(단순 변심), 받은 날 + 3개월(이상·다름) 안이다. 받은 날 기록이 없으면 요청을 기한 안으로 받고 returnDueAt은 null이다.
// - '안 날부터 30일'은 서버가 알 수 없어 3개월만 본다(openapi createShopOrderReturn 설명).
// - DELIVERY는 SHIPPED(수취 거부)·DELIVERED, PICKUP은 PICKED_UP, WALLET은 READY·LOCKED이고 입장 시작 뒤에는 이상·다름만 받는다.
// - 반품 요청은 결제사를 부르지 않고 계좌도 받지 않는다. RETURN_REQUESTED·사유·반품 송장(선택)·요청 시각만 쓰고 merch_refund 행은 만들지 않는다.
// - 에스크로 주문은 구매 확정 전(이 묶음은 항상 null) 주문 전체 항목만 받는다(부분은 409 escrow-partial-not-allowed).
import 'reflect-metadata';
import { createDatabase, createService, ensureOutboxPartitions, fakeClock, systemClock, type Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { MemoryHeldTickets, MemoryMerchStock, closedShopReauthGate, type MerchPayments } from '../src/modules/shop/index.js';
import { FakeIdentity, fan, quiet, testMedia } from '../test/support.js';
import { startPostgres, type PostgresContainer } from './postgres.js';
import { loginFor } from './roles.js';

const CONSENT = 'v2026.11-19-bat605-int-return';
const DAY = 86_400_000;
const KST = (iso: string) => Date.parse(`${iso}+09:00`);
const T0 = Date.parse('2027-01-07T01:05:00.000Z');
const clock = fakeClock({ now: T0 });
const SELLER = randomUUID();

/** 반품 경로는 결제사를 부르지 않는다. 부르면 시험이 실패한다 */
class NoPayments implements MerchPayments {
  async prepareCheckout(): Promise<never> {
    throw new Error('반품 시험은 결제창을 부르지 않는다');
  }
  async confirm(): Promise<never> {
    throw new Error('반품 시험은 승인 명령을 부르지 않는다');
  }
  async batchGet(): Promise<never> {
    throw new Error('반품 시험은 결과 당기기를 부르지 않는다');
  }
  async getPayment(): Promise<never> {
    throw new Error('반품 시험은 결제 원장을 읽지 않는다');
  }
  async cancel(): Promise<never> {
    throw new Error('반품 시험은 결제사 취소를 부르지 않는다');
  }
}

const payments = new NoPayments();
const held = new MemoryHeldTickets();
const stock = new MemoryMerchStock();

let pg: PostgresContainer;
let admin: Database;
let appDb: Database;
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-shop-return-int', max: 6 });
  await ensureOutboxPartitions(admin, systemClock);
  appDb = await loginFor(admin, pg, 'core_app_login', 'core_app', 8);
  await admin.pool.query('insert into promoter (id, legal_name) values ($1, $2) on conflict (id) do nothing', [SELLER, '(주)시험굿즈']);
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({
      database: appDb,
      partnerDatabase: appDb,
      media: testMedia(),
      shop: { stock, payments, held, reauth: closedShopReauthGate, consentVersion: CONSENT },
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
    [id, SELLER, o.price ?? 12_000, o.shippingFee ?? null, o.returnShippingFee ?? null, o.returnAddress ?? null, o.ticketLinked ?? false, o.linkedEventId ?? null, o.fulfillments ?? ['DELIVERY'], new Date(clock.now() - 10 * DAY)],
  );
  return id;
}

async function seedEvent(entryOpensAtMs: number, endsAtMs: number): Promise<string> {
  const placeId = randomUUID();
  const productionId = randomUUID();
  const eventId = randomUUID();
  await admin.pool.query(
    `insert into place (id, name, address, region, created_by) values ($1, '반품 시험 공연장', '서울특별시 마포구', '서울', $2)`,
    [placeId, SELLER],
  );
  await admin.pool.query(
    `insert into production (id, promoter_id, place_id, title, genre, sale_review, sale_approved_at)
     values ($1, $2, $3, '반품 시험 공연', '콘서트', 'APPROVED', $4)`,
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

async function seedPaidOrder(o: OrderSpec): Promise<{ orderId: string; accountId: string; itemIds: string[]; amount: number }> {
  const accountId = o.accountId ?? randomUUID();
  const orderId = randomUUID();
  const paymentId = randomUUID();
  const amount = o.items.reduce((s, i) => s + (i.quantity ?? 1) * i.unitAmount, 0) + (o.shippingFee ?? 0);
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
      o.pgStore ?? (o.fulfillment === 'DELIVERY' ? 'ESCROW' : 'STANDARD'),
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
        spec.status ?? 'DELIVERED',
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
  return { orderId, accountId, itemIds, amount };
}

const itemRows = async (orderId: string) =>
  (await admin.pool.query('select id, status, return_reason, return_tracking_no, return_requested_at from merch_order_item where order_id = $1 order by id', [orderId])).rows.map((r) => ({
    id: r.id as string,
    status: r.status as string,
    returnReason: r.return_reason as string | null,
    returnTrackingNo: r.return_tracking_no as string | null,
    returnRequestedAt: r.return_requested_at === null ? null : new Date(r.return_requested_at as string | Date).getTime(),
  }));
const refundCount = async (orderId: string) => Number((await admin.pool.query('select count(*)::int as n from merch_refund where order_id = $1', [orderId])).rows[0].n);
const outboxCount = async () => Number((await admin.pool.query('select count(*)::int as n from outbox')).rows[0].n);

// ---- HTTP 도우미 ----

const h = (accountId: string, key = randomUUID()) => ({ ...fan(accountId), 'content-type': 'application/json', 'idempotency-key': key });
const requestReturn = (accountId: string, orderId: string, body: unknown, key = randomUUID()) =>
  svc.http.inject({ method: 'POST', url: `/v1/shop/orders/${orderId}/returns`, headers: h(accountId, key), payload: JSON.stringify(body) });
const problem = (r: { statusCode: number; payload: string }) => {
  const b = JSON.parse(r.payload) as { type?: string; title?: string; status?: number };
  return { status: r.statusCode, type: String(b.type ?? '').replace(/^.*\/problems\//, ''), title: b.title };
};
const bodyOf = (r: { payload: string }) =>
  JSON.parse(r.payload) as {
    status: string;
    items: { itemId: string; status: string; returnReason?: string | null; returnTrackingNo?: string | null; returnDueAt?: string | null; defectReturnDueAt?: string | null }[];
    returnPolicy?: { returnShippingFee: number };
    refundAmount?: number;
  };

describe('반품 기한과 반품 배송비(P-T62 ①)', () => {
  test('P-T62 ① 배송 완료 7일 − 1ms·7일 정각은 200 RETURN_REQUESTED·returnReason·returnDueAt·반품 배송비이고 7일 + 1ms는 409다', async () => {
    const now = clock.now();
    for (const [what, deliveredAt] of [
      ['7일 − 1ms', now - 7 * DAY + 1],
      ['7일 정각', now - 7 * DAY],
    ] as const) {
      const p = await seedProduct({ price: 12_300, shippingFee: 3_000, returnShippingFee: 2_500, returnAddress: '서울특별시 마포구 월드컵로 1' });
      const o = await seedPaidOrder({ fulfillment: 'DELIVERY', shippingFee: 3_000, items: [{ productId: p, quantity: 1, unitAmount: 12_300, status: 'DELIVERED', shippedAt: deliveredAt - DAY, deliveredAt }] });
      const res = await requestReturn(o.accountId, o.orderId, { itemIds: [o.itemIds[0]!], reason: 'CHANGE_OF_MIND', returnTrackingNo: '123456789012' });
      expect(res.statusCode, `${what}: ${res.payload}`).toBe(200);
      const body = bodyOf(res);
      expect(body.status, what).toBe('PAID');
      expect(body.items[0], what).toMatchObject({
        itemId: o.itemIds[0]!,
        status: 'RETURN_REQUESTED',
        returnReason: 'CHANGE_OF_MIND',
        returnTrackingNo: '123456789012',
        returnDueAt: new Date(deliveredAt + 7 * DAY).toISOString(),
      });
      expect(body.returnPolicy!.returnShippingFee, what).toBe(2_500);
      expect(body.refundAmount, what).toBeUndefined();
      const row = (await itemRows(o.orderId))[0]!;
      expect(row, what).toMatchObject({ status: 'RETURN_REQUESTED', returnReason: 'CHANGE_OF_MIND', returnTrackingNo: '123456789012', returnRequestedAt: now });
      expect(await refundCount(o.orderId), what).toBe(0);
      expect(await outboxCount(), what).toBe(0);
    }

    const late = await seedProduct({ price: 12_300, shippingFee: 3_000, returnShippingFee: 2_500, returnAddress: '서울특별시 마포구 월드컵로 1' });
    const o = await seedPaidOrder({ fulfillment: 'DELIVERY', shippingFee: 3_000, items: [{ productId: late, quantity: 1, unitAmount: 12_300, status: 'DELIVERED', shippedAt: now - 8 * DAY, deliveredAt: now - 7 * DAY - 1 }] });
    const res = await requestReturn(o.accountId, o.orderId, { itemIds: [o.itemIds[0]!], reason: 'CHANGE_OF_MIND' });
    expect(res.statusCode, res.payload).toBe(409);
    expect(problem(res).type).toContain('merch-return-not-allowed');
    expect(await itemRows(o.orderId)).toMatchObject([{ status: 'DELIVERED', returnReason: null, returnRequestedAt: null }]);
    expect(await refundCount(o.orderId)).toBe(0);
  });
});

describe('반품 사유·상태·기한 경계(P-T62 ②)', () => {
  test('P-T62 ② 이상·다름은 받은 날 + 3개월(달력) − 1ms·정각에 받고 + 1ms에는 거절한다. 안 날부터 30일은 서버가 보지 않는다', async () => {
    const deliveredAt = KST('2027-01-15T00:00:00');
    const due = KST('2027-04-15T00:00:00');
    const p = await seedProduct({ price: 12_300, shippingFee: 3_000, returnShippingFee: 2_500, returnAddress: '서울특별시 마포구 월드컵로 1' });
    const cases: [string, number, number][] = [
      ['3개월 − 1ms', due - 1, 200],
      ['3개월 정각', due, 200],
      ['3개월 + 1ms', due + 1, 409],
    ];
    for (const [what, at, expected] of cases) {
      clock.advance(at - clock.now());
      const o = await seedPaidOrder({ fulfillment: 'DELIVERY', shippingFee: 3_000, items: [{ productId: p, quantity: 1, unitAmount: 12_300, status: 'DELIVERED', shippedAt: deliveredAt - DAY, deliveredAt }] });
      const res = await requestReturn(o.accountId, o.orderId, { itemIds: [o.itemIds[0]!], reason: 'DEFECT_OR_MISMATCH' });
      expect(res.statusCode, `${what}: ${res.payload}`).toBe(expected);
      if (expected === 200) {
        expect(bodyOf(res).items[0], what).toMatchObject({ status: 'RETURN_REQUESTED', returnReason: 'DEFECT_OR_MISMATCH', defectReturnDueAt: new Date(due).toISOString() });
        // 이상·다름은 반품 배송비를 구매자가 부담하지 않는다: 이 요청에서 돈이 움직이지 않는다(환급 접수는 판매자 몫)
        expect(bodyOf(res).refundAmount, what).toBeUndefined();
        expect(await refundCount(o.orderId), what).toBe(0);
      } else {
        expect(problem(res).type, what).toContain('merch-return-not-allowed');
        expect((await itemRows(o.orderId))[0]!.status, what).toBe('DELIVERED');
      }
    }

    // 받은 날부터 45일이 지났어도 3개월 안이면 이상·다름을 받는다. '안 날부터 30일'은 서버가 알 수 없어 보지 않는다
    const o = await seedPaidOrder({ fulfillment: 'DELIVERY', shippingFee: 3_000, items: [{ productId: p, quantity: 1, unitAmount: 12_300, status: 'DELIVERED', shippedAt: due - 46 * DAY, deliveredAt: due - 45 * DAY }] });
    const res = await requestReturn(o.accountId, o.orderId, { itemIds: [o.itemIds[0]!], reason: 'DEFECT_OR_MISMATCH' });
    expect(res.statusCode, res.payload).toBe(200);
    expect(bodyOf(res).items[0]!.status).toBe('RETURN_REQUESTED');
  });

  test('P-T62 ② PICKED_UP도 수령 기록 + 7일까지 받고 그 뒤는 409이며, 받은 날 기록이 없으면 요청을 받고 returnDueAt은 null이다', async () => {
    const now = clock.now();
    const p = await seedProduct({ fulfillments: ['PICKUP'], price: 15_000 });
    const picked = await seedPaidOrder({ fulfillment: 'PICKUP', items: [{ productId: p, quantity: 1, unitAmount: 15_000, status: 'PICKED_UP', pickedUpAt: now - 7 * DAY }] });
    const ok = await requestReturn(picked.accountId, picked.orderId, { itemIds: [picked.itemIds[0]!], reason: 'CHANGE_OF_MIND' });
    expect(ok.statusCode, ok.payload).toBe(200);
    expect(bodyOf(ok).items[0]).toMatchObject({ status: 'RETURN_REQUESTED', returnDueAt: new Date(now).toISOString() });

    const late = await seedPaidOrder({ fulfillment: 'PICKUP', items: [{ productId: p, quantity: 1, unitAmount: 15_000, status: 'PICKED_UP', pickedUpAt: now - 7 * DAY - 1 }] });
    const blocked = await requestReturn(late.accountId, late.orderId, { itemIds: [late.itemIds[0]!], reason: 'CHANGE_OF_MIND' });
    expect(blocked.statusCode, blocked.payload).toBe(409);
    expect(problem(blocked).type).toContain('merch-return-not-allowed');

    // 받은 날 기록 없음: 기한 안으로 받고 returnDueAt은 null(안내 없음)
    const unknown = await seedPaidOrder({ fulfillment: 'DELIVERY', shippingFee: 3_000, items: [{ productId: await seedProduct({ price: 12_300, shippingFee: 3_000, returnShippingFee: 2_500, returnAddress: '서울특별시 마포구' }), quantity: 1, unitAmount: 12_300, status: 'DELIVERED', deliveredAt: null }] });
    const res = await requestReturn(unknown.accountId, unknown.orderId, { itemIds: [unknown.itemIds[0]!], reason: 'CHANGE_OF_MIND' });
    expect(res.statusCode, res.payload).toBe(200);
    expect(bodyOf(res).items[0]).toMatchObject({ status: 'RETURN_REQUESTED', returnDueAt: null });
    expect((await itemRows(unknown.orderId))[0]!.returnRequestedAt).toBe(now);
  });

  test('P-T62 ② READY는 409이고 SHIPPED는 수취 거부(I7)로 200이며 returnDueAt은 null이다', async () => {
    const now = clock.now();
    const p = await seedProduct({ price: 12_300, shippingFee: 3_000, returnShippingFee: 2_500, returnAddress: '서울특별시 마포구' });
    const ready = await seedPaidOrder({ fulfillment: 'DELIVERY', shippingFee: 3_000, items: [{ productId: p, quantity: 1, unitAmount: 12_300, status: 'READY' }] });
    const blocked = await requestReturn(ready.accountId, ready.orderId, { itemIds: [ready.itemIds[0]!], reason: 'DEFECT_OR_MISMATCH' });
    expect(blocked.statusCode, blocked.payload).toBe(409);
    expect(problem(blocked).type).toContain('merch-return-not-allowed');
    expect((await itemRows(ready.orderId))[0]!.status).toBe('READY');

    const shipped = await seedPaidOrder({ fulfillment: 'DELIVERY', shippingFee: 3_000, items: [{ productId: p, quantity: 1, unitAmount: 12_300, status: 'SHIPPED', shippedAt: now - 2 * DAY, deliveredAt: null }] });
    const ok = await requestReturn(shipped.accountId, shipped.orderId, { itemIds: [shipped.itemIds[0]!], reason: 'CHANGE_OF_MIND' });
    expect(ok.statusCode, ok.payload).toBe(200);
    expect(bodyOf(ok).items[0]).toMatchObject({ status: 'RETURN_REQUESTED', returnDueAt: null });
  });

  test('P-T62 ② 입장 시작 전 LOCKED 부가 상품은 단순 변심도 받고, 시작 뒤에는 이상·다름만 받는다', async () => {
    const eventId = await seedEvent(clock.now() + 3_600_000, clock.now() + 5 * 3_600_000);
    const p = await seedProduct({ fulfillments: ['WALLET'], price: 20_000, ticketLinked: true, linkedEventId: eventId });
    const before = await seedPaidOrder({ fulfillment: 'WALLET', eventId, items: [{ productId: p, quantity: 1, unitAmount: 20_000, status: 'LOCKED' }] });
    const ok = await requestReturn(before.accountId, before.orderId, { itemIds: [before.itemIds[0]!], reason: 'CHANGE_OF_MIND' });
    expect(ok.statusCode, ok.payload).toBe(200);
    expect(bodyOf(ok).items[0]).toMatchObject({ status: 'RETURN_REQUESTED', returnReason: 'CHANGE_OF_MIND', returnDueAt: null });

    // 입장 시작 정각: 단순 변심은 409, 이상·다름은 200
    clock.advance(3_600_000);
    const after = await seedPaidOrder({ fulfillment: 'WALLET', eventId, items: [{ productId: p, quantity: 1, unitAmount: 20_000, status: 'LOCKED' }] });
    const blocked = await requestReturn(after.accountId, after.orderId, { itemIds: [after.itemIds[0]!], reason: 'CHANGE_OF_MIND' });
    expect(blocked.statusCode, blocked.payload).toBe(409);
    expect(problem(blocked).type).toContain('merch-return-not-allowed');
    expect((await itemRows(after.orderId))[0]!.status).toBe('LOCKED');
    const defect = await requestReturn(after.accountId, after.orderId, { itemIds: [after.itemIds[0]!], reason: 'DEFECT_OR_MISMATCH' });
    expect(defect.statusCode, defect.payload).toBe(200);
    expect(bodyOf(defect).items[0]).toMatchObject({ status: 'RETURN_REQUESTED', returnReason: 'DEFECT_OR_MISMATCH' });
  });
});

describe('반품 요청은 돈을 움직이지 않는다(P-T62 ③)', () => {
  test('P-T62 ③ 반품 요청은 결제사 0건·계좌 없음·merch_refund 0행이고 RETURN_REQUESTED만 쓴다. 에스크로 부분 반품은 409·전체는 200이다', async () => {
    const now = clock.now();
    const p1 = await seedProduct({ price: 12_300, shippingFee: 3_000, returnShippingFee: 2_500, returnAddress: '서울특별시 마포구' });
    const p2 = await seedProduct({ price: 8_800, shippingFee: 3_000, returnShippingFee: 2_500, returnAddress: '서울특별시 마포구' });
    const o = await seedPaidOrder({
      fulfillment: 'DELIVERY',
      pgStore: 'ESCROW',
      shippingFee: 3_000,
      items: [
        { productId: p1, quantity: 1, unitAmount: 12_300, status: 'DELIVERED', shippedAt: now - 2 * DAY, deliveredAt: now - DAY },
        { productId: p2, quantity: 1, unitAmount: 8_800, status: 'DELIVERED', shippedAt: now - 2 * DAY, deliveredAt: now - DAY },
      ],
    });
    // 구매 확정 전(항상 null) 부분 반품: 409 escrow-partial-not-allowed, 쓰기 0
    const partial = await requestReturn(o.accountId, o.orderId, { itemIds: [o.itemIds[0]!], reason: 'CHANGE_OF_MIND' });
    expect(partial.statusCode, partial.payload).toBe(409);
    expect(problem(partial).type).toContain('escrow-partial-not-allowed');
    expect(await itemRows(o.orderId)).toMatchObject([
      { status: 'DELIVERED', returnReason: null, returnRequestedAt: null },
      { status: 'DELIVERED', returnReason: null, returnRequestedAt: null },
    ]);
    expect(await refundCount(o.orderId)).toBe(0);
    expect(await outboxCount()).toBe(0);

    // 전체 반품: 200이고 두 항목만 RETURN_REQUESTED, 환급 행·Outbox·계좌 0
    const full = await requestReturn(o.accountId, o.orderId, { itemIds: [...o.itemIds], reason: 'CHANGE_OF_MIND', returnTrackingNo: '987654321098' });
    expect(full.statusCode, full.payload).toBe(200);
    const body = bodyOf(full);
    expect(body.status).toBe('PAID');
    expect(body.items.map((i) => [i.status, i.returnReason, i.returnTrackingNo])).toEqual([
      ['RETURN_REQUESTED', 'CHANGE_OF_MIND', '987654321098'],
      ['RETURN_REQUESTED', 'CHANGE_OF_MIND', '987654321098'],
    ]);
    expect(await refundCount(o.orderId)).toBe(0);
    expect(await outboxCount()).toBe(0);
    expect(full.payload).not.toContain('accountNumber');
    expect(full.payload).not.toContain('holderName');
    const idem = (await admin.pool.query('select result_ref from idempotency_record where operation = $1', ['RETURN_MERCH_ORDER'])).rows;
    expect(idem.map((r) => r.result_ref)).toEqual([`return:${o.orderId}`]);

    // 계좌를 보내면 계약에 없는 칸이라 400이고 쓰기 0이다(반품은 계좌를 받지 않는다)
    const p3 = await seedProduct({ price: 10_000, shippingFee: 3_000, returnShippingFee: 2_500, returnAddress: '서울특별시 마포구' });
    const extra = await seedPaidOrder({ fulfillment: 'DELIVERY', shippingFee: 3_000, items: [{ productId: p3, quantity: 1, unitAmount: 10_000, status: 'DELIVERED', shippedAt: now - 2 * DAY, deliveredAt: now - DAY }] });
    const withAccount = await requestReturn(extra.accountId, extra.orderId, {
      itemIds: [extra.itemIds[0]!],
      reason: 'CHANGE_OF_MIND',
      refundAccount: { bankCode: '88', accountNumber: '110987654321', holderName: '김환불' },
    });
    expect(withAccount.statusCode, withAccount.payload).toBe(400);
    expect((await itemRows(extra.orderId))[0]!.status).toBe('DELIVERED');
    expect(await refundCount(extra.orderId)).toBe(0);
  });
});

describe('반품의 겹침·소유·입장 시각(RV-02·04·10)', () => {
  test('P-T62 ③ 취소가 진행 중인 항목에는 반품 요청을 409로 거절하고 쓰기 0이다', async () => {
    const eventId = await seedEvent(clock.now() + 3_600_000, clock.now() + 5 * 3_600_000);
    const p = await seedProduct({ fulfillments: ['WALLET'], price: 20_000, ticketLinked: true, linkedEventId: eventId });
    const o = await seedPaidOrder({ fulfillment: 'WALLET', eventId, items: [{ productId: p, quantity: 1, unitAmount: 20_000, status: 'READY' }] });
    const refundId = randomUUID();
    await admin.pool.query(
      `insert into merch_refund (id, order_id, item_ids, amount, reason, status, kind, attempts, next_at, alerted, created_at, updated_at)
       values ($1, $2, $3::uuid[], $4, 'USER_CANCEL', 'REQUESTED', 'USER_CANCEL', 0, $5, false, $6, $6)`,
      [refundId, o.orderId, [o.itemIds[0]!], 20_000, new Date(clock.now() + 60_000), new Date(clock.now())],
    );
    await admin.pool.query('insert into merch_refund_item (refund_id, item_id) values ($1, $2)', [refundId, o.itemIds[0]!]);
    const res = await requestReturn(o.accountId, o.orderId, { itemIds: [o.itemIds[0]!], reason: 'CHANGE_OF_MIND' });
    expect(res.statusCode, res.payload).toBe(409);
    expect(problem(res).type).toContain('merch-return-not-allowed');
    expect((await itemRows(o.orderId))[0]).toMatchObject({ status: 'READY', returnReason: null, returnRequestedAt: null });
    expect(await refundCount(o.orderId)).toBe(1);
  });

  test('P-T62 ② WALLET의 입장 시작 시각을 읽지 못하면(eventId 없음·event 행 없음) 단순 변심 반품을 409로 거절한다', async () => {
    const p = await seedProduct({ fulfillments: ['WALLET'], price: 20_000 });
    for (const [what, eventId] of [
      ['eventId 없음', null],
      ['event 행 없음', randomUUID()],
    ] as const) {
      const o = await seedPaidOrder({ fulfillment: 'WALLET', eventId, items: [{ productId: p, quantity: 1, unitAmount: 20_000, status: 'READY' }] });
      const res = await requestReturn(o.accountId, o.orderId, { itemIds: [o.itemIds[0]!], reason: 'CHANGE_OF_MIND' });
      expect(res.statusCode, `${what}: ${res.payload}`).toBe(409);
      expect(problem(res).type, what).toContain('merch-return-not-allowed');
      expect((await itemRows(o.orderId))[0]!.status, what).toBe('READY');
      expect(await refundCount(o.orderId), what).toBe(0);
    }
  });

  test('P-T62 ③ 다른 계정·없는 주문·남의 항목은 같은 404 not-found이고 쓰기 0이다', async () => {
    const now = clock.now();
    const p = await seedProduct({ price: 12_300, shippingFee: 3_000, returnShippingFee: 2_500, returnAddress: '서울특별시 마포구' });
    const owner = await seedPaidOrder({ fulfillment: 'DELIVERY', shippingFee: 3_000, items: [{ productId: p, quantity: 1, unitAmount: 12_300, status: 'DELIVERED', shippedAt: now - 2 * DAY, deliveredAt: now - DAY }] });
    const other = await seedPaidOrder({ fulfillment: 'DELIVERY', shippingFee: 3_000, items: [{ productId: p, quantity: 1, unitAmount: 12_300, status: 'DELIVERED', shippedAt: now - 2 * DAY, deliveredAt: now - DAY }] });
    const idemBefore = Number((await admin.pool.query('select count(*)::int as n from idempotency_record')).rows[0].n);
    const cases: [string, string, string, string[]][] = [
      ['다른 계정의 주문', other.accountId, owner.orderId, [owner.itemIds[0]!]],
      ['없는 주문', owner.accountId, randomUUID(), [randomUUID()]],
      ['다른 주문의 항목', owner.accountId, owner.orderId, [other.itemIds[0]!]],
    ];
    for (const [what, accountId, orderId, itemIds] of cases) {
      const res = await requestReturn(accountId, orderId, { itemIds, reason: 'CHANGE_OF_MIND' });
      expect(res.statusCode, `${what}: ${res.payload}`).toBe(404);
      expect(problem(res).type, what).toContain('not-found');
    }
    expect((await itemRows(owner.orderId)).every((i) => i.status === 'DELIVERED' && i.returnRequestedAt === null)).toBe(true);
    expect((await itemRows(other.orderId)).every((i) => i.status === 'DELIVERED' && i.returnRequestedAt === null)).toBe(true);
    expect(await refundCount(owner.orderId)).toBe(0);
    expect(await refundCount(other.orderId)).toBe(0);
    expect(Number((await admin.pool.query('select count(*)::int as n from idempotency_record')).rows[0].n)).toBe(idemBefore);
  });
});
