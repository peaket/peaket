// 병합 확정(POST /v1/identity/merge-proposals/{proposalId}/confirmation, identity §2.1 '계정 병합의 첫 구현', BUILD_ORDER BOT-042, I-T32·I-T34, POL-034).
// 재인증(제안한 세션, 한 번) → 대표 계정 다시 고르기(바뀌었으면 NOT_FOUND) → 세 서비스 다시 확인(답이 없으면 UNAVAILABLE) → 막는 사유면 BLOCKED, 불변식 위반이면 INVARIANT →
// 한 트랜잭션: 추가하려던 제공자와 두 계정(ID 순)을 잠그고 둘 다 ACTIVE인지·그 수단이 아직 다른 계정의 것인지·본인확인으로 고른 대표가 그대로인지 → 로그인 수단 이전·MERGED·이메일 지우기·사슬 고치기·account_merge → 흡수 계정 세션 끝내기(MERGED) → 병합 사건.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock, uuidv7 } from '@peaket/platform';
import { MERGE_PROPOSALS, type MergeProposals, MergeCheckUnavailable, REAUTH_VERIFIER, ReauthRejected, type ReauthVerifier, SESSION_STORE, type SessionStore } from '../domain/ports.js';
import { choosePrimary } from '../domain/merge.js';
import { sessionAlive, WITHDRAWAL_REAUTH_ACT } from '../domain/session.js';
import { MergeError } from './merge-error.js';
import { MergePlanner } from './plan-merge.js';

const PROPOSAL_ID = /^[A-Za-z0-9_-]{22}$/;

@Injectable()
export class ConfirmMerge {
  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    @Inject(REAUTH_VERIFIER) private readonly reauth: ReauthVerifier,
    @Inject(MergePlanner) private readonly planner: Pick<MergePlanner, 'assessPair' | 'roles'>,
    @Inject(MERGE_PROPOSALS) private readonly proposals: MergeProposals,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** @throws MergeError NOT_FOUND·REAUTH_REQUIRED·BLOCKED·INVARIANT·UNAVAILABLE */
  async run(i: { accountId: string; sessionId: string; proposalId: string; reauthToken: string }): Promise<{ mergeId: string }> {
    const accountId = i.accountId.toLowerCase();
    const sessionId = i.sessionId.toLowerCase();
    if (!PROPOSAL_ID.test(i.proposalId)) throw new MergeError('NOT_FOUND', '병합 제안이 없다');
    const p = await this.proposals.get(i.proposalId).catch(() => {
      throw new MergeError('UNAVAILABLE', '병합 제안 저장소에 닿지 못했다');
    });
    if (!p || p.requesterAccountId !== accountId || p.requesterSessionId !== sessionId) throw new MergeError('NOT_FOUND', '병합 제안이 없다');
    let token: { jti: string; accountId: string; expiresAt: number };
    try {
      token = await this.reauth.verify(i.reauthToken, { sessionId, act: WITHDRAWAL_REAUTH_ACT });
    } catch (e) {
      if (e instanceof ReauthRejected) throw new MergeError('REAUTH_REQUIRED', e.message);
      throw e;
    }
    if (token.accountId.toLowerCase() !== accountId) throw new MergeError('REAUTH_REQUIRED', '재인증 토큰의 계정이 다르다');
    const other = p.primaryAccountId === accountId ? p.absorbedAccountId : p.primaryAccountId;
    // 확정 직전에 대표 계정을 다시 고르고(그사이 본인확인한 계정이 흡수되지 않게, 새 맥락 리뷰 높음 1) 세 서비스와 identity 사유를 다시 본다
    let plan;
    try {
      const roles = await this.planner.roles({ current: accountId, other });
      if (!roles.bothVerified && roles.primary !== p.primaryAccountId) await this.#stale(p.id, '제안 뒤 본인확인으로 대표 계정이 바뀌었다');
      plan = await this.planner.assessPair(p.primaryAccountId, p.absorbedAccountId, roles.bothVerified);
    } catch (e) {
      if (e instanceof MergeCheckUnavailable) throw new MergeError('UNAVAILABLE', e.message);
      throw e;
    }
    if (plan.invariantViolated) throw new MergeError('INVARIANT', '흡수 계정에 티켓이나 후기가 있다');
    if (plan.blockers.length > 0) {
      // 끝난 계정(탈퇴·병합됨)이 있으면 막는 사유보다 먼저 없는 제안이다(트랜잭션 안의 차례와 같게, 재검토 2026-11-05)
      if (await this.#ended(p.primaryAccountId, p.absorbedAccountId)) await this.#stale(p.id, '병합할 수 있는 계정이 아니다');
      throw new MergeError('BLOCKED', '병합을 막는 사유가 있다', plan.blockers);
    }
    const now = this.clock.now();
    const mergeId = uuidv7(this.clock);
    try {
      await this.store.transaction(async (tx) => {
        // 추가하려던 제공자 계정을 먼저 잠근다(로그인·로그인 수단 추가와 같은 순서: 제공자 → 계정 → 세션)
        await tx.lockProvider(p.newProvider, p.newProviderUserId);
        // 두 계정을 ID 순으로 잠근다(같은 둘을 거꾸로 잡는 병합과 서로 기다리지 않게)
        const [first, second] = [p.primaryAccountId, p.absorbedAccountId].sort();
        await tx.lockAccount(first!);
        await tx.lockAccount(second!);
        const s = await tx.getSessionForUpdate(sessionId);
        if (!s || s.accountId !== accountId || !sessionAlive(s, now)) throw new MergeError('REAUTH_REQUIRED', '세션이 끝났다');
        if (!(await tx.useReauth({ jti: token.jti, accountId, usedAt: now, expiresAt: token.expiresAt }))) throw new MergeError('REAUTH_REQUIRED', '이미 쓴 재인증 토큰이다');
        const statuses = [await tx.accountStatusOf(p.primaryAccountId), await tx.accountStatusOf(p.absorbedAccountId)];
        // 끝난 계정(탈퇴·병합됨)이 있으면 없는 제안이다. 없는 제안(404)은 막는 사유(409)보다 먼저 본다: 다시 와도 이룰 수 없다(재검토 2026-11-05)
        if (statuses.some((x) => x !== 'ACTIVE' && x !== 'WITHDRAWAL_PENDING')) throw new MergeError('NOT_FOUND', '병합할 수 있는 계정이 아니다');
        // 추가하려던 로그인 수단이 아직 다른 계정(제안하지 않은 쪽)의 것이어야 한다(그 제공자로 로그인한 것이 그 계정 쪽 동의다, 새 맥락 리뷰 낮음 12)
        if ((await tx.findAccountByProvider(p.newProvider, p.newProviderUserId))?.id !== other) throw new MergeError('NOT_FOUND', '추가하려던 로그인 수단이 다른 계정에 없다');
        // 잠근 뒤 본인확인 기록으로 대표 계정을 다시 고른다(잠그기 전 확인과 이 사이에 끝난 본인확인, 새 맥락 리뷰 높음 1). 표를 보지 못하는 저장소는 앞의 확인만
        const [mine, theirs] = [await tx.verifiedOf(accountId), await tx.verifiedOf(other)];
        if (mine !== null && theirs !== null) {
          const c = choosePrimary({ current: accountId, other, currentVerified: mine, otherVerified: theirs });
          if (c.bothVerified) throw new MergeError('BLOCKED', '두 계정 모두 본인확인을 마쳤다', ['BOTH_VERIFIED']);
          if (c.primary !== p.primaryAccountId) throw new MergeError('NOT_FOUND', '제안 뒤 본인확인으로 대표 계정이 바뀌었다');
        }
        // 잠근 뒤에 탈퇴 유예에 들어간 계정은 막는 사유다(409, 제안은 남는다, BOT-042가 넘긴 것)
        if (statuses.includes('WITHDRAWAL_PENDING')) throw new MergeError('BLOCKED', '탈퇴 정리 중인 계정이 있다', ['WITHDRAWAL_IN_PROGRESS']);
        const open = await tx.unterminatedSessions(p.absorbedAccountId);
        await tx.mergeAccounts({ mergeId, primaryAccountId: p.primaryAccountId, absorbedAccountId: p.absorbedAccountId, mergedProvider: p.newProvider, moved: { ...plan.moved }, requestedAt: p.createdAt, now });
        // 흡수 계정의 모든 세션을 끝낸다(세션 종료 사건 MERGED), 그다음 마지막 쓰기로 병합 사건
        await tx.terminateSessions(open, 'MERGED', now);
        await tx.recordAccountMerged({ mergeId, primaryAccountId: p.primaryAccountId, mergedAccountId: p.absorbedAccountId, confirmedAt: now });
      });
    } catch (e) {
      // 병합할 수 없게 된 제안은 지운다(다시 추가하면 지금 상태로 새 제안을 만든다)
      if (e instanceof MergeError && e.code === 'NOT_FOUND') await this.#stale(p.id, e.message);
      throw e;
    }
    // 한 번만 쓴다. 지우지 못해도 다시 오면 흡수 계정이 MERGED라 NOT_FOUND다
    await this.proposals.remove(p.id).catch(() => undefined);
    return { mergeId };
  }

  /** 두 계정 가운데 끝난(탈퇴·병합된) 계정이 있는가 */
  #ended(primary: string, absorbed: string): Promise<boolean> {
    return this.store.transaction(async (tx) => [await tx.accountStatusOf(primary), await tx.accountStatusOf(absorbed)].some((x) => x !== 'ACTIVE' && x !== 'WITHDRAWAL_PENDING'));
  }

  /** 제안을 지우고 NOT_FOUND를 던진다 */
  async #stale(id: string, why: string): Promise<never> {
    await this.proposals.remove(id).catch(() => undefined);
    throw new MergeError('NOT_FOUND', why);
  }
}
