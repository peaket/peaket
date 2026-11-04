// RB-05의 복제 확인을 실제 주 노드·복제본 둘(단일 노드 모드)로 돈다(ADR-0186, Q-T13). 클러스터 모드 시험(failover-cluster.int.test.ts)은
// 노드 하나라 붙은 복제본이 없어 확인이 기다리지 않는다. 단일 노드의 노드 표지는 'standalone'이라 장애 전환은 세대 키에 옛 표지를 써서 흉내 낸다.
import { createHotRedis, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { keys, RedisEntryStore } from '../src/modules/entry/adapters/redis-entry-store.js';
import { newEvent } from '../test/support.js';
import { startValkeyPair, type ValkeyPair } from './valkey.js';

let pair: ValkeyPair;
let redis: HotRedis;
/** RB-05 복제 확인의 WAIT 전용 연결(운영 조립과 같게 공유 연결과 따로) */
let waitRedis: HotRedis;

beforeAll(async () => {
  pair = await startValkeyPair();
  redis = await createHotRedis({ url: pair.url });
  waitRedis = await createHotRedis({ url: pair.url });
});

afterAll(async () => {
  await redis?.close();
  await waitRedis?.close();
  pair?.stop();
});

const cmd = (key: string, args: string[]) => redis.command(args, { key });

test('[Q-T13] [ASVS v5.0.0-15.4.2] 붙은복제본이RB05의건너뛰기를받지못하면_확인하지않아진입②가번호를내지않고_받으면확인해건너뛴구간뒤번호를낸다_WAIT는전용연결이라공유연결을막지않는다(ADR-0186)', async () => {
  const store = new RedisEntryStore(redis, waitRedis);
  const now = Date.now();
  const e = newEvent();
  const input = { eventId: e, expireAtMs: now + 86_400_000, opensAtMs: now - 60_000, closeAtMs: now - 50_000, lobbyShuffle: false, openBatch: false };
  expect(await store.number(input)).toMatchObject({ kind: 'NUMBERED', seq: 1 });
  await cmd(keys.epoch(e), ['HSET', keys.epoch(e), 'node', 'old-primary']);
  const rb = { eventId: e, expireAtMs: now + 86_400_000, skippedExpireAtMs: now + 86_400_000, skipBase: 10, opensAtMs: now - 60_000, lobbyShuffle: false, openBatch: false };
  expect(await store.rb05(rb)).toEqual({ kind: 'SKIPPED', start: 2, end: 11, gen: 2 });
  pair.pauseReplica();
  try {
    const t0 = Date.now();
    const confirming = store.confirmRb05({ eventId: e });
    // WAIT가 전용 연결을 막는 동안에도 공유 연결의 진입은 기다리지 않고 답한다(확인 전이라 RECOVERING)
    await new Promise((r) => setTimeout(r, 100));
    const t1 = Date.now();
    expect(await store.number(input)).toEqual({ kind: 'RECOVERING' });
    expect(Date.now() - t1).toBeLessThan(200);
    expect(await confirming).toBe('WAITING');
    // 붙은 복제본 하나를 기다림 한도만큼 기다렸다
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
    expect(String(await cmd(keys.epoch(e), ['HGET', keys.epoch(e), 'pend']))).toBe('1');
    expect(await store.number(input)).toEqual({ kind: 'RECOVERING' });
    expect(await store.rb05(rb)).toEqual({ kind: 'PENDING' });
  } finally {
    pair.resumeReplica();
  }
  expect(await store.confirmRb05({ eventId: e })).toBe('CONFIRMED');
  expect(await cmd(keys.epoch(e), ['HGET', keys.epoch(e), 'pend'])).toBeNull();
  expect(await store.number(input)).toMatchObject({ kind: 'NUMBERED', seq: 12, gen: 2 });
}, 60_000);
