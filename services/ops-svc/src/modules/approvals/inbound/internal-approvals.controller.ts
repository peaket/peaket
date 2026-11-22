// 받는 층: core-svc가 부르는 내부 승인 업무 생성(BAT-615 LCH-070, ADR-0320 결정 3)과 payment-svc가 부르는 조정 승인 사실 조회(F-07-5, ADR-0368 결정 8).
// PUT /internal/v1/approval-requests/{approvalId}: 같은 승인 ID 재호출은 같은 답(멱등). 서비스 사이 토큰으로 좁힌다.
// GET /internal/v1/approval-requests/{approvalId}: SETTLEMENT_ADJUSTMENT의 사실만(종류·대상·금액·사유 코드·상태·정족수·요청자·승인자·승인 시각), 늘 no-store.
// 근거 메모·요청자 역할·계좌·내부 토큰은 싣지 않는다. 그 밖 종류와 없는 승인은 404다.
import { Controller, Get, HttpCode, Param, Put, Res, UseGuards } from '@nestjs/common';
import { ContractBody, ContractParams, ContractRouteSchema, InternalTokenGuard, ProblemError, Roles } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ContractApprovals } from '../application/contract-approvals.js';
import { SettlementAdjustmentApprovals } from '../application/settlement-adjustment-approvals.js';

const ApprovalParams = z.object({ approvalId: z.string().min(1).max(64) });
const CurrentTerms = z
  .object({
    commissionRateBp: z.number().int().min(0).max(10_000),
    guaranteeRateBp: z.number().int().min(0).max(10_000),
    guaranteeKind: z.enum(['DEPOSIT', 'PERFORMANCE_BOND']),
    validFrom: z.string().min(1),
  })
  .strict();
const CreateBody = z
  .object({
    kind: z.literal('CONTRACT_TERMS_CHANGE'),
    targetRef: z.string().min(1).max(64),
    requestedBy: z.object({ accountId: z.string().min(1), role: z.string().min(1) }).strict(),
    reasonText: z.string().min(1).max(2_000),
    current: CurrentTerms,
    requested: z
      .object({
        commissionRateBp: z.number().int().min(0).max(10_000),
        guaranteeRateBp: z.number().int().min(0).max(10_000),
        guaranteeKind: z.enum(['DEPOSIT', 'PERFORMANCE_BOND']),
      })
      .strict(),
  })
  .strict();
const ApprovalView = z.record(z.string(), z.unknown());
const AdjustmentFacts = z
  .object({
    approvalId: z.string(),
    kind: z.literal('SETTLEMENT_ADJUSTMENT'),
    targetRef: z.string(),
    amount: z.number().int(),
    reasonCode: z.string(),
    status: z.enum(['PENDING_APPROVAL', 'REJECTED', 'EXECUTING', 'DONE', 'FAILED']),
    requiredApprovals: z.literal(2),
    requestedBy: z.string(),
    approvals: z.array(z.string()),
    approvedAt: z.string().nullable(),
  })
  .strict();

@Controller('internal/v1/approval-requests')
@UseGuards(InternalTokenGuard)
export class InternalApprovalsController {
  constructor(
    private readonly contracts: ContractApprovals,
    private readonly adjustments: SettlementAdjustmentApprovals,
  ) {}

  @Get(':approvalId')
  @Roles(['public'])
  @ContractRouteSchema({ params: ApprovalParams, responses: { 200: AdjustmentFacts } })
  async facts(@ContractParams(ApprovalParams) params: z.output<typeof ApprovalParams>, @Res({ passthrough: true }) reply: FastifyReply): Promise<z.output<typeof AdjustmentFacts>> {
    void reply.header('cache-control', 'no-store');
    const facts = await this.adjustments.facts(params.approvalId);
    if (!facts) throw new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
    return facts;
  }

  @Put(':approvalId')
  @HttpCode(200)
  @Roles(['public'])
  @ContractRouteSchema({ params: ApprovalParams, body: CreateBody, responses: { 200: ApprovalView } })
  async create(@ContractParams(ApprovalParams) params: z.output<typeof ApprovalParams>, @ContractBody(CreateBody) body: z.output<typeof CreateBody>) {
    return this.contracts.createFromCore({
      approvalId: params.approvalId,
      kind: body.kind,
      targetRef: body.targetRef,
      requestedBy: body.requestedBy,
      reasonText: body.reasonText,
      current: body.current,
      requested: body.requested,
    });
  }
}
