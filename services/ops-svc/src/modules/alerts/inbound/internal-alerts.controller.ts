// 운영 경보 내부 HTTP(BAT-425 GAT-130). purchase-svc가 회차 취소 환불 자동 정지·신청 창 닫힘을 보낸다.
// 공개 경로가 아니고, Alertmanager 웹훅·콘솔 SSE 연결 전의 첫 저장 경로다.
import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { CLOCK, type Clock, ContractRouteSchema, InternalTokenGuard, Roles } from '@peaket/platform';
import { z } from 'zod';
import { RecordOpsAlert } from '../application/record-alert.js';
import { OPS_ALERT_SEVERITIES } from '../domain/ops-alert.js';

const AlertResponse = z.object({ accepted: z.boolean(), alertId: z.uuid().optional() });
const AlertBody = z
  .object({
    eventKey: z.string().min(1),
    kind: z.string().min(1),
    severity: z.enum(OPS_ALERT_SEVERITIES),
    source: z.string().min(1),
    reason: z.string().min(1),
    detail: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.iso.datetime(),
  })
  .strict();
const ResolutionBody = z
  .object({
    eventKey: z.string().min(1),
    kind: z.string().min(1),
    reason: z.string().min(1),
    resolvedAt: z.iso.datetime(),
  })
  .strict();
const ResolutionResponse = z.object({ accepted: z.boolean(), resolved: z.boolean() });

@Controller('internal/v1/ops-alerts')
@UseGuards(InternalTokenGuard)
export class InternalAlertsController {
  constructor(
    private readonly record: RecordOpsAlert,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post()
  @HttpCode(202)
  @Roles(['public'])
  @ContractRouteSchema({ responses: { 202: AlertResponse } })
  async create(@Body() body: unknown): Promise<z.output<typeof AlertResponse>> {
    const parsed = AlertBody.safeParse(body);
    if (!parsed.success) return { accepted: false };
    const alert = await this.record.handle({ ...parsed.data, createdAt: parsed.data.createdAt ?? new Date(this.clock.now()).toISOString() });
    return { accepted: true, alertId: alert.alertId };
  }

  /** O-T20 신선도 경보가 회복되면 푼다. 다른 경보도 같은 경로로 풀 수 있다 */
  @Post('resolutions')
  @HttpCode(202)
  @Roles(['public'])
  @ContractRouteSchema({ responses: { 202: ResolutionResponse } })
  async resolve(@Body() body: unknown): Promise<z.output<typeof ResolutionResponse>> {
    const parsed = ResolutionBody.safeParse(body);
    if (!parsed.success) return { accepted: false, resolved: false };
    const alert = await this.record.resolve(parsed.data);
    return { accepted: true, resolved: alert?.resolvedAtMs !== undefined };
  }
}
