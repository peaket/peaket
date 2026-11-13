// 월렛 입장용 기기 키(FR-012, ADR-0025, ADR-0050 결정 1, ADR-0051 결정 10, offline-gate §2).
// - WebCrypto ECDSA P-256 키쌍을 extractable=false로 만든다. 개인키는 페이지 스크립트가 꺼낼 수 없고,
//   IndexedDB에는 CryptoKey 객체 그대로(구조화 복제) 둔다. 서버에는 공개키 JWK만 보낸다.
// - keyId는 공개키 SPKI의 SHA-256 앞 8바이트다(QR v1). 공개키는 extractable=true로 만들어지므로 내보낼 수 있다.
// - 키는 '이 휴대폰을 입장용으로 등록' 버튼으로만 만든다(ADR-0051 결정 10). 이 파일은 그 버튼이 부른다.
import { keyIdToBase64Url, qrV1Message, QR_V1_SIGNATURE_BYTES, type QrV1Fields } from './qr-v1.ts';

export interface DeviceKey {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
  /** QR v1에 싣는 8바이트 */
  keyId: Uint8Array;
  /** 저장·표시용 base64url 11자 */
  keyIdText: string;
}

const ALGORITHM: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_ALGORITHM: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' };

function subtleOf(subtle?: SubtleCrypto): SubtleCrypto {
  const value = subtle ?? globalThis.crypto?.subtle;
  if (!value) throw new Error('WebCrypto를 쓸 수 없는 브라우저입니다');
  return value;
}

/** 공개키 SPKI의 SHA-256 앞 8바이트(keyId) */
export async function keyIdOfPublicKey(publicKey: CryptoKey, subtle?: SubtleCrypto): Promise<Uint8Array> {
  const spki = await subtleOf(subtle).exportKey('spki', publicKey);
  const digest = await subtleOf(subtle).digest('SHA-256', spki);
  return new Uint8Array(digest).slice(0, 8);
}

/** 공개키 JWK. 개인키 칸(d)이 있으면 정의 밖이므로 버린다 */
export async function publicKeyJwkOf(publicKey: CryptoKey, subtle?: SubtleCrypto): Promise<JsonWebKey> {
  const jwk = await subtleOf(subtle).exportKey('jwk', publicKey);
  const rest = { ...jwk };
  delete rest.d;
  return rest;
}

/** ECDSA P-256 키쌍을 만들고 keyId·공개키 JWK를 함께 돌려준다. 개인키는 꺼낼 수 없다 */
export async function generateDeviceKey(subtle?: SubtleCrypto): Promise<DeviceKey> {
  const api = subtleOf(subtle);
  const pair = (await api.generateKey(ALGORITHM, false, ['sign', 'verify'])) as CryptoKeyPair;
  if (pair.privateKey.extractable) throw new Error('기기 개인키가 꺼낼 수 있는 상태로 만들어졌습니다');
  const keyId = await keyIdOfPublicKey(pair.publicKey, api);
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicKeyJwk: await publicKeyJwkOf(pair.publicKey, api),
    keyId,
    keyIdText: keyIdToBase64Url(keyId),
  };
}

/** QR v1 서명 대상에 서명해 64바이트 IEEE P1363 서명을 돌려준다 */
export async function signQrV1(privateKey: CryptoKey, fields: QrV1Fields, subtle?: SubtleCrypto): Promise<Uint8Array> {
  const signature = new Uint8Array(await subtleOf(subtle).sign(SIGN_ALGORITHM, privateKey, qrV1Message(fields) as BufferSource));
  if (signature.length !== QR_V1_SIGNATURE_BYTES) throw new Error(`ECDSA 서명은 64바이트여야 합니다(받은 ${signature.length})`);
  return signature;
}

/** 시험·스캐너 대조용 서명 확인. 실제 스캐너는 등록된 공개키로 확인한다 */
export async function verifyQrV1(publicKey: CryptoKey, fields: QrV1Fields, signature: Uint8Array, subtle?: SubtleCrypto): Promise<boolean> {
  return subtleOf(subtle).verify(SIGN_ALGORITHM, publicKey, signature as BufferSource, qrV1Message(fields) as BufferSource);
}

/** 저장한 공개키 JWK를 확인용 CryptoKey로 되돌린다(시험·오프라인 대조) */
export async function importPublicKeyJwk(jwk: JsonWebKey, subtle?: SubtleCrypto): Promise<CryptoKey> {
  return subtleOf(subtle).importKey('jwk', jwk, ALGORITHM, true, ['verify']);
}
