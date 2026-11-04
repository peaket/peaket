// 연계정보·pid HMAC의 KMS 어댑터를 AWS 흉내 서버(moto 5.2.5, docs/infra.md '로컬 클러스터')의 KMS HMAC 키로 시험한다
// (docs/features/identity.md §5 '키 판·만 14세…', BUILD_ORDER BOT-020, ADR-0050 결정 5). 실제 AWS 계정·비용 없이 같은 GenerateMac 호출을 돈다.
import { execFileSync } from 'node:child_process';
import { CreateKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { KmsIdentityHashers, kmsMacClient } from '../src/modules/verification/adapters/kms-identity-hashers.js';
import { KeyServiceUnavailable } from '../src/modules/verification/domain/verification.js';

const MOTO_IMAGE = 'motoserver/moto:5.2.5';
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const creds = { accessKeyId: 'test', secretAccessKey: 'test' };
let id: string;
let endpoint: string;
let keys: { v1: string; v2: string; pid: string };

beforeAll(async () => {
  id = docker(['run', '-d', '--rm', '-p', '127.0.0.1::5000', MOTO_IMAGE]);
  const mapped = docker(['port', id, '5000/tcp']).split('\n')[0]!;
  endpoint = `http://127.0.0.1:${mapped.slice(mapped.lastIndexOf(':') + 1)}`;
  const kms = new KMSClient({ endpoint, region: 'ap-northeast-2', credentials: creds });
  const deadline = Date.now() + 60_000;
  const make = async () => (await kms.send(new CreateKeyCommand({ KeySpec: 'HMAC_256', KeyUsage: 'GENERATE_VERIFY_MAC' }))).KeyMetadata!.KeyId!;
  for (;;) {
    try {
      keys = { v1: await make(), v2: await make(), pid: await make() };
      break;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
});
afterAll(() => {
  if (id) docker(['rm', '-f', id]);
});

const hashers = (ciKeys: Map<number, string>, ep = endpoint) =>
  new KmsIdentityHashers({ client: kmsMacClient({ region: 'ap-northeast-2', endpoint: ep, credentials: creds }), ciKeys, pidKeyId: keys.pid, pidVersion: 1 });

test('ADR0050_KMS키판마다GenerateMac으로_보존중인모든판의값을큰판부터주고_같은입력은같은값이다', async () => {
  const one = hashers(new Map([[1, keys.v1]]));
  const both = hashers(new Map([[1, keys.v1], [2, keys.v2]]));
  const a = await one.ciAll('ci-value');
  const b = await both.ciAll('ci-value');
  expect(a.map((x) => x.version)).toEqual([1]);
  expect(b.map((x) => x.version)).toEqual([2, 1]);
  expect(b.every((x) => x.hmac.length === 32)).toBe(true);
  // 같은 판·같은 입력은 같은 값, 판이 다르면 다른 값(판마다 따로 된 키)
  expect(b[1]!.hmac.equals(a[0]!.hmac)).toBe(true);
  expect(b[0]!.hmac.equals(b[1]!.hmac)).toBe(false);
  const p1 = await both.pid(b[0]!.hmac);
  const p2 = await both.pid(b[0]!.hmac);
  expect(p1).toMatchObject({ version: 1 });
  expect(p1.pid.equals(p2.pid)).toBe(true);
  expect(p1.pid.equals(b[0]!.hmac)).toBe(false);
});

test('identity§10_KMS가답하지않거나없는키면_KeyServiceUnavailable이다', async () => {
  const gone = hashers(new Map([[1, keys.v1]]), 'http://127.0.0.1:1');
  await expect(gone.ciAll('x')).rejects.toBeInstanceOf(KeyServiceUnavailable);
  const missing = new KmsIdentityHashers({ client: kmsMacClient({ region: 'ap-northeast-2', endpoint, credentials: creds }), ciKeys: new Map([[1, '00000000-0000-0000-0000-000000000000']]), pidKeyId: keys.pid, pidVersion: 1 });
  await expect(missing.ciAll('x')).rejects.toBeInstanceOf(KeyServiceUnavailable);
});

test('ADR0050_KMS키목록설정은_판번호JSON과pid키가있어야하고_흉내서버주소는local·ci에서만받는다', () => {
  const base = { PEAKET_CI_HMAC_KMS_KEYS: JSON.stringify({ 1: keys.v1 }), PEAKET_PID_HMAC_KMS_KEY: keys.pid };
  expect(KmsIdentityHashers.fromEnv({})).toBeNull();
  expect(KmsIdentityHashers.fromEnv({ ...base, PEAKET_ENV: 'ci', PEAKET_KMS_ENDPOINT: endpoint })).toBeInstanceOf(KmsIdentityHashers);
  expect(() => KmsIdentityHashers.fromEnv({ ...base, PEAKET_ENV: 'prod', PEAKET_KMS_ENDPOINT: endpoint })).toThrow(/local·ci/);
  expect(() => KmsIdentityHashers.fromEnv({ PEAKET_CI_HMAC_KMS_KEYS: base.PEAKET_CI_HMAC_KMS_KEYS, PEAKET_ENV: 'ci' })).toThrow(/PEAKET_PID_HMAC_KMS_KEY/);
  expect(() => KmsIdentityHashers.fromEnv({ ...base, PEAKET_CI_HMAC_KMS_KEYS: JSON.stringify({ 1: keys.pid }), PEAKET_ENV: 'ci' })).toThrow();
});
