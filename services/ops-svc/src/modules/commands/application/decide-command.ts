// 운영 명령의 두 번째 승인·거부(GAT-110 첫 몫). 요청자와 같은 계정은 승인하지 못한다.
import { ProblemError } from '@peaket/platform';
import type { Command } from '../domain/command.js';
import type { CommandDecision, CommandDispatcher, CommandStore } from '../domain/ports.js';

const CONTROL = /[\u0000-\u001f\u007f]/;

const fail = (d: Exclude<CommandDecision, { status: 'APPLIED' }>): never => {
  if (d.status === 'NOT_FOUND') throw new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
  if (d.status === 'NOT_PENDING') throw new ProblemError({ type: 'command-not-pending', status: 409, title: '승인 대기 중인 명령이 아닙니다' });
  throw new ProblemError({ type: 'command-requester-cannot-approve', status: 403, title: '요청한 분은 승인할 수 없습니다' });
};

export class DecideCommand {
  constructor(
    private readonly store: CommandStore,
    private readonly dispatcher?: CommandDispatcher,
  ) {}

  async approve(q: { commandId: string; approverRef: string; approverRole: string; nowMs: number }): Promise<Command> {
    const d = await this.store.approve(q.commandId, q.approverRef, q.approverRole, q.nowMs);
    if (d.status !== 'APPLIED') return fail(d);
    if (d.command.type !== 'EVENT_CANCEL' || !this.dispatcher) return d.command;
    try {
      await this.dispatcher.dispatch(d.command);
    } catch (err) {
      await this.store.markDispatchFailed(d.command.commandId, err instanceof Error ? err.message : 'dispatch-failed', q.nowMs);
      throw new ProblemError({ type: 'dependency-unavailable', status: 503, title: '의존 서비스를 잠시 쓸 수 없습니다' });
    }
    return this.store.markDispatched(d.command.commandId, q.nowMs);
  }

  async reject(q: { commandId: string; approverRef: string; approverRole: string; reason: string; nowMs: number }): Promise<Command> {
    const reason = q.reason.trim();
    if (reason.length === 0 || reason.length > 2000 || CONTROL.test(reason)) throw new ProblemError({ type: 'invalid-command', status: 422, title: '명령 값이 올바르지 않습니다' });
    const d = await this.store.reject(q.commandId, q.approverRef, q.approverRole, reason, q.nowMs);
    return d.status === 'APPLIED' ? d.command : fail(d);
  }
}
