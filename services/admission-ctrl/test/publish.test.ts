// 동시 도착 구간 묶음의 결과 게시(publishBatch, docs/features/queue-admission.md §3 '묶음의 첫 구현', ADR-0041·0050 결정 7, Q-T6)
import { createHash } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { combinedKey, merkleRoot, shuffle, sortHashes } from '@peaket/shuffle';
import { describe, expect, test } from 'vitest';
import { MemoryBatchStore, MemoryResultFiles } from '../src/modules/batch/adapters/memory-batch-store.js';
import { TestRandomness, TEST_RANDOMNESS_ENV } from '../src/modules/batch/adapters/test-randomness.js';
import { BatchMembersChanged, PublishBatchResults } from '../src/modules/batch/application/publish-batch-results.js';

const E = 'evt-batch-1';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const START = Date.parse('2026-11-10T11:00:00Z');
const SALE_END = START - 24 * 3600_000;

function world(o: { members?: string[]; closed?: { first: number; size: number; gen: number } | null; beacon?: boolean } = {}) {
  const clock = fakeClock({ now: Date.parse('2026-11-03T03:00:05Z') });
  const store = new MemoryBatchStore();
  const members = o.members ?? ['a', 'b', 'c', 'd', 'e'].map(hash);
  store.setForTest(E, { startsAtMs: START, members, closed: o.closed === undefined ? { first: 11, size: members.length, gen: 1 } : o.closed });
  const randomness = new TestRandomness(Buffer.alloc(32, 9));
  const beacons = o.beacon === false ? { value: async () => null } : randomness;
  const files = new MemoryResultFiles();
  const publish = new PublishBatchResults(store, randomness, beacons, files, clock);
  return { clock, store, randomness, files, publish, members };
}

describe('publishBatch', () => {
  test('Q-T6_닫힌묶음의참가자를_재현규격대로섞어_첫번호+순위를준다', async () => {
    const { store, randomness, publish, members } = world();
    const r = await publish.run({ eventId: E });
    expect(r).toMatchObject({ status: 'PUBLISHED', count: 5 });
    const sorted = sortHashes(members);
    const root = merkleRoot(sorted.map((h) => Buffer.from(h, 'hex')));
    const key = combinedKey(await randomness.seed(E, 1), (await randomness.value(E, 1))!, root, E);
    const order = shuffle(sorted, key);
    expect(r.status === 'PUBLISHED' && r.merkleRoot).toBe(root.toString('hex'));
    expect(order.map((h) => store.resultOf(h))).toEqual([11, 12, 13, 14, 15].map((s) => ({ value: `${s}:1`, expireAtMs: SALE_END })));
    expect(store.publishedForTest(E)).toBe(Date.parse('2026-11-03T03:00:05Z'));
  });

  test('결과파일은_토큰해시앞세자리로나눠_{해시:번호}로쓴다', async () => {
    const { store, files, publish, members } = world();
    await publish.run({ eventId: E });
    const all = Object.assign({}, ...[...files.written(E).values()]);
    expect(Object.keys(all).sort()).toEqual(sortHashes(members));
    for (const [prefix, body] of files.written(E)) for (const h of Object.keys(body)) expect(h.slice(0, 3)).toBe(prefix);
    for (const h of members) expect(all[h]).toBe(Number(store.resultOf(h)?.value.split(':')[0]));
  });

  test('같은입력이면같은결과라_두번게시해도같고_이미게시했으면ALREADY다', async () => {
    const a = world();
    const b = world();
    await a.publish.run({ eventId: E });
    await b.publish.run({ eventId: E });
    for (const h of a.members) expect(a.store.resultOf(h)).toEqual(b.store.resultOf(h));
    expect(await a.publish.run({ eventId: E })).toEqual({ status: 'ALREADY' });
  });

  test('묶음표시까지의쓰기가복제됐는지확인되지않으면_WAITING_REPLICA이고아무것도쓰지않는다_확인되면게시한다', async () => {
    const w = world();
    w.store.replicatedForTest(false);
    expect(await w.publish.run({ eventId: E })).toEqual({ status: 'WAITING_REPLICA' });
    expect(w.store.publishedForTest(E)).toBeNull();
    expect(w.members.map((h) => w.store.resultOf(h))).toEqual(w.members.map(() => null));
    expect(w.files.written(E).size).toBe(0);
    w.store.replicatedForTest(true);
    expect(await w.publish.run({ eventId: E })).toMatchObject({ status: 'PUBLISHED' });
  });

  test('닫히지않았으면NOT_CLOSED_비콘이아직없으면WAITING_BEACON이고_아무것도쓰지않는다', async () => {
    const open = world({ closed: null });
    expect(await open.publish.run({ eventId: E })).toEqual({ status: 'NOT_CLOSED' });
    const noBeacon = world({ beacon: false });
    expect(await noBeacon.publish.run({ eventId: E })).toEqual({ status: 'WAITING_BEACON' });
    for (const w of [open, noBeacon]) {
      expect(w.store.publishedForTest(E)).toBeNull();
      expect(w.members.map((h) => w.store.resultOf(h))).toEqual(w.members.map(() => null));
      expect(w.files.written(E).size).toBe(0);
    }
  });

  test('장애전환으로SADD를잃어참가자가닫힌크기보다적으면_남는자리를빠진번호로돌린다', async () => {
    const { store, publish } = world({ members: ['x', 'y'].map(hash), closed: { first: 21, size: 4, gen: 2 } });
    const r = await publish.run({ eventId: E });
    expect(r).toMatchObject({ status: 'PUBLISHED', count: 2 });
    expect(store.removedOf(E)).toEqual([23, 24]);
    expect(store.resultOf(hash('x'))?.value).toMatch(/^2[12]:2$/);
  });

  test('게시표시에_머클루트를함께쓴다', async () => {
    const { store, publish } = world();
    const r = await publish.run({ eventId: E });
    expect((await store.published(E))?.root).toBe(r.status === 'PUBLISHED' ? r.merkleRoot : 'x');
  });

  test('결과키를잃어다시쓰기표시가있으면_같은결과를다시쓰고표시를지우며_결과파일과게시시각은그대로다', async () => {
    const { clock, store, files, publish, members } = world();
    await publish.run({ eventId: E });
    const before = members.map((h) => store.resultOf(h));
    const at = store.publishedForTest(E);
    store.dropResultForTest(members[0]!);
    store.requestRepairForTest(E, 123);
    clock.advance(5_000);
    expect(await publish.run({ eventId: E })).toEqual({ status: 'REPAIRED', count: 5 });
    expect(members.map((h) => store.resultOf(h))).toEqual(before);
    expect(store.repairOf(E)).toBeNull();
    expect(store.publishedForTest(E)).toBe(at);
    expect(files.writesOf(E)).toBe(1);
    expect(await publish.run({ eventId: E })).toEqual({ status: 'ALREADY' });
  });

  test('게시뒤참가자가바뀌어머클루트가다르면_다시쓰지않고멈추며_표시는남긴다', async () => {
    const { store, publish, members } = world();
    await publish.run({ eventId: E });
    const before = store.resultOf(members[1]!);
    store.setMembersForTest(E, members.slice(1));
    store.dropResultForTest(members[1]!);
    store.requestRepairForTest(E, 123);
    await expect(publish.run({ eventId: E })).rejects.toBeInstanceOf(BatchMembersChanged);
    expect(store.resultOf(members[1]!)).toBeNull();
    expect(before).not.toBeNull();
    expect(store.repairOf(E)).toBe(123);
  });

  test('참가자목록에겹친값이와도_한사람으로센다', async () => {
    const m = ['a', 'b'].map(hash);
    const { store, publish } = world({ members: [...m, m[0]!], closed: { first: 1, size: 2, gen: 1 } });
    expect(await publish.run({ eventId: E })).toMatchObject({ status: 'PUBLISHED', count: 2 });
    expect(store.removedOf(E)).toEqual([]);
  });

  test('빈묶음도_게시표시를써서_묶음기록이없는사람을기다리게하지않는다', async () => {
    const { store, publish } = world({ members: [], closed: { first: 1, size: 0, gen: 1 } });
    expect(await publish.run({ eventId: E })).toMatchObject({ status: 'PUBLISHED', count: 0 });
    expect(store.publishedForTest(E)).not.toBeNull();
  });
});

describe('시험 시드·비콘', () => {
  test('local·ci·demo에서만켜고_운영쪽환경이나비밀없이는시작하지않는다', () => {
    expect(() => TestRandomness.fromEnv({ PEAKET_ENV: 'prod', [TEST_RANDOMNESS_ENV]: Buffer.alloc(32).toString('base64') })).toThrow(/local·ci·demo/);
    expect(() => TestRandomness.fromEnv({ PEAKET_ENV: 'ci' })).toThrow(TEST_RANDOMNESS_ENV);
    expect(TestRandomness.fromEnv({ PEAKET_ENV: 'ci', [TEST_RANDOMNESS_ENV]: Buffer.alloc(32, 1).toString('base64') })).toBeInstanceOf(TestRandomness);
  });

  test('묶음마다_시드와비콘이다르다', async () => {
    const r = new TestRandomness(Buffer.alloc(32, 9));
    expect((await r.seed(E, 1)).equals(await r.seed('other', 1))).toBe(false);
    expect((await r.seed(E, 1)).equals((await r.value(E, 1))!)).toBe(false);
  });
});
