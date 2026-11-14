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
}
