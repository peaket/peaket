// 받는 층: 관리 계정 토큰 갱신과 로그아웃(openapi POST /v1/partner/auth/access-tokens·/v1/ops/auth/access-tokens, DELETE /v1/partner/auth/sessions/me·/v1/ops/auth/sessions/me,
// docs/features/identity.md §6 '관리 계정 토큰 갱신과 로그아웃의 첫 구현', BUILD_ORDER BOT-130). 응답은 캐시하지 않는다.
// 갱신은 액세스 토큰이 끝났어도 부를 수 있어야 해서 신원 머리를 보지 않고(팬 갱신과 같다) 그 콘솔의 리프레시 쿠키만 읽는다.
// 쿠키 쓰기의 Origin 확인과 gw-ops가 갱신 경로 밖에서 리프레시 쿠키를 넘기지 않는 것은 게이트웨이가 한다(BOT-132).
import { Controller, Delete, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { CLOCK, type Clock, COOKIE_CHALLENGE, CurrentPrincipal, type Principal, ProblemError, Roles } from '@peaket/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { cookieOf } from '../../session/index.js';
import { EndAdminSession } from '../application/end-admin-session.js';
import { RefreshAdminSession } from '../application/refresh-admin-session.js';
import type { AdminAud } from '../domain/ports.js';
import { ADMIN_COOKIE_DOMAIN, ADMIN_COOKIES, adminSessionCookies, clearAdminSessionCookies } from './admin-cookies.js';

@Controller()
export class AdminTokenController {
  constructor(
    private readonly refresh: RefreshAdminSession,
    private readonly end: EndAdminSession,
    @Inject(ADMIN_COOKIE_DOMAIN) private readonly cookieDomain: string | undefined,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post('v1/partner/auth/access-tokens')
  @Roles(['public'])
  @HttpCode(204)
  partnerRefresh(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    return this.#refresh('partner', req, reply);
  }

  @Post('v1/ops/auth/access-tokens')
  @Roles(['public'])
  @HttpCode(204)
  opsRefresh(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    return this.#refresh('ops', req, reply);
  }

  // 로그아웃은 비밀번호 바꾸기 필요 세션도 받는다(auth-controls §3.5, BOT-123이 넘긴 것)
  @Delete('v1/partner/auth/sessions/me')
  @Roles(['partner_admin', 'partner_member'], { passwordChangeSession: true })
  @HttpCode(204)
  partnerLogout(@CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    return this.#logout('partner', me, reply);
  }

  @Delete('v1/ops/auth/sessions/me')
  @Roles(['viewer', 'operator', 'commander', 'cs_agent', 'cs_lead'], { passwordChangeSession: true })
  @HttpCode(204)
  opsLogout(@CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    return this.#logout('ops', me, reply);
  }

  async #refresh(aud: AdminAud, req: FastifyRequest, reply: FastifyReply): Promise<void> {
    void reply.header('cache-control', 'no-store');
    const r = await this.refresh.run({ aud, refreshToken: cookieOf(req.headers.cookie, ADMIN_COOKIES[aud].rt) ?? '' });
    if (r.result !== 'OK') {
      void reply.header('www-authenticate', COOKIE_CHALLENGE).header('set-cookie', clearAdminSessionCookies(aud, this.cookieDomain));
      throw new ProblemError({ type: 'refresh-token-invalid', status: 401, title: '다시 로그인해 주세요' });
    }
    void reply.header('set-cookie', adminSessionCookies(aud, r, this.clock.now(), this.cookieDomain));
  }

  async #logout(aud: AdminAud, me: Principal, reply: FastifyReply): Promise<void> {
    void reply.header('cache-control', 'no-store');
    // 이미 끝났으면(가드 판정과 겹친 드문 경우) 그대로 204다: 쿠키만 지운다
    await this.end.run({ accountId: me.accountId, sessionId: me.sessionId });
    void reply.header('set-cookie', clearAdminSessionCookies(aud, this.cookieDomain));
  }
}
