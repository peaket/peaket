// 받는 층: payment-svc가 지급 묶음 승인 ID를 ops-svc 지급 승인 기록과 대조하는 내부 경로(BAT-625, W12-mesh RV-01).
// 서비스 사이 토큰 가드 뒤에 있고 게이트웨이 HTTPRoute에 없다. 없는 승인은 404, 응답은 항상 no-store다.
// 사유 글·요청자 역할·계좌·내부 토큰은 싣지 않는다. payment-svc가 대조할 사실만 준다.
import { Controller, Get, Param, Res, UseGuards } from '@nestjs/common';
import { ContractRouteSchema, InternalTokenGuard, ProblemError, Roles } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { PayoutApprovals } from '../application/payout-approvals.js';

const ApprovalFacts = z
  .object({
    approvalId: z.string(),
    kind: z.literal('PAYOUT_BATCH'),
    targetRef: z.string(),
    batchId: z.string(),
    pg: z.enum(['TOSS', 'PORTONE']),
    pgStore: z.enum(['STANDARD', 'ESCROW']),
    payoutDate: z.string(),
    currency: z.literal('KRW'),
    amount: z.number().int(),
    statementCount: z.number().int(),
    status: z.enum(['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'EXECUTING', 'DONE', 'FAILED']),
    requiredApprovals: z.literal(2),
    requestedBy: z.string(),
    approvals: z.array(z.string()),
    approvedAt: z.string().nullable(),
  })
  .strict();

@Controller('internal/v1/payout-approvals')
@UseGuards(InternalTokenGuard)
export class InternalPayoutApprovalsController {
  constructor(private readonly payouts: PayoutApprovals) {}

  @Get(':approvalId')
  @ContractRouteSchema({ responses: { 200: ApprovalFacts } })
  @Roles(['public'])
  async get(@Param('approvalId') approvalId: string, @Res({ passthrough: true }) reply: FastifyReply): Promise<z.output<typeof ApprovalFacts>> {
    void reply.header('cache-control', 'no-store');
    const facts = typeof approvalId === 'string' ? await this.payouts.facts(approvalId) : undefined;
    if (!facts) throw new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
    return facts;
  }
}
