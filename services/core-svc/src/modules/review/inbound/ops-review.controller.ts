// 받는 층: CS 처리함의 후기 신고 상세·조치(openapi GET /v1/ops/reviews/{reviewId}, POST /v1/ops/reviews/{reviewId}/moderation,
// SCR-045, FR-057·FR-070, POL-044, ADR-0066, BAT-585). cs_agent만. 신고자 계정은 응답에 싣지 않는다.
import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { CreateOpsReviewModerationBody, CreateOpsReviewModerationParams } from '@peaket/contracts/openapi/ops';
import { ContractBody, ContractParams, ContractRouteSchema, Roles } from '@peaket/platform';
import { z } from 'zod';
import { Reviews } from '../application/reviews.js';

const ReviewRecordSchema = z
  .object({
    reviewId: z.string(),
    eventId: z.string(),
    productionId: z.string(),
    accountId: z.string(),
    basisOrderId: z.string(),
    rating: z.number(),
    body: z.string(),
    status: z.enum(['VISIBLE', 'HIDDEN', 'DELETED']),
    notice: z.enum(['RIGHTS_TEMP', 'POLICY']).optional(),
    noticeUntilMs: z.number().optional(),
    contentFingerprint: z.string(),
    authorDisplay: z.string(),
    createdAtMs: z.number(),
    updatedAtMs: z.number(),
    edited: z.boolean(),
  })
  .passthrough();
const OpsReviewDetail = z.object({
  review: ReviewRecordSchema,
  summary: z.object({
    total: z.number(),
    byCategory: z.record(z.string(), z.number()),
    reports: z.array(z.object({ category: z.string(), detail: z.string(), rightsHolder: z.boolean(), notifyChannel: z.string().optional(), createdAt: z.string() })),
  }),
});
const ModerationResponse = z.object({ applied: z.literal(true) });

@Controller('v1/ops/reviews')
export class OpsReviewController {
  constructor(private readonly reviews: Reviews) {}

  @Get(':reviewId')
  @ContractRouteSchema({ responses: { 200: OpsReviewDetail } })
  @Roles(['cs_agent', 'cs_lead'])
  async get(@ContractParams(CreateOpsReviewModerationParams) params: z.output<typeof CreateOpsReviewModerationParams>) {
    return this.reviews.reportedReview(params.reviewId.toLowerCase());
  }

  @Post(':reviewId/moderation')
  @ContractRouteSchema({ responses: { 200: ModerationResponse } })
  @Roles(['cs_agent', 'cs_lead'])
  @HttpCode(200)
  async moderate(@ContractParams(CreateOpsReviewModerationParams) params: z.output<typeof CreateOpsReviewModerationParams>, @ContractBody(CreateOpsReviewModerationBody) body: z.output<typeof CreateOpsReviewModerationBody>): Promise<{ applied: true }> {
    const endsAtMs = body.endsAt === undefined ? undefined : Date.parse(body.endsAt);
    return this.reviews.moderate(params.reviewId.toLowerCase(), {
      action: body.action,
      reason: body.reason,
      ...(body.violation ? { violation: body.violation } : {}),
      ...(endsAtMs === undefined || Number.isNaN(endsAtMs) ? {} : { endsAtMs }),
    });
  }
}
