// 대기열 Redis 보류(RedisHeldEventStore)를 실제 Valkey 8.1로 돈다(docs/data.md §3 q:{held:<토픽>}, ADR-0214 결정 6, ST-T19).
import { createHotRedis, fakeClock, type HeldEventInput, type HotRedis, isTransientError } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { heldKeys, RedisHeldEventStore, redisHeldCounts } from '../src/consumers/held-events.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

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

const cmd = (key: string, args: string[]) => redis.command(args, { key });
const DAY = 86_400_000;
let n = 0;

function held(topic: string, o: Partial<HeldEventInput> = {}): HeldEventInput {
  n += 1;
  return {
    topic,
    partition: 0,
    offset: BigInt(n),
    eventKey: crypto.randomUUID(),
    businessKey: `k-${n}`,
    error: 'RangeError: 모양이 아니다',
    key: 'msg-key',
    value: Buffer.from(JSON.stringify({ eventId: 'ev-1' })),
    headers: { traceparent: '00-abc' },
    timestamp: Date.now(),
    ...o,
  };
}

describe('대기열 Redis 보류', () => {
  test('ST-T19_넣으면그업무키가보류중이고_그파티션의보류키에들며_같은위치·같은eventKey는두번넣지않는다', async () => {
    const topic = `t-${crypto.randomUUID()}`;
    const clock = fakeClock({ now: Date.now() });
    const store = new RedisHeldEventStore(redis, clock);
    const e = held(topic, { partition: 2, businessKey: 'order-1' });
    await store.hold(e);
    expect(await store.isHeld(topic, 'order-1')).toBe(true);
    expect(await store.isHeld(topic, 'order-2')).toBe(false);
    expect(await store.heldKeys(topic, 2)).toEqual(new Set(['order-1']));
    expect(await store.heldKeys(topic, 0)).toEqual(new Set());
    await store.hold(e);
    await store.hold({ ...e, offset: e.offset + 100n });
    expect((await redisHeldCounts(redis, [topic])()).get(topic)).toBe(1);
    const rec = heldKeys.record(topic, 2, e.offset);
    expect(String(await cmd(rec, ['HGET', rec, 'error']))).toBe(e.error);
    const v = heldKeys.value(topic, 2, e.offset);
    expect(Buffer.from(String(await cmd(v, ['GET', v])), 'base64').equals(e.value!)).toBe(true);
    // 보류 표시와 값은 다시 처리할 때까지 둔다(수명 없음, ADR-0142 '버리지 않는다')
    expect(Number(await cmd(rec, ['PEXPIRETIME', rec]))).toBe(-1);
    expect(Number(await cmd(v, ['PEXPIRETIME', v]))).toBe(-1);
  });

  test('ST-T19_보류중일때만넣기는_그키가보류중이면넣고참이며_아니면넣지않고거짓이다', async () => {
    const topic = `t-${crypto.randomUUID()}`;
    const store = new RedisHeldEventStore(redis, fakeClock({ now: Date.now() }));
    expect(await store.holdIfHeld(held(topic, { businessKey: 'a' }))).toBe(false);
    expect(await store.isHeld(topic, 'a')).toBe(false);
    await store.hold(held(topic, { businessKey: 'a' }));
    expect(await store.holdIfHeld(held(topic, { businessKey: 'a' }))).toBe(true);
    expect((await redisHeldCounts(redis, [topic])()).get(topic)).toBe(2);
  });

  test('ST-T19_보류는7일이지나도저절로풀리지않는다(다시처리할때까지둔다)', async () => {
    const topic = `t-${crypto.randomUUID()}`;
    const clock = fakeClock({ now: Date.now() });
    const store = new RedisHeldEventStore(redis, clock);
    await store.hold(held(topic, { businessKey: 'a' }));
    clock.advance(30 * DAY);
    expect(await store.isHeld(topic, 'a')).toBe(true);
    expect(await store.heldKeys(topic, 0)).toEqual(new Set(['a']));
    expect((await redisHeldCounts(redis, [topic])()).get(topic)).toBe(1);
  });

  test('[ASVS v5.0.0-14.2.4] ST-T19_탈퇴사건은값을purgeBy(탈퇴+5일이내)까지만두고_읽지못하면값·머리없이위치만두며_보류표시는남는다', async () => {
    const topic = 'identity.accounts-withdrawn';
    const now = Date.now();
    const store = new RedisHeldEventStore(redis, fakeClock({ now }));
    const ok = held(topic, { partition: 9, value: Buffer.from(JSON.stringify({ pids: ['p'], withdrawnAt: new Date(now).toISOString(), purgeBy: new Date(now + 2 * DAY).toISOString() })) });
    await store.hold(ok);
    const v = heldKeys.value(topic, 9, ok.offset);
    expect(Number(await cmd(v, ['PEXPIRETIME', v]))).toBe(now + 2 * DAY);
    const bad = held(topic, { partition: 9, value: Buffer.from('{"pids":["p"]') });
    await store.hold(bad);
    const bv = heldKeys.value(topic, 9, bad.offset);
    expect(await cmd(bv, ['EXISTS', bv])).toBe(0);
    const br = heldKeys.record(topic, 9, bad.offset);
    expect(await cmd(br, ['HEXISTS', br, 'headers'])).toBe(0);
    expect(String(await cmd(br, ['HGET', br, 'valueKept']))).toBe('0');
    expect(await store.isHeld(topic, bad.businessKey)).toBe(true);
  });

  test('ST-T19_토픽마다상한을넘으면넣지않고일시실패다(noeviction클러스터를채우지않게)', async () => {
    const topic = `t-${crypto.randomUUID()}`;
    const store = new RedisHeldEventStore(redis, fakeClock({ now: Date.now() }), 2);
    await store.hold(held(topic));
    await store.hold(held(topic));
    const err = await store.hold(held(topic)).catch((x: unknown) => x);
    expect(isTransientError(err)).toBe(true);
    expect((await redisHeldCounts(redis, [topic])()).get(topic)).toBe(2);
  });
});
