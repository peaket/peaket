// 감사 체크포인트 서명 키의 KMS 어댑터(ADR-0348 결정 4, docs/api/guidelines.md §8.1 '체크포인트 서명' 행).
// ECC_NIST_P256 비대칭 키로 SHA-256(체크포인트 JSON)을 Sign(MessageType DIGEST, SigningAlgorithm ECDSA_SHA_256)하고 DER을 받는다.
// 공개키는 GetPublicKey(SPKI DER)로 받고, 키 꼴(ECC_NIST_P256·SIGN_VERIFY·ECDSA_SHA_256)이 아니면 던진다.
// 시간 값은 연결 1초·요청 2초 [가정](§8.1 행). 게시 작업만 부르고, 실패하면 그 체크포인트는 다음 실행에서 다시 서명한다. 오류 글에는 오류 이름만 싣는다.
import { createHash } from 'node:crypto';
import { GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { kmsErrorName } from './kms-audit-mac-key.js';

const CONNECTION_TIMEOUT_MS = 1_000;
const REQUEST_TIMEOUT_MS = 2_000;
const MAX_ATTEMPTS = 2;

/** KMS 호출 면(시험은 대역이나 흉내 서버) */
export interface CheckpointSignClient {
  /** SHA-256 다이제스트(32바이트)를 서명해 DER을 돌려준다 */
  signDigest(keyId: string, digest: Uint8Array): Promise<Uint8Array>;
  /** 공개키 SPKI DER과 키 꼴 */
  publicKey(keyId: string): Promise<{ readonly spki: Uint8Array; readonly keySpec?: string; readonly keyUsage?: string; readonly signingAlgorithms?: readonly string[] }>;
}

/** 서명하지 못함(다음 실행에서 다시) */
export class CheckpointSignUnavailable extends Error {
  constructor(readonly errorName: string) {
    super(`checkpoint-sign-unavailable:${errorName}`);
    this.name = 'CheckpointSignUnavailable';
  }
}

export function kmsCheckpointSignerClient(o: { region: string; endpoint?: string }): CheckpointSignClient {
  const client = new KMSClient({
    region: o.region,
    ...(o.endpoint ? { endpoint: o.endpoint } : {}),
    maxAttempts: MAX_ATTEMPTS,
    requestHandler: { connectionTimeout: CONNECTION_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS, throwOnRequestTimeout: true },
  });
  return {
    async signDigest(keyId, digest) {
      const r = await client.send(new SignCommand({ KeyId: keyId, Message: digest, MessageType: 'DIGEST', SigningAlgorithm: 'ECDSA_SHA_256' }));
      if (!r.Signature) throw new Error('Sign 응답에 Signature가 없다');
      return r.Signature;
    },
    async publicKey(keyId) {
      const r = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
      if (!r.PublicKey) throw new Error('GetPublicKey 응답에 PublicKey가 없다');
      return {
        spki: r.PublicKey,
        ...(r.KeySpec ? { keySpec: r.KeySpec } : {}),
        ...(r.KeyUsage ? { keyUsage: r.KeyUsage } : {}),
        ...(r.SigningAlgorithms ? { signingAlgorithms: r.SigningAlgorithms } : {}),
      };
    },
  };
}

/** KMS 체크포인트 서명기. 공개키는 한 번 받아 둔다 */
export class KmsCheckpointSigner {
  readonly alg = 'ECDSA_P256_SHA256' as const;
  #spki: Buffer | undefined;

  constructor(
    private readonly client: CheckpointSignClient,
    readonly keyId: string,
  ) {
    if (!keyId) throw new Error('감사 체크포인트 KMS 키 ID가 없다');
  }

  async publicKeySpki(): Promise<Buffer> {
    if (this.#spki) return Buffer.from(this.#spki);
    let r: Awaited<ReturnType<CheckpointSignClient['publicKey']>>;
    try {
      r = await this.client.publicKey(this.keyId);
    } catch (e) {
      throw new CheckpointSignUnavailable(kmsErrorName(e));
    }
    if (r.keySpec !== undefined && r.keySpec !== 'ECC_NIST_P256') throw new Error('감사 체크포인트 서명 키는 ECC_NIST_P256이어야 한다');
    if (r.keyUsage !== undefined && r.keyUsage !== 'SIGN_VERIFY') throw new Error('감사 체크포인트 서명 키는 SIGN_VERIFY 용도여야 한다');
    if (r.signingAlgorithms !== undefined && !r.signingAlgorithms.includes('ECDSA_SHA_256')) throw new Error('감사 체크포인트 서명 키가 ECDSA_SHA_256을 받지 않는다');
    this.#spki = Buffer.from(r.spki);
    return Buffer.from(this.#spki);
  }

  async sign(message: Uint8Array): Promise<Buffer> {
    const digest = createHash('sha256').update(message).digest();
    try {
      return Buffer.from(await this.client.signDigest(this.keyId, digest));
    } catch (e) {
      throw new CheckpointSignUnavailable(kmsErrorName(e));
    }
  }
}
