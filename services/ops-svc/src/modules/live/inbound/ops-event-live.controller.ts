// 관제 위젯 SSE 흐름 GET /v1/ops/events/{eventId}/live?widgets=(openapi, asyncapi sse.ops-event-live, ADR-0100 결정 1·2·4, docs/frontend.md §4.4.5, ADR-0360).
// 사건은 widget({widgetKey, at, value}) 하나이고 id는 값을 계산한 시각(ms)이다. 메시지마다 위젯의 전체 값이라 다시 붙으면 지금 값부터 받는다.
// 파드마다 (회차, 위젯 키)별로 한 번 계산해 나눠 준다(WidgetFeed). 모르는 위젯 키가 있으면 흐름을 열지 않고 422다.
// 하트비트·닫힘(토큰 만료·세션 종료·쌓임 상한)은 늘 여는 흐름과 같다.
import { Controller, Get, Inject, Optional, Param, Req, Res } from '@nestjs/common';
import { CLOCK, type Clock, ContractRouteSchema, CurrentPrincipal, PLATFORM_LOGGER, type PlatformLogger, type Principal, ProblemError, Roles } from '@peaket/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseWidgetList } from '../domain/widgets.js';
import { WidgetFeed } from '../application/widget-feed.js';
import { TERMINATED_SESSIONS } from '../tokens.js';
import { SseConnection, type TerminatedSessionsView } from './sse-connection.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const OpsEventLiveParams = z.object({ eventId: z.string().regex(UUID) });
export const OpsEventLiveQuery = z.object({ widgets: z.string().max(1024) });

@Controller('v1/ops/events/:eventId/live')
export class OpsEventLiveController {
  constructor(
    private readonly widgets: WidgetFeed,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(TERMINATED_SESSIONS) private readonly terminated?: TerminatedSessionsView,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: PlatformLogger,
  ) {}

  @Get()
  @Roles(['viewer', 'operator', 'commander', 'cs_agent', 'cs_lead'])
  @ContractRouteSchema({ params: OpsEventLiveParams, query: OpsEventLiveQuery, responses: { 200: z.string() } })
  async stream(@Param('eventId') eventId: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply, @CurrentPrincipal() me: Principal): Promise<void> {
    // 회차 ID 꼴은 경로 스키마(OpsEventLiveParams)가 먼저 본다
    const raw = (request.query as { widgets?: unknown } | undefined)?.widgets;
    const parsed = parseWidgetList(typeof raw === 'string' ? raw : undefined);
    if (!parsed.ok) {
      throw new ProblemError({ type: 'unknown-widget-key', status: 422, title: '모르는 위젯 키입니다', detail: `widgets: ${parsed.unknown.join(', ').slice(0, 200)}` });
    }
    const conn = new SseConnection(request, reply, {
      stream: 'ops-event-live',
      me,
      nowMs: this.clock.now(),
      ...(this.terminated ? { terminated: this.terminated } : {}),
      ...(this.logger ? { logger: this.logger } : {}),
    });
    conn.open();
    for (const key of parsed.keys) {
      const stop = this.widgets.subscribe(eventId.toLowerCase(), key, (v) => conn.send({ id: v.atMs, event: 'widget', data: { widgetKey: v.widgetKey, at: new Date(v.atMs).toISOString(), value: v.value } }));
      conn.onClose(stop);
    }
  }
}
