// 양도·돌려주기의 재인증 토큰 확인기(BUILD_ORDER GAT-055, docs/features/transfer-refund.md §3.1 '팬 취소의 재인증 확인',
// docs/security/authz-matrix.md §6, BUILD_ORDER GAT-045). purchase-svc 팬 취소의 같은 꼴을 ticket-svc의 작업 묶음으로 옮겼다.
// 서명·typ·iss·aud·exp·sid·act·op를 확인한 뒤 sub = 요청 계정과 남은 수명(5분 30초 이하)을 보고, 통과한 뒤에만 jti를 한 번 잡는다.
// 공개키 묶음·jti 저장소 장애는 ReauthUnavailable(503)이다(토큰 거절로 덮지 않는다).
import { createExternalHttpClient, type Clock, type ReauthJtiStore, systemClock, TokenKeysUnavailable, TokenRejected, type TokenVerifierOptions, TokenVerifier } from '@peaket/platform';
import { ReauthUnavailable, type TransferAct, type TransferOp, type TransferReauthGate } from '../domain/transfer-ports.js';

/** 공개키 묶음 읽기 한 번의 시간 상한 1,000ms [가정](§3.1 '공개키 묶음 읽기') */
const JWKS_TIMEOUT_CAP_MS = 1_000;
/** 남은 수명 상한: 5분 + 시계 차이 허용 30초 [가정](§3.1 '한 번 쓰기') */
const MAX_REMAINING_LIFETIME_MS = 5 * 60_000 + 30_000;
/** 묶음 안의 키를 쓸 수 없어 생긴 jose 오류 코드(확인하지 못한 것이라 503) */
const KEY_SET_BROKEN_CODES: ReadonlySet<string> = new Set(['ERR_JWK_INVALID', 'ERR_JWKS_INVALID', 'ERR_JWKS_MULTIPLE_MATCHING_KEYS']);
/** 토큰 머리에서도 나는 jose 오류(모르는 crit 등). 토큰 거절(403)이다 */
const TOKEN_NOT_SUPPORTED_CODE = 'ERR_JOSE_NOT_SUPPORTED';

const codeOf = (e: unknown): unknown => (typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined);
const nameOf = (e: unknown): unknown => (typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : undefined);

export { ReauthUnavailable } from '../domain/transfer-ports.js';

export class JwksFanReauthGate implements TransferReauthGate {
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
        if (!res.ok) throw new Error(`팬 공개키 묶음 읽기 실패: HTTP ${res.status}`);
        return (await res.json()) as Awaited<ReturnType<TokenVerifierOptions['jwks']>>;
      },
    });
  }

  async verify(token: string | undefined, q: { readonly accountId: string; readonly sessionId: string; readonly act: TransferAct; readonly op: TransferOp }): Promise<boolean> {
    if (token === undefined || token.trim() === '') return false;
    let verified: Awaited<ReturnType<TokenVerifier['verifyReauth']>>;
    try {
      verified = await this.#verifier.verifyReauth(token, { keySet: 'fan', audience: 'fan', sessionId: q.sessionId, act: q.act, op: q.op });
    } catch (e) {
      if (e instanceof TokenRejected) return false;
      if (e instanceof TokenKeysUnavailable) throw new ReauthUnavailable('팬 공개키 묶음을 받지 못해 재인증 토큰을 확인하지 못했다', { cause: e });
      const code = codeOf(e);
      if (code === TOKEN_NOT_SUPPORTED_CODE) return false;
      if ((typeof code === 'string' && KEY_SET_BROKEN_CODES.has(code)) || nameOf(e) === 'DataError') {
        throw new ReauthUnavailable('팬 공개키 묶음 안의 키를 쓸 수 없어 재인증 토큰을 확인하지 못했다', { cause: e });
      }
      // 뜻밖 오류는 확인 못 함으로 덮지 않는다(500)
      throw e;
    }
    if (verified.accountId !== q.accountId) return false;
    const nowMs = this.#clock.now();
    if (verified.expiresAt - nowMs > MAX_REMAINING_LIFETIME_MS) return false;
    try {
      return await this.#jti.claim(verified.jti, verified.expiresAt, nowMs);
    } catch (e) {
      throw new ReauthUnavailable('jti 기록 저장소를 쓸 수 없어 재인증 토큰을 확인하지 못했다', { cause: e });
    }
  }
}
