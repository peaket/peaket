// 받는 층: 회차 공개 요약(openapi GET /v1/events/{eventId}, getEvent, BUILD_ORDER HOT-170 ①).
// 인증 없음(역할 public). 판매 승인되고 판매 중지가 아닌 공연의 회차만 답한다. 승인 이력이 없는 회차와 없는 회차는 같은 404 not-found,
// 한 번 공개된 뒤 판매 중지된 회차는 410 event-suspended다(사유 없음, authz-matrix §3.5, ADR-0200 결정 3).
// 회차 ID는 계약대로 문자열이면 받는다. 모양이 틀린 ID도 저장소가 없는 회차로 답한다(같은 404, 계약에 없는 400을 내지 않는다).
// 캐시: 쿠키를 캐시 키에 넣지 않고 200만 Cache-Control: public, max-age=300, stale-if-error=86400 [가정](계약 설명).
// 200은 CDN 태그 머리 x-peaket-cache-tag: event:{회차 ID}(DB의 소문자 값)를 싣는다. 판매 승인·판매 중지·회차 변경 때 core-svc가 이 태그로
// 무효화하므로, 대문자로 부른 주소의 사본도 함께 지워진다(docs/infra.md §4.1, docs/frontend.md §2.5 /events/[id] 행).
// 404는 no-store [가정]: 판매 승인 직후 공개가 캐시된 404에 늦게 보이지 않게 한다.
// 팬별 판매 자격(GET /v1/events/{eventId}/sale-eligibility, 팬 로그인, ADR-0261 결정 5)은 같은 404·410 규칙이고 성공·오류 모두 no-store다(비로그인 401도 모듈 미들웨어가 단다).
import { Controller, Get, Res } from '@nestjs/common';
import { GetFanSaleEligibilityResponse } from '@peaket/contracts/openapi/catalog';
import { ContractParams, ContractRouteSchema, CurrentPrincipal, type Principal, Roles } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { type EventPublicSummary, GetEventSummary } from '../application/get-event-summary.js';
import { FanSaleEligibility, type FanSaleEligibilityView } from '../application/fan-sale-eligibility.js';
import { eventSuspended, notFound } from '../application/problems.js';

/** 계약의 EventId 경로 칸(문자열). 모양이 틀린 ID는 저장소가 없는 회차로 답한다(같은 404) */
export const EventParams = z.object({ eventId: z.string() }).strict();

export const PUBLIC_SUMMARY_CACHE = 'public, max-age=300, stale-if-error=86400';
/** CDN 태그 머리 이름(CloudFront CacheTagConfig.HeaderName, docs/infra.md §4.1) [가정] */
export const CACHE_TAG_HEADER = 'x-peaket-cache-tag';
export const eventCacheTag = (eventId: string) => `event:${eventId.toLowerCase()}`;
/** 응답에 공연 칸·회차 목록이 있어 공연 태그도 싣는다(공연 단위 변경이 그 공연의 모든 회차를 지운다, ADR-0200 결정 5) */
export const cacheTags = (s: { eventId: string; productionId: string }) => `${eventCacheTag(s.eventId)},production:${s.productionId.toLowerCase()}`;

@Controller('v1/events')
export class EventSummaryController {
  constructor(
    private readonly summary: GetEventSummary,
    private readonly eligibility: FanSaleEligibility,
  ) {}

  @Get(':eventId/sale-eligibility')
  @ContractRouteSchema({ responses: { 200: GetFanSaleEligibilityResponse } })
  @Roles(['fan'])
  async saleEligibility(@ContractParams(EventParams) params: z.output<typeof EventParams>, @CurrentPrincipal() me: Principal): Promise<FanSaleEligibilityView> {
    const found = await this.eligibility.run(params.eventId, me.accountId);
    if (!found || found === 'suspended') throw found ? eventSuspended() : notFound();
    return found;
  }

  @Get(':eventId')
  @Roles(['public'])
  async get(@ContractParams(EventParams) params: z.output<typeof EventParams>, @Res({ passthrough: true }) reply: FastifyReply): Promise<EventPublicSummary> {
    const found = await this.summary.run(params.eventId);
    if (!found || found === 'suspended') {
      void reply.header('cache-control', 'no-store');
      throw found ? eventSuspended() : notFound();
    }
    void reply.header('cache-control', PUBLIC_SUMMARY_CACHE);
    void reply.header(CACHE_TAG_HEADER, cacheTags(found));
    return found;
  }
}
