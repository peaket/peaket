// 굿즈 작업 일곱의 멱등 재생 대조 실제 연결 시험(AZ-T17 ⑥, W12-core-idem, ASVS v5.0.0-8.2.2).
// core-svc HTTP(AppModule DB 조립) + 실제 PostgreSQL 18(core_app·core_partner 로그인). 결제는 MemoryMerchPayments(부른 기록), 재고는 MemoryMerchStock,
// 티켓 보유는 MemoryHeldTickets, 시계는 가짜 시계다. 처음 요청은 HTTP로 내고, 기록의 결과 참조는 소유자 연결(admin, 슈퍼유저라 행 보안을 건너뛴다)로 바꿔
// DB 가드 없이 앱의 재생 대조만 본다(계획 3.2 '겹친 가드').
// 정본: ADR-0337 결정 6 — 결과 참조가 지금 요청의 계정과 경로의 주문에 속하지 않으면 처음 응답 대신 남의 주문과 같은 404 not-found,
// DB에 쓰지 않고 결제사를 부르지 않으며, 오류 로그 한 줄(kind idempotency-replay-mismatch, severity SEV2, operation, 경로의 주문 ID. 계정 ID·결과 참조 원문 없음).
// 바꾸지 않은 재요청은 처음과 같은 응답이다(docs/security/authz-matrix.md §7 AZ-T17 ⑥, docs/api/guidelines.md §4 '예외 셋째').
import 'reflect-metadata';
import { createDatabase, createService, ensureOutboxPartitions, fakeClock, requestFingerprint, systemClock, type Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { MemoryHeldTickets, MemoryMerchPayments, MemoryMerchStock, type ShopLogger, type ShopReauthGate } from '../src/modules/shop/index.js';
import { FakeIdentity, fan, quiet, testMedia } from '../test/support.js';
import { startPostgres, type PostgresContainer } from './postgres.js';
import { loginFor } from './roles.js';

const DAY = 86_400_000;
/** 시험 기준 시각(다른 shop 시험과 다른 값) */
const T0 = Date.parse('2026-12-14T02:10:00.000Z');
const clock = fakeClock({ now: T0 });
const SELLER = randomUUID();
const CONSENT = 'v2026.12-az-t17-replay';
/** 상품 가격(시험 값. 코드 상수와 다르게 고른다) */
const PRICE = 17_300;
const ACCOUNT_BODY = { bankCode: '88', accountNumber: '110-555-777777', holderName: '김재생' };
const MISMATCH = 'idempotency-replay-mismatch';

/** 재인증 확인기 대역(늘 통과). 재생 대조는 재인증과 관계없이 404여야 하므로 통과로 둔다 */
class PassReauth implements ShopReauthGate {
  readonly calls: string[] = [];
  async verify(_token: string | undefined, q: { readonly accountId: string }): Promise<boolean> {
    this.calls.push(q.accountId);
    return true;
  }
}

interface LogLine {
  level: 'info' | 'warn' | 'error';
  o: Record<string, unknown>;
  msg: string;
}
const logs: LogLine[] = [];
const logger: ShopLogger = {
  info: (o, msg) => {
    logs.push({ level: 'info', o: Object.fromEntries(Object.entries(o)), msg });
  },
  warn: (o, msg) => {
    logs.push({ level: 'warn', o: Object.fromEntries(Object.entries(o)), msg });
  },
  error: (o, msg) => {
    logs.push({ level: 'error', o: Object.fromEntries(Object.entries(o)), msg });
  },
};

const payments = new MemoryMerchPayments(() => clock.now());
const held = new MemoryHeldTickets();
const stock = new MemoryMerchStock();
const reauth = new PassReauth();

let pg: PostgresContainer;
let admin: Database;
let appDb: Database;
let partnerDb: Database;
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-shop-replay-int', max: 4 });
  await ensureOutboxPartitions(admin, systemClock);
  await ensureOutboxPartitions(admin, clock);
  appDb = await loginFor(admin, pg, 'core_app_login', 'core_app', 8);
  partnerDb = await loginFor(admin, pg, 'core_partner_login', 'core_partner', 2);
  await admin.pool.query('insert into promoter (id, legal_name) values ($1, $2)', [SELLER, '(주)재생굿즈']);
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ database: appDb, partnerDatabase: partnerDb, media: testMedia(), shop: { stock, payments, held, reauth, logger, consentVersion: CONSENT } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: new FakeIdentity(),
  });
});
afterAll(async () => {
  await svc?.close();
  await partnerDb?.close();
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
    delete from idempotency_record`);
  payments.calls.checkout.length = 0;
  payments.calls.confirm.length = 0;
  payments.calls.batch.length = 0;
  payments.calls.getPayment.length = 0;
  payments.calls.cancel.length = 0;
  payments.details.clear();
  held.rows.clear();
  reauth.calls.length = 0;
  logs.length = 0;
});

// ---- 자료 도우미 ----

async function seedProduct(o: { fulfillments: string[]; ticketLinked?: boolean; linkedEventId?: string | null }): Promise<string> {
  const id = randomUUID();
  await admin.pool.query(
    `insert into product (id, promoter_id, type, schema_version, name, status, price, shipping_fee, return_shipping_fee, return_address,
       limited_qty, transferable, ticket_linked, linked_event_id, fulfillments, commission_rate_bp, attributes, version, published_at, updated_at)
     values ($1, $2, 'MERCH', 1, '재생 시험 굿즈', 'PUBLISHED', $3, null, null, null, null, false, $4, $5, $6::text[], 1000, '{}'::jsonb, 1, $7, $7)`,
    [id, SELLER, PRICE, o.ticketLinked ?? false, o.linkedEventId ?? null, o.fulfillments, new Date(clock.now() - 10 * DAY)],
  );
  return id;
}

/** 현장 수령 시간대 하나(내일) */
async function seedSlot(productId: string): Promise<string> {
  const id = randomUUID();
  await admin.pool.query('insert into pickup_slot (id, product_id, event_id, starts_at, ends_at, ticket_holders_only) values ($1, $2, $3, $4, $5, false)', [
    id,
    productId,
    randomUUID(),
    new Date(clock.now() + DAY),
    new Date(clock.now() + DAY + 3_600_000),
  ]);
  return id;
}

/** 부가 상품의 연결 회차(입장 시작은 7일 뒤) */
async function seedEvent(): Promise<string> {
  const placeId = randomUUID();
  const productionId = randomUUID();
  const eventId = randomUUID();
  const entry = clock.now() + 7 * DAY;
  await admin.pool.query(`insert into place (id, name, address, region, created_by) values ($1, '재생 시험 공연장', '서울특별시 마포구', '서울', $2)`, [placeId, SELLER]);
  await admin.pool.query(`insert into production (id, promoter_id, place_id, title, genre, sale_review, sale_approved_at) values ($1, $2, $3, '재생 시험 공연', '콘서트', 'APPROVED', $4)`, [
    productionId,
    SELLER,
    placeId,
    new Date(clock.now() - 30 * DAY),
  ]);
  await admin.pool.query(`insert into event (id, production_id, promoter_id, venue_id, open_at, entry_opens_at, starts_at, ends_at) values ($1, $2, $3, null, $4, $5, $5, $6)`, [
    eventId,
    productionId,
    SELLER,
    new Date(entry - 2 * 3_600_000),
    new Date(entry),
    new Date(entry + 3 * 3_600_000),
  ]);
  return eventId;
}

/** PAID 현장 수령 주문과 항목 하나를 직접 넣는다(취소·반품 재생만 보는 시험. 주문 만들기는 shop-order 시험 몫) */
async function seedPaidOrder(accountId: string, productId: string, item: { status: 'READY' | 'PICKED_UP'; pickedUpAt?: number }): Promise<{ orderId: string; itemId: string }> {
  const orderId = randomUUID();
  const itemId = randomUUID();
  const slotId = randomUUID();
  await admin.pool.query('insert into pickup_slot (id, product_id, event_id, starts_at, ends_at, ticket_holders_only) values ($1, $2, $3, $4, $5, false)', [
    slotId,
    productId,
    randomUUID(),
    new Date(clock.now() + 3_600_000),
    new Date(clock.now() + 7_200_000),
  ]);
  await admin.pool.query(
    `insert into merch_order (id, promoter_id, event_id, status, pg, pg_store, shipping_fee, purchase_confirmed_at, ordered_at, account_id,
       fulfillment, amount, stock_reserved_until, payment_id, pickup_slot_id, paid_at, consent_version, recipient_name, recipient_phone, delivery_address, escrow)
     values ($1, $2, null, 'PAID', 'SIMULATOR', 'STANDARD', 0, null, $3, $4, 'PICKUP', $5, $6, $7, $8, $3, null, null, null, null, false)`,
    [orderId, SELLER, new Date(clock.now() - 3 * DAY), accountId, PRICE, new Date(clock.now() - 3 * DAY + 60_000), randomUUID(), slotId],
  );
  await admin.pool.query(
    `insert into merch_order_item (id, order_id, promoter_id, event_id, product_id, product_name, quantity, unit_amount, commission_rate_bp,
       status, fulfillment, ticket_linked, linked_ticket_id, option_snapshot, shipped_at, delivered_at, picked_up_at, event_ends_at)
     values ($1, $2, $3, null, $4, '재생 시험 굿즈', 1, $5, 1000, $6, 'PICKUP', false, null, '{"options":{},"name":"재생 시험 굿즈","type":"MERCH","schemaVersion":1}'::jsonb, null, null, $7, null)`,
    [itemId, orderId, SELLER, productId, PRICE, item.status, item.pickedUpAt === undefined ? null : new Date(item.pickedUpAt)],
  );
  // 취소가 읽는 결제 원장(카드 결제, 가상계좌 아님)
  payments.details.set(orderId, { orderId, status: 'APPROVED', pg: 'SIMULATOR', virtualAccountPaid: false });
  return { orderId, itemId };
}

// ---- HTTP·DB 도우미 ----

const headers = (accountId: string, key: string) => ({ ...fan(accountId), 'content-type': 'application/json', 'idempotency-key': key });
const post = (accountId: string, url: string, body: unknown, key: string = randomUUID()) => svc.http.inject({ method: 'POST', url, headers: headers(accountId, key), payload: JSON.stringify(body) });
const problem = (r: { statusCode: number; payload: string }) => {
  const b = JSON.parse(r.payload || '{}') as { type?: string; title?: string };
  return { status: r.statusCode, type: String(b.type ?? '').replace(/^.*\/problems\//, ''), title: b.title };
};
/** 남의 주문 404의 본문(다른 계정이 그 주문을 읽는다). 맞지 않는 재생은 이것과 같아야 한다 */
const foreign404 = async (orderId: string) => {
  const r = await svc.http.inject({ method: 'GET', url: `/v1/shop/orders/${orderId}`, headers: fan(randomUUID()) });
  const p = problem(r);
  expect(p).toMatchObject({ status: 404, type: 'not-found' });
  return p;
};
const orderIdOf = (r: { statusCode: number; payload: string }): string => {
  expect(r.statusCode, r.payload).toBe(201);
  return String((JSON.parse(r.payload) as { orderId: string }).orderId);
};

/** 기록의 결과 참조를 소유자 연결로 바꾼다(행 보안·칸 권한을 건너뛰어 앱 대조만 남긴다) */
async function setRef(accountRef: string, operation: string, key: string, ref: string): Promise<void> {
  const r = await admin.pool.query('update idempotency_record set result_ref = $4 where account_ref = $1 and operation = $2 and idempotency_key = $3', [accountRef, operation, key, ref]);
  expect(r.rowCount, `${operation} 기록`).toBe(1);
}

const TABLES = ['merch_order', 'merch_order_item', 'merch_payment_attempt', 'merch_confirm_job', 'merch_refund', 'merch_refund_item', 'outbox', 'idempotency_record'] as const;
/** 쓰기 0건 확인용: 표마다 행 수 */
async function writes(): Promise<Record<string, number>> {
  const r = await admin.pool.query(`select ${TABLES.map((t) => `(select count(*)::int from ${t}) as ${t}`).join(', ')}`);
  return r.rows[0] as Record<string, number>;
}
const itemStates = async (orderId: string) => (await admin.pool.query('select id, status, return_reason from merch_order_item where order_id = $1 order by id', [orderId])).rows as unknown[];

const mismatchLines = () => logs.filter((l) => l.o.kind === MISMATCH);
/** 오류 로그가 정확히 한 줄이고 정한 칸이 있으며, 계정 ID·결과 참조 원문 같은 값이 없다 */
function expectOneMismatch(what: string, operation: string, orderId: string | undefined, forbidden: readonly string[]): void {
  const lines = mismatchLines();
  expect(lines, what).toHaveLength(1);
  expect(lines[0], what).toMatchObject({ level: 'error', o: { kind: MISMATCH, severity: 'SEV2', operation, ...(orderId === undefined ? {} : { orderId }) } });
  const text = JSON.stringify(lines[0]);
  for (const f of forbidden) expect(text.includes(f), `${what}: 로그에 ${f}`).toBe(false);
}

describe('AZ-T17 ⑥ 굿즈 작업의 멱등 재생 대조', () => {
  test('AZ-T17 ⑥ 굿즈 주문·부가 상품 주문의 재생 참조가 다른 팬의 주문이면 404 not-found이고 그 주문 값이 응답에 없다 [ASVS v5.0.0-8.2.2]', async () => {
    const C = randomUUID();
    const D = randomUUID();
    // 굿즈 주문(CREATE_MERCH_ORDER)
    const product = await seedProduct({ fulfillments: ['PICKUP'] });
    const slot = await seedSlot(product);
    const body = { fulfillment: 'PICKUP', items: [{ productId: product, quantity: 1 }], pickupSlotId: slot };
    const K1 = randomUUID();
    const first = await post(C, '/v1/shop/orders', body, K1);
    const OC = orderIdOf(first);
    const OD = orderIdOf(await post(D, '/v1/shop/orders', body));
    const again = await post(C, '/v1/shop/orders', body, K1);
    expect({ status: again.statusCode, payload: again.payload }).toEqual({ status: 201, payload: first.payload });
    expect(mismatchLines()).toEqual([]);
    const notFound = await foreign404(OC);

    await setRef(C, 'CREATE_MERCH_ORDER', K1, OD);
    let before = await writes();
    logs.length = 0;
    let res = await post(C, '/v1/shop/orders', body, K1);
    expect(problem(res)).toEqual(notFound);
    expect(res.payload).not.toContain(OD);
    expect(await writes()).toEqual(before);
    expectOneMismatch('굿즈 주문', 'CREATE_MERCH_ORDER', undefined, [C, D, OD]);

    // 부가 상품 주문(CREATE_TICKET_ADDON)
    const event = await seedEvent();
    const addon = await seedProduct({ fulfillments: ['WALLET'], ticketLinked: true, linkedEventId: event });
    const TC = randomUUID();
    const TD = randomUUID();
    held.set(C, event, [TC]);
    held.set(D, event, [TD]);
    const addonBody = { productId: addon, quantity: 1 };
    const K2 = randomUUID();
    const firstAddon = await post(C, `/v1/tickets/${TC}/addons`, addonBody, K2);
    orderIdOf(firstAddon);
    const ODA = orderIdOf(await post(D, `/v1/tickets/${TD}/addons`, addonBody));
    logs.length = 0;
    const againAddon = await post(C, `/v1/tickets/${TC}/addons`, addonBody, K2);
    expect({ status: againAddon.statusCode, payload: againAddon.payload }).toEqual({ status: 201, payload: firstAddon.payload });
    expect(mismatchLines()).toEqual([]);

    await setRef(C, 'CREATE_TICKET_ADDON', K2, ODA);
    before = await writes();
    logs.length = 0;
    res = await post(C, `/v1/tickets/${TC}/addons`, addonBody, K2);
    expect(problem(res)).toEqual(notFound);
    expect(res.payload).not.toContain(ODA);
    expect(await writes()).toEqual(before);
    expectOneMismatch('부가 상품 주문', 'CREATE_TICKET_ADDON', undefined, [C, D, ODA]);
  });

  test('AZ-T17 ⑥ 결제 시도 재생의 시도 ID·결제사·금액이 경로 주문과 맞지 않으면 404 not-found이고 결제사를 부르지 않으며 바꾸지 않은 재요청은 처음 응답과 같다 [ASVS v5.0.0-8.2.2]', async () => {
    const C = randomUUID();
    const product = await seedProduct({ fulfillments: ['PICKUP'] });
    const slot = await seedSlot(product);
    const body = { fulfillment: 'PICKUP', items: [{ productId: product, quantity: 1 }], pickupSlotId: slot };
    // 같은 팬의 같은 금액 주문 둘(시도 ID 대조만이 둘을 가른다)
    const O1 = orderIdOf(await post(C, '/v1/shop/orders', body));
    const O2 = orderIdOf(await post(C, '/v1/shop/orders', body));
    const K3 = randomUUID();
    const first = await post(C, `/v1/shop/orders/${O1}/payments`, {}, K3);
    expect(first.statusCode, first.payload).toBe(201);
    type View = { attemptId: string; pg: string; checkout: { amount: number } & Record<string, unknown> } & Record<string, unknown>;
    const view1 = JSON.parse(first.payload) as View;
    const second = await post(C, `/v1/shop/orders/${O2}/payments`, {});
    expect(second.statusCode, second.payload).toBe(201);
    const view2 = JSON.parse(second.payload) as View;
    // 결제창 금액이 주문 금액이다(대조가 보는 값)
    expect({ amount: view1.checkout.amount, pg: view1.pg, other: view2.attemptId !== view1.attemptId }).toEqual({ amount: PRICE, pg: 'SIMULATOR', other: true });
    const again = await post(C, `/v1/shop/orders/${O1}/payments`, {}, K3);
    expect({ status: again.statusCode, payload: again.payload }).toEqual({ status: 201, payload: first.payload });
    expect(mismatchLines()).toEqual([]);
    const notFound = await foreign404(O1);
    const checkouts = payments.calls.checkout.length;
    expect(checkouts).toBe(2);

    const bumped = view1.checkout.amount + 1000;
    const notJson = `결제창 값 아님 ${randomUUID()}`;
    const cases: [string, string, string][] = [
      ['가 시도 ID를 같은 팬의 다른 주문 시도로', JSON.stringify({ ...view1, attemptId: view2.attemptId }), view2.attemptId],
      ['나 결제사', JSON.stringify({ ...view1, pg: 'TOSS' }), 'TOSS'],
      ['다 금액 + 1,000원', JSON.stringify({ ...view1, checkout: { ...view1.checkout, amount: bumped } }), String(bumped)],
      ['라 JSON이 아닌 글', notJson, notJson],
    ];
    for (const [what, ref, changed] of cases) {
      await setRef(C, 'START_MERCH_PAYMENT', K3, ref);
      const before = await writes();
      logs.length = 0;
      const res = await post(C, `/v1/shop/orders/${O1}/payments`, {}, K3);
      expect(problem(res), what).toEqual(notFound);
      expect(res.payload.includes(changed), what).toBe(false);
      expect(payments.calls.checkout.length, what).toBe(checkouts);
      expect(await writes(), what).toEqual(before);
      expectOneMismatch(what, 'START_MERCH_PAYMENT', O1, [C, ref]);
    }
  });

  test('AZ-T17 ⑥ 결제 접수 재생 참조가 목록 밖 값이면 404 not-found이고 승인 명령이 없다 [ASVS v5.0.0-8.2.2]', async () => {
    const C = randomUUID();
    const product = await seedProduct({ fulfillments: ['PICKUP'] });
    const slot = await seedSlot(product);
    const O3 = orderIdOf(await post(C, '/v1/shop/orders', { fulfillment: 'PICKUP', items: [{ productId: product, quantity: 1 }], pickupSlotId: slot }));
    const start = await post(C, `/v1/shop/orders/${O3}/payments`, {});
    expect(start.statusCode, start.payload).toBe(201);
    const acceptBody = { pg: 'SIMULATOR', paymentKey: `sim-${O3}`, amount: PRICE, attemptId: (JSON.parse(start.payload) as { attemptId: string }).attemptId };
    const url = `/v1/shop/orders/${O3}/payment-acceptance`;
    const K4 = randomUUID();
    const first = await post(C, url, acceptBody, K4);
    expect(first.statusCode, first.payload).toBe(202);
    const jobs = async () => Number((await admin.pool.query('select count(*)::int as n from merch_confirm_job where order_id = $1', [O3])).rows[0].n);
    expect({ confirms: payments.calls.confirm.length, jobs: await jobs() }).toEqual({ confirms: 1, jobs: 1 });
    const again = await post(C, url, acceptBody, K4);
    expect({ status: again.statusCode, payload: again.payload }).toEqual({ status: 202, payload: first.payload });
    expect(mismatchLines()).toEqual([]);
    const notFound = await foreign404(O3);

    for (const ref of ['ACCEPTED', 'x']) {
      await setRef(C, 'ACCEPT_MERCH_PAYMENT', K4, ref);
      const before = await writes();
      logs.length = 0;
      const res = await post(C, url, acceptBody, K4);
      expect(problem(res), ref).toEqual(notFound);
      expect({ confirms: payments.calls.confirm.length, jobs: await jobs() }, ref).toEqual({ confirms: 1, jobs: 1 });
      expect(await writes(), ref).toEqual(before);
      expectOneMismatch(ref, 'ACCEPT_MERCH_PAYMENT', O3, [C]);
    }
    // 목록 안 값(accepted)이면 처음과 같은 202이고 승인 명령을 다시 내지 않는다
    await setRef(C, 'ACCEPT_MERCH_PAYMENT', K4, 'accepted');
    logs.length = 0;
    const ok = await post(C, url, acceptBody, K4);
    expect({ status: ok.statusCode, payload: ok.payload }).toEqual({ status: 202, payload: first.payload });
    expect({ confirms: payments.calls.confirm.length, jobs: await jobs(), logs: mismatchLines() }).toEqual({ confirms: 1, jobs: 1, logs: [] });
  });

  test('AZ-T17 ⑥ 취소·환급 계좌 다시 받기 재생의 취소 ID가 다른 주문의 것이면 404 not-found이고 결제사 취소가 없다 [ASVS v5.0.0-8.2.2]', async () => {
    const C = randomUUID();
    const D = randomUUID();
    const product = await seedProduct({ fulfillments: ['PICKUP'] });
    const o5 = await seedPaidOrder(C, product, { status: 'READY' });
    const o6 = await seedPaidOrder(C, product, { status: 'READY' });
    const od = await seedPaidOrder(D, product, { status: 'READY' });
    const cancelUrl = (orderId: string) => `/v1/shop/orders/${orderId}/cancellations`;
    const cancellationOf = (r: { statusCode: number; payload: string }): string => {
      expect(r.statusCode, r.payload).toBe(202);
      return String((JSON.parse(r.payload) as { cancellationId: string }).cancellationId);
    };
    const K5 = randomUUID();
    const first = await post(C, cancelUrl(o5.orderId), {}, K5);
    const X5 = cancellationOf(first);
    const X6 = cancellationOf(await post(C, cancelUrl(o6.orderId), {}));
    const XD = cancellationOf(await post(D, cancelUrl(od.orderId), {}));
    const again = await post(C, cancelUrl(o5.orderId), {}, K5);
    expect({ status: again.statusCode, payload: again.payload }).toEqual({ status: 202, payload: first.payload });
    expect(mismatchLines()).toEqual([]);
    const notFound = await foreign404(o5.orderId);
    const cancels = payments.calls.cancel.length;
    expect(cancels).toBe(3);
    // 다른 팬 주문의 취소, 같은 팬의 다른 주문의 취소(계정 대조만으로는 못 거르는 경우)
    const others: [string, string][] = [
      ['다른 팬 주문의 취소', XD],
      ['같은 팬 다른 주문의 취소', X6],
    ];

    // 취소(CANCEL_MERCH_ORDER)
    for (const [what, target] of others) {
      await setRef(C, 'CANCEL_MERCH_ORDER', K5, `cancel:${target}`);
      const before = await writes();
      logs.length = 0;
      const res = await post(C, cancelUrl(o5.orderId), {}, K5);
      expect(problem(res), what).toEqual(notFound);
      expect(res.payload.includes(target), what).toBe(false);
      expect(payments.calls.cancel.length, what).toBe(cancels);
      expect(await writes(), what).toEqual(before);
      expectOneMismatch(`취소 ${what}`, 'CANCEL_MERCH_ORDER', o5.orderId, [C, D, `cancel:${target}`]);
    }

    // 환급 계좌 다시 받기(SHOP_CANCEL_REFUND_ACCOUNT): 재생 길이 맨 먼저 보므로 지문을 맞춘 기록만 넣는다
    const K7 = randomUUID();
    const accountUrl = `/v1/shop/orders/${o5.orderId}/cancellations/${X5}/account`;
    const payload = JSON.stringify(ACCOUNT_BODY);
    await admin.pool.query('insert into idempotency_record (account_ref, operation, idempotency_key, request_hash, result_ref, created_at) values ($1, $2, $3, $4, $5, $6)', [
      C,
      'SHOP_CANCEL_REFUND_ACCOUNT',
      K7,
      Buffer.from(requestFingerprint('POST', accountUrl, Buffer.from(payload, 'utf8'))),
      `cancel:${X5}`,
      new Date(clock.now()),
    ]);
    const retry = () => svc.http.inject({ method: 'POST', url: accountUrl, headers: { ...headers(C, K7), 'x-reauth-token': 'reauth-az-t17' }, payload });
    // 맞는 참조(경로 주문의 취소)는 그 취소의 상태로 답한다(지문이 맞는지도 이것으로 본다). 앞 취소 반복의 로그는 비우고 이 요청의 로그만 본다
    logs.length = 0;
    const own = await retry();
    expect({ status: own.statusCode, body: JSON.parse(own.payload) as unknown }).toEqual({ status: 202, body: { cancellationId: X5, status: 'REFUNDED', refundAmount: PRICE } });
    expect(mismatchLines()).toEqual([]);
    for (const [what, target] of others) {
      await setRef(C, 'SHOP_CANCEL_REFUND_ACCOUNT', K7, `cancel:${target}`);
      const before = await writes();
      logs.length = 0;
      const res = await retry();
      expect(problem(res), what).toEqual(notFound);
      expect(res.payload.includes(target), what).toBe(false);
      expect(payments.calls.cancel.length, what).toBe(cancels);
      expect(await writes(), what).toEqual(before);
      expectOneMismatch(`계좌 다시 받기 ${what}`, 'SHOP_CANCEL_REFUND_ACCOUNT', o5.orderId, [C, D, `cancel:${target}`, ACCOUNT_BODY.accountNumber, ACCOUNT_BODY.holderName]);
    }
  });

  test('AZ-T17 ⑥ 반품 재생 참조가 같은 팬의 다른 주문이면 404 not-found이고 그 주문 상세가 응답에 없다 [ASVS v5.0.0-8.2.2]', async () => {
    const C = randomUUID();
    const product = await seedProduct({ fulfillments: ['PICKUP'] });
    const picked = await seedPaidOrder(C, product, { status: 'PICKED_UP', pickedUpAt: clock.now() - DAY });
    const other = await seedPaidOrder(C, product, { status: 'READY' });
    const url = `/v1/shop/orders/${picked.orderId}/returns`;
    const body = { itemIds: [picked.itemId], reason: 'CHANGE_OF_MIND' };
    const K6 = randomUUID();
    const first = await post(C, url, body, K6);
    expect(first.statusCode, first.payload).toBe(200);
    expect(first.payload).toContain(picked.orderId);
    const again = await post(C, url, body, K6);
    expect({ status: again.statusCode, payload: again.payload }).toEqual({ status: 200, payload: first.payload });
    expect(mismatchLines()).toEqual([]);
    const notFound = await foreign404(picked.orderId);
    const otherItems = await itemStates(other.orderId);

    await setRef(C, 'RETURN_MERCH_ORDER', K6, `return:${other.orderId}`);
    const before = await writes();
    logs.length = 0;
    const res = await post(C, url, body, K6);
    expect(problem(res)).toEqual(notFound);
    expect(res.payload).not.toContain(other.orderId);
    expect(await writes()).toEqual(before);
    expect(await itemStates(other.orderId)).toEqual(otherItems);
    expectOneMismatch('반품', 'RETURN_MERCH_ORDER', picked.orderId, [C, `return:${other.orderId}`]);
  });
});
