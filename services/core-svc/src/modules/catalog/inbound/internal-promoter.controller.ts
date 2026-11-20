// 받는 층: ops-svc가 부르는 계약 승인 적용·취소 내부 경로(BAT-615 LCH-070, ADR-0320 결정 3·9).
// 클러스터 안에서만 닿고(게이트웨이에 없다) 서비스 사이 토큰으로 한 번 더 좁힌다. 같은 승인 ID 재호출은 같은 답이다.
import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ContractBody, ContractParams, ContractRouteSchema, Roles } from '@peaket/platform';
import { z } from 'zod';
import { ApplyContractApproval } from '../application/promoters.js';
import { InternalToken401Guard } from './internal-sale-config.controller.js';

const ContractApprovalParams = z.object({ promoterId: z.string().min(1).max(64), approvalId: z.string().min(1).max(64) });
const GuaranteeKind = z.enum(['DEPOSIT', 'PERFORMANCE_BOND']);
export const ContractApprovalBody = z
  .object({
    commissionRateBp: z.number().int().min(0).max(10_000).optional(),
    guaranteeRateBp: z.number().int().min(0).max(10_000).optional(),
    guaranteeKind: GuaranteeKind.optional(),
    approvedAt: z.string().min(1),
    approverId: z.string().min(1),
  })
  .strict();
const CancelBody = z.object({ reason: z.string().max(2_000).optional() }).strict();
const Applied = z.object({ applied: z.literal(true), validFrom: z.string() }).strict();
const Cancelled = z.object({ cancelled: z.literal(true) }).strict();

@Controller('internal/v1/promoters')
@UseGuards(InternalToken401Guard)
export class InternalPromoterController {
  constructor(private readonly apply: ApplyContractApproval) {}

  @Post(':promoterId/contract-approvals/:approvalId')
  @HttpCode(200)
  @Roles(['public'])
  @ContractRouteSchema({ params: ContractApprovalParams, body: ContractApprovalBody, responses: { 200: Applied } })
  async approval(@ContractParams(ContractApprovalParams) params: z.output<typeof ContractApprovalParams>, @ContractBody(ContractApprovalBody) body: z.output<typeof ContractApprovalBody>) {
    return this.apply.run(params.promoterId, params.approvalId, body);
  }

  @Post(':promoterId/contract-approvals/:approvalId/cancellations')
  @HttpCode(200)
  @Roles(['public'])
  @ContractRouteSchema({ params: ContractApprovalParams, body: CancelBody, responses: { 200: Cancelled } })
  async cancellation(@ContractParams(ContractApprovalParams) params: z.output<typeof ContractApprovalParams>) {
    return this.apply.cancel(params.promoterId, params.approvalId);
  }
}
