// core-svc support 팬 API(F-06-4 소명 + F-06-5 문의). openapi /v1/appeals·/v1/booking-restrictions/me·/v1/fraud-appeal-requests·/v1/inquiries*.
import { Body, Controller, Get, Header, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ContractRouteSchema, CurrentPrincipal, idempotencyKeyInvalid, parseIdempotencyKey, ProblemError, Roles, type Principal } from '@peaket/platform';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Appeals } from '../application/appeals.js';
import { Inquiries } from '../application/inquiries.js';
import { INQUIRY_STATUSES, isInquiryStatus, type InquiryStatus } from '../domain/inquiry.js';

const AppealBody = z
  .object({
    // 종류 검사(422 appeal-kind-not-supported)는 유스케이스가 한다. 여기서는 모양만 본다
    kind: z.string().min(1).max(64),
    targetId: z.string().min(1).max(64),
    body: z.string(),
  })
  .strict();

const InquiryBody = z
  .object({
    // 유형 검사(422)는 유스케이스가 한다. 여기서는 모양만 본다
    category: z.string().max(64).optional(),
    orderRef: z.string().min(1).max(64).optional(),
    title: z.string().max(200),
    body: z.string().max(8_000),
  })
  .strict();
const InquiryMessageBody = z.object({ body: z.string().max(8_000) }).strict();

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

const InquiryView = z.object({
  inquiryId: z.string(),
  number: z.string(),
  category: z.string(),
  orderRef: z.string().nullable(),
  orderSummary: z.string().nullable(),
  title: z.string(),
  status: z.string(),
  hasNewAnswer: z.boolean(),
  createdAt: z.string(),
  answeredAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  progressDueAt: z.string().nullable(),
  resultDueAt: z.string(),
});
const InquiryDetailView = InquiryView.extend({
  messages: z.array(z.object({ messageId: z.string(), authorKind: z.string(), authorDisplay: z.string(), kind: z.string(), body: z.string(), createdAt: z.string() })),
});
const InquiryPage = z.object({ items: z.array(InquiryView), total: z.number(), page: z.number(), limit: z.number() });
const InquiryCreated = z.object({ inquiryId: z.string(), number: z.string(), dueAt: z.string() });
const InquiryMessageView = z.object({ messageId: z.string(), authorKind: z.string(), authorDisplay: z.string(), kind: z.string(), body: z.string(), createdAt: z.string() });

const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');

@Controller('v1')
export class SupportController {
  constructor(
    private readonly appeals: Appeals,
    private readonly inquiries: Inquiries,
  ) {}

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

  @Post('inquiries')
  @HttpCode(201)
  @Header('Cache-Control', 'private, no-store')
  @Roles(['fan'])
  @ContractRouteSchema({ responses: { 201: InquiryCreated } })
  async createInquiry(
    @Body() raw: unknown,
    @CurrentPrincipal() me: Principal,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const key = parseIdempotencyKey(idempotencyKey);
    if (!key) throw idempotencyKeyInvalid();
    if (raw && typeof raw === 'object' && (Object.prototype.hasOwnProperty.call(raw, '__proto__') || Object.prototype.hasOwnProperty.call(raw, 'constructor'))) {
      throw new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다' });
    }
    const parsed = InquiryBody.safeParse(raw ?? {});
    if (!parsed.success) throw new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다' });
    const body = parsed.data;
    const out = await this.inquiries.submit(
      me.accountId,
      { category: body.category as never, ...(body.orderRef ? { orderRef: body.orderRef } : {}), title: body.title, body: body.body },
      key,
      hash({ op: 'CREATE_INQUIRY', category: body.category, ...(body.orderRef ? { orderRef: body.orderRef } : {}), title: body.title, body: body.body }),
    );
    void reply.header('location', `/v1/inquiries/${out.inquiryId}`);
    return { inquiryId: out.inquiryId, number: out.number, dueAt: out.resultDueAt };
  }

  @Get('inquiries')
  @Header('Cache-Control', 'private, no-store')
  @Roles(['fan'])
  @ContractRouteSchema({ responses: { 200: InquiryPage } })
  async listInquiries(@Query() q: Record<string, string | string[] | undefined>, @CurrentPrincipal() me: Principal) {
    const statusParam = typeof q.status === 'string' ? q.status : undefined;
    let statuses: InquiryStatus[] | undefined;
    if (statusParam) {
      const parts = statusParam.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.some((p) => !isInquiryStatus(p))) throw new ProblemError({ type: 'invalid-query', status: 400, title: '조건이 올바르지 않습니다' });
      statuses = parts as InquiryStatus[];
    }
    const page = q.page === undefined ? 1 : Number(q.page);
    const limit = q.limit === undefined ? 20 : Number(q.limit);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new ProblemError({ type: 'invalid-query', status: 400, title: '조건이 올바르지 않습니다' });
    return this.inquiries.list(me.accountId, statuses, page, limit);
  }

  @Get('inquiries/:inquiryId')
  @Header('Cache-Control', 'private, no-store')
  @Roles(['fan'])
  @ContractRouteSchema({ responses: { 200: InquiryDetailView } })
  async getInquiry(@Param('inquiryId') inquiryId: string, @CurrentPrincipal() me: Principal) {
    return this.inquiries.detail(me.accountId, inquiryId);
  }

  @Post('inquiries/:inquiryId/messages')
  @HttpCode(201)
  @Header('Cache-Control', 'private, no-store')
  @Roles(['fan'])
  @ContractRouteSchema({ responses: { 201: InquiryMessageView } })
  async createInquiryMessage(
    @Param('inquiryId') inquiryId: string,
    @Body() raw: unknown,
    @CurrentPrincipal() me: Principal,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    const key = parseIdempotencyKey(idempotencyKey);
    if (!key) throw idempotencyKeyInvalid();
    const parsed = InquiryMessageBody.safeParse(raw ?? {});
    if (!parsed.success) throw new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다' });
    return this.inquiries.addMessage(me.accountId, inquiryId, parsed.data.body, key, hash({ op: 'ADD_INQUIRY_MESSAGE', body: parsed.data.body }));
  }
}

export { InquiryView, InquiryDetailView, InquiryPage, InquiryCreated, InquiryMessageView };
export const INQUIRY_STATUS_VALUES = INQUIRY_STATUSES;
export type { InquiryStatus };
