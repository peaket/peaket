// 받는 층: 관리 계정 로그인 1단계(openapi POST /v1/partner/auth/sessions·/v1/ops/auth/sessions, identity §6 '관리 계정 로그인 1단계와 실패 제한의 첫 구현', BUILD_ORDER BOT-111).
// 게이트웨이(gw-partner·gw-ops)가 Origin을 확인하고 넘긴다. 클라이언트 IP는 게이트웨이가 하나로 다시 쓴 x-forwarded-for다(HOT-400). 응답은 캐시하지 않는다.
// 2단계(TOTP) 본문은 BOT-120이 더한다.
import { isIP } from 'node:net';
import { Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { COOKIE_CHALLENGE, ContractBody, ProblemError, Roles } from '@peaket/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LoginPasswordStep, type LoginStepOutcome } from '../application/login-password-step.js';
import { type AdminAud, LoginCountersUnavailable, PepperUnavailable } from '../domain/ports.js';

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
type PasswordStepBody = z.output<typeof PasswordStep>;

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

@Controller()
export class AdminLoginController {
  constructor(private readonly step: LoginPasswordStep) {}

  @Post('v1/partner/auth/sessions')
  @Roles(['public'])
  @HttpCode(200)
  partner(@ContractBody(PasswordStep) body: PasswordStepBody, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<object> {
    return this.#run('partner', body, req, reply);
  }

  @Post('v1/ops/auth/sessions')
  @Roles(['public'])
  @HttpCode(200)
  ops(@ContractBody(PasswordStep) body: PasswordStepBody, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<object> {
    return this.#run('ops', body, req, reply);
  }

  async #run(aud: AdminAud, body: PasswordStepBody, req: FastifyRequest, reply: FastifyReply): Promise<object> {
    void reply.header('cache-control', 'no-store');
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
