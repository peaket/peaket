// 입장용 기기 공개키의 값·검사 규칙(FR-012, POL-018, ADR-0025·0050·0051, offline-gate §2·§3).
// 월렛이 보낸 P-256 공개키 JWK에서 keyId(SPKI SHA-256 앞 8바이트)와 압축 공개키(33바이트)를 만든다.
// 개인키는 받지 않는다. d 칸이 있으면 계약(@ContractBody)과 여기서 모두 거절한다.
import { createHash, createPublicKey } from 'node:crypto';

export type DeviceKeyReason = 'ISSUE' | 'REISSUE' | 'TRANSFER' | 'BOOTH';

export interface PublicKeyJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  ext?: boolean;
  key_ops?: ('verify')[];
  alg?: 'ES256';
}

export interface DeviceKeyMaterial {
  /** QR v1에 싣는 8바이트 */
  keyId: Uint8Array;
  /** 스캐너 목록에 싣는 압축 P-256 공개키 33바이트 */
  publicKey: Uint8Array;
}

export class DeviceKeyInputError extends Error {
  constructor(readonly code: 'JWK' | 'KEY_ID' | 'REASON' | 'BOOTH_REQUEST') {
    super(`기기 키 입력 오류: ${code}`);
    this.name = 'DeviceKeyInputError';
  }
}

const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_KEY_ID = /^[A-Za-z0-9_-]{11}$/;

const bytesOfBase64Url = (text: string): Buffer => Buffer.from(text.replaceAll('-', '+').replaceAll('_', '/'), 'base64');

/** JWK 모양을 검사하고 keyId·압축 공개키를 만든다. 곡선 위의 점인지는 Node가 검증한다 */
export function deviceKeyMaterialOf(jwk: PublicKeyJwk): DeviceKeyMaterial {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !BASE64URL_32.test(jwk.x) || !BASE64URL_32.test(jwk.y)) throw new DeviceKeyInputError('JWK');
  if ('d' in (jwk as unknown as Record<string, unknown>)) throw new DeviceKeyInputError('JWK');
  let spki: Buffer;
  try {
    spki = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' }).export({ type: 'spki', format: 'der' });
  } catch {
    throw new DeviceKeyInputError('JWK');
  }
  const x = bytesOfBase64Url(jwk.x);
  const y = bytesOfBase64Url(jwk.y);
  if (x.length !== 32 || y.length !== 32) throw new DeviceKeyInputError('JWK');
  const compressed = new Uint8Array(33);
  compressed[0] = (y[31]! & 1) === 1 ? 0x03 : 0x02;
  compressed.set(x, 1);
  return { keyId: new Uint8Array(createHash('sha256').update(spki).digest()).slice(0, 8), publicKey: compressed };
}

/** QR·스캔 기록의 keyId(base64url 11자)를 8바이트로. 모양이 틀리면 undefined */
export function keyIdBytesOf(text: unknown): Uint8Array | undefined {
  if (typeof text !== 'string' || !BASE64URL_KEY_ID.test(text)) return undefined;
  const bytes = bytesOfBase64Url(text);
  return bytes.length === 8 ? new Uint8Array(bytes) : undefined;
}

export function keyIdTextOf(keyId: Uint8Array): string {
  if (keyId.length !== 8) throw new DeviceKeyInputError('KEY_ID');
  return Buffer.from(keyId).toString('base64url');
}

export function publicKeyTextOf(publicKey: Uint8Array): string {
  return Buffer.from(publicKey).toString('base64url');
}

export function assertReason(v: unknown): DeviceKeyReason {
  if (v === 'ISSUE' || v === 'REISSUE' || v === 'TRANSFER' || v === 'BOOTH') return v;
  throw new DeviceKeyInputError('REASON');
}
