// 로컬·CI의 관리자 비밀번호 페퍼(KMS 대신 설정의 키 값으로 HMAC-SHA256, BUILD_ORDER BOT-110). 운영은 KmsPepper다.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AdminPepper } from '../domain/ports.js';

export class LocalPepper implements AdminPepper {
  readonly #keys: Map<number, Buffer>;
  constructor(
    keys: Map<number, Buffer>,
    readonly writeVersion: number,
  ) {
    for (const [v, k] of keys) {
      if (!(Number.isInteger(v) && v > 0)) throw new Error('페퍼 판은 양의 정수다');
      if (k.length !== 32) throw new Error('페퍼 키는 32바이트다');
    }
    if (!keys.has(writeVersion)) throw new Error(`쓰기 판 ${writeVersion}의 페퍼 키가 없다`);
    this.#keys = new Map([...keys].map(([v, k]) => [v, Buffer.from(k)]));
  }

  has(version: number): boolean {
    return this.#keys.has(version);
  }

  async mac(version: number, message: Uint8Array): Promise<Buffer> {
    const k = this.#keys.get(version);
    if (!k) throw new Error(`페퍼 판 ${version}이(가) 없다`);
    return createHmac('sha256', k).update(message).digest();
  }

  async verify(version: number, message: Uint8Array, mac: Uint8Array): Promise<boolean> {
    if (!this.#keys.has(version)) return false;
    const want = await this.mac(version, message);
    return want.length === mac.length && timingSafeEqual(want, Buffer.from(mac));
  }

  toJSON(): string {
    return '[LocalPepper]';
  }
}
