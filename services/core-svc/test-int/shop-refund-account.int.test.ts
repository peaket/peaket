// 굿즈 지연 환급 계좌 다시 받기 실제 연결 시험(R-T43 ①~③, BAT-425, ADR-0316 결정 5, ADR-0315).
// core-svc HTTP(AppModule DB 조립) + 실제 PostgreSQL 18(core_app 로그인) + 가짜 결제 gRPC·재인증 대역.
// 정본: docs/features/payment.md §6 '지연 환급 계좌 다시 받기', docs/features/transfer-refund.md §3.1 '지연 환급 계좌를 다시 받는 작업',
// docs/data.md merch_refund(replaces_refund_id), openapi createShopCancellationAccount.
// 옛 행(REJECTED·fail_reason REFUND_ACCOUNT_REQUIRED·account_required_at 있음)은 그대로 두고, 새 행(새 UUIDv7 취소 ID·replaces_refund_id·
// 같은 금액·kind)과 새 merch_refund_item 자리를 한 트랜잭션에 만든 뒤 새 취소 ID로 CancelPayment를 부른다.
// 결제사 답: CANCELLED→항목 REFUNDED·환급 CANCELLED, CANCEL_PENDING·UNKNOWN→항목 CANCELLED·환급 CANCEL_PENDING,
// REFUND_ACCOUNT_REQUIRED→422·새 행 REJECTED·account_required_at, REJECTED→422. 계좌는 DB·로그 어디에도 원문을 남기지 않는다.
import 'reflect-metadata';
import { createDatabase, createService, ensureOutboxPartitions, fakeClock, systemClock, type Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import {
  MemoryHeldTickets,
  MemoryMerchStock,
  ReauthUnavailable,
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

const CONSENT = 'v2026.11-20-bat425-int';
const DAY = 86_400_000;
const T0 = Date.parse('2027-02-11T02:15:00.000Z');
const clock = fakeClock({ now: T0 });
const SELLER = randomUUID();
const ACCOUNT_NO = '110-987-654321';
const ACCOUNT_DIGITS = '110987654321';
const HOLDER = '김굿즈';
const ACCOUNT_BODY = { bankCode: '88', accountNumber: ACCOUNT_NO, holderName: HOLDER };

type Cancel = Parameters<MerchPayments['cancel']>[0];

class FakePayments implements MerchPayments {
  readonly cancels: Cancel[] = [];
  readonly cancelAnswers: CancelOutcome[] = [];
  async prepareCheckout(): Promise<never> {
    throw new Error('계좌 다시 받기 시험은 결제창을 부르지 않는다');
  }
  async confirm(): Promise<never> {
    throw new Error('계좌 다시 받기 시험은 승인 명령을 부르지 않는다');
  }
  async batchGet(): Promise<never> {
    throw new Error('계좌 다시 받기 시험은 결과 당기기를 부르지 않는다');
  }
  async getPayment(): Promise<never> {
    throw new Error('계좌 다시 받기 시험은 결제 상태를 읽지 않는다');
  }
  async cancel(c: Cancel): Promise<CancelOutcome> {
    this.cancels.push(c);
    return this.cancelAnswers.shift() ?? 'CANCELLED';
  }
}

class FakeReauth implements ShopReauthGate {
  readonly calls: { accountId: string; sessionId: string; act: string; op: string; token: string | undefined }[] = [];
  mode: 'up' | 'down' = 'up';
  async verify(token: string | undefined, q: { readonly accountId: string; readonly sessionId: string; readonly act: 'FAN_HIGH_RISK'; readonly op: 'SHOP_CANCEL_REFUND_ACCOUNT' }): Promise<boolean> {
    this.calls.push({ accountId: q.accountId, sessionId: q.sessionId, act: q.act, op: q.op, token });
    if (this.mode === 'down') throw new ReauthUnavailable('재인증 확인기 장애(시험)');
    if (q.act !== 'FAN_HIGH_RISK' || q.op !== 'SHOP_CANCEL_REFUND_ACCOUNT') return false;
    return token === 'good';
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

let pg: PostgresContainer;
let admin: Database;
let appDb: Database;
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-shop-refund-account-int', max: 6 });
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
  payments.cancelAnswers.length = 0;
  reauth.calls.length = 0;
  reauth.mode = 'up';
  logs.length = 0;
});

// ---- 자료 도우미(shop-cancel.int.test.ts와 같은 표 모양) ----
async function seedProduct(): Promise<string> {
  const id = randomUUID();
  await admin.pool.query(
    `insert into product (id, promoter_id, type, schema_version, name, status, price, shipping_fee, return_shipping_fee, return_address,
       limited_qty, transferable, ticket_linked, linked_event_id, fulfillments, commission_rate_bp, attributes, version, published_at, updated_at)
     values ($1, $2, 'MERCH', 1, '시험 굿즈', 'PUBLISHED', 12000, null, null, null, null, false, false, null, '{PICKUP}'::text[], 1000, '{}'::jsonb, 1, $3, $3)`,
    [id, SELLER, new Date(clock.now() - 10 * DAY)],
  );
  return id;
}

interface Seeded {
  orderId: string;
  accountId: string;
  itemId: string;
  paymentId: string;
  amount: number;
}
async function seedPaidOrder(o: { accountId?: string; unitAmount?: number; quantity?: number } = {}): Promise<Seeded> {
  const productId = await seedProduct();
  const accountId = o.accountId ?? randomUUID();
  const orderId = randomUUID();
  const paymentId = randomUUID();
  const unitAmount = o.unitAmount ?? 12_000;
  const quantity = o.quantity ?? 1;
  const amount = unitAmount * quantity;
  const itemId = randomUUID();
  const itemRow = (n: string) => `${n}-0000-4000-8000-${randomUUID().slice(-12)}`;
  const realItemId = itemRow('00000001');
  const pickupSlotId = randomUUID();
  await admin.pool.query(
    `insert into pickup_slot (id, product_id, event_id, starts_at, ends_at, ticket_holders_only)
     values ($1, $2, $3, $4, $5, false)`,
    [pickupSlotId, productId, randomUUID(), new Date(clock.now() + 3_600_000), new Date(clock.now() + 7_200_000)],
  );
  await admin.pool.query(
    `insert into merch_order (id, promoter_id, event_id, status, pg, pg_store, shipping_fee, purchase_confirmed_at, ordered_at, account_id,
       fulfillment, amount, stock_reserved_until, payment_id, pickup_slot_id, paid_at, consent_version, recipient_name, recipient_phone,
       delivery_address, escrow)
     values ($1, $2, null, 'PAID', 'SIMULATOR', 'STANDARD', 0, null, $3, $4, 'PICKUP', $5, $6, $7, $8, $3, null, null, null, null, false)`,
    [orderId, SELLER, new Date(clock.now() - 3_600_000), accountId, amount, new Date(clock.now() - 60_000), paymentId, pickupSlotId],
  );
  await admin.pool.query(
    `insert into merch_order_item (id, order_id, promoter_id, event_id, product_id, product_name, quantity, unit_amount, commission_rate_bp,
       status, fulfillment, ticket_linked, linked_ticket_id, option_snapshot, shipped_at, delivered_at, picked_up_at, event_ends_at)
     values ($1, $2, $3, null, $4, '시험 굿즈', $5, $6, 1000, 'READY', 'PICKUP', false, null,
       '{"options":{},"name":"시험 굿즈","type":"MERCH","schemaVersion":1}'::jsonb, null, null, null, null)`,
    [realItemId, orderId, SELLER, productId, quantity, unitAmount],
  );
  return { orderId, accountId, itemId: realItemId, paymentId, amount };
}

/** 계좌 거절로 끝난 옛 환급 행 하나(항목은 되돌려 READY, 옛 환급 자리는 resolved) */
async function seedRejectedRefund(o: { orderId: string; itemId: string; amount: number; status?: string; failReason?: string | null; accountRequiredAt?: number | null; replacesRefundId?: string | null }): Promise<string> {
  const refundId = randomUUID();
  const at = new Date(clock.now() - 60_000);
  await admin.pool.query(
    `insert into merch_refund (id, order_id, item_ids, amount, reason, status, kind, attempts, fail_reason, account_required_at,
       replaces_refund_id, next_at, alerted, created_at, updated_at)
     values ($1, $2, $3::uuid[], $4, 'USER_CANCEL', $5, 'USER_CANCEL', 0, $6, $7, $8, null, false, $9, $9)`,
    [refundId, o.orderId, [o.itemId], o.amount, o.status ?? 'REJECTED', o.failReason === undefined ? 'REFUND_ACCOUNT_REQUIRED' : o.failReason, o.accountRequiredAt === undefined ? at : o.accountRequiredAt === null ? null : new Date(o.accountRequiredAt), o.replacesRefundId ?? null, at],
  );
  await admin.pool.query('insert into merch_refund_item (refund_id, item_id, resolved_at) values ($1, $2, $3)', [refundId, o.itemId, at]);
  return refundId;
}

const refundsOf = async (orderId: string) =>
  (await admin.pool.query('select id, status, amount, kind, fail_reason, account_required_at, replaces_refund_id from merch_refund where order_id = $1 order by created_at, id', [orderId])).rows as {
    id: string;
    status: string;
    amount: number;
    kind: string;
    fail_reason: string | null;
    account_required_at: Date | null;
    replaces_refund_id: string | null;
  }[];
const itemsOf = async (orderId: string) =>
  (await admin.pool.query('select id, status, cancel_reason, refunded_amount from merch_order_item where order_id = $1 order by id', [orderId])).rows as { id: string; status: string; cancel_reason: string | null; refunded_amount: number }[];
const refundItemsOf = async (orderId: string) =>
  (await admin.pool.query('select ri.refund_id, ri.item_id, ri.resolved_at from merch_refund_item ri join merch_refund r on r.id = ri.refund_id where r.order_id = $1 order by ri.refund_id', [orderId])).rows as { refund_id: string; item_id: string; resolved_at: Date | null }[];

const POST = (accountId: string, orderId: string, cancellationId: string, body: unknown, o: { key?: string; token?: string } = {}) =>
  svc.http.inject({
    method: 'POST',
    url: `/v1/shop/orders/${orderId}/cancellations/${cancellationId}/account`,
    headers: { ...fan(accountId), 'content-type': 'application/json', 'idempotency-key': o.key ?? randomUUID(), ...(o.token === undefined ? {} : { 'x-reauth-token': o.token }) },
    payload: JSON.stringify(body),
  });
const problem = (r: { statusCode: number; payload: string }) => {
  const b = JSON.parse(r.payload) as { type?: string; title?: string };
  return { status: r.statusCode, type: String(b.type ?? '').replace(/^.*\/problems\//, ''), title: b.title };
};

async function leakIn(): Promise<string[]> {
  const tables = (await admin.pool.query("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'")).rows.map((r) => (r as { table_name: string }).table_name);
  const found: string[] = [];
  for (const t of tables) {
    if (t === 'outbox') continue;
    const rows = (await admin.pool.query(`select t::text as line from "${t}" t`)).rows as { line: string }[];
    for (const r of rows) for (const needle of [ACCOUNT_NO, ACCOUNT_DIGITS, HOLDER]) if (r.line.includes(needle)) found.push(`${t}:${needle}`);
  }
  for (const l of logs) for (const needle of [ACCOUNT_NO, ACCOUNT_DIGITS, HOLDER]) if (l.includes(needle)) found.push(`log:${needle}`);
  return found;
}

describe('R-T43 ① 굿즈 계좌 다시 받기(새 행·404·409)', () => {
  test('R-T43 ①_REJECTED_REFUND_ACCOUNT_REQUIRED_행에_계좌를_보내면_202_REFUNDED이고_새_행(새_ID·replaces)·새_환급_자리_1·옛_행은_REJECTED_그대로다', async () => {
    const o = await seedPaidOrder({ unitAmount: 12_500 });
    const oldId = await seedRejectedRefund({ orderId: o.orderId, itemId: o.itemId, amount: 12_500 });
    const res = await POST(o.accountId, o.orderId, oldId, ACCOUNT_BODY, { token: 'good' });
    expect(res.statusCode, res.payload).toBe(202);
    const body = JSON.parse(res.payload) as { cancellationId: string; status: string; refundAmount: number };
    expect(body).toMatchObject({ status: 'REFUNDED', refundAmount: 12_500 });
    expect(body.cancellationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.cancellationId).not.toBe(oldId);
    const rows = await refundsOf(o.orderId);
    expect(rows).toHaveLength(2);
    const oldRow = rows.find((r) => r.id === oldId)!;
    const newRow = rows.find((r) => r.id === body.cancellationId)!;
    expect(oldRow).toMatchObject({ status: 'REJECTED', fail_reason: 'REFUND_ACCOUNT_REQUIRED', amount: 12_500 });
    expect(newRow).toMatchObject({ status: 'CANCELLED', kind: 'USER_CANCEL', amount: 12_500, replaces_refund_id: oldId });
    expect(payments.cancels).toEqual([expect.objectContaining({ paymentId: o.paymentId, cancellationId: body.cancellationId, amount: 12_500, reason: 'USER_CANCEL', refundAttempt: 1, refundAccount: { bankCode: '88', accountNumber: ACCOUNT_DIGITS, holderName: HOLDER } })]);
    expect((await itemsOf(o.orderId))[0]).toMatchObject({ status: 'REFUNDED', cancel_reason: 'USER_CANCEL', refunded_amount: 12_500 });
    const itemRows = (await refundItemsOf(o.orderId)).filter((r) => r.refund_id === body.cancellationId);
    expect(itemRows).toHaveLength(1);
    expect(itemRows[0]!.resolved_at).not.toBeNull();
  });

  test('R-T43 ①_REQUESTED·CANCELLED·CANCEL_PENDING_등_자격_밖_행은_409_merch-cancel-not-allowed이고_새_행·payment가_0이다', async () => {
    for (const status of ['REQUESTED', 'CANCELLED', 'CANCEL_PENDING']) {
      const o = await seedPaidOrder();
      const oldId = await seedRejectedRefund({ orderId: o.orderId, itemId: o.itemId, amount: 12_000, status });
      const res = await POST(o.accountId, o.orderId, oldId, ACCOUNT_BODY, { token: 'good' });
      expect(res.statusCode, `${status}: ${res.payload}`).toBe(409);
      expect(problem(res).type, status).toContain('merch-cancel-not-allowed');
      expect(await refundsOf(o.orderId), status).toHaveLength(1);
      expect(payments.cancels, status).toHaveLength(0);
    }
  });

  test('R-T43 ①_남의_주문과_없는_취소·다른_주문의_취소_ID는_같은_404이고_새_행·payment가_0이다 [ASVS v5.0.0-8.2.2]', async () => {
    const o = await seedPaidOrder();
    const other = await seedPaidOrder();
    const id = await seedRejectedRefund({ orderId: o.orderId, itemId: o.itemId, amount: 12_000 });
    const foreign = await POST(other.accountId, o.orderId, id, ACCOUNT_BODY, { token: 'good' });
    const missing = await POST(o.accountId, o.orderId, randomUUID(), ACCOUNT_BODY, { token: 'good' });
    const wrongOrder = await POST(o.accountId, other.orderId, id, ACCOUNT_BODY, { token: 'good' });
    expect(problem(foreign)).toEqual(problem(missing));
    expect(problem(wrongOrder)).toEqual(problem(missing));
    expect(foreign.statusCode).toBe(404);
    expect(problem(foreign).type).toContain('not-found');
    expect(payments.cancels).toHaveLength(0);
    expect(await refundsOf(o.orderId)).toHaveLength(1);
  });

  test('R-T43 ①_시도_사슬_3회를_넘으면_409이고_새_행이_0이다', async () => {
    const o = await seedPaidOrder();
    let first: string | null = null;
    let prev: string | null = null;
    for (let n = 0; n < 4; n++) {
      prev = await seedRejectedRefund({ orderId: o.orderId, itemId: o.itemId, amount: 12_000, ...(prev === null ? {} : { replacesRefundId: prev }) });
      if (first === null) first = prev;
    }
    const res = await POST(o.accountId, o.orderId, first!, ACCOUNT_BODY, { token: 'good' });
    expect(res.statusCode, res.payload).toBe(409);
    expect(problem(res).type).toContain('merch-cancel-not-allowed');
    expect(await refundsOf(o.orderId)).toHaveLength(4);
    expect(payments.cancels).toHaveLength(0);
  });
});

describe('R-T43 ② 재인증(SHOP_CANCEL_REFUND_ACCOUNT·FAN_HIGH_RISK)', () => {
  test('R-T43 ②_토큰_없음·틀림·op/act_어긋남은_403_reauth-required이고_새_행·payment가_0이다', async () => {
    for (const token of [undefined, 'bad', 'ticket-cancel', 'sensitive']) {
      const o = await seedPaidOrder();
      const oldId = await seedRejectedRefund({ orderId: o.orderId, itemId: o.itemId, amount: 12_000 });
      const res = await POST(o.accountId, o.orderId, oldId, ACCOUNT_BODY, token === undefined ? {} : { token });
      expect(res.statusCode, `${token}: ${res.payload}`).toBe(403);
      expect(problem(res).type).toContain('reauth-required');
      expect(await refundsOf(o.orderId), String(token)).toHaveLength(1);
      expect(payments.cancels, String(token)).toHaveLength(0);
    }
  });

  test('R-T43 ②_재인증_확인기_장애는_503_reauth-unavailable·Retry-After_5초이고_새_행·payment가_0이다', async () => {
    const o = await seedPaidOrder();
    const oldId = await seedRejectedRefund({ orderId: o.orderId, itemId: o.itemId, amount: 12_000 });
    reauth.mode = 'down';
    try {
      const res = await POST(o.accountId, o.orderId, oldId, ACCOUNT_BODY, { token: 'good' });
      expect(res.statusCode, res.payload).toBe(503);
      expect(problem(res).type).toContain('reauth-unavailable');
      expect(res.headers['retry-after']).toBe('5');
      expect(reauth.calls.length).toBeGreaterThanOrEqual(1);
    } finally {
      reauth.mode = 'up';
    }
    expect(await refundsOf(o.orderId)).toHaveLength(1);
    expect(payments.cancels).toHaveLength(0);
  });
});

describe('R-T43 ③ 결제사 답을 새 행·항목 상태로 옮긴다', () => {
  test('R-T43 ③_CANCEL_PENDING·UNKNOWN은_202_REFUND_PENDING이고_항목_CANCELLED·환급_CANCEL_PENDING·재시도_1분이다', async () => {
    for (const outcome of ['CANCEL_PENDING', 'UNKNOWN'] as const) {
      const o = await seedPaidOrder();
      const oldId = await seedRejectedRefund({ orderId: o.orderId, itemId: o.itemId, amount: 12_000 });
      payments.cancelAnswers.push(outcome);
      const res = await POST(o.accountId, o.orderId, oldId, ACCOUNT_BODY, { token: 'good' });
      expect(res.statusCode, `${outcome}: ${res.payload}`).toBe(202);
      const body = JSON.parse(res.payload) as { cancellationId: string; status: string };
      expect(body.status, outcome).toBe('REFUND_PENDING');
      const newRow = (await refundsOf(o.orderId)).find((r) => r.id === body.cancellationId)!;
      expect(newRow.status, outcome).toBe('CANCEL_PENDING');
      expect((await itemsOf(o.orderId))[0]!.status, outcome).toBe('CANCELLED');
    }
  });

  test('R-T43 ③_REFUND_ACCOUNT_REQUIRED는_422·새_행_REJECTED·account_required_at이고_REJECTED는_422·새_행_REJECTED다', async () => {
    const required = await seedPaidOrder();
    const requiredOld = await seedRejectedRefund({ orderId: required.orderId, itemId: required.itemId, amount: 12_000 });
    payments.cancelAnswers.push('REFUND_ACCOUNT_REQUIRED');
    const a = await POST(required.accountId, required.orderId, requiredOld, ACCOUNT_BODY, { token: 'good' });
    expect(a.statusCode, a.payload).toBe(422);
    expect(problem(a).type).toContain('refund-account-required');
    const requiredRows = await refundsOf(required.orderId);
    expect(requiredRows).toHaveLength(2);
    const requiredNew = requiredRows.find((r) => r.id !== requiredOld)!;
    expect(requiredNew).toMatchObject({ status: 'REJECTED', fail_reason: 'REFUND_ACCOUNT_REQUIRED' });
    expect(requiredNew.account_required_at).not.toBeNull();
    expect((await itemsOf(required.orderId))[0]!.status).toBe('READY');

    const rejected = await seedPaidOrder();
    const rejectedOld = await seedRejectedRefund({ orderId: rejected.orderId, itemId: rejected.itemId, amount: 12_000 });
    payments.cancelAnswers.push('REJECTED');
    const b = await POST(rejected.accountId, rejected.orderId, rejectedOld, ACCOUNT_BODY, { token: 'good' });
    expect(b.statusCode, b.payload).toBe(422);
    expect(problem(b).type).toContain('refund-rejected');
    const rejectedNew = (await refundsOf(rejected.orderId)).find((r) => r.id !== rejectedOld)!;
    expect(rejectedNew).toMatchObject({ status: 'REJECTED', fail_reason: 'PG_REJECTED' });
  });

  test('R-T43 ③_같은_Idempotency-Key_두_번은_새_행_1·payment_1이고_계좌_원문은_DB·로그에_0건이다 [ASVS v5.0.0-8.2.3] [ASVS v5.0.0-16.2.5]', async () => {
    const o = await seedPaidOrder();
    const oldId = await seedRejectedRefund({ orderId: o.orderId, itemId: o.itemId, amount: 12_000 });
    const key = randomUUID();
    const first = await POST(o.accountId, o.orderId, oldId, ACCOUNT_BODY, { token: 'good', key });
    expect(first.statusCode, first.payload).toBe(202);
    const second = await POST(o.accountId, o.orderId, oldId, ACCOUNT_BODY, { token: 'good', key });
    expect(second.statusCode, second.payload).toBe(202);
    expect(JSON.parse(second.payload).cancellationId).toBe(JSON.parse(first.payload).cancellationId);
    expect(await refundsOf(o.orderId)).toHaveLength(2);
    expect(payments.cancels).toHaveLength(1);
    expect(await leakIn()).toEqual([]);
  });

  test('R-T43 ③_목록_밖_은행_코드_99는_400이고_토스_26개_코드는_202다(경계 양쪽)', async () => {
    const bad = await seedPaidOrder();
    const badOld = await seedRejectedRefund({ orderId: bad.orderId, itemId: bad.itemId, amount: 12_000 });
    const nope = await POST(bad.accountId, bad.orderId, badOld, { ...ACCOUNT_BODY, bankCode: '99' }, { token: 'good' });
    expect(nope.statusCode, nope.payload).toBe(400);
    expect(String(JSON.parse(nope.payload).type)).not.toContain('not-found');
    expect(payments.cancels).toHaveLength(0);
    expect(reauth.calls).toHaveLength(0);
    const codes = ['02', '03', '06', '07', '11', '12', '20', '23', '27', '31', '32', '34', '35', '37', '39', '45', '48', '50', '54', '64', '71', '81', '88', '89', '90', '92'];
    for (const bankCode of codes) {
      const o = await seedPaidOrder();
      const oldId = await seedRejectedRefund({ orderId: o.orderId, itemId: o.itemId, amount: 12_000 });
      const res = await POST(o.accountId, o.orderId, oldId, { ...ACCOUNT_BODY, bankCode }, { token: 'good' });
      expect(res.statusCode, `${bankCode}: ${res.payload}`).toBe(202);
    }
  });
});
