// TOTP(RFC 6238, HMAC-SHA1, 6자리, 30초)와 base32, 복구 코드 꼴(identity §6 '관리 계정 TOTP와 로그인 2단계의 첫 구현', BUILD_ORDER BOT-120).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_PERIOD_S = 30;
export const TOTP_DIGITS = 6;
/** 지금 칸 뒤로 받는 시간 칸 수. 0이면 코드 하나는 그 30초 칸에서만 맞는다(ASVS 6.5.5 '최대 30초', docs/security/asvs/auth.md '엄격히', 새 맥락 리뷰 2026-11-05) */
export const TOTP_BACK_STEPS = 0;
export const TOTP_SEED_BYTES = 20;

/** 그 시간 칸의 코드(RFC 4226 HOTP 동적 자르기) */
export function totpAt(seed: Uint8Array, step: number, digits = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', seed).update(counter).digest();
  const off = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[off]! & 0x7f) << 24) | (mac[off + 1]! << 16) | (mac[off + 2]! << 8) | mac[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const stepOf = (nowMs: number): number => Math.floor(nowMs / 1000 / TOTP_PERIOD_S);

/** 맞으면 그 시간 칸, 아니면 null. lastStep 이하의 칸은 받지 않는다(같은 코드 재사용 막기). 칸마다 같은 시간에 견준다 */
export function matchTotp(seed: Uint8Array, code: string, nowMs: number, lastStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = stepOf(nowMs);
  const given = Buffer.from(code, 'ascii');
  let found: number | null = null;
  for (let d = -TOTP_BACK_STEPS; d <= 0; d++) {
    const step = now + d;
    const ok = timingSafeEqual(Buffer.from(totpAt(seed, step), 'ascii'), given);
    if (ok && found === null && (lastStep === null || step > lastStep)) found = step;
  }
  return found;
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(b: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of b) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.toUpperCase().replace(/=+$/, '')) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('base32 꼴이 아니다');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSeed = (): Buffer => randomBytes(TOTP_SEED_BYTES);

export function otpauthUri(seed: Uint8Array, email: string): string {
  const label = encodeURIComponent(`PEAKET:${email}`);
  return `otpauth://totp/${label}?secret=${base32Encode(seed)}&issuer=PEAKET&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_S}`;
}

// ── 복구 코드: Crockford base32 16자(80비트), 4자씩 붙임표 ──
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const RECOVERY_CODE_COUNT = 10;
export function newRecoveryCode(): string {
  const b = randomBytes(10);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of b) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{4}/g)!.join('-');
}
/** 사람이 넣은 복구 코드를 견줄 꼴로(대문자, 붙임표·빈칸 지우기, 헷갈리는 글자 O→0·I/L→1). 꼴이 아니면 null */
export function normalizeRecoveryCode(input: string): string | null {
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{16}$/.test(s) ? s : null;
}
