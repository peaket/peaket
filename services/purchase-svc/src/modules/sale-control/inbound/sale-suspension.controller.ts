// purchase-svc 내부 HTTP: ops-svc의 판매 중지(SALE_STOP)·재개(SALE_RESUME) 명령이 회차 판매 정지 사본을 쓴다(BAT-465 R-584).
// 클러스터 안에서만 열고 인증은 서비스 메시/네트워크 정책 몫이다(공개 경로 아님).
import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { CLOCK, type Clock, ContractRouteSchema, InternalTokenGuard, Roles } from '@peaket/platform';
import { z } from 'zod';
import { SetSaleSuspension } from '../application/set-sale-suspension.js';
import { SALE_SUSPENSION_ACTIONS } from '../domain/sale-control.js';

const EventIdParams = z.object({ eventId: z.uuid() }).strict();
const SuspensionBody = z
  .object({
    action: z.enum(SALE_SUSPENSION_ACTIONS),
    commandId: z.uuid(),
    reason: z.string().min(1).max(500),
    suspensionRef: z.string().min(1).max(200).optional(),
  })
  .strict();
const StateView = z.object({ eventId: z.uuid(), suspended: z.boolean(), revision: z.number().int(), changed: z.boolean() });

@Controller('internal/v1/event-sales')
@Roles(['public'])
@UseGuards(InternalTokenGuard)
export class SaleSuspensionController {
  constructor(
    private readonly setSuspension: SetSaleSuspension,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post(':eventId/suspensions')
  @HttpCode(200)
  @ContractRouteSchema({ params: EventIdParams, body: SuspensionBody, responses: { 200: StateView } })
  async write(@Param() params: unknown, @Body() body: unknown): Promise<z.output<typeof StateView>> {
    const p = EventIdParams.safeParse(params);
    if (!p.success) throw new BadRequestException('회차 ID가 올바르지 않습니다');
    const b = SuspensionBody.safeParse(body);
    if (!b.success) throw new BadRequestException('판매 중지 본문이 올바르지 않습니다');
    return this.setSuspension.run({
      eventId: p.data.eventId,
      action: b.data.action,
      commandId: b.data.commandId,
      reason: b.data.reason,
      ...(b.data.suspensionRef !== undefined ? { suspensionRef: b.data.suspensionRef } : {}),
      nowMs: this.clock.now(),
    });
  }

  @Get(':eventId/suspensions')
  @ContractRouteSchema({ params: EventIdParams, responses: { 200: StateView.omit({ changed: true }) } })
  async read(@Param() params: unknown): Promise<{ eventId: string; suspended: boolean; revision: number }> {
    const p = EventIdParams.safeParse(params);
    if (!p.success) throw new BadRequestException('회차 ID가 올바르지 않습니다');
    return this.setSuspension.state(p.data.eventId);
  }
}
