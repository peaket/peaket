// purchase-svc 내부 HTTP: core-svc 판매 승인이 회차 판매를 연다(BAT-616 LCH-080, ADR-0327, guidelines §8.1).
// 클러스터 안에서만 열고 InternalTokenGuard로 서비스 사이 토큰을 본다. 같은 요청을 다시 보내도 행·판·비트맵을 새로 만들지 않는다.
// 400 invalid-body(모양 틀린 회차 ID·본문), 409 sale-not-publishable(좌석맵 판 없음·판매 종료), 503 seat-store-unavailable(좌석 Redis 장애).
import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ContractRouteSchema, InternalTokenGuard, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import { OpenSale, OpenSaleError, SALE_NOT_PUBLISHABLE, SEAT_STORE_UNAVAILABLE } from '../application/open-sale.js';

const SaleOpenParams = z.object({ eventId: z.uuid() }).strict();
const SaleOpenBody = z.object({ openAtMs: z.int().positive(), startsAtMs: z.int().positive() }).strict();
const SaleOpenView = z.object({ opened: z.boolean(), upcomingCreated: z.boolean(), seatEpoch: z.number().int() }).strict();

@Controller('internal/v1/events')
@Roles(['public'])
@UseGuards(InternalTokenGuard)
export class InternalSaleOpenController {
  constructor(private readonly openSale: OpenSale) {}

  @Post(':eventId/sale-open')
  @HttpCode(200)
  @ContractRouteSchema({ params: SaleOpenParams, body: SaleOpenBody, responses: { 200: SaleOpenView } })
  async open(@Param() params: unknown, @Body() body: unknown): Promise<z.output<typeof SaleOpenView>> {
    const p = SaleOpenParams.safeParse(params);
    if (!p.success) throw new ProblemError({ type: 'invalid-body', status: 400, title: '회차 ID가 올바르지 않습니다' });
    const b = SaleOpenBody.safeParse(body);
    if (!b.success) throw new ProblemError({ type: 'invalid-body', status: 400, title: '판매 열기 본문이 올바르지 않습니다' });
    try {
      return await this.openSale.run({ eventId: p.data.eventId.toLowerCase(), openAtMs: b.data.openAtMs, startsAtMs: b.data.startsAtMs });
    } catch (err) {
      if (err instanceof OpenSaleError) {
        if (err.code === SEAT_STORE_UNAVAILABLE) throw new ProblemError({ type: 'seat-store-unavailable', status: 503, title: '좌석 정보를 잠시 쓸 수 없습니다', retryAfterSeconds: 2 });
        if (err.code === SALE_NOT_PUBLISHABLE) throw new ProblemError({ type: 'sale-not-publishable', status: 409, title: '판매를 열 수 없는 회차입니다' });
      }
      throw err;
    }
  }
}
