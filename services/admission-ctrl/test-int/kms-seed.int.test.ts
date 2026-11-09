// 시드 풀기와 런북 서명을 AWS 흉내 서버 moto 5.2.5로 돈다(ADR-0239 결정 1·2·7). 실제 AWS를 쓰지 않는다.
import { execFileSync } from 'node:child_process';
import { createPublicKey, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { CreateKeyCommand, EncryptCommand, GetPublicKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { sealContext } from '@peaket/shuffle';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { kmsSeedClient, KmsSeedOpener } from '../src/modules/batch/adapters/kms-seed-opener.js';
import { bundleBytes, kmsRunbookSigner, verifySigned } from '../src/modules/rb35/index.js';
import { bundleOf, NOW } from '../test/rb35-support.js';

const MOTO_IMAGE = 'motoserver/moto:5.2.5';
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const creds = { accessKeyId: 'test', secretAccessKey: 'test' };
let moto: string;
let endpoint: string;
let client: KMSClient;
let seedKey: string;
let silent: Server;
let silentEndpoint: string;

beforeAll(async () => {
  silent = createServer(() => {});
  await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
  silentEndpoint = `http://127.0.0.1:${(silent.address() as { port: number }).port}`;
  moto = docker(['run', '-d', '--rm', '-p', '127.0.0.1::5000', MOTO_IMAGE]);
  const mapped = docker(['port', moto, '5000/tcp']).split('\n')[0]!;
  endpoint = `http://127.0.0.1:${mapped.slice(mapped.lastIndexOf(':') + 1)}`;
  client = new KMSClient({ endpoint, region: 'ap-northeast-2', credentials: creds });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      seedKey = (await client.send(new CreateKeyCommand({}))).KeyMetadata!.Arn!;
      break;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}, 120_000);

afterAll(() => {
  silent?.closeAllConnections();
  silent?.close();
  if (moto) docker(['rm', '-f', '-v', moto]);
});

const sealed = async (eventId: string, group: 'lobby' | number, seed: Buffer) =>
  Buffer.from((await client.send(new EncryptCommand({ KeyId: seedKey, Plaintext: seed, EncryptionContext: sealContext(eventId, group) }))).CiphertextBlob!).toString('base64');

test('moto에서_queue-svc처럼봉인한값을_같은컨텍스트로풀면_시드가나온다', async () => {
  const seed = randomBytes(32);
  const o = new KmsSeedOpener(kmsSeedClient({ region: 'ap-northeast-2', endpoint, credentials: creds }), seedKey);
  expect(await o.open('evt-1', 'lobby', await sealed('evt-1', 'lobby', seed))).toEqual(seed);
});

test('moto에서_다른회차·구간의컨텍스트로풀면_거절한다', async () => {
  const seed = randomBytes(32);
  const blob = await sealed('evt-1', 'lobby', seed);
  const o = new KmsSeedOpener(kmsSeedClient({ region: 'ap-northeast-2', endpoint, credentials: creds }), seedKey);
  await expect(o.open('evt-2', 'lobby', blob)).rejects.toThrow();
  await expect(o.open('evt-1', 1, blob)).rejects.toThrow();
});

test('연결만받고답하지않는KMS는_요청시간한도(throwOnRequestTimeout)로끊는다', async () => {
  const o = new KmsSeedOpener(kmsSeedClient({ region: 'ap-northeast-2', endpoint: silentEndpoint, credentials: creds }), seedKey);
  const started = Date.now();
  await expect(o.open('evt-1', 'lobby', 'AAAA')).rejects.toThrow(/TimeoutError/);
  // 2초 × 2번 안에 끝난다
  expect(Date.now() - started).toBeLessThan(8_000);
}, 15_000);

test('[ASVS v5.0.0-11.6.1] Q-T27 moto KMS의 ES256 서명(RAW)을 운영자 공개키로 확인한다', async () => {
  const keyA = (await client.send(new CreateKeyCommand({ KeySpec: 'ECC_NIST_P256', KeyUsage: 'SIGN_VERIFY' }))).KeyMetadata!.Arn!;
  const keyB = (await client.send(new CreateKeyCommand({ KeySpec: 'ECC_NIST_P256', KeyUsage: 'SIGN_VERIFY' }))).KeyMetadata!.Arn!;
  const pub = async (arn: string) => createPublicKey({ key: Buffer.from((await client.send(new GetPublicKeyCommand({ KeyId: arn }))).PublicKey!), format: 'der', type: 'spki' });
  const keys = new Map([
    ['commander-a', { id: 'commander-a', role: 'commander', key: await pub(keyA) }],
    ['commander-b', { id: 'commander-b', role: 'commander', key: await pub(keyB) }],
  ]);
  const bundle = bundleOf();
  const sign = async (arn: string) => (await kmsRunbookSigner(client)(arn, bundleBytes(bundle))).toString('base64');
  expect(verifySigned({ bundle, signatures: [{ signer: 'commander-a', sig: await sign(keyA) }, { signer: 'commander-b', sig: await sign(keyB) }] }, keys, NOW + 1_000)).toEqual({ ok: true });
  // 다른 운영자의 키로 만든 서명은 거절한다
  expect(verifySigned({ bundle, signatures: [{ signer: 'commander-a', sig: await sign(keyB) }, { signer: 'commander-b', sig: await sign(keyB) }] }, keys, NOW + 1_000)).toEqual({ ok: false, reason: 'bad_signature' });
}, 60_000);
