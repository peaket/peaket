// 운영 시드 봉인(KMS Encrypt만, ADR-0239 결정 1·2·5). 실제 KMS는 test-int/kms-seed-sealer.int.test.ts(moto)가 본다.
import type { KMSClient } from '@aws-sdk/client-kms';
import { TestSeedSealer } from '@peaket/shuffle';
import { describe, expect, test } from 'vitest';
import { KmsSeedSealer, SeedSealUnavailable, seedSealerFromEnv } from '../src/modules/entry/adapters/kms-seed-sealer.js';

const KEY = 'arn:aws:kms:ap-northeast-2:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab';
const SECRET = Buffer.alloc(32, 7).toString('base64');
const clientOf = (send: (c: { input: Record<string, unknown>; constructor: { name: string } }) => unknown): KMSClient => ({ send: async (c: never) => send(c) }) as unknown as KMSClient;
const kms = () => clientOf(() => ({}));

describe('KmsSeedSealer', () => {
  test('[ASVS v5.0.0-11.3.2] [ASVS v5.0.0-13.3.2] Encrypt만 부르고 키와 암호화 컨텍스트를 건다', async () => {
    const names: string[] = [];
    let input: Record<string, unknown> = {};
    const s = new KmsSeedSealer(clientOf((c) => (names.push(c.constructor.name), (input = c.input), { CiphertextBlob: Buffer.from('blob') })), KEY);
    const sealed = await s.seal('evt-1', 'lobby', Buffer.alloc(32, 1));
    expect(sealed).toBe(Buffer.from('blob').toString('base64'));
    expect(names).toEqual(['EncryptCommand']);
    expect(input).toMatchObject({ KeyId: KEY, EncryptionContext: { purpose: 'peaket-shuffle-seed-v1', eventId: 'evt-1', group: 'lobby' } });
  });

  test('별칭은 받지 않는다', () => {
    expect(() => new KmsSeedSealer(kms(), 'alias/seed')).toThrow(/별칭/);
  });

  test('[ASVS v5.0.0-16.5.2] 실패하면 오류 이름만 싣는다', async () => {
    const seed = Buffer.alloc(32, 0xab);
    const boom = Object.assign(new Error(`bad ${seed.toString('hex')}`), { name: 'KMSInternalException' });
    const s = new KmsSeedSealer(clientOf(() => { throw boom; }), KEY);
    const err = (await s.seal('e', 1, seed).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(SeedSealUnavailable);
    expect(err.message).toContain('KMSInternalException');
    expect(`${err.message}${err.stack}`).not.toContain(seed.toString('hex'));
  });

  test('응답이 비면 쓰지 않는다', async () => {
    await expect(new KmsSeedSealer(clientOf(() => ({})), KEY).seal('e', 1, Buffer.alloc(32))).rejects.toBeInstanceOf(SeedSealUnavailable);
  });
});

describe('seedSealerFromEnv', () => {
  test('local·ci·demo: 시험 값이 있으면 시험 봉인, 없으면 봉인 없음이다', () => {
    for (const env of ['local', 'ci', 'demo']) {
      expect(seedSealerFromEnv({ PEAKET_ENV: env, PEAKET_TEST_BATCH_RANDOMNESS: SECRET }, kms)).toBeInstanceOf(TestSeedSealer);
      expect(seedSealerFromEnv({ PEAKET_ENV: env }, kms)).toBeUndefined();
    }
  });

  test('운영은 KMS 봉인이다', () => {
    expect(seedSealerFromEnv({ PEAKET_ENV: 'prod', PEAKET_SHUFFLE_SEED_KMS_KEY: KEY }, kms)).toBeInstanceOf(KmsSeedSealer);
    expect(seedSealerFromEnv({ PEAKET_SHUFFLE_SEED_KMS_KEY: KEY }, kms)).toBeInstanceOf(KmsSeedSealer);
  });

  test.each([
    ['PEAKET_ENV 없고 키 없음', {}],
    ['운영인데 키 없음', { PEAKET_ENV: 'prod' }],
    ['staging인데 키 없음', { PEAKET_ENV: 'staging' }],
    ['운영에 시험 값이 섞임', { PEAKET_ENV: 'prod', PEAKET_SHUFFLE_SEED_KMS_KEY: KEY, PEAKET_TEST_BATCH_RANDOMNESS: SECRET }],
    ['시험 값만 있는 운영', { PEAKET_ENV: 'prod', PEAKET_TEST_BATCH_RANDOMNESS: SECRET }],
    ['운영에서 KMS 끝점 바꾸기', { PEAKET_ENV: 'prod', PEAKET_SHUFFLE_SEED_KMS_KEY: KEY, PEAKET_KMS_ENDPOINT: 'http://127.0.0.1:1' }],
  ])('시작하지 않는다: %s', (_n, env) => {
    expect(() => seedSealerFromEnv(env, kms)).toThrow();
  });

  test('local·ci는 KMS 끝점을 받는다', () => {
    const seen: (string | undefined)[] = [];
    seedSealerFromEnv({ PEAKET_ENV: 'ci', PEAKET_SHUFFLE_SEED_KMS_KEY: KEY, PEAKET_KMS_ENDPOINT: 'http://127.0.0.1:4566' }, (endpoint) => (seen.push(endpoint), kms()));
    expect(seen).toEqual(['http://127.0.0.1:4566']);
  });
});
