// 회차 단계·T-30분 점검 조회와 Go/No-Go 판정(openapi getOpsEventReadiness·createOpsGoNoGoJudgement, F-03-3 OPS-380, ADR-0371).
// 조회는 모든 관제 역할, 판정은 operator·commander(d5 §3.3 메뉴별 권한, ADR-0371 결정 5). Cache-Control: no-store.
// 판정 본문은 실패한 권고 항목의 사유만 읽는다. verdict·items 같은 다른 칸은 400으로 거절하지 않고 버린다(서버가 다시 계산한다, ASVS 8.2.3).
import { Body, Controller, Get, Header, HttpCode, Param, Post } from '@nestjs/common';
import { CreateOpsGoNoGoJudgementResponse, GetOpsEventReadinessResponse } from '@peaket/contracts/openapi/ops';
import { ContractRouteSchema, CurrentPrincipal, ProblemError, RequestValidationError, Roles, type Principal } from '@peaket/platform';
import { z } from 'zod';
import { JudgementRejected, ReadinessService, type ReadinessView } from '../application/readiness-service.js';
import { ReadinessSourceUnavailable, type GoNoGoJudgement, type SaleSchedule } from '../domain/readiness.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EventParams = z.object({ eventId: z.string().max(64) });
/** 판정 본문: 사유만 읽고 나머지 칸은 버린다 */
const JudgeBody = z.looseObject({ recommendedReasons: z.record(z.string().max(64), z.string().max(500)).optional() });

const iso = (ms: number) => new Date(ms).toISOString();
const notFound = () => new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다', detail: '판매 설정이 없는 회차입니다' });
const sourceUnavailable = () => new ProblemError({ type: 'readiness-source-unavailable', status: 503, title: '점검 원천을 읽지 못했습니다', detail: '회차 판매 설정을 읽지 못했습니다' });

function scheduleView(s: SaleSchedule) {
  return {
    opensAt: iso(s.opensAtMs),
    saleEndsAt: iso(s.saleEndsAtMs),
    ...(s.entryOpensAtMs !== null ? { entryOpensAt: iso(s.entryOpensAtMs) } : {}),
    ...(s.entryClosedAtMs !== null ? { entryClosedAt: iso(s.entryClosedAtMs) } : {}),
  };
}

/** 판정 요약(판정자 가명은 싣지 않는다) */
function judgementSummary(j: GoNoGoJudgement) {
  return {
    judgementId: j.judgementId,
    verdict: j.verdict,
    failedRequired: [...j.failedRequired],
    failedRecommended: [...j.failedRecommended],
    recommendedReasons: { ...j.recommendedReasons },
    judgedAt: iso(j.judgedAtMs),
    sequence: j.sequence,
  };
}

export function readinessView(v: ReadinessView) {
  return {
    eventId: v.eventId,
    stage: v.stage,
    ...(v.schedule ? { schedule: scheduleView(v.schedule) } : {}),
    items: v.items.map((i) => ({ ...i })),
    preview: { ...v.preview },
    ...(v.window ? { judgeableFrom: iso(v.window.fromMs), judgeableUntil: iso(v.window.untilMs) } : {}),
    ...(v.lastJudgement ? { lastJudgement: judgementSummary(v.lastJudgement) } : {}),
  };
}

@Controller('v1/ops/events/:eventId')
export class ReadinessController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get('readiness')
  @Roles(['viewer', 'operator', 'commander', 'cs_agent', 'cs_lead'])
  @Header('cache-control', 'no-store')
  @ContractRouteSchema({ params: EventParams, responses: { 200: GetOpsEventReadinessResponse } })
  async get(@Param('eventId') eventId: string) {
    if (!UUID.test(eventId)) throw notFound();
    try {
      return readinessView(await this.readiness.view(eventId.toLowerCase()));
    } catch (e) {
      if (e instanceof ReadinessSourceUnavailable) throw sourceUnavailable();
      throw e;
    }
  }

  @Post('go-no-go-judgements')
  @HttpCode(201)
  @Roles(['operator', 'commander'])
  @Header('cache-control', 'no-store')
  @ContractRouteSchema({ params: EventParams, responses: { 201: CreateOpsGoNoGoJudgementResponse } })
  async judge(@Param('eventId') eventId: string, @Body() raw: unknown, @CurrentPrincipal() me: Principal) {
    if (!UUID.test(eventId)) throw notFound();
    const body = JudgeBody.safeParse(raw ?? {});
    if (!body.success) throw new RequestValidationError('판정 본문이 올바르지 않습니다');
    try {
      const j = await this.readiness.judge(eventId.toLowerCase(), { accountId: me.accountId ?? '', recommendedReasons: body.data.recommendedReasons ?? {} });
      return { ...judgementSummary(j), eventId: j.eventId, items: j.items.map((i) => ({ ...i })) };
    } catch (e) {
      if (e instanceof ReadinessSourceUnavailable) throw sourceUnavailable();
      if (e instanceof JudgementRejected) {
        if (e.type === 'not-found') throw notFound();
        if (e.type === 'judgement-window-closed') throw new ProblemError({ type: 'judgement-window-closed', status: 409, title: '지금은 Go/No-Go 판정을 받지 않습니다', detail: e.message });
        throw new ProblemError({ type: 'recommended-reason-required', status: 422, title: '실패한 권고 항목의 사유를 적어 주세요', detail: e.message });
      }
      throw e;
    }
  }
}
