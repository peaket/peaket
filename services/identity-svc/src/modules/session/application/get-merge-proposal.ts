// 병합 제안 조회(GET /v1/identity/merge-proposals/{proposalId}, identity §2.1 '계정 병합의 첫 구현', BUILD_ORDER BOT-042). 제안한 계정만 읽는다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import type { MergeBlocker, MovedSummary } from '../domain/merge.js';
import type { Provider } from '../domain/session.js';
import { LinkStoreUnavailable, MERGE_PROPOSALS, type MergeProposals } from '../domain/ports.js';
import { MergeError } from './merge-error.js';

const PROPOSAL_ID = /^[A-Za-z0-9_-]{22}$/;

/** openapi MergeProposal */
export interface MergeProposalView {
  proposalId: string;
  primaryAccountId: string;
  mergedAccountId: string;
  status: 'PROPOSED' | 'BLOCKED';
  moved: MovedSummary;
  blockers: MergeBlocker[];
  expiresAt: string;
  /** 추가하려던 로그인 수단의 종류(BOT-043 화면 문구) */
  newProvider: Provider;
  /** 지금 로그인한 계정이 남는 쪽인지 */
  requesterRole: 'PRIMARY' | 'MERGED';
  primaryVerified: boolean;
  /** SAME_PROVIDER_KIND로 막혔을 때만: 두 계정에 함께 있는 종류(OPEN[21]) */
  sameKindProviders?: Provider[];
}

@Injectable()
export class GetMergeProposal {
  constructor(
    @Inject(MERGE_PROPOSALS) private readonly proposals: MergeProposals,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** @throws MergeError NOT_FOUND·UNAVAILABLE */
  async run(i: { accountId: string; proposalId: string }): Promise<MergeProposalView> {
    if (!PROPOSAL_ID.test(i.proposalId)) throw new MergeError('NOT_FOUND', '병합 제안이 없다');
    let p;
    try {
      p = await this.proposals.get(i.proposalId);
    } catch (e) {
      if (e instanceof LinkStoreUnavailable) throw new MergeError('UNAVAILABLE', '병합 제안 저장소에 닿지 못했다');
      throw e;
    }
    if (!p || p.expiresAt <= this.clock.now() || p.requesterAccountId !== i.accountId.toLowerCase()) throw new MergeError('NOT_FOUND', '병합 제안이 없다');
    return {
      proposalId: p.id,
      primaryAccountId: p.primaryAccountId,
      mergedAccountId: p.absorbedAccountId,
      status: p.status,
      moved: p.moved,
      blockers: p.blockers,
      expiresAt: new Date(p.expiresAt).toISOString(),
      newProvider: p.newProvider,
      requesterRole: p.primaryAccountId === p.requesterAccountId ? 'PRIMARY' : 'MERGED',
      primaryVerified: p.primaryVerified === true,
      ...(p.blockers.includes('SAME_PROVIDER_KIND') && p.sameKindProviders?.length ? { sameKindProviders: p.sameKindProviders } : {}),
    };
  }
}
