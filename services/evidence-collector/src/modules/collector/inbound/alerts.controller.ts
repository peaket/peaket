// 받는 층: Alertmanager 웹훅(기본 형식 판 4) POST /internal/v1/alerts(docs/observability.md §5 '진단 증거' 받는 길, 시험 D-T51 ②③④).
// 토큰 가드를 지난 요청만 본문을 읽는다. 본문 모양이 틀리면 400 Problem, 맞으면 곧바로 202 {"accepted": <받은 경보 수>}로 답하고 수집은 답한 뒤에 한다.
// 경보 설명 글(annotations)은 읽지 않는다(manifest·로그에 싣지 않는다).
import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { ContractRouteSchema, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import { CollectEvidence } from '../application/collect-evidence.js';
import { WebhookTokenGuard } from './webhook-token.guard.js';

/** 한 웹훅의 경보 수 상한 [가정]. Alertmanager는 묶음을 잘라 보내고(truncatedAlerts) 이 값을 넘지 않게 max_alerts를 둔다 */
const MAX_ALERTS = 1000;

const Alert = z.object({
  status: z.enum(['firing', 'resolved']),
  labels: z.record(z.string(), z.string()),
  fingerprint: z.string().max(128).optional(),
});
const Webhook = z.object({ version: z.string().optional(), status: z.string().optional(), alerts: z.array(Alert).max(MAX_ALERTS) });
const Accepted = z.object({ accepted: z.number().int() }).strict();

@Controller('internal/v1/alerts')
@Roles(['public'])
@UseGuards(WebhookTokenGuard)
export class AlertsController {
  constructor(@Inject(CollectEvidence) private readonly collect: CollectEvidence) {}

  @Post()
  @HttpCode(202)
  @ContractRouteSchema({ responses: { 202: Accepted } })
  receive(@Body() body: unknown): { accepted: number } {
    const parsed = Webhook.safeParse(body);
    if (!parsed.success) throw new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다', detail: 'Alertmanager 웹훅(판 4) 모양이 아닙니다' });
    return { accepted: this.collect.receive(parsed.data.alerts) };
  }
}
