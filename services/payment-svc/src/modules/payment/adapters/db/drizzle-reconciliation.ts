// 대사 저장소의 payment DB 쪽(docs/data.md §5·§5.1 대사 줄, docs/features/payment.md §8 '대사의 첫 구현', BUILD_ORDER HOT-153). 메서드의 약속은 domain/ports.ts PaymentReconciliationStore에 있다.
// '지금'은 앱 시계다. SQL now()를 쓰지 않는다. 운영은 릴레이 프로세스의 서비스 역할 풀을 넘긴다(원장·Outbox를 쓴다, 코드 리뷰 M14).
// 모든 문장은 문장 시간 한도가 걸린 트랜잭션 안에서 돈다(코드 리뷰 M12). 실행의 쓰기는 세대를 조건으로 하고, 작업 표 읽기도 같은 문장에서 세대를 본다(코드 리뷰 H1).
import { type Clock, type Database, type DbTransaction, deleteInBatches, type MaintenanceTask, uuidv7 } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { CONFIRM_RUNNER_STATEMENT_TIMEOUT_MS } from '../../domain/confirm-runner.js';
import type { PaymentLedgerStatus } from '../../domain/confirm-command.js';
import type { PgName, QueryStatus } from '../../domain/payment-gateway.js';
import { PG_NAMES } from '../../domain/pg-call-guard.js';
import type { PaymentReconciliationStore, ReconCompareRow, ReconDiffInput, ReconLedgerRow, ReconRun, ReconSeenInput } from '../../domain/ports.js';
import { DEPOSIT_HASH_DELETE_TASK, DEPOSIT_SECRET_HASH_DELETE_BATCH, DEPOSIT_SECRET_HASH_RETENTION_MS, RECON_SEEN_DELETE_TASK, type ReconDiffKind, type ReconRunRef, ReconRunLostError, type ReconStage, reconRangeOf, RECON_SEEN_DELETE_BATCH, reconWindowDates } from '../../domain/reconciliation.js';

export interface DrizzleReconciliationOptions {
  readonly database: Database;
  readonly clock: Clock;
}

const TX = { isolationLevel: 'read committed', statementTimeoutMs: CONFIRM_RUNNER_STATEMENT_TIMEOUT_MS } as const;
/** 기간을 넘겨 끝내지 못한 날을 한 번에 돌려주는 수 31개 [가정] */
const OVERDUE_DATES_LIMIT = 31;

const msOf = (v: Date | string): number => new Date(v).getTime();

type RunRow = { id: string; generation: number | string; stage: string; pg_cursor: string | null; compare_after: string | null; ledger_after_at: Date | string | null; ledger_after_id: string | null; listed_count: number | string; matched_count: number | string; mismatch_count: number | string };
type CompareRow = {
  payment_ref: string;
  order_ref: string;
  pg_status: string;
  amount: number | string;
  id: string | null;
  order_id: string | null;
  event_id: string | null;
  attempt_no: number | string | null;
  ledger_pg: string | null;
  ledger_ref: string | null;
  ledger_amount: number | string | null;
  ledger_status: string | null;
  pg_tx_id: string | null;
  status_changed_at: Date | string | null;
};
type LedgerRow = { id: string; order_id: string; event_id: string; attempt_no: number | string; pg: string; pg_payment_ref: string; pg_tx_id: string | null; amount: number | string; status: string; approved_at: Date | string; seen: boolean };

/** 이 실행의 세대가 그대로인가(작업 표를 읽는 문장의 조건) */
const ownsRun = (run: ReconRun) => sql`exists (select 1 from reconciliation_run r where r.id = ${run.id}::uuid and r.generation = ${run.generation}::int)`;

export class DrizzleReconciliation implements PaymentReconciliationStore {
  constructor(private readonly o: DrizzleReconciliationOptions) {}

  /** 트랜잭션 하나(READ COMMITTED, 문장 시간 한도 5초 [가정]) */
  #tx<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return this.o.database.transaction(fn, TX);
  }

  /** 세대 조건으로 실행 행을 고친다. 0행이면 다른 실행이 이어 받은 것이다 */
  async #fenced(tx: DbTransaction, run: ReconRun, set: ReturnType<typeof sql>): Promise<void> {
    const r = await tx.execute(sql`update reconciliation_run set ${set} where id = ${run.id}::uuid and generation = ${run.generation}::int returning id`);
    if (r.rows.length === 0) throw new ReconRunLostError();
  }

  async pendingDates(pg: PgName, fromDate: string): Promise<ReconRunRef[]> {
    const r = await this.#tx((tx) => tx.execute(sql`select recon_date::text as recon_date, status, finished_at from reconciliation_run where pg = ${pg} and recon_date >= ${fromDate}::date`));
    return (r.rows as { recon_date: string; status: ReconRunRef['status']; finished_at: Date | string | null }[]).map((row) => ({ date: row.recon_date, status: row.status, ...(row.finished_at === null ? {} : { finishedAtMs: msOf(row.finished_at) }) }));
  }

  async overdueDates(pg: PgName, fromDate: string): Promise<string[]> {
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        select d.day::date::text as recon_date
        from (select min(recon_date) as first_date from reconciliation_run where pg = ${pg}) b
        cross join lateral generate_series(b.first_date::timestamp, (${fromDate}::date - 1)::timestamp, interval '1 day') as d(day)
        left join reconciliation_run r on r.pg = ${pg} and r.recon_date = d.day::date
        where r.id is null or r.status <> 'DONE'
        order by d.day
        limit ${OVERDUE_DATES_LIMIT}::int`),
    );
    return (r.rows as { recon_date: string }[]).map((row) => row.recon_date);
  }

  async beginRun(pg: PgName, date: string, nowMs: number, owner: string): Promise<ReconRun | undefined> {
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        insert into reconciliation_run (id, pg, recon_date, status, stage, owner, generation, started_at)
        values (${uuidv7(this.o.clock)}::uuid, ${pg}, ${date}::date, 'RUNNING', 'LISTING', ${owner}, 1, ${new Date(nowMs)}::timestamptz)
        on conflict (pg, recon_date) do update set status = 'RUNNING', finished_at = null, owner = excluded.owner, generation = reconciliation_run.generation + 1
        where reconciliation_run.status <> 'DONE'
        returning id::text as id, generation, stage, pg_cursor, compare_after, ledger_after_at, ledger_after_id::text as ledger_after_id, listed_count, matched_count, mismatch_count`),
    );
    const row = r.rows[0] as RunRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      pg,
      date,
      generation: Number(row.generation),
      stage: row.stage as ReconStage,
      ...(row.pg_cursor === null ? {} : { pgCursor: row.pg_cursor }),
      ...(row.compare_after === null ? {} : { compareAfter: row.compare_after }),
      ...(row.ledger_after_at === null || row.ledger_after_id === null ? {} : { ledgerAfter: { atMs: msOf(row.ledger_after_at), id: row.ledger_after_id } }),
      listedCount: Number(row.listed_count),
      matchedCount: Number(row.matched_count),
      mismatchCount: Number(row.mismatch_count),
    };
  }

  async saveListedPage(run: ReconRun, items: readonly ReconSeenInput[], nextCursor: string | undefined, listed: number, mismatched = 0): Promise<void> {
    const { fromMs, toMs } = reconRangeOf(run.date);
    const from = new Date(fromMs);
    const to = new Date(toMs);
    const rank = (at: ReturnType<typeof sql>) => sql`(case when ${at} >= ${from}::timestamptz and ${at} < ${to}::timestamptz then 1 else 0 end, ${at})`;
    await this.#tx(async (tx) => {
      // 세대를 먼저 본다(실행 행 잠금이 옛 실행의 작업 표 쓰기를 막는다)
      await this.#fenced(tx, run, sql`listed_count = listed_count + ${listed}::int, mismatch_count = mismatch_count + ${mismatched}::int, pg_cursor = ${nextCursor ?? null}, stage = case when ${nextCursor === undefined}::boolean then 'COMPARING' else stage end`);
      if (items.length === 0) return;
      await tx.execute(sql`
        insert into reconciliation_seen (run_id, payment_ref, order_ref, pg_status, amount, seen_at)
        select ${run.id}::uuid, r, o, s, a, t from unnest(${sql.param(items.map((i) => i.paymentRef))}::text[], ${sql.param(items.map((i) => i.orderRef))}::text[], ${sql.param(items.map((i) => i.pgStatus))}::text[], ${sql.param(items.map((i) => i.amount))}::int[], ${sql.param(items.map((i) => new Date(i.atMs).toISOString()))}::timestamptz[]) as v(r, o, s, a, t)
        on conflict (run_id, payment_ref) do update set order_ref = excluded.order_ref, pg_status = excluded.pg_status, amount = excluded.amount, seen_at = excluded.seen_at
        where ${rank(sql`excluded.seen_at`)} >= ${rank(sql`reconciliation_seen.seen_at`)}`);
    });
  }

  async readCompareBatch(run: ReconRun, limit: number): Promise<ReconCompareRow[]> {
    const { fromMs, toMs } = reconRangeOf(run.date);
    const after = run.compareAfter === undefined ? sql`true` : sql`s.payment_ref > ${run.compareAfter}`;
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        select s.payment_ref, s.order_ref, s.pg_status, s.amount,
               l.id::text as id, l.order_id::text as order_id, l.event_id::text as event_id, l.attempt_no, l.pg as ledger_pg, l.pg_payment_ref as ledger_ref, l.amount as ledger_amount, l.status as ledger_status, l.pg_tx_id, l.status_changed_at
        from reconciliation_seen s
        left join lateral (select p.* from payment p where p.pg = any(${sql.param([...PG_NAMES])}::text[]) and p.pg_payment_ref = s.payment_ref order by case when p.pg = ${run.pg} then 0 else 1 end limit 1) l on true
        where s.run_id = ${run.id}::uuid and ${ownsRun(run)} and ${after} and s.seen_at >= ${new Date(fromMs)}::timestamptz and s.seen_at < ${new Date(toMs)}::timestamptz
        order by s.payment_ref
        limit ${limit}::int`),
    );
    return (r.rows as CompareRow[]).map((row): ReconCompareRow => ({
      paymentRef: row.payment_ref,
      orderRef: row.order_ref,
      pgStatus: row.pg_status as QueryStatus,
      amount: Number(row.amount),
      ...(row.id === null
        ? {}
        : {
            ledger: {
              paymentId: row.id,
              orderId: row.order_id!,
              eventId: row.event_id!,
              attemptNo: Number(row.attempt_no),
              pg: row.ledger_pg as PgName,
              paymentRef: row.ledger_ref!,
              amount: Number(row.ledger_amount),
              status: row.ledger_status as PaymentLedgerStatus,
              ...(row.pg_tx_id === null ? {} : { txId: row.pg_tx_id }),
              ...(row.status_changed_at === null ? {} : { statusChangedAtMs: msOf(row.status_changed_at) }),
            },
          }),
    }));
  }

  async ledgerStatus(paymentId: string): Promise<PaymentLedgerStatus | undefined> {
    const r = await this.#tx((tx) => tx.execute(sql`select status from payment where id = ${paymentId}::uuid`));
    return (r.rows[0] as { status: PaymentLedgerStatus } | undefined)?.status;
  }

  async insertDiffs(run: ReconRun, diffs: readonly ReconDiffInput[]): Promise<ReconDiffInput[]> {
    if (diffs.length === 0) return [];
    const now = new Date(this.o.clock.now());
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        insert into reconciliation_diff (id, run_id, pg, order_ref, payment_ref, kind, ledger_status, pg_status, ledger_amount, pg_amount, state, created_at)
        select i, ${run.id}::uuid, ${run.pg}, o, p, k, ls, ps, la, pa, st, ${now}::timestamptz
        from unnest(${sql.param(diffs.map(() => uuidv7(this.o.clock)))}::uuid[], ${sql.param(diffs.map((d) => d.orderRef))}::text[], ${sql.param(diffs.map((d) => d.paymentRef))}::text[], ${sql.param(diffs.map((d) => d.kind))}::text[], ${sql.param(diffs.map((d) => d.ledgerStatus ?? null))}::text[], ${sql.param(diffs.map((d) => d.pgStatus ?? null))}::text[], ${sql.param(diffs.map((d) => d.ledgerAmount ?? null))}::int[], ${sql.param(diffs.map((d) => d.pgAmount ?? null))}::int[], ${sql.param(diffs.map((d) => d.state))}::text[]) as v(i, o, p, k, ls, ps, la, pa, st)
        on conflict (pg, payment_ref, kind) do nothing
        returning payment_ref, kind`),
    );
    const written = new Set((r.rows as { payment_ref: string; kind: string }[]).map((row) => `${row.payment_ref} ${row.kind}`));
    return diffs.filter((d) => written.has(`${d.paymentRef} ${d.kind}`));
  }

  async handOff(paymentIds: readonly string[], nowMs: number): Promise<number> {
    if (paymentIds.length === 0) return 0;
    const at = new Date(nowMs);
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        update payment set next_query_at = ${at}::timestamptz, query_touched_at = ${at}::timestamptz
        where id = any(${sql.param([...paymentIds])}::uuid[]) and status in ('UNKNOWN', 'AWAITING_DEPOSIT') and next_query_at > ${at}::timestamptz`),
    );
    return r.rowCount ?? 0;
  }

  async markClosed(pg: PgName, paymentRef: string, kind: ReconDiffKind): Promise<void> {
    await this.#tx((tx) => tx.execute(sql`update reconciliation_diff set state = 'CLOSED' where pg = ${pg} and payment_ref = ${paymentRef} and kind = ${kind}`));
  }

  async finishCompareBatch(run: ReconRun, afterRef: string | undefined, matched: number, mismatched: number): Promise<void> {
    await this.#tx((tx) =>
      this.#fenced(tx, run, sql`matched_count = matched_count + ${matched}::int, mismatch_count = mismatch_count + ${mismatched}::int, compare_after = ${afterRef ?? null}, stage = case when ${afterRef === undefined}::boolean then 'LEDGER' else stage end`),
    );
  }

  async readLedgerBatch(run: ReconRun, limit: number): Promise<ReconLedgerRow[]> {
    const { fromMs, toMs } = reconRangeOf(run.date);
    const after = run.ledgerAfter === undefined ? sql`true` : sql`(p.approved_at, p.id) > (${new Date(run.ledgerAfter.atMs)}::timestamptz, ${run.ledgerAfter.id}::uuid)`;
    // 승인 행을 먼저 잘라 읽고 그 묶음만 작업 표와 견준다(작업 표에 다 있는 긴 구간을 한 문장에서 훑어 시간 한도를 넘기지 않게, 코드 리뷰 M12)
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        with page as (
          select p.id, p.order_id, p.event_id, p.attempt_no, p.pg, p.pg_payment_ref, p.pg_tx_id, p.amount, p.status, p.approved_at
          from payment p
          where p.status = 'APPROVED' and p.pg = ${run.pg} and p.approved_at >= ${new Date(fromMs)}::timestamptz and p.approved_at < ${new Date(toMs)}::timestamptz and ${after} and ${ownsRun(run)}
          order by p.approved_at, p.id
          limit ${limit}::int)
        select page.id::text as id, page.order_id::text as order_id, page.event_id::text as event_id, page.attempt_no, page.pg, page.pg_payment_ref, page.pg_tx_id, page.amount, page.status, page.approved_at,
               exists (select 1 from reconciliation_seen s where s.run_id = ${run.id}::uuid and s.payment_ref = page.pg_payment_ref) as seen
        from page
        order by page.approved_at, page.id`),
    );
    return (r.rows as LedgerRow[]).map((row) => ({
      paymentId: row.id,
      orderId: row.order_id,
      eventId: row.event_id,
      attemptNo: Number(row.attempt_no),
      pg: row.pg as PgName,
      paymentRef: row.pg_payment_ref,
      ...(row.pg_tx_id === null ? {} : { txId: row.pg_tx_id }),
      amount: Number(row.amount),
      status: row.status as PaymentLedgerStatus,
      approvedAtMs: msOf(row.approved_at),
      seen: row.seen,
    }));
  }

  async finishLedgerBatch(run: ReconRun, after: { readonly atMs: number; readonly id: string } | undefined, mismatched: number): Promise<void> {
    await this.#tx((tx) =>
      this.#fenced(tx, run, sql`mismatch_count = mismatch_count + ${mismatched}::int, ledger_after_at = ${after === undefined ? null : new Date(after.atMs)}::timestamptz, ledger_after_id = ${after?.id ?? null}::uuid, stage = case when ${after === undefined}::boolean then 'PULLING' else stage end`),
    );
  }

  async pullUnknowns(pg: PgName, beforeMs: number, nowMs: number, limit: number): Promise<number> {
    const at = new Date(nowMs);
    // 이번 당기기가 건드렸거나 단독 조회가 그 뒤에 잡은 행은 query_touched_at이 at 이상이라 다시 고르지 않는다
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        with picked as (
          select id from payment
          where status = 'UNKNOWN' and pg = ${pg} and status_changed_at < ${new Date(beforeMs)}::timestamptz and next_query_at > ${at}::timestamptz and (query_touched_at is null or query_touched_at < ${at}::timestamptz)
          order by next_query_at
          limit ${limit}::int
          for update skip locked)
        update payment p set next_query_at = ${at}::timestamptz, query_touched_at = ${at}::timestamptz
        from picked
        where p.id = picked.id`),
    );
    return r.rowCount ?? 0;
  }

  async finishRun(run: ReconRun, status: 'DONE' | 'FAILED', nowMs: number): Promise<void> {
    await this.#tx((tx) => this.#fenced(tx, run, sql`status = ${status}, finished_at = ${new Date(nowMs)}::timestamptz`));
  }

  async clearSeen(run: ReconRun): Promise<number> {
    const result = await deleteInBatches(
      this.o.clock,
      async (batch) => {
        const r = await this.#tx((tx) => tx.execute(sql`delete from reconciliation_seen where run_id = ${run.id}::uuid and payment_ref in (select payment_ref from reconciliation_seen where run_id = ${run.id}::uuid limit ${batch}::int)`));
        return r.rowCount ?? 0;
      },
      { batchSize: RECON_SEEN_DELETE_BATCH, ignoreWindow: true },
    );
    return result.deleted;
  }
}

/** 입금 secret 해시 지우기의 입력(BUILD_ORDER HOT-153) */
export interface DepositHashDeleteOptions {
  readonly clock: Clock;
  readonly signal?: AbortSignal;
  readonly guard?: () => Promise<string | undefined>;
  readonly retentionMs?: number;
}

/**
 * 입금 확정(승인) 뒤 정해진 일수가 지난 결제의 입금 secret 해시를 나눠 비운다(플랫폼 deleteInBatches 규칙, docs/data.md §5.1). 회차 끝 시각을 payment-svc가 몰라 입금 확정 시각으로 대신한다.
 * @returns 비운 행 수와 멈춘 까닭(정비 시간 끝이면 window)
 */
export async function deleteExpiredDepositHashes(database: Database, o: DepositHashDeleteOptions) {
  const before = new Date(o.clock.now() - (o.retentionMs ?? DEPOSIT_SECRET_HASH_RETENTION_MS));
  return deleteInBatches(
    o.clock,
    async (batch) => {
      const r = await database.transaction(
        (tx) =>
          tx.execute(sql`
        update payment set deposit_secret_hash = null
        where id in (select id from payment where deposit_secret_hash is not null and approved_at <= ${before}::timestamptz order by approved_at limit ${batch}::int for update skip locked)`),
        TX,
      );
      return r.rowCount ?? 0;
    },
    { batchSize: DEPOSIT_SECRET_HASH_DELETE_BATCH, signal: o.signal, guard: o.guard },
  );
}

/** 정비 일 deposit-secret-hash-delete(정비 시간). 다 못 비우고 멈추면 실패로 남겨 다음 깨어남에 이어 한다 */
export function depositSecretHashDeleteTask(database: Database, clock: Clock): MaintenanceTask {
  return {
    name: DEPOSIT_HASH_DELETE_TASK,
    when: 'window',
    run: async (signal) => {
      const r = await deleteExpiredDepositHashes(database, { clock, signal });
      if (r.stopped === 'window' || r.stopped === 'guard') throw new Error(`입금 secret 해시 지우기를 멈췄다(${r.stopped}${r.reason ? `: ${r.reason}` : ''}), 지운 ${r.deleted}건`);
      return r;
    },
  };
}

/**
 * 끝난 실행의 작업 표 행을 나눠 지운다(BUILD_ORDER HOT-153 코드 리뷰 M8): DONE 실행과, 되돌아보는 기간을 넘겨 다시 돌 일이 없는 실행(FAILED·RUNNING)이다. 이어 할 실행의 행은 남긴다.
 * @returns 지운 행 수와 멈춘 까닭(정비 시간 끝이면 window)
 */
export async function deleteFinishedReconSeen(database: Database, o: { readonly clock: Clock; readonly signal?: AbortSignal }) {
  const windowStart = reconWindowDates(o.clock.now())[0]!;
  return deleteInBatches(
    o.clock,
    async (batch) => {
      const r = await database.transaction(
        (tx) =>
          tx.execute(sql`
        delete from reconciliation_seen s
        using (
          select x.run_id, x.payment_ref from reconciliation_seen x
          join reconciliation_run r on r.id = x.run_id
          where r.status = 'DONE' or r.recon_date < ${windowStart}::date
          limit ${batch}::int) d
        where s.run_id = d.run_id and s.payment_ref = d.payment_ref`),
        TX,
      );
      return r.rowCount ?? 0;
    },
    { batchSize: RECON_SEEN_DELETE_BATCH, signal: o.signal },
  );
}

/** 정비 일 reconciliation-seen-delete(정비 시간). 다 못 지우고 멈추면 실패로 남겨 다음 깨어남에 이어 한다 */
export function reconSeenDeleteTask(database: Database, clock: Clock): MaintenanceTask {
  return {
    name: RECON_SEEN_DELETE_TASK,
    when: 'window',
    run: async (signal) => {
      const r = await deleteFinishedReconSeen(database, { clock, signal });
      if (r.stopped === 'window' || r.stopped === 'guard') throw new Error(`대사 작업 표 지우기를 멈췄다(${r.stopped}), 지운 ${r.deleted}건`);
      return r;
    },
  };
}
