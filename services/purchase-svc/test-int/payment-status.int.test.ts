// 결제 결과 long polling의 purchase DB 읽기(adapters/db/drizzle-payment-status.ts DrizzlePaymentStatus, BUILD_ORDER PRF-166)를 실제 PostgreSQL 18로 본다.
// 정본: docs/features/payment.md §2 '결제 결과 long polling의 첫 구현'(기본 키로 한 질의, 한 번에 최대 500건 [가정], 쓰기 인스턴스),
// docs/data.md purchase_order(account_id·status·failure_reason)·payment_attempt(pg·status)·ticket_issue_job(created_at, 0007), domain/ports.ts PaymentStatusReads.
//
// 약속:
// - 주문은 저장소(DrizzleOrderStore.createOrder, T1)로 만들고, 상태·failure_reason은 준비 SQL로 바꾼다(그 트랜잭션에서만 상태 이력 지연 제약 트리거를 끈다,
//   accept-e2e.int.test.ts rawNoHistory와 같은 꼴). 결제 시도·발권 재시도 큐 행은 시험이 직접 넣는다.
// - 시계는 가짜다. 주문·계정 ID는 시험마다 새 UUID다.
//
// 정본 모호(뼈대 주석의 정한 것을 따른다):
// - pg는 ACCEPTED 결제 시도의 결제사다. READY·SUPERSEDED·EXPIRED 시도만 있으면 pg가 없다(undefined).
// - failure_reason이 null이면 failureReason 칸이 undefined, 큐 행이 없으면 issueJobCreatedAtMs·issueJobAttempts·issueJobLastError가 undefined다.
//   큐 행이 있으면 issueJobAttempts는 늘 있고, last_error가 null이면 issueJobLastError가 없다(리뷰 고침 M1).
// - 소문자 UUID가 아닌 ID는 DB에 가지 않는다(read는 undefined, readMany는 그 ID를 뺀다). readMany의 차례는 보지 않는다(정렬해 견준다).
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock, uuidv7 } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import { DrizzleOrderStore, DrizzlePaymentStatus, type OrderStatus, type PaymentStatusView } from '../src/modules/booking/index.js';
import { BASE_MS, newOrderInput } from './order-fixtures.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let pgServer: PostgresContainer | undefined;
let database: Database;
let admin: Database;
const clock = fakeClock({ now: BASE_MS });
let store: DrizzleOrderStore;
let reads: DrizzlePaymentStatus;

beforeAll(async () => {
  pgServer = await startPostgres();
  await migratePurchase(pgServer.url);
  database = createDatabase({ url: pgServer.url, profile: 'general', max: 6, applicationName: 'payment-status-int' });
  admin = createDatabase({ url: pgServer.url, profile: 'general', max: 2, applicationName: 'payment-status-int-admin' });
  await ensureOutboxPartitions(admin, clock);
  store = new DrizzleOrderStore({ clock });
  reads = new DrizzlePaymentStatus({ database });
});

afterAll(async () => {
  await Promise.allSettled([database?.close(), admin?.close()]);
  pgServer?.stop();
});

const q = async <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> => (await admin.pool.query(text, params)).rows as R[];

/** 이력 없이 주문 행을 바꾸는 준비 SQL(그 트랜잭션에서만 상태 이력 지연 제약 트리거를 끈다) */
async function rawNoHistory(text: string, params: unknown[] = []): Promise<void> {
  const c = await admin.pool.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(text, params);
    await c.query('commit');
  } catch (err) {
    await c.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

interface Made {
  id: string;
  accountId: string;
  eventId: string;
}
/** 주문 하나(T1) → 상태·failure_reason을 바꾸고 결제 시도·큐 행을 넣는다 */
async function order(
  x: {
    status?: OrderStatus;
    failureReason?: string;
    attempts?: { pg: 'TOSS' | 'PORTONE' | 'SIMULATOR'; status: 'READY' | 'ACCEPTED' | 'SUPERSEDED' | 'EXPIRED' }[];
    issueJobCreatedAtMs?: number;
    /** 큐 행의 발권 시도 수·마지막 오류(리뷰 고침 M1) */
    issueJobAttempts?: number;
    issueJobLastError?: string;
  } = {},
): Promise<Made> {
  const o = newOrderInput(clock);
  await database.transaction((tx) => store.createOrder(tx, o));
  if (x.status || x.failureReason !== undefined) {
    await rawNoHistory('update purchase_order set status = $2, failure_reason = $3 where id = $1', [o.id, x.status ?? 'CREATED', x.failureReason ?? null]);
  }
  for (const a of x.attempts ?? []) {
    await q('insert into payment_attempt (id, order_id, pg, pg_order_ref, status, created_at) values ($1, $2, $3, $4, $5, $6)', [uuidv7(clock), o.id, a.pg, o.id, a.status, new Date(clock.now())]);
  }
  if (x.issueJobCreatedAtMs !== undefined) {
    await q('insert into ticket_issue_job (order_id, event_id, attempts, issue_due_at, last_error, created_at) values ($1, $2, $3, $4, $5, $6)', [
      o.id,
      o.eventId,
      x.issueJobAttempts ?? 0,
      new Date(x.issueJobCreatedAtMs + 30 * 60_000),
      x.issueJobLastError ?? null,
      new Date(x.issueJobCreatedAtMs),
    ]);
  }
  return { id: o.id, accountId: o.accountId, eventId: o.eventId };
}

const byId = (vs: PaymentStatusView[]) => [...vs].sort((a, b) => (a.orderId < b.orderId ? -1 : 1));

describe('read(주문 하나)', () => {
  test('FR011_주문 행(ID·계정·상태·failure_reason) + ACCEPTED 결제 시도의 결제사 + 발권 재시도 큐 행 created_at(epoch ms)을 한 모습으로 읽는다', async () => {
    const approvedAt = BASE_MS + 12_345;
    const m = await order({ status: 'APPROVED', attempts: [{ pg: 'PORTONE', status: 'ACCEPTED' }], issueJobCreatedAtMs: approvedAt });
    expect(await reads.read(m.id)).toStrictEqual({ orderId: m.id, accountId: m.accountId, status: 'APPROVED', pg: 'PORTONE', issueJobCreatedAtMs: approvedAt, issueJobAttempts: 0 });
  });

  test('M1_큐 행의 발권 시도 수와 마지막 오류를 읽는다(오류가 null이면 칸이 없다)', async () => {
    const retrying = await order({ status: 'APPROVED', issueJobCreatedAtMs: BASE_MS, issueJobAttempts: 2, issueJobLastError: 'UNAVAILABLE' });
    expect(await reads.read(retrying.id)).toMatchObject({ issueJobCreatedAtMs: BASE_MS, issueJobAttempts: 2, issueJobLastError: 'UNAVAILABLE' });
    const first = await order({ status: 'APPROVED', issueJobCreatedAtMs: BASE_MS, issueJobAttempts: 1 });
    const v = await reads.read(first.id);
    expect(v).toMatchObject({ issueJobAttempts: 1 });
    expect(v && 'issueJobLastError' in v).toBe(false);
    const [many] = await reads.readMany([retrying.id]);
    expect(many).toStrictEqual(await reads.read(retrying.id));
  });

  test('FR011_FAILED의 failure_reason을 그대로 읽는다', async () => {
    const m = await order({ status: 'FAILED', failureReason: 'CARD_DECLINED', attempts: [{ pg: 'TOSS', status: 'ACCEPTED' }] });
    expect(await reads.read(m.id)).toStrictEqual({ orderId: m.id, accountId: m.accountId, status: 'FAILED', failureReason: 'CARD_DECLINED', pg: 'TOSS' });
  });

  test('FR011_비어 있는 칸은 싣지 않는다: 결제 시도 없음 → pg 없음, failure_reason null → 없음, 큐 행 없음 → 없음', async () => {
    const m = await order();
    const v = await reads.read(m.id);
    expect(v).toStrictEqual({ orderId: m.id, accountId: m.accountId, status: 'CREATED' });
    expect(v && ('pg' in v || 'failureReason' in v || 'issueJobCreatedAtMs' in v || 'issueJobAttempts' in v || 'issueJobLastError' in v)).toBe(false);
  });

  test('FR011_pg는 ACCEPTED 결제 시도의 결제사다(대체된 시도·READY 시도의 결제사가 아니다)', async () => {
    const m = await order({
      status: 'RESERVED',
      attempts: [
        { pg: 'PORTONE', status: 'SUPERSEDED' },
        { pg: 'SIMULATOR', status: 'ACCEPTED' },
      ],
    });
    expect((await reads.read(m.id))?.pg).toBe('SIMULATOR');
    const ready = await order({ status: 'AUTHENTICATED', attempts: [{ pg: 'TOSS', status: 'READY' }] });
    expect((await reads.read(ready.id))?.pg).toBeUndefined();
  });

  test.each(['CREATED', 'ACCEPTED', 'RESERVED', 'AWAITING_DEPOSIT', 'UNKNOWN', 'CONFIRMED', 'COMPENSATED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'EXPIRED'] as const)(
    'FR011_상태 %s를 그대로 읽는다',
    async (status) => {
      const m = await order({ status });
      expect((await reads.read(m.id))?.status).toBe(status);
    },
  );

  test('FR011_없는 주문은 undefined다', async () => {
    expect(await reads.read(randomUUID())).toBeUndefined();
  });

  test('FR011_소문자 UUID가 아니면 DB에 가지 않고 undefined다(대문자 UUID·UUID 아님·빈 글·SQL 조각)', async () => {
    const m = await order({ status: 'CONFIRMED' });
    for (const id of [m.id.toUpperCase(), 'not-a-uuid', '', "' or 1=1 --"]) {
      expect({ id, v: await reads.read(id) }).toEqual({ id, v: undefined });
    }
  });

  test('FR011_아무것도 쓰지 않는다(읽은 뒤 주문 행·이력·결제 시도·큐 행이 그대로다)', async () => {
    const m = await order({ status: 'APPROVED', attempts: [{ pg: 'TOSS', status: 'ACCEPTED' }], issueJobCreatedAtMs: BASE_MS });
    const snap = async () => ({
      order: await q('select * from purchase_order where id = $1', [m.id]),
      events: await q('select * from order_event where order_id = $1 order by seq', [m.id]),
      attempts: await q('select * from payment_attempt where order_id = $1', [m.id]),
      jobs: await q('select * from ticket_issue_job where order_id = $1', [m.id]),
    });
    const before = await snap();
    await reads.read(m.id);
    await reads.readMany([m.id]);
    expect(await snap()).toEqual(before);
  });
});

describe('readMany(여러 주문 한 질의)', () => {
  test('FR011_여러 주문을 한 번에 읽고 각 칸은 read와 같다(차례는 보지 않는다)', async () => {
    const ms = [
      await order({ status: 'ACCEPTED', attempts: [{ pg: 'TOSS', status: 'ACCEPTED' }] }),
      await order({ status: 'FAILED', failureReason: 'INSUFFICIENT_FUNDS', attempts: [{ pg: 'PORTONE', status: 'ACCEPTED' }] }),
      await order({ status: 'APPROVED', attempts: [{ pg: 'SIMULATOR', status: 'ACCEPTED' }], issueJobCreatedAtMs: BASE_MS - 61_000 }),
    ];
    const many = await reads.readMany(ms.map((m) => m.id));
    const one = await Promise.all(ms.map((m) => reads.read(m.id)));
    expect(byId(many)).toStrictEqual(byId(one as PaymentStatusView[]));
    expect(many).toHaveLength(3);
  });

  test('FR011_없는 주문·소문자 UUID가 아닌 ID는 결과에서 빠진다', async () => {
    const m = await order({ status: 'RESERVED' });
    const many = await reads.readMany([m.id, randomUUID(), 'not-a-uuid', m.id.toUpperCase()]);
    expect(many.map((v) => v.orderId)).toEqual([m.id]);
  });

  test('FR011_빈 배열·모두 UUID가 아닌 배열이면 DB에 가지 않고 []다', async () => {
    expect(await reads.readMany([])).toEqual([]);
    expect(await reads.readMany(['x', 'y'])).toEqual([]);
  });

  test('FR011_정확히 500건 [가정]은 한 질의로 읽는다', async () => {
    const m = await order({ status: 'CONFIRMED' });
    const ids = [m.id, ...Array.from({ length: 499 }, () => randomUUID())];
    const many = await reads.readMany(ids);
    expect(many.map((v) => v.orderId)).toEqual([m.id]);
  });

  test('FR011_501건이면 RangeError로 거절하고 DB에 가지 않는다(부르는 쪽이 나눠 부른다)', async () => {
    const ids = Array.from({ length: 501 }, () => randomUUID());
    await expect(reads.readMany(ids)).rejects.toBeInstanceOf(RangeError);
  });
});
