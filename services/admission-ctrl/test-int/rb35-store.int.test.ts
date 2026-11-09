// RB-35 적용 Lua를 실제 Valkey 8.1로 돈다(ADR-0239 결정 7~12, docs/data.md §3 q:{event:E}:shuffle, §5 경합).
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHotRedis, fakeClock, type HotRedis } from '@peaket/platform';
import { drandRoundAfter, drandRoundTimeMs, EMERGENCY_BEACON, combinedKey, merkleRoot, shuffle, sortHashes } from '@peaket/shuffle';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { RedisBatchStore, RedisShuffleRecords, keys } from '../src/modules/batch/adapters/redis-batch-store.js';
import { LocalResultFiles } from '../src/modules/batch/adapters/local-result-files.js';
import { BEACON_WAIT_LIMIT_MS, PublishBatchResults } from '../src/modules/batch/application/publish-batch-results.js';
import { ApplyRb35, RedisRb35Store, SignedMarkAuth } from '../src/modules/rb35/index.js';
import { bundleOf, keysOf, NOW, operator, signedBy } from '../test/rb35-support.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer;
let redis: HotRedis;
let store: RedisRb35Store;

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
  store = new RedisRb35Store(redis, new RedisBatchStore(redis));
});

afterAll(async () => {
  await redis?.close();
  valkey?.stop();
});

const a = operator('commander-a');
const b = operator('commander-b');
const COMMIT = 'a'.repeat(64);
const STOP = `${NOW - 1_000}:beacon`;
let seq = 0;
const EXPIRE = Date.now() + 7 * 86_400_000;

const cmd = (key: string, args: string[]) => redis.command(args, { key });

/** 공시 기록이 있는 새 회차 */
async function event(o: { stop?: string | null; published?: boolean; round?: number; opensAtMs?: number } = {}) {
  seq += 1;
  const e = `evt-rb35-${seq}`;
  const k = keys.shuffle(e);
  await cmd(k, ['HSET', k, 'commit:lobby', COMMIT, 'round:lobby', String(o.round ?? 8_000_000), 'sealed:lobby', 'x', 'at:lobby', String(NOW - 60_000)]);
  if (o.stop !== null) await cmd(k, ['HSET', k, 'stop:lobby', o.stop ?? STOP]);
  if (o.published) await cmd(keys.batchDone(e), ['HSET', keys.batchDone(e), 'pub:lobby', '1']);
  await cmd(keys.cfg(e), ['HSET', keys.cfg(e), 'startsAtMs', String(EXPIRE), 'opensAtMs', String(o.opensAtMs ?? NOW - 60_000)]);
  return e;
}

const applier = (clock: ReturnType<typeof fakeClock>) => new ApplyRb35(store, keysOf(a, b), clock);
const hget = async (k: string, f: string) => {
  const v = await cmd(k, ['HGET', k, f]);
  return v === null ? null : Buffer.isBuffer(v) ? v.toString() : String(v);
};
const params = { commit: COMMIT, round: 8_000_000, stop: STOP };
const signed = (e: string, o: Parameters<typeof bundleOf>[0]) => JSON.stringify(signedBy(bundleOf({ ...o, target: { eventId: e, group: 'lobby' } }), a, b));

test('Q-T27 비상 셔플 묶음을 적용하면 멈춤이 풀리고 emergency가 저장소 시각으로 남는다', async () => {
  const e = await event();
  const before = Date.now();
  const clock = fakeClock({ now: NOW + 1_000 });
  expect(await applier(clock).run(e, 'lobby', signed(e, { params: { ...params, reason: '중계 무응답 "따옴표"' } }))).toMatchObject({ status: 'applied' });
  const k = keys.shuffle(e);
  expect(await hget(k, 'stop:lobby')).toBeNull();
  const v = JSON.parse((await hget(k, 'emergency:lobby'))!) as { at: number; stop: string; reason: string };
  expect(v).toMatchObject({ stop: 'beacon', reason: '중계 무응답 "따옴표"' });
  expect(v.at).toBeGreaterThanOrEqual(before);
  // 공시 기록 읽기가 같은 칸을 읽는다
  expect(await new RedisShuffleRecords(redis).read(e, 'lobby')).toMatchObject({ emergency: { stopReason: 'beacon' } });
});

test('Q-T27 같은 묶음을 다시 적용해도 한 번이고, 결과는 처음 값이다', async () => {
  const e = await event();
  const clock = fakeClock({ now: NOW + 1_000 });
  const s = signed(e, { params });
  expect(await applier(clock).run(e, 'lobby', s)).toMatchObject({ status: 'applied' });
  const k = keys.shuffle(e);
  await cmd(k, ['HSET', k, 'stop:lobby', STOP]);
  expect(await applier(clock).run(e, 'lobby', s)).toMatchObject({ status: 'rejected', reason: 'replay' });
  expect(await hget(k, 'stop:lobby')).toBe(STOP);
  const id = (JSON.parse(s) as { bundle: { commandId: string } }).bundle.commandId;
  expect(await hget(k, `rb35:result:${id}`)).toBe('applied');
});

test('Q-T27 멈춤 값이 묶음과 다르면(서명 뒤 상태가 바뀜) 적용하지 않는다', async () => {
  const e = await event({ stop: `${NOW + 5}:beacon` });
  const clock = fakeClock({ now: NOW + 1_000 });
  expect(await applier(clock).run(e, 'lobby', signed(e, { params }))).toMatchObject({ status: 'rejected', reason: 'stale_state' });
  const k = keys.shuffle(e);
  expect(await hget(k, 'emergency:lobby')).toBeNull();
  expect(await hget(k, 'stop:lobby')).toBe(`${NOW + 5}:beacon`);
});

test('Q-T27 커밋이 바뀌면 적용하지 않는다', async () => {
  const e = await event();
  const clock = fakeClock({ now: NOW + 1_000 });
  expect(await applier(clock).run(e, 'lobby', signed(e, { params: { ...params, commit: 'b'.repeat(64) } }))).toMatchObject({ status: 'rejected', reason: 'stale_state' });
});

test('Q-T27 게시한 구간은 적용하지 않는다', async () => {
  const e = await event({ published: true });
  const clock = fakeClock({ now: NOW + 1_000 });
  expect(await applier(clock).run(e, 'lobby', signed(e, { params }))).toMatchObject({ status: 'rejected', reason: 'published' });
});

test('Q-T27 더 기다리기는 저장소 시각 + extendSec를 쓰고 멈춤을 푼다', async () => {
  const e = await event();
  const clock = fakeClock({ now: NOW + 1_000 });
  const before = Date.now();
  expect(await applier(clock).run(e, 'lobby', signed(e, { command: 'rb35.wait', params: { ...params, extendSec: 120 } }))).toMatchObject({ status: 'applied' });
  const k = keys.shuffle(e);
  expect(await hget(k, 'stop:lobby')).toBeNull();
  expect(Number(await hget(k, 'waitUntil:lobby'))).toBeGreaterThanOrEqual(before + 120_000);
  expect(await new RedisShuffleRecords(redis).read(e, 'lobby')).toMatchObject({ waitUntilMs: expect.any(Number) });
});

/** 시계가 now일 때의 ADR 공식(묶음 만료 = now + 5분) */
const formula = (opensAtMs: number, nowMs: number) => Math.max(drandRoundAfter(opensAtMs), drandRoundAfter(nowMs + 300_000, 30_000));

test('Q-T27 커밋 다시 공시는 라운드와 이력을 바꾸고 커밋은 그대로 둔다', async () => {
  const stop = `${NOW - 1_000}:stale_round`;
  const e = await event({ stop });
  const k = keys.shuffle(e);
  await cmd(k, ['HSET', k, 'waitUntil:lobby', '1']);
  const clock = fakeClock({ now: Date.now() });
  const newRound = formula(NOW - 60_000, clock.now());
  const bundle = { command: 'rb35.recommit' as const, issuedAt: clock.now(), expiresAt: clock.now() + 300_000, params: { ...params, stop, newRound, reason: '오픈 변경' } };
  expect(await applier(clock).run(e, 'lobby', signed(e, bundle))).toMatchObject({ status: 'applied' });
  expect(await hget(k, 'round:lobby')).toBe(String(newRound));
  expect(await hget(k, 'commit:lobby')).toBe(COMMIT);
  expect(await hget(k, 'stop:lobby')).toBeNull();
  expect(await hget(k, 'waitUntil:lobby')).toBeNull();
  const hist = JSON.parse((await hget(k, 'recommit:lobby'))!) as { at: number; prev: number; round: number; reason: string; signed: { bundle: { commandId: string } } }[];
  expect(hist).toHaveLength(1);
  expect(hist[0]).toMatchObject({ prev: 8_000_000, round: newRound, reason: '오픈 변경', signed: { bundle: { command: 'rb35.recommit' } } });
  // 일정이 뒤로 밀린 뒤의 두 번째 다시 공시는 이력에 붙는다
  const opensAt2 = drandRoundTimeMs(newRound) + 60_000;
  await cmd(keys.cfg(e), ['HSET', keys.cfg(e), 'opensAtMs', String(opensAt2)]);
  const round2 = formula(opensAt2, clock.now());
  const b2 = { command: 'rb35.recommit' as const, commandId: '01957f5a-0000-7000-8000-000000000099', issuedAt: clock.now(), expiresAt: clock.now() + 300_000, params: { ...params, stop: null, round: newRound, newRound: round2, reason: '다시 변경' } };
  expect(await applier(clock).run(e, 'lobby', signed(e, b2))).toMatchObject({ status: 'applied' });
  expect(JSON.parse((await hget(k, 'recommit:lobby'))!) as unknown[]).toHaveLength(2);
  expect(await new RedisShuffleRecords(redis).read(e, 'lobby')).toMatchObject({ round: round2, recommits: [{ round: newRound }, { round: round2 }] });
});

test('Q-T27 다시 공시 라운드가 저장소 시각으로 30초 안이면 Lua가 거절한다', async () => {
  const stop = `${NOW - 1_000}:stale_round`;
  const e = await event({ stop });
  // 이 시험의 시계(묶음 검증용)는 과거다. Lua는 저장소 시각으로 본다
  const clock = fakeClock({ now: Date.now() - 600_000 });
  const newRound = formula(NOW - 60_000, clock.now());
  const bundle = { command: 'rb35.recommit' as const, issuedAt: clock.now(), expiresAt: clock.now() + 300_000, params: { ...params, stop, newRound, reason: '오픈 변경' } };
  expect(await applier(clock).run(e, 'lobby', signed(e, bundle))).toMatchObject({ status: 'rejected', reason: 'too_late' });
  expect(await hget(keys.shuffle(e), 'stop:lobby')).toBe(stop);
});

test('Q-T27 H2 멈추기 전에 이미 공개된 라운드는 Lua가 저장소 시각으로 거절한다', async () => {
  const opensAtMs = Date.now() + 3_600_000;
  const R1 = drandRoundAfter(Date.now(), -6_000);
  const e = await event({ stop: null, round: R1, opensAtMs });
  const clock = fakeClock({ now: Date.now() });
  const b = { command: 'rb35.recommit' as const, issuedAt: clock.now(), expiresAt: clock.now() + 300_000, params: { commit: COMMIT, round: R1, stop: null, newRound: formula(opensAtMs, clock.now()), reason: 'x' } };
  expect(await applier(clock).run(e, 'lobby', signed(e, b))).toMatchObject({ status: 'rejected', reason: 'round_public' });
  expect(await hget(keys.shuffle(e), 'round:lobby')).toBe(String(R1));
});

test('Q-T27 H2 일정 변경 없는 두 번째 다시 공시를 Lua가 거절한다', async () => {
  const opensAtMs = NOW - 60_000;
  const R1 = drandRoundAfter(Date.now(), 600_000);
  const e = await event({ stop: null, round: R1, opensAtMs });
  const k = keys.shuffle(e);
  await cmd(k, ['HSET', k, 'recommit:lobby', '[{"at":1,"prev":2,"round":3,"reason":"x"}]']);
  const clock = fakeClock({ now: Date.now() });
  const b = { command: 'rb35.recommit' as const, issuedAt: clock.now(), expiresAt: clock.now() + 300_000, params: { commit: COMMIT, round: R1, stop: null, newRound: formula(opensAtMs, clock.now()), reason: 'x' } };
  expect(await applier(clock).run(e, 'lobby', signed(e, b))).toMatchObject({ status: 'rejected', reason: 'already_recommitted' });
});

test('Q-T27 M2 새 라운드가 커밋 + 3초보다 앞서면 Lua가 거절한다', async () => {
  const stop = `${NOW}:late_commit`;
  const e = await event({ stop });
  const clock = fakeClock({ now: Date.now() });
  const newRound = formula(NOW - 60_000, clock.now());
  const k = keys.shuffle(e);
  await cmd(k, ['HSET', k, 'at:lobby', String(drandRoundTimeMs(newRound) - 1_000)]);
  const b = { command: 'rb35.recommit' as const, issuedAt: clock.now(), expiresAt: clock.now() + 300_000, params: { ...params, stop, newRound, reason: 'x' } };
  expect(await applier(clock).run(e, 'lobby', signed(e, b))).toMatchObject({ status: 'rejected', reason: 'too_late' });
});

test('Q-T27 M1 실제 비콘을 기록한 구간은 Lua가 거절하고, 비상 표시가 있으면 다시 공시를 거절한다', async () => {
  const e = await event();
  const k = keys.shuffle(e);
  await cmd(k, ['HSET', k, 'beacon:lobby', 'aa', 'sig:lobby', 'bb']);
  const clock = fakeClock({ now: NOW + 1_000 });
  expect(await applier(clock).run(e, 'lobby', signed(e, { params }))).toMatchObject({ status: 'rejected', reason: 'beacon_recorded' });
  const stop = `${NOW - 1_000}:stale_round`;
  const e2 = await event({ stop });
  const k2 = keys.shuffle(e2);
  await cmd(k2, ['HSET', k2, 'emergency:lobby', '{"at":1,"stop":"beacon","reason":"x"}']);
  const c2 = fakeClock({ now: Date.now() });
  const b = { command: 'rb35.recommit' as const, commandId: '01957f5a-0000-7000-8000-0000000000aa', issuedAt: c2.now(), expiresAt: c2.now() + 300_000, params: { ...params, stop, newRound: formula(NOW - 60_000, c2.now()), reason: 'x' } };
  expect(await applier(c2).run(e2, 'lobby', signed(e2, b))).toMatchObject({ status: 'rejected', reason: 'already_emergency' });
});

test('Q-T27 M1 비콘 기록은 라운드가 같고 비상 표시가 없을 때만 쓴다', async () => {
  const e = await event({ stop: null });
  const r = new RedisShuffleRecords(redis);
  expect(await r.recordBeacon(e, 'lobby', 'aa', 'bb', EXPIRE, 7)).toBe(false);
  expect(await hget(keys.shuffle(e), 'beacon:lobby')).toBeNull();
  expect(await r.recordBeacon(e, 'lobby', 'aa', 'bb', EXPIRE, 8_000_000)).toBe(true);
  expect(await hget(keys.shuffle(e), 'beacon:lobby')).toBe('aa');
  // 이미 있으면 그대로 두고 true(같은 라운드의 다시 부르기)
  expect(await r.recordBeacon(e, 'lobby', 'cc', 'dd', EXPIRE, 8_000_000)).toBe(true);
  expect(await hget(keys.shuffle(e), 'beacon:lobby')).toBe('aa');
  const e2 = await event({ stop: null });
  const k2 = keys.shuffle(e2);
  await cmd(k2, ['HSET', k2, 'emergency:lobby', '{}']);
  expect(await r.recordBeacon(e2, 'lobby', 'aa', 'bb', EXPIRE, 8_000_000)).toBe(false);
});

test('Q-T27 H1 Redis에 서명 없이 쓴 비상 표시로는 게시하지 않고 멈춘다', async () => {
  const hash = (x: string) => createHash('sha256').update(x).digest('hex');
  for (const forged of ['{"at":1,"stop":"beacon","reason":"x"}', 'not json', '{"at":1,"stop":"beacon","reason":"x","signed":{"bundle":{},"signatures":[]}}']) {
    const e = await event({ stop: null });
    const k = keys.shuffle(e);
    await cmd(k, ['HSET', k, 'emergency:lobby', forged]);
    const members = ['a', 'b'].map(hash);
    await cmd(keys.lobbyMembers(e), ['SADD', keys.lobbyMembers(e), ...members]);
    await cmd(keys.batchDone(e), ['HSET', keys.batchDone(e), 'lobby', `1:${members.length}:1`]);
    const clock = fakeClock({ now: NOW + 1_000 });
    const publish = new PublishBatchResults(new RedisBatchStore(redis), new RedisShuffleRecords(redis), { seed: async () => Buffer.alloc(32, 5) }, { round: async () => null, verifyStored: () => true }, new LocalResultFiles(mkdtempSync(join(tmpdir(), 'peaket-rb35-'))), clock, new SignedMarkAuth(keysOf(a, b)));
    expect(await publish.run({ eventId: e, group: 'lobby' })).toMatchObject({ status: 'BEACON_STOPPED', reason: 'unauthorized' });
    expect(String(await hget(k, 'stop:lobby'))).toMatch(/:unauthorized$/);
    expect(await cmd(keys.lobbyResult(members[0]!), ['GET', keys.lobbyResult(members[0]!)])).toBeNull();
  }
});

test('Q-T27 H1 Lua가 쓴 표시를 게시가 서명까지 읽어 받아들인다', async () => {
  const e = await event();
  const clock = fakeClock({ now: NOW + 1_000 });
  expect(await applier(clock).run(e, 'lobby', signed(e, { params }))).toMatchObject({ status: 'applied' });
  const rec = await new RedisShuffleRecords(redis).read(e, 'lobby');
  expect(new SignedMarkAuth(keysOf(a, b)).authorized(e, 'lobby', rec!)).toBe(true);
  // 다른 키 묶음이면 믿지 않는다
  expect(new SignedMarkAuth(keysOf(operator('commander-a'), operator('commander-b'))).authorized(e, 'lobby', rec!)).toBe(false);
});

test('Q-T27 Lua가 쓴 칸을 queue-svc 공시가 그대로 읽는다(칸 이름이 어긋나면 잡힌다)', async () => {
  const { groupProof, EMERGENCY_LIMITATION } = (await import(new URL('../../queue-svc/src/modules/state/domain/proof.ts', import.meta.url).href)) as { groupProof: (e: string, g: 'lobby' | number, f: { shuffle: Record<string, string>; done: Record<string, string> }, fixed: number, reveal: number, now: number) => { emergency?: unknown; redisclosures?: unknown; invalidDisclosures?: unknown }; EMERGENCY_LIMITATION: string };
  const fields = async (k: string) => {
    const raw = (await cmd(k, ['HGETALL', k])) as unknown;
    const pairs = Array.isArray(raw) ? Array.from({ length: raw.length / 2 }, (_, i) => [raw[2 * i], raw[2 * i + 1]]) : raw instanceof Map ? [...raw.entries()] : Object.entries(raw as object);
    return Object.fromEntries(pairs.map(([k2, v]) => [String(k2), String(v)]));
  };
  const e = await event();
  const clock = fakeClock({ now: NOW + 1_000 });
  expect(await applier(clock).run(e, 'lobby', signed(e, { params: { ...params, reason: '중계 무응답' } }))).toMatchObject({ status: 'applied' });
  const p = groupProof(e, 'lobby', { shuffle: await fields(keys.shuffle(e)), done: {} }, NOW, NOW, NOW);
  expect(p.emergency).toMatchObject({ reason: '중계 무응답', stopReason: 'beacon', limitation: EMERGENCY_LIMITATION });
  expect(p.invalidDisclosures).toBeUndefined();
  expect(JSON.stringify(p)).not.toContain('commander');

  const stop = `${NOW - 1_000}:stale_round`;
  const e2 = await event({ stop });
  const c2 = fakeClock({ now: Date.now() });
  const newRound = formula(NOW - 60_000, c2.now());
  const b = { command: 'rb35.recommit' as const, issuedAt: c2.now(), expiresAt: c2.now() + 300_000, params: { ...params, stop, newRound, reason: '오픈 변경' } };
  expect(await applier(c2).run(e2, 'lobby', signed(e2, b))).toMatchObject({ status: 'applied' });
  const p2 = groupProof(e2, 'lobby', { shuffle: await fields(keys.shuffle(e2)), done: {} }, NOW, NOW, NOW);
  expect(p2.redisclosures).toMatchObject([{ previousRound: 8_000_000, round: newRound, reason: '오픈 변경' }]);
  expect(p2.invalidDisclosures).toBeUndefined();
});

test('Q-T27 비콘을 기록한 뒤 KMS 무응답으로 멈춘 구간을 더 기다리기로 풀고, 복구 뒤 같은 라운드 값으로 게시한다', async () => {
  const hash = (x: string) => createHash('sha256').update(x).digest('hex');
  const members = ['a', 'b', 'c'].map(hash);
  const opensAtMs = Date.now() + 120_000;
  const round = drandRoundAfter(opensAtMs);
  const e = await event({ stop: null, round, opensAtMs });
  const k = keys.shuffle(e);
  await cmd(keys.lobbyMembers(e), ['SADD', keys.lobbyMembers(e), ...members]);
  await cmd(keys.batchDone(e), ['HSET', keys.batchDone(e), 'lobby', `101:${members.length}:1`]);
  const clock = fakeClock({ now: drandRoundTimeMs(round) + 500 });
  const seed = Buffer.alloc(32, 7);
  const value = Buffer.alloc(32, 9);
  const signature = 'aa'.repeat(48);
  let relayUp = true;
  let kmsUp = true;
  const store2 = new RedisBatchStore(redis);
  const writeResults = store2.writeResults.bind(store2);
  let failWrite = true;
  store2.writeResults = async (...args: Parameters<typeof writeResults>) => {
    if (failWrite) throw new Error('쓰기 실패');
    return writeResults(...args);
  };
  const beacons = { round: async () => (relayUp ? { value, signature } : null), verifyStored: (_e: string, _g: unknown, r: number, v: string, s: string) => r === round && v === value.toString('hex') && s === signature };
  const seeds = {
    seed: async () => {
      if (!kmsUp) throw new Error('KMS 무응답');
      return seed;
    },
  };
  const publish = new PublishBatchResults(store2, new RedisShuffleRecords(redis), seeds, beacons, new LocalResultFiles(mkdtempSync(join(tmpdir(), 'peaket-rb35-'))), clock, new SignedMarkAuth(keysOf(a, b)));
  // 1. 비콘을 기록한 뒤 결과 쓰기가 실패한다
  await expect(publish.run({ eventId: e, group: 'lobby' })).rejects.toThrow('쓰기 실패');
  expect(await hget(k, 'beacon:lobby')).toBe(value.toString('hex'));
  // 2. 중계와 KMS가 멎고 상한이 지나 멈춘다(리더가 바뀐 것과 같다)
  failWrite = false;
  relayUp = false;
  kmsUp = false;
  publish.forget();
  clock.advance(BEACON_WAIT_LIMIT_MS);
  expect(await publish.run({ eventId: e, group: 'lobby' })).toMatchObject({ status: 'BEACON_STOPPED', reason: 'seed_unavailable', first: true });
  const stop = (await hget(k, 'stop:lobby'))!;
  expect(stop).toMatch(/:seed_unavailable$/);
  // 3. 더 기다리기는 비콘 기록이 있어도 적용된다
  const c2 = fakeClock({ now: clock.now() });
  const wait = { command: 'rb35.wait' as const, issuedAt: c2.now(), expiresAt: c2.now() + 300_000, params: { commit: COMMIT, round, stop, extendSec: 120, reason: 'KMS 복구 대기' } };
  expect(await applier(c2).run(e, 'lobby', signed(e, wait))).toMatchObject({ status: 'applied' });
  expect(await hget(k, 'stop:lobby')).toBeNull();
  // 4. 복구하면(중계는 여전히 멎었다) 기록한 비콘으로 게시하고, 결과는 그 비콘의 값이다
  kmsUp = true;
  expect(await publish.run({ eventId: e, group: 'lobby' })).toMatchObject({ status: 'PUBLISHED', count: 3 });
  const sorted = sortHashes(members);
  const root = merkleRoot(sorted.map((h) => Buffer.from(h, 'hex')));
  const order = shuffle(sorted, combinedKey(seed, value, root, e));
  for (let i = 0; i < order.length; i++) {
    const rk = keys.lobbyResult(order[i]!);
    expect(String(await cmd(rk, ['GET', rk]))).toBe(`${101 + i}:1`);
  }
  // 비콘 기록 뒤의 비상 셔플과 다시 공시는 거절한다(이 회차는 게시됐으므로 새 회차로 본다)
  const e2 = await event({ stop: STOP, round: 8_000_000 });
  const k2 = keys.shuffle(e2);
  await cmd(k2, ['HSET', k2, 'beacon:lobby', 'aa', 'sig:lobby', 'bb']);
  const c3 = fakeClock({ now: NOW + 1_000 });
  expect(await applier(c3).run(e2, 'lobby', signed(e2, { commandId: '01957f5a-0000-7000-8000-0000000000b1', params }))).toMatchObject({ status: 'rejected', reason: 'beacon_recorded' });
  const stale = `${NOW - 1_000}:stale_round`;
  const e3 = await event({ stop: stale, round: 8_000_000 });
  const k3 = keys.shuffle(e3);
  await cmd(k3, ['HSET', k3, 'beacon:lobby', 'aa', 'sig:lobby', 'bb']);
  const c4 = fakeClock({ now: Date.now() });
  const rc = { command: 'rb35.recommit' as const, commandId: '01957f5a-0000-7000-8000-0000000000b2', issuedAt: c4.now(), expiresAt: c4.now() + 300_000, params: { ...params, stop: stale, newRound: formula(NOW - 60_000, c4.now()), reason: 'x' } };
  expect(await applier(c4).run(e3, 'lobby', signed(e3, rc))).toMatchObject({ status: 'rejected', reason: 'beacon_recorded' });
});

test('Q-T27 전달 칸: 넣기·읽기와, 같은 구간의 다른 명령은 받지 않는다', async () => {
  const e = await event();
  const one = signed(e, { params });
  const id1 = (JSON.parse(one) as { bundle: { commandId: string } }).bundle.commandId;
  expect(await store.deposit(e, 'lobby', id1, one)).toBe(true);
  expect(await store.pending(e)).toEqual([{ group: 'lobby', raw: one }]);
  const id2 = '01957f5a-0000-7000-8000-000000000002';
  const two = JSON.stringify({ x: id2 });
  expect(await store.deposit(e, 'lobby', id2, two)).toBe(false);
  // 같은 명령은 다시 넣을 수 있다
  expect(await store.deposit(e, 'lobby', id1, one)).toBe(true);
  // 거절하면 칸을 비우고 결과를 남긴다
  await store.reject(e, 'lobby', id1, one, 'expired');
  expect(await store.pending(e)).toEqual([]);
  expect(await store.result(e, id1)).toBe('rejected:expired');
});

test('Q-T27 비상 셔플을 적용한 뒤 게시가 고정값 비콘으로 결과를 만든다', async () => {
  const e = await event();
  const hash = (x: string) => createHash('sha256').update(x).digest('hex');
  const members = ['a', 'b', 'c'].map(hash);
  const k = keys.lobbyMembers(e);
  await cmd(k, ['SADD', k, ...members]);
  await cmd(keys.batchDone(e), ['HSET', keys.batchDone(e), 'lobby', `101:${members.length}:1`]);
  const clock = fakeClock({ now: NOW + 1_000 });
  expect(await applier(clock).run(e, 'lobby', signed(e, { params }))).toMatchObject({ status: 'applied' });
  const seed = Buffer.alloc(32, 5);
  const files = new LocalResultFiles(mkdtempSync(join(tmpdir(), 'peaket-rb35-')));
  const publish = new PublishBatchResults(new RedisBatchStore(redis), new RedisShuffleRecords(redis), { seed: async () => seed }, { round: async () => null, verifyStored: () => true }, files, clock, new SignedMarkAuth(keysOf(a, b)));
  expect(await publish.run({ eventId: e, group: 'lobby' })).toMatchObject({ status: 'PUBLISHED', count: 3 });
  const sorted = sortHashes(members);
  const root = merkleRoot(sorted.map((h) => Buffer.from(h, 'hex')));
  const order = shuffle(sorted, combinedKey(seed, EMERGENCY_BEACON, root, e));
  for (let i = 0; i < order.length; i++) {
    const rk = keys.lobbyResult(order[i]!);
    expect(String(await cmd(rk, ['GET', rk]))).toBe(`${101 + i}:1`);
  }
  // 비콘 칸은 비어 있다
  expect(await hget(keys.shuffle(e), 'beacon:lobby')).toBeNull();
});
