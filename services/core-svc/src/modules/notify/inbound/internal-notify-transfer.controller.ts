// 양도 알림의 내부 입구(POST /internal/v1/notify/transfer-events, docs/features/notify.md §4.8, F-05-11 R-T25·I-T54 ⑤).
// ticket-svc transfer_notice 보내기 반복이 보낸다. 내부 토큰이 설정된 조립은 없거나 틀린 토큰을 401로 받지 않는다
// (이 입구의 계약은 401이고, 정의 밖 칸·모양 오류·모르는 종류·당사자·사유는 422 invalid-notify-event다).
// 같은 noticeId가 다시 와도 작업은 하나이고 202다.
import { Body, Controller, Headers, HttpCode, Inject, Optional, Post } from '@nestjs/common';
import { constantTimeEqual, ContractRouteSchema, INTERNAL_TOKEN, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import { NotificationIntake } from '../application/notification-intake.js';
import { FanNotifyProblem } from '../domain/fan-notify.js';

export const TransferNoticeBody = z
  .object({
    noticeId: z.uuid(),
    type: z.enum(['TRANSFER_OFFERED', 'TRANSFER_ACCEPTED', 'TRANSFER_REJECTED', 'TRANSFER_WITHDRAWN', 'TRANSFER_EXPIRED', 'TICKET_RETURNED', 'TRANSFER_WEAK_REAUTH']),
    party: z.enum(['SENDER', 'RECIPIENT', 'PAYER', 'RETURNER']),
    offerId: z.uuid(),
    ticketId: z.uuid(),
    eventId: z.uuid(),
    accountId: z.uuid(),
    occurredAtMs: z.number().int().nonnegative(),
    reason: z.enum(['SENDER', 'EVENT_CANCELLED', 'EVENT_POSTPONED', 'OTHER']).optional(),
  })
  .strict();
export const TransferNoticeResponse = z.object({ created: z.number().int(), duplicate: z.number().int() });

@Controller('internal/v1/notify')
@Roles(['public'])
export class InternalNotifyTransferController {
  constructor(
    private readonly intake: NotificationIntake,
    @Optional() @Inject(INTERNAL_TOKEN) private readonly expected?: string,
  ) {}

  @Post('transfer-events')
  @HttpCode(202)
  @ContractRouteSchema({ responses: { 202: TransferNoticeResponse } })
  async receive(@Body() body: unknown, @Headers('x-peaket-internal-token') token: string | undefined): Promise<z.output<typeof TransferNoticeResponse>> {
    if (this.expected !== undefined && (typeof token !== 'string' || !constantTimeEqual(token, this.expected))) {
      throw new ProblemError({ type: 'unauthenticated', status: 401, title: '내부 토큰이 필요합니다' });
    }
    const parsed = TransferNoticeBody.safeParse(body);
    if (!parsed.success) throw new ProblemError({ type: 'invalid-notify-event', status: 422, title: '알림 사건이 올바르지 않습니다', detail: '양도 알림 모양이 올바르지 않습니다' });
    try {
      return await this.intake.transferEvent(parsed.data);
    } catch (e) {
      if (e instanceof FanNotifyProblem) throw new ProblemError({ type: 'invalid-notify-event', status: 422, title: '알림 사건이 올바르지 않습니다', detail: e.message });
      throw e;
    }
  }
}
