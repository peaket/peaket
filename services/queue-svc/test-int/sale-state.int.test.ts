// 회차 판매 상태 받기를 실제 Valkey 8.1로 돈다(test/sale-state-cases.ts의 사례를 메모리 저장소와 똑같이). 이어서 같은 notice를 진입 ②·대기 상태 파일 읽기가 보는지 본다
// (docs/features/queue-admission.md §4 '판매 상태와 Kafka 구독의 첫 구현', ADR-0214).
import { createHotRedis, type HotRedis, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { keys, RedisEntryStore } from '../src/modules/entry/adapters/redis-entry-store.js';
import { RedisEventSchedules } from '../src/modules/entry/adapters/redis-event-schedules.js';
import { type EventSchedule, keepUntilOf, PLATFORM_SCOPE } from '../src/modules/entry/domain/queue.js';
import { ApplySaleChange, RedisSaleStates } from '../src/modules/sale/index.js';
import { RedisStateSnapshots } from '../src/modules/state/adapters/redis-state-snapshots.js';
import { buildStateFiles, type QueueStateBody } from '../src/modules/state/domain/state.js';
import { saleEvent, saleStateCases } from '../test/sale-state-cases.js';
import { newEvent, openSchedule } from '../test/support.js';
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

async function writeSchedule(eventId: string, s: EventSchedule): Promise<void> {
  const key = keys.cfg(eventId);
  await cmd(key, ['HSET', key, 'opensAtMs', String(s.opensAtMs), 'startsAtMs', String(s.startsAtMs), 'lobbyShuffle', s.lobbyShuffle ? '1' : '0', 'openBatch', s.openBatch ? '1' : '0', 'rev', '1']);
}

saleStateCases('Valkey Lua', async () => {
  const schedules = new RedisEventSchedules(redis, systemClock);
  return {
    states: new RedisSaleStates(redis),
    schedules: Object.assign(schedules, { set: writeSchedule }),
    clock: systemClock,
    setSeq: async (e, n) => void (await cmd(keys.seq(e), ['SET', keys.seq(e), String(n)])),
    notice: async (e) => {
      const flat = (await cmd(keys.notice(e), ['HGETALL', keys.notice(e)])) as unknown;
      // node-redis는 HGETALL을 객체로 준다(RESP2 배열이면 짝으로 푼다)
      if (Array.isArray(flat)) return Object.fromEntries(Array.from({ length: flat.length / 2 }, (_, i) => [String(flat[2 * i]), String(flat[2 * i + 1])]));
      return Object.fromEntries(Object.entries(flat as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
    },
    expireAt: async (e) => {
      const at = Number(await cmd(keys.notice(e), ['PEXPIRETIME', keys.notice(e)]));
      return at > 0 ? at : null;
    },
    setNoticeFields: async (e, f) => void (await cmd(keys.notice(e), ['HSET', keys.notice(e), ...Object.entries(f).flat()])),
  };
});

test('[ASVS v5.0.0-15.4.2] Q-T51②_매진판을쓴뒤에는_진입②Lua가번호를내지않고_대기상태파일읽기가그판매상태를본다', async () => {
  const eventId = newEvent();
  const s = openSchedule(Date.now(), { openBatch: false });
  await writeSchedule(eventId, s);
  const entry = new RedisEntryStore(redis);
  const common = { eventId, expireAtMs: keepUntilOf(s), opensAtMs: s.opensAtMs, lobbyShuffle: false, openBatch: false };
  expect(await entry.numberBatch({ ...common, items: [{}, {}] })).toEqual([
    { kind: 'NUMBERED', seq: 1, gen: 1 },
    { kind: 'NUMBERED', seq: 2, gen: 1 },
  ]);
  const apply = new ApplySaleChange(new RedisSaleStates(redis), new RedisEventSchedules(redis, systemClock), systemClock);
  expect(await apply.run(saleEvent(eventId, { status: 'SOLD_OUT', version: 5, soldOutTiers: ['R'] }))).toEqual({ kind: 'APPLIED', soldOutLastSeq: 2 });
  expect(await entry.numberBatch({ ...common, items: [{}] })).toEqual([{ kind: 'SOLD_OUT' }]);
  expect(Number(await cmd(keys.seq(eventId), ['GET', keys.seq(eventId)]))).toBe(2);

  const snap = await new RedisStateSnapshots(redis).read(eventId);
  expect(snap.notice).toMatchObject({ saleState: 'SOLD_OUT', soldOutTiers: ['R'], paused: false, suspended: false });

  // 매진 풀림: 다시 번호를 낸다(그 앞 번호까지의 대기는 soldOutLastSeq로 끝났다)
  await apply.run(saleEvent(eventId, { status: 'ON_SALE', previousStatus: 'SOLD_OUT', version: 6 }));
  expect(await entry.numberBatch({ ...common, items: [{}] })).toEqual([{ kind: 'NUMBERED', seq: 3, gen: 1 }]);
  await apply.run(saleEvent(eventId, { status: 'ENDED', version: 7 }));
  expect(await entry.numberBatch({ ...common, items: [{}] })).toEqual([{ kind: 'ENDED' }]);
});

test('대기상태파일읽기는_notice의제어칸(paused·suspended·banner)과_ctl의입장일시정지를_같은Lua로읽고_전체범위공지를따로읽는다', async () => {
  const eventId = newEvent();
  await cmd(keys.notice(eventId), ['HSET', keys.notice(eventId), 'paused', '1', 'banner', '안내', 'soldOutTiers', 'not-json']);
  await cmd(keys.ctl(eventId), ['HSET', keys.ctl(eventId), 'admitPaused', '1', 'admitPausedUntil', '1893456000000']);
  const r = new RedisStateSnapshots(redis);
  const snap = await r.read(eventId);
  expect(snap.notice).toEqual({ soldOutTiers: [], paused: true, suspended: false, banner: '안내' });
  expect(snap.admit).toEqual({ paused: true, untilMs: 1893456000000 });
  expect((await r.read(newEvent())).admit).toEqual({ paused: false, untilMs: null });

  expect(await r.readPlatform()).toEqual({ paused: false, suspended: false });
  const pk = keys.notice(PLATFORM_SCOPE);
  await cmd(pk, ['HSET', pk, 'suspended', '1', 'banner', '전체 공지']);
  expect(await r.readPlatform()).toEqual({ paused: false, suspended: true, banner: '전체 공지' });
  await cmd(pk, ['DEL', pk]);
});

test('Q-T64①②_판매상태Lua가쓴셈칸을_대기상태파일읽기Lua가같은회차슬롯에서읽어_30초안이면파일에싣는다', async () => {
  const eventId = newEvent();
  const s = openSchedule(Date.now());
  await writeSchedule(eventId, s);
  const apply = new ApplySaleChange(new RedisSaleStates(redis), new RedisEventSchedules(redis, systemClock), systemClock);
  const countedAt = Date.now();
  await apply.run(saleEvent(eventId, { version: 2, available: 37, countedAt: new Date(countedAt).toISOString(), avgTicketsPerOrder: 1.5 }));
  const snap = await new RedisStateSnapshots(redis).read(eventId);
  expect(snap.notice).toMatchObject({ remainingSeats: 37, seatsAtMs: countedAt, avgTicketsPerOrder: 1.5 });
  const f = JSON.parse(buildStateFiles(snap, s, Math.floor(Date.now() / 1000) * 1000, {}, eventId)[0]!.body) as QueueStateBody;
  expect([f.remainingSeats, f.avgTicketsPerOrder]).toEqual([37, 1.5]);
});

test('Q-T64④_일정사본의layoutVersion은정수글(1~2^32−1,0은게시하지않는초안)일때만읽고_모양이틀리면그칸만빼며일정은그대로연다', async () => {
  const schedules = new RedisEventSchedules(redis, systemClock);
  const cases: [string, number | undefined][] = [
    ['7', 7],
    ['0', undefined],
    ['1', 1],
    ['4294967295', 4294967295],
    ['4294967296', undefined],
    ['07', undefined],
    ['v1', undefined],
  ];
  for (const [raw, want] of cases) {
    const eventId = newEvent();
    await writeSchedule(eventId, openSchedule(Date.now()));
    await cmd(keys.cfg(eventId), ['HSET', keys.cfg(eventId), 'layoutVersion', raw]);
    const got = await schedules.get(eventId);
    expect(got, raw).not.toBeNull();
    expect(got!.layoutVersion, raw).toBe(want);
  }
});
