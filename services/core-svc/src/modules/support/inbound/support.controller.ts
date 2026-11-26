// core-svc support 팬 API(F-06-4, openapi /v1/appeals·/v1/booking-restrictions/me·/v1/fraud-appeal-requests).
import { Body, Controller, Get, Header, HttpCode, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ContractRouteSchema, CurrentPrincipal, ProblemError, Roles, type Principal } from '@peaket/platform';
import { z } from 'zod';
import { Appeals } from '../application/appeals.js';

const AppealBody = z
  .object({
    // 종류 검사(422 appeal-kind-not-supported)는 유스케이스가 한다. 여기서는 모양만 본다
    kind: z.string().min(1).max(64),
    targetId: z.string().min(1).max(64),
    body: z.string(),
  })
  .strict();

/** 목록·접수 응답(openapi Appeal). 본문·CS 건·담당은 싣지 않는다 */
const AppealView = z.object({
  appealId: z.string(),
  kind: z.string(),
  targetId: z.string(),
  status: z.string(),
  result: z.string().nullable(),
  resultNote: z.string().nullable(),
  reasonCode: z.string().nullable(),
  dueAt: z.string().nullable(),
  resultDueAt: z.string().nullable(),
  submittedAt: z.string(),
  decidedAt: z.string().nullable(),
});
const AppealPage = z.object({ items: z.array(AppealView), nextCursor: z.string().nullable() });
const RestrictionView = z.object({
  status: z.string(),
  restrictionId: z.string().optional(),
  reasonCode: z.string().optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().nullable().optional(),
  appealDueAt: z.string().optional(),
});
const FraudAppealView = z.object({
  caseId: z.string(),
  eventId: z.string(),
  party: z.string(),
  heldTicketIds: z.array(z.string()),
  excludedTicketIds: z.array(z.string()),
  reasonCategories: z.array(z.string()),
  dueAt: z.string(),
  objectionDueAt: z.string().nullable(),
  objectionStatus: z.string(),
  objectionNote: z.string().nullable(),
  actionResult: z.record(z.string(), z.unknown()).nullable(),
  priorityPurchases: z.array(
    z.object({
      grantId: z.string(),
      seatLabel: z.string(),
      price: z.number(),
      expiresAt: z.string(),
      status: z.string(),
    }),
  ),
  lockExpiresAt: z.string().nullable(),
  lockActive: z.boolean(),
});
const FraudAppealPage = z.object({ items: z.array(FraudAppealView), nextCursor: z.string().nullable() });

@Controller('v1')
export class SupportController {
  constructor(private readonly appeals: Appeals) {}

  @Post('appeals')
  @HttpCode(201)
  @Header('Cache-Control', 'private, no-store')
  @Roles(['fan'])
  @ContractRouteSchema({ responses: { 201: AppealView } })
  async create(@Body() raw: unknown, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply) {
    const parsed = AppealBody.safeParse(raw ?? {});
    if (!parsed.success) throw new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다' });
    const out = await this.appeals.submit(me.accountId, parsed.data);
    void reply.header('location', `/v1/appeals/${String(out.appealId)}`);
    return out;
  }

  @Get('appeals')
  @Header('Cache-Control', 'private, no-store')
  @Roles(['fan'])
  @ContractRouteSchema({ responses: { 200: AppealPage } })
  async list(@CurrentPrincipal() me: Principal) {
    return this.appeals.listMine(me.accountId);
  }

  @Get('booking-restrictions/me')
  @Header('Cache-Control', 'private, no-store')
  @Roles(['fan'])
  @ContractRouteSchema({ responses: { 200: RestrictionView } })
  async restriction(@CurrentPrincipal() me: Principal) {
    return this.appeals.restrictionOf(me.accountId);
  }

  @Get('fraud-appeal-requests')
  @Header('Cache-Control', 'private, no-store')
  @Roles(['fan'])
  @ContractRouteSchema({ responses: { 200: FraudAppealPage } })
  async fraudAppeals(@CurrentPrincipal() me: Principal) {
    return this.appeals.fraudAppealsOf(me.accountId);
  }
}
