// 새 결제 일시 정지 행과 시험 재개 행(docs/data.md §2, ADR-0105, docs/features/payment.md §2 '새 결제 일시 정지 읽기의 첫 구현'·'정지 판정자의 첫 구현', BUILD_ORDER PRF-201·PRF-202).
// 읽기(EntryPauseReader·EntryTrialReader)는 핫패스 풀이고 쓰기 인스턴스를 본다. 판정자·해제(EntryPauseStore)와 시험 결과(EntryTrialResults)는 main.ts가 다른 풀로 만든 인스턴스를 쓴다.
import { type BatchDeleteOptions, type Clock, type Database, deleteInBatches, type MaintenanceTask, type RetentionResult } from '@peaket/platform';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import type { EntryPauseReason, EntryPauses, EntryPauseRow, EntryPauseStage } from '../../domain/entry-pause.js';
import { ENTRY_TRIAL_RETENTION_MS, type EntryPauseRecord, type EntryPauseWrite, type EntryTrialFirstResult, type EntryTrialRow } from '../../domain/entry-pause-judge.js';
import type { PgName } from '../../domain/payment-gateway.js';
import type { CallBudget, EntryPauseReader, EntryPauseStore, EntryTrialResults, EntryTrialStore } from '../../domain/ports.js';
import { armStatementLimit } from './drizzle-payment-store.js';
import { paymentEntryPause, paymentEntryTrial } from './schema.js';

/** 정지 행 읽기 문장 시간 한도 상한 150ms [가정](선택 읽기와 같다, docs/data.md §5.1) */
export const ENTRY_PAUSE_STATEMENT_TIMEOUT_MS = 150;

/** 판정자·해제의 읽기·쓰기 문장 시간 한도 400ms [가정](일반 풀, 틱당 한두 문장이다) */
export const ENTRY_PAUSE_JUDGE_STATEMENT_TIMEOUT_MS = 400;
/** 첫 호출 시작 시각 쓰기의 문장 시간 한도 100ms [가정](승인 호출을 늦추지 않게 짧게 한다, BUILD_ORDER PRF-202 코드 리뷰) */
export const ENTRY_TRIAL_FIRST_CALL_STATEMENT_TIMEOUT_MS = 100;
/** 시험 행 지우기 한 번의 묶음 1,000건 [가정](행이 많지 않다) */
const ENTRY_TRIAL_DELETE_BATCH = 1_000;
/** 정비 일의 이름 */
export const ENTRY_TRIAL_DELETE_TASK = 'payment-entry-trial-delete';

/**
 * admitted_at이 7일 [가정] 지난 시험 행을 나눠 지운다(BUILD_ORDER PRF-200 코드 리뷰, PRF-202). 표가 작아 인덱스를 따로 두지 않는다.
 * @returns 지운 행 수와 멈춘 까닭(정비 시간 끝이면 window)
 */
export async function deleteExpiredEntryTrials(database: Database, o: BatchDeleteOptions & { readonly clock: Clock; readonly retentionMs?: number }): Promise<RetentionResult> {
  const before = new Date(o.clock.now() - (o.retentionMs ?? ENTRY_TRIAL_RETENTION_MS));
  const { clock, batchSize = ENTRY_TRIAL_DELETE_BATCH, ...pacing } = o;
  return deleteInBatches(
    clock,
    async (batch) => {
      const r = await database.db.execute(sql`
        delete from payment_entry_trial
        where admitted_at <= ${before}::timestamptz and order_id in (
          select order_id from payment_entry_trial where admitted_at <= ${before}::timestamptz limit ${batch}::int)`);
      return r.rowCount ?? 0;
    },
    { ...pacing, batchSize },
  );
}

/** 정비 일 payment-entry-trial-delete(정비 시간, 서비스 역할 DB). 다 못 지우고 멈추면 실패로 남겨 다음 깨어남에 이어 한다 */
export function entryTrialsDeleteTask(database: Database, clock: Clock): MaintenanceTask {
  return {
    name: ENTRY_TRIAL_DELETE_TASK,
    when: 'window',
    run: async (signal) => {
      const r = await deleteExpiredEntryTrials(database, { clock, signal });
      if (r.stopped === 'window' || r.stopped === 'guard') throw new Error(`시험 재개 행 지우기를 멈췄다(${r.stopped}), 지운 ${r.deleted}건`);
      return r;
    },
  };
}

type RecordRow = { stage: string; reason: string; actor: string; since: Date; trial_started_at: Date | null; reopened_at: Date | null; version: string | number };
type TrialRow = { first_result: string | null; first_call_ms: number | null; first_call_at: Date };

export class DrizzleEntryPause implements EntryPauseReader, EntryTrialStore, EntryPauseStore, EntryTrialResults {
  constructor(private readonly o: { readonly database: Database }) {}

  /** channel = 'ALL' 행을 모두 읽는다(결제사 셋이라 행이 많지 않다). 채널별 정지를 쓰는 단계가 조건을 푼다 */
  async read(budget?: CallBudget): Promise<EntryPauses> {
    const startedAt = performance.now();
    const rows = await this.o.database.transaction(async (tx) => {
      await armStatementLimit(tx, ENTRY_PAUSE_STATEMENT_TIMEOUT_MS, budget, startedAt);
      return tx
        .select({ pg: paymentEntryPause.pg, stage: paymentEntryPause.stage, reason: paymentEntryPause.reason, actor: paymentEntryPause.actor, since: paymentEntryPause.since, reopenedAt: paymentEntryPause.reopenedAt, version: paymentEntryPause.version })
        .from(paymentEntryPause)
        .where(eq(paymentEntryPause.channel, 'ALL'));
    });
    const pauses = new Map<PgName, EntryPauseRow>();
    for (const row of rows) {
      const pg = row.pg as PgName;
      pauses.set(pg, { pg, stage: row.stage as EntryPauseStage, reason: row.reason as EntryPauseReason, actor: row.actor, sinceMs: row.since.getTime(), ...(row.reopenedAt === null ? {} : { reopenedAtMs: row.reopenedAt.getTime() }), version: row.version });
    }
    return pauses;
  }

  /** 이번 시험 재개로 받은 주문만 참이다: admitted_at >= 정지 행의 trial_started_at(앞 시험의 행은 지워지기 전까지 남는다. 시작 시각이 비면 조건이 NULL이라 거짓이다, BUILD_ORDER PRF-201 코드 리뷰) */
  async isAdmitted(orderId: string, pg: PgName, budget?: CallBudget): Promise<boolean> {
    const startedAt = performance.now();
    const rows = await this.o.database.transaction(async (tx) => {
      await armStatementLimit(tx, ENTRY_PAUSE_STATEMENT_TIMEOUT_MS, budget, startedAt);
      return tx
        .select({ orderId: paymentEntryTrial.orderId })
        .from(paymentEntryTrial)
        .innerJoin(paymentEntryPause, and(eq(paymentEntryPause.pg, paymentEntryTrial.pg), eq(paymentEntryPause.channel, 'ALL')))
        .where(and(eq(paymentEntryTrial.orderId, orderId), eq(paymentEntryTrial.pg, pg), gte(paymentEntryTrial.admittedAt, paymentEntryPause.trialStartedAt)))
        .limit(1);
    });
    return rows.length > 0;
  }

  /** 앞 시험의 행이 남아 있으면 이번 시험의 값으로 덮어쓴다(그대로 두면 받았는데 이번 시험에 세이지 않는다). 이번 시험의 행은 건드리지 않는다 */
  async admit(orderId: string, pg: PgName, nowMs: number, budget?: CallBudget): Promise<void> {
    const startedAt = performance.now();
    await this.o.database.transaction(async (tx) => {
      await armStatementLimit(tx, ENTRY_PAUSE_STATEMENT_TIMEOUT_MS, budget, startedAt);
      await tx.execute(sql`
        insert into payment_entry_trial (order_id, pg, admitted_at) values (${orderId}::uuid, ${pg}, ${new Date(nowMs)}::timestamptz)
        on conflict (order_id) do update set pg = excluded.pg, admitted_at = excluded.admitted_at, first_result = null, first_result_at = null, first_call_ms = null, first_call_at = null
        where payment_entry_trial.admitted_at < (select trial_started_at from payment_entry_pause p where p.pg = excluded.pg and p.channel = 'ALL')`);
    });
  }

  async recordFirstCall(orderId: string, atMs: number): Promise<boolean> {
    const startedAt = performance.now();
    const updated = await this.o.database.transaction(async (tx) => {
      await armStatementLimit(tx, ENTRY_TRIAL_FIRST_CALL_STATEMENT_TIMEOUT_MS, undefined, startedAt);
      return tx
        .update(paymentEntryTrial)
        .set({ firstCallAt: new Date(atMs) })
        .where(and(eq(paymentEntryTrial.orderId, orderId), isNull(paymentEntryTrial.firstCallAt)))
        .returning({ orderId: paymentEntryTrial.orderId });
    });
    return updated.length > 0;
  }

  async recordFirstResult(orderId: string, result: { readonly firstResult: EntryTrialFirstResult; readonly atMs: number; readonly callMs: number }): Promise<boolean> {
    const startedAt = performance.now();
    const updated = await this.o.database.transaction(async (tx) => {
      await armStatementLimit(tx, ENTRY_PAUSE_JUDGE_STATEMENT_TIMEOUT_MS, undefined, startedAt);
      return tx
        .update(paymentEntryTrial)
        .set({ firstResult: result.firstResult, firstResultAt: new Date(result.atMs), firstCallMs: result.callMs })
        .where(and(eq(paymentEntryTrial.orderId, orderId), isNull(paymentEntryTrial.firstResult)))
        .returning({ orderId: paymentEntryTrial.orderId });
    });
    return updated.length > 0;
  }

  async readRecord(pg: PgName): Promise<EntryPauseRecord | undefined> {
    const startedAt = performance.now();
    const r = await this.o.database.transaction(async (tx) => {
      await armStatementLimit(tx, ENTRY_PAUSE_JUDGE_STATEMENT_TIMEOUT_MS, undefined, startedAt);
      return tx.execute(sql`select stage, reason, actor, since, trial_started_at, reopened_at, version from payment_entry_pause where pg = ${pg} and channel = 'ALL'`);
    });
    const row = r.rows[0] as RecordRow | undefined;
    if (row === undefined) return undefined;
    return {
      pg,
      stage: row.stage as EntryPauseStage,
      reason: row.reason as EntryPauseReason,
      actor: row.actor,
      sinceMs: new Date(row.since).getTime(),
      ...(row.trial_started_at === null ? {} : { trialStartedAtMs: new Date(row.trial_started_at).getTime() }),
      ...(row.reopened_at === null ? {} : { reopenedAtMs: new Date(row.reopened_at).getTime() }),
      version: Number(row.version),
    };
  }

  /** 첫 쓰기는 판 번호 1의 INSERT(겨루면 0행), 그 뒤는 읽은 판 번호 조건의 UPDATE다 */
  async write(previous: EntryPauseRecord | undefined, next: EntryPauseWrite): Promise<boolean> {
    const startedAt = performance.now();
    const since = new Date(next.sinceMs);
    const trialStartedAt = next.trialStartedAtMs === undefined ? null : new Date(next.trialStartedAtMs);
    const reopenedAt = next.reopenedAtMs === undefined ? null : new Date(next.reopenedAtMs);
    const r = await this.o.database.transaction(async (tx) => {
      await armStatementLimit(tx, ENTRY_PAUSE_JUDGE_STATEMENT_TIMEOUT_MS, undefined, startedAt);
      if (previous === undefined) {
        return tx.execute(sql`
          insert into payment_entry_pause (pg, channel, stage, reason, actor, since, trial_started_at, reopened_at, version)
          values (${next.pg}, 'ALL', ${next.stage}, ${next.reason}, ${next.actor}, ${since}::timestamptz, ${trialStartedAt}::timestamptz, ${reopenedAt}::timestamptz, 1)
          on conflict (pg, channel) do nothing`);
      }
      return tx.execute(sql`
        update payment_entry_pause set stage = ${next.stage}, reason = ${next.reason}, actor = ${next.actor}, since = ${since}::timestamptz, trial_started_at = ${trialStartedAt}::timestamptz, reopened_at = ${reopenedAt}::timestamptz, version = version + 1
        where pg = ${next.pg} and channel = 'ALL' and version = ${previous.version}`);
    });
    return (r.rowCount ?? 0) > 0;
  }

  async readTrialResults(pg: PgName, trialStartedAtMs: number, limit: number): Promise<EntryTrialRow[]> {
    const startedAt = performance.now();
    const r = await this.o.database.transaction(async (tx) => {
      await armStatementLimit(tx, ENTRY_PAUSE_JUDGE_STATEMENT_TIMEOUT_MS, undefined, startedAt);
      return tx.execute(sql`
        select first_result, first_call_ms, first_call_at from payment_entry_trial
        where pg = ${pg} and first_call_at >= ${new Date(trialStartedAtMs)}::timestamptz
        order by first_call_at, order_id
        limit ${limit}::int`);
    });
    return (r.rows as TrialRow[]).map((row) => ({
      firstCallAtMs: new Date(row.first_call_at).getTime(),
      ...(row.first_result === null ? {} : { firstResult: row.first_result as EntryTrialFirstResult }),
      ...(row.first_call_ms === null ? {} : { firstCallMs: Number(row.first_call_ms) }),
    }));
  }

  async countWaitingConfirms(pg: PgName, nowMs: number, cap: number): Promise<number> {
    const startedAt = performance.now();
    const at = new Date(nowMs);
    const r = await this.o.database.transaction(async (tx) => {
      await armStatementLimit(tx, ENTRY_PAUSE_JUDGE_STATEMENT_TIMEOUT_MS, undefined, startedAt);
      return tx.execute(sql`
        select count(*)::int as waiting from (
          select 1 from payment_confirm_job
          where pg = ${pg} and next_attempt_at <= ${at}::timestamptz and (lease_until is null or lease_until < ${at}::timestamptz)
          limit ${cap}::int) s`);
    });
    return Number((r.rows[0] as { waiting: number | string } | undefined)?.waiting ?? 0);
  }
}
