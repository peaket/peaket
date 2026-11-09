// 로컬·CI의 TOTP 시드 봉투 암호화(키 값 PEAKET_ADMIN_TOTP_KEY로 데이터 키를 AES-256-GCM으로 감싼다, BUILD_ORDER BOT-120). 운영은 KMS(kms-totp-seed-cipher.ts).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { type TotpSeedCipher, TotpSeedUnreadable } from '../domain/ports.js';
import { contextAad, openSeed, parseSealed, sealSeed, totpContext } from './totp-seed-envelope.js';

export class LocalTotpSeedCipher implements TotpSeedCipher {
  readonly #key: Buffer;
  constructor(key: Uint8Array) {
    if (key.length !== 32) throw new Error('TOTP 시드 키 값은 32바이트다');
    this.#key = Buffer.from(key);
  }

  async encrypt(accountId: string, seed: Uint8Array): Promise<Buffer> {
    const aad = contextAad(totpContext(accountId));
    const dataKey = randomBytes(32);
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.#key, iv);
    c.setAAD(aad);
    const wrapped = Buffer.concat([iv, Buffer.concat([c.update(dataKey), c.final()]), c.getAuthTag()]);
    return sealSeed(dataKey, wrapped, seed, aad);
  }

  async decrypt(accountId: string, blob: Uint8Array): Promise<Buffer> {
    const aad = contextAad(totpContext(accountId));
    const p = parseSealed(blob);
    const w = p.encryptedDataKey;
    if (w.length !== 12 + 32 + 16) throw new TotpSeedUnreadable('wrapped');
    let dataKey: Buffer;
    try {
      const d = createDecipheriv('aes-256-gcm', this.#key, w.subarray(0, 12));
      d.setAAD(aad);
      d.setAuthTag(w.subarray(44));
      dataKey = Buffer.concat([d.update(w.subarray(12, 44)), d.final()]);
    } catch {
      throw new TotpSeedUnreadable('wrap');
    }
    return openSeed(dataKey, p, aad);
  }

  toJSON(): string {
    return '[LocalTotpSeedCipher]';
  }
}
