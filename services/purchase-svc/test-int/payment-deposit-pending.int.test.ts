// 입금 대기 반영의 판매 행 기한(docs/features/payment.md §6 '주문 쪽', docs/data.md seat_sale.pending_until, BUILD_ORDER HOT-151, P-T36)을 실제 PostgreSQL 18로 돈다.
// 약속: 주문은 운영 경로(DrizzleOrderStore·DrizzleOrderAccepts)로 만들고, RESERVED까지는 payment-results.int.test.ts와 같은 길이다. 시각은 시험마다 따로 만든 가짜 시계다.
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock, requestFingerprint, uuidv7 } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import { DrizzleOrderAccepts, DrizzleOrderStore, DrizzlePaymentResults, type NewOrder, type PaymentMarkInput } from '../src/modules/booking/index.js';
import { DrizzleSeatSales } from '../src/modules/inventory/index.js';
import { accountActor, BASE_MS, makeItems, newOrderInput, SAGA } from './order-fixtures.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let server: PostgresContainer;
let database: Database;

const ACTOR = 'system:payment-result';
const LIMIT = 4;
const DUE_MS = BASE_MS + 3 * 86_400_000;

beforeAll(async () => {
  server = await startPostgres();
  await migratePurchase(server.url);
  database = createDatabase({ url: server.url, profile: 'general', max: 8, applicationName: 'payment-deposit-pending-test' });
  await ensureOutboxPartitions(database, fakeClock({ now: BASE_MS }));
});

afterAll(async () => {
  await database?.close();
  server?.stop();
});

function fresh() {
  const clock = fakeClock({ now: BASE_MS });
  const store = new DrizzleOrderStore({ clock });
  const sales = new DrizzleSeatSales(database);
  return { clock, store, sales, accepts: new DrizzleOrderAccepts({ database, store, clock }), results: new DrizzlePaymentResults({ database, store, sales, clock }) };
}
type Fresh = ReturnType<typeof fresh>;

async function reserved(s: Fresh, seats = 2): Promise<NewOrder> {
  const o = newOrderInput(s.clock, { items: makeItems(seats) });
  await database.transaction((tx) => s.store.createOrder(tx, o));
  const attemptId = uuidv7(s.clock);
  await database.pool.query('insert into payment_attempt (id, order_id, pg, pg_order_ref, status, created_at) values ($1, $2, $3, $4, $5, $6)', [attemptId, o.id, 'TOSS', o.id, 'READY', new Date(s.clock.now())]);
  s.clock.advance(1_000);
  const once = { accountRef: o.accountId, operation: 'ACCEPT_PAYMENT' as const, key: randomUUID(), requestHash: requestFingerprint('POST', `/v1/orders/${o.id}/payment-acceptance`, Buffer.from('{}', 'utf8')) };
  expect(await s.accepts.accept(once, { orderId: o.id, attemptId, eventId: o.eventId, refs: { pg: 'TOSS', paymentKey: `tgen_${randomUUID().replaceAll('-', '')}` }, seatGen: 1, actor: accountActor(o.accountId) })).toEqual({ status: 'ACCEPTED' });
  const t7 = await database.transaction((tx) => s.store.transition(tx, { orderId: o.id, transition: 'T7', actor: SAGA }));
  expect(t7.status).toBe('APPLIED');
  expect(await s.sales.reserve({ eventId: o.eventId, orderId: o.id, accountId: o.accountId, seatIds: o.items.map((i) => i.seatId), limit: LIMIT })).toEqual({ status: 'RESERVED' });
  await database.pool.query(`update order_saga_job set step = 'CONFIRM', attempts = 0 where order_id = $1`, [o.id]);
  return o;
}

const salesOf = async (eventId: string) => (await database.pool.query<{ seat_id: string; status: string; pending_until: Date | null }>('select seat_id, status, pending_until from seat_sale where event_id = $1 order by seat_id', [eventId])).rows;
const statusOf = async (id: string) => (await database.pool.query<{ status: string }>('select status from purchase_order where id = $1', [id])).rows[0]!.status;
const markOf = (o: NewOrder, x: Partial<PaymentMarkInput>): PaymentMarkInput => ({ orderId: o.id, transition: 'T10', paymentEventSeq: 1, actor: ACTOR, ...x });
const pendingOf = (o: NewOrder, ms = DUE_MS + 600_000) => ({ eventId: o.eventId, seatIds: o.items.map((i) => i.seatId), pendingUntilMs: ms });

describe('입금 대기 전이의 판매 행 기한', () => {
  test('P-T36_T10이 그 주문의 PENDING 행마다 pending_until을 쓰고 상태는 PENDING 그대로다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const o = await reserved(s);
    expect(await s.results.mark(markOf(o, { depositPending: pendingOf(o) }))).toEqual({ status: 'APPLIED' });
    expect(await statusOf(o.id)).toBe('AWAITING_DEPOSIT');
    const rows = await salesOf(o.eventId);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ status: 'PENDING', pending_until: new Date(DUE_MS + 600_000) });
  });

  test('P-T36_기한을 모르면 지금처럼 비워 둔다', async () => {
    const s = fresh();
    const o = await reserved(s);
    expect(await s.results.mark(markOf(o, {}))).toEqual({ status: 'APPLIED' });
    for (const r of await salesOf(o.eventId)) expect(r.pending_until).toBeNull();
  });

  test('P-T36_T14도 같다', async () => {
    const s = fresh();
    const o = await reserved(s);
    expect(await s.results.mark(markOf(o, { transition: 'T12' }))).toEqual({ status: 'APPLIED' });
    expect(await s.results.mark(markOf(o, { transition: 'T14', paymentEventSeq: 2, depositPending: pendingOf(o) }))).toEqual({ status: 'APPLIED' });
    for (const r of await salesOf(o.eventId)) expect(r.pending_until).toEqual(new Date(DUE_MS + 600_000));
  });

  test('P-T36_다른 주문의 판매 행은 건드리지 않는다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const a = await reserved(s);
    const b = await reserved(s);
    expect(await s.results.mark(markOf(a, { depositPending: pendingOf(a) }))).toEqual({ status: 'APPLIED' });
    for (const r of await salesOf(b.eventId)) expect(r.pending_until).toBeNull();
  });

  test('P-T36_STALE이면 판매 행도 쓰지 않는다(한 트랜잭션) [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const o = await reserved(s);
    expect(await s.results.mark(markOf(o, { transition: 'T14', paymentEventSeq: 3, depositPending: pendingOf(o) }))).toMatchObject({ status: 'STALE', reason: 'STATUS' });
    for (const r of await salesOf(o.eventId)) expect(r.pending_until).toBeNull();
  });

  test('P-T36_T16 승인이 pending_until을 비운다(SOLD)', async () => {
    const s = fresh();
    const o = await reserved(s);
    await s.results.mark(markOf(o, { depositPending: pendingOf(o) }));
    expect(await s.results.approve({ orderId: o.id, transition: 'T16', paymentEventSeq: 2, actor: ACTOR, eventId: o.eventId, seatIds: o.items.map((i) => i.seatId), issueDueAtMs: BASE_MS + 1_800_000 })).toEqual({ status: 'APPLIED' });
    for (const r of await salesOf(o.eventId)) expect(r).toMatchObject({ status: 'SOLD', pending_until: null });
  });

  test('P-T36 ②_T17 실패는 판매 행을 지워 좌석을 놓는다', async () => {
    const s = fresh();
    const o = await reserved(s);
    await s.results.mark(markOf(o, { depositPending: pendingOf(o) }));
    expect(await s.results.fail({ orderId: o.id, transition: 'T17', paymentEventSeq: 2, actor: ACTOR, failureReason: 'EXPIRED', eventId: o.eventId, release: { eventId: o.eventId, orderId: o.id, accountId: o.accountId, seatIds: o.items.map((i) => i.seatId) } })).toEqual({ status: 'APPLIED' });
    expect(await salesOf(o.eventId)).toEqual([]);
    expect(await statusOf(o.id)).toBe('FAILED');
  });
});
