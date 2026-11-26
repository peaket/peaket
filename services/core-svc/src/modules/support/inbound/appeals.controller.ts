// F-04-15 support 소명 HTTP(팬). openapi 태그 support, Cache-Control: private, no-store.
import { Body, Controller, Get, Header, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ContractBody, ContractRouteSchema, CurrentPrincipal, Idempotent, IdempotencyRequest, Roles, type IdempotencyRequest as Idem, type Principal } from '@peaket/platform';
import { z } from 'zod';
import { SupportAppeals } from '../application/support-appeals.js';

const AppealBody = z
  .object({
    kind: z.enum(['RESTRICTION', 'RECLAIM', 'FRAUD_CASE']),
    targetId: z.string().min(1),
    body: z.string(),
  })
  .strict();

const AppealView = z.object({
  appealId: z.string(),
  kind: z.string(),
  targetId: z.string(),
  status: z.string(),
  result: z.string().nullable(),
  caseId: z.string().nullable(),
  submittedAt: z.string(),
  decidedAt: z.string().nullable(),
});

const ListView = z.object({ items: z.array(AppealView), nextCursor: z.string().nullable() });
const FraudView = z.object({ items: z.array(z.record(z.string(), z.unknown())), nextCursor: z.null() });

@Controller('v1')
export class SupportAppealsController {
  constructor(private readonly support: SupportAppeals) {}

  @Post('appeals')
  @HttpCode(201)
  @Header('Cache-Control', 'private, no-store')
  @Roles(['fan'])
  @Idempotent({ operation: 'CREATE_APPEAL' })
  @ContractRouteSchema({ body: AppealBody, responses: { 201: AppealView } })
  async create(@ContractBody(AppealBody) body: z.output<typeof AppealBody>, @CurrentPrincipal() me: Principal, @IdempotencyRequest() idem: Idem): Promise<Record<string, unknown>> {
    return this.support.submit(me, idem, body);
  }

  @Get('appeals')
  @Header('Cache-Control', 'private, no-store')
  @Roles(['fan'])
  @ContractRouteSchema({ responses: { 200: ListView } })
  async list(@Query() q: Record<string, string | string[] | undefined>, @CurrentPrincipal() me: Principal): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
    const limit = typeof q.limit === 'string' ? Math.min(100, Math.max(1, Number(q.limit) || 20)) : 20;
    return this.support.list(me, { ...(typeof q.cursor === 'string' ? { cursor: q.cursor } : {}), limit });
  }

  @Get('appeals/:appealId')
  @Header('Cache-Control', 'private, no-store')
  @Roles(['fan'])
  @ContractRouteSchema({ responses: { 200: AppealView } })
  async get(@Param('appealId') appealId: string, @CurrentPrincipal() me: Principal): Promise<Record<string, unknown>> {
    return this.support.get(me, appealId);
  }

  @Get('fraud-appeal-requests')
  @Header('Cache-Control', 'private, no-store')
  @Roles(['fan'])
  @ContractRouteSchema({ responses: { 200: FraudView } })
  async fraudViews(@CurrentPrincipal() me: Principal): Promise<{ items: Record<string, unknown>[]; nextCursor: null }> {
    return this.support.fraudViews(me);
  }
}
