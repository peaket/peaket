// 받는 층: 계정 병합 제안 조회·확정(openapi /v1/identity/merge-proposals/{proposalId}·…/confirmation, identity §2.1 '계정 병합의 첫 구현', BUILD_ORDER BOT-042).
// gw-fan이 넘긴 신원(계정·세션)과 재인증 토큰 머리를 쓴다. 응답은 캐시하지 않는다.
import { Controller, Get, Headers, HttpCode, Param, Post, Res } from '@nestjs/common';
import { CurrentPrincipal, type Principal, ProblemError, Roles } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { ConfirmMerge } from '../application/confirm-merge.js';
import { GetMergeProposal } from '../application/get-merge-proposal.js';
import { MergeError } from '../application/merge-error.js';

/** 세 서비스 확인이 답하지 않을 때 다시 해 볼 때까지 [가정] */
const RETRY_AFTER_S = 5;

function problemOf(e: MergeError): ProblemError {
  switch (e.code) {
    case 'NOT_FOUND':
      return new ProblemError({ type: 'merge-proposal-not-found', status: 404, title: '병합 제안이 없거나 시간이 지났습니다' });
    case 'REAUTH_REQUIRED':
      return new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
    case 'BLOCKED':
      // 같은 종류의 로그인 수단으로 막았으면 그 종류도 싣는다(화면 문구, openapi MergeProposal.sameKindProviders, OPEN[21])
      return new ProblemError({
        type: 'merge-blocked',
        status: 409,
        title: '지금은 두 계정을 합칠 수 없습니다',
        extensions: { blockers: e.blockers ?? [], ...(e.sameKindProviders?.length ? { sameKindProviders: e.sameKindProviders } : {}) },
      });
    case 'INVARIANT':
      return new ProblemError({ type: 'merge-invariant-violated', status: 409, title: '지금은 두 계정을 합칠 수 없습니다. 고객센터로 문의해 주세요' });
    case 'UNAVAILABLE':
      return new ProblemError({ type: 'merge-check-unavailable', status: 503, title: '잠시 뒤 다시 시도해 주세요', retryAfterSeconds: RETRY_AFTER_S });
  }
}

@Controller('v1/identity/merge-proposals')
export class MergeProposalsController {
  constructor(
    private readonly view: GetMergeProposal,
    private readonly confirm: ConfirmMerge,
  ) {}

  @Get(':proposalId')
  @Roles(['fan'])
  async get(@Param('proposalId') proposalId: string, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply) {
    void reply.header('cache-control', 'no-store');
    try {
      return await this.view.run({ accountId: me.accountId, proposalId });
    } catch (e) {
      if (e instanceof MergeError) throw problemOf(e);
      throw e;
    }
  }

  @Post(':proposalId/confirmation')
  @Roles(['fan'])
  @HttpCode(202)
  async confirmation(
    @Param('proposalId') proposalId: string,
    @Headers('x-reauth-token') reauthToken: string | undefined,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    void reply.header('cache-control', 'no-store');
    try {
      await this.confirm.run({ accountId: me.accountId, sessionId: me.sessionId, proposalId, reauthToken: reauthToken ?? '' });
    } catch (e) {
      if (e instanceof MergeError) throw problemOf(e);
      throw e;
    }
  }
}
