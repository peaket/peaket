// 입장 토큰 서명(ES256 JWT, docs/features/queue-admission.md §6 '입장 확정의 첫 구현', ADR-0050 결정 9, ADR-0183 결정 8).
// 머리 {alg ES256, typ admission+jwt, kid}, 클레임 iss·sub·aud purchase·jti·sid·event·jny·iat·exp(= iat + 최대 체류). 첫 사용 기한은 purchase-svc가 iat + 5분으로 본다.
// 서명은 Node 표준 암호 모듈로 한다(RFC 7515 그대로, 서명은 r‖s 64바이트). 키는 환경 값의 개인 JWK다(Secrets Manager → 시작 때 메모리, OPEN[10] 추천 적용).
import { createPrivateKey, type KeyObject, sign } from 'node:crypto';
import type { AdmissionTokens } from '../domain/ports.js';
import { MAX_STAY_MS } from '../domain/admission.js';

export const ADMISSION_TOKEN_KEY_ENV = 'PEAKET_ADMISSION_TOKEN_KEY';
export const ADMISSION_TOKEN_ISSUER_ENV = 'PEAKET_ADMISSION_TOKEN_ISSUER';
/** 입장 확정 응답에 싣는 서버 ECDH 공개키(공개 JWK, 선택). 키를 만드는 것과 purchase-svc 쪽은 BOT-100 */
export const PURCHASE_ECDH_PUBLIC_JWK_ENV = 'PEAKET_PURCHASE_ECDH_PUBLIC_JWK';

const HTTPS = /^https:\/\/[^\s/]+/;
const KID = /^[A-Za-z0-9_.-]{1,64}$/;
const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
const seconds = (ms: number) => Math.floor(ms / 1000);

interface Jwk {
  kty?: string;
  crv?: string;
  x?: string;
  y?: string;
  d?: string;
  kid?: string;
}

function parseJwk(name: string, raw: string): Jwk {
  let j: Jwk;
  try {
    j = JSON.parse(raw) as Jwk;
  } catch {
    // 값은 오류 문구에 싣지 않는다
    throw new Error(`${name}는 JWK JSON이어야 한다`);
  }
  if (j.kty !== 'EC' || j.crv !== 'P-256' || typeof j.x !== 'string' || typeof j.y !== 'string') throw new Error(`${name}는 P-256 JWK여야 한다(ES256)`);
  if (!j.kid || !KID.test(j.kid)) throw new Error(`${name}에 kid가 없거나 틀렸다(받는 쪽이 kid로 키를 고른다)`);
  return j;
}

export class Es256AdmissionTokens implements AdmissionTokens {
  readonly #key: KeyObject;
  readonly #kid: string;
  readonly #issuer: string;
  readonly #ecdh: Record<string, string> | undefined;

  constructor(o: { jwk: Jwk; issuer: string; ecdhPublicJwk?: Jwk }) {
    if (!HTTPS.test(o.issuer)) throw new Error('입장 토큰 발급자(iss)는 https 주소다');
    if (typeof o.jwk.d !== 'string') throw new Error(`${ADMISSION_TOKEN_KEY_ENV}는 개인 JWK여야 한다(서명에 쓴다)`);
    this.#key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: o.jwk.x, y: o.jwk.y, d: o.jwk.d }, format: 'jwk' });
    this.#kid = o.jwk.kid!;
    this.#issuer = o.issuer;
    const e = o.ecdhPublicJwk;
    this.#ecdh = e ? { kty: 'EC', crv: 'P-256', x: e.x!, y: e.y!, kid: e.kid! } : undefined;
  }

  static fromEnv(env: Record<string, string | undefined>): Es256AdmissionTokens {
    const raw = env[ADMISSION_TOKEN_KEY_ENV];
    if (!raw) throw new Error(`${ADMISSION_TOKEN_KEY_ENV}가 없다(입장 토큰 서명 개인 JWK, 비밀 관리에서 넣는다)`);
    const issuer = env[ADMISSION_TOKEN_ISSUER_ENV];
    if (!issuer) throw new Error(`${ADMISSION_TOKEN_ISSUER_ENV}가 없다(입장 토큰 발급자 iss, https 주소)`);
    const ecdhRaw = env[PURCHASE_ECDH_PUBLIC_JWK_ENV];
    let ecdhPublicJwk: Jwk | undefined;
    if (ecdhRaw) {
      ecdhPublicJwk = parseJwk(PURCHASE_ECDH_PUBLIC_JWK_ENV, ecdhRaw);
      // 응답으로 내보내는 값이라 개인 성분이 섞이면 시작하지 않는다
      if ('d' in ecdhPublicJwk) throw new Error(`${PURCHASE_ECDH_PUBLIC_JWK_ENV}는 공개 JWK여야 한다(d를 빼고 넣는다)`);
    }
    return new Es256AdmissionTokens({ jwk: parseJwk(ADMISSION_TOKEN_KEY_ENV, raw), issuer, ...(ecdhPublicJwk ? { ecdhPublicJwk } : {}) });
  }

  sign(c: { jti: string; accountId: string; sessionId: string; eventId: string; jny: string; nowMs: number }): { token: string; expiresAtMs: number } {
    const iat = seconds(c.nowMs);
    const exp = iat + seconds(MAX_STAY_MS);
    const head = b64({ alg: 'ES256', typ: 'admission+jwt', kid: this.#kid });
    const body = b64({ iss: this.#issuer, sub: c.accountId, aud: 'purchase', jti: c.jti, sid: c.sessionId, event: c.eventId, jny: c.jny, iat, exp });
    const signed = `${head}.${body}`;
    const sig = sign('sha256', Buffer.from(signed), { key: this.#key, dsaEncoding: 'ieee-p1363' });
    return { token: `${signed}.${sig.toString('base64url')}`, expiresAtMs: exp * 1000 };
  }

  serverEcdhPublicKey(): Record<string, string> | undefined {
    return this.#ecdh ? { ...this.#ecdh } : undefined;
  }
}
