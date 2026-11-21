// 공개 감사 체크포인트 서명(ADR-0348 결정 4, docs/security/secrets-and-keys.md '감사 체크포인트 서명 키').
// 서명 = ECDSA P-256 / SHA-256(체크포인트 JSON 바이트), DER을 base64로 둔다. 서명은 게시 작업 audit-anchor만 한다(API 프로세스에는 키가 없다).
// 운영: KMS 비대칭 키(PEAKET_AUDIT_CHECKPOINT_KMS_KEY_ID, Sign MessageType DIGEST·ECDSA_SHA_256, adapters/kms-checkpoint-signer.ts).
// local·ci: 같은 알고리즘의 P-256 PKCS8 PEM(PEAKET_AUDIT_CHECKPOINT_LOCAL_KEY, \n은 글자 그대로 둘 수 있다)이나 시작 때 만든 임시 키(경고 한 줄).
// local·ci 밖에서 KMS 키 ID가 없으면 시작하지 않는다(던짐). 확인은 공개키(SPKI)만으로 누구나 한다(verifyCheckpointSignature).
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { kmsCheckpointSignerClient, KmsCheckpointSigner, type CheckpointSignClient } from './adapters/kms-checkpoint-signer.js';

/** 공개 JSON·API의 signatureAlg 값 */
export const CHECKPOINT_SIGNATURE_ALG = 'ECDSA_P256_SHA256';
export const AUDIT_CHECKPOINT_KMS_KEY_ID_ENV = 'PEAKET_AUDIT_CHECKPOINT_KMS_KEY_ID';
export const AUDIT_CHECKPOINT_LOCAL_KEY_ENV = 'PEAKET_AUDIT_CHECKPOINT_LOCAL_KEY';
const KMS_ENDPOINT_ENV = 'PEAKET_KMS_ENDPOINT';
/** 로컬 키·임시 키·흉내 끝점을 허락하는 환경(ADR-0348 결정 4: local·ci만) */
export const CHECKPOINT_SIGNER_OPEN_ENVS: readonly string[] = ['local', 'ci'];

/** 체크포인트 서명기. sign은 메시지 바이트(체크포인트 JSON)를 받아 SHA-256 위 ECDSA 서명(DER)을 낸다 */
export interface CheckpointSigner {
  readonly keyId: string;
  readonly alg: typeof CHECKPOINT_SIGNATURE_ALG;
  /** 공개키 SPKI(DER). KMS는 GetPublicKey로 받는다 */
  publicKeySpki(): Promise<Buffer>;
  /** ECDSA P-256 / SHA-256 서명(DER) */
  sign(message: Uint8Array): Promise<Buffer>;
}

const isP256 = (k: KeyObject): boolean => k.asymmetricKeyType === 'ec' && k.asymmetricKeyDetails?.namedCurve === 'prime256v1';

/** 메모리 키 서명기(local·ci·시험). 같은 알고리즘이라 서명 꼴이 KMS와 같다 */
export class LocalCheckpointSigner implements CheckpointSigner {
  readonly alg = CHECKPOINT_SIGNATURE_ALG;
  readonly #private: KeyObject;
  readonly #spki: Buffer;

  constructor(
    privateKeyPem: string,
    readonly keyId: string,
  ) {
    const key = createPrivateKey({ key: privateKeyPem, format: 'pem' });
    if (!isP256(key)) throw new Error('감사 체크포인트 서명 키는 ECDSA P-256(prime256v1)이어야 한다');
    this.#private = key;
    this.#spki = createPublicKey(key).export({ type: 'spki', format: 'der' });
  }

  async publicKeySpki(): Promise<Buffer> {
    return Buffer.from(this.#spki);
  }

  async sign(message: Uint8Array): Promise<Buffer> {
    return sign('sha256', message, { key: this.#private, dsaEncoding: 'der' });
  }
}

/** 시작 때 만든 임시 P-256 키(시험·로컬). 재시작하면 새 키다(공개키는 audit_signing_key에 남는다) */
export function ephemeralCheckpointSigner(keyId = `local-ephemeral-${Date.now().toString(36)}`): LocalCheckpointSigner {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return new LocalCheckpointSigner(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), keyId);
}

/**
 * 공개키(SPKI DER)로 체크포인트 서명(DER의 base64)을 확인한다. 꼴이 틀리면 거짓
 */
export function verifyCheckpointSignature(publicKeySpki: Uint8Array, message: Uint8Array, signatureB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeySpki), format: 'der', type: 'spki' });
    if (!isP256(key)) return false;
    const sig = Buffer.from(signatureB64, 'base64');
    if (sig.length === 0 || sig.toString('base64') !== signatureB64) return false;
    return verify('sha256', message, { key, dsaEncoding: 'der' }, sig);
  } catch {
    return false;
  }
}

/** SPKI DER → PEM(공개 파일 public-keys.json·공개 앵커 응답) */
export function spkiPem(spki: Uint8Array): string {
  return createPublicKey({ key: Buffer.from(spki), format: 'der', type: 'spki' }).export({ type: 'spki', format: 'pem' }).toString();
}

export interface CheckpointSignerFromEnv {
  readonly signer: CheckpointSigner;
  readonly warning?: string;
}

/**
 * 환경 값으로 서명기를 고른다.
 * @throws Error local·ci 밖에서 KMS 키 ID가 없음, local 키·흉내 끝점을 local·ci 밖에서 씀, local 키가 P-256 PEM이 아님
 */
export function checkpointSignerFromEnv(env: Record<string, string | undefined>, o: { envName: string; client?: (c: { region: string; endpoint?: string }) => CheckpointSignClient }): CheckpointSignerFromEnv {
  const open = CHECKPOINT_SIGNER_OPEN_ENVS.includes(o.envName);
  const keyId = env[AUDIT_CHECKPOINT_KMS_KEY_ID_ENV]?.trim();
  const endpoint = env[KMS_ENDPOINT_ENV]?.trim() || undefined;
  const local = env[AUDIT_CHECKPOINT_LOCAL_KEY_ENV]?.replace(/\\n/g, '\n').trim();
  if (endpoint && !open) throw new Error(`${KMS_ENDPOINT_ENV}는 ${CHECKPOINT_SIGNER_OPEN_ENVS.join('·')}에서만 쓴다(지금 ${o.envName})`);
  if (local && !open) throw new Error(`${AUDIT_CHECKPOINT_LOCAL_KEY_ENV}는 ${CHECKPOINT_SIGNER_OPEN_ENVS.join('·')}에서만 쓴다(지금 ${o.envName}, 운영은 KMS 키)`);
  if (keyId) {
    const region = env.AWS_REGION?.trim() || 'ap-northeast-2';
    const make = o.client ?? kmsCheckpointSignerClient;
    return { signer: new KmsCheckpointSigner(make({ region, ...(endpoint ? { endpoint } : {}) }), keyId) };
  }
  if (!open) throw new Error(`${AUDIT_CHECKPOINT_KMS_KEY_ID_ENV}가 없다(감사 체크포인트 서명 키. ${CHECKPOINT_SIGNER_OPEN_ENVS.join('·')}만 로컬·임시 키를 쓴다)`);
  if (local) {
    try {
      return { signer: new LocalCheckpointSigner(local, 'local') };
    } catch (e) {
      throw new Error(`${AUDIT_CHECKPOINT_LOCAL_KEY_ENV}가 P-256 PKCS8 PEM이 아니다: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }
  return { signer: ephemeralCheckpointSigner(), warning: `${AUDIT_CHECKPOINT_KMS_KEY_ID_ENV}·${AUDIT_CHECKPOINT_LOCAL_KEY_ENV}가 없어 시작 때 만든 임시 P-256 키로 서명한다(공개키는 audit_signing_key에 남는다)` };
}
