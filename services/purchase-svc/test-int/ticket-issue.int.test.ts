// 발권 호출과 재시도 큐의 purchase DB 쪽(booking DrizzleTicketIssue: TicketIssueJobs)과 발권 실행기(TicketIssueRunner)를 실제 PostgreSQL 18로 돈다(BUILD_ORDER PRF-170).
// 정본: docs/features/payment.md §2 '발권 호출과 재시도 큐의 첫 구현'(큐 잡기·실행기·발권 호출·성공·다시 보낼 실패·다시 보내지 않는 실패·ISSUE_DELAYED 한 번·
// 발권 기한 넘김·지표·long polling issueDelayed)·'결제 결과 long polling의 첫 구현'(기다리는 상태·알림 길), §3 전이 표 T18, ADR-0106 결정 2,
// docs/data.md ticket_issue_job(ERD)·§4 열 번째 마이그레이션(0009)·§5 '발권 재시도 큐를 두 파드가 함께 잡음'·§5.1 '발권 재시도 큐' 행,
// 명세 specs/payment.qnt issue(한 행을 한 파드만)·issueAck(APPROVED에서만 바꾸는 조건부, 아니면 답을 버림)·issueFailed(다시 보낼 오류는 큐 행을 둠)·overdue(재시도는 이어 감),
// 시험 표 P-T39 ①②④·P-T15(발권 gRPC 중복 전달에도 발권 1회)·P-T1(ticket-svc 5분 멈춤), booking domain/ports.ts TicketIssueJobs·TicketIssuer·TicketIssueLog·TicketIssueSignals와
// adapters/db/drizzle-ticket-issue.ts·application/ticket-issue.ts·domain/ticket-issue.ts 머리 주석.
//
// 약속:
// - 마이그레이션은 scripts/migrate.mjs의 migratePurchase(0009까지), Outbox 일 파티션은 ensureOutboxPartitions(기준 시각의 가짜 시계)로 만든다.
// - 승인 주문은 payment-result-e2e.int.test.ts의 차례를 본떠 운영 경로로 만든다: 주문(T1) → READY 결제 시도 → 결제 접수(DrizzleOrderAccepts, T3·T4) → RESERVED
//   → APPROVED 사건을 ApplyPaymentResult(DrizzlePaymentResults)로 반영(T9, 판매 행 SOLD, ticket_issue_job 한 행, 발권 기한 = 사건 시각 + 30분).
//   좌석 Redis·Saga 승인 명령은 발권 길과 상관없어, RESERVED까지는 saga-db·payment-results.int.test.ts와 같이 T7 + DrizzleSeatSales.reserve + 작업 행 CONFIRM(SQL)으로
//   만든다(Valkey 컨테이너를 띄우지 않는다). 구매 세션 끝내기·Saga 깨우기는 대역이다.
//   큐 행의 칸을 마음대로 두어야 하는 잡기·신호·게이지 시험은 주문을 전이 함수로 APPROVED까지 걸리고(T3·T4·T7·T9) 큐 행을 SQL로 넣는다(putJob).
// - 큐를 훑는 메서드(claimDue·markDelayed·markOverdue·gauges·실행기 틱)는 회차·주문을 가리지 않으므로 시험마다 큐 표를 비운다(시험은 차례로 돈다).
// - 시각은 시험마다 따로 만든 가짜 시계다. 임대·기한·delayed_at·overdue_at·게이지 나이의 '지금'은 앱 시계(DrizzleTicketIssueOptions.clock)다.
// - 쓰기 차례·한 트랜잭션은 시험 DB에만 둔 감사 트리거(ti_audit, 운영 표에는 없다)의 트랜잭션 번호로 본다. 겹침 시험은 order_item 갱신마다 쉬는 트리거(ti_slow, 고른 주문만)로
//   성공 반영 트랜잭션을 늘린다. Outbox 값은 bytea라 감사 글에서는 JSON 조각의 16진 글로 찾는다.
// - 실행기는 손으로 부르는 타이머로 만든다(틱은 tick()을 직접 부르거나, start() 뒤 붙잡은 반복 함수를 부른다). 흔들기 난수는 0.5(간격 × 1.0)다.
//   ticket-svc는 기록 대역(좌석마다 주문·좌석에서 정해지는 티켓 ID, 차례를 뒤집어 돌려준다)이고, '늘 발권' 대역(issuingTicketIssuer)도 한 번 본다.
// - long polling은 GetPaymentStatus + PaymentStatusWaitTable(실제 setTimeout, 묶음 조회 반복은 끄고 pollOnce를 손으로)로 본다(payment-status-e2e.int.test.ts의 길을 앱 없이).
// - 기대 값은 정본에서 따로 적는다(ISSUE_DELAYED eventKey·늘 발권 대역의 티켓 ID는 order-fixtures.ts uuid8로 계산). 운영 상수·함수를 기대 값으로 쓰지 않는다.
//
// 정본 모호(ports.ts·drizzle-ticket-issue.ts·ticket-issue.ts의 [정함]을 따른다):
// - tick()은 잡은 행을 다 돈 뒤(쓰기까지) 끝난다고 본다(TicketIssueTickResult가 틱 하나의 결과다). kick은 기다리지 않으므로 상태를 기다려 본다.
// - get()이 잡지 않은 행·멈춘 행의 leaseUntilMs·nextAttemptAtMs를 무엇으로 줄지 형에 없다(TicketIssueJob에서 둘 다 필수 칸이다). 그래서 get은 그 둘을 빼고 본다.
// - 성공 반영의 쓰기 차례는 drizzle-ticket-issue.ts 머리 주석대로 본다: order_item 갱신 → 큐 행 지우기 → T18(주문 → 이력 → Outbox가 마지막).
// - 같은 큐 행의 성공 반영 둘이 겹치면 뒤의 것은 큐 행 잠금을 기다렸다가 0행을 보아 LEASE_LOST라고 본다(STALE이 아니다).
// - gauges.oldestAgeSeconds는 정수 초로 떨어지는 나이만 본다(소수 초를 어떻게 할지는 정본에 없다). 멈춘 행은 나이에 들지 않는다(다시 보낼 행의 min(created_at), 리뷰 고침 M3).
// - 지표 delayed·overdue는 0으로 불러도 되므로(정본에 없다) 합만 본다. 시험 이름의 앞 표지는 이 폴더의 꼴(PT39_①_·ADR0106_)이고 ASVS는 끝에 둔다.
import { randomUUID } from 'node:crypto';
import { OrderEvent } from '@peaket/contracts/asyncapi';
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock, requestFingerprint, uuidv7 } from '@peaket/platform';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import {
  type AcceptInput,
  ApplyPaymentResult,
  DrizzleOrderAccepts,
  DrizzleOrderStore,
  DrizzlePaymentResults,
  DrizzlePaymentStatus,
  DrizzleTicketIssue,
  GetPaymentStatus,
  type GetPaymentStatusResult,
  type IssuedTicketRef,
  isIssueDelayed,
  issuingTicketIssuer,
  type NewOrder,
  type OrderRequestOnce,
  type PaymentRefs,
  type PaymentResultEvent,
  PaymentStatusWaitTable,
  TicketIssueCallError,
  type TicketIssueCommand,
  type TicketIssueCompleteInput,
  type TicketIssueCompleteOutcome,
  type TicketIssueFailureCode,
  type TicketIssueGauges,
  type TicketIssueJob,
  type TicketIssueLog,
  type TicketIssuer,
  TicketIssueRunner,
  type TicketIssueSignals,
  type TicketIssueTimer,
  type TransitionId,
  type WaitTableTimer,
} from '../src/modules/booking/index.js';
import { DrizzleSeatSales } from '../src/modules/inventory/index.js';
import { accountActor, BASE_MS, CREATED_ONLY, eventItemsOf, HOUR, iso, laterEvent, makeItems, newOrderInput, rejections, SAGA, TRADE_ORDERS, uuid8 } from './order-fixtures.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let server: PostgresContainer | undefined;
/** 어댑터가 쓰는 풀(첫째 파드) */
let database: Database;
/** 읽기·준비용 풀 */
let admin: Database;
/** 둘째 파드 쪽 풀(잠금을 기다리는 연결을 가려 본다) */
let race: Database;

const APP = 'ticket-issue-test';
const RACE = 'ticket-issue-race';
const LIMIT = 4;
const MIN = 60_000;
/** 임대 30초 [가정](payment §2 '큐 잡기') */
const LEASE = 30_000;
/** 발권 기한 = 승인 + 30분 [가정](data.md ticket_issue_job.issue_due_at) */
const ISSUE_WINDOW_MS = 30 * MIN;
/** ISSUE_DELAYED·issueDelayed 기준 60초 [가정](payment §2) */
const DELAYED_AFTER_MS = 60_000;
/** 발권 호출 데드라인 2초 [가정](payment §2 '발권 호출') */
const DEADLINE_MS = 2_000;
/** 발권 실행기의 행위자(ACTOR_PATTERN system:<작업 이름>. 운영 상수를 가져오지 않고 따로 적는다) */
const ISSUE_ACTOR = 'system:ticket-issue';
/** 곧바로 답함의 상한(25초 기다림과 넉넉히 갈린다, payment-status-e2e.int.test.ts와 같다) */
const PROMPT_MS = 1_500;
const BEFORE_ISSUE = ['T1', 'T3', 'T4', 'T7', 'T9'];
const OUTBOX_APPROVED = ['CREATED', 'ACCEPTED', 'RESERVED', 'APPROVED'];

beforeAll(async () => {
  server = await startPostgres();
  await migratePurchase(server.url);
  database = createDatabase({ url: server.url, profile: 'general', max: 20, applicationName: APP });
  admin = createDatabase({ url: server.url, profile: 'general', max: 4, applicationName: 'ticket-issue-admin' });
  race = createDatabase({ url: server.url, profile: 'general', max: 6, applicationName: RACE });
  await ensureOutboxPartitions(admin, fakeClock({ now: BASE_MS }));
  // 시험용 감사 트리거와 느린 갱신 트리거(운영 표에는 없다)
  await admin.pool.query(`
    create table ti_audit (n bigserial primary key, xid bigint not null default txid_current(), tbl text not null, op text not null, row_text text);
    create or replace function ti_audit() returns trigger language plpgsql as $$
    begin
      insert into ti_audit (tbl, op, row_text)
      values (tg_table_name, tg_op, case when tg_op = 'DELETE' then row_to_json(old)::text else row_to_json(new)::text end);
      return null;
    end $$;
    create table ti_slow (order_id uuid primary key, ms int not null);
    create or replace function ti_slow() returns trigger language plpgsql as $$
    declare d int;
    begin
      select ms into d from ti_slow where order_id = new.order_id;
      if d is not null then perform pg_sleep(d / 1000.0); end if;
      return new;
    end $$;
    create trigger ti_slow before update on order_item for each row execute function ti_slow();`);
  for (const t of ['order_item', 'ticket_issue_job', 'purchase_order', 'order_event', 'outbox']) {
    await admin.pool.query(`create trigger ti_audit after insert or update or delete on ${t} for each row execute function ti_audit()`);
  }
});

afterAll(async () => {
  await Promise.allSettled([database?.close(), admin?.close(), race?.close()]);
  server?.stop();
});

/** 시험이 만든 실행기(시험마다 멈춘다. 뼈대의 stop은 던지므로 약속 안에서 부른다) */
const runners: TicketIssueRunner[] = [];

beforeEach(async () => {
  // 큐를 훑는 메서드가 다른 시험의 행을 잡지 않게(머리 주석 '약속')
  await q('delete from ticket_issue_job');
});

afterEach(async () => {
  await Promise.allSettled(runners.splice(0).map((r) => Promise.resolve().then(() => r.stop())));
});

// ───────────────────────────── 도우미 ─────────────────────────────

const q = async <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> => (await admin.pool.query(text, params)).rows as R[];
const count = async (text: string, params: unknown[] = []): Promise<number> => Number((await q<{ n: string | number }>(text, params))[0]!.n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 시험 하나의 가짜 시계·주문 전이 함수·접수·결제 결과·발권 큐 어댑터 */
function fresh(startMs = BASE_MS) {
  const clock = fakeClock({ now: startMs });
  const store = new DrizzleOrderStore({ clock });
  const sales = new DrizzleSeatSales(database);
  return {
    clock,
    store,
    sales,
    accepts: new DrizzleOrderAccepts({ database, store, clock }),
    results: new DrizzlePaymentResults({ database, store, sales, clock }),
    issue: new DrizzleTicketIssue({ database, store, clock }),
  };
}
type Fresh = ReturnType<typeof fresh>;
/** 둘째 파드의 발권 큐 어댑터(다른 풀, 같은 시계·전이 함수) */
const otherPod = (s: Fresh) => new DrizzleTicketIssue({ database: race, store: s.store, clock: s.clock });

const seatIdsOf = (o: NewOrder) => o.items.map((it) => it.seatId);

async function placed(s: Fresh, seats = 2): Promise<NewOrder> {
  const order = newOrderInput(s.clock, { items: makeItems(seats) });
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

async function putAttempt(s: Fresh, o: NewOrder): Promise<string> {
  const id = uuidv7(s.clock);
  await q('insert into payment_attempt (id, order_id, pg, pg_order_ref, status, created_at) values ($1, $2, $3, $4, $5, $6)', [id, o.id, 'TOSS', o.id, 'READY', new Date(s.clock.now())]);
  return id;
}
const onceOf = (o: NewOrder): OrderRequestOnce => ({
  accountRef: o.accountId,
  operation: 'ACCEPT_PAYMENT',
  key: randomUUID(),
  requestHash: requestFingerprint('POST', `/v1/orders/${o.id}/payment-acceptance`, Buffer.from(JSON.stringify({ n: randomUUID() }), 'utf8')),
});
const tossRefs = (): PaymentRefs => ({ pg: 'TOSS', paymentKey: `tgen_${randomUUID().replaceAll('-', '')}` });

/** 결제 결과 반영 쓰임새(커밋 뒤 일 대역: 구매 세션 끝내기·Saga 깨우기는 이 시험과 상관없다). onApproved는 발권 실행기 깨우기 */
function applyOf(s: Fresh, onApproved?: (orderId: string) => void): ApplyPaymentResult {
  return new ApplyPaymentResult({
    reads: s.results,
    writes: s.results,
    sessions: { complete: async () => true, unmarkPaying: async () => true },
    saga: { kick: () => {} },
    log: { held: () => {}, afterCommitFailed: () => {} },
    clock: s.clock,
    ...(onApproved ? { onApproved } : {}),
  });
}
/** 결제 승인 사건(도메인 PaymentResultEvent) */
const approvedEventOf = (o: NewOrder, atMs: number): PaymentResultEvent => ({
  eventId: o.eventId,
  orderId: o.id,
  pg: 'TOSS',
  type: 'APPROVED',
  amount: o.amount,
  payMethodCategory: 'CARD',
  refMissing: false,
  result: 'APPROVED',
  attemptNo: 1,
  latencyMs: 120,
  occurredAt: iso(atMs),
  eventSeq: 1,
  eventKey: randomUUID(),
});

interface Approved {
  o: NewOrder;
  /** 승인 반영 시각(사건 시각 = 큐 행 created_at·next_attempt_at, 발권 기한 = 이 시각 + 30분) */
  approvedAt: number;
}
/** 운영 경로로 승인까지 간 주문(머리 주석 '약속'). onApproved를 주면 반영 뒤 곧바로 부른다 */
async function approved(s: Fresh, x: { seats?: number; onApproved?: (orderId: string) => void } = {}): Promise<Approved> {
  const o = await placed(s, x.seats);
  const attemptId = await putAttempt(s, o);
  s.clock.advance(1_000);
  const input: AcceptInput = { orderId: o.id, attemptId, eventId: o.eventId, refs: tossRefs(), seatGen: 1, actor: accountActor(o.accountId) };
  expect(await s.accepts.accept(onceOf(o), input)).toEqual({ status: 'ACCEPTED' });
  await walk(s, o, ['T7']);
  expect(await s.sales.reserve({ eventId: o.eventId, orderId: o.id, accountId: o.accountId, seatIds: seatIdsOf(o), limit: LIMIT })).toEqual({ status: 'RESERVED' });
  await q(`update order_saga_job set step = 'CONFIRM', attempts = 0 where order_id = $1`, [o.id]);
  s.clock.advance(1_000);
  const approvedAt = s.clock.now();
  expect(await applyOf(s, x.onApproved).execute(approvedEventOf(o, approvedAt))).toMatchObject({ status: 'APPLIED', transition: 'T9' });
  return { o, approvedAt };
}

/** 큐 행 칸(시각은 epoch ms, null은 비움. 빠지면: next_attempt_at·created_at = 지금, issue_due_at = 지금 + 30분, 나머지 비움·0) */
interface JobSpec {
  nextAtMs?: number | null;
  leaseUntilMs?: number | null;
  attempts?: number;
  lastError?: string | null;
  createdAtMs?: number;
  issueDueAtMs?: number;
  delayedAtMs?: number | null;
  overdueAtMs?: number | null;
  seats?: number;
}
/** APPROVED 주문(전이 함수로 T3·T4·T7·T9) + 큐 행 SQL 넣기 */
async function putJob(s: Fresh, x: JobSpec = {}): Promise<NewOrder> {
  const o = await placed(s, x.seats);
  await walk(s, o, ['T3', 'T4', 'T7', ['T9', 1]]);
  const now = s.clock.now();
  const at = (v: number | null | undefined, d: number | null): Date | null => {
    const ms = v === undefined ? d : v;
    return ms === null ? null : new Date(ms);
  };
  await q(
    `insert into ticket_issue_job (order_id, event_id, attempts, next_attempt_at, issue_due_at, last_error, created_at, lease_until, delayed_at, overdue_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      o.id,
      o.eventId,
      x.attempts ?? 0,
      at(x.nextAtMs, now),
      new Date(x.issueDueAtMs ?? now + ISSUE_WINDOW_MS),
      x.lastError ?? null,
      new Date(x.createdAtMs ?? now),
      at(x.leaseUntilMs, null),
      at(x.delayedAtMs, null),
      at(x.overdueAtMs, null),
    ],
  );
  return o;
}

/** 잡은 큐 행의 기대 값(TicketIssueJob) */
const jobView = (
  o: NewOrder,
  x: { nextAttemptAtMs: number; leaseUntilMs: number; createdAtMs: number; issueDueAtMs: number; attempts?: number; lastError?: string },
): TicketIssueJob => ({
  orderId: o.id,
  eventId: o.eventId,
  payerAccountId: o.accountId,
  seatIds: seatIdsOf(o),
  attempts: x.attempts ?? 0,
  nextAttemptAtMs: x.nextAttemptAtMs,
  issueDueAtMs: x.issueDueAtMs,
  createdAtMs: x.createdAtMs,
  leaseUntilMs: x.leaseUntilMs,
  ...(x.lastError === undefined ? {} : { lastError: x.lastError }),
});

const orderRow = async (id: string) => (await q<{ status: string; event_seq: number }>('select status, event_seq from purchase_order where id = $1', [id]))[0];
const historyOf = (id: string) =>
  q<{ seq: number; from_status: string | null; to_status: string; cause: string; actor: string; occurred_at: Date }>(
    'select seq, from_status, to_status, cause, actor, occurred_at from order_event where order_id = $1 order by seq',
    [id],
  );
const causesOf = async (id: string) => (await historyOf(id)).map((r) => r.cause);
async function outboxOf(eventId: string): Promise<{ topic: string; event: Record<string, unknown> }[]> {
  const rows = await q<{ topic: string; payload: Buffer }>('select topic, payload from outbox where msg_key = $1 order by outbox.seq', [eventId]);
  return rows.map((r) => ({ topic: r.topic, event: JSON.parse(Buffer.from(r.payload).toString('utf8')) as Record<string, unknown> }));
}
/** 회차는 주문마다 새 UUID라 그 회차의 Outbox가 곧 그 주문의 사건이다 */
const outboxTypes = async (o: NewOrder) => (await outboxOf(o.eventId)).map((x) => x.event.type);
interface IssueRow {
  event_id: string;
  attempts: number;
  next_attempt_at: Date | null;
  issue_due_at: Date;
  last_error: string | null;
  created_at: Date;
  lease_until: Date | null;
  delayed_at: Date | null;
  overdue_at: Date | null;
}
const issueRowOf = async (orderId: string) =>
  (
    await q<IssueRow>(
      'select event_id, attempts, next_attempt_at, issue_due_at, last_error, created_at, lease_until, delayed_at, overdue_at from ticket_issue_job where order_id = $1',
      [orderId],
    )
  )[0];
const ticketIdsOf = (orderId: string) => q<{ seat_id: string; ticket_id: string | null }>('select seat_id, ticket_id from order_item where order_id = $1 order by line_no', [orderId]);
const noTickets = (o: NewOrder) => o.items.map((it) => ({ seat_id: it.seatId, ticket_id: null }));

/** 아무것도 바뀌지 않았는지 볼 때의 주문 흔적 */
const traceOf = async (o: NewOrder) => ({
  order: await orderRow(o.id),
  history: (await historyOf(o.id)).length,
  outbox: await outboxTypes(o),
  issue: await issueRowOf(o.id),
  tickets: await ticketIdsOf(o.id),
});

/** 그 주문의 한 전이(cause)를 쓴 트랜잭션의 행 쓰기 차례(감사 트리거). 이어진 같은 쓰기는 하나로 접고, Outbox 파티션 이름은 outbox로 본다 */
async function writesOfTx(orderId: string, cause: string): Promise<string[]> {
  const rows = await q<{ tbl: string; op: string }>(
    `select tbl, op from ti_audit
      where xid = (select xid from ti_audit where tbl = 'order_event' and op = 'INSERT' and row_text like $1 and row_text like $2 order by n desc limit 1)
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
const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex');
/** 그 주문의 ISSUE_DELAYED Outbox 넣기와 delayed_at 쓰기의 트랜잭션 번호(Outbox 값은 bytea라 JSON 조각의 16진 글로 찾는다) */
async function delayedTxOf(orderId: string): Promise<{ outbox: string[]; mark: string[] }> {
  const outbox = await q<{ xid: string }>(`select xid::text as xid from ti_audit where tbl like 'outbox%' and op = 'INSERT' and row_text like $1 and row_text like $2 order by n`, [
    `%${hex(`"orderId":"${orderId}"`)}%`,
    `%${hex('"type":"ISSUE_DELAYED"')}%`,
  ]);
  const mark = await q<{ xid: string }>(
    `select xid::text as xid from ti_audit where tbl = 'ticket_issue_job' and op = 'UPDATE' and row_text like $1 and row_text not like '%"delayed_at":null%' order by n`,
    [`%"order_id":"${orderId}"%`],
  );
  return { outbox: outbox.map((r) => r.xid), mark: mark.map((r) => r.xid) };
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

/** ISSUE_DELAYED 주문 사건의 기대 값(전부): 뒤 사건의 칸 그대로, 상태 전이 없음, firstInStage 거짓, eventKey = UUIDv8(SHA-256('OrderEvent:' + 주문 ID + ':ISSUE_DELAYED')) */
const issueDelayedOf = (o: NewOrder, atMs: number): Record<string, unknown> => ({
  eventId: o.eventId,
  orderId: o.id,
  accountId: o.accountId,
  type: 'ISSUE_DELAYED',
  amount: o.amount,
  seatIds: seatIdsOf(o),
  refMissing: false,
  items: eventItemsOf(o),
  seatAssignment: o.seatAssignment,
  firstInStage: false,
  occurredAt: iso(atMs),
  eventKey: uuid8(`OrderEvent:${o.id}:ISSUE_DELAYED`),
});

// ───────────────────────────── 대역 ─────────────────────────────

/** 기록 대역의 티켓 ID(주문·좌석에서 정해진다: 다시 불러도 같은 티켓, ticket-svc의 주문 ID 멱등과 같은 모양) */
const fakeTicketId = (orderId: string, seatId: string) => uuid8(`fake-ticket:${orderId}:${seatId}`);
/** 좌석마다 티켓 하나(차례를 뒤집어 돌려준다: 차례는 보장하지 않는다) */
const ticketsOf = (c: { orderId: string; seatIds: readonly string[] }): IssuedTicketRef[] => c.seatIds.map((seatId) => ({ seatId, ticketId: fakeTicketId(c.orderId, seatId) })).reverse();
const ticketRows = (o: NewOrder, idOf: (orderId: string, seatId: string) => string = fakeTicketId) => o.items.map((it) => ({ seat_id: it.seatId, ticket_id: idOf(o.id, it.seatId) }));

/** 대역의 답: 티켓 묶음, 실패 코드(TicketIssueCallError로 던진다), 또는 그것을 미루는 약속(호출이 걸려 있다) */
type Answer = readonly IssuedTicketRef[] | TicketIssueFailureCode;
/** ticket-svc 기록 대역(부른 명령과 그때의 앱 시계를 적는다). 기본은 늘 성공 */
function recordingIssuer(clock: { now(): number }, answer: (c: TicketIssueCommand, n: number) => Answer | Promise<Answer> = (c) => ticketsOf(c)) {
  const calls: TicketIssueCommand[] = [];
  const at: number[] = [];
  const issuer: TicketIssuer = {
    issue: async (c) => {
      calls.push(c);
      at.push(clock.now());
      const a = await answer(c, calls.length);
      if (typeof a === 'string') throw new TicketIssueCallError(a);
      return a;
    },
  };
  return { issuer, calls, at };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function recordingLog() {
  const lines: { kind: string; e: unknown }[] = [];
  const log: TicketIssueLog = {
    stopped: (e) => void lines.push({ kind: 'stopped', e }),
    overdue: (e) => void lines.push({ kind: 'overdue', e }),
    staleAnswer: (e) => void lines.push({ kind: 'staleAnswer', e }),
    runError: (e) => void lines.push({ kind: 'runError', e: { what: e.what, orderId: e.orderId, err: String(e.err) } }),
  };
  return { log, lines };
}
function recordingSignals() {
  const attempts: string[] = [];
  const gauges: TicketIssueGauges[] = [];
  const sums = { delayed: 0, overdue: 0 };
  const signals: TicketIssueSignals = {
    jobs: (g) => void gauges.push(g),
    attempt: (r) => void attempts.push(r),
    delayed: (n) => {
      sums.delayed += n;
    },
    overdue: (n) => {
      sums.overdue += n;
    },
  };
  return { signals, attempts, gauges, sums };
}

const manualTimer: TicketIssueTimer = { setInterval: () => 1, clearInterval: () => {} };
/** 반복 함수를 붙잡는 타이머(시험이 반복의 틱 하나를 손으로 부른다) */
function capturingTimer(): TicketIssueTimer & { fn?: () => void } {
  const t: TicketIssueTimer & { fn?: () => void } = {
    setInterval: (fn) => {
      t.fn = fn;
      return 1;
    },
    clearInterval: () => {},
  };
  return t;
}

/** 발권 실행기(흔들기 난수 0.5 → 간격 × 1.0, 손 타이머). 시험이 끝나면 멈춘다 */
function runnerOf(s: Fresh, x: { issuer: TicketIssuer; jobs?: DrizzleTicketIssue; onOrderChanged?: (orderId: string) => void; concurrency?: number; timer?: TicketIssueTimer }) {
  const log = recordingLog();
  const signals = recordingSignals();
  const runner = new TicketIssueRunner({
    jobs: x.jobs ?? s.issue,
    issuer: x.issuer,
    log: log.log,
    signals: signals.signals,
    clock: s.clock,
    timer: x.timer ?? manualTimer,
    random: () => 0.5,
    ...(x.onOrderChanged ? { onOrderChanged: x.onOrderChanged } : {}),
    ...(x.concurrency === undefined ? {} : { concurrency: x.concurrency }),
  });
  runners.push(runner);
  return { runner, log: log.lines, signals };
}

// long polling(payment-status-e2e.int.test.ts와 같은 쓰임새, 앱 없이)
/** 기다림 시간 다 됨은 실제 setTimeout(unref), 묶음 조회 반복은 끈다(시험이 pollOnce를 직접 부른다) */
const realTimeouts: WaitTableTimer = {
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};
const waitTableOf = (s: Fresh) => new PaymentStatusWaitTable({ reads: new DrizzlePaymentStatus({ database }), clock: s.clock, timer: realTimeouts });
/** 그 주문 계정으로 결제 결과를 묻는다(남은 시간 없음 → 기다림 25초). 답한 때(벽시계)를 함께 준다 */
function pollOf(s: Fresh, table: PaymentStatusWaitTable, o: NewOrder): Promise<{ result: GetPaymentStatusResult; at: number }> {
  const use = new GetPaymentStatus({ reads: new DrizzlePaymentStatus({ database }), waiters: table, clock: s.clock });
  return use.execute({ accountId: o.accountId, orderId: o.id }).then((result) => ({ result, at: performance.now() }));
}
async function waiting(table: PaymentStatusWaitTable, n: number, timeoutMs = 5_000): Promise<void> {
  const end = performance.now() + timeoutMs;
  while (table.size() < n) {
    if (performance.now() > end) throw new Error(`기다림 표에 ${n}개가 들지 않았다(지금 ${table.size()})`);
    await sleep(10);
  }
}

// ───────────────────────────── 잡기(claimDue·claim·get) ─────────────────────────────

describe('DrizzleTicketIssue.claimDue·claim·get(짧은 트랜잭션: 기한·임대 조건, FOR UPDATE SKIP LOCKED, 임대 쓰고 커밋)', () => {
  test('ADR0106_기한이 됐고(next_attempt_at ≤ 지금) 임대가 비었거나 끝난(lease_until < 지금) 행만 next_attempt_at 차례로 잡아 lease_until = 지금 + 임대를 쓰고 커밋한다. 결제자·좌석(줄 번호 차례)·기한·만든 시각·마지막 오류를 붙이고 attempts는 그대로다. 임대 끝이 지금과 같은 행·기한 전·멈춘 행은 잡지 않는다 [ASVS v5.0.0-2.3.4]', async () => {
    const s = fresh();
    const now = s.clock.now();
    const late = await putJob(s, { nextAtMs: now - 5_000, attempts: 2, lastError: 'UNAVAILABLE', createdAtMs: now - 9_000, issueDueAtMs: now + 20 * MIN, seats: 3 });
    const exact = await putJob(s, { nextAtMs: now });
    const leaseGone = await putJob(s, { nextAtMs: now - 9_000, leaseUntilMs: now - 1 });
    const leaseNow = await putJob(s, { nextAtMs: now - 8_000, leaseUntilMs: now });
    const leased = await putJob(s, { nextAtMs: now - 20_000, leaseUntilMs: now + 10_000 });
    const future = await putJob(s, { nextAtMs: now + 1 });
    const stopped = await putJob(s, { nextAtMs: null, attempts: 1, lastError: 'FAILED_PRECONDITION' });

    const got = await s.issue.claimDue(10, LEASE);

    const plain = { createdAtMs: now, issueDueAtMs: now + ISSUE_WINDOW_MS, leaseUntilMs: now + LEASE };
    expect(got).toEqual([
      jobView(leaseGone, { ...plain, nextAttemptAtMs: now - 9_000 }),
      jobView(late, { nextAttemptAtMs: now - 5_000, attempts: 2, lastError: 'UNAVAILABLE', createdAtMs: now - 9_000, issueDueAtMs: now + 20 * MIN, leaseUntilMs: now + LEASE }),
      jobView(exact, { ...plain, nextAttemptAtMs: now }),
    ]);
    // 임대는 커밋됐다(다른 연결에서 보인다). attempts는 그대로다
    for (const o of [late, exact, leaseGone]) expect((await issueRowOf(o.id))?.lease_until).toEqual(new Date(now + LEASE));
    expect((await issueRowOf(late.id))?.attempts).toBe(2);
    expect((await issueRowOf(leaseNow.id))?.lease_until).toEqual(new Date(now));
    expect((await issueRowOf(leased.id))?.lease_until).toEqual(new Date(now + 10_000));
    expect((await issueRowOf(future.id))?.lease_until).toBeNull();
    expect((await issueRowOf(stopped.id))?.lease_until).toBeNull();
    // 임대 중이라 다시 부르면 아무것도 없다. 임대가 지나면 다시 잡는다(멈춘 행은 끝내 잡지 않는다)
    expect(await s.issue.claimDue(10, LEASE)).toEqual([]);
    s.clock.advance(LEASE + 1);
    expect((await s.issue.claimDue(10, LEASE)).map((j) => j.orderId).sort()).toEqual([late.id, exact.id, leaseGone.id, leaseNow.id, leased.id, future.id].sort());
    expect((await issueRowOf(stopped.id))?.lease_until).toBeNull();
  });

  test('limit개까지만 잡고, next_attempt_at이 이른 것부터이며 같으면 주문 ID 차례다', async () => {
    const s = fresh();
    const now = s.clock.now();
    const first = await putJob(s, { nextAtMs: now - 3_000 });
    const ties = [await putJob(s, { nextAtMs: now - 2_000 }), await putJob(s, { nextAtMs: now - 2_000 }), await putJob(s, { nextAtMs: now - 2_000 })].map((o) => o.id).sort();
    const last = await putJob(s, { nextAtMs: now - 1_000 });
    expect((await s.issue.claimDue(3, LEASE)).map((j) => j.orderId)).toEqual([first.id, ties[0], ties[1]]);
    expect((await s.issue.claimDue(3, LEASE)).map((j) => j.orderId)).toEqual([ties[2], last.id]);
  });

  test('ADR0106_다른 연결이 행 잠금을 쥔 행은 기다리지 않고 건너뛴다(SKIP LOCKED) [ASVS v5.0.0-2.3.4]', async () => {
    const s = fresh();
    const now = s.clock.now();
    const held = await putJob(s, { nextAtMs: now - 2_000 });
    const free = await putJob(s, { nextAtMs: now - 1_000 });
    const c = await race.pool.connect();
    try {
      await c.query('begin');
      await c.query('select order_id from ticket_issue_job where order_id = $1 for update', [held.id]);
      const started = Date.now();
      expect((await s.issue.claimDue(10, LEASE)).map((j) => j.orderId)).toEqual([free.id]);
      // 기다리지 않았다(잠금 시간 초과까지 서지 않는다)
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
    expect((await s.issue.claimDue(10, LEASE)).map((j) => j.orderId)).toEqual([held.id]);
  });

  test('변이 검토_ADR0106_claim(kick의 잡기)도 다른 연결이 행 잠금을 쥔 행은 기다리지 않고 undefined다(SKIP LOCKED). 잠금이 풀리면 잡는다 [ASVS v5.0.0-2.3.4]', async () => {
    const s = fresh();
    const held = await putJob(s, { nextAtMs: s.clock.now() - 1_000 });
    const c = await race.pool.connect();
    try {
      await c.query('begin');
      await c.query('select order_id from ticket_issue_job where order_id = $1 for update', [held.id]);
      const started = Date.now();
      expect(await s.issue.claim(held.id, LEASE)).toBeUndefined();
      // 기다리지 않았다(문장 시간 한도 5초까지 서지 않는다)
      expect(Date.now() - started).toBeLessThan(2_000);
      expect((await issueRowOf(held.id))?.lease_until).toBeNull();
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
    expect((await s.issue.claim(held.id, LEASE))?.orderId).toBe(held.id);
  });

  test('PT15_ADR0106_두 파드(두 연결)가 동시에 claimDue를 불러도 같은 행을 둘이 잡지 않고, 둘을 합치면 기한이 된 행 전부다(다섯 번) [ASVS v5.0.0-2.3.4]', async () => {
    for (let round = 0; round < 5; round += 1) {
      await q('delete from ticket_issue_job');
      const s = fresh(BASE_MS + round * HOUR);
      const now = s.clock.now();
      const ids: string[] = [];
      for (let i = 0; i < 12; i += 1) ids.push((await putJob(s, { nextAtMs: now - i })).id);

      const settled = await Promise.allSettled([s.issue.claimDue(8, LEASE), otherPod(s).claimDue(8, LEASE)]);

      expect(rejections(settled), `${round}회`).toEqual([]);
      const [a, b] = settled.map((x) => (x as PromiseFulfilledResult<TicketIssueJob[]>).value.map((j) => j.orderId));
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
  ])('claimDue: %s면 RangeError이고 아무 행도 임대하지 않는다 [ASVS v5.0.0-2.2.1]', async (_label, limit, leaseMs) => {
    const s = fresh();
    const o = await putJob(s, { nextAtMs: s.clock.now() - 1 });
    await expect(s.issue.claimDue(limit, leaseMs)).rejects.toThrow(RangeError);
    expect((await issueRowOf(o.id))?.lease_until).toBeNull();
  });

  test('ADR0106_승인 반영이 넣은 큐 행(attempts 0·next_attempt_at = created_at = 승인 반영 시각·임대 없음)을 claim이 같은 조건으로 잡고, 임대 중(임대 끝 = 지금 포함)·기한 전·멈춘 행이면 undefined다. get은 임대를 쓰지 않고 읽는다 [ASVS v5.0.0-2.3.4]', async () => {
    const s = fresh();
    const a = await approved(s);
    expect(await issueRowOf(a.o.id)).toEqual({
      event_id: a.o.eventId,
      attempts: 0,
      next_attempt_at: new Date(a.approvedAt),
      issue_due_at: new Date(a.approvedAt + ISSUE_WINDOW_MS),
      last_error: null,
      created_at: new Date(a.approvedAt),
      lease_until: null,
      delayed_at: null,
      overdue_at: null,
    });
    // get은 임대를 쓰지 않는다
    expect(await s.issue.get(a.o.id)).toMatchObject({ orderId: a.o.id, eventId: a.o.eventId, payerAccountId: a.o.accountId, seatIds: seatIdsOf(a.o), attempts: 0 });
    expect((await issueRowOf(a.o.id))?.lease_until).toBeNull();
    const now = s.clock.now();
    expect(await s.issue.claim(a.o.id, LEASE)).toEqual(
      jobView(a.o, { nextAttemptAtMs: a.approvedAt, createdAtMs: a.approvedAt, issueDueAtMs: a.approvedAt + ISSUE_WINDOW_MS, leaseUntilMs: now + LEASE }),
    );
    expect((await issueRowOf(a.o.id))?.lease_until).toEqual(new Date(now + LEASE));
    expect(await s.issue.get(a.o.id)).toMatchObject({ orderId: a.o.id, leaseUntilMs: now + LEASE });
    // 임대 중. 임대 끝과 지금이 같아도 아직 임대 중이다(lease_until < 지금일 때만 잡는다)
    s.clock.advance(LEASE - 1);
    expect(await s.issue.claim(a.o.id, LEASE)).toBeUndefined();
    s.clock.advance(1);
    expect(await s.issue.claim(a.o.id, LEASE)).toBeUndefined();
    s.clock.advance(1);
    expect((await s.issue.claim(a.o.id, LEASE))?.leaseUntilMs).toBe(s.clock.now() + LEASE);
    // 기한 전(다시 보내기로 미룬 행)
    await q('update ticket_issue_job set next_attempt_at = $2, lease_until = null where order_id = $1', [a.o.id, new Date(s.clock.now() + 4_000)]);
    expect(await s.issue.claim(a.o.id, LEASE)).toBeUndefined();
    s.clock.advance(4_000);
    expect((await s.issue.claim(a.o.id, LEASE))?.nextAttemptAtMs).toBe(s.clock.now());
    // 멈춘 행(next_attempt_at 비움)은 잡지 않지만 get으로는 읽힌다
    await q(`update ticket_issue_job set next_attempt_at = null, lease_until = null, attempts = 1, last_error = 'NOT_FOUND' where order_id = $1`, [a.o.id]);
    s.clock.advance(HOUR);
    expect(await s.issue.claim(a.o.id, LEASE)).toBeUndefined();
    expect(await s.issue.get(a.o.id)).toMatchObject({ orderId: a.o.id, attempts: 1, lastError: 'NOT_FOUND' });
    expect(await s.issue.get(uuidv7(s.clock))).toBeUndefined();
  });

  test.each<[string, (id: string) => string]>([
    ['행 없는 주문(새 UUIDv7)', () => uuidv7(fakeClock({ now: BASE_MS }))],
    ['대문자 UUID', (id) => id.toUpperCase()],
    ['UUID가 아님', () => 'order-1'],
    ['빈 글', () => ''],
  ])('claim: %s면 undefined다(던지지 않는다)', async (_label, idOf) => {
    const s = fresh();
    const o = await putJob(s, { nextAtMs: s.clock.now() - 1 });
    expect(await s.issue.claim(idOf(o.id), LEASE)).toBeUndefined();
    expect((await issueRowOf(o.id))?.lease_until).toBeNull();
    // 맞는 ID는 잡힌다(아무것이나 undefined인 구현이 통과하지 않게)
    expect((await s.issue.claim(o.id, LEASE))?.orderId).toBe(o.id);
  });
});

// ───────────────────────────── 성공 반영(complete) ─────────────────────────────

describe('DrizzleTicketIssue.complete(한 트랜잭션: 큐 행 잠금 → 주문 행 잠금·상태 확인 → order_item.ticket_id → 큐 행 지우기 → T18)', () => {
  test('ADR0106_CONFIRMED: 한 트랜잭션에서 좌석별 티켓 ID(답의 차례와 상관없이)·큐 행 지우기·T18(APPROVED → CONFIRMED, 이력·Outbox CONFIRMED)을 쓴다. 쓰기 차례는 order_item → 큐 행 → 주문 → 이력 → Outbox(마지막)다 [ASVS v5.0.0-2.3.3] [ASVS v5.0.0-2.3.1]', async () => {
    const s = fresh();
    const a = await approved(s, { seats: 3 });
    const job = await s.issue.claim(a.o.id, LEASE);
    expect(job).toBeDefined();
    s.clock.advance(700);
    const at = s.clock.now();
    const input: TicketIssueCompleteInput = { orderId: a.o.id, tickets: ticketsOf({ orderId: a.o.id, seatIds: seatIdsOf(a.o) }), actor: ISSUE_ACTOR, leaseUntilMs: job!.leaseUntilMs };

    expect(await s.issue.complete(input)).toEqual({ status: 'CONFIRMED' });

    expect(await orderRow(a.o.id)).toEqual({ status: 'CONFIRMED', event_seq: 6 });
    expect((await historyOf(a.o.id)).at(-1)).toEqual({ seq: 6, from_status: 'APPROVED', to_status: 'CONFIRMED', cause: 'T18', actor: ISSUE_ACTOR, occurred_at: new Date(at) });
    expect(await ticketIdsOf(a.o.id)).toEqual(ticketRows(a.o));
    expect(await issueRowOf(a.o.id)).toBeUndefined();
    const outbox = await outboxOf(a.o.eventId);
    expect(outbox.map((x) => x.event.type)).toEqual([...OUTBOX_APPROVED, 'CONFIRMED']);
    expect(outbox.at(-1)!.topic).toBe(TRADE_ORDERS);
    expect(outbox.at(-1)!.event).toMatchObject(laterEvent(a.o, 'CONFIRMED', 6, at, true));
    for (const k of CREATED_ONLY) expect(outbox.at(-1)!.event).not.toHaveProperty(k);
    expect(contractIssues(outbox.at(-1)!.event)).toEqual([]);
    expect(await writesOfTx(a.o.id, 'T18')).toEqual(['UPDATE order_item', 'DELETE ticket_issue_job', 'UPDATE purchase_order', 'INSERT order_event', 'INSERT outbox']);
  });

  test.each<[string, TransitionId, string]>([
    ['이미 CONFIRMED(다른 실행이 먼저 확정)', 'T18', 'CONFIRMED'],
    ['보상으로 감(COMPENSATED)', 'T20', 'COMPENSATED'],
  ])('ADR0106_주문이 APPROVED가 아니면(%s) 상태·이력·Outbox·티켓 ID는 그대로 두고 큐 행만 지워 STALE(current)이다(늦게 온 발권 답, 명세 issueAck 조건부) [ASVS v5.0.0-2.3.1]', async (_label, by, current) => {
    const s = fresh();
    const a = await approved(s);
    const job = await s.issue.claim(a.o.id, LEASE);
    await walk(s, a.o, [by]);
    const before = await traceOf(a.o);
    expect(before.issue).toBeDefined();

    expect(await s.issue.complete({ orderId: a.o.id, tickets: ticketsOf({ orderId: a.o.id, seatIds: seatIdsOf(a.o) }), actor: ISSUE_ACTOR, leaseUntilMs: job!.leaseUntilMs })).toEqual({
      status: 'STALE',
      current,
    });

    expect(await traceOf(a.o)).toEqual({ ...before, issue: undefined });
    expect(before.tickets).toEqual(noTickets(a.o));
  });

  test('ADR0106_큐 행이 남의 임대(임대가 끝나 다른 파드가 다시 잡음)거나 행이 없으면 LEASE_LOST이고 아무것도 바꾸지 않는다 [ASVS v5.0.0-2.3.4]', async () => {
    const s = fresh();
    const a = await approved(s);
    const tickets = ticketsOf({ orderId: a.o.id, seatIds: seatIdsOf(a.o) });
    const mine = await s.issue.claim(a.o.id, LEASE);
    s.clock.advance(LEASE + 1);
    const theirs = await otherPod(s).claim(a.o.id, LEASE);
    expect(theirs?.leaseUntilMs).toBe(s.clock.now() + LEASE);
    const before = await traceOf(a.o);

    expect(await s.issue.complete({ orderId: a.o.id, tickets, actor: ISSUE_ACTOR, leaseUntilMs: mine!.leaseUntilMs })).toEqual({ status: 'LEASE_LOST' });

    expect(await traceOf(a.o)).toEqual(before);
    expect(before.issue?.lease_until).toEqual(new Date(theirs!.leaseUntilMs));
    // 행이 없다(보상이 지웠다): 임대 조건이 있든 없든 LEASE_LOST
    await q('delete from ticket_issue_job where order_id = $1', [a.o.id]);
    expect(await s.issue.complete({ orderId: a.o.id, tickets, actor: ISSUE_ACTOR, leaseUntilMs: theirs!.leaseUntilMs })).toEqual({ status: 'LEASE_LOST' });
    expect(await s.issue.complete({ orderId: a.o.id, tickets, actor: ISSUE_ACTOR })).toEqual({ status: 'LEASE_LOST' });
    expect(await orderRow(a.o.id)).toMatchObject({ status: 'APPROVED' });
    expect(await ticketIdsOf(a.o.id)).toEqual(noTickets(a.o));
    expect(await causesOf(a.o.id)).toEqual(BEFORE_ISSUE);
  });

  test.each<[string, (i: TicketIssueCompleteInput) => TicketIssueCompleteInput]>([
    ['좌석 하나가 빠짐', (i) => ({ ...i, tickets: i.tickets.slice(1) })],
    ['주문에 없는 좌석', (i) => ({ ...i, tickets: [...i.tickets.slice(1), { seatId: randomUUID(), ticketId: randomUUID() }] })],
    ['같은 좌석이 둘', (i) => ({ ...i, tickets: [...i.tickets, { seatId: i.tickets[0]!.seatId, ticketId: randomUUID() }] })],
    ['같은 티켓 ID가 둘', (i) => ({ ...i, tickets: i.tickets.map((t) => ({ ...t, ticketId: i.tickets[0]!.ticketId })) })],
    ['티켓 ID가 UUID가 아님', (i) => ({ ...i, tickets: [{ ...i.tickets[0]!, ticketId: 'TKT-1' }, ...i.tickets.slice(1)] })],
    ['행위자 모양이 틀림', (i) => ({ ...i, actor: 'ticket-issue' })],
  ])('입력이 틀리면(%s) RangeError이고 아무것도 바뀌지 않으며(큐 행·임대 그대로), 맞는 입력으로 다시 부르면 CONFIRMED다 [ASVS v5.0.0-2.2.1] [ASVS v5.0.0-2.3.3]', async (_label, change) => {
    const s = fresh();
    const a = await approved(s);
    const job = await s.issue.claim(a.o.id, LEASE);
    const good: TicketIssueCompleteInput = { orderId: a.o.id, tickets: ticketsOf({ orderId: a.o.id, seatIds: seatIdsOf(a.o) }), actor: ISSUE_ACTOR, leaseUntilMs: job!.leaseUntilMs };
    const before = await traceOf(a.o);
    await expect(s.issue.complete(change(good))).rejects.toThrow(RangeError);
    expect(await traceOf(a.o)).toEqual(before);
    expect(await s.issue.complete(good)).toEqual({ status: 'CONFIRMED' });
  });

  test('PT15_ADR0106_같은 주문의 성공 반영 둘이 두 연결에서 겹치면 뒤의 것은 큐 행 잠금을 기다렸다가 LEASE_LOST이고, T18·Outbox CONFIRMED·티켓 ID는 한 번이다(이중 발권 0) [ASVS v5.0.0-2.3.4]', async () => {
    const s = fresh();
    const a = await approved(s);
    const tickets = ticketsOf({ orderId: a.o.id, seatIds: seatIdsOf(a.o) });
    // order_item 갱신마다 0.3초 쉰다(첫 반영이 큐 행·주문 행을 쥔 시간을 늘린다)
    await q('insert into ti_slow (order_id, ms) values ($1, 300)', [a.o.id]);
    let firstDone = false;
    let secondDone = false;
    const first = s.issue.complete({ orderId: a.o.id, tickets, actor: ISSUE_ACTOR }).finally(() => {
      firstDone = true;
    });
    first.catch(() => undefined);
    let second: Promise<TicketIssueCompleteOutcome> | undefined;
    try {
      expect(await waitFor(async () => firstDone || (await sleepers(APP)) > 0, 5_000)).toBe(true);
      expect(firstDone).toBe(false);
      second = otherPod(s)
        .complete({ orderId: a.o.id, tickets, actor: ISSUE_ACTOR })
        .finally(() => {
          secondDone = true;
        });
      second.catch(() => undefined);
      expect(await waitFor(async () => secondDone || (await lockWaiters(RACE)) > 0, 5_000)).toBe(true);
      expect(secondDone).toBe(false);
      expect(await first).toEqual({ status: 'CONFIRMED' });
      expect(await second).toEqual({ status: 'LEASE_LOST' });
    } finally {
      await first.catch(() => undefined);
      await second?.catch(() => undefined);
      await q('delete from ti_slow where order_id = $1', [a.o.id]);
    }
    expect(await causesOf(a.o.id)).toEqual([...BEFORE_ISSUE, 'T18']);
    expect(await outboxTypes(a.o)).toEqual([...OUTBOX_APPROVED, 'CONFIRMED']);
    expect(await ticketIdsOf(a.o.id)).toEqual(ticketRows(a.o));
  });
});

// ───────────────────────────── 다시 보내기·멈추기·임대 놓기 ─────────────────────────────

describe('DrizzleTicketIssue.retry·stop·release(자기 임대 조건의 UPDATE 한 문장, 주문 이력 T19 없음)', () => {
  test('ADR0106_retry는 자기 임대일 때 attempts + 1·last_error = 코드·next_attempt_at = nextAtMs·임대 비움이고, 주문 상태·이력(T19 없음)·Outbox는 그대로다. 다음 시도 시각 전에는 잡히지 않고, 남의 임대·없는 행이면 false다 [ASVS v5.0.0-16.5.2]', async () => {
    const s = fresh();
    const a = await approved(s);
    const before = await traceOf(a.o);
    const job = await s.issue.claim(a.o.id, LEASE);
    const next = s.clock.now() + 1_000;

    expect(await s.issue.retry({ orderId: a.o.id, nextAtMs: next, code: 'UNAVAILABLE', leaseUntilMs: job!.leaseUntilMs })).toBe(true);

    expect(await issueRowOf(a.o.id)).toEqual({ ...before.issue!, attempts: 1, last_error: 'UNAVAILABLE', next_attempt_at: new Date(next), lease_until: null });
    expect(await claimFree(s, a.o.id)).toBeUndefined();
    s.clock.advance(1_000);
    const again = await s.issue.claim(a.o.id, LEASE);
    expect(again).toMatchObject({ attempts: 1, lastError: 'UNAVAILABLE', nextAttemptAtMs: next });
    // 옛 임대(이미 놓았다)로는 바꾸지 못한다
    expect(await s.issue.retry({ orderId: a.o.id, nextAtMs: next + 9_000, code: 'INTERNAL', leaseUntilMs: job!.leaseUntilMs })).toBe(false);
    expect((await issueRowOf(a.o.id))?.attempts).toBe(1);
    expect(await s.issue.retry({ orderId: a.o.id, nextAtMs: next + 2_000, code: 'DEADLINE_EXCEEDED', leaseUntilMs: again!.leaseUntilMs })).toBe(true);
    expect(await issueRowOf(a.o.id)).toMatchObject({ attempts: 2, last_error: 'DEADLINE_EXCEEDED', next_attempt_at: new Date(next + 2_000), lease_until: null });
    expect(await s.issue.retry({ orderId: uuidv7(s.clock), nextAtMs: next, code: 'UNAVAILABLE' })).toBe(false);
    const after = await traceOf(a.o);
    expect({ order: after.order, history: after.history, outbox: after.outbox, tickets: after.tickets }).toEqual({
      order: before.order,
      history: before.history,
      outbox: before.outbox,
      tickets: before.tickets,
    });
    expect(await causesOf(a.o.id)).toEqual(BEFORE_ISSUE);
  });

  test('PT39_④_ADR0106_stop은 자기 임대일 때 attempts + 1·last_error·next_attempt_at 비움·임대 비움이고, 그 뒤로는 claimDue·claim이 잡지 않는다(한 시간 뒤에도). 주문은 APPROVED 그대로다(결제 취소 0). 남의 임대면 false다 [ASVS v5.0.0-16.5.2]', async () => {
    const s = fresh();
    const a = await approved(s);
    const before = await traceOf(a.o);
    const job = await s.issue.claim(a.o.id, LEASE);
    expect(await s.issue.stop({ orderId: a.o.id, code: 'FAILED_PRECONDITION', leaseUntilMs: job!.leaseUntilMs + 1 })).toBe(false);
    expect((await issueRowOf(a.o.id))?.lease_until).toEqual(new Date(job!.leaseUntilMs));

    expect(await s.issue.stop({ orderId: a.o.id, code: 'FAILED_PRECONDITION', leaseUntilMs: job!.leaseUntilMs })).toBe(true);

    expect(await issueRowOf(a.o.id)).toEqual({ ...before.issue!, attempts: 1, last_error: 'FAILED_PRECONDITION', next_attempt_at: null, lease_until: null });
    s.clock.advance(HOUR);
    expect(await s.issue.claimDue(50, LEASE)).toEqual([]);
    expect(await s.issue.claim(a.o.id, LEASE)).toBeUndefined();
    expect(await s.issue.get(a.o.id)).toMatchObject({ orderId: a.o.id, attempts: 1, lastError: 'FAILED_PRECONDITION' });
    expect(await orderRow(a.o.id)).toEqual(before.order);
    expect(await outboxTypes(a.o)).toEqual(OUTBOX_APPROVED);
    expect(await causesOf(a.o.id)).toEqual(BEFORE_ISSUE);
    expect(await s.issue.stop({ orderId: uuidv7(s.clock), code: 'NOT_FOUND' })).toBe(false);
  });

  test('release는 자기 임대일 때 임대만 비우고(다른 칸 그대로) 곧바로 다시 잡히며, 남의 임대·이미 놓은 임대면 false다', async () => {
    const s = fresh();
    const now = s.clock.now();
    const o = await putJob(s, { nextAtMs: now - 1_000, attempts: 3, lastError: 'UNAVAILABLE' });
    const job = await s.issue.claim(o.id, LEASE);
    const claimed = await issueRowOf(o.id);
    expect(await s.issue.release(o.id, job!.leaseUntilMs + 1)).toBe(false);
    expect(await issueRowOf(o.id)).toEqual(claimed);

    expect(await s.issue.release(o.id, job!.leaseUntilMs)).toBe(true);

    expect(await issueRowOf(o.id)).toEqual({ ...claimed!, lease_until: null });
    expect(await s.issue.release(o.id, job!.leaseUntilMs)).toBe(false);
    expect(await s.issue.claim(o.id, LEASE)).toMatchObject({ orderId: o.id, attempts: 3, lastError: 'UNAVAILABLE', nextAttemptAtMs: now - 1_000 });
  });
});

/** 임대 없이 잡히는지만 본다(잡히면 곧바로 임대를 놓아 다음 단언에 남지 않게) */
async function claimFree(s: Fresh, orderId: string): Promise<TicketIssueJob | undefined> {
  const j = await s.issue.claim(orderId, LEASE);
  if (j) await q('update ticket_issue_job set lease_until = null where order_id = $1', [orderId]);
  return j;
}

// ───────────────────────────── ISSUE_DELAYED·발권 기한 넘김 ─────────────────────────────

describe('DrizzleTicketIssue.markDelayed·markOverdue(한 트랜잭션, SKIP LOCKED, 주문마다 한 번)', () => {
  test('PT39_①_ADR0106_markDelayed는 created_at ≤ 지금 − 60초이고 delayed_at이 빈 행마다 Outbox ISSUE_DELAYED(상태 전이·이력 없음, eventKey = 주문마다 고정 UUIDv8, Kafka 키 = 회차)와 delayed_at = 지금을 쓰고 created_at 차례로 주문 ID를 돌려준다. 멈춘 행·임대 중인 행도 대상이고, 다시 부르면 아무것도 내지 않는다', async () => {
    const s = fresh();
    const now = s.clock.now();
    const old = await putJob(s, { createdAtMs: now - 90_000, nextAtMs: now + 5_000, attempts: 3, lastError: 'UNAVAILABLE' });
    const stopped = await putJob(s, { createdAtMs: now - 80_000, nextAtMs: null, attempts: 1, lastError: 'NOT_FOUND' });
    const leased = await putJob(s, { createdAtMs: now - 70_000, leaseUntilMs: now + 20_000 });
    const exact = await putJob(s, { createdAtMs: now - DELAYED_AFTER_MS });
    const young = await putJob(s, { createdAtMs: now - DELAYED_AFTER_MS + 1 });
    const done = await putJob(s, { createdAtMs: now - 120_000, delayedAtMs: now - 60_000 });

    expect(await s.issue.markDelayed(100)).toEqual([old.id, stopped.id, leased.id, exact.id]);

    for (const o of [old, stopped, leased, exact]) {
      const outbox = await outboxOf(o.eventId);
      expect(outbox.map((x) => x.event.type)).toEqual([...OUTBOX_APPROVED, 'ISSUE_DELAYED']);
      expect(outbox.at(-1)!.topic).toBe(TRADE_ORDERS);
      expect(outbox.at(-1)!.event).toEqual(issueDelayedOf(o, now));
      expect(contractIssues(outbox.at(-1)!.event)).toEqual([]);
      expect((await issueRowOf(o.id))?.delayed_at).toEqual(new Date(now));
      // 상태 전이·이력이 없다
      expect(await orderRow(o.id)).toEqual({ status: 'APPROVED', event_seq: 5 });
      expect(await causesOf(o.id)).toEqual(BEFORE_ISSUE);
    }
    // delayed_at 말고는 그대로다
    expect(await issueRowOf(old.id)).toMatchObject({ attempts: 3, last_error: 'UNAVAILABLE', next_attempt_at: new Date(now + 5_000), lease_until: null, overdue_at: null });
    expect(await issueRowOf(stopped.id)).toMatchObject({ next_attempt_at: null, attempts: 1 });
    expect(await issueRowOf(leased.id)).toMatchObject({ lease_until: new Date(now + 20_000) });
    for (const o of [young, done]) expect(await outboxTypes(o)).toEqual(OUTBOX_APPROVED);
    expect((await issueRowOf(young.id))?.delayed_at).toBeNull();
    expect((await issueRowOf(done.id))?.delayed_at).toEqual(new Date(now - 60_000));
    // 한 번만 낸다
    expect(await s.issue.markDelayed(100)).toEqual([]);
    s.clock.advance(5 * MIN);
    expect(await s.issue.markDelayed(100)).toEqual([young.id]);
    for (const o of [old, stopped, leased, exact, young]) expect((await outboxTypes(o)).filter((t) => t === 'ISSUE_DELAYED'), o.id).toHaveLength(1);
    expect(await outboxTypes(done)).toEqual(OUTBOX_APPROVED);
  });

  test('ADR0106_ISSUE_DELAYED와 delayed_at은 한 트랜잭션이고, limit개까지만 created_at이 이른 것부터 낸다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const now = s.clock.now();
    const rows = [await putJob(s, { createdAtMs: now - 63_000 }), await putJob(s, { createdAtMs: now - 62_000 }), await putJob(s, { createdAtMs: now - 61_000 })];
    expect(await s.issue.markDelayed(2)).toEqual([rows[0]!.id, rows[1]!.id]);
    expect(await s.issue.markDelayed(2)).toEqual([rows[2]!.id]);
    for (const o of rows) {
      const tx = await delayedTxOf(o.id);
      expect(tx.outbox, o.id).toHaveLength(1);
      expect(tx.mark, o.id).toEqual(tx.outbox);
    }
  });

  test('리뷰 고침 L7_ADR0106_markDelayed 한 트랜잭션은 고른 행의 delayed_at을 먼저 쓰고 ISSUE_DELAYED Outbox를 마지막에 한 번에 쓴다(ADR-0116 결정 3: Outbox가 업무 문장의 마지막). APPROVED가 아닌 어긋난 행은 delayed_at만 쓴다', async () => {
    const s = fresh();
    const now = s.clock.now();
    const rows = [await putJob(s, { createdAtMs: now - 63_000 }), await putJob(s, { createdAtMs: now - 62_000 }), await putJob(s, { createdAtMs: now - 61_000 })];
    const odd = await putJob(s, { createdAtMs: now - 64_000 });
    await walk(s, odd, ['T18']);
    expect(await s.issue.markDelayed(100)).toEqual(rows.map((o) => o.id));
    const xid = (await delayedTxOf(rows[0]!.id)).outbox[0]!;
    for (const o of rows) expect(await delayedTxOf(o.id), o.id).toEqual({ outbox: [xid], mark: [xid] });
    expect((await delayedTxOf(odd.id)).mark).toEqual([xid]);
    const ops = await q<{ tbl: string; op: string }>('select tbl, op from ti_audit where xid = $1::bigint order by n', [xid]);
    const writes: string[] = [];
    for (const r of ops) {
      const w = `${r.op} ${r.tbl.startsWith('outbox') ? 'outbox' : r.tbl}`;
      if (writes.at(-1) !== w) writes.push(w);
    }
    expect(writes).toEqual(['UPDATE ticket_issue_job', 'INSERT outbox']);
    expect(ops.filter((r) => r.tbl.startsWith('outbox'))).toHaveLength(3);
    expect(ops.filter((r) => r.tbl === 'ticket_issue_job')).toHaveLength(4);
  });

  test('PT39_②_ADR0106_markOverdue는 issue_due_at ≤ 지금이고 overdue_at이 빈 행에 overdue_at = 지금을 쓰고 issue_due_at 차례로 주문 ID를 돌려준다. next_attempt_at·attempts·주문·Outbox는 그대로이고(재시도는 이어 간다) 다시 부르면 아무것도 표시하지 않는다', async () => {
    const s = fresh();
    const now = s.clock.now();
    const late = await putJob(s, { issueDueAtMs: now - 5 * MIN, nextAtMs: now + 60_000, attempts: 9, lastError: 'UNAVAILABLE' });
    const exact = await putJob(s, { issueDueAtMs: now });
    const stopped = await putJob(s, { issueDueAtMs: now - MIN, nextAtMs: null, attempts: 1, lastError: 'FAILED_PRECONDITION' });
    const notYet = await putJob(s, { issueDueAtMs: now + 1 });
    const already = await putJob(s, { issueDueAtMs: now - 10 * MIN, overdueAtMs: now - MIN });
    const before = new Map<string, Awaited<ReturnType<typeof traceOf>>>();
    for (const o of [late, exact, stopped, notYet, already]) before.set(o.id, await traceOf(o));

    expect(await s.issue.markOverdue(100)).toEqual([late.id, stopped.id, exact.id]);

    for (const o of [late, exact, stopped]) {
      const b = before.get(o.id)!;
      expect(await traceOf(o)).toEqual({ ...b, issue: { ...b.issue!, overdue_at: new Date(now) } });
    }
    for (const o of [notYet, already]) expect(await traceOf(o)).toEqual(before.get(o.id));
    expect(await s.issue.markOverdue(100)).toEqual([]);
    s.clock.advance(1);
    expect(await s.issue.markOverdue(1)).toEqual([notYet.id]);
  });

  test('PT15_ADR0106_두 파드가 동시에 markDelayed·markOverdue를 불러도 주문마다 ISSUE_DELAYED 한 번·기한 넘김 표시 한 번이다(세 번) [ASVS v5.0.0-2.3.4]', async () => {
    for (let round = 0; round < 3; round += 1) {
      await q('delete from ticket_issue_job');
      const s = fresh(BASE_MS + round * HOUR);
      const now = s.clock.now();
      const orders: NewOrder[] = [];
      for (let i = 0; i < 8; i += 1) orders.push(await putJob(s, { createdAtMs: now - 2 * MIN - i, issueDueAtMs: now - i }));
      const ids = orders.map((o) => o.id).sort();

      const delayed = await Promise.allSettled([s.issue.markDelayed(100), otherPod(s).markDelayed(100)]);
      const overdue = await Promise.allSettled([s.issue.markOverdue(100), otherPod(s).markOverdue(100)]);

      for (const settled of [delayed, overdue]) {
        expect(rejections(settled), `${round}회`).toEqual([]);
        const [a, b] = settled.map((x) => (x as PromiseFulfilledResult<string[]>).value);
        expect(a!.filter((id) => b!.includes(id)), `${round}회 겹침`).toEqual([]);
        expect([...a!, ...b!].sort(), `${round}회`).toEqual(ids);
      }
      for (const o of orders) expect((await outboxTypes(o)).filter((t) => t === 'ISSUE_DELAYED'), `${round}회`).toHaveLength(1);
    }
  });

  test.each<[string, 'markDelayed' | 'markOverdue', number]>([
    ['markDelayed limit 0', 'markDelayed', 0],
    ['markDelayed limit 소수', 'markDelayed', 1.5],
    ['markOverdue limit 0', 'markOverdue', 0],
    ['markOverdue limit NaN', 'markOverdue', Number.NaN],
  ])('%s면 RangeError이고 아무것도 표시하지 않는다 [ASVS v5.0.0-2.2.1]', async (_label, method, limit) => {
    const s = fresh();
    const now = s.clock.now();
    const o = await putJob(s, { createdAtMs: now - 2 * MIN, issueDueAtMs: now - 1 });
    await expect(s.issue[method](limit)).rejects.toThrow(RangeError);
    expect(await issueRowOf(o.id)).toMatchObject({ delayed_at: null, overdue_at: null });
    expect(await outboxTypes(o)).toEqual(OUTBOX_APPROVED);
  });
});

// ───────────────────────────── 게이지 ─────────────────────────────

describe('DrizzleTicketIssue.gauges(잠그지 않는 한 질의)', () => {
  test('ADR0106_gauges는 next_attempt_at이 있는 행(임대 중 포함)·비운 행의 수와 다시 보낼 행 가운데 가장 오래된 행의 나이(초, 멈춘 행은 빼고, 리뷰 고침 M3)다. 행이 없으면 0·0·0이고 아무것도 쓰지 않는다', async () => {
    const s = fresh();
    const now = s.clock.now();
    expect(await s.issue.gauges()).toEqual({ pending: 0, stopped: 0, oldestAgeSeconds: 0 });
    const orders = [
      await putJob(s, { createdAtMs: now - 10_000 }),
      await putJob(s, { createdAtMs: now - 3_000, leaseUntilMs: now + 20_000 }),
      await putJob(s, { createdAtMs: now, nextAtMs: now + 30_000, attempts: 5, lastError: 'UNAVAILABLE' }),
      await putJob(s, { createdAtMs: now - 95_000, nextAtMs: null, attempts: 1, lastError: 'FAILED_PRECONDITION' }),
    ];
    const before = await Promise.all(orders.map((o) => issueRowOf(o.id)));

    expect(await s.issue.gauges()).toEqual({ pending: 3, stopped: 1, oldestAgeSeconds: 10 });
    s.clock.advance(5_000);
    expect(await s.issue.gauges()).toEqual({ pending: 3, stopped: 1, oldestAgeSeconds: 15 });

    expect(await Promise.all(orders.map((o) => issueRowOf(o.id)))).toEqual(before);
  });

  test('리뷰 고침 M3_ADR0106_가장 오래된 행의 나이(ticket_issue_oldest_seconds)는 다시 보낼 행(next_attempt_at 있음)만 본다: 오래된 멈춘 행 하나와 새 행 하나면 새 행의 나이이고, 멈춘 행만 있으면 0이다(멈춘 행은 ticket_issue_jobs{state="stopped"}가 알린다)', async () => {
    const s = fresh();
    const now = s.clock.now();
    await putJob(s, { createdAtMs: now - 25 * MIN, nextAtMs: null, attempts: 1, lastError: 'FAILED_PRECONDITION' });
    expect(await s.issue.gauges()).toEqual({ pending: 0, stopped: 1, oldestAgeSeconds: 0 });
    await putJob(s, { createdAtMs: now - 7_000 });
    expect(await s.issue.gauges()).toEqual({ pending: 1, stopped: 1, oldestAgeSeconds: 7 });
  });
});

// ───────────────────────────── 실행기 ─────────────────────────────

describe('TicketIssueRunner + 대역 ticket-svc(실제 purchase DB)', () => {
  test('ADR0106_승인 주문은 실행기 틱 한 번에 늘 발권 대역(issuingTicketIssuer)으로 CONFIRMED가 되고, 좌석별 티켓 ID는 UUIDv8(SHA-256(Ticket:주문 ID:좌석 ID))이다. 이력 T18(system:ticket-issue)·Outbox CONFIRMED·큐 행 없음, 지표 issued·onOrderChanged 한 번', async () => {
    const s = fresh();
    const a = await approved(s);
    const changed: string[] = [];
    const { runner, log, signals } = runnerOf(s, { issuer: issuingTicketIssuer, onOrderChanged: (id) => void changed.push(id) });

    expect(await runner.tick()).toMatchObject({ claimed: 1, delayed: 0, overdue: 0, measured: true });

    expect(await orderRow(a.o.id)).toEqual({ status: 'CONFIRMED', event_seq: 6 });
    expect(await ticketIdsOf(a.o.id)).toEqual(ticketRows(a.o, (orderId, seatId) => uuid8(`Ticket:${orderId}:${seatId}`)));
    expect((await historyOf(a.o.id)).at(-1)).toMatchObject({ from_status: 'APPROVED', to_status: 'CONFIRMED', cause: 'T18', actor: ISSUE_ACTOR });
    expect(await issueRowOf(a.o.id)).toBeUndefined();
    expect(await outboxTypes(a.o)).toEqual([...OUTBOX_APPROVED, 'CONFIRMED']);
    expect(changed).toEqual([a.o.id]);
    expect(signals.attempts).toEqual(['issued']);
    expect(log).toEqual([]);
    // 다음 틱에는 할 것이 없다
    expect(await runner.tick()).toMatchObject({ claimed: 0 });
  });

  test('ADR0106_결제 결과 반영이 승인(T9)을 커밋하면 onApproved → kick이 그 주문을 곧바로 돈다(틱 없이 CONFIRMED). 발권 호출은 주문 ID·회차·결제자·좌석(줄 번호 차례)·데드라인 2초로 한 번이다', async () => {
    const s = fresh();
    const issuer = recordingIssuer(s.clock);
    const { runner, log, signals } = runnerOf(s, { issuer: issuer.issuer });

    const a = await approved(s, { onApproved: (id) => runner.kick(id) });

    expect(await waitFor(async () => (await orderRow(a.o.id))?.status === 'CONFIRMED', 5_000)).toBe(true);
    expect(issuer.calls).toEqual([{ orderId: a.o.id, eventId: a.o.eventId, payerAccountId: a.o.accountId, seatIds: seatIdsOf(a.o), deadlineMs: DEADLINE_MS }]);
    expect(await ticketIdsOf(a.o.id)).toEqual(ticketRows(a.o));
    // 다시 돌려도 할 것이 없다(큐 행이 지워졌다)
    expect(await runner.runOne(a.o.id)).toEqual({ kind: 'SKIPPED', reason: 'NO_JOB' });
    await runner.stop();
    expect(signals.attempts).toEqual(['issued']);
    expect(log).toEqual([]);
  });

  test('ADR0106_ticket-svc가 UNAVAILABLE을 두 번 낸 뒤 성공하면: 실패마다 attempts + 1·last_error·다음 시각 = 지금 + 1초·2초(늘려 쉬기, 흔들기 × 1)·임대 비움이고, 기한 전에는 부르지 않으며, attempts 2 뒤 세 번째 시도에 CONFIRMED다. 같은 주문 ID로만 부르고 주문 이력에 T19가 없다 [ASVS v5.0.0-16.5.2]', async () => {
    const s = fresh();
    const a = await approved(s);
    const issuer = recordingIssuer(s.clock, (c, n) => (n <= 2 ? 'UNAVAILABLE' : ticketsOf(c)));
    const { runner, log, signals } = runnerOf(s, { issuer: issuer.issuer });
    const t0 = s.clock.now();

    await runner.tick();
    expect(await issueRowOf(a.o.id)).toMatchObject({ attempts: 1, last_error: 'UNAVAILABLE', next_attempt_at: new Date(t0 + 1_000), lease_until: null });
    expect(await orderRow(a.o.id)).toMatchObject({ status: 'APPROVED' });
    // 기한 전에는 부르지 않는다
    s.clock.advance(999);
    await runner.tick();
    expect(issuer.calls).toHaveLength(1);
    s.clock.advance(1);
    await runner.tick();
    expect(await issueRowOf(a.o.id)).toMatchObject({ attempts: 2, last_error: 'UNAVAILABLE', next_attempt_at: new Date(t0 + 3_000), lease_until: null });
    s.clock.advance(2_000);
    await runner.tick();

    expect(await orderRow(a.o.id)).toEqual({ status: 'CONFIRMED', event_seq: 6 });
    expect(await issueRowOf(a.o.id)).toBeUndefined();
    expect(await ticketIdsOf(a.o.id)).toEqual(ticketRows(a.o));
    expect(issuer.calls.map((c) => c.orderId)).toEqual([a.o.id, a.o.id, a.o.id]);
    expect(issuer.at.map((t) => t - t0)).toEqual([0, 1_000, 3_000]);
    expect(await causesOf(a.o.id)).toEqual([...BEFORE_ISSUE, 'T18']);
    expect(signals.attempts).toEqual(['retry', 'retry', 'issued']);
    expect(log).toEqual([]);
  });

  test.each<[string, (c: TicketIssueCommand) => Answer, TicketIssueFailureCode]>([
    ['FAILED_PRECONDITION', () => 'FAILED_PRECONDITION', 'FAILED_PRECONDITION'],
    ['답의 좌석 하나가 빠짐(BAD_ANSWER)', (c) => ticketsOf(c).slice(1), 'BAD_ANSWER'],
  ])('PT39_④_ADR0106_ticket-svc가 %s면 멈춘 행으로 남는다(attempts 1·last_error·next_attempt_at 비움·임대 비움). SEV2 로그 stopped(주문 ID·코드) 한 줄과 지표 stopped이고, 주문 APPROVED·티켓 ID 없음·결제 취소 0이며 10분 뒤에도 다시 부르지 않는다 [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.5.2]', async (_label, answer, code) => {
    const s = fresh();
    const a = await approved(s);
    const issuer = recordingIssuer(s.clock, answer);
    const { runner, log, signals } = runnerOf(s, { issuer: issuer.issuer });

    await runner.tick();

    expect(await issueRowOf(a.o.id)).toMatchObject({ attempts: 1, last_error: code, next_attempt_at: null, lease_until: null });
    expect(log).toEqual([{ kind: 'stopped', e: { orderId: a.o.id, code } }]);
    expect(signals.attempts).toEqual(['stopped']);
    s.clock.advance(10 * MIN);
    await runner.tick();
    expect(issuer.calls).toHaveLength(1);
    expect(await orderRow(a.o.id)).toMatchObject({ status: 'APPROVED' });
    expect(await ticketIdsOf(a.o.id)).toEqual(noTickets(a.o));
    expect(await causesOf(a.o.id)).toEqual(BEFORE_ISSUE);
    // 멈춘 행도 60초가 지나 ISSUE_DELAYED는 한 번 나간다. 결제 취소(COMPENSATED)는 없다
    expect(await outboxTypes(a.o)).toEqual([...OUTBOX_APPROVED, 'ISSUE_DELAYED']);
    expect(log.filter((l) => l.kind === 'stopped')).toHaveLength(1);
  });

  test.each<[string, string, number, number[]]>([
    ['PT39_①', '2분', 2 * MIN, [0, 1, 3, 7, 15, 31, 63, 123]],
    ['PT1', '5분', 5 * MIN, [0, 1, 3, 7, 15, 31, 63, 123, 183, 243, 303]],
  ])(
    '%s_ADR0106_ticket-svc가 승인 뒤 %s 동안 UNAVAILABLE이면 결제를 취소하지 않고 1초 틱마다 늘려 쉬며(1·2·4…초, 상한 60초) 같은 주문 ID로 다시 불러 멈춤이 끝난 다음 시도에 CONFIRMED다. 승인 뒤 60초에 ISSUE_DELAYED 한 번(지표 delayed 1), 기한 넘김 없음, 이중 발권 0 [ASVS v5.0.0-16.5.2]',
    async (_id, _label, outageMs, seconds) => {
      const s = fresh();
      const a = await approved(s);
      const t0 = s.clock.now();
      const issuer = recordingIssuer(s.clock, (c) => (s.clock.now() - t0 < outageMs ? 'UNAVAILABLE' : ticketsOf(c)));
      const { runner, log, signals } = runnerOf(s, { issuer: issuer.issuer });
      const delayedAt: number[] = [];

      for (let sec = 0; sec <= seconds.at(-1)! + 5; sec += 1) {
        const r = await runner.tick();
        if (r.delayed > 0) delayedAt.push(sec);
        if ((await orderRow(a.o.id))?.status === 'CONFIRMED') break;
        s.clock.advance(1_000);
      }

      expect(await orderRow(a.o.id)).toEqual({ status: 'CONFIRMED', event_seq: 6 });
      expect(issuer.at.map((t) => (t - t0) / 1_000)).toEqual(seconds);
      expect(new Set(issuer.calls.map((c) => c.orderId))).toEqual(new Set([a.o.id]));
      expect(delayedAt).toEqual([60]);
      expect(signals.sums).toEqual({ delayed: 1, overdue: 0 });
      expect(signals.attempts).toEqual([...Array.from({ length: seconds.length - 1 }, () => 'retry'), 'issued']);
      expect(await outboxTypes(a.o)).toEqual([...OUTBOX_APPROVED, 'ISSUE_DELAYED', 'CONFIRMED']);
      expect(await causesOf(a.o.id)).toEqual([...BEFORE_ISSUE, 'T18']);
      expect(await ticketIdsOf(a.o.id)).toEqual(ticketRows(a.o));
      expect(log).toEqual([]);
    },
    60_000,
  );

  test('PT39_②_ADR0106_발권 기한(승인 + 30분)이 되면 틱이 그 주문에 SEV1 overdue 로그 한 줄·지표 overdue 1을 한 번만 내고(overdue_at), 재시도는 이어 간다(next_attempt_at 있음, 다시 부름). 결제 취소 0 [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.5.2]', async () => {
    const s = fresh();
    const a = await approved(s);
    const t0 = s.clock.now();
    const issuer = recordingIssuer(s.clock, () => 'UNAVAILABLE');
    const { runner, log, signals } = runnerOf(s, { issuer: issuer.issuer });
    await runner.tick();
    // 기한 1ms 전: ISSUE_DELAYED는 내지만 기한 넘김은 아니다
    s.clock.advance(ISSUE_WINDOW_MS - 1);
    expect(await runner.tick()).toMatchObject({ delayed: 1, overdue: 0 });
    expect((await issueRowOf(a.o.id))?.overdue_at).toBeNull();
    // 기한 = 지금
    s.clock.advance(1);
    expect(await runner.tick()).toMatchObject({ delayed: 0, overdue: 1 });
    expect(log.filter((l) => l.kind === 'overdue')).toEqual([{ kind: 'overdue', e: { orderId: a.o.id } }]);
    const row = await issueRowOf(a.o.id);
    expect(row).toMatchObject({ overdue_at: new Date(t0 + ISSUE_WINDOW_MS), issue_due_at: new Date(t0 + ISSUE_WINDOW_MS) });
    expect(row?.next_attempt_at).not.toBeNull();
    // 재시도는 이어 가고 기한 넘김은 다시 내지 않는다
    const callsBefore = issuer.calls.length;
    s.clock.advance(61_000);
    expect(await runner.tick()).toMatchObject({ delayed: 0, overdue: 0 });
    expect(issuer.calls).toHaveLength(callsBefore + 1);
    expect(log.filter((l) => l.kind === 'overdue')).toHaveLength(1);
    expect(signals.sums).toEqual({ delayed: 1, overdue: 1 });
    expect(await orderRow(a.o.id)).toMatchObject({ status: 'APPROVED' });
    expect(await outboxTypes(a.o)).toEqual([...OUTBOX_APPROVED, 'ISSUE_DELAYED']);
    expect(log.filter((l) => l.kind !== 'overdue')).toEqual([]);
  });

  test('PT15_ADR0106_두 파드의 실행기가 같은 때 틱을 돌아도 큐 행 하나는 한 파드만 잡아(SKIP LOCKED·임대) 주문마다 발권 호출 한 번·T18 한 번·Outbox CONFIRMED 한 번이다(세 번) [ASVS v5.0.0-2.3.4]', async () => {
    for (let round = 0; round < 3; round += 1) {
      await q('delete from ticket_issue_job');
      const s = fresh(BASE_MS + round * HOUR);
      const orders: Approved[] = [];
      for (let i = 0; i < 6; i += 1) orders.push(await approved(s));
      const issuer = recordingIssuer(s.clock);
      const one = runnerOf(s, { issuer: issuer.issuer });
      const two = runnerOf(s, { issuer: issuer.issuer, jobs: otherPod(s) });

      const settled = await Promise.allSettled([one.runner.tick(), two.runner.tick()]);

      expect(rejections(settled), `${round}회`).toEqual([]);
      expect(issuer.calls.map((c) => c.orderId).sort(), `${round}회`).toEqual(orders.map((x) => x.o.id).sort());
      for (const x of orders) {
        expect(await orderRow(x.o.id), `${round}회`).toMatchObject({ status: 'CONFIRMED' });
        expect((await causesOf(x.o.id)).filter((c) => c === 'T18'), `${round}회`).toHaveLength(1);
        expect((await outboxTypes(x.o)).filter((t) => t === 'CONFIRMED'), `${round}회`).toHaveLength(1);
      }
      expect([...one.signals.attempts, ...two.signals.attempts], `${round}회`).toEqual(Array.from({ length: 6 }, () => 'issued'));
    }
  });

  test('PT15_ADR0106_임대가 끝난 뒤 늦게 온 발권 답: 첫 파드의 호출이 30초를 넘기는 사이 둘째 파드가 다시 잡아 CONFIRMED로 쓰면, 첫 파드의 늦은 답은 LEASE_LOST로 아무것도 바꾸지 않는다(T18·Outbox CONFIRMED 한 번, 지표 없음) [ASVS v5.0.0-2.3.4]', async () => {
    const s = fresh();
    const a = await approved(s);
    const slow = deferred<Answer>();
    const issuer = recordingIssuer(s.clock, (c, n) => (n === 1 ? slow.promise : ticketsOf(c)));
    const first = runnerOf(s, { issuer: issuer.issuer });
    const second = runnerOf(s, { issuer: issuer.issuer, jobs: otherPod(s) });
    const late = first.runner.runOne(a.o.id);
    late.catch(() => undefined);
    try {
      expect(await waitFor(async () => issuer.calls.length === 1, 5_000)).toBe(true);
      s.clock.advance(LEASE + 1);
      expect(await second.runner.runOne(a.o.id)).toEqual({ kind: 'ISSUED' });
      slow.resolve(ticketsOf(issuer.calls[0]!));
      expect(await late).toEqual({ kind: 'SKIPPED', reason: 'LEASE_LOST' });
    } finally {
      slow.resolve([]);
      await late.catch(() => undefined);
    }
    expect(issuer.calls.map((c) => c.orderId)).toEqual([a.o.id, a.o.id]);
    expect(await orderRow(a.o.id)).toEqual({ status: 'CONFIRMED', event_seq: 6 });
    expect(await causesOf(a.o.id)).toEqual([...BEFORE_ISSUE, 'T18']);
    expect(await outboxTypes(a.o)).toEqual([...OUTBOX_APPROVED, 'CONFIRMED']);
    expect(await ticketIdsOf(a.o.id)).toEqual(ticketRows(a.o));
    expect(first.signals.attempts).toEqual([]);
    expect(second.signals.attempts).toEqual(['issued']);
    expect([...first.log, ...second.log]).toEqual([]);
  });

  test('ADR0106_발권 답과 보상이 겹침: 부르는 사이 주문이 COMPENSATED로 가면(T20) 답은 상태를 바꾸지 않고 큐 행만 지운다(STALE, 경고 staleAnswer 한 줄·지표 stale, onOrderChanged 없음, 티켓 ID 없음) [ASVS v5.0.0-2.3.1]', async () => {
    const s = fresh();
    const a = await approved(s);
    const slow = deferred<Answer>();
    const issuer = recordingIssuer(s.clock, () => slow.promise);
    const changed: string[] = [];
    const { runner, log, signals } = runnerOf(s, { issuer: issuer.issuer, onOrderChanged: (id) => void changed.push(id) });
    const running = runner.runOne(a.o.id);
    running.catch(() => undefined);
    try {
      expect(await waitFor(async () => issuer.calls.length === 1, 5_000)).toBe(true);
      await walk(s, a.o, ['T20']);
      slow.resolve(ticketsOf(issuer.calls[0]!));
      expect(await running).toEqual({ kind: 'STALE', current: 'COMPENSATED' });
    } finally {
      slow.resolve([]);
      await running.catch(() => undefined);
    }
    expect(await orderRow(a.o.id)).toMatchObject({ status: 'COMPENSATED' });
    expect(await issueRowOf(a.o.id)).toBeUndefined();
    expect(await ticketIdsOf(a.o.id)).toEqual(noTickets(a.o));
    expect(await causesOf(a.o.id)).toEqual([...BEFORE_ISSUE, 'T20']);
    expect(log).toEqual([{ kind: 'staleAnswer', e: { orderId: a.o.id, current: 'COMPENSATED' } }]);
    expect(signals.attempts).toEqual(['stale']);
    expect(changed).toEqual([]);
  });

  test('ADR0106_stop(SIGTERM)은 반복을 끄고 부르던 발권 호출과 그 뒤 쓰기까지 기다리며, 잡았지만 시작하지 않은 행(빈자리를 기다리던 행)은 임대를 놓는다(동시 호출 1). 틱은 빈자리만큼만 잡는다(리뷰 고침 H1). 멈춘 뒤의 kick은 부르지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const s = fresh();
    const a = await approved(s);
    const b = await approved(s);
    const slow = deferred<Answer>();
    const issuer = recordingIssuer(s.clock, (c, n) => (n === 1 ? slow.promise : ticketsOf(c)));
    const timer = capturingTimer();
    const { runner } = runnerOf(s, { issuer: issuer.issuer, concurrency: 1, timer });
    let stopping: Promise<void> | undefined;
    let waitingRun: Promise<unknown> | undefined;
    try {
      runner.start();
      expect(timer.fn).toBeDefined();
      // 반복의 틱 하나: 빈자리 1이라 한 행만 잡고(임대) 부르는 중이다. 다른 행은 잡지 않는다(리뷰 고침 H1)
      timer.fn!();
      expect(await waitFor(async () => issuer.calls.length === 1, 5_000)).toBe(true);
      const firstId = issuer.calls[0]!.orderId;
      const otherId = firstId === a.o.id ? b.o.id : a.o.id;
      expect(await issueRowOf(otherId)).toMatchObject({ lease_until: null });
      // 다른 행을 손으로 잡아 실행기에 넘기면 빈자리를 기다린다(잡았지만 시작하지 않은 행)
      const otherJob = await s.issue.claim(otherId, LEASE);
      expect(otherJob).toBeDefined();
      waitingRun = runner.runJob(otherJob!);
      waitingRun.catch(() => undefined);
      await sleep(100);
      expect(issuer.calls).toHaveLength(1);
      let stopped = false;
      stopping = runner.stop().finally(() => {
        stopped = true;
      });
      stopping.catch(() => undefined);
      await sleep(200);
      expect(stopped).toBe(false);
      slow.resolve(ticketsOf(issuer.calls[0]!));
      await stopping;
      // 기다린 호출의 쓰기가 끝났고, 시작하지 않은 행은 부르지 않고 임대를 놓았다
      expect(await waitingRun).toEqual({ kind: 'SKIPPED', reason: 'RELEASED' });
      expect(await orderRow(firstId)).toMatchObject({ status: 'CONFIRMED' });
      expect(await issueRowOf(otherId)).toMatchObject({ attempts: 0, last_error: null, lease_until: null });
      expect(issuer.calls).toHaveLength(1);
      runner.kick(otherId);
      await sleep(200);
      expect(issuer.calls).toHaveLength(1);
      expect(await orderRow(otherId)).toMatchObject({ status: 'APPROVED' });
    } finally {
      slow.resolve([]);
      await stopping?.catch(() => undefined);
      await waitingRun?.catch(() => undefined);
    }
  });
});

// ───────────────────────────── long polling ─────────────────────────────

describe('결제 결과 long polling(GetPaymentStatus)과 발권 실행기', () => {
  test('FR011_ADR0106_APPROVED를 기다리는 long polling은 같은 파드의 실행기가 CONFIRMED로 바꾸면(onOrderChanged → notify) 묶음 조회 없이 곧바로 CONFIRMED로 답한다', async () => {
    const s = fresh();
    const a = await approved(s);
    const table = waitTableOf(s);
    try {
      const { runner } = runnerOf(s, { issuer: recordingIssuer(s.clock).issuer, onOrderChanged: (id) => table.notify(id) });
      const pending = pollOf(s, table, a.o);
      pending.catch(() => undefined);
      await waiting(table, 1);
      const issuedAt = performance.now();
      expect(await runner.runOne(a.o.id)).toEqual({ kind: 'ISSUED' });
      const { result, at } = await pending;
      expect(result).toEqual({ status: 200, body: { status: 'CONFIRMED', issueDelayed: false, pg: 'TOSS' } });
      expect(at - issuedAt).toBeLessThan(PROMPT_MS);
      expect(table.size()).toBe(0);
    } finally {
      await table.stop();
    }
  });

  test('FR011_ADR0106_다른 파드의 실행기가 CONFIRMED로 바꾸면(notify 없음) 묶음 조회 한 번이 깨워 CONFIRMED로 답한다', async () => {
    const s = fresh();
    const a = await approved(s);
    const table = waitTableOf(s);
    try {
      const { runner } = runnerOf(s, { issuer: recordingIssuer(s.clock).issuer });
      const pending = pollOf(s, table, a.o);
      pending.catch(() => undefined);
      await waiting(table, 1);
      expect(await runner.runOne(a.o.id)).toEqual({ kind: 'ISSUED' });
      expect(table.size()).toBe(1);
      expect(await table.pollOnce()).toBe(1);
      expect((await pending).result).toEqual({ status: 200, body: { status: 'CONFIRMED', issueDelayed: false, pg: 'TOSS' } });
    } finally {
      await table.stop();
    }
  });

  test('M2_ADR0106_issueDelayed와 ISSUE_DELAYED는 같은 60초 기준(큐 행 created_at)이다: 승인 + 59.999초에는 markDelayed가 아무것도 내지 않고 issueDelayed 거짓, + 60초에는 ISSUE_DELAYED 한 번과 함께 기다리던 long polling이 issueDelayed 참으로 답한다', async () => {
    const s = fresh();
    const a = await approved(s);
    const statusReads = new DrizzlePaymentStatus({ database });
    const table = waitTableOf(s);
    try {
      const pending = pollOf(s, table, a.o);
      pending.catch(() => undefined);
      await waiting(table, 1);
      s.clock.advance(DELAYED_AFTER_MS - 1);
      expect(await s.issue.markDelayed(100)).toEqual([]);
      expect(isIssueDelayed((await statusReads.read(a.o.id))!, s.clock.now())).toBe(false);
      expect(table.size()).toBe(1);
      s.clock.advance(1);
      expect(await s.issue.markDelayed(100)).toEqual([a.o.id]);
      expect(await table.pollOnce()).toBe(1);
      expect((await pending).result).toEqual({ status: 200, body: { status: 'APPROVED', issueDelayed: true, pg: 'TOSS' } });
      expect((await outboxOf(a.o.eventId)).at(-1)!.event).toEqual(issueDelayedOf(a.o, a.approvedAt + DELAYED_AFTER_MS));
    } finally {
      await table.stop();
    }
  });
});
