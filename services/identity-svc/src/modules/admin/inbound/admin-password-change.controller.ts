// 받는 층: 관리 계정 비밀번호 바꾸기(openapi POST /v1/partner/auth/password-changes·/v1/ops/auth/password-changes, identity §6 '관리 계정 비밀번호만 맞은 로그인 알림과 비밀번호 바꾸기의 첫 구현', BUILD_ORDER BOT-123, AC-T4).
// 게이트웨이가 넘긴 관리 신원(계정·세션·스코프)과 identity의 역할 판정(가드)을 쓴다. 비밀번호 바꾸기 필요 세션(scope password:change)도 받는다.
import { Controller, HttpCode, Inject, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { CLOCK, type Clock, ContractBody, COOKIE_CHALLENGE, CurrentPrincipal, type Principal, ProblemError, Roles } from '@peaket/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AdminPasswordError, PASSWORD_ADVICE, REJECTION_TEXT } from '../application/admin-password-error.js';
import { ChangeAdminPassword } from '../application/change-admin-password.js';
import { type AdminAud, LoginCountersUnavailable, PepperUnavailable } from '../domain/ports.js';
import { ADMIN_COOKIE_DOMAIN, ADMIN_COOKIES } from './admin-cookies.js';
import { clientIpOf } from './admin-login.controller.js';

const RETRY_AFTER_S = 5;
const Body = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: z.string().min(15).max(256),
  })
  .strict();

@Controller()
export class AdminPasswordChangeController {
  constructor(
    private readonly change: ChangeAdminPassword,
    @Inject(ADMIN_COOKIE_DOMAIN) private readonly cookieDomain: string | undefined,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post('v1/partner/auth/password-changes')
  @Roles(['partner_admin', 'partner_member'], { passwordChangeSession: true })
  @HttpCode(204)
  partner(@ContractBody(Body) body: z.output<typeof Body>, @CurrentPrincipal() me: Principal, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    return this.#run('partner', body, me, req, reply);
  }

  @Post('v1/ops/auth/password-changes')
  @Roles(['viewer', 'operator', 'commander', 'cs_agent', 'cs_lead'], { passwordChangeSession: true })
  @HttpCode(204)
  ops(@ContractBody(Body) body: z.output<typeof Body>, @CurrentPrincipal() me: Principal, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    return this.#run('ops', body, me, req, reply);
  }

  async #run(aud: AdminAud, body: z.output<typeof Body>, me: Principal, req: FastifyRequest, reply: FastifyReply): Promise<void> {
    void reply.header('cache-control', 'no-store');
    let o;
    try {
      o = await this.change.run({ aud, accountId: me.accountId, sessionId: me.sessionId, scopes: me.scopes, currentPassword: body.currentPassword, newPassword: body.newPassword, ip: clientIpOf(req) });
    } catch (e) {
      if ((e instanceof AdminPasswordError && e.code === 'UNAVAILABLE') || e instanceof LoginCountersUnavailable || e instanceof PepperUnavailable) {
        throw new ProblemError({ type: 'admin-login-unavailable', status: 503, title: '잠시 뒤 다시 시도해 주세요', retryAfterSeconds: RETRY_AFTER_S });
      }
      throw e;
    }
    switch (o.kind) {
      case 'CHANGED':
        // 비밀번호 바꾸기 필요 세션이었으면 제한을 푼 새 액세스 토큰 쿠키(같은 이름·속성, identity §3 쿠키 표)
        if (o.accessToken && o.absoluteExpiresAt) {
          const names = ADMIN_COOKIES[aud];
          const maxAge = Math.max(0, Math.floor((o.absoluteExpiresAt - this.clock.now()) / 1000));
          const dom = aud === 'partner' && this.cookieDomain ? `; Domain=${this.cookieDomain}` : '';
          void reply.header('set-cookie', `${names.at}=${o.accessToken}${dom}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`);
        }
        return;
      case 'CURRENT_INVALID':
        throw new ProblemError({ type: 'current-password-invalid', status: 422, title: '지금 비밀번호가 맞지 않습니다', normalBranch: true });
      case 'REJECTED':
        throw new ProblemError({ type: 'password-rejected', status: 422, title: '쓸 수 없는 비밀번호입니다', detail: REJECTION_TEXT[o.reason], normalBranch: true, extensions: { reason: o.reason, advice: PASSWORD_ADVICE } });
      case 'LOCKED':
        throw new ProblemError({ type: 'admin-account-locked', status: 423, title: '계정이 잠겼습니다', normalBranch: true, retryAfterSeconds: o.retryAfterSeconds, extensions: { lock: 'TIMED', retryAfterSeconds: o.retryAfterSeconds } });
      case 'PROTECTED':
        throw new ProblemError({ type: 'admin-account-locked', status: 423, title: '계정이 잠겼습니다', normalBranch: true, extensions: { lock: 'PROTECT' } });
      case 'NOT_FOUND':
        throw new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
      case 'SESSION_INVALID':
        // 가드의 신원 401과 같다(RFC 9110 §15.5.2)
        void reply.header('www-authenticate', COOKIE_CHALLENGE);
        throw new UnauthorizedException();
      case 'BUSY':
        throw new ProblemError({ type: 'admin-login-busy', status: 429, title: '잠시 뒤 다시 시도해 주세요', normalBranch: true, retryAfterSeconds: 1 });
    }
  }
}
