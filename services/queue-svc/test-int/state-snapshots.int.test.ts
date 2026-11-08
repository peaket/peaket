// 대기 상태 파일의 값 읽기를 실제 Valkey 8.1로 본다(회차 슬롯 Lua 하나, 빠진 번호 비트맵은 바이트로 받음, docs/features/queue-admission.md §4)
import { createHotRedis, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { RedisEntryStore, keys } from '../src/modules/entry/adapters/redis-entry-store.js';
import { RedisStateMirrorLease } from '../src/modules/state/adapters/redis-state-mirror-lease.js';
import { RedisStateSnapshots } from '../src/modules/state/adapters/redis-state-snapshots.js';
import { AHEAD_SEGMENTS, buildStateFiles, type QueueStateBody } from '../src/modules/state/domain/state.js';
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

test('회차슬롯Lua하나로_seq·serving·빠진번호비트맵(바이트)·건너뛴구간·serving_log·calls를읽는다', async () => {
  const e = newEvent();
  const store = new RedisEntryStore(redis);
  const expireAtMs = Date.now() + 86_400_000;
  for (let i = 0; i < 2_005; i++) await store.number({ eventId: e, expireAtMs });
  // 번호 1·8(바이트 0x81)과 1,000·2,004를 빠진 번호로, 1,201~1,260은 장애 전환 때 건너뛴 구간으로
  for (const seq of [1, 8, 1_000, 2_004]) await store.markRemoved({ eventId: e, seq, expireAtMs });
  await cmd(keys.skipped(e), ['RPUSH', keys.skipped(e), '1201:1260:1']);
  // 리더가 쓸 값(BUILD_ORDER PRF-090): serving, 1초 칸 기록, 전진 기록 {전진 시각}:{유효 번호 수}
  const now = Date.now();
  const slot = Math.floor(now / 1000);
  await cmd(keys.serving(e), ['SET', keys.serving(e), '1100']);
  await cmd(keys.servingLog(e), ['ZADD', keys.servingLog(e), '900', String(slot - 1), '1100', String(slot)]);
  await cmd(keys.calls(e), ['ZADD', keys.calls(e), '900', `${now - 1_000}:300`, '1100', `${now - 200}:199`]);

  const s = await new RedisStateSnapshots(redis).read(e);
  expect(s).toMatchObject({ seq: 2_005, serving: 1_100, skipped: [{ start: 1_201, end: 1_260 }] });
  expect(s.removed[0]).toBe(0b0100_0000); // 번호 n = 비트 n(높은 비트부터)이라 번호 1은 둘째 비트, 0번 비트는 쓰지 않는다
  expect(s.removed[1]).toBe(0b1000_0000); // 번호 8
  expect(s.removed.length).toBe(Math.floor(2_005 / 8) + 1);
  expect(s.servingLog).toEqual([{ slot: slot - 1, serving: 900 }, { slot, serving: 1_100 }]);
  expect(s.calls).toEqual([{ atMs: now - 1_000, last: 900 }, { atMs: now - 200, last: 1_100 }]);

  const files = buildStateFiles(s, openSchedule(now), Math.floor(now / 1000) * 1000).map((f) => JSON.parse(f.body) as QueueStateBody);
  expect(files).toHaveLength(3 + AHEAD_SEGMENTS);
  const b0 = Buffer.from(files[0]!.removedBitmap, 'base64');
  expect(b0[0]).toBe(0b1000_0001); // 구간 0의 k=0(번호 1)과 k=7(번호 8)
  expect(files.slice(0, 4).map((f) => f.removedBeforeSegment)).toEqual([0, 3, 63, 64]);
  expect(files[0]!.removedUpToServing).toBe(3);
});

test('[Q-T66] notice의stateDegraded를_회차와전체범위에서읽어_파일의폴링힌트가2배가된다', async () => {
  const snapshots = new RedisStateSnapshots(redis);
  const e = newEvent();
  await cmd(keys.notice(e), ['HSET', keys.notice(e), 'stateDegraded', '1']);
  const s = await snapshots.read(e);
  expect(s.notice?.stateDegraded).toBe(true);
  const f = JSON.parse(buildStateFiles(s, openSchedule(Date.now()), Date.now())[0]!.body) as QueueStateBody;
  expect(f.pollHintMs).toBe(1000);
  const p = keys.notice('PLATFORM');
  await cmd(p, ['HSET', p, 'stateDegraded', '1']);
  try {
    expect((await snapshots.readPlatform()).stateDegraded).toBe(true);
  } finally {
    await cmd(p, ['HDEL', p, 'stateDegraded']);
  }
});

test('[Q-T66] 같은초의사본쓰기는_파드하나만잡고_수명이지나면다시잡는다', async () => {
  const lease = new RedisStateMirrorLease(redis);
  const e = newEvent();
  expect(await lease.claim(e)).toBe(true);
  expect(await lease.claim(e)).toBe(false);
  await new Promise((r) => setTimeout(r, 950));
  expect(await lease.claim(e)).toBe(true);
});

test('아무것도없는회차는_seq·serving0과빈비트맵이고_판매상태칸·입장일시정지도없다', async () => {
  const s = await new RedisStateSnapshots(redis).read(newEvent());
  expect(s).toEqual({
    seq: 0,
    serving: 0,
    removed: new Uint8Array(0),
    skipped: [],
    servingLog: [],
    calls: [],
    notice: { soldOutTiers: [], paused: false, suspended: false, stateDegraded: false },
    admit: { paused: false, untilMs: null },
  });
});
