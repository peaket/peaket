// 관리 재인증 토큰 확인(typ reauth+jwt, 관리 키 셋, docs/features/identity.md §6 '관리 계정 패스키의 첫 구현', BUILD_ORDER BOT-122).
// identity가 직접 받는 작업 묶음(ACCOUNT_SECURITY: 내 패스키 등록·지우기)에 쓴다. 공용 확인기(packages/platform TokenVerifier)에 이 서비스의 공개키 묶음을 그대로 넘긴다.
// 서명(ES256)·typ·iss·aud(그 콘솔)·exp·세션(sid)·작업 묶음(act)을 본다. 한 번 쓰기(jti)와 factors 판정은 부르는 유스케이스가 저장소로 본다.
import type { JSONWebKeySet } from 'jose';
import { type Clock, TokenRejected, TokenVerifier } from '@peaket/platform';
import type { ReauthAct } from '../domain/passkey.js';
import { type AdminAud, AdminReauthRejected, type AdminReauthVerifier } from '../domain/ports.js';

export class JoseAdminReauthVerifier implements AdminReauthVerifier {
  readonly #verifier: TokenVerifier;

  constructor(keys: { jwks(set: 'admin', now: number): { keys: object[] } }, issuer: string, clock: Clock) {
    this.#verifier = new TokenVerifier({ issuer, jwks: () => keys.jwks('admin', clock.now()) as JSONWebKeySet, clock });
  }

  async verify(token: string, o: { aud: AdminAud; sessionId: string; act: ReauthAct }): Promise<{ jti: string; accountId: string; factors: string[] }> {
    if (!token) throw new AdminReauthRejected('missing');
    try {
      const v = await this.#verifier.verifyReauth(token, { keySet: 'admin', audience: o.aud, sessionId: o.sessionId, act: o.act });
      return { jti: v.jti, accountId: v.accountId, factors: v.factors ?? [] };
    } catch (e) {
      if (e instanceof TokenRejected) throw new AdminReauthRejected(e.reason);
      throw e;
    }
  }
}
