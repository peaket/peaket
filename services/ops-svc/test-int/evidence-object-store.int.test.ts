// F-04-14 증거 저장소 S3 통합 시험(동결 로컬, LCH-290, FX-T13).
// moto 5.2.5에서 Object Lock·법적 보존·SSE-KMS·같은 키 다른 바이트를 본다. Docker가 없으면 건너뛰지 않고 실패한다.
// [ASVS v5.0.0-13.2.2] 법적 보존 풀기·지우기는 파기 작업만, [ASVS v5.0.0-11.1.2] 판·알고리즘.
import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { CreateKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as inv from '../src/modules/investigations/index.js';

const MOTO_IMAGE = 'motoserver/moto:5.2.5';
const REGION = 'ap-northeast-2';
const BUCKET = 'peaket-it-evidence';
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim();

let container = '';
let endpoint = '';
let s3: S3Client;
let kms: KMSClient;
let kmsKeyId = '';
let store: any;

beforeAll(async () => {
  process.env.AWS_ACCESS_KEY_ID = 'test';
  process.env.AWS_SECRET_ACCESS_KEY = 'test';
  process.env.AWS_REGION = REGION;
  const prefix = process.env.PEAKET_TEST_CONTAINER_PREFIX;
  container = docker(['run', '-d', '--rm', ...(prefix ? ['--name', `${prefix}moto-evidence-${Math.random().toString(36).slice(2, 8)}`] : []), '-p', '127.0.0.1::5000', MOTO_IMAGE]);
  const mapped = docker(['port', container, '5000/tcp']).split('\n')[0]!;
  endpoint = `http://127.0.0.1:${mapped.slice(mapped.lastIndexOf(':') + 1)}`;
  s3 = new S3Client({ endpoint, region: REGION, forcePathStyle: true, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  kms = new KMSClient({ endpoint, region: REGION, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: BUCKET, ObjectLockEnabledForBucket: true }));
      kmsKeyId = (await kms.send(new CreateKeyCommand({ Description: 'peaket-evidence-it' }))).KeyMetadata!.KeyId!;
      break;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  const Store = (inv as unknown as Record<string, any>).S3EvidenceObjectStore;
  if (typeof Store !== 'function') throw new Error('S3EvidenceObjectStore가 없다');
  store = new Store({ bucket: BUCKET, region: REGION, endpoint, kmsKeyId, client: s3 });
}, 180_000);

afterAll(async () => {
  await s3?.destroy();
  await kms?.destroy();
  if (container) {
    try {
      docker(['rm', '-f', '-v', container]);
    } catch {
      // 이미 멈췄다
    }
  }
});

describe('F-04-14 S3 증거 저장소', () => {
  test('FX-T13 ⑬ [ASVS v5.0.0-13.2.2] moto S3는 법적 보존 ON 객체의 삭제를 거절하고 보존을 푼 뒤 파기 작업이 모든 판을 지운다', async () => {
    const key = 'evidence/case-1/bundle-1/case.json';
    expect(await store.putOnce(key, Buffer.from('{"case":1}'), 'application/json')).toBe('CREATED');
    const head = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    expect(Buffer.from(await head.Body!.transformToByteArray()).toString('utf8')).toBe('{"case":1}');
    await expect(s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))).rejects.toThrow();
    await store.dispose('evidence/case-1/bundle-1/');
    await expect(s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))).rejects.toThrow();
  });

  test('FX-T13 ⑭ 같은 키에 다른 바이트를 쓰면 DIFFERENT이고 같은 바이트는 SAME이다', async () => {
    const key = 'evidence/case-2/bundle-2/manifest.json';
    expect(await store.putOnce(key, Buffer.from('same'), 'application/json')).toBe('CREATED');
    expect(await store.putOnce(key, Buffer.from('same'), 'application/json')).toBe('SAME');
    expect(await store.putOnce(key, Buffer.from('different'), 'application/json')).toBe('DIFFERENT');
  });
});
