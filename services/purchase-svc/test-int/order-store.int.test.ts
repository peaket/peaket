// 주문 저장소(booking 모듈 DrizzleOrderStore·checkOrderHistory)의 통합 시험: 실제 PostgreSQL 18 컨테이너 하나를 파일 전체가 나눠 쓴다(BUILD_ORDER PRF-160).
// 정본: docs/features/payment.md §3 전이 표와 '주문 저장소의 첫 구현', docs/data.md §2 ERD(purchase_order·order_item·order_event·order_idempotency·payment_attempt),
// §4 '주문 표 마이그레이션(PRF-160)', §5 '주문 상태 전이', §5.1 '매일 주문 상태·이력 검사', ADR-0113 결정 2, ADR-0114 결정 1(외래 키에 연쇄 삭제 없음).
//
// 약속:
// - 마이그레이션은 scripts/migrate.mjs의 migratePurchase, Outbox 일 파티션은 @peaket/platform의 ensureOutboxPartitions(기준 시각의 가짜 시계)로 만든다.
// - 시험마다 새 주문·새 회차 ID를 쓰고 표를 비우지 않는다. 시각은 시험마다 따로 만든 가짜 시계다(같이 쓰는 시계를 밀지 않는다).
// - DB 상태는 저장소를 거치지 않고 admin 풀의 직접 SQL로 읽는다(저장소가 자기 상태를 스스로 증명하지 않게).
// - 기대 값(전이 표, 사건 종류, eventKey 식)은 order-fixtures.ts에 정본에서 따로 적었다. 운영 코드의 표·함수를 기대 값으로 쓰지 않는다.
// - 매일 검사 시험은 기준 시각 다음 날의 한 시간 칸을 하나씩, 이웃 칸을 비워 둔 채 쓴다(다른 시험의 이력이 그 칸에 없다).
// - 이 파일에는 주문을 일부러 어긋나게 만드는 SQL(purchase_order의 status를 바꾸는 UPDATE 포함)이 있다.
//   CI 검사(test/order-status-sql.test.ts)는 서비스의 src·scripts·migrations만 훑고 시험 폴더는 훑지 않는다.
// - purchase_order에는 지연 제약 트리거 order_status_has_event가 있다(커밋 때 그 상태·번호의 이력 행이 없으면 23514).
//   이력 없이 주문 행을 직접 넣거나 바꾸는 준비 SQL은 rawNoHistory로 그 트랜잭션에서만 트리거를 끈다(session_replication_role = replica, 시험 연결은 슈퍼유저).
//   그 트랜잭션에서는 외래 키 검사도 꺼지므로 외래 키를 보는 자식 행(order_item·order_event)은 따로 넣는다.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { OrderEvent } from '@peaket/contracts/asyncapi';
import {
  createDatabase,
  type Database,
  type DbTransaction,
  ensureOutboxPartitions,
  fakeClock,
  IdempotencyStore,
  ProblemError,
  requestFingerprint,
  uuidv7,
  uuidv7Time,
} from '@peaket/platform';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import {
  checkOrderHistory,
  DrizzleOrderStore,
  type NewOrder,
  type OrderHistoryMismatch,
  type OrderStatus,
  type SeatAssignment,
  type TransitionId,
  type TransitionInput,
  type TransitionResult,
} from '../src/modules/booking/index.js';
import {
  accountActor,
  adminActor,
  BASE_MS,
  CREATED_ONLY,
  createdEvent,
  DAY,
  HOUR,
  laterEvent,
  makeItems,
  messagesOf,
  newOrderInput,
  orderEventKeyOf,
  PATH_TO,
  PAYMENT_RESULT,
  pgCodesOf,
  rejections,
  rowOf,
  SAGA,
  STAGE,
  STATUSES,
  TABLE,
  toOf,
  TRADE_ORDERS,
  untouchableTx,
} from './order-fixtures.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let server: PostgresContainer;
/** 저장소가 쓰는 풀(general, 연결 20개: 동시성 시험이 16개를 한꺼번에 쓴다) */
let database: Database;
/** 읽기·준비용 풀. 저장소가 쓰는 풀과 따로 둬서 읽기가 저장소의 연결을 뺏지 않는다 */
let admin: Database;
/** 행 잠금 경합 시험용 풀. pg_stat_activity에서 이 이름으로 잠금을 기다리는 연결을 찾는다 */
let race: Database;
const RACE_APP = 'order-store-race';

beforeAll(async () => {
  server = await startPostgres();
  await migratePurchase(server.url);
  database = createDatabase({ url: server.url, profile: 'general', max: 20, applicationName: 'order-store-test' });
  admin = createDatabase({ url: server.url, profile: 'general', max: 4, applicationName: 'order-store-admin' });
  race = createDatabase({ url: server.url, profile: 'general', max: 4, applicationName: RACE_APP });
  // 기준 날(한국 시각)부터 7일 [가정] 앞까지의 Outbox 일 파티션. 매일 검사 시험의 다음 날 칸도 여기 든다
  await ensureOutboxPartitions(admin, fakeClock({ now: BASE_MS }));
});

afterAll(async () => {
  await Promise.allSettled([database?.close(), admin?.close(), race?.close()]);
  server?.stop();
});

// ───────────────────────────── 도우미 ─────────────────────────────

const q = async <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> => (await admin.pool.query(text, params)).rows as R[];
const count = async (text: string, params: unknown[] = []): Promise<number> => Number((await q<{ n: string | number }>(text, params))[0]!.n);

/**
 * 이력 없이 주문 행을 넣거나 바꾸는 준비 SQL. 그 트랜잭션에서만 트리거(상태 이력 지연 제약)를 끈다(SET LOCAL session_replication_role = replica).
 * 문장이 실패하면 되돌리고 그 PostgreSQL 오류(code·table·constraint)를 그대로 던진다
 */
async function rawNoHistory<R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> {
  const c = await admin.pool.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    const r = await c.query(text, params);
    await c.query('commit');
    return r.rows as R[];
  } catch (err) {
    await c.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/** 시험 하나의 가짜 시계와 저장소 */
function fresh(startMs = BASE_MS) {
  const clock = fakeClock({ now: startMs });
  return { clock, store: new DrizzleOrderStore({ clock }) };
}
type Fresh = ReturnType<typeof fresh>;

const create = (s: Fresh, o: NewOrder, db: Database = database) => db.transaction((tx) => s.store.createOrder(tx, o));
const transit = (s: Fresh, input: TransitionInput, db: Database = database) => db.transaction((tx) => s.store.transition(tx, input));

type Applied = Extract<TransitionResult, { status: 'APPLIED' }>;
function applied(r: TransitionResult, label?: string): Applied {
  expect(r, label).toMatchObject({ status: 'APPLIED' });
  return r as Applied;
}

/** 전이 입력. 결제 결과 전이면 순번을 싣는다 */
const step = (orderId: string, transition: TransitionId, actor: string, paymentEventSeq?: number): TransitionInput =>
  paymentEventSeq === undefined ? { orderId, transition, actor } : { orderId, transition, actor, paymentEventSeq };

/** path의 전이를 차례로 한다(전이마다 시계를 1초 민다). 결제 결과 전이에는 1부터 늘어나는 순번을 준다. 마지막으로 준 순번을 돌려준다 */
async function drive(s: Fresh, o: NewOrder, path: readonly TransitionId[], actor = SAGA): Promise<number> {
  let paymentSeq = 0;
  for (const t of path) {
    applied(await transit(s, step(o.id, t, actor, PAYMENT_RESULT.has(t) ? ++paymentSeq : undefined)), `준비 단계 ${t}`);
    s.clock.advance(1000);
  }
  return paymentSeq;
}

/** 주문을 만들고(그 뒤 시계 1초) path를 지나게 한다 */
async function placed(s: Fresh, path: readonly TransitionId[] = [], o: Partial<NewOrder> = {}): Promise<{ o: NewOrder; paymentSeq: number }> {
  const order = newOrderInput(s.clock, o);
  await create(s, order);
  s.clock.advance(1000);
  return { o: order, paymentSeq: await drive(s, order, path) };
}

interface OrderDbRow {
  id: string;
  account_id: string;
  event_id: string;
  status: string;
  amount: number;
  event_seq: number;
  /** bigint라 글로 온다 */
  payment_event_seq: string;
  buyer_name: string | null;
  buyer_phone: string | null;
  idempotency_key: string;
  consent_version: string;
  seat_assignment: string;
  created_at: Date;
  /** 마이그레이션 0004(PRF-161) */
  hold_id: string;
  purchase_session_id: string;
}
interface HistoryRow {
  seq: number;
  from_status: string | null;
  to_status: string;
  cause: string;
  actor: string;
  occurred_at: Date;
}
interface OutboxRow {
  id: string;
  seq: string;
  topic: string;
  msg_key: string;
  sent_at: Date | null;
  /** payload(UTF-8 JSON)를 푼 값 */
  event: Record<string, unknown>;
}

const orderRowOf = async (id: string): Promise<OrderDbRow | undefined> =>
  (
    await q<OrderDbRow>(
      `select id, account_id, event_id, status, amount, event_seq, payment_event_seq, buyer_name, buyer_phone, idempotency_key, consent_version, seat_assignment, created_at,
              hold_id, purchase_session_id
         from purchase_order where id = $1`,
      [id],
    )
  )[0];
const itemRowsOf = (id: string) =>
  q<{ line_no: number; seat_id: string; tier: string; section_id: string; unit_price: number; ticket_id: string | null }>(
    'select line_no, seat_id, tier, section_id, unit_price, ticket_id from order_item where order_id = $1 order by line_no',
    [id],
  );
const historyOf = (id: string) => q<HistoryRow>('select seq, from_status, to_status, cause, actor, occurred_at from order_event where order_id = $1 order by seq', [id]);
/**
 * 그 회차(Kafka 키)의 Outbox 행을 seq 차례로. 시험마다 회차가 새것이라 그 주문의 사건만 나온다.
 * 정렬은 표의 bigint 칸(outbox.seq)으로 한다(글로 바꾼 별칭 seq로 정렬하면 '100' < '99'가 된다)
 */
async function outboxOf(eventId: string): Promise<OutboxRow[]> {
  const rows = await q<Omit<OutboxRow, 'event'> & { payload: Buffer }>('select id, seq::text as seq, topic, msg_key, payload, sent_at from outbox where msg_key = $1 order by outbox.seq', [eventId]);
  return rows.map(({ payload, ...r }) => ({ ...r, event: JSON.parse(Buffer.from(payload).toString('utf8')) as Record<string, unknown> }));
}
/** 한 주문의 모든 흔적(주문 행, 항목, 이력, Outbox). 아무것도 안 바뀌었는지 견줄 때 쓴다 */
const traceOf = async (o: NewOrder) => ({ order: await orderRowOf(o.id), items: await itemRowsOf(o.id), history: await historyOf(o.id), outbox: await outboxOf(o.eventId) });

/** 계약(packages/contracts OrderEvent Zod)에 맞지 않는 곳. 맞으면 빈 배열 */
const contractIssues = (event: unknown) => OrderEvent.safeParse(event).error?.issues ?? [];

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > end) return false;
    await sleep(25);
  }
}

/** 풀에 쉬는 연결을 n개 미리 만든다(연결 맺기가 몰려 대기 한도를 넘는 우연한 실패를 없앤다). 429면 다시 한다 */
async function warm(db: Database, n: number): Promise<void> {
  const held: { release(): void }[] = [];
  try {
    for (let i = 0; i < n; i += 1) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          held.push(await db.pool.connect());
          break;
        } catch (err) {
          if (!(err instanceof ProblemError && err.status === 429) || attempt >= 20) throw err;
          await sleep(50);
        }
      }
    }
  } finally {
    for (const c of held) c.release();
  }
}

/**
 * 행 잠금 경합: 첫 트랜잭션이 전이를 마친 뒤(주문 행 쓰기 잠금을 쥔 채) 멈춘 동안 둘째 트랜잭션이 같은 주문에 전이를 보낸다.
 * 둘째가 잠금을 기다리는 것을 pg_stat_activity로 확인한 뒤 첫째를 커밋시킨다(data.md §5 '주문 상태 전이': 뒤 쪽은 줄을 서고 커밋 뒤 조건을 다시 본다)
 */
async function gatedRace(s: Fresh, first: TransitionInput, second: TransitionInput): Promise<{ r1: TransitionResult; r2: TransitionResult; waited: boolean }> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let markHeld!: () => void;
  const held = new Promise<void>((r) => (markHeld = r));
  const firstTx = race.transaction(async (tx) => {
    const r = await s.store.transition(tx, first);
    markHeld();
    await gate;
    return r;
  });
  let secondTx: Promise<TransitionResult> | undefined;
  let waited = false;
  try {
    await Promise.race([
      held,
      firstTx.then(() => {
        throw new Error('첫 트랜잭션이 멈추지 않고 끝났다');
      }),
    ]);
    secondTx = race.transaction((tx) => s.store.transition(tx, second));
    waited = await waitFor(
      async () => (await count(`select count(*) as n from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'`, [RACE_APP])) >= 1,
      5000,
    );
  } finally {
    release();
    await Promise.allSettled([firstTx, secondTx ?? Promise.resolve()]);
  }
  // 여기 오면 try 안에서 던지지 않았으니 secondTx가 있다
  const [r1, r2] = await Promise.all([firstTx, secondTx!]);
  return { r1, r2, waited };
}

/** 마이그레이션 시험용으로 주문 행을 직접 넣는다(INSERT는 전이 함수 검사 대상이 아니다. 이력 없이 넣으므로 rawNoHistory로). 넣은 값을 돌려준다 */
async function insertRawOrder(o: Partial<Record<string, unknown>> = {}) {
  const row: Record<string, unknown> = {
    id: uuidv7(fakeClock({ now: BASE_MS })),
    account_id: randomUUID(),
    event_id: randomUUID(),
    status: 'CREATED',
    amount: 1000,
    event_seq: 1,
    payment_event_seq: 0,
    buyer_name: '김피켓',
    buyer_phone: '01012345678',
    idempotency_key: randomUUID(),
    consent_version: 'v1',
    seat_assignment: 'PICK',
    created_at: new Date(BASE_MS),
    // 마이그레이션 0004(PRF-161)가 더한 NOT NULL 칸. 주문마다 새 홀드(hold_id 유일)와 구매 세션
    hold_id: randomUUID(),
    purchase_session_id: randomUUID(),
    ...o,
  };
  const cols = Object.keys(row);
  await rawNoHistory(`insert into purchase_order (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map((c) => row[c]));
  return row as { id: string } & Record<string, unknown>;
}
const insertRawItem = (orderId: string, lineNo: number, unitPrice = 1000) =>
  q(`insert into order_item (order_id, line_no, seat_id, tier, section_id, unit_price) values ($1, $2, $3, 'R', 'SEC-A', $4)`, [orderId, lineNo, randomUUID(), unitPrice]);
const insertRawEvent = (orderId: string, seq: number) =>
  q(`insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at) values ($1, $2, null, 'CREATED', 'T1', $3, $4)`, [orderId, seq, SAGA, new Date(BASE_MS)]);
const insertRawAttempt = (orderId: string, status: string, pg = 'TOSS') =>
  q(`insert into payment_attempt (id, order_id, pg, pg_order_ref, status, created_at) values ($1, $2, $3, $4, $5, $6)`, [
    uuidv7(fakeClock({ now: BASE_MS })),
    orderId,
    pg,
    `ord_${randomUUID().slice(0, 8)}`,
    status,
    new Date(BASE_MS),
  ]);

/** 칸 이름 → 형·널 허용 */
async function columnsOf(table: string): Promise<Record<string, { type: string; nullable: boolean }>> {
  const rows = await q<{ column_name: string; data_type: string; is_nullable: string }>(
    `select column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`,
    [table],
  );
  return Object.fromEntries(rows.map((r) => [r.column_name, { type: r.data_type, nullable: r.is_nullable === 'YES' }]));
}

/** 23502(NOT NULL) 또는 23514(CHECK). 널을 어느 쪽으로 막든 막기만 하면 된다 */
const NULL_REJECTED = /^(23502|23514)$/;

// ───────────────────────────── 마이그레이션 ─────────────────────────────

describe('마이그레이션: 표·칸·키·제약', () => {
  const TABLES = ['order_event', 'order_idempotency', 'order_item', 'outbox', 'payment_attempt', 'purchase_order'];

  test('표 여섯이 있고 purchase_order·order_item·order_event·order_idempotency·payment_attempt는 나누지 않은 표이며(ADR-0114) outbox만 ID 범위 파티션 부모다 [ASVS v5.0.0-2.3.3]', async () => {
    const kinds = await q<{ relname: string; relkind: string }>(
      `select relname, relkind from pg_class where relnamespace = 'public'::regnamespace and relname = any($1) and relkind in ('r', 'p') order by relname`,
      [TABLES],
    );
    expect(kinds).toEqual([
      { relname: 'order_event', relkind: 'r' },
      { relname: 'order_idempotency', relkind: 'r' },
      { relname: 'order_item', relkind: 'r' },
      { relname: 'outbox', relkind: 'p' },
      { relname: 'payment_attempt', relkind: 'r' },
      { relname: 'purchase_order', relkind: 'r' },
    ]);
    const parts = await q<{ relname: string; keydef: string }>(
      `select c.relname, pg_get_partkeydef(pt.partrelid) as keydef from pg_partitioned_table pt join pg_class c on c.oid = pt.partrelid where c.relname = any($1)`,
      [TABLES],
    );
    expect(parts).toEqual([{ relname: 'outbox', keydef: 'RANGE (id)' }]);
  });

  test('purchase_order의 칸과 형이 ERD와 같다: payment_event_seq는 bigint NOT NULL, 예매자 성명·번호는 탈퇴 보존 때 비우므로 널 허용 [ASVS v5.0.0-2.2.1]', async () => {
    expect(await columnsOf('purchase_order')).toMatchObject({
      id: { type: 'uuid', nullable: false },
      account_id: { type: 'uuid' },
      event_id: { type: 'uuid' },
      status: { type: 'text' },
      amount: { type: 'integer' },
      event_seq: { type: 'integer' },
      payment_event_seq: { type: 'bigint', nullable: false },
      buyer_name: { type: 'text', nullable: true },
      buyer_phone: { type: 'text', nullable: true },
      idempotency_key: { type: 'text' },
      consent_version: { type: 'text' },
      seat_assignment: { type: 'text' },
      created_at: { type: 'timestamp with time zone' },
      // 마이그레이션 0004(PRF-161): 주문을 만든 홀드(uuid)와 구매 세션(입장 토큰 jti, text). 둘 다 NOT NULL
      hold_id: { type: 'uuid', nullable: false },
      purchase_session_id: { type: 'text', nullable: false },
    });
  });

  test('order_item·order_event·payment_attempt의 칸과 형이 ERD와 같다(order_item.tier는 등급 ID 글, ticket_id는 발권 뒤 채워 널 허용, order_event.from_status는 첫 행이 비어 널 허용) [ASVS v5.0.0-2.2.1]', async () => {
    expect(await columnsOf('order_item')).toMatchObject({
      order_id: { type: 'uuid', nullable: false },
      line_no: { type: 'integer', nullable: false },
      seat_id: { type: 'uuid' },
      tier: { type: 'text' },
      section_id: { type: 'text' },
      unit_price: { type: 'integer' },
      ticket_id: { type: 'uuid', nullable: true },
    });
    expect(await columnsOf('order_event')).toMatchObject({
      order_id: { type: 'uuid', nullable: false },
      seq: { type: 'integer', nullable: false },
      from_status: { type: 'text', nullable: true },
      to_status: { type: 'text' },
      cause: { type: 'text' },
      actor: { type: 'text' },
      occurred_at: { type: 'timestamp with time zone' },
    });
    expect(await columnsOf('payment_attempt')).toMatchObject({
      id: { type: 'uuid', nullable: false },
      order_id: { type: 'uuid' },
      pg: { type: 'text' },
      pg_order_ref: { type: 'text' },
      status: { type: 'text' },
      created_at: { type: 'timestamp with time zone' },
    });
  });

  test('order_idempotency는 platform idempotencyRecordTable 꼴, outbox는 platform 템플릿 0002_outbox.sql 꼴 그대로다 [ASVS v5.0.0-2.3.3]', async () => {
    expect(await columnsOf('order_idempotency')).toEqual({
      account_ref: { type: 'text', nullable: false },
      operation: { type: 'text', nullable: false },
      idempotency_key: { type: 'uuid', nullable: false },
      request_hash: { type: 'bytea', nullable: false },
      result_ref: { type: 'text', nullable: true },
      created_at: { type: 'timestamp with time zone', nullable: false },
    });
    expect(await columnsOf('outbox')).toEqual({
      id: { type: 'uuid', nullable: false },
      seq: { type: 'bigint', nullable: false },
      topic: { type: 'text', nullable: false },
      msg_key: { type: 'text', nullable: false },
      payload: { type: 'bytea', nullable: false },
      headers: { type: 'jsonb', nullable: false },
      sent_at: { type: 'timestamp with time zone', nullable: true },
    });
  });

  test('기본 키: purchase_order (id), order_item (order_id, line_no), order_event (order_id, seq), order_idempotency (account_ref, operation, idempotency_key), payment_attempt (id), outbox (id) [ASVS v5.0.0-2.3.4]', async () => {
    const r = await q<{ tbl: string; def: string }>(
      `select conrelid::regclass::text as tbl, pg_get_constraintdef(oid) as def from pg_constraint where contype = 'p' and conrelid::regclass::text = any($1) order by 1`,
      [TABLES],
    );
    expect(r).toEqual([
      { tbl: 'order_event', def: 'PRIMARY KEY (order_id, seq)' },
      { tbl: 'order_idempotency', def: 'PRIMARY KEY (account_ref, operation, idempotency_key)' },
      { tbl: 'order_item', def: 'PRIMARY KEY (order_id, line_no)' },
      { tbl: 'outbox', def: 'PRIMARY KEY (id)' },
      { tbl: 'payment_attempt', def: 'PRIMARY KEY (id)' },
      { tbl: 'purchase_order', def: 'PRIMARY KEY (id)' },
    ]);
  });

  test('order_event (order_id, seq)·order_item (order_id, line_no)이 같은 행을 또 넣으면 23505다 [ASVS v5.0.0-2.3.4]', async () => {
    const o = await insertRawOrder();
    await insertRawEvent(o.id, 1);
    await expect(insertRawEvent(o.id, 1)).rejects.toMatchObject({ code: '23505', table: 'order_event' });
    await insertRawEvent(o.id, 2);
    await insertRawItem(o.id, 1);
    await expect(insertRawItem(o.id, 1)).rejects.toMatchObject({ code: '23505', table: 'order_item' });
    expect(await count('select count(*) as n from order_event where order_id = $1', [o.id])).toBe(2);
    expect(await count('select count(*) as n from order_item where order_id = $1', [o.id])).toBe(1);
  });

  test('order_item·order_event는 purchase_order(id)에 외래 키를 걸고 연쇄 삭제가 없다(ADR-0114 결정 1): 없는 주문의 자식 행은 23503, 자식이 있는 주문을 지우면 23503, 자식부터 지우면 지워진다 [ASVS v5.0.0-2.3.3]', async () => {
    const fks = await q<{ tbl: string; def: string }>(
      `select conrelid::regclass::text as tbl, pg_get_constraintdef(oid) as def from pg_constraint where contype = 'f' and conrelid::regclass::text in ('order_item', 'order_event') order by 1`,
    );
    expect(fks.map((x) => x.tbl)).toEqual(['order_event', 'order_item']);
    for (const fk of fks) {
      expect(fk.def, fk.tbl).toMatch(/^FOREIGN KEY \(order_id\) REFERENCES (public\.)?purchase_order\(id\)/);
      expect(fk.def, fk.tbl).not.toMatch(/CASCADE|SET NULL|SET DEFAULT/);
    }

    const ghost = randomUUID();
    await expect(insertRawItem(ghost, 1)).rejects.toMatchObject({ code: '23503', table: 'order_item' });
    await expect(insertRawEvent(ghost, 1)).rejects.toMatchObject({ code: '23503', table: 'order_event' });

    const parent = await insertRawOrder();
    await insertRawItem(parent.id, 1);
    await insertRawEvent(parent.id, 1);
    await expect(q('delete from purchase_order where id = $1', [parent.id])).rejects.toMatchObject({ code: '23503' });
    expect(await count('select count(*) as n from purchase_order where id = $1', [parent.id])).toBe(1);
    // 보존 삭제의 순서(자식부터)
    await q('delete from order_item where order_id = $1', [parent.id]);
    await q('delete from order_event where order_id = $1', [parent.id]);
    await q('delete from purchase_order where id = $1', [parent.id]);
    expect(await count('select count(*) as n from purchase_order where id = $1', [parent.id])).toBe(0);
  });

  test('purchase_order의 인덱스는 기본 키, 0004의 hold_id 유일 인덱스(purchase_order_hold_key), 0011의 구매 세션 인덱스(purchase_order_session_idx) 셋뿐이다(쓰기가 많은 표라 그 밖의 인덱스를 두지 않는다, data.md §4·§5.1, payment §2 같은 홀드의 두 주문) [ASVS v5.0.0-2.3.4]', async () => {
    const r = await q<{ primary: boolean; unique: boolean; name: string; def: string }>(
      `select i.indisprimary as primary, i.indisunique as unique, c.relname as name, pg_get_indexdef(i.indexrelid) as def
         from pg_index i join pg_class c on c.oid = i.indexrelid where i.indrelid = 'purchase_order'::regclass order by i.indisprimary desc, c.relname`,
    );
    expect(r).toHaveLength(3);
    expect(r[0]).toMatchObject({ primary: true });
    expect(r[0]!.def).toMatch(/USING btree \(id\)$/);
    expect(r[1]).toMatchObject({ primary: false, unique: true, name: 'purchase_order_hold_key' });
    // 부분 인덱스가 아니다(모든 주문이 홀드 하나에 묶인다)
    expect(r[1]!.def).toMatch(/^CREATE UNIQUE INDEX purchase_order_hold_key ON (public\.)?purchase_order USING btree \(hold_id\)$/);
    // 조건 없는 인덱스다(모양은 purchase-migration.int.test.ts의 0011 시험이 본다)
    expect(r[2]).toMatchObject({ primary: false, unique: false, name: 'purchase_order_session_idx' });
  });

  test('0004: 같은 hold_id로 주문 행을 또 넣으면 23505(purchase_order_hold_key)이고, hold_id·purchase_session_id에 널을 넣으면 거절된다 [ASVS v5.0.0-2.3.4]', async () => {
    const first = await insertRawOrder();
    await expect(insertRawOrder({ hold_id: first.hold_id })).rejects.toMatchObject({ code: '23505', table: 'purchase_order', constraint: 'purchase_order_hold_key' });
    expect(await count('select count(*) as n from purchase_order where hold_id = $1', [first.hold_id])).toBe(1);
    for (const column of ['hold_id', 'purchase_session_id']) {
      const err = await insertRawOrder({ [column]: null }).catch((e: unknown) => e);
      expect((err as { code?: string }).code, column).toMatch(NULL_REJECTED);
    }
  });

  test('order_event의 인덱스는 기본 키와 occurred_at의 BRIN 인덱스 둘이다(매일 검사가 전날 이력을 찾는다, data.md §5.1) [ASVS v5.0.0-2.3.3]', async () => {
    const r = await q<{ am: string; primary: boolean; def: string }>(
      `select am.amname as am, i.indisprimary as primary, pg_get_indexdef(i.indexrelid) as def
         from pg_index i join pg_class c on c.oid = i.indexrelid join pg_am am on am.oid = c.relam
        where i.indrelid = 'order_event'::regclass order by am.amname`,
    );
    expect(r.map((x) => [x.am, x.primary])).toEqual([
      ['brin', false],
      ['btree', true],
    ]);
    expect(r[0]!.def).toMatch(/ON (public\.)?order_event USING brin \(occurred_at\)/);
    // pg_indexes에서도 보인다
    const named = await q<{ indexdef: string }>(`select indexdef from pg_indexes where schemaname = 'public' and tablename = 'order_event' and indexdef like '%USING brin%'`);
    expect(named).toHaveLength(1);
  });

  test.each(STATUSES)("purchase_order.status에 '%s'는 들어간다(열세 값) [ASVS v5.0.0-2.2.1]", async (status) => {
    const o = await insertRawOrder({ status });
    expect(await orderRowOf(o.id)).toMatchObject({ status });
  });

  test.each(['created', 'PAID', 'DEPOSIT_REVERSED', 'ISSUE_DELAYED', 'EVENT_CANCELLATION_CONFIRMED', 'COMPENSATION_PAID', 'CANCELED', ''])(
    "purchase_order.status에 '%s'는 check 위반(23514)이다(사건 이름은 저장 값이 아니다) [ASVS v5.0.0-2.2.1]",
    async (status) => {
      const id = uuidv7(fakeClock({ now: BASE_MS }));
      await expect(insertRawOrder({ id, status })).rejects.toMatchObject({ code: '23514', table: 'purchase_order' });
      expect(await orderRowOf(id)).toBeUndefined();
    },
  );

  test.each(['PICK', 'AUTO'])("purchase_order.seat_assignment에 '%s'는 들어간다 [ASVS v5.0.0-2.2.1]", async (seatAssignment) => {
    const o = await insertRawOrder({ seat_assignment: seatAssignment });
    expect(await orderRowOf(o.id)).toMatchObject({ seat_assignment: seatAssignment });
  });

  test.each(['pick', 'MANUAL', 'Auto', ''])("purchase_order.seat_assignment에 '%s'는 check 위반(23514)이다 [ASVS v5.0.0-2.2.1]", async (seatAssignment) => {
    await expect(insertRawOrder({ seat_assignment: seatAssignment })).rejects.toMatchObject({ code: '23514', table: 'purchase_order' });
  });

  test.each<[string, Record<string, unknown>]>([
    ['amount 음수', { amount: -1 }],
    ['event_seq 0', { event_seq: 0 }],
    ['event_seq 음수', { event_seq: -1 }],
    ['payment_event_seq 음수', { payment_event_seq: -1 }],
  ])('purchase_order에서 %s는 check 위반(23514)이다 [ASVS v5.0.0-2.3.2]', async (_label, change) => {
    await expect(insertRawOrder(change)).rejects.toMatchObject({ code: '23514', table: 'purchase_order' });
  });

  test('purchase_order 경계값: amount 0·event_seq 1·payment_event_seq 0은 들어가고, payment_event_seq를 주지 않으면 0이다(NOT NULL DEFAULT 0) [ASVS v5.0.0-2.3.2]', async () => {
    const o = await insertRawOrder({ amount: 0 });
    expect(await orderRowOf(o.id)).toMatchObject({ amount: 0, event_seq: 1, payment_event_seq: '0' });
    const id = uuidv7(fakeClock({ now: BASE_MS }));
    await rawNoHistory(
      `insert into purchase_order (id, account_id, event_id, status, amount, event_seq, buyer_name, buyer_phone, idempotency_key, consent_version, seat_assignment, created_at, hold_id, purchase_session_id)
       values ($1, $2, $3, 'CREATED', 1000, 1, '김피켓', '01012345678', $4, 'v1', 'AUTO', $5, $6, $7)`,
      [id, randomUUID(), randomUUID(), randomUUID(), new Date(BASE_MS), randomUUID(), randomUUID()],
    );
    expect(await orderRowOf(id)).toMatchObject({ payment_event_seq: '0' });
  });

  // 정본 모호: status·seat_assignment는 '이 값만'(CHECK)이라 널도 막는다고 읽는다. amount(서버 계산 필수 값)·event_seq(이력 번호 카운터)는
  // 널 허용 여부가 적혀 있지 않지만, 비면 전이 UPDATE의 event_seq + 1과 사건 amount가 깨지므로 막는다고 가정한다(NOT NULL이든 CHECK든)
  test.each(['status', 'seat_assignment', 'amount', 'event_seq', 'payment_event_seq'])('purchase_order.%s에 널을 넣으면 거절된다(23502 또는 23514) [ASVS v5.0.0-2.2.1]', async (column) => {
    const err = await insertRawOrder({ [column]: null }).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toMatch(NULL_REJECTED);
  });

  test('order_item.unit_price는 0 이상이다: -1은 23514, 0은 들어간다 [ASVS v5.0.0-2.3.2]', async () => {
    const o = await insertRawOrder();
    await expect(insertRawItem(o.id, 1, -1)).rejects.toMatchObject({ code: '23514', table: 'order_item' });
    await insertRawItem(o.id, 1, 0);
    expect(await itemRowsOf(o.id)).toMatchObject([{ line_no: 1, unit_price: 0, ticket_id: null }]);
  });

  const putEvent = (orderId: string, seq: number, from: string | null, to: string) =>
    q(`insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at) values ($1, $2, $3, $4, 'T1', $5, $6)`, [orderId, seq, from, to, SAGA, new Date(BASE_MS)]);

  test.each(['PAID', 'created', '', 'DEPOSIT_REVERSED'])("order_event.to_status·from_status에 '%s'(열세 값 밖)는 check 위반(23514)이다 [ASVS v5.0.0-2.2.1]", async (bad) => {
    const o = await insertRawOrder();
    await expect(putEvent(o.id, 1, null, bad)).rejects.toMatchObject({ code: '23514', table: 'order_event', constraint: 'order_event_to_status_check' });
    await expect(putEvent(o.id, 1, bad, 'CREATED')).rejects.toMatchObject({ code: '23514', table: 'order_event', constraint: 'order_event_from_status_check' });
    expect(await count('select count(*) as n from order_event where order_id = $1', [o.id])).toBe(0);
  });

  test.each([0, -1])('order_event.seq %i는 check 위반(23514, order_event_seq_check)이다(번호는 1부터) [ASVS v5.0.0-2.3.2]', async (seq) => {
    const o = await insertRawOrder();
    await expect(insertRawEvent(o.id, seq)).rejects.toMatchObject({ code: '23514', table: 'order_event', constraint: 'order_event_seq_check' });
    await insertRawEvent(o.id, 1);
    expect(await count('select count(*) as n from order_event where order_id = $1', [o.id])).toBe(1);
  });

  test('order_item: 같은 주문에 같은 좌석을 두 줄로 넣으면 23505(order_item_seat_key)이고, 다른 주문의 같은 좌석은 들어간다 [ASVS v5.0.0-2.3.4]', async () => {
    const o = await insertRawOrder();
    const other = await insertRawOrder();
    const seat = randomUUID();
    const put = (orderId: string, lineNo: number) =>
      q(`insert into order_item (order_id, line_no, seat_id, tier, section_id, unit_price) values ($1, $2, $3, 'R', 'SEC-A', 1000)`, [orderId, lineNo, seat]);
    await put(o.id, 1);
    await expect(put(o.id, 2)).rejects.toMatchObject({ code: '23505', table: 'order_item', constraint: 'order_item_seat_key' });
    await put(other.id, 1);
    expect(await count('select count(*) as n from order_item where seat_id = $1', [seat])).toBe(2);
  });

  test('order_event의 BRIN 인덱스는 autosummarize = on이다(새로 찬 블록 범위를 저절로 요약해 전날 이력 찾기가 넓게 훑지 않는다) [ASVS v5.0.0-2.3.3]', async () => {
    const r = await q<{ reloptions: string[] | null }>(`select reloptions from pg_class where relname = 'order_event_occurred_at_brin'`);
    expect(r).toHaveLength(1);
    expect(r[0]!.reloptions).toContain('autosummarize=on');
  });

  test('purchase_order에 상태 이력 지연 제약 트리거(order_status_has_event)가 있다: INSERT·UPDATE OF status, event_seq, DEFERRABLE INITIALLY DEFERRED, 행마다 [ASVS v5.0.0-2.3.3]', async () => {
    const r = await q<{ def: string; deferrable: boolean; deferred: boolean; constraint: boolean }>(
      `select pg_get_triggerdef(t.oid) as def, t.tgdeferrable as deferrable, t.tginitdeferred as deferred, t.tgconstraint <> 0 as constraint
         from pg_trigger t where t.tgrelid = 'purchase_order'::regclass and not t.tgisinternal`,
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ deferrable: true, deferred: true, constraint: true });
    expect(r[0]!.def).toMatch(/^CREATE CONSTRAINT TRIGGER order_status_has_event AFTER INSERT OR UPDATE OF status, event_seq ON (public\.)?purchase_order DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION order_status_has_event\(\)$/);
  });

  test.each(['TOSS', 'PORTONE', 'SIMULATOR'])("payment_attempt.pg에 '%s'는 들어간다 [ASVS v5.0.0-2.2.1]", async (pgName) => {
    const o = await insertRawOrder();
    await insertRawAttempt(o.id, 'READY', pgName);
    expect(await count('select count(*) as n from payment_attempt where order_id = $1 and pg = $2', [o.id, pgName])).toBe(1);
  });

  test.each(['toss', 'KAKAO', 'NICE', ''])("payment_attempt.pg에 '%s'는 check 위반(23514)이다 [ASVS v5.0.0-2.2.1]", async (pgName) => {
    const o = await insertRawOrder();
    await expect(insertRawAttempt(o.id, 'READY', pgName)).rejects.toMatchObject({ code: '23514', table: 'payment_attempt' });
  });

  test.each(['READY', 'ACCEPTED', 'SUPERSEDED', 'EXPIRED'])("payment_attempt.status에 '%s'는 들어간다 [ASVS v5.0.0-2.2.1]", async (status) => {
    const o = await insertRawOrder();
    await insertRawAttempt(o.id, status);
    expect(await count('select count(*) as n from payment_attempt where order_id = $1 and status = $2', [o.id, status])).toBe(1);
  });

  test.each(['ready', 'FAILED', 'APPROVED', 'CANCELED', ''])("payment_attempt.status에 '%s'는 check 위반(23514)이다 [ASVS v5.0.0-2.2.1]", async (status) => {
    const o = await insertRawOrder();
    await expect(insertRawAttempt(o.id, status)).rejects.toMatchObject({ code: '23514', table: 'payment_attempt' });
  });

  test('payment_attempt에는 활성(READY·ACCEPTED) 시도 유일 부분 인덱스 UNIQUE (order_id) WHERE status IN (READY, ACCEPTED)가 하나 있다 [ASVS v5.0.0-2.3.4]', async () => {
    const r = await q<{ def: string; pred: string | null }>(
      `select pg_get_indexdef(i.indexrelid) as def, pg_get_expr(i.indpred, i.indrelid) as pred
         from pg_index i where i.indrelid = 'payment_attempt'::regclass and i.indisunique and not i.indisprimary`,
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.def).toMatch(/^CREATE UNIQUE INDEX \S+ ON (public\.)?payment_attempt USING btree \(order_id\) WHERE /);
    const pred = r[0]!.pred ?? '';
    expect(pred).toContain("'READY'");
    expect(pred).toContain("'ACCEPTED'");
    expect(pred).not.toContain('SUPERSEDED');
    expect(pred).not.toContain('EXPIRED');
  });

  test.each<[string, string]>([
    ['READY', 'READY'],
    ['READY', 'ACCEPTED'],
    ['ACCEPTED', 'READY'],
    ['ACCEPTED', 'ACCEPTED'],
  ])('같은 주문에 활성 시도 %s가 있으면 %s를 또 넣지 못한다(23505) [ASVS v5.0.0-2.3.4]', async (first, second) => {
    const o = await insertRawOrder();
    await insertRawAttempt(o.id, first);
    await expect(insertRawAttempt(o.id, second)).rejects.toMatchObject({ code: '23505', table: 'payment_attempt' });
    expect(await count('select count(*) as n from payment_attempt where order_id = $1', [o.id])).toBe(1);
  });

  test('끝난 시도(SUPERSEDED·EXPIRED)는 몇 개든 쌓이고 그 위에 활성 시도는 하나만 얹힌다. 이미 READY가 있으면 SUPERSEDED를 READY로 되살리지 못하며, 다른 주문은 따로 센다 [ASVS v5.0.0-2.3.4]', async () => {
    const o = await insertRawOrder();
    await insertRawAttempt(o.id, 'SUPERSEDED');
    await insertRawAttempt(o.id, 'SUPERSEDED');
    await insertRawAttempt(o.id, 'EXPIRED');
    await insertRawAttempt(o.id, 'READY');
    expect(await count('select count(*) as n from payment_attempt where order_id = $1', [o.id])).toBe(4);
    await expect(q(`update payment_attempt set status = 'READY' where order_id = $1 and status = 'SUPERSEDED'`, [o.id])).rejects.toMatchObject({ code: '23505' });
    // 이전 시도를 대체하면(READY → SUPERSEDED) 새 READY가 들어간다(T2, payment §2.2)
    await q(`update payment_attempt set status = 'SUPERSEDED' where order_id = $1 and status = 'READY'`, [o.id]);
    await insertRawAttempt(o.id, 'READY');
    expect(await count(`select count(*) as n from payment_attempt where order_id = $1 and status = 'READY'`, [o.id])).toBe(1);
    const other = await insertRawOrder();
    await insertRawAttempt(other.id, 'READY');
    expect(await count(`select count(*) as n from payment_attempt where order_id = $1 and status = 'READY'`, [other.id])).toBe(1);
  });

  test.each(['CREATE_ORDER', 'START_PAYMENT', 'ACCEPT_PAYMENT'])("order_idempotency.operation에 '%s'는 들어간다(주문 생성·결제 시도 시작·결제 접수) [ASVS v5.0.0-2.3.3]", async (operation) => {
    const account = randomUUID();
    await q(`insert into order_idempotency (account_ref, operation, idempotency_key, request_hash, result_ref, created_at) values ($1, $2, $3, $4, null, $5)`, [
      account,
      operation,
      randomUUID(),
      Buffer.alloc(32, 1),
      new Date(BASE_MS),
    ]);
    expect(await count('select count(*) as n from order_idempotency where account_ref = $1 and operation = $2', [account, operation])).toBe(1);
  });

  test.each(['CANCEL_ORDER', 'CREATE_NOTE', 'create_order', ''])("order_idempotency.operation에 '%s'는 check 위반(23514)이다 [ASVS v5.0.0-2.3.3]", async (operation) => {
    await expect(
      q(`insert into order_idempotency (account_ref, operation, idempotency_key, request_hash, result_ref, created_at) values ($1, $2, $3, $4, null, $5)`, [
        randomUUID(),
        operation,
        randomUUID(),
        Buffer.alloc(32, 1),
        new Date(BASE_MS),
      ]),
    ).rejects.toMatchObject({ code: '23514', table: 'order_idempotency' });
  });
});

// ───────────────────────────── createOrder ─────────────────────────────

describe('createOrder', () => {
  // 정본 모호: purchase_order.created_at을 무엇으로 채우는지 적혀 있지 않다. 시간 의존 값은 주입한 시계로 쓴다는 규칙대로 가짜 시계의 시각이라고 가정한다
  test('한 트랜잭션에 주문 행(CREATED, event_seq 1, payment_event_seq 0)·항목(받은 차례로 줄 번호 1부터)·이력 번호 1(출발 비움, T1, 행위자, 시계 시각)·Outbox CREATED 사건 하나를 쓴다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const o = newOrderInput(s.clock);
    const at = s.clock.now();

    const created = await create(s, o);

    const t = await traceOf(o);
    expect(t.order).toEqual({
      id: o.id,
      account_id: o.accountId,
      event_id: o.eventId,
      status: 'CREATED',
      amount: o.amount,
      event_seq: 1,
      payment_event_seq: '0',
      buyer_name: o.buyerName,
      buyer_phone: o.buyerPhone,
      idempotency_key: o.idempotencyKey,
      consent_version: o.consentVersion,
      seat_assignment: 'PICK',
      created_at: new Date(at),
      // 0004(PRF-161): NewOrder.holdId·purchaseSessionId를 그대로 쓴다
      hold_id: o.holdId,
      purchase_session_id: o.purchaseSessionId,
    });
    expect(t.items).toEqual(o.items.map((it, i) => ({ line_no: i + 1, seat_id: it.seatId, tier: it.tierId, section_id: it.sectionId, unit_price: it.unitPrice, ticket_id: null })));
    expect(t.history).toEqual([{ seq: 1, from_status: null, to_status: 'CREATED', cause: 'T1', actor: o.actor, occurred_at: new Date(at) }]);
    expect(t.outbox).toHaveLength(1);
    const row = t.outbox[0]!;
    expect(created).toEqual({ seq: 1, outboxId: row.id });
    expect(row).toMatchObject({ topic: TRADE_ORDERS, msg_key: o.eventId, sent_at: null });
    // Outbox ID는 주입한 시계의 UUIDv7이다(그날 파티션에 든다)
    expect(uuidv7Time(row.id)).toBe(at);
    expect(row.event).toEqual(createdEvent(o, at));
    expect(contractIssues(row.event)).toEqual([]);
  });

  test('getOrder는 만든 주문 행을 OrderRow로 돌려주고(payment_event_seq는 수), 없는 주문은 undefined다', async () => {
    const s = fresh();
    const o = newOrderInput(s.clock, { seatAssignment: 'AUTO' });
    await create(s, o);

    expect(await s.store.getOrder(database, o.id)).toEqual(rowOf(o, 'CREATED', 1));
    expect(await database.transaction((tx) => s.store.getOrder(tx, o.id))).toEqual(rowOf(o, 'CREATED', 1));
    expect(await s.store.getOrder(database, uuidv7(s.clock))).toBeUndefined();
  });

  test('조사용 칸을 계산하지 못한 주문(refMissing true, contactRef·journeyId·purchaseSessionId 없음, AUTO)의 CREATED 사건은 그 칸 없이 refMissing true를 싣는다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const o = newOrderInput(s.clock, { seatAssignment: 'AUTO', created: { refMissing: true } });
    const at = s.clock.now();

    await create(s, o);

    const [row] = await outboxOf(o.eventId);
    expect(row!.event).toEqual(createdEvent(o, at));
    expect(row!.event).toMatchObject({ refMissing: true, seatAssignment: 'AUTO' });
    for (const k of CREATED_ONLY) expect(row!.event).not.toHaveProperty(k);
    expect(contractIssues(row!.event)).toEqual([]);
    expect(await orderRowOf(o.id)).toMatchObject({ seat_assignment: 'AUTO' });
  });

  test('항목 10개(주문 하나의 상한 [가정])는 들어가고 줄 번호가 받은 차례로 1~10이다 [ASVS v5.0.0-2.2.1]', async () => {
    const s = fresh();
    const o = newOrderInput(s.clock, { items: makeItems(10) });

    await create(s, o);

    expect((await itemRowsOf(o.id)).map((r) => [r.line_no, r.seat_id])).toEqual(o.items.map((it, i) => [i + 1, it.seatId]));
  });

  test('바깥 트랜잭션을 되돌리면 주문 행·항목·이력·Outbox가 하나도 남지 않는다(부르는 쪽 트랜잭션 안에서 돈다) [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const o = newOrderInput(s.clock);

    await expect(
      database.transaction(async (tx) => {
        await s.store.createOrder(tx, o);
        throw new Error('부르는 쪽이 되돌린다');
      }),
    ).rejects.toThrow('부르는 쪽이 되돌린다');

    expect(await traceOf(o)).toEqual({ order: undefined, items: [], history: [], outbox: [] });
  });

  test('같은 주문 ID로 두 번 만들면 기본 키 위반(23505)으로 실패하고 처음 주문만 남는다(둘째의 항목·이력·Outbox도 없다) [ASVS v5.0.0-2.3.4]', async () => {
    const s = fresh();
    const first = newOrderInput(s.clock);
    await create(s, first);
    const before = await traceOf(first);
    const dup = { ...newOrderInput(s.clock), id: first.id };

    const err = await create(s, dup).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(pgCodesOf(err), messagesOf(err)).toContain('23505');
    expect(await traceOf(first)).toEqual(before);
    expect(await outboxOf(dup.eventId)).toEqual([]);
  });

  const BAD_ORDERS: { label: string; change: (o: NewOrder) => NewOrder }[] = [
    { label: '항목 0개', change: (o) => ({ ...o, items: [] }) },
    { label: '항목 11개', change: (o) => ({ ...o, items: makeItems(11) }) },
    { label: '같은 좌석이 두 번', change: (o) => ({ ...o, items: [o.items[0]!, o.items[1]!, o.items[0]!] }) },
    { label: '금액 음수', change: (o) => ({ ...o, amount: -1 }) },
    { label: '금액이 소수', change: (o) => ({ ...o, amount: 1000.5 }) },
    { label: '항목 가격 음수', change: (o) => ({ ...o, items: o.items.map((it, i) => (i === 0 ? { ...it, unitPrice: -1 } : it)) }) },
    { label: '좌석 고르기 방식이 PICK·AUTO 밖', change: (o) => ({ ...o, seatAssignment: 'MANUAL' as SeatAssignment }) },
    { label: '행위자 모양 틀림', change: (o) => ({ ...o, actor: `user:${o.accountId}` }) },
    { label: '동의 문안 판이 빈 글', change: (o) => ({ ...o, consentVersion: '' }) },
    { label: '동의 문안 판이 33자', change: (o) => ({ ...o, consentVersion: 'v'.repeat(33) }) },
    { label: '동의 문안 판에 공백', change: (o) => ({ ...o, consentVersion: 'v 1' }) },
    { label: '멱등 키가 대문자 UUID', change: (o) => ({ ...o, idempotencyKey: o.idempotencyKey.toUpperCase() }) },
    { label: 'refMissing이 참인데 contactRef가 있음', change: (o) => ({ ...o, created: { ...o.created, refMissing: true } }) },
    { label: 'refMissing이 거짓인데 contactRef가 없음', change: (o) => ({ ...o, created: { purchaseSessionId: o.created.purchaseSessionId, refMissing: false } }) },
    { label: '예매자 성명이 101자', change: (o) => ({ ...o, buyerName: '가'.repeat(101) }) },
    { label: '예매자 번호가 101자', change: (o) => ({ ...o, buyerPhone: '1'.repeat(101) }) },
    // NewOrder.holdId는 소문자 UUID다(ports.ts, 0004 PRF-161)
    { label: '홀드 ID가 UUID가 아님', change: (o) => ({ ...o, holdId: 'hold-1' }) },
    { label: '홀드 ID가 대문자 UUID', change: (o) => ({ ...o, holdId: o.holdId.toUpperCase() }) },
  ];

  test('예매자 성명·번호는 100자 [가정]까지 들어간다(경계) [ASVS v5.0.0-2.2.1]', async () => {
    const s = fresh();
    const o = newOrderInput(s.clock, { buyerName: '가'.repeat(100), buyerPhone: '1'.repeat(100) });
    await create(s, o);
    expect(await orderRowOf(o.id)).toMatchObject({ buyer_name: '가'.repeat(100), buyer_phone: '1'.repeat(100) });
  });

  test.each(BAD_ORDERS)('입력이 틀리면($label) RangeError로 거절하고 DB에 가지 않는다(트랜잭션 객체를 건드리지 않는다) [ASVS v5.0.0-2.2.1]', async ({ change }) => {
    const s = fresh();
    const { tx, touched } = untouchableTx();

    await expect((async () => s.store.createOrder(tx, change(newOrderInput(s.clock))))()).rejects.toThrow(RangeError);

    expect(touched).toEqual([]);
  });
});

// ───────────────────────────── transition 적용 ─────────────────────────────

describe('transition 적용', () => {
  test('T3(사건 없음)은 이력 행만 더하고 Outbox 행을 넣지 않으며(outboxId 없음), T4는 이력과 ACCEPTED 사건 하나를 더한다: 번호 2·3, event_seq는 마지막 번호, 돌려준 order는 전이 뒤 행 [ASVS v5.0.0-2.3.1]', async () => {
    const s = fresh();
    const o = newOrderInput(s.clock);
    const createdAt = s.clock.now();
    await create(s, o);
    const fan = accountActor(o.accountId);

    s.clock.advance(1000);
    const t3At = s.clock.now();
    const r3 = applied(await transit(s, step(o.id, 'T3', fan)));
    expect(r3).toEqual({ status: 'APPLIED', seq: 2, order: rowOf(o, 'AUTHENTICATED', 2) });
    expect(r3.outboxId).toBeUndefined();
    expect((await outboxOf(o.eventId)).map((x) => x.event.type)).toEqual(['CREATED']);

    s.clock.advance(1000);
    const t4At = s.clock.now();
    const r4 = applied(await transit(s, step(o.id, 'T4', SAGA)));
    expect(r4).toEqual({ status: 'APPLIED', seq: 3, order: rowOf(o, 'ACCEPTED', 3), outboxId: expect.any(String) });

    expect(await historyOf(o.id)).toEqual([
      { seq: 1, from_status: null, to_status: 'CREATED', cause: 'T1', actor: o.actor, occurred_at: new Date(createdAt) },
      { seq: 2, from_status: 'CREATED', to_status: 'AUTHENTICATED', cause: 'T3', actor: fan, occurred_at: new Date(t3At) },
      { seq: 3, from_status: 'AUTHENTICATED', to_status: 'ACCEPTED', cause: 'T4', actor: SAGA, occurred_at: new Date(t4At) },
    ]);
    expect(await orderRowOf(o.id)).toMatchObject({ status: 'ACCEPTED', event_seq: 3, payment_event_seq: '0' });
    const outbox = await outboxOf(o.eventId);
    expect(outbox.map((x) => x.event.type)).toEqual(['CREATED', 'ACCEPTED']);
    const accepted = outbox[1]!;
    expect(accepted.id).toBe(r4.outboxId);
    expect(uuidv7Time(accepted.id)).toBe(t4At);
    expect(accepted).toMatchObject({ topic: TRADE_ORDERS, msg_key: o.eventId, sent_at: null });
    expect(accepted.event).toMatchObject(laterEvent(o, 'ACCEPTED', 3, t4At, true));
    for (const k of CREATED_ONLY) expect(accepted.event).not.toHaveProperty(k);
    expect(contractIssues(accepted.event)).toEqual([]);
  });

  test('행위자 세 종류(account:·admin:·system:, 작업 이름 1자와 63자)를 받아 이력에 그대로 적는다(T2를 거듭: CREATED → CREATED, 사건 없음) [ASVS v5.0.0-2.2.1]', async () => {
    const s = fresh();
    const { o } = await placed(s);
    const actors = [accountActor(o.accountId), adminActor(randomUUID()), 'system:a', `system:${'a'.repeat(63)}`];

    for (const actor of actors) applied(await transit(s, step(o.id, 'T2', actor)), actor);

    const history = await historyOf(o.id);
    expect(history.map((h) => [h.seq, h.from_status, h.to_status, h.cause, h.actor])).toEqual([
      [1, null, 'CREATED', 'T1', o.actor],
      ...actors.map((actor, i) => [i + 2, 'CREATED', 'CREATED', 'T2', actor]),
    ]);
    expect(await outboxOf(o.eventId)).toHaveLength(1);
  });

  test('긴 길(T3→T4→T7→T12→T13→T18→T22→T25→T23→T26)에서도 이력 번호가 1~11로 빈틈 없이 오르고 event_seq가 마지막 번호이며, Outbox 사건은 이력 차례대로(seq 오름차순) 쌓이고 eventKey가 그 번호의 값이다 [ASVS v5.0.0-2.3.1]', async () => {
    const s = fresh();
    const path: TransitionId[] = ['T3', 'T4', 'T7', 'T12', 'T13', 'T18', 'T22', 'T25', 'T23', 'T26'];
    const { o, paymentSeq } = await placed(s, path);

    const history = await historyOf(o.id);
    expect(history.map((h) => [h.seq, h.cause])).toEqual([[1, 'T1'], ...path.map((t, i) => [i + 2, t])]);
    for (let i = 1; i < history.length; i += 1) {
      expect(history[i]!.from_status, `번호 ${i + 1}의 출발`).toBe(history[i - 1]!.to_status);
    }
    expect(await orderRowOf(o.id)).toMatchObject({ status: 'REFUNDED', event_seq: 11, payment_event_seq: String(paymentSeq) });
    const outbox = await outboxOf(o.eventId);
    expect(outbox.map((x) => [x.event.type, x.event.eventKey])).toEqual([
      ['CREATED', orderEventKeyOf(o.id, 1)],
      ['ACCEPTED', orderEventKeyOf(o.id, 3)],
      ['RESERVED', orderEventKeyOf(o.id, 4)],
      ['APPROVED', orderEventKeyOf(o.id, 6)],
      ['CONFIRMED', orderEventKeyOf(o.id, 7)],
      ['PARTIALLY_REFUNDED', orderEventKeyOf(o.id, 8)],
      ['PARTIALLY_REFUNDED', orderEventKeyOf(o.id, 9)],
      ['REFUNDED', orderEventKeyOf(o.id, 10)],
      ['REFUNDED', orderEventKeyOf(o.id, 11)],
    ]);
    const seqs = outbox.map((x) => BigInt(x.seq));
    expect([...seqs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(seqs);
  });

  const CASES = Object.entries(TABLE).map(([id, [from, to, type]]) => ({ id: id as TransitionId, from, to, type, label: type ?? '없음(이력만)' }));

  test.each(CASES)(
    '$id($from → $to)는 이력 한 행(cause $id)을 더하고 상태를 도착으로 바꾸며 사건은 [$label]이다(결제 결과 전이면 payment_event_seq가 받은 순번이 된다) [ASVS v5.0.0-2.3.1]',
    async ({ id, from, to, type }) => {
      const s = fresh();
      const path = PATH_TO[from]!;
      const { o, paymentSeq } = await placed(s, path);
      const before = await traceOf(o);
      const isPayment = PAYMENT_RESULT.has(id);
      const given = isPayment ? paymentSeq + 1 : undefined;
      const expectedPaymentSeq = given ?? paymentSeq;
      const at = s.clock.now();
      const n = path.length + 2;

      const r = applied(await transit(s, step(o.id, id, SAGA, given)));

      expect(r.seq).toBe(n);
      expect(r.order).toEqual(rowOf(o, to, n, expectedPaymentSeq));
      const after = await traceOf(o);
      expect(after.history).toEqual([...before.history, { seq: n, from_status: from, to_status: to, cause: id, actor: SAGA, occurred_at: new Date(at) }]);
      expect(after.order).toMatchObject({ status: to, event_seq: n, payment_event_seq: String(expectedPaymentSeq) });
      expect(after.items).toEqual(before.items);
      if (type === undefined) {
        expect(r.outboxId).toBeUndefined();
        expect(after.outbox).toEqual(before.outbox);
        return;
      }
      expect(after.outbox).toHaveLength(before.outbox.length + 1);
      const last = after.outbox.at(-1)!;
      expect(last.id).toBe(r.outboxId);
      const reachedBefore = ['CREATED', ...path.map(toOf)].includes(to);
      expect(last.event).toMatchObject(laterEvent(o, type, n, at, STAGE.has(to) && !reachedBefore));
      for (const k of CREATED_ONLY) expect(last.event).not.toHaveProperty(k);
      expect(contractIssues(last.event)).toEqual([]);
    },
  );
});

// ───────────────────────────── STALE ─────────────────────────────

describe('transition STALE(전이하지 않음, 던지지 않는다)', () => {
  test('없는 주문은 NOT_FOUND이고 이력·Outbox에 아무것도 쓰지 않는다(결제 결과 전이도 같다) [ASVS v5.0.0-2.3.1]', async () => {
    const s = fresh();
    const ghost = uuidv7(s.clock);
    const outboxBefore = await count('select count(*) as n from outbox');

    expect(await transit(s, step(ghost, 'T3', SAGA))).toEqual({ status: 'STALE', reason: 'NOT_FOUND' });
    expect(await transit(s, step(ghost, 'T9', SAGA, 1))).toEqual({ status: 'STALE', reason: 'NOT_FOUND' });

    expect(await count('select count(*) as n from order_event where order_id = $1', [ghost])).toBe(0);
    expect(await count('select count(*) as n from outbox')).toBe(outboxBefore);
  });

  test.each<{ label: string; path: TransitionId[]; t: TransitionId; seq?: number; current: OrderStatus }>([
    { label: 'CREATED 주문에 T4(출발 AUTHENTICATED)', path: [], t: 'T4', current: 'CREATED' },
    { label: 'EXPIRED로 끝난 주문에 T3', path: ['T5'], t: 'T3', current: 'EXPIRED' },
    { label: 'FAILED로 끝난 주문에 T7', path: ['T3', 'T4', 'T8'], t: 'T7', current: 'FAILED' },
    { label: '이미 CONFIRMED인 주문에 T18을 다시', path: ['T3', 'T4', 'T7', 'T9', 'T18'], t: 'T18', current: 'CONFIRMED' },
    { label: 'APPROVED 주문에 더 큰 순번의 T9(순번은 맞아도 출발이 아님)', path: ['T3', 'T4', 'T7', 'T9'], t: 'T9', seq: 99, current: 'APPROVED' },
  ])('[$label] STALE(STATUS, current $current)이고 주문·항목·이력·Outbox가 그대로다 [ASVS v5.0.0-2.3.1]', async ({ path, t, seq, current }) => {
    const s = fresh();
    const { o } = await placed(s, path);
    const before = await traceOf(o);

    expect(await transit(s, step(o.id, t, SAGA, seq))).toEqual({ status: 'STALE', reason: 'STATUS', current });

    expect(await traceOf(o)).toEqual(before);
  });

  test('T9에 이미 반영한 순번과 같거나 낮은 순번이 다시 오면 STALE(PAYMENT_SEQ)이고 그대로이며, 더 높은 순번(2^31, bigint 칸)이면 적용되고 payment_event_seq가 그 값이다 [ASVS v5.0.0-2.3.1] [ASVS v5.0.0-2.3.4]', async () => {
    const s = fresh();
    const { o } = await placed(s, ['T3', 'T4', 'T7']);
    // 순번 조건만 따로 보려고, RESERVED 그대로 순번 5의 결제 사건을 이미 반영한 것처럼 SQL로 둔다(상태는 바꾸지 않는다)
    await q('update purchase_order set payment_event_seq = 5 where id = $1', [o.id]);
    const before = await traceOf(o);

    for (const seq of [5, 4, 1]) {
      expect(await transit(s, step(o.id, 'T9', SAGA, seq)), `순번 ${seq}`).toMatchObject({ status: 'STALE', reason: 'PAYMENT_SEQ' });
    }
    expect(await traceOf(o)).toEqual(before);

    const high = 2 ** 31;
    const r = applied(await transit(s, step(o.id, 'T9', SAGA, high)));
    expect(r.order).toEqual(rowOf(o, 'APPROVED', 5, high));
    expect(await orderRowOf(o.id)).toMatchObject({ status: 'APPROVED', event_seq: 5, payment_event_seq: String(high) });
    expect((await historyOf(o.id)).at(-1)).toMatchObject({ seq: 5, from_status: 'RESERVED', to_status: 'APPROVED', cause: 'T9' });
  });

  test('실제 길: T10(순번 3)으로 입금 대기가 된 뒤 T16에 순번 3·2·1(같은 사건이 사건 길과 당기기로 두 번 옴)은 STALE(PAYMENT_SEQ), 순번 4는 적용된다 [ASVS v5.0.0-2.3.1] [ASVS v5.0.0-2.3.4]', async () => {
    const s = fresh();
    const { o } = await placed(s, ['T3', 'T4', 'T7']);
    applied(await transit(s, step(o.id, 'T10', SAGA, 3)));
    const before = await traceOf(o);
    expect(before.order).toMatchObject({ status: 'AWAITING_DEPOSIT', payment_event_seq: '3' });

    for (const seq of [3, 2, 1]) {
      expect(await transit(s, step(o.id, 'T16', SAGA, seq)), `순번 ${seq}`).toMatchObject({ status: 'STALE', reason: 'PAYMENT_SEQ' });
    }
    expect(await traceOf(o)).toEqual(before);

    const r = applied(await transit(s, step(o.id, 'T16', SAGA, 4)));
    expect(r.order).toEqual(rowOf(o, 'APPROVED', 6, 4));
    expect((await outboxOf(o.eventId)).at(-1)!.event).toMatchObject({ type: 'APPROVED', eventKey: orderEventKeyOf(o.id, 6), firstInStage: true });
  });

  test('입금 되돌림(T21)도 결제 결과 반영이라 순번을 받는다: T10(3)→T16(4)→T18→T21(5)→T16(6)→T18 뒤 늦게 온 순번 5의 T21은 STALE(PAYMENT_SEQ)이고 그대로다 [ASVS v5.0.0-2.3.1] [ASVS v5.0.0-2.3.4]', async () => {
    const s = fresh();
    const { o } = await placed(s, ['T3', 'T4', 'T7']);
    applied(await transit(s, step(o.id, 'T10', SAGA, 3)));
    applied(await transit(s, step(o.id, 'T16', SAGA, 4)));
    applied(await transit(s, step(o.id, 'T18', SAGA)));

    const reversed = applied(await transit(s, step(o.id, 'T21', SAGA, 5)));
    expect(reversed.order).toEqual(rowOf(o, 'AWAITING_DEPOSIT', 8, 5));
    expect((await outboxOf(o.eventId)).at(-1)!.event).toMatchObject({ type: 'DEPOSIT_REVERSED', eventKey: orderEventKeyOf(o.id, 8) });

    applied(await transit(s, step(o.id, 'T16', SAGA, 6)));
    applied(await transit(s, step(o.id, 'T18', SAGA)));
    const before = await traceOf(o);
    expect(before.order).toMatchObject({ status: 'CONFIRMED', event_seq: 10, payment_event_seq: '6' });

    // 같은 되돌림 사건(순번 5)이 당기기로 다시 와도 두 번 되돌리지 않는다
    expect(await transit(s, step(o.id, 'T21', SAGA, 5))).toEqual({ status: 'STALE', reason: 'PAYMENT_SEQ' });
    expect(await traceOf(o)).toEqual(before);
  });

  // T11 순번 예외(payment §3 '주문 저장소의 첫 구현', 추천 적용 2026-11-05, BUILD_ORDER PRF-165): Saga가 승인 명령을 접수시키지 못한 채 승인 기한을 넘기면
  // 결제 사건이 없으므로 T11은 순번 없이 상태 조건만으로 바꾼다. 순번을 주면 다른 결제 결과 전이처럼 조건을 건다
  test('T11은 결제 사건 순번 없이도 받는다: RESERVED 주문에 순번 없는 T11은 적용되고 payment_event_seq가 그대로이며 이력·Outbox FAILED가 하나씩이다 [ASVS v5.0.0-2.3.1]', async () => {
    const s = fresh();
    const { o, paymentSeq } = await placed(s, ['T3', 'T4', 'T7']);
    const at = s.clock.now();

    const r = applied(await transit(s, step(o.id, 'T11', SAGA)));

    expect(r.seq).toBe(5);
    expect(r.order).toEqual(rowOf(o, 'FAILED', 5, paymentSeq));
    expect(await orderRowOf(o.id)).toMatchObject({ status: 'FAILED', event_seq: 5, payment_event_seq: String(paymentSeq) });
    expect((await historyOf(o.id)).at(-1)).toEqual({ seq: 5, from_status: 'RESERVED', to_status: 'FAILED', cause: 'T11', actor: SAGA, occurred_at: new Date(at) });
    expect((await outboxOf(o.eventId)).at(-1)!.event).toMatchObject(laterEvent(o, 'FAILED', 5, at, false));
  });

  test('T11에 순번을 주면 다른 결제 결과 전이처럼 조건을 건다: 이미 반영한 순번 이하면 STALE(PAYMENT_SEQ), 더 높으면 적용되고 그 순번이 된다 [ASVS v5.0.0-2.3.1] [ASVS v5.0.0-2.3.4]', async () => {
    const s = fresh();
    const { o } = await placed(s, ['T3', 'T4', 'T7']);
    await q('update purchase_order set payment_event_seq = 5 where id = $1', [o.id]);
    const before = await traceOf(o);
    for (const seq of [5, 1]) {
      expect(await transit(s, step(o.id, 'T11', SAGA, seq)), `순번 ${seq}`).toMatchObject({ status: 'STALE', reason: 'PAYMENT_SEQ' });
    }
    expect(await traceOf(o)).toEqual(before);
    expect(applied(await transit(s, step(o.id, 'T11', SAGA, 6))).order).toEqual(rowOf(o, 'FAILED', 5, 6));
  });

  test('순번 없는 T11도 출발 상태 조건은 그대로다: ACCEPTED 주문에는 STALE(STATUS, current ACCEPTED)이고, 이미 FAILED가 된 주문에 다시 오면 STALE(STATUS, current FAILED)다 [ASVS v5.0.0-2.3.1]', async () => {
    const s = fresh();
    const { o } = await placed(s, ['T3', 'T4']);
    const before = await traceOf(o);
    expect(await transit(s, step(o.id, 'T11', SAGA))).toEqual({ status: 'STALE', reason: 'STATUS', current: 'ACCEPTED' });
    expect(await traceOf(o)).toEqual(before);
    applied(await transit(s, step(o.id, 'T7', SAGA)));
    applied(await transit(s, step(o.id, 'T11', SAGA)));
    expect(await transit(s, step(o.id, 'T11', SAGA))).toEqual({ status: 'STALE', reason: 'STATUS', current: 'FAILED' });
  });

  test('까닭의 차례: 출발 상태가 아닌 주문에 이미 반영한 순번 이하의 결제 결과가 오면 PAYMENT_SEQ가 아니라 STATUS(current)다(T10 순번 3으로 입금 대기 뒤 T9 순번 2·3) [ASVS v5.0.0-2.3.1]', async () => {
    const s = fresh();
    const { o } = await placed(s, ['T3', 'T4', 'T7']);
    applied(await transit(s, step(o.id, 'T10', SAGA, 3)));
    const before = await traceOf(o);

    for (const seq of [2, 3]) {
      expect(await transit(s, step(o.id, 'T9', SAGA, seq)), `순번 ${seq}`).toEqual({ status: 'STALE', reason: 'STATUS', current: 'AWAITING_DEPOSIT' });
    }
    expect(await traceOf(o)).toEqual(before);
  });

  test('결제 결과가 아닌 전이(T18)는 payment_event_seq를 바꾸지 않는다 [ASVS v5.0.0-2.3.1]', async () => {
    const s = fresh();
    const { o } = await placed(s, ['T3', 'T4', 'T7']);
    applied(await transit(s, step(o.id, 'T9', SAGA, 7)));

    const r = applied(await transit(s, step(o.id, 'T18', SAGA)));

    expect(r.order).toEqual(rowOf(o, 'CONFIRMED', 6, 7));
    expect(await orderRowOf(o.id)).toMatchObject({ payment_event_seq: '7' });
  });
});

// ───────────────────────────── 입력 거절 ─────────────────────────────

describe('transition 입력 거절(코드 오류, DB에 가지 않는다)', () => {
  const BAD_INPUTS: { label: string; input: (orderId: string) => TransitionInput }[] = [
    { label: '표에 없는 번호 T27', input: (id) => step(id, 'T27', SAGA) },
    { label: '표에 없는 번호 T0', input: (id) => step(id, 'T0', SAGA) },
    { label: '번호 모양이 아님(X3)', input: (id) => step(id, 'X3' as TransitionId, SAGA) },
    { label: '소수 번호(T3.5)', input: (id) => step(id, 'T3.5', SAGA) },
    { label: 'T1(주문 생성은 createOrder로 한다)', input: (id) => step(id, 'T1', SAGA) },
    { label: '행위자가 빈 글', input: (id) => step(id, 'T3', '') },
    { label: '행위자 종류가 셋 밖(user:)', input: (id) => step(id, 'T3', `user:${randomUUID()}`) },
    { label: '팬 행위자의 계정 ID가 대문자 UUID', input: (id) => step(id, 'T3', `account:${randomUUID().toUpperCase()}`) },
    { label: '관리 행위자의 ID가 UUID가 아님', input: (id) => step(id, 'T3', 'admin:cs-kim') },
    { label: '작업 이름이 빔(system:)', input: (id) => step(id, 'T3', 'system:') },
    { label: '작업 이름에 대문자(system:Saga)', input: (id) => step(id, 'T3', 'system:Saga') },
    { label: '작업 이름이 하이픈으로 시작', input: (id) => step(id, 'T3', 'system:-saga') },
    { label: '작업 이름이 64자', input: (id) => step(id, 'T3', `system:${'a'.repeat(64)}`) },
    { label: '행위자 뒤에 공백', input: (id) => step(id, 'T3', `${SAGA} `) },
    { label: '결제 결과 전이 T9에 순번 없음', input: (id) => step(id, 'T9', SAGA) },
    { label: '결제 결과 전이 T17에 순번 없음', input: (id) => step(id, 'T17', SAGA) },
    { label: '입금 되돌림 T21(결제 결과 전이)에 순번 없음', input: (id) => step(id, 'T21', SAGA) },
    { label: '결제 결과가 아닌 T4에 순번', input: (id) => step(id, 'T4', SAGA, 1) },
    { label: '결제 결과가 아닌 T18에 순번', input: (id) => step(id, 'T18', SAGA, 3) },
    { label: '순번 0', input: (id) => step(id, 'T9', SAGA, 0) },
    { label: '순번 음수', input: (id) => step(id, 'T9', SAGA, -1) },
    { label: '순번 소수', input: (id) => step(id, 'T9', SAGA, 1.5) },
    { label: '순번 NaN', input: (id) => step(id, 'T9', SAGA, Number.NaN) },
    { label: '순번 무한대', input: (id) => step(id, 'T9', SAGA, Number.POSITIVE_INFINITY) },
  ];

  test.each(BAD_INPUTS)('[$label] RangeError로 거절하고 트랜잭션 객체를 건드리지 않는다 [ASVS v5.0.0-2.2.1] [ASVS v5.0.0-2.2.3]', async ({ input }) => {
    const { store } = fresh();
    const { tx, touched } = untouchableTx();

    await expect((async () => store.transition(tx, input(randomUUID())))()).rejects.toThrow(RangeError);

    expect(touched).toEqual([]);
  });

  test('실제 트랜잭션에서도: RESERVED 주문에 순번 없는 T9·T1·표 밖 번호를 보내면 던지고 주문·이력·Outbox가 그대로다 [ASVS v5.0.0-16.5.3]', async () => {
    const s = fresh();
    const { o } = await placed(s, ['T3', 'T4', 'T7']);
    const before = await traceOf(o);

    for (const t of ['T9', 'T1', 'T27'] as const) {
      await expect(transit(s, step(o.id, t, SAGA)), t).rejects.toThrow(RangeError);
    }

    expect(await traceOf(o)).toEqual(before);
  });
});

// ───────────────────────────── firstInStage ─────────────────────────────

describe('firstInStage', () => {
  test('CREATED→AUTHENTICATED→ACCEPTED→RESERVED→APPROVED(T9)→CONFIRMED(T18)→AWAITING_DEPOSIT(T21, DEPOSIT_REVERSED)→APPROVED(T16)→CONFIRMED(T18): 단계에 처음 들어온 ACCEPTED·APPROVED·CONFIRMED만 참이고 입금 되돌림 뒤의 APPROVED·CONFIRMED는 거짓이다 [ASVS v5.0.0-2.3.1]', async () => {
    const s = fresh();
    const { o } = await placed(s, ['T3', 'T4', 'T7', 'T9', 'T18', 'T21', 'T16', 'T18']);

    const outbox = await outboxOf(o.eventId);
    expect(outbox.map((x) => [x.event.type, x.event.firstInStage, x.event.eventKey])).toEqual([
      ['CREATED', false, orderEventKeyOf(o.id, 1)],
      ['ACCEPTED', true, orderEventKeyOf(o.id, 3)],
      ['RESERVED', false, orderEventKeyOf(o.id, 4)],
      ['APPROVED', true, orderEventKeyOf(o.id, 5)],
      ['CONFIRMED', true, orderEventKeyOf(o.id, 6)],
      ['DEPOSIT_REVERSED', false, orderEventKeyOf(o.id, 7)],
      ['APPROVED', false, orderEventKeyOf(o.id, 8)],
      ['CONFIRMED', false, orderEventKeyOf(o.id, 9)],
    ]);
    for (const row of outbox) expect(contractIssues(row.event), String(row.event.type)).toEqual([]);
    // 결제 결과 전이 T9(1)·T21(2)·T16(3)의 순번을 반영했다
    expect(await orderRowOf(o.id)).toMatchObject({ status: 'CONFIRMED', event_seq: 9, payment_event_seq: '3' });
    expect((await historyOf(o.id)).map((h) => h.to_status)).toEqual([
      'CREATED',
      'AUTHENTICATED',
      'ACCEPTED',
      'RESERVED',
      'APPROVED',
      'CONFIRMED',
      'AWAITING_DEPOSIT',
      'APPROVED',
      'CONFIRMED',
    ]);
  });
});

// ───────────────────────────── 동시성 ─────────────────────────────

describe('동시성(같은 주문의 두 전이)', () => {
  test.each<[TransitionId, TransitionId, OrderStatus]>([
    ['T7', 'T8', 'RESERVED'],
    ['T8', 'T7', 'FAILED'],
  ])(
    '같은 ACCEPTED 주문에 %s를 쓴 트랜잭션이 행을 쥔 동안 %s가 오면 뒤 쪽은 행 잠금을 기다렸다가 STALE(STATUS, current %s)이고, 이력 번호는 1~4로 빈틈·겹침이 없으며 사건은 이긴 쪽 하나다 [ASVS v5.0.0-2.3.1] [ASVS v5.0.0-2.3.4]',
    async (first, second, winnerTo) => {
      const s = fresh();
      const { o } = await placed(s, ['T3', 'T4']);

      const { r1, r2, waited } = await gatedRace(s, step(o.id, first, SAGA), step(o.id, second, SAGA));

      expect(waited, '둘째 트랜잭션이 행 잠금을 기다렸다').toBe(true);
      expect(applied(r1).seq).toBe(4);
      expect(r1).toMatchObject({ order: rowOf(o, winnerTo, 4) });
      expect(r2).toEqual({ status: 'STALE', reason: 'STATUS', current: winnerTo });
      expect((await historyOf(o.id)).map((h) => [h.seq, h.cause])).toEqual([
        [1, 'T1'],
        [2, 'T3'],
        [3, 'T4'],
        [4, first],
      ]);
      expect(await orderRowOf(o.id)).toMatchObject({ status: winnerTo, event_seq: 4 });
      expect((await outboxOf(o.eventId)).map((x) => x.event.type)).toEqual(['CREATED', 'ACCEPTED', winnerTo]);
    },
  );

  test('같은 결제 사건(순번 7)의 T9를 두 트랜잭션이 겹쳐 보내면(사건 길과 당기기) 하나만 APPLIED이고, 이력의 APPROVED·Outbox APPROVED 사건은 하나, payment_event_seq는 7이다 [ASVS v5.0.0-2.3.4]', async () => {
    const s = fresh();
    const { o } = await placed(s, ['T3', 'T4', 'T7']);

    const { r1, r2, waited } = await gatedRace(s, step(o.id, 'T9', SAGA, 7), step(o.id, 'T9', SAGA, 7));

    expect(waited, '둘째 트랜잭션이 행 잠금을 기다렸다').toBe(true);
    expect(applied(r1).order).toEqual(rowOf(o, 'APPROVED', 5, 7));
    // 둘째는 상태(APPROVED)도 순번(7)도 맞지 않는다. 어느 이유를 돌려줄지는 정하지 않는다
    expect(r2).toMatchObject({ status: 'STALE' });
    expect(['STATUS', 'PAYMENT_SEQ']).toContain((r2 as { reason?: string }).reason);
    expect((await historyOf(o.id)).filter((h) => h.to_status === 'APPROVED')).toHaveLength(1);
    expect(await orderRowOf(o.id)).toMatchObject({ status: 'APPROVED', event_seq: 5, payment_event_seq: '7' });
    expect((await outboxOf(o.eventId)).filter((x) => x.event.type === 'APPROVED')).toHaveLength(1);
  });

  test('ACCEPTED 주문 여덟 개에 T7과 T8을 한꺼번에(트랜잭션 16개) 보내도 던지는 오류가 없고, 주문마다 정확히 하나만 APPLIED·다른 하나는 STALE(STATUS, 이긴 쪽 상태)이며 이력은 1~4다 [ASVS v5.0.0-2.3.4]', async () => {
    const s = fresh();
    const orders: NewOrder[] = [];
    for (let i = 0; i < 8; i += 1) orders.push((await placed(s, ['T3', 'T4'])).o);
    await warm(database, 16);

    const settled = await Promise.allSettled(orders.flatMap((o) => (['T7', 'T8'] as const).map((t) => transit(s, step(o.id, t, SAGA)))));

    expect(rejections(settled)).toEqual([]);
    for (const [i, o] of orders.entries()) {
      const pair = [settled[2 * i], settled[2 * i + 1]].map((r) => (r as PromiseFulfilledResult<TransitionResult>).value);
      expect(
        pair.map((r) => r.status).sort(),
        `주문 ${i}`,
      ).toEqual(['APPLIED', 'STALE']);
      const winner = pair.findIndex((r) => r.status === 'APPLIED');
      const winnerTo: OrderStatus = winner === 0 ? 'RESERVED' : 'FAILED';
      expect(pair[1 - winner], `주문 ${i} 진 쪽`).toEqual({ status: 'STALE', reason: 'STATUS', current: winnerTo });
      expect((await historyOf(o.id)).map((h) => h.seq), `주문 ${i} 이력`).toEqual([1, 2, 3, 4]);
      expect(await orderRowOf(o.id), `주문 ${i} 행`).toMatchObject({ status: winnerTo, event_seq: 4 });
      expect(await outboxOf(o.eventId), `주문 ${i} Outbox`).toHaveLength(3);
    }
  });
});

// ───────────────────────────── 원자성 ─────────────────────────────

describe('원자성(Outbox 쓰기가 실패하면 함께 되돌아간다)', () => {
  /** Outbox 일 파티션이 없는 날(기준 + 30일)의 시계: 그날 ID의 Outbox 행은 들어갈 파티션이 없어 실패한다 */
  const farFuture = () => fresh(BASE_MS + 30 * DAY);
  const NO_OUTBOX_PARTITION = /no partition of relation "outbox" found for row/;

  test('사건이 있는 전이(T4)에서 Outbox 쓰기가 실패하면 transition이 던지고 상태·event_seq·이력·Outbox가 바뀌지 않는다 [ASVS v5.0.0-2.3.3] [ASVS v5.0.0-16.5.3]', async () => {
    const s = fresh();
    const { o } = await placed(s, ['T3']);
    const before = await traceOf(o);
    expect(before.order).toMatchObject({ status: 'AUTHENTICATED', event_seq: 2 });

    const err = await transit(farFuture(), step(o.id, 'T4', SAGA)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(messagesOf(err)).toMatch(NO_OUTBOX_PARTITION);
    expect(await traceOf(o)).toEqual(before);
    // 그 뒤 정상 시계로는 같은 전이가 된다(되돌아간 뒤 번호 3을 다시 쓴다)
    expect(applied(await transit(s, step(o.id, 'T4', SAGA))).seq).toBe(3);
  });

  test('createOrder에서 Outbox 쓰기가 실패하면 던지고 주문 행·항목·이력이 하나도 남지 않는다 [ASVS v5.0.0-2.3.3] [ASVS v5.0.0-16.5.3]', async () => {
    const far = farFuture();
    const o = newOrderInput(far.clock);

    const err = await create(far, o).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(messagesOf(err)).toMatch(NO_OUTBOX_PARTITION);
    expect(await traceOf(o)).toEqual({ order: undefined, items: [], history: [], outbox: [] });
  });
});

// ───────────────────────────── 상태 이력 지연 제약 트리거 ─────────────────────────────

describe('상태 이력 지연 제약 트리거(order_status_has_event, 전이 함수 밖 쓰기를 DB가 막는다)', () => {
  /** 준비 SQL을 한 트랜잭션으로 돌리고 커밋한다(트리거를 끄지 않는다). 실패하면 되돌리고 그 오류를 던진다 */
  async function rawTx(statements: [string, unknown[]][]): Promise<void> {
    const c = await admin.pool.connect();
    try {
      await c.query('begin');
      for (const [text, params] of statements) await c.query(text, params);
      await c.query('commit');
    } catch (err) {
      await c.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }
  const HISTORY_MISSING = { code: '23514', constraint: 'order_status_has_event' };

  test('이력 없이 status만 바꾼 트랜잭션은 커밋이 23514(order_status_has_event)로 실패하고 주문·이력이 그대로다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const { o } = await placed(s, ['T3']);
    const before = await traceOf(o);

    await expect(rawTx([[`update purchase_order set status = 'EXPIRED' where id = $1`, [o.id]]])).rejects.toMatchObject(HISTORY_MISSING);

    expect(await traceOf(o)).toEqual(before);
  });

  test('이력 없이 event_seq만 올린 트랜잭션도, 이력 없이 주문 행만 넣은 트랜잭션도 커밋이 실패한다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const { o } = await placed(s, ['T3']);
    await expect(rawTx([['update purchase_order set event_seq = event_seq + 1 where id = $1', [o.id]]])).rejects.toMatchObject(HISTORY_MISSING);
    expect(await orderRowOf(o.id)).toMatchObject({ status: 'AUTHENTICATED', event_seq: 2 });

    const id = uuidv7(fakeClock({ now: BASE_MS }));
    await expect(
      rawTx([
        [
          `insert into purchase_order (id, account_id, event_id, status, amount, event_seq, buyer_name, buyer_phone, idempotency_key, consent_version, seat_assignment, created_at, hold_id, purchase_session_id)
           values ($1, $2, $3, 'CREATED', 1000, 1, '김피켓', '01012345678', $4, 'v1', 'PICK', $5, $6, $7)`,
          [id, randomUUID(), randomUUID(), randomUUID(), new Date(BASE_MS), randomUUID(), randomUUID()],
        ],
      ]),
    ).rejects.toMatchObject(HISTORY_MISSING);
    expect(await orderRowOf(id)).toBeUndefined();
  });

  test('이력이 도착 상태와 다르면(번호는 맞지만 to_status가 다름) 커밋이 실패한다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const { o } = await placed(s, ['T3']);
    await expect(
      rawTx([
        [`update purchase_order set status = 'EXPIRED', event_seq = event_seq + 1 where id = $1`, [o.id]],
        [`insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at) values ($1, 3, 'AUTHENTICATED', 'ACCEPTED', 'T4', $2, $3)`, [o.id, SAGA, new Date(BASE_MS)]],
      ]),
    ).rejects.toMatchObject(HISTORY_MISSING);
    expect(await orderRowOf(o.id)).toMatchObject({ status: 'AUTHENTICATED', event_seq: 2 });
  });

  test('지연 제약이라 같은 트랜잭션에서 맞는 이력을 UPDATE 뒤에 써도 커밋된다(전이 함수·주문 만들기와 같은 차례) [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const { o } = await placed(s, ['T3']);
    await rawTx([
      [`update purchase_order set status = 'EXPIRED', event_seq = event_seq + 1 where id = $1`, [o.id]],
      [`insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at) values ($1, 3, 'AUTHENTICATED', 'EXPIRED', 'T6', $2, $3)`, [o.id, SAGA, new Date(BASE_MS)]],
    ]);
    expect(await orderRowOf(o.id)).toMatchObject({ status: 'EXPIRED', event_seq: 3 });
  });

  test('payment_event_seq만 바꾸는 UPDATE는 트리거 대상이 아니다(UPDATE OF status, event_seq) [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const { o } = await placed(s, ['T3', 'T4', 'T7']);
    await rawTx([['update purchase_order set payment_event_seq = 9 where id = $1', [o.id]]]);
    expect(await orderRowOf(o.id)).toMatchObject({ status: 'RESERVED', payment_event_seq: '9' });
  });
});

// ───────────────────────────── 매일 상태·이력 검사 ─────────────────────────────

describe('checkOrderHistory(매일 상태·이력 검사)', () => {
  /** 기준 다음 날(한국 시각 11-06 12시부터)의 k번째 한 시간 칸. 시험마다 짝수 칸을 하나씩 쓰고 홀수 칸은 범위 밖 주문에만 쓴다 */
  const windowOf = (k: number) => ({ fromMs: BASE_MS + DAY + k * HOUR, toMs: BASE_MS + DAY + (k + 1) * HOUR });
  const byOrderId = (xs: readonly OrderHistoryMismatch[]) => [...xs].sort((a, b) => (a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0));

  /** 일부러 어긋나게 만든다(시험 안 SQL). 저장소를 거치지 않고, 상태 이력 트리거를 그 트랜잭션에서 끈다 */
  const breakStatus = (id: string, status: OrderStatus) => rawNoHistory('update purchase_order set status = $2 where id = $1', [id, status]);
  const breakEventSeq = (id: string, eventSeq: number) => rawNoHistory('update purchase_order set event_seq = $2 where id = $1', [id, eventSeq]);
  const dropHistoryRow = (id: string, seq: number) => q('delete from order_event where order_id = $1 and seq = $2', [id, seq]);

  test('정상 주문들(이력 1행·3행·6행·4행)은 어긋남이 0이고, 칸 안에 이력이 여러 행이어도 주문 하나로 센다 [ASVS v5.0.0-2.3.3]', async () => {
    const w = windowOf(0);
    const s = fresh(w.fromMs + 60_000);
    await placed(s, []);
    await placed(s, ['T3', 'T4']);
    await placed(s, ['T3', 'T4', 'T7', 'T9', 'T18']);
    await placed(s, ['T3', 'T4', 'T8']);

    expect(await checkOrderHistory(database, w)).toEqual({ checked: 4, mismatched: [] });
  });

  test('어긋난 주문 셋(상태만 바꿈, event_seq만 바꿈, 이력 한 행을 지워 빈틈)이 각각 잡히고 칸(status·eventSeq·lastSeq·rows·lastTo)이 맞으며 정상 주문은 잡히지 않는다 [ASVS v5.0.0-2.3.3]', async () => {
    const w = windowOf(2);
    const s = fresh(w.fromMs + 60_000);
    const statusOnly = (await placed(s, ['T3'])).o;
    const seqOnly = (await placed(s, ['T3'])).o;
    const gap = (await placed(s, ['T3', 'T4'])).o;
    await placed(s, ['T3', 'T4', 'T7']);
    await breakStatus(statusOnly.id, 'EXPIRED');
    await breakEventSeq(seqOnly.id, 5);
    await dropHistoryRow(gap.id, 2);

    const report = await checkOrderHistory(database, w);

    expect(report.checked).toBe(4);
    expect(byOrderId(report.mismatched)).toEqual(
      byOrderId([
        { orderId: statusOnly.id, status: 'EXPIRED', eventSeq: 2, lastSeq: 2, rows: 2, lastTo: 'AUTHENTICATED' },
        { orderId: seqOnly.id, status: 'AUTHENTICATED', eventSeq: 5, lastSeq: 2, rows: 2, lastTo: 'AUTHENTICATED' },
        { orderId: gap.id, status: 'ACCEPTED', eventSeq: 3, lastSeq: 3, rows: 2, lastTo: 'ACCEPTED' },
      ]),
    );
  });

  test('범위는 [fromMs, toMs)다: fromMs·toMs−1의 이력은 보고, toMs·fromMs−1에만 이력이 있는 주문은 (어긋났어도) 보지 않으며 checked에 안 센다. 칸 앞에 만들고 칸 안에서 전이한 주문은 보고 이력 전체(칸 밖 행 포함)로 견준다 [ASVS v5.0.0-2.3.3]', async () => {
    const w = windowOf(4);
    await placed(fresh(w.fromMs));
    await placed(fresh(w.toMs - 1));
    const atTo = (await placed(fresh(w.toMs))).o;
    const justBefore = (await placed(fresh(w.fromMs - 1))).o;
    await breakStatus(atTo.id, 'FAILED');
    await breakStatus(justBefore.id, 'FAILED');
    const straddle = fresh(w.fromMs - 30 * 60_000);
    const { o: straddler } = await placed(straddle);
    straddle.clock.advance(40 * 60_000);
    applied(await transit(straddle, step(straddler.id, 'T3', SAGA)));

    expect(await checkOrderHistory(database, w)).toEqual({ checked: 3, mismatched: [] });
  });

  test('batchSize 2(주문 5개를 2·2·1로)·1로 나눠 읽어도 기본 묶음과 결과가 같다 [ASVS v5.0.0-2.3.3]', async () => {
    const w = windowOf(6);
    const s = fresh(w.fromMs + 60_000);
    const orders: NewOrder[] = [];
    for (const path of [[], ['T3'], ['T3', 'T4'], ['T3', 'T4', 'T7'], ['T5']] as TransitionId[][]) orders.push((await placed(s, path)).o);
    await breakStatus(orders[1]!.id, 'EXPIRED');
    await dropHistoryRow(orders[3]!.id, 3);

    const all = await checkOrderHistory(database, w);
    const byTwo = await checkOrderHistory(database, { ...w, batchSize: 2 });
    const byOne = await checkOrderHistory(database, { ...w, batchSize: 1 });

    expect(all.checked).toBe(5);
    expect(all.mismatched.map((m) => m.orderId).sort()).toEqual([orders[1]!.id, orders[3]!.id].sort());
    for (const r of [byTwo, byOne]) {
      expect(r.checked).toBe(5);
      expect(byOrderId(r.mismatched)).toEqual(byOrderId(all.mismatched));
    }
  });

  test('이미 끊긴 signal이면 첫 묶음도 시작하지 않아 checked 0·어긋남 없음이다(같은 칸을 signal 없이 보면 주문 둘·어긋남 하나가 있다) [ASVS v5.0.0-2.3.3]', async () => {
    const w = windowOf(8);
    const s = fresh(w.fromMs + 60_000);
    const { o } = await placed(s, ['T3']);
    await placed(s, []);
    await breakEventSeq(o.id, 9);
    const ac = new AbortController();
    ac.abort();

    expect(await checkOrderHistory(database, { ...w, signal: ac.signal })).toEqual({ checked: 0, mismatched: [] });

    const report = await checkOrderHistory(database, w);
    expect(report.checked).toBe(2);
    expect(report.mismatched).toEqual([{ orderId: o.id, status: 'AUTHENTICATED', eventSeq: 9, lastSeq: 2, rows: 2, lastTo: 'AUTHENTICATED' }]);
  });

  /**
   * database.db.execute를 감싸 checkOrderHistory가 보낸 SQL 글을 모은다. after(글)는 그 질의가 끝난 뒤 부른다(묶음 도중 signal을 끊는 데 쓴다)
   */
  function recording(after?: (text: string) => void) {
    const texts: string[] = [];
    const dialect = new PgDialect();
    const db = new Proxy(database.db, {
      get(target, p, receiver) {
        if (p !== 'execute') return Reflect.get(target, p, receiver);
        return async (query: SQL) => {
          const text = dialect.sqlToQuery(query).sql;
          texts.push(text);
          const r = await target.execute(query);
          after?.(text);
          return r;
        };
      },
    });
    return { texts, wrapped: { ...database, db } as Database };
  }
  const isRangeQuery = (t: string) => /occurred_at/.test(t);
  const isCompareQuery = (t: string) => /array_agg/.test(t);

  test('그날 주문 ID는 범위 질의 한 번(occurred_at, BRIN)으로 모으고 묶음마다 다시 훑지 않는다: batchSize 2·주문 5개에서 범위 질의 1번, 견주기 3번(2·2·1) [ASVS v5.0.0-2.3.3]', async () => {
    const w = windowOf(10);
    const s = fresh(w.fromMs + 60_000);
    for (const path of [[], ['T3'], ['T3', 'T4'], ['T3', 'T4', 'T7'], ['T5']] as TransitionId[][]) await placed(s, path);
    const rec = recording();

    const report = await checkOrderHistory(rec.wrapped, { ...w, batchSize: 2 });

    expect(report).toEqual({ checked: 5, mismatched: [] });
    expect(rec.texts.filter(isRangeQuery)).toHaveLength(1);
    expect(rec.texts.filter(isCompareQuery)).toHaveLength(3);
  });

  test('묶음 도중 signal이 끊기면(첫 묶음 뒤) 다음 묶음을 시작하지 않고 본 것까지만 돌려준다 [ASVS v5.0.0-2.3.3]', async () => {
    const w = windowOf(12);
    const s = fresh(w.fromMs + 60_000);
    for (let i = 0; i < 5; i += 1) await placed(s, ['T3']);
    const ac = new AbortController();
    const rec = recording((text) => {
      if (isCompareQuery(text)) ac.abort();
    });

    const report = await checkOrderHistory(rec.wrapped, { ...w, batchSize: 2, signal: ac.signal });

    expect(report).toEqual({ checked: 2, mismatched: [] });
    expect(rec.texts.filter(isCompareQuery)).toHaveLength(1);
  });

  test.each<[string, number, number]>([
    ['fromMs = toMs', BASE_MS, BASE_MS],
    ['fromMs > toMs', BASE_MS + 1, BASE_MS],
  ])('범위가 비었거나 뒤집히면(%s) DB에 가지 않고 RangeError다 [ASVS v5.0.0-2.2.1]', async (_label, fromMs, toMs) => {
    const rec = recording();
    await expect(checkOrderHistory(rec.wrapped, { fromMs, toMs })).rejects.toThrow(RangeError);
    expect(rec.texts).toEqual([]);
  });
});

// ───────────────────────────── order_idempotency ─────────────────────────────

describe('order_idempotency(platform IdempotencyStore)', () => {
  const fingerprint = (body: string) => requestFingerprint('POST', '/v1/orders', Buffer.from(body, 'utf8'));
  const idemRows = (accountRef: string) =>
    q<{ operation: string; idempotency_key: string; request_hash: Buffer; result_ref: string | null; created_at: Date }>(
      'select operation, idempotency_key, request_hash, result_ref, created_at from order_idempotency where account_ref = $1 order by operation',
      [accountRef],
    );

  test('처음 요청은 execute, 같은 키·같은 지문은 replay(처음 결과 참조), 같은 키·다른 지문은 422(idempotency-key-reused)이고 행은 하나다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const idem = new IdempotencyStore({ clock: s.clock, table: 'order_idempotency' });
    const accountRef = randomUUID();
    const key = randomUUID();
    const hash = fingerprint('{"seats":1}');
    const ref = uuidv7(s.clock);
    const calls: string[] = [];
    const steps = {
      execute: async () => {
        calls.push('execute');
        return { resultRef: ref, value: 'first' };
      },
      replay: async (r: string) => {
        calls.push(`replay:${r}`);
        return 'again';
      },
    };
    const run = (requestHash: Uint8Array) => database.transaction((tx: DbTransaction) => idem.run(tx, { accountRef, operation: 'CREATE_ORDER', key, requestHash }, steps));

    expect(await run(hash)).toBe('first');
    expect(await run(hash)).toBe('again');
    await expect(run(fingerprint('{"seats":2}'))).rejects.toMatchObject({ status: 422, slug: 'idempotency-key-reused' });

    expect(calls).toEqual(['execute', `replay:${ref}`]);
    expect(await idemRows(accountRef)).toEqual([{ operation: 'CREATE_ORDER', idempotency_key: key, request_hash: Buffer.from(hash), result_ref: ref, created_at: new Date(s.clock.now()) }]);
  });

  test('키 범위는 계정 × 작업이다: 같은 키라도 다른 작업(START_PAYMENT)·다른 계정은 처음 요청(execute)이다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const idem = new IdempotencyStore({ clock: s.clock, table: 'order_idempotency' });
    const accountRef = randomUUID();
    const key = randomUUID();
    const hash = fingerprint('{}');
    let executed = 0;
    const steps = {
      execute: async () => ({ resultRef: `ref-${++executed}`, value: executed }),
      replay: async () => -1,
    };
    const run = (account: string, operation: string) => database.transaction((tx) => idem.run(tx, { accountRef: account, operation, key, requestHash: hash }, steps));

    expect(await run(accountRef, 'CREATE_ORDER')).toBe(1);
    expect(await run(accountRef, 'START_PAYMENT')).toBe(2);
    expect(await run(randomUUID(), 'CREATE_ORDER')).toBe(3);
    expect(await run(accountRef, 'CREATE_ORDER')).toBe(-1);

    expect((await idemRows(accountRef)).map((r) => [r.operation, r.result_ref])).toEqual([
      ['CREATE_ORDER', 'ref-1'],
      ['START_PAYMENT', 'ref-2'],
    ]);
  });

  test('주문 생성과 같은 트랜잭션에서: 첫 요청은 주문을 만들고 결과 참조에 주문 ID를 적으며, 같은 키로 다시 온 요청은 주문을 더 만들지 않고 같은 주문을 돌려준다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const idem = new IdempotencyStore({ clock: s.clock, table: 'order_idempotency' });
    const o = newOrderInput(s.clock);
    const hash = fingerprint(JSON.stringify({ seats: o.items.map((it) => it.seatId) }));
    const run = (order: NewOrder) =>
      database.transaction((tx) =>
        idem.run(
          tx,
          { accountRef: order.accountId, operation: 'CREATE_ORDER', key: order.idempotencyKey, requestHash: hash },
          {
            execute: async () => {
              await s.store.createOrder(tx, order);
              return { resultRef: order.id, value: order.id };
            },
            replay: async (resultRef) => (await s.store.getOrder(tx, resultRef))?.id ?? 'missing',
          },
        ),
      );

    expect(await run(o)).toBe(o.id);
    // 다시 온 요청이 새 주문 ID·새 회차로 만들려 해도 처음 주문을 돌려준다
    const again = newOrderInput(s.clock, { accountId: o.accountId, idempotencyKey: o.idempotencyKey });
    expect(await run(again)).toBe(o.id);

    expect(await count('select count(*) as n from purchase_order where account_id = $1', [o.accountId])).toBe(1);
    expect(await orderRowOf(again.id)).toBeUndefined();
    expect(await outboxOf(again.eventId)).toEqual([]);
    expect((await idemRows(o.accountId)).map((r) => [r.operation, r.idempotency_key, r.result_ref])).toEqual([['CREATE_ORDER', o.idempotencyKey, o.id]]);
  });
});
