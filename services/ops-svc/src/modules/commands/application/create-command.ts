// 운영 명령 접수(T1~T5, ADR-0340). 저장 전에 유형·역할·사유·params·안전 한계를 검사하고(prepare),
// dry-run을 계산해 CREATED → DRY_RUN → PENDING_APPROVAL 또는 APPROVED 사건으로 남긴다(commit). 1인 명령은 접수 응답 전에 실행한다.
// 받는 층은 멱등 다시 보내기(replay) → prepare → 위험 명령 재인증 → commit 차례로 부른다. 막히면 명령 행·사건·감사·멱등 기록이 남지 않는다.
import { randomUUID } from 'node:crypto';
import { ProblemError } from '@peaket/platform';
import { blockApprovalOfParams, COMMAND_TYPES, requesterRolesOf, type ApprovalMode, type Command, type CommandExecutionActor, type CommandIdempotency, type CommandType } from '../domain/command.js';
import { checkCommandParams, CommandInputRejected, isPgFallbackParams, normalizeReason, pgAssignParamsOf } from '../domain/command-params.js';
import { LOBBY_BANNER_TEMPLATE_ID } from '../domain/control-kinds.js';
import type { CommandDryRun, DryRunCountResult } from '../domain/dry-run.js';
import { noApprovedLobbyBannerTemplates, noCommandSecurityEvents, type CancelledEventGuard, type CommandSecurityEvents, type CommandStore, type LobbyBannerTemplates } from '../domain/ports.js';
import type { ProtectedRangeHit } from '../domain/block-ranges.js';
import { ComputeDryRun } from './compute-dry-run.js';
import type { ExecuteCommand } from './execute-command.js';
import { PgAssignmentGate } from './pg-assignment-gate.js';

export interface CreateCommandInput {
  readonly type: CommandType;
  readonly reason: string;
  readonly params: Record<string, unknown>;
  /** 요청한 관리 계정 ID(대응 표에만 남는다) */
  readonly requestedBy: string;
  readonly requestedRole: string;
  readonly nowMs: number;
  /** 1인 명령을 접수 뒤 바로 실행할 때 넘길 관리 계정 신원 */
  readonly actor?: CommandExecutionActor;
  /** Kafka 사건의 eventKey처럼 외부에서 정한 멱등 키로 명령 ID를 고정할 때 */
  readonly commandId?: string;
  /** POST /v1/ops/commands의 Idempotency-Key 기록(같은 트랜잭션의 첫 쓰기) */
  readonly idempotency?: CommandIdempotency;
}

/** 검사를 지난 접수(저장 전). 미리보기는 dryRun만 돌려준다 */
export interface PreparedCommand {
  readonly type: CommandType;
  readonly reason: string;
  readonly params: Record<string, unknown>;
  readonly eventId?: string;
  readonly approvalMode: ApprovalMode;
  /** 위험 명령(2인, 명령 3·11, 명령 4의 2인 조건)이라 재인증이 필요한가 */
  readonly reauthRequired: boolean;
  readonly dryRun: CommandDryRun;
  readonly protectedRangeHits: readonly ProtectedRangeHit[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 유형별 params의 회차 ID를 꺼낸다(목록 필터용). eventIds 배열이면 첫 회차, eventId 글자면 그 값 */
export function eventIdOf(params: Record<string, unknown>): string | undefined {
  if (typeof params.eventId === 'string') return params.eventId;
  if (Array.isArray(params.eventIds) && typeof params.eventIds[0] === 'string') return params.eventIds[0];
  return undefined;
}

const invalidCommand = (): ProblemError => new ProblemError({ type: 'invalid-command', status: 422, title: '명령 값이 올바르지 않습니다' });
const roleForbidden = (): ProblemError => new ProblemError({ type: 'command-role-forbidden', status: 403, title: '이 명령을 할 수 있는 역할이 아닙니다' });

/** 도메인 거절을 422로 바꾼다. 한계 밖은 걸린 한계 이름을 detail에 싣는다(ADR-0340 결정 9) */
export function problemOfRejection(e: CommandInputRejected): ProblemError {
  if (e.kind === 'OUT_OF_RANGE') return new ProblemError({ type: 'command-out-of-range', status: 422, title: '안전 허용 범위 밖의 명령입니다', detail: e.limit });
  return invalidCommand();
}

export interface CreateCommandDeps {
  readonly dryRun?: ComputeDryRun;
  readonly security?: CommandSecurityEvents;
  /** 명령 12 온세일 윈도우·하위 결제사 판정과 명령 12·6 결제 갈래 dry-run 넣는 값(ADR-0349). 없으면 원천 없는 문(명령 12는 503)이다 */
  readonly pgGate?: PgAssignmentGate;
  /** 명령 7의 승인 템플릿 찾기(RV-01). 없으면 늘 '없음'(noApprovedLobbyBannerTemplates)이라 명령 7은 422다 */
  readonly bannerTemplates?: LobbyBannerTemplates;
}

/** 명령 7 템플릿이 승인되지 않았거나 꼴이 틀림(422 invalid-command, detail templateId, RV-01) */
const templateRejected = (): ProblemError => new ProblemError({ type: 'invalid-command', status: 422, title: '명령 값이 올바르지 않습니다', detail: 'templateId' });

export class CreateCommand {
  readonly dryRun: ComputeDryRun;
  readonly #security: CommandSecurityEvents;
  readonly #pgGate: PgAssignmentGate;
  readonly #bannerTemplates: LobbyBannerTemplates;

  constructor(
    private readonly store: CommandStore,
    private readonly execution?: ExecuteCommand,
    /** 회차 취소가 확정된 회차에는 판매 재개(SALE_RESUME)를 만들지 않는다(BAT-420 GAT-110 H, ADR-0280 결정 2) */
    readonly guard?: CancelledEventGuard,
    deps: CreateCommandDeps = {},
  ) {
    this.dryRun = deps.dryRun ?? new ComputeDryRun();
    this.#security = deps.security ?? noCommandSecurityEvents;
    this.#pgGate = deps.pgGate ?? new PgAssignmentGate();
    this.#bannerTemplates = deps.bannerTemplates ?? noApprovedLobbyBannerTemplates;
  }

  /**
   * 저장 전 검사와 dry-run. 내부 사건 수신·직접 호출도 같은 규칙을 지난다(B3-H01).
   * @throws ProblemError 403 command-role-forbidden, 422 invalid-command·command-out-of-range, 409 event-cancelled,
   *   명령 12는 503 onsale-window-unavailable·pg-check-unavailable과 422 pg-fallback-same-provider(ADR-0349 결정 2·3)
   */
  async prepare(input: Pick<CreateCommandInput, 'type' | 'reason' | 'params' | 'requestedRole' | 'nowMs'>): Promise<PreparedCommand> {
    if (!COMMAND_TYPES.includes(input.type)) throw invalidCommand();
    if (!requesterRolesOf(input.type).includes(input.requestedRole)) throw roleForbidden();
    let reason: string;
    let params: Record<string, unknown>;
    try {
      reason = normalizeReason(input.reason);
      params = checkCommandParams(input.type, input.params, input.nowMs);
    } catch (e) {
      if (e instanceof CommandInputRejected) throw problemOfRejection(e);
      throw e;
    }
    const eventId = eventIdOf(params);
    if (eventId !== undefined && !UUID.test(eventId)) throw invalidCommand();
    // 명령 7은 승인된 템플릿만 받는다(ADR-0365 결정 2 바꿈, RV-01). 저장하기 전에 본다(미리보기도 같다)
    if (input.type === 'LOBBY_BANNER') {
      const templateId = params.templateId;
      if (typeof templateId !== 'string' || !LOBBY_BANNER_TEMPLATE_ID.test(templateId) || !(await this.#bannerTemplates.approved(templateId))) throw templateRejected();
    }
    // 회차 취소가 확정된 회차는 판매를 다시 열지 않는다(환급 중·끝난 회차를 다시 팔지 않게, ADR-0280 결정 2). 실행 때도 다시 본다
    if (input.type === 'SALE_RESUME' && eventId !== undefined && this.guard && (await this.guard.isCancelled(eventId))) {
      // 제목은 openapi x-peaket-problem-types 목록 그대로(같은 이름은 어느 서비스나 같은 제목, PRF192), 이 경우의 설명은 detail에 싣는다
      throw new ProblemError({ type: 'event-cancelled', status: 409, title: '취소가 확정된 회차입니다', detail: '회차 취소가 확정된 회차는 판매를 재개할 수 없습니다' });
    }
    // 명령 12: 온세일 윈도우 → 하위 결제사 판정(503·422면 저장하지 않는다). 판정이 준 승인 상한을 dry-run 넣는 값으로 쓴다(ADR-0349 결정 2·3·4).
    // 명령 6 결제 갈래: 회차마다 지금 지정·승인 상한을 읽어 dry-run에 넣는다(막지 않는다, 결정 6)
    let extra: DryRunCountResult | undefined;
    if (input.type === 'PG_ASSIGN') {
      const pg = pgAssignParamsOf(params);
      extra = this.#pgGate.pgAssignInputs(pg, await this.#pgGate.checkPgAssign(pg, input.nowMs), input.nowMs);
    } else if (isPgFallbackParams(input.type, params)) {
      extra = await this.#pgGate.pgFallbackInputs(params, input.nowMs);
    }
    const dryRun = await this.dryRun.compute({ type: input.type, params, ...(eventId !== undefined ? { eventId } : {}) }, input.nowMs, extra);
    const hits = input.type === 'BLOCK_ASN_IP' ? blockApprovalOfParams(params, this.dryRun.protectedRanges).hits : [];
    return { type: input.type, reason, params, ...(eventId !== undefined ? { eventId } : {}), approvalMode: dryRun.approvalMode, reauthRequired: dryRun.reauthRequired, dryRun, protectedRangeHits: hits };
  }

  /** 같은 멱등 키의 처음 명령(같은 지문). 다른 지문이면 422 idempotency-key-reused를 던진다 */
  async replay(idem: CommandIdempotency, nowMs: number): Promise<Command | undefined> {
    const commandId = await this.store.replayOf(idem, nowMs);
    return commandId ? this.store.find(commandId) : undefined;
  }

  /** 검사를 지난 접수를 저장한다. 1인·즉시 실행 명령은 응답 전에 실행한다. 2인 명령은 승인 뒤 DecideCommand가 실행한다 */
  async commit(prepared: PreparedCommand, input: CreateCommandInput): Promise<Command> {
    const commandId = input.commandId ?? randomUUID();
    const { command, replayed } = await this.store.insert({
      commandId,
      type: prepared.type,
      reason: prepared.reason,
      params: prepared.params,
      requestedBy: input.requestedBy,
      requestedRole: input.requestedRole,
      ...(prepared.eventId !== undefined ? { eventId: prepared.eventId } : {}),
      nowMs: input.nowMs,
      dryRun: prepared.dryRun as unknown as Record<string, unknown>,
      approvalMode: prepared.approvalMode,
      ...(input.idempotency ? { idempotency: input.idempotency } : {}),
    });
    // 같은 멱등 키로 겹쳐 온 요청은 처음 명령을 그대로 돌려준다(새 일·실행 없음)
    if (replayed) return command;
    if (prepared.protectedRangeHits.length > 0) this.#security.blockProtectedRange({ commandId: command.commandId, requesterRole: input.requestedRole, hits: prepared.protectedRangeHits });
    if (this.execution && command.state === 'APPROVED') {
      const actor: CommandExecutionActor = input.actor ?? { accountId: input.requestedBy, sessionId: '', role: input.requestedRole };
      return this.execution.run(command, actor, input.nowMs);
    }
    return command;
  }

  async execute(input: CreateCommandInput): Promise<Command> {
    return this.commit(await this.prepare(input), input);
  }
}

/** 저장하지 않는 미리보기(POST /v1/ops/command-dry-runs, ADR-0340 결정 2). 접수와 같은 403·422이고 감사 기록을 남기지 않는다 */
export class PreviewCommand {
  constructor(private readonly create: CreateCommand) {}

  async execute(input: Pick<CreateCommandInput, 'type' | 'reason' | 'params' | 'requestedRole' | 'nowMs'>): Promise<CommandDryRun> {
    return (await this.create.prepare(input)).dryRun;
  }
}
