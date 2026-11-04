// 관리 계정 토큰 갱신(openapi POST /v1/partner/auth/access-tokens·/v1/ops/auth/access-tokens, docs/features/identity.md §6 '관리 계정 토큰 갱신과 로그아웃의 첫 구현', BUILD_ORDER BOT-130, I-T46).
// 팬 갱신(RefreshSession)과 같은 회전·30초 재시도 유예·재사용 탐지(decideRefresh)를 관리 세션 표에 쓴다. 리프레시 토큰은 해시로만 찾고 저장한다.
// 유휴 만료만 늘리고 절대 만료는 넘기지 않는다. 비밀번호 바꾸기 필요 계정이면 scope password:change를 다시 붙인다(auth-controls §3.5).
import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock, PASSWORD_CHANGE_SCOPE } from '@peaket/platform';
import { decideRefresh, sessionAlive } from '../../session/index.js';
import { ADMIN_LOGIN_SIGNALS, ADMIN_REFRESH_STORE, ADMIN_TOKEN_SIGNER, type AdminAud, type AdminLoginSignals, type AdminRefreshStore, type AdminTokenSigner, ROLES_OF_AUD } from '../domain/ports.js';
import { ADMIN_SESSION_IDLE_MS } from './login-second-step.js';

export type AdminRefreshResult =
  | { result: 'OK'; sessionId: string; accessToken: string; refreshToken: string; absoluteExpiresAt: number }
  | { result: 'REUSED' }
  | { result: 'INVALID' };

/** 쿠키 값 모양(32바이트 base64url = 43자). 모양이 아니면 DB를 보지 않는다 */
const SHAPE = /^[A-Za-z0-9_-]{43}$/;
const sha256 = (t: string): Buffer => createHash('sha256').update(t).digest();

@Injectable()
export class RefreshAdminSession {
  constructor(
    @Inject(ADMIN_REFRESH_STORE) private readonly store: AdminRefreshStore,
    @Inject(ADMIN_TOKEN_SIGNER) private readonly signer: AdminTokenSigner,
    @Inject(ADMIN_LOGIN_SIGNALS) private readonly signals: AdminLoginSignals,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(i: { aud: AdminAud; refreshToken: string }): Promise<AdminRefreshResult> {
    if (!SHAPE.test(i.refreshToken)) return this.#invalid(i.aud);
    const now = this.clock.now();
    const nextToken = randomBytes(32).toString('base64url');
    const nextHash = sha256(nextToken);
    const r = await this.store.refreshTransaction(async (tx) => {
      const s = await tx.findByRefreshHash(sha256(i.refreshToken));
      // 다른 콘솔의 세션이면 없는 것으로 본다(그 세션은 끝내지 않는다)
      if (!s || s.aud !== i.aud) return { kind: 'invalid' as const };
      const decision = decideRefresh({ match: s.match, rotatedAt: s.rotatedAt, refreshUsed: s.refreshUsed, alive: sessionAlive(s, now) }, now);
      if (decision === 'invalid') return { kind: 'invalid' as const };
      // 지운 계정이면 그 세션을 끝내고(DELETE), 그 밖에 활성이 아니면(재초대 대기 등) 갱신만 하지 않는다(세션은 재초대 쪽이 끝낸다).
      // 그 콘솔의 역할이 아니면 끝낸다(ROLE_CHANGED). 보호 잠금 중인 계정의 열린 세션은 이어진다(auth-controls §3.2)
      const account = await tx.accountOf(s.accountId);
      if (!account || account.status === 'REMOVED') {
        await tx.terminateSessions([s.id], 'DELETE', now);
        return { kind: 'invalid' as const };
      }
      if (account.status !== 'ACTIVE') return { kind: 'invalid' as const };
      if (!ROLES_OF_AUD[s.aud].includes(account.role)) {
        await tx.terminateSessions([s.id], 'ROLE_CHANGED', now);
        return { kind: 'invalid' as const };
      }
      // 계정 상태를 본 뒤에 탈취를 가른다(팬 갱신과 같은 차례: 지운 계정의 옛 토큰은 DELETE로 끝나고 재사용 지표를 올리지 않는다)
      if (decision === 'reuse') {
        // 탈취로 본다: 그 패밀리의 끝나지 않은 세션을 모두 끝내고 종료 사건을 낸다
        await tx.terminateSessions(await tx.familySessions(s.refreshFamily), 'REFRESH_REUSE', now);
        return { kind: 'reuse' as const };
      }
      // 되돌릴 수 없는 쓰기 전에 액세스 토큰부터 서명한다: 서명이 실패하면 트랜잭션이 되돌아가 브라우저의 옛 쿠키가 그대로 지금 토큰이다
      // (커밋 뒤에 서명하면 30초 뒤 같은 쿠키가 탈취로 보여 로그인이 끊긴다, 재검토 2026-11-05. 로그인 2단계와 같은 차례)
      const at = await this.signer.access({ accountId: s.accountId, sessionId: s.id, aud: i.aud, ...(account.passwordChangeRequired ? { scopes: [PASSWORD_CHANGE_SCOPE] } : {}) }, now);
      if (decision === 'rotate') await tx.rotateRefresh(s.id, nextHash, now, Math.min(now + ADMIN_SESSION_IDLE_MS, s.absoluteExpiresAt));
      // 재시도: 먼저 준(받지 못한) 토큰을 새 토큰으로 바꿔 폐기한다. 앞 토큰·회전 시각은 그대로라 유예가 늘지 않는다
      else await tx.setRefreshHash(s.id, nextHash);
      await tx.recordRefreshHash({ hash: nextHash, sessionId: s.id, refreshFamily: s.refreshFamily, issuedAt: now, expiresAt: s.absoluteExpiresAt });
      return { kind: decision, sessionId: s.id, absoluteExpiresAt: s.absoluteExpiresAt, accessToken: at.token };
    });
    if (r.kind === 'invalid') return this.#invalid(i.aud);
    if (r.kind === 'reuse') {
      this.signals.refreshed?.(i.aud, 'reused');
      return { result: 'REUSED' };
    }
    this.signals.refreshed?.(i.aud, r.kind === 'rotate' ? 'rotated' : 'retried');
    return { result: 'OK', sessionId: r.sessionId, accessToken: r.accessToken, refreshToken: nextToken, absoluteExpiresAt: r.absoluteExpiresAt };
  }

  #invalid(aud: AdminAud): AdminRefreshResult {
    this.signals.refreshed?.(aud, 'invalid');
    return { result: 'INVALID' };
  }
}
