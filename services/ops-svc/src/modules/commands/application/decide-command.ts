// 두 번째 승인·거부(T6·T7)와 명령 3·11 되돌리기 요청의 승인·거부(T15·T16). 요청자와 같은 계정은 승인하지 못한다(403),
// 같은 사람 두 번은 command_actor 유일 제약이 409로 막는다. 승인 기한(10분)과 같거나 늦으면 명령을 닫고 409다(ADR-0340 결정 4).
import { ProblemError } from '@peaket/platform';
import type { Command, CommandExecutionActor } from '../domain/command.js';
import { normalizeReason, CommandInputRejected } from '../domain/command-params.js';
import type { CommandDecision, CommandStore } from '../domain/ports.js';
import type { ExecuteCommand } from './execute-command.js';
import { sendRevert } from './revert-command.js';

const notPending = (): ProblemError => new ProblemError({ type: 'command-not-pending', status: 409, title: '승인 대기 중인 명령이 아닙니다' });

export const fail = (d: Exclude<CommandDecision, { status: 'APPLIED' }>): never => {
  if (d.status === 'NOT_FOUND') throw new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
  if (d.status === 'NOT_PENDING' || d.status === 'EXPIRED' || d.status === 'DUPLICATE') throw notPending();
  if (d.status === 'ROLE_FORBIDDEN') throw new ProblemError({ type: 'command-role-forbidden', status: 403, title: '이 명령을 할 수 있는 역할이 아닙니다' });
  throw new ProblemError({ type: 'command-requester-cannot-approve', status: 403, title: '요청한 분은 승인할 수 없습니다' });
};

const reasonOf = (raw: string): string => {
  try {
    return normalizeReason(raw);
  } catch (e) {
    if (e instanceof CommandInputRejected) throw new ProblemError({ type: 'invalid-command', status: 422, title: '명령 값이 올바르지 않습니다' });
    throw e;
  }
};

export class DecideCommand {
  constructor(
    private readonly store: CommandStore,
    private readonly execution?: ExecuteCommand,
  ) {}

  /**
   * approverRef는 승인자 관리 계정 ID다(저장소가 가명 참조로 바꾼다). PENDING_APPROVAL은 승인 뒤 실행하고,
   * REVERT_PENDING은 되돌림을 보내 REVERTED(보내지 못하면 ACKED와 502 command-dispatch-failed)다
   */
  async approve(q: { commandId: string; approverRef: string; approverRole: string; nowMs: number; actor?: CommandExecutionActor }): Promise<Command> {
    const d = await this.store.approve(q.commandId, q.approverRef, q.approverRole, q.nowMs);
    if (d.status !== 'APPLIED') return fail(d);
    const actor: CommandExecutionActor = q.actor ?? { accountId: q.approverRef, sessionId: '', role: q.approverRole };
    if (d.revert) return sendRevert(this.store, this.execution?.target, d.command, actor, { ...d.revert, fromPending: true }, q.nowMs);
    if (!this.execution) return d.command;
    return this.execution.run(d.command, actor, q.nowMs);
  }

  async reject(q: { commandId: string; approverRef: string; approverRole: string; reason: string; nowMs: number }): Promise<Command> {
    const reason = reasonOf(q.reason);
    const d = await this.store.reject(q.commandId, q.approverRef, q.approverRole, reason, q.nowMs);
    return d.status === 'APPLIED' ? d.command : fail(d);
  }
}
