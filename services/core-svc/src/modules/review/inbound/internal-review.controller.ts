// 내부 HTTP: 보류된 탈퇴 사건을 손으로 처리하는 길(소유자 결정 2026-11-16 OPEN[42], ADR-0278, docs/features/identity.md §8 '손으로 처리', 웨이브 끝 보안 리뷰 S1).
// 탈퇴 사건(identity.accounts-withdrawn)이 core held_event에 보류됐을 때 운영자가 부른다. 그 계정의 처리 안 한 탈퇴 보류 사건이 있을 때만 파기하고(없으면 409 withdrawal-not-held),
// 같은 트랜잭션에서 다시 정리 예약(지금 + 16분)을 쓰고 보류 행을 다시 처리로 표시한다. 요청자·사유는 필수이고 운영 줄 review-purge-manual에 남는다(계정 ID 없음).
// 한 번에 보류 행 ID 차례로 50개까지 처리하고, 응답은 처리한 보류 행 수와 ID다(eventKey가 없는 행 포함, W8-audit2a 다시 보기 N1). 남은 행이 있으면 409가 날 때까지 다시 부른다.
// 옛 경로 /anonymize(계정·주문 참조만 끊음)는 없앴다.
import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ContractRouteSchema, InternalTokenGuard, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import { Reviews } from '../application/reviews.js';
import { MANUAL_PURGE_HELD_LIMIT, ReviewProblem } from '../domain/review.js';

const AccountParams = z.object({ accountId: z.uuid() }).strict();
/** 누가·왜(사유 10~500자, 요청자 1~64자). 모르는 칸은 받지 않는다 */
const PurgeBody = z.object({ reason: z.string().min(10).max(500), requestedBy: z.string().min(1).max(64) }).strict();
/** 파기 수, 처리한 보류 행 수(1~50), 그 행들의 ID(보류 행 ID 차례, 길이 = heldEvents) */
const View = z.object({
  purged: z.number().int().nonnegative(),
  heldEvents: z.number().int().min(1).max(MANUAL_PURGE_HELD_LIMIT),
  heldEventIds: z.array(z.uuid()).min(1).max(MANUAL_PURGE_HELD_LIMIT),
});

@Controller('internal/v1/reviews')
@UseGuards(InternalTokenGuard)
export class InternalReviewController {
  constructor(private readonly reviews: Reviews) {}

  @Post('accounts/:accountId/purge')
  @HttpCode(200)
  @Roles(['public'])
  @ContractRouteSchema({ params: AccountParams, body: PurgeBody, responses: { 200: View } })
  async purge(@Param('accountId') accountId: string, @Body() body: z.output<typeof PurgeBody>): Promise<z.output<typeof View>> {
    try {
      return await this.reviews.purgeHeldWithdrawal(accountId, body);
    } catch (e) {
      if (e instanceof ReviewProblem) throw new ProblemError({ type: e.type, status: e.status, title: e.title, extensions: e.extensions });
      throw e;
    }
  }
}
