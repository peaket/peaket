// 구매 세션 요청 서명의 암호 상수와 기본 요소(docs/frontend.md §5.3 '서명', ADR-0050 결정 8, ADR-0079 결정 6, ADR-0221 결정 2·3).
// 서버 쪽 같은 식은 packages/platform/src/purchase-auth.ts(purchaseRequestKey·purchaseMacInput·purchaseMac)이고, 두 쪽이 같은 시험 벡터
// docs/api/vectors/purchase-request-mac.v1.json을 읽는다(FE-T7). 암호는 브라우저 Web Cryptography API(crypto.subtle)만 쓴다(ASVS 11.2.1).
// 알고리즘·HKDF info·키 길이는 이 파일에서만 고른다(암호 민첩성, ASVS 11.2.2). 이 파일은 Node의 타입 지우기로도 돌 수 있게
// 지울 수 있는 타입 문법만 쓴다(세 엔진 검사 tools/web-checks/purchase가 그대로 내준다).

/** HKDF info(판을 바꾸면 v2). 서버 PURCHASE_KEY_INFO와 같다 */
export const PURCHASE_KEY_INFO = 'PEAKET-purchase-v1';
/** 요청 인증 키 길이(비트). deriveKey의 HMAC 매개변수에 length를 주지 않으면 해시 블록 크기(512비트)가 되어 서버와 달라진다 */
export const PURCHASE_KEY_BITS = 256;
/** 입장 토큰 jti 모양(서버 KEY_PART와 같다. 잠금 이름과 저장 키에 쓴다. 어긋나면 키를 만들어도 서버가 401로 거절한다) */
const JTI = /^[A-Za-z0-9_-]{1,64}$/;

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const HMAC = { name: 'HMAC', hash: 'SHA-256', length: PURCHASE_KEY_BITS } as const;

const enc = new TextEncoder();

/** base64url(덧붙임 없음) */
export function b64u(bytes: Uint8Array | ArrayBuffer): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url 풀기. 글자가 틀리면 던진다 */
export function fromB64u(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new TypeError('base64url이 아니다');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 입장 토큰(JWT) 본문의 jti와 exp(초). 서명은 확인하지 않는다(서버가 본다). 브라우저는 구매 세션 키의 이름(jti)과
 * 저장 기한(exp)만 읽는다. 모양이 틀리면 null
 */
export function admissionClaims(token: string): { jti: string; exp?: number } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromB64u(parts[1]!)));
  } catch {
    return null;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const { jti, exp } = body as { jti?: unknown; exp?: unknown };
  if (typeof jti !== 'string' || !JTI.test(jti)) return null;
  if (exp !== undefined && (typeof exp !== 'number' || !Number.isFinite(exp))) return null;
  return exp === undefined ? { jti } : { jti, exp };
}

/** 브라우저 임시 키 쌍(ECDH P-256). 개인키는 추출 불가이고, 공개키는 비압축 점(0x04 ‖ x ‖ y)의 base64url이다(openapi ClientEphemeralKey) */
export async function createClientKeyPair(subtle: SubtleCrypto): Promise<{ privateKey: CryptoKey; publicKey: string }> {
  const pair = (await subtle.generateKey(ECDH, false, ['deriveBits'])) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicKey: b64u(await subtle.exportKey('raw', pair.publicKey)) };
}

/** 서버 ECDH 공개키(입장 확정 응답의 JWK). P-256 공개 성분만 받는다 */
export interface ServerEcdhJwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
  kid?: string;
}

/** 서버 공개키와 합의한 공유 비밀(x 좌표 32바이트). 곡선 위의 점이 아니거나 P-256이 아니면 던진다 */
export async function sharedSecret(subtle: SubtleCrypto, privateKey: CryptoKey, server: ServerEcdhJwk): Promise<ArrayBuffer> {
  if (server.kty !== 'EC' || server.crv !== 'P-256' || typeof server.x !== 'string' || typeof server.y !== 'string') throw new TypeError('서버 공개키가 P-256 JWK가 아니다');
  // 공개 성분만 넘긴다(개인 성분 d가 섞여 와도 쓰지 않는다)
  const pub = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: server.x, y: server.y, ext: true }, ECDH, false, []);
  return subtle.deriveBits({ name: 'ECDH', public: pub }, privateKey, 256);
}

/** 요청 인증 키 = HKDF-SHA256(공유 비밀, salt = jti의 UTF-8, info = PEAKET-purchase-v1) → HMAC-SHA256 256비트, 서명에만 쓴다. extractable은 시험만 켠다 */
export async function requestKey(subtle: SubtleCrypto, secret: BufferSource, jti: string, extractable = false): Promise<CryptoKey> {
  const ikm = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(jti), info: enc.encode(PURCHASE_KEY_INFO) }, ikm, HMAC, extractable, ['sign']);
}

/** 본문 SHA-256의 base64url(본문이 없으면 빈 바이트의 해시) */
export async function bodyHash(subtle: SubtleCrypto, body: Uint8Array): Promise<string> {
  return b64u(await subtle.digest('SHA-256', body as Uint8Array<ArrayBuffer>));
}

/** MAC 입력: METHOD \n pathAndQuery \n seq \n base64url(SHA-256(body)). pathAndQuery는 보낸 주소의 경로와 쿼리를 호스트 없이 그대로 쓴다 */
export function macInput(method: string, pathAndQuery: string, seq: number, bodySha256B64u: string): string {
  return `${method}\n${pathAndQuery}\n${seq}\n${bodySha256B64u}`;
}

/** mac = base64url(HMAC-SHA256(key, utf8(MAC 입력))) */
export async function purchaseMac(subtle: SubtleCrypto, key: CryptoKey, method: string, pathAndQuery: string, seq: number, body: Uint8Array): Promise<string> {
  const input = macInput(method, pathAndQuery, seq, await bodyHash(subtle, body));
  return b64u(await subtle.sign('HMAC', key, enc.encode(input)));
}
