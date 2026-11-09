// 시드 봉인을 AWS 흉내 서버 moto 5.2.5로 돈다(ADR-0239 결정 1·2). 실제 AWS를 쓰지 않는다.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { CreateKeyCommand, DecryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { sealContext } from '@peaket/shuffle';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { KmsSeedSealer, kmsSealClient, seedSealerFromEnv } from '../src/modules/entry/adapters/kms-seed-sealer.js';

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

const decrypt = (blob: string, eventId: string, group: 'lobby' | number) => client.send(new DecryptCommand({ KeyId: seedKey, CiphertextBlob: Buffer.from(blob, 'base64'), EncryptionContext: sealContext(eventId, group) }));

test('moto에서_KMS로봉인하면_같은컨텍스트로만풀린다', async () => {
  const seed = randomBytes(32);
  const s = new KmsSeedSealer(kmsSealClient({ region: 'ap-northeast-2', endpoint, credentials: creds }), seedKey);
  const blob = await s.seal('evt-1', 'lobby', seed);
  expect(Buffer.from((await decrypt(blob, 'evt-1', 'lobby')).Plaintext!)).toEqual(seed);
  await expect(decrypt(blob, 'evt-2', 'lobby')).rejects.toThrow();
});

test('연결만받고답하지않는KMS는_요청시간한도로끊는다', async () => {
  const s = new KmsSeedSealer(kmsSealClient({ region: 'ap-northeast-2', endpoint: silentEndpoint, credentials: creds }), seedKey);
  const started = Date.now();
  await expect(s.seal('evt-1', 'lobby', randomBytes(32))).rejects.toThrow(/TimeoutError/);
  expect(Date.now() - started).toBeLessThan(8_000);
}, 15_000);

test('설정으로_ci에서도KMS를쓸수있다', async () => {
  const s = seedSealerFromEnv({ PEAKET_ENV: 'ci', PEAKET_SHUFFLE_SEED_KMS_KEY: seedKey, PEAKET_KMS_ENDPOINT: endpoint, AWS_REGION: 'ap-northeast-2', AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test' }, (ep, region) => kmsSealClient({ region, credentials: creds, ...(ep ? { endpoint: ep } : {}) }));
  expect(s).toBeInstanceOf(KmsSeedSealer);
}, 15_000);
