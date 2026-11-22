// 받는 층: 내 스캐너 세션(휴대폰 쪽, openapi GET /v1/identity/scanner-sessions, DELETE /v1/identity/scanner-sessions/{sessionId}, docs/features/identity.md §6.1
// '휴대폰 화면 실제 연결' ④, BUILD_ORDER F-05-7 = GAT-230, ADR-0362 결정 6). gw-fan이 넘긴 신원(계정·세션)과 재인증 토큰 머리(X-Reauth-Token)를 쓴다. 응답은 캐시하지 않는다.
import { Controller, Delete, Get, Headers, HttpCode, Param, Res, UnauthorizedException } from '@nestjs/common';
import { GetIdentityScannerSessionsResponse } from '@peaket/contracts/openapi/identity';
import { ContractRouteSchema, COOKIE_CHALLENGE, CurrentPrincipal, type Principal, ProblemError, Roles } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AccountError } from '../application/account-error.js';
import { EndScannerSession } from '../application/end-scanner-session.js';
import { ListScannerSessions, type ScannerSessionSelfView } from '../application/list-scanner-sessions.js';

@Controller('v1/identity/scanner-sessions')
export class ScannerSessionsController {
  constructor(
    private readonly list: ListScannerSessions,
    private readonly end: EndScannerSession,
  ) {}

  /** 살아 있는 내 스캐너 세션(많아야 한 줄, I-T89 ①②). 스태프가 아니면 빈 items. 부른 세션이 이미 끝났으면 401 */
  @Get()
  @ContractRouteSchema({ responses: { 200: GetIdentityScannerSessionsResponse } })
  @Roles(['fan'])
  async sessions(@CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply): Promise<{ items: ScannerSessionSelfView[] }> {
    void reply.header('cache-control', 'no-store');
    try {
      return { items: await this.list.run({ accountId: me.accountId, sessionId: me.sessionId }) };
    } catch (e) {
      if (e instanceof AccountError && e.code === 'SESSION_ENDED') {
        void reply.header('www-authenticate', COOKIE_CHALLENGE);
        throw new UnauthorizedException();
      }
      throw e;
    }
  }

  /** 끝내기(I-T89 ③~⑤): 재인증 먼저, 남의·끝난·없는 세션은 같은 404(토큰을 쓰지 않는다) */
  @Delete(':sessionId')
  @Roles(['fan'])
  @HttpCode(204)
  // 경로 인자는 스키마로 거르지 않는다: 모양이 틀린 ID도 재인증을 먼저 본 뒤 같은 404여야 해서다(I-T89 ⑤)
  @ContractRouteSchema({ responses: { 204: z.object({}).strict() } })
  async remove(
    @Param('sessionId') sessionId: string,
    @Headers('x-reauth-token') reauthToken: string | undefined,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    void reply.header('cache-control', 'no-store');
    try {
      await this.end.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: reauthToken ?? '', scannerSessionId: sessionId });
    } catch (e) {
      if (e instanceof AccountError && e.code === 'SESSION_NOT_FOUND') throw new ProblemError({ type: 'session-not-found', status: 404, title: '로그인한 기기가 아니거나 이미 로그아웃했습니다' });
      // 토큰이 없거나 만료·재사용이거나 세션·작업이 맞지 않으면 403 reauth-required(이유는 응답에 싣지 않는다)
      if (e instanceof AccountError) throw new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
      throw e;
    }
  }
}
