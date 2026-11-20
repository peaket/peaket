// 받는 층: purchase-svc가 회차 판매 설정 사본(event_sale_config)을 읽는 내부 HTTP 경로(BAT-051, HOT-252).
// purchase-svc가 core DB에 직접 접속하지 않게 core-svc가 대신 읽는다. 클러스터 안에서만 닿는 경로이고(게이트웨이 HTTPRoute에 없다),
// 서비스 사이 토큰(InternalTokenGuard)으로 한 번 더 좁힌다. 설정이 없으면 404 not-found, 응답은 항상 no-store다.
import { type ExecutionContext, Controller, Get, Inject, Injectable, Optional, Param, Query, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ContractRouteSchema, INTERNAL_TOKEN, INTERNAL_TOKEN_REQUIRED, InternalTokenGuard, Roles } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { notFound } from '../application/problems.js';
import type { EventSaleConfig } from '../domain/event-sale-config.js';
import { SALE_CONFIG_READER, type SaleConfigReader } from '../domain/sale-config-ports.js';

/** 내부 응답 모양(event_sale_config.payload). openapi 계약이 아니라 core-svc 안의 닫힌 스키마다 */
const SaleConfigResponse = z
  .object({
    eventId: z.string(),
    productionId: z.string(),
    promoterId: z.string(),
    title: z.string().optional(),
    rev: z.number(),
    opensAtMs: z.number(),
    startsAtMs: z.number(),
    lobbyMinutes: z.number(),
    lobbyShuffle: z.boolean(),
    openBatch: z.boolean(),
    perPersonLimit: z.number(),
    saleEndsAtMs: z.number(),
    reentryAllowed: z.boolean().optional(),
    entryOpensAtMs: z.number().nullable().optional(),
    endsAtMs: z.number().optional(),
    entryClosedAtMs: z.number().nullable().optional(),
    commissionRateBp: z.number().optional(),
    layoutVersion: z.number().optional(),
    pgKey: z.string().optional(),
    pgTps: z.number().optional(),
    salePolicy: z.array(z.unknown()),
    eligGates: z.array(z.unknown()),
    eligLists: z.array(z.string()),
  })
  .strict();

const DueEventsResponse = z
  .object({ items: z.array(z.object({ eventId: z.string(), promoterId: z.string(), endsAt: z.string() })) })
  .strict();
const CommissionRateResponse = z.object({ commissionRateBp: z.number() }).strict();

/**
 * 내부 토큰이 없거나 틀리면 401(공용 InternalTokenGuard의 403과 달리 이 경로의 계약이다).
 * 판정 규칙과 시작 차단은 공용 InternalTokenGuard를 그대로 쓴다: local·ci에서만 토큰 없이 통과하고,
 * 그 밖의 환경은 토큰이 없으면 시작하지 않는다(fail-closed). INTERNAL_TOKEN_REQUIRED는 createService가 전역으로 준다.
 */
@Injectable()
export class InternalToken401Guard extends InternalTokenGuard {
  constructor(
    @Inject(INTERNAL_TOKEN) expected?: string,
    @Optional() @Inject(INTERNAL_TOKEN_REQUIRED) required = false,
  ) {
    super(expected, required);
  }

  override canActivate(context: ExecutionContext): boolean {
    if (!super.canActivate(context)) throw new UnauthorizedException('내부 토큰이 올바르지 않습니다');
    return true;
  }
}

@Controller('internal/v1/events')
@UseGuards(InternalToken401Guard)
export class InternalSaleConfigController {
  constructor(@Inject(SALE_CONFIG_READER) private readonly configs: SaleConfigReader) {}

  @Get('settlement-due')
  @ContractRouteSchema({ responses: { 200: DueEventsResponse } })
  @Roles(['public'])
  async due(@Query() q: Record<string, string | undefined>, @Res({ passthrough: true }) reply: FastifyReply): Promise<{ items: { eventId: string; promoterId: string; endsAt: string }[] }> {
    void reply.header('cache-control', 'no-store');
    const through = q.through && /^\d{4}-\d{2}-\d{2}$/.test(q.through) ? new Date(`${q.through}T23:59:59.999Z`) : undefined;
    if (!through || Number.isNaN(through.getTime())) throw notFound();
    const limit = Math.min(Math.max(Number(q.limit ?? 100), 1), 500);
    const rows = await this.configs.listEndedBefore(through, limit);
    return { items: rows.map((r) => ({ eventId: r.eventId, promoterId: r.promoterId, endsAt: r.endsAt.toISOString() })) };
  }

  @Get(':eventId/sale-config')
  @ContractRouteSchema({ responses: { 200: SaleConfigResponse } })
  @Roles(['public'])
  async get(@Param('eventId') eventId: string, @Res({ passthrough: true }) reply: FastifyReply): Promise<EventSaleConfig> {
    void reply.header('cache-control', 'no-store');
    const config = typeof eventId === 'string' ? await this.configs.get(eventId) : undefined;
    if (!config) throw notFound();
    return config;
  }

  /** 회차 정산의 수수료율(bp). 판매 승인 때 event.commission_rate_bp에 고정한 값이고, 없으면 404다(A1-H10) */
  @Get(':eventId/commission-rate')
  @ContractRouteSchema({ responses: { 200: CommissionRateResponse } })
  @Roles(['public'])
  async commissionRate(@Param('eventId') eventId: string, @Res({ passthrough: true }) reply: FastifyReply): Promise<{ commissionRateBp: number }> {
    void reply.header('cache-control', 'no-store');
    const rate = typeof eventId === 'string' ? await this.configs.commissionRateBp(eventId) : undefined;
    if (rate === undefined) throw notFound();
    return { commissionRateBp: rate };
  }
}
