// 받는 층: ops-svc가 부르는 계약 승인 적용·취소, payment-svc가 부르는 지금 계약 조건 내부 경로
// (BAT-615 LCH-070, BAT-630 LCH-110, ADR-0320 결정 3·9).
// 클러스터 안에서만 닿고(게이트웨이에 없다) 서비스 사이 토큰으로 한 번 더 좁힌다. 같은 승인 ID 재호출은 같은 답이다.
import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { ContractBody, ContractParams, ContractRouteSchema, Roles } from '@peaket/platform';
import { z } from 'zod';
import { ApplyContractApproval } from '../application/promoters.js';
import { PROMOTER_STORE, type PromoterStore } from '../domain/promoter-ports.js';
import { InternalToken401Guard } from './internal-sale-config.controller.js';

const ContractApprovalParams = z.object({ promoterId: z.string().min(1).max(64), approvalId: z.string().min(1).max(64) });
const ContractParamsOnly = z.object({ promoterId: z.string().min(1).max(64) });
const ContractView = z.object({ commissionRateBp: z.number(), guaranteeRateBp: z.number(), guaranteeKind: z.enum(['DEPOSIT', 'PERFORMANCE_BOND']) });
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
  constructor(
    private readonly apply: ApplyContractApproval,
    @Inject(PROMOTER_STORE) private readonly promoters: PromoterStore,
  ) {}

  /** payment-svc 보증 충당이 지금 계약의 보증 비율·종류를 읽는다(BAT-630 LCH-110). 없으면 404. */
  @Get(':promoterId/contract')
  @Roles(['public'])
  @ContractRouteSchema({ params: ContractParamsOnly, responses: { 200: ContractView } })
  async currentContract(@Param('promoterId') promoterId: string) {
    const detail = await this.promoters.detail(promoterId);
    if (!detail) throw new NotFoundException();
    return { commissionRateBp: detail.contract.commissionRateBp, guaranteeRateBp: detail.contract.guaranteeRateBp, guaranteeKind: detail.contract.guaranteeKind };
  }

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
