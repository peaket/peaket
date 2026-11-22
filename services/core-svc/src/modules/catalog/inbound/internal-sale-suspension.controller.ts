// 받는 층: ops-svc가 판매 중지·재개를 core 공연 판매 승인 상태에 반영하는 내부 HTTP 경로(BAT-620 LCH-090, ADR-0123, SR-T8 ③).
// 판매 설정 읽기·회차 상태 반영과 같은 내부 토큰 가드(없거나 틀리면 401)를 쓴다. 게이트웨이 HTTPRoute에 없고 클러스터 안에서만 닿는다.
// GET …/sale-review-scope: 집행 순서용 비취소 회차 목록(중지는 판매를 먼저 막고 공개를 내린다).
// POST …/sale-review-result: SUSPENDED·RESUMED. 200 {status, productionId, eventIds, resumeEventIds}, 404 not-found, 409 sale-suspension-conflict, 400 invalid-body. no-store.
import { Controller, Get, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ContractBody, ContractRouteSchema, ProblemError, Roles } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ChangeSaleSuspension, SALE_SUSPENDED_SEARCH_REASON } from '../application/change-sale-suspension.js';
import { notFound } from '../application/problems.js';
import { SALE_SUSPENSION_REASON_CODES, SaleSuspensionConflict, SaleSuspensionNotFound } from '../domain/sale-suspension.js';
import { InternalToken401Guard } from './internal-sale-config.controller.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 내부 본문(openapi 계약이 아니라 core-svc 안의 닫힌 스키마다. 모르는 칸은 400) */
const SaleReviewResultBody = z
  .object({
    kind: z.enum(['SUSPENDED', 'RESUMED']),
    approvalId: z.string().min(1).max(200),
    reasonCode: z.enum(SALE_SUSPENSION_REASON_CODES).optional(),
    reason: z.string().min(1).max(1_000).optional(),
  })
  .strict();

const ScopeResponse = z
  .object({ productionId: z.uuid(), saleReview: z.string(), eventIds: z.array(z.uuid()) })
  .strict();
const ResultResponse = z
  .object({ status: z.enum(['APPLIED', 'UNCHANGED']), productionId: z.uuid(), eventIds: z.array(z.uuid()), resumeEventIds: z.array(z.uuid()) })
  .strict();
const SuspendedResponse = z.object({ suspendedEventIds: z.array(z.uuid()) }).strict();

/** 지급 묶음 하나가 한 번에 물을 수 있는 회차 수 상한. payment-svc 어댑터도 100개씩 나눈다. */
export const SALE_SUSPENSIONS_MAX = 100;

const invalidBody = () => new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다' });
const invalidQuery = () => new ProblemError({ type: 'invalid-query', status: 400, title: '목록 조건이 올바르지 않습니다' });
const conflict = () => new ProblemError({ type: 'sale-suspension-conflict', status: 409, title: '판매 승인 상태와 맞지 않습니다' });

@Controller('internal/v1/events')
@UseGuards(InternalToken401Guard)
export class InternalSaleSuspensionController {
  constructor(private readonly change: ChangeSaleSuspension) {}

  @Get('sale-suspensions')
  @ContractRouteSchema({ responses: { 200: SuspendedResponse } })
  @Roles(['public'])
  async suspended(@Query() q: Record<string, string | undefined>, @Res({ passthrough: true }) reply: FastifyReply): Promise<z.output<typeof SuspendedResponse>> {
    void reply.header('cache-control', 'no-store');
    const raw = typeof q.eventIds === 'string' ? q.eventIds : '';
    const ids = [...new Set(raw.split(',').map((id) => id.trim()).filter((id) => id !== ''))];
    if (ids.length === 0 || ids.length > SALE_SUSPENSIONS_MAX || ids.some((id) => !UUID.test(id))) throw invalidQuery();
    return { suspendedEventIds: [...(await this.change.listSuspended(ids))] };
  }

  @Get(':eventId/sale-review-scope')
  @ContractRouteSchema({ responses: { 200: ScopeResponse } })
  @Roles(['public'])
  async scope(@Param('eventId') eventId: string, @Res({ passthrough: true }) reply: FastifyReply): Promise<z.output<typeof ScopeResponse>> {
    void reply.header('cache-control', 'no-store');
    if (typeof eventId !== 'string' || !UUID.test(eventId)) throw notFound();
    try {
      const found = await this.change.scope(eventId);
      return { productionId: found.productionId, saleReview: found.saleReview, eventIds: [...found.eventIds] };
    } catch (e) {
      if (e instanceof SaleSuspensionNotFound) throw notFound();
      throw e;
    }
  }

  @Post(':eventId/sale-review-result')
  @HttpCode(200)
  @ContractRouteSchema({ body: SaleReviewResultBody, responses: { 200: ResultResponse } })
  @Roles(['public'])
  async apply(
    @Param('eventId') eventId: string,
    @ContractBody(SaleReviewResultBody) body: z.output<typeof SaleReviewResultBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<z.output<typeof ResultResponse>> {
    void reply.header('cache-control', 'no-store');
    if (typeof eventId !== 'string' || !UUID.test(eventId)) throw notFound();
    // 중지는 사유 코드·사유가 꼭 있고, 재개에는 없다(사유는 중지 때 남긴다)
    if (body.kind === 'SUSPENDED' ? body.reasonCode === undefined || body.reason === undefined : body.reasonCode !== undefined || body.reason !== undefined) {
      throw invalidBody();
    }
    try {
      const r = await this.change.run({
        eventId,
        kind: body.kind,
        approvalId: body.approvalId,
        ...(body.reasonCode !== undefined ? { reasonCode: body.reasonCode } : {}),
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
      });
      return { ...r, eventIds: [...r.eventIds], resumeEventIds: [...r.resumeEventIds] };
    } catch (e) {
      if (e instanceof SaleSuspensionNotFound) throw notFound();
      if (e instanceof SaleSuspensionConflict) throw conflict();
      throw e;
    }
  }
}

/** search_removed 이유를 다른 곳에서도 같은 이름으로 쓰게 남긴다(시험·문서 대조) */
export const SALE_SUSPENDED_REASON = SALE_SUSPENDED_SEARCH_REASON;
