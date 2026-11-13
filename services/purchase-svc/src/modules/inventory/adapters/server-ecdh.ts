// 서버 고정 ECDH 키(구매 세션 요청 인증 키 합의, docs/features/seat-hold.md §2 '요청 인증 키', docs/security/secrets-and-keys.md '구매 세션 서버 ECDH 키', ADR-0050 결정 8, BUILD_ORDER PRF-136).
// 환경 값 PEAKET_PURCHASE_ECDH_KEY의 개인 JWK(P-256, kid 필수)를 시작 때 메모리로만 읽는다(저장·로그 없음). 공유 비밀은 x 좌표 32바이트다(RFC 5903, 해시하지 않는다).
// 요청 인증 키는 이 공유 비밀을 HKDF-SHA256(salt = jti, info = PEAKET-purchase-v1)에 넣어 만든다(platform purchaseRequestKey). 키 교체(옛 키 함께 허용)와 1ms 측정은 BOT-100이다.
import { createECDH, createPrivateKey, diffieHellman, type KeyObject } from 'node:crypto';

export const PURCHASE_ECDH_KEY_ENV = 'PEAKET_PURCHASE_ECDH_KEY';
/** 키 교체 중에 함께 받는 옛 개인 JWK(선택, BOT-100). 있으면 옛 키로 서명한 요청도 받는다 */
export const PURCHASE_ECDH_KEY_PREV_ENV = 'PEAKET_PURCHASE_ECDH_KEY_PREV';

const KID = /^[A-Za-z0-9_.-]{1,64}$/;
/** P-256 좌표·개인 스칼라는 32바이트 = base64url 43자 */
const COORD = /^[A-Za-z0-9_-]{43}$/;

export interface ServerEcdhJwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
  d: string;
  kid: string;
}

export class ServerEcdhKey {
  readonly kid: string;
  readonly #priv: KeyObject;
  readonly #x: string;
  readonly #y: string;
  /** 키 교체 중 함께 받는 옛 키(없으면 undefined). 이 키로 합의한 요청도 통과시킨다(BOT-100) */
  readonly previous?: ServerEcdhKey;

  /** 오류 문구에는 키 값을 싣지 않는다 */
  constructor(jwk: ServerEcdhJwk, previous?: ServerEcdhKey) {
    const j = jwk as unknown as Record<string, unknown>;
    if (j.kty !== 'EC' || j.crv !== 'P-256') throw new Error(`${PURCHASE_ECDH_KEY_ENV}는 P-256 JWK여야 한다(ECDH)`);
    if (typeof j.d !== 'string' || !COORD.test(j.d)) throw new Error(`${PURCHASE_ECDH_KEY_ENV}는 개인 JWK여야 한다(d가 없거나 모양이 틀렸다)`);
    if (typeof j.x !== 'string' || !COORD.test(j.x) || typeof j.y !== 'string' || !COORD.test(j.y)) throw new Error(`${PURCHASE_ECDH_KEY_ENV}의 공개 좌표(x·y)가 없거나 모양이 틀렸다`);
    if (typeof j.kid !== 'string' || !KID.test(j.kid)) throw new Error(`${PURCHASE_ECDH_KEY_ENV}에 kid가 없거나 모양이 틀렸다`);
    try {
      this.#priv = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: j.x, y: j.y, d: j.d }, format: 'jwk' });
    } catch {
      throw new Error(`${PURCHASE_ECDH_KEY_ENV}를 P-256 개인키로 읽지 못했다(좌표가 곡선 위의 점이 아니다)`);
    }
    // 공개 좌표가 개인 스칼라의 짝인지 본다: 짝이 아니면 입장 확정 응답의 공개키로 합의한 클라이언트 키와 서버 키가 어긋나 모든 요청이 401이 된다
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(j.d, 'base64url'));
    const pub = ecdh.getPublicKey();
    if (pub.subarray(1, 33).toString('base64url') !== j.x || pub.subarray(33).toString('base64url') !== j.y) {
      throw new Error(`${PURCHASE_ECDH_KEY_ENV}의 공개 좌표(x·y)가 개인 스칼라(d)의 짝이 아니다`);
    }
    this.kid = j.kid;
    this.#x = j.x;
    this.#y = j.y;
    this.previous = previous;
  }

  static fromEnv(env: Readonly<Record<string, string | undefined>>): ServerEcdhKey {
    const current = ServerEcdhKey.#parseJwk(env, PURCHASE_ECDH_KEY_ENV);
    const raw = env[PURCHASE_ECDH_KEY_PREV_ENV];
    const previous = raw === undefined || raw === '' ? undefined : new ServerEcdhKey(ServerEcdhKey.#parseJwk(env, PURCHASE_ECDH_KEY_PREV_ENV));
    const key = new ServerEcdhKey(current, previous);
    if (previous && previous.kid === key.kid) throw new Error(`${PURCHASE_ECDH_KEY_PREV_ENV}의 kid가 현재 키와 같다(키 교체는 다른 kid로 한다)`);
    return key;
  }

  static #parseJwk(env: Readonly<Record<string, string | undefined>>, name: string): ServerEcdhJwk {
    const raw = env[name];
    if (!raw) throw new Error(`${name}가 없다(구매 세션 서버 ECDH 개인 JWK, 비밀 관리에서 넣는다)`);
    let j: unknown;
    try {
      j = JSON.parse(raw);
    } catch {
      throw new Error(`${name}는 JWK JSON이어야 한다`);
    }
    if (j === null || typeof j !== 'object' || Array.isArray(j)) throw new Error(`${name}는 JWK 객체여야 한다`);
    return j as ServerEcdhJwk;
  }

  /** 짝이 되는 공개 JWK(개인 성분 없음). queue-svc가 입장 확정 응답에 싣는 PEAKET_PURCHASE_ECDH_PUBLIC_JWK와 같아야 한다 */
  publicJwk(): { kty: 'EC'; crv: 'P-256'; x: string; y: string; kid: string } {
    return { kty: 'EC', crv: 'P-256', x: this.#x, y: this.#y, kid: this.kid };
  }

  /** ECDH 공유 비밀(x 좌표 32바이트). 클라이언트 공개키는 parseClientEphemeralKey가 곡선 위의 점으로 확인한 것이어야 한다 */
  sharedSecret(clientPublic: KeyObject): Buffer {
    return diffieHellman({ privateKey: this.#priv, publicKey: clientPublic });
  }

  /** 현재 키와 옛 키(있으면)의 공유 비밀. 현재 키가 먼저다(키 교체 중 요청 인증은 모두 본다, BOT-100) */
  sharedSecrets(clientPublic: KeyObject): Buffer[] {
    const current = this.sharedSecret(clientPublic);
    return this.previous ? [current, this.previous.sharedSecret(clientPublic)] : [current];
  }
}
