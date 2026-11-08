// 주문 Saga 1단계의 purchase DB 쪽(booking DrizzleSaga: SagaJobs·SagaOrders·ReserveTx·SagaFailures·ConfirmSent)을 실제 PostgreSQL 18로 돈다(BUILD_ORDER PRF-165).
// 정본: docs/features/payment.md §2 'Saga 1단계의 첫 구현'(실행기·단계 RESERVE ③·단계 CONFIRM·실패 사유)·'결제 접수의 첫 구현'(결제 참조의 자리)·
// §3 '주문 저장소의 첫 구현'(T11은 결제 사건 순번 없이도 받는다), docs/data.md purchase_order.failure_reason·§4 일곱 번째 마이그레이션(0006)·
// §5 'Saga 1단계' 줄(두 파드가 같은 작업 행을 집음, 판매 예약과 다시 만들기가 겹침)·'결제 접수 reserve' 줄, docs/features/seat-hold.md §6 '다시 만들기의 첫 구현'
// (seat_rebuild 행을 FOR SHARE로 대조), 시험 표 S-T8, booking domain/ports.ts SagaJobs·SagaOrders·ReserveTx·SagaFailures·ConfirmSent와 adapters/db/drizzle-saga.ts 머리 주석.
//
// 약속:
// - 마이그레이션은 scripts/migrate.mjs의 migratePurchase, Outbox 일 파티션은 ensureOutboxPartitions(기준 시각의 가짜 시계)로 만든다(order-accepts.int.test.ts와 같다).
// - 접수된 주문은 운영 경로로 만든다: DrizzleOrderStore.createOrder → 결제 시도 READY 행 직접 넣기 → DrizzleOrderAccepts.accept(PRF-162, 작업 행 RESERVE).
//   판매 예약 뒤 상태(T11·done 시험의 준비)는 ReserveTx를 거치지 않고 만든다: 주문 전이 T7 + DrizzleSeatSales.reserve + 작업 행 step 'CONFIRM'(SQL).
// - 시각은 시험마다 따로 만든 가짜 시계다. 임대·기한의 '지금'은 앱 시계(DrizzleSagaOptions.clock)다(접수가 next_attempt_at = 접수 시각(앱 시계)으로 넣는 것과 같은 쪽).
// - 쓰기 차례는 시험 DB에만 둔 감사 트리거(saga_audit, 운영 표에는 없다)로 본다: 어댑터가 문장을 어떻게 보내든(tx.execute·질의 만들기) 행 쓰기가 일어난 차례를
//   트랜잭션 번호(txid_current)와 함께 적는다. 겹침 시험은 seat_sale 삽입마다 쉬는 시험용 트리거(saga_slow_insert, 고른 회차만)로 트랜잭션을 늘린다.
// - DB 상태는 admin 풀의 직접 SQL로 읽는다. 기대 값(전이 표·사건 모양)은 order-fixtures.ts에 정본에서 따로 적은 것을 쓴다.
//
// 정본 모호(ports.ts·drizzle-saga.ts의 정한 것을 따른다):
// - GEN_CHANGED는 '되돌린 뒤 주문 seat_gen을 새 번호로 고쳐 커밋'이다(payment §2 단계 RESERVE ③). 그래서 판매 행·한도·작업·이력·Outbox는 그대로이고 seat_gen만 바뀐다.
// - SEAT_TAKEN·QUOTA_EXCEEDED·ORDER_STATE는 seat_rebuild 행 넣기까지 같은 트랜잭션째 되돌린다(행이 없던 회차는 행이 남지 않는다).
// - T8·T11의 결제 시도 상태(status)는 정본에 없어 보지 않는다(결제 참조 칸 셋만 비운다).
// - claimDue의 차례는 next_attempt_at 오름차순이고 같은 시각이면 보지 않는다. 집기는 attempts를 바꾸지 않는다(reschedule만 1 올린다).
// - ReserveTx 입력의 판매 행 pending_until은 정본에 없어 보지 않는다.
import { randomUUID } from 'node:crypto';
import { OrderEvent } from '@peaket/contracts/asyncapi';
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock, requestFingerprint, uuidv7 } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import {
  type AcceptInput,
  DrizzleOrderAccepts,
  DrizzleOrderStore,
  DrizzleSaga,
  type NewOrder,
  type OrderRequestOnce,
  type PaymentRefs,
  type ReserveTxInput,
  type ReserveTxOutcome,
  type SagaFailInput,
  type TransitionId,
} from '../src/modules/booking/index.js';
import { DrizzleSeatRebuildSource, DrizzleSeatSales } from '../src/modules/inventory/index.js';
import { accountActor, BASE_MS, CREATED_ONLY, laterEvent, makeItems, messagesOf, newOrderInput, rejections, SAGA } from './order-fixtures.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let server: PostgresContainer;
/** 어댑터가 쓰는 풀 */
let database: Database;
/** 읽기·준비용 풀 */
let admin: Database;
/** 다시 만들기 임대·두 번째 집기 쪽 풀(잠금을 기다리는 연결을 가려 본다) */
let race: Database;

const APP = 'saga-db-test';
const RACE = 'saga-db-race';
const LIMIT = 4;
const LEASE = 30_000;

beforeAll(async () => {
  server = await startPostgres();
  await migratePurchase(server.url);
  database = createDatabase({ url: server.url, profile: 'general', max: 20, applicationName: APP });
  admin = createDatabase({ url: server.url, profile: 'general', max: 4, applicationName: 'saga-db-admin' });
  race = createDatabase({ url: server.url, profile: 'general', max: 4, applicationName: RACE });
  await ensureOutboxPartitions(admin, fakeClock({ now: BASE_MS }));
  // 시험용 감사 트리거와 느린 삽입 트리거(운영 표에는 없다)
  await admin.pool.query(`
    create table saga_audit (n bigserial primary key, xid bigint not null default txid_current(), tbl text not null, op text not null, row_text text);
    create or replace function saga_audit() returns trigger language plpgsql as $$
    begin
      insert into saga_audit (tbl, op, row_text)
      values (tg_table_name, tg_op, case when tg_op = 'DELETE' then row_to_json(old)::text else row_to_json(new)::text end);
      return null;
    end $$;
    create table saga_slow_insert (event_id uuid primary key, ms int not null);
    create or replace function saga_slow_insert() returns trigger language plpgsql as $$
    declare d int;
    begin
      select ms into d from saga_slow_insert where event_id = new.event_id;
      if d is not null then perform pg_sleep(d / 1000.0); end if;
      return new;
    end $$;
    create trigger saga_slow_insert before insert on seat_sale for each row execute function saga_slow_insert();`);
  for (const t of ['seat_rebuild', 'purchase_quota', 'seat_sale', 'order_saga_job', 'purchase_order', 'order_event', 'payment_attempt', 'outbox']) {
    await admin.pool.query(`create trigger saga_audit after insert or update or delete on ${t} for each row execute function saga_audit()`);
  }
});

afterAll(async () => {
  await Promise.allSettled([database?.close(), admin?.close(), race?.close()]);
  server?.stop();
});

// ───────────────────────────── 도우미 ─────────────────────────────

const q = async <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> => (await admin.pool.query(text, params)).rows as R[];
const count = async (text: string, params: unknown[] = []): Promise<number> => Number((await q<{ n: string | number }>(text, params))[0]!.n);

/** 시험 하나의 가짜 시계·주문 전이 함수·접수 어댑터·Saga 어댑터 */
function fresh(startMs = BASE_MS) {
  const clock = fakeClock({ now: startMs });
  const store = new DrizzleOrderStore({ clock });
  const sales = new DrizzleSeatSales(database);
  return { clock, store, sales, accepts: new DrizzleOrderAccepts({ database, store, clock }), saga: new DrizzleSaga({ database, store, sales, clock }) };
}
type Fresh = ReturnType<typeof fresh>;

/** 주문 하나(T1, 지금 시각, 좌석 2) */
async function placed(s: Fresh, o: Partial<NewOrder> = {}): Promise<NewOrder> {
  const order = newOrderInput(s.clock, { items: makeItems(2), ...o });
  await database.transaction((tx) => s.store.createOrder(tx, order));
  return order;
}
async function walk(s: Fresh, o: NewOrder, path: readonly TransitionId[]): Promise<void> {
  for (const transition of path) {
    const r = await database.transaction((tx) => s.store.transition(tx, { orderId: o.id, transition, actor: SAGA }));
    expect(r.status, transition).toBe('APPLIED');
  }
}

type Pg = 'TOSS' | 'PORTONE' | 'SIMULATOR';
async function putAttempt(s: Fresh, o: NewOrder, pg: Pg = 'TOSS'): Promise<string> {
  const id = uuidv7(s.clock);
  await q('insert into payment_attempt (id, order_id, pg, pg_order_ref, status, created_at) values ($1, $2, $3, $4, $5, $6)', [
    id,
    o.id,
    pg,
    pg === 'PORTONE' ? `pay-${o.id}` : o.id,
    'READY',
    new Date(s.clock.now()),
  ]);
  return id;
}
const onceOf = (o: NewOrder): OrderRequestOnce => ({
  accountRef: o.accountId,
  operation: 'ACCEPT_PAYMENT',
  key: randomUUID(),
  requestHash: requestFingerprint('POST', `/v1/orders/${o.id}/payment-acceptance`, Buffer.from(JSON.stringify({ n: randomUUID() }), 'utf8')),
});
const tossRefs = (): PaymentRefs => ({ pg: 'TOSS', paymentKey: `tgen_${randomUUID().replaceAll('-', '')}` });
const portoneRefs = (): PaymentRefs => ({ pg: 'PORTONE', txId: `tx-${randomUUID()}`, paymentToken: `ptok_${randomUUID().replaceAll('-', '')}` });

interface Accepted {
  o: NewOrder;
  attemptId: string;
  refs: PaymentRefs;
  /** 접수(인증) 시각 */
  at: number;
}
/** 접수된 주문(ACCEPTED, 시도 ACCEPTED·결제 참조, seat_gen, 작업 RESERVE). 운영 접수 어댑터(PRF-162)로 만든다 */
async function accepted(s: Fresh, x: { seatGen?: number; refs?: PaymentRefs; order?: Partial<NewOrder> } = {}): Promise<Accepted> {
  const o = await placed(s, x.order);
  const refs = x.refs ?? tossRefs();
  const attemptId = await putAttempt(s, o, refs.pg);
  s.clock.advance(1_000);
  const at = s.clock.now();
  const input: AcceptInput = { orderId: o.id, attemptId, eventId: o.eventId, refs, seatGen: x.seatGen ?? 1, actor: accountActor(o.accountId) };
  expect(await s.accepts.accept(onceOf(o), input)).toEqual({ status: 'ACCEPTED' });
  return { o, attemptId, refs, at };
}
/** 판매 예약 뒤 상태(RESERVED, 판매 행 PENDING·한도, 작업 CONFIRM). ReserveTx를 거치지 않는다(T11·done 시험이 reserve 구현에 기대지 않게) */
async function reservedByHand(s: Fresh, a: Accepted): Promise<void> {
  await walk(s, a.o, ['T7']);
  const r = await s.sales.reserve({ eventId: a.o.eventId, orderId: a.o.id, accountId: a.o.accountId, seatIds: a.o.items.map((it) => it.seatId), limit: LIMIT });
  expect(r).toEqual({ status: 'RESERVED' });
  await q(`update order_saga_job set step = 'CONFIRM', attempts = 0 where order_id = $1`, [a.o.id]);
}

const reserveInputOf = (a: Accepted, orderGen = 1, o: Partial<ReserveTxInput> = {}): ReserveTxInput => ({
  orderId: a.o.id,
  eventId: a.o.eventId,
  accountId: a.o.accountId,
  seatIds: a.o.items.map((it) => it.seatId),
  limit: LIMIT,
  orderGen,
  actor: SAGA,
  ...o,
});

const orderRow = async (id: string) =>
  (
    await q<{ status: string; event_seq: number; seat_gen: number | null; failure_reason: string | null; payment_event_seq: string }>(
      'select status, event_seq, seat_gen, failure_reason, payment_event_seq::text as payment_event_seq from purchase_order where id = $1',
      [id],
    )
  )[0];
const attemptRefs = async (id: string) =>
  (await q<{ pg_payment_key: string | null; pg_tx_id: string | null; pg_payment_token: string | null }>('select pg_payment_key, pg_tx_id, pg_payment_token from payment_attempt where id = $1', [id]))[0];
const historyOf = (id: string) =>
  q<{ seq: number; from_status: string | null; to_status: string; cause: string; actor: string; occurred_at: Date }>(
    'select seq, from_status, to_status, cause, actor, occurred_at from order_event where order_id = $1 order by seq',
    [id],
  );
async function outboxOf(eventId: string): Promise<{ raw: string; event: Record<string, unknown> }[]> {
  const rows = await q<{ payload: Buffer }>('select payload from outbox where msg_key = $1 order by outbox.seq', [eventId]);
  return rows.map((r) => {
    const raw = Buffer.from(r.payload).toString('utf8');
    return { raw, event: JSON.parse(raw) as Record<string, unknown> };
  });
}
const jobOf = async (orderId: string) =>
  (
    await q<{ event_id: string; step: string; attempts: number; next_attempt_at: Date; lease_until: Date | null }>(
      'select event_id, step, attempts, next_attempt_at, lease_until from order_saga_job where order_id = $1',
      [orderId],
    )
  )[0];
const salesOf = (eventId: string) =>
  q<{ seat_id: string; order_id: string; account_id: string; status: string }>(
    'select seat_id, order_id, account_id, status from seat_sale where event_id = $1 order by seat_id',
    [eventId],
  );
const quotaOf = async (accountId: string, eventId: string) =>
  (await q<{ used: number; limit_count: number }>('select used, limit_count from purchase_quota where account_id = $1 and event_id = $2', [accountId, eventId]))[0];
const rebuildOf = async (eventId: string) =>
  (await q<{ gen: number; holder: string | null; lease_until: Date | null }>('select gen, holder, lease_until from seat_rebuild where event_id = $1', [eventId]))[0];

/** 아무것도 남지 않았는지 볼 때의 주문 흔적 */
const traceOf = async (a: Accepted) => ({
  order: await orderRow(a.o.id),
  history: (await historyOf(a.o.id)).length,
  outbox: (await outboxOf(a.o.eventId)).map((x) => x.event.type),
  job: await jobOf(a.o.id),
  sales: await salesOf(a.o.eventId),
  quota: await quotaOf(a.o.accountId, a.o.eventId),
  rebuild: await rebuildOf(a.o.eventId),
  refs: await attemptRefs(a.attemptId),
});

/**
 * 그 주문의 한 전이(cause)를 쓴 트랜잭션의 행 쓰기 차례(감사 트리거). 이어진 같은 쓰기(여러 행 한 문장)는 하나로 접고, Outbox 파티션 이름은 outbox로 본다
 */
async function writesOfTx(orderId: string, cause: string): Promise<string[]> {
  const rows = await q<{ tbl: string; op: string }>(
    `select tbl, op from saga_audit
      where xid = (select xid from saga_audit where tbl = 'order_event' and op = 'INSERT' and row_text like $1 and row_text like $2 order by n desc limit 1)
      order by n`,
    [`%"order_id":"${orderId}"%`, `%"cause":"${cause}"%`],
  );
  const out: string[] = [];
  for (const r of rows) {
    const w = `${r.op} ${r.tbl.startsWith('outbox') ? 'outbox' : r.tbl}`;
    if (out.at(-1) !== w) out.push(w);
  }
  return out;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}
const lockWaiters = (app: string) => count(`select count(*) as n from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'`, [app]);
const sleepers = (app: string) => count(`select count(*) as n from pg_stat_activity where application_name = $1 and wait_event = 'PgSleep'`, [app]);

const contractIssues = (event: unknown) => OrderEvent.safeParse(event).error?.issues ?? [];

/** 작업 행을 직접 넣는다(claimDue 시험: 주문은 T1만 있으면 된다) */
async function putJob(s: Fresh, x: { nextAtMs: number; leaseUntilMs?: number | null; step?: string; attempts?: number }): Promise<NewOrder> {
  const o = await placed(s);
  await q('insert into order_saga_job (order_id, event_id, step, attempts, next_attempt_at, lease_until, created_at) values ($1, $2, $3, $4, $5, $6, $7)', [
    o.id,
    o.eventId,
    x.step ?? 'RESERVE',
    x.attempts ?? 0,
    new Date(x.nextAtMs),
    x.leaseUntilMs === undefined || x.leaseUntilMs === null ? null : new Date(x.leaseUntilMs),
    new Date(s.clock.now()),
  ]);
  return o;
}

// ───────────────────────────── SagaJobs ─────────────────────────────

describe('DrizzleSaga SagaJobs.claimDue(짧은 트랜잭션: 기한·임대 조건, FOR UPDATE SKIP LOCKED, 임대 쓰고 커밋)', () => {
  // claimDue는 회차·주문을 가리지 않고 기한이 된 행을 모두 줍는다: 시험마다 작업 표를 비운다(이 describe 안에서만, 시험은 차례로 돈다)
  beforeEach(async () => {
    await q('delete from order_saga_job');
  });

  test('기한이 됐고(next_attempt_at ≤ 지금) 임대가 비었거나 지난 행만 next_attempt_at 차례로 집고, lease_until = 지금 + leaseMs를 쓰며 attempts는 그대로다 [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const now = s.clock.now();
    const late = await putJob(s, { nextAtMs: now - 5_000, attempts: 2 });
    const exact = await putJob(s, { nextAtMs: now });
    const leaseGone = await putJob(s, { nextAtMs: now - 9_000, leaseUntilMs: now - 1, step: 'CONFIRM' });
    const future = await putJob(s, { nextAtMs: now + 1 });
    const leased = await putJob(s, { nextAtMs: now - 20_000, leaseUntilMs: now + 10_000 });

    const got = await s.saga.claimDue(10, LEASE);

    expect(got).toEqual([
      { orderId: leaseGone.id, eventId: leaseGone.eventId, step: 'CONFIRM', attempts: 0, nextAttemptAtMs: now - 9_000, leaseUntilMs: now + LEASE },
      { orderId: late.id, eventId: late.eventId, step: 'RESERVE', attempts: 2, nextAttemptAtMs: now - 5_000, leaseUntilMs: now + LEASE },
      { orderId: exact.id, eventId: exact.eventId, step: 'RESERVE', attempts: 0, nextAttemptAtMs: now, leaseUntilMs: now + LEASE },
    ]);
    // 임대는 커밋됐다(다른 연결에서 보인다)
    for (const o of [late, exact, leaseGone]) expect((await jobOf(o.id))?.lease_until).toEqual(new Date(now + LEASE));
    expect((await jobOf(future.id))?.lease_until).toBeNull();
    expect((await jobOf(leased.id))?.lease_until).toEqual(new Date(now + 10_000));
    // 임대 중이라 다시 부르면 아무것도 없다. 임대가 지나면 다시 집는다
    expect(await s.saga.claimDue(10, LEASE)).toEqual([]);
    s.clock.advance(LEASE + 1);
    expect((await s.saga.claimDue(10, LEASE)).map((j) => j.orderId).sort()).toEqual([late.id, exact.id, leaseGone.id, future.id, leased.id].sort());
  });

  test('limit개까지만 집는다(next_attempt_at이 이른 것부터)', async () => {
    const s = fresh();
    const now = s.clock.now();
    const jobs: NewOrder[] = [];
    for (let i = 0; i < 5; i += 1) jobs.push(await putJob(s, { nextAtMs: now - 1_000 * (5 - i) }));
    expect((await s.saga.claimDue(3, LEASE)).map((j) => j.orderId)).toEqual(jobs.slice(0, 3).map((o) => o.id));
    expect((await s.saga.claimDue(3, LEASE)).map((j) => j.orderId)).toEqual(jobs.slice(3).map((o) => o.id));
  });

  test('변이 검토 PRF-171_AWAIT 행(승인 명령 접수 뒤 결과 기다림)은 기한이 됐고 임대가 비었어도 claimDue·claim이 집지 않고 임대도 쓰지 않는다(결과 당기기가 고른다, PRF-171 설계 2) [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const now = s.clock.now();
    const waiting = await putJob(s, { nextAtMs: now - 9_000, step: 'AWAIT' });
    const confirm = await putJob(s, { nextAtMs: now - 1_000, step: 'CONFIRM' });

    expect((await s.saga.claimDue(10, LEASE)).map((j) => j.orderId)).toEqual([confirm.id]);
    expect(await s.saga.claim(waiting.id, LEASE)).toBeUndefined();
    expect((await jobOf(waiting.id))?.lease_until).toBeNull();
    expect((await jobOf(waiting.id))?.step).toBe('AWAIT');
  });

  test('다른 연결이 행 잠금을 쥔 행은 기다리지 않고 건너뛴다(SKIP LOCKED) [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const now = s.clock.now();
    const held = await putJob(s, { nextAtMs: now - 2_000 });
    const free = await putJob(s, { nextAtMs: now - 1_000 });
    const c = await race.pool.connect();
    try {
      await c.query('begin');
      await c.query('select order_id from order_saga_job where order_id = $1 for update', [held.id]);
      const started = Date.now();
      const got = await s.saga.claimDue(10, LEASE);
      expect(got.map((j) => j.orderId)).toEqual([free.id]);
      // 기다리지 않았다(잠금 시간 초과까지 서지 않는다)
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
    expect((await s.saga.claimDue(10, LEASE)).map((j) => j.orderId)).toEqual([held.id]);
  });

  test('두 파드(두 연결)가 동시에 claimDue를 불러도 같은 행을 둘이 집지 않고, 둘을 합치면 기한이 된 행 전부다(다섯 번) [ASVS v5.0.0-15.4.1]', async () => {
    for (let round = 0; round < 5; round += 1) {
      await q('delete from order_saga_job');
      const s = fresh(BASE_MS + round * 3_600_000);
      const now = s.clock.now();
      const ids: string[] = [];
      for (let i = 0; i < 12; i += 1) ids.push((await putJob(s, { nextAtMs: now - i })).id);
      const other = new DrizzleSaga({ database: race, store: s.store, sales: new DrizzleSeatSales(race), clock: s.clock });

      const settled = await Promise.allSettled([s.saga.claimDue(8, LEASE), other.claimDue(8, LEASE)]);

      expect(rejections(settled), `${round}회`).toEqual([]);
      const [a, b] = settled.map((x) => (x as PromiseFulfilledResult<{ orderId: string }[]>).value.map((j) => j.orderId));
      expect(a!.filter((id) => b!.includes(id)), `${round}회 겹침`).toEqual([]);
      expect([...a!, ...b!].sort(), `${round}회`).toEqual([...ids].sort());
    }
  });

  test.each<[string, number, number]>([
    ['limit 0', 0, LEASE],
    ['limit 소수', 1.5, LEASE],
    ['limit NaN', Number.NaN, LEASE],
    ['leaseMs 0', 1, 0],
    ['leaseMs 음수', 1, -1],
  ])('%s면 RangeError이고 아무 행도 임대하지 않는다 [ASVS v5.0.0-2.2.1]', async (_label, limit, leaseMs) => {
    const s = fresh();
    const o = await putJob(s, { nextAtMs: s.clock.now() - 1 });
    await expect(s.saga.claimDue(limit, leaseMs)).rejects.toThrow(RangeError);
    expect((await jobOf(o.id))?.lease_until).toBeNull();
  });
});

describe('DrizzleSaga SagaJobs.claim·get·reschedule·setStep·delete', () => {
  test('claim은 그 주문의 행 하나를 같은 조건(기한이 됐고 임대가 비었거나 지남)으로 집고, 임대 중·기한 전이면 undefined다', async () => {
    const s = fresh();
    const a = await accepted(s);
    const now = s.clock.now();
    expect(await s.saga.claim(a.o.id, LEASE)).toEqual({ orderId: a.o.id, eventId: a.o.eventId, step: 'RESERVE', attempts: 0, nextAttemptAtMs: a.at, leaseUntilMs: now + LEASE });
    expect((await jobOf(a.o.id))?.lease_until).toEqual(new Date(now + LEASE));
    // 임대 중
    s.clock.advance(LEASE - 1);
    expect(await s.saga.claim(a.o.id, LEASE)).toBeUndefined();
    // 임대가 지남
    s.clock.advance(2);
    expect((await s.saga.claim(a.o.id, LEASE))?.leaseUntilMs).toBe(s.clock.now() + LEASE);
    // 기한 전(다시 하기로 미룬 행)
    expect(await s.saga.reschedule(a.o.id, s.clock.now() + 5_000)).toBe(true);
    expect(await s.saga.claim(a.o.id, LEASE)).toBeUndefined();
    s.clock.advance(5_000);
    expect(await s.saga.claim(a.o.id, LEASE)).toMatchObject({ orderId: a.o.id, attempts: 1 });
  });

  test.each<[string, (id: string) => string]>([
    ['행 없는 주문(새 UUIDv7)', () => uuidv7(fakeClock({ now: BASE_MS }))],
    ['대문자 UUID', (id) => id.toUpperCase()],
    ['UUID가 아님', () => 'order-1'],
    ['빈 글', () => ''],
  ])('claim·get: %s면 undefined다(던지지 않는다)', async (_label, idOf) => {
    const s = fresh();
    const a = await accepted(s);
    // 맞는 ID는 읽힌다(아무것이나 undefined인 구현이 통과하지 않게)
    expect((await s.saga.get(a.o.id))?.orderId).toBe(a.o.id);
    expect(await s.saga.claim(idOf(a.o.id), LEASE)).toBeUndefined();
    expect(await s.saga.get(idOf(a.o.id))).toBeUndefined();
    expect((await jobOf(a.o.id))?.lease_until).toBeNull();
  });

  test('get은 임대를 쓰지 않고 행 그대로다(임대가 있으면 leaseUntilMs)', async () => {
    const s = fresh();
    const a = await accepted(s);
    expect(await s.saga.get(a.o.id)).toEqual({ orderId: a.o.id, eventId: a.o.eventId, step: 'RESERVE', attempts: 0, nextAttemptAtMs: a.at });
    expect((await jobOf(a.o.id))?.lease_until).toBeNull();
    await s.saga.claim(a.o.id, LEASE);
    expect((await s.saga.get(a.o.id))?.leaseUntilMs).toBe(s.clock.now() + LEASE);
  });

  test('reschedule은 attempts + 1, next_attempt_at = nextAtMs, 임대 비움이고 행이 없으면 false다', async () => {
    const s = fresh();
    const a = await accepted(s);
    await s.saga.claim(a.o.id, LEASE);
    const next = s.clock.now() + 2_000;
    expect(await s.saga.reschedule(a.o.id, next)).toBe(true);
    expect(await jobOf(a.o.id)).toEqual({ event_id: a.o.eventId, step: 'RESERVE', attempts: 1, next_attempt_at: new Date(next), lease_until: null });
    expect(await s.saga.reschedule(a.o.id, next + 4_000)).toBe(true);
    expect((await jobOf(a.o.id))?.attempts).toBe(2);
    expect(await s.saga.reschedule(uuidv7(s.clock), next)).toBe(false);
  });

  test('setStep은 단계를 바꾸고 attempts 0·next_attempt_at = 지금·임대 비움이며, 행이 없으면 false다. CHECK 밖의 단계는 DB가 막는다', async () => {
    const s = fresh();
    const a = await accepted(s);
    await s.saga.reschedule(a.o.id, s.clock.now() + 9_000);
    await s.saga.claim(a.o.id, LEASE);
    s.clock.advance(700);
    expect(await s.saga.setStep(a.o.id, 'CONFIRM')).toBe(true);
    expect(await jobOf(a.o.id)).toEqual({ event_id: a.o.eventId, step: 'CONFIRM', attempts: 0, next_attempt_at: new Date(s.clock.now()), lease_until: null });
    expect(await s.saga.setStep(uuidv7(s.clock), 'RESERVE')).toBe(false);
    await expect(s.saga.setStep(a.o.id, 'APPROVE' as 'RESERVE')).rejects.toThrow();
    expect((await jobOf(a.o.id))?.step).toBe('CONFIRM');
  });

  test('delete는 행을 지우고 true, 다시 부르면 false다', async () => {
    const s = fresh();
    const a = await accepted(s);
    expect(await s.saga.delete(a.o.id)).toBe(true);
    expect(await jobOf(a.o.id)).toBeUndefined();
    expect(await s.saga.delete(a.o.id)).toBe(false);
    // 주문은 그대로다
    expect((await orderRow(a.o.id))?.status).toBe('ACCEPTED');
  });
});

// ───────────────────────────── SagaOrders.read ─────────────────────────────

describe('DrizzleSaga SagaOrders.read(주문 행·항목·ACCEPTED 결제 시도)', () => {
  test('토스: 주문 칸(holdId·구매 세션·seat_gen·금액)·좌석(줄 번호 차례)·시도(결제사·pg_order_ref·결제 키·인증 시각)다', async () => {
    const s = fresh();
    const a = await accepted(s, { seatGen: 7 });
    expect(await s.saga.read(a.o.id)).toEqual({
      orderId: a.o.id,
      accountId: a.o.accountId,
      eventId: a.o.eventId,
      status: 'ACCEPTED',
      amount: a.o.amount,
      holdId: a.o.holdId,
      purchaseSessionId: a.o.purchaseSessionId,
      seatGen: 7,
      seats: a.o.items.map((it) => ({ seatId: it.seatId, tierId: it.tierId, sectionId: it.sectionId })),
      attempt: { attemptId: a.attemptId, pg: 'TOSS', attemptNo: 1, pgOrderRef: a.o.id, refs: a.refs, authenticatedAtMs: a.at },
    });
  });

  test('포트원: 결제 참조는 거래 ID·토큰이고 pgOrderRef는 pay-{주문 ID}다', async () => {
    const s = fresh();
    const refs = portoneRefs();
    const a = await accepted(s, { refs });
    expect((await s.saga.read(a.o.id))?.attempt).toEqual({ attemptId: a.attemptId, pg: 'PORTONE', attemptNo: 1, pgOrderRef: `pay-${a.o.id}`, refs, authenticatedAtMs: a.at });
  });

  test('P-T53_리뷰 고침 L9: 앞 시도가 대체된 뒤 접수된 시도의 순번은 2다(같은 주문의 시도를 만든 차례로 센다, ConfirmPaymentRequest.attempt_no)', async () => {
    const s = fresh();
    const o = await placed(s);
    const first = await putAttempt(s, o);
    await q(`update payment_attempt set status = 'SUPERSEDED' where id = $1`, [first]);
    s.clock.advance(1_000);
    const second = await putAttempt(s, o);
    s.clock.advance(1_000);
    const refs = tossRefs();
    const input: AcceptInput = { orderId: o.id, attemptId: second, eventId: o.eventId, refs, seatGen: 1, actor: accountActor(o.accountId) };
    expect(await s.accepts.accept(onceOf(o), input)).toEqual({ status: 'ACCEPTED' });

    expect((await s.saga.read(o.id))?.attempt).toMatchObject({ attemptId: second, attemptNo: 2 });
  });

  test('구매 세션 ID가 UUID가 아닌 jti 모양(키 조각)이어도 그대로 읽는다(payment §2 좌석 묶기 입력의 구매 세션 ID)', async () => {
    const s = fresh();
    const psid = `jti_${randomUUID().replaceAll('-', '').slice(0, 20)}-x`;
    const a = await accepted(s, { order: { purchaseSessionId: psid } });
    expect((await s.saga.read(a.o.id))?.purchaseSessionId).toBe(psid);
  });

  test('접수 전(CREATED)이면 seatGen·attempt가 없고, 결제 참조를 지운 뒤면 attempt.refs가 없다', async () => {
    const s = fresh();
    const o = await placed(s);
    await putAttempt(s, o);
    const r = await s.saga.read(o.id);
    expect(r).toMatchObject({ orderId: o.id, status: 'CREATED' });
    expect(r?.seatGen).toBeUndefined();
    expect(r?.attempt).toBeUndefined();
    const a = await accepted(s);
    await q('update payment_attempt set pg_payment_key = null where id = $1', [a.attemptId]);
    const after = await s.saga.read(a.o.id);
    expect(after?.attempt).toMatchObject({ attemptId: a.attemptId, pg: 'TOSS', authenticatedAtMs: a.at });
    expect(after?.attempt?.refs).toBeUndefined();
  });

  test.each<[string, (id: string) => string]>([
    ['없는 주문', () => uuidv7(fakeClock({ now: BASE_MS }))],
    ['대문자 UUID', (id) => id.toUpperCase()],
    ['UUID가 아님', () => 'order-1'],
  ])('%s면 undefined다(던지지 않는다)', async (_label, idOf) => {
    const s = fresh();
    const a = await accepted(s);
    expect((await s.saga.read(a.o.id))?.orderId).toBe(a.o.id);
    expect(await s.saga.read(idOf(a.o.id))).toBeUndefined();
  });
});

// ───────────────────────────── ReserveTx ─────────────────────────────

describe('DrizzleSaga ReserveTx.reserve(한 트랜잭션: seat_rebuild 행 → gen FOR SHARE 대조 → 판매 예약 → 작업 CONFIRM → T7)', () => {
  test('RESERVED: seat_rebuild 행이 없으면 판 번호 1로 넣고, 판매 행 PENDING·한도·작업 CONFIRM(attempts 0, 지금, 임대 비움)·T7 이력·Outbox RESERVED를 커밋한다 [ASVS v5.0.0-15.4.1] [ASVS v5.0.0-2.3.1]', async () => {
    const s = fresh();
    const a = await accepted(s, { seatGen: 1 });
    await s.saga.claim(a.o.id, LEASE);
    await s.saga.reschedule(a.o.id, s.clock.now());
    s.clock.advance(3_000);
    const at = s.clock.now();
    expect(await rebuildOf(a.o.eventId)).toBeUndefined();

    expect(await s.saga.reserve(reserveInputOf(a, 1))).toEqual({ status: 'RESERVED' });

    expect(await rebuildOf(a.o.eventId)).toEqual({ gen: 1, holder: null, lease_until: null });
    expect(await salesOf(a.o.eventId)).toEqual(
      [...a.o.items].map((it) => it.seatId).sort().map((seat_id) => ({ seat_id, order_id: a.o.id, account_id: a.o.accountId, status: 'PENDING' })),
    );
    expect(await quotaOf(a.o.accountId, a.o.eventId)).toEqual({ used: 2, limit_count: LIMIT });
    expect(await jobOf(a.o.id)).toEqual({ event_id: a.o.eventId, step: 'CONFIRM', attempts: 0, next_attempt_at: new Date(at), lease_until: null });
    expect(await orderRow(a.o.id)).toMatchObject({ status: 'RESERVED', event_seq: 4, seat_gen: 1, failure_reason: null });
    expect((await historyOf(a.o.id)).at(-1)).toEqual({ seq: 4, from_status: 'ACCEPTED', to_status: 'RESERVED', cause: 'T7', actor: SAGA, occurred_at: new Date(at) });
    const outbox = await outboxOf(a.o.eventId);
    expect(outbox.map((x) => x.event.type)).toEqual(['CREATED', 'ACCEPTED', 'RESERVED']);
    expect(outbox[2]!.event).toMatchObject(laterEvent(a.o, 'RESERVED', 4, at, false));
    for (const k of CREATED_ONLY) expect(outbox[2]!.event).not.toHaveProperty(k);
    expect(contractIssues(outbox[2]!.event)).toEqual([]);
    // 결제 참조는 그대로(승인 명령이 쓴다)이고 사건에 싣지 않는다
    expect((await attemptRefs(a.attemptId))?.pg_payment_key).toBe((a.refs as { paymentKey: string }).paymentKey);
    for (const x of outbox) expect(x.raw).not.toContain((a.refs as { paymentKey: string }).paymentKey);
  });

  test('쓰기 차례: seat_rebuild 행 → 한도 행 → 좌석 행 → 작업 행 → 주문 행(T7) → 이력 → Outbox가 마지막이다(한 트랜잭션, OPEN[15]의 잠금 차례) [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const a = await accepted(s);
    expect(await s.saga.reserve(reserveInputOf(a))).toEqual({ status: 'RESERVED' });
    expect(await writesOfTx(a.o.id, 'T7')).toEqual([
      'INSERT seat_rebuild',
      'INSERT purchase_quota',
      'INSERT seat_sale',
      'UPDATE order_saga_job',
      'UPDATE purchase_order',
      'INSERT order_event',
      'INSERT outbox',
    ]);
  });

  test('seat_rebuild 행이 이미 있고 판 번호가 같으면(다시 만들기 뒤 판 3, 주문 seat_gen 3) 행을 바꾸지 않고 RESERVED다', async () => {
    const s = fresh();
    const a = await accepted(s, { seatGen: 3 });
    await q('insert into seat_rebuild (event_id, gen, holder, lease_until) values ($1, 3, null, null)', [a.o.eventId]);
    expect(await s.saga.reserve(reserveInputOf(a, 3))).toEqual({ status: 'RESERVED' });
    expect(await rebuildOf(a.o.eventId)).toEqual({ gen: 3, holder: null, lease_until: null });
    expect((await orderRow(a.o.id))?.status).toBe('RESERVED');
    // 행이 있었으니 seat_rebuild 쓰기가 없다
    expect((await writesOfTx(a.o.id, 'T7'))[0]).toBe('INSERT purchase_quota');
  });

  // 리뷰 고침 M1(2026-11-05, 명세 saleStep): GEN_CHANGED는 되돌리기만 한다(주문 seat_gen도 그대로. 실행기가 그 번호 그대로 묶기부터 다시 한다)
  test('M1_VT40_④_GEN_CHANGED: seat_rebuild 판 번호(2)가 주문의 것(1)과 다르면 되돌리고 아무것도 남기지 않는다(판매 행·한도·작업·이력·Outbox·주문 seat_gen 그대로) [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const a = await accepted(s, { seatGen: 1 });
    await q('insert into seat_rebuild (event_id, gen, holder, lease_until) values ($1, 2, null, null)', [a.o.eventId]);
    const before = await traceOf(a);

    expect(await s.saga.reserve(reserveInputOf(a, 1))).toEqual({ status: 'GEN_CHANGED', gen: 2 });

    expect(await traceOf(a)).toEqual(before);
    expect(before.order).toMatchObject({ seat_gen: 1 });
    expect(before.sales).toEqual([]);
    expect(before.job).toMatchObject({ step: 'RESERVE' });
  });

  test('SEAT_TAKEN: 다른 주문이 한 좌석을 이미 PENDING으로 가졌으면 그 좌석을 돌려주고 트랜잭션째 되돌린다(seat_rebuild 행·한도·작업·이력이 그대로) [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const a = await accepted(s);
    const taken = a.o.items[1]!.seatId;
    const rival = randomUUID();
    expect(await s.sales.reserve({ eventId: a.o.eventId, orderId: uuidv7(s.clock), accountId: rival, seatIds: [taken], limit: LIMIT })).toEqual({ status: 'RESERVED' });
    const before = await traceOf(a);

    expect(await s.saga.reserve(reserveInputOf(a))).toEqual({ status: 'SEAT_TAKEN', seatIds: [taken] });

    expect(await traceOf(a)).toEqual(before);
    expect(before.rebuild).toBeUndefined();
    expect(before.quota).toBeUndefined();
    expect(before.sales.map((x) => x.account_id)).toEqual([rival]);
  });

  test.each<[string, number | undefined, number]>([
    ['한도 행이 이미 3/4인데 2석', 3, LIMIT],
    ['1인 한도 1인데 2석(DB 한도 행 없음)', undefined, 1],
  ])('QUOTA_EXCEEDED(%s): 트랜잭션째 되돌리고 한도 행이 그대로다 [ASVS v5.0.0-15.4.1]', async (_label, used, limit) => {
    const s = fresh();
    const a = await accepted(s);
    if (used !== undefined) await q('insert into purchase_quota (account_id, event_id, used, limit_count) values ($1, $2, $3, $4)', [a.o.accountId, a.o.eventId, used, LIMIT]);
    const before = await traceOf(a);

    expect(await s.saga.reserve(reserveInputOf(a, 1, { limit }))).toEqual({ status: 'QUOTA_EXCEEDED' });

    expect(await traceOf(a)).toEqual(before);
  });

  test.each<[string, readonly TransitionId[], string]>([
    ['이미 RESERVED(다른 실행이 먼저 함)', ['T7'], 'RESERVED'],
    ['FAILED(T8)', ['T8'], 'FAILED'],
  ])('ORDER_STATE(%s): T7이 0행이면 넣은 판매 행·한도까지 트랜잭션째 되돌리고 current가 지금 상태다 [ASVS v5.0.0-15.4.1]', async (_label, path, current) => {
    const s = fresh();
    const a = await accepted(s);
    await walk(s, a.o, path);
    const before = await traceOf(a);

    expect(await s.saga.reserve(reserveInputOf(a))).toEqual({ status: 'ORDER_STATE', current });

    expect(await traceOf(a)).toEqual(before);
    expect(before.sales).toEqual([]);
  });

  test.each<[string, (i: ReserveTxInput) => ReserveTxInput]>([
    ['orderId가 UUID가 아님', (i) => ({ ...i, orderId: 'order-1' })],
    ['eventId가 대문자 UUID', (i) => ({ ...i, eventId: i.eventId.toUpperCase() })],
    ['좌석 없음', (i) => ({ ...i, seatIds: [] })],
    ['좌석 11개', (i) => ({ ...i, seatIds: Array.from({ length: 11 }, () => randomUUID()) })],
    ['좌석 ID가 UUID가 아님', (i) => ({ ...i, seatIds: ['A01'] })],
    ['한도 0', (i) => ({ ...i, limit: 0 })],
    ['orderGen 0', (i) => ({ ...i, orderGen: 0 })],
    ['orderGen 소수', (i) => ({ ...i, orderGen: 1.5 })],
    ['행위자 모양이 틀림', (i) => ({ ...i, actor: 'saga' })],
  ])('입력이 틀리면(%s) RangeError이고 아무것도 바뀌지 않으며, 맞는 입력으로 다시 부르면 RESERVED다 [ASVS v5.0.0-2.2.1]', async (_label, change) => {
    const s = fresh();
    const a = await accepted(s);
    const good = reserveInputOf(a);
    const before = await traceOf(a);
    await expect(s.saga.reserve(change(good))).rejects.toThrow(RangeError);
    expect(await traceOf(a)).toEqual(before);
    expect(await s.saga.reserve(good)).toEqual({ status: 'RESERVED' });
  });
});

describe('DrizzleSaga ReserveTx.reserve 동시성(data.md §5 Saga 1단계·결제 접수 reserve, OPEN[15])', () => {
  test('VT40_④_다시 만들기의 판 번호 올리기가 seat_rebuild 행을 쥔 채 있으면 판매 예약은 FOR SHARE에서 기다리고, 그것이 커밋되면 새 번호(2)를 읽어 GEN_CHANGED다(판매 행 없음) [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const a = await accepted(s, { seatGen: 1 });
    await q('insert into seat_rebuild (event_id, gen, holder, lease_until) values ($1, 1, null, null)', [a.o.eventId]);
    const c = await race.pool.connect();
    let settled = false;
    let reserving: Promise<ReserveTxOutcome> | undefined;
    try {
      await c.query('begin');
      // 다시 만들기 임대 잡기와 같은 문장(drizzle-seat-rebuild.ts acquire)을 커밋하지 않고 쥔다
      await c.query(
        `insert into seat_rebuild (event_id, gen, holder, lease_until) values ($1, 2, 'pod-rebuild', now() + interval '60 seconds')
         on conflict (event_id) do update set gen = seat_rebuild.gen + 1, holder = excluded.holder, lease_until = excluded.lease_until
         where seat_rebuild.lease_until is null or seat_rebuild.lease_until < now() returning gen`,
        [a.o.eventId],
      );
      reserving = s.saga.reserve(reserveInputOf(a, 1)).finally(() => {
        settled = true;
      });
      reserving.catch(() => undefined);
      expect(await waitFor(async () => settled || (await lockWaiters(APP)) > 0, 5_000)).toBe(true);
      expect(settled).toBe(false);
      await c.query('commit');
      expect(await reserving).toEqual({ status: 'GEN_CHANGED', gen: 2 });
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
      await reserving?.catch(() => undefined);
    }
    expect(await salesOf(a.o.eventId)).toEqual([]);
    // 되돌리기만 한다(리뷰 M1): 주문 seat_gen은 그대로 1
    expect(await orderRow(a.o.id)).toMatchObject({ status: 'ACCEPTED', seat_gen: 1 });
  });

  test('VT40_④_판매 예약이 seat_rebuild 행을 FOR SHARE로 쥔 동안 온 다시 만들기 임대(DrizzleSeatRebuildSource.acquire)는 기다리고, 판매 예약이 RESERVED로 커밋된 뒤에 판 번호를 2로 올린다(그 판매는 다시 만들기가 읽는다) [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const a = await accepted(s, { seatGen: 1 });
    // 판매 행 삽입마다 0.4초 쉰다(판매 예약 트랜잭션이 seat_rebuild 행을 쥔 시간을 늘린다)
    await q('insert into saga_slow_insert (event_id, ms) values ($1, 400)', [a.o.eventId]);
    let reserveDone = false;
    let acquireDone = false;
    const reserving = s.saga.reserve(reserveInputOf(a, 1)).finally(() => {
      reserveDone = true;
    });
    reserving.catch(() => undefined);
    try {
      expect(await waitFor(async () => reserveDone || (await sleepers(APP)) > 0, 5_000)).toBe(true);
      expect(reserveDone).toBe(false);
      const acquiring = new DrizzleSeatRebuildSource(race).acquire(a.o.eventId, 'pod-rebuild').finally(() => {
        acquireDone = true;
      });
      acquiring.catch(() => undefined);
      expect(await waitFor(async () => acquireDone || reserveDone || (await lockWaiters(RACE)) > 0, 5_000)).toBe(true);
      expect(acquireDone).toBe(false);
      expect(await reserving).toEqual({ status: 'RESERVED' });
      expect(await acquiring).toBe(2);
    } finally {
      await reserving.catch(() => undefined);
      await q('delete from saga_slow_insert where event_id = $1', [a.o.eventId]);
    }
    expect((await salesOf(a.o.eventId)).map((x) => x.status)).toEqual(['PENDING', 'PENDING']);
    expect(await orderRow(a.o.id)).toMatchObject({ status: 'RESERVED', seat_gen: 1 });
    expect((await rebuildOf(a.o.eventId))?.gen).toBe(2);
  });

  test('ST8_같은 좌석의 두 주문(다른 계정)이 두 연결에서 동시에 판매 예약하면 하나만 RESERVED이고 진 쪽은 SEAT_TAKEN으로 아무것도 남지 않는다(다섯 번) [ASVS v5.0.0-15.4.1]', async () => {
    for (let round = 0; round < 5; round += 1) {
      const s = fresh();
      const seat = randomUUID();
      const eventId = randomUUID();
      const mk = async () => accepted(s, { order: { eventId, items: [{ seatId: seat, tierId: 'R', sectionId: 'SEC-A', unitPrice: 99_000 }] } });
      const x = await mk();
      const y = await mk();
      await q('insert into saga_slow_insert (event_id, ms) values ($1, 50) on conflict do nothing', [eventId]);
      const other = new DrizzleSaga({ database: race, store: s.store, sales: new DrizzleSeatSales(race), clock: s.clock });

      const settled = await Promise.allSettled([s.saga.reserve(reserveInputOf(x)), other.reserve(reserveInputOf(y))]);

      expect(rejections(settled), `${round}회`).toEqual([]);
      const out = settled.map((r) => (r as PromiseFulfilledResult<ReserveTxOutcome>).value);
      expect(out.map((r) => r.status).sort(), `${round}회`).toEqual(['RESERVED', 'SEAT_TAKEN']);
      expect(out.find((r) => r.status === 'SEAT_TAKEN'), `${round}회`).toEqual({ status: 'SEAT_TAKEN', seatIds: [seat] });
      const [win, lose] = out[0]!.status === 'RESERVED' ? [x, y] : [y, x];
      expect(await salesOf(eventId), `${round}회`).toEqual([{ seat_id: seat, order_id: win.o.id, account_id: win.o.accountId, status: 'PENDING' }]);
      expect(await orderRow(lose.o.id), `${round}회`).toMatchObject({ status: 'ACCEPTED' });
      expect((await jobOf(lose.o.id))?.step, `${round}회`).toBe('RESERVE');
      expect(await quotaOf(lose.o.accountId, eventId), `${round}회`).toBeUndefined();
    }
  });
});

// ───────────────────────────── SagaFailures ─────────────────────────────

const failOf = (a: Accepted, x: Partial<SagaFailInput> = {}): SagaFailInput => ({ orderId: a.o.id, transition: 'T8', reason: 'SEAT_TAKEN', actor: SAGA, ...x });
const releaseOf = (a: Accepted) => ({ eventId: a.o.eventId, orderId: a.o.id, accountId: a.o.accountId, seatIds: a.o.items.map((it) => it.seatId) });

// 리뷰 고침(2026-11-05) H1 변형: 첫 문장은 작업 행(기대 단계·자기 임대)이고, M4: 작업 행은 지우지 않고 RELEASE로 바꾼다(실행기가 실패 해제 뒤 지운다)
describe('DrizzleSaga SagaFailures.fail(한 트랜잭션: 작업 행 RELEASE → failure_reason → (T11) releasePendingIn → 결제 참조 지우기 → T8·T11)', () => {
  test.each(['SEAT_TAKEN', 'QUOTA_EXCEEDED', 'STALE_GEN', 'EXPIRED', 'STORE_GONE'] as const)(
    'T8(%s): 주문 FAILED·failure_reason, 이력 T8, Outbox FAILED, 작업 행 RELEASE(attempts 0), 결제 키 지움(과금 없이 끝남) [ASVS v5.0.0-2.3.1] [ASVS v5.0.0-14.2.4]',
    async (reason) => {
      const s = fresh();
      const a = await accepted(s);
      s.clock.advance(2_000);
      const at = s.clock.now();

      expect(await s.saga.fail(failOf(a, { reason }))).toEqual({ status: 'FAILED' });

      expect(await orderRow(a.o.id)).toMatchObject({ status: 'FAILED', event_seq: 4, failure_reason: reason, payment_event_seq: '0' });
      expect((await historyOf(a.o.id)).at(-1)).toEqual({ seq: 4, from_status: 'ACCEPTED', to_status: 'FAILED', cause: 'T8', actor: SAGA, occurred_at: new Date(at) });
      const outbox = await outboxOf(a.o.eventId);
      expect(outbox.map((x) => x.event.type)).toEqual(['CREATED', 'ACCEPTED', 'FAILED']);
      expect(outbox[2]!.event).toMatchObject(laterEvent(a.o, 'FAILED', 4, at, false));
      expect(contractIssues(outbox[2]!.event)).toEqual([]);
      expect(await jobOf(a.o.id)).toEqual({ event_id: a.o.eventId, step: 'RELEASE', attempts: 0, next_attempt_at: new Date(at), lease_until: null });
      expect(await attemptRefs(a.attemptId)).toEqual({ pg_payment_key: null, pg_tx_id: null, pg_payment_token: null });
    },
  );

  test('H1변형_T8 쓰기 차례: 작업 행(RELEASE) → 주문 failure_reason → 결제 시도 → 주문 전이 → 이력 → Outbox가 마지막이다(판매 예약과 같이 작업 행이 주문 행보다 먼저) [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const a = await accepted(s, { refs: portoneRefs() });
    expect(await s.saga.fail(failOf(a))).toEqual({ status: 'FAILED' });
    expect(await writesOfTx(a.o.id, 'T8')).toEqual(['UPDATE order_saga_job', 'UPDATE purchase_order', 'UPDATE payment_attempt', 'UPDATE purchase_order', 'INSERT order_event', 'INSERT outbox']);
    expect(await attemptRefs(a.attemptId)).toEqual({ pg_payment_key: null, pg_tx_id: null, pg_payment_token: null });
  });

  test('T11(EXPIRED): 결제 사건 순번 없이 받고(payment_event_seq 그대로 0), 판매 행 PENDING을 지우고 한도를 되돌리며, 결제 참조를 지우고 작업 행을 RELEASE로 바꾼다 [ASVS v5.0.0-2.3.1] [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const a = await accepted(s);
    await reservedByHand(s, a);
    expect(await quotaOf(a.o.accountId, a.o.eventId)).toEqual({ used: 2, limit_count: LIMIT });
    s.clock.advance(600_000);
    const at = s.clock.now();

    expect(await s.saga.fail(failOf(a, { transition: 'T11', reason: 'EXPIRED', release: releaseOf(a) }))).toEqual({ status: 'FAILED' });

    expect(await orderRow(a.o.id)).toMatchObject({ status: 'FAILED', event_seq: 5, failure_reason: 'EXPIRED', payment_event_seq: '0' });
    expect((await historyOf(a.o.id)).at(-1)).toEqual({ seq: 5, from_status: 'RESERVED', to_status: 'FAILED', cause: 'T11', actor: SAGA, occurred_at: new Date(at) });
    expect((await outboxOf(a.o.eventId)).at(-1)!.event).toMatchObject(laterEvent(a.o, 'FAILED', 5, at, false));
    expect(await salesOf(a.o.eventId)).toEqual([]);
    expect(await quotaOf(a.o.accountId, a.o.eventId)).toEqual({ used: 0, limit_count: LIMIT });
    expect(await jobOf(a.o.id)).toMatchObject({ step: 'RELEASE', attempts: 0 });
    expect(await attemptRefs(a.attemptId)).toEqual({ pg_payment_key: null, pg_tx_id: null, pg_payment_token: null });
    expect(await writesOfTx(a.o.id, 'T11')).toEqual([
      'UPDATE order_saga_job',
      'UPDATE purchase_order',
      'DELETE seat_sale',
      'UPDATE purchase_quota',
      'UPDATE payment_attempt',
      'UPDATE purchase_order',
      'INSERT order_event',
      'INSERT outbox',
    ]);
  });

  test('T11은 그 주문·계정의 PENDING 행만 지운다(같은 회차 다른 주문의 판매 행·한도는 그대로)', async () => {
    const s = fresh();
    const a = await accepted(s);
    await reservedByHand(s, a);
    const otherAccount = randomUUID();
    const otherSeat = randomUUID();
    expect(await s.sales.reserve({ eventId: a.o.eventId, orderId: uuidv7(s.clock), accountId: otherAccount, seatIds: [otherSeat], limit: LIMIT })).toEqual({ status: 'RESERVED' });
    expect(await s.saga.fail(failOf(a, { transition: 'T11', reason: 'EXPIRED', release: releaseOf(a) }))).toEqual({ status: 'FAILED' });
    expect((await salesOf(a.o.eventId)).map((x) => [x.seat_id, x.account_id])).toEqual([[otherSeat, otherAccount]]);
    expect(await quotaOf(otherAccount, a.o.eventId)).toEqual({ used: 1, limit_count: LIMIT });
  });

  test.each<[string, readonly TransitionId[] | 'reserved', SagaFailInput['transition'], string]>([
    ['RESERVED 주문에 T8', 'reserved', 'T8', 'RESERVED'],
    ['ACCEPTED 주문에 T11', [], 'T11', 'ACCEPTED'],
    ['이미 FAILED(T8)인 주문에 T8', ['T8'], 'T8', 'FAILED'],
  ])('STALE(%s): 트랜잭션째 되돌려 failure_reason·판매 행·한도·결제 참조·작업 행이 그대로다 [ASVS v5.0.0-15.4.1]', async (_label, path, transition, current) => {
    const s = fresh();
    const a = await accepted(s);
    if (path === 'reserved') await reservedByHand(s, a);
    else await walk(s, a.o, path);
    // ACCEPTED 주문의 T11 경우에도 지울 판매 행이 있게(다른 길로 들어간 PENDING이 지워지지 않는지 본다)
    if (path !== 'reserved' && transition === 'T11') {
      expect(await s.sales.reserve({ eventId: a.o.eventId, orderId: a.o.id, accountId: a.o.accountId, seatIds: a.o.items.map((it) => it.seatId), limit: LIMIT })).toEqual({ status: 'RESERVED' });
    }
    const before = await traceOf(a);
    const input = failOf(a, { transition, reason: 'EXPIRED', ...(transition === 'T11' ? { release: releaseOf(a) } : {}) });

    expect(await s.saga.fail(input)).toEqual({ status: 'STALE', current });

    expect(await traceOf(a)).toEqual(before);
  });

  test.each<[string, (a: Accepted) => SagaFailInput]>([
    ['T11인데 release 없음', (a) => failOf(a, { transition: 'T11', reason: 'EXPIRED' })],
    ['T8인데 release 있음', (a) => failOf(a, { release: releaseOf(a) })],
    ['모르는 사유', (a) => failOf(a, { reason: 'DECLINED' as 'EXPIRED' })],
    ['모르는 전이', (a) => failOf(a, { transition: 'T15' as 'T8' })],
    ['orderId가 UUID가 아님', (a) => failOf(a, { orderId: 'order-1' })],
    ['행위자 모양이 틀림', (a) => failOf(a, { actor: 'saga' })],
  ])('입력이 틀리면(%s) RangeError이고 아무것도 바뀌지 않는다 [ASVS v5.0.0-2.2.1]', async (_label, bad) => {
    const s = fresh();
    const a = await accepted(s);
    const before = await traceOf(a);
    await expect(s.saga.fail(bad(a))).rejects.toThrow(RangeError);
    expect(await traceOf(a)).toEqual(before);
    // 맞는 입력은 받는다(무엇이든 RangeError인 구현이 통과하지 않게)
    expect(await s.saga.fail(failOf(a))).toEqual({ status: 'FAILED' });
  });

  // 리뷰 고침 H1 변형·④(2026-11-05): fail의 첫 문장은 작업 행(WHERE step = 기대 단계, 자기 임대)이다. 다른 실행이 승인을 접수시키고 작업을 AWAIT로 바꾼 뒤(PRF-171)
  // 늦은 실행이 T11을 쓰는 길이 막히고, 판매 예약과 잠금 차례(작업 행 → 주문 행)가 같아진다
  test('H1변형_④_A가 CONFIRM 작업을 쥐고 있다가 임대가 지난 사이 B가 집어 승인 뒤 정리(done)로 작업 행을 AWAIT로 바꾸면(PRF-171), A의 늦은 T11은 STALE이고 주문·판매 행·한도가 그대로다 [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const a = await accepted(s);
    await reservedByHand(s, a);
    const held = await s.saga.claim(a.o.id, LEASE);
    expect(held?.step).toBe('CONFIRM');
    const other = new DrizzleSaga({ database: race, store: s.store, sales: new DrizzleSeatSales(race), clock: s.clock });
    s.clock.advance(LEASE + 1);
    const b = await other.claim(a.o.id, LEASE);
    expect(b?.step).toBe('CONFIRM');
    expect(await other.done(a.o.id, b!.leaseUntilMs)).toBe(true);
    const before = await traceOf(a);

    expect(await s.saga.fail(failOf(a, { transition: 'T11', reason: 'EXPIRED', release: releaseOf(a), leaseUntilMs: held!.leaseUntilMs }))).toEqual({ status: 'STALE', current: 'RESERVED' });

    expect(await traceOf(a)).toEqual(before);
    expect(before.order).toMatchObject({ status: 'RESERVED', failure_reason: null });
    expect(before.sales.map((x) => x.status)).toEqual(['PENDING', 'PENDING']);
  });

  test('H1변형_④_자기 임대가 아니면(lease_until이 다름) fail은 STALE이고 아무것도 바뀌지 않는다. 맞는 임대면 FAILED다', async () => {
    const s = fresh();
    const a = await accepted(s);
    const held = await s.saga.claim(a.o.id, LEASE);
    const before = await traceOf(a);
    expect(await s.saga.fail(failOf(a, { leaseUntilMs: held!.leaseUntilMs! + 1 }))).toEqual({ status: 'STALE', current: 'ACCEPTED' });
    expect(await traceOf(a)).toEqual(before);
    expect(await s.saga.fail(failOf(a, { leaseUntilMs: held!.leaseUntilMs }))).toEqual({ status: 'FAILED' });
  });

  test('같은 주문의 T8 둘이 두 연결에서 겹치면 하나만 FAILED이고 다른 하나는 STALE(current FAILED)이며 이력·Outbox가 하나씩이다 [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const a = await accepted(s);
    const other = new DrizzleSaga({ database: race, store: s.store, sales: new DrizzleSeatSales(race), clock: s.clock });
    const settled = await Promise.allSettled([s.saga.fail(failOf(a)), other.fail(failOf(a, { reason: 'EXPIRED' }))]);
    expect(rejections(settled).map(messagesOf)).toEqual([]);
    const out = settled.map((r) => (r as PromiseFulfilledResult<unknown>).value);
    expect(out).toContainEqual({ status: 'FAILED' });
    expect(out).toContainEqual({ status: 'STALE', current: 'FAILED' });
    expect((await historyOf(a.o.id)).map((h) => h.cause)).toEqual(['T1', 'T3', 'T4', 'T8']);
    expect((await outboxOf(a.o.eventId)).map((x) => x.event.type)).toEqual(['CREATED', 'ACCEPTED', 'FAILED']);
  });
});

// ───────────────────────────── ConfirmSent ─────────────────────────────

// PRF-171(추천 적용 2026-11-06, payment §2 단계 CONFIRM): 승인 명령이 접수되면 작업 행을 지우지 않고 AWAIT로 남긴다(confirm_sent_at 그대로, 결과 당기기가 찾는다)
describe('DrizzleSaga ConfirmSent.done(한 트랜잭션: 결제 참조 지우기 → 작업 행 AWAIT)', () => {
  test.each<[string, () => PaymentRefs]>([
    ['토스', tossRefs],
    ['포트원', portoneRefs],
  ])('%s: 결제 키·거래 ID·토큰을 비우고 작업 행을 지우지 않고 AWAIT로 남겨(confirm_sent_at 그대로) true, 다시 부르면 false이며 주문 상태는 그대로 RESERVED다 [ASVS v5.0.0-14.2.4] [ASVS v5.0.0-2.3.3]', async (_label, refsOf) => {
    const s = fresh();
    const a = await accepted(s, { refs: refsOf() });
    await reservedByHand(s, a);
    expect(await s.saga.markConfirmSent(a.o.id)).toBe(true);
    const sentAt = await sentAtOf(a.o.id);
    expect(sentAt).toEqual(new Date(s.clock.now()));
    const before = await traceOf(a);
    expect(before.refs).not.toEqual({ pg_payment_key: null, pg_tx_id: null, pg_payment_token: null });
    s.clock.advance(1_000);

    expect(await s.saga.done(a.o.id)).toBe(true);

    expect(await attemptRefs(a.attemptId)).toEqual({ pg_payment_key: null, pg_tx_id: null, pg_payment_token: null });
    expect((await jobOf(a.o.id))?.step).toBe('AWAIT');
    expect(await sentAtOf(a.o.id)).toEqual(sentAt);
    // AWAIT 행의 attempts·next_attempt_at·임대는 정본에 없어 보지 않는다
    expect({ ...(await traceOf(a)), job: undefined }).toEqual({ ...before, job: undefined, refs: { pg_payment_key: null, pg_tx_id: null, pg_payment_token: null } });
    expect(await s.saga.done(a.o.id)).toBe(false);
    expect((await jobOf(a.o.id))?.step).toBe('AWAIT');
  });

  test('작업 행이 없으면(다른 실행이 먼저 끝냄) false이고 결제 참조를 지우지 않는다', async () => {
    const s = fresh();
    const a = await accepted(s);
    await reservedByHand(s, a);
    await q('delete from order_saga_job where order_id = $1', [a.o.id]);
    expect(await s.saga.done(a.o.id)).toBe(false);
    expect((await attemptRefs(a.attemptId))?.pg_payment_key).not.toBeNull();
  });

  test('낮음_자기 임대가 아니면(lease_until이 다름) false이고 아무것도 바꾸지 않는다. 맞는 임대면 true다', async () => {
    const s = fresh();
    const a = await accepted(s);
    await reservedByHand(s, a);
    const held = await s.saga.claim(a.o.id, LEASE);
    const before = await traceOf(a);
    expect(await s.saga.done(a.o.id, held!.leaseUntilMs! + 1)).toBe(false);
    expect(await traceOf(a)).toEqual(before);
    expect(await s.saga.done(a.o.id, held!.leaseUntilMs)).toBe(true);
    expect((await jobOf(a.o.id))?.step).toBe('AWAIT');
  });
});

// ───────────────────────────── 리뷰 고침(2026-11-05) H1·M1·M3·낮음 ─────────────────────────────

const sentAtOf = async (orderId: string) =>
  (await q<{ confirm_sent_at: Date | null }>('select confirm_sent_at from order_saga_job where order_id = $1', [orderId]))[0]?.confirm_sent_at;

describe('DrizzleSaga 보낸 시각·임대·건너뛰기·판 번호 적기', () => {
  test('H1_markConfirmSent: CONFIRM 작업 행의 confirm_sent_at을 처음이면 지금으로 적고(커밋), 다시 불러도 처음 값 그대로다. 집기는 그 값을 confirmSentAtMs로 돌려준다', async () => {
    const s = fresh();
    const a = await accepted(s);
    await reservedByHand(s, a);
    const held = await s.saga.claim(a.o.id, LEASE);
    expect(held?.confirmSentAtMs).toBeUndefined();
    const at = s.clock.now();
    expect(await s.saga.markConfirmSent(a.o.id, held!.leaseUntilMs)).toBe(true);
    expect(await sentAtOf(a.o.id)).toEqual(new Date(at));
    s.clock.advance(5_000);
    expect(await s.saga.markConfirmSent(a.o.id, held!.leaseUntilMs)).toBe(true);
    expect(await sentAtOf(a.o.id)).toEqual(new Date(at));
    expect(await s.saga.reschedule(a.o.id, s.clock.now(), held!.leaseUntilMs)).toBe(true);
    expect((await s.saga.claim(a.o.id, LEASE))?.confirmSentAtMs).toBe(at);
  });

  test('H1_markConfirmSent: 작업 행이 CONFIRM이 아니거나(RESERVE) 자기 임대가 아니면 false이고 적지 않는다', async () => {
    const s = fresh();
    const a = await accepted(s);
    const held = await s.saga.claim(a.o.id, LEASE);
    expect(await s.saga.markConfirmSent(a.o.id, held!.leaseUntilMs)).toBe(false);
    await q(`update order_saga_job set step = 'CONFIRM' where order_id = $1`, [a.o.id]);
    expect(await s.saga.markConfirmSent(a.o.id, held!.leaseUntilMs! + 1)).toBe(false);
    expect(await sentAtOf(a.o.id)).toBeNull();
  });

  test('낮음_reschedule·setStep·delete·release는 자기 임대가 아니면 0행(false)이고, 맞으면 바꾼다. release는 임대만 비운다', async () => {
    const s = fresh();
    const a = await accepted(s);
    const held = await s.saga.claim(a.o.id, LEASE);
    const wrong = held!.leaseUntilMs! + 1;
    expect(await s.saga.reschedule(a.o.id, s.clock.now() + 1_000, wrong)).toBe(false);
    expect(await s.saga.setStep(a.o.id, 'CONFIRM', wrong)).toBe(false);
    expect(await s.saga.delete(a.o.id, { leaseUntilMs: wrong })).toBe(false);
    expect(await s.saga.release(a.o.id, wrong)).toBe(false);
    expect(await jobOf(a.o.id)).toMatchObject({ step: 'RESERVE', attempts: 0, lease_until: new Date(held!.leaseUntilMs!) });
    expect(await s.saga.release(a.o.id, held!.leaseUntilMs!)).toBe(true);
    expect(await jobOf(a.o.id)).toEqual({ event_id: a.o.eventId, step: 'RESERVE', attempts: 0, next_attempt_at: new Date(a.at), lease_until: null });
    // 단계가 다르면 delete는 지우지 않는다
    expect(await s.saga.delete(a.o.id, { step: 'RELEASE' })).toBe(false);
    expect(await s.saga.delete(a.o.id, { step: 'RESERVE' })).toBe(true);
  });

  test('낮음_판매 예약 트랜잭션도 자기 임대가 아니면 작업 행을 바꾸지 못해 되돌리고 ORDER_STATE다(판매 행·한도가 남지 않는다). 판매 예약은 임대를 그대로 둔다', async () => {
    const s = fresh();
    const a = await accepted(s);
    const held = await s.saga.claim(a.o.id, LEASE);
    const before = await traceOf(a);
    expect(await s.saga.reserve(reserveInputOf(a, 1, { leaseUntilMs: held!.leaseUntilMs! + 1 }))).toEqual({ status: 'ORDER_STATE', current: 'ACCEPTED' });
    expect(await traceOf(a)).toEqual(before);
    expect(await s.saga.reserve(reserveInputOf(a, 1, { leaseUntilMs: held!.leaseUntilMs }))).toEqual({ status: 'RESERVED' });
    expect(await jobOf(a.o.id)).toMatchObject({ step: 'CONFIRM', attempts: 0, lease_until: new Date(held!.leaseUntilMs!) });
    expect(await sentAtOf(a.o.id)).toBeNull();
  });

  test.each<[string, readonly TransitionId[], 'REMOVED' | 'KEPT']>([
    ['RESERVED 주문의 CONFIRM 작업(아직 그 단계)', [], 'KEPT'],
    ['APPROVED 주문의 CONFIRM 작업(단계를 지남)', ['T9'], 'REMOVED'],
    ['UNKNOWN 주문의 CONFIRM 작업(단계를 지남)', ['T12'], 'REMOVED'],
  ])('M3_abandon(%s): 지났으면 한 트랜잭션에서 결제 참조와 작업 행을 지우고(REMOVED), 아니면 아무것도 바꾸지 않는다(KEPT)', async (_label, path, want) => {
    const s = fresh();
    const a = await accepted(s);
    await reservedByHand(s, a);
    let seq = 0;
    for (const transition of path) {
      seq += 1;
      const r = await database.transaction((tx) => s.store.transition(tx, { orderId: a.o.id, transition, actor: SAGA, paymentEventSeq: seq }));
      expect(r.status, transition).toBe('APPLIED');
    }
    const held = await s.saga.claim(a.o.id, LEASE);
    const before = await traceOf(a);
    expect(await s.saga.abandon(a.o.id, 'CONFIRM', held!.leaseUntilMs)).toBe(want);
    if (want === 'KEPT') expect(await traceOf(a)).toEqual(before);
    else expect(await traceOf(a)).toEqual({ ...before, job: undefined, refs: { pg_payment_key: null, pg_tx_id: null, pg_payment_token: null } });
  });

  test('M3_abandon: 그 단계의 작업 행이 없거나(단계가 다름) 자기 임대가 아니면 GONE이고 아무것도 바꾸지 않는다', async () => {
    const s = fresh();
    const a = await accepted(s);
    const held = await s.saga.claim(a.o.id, LEASE);
    await walk(s, a.o, ['T8']);
    const before = await traceOf(a);
    expect(await s.saga.abandon(a.o.id, 'CONFIRM', held!.leaseUntilMs)).toBe('GONE');
    expect(await s.saga.abandon(a.o.id, 'RESERVE', held!.leaseUntilMs! + 1)).toBe('GONE');
    expect(await traceOf(a)).toEqual(before);
    // 맞는 단계·임대면 FAILED 주문은 RESERVE 단계를 지났다
    expect(await s.saga.abandon(a.o.id, 'RESERVE', held!.leaseUntilMs)).toBe('REMOVED');
  });

  test('M1_recordPinned(리뷰 고침 L5, PRF-167): ACCEPTED이고 seat_gen이 그대로일 때만 새 판 번호와 pinned_at을 한 UPDATE로 적고, pinned_at은 처음 값을 둔다(상태 칸·이력은 그대로)', async () => {
    const s = fresh();
    const a = await accepted(s, { seatGen: 1 });
    const pinnedAt = async () => (await admin.pool.query<{ pinned_at: Date | null }>('select pinned_at from purchase_order where id = $1', [a.o.id])).rows[0]!.pinned_at;
    expect(await s.saga.recordPinned(a.o.id, 2, 3)).toBe(false);
    expect(await pinnedAt()).toBeNull();
    expect(await s.saga.recordPinned(a.o.id, 1, 3)).toBe(true);
    expect(await orderRow(a.o.id)).toMatchObject({ status: 'ACCEPTED', seat_gen: 3, event_seq: 3 });
    const first = await pinnedAt();
    expect(first).not.toBeNull();
    // 같은 판 번호로 다시(다시 묶기 OK): 판 번호 그대로, pinned_at은 처음 값
    expect(await s.saga.recordPinned(a.o.id, 3, 3)).toBe(true);
    expect(await pinnedAt()).toEqual(first);
    await walk(s, a.o, ['T7']);
    expect(await s.saga.recordPinned(a.o.id, 3, 4)).toBe(false);
    expect((await orderRow(a.o.id))?.seat_gen).toBe(3);
    // 소문자 UUID가 아닌 주문 ID는 false, 판 번호 모양이 틀리면 RangeError
    expect(await s.saga.recordPinned('NOT-A-UUID', 1, 1)).toBe(false);
    await expect(s.saga.recordPinned(a.o.id, 0, 1)).rejects.toThrow(RangeError);
  });
});
