// 받는 층: 파트너 판매 승인 요청·변경 취소·현황(openapi POST/DELETE/GET /v1/partner/productions/{productionId}/sale-review, BAT-616 LCH-080, ADR-0327).
// 요청·변경 취소는 partner_admin만 한다(partner_member 403, authz-matrix AZ-T3). 현황은 관리자·실무자 모두 읽는다.
// 본문은 닫힌 객체이고(모르는 칸 400), 정산 계좌는 모양만 보고 저장하지 않는다(지급대행 연동 전, LCH-110). 응답은 no-store다.
import { Controller, Delete, Get, Header, HttpCode, Post } from '@nestjs/common';
import { ContractBody, ContractParams, ContractRouteSchema, CurrentPrincipal, type Principal, Roles } from '@peaket/platform';
import { z } from 'zod';
import { RequestSaleReview } from '../application/request-sale-review.js';
import { type SaleReviewRequestBody } from '../domain/sale-review.js';
import { ProductionParams, tenantOf } from './partner-production.controller.js';

const SellerInput = z
  .object({
    legalName: z.string().min(1).max(100),
    representative: z.string().min(1).max(100),
    address: z.string().min(1).max(300),
    phone: z.string().min(1).max(30),
    email: z.email().max(200),
    businessRegNo: z.string().min(1).max(20),
    mailOrderReportNo: z.string().min(1).max(100).optional(),
    exemptionBasis: z.string().min(1).max(500).optional(),
  })
  .strict();

const PayoutAccountInput = z
  .object({
    bankCode: z.string().min(1).max(10),
    accountNumber: z.string().min(1).max(30),
    holderName: z.string().min(1).max(60),
  })
  .strict();

const AccessibleSeatingInput = z
  .object({
    confirmed: z.literal(true),
    shortfallReason: z.enum(['RELAXED_STANDARD', 'RECOMMENDED_FACILITY', 'NOT_USED_THIS_SHOW', 'OTHER']).optional(),
    note: z.string().max(500).optional(),
  })
  .strict();

/** 계약 CreatePartnerProductionSaleReviewBody */
export const PartnerSaleReviewBody = z
  .object({
    seller: SellerInput,
    payoutAccount: PayoutAccountInput,
    accessibleSeating: AccessibleSeatingInput,
  })
  .strict();

const RequestAccepted = z.object({ status: z.literal('SUBMITTED') }).strict();
const PartnerStatusView = z
  .object({
    saleReview: z.string(),
    rejectionReason: z.string().nullable(),
    hasApprovalHistory: z.boolean(),
    submittedAt: z.unknown().nullable(),
    seller: z.record(z.string(), z.unknown()).nullable(),
    events: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();

@Controller('v1/partner/productions')
export class PartnerSaleReviewController {
  constructor(private readonly reviews: RequestSaleReview) {}

  @Post(':productionId/sale-review')
  @HttpCode(202)
  @Roles(['partner_admin'])
  @ContractRouteSchema({ params: ProductionParams, body: PartnerSaleReviewBody, responses: { 202: RequestAccepted } })
  async request(@ContractParams(ProductionParams) params: z.output<typeof ProductionParams>, @ContractBody(PartnerSaleReviewBody) body: z.output<typeof PartnerSaleReviewBody>, @CurrentPrincipal() me: Principal) {
    return this.reviews.request({ productionId: params.productionId.toLowerCase(), tenantId: tenantOf(me), body: body as SaleReviewRequestBody });
  }

  @Delete(':productionId/sale-review')
  @HttpCode(204)
  @Roles(['partner_admin'])
  @ContractRouteSchema({ params: ProductionParams, responses: { 204: z.null() } })
  async cancel(@ContractParams(ProductionParams) params: z.output<typeof ProductionParams>, @CurrentPrincipal() me: Principal): Promise<void> {
    await this.reviews.cancel({ productionId: params.productionId.toLowerCase(), tenantId: tenantOf(me) });
  }

  @Get(':productionId/sale-review')
  @Header('Cache-Control', 'no-store')
  @Roles(['partner_admin', 'partner_member'])
  @ContractRouteSchema({ params: ProductionParams, responses: { 200: PartnerStatusView } })
  async status(@ContractParams(ProductionParams) params: z.output<typeof ProductionParams>, @CurrentPrincipal() me: Principal) {
    return this.reviews.status({ productionId: params.productionId.toLowerCase(), tenantId: tenantOf(me) });
  }
}
