// 계정 설정의 로그인 수단 추가(SCR-040 ②, SessionService.AddProvider, identity §2.1 '설정의 로그인 수단 연결·해제의 첫 구현', BUILD_ORDER BOT-041, I-T34).
// 재인증 토큰(같은 세션·FAN_SENSITIVE)을 한 번 쓰고, 계정을 잠근 뒤 새 제공자 (제공자, sub)를 이 계정에 잇는다. 결과는 오류가 아니라 값으로 돌려준다.
// 이었으면(LINKED) 이 세션 말고 그 계정의 살아 있는 세션을 모두 끝낸다(ASVS 7.4.3, BUILD_ORDER BOT-044, ADR-0209 결정 5).
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { REAUTH_VERIFIER, ReauthRejected, type ReauthVerifier, SESSION_SIGNALS, SESSION_STORE, type SessionSignals, type SessionStore } from '../domain/ports.js';
import { type Provider, sessionAlive, WITHDRAWAL_REAUTH_ACT } from '../domain/session.js';
import { otherLiveSessions } from './end-other-sessions.js';
import { MergePlanner } from './plan-merge.js';

export type AddProviderResult = 'LINKED' | 'ALREADY_LINKED' | 'PROVIDER_TYPE_TAKEN' | 'OTHER_ACCOUNT' | 'REAUTH_REQUIRED';

export interface AddProviderInput {
  accountId: string;
  sessionId: string;
  reauthToken: string;
  provider: Provider;
  providerUserId: string;
}

@Injectable()
export class AddProvider {
  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    @Inject(REAUTH_VERIFIER) private readonly reauth: ReauthVerifier,
    @Inject(CLOCK) private readonly clock: Clock,
    /** 다른 계정이면 병합 제안을 만든다(BOT-042). 없으면 OTHER_ACCOUNT만(시험) */
    @Optional() @Inject(MergePlanner) private readonly planner?: Pick<MergePlanner, 'plan'>,
    @Optional() @Inject(SESSION_SIGNALS) private readonly signals?: Pick<SessionSignals, 'othersEnded'>,
  ) {}

  async run(i: AddProviderInput): Promise<AddProviderResult> {
    return (await this.#add(i)).result;
  }

  /** 결과와, 다른 계정이면 병합 제안 ID(만들 수 있었으면, identity §2.1 '계정 병합의 첫 구현') */
  async add(i: AddProviderInput): Promise<{ result: AddProviderResult; mergeProposalId?: string }> {
    const r = await this.#add(i);
    if (r.result !== 'OTHER_ACCOUNT' || !this.planner || !r.otherAccountId) return { result: r.result };
    const id = await this.planner.plan({ requesterAccountId: i.accountId.toLowerCase(), requesterSessionId: i.sessionId.toLowerCase(), otherAccountId: r.otherAccountId, newProvider: i.provider, newProviderUserId: i.providerUserId });
    return id ? { result: 'OTHER_ACCOUNT', mergeProposalId: id } : { result: 'OTHER_ACCOUNT' };
  }

  async #add(i: AddProviderInput): Promise<{ result: AddProviderResult; otherAccountId?: string }> {
    const accountId = i.accountId.toLowerCase();
    const sessionId = i.sessionId.toLowerCase();
    if (!i.providerUserId || i.providerUserId.length > 255) return { result: 'REAUTH_REQUIRED' };
    let token: { jti: string; accountId: string; expiresAt: number };
    try {
      token = await this.reauth.verify(i.reauthToken, { sessionId, act: WITHDRAWAL_REAUTH_ACT });
    } catch (e) {
      if (e instanceof ReauthRejected) return { result: 'REAUTH_REQUIRED' };
      throw e;
    }
    if (token.accountId.toLowerCase() !== accountId) return { result: 'REAUTH_REQUIRED' };
    const now = this.clock.now();
    let ended = 0;
    const out = await this.store.transaction(async (tx): Promise<{ result: AddProviderResult; otherAccountId?: string }> => {
      // 같은 제공자 계정의 로그인·연결과 겹치지 않게 제공자, 계정, 세션 차례로 잠근다(CreateSession·탈퇴와 같은 순서, 다시 검토 낮음)
      await tx.lockProvider(i.provider, i.providerUserId);
      await tx.lockAccount(accountId);
      // 재인증 토큰을 준 세션이 아직 살아 있어야 한다(다른 기기에서 그 세션을 끝냈으면 막는다). 앱 서버 gRPC라 게이트웨이의 세션 확인을 거치지 않는다(새 맥락 리뷰 중간 1)
      const s = await tx.getSessionForUpdate(sessionId);
      if (!s || s.accountId !== accountId || !sessionAlive(s, now)) return { result: 'REAUTH_REQUIRED' };
      if ((await tx.accountStatusOf(accountId)) !== 'ACTIVE') return { result: 'REAUTH_REQUIRED' };
      if (!(await tx.useReauth({ jti: token.jti, accountId, usedAt: now, expiresAt: token.expiresAt }))) return { result: 'REAUTH_REQUIRED' };
      const owner = await tx.findAccountByProvider(i.provider, i.providerUserId);
      if (owner?.id === accountId) return { result: 'ALREADY_LINKED' };
      // 같은 종류가 이미 있으면 다른 계정의 것이어도 잇거나 합치지 않는다(종류마다 하나 [가정], 병합이 같은 종류를 둘로 만들지 않게, 새 맥락 리뷰 중간 3)
      if ((await tx.providersOf(accountId)).some((p) => p.provider === i.provider)) return { result: 'PROVIDER_TYPE_TAKEN' };
      if (owner) return { result: 'OTHER_ACCOUNT', otherAccountId: owner.id };
      await tx.linkProvider(accountId, i.provider, i.providerUserId, now);
      // 인증 요소가 바뀌었다: 이 세션 말고 다른 세션을 끝낸다. 세션 종료 사건을 연결 사건보다 먼저 적는다(둘 다 트랜잭션 끝)
      const others = await otherLiveSessions(tx, accountId, sessionId, now);
      await tx.terminateSessions(others, 'LOGIN_METHOD_CHANGED', now);
      ended = others.length;
      await tx.recordLoginMethodChanged({ accountId, change: 'LINKED', provider: i.provider, occurredAt: now });
      return { result: 'LINKED' };
    });
    if (ended) this.signals?.othersEnded('login_method_changed', ended);
    return out;
  }
}
