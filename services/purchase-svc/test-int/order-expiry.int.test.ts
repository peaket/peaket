// 결제하지 않은 주문의 만료와 안전망을 실제 PostgreSQL 18·실제 Valkey 8.1로 돈다(BUILD_ORDER PRF-172, 시험 P-T41).
// 정본: docs/features/payment.md §2 '결제하지 않은 주문 만료의 첫 구현'·§3 T5·T6, ADR-0107 결정 1·2·6, docs/data.md 0011·§5 '결제 접수'·§5.1 '주문 만료 안전망'·'만료 고리의 열린 주문 찾기',
// docs/features/seat-hold.md §2 onEnded·§5 onHoldsExpired, booking domain/ports.ts OrderExpiryStore·OrderExpiryInventory.
//
// 약속:
// - 마이그레이션은 migratePurchase, Outbox 일 파티션은 ensureOutboxPartitions다. 주문·결제 시도의 준비는 saga-db.int·order-accepts.int와 같다(주문 전이 함수 + 결제 시도 행 직접 넣기).
// - 시간대: 어댑터 시험(1~4)은 실제 지금보다 60일 앞의 가짜 시계에서 돌고, 범위를 읽는 시험은 시험마다 이틀씩 떨어진 구간을 쓴다(표를 비우지 않는다).
//   끝까지 시험(6)은 실제 지금보다 3일씩 뒤로 떨어진 시계를 시험마다 새로 쓴다. 안전망의 하루 범위에 다른 시험의 주문이 들어오지 않아 보고 값을 그대로 견줄 수 있다.
// - 만료 Lua는 Redis TIME으로 다시 가른다(pin.int.test.ts). 그래서 홀드 만료는 홀드 Hash의 exp와 만료 인덱스 점수를 지난 시각으로 고쳐 만들고 실제 ExpirySweeper를 돈다. 앱 시계만으로는 풀리지 않는다.
// - 사용자 해제는 해제 Lua(HOT-070) 전이라 해제가 지우는 홀드 Hash를 직접 지워 흉내 낸다(order-holds.int.test.ts와 같다).
// - 만료된 주문의 결제 접수 409 order-expired 응답은 accept-e2e.int.test.ts가 본다(주문이 EXPIRED면 409). 여기서는 그 응답을 만드는 접수 어댑터 결과 STALE ORDER_STATE EXPIRED를 본다.
// - 기대 값은 정본에서 시험이 따로 적는다(행위자·40분·90분은 글자 그대로. 운영 상수를 가져오지 않는다).
//
// 형이 정본보다 모자라 시험이 정한 것(구현이 형을 넓힐 때 맞춘다):
// - holdRemains의 입력 OrderHoldQuery에 좌석이 없다. 정본(payment §2 ②)은 '주문 항목의 좌석마다' 읽으므로 시험은 주문 항목 좌석 ID를 seatIds로 더해 넘긴다(holdQuery 도우미 한 곳).
// - OrderExpiryOrder에 칸이 더 생겨도 되게 주문 값은 정본에 있는 여섯 칸만 견준다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { OrderEvent } from '@peaket/contracts/asyncapi';
import { createDatabase, createHotRedis, type Database, ensureOutboxPartitions, fakeClock, type HotRedis, requestFingerprint, uuidv7 } from '@peaket/platform';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import {
  type AcceptInput,
  DrizzleOrderAccepts,
  DrizzleOrderExpiry,
  DrizzleOrderStore,
  InventoryOrderExpiry,
  type NewOrder,
  OrderExpiry,
  type OrderExpiryInput,
  type OrderExpiryOutcome,
  type OrderExpirySignals,
  type OrderExpiryStage,
  orderExpiryStaleTask,
  OrderExpirySweep,
  type OrderExpiryTrigger,
  type OrderRequestOnce,
  OrderSeatStoreUnavailable,
  type PaymentRefs,
  type TransitionId,
} from '../src/modules/booking/index.js';
import {
  EndPurchaseSession,
  ExpirySweeper,
  type HoldInput,
  type MemorySeatDef,
  MemorySeatMap,
  RedisOrderHolds,
  RedisPurchaseSessionStore,
  RedisSeatStore,
  RedisSweepLeases,
  type SessionEndedLog,
  seatKeys,
} from '../src/modules/inventory/index.js';
import { fingerprintOf } from '../test/hold-cases.js';
import { openInput } from '../test/purchase-session-cases.js';
import { accountActor, CREATED_ONLY, DAY, HOUR, laterEvent, makeItems, messagesOf, newOrderInput, rejections, SAGA } from './order-fixtures.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const MIN = 60_000;
/** 만료 전이의 행위자(system:<작업 이름>, order_event.actor) */
const EXPIRY_ACTOR = 'system:order-expiry';
const NO_OUTBOX_PARTITION = /no partition of relation "outbox" found for row/;
const APP = 'order-expiry-test';

let pgServer: PostgresContainer | undefined;
let valkey: ValkeyContainer | undefined;
let redis: HotRedis;
/** 어댑터가 쓰는 풀(동시성 시험이 연결 여럿을 쓴다) */
let database: Database;
/** 읽기·준비용 풀 */
let admin: Database;
/** 잠금을 붙잡아 두는 풀 */
let race: Database;
/** Valkey 시계 − 시험 프로세스 시계 */
let skewMs = 0;
/** 어댑터 시험의 기준 시각(실제 지금 − 60일) */
let adapterBaseMs = 0;

const liveNow = (): number => Date.now() + skewMs;
const noop = (): void => undefined;
/** 뼈대처럼 동기로 던지는 호출도 거부된 약속으로 받는다(겹침 시험의 다른 쪽을 기다릴 수 있게) */
const later = <T>(fn: () => Promise<T>): Promise<T> => Promise.resolve().then(fn);

beforeAll(async () => {
  const [p, v] = await Promise.allSettled([startPostgres(), startValkey()]);
  if (p.status === 'fulfilled') pgServer = p.value;
  if (v.status === 'fulfilled') valkey = v.value;
  for (const r of [p, v]) if (r.status === 'rejected') throw r.reason as Error;

  redis = await createHotRedis({ url: valkey!.url });
  const samples: number[] = [];
  for (let k = 0; k < 5; k += 1) {
    const before = Date.now();
    const t = (await redis.command(['TIME'], {})) as unknown[];
    samples.push(Number(t[0]) * 1000 + Math.floor(Number(t[1]) / 1000) - Math.round((before + Date.now()) / 2));
  }
  skewMs = samples.sort((a, b) => a - b)[2]!;
  adapterBaseMs = liveNow() - 60 * DAY;

  await migratePurchase(pgServer!.url);
  database = createDatabase({ url: pgServer!.url, profile: 'general', max: 20, applicationName: APP });
  admin = createDatabase({ url: pgServer!.url, profile: 'general', max: 4, applicationName: 'order-expiry-admin' });
  race = createDatabase({ url: pgServer!.url, profile: 'general', max: 4, applicationName: 'order-expiry-race' });
  await ensureOutboxPartitions(admin, fakeClock({ now: adapterBaseMs }), { daysAhead: 40 });
  await ensureOutboxPartitions(admin, fakeClock({ now: liveNow() }), { daysAhead: 40 });
  // 시험 DB에만 두는 감사 트리거(쓰기 차례·트랜잭션 번호)와, 고른 주문의 EXPIRED 쓰기를 늦추는 트리거(만료가 주문 행을 쥔 시간을 늘린다)
  await admin.pool.query(`
    create table expiry_audit (n bigserial primary key, xid bigint not null default txid_current(), tbl text not null, op text not null, row_text text);
    create or replace function expiry_audit() returns trigger language plpgsql as $$
    begin
      insert into expiry_audit (tbl, op, row_text) values (tg_table_name, tg_op, row_to_json(new)::text);
      return null;
    end $$;
    create table expiry_slow (order_id uuid primary key, ms int not null);
    create or replace function expiry_slow() returns trigger language plpgsql as $$
    declare d int;
    begin
      select ms into d from expiry_slow where order_id = new.id;
      if d is not null then perform pg_sleep(d / 1000.0); end if;
      return new;
    end $$;
    create trigger expiry_slow before update on purchase_order for each row when (new.status = 'EXPIRED') execute function expiry_slow();`);
  for (const t of ['purchase_order', 'order_event', 'payment_attempt', 'outbox']) {
    await admin.pool.query(`create trigger expiry_audit after insert or update on ${t} for each row execute function expiry_audit()`);
  }
});

afterAll(async () => {
  await Promise.allSettled([redis?.close(), database?.close(), admin?.close(), race?.close()]);
  valkey?.stop();
  pgServer?.stop();
});

// ───────────────────────────── 도우미(DB) ─────────────────────────────

const q = async <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> => (await admin.pool.query(text, params)).rows as R[];
const count = async (text: string, params: unknown[] = []): Promise<number> => Number((await q<{ n: string | number }>(text, params))[0]!.n);

/** 시험 하나의 가짜 시계·전이 함수·접수 어댑터·만료 어댑터 */
function fresh(startMs = adapterBaseMs) {
  const clock = fakeClock({ now: startMs });
  const store = new DrizzleOrderStore({ clock });
  return { clock, store, accepts: new DrizzleOrderAccepts({ database, store, clock }), expiry: new DrizzleOrderExpiry({ database, store, clock }) };
}
type Fresh = ReturnType<typeof fresh>;

let rangeWindows = 0;
/** 범위를 읽는 시험의 구간 시작(시험마다 이틀씩 떨어진다) */
const nextRange = (): number => {
  rangeWindows += 1;
  return adapterBaseMs + rangeWindows * 2 * DAY;
};

async function placed(s: Fresh, o: Partial<NewOrder> = {}): Promise<NewOrder> {
  const order = newOrderInput(s.clock, { items: makeItems(2), ...o });
  await database.transaction((tx) => s.store.createOrder(tx, order));
  return order;
}
/** 그 시각에 만든 주문(ID·created_at·이력이 모두 그 시각) */
async function placedAt(ms: number, o: Partial<NewOrder> = {}): Promise<NewOrder> {
  const clock = fakeClock({ now: ms });
  const store = new DrizzleOrderStore({ clock });
  const order = newOrderInput(clock, { items: makeItems(2), ...o });
  await database.transaction((tx) => store.createOrder(tx, order));
  return order;
}
async function walk(s: Fresh, o: NewOrder, path: readonly TransitionId[]): Promise<void> {
  for (const transition of path) {
    const r = await database.transaction((tx) => s.store.transition(tx, { orderId: o.id, transition, actor: SAGA }));
    expect(r.status, transition).toBe('APPLIED');
  }
}
/** 결제 시도 행을 직접 넣는다(결제 시도 시작은 PRF-190). ID·created_at이 모두 그 시각이다 */
async function putAttempt(orderId: string, atMs: number, status = 'READY'): Promise<string> {
  const id = uuidv7(fakeClock({ now: atMs }));
  await q('insert into payment_attempt (id, order_id, pg, pg_order_ref, status, created_at) values ($1, $2, $3, $4, $5, $6)', [id, orderId, 'TOSS', orderId, status, new Date(atMs)]);
  return id;
}

const onceOf = (o: NewOrder): OrderRequestOnce => ({
  accountRef: o.accountId,
  operation: 'ACCEPT_PAYMENT',
  key: randomUUID(),
  requestHash: requestFingerprint('POST', `/v1/orders/${o.id}/payment-acceptance`, Buffer.from(JSON.stringify({ n: randomUUID() }), 'utf8')),
});
const tossRefs = (): PaymentRefs => ({ pg: 'TOSS', paymentKey: `tgen_${randomUUID().replaceAll('-', '')}` });
const acceptOf = (o: NewOrder, attemptId: string): AcceptInput => ({ orderId: o.id, attemptId, eventId: o.eventId, refs: tossRefs(), seatGen: 1, actor: accountActor(o.accountId) });
const expireOf = (o: NewOrder, over: Partial<OrderExpiryInput> = {}): OrderExpiryInput => ({ orderId: o.id, sessionEnded: true, holdRemains: false, actor: EXPIRY_ACTOR, ...over });

const orderRow = async (id: string) => (await q<{ status: string; event_seq: number }>('select status, event_seq from purchase_order where id = $1', [id]))[0];
const attemptStatus = async (id: string) => (await q<{ status: string }>('select status from payment_attempt where id = $1', [id]))[0]?.status;
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
const sagaJobs = (orderId: string) => count('select count(*) as n from order_saga_job where order_id = $1', [orderId]);
const acceptIdems = (accountId: string) => count(`select count(*) as n from order_idempotency where account_ref = $1 and operation = 'ACCEPT_PAYMENT'`, [accountId]);
const contractIssues = (event: unknown) => OrderEvent.safeParse(event).error?.issues ?? [];

/** 아무것도 바뀌지 않았는지 볼 때의 주문 흔적 */
const traceOf = async (o: NewOrder) => ({
  order: await orderRow(o.id),
  history: (await historyOf(o.id)).length,
  outbox: (await outboxOf(o.eventId)).map((x) => x.event.type),
});

/** 그 주문의 한 전이(cause)를 쓴 트랜잭션의 행 쓰기 차례(감사 트리거). Outbox 파티션 이름은 outbox로 본다 */
async function writesOfTx(orderId: string, cause: string): Promise<string[]> {
  const rows = await q<{ tbl: string; op: string }>(
    `select tbl, op from expiry_audit
      where xid = (select xid from expiry_audit where tbl = 'order_event' and op = 'INSERT' and row_text like $1 and row_text like $2 order by n desc limit 1)
      order by n`,
    [`%"order_id":"${orderId}"%`, `%"cause":"${cause}"%`],
  );
  return rows.map((r) => `${r.op} ${r.tbl.startsWith('outbox') ? 'outbox' : r.tbl}`);
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}
const lockWaiters = () => count(`select count(*) as n from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'`, [APP]);
const sleepers = () => count(`select count(*) as n from pg_stat_activity where application_name = $1 and wait_event = 'PgSleep'`, [APP]);

/** 주문 값에서 정본에 있는 칸(OrderExpiryOrder의 여섯 칸) */
const viewOf = (o: NewOrder, status: string) => ({ orderId: o.id, accountId: o.accountId, eventId: o.eventId, purchaseSessionId: o.purchaseSessionId, holdId: o.holdId, status });

/** fn이 풀로 보낸 문장을 엿본다(드라이버 Pool.query를 잠시 감싼다. 어댑터가 execute를 쓰든 질의 만들기를 쓰든 잡힌다) */
async function capturing<T>(fn: () => Promise<T>): Promise<{ value: T; sqls: { text: string; params: unknown[] }[] }> {
  const pool = database.pool as unknown as { query: (...a: unknown[]) => unknown };
  const real = pool.query;
  const sqls: { text: string; params: unknown[] }[] = [];
  pool.query = function spy(this: unknown, ...a: unknown[]) {
    const first = a[0] as string | { text: string };
    sqls.push({ text: typeof first === 'string' ? first : first.text, params: (a[1] as unknown[] | undefined) ?? [] });
    return real.apply(this, a);
  };
  try {
    return { value: await fn(), sqls };
  } finally {
    pool.query = real;
  }
}
/** EXPLAIN(FORMAT JSON) 계획의 노드들(평평하게) */
function planNodes(plan: Record<string, unknown>): Record<string, unknown>[] {
  const kids = (plan.Plans as Record<string, unknown>[] | undefined) ?? [];
  return [plan, ...kids.flatMap(planNodes)];
}
/**
 * 운영처럼 주문 표를 크게(다른 주문 2만 건, 열 건에 하나는 열린 주문) 같은 트랜잭션에 넣고 통계를 새로 낸 뒤 그 문장들의 실행 계획을 낸다(되돌려 남기지 않는다. saga-e2e H1과 같은 꼴).
 * 지연 제약(이력 행)은 커밋 때만 보므로 되돌리는 이 트랜잭션에는 걸리지 않는다
 */
async function plansOnBigTable(sqls: readonly { text: string; params: unknown[] }[]): Promise<Record<string, unknown>[][]> {
  const client = await admin.pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into purchase_order (id, account_id, event_id, status, amount, event_seq, idempotency_key, consent_version, seat_assignment, created_at, hold_id, purchase_session_id)
       select gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), case when n % 10 = 0 then 'CREATED' else 'CONFIRMED' end, 0, 1, 'k', 'v1', 'PICK', now(), gen_random_uuid(), 'ps-' || n
         from generate_series(1, 20000) n`,
    );
    await client.query('analyze purchase_order');
    const out: Record<string, unknown>[][] = [];
    for (const s of sqls) {
      const r = await client.query<{ 'QUERY PLAN': [{ Plan: Record<string, unknown> }] }>(`explain (format json) ${s.text}`, s.params);
      out.push(planNodes(r.rows[0]!['QUERY PLAN'][0].Plan));
    }
    await client.query('rollback');
    return out;
  } finally {
    await client.query('rollback').catch(noop);
    client.release();
  }
}

/** 실행 계획에서 주문 표·인덱스를 읽는 노드들 */
const onOrders = (nodes: Record<string, unknown>[]) => nodes.filter((n) => n['Relation Name'] === 'purchase_order' || n['Index Name'] !== undefined);

// ───────────────────────────── 도우미(좌석 Redis) ─────────────────────────────

const liveSeatMap = new MemorySeatMap();
const sessionStore = () => new RedisPurchaseSessionStore(redis);
const seatStore = () => new RedisSeatStore(redis);

interface Live {
  eventId: string;
  accountId: string;
  jti: string;
  holdId: string;
  seatIds: string[];
  /** 회차의 좌석 넷(좌석 ID 오름차순, 앞 둘을 처음 홀드가 잡는다) */
  all: string[];
  refs: HoldInput['seats'];
  keepUntilMs: number;
}

/** 좌석을 실제 홀드 Lua로 잡고 그 구매 세션의 홀드 목록에 적는다(HoldSeats와 같은 차례) */
async function holdSeats(w: Pick<Live, 'eventId' | 'refs' | 'keepUntilMs'>, x: { accountId: string; jti: string; holdId: string; seatIds: string[] }): Promise<void> {
  const sorted = [...x.seatIds].sort();
  const input: HoldInput = {
    eventId: w.eventId,
    accountId: x.accountId,
    purchaseSessionId: x.jti,
    holdId: x.holdId,
    idempotencyKey: randomUUID(),
    fingerprint: fingerprintOf(sorted),
    seats: sorted.map((id) => w.refs.find((r) => r.seatId === id)!),
    limit: 4,
    keepUntilMs: w.keepUntilMs,
  };
  const r = await seatStore().hold(input);
  expect(r.kind).toBe('OK');
  expect(await sessionStore().recordHold(x.jti, x.holdId, sorted)).not.toBeNull();
}

/** 회차 하나를 열고(좌석 UUID 넷), 새 계정이 구매 세션을 연 뒤 좌석 둘을 잡은 세계. 시각이 앞선 시계라도 된다(열기·홀드 Lua는 앞날의 기한을 받는다) */
async function liveWorld(clock: { now(): number }): Promise<Live> {
  const eventId = randomUUID();
  const accountId = randomUUID();
  const jti = randomUUID();
  const all = Array.from({ length: 4 }, () => randomUUID()).sort();
  const defs: MemorySeatDef[] = all.map((seatId, i) => ({ seatId, index: i, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: i, tierId: 'R' }));
  liveSeatMap.put({ eventId, layoutVersion: 'v1', seatCount: 4, perAccountLimit: 4, saleEndsAtMs: clock.now() + DAY }, defs);
  const keepUntilMs = clock.now() + 2 * DAY;
  await seatStore().openSale({ eventId, seatCount: 4, keepUntilMs });
  expect((await sessionStore().open(openInput({ now: () => clock.now() }, jti, { accountId, eventId }))).kind).toBe('CREATED');
  const seatIds = all.slice(0, 2);
  const holdId = uuidv7(fakeClock({ now: clock.now() }));
  const w: Live = { eventId, accountId, jti, holdId, seatIds, all, refs: defs, keepUntilMs };
  await holdSeats(w, { accountId, jti, holdId, seatIds });
  return w;
}

const indexOf = (w: Live, seatId: string): number => w.refs.find((r) => r.seatId === seatId)!.index;

/** 그 좌석들의 홀드 시간을 지난 것으로 만든다(홀드 Hash exp와 만료 인덱스 점수, 만료 Lua가 Redis TIME과 견주는 두 값) */
async function lapse(w: Live, seatIds: readonly string[] = w.seatIds): Promise<void> {
  const at = liveNow() - MIN;
  for (const seatId of seatIds) {
    const hold = seatKeys.hold(w.eventId, indexOf(w, seatId));
    await redis.command(['HSET', hold, 'exp', String(at)], { key: hold });
    const expiry = seatKeys.expiry(w.eventId);
    await redis.command(['ZADD', expiry, String(at), String(indexOf(w, seatId))], { key: expiry });
  }
}
/** 사용자 해제가 지우는 홀드 Hash를 직접 지운다(해제 Lua는 HOT-070) */
async function dropHold(w: Live, seatId: string): Promise<void> {
  const hold = seatKeys.hold(w.eventId, indexOf(w, seatId));
  await redis.command(['DEL', hold], { key: hold });
}
/** 그 시계로 ExpirySweeper를 만든다(고리는 주면 잇는다) */
const sweeperOf = (clock: { now(): number; monotonicMs(): number }, onHoldsExpired?: ConstructorParameters<typeof ExpirySweeper>[0]['onHoldsExpired']) =>
  new ExpirySweeper({ expiries: seatStore(), seatMap: liveSeatMap, leases: new RedisSweepLeases(redis), clock, podId: 'pod-order-expiry', ...(onHoldsExpired ? { onHoldsExpired } : {}) });

const inventoryOf = (clock: { now(): number; monotonicMs(): number }, r: HotRedis = redis) => new InventoryOrderExpiry({ sessions: new RedisPurchaseSessionStore(r), holds: new RedisOrderHolds(r, liveSeatMap), clock });

/**
 * holdRemains의 입력. 포트의 OrderHoldQuery에는 좌석이 없지만 정본(payment §2 ②)은 '주문 항목의 좌석마다' 홀드 Hash를 읽으므로 주문 항목 좌석 ID를 seatIds로 더한다.
 * 객체를 돌려줘 넘기므로 포트 형을 넓히기 전에도 형 검사를 지난다. 구현이 다른 이름을 쓰면 이 한 곳을 고친다
 */
const holdQuery = (w: Live, over: { holdId?: string; seatIds?: readonly string[] } = {}) => ({
  eventId: w.eventId,
  purchaseSessionId: w.jti,
  accountId: w.accountId,
  holdId: over.holdId ?? w.holdId,
  seatIds: over.seatIds ?? w.seatIds,
});

// ───────────────────────────── 1. expireIfDue ─────────────────────────────

describe('DrizzleOrderExpiry.expireIfDue(주문 행 잠금 → 활성 결제 시도 → T5·T6·이력·Outbox 한 트랜잭션)', () => {
  test('PT41_ADR0107_T5: CREATED이고 세 조건이 끝났으면 EXPIRED(T5)이고 주문·이력(cause T5, 행위자 system:order-expiry)·Outbox EXPIRED를 쓴다 [ASVS v5.0.0-2.3.1] [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const o = await placed(s);
    s.clock.advance(MIN);
    const at = s.clock.now();

    expect(await s.expiry.expireIfDue(expireOf(o))).toEqual({ status: 'EXPIRED', transition: 'T5', seq: 2 });

    expect(await orderRow(o.id)).toEqual({ status: 'EXPIRED', event_seq: 2 });
    expect((await historyOf(o.id)).at(-1)).toEqual({ seq: 2, from_status: 'CREATED', to_status: 'EXPIRED', cause: 'T5', actor: EXPIRY_ACTOR, occurred_at: new Date(at) });
    const outbox = await outboxOf(o.eventId);
    expect(outbox.map((x) => x.event.type)).toEqual(['CREATED', 'EXPIRED']);
    expect(outbox[1]!.event).toMatchObject(laterEvent(o, 'EXPIRED', 2, at, false));
    for (const k of CREATED_ONLY) expect(outbox[1]!.event).not.toHaveProperty(k);
    expect(contractIssues(outbox[1]!.event)).toEqual([]);
  });

  test('PT41_ADR0107_T6: AUTHENTICATED이고 세 조건이 끝났으면 EXPIRED(T6)이고 이력은 AUTHENTICATED → EXPIRED다 [ASVS v5.0.0-2.3.1]', async () => {
    const s = fresh();
    const o = await placed(s);
    await walk(s, o, ['T3']);
    expect(await s.expiry.expireIfDue(expireOf(o))).toEqual({ status: 'EXPIRED', transition: 'T6', seq: 3 });
    expect(await orderRow(o.id)).toEqual({ status: 'EXPIRED', event_seq: 3 });
    expect((await historyOf(o.id)).at(-1)).toMatchObject({ seq: 3, from_status: 'AUTHENTICATED', to_status: 'EXPIRED', cause: 'T6', actor: EXPIRY_ACTOR });
    expect((await outboxOf(o.eventId)).map((x) => x.event.type).at(-1)).toBe('EXPIRED');
  });

  test('PT41_ADR0107_쓰기는 한 트랜잭션의 주문 행 → 이력 → Outbox 셋뿐이다(결제 시도 행을 바꾸지 않는다) [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const o = await placed(s);
    const attemptId = await putAttempt(o.id, s.clock.now());
    s.clock.advance(41 * MIN);
    expect((await s.expiry.expireIfDue(expireOf(o))).status).toBe('EXPIRED');
    expect(await writesOfTx(o.id, 'T5')).toEqual(['UPDATE purchase_order', 'INSERT order_event', 'INSERT outbox']);
    expect(await attemptStatus(attemptId)).toBe('READY');
  });

  test('PT41_ADR0107_Outbox 쓰기가 실패하면 던지고 주문·이력·Outbox가 그대로다(같은 트랜잭션) [ASVS v5.0.0-2.3.3] [ASVS v5.0.0-16.5.2]', async () => {
    const s = fresh();
    const o = await placed(s);
    const before = await traceOf(o);
    const far = fresh(adapterBaseMs + 200 * DAY);

    const err = await later(() => far.expiry.expireIfDue(expireOf(o))).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(messagesOf(err)).toMatch(NO_OUTBOX_PARTITION);
    expect(await traceOf(o)).toEqual(before);
    expect((await s.expiry.expireIfDue(expireOf(o))).status).toBe('EXPIRED');
  });

  test.each<[string, Partial<OrderExpiryInput>, string]>([
    ['세션이 남음', { sessionEnded: false, holdRemains: false }, 'SESSION'],
    ['홀드가 남음', { sessionEnded: true, holdRemains: true }, 'HOLD'],
    ['둘 다 남음(세션이 먼저)', { sessionEnded: false, holdRemains: true }, 'SESSION'],
  ])('PT41_ADR0107_%s이면 NOT_YET이고 아무것도 바뀌지 않는다 [ASVS v5.0.0-2.3.1]', async (_label, over, reason) => {
    const s = fresh();
    const o = await placed(s);
    const before = await traceOf(o);
    expect(await s.expiry.expireIfDue(expireOf(o, over))).toEqual({ status: 'NOT_YET', reason });
    expect(await traceOf(o)).toEqual(before);
  });

  test('PT41_ADR0107_READY 결제 시도가 만든 지 40분 [가정] 안이면 NOT_YET ATTEMPT이고, 만든 지 정확히 40분이면 활성이 아니라 만료한다(접수의 경계와 같다) [ASVS v5.0.0-2.3.1]', async () => {
    const s = fresh();
    const o = await placed(s);
    await putAttempt(o.id, s.clock.now());
    const before = await traceOf(o);

    expect(await s.expiry.expireIfDue(expireOf(o))).toEqual({ status: 'NOT_YET', reason: 'ATTEMPT' });
    s.clock.advance(40 * MIN - 1);
    expect(await s.expiry.expireIfDue(expireOf(o))).toEqual({ status: 'NOT_YET', reason: 'ATTEMPT' });
    expect(await traceOf(o)).toEqual(before);

    s.clock.advance(1);
    expect(await s.expiry.expireIfDue(expireOf(o))).toEqual({ status: 'EXPIRED', transition: 'T5', seq: 2 });
  });

  test.each(['SUPERSEDED', 'EXPIRED'])('PT41_ADR0107_결제 시도가 %s뿐이면 만든 지 40분 안이어도 활성이 아니다 [ASVS v5.0.0-2.3.1]', async (status) => {
    const s = fresh();
    const o = await placed(s);
    await putAttempt(o.id, s.clock.now(), status);
    expect((await s.expiry.expireIfDue(expireOf(o))).status).toBe('EXPIRED');
  });

  test.each<[string, readonly TransitionId[]]>([
    ['ACCEPTED', ['T3', 'T4']],
    ['RESERVED', ['T3', 'T4', 'T7']],
    ['FAILED', ['T3', 'T4', 'T8']],
    ['EXPIRED', ['T5']],
  ])('PT41_ADR0107_주문이 %s면 NOT_OPEN(current)이고 아무것도 쓰지 않는다 [ASVS v5.0.0-2.3.1]', async (status, path) => {
    const s = fresh();
    const o = await placed(s);
    await walk(s, o, path);
    const before = await traceOf(o);
    expect(await s.expiry.expireIfDue(expireOf(o))).toEqual({ status: 'NOT_OPEN', current: status });
    expect(await traceOf(o)).toEqual(before);
  });

  test('PT41_ADR0107_없는 주문은 current 없는 NOT_OPEN이다', async () => {
    const s = fresh();
    expect(await s.expiry.expireIfDue({ orderId: uuidv7(s.clock), sessionEnded: true, holdRemains: false, actor: EXPIRY_ACTOR })).toEqual({ status: 'NOT_OPEN' });
  });

  test('PT41_ADR0107_두 번째 부름은 NOT_OPEN EXPIRED이고 이력·Outbox EXPIRED는 하나뿐이다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const o = await placed(s);
    expect((await s.expiry.expireIfDue(expireOf(o))).status).toBe('EXPIRED');
    expect(await s.expiry.expireIfDue(expireOf(o))).toEqual({ status: 'NOT_OPEN', current: 'EXPIRED' });
    expect(await historyOf(o.id)).toHaveLength(2);
    expect((await outboxOf(o.eventId)).map((x) => x.event.type)).toEqual(['CREATED', 'EXPIRED']);
  });

  test('PT41_ADR0107_행위자 모양이 틀리면 RangeError이고 주문이 그대로다 [ASVS v5.0.0-2.2.1]', async () => {
    const s = fresh();
    const o = await placed(s);
    const before = await traceOf(o);
    await expect(later(() => s.expiry.expireIfDue(expireOf(o, { actor: 'order-expiry' })))).rejects.toThrow(RangeError);
    expect(await traceOf(o)).toEqual(before);
  });
});

// ───────────────────────────── 2. 결제 접수와 경합 ─────────────────────────────

describe('결제 접수(T3·T4)와 만료의 경합(잠금 차례 주문 행 → 결제 시도 행, data.md §5)', () => {
  test('PT41_③_접수가 주문 행을 쥔 채 결제 시도 행에서 기다리는 동안 온 만료는 주문 행에서 기다렸다가 NOT_OPEN(ACCEPTED)이고 주문은 접수대로다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const o = await placed(s);
    const attemptId = await putAttempt(o.id, s.clock.now());
    s.clock.advance(41 * MIN);
    const c = await race.pool.connect();
    let accepting: Promise<unknown> | undefined;
    let expiring: Promise<unknown> | undefined;
    let acceptDone = false;
    let expireDone = false;
    try {
      await c.query('begin');
      await c.query('select id from payment_attempt where id = $1 for update', [attemptId]);
      accepting = s.accepts.accept(onceOf(o), acceptOf(o, attemptId)).finally(() => {
        acceptDone = true;
      });
      accepting.catch(noop);
      expect(await waitFor(async () => acceptDone || (await lockWaiters()) >= 1, 5_000)).toBe(true);
      expect(acceptDone).toBe(false);
      expiring = later(() => s.expiry.expireIfDue(expireOf(o))).finally(() => {
        expireDone = true;
      });
      expiring.catch(noop);
      expect(await waitFor(async () => expireDone || (await lockWaiters()) >= 2, 5_000)).toBe(true);
      expect(expireDone).toBe(false);
      await c.query('commit');
      expect(await accepting).toEqual({ status: 'ACCEPTED' });
      expect(await expiring).toEqual({ status: 'NOT_OPEN', current: 'ACCEPTED' });
    } finally {
      await c.query('rollback').catch(noop);
      c.release();
      await accepting?.catch(noop);
      await expiring?.catch(noop);
    }
    expect(await orderRow(o.id)).toMatchObject({ status: 'ACCEPTED' });
    expect((await outboxOf(o.eventId)).map((x) => x.event.type)).toEqual(['CREATED', 'ACCEPTED']);
  });

  test('PT41_③_만료가 주문 행을 쥔 동안 온 접수는 기다렸다가 STALE ORDER_STATE EXPIRED다(409 order-expired 길, 시도 READY 그대로·멱등 기록·Saga 작업 없음) [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const o = await placed(s);
    const attemptId = await putAttempt(o.id, s.clock.now());
    s.clock.advance(41 * MIN);
    await q('insert into expiry_slow (order_id, ms) values ($1, 700)', [o.id]);
    let expireDone = false;
    let acceptDone = false;
    const expiring = later(() => s.expiry.expireIfDue(expireOf(o))).finally(() => {
      expireDone = true;
    });
    expiring.catch(noop);
    let accepting: Promise<unknown> | undefined;
    try {
      expect(await waitFor(async () => expireDone || (await sleepers()) > 0, 5_000)).toBe(true);
      expect(expireDone).toBe(false);
      accepting = s.accepts.accept(onceOf(o), acceptOf(o, attemptId)).finally(() => {
        acceptDone = true;
      });
      accepting.catch(noop);
      expect(await waitFor(async () => acceptDone || expireDone || (await lockWaiters()) > 0, 5_000)).toBe(true);
      expect(await expiring).toEqual({ status: 'EXPIRED', transition: 'T5', seq: 2 });
      expect(await accepting).toEqual({ status: 'STALE', reason: 'ORDER_STATE', current: 'EXPIRED' });
    } finally {
      await expiring.catch(noop);
      await accepting?.catch(noop);
    }
    expect(await orderRow(o.id)).toEqual({ status: 'EXPIRED', event_seq: 2 });
    expect(await attemptStatus(attemptId)).toBe('READY');
    expect(await acceptIdems(o.accountId)).toBe(0);
    expect(await sagaJobs(o.id)).toBe(0);
  });

  test('PT41_③_두 연결에서 같은 주문을 접수와 만료로 겹치면 하나만 이기고 진 쪽은 아무것도 남기지 않는다(다섯 번) [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    for (let round = 0; round < 5; round += 1) {
      const o = await placed(s);
      const attemptId = await putAttempt(o.id, s.clock.now());
      s.clock.advance(41 * MIN);
      const other = new DrizzleOrderExpiry({ database: race, store: s.store, clock: s.clock });

      const settled = await Promise.allSettled([s.accepts.accept(onceOf(o), acceptOf(o, attemptId)), later(() => other.expireIfDue(expireOf(o)))]);

      expect(rejections(settled), `${round}회`).toEqual([]);
      const accept = (settled[0] as PromiseFulfilledResult<unknown>).value;
      const expire = (settled[1] as PromiseFulfilledResult<OrderExpiryOutcome>).value;
      if (expire.status === 'EXPIRED') {
        expect(accept, `${round}회`).toEqual({ status: 'STALE', reason: 'ORDER_STATE', current: 'EXPIRED' });
        expect(await orderRow(o.id), `${round}회`).toEqual({ status: 'EXPIRED', event_seq: 2 });
        expect(await attemptStatus(attemptId), `${round}회`).toBe('READY');
        expect(await sagaJobs(o.id), `${round}회`).toBe(0);
      } else {
        expect(expire, `${round}회`).toEqual({ status: 'NOT_OPEN', current: 'ACCEPTED' });
        expect(accept, `${round}회`).toEqual({ status: 'ACCEPTED' });
        expect(await orderRow(o.id), `${round}회`).toMatchObject({ status: 'ACCEPTED' });
        expect(await attemptStatus(attemptId), `${round}회`).toBe('ACCEPTED');
        expect(await sagaJobs(o.id), `${round}회`).toBe(1);
      }
    }
  });

  test('변이 검토 PRF-172_주문 행을 쥔 쪽이 상태를 바꾸지 않고 READY 결제 시도를 더해 커밋하면 만료는 주문 행에서 기다렸다가 그 시도를 보고 NOT_YET ATTEMPT다: FOR UPDATE가 없으면 커밋 전이라 시도를 못 보고 상태만 보는 조건부 UPDATE를 지나 만료한다 (ADR0107) [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const o = await placed(s);
    const before = await traceOf(o);
    const c = await race.pool.connect();
    let expiring: Promise<OrderExpiryOutcome> | undefined;
    try {
      await c.query('begin');
      await c.query('select id from purchase_order where id = $1 for update', [o.id]);
      await c.query('insert into payment_attempt (id, order_id, pg, pg_order_ref, status, created_at) values ($1, $2, $3, $4, $5, $6)', [uuidv7(s.clock), o.id, 'TOSS', o.id, 'READY', new Date(s.clock.now())]);
      expiring = later(() => s.expiry.expireIfDue(expireOf(o)));
      expiring.catch(noop);
      expect(await waitFor(async () => (await lockWaiters()) >= 1, 5_000)).toBe(true);
      await c.query('commit');
      expect(await expiring).toEqual({ status: 'NOT_YET', reason: 'ATTEMPT' });
    } finally {
      await c.query('rollback').catch(noop);
      c.release();
      await expiring?.catch(noop);
    }
    expect(await traceOf(o)).toEqual(before);
  });
});

// ───────────────────────────── 3. 주문 찾기 ─────────────────────────────

describe('DrizzleOrderExpiry order·openOrdersOfSession·openOrdersOfHolds(data.md §5.1 만료 고리의 열린 주문 찾기)', () => {
  test('PT41_ADR0107_order는 주문 칸을 잠그지 않고 읽고, 없거나 소문자 UUID가 아니면 undefined다', async () => {
    const s = fresh();
    const o = await placed(s);
    expect(await s.expiry.order(o.id)).toEqual(expect.objectContaining(viewOf(o, 'CREATED')));
    expect(await s.expiry.order(uuidv7(s.clock))).toBeUndefined();
    expect(await s.expiry.order(o.id.toUpperCase())).toBeUndefined();
    expect(await s.expiry.order('order-1')).toBeUndefined();
  });

  test('PT41_ADR0107_openOrdersOfSession은 그 세션의 CREATED·AUTHENTICATED만 준다(접수·만료된 주문과 다른 세션의 주문은 없다), 없으면 빈 배열이다', async () => {
    const s = fresh();
    const purchaseSessionId = randomUUID();
    const open = await placed(s, { purchaseSessionId });
    const authed = await placed(s, { purchaseSessionId });
    await walk(s, authed, ['T3']);
    const accepted = await placed(s, { purchaseSessionId });
    await walk(s, accepted, ['T3', 'T4']);
    const expired = await placed(s, { purchaseSessionId });
    await walk(s, expired, ['T5']);
    await placed(s);

    const rows = await s.expiry.openOrdersOfSession(purchaseSessionId);

    expect([...rows].sort((a, b) => (a.orderId < b.orderId ? -1 : 1))).toEqual(
      [viewOf(open, 'CREATED'), viewOf(authed, 'AUTHENTICATED')].sort((a, b) => (a.orderId < b.orderId ? -1 : 1)).map((v) => expect.objectContaining(v) as unknown),
    );
    expect(await s.expiry.openOrdersOfSession(randomUUID())).toEqual([]);
  });

  test('PT41_ADR0107_리뷰 고침 M2: openOrdersOfHolds는 그 홀드들의 CREATED·AUTHENTICATED 주문만 한 문장으로 준다(접수·만료된 주문과 없는 홀드는 없다). 소문자 UUID가 아닌 holdId는 빼고, 남은 것이 없으면 DB에 가지 않는다 [ASVS v5.0.0-2.2.1]', async () => {
    const s = fresh();
    const open = await placed(s);
    const authed = await placed(s);
    await walk(s, authed, ['T3']);
    const accepted = await placed(s);
    await walk(s, accepted, ['T3', 'T4']);
    const expired = await placed(s);
    await walk(s, expired, ['T5']);
    const asc = (a: { orderId: string }, b: { orderId: string }) => (a.orderId < b.orderId ? -1 : 1);

    const got = await capturing(() => s.expiry.openOrdersOfHolds([open.holdId, authed.holdId, accepted.holdId, expired.holdId, uuidv7(s.clock), authed.holdId.toUpperCase(), 'hold-1']));

    expect(got.sqls).toHaveLength(1);
    expect([...got.value].sort(asc)).toEqual([viewOf(open, 'CREATED'), viewOf(authed, 'AUTHENTICATED')].sort(asc).map((v) => expect.objectContaining(v) as unknown));
    for (const ids of [[], ['hold-1', open.holdId.toUpperCase()]]) {
      const none = await capturing(() => s.expiry.openOrdersOfHolds(ids));
      expect(none.value).toEqual([]);
      expect(none.sqls).toEqual([]);
    }
  });

  test('PT41_ADR0107_리뷰 고침 M2: holdId 2,000개도 한 문장이다 [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const o = await placed(s);
    const ids = [o.holdId, ...Array.from({ length: 1_999 }, () => randomUUID())];
    const got = await capturing(() => s.expiry.openOrdersOfHolds(ids));
    expect(got.sqls).toHaveLength(1);
    expect(got.value.map((x) => x.orderId)).toEqual([o.id]);
  });

  test('ADR0107_리뷰 고침 M1·M2: openOrdersOfSession은 purchase_order_session_idx를 타고 openOrdersOfHolds는 purchase_order_hold_key를 탄다(운영처럼 큰 주문 표에서 EXPLAIN에 통째 읽기가 없다, data.md §5.1) [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const purchaseSessionId = randomUUID();
    const o = await placed(s, { purchaseSessionId });
    const a = await capturing(() => s.expiry.openOrdersOfSession(purchaseSessionId));
    const b = await capturing(() => s.expiry.openOrdersOfHolds([o.holdId]));
    expect(a.value).toHaveLength(1);
    expect(a.sqls).toHaveLength(1);
    expect(b.sqls).toHaveLength(1);

    const [session, hold] = await plansOnBigTable([a.sqls[0]!, b.sqls[0]!]);

    expect(session!.map((n) => n['Node Type'])).not.toContain('Seq Scan');
    expect(onOrders(session!).map((n) => n['Index Name'])).toContain('purchase_order_session_idx');
    expect(hold!.map((n) => n['Node Type'])).not.toContain('Seq Scan');
    expect(onOrders(hold!).map((n) => n['Index Name'])).toContain('purchase_order_hold_key');
  });
});

// ───────────────────────────── 4. 안전망 묶음 ─────────────────────────────

describe('DrizzleOrderExpiry.expireReadyAttempts(하루 범위, 결제 시도 행만)', () => {
  const byAttempt = (a: { attemptId: string }, b: { attemptId: string }) => (a.attemptId < b.attemptId ? -1 : 1);

  test('PT41_ADR0107_범위 [하루 전, 40분 전) 안의 READY만 EXPIRED로 바꾸고 바꾼 시도·주문을 돌려준다. 주문은 그대로이고 다시 부르면 빈 배열이다 [ASVS v5.0.0-2.3.1]', async () => {
    const now = nextRange();
    const s = fresh(now);
    const from = now - DAY;
    const before = now - 40 * MIN;
    const put = async (ms: number, status = 'READY') => {
      const o = await placedAt(ms);
      return { o, attemptId: await putAttempt(o.id, ms, status) };
    };
    const tooOld = await put(from - 1);
    const first = await put(from);
    const last = await put(before - 1);
    const tooNew = await put(before);
    const superseded = await put(from + HOUR, 'SUPERSEDED');

    const got = await s.expiry.expireReadyAttempts({ createdFromMs: from, createdBeforeMs: before, limit: 500 });

    expect([...got].sort(byAttempt)).toEqual([first, last].map((x) => ({ attemptId: x.attemptId, orderId: x.o.id })).sort(byAttempt));
    expect(await attemptStatus(first.attemptId)).toBe('EXPIRED');
    expect(await attemptStatus(last.attemptId)).toBe('EXPIRED');
    expect(await attemptStatus(tooOld.attemptId)).toBe('READY');
    expect(await attemptStatus(tooNew.attemptId)).toBe('READY');
    expect(await attemptStatus(superseded.attemptId)).toBe('SUPERSEDED');
    // 결제 시도 행만 바꾼다(주문 행을 잡지 않아 잠금 차례를 거스르지 않는다)
    expect(await orderRow(first.o.id)).toEqual({ status: 'CREATED', event_seq: 1 });
    expect(await s.expiry.expireReadyAttempts({ createdFromMs: from, createdBeforeMs: before, limit: 500 })).toEqual([]);
  });

  test('PT41_ADR0107_리뷰 고침 L4: 기본 키 범위 안이어도 created_at이 40분 [가정] 경계 뒤인 READY는 바꾸지 않는다(접수의 경계와 어긋나지 않게 만든 시각을 함께 본다), 경계와 같으면 바꾼다 [ASVS v5.0.0-2.3.1]', async () => {
    const now = nextRange();
    const s = fresh(now);
    const from = now - DAY;
    const before = now - 40 * MIN;
    /** ID는 경계 앞 시각(기본 키 범위 안)이고 created_at만 createdAtMs인 READY 행 */
    const putSkewed = async (createdAtMs: number) => {
      const o = await placedAt(before - HOUR);
      const id = uuidv7(fakeClock({ now: before - HOUR }));
      await q('insert into payment_attempt (id, order_id, pg, pg_order_ref, status, created_at) values ($1, $2, $3, $4, $5, $6)', [id, o.id, 'TOSS', o.id, 'READY', new Date(createdAtMs)]);
      return { o, attemptId: id };
    };
    const recent = await putSkewed(before + 1);
    const atBoundary = await putSkewed(before);

    const got = await s.expiry.expireReadyAttempts({ createdFromMs: from, createdBeforeMs: before, limit: 500 });

    expect(got).toEqual([{ attemptId: atBoundary.attemptId, orderId: atBoundary.o.id }]);
    expect(await attemptStatus(recent.attemptId)).toBe('READY');
    expect(await attemptStatus(atBoundary.attemptId)).toBe('EXPIRED');
  });

  test('PT41_ADR0107_limit개까지만 바꾸고 남은 것은 다음 부름이 바꾼다', async () => {
    const now = nextRange();
    const s = fresh(now);
    const range = { createdFromMs: now - DAY, createdBeforeMs: now - 40 * MIN };
    for (let i = 0; i < 5; i += 1) {
      const at = now - HOUR - i * MIN;
      const o = await placedAt(at);
      await putAttempt(o.id, at);
    }
    expect(await s.expiry.expireReadyAttempts({ ...range, limit: 3 })).toHaveLength(3);
    expect(await s.expiry.expireReadyAttempts({ ...range, limit: 3 })).toHaveLength(2);
  });

  test('PT41_ADR0107_한 번에 500건까지다: READY 501건에 limit 500이면 500건을 바꾸고 1건이 READY로 남는다(docs/data.md §5.1)', async () => {
    const now = nextRange();
    const s = fresh(now);
    const at = now - HOUR;
    const clock = fakeClock({ now: at });
    const orderIds = Array.from({ length: 501 }, () => uuidv7(clock));
    const attemptIds = Array.from({ length: 501 }, () => uuidv7(clock));
    await q(
      `with o as (insert into purchase_order (id, account_id, event_id, status, amount, event_seq, idempotency_key, consent_version, seat_assignment, created_at, hold_id, purchase_session_id)
                  select id, gen_random_uuid(), gen_random_uuid(), 'CREATED', 0, 1, 'k', 'v1', 'PICK', $2::timestamptz, gen_random_uuid(), 'ps-bulk' from unnest($1::uuid[]) as t(id) returning id),
            e as (insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at) select id, 1, null, 'CREATED', 'T1', 'system:test', $2::timestamptz from o)
       insert into payment_attempt (id, order_id, pg, pg_order_ref, status, created_at)
       select a, b, 'TOSS', b::text, 'READY', $2::timestamptz from unnest($3::uuid[], $1::uuid[]) as u(a, b)`,
      [orderIds, new Date(at), attemptIds],
    );

    const got = await s.expiry.expireReadyAttempts({ createdFromMs: now - DAY, createdBeforeMs: now - 40 * MIN, limit: 500 });

    expect(got).toHaveLength(500);
    expect(new Set(got.map((x) => x.attemptId)).size).toBe(500);
    expect(await count(`select count(*) as n from payment_attempt where id = any($1::uuid[]) and status = 'READY'`, [attemptIds])).toBe(1);
  });

  test('PT41_ADR0107_다른 연결이 잠근 행은 기다리지 않고 건너뛴다(FOR UPDATE SKIP LOCKED) [ASVS v5.0.0-15.4.1]', async () => {
    const now = nextRange();
    const s = fresh(now);
    const range = { createdFromMs: now - DAY, createdBeforeMs: now - 40 * MIN, limit: 500 };
    const a = await placedAt(now - 2 * HOUR);
    const held = await putAttempt(a.id, now - 2 * HOUR);
    const b = await placedAt(now - HOUR);
    const free = await putAttempt(b.id, now - HOUR);
    const c = await race.pool.connect();
    try {
      await c.query('begin');
      await c.query('select id from payment_attempt where id = $1 for update', [held]);
      const started = Date.now();
      expect(await s.expiry.expireReadyAttempts(range)).toEqual([{ attemptId: free, orderId: b.id }]);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await c.query('rollback').catch(noop);
      c.release();
    }
    expect(await s.expiry.expireReadyAttempts(range)).toEqual([{ attemptId: held, orderId: a.id }]);
  });

  test.each<[string, { createdFromMs: number; createdBeforeMs: number; limit: number }]>([
    ['limit 0', { createdFromMs: 1_000, createdBeforeMs: 2_000, limit: 0 }],
    ['limit 501', { createdFromMs: 1_000, createdBeforeMs: 2_000, limit: 501 }],
    ['limit 소수', { createdFromMs: 1_000, createdBeforeMs: 2_000, limit: 1.5 }],
    ['시작이 끝보다 뒤', { createdFromMs: 3_000, createdBeforeMs: 2_000, limit: 10 }],
    ['시작이 NaN', { createdFromMs: Number.NaN, createdBeforeMs: 2_000, limit: 10 }],
  ])('PT41_ADR0107_expireReadyAttempts·openOrderBatch: %s면 RangeError다 [ASVS v5.0.0-2.2.1]', async (_label, range) => {
    const s = fresh();
    await expect(later(() => s.expiry.expireReadyAttempts(range))).rejects.toThrow(RangeError);
    await expect(later(() => s.expiry.openOrderBatch(range))).rejects.toThrow(RangeError);
  });
});

describe('DrizzleOrderExpiry.openOrderBatch·staleOrderBatch(주문 안전망, 기본 키 범위)', () => {
  test('PT41_ADR0107_범위 [하루 전, 90분 전) 안의 CREATED·AUTHENTICATED를 ID 차례로 주고, 접수·만료된 주문과 범위 밖은 없다. 아무것도 바꾸지 않는다 [ASVS v5.0.0-2.3.1]', async () => {
    const now = nextRange();
    const s = fresh(now);
    const from = now - DAY;
    const before = now - 90 * MIN;
    await placedAt(from - 1);
    const first = await placedAt(from);
    const authed = await placedAt(from + MIN);
    await walk(s, authed, ['T3']);
    const accepted = await placedAt(from + 2 * MIN);
    await walk(s, accepted, ['T3', 'T4']);
    const expired = await placedAt(from + 3 * MIN);
    await walk(s, expired, ['T5']);
    const last = await placedAt(before - 1);
    await placedAt(before);

    const rows = await s.expiry.openOrderBatch({ createdFromMs: from, createdBeforeMs: before, limit: 500 });

    expect(rows).toEqual([viewOf(first, 'CREATED'), viewOf(authed, 'AUTHENTICATED'), viewOf(last, 'CREATED')].map((v) => expect.objectContaining(v) as unknown));
    expect(await orderRow(first.id)).toEqual({ status: 'CREATED', event_seq: 1 });
  });

  test('PT41_ADR0107_afterId로 다음 묶음을 잇는다(NOT_YET으로 남는 주문이 있어도 앞으로 간다) [ASVS v5.0.0-2.3.1]', async () => {
    const now = nextRange();
    const s = fresh(now);
    const range = { createdFromMs: now - DAY, createdBeforeMs: now - 90 * MIN };
    const orders: NewOrder[] = [];
    for (let i = 0; i < 5; i += 1) orders.push(await placedAt(now - 3 * HOUR + i * MIN));
    const ids = orders.map((o) => o.id);

    const page1 = await s.expiry.openOrderBatch({ ...range, limit: 2 });
    expect(page1.map((o) => o.orderId)).toEqual(ids.slice(0, 2));
    const page2 = await s.expiry.openOrderBatch({ ...range, limit: 2, afterId: page1.at(-1)!.orderId });
    expect(page2.map((o) => o.orderId)).toEqual(ids.slice(2, 4));
    const page3 = await s.expiry.openOrderBatch({ ...range, limit: 2, afterId: page2.at(-1)!.orderId });
    expect(page3.map((o) => o.orderId)).toEqual(ids.slice(4));
    expect(await s.expiry.openOrderBatch({ ...range, limit: 2, afterId: page3.at(-1)!.orderId })).toEqual([]);
    await expect(later(() => s.expiry.openOrderBatch({ ...range, limit: 2, afterId: 'not-a-uuid' }))).rejects.toThrow(RangeError);
  });

  test('PT41_ADR0107_다른 연결이 행을 잠가도 기다리지 않고 읽는다(잠그지 않는다)', async () => {
    const now = nextRange();
    const s = fresh(now);
    const o = await placedAt(now - 3 * HOUR);
    const c = await race.pool.connect();
    try {
      await c.query('begin');
      await c.query('select id from purchase_order where id = $1 for update', [o.id]);
      const started = Date.now();
      expect((await s.expiry.openOrderBatch({ createdFromMs: now - DAY, createdBeforeMs: now - 90 * MIN, limit: 500 })).map((x) => x.orderId)).toEqual([o.id]);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await c.query('rollback').catch(noop);
      c.release();
    }
  });

  test('ADR0107_리뷰 고침 M4: openOrderBatch·staleOrderBatch는 기본 키로 읽는다(운영처럼 큰 주문 표에서 EXPLAIN에 purchase_order_pkey가 있고 통째 읽기가 없다, data.md §5.1) [ASVS v5.0.0-15.4.1]', async () => {
    const now = nextRange();
    const s = fresh(now);
    const a = await capturing(() => s.expiry.openOrderBatch({ createdFromMs: now - DAY, createdBeforeMs: now - 90 * MIN, limit: 500 }));
    const b = await capturing(() => s.expiry.staleOrderBatch({ createdFromMs: now - 30 * DAY, createdBeforeMs: now - DAY, limit: 1_000 }));
    expect(a.sqls).toHaveLength(1);
    expect(b.sqls).toHaveLength(1);

    const [open, stale] = await plansOnBigTable([a.sqls[0]!, b.sqls[0]!]);

    for (const nodes of [open!, stale!]) {
      expect(nodes.map((n) => n['Node Type'])).not.toContain('Seq Scan');
      expect(onOrders(nodes).map((n) => n['Index Name'])).toContain('purchase_order_pkey');
    }
  });

  test('PT41_ADR0107_리뷰 고침 M3: staleOrderBatch의 한 묶음은 1,000건까지다(openOrderBatch는 500건 그대로). 범위·afterId가 틀리면 RangeError다 [ASVS v5.0.0-2.2.1]', async () => {
    const now = nextRange();
    const s = fresh(now);
    const range = { createdFromMs: now - 30 * DAY, createdBeforeMs: now - DAY };
    await expect(s.expiry.staleOrderBatch({ ...range, limit: 1_000 })).resolves.toBeInstanceOf(Array);
    await expect(later(() => s.expiry.staleOrderBatch({ ...range, limit: 1_001 }))).rejects.toThrow(RangeError);
    await expect(later(() => s.expiry.openOrderBatch({ ...range, limit: 1_000 }))).rejects.toThrow(RangeError);
    await expect(later(() => s.expiry.staleOrderBatch({ createdFromMs: now, createdBeforeMs: now - DAY, limit: 10 }))).rejects.toThrow(RangeError);
    await expect(later(() => s.expiry.staleOrderBatch({ ...range, limit: 10, afterId: 'not-a-uuid' }))).rejects.toThrow(RangeError);
  });
});

describe('orderExpiryStaleTask(실제 PostgreSQL, 하루 넘은 열린 주문)', () => {
  test('PT41_ADR0107_리뷰 고침 M3: 만든 지 1~30일 [가정]인 열린 주문만 다시 판정한다: 조건이 끝난 주문은 까닭 sweep으로 EXPIRED, 홀드가 남은 주문은 CREATED로 남아 게이지에 세고, 30일 넘은 주문과 하루 안의 주문은 보지 않는다 [ASVS v5.0.0-2.3.1] [ASVS v5.0.0-16.5.2]', async () => {
    // 다른 시험의 주문이 이 30일에 들어오지 않게 실제 지금보다 200일 뒤로 간다
    const now = liveNow() + 200 * DAY;
    await ensureOutboxPartitions(admin, fakeClock({ now: now - 31 * DAY }), { daysAhead: 32 });
    const s = fresh(now);
    const tooOld = await placedAt(now - 30 * DAY - 1);
    const oldest = await placedAt(now - 30 * DAY);
    const stuck = await placedAt(now - 10 * DAY);
    const youngest = await placedAt(now - DAY - 1);
    const tooNew = await placedAt(now - DAY);
    const expired: OrderExpiryTrigger[] = [];
    const gauge: number[] = [];
    const warns: object[] = [];
    const signals: OrderExpirySignals = { expired: (t) => void expired.push(t), failure: noop, openStale: (n) => void gauge.push(n) };
    const held = new Set<string>([stuck.holdId]);
    const inventory = { sessionEnded: async () => true, holdRemains: async (q: { holdId: string }) => held.has(q.holdId) };
    const check = new OrderExpiry({ store: s.expiry, inventory, signals, clock: s.clock });
    const task = orderExpiryStaleTask({ store: s.expiry, expiry: check, clock: s.clock, signals, logger: { warn: (o) => void warns.push(o) } });

    const report = await task.run();

    expect(report).toEqual({ checked: 3, expired: 2, stillOpen: 1, failed: 0 });
    expect(gauge).toEqual([1]);
    expect(warns).toHaveLength(1);
    expect(expired).toEqual(['sweep', 'sweep']);
    expect(await orderRow(oldest.id)).toEqual({ status: 'EXPIRED', event_seq: 2 });
    expect(await orderRow(youngest.id)).toEqual({ status: 'EXPIRED', event_seq: 2 });
    expect(await orderRow(stuck.id)).toEqual({ status: 'CREATED', event_seq: 1 });
    expect(await orderRow(tooOld.id)).toEqual({ status: 'CREATED', event_seq: 1 });
    expect(await orderRow(tooNew.id)).toEqual({ status: 'CREATED', event_seq: 1 });

    // 다음 날 홀드가 풀리면 끝나고 게이지는 0이다
    held.clear();
    s.clock.advance(HOUR);
    await task.run();
    expect(gauge).toEqual([1, 0]);
    expect(await orderRow(stuck.id)).toEqual({ status: 'EXPIRED', event_seq: 2 });
  });
});

// ───────────────────────────── 5. InventoryOrderExpiry ─────────────────────────────

describe('InventoryOrderExpiry(실제 Valkey)', () => {
  test('PT41_ADR0107_sessionEnded: 세션이 열렸으면 거짓, 최대 체류 시각 1ms 전까지 거짓이고 그 시각부터 참이다(키가 남아 있어도), 끝낸 세션·없는 세션은 참이다 [ASVS v5.0.0-2.3.1]', async () => {
    const clock = fakeClock({ now: liveNow() });
    const w = await liveWorld(clock);
    const inventory = inventoryOf(clock);

    expect(await inventory.sessionEnded(w.jti)).toBe(false);
    const max = (await sessionStore().read(w.jti))!.maxStayUntilMs;
    clock.advance(max - 1 - clock.now());
    expect(await inventory.sessionEnded(w.jti)).toBe(false);
    clock.advance(1);
    expect(await inventory.sessionEnded(w.jti)).toBe(true);

    const other = await liveWorld(clock);
    expect(await inventory.sessionEnded(other.jti)).toBe(false);
    expect(await sessionStore().end(other.jti)).not.toBeNull();
    expect(await inventory.sessionEnded(other.jti)).toBe(true);
    expect(await inventory.sessionEnded(randomUUID())).toBe(true);
  });

  test('PT41_ADR0107_holdRemains: 살아 있는 홀드면 참이고, 구매 세션을 끝낸 뒤에도 홀드가 살아 있으면 참이다(세션의 홀드 목록을 보지 않는다). 읽기만 한다 [ASVS v5.0.0-2.3.1]', async () => {
    const clock = fakeClock({ now: liveNow() });
    const w = await liveWorld(clock);
    const inventory = inventoryOf(clock);
    expect(await inventory.holdRemains(holdQuery(w))).toBe(true);

    const hash = seatKeys.hold(w.eventId, indexOf(w, w.seatIds[0]!));
    const before = await redis.command(['HGETALL', hash], { key: hash });
    expect(await sessionStore().end(w.jti)).not.toBeNull();

    expect(await inventory.holdRemains(holdQuery(w))).toBe(true);
    expect(await redis.command(['HGETALL', hash], { key: hash })).toEqual(before);
  });

  test('PT41_ADR0107_holdRemains: 만료 Lua가 풀면 거짓이다(실제 ExpirySweeper 틱) [ASVS v5.0.0-2.3.1]', async () => {
    const clock = fakeClock({ now: liveNow() });
    const w = await liveWorld(clock);
    const inventory = inventoryOf(clock);
    await lapse(w);
    // 시간이 지났어도 아직 풀리지 않은 동안은 정본이 정하지 않아 보지 않는다. 풀린 뒤만 본다
    const t = await sweeperOf(clock).tick();
    expect(t.events.find((x) => x.eventId === w.eventId)).toMatchObject({ released: 2 });

    expect(await inventory.holdRemains(holdQuery(w))).toBe(false);
  });

  test('PT41_ADR0107_holdRemains: 한 좌석이라도 그 홀드가 남았으면 참이고, 모두 풀리면(해제가 지우는 Hash를 지움) 거짓이다 [ASVS v5.0.0-2.3.1]', async () => {
    const clock = fakeClock({ now: liveNow() });
    const w = await liveWorld(clock);
    const inventory = inventoryOf(clock);
    await dropHold(w, w.seatIds[0]!);
    expect(await inventory.holdRemains(holdQuery(w))).toBe(true);
    await dropHold(w, w.seatIds[1]!);
    expect(await inventory.holdRemains(holdQuery(w))).toBe(false);
  });

  test('PT41_ADR0107_holdRemains: 그 좌석이 다른 holdId의 홀드로 잡혀 있으면 거짓이다(풀린 뒤 다른 계정이 다시 잡음, 없는 holdId로 물어도 거짓) [ASVS v5.0.0-2.3.1]', async () => {
    const clock = fakeClock({ now: liveNow() });
    const w = await liveWorld(clock);
    const inventory = inventoryOf(clock);
    expect(await inventory.holdRemains(holdQuery(w, { holdId: uuidv7(clock) }))).toBe(false);

    await lapse(w);
    await sweeperOf(clock).tick();
    const accountId = randomUUID();
    const jti = randomUUID();
    expect((await sessionStore().open(openInput({ now: () => clock.now() }, jti, { accountId, eventId: w.eventId }))).kind).toBe('CREATED');
    const holdId = uuidv7(clock);
    await holdSeats(w, { accountId, jti, holdId, seatIds: w.seatIds });

    expect(await inventory.holdRemains(holdQuery(w))).toBe(false);
    expect(await inventory.holdRemains(holdQuery(w, { holdId }))).toBe(true);
  });

  test('PT41_ADR0107_holdRemains: 좌석맵 판에 없어 색인을 모르는 좌석이 있으면 참(아직)이다(안전망이 다시 본다) [ASVS v5.0.0-16.5.2]', async () => {
    const clock = fakeClock({ now: liveNow() });
    const w = await liveWorld(clock);
    const inventory = inventoryOf(clock);
    await dropHold(w, w.seatIds[0]!);
    await dropHold(w, w.seatIds[1]!);
    expect(await inventory.holdRemains(holdQuery(w, { seatIds: [...w.seatIds, randomUUID()] }))).toBe(true);
  });

  test('PT41_ADR0107_좌석 Redis 일시 장애는 끝났다·풀렸다로 보지 않고 OrderSeatStoreUnavailable로 던진다 [ASVS v5.0.0-16.5.2]', async () => {
    const clock = fakeClock({ now: liveNow() });
    const w = await liveWorld(clock);
    const down = () => Promise.reject(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    const failing = { command: down, sendCommand: down, evalScript: down, close: () => Promise.resolve() } as unknown as HotRedis;
    const inventory = inventoryOf(clock, failing);
    await expect(later(() => inventory.sessionEnded(w.jti))).rejects.toBeInstanceOf(OrderSeatStoreUnavailable);
    await expect(later(() => inventory.holdRemains(holdQuery(w)))).rejects.toBeInstanceOf(OrderSeatStoreUnavailable);
  });
});

// ───────────────────────────── 6. P-T41 끝까지 ─────────────────────────────

interface Assembled {
  clock: ReturnType<typeof fakeClock>;
  orders: DrizzleOrderStore;
  accepts: DrizzleOrderAccepts;
  /** 저장소의 expireIfDue 결과를 차례로 적는다(결과를 돌려주지 않는 고리가 끝났는지 본다) */
  outcomes: { orderId: string; outcome: OrderExpiryOutcome }[];
  /** 안전망이 부른 check */
  checks: [string, OrderExpiryTrigger][];
  expired: OrderExpiryTrigger[];
  failures: OrderExpiryStage[];
  expiry: OrderExpiry;
  sweep: OrderExpirySweep;
  end: EndPurchaseSession;
  sweeper: ExpirySweeper;
}

const assembled: Assembled[] = [];
let liveDays = 0;

/** 끝까지 시험의 조립(시작 파일이 잇는 모양과 같다). hooks가 거짓이면 세션 종료·홀드 만료 고리를 잇지 않는다(사건 유실) */
function assemble(o: { hooks?: boolean } = {}): Assembled {
  const hooks = o.hooks ?? true;
  liveDays += 1;
  const clock = fakeClock({ now: liveNow() + liveDays * 3 * DAY });
  const orders = new DrizzleOrderStore({ clock });
  const store = new DrizzleOrderExpiry({ database, store: orders, clock });
  const outcomes: Assembled['outcomes'] = [];
  const expired: OrderExpiryTrigger[] = [];
  const failures: OrderExpiryStage[] = [];
  const signals: OrderExpirySignals = { expired: (t) => void expired.push(t), failure: (s) => void failures.push(s), openStale: noop };
  const logger = { warn: noop };
  /** 고리·안전망이 부른 판정의 결과를 모은다(세션·홀드가 아직이면 트랜잭션을 열지 않으므로 저장소가 아니라 판정 자리에서 본다, 리뷰 고침 L3) */
  class RecordingExpiry extends OrderExpiry {
    override async check(orderId: string, trigger: OrderExpiryTrigger): Promise<OrderExpiryOutcome> {
      const outcome = await super.check(orderId, trigger);
      outcomes.push({ orderId, outcome });
      return outcome;
    }
  }
  const expiry = new RecordingExpiry({ store, inventory: inventoryOf(clock), signals, logger, clock });
  const checks: Assembled['checks'] = [];
  const sweep = new OrderExpirySweep({
    store,
    expiry: {
      check: (id, trigger) => {
        checks.push([id, trigger]);
        return expiry.check(id, trigger);
      },
    },
    leader: { isLeader: () => true },
    clock,
    signals,
    logger,
  });
  const ended: SessionEndedLog = { appendEnded: () => Promise.resolve() };
  const end = new EndPurchaseSession({ store: sessionStore(), ended, clock, ...(hooks ? { onEnded: (e) => expiry.onSessionEnded(e) } : {}) });
  const sweeper = sweeperOf(clock, hooks ? (e) => expiry.onHoldsExpired(e) : undefined);
  const a: Assembled = { clock, orders, accepts: new DrizzleOrderAccepts({ database, store: orders, clock }), outcomes, checks, expired, failures, expiry, sweep, end, sweeper };
  assembled.push(a);
  return a;
}

afterEach(async () => {
  for (const a of assembled.splice(0)) {
    try {
      await a.expiry.stop();
    } catch {
      // 뼈대(미구현)에서는 stop도 던진다
    }
  }
});

/** 구매 세션·홀드·주문(T1)까지 만든 세계 */
async function placedLive(a: Assembled): Promise<{ w: Live; o: NewOrder }> {
  const w = await liveWorld(a.clock);
  const o = newOrderInput(a.clock, {
    eventId: w.eventId,
    accountId: w.accountId,
    holdId: w.holdId,
    purchaseSessionId: w.jti,
    items: w.seatIds.map((seatId) => ({ seatId, tierId: 'R', sectionId: 'SEC-A', unitPrice: 99_000 })),
  });
  await database.transaction((tx) => a.orders.createOrder(tx, o));
  return { w, o };
}
const advanceTo = (a: Assembled, ms: number): void => a.clock.advance(ms - a.clock.now());
/** 그 주문의 n번째 판정(check) 결과(고리는 기다리지 않으므로 생길 때까지 기다린다) */
async function outcomeOf(a: Assembled, orderId: string, nth: number): Promise<OrderExpiryOutcome> {
  const mine = () => a.outcomes.filter((x) => x.orderId === orderId);
  expect(await waitFor(() => mine().length >= nth, 3_000), `주문의 ${nth}번째 만료 판정이 오지 않았다`).toBe(true);
  return mine()[nth - 1]!.outcome;
}
async function expectExpired(a: Assembled, o: NewOrder, at: number): Promise<void> {
  expect(await orderRow(o.id)).toEqual({ status: 'EXPIRED', event_seq: 2 });
  expect((await historyOf(o.id)).at(-1)).toEqual({ seq: 2, from_status: 'CREATED', to_status: 'EXPIRED', cause: 'T5', actor: EXPIRY_ACTOR, occurred_at: new Date(at) });
  const outbox = await outboxOf(o.eventId);
  expect(outbox.map((x) => x.event.type)).toEqual(['CREATED', 'EXPIRED']);
  expect(outbox[1]!.event).toMatchObject(laterEvent(o, 'EXPIRED', 2, at, false));
  expect(contractIssues(outbox[1]!.event)).toEqual([]);
  // 결제사로 가는 Saga 작업이 없다(과금 0건)
  expect(await sagaJobs(o.id)).toBe(0);
  expect(a.failures).toEqual([]);
}

describe('P-T41 결제하지 않은 티켓 주문의 만료(끝까지)', () => {
  test('PT41_①_결제창을 닫고 떠남: 세션을 끝내면 NOT_YET HOLD, 홀드가 풀리면 NOT_YET ATTEMPT이고, 결제 시도가 40분 [가정] 지나 안전망이 EXPIRED로 바꾸면 그 주문을 만료한다(EXPIRED 사건, Saga 없음). 만료 뒤 늦은 접수는 STALE EXPIRED다(409 order-expired 길) [ASVS v5.0.0-2.3.1] [ASVS v5.0.0-2.3.3]', async () => {
    const a = assemble();
    const { w, o } = await placedLive(a);
    const t0 = a.clock.now();
    const attemptId = await putAttempt(o.id, t0);

    expect(await a.end.execute({ sessionId: w.jti, reason: 'LEFT' })).toBe(true);
    expect(await outcomeOf(a, o.id, 1)).toEqual({ status: 'NOT_YET', reason: 'HOLD' });

    await lapse(w);
    a.clock.advance(8 * MIN);
    await a.sweeper.tick();
    expect(await outcomeOf(a, o.id, 2)).toEqual({ status: 'NOT_YET', reason: 'ATTEMPT' });
    expect(await orderRow(o.id)).toEqual({ status: 'CREATED', event_seq: 1 });

    advanceTo(a, t0 + 40 * MIN - 1_000);
    expect(await a.sweep.tick()).toMatchObject({ attemptsExpired: 0, checked: 0, expired: 0, failed: 0 });
    expect(await attemptStatus(attemptId)).toBe('READY');

    advanceTo(a, t0 + 40 * MIN + 1);
    const at = a.clock.now();
    expect(await a.sweep.tick()).toMatchObject({ attemptsExpired: 1, checked: 1, expired: 1, failed: 0 });

    expect(a.checks).toEqual([[o.id, 'attempt']]);
    expect(a.expired).toEqual(['attempt']);
    expect(await attemptStatus(attemptId)).toBe('EXPIRED');
    await expectExpired(a, o, at);
    expect(await a.accepts.accept(onceOf(o), acceptOf(o, attemptId))).toEqual({ status: 'STALE', reason: 'ORDER_STATE', current: 'EXPIRED' });
  });

  test.each<[string, 'session' | 'hold']>([
    ['세션이 먼저 끝나고 홀드가 뒤에 풀림', 'hold'],
    ['홀드가 먼저 풀리고 세션이 뒤에 끝남', 'session'],
  ])('PT41_②_결제 시도를 만들지 않고 떠남(%s): 뒤 사건이 온 때 EXPIRED이고 까닭은 그 사건이다 [ASVS v5.0.0-2.3.1]', async (_label, last) => {
    const a = assemble();
    const { w, o } = await placedLive(a);

    if (last === 'hold') {
      expect(await a.end.execute({ sessionId: w.jti, reason: 'LEFT' })).toBe(true);
      expect(await outcomeOf(a, o.id, 1)).toEqual({ status: 'NOT_YET', reason: 'HOLD' });
      await lapse(w);
      await a.sweeper.tick();
    } else {
      await lapse(w);
      await a.sweeper.tick();
      expect(await outcomeOf(a, o.id, 1)).toEqual({ status: 'NOT_YET', reason: 'SESSION' });
      expect(await a.end.execute({ sessionId: w.jti, reason: 'LEFT' })).toBe(true);
    }

    expect(await outcomeOf(a, o.id, 2)).toMatchObject({ status: 'EXPIRED', transition: 'T5' });
    expect(a.expired).toEqual([last]);
    await expectExpired(a, o, a.clock.now());
  });

  test('PT41_③_결제 시도 만료 직전에 접수하면 접수가 이기고 만료하지 않는다: 40분이 지나 안전망이 돌아도 주문은 ACCEPTED 그대로이고 check는 NOT_OPEN(ACCEPTED)이다 [ASVS v5.0.0-2.3.1] [ASVS v5.0.0-2.3.3]', async () => {
    const a = assemble();
    const { w, o } = await placedLive(a);
    const t0 = a.clock.now();
    const attemptId = await putAttempt(o.id, t0);
    expect(await a.end.execute({ sessionId: w.jti, reason: 'LEFT' })).toBe(true);
    await outcomeOf(a, o.id, 1);
    await lapse(w);
    await a.sweeper.tick();
    await outcomeOf(a, o.id, 2);

    advanceTo(a, t0 + 40 * MIN - 1_000);
    expect(await a.accepts.accept(onceOf(o), acceptOf(o, attemptId))).toEqual({ status: 'ACCEPTED' });

    advanceTo(a, t0 + 40 * MIN + 1);
    expect(await a.sweep.tick()).toMatchObject({ attemptsExpired: 0, expired: 0, failed: 0 });
    expect(await a.expiry.check(o.id, 'attempt')).toEqual({ status: 'NOT_OPEN', current: 'ACCEPTED' });

    expect(await orderRow(o.id)).toMatchObject({ status: 'ACCEPTED' });
    expect(await attemptStatus(attemptId)).toBe('ACCEPTED');
    expect(a.expired).toEqual([]);
  });

  test('PT41_④_사건이 빠지면(세션 종료·홀드 만료 고리를 잇지 않음) 89분에는 끝내지 않고, 만든 지 90분 [가정]이 지나면 안전망이 EXPIRED로 끝낸다(까닭 sweep) [ASVS v5.0.0-2.3.1] [ASVS v5.0.0-16.5.2]', async () => {
    const a = assemble({ hooks: false });
    const { w, o } = await placedLive(a);
    const t0 = a.clock.now();
    expect(await a.end.execute({ sessionId: w.jti, reason: 'LEFT' })).toBe(true);
    await lapse(w);
    await a.sweeper.tick();
    expect(await orderRow(o.id)).toEqual({ status: 'CREATED', event_seq: 1 });
    expect(a.outcomes).toEqual([]);

    advanceTo(a, t0 + 89 * MIN);
    expect(await a.sweep.tick()).toMatchObject({ checked: 0, expired: 0, failed: 0 });
    expect(await orderRow(o.id)).toEqual({ status: 'CREATED', event_seq: 1 });

    advanceTo(a, t0 + 90 * MIN + 1);
    const at = a.clock.now();
    expect(await a.sweep.tick()).toMatchObject({ checked: 1, expired: 1, failed: 0 });

    expect(a.checks).toEqual([[o.id, 'sweep']]);
    expect(a.expired).toEqual(['sweep']);
    await expectExpired(a, o, at);
  });

  test('PT41_④_안전망도 세 조건을 그대로 본다: 90분이 지나 세션은 최대 체류로 끝났어도 홀드가 남았으면 NOT_YET HOLD로 두고, 홀드가 풀린 다음 틱에 만료한다 [ASVS v5.0.0-2.3.1]', async () => {
    const a = assemble({ hooks: false });
    const { w, o } = await placedLive(a);
    const t0 = a.clock.now();

    advanceTo(a, t0 + 91 * MIN);
    expect(await a.sweep.tick()).toMatchObject({ checked: 1, expired: 0, failed: 0 });
    expect(await outcomeOf(a, o.id, 1)).toEqual({ status: 'NOT_YET', reason: 'HOLD' });
    expect(await orderRow(o.id)).toEqual({ status: 'CREATED', event_seq: 1 });

    await lapse(w);
    await a.sweeper.tick();
    a.clock.advance(10 * MIN);
    const at = a.clock.now();
    expect(await a.sweep.tick()).toMatchObject({ checked: 1, expired: 1, failed: 0 });
    expect(a.expired).toEqual(['sweep']);
    await expectExpired(a, o, at);
  });
});
