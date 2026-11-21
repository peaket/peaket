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
import { POST_REVIEW_TYPES, type PostReviewAlertKind, type PostReviewRow, type PostReviewWriter } from '../domain/post-review.js';
import type { CommandTimelineEntry } from '../domain/ports.js';
import type { OutboxMessage } from '@peaket/platform';
import type { SettingChange } from '../domain/ports.js';
import { settingOutboxMessage } from './settings-outbox.js';

/** 메모리 Outbox 한 줄(설정 사건과 그 Kafka 메시지) */
export interface MemoryOutboxSetting {
  readonly setting: SettingChange;
  readonly message: OutboxMessage;
}

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
  /** 사후 검토 행(command_post_review와 같은 칸, ADR-0349 결정 7) */
  readonly #postReviews = new Map<string, PostReviewRow>();
  /** 설정 사건 Outbox(ops DB outbox와 같은 메시지, ADR-0349 결정 5) */
  readonly #outbox: MemoryOutboxSetting[] = [];

  constructor(private readonly audit: AuditChain) {
    super();
  }

  /** 시험용: 쓰기가 성공해 남은 설정 사건(차례대로) */
  outboxSettings(): readonly MemoryOutboxSetting[] {
    return [...this.#outbox];
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
    const postReviewDueAtMs = this.#postReviews.get(r.commandId)?.dueAtMs;
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
      ...(postReviewDueAtMs !== undefined ? { postReviewDueAtMs } : {}),
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
        ...(plan.expiresAtMs !== undefined ? { expiresAtMs: plan.expiresAtMs } : {}),
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
    const newSettings: MemoryOutboxSetting[] = [];
    const existingEvents = this.#events.get(commandId) ?? [];
    const allActors = () => [...this.#actors.values(), ...newActors];
    const store = this;
    // 그 쓰기 안에서 쓴 대응·승인·사건을 함께 본다
    const current = (): Command => store.#toCommand(draft, { actors: newActors, approvals: newApprovals, events: newEvents });
    let review: PostReviewRow | undefined;
    const writer: CommandWriter = {
      get current() {
        return current();
      },
      async actor(side, round, accountId, nowMs, given) {
        if (isPersonSide(side) && allActors().some((a) => a.commandId === commandId && a.round === round && isPersonSide(a.side) && a.adminAccountId === accountId)) throw new DuplicateCommandActor();
        const actorRef = given ?? randomUUID();
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
      // 설정 사건(ADR-0349 결정 5): DB와 같은 꼴 검사(settingOutboxMessage)를 지난 메시지를 쓰기가 성공할 때만 남긴다
      async setting(s: SettingChange) {
        newSettings.push({ setting: s, message: settingOutboxMessage(s) });
      },
      postReviews: this.#postReviewWriter(commandId, () => [...existingEvents, ...newEvents], (r) => (review = r)),
    };
    const result = await fn(writer);
    // 모두 성공했을 때만 반영한다(한 트랜잭션처럼)
    if (review) this.#postReviews.set(commandId, review);
    this.#rows.set(commandId, draft);
    for (const a of newActors) this.#actors.set(a.actorRef, a);
    this.#approvals.push(...newApprovals);
    this.#events.set(commandId, [...existingEvents, ...newEvents]);
    this.#outbox.push(...newSettings);
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

  /** 쓰기 하나의 사후 검토 쓰기. 바꾼 행은 put으로 넘기고, 쓰기가 성공하면 반영한다(조건은 command_post_review의 조건부 갱신과 같다) */
  #postReviewWriter(commandId: string, events: () => readonly MemoryCommandEvent[], put: (r: PostReviewRow) => void): PostReviewWriter {
    let row = this.#postReviews.get(commandId);
    const set = (r: PostReviewRow): true => {
      row = r;
      put(r);
      return true;
    };
    return {
      async read() {
        return row;
      },
      async firstDispatchedAtMs() {
        return events().find((e) => e.type === 'DISPATCHED')?.createdAtMs;
      },
      async open(r) {
        if (row) return false;
        return set({ commandId, executorRef: r.executorRef, dueAtMs: r.dueAtMs, soloSelfReview: false, late: false });
      },
      async submit(r) {
        if (!row || row.submittedAtMs !== undefined) return false;
        return set({ ...row, submittedAtMs: r.submittedAtMs, report: r.report, confirmDueAtMs: r.confirmDueAtMs, late: row.late || r.late });
      },
      async confirm(r) {
        if (!row || row.submittedAtMs === undefined || row.confirmedAtMs !== undefined) return false;
        return set({ ...row, confirmedAtMs: r.confirmedAtMs, reviewerRef: r.reviewerRef, assessment: r.assessment, soloSelfReview: r.soloSelfReview, late: row.late || r.late });
      },
      async markAlerted(kind: PostReviewAlertKind, nowMs: number) {
        if (!row) return false;
        if (kind === 'DUE') {
          if (row.submittedAtMs !== undefined || row.dueAlertedAtMs !== undefined || nowMs < row.dueAtMs) return false;
          return set({ ...row, dueAlertedAtMs: nowMs });
        }
        if (row.submittedAtMs === undefined || row.confirmedAtMs !== undefined || row.confirmAlertedAtMs !== undefined || row.confirmDueAtMs === undefined || nowMs < row.confirmDueAtMs) return false;
        return set({ ...row, confirmAlertedAtMs: nowMs });
      },
    };
  }

  async postReviewOf(commandId: string): Promise<PostReviewRow | undefined> {
    return this.#postReviews.get(commandId);
  }

  async postReviewsDue(nowMs: number, limit: number): Promise<readonly { commandId: string; kind: PostReviewAlertKind }[]> {
    const due: { commandId: string; kind: PostReviewAlertKind; t: number }[] = [];
    for (const r of this.#postReviews.values()) {
      if (r.submittedAtMs === undefined && r.dueAlertedAtMs === undefined && r.dueAtMs <= nowMs) due.push({ commandId: r.commandId, kind: 'DUE', t: r.dueAtMs });
      else if (r.submittedAtMs !== undefined && r.confirmedAtMs === undefined && r.confirmAlertedAtMs === undefined && r.confirmDueAtMs !== undefined && r.confirmDueAtMs <= nowMs) {
        due.push({ commandId: r.commandId, kind: 'CONFIRM', t: r.confirmDueAtMs });
      }
    }
    return due
      .sort((a, b) => a.t - b.t)
      .slice(0, limit)
      .map(({ commandId, kind }) => ({ commandId, kind }));
  }

  async postReviewsToOpen(limit: number): Promise<readonly string[]> {
    return [...this.#rows.values()]
      .filter((r) => POST_REVIEW_TYPES.includes(r.type) && r.attempts > 0 && !this.#postReviews.has(r.commandId) && (this.#events.get(r.commandId) ?? []).some((e) => e.type === 'DISPATCHED'))
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .slice(0, limit)
      .map((r) => r.commandId);
  }

  async timelineOf(commandId: string): Promise<readonly CommandTimelineEntry[]> {
    return (this.#events.get(commandId) ?? []).map((e) => {
      const account = this.#actors.get(e.actorRef)?.adminAccountId;
      return { seq: e.seq, type: e.type, actorRef: e.actorRef, actorRole: e.actorRole, ...(account !== undefined ? { actorAccountId: account } : {}), reason: e.reason, createdAtMs: e.createdAtMs };
    });
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
