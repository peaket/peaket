// 받는 층: 운영 명령 접수·목록·2인 승인·거부(openapi /v1/ops/commands, GAT-110 첫 몫).
// 제어 gRPC 전달·ack·되돌리기·사후 검토는 후속이다. 재인증 토큰 확인 계약도 아직 없어 위험 명령의 fresh 검사를 하지 않는다(known gap).
import { Controller, Get, Header, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { CLOCK, type Clock, ContractBody, ContractParams, ContractRouteSchema, CurrentPrincipal, type Principal, ProblemError, Roles } from '@peaket/platform';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CreateCommand } from '../application/create-command.js';
import { DecideCommand } from '../application/decide-command.js';
import { GetCommand } from '../application/get-command.js';
import { ListCommands } from '../application/list-commands.js';
import { COMMAND_STATES, COMMAND_TYPES, type Command } from '../domain/command.js';

const CommandIdParams = z.object({ commandId: z.uuid() }).strict();
const CommandBody = z
  .object({
    type: z.enum(COMMAND_TYPES),
    reason: z.string().min(1).max(2000),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const RejectBody = z.object({ reason: z.string().min(1).max(2000) }).strict();
const OpsActorView = z.object({ adminAccountId: z.string(), displayName: z.string().nullable(), role: z.string() });
const CommandView = z.object({
  commandId: z.string(),
  type: z.enum(COMMAND_TYPES),
  state: z.enum(COMMAND_STATES),
  reason: z.string(),
  params: z.record(z.string(), z.unknown()),
  requestedBy: OpsActorView,
  eventId: z.string().nullable().optional(),
  approvalExpiresAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  approvals: z.array(z.string()),
});
const CommandBaseView = CommandView.omit({ params: true });
const CommandPageView = z.object({ items: z.array(CommandBaseView), nextCursor: z.string().nullable() });

// 표시 이름은 identity admin_account 조회가 붙기 전까지 null이다(후속). 목록에는 params를 싣지 않는다(openapi).
const baseViewOf = (c: Command): z.output<typeof CommandBaseView> => ({
  commandId: c.commandId,
  type: c.type,
  state: c.state,
  reason: c.reason,
  requestedBy: { adminAccountId: c.requestedBy, displayName: null, role: c.requestedRole },
  ...(c.eventId !== undefined ? { eventId: c.eventId } : {}),
  ...(c.approvalExpiresAtMs !== undefined ? { approvalExpiresAt: new Date(c.approvalExpiresAtMs).toISOString() } : {}),
  createdAt: new Date(c.createdAtMs).toISOString(),
  updatedAt: new Date(c.updatedAtMs).toISOString(),
  approvals: [...c.approvals],
});
const viewOf = (c: Command): z.output<typeof CommandView> => ({ ...baseViewOf(c), params: c.params });

const badQuery = (): never => {
  throw new ProblemError({ type: 'invalid-query', status: 400, title: '목록 조건이 올바르지 않습니다' });
};

@Controller('v1/ops/commands')
export class CommandsController {
  constructor(
    private readonly createCommand: CreateCommand,
    private readonly listCommands: ListCommands,
    private readonly getCommand: GetCommand,
    private readonly decideCommand: DecideCommand,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post()
  @HttpCode(201)
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ body: CommandBody, responses: { 201: CommandView } })
  async create(@ContractBody(CommandBody) body: z.output<typeof CommandBody>, @CurrentPrincipal() me: Principal): Promise<z.output<typeof CommandView>> {
    const command = await this.createCommand.execute({
      type: body.type,
      reason: body.reason,
      params: body.params ?? {},
      requestedBy: me.accountId,
      requestedRole: me.role ?? 'operator',
      nowMs: this.clock.now(),
    });
    return viewOf(command);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @Roles(['viewer', 'operator', 'commander'])
  @ContractRouteSchema({ responses: { 200: CommandPageView } })
  async list(@Req() request: FastifyRequest): Promise<z.output<typeof CommandPageView>> {
    const q = request.query as Record<string, unknown>;
    const limit = typeof q.limit === 'string' ? Number(q.limit) : 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) badQuery();
    const type = typeof q.type === 'string' ? q.type : undefined;
    if (type !== undefined && !COMMAND_TYPES.includes(type as never)) badQuery();
    const states = typeof q.state === 'string' && q.state !== '' ? q.state.split(',') : undefined;
    if (states !== undefined && states.some((s) => !COMMAND_STATES.includes(s as never))) badQuery();
    const eventId = typeof q.eventId === 'string' ? q.eventId : undefined;
    if (eventId !== undefined && !z.uuid().safeParse(eventId).success) badQuery();
    const page = await this.listCommands.execute({
      ...(eventId !== undefined ? { eventId } : {}),
      ...(type !== undefined ? { type: type as never } : {}),
      ...(states !== undefined ? { states: states as never } : {}),
      ...(typeof q.cursor === 'string' ? { cursor: q.cursor } : {}),
      limit,
    });
    return { items: page.items.map(baseViewOf), nextCursor: page.nextCursor ?? null };
  }

  @Get(':commandId')
  @Header('Cache-Control', 'no-store')
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ params: CommandIdParams, responses: { 200: CommandView } })
  async detail(@ContractParams(CommandIdParams) params: z.output<typeof CommandIdParams>): Promise<z.output<typeof CommandView>> {
    return viewOf(await this.getCommand.execute(params.commandId));
  }

  @Post(':commandId/approvals')
  @HttpCode(200)
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ params: CommandIdParams, responses: { 200: CommandView } })
  async approve(@ContractParams(CommandIdParams) params: z.output<typeof CommandIdParams>, @CurrentPrincipal() me: Principal): Promise<z.output<typeof CommandView>> {
    return viewOf(await this.decideCommand.approve({ commandId: params.commandId, approverRef: me.accountId, approverRole: me.role ?? 'operator', nowMs: this.clock.now() }));
  }

  @Post(':commandId/rejections')
  @HttpCode(200)
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ params: CommandIdParams, body: RejectBody, responses: { 200: CommandView } })
  async reject(@ContractParams(CommandIdParams) params: z.output<typeof CommandIdParams>, @ContractBody(RejectBody) body: z.output<typeof RejectBody>, @CurrentPrincipal() me: Principal): Promise<z.output<typeof CommandView>> {
    return viewOf(await this.decideCommand.reject({ commandId: params.commandId, approverRef: me.accountId, approverRole: me.role ?? 'operator', reason: body.reason, nowMs: this.clock.now() }));
  }
}
