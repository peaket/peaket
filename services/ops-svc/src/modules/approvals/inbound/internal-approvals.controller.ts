// 받는 층: core-svc가 부르는 내부 승인 업무 생성(BAT-615 LCH-070, ADR-0320 결정 3).
// PUT /internal/v1/approval-requests/{approvalId}: 같은 승인 ID 재호출은 같은 답(멱등). 서비스 사이 토큰으로 좁힌다.
import { Body, Controller, HttpCode, Param, Put, UseGuards } from '@nestjs/common';
import { ContractBody, ContractParams, ContractRouteSchema, InternalTokenGuard, Roles } from '@peaket/platform';
import { z } from 'zod';
import { ContractApprovals } from '../application/contract-approvals.js';

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

@Controller('internal/v1/approval-requests')
@UseGuards(InternalTokenGuard)
export class InternalApprovalsController {
  constructor(private readonly contracts: ContractApprovals) {}

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
