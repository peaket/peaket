// 진입 3단계 Lua를 실제 Valkey 8.1로 돈다(test/entry-cases.ts의 사례를 메모리 저장소와 똑같이). 선점 수명은 300ms로 줄여 실제로 기다린다.
import { createHotRedis, type HotRedis, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { RedisEntryStore, keys } from '../src/modules/entry/adapters/redis-entry-store.js';
import { RedisEventSchedules } from '../src/modules/entry/adapters/redis-event-schedules.js';
import { type EventSchedule, QueueStoreUnavailable } from '../src/modules/entry/domain/queue.js';
import { batchCases } from '../test/batch-cases.js';
import { entryCases } from '../test/entry-cases.js';
import { newEvent, openSchedule } from '../test/support.js';
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
    failover: async (eventId) => void (await cmd(keys.epoch(eventId), ['HSET', keys.epoch(eventId), 'node', 'old-primary'])),
    skipped: async (eventId) => ((await cmd(keys.skipped(eventId), ['LRANGE', keys.skipped(eventId), '0', '-1'])) as unknown[]).map(String),
    lose: async (eventId, seq) => void (await cmd(keys.seq(eventId), ['SET', keys.seq(eventId), String(seq), 'KEEPTTL'])),
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
    failover: async (eventId) => void (await cmd(keys.epoch(eventId), ['HSET', keys.epoch(eventId), 'node', 'old-primary'])),
    skipped: async (eventId) => ((await cmd(keys.skipped(eventId), ['LRANGE', keys.skipped(eventId), '0', '-1'])) as unknown[]).map(String),
    lose: async (eventId, seq) => void (await cmd(keys.seq(eventId), ['SET', keys.seq(eventId), String(seq), 'KEEPTTL'])),
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

test('일정사본을읽으면_세대키가없을때지금노드ID를쓰고_오픈전에다르면그자리에서바꾸며건너뛰지않는다', async () => {
  const eventId = newEvent();
  const now = Date.now();
  await writeSchedule(eventId, openSchedule(now, { opensAtMs: now + 60_000 }));
  const ek = keys.epoch(eventId);
  expect(await new RedisEventSchedules(redis, systemClock).get(eventId)).not.toBeNull();
  expect(String(await cmd(ek, ['HGET', ek, 'node']))).toBe('standalone');
  // 오픈 전에 주 노드가 바뀌었다: 번호가 나간 적이 없으니 세대 키만 바꾼다
  await cmd(ek, ['HSET', ek, 'node', 'old-primary']);
  expect(await new RedisEventSchedules(redis, systemClock).get(eventId)).not.toBeNull();
  expect(String(await cmd(ek, ['HGET', ek, 'node']))).toBe('standalone');
  expect(Number(await cmd(keys.skipped(eventId), ['LLEN', keys.skipped(eventId)]))).toBe(0);
  expect(await cmd(keys.seq(eventId), ['GET', keys.seq(eventId)])).toBeNull();
  // 세대 키 수명은 순번 카운터와 같다(판매 종료 + 1일)
  const s = openSchedule(now, { opensAtMs: now + 60_000 });
  expect(Number(await cmd(ek, ['PEXPIRETIME', ek]))).toBe(s.startsAtMs - 24 * 3600_000 + 24 * 3600_000);
});

test('노드ID를읽다가클러스터꺼짐이아닌오류(권한)가나면_standalone으로넘기지않고실패한다', async () => {
  const eventId = newEvent();
  await writeSchedule(eventId, openSchedule(Date.now()));
  await cmd('x', ['ACL', 'SETUSER', 'nocluster', 'on', '>pw-test-only', '~*', '&*', '+@all', '-cluster']);
  const limited = await createHotRedis({ url: valkey.url.replace('redis://', 'redis://nocluster:pw-test-only@') });
  try {
    const e = await new RedisEventSchedules(limited, systemClock).get(eventId).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(QueueStoreUnavailable);
    expect(String((e as Error).message)).toContain('PEAKET_NODE_ID');
  } finally {
    await limited.close();
  }
});

test('일정사본을읽으면_리더가볼진행중인회차목록에회차키수명(공연시작)을점수로넣는다', async () => {
  const eventId = newEvent();
  const s = openSchedule(Date.now());
  await writeSchedule(eventId, s);
  expect(await new RedisEventSchedules(redis, systemClock).get(eventId)).not.toBeNull();
  expect(Number(await cmd('q:{admission}:events', ['ZSCORE', 'q:{admission}:events', eventId]))).toBe(s.startsAtMs);
});

test('오픈뒤에는일정사본읽기가다른노드ID를바꾸지않는다_진입②와RB05가맡는다', async () => {
  const eventId = newEvent();
  await writeSchedule(eventId, openSchedule(Date.now()));
  const ek = keys.epoch(eventId);
  await cmd(ek, ['HSET', ek, 'node', 'old-primary']);
  expect(await new RedisEventSchedules(redis, systemClock).get(eventId)).not.toBeNull();
  expect(String(await cmd(ek, ['HGET', ek, 'node']))).toBe('old-primary');
});

test('RB05는서버시각으로오픈전이고카운터가없으면_건너뛰지않고세대키만바꾸며_카운터가있으면오픈전이라도건너뛴다', async () => {
  const store = new RedisEntryStore(redis);
  const now = Date.now();
  const base = { expireAtMs: now + 86_400_000, skippedExpireAtMs: now + 86_400_000, skipBase: 10, opensAtMs: now + 60_000, lobbyShuffle: true, openBatch: false };
  const a = newEvent();
  await cmd(keys.epoch(a), ['HSET', keys.epoch(a), 'node', 'old-primary']);
  expect(await store.rb05({ eventId: a, ...base })).toEqual({ kind: 'DONE' });
  expect(String(await cmd(keys.epoch(a), ['HGET', keys.epoch(a), 'node']))).toBe('standalone');
  expect(await cmd(keys.seq(a), ['GET', keys.seq(a)])).toBeNull();
  // 오픈 시각이 오픈 뒤에 늦춰진 회차: 카운터가 있으니 번호가 나갔을 수 있다
  const b = newEvent();
  await cmd(keys.epoch(b), ['HSET', keys.epoch(b), 'node', 'old-primary']);
  await cmd(keys.seq(b), ['SET', keys.seq(b), '7']);
  expect(await store.rb05({ eventId: b, ...base })).toEqual({ kind: 'SKIPPED', start: 8, end: 17, gen: 2 });
  // 이미 건너뛰었으면(다른 파드가 먼저 했다) 다시 건너뛰지 않는다. 복제 확인 전이면 PENDING, 확인 뒤면 DONE(ADR-0186)
  expect(await store.rb05({ eventId: b, ...base })).toEqual({ kind: 'PENDING' });
  expect(await store.confirmRb05({ eventId: b })).toBe('CONFIRMED');
  expect(await store.rb05({ eventId: b, ...base })).toEqual({ kind: 'DONE' });
  expect(Number(await cmd(keys.seq(b), ['GET', keys.seq(b)]))).toBe(17);
});

test('[Q-T13] [ASVS v5.0.0-15.4.2] RB05가건너뛴뒤_복제확인전(pend)에는진입②가번호를내지않고_확인하면표시를지우고다시낸다(ADR-0186)', async () => {
  const store = new RedisEntryStore(redis);
  const now = Date.now();
  const e = newEvent();
  const input = { eventId: e, expireAtMs: now + 86_400_000, opensAtMs: now - 60_000, closeAtMs: now - 50_000, lobbyShuffle: false, openBatch: false };
  expect(await store.number(input)).toMatchObject({ kind: 'NUMBERED', seq: 1 });
  await cmd(keys.epoch(e), ['HSET', keys.epoch(e), 'node', 'old-primary']);
  expect(await store.number(input)).toEqual({ kind: 'RECOVERING' });
  const rb = { eventId: e, expireAtMs: now + 86_400_000, skippedExpireAtMs: now + 86_400_000, skipBase: 10, opensAtMs: now - 60_000, lobbyShuffle: false, openBatch: false };
  expect(await store.rb05(rb)).toEqual({ kind: 'SKIPPED', start: 2, end: 11, gen: 2 });
  expect(String(await cmd(keys.epoch(e), ['HGET', keys.epoch(e), 'pend']))).toBe('1');
  // 세대 키는 지금 노드 표지가 됐지만 확인 전이다
  expect(await store.number(input)).toEqual({ kind: 'RECOVERING' });
  // 붙은 복제본이 없는 단일 노드라 기다리지 않고 지운다
  expect(await store.confirmRb05({ eventId: e })).toBe('CONFIRMED');
  expect(await cmd(keys.epoch(e), ['HGET', keys.epoch(e), 'pend'])).toBeNull();
  expect(await cmd(keys.epoch(e), ['HGET', keys.epoch(e), 'wait'])).toBeNull();
  expect(await store.number(input)).toMatchObject({ kind: 'NUMBERED', seq: 12, gen: 2 });
  // 확인할 것이 없으면 아무것도 하지 않는다
  expect(await store.confirmRb05({ eventId: e })).toBe('NONE');
});

test('일정사본읽기는오픈시각이늦춰져오픈전이돼도_카운터가있으면다른노드표지를바꾸지않는다', async () => {
  const eventId = newEvent();
  await writeSchedule(eventId, openSchedule(Date.now(), { opensAtMs: Date.now() + 60_000 }));
  await cmd(keys.epoch(eventId), ['HSET', keys.epoch(eventId), 'node', 'old-primary']);
  await cmd(keys.seq(eventId), ['SET', keys.seq(eventId), '5']);
  expect(await new RedisEventSchedules(redis, systemClock).get(eventId)).not.toBeNull();
  expect(String(await cmd(keys.epoch(eventId), ['HGET', keys.epoch(eventId), 'node']))).toBe('old-primary');
});

test('RB05가적은건너뛴구간은판매종료까지_세대키는판매종료+1일까지둔다', async () => {
  const { EnterQueue } = await import('../src/modules/entry/application/enter-queue.js');
  const { ACCOUNT, DEVICE, PID, preverifyToken, tokens } = await import('../test/support.js');
  const eventId = newEvent();
  const s = openSchedule(Date.now());
  await writeSchedule(eventId, s);
  const enter = new EnterQueue(new RedisEntryStore(redis), new RedisEventSchedules(redis, systemClock), tokens, systemClock, { pendingTtlMs: PENDING_TTL_MS, rb05SkipBase: 10 });
  const go = () => enter.run({ accountId: ACCOUNT, pid: PID, eventId, body: { preverifyToken: preverifyToken(systemClock, eventId), deviceId: DEVICE } });
  await go();
  await cmd(keys.epoch(eventId), ['HSET', keys.epoch(eventId), 'node', 'old-primary']);
  await cmd(keys.dup(PID, eventId), ['DEL', keys.dup(PID, eventId)]);
  await expect(go()).rejects.toMatchObject({ code: 'QUEUE_RECOVERING' });
  const saleEnd = s.startsAtMs - 24 * 3600_000;
  expect(Number(await cmd(keys.skipped(eventId), ['PEXPIRETIME', keys.skipped(eventId)]))).toBe(saleEnd);
  expect(Number(await cmd(keys.epoch(eventId), ['PEXPIRETIME', keys.epoch(eventId)]))).toBe(saleEnd + 24 * 3600_000);
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
