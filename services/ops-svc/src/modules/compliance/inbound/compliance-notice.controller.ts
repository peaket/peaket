// SCR-032 통보 탭의 REST 경계(F-07-11, openapi /v1/ops/compliance/notices*).
// 쓰기는 operator·commander, 읽기는 CS 두 역할까지. CS는 SUMMARY만 받고 목록·상세 모두 private, no-store다.
import { Body, Controller, Get, Header, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { ContractRouteSchema, CurrentPrincipal, parseIdempotencyKey, ProblemError, Roles, type Principal } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ComplianceNotices } from '../application/compliance-notices.js';
import { COMPLIANCE_DEADLINES, COMPLIANCE_REQUESTERS, COMPLIANCE_STATUSES } from '../domain/compliance-notice.js';

const NoticeCreateBody = z
  .object({
    requester: z.enum(COMPLIANCE_REQUESTERS),
    agencyName: z.string().min(1).max(100),
    receivedAt: z.iso.datetime({ offset: true }),
    deadline: z.enum(COMPLIANCE_DEADLINES),
    reviewIds: z
      .array(z.uuid())
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, '중복된 후기 ID가 있습니다'),
    summary: z.string().max(2_000).optional(),
  })
  .strict();
const NoticeCreateView = z.object({ noticeId: z.uuid(), dueAt: z.iso.datetime({ offset: true }) });
const NoticeActionBody = z.object({ reason: z.string().min(1).max(2_000) }).strict();
const NoticeActionView = z.object({ noticeId: z.uuid(), status: z.enum(['TAKEN_DOWN', 'WITHDRAWN']), takenDownAt: z.iso.datetime({ offset: true }).optional(), withdrawnAt: z.iso.datetime({ offset: true }).optional(), reason: z.string() });
const NoticeView = z
  .object({
    view: z.enum(['SUMMARY', 'FULL']),
    noticeId: z.uuid(),
    requester: z.enum(COMPLIANCE_REQUESTERS),
    agencyName: z.string(),
    dueAt: z.iso.datetime({ offset: true }),
    status: z.enum(COMPLIANCE_STATUSES),
    receivedAt: z.iso.datetime({ offset: true }).optional(),
    deadline: z.enum(COMPLIANCE_DEADLINES).optional(),
    reviewIds: z.array(z.uuid()).optional(),
    summary: z.string().optional(),
    documents: z.array(z.unknown()).optional(),
    takenDownAt: z.iso.datetime({ offset: true }).nullable().optional(),
    withdrawnAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .strict();
const NoticePage = z.object({ items: z.array(NoticeView), nextCursor: z.string().nullable() });
const NoticeParams = z.object({ noticeId: z.string() }).strict();

const invalidQuery = (): ProblemError => new ProblemError({ type: 'invalid-query', status: 400, title: '목록 조건이 올바르지 않습니다' });
const keyOf = (raw: string | undefined): string => {
  const key = parseIdempotencyKey(raw);
  if (!key) throw new ProblemError({ type: 'idempotency-key-invalid', status: 400, title: '멱등 키(Idempotency-Key)가 없거나 형식이 맞지 않습니다' });
  return key;
};

@Controller('v1/ops/compliance/notices')
export class ComplianceNoticeController {
  constructor(private readonly notices: ComplianceNotices) {}

  @Post()
  @HttpCode(201)
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ body: NoticeCreateBody, responses: { 201: NoticeCreateView } })
  async create(
    @Body() body: z.output<typeof NoticeCreateBody>,
    @CurrentPrincipal() me: Principal,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<z.output<typeof NoticeCreateView>> {
    const out = await this.notices.create(body, { accountId: me.accountId, role: me.role ?? 'operator' }, keyOf(rawKey));
    void reply.header('location', `/v1/ops/compliance/notices/${out.noticeId}`);
    return out;
  }

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Roles(['operator', 'commander', 'cs_agent', 'cs_lead'])
  @ContractRouteSchema({ responses: { 200: NoticePage } })
  async list(@Query() q: Record<string, string | string[] | undefined>, @CurrentPrincipal() me: Principal): Promise<z.output<typeof NoticePage>> {
    const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
    const rawStatus = one(q.status);
    const status = rawStatus === undefined || rawStatus === '' ? undefined : (COMPLIANCE_STATUSES as readonly string[]).includes(rawStatus) ? (rawStatus as (typeof COMPLIANCE_STATUSES)[number]) : undefined;
    if (rawStatus !== undefined && rawStatus !== '' && status === undefined) throw invalidQuery();
    const sort = one(q.sort) ?? 'DUE_ASC';
    if (sort !== 'DUE_ASC' && sort !== 'LATEST') throw invalidQuery();
    const limitRaw = one(q.limit) ?? '50';
    const limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalidQuery();
    const cursor = one(q.cursor);
    return (await this.notices.list({ ...(status ? { status } : {}), sort, ...(cursor ? { cursor } : {}), limit }, me.role ?? '')) as z.output<typeof NoticePage>;
  }

  @Get(':noticeId')
  @Header('Cache-Control', 'private, no-store')
  @Roles(['operator', 'commander', 'cs_agent', 'cs_lead'])
  @ContractRouteSchema({ params: NoticeParams, responses: { 200: NoticeView } })
  async detail(@Param('noticeId') noticeId: string, @CurrentPrincipal() me: Principal): Promise<z.output<typeof NoticeView>> {
    return (await this.notices.detail(noticeId, { accountId: me.accountId, role: me.role ?? '' })) as z.output<typeof NoticeView>;
  }

  @Post(':noticeId/takedown')
  @HttpCode(200)
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ params: NoticeParams, body: NoticeActionBody, responses: { 200: NoticeActionView } })
  async takedown(
    @Param('noticeId') noticeId: string,
    @Body() body: z.output<typeof NoticeActionBody>,
    @CurrentPrincipal() me: Principal,
    @Headers('idempotency-key') rawKey: string | undefined,
  ): Promise<z.output<typeof NoticeActionView>> {
    return (await this.notices.takedown(noticeId, body.reason, { accountId: me.accountId, role: me.role ?? 'operator' }, keyOf(rawKey))) as z.output<typeof NoticeActionView>;
  }

  @Post(':noticeId/withdrawal')
  @HttpCode(200)
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ params: NoticeParams, body: NoticeActionBody, responses: { 200: NoticeActionView } })
  async withdraw(
    @Param('noticeId') noticeId: string,
    @Body() body: z.output<typeof NoticeActionBody>,
    @CurrentPrincipal() me: Principal,
    @Headers('idempotency-key') rawKey: string | undefined,
  ): Promise<z.output<typeof NoticeActionView>> {
    return (await this.notices.withdraw(noticeId, body.reason, { accountId: me.accountId, role: me.role ?? 'operator' }, keyOf(rawKey))) as z.output<typeof NoticeActionView>;
  }
}
