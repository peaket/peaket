// 내부 HTTP: 탈퇴·파기 계정의 후기에서 계정·주문 참조를 익명화한다(identity-svc 탈퇴 처리 뒤).
// 법정 보존이 필요한 후기 본문·평점은 남기고, 계정·주문 참조만 후기 ID로 바꾼다.
import { Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ContractRouteSchema, InternalTokenGuard, Roles } from '@peaket/platform';
import { z } from 'zod';
import { Reviews } from '../application/reviews.js';

const AccountParams = z.object({ accountId: z.uuid() }).strict();
const View = z.object({ anonymized: z.number().int().nonnegative() });

@Controller('internal/v1/reviews')
@UseGuards(InternalTokenGuard)
export class InternalReviewController {
  constructor(private readonly reviews: Reviews) {}

  @Post('accounts/:accountId/anonymize')
  @HttpCode(200)
  @Roles(['public'])
  @ContractRouteSchema({ params: AccountParams, responses: { 200: View } })
  async anonymize(@Param('accountId') accountId: string): Promise<z.output<typeof View>> {
    return this.reviews.anonymizeAccount(accountId);
  }
}
