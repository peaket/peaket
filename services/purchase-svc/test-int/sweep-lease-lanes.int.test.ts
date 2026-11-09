// 회차별 임대의 두 줄을 실제 Valkey 8.1로 돈다(RedisSweepLeases, docs/data.md §3 s:{event:E}:sweep·sesweep, docs/features/seat-hold.md §2 '정리 색인과 1초 반복', BUILD_ORDER PRF-138).
// 'expiry'(기본)는 s:{event:E}:sweep, 'session'은 s:{event:E}:sesweep이라 서로 막지 않고, 같은 줄 안의 규칙(내 것이면 늘림, 비었거나 지났으면 잡음, 남의 것이면 거짓)은 같다.
// 키 이름은 도우미(seatKeys)가 아니라 글자 그대로 적어 확인한다. 메모리 구현과 가짜 Redis로 본 호출은 test/sweep-lease-lanes.test.ts에 있다.
import 'reflect-metadata';
import { createHotRedis, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { RedisSweepLeases, SeatStoreUnavailable } from '../src/modules/inventory/index.js';
import { newEvent } from '../test/hold-cases.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const TTL = 3000;
let valkey: ValkeyContainer | undefined;
let redis: HotRedis;
let leases: RedisSweepLeases;

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
  leases = new RedisSweepLeases(redis);
});

afterAll(async () => {
  await redis?.close();
  valkey?.stop();
});

const sweepKey = (e: string) => `s:{event:${e}}:sweep`;
const sesweepKey = (e: string) => `s:{event:${e}}:sesweep`;
const get = (key: string) => redis.command(['GET', key], { key }).then((v) => (v === null ? null : String(v)));
const pttl = async (key: string) => Number(await redis.command(['PTTL', key], { key }));

/** 조건이 설 때까지 0.05초마다 본다(고정 sleep 없이, 5초 안에 안 되면 던진다) */
async function until(ok: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${what}이(가) 5초 안에 되지 않았다`);
}

describe('RedisSweepLeases: 줄마다 다른 키', () => {
  test('QT11_NFR025_ session 줄은 s:{event:E}:sesweep에 파드 ID를 수명 3초 이하로 쓰고 만료 임대 키는 건드리지 않는다', async () => {
    const e = newEvent();
    expect(await leases.acquire(e, 'pod-a', TTL, 'session')).toBe(true);
    expect(await get(sesweepKey(e))).toBe('pod-a');
    const ttl = await pttl(sesweepKey(e));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(TTL);
    expect(await get(sweepKey(e))).toBeNull();
  });

  test('QT11_NFR025_ expiry 줄과 줄 인자가 없을 때는 s:{event:E}:sweep에 쓰고 정리 임대 키는 건드리지 않는다', async () => {
    const e = newEvent();
    expect(await leases.acquire(e, 'pod-a', TTL, 'expiry')).toBe(true);
    expect(await get(sweepKey(e))).toBe('pod-a');
    expect(await get(sesweepKey(e))).toBeNull();
    const e2 = newEvent();
    expect(await leases.acquire(e2, 'pod-b', TTL)).toBe(true);
    expect(await get(sweepKey(e2))).toBe('pod-b');
    expect(await get(sesweepKey(e2))).toBeNull();
  });

  test('QT11_NFR025_ 한 줄을 다른 파드가 잡고 있어도 다른 줄은 잡힌다: 두 줄은 서로 막지 않는다', async () => {
    const e = newEvent();
    expect(await leases.acquire(e, 'pod-a', TTL, 'expiry')).toBe(true);
    expect(await leases.acquire(e, 'pod-b', TTL, 'session')).toBe(true);
    expect(await get(sweepKey(e))).toBe('pod-a');
    expect(await get(sesweepKey(e))).toBe('pod-b');
    // 각자 자기 줄은 늘리고 남의 줄은 못 잡는다
    expect(await leases.acquire(e, 'pod-a', TTL, 'expiry')).toBe(true);
    expect(await leases.acquire(e, 'pod-b', TTL, 'session')).toBe(true);
    expect(await leases.acquire(e, 'pod-a', TTL, 'session')).toBe(false);
    expect(await leases.acquire(e, 'pod-b', TTL, 'expiry')).toBe(false);
    expect(await get(sweepKey(e))).toBe('pod-a');
    expect(await get(sesweepKey(e))).toBe('pod-b');
  });

  test('QT11_NFR025_ 줄은 회차마다 따로다', async () => {
    const e1 = newEvent();
    const e2 = newEvent();
    expect(await leases.acquire(e1, 'pod-a', TTL, 'session')).toBe(true);
    expect(await leases.acquire(e2, 'pod-b', TTL, 'session')).toBe(true);
    expect(await get(sesweepKey(e1))).toBe('pod-a');
    expect(await get(sesweepKey(e2))).toBe('pod-b');
  });
});

describe.each(['expiry', 'session'] as const)('RedisSweepLeases: %s 줄 안의 규칙', (lane) => {
  const keyOf = (e: string) => (lane === 'session' ? sesweepKey(e) : sweepKey(e));

  test(`QT11_NFR025_${lane}_ 내 것이면 수명을 지금부터 다시 건다(PEXPIRE): 줄여 둔 수명이 다시 3초 가까이로 늘어난다`, async () => {
    const e = newEvent();
    const key = keyOf(e);
    expect(await leases.acquire(e, 'pod-a', TTL, lane)).toBe(true);
    await redis.command(['PEXPIRE', key, '200'], { key });
    expect(await pttl(key)).toBeLessThanOrEqual(200);
    expect(await leases.acquire(e, 'pod-a', TTL, lane)).toBe(true);
    expect(await pttl(key)).toBeGreaterThan(1000);
    expect(await get(key)).toBe('pod-a');
  });

  test(`QT11_NFR025_${lane}_ 남의 것이면 거짓이고 값도 수명도 바꾸지 않는다`, async () => {
    const e = newEvent();
    const key = keyOf(e);
    expect(await leases.acquire(e, 'pod-a', TTL, lane)).toBe(true);
    await redis.command(['PEXPIRE', key, '2000'], { key });
    expect(await leases.acquire(e, 'pod-b', 60_000, lane)).toBe(false);
    expect(await get(key)).toBe('pod-a');
    expect(await pttl(key)).toBeLessThanOrEqual(2000);
  });

  test(`QT11_NFR025_${lane}_ 수명이 다하면(키가 사라지면) 다른 파드가 잡고, 그 뒤로는 앞 파드가 못 잡는다`, async () => {
    const e = newEvent();
    const key = keyOf(e);
    expect(await leases.acquire(e, 'pod-a', 150, lane)).toBe(true);
    await until(async () => (await get(key)) === null, '임대 수명 만료');
    expect(await leases.acquire(e, 'pod-b', TTL, lane)).toBe(true);
    expect(await get(key)).toBe('pod-b');
    expect(await leases.acquire(e, 'pod-a', TTL, lane)).toBe(false);
  });

  test(`QT11_NFR025_${lane}_ 모양이 틀리면 RangeError이고 키를 만들지 않는다`, async () => {
    const e = newEvent();
    await expect(leases.acquire(e, 'pod:a', TTL, lane)).rejects.toBeInstanceOf(RangeError);
    await expect(leases.acquire(e, 'pod-a', 0, lane)).rejects.toBeInstanceOf(RangeError);
    expect(await get(keyOf(e))).toBeNull();
  });
});

describe('RedisSweepLeases: 메모리 부족(maxmemory, noeviction)', () => {
  test('NFR015_QT11_ 메모리가 차면 session 줄 임대도 SeatStoreUnavailable(reason oom)이고 키를 만들지 않는다. 메모리가 돌아오면 잡는다 [ASVS v5.0.0-16.3.4]', async () => {
    const policy = await redis.command(['CONFIG', 'GET', 'maxmemory-policy'], { key: 'x' });
    expect(JSON.stringify(policy)).toContain('noeviction');
    const e = newEvent();
    await redis.command(['CONFIG', 'SET', 'maxmemory', '1'], { key: 'x' });
    try {
      const x = await leases.acquire(e, 'pod-a', TTL, 'session').then(
        () => null,
        (err: unknown) => err,
      );
      expect(x).toBeInstanceOf(SeatStoreUnavailable);
      expect((x as SeatStoreUnavailable).reason).toBe('oom');
    } finally {
      await redis.command(['CONFIG', 'SET', 'maxmemory', '0'], { key: 'x' });
    }
    expect(await get(sesweepKey(e))).toBeNull();
    expect(await leases.acquire(e, 'pod-a', TTL, 'session')).toBe(true);
  });
});
