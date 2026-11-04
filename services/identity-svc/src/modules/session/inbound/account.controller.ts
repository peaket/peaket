// 받는 층: 팬 탈퇴(openapi DELETE /v1/identity/account, docs/features/identity.md §8 '탈퇴의 첫 구현', BUILD_ORDER BOT-030, FR-017, POL-033).
// gw-fan이 넘긴 신원(계정·세션)과 재인증 토큰 머리(X-Reauth-Token, docs/api/guidelines.md 재인증 토큰)를 쓴다. 응답은 캐시하지 않는다.
import { Controller, Delete, Get, Headers, HttpCode, Res } from '@nestjs/common';
import { ContractBody, CurrentPrincipal, type Principal, ProblemError, Roles } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AccountError } from '../application/account-error.js';
import { ListProviders } from '../application/list-providers.js';
import { WithdrawAccount } from '../application/withdraw-account.js';

// openapi 요청 본문(환불 계좌는 가상계좌 지금 환급 때만 쓰고 저장하지 않는다. 가상계좌 결제가 생기기 전에는 받기만 하고 버린다, BUILD_ORDER BOT-035)
const WithdrawBody = z
  .object({ confirmCancelUnusedTickets: z.boolean().optional(), acknowledgeFraudHold: z.boolean().optional(), refundAccount: z.object({}).passthrough().optional() })
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
      await this.withdraw.run({
        accountId: me.accountId,
        sessionId: me.sessionId,
        reauthToken: reauthToken ?? '',
        body: { confirmCancelUnusedTickets: body?.confirmCancelUnusedTickets, acknowledgeFraudHold: body?.acknowledgeFraudHold },
      });
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
      // 토큰이 없거나 만료·재사용이거나 세션·작업 묶음이 맞지 않으면 403 reauth-required(이유는 응답에 싣지 않는다)
      if (e instanceof AccountError) throw new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
      throw e;
    }
  }
}

/** 받는 층: 연결된 로그인 수단 목록(openapi GET /v1/identity/providers, identity §8 '탈퇴 화면 연결'). 응답은 캐시하지 않는다 */
@Controller('v1/identity/providers')
export class ProvidersController {
  constructor(private readonly list: ListProviders) {}

  @Get()
  @Roles(['fan'])
  async providers(@CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply) {
    void reply.header('cache-control', 'no-store');
    return { providers: await this.list.run(me.accountId) };
  }
}
