// 승인된 운영 명령의 실제 실행(T8~T11, BAT-465 GAT-300). 실행 전후 감사 체크포인트를 만들고,
// 대상 결과를 성공(카탈로그 명령 ACKED·1회 실행 명령 SUCCEEDED, ADR-0340 결정 1)·FAILED로 남긴다.
// 대상이 없으면 target-not-wired로 실패해 재시도할 수 있게 한다. 감사 기록은 DISPATCHED 사건과 함께 보내기 전에 커밋된다.
import { randomUUID } from 'node:crypto';
import { ProblemError } from '@peaket/platform';
import type { AuditCheckpointService } from '../../audit/index.js';
import { SYSTEM_ACTOR_REF, type Command, type CommandExecutionActor } from '../domain/command.js';
import type { CancelledEventGuard, CommandExecutor, CommandStore } from '../domain/ports.js';

export class ExecuteCommand {
  constructor(
    private readonly store: CommandStore,
    private readonly executor?: CommandExecutor,
    private readonly checkpoints?: AuditCheckpointService,
    /** 회차 취소가 확정된 회차의 판매 재개(SALE_RESUME)를 실행하지 않는다(확정 전에 만든 명령 포함, BAT-420 GAT-110 H, ADR-0280 결정 2) */
    readonly guard?: CancelledEventGuard,
  ) {}

  /** 실행기(되돌림·연장을 보내는 쪽도 같다). 없으면 보내지 못한 것으로 본다 */
  get target(): CommandExecutor | undefined {
    return this.executor;
  }

  /**
   * APPROVED(T8)·FAILED(T11)인 명령을 보낸다. FAILED에서 다시 하면 그 사람이 행위자(ACTOR 대응)다.
   * @throws ProblemError 409 command-not-executable
   */
  async run(command: Command, actor: CommandExecutionActor, nowMs: number): Promise<Command> {
    if (command.state !== 'APPROVED' && command.state !== 'FAILED') {
      throw new ProblemError({ type: 'command-not-executable', status: 409, title: '실행할 수 있는 명령이 아닙니다' });
    }
    // 실행 체크포인트의 행위자는 그 DISPATCHED 사건의 가명 참조다(처음 실행은 SYSTEM, 다시 한 실행은 그 사람의 ACTOR 참조).
    // 체크포인트는 7년 보존이라 관리 계정 ID를 남기지 않는다(대응 표만 3년 뒤 지운다, ADR-0149 결정 3, BAT-355 리뷰 RV-02)
    const retry = command.state === 'FAILED' ? { accountId: actor.accountId, role: actor.role, ref: randomUUID() } : undefined;
    const actorRef = retry?.ref ?? SYSTEM_ACTOR_REF;
    await this.checkpoints?.create({ reason: `COMMAND_EXECUTION_BEFORE:${command.commandId}`, actorRef });
    const dispatched = await this.store.markDispatched(command.commandId, nowMs, retry);
    let finished: Command;
    const eventId = command.eventId ?? (typeof command.params.eventId === 'string' ? command.params.eventId : undefined);
    if (command.type === 'SALE_RESUME' && this.guard && eventId !== undefined && (await this.guard.isCancelled(eventId))) {
      // 실행기를 부르지 않고 FAILED로 남긴다(다시 시도해도 같은 확인을 지난다)
      finished = await this.store.markDispatchFailed(command.commandId, 'event-cancelled', nowMs);
    } else if (!this.executor) {
      finished = await this.store.markDispatchFailed(command.commandId, 'target-not-wired', nowMs);
    } else {
      try {
        const result = await this.executor.execute(dispatched, actor);
        finished =
          result.status === 'FAILED'
            ? await this.store.markDispatchFailed(command.commandId, result.error, nowMs)
            : await this.store.markSucceeded(command.commandId, result.detail, nowMs, result.status === 'ACKED' ? result.ackedAtMs : undefined);
      } catch (err) {
        finished = await this.store.markDispatchFailed(command.commandId, err instanceof Error ? err.message : 'execution-failed', nowMs);
      }
    }
    await this.checkpoints?.create({ reason: `COMMAND_EXECUTION_AFTER:${command.commandId}`, actorRef });
    return finished;
  }
}
