// 받는 층: purchase-svc가 회차 판매 설정 사본(event_sale_config)을 읽는 내부 HTTP 경로(BAT-051, HOT-252).
// purchase-svc가 core DB에 직접 접속하지 않게 core-svc가 대신 읽는다. 클러스터 안에서만 닿는 경로이고(게이트웨이 HTTPRoute에 없다),
// identity의 /internal/jwks와 같은 public 역할이다. 설정이 없으면 404 not-found, 응답은 항상 no-store다.
import { Controller, Get, Inject, Param, Query, Res } from '@nestjs/common';
import { ContractRouteSchema, Roles } from '@peaket/platform';
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

@Controller('internal/v1/events')
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
}
