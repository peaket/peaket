// 받는 층: 팬 토큰 갱신(openapi POST /v1/identity/access-tokens, docs/features/identity.md §3 '토큰 수명주기 구현', I-T4)과
// 공개키 묶음(GET /internal/jwks/{fan|admin|staff}.json, 클러스터 안에서만, I-T20).
// 갱신은 gw-fan이 Origin을 확인하고 넘긴다. 실패 응답은 401, WWW-Authenticate, 쿠키 지우기이고, 쿠키의 토큰이 끝난 세션의 것이면 끝난 까닭 ended를 싣는다(ADR-0235 결정 1).
import { Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { CLOCK, type Clock, COOKIE_CHALLENGE, ProblemError, Roles } from '@peaket/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RefreshSession } from '../application/refresh-session.js';
import { PUBLIC_KEYS, type PublicKeys } from '../domain/ports.js';
import { clearSessionCookies, cookieOf, REFRESH_COOKIE, sessionCookies } from './session-cookies.js';

export const COOKIE_DOMAIN = Symbol('identity.CookieDomain');

@Controller()
export class TokenController {
  constructor(
    private readonly refresh: RefreshSession,
    @Inject(COOKIE_DOMAIN) private readonly cookieDomain: string | undefined,
    @Inject(PUBLIC_KEYS) private readonly keys: PublicKeys,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post('v1/identity/access-tokens')
  @Roles(['public'])
  @HttpCode(204)
  async refreshTokens(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    void reply.header('cache-control', 'no-store');
    const r = await this.refresh.run({ refreshToken: cookieOf(req.headers.cookie, REFRESH_COOKIE) ?? '' });
    if (r.result !== 'OK') {
      void reply.header('www-authenticate', COOKIE_CHALLENGE).header('set-cookie', clearSessionCookies(this.cookieDomain));
      throw new ProblemError({ type: 'refresh-token-invalid', status: 401, title: '다시 로그인해 주세요', ...(r.ended ? { extensions: { ended: r.ended } } : {}) });
    }
    void reply.header('set-cookie', sessionCookies(r, this.clock.now(), this.cookieDomain));
  }

  @Get('internal/jwks/:file')
  @Roles(['public'])
  jwks(@Param('file') file: string, @Res({ passthrough: true }) reply: FastifyReply): object {
    const m = /^(fan|admin|staff)\.json$/.exec(file);
    if (!m) throw new ProblemError({ type: 'jwks-not-found', status: 404, title: '없는 공개키 묶음입니다' });
    void reply.header('cache-control', 'public, max-age=300').header('content-type', 'application/jwk-set+json');
    return this.keys.jwks(m[1] as 'fan' | 'admin' | 'staff', this.clock.now());
  }
}
