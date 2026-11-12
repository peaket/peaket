// BAT-035 진단용 임시 시험: 세 경로 트랜잭션의 문장 수·문장별 시간·itemsOf/reachedBeforeOf 중복을 본다.
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database, type DbTransaction, ensureOutboxPartitions, fakeClock, requestFingerprint, uuidv7 } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import {
  type AcceptInput,
  DrizzleOrderAccepts,
  DrizzleOrderStarts,
  DrizzleOrderStore,
  DrizzleOrderWrites,
  type NewOrder,
  type OrderRequestOnce,
  type PaymentRefs,
} from '../src/modules/booking/index.js';
import { accountActor, BASE_MS, makeItems, newOrderInput } from './order-fixtures.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let server: PostgresContainer;
let real: Database;
let admin: Database;
let timed: Database;
let log: { sql: string; ms: number }[] = [];

const sqlText = (q: unknown): string => {
  const chunks = (q as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((c) => {
      if (typeof c === 'string') return c;
      if (c === null || c === undefined) return '?';
      const v = (c as { value?: unknown }).value;
      if (Array.isArray(v)) return v.join('');
      if (typeof v === 'string') return v;
      return '?';
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
};

function timedDatabase(base: Database): Database {
  return {
    db: base.db,
    pool: base.pool,
    close: () => base.close(),
    transaction: (fn, opts) =>
      base.transaction(async (tx) => {
        const wrapped = {
          execute: async (q: Parameters<DbTransaction['execute']>[0]) => {
            const t0 = performance.now();
            const r = await tx.execute(q);
            log.push({ sql: sqlText(q), ms: performance.now() - t0 });
            return r;
          },
        } as DbTransaction;
        return fn(wrapped);
      }, opts),
  };
}

beforeAll(async () => {
  server = await startPostgres();
  await migratePurchase(server.url);
  real = createDatabase({ url: server.url, profile: 'general', max: 20, applicationName: 'bat035-probe' });
  admin = createDatabase({ url: server.url, profile: 'general', max: 4, applicationName: 'bat035-admin' });
  timed = timedDatabase(real);
  await ensureOutboxPartitions(admin, fakeClock({ now: BASE_MS }));
}, 120_000);

afterAll(async () => {
  await Promise.allSettled([real?.close(), admin?.close()]);
  server?.stop();
});

const q = async (text: string, params: unknown[] = []) => (await admin.pool.query(text, params)).rows;

function fresh() {
  const clock = fakeClock({ now: BASE_MS });
  const store = new DrizzleOrderStore({ clock });
  return { clock, store, writes: new DrizzleOrderWrites({ database: timed, store, clock }), starts: new DrizzleOrderStarts({ database: timed, store, clock }), accepts: new DrizzleOrderAccepts({ database: timed, store, clock }) };
}

async function placed(s: ReturnType<typeof fresh>, o: Partial<NewOrder> = {}): Promise<NewOrder> {
  const order = newOrderInput(s.clock, { items: makeItems(2), ...o });
  await real.transaction((tx) => s.store.createOrder(tx, order));
  return order;
}

const createOnce = (o: NewOrder, body: unknown): OrderRequestOnce => ({
  accountRef: o.accountId,
  operation: 'CREATE_ORDER',
  key: o.idempotencyKey,
  requestHash: requestFingerprint('POST', '/v1/orders', Buffer.from(JSON.stringify(body), 'utf8')),
});
const startOnce = (o: NewOrder): OrderRequestOnce => ({
  accountRef: o.accountId,
  operation: 'START_PAYMENT',
  key: randomUUID(),
  requestHash: requestFingerprint('POST', `/v1/orders/${o.id}/payments`, Buffer.from('{}', 'utf8')),
});
const acceptOnce = (o: NewOrder): OrderRequestOnce => ({
  accountRef: o.accountId,
  operation: 'ACCEPT_PAYMENT',
  key: randomUUID(),
  requestHash: requestFingerprint('POST', `/v1/orders/${o.id}/payment-acceptance`, Buffer.from('{}', 'utf8')),
});
const refs: PaymentRefs = { pg: 'TOSS', paymentKey: `tgen_${randomUUID().replaceAll('-', '').slice(0, 20)}` };

async function report(label: string, fn: () => Promise<unknown>) {
  log = [];
  const t0 = performance.now();
  await fn();
  const total = performance.now() - t0;
  const itemReads = log.filter((x) => /select .*from order_item/i.test(x.sql)).length;
  const eventReads = log.filter((x) => /select .*exists.*from order_event/i.test(x.sql)).length;
  const slow = [...log].sort((a, b) => b.ms - a.ms).slice(0, 6).map((x) => `${x.ms.toFixed(1)}ms ${x.sql.slice(0, 120)}`);
  console.log(`\n=== ${label}: statements=${log.length} total=${total.toFixed(1)}ms itemReads=${itemReads} reachedBeforeReads=${eventReads}`);
  for (const s of slow) console.log('  ' + s);
  return { log: [...log], total, itemReads, eventReads };
}

test('BAT035_세경로_트랜잭션_문장수와_순서를_줄인다', async () => {
  const s = fresh();
  const order = newOrderInput(s.clock, { items: makeItems(2) });
  const created = await report('create', () => s.writes.create(createOnce(order, { holdId: order.holdId }), order));
  expect(created.log.length).toBe(6);
  const createSql = created.log.map((x) => x.sql).join('\n');
  expect(createSql).toContain('insert into purchase_order');
  expect(createSql).toContain('insert into order_item');
  expect(createSql).toContain('insert into order_event');
  expect(created.log.filter((x) => /insert into outbox/i.test(x.sql)).length).toBe(1);

  const startOrder = await placed(s);
  const started = await report('start', () => s.starts.start(startOnce(startOrder), { orderId: startOrder.id, attemptId: uuidv7(s.clock), pg: 'TOSS', pgOrderRef: startOrder.id, actor: accountActor(startOrder.accountId) }));
  expect(started.log.length).toBe(8);
  const startSql = started.log.map((x) => x.sql);
  const supersede = startSql.findIndex((x) => /update payment_attempt set status = 'SUPERSEDED'/i.test(x));
  const insertAttempt = startSql.findIndex((x) => /insert into payment_attempt/i.test(x));
  expect(supersede).toBeGreaterThanOrEqual(0);
  expect(insertAttempt).toBeGreaterThan(supersede);
  expect(startSql[insertAttempt]).toContain('with counted as');

  const acceptOrder = await placed(s);
  const attemptId = uuidv7(s.clock);
  await q('insert into payment_attempt (id, order_id, pg, pg_order_ref, status, created_at) values ($1,$2,$3,$4,$5,$6)', [attemptId, acceptOrder.id, 'TOSS', acceptOrder.id, 'READY', new Date(s.clock.now())]);
  const input: AcceptInput = { orderId: acceptOrder.id, attemptId, eventId: acceptOrder.eventId, refs, seatGen: 7, actor: accountActor(acceptOrder.accountId) };
  const accepted = await report('accept', () => s.accepts.accept(acceptOnce(acceptOrder), input));
  expect(accepted.log.length).toBe(11);
  expect(accepted.itemReads).toBe(1);
  expect(accepted.eventReads).toBe(1);
  const acceptSql = accepted.log.map((x) => x.sql);
  expect(acceptSql.filter((x) => /update purchase_order set status =/i.test(x)).length).toBe(1);
  expect(acceptSql.filter((x) => /insert into order_event/i.test(x)).length).toBe(1);
  const saga = acceptSql.findIndex((x) => /insert into order_saga_job/i.test(x));
  const outbox = acceptSql.findIndex((x) => /insert into outbox/i.test(x));
  expect(outbox).toBeGreaterThan(saga);
  expect(acceptSql.slice(outbox + 1).every((x) => /update order_idempotency/i.test(x))).toBe(true);
}, 120_000);
