// 예매 제한 사본 읽기(booking RedisBookingRestrictions)를 실제 Valkey 8.1로 돈다(BUILD_ORDER PRF-161, P-T49의 저장소 쪽).
// 정본: docs/data.md §3 s:rst:{account} 행(칸 st·until·rid·ver), docs/features/payment.md §2 '예매 제한 확인'·'주문 생성의 첫 구현' 예매 제한 사본,
// booking domain/ports.ts BookingRestrictions와 adapters/redis-booking-restrictions.ts의 설명.
// 사본을 쓰는 쪽(SetBookingRestriction 받기)은 GAT-310이라, 여기서는 Hash를 직접 HSET해 준비한다. 계정마다 새 UUID를 쓰고 Valkey를 비우지 않는다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createHotRedis, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { bookingRestrictionKey, OrderSeatStoreUnavailable, RedisBookingRestrictions } from '../src/modules/booking/index.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer | undefined;
let redis: HotRedis;

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
});

afterAll(async () => {
  await redis?.close();
  valkey?.stop();
});

/** 명령을 세는 겉 */
function counting(inner: HotRedis) {
  const calls: string[][] = [];
  const r: HotRedis = {
    command: (a, o) => {
      calls.push([...a]);
      return inner.command(a, o);
    },
    sendCommand: (a) => {
      calls.push([...a].map(String));
      return inner.sendCommand(a);
    },
    evalScript: (s, k, a, o) => {
      calls.push(['EVALSHA', ...k]);
      return inner.evalScript(s, k, a, o);
    },
    close: () => inner.close(),
  };
  return { redis: r, calls };
}

/** 사본 Hash를 칸 그대로 넣는다(GAT-310이 쓸 모양) */
async function put(accountId: string, fields: Record<string, string>): Promise<void> {
  const key = bookingRestrictionKey(accountId);
  await redis.command(['HSET', key, ...Object.entries(fields).flat()], { key });
}

const UNTIL = 1_793_761_199_200; // 2026-11-04T23:59:59.200Z 근처의 유닉스 밀리초

describe('RedisBookingRestrictions.read', () => {
  test('키 이름은 s:rst:{계정 ID}다(회차 해시 태그 없이 계정 단위로 흩는다)', () => {
    const a = randomUUID();
    expect(bookingRestrictionKey(a)).toBe(`s:rst:${a}`);
  });

  test('PT49_사본이 없으면 undefined(제한 없음)다', async () => {
    expect(await new RedisBookingRestrictions(redis).read(randomUUID())).toBeUndefined();
  });

  test('PT49_①_ACTIVE이고 until이 있으면 { st: ACTIVE, untilMs }다(rid·ver 칸은 보지 않는다)', async () => {
    const a = randomUUID();
    await put(a, { st: 'ACTIVE', until: String(UNTIL), rid: randomUUID(), ver: '7' });
    expect(await new RedisBookingRestrictions(redis).read(a)).toEqual({ st: 'ACTIVE', untilMs: UNTIL });
  });

  test('PT49_①_ACTIVE이고 until 칸이 없으면 끝 없음이라 untilMs가 없다', async () => {
    const a = randomUUID();
    await put(a, { st: 'ACTIVE', rid: randomUUID(), ver: '1' });
    const r = await new RedisBookingRestrictions(redis).read(a);
    expect(r).toEqual({ st: 'ACTIVE' });
    expect(r).not.toHaveProperty('untilMs');
  });

  test('PT49_①_ACTIVE이고 until이 빈 글이면(data.md: 비면 끝 없음) untilMs가 없다', async () => {
    const a = randomUUID();
    await put(a, { st: 'ACTIVE', until: '', rid: randomUUID(), ver: '2' });
    const r = await new RedisBookingRestrictions(redis).read(a);
    expect(r).toEqual({ st: 'ACTIVE' });
    expect(r).not.toHaveProperty('untilMs');
  });

  test('PT49_④_LIFTED는 { st: LIFTED }이고 until이 있으면 그대로 싣는다(판정은 쓰임새가 한다)', async () => {
    const a = randomUUID();
    await put(a, { st: 'LIFTED', rid: randomUUID(), ver: '3' });
    expect(await new RedisBookingRestrictions(redis).read(a)).toEqual({ st: 'LIFTED' });
    const b = randomUUID();
    await put(b, { st: 'LIFTED', until: String(UNTIL), ver: '4' });
    expect(await new RedisBookingRestrictions(redis).read(b)).toEqual({ st: 'LIFTED', untilMs: UNTIL });
  });

  test("until '0'은 0 이상 정수의 경계라 받는다(untilMs 0)", async () => {
    const a = randomUUID();
    await put(a, { st: 'ACTIVE', until: '0' });
    expect(await new RedisBookingRestrictions(redis).read(a)).toEqual({ st: 'ACTIVE', untilMs: 0 });
  });

  // 리뷰 고침 L3(2026-11-05): 네 칸(st·until·rid·ver)을 함께 읽는다. 키가 아예 없을 때만 사본 없음이고, 다른 칸이 있는데 st가 없으면 망가진 사본이다
  test.each<[string, Record<string, string>]>([
    ['until·rid·ver', { until: String(UNTIL), rid: randomUUID(), ver: '5' }],
    ['rid만', { rid: randomUUID() }],
    ['ver만', { ver: '3' }],
    ['until만', { until: String(UNTIL) }],
  ])('ASVS16.5.3_st 칸이 없고 다른 칸(%s)만 있으면 망가진 사본이라 Error다(제한 없음으로 숨기지 않는다) [ASVS v5.0.0-16.5.3]', async (_label, fields) => {
    const a = randomUUID();
    await put(a, fields);
    const err = await new RedisBookingRestrictions(redis).read(a).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(OrderSeatStoreUnavailable);
  });

  test('네 칸이 모두 없으면(모르는 칸만 있는 Hash 포함) 사본이 없는 것으로 본다(HMGET 한 번으로 네 칸만 본다)', async () => {
    const a = randomUUID();
    await put(a, { other: 'x' });
    expect(await new RedisBookingRestrictions(redis).read(a)).toBeUndefined();
  });

  test('읽기는 HMGET 한 번(네 칸 st·until·rid·ver)이고 아무것도 쓰지 않는다(키 값·수명이 그대로)', async () => {
    const a = randomUUID();
    await put(a, { st: 'ACTIVE', until: String(UNTIL), rid: 'r1', ver: '9' });
    const key = bookingRestrictionKey(a);
    await redis.command(['PEXPIRE', key, '600000'], { key });
    const at = Number(await redis.command(['PEXPIRETIME', key], { key }));
    const c = counting(redis);
    await new RedisBookingRestrictions(c.redis).read(a);
    expect(c.calls).toEqual([['HMGET', key, 'st', 'until', 'rid', 'ver']]);
    expect(Number(await redis.command(['PEXPIRETIME', key], { key }))).toBe(at);
    expect((await redis.command(['HMGET', key, 'st', 'until', 'rid', 'ver'], { key })) as unknown[]).toEqual(['ACTIVE', String(UNTIL), 'r1', '9']);
  });

  // 정본 모호: st 칸이 빈 글이면 '없음'(사본 없음)인지 '틀린 값'(망가진 사본)인지 적혀 있지 않다. 어댑터 설명의 'st가 ACTIVE·LIFTED가 아니면 Error'를 따라 망가진 사본으로 가정한다
  // 망가진 사본 시험은 같은 계정의 맞는 사본을 먼저 읽어 본 뒤(읽기가 되는 저장소에서) 칸 하나만 망가뜨린다
  test.each(['active', 'Active', 'BANNED', 'RESTRICTED', ''])("st가 ACTIVE·LIFTED가 아니면('%s') 망가진 사본이라 Error다(제한 없음으로 숨기지 않는다)", async (st) => {
    const a = randomUUID();
    await put(a, { st: 'ACTIVE', until: String(UNTIL) });
    const restrictions = new RedisBookingRestrictions(redis);
    expect(await restrictions.read(a)).toEqual({ st: 'ACTIVE', untilMs: UNTIL });
    await put(a, { st });
    const err = await restrictions.read(a).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(OrderSeatStoreUnavailable);
  });

  test.each(['0123', '-1', '1.5', 'abc', '1e3', ' 5', '9007199254740993', '0x10'])("until이 빈 글이 아닌데 앞 0 없는 0 이상 안전한 정수 글이 아니면('%s') 망가진 사본이라 Error다", async (until) => {
    const a = randomUUID();
    await put(a, { st: 'ACTIVE', until: String(UNTIL) });
    const restrictions = new RedisBookingRestrictions(redis);
    expect(await restrictions.read(a)).toEqual({ st: 'ACTIVE', untilMs: UNTIL });
    await put(a, { until });
    const err = await restrictions.read(a).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(OrderSeatStoreUnavailable);
  });

  test.each([
    ['대문자 UUID', randomUUID().toUpperCase()],
    ['UUID가 아님', 'acct-1'],
    ['해시 태그를 여는 {', '{x}'],
    ['빈 글', ''],
  ])('ASVS1.2.4_계정 ID가 소문자 UUID가 아니면(%s) RangeError이고 좌석 Redis를 부르지 않는다 [ASVS v5.0.0-1.2.4]', async (_label, accountId) => {
    const c = counting(redis);
    await expect(new RedisBookingRestrictions(c.redis).read(accountId)).rejects.toThrow(RangeError);
    expect(c.calls).toEqual([]);
  });

  test('키의 형이 틀리면(문자열) 일시 장애가 아닌 오류다(WRONGTYPE, OrderSeatStoreUnavailable이 아니다)', async () => {
    const a = randomUUID();
    const key = bookingRestrictionKey(a);
    await redis.command(['SET', key, 'x'], { key });
    const err = await new RedisBookingRestrictions(redis).read(a).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(OrderSeatStoreUnavailable);
    expect(String((err as Error).message)).toMatch(/WRONGTYPE/);
  });

  test('좌석 Redis가 답하지 않으면(CLIENT PAUSE, 플랫폼 기본 마감) OrderSeatStoreUnavailable을 던진다', async () => {
    const a = randomUUID();
    await put(a, { st: 'ACTIVE' });
    const pauser = await createHotRedis({ url: valkey!.url });
    try {
      await pauser.command(['CLIENT', 'PAUSE', '1000', 'ALL'], {});
      await expect(new RedisBookingRestrictions(redis).read(a)).rejects.toBeInstanceOf(OrderSeatStoreUnavailable);
    } finally {
      await pauser.command(['CLIENT', 'UNPAUSE'], {}).catch(() => undefined);
      for (let i = 0; i < 40; i += 1) {
        if (await redis.command(['PING'], {}).then(() => true, () => false)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await pauser.close();
    }
    expect(await new RedisBookingRestrictions(redis).read(a)).toEqual({ st: 'ACTIVE' });
  });
});
