// 받는 층: Alertmanager 웹훅(판 4) POST /v1/alerts(docs/observability.md §5 '경보 보내는 길' 티켓 중계, V-T53 ④⑤⑥).
// 토큰 가드를 지난 요청만 본문을 읽는다. 본문 모양이 틀리면 400 Problem, GitHub 호출이 끝난 뒤 202 {"accepted": <받은 수>}로 답한다
// (502를 답해야 Alertmanager가 다시 보낸다). GitHub 실패는 502 Problem이다.
import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { ContractRouteSchema, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import { RelayAlerts } from '../application/relay-alerts.js';
import { GitHubUnavailable } from '../domain/github-issues.js';
import { WebhookTokenGuard } from './webhook-token.guard.js';

/** 한 웹훅의 경보 수 상한 [가정]. Alertmanager는 묶음을 잘라 보낸다 */
const MAX_ALERTS = 1000;

const Alert = z.object({
  status: z.enum(['firing', 'resolved']),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()).optional(),
  startsAt: z.string().min(1),
  endsAt: z.string().min(1),
  fingerprint: z.string().min(1).max(128),
});
const Webhook = z.object({ version: z.literal('4'), alerts: z.array(Alert).min(1).max(MAX_ALERTS) });
const Accepted = z.object({ accepted: z.number().int() }).strict();

@Controller('v1/alerts')
@Roles(['public'])
@UseGuards(WebhookTokenGuard)
export class AlertsController {
  constructor(@Inject(RelayAlerts) private readonly relay: RelayAlerts) {}

  @Post()
  @HttpCode(202)
  @ContractRouteSchema({ responses: { 202: Accepted } })
  async receive(@Body() body: unknown): Promise<{ accepted: number }> {
    const parsed = Webhook.safeParse(body);
    if (!parsed.success) throw new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다', detail: 'Alertmanager 웹훅(판 4) 모양이 아닙니다' });
    try {
      return { accepted: await this.relay.receive(parsed.data.alerts) };
    } catch (e) {
      if (e instanceof GitHubUnavailable) throw new ProblemError({ type: 'alert-issue-relay-unavailable', status: 502, title: '경보 티켓을 만들지 못했습니다', detail: 'GitHub 호출이 실패했습니다(Alertmanager가 다시 보냅니다)' });
      throw e;
    }
  }
}
