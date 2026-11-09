// 결제 결과 반영의 purchase DB 쪽(PaymentResultReads·PaymentResultWrites, docs/features/payment.md §2 '결제 결과 반영의 첫 구현',
// docs/data.md §5 '결제 결과 반영', BUILD_ORDER PRF-163).
// - 승인(approve, READ COMMITTED): 작업 행 정리(있으면 단계와 상관없이 지우기. 결과를 기다리던 AWAIT 행도 같다, PRF-171) → 주문 행 잠금·상태·순번 확인
//   → 결제 참조 지우기 → 판매 행 PENDING → SOLD(inventory markSoldIn, 바꾼 수 = 좌석 수여야 한다) → ticket_issue_job 한 행 → T9·T13·T16.
// - 실패(fail, READ COMMITTED): 작업 행 RELEASE(단계와 상관없이, 없으면 넣기) → 주문 failure_reason → 판매 행 PENDING 지우기(inventory releasePendingIn) → 결제 참조 지우기 → T11·T15·T17.
// - 상태만(mark, 중간 결과): 작업 행을 지우지 않고 AWAIT로 남기기(있으면. pull_next_at = 지금 + 30초 [가정](T12)·60초 [가정](T10·T14), PRF-171 '중간 결과 뒤에도 당긴다')
//   → 주문 행 잠금·상태·순번 확인 → 결제 참조 지우기(리뷰 M1) → T10·T12·T14. 판매 행 PENDING은 그대로 둔다.
//   최종 결과(승인·실패)만 작업 행을 지우거나 RELEASE로 바꾼다. 그래서 사건 길이 멈춘 동안에도 결과 당기기가 뒤따르는 최종 결과를 받는다.
// 잠금 차례는 Saga(drizzle-saga.ts)와 같이 작업 행 → 주문 행이 먼저다. 그 뒤 실패는 한도 행 → 좌석 행 → 결제 시도 행, 승인은 결제 시도 행 → 좌석 행이다
// (쓰기 차례 시험이 정한 차례. 주문 행을 먼저 쥐므로 엇갈려도 교착하지 않는다). 겹친 Saga CONFIRM 실행은 작업 행이 바뀌어 0행이 되고 물러난다.
// 주문 상태는 주문 전이 함수(DrizzleOrderStore.transition, 결제 사건 순번 조건)로만 바꾼다(상태 SQL은 drizzle-orders.ts에만, test/order-status-sql.test.ts).
// 전이가 0행(STALE)이면 표지 오류를 던져 트랜잭션째 되돌린 뒤 밖에서 결과로 바꾼다(drizzle-saga.ts SagaRollback과 같은 꼴). 결제 참조·토큰은 로그·오류 글에 싣지 않는다.
// inventory를 가져오지 않는다: 판매 행 SOLD·PENDING 지우기는 필요한 메서드 모양(PaymentResultSeatSales)만 받는다(조립은 PRF-164가 DrizzleSeatSales를 넘긴다).
// 구현에서 정한 것(정본에 없다):
// - 없는 주문: ticket_issue_job·order_saga_job을 넣기 전에 주문 행이 있는지 보고 없으면 STALE NOT_FOUND로 되돌린다(주문 외래 키 위반으로 던지지 않는다).
//   승인·상태만은 작업 행 문장 바로 뒤에 주문 행을 상태·순번과 함께 잠가(FOR NO KEY UPDATE) 본다: 출발 상태가 아니거나 순번을 이미 반영했으면
//   주문 전이 함수와 같은 규칙(NOT_FOUND·STATUS·PAYMENT_SEQ)으로 바로 STALE이라 진 쪽이 판매 행·발권 큐 문장까지 가지 않는다(권고1).
//   승인은 결제 시도·좌석 행을 주문 전이보다 먼저 쓰므로(쓰기 차례) 주문 행을 먼저 쥐어야 실패 쓰기와 엇갈려 교착하지 않는다.
//   실패는 작업 행 문장이 0행일 때만 잠금 없이 본다(바로 뒤 실패 사유 문장이 주문 행을 잠근다).
// - 승인의 SOLD 수가 좌석 수와 다르면(판매 행이 없어졌다) 되돌리고 SOLD_MISMATCH다(쓰임새가 SEV1로 보류한다, 리뷰 M4).
// - ticket_issue_job 넣기는 ON CONFLICT DO NOTHING이다(주문 행 확인을 지난 뒤라 겹친 승인은 여기 오지 않는다. 있어서는 안 될 남은 행이 있어도 승인을 막지 않는다).
// - 승인·실패·상태만의 결제 참조 지우기는 남은 칸이 있을 때만 행을 쓴다(Saga done이 먼저 지웠으면 그대로).
// - 실패의 작업 행은 단계·임대와 상관없이 RELEASE(attempts 0, 다음 시각 지금, 임대 비움)로 바꾼다. 승인 명령 보낸 시각은 그대로 둔다.
// - 실패 사유 쓰기는 출발 상태이고 순번이 더 클 때만 한다. 0행이면 주문 전이 함수와 같은 규칙(NOT_FOUND·STATUS·PAYMENT_SEQ)으로 까닭을 가른다.
// - 상태만의 작업 행은 단계·임대와 상관없이 AWAIT로 바꾸고 pull_next_at과 next_attempt_at = 'infinity'를 쓴다(며칠 남을 수 있는 AWAIT 행이 Saga 쓸기 색인의
//   차례 앞을 막지 않게, 2026-11-06 코드 리뷰 M1. Saga 칸 attempts·lease_until·confirm_sent_at은 그대로다. Saga 잡기가 AWAIT 행을 고르지 않고,
//   겹친 Saga CONFIRM 실행의 정리(done)는 CONFIRM 조건이라, 다시 하기(reschedule)는 AWAIT 행을 빼므로 0행이 된다). 작업 행이 없으면 넣지 않는다
//   (접수 뒤에는 늘 작업 행이 있다. 없는 것은 손질·옛 행의 길이라 당기기 대상이 되지 않을 뿐이다).
import type { Clock, Database, DbTransaction } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { ACTOR_PATTERN, transitionById, type OrderStatus } from '../../domain/order.js';
import { PAYMENT_PULL_AFTER_DEPOSIT_MS, PAYMENT_PULL_AFTER_UNKNOWN_MS } from '../../domain/payment-pull.js';
import { PAYMENT_FAILURE_CATEGORIES } from '../../domain/payment-result.js';
import type {
  PaymentApproveInput,
  PaymentFailInput,
  PaymentMarkInput,
  PaymentResultOrder,
  PaymentReverseInput,
  PaymentResultReads,
  PaymentResultWriteOutcome,
  PaymentResultWrites,
  PaymentPg,
  SagaSaleRelease,
} from '../../domain/ports.js';
import { SAGA_STATEMENT_TIMEOUT_MS } from '../../domain/saga.js';
import type { DrizzleOrderStore } from './drizzle-orders.js';

/** inventory DrizzleSeatSales의 바깥 트랜잭션 면(markSoldIn·releasePendingIn)의 모양 */
export interface PaymentResultSeatSales {
  /** 그 주문의 PENDING 행을 좌석 ID 순으로 잠가 SOLD로 바꾼다(pending_until 비움). 바꾼 행 수(두 번째 호출은 0) */
  markSoldIn(tx: DbTransaction, order: { eventId: string; orderId: string; seatIds: readonly string[] }): Promise<number>;
  /** 그 주문·계정의 PENDING 행을 지우고 한도를 되돌린다. 지운 행 수 */
  releasePendingIn(tx: DbTransaction, release: SagaSaleRelease): Promise<number>;
  /** 그 주문의 SOLD 행을 PENDING으로 되돌린다(입금 오류, BUILD_ORDER HOT-152). 바꾼 행 수 */
  markPendingAgainIn(tx: DbTransaction, order: { eventId: string; orderId: string; seatIds: readonly string[]; pendingUntilMs?: number }): Promise<number>;
  /** 그 주문의 PENDING 행을 좌석 ID 순으로 잠가 pending_until을 쓴다(입금 대기, BUILD_ORDER HOT-151). 바꾼 행 수 */
  setPendingUntilIn(tx: DbTransaction, order: { eventId: string; orderId: string; seatIds: readonly string[]; pendingUntilMs: number }): Promise<number>;
}

export interface DrizzlePaymentResultsOptions {
  database: Database;
  /** 주문 전이 함수(T9~T17, 결제 사건 순번 조건) */
  store: DrizzleOrderStore;
  /** 판매 행 SOLD·PENDING 지우기(inventory DrizzleSeatSales) */
  sales: PaymentResultSeatSales;
  /** ticket_issue_job·작업 행의 '지금'(next_attempt_at·created_at) */
  clock: Clock;
}

/** 표의 uuid 글(소문자) */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 주문 하나의 좌석 수 상한 [가정: 주문 하나 10석 이하] */
const MAX_SEATS = 10;
/** 모든 트랜잭션의 격리 수준(서버·역할 기본값에 기대지 않는다)과 문장 시간 한도 5초 [가정](Saga와 같은 값, 요청 밖이다) */
const TX = { isolationLevel: 'read committed', statementTimeoutMs: SAGA_STATEMENT_TIMEOUT_MS } as const;

const APPROVE_TRANSITIONS: ReadonlySet<string> = new Set(['T9', 'T13', 'T16']);
const FAIL_TRANSITIONS: ReadonlySet<string> = new Set(['T11', 'T15', 'T17']);
const MARK_TRANSITIONS: ReadonlySet<string> = new Set(['T10', 'T12', 'T14']);
const REVERSE_TRANSITIONS: ReadonlySet<string> = new Set(['T21']);
const FAILURE_CATEGORIES: ReadonlySet<string> = new Set(PAYMENT_FAILURE_CATEGORIES);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

// ---- 입력 검사(DB에 가기 전, 틀리면 RangeError) ----

/** 쓰기 공통 칸: 주문 ID·전이(그 갈래의 것)·결제 사건 순번(양의 정수)·행위자 */
function assertBase(i: unknown, allowed: ReadonlySet<string>, what: string): asserts i is Record<string, unknown> {
  if (!isObject(i)) throw new RangeError(`${what} 입력이 객체가 아니다`);
  if (!isUuid(i.orderId)) throw new RangeError('orderId가 소문자 UUID가 아니다');
  if (typeof i.transition !== 'string' || !allowed.has(i.transition)) throw new RangeError(`${what} 갈래의 전이가 아니다: ${String(i.transition)}`);
  const seq = i.paymentEventSeq;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) throw new RangeError(`paymentEventSeq는 양의 정수다: ${String(seq)}`);
  if (typeof i.actor !== 'string' || !ACTOR_PATTERN.test(i.actor)) throw new RangeError('행위자(actor)가 account:<UUID>·admin:<UUID>·system:<작업 이름> 모양이 아니다');
}

/** 좌석 ID 묶음(소문자 UUID, 1~10개, 겹침 없음) */
function assertSeatIds(v: unknown): void {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_SEATS) throw new RangeError(`seatIds는 1~${MAX_SEATS}개여야 한다`);
  if (!v.every(isUuid)) throw new RangeError('seatIds에 소문자 UUID가 아닌 좌석 ID가 있다');
  if (new Set(v).size !== v.length) throw new RangeError('seatIds에 같은 좌석이 두 번 있다');
}

function assertApprove(i: PaymentApproveInput): void {
  assertBase(i, APPROVE_TRANSITIONS, '승인');
  if (!isUuid(i.eventId)) throw new RangeError('eventId가 소문자 UUID가 아니다');
  assertSeatIds(i.seatIds);
  const due = i.issueDueAtMs;
  if (typeof due !== 'number' || !Number.isSafeInteger(due) || Number.isNaN(new Date(due).getTime())) throw new RangeError(`issueDueAtMs가 날짜(유닉스 밀리초)가 아니다: ${String(due)}`);
}

function assertFail(i: PaymentFailInput): void {
  assertBase(i, FAIL_TRANSITIONS, '실패');
  if (typeof i.failureReason !== 'string' || !FAILURE_CATEGORIES.has(i.failureReason)) throw new RangeError(`결제 쪽 실패 사유가 목록에 없다: ${String(i.failureReason)}`);
  if (!isUuid(i.eventId)) throw new RangeError('eventId가 소문자 UUID가 아니다');
  const r: unknown = i.release;
  if (!isObject(r)) throw new RangeError('실패에는 판매 행 지우기(release)가 있어야 한다');
  if (!isUuid(r.eventId) || !isUuid(r.accountId)) throw new RangeError('release의 eventId·accountId가 소문자 UUID가 아니다');
  if (r.orderId !== i.orderId) throw new RangeError('release의 orderId가 실패 쓰기의 주문과 다르다');
  assertSeatIds(r.seatIds);
}

function assertReverse(i: PaymentReverseInput): void {
  assertBase(i, REVERSE_TRANSITIONS, '입금 되돌림');
  if (!isUuid(i.eventId)) throw new RangeError('eventId가 소문자 UUID가 아니다');
  assertSeatIds(i.seatIds);
  const until = i.pendingUntilMs;
  if (until !== undefined && (typeof until !== 'number' || !Number.isSafeInteger(until) || Number.isNaN(new Date(until).getTime()))) throw new RangeError(`pendingUntilMs가 날짜(유닉스 밀리초)가 아니다: ${String(until)}`);
}

function assertMark(i: PaymentMarkInput): void {
  assertBase(i, MARK_TRANSITIONS, '상태만');
  const d: unknown = i.depositPending;
  if (d === undefined) return;
  if (i.transition === 'T12') throw new RangeError('T12에는 판매 행 기한이 없다');
  if (!isObject(d)) throw new RangeError('depositPending이 객체가 아니다');
  if (!isUuid(d.eventId)) throw new RangeError('depositPending.eventId가 소문자 UUID가 아니다');
  assertSeatIds(d.seatIds);
  const until = d.pendingUntilMs;
  if (typeof until !== 'number' || !Number.isSafeInteger(until) || Number.isNaN(new Date(until).getTime())) throw new RangeError(`pendingUntilMs가 날짜(유닉스 밀리초)가 아니다: ${String(until)}`);
}

// ---- 문장 ----

/** 그 주문 ACCEPTED 시도의 결제 키·거래 ID·토큰을 지운다(남은 칸이 있을 때만 행을 쓴다. 5년 보관은 payment-svc 결제 원장이다) */
const clearRefs = (tx: DbTransaction, orderId: string) =>
  tx.execute(sql`
    update payment_attempt set pg_payment_key = null, pg_tx_id = null, pg_payment_token = null
    where order_id = ${orderId}::uuid and status = 'ACCEPTED'
      and (pg_payment_key is not null or pg_tx_id is not null or pg_payment_token is not null)`);

/** 주문 행이 있나(잠그지 않는 읽기. 실패 쓰기의 작업 행 문장이 0행일 때만 본다) */
async function orderExists(tx: DbTransaction, orderId: string): Promise<boolean> {
  const r = await tx.execute(sql`select 1 from purchase_order where id = ${orderId}::uuid`);
  return r.rows.length > 0;
}

/**
 * 주문 행을 잠그고(뒤따르는 전이 UPDATE와 같은 잠금 세기라 외래 키 확인의 KEY SHARE와 부딪치지 않는다) 전이할 수 있는지 본다(권고1).
 * 할 수 있으면 undefined, 아니면 STALE(주문 전이 함수 staleOf와 같은 규칙: 없음 NOT_FOUND, 출발 상태가 아님 STATUS, 출발 상태인데 그 순번 이상을 반영함 PAYMENT_SEQ).
 * 승인 쓰기는 결제 시도·좌석 행을 주문 전이보다 먼저 쓰므로, 주문 행을 먼저 쥐어 실패 쓰기(주문 행 → 좌석 → 결제 시도)와 엇갈려 교착하지 않게 한다
 */
async function lockSource(tx: DbTransaction, orderId: string, from: OrderStatus, paymentEventSeq: number): Promise<Stale | undefined> {
  const r = await tx.execute(sql`select status, payment_event_seq::text as payment_event_seq from purchase_order where id = ${orderId}::uuid for no key update`);
  const row = r.rows[0] as { status: string; payment_event_seq: string } | undefined;
  if (!row) return { status: 'STALE', reason: 'NOT_FOUND' };
  const current = row.status as OrderStatus;
  if (current !== from) return { status: 'STALE', reason: 'STATUS', current };
  if (Number(row.payment_event_seq) >= paymentEventSeq) return { status: 'STALE', reason: 'PAYMENT_SEQ' };
  return undefined;
}

/** 전이의 출발 상태(전이 표) */
function fromOf(transition: string): OrderStatus {
  const from = transitionById(transition)?.from;
  if (!from) throw new Error(`전이 표에 출발 상태가 없다(코드 오류): ${transition}`);
  return from;
}

type Stale = Extract<PaymentResultWriteOutcome, { status: 'STALE' }>;

/** 주문 전이 함수의 STALE 결과 → 쓰기 결과(current는 있을 때만) */
const staleOf = (t: { reason: Stale['reason']; current?: OrderStatus }): Stale =>
  t.current !== undefined ? { status: 'STALE', reason: t.reason, current: t.current } : { status: 'STALE', reason: t.reason };

/** 실패 사유를 쓰지 못했을 때의 까닭(주문 전이 함수 staleOf와 같은 규칙: 출발 상태인데 막혔으면 순번) */
async function failStaleOf(tx: DbTransaction, orderId: string, from: OrderStatus): Promise<Stale> {
  const r = await tx.execute(sql`select status from purchase_order where id = ${orderId}::uuid`);
  const row = r.rows[0] as { status: string } | undefined;
  if (!row) return { status: 'STALE', reason: 'NOT_FOUND' };
  const current = row.status as OrderStatus;
  return current === from ? { status: 'STALE', reason: 'PAYMENT_SEQ' } : { status: 'STALE', reason: 'STATUS', current };
}

/** 결제 결과 반영의 purchase DB 구현(위 머리 주석의 차례). 트랜잭션은 모두 READ COMMITTED·문장 시간 한도 5초 [가정](SAGA_STATEMENT_TIMEOUT_MS)를 직접 고른다 */
export class DrizzlePaymentResults implements PaymentResultReads, PaymentResultWrites {
  constructor(private readonly o: DrizzlePaymentResultsOptions) {}

  /** 주문 행 + 항목 좌석 ID(줄 번호 차례) + ACCEPTED 결제 시도의 결제사. 없거나 소문자 UUID가 아니면 undefined(DB에 가지 않는다) */
  async read(orderId: string): Promise<PaymentResultOrder | undefined> {
    if (!isUuid(orderId)) return undefined;
    const r = await this.o.database.db.execute(sql`
      select o.id, o.status, o.amount, o.payment_event_seq::text as payment_event_seq, o.event_id, o.account_id, o.purchase_session_id,
             (select a.pg from payment_attempt a where a.order_id = o.id and a.status = 'ACCEPTED' limit 1) as accepted_pg,
             array(select i.seat_id::text from order_item i where i.order_id = o.id order by i.line_no) as seat_ids
      from purchase_order o
      where o.id = ${orderId}::uuid`);
    const row = r.rows[0] as
      | {
          id: string;
          status: string;
          amount: number | string;
          payment_event_seq: string;
          event_id: string;
          account_id: string;
          purchase_session_id: string;
          accepted_pg: string | null;
          seat_ids: string[];
        }
      | undefined;
    if (!row) return undefined;
    return {
      orderId: row.id,
      status: row.status as OrderStatus,
      amount: Number(row.amount),
      paymentEventSeq: Number(row.payment_event_seq),
      ...(row.accepted_pg !== null ? { acceptedPg: row.accepted_pg as PaymentPg } : {}),
      eventId: row.event_id,
      accountId: row.account_id,
      purchaseSessionId: row.purchase_session_id,
      seatIds: row.seat_ids,
    };
  }

  async approve(input: PaymentApproveInput): Promise<PaymentResultWriteOutcome> {
    assertApprove(input);
    const from = fromOf(input.transition);
    return this.#tx(async (tx) => {
      const now = new Date(this.o.clock.now());
      // 첫 문장: 작업 행 정리(잠금 차례 작업 행 → 주문 행). 겹친 Saga CONFIRM 실행은 이 행에서 기다렸다가 0행이라 물러난다
      await tx.execute(sql`delete from order_saga_job where order_id = ${input.orderId}::uuid`);
      // 둘째: 주문 행을 잠그고 상태·순번을 본다. 맞지 않으면(없는 주문 포함) 넣기 전에 되돌린다
      const stale = await lockSource(tx, input.orderId, from, input.paymentEventSeq);
      if (stale) throw new PaymentResultRollback(stale);
      // 남은 결제 참조를 지운다(승인 명령이 접수됐다)
      await clearRefs(tx, input.orderId);
      // 판매 행 PENDING → SOLD(같은 트랜잭션, 좌석 ID 순 잠금). 좌석 수만큼 바뀌지 않았으면 판매 행이 없어진 것이라 되돌린다(리뷰 M4)
      const sold = await this.o.sales.markSoldIn(tx, { eventId: input.eventId, orderId: input.orderId, seatIds: input.seatIds });
      if (sold !== input.seatIds.length) throw new PaymentResultRollback({ status: 'SOLD_MISMATCH' });
      // 발권 재시도 큐 한 행
      await tx.execute(sql`
        insert into ticket_issue_job (order_id, event_id, issue_generation, attempts, next_attempt_at, issue_due_at, last_error, created_at)
        values (${input.orderId}::uuid, ${input.eventId}::uuid, ${input.paymentEventSeq}::bigint, 0, ${now}::timestamptz, ${new Date(input.issueDueAtMs)}::timestamptz, null, ${now}::timestamptz)
        on conflict (order_id) do nothing`);
      // T9·T13·T16(APPROVED 사건의 Outbox가 업무 문장의 마지막)
      const t = await this.o.store.transition(tx, { orderId: input.orderId, transition: input.transition, actor: input.actor, paymentEventSeq: input.paymentEventSeq });
      if (t.status !== 'APPLIED') throw new PaymentResultRollback(staleOf(t));
      return { status: 'APPLIED' } as const;
    });
  }

  async fail(input: PaymentFailInput): Promise<PaymentResultWriteOutcome> {
    assertFail(input);
    const from = fromOf(input.transition);
    return this.#tx(async (tx) => {
      const now = new Date(this.o.clock.now());
      // 첫 문장: 작업 행을 RELEASE로(단계·임대와 상관없이, 임대를 비워 커밋 뒤 kick이 곧바로 집게). 잠금 차례 작업 행 → 주문 행
      const job = await tx.execute(sql`
        update order_saga_job set step = 'RELEASE', attempts = 0, next_attempt_at = ${now}::timestamptz, lease_until = null
        where order_id = ${input.orderId}::uuid
        returning order_id`);
      if (job.rows.length === 0) {
        // 작업 행이 없다(손질·PRF-171 전의 옛 길. 지금은 T12·T10·T14도 작업 행을 AWAIT로 남긴다): 주문 행이 있을 때만 RELEASE 행을 넣는다
        // (없는 주문을 외래 키 위반으로 던지지 않는다)
        if (!(await orderExists(tx, input.orderId))) throw new PaymentResultRollback({ status: 'STALE', reason: 'NOT_FOUND' });
        await tx.execute(sql`
          insert into order_saga_job (order_id, event_id, step, attempts, next_attempt_at, lease_until, created_at)
          values (${input.orderId}::uuid, ${input.eventId}::uuid, 'RELEASE', 0, ${now}::timestamptz, null, ${now}::timestamptz)
          on conflict (order_id) do update set step = 'RELEASE', attempts = 0, next_attempt_at = excluded.next_attempt_at, lease_until = null`);
      }
      // 실패 사유(출발 상태이고 순번이 더 클 때만, 상태 칸은 전이 함수가 바꾼다). 0행이면 그 사이 다른 전이가 먼저 했거나 다시 온 사건이다
      const marked = await tx.execute(sql`
        update purchase_order set failure_reason = ${input.failureReason}
        where id = ${input.orderId}::uuid and status = ${from} and payment_event_seq < ${input.paymentEventSeq}::bigint
        returning id`);
      if (marked.rows.length === 0) throw new PaymentResultRollback(await failStaleOf(tx, input.orderId, from));
      // 판매 행 PENDING을 지우고 한도를 되돌린다(잠금 차례 한도 행 → 좌석 행)
      await this.o.sales.releasePendingIn(tx, input.release);
      // 과금 없이 끝났다: 남은 결제 키·거래 ID·토큰을 지운다
      await clearRefs(tx, input.orderId);
      // T11·T15·T17(FAILED 사건의 Outbox가 업무 문장의 마지막)
      const t = await this.o.store.transition(tx, { orderId: input.orderId, transition: input.transition, actor: input.actor, paymentEventSeq: input.paymentEventSeq });
      if (t.status !== 'APPLIED') throw new PaymentResultRollback(staleOf(t));
      return { status: 'APPLIED' } as const;
    });
  }

  async mark(input: PaymentMarkInput): Promise<PaymentResultWriteOutcome> {
    assertMark(input);
    const from = fromOf(input.transition);
    return this.#tx(async (tx) => {
      // 첫 문장: 작업 행을 지우지 않고 AWAIT로 남겨 다음 당기기 점검을 둔다(있으면, 잠금 차례 작업 행 → 주문 행. 중간 결과라 최종 결과를 당겨 받는다, PRF-171).
      // Saga의 next_attempt_at은 무한대로 둔다(Saga 쓸기 색인의 차례 앞을 막지 않게, 리뷰 고침 M1). 판매 행 PENDING은 그대로다.
      // STALE이면 트랜잭션째 되돌리므로 작업 행도 그대로 남는다
      const pullNextAt = new Date(this.o.clock.now() + (input.transition === 'T12' ? PAYMENT_PULL_AFTER_UNKNOWN_MS : PAYMENT_PULL_AFTER_DEPOSIT_MS));
      await tx.execute(sql`
        update order_saga_job set step = 'AWAIT', pull_next_at = ${pullNextAt}::timestamptz, next_attempt_at = 'infinity'::timestamptz
        where order_id = ${input.orderId}::uuid`);
      // 둘째: 주문 행을 잠그고 상태·순번을 본다(잠금 차례 작업 행 → 주문 행 → 결제 시도 행)
      const stale = await lockSource(tx, input.orderId, from, input.paymentEventSeq);
      if (stale) throw new PaymentResultRollback(stale);
      // 남은 결제 참조를 지운다(UNKNOWN·AWAITING_DEPOSIT 사건이 왔다는 것은 승인 명령이 접수됐다는 뜻, 리뷰 M1)
      await clearRefs(tx, input.orderId);
      // 입금 대기면 판매 행에 입금 기한 + 10분 [가정]을 쓴다(사건에 기한이 없으면 칸 없이 온다, BUILD_ORDER HOT-151)
      if (input.depositPending) await this.o.sales.setPendingUntilIn(tx, { eventId: input.depositPending.eventId, orderId: input.orderId, seatIds: input.depositPending.seatIds, pendingUntilMs: input.depositPending.pendingUntilMs });
      // T10·T14(AWAITING_DEPOSIT 사건)·T12(사건 없이 이력만)
      const t = await this.o.store.transition(tx, { orderId: input.orderId, transition: input.transition, actor: input.actor, paymentEventSeq: input.paymentEventSeq });
      if (t.status !== 'APPLIED') throw new PaymentResultRollback(staleOf(t));
      return { status: 'APPLIED' } as const;
    });
  }

  async reverse(input: PaymentReverseInput): Promise<PaymentResultWriteOutcome> {
    assertReverse(input);
    return this.#tx(async (tx) => {
      const nowMs = this.o.clock.now();
      const now = new Date(nowMs);
      // 첫 문장: 주문 행을 잠그고 상태·순번을 본다. CONFIRMED 주문에는 작업 행이 없어 잠금 차례(작업 행 → 주문 행)가 부딪칠 상대가 없다
      const stale = await lockSource(tx, input.orderId, 'CONFIRMED', input.paymentEventSeq);
      if (stale) throw new PaymentResultRollback(stale);
      // 작업 행을 AWAIT로 넣어 다시 들어온 입금을 결과 당기기가 받게 한다(pull_next_at = 지금 + 60초 [가정], 당기기의 조건이라 confirm_sent_at도 쓴다)
      const pullNextAt = new Date(nowMs + PAYMENT_PULL_AFTER_DEPOSIT_MS);
      await tx.execute(sql`
        insert into order_saga_job (order_id, event_id, step, attempts, next_attempt_at, lease_until, created_at, confirm_sent_at, pull_next_at)
        values (${input.orderId}::uuid, ${input.eventId}::uuid, 'AWAIT', 0, 'infinity'::timestamptz, null, ${now}::timestamptz, ${now}::timestamptz, ${pullNextAt}::timestamptz)
        on conflict (order_id) do update set step = 'AWAIT', pull_next_at = excluded.pull_next_at, next_attempt_at = 'infinity'::timestamptz, confirm_sent_at = coalesce(order_saga_job.confirm_sent_at, excluded.confirm_sent_at)`);
      // 판매 행 SOLD → PENDING(좌석 ID 순 잠금). 좌석 수만큼 바뀌지 않았으면 판매 행이 없어진 것이라 되돌린다
      const pending = await this.o.sales.markPendingAgainIn(tx, { eventId: input.eventId, orderId: input.orderId, seatIds: input.seatIds, ...(input.pendingUntilMs === undefined ? {} : { pendingUntilMs: input.pendingUntilMs }) });
      if (pending !== input.seatIds.length) throw new PaymentResultRollback({ status: 'SOLD_MISMATCH' });
      await tx.execute(sql`update order_item set ticket_id = null where order_id = ${input.orderId}::uuid`);
      // 티켓 무효 작업 행. 무효로 할 세대는 되돌리기 직전의 payment_event_seq다(T21이 순번을 바꾸기 전에 읽는다)
      await tx.execute(sql`
        insert into ticket_void_job (order_id, event_id, issue_generation, attempts, next_attempt_at, lease_until, last_error, created_at)
        select id, ${input.eventId}::uuid, payment_event_seq, 0, ${now}::timestamptz, null, null, ${now}::timestamptz from purchase_order where id = ${input.orderId}::uuid
        on conflict (order_id) do update set issue_generation = excluded.issue_generation, attempts = 0, next_attempt_at = excluded.next_attempt_at, lease_until = null, last_error = null`);
      // T21(trade.orders DEPOSIT_REVERSED Outbox가 업무 문장의 마지막)
      const t = await this.o.store.transition(tx, { orderId: input.orderId, transition: input.transition, actor: input.actor, paymentEventSeq: input.paymentEventSeq });
      if (t.status !== 'APPLIED') throw new PaymentResultRollback(staleOf(t));
      return { status: 'APPLIED' } as const;
    });
  }

  async holdIssue(orderId: string): Promise<boolean> {
    if (!isUuid(orderId)) return false;
    // 이미 멈춘 행은 그대로 둔다(사람이 본 까닭을 덮지 않는다). 임대까지 비워 돌던 발권의 늦은 답이 이어 쓰지 못한다
    const r = await this.o.database.transaction(
      (tx) =>
        tx.execute(sql`
          update ticket_issue_job set next_attempt_at = null, lease_until = null, last_error = 'DEPOSIT_REVERSED'
          where order_id = ${orderId}::uuid and next_attempt_at is not null
          returning order_id`),
      TX,
    );
    return r.rows.length > 0;
  }

  /** 트랜잭션 하나(READ COMMITTED, 문장 시간 한도 5초 [가정]). 되돌림 표지는 결과로 바꾼다 */
  async #tx(fn: (tx: DbTransaction) => Promise<PaymentResultWriteOutcome>): Promise<PaymentResultWriteOutcome> {
    try {
      return await this.o.database.transaction(fn, TX);
    } catch (e) {
      if (e instanceof PaymentResultRollback) return e.outcome;
      throw e;
    }
  }
}

/** 트랜잭션 안에서 되돌릴 때 던지는 표지(밖에서 결과로 바꾼다. 밖으로 새지 않는다) */
export class PaymentResultRollback extends Error {
  constructor(readonly outcome: Exclude<PaymentResultWriteOutcome, { status: 'APPLIED' }>) {
    super('결제 결과 트랜잭션을 되돌린다');
    this.name = 'PaymentResultRollback';
  }
}
