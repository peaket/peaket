// 법정 통보 내부 경로(F-07-11, LCH-160, POL-024·POL-044, ADR-0066, C-T22).
// ops-svc가 접수·차단·철회를 이 경로로 core에 넘긴다. 내부 토큰이 없거나 틀리면 401이다(공용 가드의 403이 아니라 이 경로의 계약).
import { Body, Controller, Get, Header, HttpCode, Inject, Injectable, Optional, Param, Post, UnauthorizedException, UseGuards, type ExecutionContext } from '@nestjs/common';
import { ContractRouteSchema, INTERNAL_TOKEN, INTERNAL_TOKEN_REQUIRED, InternalTokenGuard, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import { Reviews } from '../application/reviews.js';
import { ReviewProblem } from '../domain/review.js';

/** 내부 토큰 거절을 401로 바꾸는 가드(core catalog 내부 경로와 같은 꼴, docs/api guidelines §8.1) */
@Injectable()
class InternalToken401Guard extends InternalTokenGuard {
  constructor(
    @Inject(INTERNAL_TOKEN) expected?: string,
    @Optional() @Inject(INTERNAL_TOKEN_REQUIRED) required = false,
  ) {
    super(expected, required);
  }

  override canActivate(context: ExecutionContext): boolean {
    if (!super.canActivate(context)) throw new UnauthorizedException('내부 토큰이 올바르지 않습니다');
    return true;
  }
}

const NoticeTakedownBody = z
  .object({
    noticeId: z.uuid(),
    reviewIds: z
      .array(z.uuid())
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, '중복된 후기 ID가 있습니다'),
    receivedAt: z.iso.datetime({ offset: true }),
    deadline: z.enum(['H24', 'H10']),
    reason: z.string().max(8000),
  })
  .strict();
const NoticeTakedownView = z.object({
  noticeId: z.uuid(),
  applied: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  deadlineAt: z.iso.datetime({ offset: true }),
});
const NoticeWithdrawBody = z.object({ reason: z.string().max(8000) }).strict();
const NoticeWithdrawView = z.object({
  noticeId: z.uuid(),
  restored: z.number().int().nonnegative(),
  sameContentRestored: z.number().int().nonnegative(),
  fingerprintsCleared: z.number().int().nonnegative(),
});
const NoticeReportView = z.object({
  noticeId: z.uuid(),
  reviews: z.array(
    z.object({
      reviewId: z.uuid(),
      reason: z.enum(['NOTICE', 'SAME_CONTENT']),
      fingerprint: z.string(),
      hiddenAt: z.iso.datetime({ offset: true }),
      restoredAt: z.iso.datetime({ offset: true }).nullable(),
    }),
  ),
  counts: z.object({ notice: z.number().int().nonnegative(), sameContent: z.number().int().nonnegative(), restored: z.number().int().nonnegative(), activeSameContent: z.number().int().nonnegative() }),
});
const NoticeParams = z.object({ noticeId: z.string() }).strict();

function problemOf(e: ReviewProblem): ProblemError {
  return new ProblemError({ type: e.type, status: e.status, title: e.title, extensions: e.extensions });
}

@Controller('internal/v1/reviews')
@UseGuards(InternalToken401Guard)
export class InternalNoticeController {
  constructor(private readonly reviews: Reviews) {}

  @Post('notice-takedowns')
  @HttpCode(200)
  @Roles(['public'])
  @ContractRouteSchema({ body: NoticeTakedownBody, responses: { 200: NoticeTakedownView } })
  async applyNotice(@Body() body: z.output<typeof NoticeTakedownBody>): Promise<z.output<typeof NoticeTakedownView>> {
    try {
      return await this.reviews.applyNoticeTakedown({
        noticeId: body.noticeId,
        reviewIds: body.reviewIds,
        receivedAtMs: Date.parse(body.receivedAt),
        kind: body.deadline === 'H10' ? 'MINISTRY' : 'GENERAL',
        reason: body.reason,
      });
    } catch (e) {
      if (e instanceof ReviewProblem) throw problemOf(e);
      throw e;
    }
  }

  @Post('notice-takedowns/:noticeId/withdrawal')
  @HttpCode(200)
  @Roles(['public'])
  @ContractRouteSchema({ params: NoticeParams, body: NoticeWithdrawBody, responses: { 200: NoticeWithdrawView } })
  async withdrawNotice(@Param('noticeId') noticeId: string, @Body() body: z.output<typeof NoticeWithdrawBody>): Promise<z.output<typeof NoticeWithdrawView>> {
    try {
      return await this.reviews.withdrawNotice(noticeId, body.reason);
    } catch (e) {
      if (e instanceof ReviewProblem) throw problemOf(e);
      throw e;
    }
  }

  @Get('notice-takedowns/:noticeId')
  @Header('Cache-Control', 'no-store')
  @Roles(['public'])
  @ContractRouteSchema({ params: NoticeParams, responses: { 200: NoticeReportView } })
  async noticeReport(@Param('noticeId') noticeId: string): Promise<z.output<typeof NoticeReportView>> {
    try {
      return (await this.reviews.noticeReport(noticeId)) as z.output<typeof NoticeReportView>;
    } catch (e) {
      if (e instanceof ReviewProblem) throw problemOf(e);
      throw e;
    }
  }
}
