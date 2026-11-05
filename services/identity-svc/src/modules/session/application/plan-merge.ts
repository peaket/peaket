// 병합 제안 만들기와 확인(identity §2.1 '계정 병합의 첫 구현', BUILD_ORDER BOT-042, I-T31, POL-034).
// 대표 계정을 고르고 identity 사유(BOTH_VERIFIED·WITHDRAWAL_IN_PROGRESS·APPEAL_PENDING·SAME_PROVIDER_KIND)와 세 서비스의 CheckAccountMerge를 함께 본다.
// 세 서비스 가운데 하나라도 답하지 않으면 MergeCheckUnavailable(제안을 만들지 않는다, 확정은 503).
import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { choosePrimary, MERGE_PROPOSAL_TTL_MS, type MergeBlocker, sharedProviderKinds, type StoredMergeProposal, summarize } from '../domain/merge.js';
import {
  ACCOUNT_ERASER,
  type AccountEraser,
  MERGE_CHECKERS,
  MERGE_PROPOSALS,
  type MergeChecker,
  MergeCheckUnavailable,
  type MergeProposals,
  SESSION_SIGNALS,
  SESSION_STORE,
  type SessionSignals,
  type SessionStore,
} from '../domain/ports.js';
import type { Provider } from '../domain/session.js';

export interface MergePlan extends Pick<StoredMergeProposal, 'primaryAccountId' | 'absorbedAccountId' | 'status' | 'blockers' | 'sameKindProviders' | 'invariantViolated' | 'moved'> {}

@Injectable()
export class MergePlanner {
  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    @Inject(ACCOUNT_ERASER) private readonly verifications: Pick<AccountEraser, 'pidsOf'>,
    @Inject(MERGE_CHECKERS) private readonly checkers: readonly MergeChecker[],
    @Inject(MERGE_PROPOSALS) private readonly proposals: MergeProposals,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: PlatformLogger,
    @Optional() @Inject(SESSION_SIGNALS) private readonly signals?: Pick<SessionSignals, 'mergeInvariantViolated'>,
  ) {}

  /** 지금 본인확인 상태로 고른 대표·흡수 계정(제안 만들기와 확정 직전에 같은 규칙) */
  async roles(i: { current: string; other: string }): Promise<{ primary: string; absorbed: string; bothVerified: boolean; primaryVerified: boolean }> {
    const [currentVerified, otherVerified] = await Promise.all([this.verifications.pidsOf(i.current), this.verifications.pidsOf(i.other)]).then((r) => r.map((x) => x.length > 0));
    const c = choosePrimary({ current: i.current, other: i.other, currentVerified: currentVerified!, otherVerified: otherVerified! });
    return { ...c, primaryVerified: c.primary === i.current ? currentVerified! : otherVerified! };
  }

  /** 대표·흡수 계정과 막는 사유·요약. @throws MergeCheckUnavailable 세 서비스 가운데 하나라도 답하지 않음 */
  async assess(i: { current: string; other: string }): Promise<MergePlan & { primaryVerified: boolean }> {
    const { primary, absorbed, bothVerified, primaryVerified } = await this.roles(i);
    return { ...(await this.assessPair(primary, absorbed, bothVerified)), primaryVerified };
  }

  /** 정해진 대표·흡수 계정으로 다시 본다(확정 직전) */
  async assessPair(primary: string, absorbed: string, bothVerified?: boolean): Promise<MergePlan> {
    const both = bothVerified ?? (await Promise.all([this.verifications.pidsOf(primary), this.verifications.pidsOf(absorbed)])).every((x) => x.length > 0);
    const facts = await this.store.transaction(async (tx) => ({
      status: await tx.accountStatusOf(absorbed),
      primaryStatus: await tx.accountStatusOf(primary),
      holds: await tx.openHoldsOf(absorbed),
      providers: (await tx.providersOf(absorbed)).map((p) => p.provider),
      primaryProviders: (await tx.providersOf(primary)).map((p) => p.provider),
    }));
    const identityBlockers: MergeBlocker[] = [];
    if (both) identityBlockers.push('BOTH_VERIFIED');
    // 대표 계정이 탈퇴 유예 중이어도 막는다(곧 지워질 계정에 옮기지 않는다, identity §2.1, BOT-042가 넘긴 것)
    if (facts.status === 'WITHDRAWAL_PENDING' || facts.primaryStatus === 'WITHDRAWAL_PENDING') identityBlockers.push('WITHDRAWAL_IN_PROGRESS');
    if (facts.holds > 0) identityBlockers.push('APPEAL_PENDING');
    // 두 계정에 같은 종류의 로그인 수단이 함께 있으면 막는다(소유자 결정 2026-11-05, OPEN[21] 추천 적용). 추가하려던 종류는 로그인 수단 추가가
    // 지금 계정에 그 종류가 없을 때만 제안하므로(PROVIDER_TYPE_TAKEN) 처음에는 겹치지 않는다
    const same = sharedProviderKinds(facts.primaryProviders, facts.providers);
    if (same.length > 0) identityBlockers.push('SAME_PROVIDER_KIND');
    // 세 서비스를 함께 부른다(각 1초 기한은 어댑터가 건다). 하나라도 답하지 않으면 그 오류를 던진다
    const checks = await Promise.all(this.checkers.map((c) => c.check({ primaryAccountId: primary, absorbedAccountId: absorbed })));
    const s = summarize({ checks, identityBlockers, absorbedProviders: facts.providers.length });
    if (s.invariantViolated) {
      this.logger?.error({ primaryAccountId: primary, absorbedAccountId: absorbed }, '병합 불변식 위반: 흡수 계정에 티켓이나 후기가 있다(SEV3)');
      this.signals?.mergeInvariantViolated();
    }
    return { primaryAccountId: primary, absorbedAccountId: absorbed, ...s, ...(same.length > 0 ? { sameKindProviders: same } : {}) };
  }

  /** 병합 제안을 만들어 저장하고 ID를 돌려준다. 세 서비스가 답하지 않거나 저장소에 닿지 못하면 null(로그인 수단 추가는 OTHER_ACCOUNT만) */
  async plan(i: { requesterAccountId: string; requesterSessionId: string; otherAccountId: string; newProvider: Provider; newProviderUserId: string }): Promise<string | null> {
    let p: MergePlan & { primaryVerified: boolean };
    try {
      p = await this.assess({ current: i.requesterAccountId, other: i.otherAccountId });
    } catch (e) {
      // 로그인 수단 추가는 이미 끝났다(재인증 토큰을 썼다). 무엇이 실패해도 OTHER_ACCOUNT만 돌려주게 던지지 않는다(새 맥락 리뷰 낮음 10)
      if (e instanceof MergeCheckUnavailable) this.logger?.warn({ service: e.service }, '병합 제안을 만들지 못했다(CheckAccountMerge가 답하지 않음)');
      else this.logger?.error({ err: e }, '병합 제안을 만들지 못했다');
      return null;
    }
    const now = this.clock.now();
    const id = randomBytes(16).toString('base64url');
    try {
      await this.proposals.save({ id, requesterAccountId: i.requesterAccountId, requesterSessionId: i.requesterSessionId, newProvider: i.newProvider, newProviderUserId: i.newProviderUserId, ...p, createdAt: now, expiresAt: now + MERGE_PROPOSAL_TTL_MS });
    } catch {
      return null;
    }
    return id;
  }
}
