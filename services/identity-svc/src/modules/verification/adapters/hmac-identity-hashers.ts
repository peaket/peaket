// 연계정보 HMAC과 pid의 설정값 키(docs/features/identity.md §5 '키 판·만 14세…', docs/security/secrets-and-keys.md 연계정보·pid 행).
// local·ci·demo에서만 쓴다. 운영은 KMS HMAC 키(kms-identity-hashers.ts). 연계정보 키는 판마다 따로 된 키이고, 보존 중인 모든 판으로 계산한다.
import { createHmac } from 'node:crypto';
import type { IdentityHashers } from '../domain/ports.js';

export const CI_HMAC_KEYS_ENV = 'PEAKET_CI_HMAC_KEYS';
/** 판 1 하나만 줄 때의 예전 이름 */
export const CI_HMAC_KEY_ENV = 'PEAKET_CI_HMAC_KEY';
export const PID_HMAC_KEY_ENV = 'PEAKET_PID_HMAC_KEY';
export const PID_HMAC_KEY_VERSION_ENV = 'PEAKET_PID_HMAC_KEY_VERSION';
/** 새 기록에 쓰는 판(없으면 가장 큰 판). 새 판은 모든 파드에 조회용으로 둔 뒤 이 값을 올린다(secrets-and-keys 연계정보 행) */
export const CI_HMAC_WRITE_VERSION_ENV = 'PEAKET_CI_HMAC_WRITE_VERSION';
const ALLOWED_ENVS = ['local', 'ci', 'demo'];

/** 판 번호(1 이상 정수) → 값 목록. JSON {"판": 값} */
export function parseVersions(raw: string, name: string): Map<number, string> {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    throw new Error(`${name}는 JSON {"판": 값}이다`);
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new Error(`${name}는 JSON {"판": 값}이다`);
  const out = new Map<number, string>();
  for (const [k, v] of Object.entries(o)) {
    const n = Number(k);
    if (!/^[1-9]\d{0,5}$/.test(k) || typeof v !== 'string' || v.length === 0) throw new Error(`${name}의 판 '${k}'가 틀렸다(1 이상 정수와 값)`);
    out.set(n, v);
  }
  if (out.size === 0) throw new Error(`${name}에 판이 하나도 없다`);
  return out;
}

export const writeVersionOf = (env: Record<string, string | undefined>): number | undefined => {
  const raw = env[CI_HMAC_WRITE_VERSION_ENV];
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d{0,5}$/.test(raw)) throw new Error(`${CI_HMAC_WRITE_VERSION_ENV}는 1 이상 정수다: ${raw}`);
  return Number(raw);
};

/** 첫째가 쓰기 판, 나머지는 큰 판부터. 쓰기 판이 목록에 없으면 던진다 */
export function orderVersions<T>(entries: [number, T][], writeVersion?: number): [number, T][] {
  const sorted = [...entries].sort((a, b) => b[0] - a[0]);
  const write = writeVersion ?? sorted[0]?.[0];
  const head = sorted.find(([v]) => v === write);
  if (!head) throw new Error(`쓰기 판 ${write}가 연계정보 키 판 목록에 없다`);
  return [head, ...sorted.filter(([v]) => v !== write)];
}

export const pidVersionOf = (env: Record<string, string | undefined>): number => {
  const raw = env[PID_HMAC_KEY_VERSION_ENV] ?? '1';
  if (!/^[1-9]\d{0,5}$/.test(raw)) throw new Error(`${PID_HMAC_KEY_VERSION_ENV}는 1 이상 정수다: ${raw}`);
  return Number(raw);
};

export class HmacIdentityHashers implements IdentityHashers {
  /** 첫째가 쓰기 판, 나머지는 큰 판부터 */
  readonly #ciKeys: [number, Buffer][];
  readonly #pidKey: Buffer;
  readonly #pidVersion: number;

  constructor(o: { ciKeys: Map<number, Buffer>; writeVersion?: number; pidKey: Buffer; pidVersion: number }) {
    if (o.ciKeys.size === 0) throw new Error('연계정보 HMAC 키 판이 하나도 없다');
    const seen: Buffer[] = [];
    for (const [v, k] of o.ciKeys) {
      if (!Number.isInteger(v) || v < 1) throw new Error(`연계정보 키 판은 1 이상 정수다: ${v}`);
      if (k.length !== 32) throw new Error('연계정보 HMAC 키는 32바이트다');
      if (k.equals(o.pidKey)) throw new Error('연계정보 키와 pid 키는 달라야 한다(키끼리 바꿔 쓰지 않는다)');
      if (seen.some((x) => x.equals(k))) throw new Error('연계정보 키 판끼리 같은 키를 쓰지 않는다');
      seen.push(k);
    }
    if (o.pidKey.length !== 32) throw new Error('pid HMAC 키는 32바이트다');
    this.#ciKeys = orderVersions([...o.ciKeys], o.writeVersion).map(([v, k]) => [v, Buffer.from(k)]);
    this.#pidKey = Buffer.from(o.pidKey);
    this.#pidVersion = o.pidVersion;
  }

  /** 연계정보 키 하나(판 1)와 pid 키(판 1). 시험용 */
  static single(ciKey: Buffer, pidKey: Buffer): HmacIdentityHashers {
    return new HmacIdentityHashers({ ciKeys: new Map([[1, ciKey]]), pidKey, pidVersion: 1 });
  }

  static fromEnv(env: Record<string, string | undefined>): HmacIdentityHashers {
    const peaketEnv = env.PEAKET_ENV ?? 'prod';
    if (!ALLOWED_ENVS.includes(peaketEnv)) throw new Error(`설정값 연계정보·pid 키는 ${ALLOWED_ENVS.join('·')}에서만 쓴다(운영은 KMS, 지금 ${peaketEnv})`);
    const pid = env[PID_HMAC_KEY_ENV];
    if (!pid) throw new Error(`${PID_HMAC_KEY_ENV}가 없다(base64 32바이트)`);
    const many = env[CI_HMAC_KEYS_ENV];
    const one = env[CI_HMAC_KEY_ENV];
    if (!many && !one) throw new Error(`${CI_HMAC_KEYS_ENV}(또는 ${CI_HMAC_KEY_ENV})가 없다(base64 32바이트)`);
    if (many && one) throw new Error(`${CI_HMAC_KEYS_ENV}와 ${CI_HMAC_KEY_ENV}는 하나만 준다`);
    const versions = many ? parseVersions(many, CI_HMAC_KEYS_ENV) : new Map([[1, one as string]]);
    return new HmacIdentityHashers({
      ciKeys: new Map([...versions].map(([v, k]) => [v, Buffer.from(k, 'base64')])),
      writeVersion: writeVersionOf(env),
      pidKey: Buffer.from(pid, 'base64'),
      pidVersion: pidVersionOf(env),
    });
  }

  versions(): number[] {
    return this.#ciKeys.map(([v]) => v);
  }

  pidVersion(): number {
    return this.#pidVersion;
  }

  async ciAll(ci: string) {
    return this.#ciKeys.map(([version, key]) => ({ hmac: createHmac('sha256', key).update(ci, 'utf8').digest(), version }));
  }

  async pid(ciHmac: Buffer) {
    return { pid: createHmac('sha256', this.#pidKey).update(ciHmac).digest(), version: this.#pidVersion };
  }
}
