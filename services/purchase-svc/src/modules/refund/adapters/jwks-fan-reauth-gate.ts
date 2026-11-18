// 팬 취소의 재인증 토큰 확인(docs/features/transfer-refund.md §3.1 '팬 취소의 재인증 확인', BUILD_ORDER GAT-080, R-T39).
// identity-svc 팬 공개키 묶음(GET /internal/jwks/fan.json)과 플랫폼 공용 확인기(TokenVerifier.verifyReauth, 키 셋 fan·aud fan)로
// 서명·typ·iss·aud·exp·sid·act를 보고, sub = 요청 계정을 여기서 본다(확인기는 sub를 대조하지 않는다).
// 모두 통과한 뒤에만 jti를 한 번 잡는다(좌석 Redis reauth:jti:{jti}, docs/data.md §3). 저장소는 필수다(core·ops와 달리 건너뛰지 않는다).
// 공개키 묶음을 한 번도 받지 못했거나 jti 저장소가 던지면 ReauthUnavailable(503 reauth-unavailable)이다.
import { createExternalHttpClient, type Clock, type ReauthJtiStore, systemClock, TokenKeysUnavailable, TokenRejected, TokenVerifier, type TokenVerifierOptions } from '@peaket/platform';
import { type FanReauthAct, type ReauthGate, ReauthUnavailable } from '../domain/ports.js';

/** 공개키 묶음 읽기 한 번의 시간 상한(재인증을 받는 다른 서비스와 같다) */
const JWKS_TIMEOUT_CAP_MS = 5_000;

export class JwksFanReauthGate implements ReauthGate {
  readonly #verifier: TokenVerifier;
  readonly #jti: ReauthJtiStore;
  readonly #clock: Clock;

  constructor(o: { jwksUrl: string; issuer: string; jti: ReauthJtiStore; clock?: Clock; fetch?: typeof fetch }) {
    this.#jti = o.jti;
    this.#clock = o.clock ?? systemClock;
    const u = new URL(o.jwksUrl);
    const client = createExternalHttpClient({
      provider: 'identity-jwks',
      baseUrl: u.origin,
      timeoutCapMs: JWKS_TIMEOUT_CAP_MS,
      ...(o.clock ? { clock: o.clock } : {}),
      ...(o.fetch ? { fetch: o.fetch } : {}),
    });
    this.#verifier = new TokenVerifier({
      issuer: o.issuer,
      ...(o.clock ? { clock: o.clock } : {}),
      jwks: async () => {
        const res = await client.request({ method: 'GET', path: u.pathname });
        // 2xx가 아니면 받지 못한 것으로 본다(확인기가 마지막 키를 쓰거나, 처음이면 TokenKeysUnavailable로 바꾼다)
        if (!res.ok) throw new Error(`팬 공개키 묶음 읽기 실패: HTTP ${res.status}`);
        return (await res.json()) as Awaited<ReturnType<TokenVerifierOptions['jwks']>>;
      },
    });
  }

  async verify(token: string | undefined, q: { readonly accountId: string; readonly sessionId: string; readonly act: FanReauthAct }): Promise<boolean> {
    if (token === undefined || token.trim() === '') return false;
    let verified: Awaited<ReturnType<TokenVerifier['verifyReauth']>>;
    try {
      verified = await this.#verifier.verifyReauth(token, { keySet: 'fan', audience: 'fan', sessionId: q.sessionId, act: q.act });
    } catch (e) {
      if (e instanceof TokenRejected) return false;
      if (e instanceof TokenKeysUnavailable) throw new ReauthUnavailable('팬 공개키 묶음을 받지 못해 재인증 토큰을 확인하지 못했다', { cause: e });
      throw e;
    }
    // 확인기는 sub를 보지 않는다. 다른 계정의 토큰은 jti를 잡지 않고 거절한다
    if (verified.accountId !== q.accountId) return false;
    let claimed: boolean;
    try {
      claimed = await this.#jti.claim(verified.jti, verified.expiresAt, this.#clock.now());
    } catch (e) {
      throw new ReauthUnavailable('jti 기록 저장소를 쓸 수 없어 재인증 토큰을 확인하지 못했다', { cause: e });
    }
    return claimed;
  }
}
