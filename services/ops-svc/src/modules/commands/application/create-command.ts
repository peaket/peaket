// 운영 명령 접수(GAT-110 첫 몫). 사유·유형·params를 검사하고 2인 명령은 PENDING_APPROVAL로 둔다.
import { randomUUID } from 'node:crypto';
import { ProblemError } from '@peaket/platform';
import { z } from 'zod';
import { COMMAND_TYPES, type Command, type CommandType } from '../domain/command.js';
import type { CommandStore } from '../domain/ports.js';

export interface CreateCommandInput {
  readonly type: CommandType;
  readonly reason: string;
  readonly params: Record<string, unknown>;
  readonly requestedBy: string;
  readonly requestedRole: string;
  readonly nowMs: number;
}

const CONTROL = /[\u0000-\u001f\u007f]/;

/** 유형별 params의 회차 ID를 꺼낸다(목록 필터용). eventIds 배열이면 첫 회차, eventId 글자면 그 값 */
export function eventIdOf(params: Record<string, unknown>): string | undefined {
  if (typeof params.eventId === 'string') return params.eventId;
  if (Array.isArray(params.eventIds) && typeof params.eventIds[0] === 'string') return params.eventIds[0];
  return undefined;
}

export class CreateCommand {
  constructor(private readonly store: CommandStore) {}

  async execute(input: CreateCommandInput): Promise<Command> {
    if (!COMMAND_TYPES.includes(input.type)) throw new ProblemError({ type: 'invalid-command', status: 422, title: '명령 값이 올바르지 않습니다' });
    const reason = input.reason.trim();
    if (reason.length === 0 || reason.length > 2000 || CONTROL.test(reason)) throw new ProblemError({ type: 'invalid-command', status: 422, title: '명령 값이 올바르지 않습니다' });
    if (typeof input.params !== 'object' || input.params === null || Array.isArray(input.params)) throw new ProblemError({ type: 'invalid-command', status: 422, title: '명령 값이 올바르지 않습니다' });
    const eventId = eventIdOf(input.params);
    if (eventId !== undefined && !z.uuid().safeParse(eventId).success) throw new ProblemError({ type: 'invalid-command', status: 422, title: '명령 값이 올바르지 않습니다' });
    const commandId = randomUUID();
    return this.store.create({
      commandId,
      type: input.type,
      reason,
      params: input.params,
      requestedBy: input.requestedBy,
      requestedRole: input.requestedRole,
      ...(eventId !== undefined ? { eventId } : {}),
      nowMs: input.nowMs,
    });
  }
}
