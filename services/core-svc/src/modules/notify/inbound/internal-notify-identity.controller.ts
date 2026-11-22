// BAT-455 받는 층: identity 사건(로그인 수단 연결·해제 I-T34, 계정 병합 POL-034)의 내부 입구.
// Kafka 소비자가 붙기 전의 입구이고, 같은 유스케이스를 부른다. 내부 토큰이 있으면 요구한다.
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ContractRouteSchema, InternalTokenGuard, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import { NotificationIntake } from '../application/notification-intake.js';
import { FanNotifyProblem } from '../domain/fan-notify.js';

const LoginMethod = z.object({
  type: z.literal('LOGIN_METHOD_CHANGED'),
  eventKey: z.string().min(1),
  accountId: z.string(),
  change: z.enum(['LINKED', 'UNLINKED']),
  provider: z.string().min(1),
  occurredAtMs: z.number().int().optional(),
}).strict();
const AccountMerged = z.object({
  type: z.literal('ACCOUNT_MERGED'),
  eventKey: z.string().min(1),
  primaryAccountId: z.string(),
  mergedAccountId: z.string(),
  occurredAtMs: z.number().int().optional(),
}).strict();
const BodySchema = z.union([LoginMethod, AccountMerged]);
const Response = z.object({ created: z.number().int(), duplicate: z.number().int(), subscriptionsMoved: z.number().int().optional(), pushMoved: z.number().int().optional() });

@Controller('internal/v1/notify')
@Roles(['public'])
@UseGuards(InternalTokenGuard)
export class InternalNotifyIdentityController {
  constructor(private readonly intake: NotificationIntake) {}

  @Post('identity-events')
  @HttpCode(202)
  @ContractRouteSchema({ responses: { 202: Response } })
  async receive(@Body() body: unknown) {
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) throw new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다', detail: 'identity 사건 모양이 올바르지 않습니다' });
    try {
      if (parsed.data.type === 'LOGIN_METHOD_CHANGED') {
        const r = await this.intake.loginMethodChanged(parsed.data);
        return { created: r.created, duplicate: r.duplicate };
      }
      const r = await this.intake.accountMerged(parsed.data);
      return { created: r.created, duplicate: r.duplicate, subscriptionsMoved: r.subscriptionsMoved, pushMoved: r.pushMoved };
    } catch (e) {
      if (e instanceof FanNotifyProblem) throw new ProblemError({ type: 'invalid-body', status: 400, title: e.message });
      throw e;
    }
  }
}
