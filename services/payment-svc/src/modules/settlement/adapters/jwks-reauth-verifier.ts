// 관리 재인증 토큰 확인(identity GET /internal/jwks/admin.json, typ reauth+jwt, act PAYOUT_ACCOUNT/BOOKER_EXPORT).
// JWT 확인은 platform TokenVerifier가 하고, 이 서비스는 작업 묶음·패스키 요소만 더 본다.
import { createExternalHttpClient, TokenRejected, TokenVerifier, type Clock, type TokenVerifierOptions } from '@peaket/platform';
import type { ReauthVerifier, VerifiedReauth } from '../domain/ports.js';
import { SettlementProblem } from '../domain/settlement.js';

const reauthRequired = () => new SettlementProblem('reauth-required', 403, '다시 인증해 주세요');

export class JwksReauthVerifier implements ReauthVerifier {
  readonly #verifier: TokenVerifier;

  constructor(o: { jwksUrl: string; issuer: string; clock?: Clock; fetch?: typeof fetch }) {
    const u = new URL(o.jwksUrl);
    const client = createExternalHttpClient({
      provider: 'identity-jwks',
      baseUrl: u.origin,
      timeoutCapMs: 5000,
      ...(o.clock ? { clock: o.clock } : {}),
      ...(o.fetch ? { fetch: o.fetch } : {}),
    });
    this.#verifier = new TokenVerifier({
      issuer: o.issuer,
      ...(o.clock ? { clock: o.clock } : {}),
      jwks: async () => (await (await client.request({ method: 'GET', path: u.pathname })).json()) as unknown as Awaited<ReturnType<TokenVerifierOptions['jwks']>>,
    });
  }

  async verify(token: string | undefined, o: { sessionId: string; act: string }): Promise<VerifiedReauth> {
    if (!token) throw reauthRequired();
    try {
      const v = await this.#verifier.verifyReauth(token, { keySet: 'admin', audience: 'partner', sessionId: o.sessionId, act: o.act });
      const factors = v.factors ?? [];
      if (!factors.includes('passkey')) throw reauthRequired();
      return { jti: v.jti, accountId: v.accountId, sessionId: v.sessionId, act: v.act, factors };
    } catch (e) {
      if (e instanceof TokenRejected) throw reauthRequired();
      throw e;
    }
  }
}

/** JWKS 주소가 없는 개발·시험 조립. 재인증이 필요한 경로는 항상 403이다. */
export class UnavailableReauthVerifier implements ReauthVerifier {
  async verify(): Promise<VerifiedReauth> {
    throw reauthRequired();
  }
}
