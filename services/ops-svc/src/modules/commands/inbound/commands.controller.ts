// 받는 층: 운영 명령 접수·목록·상세·2인 승인·거부·재시도·되돌리기·연장(openapi /v1/ops/commands, ADR-0340).
// 접수는 Idempotency-Key가 필요하다. 차례는 멱등 다시 보내기 → 저장 전 검사(403·422) → 위험 명령 재인증 → 저장이라,
// 막힌 요청은 명령 행·사건·감사·멱등 기록을 남기지 않고, 같은 키·같은 본문의 다시 보내기는 재인증 토큰을 다시 보지 않는다(결정 7).
// 위험 명령(2인, 명령 3·11과 그 되돌리기 요청, 명령 4의 2인 조건)은 X-Reauth-Token(act=OPS_COMMAND, 패스키, 그 세션)을 본다(ADR-0322).
// 403마다 보안 사건 로그 한 줄(ops_command_authz_denied, 명령 ID·역할·까닭, 계정 ID 없음)을 남긴다(ASVS 16.3.2).
import { Controller, Get, Header, HttpCode, Inject, Optional, Post, Req, Res } from '@nestjs/common';
import {
  CLOCK,
  type Clock,
  ContractBody,
  ContractParams,
  ContractRouteSchema,
  CurrentPrincipal,
  IdempotencyRequest,
  Idempotent,
  type Principal,
  ProblemError,
  Roles,
} from '@peaket/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CreateCommand } from '../application/create-command.js';
import { DecideCommand } from '../application/decide-command.js';
import { GetCommand } from '../application/get-command.js';
import { ListCommands } from '../application/list-commands.js';
import { RetryCommand } from '../application/retry-command.js';
import { ExtendCommand, RevertCommand } from '../application/revert-command.js';
import { COMMAND_STATES, COMMAND_TYPES, CREATE_OPS_COMMAND, REVERT_NEEDS_APPROVAL, reauthRequiredFor, type Command } from '../domain/command.js';
import { noCommandSecurityEvents, type CommandSecurityEvents } from '../domain/ports.js';
import { COMMAND_REAUTH, COMMAND_SECURITY_EVENTS } from '../tokens.js';
import { ReauthUnavailable, type ApprovalReauthVerifier } from '../../payouts/index.js';
import { CommandBody, CommandIdParams, CommandPageView, CommandView, ReasonBody, RejectBody, baseViewOf, viewOf } from './command-view.js';

const badQuery = (): never => {
  throw new ProblemError({ type: 'invalid-query', status: 400, title: '목록 조건이 올바르지 않습니다' });
};

// 제목은 openapi x-peaket-problem-types 목록 그대로다(PRF192)
const reauthRequired = () => new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
const reauthUnavailable = () => new ProblemError({ type: 'reauth-unavailable', status: 503, title: '재인증 검증기를 쓸 수 없습니다', retryAfterSeconds: 5 });

@Controller('v1/ops/commands')
export class CommandsController {
  readonly #security: CommandSecurityEvents;

  constructor(
    private readonly createCommand: CreateCommand,
    private readonly listCommands: ListCommands,
    private readonly getCommand: GetCommand,
    private readonly decideCommand: DecideCommand,
    private readonly retryCommand: RetryCommand,
    private readonly revertCommand: RevertCommand,
    private readonly extendCommand: ExtendCommand,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(COMMAND_REAUTH) private readonly reauth?: ApprovalReauthVerifier,
    @Optional() @Inject(COMMAND_SECURITY_EVENTS) security?: CommandSecurityEvents,
  ) {
    this.#security = security ?? noCommandSecurityEvents;
  }

  /** 403이면 보안 사건 한 줄을 남기고 그대로 던진다 */
  async #guarded<T>(action: string, me: Principal, commandId: string | undefined, f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof ProblemError && e.status === 403) this.#security.authzDenied({ ...(commandId !== undefined ? { commandId } : {}), role: me.role ?? 'unknown', reason: e.slug, action });
      throw e;
    }
  }

  @Post()
  @HttpCode(201)
  @Roles(['operator', 'commander'])
  @Idempotent({ operation: CREATE_OPS_COMMAND })
  @ContractRouteSchema({ body: CommandBody, responses: { 201: CommandView } })
  async create(
    @ContractBody(CommandBody) body: z.output<typeof CommandBody>,
    @CurrentPrincipal() me: Principal,
    @Req() request: FastifyRequest,
    @IdempotencyRequest() idem: IdempotencyRequest,
  ): Promise<z.output<typeof CommandView>> {
    const nowMs = this.clock.now();
    const idempotency = { accountRef: idem.accountRef, operation: idem.operation, key: idem.key, requestHash: idem.requestHash };
    // 같은 키·같은 본문: 처음 명령을 돌려주고 새 일을 하지 않는다(재인증도 다시 보지 않는다). 다른 본문은 422
    const replayed = await this.createCommand.replay(idempotency, nowMs);
    if (replayed) return viewOf(replayed, me);
    const role = me.role ?? 'operator';
    return this.#guarded('create', me, undefined, async () => {
      const prepared = await this.createCommand.prepare({ type: body.type, reason: body.reason, params: body.params ?? {}, requestedRole: role, nowMs });
      if (prepared.reauthRequired) await this.#verifyReauth(me, request);
      const command = await this.createCommand.commit(prepared, {
        type: body.type,
        reason: body.reason,
        params: body.params ?? {},
        requestedBy: me.accountId,
        requestedRole: role,
        nowMs,
        actor: { accountId: me.accountId, sessionId: me.sessionId, role },
        idempotency,
      });
      return viewOf(command, me);
    });
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @Roles(['viewer', 'operator', 'commander'])
  @ContractRouteSchema({ responses: { 200: CommandPageView } })
  async list(@Req() request: FastifyRequest, @CurrentPrincipal() me: Principal): Promise<z.output<typeof CommandPageView>> {
    const q = request.query as Record<string, unknown>;
    const limit = typeof q.limit === 'string' ? Number(q.limit) : 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) badQuery();
    const type = typeof q.type === 'string' ? q.type : undefined;
    if (type !== undefined && !COMMAND_TYPES.includes(type as never)) badQuery();
    const states = typeof q.state === 'string' && q.state !== '' ? q.state.split(',') : undefined;
    if (states !== undefined && states.some((s) => !COMMAND_STATES.includes(s as never))) badQuery();
    const eventId = typeof q.eventId === 'string' ? q.eventId : undefined;
    if (eventId !== undefined && !z.uuid().safeParse(eventId).success) badQuery();
    const updatedAfter = typeof q.updatedAfter === 'string' ? Date.parse(q.updatedAfter) : undefined;
    if (updatedAfter !== undefined && !Number.isFinite(updatedAfter)) badQuery();
    const page = await this.listCommands.execute({
      ...(eventId !== undefined ? { eventId } : {}),
      ...(type !== undefined ? { type: type as never } : {}),
      ...(states !== undefined ? { states: states as never } : {}),
      ...(typeof q.cursor === 'string' ? { cursor: q.cursor } : {}),
      ...(updatedAfter !== undefined ? { updatedAfterMs: updatedAfter } : {}),
      limit,
    });
    return { items: page.items.map((c) => baseViewOf(c, me)), nextCursor: page.nextCursor ?? null };
  }

  @Get(':commandId')
  @Header('Cache-Control', 'no-store')
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ params: CommandIdParams, responses: { 200: CommandView } })
  async detail(@ContractParams(CommandIdParams) params: z.output<typeof CommandIdParams>, @CurrentPrincipal() me: Principal): Promise<z.output<typeof CommandView>> {
    return viewOf(await this.getCommand.execute(params.commandId), me);
  }

  @Post(':commandId/approvals')
  @HttpCode(200)
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ params: CommandIdParams, responses: { 200: CommandView } })
  async approve(
    @ContractParams(CommandIdParams) params: z.output<typeof CommandIdParams>,
    @CurrentPrincipal() me: Principal,
    @Req() request: FastifyRequest,
  ): Promise<z.output<typeof CommandView>> {
    return this.#guarded('approve', me, params.commandId, async () => {
      const current = await this.getCommand.execute(params.commandId);
      // 위험 명령의 승인과 명령 3·11 되돌리기 요청의 승인은 재인증한다
      if (this.#risky(current) || current.state === 'REVERT_PENDING') await this.#verifyReauth(me, request);
      const role = me.role ?? 'operator';
      return viewOf(
        await this.decideCommand.approve({
          commandId: params.commandId,
          approverRef: me.accountId,
          approverRole: role,
          nowMs: this.clock.now(),
          actor: { accountId: me.accountId, sessionId: me.sessionId, role },
        }),
        me,
      );
    });
  }

  @Post(':commandId/rejections')
  @HttpCode(200)
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ params: CommandIdParams, body: RejectBody, responses: { 200: CommandView } })
  async reject(@ContractParams(CommandIdParams) params: z.output<typeof CommandIdParams>, @ContractBody(RejectBody) body: z.output<typeof RejectBody>, @CurrentPrincipal() me: Principal): Promise<z.output<typeof CommandView>> {
    return this.#guarded('reject', me, params.commandId, async () =>
      viewOf(await this.decideCommand.reject({ commandId: params.commandId, approverRef: me.accountId, approverRole: me.role ?? 'operator', reason: body.reason, nowMs: this.clock.now() }), me),
    );
  }

  @Post(':commandId/retries')
  @HttpCode(200)
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ params: CommandIdParams, responses: { 200: CommandView } })
  async retry(
    @ContractParams(CommandIdParams) params: z.output<typeof CommandIdParams>,
    @CurrentPrincipal() me: Principal,
    @Req() request: FastifyRequest,
  ): Promise<z.output<typeof CommandView>> {
    return this.#guarded('retry', me, params.commandId, async () => {
      const current = await this.getCommand.execute(params.commandId);
      if (this.#risky(current)) await this.#verifyReauth(me, request);
      return viewOf(
        await this.retryCommand.execute({
          commandId: params.commandId,
          actor: { accountId: me.accountId, sessionId: me.sessionId, role: me.role ?? 'operator' },
          nowMs: this.clock.now(),
        }),
        me,
      );
    });
  }

  /** 되돌리기(ADR-0340 결정 5). 명령 3·11은 commander 요청·재인증 → 202 REVERT_PENDING, 그 밖은 200 REVERTED */
  @Post(':commandId/reversions')
  @HttpCode(200)
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ params: CommandIdParams, body: ReasonBody, responses: { 200: CommandView, 202: CommandView } })
  async revert(
    @ContractParams(CommandIdParams) params: z.output<typeof CommandIdParams>,
    @ContractBody(ReasonBody) body: z.output<typeof ReasonBody>,
    @CurrentPrincipal() me: Principal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<z.output<typeof CommandView>> {
    return this.#guarded('revert', me, params.commandId, async () => {
      const current = await this.getCommand.execute(params.commandId);
      if (REVERT_NEEDS_APPROVAL.includes(current.type)) await this.#verifyReauth(me, request);
      const r = await this.revertCommand.execute({
        commandId: params.commandId,
        reason: body.reason,
        actor: { accountId: me.accountId, sessionId: me.sessionId, role: me.role ?? 'operator' },
        nowMs: this.clock.now(),
      });
      if (r.pending) void reply.status(202);
      return viewOf(r.command, me);
    });
  }

  /** 명령 2 연장(지금 + 10분, operator 이상, 재인증 없음, ADR-0340 결정 5) */
  @Post(':commandId/extensions')
  @HttpCode(200)
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ params: CommandIdParams, body: ReasonBody, responses: { 200: CommandView } })
  async extend(
    @ContractParams(CommandIdParams) params: z.output<typeof CommandIdParams>,
    @ContractBody(ReasonBody) body: z.output<typeof ReasonBody>,
    @CurrentPrincipal() me: Principal,
  ): Promise<z.output<typeof CommandView>> {
    return this.#guarded('extend', me, params.commandId, async () =>
      viewOf(
        await this.extendCommand.execute({ commandId: params.commandId, reason: body.reason, actor: { accountId: me.accountId, sessionId: me.sessionId, role: me.role ?? 'operator' }, nowMs: this.clock.now() }),
        me,
      ),
    );
  }

  /** 위험 명령인가. 명령 4는 params의 2인 조건으로 본다(ADR-0339 결정 1) */
  #risky(c: Command): boolean {
    return reauthRequiredFor(c.type, c.params, this.createCommand.dryRun.protectedRanges);
  }

  /** X-Reauth-Token(act=OPS_COMMAND, 패스키, 그 세션)을 본다. 막히면 명령 행·감사 기록을 쓰지 않는다 */
  async #verifyReauth(me: Principal, request: FastifyRequest): Promise<void> {
    const token = request.headers['x-reauth-token'];
    const value = typeof token === 'string' && token !== '' ? token : undefined;
    // 토큰이 없는 것과 확인기가 없는 것은 다르다: 없는 토큰은 403, 확인기·jti 저장소 장애는 503(닫힌 쪽)
    if (value === undefined) throw reauthRequired();
    if (!this.reauth) throw reauthUnavailable();
    try {
      const v = await this.reauth.verify(value, { sessionId: me.sessionId, act: 'OPS_COMMAND' });
      if (v.accountId !== me.accountId) throw reauthRequired();
    } catch (e) {
      if (e instanceof ProblemError) throw e;
      if (e instanceof ReauthUnavailable) throw reauthUnavailable();
      throw reauthRequired();
    }
  }
}
