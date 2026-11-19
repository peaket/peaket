// 굿즈 재고 예약 만료 작업 통합 시험(BUILD_ORDER LCH-010, BAT-600, P-T42 ①②③⑤, 장애 주입 F-1·F-2).
// 실제 PostgreSQL 18(core_app 역할)·실제 Valkey 8.1로 주문 만들기·결제 시도·결제 접수·결과 반영·만료 작업을 공개 경계(CreateMerchOrder·MerchPayment·
// MerchPaymentResults·MerchStockExpiry, DrizzleShopOrderStore·RedisMerchStock)에서 돌린다. payment-svc는 시험 안의 가짜 결제 포트다.
// 단언 값은 정본에서 가져온다: 재고 예약 15분(900,000ms, ADR-0107 결정 4·ADR-0300 결정 4), 결제 접수 때 인증 + 10분(600,000ms)과 지금 값 가운데 늦은 쪽(ADR-0300 결정 5),
// 접수한 주문은 만료하지 않고 점수를 지금 + 60초(60,000ms) 미룸(결정 7), Redis 키 넷 이름(결정 3, docs/data.md §3 굿즈 재고 키).
import { createDatabase, createHotRedis, ensureOutboxPartitions, fakeClock, systemClock, type Database, type FakeClock, type HotRedis } from '@peaket/platform';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import {
  CreateMerchOrder,
  DrizzleShopOrderStore,
  MemoryHeldTickets,
  MerchPayment,
  MerchPaymentResults,
  MerchStockExpiry,
  MerchUnclaimed,
  RedisMerchStock,
  ShopProblem,
  type ConfirmJob,
  type MerchPayments,
  type PaymentState,
} from '../src/modules/shop/index.js';
import { startValkey, type ValkeyContainer } from '../../queue-svc/test-int/valkey.js';
import { startPostgres, type PostgresContainer } from './postgres.js';
import { loginFor } from './roles.js';

let pgc: PostgresContainer;
let valkey: ValkeyContainer;
let admin: Database;
let appDb: Database;
let redis: HotRedis;
let stock: RedisMerchStock;

const PROMOTER = randomUUID();
const EVENT = randomUUID();
/** 정본 값(ADR-0107 결정 4, ADR-0300 결정 4·5·7) */
const RESERVATION_MS = 15 * 60 * 1000;
const CONFIRM_WINDOW_MS = 10 * 60 * 1000;
const ACCEPTED_DEFER_MS = 60 * 1000;
/** 시험의 한정 수량(코드 기본값과 다르게) */
const LIMITED = 3;
const PRICE = 17_000;

beforeAll(async () => {
  pgc = await startPostgres();
  await migrateCore(pgc.url);
  admin = createDatabase({ url: pgc.url, applicationName: 'core-svc-shop-expiry-int', max: 4 });
  await ensureOutboxPartitions(admin, systemClock);
  appDb = await loginFor(admin, pgc, 'core_app_login', 'core_app', 8);
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
  stock = new RedisMerchStock(redis);
});
afterAll(async () => {
  await redis?.close();
  await appDb?.close();
  await admin?.close();
  valkey?.stop();
  pgc?.stop();
});

beforeEach(async () => {
  // 사례마다 주문·예약을 비우고 앞 사례의 상품을 만료 작업 대상에서 뺀다(틱의 셈을 정확히 보려고)
  await admin.pool.query('delete from merch_refund_item; delete from merch_refund; delete from merch_confirm_job; delete from merch_payment_attempt; delete from merch_order_item; delete from merch_order');
  await admin.pool.query(`update product set status = 'DRAFT'`);
  await redis.command(['FLUSHALL']);
});

// ---- 시험 대역 ----

class FakePayments implements MerchPayments {
  readonly confirms: ConfirmJob[] = [];
  readonly batchCalls: string[][] = [];
  readonly cancels: Parameters<MerchPayments['cancel']>[0][] = [];
  states = new Map<string, PaymentState>();
  async prepareCheckout(q: Parameters<MerchPayments['prepareCheckout']>[0]) {
    return {
      pg: 'SIMULATOR' as const,
      switched: false,
      allowedPayMethods: ['CARD'],
      checkout: { clientKey: 'sim_ck_test', customerKey: 'c'.repeat(32), orderId: q.orderId, orderName: q.orderName, amount: q.amount, successUrl: 'https://web.test/s', failUrl: 'https://web.test/f' },
    };
  }
  async confirm(c: ConfirmJob) {
    this.confirms.push(c);
    return { status: 'ACCEPTED' as const };
  }
  async batchGet(ids: readonly string[]) {
    this.batchCalls.push([...ids]);
    return ids.flatMap((id) => (this.states.has(id) ? [this.states.get(id)!] : []));
  }
  async cancel(c: Parameters<MerchPayments['cancel']>[0]): Promise<'CANCELLED'> {
    this.cancels.push(c);
    return 'CANCELLED';
  }
}

const once = (accountId: string, operation: string) => ({ accountRef: accountId, operation, key: randomUUID(), requestHash: new Uint8Array(randomBytes(32)) });

/** 한정 수량 상품 하나와 그 상품의 현장 수령 시간대(끝 시각은 넉넉히 뒤) */
async function limitedProduct(startMs: number): Promise<{ productId: string; slotId: string }> {
  const productId = randomUUID();
  const slotId = randomUUID();
  await admin.pool.query(
    `insert into product (id, promoter_id, type, schema_version, name, status, price, limited_qty, fulfillments, attributes, updated_at)
     values ($1, $2, 'MERCH', 1, '한정 응원 타월', 'PUBLISHED', $3, $4, '{PICKUP}', '{}'::jsonb, now())`,
    [productId, PROMOTER, PRICE, LIMITED],
  );
  await admin.pool.query('insert into product_stock (product_id, stock, updated_at) values ($1, $2, now())', [productId, LIMITED]);
  await admin.pool.query('insert into pickup_slot (id, product_id, event_id, starts_at, ends_at) values ($1, $2, $3, $4, $5)', [
    slotId,
    productId,
    EVENT,
    new Date(startMs + 24 * 3600_000),
    new Date(startMs + 30 * 24 * 3600_000),
  ]);
  return { productId, slotId };
}

function world(clock: FakeClock) {
  const store = new DrizzleShopOrderStore(appDb, clock);
  const payments = new FakePayments();
  const orders = new CreateMerchOrder({ store, stock, held: new MemoryHeldTickets(), clock, consentVersion: '2027-01-01' });
  const payment = new MerchPayment({ store, stock, payments, clock });
  return { store, payments, orders, payment };
}

async function order(w: ReturnType<typeof world>, accountId: string, p: { productId: string; slotId: string }, quantity = 1): Promise<string> {
  const v = await w.orders.shop(accountId, { fulfillment: 'PICKUP', items: [{ productId: p.productId, quantity }], pickupSlotId: p.slotId }, once(accountId, 'CREATE_MERCH_ORDER'));
  return v.orderId;
}

const startPayment = (w: ReturnType<typeof world>, accountId: string, orderId: string) => w.payment.start(accountId, orderId, {}, once(accountId, 'START_MERCH_PAYMENT'));
const accept = (w: ReturnType<typeof world>, accountId: string, orderId: string) =>
  w.payment.accept(accountId, orderId, { pg: 'SIMULATOR', paymentKey: `sim_pk_${orderId.slice(0, 8)}`, amount: PRICE }, once(accountId, 'ACCEPT_MERCH_PAYMENT'));

// ---- 저장소 읽기(정본의 키 이름을 그대로 적는다) ----

const keys = (productId: string) => {
  const tag = `shop:{product:${productId}}`;
  return { stock: `${tag}:stock`, resv: `${tag}:resv`, qty: `${tag}:resv_qty`, unpaid: `${tag}:unpaid` };
};
const counter = async (productId: string) => (await redis.command(['GET', keys(productId).stock])) as string | null;
const score = async (productId: string, orderId: string) => {
  const s = (await redis.command(['ZSCORE', keys(productId).resv, orderId])) as string | null;
  return s === null ? null : Number(s);
};
const resvQty = async (productId: string, orderId: string) => (await redis.command(['HGET', keys(productId).qty, orderId])) as string | null;
const unpaidOf = async (productId: string, accountId: string) => (await redis.command(['HGET', keys(productId).unpaid, accountId])) as string | null;
const orderRow = async (orderId: string) =>
  (await admin.pool.query('select status, stock_reserved_until from merch_order where id = $1', [orderId])).rows[0] as { status: string; stock_reserved_until: Date } | undefined;
const productStock = async (productId: string) => Number((await admin.pool.query('select stock from product_stock where product_id = $1', [productId])).rows[0].stock);
const attemptStatuses = async (orderId: string) => (await admin.pool.query('select status from merch_payment_attempt where order_id = $1 order by attempt_no', [orderId])).rows.map((r) => r.status as string);
const jobCount = async (orderId: string) => Number((await admin.pool.query('select count(*)::int as n from merch_confirm_job where order_id = $1', [orderId])).rows[0].n);

/** 잠금을 기다리는 연결이 n개가 될 때까지(경합을 끼워 넣을 때) */
async function waitForLockWaiters(n: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const r = await admin.pool.query(`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and state = 'active'`);
    if (Number(r.rows[0].n) >= n) return;
    if (Date.now() > deadline) throw new Error(`잠금 대기 ${n}개를 기다리다 시간이 다 됐다(지금 ${r.rows[0].n}개)`);
    await new Promise((res) => setTimeout(res, 20));
  }
}

/** 별도 연결로 주문 행을 잠가 둔다(풀면 기다리던 쪽이 차례로 잡는다) */
async function holdOrderRow(orderId: string): Promise<{ release: () => Promise<void> }> {
  const c = new pg.Client({ connectionString: pgc.url });
  await c.connect();
  await c.query('begin');
  await c.query('select id from merch_order where id = $1 for update', [orderId]);
  return {
    release: async () => {
      await c.query('commit');
      await c.end();
    },
  };
}

const T0 = Date.parse('2027-03-02T03:00:00.000Z');
const A = () => randomUUID();

describe('굿즈 재고 예약 만료(실제 PostgreSQL·Valkey)', () => {
  test('P-T42 ① 주문 뒤 15분 − 1ms에는 그대로이고 15분에 Expired와 카운터 복구, 같은 계정·다른 계정이 다시 산다', async () => {
    const clock = fakeClock({ now: T0 });
    const w = world(clock);
    const p = await limitedProduct(T0);
    const a = A();
    const b = A();
    const o = await order(w, a, p);
    expect(await counter(p.productId)).toBe('2');
    expect(await score(p.productId, o)).toBe(T0 + 900_000);
    expect(await resvQty(p.productId, o)).toBe('1');
    expect(await unpaidOf(p.productId, a)).toBe(o);
    expect((await orderRow(o))!.stock_reserved_until.getTime()).toBe(T0 + RESERVATION_MS);

    const expiry = new MerchStockExpiry({ store: w.store, stock, clock });
    clock.advance(RESERVATION_MS - 1);
    expect(await expiry.tick()).toEqual({ expired: 0, released: 0, deferred: 0, unavailable: 0 });
    expect((await orderRow(o))!.status).toBe('CREATED');
    expect(await counter(p.productId)).toBe('2');
    expect(await score(p.productId, o)).toBe(T0 + 900_000);

    clock.advance(1);
    expect(await expiry.tick()).toEqual({ expired: 1, released: 1, deferred: 0, unavailable: 0 });
    expect((await orderRow(o))!.status).toBe('EXPIRED');
    // 지우는 연산이 건드린 키 넷: 카운터는 돌아오고 예약 원소·수량·결제 전 칸은 지워진다
    expect(await counter(p.productId)).toBe('3');
    expect(await score(p.productId, o)).toBeNull();
    expect(await resvQty(p.productId, o)).toBeNull();
    expect(await unpaidOf(p.productId, a)).toBeNull();
    expect(await productStock(p.productId)).toBe(LIMITED);

    // 재고가 돌아와 같은 계정·다른 계정이 다시 살 수 있다
    const again = await order(w, a, p);
    const other = await order(w, b, p);
    expect(await counter(p.productId)).toBe('1');
    expect(await unpaidOf(p.productId, a)).toBe(again);
    expect(await unpaidOf(p.productId, b)).toBe(other);
    // 만료를 한 번 더 돌려도 이미 끝난 주문을 두 번 돌리지 않는다
    expect(await expiry.tick()).toEqual({ expired: 0, released: 0, deferred: 0, unavailable: 0 });
    expect(await counter(p.productId)).toBe('1');
  });

  test('P-T42 ② 주문 뒤 10분에 결제 접수하면 인증 + 10분까지 늘고 주문 + 15분이 지나도 만료하지 않는다', async () => {
    const clock = fakeClock({ now: T0 });
    const w = world(clock);
    const p = await limitedProduct(T0);
    const a = A();
    const o = await order(w, a, p);
    clock.advance(9 * 60_000);
    await startPayment(w, a, o);
    clock.advance(60_000);
    const authAt = clock.now();
    await accept(w, a, o);
    // 인증 + 10분(주문 + 20분)이 주문 + 15분보다 늦으므로 그 값
    expect((await orderRow(o))!.stock_reserved_until.getTime()).toBe(authAt + CONFIRM_WINDOW_MS);
    expect(await score(p.productId, o)).toBe(T0 + 1_200_000);
    // 접수한 주문은 '결제하지 않은 주문'이 아니다
    expect(await unpaidOf(p.productId, a)).toBeNull();
    expect(await productStock(p.productId)).toBe(2);
    expect(await counter(p.productId)).toBe('2');
    expect(w.payments.confirms).toHaveLength(1);

    const expiry = new MerchStockExpiry({ store: w.store, stock, clock });
    clock.advance(T0 + RESERVATION_MS - clock.now());
    expect(await expiry.tick()).toEqual({ expired: 0, released: 0, deferred: 0, unavailable: 0 });
    expect((await orderRow(o))!.status).toBe('CREATED');
    clock.advance(authAt + CONFIRM_WINDOW_MS - 1 - clock.now());
    expect((await expiry.tick()).expired).toBe(0);
    expect((await orderRow(o))!.status).toBe('CREATED');
    expect(await score(p.productId, o)).toBe(T0 + 1_200_000);
    // 승인 기한(인증 + 10분)에 닿으면 원소를 읽지만 접수한 주문이라 끝내지 않고 점수만 60초 미룬다
    clock.advance(1);
    expect(await expiry.tick()).toEqual({ expired: 0, released: 0, deferred: 1, unavailable: 0 });
    expect((await orderRow(o))!.status).toBe('CREATED');
    expect(await score(p.productId, o)).toBe(authAt + CONFIRM_WINDOW_MS + ACCEPTED_DEFER_MS);
    expect(await counter(p.productId)).toBe('2');
  });

  test('P-T42 ② 주문 뒤 2분에 결제 접수하면 주문 + 15분 그대로(늦은 쪽)이고, 접수한 주문은 기한이 지나도 만료하지 않고 점수를 60초 미룬다', async () => {
    const clock = fakeClock({ now: T0 });
    const w = world(clock);
    const p = await limitedProduct(T0);
    const a = A();
    const o = await order(w, a, p);
    clock.advance(60_000);
    await startPayment(w, a, o);
    clock.advance(60_000);
    await accept(w, a, o);
    expect((await orderRow(o))!.stock_reserved_until.getTime()).toBe(T0 + 900_000);
    expect(await score(p.productId, o)).toBe(T0 + 900_000);

    const expiry = new MerchStockExpiry({ store: w.store, stock, clock });
    clock.advance(T0 + RESERVATION_MS - clock.now());
    expect(await expiry.tick()).toEqual({ expired: 0, released: 0, deferred: 1, unavailable: 0 });
    expect((await orderRow(o))!.status).toBe('CREATED');
    expect(await attemptStatuses(o)).toEqual(['ACCEPTED']);
    expect(await score(p.productId, o)).toBe(T0 + 900_000 + ACCEPTED_DEFER_MS);
    expect(await counter(p.productId)).toBe('2');
    expect(await productStock(p.productId)).toBe(2);

    // 승인 기한(인증 + 10분)은 이미 지났다. 미룬 시각이 되어도 만료 작업은 접수한 주문을 바꾸지 않는다(결과는 당기기가 정한다)
    clock.advance(ACCEPTED_DEFER_MS - 1);
    expect(await expiry.tick()).toEqual({ expired: 0, released: 0, deferred: 0, unavailable: 0 });
    clock.advance(1);
    expect(await expiry.tick()).toEqual({ expired: 0, released: 0, deferred: 1, unavailable: 0 });
    expect((await orderRow(o))!.status).toBe('CREATED');
    expect(await score(p.productId, o)).toBe(clock.now() + ACCEPTED_DEFER_MS);
    expect(await counter(p.productId)).toBe('2');
  });

  test('P-T42 ③ 결제 접수는 예약 시각 − 1ms까지만 받고 예약 시각에는 409 order-expired이며 결제사를 부르지 않는다', async () => {
    const clock = fakeClock({ now: T0 });
    const w = world(clock);
    const p = await limitedProduct(T0);
    const a = A();
    const o = await order(w, a, p);
    clock.advance(60_000);
    await startPayment(w, a, o);
    clock.advance(T0 + RESERVATION_MS - clock.now());
    const err = await accept(w, a, o).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShopProblem);
    expect(err).toMatchObject({ type: 'order-expired', status: 409 });
    expect(w.payments.confirms).toHaveLength(0);
    expect(await productStock(p.productId)).toBe(LIMITED);
    expect(await jobCount(o)).toBe(0);
    expect(await attemptStatuses(o)).toEqual(['READY']);
  });

  test('P-T42 ③ 만료가 주문 행을 먼저 잡으면 만료가 이기고 접수는 409 order-expired, ConfirmPayment 0건, 재고는 돌아온다 [ASVS v5.0.0-2.3.4]', async () => {
    const clock = fakeClock({ now: T0 });
    const w = world(clock);
    const p = await limitedProduct(T0);
    const a = A();
    const o = await order(w, a, p);
    clock.advance(60_000);
    await startPayment(w, a, o);
    // 만료는 예약 시각에, 접수는 예약 시각 − 1ms에 읽은 시계로 돈다(접수 쪽 기한 검사만으로는 막히지 않는 때)
    const expiryClock = fakeClock({ now: T0 + RESERVATION_MS });
    const acceptClock = fakeClock({ now: T0 + RESERVATION_MS - 1 });
    const expiry = new MerchStockExpiry({ store: new DrizzleShopOrderStore(appDb, expiryClock), stock, clock: expiryClock });
    const acceptor = new MerchPayment({ store: new DrizzleShopOrderStore(appDb, acceptClock), stock, payments: w.payments, clock: acceptClock });

    const lock = await holdOrderRow(o);
    const expiring = expiry.tick();
    await waitForLockWaiters(1);
    const accepting = acceptor.accept(a, o, { pg: 'SIMULATOR', paymentKey: 'sim_pk_race1', amount: PRICE }, once(a, 'ACCEPT_MERCH_PAYMENT')).then(
      () => 'accepted',
      (e: unknown) => e,
    );
    await waitForLockWaiters(2);
    await lock.release();

    expect(await expiring).toEqual({ expired: 1, released: 1, deferred: 0, unavailable: 0 });
    const err = await accepting;
    expect(err).toBeInstanceOf(ShopProblem);
    expect(err).toMatchObject({ type: 'order-expired', status: 409 });
    expect(w.payments.confirms).toHaveLength(0);
    expect((await orderRow(o))!.status).toBe('EXPIRED');
    expect(await attemptStatuses(o)).toEqual(['EXPIRED']);
    expect(await jobCount(o)).toBe(0);
    expect(await productStock(p.productId)).toBe(LIMITED);
    expect(await counter(p.productId)).toBe('3');
    expect(await score(p.productId, o)).toBeNull();
  });

  test('P-T42 ③ 접수가 주문 행을 먼저 잡으면 접수가 이기고 만료 0건, 예약 기한이 지난 늦은 만료도 접수한 주문을 끝내지 않는다 [ASVS v5.0.0-2.3.4]', async () => {
    const clock = fakeClock({ now: T0 });
    const w = world(clock);
    const p = await limitedProduct(T0);
    const a = A();
    const o = await order(w, a, p);
    clock.advance(60_000);
    await startPayment(w, a, o);
    // 접수는 예약 시각 − 1ms(늘어난 기한 = 그때 + 10분 = 주문 + 25분 − 1ms), 만료는 주문 + 30분에 읽은 시계:
    // 만료 쪽 기한 조건은 참이 되므로 '결제 접수 전' 조건만이 만료를 막는다(겹친 가드 하나씩)
    const acceptClock = fakeClock({ now: T0 + RESERVATION_MS - 1 });
    const expiryClock = fakeClock({ now: T0 + 30 * 60_000 });
    const acceptor = new MerchPayment({ store: new DrizzleShopOrderStore(appDb, acceptClock), stock, payments: w.payments, clock: acceptClock });
    const expiry = new MerchStockExpiry({ store: new DrizzleShopOrderStore(appDb, expiryClock), stock, clock: expiryClock });

    const lock = await holdOrderRow(o);
    const accepting = acceptor.accept(a, o, { pg: 'SIMULATOR', paymentKey: 'sim_pk_race2', amount: PRICE }, once(a, 'ACCEPT_MERCH_PAYMENT'));
    await waitForLockWaiters(1);
    const expiring = expiry.tick();
    await waitForLockWaiters(2);
    await lock.release();

    await accepting;
    const t = await expiring;
    expect(t.expired).toBe(0);
    expect(t.released).toBe(0);
    expect(w.payments.confirms).toHaveLength(1);
    expect(w.payments.confirms[0]).toMatchObject({ orderId: o, amount: PRICE });
    const row = (await orderRow(o))!;
    expect(row.status).toBe('CREATED');
    expect(row.stock_reserved_until.getTime()).toBe(T0 + RESERVATION_MS - 1 + CONFIRM_WINDOW_MS);
    expect(await attemptStatuses(o)).toEqual(['ACCEPTED']);
    expect(await jobCount(o)).toBe(1);
    // 재고 확정: PostgreSQL에서 깎였고 카운터는 돌아오지 않았으며 예약 원소가 남아 있다
    expect(await productStock(p.productId)).toBe(2);
    expect(await counter(p.productId)).toBe('2');
    expect(await score(p.productId, o)).not.toBeNull();

    // 그 뒤의 만료 바퀴도 접수한 주문을 끝내지 않는다
    const later = new MerchStockExpiry({ store: new DrizzleShopOrderStore(appDb, expiryClock), stock, clock: expiryClock });
    expiryClock.advance(5 * 60_000);
    expect((await later.tick()).expired).toBe(0);
    expect((await orderRow(o))!.status).toBe('CREATED');
    expect(await counter(p.productId)).toBe('2');
  });

  test('P-T42 ⑤ 만료를 커밋한 뒤 RELEASE 전에 멈춘 바퀴를 새 바퀴가 이어 재고를 한 번만 돌린다(F-1)', async () => {
    const clock = fakeClock({ now: T0 });
    const w = world(clock);
    const p = await limitedProduct(T0);
    const a = A();
    const o = await order(w, a, p);
    clock.advance(RESERVATION_MS);

    const injected: { orderId: string; status: string | undefined; score: number | null; counter: string | null }[] = [];
    const crashing = new MerchStockExpiry({
      store: w.store,
      stock,
      clock,
      afterExpireCommit: async (orderId) => {
        // 끊는 자리가 커밋 뒤인지: DB는 이미 EXPIRED이고 Redis는 아직 그대로다
        injected.push({ orderId, status: (await orderRow(orderId))?.status, score: await score(p.productId, orderId), counter: await counter(p.productId) });
        throw new Error('주입: 만료 커밋 뒤 프로세스가 죽었다');
      },
    });
    await expect(crashing.tick()).rejects.toThrow('주입: 만료 커밋 뒤 프로세스가 죽었다');
    expect(injected).toEqual([{ orderId: o, status: 'EXPIRED', score: T0 + 900_000, counter: '2' }]);
    expect(await resvQty(p.productId, o)).toBe('1');
    expect(await counter(p.productId)).toBe('2');

    const restarted = new MerchStockExpiry({ store: w.store, stock, clock });
    expect(await restarted.tick()).toEqual({ expired: 0, released: 1, deferred: 0, unavailable: 0 });
    expect(await counter(p.productId)).toBe('3');
    expect(await score(p.productId, o)).toBeNull();
    expect(await resvQty(p.productId, o)).toBeNull();
    expect(await unpaidOf(p.productId, a)).toBeNull();
    // 두 번 돌리기 0
    clock.advance(1_000);
    expect(await restarted.tick()).toEqual({ expired: 0, released: 0, deferred: 0, unavailable: 0 });
    expect(await counter(p.productId)).toBe('3');
    expect(await productStock(p.productId)).toBe(LIMITED);
  });

  test('P-T42 ⑤ 결과 반영 FAILED를 커밋한 뒤 RELEASE 전에 끊기면 product_stock은 그 트랜잭션에서 이미 돌아오고 만료 작업이 카운터를 한 번만 돌린다(F-2) [ASVS v5.0.0-2.3.3]', async () => {
    const clock = fakeClock({ now: T0 });
    const w = world(clock);
    const p = await limitedProduct(T0);
    const a = A();
    const o = await order(w, a, p);
    clock.advance(60_000);
    await startPayment(w, a, o);
    await accept(w, a, o);
    expect(await productStock(p.productId)).toBe(2);
    expect(await counter(p.productId)).toBe('2');
    expect(await score(p.productId, o)).toBe(T0 + 900_000);

    w.payments.states.set(o, { orderId: o, paymentId: randomUUID(), pg: 'SIMULATOR', status: 'FAILED', approvedAtMs: undefined, failureCategory: 'DECLINED' });
    const injected: { orderId: string; kind: string; status: string | undefined; productStock: number; counter: string | null; score: number | null }[] = [];
    const results = new MerchPaymentResults({
      store: w.store,
      stock,
      payments: w.payments,
      clock,
      afterResultCommit: async (orderId, kind) => {
        injected.push({ orderId, kind, status: (await orderRow(orderId))?.status, productStock: await productStock(p.productId), counter: await counter(p.productId), score: await score(p.productId, orderId) });
        throw new Error('주입: 결과 커밋 뒤 프로세스가 죽었다');
      },
    });
    clock.advance(2_000);
    const t = await results.tick();
    expect(t).toMatchObject({ claimed: 1, paid: 0, failed: 1, pullFailed: false });
    expect(w.payments.batchCalls).toEqual([[o]]);
    // 주입 자리는 커밋 뒤다: 주문 FAILED와 product_stock 되돌림이 이미 한 트랜잭션으로 반영됐고, Redis는 아직 그대로다
    expect(injected).toEqual([{ orderId: o, kind: 'failed', status: 'FAILED', productStock: LIMITED, counter: '2', score: T0 + 900_000 }]);
    expect(await attemptStatuses(o)).toEqual(['FAILED']);
    expect(await jobCount(o)).toBe(0);

    const expiry = new MerchStockExpiry({ store: w.store, stock, clock });
    clock.advance(T0 + RESERVATION_MS - 1 - clock.now());
    expect(await expiry.tick()).toEqual({ expired: 0, released: 0, deferred: 0, unavailable: 0 });
    clock.advance(1);
    expect(await expiry.tick()).toEqual({ expired: 0, released: 1, deferred: 0, unavailable: 0 });
    expect(await counter(p.productId)).toBe('3');
    expect(await score(p.productId, o)).toBeNull();
    expect(await resvQty(p.productId, o)).toBeNull();
    expect(await productStock(p.productId)).toBe(LIMITED);
    clock.advance(1_000);
    expect(await expiry.tick()).toEqual({ expired: 0, released: 0, deferred: 0, unavailable: 0 });
    expect(await counter(p.productId)).toBe('3');
    expect(await productStock(p.productId)).toBe(LIMITED);
  });

  // ---- BAT-605: 굿즈 가상계좌 입금 기한 + 10분 만료(ADR-0314, P-T60 ④) ----

  test('P-T60 ④ 입금 기한 + 10분 − 1ms에는 만료하지 않고 정각에 EXPIRED·RELEASE(restore=1)·재고 복구이며, 다시 돌려도 한 번만 반영한다 [ASVS v5.0.0-2.3.3]', async () => {
    const clock = fakeClock({ now: T0 });
    const w = world(clock);
    const p = await limitedProduct(T0);
    const a = A();
    const o = await order(w, a, p);
    clock.advance(60_000);
    await startPayment(w, a, o);
    clock.advance(60_000);
    await accept(w, a, o);
    expect(await productStock(p.productId)).toBe(2);
    expect(await counter(p.productId)).toBe('2');
    // 입금 기한은 코드 상수(다음 날 23:59)와 다른 값으로 고른다
    const depositDueAt = clock.now() + 2 * 3_600_000 + 47 * 60_000;
    w.payments.states.set(o, { orderId: o, paymentId: randomUUID(), pg: 'SIMULATOR', status: 'AWAITING_DEPOSIT', approvedAtMs: undefined, failureCategory: undefined, depositDueAtMs: depositDueAt });
    const results = new MerchPaymentResults({ store: w.store, stock, payments: w.payments, clock });
    clock.advance(2_000);
    await results.tick();
    const deadline = depositDueAt + 10 * 60_000;
    expect((await orderRow(o))!.status).toBe('AWAITING_DEPOSIT');
    expect((await orderRow(o))!.stock_reserved_until.getTime()).toBe(deadline);
    expect(await score(p.productId, o)).toBe(deadline);

    const expiry = new MerchStockExpiry({ store: w.store, stock, clock });
    clock.advance(deadline - 1 - clock.now());
    expect(await expiry.tick()).toEqual({ expired: 0, released: 0, deferred: 0, unavailable: 0 });
    expect((await orderRow(o))!.status).toBe('AWAITING_DEPOSIT');
    expect(await productStock(p.productId)).toBe(2);
    expect(await counter(p.productId)).toBe('2');
    expect(await score(p.productId, o)).toBe(deadline);

    clock.advance(1);
    expect(await expiry.tick()).toEqual({ expired: 1, released: 1, deferred: 1, unavailable: 0 });
    expect((await orderRow(o))!.status).toBe('EXPIRED');
    expect(await productStock(p.productId)).toBe(LIMITED);
    expect(await counter(p.productId)).toBe('3');
    expect(await score(p.productId, o)).toBeNull();
    expect(await resvQty(p.productId, o)).toBeNull();
    expect(await unpaidOf(p.productId, a)).toBeNull();
    expect(await attemptStatuses(o)).toEqual(['EXPIRED']);
    expect(await jobCount(o)).toBe(0);
    // 한 번만 반영한다
    clock.advance(1_000);
    expect(await expiry.tick()).toEqual({ expired: 0, released: 0, deferred: 0, unavailable: 0 });
    expect(await counter(p.productId)).toBe('3');
    expect(await productStock(p.productId)).toBe(LIMITED);
  });

  test('P-T60 ④ 입금 완료 결과가 기한 정각에 늦게 와 만료와 겹쳐도 먼저 커밋한 PAID가 이기고 재고를 두 번 돌리지 않는다 [ASVS v5.0.0-2.3.3]', async () => {
    const clock = fakeClock({ now: T0 });
    const w = world(clock);
    const p = await limitedProduct(T0);
    const a = A();
    const o = await order(w, a, p);
    clock.advance(60_000);
    await startPayment(w, a, o);
    clock.advance(60_000);
    await accept(w, a, o);
    const depositDueAt = clock.now() + 3 * 3_600_000 + 11 * 60_000;
    w.payments.states.set(o, { orderId: o, paymentId: randomUUID(), pg: 'SIMULATOR', status: 'AWAITING_DEPOSIT', approvedAtMs: undefined, failureCategory: undefined, depositDueAtMs: depositDueAt });
    const results = new MerchPaymentResults({ store: w.store, stock, payments: w.payments, clock });
    clock.advance(2_000);
    await results.tick();
    const deadline = depositDueAt + 10 * 60_000;
    expect((await orderRow(o))!.status).toBe('AWAITING_DEPOSIT');
    expect(await productStock(p.productId)).toBe(2);
    expect(await counter(p.productId)).toBe('2');
    expect(await score(p.productId, o)).toBe(deadline);

    // 기한 정각에 입금 완료 결과가 늦게 도착한다(승인 시각은 기한 정각)
    clock.advance(deadline - clock.now());
    w.payments.states.set(o, { orderId: o, paymentId: randomUUID(), pg: 'SIMULATOR', status: 'APPROVED', approvedAtMs: clock.now(), failureCategory: undefined });
    await admin.pool.query('update merch_confirm_job set next_at = $1 where order_id = $2', [new Date(clock.now()), o]);
    const expiry = new MerchStockExpiry({ store: w.store, stock, clock });

    // 입금 확인이 주문 행을 먼저 기다리고, 그 뒤 만료가 기다린다(기다린 차례대로 잠금을 잡는다)
    const lock = await holdOrderRow(o);
    const paying = results.tick();
    await waitForLockWaiters(1);
    const expiring = expiry.tick();
    await waitForLockWaiters(2);
    await lock.release();

    const paidTick = await paying;
    const expiredTick = await expiring;
    expect(paidTick.paid).toBe(1);
    expect(expiredTick).toEqual({ expired: 0, released: 0, deferred: 1, unavailable: 0 });
    expect((await orderRow(o))!.status).toBe('PAID');
    // 만료가 덮어쓰지 않았고 재고도 두 번 돌지 않았다(접수 때 깎인 2 그대로, 카운터는 돌아오지 않음)
    expect(await productStock(p.productId)).toBe(2);
    expect(await counter(p.productId)).toBe('2');
    expect(await score(p.productId, o)).toBeNull();
    expect(await resvQty(p.productId, o)).toBeNull();
    expect(await attemptStatuses(o)).toEqual(['ACCEPTED']);
    expect(await jobCount(o)).toBe(0);
    // 뒤 바퀴도 아무것도 바꾸지 않는다
    clock.advance(1_000);
    expect(await expiry.tick()).toEqual({ expired: 0, released: 0, deferred: 0, unavailable: 0 });
    expect((await orderRow(o))!.status).toBe('PAID');
    expect(await productStock(p.productId)).toBe(2);
    expect(await counter(p.productId)).toBe('2');
  });

  test('RV-29 미수령 자동 취소가 아직 커밋되지 않은 구매자 취소와 겹쳐도 이중 환급 0건이다', async () => {
    const clock = fakeClock({ now: T0 });
    const w = world(clock);
    const p = await limitedProduct(T0);
    const a = A();
    const o = await order(w, a, p);
    // 미수령 대상이 되도록 주문을 PAID로 두고 시간대를 지난 날로 옮긴다(주문 만들기 검사를 피하려고 만든 뒤 고친다)
    await admin.pool.query('update merch_order set status = $2, payment_id = $3, paid_at = $4 where id = $1', [o, 'PAID', randomUUID(), new Date(T0)]);
    await admin.pool.query('update pickup_slot set starts_at = $2, ends_at = $3 where id = $1', [p.slotId, new Date(T0 - 2 * 86_400_000 - 3_600_000), new Date(T0 - 2 * 86_400_000)]);
    const itemId = (await admin.pool.query('select id from merch_order_item where order_id = $1', [o])).rows[0].id as string;
    // 구매자 취소 트랜잭션을 열어 주문 행을 잠그고 환급 행·자리를 커밋하지 않은 채 둔다
    const buyer = new pg.Client({ connectionString: pgc.url });
    await buyer.connect();
    await buyer.query('begin');
    await buyer.query('select id from merch_order where id = $1 for update', [o]);
    const buyerRefund = randomUUID();
    await buyer.query(
      `insert into merch_refund (id, order_id, item_ids, amount, reason, status, kind, attempts, next_at, alerted, created_at, updated_at)
       values ($1, $2, $3::uuid[], $4, 'USER_CANCEL', 'REQUESTED', 'USER_CANCEL', 0, $5, false, $6, $6)`,
      [buyerRefund, o, [itemId], PRICE, new Date(T0 + 60_000), new Date(T0)],
    );
    await buyer.query('insert into merch_refund_item (refund_id, item_id) values ($1, $2)', [buyerRefund, itemId]);
    const unclaimed = new MerchUnclaimed({ store: w.store, payments: w.payments, clock });
    const running = unclaimed.run();
    let committed = false;
    let result: Awaited<typeof running> | undefined;
    try {
      // 미수령 쪽이 구매자 주문 행 잠금(또는 외래키 확인)을 기다린다
      await waitForLockWaiters(1);
      await buyer.query('commit');
      committed = true;
      result = await running;
    } finally {
      if (!committed) await buyer.query('rollback').catch(() => {});
      await buyer.end();
      if (!committed) await running.catch(() => {});
    }
    // 구매자 취소가 먼저 자리를 잡았으므로 미수령 쪽은 0건이고, 환급 행은 구매자 것 하나뿐이다
    expect(result).toEqual({ cancelled: 0, refunds: 0 });
    expect(w.payments.cancels).toHaveLength(0);
    const refunds = (await admin.pool.query('select id, status from merch_refund where order_id = $1', [o])).rows;
    expect(refunds).toEqual([{ id: buyerRefund, status: 'REQUESTED' }]);
    expect((await admin.pool.query('select status from merch_order_item where id = $1', [itemId])).rows[0].status).toBe('READY');
  });
});
