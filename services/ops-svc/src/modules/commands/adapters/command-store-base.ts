// 두 명령 저장소(PostgreSQL·메모리)가 함께 쓰는 높은 쪽 쓰기. 규칙은 도메인 command-writes.ts에 있고, 여기서는 잠근 쓰기(mutate)에 묶기만 한다.
import type { Command, NewCommand } from '../domain/command.js';
import { writeDecision, writeDispatched, writeFailed, writeSucceeded } from '../domain/command-writes.js';
import {
  DuplicateCommandActor,
  type CommandDecision,
  type CommandDueKind,
  type CommandListQuery,
  type CommandPage,
  type CommandStore,
  type CommandWriter,
} from '../domain/ports.js';
import type { CommandIdempotency } from '../domain/command.js';

const missing = (commandId: string): never => {
  throw new Error(`명령이 없다: ${commandId}`);
};

export abstract class CommandStoreBase implements CommandStore {
  abstract insert(input: NewCommand): Promise<{ readonly command: Command; readonly replayed: boolean }>;

  async create(input: NewCommand): Promise<Command> {
    return (await this.insert(input)).command;
  }
  abstract replayOf(idem: CommandIdempotency, nowMs: number): Promise<string | undefined>;
  abstract find(commandId: string): Promise<Command | undefined>;
  abstract list(query: CommandListQuery): Promise<CommandPage>;
  abstract mutate<T>(commandId: string, fn: (w: CommandWriter) => Promise<T>): Promise<T | undefined>;
  abstract mutateDue(kind: CommandDueKind, nowMs: number, fn: (w: CommandWriter) => Promise<void>): Promise<boolean>;
  abstract dueForCompare(nowMs: number, limit: number): Promise<readonly string[]>;
  abstract purgeActors(beforeMs: number): Promise<number>;

  async #decide(commandId: string, accountId: string, role: string, decision: 'APPROVED' | 'REJECTED', reason: string | undefined, nowMs: number): Promise<CommandDecision> {
    try {
      const d = await this.mutate(commandId, (w) => writeDecision(w, { accountId, role, decision, ...(reason !== undefined ? { reason } : {}), nowMs }));
      return d ?? { status: 'NOT_FOUND' };
    } catch (e) {
      // 같은 사람이 같은 회차에 두 번(유일 제약). 트랜잭션째 되돌아가 승인 행이 남지 않는다
      if (e instanceof DuplicateCommandActor) return { status: 'DUPLICATE' };
      throw e;
    }
  }

  approve(commandId: string, approverRef: string, approverRole: string, nowMs: number): Promise<CommandDecision> {
    return this.#decide(commandId, approverRef, approverRole, 'APPROVED', undefined, nowMs);
  }

  reject(commandId: string, approverRef: string, approverRole: string, reason: string, nowMs: number): Promise<CommandDecision> {
    return this.#decide(commandId, approverRef, approverRole, 'REJECTED', reason, nowMs);
  }

  async markDispatched(commandId: string, nowMs: number, actor?: { readonly accountId: string; readonly role: string; readonly ref?: string }): Promise<Command> {
    return (await this.mutate(commandId, (w) => writeDispatched(w, { nowMs, ...(actor ? { actor } : {}) }))) ?? missing(commandId);
  }

  async markSucceeded(commandId: string, result: Record<string, unknown> | undefined, nowMs: number, ackedAtMs?: number): Promise<Command> {
    return (await this.mutate(commandId, (w) => writeSucceeded(w, { ...(result !== undefined ? { result } : {}), ...(ackedAtMs !== undefined ? { ackedAtMs } : {}), nowMs }))) ?? missing(commandId);
  }

  async markDispatchFailed(commandId: string, reason: string, nowMs: number): Promise<Command> {
    return (await this.mutate(commandId, (w) => writeFailed(w, { reason, nowMs }))) ?? missing(commandId);
  }
}

/** 목록 커서(만든 시각, 명령 ID) */
export const encodeCursor = (c: Command): string => Buffer.from(JSON.stringify([c.createdAtMs, c.commandId]), 'utf8').toString('base64url');
export const decodeCursor = (raw: string): { createdAtMs: number; commandId: string } | undefined => {
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(v) || typeof v[0] !== 'number' || typeof v[1] !== 'string') return undefined;
    return { createdAtMs: v[0], commandId: v[1] };
  } catch {
    return undefined;
  }
};
