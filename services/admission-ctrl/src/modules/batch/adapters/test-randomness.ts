// 시험용 시드·비콘(local·ci·demo에서만): 설정한 비밀에서 묶음마다 다른 값을 만든다. 운영의 시드는 KMS 봉인과 오픈 10분 전 커밋 공시,
// 비콘은 drand 공시 라운드다(BUILD_ORDER HOT-040). 이 값은 비밀을 아는 사람이 미리 계산할 수 있어 공정성 증명이 되지 않는다.
// 설정: PEAKET_TEST_BATCH_RANDOMNESS = base64 비밀(32바이트 이상), PEAKET_ENV = local·ci·demo
import { createHmac } from 'node:crypto';
import type { Beacon, SeedSource } from '../domain/ports.js';

export const TEST_RANDOMNESS_ENV = 'PEAKET_TEST_BATCH_RANDOMNESS';
const ALLOWED_ENVS = ['local', 'ci', 'demo'];

export class TestRandomness implements SeedSource, Beacon {
  readonly #secret: Buffer;

  constructor(secret: Buffer) {
    if (secret.length < 32) throw new Error('시험 시드·비콘 비밀은 32바이트 이상이다');
    this.#secret = Buffer.from(secret);
  }

  static fromEnv(env: Record<string, string | undefined>): TestRandomness {
    if (!ALLOWED_ENVS.includes(env.PEAKET_ENV ?? '')) throw new Error('시험 시드·비콘은 local·ci·demo에서만 켠다(운영은 KMS 시드와 drand 비콘, BUILD_ORDER HOT-040)');
    const raw = env[TEST_RANDOMNESS_ENV];
    if (!raw) throw new Error(`${TEST_RANDOMNESS_ENV}가 없다(base64 32바이트 이상)`);
    return new TestRandomness(Buffer.from(raw, 'base64'));
  }

  async seed(eventId: string, batchNo: number): Promise<Buffer> {
    return createHmac('sha256', this.#secret).update(`batch-seed\0${eventId}\0${batchNo}`).digest();
  }

  async value(eventId: string, batchNo: number): Promise<Buffer | null> {
    return createHmac('sha256', this.#secret).update(`batch-beacon\0${eventId}\0${batchNo}`).digest();
  }
}
