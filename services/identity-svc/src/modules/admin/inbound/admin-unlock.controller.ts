// 받는 층: 관리 계정 시간 잠금 본인 해제와 해제 링크 다시 받기(openapi POST /v1/{partner|ops}/auth/unlocks·/unlock-links, identity §6 '관리 계정 본인 해제 링크와 2단계 보호 잠금의 첫 구현', BUILD_ORDER BOT-121).
// 게이트웨이가 Origin을 확인하고 넘긴다. 링크 토큰은 URL 조각에서 화면이 읽어 본문으로 보낸다(주소·접근 로그에 남지 않는다). 응답은 캐시하지 않는다.
import { Controller, HttpCode, Post, Res } from '@nestjs/common';
import { ContractBody, ProblemError, Roles } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { RequestUnlockLink, UnlockWithLink } from '../application/unlock-account.js';
import { type AdminAud, LoginCountersUnavailable, PepperUnavailable, TotpKeyUnavailable } from '../domain/ports.js';

const RETRY_AFTER_S = 5;
const UnlockBody = z
  .object({
    unlockToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code: z.string().min(6).max(64),
  })
  .strict();
const ResendBody = z.object({ email: z.string().email().max(254) }).strict();

const unavailable = (e: unknown) => {
  if (e instanceof LoginCountersUnavailable || e instanceof PepperUnavailable || e instanceof TotpKeyUnavailable) return new ProblemError({ type: 'admin-login-unavailable', status: 503, title: '잠시 뒤 다시 시도해 주세요', retryAfterSeconds: RETRY_AFTER_S });
  return e;
};

@Controller()
export class AdminUnlockController {
  constructor(
    private readonly unlock: UnlockWithLink,
    private readonly resend: RequestUnlockLink,
  ) {}

  @Post('v1/partner/auth/unlocks')
  @Roles(['public'])
  @HttpCode(204)
  partnerUnlock(@ContractBody(UnlockBody) body: z.output<typeof UnlockBody>, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    return this.#unlock('partner', body, reply);
  }

  @Post('v1/ops/auth/unlocks')
  @Roles(['public'])
  @HttpCode(204)
  opsUnlock(@ContractBody(UnlockBody) body: z.output<typeof UnlockBody>, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    return this.#unlock('ops', body, reply);
  }

  @Post('v1/partner/auth/unlock-links')
  @Roles(['public'])
  @HttpCode(202)
  partnerResend(@ContractBody(ResendBody) body: z.output<typeof ResendBody>, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    return this.#resend('partner', body, reply);
  }

  @Post('v1/ops/auth/unlock-links')
  @Roles(['public'])
  @HttpCode(202)
  opsResend(@ContractBody(ResendBody) body: z.output<typeof ResendBody>, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    return this.#resend('ops', body, reply);
  }

  async #unlock(aud: AdminAud, body: { unlockToken: string; code: string }, reply: FastifyReply): Promise<void> {
    void reply.header('cache-control', 'no-store');
    let o;
    try {
      o = await this.unlock.run({ aud, unlockToken: body.unlockToken, code: body.code });
    } catch (e) {
      throw unavailable(e);
    }
    switch (o.kind) {
      case 'UNLOCKED':
        return;
      case 'LINK_INVALID':
        throw new ProblemError({ type: 'unlock-link-invalid', status: 410, title: '이 링크는 더 쓸 수 없습니다', normalBranch: true });
      case 'CODE_INVALID':
        throw new ProblemError({ type: 'unlock-code-invalid', status: 422, title: '코드가 맞지 않습니다', normalBranch: true, extensions: { remainingAttempts: o.remainingAttempts } });
      case 'PROTECTED':
        throw new ProblemError({ type: 'admin-account-locked', status: 423, title: '계정이 잠겼습니다', normalBranch: true, extensions: { lock: 'PROTECT' } });
      case 'BUSY':
        throw new ProblemError({ type: 'admin-login-busy', status: 429, title: '잠시 뒤 다시 시도해 주세요', normalBranch: true, retryAfterSeconds: 1 });
    }
  }

  async #resend(aud: AdminAud, body: { email: string }, reply: FastifyReply): Promise<void> {
    void reply.header('cache-control', 'no-store');
    let o;
    try {
      o = await this.resend.run({ aud, email: body.email });
    } catch (e) {
      throw unavailable(e);
    }
    if (o.kind === 'RATE_LIMITED') throw new ProblemError({ type: 'unlock-link-resend-limit', status: 429, title: '해제 링크는 1시간에 3번까지 다시 받을 수 있습니다', normalBranch: true, retryAfterSeconds: o.retryAfterSeconds });
  }
}
