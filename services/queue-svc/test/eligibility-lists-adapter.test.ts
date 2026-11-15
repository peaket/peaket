// B2V-02 회귀 시험: 운영 어댑터 `RedisAdmissionStore.eligibilityLists`(우선 구매 입장 `lst`, GAT-135, ADR-0265 결정 7).
// 실제 Valkey Lua는 test-int/booking-restriction.int.test.ts가 보고, 여기서는 Docker 없이 어댑터↔Lua 계약을 고정한다:
// 후보 키를 회차 해시 태그 한 슬롯에 모아 중복 없이 넘기고(ARGV[1] = 계정 ID), 돌려받은 명단 키를 문자열로 읽으며,
// 후보가 없으면 Redis를 부르지 않고, 일시 장애는 QueueStoreUnavailable(받는 층 503)로 바꾼다.
import { type HotRedis, RedisConnectError } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { admissionKeys, RedisAdmissionStore } from '../src/modules/admission/adapters/redis-admission-store.js';
import { QueueStoreUnavailable } from '../src/modules/entry/domain/queue.js';
import { ACCOUNT } from './support.js';

const EVENT = 'ev-b2v02';

function fake(handler: (keys: string[], args: string[]) => Promise<unknown>): HotRedis & { calls: { keys: string[]; args: string[] }[] } {
  const calls: { keys: string[]; args: string[] }[] = [];
  return {
    calls,
    command: async () => null,
    sendCommand: async () => null,
    close: async () => {},
    evalScript: async (_script: unknown, keys: string[], args: string[]) => {
      calls.push({ keys, args });
      return handler(keys, args);
    },
  };
}

describe('B2V-02 Redis eligibilityLists 어댑터 [GAT-135, ADR-0265]', () => {
  test('후보가 없으면 Redis를 부르지 않고 빈 배열이다', async () => {
    const redis = fake(async () => []);
    expect(await new RedisAdmissionStore(redis).eligibilityLists({ eventId: EVENT, accountId: ACCOUNT, listKeys: [] })).toEqual([]);
    expect(redis.calls).toHaveLength(0);
  });

  test('중복 후보는 한 번만, 회차 해시 태그 한 슬롯의 키로 넘기고 ARGV[1]은 계정 ID이며 결과는 문자열로 읽는다', async () => {
    const redis = fake(async () => [Buffer.from('member'), 'staff']);
    expect(await new RedisAdmissionStore(redis).eligibilityLists({ eventId: EVENT, accountId: ACCOUNT, listKeys: ['vip', 'member', 'vip'] })).toEqual(['member', 'staff']);
    expect(redis.calls).toHaveLength(1);
    const [{ keys, args }] = redis.calls as [{ keys: string[]; args: string[] }];
    expect(keys).toEqual([admissionKeys.elig(EVENT, 'vip'), admissionKeys.elig(EVENT, 'member')]);
    expect(args).toEqual([ACCOUNT, 'vip', 'member']);
    // 한 Lua가 여러 키를 만지므로 모두 같은 해시 태그(한 슬롯)여야 한다
    expect(new Set(keys.map((key) => /\{([^}]+)\}/.exec(key)?.[1])).size).toBe(1);
  });

  test('일시 장애는 QueueStoreUnavailable로 바꾼다(받는 층 503 dependency-unavailable)', async () => {
    const down = new RedisAdmissionStore({
      command: async () => null,
      sendCommand: async () => null,
      close: async () => {},
      evalScript: async () => Promise.reject(new RedisConnectError()),
    });
    await expect(down.eligibilityLists({ eventId: EVENT, accountId: ACCOUNT, listKeys: ['member'] })).rejects.toBeInstanceOf(QueueStoreUnavailable);
  });
});
