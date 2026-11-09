// 받는 층: 팬의 로그인한 기기(openapi GET /v1/identity/sessions, DELETE /v1/identity/sessions/{sessionId}, docs/features/identity.md §8 '로그인한 기기와 다른 세션 끝내기의 첫 구현',
// BUILD_ORDER BOT-044, ADR-0209, FR-017, POL-019). gw-fan이 넘긴 신원(계정·세션)과 재인증 토큰 머리(X-Reauth-Token)를 쓴다. 응답은 캐시하지 않는다.
import { Controller, Delete, Get, Headers, HttpCode, Param, Res, UnauthorizedException } from '@nestjs/common';
import { COOKIE_CHALLENGE, CurrentPrincipal, type Principal, ProblemError, Roles } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { AccountError } from '../application/account-error.js';
import { EndDeviceSession } from '../application/end-device-session.js';
import { ListSessions } from '../application/list-sessions.js';

@Controller('v1/identity/sessions')
export class SessionsController {
  constructor(
    private readonly list: ListSessions,
    private readonly end: EndDeviceSession,
  ) {}

  /** 로그인한 기기마다 한 줄(I-T74 ①). 부른 세션이 이미 끝났으면 401(인증 가드의 401과 같은 모양) */
  @Get()
  @Roles(['fan'])
  async sessions(@CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply) {
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

  /** 다른 기기 로그아웃(I-T74 ②~⑤): 재인증 토큰 머리. 지금 기기 줄이면 같은 기기의 다른 로그인만 끝낸다. 남의·끝난 세션과 끝낼 다른 로그인이 없으면 같은 404 */
  @Delete(':sessionId')
  @Roles(['fan'])
  @HttpCode(204)
  async remove(
    @Param('sessionId') sessionId: string,
    @Headers('x-reauth-token') reauthToken: string | undefined,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    void reply.header('cache-control', 'no-store');
    try {
      await this.end.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: reauthToken ?? '', targetSessionId: sessionId });
    } catch (e) {
      if (e instanceof AccountError && e.code === 'SESSION_NOT_FOUND') throw new ProblemError({ type: 'session-not-found', status: 404, title: '로그인한 기기가 아니거나 이미 로그아웃했습니다' });
      // 토큰이 없거나 만료·재사용이거나 세션·작업 묶음이 맞지 않으면 403 reauth-required(이유는 응답에 싣지 않는다)
      if (e instanceof AccountError) throw new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
      throw e;
    }
  }
}
