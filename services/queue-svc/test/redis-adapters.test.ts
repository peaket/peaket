// 대기열 Redis 어댑터의 오류 가르기와 회차 일정 캐시(2026-11-03 새 맥락 리뷰): 일시 장애는 업무 오류(503)로, 버그는 그대로 던진다
import { fakeClock, type HotRedis, RedisConnectError, RedisDeadlineError } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { RedisEntryStore } from '../src/modules/entry/adapters/redis-entry-store.js';
import { RedisEventSchedules, SCHEDULE_CACHE_MAX } from '../src/modules/entry/adapters/redis-event-schedules.js';
import { QueueStoreUnavailable } from '../src/modules/entry/domain/queue.js';

function failing(err: unknown): HotRedis {
  const fail = async () => Promise.reject(err);
  return { command: fail, evalScript: fail, sendCommand: fail, close: async () => {} };
}

describe('일시 장애', () => {
  // 끊김(ClientOfflineError) 같은 나머지 경우는 플랫폼 시험(packages/platform/test/redis.test.ts)이 본다
  test('마감초과·연결실패·클러스터재구성은_QueueStoreUnavailable로바꾼다', async () => {
    for (const err of [new RedisDeadlineError(100), new RedisConnectError(), new Error('CLUSTERDOWN The cluster is down'), new Error('TRYAGAIN rehashing')]) {
      const store = new RedisEntryStore(failing(err));
      await expect(store.preempt({ pid: 'p', eventId: 'e', requestId: 'r', pendingTtlMs: 10 })).rejects.toBeInstanceOf(QueueStoreUnavailable);
      await expect(store.number({ eventId: 'e', expireAtMs: 1 })).rejects.toBeInstanceOf(QueueStoreUnavailable);
      await expect(new RedisEventSchedules(failing(err), fakeClock()).get('e')).rejects.toBeInstanceOf(QueueStoreUnavailable);
    }
  });

  test('스크립트오류같은버그는_바꾸지않고그대로던진다', async () => {
    const bug = new Error('ERR Error running script');
    await expect(new RedisEntryStore(failing(bug)).number({ eventId: 'e', expireAtMs: 1 })).rejects.toBe(bug);
  });
});

describe('회차 일정 캐시', () => {
  const cfg = ['opensAtMs', '1', 'startsAtMs', '2', 'lobbyShuffle', '1', 'openBatch', '1', 'rev', '1'];

  function counting(found: (key: string) => boolean): HotRedis & { calls: number } {
    const r = {
      calls: 0,
      command: async () => null,
      // 일정 사본은 세대 키를 함께 맞추는 Lua 하나로 읽는다(ADR-0181)
      evalScript: async (_script: unknown, keys: string[]) => {
        r.calls++;
        return found(keys[0]!) ? cfg : [];
      },
      sendCommand: async () => null,
      close: async () => {},
    };
    return r;
  }

  test('없는회차는_캐시하지않는다_무작위회차ID로메모리를키우지못한다', async () => {
    const redis = counting(() => false);
    const s = new RedisEventSchedules(redis, fakeClock());
    for (let i = 0; i < 5; i++) expect(await s.get('nope')).toBeNull();
    expect(redis.calls).toBe(5);
    expect(s.cachedForTest()).toBe(0);
  });

  test('있는회차는_1초캐시하고_캐시는상한을넘지않는다', async () => {
    const redis = counting(() => true);
    const clock = fakeClock();
    const s = new RedisEventSchedules(redis, clock);
    await s.get('a');
    await s.get('a');
    expect(redis.calls).toBe(1);
    clock.advance(1_001);
    await s.get('a');
    expect(redis.calls).toBe(2);
    for (let i = 0; i < SCHEDULE_CACHE_MAX + 50; i++) await s.get(`e-${i}`);
    expect(s.cachedForTest()).toBeLessThanOrEqual(SCHEDULE_CACHE_MAX);
  });
});
