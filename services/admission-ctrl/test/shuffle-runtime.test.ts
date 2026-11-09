// 운영 조립(ADR-0239 결정 5): 운영 환경값은 시험 대역으로 떨어지지 않고, 설정이 모자라면 시작하지 않는다.
import { createServer } from 'node:http';
import type { KMSClient } from '@aws-sdk/client-kms';
import { fakeClock } from '@peaket/platform';
import { TestSeedSealer } from '@peaket/shuffle';
import { describe, expect, test } from 'vitest';
import { externalBeaconHttp, RELAY_TIMEOUT_MS } from '../src/modules/batch/adapters/drand-http.js';
import { DrandBeacon } from '../src/modules/batch/adapters/drand-beacon.js';
import { KmsSeedOpener } from '../src/modules/batch/adapters/kms-seed-opener.js';
import { MemoryShuffleRecords } from '../src/modules/batch/adapters/memory-batch-store.js';
import { shuffleRuntimeFromEnv } from '../src/modules/batch/adapters/shuffle-runtime.js';
import { TestRandomness } from '../src/modules/batch/adapters/test-randomness.js';

const KEY = 'arn:aws:kms:ap-northeast-2:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab';
const SECRET = Buffer.alloc(32, 7).toString('base64');
const created: { endpoint: string | undefined; region: string }[] = [];
const kms = (endpoint: string | undefined, region: string) => (created.push({ endpoint, region }), { send: async () => ({}) } as unknown as KMSClient);
const deps = { kms, clock: fakeClock({ now: 1_700_000_000_000 }) };
const records = new MemoryShuffleRecords();
const prodEnv = { PEAKET_ENV: 'prod', PEAKET_SHUFFLE_SEED_KMS_KEY: KEY, PEAKET_DRAND_RELAYS: 'https://a.example,https://b.example' };

describe('shuffleRuntimeFromEnv', () => {
  test('local·ci·demo는 시험 대역 그대로다', () => {
    for (const env of ['local', 'ci', 'demo']) {
      const r = shuffleRuntimeFromEnv({ PEAKET_ENV: env, PEAKET_TEST_BATCH_RANDOMNESS: SECRET }, deps);
      expect(r.opener).toBeInstanceOf(TestSeedSealer);
      expect(r.beacon(records)).toBeInstanceOf(TestRandomness);
    }
  });

  test('운영은 KMS 풀기와 drand 비콘이다', () => {
    const r = shuffleRuntimeFromEnv(prodEnv, deps);
    expect(r.opener).toBeInstanceOf(KmsSeedOpener);
    expect(r.beacon(records)).toBeInstanceOf(DrandBeacon);
  });

  test.each([
    ['PEAKET_ENV 없음', { PEAKET_SHUFFLE_SEED_KMS_KEY: KEY, PEAKET_DRAND_RELAYS: 'https://a.example,https://b.example' }],
    ['staging', { PEAKET_ENV: 'staging', PEAKET_SHUFFLE_SEED_KMS_KEY: KEY, PEAKET_DRAND_RELAYS: 'https://a.example,https://b.example' }],
  ])('운영 값(%s)도 KMS로 조립된다', (_n, env) => {
    expect(shuffleRuntimeFromEnv(env, deps).opener).toBeInstanceOf(KmsSeedOpener);
  });

  test.each([
    ['PEAKET_ENV 없고 설정도 없음', {}],
    ['운영인데 KMS 키 없음', { PEAKET_ENV: 'prod', PEAKET_DRAND_RELAYS: 'https://a.example,https://b.example' }],
    ['운영인데 중계 주소 없음', { PEAKET_ENV: 'prod', PEAKET_SHUFFLE_SEED_KMS_KEY: KEY }],
    ['운영인데 중계 주소 하나', { ...prodEnv, PEAKET_DRAND_RELAYS: 'https://a.example' }],
    ['운영인데 같은 주소 둘', { ...prodEnv, PEAKET_DRAND_RELAYS: 'https://a.example,https://a.example/' }],
    ['운영인데 http 중계', { ...prodEnv, PEAKET_DRAND_RELAYS: 'http://a.example,https://b.example' }],
    ['주소 모양이 틀림', { ...prodEnv, PEAKET_DRAND_RELAYS: 'https://a.example?x=1,https://b.example' }],
    ['운영에서 KMS 끝점 바꾸기', { ...prodEnv, PEAKET_KMS_ENDPOINT: 'http://127.0.0.1:1' }],
    ['운영에 시험 값이 섞임', { ...prodEnv, PEAKET_TEST_BATCH_RANDOMNESS: SECRET }],
    ['시험 값만 있는 운영', { PEAKET_ENV: 'prod', PEAKET_TEST_BATCH_RANDOMNESS: SECRET }],
  ])('시작하지 않는다: %s', (_n, env) => {
    expect(() => shuffleRuntimeFromEnv(env, deps)).toThrow();
  });

  test('운영 끝점은 AWS 기본이고 local·ci에서만 KMS 끝점을 받는다', () => {
    created.length = 0;
    shuffleRuntimeFromEnv({ ...prodEnv, AWS_REGION: 'ap-northeast-2' }, deps);
    expect(created).toEqual([{ endpoint: undefined, region: 'ap-northeast-2' }]);
    created.length = 0;
    shuffleRuntimeFromEnv({ PEAKET_ENV: 'ci', PEAKET_SHUFFLE_SEED_KMS_KEY: KEY, PEAKET_DRAND_RELAYS: 'http://127.0.0.1:1,http://127.0.0.1:2', PEAKET_KMS_ENDPOINT: 'http://127.0.0.1:4566' }, deps);
    expect(created).toEqual([{ endpoint: 'http://127.0.0.1:4566', region: 'ap-northeast-2' }]);
  });
});

describe('externalBeaconHttp', () => {
  const body = JSON.stringify({ round: 1, randomness: 'aa', signature: 'bb' });
  const res = (status: number, text: string) => new Response(status === 200 ? text : null, { status });

  test('[ASVS v5.0.0-16.5.2] 짧은 마감으로 부르고 추적 머리를 싣지 않는다', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const http = externalBeaconHttp(['https://a.example'], { fetchImpl: (async (u: URL, i: RequestInit) => (seen.push({ url: String(u), init: i }), res(200, body))) as unknown as typeof fetch, timeoutMs: 1_500 });
    const r = await http.get('https://a.example/CHAIN/public/9');
    expect(r).toEqual({ status: 200, body: JSON.parse(body) });
    expect(seen[0]!.url).toBe('https://a.example/CHAIN/public/9');
    expect(seen[0]!.init.signal).toBeDefined();
    expect(new Headers(seen[0]!.init.headers).has('traceparent')).toBe(false);
  });

  test('[ASVS v5.0.0-16.5.2] 4 KiB를 넘는 응답은 읽지 않는다', async () => {
    const http = externalBeaconHttp(['https://a.example'], { fetchImpl: (async () => res(200, 'x'.repeat(5_000))) as unknown as typeof fetch });
    await expect(http.get('https://a.example/CHAIN/public/9')).rejects.toThrow();
  });

  test('[ASVS v5.0.0-16.5.2] 기본 마감은 2초다', () => {
    expect(RELAY_TIMEOUT_MS).toBe(2_000);
  });

  test('[ASVS v5.0.0-16.5.2] 머리만 보내고 본문에서 멈춘 중계는 본문을 읽는 단계에서 끊는다', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"round":');
      // 끝내지 않는다
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const relay = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const http = externalBeaconHttp([relay], { timeoutMs: 150 });
      const started = Date.now();
      await expect(http.get(`${relay}/CHAIN/public/9`)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }, 10_000);

  test('없는 라운드(404)는 상태만 준다', async () => {
    const http = externalBeaconHttp(['https://a.example'], { fetchImpl: (async () => res(404, '')) as unknown as typeof fetch });
    expect(await http.get('https://a.example/CHAIN/public/9')).toEqual({ status: 404, body: null });
  });

  test('목록에 없는 주소는 부르지 않는다', async () => {
    const http = externalBeaconHttp(['https://a.example'], { fetchImpl: (async () => res(200, body)) as unknown as typeof fetch });
    await expect(http.get('https://evil.example/CHAIN/public/9')).rejects.toThrow();
  });
});
