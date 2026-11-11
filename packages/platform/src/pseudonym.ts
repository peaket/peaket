// 로그 가명과 IP 앞부분(ADR-0053 결정 1, docs/observability.md §2·§7, openspec 변경 add-service-logging 결정 4).
// 운영 로그·추적의 사람 식별값(pid·세션 ID·계정 ID)은 HMAC-SHA256(로그 가명 키, 값)의 앞 16바이트(base64url)로만 남긴다.
import { createHmac, createSecretKey, type KeyObject, randomBytes } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import { DEBUG_ERRORS_ALLOWED, PEAKET_ENVS, type PeaketEnv, PlatformConfigError } from './config.js';

export const LOG_PSEUDONYM_KEY_ENV = 'PEAKET_LOG_PSEUDONYM_KEY';
const KEY_BYTES = 32;
const REF_BYTES = 16;

/** 키를 안에만 두는 가명 함수. 객체를 글로 바꿔도 키가 드러나지 않는다 */
export class LogPseudonymizer {
  readonly #key: KeyObject;
  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) throw new PlatformConfigError(`로그 가명 키는 ${KEY_BYTES}바이트여야 한다`);
    // 요청마다 createHmac에 Buffer를 넘기면 Node가 KeyObject를 다시 만든다(프로파일에서 HMAC 한 번에 39µs).
    // 키 객체를 한 번만 만들어 두면 같은 값으로 13µs다(BAT-031, 동작 불변)
    this.#key = createSecretKey(Buffer.from(key));
  }

  /** HMAC-SHA256(키, 값)의 앞 16바이트(base64url, 22자) */
  ref(value: string): string {
    return createHmac('sha256', this.#key).update(value, 'utf8').digest().subarray(0, REF_BYTES).toString('base64url');
  }

  toJSON(): string {
    return '[LogPseudonymizer]';
  }

  toString(): string {
    return '[LogPseudonymizer]';
  }
}

function decodeKey(raw: string): Buffer | undefined {
  // base64와 base64url을 함께 받는다. 다른 글자가 섞이면 받지 않는다
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) return undefined;
  const key = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return key.length === KEY_BYTES ? key : undefined;
}

/**
 * 환경 변수의 로그 가명 키(External Secrets Operator가 넣는다)로 가명 함수를 만든다.
 * 운영 쪽 환경(demo·staging·prod, 환경 없음 포함)은 키가 없거나 틀리면 시작하지 않는다(닫힘 실패).
 * local·ci는 키가 없으면 프로세스마다 무작위 키를 쓰고 경고를 돌려준다
 */
export function loadLogPseudonymizer(env: Record<string, string | undefined>): { pseudonymizer: LogPseudonymizer; warning?: string } {
  const rawEnv = env.PEAKET_ENV;
  const peaketEnv = ((PEAKET_ENVS as readonly string[]).includes(rawEnv ?? '') ? rawEnv : 'prod') as PeaketEnv;
  const raw = env[LOG_PSEUDONYM_KEY_ENV];
  if (raw === undefined || raw === '') {
    if (!DEBUG_ERRORS_ALLOWED.includes(peaketEnv)) {
      throw new PlatformConfigError(`${LOG_PSEUDONYM_KEY_ENV}가 없다. ${peaketEnv}에서는 로그 가명 키 없이 시작하지 않는다(ADR-0053 결정 1)`);
    }
    return {
      pseudonymizer: new LogPseudonymizer(randomBytes(KEY_BYTES)),
      warning: `${LOG_PSEUDONYM_KEY_ENV}가 없어 이 프로세스만의 무작위 키를 쓴다. 다시 뜨면 가명이 이어지지 않는다(${peaketEnv})`,
    };
  }
  const key = decodeKey(raw);
  if (!key) throw new PlatformConfigError(`${LOG_PSEUDONYM_KEY_ENV}는 base64(또는 base64url)로 적은 ${KEY_BYTES}바이트여야 한다`);
  return { pseudonymizer: new LogPseudonymizer(key) };
}

function expandIPv6(ip: string): string[] | undefined {
  const halves = ip.split('::');
  if (halves.length > 2) return undefined;
  const part = (s: string) => (s === '' ? [] : s.split(':'));
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  // 끝에 IPv4가 붙은 표기(::ffff:a.b.c.d)는 두 칸으로 센다
  const last = tail.length ? tail[tail.length - 1] : head[head.length - 1];
  const v4Tail = last !== undefined && last.includes('.');
  const count = head.length + tail.length + (v4Tail ? 1 : 0);
  if (halves.length === 1 ? count !== 8 : count > 7) return undefined;
  const zeros = Array(8 - count).fill('0');
  return [...head, ...(halves.length === 2 ? zeros : []), ...tail];
}

/**
 * IP의 앞부분(IPv4 /24, IPv6 /48). 키 없는 해시는 IPv4 전체를 계산해 되돌릴 수 있어 쓰지 않는다(ADR-0053 결정 1).
 * IPv4가 든 IPv6(::ffff:a.b.c.d)는 IPv4로 본다. 형식이 틀리면 undefined(값을 쓰지 않는다)
 */
export function ipPrefix(ip: string): string | undefined {
  const bare = ip.split('%')[0];
  if (isIPv4(bare)) return `${bare.split('.').slice(0, 3).join('.')}.0/24`;
  if (!isIPv6(bare)) return undefined;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  if (mapped && isIPv4(mapped[1])) return ipPrefix(mapped[1]);
  const groups = expandIPv6(bare.toLowerCase());
  if (!groups) return undefined;
  const head = groups.slice(0, 3).map((g) => g.replace(/^0+(?=.)/, ''));
  while (head.length && head[head.length - 1] === '0') head.pop();
  return `${head.join(':')}::/48`;
}
