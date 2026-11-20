// 받는 층: 봇 판정 표본 검토(openapi /v1/ops/events/{eventId}/bot-review, -samples, /v1/ops/bot-review-samples/{sampleId}/judgement).
// FR-049, SCR-067, ADR-0174. CS 두 역할만 부른다(authz-matrix §4.1). 상세 경로는 없다(목록 항목이 카드 전체를 싣는다).
// 진행·목록·판정 응답은 Cache-Control: no-store이고, 판정은 POST만 받는다(ASVS 3.2.1·3.5.3).
import { Body, Controller, Get, Header, HttpCode, Param, Post } from '@nestjs/common';
import {
  CreateOpsBotReviewSampleJudgementBody,
  CreateOpsBotReviewSampleJudgementParams,
  CreateOpsBotReviewSampleJudgementResponse,
  GetOpsEventBotReviewParams,
  GetOpsEventBotReviewQueryParams,
  GetOpsEventBotReviewResponse,
  ListOpsEventBotReviewSamplesParams,
  ListOpsEventBotReviewSamplesQueryParams,
  ListOpsEventBotReviewSamplesResponse,
} from '@peaket/contracts/openapi/ops';
import {
  ContractBody,
  ContractParams,
  ContractQuery,
  ContractRouteSchema,
  CurrentPrincipal,
  IdempotencyRequest,
  Idempotent,
  ProblemError,
  RequestValidationError,
  Roles,
  type Principal,
} from '@peaket/platform';
import { z } from 'zod';
import { GetBotReview } from '../application/get-review.js';
import { BotReviewBadQuery, ListBotReviewSamples } from '../application/list-samples.js';
import { RecordBotReviewJudgement } from '../application/record-judgement.js';
import { BotReviewProblem, judgementView } from '../domain/bot-review.js';

function reject(e: unknown): never {
  if (e instanceof BotReviewProblem) {
    throw new ProblemError({
      type: e.type,
      status: e.status,
      title: e.message,
      ...(e.retryAfterSeconds !== undefined ? { retryAfterSeconds: e.retryAfterSeconds } : {}),
    });
  }
  if (e instanceof BotReviewBadQuery) throw new RequestValidationError(e.message);
  throw e;
}

@Controller('v1/ops')
export class BotReviewController {
  constructor(
    private readonly getReview: GetBotReview,
    private readonly listSamples: ListBotReviewSamples,
    private readonly recordJudgement: RecordBotReviewJudgement,
  ) {}

  @Get('events/:eventId/bot-review')
  @Header('Cache-Control', 'no-store')
  @Roles(['cs_agent', 'cs_lead'])
  @ContractRouteSchema({ params: GetOpsEventBotReviewParams, query: GetOpsEventBotReviewQueryParams, responses: { 200: GetOpsEventBotReviewResponse } })
  async get(
    @ContractParams(GetOpsEventBotReviewParams) params: z.output<typeof GetOpsEventBotReviewParams>,
    @ContractQuery(GetOpsEventBotReviewQueryParams) query: z.output<typeof GetOpsEventBotReviewQueryParams>,
  ) {
    try {
      return await this.getReview.run({ eventId: params.eventId, reviewKind: query.reviewKind });
    } catch (e) {
      reject(e);
    }
  }

  @Get('events/:eventId/bot-review-samples')
  @Header('Cache-Control', 'no-store')
  @Roles(['cs_agent', 'cs_lead'])
  @ContractRouteSchema({
    params: ListOpsEventBotReviewSamplesParams,
    query: ListOpsEventBotReviewSamplesQueryParams,
    responses: { 200: ListOpsEventBotReviewSamplesResponse },
  })
  async list(
    @ContractParams(ListOpsEventBotReviewSamplesParams) params: z.output<typeof ListOpsEventBotReviewSamplesParams>,
    @ContractQuery(ListOpsEventBotReviewSamplesQueryParams) query: z.output<typeof ListOpsEventBotReviewSamplesQueryParams>,
  ) {
    try {
      return await this.listSamples.run({
        eventId: params.eventId,
        reviewKind: query.reviewKind,
        status: query.status,
        cursor: query.cursor,
        limit: query.limit,
      });
    } catch (e) {
      reject(e);
    }
  }

  @Post('bot-review-samples/:sampleId/judgement')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Roles(['cs_agent', 'cs_lead'])
  @Idempotent({ operation: 'CREATE_BOT_REVIEW_JUDGEMENT' })
  @ContractRouteSchema({
    params: CreateOpsBotReviewSampleJudgementParams,
    body: CreateOpsBotReviewSampleJudgementBody,
    responses: { 200: CreateOpsBotReviewSampleJudgementResponse },
  })
  async create(
    @ContractParams(CreateOpsBotReviewSampleJudgementParams) params: z.output<typeof CreateOpsBotReviewSampleJudgementParams>,
    @ContractBody(CreateOpsBotReviewSampleJudgementBody) body: z.output<typeof CreateOpsBotReviewSampleJudgementBody>,
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() idem: IdempotencyRequest,
  ) {
    try {
      const judgement = await this.recordJudgement.run({
        sampleId: params.sampleId,
        verdict: body.verdict,
        evidenceKinds: body.evidenceKinds ?? [],
        // 처리자는 본문이 아니라 인증된 Principal에서만 꺼낸다(계획 10 #2)
        actedBy: me.accountId,
        idem,
      });
      return judgementView(judgement);
    } catch (e) {
      reject(e);
    }
  }
}
