// 운영의 TOTP 시드 봉투 암호화(AWS KMS GenerateDataKey·Decrypt와 암호화 컨텍스트, docs/security/secrets-and-keys.md 'TOTP 시드 암호화 키', BUILD_ORDER BOT-120).
// KMS가 Decrypt 때 컨텍스트를 확인하고, GCM 태그가 암호문을 컨텍스트에 묶는다. 서울이 답하지 않으면 도쿄 복제 키로 한 번 넘긴다(BOT-131, ADR-0102).
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { type TotpSeedCipher, TotpKeyUnavailable, TotpSeedUnreadable } from '../domain/ports.js';
import { kmsFailoverFromEnv, replicaKeyId, requireFailoverOutsideLocal, withFailover } from './kms-failover.js';
import { LocalTotpSeedCipher } from './local-totp-seed-cipher.js';
import { contextAad, openSeed, parseSealed, sealSeed, totpContext } from './totp-seed-envelope.js';

export const TOTP_KMS_KEY_ENV = 'PEAKET_ADMIN_TOTP_KMS_KEY';
export const TOTP_LOCAL_KEY_ENV = 'PEAKET_ADMIN_TOTP_KEY';
const LOCAL_ENVS = ['local', 'ci'];
/** 컨텍스트가 다르거나 암호문이 그 키의 것이 아닐 때 KMS가 주는 오류 */
const UNREADABLE = new Set(['InvalidCiphertextException', 'IncorrectKeyException']);
const errorName = (e: unknown): string => {
  const n = (e as { name?: unknown } | null)?.name;
  return typeof n === 'string' ? n : 'Error';
};

export class KmsTotpSeedCipher implements TotpSeedCipher {
  constructor(
    private readonly client: KMSClient,
    private readonly keyId: string,
    /** 넘길 리전의 복제 키(BOT-131). 없으면 넘기지 않는다 */
    private readonly failover?: { client: KMSClient; keyId: string; onFailover?: (errorName: string) => void },
  ) {
    if (keyId.startsWith('alias/') || keyId.includes(':alias/')) throw new Error('KMS 별칭은 받지 않는다(키 ID나 키 ARN)');
  }

  async encrypt(accountId: string, seed: Uint8Array): Promise<Buffer> {
    const ctx = totpContext(accountId);
    let r;
    try {
      const f = this.failover;
      r = await withFailover(
        () => this.client.send(new GenerateDataKeyCommand({ KeyId: this.keyId, KeySpec: 'AES_256', EncryptionContext: ctx })),
        f ? () => f.client.send(new GenerateDataKeyCommand({ KeyId: f.keyId, KeySpec: 'AES_256', EncryptionContext: ctx })) : undefined,
        f?.onFailover,
      );
    } catch (e) {
      throw new TotpKeyUnavailable(errorName(e));
    }
    if (!r.Plaintext || !r.CiphertextBlob) throw new TotpKeyUnavailable('empty');
    const out = sealSeed(r.Plaintext, r.CiphertextBlob, seed, contextAad(ctx));
    r.Plaintext.fill(0);
    return out;
  }

  async decrypt(accountId: string, blob: Uint8Array): Promise<Buffer> {
    const ctx = totpContext(accountId);
    const p = parseSealed(blob);
    let key: Uint8Array;
    try {
      const f = this.failover;
      const r = await withFailover(
        () => this.client.send(new DecryptCommand({ KeyId: this.keyId, CiphertextBlob: p.encryptedDataKey, EncryptionContext: ctx })),
        f ? () => f.client.send(new DecryptCommand({ KeyId: f.keyId, CiphertextBlob: p.encryptedDataKey, EncryptionContext: ctx })) : undefined,
        f?.onFailover,
      );
      if (!r.Plaintext) throw new TotpKeyUnavailable('empty');
      key = r.Plaintext;
    } catch (e) {
      if (e instanceof TotpKeyUnavailable) throw e;
      if (UNREADABLE.has(errorName(e))) throw new TotpSeedUnreadable(errorName(e));
      throw new TotpKeyUnavailable(errorName(e));
    }
    try {
      return openSeed(key, p, contextAad(ctx));
    } finally {
      key.fill(0);
    }
  }

  toJSON(): string {
    return '[KmsTotpSeedCipher]';
  }
}

/**
 * 설정: KMS 키가 있으면 KMS, 없고 local·ci면 키 값, 둘 다 없으면 null(2단계를 통과할 수 없다). 운영에서 키 값은 받지 않는다.
 * client(끝점, 리전): 서울은 (PEAKET_KMS_ENDPOINT, AWS_REGION), 넘길 리전은 (PEAKET_KMS_FAILOVER_ENDPOINT, PEAKET_KMS_FAILOVER_REGION)
 */
export function totpSeedCipherFromEnv(env: Record<string, string | undefined>, client: (endpoint: string | undefined, region: string) => KMSClient, onFailover?: (use: 'totp', errorName: string) => void): TotpSeedCipher | null {
  const peaketEnv = env.PEAKET_ENV ?? 'prod';
  const local = LOCAL_ENVS.includes(peaketEnv);
  const keyId = env[TOTP_KMS_KEY_ENV];
  if (keyId) {
    const endpoint = env.PEAKET_KMS_ENDPOINT;
    if (endpoint && !local) throw new Error(`PEAKET_KMS_ENDPOINT는 ${LOCAL_ENVS.join('·')}에서만 쓴다(지금 ${peaketEnv})`);
    const failover = kmsFailoverFromEnv(env);
    requireFailoverOutsideLocal(env, failover, 'TOTP 시드 키');
    const primary = client(endpoint, env.AWS_REGION ?? 'ap-northeast-2');
    if (!failover) return new KmsTotpSeedCipher(primary, keyId);
    return new KmsTotpSeedCipher(primary, keyId, { client: client(failover.endpoint, failover.region), keyId: replicaKeyId(keyId, failover.region), onFailover: (name) => onFailover?.('totp', name) });
  }
  const raw = env[TOTP_LOCAL_KEY_ENV];
  if (!raw) return null;
  if (!local) throw new Error(`${TOTP_LOCAL_KEY_ENV}(TOTP 시드 키 값)는 ${LOCAL_ENVS.join('·')}에서만 쓴다. 운영은 ${TOTP_KMS_KEY_ENV}`);
  return new LocalTotpSeedCipher(Buffer.from(raw, 'base64'));
}
