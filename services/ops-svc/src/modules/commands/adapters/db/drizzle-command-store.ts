// 운영 명령 저장소의 PostgreSQL 구현. 명령 쓰기와 감사 체인 기록을 한 트랜잭션에 넣는다.
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database, type DbTransaction } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { APPROVAL_TTL_MS, approvalModeOf, stateAfterCreate, type Command, type CommandState, type CommandType, type NewCommand } from '../../domain/command.js';
import type { CommandDecision, CommandListQuery, CommandPage, CommandStore } from '../../domain/ports.js';
import { appendAuditIn } from '../../../audit/audit.js';

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
  created_at: Date | string;
  updated_at: Date | string;
}

const toCommand = (r: Row, approvals: readonly string[] = []): Command => ({
  commandId: r.id,
  type: r.type as CommandType,
  state: r.state as CommandState,
  reason: r.reason,
  params: typeof r.params === 'string' ? (JSON.parse(r.params) as Record<string, unknown>) : r.params,
  requestedBy: r.requested_by,
  requestedRole: r.requested_role,
  ...(r.event_id !== null ? { eventId: r.event_id } : {}),
  ...(r.approval_expires_at !== null ? { approvalExpiresAtMs: new Date(r.approval_expires_at).getTime() } : {}),
  createdAtMs: new Date(r.created_at).getTime(),
  updatedAtMs: new Date(r.updated_at).getTime(),
  approvals,
});

const encodeCursor = (c: Command): string => Buffer.from(JSON.stringify([c.createdAtMs, c.commandId]), 'utf8').toString('base64url');
const decodeCursor = (raw: string): { createdAtMs: number; commandId: string } | undefined => {
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(v) || typeof v[0] !== 'number' || typeof v[1] !== 'string') return undefined;
    return { createdAtMs: v[0], commandId: v[1] };
  } catch {
    return undefined;
  }
};

@Injectable()
export class DrizzleCommandStore implements CommandStore {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async create(input: NewCommand): Promise<Command> {
    const mode = approvalModeOf(input.type);
    const state = stateAfterCreate(mode);
    return this.database.transaction(async (tx) => {
      await tx.execute(sql`
        insert into ops_command (id, type, state, reason, params, requested_by, requested_role, event_id, approval_expires_at, created_at, updated_at)
        values (${input.commandId}::uuid, ${input.type}, ${state}, ${input.reason}, ${JSON.stringify(input.params)}::jsonb, ${input.requestedBy}, ${input.requestedRole},
                ${input.eventId ?? null}::uuid, ${mode === 'TWO' ? new Date(input.nowMs + APPROVAL_TTL_MS) : null}::timestamptz,
                ${new Date(input.nowMs)}::timestamptz, ${new Date(input.nowMs)}::timestamptz)`);
      await this.#event(tx, input.commandId, 1, 'CREATED', input.requestedBy, input.requestedRole, input.reason, input.nowMs);
      if (state !== 'DRAFTED') await this.#event(tx, input.commandId, 2, state, input.requestedBy, input.requestedRole, input.reason, input.nowMs);
      await appendAuditIn(tx, {
        recordType: 'COMMAND_CREATED',
        recordId: input.commandId,
        payload: { type: input.type, state, requestedBy: input.requestedBy, reason: input.reason },
        nowMs: input.nowMs,
      });
      const result = await tx.execute(sql`select * from ops_command where id = ${input.commandId}::uuid`);
      return toCommand(result.rows[0] as unknown as Row);
    });
  }

  async find(commandId: string): Promise<Command | undefined> {
    const [row] = (await this.database.db.execute(sql`select * from ops_command where id = ${commandId}::uuid`)).rows as unknown as Row[];
    if (!row) return undefined;
    const approvals = await this.#approvals(commandId);
    return toCommand(row, approvals);
  }

  async list(query: CommandListQuery): Promise<CommandPage> {
    let where = sql`true`;
    if (query.eventId !== undefined) where = sql`${where} and event_id = ${query.eventId}::uuid`;
    if (query.type !== undefined) where = sql`${where} and type = ${query.type}`;
    if (query.states !== undefined && query.states.length > 0) where = sql`${where} and state in (${sql.join(query.states.map((s: string) => sql`${s}`), sql`, `)})`;
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    if (cursor) {
      const at = new Date(cursor.createdAtMs);
      where = sql`${where} and (created_at < ${at}::timestamptz or (created_at = ${at}::timestamptz and id < ${cursor.commandId}::uuid))`;
    }
    const rows = (await this.database.db.execute(sql`select * from ops_command where ${where} order by created_at desc, id desc limit ${query.limit + 1}`)).rows as unknown as Row[];
    const page = rows.slice(0, query.limit).map((r) => toCommand(r));
    const approvals = await this.#approvalsMany(page.map((c) => c.commandId));
    const items = page.map((c) => ({ ...c, approvals: approvals.get(c.commandId) ?? [] }));
    const last = items.at(-1);
    return { items, ...(rows.length > query.limit && last ? { nextCursor: encodeCursor(last) } : {}) };
  }

  async approve(commandId: string, approverRef: string, approverRole: string, nowMs: number): Promise<CommandDecision> {
    return this.#decide(commandId, approverRef, approverRole, 'APPROVED', undefined, nowMs);
  }

  async reject(commandId: string, approverRef: string, approverRole: string, reason: string, nowMs: number): Promise<CommandDecision> {
    return this.#decide(commandId, approverRef, approverRole, 'REJECTED', reason, nowMs);
  }

  async markDispatched(commandId: string, nowMs: number): Promise<Command> {
    return this.#finishDispatch(commandId, 'DISPATCHED', undefined, nowMs);
  }

  async markDispatchFailed(commandId: string, reason: string, nowMs: number): Promise<Command> {
    return this.#finishDispatch(commandId, 'FAILED', reason, nowMs);
  }

  async #finishDispatch(commandId: string, state: 'DISPATCHED' | 'FAILED', reason: string | undefined, nowMs: number): Promise<Command> {
    return this.database.transaction(async (tx) => {
      const [row] = (await tx.execute(sql`select * from ops_command where id = ${commandId}::uuid for update`)).rows as unknown as Row[];
      if (!row) throw new Error(`명령이 없다: ${commandId}`);
      await tx.execute(sql`update ops_command set state = ${state}, updated_at = ${new Date(nowMs)}::timestamptz where id = ${commandId}::uuid`);
      const [seq] = (await tx.execute(sql`select coalesce(max(seq), 0) + 1 as seq from command_event where command_id = ${commandId}::uuid`)).rows as { seq: number | string }[];
      await this.#event(tx, commandId, Number(seq!.seq), state, 'system', 'system', reason ?? row.reason, nowMs);
      await appendAuditIn(tx, {
        recordType: state === 'DISPATCHED' ? 'COMMAND_DISPATCHED' : 'COMMAND_DISPATCH_FAILED',
        recordId: commandId,
        payload: { state, ...(reason !== undefined ? { reason } : {}) },
        nowMs,
      });
      const approvals = await this.#approvalsIn(tx, commandId);
      return toCommand({ ...row, state, updated_at: new Date(nowMs) }, approvals);
    });
  }

  async #decide(commandId: string, approverRef: string, approverRole: string, decision: 'APPROVED' | 'REJECTED', reason: string | undefined, nowMs: number): Promise<CommandDecision> {
    return this.database.transaction(async (tx) => {
      const [row] = (await tx.execute(sql`select * from ops_command where id = ${commandId}::uuid for update`)).rows as unknown as Row[];
      if (!row) return { status: 'NOT_FOUND' } as const;
      if (row.state !== 'PENDING_APPROVAL') return { status: 'NOT_PENDING' } as const;
      if (row.requested_by === approverRef) return { status: 'SAME_ACTOR' } as const;
      await tx.execute(sql`
        insert into command_approval (command_id, approver_ref, approver_role, decision, reason, decided_at)
        values (${commandId}::uuid, ${approverRef}, ${approverRole}, ${decision}, ${reason ?? null}, ${new Date(nowMs)}::timestamptz)`);
      await tx.execute(sql`update ops_command set state = ${decision}, updated_at = ${new Date(nowMs)}::timestamptz, approval_expires_at = null where id = ${commandId}::uuid`);
      const [seq] = (await tx.execute(sql`select coalesce(max(seq), 0) + 1 as seq from command_event where command_id = ${commandId}::uuid`)).rows as { seq: number | string }[];
      await this.#event(tx, commandId, Number(seq!.seq), decision, approverRef, approverRole, reason ?? row.reason, nowMs);
      await appendAuditIn(tx, {
        recordType: decision === 'APPROVED' ? 'COMMAND_APPROVED' : 'COMMAND_REJECTED',
        recordId: commandId,
        payload: { decision, approverRef, approverRole, ...(reason !== undefined ? { reason } : {}) },
        nowMs,
      });
      const approvals = await this.#approvalsIn(tx, commandId);
      return { status: 'APPLIED', command: toCommand({ ...row, state: decision, updated_at: new Date(nowMs), approval_expires_at: null }, approvals) } as const;
    });
  }

  async #event(tx: DbTransaction, commandId: string, seq: number, type: string, actorRef: string, actorRole: string, reason: string, nowMs: number): Promise<void> {
    await tx.execute(sql`
      insert into command_event (command_id, seq, type, actor_ref, actor_role, reason, created_at)
      values (${commandId}::uuid, ${seq}::int, ${type}, ${actorRef}, ${actorRole}, ${reason}, ${new Date(nowMs)}::timestamptz)`);
  }

  async #approvals(commandId: string): Promise<string[]> {
    const rows = (await this.database.db.execute(sql`select approver_ref from command_approval where command_id = ${commandId}::uuid order by decided_at`)).rows as { approver_ref: string }[];
    return rows.map((r) => r.approver_ref);
  }

  async #approvalsMany(ids: readonly string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (ids.length === 0) return out;
    const rows = (await this.database.db.execute(sql`select command_id, approver_ref from command_approval where command_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}) order by decided_at`)).rows as { command_id: string; approver_ref: string }[];
    for (const r of rows) out.set(r.command_id, [...(out.get(r.command_id) ?? []), r.approver_ref]);
    return out;
  }

  async #approvalsIn(tx: DbTransaction, commandId: string): Promise<string[]> {
    const rows = (await tx.execute(sql`select approver_ref from command_approval where command_id = ${commandId}::uuid order by decided_at`)).rows as { approver_ref: string }[];
    return rows.map((r) => r.approver_ref);
  }
}
