// 승인된 운영 명령의 실제 실행(BAT-465 GAT-300). 실행 전후 감사 체크포인트를 만들고,
// 대상 결과를 SUCCEEDED/FAILED로 남긴다. 대상이 없으면 target-not-wired로 실패해 재시도할 수 있게 한다.
import { ProblemError } from '@peaket/platform';
import type { AuditCheckpointService } from '../../audit/index.js';
import type { Command, CommandExecutionActor } from '../domain/command.js';
import type { CommandExecutor, CommandStore } from '../domain/ports.js';

export class ExecuteCommand {
  constructor(
    private readonly store: CommandStore,
    private readonly executor?: CommandExecutor,
    private readonly checkpoints?: AuditCheckpointService,
  ) {}

  async run(command: Command, actor: CommandExecutionActor, nowMs: number): Promise<Command> {
    if (command.state !== 'APPROVED' && command.state !== 'FAILED' && command.state !== 'DISPATCHED') {
      throw new ProblemError({ type: 'command-not-executable', status: 409, title: '실행할 수 있는 명령이 아닙니다' });
    }
    await this.checkpoints?.create({ reason: `COMMAND_EXECUTION_BEFORE:${command.commandId}`, actorRef: actor.accountId });
    const dispatched = await this.store.markDispatched(command.commandId, nowMs);
    let finished: Command;
    if (!this.executor) {
      finished = await this.store.markDispatchFailed(command.commandId, 'target-not-wired', nowMs);
    } else {
      try {
        const result = await this.executor.execute(dispatched, actor);
        finished =
          result.status === 'SUCCEEDED'
            ? await this.store.markSucceeded(command.commandId, result.detail, nowMs)
            : await this.store.markDispatchFailed(command.commandId, result.error, nowMs);
      } catch (err) {
        finished = await this.store.markDispatchFailed(command.commandId, err instanceof Error ? err.message : 'execution-failed', nowMs);
      }
    }
    await this.checkpoints?.create({ reason: `COMMAND_EXECUTION_AFTER:${command.commandId}`, actorRef: actor.accountId });
    return finished;
  }
}
