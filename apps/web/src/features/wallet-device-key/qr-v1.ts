// QR v1 바이너리 형식(docs/features/offline-gate.md §3, POL-018, ADR-0025·0051 결정 7).
// 형식 버전(1바이트) ‖ 티켓 ID(UUIDv7, 16바이트) ‖ keyId(8바이트) ‖ 시각(4바이트 빅엔디언 UNIX 초) ‖ 서명(64바이트 ECDSA P-256 IEEE P1363) = 93바이트.
// 서명 대상은 "PEAKET-QR-v1" ‖ 티켓 ID ‖ keyId ‖ 시각이다. QR에는 base45(RFC 9285) 글자로 싣는다(93바이트 → 140자).
// 이 파일은 브라우저와 Node 단위 시험이 함께 쓰는 순수 함수만 둔다(WebCrypto 호출은 device-key.ts).

export const QR_V1_VERSION = 1;
export const QR_V1_HEADER = 'PEAKET-QR-v1';
export const QR_V1_BYTES = 93;
export const QR_V1_BASE45_LENGTH = 140;
export const QR_V1_TIME_BYTES = 4;
export const QR_V1_KEY_ID_BYTES = 8;
export const QR_V1_SIGNATURE_BYTES = 64;

export interface QrV1Fields {
  /** UUIDv7 글자(예: 0190f3a1-7c2e-7a00-8000-000000000101) */
  ticketId: string;
  /** 공개키 SPKI SHA-256 앞 8바이트 */
  keyId: Uint8Array;
  /** 부호 없는 32비트 빅엔디언 UNIX 초(2106년까지) */
  timeSeconds: number;
}

export interface QrV1Payload extends QrV1Fields {
  /** ECDSA P-256 IEEE P1363(r‖s) 64바이트 */
  signature: Uint8Array;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** UUIDv7 글자를 16바이트로. 형식 버전(7)과 RFC 4122 변형(10xx)을 확인한다 */
export function uuidV7ToBytes(uuid: string): Uint8Array {
  if (!UUID_SHAPE.test(uuid)) throw new Error('QR v1 티켓 ID는 UUID 형식이어야 합니다');
  const hex = uuid.replaceAll('-', '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  if ((out[6]! >> 4) !== 7) throw new Error('QR v1 티켓 ID는 UUIDv7이어야 합니다');
  if ((out[8]! & 0xc0) !== 0x80) throw new Error('QR v1 티켓 ID의 변형 비트가 RFC 4122가 아닙니다');
  return out;
}

export function bytesToUuidV7(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('UUID는 16바이트여야 합니다');
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uint32BE(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error('QR v1 시각은 부호 없는 32비트 정수여야 합니다');
  const out = new Uint8Array(4);
  out[0] = (value >>> 24) & 0xff;
  out[1] = (value >>> 16) & 0xff;
  out[2] = (value >>> 8) & 0xff;
  out[3] = value & 0xff;
  return out;
}

export function uint32FromBE(bytes: Uint8Array, offset = 0): number {
  if (bytes.length < offset + 4) throw new Error('4바이트가 모자랍니다');
  return ((bytes[offset]! << 24) >>> 0) + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** 서명 대상: "PEAKET-QR-v1" ‖ 티켓 ID ‖ keyId ‖ 시각(40바이트) */
export function qrV1Message(fields: QrV1Fields): Uint8Array {
  if (fields.keyId.length !== QR_V1_KEY_ID_BYTES) throw new Error('keyId는 8바이트여야 합니다');
  return concatBytes(new TextEncoder().encode(QR_V1_HEADER), uuidV7ToBytes(fields.ticketId), fields.keyId, uint32BE(fields.timeSeconds));
}

/** QR v1 93바이트를 만든다. 서명은 device-key.ts의 signQrV1이 만든 64바이트를 넣는다 */
export function encodeQrV1(payload: QrV1Payload): Uint8Array {
  if (payload.signature.length !== QR_V1_SIGNATURE_BYTES) throw new Error('서명은 64바이트여야 합니다');
  const out = new Uint8Array(QR_V1_BYTES);
  out[0] = QR_V1_VERSION;
  out.set(uuidV7ToBytes(payload.ticketId), 1);
  out.set(payload.keyId, 17);
  out.set(uint32BE(payload.timeSeconds), 25);
  out.set(payload.signature, 29);
  return out;
}

/** QR v1 93바이트를 풀어 검증에 쓴다. 형식 버전과 길이를 먼저 본다 */
export function decodeQrV1(bytes: Uint8Array): QrV1Payload {
  if (bytes.length !== QR_V1_BYTES) throw new Error(`QR v1은 ${QR_V1_BYTES}바이트여야 합니다(받은 ${bytes.length})`);
  if (bytes[0] !== QR_V1_VERSION) throw new Error(`지원하지 않는 QR 형식 버전 ${bytes[0]}입니다`);
  return {
    ticketId: bytesToUuidV7(bytes.slice(1, 17)),
    keyId: bytes.slice(17, 25),
    timeSeconds: uint32FromBE(bytes, 25),
    signature: bytes.slice(29, 93),
  };
}

// RFC 9285 base45. QR 영숫자 모드가 쓰는 45글자만 쓴다.
const BASE45_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const BASE45_VALUE = new Map(Array.from(BASE45_ALPHABET, (ch, i) => [ch, i]));

export function base45Encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 2) {
    if (i + 1 < bytes.length) {
      const n = bytes[i]! * 256 + bytes[i + 1]!;
      out += BASE45_ALPHABET[n % 45]! + BASE45_ALPHABET[Math.floor(n / 45) % 45]! + BASE45_ALPHABET[Math.floor(n / 2025)]!;
    } else {
      const n = bytes[i]!;
      out += BASE45_ALPHABET[n % 45]! + BASE45_ALPHABET[Math.floor(n / 45)]!;
    }
  }
  return out;
}

export function base45Decode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 3) {
    const left = text.length - i;
    const c0 = BASE45_VALUE.get(text[i]!);
    const c1 = left >= 2 ? BASE45_VALUE.get(text[i + 1]!) : undefined;
    if (c0 === undefined || c1 === undefined) throw new Error('base45 글자가 아닙니다');
    if (left >= 3) {
      const c2 = BASE45_VALUE.get(text[i + 2]!);
      if (c2 === undefined) throw new Error('base45 글자가 아닙니다');
      const n = c0 + c1 * 45 + c2 * 2025;
      if (n > 0xffff) throw new Error('base45 세 글자가 2바이트를 넘습니다');
      out.push(n >> 8, n & 0xff);
    } else if (left === 2) {
      const n = c0 + c1 * 45;
      if (n > 0xff) throw new Error('base45 두 글자가 1바이트를 넘습니다');
      out.push(n);
    } else {
      throw new Error('base45 마지막 묶음이 두 글자보다 짧습니다');
    }
  }
  return Uint8Array.from(out);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function base64UrlToBytes(text: string): Uint8Array {
  const padded = text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

/** keyId 8바이트를 저장·표시용 base64url 11자로 */
export function keyIdToBase64Url(keyId: Uint8Array): string {
  if (keyId.length !== QR_V1_KEY_ID_BYTES) throw new Error('keyId는 8바이트여야 합니다');
  return bytesToBase64Url(keyId);
}

export function keyIdFromBase64Url(text: string): Uint8Array {
  const bytes = base64UrlToBytes(text);
  if (bytes.length !== QR_V1_KEY_ID_BYTES) throw new Error('keyId는 8바이트여야 합니다');
  return bytes;
}
