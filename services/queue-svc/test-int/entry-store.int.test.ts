// 진입 3단계 Lua를 실제 Valkey 8.1로 돈다(test/entry-cases.ts의 사례를 메모리 저장소와 똑같이). 선점 수명은 300ms로 줄여 실제로 기다린다.
import { createHotRedis, type HotRedis, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { RedisEntryStore, keys } from '../src/modules/entry/adapters/redis-entry-store.js';
import { RedisEventSchedules } from '../src/modules/entry/adapters/redis-event-schedules.js';
import type { EventSchedule } from '../src/modules/entry/domain/queue.js';
import { batchCases } from '../test/batch-cases.js';
import { entryCases } from '../test/entry-cases.js';
import { newEvent } from '../test/support.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const PENDING_TTL_MS = 300;

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
  const window = s.batchWindowMs === undefined ? [] : ['batchWindowMs', String(s.batchWindowMs)];
  await cmd(key, ['HSET', key, 'opensAtMs', String(s.opensAtMs), 'startsAtMs', String(s.startsAtMs), 'lobbyShuffle', s.lobbyShuffle ? '1' : '0', 'openBatch', s.openBatch ? '1' : '0', 'rev', '1', ...window]);
}

const WINDOW_MS = 800;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

entryCases('Valkey Lua', async () => {
  const schedules = new RedisEventSchedules(redis, systemClock);
  return {
    store: new RedisEntryStore(redis),
    schedules: Object.assign(schedules, { set: writeSchedule }),
    clock: systemClock,
    pendingTtlMs: PENDING_TTL_MS,
    passPending: () => new Promise((r) => setTimeout(r, PENDING_TTL_MS + 100)),
    admit: async (pid, eventId, hash) => void (await cmd(keys.adm(pid, eventId), ['SET', keys.adm(pid, eventId), hash])),
    addSkipped: async (eventId, line) => void (await cmd(keys.skipped(eventId), ['RPUSH', keys.skipped(eventId), line])),
    removed: async (eventId, seq) => Number(await cmd(keys.removed(eventId), ['GETBIT', keys.removed(eventId), String(seq)])) === 1,
    verifying: async (eventId, hash) => {
      const v = await cmd(keys.verify(eventId), ['HGET', keys.verify(eventId), hash]);
      return v === null ? null : String(v);
    },
    counter: async (eventId) => Number((await cmd(keys.seq(eventId), ['GET', keys.seq(eventId)])) ?? 0),
  };
});

batchCases('Valkey Lua', async () => {
  const schedules = new RedisEventSchedules(redis, systemClock);
  return {
    store: new RedisEntryStore(redis),
    schedules: Object.assign(schedules, { set: writeSchedule }),
    clock: systemClock,
    pendingTtlMs: PENDING_TTL_MS,
    windowMs: WINDOW_MS,
    passPending: () => sleep(PENDING_TTL_MS + 100),
    passWindow: () => sleep(WINDOW_MS + 50),
    admit: async (pid, eventId, hash) => void (await cmd(keys.adm(pid, eventId), ['SET', keys.adm(pid, eventId), hash])),
    addSkipped: async (eventId, line) => void (await cmd(keys.skipped(eventId), ['RPUSH', keys.skipped(eventId), line])),
    removed: async (eventId, seq) => Number(await cmd(keys.removed(eventId), ['GETBIT', keys.removed(eventId), String(seq)])) === 1,
    verifying: async (eventId, hash) => {
      const v = await cmd(keys.verify(eventId), ['HGET', keys.verify(eventId), hash]);
      return v === null ? null : String(v);
    },
    counter: async (eventId) => Number((await cmd(keys.seq(eventId), ['GET', keys.seq(eventId)])) ?? 0),
    publishResult: async (eventId, hash, seq, gen) => {
      await cmd(keys.batchResult(hash), ['SET', keys.batchResult(hash), `${seq}:${gen}`]);
      await cmd(keys.batchDone(eventId), ['HSET', keys.batchDone(eventId), 'pub:1', String(Date.now())]);
    },
    publishNone: async (eventId) => void (await cmd(keys.batchDone(eventId), ['HSET', keys.batchDone(eventId), 'pub:1', String(Date.now())])),
    batchMembers: async (eventId) => ((await cmd(keys.batchMembers(eventId), ['SMEMBERS', keys.batchMembers(eventId)])) as string[]).map(String).sort(),
    marker: async (eventId, field) => {
      const v = await cmd(keys.batchDone(eventId), ['HGET', keys.batchDone(eventId), field]);
      return v === null ? null : String(v);
    },
    addLobby: async (eventId, n) => void (await cmd(keys.lobbyMembers(eventId), ['SADD', keys.lobbyMembers(eventId), ...Array.from({ length: n }, (_, k) => `lobby-${k}`)])),
    dupOf: async (pid, eventId) => {
      const k = keys.dup(pid, eventId);
      const value = await cmd(k, ['GET', k]);
      const at = Number(await cmd(k, ['PEXPIRETIME', k]));
      return { value: value === null ? null : String(value), expireAtMs: at > 0 ? at : null };
    },
    dropMember: async (eventId, hash) => void (await cmd(keys.batchMembers(eventId), ['SREM', keys.batchMembers(eventId), hash])),
  };
});

test('키수명_사람키는판매종료에_회차키는판매종료+1일에맞춘다', async () => {
  const { EnterQueue } = await import('../src/modules/entry/application/enter-queue.js');
  const { ACCOUNT, DEVICE, PID, openSchedule, preverifyToken, tokens } = await import('../test/support.js');
  const eventId = newEvent();
  const s = openSchedule(Date.now(), { openBatch: false });
  await writeSchedule(eventId, s);
  const enter = new EnterQueue(new RedisEntryStore(redis), new RedisEventSchedules(redis, systemClock), tokens, systemClock, { pendingTtlMs: PENDING_TTL_MS });
  await enter.run({ accountId: ACCOUNT, pid: PID, eventId, body: { preverifyToken: preverifyToken(systemClock, eventId), deviceId: DEVICE } });
  const saleEnd = s.startsAtMs - 24 * 3600_000;
  const dupAt = Number(await cmd(keys.dup(PID, eventId), ['PEXPIRETIME', keys.dup(PID, eventId)]));
  const seqAt = Number(await cmd(keys.seq(eventId), ['PEXPIRETIME', keys.seq(eventId)]));
  expect(dupAt).toBe(saleEnd);
  expect(seqAt).toBe(saleEnd + 24 * 3600_000);
});

test('묶음참가자목록(토큰해시)은_판매종료까지만둔다', async () => {
  const { EnterQueue } = await import('../src/modules/entry/application/enter-queue.js');
  const { ACCOUNT, DEVICE, PID, openSchedule, preverifyToken, tokens } = await import('../test/support.js');
  const eventId = newEvent();
  const now = Date.now();
  const s = openSchedule(now, { opensAtMs: now - 150, lobbyShuffle: false, openBatch: true, batchWindowMs: 5_000 });
  await writeSchedule(eventId, s);
  const enter = new EnterQueue(new RedisEntryStore(redis), new RedisEventSchedules(redis, systemClock), tokens, systemClock, { pendingTtlMs: PENDING_TTL_MS });
  const r = await enter.run({ accountId: ACCOUNT, pid: PID, eventId, body: { preverifyToken: preverifyToken(systemClock, eventId, { i0: s.opensAtMs - 60_000 }), deviceId: DEVICE } });
  expect(r.kind).toBe('BATCHING');
  const k = keys.batchMembers(eventId);
  expect(Number(await cmd(k, ['PEXPIRETIME', k]))).toBe(s.startsAtMs - 24 * 3600_000);
});

test('회차일정이늦춰지면_회차키(카운터·빠진번호·추가검증기록)수명을다음호출에서늦추고_당기지는않으며_INCRBY로먼저생긴수명없는카운터에도건다', async () => {
  const store = new RedisEntryStore(redis);
  const eventId = newEvent();
  const t1 = Date.now() + 3600_000;
  const t2 = t1 + 2 * 86_400_000;
  const at = async (key: string) => Number(await cmd(key, ['PEXPIRETIME', key]));
  await store.number({ eventId, expireAtMs: t1 });
  await store.number({ eventId, expireAtMs: t2 });
  expect(await at(keys.seq(eventId))).toBe(t2);
  await store.number({ eventId, expireAtMs: t1 });
  expect(await at(keys.seq(eventId))).toBe(t2);

  await store.markRemoved({ eventId, seq: 1, expireAtMs: t1 });
  await store.markRemoved({ eventId, seq: 2, expireAtMs: t2 });
  expect(await at(keys.removed(eventId))).toBe(t2);

  await store.markVerifying({ eventId, seq: 3, ticketHash: 'a'.repeat(64), atMs: 1, reason: 'NETWORK', expireAtMs: t1, verifyExpireAtMs: t1 });
  await store.markVerifying({ eventId, seq: 4, ticketHash: 'b'.repeat(64), atMs: 1, reason: 'NETWORK', expireAtMs: t2, verifyExpireAtMs: t2 - 86_400_000 });
  expect(await at(keys.verify(eventId))).toBe(t2 - 86_400_000);

  const other = newEvent();
  await cmd(keys.seq(other), ['INCRBY', keys.seq(other), '1000']);
  expect(await at(keys.seq(other))).toBe(-1);
  expect(await store.number({ eventId: other, expireAtMs: t1 })).toMatchObject({ kind: 'NUMBERED', seq: 1001 });
  expect(await at(keys.seq(other))).toBe(t1);
});
