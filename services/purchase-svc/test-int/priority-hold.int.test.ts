// 우선 구매 보류 Lua를 실제 Valkey 8.1로 본다(GAT-135, S-T37 ①, docs/features/seat-hold.md §5 '우선 구매 보류').
// 비트·kind PRIORITY Hash·`s:{event:E}:prio`를 한 Lua가 쓰고, 7분 만료 인덱스에는 넣지 않는지 확인한다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createHotRedis, fakeClock, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MemorySeatMap, RedisOrderHolds, RedisSeatStore, seatKeys } from '../src/modules/inventory/index.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const NOW = Date.parse('2026-11-14T08:00:00.000Z');
const DAY = 86_400_000;
let valkey: ValkeyContainer | undefined;
let redis: HotRedis;
let store: RedisSeatStore;

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
  store = new RedisSeatStore(redis, undefined, fakeClock({ now: NOW }));
});
afterAll(async () => {
  await redis?.close();
  valkey?.stop();
});

const hash = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (Array.isArray(v)) for (let i = 0; i < v.length; i += 2) out[String(v[i])] = String(v[i + 1]);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = String(x);
  return out;
};

describe('우선 구매 보류 Lua [GAT-135, S-T37 ①]', () => {
  test('S-T37 ①_같은_좌석을_PRIORITY로_잡고_prio_인덱스에만_넣는다', async () => {
    const eventId = randomUUID();
    const accountId = randomUUID();
    const grantId = randomUUID();
    const seat = { seatId: randomUUID(), index: 7, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: 7, tierId: 'R' };
    await store.openSale({ eventId, seatCount: 10, keepUntilMs: NOW + 10 * DAY });
    const r = await store.holdPriority({ eventId, accountId, grantId, seat, expiresAtMs: NOW + DAY, keepUntilMs: NOW + 2 * DAY });
    expect(r).toMatchObject({ kind: 'OK', seatId: seat.seatId, expiresAtMs: NOW + DAY });
    expect(hash(await redis.command(['HGETALL', seatKeys.hold(eventId, seat.index)], { key: seatKeys.hold(eventId, seat.index) }))).toMatchObject({
      holdId: grantId,
      owner: accountId,
      psid: '',
      kind: 'PRIORITY',
      priorityGrantId: grantId,
    });
    expect(Number(await redis.command(['ZSCORE', seatKeys.prio(eventId), String(seat.index)], { key: seatKeys.prio(eventId) }))).toBe(NOW + DAY);
    expect(await redis.command(['ZSCORE', seatKeys.expiry(eventId), String(seat.index)], { key: seatKeys.expiry(eventId) })).toBeNull();
    const again = await store.holdPriority({ eventId, accountId: randomUUID(), grantId: randomUUID(), seat, expiresAtMs: NOW + DAY, keepUntilMs: NOW + 2 * DAY });
    expect(again).toEqual({ kind: 'CONFLICT', seatId: seat.seatId });
  });

  test('S-T37 ④_우선_주문의_홀드_확인은_같은_권리_ID의_PRIORITY_홀드만_OK다', async () => {
    const eventId = randomUUID();
    const accountId = randomUUID();
    const grantId = randomUUID();
    const seat = { seatId: randomUUID(), index: 3, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: 3, tierId: 'R' };
    await store.openSale({ eventId, seatCount: 10, keepUntilMs: NOW + 10 * DAY });
    expect(await store.holdPriority({ eventId, accountId, grantId, seat, expiresAtMs: NOW + DAY, keepUntilMs: NOW + 2 * DAY })).toMatchObject({ kind: 'OK' });
    const map = new MemorySeatMap();
    map.put({ eventId, layoutVersion: 'v1', seatCount: 10, perAccountLimit: 4, saleEndsAtMs: NOW + 10 * DAY }, [seat]);
    const holds = new RedisOrderHolds(redis, map);
    const base = { eventId, purchaseSessionId: randomUUID(), accountId, holdId: grantId, priorityGrantId: grantId, prioritySeatId: seat.seatId };
    expect(await holds.check(base)).toMatchObject({ status: 'OK', kind: 'PRIORITY', priorityGrantId: grantId, seats: [{ seatId: seat.seatId }] });
    const other = randomUUID();
    expect(await holds.check({ ...base, holdId: other, priorityGrantId: other })).toEqual({ status: 'NOT_FOUND' });
  });

  test('GAT135_만료_시각이_지난_보류는_EXPIRED이고_아무것도_잡지_않는다', async () => {
    const eventId = randomUUID();
    const seat = { seatId: randomUUID(), index: 1, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: 1, tierId: 'R' };
    await store.openSale({ eventId, seatCount: 10, keepUntilMs: NOW + 10 * DAY });
    const r = await store.holdPriority({ eventId, accountId: randomUUID(), grantId: randomUUID(), seat, expiresAtMs: NOW - 1, keepUntilMs: NOW + 2 * DAY });
    expect(r).toEqual({ kind: 'EXPIRED' });
    expect(await redis.command(['GETBIT', seatKeys.bitmap(eventId), String(seat.index)], { key: seatKeys.bitmap(eventId) })).toBe(0);
  });
});
