// 명령 요청·결과·자동 조치 사건의 멱등 처리(BAT-465 GAT-300, R-584 Kafka 소비자, ADR-0340 결정 6).
// HTTP(/internal/v1/ops/command-events)와 Kafka(ops.command-events)가 같은 함수를 쓴다. 그래서 두 길로 같은 사건이 와도 한 번만 만든다.
// eventKey로 명령 ID를 결정하고, 결과 사건은 실행을 시작한(DISPATCHED) 명령만 끝낸다(승인 대기·승인됨 명령을 결과로 끝내면 승인을 우회한다).
// 자동 조치(AUTO_ACTION)는 명령 1의 목표 낮추기뿐이고 행위자 SYSTEM으로 승인 없이 DISPATCHED를 만든다(T12). 뒤의 COMMAND_RESULT(ACKED)로 끝낸다.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { CreateCommand } from './create-command.js';
import { COMMAND_TYPES, SYSTEM_ROLE } from '../domain/command.js';
import { checkCommandParams, CommandInputRejected, normalizeReason } from '../domain/command-params.js';
import type { CommandStore } from '../domain/ports.js';

export const CommandEventBody = z.discriminatedUnion('kind', [
  z
    .object({
      eventKey: z.string().min(1).max(200),
      kind: z.literal('COMMAND_REQUESTED'),
      type: z.enum(COMMAND_TYPES),
      reason: z.string().min(1).max(2000),
      params: z.record(z.string(), z.unknown()).optional(),
      requestedBy: z.uuid(),
      requestedRole: z.string().min(1),
      occurredAt: z.iso.datetime().optional(),
    })
    .strict(),
  z
    .object({
      eventKey: z.string().min(1).max(200),
      kind: z.literal('COMMAND_RESULT'),
      commandId: z.uuid(),
      status: z.enum(['SUCCEEDED', 'ACKED', 'FAILED']),
      detail: z.record(z.string(), z.unknown()).optional(),
      error: z.string().max(2000).optional(),
      ackedAt: z.iso.datetime().optional(),
      occurredAt: z.iso.datetime().optional(),
    })
    .strict(),
  z
    .object({
      eventKey: z.string().min(1).max(200),
      kind: z.literal('AUTO_ACTION'),
      // 받는 유형은 명령 1의 목표 낮추기뿐이다(AIMD·버짓 연동 감축, control-tower §4)
      type: z.literal('ADMISSION_TARGET'),
      params: z.object({ eventId: z.uuid(), target: z.number().int(), fromTarget: z.number().int() }).strict(),
      reason: z.string().min(1).max(2000),
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
    if (e.kind === 'COMMAND_REQUESTED') {
      const commandId = commandIdOfEventKey(e.eventKey);
      const existing = await store.find(commandId);
      if (existing) {
        // 같은 eventKey에 다른 내용을 실으면 조용히 처음 것을 돌려주지 않는다(멱등 키 재사용 탐지).
        const same = existing.type === e.type && existing.reason === e.reason.trim().normalize('NFC') && isDeepStrictEqual(existing.params, e.params ?? {});
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
    if (e.kind === 'AUTO_ACTION') return this.#autoAction(e, nowMs);
    const current = await store.find(e.commandId);
    if (!current) return { accepted: false };
    // 결과 사건은 이미 실행을 시작한 명령에만 적용한다.
    if (current.state === 'SUCCEEDED' || current.state === 'ACKED' || current.state === 'FAILED') return { accepted: true, commandId: current.commandId };
    if (current.state !== 'DISPATCHED') return { accepted: false };
    if (e.status === 'FAILED') await store.markDispatchFailed(e.commandId, e.error ?? 'external-result-failed', nowMs);
    else await store.markSucceeded(e.commandId, e.detail, nowMs, e.ackedAt !== undefined ? Date.parse(e.ackedAt) : undefined);
    return { accepted: true, commandId: e.commandId };
  }

  /** 자동 조치(T12): 목표를 낮추는 것만, 안전 하한 아래로는 받지 않는다. 같은 eventKey는 한 번만 만든다 */
  async #autoAction(e: Extract<CommandEventBody, { kind: 'AUTO_ACTION' }>, nowMs: number): Promise<CommandEventResponse> {
    const { createCommand, store } = this.deps;
    const commandId = commandIdOfEventKey(e.eventKey);
    let reason: string;
    let params: Record<string, unknown>;
    try {
      reason = normalizeReason(e.reason);
      params = checkCommandParams(e.type, e.params, nowMs);
    } catch (err) {
      if (err instanceof CommandInputRejected) return { accepted: false };
      throw err;
    }
    if (e.params.target >= e.params.fromTarget) return { accepted: false };
    const existing = await store.find(commandId);
    if (existing) {
      const same = existing.type === e.type && existing.reason === reason && isDeepStrictEqual(existing.params, params) && existing.requestedRole === SYSTEM_ROLE;
      return same ? { accepted: true, commandId } : { accepted: false };
    }
    const dryRun = await createCommand.dryRun.compute({ type: e.type, params, eventId: e.params.eventId }, nowMs);
    try {
      await store.create({
        commandId,
        type: e.type,
        reason,
        params,
        requestedBy: '',
        requestedRole: SYSTEM_ROLE,
        eventId: e.params.eventId,
        nowMs,
        dryRun: dryRun as unknown as Record<string, unknown>,
        system: true,
      });
    } catch {
      // 두 길(HTTP·Kafka)로 같은 사건이 겹쳐 왔다: 먼저 만든 쪽이 있으면 받은 것으로 본다
      const again = await store.find(commandId);
      return again ? { accepted: true, commandId } : { accepted: false };
    }
    return { accepted: true, commandId };
  }
}
