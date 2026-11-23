// 스캐너 쪽 QR v1 풀기·서명 검증(offline-gate §3, 계획 docs/review/plans/F-05-4.md §3).
// - 형식: 버전(1) ‖ 티켓 ID(16) ‖ keyId(8) ‖ 시각(4, 부호 없는 32비트 빅엔디언 초) ‖ 서명(64, P-256 IEEE P1363), 93바이트
// - 글자: base45(RFC 9285). 서명 대상: "PEAKET-QR-v1" ‖ 티켓 ID ‖ keyId ‖ 시각
// - 월렛(apps/web)의 코드를 가져오지 않는다. 스캐너가 검증에 필요한 만큼만 직접 둔다.
// - Node 시험(node --test)이 그대로 읽는 파일이다: 매개변수 속성·enum 없이, 상대 가져오기는 .ts 확장자로 쓴다.

export interface ScannedQr {
  version: 1;
  ticketId: string;
  /** 8바이트 base64url(11자) */
  keyId: string;
  timestampSec: number;
  /** 서명 대상 40바이트(PEAKET-QR-v1 ‖ 티켓 ID ‖ keyId ‖ 시각) */
  message: Uint8Array;
  /** P-256 IEEE P1363(r ‖ s) 64바이트 */
  signature: Uint8Array;
}

export type ParseQrResult = { ok: true; qr: ScannedQr } | { ok: false; reason: 'INVALID_QR' | 'UNSUPPORTED_VERSION' };

const B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const HEADER = new TextEncoder().encode('PEAKET-QR-v1');
const PAYLOAD_BYTES = 93;

/** RFC 9285 base45 풀기. 글자 집합·길이·묶음 값이 어긋나면 undefined */
export function decodeBase45(text: string): Uint8Array | undefined {
  if (text.length === 0) return undefined;
  const out: number[] = [];
  let i = 0;
  for (; i + 2 < text.length; i += 3) {
    const a = B45.indexOf(text[i]!);
    const b = B45.indexOf(text[i + 1]!);
    const c = B45.indexOf(text[i + 2]!);
    if (a < 0 || b < 0 || c < 0) return undefined;
    const n = a + b * 45 + c * 2025;
    if (n > 0xffff) return undefined;
    out.push((n >> 8) & 0xff, n & 0xff);
  }
  const left = text.length - i;
  if (left === 1) return undefined;
  if (left === 2) {
    const a = B45.indexOf(text[i]!);
    const b = B45.indexOf(text[i + 1]!);
    if (a < 0 || b < 0) return undefined;
    const n = a + b * 45;
    if (n > 0xff) return undefined;
    out.push(n);
  }
  return new Uint8Array(out);
}

const u32be = (b: Uint8Array, at: number): number => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

function hexOf(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function uuidOf(bytes: Uint8Array): string {
  const h = hexOf(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function b64uOf(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * QR 글자를 푼다. 풀리지 않거나 형식이 어긋나면 INVALID_QR, 형식 버전이 1이 아니면 UNSUPPORTED_VERSION.
 * 버전이 1이 아닌 값은 길이와 상관없이 UNSUPPORTED_VERSION이다.
 */
export function parseQrV1(raw: string): ParseQrResult {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'INVALID_QR' };
  const bytes = decodeBase45(raw);
  if (!bytes || bytes.length === 0) return { ok: false, reason: 'INVALID_QR' };
  if (bytes[0] !== 1) return { ok: false, reason: 'UNSUPPORTED_VERSION' };
  if (bytes.length !== PAYLOAD_BYTES) return { ok: false, reason: 'INVALID_QR' };
  const ticket = bytes.slice(1, 17);
  const keyId = bytes.slice(17, 25);
  const time = bytes.slice(25, 29);
  const message = concat(HEADER, ticket, keyId, time);
  return {
    ok: true,
    qr: {
      version: 1,
      ticketId: uuidOf(ticket),
      keyId: b64uOf(keyId),
      timestampSec: u32be(bytes, 25),
      message,
      signature: bytes.slice(29, 93),
    },
  };
}

// ---- P-256 압축 공개키 풀기 ----
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

function mod(a: bigint, m = P): bigint {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

function modPow(base: bigint, exp: bigint, m = P): bigint {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

function bigIntTo32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function fromB64u(text: string): Uint8Array {
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** 압축 공개키(0x02/0x03 ‖ x, base64url)를 raw 65바이트로 푼다. 읽지 못하면 던진다 */
export function compressedToRaw(publicKey: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = fromB64u(publicKey);
  } catch {
    throw new Error('압축 공개키가 base64url이 아니다');
  }
  if (bytes.length !== 33 || (bytes[0] !== 0x02 && bytes[0] !== 0x03)) throw new Error('압축 공개키의 길이나 접두가 P-256이 아니다');
  const x = bytesToBigInt(bytes.slice(1));
  if (x >= P) throw new Error('공개키의 x가 곡선 범위 밖이다');
  const rhs = mod(x * x * x - 3n * x + B);
  const y = modPow(rhs, (P + 1n) / 4n);
  if (mod(y * y) !== rhs) throw new Error('곡선 위의 점이 아니다');
  const wantOdd = bytes[0] === 0x03;
  const yOdd = (y & 1n) === 1n;
  const yFinal = wantOdd === yOdd ? y : P - y;
  const raw = new Uint8Array(65);
  raw[0] = 0x04;
  raw.set(bigIntTo32(x), 1);
  raw.set(bigIntTo32(yFinal), 33);
  return raw;
}

/** 압축 공개키가 읽히는 모양인가(변경분 KEY_REGISTERED의 publicKey 검사). 던지지 않는다 */
export function isReadablePublicKey(publicKey: string): boolean {
  try {
    compressedToRaw(publicKey);
    return true;
  } catch {
    return false;
  }
}

/** 서명이 맞는가. 키를 읽지 못하면 던진다(검증 자체가 실패하면 false) */
export async function verifyQrSignature(publicKey: string, qr: ScannedQr): Promise<boolean> {
  const raw = compressedToRaw(publicKey);
  const key = await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  try {
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, qr.signature as BufferSource, qr.message as BufferSource);
  } catch {
    return false;
  }
}
