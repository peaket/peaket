// 주문 Saga 1단계의 purchase DB 쪽(SagaJobs·SagaOrders·ReserveTx·SagaFailures·ConfirmSent, docs/features/payment.md §2 'Saga 1단계의 첫 구현',
// docs/data.md §5 'Saga 1단계', BUILD_ORDER PRF-165).
// - 작업 집기(claimDue·claim): 짧은 트랜잭션 하나에서 FOR UPDATE SKIP LOCKED로 골라 임대(lease_until)를 쓰고 바로 커밋한다(data.md §5 발송 워커와 같은 꼴).
// - 판매 예약(reserve, READ COMMITTED): seat_rebuild 회차 행 넣기(ON CONFLICT DO NOTHING) → gen FOR SHARE → 대조 → 판매 예약(inventory reserveIn, 같은 트랜잭션)
//   → 작업 CONFIRM(임대는 그대로, 보낸 시각 비움) → T7. 판 번호 올리기(다시 만들기의 그 행 갱신)와 차례가 정해진다(OPEN[15]).
//   잠금 차례: seat_rebuild 행 → 한도 행 → 좌석 행 → 작업 행 → 주문 행. GEN_CHANGED는 되돌리기만 한다(주문 seat_gen을 고치지 않는다, 리뷰 M1).
// - 실패 기록(fail, READ COMMITTED): 작업 행 step RELEASE(기대 단계·자기 임대, 0행이면 STALE) → 주문 failure_reason → (T11) releasePendingIn → 결제 참조 지우기 → T8·T11.
//   잠금 차례: 작업 행 → 주문 행 → 한도 행 → 좌석 행 → 결제 시도 행(판매 예약과 같이 작업 행이 주문 행보다 먼저다, 리뷰 H1 변형). 작업 행은 실행기가 해제 뒤 지운다(리뷰 M4).
// - 승인 명령 뒤(done): CONFIRM 작업 행을 지우지 않고 AWAIT로(자기 임대, confirm_sent_at 그대로, next_attempt_at = 'infinity') → 결제 참조 지우기
//   (한 트랜잭션, 잠금 차례 작업 행 → 결제 시도 행). AWAIT 행은 결제 결과 당기기(drizzle-payment-pull.ts)가 찾고 결과 반영(drizzle-payment-results.ts)이 끝낸다
//   (BUILD_ORDER PRF-171 설계 1, ADR-0140). next_attempt_at을 무한대로 두어 며칠 남을 수 있는 AWAIT 행이 Saga 잡기의 쓸기 색인(next_attempt_at) 차례 앞을
//   막지 않게 한다(docs/data.md §5.1 '결과 당기기 대상', 2026-11-06 코드 리뷰 M1).
// - Saga 잡기(claimDue·claim)는 AWAIT 행을 고르지 않는다(step <> 'AWAIT', PRF-171 설계 2). setStep·reschedule도 AWAIT 행을 바꾸지 않는다(모르는 단계로 다룬다.
//   reschedule이 바꾸면 무한대가 되돌아간다, 리뷰 고침 M1). 행 읽기(get 등)는 무한대를 Infinity로 읽는다(던지지 않는다).
// - 건너뛰기(abandon, 리뷰 M3): 그 단계의 작업 행 잠금 → 주문 상태 → 그 단계를 지났으면 결제 참조·작업 행 지우기.
// 주문 상태는 주문 전이 함수(DrizzleOrderStore.transition)로만 바꾼다(상태 SQL은 drizzle-orders.ts에만, test/order-status-sql.test.ts). 결제 참조·토큰은 로그·오류 글에 싣지 않는다.
// inventory를 가져오지 않는다: 판매 예약·PENDING 지우기는 필요한 메서드 모양(SagaSeatSales)만 받는다(조립은 main.ts가 DrizzleSeatSales를 넘긴다).
// 구현에서 정한 것(정본에 없다):
// - 임대가 '지났다'는 lease_until ≤ 지금이다(그 시각에 임대가 끝난다). 임대·기한의 '지금'은 앱 시계(DrizzleSagaOptions.clock)다.
// - claimDue는 next_attempt_at 오름차순(같으면 주문 ID 순)으로 고르고 그 차례로 돌려준다. 집기는 attempts를 바꾸지 않는다(reschedule만 1 올린다).
// - 작업 행을 바꾸는 메서드는 자기 임대 값(lease_until = 잡은 값)을 받으면 조건으로 건다(리뷰 낮음). 트랜잭션마다 문장 시간 한도 5초 [가정](요청 밖이다).
// - 판매 예약 트랜잭션에서 작업 행이 없거나 남의 임대면 ORDER_STATE로 되돌린다(작업 없는 RESERVED 주문을 만들지 않는다).
// - 결제 참조를 지우는 결제 시도는 그 주문의 ACCEPTED 시도다. 시도 상태(status)는 바꾸지 않는다(정본에 없다).
import type { Clock, Database, DbTransaction } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { ACTOR_PATTERN, type OrderStatus } from '../../domain/order.js';
import type {
  ConfirmSent,
  LeaseGuard,
  PaymentPg,
  PaymentRefs,
  ReserveTx,
  ReserveTxInput,
  ReserveTxOutcome,
  SagaAttemptView,
  SagaFailInput,
  SagaFailOutcome,
  SagaFailures,
  SagaJob,
  SagaJobs,
  SagaOrders,
  SagaOrderView,
  SagaSaleRelease,
} from '../../domain/ports.js';
import { SAGA_FAILURE_REASONS, SAGA_STATEMENT_TIMEOUT_MS, sagaStepPassed, type SagaStep } from '../../domain/saga.js';
import type { DrizzleOrderStore } from './drizzle-orders.js';

/** inventory DrizzleSeatSales의 바깥 트랜잭션 면(reserveIn·releasePendingIn)의 모양 */
export interface SagaSeatSales {
  /** RESERVED가 아니면 부르는 쪽이 트랜잭션째 되돌린다 */
  reserveIn(
    tx: DbTransaction,
    input: { eventId: string; orderId: string; accountId: string; seatIds: readonly string[]; limit: number },
  ): Promise<{ status: 'RESERVED' } | { status: 'QUOTA_EXCEEDED' } | { status: 'SEAT_TAKEN'; seatIds: string[] }>;
  releasePendingIn(tx: DbTransaction, release: SagaSaleRelease): Promise<number>;
}

export interface DrizzleSagaOptions {
  database: Database;
  /** 주문 전이 함수(T7·T8·T11) */
  store: DrizzleOrderStore;
  /** 판매 예약·PENDING 지우기(inventory DrizzleSeatSales) */
  sales: SagaSeatSales;
  clock: Clock;
}

/** 표의 uuid 글(소문자) */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** PostgreSQL int4 최댓값(seat_gen·limit 칸) */
const INT4_MAX = 2_147_483_647;
/** 주문 하나의 좌석 수 상한 [가정: 주문 하나 10석 이하] */
const MAX_SEATS = 10;
/** 모든 트랜잭션의 격리 수준(서버·역할 기본값에 기대지 않는다)과 문장 시간 한도 5초 [가정](요청 밖이라 요청의 남은 시간이 없다) */
const TX = { isolationLevel: 'read committed', statementTimeoutMs: SAGA_STATEMENT_TIMEOUT_MS } as const;
/** seat_rebuild 행이 없을 때 넣는 판 번호(판매 열기의 판 번호 1, inventory INITIAL_SEAT_GEN과 같은 값. booking은 inventory를 가져오지 않아 다시 적는다) */
const INITIAL_GEN = 1;
/** 실패 전이의 출발 상태와 그때의 작업 단계 */
const FAIL_FROM: Readonly<Record<'T8' | 'T11', { status: OrderStatus; step: SagaStep }>> = {
  T8: { status: 'ACCEPTED', step: 'RESERVE' },
  T11: { status: 'RESERVED', step: 'CONFIRM' },
};
const FAILURE_REASONS: ReadonlySet<string> = new Set(SAGA_FAILURE_REASONS);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const isPositiveInt = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= max;

function assertActor(v: unknown): void {
  if (typeof v !== 'string' || !ACTOR_PATTERN.test(v)) throw new RangeError('행위자(actor)가 account:<UUID>·admin:<UUID>·system:<작업 이름> 모양이 아니다');
}

/** 자기 임대 값: 없거나 0 이상의 안전한 정수(epoch ms) */
function assertLease(v: unknown): void {
  if (v !== undefined && !(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)) throw new RangeError(`임대 값(leaseUntilMs)은 epoch ms 정수다: ${String(v)}`);
}

/** 자기 임대 조건 SQL 조각(값이 없으면 빈 조각) */
const leaseCond = (lease: LeaseGuard) => (lease === undefined ? sql`` : sql` and lease_until = ${new Date(lease)}::timestamptz`);

/** 좌석 ID 묶음(소문자 UUID, 1~10개, 겹침 없음) */
function assertSeatIds(v: unknown): void {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_SEATS) throw new RangeError(`seatIds는 1~${MAX_SEATS}개여야 한다`);
  if (!v.every(isUuid)) throw new RangeError('seatIds에 소문자 UUID가 아닌 좌석 ID가 있다');
  if (new Set(v).size !== v.length) throw new RangeError('seatIds에 같은 좌석이 두 번 있다');
}

/** 판매 예약 트랜잭션 입력 검사(DB에 가기 전) */
function assertReserveTxInput(i: ReserveTxInput): void {
  if (!isObject(i)) throw new RangeError('판매 예약 입력이 객체가 아니다');
  if (!isUuid(i.orderId)) throw new RangeError('orderId가 소문자 UUID가 아니다');
  if (!isUuid(i.eventId)) throw new RangeError('eventId가 소문자 UUID가 아니다');
  if (!isUuid(i.accountId)) throw new RangeError('accountId가 소문자 UUID가 아니다');
  assertSeatIds(i.seatIds);
  if (!isPositiveInt(i.limit)) throw new RangeError(`1인 한도는 1 이상의 정수다: ${String(i.limit)}`);
  if (!isPositiveInt(i.orderGen, INT4_MAX)) throw new RangeError(`orderGen은 1~${INT4_MAX}의 정수다: ${String(i.orderGen)}`);
  assertActor(i.actor);
  assertLease(i.leaseUntilMs);
}

/** 실패 기록 입력 검사(DB에 가기 전) */
function assertFailInput(i: SagaFailInput): void {
  if (!isObject(i)) throw new RangeError('실패 기록 입력이 객체가 아니다');
  if (!isUuid(i.orderId)) throw new RangeError('orderId가 소문자 UUID가 아니다');
  if (i.transition !== 'T8' && i.transition !== 'T11') throw new RangeError(`Saga 실패 전이는 T8·T11이다: ${String(i.transition)}`);
  if (typeof i.reason !== 'string' || !FAILURE_REASONS.has(i.reason)) throw new RangeError(`Saga 실패 사유가 목록에 없다: ${String(i.reason)}`);
  assertActor(i.actor);
  assertLease(i.leaseUntilMs);
  const r: unknown = i.release;
  if (i.transition === 'T8') {
    if (r !== undefined) throw new RangeError('T8(판매 예약 전)에는 판매 행 지우기(release)를 주지 않는다');
    return;
  }
  if (!isObject(r)) throw new RangeError('T11에는 판매 행 지우기(release)가 있어야 한다');
  if (!isUuid(r.eventId) || !isUuid(r.accountId)) throw new RangeError('release의 eventId·accountId가 소문자 UUID가 아니다');
  if (r.orderId !== i.orderId) throw new RangeError('release의 orderId가 실패 기록의 주문과 다르다');
  assertSeatIds(r.seatIds);
}

type JobRow = {
  order_id: string;
  event_id: string;
  step: string;
  attempts: number | string;
  /** AWAIT 행은 무한대다(드라이버가 'infinity' 글이나 Infinity 수로 넘긴다) */
  next_attempt_at: Date | string | number;
  lease_until: Date | string | null;
  confirm_sent_at: Date | string | null;
};
const JOB_COLUMNS = sql.raw('order_id, event_id, step, attempts, next_attempt_at, lease_until, confirm_sent_at');
const JOB_COLUMNS_J = sql.raw('j.order_id, j.event_id, j.step, j.attempts, j.next_attempt_at, j.lease_until, j.confirm_sent_at');

/**
 * timestamptz 칸 → epoch ms. 무한대('infinity'·'-infinity' 글, node-postgres가 바꾼 ±Infinity 수)는 ±Infinity다
 * (new Date('infinity')는 NaN이고 toISOString은 던진다. AWAIT 행의 next_attempt_at, 리뷰 고침 M1)
 */
const msOf = (v: Date | string | number): number => {
  if (typeof v === 'number') return v;
  if (v === 'infinity') return Number.POSITIVE_INFINITY;
  if (v === '-infinity') return Number.NEGATIVE_INFINITY;
  return new Date(v).getTime();
};

function jobOf(r: JobRow): SagaJob {
  return {
    orderId: r.order_id,
    eventId: r.event_id,
    step: r.step as SagaStep,
    attempts: Number(r.attempts),
    nextAttemptAtMs: msOf(r.next_attempt_at),
    ...(r.lease_until !== null ? { leaseUntilMs: msOf(r.lease_until) } : {}),
    ...(r.confirm_sent_at !== null ? { confirmSentAtMs: msOf(r.confirm_sent_at) } : {}),
  };
}

/** 고른 차례(next_attempt_at, 같으면 주문 ID) */
const byDue = (a: SagaJob, b: SagaJob): number => a.nextAttemptAtMs - b.nextAttemptAtMs || (a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0);

/** 결제 시도 행의 결제 참조 칸 → PaymentRefs. 결제사에 맞는 칸이 비었으면(지웠다) undefined */
function refsOf(pg: PaymentPg, key: string | null, txId: string | null, token: string | null): PaymentRefs | undefined {
  if (pg === 'PORTONE') return txId !== null && token !== null ? { pg, txId, paymentToken: token } : undefined;
  return key !== null ? { pg, paymentKey: key } : undefined;
}

/** 그 주문 ACCEPTED 시도의 결제 키·거래 ID·토큰을 지우는 문장(과금 없이 끝났거나 승인 명령이 접수됐다. 5년 보관은 payment-svc 결제 원장이다) */
const clearRefs = (tx: DbTransaction, orderId: string) =>
  tx.execute(sql`
    update payment_attempt set pg_payment_key = null, pg_tx_id = null, pg_payment_token = null
    where order_id = ${orderId}::uuid and status = 'ACCEPTED'`);

/**
 * Saga 작업·주문의 purchase DB 구현(위 머리 주석의 차례). 트랜잭션은 모두 READ COMMITTED·문장 시간 한도 5초 [가정]를 직접 고른다.
 * 0행으로 되돌리는 길(GEN_CHANGED·SEAT_TAKEN·QUOTA_EXCEEDED·ORDER_STATE·STALE)은 표지 오류를 던져 되돌린 뒤 밖에서 결과로 바꾼다(drizzle-order-accepts.ts와 같은 꼴).
 */
export class DrizzleSaga implements SagaJobs, SagaOrders, ReserveTx, SagaFailures, ConfirmSent {
  constructor(private readonly o: DrizzleSagaOptions) {}

  // ---- SagaJobs ----

  async claimDue(limit: number, leaseMs: number): Promise<SagaJob[]> {
    if (!isPositiveInt(limit)) throw new RangeError(`limit은 1 이상의 정수다: ${String(limit)}`);
    if (!isPositiveInt(leaseMs)) throw new RangeError(`leaseMs는 1 이상의 정수다: ${String(leaseMs)}`);
    const now = this.o.clock.now();
    const at = new Date(now);
    const until = new Date(now + leaseMs);
    // AWAIT(승인 명령 접수 뒤 결과 기다림) 행은 고르지 않는다(결과 당기기가 고른다, PRF-171 설계 2)
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        with picked as (
          select order_id from order_saga_job
          where step <> 'AWAIT' and next_attempt_at <= ${at}::timestamptz and (lease_until is null or lease_until <= ${at}::timestamptz)
          order by next_attempt_at, order_id
          limit ${limit}::int
          for update skip locked)
        update order_saga_job j set lease_until = ${until}::timestamptz
        from picked p
        where j.order_id = p.order_id
        returning ${JOB_COLUMNS_J}`),
    );
    // RETURNING의 차례는 정해지지 않아 고른 차례로 다시 맞춘다
    return (r.rows as JobRow[]).map(jobOf).sort(byDue);
  }

  async claim(orderId: string, leaseMs: number): Promise<SagaJob | undefined> {
    if (!isUuid(orderId)) return undefined;
    if (!isPositiveInt(leaseMs)) throw new RangeError(`leaseMs는 1 이상의 정수다: ${String(leaseMs)}`);
    const now = this.o.clock.now();
    const at = new Date(now);
    const until = new Date(now + leaseMs);
    // claimDue와 같은 조건(AWAIT 행 빼기 포함: 접수 뒤 kick·runOne이 승인 명령을 다시 보내지 않게), 행 잠금을 쥔 다른 실행(판매 예약 트랜잭션 등)이 있으면 기다리지 않고 집지 않는다
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        with picked as (
          select order_id from order_saga_job
          where order_id = ${orderId}::uuid and step <> 'AWAIT' and next_attempt_at <= ${at}::timestamptz and (lease_until is null or lease_until <= ${at}::timestamptz)
          for update skip locked)
        update order_saga_job j set lease_until = ${until}::timestamptz
        from picked p
        where j.order_id = p.order_id
        returning ${JOB_COLUMNS_J}`),
    );
    const row = r.rows[0] as JobRow | undefined;
    return row ? jobOf(row) : undefined;
  }

  async get(orderId: string): Promise<SagaJob | undefined> {
    if (!isUuid(orderId)) return undefined;
    const r = await this.o.database.db.execute(sql`select ${JOB_COLUMNS} from order_saga_job where order_id = ${orderId}::uuid`);
    const row = r.rows[0] as JobRow | undefined;
    return row ? jobOf(row) : undefined;
  }

  async reschedule(orderId: string, nextAtMs: number, lease?: LeaseGuard): Promise<boolean> {
    if (!isUuid(orderId)) return false;
    const next = new Date(nextAtMs);
    if (typeof nextAtMs !== 'number' || Number.isNaN(next.getTime())) throw new RangeError(`nextAtMs가 날짜(유닉스 밀리초)가 아니다: ${String(nextAtMs)}`);
    assertLease(lease);
    // AWAIT 행(결과 기다림)은 바꾸지 않는다: 무한대 next_attempt_at을 되돌리지 않는다(Saga가 쥔 CONFIRM 행을 그사이 결과 반영이 AWAIT로 바꾼 경우, 리뷰 고침 M1)
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        update order_saga_job set attempts = attempts + 1, next_attempt_at = ${next}::timestamptz, lease_until = null
        where order_id = ${orderId}::uuid and step <> 'AWAIT'${leaseCond(lease)}
        returning order_id`),
    );
    return r.rows.length > 0;
  }

  async setStep(orderId: string, step: SagaStep, lease?: LeaseGuard): Promise<boolean> {
    if (!isUuid(orderId)) return false;
    assertLease(lease);
    // 단계 값은 표의 CHECK(RESERVE·CONFIRM·RELEASE 0006, AWAIT 0010)가 막는다. 보낸 시각은 그대로 둔다(한 번 보낸 명령은 되돌릴 수 없다).
    // AWAIT 행(결과 기다림)은 바꾸지 않는다(Saga가 모르는 단계로 다룬다, PRF-171 설계 2)
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        update order_saga_job set step = ${step}, attempts = 0, next_attempt_at = ${new Date(this.o.clock.now())}::timestamptz, lease_until = null
        where order_id = ${orderId}::uuid and step <> 'AWAIT'${leaseCond(lease)}
        returning order_id`),
    );
    return r.rows.length > 0;
  }

  async delete(orderId: string, o: { readonly step?: SagaStep; readonly leaseUntilMs?: number } = {}): Promise<boolean> {
    if (!isUuid(orderId)) return false;
    assertLease(o.leaseUntilMs);
    const stepCond = o.step === undefined ? sql`` : sql` and step = ${o.step}`;
    const r = await this.#tx((tx) => tx.execute(sql`delete from order_saga_job where order_id = ${orderId}::uuid${stepCond}${leaseCond(o.leaseUntilMs)} returning order_id`));
    return r.rows.length > 0;
  }

  async markConfirmSent(orderId: string, lease?: LeaseGuard): Promise<boolean> {
    if (!isUuid(orderId)) return false;
    assertLease(lease);
    // 처음 보낼 때만 적는다(이미 있으면 그대로). 커밋한 뒤에 보낸다(리뷰 H1)
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        update order_saga_job set confirm_sent_at = coalesce(confirm_sent_at, ${new Date(this.o.clock.now())}::timestamptz)
        where order_id = ${orderId}::uuid and step = 'CONFIRM'${leaseCond(lease)}
        returning order_id`),
    );
    return r.rows.length > 0;
  }

  async release(orderId: string, leaseUntilMs: number): Promise<boolean> {
    if (!isUuid(orderId)) return false;
    assertLease(leaseUntilMs);
    const r = await this.#tx((tx) =>
      tx.execute(sql`update order_saga_job set lease_until = null where order_id = ${orderId}::uuid${leaseCond(leaseUntilMs)} returning order_id`),
    );
    return r.rows.length > 0;
  }

  async abandon(orderId: string, step: SagaStep, lease?: LeaseGuard): Promise<'REMOVED' | 'KEPT' | 'GONE'> {
    if (!isUuid(orderId)) return 'GONE';
    assertLease(lease);
    return this.#tx(async (tx) => {
      // 잠금 차례 작업 행 → 주문 행(판매 예약·실패 기록과 같다)
      const job = await tx.execute(sql`select order_id from order_saga_job where order_id = ${orderId}::uuid and step = ${step}${leaseCond(lease)} for update`);
      if (job.rows.length === 0) return 'GONE' as const;
      const status = await statusOf(tx, orderId);
      if (status === undefined || !sagaStepPassed(step, status)) return 'KEPT' as const;
      await clearRefs(tx, orderId);
      await tx.execute(sql`delete from order_saga_job where order_id = ${orderId}::uuid and step = ${step}`);
      return 'REMOVED' as const;
    });
  }

  // ---- SagaOrders ----

  /** 주문 행(holdId·psid·seat_gen·금액) + 항목(줄 번호 차례) + ACCEPTED 결제 시도(pg·pg_order_ref·결제 참조·authenticated_at) */
  async read(orderId: string): Promise<SagaOrderView | undefined> {
    if (!isUuid(orderId)) return undefined;
    const db = this.o.database.db;
    const o = await db.execute(sql`
      select id, account_id, event_id, status, amount, hold_id, purchase_session_id, seat_gen from purchase_order where id = ${orderId}::uuid`);
    const row = o.rows[0] as
      | { id: string; account_id: string; event_id: string; status: string; amount: number | string; hold_id: string; purchase_session_id: string; seat_gen: number | null }
      | undefined;
    if (!row) return undefined;
    const items = await db.execute(sql`select seat_id, tier, section_id from order_item where order_id = ${orderId}::uuid order by line_no`);
    const a = await db.execute(sql`
      select a.id, a.pg, a.pg_order_ref, a.pg_payment_key, a.pg_tx_id, a.pg_payment_token, a.authenticated_at,
        (select count(*) from payment_attempt b where b.order_id = a.order_id and (b.created_at, b.id) <= (a.created_at, a.id)) as attempt_no
      from payment_attempt a
      where a.order_id = ${orderId}::uuid and a.status = 'ACCEPTED'
      limit 1`);
    const att = a.rows[0] as
      | {
          id: string;
          pg: string;
          pg_order_ref: string | null;
          pg_payment_key: string | null;
          pg_tx_id: string | null;
          pg_payment_token: string | null;
          authenticated_at: Date | string | null;
          attempt_no: number | string;
        }
      | undefined;
    let attempt: SagaAttemptView | undefined;
    if (att) {
      const pg = att.pg as PaymentPg;
      const refs = refsOf(pg, att.pg_payment_key, att.pg_tx_id, att.pg_payment_token);
      attempt = {
        attemptId: att.id,
        pg,
        attemptNo: Number(att.attempt_no),
        ...(att.pg_order_ref !== null ? { pgOrderRef: att.pg_order_ref } : {}),
        ...(refs ? { refs } : {}),
        ...(att.authenticated_at !== null ? { authenticatedAtMs: msOf(att.authenticated_at) } : {}),
      };
    }
    return {
      orderId: row.id,
      accountId: row.account_id,
      eventId: row.event_id,
      status: row.status as OrderStatus,
      amount: Number(row.amount),
      holdId: row.hold_id,
      purchaseSessionId: row.purchase_session_id,
      ...(row.seat_gen !== null ? { seatGen: Number(row.seat_gen) } : {}),
      seats: (items.rows as { seat_id: string; tier: string; section_id: string }[]).map((x) => ({ seatId: x.seat_id, tierId: x.tier, sectionId: x.section_id })),
      ...(attempt ? { attempt } : {}),
    };
  }

  /**
   * 묶기 OK 뒤 판 번호와 pinned_at을 한 UPDATE로(BUILD_ORDER PRF-167, 리뷰 고침 L5): 접수된 주문(ACCEPTED)이고 판 번호가 그대로(seat_gen = fromGen)일 때만
   * seat_gen = toGen, pinned_at = coalesce(pinned_at, 지금)(이미 있으면 처음 값). 시각은 앱 시계다(confirm_sent_at과 같다). 상태 칸·이력은 건드리지 않는다.
   * 소문자 UUID가 아니면 false
   */
  async recordPinned(orderId: string, fromGen: number, toGen: number): Promise<boolean> {
    if (!isUuid(orderId)) return false;
    if (!isPositiveInt(fromGen, INT4_MAX) || !isPositiveInt(toGen, INT4_MAX)) throw new RangeError(`판 번호는 1~${INT4_MAX}의 정수다: ${String(fromGen)} → ${String(toGen)}`);
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        update purchase_order set seat_gen = ${toGen}::int, pinned_at = coalesce(pinned_at, ${new Date(this.o.clock.now())}::timestamptz)
        where id = ${orderId}::uuid and status = 'ACCEPTED' and seat_gen = ${fromGen}::int
        returning id`),
    );
    return r.rows.length > 0;
  }

  // ---- ReserveTx ----

  async reserve(input: ReserveTxInput): Promise<ReserveTxOutcome> {
    assertReserveTxInput(input);
    try {
      return await this.#tx(async (tx) => {
        // 회차 행이 없으면 판 번호 1로 넣는다(다시 만들기가 없던 회차). 있으면 그대로(쓰지 않는다)
        await tx.execute(sql`
          insert into seat_rebuild (event_id, gen, holder, lease_until) values (${input.eventId}::uuid, ${INITIAL_GEN}::int, null, null)
          on conflict (event_id) do nothing`);
        // 판 번호를 FOR SHARE로 잠가 읽는다: 다시 만들기의 판 번호 올리기(그 행 갱신)는 이 트랜잭션이 끝날 때까지 기다리고, 그것이 먼저면 여기서 기다린다
        const g = await tx.execute(sql`select gen from seat_rebuild where event_id = ${input.eventId}::uuid for share`);
        const gen = Number((g.rows[0] as { gen: number | string }).gen);
        if (gen !== input.orderGen) throw new SagaRollback({ status: 'GEN_CHANGED', gen });
        // 판매 행 PENDING·한도(같은 트랜잭션. 잠금 차례 한도 행 → 좌석 행)
        const sold = await this.o.sales.reserveIn(tx, { eventId: input.eventId, orderId: input.orderId, accountId: input.accountId, seatIds: input.seatIds, limit: input.limit });
        if (sold.status === 'SEAT_TAKEN') throw new SagaRollback({ status: 'SEAT_TAKEN', seatIds: sold.seatIds });
        if (sold.status === 'QUOTA_EXCEEDED') throw new SagaRollback({ status: 'QUOTA_EXCEEDED' });
        // 작업을 CONFIRM으로(같은 실행이 이어서 승인 명령을 보낸다. 임대는 그대로 두어 다른 파드가 곧바로 집지 않게 한다, 보낸 시각 비움)
        const job = await tx.execute(sql`
          update order_saga_job set step = 'CONFIRM', attempts = 0, next_attempt_at = ${new Date(this.o.clock.now())}::timestamptz, confirm_sent_at = null
          where order_id = ${input.orderId}::uuid and step = 'RESERVE'${leaseCond(input.leaseUntilMs)}
          returning order_id`);
        if (job.rows.length === 0) throw new SagaRollback(orderStateOf(await statusOf(tx, input.orderId)));
        // T7(RESERVED 사건의 Outbox가 업무 문장의 마지막)
        const t = await this.o.store.transition(tx, { orderId: input.orderId, transition: 'T7', actor: input.actor });
        if (t.status !== 'APPLIED') throw new SagaRollback(orderStateOf(t.current));
        return { status: 'RESERVED' } as const;
      });
    } catch (e) {
      if (!(e instanceof SagaRollback)) throw e;
      const out = e.outcome;
      if (out.status === 'STALE') throw new Error('판매 예약 트랜잭션이 실패 기록의 표지로 끝났다(코드 오류)');
      // GEN_CHANGED는 되돌리기만 한다: 주문 seat_gen을 고치지 않는다(부르는 쪽이 그 번호 그대로 묶기부터 다시 한다, 리뷰 M1)
      return out;
    }
  }

  // ---- SagaFailures ----

  async fail(input: SagaFailInput): Promise<SagaFailOutcome> {
    assertFailInput(input);
    const from = FAIL_FROM[input.transition];
    try {
      return await this.#tx(async (tx) => {
        // 첫 문장: 작업 행을 RELEASE로(기대 단계·자기 임대일 때만). 0행이면 다른 실행이 이미 끝냈거나 임대를 이어 받았다(리뷰 H1 변형).
        // 작업 행을 지우지 않는다: 실패 해제가 끝난 뒤 실행기가 지운다(리뷰 M4)
        const job = await tx.execute(sql`
          update order_saga_job set step = 'RELEASE', attempts = 0, next_attempt_at = ${new Date(this.o.clock.now())}::timestamptz
          where order_id = ${input.orderId}::uuid and step = ${from.step}${leaseCond(input.leaseUntilMs)}
          returning order_id`);
        if (job.rows.length === 0) throw new SagaRollback(staleOf(await statusOf(tx, input.orderId)));
        // 실패 사유(출발 상태일 때만). 0행이면 그 사이 다른 전이가 먼저 했다
        const marked = await tx.execute(sql`
          update purchase_order set failure_reason = ${input.reason}
          where id = ${input.orderId}::uuid and status = ${from.status}
          returning id`);
        if (marked.rows.length === 0) throw new SagaRollback(staleOf(await statusOf(tx, input.orderId)));
        // T11: 판매 행 PENDING을 지우고 한도를 되돌린다(잠금 차례 한도 행 → 좌석 행)
        if (input.release) await this.o.sales.releasePendingIn(tx, input.release);
        // 과금 없이 끝났다: 결제 키·거래 ID·토큰을 지운다
        await clearRefs(tx, input.orderId);
        // T8·T11(FAILED 사건의 Outbox가 업무 문장의 마지막. T11은 결제 사건 순번 없이 받는다)
        const t = await this.o.store.transition(tx, { orderId: input.orderId, transition: input.transition, actor: input.actor });
        if (t.status !== 'APPLIED') throw new SagaRollback(staleOf(t.current));
        return { status: 'FAILED' } as const;
      });
    } catch (e) {
      if (!(e instanceof SagaRollback)) throw e;
      const out = e.outcome;
      if (out.status !== 'STALE') throw new Error('실패 기록 트랜잭션이 판매 예약의 표지로 끝났다(코드 오류)');
      return out;
    }
  }

  // ---- ConfirmSent ----

  async done(orderId: string, lease?: LeaseGuard): Promise<boolean> {
    if (!isUuid(orderId)) return false;
    assertLease(lease);
    return this.#tx(async (tx) => {
      // 승인 명령이 접수됐다: CONFIRM 작업 행을 지우지 않고 AWAIT로 바꾸고(자기 임대. confirm_sent_at은 그대로 둬 당기기가 '접수 뒤 5초'·'기록 없음 10분'을 잰다,
      // pull_next_at은 비워 그 기준으로 잡히게 하고, next_attempt_at은 무한대로 둬 Saga 쓸기 색인의 차례 앞을 막지 않는다, 리뷰 고침 M1) 결제 참조를 지운다.
      // 결과는 trade.payments로 받고, 늦으면 결과 당기기가 이 행으로 찾는다(PRF-171 설계 1). 잠금 차례 작업 행 → 결제 시도 행
      const r = await tx.execute(sql`
        update order_saga_job set step = 'AWAIT', pull_next_at = null, next_attempt_at = 'infinity'::timestamptz
        where order_id = ${orderId}::uuid and step = 'CONFIRM'${leaseCond(lease)}
        returning order_id`);
      if (r.rows.length === 0) return false;
      await clearRefs(tx, orderId);
      return true;
    });
  }

  /** 트랜잭션 하나(READ COMMITTED, 문장 시간 한도 5초 [가정]) */
  #tx<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return this.o.database.transaction(fn, TX);
  }
}

/** 같은 트랜잭션에서 읽은 주문의 지금 상태(READ COMMITTED라 막 커밋된 값). 행이 없으면 undefined */
async function statusOf(tx: DbTransaction, orderId: string): Promise<OrderStatus | undefined> {
  const r = await tx.execute(sql`select status from purchase_order where id = ${orderId}::uuid`);
  return (r.rows[0] as { status: string } | undefined)?.status as OrderStatus | undefined;
}

const orderStateOf = (current: OrderStatus | undefined): Extract<ReserveTxOutcome, { status: 'ORDER_STATE' }> =>
  current !== undefined ? { status: 'ORDER_STATE', current } : { status: 'ORDER_STATE' };
const staleOf = (current: OrderStatus | undefined): Extract<SagaFailOutcome, { status: 'STALE' }> => (current !== undefined ? { status: 'STALE', current } : { status: 'STALE' });

/** 트랜잭션 안에서 되돌릴 때 던지는 표지(밖에서 결과로 바꾼다. 밖으로 새지 않는다) */
export class SagaRollback extends Error {
  constructor(readonly outcome: Exclude<ReserveTxOutcome, { status: 'RESERVED' }> | Extract<SagaFailOutcome, { status: 'STALE' }>) {
    super('Saga 트랜잭션을 되돌린다');
    this.name = 'SagaRollback';
  }
}
