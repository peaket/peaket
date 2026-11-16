// 승인된 운영 명령의 실제 실행(BAT-465 GAT-300). 실행 전후 감사 체크포인트를 만들고,
// 대상 결과를 SUCCEEDED/FAILED로 남긴다. 대상이 없으면 target-not-wired로 실패해 재시도할 수 있게 한다.
import { ProblemError } from '@peaket/platform';
import type { AuditCheckpointService } from '../../audit/index.js';
import type { Command, CommandExecutionActor } from '../domain/command.js';
import type { CancelledEventGuard, CommandExecutor, CommandStore } from '../domain/ports.js';

export class ExecuteCommand {
  constructor(
    private readonly store: CommandStore,
    private readonly executor?: CommandExecutor,
    private readonly checkpoints?: AuditCheckpointService,
    /** 회차 취소가 확정된 회차의 판매 재개(SALE_RESUME)를 실행하지 않는다(확정 전에 만든 명령 포함, BAT-420 GAT-110 H, ADR-0280 결정 2) */
    readonly guard?: CancelledEventGuard,
  ) {}

  async run(command: Command, actor: CommandExecutionActor, nowMs: number): Promise<Command> {
    if (command.state !== 'APPROVED' && command.state !== 'FAILED' && command.state !== 'DISPATCHED') {
      throw new ProblemError({ type: 'command-not-executable', status: 409, title: '실행할 수 있는 명령이 아닙니다' });
    }
    if (command.type === 'SALE_RESUME' && this.guard) {
      const eventId = command.eventId ?? (typeof command.params.eventId === 'string' ? command.params.eventId : undefined);
      // 실행기를 부르지 않고 FAILED로 남긴다(다시 시도해도 같은 확인을 지난다)
      if (eventId !== undefined && (await this.guard.isCancelled(eventId))) return this.store.markDispatchFailed(command.commandId, 'event-cancelled', nowMs);
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
