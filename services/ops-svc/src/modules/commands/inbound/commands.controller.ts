// 받는 층: 운영 명령 접수·목록·2인 승인·거부(openapi /v1/ops/commands, GAT-110 첫 몫).
// 제어 gRPC 전달·ack·되돌리기·사후 검토는 후속이다. 위험 명령의 재인증(X-Reauth-Token, act=OPS_COMMAND)은 BAT-045가 더했다.
import { Controller, Get, Header, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { CLOCK, type Clock, ContractBody, ContractParams, ContractRouteSchema, CurrentPrincipal, type Principal, ProblemError, Roles } from '@peaket/platform';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CreateCommand } from '../application/create-command.js';
import { DecideCommand } from '../application/decide-command.js';
import { GetCommand } from '../application/get-command.js';
import { ListCommands } from '../application/list-commands.js';
import { RetryCommand } from '../application/retry-command.js';
import { approvalModeOf, COMMAND_STATES, COMMAND_TYPES, type CommandType } from '../domain/command.js';
import { COMMAND_REAUTH } from '../tokens.js';
import { ReauthUnavailable, type ApprovalReauthVerifier } from '../../payouts/index.js';
import { CommandBody, CommandIdParams, CommandPageView, CommandView, RejectBody, baseViewOf, viewOf } from './command-view.js';

const badQuery = (): never => {
  throw new ProblemError({ type: 'invalid-query', status: 400, title: '목록 조건이 올바르지 않습니다' });
};

/** 위험 명령: 2인 승인 명령과 멈추는 쪽 명령 3·11(control-tower §3·§4, ADR-0095·0322) */
const riskyCommand = (type: CommandType): boolean => approvalModeOf(type) === 'TWO' || type === 'KILL_SWITCH' || type === 'AUTOMATION_STOP';
const reauthRequired = () => new ProblemError({ type: 'reauth-required', status: 403, title: '위험 명령은 다시 인증해야 합니다' });
const reauthUnavailable = () => new ProblemError({ type: 'reauth-unavailable', status: 503, title: '재인증 확인기를 쓸 수 없습니다', retryAfterSeconds: 5 });

@Controller('v1/ops/commands')
export class CommandsController {
  constructor(
    private readonly createCommand: CreateCommand,
    private readonly listCommands: ListCommands,
    private readonly getCommand: GetCommand,
    private readonly decideCommand: DecideCommand,
    private readonly retryCommand: RetryCommand,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(COMMAND_REAUTH) private readonly reauth?: ApprovalReauthVerifier,
  ) {}

  @Post()
  @HttpCode(201)
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ body: CommandBody, responses: { 201: CommandView } })
  async create(
    @ContractBody(CommandBody) body: z.output<typeof CommandBody>,
    @CurrentPrincipal() me: Principal,
    @Req() request: FastifyRequest,
  ): Promise<z.output<typeof CommandView>> {
    await this.#requireReauth(body.type, me, request);
    const command = await this.createCommand.execute({
      type: body.type,
      reason: body.reason,
      params: body.params ?? {},
      requestedBy: me.accountId,
      requestedRole: me.role ?? 'operator',
      nowMs: this.clock.now(),
      actor: { accountId: me.accountId, sessionId: me.sessionId, role: me.role ?? 'operator' },
    });
    return viewOf(command, me);
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
    const current = await this.getCommand.execute(params.commandId);
    await this.#requireReauth(current.type, me, request);
    return viewOf(
      await this.decideCommand.approve({
        commandId: params.commandId,
        approverRef: me.accountId,
        approverRole: me.role ?? 'operator',
        nowMs: this.clock.now(),
        actor: { accountId: me.accountId, sessionId: me.sessionId, role: me.role ?? 'operator' },
      }),
      me,
    );
  }

  @Post(':commandId/rejections')
  @HttpCode(200)
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ params: CommandIdParams, body: RejectBody, responses: { 200: CommandView } })
  async reject(@ContractParams(CommandIdParams) params: z.output<typeof CommandIdParams>, @ContractBody(RejectBody) body: z.output<typeof RejectBody>, @CurrentPrincipal() me: Principal): Promise<z.output<typeof CommandView>> {
    return viewOf(await this.decideCommand.reject({ commandId: params.commandId, approverRef: me.accountId, approverRole: me.role ?? 'operator', reason: body.reason, nowMs: this.clock.now() }), me);
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
    const current = await this.getCommand.execute(params.commandId);
    await this.#requireReauth(current.type, me, request);
    return viewOf(
      await this.retryCommand.execute({
        commandId: params.commandId,
        actor: { accountId: me.accountId, sessionId: me.sessionId, role: me.role ?? 'operator' },
        nowMs: this.clock.now(),
      }),
      me,
    );
  }

  /** 위험 명령이면 X-Reauth-Token(act=OPS_COMMAND, 패스키, 그 세션)을 본다. 막히면 명령 행·감사 기록을 쓰지 않는다 */
  async #requireReauth(type: CommandType, me: Principal, request: FastifyRequest): Promise<void> {
    if (!riskyCommand(type)) return;
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
