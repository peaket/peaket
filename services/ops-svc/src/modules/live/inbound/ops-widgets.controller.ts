// 관제 위젯 조회 GET /v1/ops/widgets/{widgetKey}?eventId=&from=&to=(openapi, docs/frontend.md §4.4.5, ADR-0100 결정 1, ADR-0360).
// 위젯을 처음 그리거나 다시 보일 때 지금 값과 그래프 창(기본 최근 15분)의 점을 준다. 위젯 키마다 응답 모양이 다르고(openapi oneOf),
// 모르는 키는 404다. 원천을 못 읽으면 200에 error 'source-unavailable'이다. 임의 쿼리를 받지 않는다. Cache-Control: no-store.
import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { ContractRouteSchema, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import { WIDGET_MAX_RANGE_MS, WIDGET_RANGE_MS, WidgetValue, isWidgetKey } from '../domain/widgets.js';
import { WidgetFeed } from '../application/widget-feed.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const OpsWidgetParams = z.object({ widgetKey: z.string().max(100) });
export const OpsWidgetQuery = z.object({
  eventId: z.string().regex(UUID).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

const notFound = () => new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다', detail: '없는 위젯 키입니다' });
const badRange = () => new ProblemError({ type: 'invalid-query', status: 400, title: '목록 조건이 올바르지 않습니다', detail: 'from·to 범위가 올바르지 않습니다' });

@Controller('v1/ops/widgets')
export class OpsWidgetsController {
  constructor(private readonly widgets: WidgetFeed) {}

  @Get(':widgetKey')
  @Roles(['viewer', 'operator', 'commander', 'cs_agent', 'cs_lead'])
  @Header('cache-control', 'no-store')
  @ContractRouteSchema({ params: OpsWidgetParams, query: OpsWidgetQuery, responses: { 200: WidgetValue } })
  async get(@Param('widgetKey') widgetKey: string, @Query() raw: Record<string, unknown>): Promise<z.output<typeof WidgetValue>> {
    if (!isWidgetKey(widgetKey)) throw notFound();
    const q = OpsWidgetQuery.safeParse(raw ?? {});
    if (!q.success) throw badRange();
    const toMs = q.data.to ? Date.parse(q.data.to) : undefined;
    const fromMs = q.data.from ? Date.parse(q.data.from) : toMs !== undefined ? toMs - WIDGET_RANGE_MS : undefined;
    if (fromMs !== undefined && toMs !== undefined && (fromMs >= toMs || toMs - fromMs > WIDGET_MAX_RANGE_MS)) throw badRange();
    return this.widgets.read(widgetKey, {
      eventId: q.data.eventId?.toLowerCase() ?? null,
      ...(fromMs !== undefined ? { fromMs } : {}),
      ...(toMs !== undefined ? { toMs } : {}),
    });
  }
}
