// 받는 층: purchase-svc가 회차 판매 설정 사본(event_sale_config)을 읽는 내부 HTTP 경로(BAT-051, HOT-252).
// purchase-svc가 core DB에 직접 접속하지 않게 core-svc가 대신 읽는다. 클러스터 안에서만 닿는 경로이고(게이트웨이 HTTPRoute에 없다),
// 서비스 사이 토큰(InternalTokenGuard)으로 한 번 더 좁힌다. 설정이 없으면 404 not-found, 응답은 항상 no-store다.
import { type CanActivate, type ExecutionContext, Controller, Get, Inject, Injectable, Param, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ContractRouteSchema, INTERNAL_TOKEN, Roles } from '@peaket/platform';
import type { FastifyRequest } from 'fastify';
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

/** 내부 토큰이 없거나 틀리면 401(공용 InternalTokenGuard의 403과 달리 이 경로의 계약이다). 토큰이 비면 local·ci처럼 통과한다 */
@Injectable()
class InternalToken401Guard implements CanActivate {
  constructor(@Inject(INTERNAL_TOKEN) private readonly expected?: string) {}
  canActivate(context: ExecutionContext): boolean {
    if (!this.expected) return true;
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (request.headers['x-peaket-internal-token'] !== this.expected) throw new UnauthorizedException('내부 토큰이 올바르지 않습니다');
    return true;
  }
}

@Controller('internal/v1/events')
@UseGuards(InternalToken401Guard)
export class InternalSaleConfigController {
  constructor(@Inject(SALE_CONFIG_READER) private readonly configs: SaleConfigReader) {}

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
