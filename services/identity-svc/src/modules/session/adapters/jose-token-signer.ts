// 토큰 서명 어댑터(docs/features/identity.md §3·§7.1, ADR-0011·0050). 키는 키 셋 셋(TokenKeyRing)의 지금 키다.
// 팬 액세스 토큰과 팬 재인증 토큰은 팬 키 셋으로 서명한다. 관리·현장 스태프 토큰은 그 로그인 단계(wbs 3.5.1·5.5.x)가 이 서명기에 더한다.
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { SignedToken, TokenSigner } from '../domain/ports.js';
import { ACCESS_TOKEN_TTL_MS, FAN_REAUTH_ACT, REAUTH_TOKEN_TTL_MS, type ReauthPurpose } from '../domain/session.js';
import type { TokenKeyRing } from './token-keys.js';

export const TOKEN_ISSUER_ENV = 'PEAKET_TOKEN_ISSUER';

const seconds = (ms: number) => Math.floor(ms / 1000);
const HTTPS = /^https:\/\/[^\s/]+/;

export function tokenIssuerFromEnv(env: Record<string, string | undefined>): string {
  const issuer = env[TOKEN_ISSUER_ENV];
  if (!issuer) throw new Error(`${TOKEN_ISSUER_ENV}가 없다(토큰 발급자 iss, 운영 https://identity.peaket.example [가정])`);
  if (!HTTPS.test(issuer)) throw new Error('토큰 발급자(iss)는 https 주소다');
  return issuer;
}

export class JoseTokenSigner implements TokenSigner {
  readonly #keys: TokenKeyRing;
  readonly #issuer: string;

  constructor(keys: TokenKeyRing, issuer: string) {
    if (!HTTPS.test(issuer)) throw new Error('토큰 발급자(iss)는 https 주소다');
    this.#keys = keys;
    this.#issuer = issuer;
  }

  get issuer(): string {
    return this.#issuer;
  }

  async access(c: { accountId: string; sessionId: string; scopes?: string[]; pid?: string; pidPrev?: string }, now: number): Promise<SignedToken> {
    const { kid, key } = this.#keys.signingKey('fan');
    const exp = seconds(now + ACCESS_TOKEN_TTL_MS);
    // 역할·테넌트·지정은 싣지 않는다(ADR-0172). scope(ticket:buy)·pid·pid_prev는 본인확인을 마친 계정만(identity §3·§5)
    const claims: Record<string, string> = { sid: c.sessionId };
    if (c.scopes?.length) claims.scope = c.scopes.join(' ');
    if (c.pid) claims.pid = c.pid;
    if (c.pidPrev) claims.pid_prev = c.pidPrev;
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid })
      .setIssuer(this.#issuer)
      .setSubject(c.accountId)
      .setAudience('fan')
      .setIssuedAt(seconds(now))
      .setExpirationTime(exp)
      .setJti(randomUUID())
      .sign(key);
    return { token, expiresAt: exp * 1000 };
  }

  async reauth(c: { accountId: string; sessionId: string; provider: string; strength: string; purpose: ReauthPurpose }, now: number): Promise<SignedToken> {
    const { kid, key } = this.#keys.signingKey('fan');
    const exp = seconds(now + REAUTH_TOKEN_TTL_MS);
    const token = await new SignJWT({ sid: c.sessionId, act: FAN_REAUTH_ACT[c.purpose], provider: c.provider, strength: c.strength })
      .setProtectedHeader({ alg: 'ES256', typ: 'reauth+jwt', kid })
      .setIssuer(this.#issuer)
      .setSubject(c.accountId)
      .setAudience('fan')
      .setIssuedAt(seconds(now))
      .setExpirationTime(exp)
      .setJti(randomUUID())
      .sign(key);
    return { token, expiresAt: exp * 1000 };
  }
}
