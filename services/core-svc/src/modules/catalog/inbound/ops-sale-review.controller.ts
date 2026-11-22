// 받는 층: 관제 판매 승인 목록·상세·승인·반려(openapi GET /v1/ops/sale-reviews, GET /v1/ops/sale-reviews/{productionId},
// POST …/approvals·rejections, 판매 승인 LCH-080, BAT-616, ADR-0327).
// operator·commander만 승인·반려하고, viewer·CS를 포함한 다섯 역할이 목록·상세를 읽는다(authz-matrix §4.1). 응답은 no-store다.
// 판매 승인은 공연 단위이고 그 공연의 회차를 모두 함께 판정한다(ADR-0093).
import { Controller, Get, Header, HttpCode, Post } from '@nestjs/common';
import { ListOpsSaleReviewsQueryParams } from '@peaket/contracts/openapi/ops';
import { ContractBody, ContractParams, ContractQuery, ContractRouteSchema, Roles } from '@peaket/platform';
import { z } from 'zod';
import { ApproveSaleReview } from '../application/approve-sale-review.js';
import { RejectSaleReview } from '../application/reject-sale-review.js';
import { OpsSaleReviews } from '../application/request-sale-review.js';
import { ProductionParams } from './partner-production.controller.js';

const Scale = z.enum(['LARGE', 'MEDIUM', 'SMALL']);
/** 목록 쿼리는 계약 생성 스키마를 그대로 쓰고 닫는다. status·cursor·limit을 반복하면 파이프가 겹친 매개변수로 400을 낸다(ASVS 15.3.7) */
const ListQuery = ListOpsSaleReviewsQueryParams.strict();
export const SaleApprovalBody = z
  .object({
    scales: z.array(z.object({ eventId: z.uuid(), scale: Scale }).strict()).min(1),
    placeId: z.uuid().optional(),
    accessibleSeatingCheck: z.boolean().optional(),
  })
  .strict();
export const SaleRejectionBody = z.object({ reason: z.string().min(1).max(1000) }).strict();
const SaleApprovalResponse = z.object({ applied: z.literal(true), events: z.number().int().min(0) }).strict();
const SaleRejectionResponse = z.object({ applied: z.literal(true) }).strict();
const SaleReviewItemView = z
  .object({
    productionId: z.string(),
    title: z.string(),
    promoterId: z.string(),
    promoterName: z.string(),
    status: z.string(),
    reapproval: z.boolean(),
    submittedAt: z.unknown().nullable(),
    firstOpenAt: z.unknown().nullable(),
    eventCount: z.number(),
    suspensionApprovalPending: z.boolean(),
  })
  .passthrough();
const SaleReviewPageView = z.object({ items: z.array(SaleReviewItemView), nextCursor: z.string().nullable() }).passthrough();
const SaleReviewDetailView = z
  .object({
    productionId: z.string(),
    title: z.string(),
    promoterId: z.string(),
    promoterName: z.string(),
    status: z.string(),
    reapproval: z.boolean(),
    submittedAt: z.unknown().nullable(),
    rejectionReason: z.string().nullable(),
    seller: z.record(z.string(), z.unknown()).nullable(),
    verifiedAt: z.unknown().nullable(),
    salePolicy: z.array(z.record(z.string(), z.unknown())),
    events: z.array(z.record(z.string(), z.unknown())),
    placeId: z.string().nullable(),
    placeName: z.string().nullable(),
    requestedPlace: z.boolean(),
    accessibleSeatingCheck: z.boolean().nullable(),
    suspensionApprovalPending: z.boolean(),
  })
  .passthrough();

@Controller('v1/ops/sale-reviews')
export class OpsSaleReviewController {
  constructor(
    private readonly approve: ApproveSaleReview,
    private readonly reject: RejectSaleReview,
    private readonly reviews: OpsSaleReviews,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Roles(['viewer', 'operator', 'commander', 'cs_agent', 'cs_lead'])
  @ContractRouteSchema({ responses: { 200: SaleReviewPageView } })
  async list(@ContractQuery(ListQuery) q: z.output<typeof ListQuery>) {
    return this.reviews.list({
      ...(q.status !== undefined ? { statuses: q.status } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
    });
  }

  @Get(':productionId')
  @Header('Cache-Control', 'no-store')
  @Roles(['viewer', 'operator', 'commander', 'cs_agent', 'cs_lead'])
  @ContractRouteSchema({ params: ProductionParams, responses: { 200: SaleReviewDetailView } })
  async detail(@ContractParams(ProductionParams) params: z.output<typeof ProductionParams>) {
    return this.reviews.detail(params.productionId.toLowerCase());
  }

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
