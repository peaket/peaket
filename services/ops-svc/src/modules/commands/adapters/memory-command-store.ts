// 시험용 메모리 명령 저장소. 감사 체인은 MemoryAuditChain을 쓴다.
import { APPROVAL_TTL_MS, approvalModeOf, stateAfterCreate, type Command, type CommandState, type CommandType, type NewCommand } from '../domain/command.js';
import type { CommandDecision, CommandListQuery, CommandPage, CommandStore } from '../domain/ports.js';
import type { AuditChain } from '../../audit/audit.js';

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

export class MemoryCommandStore implements CommandStore {
  readonly #byId = new Map<string, Command>();

  constructor(private readonly audit: AuditChain) {}

  async create(input: NewCommand): Promise<Command> {
    const mode = approvalModeOf(input.type);
    const state = stateAfterCreate(mode);
    const command: Command = {
      commandId: input.commandId,
      type: input.type,
      state,
      reason: input.reason,
      params: input.params,
      requestedBy: input.requestedBy,
      requestedRole: input.requestedRole,
      ...(input.eventId !== undefined ? { eventId: input.eventId } : {}),
      ...(mode === 'TWO' ? { approvalExpiresAtMs: input.nowMs + APPROVAL_TTL_MS } : {}),
      createdAtMs: input.nowMs,
      updatedAtMs: input.nowMs,
      approvals: [],
    };
    this.#byId.set(command.commandId, command);
    await this.audit.append({ recordType: 'COMMAND_CREATED', recordId: command.commandId, payload: { type: command.type, state: command.state, requestedBy: command.requestedBy, reason: command.reason }, nowMs: input.nowMs });
    return command;
  }

  async find(commandId: string): Promise<Command | undefined> {
    return this.#byId.get(commandId);
  }

  async list(query: CommandListQuery): Promise<CommandPage> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    let items = [...this.#byId.values()]
      .filter((c) => (query.eventId === undefined || c.eventId === query.eventId))
      .filter((c) => (query.type === undefined || c.type === query.type))
      .filter((c) => (query.states === undefined || query.states.includes(c.state)))
      .sort((a, b) => b.createdAtMs - a.createdAtMs || (a.commandId < b.commandId ? 1 : -1));
    if (cursor) items = items.filter((c) => c.createdAtMs < cursor.createdAtMs || (c.createdAtMs === cursor.createdAtMs && c.commandId < cursor.commandId));
    const page = items.slice(0, query.limit);
    const last = page.at(-1);
    return { items: page, ...(items.length > query.limit && last ? { nextCursor: encodeCursor(last) } : {}) };
  }

  async approve(commandId: string, approverRef: string, approverRole: string, nowMs: number): Promise<CommandDecision> {
    return this.#decide(commandId, approverRef, approverRole, 'APPROVED', undefined, nowMs);
  }

  async reject(commandId: string, approverRef: string, approverRole: string, reason: string, nowMs: number): Promise<CommandDecision> {
    return this.#decide(commandId, approverRef, approverRole, 'REJECTED', reason, nowMs);
  }

  async #decide(commandId: string, approverRef: string, approverRole: string, decision: 'APPROVED' | 'REJECTED', reason: string | undefined, nowMs: number): Promise<CommandDecision> {
    const current = this.#byId.get(commandId);
    if (!current) return { status: 'NOT_FOUND' };
    if (current.state !== 'PENDING_APPROVAL') return { status: 'NOT_PENDING' };
    if (current.requestedBy === approverRef) return { status: 'SAME_ACTOR' };
    const command: Command = {
      ...current,
      state: decision,
      updatedAtMs: nowMs,
      approvals: [...current.approvals, approverRef],
      approvalExpiresAtMs: undefined,
    };
    this.#byId.set(commandId, command);
    await this.audit.append({ recordType: decision === 'APPROVED' ? 'COMMAND_APPROVED' : 'COMMAND_REJECTED', recordId: commandId, payload: { decision, approverRef, approverRole, ...(reason !== undefined ? { reason } : {}) }, nowMs });
    return { status: 'APPLIED', command };
  }
}
