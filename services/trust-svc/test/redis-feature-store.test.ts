// 판정 피처 Redis 저장소의 키별 실패(리뷰 2, bot-defense §18 '피처 Redis 장애'): 실패한 명령의 피처만 값 없음이고 나머지는 그대로다.
import type { HotRedis } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { keys, RedisFeatureStore } from '../src/modules/scoring/adapters/redis-feature-store.js';

const NOW = Date.UTC(2026, 10, 9, 1);

function fakeRedis(fail: (key: string) => boolean): HotRedis {
  return {
    command: async (args: string[], o?: { key?: string }) => {
      const key = o?.key ?? args[1]!;
      if (fail(key)) throw new Error('down');
      if (args[0] === 'EXISTS') return key === keys.honeypot('p') ? 1 : 0;
      return [];
    },
    evalScript: async (_s: unknown, k: string[]) => {
      if (fail(k[0]!)) throw new Error('down');
      return 2;
    },
  } as unknown as HotRedis;
}

describe('요청 때 세는 키의 모양', () => {
  function recording(failing = false) {
    const evals: { keys: string[]; args: string[] }[] = [];
    const redis = {
      command: async () => [],
      evalScript: async (_s: unknown, k: string[], a: string[]) => {
        evals.push({ keys: k, args: a });
        if (failing) throw new Error('down');
        return 4;
      },
    } as unknown as HotRedis;
    return { redis, evals };
  }

  test('B-T22⑧_공유수의Lua는기기키하나만쓴다_슬롯을넘지않는다', async () => {
    const { redis, evals } = recording();
    const r = await new RedisFeatureStore(redis).read({ deviceRef: 'k1.d', pid: 'p', now: NOW, shareEventId: 'ev-1' });
    expect(r.shared).toBe(4);
    const share = evals.find((e) => e.keys[0]!.startsWith('tr:devshare'));
    expect(share).toEqual({ keys: ['tr:devshare:{k1.d}:ev-1'], args: ['p', '20', '600000'] });
  });

  test('B-T22⑥_공유수만실패하면그칸만빈다', async () => {
    const redis = {
      command: async () => [],
      evalScript: async (_s: unknown, k: string[]) => {
        if (k[0]!.startsWith('tr:devshare')) throw new Error('down');
        return 0;
      },
    } as unknown as HotRedis;
    const r = await new RedisFeatureStore(redis).read({ deviceRef: 'k1.d', pid: 'p', now: NOW, shareEventId: 'ev-1' });
    expect(r.failed).toEqual(['shared']);
    expect(r.shared).toBeUndefined();
  });

  test('B-T23_진입수의Lua는ASN키하나만쓰고_10초칸이며_수명은30초다', async () => {
    const { redis, evals } = recording();
    const now = 1_700_000_012_345;
    const r = await new RedisFeatureStore(redis).read({ deviceRef: undefined, pid: '', now, hostEntry: { asn: 16509, eventId: 'ev-1' } });
    expect(r.hostEntries).toBe(4);
    expect(evals).toEqual([{ keys: [`tr:asnhost:{16509}:ev-1:${Math.floor(now / 10_000)}`], args: ['30000'] }]);
  });

  test('B-T23⑤_진입수만실패하면그칸만빈다', async () => {
    const { redis } = recording(true);
    const r = await new RedisFeatureStore(redis).read({ deviceRef: undefined, pid: 'p', now: NOW, hostEntry: { asn: 16509, eventId: 'ev-1' } });
    expect(r.failed).toEqual(['entries']);
    expect(r.hostEntries).toBeUndefined();
  });

  test('B-T23②_대역을세지않는요청은진입수Lua를부르지않는다', async () => {
    const { redis, evals } = recording();
    const r = await new RedisFeatureStore(redis).read({ deviceRef: undefined, pid: '', now: NOW });
    expect(evals).toEqual([]);
    expect(r.hostEntries).toBeUndefined();
  });
});

describe('RedisFeatureStore.read 키별 실패', () => {
  test('리뷰2_차단목록키만실패하면_그칸만비고_나머지는읽힌다', async () => {
    const store = new RedisFeatureStore(fakeRedis((k) => k === keys.block('k1.d')));
    const r = await store.read({ deviceRef: 'k1.d', pid: 'p', now: NOW });
    expect(r.failed).toEqual(['block']);
    expect(r.blocked).toBeUndefined();
    expect(r.honeypot).toBe(true);
    expect(r.accounts).toBe(2);
  });

  test('리뷰2_허니팟키만실패하면_그칸만빈다', async () => {
    const store = new RedisFeatureStore(fakeRedis((k) => k === keys.honeypot('p')));
    const r = await store.read({ deviceRef: 'k1.d', pid: 'p', now: NOW });
    expect(r.failed).toEqual(['honeypot']);
    expect(r.honeypot).toBeUndefined();
    expect(r.blocked).toBe(false);
  });

  test('리뷰2_계정수·이력키실패는각각의칸이다', async () => {
    const store = new RedisFeatureStore(fakeRedis((k) => k === keys.devAccounts('k1.d') || k === keys.devHistory('k1.d')));
    const r = await store.read({ deviceRef: 'k1.d', pid: 'p', now: NOW });
    expect([...r.failed].sort()).toEqual(['accounts', 'history']);
    expect(r.accounts).toBeUndefined();
    expect(r.history).toBeUndefined();
    expect(r.blocked).toBe(false);
  });

  test('기기가명이없으면기기키를부르지않고실패도없다', async () => {
    const store = new RedisFeatureStore(fakeRedis((k) => k.includes('devacct')));
    const r = await store.read({ deviceRef: undefined, pid: 'p', now: NOW });
    expect(r.failed).toEqual([]);
    expect(r.accounts).toBeUndefined();
    expect(r.honeypot).toBe(true);
  });
});
