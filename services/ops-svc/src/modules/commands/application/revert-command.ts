// 되돌리기(T13·T14·T15)와 명령 2 연장(ADR-0340 결정 5). ACKED인 카탈로그 명령만 되돌린다.
// 명령 3·11은 commander 요청 → REVERT_PENDING(202) → 요청자 아닌 operator 이상의 승인(DecideCommand) 뒤 보낸다.
// 그 밖은 그 유형을 낼 수 있는 역할 1인이 보내고 REVERTED(200). 보내지 못하면 ACKED 그대로·REVERT_FAILED 사건·502 command-dispatch-failed다.
import { ProblemError } from '@peaket/platform';
import type { Command, CommandExecutionActor } from '../domain/command.js';
import { CommandInputRejected, normalizeReason } from '../domain/command-params.js';
import { writeExtendResult, writeExtendStart, writeRevertRequest, writeRevertResult, writeSettingChange } from '../domain/command-writes.js';
import { isSettingCommand } from '../domain/setting-commands.js';
import type { CommandExecutor, CommandSendResult, CommandStore } from '../domain/ports.js';

const notFound = (): ProblemError => new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
const roleForbidden = (): ProblemError => new ProblemError({ type: 'command-role-forbidden', status: 403, title: '이 명령을 할 수 있는 역할이 아닙니다' });
export const dispatchFailed = (detail: string): ProblemError =>
  new ProblemError({ type: 'command-dispatch-failed', status: 502, title: '명령을 대상에 보내지 못했습니다. 다시 시도해 주세요', detail });

const reasonOf = (raw: string): string => {
  try {
    return normalizeReason(raw);
  } catch (e) {
    if (e instanceof CommandInputRejected) throw new ProblemError({ type: 'invalid-command', status: 422, title: '명령 값이 올바르지 않습니다' });
    throw e;
  }
};

/** 실행기를 부르고 결과를 FAILED/ACKED로 고른다(던지거나 없으면 보내지 못한 것) */
async function send(call: (() => Promise<CommandSendResult>) | undefined): Promise<CommandSendResult> {
  if (!call) return { status: 'FAILED', error: 'target-not-wired' };
  try {
    return await call();
  } catch (e) {
    return { status: 'FAILED', error: e instanceof Error ? e.message : 'send-failed' };
  }
}

/**
 * 되돌림을 보내고 결과를 남긴다. 받으면 REVERTED, 보내지 못하면 ACKED 그대로와 502다.
 * @throws ProblemError 502 command-dispatch-failed
 */
export async function sendRevert(
  store: CommandStore,
  executor: CommandExecutor | undefined,
  command: Command,
  actor: CommandExecutionActor,
  q: { actorRef: string; actorRole: string; fromPending: boolean },
  nowMs: number,
): Promise<Command> {
  if (isSettingCommand(command.type)) {
    const previousBotLevel =
      command.type === 'BOT_LEVEL'
        ? (await store.list({ type: 'BOT_LEVEL', states: ['ACKED'], limit: 100 })).items
            .filter((c) => c.commandId !== command.commandId)
            .sort((a, b) => b.createdAtMs - a.createdAtMs)[0]?.params
        : undefined;
    const out = await store.mutate(command.commandId, async (w) => {
      try {
        const ok = await writeSettingChange(w, { phase: 'REVERT', nowMs, ...(previousBotLevel !== undefined ? { previousBotLevel } : {}) });
        if (!ok) return { ok: false, error: 'settings-outbox-not-wired', command: w.current };
        return { ok: await writeRevertResult(w, { ok: true, ...q, nowMs }), command: w.current };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'settings-outbox-not-wired', command: w.current };
      }
    });
    if (!out) throw notFound();
    if (!out.ok) throw dispatchFailed(out.error ?? 'settings-outbox-not-wired');
    return out.command;
  }
  const r = await send(executor?.revert ? () => executor.revert!(command, actor) : undefined);
  const error = r.status === 'FAILED' ? r.error : undefined;
  const out = await store.mutate(command.commandId, async (w) => ({ ok: await writeRevertResult(w, { ok: r.status === 'ACKED', ...(error !== undefined ? { error } : {}), ...q, nowMs }), command: w.current }));
  if (!out) throw notFound();
  if (!out.ok) throw dispatchFailed(error ?? 'state-changed');
  return out.command;
}

export class RevertCommand {
  constructor(
    private readonly store: CommandStore,
    private readonly executor?: CommandExecutor,
  ) {}

  /**
   * @returns pending 참이면 두 번째 승인 대기(202), 거짓이면 되돌림(200)
   * @throws ProblemError 404, 403 command-role-forbidden, 409 command-not-revertible, 502 command-dispatch-failed, 422 invalid-command
   */
  async execute(q: { commandId: string; reason: string; actor: CommandExecutionActor; nowMs: number }): Promise<{ command: Command; pending: boolean }> {
    const reason = reasonOf(q.reason);
    const start = await this.store.mutate(q.commandId, (w) => writeRevertRequest(w, { accountId: q.actor.accountId, role: q.actor.role, reason, nowMs: q.nowMs }));
    if (!start) throw notFound();
    if (start.status === 'NOT_REVERTIBLE') throw new ProblemError({ type: 'command-not-revertible', status: 409, title: '되돌릴 수 있는 명령이 아닙니다' });
    if (start.status === 'ROLE_FORBIDDEN') throw roleForbidden();
    if (start.status === 'PENDING') return { command: start.command, pending: true };
    const command = await sendRevert(this.store, this.executor, start.command, q.actor, { actorRef: start.actorRef, actorRole: start.actorRole, fromPending: false }, q.nowMs);
    return { command, pending: false };
  }
}

export class ExtendCommand {
  constructor(
    private readonly store: CommandStore,
    private readonly executor?: CommandExecutor,
  ) {}

  /**
   * 명령 2만, ACKED이고 만료 전. 새 만료 = 지금 + 10분. 받는 쪽 ack 뒤에 만료를 바꾼다.
   * @throws ProblemError 404, 403 command-role-forbidden, 409 command-not-executable, 502 command-dispatch-failed, 422 invalid-command
   */
  async execute(q: { commandId: string; reason: string; actor: CommandExecutionActor; nowMs: number }): Promise<Command> {
    const reason = reasonOf(q.reason);
    const start = await this.store.mutate(q.commandId, (w) => writeExtendStart(w, { accountId: q.actor.accountId, role: q.actor.role, reason, nowMs: q.nowMs }));
    if (!start) throw notFound();
    if (start.status === 'NOT_EXTENDABLE') throw new ProblemError({ type: 'command-not-executable', status: 409, title: '실행할 수 있는 명령이 아닙니다' });
    if (start.status === 'ROLE_FORBIDDEN') throw roleForbidden();
    const r = await send(this.executor?.extend ? () => this.executor!.extend!(start.command, start.expiresAtMs, q.actor) : undefined);
    const error = r.status === 'FAILED' ? r.error : undefined;
    const out = await this.store.mutate(q.commandId, async (w) => ({
      ok: await writeExtendResult(w, {
        ok: r.status === 'ACKED',
        ...(error !== undefined ? { error } : {}),
        expiresAtMs: start.expiresAtMs,
        ...(r.status === 'ACKED' && r.ackedAtMs !== undefined ? { ackedAtMs: r.ackedAtMs } : {}),
        actorRef: start.actorRef,
        actorRole: start.actorRole,
        nowMs: q.nowMs,
      }),
      command: w.current,
    }));
    if (!out) throw notFound();
    if (!out.ok) throw dispatchFailed(error ?? 'state-changed');
    return out.command;
  }
}
