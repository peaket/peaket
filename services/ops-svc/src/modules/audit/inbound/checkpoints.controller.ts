// 받는 층: 감사 체크포인트 생성·목록·상세·검증(openapi /v1/ops/audit-checkpoints, BAT-465 GAT-310).
import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { CLOCK, type Clock, ContractBody, ContractParams, ContractRouteSchema, CurrentPrincipal, type Principal, ProblemError, Roles } from '@peaket/platform';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuditCheckpointService, type AuditCheckpoint } from '../checkpoint.js';

const CheckpointIdParams = z.object({ checkpointId: z.uuid() }).strict();
const CreateBody = z.object({ reason: z.string().min(1).max(500) }).strict();
const CheckpointView = z.object({
  checkpointId: z.string(),
  fromSeq: z.number(),
  toSeq: z.number(),
  rootHash: z.string(),
  prevCheckpointHash: z.string(),
  reason: z.string(),
  actorRef: z.string(),
  createdAt: z.string(),
});
const CheckpointPage = z.object({ items: z.array(CheckpointView), nextCursor: z.string().nullable() });
const VerificationView = z.object({
  checkpointId: z.string(),
  valid: z.boolean(),
  rootValid: z.boolean(),
  prevValid: z.boolean(),
  fromSeq: z.number(),
  toSeq: z.number(),
  checkedAt: z.string(),
});

const viewOf = (c: AuditCheckpoint): z.output<typeof CheckpointView> => ({
  checkpointId: c.checkpointId,
  fromSeq: c.fromSeq,
  toSeq: c.toSeq,
  rootHash: c.rootHash,
  prevCheckpointHash: c.prevCheckpointHash,
  reason: c.reason,
  actorRef: c.actorRef,
  createdAt: new Date(c.createdAtMs).toISOString(),
});

@Controller('v1/ops/audit-checkpoints')
export class AuditCheckpointsController {
  constructor(
    private readonly checkpoints: AuditCheckpointService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post()
  @HttpCode(201)
  @Roles(['commander'])
  @ContractRouteSchema({ body: CreateBody, responses: { 201: CheckpointView } })
  async create(@ContractBody(CreateBody) body: z.output<typeof CreateBody>, @CurrentPrincipal() me: Principal): Promise<z.output<typeof CheckpointView>> {
    return viewOf(await this.checkpoints.create({ reason: body.reason, actorRef: me.accountId }));
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @Roles(['viewer', 'operator', 'commander'])
  @ContractRouteSchema({ responses: { 200: CheckpointPage } })
  async list(@Req() request: FastifyRequest): Promise<z.output<typeof CheckpointPage>> {
    const raw = (request.query as Record<string, unknown>).limit;
    const limit = typeof raw === 'string' ? Number(raw) : 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ProblemError({ type: 'invalid-query', status: 400, title: '목록 조건이 올바르지 않습니다' });
    const items = await this.checkpoints.list(limit);
    return { items: items.map(viewOf), nextCursor: null };
  }

  @Get(':checkpointId')
  @Header('Cache-Control', 'no-store')
  @Roles(['viewer', 'operator', 'commander'])
  @ContractRouteSchema({ params: CheckpointIdParams, responses: { 200: CheckpointView } })
  async detail(@ContractParams(CheckpointIdParams) params: z.output<typeof CheckpointIdParams>): Promise<z.output<typeof CheckpointView>> {
    return viewOf(await this.checkpoints.get(params.checkpointId));
  }

  @Get(':checkpointId/verification')
  @Header('Cache-Control', 'no-store')
  @Roles(['viewer', 'operator', 'commander'])
  @ContractRouteSchema({ params: CheckpointIdParams, responses: { 200: VerificationView } })
  async verify(@ContractParams(CheckpointIdParams) params: z.output<typeof CheckpointIdParams>): Promise<z.output<typeof VerificationView>> {
    const v = await this.checkpoints.verify(params.checkpointId);
    return { ...v, checkedAt: new Date(v.checkedAtMs).toISOString() };
  }
}
