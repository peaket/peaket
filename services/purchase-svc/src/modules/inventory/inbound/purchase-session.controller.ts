// 받는 층: 구매 세션 나가기(openapi DELETE /v1/events/{eventId}/purchase-session, docs/features/seat-hold.md §2 '구매 세션 종료와 정리', BUILD_ORDER PRF-138).
// 팬 경로(역할 fan, ticket:buy)이고 구매 세션 요청 서명이 필수다(@PurchaseSigned). 구매 세션을 LEFT로 끝내고 204로 답한다.
// 거절: 구매 세션의 회차가 주소의 회차와 다르면 403, 좌석 Redis 일시 장애·메모리 부족은 503 seat-store-unavailable. 오류도 Cache-Control: no-store.
import { Controller, Delete, ForbiddenException, HttpCode, Param, Res } from '@nestjs/common';
import { ContractRouteSchema, CurrentPurchaseSession, PurchaseSigned, Roles } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { EndPurchaseSession, EndSessionError } from '../application/end-purchase-session.js';
import { KEY_PART, SeatStoreUnavailable } from '../domain/hold.js';
import { storeUnavailableError, throwHoldProblem } from '../application/hold-error.js';
import { sanitizedStoreError } from './holds.controller.js';

export const LeaveParams = z.object({ eventId: z.string().regex(KEY_PART) }).strict();

@Controller('v1/events/:eventId')
export class PurchaseSessionController {
  constructor(private readonly ending: EndPurchaseSession) {}

  @Delete('purchase-session')
  @HttpCode(204)
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  @PurchaseSigned()
  @ContractRouteSchema({ params: LeaveParams })
  async leave(@Param('eventId') eventId: string, @CurrentPurchaseSession() purchaseSessionId: string, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    void reply.header('cache-control', 'no-store');
    try {
      // 세션이 요청 확인과 이 호출 사이에 사라졌으면 이미 끝난 것이다(204). 회차가 다르면 거절한다(세션은 그대로)
      await this.ending.execute({ sessionId: purchaseSessionId, reason: 'LEFT', expectEventId: eventId });
    } catch (e) {
      if (e instanceof EndSessionError) throw new ForbiddenException();
      if (e instanceof SeatStoreUnavailable) {
        try {
          throwHoldProblem(storeUnavailableError(e), reply);
        } catch (problem) {
          throw problem;
        }
      }
      throw sanitizedStoreError(e);
    }
  }
}
