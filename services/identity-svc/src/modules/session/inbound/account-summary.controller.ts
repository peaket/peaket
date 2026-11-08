// 받는 층: 팬 계정 요약과 가입 마무리(openapi GET /v1/identity/me, POST /v1/identity/signup-completions·nickname-checks·signup-cancellations,
// docs/features/identity.md §8 '팬 계정 요약·세션 종료 사유·가입 마무리의 첫 구현', BUILD_ORDER BOT-047, ADR-0235). gw-fan이 넘긴 신원을 쓴다. 응답은 캐시하지 않는다.
import { Controller, Get, HttpCode, Inject, Post, Res, UnauthorizedException } from '@nestjs/common';
import { COOKIE_CHALLENGE, ContractBody, CurrentPrincipal, type Principal, ProblemError, Roles } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AccountError } from '../application/account-error.js';
import { CancelSignup } from '../application/cancel-signup.js';
import { CheckNickname, NicknameCheckLimited } from '../application/check-nickname.js';
import { CompleteSignup, SignupError } from '../application/complete-signup.js';
import { GetAccountSummary } from '../application/get-account-summary.js';
import { NICKNAME_MAX_UNITS } from '../domain/signup.js';
import { clearSessionCookies } from './session-cookies.js';
import { COOKIE_DOMAIN } from './token.controller.js';

const PHONE = /^(010[0-9]{8}|01[16789][0-9]{7,8})$/;
// 계약처럼 닫는다(모르는 칸은 400, docs/api/guidelines.md §1). 필수 동의가 아니거나 동의 없는 휴대폰 번호는 본문 꼴 400이다
const SignupCompletionBody = z
  .object({
    ageOver14: z.literal(true),
    consents: z.object({ terms: z.literal(true), privacy: z.literal(true), marketing: z.boolean(), phone: z.boolean() }).strict(),
    nickname: z.string().min(1).max(NICKNAME_MAX_UNITS),
    phone: z.string().regex(PHONE).optional(),
  })
  .strict()
  .refine((b) => b.phone === undefined || b.consents.phone, { message: '동의 없는 휴대폰 번호' });
const NicknameCheckBody = z.object({ nickname: z.string().max(NICKNAME_MAX_UNITS) }).strict();
const SignupCancellationBody = z.object({ reason: z.literal('UNDER_14') }).strict();

/** 세션이 끝난 경우는 인증 가드의 401과 같은 모양이다 */
function unauthorized(reply: FastifyReply): UnauthorizedException {
  void reply.header('www-authenticate', COOKIE_CHALLENGE);
  return new UnauthorizedException();
}

const alreadyCompleted = () => new ProblemError({ type: 'signup-already-completed', status: 409, title: '이미 가입을 마친 계정입니다' });

@Controller('v1/identity')
export class AccountSummaryController {
  constructor(
    private readonly summary: GetAccountSummary,
    private readonly complete: CompleteSignup,
    private readonly nicknames: CheckNickname,
    private readonly cancel: CancelSignup,
    @Inject(COOKIE_DOMAIN) private readonly cookieDomain: string | undefined,
  ) {}

  /** 계정 요약(I-T77): 이메일·휴대폰 번호·회원 코드는 싣지 않는다 */
  @Get('me')
  @Roles(['fan'])
  async me(@CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply) {
    void reply.header('cache-control', 'no-store');
    try {
      return await this.summary.run({ accountId: me.accountId, sessionId: me.sessionId });
    } catch (e) {
      if (e instanceof AccountError && e.code === 'SESSION_ENDED') throw unauthorized(reply);
      throw e;
    }
  }

  /** 가입 마무리(I-T79): 새 계정 요약을 돌려준다 */
  @Post('signup-completions')
  @Roles(['fan'])
  @HttpCode(200)
  async signupCompletion(@ContractBody(SignupCompletionBody) body: z.output<typeof SignupCompletionBody>, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply) {
    void reply.header('cache-control', 'no-store');
    try {
      return await this.complete.run({ accountId: me.accountId, sessionId: me.sessionId, input: body });
    } catch (e) {
      if (e instanceof AccountError && e.code === 'SESSION_ENDED') throw unauthorized(reply);
      if (e instanceof SignupError) {
        if (e.code === 'ALREADY_COMPLETED') throw alreadyCompleted();
        if (e.code === 'UNDER_14') throw new ProblemError({ type: 'under-14', status: 403, title: '만 14세 미만은 피켓을 이용할 수 없습니다' });
        if (e.code === 'NICKNAME_TAKEN') throw new ProblemError({ type: 'nickname-taken', status: 409, title: '이미 사용 중인 닉네임입니다' });
        throw new ProblemError({ type: 'nickname-invalid', status: 400, title: '닉네임 꼴이 맞지 않습니다' });
      }
      throw e;
    }
  }

  /** 닉네임 확인(I-T80): 닉네임은 본문으로만 받는다. 세션마다 요청 한도 */
  @Post('nickname-checks')
  @Roles(['fan'])
  @HttpCode(200)
  async nicknameCheck(@ContractBody(NicknameCheckBody) body: z.output<typeof NicknameCheckBody>, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply) {
    void reply.header('cache-control', 'no-store');
    try {
      return await this.nicknames.run({ accountId: me.accountId, sessionId: me.sessionId, nickname: body.nickname });
    } catch (e) {
      if (e instanceof AccountError && e.code === 'SESSION_ENDED') throw unauthorized(reply);
      if (e instanceof NicknameCheckLimited) {
        void reply.header('retry-after', String(Math.ceil(e.retryAfterMs / 1000)));
        throw new ProblemError({ type: 'nickname-check-limited', status: 429, title: '닉네임 확인을 너무 많이 했습니다. 잠시 뒤 다시 시도해 주세요' });
      }
      throw e;
    }
  }

  /** 만 14세 미만 가입 취소(I-T81): 세션을 끝내고 팬 쿠키를 지운다 */
  @Post('signup-cancellations')
  @Roles(['fan'])
  @HttpCode(204)
  async signupCancellation(@ContractBody(SignupCancellationBody) _body: z.output<typeof SignupCancellationBody>, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    void reply.header('cache-control', 'no-store');
    try {
      await this.cancel.run({ accountId: me.accountId, sessionId: me.sessionId });
      void reply.header('set-cookie', clearSessionCookies(this.cookieDomain));
    } catch (e) {
      if (e instanceof AccountError && e.code === 'ALREADY_COMPLETED') throw alreadyCompleted();
      if (e instanceof AccountError && e.code === 'SESSION_ENDED') throw unauthorized(reply);
      throw e;
    }
  }
}
