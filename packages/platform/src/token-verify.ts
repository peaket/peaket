// 받는 쪽의 identity 토큰 확인(docs/features/identity.md §3 '게이트웨이 무상태 고속 검증'·'토큰 수명주기 구현' 발급자와 검증 규칙, ADR-0050 결정 9).
// - 키 셋(팬·관리·현장 스태프)마다 자기 공개키 묶음만 믿는다. 키 셋이 받는 대상은 정해져 있다(팬 fan, 관리 partner·ops, 현장 스태프 scanner)
// - 서명(ES256만)·typ(액세스 at+jwt, 재인증 reauth+jwt)·iss·aud·exp를 함께 본다. 하나라도 어긋나면 이유와 함께 거절한다(응답에는 이유를 싣지 않는다)
// - 공개키 묶음은 5분 [가정] 캐시하고, 모르는 kid가 오면 한 번 다시 읽는다(교체 직후 새 키, I-T20). 다시 읽기는 키 셋마다 하나로 묶고(동시에 온 요청은 한 번),
//   모르는 kid 때문에 다시 읽는 일은 30초 [가정]에 한 번이다(서명 없는 아무 kid로 identity-svc를 두드리지 못하게). 읽기에 실패하면 마지막으로 받은 키로 계속 확인한다(무상태 검증)
// 게이트웨이(BUILD_ORDER HOT-400)와 재인증 토큰을 받는 서비스, 소비자 웹 앱 서버가 같은 규칙을 쓴다. Nest에 기대지 않는다.
import { createLocalJWKSet, decodeProtectedHeader, errors, type JSONWebKeySet, type JWTPayload, jwtVerify } from 'jose';
import { type Clock, systemClock } from './clock.js';

export const TOKEN_KEY_SETS = ['fan', 'admin', 'staff'] as const;
export type TokenKeySet = (typeof TOKEN_KEY_SETS)[number];

/** 키 셋마다 받는 대상(aud) */
export const KEY_SET_AUDIENCES: Readonly<Record<TokenKeySet, readonly string[]>> = Object.freeze({ fan: ['fan'], admin: ['partner', 'ops'], staff: ['scanner'] });

/** 공개키 묶음 캐시 5분 [가정](identity §3 '공개키 배포') */
export const JWKS_CACHE_MS = 5 * 60_000;
/** 모르는 kid로 다시 읽는 최소 간격, 읽기 실패 뒤 다시 시도할 때까지 30초 [가정] */
export const JWKS_REFETCH_COOLDOWN_MS = 30_000;

export type TokenRejectReason = 'format' | 'alg' | 'kid' | 'signature' | 'typ' | 'iss' | 'aud' | 'expired' | 'claims';

/** 공개키 묶음을 한 번도 받지 못해 확인할 수 없다(부르는 쪽은 503으로 다룬다. 401로 바꾸지 않는다) */
export class TokenKeysUnavailable extends Error {
  constructor(readonly keySet: TokenKeySet, cause?: unknown) {
    super(`${keySet} 공개키 묶음을 받지 못했다`, { cause });
    this.name = 'TokenKeysUnavailable';
  }
}

export class TokenRejected extends Error {
  constructor(
    readonly reason: TokenRejectReason,
    message = `토큰 거절: ${reason}`,
  ) {
    super(message);
    this.name = 'TokenRejected';
  }
}

export interface VerifiedAccess {
  accountId: string;
  sessionId: string;
  audience: string;
  scopes: string[];
  pid?: string;
  pidPrev?: string;
  expiresAt: number;
}

export interface VerifiedReauth {
  jti: string;
  accountId: string;
  sessionId: string;
  act: string;
  provider?: string;
  strength?: string;
  factors?: string[];
}

export interface TokenVerifierOptions {
  /** identity 토큰의 발급자(iss) */
  issuer: string;
  /** 키 셋의 공개키 묶음을 읽는다(identity-svc GET /internal/jwks/{set}.json 등) */
  jwks: (set: TokenKeySet) => Promise<JSONWebKeySet> | JSONWebKeySet;
  clock?: Clock;
}

interface Cached {
  /** 받은 시각 */
  at: number;
  /** 읽기에 실패했을 때 다시 시도할 수 있는 시각 */
  retryAt: number;
  /** 모르는 kid 때문에 마지막으로 다시 읽은 시각 */
  missAt: number;
  kids: Set<string>;
  keys: ReturnType<typeof createLocalJWKSet>;
}

export class TokenVerifier {
  readonly #o: TokenVerifierOptions;
  readonly #clock: Clock;
  readonly #cache = new Map<TokenKeySet, Cached>();
  readonly #inflight = new Map<TokenKeySet, Promise<Cached>>();

  constructor(o: TokenVerifierOptions) {
    this.#o = o;
    this.#clock = o.clock ?? systemClock;
  }

  /** 다시 읽기(키 셋마다 하나만 돈다). 실패하면 마지막으로 받은 키를 그대로 쓰고 30초 뒤에 다시 시도한다 */
  #load(set: TokenKeySet, miss: boolean): Promise<Cached> {
    const running = this.#inflight.get(set);
    if (running) return running;
    const p = (async () => {
      const prev = this.#cache.get(set);
      const now = this.#clock.now();
      try {
        const jwks = await this.#o.jwks(set);
        const c: Cached = {
          at: now,
          retryAt: now,
          missAt: miss ? now : (prev?.missAt ?? Number.NEGATIVE_INFINITY),
          kids: new Set(jwks.keys.map((k) => k.kid).filter((k): k is string => typeof k === 'string')),
          keys: createLocalJWKSet(jwks),
        };
        this.#cache.set(set, c);
        return c;
      } catch (err) {
        if (!prev) throw new TokenKeysUnavailable(set, err);
        prev.retryAt = now + JWKS_REFETCH_COOLDOWN_MS;
        if (miss) prev.missAt = now;
        return prev;
      }
    })().finally(() => this.#inflight.delete(set));
    this.#inflight.set(set, p);
    return p;
  }

  async #keysFor(set: TokenKeySet, kid: string): Promise<Cached> {
    const now = this.#clock.now();
    const c = this.#cache.get(set);
    if (!c) return this.#load(set, false);
    if (now - c.at > JWKS_CACHE_MS && now >= c.retryAt) return this.#load(set, false);
    // 모르는 kid: 키를 막 바꿨을 수 있어 다시 읽는다. 30초에 한 번만
    if (!c.kids.has(kid) && now - c.missAt > JWKS_REFETCH_COOLDOWN_MS) return this.#load(set, true);
    return c;
  }

  async #verify(token: string, keySet: TokenKeySet, audience: string, typ: string): Promise<JWTPayload> {
    if (!KEY_SET_AUDIENCES[keySet].includes(audience)) throw new Error(`${keySet} 키 셋이 받지 않는 대상이다: ${audience}`);
    let header: ReturnType<typeof decodeProtectedHeader>;
    try {
      header = decodeProtectedHeader(token);
    } catch {
      throw new TokenRejected('format');
    }
    if (header.alg !== 'ES256') throw new TokenRejected('alg');
    if (typeof header.kid !== 'string') throw new TokenRejected('kid');
    const keys = await this.#keysFor(keySet, header.kid);
    if (!keys.kids.has(header.kid)) throw new TokenRejected('kid');
    try {
      const { payload } = await jwtVerify(token, keys.keys, { issuer: this.#o.issuer, audience, typ, algorithms: ['ES256'], requiredClaims: ['exp'], currentDate: new Date(this.#clock.now()) });
      return payload;
    } catch (e) {
      if (e instanceof errors.JWTExpired) throw new TokenRejected('expired');
      if (e instanceof errors.JWTClaimValidationFailed) throw new TokenRejected(e.claim === 'iss' || e.claim === 'aud' || e.claim === 'typ' ? e.claim : 'claims');
      if (e instanceof errors.JWSSignatureVerificationFailed) throw new TokenRejected('signature');
      if (e instanceof errors.JWKSNoMatchingKey) throw new TokenRejected('kid');
      if (e instanceof errors.JOSEAlgNotAllowed) throw new TokenRejected('alg');
      if (e instanceof errors.JWSInvalid || e instanceof errors.JWTInvalid) throw new TokenRejected('format');
      throw e;
    }
  }

  /** 액세스 토큰(typ at+jwt) */
  async verifyAccess(token: string, o: { keySet: TokenKeySet; audience: string }): Promise<VerifiedAccess> {
    const p = await this.#verify(token, o.keySet, o.audience, 'at+jwt');
    if (typeof p.sub !== 'string' || typeof p.sid !== 'string' || typeof p.exp !== 'number') throw new TokenRejected('claims');
    const v: VerifiedAccess = { accountId: p.sub, sessionId: p.sid, audience: o.audience, scopes: typeof p.scope === 'string' ? p.scope.split(/\s+/).filter(Boolean) : [], expiresAt: p.exp * 1000 };
    if (typeof p.pid === 'string') v.pid = p.pid;
    if (typeof p.pid_prev === 'string') v.pidPrev = p.pid_prev;
    return v;
  }

  /** 재인증 토큰(typ reauth+jwt): 요청의 세션·작업 묶음과 같아야 한다(identity §3 '재인증 토큰의 묶음'). 한 번 쓰기(jti)는 부르는 쪽이 본다 */
  async verifyReauth(token: string, o: { keySet: TokenKeySet; audience: string; sessionId: string; act: string }): Promise<VerifiedReauth> {
    const p = await this.#verify(token, o.keySet, o.audience, 'reauth+jwt');
    if (typeof p.sub !== 'string' || typeof p.jti !== 'string' || p.sid !== o.sessionId || p.act !== o.act) throw new TokenRejected('claims');
    const v: VerifiedReauth = { jti: p.jti, accountId: p.sub, sessionId: o.sessionId, act: o.act };
    if (typeof p.provider === 'string') v.provider = p.provider;
    if (typeof p.strength === 'string') v.strength = p.strength;
    if (Array.isArray(p.factors)) v.factors = p.factors.filter((f): f is string => typeof f === 'string');
    return v;
  }
}
