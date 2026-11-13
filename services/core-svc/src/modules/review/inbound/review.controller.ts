// 받는 층: 관람 후기·신고(openapi reviews 태그, SCR-016, FR-016·FR-070, ADR-0063·0066, BAT-585).
// 목록·요약은 공개(팬 쿠키가 있으면 mine·reportedByMe), 쓰기·고치기·지우기·신고는 로그인 팬만이다.
import { Controller, Delete, Get, HttpCode, Patch, Post } from '@nestjs/common';
import {
  CreateEventReviewBody,
  CreateEventReviewResponse,
  CreateReviewReportBody,
  CreateReviewReportResponse,
  GetEventReviewEligibilityParams,
  GetEventReviewEligibilityResponse,
  GetEventReviewSummaryResponse,
  GetReviewParams,
  GetReviewResponse,
  ListEventReviewsQueryParams,
  ListEventReviewsResponse,
  UpdateReviewResponse,
} from '@peaket/contracts/openapi/reviews';
import { ContractBody, ContractParams, ContractQuery, ContractRouteSchema, CurrentPrincipal, type Principal, Roles } from '@peaket/platform';
import { z } from 'zod';
import { Reviews } from '../application/reviews.js';
import type { EligibilityView, ReviewPage, ReviewSort, ReviewSummary, ReviewView } from '../domain/review.js';

const EventParams = z.object({ eventId: z.string() }).strict();
const ReviewParams = z.object({ reviewId: z.string() }).strict();
const WriteBody = CreateEventReviewBody;
const ReportBody = CreateReviewReportBody;
const NoBody = z.null();

@Controller('v1')
export class ReviewController {
  constructor(private readonly reviews: Reviews) {}

  @Get('events/:eventId/reviews')
  @ContractRouteSchema({ responses: { 200: ListEventReviewsResponse } })
  @Roles(['public', 'fan'])
  async list(
    @ContractParams(EventParams) params: z.output<typeof EventParams>,
    @ContractQuery(ListEventReviewsQueryParams) q: z.output<typeof ListEventReviewsQueryParams>,
    @CurrentPrincipal() me: Principal | undefined,
  ): Promise<ReviewPage> {
    return this.reviews.list(params.eventId.toLowerCase(), me?.accountId, q.sort as ReviewSort, q.cursor, q.limit ?? 10);
  }

  @Get('events/:eventId/review-summary')
  @ContractRouteSchema({ responses: { 200: GetEventReviewSummaryResponse } })
  @Roles(['public'])
  async summary(@ContractParams(EventParams) params: z.output<typeof EventParams>): Promise<ReviewSummary> {
    return this.reviews.summary(params.eventId.toLowerCase());
  }

  @Get('events/:eventId/review-eligibility')
  @ContractRouteSchema({ responses: { 200: GetEventReviewEligibilityResponse } })
  @Roles(['fan'])
  async eligibility(@ContractParams(GetEventReviewEligibilityParams) params: z.output<typeof GetEventReviewEligibilityParams>, @CurrentPrincipal() me: Principal): Promise<EligibilityView> {
    return this.reviews.eligibility(params.eventId.toLowerCase(), me.accountId);
  }

  @Post('events/:eventId/reviews')
  @ContractRouteSchema({ responses: { 201: CreateEventReviewResponse } })
  @Roles(['fan'])
  @HttpCode(201)
  async create(@ContractParams(EventParams) params: z.output<typeof EventParams>, @ContractBody(WriteBody) body: z.output<typeof WriteBody>, @CurrentPrincipal() me: Principal): Promise<ReviewView> {
    return this.reviews.create(params.eventId.toLowerCase(), me.accountId, body);
  }

  @Get('reviews/:reviewId')
  @ContractRouteSchema({ responses: { 200: GetReviewResponse } })
  @Roles(['public', 'fan'])
  async get(@ContractParams(GetReviewParams) params: z.output<typeof GetReviewParams>, @CurrentPrincipal() me: Principal | undefined): Promise<ReviewView> {
    return this.reviews.get(params.reviewId.toLowerCase(), me?.accountId);
  }

  @Patch('reviews/:reviewId')
  @ContractRouteSchema({ responses: { 200: UpdateReviewResponse } })
  @Roles(['fan'])
  async update(@ContractParams(ReviewParams) params: z.output<typeof ReviewParams>, @ContractBody(WriteBody) body: z.output<typeof WriteBody>, @CurrentPrincipal() me: Principal): Promise<ReviewView> {
    return this.reviews.update(params.reviewId.toLowerCase(), me.accountId, body);
  }

  @Delete('reviews/:reviewId')
  @ContractRouteSchema({ responses: { 204: NoBody } })
  @Roles(['fan'])
  @HttpCode(204)
  async remove(@ContractParams(ReviewParams) params: z.output<typeof ReviewParams>, @CurrentPrincipal() me: Principal): Promise<void> {
    await this.reviews.delete(params.reviewId.toLowerCase(), me.accountId);
  }

  @Post('reviews/:reviewId/reports')
  @ContractRouteSchema({ responses: { 201: CreateReviewReportResponse } })
  @Roles(['fan'])
  @HttpCode(201)
  async report(@ContractParams(ReviewParams) params: z.output<typeof ReviewParams>, @ContractBody(ReportBody) body: z.output<typeof ReportBody>, @CurrentPrincipal() me: Principal): Promise<{ reportId: string }> {
    return this.reviews.report(params.reviewId.toLowerCase(), me.accountId, body);
  }
}
