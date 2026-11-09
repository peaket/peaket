// 받는 층: 홀드 다시 읽기·해제·연장(openapi /v1/holds/{holdId}, docs/features/seat-hold.md §5, BUILD_ORDER HOT-070, ADR-0254).
// 팬 경로라 계정은 플랫폼 인증 가드의 신원으로만 정한다. 응답은 캐시하지 않는다(오류도).
import { Controller, Delete, Get, Headers, HttpCode, Param, Post, Res } from '@nestjs/common';
import { ContractRouteSchema, CurrentPrincipal, CurrentPurchaseSession, type Principal, PurchaseSigned, Roles, requestContext, requestLog } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { HoldError, throwHoldProblem } from '../application/hold-error.js';
import { type HoldBody, ManageHolds } from '../application/manage-holds.js';
import { HoldResponseBody, sanitizedStoreError } from './holds.controller.js';

// 형식이 틀린 holdId도 없는 것과 같은 404다(BOLA 방지, 400으로 나누지 않는다, L14). 키에 넣기 전의 모양 확인은 쓰임새가 한다
export const HoldIdParams = z.object({ holdId: z.string() }).strict();
export const HoldSignedHeaders = z.object({ 'X-Purchase-Seq': z.int().min(1), 'X-Purchase-Mac': z.string() });

@Controller('v1/holds/:holdId')
export class HoldLifecycleController {
  constructor(private readonly holds: ManageHolds) {}

  async #run<T>(reply: FastifyReply, f: () => Promise<T>): Promise<T> {
    requestLog().set({ queuePhase: 'purchase' });
    void reply.header('cache-control', 'no-store');
    try {
      return await f();
    } catch (e) {
      if (e instanceof HoldError) throwHoldProblem(e, reply);
      throw sanitizedStoreError(e);
    }
  }

  /** 다시 읽기(서명 없음). 입장 토큰 머리를 쓰고 일련번호·무활동 시간을 바꾸지 않는다 */
  @Get()
  @Roles(['fan'])
  @ContractRouteSchema({ params: HoldIdParams, responses: { 200: HoldResponseBody } })
  read(@Param('holdId') holdId: string, @Headers('x-admission-token') token: unknown, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply): Promise<HoldBody> {
    const deadline = requestContext()?.deadline;
    return this.#run(reply, () => this.holds.read({ token, accountId: me.accountId, holdId, ...(deadline ? { deadline } : {}) }));
  }

  @Delete()
  @HttpCode(204)
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  @PurchaseSigned()
  @ContractRouteSchema({ params: HoldIdParams, headers: HoldSignedHeaders })
  async release(@Param('holdId') holdId: string, @CurrentPrincipal() me: Principal, @CurrentPurchaseSession() purchaseSessionId: string, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    const deadline = requestContext()?.deadline;
    await this.#run(reply, () => this.holds.release({ accountId: me.accountId, purchaseSessionId, holdId, ...(deadline ? { deadline } : {}) }));
  }

  @Post('extension')
  @HttpCode(200)
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  @PurchaseSigned()
  @ContractRouteSchema({ params: HoldIdParams, headers: HoldSignedHeaders, responses: { 200: HoldResponseBody } })
  extend(@Param('holdId') holdId: string, @CurrentPrincipal() me: Principal, @CurrentPurchaseSession() purchaseSessionId: string, @Res({ passthrough: true }) reply: FastifyReply): Promise<HoldBody> {
    const deadline = requestContext()?.deadline;
    return this.#run(reply, () => this.holds.extend({ accountId: me.accountId, purchaseSessionId, holdId, ...(deadline ? { deadline } : {}) }));
  }
}
