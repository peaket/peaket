// 내부 HTTP: purchase-svc trade.orders Outbox의 팬 알림 사건을 `core-notify-sender` 첫 몫으로 보낸다.
// Kafka 소비자·발송 원장 표는 마이그레이션 허용 밖이라 이 경로가 첫 연결이다(BAT-425 GAT-130 잔여).
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ContractRouteSchema, InternalTokenGuard, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import { NotificationSender, NotificationSenderProblem, type FanNoticeType } from '../application/notification-sender.js';

const NotifyBody = z
  .object({
    type: z.enum(['EVENT_CANCELLATION_CONFIRMED', 'EVENT_POSTPONED', 'REFUNDED', 'REFUND_FAILED']),
    orderId: z.uuid(),
    eventId: z.uuid(),
    accountId: z.uuid(),
    occurredAtMs: z.number().int().nonnegative(),
    fanNoticeReason: z.string().max(200).optional(),
    refundAmount: z.number().int().nonnegative().optional(),
  })
  .strict();
const View = z.object({ deliveryId: z.string(), type: z.enum(['EVENT_CANCELLATION_CONFIRMED', 'EVENT_POSTPONED', 'REFUNDED', 'REFUND_FAILED']), orderId: z.string(), status: z.enum(['SENT', 'PENDING', 'FAILED', 'UNAVAILABLE']), message: z.string() });

@Controller('internal/v1/notify/trade-events')
@UseGuards(InternalTokenGuard)
export class InternalNotifyController {
  constructor(private readonly sender: NotificationSender) {}

  @Post()
  @HttpCode(202)
  @Roles(['public'])
  @ContractRouteSchema({ body: NotifyBody, responses: { 202: View } })
  async send(@Body() body: z.output<typeof NotifyBody>): Promise<z.output<typeof View>> {
    try {
      const out = await this.sender.send({ ...body, type: body.type as FanNoticeType });
      if (out.status === 'UNAVAILABLE') throw new ProblemError({ type: 'notify-sender-unavailable', status: 503, title: '알림 발송기를 쓸 수 없습니다', retryAfterSeconds: 5 });
      return out;
    } catch (err) {
      if (err instanceof NotificationSenderProblem) throw new ProblemError({ type: err.code === 'INVALID' ? 'invalid-notify-event' : 'notify-sender-unavailable', status: err.code === 'INVALID' ? 422 : 503, title: err.code === 'INVALID' ? '알림 사건이 올바르지 않습니다' : '알림 발송기를 쓸 수 없습니다', ...(err.code === 'UNAVAILABLE' ? { retryAfterSeconds: 5 } : {}) });
      throw err;
    }
  }
}
