// 관리 액세스 토큰 서명(관리 토큰 키 셋, ES256, identity §3 쿠키 표·§6 '관리 계정 TOTP와 로그인 2단계의 첫 구현', BUILD_ORDER BOT-120).
// 클레임: iss·sub(관리 계정 ID)·aud(partner·ops)·sid·iat·exp(15분)·jti. 역할·테넌트·지정은 싣지 않는다(ADR-0172, RolesGuard가 GetAdminAuthz로 묻는다).
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { TokenKeyRing } from '../../session/index.js';
import type { AdminAud, AdminTokenSigner } from '../domain/ports.js';

export const ADMIN_ACCESS_TOKEN_TTL_MS = 15 * 60_000;
const seconds = (ms: number) => Math.floor(ms / 1000);

export class JoseAdminTokenSigner implements AdminTokenSigner {
  constructor(
    private readonly keys: Pick<TokenKeyRing, 'signingKey'>,
    private readonly issuer: string,
  ) {}

  async access(c: { accountId: string; sessionId: string; aud: AdminAud; scopes?: readonly string[] }, now: number): Promise<{ token: string; expiresAt: number }> {
    const { kid, key } = this.keys.signingKey('admin');
    const exp = seconds(now + ADMIN_ACCESS_TOKEN_TTL_MS);
    // 비밀번호 바꾸기 필요 세션만 scope를 싣는다(password:change, BOT-123)
    const claims: Record<string, string> = { sid: c.sessionId };
    if (c.scopes?.length) claims.scope = c.scopes.join(' ');
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid })
      .setIssuer(this.issuer)
      .setSubject(c.accountId)
      .setAudience(c.aud)
      .setIssuedAt(seconds(now))
      .setExpirationTime(exp)
      .setJti(randomUUID())
      .sign(key);
    return { token, expiresAt: exp * 1000 };
  }
}
