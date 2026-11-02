// 팬 토큰 키(ES256) 서명 어댑터(docs/features/identity.md §3·§7.1, ADR-0011·0050).
// 지금은 설정값의 JWK 하나다. 키 셋(팬·관리·현장 스태프)·회전·공개키 배포와 iss 확정은 BUILD_ORDER PRF-030(identity §2 '첫 구현').
import { randomUUID } from 'node:crypto';
import { importJWK, type JWK, SignJWT } from 'jose';
import type { SignedToken, TokenSigner } from '../domain/ports.js';
import { ACCESS_TOKEN_TTL_MS, FAN_REAUTH_ACT, REAUTH_TOKEN_TTL_MS, type ReauthPurpose } from '../domain/session.js';

export const FAN_TOKEN_KEY_ENV = 'PEAKET_FAN_TOKEN_KEY';
export const TOKEN_ISSUER_ENV = 'PEAKET_TOKEN_ISSUER';

const seconds = (ms: number) => Math.floor(ms / 1000);

export class JoseTokenSigner implements TokenSigner {
  private constructor(
    private readonly key: Awaited<ReturnType<typeof importJWK>>,
    private readonly kid: string,
    private readonly issuer: string,
  ) {}

  /** ES256(P-256) 개인 JWK와 발급자로 만든다. kid가 없거나 다른 곡선이면 시작하지 않는다 */
  static async fromJwk(jwk: JWK, issuer: string): Promise<JoseTokenSigner> {
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.d !== 'string') throw new Error('팬 토큰 키는 P-256 개인 JWK여야 한다(ES256)');
    if (!jwk.kid) throw new Error('팬 토큰 키 JWK에 kid가 없다(게이트웨이가 kid로 키를 고른다)');
    if (!/^https:\/\/[^\s/]+/.test(issuer)) throw new Error('토큰 발급자(iss)는 https 주소다');
    return new JoseTokenSigner(await importJWK({ ...jwk, alg: 'ES256' }, 'ES256'), jwk.kid, issuer);
  }

  static async fromEnv(env: Record<string, string | undefined>): Promise<JoseTokenSigner> {
    const raw = env[FAN_TOKEN_KEY_ENV];
    const issuer = env[TOKEN_ISSUER_ENV];
    if (!raw) throw new Error(`${FAN_TOKEN_KEY_ENV}가 없다(팬 토큰 개인 JWK, 비밀 관리에서 넣는다)`);
    if (!issuer) throw new Error(`${TOKEN_ISSUER_ENV}가 없다(토큰 발급자 iss)`);
    let jwk: JWK;
    try {
      jwk = JSON.parse(raw) as JWK;
    } catch {
      throw new Error(`${FAN_TOKEN_KEY_ENV}는 JWK JSON이어야 한다`);
    }
    return JoseTokenSigner.fromJwk(jwk, issuer);
  }

  async access(c: { accountId: string; sessionId: string }, now: number): Promise<SignedToken> {
    const exp = seconds(now + ACCESS_TOKEN_TTL_MS);
    // 역할·테넌트·지정은 싣지 않는다(ADR-0172). scope·pid는 본인확인 단계(PRF-040)가 싣는다
    const token = await new SignJWT({ sid: c.sessionId })
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: this.kid })
      .setIssuer(this.issuer)
      .setSubject(c.accountId)
      .setAudience('fan')
      .setIssuedAt(seconds(now))
      .setExpirationTime(exp)
      .setJti(randomUUID())
      .sign(this.key);
    return { token, expiresAt: exp * 1000 };
  }

  async reauth(c: { accountId: string; sessionId: string; provider: string; strength: string; purpose: ReauthPurpose }, now: number): Promise<SignedToken> {
    const exp = seconds(now + REAUTH_TOKEN_TTL_MS);
    const token = await new SignJWT({ sid: c.sessionId, act: FAN_REAUTH_ACT[c.purpose], provider: c.provider, strength: c.strength })
      .setProtectedHeader({ alg: 'ES256', typ: 'reauth+jwt', kid: this.kid })
      .setIssuer(this.issuer)
      .setSubject(c.accountId)
      .setAudience('fan')
      .setIssuedAt(seconds(now))
      .setExpirationTime(exp)
      .setJti(randomUUID())
      .sign(this.key);
    return { token, expiresAt: exp * 1000 };
  }
}
