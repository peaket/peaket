// CS 처리함 건의 PostgreSQL 구현(ops 0000·0030·0032, docs/data.md cs_case·cs_case_request).
// 열린 (kind, target_ref) 하나는 부분 유일 인덱스 cs_case_open_key가, 같은 eventKey 한 번은 cs_case_request 기본 키가 지킨다(ADR-0364 결정 4).
// next_due_at은 두 기한 중 이른 것의 생성 열('infinity' 포함)이라 앱은 읽지 않고 두 기한에서 다시 센다. 갱신은 판(version) 조건부이고 감사를 같은 트랜잭션에 쓴다.
// 추가 검증 이의(F-06-7, ops 0031, docs/data.md verification_case·cs_case_dispatch·§5.1 'CS 처리함 보낼 호출' 행):
// 건을 처음 열 때 같은 트랜잭션에 이의 행과 보낼 호출 둘을 넣고, 결정은 건 해결·이의 결과·보낼 호출·감사·멱등 기록을 한 트랜잭션에 쓴다.
// 보낼 호출은 앱 시계 값($now)으로 FOR UPDATE SKIP LOCKED로 잡고 claimed_until을 30초 [가정] 뒤로 둔다(DB now()를 쓰지 않는다).
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, IdempotencyStore, systemClock, type Database, type DbTransaction } from '@peaket/platform';
import { sql, type SQL } from 'drizzle-orm';
import { appendAuditIn, type AuditRecord } from '../../../audit/index.js';
import type { CsCase, CsCaseKind, CsCaseListQuery, CsCaseOpenInput, CsCaseReceiveResult, CsCaseStatus, CsCaseStore } from '../../domain/cs-case.js';
import {
  VERIFICATION_APPEAL_KIND,
  type AppealContent,
  type AppealDecisionResult,
  type AppealDecisionWrite,
  type AppealOutcome,
  type BlockListChange,
  type CsAppealStore,
  type CsCaseDispatchRow,
  type DispatchCall,
  type DispatchState,
  type VerificationCase,
  type VerificationCaseStatus,
} from '../../domain/verification-appeal.js';

interface Row {
  id: string;
  kind: string;
  target_ref: string;
  status: string;
  category: string;
  progress_due_at: Date | string | null;
  result_due_at: Date | string | null;
  assignee: string | null;
  version: string | number;
  result_note: string | null;
  resolved_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  due_soon_alerted_for: Date | string | null;
  overdue_alerted_for: Date | string | null;
  detail: string | null;
}

const COLUMNS = sql`id, kind, target_ref, status, category, progress_due_at, result_due_at, assignee, version, result_note, resolved_at, created_at, updated_at, due_soon_alerted_for, overdue_alerted_for, detail`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const msOf = (v: Date | string | null): number | null => (v === null ? null : new Date(v).getTime());
const toCase = (r: Row): CsCase => ({
  caseId: r.id,
  kind: r.kind as CsCaseKind,
  targetRef: r.target_ref,
  status: r.status as CsCaseStatus,
  createdAtMs: new Date(r.created_at).getTime(),
  category: r.category,
  progressDueAtMs: msOf(r.progress_due_at),
  resultDueAtMs: msOf(r.result_due_at),
  assignee: r.assignee,
  version: Number(r.version),
  resultNote: r.result_note,
  resolvedAtMs: msOf(r.resolved_at),
  updatedAtMs: new Date(r.updated_at).getTime(),
  dueSoonAlertedForMs: msOf(r.due_soon_alerted_for),
  overdueAlertedForMs: msOf(r.overdue_alerted_for),
  detail: r.detail ?? null,
});
const ts = (ms: number | null | undefined): SQL => (ms === null || ms === undefined ? sql`null` : sql`${new Date(ms)}::timestamptz`);
const inList = (values: readonly string[]): SQL => sql.join(values.map((v) => sql`${v}`), sql`, `);

type Executor = Pick<DbTransaction, 'execute'>;

interface AppealRow {
  id: string;
  case_id: string;
  event_id: string | null;
  account_id: string | null;
  pid: string | null;
  appeal_text: string | null;
  reason_category: string | null;
  received_at: Date | string | null;
  status: string;
  appeal_result: string | null;
  decided_by: string | null;
  decided_at: Date | string | null;
  block_list_change: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface DispatchRow {
  case_id: string;
  call: string;
  source_version: string | number;
  state: string;
  attempts: string | number;
  next_attempt_at: Date | string | null;
  claimed_until: Date | string | null;
  last_error: string | null;
  result: string | null;
  failed_alerted_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const toAppeal = (r: AppealRow): VerificationCase => ({
  appealId: r.id,
  caseId: r.case_id,
  eventId: r.event_id,
  accountId: r.account_id,
  pid: r.pid,
  text: r.appeal_text,
  reasonCategory: r.reason_category,
  receivedAtMs: msOf(r.received_at),
  status: r.status as VerificationCaseStatus,
  appealResult: r.appeal_result as AppealOutcome | null,
  decidedBy: r.decided_by,
  decidedAtMs: msOf(r.decided_at),
  blockListChange: r.block_list_change as BlockListChange | null,
  createdAtMs: new Date(r.created_at).getTime(),
  updatedAtMs: new Date(r.updated_at).getTime(),
});

const toDispatch = (r: DispatchRow): CsCaseDispatchRow => ({
  caseId: r.case_id,
  call: r.call as DispatchCall,
  sourceVersion: Number(r.source_version),
  state: r.state as DispatchState,
  attempts: Number(r.attempts),
  nextAttemptAtMs: msOf(r.next_attempt_at),
  claimedUntilMs: msOf(r.claimed_until),
  lastError: r.last_error,
  result: r.result,
  failedAlertedAtMs: msOf(r.failed_alerted_at),
  createdAtMs: new Date(r.created_at).getTime(),
  updatedAtMs: new Date(r.updated_at).getTime(),
});

/** 결정 트랜잭션의 판 겨룸(되돌린 뒤 412로 바꾼다) */
class StaleDecision extends Error {}

/** 한 건의 호출 차례(domain DISPATCH_CALLS와 같다, bot-defense §12 '기다림과 이어 보내기') */
const CALL_ORDER = sql`array['APPEAL_COPY', 'ACCOUNT_HOLD_OPEN', 'QUEUE_RESOLVE', 'TRUST_LABEL', 'ACCOUNT_HOLD_CLOSE']::text[]`;

@Injectable()
export class DrizzleCsCaseStore implements CsCaseStore, CsAppealStore {
  readonly #idem: IdempotencyStore;

  constructor(@Inject(DATABASE) private readonly database: Database) {
    this.#idem = new IdempotencyStore({ clock: systemClock });
  }

  async #insertOpen(ex: Executor, input: CsCaseOpenInput): Promise<{ case: CsCase; created: boolean }> {
    const inserted = (
      await ex.execute(sql`
        insert into cs_case (id, kind, target_ref, status, category, progress_due_at, result_due_at, created_at, updated_at, detail)
        values (${input.caseId}::uuid, ${input.kind}, ${input.targetRef}, 'OPEN', ${input.category ?? ''}, ${ts(input.progressDueAtMs)}, ${ts(input.resultDueAtMs)},
                ${new Date(input.nowMs)}::timestamptz, ${new Date(input.nowMs)}::timestamptz, ${input.detail ?? null})
        on conflict (kind, target_ref) where status <> 'RESOLVED' do nothing
        returning ${COLUMNS}`)
    ).rows as unknown as Row[];
    if (inserted[0]) return { case: toCase(inserted[0]), created: true };
    const rows = (await ex.execute(sql`select ${COLUMNS} from cs_case where kind = ${input.kind} and target_ref = ${input.targetRef} and status <> 'RESOLVED' order by created_at limit 1`)).rows as unknown as Row[];
    return { case: toCase(rows[0]!), created: false };
  }

  async open(input: CsCaseOpenInput): Promise<CsCase> {
    return (await this.#insertOpen(this.database.db, input)).case;
  }

  async receive(input: CsCaseOpenInput & { readonly eventKey: string }): Promise<{ result: CsCaseReceiveResult; case: CsCase }> {
    const appeal = input.kind === VERIFICATION_APPEAL_KIND && UUID.test(input.targetRef);
    return this.database.transaction(async (tx) => {
      const seen = (await tx.execute(sql`select c.* from cs_case_request r join cs_case c on c.id = r.case_id where r.event_key = ${input.eventKey}`)).rows as unknown as Row[];
      if (seen[0]) return { result: 'duplicate' as const, case: toCase(seen[0]) };
      // 이의 ID마다 건 하나(F-06-7): 이미 이의 행이 있으면 해결된 건이어도 그 건이고 eventKey를 그 건으로 적는다(보낼 호출은 더하지 않는다)
      if (appeal) {
        const known = (await tx.execute(sql`select c.* from verification_case v join cs_case c on c.id = v.case_id where v.id = ${input.targetRef}::uuid`)).rows as unknown as Row[];
        if (known[0]) {
          await tx.execute(sql`
            insert into cs_case_request (event_key, case_id, kind, received_at)
            values (${input.eventKey}, ${known[0].id}::uuid, ${input.kind}, ${new Date(input.nowMs)}::timestamptz)
            on conflict (event_key) do nothing`);
          return { result: 'duplicate' as const, case: toCase(known[0]) };
        }
      }
      const opened = await this.#insertOpen(tx, input);
      const recorded = await tx.execute(sql`
        insert into cs_case_request (event_key, case_id, kind, received_at)
        values (${input.eventKey}, ${opened.case.caseId}::uuid, ${input.kind}, ${new Date(input.nowMs)}::timestamptz)
        on conflict (event_key) do nothing
        returning event_key`);
      // 같은 eventKey가 동시에 들어와 다른 쪽이 먼저 적었으면 그 요청의 건으로 답한다(새 건은 이 트랜잭션이 열었을 때만 남는다)
      if (recorded.rows.length === 0) {
        if (opened.created) await tx.execute(sql`delete from cs_case where id = ${opened.case.caseId}::uuid`);
        const again = (await tx.execute(sql`select c.* from cs_case_request r join cs_case c on c.id = r.case_id where r.event_key = ${input.eventKey}`)).rows as unknown as Row[];
        return { result: 'duplicate' as const, case: toCase(again[0]!) };
      }
      if (appeal) await this.#openAppeal(tx, input.targetRef, opened.case, input.nowMs);
      return { result: opened.created ? ('opened' as const) : ('existing' as const), case: opened.case };
    });
  }

  /** 이의 행(내용 없음, PENDING)과 보낼 호출 APPEAL_COPY·ACCOUNT_HOLD_OPEN(연 때의 판)을 넣는다. 이미 있으면 그대로 */
  async #openAppeal(ex: Executor, appealId: string, c: CsCase, nowMs: number): Promise<void> {
    const at = new Date(nowMs);
    const inserted = await ex.execute(sql`
      insert into verification_case (id, case_id, status, created_at, updated_at)
      values (${appealId}::uuid, ${c.caseId}::uuid, 'PENDING', ${at}::timestamptz, ${at}::timestamptz)
      on conflict do nothing
      returning id`);
    if (inserted.rows.length === 0) return;
    await ex.execute(sql`
      insert into cs_case_dispatch (case_id, call, source_version, state, attempts, next_attempt_at, created_at, updated_at)
      values (${c.caseId}::uuid, 'APPEAL_COPY', ${c.version}, 'PENDING', 0, ${at}::timestamptz, ${at}::timestamptz, ${at}::timestamptz),
             (${c.caseId}::uuid, 'ACCOUNT_HOLD_OPEN', ${c.version}, 'PENDING', 0, ${at}::timestamptz, ${at}::timestamptz, ${at}::timestamptz)
      on conflict (case_id, call) do nothing`);
  }

  async find(caseId: string): Promise<CsCase | undefined> {
    if (!UUID.test(caseId)) return undefined;
    const rows = (await this.database.db.execute(sql`select ${COLUMNS} from cs_case where id = ${caseId}::uuid`)).rows as unknown as Row[];
    return rows[0] ? toCase(rows[0]) : undefined;
  }

  async findOpen(kind: CsCaseKind, targetRef: string): Promise<CsCase | undefined> {
    const rows = (await this.database.db.execute(sql`select ${COLUMNS} from cs_case where kind = ${kind} and target_ref = ${targetRef} and status <> 'RESOLVED' order by created_at limit 1`)).rows as unknown as Row[];
    return rows[0] ? toCase(rows[0]) : undefined;
  }

  async list(q: CsCaseListQuery): Promise<CsCase[]> {
    if (q.statuses.length === 0 || (q.kinds && q.kinds.length === 0)) return [];
    let where = sql`status in (${inList(q.statuses)})`;
    if (q.kinds) where = sql`${where} and kind in (${inList(q.kinds)})`;
    if (q.excludeKinds && q.excludeKinds.length > 0) where = sql`${where} and kind not in (${inList(q.excludeKinds)})`;
    if (q.excludeCategories && q.excludeCategories.categories.length > 0) {
      where = sql`${where} and not (kind = ${q.excludeCategories.kind} and category in (${inList(q.excludeCategories.categories)}))`;
    }
    if (q.dueAtOrBeforeMs !== undefined) where = sql`${where} and next_due_at <= ${new Date(q.dueAtOrBeforeMs)}::timestamptz`;
    if (q.after) {
      const due = q.after.nextDueMs === null ? sql`'infinity'::timestamptz` : sql`${new Date(q.after.nextDueMs)}::timestamptz`;
      where = sql`${where} and (next_due_at, id) > (${due}, ${q.after.caseId}::uuid)`;
    }
    const rows = (await this.database.db.execute(sql`select ${COLUMNS} from cs_case where ${where} order by next_due_at, id limit ${q.limit}`)).rows as unknown as Row[];
    return rows.map(toCase);
  }

  async update(next: CsCase, expectedVersion: number, audit?: AuditRecord): Promise<boolean> {
    if (!UUID.test(next.caseId)) return false;
    return this.database.transaction(async (tx) => {
      const updated = await tx.execute(sql`
        update cs_case set
          status = ${next.status},
          assignee = ${next.assignee === null ? sql`null` : sql`${next.assignee}::uuid`},
          result_note = ${next.resultNote},
          resolved_at = ${ts(next.resolvedAtMs)},
          version = ${next.version},
          updated_at = ${new Date(next.updatedAtMs)}::timestamptz
        where id = ${next.caseId}::uuid and version = ${expectedVersion}
        returning id`);
      if (updated.rows.length === 0) return false;
      if (audit) await appendAuditIn(tx, audit);
      return true;
    });
  }

  async markAlerted(caseId: string, marks: { readonly dueSoonForMs?: number; readonly overdueForMs?: number }): Promise<void> {
    const sets: SQL[] = [];
    if (marks.dueSoonForMs !== undefined) sets.push(sql`due_soon_alerted_for = ${new Date(marks.dueSoonForMs)}::timestamptz`);
    if (marks.overdueForMs !== undefined) sets.push(sql`overdue_alerted_for = ${new Date(marks.overdueForMs)}::timestamptz`);
    if (sets.length === 0 || !UUID.test(caseId)) return;
    await this.database.db.execute(sql`update cs_case set ${sql.join(sets, sql`, `)} where id = ${caseId}::uuid`);
  }

  async resolvedWithAlerts(limit: number): Promise<CsCase[]> {
    const rows = (
      await this.database.db.execute(sql`
        select ${COLUMNS} from cs_case
         where status = 'RESOLVED' and (due_soon_alerted_for is not null or overdue_alerted_for is not null)
         order by id limit ${limit}`)
    ).rows as unknown as Row[];
    return rows.map(toCase);
  }

  async clearAlerted(caseId: string): Promise<void> {
    if (!UUID.test(caseId)) return;
    await this.database.db.execute(sql`update cs_case set due_soon_alerted_for = null, overdue_alerted_for = null where id = ${caseId}::uuid`);
  }

  // ---- 추가 검증 이의(F-06-7) ----

  async appealOf(caseId: string): Promise<VerificationCase | undefined> {
    if (!UUID.test(caseId)) return undefined;
    const rows = (await this.database.db.execute(sql`select * from verification_case where case_id = ${caseId}::uuid`)).rows as unknown as AppealRow[];
    return rows[0] ? toAppeal(rows[0]) : undefined;
  }

  async dispatchRowsOf(caseId: string): Promise<CsCaseDispatchRow[]> {
    if (!UUID.test(caseId)) return [];
    const rows = (await this.database.db.execute(sql`select * from cs_case_dispatch where case_id = ${caseId}::uuid order by array_position(${CALL_ORDER}, call)`)).rows as unknown as DispatchRow[];
    return rows.map(toDispatch);
  }

  async copyAppealContent(caseId: string, c: AppealContent, nowMs: number): Promise<void> {
    await this.database.db.execute(sql`
      update verification_case set
        event_id = ${c.eventId}::uuid,
        account_id = ${c.accountId}::uuid,
        pid = ${c.pid},
        appeal_text = ${c.text},
        reason_category = ${c.reasonCategory},
        received_at = ${new Date(c.receivedAtMs)}::timestamptz,
        status = case when status = 'SKIPPED' then 'PENDING' else status end,
        updated_at = ${new Date(nowMs)}::timestamptz
      where case_id = ${caseId}::uuid and event_id is null`);
  }

  async updateAppeal(caseId: string, patch: { readonly status?: VerificationCaseStatus; readonly blockListChange?: BlockListChange }, nowMs: number): Promise<void> {
    const sets: SQL[] = [sql`updated_at = ${new Date(nowMs)}::timestamptz`];
    if (patch.status !== undefined) sets.push(sql`status = ${patch.status}`);
    if (patch.blockListChange !== undefined) sets.push(sql`block_list_change = ${patch.blockListChange}`);
    await this.database.db.execute(sql`update verification_case set ${sql.join(sets, sql`, `)} where case_id = ${caseId}::uuid`);
  }

  async findDecisionRecord(idem: AppealDecisionWrite['idem']): Promise<{ readonly requestHash: Uint8Array; readonly caseId: string | null } | undefined> {
    const rows = (
      await this.database.db.execute(sql`
        select request_hash, result_ref from idempotency_record
         where account_ref = ${idem.accountRef} and operation = ${idem.operation} and idempotency_key = ${idem.key}`)
    ).rows as unknown as Array<{ request_hash: Buffer; result_ref: string | null }>;
    return rows[0] ? { requestHash: new Uint8Array(rows[0].request_hash), caseId: rows[0].result_ref } : undefined;
  }

  async decide(w: AppealDecisionWrite): Promise<AppealDecisionResult> {
    const caseId = w.next.caseId;
    const at = new Date(w.decidedAtMs);
    try {
      return await this.database.transaction(async (tx) =>
        this.#idem.run<AppealDecisionResult>(tx, w.idem, {
          execute: async () => {
            const updated = await tx.execute(sql`
              update cs_case set
                status = ${w.next.status},
                result_note = ${w.next.resultNote},
                resolved_at = ${ts(w.next.resolvedAtMs)},
                version = ${w.next.version},
                updated_at = ${new Date(w.next.updatedAtMs)}::timestamptz
              where id = ${caseId}::uuid and version = ${w.expectedVersion} and status <> 'RESOLVED'
              returning id`);
            if (updated.rows.length === 0) throw new StaleDecision();
            await tx.execute(sql`
              update verification_case set appeal_result = ${w.outcome}, decided_by = ${w.decidedBy}::uuid, decided_at = ${at}::timestamptz, status = case when status = 'SKIPPED' then 'SKIPPED' else 'RUNNING' end, updated_at = ${at}::timestamptz
              where case_id = ${caseId}::uuid`);
            for (const call of w.calls) {
              await tx.execute(sql`
                insert into cs_case_dispatch (case_id, call, source_version, state, attempts, next_attempt_at, created_at, updated_at)
                values (${caseId}::uuid, ${call}, ${w.next.version}, 'PENDING', 0, ${at}::timestamptz, ${at}::timestamptz, ${at}::timestamptz)`);
            }
            await appendAuditIn(tx, w.audit);
            return { resultRef: caseId, value: { kind: 'decided' } };
          },
          replay: async (ref) => ({ kind: 'replay', caseId: ref }),
        }),
      );
    } catch (err) {
      if (err instanceof StaleDecision) return { kind: 'stale' };
      throw err;
    }
  }

  async #claim(where: SQL, order: SQL, limit: number | null, nowMs: number, claimMs: number): Promise<CsCaseDispatchRow[]> {
    const rows = (
      await this.database.db.execute(sql`
        with s as (
          select case_id, call from cs_case_dispatch
           where state <> 'APPLIED' and (claimed_until is null or claimed_until < ${new Date(nowMs)}::timestamptz) and ${where}
           order by ${order} ${limit === null ? sql`` : sql`limit ${limit}`}
           for update skip locked)
        update cs_case_dispatch d set claimed_until = ${new Date(nowMs + claimMs)}::timestamptz
          from s
         where d.case_id = s.case_id and d.call = s.call
        returning d.*`)
    ).rows as unknown as DispatchRow[];
    return rows.map(toDispatch);
  }

  async claimDue(nowMs: number, limit: number, claimMs: number): Promise<CsCaseDispatchRow[]> {
    return this.#claim(sql`next_attempt_at <= ${new Date(nowMs)}::timestamptz`, sql`next_attempt_at, case_id`, limit, nowMs, claimMs);
  }

  async claimCase(caseId: string, nowMs: number, claimMs: number): Promise<CsCaseDispatchRow[]> {
    if (!UUID.test(caseId)) return [];
    return this.#claim(sql`case_id = ${caseId}::uuid and next_attempt_at is not null`, sql`call`, null, nowMs, claimMs);
  }

  async saveDispatch(row: CsCaseDispatchRow): Promise<void> {
    await this.database.db.execute(sql`
      update cs_case_dispatch set
        state = ${row.state},
        attempts = ${row.attempts},
        next_attempt_at = ${ts(row.nextAttemptAtMs)},
        claimed_until = null,
        last_error = ${row.lastError},
        result = ${row.result},
        failed_alerted_at = ${ts(row.failedAlertedAtMs)},
        updated_at = ${new Date(row.updatedAtMs)}::timestamptz
      where case_id = ${row.caseId}::uuid and call = ${row.call}`);
  }
}
