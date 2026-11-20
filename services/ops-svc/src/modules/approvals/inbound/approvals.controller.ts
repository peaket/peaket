// 받는 층: 승인 업무 목록·상세·승인·반려·철회(openapi /v1/ops/approval-requests*, BAT-615 LCH-070, BAT-045 BOT-152).
// 지급 묶음·계약 조건 변경·commander 역할 변경 승인을 ApprovalRouter가 kind로 나눈다. 계약 승인은 요청자·commander만 보고, 승인은 commander만 한다.
import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ContractBody, ContractParams, ContractRouteSchema, CurrentPrincipal, ProblemError, type Principal, Roles } from '@peaket/platform';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApprovalRouter } from '../application/approval-router.js';
import type { OpsActor } from '../../payouts/index.js';

const ApprovalParams = z.object({ approvalId: z.string().min(1).max(64) });
const RejectBody = z.object({ reason: z.string().min(1).max(2_000) }).strict();
const WithdrawBody = z.object({ reason: z.string().min(1).max(2_000) }).strict();
const DecisionBody = z.object({ reason: z.string().min(1).max(1_000).optional() }).strict();
const ApprovalView = z.record(z.string(), z.unknown());
const ApprovalPage = z.object({ items: z.array(ApprovalView), nextCursor: z.string().nullable() });

const actorOf = (me: Principal): OpsActor => ({ accountId: me.accountId, sessionId: me.sessionId, role: me.role ?? 'operator' });
const bad = (title: string): never => {
  throw new ProblemError({ type: 'invalid-query', status: 400, title });
};
const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1 || n > 100) bad('limit이 맞지 않습니다');
  return n;
};

@Controller('v1/ops/approval-requests')
export class ApprovalsController {
  constructor(private readonly router: ApprovalRouter) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Roles(['operator', 'commander', 'cs_agent', 'cs_lead'])
  @ContractRouteSchema({ responses: { 200: ApprovalPage } })
  async list(@Query() q: Record<string, string | undefined>, @CurrentPrincipal() me: Principal) {
    const status = q.status ? q.status.split(',') : undefined;
    return this.router.list({ ...(status ? { status } : {}), ...(q.awaitingMyApproval === 'true' ? { awaitingMyApproval: true } : {}), ...(q.requestedByMe === 'true' ? { requestedByMe: true } : {}), limit: num(q.limit, 50) }, actorOf(me));
  }

  @Get(':approvalId')
  @Header('Cache-Control', 'no-store')
  @Roles(['operator', 'commander', 'cs_agent', 'cs_lead'])
  @ContractRouteSchema({ params: ApprovalParams, responses: { 200: ApprovalView } })
  async get(@ContractParams(ApprovalParams) params: z.output<typeof ApprovalParams>, @CurrentPrincipal() me: Principal) {
    return this.router.get(params.approvalId, actorOf(me));
  }

  @Post(':approvalId/approvals')
  @HttpCode(200)
  @Roles(['commander', 'cs_lead'])
  @ContractRouteSchema({ params: ApprovalParams, responses: { 200: ApprovalView } })
  async approve(@ContractParams(ApprovalParams) params: z.output<typeof ApprovalParams>, @CurrentPrincipal() me: Principal, @Req() request: FastifyRequest, @Body() raw?: unknown) {
    const token = request.headers['x-reauth-token'];
    const parsed = DecisionBody.safeParse(raw ?? {});
    const reason = parsed.success ? parsed.data.reason : undefined;
    return this.router.approve(params.approvalId, actorOf(me), typeof token === 'string' ? token : undefined, reason);
  }

  @Post(':approvalId/rejections')
  @HttpCode(200)
  @Roles(['commander', 'cs_lead'])
  @ContractRouteSchema({ params: ApprovalParams, body: RejectBody, responses: { 200: ApprovalView } })
  async reject(@ContractParams(ApprovalParams) params: z.output<typeof ApprovalParams>, @ContractBody(RejectBody) body: z.output<typeof RejectBody>, @CurrentPrincipal() me: Principal) {
    return this.router.reject(params.approvalId, actorOf(me), body.reason);
  }

  @Post(':approvalId/withdrawals')
  @HttpCode(200)
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ params: ApprovalParams, body: WithdrawBody, responses: { 200: ApprovalView } })
  async withdraw(@ContractParams(ApprovalParams) params: z.output<typeof ApprovalParams>, @ContractBody(WithdrawBody) body: z.output<typeof WithdrawBody>, @CurrentPrincipal() me: Principal) {
    return this.router.withdraw(params.approvalId, actorOf(me), body.reason);
  }
}
