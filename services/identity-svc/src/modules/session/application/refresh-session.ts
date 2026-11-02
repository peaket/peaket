// 팬 토큰 갱신(docs/features/identity.md §3 '리프레시 토큰 회전'·'응답을 잃은 뒤의 재시도'·'토큰 수명주기 구현', I-T4, RFC 9700 §4.14.2).
// 리프레시 토큰은 해시로만 찾고 저장한다. 판정은 도메인 decideRefresh가 한다(회전·재시도·탈취·무효).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { ACCOUNT_CLAIMS, type AccountClaims, SESSION_SIGNALS, SESSION_STORE, type SessionSignals, type SessionStore, TOKEN_SIGNER, type TokenSigner } from '../domain/ports.js';
import { decideRefresh, SESSION_IDLE_MS, sessionAlive } from '../domain/session.js';
import { newRefreshToken, refreshHash } from './create-session.js';

export type RefreshResult =
  | { result: 'OK'; accountId: string; sessionId: string; accessToken: string; accessTokenExpiresAt: number; refreshToken: string; refreshTokenExpiresAt: number }
  | { result: 'REUSED' }
  | { result: 'INVALID' };

/** 쿠키 값 모양(256비트 base64url = 43자). 모양이 아니면 DB를 보지 않는다 */
const SHAPE = /^[A-Za-z0-9_-]{43}$/;

@Injectable()
export class RefreshSession {
  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    @Inject(TOKEN_SIGNER) private readonly signer: TokenSigner,
    @Inject(SESSION_SIGNALS) private readonly signals: SessionSignals,
    @Inject(ACCOUNT_CLAIMS) private readonly claims: AccountClaims,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(i: { refreshToken: string }): Promise<RefreshResult> {
    if (!SHAPE.test(i.refreshToken)) {
      this.signals.refreshed('fan', 'invalid');
      return { result: 'INVALID' };
    }
    const now = this.clock.now();
    const next = newRefreshToken();
    const r = await this.store.transaction(async (tx) => {
      const s = await tx.findByRefreshHash(refreshHash(i.refreshToken));
      if (!s) return { kind: 'invalid' as const };
      const decision = decideRefresh({ match: s.match, rotatedAt: s.rotatedAt, refreshUsed: s.refreshUsed, alive: sessionAlive(s, now) }, now);
      if (decision === 'invalid') return { kind: 'invalid' as const };
      if (decision === 'reuse') {
        // 탈취로 본다: 그 패밀리의 모든 활성 세션을 끝내고 종료 사건을 낸다
        await tx.terminateSessions(await tx.familySessions(s.refreshFamily), 'REFRESH_REUSE', now);
        return { kind: 'reuse' as const };
      }
      const idleExpiresAt = Math.min(now + SESSION_IDLE_MS, s.absoluteExpiresAt);
      if (decision === 'rotate') await tx.rotateRefresh(s.id, next.hash, now, idleExpiresAt);
      // 재시도: 먼저 준(받지 못한) 토큰을 새 토큰으로 바꿔 폐기한다. 앞 토큰·회전 시각은 그대로라 유예가 늘지 않는다
      else await tx.setRefreshHash(s.id, next.hash);
      await tx.recordRefreshHash({ hash: next.hash, sessionId: s.id, refreshFamily: s.refreshFamily, issuedAt: now, expiresAt: s.absoluteExpiresAt });
      return { kind: decision, accountId: s.accountId, sessionId: s.id, refreshExpiresAt: decision === 'rotate' ? idleExpiresAt : Math.min(s.idleExpiresAt, s.absoluteExpiresAt) };
    });
    if (r.kind === 'invalid') {
      this.signals.refreshed('fan', 'invalid');
      return { result: 'INVALID' };
    }
    if (r.kind === 'reuse') {
      this.signals.refreshed('fan', 'reused');
      return { result: 'REUSED' };
    }
    this.signals.refreshed('fan', r.kind === 'rotate' ? 'rotated' : 'retried');
    // 본인확인 뒤 첫 갱신부터 ticket:buy·pid가 실린다(identity §5 '즉시 갱신')
    const access = await this.signer.access({ accountId: r.accountId, sessionId: r.sessionId, ...(await this.claims.of(r.accountId)) }, now);
    return {
      result: 'OK',
      accountId: r.accountId,
      sessionId: r.sessionId,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: next.token,
      refreshTokenExpiresAt: r.refreshExpiresAt,
    };
  }
}
