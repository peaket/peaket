// 운영 명령 저장소의 PostgreSQL 구현. 명령 행·사건·대응 행(command_actor)·감사 체인 기록·멱등 기록을 한 트랜잭션에 넣는다(ASVS 2.3.3).
// 상태 쓰기 규칙은 도메인 command-writes.ts에 있고, 여기서는 명령 행을 FOR UPDATE로 잠근 쓰기(DbCommandWriter)를 준다.
// 사람 칸(requested_by·actor_ref·approver_ref·감사 기록)은 기록마다 새 가명 참조이고 관리 계정 ID는 command_actor에만 있다(ADR-0340 결정 8).
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, IDEMPOTENCY_RECORD_TABLE, IDEMPOTENCY_RETENTION_MS, IdempotencyStore, idempotencyKeyReused, type Database, type DbTransaction } from '@peaket/platform';
import { sql, type SQL } from 'drizzle-orm';
import { AUTO_EXPIRE_TYPES, type Command, type CommandIdempotency, type CommandState, type CommandType, type NewCommand } from '../../domain/command.js';
import { planCreation } from '../../domain/command-writes.js';
import { DuplicateCommandActor, type ActorSide, type CommandDueKind, type CommandListQuery, type CommandPage, type CommandPatch, type CommandWriter, type NewCommandApproval, type NewCommandEvent } from '../../domain/ports.js';
import { appendAuditIn } from '../../../audit/audit.js';
import { CommandStoreBase, decodeCursor, encodeCursor } from '../command-store-base.js';
import { publishSetting } from '../settings-outbox.js';
import type { SettingChange } from '../../domain/ports.js';
import type { PostReviewAlertKind, PostReviewRow, PostReviewWriter } from '../../domain/post-review.js';
import type { CommandTimelineEntry } from '../../domain/ports.js';
import { DbPostReviewWriter, postReviewRowOf, postReviewsDueOf, postReviewsToOpenOf, timelineOfDb } from './drizzle-post-reviews.js';

interface Row {
  id: string;
  type: string;
  state: string;
  reason: string;
  params: Record<string, unknown> | string;
  requested_by: string;
  requested_role: string;
  event_id: string | null;
  approval_expires_at: Date | string | null;
  expires_at: Date | string | null;
  compare_due_at: Date | string | null;
  round: number | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  attempts: number | string | null;
  last_error: string | null;
  executed_at: Date | string | null;
  result: Record<string, unknown> | string | null;
  /** 대응 표로 푼 요청자 관리 계정(없으면 null) */
  requester_account?: string | null;
  /** 사후 검토 작성 기한(command_post_review.due_at, 없으면 null) */
  post_review_due_at?: Date | string | null;
  /** 지금 보내는 제어 판과 보내기 시작한 시각(마이그레이션 0025, ADR-0365 결정 1·4) */
  control_version?: number | string | null;
  control_sent_at?: Date | string | null;
}

/** 같은 사람 두 번·요청자 본인 승인을 막는 부분 유일 색인(마이그레이션 0021) */
const ACTOR_PERSON_KEY = 'command_actor_person_key';

const ms = (v: Date | string | null): number | undefined => (v === null ? undefined : new Date(v).getTime());
const json = <T>(v: T | string): T => (typeof v === 'string' ? (JSON.parse(v) as T) : v);
const pgCode = (e: unknown): string | undefined => {
  const any = e as { code?: unknown; cause?: { code?: unknown } } | undefined;
  const c = any?.code ?? any?.cause?.code;
  return typeof c === 'string' ? c : undefined;
};
const constraintOf = (e: unknown): string | undefined => {
  const any = e as { constraint?: unknown; cause?: { constraint?: unknown } } | undefined;
  const c = any?.constraint ?? any?.cause?.constraint;
  return typeof c === 'string' ? c : undefined;
};

/** 행을 명령으로. 승인·dry-run·ack 시각 같은 딸린 값은 따로 붙인다 */
const toCommand = (r: Row, extra: { approvals?: readonly string[]; revertRequestedBy?: string; dryRun?: Record<string, unknown>; ackedAtMs?: number } = {}): Command => ({
  commandId: r.id,
  type: r.type as CommandType,
  state: r.state as CommandState,
  reason: r.reason,
  params: json(r.params),
  requestedBy: r.requester_account ?? '',
  requesterRef: r.requested_by,
  requestedRole: r.requested_role,
  ...(r.event_id !== null ? { eventId: r.event_id } : {}),
  ...(r.approval_expires_at !== null ? { approvalExpiresAtMs: ms(r.approval_expires_at)! } : {}),
  ...(r.expires_at !== null ? { expiresAtMs: ms(r.expires_at)! } : {}),
  ...(r.compare_due_at !== null ? { compareDueAtMs: ms(r.compare_due_at)! } : {}),
  round: Number(r.round ?? 0),
  ...(extra.revertRequestedBy !== undefined ? { revertRequestedBy: extra.revertRequestedBy } : {}),
  createdAtMs: ms(r.created_at)!,
  updatedAtMs: ms(r.updated_at)!,
  approvals: extra.approvals ?? [],
  attempts: Number(r.attempts ?? 0),
  ...(r.last_error !== null ? { lastError: r.last_error } : {}),
  ...(r.executed_at !== null ? { executedAtMs: ms(r.executed_at)! } : {}),
  ...(r.result !== null ? { result: json(r.result) } : {}),
  ...(extra.dryRun !== undefined ? { dryRun: extra.dryRun } : {}),
  ...(extra.ackedAtMs !== undefined ? { ackedAtMs: extra.ackedAtMs } : {}),
  ...(r.post_review_due_at !== undefined && r.post_review_due_at !== null ? { postReviewDueAtMs: ms(r.post_review_due_at)! } : {}),
  ...(r.control_version !== undefined && r.control_version !== null ? { controlVersion: Number(r.control_version) } : {}),
  ...(r.control_sent_at !== undefined && r.control_sent_at !== null ? { controlSentAtMs: ms(r.control_sent_at)! } : {}),
});

/** 글자 칸을 UUID로 읽는다(옛 행의 글자 값은 null이 되어 결합에서 빠진다). 대응 표 기본 키 색인을 쓰게 한다 */
const asUuid = (col: SQL): SQL => sql`(case when ${col} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (${col})::uuid end)`;

/** 요청자 관리 계정과 사후 검토 작성 기한을 함께 읽는 명령 행 SELECT(대응 표·사후 검토 표 왼쪽 결합) */
const SELECT_ROW = sql`
  select c.*, a.admin_account_id::text as requester_account, pr.due_at as post_review_due_at
  from ops_command c left join command_actor a on a.actor_ref = ${asUuid(sql`c.requested_by`)}
  left join command_post_review pr on pr.command_id = c.id`;

type Exec = Pick<DbTransaction, 'execute'>;

async function approvalsOf(q: Exec, ids: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const rows = (
    await q.execute(sql`
      select p.command_id::text as command_id, a.admin_account_id::text as account
      from command_approval p left join command_actor a on a.actor_ref = ${asUuid(sql`p.approver_ref`)}
      where p.command_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}) and p.round = 0
      order by p.decided_at`)
  ).rows as { command_id: string; account: string | null }[];
  for (const r of rows) out.set(r.command_id, [...(out.get(r.command_id) ?? []), r.account ?? '']);
  return out;
}

/** 상세에 붙는 값: 승인(회차 0), 지금 회차의 되돌리기 요청자, 접수 때의 dry-run, 첫 ack 시각 */
async function detailOf(q: Exec, row: Row): Promise<Command> {
  const id = row.id;
  const approvals = (await approvalsOf(q, [id])).get(id) ?? [];
  const round = Number(row.round ?? 0);
  let revertRequestedBy: string | undefined;
  if (round > 0) {
    const [r] = (await q.execute(sql`select admin_account_id::text as account from command_actor where command_id = ${id}::uuid and round = ${round} and side = 'REQUESTER' limit 1`)).rows as { account: string }[];
    revertRequestedBy = r?.account;
  }
  const [d] = (
    await q.execute(sql`
      select dry_run from command_event where command_id = ${id}::uuid and dry_run is not null and type in ('DRY_RUN', 'DISPATCHED') order by seq limit 1`)
  ).rows as { dry_run: Record<string, unknown> | string }[];
  const [a] = (await q.execute(sql`select acked_at from command_event where command_id = ${id}::uuid and type = 'ACKED' and acked_at is not null order by seq limit 1`)).rows as { acked_at: Date | string }[];
  return toCommand(row, {
    approvals,
    ...(revertRequestedBy !== undefined ? { revertRequestedBy } : {}),
    ...(d ? { dryRun: json(d.dry_run) } : {}),
    ...(a ? { ackedAtMs: ms(a.acked_at)! } : {}),
  });
}

/** 잠근 명령 행 하나의 쓰기(같은 트랜잭션) */
class DbCommandWriter implements CommandWriter {
  #current: Command;
  /** 사후 검토 행(같은 트랜잭션, ADR-0349 결정 7) */
  readonly postReviews: PostReviewWriter;

  constructor(
    private readonly tx: DbTransaction,
    current: Command,
  ) {
    this.#current = current;
    this.postReviews = new DbPostReviewWriter(tx, current.commandId);
  }

  get current(): Command {
    return this.#current;
  }

  async actor(side: ActorSide, round: number, accountId: string, nowMs: number, given?: string): Promise<string> {
    const ref = given ?? randomUUID();
    try {
      await this.tx.execute(sql`
        insert into command_actor (actor_ref, command_id, round, side, admin_account_id, recorded_at)
        values (${ref}::uuid, ${this.#current.commandId}::uuid, ${round}::smallint, ${side}, ${accountId}::uuid, ${new Date(nowMs)}::timestamptz)`);
    } catch (e) {
      if (pgCode(e) === '23505' && constraintOf(e) === ACTOR_PERSON_KEY) throw new DuplicateCommandActor();
      throw e;
    }
    return ref;
  }

  async requesterOf(round: number): Promise<{ ref: string; accountId?: string } | undefined> {
    const [r] = (
      await this.tx.execute(sql`
        select actor_ref::text as ref, admin_account_id::text as account from command_actor
        where command_id = ${this.#current.commandId}::uuid and round = ${round} and side = 'REQUESTER' limit 1`)
    ).rows as { ref: string; account: string }[];
    if (r) return { ref: r.ref, accountId: r.account };
    // 옛 행(0021 이전)은 대응이 명령마다 있지 않을 수 있다: 가명 참조로 찾는다
    if (round !== 0) return undefined;
    const ref = this.#current.requesterRef ?? '';
    const [legacy] = (await this.tx.execute(sql`select admin_account_id::text as account from command_actor where actor_ref = ${asUuid(sql`${ref}::text`)}`)).rows as { account: string }[];
    return { ref, ...(legacy ? { accountId: legacy.account } : {}) };
  }

  async decidedIn(round: number): Promise<boolean> {
    return (await this.tx.execute(sql`select 1 from command_approval where command_id = ${this.#current.commandId}::uuid and round = ${round} limit 1`)).rows.length > 0;
  }

  async event(e: NewCommandEvent): Promise<void> {
    const id = this.#current.commandId;
    const [seq] = (await this.tx.execute(sql`select coalesce(max(seq), 0) + 1 as seq from command_event where command_id = ${id}::uuid`)).rows as { seq: number | string }[];
    await this.tx.execute(sql`
      insert into command_event (command_id, seq, type, actor_ref, actor_role, reason, dry_run, detail, acked_at, created_at)
      values (${id}::uuid, ${Number(seq!.seq)}::int, ${e.type}, ${e.actorRef}, ${e.actorRole}, ${e.reason},
              ${e.dryRun !== undefined ? JSON.stringify(e.dryRun) : null}::jsonb, ${e.detail !== undefined ? JSON.stringify(e.detail) : null}::jsonb,
              ${e.ackedAtMs !== undefined ? new Date(e.ackedAtMs) : null}::timestamptz, ${new Date(e.nowMs)}::timestamptz)`);
    if (e.ackedAtMs !== undefined && this.#current.ackedAtMs === undefined && e.type === 'ACKED') this.#current = { ...this.#current, ackedAtMs: e.ackedAtMs };
  }

  async patch(p: CommandPatch): Promise<void> {
    const sets: SQL[] = [sql`updated_at = ${new Date(p.nowMs)}::timestamptz`];
    const at = (v: number | null) => (v === null ? null : new Date(v));
    if (p.state !== undefined) sets.push(sql`state = ${p.state}`);
    if (p.approvalExpiresAtMs !== undefined) sets.push(sql`approval_expires_at = ${at(p.approvalExpiresAtMs)}::timestamptz`);
    if (p.expiresAtMs !== undefined) sets.push(sql`expires_at = ${at(p.expiresAtMs)}::timestamptz`);
    if (p.compareDueAtMs !== undefined) sets.push(sql`compare_due_at = ${at(p.compareDueAtMs)}::timestamptz`);
    if (p.executedAtMs !== undefined) sets.push(sql`executed_at = ${at(p.executedAtMs)}::timestamptz`);
    if (p.attempts !== undefined) sets.push(sql`attempts = ${p.attempts}::int`);
    if (p.lastError !== undefined) sets.push(sql`last_error = ${p.lastError}`);
    if (p.result !== undefined) sets.push(sql`result = ${p.result === null ? null : JSON.stringify(p.result)}::jsonb`);
    if (p.round !== undefined) sets.push(sql`round = ${p.round}::smallint`);
    if (p.controlVersion !== undefined) sets.push(sql`control_version = ${p.controlVersion}::bigint`);
    if (p.controlSentAtMs !== undefined) sets.push(sql`control_sent_at = ${at(p.controlSentAtMs)}::timestamptz`);
    await this.tx.execute(sql`update ops_command set ${sql.join(sets, sql`, `)} where id = ${this.#current.commandId}::uuid`);
    const c = { ...this.#current } as Record<string, unknown>;
    const opt = (k: string, v: unknown) => {
      if (v === undefined) return;
      if (v === null) delete c[k];
      else c[k] = v;
    };
    if (p.state !== undefined) c.state = p.state;
    opt('approvalExpiresAtMs', p.approvalExpiresAtMs);
    opt('expiresAtMs', p.expiresAtMs);
    opt('compareDueAtMs', p.compareDueAtMs);
    opt('executedAtMs', p.executedAtMs);
    opt('lastError', p.lastError);
    opt('result', p.result);
    opt('controlVersion', p.controlVersion);
    opt('controlSentAtMs', p.controlSentAtMs);
    if (p.attempts !== undefined) c.attempts = p.attempts;
    if (p.round !== undefined) c.round = p.round;
    c.updatedAtMs = p.nowMs;
    this.#current = c as unknown as Command;
  }

  async approval(a: NewCommandApproval): Promise<void> {
    await this.tx.execute(sql`
      insert into command_approval (command_id, approver_ref, approver_role, requester_ref, decision, reason, round, decided_at)
      values (${this.#current.commandId}::uuid, ${a.approverRef}, ${a.approverRole}, ${a.requesterRef}, ${a.decision}, ${a.reason ?? null}, ${a.round}::smallint, ${new Date(a.nowMs)}::timestamptz)`);
    if (a.round === 0) {
      const [r] = (await this.tx.execute(sql`select admin_account_id::text as account from command_actor where actor_ref = ${a.approverRef}::uuid`)).rows as { account: string }[];
      this.#current = { ...this.#current, approvals: [...this.#current.approvals, r?.account ?? ''] };
    }
  }

  async audit(recordType: string, payload: Record<string, unknown>, nowMs: number): Promise<void> {
    await appendAuditIn(this.tx, { recordType, recordId: this.#current.commandId, payload, nowMs });
  }

  /**
   * 판 번호 원장(ADR-0365 결정 1): 범위마다 (범위, 종류) 행을 만들어 두고 차례대로 잠근 뒤(FOR UPDATE, 같은 차례라 서로 막히지 않는다)
   * 새 판 = max(마지막 판 + 1, 지금 밀리초)를 모두에 쓴다. 같은 밀리초의 두 명령도 서로 다른 판이고, 시계가 되돌아가도 줄지 않는다
   */
  async assignControlVersion(q: { readonly scopes: readonly string[]; readonly kind: string; readonly nowMs: number }): Promise<number> {
    const scopes = [...new Set(q.scopes)].sort();
    const now = new Date(q.nowMs);
    let last = 0;
    for (const scope of scopes) {
      await this.tx.execute(sql`
        insert into control_version (scope, kind, last_version, command_id, updated_at) values (${scope}, ${q.kind}, 0, ${this.#current.commandId}::uuid, ${now}::timestamptz)
        on conflict (scope, kind) do nothing`);
      const [r] = (await this.tx.execute(sql`select last_version from control_version where scope = ${scope} and kind = ${q.kind} for update`)).rows as { last_version: number | string }[];
      last = Math.max(last, Number(r?.last_version ?? 0));
    }
    const version = Math.max(last + 1, q.nowMs);
    await this.tx.execute(sql`
      update control_version set last_version = ${version}::bigint, command_id = ${this.#current.commandId}::uuid, updated_at = ${now}::timestamptz
      where kind = ${q.kind} and scope in (${sql.join(scopes.map((x) => sql`${x}`), sql`, `)})`);
    return version;
  }

  /** 설정 사건을 같은 트랜잭션의 Outbox 행으로(ADR-0349 결정 5). 행 ID는 실제 시계의 UUIDv7이다(일 파티션은 릴레이가 실제 시계로 미리 만든다) */
  async setting(s: SettingChange): Promise<void> {
    await publishSetting(this.tx, s);
  }
}

/** 정비 작업이 고르는 조건 */
const DUE: Record<CommandDueKind, (nowMs: number) => SQL> = {
  APPROVAL_EXPIRED: (now) => sql`c.state = 'PENDING_APPROVAL' and c.approval_expires_at <= ${new Date(now)}::timestamptz`,
  REVERT_EXPIRED: (now) => sql`c.state = 'REVERT_PENDING' and c.approval_expires_at <= ${new Date(now)}::timestamptz`,
  AUTO_EXPIRE: (now) => sql`c.state = 'ACKED' and c.type in (${sql.join(AUTO_EXPIRE_TYPES.map((t) => sql`${t}`), sql`, `)}) and c.expires_at <= ${new Date(now)}::timestamptz`,
};

@Injectable()
export class DrizzleCommandStore extends CommandStoreBase {
  constructor(@Inject(DATABASE) private readonly database: Database) {
    super();
  }

  async replayOf(idem: CommandIdempotency, nowMs: number): Promise<string | undefined> {
    const since = new Date(nowMs - IDEMPOTENCY_RETENTION_MS);
    const [row] = (
      await this.database.db.execute(sql`
        select request_hash, result_ref from ${sql.identifier(IDEMPOTENCY_RECORD_TABLE)}
         where account_ref = ${idem.accountRef} and operation = ${idem.operation} and idempotency_key = ${idem.key}::uuid and created_at > ${since}`)
    ).rows as { request_hash: Buffer; result_ref: string | null }[];
    if (!row || row.result_ref === null) return undefined;
    const stored = Buffer.from(row.request_hash);
    const hash = Buffer.from(idem.requestHash);
    if (stored.length !== hash.length || !timingSafeEqual(stored, hash)) throw idempotencyKeyReused();
    return row.result_ref;
  }

  async insert(input: NewCommand): Promise<{ command: Command; replayed: boolean }> {
    return this.database.transaction(async (tx) => {
      const insert = async (): Promise<Command> => {
        const requesterRef = randomUUID();
        const plan = planCreation(input, requesterRef);
        const now = new Date(input.nowMs);
        await tx.execute(sql`
          insert into ops_command (id, type, state, reason, params, requested_by, requested_role, event_id, approval_expires_at, compare_due_at, expires_at, attempts, round, created_at, updated_at)
          values (${input.commandId}::uuid, ${input.type}, ${plan.state}, ${input.reason}, ${JSON.stringify(input.params)}::jsonb, ${plan.requesterRef},
                  ${input.system ? 'system' : input.requestedRole}, ${input.eventId ?? null}::uuid,
                  ${plan.approvalExpiresAtMs !== undefined ? new Date(plan.approvalExpiresAtMs) : null}::timestamptz,
                  ${plan.compareDueAtMs !== undefined ? new Date(plan.compareDueAtMs) : null}::timestamptz,
                  ${plan.expiresAtMs !== undefined ? new Date(plan.expiresAtMs) : null}::timestamptz,
                  ${plan.attempts}::int, 0, ${now}::timestamptz, ${now}::timestamptz)`);
        const [row] = (await tx.execute(sql`${SELECT_ROW} where c.id = ${input.commandId}::uuid`)).rows as unknown as Row[];
        const w = new DbCommandWriter(tx, toCommand(row!));
        if (plan.actor) {
          await tx.execute(sql`
            insert into command_actor (actor_ref, command_id, round, side, admin_account_id, recorded_at)
            values (${plan.requesterRef}::uuid, ${input.commandId}::uuid, 0, 'REQUESTER', ${plan.actor.accountId}::uuid, ${now}::timestamptz)`);
        }
        for (const e of plan.events) await w.event({ ...e, nowMs: input.nowMs });
        await w.audit(plan.audit.recordType, plan.audit.payload, input.nowMs);
        const [fresh] = (await tx.execute(sql`${SELECT_ROW} where c.id = ${input.commandId}::uuid`)).rows as unknown as Row[];
        return detailOf(tx, fresh!);
      };
      if (!input.idempotency) return { command: await insert(), replayed: false };
      // 멱등 기록은 같은 트랜잭션의 첫 쓰기다. 같은 키·같은 지문이면 처음 명령을 돌려주고 새 일을 하지 않는다(ADR-0340 결정 7)
      return new IdempotencyStore({ clock: { now: () => input.nowMs, monotonicMs: () => performance.now() } }).run<{ command: Command; replayed: boolean }>(tx, input.idempotency, {
        execute: async () => {
          const command = await insert();
          return { resultRef: command.commandId, value: { command, replayed: false } };
        },
        replay: async (ref) => {
          const [row] = (await tx.execute(sql`${SELECT_ROW} where c.id = ${ref}::uuid`)).rows as unknown as Row[];
          if (!row) throw new Error(`멱등 기록이 가리키는 명령이 없다: ${ref}`);
          return { command: await detailOf(tx, row), replayed: true };
        },
      });
    });
  }

  async find(commandId: string): Promise<Command | undefined> {
    const [row] = (await this.database.db.execute(sql`${SELECT_ROW} where c.id = ${commandId}::uuid`)).rows as unknown as Row[];
    return row ? detailOf(this.database.db, row) : undefined;
  }

  async list(query: CommandListQuery): Promise<CommandPage> {
    let where = sql`true`;
    if (query.eventId !== undefined) where = sql`${where} and c.event_id = ${query.eventId}::uuid`;
    if (query.type !== undefined) where = sql`${where} and c.type = ${query.type}`;
    if (query.states !== undefined && query.states.length > 0) where = sql`${where} and c.state in (${sql.join(query.states.map((s: string) => sql`${s}`), sql`, `)})`;
    if (query.updatedAfterMs !== undefined) where = sql`${where} and c.updated_at > ${new Date(query.updatedAfterMs)}::timestamptz`;
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    if (cursor) {
      const at = new Date(cursor.createdAtMs);
      where = sql`${where} and (c.created_at < ${at}::timestamptz or (c.created_at = ${at}::timestamptz and c.id < ${cursor.commandId}::uuid))`;
    }
    const rows = (await this.database.db.execute(sql`${SELECT_ROW} where ${where} order by c.created_at desc, c.id desc limit ${query.limit + 1}`)).rows as unknown as Row[];
    const page = rows.slice(0, query.limit);
    const approvals = await approvalsOf(this.database.db, page.map((r) => r.id));
    const items = page.map((r) => toCommand(r, { approvals: approvals.get(r.id) ?? [] }));
    const last = items.at(-1);
    return { items, ...(rows.length > query.limit && last ? { nextCursor: encodeCursor(last) } : {}) };
  }

  async mutate<T>(commandId: string, fn: (w: CommandWriter) => Promise<T>): Promise<T | undefined> {
    return this.database.transaction(async (tx) => {
      const [locked] = (await tx.execute(sql`select id from ops_command where id = ${commandId}::uuid for update`)).rows as { id: string }[];
      if (!locked) return undefined;
      const [row] = (await tx.execute(sql`${SELECT_ROW} where c.id = ${commandId}::uuid`)).rows as unknown as Row[];
      return fn(new DbCommandWriter(tx, await detailOf(tx, row!)));
    });
  }

  async mutateDue(kind: CommandDueKind, nowMs: number, fn: (w: CommandWriter) => Promise<void>): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const [picked] = (await tx.execute(sql`select c.id from ops_command c where ${DUE[kind](nowMs)} order by c.updated_at limit 1 for update skip locked`)).rows as { id: string }[];
      if (!picked) return false;
      const [row] = (await tx.execute(sql`${SELECT_ROW} where c.id = ${picked.id}::uuid`)).rows as unknown as Row[];
      await fn(new DbCommandWriter(tx, await detailOf(tx, row!)));
      return true;
    });
  }

  async dueForCompare(nowMs: number, limit: number): Promise<readonly string[]> {
    const rows = (await this.database.db.execute(sql`select id::text as id from ops_command where compare_due_at <= ${new Date(nowMs)}::timestamptz order by compare_due_at limit ${limit}`)).rows as { id: string }[];
    return rows.map((r) => r.id);
  }

  async purgeActors(beforeMs: number): Promise<number> {
    const r = await this.database.db.execute(sql`delete from command_actor where recorded_at < ${new Date(beforeMs)}::timestamptz and delete_hold_ref is null`);
    return (r as { rowCount?: number | null }).rowCount ?? 0;
  }

  // ---- 사후 검토(ADR-0349 결정 7): 잠그지 않는 읽기. 쓰기는 mutate의 postReviews ----

  postReviewOf(commandId: string): Promise<PostReviewRow | undefined> {
    return postReviewRowOf(this.database.db, commandId);
  }

  postReviewsDue(nowMs: number, limit: number): Promise<readonly { commandId: string; kind: PostReviewAlertKind }[]> {
    return postReviewsDueOf(this.database.db, nowMs, limit);
  }

  postReviewsToOpen(limit: number): Promise<readonly string[]> {
    return postReviewsToOpenOf(this.database.db, limit);
  }

  timelineOf(commandId: string): Promise<readonly CommandTimelineEntry[]> {
    return timelineOfDb(this.database.db, commandId);
  }
}
