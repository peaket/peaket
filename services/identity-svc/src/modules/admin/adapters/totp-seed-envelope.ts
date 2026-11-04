// TOTP 시드 봉투 암호화의 공통 꼴(identity §6 '관리 계정 TOTP와 로그인 2단계의 첫 구현', ADR-0050·ADR-0053 결정 7, BUILD_ORDER BOT-120).
// 저장 꼴: 판 1바이트(1) ‖ 암호화한 데이터 키 길이 2바이트 ‖ 암호화한 데이터 키 ‖ IV 12바이트 ‖ 태그 16바이트 ‖ 암호문.
// 시드는 데이터 키로 AES-256-GCM 암호화하고, 추가 인증 데이터는 암호화 컨텍스트의 정렬한 JSON이다(다른 계정 행으로 옮기면 태그가 맞지 않는다).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { TotpSeedUnreadable } from '../domain/ports.js';

export const TOTP_PURPOSE = 'peaket-admin-totp-v1';
const VERSION = 1;

export const totpContext = (accountId: string): Record<string, string> => ({ accountId, purpose: TOTP_PURPOSE });
/** 키를 정렬한 JSON(추가 인증 데이터) */
export const contextAad = (ctx: Record<string, string>): Buffer =>
  Buffer.from(
    JSON.stringify(
      Object.keys(ctx)
        .sort()
        .reduce<Record<string, string>>((o, k) => ((o[k] = ctx[k]!), o), {}),
    ),
    'utf8',
  );

export function sealSeed(dataKey: Uint8Array, encryptedDataKey: Uint8Array, seed: Uint8Array, aad: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dataKey, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(seed), c.final()]);
  const head = Buffer.alloc(3);
  head.writeUInt8(VERSION, 0);
  head.writeUInt16BE(encryptedDataKey.length, 1);
  return Buffer.concat([head, Buffer.from(encryptedDataKey), iv, c.getAuthTag(), ct]);
}

/** 꼴을 읽는다. 틀리면 TotpSeedUnreadable */
export function parseSealed(blob: Uint8Array): { encryptedDataKey: Buffer; iv: Buffer; tag: Buffer; ct: Buffer } {
  const b = Buffer.from(blob);
  if (b.length < 3 || b.readUInt8(0) !== VERSION) throw new TotpSeedUnreadable('version');
  const n = b.readUInt16BE(1);
  // 빈 데이터 키나 KMS 한도(6,144바이트)를 넘는 데이터 키는 키 서비스를 부르지 않고 '풀 수 없음'이다
  if (n === 0 || n > 6144 || b.length < 3 + n + 12 + 16 + 1) throw new TotpSeedUnreadable('length');
  return { encryptedDataKey: b.subarray(3, 3 + n), iv: b.subarray(3 + n, 15 + n), tag: b.subarray(15 + n, 31 + n), ct: b.subarray(31 + n) };
}

export function openSeed(dataKey: Uint8Array, p: { iv: Buffer; tag: Buffer; ct: Buffer }, aad: Buffer): Buffer {
  try {
    const d = createDecipheriv('aes-256-gcm', dataKey, p.iv);
    d.setAAD(aad);
    d.setAuthTag(p.tag);
    return Buffer.concat([d.update(p.ct), d.final()]);
  } catch {
    throw new TotpSeedUnreadable('tag');
  }
}
