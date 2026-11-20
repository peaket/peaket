// 관리 재인증 토큰 확인(identity GET /internal/jwks/admin.json, act APPROVAL·PERMISSION_CHANGE·OPS_COMMAND, passkey 필수).
import { createExternalHttpClient, ProblemError, type ReauthJtiStore, systemClock, TokenRejected, TokenVerifier, type Clock, type TokenVerifierOptions } from '@peaket/platform';
import { type ApprovalReauthVerifier, type ReauthAct } from '../domain/ports.js';

const reauthRequired = () => new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });

export class JwksApprovalVerifier implements ApprovalReauthVerifier {
  readonly #verifier: TokenVerifier;
  readonly #jti?: ReauthJtiStore;
  readonly #clock: Clock;
  constructor(o: { jwksUrl: string; issuer: string; clock?: Clock; fetch?: typeof fetch; jti?: ReauthJtiStore }) {
    this.#jti = o.jti;
    this.#clock = o.clock ?? systemClock;
    const u = new URL(o.jwksUrl);
    const client = createExternalHttpClient({ provider: 'identity-jwks', baseUrl: u.origin, timeoutCapMs: 5_000, ...(o.clock ? { clock: o.clock } : {}), ...(o.fetch ? { fetch: o.fetch } : {}) });
    this.#verifier = new TokenVerifier({
      issuer: o.issuer,
      ...(o.clock ? { clock: o.clock } : {}),
      jwks: async () => (await (await client.request({ method: 'GET', path: u.pathname })).json()) as unknown as Awaited<ReturnType<TokenVerifierOptions['jwks']>>,
    });
  }
  async verify(token: string | undefined, o: { sessionId: string; act: ReauthAct }) {
    if (!token) throw reauthRequired();
    try {
      const v = await this.#verifier.verifyReauth(token, { keySet: 'admin', audience: 'ops', sessionId: o.sessionId, act: o.act });
      const factors = v.factors ?? [];
      if (!factors.includes('passkey')) throw reauthRequired();
      if (this.#jti) {
        let claimed: boolean;
        try {
          claimed = await this.#jti.claim(v.jti, v.expiresAt, this.#clock.now());
        } catch {
          throw new ProblemError({ type: 'reauth-unavailable', status: 503, title: '재인증 확인기를 쓸 수 없습니다', retryAfterSeconds: 5 });
        }
        if (!claimed) throw reauthRequired();
      }
      return { accountId: v.accountId, factors };
    } catch (e) {
      if (e instanceof ProblemError) throw e;
      if (e instanceof TokenRejected) throw reauthRequired();
      // 키 묶음을 받지 못하는 등 확인기 장애는 통과가 아니라 503이다(닫힌 쪽)
      throw new ProblemError({ type: 'reauth-unavailable', status: 503, title: '재인증 확인기를 쓸 수 없습니다', retryAfterSeconds: 5 });
    }
  }
}

export class UnavailableApprovalVerifier implements ApprovalReauthVerifier {
  async verify(): Promise<{ accountId: string; factors: string[] }> {
    throw reauthRequired();
  }
}
