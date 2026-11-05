// 결제 결과 반영의 purchase DB 쪽(booking DrizzlePaymentResults: read·approve·fail·mark)과 쓰임새(ApplyPaymentResult)를 실제 PostgreSQL 18로 돈다(BUILD_ORDER PRF-163).
// inventory DrizzleSeatSales.markSoldIn(바깥 트랜잭션)도 여기서 본다.
// 정본: docs/features/payment.md §2 '결제 결과 반영의 첫 구현'(사건 종류 × 지금 상태 → 전이·있을 수 없는 조합과 대조·승인 트랜잭션·실패 트랜잭션·UNKNOWN·입금 대기·커밋 뒤)·
// 'Saga 1단계의 첫 구현'(작업 행의 끝: 실패 기록은 작업 행을 먼저 잡는다, 잠금 차례 작업 행 → 주문 행), §3 전이 표 T9~T17, docs/data.md ticket_issue_job(ERD)·
// §4 여덟 번째 마이그레이션(0007)·§5 '결제 결과 반영' 줄(같은 사건 두 번·결과가 Saga CONFIRM 실행과 겹침·뒤바뀐 차례), 시험 표 P-T2·P-T15,
// booking domain/ports.ts PaymentResultReads·PaymentResultWrites와 adapters/db/drizzle-payment-results.ts·application/apply-payment-result.ts·domain/payment-result.ts 머리 주석.
//
// 약속(saga-db.int.test.ts와 같은 꼴):
// - 마이그레이션은 scripts/migrate.mjs의 migratePurchase, Outbox 일 파티션은 ensureOutboxPartitions(기준 시각의 가짜 시계)로 만든다.
// - 주문은 운영 경로로 만든다: DrizzleOrderStore.createOrder → 결제 시도 READY 행 직접 넣기 → DrizzleOrderAccepts.accept(작업 행 RESERVE).
//   판매 예약 뒤 상태(RESERVED, 판매 행 PENDING·한도, 작업 행 CONFIRM)는 saga-db와 같이 T7 + DrizzleSeatSales.reserve + 작업 행 step 'CONFIRM'(SQL)으로 만든다.
//   UNKNOWN·AWAITING_DEPOSIT은 그 위에 주문 전이 함수(T12·T10, 결제 사건 순번)를 직접 부른다(mark 구현에 기대지 않게).
// - 시각은 시험마다 따로 만든 가짜 시계다. ticket_issue_job·작업 행의 '지금'은 앱 시계(DrizzlePaymentResultsOptions.clock)다.
// - 쓰기 차례는 시험 DB에만 둔 감사 트리거(pr_audit, 운영 표에는 없다)로 본다. 겹침 시험은 ticket_issue_job 삽입마다 쉬는 시험용 트리거(pr_slow, 고른 회차만)로
//   승인 트랜잭션을 늘린다(작업 행을 지운 뒤, 주문 전이 앞).
// - DB 상태는 admin 풀의 직접 SQL로 읽는다. 기대 값(전이 표·사건 모양)은 order-fixtures.ts와 이 파일이 정본에서 따로 적은 것을 쓴다(운영 상수를 기대 값으로 쓰지 않는다).
//
// 정본 모호(ports.ts·drizzle-payment-results.ts·payment-result.ts의 [정함]을 따른다):
// - STALE PAYMENT_SEQ의 current: 주문 전이 함수가 PAYMENT_SEQ에는 current를 싣지 않는다(drizzle-orders.ts staleOf). 그래서 PAYMENT_SEQ는 status·reason만 본다.
// - 없는 주문(NOT_FOUND): 승인은 ticket_issue_job, 실패는 order_saga_job을 넣는데 둘 다 주문 외래 키가 있다. 외래 키 위반(23503)으로 던지지 않고
//   STALE NOT_FOUND로 끝나야 한다고 본다(ports.ts '주문 전이가 0행이면 STALE'). 구현은 주문 행을 먼저 잠가 거르거나 넣기 전에 본다.
// - 같은 승인 둘이 겹치면 진 쪽은 ticket_issue_job 기본 키 위반(23505)으로 던지지 않고 STALE이어야 한다고 본다(data.md §5 '하나만 반영').
// - fail이 기존 작업 행의 confirm_sent_at을 어떻게 두는지는 보지 않는다.
// - 승인의 쓰기 차례는 drizzle-payment-results.ts 머리 주석 그대로 본다: 작업 행 지우기 → 결제 참조 지우기 → 판매 행 SOLD → ticket_issue_job → T9 → 이력 → Outbox.
// 리뷰(2026-11-05) 반영(새 정본):
// - M1: mark(T10·T12·T14)도 남은 결제 참조를 지운다(UNKNOWN·AWAITING_DEPOSIT 사건은 승인 명령이 접수됐다는 뜻). 쓰기 차례: 작업 행 → 결제 시도 → 주문 → 이력(→ Outbox).
// - M2: 닫힌 주문(FAILED·EXPIRED·COMPENSATED)에 APPROVED·AWAITING_DEPOSIT은 CHARGED_ON_CLOSED_ORDER(SEV1)로 보류한다(접수한 결제 시도가 없는 EXPIRED도).
// - M3: DEPOSIT_REVERSED·PARTIAL_CANCELED·CANCELED는 NOT_YET_SUPPORTED로 보류한다(RESOLVED만 건너뛴다).
// - M4: 승인에서 SOLD로 바꾼 판매 행 수가 좌석 수와 다르면 되돌리고 SOLD_MISMATCH(SEV1)로 보류한다.
// - 권고1: 승인은 주문 행을 잠글 때 상태·순번을 보고 맞지 않으면 바로 STALE이다(판매 행·발권 큐 문장까지 가지 않는다).
// - L1: 승인된 주문의 다시 온 사건은 구매 세션 끝내기만 다시 부른다.
import { randomUUID } from 'node:crypto';
import { OrderEvent } from '@peaket/contracts/asyncapi';
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock, requestFingerprint, uuidv7 } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import {
  type AcceptInput,
  ApplyPaymentResult,
  type ApplyPaymentResultOutcome,
  DrizzleOrderAccepts,
  DrizzleOrderStore,
  DrizzlePaymentResults,
  DrizzleSaga,
  type NewOrder,
  type OrderRequestOnce,
  type PaymentApproveInput,
  type PaymentFailInput,
  type PaymentMarkInput,
  type PaymentResultEvent,
  PaymentResultHeld,
  type PaymentResultHoldReason,
  type PaymentResultLog,
  type PaymentResultSeatSales,
  type PaymentResultSessions,
  type PaymentResultWriteOutcome,
  type PaymentRefs,
  type TransitionId,
} from '../src/modules/booking/index.js';
import { DrizzleSeatSales } from '../src/modules/inventory/index.js';
import { accountActor, BASE_MS, CREATED_ONLY, iso, laterEvent, makeItems, messagesOf, newOrderInput, rejections, SAGA, untouchableTx } from './order-fixtures.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let server: PostgresContainer;
/** 어댑터가 쓰는 풀 */
let database: Database;
/** 읽기·준비용 풀 */
let admin: Database;
/** 두 번째 연결 쪽 풀(겹친 Saga 실행·같은 사건 두 번) */
let race: Database;

const APP = 'payment-results-test';
const RACE = 'payment-results-race';
const LIMIT = 4;
const LEASE = 30_000;
const MIN = 60_000;
/** 결제 결과 반영의 행위자(payment-result.ts PAYMENT_RESULT_ACTOR를 가져오지 않고 따로 적는다, ACTOR_PATTERN system:<작업 이름>) */
const PAYMENT_ACTOR = 'system:payment-result';
/** 발권 기한 = 승인 + 30분 [가정](data.md ticket_issue_job.issue_due_at) */
const ISSUE_WINDOW_MS = 30 * MIN;
/** 결제 쪽 실패 사유 여섯(asyncapi PaymentEvent.failureCategory, payment §2 실패 트랜잭션) */
const CATEGORIES = ['CARD_DECLINED', 'USER_ABORTED', 'VALIDATION', 'EXPIRED', 'PG_ERROR', 'THROTTLED'] as const;

beforeAll(async () => {
  server = await startPostgres();
  await migratePurchase(server.url);
  database = createDatabase({ url: server.url, profile: 'general', max: 20, applicationName: APP });
  admin = createDatabase({ url: server.url, profile: 'general', max: 4, applicationName: 'payment-results-admin' });
  race = createDatabase({ url: server.url, profile: 'general', max: 6, applicationName: RACE });
  await ensureOutboxPartitions(admin, fakeClock({ now: BASE_MS }));
  // 시험용 감사 트리거와 느린 삽입 트리거(운영 표에는 없다)
  await admin.pool.query(`
    create table pr_audit (n bigserial primary key, xid bigint not null default txid_current(), tbl text not null, op text not null, row_text text);
    create or replace function pr_audit() returns trigger language plpgsql as $$
    begin
      insert into pr_audit (tbl, op, row_text)
      values (tg_table_name, tg_op, case when tg_op = 'DELETE' then row_to_json(old)::text else row_to_json(new)::text end);
      return null;
    end $$;
    create table pr_slow (event_id uuid primary key, ms int not null);
    create or replace function pr_slow() returns trigger language plpgsql as $$
    declare d int;
    begin
      select ms into d from pr_slow where event_id = new.event_id;
      if d is not null then perform pg_sleep(d / 1000.0); end if;
      return new;
    end $$;
    create trigger pr_slow before insert on ticket_issue_job for each row execute function pr_slow();`);
  for (const t of ['purchase_quota', 'seat_sale', 'order_saga_job', 'purchase_order', 'order_event', 'payment_attempt', 'outbox', 'ticket_issue_job']) {
    await admin.pool.query(`create trigger pr_audit after insert or update or delete on ${t} for each row execute function pr_audit()`);
  }
});

afterAll(async () => {
  await Promise.allSettled([database?.close(), admin?.close(), race?.close()]);
  server?.stop();
});

// ───────────────────────────── 도우미 ─────────────────────────────

const q = async <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> => (await admin.pool.query(text, params)).rows as R[];
const count = async (text: string, params: unknown[] = []): Promise<number> => Number((await q<{ n: string | number }>(text, params))[0]!.n);

/** 시험 하나의 가짜 시계·주문 전이 함수·접수 어댑터·Saga 어댑터·결제 결과 어댑터 */
function fresh(startMs = BASE_MS) {
  const clock = fakeClock({ now: startMs });
  const store = new DrizzleOrderStore({ clock });
  const sales = new DrizzleSeatSales(database);
  return {
    clock,
    store,
    sales,
    accepts: new DrizzleOrderAccepts({ database, store, clock }),
    saga: new DrizzleSaga({ database, store, sales, clock }),
    results: new DrizzlePaymentResults({ database, store, sales, clock }),
  };
}
type Fresh = ReturnType<typeof fresh>;
/** 두 번째 연결 쪽 결제 결과 어댑터(같은 시계·전이 함수) */
const racingResults = (s: Fresh) => new DrizzlePaymentResults({ database: race, store: s.store, sales: new DrizzleSeatSales(race), clock: s.clock });
/** markSoldIn을 부른 수를 세는 결제 결과 어댑터(권고1: STALE이면 판매 행 문장까지 가지 않는다) */
function countingResults(s: Fresh, db: Database = database) {
  const inner = new DrizzleSeatSales(db);
  const calls = { markSoldIn: 0 };
  const sales: PaymentResultSeatSales = {
    markSoldIn: (tx, o) => {
      calls.markSoldIn += 1;
      return inner.markSoldIn(tx, o);
    },
    releasePendingIn: (tx, r) => inner.releasePendingIn(tx, r),
  };
  return { results: new DrizzlePaymentResults({ database: db, store: s.store, sales, clock: s.clock }), calls };
}
const racingSaga = (s: Fresh) => new DrizzleSaga({ database: race, store: s.store, sales: new DrizzleSeatSales(race), clock: s.clock });

async function placed(s: Fresh, o: Partial<NewOrder> = {}): Promise<NewOrder> {
  const order = newOrderInput(s.clock, { items: makeItems(2), ...o });
  await database.transaction((tx) => s.store.createOrder(tx, order));
  return order;
}
/** 전이를 차례로(결제 결과 전이는 [전이, 순번]) */
async function walk(s: Fresh, o: NewOrder, path: readonly (TransitionId | readonly [TransitionId, number])[]): Promise<void> {
  for (const step of path) {
    const [transition, paymentEventSeq] = typeof step === 'string' ? [step, undefined] : step;
    const r = await database.transaction((tx) =>
      s.store.transition(tx, { orderId: o.id, transition, actor: SAGA, ...(paymentEventSeq === undefined ? {} : { paymentEventSeq }) }),
    );
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
  at: number;
}
/** 접수된 주문(ACCEPTED, 시도 ACCEPTED·결제 참조, 작업 RESERVE). 운영 접수 어댑터(PRF-162)로 만든다 */
async function accepted(s: Fresh, x: { refs?: PaymentRefs; order?: Partial<NewOrder> } = {}): Promise<Accepted> {
  const o = await placed(s, x.order);
  const refs = x.refs ?? tossRefs();
  const attemptId = await putAttempt(s, o, refs.pg);
  s.clock.advance(1_000);
  const at = s.clock.now();
  const input: AcceptInput = { orderId: o.id, attemptId, eventId: o.eventId, refs, seatGen: 1, actor: accountActor(o.accountId) };
  expect(await s.accepts.accept(onceOf(o), input)).toEqual({ status: 'ACCEPTED' });
  return { o, attemptId, refs, at };
}
/** 판매 예약 뒤 상태(RESERVED, 판매 행 PENDING·한도, 작업 CONFIRM). saga-db.int.test.ts와 같은 길 */
async function reservedByHand(s: Fresh, a: Accepted): Promise<void> {
  await walk(s, a.o, ['T7']);
  const r = await s.sales.reserve({ eventId: a.o.eventId, orderId: a.o.id, accountId: a.o.accountId, seatIds: a.o.items.map((it) => it.seatId), limit: LIMIT });
  expect(r).toEqual({ status: 'RESERVED' });
  await q(`update order_saga_job set step = 'CONFIRM', attempts = 0 where order_id = $1`, [a.o.id]);
}
/** RESERVED까지 간 주문 */
async function reserved(s: Fresh, x: { refs?: PaymentRefs; order?: Partial<NewOrder> } = {}): Promise<Accepted> {
  const a = await accepted(s, x);
  await reservedByHand(s, a);
  return a;
}

const seatIdsOf = (a: Accepted) => a.o.items.map((it) => it.seatId);
const releaseOf = (a: Accepted) => ({ eventId: a.o.eventId, orderId: a.o.id, accountId: a.o.accountId, seatIds: seatIdsOf(a) });
const approveOf = (s: Fresh, a: Accepted, x: Partial<PaymentApproveInput> = {}): PaymentApproveInput => ({
  orderId: a.o.id,
  transition: 'T9',
  paymentEventSeq: 1,
  actor: PAYMENT_ACTOR,
  eventId: a.o.eventId,
  seatIds: seatIdsOf(a),
  issueDueAtMs: s.clock.now() + ISSUE_WINDOW_MS,
  ...x,
});
const failOf = (a: Accepted, x: Partial<PaymentFailInput> = {}): PaymentFailInput => ({
  orderId: a.o.id,
  transition: 'T11',
  paymentEventSeq: 1,
  actor: PAYMENT_ACTOR,
  failureReason: 'CARD_DECLINED',
  eventId: a.o.eventId,
  release: releaseOf(a),
  ...x,
});
const markOf = (a: Accepted, x: Partial<PaymentMarkInput> = {}): PaymentMarkInput => ({ orderId: a.o.id, transition: 'T12', paymentEventSeq: 1, actor: PAYMENT_ACTOR, ...x });

const orderRow = async (id: string) =>
  (
    await q<{ status: string; event_seq: number; failure_reason: string | null; payment_event_seq: string }>(
      'select status, event_seq, failure_reason, payment_event_seq::text as payment_event_seq from purchase_order where id = $1',
      [id],
    )
  )[0];
const attemptRefs = async (id: string) =>
  (await q<{ pg_payment_key: string | null; pg_tx_id: string | null; pg_payment_token: string | null }>('select pg_payment_key, pg_tx_id, pg_payment_token from payment_attempt where id = $1', [id]))[0];
const NO_REFS = { pg_payment_key: null, pg_tx_id: null, pg_payment_token: null };
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
/** 작업 행의 결과 당기기 쪽 칸(0010, PRF-171): 승인 명령 보낸 시각·다음 당기기 점검 시각 */
const pullColsOf = async (orderId: string) =>
  (await q<{ confirm_sent_at: Date | null; pull_next_at: Date | null }>('select confirm_sent_at, pull_next_at from order_saga_job where order_id = $1', [orderId]))[0];
/** UNKNOWN(T12) 반영 뒤 다음 당기기 점검 30초 [가정], 입금 대기(T10·T14) 반영 뒤 60초 [가정](payment §2 '중간 결과 뒤에도 당긴다', PRF-171) */
const AFTER_UNKNOWN_MS = 30_000;
const AFTER_DEPOSIT_MS = 60_000;
const salesOf = (eventId: string) =>
  q<{ seat_id: string; order_id: string; account_id: string; status: string; pending_until: Date | null }>(
    'select seat_id, order_id, account_id, status, pending_until from seat_sale where event_id = $1 order by seat_id',
    [eventId],
  );
const quotaOf = async (accountId: string, eventId: string) =>
  (await q<{ used: number; limit_count: number }>('select used, limit_count from purchase_quota where account_id = $1 and event_id = $2', [accountId, eventId]))[0];
const issueJobOf = async (orderId: string) =>
  (
    await q<{ event_id: string; attempts: number; next_attempt_at: Date | null; issue_due_at: Date; last_error: string | null; created_at: Date }>(
      'select event_id, attempts, next_attempt_at, issue_due_at, last_error, created_at from ticket_issue_job where order_id = $1',
      [orderId],
    )
  )[0];

/** 아무것도 남지 않았는지 볼 때의 주문 흔적 */
const traceOf = async (a: Accepted) => ({
  order: await orderRow(a.o.id),
  history: (await historyOf(a.o.id)).length,
  outbox: (await outboxOf(a.o.eventId)).map((x) => x.event.type),
  job: await jobOf(a.o.id),
  sales: await salesOf(a.o.eventId),
  quota: await quotaOf(a.o.accountId, a.o.eventId),
  refs: await attemptRefs(a.attemptId),
  issue: await issueJobOf(a.o.id),
});

/** 그 주문의 한 전이(cause)를 쓴 트랜잭션의 행 쓰기 차례(감사 트리거). 이어진 같은 쓰기는 하나로 접고, Outbox 파티션 이름은 outbox로 본다 */
async function writesOfTx(orderId: string, cause: string): Promise<string[]> {
  const rows = await q<{ tbl: string; op: string }>(
    `select tbl, op from pr_audit
      where xid = (select xid from pr_audit where tbl = 'order_event' and op = 'INSERT' and row_text like $1 and row_text like $2 order by n desc limit 1)
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

// ───────────────────────────── read ─────────────────────────────

describe('DrizzlePaymentResults.read(주문 행·항목 좌석·ACCEPTED 결제 시도의 결제사)', () => {
  test('접수한 주문: 주문 칸(상태·금액·payment_event_seq·회차·계정·구매 세션)·좌석(줄 번호 차례)·접수한 시도의 결제사다', async () => {
    const s = fresh();
    const a = await accepted(s);
    expect(await s.results.read(a.o.id)).toEqual({
      orderId: a.o.id,
      status: 'ACCEPTED',
      amount: a.o.amount,
      paymentEventSeq: 0,
      acceptedPg: 'TOSS',
      eventId: a.o.eventId,
      accountId: a.o.accountId,
      purchaseSessionId: a.o.purchaseSessionId,
      seatIds: seatIdsOf(a),
    });
  });

  test('포트원 시도·결제 참조를 지운 뒤(Saga done)도 결제사를 읽고, UNKNOWN(T12 순번 2) 뒤면 paymentEventSeq 2다. 구매 세션 ID가 jti 모양이어도 그대로다', async () => {
    const s = fresh();
    const psid = `jti_${randomUUID().replaceAll('-', '').slice(0, 20)}-x`;
    const a = await reserved(s, { refs: portoneRefs(), order: { purchaseSessionId: psid } });
    expect(await s.saga.done(a.o.id)).toBe(true);
    await walk(s, a.o, [['T12', 2]]);
    expect(await s.results.read(a.o.id)).toMatchObject({ status: 'UNKNOWN', paymentEventSeq: 2, acceptedPg: 'PORTONE', purchaseSessionId: psid, seatIds: seatIdsOf(a) });
  });

  test('접수 전(CREATED, READY 시도만)이면 acceptedPg가 없다', async () => {
    const s = fresh();
    const o = await placed(s);
    await putAttempt(s, o);
    const r = await s.results.read(o.id);
    expect(r).toMatchObject({ orderId: o.id, status: 'CREATED', paymentEventSeq: 0 });
    expect(r?.acceptedPg).toBeUndefined();
  });

  test.each<[string, (id: string) => string]>([
    ['없는 주문', () => uuidv7(fakeClock({ now: BASE_MS }))],
    ['대문자 UUID', (id) => id.toUpperCase()],
    ['UUID가 아님', () => 'order-1'],
    ['빈 글', () => ''],
  ])('%s면 undefined다(던지지 않는다)', async (_label, idOf) => {
    const s = fresh();
    const a = await accepted(s);
    expect((await s.results.read(a.o.id))?.orderId).toBe(a.o.id);
    expect(await s.results.read(idOf(a.o.id))).toBeUndefined();
  });
});

// ───────────────────────────── approve ─────────────────────────────

describe('DrizzlePaymentResults.approve(한 트랜잭션: 작업 행 정리 → 판매 행 SOLD → ticket_issue_job → T9·T13·T16)', () => {
  test('T9: 주문 APPROVED·payment_event_seq, 판매 행 SOLD(pending_until 비움)·한도 그대로, ticket_issue_job 한 행(attempts 0·지금·발권 기한), CONFIRM 작업 행·결제 참조 지움, 이력 T9, Outbox APPROVED [ASVS v5.0.0-2.3.1] [ASVS v5.0.0-14.2.4]', async () => {
    const s = fresh();
    const a = await reserved(s);
    s.clock.advance(4_000);
    const at = s.clock.now();
    const due = at + ISSUE_WINDOW_MS + 7;

    expect(await s.results.approve(approveOf(s, a, { paymentEventSeq: 3, issueDueAtMs: due }))).toEqual({ status: 'APPLIED' });

    expect(await orderRow(a.o.id)).toEqual({ status: 'APPROVED', event_seq: 5, failure_reason: null, payment_event_seq: '3' });
    expect(await salesOf(a.o.eventId)).toEqual(
      [...seatIdsOf(a)].sort().map((seat_id) => ({ seat_id, order_id: a.o.id, account_id: a.o.accountId, status: 'SOLD', pending_until: null })),
    );
    expect(await quotaOf(a.o.accountId, a.o.eventId)).toEqual({ used: 2, limit_count: LIMIT });
    expect(await issueJobOf(a.o.id)).toEqual({ event_id: a.o.eventId, attempts: 0, next_attempt_at: new Date(at), issue_due_at: new Date(due), last_error: null, created_at: new Date(at) });
    expect(await jobOf(a.o.id)).toBeUndefined();
    expect(await attemptRefs(a.attemptId)).toEqual(NO_REFS);
    expect((await historyOf(a.o.id)).at(-1)).toEqual({ seq: 5, from_status: 'RESERVED', to_status: 'APPROVED', cause: 'T9', actor: PAYMENT_ACTOR, occurred_at: new Date(at) });
    const outbox = await outboxOf(a.o.eventId);
    expect(outbox.map((x) => x.event.type)).toEqual(['CREATED', 'ACCEPTED', 'RESERVED', 'APPROVED']);
    // 단계(APPROVED)에 처음 들어왔다(ADR-0099)
    expect(outbox[3]!.event).toMatchObject(laterEvent(a.o, 'APPROVED', 5, at, true));
    for (const k of CREATED_ONLY) expect(outbox[3]!.event).not.toHaveProperty(k);
    expect(contractIssues(outbox[3]!.event)).toEqual([]);
    for (const x of outbox) expect(x.raw).not.toContain((a.refs as { paymentKey: string }).paymentKey);
  });

  test('쓰기 차례: 작업 행 지우기 → 결제 참조 지우기 → 판매 행 SOLD → ticket_issue_job → 주문 전이 → 이력 → Outbox가 마지막이다(한 트랜잭션, 잠금 차례 작업 행이 먼저) [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const a = await reserved(s, { refs: portoneRefs() });
    expect(await s.results.approve(approveOf(s, a))).toEqual({ status: 'APPLIED' });
    expect(await writesOfTx(a.o.id, 'T9')).toEqual([
      'DELETE order_saga_job',
      'UPDATE payment_attempt',
      'UPDATE seat_sale',
      'INSERT ticket_issue_job',
      'UPDATE purchase_order',
      'INSERT order_event',
      'INSERT outbox',
    ]);
    expect(await attemptRefs(a.attemptId)).toEqual(NO_REFS);
  });

  test('Saga done이 먼저 끝나 결제 참조가 없고 작업 행이 AWAIT(PRF-171)여도 승인하고, 그 행을 단계와 상관없이 지운다', async () => {
    const s = fresh();
    const a = await reserved(s);
    expect(await s.saga.done(a.o.id)).toBe(true);
    expect((await jobOf(a.o.id))?.step).toBe('AWAIT');
    expect(await s.results.approve(approveOf(s, a))).toEqual({ status: 'APPLIED' });
    expect(await orderRow(a.o.id)).toMatchObject({ status: 'APPROVED', payment_event_seq: '1' });
    expect((await salesOf(a.o.eventId)).map((x) => x.status)).toEqual(['SOLD', 'SOLD']);
    expect((await issueJobOf(a.o.id))?.attempts).toBe(0);
    expect(await jobOf(a.o.id)).toBeUndefined();
  });

  test.each<[string, readonly (TransitionId | readonly [TransitionId, number])[], 'T13' | 'T16', 'UNKNOWN' | 'AWAITING_DEPOSIT']>([
    ['T13(UNKNOWN → APPROVED)', [['T12', 1]], 'T13', 'UNKNOWN'],
    ['T16(AWAITING_DEPOSIT → APPROVED)', [['T10', 1]], 'T16', 'AWAITING_DEPOSIT'],
  ])('%s: 판매 행 SOLD·ticket_issue_job·APPROVED 사건이고 출발은 그 상태다 [ASVS v5.0.0-2.3.1]', async (_label, path, transition, from) => {
    const s = fresh();
    const a = await reserved(s);
    await walk(s, a.o, path);
    // mark(T12·T10)가 남기는 AWAIT 행을 손으로 만든다(PRF-171: 중간 결과 뒤에도 당긴다. 승인은 작업 행을 단계와 상관없이 지운다)
    await q(`update order_saga_job set step = 'AWAIT' where order_id = $1`, [a.o.id]);
    s.clock.advance(1_000);
    const at = s.clock.now();

    expect(await s.results.approve(approveOf(s, a, { transition, paymentEventSeq: 2 }))).toEqual({ status: 'APPLIED' });

    expect(await orderRow(a.o.id)).toMatchObject({ status: 'APPROVED', event_seq: 6, payment_event_seq: '2' });
    expect((await historyOf(a.o.id)).at(-1)).toEqual({ seq: 6, from_status: from, to_status: 'APPROVED', cause: transition, actor: PAYMENT_ACTOR, occurred_at: new Date(at) });
    expect((await outboxOf(a.o.eventId)).at(-1)!.event).toMatchObject(laterEvent(a.o, 'APPROVED', 6, at, true));
    expect((await salesOf(a.o.eventId)).map((x) => x.status)).toEqual(['SOLD', 'SOLD']);
    expect(await issueJobOf(a.o.id)).toMatchObject({ event_id: a.o.eventId, attempts: 0 });
    expect(await jobOf(a.o.id)).toBeUndefined();
  });

  test.each<[string, readonly (TransitionId | readonly [TransitionId, number])[], number, Record<string, unknown>]>([
    ['PAYMENT_SEQ 같은 순번(UNKNOWN 순번 2에 T13 순번 2)', [['T12', 2]], 2, { status: 'STALE', reason: 'PAYMENT_SEQ' }],
    ['PAYMENT_SEQ 낮은 순번(UNKNOWN 순번 2에 T13 순번 1)', [['T12', 2]], 1, { status: 'STALE', reason: 'PAYMENT_SEQ' }],
  ])('STALE %s: 트랜잭션째 되돌려 작업 행·판매 행·결제 참조·ticket_issue_job이 그대로다 [ASVS v5.0.0-15.4.1]', async (_label, path, seq, want) => {
    const s = fresh();
    const a = await reserved(s);
    await walk(s, a.o, path);
    const before = await traceOf(a);
    expect(before.job).toMatchObject({ step: 'CONFIRM' });

    expect(await s.results.approve(approveOf(s, a, { transition: 'T13', paymentEventSeq: seq }))).toMatchObject(want);

    expect(await traceOf(a)).toEqual(before);
    expect(before.issue).toBeUndefined();
  });

  test.each<[string, 'reserved' | readonly TransitionId[], string]>([
    ['ACCEPTED 주문에 T9(작업 행 RESERVE가 남는다)', [], 'ACCEPTED'],
    ['이미 APPROVED인 주문에 T9', 'reserved', 'APPROVED'],
    ['FAILED(T8) 주문에 T9', ['T8'], 'FAILED'],
  ])('STALE STATUS(%s): current가 지금 상태이고 아무것도 남지 않는다 [ASVS v5.0.0-15.4.1]', async (_label, path, current) => {
    const s = fresh();
    const a = await accepted(s);
    if (path === 'reserved') {
      await reservedByHand(s, a);
      expect(await s.results.approve(approveOf(s, a, { paymentEventSeq: 1 }))).toEqual({ status: 'APPLIED' });
    } else await walk(s, a.o, path);
    const before = await traceOf(a);

    expect(await s.results.approve(approveOf(s, a, { paymentEventSeq: 5 }))).toEqual({ status: 'STALE', reason: 'STATUS', current });

    expect(await traceOf(a)).toEqual(before);
  });

  test.each<[string, 'ACCEPTED' | 'UNKNOWN', PaymentApproveInput['transition'], number, Record<string, unknown>]>([
    ['STATUS: ACCEPTED 주문에 T9', 'ACCEPTED', 'T9', 1, { status: 'STALE', reason: 'STATUS', current: 'ACCEPTED' }],
    ['PAYMENT_SEQ: UNKNOWN 순번 2에 T13 순번 2', 'UNKNOWN', 'T13', 2, { status: 'STALE', reason: 'PAYMENT_SEQ' }],
  ])('권고1_STALE(%s)이면 주문 행을 잠글 때 바로 끝나 판매 행 SOLD·발권 큐 문장까지 가지 않는다(markSoldIn 0번) [ASVS v5.0.0-15.4.1]', async (_label, state, transition, seq, want) => {
    const s = fresh();
    const a = await accepted(s);
    if (state === 'UNKNOWN') {
      await reservedByHand(s, a);
      await walk(s, a.o, [['T12', 2]]);
    }
    const before = await traceOf(a);
    const c = countingResults(s);
    expect(await c.results.approve(approveOf(s, a, { transition, paymentEventSeq: seq }))).toEqual(want);
    expect(c.calls.markSoldIn).toBe(0);
    expect(await traceOf(a)).toEqual(before);
  });

  test('M4_판매 행 PENDING을 지운 RESERVED 주문에 승인하면 바꾼 판매 행 수(0)가 좌석 수(2)와 달라 되돌리고 SOLD_MISMATCH다: 주문 RESERVED·작업 행·결제 참조 그대로, ticket_issue_job 없음 [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const a = await reserved(s);
    await q('delete from seat_sale where order_id = $1', [a.o.id]);
    const before = await traceOf(a);
    expect(await s.results.approve(approveOf(s, a))).toEqual({ status: 'SOLD_MISMATCH' });
    expect(await traceOf(a)).toEqual(before);
    expect(before.order).toMatchObject({ status: 'RESERVED' });
    expect(before.job).toMatchObject({ step: 'CONFIRM' });
    expect(before.issue).toBeUndefined();
  });

  test('M4_판매 행 하나만 남은 주문(좌석 둘)에 승인하면 SOLD_MISMATCH이고 남은 행도 PENDING 그대로다 [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const a = await reserved(s);
    await q('delete from seat_sale where order_id = $1 and seat_id = $2', [a.o.id, seatIdsOf(a)[0]]);
    expect(await s.results.approve(approveOf(s, a))).toEqual({ status: 'SOLD_MISMATCH' });
    expect((await salesOf(a.o.eventId)).map((x) => [x.seat_id, x.status])).toEqual([[seatIdsOf(a)[1], 'PENDING']]);
    expect(await orderRow(a.o.id)).toMatchObject({ status: 'RESERVED', payment_event_seq: '0' });
  });

  test('STALE NOT_FOUND: 없는 주문이면 외래 키 위반으로 던지지 않고 STALE NOT_FOUND이며 ticket_issue_job이 남지 않는다(정본 모호: 머리 주석)', async () => {
    const s = fresh();
    const a = await reserved(s);
    const ghost = uuidv7(s.clock);
    expect(await s.results.approve(approveOf(s, a, { orderId: ghost }))).toEqual({ status: 'STALE', reason: 'NOT_FOUND' });
    expect(await issueJobOf(ghost)).toBeUndefined();
    // 남의 판매 행(같은 회차·좌석)은 그대로다
    expect((await salesOf(a.o.eventId)).map((x) => x.status)).toEqual(['PENDING', 'PENDING']);
  });

  test.each<[string, (i: PaymentApproveInput) => PaymentApproveInput]>([
    ['orderId가 UUID가 아님', (i) => ({ ...i, orderId: 'order-1' })],
    ['eventId가 대문자 UUID', (i) => ({ ...i, eventId: i.eventId.toUpperCase() })],
    ['순번 0', (i) => ({ ...i, paymentEventSeq: 0 })],
    ['순번 소수', (i) => ({ ...i, paymentEventSeq: 1.5 })],
    ['행위자 모양이 틀림', (i) => ({ ...i, actor: 'payment-result' })],
    ['승인 갈래가 아닌 전이', (i) => ({ ...i, transition: 'T11' as 'T9' })],
    ['좌석 없음', (i) => ({ ...i, seatIds: [] })],
    ['좌석 11개', (i) => ({ ...i, seatIds: Array.from({ length: 11 }, () => randomUUID()) })],
    ['좌석 ID가 UUID가 아님', (i) => ({ ...i, seatIds: ['A01'] })],
    ['발권 기한 NaN', (i) => ({ ...i, issueDueAtMs: Number.NaN })],
  ])('입력이 틀리면(%s) RangeError이고 아무것도 바뀌지 않으며, 맞는 입력은 APPLIED다 [ASVS v5.0.0-2.2.1]', async (_label, change) => {
    const s = fresh();
    const a = await reserved(s);
    const good = approveOf(s, a);
    const before = await traceOf(a);
    await expect(s.results.approve(change(good))).rejects.toThrow(RangeError);
    expect(await traceOf(a)).toEqual(before);
    expect(await s.results.approve(good)).toEqual({ status: 'APPLIED' });
  });
});

// ───────────────────────────── fail ─────────────────────────────

describe('DrizzlePaymentResults.fail(한 트랜잭션: 작업 행 RELEASE → failure_reason → PENDING 지우기 → 결제 참조 지우기 → T11·T15·T17)', () => {
  test.each(CATEGORIES)(
    'PT2_T11(%s): 주문 FAILED·failure_reason = 그 사유·payment_event_seq, 판매 행 PENDING 지움·한도 되돌림, 결제 참조 지움, 작업 행 RELEASE(attempts 0·지금·임대 비움), Outbox FAILED, ticket_issue_job 없음 [ASVS v5.0.0-2.3.1] [ASVS v5.0.0-14.2.4]',
    async (category) => {
      const s = fresh();
      const a = await reserved(s);
      s.clock.advance(3_000);
      const at = s.clock.now();

      expect(await s.results.fail(failOf(a, { failureReason: category, paymentEventSeq: 2 }))).toEqual({ status: 'APPLIED' });

      expect(await orderRow(a.o.id)).toEqual({ status: 'FAILED', event_seq: 5, failure_reason: category, payment_event_seq: '2' });
      expect(await salesOf(a.o.eventId)).toEqual([]);
      expect(await quotaOf(a.o.accountId, a.o.eventId)).toEqual({ used: 0, limit_count: LIMIT });
      expect(await attemptRefs(a.attemptId)).toEqual(NO_REFS);
      expect(await jobOf(a.o.id)).toEqual({ event_id: a.o.eventId, step: 'RELEASE', attempts: 0, next_attempt_at: new Date(at), lease_until: null });
      expect((await historyOf(a.o.id)).at(-1)).toEqual({ seq: 5, from_status: 'RESERVED', to_status: 'FAILED', cause: 'T11', actor: PAYMENT_ACTOR, occurred_at: new Date(at) });
      const outbox = await outboxOf(a.o.eventId);
      expect(outbox.map((x) => x.event.type)).toEqual(['CREATED', 'ACCEPTED', 'RESERVED', 'FAILED']);
      expect(outbox[3]!.event).toMatchObject(laterEvent(a.o, 'FAILED', 5, at, false));
      expect(contractIssues(outbox[3]!.event)).toEqual([]);
      expect(await issueJobOf(a.o.id)).toBeUndefined();
    },
  );

  test('쓰기 차례: 작업 행(RELEASE) → 주문 failure_reason → 판매 행 지우기 → 한도 → 결제 시도 → 주문 전이 → 이력 → Outbox가 마지막이다(Saga T11과 같은 잠금 차례) [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const a = await reserved(s);
    expect(await s.results.fail(failOf(a))).toEqual({ status: 'APPLIED' });
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

  test('Saga가 CONFIRM 작업을 임대 중이어도 작업 행을 RELEASE로 바꾸고 임대를 비운다(커밋 뒤 kick이 곧바로 집게) [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const a = await reserved(s);
    const held = await s.saga.claim(a.o.id, LEASE);
    expect(held?.leaseUntilMs).toBe(s.clock.now() + LEASE);
    s.clock.advance(500);
    expect(await s.results.fail(failOf(a))).toEqual({ status: 'APPLIED' });
    expect(await jobOf(a.o.id)).toEqual({ event_id: a.o.eventId, step: 'RELEASE', attempts: 0, next_attempt_at: new Date(s.clock.now()), lease_until: null });
    // 지금 집을 수 있다(실행기의 RELEASE 단계)
    expect(await s.saga.claim(a.o.id, LEASE)).toMatchObject({ orderId: a.o.id, step: 'RELEASE' });
  });

  test.each<[string, TransitionId, 'T15' | 'T17', 'UNKNOWN' | 'AWAITING_DEPOSIT']>([
    ['T15(UNKNOWN → FAILED)', 'T12', 'T15', 'UNKNOWN'],
    ['T17(AWAITING_DEPOSIT → FAILED)', 'T10', 'T17', 'AWAITING_DEPOSIT'],
  ])('%s: 작업 행이 없으면 RELEASE 행을 넣는다(event_id·attempts 0·지금·임대 없음)이고, 쓰기 차례의 첫 문장이 그 삽입이다 [ASVS v5.0.0-2.3.1]', async (_label, mark, transition, from) => {
    const s = fresh();
    const a = await reserved(s);
    await walk(s, a.o, [[mark, 1]]);
    // 작업 행이 없는 경우를 손으로 만든다(PRF-171 뒤로 mark는 작업 행을 AWAIT로 남기므로 손질·옛 행의 길이다)
    await q('delete from order_saga_job where order_id = $1', [a.o.id]);
    s.clock.advance(2_000);
    const at = s.clock.now();

    expect(await s.results.fail(failOf(a, { transition, paymentEventSeq: 2, failureReason: 'EXPIRED' }))).toEqual({ status: 'APPLIED' });

    expect(await orderRow(a.o.id)).toMatchObject({ status: 'FAILED', failure_reason: 'EXPIRED', payment_event_seq: '2' });
    expect((await historyOf(a.o.id)).at(-1)).toMatchObject({ from_status: from, to_status: 'FAILED', cause: transition, actor: PAYMENT_ACTOR });
    expect(await jobOf(a.o.id)).toEqual({ event_id: a.o.eventId, step: 'RELEASE', attempts: 0, next_attempt_at: new Date(at), lease_until: null });
    expect(await salesOf(a.o.eventId)).toEqual([]);
    expect(await quotaOf(a.o.accountId, a.o.eventId)).toEqual({ used: 0, limit_count: LIMIT });
    expect((await writesOfTx(a.o.id, transition))[0]).toBe('INSERT order_saga_job');
  });

  test('그 주문·계정의 PENDING만 지운다(같은 회차 다른 주문의 판매 행·한도는 그대로)', async () => {
    const s = fresh();
    const a = await reserved(s);
    const otherAccount = randomUUID();
    const otherSeat = randomUUID();
    expect(await s.sales.reserve({ eventId: a.o.eventId, orderId: uuidv7(s.clock), accountId: otherAccount, seatIds: [otherSeat], limit: LIMIT })).toEqual({ status: 'RESERVED' });
    expect(await s.results.fail(failOf(a))).toEqual({ status: 'APPLIED' });
    expect((await salesOf(a.o.eventId)).map((x) => [x.seat_id, x.account_id, x.status])).toEqual([[otherSeat, otherAccount, 'PENDING']]);
    expect(await quotaOf(otherAccount, a.o.eventId)).toEqual({ used: 1, limit_count: LIMIT });
  });

  test.each<[string, 'reserved' | readonly (TransitionId | readonly [TransitionId, number])[], PaymentFailInput['transition'], number, Record<string, unknown>]>([
    ['STATUS: ACCEPTED 주문에 T11', [], 'T11', 1, { status: 'STALE', reason: 'STATUS', current: 'ACCEPTED' }],
    ['STATUS: FAILED(T8) 주문에 T11', ['T8'], 'T11', 1, { status: 'STALE', reason: 'STATUS', current: 'FAILED' }],
    ['PAYMENT_SEQ: UNKNOWN 순번 3에 T15 순번 3', 'reserved', 'T15', 3, { status: 'STALE', reason: 'PAYMENT_SEQ' }],
  ])('STALE(%s): 트랜잭션째 되돌려 작업 행·failure_reason·판매 행·한도·결제 참조가 그대로다 [ASVS v5.0.0-15.4.1]', async (_label, path, transition, seq, want) => {
    const s = fresh();
    const a = await accepted(s);
    if (path === 'reserved') {
      await reservedByHand(s, a);
      await walk(s, a.o, [['T12', 3]]);
    } else await walk(s, a.o, path);
    const before = await traceOf(a);

    expect(await s.results.fail(failOf(a, { transition, paymentEventSeq: seq }))).toMatchObject(want);

    expect(await traceOf(a)).toEqual(before);
  });

  test('STALE NOT_FOUND: 없는 주문이면 작업 행 외래 키 위반으로 던지지 않고 STALE NOT_FOUND이며 작업 행이 남지 않는다(정본 모호: 머리 주석)', async () => {
    const s = fresh();
    const a = await reserved(s);
    const ghost = uuidv7(s.clock);
    expect(await s.results.fail(failOf(a, { orderId: ghost, release: { ...releaseOf(a), orderId: ghost } }))).toEqual({ status: 'STALE', reason: 'NOT_FOUND' });
    expect(await jobOf(ghost)).toBeUndefined();
    expect((await salesOf(a.o.eventId)).map((x) => x.status)).toEqual(['PENDING', 'PENDING']);
  });

  test.each<[string, (a: Accepted) => PaymentFailInput]>([
    ['release.orderId가 주문과 다름', (a) => failOf(a, { release: { ...releaseOf(a), orderId: uuidv7(fakeClock({ now: BASE_MS })) } })],
    ['모르는 실패 사유', (a) => failOf(a, { failureReason: 'DECLINED' as 'EXPIRED' })],
    ['실패 갈래가 아닌 전이', (a) => failOf(a, { transition: 'T9' as 'T11' })],
    ['순번 음수', (a) => failOf(a, { paymentEventSeq: -1 })],
    ['orderId가 UUID가 아님', (a) => failOf(a, { orderId: 'order-1' })],
    ['행위자 모양이 틀림', (a) => failOf(a, { actor: 'payment' })],
  ])('입력이 틀리면(%s) RangeError이고 아무것도 바뀌지 않으며, 맞는 입력은 APPLIED다 [ASVS v5.0.0-2.2.1]', async (_label, bad) => {
    const s = fresh();
    const a = await reserved(s);
    const before = await traceOf(a);
    await expect(s.results.fail(bad(a))).rejects.toThrow(RangeError);
    expect(await traceOf(a)).toEqual(before);
    expect(await s.results.fail(failOf(a))).toEqual({ status: 'APPLIED' });
  });
});

// ───────────────────────────── mark ─────────────────────────────

// PRF-171(추천 적용 2026-11-06, payment §2 '중간 결과 뒤에도 당긴다'): T12·T10·T14는 작업 행을 지우지 않고 AWAIT로 남겨(confirm_sent_at 그대로)
// pull_next_at을 UNKNOWN이면 지금 + 30초 [가정], 입금 대기면 지금 + 60초 [가정]로 둔다. 첫 문장은 그대로 작업 행이다(잠금 차례 작업 행 → 주문 행)
describe('DrizzlePaymentResults.mark(한 트랜잭션: 작업 행 AWAIT·다음 당기기 점검 → T10·T12·T14, 판매 행 PENDING 그대로)', () => {
  test('T12(RESERVED → UNKNOWN): 작업 행을 AWAIT로 남기고(pull_next_at = 지금 + 30초) 주문만 바꾼다(사건 없이 이력만). 판매 행 PENDING·한도 그대로, ticket_issue_job 없음 [ASVS v5.0.0-2.3.1] [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const a = await reserved(s);
    s.clock.advance(1_000);
    const at = s.clock.now();
    const outboxBefore = (await outboxOf(a.o.eventId)).map((x) => x.event.type);

    expect(await s.results.mark(markOf(a, { paymentEventSeq: 4 }))).toEqual({ status: 'APPLIED' });

    expect(await orderRow(a.o.id)).toEqual({ status: 'UNKNOWN', event_seq: 5, failure_reason: null, payment_event_seq: '4' });
    expect((await historyOf(a.o.id)).at(-1)).toEqual({ seq: 5, from_status: 'RESERVED', to_status: 'UNKNOWN', cause: 'T12', actor: PAYMENT_ACTOR, occurred_at: new Date(at) });
    expect((await outboxOf(a.o.eventId)).map((x) => x.event.type)).toEqual(outboxBefore);
    expect(await jobOf(a.o.id)).toMatchObject({ event_id: a.o.eventId, step: 'AWAIT' });
    expect((await pullColsOf(a.o.id))?.pull_next_at).toEqual(new Date(at + AFTER_UNKNOWN_MS));
    expect((await salesOf(a.o.eventId)).map((x) => x.status)).toEqual(['PENDING', 'PENDING']);
    expect(await quotaOf(a.o.accountId, a.o.eventId)).toEqual({ used: 2, limit_count: LIMIT });
    expect(await issueJobOf(a.o.id)).toBeUndefined();
    // 남은 결제 참조도 지운다(리뷰 M1: UNKNOWN 사건은 승인 명령이 접수됐다는 뜻)
    expect(await attemptRefs(a.attemptId)).toEqual(NO_REFS);
    expect(await writesOfTx(a.o.id, 'T12')).toEqual(['UPDATE order_saga_job', 'UPDATE payment_attempt', 'UPDATE purchase_order', 'INSERT order_event']);
  });

  test('T10(RESERVED → AWAITING_DEPOSIT): 작업 행을 AWAIT로 남기고(pull_next_at = 지금 + 60초) AWAITING_DEPOSIT 사건이 Outbox 마지막이며 판매 행 PENDING은 그대로다 [ASVS v5.0.0-2.3.1] [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const a = await reserved(s);
    const at = s.clock.now();
    expect(await s.results.mark(markOf(a, { transition: 'T10' }))).toEqual({ status: 'APPLIED' });
    expect(await orderRow(a.o.id)).toMatchObject({ status: 'AWAITING_DEPOSIT', payment_event_seq: '1' });
    const outbox = await outboxOf(a.o.eventId);
    expect(outbox.at(-1)!.event).toMatchObject(laterEvent(a.o, 'AWAITING_DEPOSIT', 5, at, false));
    expect(contractIssues(outbox.at(-1)!.event)).toEqual([]);
    expect(await jobOf(a.o.id)).toMatchObject({ event_id: a.o.eventId, step: 'AWAIT' });
    expect((await pullColsOf(a.o.id))?.pull_next_at).toEqual(new Date(at + AFTER_DEPOSIT_MS));
    expect((await salesOf(a.o.eventId)).map((x) => x.status)).toEqual(['PENDING', 'PENDING']);
    expect(await attemptRefs(a.attemptId)).toEqual(NO_REFS);
    expect(await writesOfTx(a.o.id, 'T10')).toEqual(['UPDATE order_saga_job', 'UPDATE payment_attempt', 'UPDATE purchase_order', 'INSERT order_event', 'INSERT outbox']);
  });

  test('M1_Saga가 승인 명령 RETRYABLE로 다시 하기를 기다리는 사이(작업 CONFIRM·보낸 시각 있음·결제 참조 남음) AWAITING_DEPOSIT이 오면 T10 뒤 작업 행이 AWAIT(보낸 시각 그대로)이고 결제 참조가 비어 있다 [ASVS v5.0.0-14.2.4]', async () => {
    const s = fresh();
    const a = await reserved(s, { refs: portoneRefs() });
    const held = await s.saga.claim(a.o.id, LEASE);
    expect(await s.saga.markConfirmSent(a.o.id, held!.leaseUntilMs)).toBe(true);
    const sentAt = s.clock.now();
    expect(await s.saga.reschedule(a.o.id, s.clock.now() + 2_000, held!.leaseUntilMs)).toBe(true);
    expect(await jobOf(a.o.id)).toMatchObject({ step: 'CONFIRM', attempts: 1, lease_until: null });
    expect(await attemptRefs(a.attemptId)).not.toEqual(NO_REFS);

    expect(await s.results.mark(markOf(a, { transition: 'T10' }))).toEqual({ status: 'APPLIED' });

    expect(await orderRow(a.o.id)).toMatchObject({ status: 'AWAITING_DEPOSIT', payment_event_seq: '1' });
    expect((await jobOf(a.o.id))?.step).toBe('AWAIT');
    expect(await pullColsOf(a.o.id)).toEqual({ confirm_sent_at: new Date(sentAt), pull_next_at: new Date(s.clock.now() + AFTER_DEPOSIT_MS) });
    expect(await attemptRefs(a.attemptId)).toEqual(NO_REFS);
    // 다시 하기 기한이 와도 집을 작업이 없다(승인 명령을 다시 보내지 않는다)
    s.clock.advance(3_000);
    expect(await s.saga.claim(a.o.id, LEASE)).toBeUndefined();
  });

  test('권고1_mark도 주문 행을 잠글 때 상태·순번이 맞지 않으면 바로 STALE이다(T14 순번이 이미 반영한 것 이하)', async () => {
    const s = fresh();
    const a = await reserved(s);
    expect(await s.results.mark(markOf(a, { transition: 'T12', paymentEventSeq: 3 }))).toEqual({ status: 'APPLIED' });
    const before = await traceOf(a);
    expect(await s.results.mark(markOf(a, { transition: 'T14', paymentEventSeq: 3 }))).toEqual({ status: 'STALE', reason: 'PAYMENT_SEQ' });
    expect(await s.results.mark(markOf(a, { transition: 'T10', paymentEventSeq: 4 }))).toEqual({ status: 'STALE', reason: 'STATUS', current: 'UNKNOWN' });
    expect(await traceOf(a)).toEqual(before);
  });

  test('T14(UNKNOWN → AWAITING_DEPOSIT): T12가 남긴 AWAIT 행을 그대로 두고 다음 점검을 입금 대기 간격(지금 + 60초)으로 바꾼다(순번이 더 커야 한다)', async () => {
    const s = fresh();
    const a = await reserved(s);
    expect(await s.results.mark(markOf(a, { transition: 'T12', paymentEventSeq: 1 }))).toEqual({ status: 'APPLIED' });
    expect((await pullColsOf(a.o.id))?.pull_next_at).toEqual(new Date(s.clock.now() + AFTER_UNKNOWN_MS));
    expect(await s.results.mark(markOf(a, { transition: 'T14', paymentEventSeq: 1 }))).toMatchObject({ status: 'STALE', reason: 'PAYMENT_SEQ' });
    // 되돌린 쓰기는 다음 점검 시각도 남기지 않는다
    expect((await pullColsOf(a.o.id))?.pull_next_at).toEqual(new Date(s.clock.now() + AFTER_UNKNOWN_MS));
    s.clock.advance(1_000);
    expect(await s.results.mark(markOf(a, { transition: 'T14', paymentEventSeq: 2 }))).toEqual({ status: 'APPLIED' });
    expect(await orderRow(a.o.id)).toMatchObject({ status: 'AWAITING_DEPOSIT', payment_event_seq: '2' });
    expect((await historyOf(a.o.id)).slice(-2).map((h) => h.cause)).toEqual(['T12', 'T14']);
    expect((await jobOf(a.o.id))?.step).toBe('AWAIT');
    expect((await pullColsOf(a.o.id))?.pull_next_at).toEqual(new Date(s.clock.now() + AFTER_DEPOSIT_MS));
  });

  test('STALE STATUS(ACCEPTED 주문에 T12): 되돌려 작업 행 RESERVE가 그대로다. 입력이 틀리면(상태만 갈래가 아닌 전이·순번 0) RangeError [ASVS v5.0.0-2.2.1] [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const a = await accepted(s);
    const before = await traceOf(a);
    expect(await s.results.mark(markOf(a))).toEqual({ status: 'STALE', reason: 'STATUS', current: 'ACCEPTED' });
    expect(await traceOf(a)).toEqual(before);
    await expect(s.results.mark(markOf(a, { transition: 'T9' as 'T12' }))).rejects.toThrow(RangeError);
    await expect(s.results.mark(markOf(a, { paymentEventSeq: 0 }))).rejects.toThrow(RangeError);
    expect(await traceOf(a)).toEqual(before);
  });
});

// ───────────────────────────── 동시성(data.md §5 '결제 결과 반영') ─────────────────────────────

describe('결제 결과 반영 동시성(data.md §5: 같은 사건 두 번·Saga CONFIRM과 겹침)', () => {
  test('PT15_같은 승인을 두 연결이 동시에 쓰면 하나만 APPLIED이고 다른 하나는 STALE이며(던지지 않는다) 이력·Outbox·ticket_issue_job이 하나씩이다(세 번) [ASVS v5.0.0-15.4.1]', async () => {
    for (let round = 0; round < 3; round += 1) {
      const s = fresh();
      const a = await reserved(s);
      const input = approveOf(s, a, { paymentEventSeq: 2 });
      const one = countingResults(s);
      const two = countingResults(s, race);

      const settled = await Promise.allSettled([one.results.approve(input), two.results.approve(input)]);

      expect(rejections(settled), `${round}회`).toEqual([]);
      const out = settled.map((r) => (r as PromiseFulfilledResult<PaymentResultWriteOutcome>).value);
      expect(out.map((r) => r.status).sort(), `${round}회`).toEqual(['APPLIED', 'STALE']);
      expect((await historyOf(a.o.id)).map((h) => h.cause), `${round}회`).toEqual(['T1', 'T3', 'T4', 'T7', 'T9']);
      expect((await outboxOf(a.o.eventId)).filter((x) => x.event.type === 'APPROVED'), `${round}회`).toHaveLength(1);
      expect(await count('select count(*) as n from ticket_issue_job where order_id = $1', [a.o.id]), `${round}회`).toBe(1);
      expect((await salesOf(a.o.eventId)).map((x) => x.status), `${round}회`).toEqual(['SOLD', 'SOLD']);
      // 진 쪽은 주문 행 잠금에서 STALE로 끝나 판매 행 문장을 부르지 않는다(권고1)
      expect(one.calls.markSoldIn + two.calls.markSoldIn, `${round}회`).toBe(1);
    }
  });

  test('같은 실패를 두 연결이 동시에 쓰면 하나만 APPLIED이고 다른 하나는 STALE이며 한도는 한 번만 되돌린다 [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const a = await reserved(s);
    const settled = await Promise.allSettled([s.results.fail(failOf(a)), racingResults(s).fail(failOf(a, { failureReason: 'PG_ERROR' }))]);
    expect(rejections(settled).map(messagesOf)).toEqual([]);
    const out = settled.map((r) => (r as PromiseFulfilledResult<PaymentResultWriteOutcome>).value);
    expect(out.map((r) => r.status).sort()).toEqual(['APPLIED', 'STALE']);
    expect((await historyOf(a.o.id)).map((h) => h.cause)).toEqual(['T1', 'T3', 'T4', 'T7', 'T11']);
    expect(await quotaOf(a.o.accountId, a.o.eventId)).toEqual({ used: 0, limit_count: LIMIT });
    expect(await jobOf(a.o.id)).toMatchObject({ step: 'RELEASE' });
  });

  test('Saga done이 CONFIRM 작업 행을 지우는 트랜잭션을 쥔 동안 approve는 작업 행에서 기다리고, 그것이 커밋되면 이어서 APPLIED다 [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const a = await reserved(s);
    const c = await race.pool.connect();
    let settled = false;
    let approving: Promise<PaymentResultWriteOutcome> | undefined;
    try {
      await c.query('begin');
      // Saga done(drizzle-saga.ts)과 같은 첫 문장을 커밋하지 않고 쥔다
      await c.query(`delete from order_saga_job where order_id = $1 and step = 'CONFIRM' returning order_id`, [a.o.id]);
      approving = s.results.approve(approveOf(s, a)).finally(() => {
        settled = true;
      });
      approving.catch(() => undefined);
      expect(await waitFor(async () => settled || (await lockWaiters(APP)) > 0, 5_000)).toBe(true);
      expect(settled).toBe(false);
      await c.query('update payment_attempt set pg_payment_key = null, pg_tx_id = null, pg_payment_token = null where id = $1', [a.attemptId]);
      await c.query('commit');
      expect(await approving).toEqual({ status: 'APPLIED' });
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
      await approving?.catch(() => undefined);
    }
    expect(await orderRow(a.o.id)).toMatchObject({ status: 'APPROVED' });
    expect(await jobOf(a.o.id)).toBeUndefined();
    expect((await salesOf(a.o.eventId)).map((x) => x.status)).toEqual(['SOLD', 'SOLD']);
  });

  test('approve가 작업 행을 지우고 트랜잭션을 쥔 동안 온 Saga CONFIRM 실행(done)은 작업 행에서 기다렸다가 0행이라 물러나고(false), 늦은 T11도 STALE이다 [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const a = await reserved(s);
    const held = await s.saga.claim(a.o.id, LEASE);
    expect(held?.step).toBe('CONFIRM');
    // ticket_issue_job 삽입마다 0.6초 쉰다(작업 행을 지운 뒤 승인 트랜잭션을 늘린다)
    await q('insert into pr_slow (event_id, ms) values ($1, 600)', [a.o.eventId]);
    let approveDone = false;
    let doneDone = false;
    const approving = s.results.approve(approveOf(s, a)).finally(() => {
      approveDone = true;
    });
    approving.catch(() => undefined);
    try {
      expect(await waitFor(async () => approveDone || (await sleepers(APP)) > 0, 5_000)).toBe(true);
      expect(approveDone).toBe(false);
      const other = racingSaga(s);
      const finishing = other.done(a.o.id, held!.leaseUntilMs).finally(() => {
        doneDone = true;
      });
      finishing.catch(() => undefined);
      expect(await waitFor(async () => doneDone || approveDone || (await lockWaiters(RACE)) > 0, 5_000)).toBe(true);
      expect(doneDone).toBe(false);
      expect(await approving).toEqual({ status: 'APPLIED' });
      expect(await finishing).toBe(false);
      expect(await other.fail({ orderId: a.o.id, transition: 'T11', reason: 'EXPIRED', actor: SAGA, release: releaseOf(a), leaseUntilMs: held!.leaseUntilMs })).toEqual({
        status: 'STALE',
        current: 'APPROVED',
      });
    } finally {
      await approving.catch(() => undefined);
      await q('delete from pr_slow where event_id = $1', [a.o.eventId]);
    }
    expect(await orderRow(a.o.id)).toMatchObject({ status: 'APPROVED', failure_reason: null });
    expect(await jobOf(a.o.id)).toBeUndefined();
    expect((await salesOf(a.o.eventId)).map((x) => x.status)).toEqual(['SOLD', 'SOLD']);
    expect(await issueJobOf(a.o.id)).toMatchObject({ attempts: 0 });
  });
});

// ───────────────────────────── markSoldIn ─────────────────────────────

describe('DrizzleSeatSales.markSoldIn(바깥 트랜잭션 안에서 그 주문의 PENDING → SOLD)', () => {
  test('부르는 쪽 트랜잭션 안에서 그 주문의 PENDING만 SOLD(pending_until 비움)로 바꿔 바꾼 수를 돌려주고, 같은 트랜잭션의 두 번째 호출은 0이다. 같은 회차 다른 주문의 PENDING은 그대로다 [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const a = await reserved(s);
    const otherOrder = uuidv7(s.clock);
    const otherSeat = randomUUID();
    expect(await s.sales.reserve({ eventId: a.o.eventId, orderId: otherOrder, accountId: randomUUID(), seatIds: [otherSeat], limit: LIMIT })).toEqual({ status: 'RESERVED' });

    const got = await database.transaction(async (tx) => {
      const xid = String(((await tx.execute(sql`select txid_current()::text as x`)).rows[0] as { x: string }).x);
      const first = await s.sales.markSoldIn(tx, { eventId: a.o.eventId, orderId: a.o.id, seatIds: seatIdsOf(a) });
      const second = await s.sales.markSoldIn(tx, { eventId: a.o.eventId, orderId: a.o.id, seatIds: seatIdsOf(a) });
      return { xid, first, second };
    });

    expect(got.first).toBe(2);
    expect(got.second).toBe(0);
    const rows = await salesOf(a.o.eventId);
    expect(rows.filter((r) => r.order_id === a.o.id).map((r) => [r.status, r.pending_until])).toEqual([
      ['SOLD', null],
      ['SOLD', null],
    ]);
    expect(rows.find((r) => r.order_id === otherOrder)?.status).toBe('PENDING');
    // 트랜잭션을 따로 열지 않았다(판매 행 갱신이 부르는 쪽 트랜잭션 번호로 적혔다)
    const xids = await q<{ xid: string }>(`select distinct xid::text as xid from pr_audit where tbl = 'seat_sale' and op = 'UPDATE' and row_text like $1`, [`%"order_id":"${a.o.id}"%`]);
    expect(xids.map((x) => x.xid)).toEqual([got.xid]);
  });

  test('부르는 쪽 트랜잭션을 되돌리면 판매 행이 PENDING 그대로다', async () => {
    const s = fresh();
    const a = await reserved(s);
    let changed = -1;
    await expect(
      database.transaction(async (tx) => {
        changed = await s.sales.markSoldIn(tx, { eventId: a.o.eventId, orderId: a.o.id, seatIds: seatIdsOf(a) });
        throw new Error('시험이 되돌린다');
      }),
    ).rejects.toThrow('시험이 되돌린다');
    expect(changed).toBe(2);
    expect((await salesOf(a.o.eventId)).map((x) => x.status)).toEqual(['PENDING', 'PENDING']);
  });

  test('주문 ID·회차·좌석이 다르면 0이고, 넘긴 좌석만 바꾼다(그 주문의 다른 좌석은 PENDING 그대로)', async () => {
    const s = fresh();
    const a = await reserved(s);
    const [first, second] = seatIdsOf(a);
    const n = await database.transaction(async (tx) => [
      await s.sales.markSoldIn(tx, { eventId: a.o.eventId, orderId: uuidv7(s.clock), seatIds: seatIdsOf(a) }),
      await s.sales.markSoldIn(tx, { eventId: randomUUID(), orderId: a.o.id, seatIds: seatIdsOf(a) }),
      await s.sales.markSoldIn(tx, { eventId: a.o.eventId, orderId: a.o.id, seatIds: [randomUUID()] }),
      await s.sales.markSoldIn(tx, { eventId: a.o.eventId, orderId: a.o.id, seatIds: [first!] }),
    ]);
    expect(n).toEqual([0, 0, 0, 1]);
    const rows = await salesOf(a.o.eventId);
    expect(rows.find((r) => r.seat_id === first)?.status).toBe('SOLD');
    expect(rows.find((r) => r.seat_id === second)?.status).toBe('PENDING');
  });

  test.each<[string, Record<string, unknown>]>([
    ['orderId가 UUID가 아님', { orderId: 'order-1' }],
    ['eventId가 대문자 UUID', { eventId: randomUUID().toUpperCase() }],
    ['좌석 없음', { seatIds: [] }],
    ['좌석 ID가 UUID가 아님', { seatIds: ['A01'] }],
  ])('입력이 틀리면(%s) RangeError이고 트랜잭션을 건드리지 않는다 [ASVS v5.0.0-2.2.1]', async (_label, change) => {
    const s = fresh();
    const { tx, touched } = untouchableTx();
    const input = { eventId: randomUUID(), orderId: randomUUID(), seatIds: [randomUUID()], ...change } as { eventId: string; orderId: string; seatIds: string[] };
    await expect(s.sales.markSoldIn(tx, input)).rejects.toThrow(RangeError);
    expect(touched).toEqual([]);
  });
});

// ───────────────────────────── ApplyPaymentResult(쓰임새, 실제 DB) ─────────────────────────────

function recordingSessions(o: { completeError?: Error } = {}): PaymentResultSessions & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    complete: async (id) => {
      calls.push(`complete:${id}`);
      if (o.completeError) throw o.completeError;
      return true;
    },
    unmarkPaying: async (id) => {
      calls.push(`unmark:${id}`);
      return true;
    },
  };
}
function recordingLog(): PaymentResultLog & { lines: { kind: string; e: unknown }[] } {
  const lines: { kind: string; e: unknown }[] = [];
  return {
    lines,
    held: (e) => void lines.push({ kind: 'held', e }),
    afterCommitFailed: (e) => void lines.push({ kind: 'afterCommitFailed', e }),
  };
}
/** 보류 까닭별 로그 수준·표시(리뷰 M2·M4·L6, 시험 쪽에 따로 적은 것) */
const HOLD_LOG: Record<PaymentResultHoldReason, { severity: 'SEV1' | 'SEV2'; kind?: string }> = {
  IMPOSSIBLE: { severity: 'SEV2' },
  AMOUNT_MISMATCH: { severity: 'SEV2', kind: 'security' },
  PG_MISMATCH: { severity: 'SEV2', kind: 'security' },
  NOT_YET_SUPPORTED: { severity: 'SEV2' },
  CHARGED_ON_CLOSED_ORDER: { severity: 'SEV1', kind: 'payment-charged-closed' },
  SOLD_MISMATCH: { severity: 'SEV1' },
};
const heldLine = (reason: PaymentResultHoldReason, e: PaymentResultEvent) => ({ kind: 'held', e: { orderId: e.orderId, type: e.type, pg: e.pg, reason, ...HOLD_LOG[reason] } });

function useCase(s: Fresh, o: { results?: DrizzlePaymentResults; completeError?: Error } = {}) {
  const sessions = recordingSessions(o.completeError ? { completeError: o.completeError } : {});
  const kicks: string[] = [];
  const log = recordingLog();
  const results = o.results ?? s.results;
  const apply = new ApplyPaymentResult({ reads: results, writes: results, sessions, saga: { kick: (id) => void kicks.push(id) }, log, clock: s.clock });
  return { apply, sessions, kicks, log };
}
/** 결제 사건(asyncapi PaymentEvent의 칸). 금액·결제사는 주문 그대로, eventKey는 새 UUID */
const eventOf = (s: Fresh, a: Accepted, x: Partial<PaymentResultEvent> = {}): PaymentResultEvent => ({
  eventId: a.o.eventId,
  orderId: a.o.id,
  pg: a.refs.pg,
  type: 'APPROVED',
  amount: a.o.amount,
  refMissing: false,
  attemptNo: 1,
  occurredAt: iso(s.clock.now()),
  eventSeq: 1,
  eventKey: randomUUID(),
  ...x,
});

describe('ApplyPaymentResult.execute(실제 DB: 읽기 → 결정 → 한 트랜잭션 → 커밋 뒤 일)', () => {
  test('APPROVED(RESERVED): APPLIED T9·APPROVE이고 발권 기한은 사건의 occurredAt + 30분(앱 시계가 아님), 커밋 뒤 구매 세션을 끝낸다(P-T12: 결제에 성공하면 비운다) [ASVS v5.0.0-2.3.1]', async () => {
    const s = fresh();
    const a = await reserved(s);
    const occurredAtMs = s.clock.now() - 2_000;
    s.clock.advance(5_000);
    const u = useCase(s);

    expect(await u.apply.execute(eventOf(s, a, { occurredAt: iso(occurredAtMs), eventSeq: 1 }))).toEqual({ status: 'APPLIED', transition: 'T9', write: 'APPROVE' });

    expect((await issueJobOf(a.o.id))?.issue_due_at).toEqual(new Date(occurredAtMs + ISSUE_WINDOW_MS));
    expect(u.sessions.calls).toEqual([`complete:${a.o.purchaseSessionId}`]);
    expect(u.kicks).toEqual([]);
    expect(u.log.lines).toEqual([]);
  });

  test('PT2_FAILED(RESERVED, CARD_DECLINED): APPLIED T11·FAIL, failure_reason CARD_DECLINED, 커밋 뒤 Paying을 풀고 Saga를 깨운다', async () => {
    const s = fresh();
    const a = await reserved(s);
    const u = useCase(s);
    expect(await u.apply.execute(eventOf(s, a, { type: 'FAILED', failureCategory: 'CARD_DECLINED', result: 'DECLINED' }))).toEqual({ status: 'APPLIED', transition: 'T11', write: 'FAIL' });
    expect(await orderRow(a.o.id)).toMatchObject({ status: 'FAILED', failure_reason: 'CARD_DECLINED' });
    expect(u.sessions.calls).toEqual([`unmark:${a.o.purchaseSessionId}`]);
    expect(u.kicks).toEqual([a.o.id]);
  });

  test('FAILED에 failureCategory가 없으면 failure_reason은 PG_ERROR다([정함] PAYMENT_FAILURE_FALLBACK)', async () => {
    const s = fresh();
    const a = await reserved(s);
    expect((await useCase(s).apply.execute(eventOf(s, a, { type: 'FAILED' }))).status).toBe('APPLIED');
    expect(await orderRow(a.o.id)).toMatchObject({ status: 'FAILED', failure_reason: 'PG_ERROR' });
  });

  test('UNKNOWN(RESERVED): APPLIED T12·MARK이고 커밋 뒤 아무것도 하지 않는다. 이어 AWAITING_DEPOSIT(순번 2)은 T14·MARK이고 구매 세션을 끝낸다', async () => {
    const s = fresh();
    const a = await reserved(s);
    const u = useCase(s);
    expect(await u.apply.execute(eventOf(s, a, { type: 'UNKNOWN', eventSeq: 1 }))).toEqual({ status: 'APPLIED', transition: 'T12', write: 'MARK' });
    expect(u.sessions.calls).toEqual([]);
    expect(u.kicks).toEqual([]);
    expect(await u.apply.execute(eventOf(s, a, { type: 'AWAITING_DEPOSIT', eventSeq: 2, result: 'WAITING_FOR_DEPOSIT' }))).toEqual({ status: 'APPLIED', transition: 'T14', write: 'MARK' });
    expect(u.sessions.calls).toEqual([`complete:${a.o.purchaseSessionId}`]);
    expect(await orderRow(a.o.id)).toMatchObject({ status: 'AWAITING_DEPOSIT', payment_event_seq: '2' });
  });

  test('PT15_뒤바뀐 차례: 순번 3(APPROVED)을 반영한 뒤 온 순번 2(UNKNOWN)는 SKIPPED DUPLICATE이고, 같은 사건이 다시 와도 SKIPPED DUPLICATE다(이력·Outbox 그대로) [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const a = await reserved(s);
    const u = useCase(s);
    const approved = eventOf(s, a, { eventSeq: 3 });
    expect((await u.apply.execute(approved)).status).toBe('APPLIED');
    const before = await traceOf(a);

    expect(await u.apply.execute(eventOf(s, a, { type: 'UNKNOWN', eventSeq: 2 }))).toEqual({ status: 'SKIPPED', reason: 'DUPLICATE' });
    expect(await u.apply.execute(approved)).toEqual({ status: 'SKIPPED', reason: 'DUPLICATE' });

    expect(await traceOf(a)).toEqual(before);
    expect(before.order).toMatchObject({ status: 'APPROVED', payment_event_seq: '3' });
    // 다시 온 사건은 로그를 남기지 않는다. 승인된 주문이라 구매 세션 끝내기만 다시 부른다(리뷰 L1, Paying 풀기는 없다)
    expect(u.log.lines).toEqual([]);
    expect(u.sessions.calls).toEqual(Array.from({ length: 3 }, () => `complete:${a.o.purchaseSessionId}`));
  });

  test('B_UNKNOWN 주문(T12 순번 1) + APPROVED(순번 2) → APPLIED T13·APPROVE: 판매 행 SOLD·ticket_issue_job·결제 참조 비움·구매 세션 끝냄 [ASVS v5.0.0-2.3.1]', async () => {
    const s = fresh();
    const a = await reserved(s);
    const u = useCase(s);
    expect(await u.apply.execute(eventOf(s, a, { type: 'UNKNOWN', result: 'UNKNOWN', eventSeq: 1 }))).toEqual({ status: 'APPLIED', transition: 'T12', write: 'MARK' });
    s.clock.advance(1_000);
    const occurredAtMs = s.clock.now();
    expect(await u.apply.execute(eventOf(s, a, { eventSeq: 2, occurredAt: iso(occurredAtMs) }))).toEqual({ status: 'APPLIED', transition: 'T13', write: 'APPROVE' });
    expect(await orderRow(a.o.id)).toMatchObject({ status: 'APPROVED', payment_event_seq: '2' });
    expect((await historyOf(a.o.id)).map((h) => h.cause)).toEqual(['T1', 'T3', 'T4', 'T7', 'T12', 'T13']);
    expect((await salesOf(a.o.eventId)).map((x) => x.status)).toEqual(['SOLD', 'SOLD']);
    expect(await issueJobOf(a.o.id)).toMatchObject({ event_id: a.o.eventId, attempts: 0, issue_due_at: new Date(occurredAtMs + ISSUE_WINDOW_MS) });
    expect(await attemptRefs(a.attemptId)).toEqual(NO_REFS);
    expect(await jobOf(a.o.id)).toBeUndefined();
    expect(u.sessions.calls).toEqual([`complete:${a.o.purchaseSessionId}`]);
    expect(u.kicks).toEqual([]);
  });

  test('PT15_같은 사건이 두 길(사건·당기기)로 동시에 오면 하나는 APPLIED, 다른 하나는 SKIPPED DUPLICATE다(쓰기 STALE 뒤 다시 읽어 정함) [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const a = await reserved(s);
    const e = eventOf(s, a, { eventSeq: 2 });
    const one = useCase(s);
    const two = useCase(s, { results: racingResults(s) });
    const settled = await Promise.allSettled([one.apply.execute(e), two.apply.execute(e)]);
    expect(rejections(settled)).toEqual([]);
    const out = settled.map((r) => (r as PromiseFulfilledResult<ApplyPaymentResultOutcome>).value);
    expect(out.map((r) => r.status).sort()).toEqual(['APPLIED', 'SKIPPED']);
    expect(out.find((r) => r.status === 'SKIPPED')).toEqual({ status: 'SKIPPED', reason: 'DUPLICATE' });
    expect((await historyOf(a.o.id)).filter((h) => h.cause === 'T9')).toHaveLength(1);
  });

  test('이미 그 도착 상태(APPROVED)인데 순번이 더 큰 APPROVED가 오면 SKIPPED ALREADY_THERE다', async () => {
    const s = fresh();
    const a = await reserved(s);
    const u = useCase(s);
    await u.apply.execute(eventOf(s, a, { eventSeq: 1 }));
    expect(await u.apply.execute(eventOf(s, a, { eventSeq: 2 }))).toEqual({ status: 'SKIPPED', reason: 'ALREADY_THERE' });
    expect(await orderRow(a.o.id)).toMatchObject({ payment_event_seq: '1' });
  });

  test('RESOLVED는 SKIPPED RECORD_ONLY이고 주문이 그대로이며 로그가 없다', async () => {
    const s = fresh();
    const a = await reserved(s);
    const u = useCase(s);
    const before = await traceOf(a);
    expect(await u.apply.execute(eventOf(s, a, { type: 'RESOLVED' }))).toEqual({ status: 'SKIPPED', reason: 'RECORD_ONLY' });
    expect(await traceOf(a)).toEqual(before);
    expect(u.log.lines).toEqual([]);
  });

  test.each(['DEPOSIT_REVERSED', 'PARTIAL_CANCELED', 'CANCELED'] as const)(
    'M3_%s는 건너뛰지 않고 PaymentResultHeld(NOT_YET_SUPPORTED)를 던진다(보류 표에 남아 그 사건을 잃지 않는다). 주문 그대로, held 로그 한 줄(SEV2)',
    async (type) => {
      const s = fresh();
      const a = await reserved(s);
      const u = useCase(s);
      await u.apply.execute(eventOf(s, a, { eventSeq: 1 }));
      const before = await traceOf(a);
      const e = eventOf(s, a, { type, eventSeq: 2 });
      await expect(u.apply.execute(e)).rejects.toMatchObject({ name: 'PaymentResultHeld', reason: 'NOT_YET_SUPPORTED', eventType: type });
      expect(await traceOf(a)).toEqual(before);
      expect(u.log.lines).toEqual([heldLine('NOT_YET_SUPPORTED', e)]);
    },
  );

  test.each<[string, (s: Fresh, a: Accepted) => Promise<PaymentResultEvent>, PaymentResultHoldReason]>([
    [
      '닫힌 주문에 과금(FAILED·EXPIRED 주문에 APPROVED — 과금됐는데 주문이 실패, 리뷰 M2)',
      async (s, a) => {
        expect(await s.saga.fail({ orderId: a.o.id, transition: 'T11', reason: 'EXPIRED', actor: SAGA, release: releaseOf(a) })).toEqual({ status: 'FAILED' });
        return eventOf(s, a);
      },
      'CHARGED_ON_CLOSED_ORDER',
    ],
    [
      '있을 수 없는 조합(이미 APPROVED된 주문에 새 순번 UNKNOWN)',
      async (s, a) => {
        expect((await useCase(s).apply.execute(eventOf(s, a, { eventSeq: 1 }))).status).toBe('APPLIED');
        return eventOf(s, a, { type: 'UNKNOWN', eventSeq: 2 });
      },
      'IMPOSSIBLE',
    ],
    ['금액이 1원 다름', async (s, a) => eventOf(s, a, { amount: a.o.amount + 1 }), 'AMOUNT_MISMATCH'],
    ['결제사가 접수한 시도와 다름', async (s, a) => eventOf(s, a, { pg: 'PORTONE' }), 'PG_MISMATCH'],
    ['없는 주문', async (s, a) => eventOf(s, a, { orderId: uuidv7(s.clock) }), 'IMPOSSIBLE'],
  ])('보류(%s): PaymentResultHeld(까닭 %s)를 던지고 아무것도 바뀌지 않으며 held 로그 한 줄, 커밋 뒤 일 없음 [ASVS v5.0.0-16.3.3]', async (_label, make, reason) => {
    const s = fresh();
    const a = await reserved(s);
    const e = await make(s, a);
    const before = await traceOf(a);
    const u = useCase(s);

    const err = await u.apply.execute(e).then(
      () => undefined,
      (x: unknown) => x,
    );

    expect(err).toBeInstanceOf(PaymentResultHeld);
    expect(err).toMatchObject({ name: 'PaymentResultHeld', reason, orderId: e.orderId, eventType: e.type });
    // 같은 결과일 실패로 본다(키 단위 소비자가 일시 실패로 보지 않는다): code·cause를 싣지 않고 글에 금액을 싣지 않는다
    expect((err as { code?: unknown }).code).toBeUndefined();
    expect((err as { cause?: unknown }).cause).toBeUndefined();
    expect((err as Error).message).not.toContain(String(a.o.amount));
    expect(await traceOf(a)).toEqual(before);
    expect(u.log.lines).toEqual([heldLine(reason, e)]);
    expect(u.sessions.calls).toEqual([]);
    expect(u.kicks).toEqual([]);
  });

  test('M2_접수 전에 만료된 주문(T5 CREATED → EXPIRED, 접수한 결제 시도 없음)에 APPROVED가 오면 PG_MISMATCH가 아니라 CHARGED_ON_CLOSED_ORDER(SEV1)로 보류하고 주문이 그대로다 [ASVS v5.0.0-16.3.3]', async () => {
    const s = fresh();
    const o = await placed(s);
    const attemptId = await putAttempt(s, o);
    await walk(s, o, ['T5']);
    const u = useCase(s);
    const e: PaymentResultEvent = { ...eventOf(s, { o, attemptId, refs: tossRefs(), at: s.clock.now() }), eventSeq: 1 };
    const before = await orderRow(o.id);
    await expect(u.apply.execute(e)).rejects.toMatchObject({ name: 'PaymentResultHeld', reason: 'CHARGED_ON_CLOSED_ORDER', orderId: o.id });
    expect(await orderRow(o.id)).toEqual(before);
    expect(before).toMatchObject({ status: 'EXPIRED' });
    expect(u.log.lines).toEqual([heldLine('CHARGED_ON_CLOSED_ORDER', e)]);
    expect(await issueJobOf(o.id)).toBeUndefined();
  });

  test('M4_판매 행 PENDING을 SQL로 지운 RESERVED 주문에 APPROVED: PaymentResultHeld(SOLD_MISMATCH, SEV1)이고 주문 RESERVED·ticket_issue_job 없음·구매 세션 일 없음 [ASVS v5.0.0-16.3.3]', async () => {
    const s = fresh();
    const a = await reserved(s);
    await q('delete from seat_sale where order_id = $1', [a.o.id]);
    const before = await traceOf(a);
    const u = useCase(s);
    const e = eventOf(s, a);
    await expect(u.apply.execute(e)).rejects.toMatchObject({ name: 'PaymentResultHeld', reason: 'SOLD_MISMATCH', orderId: a.o.id });
    expect(await traceOf(a)).toEqual(before);
    expect(before.order).toMatchObject({ status: 'RESERVED' });
    expect(before.issue).toBeUndefined();
    expect(u.log.lines).toEqual([heldLine('SOLD_MISMATCH', e)]);
    expect(u.sessions.calls).toEqual([]);
  });

  test('커밋 뒤 구매 세션 끝내기가 던져도 결과는 APPLIED이고 afterCommitFailed 한 줄(오류 이름만)이다', async () => {
    const s = fresh();
    const a = await reserved(s);
    const boom = new Error('ECONNRESET');
    boom.name = 'OrderSeatStoreUnavailable';
    const u = useCase(s, { completeError: boom });
    expect((await u.apply.execute(eventOf(s, a))).status).toBe('APPLIED');
    expect(u.log.lines).toEqual([{ kind: 'afterCommitFailed', e: { orderId: a.o.id, what: 'complete_session', errorName: 'OrderSeatStoreUnavailable' } }]);
    expect(await orderRow(a.o.id)).toMatchObject({ status: 'APPROVED' });
  });
});
