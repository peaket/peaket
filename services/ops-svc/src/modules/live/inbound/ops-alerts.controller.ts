// 경보 목록 GET /v1/ops/alerts?eventId=(openapi listOpsAlerts, F-03-3 OPS-380, ADR-0100 결정 2, ADR-0371 결정 9).
// 콘솔은 늘 여는 흐름을 처음 열 때와 reset을 받을 때 이 목록으로 경보 슬라이스를 갈아 끼우고, 응답 seq 뒤 순번의 alert 사건만 목록 위에 다시 얹는다.
// 걸린 경보 전부와 풀린 지 60분 [가정] 안의 경보, 500건 [가정]까지(넘으면 풀린 것 가운데 오래된 것부터 뺀다, docs/frontend.md §3.10).
// 경보는 alerts 컨텍스트의 공개 읽기(OpsAlertList.list)로 읽고 본문은 흐름 alert 사건과 같은 규칙(alertBodyOf)으로 만든다. 받는 역할도 흐름과 같다(CS 403).
import { Controller, Get, Header, Inject, Query } from '@nestjs/common';
import { ListOpsAlertsResponse } from '@peaket/contracts/openapi/ops';
import { CLOCK, type Clock, ContractRouteSchema, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import type { OpsAlertList } from '../../alerts/index.js';
import { alertBodyOf } from '../domain/alert-body.js';
import type { PushEventSource } from '../domain/ports.js';
import { LIVE_ALERT_STORE, PUSH_EVENT_SOURCE } from '../tokens.js';

/** 풀린 경보를 두는 시간 60분 [가정](frontend §3.10) */
export const ALERT_LIST_RESOLVED_KEEP_MS = 60 * 60_000;
/** 목록 상한 500건 [가정](frontend §3.10 '들고 있는 양의 상한') */
export const ALERT_LIST_MAX = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const OpsAlertsQuery = z.object({ eventId: z.string().max(64).optional() });

@Controller('v1/ops/alerts')
export class OpsAlertsController {
  constructor(
    @Inject(LIVE_ALERT_STORE) private readonly alerts: OpsAlertList,
    @Inject(PUSH_EVENT_SOURCE) private readonly source: PushEventSource,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  @Roles(['viewer', 'operator', 'commander'])
  @Header('cache-control', 'no-store')
  @ContractRouteSchema({ query: OpsAlertsQuery, responses: { 200: ListOpsAlertsResponse } })
  async list(@Query() raw: Record<string, unknown>) {
    const q = OpsAlertsQuery.safeParse(raw ?? {});
    if (!q.success || (q.data.eventId !== undefined && !UUID.test(q.data.eventId))) {
      throw new ProblemError({ type: 'invalid-query', status: 400, title: '목록 조건이 올바르지 않습니다', detail: 'eventId는 UUID여야 합니다' });
    }
    // 순번을 먼저 잡고 목록을 읽는다: 그 순번까지 커밋된 경보 변경은 목록에 들어 있다
    const seq = await (this.source.committedMax ? this.source.committedMax() : this.source.latest());
    const items = await this.alerts.list({
      ...(q.data.eventId ? { eventKey: q.data.eventId.toLowerCase() } : {}),
      resolvedSinceMs: this.clock.now() - ALERT_LIST_RESOLVED_KEEP_MS,
      limit: ALERT_LIST_MAX,
    });
    return { items: items.map(alertBodyOf), seq };
  }
}
