// 관리 계정 비밀번호 해시(identity §6 '관리 계정 비밀번호 저장과 정책의 첫 구현', ADR-0033, ADR-0050 결정 9, BUILD_ORDER BOT-110).
// PBKDF2-HMAC-SHA256(원문 NFC의 UTF-8, 솔트 16바이트, 600,000회, 32바이트) → 페퍼 MAC(입력 "admin-pw-v1" ‖ 관리 계정 ID 16바이트 ‖ PBKDF2 결과).
// 저장 문자열: $pbkdf2-sha256$i={반복},k={페퍼 판}${솔트}${MAC}(base64 패딩 없음). 확인은 페퍼 키 서비스의 VerifyMac이 한다.
import { pbkdf2, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import type { AdminPasswords, AdminPepper } from '../domain/ports.js';

const pbkdf2Async = promisify(pbkdf2);
export const ADMIN_PBKDF2_MIN_ITERATIONS = 600_000;
/** 저장 문자열에서 받는 반복 횟수의 위 끝 [가정]. 넘으면 맞지 않는 것으로 본다(스레드풀을 오래 붙잡거나 pbkdf2가 던지지 않게, 새 맥락 리뷰 2026-11-05) */
export const ADMIN_PBKDF2_MAX_ITERATIONS = 10_000_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
/** 복구 코드(80비트 난수)의 반복 횟수 [가정](identity §6 '관리 계정 TOTP와 로그인 2단계의 첫 구현') */
export const RECOVERY_CODE_ITERATIONS = 10_000;
const PHC = /^\$pbkdf2-sha256\$i=(\d+),k=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64').replace(/=+$/, '');
const unb64 = (s: string) => Buffer.from(s, 'base64');
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** UUID 문자열 → 16바이트(UUID가 아니면 null) */
function uuidBytes(id: string): Buffer | null {
  return UUID.test(id) ? Buffer.from(id.replace(/-/g, ''), 'hex') : null;
}
/** 저장 문자열을 읽는다. 꼴·반복 횟수 범위·솔트·MAC 길이가 틀리면 null */
function parsePhc(phc: string): { iterations: number; version: number; salt: Buffer; mac: Buffer } | null {
  const m = PHC.exec(phc);
  if (!m) return null;
  const iterations = Number(m[1]);
  const version = Number(m[2]);
  if (!(Number.isSafeInteger(iterations) && iterations >= 1 && iterations <= ADMIN_PBKDF2_MAX_ITERATIONS && Number.isSafeInteger(version))) return null;
  const salt = unb64(m[3]!);
  const mac = unb64(m[4]!);
  if (salt.length !== SALT_BYTES || mac.length !== KEY_BYTES) return null;
  return { iterations, version, salt, mac };
}

export class Pbkdf2AdminPasswords implements AdminPasswords {
  readonly #iterations: number;
  /** 페퍼 입력의 맥락 앞머리(비밀번호 admin-pw-v1, 복구 코드 admin-rc-v1) */
  readonly #context: Buffer;
  constructor(
    private readonly pepper: AdminPepper,
    o: { iterations?: number; context?: 'admin-pw-v1' | 'admin-rc-v1' } = {},
  ) {
    this.#context = Buffer.from(o.context ?? 'admin-pw-v1', 'utf8');
    this.#iterations = o.iterations ?? ADMIN_PBKDF2_MIN_ITERATIONS;
    if (!(Number.isInteger(this.#iterations) && this.#iterations > 0 && this.#iterations <= ADMIN_PBKDF2_MAX_ITERATIONS)) throw new Error(`PBKDF2 반복 횟수는 1~${ADMIN_PBKDF2_MAX_ITERATIONS}의 정수다`);
  }

  async hash(accountId: string, raw: string): Promise<string> {
    const id = uuidBytes(accountId);
    if (!id) throw new Error('관리 계정 ID는 UUID다');
    const salt = randomBytes(SALT_BYTES);
    const dk = await pbkdf2Async(raw.normalize('NFC'), salt, this.#iterations, KEY_BYTES, 'sha256');
    const v = this.pepper.writeVersion;
    const mac = await this.pepper.mac(v, Buffer.concat([this.#context, id, dk]));
    return `$pbkdf2-sha256$i=${this.#iterations},k=${v}$${b64(salt)}$${b64(mac)}`;
  }

  async verify(accountId: string, raw: string, phc: string): Promise<boolean> {
    const p = parsePhc(phc);
    const id = uuidBytes(accountId);
    if (!p || !id || !this.pepper.has(p.version)) return false;
    const dk = await pbkdf2Async(raw.normalize('NFC'), p.salt, p.iterations, KEY_BYTES, 'sha256');
    return this.pepper.verify(p.version, Buffer.concat([this.#context, id, dk]), p.mac);
  }

  async burn(raw: string): Promise<void> {
    await pbkdf2Async(raw.normalize('NFC'), randomBytes(SALT_BYTES), this.#iterations, KEY_BYTES, 'sha256');
  }

  needsRehash(phc: string): boolean {
    const p = parsePhc(phc);
    if (!p) return true;
    return p.iterations < this.#iterations || p.version !== this.pepper.writeVersion;
  }
}
