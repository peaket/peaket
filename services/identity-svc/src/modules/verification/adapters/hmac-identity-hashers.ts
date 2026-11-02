// 연계정보 HMAC과 pid(docs/features/identity.md §5, docs/security/secrets-and-keys.md 연계정보·pid 행). 지금은 설정값 키(판 1)다.
// 운영은 KMS HMAC 키(키 버전 조회, 다중 리전)로 바꾼다(BUILD_ORDER BOT-020).
import { createHmac } from 'node:crypto';
import type { IdentityHashers } from '../domain/ports.js';

export const CI_HMAC_KEY_ENV = 'PEAKET_CI_HMAC_KEY';
export const PID_HMAC_KEY_ENV = 'PEAKET_PID_HMAC_KEY';

export class HmacIdentityHashers implements IdentityHashers {
  readonly #ciKey: Buffer;
  readonly #pidKey: Buffer;

  constructor(ciKey: Buffer, pidKey: Buffer) {
    if (ciKey.length !== 32 || pidKey.length !== 32) throw new Error('연계정보·pid HMAC 키는 32바이트다');
    if (ciKey.equals(pidKey)) throw new Error('연계정보 키와 pid 키는 달라야 한다(키끼리 바꿔 쓰지 않는다)');
    this.#ciKey = Buffer.from(ciKey);
    this.#pidKey = Buffer.from(pidKey);
  }

  static fromEnv(env: Record<string, string | undefined>): HmacIdentityHashers {
    const ci = env[CI_HMAC_KEY_ENV];
    const pid = env[PID_HMAC_KEY_ENV];
    if (!ci || !pid) throw new Error(`${CI_HMAC_KEY_ENV}·${PID_HMAC_KEY_ENV}가 없다(base64 32바이트, 비밀 관리에서 넣는다)`);
    return new HmacIdentityHashers(Buffer.from(ci, 'base64'), Buffer.from(pid, 'base64'));
  }

  ci(ci: string) {
    return { hmac: createHmac('sha256', this.#ciKey).update(ci, 'utf8').digest(), version: 1 };
  }

  pid(ciHmac: Buffer) {
    return { pid: createHmac('sha256', this.#pidKey).update(ciHmac).digest(), version: 1 };
  }

  toJSON(): string {
    return '[HmacIdentityHashers]';
  }
}
