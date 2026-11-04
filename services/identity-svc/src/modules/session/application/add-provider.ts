// 계정 설정의 로그인 수단 추가(SCR-040 ②, SessionService.AddProvider, identity §2.1 '설정의 로그인 수단 연결·해제의 첫 구현', BUILD_ORDER BOT-041, I-T34).
// 재인증 토큰(같은 세션·FAN_SENSITIVE)을 한 번 쓰고, 계정을 잠근 뒤 새 제공자 (제공자, sub)를 이 계정에 잇는다. 결과는 오류가 아니라 값으로 돌려준다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { REAUTH_VERIFIER, ReauthRejected, type ReauthVerifier, SESSION_STORE, type SessionStore } from '../domain/ports.js';
import { type Provider, sessionAlive, WITHDRAWAL_REAUTH_ACT } from '../domain/session.js';

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
  ) {}

  async run(i: AddProviderInput): Promise<AddProviderResult> {
    const accountId = i.accountId.toLowerCase();
    const sessionId = i.sessionId.toLowerCase();
    if (!i.providerUserId || i.providerUserId.length > 255) return 'REAUTH_REQUIRED';
    let token: { jti: string; accountId: string; expiresAt: number };
    try {
      token = await this.reauth.verify(i.reauthToken, { sessionId, act: WITHDRAWAL_REAUTH_ACT });
    } catch (e) {
      if (e instanceof ReauthRejected) return 'REAUTH_REQUIRED';
      throw e;
    }
    if (token.accountId.toLowerCase() !== accountId) return 'REAUTH_REQUIRED';
    const now = this.clock.now();
    return this.store.transaction(async (tx) => {
      // 같은 제공자 계정의 로그인·연결과 겹치지 않게 제공자, 계정, 세션 차례로 잠근다(CreateSession·탈퇴와 같은 순서, 다시 검토 낮음)
      await tx.lockProvider(i.provider, i.providerUserId);
      await tx.lockAccount(accountId);
      // 재인증 토큰을 준 세션이 아직 살아 있어야 한다(다른 기기에서 그 세션을 끝냈으면 막는다). 앱 서버 gRPC라 게이트웨이의 세션 확인을 거치지 않는다(새 맥락 리뷰 중간 1)
      const s = await tx.getSessionForUpdate(sessionId);
      if (!s || s.accountId !== accountId || !sessionAlive(s, now)) return 'REAUTH_REQUIRED';
      if ((await tx.accountStatusOf(accountId)) !== 'ACTIVE') return 'REAUTH_REQUIRED';
      if (!(await tx.useReauth({ jti: token.jti, accountId, usedAt: now, expiresAt: token.expiresAt }))) return 'REAUTH_REQUIRED';
      const owner = await tx.findAccountByProvider(i.provider, i.providerUserId);
      if (owner) return owner.id === accountId ? 'ALREADY_LINKED' : 'OTHER_ACCOUNT';
      if ((await tx.providersOf(accountId)).some((p) => p.provider === i.provider)) return 'PROVIDER_TYPE_TAKEN';
      await tx.linkProvider(accountId, i.provider, i.providerUserId, now);
      await tx.recordLoginMethodChanged({ accountId, change: 'LINKED', provider: i.provider, occurredAt: now });
      return 'LINKED';
    });
  }
}
