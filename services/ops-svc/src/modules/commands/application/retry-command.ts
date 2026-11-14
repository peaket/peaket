// 실패한 운영 명령의 재시도(BAT-465 GAT-300). 같은 명령 ID로 다시 실행하고 시도 횟수를 올린다.
import { ProblemError } from '@peaket/platform';
import type { Command, CommandExecutionActor } from '../domain/command.js';
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
    if (command.state !== 'FAILED') throw new ProblemError({ type: 'command-not-failed', status: 409, title: '실패한 명령만 다시 시도할 수 있습니다' });
    return this.execution.run(command, q.actor, q.nowMs);
  }
}
