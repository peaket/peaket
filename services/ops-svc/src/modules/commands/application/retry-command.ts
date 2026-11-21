// 실패한 운영 명령의 재시도(T11, BAT-465 GAT-300). 같은 명령 ID로 다시 실행하고 시도 횟수를 올린다.
// 다시 한 사람은 대응 표에 ACTOR로 남고 DISPATCHED 사건의 행위자는 그 가명 참조다(ADR-0340 결정 8).
import { ProblemError } from '@peaket/platform';
import { requesterRolesOf, type Command, type CommandExecutionActor } from '../domain/command.js';
import type { CommandStore } from '../domain/ports.js';
import type { ExecuteCommand } from './execute-command.js';

export class RetryCommand {
  constructor(
    private readonly store: CommandStore,
    private readonly execution: ExecuteCommand,
  ) {}

  async execute(q: { commandId: string; actor: CommandExecutionActor; nowMs: number }): Promise<Command> {
    const command = await this.store.find(q.commandId);
    if (!command) throw new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
    // 재시도는 실행과 같은 권한이다. commander 전용 명령은 operator가 다시 실행할 수 없다(B3-H01). 시스템 자동 조치는 사람이 다시 하지 않는다
    if (!requesterRolesOf(command.type).includes(command.requestedRole) || !requesterRolesOf(command.type).includes(q.actor.role)) {
      throw new ProblemError({ type: 'command-role-forbidden', status: 403, title: '이 명령을 할 수 있는 역할이 아닙니다' });
    }
    if (command.state !== 'FAILED') throw new ProblemError({ type: 'command-not-failed', status: 409, title: '실패한 명령만 다시 시도할 수 있습니다' });
    return this.execution.run(command, q.actor, q.nowMs);
  }
}
