// 발권 재시도 큐의 purchase DB 쪽(TicketIssueJobs, ADR-0106 결정 2, docs/data.md §5, BUILD_ORDER PRF-170). drizzle-saga.ts(order_saga_job)와 같은 꼴이다.
// - 잡기(claimDue·claim): 짧은 트랜잭션 하나에서 next_attempt_at ≤ 지금이고 (lease_until이 비었거나 < 지금, data.md §5.1 행)인 ticket_issue_job 행을 FOR UPDATE SKIP LOCKED로
//   골라 lease_until = 지금 + 임대를 쓰고 바로 커밋한다. 주문 행(결제자 account_id)·주문 항목(좌석 ID, 줄 번호 차례)을 붙여 돌려준다. 잠금 밖에서 ticket-svc를 부른다.
// - 성공 반영(complete, READ COMMITTED): 큐 행 잠금(자기 임대, 0행이면 LEASE_LOST로 되돌림) → 주문 행 잠금·상태 확인(FOR NO KEY UPDATE, drizzle-payment-results.ts
//   lockSource와 같은 꼴. APPROVED가 아니면 큐 행만 지우고 커밋해 STALE) → order_item.ticket_id = 좌석별 티켓 ID(한 문장, 바꾼 행 수 = 좌석 수가 아니면 되돌림)
//   → 큐 행 지우기 → 주문 전이 T18(DrizzleOrderStore.transition, 출발 APPROVED 조건. Outbox CONFIRMED가 업무 문장의 마지막, ADR-0116 결정 3).
//   잠금 차례는 큐 행 → 주문 행 → 주문 항목이다(Saga·결제 결과 반영과 같이 작업 행이 주문 행보다 먼저다).
// - 다시 보내기(retry)·멈추기(stop)·임대 놓기(release): 자기 임대 조건의 UPDATE 한 문장. 주문 이력(T19)은 쓰지 않는다.
// - ISSUE_DELAYED 내기(markDelayed): 한 트랜잭션에서 created_at ≤ 지금 − 60초 [가정]이고 delayed_at이 빈 행을 SKIP LOCKED로 골라(잠금 차례 큐 행 → 주문 행),
//   고른 주문의 주문 행·항목을 한 번씩(= any) 읽고, delayed_at = 지금을 한 문장으로 쓴 뒤, buildIssueDelayedEvent로 만든 사건들을 Outbox에 마지막으로 한 번에 쓴다
//   (writeOutbox, Kafka 키 = 회차 ID. Outbox가 업무 문장의 마지막, ADR-0116 결정 3, 리뷰 고침 L7). 상태·이력은 바꾸지 않는다.
// - 기한 넘김 표시(markOverdue): issue_due_at ≤ 지금이고 overdue_at이 빈 행을 SKIP LOCKED로 골라 overdue_at = 지금(한 문장). next_attempt_at은 그대로다.
// - 게이지(gauges): 잠그지 않는 한 질의(next_attempt_at 있음·없음 수, 다시 보낼 행(next_attempt_at 있음)의 min(created_at), 리뷰 고침 M3).
// 운영은 핫패스 풀이 아니라 실행기 전용 일반 풀(ticketIssueDatabaseOptions, 연결 4개 [가정])을 넘긴다(리뷰 고침 H1).
// 주문 상태는 주문 전이 함수로만 바꾼다(상태 SQL은 drizzle-orders.ts에만, test/order-status-sql.test.ts). 임대·기한의 '지금'은 앱 시계(DrizzleTicketIssueOptions.clock)다.
// 트랜잭션마다 READ COMMITTED·문장 시간 한도 5초 [가정](SAGA_STATEMENT_TIMEOUT_MS, 요청 밖이다).
// 구현에서 정한 것(정본에 없다):
// - 잡기의 '임대가 지났다'는 lease_until < 지금이다(data.md §5.1 행. 임대 끝과 지금이 같으면 아직 임대 중이다. Saga 잡기의 ≤와 다르다).
// - claimDue는 next_attempt_at 오름차순(같으면 주문 ID 순)으로 고르고 그 차례로 돌려준다. 결제자·좌석은 같은 트랜잭션의 RETURNING 안 하위 질의로 붙인다.
// - complete의 큐 행 잠금은 SKIP LOCKED가 아닌 FOR UPDATE다: 같은 주문의 다른 성공 반영이 쥐고 있으면 기다렸다가, 그쪽이 커밋해 행이 없어지면 0행이라 LEASE_LOST다.
//   티켓 묶음의 모양(좌석·티켓 ID가 소문자 UUID, 겹침 없음, 1~10개)과 행위자는 DB에 가기 전에 보고, 주문 좌석과 맞는지는 주문 행을 잠근 뒤 항목을 읽어 본다
//   (맞지 않으면 RangeError로 되돌린다. 아무것도 바뀌지 않는다). 주문이 APPROVED가 아니면 좌석을 대조하지 않고 큐 행만 지운다(늦게 온 답이라 쓰지 않는다).
// - markDelayed가 고른 행의 주문이 APPROVED가 아니면(보상이 큐 행을 지우지 않은 어긋난 행) 사건을 내지 않고 delayed_at만 적어 다시 고르지 않는다(낸 주문 ID에 넣지 않는다).
// - markDelayed는 created_at 차례(같으면 주문 ID), markOverdue는 issue_due_at 차례(같으면 주문 ID)로 고르고 그 차례로 돌려준다.
// - gauges.oldestAgeSeconds는 초 단위 내림(지금 − 다시 보낼 행의 min(created_at))이고 0보다 작으면(앱 시계가 뒤) 0이다. 멈춘 행은 나이에 들지 않는다
//   (멈춘 행은 사람이 볼 때까지 남아 '밀린 큐'의 나이를 늘 기한 넘김 근처로 묶어 두기 때문이다. 멈춘 행은 stopped 수가 알린다, 리뷰 고침 M3).
// - 행을 바꾸는 메서드는 소문자 UUID가 아닌 주문 ID면 DB에 가지 않고 false·undefined다(Saga와 같다).
import { type Clock, type Database, type DatabaseOptions, type DbTransaction, type OutboxMessage, writeOutbox } from '@peaket/platform';
import { type SQL, sql } from 'drizzle-orm';
import { ACTOR_PATTERN, type OrderItem, type OrderRow, type OrderStatus, type SeatAssignment } from '../../domain/order.js';
import type {
  OrderEventCodec,
  TicketIssueCompleteInput,
  TicketIssueCompleteOutcome,
  TicketIssueGauges,
  TicketIssueJob,
  TicketIssueJobs,
  TicketIssueJobView,
  TicketIssueRetryInput,
  TicketIssueStopInput,
} from '../../domain/ports.js';
import { SAGA_STATEMENT_TIMEOUT_MS } from '../../domain/saga.js';
import {
  buildIssueDelayedEvent,
  issuedTicketsMatch,
  TICKET_ISSUE_DELAYED_AFTER_MS,
  TICKET_ISSUE_RETRY_CODES,
  TICKET_ISSUE_STOP_CODES,
  type TicketIssueFailureCode,
} from '../../domain/ticket-issue.js';
import { jsonOrderEventCodec, TRADE_ORDERS_TOPIC } from '../order-events.js';
import type { DrizzleOrderStore } from './drizzle-orders.js';

/** 발권 실행기 전용 DB 풀의 연결 수 4개 [가정](docs/features/payment.md §2 '발권 호출과 재시도 큐의 첫 구현' 실행기) */
/** 발권 실행기 전용 풀의 연결 수 24개 [가정](BAT-029: 승인 100/s의 발권 완료 트랜잭션을 따라가도록 4에서 올렸다) */
const TICKET_ISSUE_DB_MAX = 24;

/**
 * 발권 실행기의 purchase DB(PEAKET_DATABASE_URL) 풀 설정(main.ts가 createDatabase에 넘기고 종료 때 닫는다, 리뷰 고침 H1).
 * 핫패스 풀과 따로인 일반 풀(연결을 기다린다)·연결 TICKET_ISSUE_DB_MAX개·이름 purchase-svc-ticket-issue다: ticket-svc가 멈춰 실패가 한꺼번에 몰려도
 * 홀드·주문 요청이 풀 대기 초과(429)를 받지 않게 한다. 소비자 풀(consumers.ts consumerDatabaseOptions)과 같은 꼴이다
 */
export function ticketIssueDatabaseOptions(url: string): DatabaseOptions {
  return { url, profile: 'general', max: TICKET_ISSUE_DB_MAX, applicationName: 'purchase-svc-ticket-issue' };
}

export interface DrizzleTicketIssueOptions {
  /** 운영은 실행기 전용 일반 풀(ticketIssueDatabaseOptions) */
  database: Database;
  /** 주문 전이 함수(T18, 출발 상태 APPROVED 조건. Outbox CONFIRMED를 함께 쓴다) */
  store: DrizzleOrderStore;
  /** ISSUE_DELAYED 사건의 값 바이트(기본 JSON 대역 jsonOrderEventCodec. 주문 전이 함수와 같은 것을 준다) */
  codec?: OrderEventCodec;
  /** 임대·기한·delayed_at·overdue_at·게이지 나이의 '지금' */
  clock: Clock;
}

/** 표의 uuid 글(소문자) */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 주문 하나의 좌석 수 상한 [가정: 주문 하나 10석 이하] */
const MAX_SEATS = 10;
/** 모든 트랜잭션의 격리 수준(서버·역할 기본값에 기대지 않는다)과 문장 시간 한도 5초 [가정](요청 밖이라 요청의 남은 시간이 없다) */
const TX = { isolationLevel: 'read committed', statementTimeoutMs: SAGA_STATEMENT_TIMEOUT_MS } as const;
/** last_error에 적어도 되는 코드(gRPC 이름·CIRCUIT_OPEN·BAD_ANSWER) */
const FAILURE_CODES: ReadonlySet<string> = new Set<TicketIssueFailureCode>([...TICKET_ISSUE_RETRY_CODES, ...TICKET_ISSUE_STOP_CODES]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;

/** 자기 임대 값: 없거나 0 이상의 안전한 정수(epoch ms) */
function assertLease(v: unknown): void {
  if (v !== undefined && !(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)) throw new RangeError(`임대 값(leaseUntilMs)은 epoch ms 정수다: ${String(v)}`);
}

function assertCode(v: unknown): void {
  if (typeof v !== 'string' || !FAILURE_CODES.has(v)) throw new RangeError(`발권 실패 코드가 목록에 없다: ${String(v)}`);
}

/** 성공 반영 입력 검사(DB에 가기 전): 주문 ID, 티켓 묶음 모양(1~10개, 좌석·티켓 ID 소문자 UUID, 좌석·티켓 겹침 없음), 행위자, 임대 */
function assertCompleteInput(i: TicketIssueCompleteInput): void {
  if (!isObject(i)) throw new RangeError('성공 반영 입력이 객체가 아니다');
  if (!isUuid(i.orderId)) throw new RangeError('orderId가 소문자 UUID가 아니다');
  const tickets: unknown = i.tickets;
  if (!Array.isArray(tickets) || tickets.length < 1 || tickets.length > MAX_SEATS) throw new RangeError(`tickets는 1~${MAX_SEATS}개여야 한다`);
  const seats = new Set<string>();
  const ids = new Set<string>();
  for (const t of tickets as unknown[]) {
    if (!isObject(t) || !isUuid(t.seatId) || !isUuid(t.ticketId)) throw new RangeError('tickets의 seatId·ticketId가 소문자 UUID가 아니다');
    if (seats.has(t.seatId)) throw new RangeError('tickets에 같은 좌석이 두 번 있다');
    if (ids.has(t.ticketId)) throw new RangeError('tickets에 같은 티켓 ID가 두 번 있다');
    seats.add(t.seatId);
    ids.add(t.ticketId);
  }
  if (typeof i.actor !== 'string' || !ACTOR_PATTERN.test(i.actor)) throw new RangeError('행위자(actor)가 account:<UUID>·admin:<UUID>·system:<작업 이름> 모양이 아니다');
  assertLease(i.leaseUntilMs);
}

/** 잡기 조건: 그 주문의 티켓 무효 행이 없다. 앞 세대가 무효가 되기 전에 재발권이 나가지 않게 한다(멈춘 무효 행도 막는다, BUILD_ORDER HOT-152 코드 리뷰) */
const NO_VOID_PENDING = sql.raw('not exists (select 1 from ticket_void_job v where v.order_id = ticket_issue_job.order_id)');

/** 자기 임대 조건 SQL 조각(값이 없으면 빈 조각) */
const leaseCond = (lease: number | undefined) => (lease === undefined ? sql`` : sql` and lease_until = ${new Date(lease)}::timestamptz`);

type JobRow = {
  order_id: string;
  event_id: string;
  issue_generation: number | string;
  attempts: number | string;
  next_attempt_at: Date | string | null;
  issue_due_at: Date | string;
  created_at: Date | string;
  lease_until: Date | string | null;
  last_error: string | null;
  account_id: string | null;
  seat_ids: string[] | null;
};

/** RETURNING·SELECT의 큐 행 칸 + 결제자(주문 행) + 좌석(주문 항목, 줄 번호 차례). 별칭 j는 ticket_issue_job이다 */
const JOB_COLUMNS_J = sql.raw(`j.order_id, j.event_id, j.issue_generation, j.attempts, j.next_attempt_at, j.issue_due_at, j.created_at, j.lease_until, j.last_error,
  (select o.account_id from purchase_order o where o.id = j.order_id) as account_id,
  (select array_agg(i.seat_id::text order by i.line_no) from order_item i where i.order_id = j.order_id) as seat_ids`);

const msOf = (v: Date | string): number => new Date(v).getTime();

/** 읽은 큐 행 → 보기(두 칸은 비었으면 null) */
function viewOf(r: JobRow): TicketIssueJobView {
  return {
    orderId: r.order_id,
    eventId: r.event_id,
    payerAccountId: r.account_id ?? '',
    seatIds: r.seat_ids ?? [],
    issueGeneration: Number(r.issue_generation),
    attempts: Number(r.attempts),
    nextAttemptAtMs: r.next_attempt_at === null ? null : msOf(r.next_attempt_at),
    issueDueAtMs: msOf(r.issue_due_at),
    createdAtMs: msOf(r.created_at),
    leaseUntilMs: r.lease_until === null ? null : msOf(r.lease_until),
    ...(r.last_error !== null ? { lastError: r.last_error } : {}),
  };
}

/** 잡은 큐 행 → TicketIssueJob(잡기 조건이 next_attempt_at 있음·lease_until 씀을 보장한다) */
function jobOf(r: JobRow): TicketIssueJob {
  const v = viewOf(r);
  if (v.nextAttemptAtMs === null || v.leaseUntilMs === null) throw new Error('잡은 발권 큐 행에 다음 시도 시각이나 임대가 없다(코드 오류)');
  return { ...v, nextAttemptAtMs: v.nextAttemptAtMs, leaseUntilMs: v.leaseUntilMs };
}

/** 고른 차례(next_attempt_at, 같으면 주문 ID) */
const byDue = (a: TicketIssueJob, b: TicketIssueJob): number => a.nextAttemptAtMs - b.nextAttemptAtMs || (a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0);

/** 시각·주문 ID 차례(markDelayed·markOverdue가 고른 차례로 돌려줄 때) */
const byAtThenId = (a: { at: number; id: string }, b: { at: number; id: string }): number => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** 트랜잭션 안에서 되돌릴 때 던지는 표지(밖에서 결과로 바꾼다. 밖으로 새지 않는다) */
class TicketIssueRollback extends Error {
  constructor(readonly outcome: TicketIssueCompleteOutcome) {
    super('발권 성공 반영 트랜잭션을 되돌린다');
    this.name = 'TicketIssueRollback';
  }
}

/** 발권 큐의 purchase DB 구현(위 머리 주석의 차례) */
export class DrizzleTicketIssue implements TicketIssueJobs {
  readonly #codec: OrderEventCodec;

  constructor(private readonly o: DrizzleTicketIssueOptions) {
    this.#codec = o.codec ?? jsonOrderEventCodec;
  }

  async claimDue(limit: number, leaseMs: number): Promise<TicketIssueJob[]> {
    if (!isPositiveInt(limit)) throw new RangeError(`limit은 1 이상의 정수다: ${String(limit)}`);
    if (!isPositiveInt(leaseMs)) throw new RangeError(`leaseMs는 1 이상의 정수다: ${String(leaseMs)}`);
    const now = this.o.clock.now();
    const at = new Date(now);
    const until = new Date(now + leaseMs);
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        with picked as (
          select order_id from ticket_issue_job
          where next_attempt_at <= ${at}::timestamptz and (lease_until is null or lease_until < ${at}::timestamptz) and ${NO_VOID_PENDING}
          order by next_attempt_at, order_id
          limit ${limit}::int
          for update skip locked)
        update ticket_issue_job j set lease_until = ${until}::timestamptz
        from picked p
        where j.order_id = p.order_id
        returning ${JOB_COLUMNS_J}`),
    );
    // RETURNING의 차례는 정해지지 않아 고른 차례로 다시 맞춘다
    return (r.rows as JobRow[]).map(jobOf).sort(byDue);
  }

  async claim(orderId: string, leaseMs: number): Promise<TicketIssueJob | undefined> {
    if (!isUuid(orderId)) return undefined;
    if (!isPositiveInt(leaseMs)) throw new RangeError(`leaseMs는 1 이상의 정수다: ${String(leaseMs)}`);
    const now = this.o.clock.now();
    const at = new Date(now);
    const until = new Date(now + leaseMs);
    // claimDue와 같은 조건. 행 잠금을 쥔 다른 실행(성공 반영 트랜잭션 등)이 있으면 기다리지 않고 잡지 않는다
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        with picked as (
          select order_id from ticket_issue_job
          where order_id = ${orderId}::uuid and next_attempt_at <= ${at}::timestamptz and (lease_until is null or lease_until < ${at}::timestamptz) and ${NO_VOID_PENDING}
          for update skip locked)
        update ticket_issue_job j set lease_until = ${until}::timestamptz
        from picked p
        where j.order_id = p.order_id
        returning ${JOB_COLUMNS_J}`),
    );
    const row = r.rows[0] as JobRow | undefined;
    return row ? jobOf(row) : undefined;
  }

  async get(orderId: string): Promise<TicketIssueJobView | undefined> {
    if (!isUuid(orderId)) return undefined;
    const r = await this.o.database.db.execute(sql`select ${JOB_COLUMNS_J} from ticket_issue_job j where j.order_id = ${orderId}::uuid`);
    const row = r.rows[0] as JobRow | undefined;
    return row ? viewOf(row) : undefined;
  }

  async complete(input: TicketIssueCompleteInput): Promise<TicketIssueCompleteOutcome> {
    assertCompleteInput(input);
    const orderId = input.orderId;
    try {
      return await this.#tx(async (tx) => {
        // ① 큐 행 잠금(자기 임대). 같은 주문의 다른 성공 반영이 쥐고 있으면 기다린다. 0행이면 다른 실행이 이어 받았거나 끝냈거나 보상이 지웠다
        const job = await tx.execute(sql`select order_id from ticket_issue_job where order_id = ${orderId}::uuid${leaseCond(input.leaseUntilMs)} for update`);
        if (job.rows.length === 0) return { status: 'LEASE_LOST' } as const;
        // ② 주문 행 잠금·상태 확인(잠금 차례 큐 행 → 주문 행). APPROVED가 아니면 늦게 온 답이라 상태·티켓 ID는 그대로 두고 큐 행만 지운다(명세 issueAck의 조건부)
        const o = await tx.execute(sql`select status from purchase_order where id = ${orderId}::uuid for no key update`);
        const current = (o.rows[0] as { status: string } | undefined)?.status as OrderStatus | undefined;
        if (current !== 'APPROVED') {
          await tx.execute(sql`delete from ticket_issue_job where order_id = ${orderId}::uuid`);
          return current !== undefined ? ({ status: 'STALE', current } as const) : ({ status: 'STALE' } as const);
        }
        // ③ 답의 티켓이 주문 좌석과 맞나(주문 항목, 줄 번호 차례). 맞지 않으면 되돌린다(이중 발권·빈 티켓을 주문에 적지 않는다)
        const items = await tx.execute(sql`select seat_id::text as seat_id from order_item where order_id = ${orderId}::uuid order by line_no`);
        const seatIds = (items.rows as { seat_id: string }[]).map((x) => x.seat_id);
        if (!issuedTicketsMatch(seatIds, input.tickets)) throw new RangeError('티켓 묶음이 주문 좌석과 맞지 않는다(빠짐·남는 좌석)');
        // ④ 좌석별 티켓 ID(한 문장). 바꾼 행 수가 좌석 수가 아니면 되돌린다
        const values = sql.join(
          input.tickets.map((t) => sql`(${t.seatId}::uuid, ${t.ticketId}::uuid)`),
          sql`, `,
        );
        const updated = await tx.execute(sql`
          update order_item i set ticket_id = v.ticket_id
          from (values ${values}) as v(seat_id, ticket_id)
          where i.order_id = ${orderId}::uuid and i.seat_id = v.seat_id
          returning i.seat_id`);
        if (updated.rows.length !== seatIds.length) throw new Error('주문 항목의 티켓 ID를 좌석 수만큼 쓰지 못했다(코드 오류)');
        // ⑤ 큐 행 지우기(발권됐다. ADR-0106: 승인된 주문은 '발권됨' 아니면 '큐에 있음')
        await tx.execute(sql`delete from ticket_issue_job where order_id = ${orderId}::uuid`);
        // ⑥ T18(APPROVED → CONFIRMED, 출발 상태 조건. Outbox CONFIRMED가 업무 문장의 마지막). 주문 행을 쥐고 APPROVED를 봤으므로 0행이면 코드 오류다
        const t = await this.o.store.transition(tx, { orderId, transition: 'T18', actor: input.actor });
        if (t.status !== 'APPLIED') throw new TicketIssueRollback(t.current !== undefined ? { status: 'STALE', current: t.current } : { status: 'STALE' });
        return { status: 'CONFIRMED' } as const;
      });
    } catch (e) {
      if (!(e instanceof TicketIssueRollback)) throw e;
      // 되돌렸다(큐 행도 그대로다). 다음 시도가 같은 주문 ID로 다시 부르고 그때 상태로 STALE이 된다
      return e.outcome;
    }
  }

  async retry(input: TicketIssueRetryInput): Promise<boolean> {
    if (!isObject(input)) throw new RangeError('다시 보내기 입력이 객체가 아니다');
    if (!isUuid(input.orderId)) return false;
    const next = new Date(input.nextAtMs);
    if (typeof input.nextAtMs !== 'number' || Number.isNaN(next.getTime())) throw new RangeError(`nextAtMs가 날짜(유닉스 밀리초)가 아니다: ${String(input.nextAtMs)}`);
    assertCode(input.code);
    assertLease(input.leaseUntilMs);
    // 주문 이력(T19)은 쓰지 않는다(자동 재시도마다 이력이 늘지 않게, 정함)
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        update ticket_issue_job set attempts = attempts + 1, last_error = ${input.code}, next_attempt_at = ${next}::timestamptz, lease_until = null
        where order_id = ${input.orderId}::uuid${leaseCond(input.leaseUntilMs)}
        returning order_id`),
    );
    return r.rows.length > 0;
  }

  async stop(input: TicketIssueStopInput): Promise<boolean> {
    if (!isObject(input)) throw new RangeError('멈추기 입력이 객체가 아니다');
    if (!isUuid(input.orderId)) return false;
    assertCode(input.code);
    assertLease(input.leaseUntilMs);
    // next_attempt_at을 비워 자동 재시도를 멈춘다(잡기 조건 밖이다). CS가 다시 시도 시각을 당기는 계약은 GAT-280
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        update ticket_issue_job set attempts = attempts + 1, last_error = ${input.code}, next_attempt_at = null, lease_until = null
        where order_id = ${input.orderId}::uuid${leaseCond(input.leaseUntilMs)}
        returning order_id`),
    );
    return r.rows.length > 0;
  }

  async release(orderId: string, leaseUntilMs: number): Promise<boolean> {
    if (!isUuid(orderId)) return false;
    if (typeof leaseUntilMs !== 'number') throw new RangeError(`임대 값(leaseUntilMs)은 epoch ms 정수다: ${String(leaseUntilMs)}`);
    assertLease(leaseUntilMs);
    const r = await this.#tx((tx) =>
      tx.execute(sql`update ticket_issue_job set lease_until = null where order_id = ${orderId}::uuid${leaseCond(leaseUntilMs)} returning order_id`),
    );
    return r.rows.length > 0;
  }

  async markDelayed(limit: number): Promise<string[]> {
    if (!isPositiveInt(limit)) throw new RangeError(`limit은 1 이상의 정수다: ${String(limit)}`);
    const now = this.o.clock.now();
    const at = new Date(now);
    const before = new Date(now - TICKET_ISSUE_DELAYED_AFTER_MS);
    return this.#tx(async (tx) => {
      // ① 고르기(SKIP LOCKED: 다른 파드가 같은 때 고른 행은 건너뛴다). 멈춘 행·임대 중인 행도 대상이다(행 잠금만 본다). 잠금 차례는 큐 행 → 주문 행이다
      const picked = await tx.execute(sql`
        select order_id::text as order_id, issue_generation::text as issue_generation from ticket_issue_job
        where created_at <= ${before}::timestamptz and delayed_at is null
        order by created_at, order_id
        limit ${limit}::int
        for update skip locked`);
      const pickedRows = picked.rows as { order_id: string; issue_generation: string }[];
      const ids = pickedRows.map((x) => x.order_id);
      if (ids.length === 0) return [];
      const generations = new Map(pickedRows.map((x) => [x.order_id, Number(x.issue_generation)]));
      // uuid[] 조각(drizzle-orders.ts uuidArray와 같은 꼴)
      const idList = sql`array[${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]`;
      // ② 고른 주문의 주문 행·항목을 한 번씩 읽는다(행마다 읽지 않는다, 리뷰 고침 L7)
      const orders = await ordersOf(tx, idList);
      const items = await itemsByOrder(tx, idList);
      // ③ 사건을 만든다. APPROVED가 아닌 어긋난 행에는 내지 않는다(머리 주석 '구현에서 정한 것'). delayed_at만 적어 다시 고르지 않는다
      const sent: string[] = [];
      const messages: OutboxMessage[] = [];
      for (const orderId of ids) {
        const order = orders.get(orderId);
        if (order?.status !== 'APPROVED') continue;
        const message = buildIssueDelayedEvent({ order, items: items.get(orderId) ?? [], occurredAtMs: now, issueGeneration: generations.get(orderId) ?? 0 });
        messages.push({ topic: TRADE_ORDERS_TOPIC, key: order.eventId, payload: this.#codec.encode(message) });
        sent.push(orderId);
      }
      // ④ delayed_at = 지금(한 문장)
      await tx.execute(sql`update ticket_issue_job set delayed_at = ${at}::timestamptz where order_id = any(${idList})`);
      // ⑤ Outbox는 업무 문장의 마지막에 한 번(ADR-0116 결정 3)
      await writeOutbox(tx, this.o.clock, messages);
      return sent;
    });
  }

  async markOverdue(limit: number): Promise<string[]> {
    if (!isPositiveInt(limit)) throw new RangeError(`limit은 1 이상의 정수다: ${String(limit)}`);
    const at = new Date(this.o.clock.now());
    // 한 문장(SKIP LOCKED로 골라 overdue_at만 쓴다. next_attempt_at·attempts는 그대로라 재시도는 이어 간다, ADR-0106 결정 2)
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        with picked as (
          select order_id from ticket_issue_job
          where issue_due_at <= ${at}::timestamptz and overdue_at is null
          order by issue_due_at, order_id
          limit ${limit}::int
          for update skip locked)
        update ticket_issue_job j set overdue_at = ${at}::timestamptz
        from picked p
        where j.order_id = p.order_id
        returning j.order_id::text as order_id, j.issue_due_at`),
    );
    return (r.rows as { order_id: string; issue_due_at: Date | string }[])
      .map((x) => ({ id: x.order_id, at: msOf(x.issue_due_at) }))
      .sort(byAtThenId)
      .map((x) => x.id);
  }

  async gauges(): Promise<TicketIssueGauges> {
    // 가장 오래된 행의 나이는 다시 보낼 행만 본다(멈춘 행은 stopped 수가 알린다, 리뷰 고침 M3)
    const r = await this.o.database.db.execute(sql`
      select count(*) filter (where next_attempt_at is not null)::int as pending,
             count(*) filter (where next_attempt_at is null)::int as stopped,
             min(created_at) filter (where next_attempt_at is not null) as oldest
      from ticket_issue_job`);
    const row = r.rows[0] as { pending: number | string; stopped: number | string; oldest: Date | string | null } | undefined;
    const oldest = row?.oldest ?? null;
    const age = oldest === null ? 0 : Math.max(0, Math.floor((this.o.clock.now() - msOf(oldest)) / 1000));
    return { pending: Number(row?.pending ?? 0), stopped: Number(row?.stopped ?? 0), oldestAgeSeconds: age };
  }

  /** 트랜잭션 하나(READ COMMITTED, 문장 시간 한도 5초 [가정]) */
  #tx<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return this.o.database.transaction(fn, TX);
  }
}

type OrderDbRow = {
  id: string;
  account_id: string;
  event_id: string;
  status: string;
  amount: number | string;
  event_seq: number | string;
  payment_event_seq: number | string;
  seat_assignment: string;
};

/** 같은 트랜잭션에서 한 질의로 읽은 주문 행들(사건 칸, 주문 ID → 행). 없는 주문은 빠진다. ids는 uuid[] SQL 조각이다 */
async function ordersOf(tx: DbTransaction, ids: SQL): Promise<Map<string, OrderRow>> {
  const r = await tx.execute(sql`
    select id::text as id, account_id, event_id, status, amount, event_seq, payment_event_seq::text as payment_event_seq, seat_assignment
    from purchase_order where id = any(${ids})`);
  const out = new Map<string, OrderRow>();
  for (const row of r.rows as OrderDbRow[]) {
    out.set(row.id, {
      id: row.id,
      accountId: row.account_id,
      eventId: row.event_id,
      status: row.status as OrderStatus,
      amount: Number(row.amount),
      eventSeq: Number(row.event_seq),
      paymentEventSeq: Number(row.payment_event_seq),
      seatAssignment: row.seat_assignment as SeatAssignment,
    });
  }
  return out;
}

/** 같은 트랜잭션에서 한 질의로 읽은 주문 항목들(주문 ID → 줄 번호 차례의 항목). ids는 uuid[] SQL 조각이다 */
async function itemsByOrder(tx: DbTransaction, ids: SQL): Promise<Map<string, OrderItem[]>> {
  const r = await tx.execute(sql`
    select order_id::text as order_id, seat_id, tier, section_id, unit_price from order_item
    where order_id = any(${ids}) order by order_id, line_no`);
  const out = new Map<string, OrderItem[]>();
  for (const x of r.rows as { order_id: string; seat_id: string; tier: string; section_id: string; unit_price: number | string }[]) {
    const list = out.get(x.order_id) ?? [];
    list.push({ seatId: x.seat_id, tierId: x.tier, sectionId: x.section_id, unitPrice: Number(x.unit_price) });
    out.set(x.order_id, list);
  }
  return out;
}
