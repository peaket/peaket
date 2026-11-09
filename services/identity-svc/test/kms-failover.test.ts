// 관리 계정 KMS 호출의 복제 키 넘기기(docs/features/identity.md §6 '관리 계정 KMS 호출의 복제 키 넘기기의 첫 구현', BUILD_ORDER BOT-131, ADR-0102).
// 넘기는 오류와 넘기지 않는 거절, 복제 키 ID, 설정 검사, 페퍼·TOTP 어댑터의 넘김을 대역으로 본다(실제 다중 리전 키는 test-int/kms-failover.int.test.ts).
import type { KMSClient } from '@aws-sdk/client-kms';
import { describe, expect, test } from 'vitest';
import { isKmsUnavailable, kmsFailoverFromEnv, replicaKeyId } from '../src/modules/admin/adapters/kms-failover.js';
import { adminPepperFromEnv, failoverPepperClient, KmsPepper, type PepperMacClient } from '../src/modules/admin/adapters/kms-pepper.js';
import { KmsTotpSeedCipher, totpSeedCipherFromEnv } from '../src/modules/admin/adapters/kms-totp-seed-cipher.js';
import { PepperUnavailable, TotpSeedUnreadable } from '../src/modules/admin/domain/ports.js';

const SEOUL_ARN = 'arn:aws:kms:ap-northeast-2:111122223333:key/mrk-1234abcd12ab34cd56ef1234567890ab';
const TOKYO_ARN = 'arn:aws:kms:ap-northeast-1:111122223333:key/mrk-1234abcd12ab34cd56ef1234567890ab';
const err = (name: string, status?: number) => Object.assign(new Error(name), { name, ...(status ? { $metadata: { httpStatusCode: status } } : {}) });

describe('넘기는 때(ADR-0102)', () => {
  test('응답이없거나서버쪽오류·한도면넘기고_거절은넘기지않는다', () => {
    for (const e of [err('TimeoutError'), Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), err('KMSInternalException', 500), err('DependencyTimeoutException', 503), err('KeyUnavailableException', 500), err('ThrottlingException', 400), err('ServiceUnavailable', 503)]) {
      expect(isKmsUnavailable(e), e.name).toBe(true);
    }
    for (const e of [err('KMSInvalidMacException', 400), err('InvalidCiphertextException', 400), err('IncorrectKeyException', 400), err('AccessDeniedException', 400), err('NotFoundException', 400), err('DisabledException', 400), err('KMSInvalidStateException', 400), err('ValidationException', 400)]) {
      expect(isKmsUnavailable(e), e.name).toBe(false);
    }
  });

  test('복제키ID는ARN이면리전칸만바꾸고키ID면그대로이며_다중리전키가아니면받지않는다', () => {
    expect(replicaKeyId(SEOUL_ARN, 'ap-northeast-1')).toBe(TOKYO_ARN);
    expect(replicaKeyId('mrk-1234abcd12ab34cd56ef1234567890ab', 'ap-northeast-1')).toBe('mrk-1234abcd12ab34cd56ef1234567890ab');
    expect(() => replicaKeyId('1234abcd-12ab-34cd-56ef-1234567890ab', 'ap-northeast-1')).toThrow(/다중 리전/);
    expect(() => replicaKeyId('arn:aws:kms:ap-northeast-2:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab', 'ap-northeast-1')).toThrow(/다중 리전/);
  });

  test('설정_넘길리전이없으면local·ci밖에서는페퍼·TOTP키를KMS로쓸수없고_끝점은local·ci만이다', () => {
    const keys = { PEAKET_ADMIN_PEPPER_KMS_KEYS: JSON.stringify({ 1: SEOUL_ARN }) };
    const client = (): PepperMacClient => ({ mac: async () => Buffer.alloc(32), verify: async () => true });
    expect(() => adminPepperFromEnv({ PEAKET_ENV: 'prod', ...keys }, client)).toThrow(/PEAKET_KMS_FAILOVER_REGION/);
    expect(adminPepperFromEnv({ PEAKET_ENV: 'prod', PEAKET_KMS_FAILOVER_REGION: 'ap-northeast-1', ...keys }, client)).toBeInstanceOf(KmsPepper);
    expect(adminPepperFromEnv({ PEAKET_ENV: 'ci', ...keys }, client)).toBeInstanceOf(KmsPepper);
    // 넘길 리전이 있으면 다중 리전 키여야 한다
    expect(() => adminPepperFromEnv({ PEAKET_ENV: 'prod', PEAKET_KMS_FAILOVER_REGION: 'ap-northeast-1', PEAKET_ADMIN_PEPPER_KMS_KEYS: JSON.stringify({ 1: '1234abcd-12ab-34cd-56ef-1234567890ab' }) }, client)).toThrow(/다중 리전/);
    const kms = (() => ({ send: async () => ({}) })) as unknown as () => KMSClient;
    expect(() => totpSeedCipherFromEnv({ PEAKET_ENV: 'prod', PEAKET_ADMIN_TOTP_KMS_KEY: SEOUL_ARN }, kms)).toThrow(/PEAKET_KMS_FAILOVER_REGION/);
    expect(totpSeedCipherFromEnv({ PEAKET_ENV: 'prod', PEAKET_KMS_FAILOVER_REGION: 'ap-northeast-1', PEAKET_ADMIN_TOTP_KMS_KEY: SEOUL_ARN }, kms)).toBeInstanceOf(KmsTotpSeedCipher);
    expect(() => kmsFailoverFromEnv({ PEAKET_ENV: 'prod', PEAKET_KMS_FAILOVER_REGION: 'ap-northeast-1', PEAKET_KMS_FAILOVER_ENDPOINT: 'http://127.0.0.1:1' })).toThrow(/local·ci/);
    expect(kmsFailoverFromEnv({ PEAKET_ENV: 'ci', PEAKET_KMS_FAILOVER_REGION: 'ap-northeast-1', PEAKET_KMS_FAILOVER_ENDPOINT: 'http://127.0.0.1:1' })).toEqual({ region: 'ap-northeast-1', endpoint: 'http://127.0.0.1:1' });
    expect(kmsFailoverFromEnv({ PEAKET_ENV: 'ci' })).toBeNull();
  });
});

describe('페퍼의 넘김', () => {
  test('서울이응답하지않으면도쿄복제키로같은호출을한번하고_넘긴수를알리며_MAC불일치·권한거절은넘기지않는다', async () => {
    const calls: string[] = [];
    let primaryError: Error | null = err('TimeoutError');
    const primary: PepperMacClient = {
      mac: async (k) => { calls.push(`seoul.mac ${k}`); if (primaryError) throw primaryError; return Buffer.alloc(32, 1); },
      verify: async (k) => { calls.push(`seoul.verify ${k}`); if (primaryError) throw primaryError; return true; },
    };
    const secondary: PepperMacClient = {
      mac: async (k) => { calls.push(`tokyo.mac ${k}`); return Buffer.alloc(32, 1); },
      verify: async (k) => { calls.push(`tokyo.verify ${k}`); return true; },
    };
    const failovers: string[] = [];
    const pepper = new KmsPepper(failoverPepperClient(primary, secondary, 'ap-northeast-1', () => failovers.push('pepper')), new Map([[1, SEOUL_ARN]]), 1);
    expect(await pepper.verify(1, Buffer.from('m'), Buffer.alloc(32))).toBe(true);
    expect(await pepper.mac(1, Buffer.from('m'))).toEqual(Buffer.alloc(32, 1));
    expect(calls).toEqual([`seoul.verify ${SEOUL_ARN}`, `tokyo.verify ${TOKYO_ARN}`, `seoul.mac ${SEOUL_ARN}`, `tokyo.mac ${TOKYO_ARN}`]);
    expect(failovers).toEqual(['pepper', 'pepper']);
    // 거절은 넘기지 않는다
    calls.length = 0;
    primaryError = err('AccessDeniedException', 400);
    await expect(pepper.verify(1, Buffer.from('m'), Buffer.alloc(32))).rejects.toBeInstanceOf(PepperUnavailable);
    expect(calls).toEqual([`seoul.verify ${SEOUL_ARN}`]);
    // 도쿄도 응답하지 않으면 503(PepperUnavailable)
    primaryError = err('TimeoutError');
    const dead = new KmsPepper(failoverPepperClient(primary, { mac: async () => { throw err('TimeoutError'); }, verify: async () => { throw err('TimeoutError'); } }, 'ap-northeast-1'), new Map([[1, SEOUL_ARN]]), 1);
    await expect(dead.verify(1, Buffer.from('m'), Buffer.alloc(32))).rejects.toBeInstanceOf(PepperUnavailable);
  });
});

describe('TOTP 시드의 넘김', () => {
  test('서울이응답하지않으면복제키로GenerateDataKey·Decrypt를한번하고_컨텍스트가틀린거절은넘기지않는다', async () => {
    const seen: string[] = [];
    const fake = (name: string, fail: () => Error | null) =>
      ({
        send: async (cmd: { constructor: { name: string }; input: { KeyId: string } }) => {
          seen.push(`${name}.${cmd.constructor.name} ${cmd.input.KeyId}`);
          const e = fail();
          if (e) throw e;
          if (cmd.constructor.name === 'GenerateDataKeyCommand') return { Plaintext: new Uint8Array(32).fill(7), CiphertextBlob: new Uint8Array(40).fill(3) };
          return { Plaintext: new Uint8Array(32).fill(7) };
        },
      }) as unknown as KMSClient;
    let seoulFail: Error | null = err('TimeoutError');
    const failovers: string[] = [];
    const cipher = new KmsTotpSeedCipher(fake('seoul', () => seoulFail), SEOUL_ARN, { client: fake('tokyo', () => null), keyId: TOKYO_ARN, onFailover: () => failovers.push('totp') });
    const sealed = await cipher.encrypt('0190f3a1-7c2e-7a00-8000-000000000d01', Buffer.alloc(20, 5));
    expect(await cipher.decrypt('0190f3a1-7c2e-7a00-8000-000000000d01', sealed)).toEqual(Buffer.alloc(20, 5));
    expect(seen).toEqual([`seoul.GenerateDataKeyCommand ${SEOUL_ARN}`, `tokyo.GenerateDataKeyCommand ${TOKYO_ARN}`, `seoul.DecryptCommand ${SEOUL_ARN}`, `tokyo.DecryptCommand ${TOKYO_ARN}`]);
    expect(failovers).toEqual(['totp', 'totp']);
    seen.length = 0;
    seoulFail = err('InvalidCiphertextException', 400);
    await expect(cipher.decrypt('0190f3a1-7c2e-7a00-8000-000000000d01', sealed)).rejects.toBeInstanceOf(TotpSeedUnreadable);
    expect(seen).toEqual([`seoul.DecryptCommand ${SEOUL_ARN}`]);
  });
});

describe('재검토(2026-11-05)', () => {
  test('local·ci에서서울끝점이있으면넘길끝점도있어야한다_실제AWS로나가지않게', () => {
    expect(() => kmsFailoverFromEnv({ PEAKET_ENV: 'ci', PEAKET_KMS_ENDPOINT: 'http://127.0.0.1:4566', PEAKET_KMS_FAILOVER_REGION: 'ap-northeast-1' })).toThrow(/PEAKET_KMS_FAILOVER_ENDPOINT/);
    // 넘길 끝점만 있고 리전이 없으면 넘기기가 말없이 꺼진다: 거절한다
    expect(() => kmsFailoverFromEnv({ PEAKET_ENV: 'ci', PEAKET_KMS_FAILOVER_ENDPOINT: 'http://127.0.0.1:4566' })).toThrow(/PEAKET_KMS_FAILOVER_REGION/);
  });

  test('SDK를거치지않은오류(코드버그·빈응답)는장애로보지않는다', () => {
    expect(isKmsUnavailable(new TypeError('x'))).toBe(false);
    expect(isKmsUnavailable(new Error('GenerateMac 응답에 Mac이 없다'))).toBe(false);
    expect(isKmsUnavailable(Object.assign(new Error('x'), { name: 'Error', $metadata: { attempts: 2 } }))).toBe(true);
  });

  test('맞지않는MAC(false)은넘기지않고_넘길때는서울오류이름을알리며_알리는쪽이던져도도쿄를부른다', async () => {
    const calls: string[] = [];
    const primary: PepperMacClient = { mac: async () => { throw err('KMSInternalException', 500); }, verify: async () => { calls.push('seoul'); return false; } };
    const secondary: PepperMacClient = { mac: async () => { calls.push('tokyo.mac'); return Buffer.alloc(32); }, verify: async () => { calls.push('tokyo'); return true; } };
    const seen: string[] = [];
    const pepper = new KmsPepper(failoverPepperClient(primary, secondary, 'ap-northeast-1', (e) => { seen.push(e); throw new Error('지표가 던졌다'); }), new Map([[1, SEOUL_ARN]]), 1);
    expect(await pepper.verify(1, Buffer.from('m'), Buffer.alloc(32))).toBe(false);
    expect(calls).toEqual(['seoul']);
    expect(await pepper.mac(1, Buffer.from('m'))).toEqual(Buffer.alloc(32));
    expect(seen).toEqual(['KMSInternalException']);
  });

  test('identity_kms_failover_total{use}를올린다', async () => {
    const { Registry } = await import('@prometheus-io/client');
    const { PromAdminLoginSignals } = await import('../src/modules/admin/adapters/prom-admin-login-signals.js');
    const registry = new Registry();
    const s = new PromAdminLoginSignals();
    s.register(registry);
    s.kmsFailover('totp');
    expect(await registry.metrics()).toMatch(/identity_kms_failover_total\{use="totp"\} 1/);
  });
});
