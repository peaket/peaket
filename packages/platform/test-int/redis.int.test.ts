// 핫패스 Redis 연결을 실제 Valkey 8.1로 본다(ADR-0176 결정 2). Docker 엔진이 있어야 한다
import { afterAll, beforeAll, expect, test } from 'vitest';
import { RedisDeadlineError, createHotRedis, redisScript, type HotRedis } from '../src/redis.js';
import { startPasswordCluster, startValkey, type ValkeyContainer } from './containers.js';

let valkey: ValkeyContainer;
let redis: HotRedis;

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
});

afterAll(async () => {
  await redis?.close();
  valkey?.stop();
});

test('명령과_스크립트를보낸다_처음은EVAL로올리고다음은EVALSHA로돈다', async () => {
  await expect(redis.command(['SET', 'k:a', '1'], { key: 'k:a' })).resolves.toBe('OK');
  const s = redisScript("return redis.call('INCR', KEYS[1])");
  await expect(redis.evalScript(s, ['k:a'], [])).resolves.toBe(2);
  await expect(redis.evalScript(s, ['k:a'], [])).resolves.toBe(3);
});

test('응답이늦은명령은_호출쪽마감100ms에_RedisDeadlineError로끊는다', async () => {
  const started = Date.now();
  await expect(redis.command(['BLPOP', 'k:empty', '2'], { key: 'k:empty' })).rejects.toBeInstanceOf(RedisDeadlineError);
  expect(Date.now() - started).toBeLessThan(1_000);
});

test('붙을수없는주소면_시작마감안에실패하고_주소를오류문구에싣지않는다', async () => {
  const started = Date.now();
  await expect(createHotRedis({ url: 'redis://user:secret@127.0.0.1:1', startupTimeoutMs: 300 })).rejects.toThrow(/연결하지 못했다/);
  await expect(createHotRedis({ url: 'redis://user:secret@127.0.0.1:1', startupTimeoutMs: 300 })).rejects.not.toThrow(/secret/);
  expect(Date.now() - started).toBeLessThan(3_000);
});

test('비밀번호를건클러스터에서도_찾아낸노드연결이인증해명령이돈다', async () => {
  const c = await startPasswordCluster('it-secret');
  try {
    const cluster = await createHotRedis({ clusterUrls: [`redis://:it-secret@127.0.0.1:${c.port}`] });
    try {
      await expect(cluster.command(['SET', 'k:{x}', 'v'], { key: 'k:{x}' })).resolves.toBe('OK');
      await expect(cluster.evalScript(redisScript("return redis.call('GET', KEYS[1])"), ['k:{x}'], [])).resolves.toBe('v');
    } finally {
      await cluster.close();
    }
  } finally {
    c.stop();
  }
});
