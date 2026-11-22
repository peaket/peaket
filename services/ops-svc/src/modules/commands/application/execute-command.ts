// 승인된 운영 명령의 실제 실행(T8~T11, BAT-465 GAT-300). 실행 전후 감사 체크포인트를 만들고,
// 대상 결과를 성공(카탈로그 명령 ACKED·1회 실행 명령 SUCCEEDED, ADR-0340 결정 1)·FAILED로 남긴다.
// 대상이 없으면 target-not-wired로 실패해 재시도할 수 있게 한다. 감사 기록은 DISPATCHED 사건과 함께 보내기 전에 커밋된다.
// 명령 12(PG_ASSIGN)는 실행기를 부르지 않는다: 실행 직전에 온세일 윈도우·하위 결제사 판정을 다시 보고(걸리면 FAILED, 사유는 그 Problem 이름),
// 통과하면 ACKED 상태 쓰기와 같은 트랜잭션에 control.settings 사건(키 '<회차>:PG_ASSIGNMENT:', 값 PgAssignmentValue) 하나를 Outbox로 쓴다(ADR-0349 결정 5).
// 설정형 명령의 적용 확인 표시는 OPS-300(F-02-5)이다.
// 제어 gRPC 카탈로그 명령 1·2·3·7·11(F-02-1, ADR-0365 결정 4)은 DISPATCHED(판 번호를 같은 트랜잭션에 매김)를 커밋한 뒤 배경 작업(ControlDispatcher)에 넘기고
// DISPATCHED로 돌아온다. 끝 상태(ACKED·FAILED)는 배경 작업이 쓴다. 배경 작업이 없으면 전처럼 실행기를 부른다.
// 명령 6 결제 갈래(F-02-2, ADR-0366)도 배경 작업이 보낸다. 대체 결제사 전환은 처음 DISPATCHED를 쓰기 전에 payment-svc ResolvePgSwitch로 회차마다 갈 곳을 묻고,
// 묻지 못하면 아무것도 쓰지 않고 503 pg-check-unavailable을 던진다(결정 5). 승인 요청은 DecideCommand가 승인을 쓰기 전에 preflight로 먼저 묻는다.
import { randomUUID } from 'node:crypto';
import { ProblemError } from '@peaket/platform';
import type { AuditCheckpointService } from '../../audit/index.js';
import { SYSTEM_ACTOR_REF, type Command, type CommandExecutionActor } from '../domain/command.js';
import { CommandInputRejected, isPgFallbackParams, pgAssignParamsOf, type PgAssignParams } from '../domain/command-params.js';
import { writeSucceeded } from '../domain/command-writes.js';
import { controlScopesOf, isDispatchedControl } from '../domain/control-kinds.js';
import type { PgSwitchRoutes } from '../domain/pg-switch.js';
import type { CancelledEventGuard, CommandExecutor, CommandStore, SettingChange } from '../domain/ports.js';
import { PgAssignmentGate } from './pg-assignment-gate.js';
import { PgSwitchPlanner } from './pg-switch-plan.js';

/** 실행의 덧붙임(BAT-360). 주지 않으면 명령 12의 원천이 없는 문(실행 직전 확인이 503 사유로 FAILED)이다 */
export interface ExecuteCommandOptions {
  /** 명령 12 온세일 윈도우·하위 결제사 판정(CreateCommand와 같은 객체) */
  readonly pgGate?: PgAssignmentGate;
  /** 제어 gRPC 명령의 배경 보내기(F-02-1, ADR-0365 결정 4). 없으면 실행기가 보낸다. 명령 6 전환은 물은 갈 곳을 함께 넘긴다 */
  readonly control?: { dispatch(command: Command, o?: { readonly pgRoutes?: PgSwitchRoutes }): void };
  /** 명령 6 대체 결제사 전환의 갈 곳 묻기(F-02-2, ADR-0366 결정 5). 없으면 원천 없는 문이라 503 pg-check-unavailable이다 */
  readonly pgSwitch?: PgSwitchPlanner;
}

/** 명령 12의 설정 사건 종류(asyncapi SettingChanged.key) */
export const PG_ASSIGNMENT_SETTING = 'PG_ASSIGNMENT';

/** 명령 12 값을 설정 사건으로(범위는 회차, 대상 없음, 값 PgAssignmentValue {primaryPg, fallbackPg?}) */
export function pgAssignmentSettingOf(command: Command, params: PgAssignParams, nowMs: number): SettingChange {
  return {
    kind: PG_ASSIGNMENT_SETTING,
    scope: params.eventId,
    value: { primaryPg: params.primaryPg, ...(params.fallbackPg !== undefined ? { fallbackPg: params.fallbackPg } : {}) },
    commandId: command.commandId,
    // 명령 기록의 가명 참조(요청자). 관리 계정 ID를 싣지 않는다(asyncapi actor, ADR-0149)
    actorRef: command.requesterRef ?? SYSTEM_ACTOR_REF,
    occurredAtMs: nowMs,
  };
}

const scopesReadable = (c: Command): boolean => {
  try {
    return controlScopesOf(c).length > 0;
  } catch {
    return false;
  }
};

export class ExecuteCommand {
  readonly #pgGate: PgAssignmentGate;
  readonly #control: ExecuteCommandOptions['control'];
  readonly #pgSwitch: PgSwitchPlanner;

  constructor(
    private readonly store: CommandStore,
    private readonly executor?: CommandExecutor,
    private readonly checkpoints?: AuditCheckpointService,
    /** 회차 취소가 확정된 회차의 판매 재개(SALE_RESUME)를 실행하지 않는다(확정 전에 만든 명령 포함, BAT-420 GAT-110 H, ADR-0280 결정 2) */
    readonly guard?: CancelledEventGuard,
    options: ExecuteCommandOptions = {},
  ) {
    this.#pgGate = options.pgGate ?? new PgAssignmentGate();
    this.#control = options.control;
    this.#pgSwitch = options.pgSwitch ?? new PgSwitchPlanner();
  }

  /**
   * 명령 6 대체 결제사 전환을 제어 gRPC로 보낼 때, 처음 DISPATCHED 전에 회차마다 갈 곳을 묻는다(ADR-0366 결정 5). 그 밖의 명령은 undefined.
   * 승인 요청(DecideCommand)이 승인을 쓰기 전에 부른다(실패하면 승인도 쓰지 않는다).
   * @throws ProblemError 503 pg-check-unavailable
   */
  async preflight(command: Pick<Command, 'type' | 'params'>): Promise<PgSwitchRoutes | undefined> {
    if (!this.#control || !isPgFallbackParams(command.type, command.params)) return undefined;
    return this.#pgSwitch.routes(command);
  }

  /**
   * 명령 12 실행: 실행 직전 확인 → ACKED와 설정 사건을 한 트랜잭션에. 확인에 걸리면 FAILED(사유 command-out-of-range·pg-fallback-same-provider·
   * onsale-window-unavailable·pg-check-unavailable), 저장소가 설정 사건을 쓰지 못하면 FAILED(settings-outbox-not-wired)다
   */
  async #pgAssign(command: Command, nowMs: number): Promise<Command> {
    let params: PgAssignParams;
    try {
      params = pgAssignParamsOf(command.params);
    } catch (e) {
      if (e instanceof CommandInputRejected) return this.store.markDispatchFailed(command.commandId, 'invalid-command', nowMs);
      throw e;
    }
    try {
      await this.#pgGate.checkPgAssign(params, nowMs);
    } catch (e) {
      if (e instanceof ProblemError) return this.store.markDispatchFailed(command.commandId, e.slug, nowMs);
      throw e;
    }
    const setting = pgAssignmentSettingOf(command, params, nowMs);
    const done = await this.store.mutate(command.commandId, async (w) => {
      if (!w.setting) return undefined;
      const acked = await writeSucceeded(w, { result: { setting: PG_ASSIGNMENT_SETTING, scope: setting.scope }, ackedAtMs: nowMs, nowMs });
      // Outbox 행은 트랜잭션의 마지막 쓰기다(ADR-0116 결정 3)
      await w.setting(setting);
      return acked;
    });
    return done ?? this.store.markDispatchFailed(command.commandId, 'settings-outbox-not-wired', nowMs);
  }

  /** 실행기(되돌림·연장을 보내는 쪽도 같다). 없으면 보내지 못한 것으로 본다 */
  get target(): CommandExecutor | undefined {
    return this.executor;
  }

  /**
   * APPROVED(T8)·FAILED(T11)인 명령을 보낸다. FAILED에서 다시 하면 그 사람이 행위자(ACTOR 대응)다.
   * @param o.pgRoutes 부르는 쪽이 먼저 물은 명령 6 갈 곳(preflight). 없으면 여기서 묻는다
   * @throws ProblemError 409 command-not-executable, 503 pg-check-unavailable(명령 6 전환의 갈 곳을 묻지 못함, 아무것도 쓰지 않았다)
   */
  async run(command: Command, actor: CommandExecutionActor, nowMs: number, o: { readonly pgRoutes?: PgSwitchRoutes } = {}): Promise<Command> {
    if (command.state !== 'APPROVED' && command.state !== 'FAILED') {
      throw new ProblemError({ type: 'command-not-executable', status: 409, title: '실행할 수 있는 명령이 아닙니다' });
    }
    // 명령 6 전환: 체크포인트·DISPATCHED를 쓰기 전에 묻는다(ADR-0366 결정 5)
    const pgRoutes = o.pgRoutes ?? (await this.preflight(command));
    // 실행 체크포인트의 행위자는 그 DISPATCHED 사건의 가명 참조다(처음 실행은 SYSTEM, 다시 한 실행은 그 사람의 ACTOR 참조).
    // 체크포인트는 7년 보존이라 관리 계정 ID를 남기지 않는다(대응 표만 3년 뒤 지운다, ADR-0149 결정 3, BAT-355 리뷰 RV-02)
    const retry = command.state === 'FAILED' ? { accountId: actor.accountId, role: actor.role, ref: randomUUID() } : undefined;
    const actorRef = retry?.ref ?? SYSTEM_ACTOR_REF;
    await this.checkpoints?.create({ reason: `COMMAND_EXECUTION_BEFORE:${command.commandId}`, actorRef, kind: 'EXECUTION' });
    const dispatched = await this.store.markDispatched(command.commandId, nowMs, retry);
    let finished: Command;
    const eventId = command.eventId ?? (typeof command.params.eventId === 'string' ? command.params.eventId : undefined);
    if (command.type === 'SALE_RESUME' && this.guard && eventId !== undefined && (await this.guard.isCancelled(eventId))) {
      // 실행기를 부르지 않고 FAILED로 남긴다(다시 시도해도 같은 확인을 지난다)
      finished = await this.store.markDispatchFailed(command.commandId, 'event-cancelled', nowMs);
    } else if (this.#control && isDispatchedControl(command.type, command.params)) {
      // 판이 매겨졌으면 배경 작업이 보낸다(응답은 DISPATCHED). 범위를 읽지 못했거나 원장이 없는 저장소면 보내지 못한 것이다
      if (dispatched.controlVersion !== undefined) {
        this.#control.dispatch(dispatched, pgRoutes ? { pgRoutes } : {});
        finished = dispatched;
      } else {
        finished = await this.store.markDispatchFailed(command.commandId, scopesReadable(dispatched) ? 'control-ledger-not-wired' : 'invalid-command', nowMs);
      }
    } else if (command.type === 'PG_ASSIGN') {
      try {
        finished = await this.#pgAssign(dispatched, nowMs);
      } catch (err) {
        finished = await this.store.markDispatchFailed(command.commandId, err instanceof Error ? err.message : 'execution-failed', nowMs);
      }
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
    await this.checkpoints?.create({ reason: `COMMAND_EXECUTION_AFTER:${command.commandId}`, actorRef, kind: 'EXECUTION' });
    return finished;
  }
}
