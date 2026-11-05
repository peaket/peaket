// 로그인 수단 해제(DELETE /v1/identity/providers/{provider}, SCR-040 ③, identity §2.1 '설정의 로그인 수단 연결·해제의 첫 구현', BUILD_ORDER BOT-041, I-T33·I-T34).
// 재인증 토큰을 한 번 쓰고 계정을 잠근 뒤, 그 종류가 없으면 NOT_FOUND, 마지막 하나면 LAST_LOGIN_METHOD(되돌려 토큰은 쓰지 않은 것이 된다), 아니면 지우고 해제 사건을 적는다.
// 지우면 이 세션 말고 그 계정의 살아 있는 세션을 모두 끝낸다(ASVS 7.4.3, BUILD_ORDER BOT-044, ADR-0209 결정 5).
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { REAUTH_VERIFIER, ReauthRejected, type ReauthVerifier, SESSION_SIGNALS, SESSION_STORE, type SessionSignals, type SessionStore } from '../domain/ports.js';
import { type Provider, sessionAlive, WITHDRAWAL_REAUTH_ACT } from '../domain/session.js';
import { AccountError } from './account-error.js';
import { otherLiveSessions } from './end-other-sessions.js';

@Injectable()
export class UnlinkProvider {
  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    @Inject(REAUTH_VERIFIER) private readonly reauth: ReauthVerifier,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(SESSION_SIGNALS) private readonly signals?: Pick<SessionSignals, 'othersEnded'>,
  ) {}

  /** @throws AccountError REAUTH_REQUIRED·NOT_FOUND·LAST_LOGIN_METHOD */
  async run(i: { accountId: string; sessionId: string; reauthToken: string; provider: Provider }): Promise<void> {
    const accountId = i.accountId.toLowerCase();
    const sessionId = i.sessionId.toLowerCase();
    let token: { jti: string; accountId: string; expiresAt: number };
    try {
      token = await this.reauth.verify(i.reauthToken, { sessionId, act: WITHDRAWAL_REAUTH_ACT });
    } catch (e) {
      if (e instanceof ReauthRejected) throw new AccountError('REAUTH_REQUIRED', e.message);
      throw e;
    }
    if (token.accountId.toLowerCase() !== accountId) throw new AccountError('REAUTH_REQUIRED', '재인증 토큰의 계정이 다르다');
    const now = this.clock.now();
    const ended = await this.store.transaction(async (tx) => {
      // 계정, 세션 차례로 잠근다(로그인·탈퇴와 같은 순서). 해제는 gw-fan이 세션을 보지만, 같은 규칙을 유스케이스에서도 지킨다(추가와 같게)
      await tx.lockAccount(accountId);
      const s = await tx.getSessionForUpdate(sessionId);
      if (!s || s.accountId !== accountId || !sessionAlive(s, now)) throw new AccountError('REAUTH_REQUIRED', '세션이 끝났다');
      if (!(await tx.useReauth({ jti: token.jti, accountId, usedAt: now, expiresAt: token.expiresAt }))) throw new AccountError('REAUTH_REQUIRED', '이미 쓴 재인증 토큰이다');
      if ((await tx.accountStatusOf(accountId)) !== 'ACTIVE') throw new AccountError('REAUTH_REQUIRED', '해제할 수 있는 계정이 아니다');
      const all = await tx.providersOf(accountId);
      if (!all.some((p) => p.provider === i.provider)) throw new AccountError('NOT_FOUND', '그 종류의 로그인 수단이 없다');
      // 마지막 하나는 지우지 않는다(I-T33). 같은 종류가 여럿이어도 종류를 지우면 남는 수단이 없으면 막는다
      if (all.every((p) => p.provider === i.provider)) throw new AccountError('LAST_LOGIN_METHOD', '마지막 로그인 수단이다');
      await tx.unlinkProvider(accountId, i.provider);
      // 인증 요소가 바뀌었다: 이 세션 말고 다른 세션을 끝낸다. 세션 종료 사건을 해제 사건보다 먼저 적는다(둘 다 트랜잭션 끝)
      const others = await otherLiveSessions(tx, accountId, sessionId, now);
      await tx.terminateSessions(others, 'LOGIN_METHOD_CHANGED', now);
      await tx.recordLoginMethodChanged({ accountId, change: 'UNLINKED', provider: i.provider, occurredAt: now });
      return others.length;
    });
    if (ended) this.signals?.othersEnded('login_method_changed', ended);
  }
}
