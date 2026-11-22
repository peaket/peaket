// 입장 키 알림의 내부 입구(POST /internal/v1/notify/ticket-events, docs/features/notify.md §4.7, ADR-0363 결정 4, BUILD_ORDER GAT-020).
// ticket-svc device_key_notice 보내기 반복이 보낸다. Kafka trade.tickets 소비자가 생기면(GAT-250 남은 것) 같은 유스케이스를 그쪽에서 부른다.
// 내부 토큰이 있으면 요구한다. 정의 밖 칸·모양 오류는 422다(보내는 쪽은 422를 보낸 것으로 적고 다시 보내지 않는다).
// 같은 noticeId가 다시 와도 작업은 하나이고 202다(중복 키 {type}:{ticketId}:{noticeId}:{accountId}:{채널}).
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ContractRouteSchema, InternalTokenGuard, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import { NotificationIntake } from '../application/notification-intake.js';
import { FanNotifyProblem } from '../domain/fan-notify.js';

/** 본문(notify §4.7). ticket-svc 연결 시험의 core 대역이 같은 스키마로 받은 본문을 검사한다 */
export const TicketKeyNoticeBody = z
  .object({
    noticeId: z.uuid(),
    type: z.enum(['DEVICE_KEY_REISSUED', 'DEVICE_KEY_LATE_ISSUE']),
    accountId: z.uuid(),
    ticketId: z.uuid(),
    registeredAtMs: z.number().int().nonnegative(),
  })
  .strict();
export const TicketKeyNoticeResponse = z.object({ created: z.number().int(), duplicate: z.number().int() });

@Controller('internal/v1/notify')
@Roles(['public'])
@UseGuards(InternalTokenGuard)
export class InternalNotifyTicketController {
  constructor(private readonly intake: NotificationIntake) {}

  @Post('ticket-events')
  @HttpCode(202)
  @ContractRouteSchema({ responses: { 202: TicketKeyNoticeResponse } })
  async receive(@Body() body: unknown): Promise<z.output<typeof TicketKeyNoticeResponse>> {
    const parsed = TicketKeyNoticeBody.safeParse(body);
    if (!parsed.success) throw new ProblemError({ type: 'invalid-notify-event', status: 422, title: '알림 사건이 올바르지 않습니다', detail: '입장 키 알림 모양이 올바르지 않습니다' });
    try {
      return await this.intake.ticketKeyNotice(parsed.data);
    } catch (e) {
      if (e instanceof FanNotifyProblem) throw new ProblemError({ type: 'invalid-notify-event', status: 422, title: '알림 사건이 올바르지 않습니다', detail: e.message });
      throw e;
    }
  }
}
