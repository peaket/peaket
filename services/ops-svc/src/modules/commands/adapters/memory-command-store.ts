// 시험용 메모리 명령 저장소. 감사 체인은 MemoryAuditChain을 쓴다.
// PostgreSQL 저장소와 같은 쓰기 함수(command-writes.ts)를 쓰고, 쓰기 하나는 명령마다 잠근 채 모아 두었다가 끝에 한꺼번에 반영한다(던지면 아무것도 남지 않는다).
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { idempotencyKeyReused, IDEMPOTENCY_RETENTION_MS } from '@peaket/platform';
import type { AuditChain } from '../../audit/audit.js';
import { AUTO_EXPIRE_TYPES, type Command, type CommandIdempotency, type CommandState, type CommandType, type NewCommand } from '../domain/command.js';
import { planCreation } from '../domain/command-writes.js';
import {
  DuplicateCommandActor,
  type ActorSide,
  type CommandDueKind,
  type CommandListQuery,
  type CommandPage,
  type CommandPatch,
  type CommandWriter,
  type NewCommandApproval,
  type NewCommandEvent,
} from '../domain/ports.js';
import { CommandStoreBase, decodeCursor, encodeCursor } from './command-store-base.js';

interface MemRow {
  commandId: string;
  type: CommandType;
  state: CommandState;
  reason: string;
  params: Record<string, unknown>;
  requesterRef: string;
  requestedRole: string;
  eventId?: string;
  approvalExpiresAtMs?: number;
  expiresAtMs?: number;
  compareDueAtMs?: number;
  round: number;
  createdAtMs: number;
  updatedAtMs: number;
  attempts: number;
  lastError?: string;
  executedAtMs?: number;
  result?: Record<string, unknown>;
}

/** 시험이 읽는 사건 한 줄(command_event와 같은 칸) */
export interface MemoryCommandEvent {
  readonly commandId: string;
  readonly seq: number;
  readonly type: string;
  readonly actorRef: string;
  readonly actorRole: string;
  readonly reason: string;
  readonly dryRun?: Record<string, unknown>;
  readonly detail?: Record<string, unknown>;
  readonly ackedAtMs?: number;
  readonly createdAtMs: number;
}

/** 시험이 읽는 대응 행 한 줄(command_actor와 같은 칸) */
export interface MemoryCommandActor {
  readonly actorRef: string;
  readonly commandId: string;
  readonly round: number;
  readonly side: ActorSide;
  readonly adminAccountId: string;
  readonly recordedAtMs: number;
  deleteHoldRef?: string;
}

interface MemApproval extends NewCommandApproval {
  readonly commandId: string;
}

const isPersonSide = (s: ActorSide): boolean => s === 'REQUESTER' || s === 'APPROVER';

export class MemoryCommandStore extends CommandStoreBase {
  readonly #rows = new Map<string, MemRow>();
  readonly #events = new Map<string, MemoryCommandEvent[]>();
  readonly #actors = new Map<string, MemoryCommandActor>();
  readonly #approvals: MemApproval[] = [];
  readonly #idempotency = new Map<string, { hash: Buffer; commandId: string; createdAtMs: number }>();
  readonly #locks = new Map<string, Promise<void>>();

  constructor(private readonly audit: AuditChain) {
    super();
  }

  /** 시험용: 명령의 사건(차례대로) */
  eventsOf(commandId: string): readonly MemoryCommandEvent[] {
    return this.#events.get(commandId) ?? [];
  }

  /** 시험용: 대응 행 전부 */
  actors(): readonly MemoryCommandActor[] {
    return [...this.#actors.values()];
  }

  /** 시험용: 명령 행의 가명 참조 칸(ops_command.requested_by와 같은 값) */
  requesterRefOf(commandId: string): string | undefined {
    return this.#rows.get(commandId)?.requesterRef;
  }

  async #lock<T>(commandId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(commandId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const chained = prev.then(() => mine);
    this.#locks.set(commandId, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.#locks.get(commandId) === chained) this.#locks.delete(commandId);
    }
  }

  /** 쓰기 안에서는 아직 반영하지 않은 대응·승인·사건(overlay)을 함께 본다 */
  #toCommand(r: MemRow, overlay?: { actors: readonly MemoryCommandActor[]; approvals: readonly MemApproval[]; events: readonly MemoryCommandEvent[] }): Command {
    const actors = [...this.#actors.values(), ...(overlay?.actors ?? [])];
    const account = (ref: string): string | undefined => actors.find((a) => a.actorRef === ref)?.adminAccountId;
    const events = [...(this.#events.get(r.commandId) ?? []), ...(overlay?.events ?? [])];
    const dryRun = events.find((e) => e.type === 'DRY_RUN')?.dryRun ?? events.find((e) => e.type === 'DISPATCHED' && e.dryRun !== undefined)?.dryRun;
    const ackedAtMs = events.find((e) => e.type === 'ACKED')?.ackedAtMs;
    const approvals = [...this.#approvals, ...(overlay?.approvals ?? [])].filter((a) => a.commandId === r.commandId && a.round === 0).map((a) => account(a.approverRef) ?? '');
    const revertRequester = r.round > 0 ? actors.find((a) => a.commandId === r.commandId && a.round === r.round && a.side === 'REQUESTER') : undefined;
    return {
      commandId: r.commandId,
      type: r.type,
      state: r.state,
      reason: r.reason,
      params: r.params,
      requestedBy: account(r.requesterRef) ?? '',
      requesterRef: r.requesterRef,
      requestedRole: r.requestedRole,
      ...(r.eventId !== undefined ? { eventId: r.eventId } : {}),
      ...(r.approvalExpiresAtMs !== undefined ? { approvalExpiresAtMs: r.approvalExpiresAtMs } : {}),
      ...(r.expiresAtMs !== undefined ? { expiresAtMs: r.expiresAtMs } : {}),
      ...(r.compareDueAtMs !== undefined ? { compareDueAtMs: r.compareDueAtMs } : {}),
      round: r.round,
      ...(revertRequester ? { revertRequestedBy: revertRequester.adminAccountId } : {}),
      createdAtMs: r.createdAtMs,
      updatedAtMs: r.updatedAtMs,
      approvals,
      attempts: r.attempts,
      ...(r.lastError !== undefined ? { lastError: r.lastError } : {}),
      ...(r.executedAtMs !== undefined ? { executedAtMs: r.executedAtMs } : {}),
      ...(r.result !== undefined ? { result: r.result } : {}),
      ...(dryRun !== undefined ? { dryRun } : {}),
      ...(ackedAtMs !== undefined ? { ackedAtMs } : {}),
    };
  }

  #idemKey(idem: CommandIdempotency): string {
    return `${idem.accountRef}|${idem.operation}|${idem.key}`;
  }

  async replayOf(idem: CommandIdempotency, nowMs: number): Promise<string | undefined> {
    const seen = this.#idempotency.get(this.#idemKey(idem));
    if (!seen || seen.createdAtMs <= nowMs - IDEMPOTENCY_RETENTION_MS) return undefined;
    const hash = Buffer.from(idem.requestHash);
    if (seen.hash.length !== hash.length || !timingSafeEqual(seen.hash, hash)) throw idempotencyKeyReused();
    return seen.commandId;
  }

  async insert(input: NewCommand): Promise<{ command: Command; replayed: boolean }> {
    return this.#lock(input.commandId, async () => {
      if (input.idempotency) {
        const replayed = await this.replayOf(input.idempotency, input.nowMs);
        if (replayed) return { command: this.#toCommand(this.#rows.get(replayed)!), replayed: true };
      }
      if (this.#rows.has(input.commandId)) throw new Error(`이미 있는 명령이다: ${input.commandId}`);
      const requesterRef = randomUUID();
      const plan = planCreation(input, requesterRef);
      if (plan.actor) {
        const dup = [...this.#actors.values()].some((a) => a.commandId === input.commandId && a.round === 0 && isPersonSide(a.side) && a.adminAccountId === plan.actor!.accountId);
        if (dup) throw new DuplicateCommandActor();
      }
      const row: MemRow = {
        commandId: input.commandId,
        type: input.type,
        state: plan.state,
        reason: input.reason,
        params: input.params,
        requesterRef: plan.requesterRef,
        requestedRole: input.system ? 'system' : input.requestedRole,
        ...(input.eventId !== undefined ? { eventId: input.eventId } : {}),
        ...(plan.approvalExpiresAtMs !== undefined ? { approvalExpiresAtMs: plan.approvalExpiresAtMs } : {}),
        ...(plan.compareDueAtMs !== undefined ? { compareDueAtMs: plan.compareDueAtMs } : {}),
        round: 0,
        createdAtMs: input.nowMs,
        updatedAtMs: input.nowMs,
        attempts: plan.attempts,
      };
      this.#rows.set(row.commandId, row);
      if (plan.actor) this.#actors.set(plan.requesterRef, { actorRef: plan.requesterRef, commandId: row.commandId, round: 0, side: 'REQUESTER', adminAccountId: plan.actor.accountId, recordedAtMs: input.nowMs });
      this.#events.set(
        row.commandId,
        plan.events.map((e, i) => ({ commandId: row.commandId, seq: i + 1, ...e, createdAtMs: input.nowMs })),
      );
      if (input.idempotency) this.#idempotency.set(this.#idemKey(input.idempotency), { hash: Buffer.from(input.idempotency.requestHash), commandId: row.commandId, createdAtMs: input.nowMs });
      await this.audit.append({ recordType: plan.audit.recordType, recordId: row.commandId, payload: plan.audit.payload, nowMs: input.nowMs });
      return { command: this.#toCommand(row), replayed: false };
    });
  }

  async find(commandId: string): Promise<Command | undefined> {
    const r = this.#rows.get(commandId);
    return r ? this.#toCommand(r) : undefined;
  }

  async list(query: CommandListQuery): Promise<CommandPage> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    let items = [...this.#rows.values()]
      .filter((c) => query.eventId === undefined || c.eventId === query.eventId)
      .filter((c) => query.type === undefined || c.type === query.type)
      .filter((c) => query.states === undefined || query.states.includes(c.state))
      .filter((c) => query.updatedAfterMs === undefined || c.updatedAtMs > query.updatedAfterMs)
      .sort((a, b) => b.createdAtMs - a.createdAtMs || (a.commandId < b.commandId ? 1 : -1));
    if (cursor) items = items.filter((c) => c.createdAtMs < cursor.createdAtMs || (c.createdAtMs === cursor.createdAtMs && c.commandId < cursor.commandId));
    const page = items.slice(0, query.limit).map((r) => {
      const { dryRun: _d, ackedAtMs: _a, ...rest } = this.#toCommand(r);
      return rest;
    });
    const last = page.at(-1);
    return { items: page, ...(items.length > query.limit && last ? { nextCursor: encodeCursor(last) } : {}) };
  }

  async mutate<T>(commandId: string, fn: (w: CommandWriter) => Promise<T>): Promise<T | undefined> {
    if (!this.#rows.has(commandId)) return undefined;
    return this.#lock(commandId, () => this.#write(commandId, fn));
  }

  async #write<T>(commandId: string, fn: (w: CommandWriter) => Promise<T>): Promise<T | undefined> {
    const base = this.#rows.get(commandId);
    if (!base) return undefined;
    const draft: MemRow = { ...base };
    const newEvents: MemoryCommandEvent[] = [];
    const newActors: MemoryCommandActor[] = [];
    const newApprovals: MemApproval[] = [];
    const audits: { recordType: string; payload: Record<string, unknown>; nowMs: number }[] = [];
    const existingEvents = this.#events.get(commandId) ?? [];
    const allActors = () => [...this.#actors.values(), ...newActors];
    const store = this;
    // 그 쓰기 안에서 쓴 대응·승인·사건을 함께 본다
    const current = (): Command => store.#toCommand(draft, { actors: newActors, approvals: newApprovals, events: newEvents });
    const writer: CommandWriter = {
      get current() {
        return current();
      },
      async actor(side, round, accountId, nowMs) {
        if (isPersonSide(side) && allActors().some((a) => a.commandId === commandId && a.round === round && isPersonSide(a.side) && a.adminAccountId === accountId)) throw new DuplicateCommandActor();
        const actorRef = randomUUID();
        newActors.push({ actorRef, commandId, round, side, adminAccountId: accountId, recordedAtMs: nowMs });
        return actorRef;
      },
      async requesterOf(round) {
        const a = allActors().find((x) => x.commandId === commandId && x.round === round && x.side === 'REQUESTER');
        if (a) return { ref: a.actorRef, accountId: a.adminAccountId };
        return round === 0 ? { ref: draft.requesterRef } : undefined;
      },
      async decidedIn(round) {
        return [...store.#approvals, ...newApprovals].some((a) => a.commandId === commandId && a.round === round);
      },
      async event(e: NewCommandEvent) {
        newEvents.push({
          commandId,
          seq: existingEvents.length + newEvents.length + 1,
          type: e.type,
          actorRef: e.actorRef,
          actorRole: e.actorRole,
          reason: e.reason,
          ...(e.dryRun !== undefined ? { dryRun: e.dryRun } : {}),
          ...(e.detail !== undefined ? { detail: e.detail } : {}),
          ...(e.ackedAtMs !== undefined ? { ackedAtMs: e.ackedAtMs } : {}),
          createdAtMs: e.nowMs,
        });
      },
      async patch(p: CommandPatch) {
        if (p.state !== undefined) draft.state = p.state;
        const optional = <K extends 'approvalExpiresAtMs' | 'expiresAtMs' | 'compareDueAtMs' | 'executedAtMs' | 'lastError' | 'result'>(k: K, v: MemRow[K] | null | undefined) => {
          if (v === undefined) return;
          if (v === null) delete draft[k];
          else draft[k] = v;
        };
        optional('approvalExpiresAtMs', p.approvalExpiresAtMs);
        optional('expiresAtMs', p.expiresAtMs);
        optional('compareDueAtMs', p.compareDueAtMs);
        optional('executedAtMs', p.executedAtMs);
        optional('lastError', p.lastError);
        optional('result', p.result);
        if (p.attempts !== undefined) draft.attempts = p.attempts;
        if (p.round !== undefined) draft.round = p.round;
        draft.updatedAtMs = p.nowMs;
      },
      async approval(a) {
        newApprovals.push({ ...a, commandId });
      },
      async audit(recordType, payload, nowMs) {
        audits.push({ recordType, payload, nowMs });
      },
    };
    const result = await fn(writer);
    // 모두 성공했을 때만 반영한다(한 트랜잭션처럼)
    this.#rows.set(commandId, draft);
    for (const a of newActors) this.#actors.set(a.actorRef, a);
    this.#approvals.push(...newApprovals);
    this.#events.set(commandId, [...existingEvents, ...newEvents]);
    for (const a of audits) await this.audit.append({ recordType: a.recordType, recordId: commandId, payload: a.payload, nowMs: a.nowMs });
    return result;
  }

  #due(kind: CommandDueKind, nowMs: number, r: MemRow): boolean {
    if (kind === 'APPROVAL_EXPIRED') return r.state === 'PENDING_APPROVAL' && r.approvalExpiresAtMs !== undefined && r.approvalExpiresAtMs <= nowMs;
    if (kind === 'REVERT_EXPIRED') return r.state === 'REVERT_PENDING' && r.approvalExpiresAtMs !== undefined && r.approvalExpiresAtMs <= nowMs;
    return r.state === 'ACKED' && AUTO_EXPIRE_TYPES.includes(r.type) && r.expiresAtMs !== undefined && r.expiresAtMs <= nowMs;
  }

  async mutateDue(kind: CommandDueKind, nowMs: number, fn: (w: CommandWriter) => Promise<void>): Promise<boolean> {
    // 잠긴 명령은 건너뛴다(SKIP LOCKED와 같다)
    const row = [...this.#rows.values()].find((r) => this.#due(kind, nowMs, r) && !this.#locks.has(r.commandId));
    if (!row) return false;
    await this.mutate(row.commandId, fn);
    return true;
  }

  async dueForCompare(nowMs: number, limit: number): Promise<readonly string[]> {
    return [...this.#rows.values()]
      .filter((r) => r.compareDueAtMs !== undefined && r.compareDueAtMs <= nowMs)
      .sort((a, b) => a.compareDueAtMs! - b.compareDueAtMs!)
      .slice(0, limit)
      .map((r) => r.commandId);
  }

  async purgeActors(beforeMs: number): Promise<number> {
    let n = 0;
    for (const [ref, a] of this.#actors) {
      if (a.recordedAtMs < beforeMs && a.deleteHoldRef === undefined) {
        this.#actors.delete(ref);
        n += 1;
      }
    }
    return n;
  }
}
