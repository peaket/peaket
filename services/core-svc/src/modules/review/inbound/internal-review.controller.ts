// 내부 HTTP: 탈퇴 계정 후기 파기를 손으로 다시 하는 길(소유자 결정 2026-11-16 OPEN[42], ADR-0278, docs/features/identity.md §8 '후기 파기').
// 탈퇴 사건(identity.accounts-withdrawn)을 잃었거나 보류됐을 때 운영자가 부른다. 파기 칸은 docs/data.md §2 '후기 파기'이고 다시 정리 예약은 만들지 않는다.
// 옛 경로 /anonymize(계정·주문 참조만 끊음)는 없앴다(부르는 곳이 없다, 추천 적용 2026-11-16).
import { Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ContractRouteSchema, InternalTokenGuard, Roles } from '@peaket/platform';
import { z } from 'zod';
import { Reviews } from '../application/reviews.js';

const AccountParams = z.object({ accountId: z.uuid() }).strict();
const View = z.object({ purged: z.number().int().nonnegative() });

@Controller('internal/v1/reviews')
@UseGuards(InternalTokenGuard)
export class InternalReviewController {
  constructor(private readonly reviews: Reviews) {}

  @Post('accounts/:accountId/purge')
  @HttpCode(200)
  @Roles(['public'])
  @ContractRouteSchema({ params: AccountParams, responses: { 200: View } })
  async purge(@Param('accountId') accountId: string): Promise<z.output<typeof View>> {
    return this.reviews.purgeAccount(accountId);
  }
}
