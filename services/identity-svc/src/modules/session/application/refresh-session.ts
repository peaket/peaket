// 팬 토큰 갱신(docs/features/identity.md §3 '리프레시 토큰 회전'·'응답을 잃은 뒤의 재시도'·'토큰 수명주기 구현', I-T4, RFC 9700 §4.14.2).
// 리프레시 토큰은 해시로만 찾고 저장한다. 판정은 도메인 decideRefresh가 한다(회전·재시도·탈취·무효).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { ACCOUNT_CLAIMS, type AccountClaims, SESSION_SIGNALS, SESSION_STORE, type SessionSignals, type SessionStore, TOKEN_SIGNER, type TokenSigner } from '../domain/ports.js';
import { decideRefresh, fanEndedReason, SESSION_IDLE_MS, sessionAlive } from '../domain/session.js';
import { newRefreshToken, refreshHash } from './create-session.js';

export type RefreshResult =
  | { result: 'OK'; accountId: string; sessionId: string; accessToken: string; accessTokenExpiresAt: number; refreshToken: string; refreshTokenExpiresAt: number }
  /** ended: 끝난 까닭(갱신 401의 ended, ADR-0235 결정 1). 재사용을 찾아낸 응답은 REFRESH_REUSE */
  | { result: 'REUSED'; ended: 'REFRESH_REUSE' }
  | { result: 'INVALID'; ended?: string };

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
    const hash = refreshHash(i.refreshToken);
    // 토큰에 실을 계정 값(본인확인 뒤 첫 갱신부터 ticket:buy·pid, identity §5 '즉시 갱신')은 트랜잭션 앞에서 잠그지 않고 읽는다:
    // 다른 저장소를 읽으므로 세션 줄을 잠근 채 두 번째 연결을 잡지 않는다. 모르는 토큰이면 읽지 않는다
    const owner = await this.store.refreshOwner(hash);
    const claims = owner ? await this.claims.of(owner) : null;
    const r = await this.store.transaction(async (tx) => {
      const s = await tx.findByRefreshHash(hash);
      if (!s) return { kind: 'invalid' as const };
      const decision = decideRefresh({ match: s.match, rotatedAt: s.rotatedAt, refreshUsed: s.refreshUsed, alive: sessionAlive(s, now) }, now);
      // 끝난 세션의 토큰이 왔을 때만 까닭을 싣는다. 유휴·절대 만료는 끝낸 일이 아니므로 싣지 않는다(ADR-0235 결정 1)
      if (decision === 'invalid') return { kind: 'invalid' as const, ended: s.terminatedAt !== null ? fanEndedReason(s.terminatedReason) : undefined };
      // 탈퇴·병합된 계정의 세션이 남아 있으면(로그인과 탈퇴가 겹침) 갱신하지 않고 그 세션을 끝낸다(새 맥락 리뷰 M1)
      const status = await tx.accountStatusOf(s.accountId);
      if (status === 'DELETED' || status === 'MERGED') {
        const reason = status === 'MERGED' ? ('MERGED' as const) : ('DELETE' as const);
        await tx.terminateSessions([s.id], reason, now);
        return { kind: 'invalid' as const, ended: reason };
      }
      if (decision === 'reuse') {
        // 탈취로 본다: 그 패밀리의 모든 활성 세션을 끝내고 종료 사건을 낸다
        await tx.terminateSessions(await tx.familySessions(s.refreshFamily), 'REFRESH_REUSE', now);
        return { kind: 'reuse' as const };
      }
      const idleExpiresAt = Math.min(now + SESSION_IDLE_MS, s.absoluteExpiresAt);
      // 되돌릴 수 없는 쓰기 전에 액세스 토큰부터 서명한다: 서명이 실패하면 트랜잭션이 되돌아가 브라우저의 옛 쿠키가 그대로 지금 토큰이다
      // (커밋 뒤에 서명하면 30초 뒤 같은 쿠키가 탈취로 보여 로그인이 끊긴다, 관리 갱신과 같은 차례, BOT-130이 넘긴 것).
      // 앞에서 읽은 주인과 다르면(그 사이 해시가 다른 세션으로 갔다는 뜻이라 생기지 않는다) 그 계정으로 다시 읽는다
      const c = s.accountId === owner && claims ? claims : await this.claims.of(s.accountId);
      const access = await this.signer.access({ accountId: s.accountId, sessionId: s.id, ...c }, now);
      if (decision === 'rotate') await tx.rotateRefresh(s.id, next.hash, now, idleExpiresAt);
      // 재시도: 먼저 준(받지 못한) 토큰을 새 토큰으로 바꿔 폐기한다. 앞 토큰·회전 시각은 그대로라 유예가 늘지 않는다
      else await tx.setRefreshHash(s.id, next.hash);
      await tx.recordRefreshHash({ hash: next.hash, sessionId: s.id, refreshFamily: s.refreshFamily, issuedAt: now, expiresAt: s.absoluteExpiresAt });
      return { kind: decision, accountId: s.accountId, sessionId: s.id, access, refreshExpiresAt: decision === 'rotate' ? idleExpiresAt : Math.min(s.idleExpiresAt, s.absoluteExpiresAt) };
    });
    if (r.kind === 'invalid') {
      this.signals.refreshed('fan', 'invalid');
      return r.ended ? { result: 'INVALID', ended: r.ended } : { result: 'INVALID' };
    }
    if (r.kind === 'reuse') {
      this.signals.refreshed('fan', 'reused');
      return { result: 'REUSED', ended: 'REFRESH_REUSE' };
    }
    this.signals.refreshed('fan', r.kind === 'rotate' ? 'rotated' : 'retried');
    const { access } = r;
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
