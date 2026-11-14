// 관리 재인증 토큰 확인(identity GET /internal/jwks/admin.json, act APPROVAL, passkey 필수).
import { createExternalHttpClient, ProblemError, TokenRejected, TokenVerifier, type Clock, type TokenVerifierOptions } from '@peaket/platform';
import type { ApprovalReauthVerifier } from '../domain/ports.js';

const reauthRequired = () => new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });

export class JwksApprovalVerifier implements ApprovalReauthVerifier {
  readonly #verifier: TokenVerifier;
  constructor(o: { jwksUrl: string; issuer: string; clock?: Clock; fetch?: typeof fetch }) {
    const u = new URL(o.jwksUrl);
    const client = createExternalHttpClient({ provider: 'identity-jwks', baseUrl: u.origin, timeoutCapMs: 5_000, ...(o.clock ? { clock: o.clock } : {}), ...(o.fetch ? { fetch: o.fetch } : {}) });
    this.#verifier = new TokenVerifier({
      issuer: o.issuer,
      ...(o.clock ? { clock: o.clock } : {}),
      jwks: async () => (await (await client.request({ method: 'GET', path: u.pathname })).json()) as unknown as Awaited<ReturnType<TokenVerifierOptions['jwks']>>,
    });
  }
  async verify(token: string | undefined, o: { sessionId: string; act: 'APPROVAL' }) {
    if (!token) throw reauthRequired();
    try {
      const v = await this.#verifier.verifyReauth(token, { keySet: 'admin', audience: 'ops', sessionId: o.sessionId, act: o.act });
      const factors = v.factors ?? [];
      if (!factors.includes('passkey')) throw reauthRequired();
      return { accountId: v.accountId, factors };
    } catch (e) {
      if (e instanceof ProblemError) throw e;
      if (e instanceof TokenRejected) throw reauthRequired();
      throw e;
    }
  }
}

export class UnavailableApprovalVerifier implements ApprovalReauthVerifier {
  async verify(): Promise<{ accountId: string; factors: string[] }> {
    throw reauthRequired();
  }
}
