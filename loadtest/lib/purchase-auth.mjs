// 구매 요청 인증(ADR-0050 결정 8, docs/frontend.md §5.3, docs/verification.md §3.9 'v1 경로'). k6 시나리오와 Node 시험이 같은 파일을 읽는다(node: 모듈을 쓰지 않는다).
// 규칙은 packages/platform/src/purchase-auth.ts와 같다:
//   요청 인증 키 = HKDF-SHA256(ECDH 공유 비밀, salt = 입장 토큰 jti(UTF-8), info = 'PEAKET-purchase-v1'), 32바이트(HMAC 한 블록이라 extract·expand를 HMAC 두 번으로 한다)
//   MAC 입력 = METHOD LF 경로와 쿼리 LF 일련번호(10진수) LF base64url(SHA-256(본문 바이트))
//   MAC = 채움 없는 base64url(HMAC-SHA256(키, MAC 입력의 UTF-8))
// HMAC-SHA256·SHA-256 원시 함수는 부르는 쪽이 넘긴다(k6는 k6/crypto, Node는 node:crypto). k6에는 ECDH가 없어 공유 비밀은 실행 도구가 이 PC에서 미리 계산해 넘긴다.
// 정해진 값: docs/api/vectors/purchase-request-mac.v1.json(서버·화면 시험과 같은 파일, loadtest/test/purchase-auth.test.mjs)

export const PURCHASE_KEY_INFO = 'PEAKET-purchase-v1';
export const PURCHASE_SEQ_HEADER = 'x-purchase-seq';
export const PURCHASE_MAC_HEADER = 'x-purchase-mac';
/** 일련번호 상한(서버 SEQ: 앞 0 없는 10진수 1 이상 2^53 − 1 이하) */
export const MAX_PURCHASE_SEQ = Number.MAX_SAFE_INTEGER;

/**
 * @typedef {{ hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array, sha256(data: Uint8Array): Uint8Array }} PurchaseCrypto
 */

/** UTF-8 바이트(서로게이트 쌍 포함). k6에 TextEncoder가 없어도 쓰게 직접 만든다 */
export function utf8(s) {
  const out = [];
  for (let i = 0; i < s.length; i += 1) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i += 1;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

/** 16진수 글 → 바이트(짝수 길이, 0-9a-f만. 아니면 RangeError) */
export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new RangeError('16진수 글이 아니다');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += (b < 16 ? '0' : '') + b.toString(16);
  return s;
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** 채움 없는 base64url */
export function b64url(bytes) {
  let s = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    s += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    s += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    s += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63];
  }
  return s;
}

/** base64url(채움 있거나 없음) → 바이트. 다른 글자가 있으면 RangeError */
export function fromB64url(s) {
  const clean = s.replace(/=+$/, '');
  const out = [];
  let bits = 0;
  let acc = 0;
  for (const ch of clean) {
    const v = B64URL.indexOf(ch);
    if (v < 0) throw new RangeError('base64url 글자가 아니다');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** UTF-8 바이트 → 글(JSON 본문 읽기용, 4바이트 글자 포함) */
function fromUtf8(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    let c;
    if (b < 0x80) (c = b), (i += 1);
    else if (b < 0xe0) (c = ((b & 31) << 6) | (bytes[i + 1] & 63)), (i += 2);
    else if (b < 0xf0) (c = ((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63)), (i += 3);
    else (c = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63)), (i += 4);
    s += String.fromCodePoint(c);
  }
  return s;
}

/** 입장 토큰(JWT)의 jti. 서명은 보지 않는다(서버가 본다, api-client/src/purchase/crypto.ts와 같다). 없거나 틀리면 RangeError */
export function admissionJti(token) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) throw new RangeError('입장 토큰은 점 셋으로 나뉜 JWT다');
  let claims;
  try {
    claims = JSON.parse(fromUtf8(fromB64url(parts[1])));
  } catch {
    throw new RangeError('입장 토큰 본문을 읽지 못했다');
  }
  if (!claims || typeof claims.jti !== 'string' || claims.jti === '') throw new RangeError('입장 토큰에 jti가 없다');
  return claims.jti;
}

/**
 * 요청 인증 키(32바이트)
 * @param {PurchaseCrypto} c @param {Uint8Array} sharedSecret @param {string} jti
 */
export function purchaseRequestKey(c, sharedSecret, jti) {
  if (!sharedSecret || sharedSecret.length === 0) throw new RangeError('공유 비밀이 비었다');
  if (!jti) throw new RangeError('jti가 비었다');
  const prk = c.hmacSha256(utf8(jti), sharedSecret);
  const info = utf8(PURCHASE_KEY_INFO);
  const t = new Uint8Array(info.length + 1);
  t.set(info);
  t[info.length] = 1;
  return c.hmacSha256(prk, t).slice(0, 32);
}

/**
 * @param {PurchaseCrypto} c @param {string} method @param {string} pathAndQuery @param {number} seq @param {Uint8Array} body
 */
export function purchaseMacInput(c, method, pathAndQuery, seq, body) {
  return `${method}\n${pathAndQuery}\n${seq}\n${b64url(c.sha256(body))}`;
}

/** @param {PurchaseCrypto} c @param {Uint8Array} key @param {string} input */
export function purchaseMac(c, key, input) {
  return b64url(c.hmacSha256(key, utf8(input)));
}

/**
 * 구매 세션 하나의 서명기: 일련번호는 1부터 부를 때마다 하나씩 올린다(같은 번호를 다시 쓰면 서버가 purchase-seq-reused로 거절한다.
 * 다시 보내기도 새 번호다). 본문은 보낼 그 글 그대로 받는다(바이트가 같아야 한다)
 */
export class PurchaseSigner {
  /** @param {PurchaseCrypto} c @param {Uint8Array} sharedSecret @param {string} admissionToken */
  constructor(c, sharedSecret, admissionToken) {
    this.c = c;
    this.key = purchaseRequestKey(c, sharedSecret, admissionJti(admissionToken));
    this.seq = 0;
  }

  /**
   * 다음 요청의 머리 둘
   * @param {string} method @param {string} pathAndQuery @param {string} body
   * @returns {Record<string, string>}
   */
  sign(method, pathAndQuery, body) {
    if (this.seq >= MAX_PURCHASE_SEQ) throw new RangeError('일련번호를 다 썼다');
    this.seq += 1;
    const mac = purchaseMac(this.c, this.key, purchaseMacInput(this.c, method, pathAndQuery, this.seq, utf8(body)));
    return { [PURCHASE_SEQ_HEADER]: String(this.seq), [PURCHASE_MAC_HEADER]: mac };
  }
}
