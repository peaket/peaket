// 굿즈 주문·한정 재고·결제 접수·결과 당기기 실제 연결 시험(BUILD_ORDER LCH-010, BAT-600, ADR-0300 결정 3~7, docs/data.md §4 경계 5).
// core-svc HTTP(AppModule DB 조립) + 실제 PostgreSQL 18(core_app·core_partner 로그인) + 실제 Valkey 8.1(RedisMerchStock).
// payment-svc는 이 파일 안의 가짜 결제 포트(부른 기록·결과를 시험이 정함), 티켓 보유는 MemoryHeldTickets다. 시계는 가짜 시계다.
// 결과 당기기·만료는 공개 유스케이스(MerchPaymentResults·MerchStockExpiry)의 tick을 시험이 부른다(릴레이 리더 반복의 한 바퀴).
// 값은 정본에서: 예약 15분·승인 기한 인증 + 10분·다시 보내기 1초부터·당기기 실패 5초 미룸(ADR-0300 결정 4~6), 한정 수량 고치기 식(결정 3), 키 이름(결정 3).
import 'reflect-metadata';
import { createDatabase, createHotRedis, createService, ensureOutboxPartitions, fakeClock, systemClock, type Database, type HotRedis } from '@peaket/platform';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { promoter } from '../src/modules/catalog/adapters/db/schema.js';
import {
  CreateMerchOrder,
  DrizzleShopOrderStore,
  MemoryHeldTickets,
  MerchPaymentResults,
  MerchStockExpiry,
  RedisMerchStock,
  type MerchPayments,
  type MerchStock,
  type PaymentState,
} from '../src/modules/shop/index.js';
import { FakeIdentity, fan, quiet, testMedia } from '../test/support.js';
import { startValkey, type ValkeyContainer } from '../../queue-svc/test-int/valkey.js';
import { startPostgres, type PostgresContainer } from './postgres.js';
import { loginFor } from './roles.js';

type Confirm = Parameters<MerchPayments['confirm']>[0];
type ConfirmResult = Awaited<ReturnType<MerchPayments['confirm']>>;

/** 가짜 payment-svc(시험 대역). 승인 명령·당기기·취소의 부른 기록을 남기고 결과는 시험이 정한다 */
class FakePayments implements MerchPayments {
  readonly confirms: Confirm[] = [];
  readonly batches: string[][] = [];
  readonly states = new Map<string, PaymentState>();
  confirmAnswer: ConfirmResult = { status: 'ACCEPTED' };
  batchDown = false;
  /** 참이면 승인 명령을 '적은' 뒤 confirmAnswer로 답한다(payment-svc가 명령을 원장에 적고 시간 초과로만 답한 꼴, 리뷰 RV-01) */
  recordOnConfirm = false;

  async prepareCheckout(q: Parameters<MerchPayments['prepareCheckout']>[0]) {
    const url = `http://localhost:3000/shop/checkout/return?order=${q.orderId}&pg=SIMULATOR`;
    return {
      pg: 'SIMULATOR' as const,
      switched: false,
      checkout: { clientKey: 'test_ck_sim', customerKey: 'cust-int', orderId: q.orderId, orderName: q.orderName, amount: q.amount, successUrl: url, failUrl: url },
      allowedPayMethods: ['CARD'],
    };
  }
  async confirm(c: Confirm): Promise<ConfirmResult> {
    this.confirms.push(c);
    if (this.recordOnConfirm && !this.states.has(c.orderId)) {
      this.states.set(c.orderId, { orderId: c.orderId, paymentId: randomUUID(), pg: 'SIMULATOR', status: 'ACCEPTED', approvedAtMs: undefined, failureCategory: undefined });
    }
    return this.confirmAnswer;
  }
  async batchGet(orderIds: readonly string[]): Promise<PaymentState[]> {
    this.batches.push([...orderIds]);
    if (this.batchDown) throw new Error('payment-svc 멈춤(시험)');
    return orderIds.flatMap((id) => (this.states.has(id) ? [this.states.get(id)!] : []));
  }
  async cancel(): Promise<'CANCELLED'> {
    return 'CANCELLED';
  }
  approve(orderId: string): void {
    this.states.set(orderId, { orderId, paymentId: randomUUID(), pg: 'SIMULATOR', status: 'APPROVED', approvedAtMs: clock.now(), failureCategory: undefined });
  }
  confirmsOf(orderId: string): number {
    return this.confirms.filter((c) => c.orderId === orderId).length;
  }
}

const NOW = Date.parse('2026-12-03T03:00:00.000Z');
const clock = fakeClock({ now: NOW });
const payments = new FakePayments();
const held = new MemoryHeldTickets();
const identity = new FakeIdentity();
const SELLER = randomUUID();
const SLOT_EVENT = randomUUID();

let pg: PostgresContainer;
let admin: Database;
let appDb: Database;
let partnerDb: Database;
let valkey: ValkeyContainer;
let redis: HotRedis;
let stock: RedisMerchStock;
let store: DrizzleShopOrderStore;
let results: MerchPaymentResults;
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-shop-order-int', max: 4 });
  await ensureOutboxPartitions(admin, systemClock);
  appDb = await loginFor(admin, pg, 'core_app_login', 'core_app', 12);
  partnerDb = await loginFor(admin, pg, 'core_partner_login', 'core_partner', 4);
  await admin.db.insert(promoter).values({ id: SELLER, legalName: '(주)루멘굿즈' });
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
  stock = new RedisMerchStock(redis);
  store = new DrizzleShopOrderStore(appDb, clock);
  results = new MerchPaymentResults({ store, stock, payments, clock });
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ database: appDb, partnerDatabase: partnerDb, media: testMedia(), shop: { stock, payments, held } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
  await redis?.close();
  valkey?.stop();
  await partnerDb?.close();
  await appDb?.close();
  await admin?.close();
  pg?.stop();
});

// ---- 도우미 ----

const problem = (r: { payload: string }) => String(JSON.parse(r.payload).type).replace(/^.*\/problems\//, '');
const keys = (p: string) => ({ stock: `shop:{product:${p}}:stock`, resv: `shop:{product:${p}}:resv`, qty: `shop:{product:${p}}:resv_qty`, unpaid: `shop:{product:${p}}:unpaid` });
const cmd = (args: string[]) => redis.command(args, { key: args[1]! });
const counter = async (p: string) => (await cmd(['GET', keys(p).stock])) as string | null;
const resvMembers = async (p: string) => ((await cmd(['ZRANGE', keys(p).resv, '0', '-1'])) as string[]).map(String).sort();
const resvScore = async (p: string, o: string) => {
  const s = await cmd(['ZSCORE', keys(p).resv, o]);
  return s === null ? null : Number(s);
};
const unpaidOf = async (p: string, a: string) => (await cmd(['HGET', keys(p).unpaid, a])) as string | null;
const productStock = async (p: string) => Number((await admin.pool.query('select stock from product_stock where product_id = $1', [p])).rows[0]?.stock);
const orderRow = async (o: string) =>
  (await admin.pool.query('select status, amount, stock_reserved_until, payment_id from merch_order where id = $1', [o])).rows[0] as { status: string; amount: number; stock_reserved_until: Date; payment_id: string | null } | undefined;
const statusOf = async (o: string) => (await orderRow(o))?.status;

let seq = 0;
/** 파트너 상품 만들기(HTTP, core_partner) + 현장 수령 시간대 한 줄(시험 데이터, 파트너 경로는 계약에 없음) */
async function product(o: { limitedQty?: number | null; price?: number; attributes?: Record<string, unknown>; saleEndsAt?: string | null } = {}): Promise<{ productId: string; slotId: string }> {
  seq++;
  const r = await svc.http.inject({
    method: 'POST',
    url: '/v1/partner/products',
    headers: { ...identity.partner(SELLER), 'content-type': 'application/json' },
    payload: JSON.stringify({
      type: 'MERCH',
      name: `시험 굿즈 ${seq}`,
      price: o.price ?? 12_000,
      shippingFee: 3000,
      returnShippingFee: 3000,
      returnAddress: '서울특별시 마포구',
      ticketLinked: false,
      linkedEventId: null,
      limitedQty: o.limitedQty === undefined ? 3 : o.limitedQty,
      fulfillments: ['PICKUP'],
      transferable: false,
      status: 'PUBLISHED',
      attributes: o.attributes ?? {},
      ...(o.saleEndsAt !== undefined ? { saleEndsAt: o.saleEndsAt } : {}),
    }),
  });
  expect(r.statusCode, r.payload).toBe(201);
  const productId = JSON.parse(r.payload).productId as string;
  const slotId = randomUUID();
  await admin.pool.query('insert into pickup_slot (id, product_id, event_id, starts_at, ends_at, ticket_holders_only) values ($1, $2, $3, $4, $5, false)', [
    slotId,
    productId,
    SLOT_EVENT,
    new Date(NOW + 10 * 86_400_000),
    new Date(NOW + 10 * 86_400_000 + 3_600_000),
  ]);
  return { productId, slotId };
}

const fanHeaders = (account: string) => ({ ...fan(account), 'content-type': 'application/json', 'idempotency-key': randomUUID() });
const order = (account: string, p: { productId: string; slotId: string }, quantity = 1) =>
  svc.http.inject({ method: 'POST', url: '/v1/shop/orders', headers: fanHeaders(account), payload: JSON.stringify({ fulfillment: 'PICKUP', items: [{ productId: p.productId, quantity }], pickupSlotId: p.slotId }) });
const startPayment = (account: string, orderId: string) => svc.http.inject({ method: 'POST', url: `/v1/shop/orders/${orderId}/payments`, headers: fanHeaders(account), payload: JSON.stringify({}) });
const acceptPayment = (account: string, orderId: string, amount: number, attemptId?: string) =>
  svc.http.inject({ method: 'POST', url: `/v1/shop/orders/${orderId}/payment-acceptance`, headers: fanHeaders(account), payload: JSON.stringify({ pg: 'SIMULATOR', paymentKey: `sim-${orderId}`, amount, ...(attemptId ? { attemptId } : {}) }) });

/** 주문 → 결제 시도 → 결제 접수(202)까지. 주문 ID를 돌려준다 */
async function orderAndAccept(account: string, p: { productId: string; slotId: string }, quantity = 1, amount?: number): Promise<string> {
  const o = await order(account, p, quantity);
  expect(o.statusCode, o.payload).toBe(201);
  const orderId = JSON.parse(o.payload).orderId as string;
  const s = await startPayment(account, orderId);
  expect(s.statusCode, s.payload).toBe(201);
  const a = await acceptPayment(account, orderId, amount ?? (await orderRow(orderId))!.amount, JSON.parse(s.payload).attemptId);
  expect(a.statusCode, a.payload).toBe(202);
  return orderId;
}

/** 당기기 한 바퀴를 확실히 돌리려고 모든 작업의 다음 시각을 지금으로 당긴다(시험 준비) */
const dueAllJobs = () => admin.pool.query('update merch_confirm_job set next_at = $1', [new Date(clock.now())]);

describe('굿즈 주문·한정 재고 실제 연결(PostgreSQL·Valkey)', () => {
  test('P-T57 ③ 한정 3개 상품에 계정 10개가 같은 때 1개씩 주문하면 201 3건·409 merch-sold-out 7건이고 모두 결제하면 product_stock 0·카운터 0·예약 원소 0이다 [ASVS v5.0.0-2.3.4]', async () => {
    const p = await product({ limitedQty: 3 });
    const accounts = Array.from({ length: 10 }, () => randomUUID());
    const answers = await Promise.all(accounts.map((a) => order(a, p)));
    const ok = answers.filter((r) => r.statusCode === 201);
    const sold = answers.filter((r) => r.statusCode === 409);
    expect(ok).toHaveLength(3);
    expect(sold).toHaveLength(7);
    for (const r of sold) expect(problem(r)).toBe('merch-sold-out');
    expect(await counter(p.productId)).toBe('0');
    const winners = answers.flatMap((r, i) => (r.statusCode === 201 ? [{ account: accounts[i]!, orderId: JSON.parse(r.payload).orderId as string }] : []));
    for (const w of winners) {
      const s = await startPayment(w.account, w.orderId);
      expect(s.statusCode).toBe(201);
      expect((await acceptPayment(w.account, w.orderId, 12_000, JSON.parse(s.payload).attemptId)).statusCode).toBe(202);
    }
    expect(await productStock(p.productId)).toBe(0);
    for (const w of winners) payments.approve(w.orderId);
    clock.advance(2_000);
    const tick = await results.tick();
    expect(tick.paid).toBe(3);
    for (const w of winners) expect(await statusOf(w.orderId)).toBe('PAID');
    expect(await productStock(p.productId)).toBe(0);
    expect(await counter(p.productId)).toBe('0');
    expect(await resvMembers(p.productId)).toEqual([]);
    const sum = await admin.pool.query("select coalesce(sum(i.quantity), 0)::int as n from merch_order_item i join merch_order o on o.id = i.order_id where i.product_id = $1 and o.status = 'PAID'", [p.productId]);
    expect(sum.rows[0].n).toBe(3);
  });

  test('P-T57 ④ 결제 접수 때 PostgreSQL 남은 수가 0이면(카운터는 1) 409 merch-sold-out, 주문 FAILED, ConfirmPayment 0건, 예약 원소 0이다 [ASVS v5.0.0-2.3.4]', async () => {
    const p = await product({ limitedQty: 3 });
    const a = randomUUID();
    const o = await order(a, p);
    expect(o.statusCode).toBe(201);
    const orderId = JSON.parse(o.payload).orderId as string;
    await cmd(['SET', keys(p.productId).stock, '1', 'KEEPTTL']);
    await admin.pool.query('update product_stock set stock = 0 where product_id = $1', [p.productId]);
    const s = await startPayment(a, orderId);
    expect(s.statusCode).toBe(201);
    const r = await acceptPayment(a, orderId, 12_000, JSON.parse(s.payload).attemptId);
    expect(r.statusCode).toBe(409);
    expect(problem(r)).toBe('merch-sold-out');
    expect(await statusOf(orderId)).toBe('FAILED');
    expect(payments.confirmsOf(orderId)).toBe(0);
    expect(await resvMembers(p.productId)).toEqual([]);
    expect(await unpaidOf(p.productId, a)).toBeNull();
    // 그 주문의 예약 1개가 카운터로 돌아왔다(1 + 1), PostgreSQL 남은 수는 0 그대로
    expect(await counter(p.productId)).toBe('2');
    expect(await productStock(p.productId)).toBe(0);
    expect((await admin.pool.query('select count(*)::int as n from merch_confirm_job where order_id = $1', [orderId])).rows[0].n).toBe(0);
  });

  test('P-T57 ⑤ 카운터 키를 지운 뒤 주문하면 카운터를 product_stock − 결제 접수 전 예약 합으로 다시 만들고 주문이 201이다', async () => {
    const p = await product({ limitedQty: 5 });
    const [x, z, y] = [randomUUID(), randomUUID(), randomUUID()];
    const ox = JSON.parse((await order(x, p, 2)).payload).orderId as string; // 접수 전 예약 2
    const oz = await orderAndAccept(z, p, 1); // 접수함: product_stock 5 → 4, 예약 합에서 빠진다
    expect(await productStock(p.productId)).toBe(4);
    expect(await counter(p.productId)).toBe('2');
    await cmd(['DEL', keys(p.productId).stock]);
    const r = await order(y, p, 1);
    expect(r.statusCode, r.payload).toBe(201);
    const oy = JSON.parse(r.payload).orderId as string;
    // 다시 만든 값 4 − 2 = 2에서 y가 1을 잡아 1
    expect(await counter(p.productId)).toBe('1');
    expect(await resvMembers(p.productId)).toEqual([ox, oy, oz].sort());
  });

  test('P-T57 ⑤ Redis 키 넷이 모두 사라진 뒤(재시작 흉내) 주문하면 결제 전 예약만 다시 넣고 카운터를 DB로 다시 만든다', async () => {
    const p = await product({ limitedQty: 5 });
    const [x, z, y] = [randomUUID(), randomUUID(), randomUUID()];
    const ox = JSON.parse((await order(x, p, 2)).payload).orderId as string;
    await orderAndAccept(z, p, 1);
    for (const k of Object.values(keys(p.productId))) await cmd(['DEL', k]);
    const r = await order(y, p, 1);
    expect(r.statusCode, r.payload).toBe(201);
    const oy = JSON.parse(r.payload).orderId as string;
    expect(await counter(p.productId)).toBe('1');
    expect(await resvMembers(p.productId)).toEqual([ox, oy].sort());
    expect(await unpaidOf(p.productId, x)).toBe(ox);
    expect(await unpaidOf(p.productId, y)).toBe(oy);
    expect(Number(await cmd(['HGET', keys(p.productId).qty, ox]))).toBe(2);
  });

  test('P-T57 ③ 재고 키 넷의 수명은 판매 종료 + 1일이고, 판매 종료가 없으면 30일이다(docs/data.md §3)', async () => {
    const ends = await product({ limitedQty: 3, saleEndsAt: new Date(NOW + 2 * 86_400_000).toISOString() });
    const open = await product({ limitedQty: 3, saleEndsAt: null });
    expect((await order(randomUUID(), ends)).statusCode).toBe(201);
    expect((await order(randomUUID(), open)).statusCode).toBe(201);
    for (const [p, ms] of [
      [ends.productId, 3 * 86_400_000],
      [open.productId, 30 * 86_400_000],
    ] as const) {
      for (const k of Object.values(keys(p))) {
        const pttl = Number(await cmd(['PTTL', k]));
        expect(pttl, k).toBeGreaterThan(ms - 60_000);
        expect(pttl, k).toBeLessThanOrEqual(ms);
      }
    }
  });

  test('P-T57 ⑧ 1개 팔린 뒤 한정 수량을 3에서 2로 고치면 남은 수 1이고 카운터 키가 지워진다. 2개 팔린 뒤 0으로 고치면 422 product-limited-qty-invalid이고 남은 수가 그대로다', async () => {
    const p = await product({ limitedQty: 3 });
    const o1 = await orderAndAccept(randomUUID(), p);
    payments.approve(o1);
    clock.advance(2_000);
    await results.tick();
    expect(await statusOf(o1)).toBe('PAID');
    expect(await productStock(p.productId)).toBe(2);
    expect(await counter(p.productId)).toBe('2');
    const partner = { ...identity.partner(SELLER), 'content-type': 'application/json' };
    const etag = (await svc.http.inject({ method: 'GET', url: `/v1/partner/products/${p.productId}`, headers: partner })).headers.etag as string;
    const down = await svc.http.inject({ method: 'PATCH', url: `/v1/partner/products/${p.productId}`, headers: { ...partner, 'if-match': etag }, payload: JSON.stringify({ limitedQty: 2 }) });
    expect(down.statusCode, down.payload).toBe(200);
    expect(JSON.parse(down.payload)).toMatchObject({ stockRemaining: 1, stockTotal: 2 });
    expect(await productStock(p.productId)).toBe(1);
    expect(await counter(p.productId)).toBeNull();
    // 다음 주문이 카운터를 DB로 다시 만든다(1 − 0 = 1, 주문이 1을 잡아 0)
    const o2 = await orderAndAccept(randomUUID(), p);
    expect(await counter(p.productId)).toBe('0');
    payments.approve(o2);
    clock.advance(2_000);
    await results.tick();
    expect(await statusOf(o2)).toBe('PAID');
    expect(await productStock(p.productId)).toBe(0);
    const etag2 = (await svc.http.inject({ method: 'GET', url: `/v1/partner/products/${p.productId}`, headers: partner })).headers.etag as string;
    const zero = await svc.http.inject({ method: 'PATCH', url: `/v1/partner/products/${p.productId}`, headers: { ...partner, 'if-match': etag2 }, payload: JSON.stringify({ limitedQty: 0 }) });
    expect(zero.statusCode, zero.payload).toBe(422);
    expect(problem(zero)).toBe('product-limited-qty-invalid');
    expect(await productStock(p.productId)).toBe(0);
    expect(await counter(p.productId)).toBe('0');
  });

  test('P-T42 ④ 한정 1개 상품을 같은 계정이 결제하지 않은 채 다시 주문하면 앞 주문이 EXPIRED로 끝나고 재고를 돌린 뒤 새 주문이 201이며 마지막 카운터는 0이다', async () => {
    const p = await product({ limitedQty: 1 });
    const a = randomUUID();
    const first = JSON.parse((await order(a, p)).payload).orderId as string;
    expect(await counter(p.productId)).toBe('0');
    const r = await order(a, p);
    expect(r.statusCode, r.payload).toBe(201);
    const second = JSON.parse(r.payload).orderId as string;
    expect(await statusOf(first)).toBe('EXPIRED');
    expect(await statusOf(second)).toBe('CREATED');
    expect(await counter(p.productId)).toBe('0');
    expect(await resvMembers(p.productId)).toEqual([second]);
    expect(await unpaidOf(p.productId, a)).toBe(second);
    expect(await productStock(p.productId)).toBe(1);
    // 다른 계정은 그동안 살 수 없다(초과 판매 0)
    const other = await order(randomUUID(), p);
    expect(other.statusCode).toBe(409);
    expect(problem(other)).toBe('merch-sold-out');
  });

  test('P-T42 ④ 같은 계정이 같은 한정 상품을 두 번 같은 때 주문하면 결제 전 주문은 하나만 남는다(나머지는 409 merch-order-in-progress이거나 EXPIRED)', async () => {
    const p = await product({ limitedQty: 1 });
    const a = randomUUID();
    const [r1, r2] = await Promise.all([order(a, p), order(a, p)]);
    const codes = [r1.statusCode, r2.statusCode].sort();
    expect(codes[0]).toBe(201);
    for (const r of [r1, r2]) if (r.statusCode === 409) expect(problem(r)).toBe('merch-order-in-progress');
    expect([201, 409]).toContain(codes[1]);
    const rows = (await admin.pool.query("select o.id, o.status from merch_order o join merch_order_item i on i.order_id = o.id where i.product_id = $1 and o.account_id = $2", [p.productId, a])).rows as { id: string; status: string }[];
    const created = rows.filter((x) => x.status === 'CREATED');
    expect(created).toHaveLength(1);
    expect(rows.filter((x) => x.status !== 'CREATED').every((x) => x.status === 'EXPIRED')).toBe(true);
    expect(await counter(p.productId)).toBe('0');
    expect(await resvMembers(p.productId)).toEqual([created[0]!.id]);
  });

  test('V-T35 ② 주문 뒤 파트너가 가격을 올려도 그 주문의 금액·항목 단가·옵션 스냅샷과 승인 명령 금액은 주문 때 값이다', async () => {
    const p = await product({ limitedQty: null, price: 31_000, attributes: { options: [{ name: '사이즈', values: ['M', 'L'] }] } });
    const a = randomUUID();
    const o = await svc.http.inject({
      method: 'POST',
      url: '/v1/shop/orders',
      headers: fanHeaders(a),
      payload: JSON.stringify({ fulfillment: 'PICKUP', items: [{ productId: p.productId, quantity: 2, options: { 사이즈: 'L' } }], pickupSlotId: p.slotId }),
    });
    expect(o.statusCode, o.payload).toBe(201);
    const orderId = JSON.parse(o.payload).orderId as string;
    const partner = { ...identity.partner(SELLER), 'content-type': 'application/json' };
    const etag = (await svc.http.inject({ method: 'GET', url: `/v1/partner/products/${p.productId}`, headers: partner })).headers.etag as string;
    const up = await svc.http.inject({
      method: 'PATCH',
      url: `/v1/partner/products/${p.productId}`,
      headers: { ...partner, 'if-match': etag },
      payload: JSON.stringify({ price: 47_000, attributes: { options: [{ name: '사이즈', values: ['S', 'M', 'L'] }] } }),
    });
    expect(up.statusCode, up.payload).toBe(200);
    const s = await startPayment(a, orderId);
    expect((await acceptPayment(a, orderId, 62_000, JSON.parse(s.payload).attemptId)).statusCode).toBe(202);
    expect((await orderRow(orderId))!.amount).toBe(62_000);
    const item = (await admin.pool.query('select unit_amount, option_snapshot from merch_order_item where order_id = $1', [orderId])).rows[0];
    expect(item.unit_amount).toBe(31_000);
    expect(item.option_snapshot).toMatchObject({ options: { 사이즈: 'L' } });
    expect(payments.confirms.filter((c) => c.orderId === orderId).map((c) => c.amount)).toEqual([62_000]);
  });

  test('P-T42 ⑤ F-3 Redis 예약 뒤 DB 넣기 전에 요청이 죽으면 같은 계정의 같은 상품 주문은 409 merch-order-in-progress이고, 예약 시각이 지나면 만료 작업이 DB에 없는 주문으로 한 번만 돌린다', async () => {
    const p = await product({ limitedQty: 3 });
    const a = randomUUID();
    let inserts = 0;
    let undos = 0;
    // 죽는 요청 흉내: 예약은 실제 Valkey에 남고, DB 넣기와 그 뒤의 되돌림이 모두 일어나지 않는다
    const dyingStore = new Proxy(store, {
      get(t, k, r) {
        if (k === 'insertOrder')
          return async () => {
            inserts++;
            throw new Error('프로세스 죽음(시험)');
          };
        const v = Reflect.get(t, k, r);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const dyingStock: MerchStock = new Proxy(stock, {
      get(t, k, r) {
        if (k === 'release')
          return async () => {
            undos++;
            throw new Error('프로세스 죽음(시험)');
          };
        const v = Reflect.get(t, k, r);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const dying = new CreateMerchOrder({ store: dyingStore, stock: dyingStock, held, clock, consentVersion: undefined });
    const once = { accountRef: a, operation: 'CREATE_MERCH_ORDER', key: randomUUID(), requestHash: createHash('sha256').update('f3').digest() };
    await expect(dying.shop(a, { fulfillment: 'PICKUP', items: [{ productId: p.productId, quantity: 2 }], pickupSlotId: p.slotId }, once)).rejects.toThrow();
    // 끊는 자리를 실제로 지났다: 예약은 Redis에 있고 DB에는 주문이 없다
    expect(inserts).toBe(1);
    expect(undos).toBe(1);
    const [ghost] = await resvMembers(p.productId);
    expect(ghost).toBeDefined();
    expect(await counter(p.productId)).toBe('1');
    expect(await orderRow(ghost!)).toBeUndefined();
    expect(await unpaidOf(p.productId, a)).toBe(ghost);
    const blocked = await order(a, p);
    expect(blocked.statusCode).toBe(409);
    expect(problem(blocked)).toBe('merch-order-in-progress');
    expect(await counter(p.productId)).toBe('1');
    // 예약 시각(주문 + 15분)이 되기 1ms 전에는 그대로, 그 시각에 돌린다
    const expiry = new MerchStockExpiry({ store, stock, clock });
    // (다른 시험의 주문도 같은 반복이 돌리므로 바퀴 합계가 아니라 이 상품의 키로 본다)
    clock.advance(15 * 60_000 - 1);
    await expiry.tick();
    expect(await counter(p.productId)).toBe('1');
    expect(await resvMembers(p.productId)).toEqual([ghost]);
    clock.advance(1);
    await expiry.tick();
    expect(await counter(p.productId)).toBe('3');
    expect(await resvMembers(p.productId)).toEqual([]);
    expect(Number(await cmd(['HLEN', keys(p.productId).qty]))).toBe(0);
    // 한 번만 돌린다
    await expiry.tick();
    expect(await counter(p.productId)).toBe('3');
    const again = await order(a, p);
    expect(again.statusCode, again.payload).toBe(201);
    expect(await counter(p.productId)).toBe('2');
  });

  test('P-T57 ① F-4 결제 접수 커밋 뒤 ConfirmPayment가 UNAVAILABLE이면 202이고, 작업이 1초 뒤(999ms에는 아님) 다시 보내 받아지면 승인이 반영된다', async () => {
    const p = await product({ limitedQty: 3 });
    const a = randomUUID();
    payments.confirmAnswer = { status: 'RETRYABLE', reason: 'UNAVAILABLE' };
    let orderId: string;
    try {
      orderId = await orderAndAccept(a, p);
    } finally {
      payments.confirmAnswer = { status: 'ACCEPTED' };
    }
    expect(payments.confirmsOf(orderId)).toBe(1);
    expect(await statusOf(orderId)).toBe('CREATED');
    expect(await productStock(p.productId)).toBe(2);
    clock.advance(999);
    await results.tick();
    expect(payments.confirmsOf(orderId)).toBe(1);
    clock.advance(1);
    await results.tick();
    expect(payments.confirmsOf(orderId)).toBe(2);
    payments.approve(orderId);
    clock.advance(2_000);
    await results.tick();
    expect(await statusOf(orderId)).toBe('PAID');
    expect(await productStock(p.productId)).toBe(2);
    expect(await counter(p.productId)).toBe('2');
    expect(await resvMembers(p.productId)).toEqual([]);
  });

  test('P-T57 ② F-4 ConfirmPayment가 승인 기한(인증 + 10분)까지 한 번도 받아지지 않으면 기한 1ms 전에는 다시 보내고, 기한에 주문 FAILED와 두 재고 복구다 [ASVS v5.0.0-2.3.3]', async () => {
    const p = await product({ limitedQty: 3 });
    const a = randomUUID();
    payments.confirmAnswer = { status: 'RETRYABLE', reason: 'UNAVAILABLE' };
    try {
      const authAt = clock.now();
      const orderId = await orderAndAccept(a, p);
      expect(await productStock(p.productId)).toBe(2);
      expect(await counter(p.productId)).toBe('2');
      // 기한 1ms 전까지 30초씩 돌린다(다시 보내기 간격 상한 30초)
      while (clock.now() + 30_000 < authAt + 10 * 60_000 - 1) {
        clock.advance(30_000);
        await results.tick();
      }
      clock.advance(authAt + 10 * 60_000 - 1 - clock.now());
      await dueAllJobs();
      const before = payments.confirmsOf(orderId);
      const t1 = await results.tick();
      expect(t1.failed).toBe(0);
      expect(payments.confirmsOf(orderId)).toBe(before + 1);
      expect(await statusOf(orderId)).toBe('CREATED');
      clock.advance(1);
      await dueAllJobs();
      const t2 = await results.tick();
      expect(t2.failed).toBe(1);
      expect(payments.confirmsOf(orderId)).toBe(before + 1);
      expect(await statusOf(orderId)).toBe('FAILED');
      expect(await productStock(p.productId)).toBe(3);
      expect(await counter(p.productId)).toBe('3');
      expect(await resvMembers(p.productId)).toEqual([]);
      expect((await admin.pool.query('select status from merch_payment_attempt where order_id = $1', [orderId])).rows.map((r) => r.status)).toEqual(['FAILED']);
      expect((await admin.pool.query('select count(*)::int as n from merch_confirm_job where order_id = $1', [orderId])).rows[0].n).toBe(0);
    } finally {
      payments.confirmAnswer = { status: 'ACCEPTED' };
    }
  });

  test('P-T57 ① F-5 BatchGetPayments가 실패하면 그 묶음을 5초 미루고(4,999ms에는 묻지 않음) 되살아나면 반영한다', async () => {
    const p = await product({ limitedQty: 3 });
    const orderId = await orderAndAccept(randomUUID(), p);
    payments.approve(orderId);
    payments.batchDown = true;
    try {
      clock.advance(2_000);
      const t = await results.tick();
      expect(t.pullFailed).toBe(true);
      expect(payments.batches.filter((b) => b.includes(orderId))).toHaveLength(1);
    } finally {
      payments.batchDown = false;
    }
    clock.advance(4_999);
    await results.tick();
    expect(payments.batches.filter((b) => b.includes(orderId))).toHaveLength(1);
    expect(await statusOf(orderId)).toBe('CREATED');
    clock.advance(1);
    await results.tick();
    expect(payments.batches.filter((b) => b.includes(orderId))).toHaveLength(2);
    expect(await statusOf(orderId)).toBe('PAID');
    expect(await resvMembers(p.productId)).toEqual([]);
  });

  test('P-T57 ② 결제사 거절을 당겨 오면 주문 FAILED, product_stock과 카운터가 3으로 돌아온다 [ASVS v5.0.0-2.3.3]', async () => {
    const p = await product({ limitedQty: 3 });
    const a = randomUUID();
    const orderId = await orderAndAccept(a, p);
    expect(await productStock(p.productId)).toBe(2);
    payments.states.set(orderId, { orderId, paymentId: randomUUID(), pg: 'SIMULATOR', status: 'FAILED', approvedAtMs: undefined, failureCategory: 'REJECTED' });
    clock.advance(2_000);
    expect((await results.tick()).failed).toBe(1);
    expect(await statusOf(orderId)).toBe('FAILED');
    expect(await productStock(p.productId)).toBe(3);
    expect(await counter(p.productId)).toBe('3');
    expect(await resvMembers(p.productId)).toEqual([]);
    expect(Number(await cmd(['HLEN', keys(p.productId).qty]))).toBe(0);
    expect(await unpaidOf(p.productId, a)).toBeNull();
    // 같은 결과를 두 번 받아도 한 번만 반영한다
    await admin.pool.query('insert into merch_confirm_job (order_id, attempt_id, attempt_no, pg, payment_ref, amount, authenticated_at, sent, tries, next_at) select $1, id, attempt_no, pg, \'{"kind":"toss","paymentKey":"x"}\'::jsonb, 12000, now(), true, 1, $2 from merch_payment_attempt where order_id = $1', [orderId, new Date(clock.now())]);
    await results.tick();
    expect(await statusOf(orderId)).toBe('FAILED');
    expect(await productStock(p.productId)).toBe(3);
    expect(await counter(p.productId)).toBe('3');
    await admin.pool.query('delete from merch_confirm_job where order_id = $1', [orderId]);
  });

  // ---- 리뷰 반영 RV-01(P-T57 ⑨, ADR-0300 결정 5 넷째 줄·결정 6): 승인 기한(인증 + 10분)이 지난 '받아짐 모름' 작업은 BatchGetPayments로 물어
  // 결제가 없을 때만 FAILED와 두 재고 복구, 있으면 받아짐으로 바꿔 당기기로 반영, 묻지 못하면 5초 미룸, 기한 뒤에는 ConfirmPayment를 다시 보내지 않는다.
  const DEADLINE_MS = 10 * 60_000;
  const jobCount = async (o: string) => Number((await admin.pool.query('select count(*)::int as n from merch_confirm_job where order_id = $1', [o])).rows[0].n);
  const batchesOf = (o: string) => payments.batches.filter((b) => b.includes(o)).length;
  /** 승인 기한 1ms 전까지 30초씩 당기기 바퀴를 돌린다(다시 보내기 간격 상한 30초) */
  async function runUntilJustBeforeDeadline(authAt: number): Promise<void> {
    while (clock.now() + 30_000 < authAt + DEADLINE_MS - 1) {
      clock.advance(30_000);
      await results.tick();
    }
    clock.advance(authAt + DEADLINE_MS - 1 - clock.now());
    await dueAllJobs();
    await results.tick();
  }

  test('P-T57 ⑨ F-4 ConfirmPayment가 명령을 적고 시간 초과로만 답한 채 승인 기한이 지나도 FAILED로 끝내지 않고, 뒤에 승인되면 PAID이며 재고를 돌리지 않는다 [ASVS v5.0.0-2.3.3]', async () => {
    const p = await product({ limitedQty: 3 });
    const a = randomUUID();
    payments.confirmAnswer = { status: 'RETRYABLE', reason: 'DEADLINE_EXCEEDED' };
    payments.recordOnConfirm = true;
    try {
      const authAt = clock.now();
      const orderId = await orderAndAccept(a, p);
      expect(payments.states.get(orderId)?.status).toBe('ACCEPTED');
      expect(await productStock(p.productId)).toBe(2);
      expect(await counter(p.productId)).toBe('2');
      await runUntilJustBeforeDeadline(authAt);
      expect(await statusOf(orderId)).toBe('CREATED');
      // 기한: 끝내기 전에 BatchGetPayments로 묻고, 결제가 있으므로 FAILED로 끝내지 않는다
      clock.advance(1);
      await dueAllJobs();
      const asked = batchesOf(orderId);
      const sentAtDeadline = payments.confirmsOf(orderId);
      const t = await results.tick();
      expect(t.failed).toBe(0);
      expect(batchesOf(orderId)).toBe(asked + 1);
      expect(await statusOf(orderId)).toBe('CREATED');
      expect(await productStock(p.productId)).toBe(2);
      expect(await counter(p.productId)).toBe('2');
      expect(await jobCount(orderId)).toBe(1);
      expect((await admin.pool.query('select status from merch_payment_attempt where order_id = $1', [orderId])).rows.map((r) => r.status)).toEqual(['ACCEPTED']);
      // 뒤에 승인되면 당기기로 PAID, 재고는 돌아오지 않는다(product_stock 2·카운터 2·예약 원소 0)
      payments.approve(orderId);
      clock.advance(2_000);
      await dueAllJobs();
      await results.tick();
      expect(await statusOf(orderId)).toBe('PAID');
      expect(await productStock(p.productId)).toBe(2);
      expect(await counter(p.productId)).toBe('2');
      expect(await resvMembers(p.productId)).toEqual([]);
      expect(await jobCount(orderId)).toBe(0);
      // 기한 뒤 ConfirmPayment는 0건이다
      expect(payments.confirmsOf(orderId)).toBe(sentAtDeadline);
    } finally {
      payments.confirmAnswer = { status: 'ACCEPTED' };
      payments.recordOnConfirm = false;
    }
  });

  test('P-T57 ⑨ 기한에 BatchGetPayments가 실패하면 FAILED로 끝내지 않고 5초 뒤 다시 묻는다(4,999ms에는 묻지 않음)', async () => {
    const p = await product({ limitedQty: 3 });
    const a = randomUUID();
    payments.confirmAnswer = { status: 'RETRYABLE', reason: 'UNAVAILABLE' };
    try {
      const authAt = clock.now();
      const orderId = await orderAndAccept(a, p);
      await runUntilJustBeforeDeadline(authAt);
      clock.advance(1);
      await dueAllJobs();
      const asked = batchesOf(orderId);
      payments.batchDown = true;
      try {
        const t = await results.tick();
        expect(t.failed).toBe(0);
        expect(batchesOf(orderId)).toBe(asked + 1);
      } finally {
        payments.batchDown = false;
      }
      expect(await statusOf(orderId)).toBe('CREATED');
      expect(await productStock(p.productId)).toBe(2);
      expect(await counter(p.productId)).toBe('2');
      expect(await jobCount(orderId)).toBe(1);
      clock.advance(4_999);
      await results.tick();
      expect(batchesOf(orderId)).toBe(asked + 1);
      expect(await statusOf(orderId)).toBe('CREATED');
      // 5초에 다시 묻고, 명령이 적히지 않았으므로(답에 없음) 이제 FAILED와 두 재고 복구다
      clock.advance(1);
      const t2 = await results.tick();
      expect(batchesOf(orderId)).toBe(asked + 2);
      expect(t2.failed).toBe(1);
      expect(await statusOf(orderId)).toBe('FAILED');
      expect(await productStock(p.productId)).toBe(3);
      expect(await counter(p.productId)).toBe('3');
      expect(await resvMembers(p.productId)).toEqual([]);
      expect(await jobCount(orderId)).toBe(0);
    } finally {
      payments.confirmAnswer = { status: 'ACCEPTED' };
    }
  });

  test('P-T57 ⑨ 기한 뒤에는 ConfirmPayment를 다시 보내지 않는다(받아진 작업이 당기기 답에 없으면 기한 전에는 다시 보내고, 기한에는 보내지 않고 FAILED와 두 재고 복구)', async () => {
    const p = await product({ limitedQty: 3 });
    const a = randomUUID();
    const authAt = clock.now();
    const orderId = await orderAndAccept(a, p);
    expect(payments.confirmsOf(orderId)).toBe(1);
    // 기한 전: 답에 없으면 다시 보낸다(ADR-0300 결정 6). 몇 바퀴 만에 보내는지는 정본이 정하지 않으므로 세 바퀴까지 본다
    clock.advance(2_000);
    for (let i = 0; i < 3 && payments.confirmsOf(orderId) < 2; i++) {
      await dueAllJobs();
      await results.tick();
    }
    expect(payments.confirmsOf(orderId)).toBe(2);
    expect(await statusOf(orderId)).toBe('CREATED');
    // 기한(인증 + 10분): 답에 없어도 다시 보내지 않고 FAILED로 끝낸다(세 바퀴 안에)
    clock.advance(authAt + DEADLINE_MS - clock.now());
    const sent = payments.confirmsOf(orderId);
    for (let i = 0; i < 3 && (await statusOf(orderId)) !== 'FAILED'; i++) {
      await dueAllJobs();
      await results.tick();
      expect(payments.confirmsOf(orderId)).toBe(sent);
    }
    expect(payments.confirmsOf(orderId)).toBe(sent);
    expect(await statusOf(orderId)).toBe('FAILED');
    expect(await productStock(p.productId)).toBe(3);
    expect(await counter(p.productId)).toBe('3');
    expect(await resvMembers(p.productId)).toEqual([]);
    expect(await jobCount(orderId)).toBe(0);
    // 뒤 바퀴에서도 0건
    for (let i = 0; i < 3; i++) {
      clock.advance(30_000);
      await results.tick();
    }
    expect(payments.confirmsOf(orderId)).toBe(sent);
  });
});
