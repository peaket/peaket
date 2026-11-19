// 받는 층: 팬 탈퇴(openapi DELETE /v1/identity/account, docs/features/identity.md §8 '탈퇴의 첫 구현', BUILD_ORDER BOT-030, FR-017, POL-033).
// gw-fan이 넘긴 신원(계정·세션)과 재인증 토큰 머리(X-Reauth-Token, docs/api/guidelines.md 재인증 토큰)를 쓴다. 응답은 캐시하지 않는다.
// 끝냈으면 204, 탈퇴 참여자를 기다려 미뤘으면 본문 없는 202다(BUILD_ORDER PRF-169, ADR-0284).
// 결제한 미사용 티켓이 있으면 409 withdrawal-confirmation-required의 extensions.unusedTickets로 환급 예상을 보이고(PRF-174, I-T26),
// 견적을 받지 못하면 503 dependency-unavailable과 Retry-After 1초 [가정]다. 두 409 모두 재인증 토큰을 쓰지 않는다.
import { Controller, Delete, Get, Headers, HttpCode, Param, Res } from '@nestjs/common';
import { ContractBody, CurrentPrincipal, type Principal, ProblemError, Roles } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AccountError } from '../application/account-error.js';
import { ListProviders } from '../application/list-providers.js';
import { UnlinkProvider } from '../application/unlink-provider.js';
import { WithdrawAccount } from '../application/withdraw-account.js';
import type { Provider } from '../domain/session.js';

const PROVIDERS: readonly string[] = ['kakao', 'naver', 'google'];

// openapi 요청 본문(환불 계좌는 가상계좌 지금 환급 때만 쓰고 저장하지 않는다. 가상계좌 결제가 생기기 전에는 받기만 하고 버린다, BUILD_ORDER BOT-035)
// 계약처럼 닫는다(모르는 칸은 400, docs/api/guidelines.md §1). 환불 계좌는 계약 RefundAccount의 세 칸
const RefundAccount = z.object({ bankCode: z.string(), accountNumber: z.string(), holderName: z.string() }).strict();
const WithdrawBody = z
  .object({ confirmCancelUnusedTickets: z.boolean().optional(), acknowledgeFraudHold: z.boolean().optional(), refundAccount: RefundAccount.optional() })
  .strict()
  .optional();

@Controller('v1/identity/account')
export class AccountController {
  constructor(private readonly withdraw: WithdrawAccount) {}

  @Delete()
  @Roles(['fan'])
  @HttpCode(204)
  async remove(
    @Headers('x-reauth-token') reauthToken: string | undefined,
    @ContractBody(WithdrawBody) body: z.output<typeof WithdrawBody>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    void reply.header('cache-control', 'no-store');
    try {
      const r = await this.withdraw.run({
        accountId: me.accountId,
        sessionId: me.sessionId,
        reauthToken: reauthToken ?? '',
        body: { confirmCancelUnusedTickets: body?.confirmCancelUnusedTickets, acknowledgeFraudHold: body?.acknowledgeFraudHold },
      });
      // 탈퇴 참여자가 끝나지 않았거나 답하지 못했으면 본문 없는 202(identity §8 '탈퇴 참여자와 탈퇴 미룸의 첫 구현', ADR-0284). 끝냈으면 204 그대로
      if (r.outcome === 'DEFERRED') void reply.code(202);
    } catch (e) {
      // 대조값 보관 행이 있으면 409 '탈퇴 전 확인'과 fraudHold(상태와 끝, identity §8 '대조값 보관의 첫 구현')
      if (e instanceof AccountError && e.code === 'CONFIRMATION_REQUIRED' && e.fraudHold) {
        throw new ProblemError({
          type: 'withdrawal-confirmation-required',
          status: 409,
          title: '탈퇴 전에 확인해 주세요',
          extensions: { fraudHold: { state: e.fraudHold.state, until: new Date(e.fraudHold.until).toISOString() } },
        });
      }
      // 결제한 미사용 티켓이 있으면 409 '탈퇴 전 확인'과 unusedTickets(수·결제 금액·공제액·환급 예상액·양도 가능 수·마감 뒤 환급 수, identity §8 '미사용 티켓 확인과 취소')
      if (e instanceof AccountError && e.code === 'CONFIRMATION_REQUIRED' && e.unusedTickets) {
        throw new ProblemError({
          type: 'withdrawal-confirmation-required',
          status: 409,
          title: '탈퇴 전에 확인해 주세요',
          extensions: {
            unusedTickets: {
              count: e.unusedTickets.count,
              ticketAmount: e.unusedTickets.ticketAmount,
              deductionAmount: e.unusedTickets.deductionAmount,
              refundAmount: e.unusedTickets.refundAmount,
              transferableCount: e.unusedTickets.transferableCount,
              deferredRefundCount: e.unusedTickets.deferredRefundCount,
            },
          },
        });
      }
      // 견적을 받지 못했으면 상태·토큰을 바꾸지 않고 503과 Retry-After 1초 [가정](identity §8 '미사용 티켓 확인과 취소')
      if (e instanceof AccountError && e.code === 'DEPENDENCY_UNAVAILABLE') {
        throw new ProblemError({ type: 'dependency-unavailable', status: 503, title: '잠시 뒤 다시 시도해 주세요', retryAfterSeconds: 1 });
      }
      // 토큰이 없거나 만료·재사용이거나 세션·작업 묶음이 맞지 않으면 403 reauth-required(이유는 응답에 싣지 않는다)
      if (e instanceof AccountError) throw new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
      throw e;
    }
  }
}

/** 받는 층: 연결된 로그인 수단 목록(openapi GET /v1/identity/providers, identity §8 '탈퇴 화면 연결'). 응답은 캐시하지 않는다 */
@Controller('v1/identity/providers')
export class ProvidersController {
  constructor(
    private readonly list: ListProviders,
    private readonly unlink: UnlinkProvider,
  ) {}

  /** 로그인 수단 해제(SCR-040 ③, identity §2.1 '설정의 로그인 수단 연결·해제의 첫 구현', BOT-041, I-T33): 재인증 토큰 머리, 마지막 하나는 409 */
  @Delete(':provider')
  @Roles(['fan'])
  @HttpCode(204)
  async remove(
    @Param('provider') provider: string,
    @Headers('x-reauth-token') reauthToken: string | undefined,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    void reply.header('cache-control', 'no-store');
    if (!PROVIDERS.includes(provider)) throw new ProblemError({ type: 'login-provider-not-linked', status: 404, title: '연결된 로그인 수단이 아닙니다' });
    try {
      await this.unlink.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: reauthToken ?? '', provider: provider as Provider });
    } catch (e) {
      if (e instanceof AccountError && e.code === 'NOT_FOUND') throw new ProblemError({ type: 'login-provider-not-linked', status: 404, title: '연결된 로그인 수단이 아닙니다' });
      if (e instanceof AccountError && e.code === 'LAST_LOGIN_METHOD') throw new ProblemError({ type: 'last-login-method', status: 409, title: '마지막 로그인 수단은 해제할 수 없습니다' });
      if (e instanceof AccountError) throw new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
      throw e;
    }
  }

  @Get()
  @Roles(['fan'])
  async providers(@CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply) {
    void reply.header('cache-control', 'no-store');
    return { providers: await this.list.run(me.accountId) };
  }
}
