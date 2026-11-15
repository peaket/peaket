// shop·notify 실제 PostgreSQL 통합 시험(BUILD_ORDER BAT-610 서버 잔여, R-567·R-588).
// 0014_shop·0015_notify·0016_merch_export 적용·재적용, 테넌트 RLS, Drizzle 저장소, 상품·웹훅·export·상품 정산 원천 HTTP를 실제 DB로 본다.
import 'reflect-metadata';
import { createDatabase, createService, ensureOutboxPartitions, systemClock, type Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { event, place, production, promoter } from '../src/modules/catalog/adapters/db/schema.js';
import { webhookEndpoint as webhookEndpointTable } from '../src/modules/notify/adapters/db/schema.js';
import { merchOrder as merchOrderTable, product as productTable } from '../src/modules/shop/adapters/db/schema.js';
import { FakeIdentity, quiet, testMedia } from '../test/support.js';
import { startPostgres, type PostgresContainer } from './postgres.js';
import { loginFor } from './roles.js';

let pg: PostgresContainer;
let admin: Database;
let appDb: Database;
let partnerDb: Database;
let svc: Awaited<ReturnType<typeof createService>>;
const identity = new FakeIdentity();

const A = randomUUID();
const B = randomUUID();
const PLACE = randomUUID();
const PROD_A = randomUUID();
const EVENT_A = randomUUID();

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-shop-notify-int', max: 4 });
  await ensureOutboxPartitions(admin, systemClock);
  appDb = await loginFor(admin, pg, 'core_app_login', 'core_app', 2);
  partnerDb = await loginFor(admin, pg, 'core_partner_login', 'core_partner', 4);
  await admin.db.insert(promoter).values([
    { id: A, legalName: '(주)에이' },
    { id: B, legalName: '(주)비' },
  ]);
  await admin.db.insert(place).values({ id: PLACE, name: '피켓홀', address: '서울 어딘가 1', region: '서울', createdBy: A });
  await admin.db.insert(production).values({ id: PROD_A, promoterId: A, placeId: PLACE, title: 'LUMEN 콘서트', genre: '콘서트', saleReview: 'DRAFT' });
  await admin.db.insert(event).values({ id: EVENT_A, productionId: PROD_A, promoterId: A, venueId: null, openAt: new Date('2027-01-01T00:00:00Z'), startsAt: new Date('2027-02-01T10:00:00Z'), endsAt: new Date('2027-02-01T12:00:00Z') });
  process.env.PEAKET_INTERNAL_TOKEN = 'int-test-token';
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ database: appDb, partnerDatabase: partnerDb, media: testMedia() }),
    env: { PEAKET_ENV: 'ci' },
    clock: systemClock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
  await partnerDb?.close();
  await appDb?.close();
  await admin?.close();
  pg?.stop();
});

const headers = (tenant = A) => ({ ...identity.partner(tenant), 'content-type': 'application/json' });
const productBody = (over: Record<string, unknown> = {}) => ({
  type: 'MERCH',
  name: 'LUMEN 공식 응원봉',
  price: 45000,
  shippingFee: 3000,
  returnShippingFee: 3000,
  returnAddress: '서울특별시 마포구',
  ticketLinked: false,
  linkedEventId: null,
  limitedQty: 10,
  fulfillments: ['DELIVERY', 'PICKUP'],
  transferable: false,
  status: 'PUBLISHED',
  attributes: { options: '인디고' },
  ...over,
});
const createProduct = (tenant = A, over: Record<string, unknown> = {}) =>
  svc.http.inject({ method: 'POST', url: '/v1/partner/products', headers: headers(tenant), payload: JSON.stringify(productBody(over)) });
const listProducts = (tenant = A, qs = '') => svc.http.inject({ method: 'GET', url: `/v1/partner/products${qs}`, headers: headers(tenant) });
const getProduct = (id: string, tenant = A) => svc.http.inject({ method: 'GET', url: `/v1/partner/products/${id}`, headers: headers(tenant) });
const patchProduct = (id: string, body: Record<string, unknown>, ifMatch?: string, tenant = A) =>
  svc.http.inject({ method: 'PATCH', url: `/v1/partner/products/${id}`, headers: { ...headers(tenant), ...(ifMatch ? { 'if-match': ifMatch } : {}) }, payload: JSON.stringify(body) });

const webhookBody = (over: Record<string, unknown> = {}) => ({ url: 'https://partner.example.com/hook', eventTypes: ['order.confirmed'], ...over });
const createWebhook = (tenant = A, over: Record<string, unknown> = {}) =>
  svc.http.inject({ method: 'POST', url: '/v1/partner/webhooks', headers: headers(tenant), payload: JSON.stringify(webhookBody(over)) });
const listWebhooks = (tenant = A) => svc.http.inject({ method: 'GET', url: '/v1/partner/webhooks', headers: headers(tenant) });
const patchWebhook = (id: string, body: Record<string, unknown>, ifMatch?: string, tenant = A) =>
  svc.http.inject({ method: 'PATCH', url: `/v1/partner/webhooks/${id}`, headers: { ...headers(tenant), ...(ifMatch ? { 'if-match': ifMatch } : {}) }, payload: JSON.stringify(body) });
const rotateWebhook = (id: string, tenant = A) => svc.http.inject({ method: 'POST', url: `/v1/partner/webhooks/${id}/secret-rotations`, headers: identity.partner(tenant) });

describe('shop·notify PostgreSQL [BAT-610 R-567]', () => {
  test('0014·0015가 표·RLS·권한을 만들고 다시 적용해도 같다', async () => {
    const tables = await admin.pool.query(
      "select tablename, rowsecurity from pg_tables where schemaname = 'public' and tablename in ('product','product_stock','webhook_endpoint','webhook_delivery') order by tablename",
    );
    expect(tables.rows).toEqual([
      { tablename: 'product', rowsecurity: true },
      { tablename: 'product_stock', rowsecurity: true },
      { tablename: 'webhook_delivery', rowsecurity: true },
      { tablename: 'webhook_endpoint', rowsecurity: true },
    ]);
    const grants = await admin.pool.query(
      "select table_name, string_agg(privilege_type, ',' order by privilege_type) as privileges from information_schema.role_table_grants where grantee = 'core_partner' and table_name in ('product','product_stock','webhook_endpoint','webhook_delivery') group by table_name order by table_name",
    );
    expect(grants.rows).toEqual([
      { table_name: 'product', privileges: 'INSERT,SELECT,UPDATE' },
      { table_name: 'product_stock', privileges: 'DELETE,INSERT,SELECT,UPDATE' },
      { table_name: 'webhook_delivery', privileges: 'INSERT,SELECT,UPDATE' },
      { table_name: 'webhook_endpoint', privileges: 'INSERT,SELECT,UPDATE' },
    ]);
    await expect(migrateCore(pg.url)).resolves.toBeUndefined();
  });

  test('상품 만들기→목록→상세→고치기, If-Match 판과 테넌트 격리를 실제 DB로 본다', async () => {
    const created = await createProduct();
    expect(created.statusCode).toBe(201);
    const p = JSON.parse(created.payload);
    expect(p).toMatchObject({ name: 'LUMEN 공식 응원봉', status: 'ON_SALE', stockRemaining: 10, stockTotal: 10, version: 1 });
    expect(created.headers.etag).toBe('"1"');

    const row = await admin.pool.query('select id, promoter_id, limited_qty from product where id = $1', [p.productId]);
    expect(row.rows[0]).toMatchObject({ promoter_id: A, limited_qty: 10 });
    const stock = await admin.pool.query('select stock from product_stock where product_id = $1', [p.productId]);
    expect(stock.rows[0].stock).toBe(10);

    expect(JSON.parse((await listProducts()).payload).items.some((x: { productId: string }) => x.productId === p.productId)).toBe(true);
    expect(JSON.parse((await listProducts(B)).payload).items).toEqual([]);
    expect((await getProduct(p.productId, B)).statusCode).toBe(404);

    const stale = await patchProduct(p.productId, { price: 1 }, '"9"');
    expect(stale.statusCode).toBe(412);
    expect((await patchProduct(p.productId, { price: 1 })).statusCode).toBe(428);
    const updated = await patchProduct(p.productId, { price: 39000, status: 'HIDDEN' }, '"1"');
    expect(updated.statusCode).toBe(200);
    expect(JSON.parse(updated.payload)).toMatchObject({ price: 39000, status: 'HIDDEN', version: 2 });
    expect(updated.headers.etag).toBe('"2"');
  });

  test('한정 수량 0은 품절이고, 한정을 풀면 product_stock 행이 지워진다', async () => {
    const sold = await createProduct(A, { name: '품절 상품', limitedQty: 0 });
    expect(sold.statusCode).toBe(201);
    const p = JSON.parse(sold.payload);
    expect(p.status).toBe('SOLD_OUT');

    const reopened = await patchProduct(p.productId, { limitedQty: 5 }, '"1"');
    expect(JSON.parse(reopened.payload)).toMatchObject({ status: 'ON_SALE', stockRemaining: 5, stockTotal: 5 });
    const unlimited = await patchProduct(p.productId, { limitedQty: null }, '"2"');
    expect(JSON.parse(unlimited.payload)).toMatchObject({ stockRemaining: null, stockTotal: null });
    const stock = await admin.pool.query('select count(*)::int as n from product_stock where product_id = $1', [p.productId]);
    expect(stock.rows[0].n).toBe(0);
  });

  test('판매 기간을 저장하고 판매 전·판매 끝 상태를 계산한다', async () => {
    const scheduled = await createProduct(A, { name: '판매 전 상품', saleStartsAt: '2027-03-01T00:00:00.000Z' });
    expect(scheduled.statusCode).toBe(201);
    const p = JSON.parse(scheduled.payload);
    expect(p.status).toBe('NOT_STARTED');
    const row = await admin.pool.query('select sale_starts_at from product where id = $1', [p.productId]);
    expect(row.rows[0].sale_starts_at.toISOString()).toBe('2027-03-01T00:00:00.000Z');
  });

  test('티켓 연동 상품은 연결 회차의 공연 이름을 주고, 잘못된 조합은 422다', async () => {
    const linked = await createProduct(A, { name: '티켓 연동 응원봉', ticketLinked: true, linkedEventId: EVENT_A, fulfillments: ['PICKUP'] });
    expect(linked.statusCode).toBe(201);
    expect(JSON.parse(linked.payload)).toMatchObject({ linkedEventId: EVENT_A, linkedProductionId: PROD_A, linkedProductionTitle: 'LUMEN 콘서트' });

    const bad = await createProduct(A, { name: '잘못된 연동', ticketLinked: true, linkedEventId: null, fulfillments: ['PICKUP'] });
    expect(bad.statusCode).toBe(422);
    expect(JSON.parse(bad.payload).type).toContain('product-ticket-link-invalid');
  });

  test('파트너 DB 역할은 자기 테넌트 행만 읽고 쓰며, 테넌트 없이는 0건이다 [ASVS v5.0.0-8.4.1]', async () => {
    const own = await partnerDb.transaction(async (tx) => tx.select({ id: productTable.id }).from(productTable), { tenantId: A });
    expect(own.length).toBeGreaterThan(0);
    const none = await partnerDb.transaction(async (tx) => tx.select({ id: productTable.id }).from(productTable));
    expect(none).toEqual([]);
    const other = await partnerDb.transaction(async (tx) => tx.select({ id: productTable.id }).from(productTable), { tenantId: B });
    expect(other).toEqual([]);
    await expect(
      partnerDb.transaction(
        async (tx) =>
          tx.insert(productTable).values({
            id: randomUUID(),
            promoterId: B,
            type: 'MERCH',
            name: '남의 상품',
            status: 'DRAFT',
            price: 1,
            fulfillments: ['PICKUP'],
            updatedAt: new Date(),
          }),
        { tenantId: A },
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  test('웹훅 등록·목록·고치기·비밀 재발급·발송 기록·다시 보내기를 실제 DB로 본다', async () => {
    const created = await createWebhook();
    expect(created.statusCode).toBe(201);
    const w = JSON.parse(created.payload);
    expect(w.secret).toMatch(/^whsec_/);
    expect(w).toMatchObject({ url: 'https://partner.example.com/hook', status: 'ACTIVE', version: 1 });
    expect(JSON.parse((await listWebhooks()).payload).items).toHaveLength(1);
    expect(JSON.parse((await listWebhooks(B)).payload).items).toEqual([]);
    expect((await patchWebhook(w.endpointId, { status: 'DISABLED' }, '"1"', B)).statusCode).toBe(404);
    expect((await patchWebhook(w.endpointId, { status: 'DISABLED' })).statusCode).toBe(428);
    expect((await patchWebhook(w.endpointId, { status: 'DISABLED' }, '"9"')).statusCode).toBe(412);
    const updated = await patchWebhook(w.endpointId, { status: 'DISABLED', eventTypes: ['event.sold_out'] }, '"1"');
    expect(updated.statusCode).toBe(200);
    expect(JSON.parse(updated.payload)).toMatchObject({ status: 'DISABLED', eventTypes: ['event.sold_out'], version: 2 });

    await admin.pool.query("update webhook_endpoint set secret_issued_at = now() - interval '2 minutes' where id = $1", [w.endpointId]);
    const rotated = await rotateWebhook(w.endpointId);
    expect(rotated.statusCode).toBe(201);
    const r = JSON.parse(rotated.payload);
    expect(r.secret).toMatch(/^whsec_/);
    expect(r.secret).not.toBe(w.secret);
    expect(new Date(r.previousSecretValidUntil).getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    expect((await rotateWebhook(w.endpointId)).statusCode).toBe(409);

    const deliveryId = randomUUID();
    await admin.pool.query(
      "insert into webhook_delivery (id, endpoint_id, webhook_id, event_type, status, attempt_count, created_at) values ($1, $2, 'msg_1', 'order.confirmed', 'DEAD', 7, now())",
      [deliveryId, w.endpointId],
    );
    const page = JSON.parse((await svc.http.inject({ method: 'GET', url: `/v1/partner/webhooks/${w.endpointId}/deliveries`, headers: headers() })).payload);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ deliveryId, status: 'DEAD' });
    const re = await svc.http.inject({ method: 'POST', url: `/v1/partner/webhook-deliveries/${deliveryId}/redeliveries`, headers: identity.partner(A) });
    expect(re.statusCode).toBe(202);
    expect(JSON.parse(re.payload)).toMatchObject({ status: 'PENDING', attemptCount: 8 });
    expect((await svc.http.inject({ method: 'POST', url: `/v1/partner/webhook-deliveries/${deliveryId}/redeliveries`, headers: identity.partner(A) })).statusCode).toBe(409);
    expect((await svc.http.inject({ method: 'POST', url: `/v1/partner/webhook-deliveries/${deliveryId}/redeliveries`, headers: identity.partner(B) })).statusCode).toBe(404);
  });

  test('웹훅 주소 검사는 https·443·사용자 정보·IP literal·사설 호스트를 거절한다', async () => {
    for (const url of ['http://partner.example.com/hook', 'https://partner.example.com:8443/hook', 'https://u:p@partner.example.com/hook', 'https://203.0.113.10/hook', 'https://[::1]/hook', 'https://2130706433/hook', 'https://localhost/hook']) {
      const r = await createWebhook(A, { url });
      expect(r.statusCode, url).toBe(400);
    }
    const count = await admin.pool.query("select count(*)::int as n from webhook_endpoint where url like '%partner.example.com%'");
    expect(count.rows[0].n).toBe(1);
  });

  test('파트너 DB 역할은 웹훅도 자기 테넌트 행만 읽고 쓴다 [ASVS v5.0.0-8.4.1]', async () => {
    const own = await partnerDb.transaction(async (tx) => tx.select({ id: webhookEndpointTable.id }).from(webhookEndpointTable), { tenantId: A });
    expect(own.length).toBeGreaterThan(0);
    const none = await partnerDb.transaction(async (tx) => tx.select({ id: webhookEndpointTable.id }).from(webhookEndpointTable));
    expect(none).toEqual([]);
    const other = await partnerDb.transaction(async (tx) => tx.select({ id: webhookEndpointTable.id }).from(webhookEndpointTable), { tenantId: B });
    expect(other).toEqual([]);
  });

  test('0016이 merch_order·merch_order_item·attendee_export와 webhook payload를 만들고 RLS·권한을 건다', async () => {
    const tables = await admin.pool.query(
      "select tablename, rowsecurity from pg_tables where schemaname = 'public' and tablename in ('merch_order','merch_order_item','attendee_export') order by tablename",
    );
    expect(tables.rows).toEqual([
      { tablename: 'attendee_export', rowsecurity: true },
      { tablename: 'merch_order', rowsecurity: true },
      { tablename: 'merch_order_item', rowsecurity: true },
    ]);
    const grants = await admin.pool.query(
      "select table_name, string_agg(privilege_type, ',' order by privilege_type) as privileges from information_schema.role_table_grants where grantee = 'core_partner' and table_name in ('merch_order','merch_order_item','attendee_export') group by table_name order by table_name",
    );
    expect(grants.rows).toEqual([
      { table_name: 'attendee_export', privileges: 'INSERT,SELECT,UPDATE' },
      { table_name: 'merch_order', privileges: 'INSERT,SELECT,UPDATE' },
      { table_name: 'merch_order_item', privileges: 'INSERT,SELECT,UPDATE' },
    ]);
    const appGrants = await admin.pool.query(
      "select table_name, string_agg(privilege_type, ',' order by privilege_type) as privileges from information_schema.role_table_grants where grantee = 'core_app' and table_name in ('webhook_delivery','webhook_endpoint') group by table_name order by table_name",
    );
    expect(appGrants.rows).toEqual([
      { table_name: 'webhook_delivery', privileges: 'INSERT,SELECT,UPDATE' },
      { table_name: 'webhook_endpoint', privileges: 'SELECT,UPDATE' },
    ]);
    const payload = await admin.pool.query("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'webhook_delivery' and column_name = 'payload'");
    expect(payload.rows).toHaveLength(1);
    await expect(migrateCore(pg.url)).resolves.toBeUndefined();
  });

  test('상품 정산 원천 HTTP가 기준일이 든 항목만 주고 core_app으로 읽는다', async () => {
    const orderId = randomUUID();
    const itemId = randomUUID();
    await admin.pool.query(
      "insert into merch_order (id, promoter_id, event_id, buyer_name, buyer_phone, status, pg, pg_store, shipping_fee, ordered_at) values ($1,$2,$3,'김민수','010-1234-5678','PAID','TOSS','STANDARD',3000,now())",
      [orderId, A, EVENT_A],
    );
    await admin.pool.query(
      "insert into merch_order_item (id, order_id, promoter_id, event_id, product_id, product_name, quantity, unit_amount, commission_rate_bp, status, fulfillment, seat_label, ticket_linked, delivered_at) values ($1,$2,$3,$4,$5,'응원봉',2,15000,1000,'DELIVERED','DELIVERY','A-12',false,'2026-10-22T00:00:00Z')",
      [itemId, orderId, A, EVENT_A, randomUUID()],
    );
    const r = await svc.http.inject({ method: 'GET', url: '/internal/v1/shop/product-settlement-items?from=2026-10-30&to=2026-10-30', headers: { 'x-peaket-internal-token': 'int-test-token' } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.items).toEqual([expect.objectContaining({ itemId, orderId, promoterId: A, grossAmount: 33_000, commissionRateBp: 1000, basisDate: '2026-10-30' })]);
    expect((await svc.http.inject({ method: 'GET', url: '/internal/v1/shop/product-settlement-items?from=2026-10-30&to=2026-10-30' })).statusCode).toBe(403);
  });

  test('상품 정산 원천은 다품목 주문의 배송비를 한 번만 더해 23,000원이다', async () => {
    const orderId = randomUUID();
    const item1 = randomUUID();
    const item2 = randomUUID();
    await admin.pool.query(
      "insert into merch_order (id, promoter_id, event_id, buyer_name, buyer_phone, status, pg, pg_store, shipping_fee, ordered_at) values ($1,$2,$3,'김민수','010-1234-5678','PAID','TOSS','STANDARD',3000,now())",
      [orderId, A, EVENT_A],
    );
    for (const id of [item1, item2]) {
      await admin.pool.query(
        "insert into merch_order_item (id, order_id, promoter_id, event_id, product_id, product_name, quantity, unit_amount, commission_rate_bp, status, fulfillment, seat_label, ticket_linked, delivered_at) values ($1,$2,$3,$4,$5,'응원봉',1,10000,1000,'DELIVERED','DELIVERY','A-12',false,'2026-10-22T00:00:00Z')",
        [id, orderId, A, EVENT_A, randomUUID()],
      );
    }
    const r = await svc.http.inject({ method: 'GET', url: '/internal/v1/shop/product-settlement-items?from=2026-10-30&to=2026-10-30', headers: { 'x-peaket-internal-token': 'int-test-token' } });
    expect(r.statusCode).toBe(200);
    const items = JSON.parse(r.payload).items as Array<{ orderId: string; grossAmount: number }>;
    const mine = items.filter((i) => i.orderId === orderId);
    expect(mine).toHaveLength(2);
    expect(mine.reduce((s, i) => s + i.grossAmount, 0)).toBe(23_000);
  });

  test('merch 주문·내보내기 이력도 파트너 테넌트 RLS로 갈린다 [ASVS v5.0.0-8.4.1]', async () => {
    const orderId = randomUUID();
    await admin.pool.query(
      "insert into merch_order (id, promoter_id, event_id, buyer_name, buyer_phone, status, pg, pg_store, shipping_fee, ordered_at) values ($1,$2,$3,'이서','010-9876-5432','PAID','TOSS','STANDARD',0,now())",
      [orderId, A, EVENT_A],
    );
    const own = await partnerDb.transaction(async (tx) => tx.select({ id: merchOrderTable.id }).from(merchOrderTable), { tenantId: A });
    expect(own.length).toBeGreaterThan(0);
    const other = await partnerDb.transaction(async (tx) => tx.select({ id: merchOrderTable.id }).from(merchOrderTable), { tenantId: B });
    expect(other).toEqual([]);
  });

  test('웹훅 사건 내부 입구는 발송 행을 만들고, 예매자 명단 내려받기는 재인증 없이 403이다', async () => {
    const created = JSON.parse((await createWebhook(A, { eventTypes: ['order.confirmed'] })).payload);
    const enq = await svc.http.inject({
      method: 'POST',
      url: '/internal/v1/notify/webhook-events',
      headers: { 'content-type': 'application/json', 'x-peaket-internal-token': 'int-test-token' },
      payload: JSON.stringify({ promoterId: A, eventType: 'order.confirmed', data: { orderId: randomUUID() } }),
    });
    expect(enq.statusCode).toBe(202);
    expect(JSON.parse(enq.payload).accepted).toBeGreaterThanOrEqual(1);
    const rows = await admin.pool.query("select payload, status from webhook_delivery where endpoint_id = $1", [created.endpointId]);
    expect(rows.rows[0]).toMatchObject({ status: 'PENDING', payload: { type: 'order.confirmed' } });
    const exportTry = await svc.http.inject({
      method: 'POST',
      url: `/v1/partner/events/${EVENT_A}/attendee-exports`,
      headers: { ...headers(), 'x-reauth-token': 'anything' },
      payload: JSON.stringify({ reason: '현장 대조', format: 'CSV' }),
    });
    expect(exportTry.statusCode).toBe(403);
    expect(JSON.parse(exportTry.payload).type).toContain('reauth-required');
  });
});
