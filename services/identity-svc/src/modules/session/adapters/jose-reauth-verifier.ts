// 재인증 토큰 확인(typ reauth+jwt, docs/features/identity.md §3 '재인증 토큰의 묶음'·§8 '탈퇴의 첫 구현', docs/api/guidelines.md 재인증 토큰).
// identity가 직접 받는 팬 민감 작업(탈퇴)에 쓴다. 공용 확인기(packages/platform TokenVerifier)에 이 서비스의 공개키 묶음을 그대로 넘긴다.
// 서명(ES256)·typ·iss·aud(fan)·exp·세션(sid)·작업 묶음(act)을 본다. 한 번 쓰기(jti)는 부르는 유스케이스가 저장소로 본다.
import type { JSONWebKeySet } from 'jose';
import { type Clock, TokenRejected, TokenVerifier } from '@peaket/platform';
import type { PublicKeys, ReauthVerifier } from '../domain/ports.js';
import { ReauthRejected } from '../domain/ports.js';
import { REAUTH_TOKEN_TTL_MS } from '../domain/session.js';

export class JoseReauthVerifier implements ReauthVerifier {
  readonly #verifier: TokenVerifier;
  readonly #clock: Clock;

  constructor(keys: PublicKeys, issuer: string, clock: Clock) {
    this.#clock = clock;
    this.#verifier = new TokenVerifier({ issuer, jwks: (set) => keys.jwks(set, clock.now()) as JSONWebKeySet, clock });
  }

  async verify(token: string, o: { sessionId: string; act: string }): Promise<{ jti: string; accountId: string; expiresAt: number }> {
    if (!token) throw new ReauthRejected('missing');
    try {
      const v = await this.#verifier.verifyReauth(token, { keySet: 'fan', audience: 'fan', sessionId: o.sessionId, act: o.act });
      // 토큰 만료는 확인기가 본다. 사용 기록은 토큰 수명만큼만 남기면 된다
      const exp = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as { exp?: unknown };
      const expiresAt = typeof exp.exp === 'number' ? exp.exp * 1000 : this.#clock.now() + REAUTH_TOKEN_TTL_MS;
      return { jti: v.jti, accountId: v.accountId, expiresAt };
    } catch (e) {
      if (e instanceof TokenRejected) throw new ReauthRejected(e.message);
      throw e;
    }
  }
}
