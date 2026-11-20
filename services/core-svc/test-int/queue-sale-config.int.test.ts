// 대기열 판매 설정 사본 writer(S-T41 ⑧, BAT-616 LCH-080, ADR-0181·0327, docs/data.md `q:{event:E}:cfg`·`q:{event:E}:epoch`).
// 실제 Valkey 8.1에서 rev 9→10 경계·같은/낮은 rev·TTL·q:epoch node·진행 회차 목록을 보고, 단일 노드와 클러스터 모드를 함께 본다.
import { createHotRedis, type HotRedis } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { CompositeSaleConfigStore, QueueSaleConfigStore, SALE_CONFIG_LUA, type EventSaleConfig, type SaleConfigStore } from '../src/modules/catalog/index.js';
import { startValkey, type ValkeyContainer } from '../../queue-svc/test-int/valkey.js';

const NOW = Date.parse('2026-11-20T00:00:00Z');
const DAY = 86_400_000;
const CLUSTER_EPOCH = 7;

let valkey: ValkeyContainer;
let cluster: ValkeyContainer;
let redis: HotRedis;
let clusterRedis: HotRedis;
let myId: string;
let store: QueueSaleConfigStore;
let clusterStore: QueueSaleConfigStore;

beforeAll(async () => {
  const [a, b] = await Promise.allSettled([startValkey(), startValkey({ cluster: true, configEpoch: CLUSTER_EPOCH })]);
  if (a.status === 'rejected') throw a.reason as Error;
  if (b.status === 'rejected') throw b.reason as Error;
  valkey = a.value;
  cluster = b.value;
  [redis, clusterRedis] = await Promise.all([createHotRedis({ url: valkey.url }), createHotRedis({ url: cluster.url })]);
  myId = String(await clusterRedis.command(['CLUSTER', 'MYID'], { key: 'x' }));
  store = new QueueSaleConfigStore(redis);
  clusterStore = new QueueSaleConfigStore(clusterRedis);
}, 180_000);

afterAll(async () => {
  await Promise.allSettled([redis?.close(), clusterRedis?.close()]);
  valkey?.stop();
  cluster?.stop();
});

const cmd = (key: string, args: string[]) => redis.command(args, { key });
const cfgKey = (eventId: string) => `q:{event:${eventId}}:cfg`;
const epochKey = (eventId: string) => `q:{event:${eventId}}:epoch`;

function config(o: { eventId?: string; rev: number; perPersonLimit?: number; saleEndsAtMs?: number; startsAtMs?: number }): EventSaleConfig {
  const eventId = o.eventId ?? randomUUID();
  const startsAtMs = o.startsAtMs ?? NOW + 10 * DAY;
  return {
    eventId,
    productionId: randomUUID(),
    promoterId: randomUUID(),
    rev: o.rev,
    opensAtMs: startsAtMs - 3 * DAY,
    startsAtMs,
    lobbyMinutes: 10,
    lobbyShuffle: true,
    openBatch: true,
    perPersonLimit: o.perPersonLimit ?? 4,
    saleEndsAtMs: o.saleEndsAtMs ?? startsAtMs - DAY,
    salePolicy: [],
    eligGates: [],
    eligLists: [],
  };
}

const hashOf = (v: unknown): Record<string, string> => {
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), String(x)]));
  if (Array.isArray(v)) {
    const o: Record<string, string> = {};
    for (let i = 0; i + 1 < v.length; i += 2) o[String(v[i])] = String(v[i + 1]);
    return o;
  }
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [String(k), String(x)]));
  return {};
};

describe('대기열 판매 설정 사본(실제 Valkey, S-T41 ⑧)', () => {
  test('S-T41 ⑧_ 같은 rev·낮은 rev는 덮지 않고 9→10 경계에서 10이 이긴다. 수명은 판매 종료+1일이고 진행 회차 목록 점수는 시작 시각이다', async () => {
    const c = config({ rev: 9, perPersonLimit: 4, startsAtMs: NOW + 10 * DAY });
    await store.put([c], [{ eventId: c.eventId, startsAtMs: c.startsAtMs }]);
    expect(hashOf(await cmd(cfgKey(c.eventId), ['HGETALL', cfgKey(c.eventId)])).rev).toBe('9');
    expect(await store.get(c.eventId)).toMatchObject({ rev: 9, perPersonLimit: 4 });

    // 글자로 비교하면 '10' < '9'다. 숫자로 비교해 10이 이겨야 한다
    await store.put([{ ...c, rev: 10 }], []);
    expect(hashOf(await cmd(cfgKey(c.eventId), ['HGETALL', cfgKey(c.eventId)])).rev).toBe('10');
    expect((await store.get(c.eventId))?.rev).toBe(10);

    // 같은 rev·낮은 rev는 값도 바꾸지 않는다
    await store.put([{ ...c, rev: 10, perPersonLimit: 2 }], []);
    expect((await store.get(c.eventId))?.perPersonLimit).toBe(4);
    await store.put([{ ...c, rev: 8, perPersonLimit: 1 }], []);
    expect((await store.get(c.eventId))?.perPersonLimit).toBe(4);
    await store.put([{ ...c, rev: 11, perPersonLimit: 2 }], []);
    expect((await store.get(c.eventId))?.perPersonLimit).toBe(2);

    // 수명 = 판매 종료 + 1일
    const expected = c.saleEndsAtMs + DAY;
    const ttl = Number(await cmd(cfgKey(c.eventId), ['PEXPIRETIME', cfgKey(c.eventId)]));
    expect(Math.abs(ttl - expected)).toBeLessThan(2_000);

    // q:{admission}:events 점수 = 시작 시각
    const score = Number(await cmd('q:{admission}:events', ['ZSCORE', 'q:{admission}:events', c.eventId]));
    expect(score).toBe(c.startsAtMs);
  });

  test('S-T41 ⑧_ q:epoch node는 없을 때만 쓰고 standalone 또는 {CLUSTER MYID}:{cluster_my_epoch}이며 수명은 더 늦은 쪽으로만 늘린다', async () => {
    const standalone = config({ rev: 1 });
    await store.put([standalone], []);
    expect(hashOf(await cmd(epochKey(standalone.eventId), ['HGETALL', epochKey(standalone.eventId)]))).toMatchObject({ node: 'standalone' });
    const standaloneKeep = Number(await cmd(epochKey(standalone.eventId), ['PEXPIRETIME', epochKey(standalone.eventId)]));
    expect(Math.abs(standaloneKeep - (standalone.saleEndsAtMs + DAY))).toBeLessThan(2_000);

    // 이미 있는 node는 덮지 않고, 수명은 더 늦은 쪽으로만 늘린다
    await cmd(epochKey(standalone.eventId), ['HSET', epochKey(standalone.eventId), 'node', 'node-a']);
    const later = { ...standalone, rev: 2, saleEndsAtMs: standalone.saleEndsAtMs + 2 * DAY };
    await store.put([later], []);
    expect(hashOf(await cmd(epochKey(standalone.eventId), ['HGETALL', epochKey(standalone.eventId)])).node).toBe('node-a');
    expect(Number(await cmd(epochKey(standalone.eventId), ['PEXPIRETIME', epochKey(standalone.eventId)]))).toBe(standaloneKeep + 2 * DAY);
    const kept = Number(await cmd(epochKey(standalone.eventId), ['PEXPIRETIME', epochKey(standalone.eventId)]));
    await store.put([{ ...standalone, rev: 3, saleEndsAtMs: standalone.saleEndsAtMs }], []);
    expect(Number(await cmd(epochKey(standalone.eventId), ['PEXPIRETIME', epochKey(standalone.eventId)]))).toBe(kept);

    // 클러스터 모드: node = {CLUSTER MYID}:{cluster_my_epoch}
    const clustered = config({ rev: 1 });
    await clusterStore.put([clustered], []);
    expect(hashOf(await clusterRedis.command(['HGETALL', epochKey(clustered.eventId)], { key: epochKey(clustered.eventId) })).node).toBe(`${myId}:${CLUSTER_EPOCH}`);

    // Lua는 #!lua로 시작하고 rev를 tonumber로 비교한다(글자 비교 금지)
    expect(SALE_CONFIG_LUA.startsWith('#!lua')).toBe(true);
    expect(SALE_CONFIG_LUA).toContain("tonumber(redis.call('HGET', KEYS[1], 'rev'))");
    expect(SALE_CONFIG_LUA).toContain("redis.call('CLUSTER', 'INFO')");
  });

  test('S-T41 ⑧_ CompositeSaleConfigStore는 DB와 대기열에 함께 쓰고 대기열 실패를 성공으로 삼키지 않는다', async () => {
    const calls: string[] = [];
    const db: SaleConfigStore = {
      put: async () => void calls.push('db'),
      get: async () => undefined,
      listEndedBefore: async () => [],
      commissionRateBp: async () => undefined,
    };
    const queue: SaleConfigStore = {
      put: async () => void calls.push('queue'),
      get: async () => undefined,
      listEndedBefore: async () => [],
      commissionRateBp: async () => undefined,
    };
    const composite = new CompositeSaleConfigStore(db, queue);
    const c = config({ rev: 1 });
    await composite.put([c], []);
    expect(calls).toEqual(['db', 'queue']);

    calls.length = 0;
    const brokenQueue: SaleConfigStore = { ...queue, put: async () => { calls.push('queue'); throw new Error('valkey down'); } };
    await expect(new CompositeSaleConfigStore(db, brokenQueue).put([c], [])).rejects.toThrow('valkey down');
    expect(calls).toEqual(['db', 'queue']);
  });
});
