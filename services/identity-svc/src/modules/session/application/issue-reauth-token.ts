// IssueReauthToken(docs/features/identity.md §7.1, I-T54, ASVS v5.0.0-6.8.4): 앱 서버가 제공자 재인증과 강도 판정을 마친 뒤 부른다.
// 세션이 살아 있고 그 계정의 세션이며 (제공자, provider_user_id)가 그 계정에 연결돼 있을 때만 재인증 토큰(5분, 강도를 싣는다)을 준다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { REVERIFICATIONS, type Reverifications, SESSION_SIGNALS, SESSION_STORE, type SessionSignals, type SessionStore, TOKEN_SIGNER, type TokenSigner } from '../domain/ports.js';
import { needsReverification, type Provider, type ReauthPurpose, type ReauthStrength, REVERIFY_WINDOW_MS, sessionAlive } from '../domain/session.js';
import { checkIds } from './end-session.js';
import { SessionError } from './session-error.js';

export type IssueReauthResult = { result: 'ISSUED'; token: string; expiresAt: number } | { result: 'ACCOUNT_MISMATCH' } | { result: 'REVERIFY_REQUIRED' };

@Injectable()
export class IssueReauthToken {
  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    @Inject(TOKEN_SIGNER) private readonly signer: TokenSigner,
    @Inject(SESSION_SIGNALS) private readonly signals: SessionSignals,
    @Inject(REVERIFICATIONS) private readonly reverifications: Reverifications,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(i: { sessionId: string; accountId: string; provider: Provider; providerUserId: string; strength: ReauthStrength; purpose: ReauthPurpose }): Promise<IssueReauthResult> {
    checkIds(i.sessionId, i.accountId);
    if (!i.providerUserId || i.providerUserId.length > 255) throw new SessionError('INVALID_ARGUMENT', 'provider_user_id가 없거나 255자를 넘는다');
    const now = this.clock.now();
    const { linked, verdict } = await this.store.transaction(async (tx) => {
      const s = await tx.getSessionForUpdate(i.sessionId);
      if (!s || s.accountId !== i.accountId.toLowerCase() || !sessionAlive(s, now)) {
        throw new SessionError('FAILED_PRECONDITION', '살아 있는 그 계정의 세션이 아니다');
      }
      return { linked: await tx.isProviderLinked(s.accountId, i.provider, i.providerUserId), verdict: s.loginVerdict };
    });
    if (!linked) {
      this.signals.reauthMismatch(i.provider);
      return { result: 'ACCOUNT_MISMATCH' };
    }
    // 재통과가 필요한 경우에도 같은 세션의 REVERIFY가 10분 [가정] 안에 확정됐으면 준다(identity §5 '키 판·만 14세…', I-T55 ④)
    if (needsReverification(i.purpose, i.strength, verdict) && !(await this.reverifications.recentlyReverified(i.accountId.toLowerCase(), i.sessionId.toLowerCase(), now - REVERIFY_WINDOW_MS))) {
      this.signals.reverifyRequired(i.provider);
      return { result: 'REVERIFY_REQUIRED' };
    }
    const t = await this.signer.reauth(
      { accountId: i.accountId.toLowerCase(), sessionId: i.sessionId.toLowerCase(), provider: i.provider, strength: i.strength, purpose: i.purpose },
      now,
    );
    this.signals.reauthIssued(i.provider, i.strength);
    return { result: 'ISSUED', token: t.token, expiresAt: t.expiresAt };
  }
}
