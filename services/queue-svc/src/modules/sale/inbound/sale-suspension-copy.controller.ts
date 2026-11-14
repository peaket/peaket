// queue-svc 내부 HTTP: ops-svc의 판매 중지(SALE_STOP)·재개(SALE_RESUME) 명령이 대기열 판매 정지 사본을 쓴다(BAT-465 R-584).
// purchase-svc의 같은 경로를 먼저 부른 뒤 이 경로를 부른다(판매를 먼저 막고 대기 상태를 바꾼다, ADR-0123 결정 3).
// 클러스터 안에서만 열고 인증은 서비스 메시/네트워크 정책 몫이다(공개 경로 아님).
import { BadRequestException, Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ContractRouteSchema, InternalTokenGuard, Roles } from '@peaket/platform';
import { z } from 'zod';
import { SetSaleSuspensionCopy } from '../application/set-sale-suspension-copy.js';
import { SALE_SUSPENSION_ACTIONS } from '../domain/sale-suspension.js';

const EventIdParams = z.object({ eventId: z.uuid() }).strict();
const SuspensionBody = z
  .object({
    action: z.enum(SALE_SUSPENSION_ACTIONS),
    commandId: z.uuid(),
    reason: z.string().min(1).max(500).optional(),
    revision: z.number().int().min(0).optional(),
  })
  .strict();
const View = z.object({ eventId: z.uuid(), suspended: z.boolean(), revision: z.number().int() });

@Controller('internal/v1/event-sales')
@Roles(['public'])
@UseGuards(InternalTokenGuard)
export class SaleSuspensionCopyController {
  constructor(private readonly setSuspension: SetSaleSuspensionCopy) {}

  @Post(':eventId/suspensions')
  @HttpCode(200)
  @ContractRouteSchema({ params: EventIdParams, body: SuspensionBody, responses: { 200: View } })
  async write(@Param() params: unknown, @Body() body: unknown): Promise<z.output<typeof View>> {
    const p = EventIdParams.safeParse(params);
    if (!p.success) throw new BadRequestException('회차 ID가 올바르지 않습니다');
    const b = SuspensionBody.safeParse(body);
    if (!b.success) throw new BadRequestException('판매 중지 본문이 올바르지 않습니다');
    return this.setSuspension.run({
      eventId: p.data.eventId,
      action: b.data.action,
      commandId: b.data.commandId,
      ...(b.data.revision !== undefined ? { revision: b.data.revision } : {}),
    });
  }
}
