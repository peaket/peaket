// 다른 기기 로그아웃(openapi DELETE /v1/identity/sessions/{sessionId}, docs/features/identity.md §8 '로그인한 기기와 다른 세션 끝내기의 첫 구현', BUILD_ORDER BOT-044,
// ADR-0209 결정 4, I-T74, FR-017, POL-019). 재인증 토큰(같은 세션·FAN_SENSITIVE)을 확인하고, 계정을 잠근 뒤 대상 세션과 같은 기기의 살아 있는 세션을 모두 끝낸다(LOGOUT).
// 지금 기기 줄이면 지금 세션만 남기고 같은 기기의 다른 로그인을 끝낸다(새 맥락 리뷰 중간 1). 다른 계정·끝난 세션·없는 ID·끝낼 다른 로그인이 없는 지금 기기는
// 같은 SESSION_NOT_FOUND이고, 트랜잭션을 되돌려 재인증 토큰을 쓰지 않은 것으로 둔다. 대상은 그 계정의 살아 있는 세션 안에서만 찾는다(남의 세션 행을 잠그지 않는다, 새 맥락 리뷰 낮음 4).
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { REAUTH_VERIFIER, ReauthRejected, type ReauthVerifier, SESSION_SIGNALS, SESSION_STORE, type SessionSignals, type SessionStore } from '../domain/ports.js';
import { sessionsToEnd, WITHDRAWAL_REAUTH_ACT } from '../domain/session.js';
import { AccountError } from './account-error.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class EndDeviceSession {
  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    @Inject(REAUTH_VERIFIER) private readonly reauth: ReauthVerifier,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(SESSION_SIGNALS) private readonly signals?: Pick<SessionSignals, 'othersEnded'>,
  ) {}

  /** @throws AccountError REAUTH_REQUIRED·SESSION_NOT_FOUND */
  async run(i: { accountId: string; sessionId: string; reauthToken: string; targetSessionId: string }): Promise<{ ended: number }> {
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
    // 재인증을 확인한 뒤에야 대상을 본다(재인증 없이 세션 ID를 떠보지 못하게). 모양이 틀린 ID도 같은 404다
    if (!UUID.test(i.targetSessionId)) throw new AccountError('SESSION_NOT_FOUND', '세션 ID 모양이 아니다');
    const target = i.targetSessionId.toLowerCase();
    const now = this.clock.now();
    const ended = await this.store.transaction(async (tx) => {
      // 계정, 세션 차례로 잠근다(로그인·탈퇴·로그인 수단 바꾸기와 같은 순서, docs/data.md §5). 세션은 그 계정의 살아 있는 것만 잠근다
      await tx.lockAccount(accountId);
      const active = await tx.activeSessions(accountId, now);
      if (!active.some((s) => s.sessionId === sessionId)) throw new AccountError('REAUTH_REQUIRED', '세션이 끝났다');
      const status = await tx.accountStatusOf(accountId);
      if (status !== 'ACTIVE' && status !== 'WITHDRAWAL_PENDING') throw new AccountError('REAUTH_REQUIRED', '로그아웃할 수 있는 계정이 아니다');
      if (!(await tx.useReauth({ jti: token.jti, accountId, usedAt: now, expiresAt: token.expiresAt }))) throw new AccountError('REAUTH_REQUIRED', '이미 쓴 재인증 토큰이다');
      // 지금 세션은 끝내지 않는다: 지금 기기 줄이면 같은 기기의 다른 로그인만 끝낸다. 지금 세션 자체는 화면의 로그아웃(앱 서버 POST /logout)으로 끝낸다
      const ids = sessionsToEnd(active, target, sessionId);
      if (!ids || ids.length === 0) throw new AccountError('SESSION_NOT_FOUND', '이 계정의 살아 있는 다른 세션이 아니다');
      await tx.terminateSessions(ids, 'LOGOUT', now);
      return ids.length;
    });
    this.signals?.othersEnded('remote_logout', ended);
    return { ended };
  }
}
