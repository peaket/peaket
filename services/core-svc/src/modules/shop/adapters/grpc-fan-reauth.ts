// 굿즈 취소의 재인증 확인(ADR-0293·ADR-0315, docs/features/transfer-refund.md §3.1 '팬 취소의 재인증 확인', P-T63 ②).
// purchase-svc `JwksFanReauthGate`와 같은 꼴을 core-svc shop에 복제한다(공용화는 정리 목록).
// identity-svc 팬 공개키 묶음(GET /internal/jwks/fan.json)과 플랫폼 공용 확인기(TokenVerifier.verifyReauth, 키 셋 fan·aud fan)로
// 서명·typ·iss·aud·exp·sid·act·op를 보고(어긋나면 까닭 claims), sub = 요청 계정과 남은 수명(5분 30초 이하)을 여기서 본다.
// 모두 통과한 뒤에만 jti를 한 번 잡는다(샵 Redis `reauth:jti:{jti}`). 공개키 묶음·jti 저장소 장애는 ReauthUnavailable(503)이다.
import { createExternalHttpClient, type Clock, type ReauthJtiStore, systemClock, TokenKeysUnavailable, TokenRejected, type TokenRejectReason, TokenVerifier, type TokenVerifierOptions } from '@peaket/platform';
import { type ShopReauthAct, type ShopReauthGate, type ShopReauthOp, ReauthUnavailable } from '../domain/merch-ports.js';

/** 공개키 묶음 읽기 한 번의 시간 상한 1,000ms [가정](요청 마감과 쓰기 칸막이를 오래 잡지 않는다) */
const JWKS_TIMEOUT_CAP_MS = 1_000;
/** 받는 토큰의 남은 수명 상한: 5분 + 시계 차이 허용 30초 [가정](ADR-0293) */
const MAX_REMAINING_LIFETIME_MS = 5 * 60_000 + 30_000;
/** 묶음 안의 키를 쓸 수 없어 생긴 jose 오류 코드 */
const KEY_SET_BROKEN_CODES: ReadonlySet<string> = new Set(['ERR_JWK_INVALID', 'ERR_JWKS_INVALID', 'ERR_JWKS_MULTIPLE_MATCHING_KEYS']);
/** 토큰 머리에서도 나는 jose 오류 코드(모르는 crit 머리 등). 토큰 거절(403, 까닭 claims)이다 */
const TOKEN_NOT_SUPPORTED_CODE = 'ERR_JOSE_NOT_SUPPORTED';

/** 403의 까닭 이름표(§3.1 '거절 기록') */
export type ShopReauthRejectReason = 'missing' | TokenRejectReason | 'sub' | 'lifetime' | 'replay';
/** 403·503 한 번의 기록. 통과는 넘기지 않는다 */
export type ShopReauthResult = { readonly outcome: 'rejected'; readonly reason: ShopReauthRejectReason } | { readonly outcome: 'unavailable'; readonly reason: 'keys' | 'store' };

const codeOf = (e: unknown): unknown => (typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined);
const nameOf = (e: unknown): unknown => (typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : undefined);

export class JwksShopReauthGate implements ShopReauthGate {
  readonly #verifier: TokenVerifier;
  readonly #jti: ReauthJtiStore;
  readonly #clock: Clock;
  readonly #onResult: ((r: ShopReauthResult) => void) | undefined;

  constructor(o: { jwksUrl: string; issuer: string; jti: ReauthJtiStore; clock?: Clock; fetch?: typeof fetch; onResult?: (r: ShopReauthResult) => void }) {
    this.#jti = o.jti;
    this.#clock = o.clock ?? systemClock;
    this.#onResult = o.onResult;
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

  #reject(reason: ShopReauthRejectReason): false {
    this.#onResult?.({ outcome: 'rejected', reason });
    return false;
  }

  #unavailable(reason: 'keys' | 'store', message: string, cause: unknown): ReauthUnavailable {
    this.#onResult?.({ outcome: 'unavailable', reason });
    return new ReauthUnavailable(message, { cause });
  }

  async verify(token: string | undefined, q: { readonly accountId: string; readonly sessionId: string; readonly act: ShopReauthAct; readonly op: ShopReauthOp }): Promise<boolean> {
    if (token === undefined || token.trim() === '') return this.#reject('missing');
    let verified: Awaited<ReturnType<TokenVerifier['verifyReauth']>>;
    try {
      verified = await this.#verifier.verifyReauth(token, { keySet: 'fan', audience: 'fan', sessionId: q.sessionId, act: q.act, op: q.op });
    } catch (e) {
      if (e instanceof TokenRejected) return this.#reject(e.reason);
      if (e instanceof TokenKeysUnavailable) throw this.#unavailable('keys', '팬 공개키 묶음을 받지 못해 재인증 토큰을 확인하지 못했다', e);
      const code = codeOf(e);
      if (code === TOKEN_NOT_SUPPORTED_CODE) return this.#reject('claims');
      // 좌표가 곡선 밖이거나 y가 없는 키는 jose가 code 없이 DOMException(name DataError)을 낸다
      if ((typeof code === 'string' && KEY_SET_BROKEN_CODES.has(code)) || nameOf(e) === 'DataError') {
        throw this.#unavailable('keys', '팬 공개키 묶음 안의 키를 쓸 수 없어 재인증 토큰을 확인하지 못했다', e);
      }
      // 그 밖의 뜻밖 오류(코드 결함)는 확인 못 함으로 덮지 않는다(500)
      throw e;
    }
    // 확인기는 sub를 보지 않는다. 다른 계정의 토큰은 jti를 잡지 않고 거절한다
    if (verified.accountId !== q.accountId) return this.#reject('sub');
    const nowMs = this.#clock.now();
    // 남은 수명이 상한을 넘는 토큰은 jti를 잡지 않고 거절한다(기록이 토큰보다 먼저 사라지지 않게)
    if (verified.expiresAt - nowMs > MAX_REMAINING_LIFETIME_MS) return this.#reject('lifetime');
    let claimed: boolean;
    try {
      claimed = await this.#jti.claim(verified.jti, verified.expiresAt, nowMs);
    } catch (e) {
      throw this.#unavailable('store', 'jti 기록 저장소를 쓸 수 없어 재인증 토큰을 확인하지 못했다', e);
    }
    return claimed ? true : this.#reject('replay');
  }
}

/** 재인증이 필요한 작업이 없는 환경 값(주소 없는 local·ci)의 닫힌 대역(늘 403). main.ts가 넣는다 */
export const STUB_SHOP_REAUTH_ENVS: ReadonlySet<string> = new Set(['local', 'ci']);
/** 발급자 기본값: local·ci에서만 쓴다(그 밖 환경은 시작 실패) */
const DEFAULT_IDENTITY_ISSUER = 'https://identity.peaket.example';

/**
 * 시작 조립(ADR-0315, purchase-svc `fanReauthGateFromEnv`와 같은 규칙).
 * `PEAKET_IDENTITY_FAN_JWKS_URL`이 있으면 JwksShopReauthGate(발급자 `PEAKET_IDENTITY_ISSUER`)를 돌려준다.
 * 주소가 없으면(빈 문자열 포함) local·ci는 undefined(닫힌 대역, 늘 403)과 경고 한 번, 그 밖 환경은 던진다(시작 실패).
 */
export function shopReauthGateFromEnv(o: {
  env: Readonly<Record<string, string | undefined>>;
  jti: ReauthJtiStore;
  warn?: (msg: string) => void;
  clock?: Clock;
  fetch?: typeof fetch;
  onResult?: (r: ShopReauthResult) => void;
}): ShopReauthGate | undefined {
  const envName = o.env.PEAKET_ENV;
  const stubEnv = envName !== undefined && STUB_SHOP_REAUTH_ENVS.has(envName);
  const jwksUrl = o.env.PEAKET_IDENTITY_FAN_JWKS_URL;
  if (jwksUrl !== undefined && jwksUrl.trim() !== '') {
    const issuer = o.env.PEAKET_IDENTITY_ISSUER;
    const hasIssuer = issuer !== undefined && issuer.trim() !== '';
    if (!hasIssuer && !stubEnv) throw new Error('PEAKET_IDENTITY_FAN_JWKS_URL은 있는데 PEAKET_IDENTITY_ISSUER가 없다(기본값 발급자로 뜨면 굿즈 취소가 늘 403일 수 있다). 운영에서는 시작하지 않는다');
    return new JwksShopReauthGate({
      jwksUrl: jwksUrl.trim(),
      issuer: hasIssuer ? issuer.trim() : DEFAULT_IDENTITY_ISSUER,
      jti: o.jti,
      ...(o.clock ? { clock: o.clock } : {}),
      ...(o.fetch ? { fetch: o.fetch } : {}),
      ...(o.onResult ? { onResult: o.onResult } : {}),
    });
  }
  const msg = 'PEAKET_IDENTITY_FAN_JWKS_URL이 없다(굿즈 취소의 재인증 토큰을 확인하지 못해 계좌 취소가 늘 403 reauth-required다)';
  if (!stubEnv) throw new Error(`${msg}. 운영에서는 시작하지 않는다`);
  o.warn?.(msg);
  return undefined;
}
