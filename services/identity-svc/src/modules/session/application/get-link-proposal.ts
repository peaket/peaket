// 가입 때 연결 제안 조회(GET /v1/identity/link-proposals/{proposalId} → SessionService.GetLinkProposal, identity §2.1 '가입 때 연결 제안의 첫 구현', I-T29).
// 묶음 값이 맞을 때만 기존·새 제공자, 만료 시각, 남은 시도를 준다. 닉네임·이메일은 주지 않는다(다른 사람 계정을 캐내지 못하게).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { LINK_PROPOSALS, type LinkProposals, LinkStoreUnavailable } from '../domain/ports.js';
import { LINK_MAX_ATTEMPTS, type Provider } from '../domain/session.js';
import { bindingMatches, proposalIdOk } from './create-session.js';
import { SessionError } from './session-error.js';

export interface LinkProposalView {
  existingProvider: Provider;
  newProvider: Provider;
  expiresAt: number;
  attemptsLeft: number;
}

@Injectable()
export class GetLinkProposal {
  constructor(
    @Inject(LINK_PROPOSALS) private readonly links: LinkProposals,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** @throws SessionError NOT_FOUND 없음·만료·묶음 값이 다름, UNAVAILABLE 저장소 장애 */
  async run(i: { proposalId: string; binding: string }): Promise<LinkProposalView> {
    if (!proposalIdOk(i.proposalId)) throw new SessionError('NOT_FOUND', '연결 제안이 없다');
    let p;
    try {
      p = await this.links.get(i.proposalId);
    } catch (err) {
      if (err instanceof LinkStoreUnavailable) throw new SessionError('UNAVAILABLE', '연결 제안 저장소에 닿지 못했다');
      throw err;
    }
    if (!p || p.expiresAt <= this.clock.now() || !bindingMatches(p, i.binding)) throw new SessionError('NOT_FOUND', '연결 제안이 없거나 만료됐다');
    return { existingProvider: p.existingProvider, newProvider: p.newProvider, expiresAt: p.expiresAt, attemptsLeft: Math.max(0, LINK_MAX_ATTEMPTS - p.attempts) };
  }
}
