// 받는 층: 관제 판매 승인·반려(openapi POST /v1/ops/sale-reviews/{productionId}/approvals·rejections, 판매 승인 LCH-080).
// operator·commander만. 판매 승인은 공연 단위이고 그 공연의 회차를 모두 함께 판정한다(ADR-0093).
import { Controller, HttpCode, Post } from '@nestjs/common';
import { ContractBody, ContractParams, ContractRouteSchema, Roles } from '@peaket/platform';
import { z } from 'zod';
import { ApproveSaleReview } from '../application/approve-sale-review.js';
import { RejectSaleReview } from '../application/reject-sale-review.js';
import { ProductionParams } from './partner-production.controller.js';

const Scale = z.enum(['LARGE', 'MEDIUM', 'SMALL']);
export const SaleApprovalBody = z
  .object({
    scales: z.array(z.object({ eventId: z.uuid(), scale: Scale }).strict()).min(1),
    placeId: z.uuid(),
    accessibleSeatingCheck: z.boolean().optional(),
  })
  .strict();
export const SaleRejectionBody = z.object({ reason: z.string().min(1).max(1000) }).strict();
const SaleApprovalResponse = z.object({ applied: z.literal(true), events: z.number().int().min(0) }).strict();
const SaleRejectionResponse = z.object({ applied: z.literal(true) }).strict();

@Controller('v1/ops/sale-reviews')
export class OpsSaleReviewController {
  constructor(
    private readonly approve: ApproveSaleReview,
    private readonly reject: RejectSaleReview,
  ) {}

  @Post(':productionId/approvals')
  @ContractRouteSchema({ responses: { 200: SaleApprovalResponse } })
  @Roles(['operator', 'commander'])
  @HttpCode(200)
  async approval(@ContractParams(ProductionParams) params: z.output<typeof ProductionParams>, @ContractBody(SaleApprovalBody) body: z.output<typeof SaleApprovalBody>) {
    return this.approve.run({
      productionId: params.productionId.toLowerCase(),
      scales: body.scales,
      placeId: body.placeId,
      ...(body.accessibleSeatingCheck !== undefined ? { accessibleSeatingCheck: body.accessibleSeatingCheck } : {}),
    });
  }

  @Post(':productionId/rejections')
  @ContractRouteSchema({ responses: { 200: SaleRejectionResponse } })
  @Roles(['operator', 'commander'])
  @HttpCode(200)
  async rejection(@ContractParams(ProductionParams) params: z.output<typeof ProductionParams>, @ContractBody(SaleRejectionBody) body: z.output<typeof SaleRejectionBody>) {
    return this.reject.run({ productionId: params.productionId.toLowerCase(), reason: body.reason });
  }
}
