// 승인 명령 저장소의 payment DB 쪽(docs/data.md §5 '승인 실행기'·§5.1, docs/features/payment.md §2 '승인 실행기의 첫 구현', BUILD_ORDER PRF-181)과 UNKNOWN 조회 저장소('UNKNOWN 해소의 첫 구현', BUILD_ORDER PRF-182).
// drizzle-ticket-issue.ts(purchase-svc)와 같은 꼴이다. 메서드의 약속은 domain/ports.ts PaymentConfirmJobs·PaymentUnknownQueries에 있다.
// 잠금 차례는 payment 행 → payment_confirm_job 행이다(잡기는 명령 행만 잠근다). Outbox는 업무 문장의 마지막에 쓴다(ADR-0116 결정 3).
// 운영은 핫패스 풀이 아니라 실행기 전용 일반 풀(confirmRunnerDatabaseOptions)을 넘긴다.
// 임대·occurred_at·status_changed_at의 '지금'은 앱 시계(DrizzleConfirmJobsOptions.clock)다. SQL now()를 쓰지 않는다.
// 구현에서 정한 것(정본·설계에 없다):
// - read는 트랜잭션 없이 한 문장이다(잠금이 없어 기다릴 일이 없다. 쓰기만 문장 시간 한도를 건다).
// - 잡기의 '임대가 지났다'는 lease_until < 지금이다(같은 시각은 아직 임대 중이다, drizzle-ticket-issue.ts와 같다).
import { type Clock, type Database, type DatabaseOptions, type DbTransaction, writeOutbox } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { PaymentLedgerStatus } from '../../domain/confirm-command.js';
import {
  buildPaymentEvent,
  type BuildPaymentEventInput,
  CONFIRM_RUNNER_STATEMENT_TIMEOUT_MS,
  CONFIRM_SENT_EVENT_TYPE,
  type ConfirmFinish,
  type ConfirmJob,
  type ConfirmTarget,
  paymentEventKey,
  type PaymentEventMessage,
} from '../../domain/confirm-runner.js';
import type { PgName } from '../../domain/payment-gateway.js';
import type { FinishConfirmResult, MarkConfirmSentResult, PaymentConfirmJobs, PaymentEventCodec, PaymentUnknownQueries, ResolveUnknownResult } from '../../domain/ports.js';
import { buildResolvedEvent, RESOLVED_EVENT_TYPE, type ResolvedFinish, UNKNOWN_OVERDUE_MS, UNKNOWN_QUERY_BASE_MS, unknownQueryClaimHoldMs, type UnknownQueryJob } from '../../domain/unknown-resolver.js';
import { jsonPaymentEventCodec, TRADE_PAYMENTS_TOPIC } from '../payment-events.js';

/** 승인 실행기 전용 DB 풀의 연결 수 8개 [가정](docs/verification.md §4.1 '승인 실행기') */
export const CONFIRM_RUNNER_DB_MAX = 8;

/** 모든 쓰기 트랜잭션의 격리 수준(서버·역할 기본값에 기대지 않는다)과 문장 시간 한도(요청 밖이라 요청의 남은 시간이 없다) */
const TX = { isolationLevel: 'read committed', statementTimeoutMs: CONFIRM_RUNNER_STATEMENT_TIMEOUT_MS } as const;

const isPositiveInt = (v: number): boolean => Number.isSafeInteger(v) && v >= 1;

/**
 * 승인 실행기의 payment DB(PEAKET_DATABASE_URL) 풀 설정: 일반 풀(연결을 기다린다)·연결 CONFIRM_RUNNER_DB_MAX개·이름 payment-svc-confirm.
 * 결제사가 느려도 승인 명령 접수(핫패스 풀)가 풀 대기 초과를 받지 않게 나눈다(main.ts가 createDatabase에 넘기고 종료 때 닫는다)
 */
export function confirmRunnerDatabaseOptions(url: string): DatabaseOptions {
  return { url, profile: 'general', max: CONFIRM_RUNNER_DB_MAX, applicationName: 'payment-svc-confirm' };
}

export interface DrizzleConfirmJobsOptions {
  /** 운영은 실행기 전용 일반 풀(confirmRunnerDatabaseOptions) */
  readonly database: Database;
  /** 임대·occurred_at·status_changed_at·Outbox ID의 '지금' */
  readonly clock: Clock;
  /** trade.payments 값의 바이트(기본 JSON 대역 jsonPaymentEventCodec) */
  readonly codec?: PaymentEventCodec;
}

type ClaimRow = { payment_id: string; attempts: number | string; next_attempt_at: Date | string; previous_owner: string | null };

type TargetRow = {
  id: string;
  order_id: string;
  event_id: string;
  attempt_no: number | string;
  pg: string;
  pg_payment_ref: string;
  amount: number | string;
  status: string;
  authenticated_at: Date | string;
  confirm_sent: boolean;
};

type QueryRow = {
  id: string;
  order_id: string;
  event_id: string;
  attempt_no: number | string;
  pg: string;
  pg_payment_ref: string;
  amount: number | string;
  anomaly_logged_at: Date | string | null;
  query_attempts: number | string;
};

const msOf = (v: Date | string): number => new Date(v).getTime();

/** 자기 임대 조건 SQL 조각(lease_owner·lease_until이 잡을 때 쓴 값과 같다) */
const ownLease = (job: ConfirmJob) => sql`lease_owner = ${job.owner} and lease_until = ${new Date(job.leaseUntilMs)}::timestamptz`;

/** payment 행을 잠그고 상태를 읽는다(잠금 차례의 첫째). 행이 없으면 undefined */
async function lockStatus(tx: DbTransaction, paymentId: string): Promise<PaymentLedgerStatus | undefined> {
  const r = await tx.execute(sql`select status from payment where id = ${paymentId}::uuid for update`);
  return (r.rows[0] as { status: PaymentLedgerStatus } | undefined)?.status;
}

/** 다음 순번(max(seq) + 1). payment 행 잠금을 쥔 뒤에 부른다 */
async function nextSeq(tx: DbTransaction, paymentId: string): Promise<number> {
  const r = await tx.execute(sql`select coalesce(max(seq), 0) + 1 as next from payment_event where payment_id = ${paymentId}::uuid`);
  return Number((r.rows[0] as { next: number | string }).next);
}

/** 승인 명령 저장소의 payment DB 구현 */
export class DrizzleConfirmJobs implements PaymentConfirmJobs, PaymentUnknownQueries {
  readonly #codec: PaymentEventCodec;

  constructor(private readonly o: DrizzleConfirmJobsOptions) {
    this.#codec = o.codec ?? jsonPaymentEventCodec;
  }

  async claimDue(limit: number, owner: string, leaseMs: number): Promise<ConfirmJob[]> {
    if (!isPositiveInt(limit)) throw new RangeError(`limit은 1 이상의 정수다: ${String(limit)}`);
    if (!isPositiveInt(leaseMs)) throw new RangeError(`leaseMs는 1 이상의 정수다: ${String(leaseMs)}`);
    if (owner === '') throw new RangeError('owner가 빈 글이다');
    const now = this.o.clock.now();
    const at = new Date(now);
    const leaseUntilMs = now + leaseMs;
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        with picked as (
          select payment_id, lease_owner from payment_confirm_job
          where next_attempt_at <= ${at}::timestamptz and (lease_until is null or lease_until < ${at}::timestamptz)
          order by next_attempt_at, payment_id
          limit ${limit}::int
          for update skip locked)
        update payment_confirm_job j
        set lease_owner = ${owner}, lease_until = ${new Date(leaseUntilMs)}::timestamptz
        from picked p
        where j.payment_id = p.payment_id
        returning j.payment_id::text as payment_id, j.attempts, j.next_attempt_at, p.lease_owner as previous_owner`),
    );
    // RETURNING의 차례는 정해지지 않아 고른 차례(next_attempt_at, 같으면 payment_id)로 다시 맞춘다
    return (r.rows as ClaimRow[])
      .sort((a, b) => msOf(a.next_attempt_at) - msOf(b.next_attempt_at) || (a.payment_id < b.payment_id ? -1 : a.payment_id > b.payment_id ? 1 : 0))
      .map((row) => ({ paymentId: row.payment_id, attempts: Number(row.attempts), owner, leaseUntilMs, hadPreviousOwner: row.previous_owner !== null }));
  }

  async read(paymentId: string): Promise<ConfirmTarget | undefined> {
    const r = await this.o.database.db.execute(sql`
      select p.id::text as id, p.order_id::text as order_id, p.event_id::text as event_id, p.attempt_no, p.pg, p.pg_payment_ref, p.amount, p.status, p.authenticated_at,
             exists (select 1 from payment_event e where e.payment_id = p.id and e.type = ${CONFIRM_SENT_EVENT_TYPE}) as confirm_sent
      from payment p where p.id = ${paymentId}::uuid`);
    const row = r.rows[0] as TargetRow | undefined;
    if (!row) return undefined;
    return {
      paymentId: row.id,
      orderId: row.order_id,
      eventId: row.event_id,
      attemptNo: Number(row.attempt_no),
      pg: row.pg as PgName,
      paymentRef: row.pg_payment_ref,
      amount: Number(row.amount),
      status: row.status as PaymentLedgerStatus,
      authenticatedAtMs: msOf(row.authenticated_at),
      confirmSent: row.confirm_sent,
    };
  }

  async markSent(job: ConfirmJob): Promise<MarkConfirmSentResult> {
    return this.#tx(async (tx) => {
      if ((await lockStatus(tx, job.paymentId)) !== 'ACCEPTED') return 'STALE';
      const own = await tx.execute(sql`select payment_id from payment_confirm_job where payment_id = ${job.paymentId}::uuid and ${ownLease(job)} for update`);
      if (own.rows.length === 0) return 'LEASE_LOST';
      const sent = await tx.execute(sql`select 1 from payment_event where payment_id = ${job.paymentId}::uuid and type = ${CONFIRM_SENT_EVENT_TYPE} limit 1`);
      if (sent.rows.length > 0) return 'ALREADY';
      const seq = await nextSeq(tx, job.paymentId);
      await tx.execute(sql`
        insert into payment_event (payment_id, seq, event_key, type, exported, occurred_at)
        values (${job.paymentId}::uuid, ${seq}, ${paymentEventKey(job.paymentId, seq)}::uuid, ${CONFIRM_SENT_EVENT_TYPE}, false, ${new Date(this.o.clock.now())}::timestamptz)`);
      return 'MARKED';
    });
  }

  async finish(target: ConfirmTarget, finish: ConfirmFinish): Promise<FinishConfirmResult> {
    return this.#tx(async (tx) => {
      if ((await lockStatus(tx, target.paymentId)) !== 'ACCEPTED') {
        await tx.execute(sql`delete from payment_confirm_job where payment_id = ${target.paymentId}::uuid`);
        return 'STALE';
      }
      const message = await this.#recordResult(tx, target, finish, this.o.clock.now());
      await tx.execute(sql`delete from payment_confirm_job where payment_id = ${target.paymentId}::uuid`);
      // Outbox는 트랜잭션의 마지막 문장이다(ADR-0116 결정 3)
      await writeOutbox(tx, this.o.clock, [{ topic: TRADE_PAYMENTS_TOPIC, key: target.eventId, payload: this.#codec.encode(message) }]);
      return 'APPLIED';
    });
  }

  /**
   * 답 반영의 공통 몫(payment 행 잠금을 쥔 뒤): 다음 순번으로 수출 사건을 쓰고 원장을 바꾼다. 승인 실행기의 finish와 UNKNOWN 해소의 resolve가 함께 쓴다.
   * @returns trade.payments 값(Outbox는 부른 쪽이 트랜잭션의 마지막 문장으로 쓴다)
   */
  async #recordResult(tx: DbTransaction, target: BuildPaymentEventInput['target'], finish: ConfirmFinish, now: number): Promise<PaymentEventMessage> {
    const seq = await nextSeq(tx, target.paymentId);
    const message = buildPaymentEvent({ target, finish, seq, nowMs: now });
    await tx.execute(sql`
      insert into payment_event (payment_id, seq, event_key, type, exported, occurred_at)
      values (${target.paymentId}::uuid, ${seq}, ${message.eventKey}::uuid, ${finish.status}, true, ${new Date(message.occurredAt)}::timestamptz)`);
    const approvedAt = finish.status === 'APPROVED' ? new Date(finish.approvedAtMs) : null;
    const failureCategory = finish.status === 'FAILED' ? finish.failureCategory : null;
    // 결과가 정해졌을 때만 포트원 토큰을 지운다(UNKNOWN은 조회·재확인이 끝날 때까지 남긴다)
    const clearToken = finish.status !== 'UNKNOWN';
    // UNKNOWN으로 쓰는 전이가 첫 단독 조회 시각을 함께 쓰고, UNKNOWN을 떠나는 전이가 비운다(BUILD_ORDER PRF-182)
    const nextQueryAt = finish.status === 'UNKNOWN' ? new Date(now + UNKNOWN_QUERY_BASE_MS) : null;
    await tx.execute(sql`
      update payment
      set status = ${finish.status}, status_changed_at = ${new Date(now)}::timestamptz,
          approved_at = ${approvedAt}::timestamptz, failure_category = ${failureCategory},
          pg_confirm_token = case when ${clearToken}::boolean then null else pg_confirm_token end,
          next_query_at = ${nextQueryAt}::timestamptz
      where id = ${target.paymentId}::uuid`);
    return message;
  }

  async reschedule(job: ConfirmJob, nextAtMs: number, o: { readonly countRetry: boolean }): Promise<boolean> {
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        update payment_confirm_job set next_attempt_at = ${new Date(nextAtMs)}::timestamptz, lease_owner = null, lease_until = null, attempts = attempts + ${o.countRetry ? 1 : 0}::int
        where payment_id = ${job.paymentId}::uuid and ${ownLease(job)}
        returning payment_id`),
    );
    return r.rows.length > 0;
  }

  async dropJob(job: ConfirmJob): Promise<boolean> {
    const r = await this.#tx((tx) => tx.execute(sql`delete from payment_confirm_job where payment_id = ${job.paymentId}::uuid and ${ownLease(job)} returning payment_id`));
    return r.rows.length > 0;
  }

  async release(job: ConfirmJob): Promise<boolean> {
    const r = await this.#tx((tx) =>
      tx.execute(sql`update payment_confirm_job set lease_owner = null, lease_until = null where payment_id = ${job.paymentId}::uuid and ${ownLease(job)} returning payment_id`),
    );
    return r.rows.length > 0;
  }

  async claimDueQueries(limit: number): Promise<UnknownQueryJob[]> {
    if (!isPositiveInt(limit)) throw new RangeError(`limit은 1 이상의 정수다: ${String(limit)}`);
    const now = this.o.clock.now();
    return this.#tx(async (tx) => {
      // 'UNKNOWN'은 부분 인덱스 조건과 맞도록 값 자리가 아니라 문장에 그대로 적는다. RETURNING 차례가 정해지지 않아 고르기와 밀기를 나눈다(고른 차례를 지키고 간격 식은 도메인 하나다)
      const r = await tx.execute(sql`
        select id::text as id, order_id::text as order_id, event_id::text as event_id, attempt_no, pg, pg_payment_ref, amount, anomaly_logged_at, query_attempts
        from payment
        where status = 'UNKNOWN' and next_query_at <= ${new Date(now)}::timestamptz
        order by next_query_at
        limit ${limit}::int
        for update skip locked`);
      const rows = r.rows as QueryRow[];
      if (rows.length === 0) return [];
      const jobs = rows.map((row): UnknownQueryJob => {
        const queryAttempts = Number(row.query_attempts) + 1;
        return {
          paymentId: row.id,
          orderId: row.order_id,
          eventId: row.event_id,
          attemptNo: Number(row.attempt_no),
          pg: row.pg as PgName,
          paymentRef: row.pg_payment_ref,
          amount: Number(row.amount),
          queryAttempts,
          claimedNextQueryAtMs: now + unknownQueryClaimHoldMs(queryAttempts),
          anomalyLogged: row.anomaly_logged_at !== null,
        };
      });
      const ids = jobs.map((j) => j.paymentId);
      const nextAts = jobs.map((j) => new Date(j.claimedNextQueryAtMs).toISOString());
      await tx.execute(sql`
        update payment p
        set next_query_at = v.next_at, query_attempts = p.query_attempts + 1
        from unnest(${sql.param(ids)}::uuid[], ${sql.param(nextAts)}::timestamptz[]) as v(id, next_at)
        where p.id = v.id`);
      return jobs;
    });
  }

  async rescheduleQuery(job: UnknownQueryJob, nextAtMs: number): Promise<boolean> {
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        update payment set next_query_at = ${new Date(nextAtMs)}::timestamptz
        where id = ${job.paymentId}::uuid and status = 'UNKNOWN' and next_query_at = ${new Date(job.claimedNextQueryAtMs)}::timestamptz
        returning id`),
    );
    return r.rows.length > 0;
  }

  async markAnomalyLogged(job: UnknownQueryJob): Promise<boolean> {
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        update payment set anomaly_logged_at = ${new Date(this.o.clock.now())}::timestamptz
        where id = ${job.paymentId}::uuid and status = 'UNKNOWN' and anomaly_logged_at is null
        returning id`),
    );
    return r.rows.length > 0;
  }

  async markOverdueBatch(limit: number): Promise<string[]> {
    if (!isPositiveInt(limit)) throw new RangeError(`limit은 1 이상의 정수다: ${String(limit)}`);
    const now = this.o.clock.now();
    const r = await this.#tx((tx) =>
      // 'UNKNOWN'은 부분 인덱스 조건과 맞도록 값 자리가 아니라 문장에 그대로 적는다. 잠긴 행을 건너뛰고 overdue_at IS NULL을 보므로 두 파드가 겹쳐도 행마다 한 번이다
      tx.execute(sql`
        with picked as (
          select id from payment
          where status = 'UNKNOWN' and status_changed_at < ${new Date(now - UNKNOWN_OVERDUE_MS)}::timestamptz and overdue_at is null
          order by status_changed_at
          limit ${limit}::int
          for update skip locked)
        update payment p set overdue_at = ${new Date(now)}::timestamptz
        from picked
        where p.id = picked.id
        returning p.order_id::text as order_id`),
    );
    return (r.rows as { order_id: string }[]).map((row) => row.order_id);
  }

  async resolve(job: UnknownQueryJob, finish: ResolvedFinish): Promise<ResolveUnknownResult> {
    return this.#tx(async (tx) => {
      if ((await lockStatus(tx, job.paymentId)) !== 'UNKNOWN') return 'STALE';
      const now = this.o.clock.now();
      const message = await this.#recordResult(tx, job, finish, now);
      // 결과 사건 뒤의 순번으로 해소 기록을 남긴다(ADR-0073. 결과 당기기와 주문 쪽 처리기는 RESOLVED를 결과로 보지 않는다)
      const resolved = buildResolvedEvent(job.paymentId, message, message.eventSeq + 1, now);
      await tx.execute(sql`
        insert into payment_event (payment_id, seq, event_key, type, exported, occurred_at)
        values (${job.paymentId}::uuid, ${resolved.eventSeq}, ${resolved.eventKey}::uuid, ${RESOLVED_EVENT_TYPE}, true, ${new Date(now)}::timestamptz)`);
      // Outbox는 트랜잭션의 마지막 문장이다(ADR-0116 결정 3)
      await writeOutbox(
        tx,
        this.o.clock,
        [message, resolved].map((m) => ({ topic: TRADE_PAYMENTS_TOPIC, key: job.eventId, payload: this.#codec.encode(m) })),
      );
      return 'APPLIED';
    });
  }

  /** 트랜잭션 하나(READ COMMITTED, 문장 시간 한도 5초 [가정]) */
  #tx<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return this.o.database.transaction(fn, TX);
  }
}
