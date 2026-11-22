// CS 처리함 건의 PostgreSQL 구현(ops 0000·0030, docs/data.md cs_case·cs_case_request).
// 열린 (kind, target_ref) 하나는 부분 유일 인덱스 cs_case_open_key가, 같은 eventKey 한 번은 cs_case_request 기본 키가 지킨다(ADR-0364 결정 4).
// next_due_at은 두 기한 중 이른 것의 생성 열('infinity' 포함)이라 앱은 읽지 않고 두 기한에서 다시 센다. 갱신은 판(version) 조건부이고 감사를 같은 트랜잭션에 쓴다.
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database, type DbTransaction } from '@peaket/platform';
import { sql, type SQL } from 'drizzle-orm';
import { appendAuditIn, type AuditRecord } from '../../../audit/index.js';
import type { CsCase, CsCaseKind, CsCaseListQuery, CsCaseOpenInput, CsCaseReceiveResult, CsCaseStatus, CsCaseStore } from '../../domain/cs-case.js';

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
}

const COLUMNS = sql`id, kind, target_ref, status, category, progress_due_at, result_due_at, assignee, version, result_note, resolved_at, created_at, updated_at, due_soon_alerted_for, overdue_alerted_for`;
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
});
const ts = (ms: number | null | undefined): SQL => (ms === null || ms === undefined ? sql`null` : sql`${new Date(ms)}::timestamptz`);
const inList = (values: readonly string[]): SQL => sql.join(values.map((v) => sql`${v}`), sql`, `);

type Executor = Pick<DbTransaction, 'execute'>;

@Injectable()
export class DrizzleCsCaseStore implements CsCaseStore {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async #insertOpen(ex: Executor, input: CsCaseOpenInput): Promise<{ case: CsCase; created: boolean }> {
    const inserted = (
      await ex.execute(sql`
        insert into cs_case (id, kind, target_ref, status, category, progress_due_at, result_due_at, created_at, updated_at)
        values (${input.caseId}::uuid, ${input.kind}, ${input.targetRef}, 'OPEN', ${input.category ?? ''}, ${ts(input.progressDueAtMs)}, ${ts(input.resultDueAtMs)},
                ${new Date(input.nowMs)}::timestamptz, ${new Date(input.nowMs)}::timestamptz)
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
    return this.database.transaction(async (tx) => {
      const seen = (await tx.execute(sql`select c.* from cs_case_request r join cs_case c on c.id = r.case_id where r.event_key = ${input.eventKey}`)).rows as unknown as Row[];
      if (seen[0]) return { result: 'duplicate' as const, case: toCase(seen[0]) };
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
      return { result: opened.created ? ('opened' as const) : ('existing' as const), case: opened.case };
    });
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
}
