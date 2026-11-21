// 사후 검토 행(command_post_review, ops 0024)의 PostgreSQL 쓰기·읽기(ADR-0349 결정 7, docs/data.md command_post_review·§5 '사후 검토 보고서 제출·검토가 겹침').
// 쓰기는 명령 행을 FOR UPDATE로 잠근 같은 트랜잭션(DbCommandWriter)에서 하고, 칸마다 조건부 갱신이라 겹친 요청은 하나만 통과한다.
// 사람 칸은 가명 참조(command_actor로 푼다)이고 관리 계정 ID를 적지 않는다.
import type { DbTransaction } from '@peaket/platform';
import { sql, type SQL } from 'drizzle-orm';
import { POST_REVIEW_TYPES, type PostReviewAlertKind, type PostReviewAssessment, type PostReviewReport, type PostReviewRow, type PostReviewWriter } from '../../domain/post-review.js';
import type { CommandTimelineEntry } from '../../domain/ports.js';

type Exec = Pick<DbTransaction, 'execute'>;

interface Row {
  command_id: string;
  executor_ref: string;
  due_at: Date | string;
  submitted_at: Date | string | null;
  report: PostReviewReport | string | null;
  confirm_due_at: Date | string | null;
  confirmed_at: Date | string | null;
  reviewer_ref: string | null;
  assessment: string | null;
  solo_self_review: boolean;
  late: boolean;
  due_alerted_at: Date | string | null;
  confirm_alerted_at: Date | string | null;
}

const ms = (v: Date | string | null): number | undefined => (v === null ? undefined : new Date(v).getTime());
const json = <T>(v: T | string): T => (typeof v === 'string' ? (JSON.parse(v) as T) : v);
const at = (v: number): Date => new Date(v);
const affected = (r: unknown): number => (r as { rowCount?: number | null }).rowCount ?? 0;

const toRow = (r: Row): PostReviewRow => ({
  commandId: r.command_id,
  executorRef: r.executor_ref,
  dueAtMs: ms(r.due_at)!,
  ...(r.submitted_at !== null ? { submittedAtMs: ms(r.submitted_at)! } : {}),
  ...(r.report !== null ? { report: json(r.report) } : {}),
  ...(r.confirm_due_at !== null ? { confirmDueAtMs: ms(r.confirm_due_at)! } : {}),
  ...(r.confirmed_at !== null ? { confirmedAtMs: ms(r.confirmed_at)! } : {}),
  ...(r.reviewer_ref !== null ? { reviewerRef: r.reviewer_ref } : {}),
  ...(r.assessment !== null ? { assessment: r.assessment as PostReviewAssessment } : {}),
  soloSelfReview: r.solo_self_review,
  late: r.late,
  ...(r.due_alerted_at !== null ? { dueAlertedAtMs: ms(r.due_alerted_at)! } : {}),
  ...(r.confirm_alerted_at !== null ? { confirmAlertedAtMs: ms(r.confirm_alerted_at)! } : {}),
});

export async function postReviewRowOf(q: Exec, commandId: string): Promise<PostReviewRow | undefined> {
  const [r] = (await q.execute(sql`select * from command_post_review where command_id = ${commandId}::uuid`)).rows as unknown as Row[];
  return r ? toRow(r) : undefined;
}

/** 명령 행을 잠근 트랜잭션 안의 사후 검토 쓰기 */
export class DbPostReviewWriter implements PostReviewWriter {
  constructor(
    private readonly tx: DbTransaction,
    private readonly commandId: string,
  ) {}

  read(): Promise<PostReviewRow | undefined> {
    return postReviewRowOf(this.tx, this.commandId);
  }

  async firstDispatchedAtMs(): Promise<number | undefined> {
    const [r] = (await this.tx.execute(sql`select created_at from command_event where command_id = ${this.commandId}::uuid and type = 'DISPATCHED' order by seq limit 1`)).rows as { created_at: Date | string }[];
    return r ? ms(r.created_at) : undefined;
  }

  async open(r: { executorRef: string; dueAtMs: number }): Promise<boolean> {
    return (
      affected(
        await this.tx.execute(sql`
          insert into command_post_review (command_id, executor_ref, due_at, solo_self_review, late)
          values (${this.commandId}::uuid, ${r.executorRef}, ${at(r.dueAtMs)}::timestamptz, false, false)
          on conflict (command_id) do nothing`),
      ) > 0
    );
  }

  async submit(r: { report: PostReviewReport; submittedAtMs: number; confirmDueAtMs: number; late: boolean }): Promise<boolean> {
    return (
      affected(
        await this.tx.execute(sql`
          update command_post_review
             set submitted_at = ${at(r.submittedAtMs)}::timestamptz, report = ${JSON.stringify(r.report)}::jsonb,
                 confirm_due_at = ${at(r.confirmDueAtMs)}::timestamptz, late = late or ${r.late}
           where command_id = ${this.commandId}::uuid and submitted_at is null`),
      ) > 0
    );
  }

  async confirm(r: { reviewerRef: string; assessment: PostReviewAssessment; confirmedAtMs: number; soloSelfReview: boolean; late: boolean }): Promise<boolean> {
    return (
      affected(
        await this.tx.execute(sql`
          update command_post_review
             set confirmed_at = ${at(r.confirmedAtMs)}::timestamptz, reviewer_ref = ${r.reviewerRef}, assessment = ${r.assessment},
                 solo_self_review = ${r.soloSelfReview}, late = late or ${r.late}
           where command_id = ${this.commandId}::uuid and submitted_at is not null and confirmed_at is null`),
      ) > 0
    );
  }

  async markAlerted(kind: PostReviewAlertKind, nowMs: number): Promise<boolean> {
    const q =
      kind === 'DUE'
        ? sql`update command_post_review set due_alerted_at = ${at(nowMs)}::timestamptz
               where command_id = ${this.commandId}::uuid and submitted_at is null and due_alerted_at is null and due_at <= ${at(nowMs)}::timestamptz`
        : sql`update command_post_review set confirm_alerted_at = ${at(nowMs)}::timestamptz
               where command_id = ${this.commandId}::uuid and submitted_at is not null and confirmed_at is null
                 and confirm_alerted_at is null and confirm_due_at <= ${at(nowMs)}::timestamptz`;
    return affected(await this.tx.execute(q)) > 0;
  }
}

/** 기한을 넘겼는데 경보를 내지 않은 행(정각 포함) */
export async function postReviewsDueOf(q: Exec, nowMs: number, limit: number): Promise<{ commandId: string; kind: PostReviewAlertKind }[]> {
  const now = at(nowMs);
  const rows = (
    await q.execute(sql`
      (select command_id::text as command_id, 'DUE' as kind, due_at as t from command_post_review
        where submitted_at is null and due_alerted_at is null and due_at <= ${now}::timestamptz)
      union all
      (select command_id::text, 'CONFIRM', confirm_due_at from command_post_review
        where submitted_at is not null and confirmed_at is null and confirm_alerted_at is null and confirm_due_at <= ${now}::timestamptz)
      order by t limit ${limit}`)
  ).rows as { command_id: string; kind: PostReviewAlertKind }[];
  return rows.map((r) => ({ commandId: r.command_id, kind: r.kind }));
}

/** 처음 DISPATCHED를 지났는데 사후 검토 행이 없는 명령 3·11 */
export async function postReviewsToOpenOf(q: Exec, limit: number): Promise<string[]> {
  const types: SQL = sql.join(POST_REVIEW_TYPES.map((t) => sql`${t}`), sql`, `);
  const rows = (
    await q.execute(sql`
      select c.id::text as id from ops_command c
       where c.type in (${types}) and c.attempts > 0
         and not exists (select 1 from command_post_review p where p.command_id = c.id)
         and exists (select 1 from command_event e where e.command_id = c.id and e.type = 'DISPATCHED')
       order by c.created_at limit ${limit}`)
  ).rows as { id: string }[];
  return rows.map((r) => r.id);
}

/** 명령의 사건 차례와 행위자(대응이 남아 있으면 관리 계정 ID) */
export async function timelineOfDb(q: Exec, commandId: string): Promise<CommandTimelineEntry[]> {
  const rows = (
    await q.execute(sql`
      select e.seq, e.type, e.actor_ref, e.actor_role, e.reason, e.created_at, a.admin_account_id::text as account
        from command_event e
        left join command_actor a on a.actor_ref = (case when e.actor_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then e.actor_ref::uuid end)
       where e.command_id = ${commandId}::uuid order by e.seq`)
  ).rows as { seq: number | string; type: string; actor_ref: string; actor_role: string; reason: string; created_at: Date | string; account: string | null }[];
  return rows.map((r) => ({
    seq: Number(r.seq),
    type: r.type,
    actorRef: r.actor_ref,
    actorRole: r.actor_role,
    ...(r.account !== null ? { actorAccountId: r.account } : {}),
    reason: r.reason,
    createdAtMs: ms(r.created_at)!,
  }));
}
