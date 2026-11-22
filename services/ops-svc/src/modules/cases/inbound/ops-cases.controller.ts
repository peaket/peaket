// 받는 층: CS 처리함 목록·상세·갱신(openapi listOpsCases·getOpsCase·updateOpsCase, gw-ops /v1/ops/cases*, F-06-2 GAT-280, ADR-0364 결정 5).
// 역할은 platform RolesGuard가 identity GetAdminAuthz로 판정한다(operator·commander·cs_agent·cs_lead, viewer는 403). 건 종류와 역할의 재판정은 CsCases가 한다.
// 단건 GET·PATCH 200은 ETag(판 번호)를 싣고, PATCH는 If-Match를 읽는다(없으면 428, 다르면 412, docs/api/guidelines.md '동시 수정').
// 응답은 Cache-Control: no-store다(가린 값과 처리 메모가 공용 캐시에 남지 않게).
import { Body, Controller, Get, Header, Headers, Param, Patch, Query, Res } from '@nestjs/common';
import { GetOpsCaseResponse, ListOpsCasesResponse, UpdateOpsCaseResponse } from '@peaket/contracts/openapi/ops';
import { ContractRouteSchema, CurrentPrincipal, ProblemError, Roles, type Principal } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { CsCases } from '../application/cs-cases.js';
import { CS_CASE_STATUSES } from '../domain/cs-case.js';

const CASE_ROLES = ['operator', 'commander', 'cs_agent', 'cs_lead'] as const;
/** 갱신 본문(openapi updateOpsCase). 배정 풀기는 빈 글이나 null이다 */
const UpdateBody = z
  .object({
    assignee: z.string().max(64).nullable().optional(),
    status: z.enum(CS_CASE_STATUSES).optional(),
    resultNote: z.string().max(4_000).optional(),
  })
  .strict();

const etagOf = (version: number): string => `"${version}"`;
const actorOf = (me: Principal) => ({ accountId: me.accountId, role: me.role ?? 'viewer' });
const one = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

@Controller('v1/ops/cases')
export class OpsCasesController {
  constructor(private readonly cases: CsCases) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Roles([...CASE_ROLES])
  @ContractRouteSchema({ responses: { 200: ListOpsCasesResponse } })
  async list(@Query() q: Record<string, string | string[] | undefined>, @CurrentPrincipal() me: Principal) {
    return this.cases.list(actorOf(me), { kind: one(q.kind), status: one(q.status), dueWithinDays: one(q.dueWithinDays), cursor: one(q.cursor), limit: one(q.limit) });
  }

  @Get(':caseId')
  @Header('Cache-Control', 'no-store')
  @Roles([...CASE_ROLES])
  @ContractRouteSchema({ responses: { 200: GetOpsCaseResponse } })
  async get(@Param('caseId') caseId: string, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply) {
    const out = await this.cases.get(actorOf(me), caseId);
    void reply.header('etag', etagOf(out.version));
    return out.view;
  }

  @Patch(':caseId')
  @Header('Cache-Control', 'no-store')
  @Roles([...CASE_ROLES])
  @ContractRouteSchema({ responses: { 200: UpdateOpsCaseResponse } })
  async update(
    @Param('caseId') caseId: string,
    @Body() body: unknown,
    @CurrentPrincipal() me: Principal,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const parsed = UpdateBody.safeParse(body ?? {});
    if (!parsed.success) throw new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다' });
    const out = await this.cases.update(actorOf(me), caseId, one(headers['if-match']), parsed.data);
    void reply.header('etag', etagOf(out.version));
    return out.view;
  }
}
