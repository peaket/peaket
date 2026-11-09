// 운영 시드 풀기(KMS Decrypt만, ADR-0239 결정 1·2). 실제 KMS는 test-int/kms-seed.int.test.ts(moto)가 본다.
import { randomBytes } from 'node:crypto';
import type { KMSClient } from '@aws-sdk/client-kms';
import { describe, expect, test } from 'vitest';
import { KmsSeedOpener, SeedKeyUnavailable } from '../src/modules/batch/adapters/kms-seed-opener.js';

const KEY = 'arn:aws:kms:ap-northeast-2:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab';
const clientOf = (send: (c: { input: Record<string, unknown>; constructor: { name: string } }) => unknown): KMSClient => ({ send: async (c: never) => send(c) }) as unknown as KMSClient;

describe('KmsSeedOpener', () => {
  test('[ASVS v5.0.0-11.3.2] [ASVS v5.0.0-13.3.2] Decrypt만 부르고 키와 암호화 컨텍스트를 건다', async () => {
    const seen: string[] = [];
    let input: Record<string, unknown> = {};
    const plain = new Uint8Array(randomBytes(32));
    const copy = Buffer.from(plain);
    const o = new KmsSeedOpener(clientOf((c) => (seen.push(c.constructor.name), (input = c.input), { Plaintext: plain })), KEY);
    const out = await o.open('evt-1', 'lobby', Buffer.from('sealed-bytes').toString('base64'));
    expect(out.equals(copy)).toBe(true);
    expect(seen).toEqual(['DecryptCommand']);
    expect(input).toMatchObject({ KeyId: KEY, EncryptionContext: { purpose: 'peaket-shuffle-seed-v1', eventId: 'evt-1', group: 'lobby' } });
    expect(Buffer.from(input.CiphertextBlob as Uint8Array).toString()).toBe('sealed-bytes');
    // SDK가 준 버퍼는 지운다
    expect(plain.every((b) => b === 0)).toBe(true);
  });

  test('구간이 숫자면 컨텍스트 값은 문자열이다', async () => {
    let ctx: unknown;
    const o = new KmsSeedOpener(clientOf((c) => ((ctx = c.input.EncryptionContext), { Plaintext: Buffer.alloc(32) })), KEY);
    await o.open('evt-1', 1, 'AA==');
    expect(ctx).toEqual({ purpose: 'peaket-shuffle-seed-v1', eventId: 'evt-1', group: '1' });
  });

  test('별칭은 받지 않는다', () => {
    expect(() => new KmsSeedOpener(clientOf(() => ({})), 'alias/seed')).toThrow(/별칭/);
    expect(() => new KmsSeedOpener(clientOf(() => ({})), 'arn:aws:kms:ap-northeast-2:1:alias/seed')).toThrow(/별칭/);
  });

  test('[ASVS v5.0.0-16.5.2] 호출이 실패하면 오류 이름만 싣는다', async () => {
    const secret = 'PLAINTEXT-MUST-NOT-LEAK';
    const boom = Object.assign(new Error(`bad ${secret}`), { name: 'InvalidCiphertextException', $response: { body: secret } });
    const o = new KmsSeedOpener(clientOf(() => { throw boom; }), KEY);
    const err = (await o.open('e', 1, 'AA==').catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(SeedKeyUnavailable);
    expect(err.message).toContain('InvalidCiphertextException');
    expect(JSON.stringify({ m: err.message, s: err.stack, e: { ...err } })).not.toContain(secret);
  });

  test('평문이 비면 쓰지 않는다', async () => {
    const o = new KmsSeedOpener(clientOf(() => ({})), KEY);
    await expect(o.open('e', 1, 'AA==')).rejects.toBeInstanceOf(SeedKeyUnavailable);
  });

  test('[ASVS v5.0.0-11.3.2] 직렬화해도 키 정보를 내지 않는다', () => {
    expect(JSON.stringify(new KmsSeedOpener(clientOf(() => ({})), KEY))).toBe('"[KmsSeedOpener]"');
  });
});
