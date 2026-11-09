// 받는 층: 관리 계정 로그인 1단계(openapi POST /v1/partner/auth/sessions·/v1/ops/auth/sessions, identity §6 '관리 계정 로그인 1단계와 실패 제한의 첫 구현', BUILD_ORDER BOT-111).
// 게이트웨이(gw-partner·gw-ops)가 Origin을 확인하고 넘긴다. 클라이언트 IP는 게이트웨이가 하나로 다시 쓴 x-forwarded-for다(HOT-400). 응답은 캐시하지 않는다.
// 2단계(TOTP) 본문은 BOT-120이 더한다.
import { isIP } from 'node:net';
import { Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { CLOCK, type Clock, COOKIE_CHALLENGE, ContractBody, ProblemError, Roles } from '@peaket/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LoginPasswordStep, type LoginStepOutcome } from '../application/login-password-step.js';
import { LoginSecondStep, type SecondStepOutcome } from '../application/login-second-step.js';
import { type AdminAud, LoginCountersUnavailable, PepperUnavailable, TotpKeyUnavailable } from '../domain/ports.js';
import { ADMIN_COOKIE_DOMAIN, adminSessionCookies } from './admin-cookies.js';

/** 셈 저장소·페퍼 키 서비스·사람 확인 서비스가 답하지 않을 때 다시 해 볼 때까지 [가정] */
const RETRY_AFTER_S = 5;

const PasswordStep = z
  .object({
    email: z.string().email().max(254),
    password: z.string().min(1).max(1024),
    deviceId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .optional(),
    humanCheckToken: z.string().min(1).max(2048).optional(),
  })
  .strict();
const SecondStep = z
  .object({
    loginStep: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code: z.string().min(6).max(32),
  })
  .strict();
const LoginBody = z.union([PasswordStep, SecondStep]);
type PasswordStepBody = z.output<typeof PasswordStep>;
type LoginBodyT = z.output<typeof LoginBody>;

/** 게이트웨이가 쓴 클라이언트 IP 하나. 없거나 IP가 아니면 연결 상대 주소 */
export function clientIpOf(req: Pick<FastifyRequest, 'headers' | 'socket'>): string {
  const h = req.headers['x-forwarded-for'];
  const v = (Array.isArray(h) ? h[0] : h)?.trim();
  if (v && isIP(v)) return v;
  return req.socket?.remoteAddress ?? '';
}

function respond(o: LoginStepOutcome, reply: FastifyReply): object {
  switch (o.kind) {
    case 'PASSED':
      return { next: 'TOTP', loginStep: o.loginStep, expiresInSeconds: o.expiresInSeconds };
    case 'FAILED':
      void reply.header('www-authenticate', COOKIE_CHALLENGE);
      throw new ProblemError({ type: 'admin-login-failed', status: 401, title: '이메일이나 비밀번호가 맞지 않습니다', normalBranch: true, extensions: { remainingAttempts: o.remainingAttempts, humanCheckRequired: o.humanCheckRequired } });
    case 'LOCKED':
      if (o.lock === 'PROTECT') throw new ProblemError({ type: 'admin-account-locked', status: 423, title: '계정이 잠겼습니다', normalBranch: true, extensions: { lock: 'PROTECT' } });
      throw new ProblemError({ type: 'admin-account-locked', status: 423, title: '계정이 잠겼습니다', normalBranch: true, retryAfterSeconds: o.retryAfterSeconds, extensions: { lock: 'TIMED', retryAfterSeconds: o.retryAfterSeconds } });
    case 'HUMAN_CHECK_REQUIRED':
      throw new ProblemError({ type: 'human-check-required', status: 428, title: '사람 확인을 마친 뒤 다시 시도해 주세요', normalBranch: true });
    case 'BUSY':
      throw new ProblemError({ type: 'admin-login-busy', status: 429, title: '잠시 뒤 다시 시도해 주세요', normalBranch: true, retryAfterSeconds: 1 });
    case 'HUMAN_CHECK_UNAVAILABLE':
      throw new ProblemError({ type: 'human-check-unavailable', status: 503, title: '잠시 뒤 다시 시도해 주세요', retryAfterSeconds: RETRY_AFTER_S });
  }
}

function respondSecond(o: Exclude<SecondStepOutcome, { kind: 'DONE' }>): never {
  switch (o.kind) {
    case 'STEP_INVALID':
      throw new ProblemError({ type: 'admin-login-step-invalid', status: 401, title: '처음부터 다시 로그인해 주세요', normalBranch: true });
    case 'CODE_INVALID':
      throw new ProblemError({ type: 'admin-login-code-invalid', status: 401, title: '인증 앱 코드가 맞지 않습니다', normalBranch: true, extensions: { remainingAttempts: o.remainingAttempts } });
    case 'LOCKED':
      if (o.lock === 'PROTECT') throw new ProblemError({ type: 'admin-account-locked', status: 423, title: '계정이 잠겼습니다', normalBranch: true, extensions: { lock: 'PROTECT' } });
      throw new ProblemError({ type: 'admin-account-locked', status: 423, title: '계정이 잠겼습니다', normalBranch: true, retryAfterSeconds: o.retryAfterSeconds, extensions: { lock: 'TIMED', retryAfterSeconds: o.retryAfterSeconds } });
    case 'BUSY':
      throw new ProblemError({ type: 'admin-login-busy', status: 429, title: '잠시 뒤 다시 시도해 주세요', normalBranch: true, retryAfterSeconds: 1 });
  }
}

@Controller()
export class AdminLoginController {
  constructor(
    private readonly step: LoginPasswordStep,
    private readonly second: LoginSecondStep,
    @Inject(ADMIN_COOKIE_DOMAIN) private readonly cookieDomain: string | undefined,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post('v1/partner/auth/sessions')
  @Roles(['public'])
  @HttpCode(200)
  partner(@ContractBody(LoginBody) body: LoginBodyT, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<object> {
    return this.#run('partner', body, req, reply);
  }

  @Post('v1/ops/auth/sessions')
  @Roles(['public'])
  @HttpCode(200)
  ops(@ContractBody(LoginBody) body: LoginBodyT, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<object> {
    return this.#run('ops', body, req, reply);
  }

  async #run(aud: AdminAud, body: LoginBodyT, req: FastifyRequest, reply: FastifyReply): Promise<object> {
    void reply.header('cache-control', 'no-store');
    if ('loginStep' in body) return this.#second(aud, body, req, reply);
    return this.#first(aud, body, req, reply);
  }

  async #second(aud: AdminAud, body: { loginStep: string; code: string }, req: FastifyRequest, reply: FastifyReply): Promise<object> {
    let o: SecondStepOutcome;
    try {
      o = await this.second.run({ aud, loginStep: body.loginStep, code: body.code, ip: clientIpOf(req), deviceId: '' });
    } catch (e) {
      if (e instanceof LoginCountersUnavailable || e instanceof PepperUnavailable || e instanceof TotpKeyUnavailable) throw new ProblemError({ type: 'admin-login-unavailable', status: 503, title: '잠시 뒤 다시 시도해 주세요', retryAfterSeconds: RETRY_AFTER_S });
      throw e;
    }
    if (o.kind !== 'DONE') {
      if (o.kind === 'STEP_INVALID' || o.kind === 'CODE_INVALID') void reply.header('www-authenticate', COOKIE_CHALLENGE);
      respondSecond(o);
    }
    // 토큰은 본문이 아니라 쿠키 둘로 준다(게이트웨이가 그대로 돌려준다, identity §3 쿠키 표)
    void reply.header('set-cookie', adminSessionCookies(aud, o, this.clock.now(), this.cookieDomain));
    return { next: 'DONE' };
  }

  async #first(aud: AdminAud, body: PasswordStepBody, req: FastifyRequest, reply: FastifyReply): Promise<object> {
    let o: LoginStepOutcome;
    try {
      o = await this.step.run({ aud, email: body.email, password: body.password, ip: clientIpOf(req), deviceId: body.deviceId ?? '', ...(body.humanCheckToken ? { humanCheckToken: body.humanCheckToken } : {}) });
    } catch (e) {
      if (e instanceof LoginCountersUnavailable || e instanceof PepperUnavailable) throw new ProblemError({ type: 'admin-login-unavailable', status: 503, title: '잠시 뒤 다시 시도해 주세요', retryAfterSeconds: RETRY_AFTER_S });
      throw e;
    }
    return respond(o, reply);
  }
}
