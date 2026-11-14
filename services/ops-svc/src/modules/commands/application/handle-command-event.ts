// 명령 요청·결과 사건의 멱등 처리(BAT-465 GAT-300, R-584 Kafka 소비자).
// HTTP(/internal/v1/ops/command-events)와 Kafka(ops.command-events)가 같은 함수를 쓴다. 그래서 두 길로 같은 사건이 와도 한 번만 만든다.
// eventKey로 명령 ID를 결정하고, 결과 사건은 실행을 시작한(DISPATCHED) 명령만 끝낸다(승인 대기·승인됨 명령을 결과로 끝내면 승인을 우회한다).
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { CreateCommand } from './create-command.js';
import { COMMAND_TYPES } from '../domain/command.js';
import type { CommandStore } from '../domain/ports.js';

export const CommandEventBody = z.discriminatedUnion('kind', [
  z
    .object({
      eventKey: z.string().min(1).max(200),
      kind: z.literal('COMMAND_REQUESTED'),
      type: z.enum(COMMAND_TYPES),
      reason: z.string().min(1).max(2000),
      params: z.record(z.string(), z.unknown()).optional(),
      requestedBy: z.string().min(1),
      requestedRole: z.string().min(1),
      occurredAt: z.iso.datetime().optional(),
    })
    .strict(),
  z
    .object({
      eventKey: z.string().min(1).max(200),
      kind: z.literal('COMMAND_RESULT'),
      commandId: z.uuid(),
      status: z.enum(['SUCCEEDED', 'FAILED']),
      detail: z.record(z.string(), z.unknown()).optional(),
      error: z.string().max(2000).optional(),
      occurredAt: z.iso.datetime().optional(),
    })
    .strict(),
]);
export type CommandEventBody = z.output<typeof CommandEventBody>;
export type CommandEvent = CommandEventBody;
export const CommandEventResponse = z.object({ accepted: z.boolean(), commandId: z.uuid().optional() });
export type CommandEventResponse = z.output<typeof CommandEventResponse>;

/** eventKey를 UUIDv5 비슷한 결정적 ID로 바꾼다(같은 사건 재수신 멱등) */
export function commandIdOfEventKey(eventKey: string): string {
  const h = createHash('sha256').update(`ops-command:${eventKey}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x40;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export interface HandleCommandEventDeps {
  readonly createCommand: CreateCommand;
  readonly store: CommandStore;
}

/** 한 사건을 받아 처리한다. 받지 않으면 accepted 거짓이고 아무것도 쓰지 않는다 */
export class HandleCommandEvent {
  constructor(private readonly deps: HandleCommandEventDeps) {}

  async run(e: CommandEventBody, nowMs: number): Promise<CommandEventResponse> {
    const { createCommand, store } = this.deps;
    const at = e.occurredAt ? Date.parse(e.occurredAt) : nowMs;
    if (e.kind === 'COMMAND_REQUESTED') {
      const commandId = commandIdOfEventKey(e.eventKey);
      const existing = await store.find(commandId);
      if (existing) {
        // 같은 eventKey에 다른 내용을 실으면 조용히 처음 것을 돌려주지 않는다(멱등 키 재사용 탐지).
        const same = existing.type === e.type && existing.reason === e.reason && isDeepStrictEqual(existing.params, e.params ?? {});
        return same ? { accepted: true, commandId: existing.commandId } : { accepted: false };
      }
      try {
        const command = await createCommand.execute({
          commandId,
          type: e.type,
          reason: e.reason,
          params: e.params ?? {},
          requestedBy: e.requestedBy,
          requestedRole: e.requestedRole,
          nowMs,
          actor: { accountId: e.requestedBy, sessionId: '', role: e.requestedRole },
        });
        return { accepted: true, commandId: command.commandId };
      } catch {
        const again = await store.find(commandId);
        return again ? { accepted: true, commandId: again.commandId } : { accepted: false };
      }
    }
    const current = await store.find(e.commandId);
    if (!current) return { accepted: false };
    // 결과 사건은 이미 실행을 시작한 명령에만 적용한다.
    if (current.state === 'SUCCEEDED' || current.state === 'FAILED') return { accepted: true, commandId: current.commandId };
    if (current.state !== 'DISPATCHED') return { accepted: false };
    if (e.status === 'SUCCEEDED') await store.markSucceeded(e.commandId, e.detail, nowMs);
    else await store.markDispatchFailed(e.commandId, e.error ?? 'external-result-failed', nowMs);
    return { accepted: true, commandId: e.commandId };
  }
}
