// 동시 도착 구간 묶음의 결과 게시(publishBatch, docs/features/queue-admission.md §3 '묶음의 첫 구현', ADR-0041·0050 결정 7, Q-T6)
import { createHash } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { combinedKey, commitment, drandRoundAfter, drandRoundTimeMs, merkleRoot, shuffle, sortHashes, TestSeedSealer } from '@peaket/shuffle';
import { describe, expect, test } from 'vitest';
import { CommittedSeedSource } from '../src/modules/batch/adapters/committed-seed-source.js';
import { MemoryBatchStore, MemoryResultFiles, MemoryShuffleRecords } from '../src/modules/batch/adapters/memory-batch-store.js';
import { TestRandomness, TEST_RANDOMNESS_ENV } from '../src/modules/batch/adapters/test-randomness.js';
import { BatchMembersChanged, BEACON_WAIT_LIMIT_MS, PublishBatchResults } from '../src/modules/batch/application/publish-batch-results.js';

const E = 'evt-batch-1';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const START = Date.parse('2026-11-10T11:00:00Z');
const SALE_END = START - 24 * 3600_000;

function world(o: { members?: string[]; closed?: { first: number; size: number; gen: number } | null; beacon?: boolean } = {}) {
  const clock = fakeClock({ now: Date.parse('2026-11-03T03:00:05Z') });
  const store = new MemoryBatchStore(clock);
  const members = o.members ?? ['a', 'b', 'c', 'd', 'e'].map(hash);
  const opensAtMs = clock.now() - 3_000;
  store.setForTest(E, { startsAtMs: START, opensAtMs, members, closed: o.closed === undefined ? { first: 11, size: members.length, gen: 1 } : o.closed });
  const randomness = new TestRandomness(Buffer.alloc(32, 9));
  const beacons = o.beacon === false ? { round: async () => null, verifyStored: () => true } : randomness;
  const files = new MemoryResultFiles();
  const records = new MemoryShuffleRecords();
  // 이 묶음 시험의 공시 기록(라운드는 지금 뒤라 비콘 대기 상한에 닿지 않는다)
  records.setForTest(E, 1, { commit: '00'.repeat(32), round: drandRoundAfter(opensAtMs + 2_000), sealed: 'x', atMs: 0 });
  const publish = new PublishBatchResults(store, records, randomness, beacons, files, clock);
  return { clock, store, randomness, files, publish, members, records };
}

describe('시험 비콘의 기록 확인', () => {
  test('Q-T27 시험 비콘은 자기가 만든 값만 맞다고 본다', async () => {
    const r = new TestRandomness(Buffer.alloc(32, 9));
    const got = (await r.round(E, 1))!;
    expect(r.verifyStored(E, 1, 123, got.value.toString('hex'), got.signature)).toBe(true);
    expect(r.verifyStored(E, 1, 123, 'bb'.repeat(32), got.signature)).toBe(false);
    expect(r.verifyStored('other', 1, 123, got.value.toString('hex'), got.signature)).toBe(false);
  });

  test('Q-T27 시험 비콘의 서명은 drand G1과 같은 16진 96자이고, 값은 서명의 SHA-256이다(검증 화면이 정상 공시로 대조한다)', async () => {
    const got = (await new TestRandomness(Buffer.alloc(32, 9)).round(E, 1))!;
    expect(got.signature).toMatch(/^[0-9a-f]{96}$/);
    expect(got.value.toString('hex')).toBe(createHash('sha256').update(Buffer.from(got.signature, 'hex')).digest('hex'));
  });
});

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

  test('Q-T68④ Q-T68⑦ 게시 때 묶음의 주인 없는 자리(ORPHAN)는 그 번호를 빠진 번호로 돌린다', async () => {
    const m = ['a', 'b', 'c'].map(hash);
    const { store, publish } = world({ members: m });
    store.orphanForTest(E, m[1]!);
    expect(await publish.run({ eventId: E })).toMatchObject({ status: 'PUBLISHED', count: 3 });
    const seq = Number(store.resultOf(m[1]!)!.value.split(':')[0]);
    expect(store.removedOf(E)).toEqual([seq]);
  });

  test('FR-038 참가자가있으면_앞자리4096개파일을모두쓰고_빈앞자리는빈표다', async () => {
    const { files, publish } = world();
    await publish.run({ eventId: E });
    expect(files.written(E).size).toBe(4096);
    expect(files.written(E).get('000')).toEqual({});
  });

  test('POL-005 Q-T6 머클루트는_비콘을받기전에공시한다', async () => {
    const w = world({ beacon: false });
    expect(await w.publish.run({ eventId: E })).toEqual({ status: 'WAITING_BEACON' });
    const root = merkleRoot(sortHashes(w.members).map((h) => Buffer.from(h, 'hex'))).toString('hex');
    expect(await w.store.earlyRootOf(E, 1)).toEqual({ root, atMs: w.clock.now() });
    expect(w.store.publishedForTest(E)).toBeNull();
    expect(w.files.written(E).size).toBe(0);
  });

  test('[ASVS v5.0.0-15.4.2] POL-005 복제확인전에는_머클루트를공시하지않는다', async () => {
    const w = world();
    w.store.replicatedForTest(false);
    expect(await w.publish.run({ eventId: E })).toEqual({ status: 'WAITING_REPLICA' });
    expect(await w.store.earlyRootOf(E, 1)).toBeNull();
  });

  test('POL-005 Q-T6 공시한루트와_게시때다시센루트가다르면_게시를멈춘다', async () => {
    const w = world({ beacon: false });
    await w.publish.run({ eventId: E });
    w.store.setMembersForTest(E, [...w.members.slice(0, 4), hash('z')]);
    const again = new PublishBatchResults(w.store, w.records, w.randomness, w.randomness, w.files, w.clock);
    expect(await again.run({ eventId: E })).toEqual({ status: 'BEACON_STOPPED', reason: 'members_changed', first: true });
    expect((await w.records.read(E, 1))?.stopped?.reason).toBe('members_changed');
    expect(w.store.publishedForTest(E)).toBeNull();
    expect(await again.run({ eventId: E })).toEqual({ status: 'BEACON_STOPPED', reason: 'members_changed', first: false });
  });

  test('[ASVS v5.0.0-16.5.2] POL-005 Q-T6 머클루트를_공시라운드뒤에썼으면_게시를멈춘다(리더가죽었다가라운드뒤에처음돈경우)', async () => {
    const w = world();
    const rec = await w.records.read(E, 1);
    w.clock.advance(drandRoundTimeMs(rec!.round) + 1 - w.clock.now());
    expect(await w.publish.run({ eventId: E })).toEqual({ status: 'BEACON_STOPPED', reason: 'late_root', first: true });
    expect((await w.records.read(E, 1))?.stopped?.reason).toBe('late_root');
    expect(w.store.publishedForTest(E)).toBeNull();
    expect(w.files.written(E).size).toBe(0);
  });

  test('[ASVS v5.0.0-16.5.2] 결과파일쓰기가실패한뒤다시부르면_사람별결과와셔플을되풀이하지않고파일만다시쓴다', async () => {
    const w = world();
    let fail = true;
    let seeds = 0;
    const files = { write: async (e: string, g: 1 | 'lobby' | number, m: ReadonlyMap<string, Record<string, number>>) => (fail ? Promise.reject(new Error('S3 503')) : w.files.write(e, g, m)) };
    const seedSource = { seed: async (e: string, g: 1 | 'lobby' | number) => ((seeds += 1), w.randomness.seed(e, g)) };
    const p = new PublishBatchResults(w.store, w.records, seedSource, w.randomness, files, w.clock);
    await expect(p.run({ eventId: E })).rejects.toThrow('S3 503');
    const writes = w.store.writeCallsForTest();
    expect(writes).toBe(1);
    fail = false;
    expect(await p.run({ eventId: E })).toMatchObject({ status: 'PUBLISHED', count: 5 });
    expect(w.store.writeCallsForTest()).toBe(writes);
    expect(seeds).toBe(1);
    expect(w.store.publishedForTest(E)).not.toBeNull();
  });

  test('공시때읽은참가자를게시까지쓰고_리더를잃어forget하면비운다(참가자를다시읽는다)', async () => {
    const w = world();
    let round: Awaited<ReturnType<typeof w.randomness.round>> = null;
    const p = new PublishBatchResults(w.store, w.records, w.randomness, { round: async () => round, verifyStored: () => true }, w.files, w.clock);
    expect(await p.run({ eventId: E })).toEqual({ status: 'WAITING_BEACON' });
    expect(w.store.membersCallsForTest()).toBe(1);
    round = await w.randomness.round(E, 1);
    expect(await p.run({ eventId: E })).toMatchObject({ status: 'PUBLISHED' });
    expect(w.store.membersCallsForTest()).toBe(1);

    const other = world();
    const q = new PublishBatchResults(other.store, other.records, other.randomness, { round: async () => null, verifyStored: () => true }, other.files, other.clock);
    await q.run({ eventId: E });
    q.forget();
    const r = new PublishBatchResults(other.store, other.records, other.randomness, other.randomness, other.files, other.clock);
    await r.run({ eventId: E });
    expect(other.store.membersCallsForTest()).toBe(2);
  });

  /** 결과 파일 쓰기가 한 번 실패해 #pending이 남은 게시 */
  async function failedOnce() {
    const w = world();
    const state = { fail: true };
    const files = { write: async (e: string, g: 1 | 'lobby' | number, m: ReadonlyMap<string, Record<string, number>>) => (state.fail ? Promise.reject(new Error('S3 503')) : w.files.write(e, g, m)) };
    const p = new PublishBatchResults(w.store, w.records, w.randomness, w.randomness, files, w.clock);
    await expect(p.run({ eventId: E })).rejects.toThrow('S3 503');
    state.fail = false;
    return { ...w, p };
  }

  test('POL-005 닫힌 구간 표시가 바뀌면 들고 있던 결과를 버리고 처음부터 게시한다(옛 결과로 게시 표시를 쓰지 않는다)', async () => {
    const w = await failedOnce();
    w.store.setClosedForTest(E, { first: 11, size: 5, gen: 2 });
    expect(await w.p.run({ eventId: E })).toMatchObject({ status: 'PUBLISHED', count: 5 });
    expect(w.store.resultOf(w.members[0]!)?.value).toMatch(/:2$/);
    expect(w.store.writeCallsForTest()).toBe(2);
  });

  test('POL-005 리더를 잃은 뒤 돌던 게시는 결과를 들고 남지 않고 게시 표시를 쓰지 않는다', async () => {
    const w = world();
    let once = true;
    const seeds = {
      seed: async (e: string, g: 1 | 'lobby' | number) => {
        if (once) {
          once = false;
          p.forget();
        }
        return w.randomness.seed(e, g);
      },
    };
    const p = new PublishBatchResults(w.store, w.records, seeds, w.randomness, w.files, w.clock);
    expect(await p.run({ eventId: E })).toEqual({ status: 'ABANDONED' });
    expect(w.store.publishedForTest(E)).toBeNull();
    expect(w.files.written(E).size).toBe(0);
    expect(await p.run({ eventId: E })).toMatchObject({ status: 'PUBLISHED' });
  });

  test('POL-005 파일을 다시 쓸 차례여도 멈춘 구간은 게시하지 않는다', async () => {
    const w = await failedOnce();
    await w.records.stop(E, 1, w.clock.now(), 'beacon', START);
    expect(await w.p.run({ eventId: E })).toEqual({ status: 'BEACON_STOPPED', reason: 'beacon', first: false });
    expect(w.store.publishedForTest(E)).toBeNull();
    expect(w.files.written(E).size).toBe(0);
  });

  test('시험 비콘은 값이 서명의 SHA-256이다(검증 화면이 그대로 대조한다)', async () => {
    const w = world();
    const r = (await w.randomness.round(E, 1))!;
    expect(createHash('sha256').update(Buffer.from(r.signature, 'hex')).digest('hex')).toBe(r.value.toString('hex'));
  });

  test('POL-005 Q-T6 게시할때_비콘값과서명을공시기록에남긴다', async () => {
    const w = world();
    await w.publish.run({ eventId: E });
    const rec = await w.records.read(E, 1);
    const round = (await w.randomness.round(E, 1))!;
    expect(rec?.beacon).toBe(round.value.toString('hex'));
    expect(rec?.signature).toBe(round.signature);
  });

  test('[ASVS v5.0.0-16.5.2] 결과파일쓰기가실패하면_게시표시를쓰지않는다', async () => {
    const w = world();
    const failing = new PublishBatchResults(w.store, w.records, w.randomness, w.randomness, { write: async () => Promise.reject(new Error('S3 503')) }, w.clock);
    await expect(failing.run({ eventId: E })).rejects.toThrow('S3 503');
    expect(w.store.publishedForTest(E)).toBeNull();
    await w.publish.run({ eventId: E });
    expect(w.store.publishedForTest(E)).not.toBeNull();
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
    expect((await store.published(E, 1))?.root).toBe(r.status === 'PUBLISHED' ? r.merkleRoot : 'x');
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

describe('로비 셔플과 비콘 대기(HOT-040, ADR-0231)', () => {
  const OPENS = Date.parse('2026-11-09T11:00:00Z');
  const ROUND = drandRoundAfter(OPENS);
  const sealer = new TestSeedSealer(Buffer.alloc(32, 8));

  async function lobby(o: { members?: string[]; verifying?: string[]; beacon?: Buffer | null; now?: number; round?: number; noRecord?: boolean; commitOffsetMs?: number } = {}) {
    const clock = fakeClock({ now: o.now ?? drandRoundTimeMs(ROUND) + 1_000 });
    const store = new MemoryBatchStore();
    const members = o.members ?? ['p', 'q', 'r'].map(hash);
    store.setForTest(E, { startsAtMs: START, opensAtMs: OPENS, members, closed: { first: 1, size: members.length, gen: 1 }, group: 'lobby', verifying: o.verifying ?? [] });
    const records = new MemoryShuffleRecords();
    const seed = Buffer.alloc(32, 3);
    if (!o.noRecord) records.setForTest(E, 'lobby', { commit: commitment(E, seed).toString('hex'), round: o.round ?? ROUND, sealed: await sealer.seal(E, 'lobby', seed), atMs: OPENS - 600_000 + (o.commitOffsetMs ?? 0) });
    const seeds = new CommittedSeedSource(records, sealer);
    const beaconValue = o.beacon === undefined ? Buffer.alloc(32, 6) : o.beacon;
    const beacons = { round: async () => (beaconValue ? { value: beaconValue, signature: 'ab' } : null), verifyStored: () => true };
    const files = new MemoryResultFiles();
    const publish = new PublishBatchResults(store, records, seeds, beacons, files, clock);
    return { clock, store, records, files, publish, members, seed };
  }

  test('Q-T6 구간 lobby는 q:lobby 결과와 shuffle-results 파일, pub:lobby를 쓴다', async () => {
    const w = await lobby();
    const r = await w.publish.run({ eventId: E, group: 'lobby' });
    expect(r).toMatchObject({ status: 'PUBLISHED', count: 3 });
    const sorted = sortHashes(w.members);
    const root = merkleRoot(sorted.map((h) => Buffer.from(h, 'hex')));
    const order = shuffle(sorted, combinedKey(w.seed, Buffer.alloc(32, 6), root, E));
    expect(order.map((h) => w.store.resultOf(h, 'lobby')?.value)).toEqual(['1:1', '2:1', '3:1']);
    expect(w.store.publishedForTest(E, 'lobby')).not.toBeNull();
    expect((await w.store.published(E, 'lobby'))?.root).toBe(root.toString('hex'));
    const all = Object.assign({}, ...[...w.files.written(E, 'lobby').values()]);
    expect(Object.keys(all).sort()).toEqual(sorted);
  });

  test('Q-T34 게시 때 VERIFYING인 참가자의 번호는 빠진 번호로 돌리고 나머지는 그대로다', async () => {
    const m = ['p', 'q', 'r'].map(hash);
    const w = await lobby({ members: m, verifying: [m[1]!] });
    await w.publish.run({ eventId: E, group: 'lobby' });
    const seq = Number(w.store.resultOf(m[1]!, 'lobby')!.value.split(':')[0]);
    expect(w.store.removedOf(E)).toEqual([seq]);
  });

  test('Q-T68② 게시 때 주인 없는 자리(ORPHAN)인 로비 참가자의 번호는 빠진 번호로 돌린다', async () => {
    const m = ['p', 'q', 'r'].map(hash);
    const w = await lobby({ members: m });
    w.store.orphanForTest(E, m[2]!);
    await w.publish.run({ eventId: E, group: 'lobby' });
    const seq = Number(w.store.resultOf(m[2]!, 'lobby')!.value.split(':')[0]);
    expect(w.store.removedOf(E)).toEqual([seq]);
  });

  test('[ASVS v5.0.0-16.5.2] Q-T27 비콘이 라운드 예정 시각에서 30초 늦어도 기다렸다가 받은 뒤 게시한다', async () => {
    const waiting = await lobby({ beacon: null, now: drandRoundTimeMs(ROUND) + 30_000 });
    expect(await waiting.publish.run({ eventId: E, group: 'lobby' })).toEqual({ status: 'WAITING_BEACON' });
    expect(waiting.files.written(E, 'lobby').size).toBe(0);
    const arrived = await lobby({ now: drandRoundTimeMs(ROUND) + 30_000 });
    expect(await arrived.publish.run({ eventId: E, group: 'lobby' })).toMatchObject({ status: 'PUBLISHED' });
  });

  test('[ASVS v5.0.0-16.5.2] Q-T27 라운드 예정 시각에서 60초를 넘겨도 값이 없으면 멈추고, 멈춘 뒤에는 값이 와도 게시하지 않는다', async () => {
    const w = await lobby({ beacon: null, now: drandRoundTimeMs(ROUND) + BEACON_WAIT_LIMIT_MS + 1 });
    expect(await w.publish.run({ eventId: E, group: 'lobby' })).toEqual({ status: 'BEACON_STOPPED', reason: 'beacon', first: true });
    expect((await w.records.read(E, 'lobby'))?.stopped).toMatchObject({ reason: 'beacon' });
    // 값이 뒤늦게 와도(비콘을 바꿔도) 멈춤은 풀리지 않는다(RB-35 CLI만 푼다)
    const again = new PublishBatchResults(w.store, w.records, new CommittedSeedSource(w.records, sealer), { round: async () => ({ value: Buffer.alloc(32, 6), signature: 'ab' }), verifyStored: () => true }, w.files, w.clock);
    expect(await again.run({ eventId: E, group: 'lobby' })).toEqual({ status: 'BEACON_STOPPED', reason: 'beacon', first: false });
    expect(w.store.publishedForTest(E, 'lobby')).toBeNull();
  });

  test('[ASVS v5.0.0-16.5.2] 공시 기록이 없으면 멈추고(no_commit) 게시하지 않으며, 멈춤은 처음 쓴 호출만 first다', async () => {
    const w = await lobby({ noRecord: true });
    expect(await w.publish.run({ eventId: E, group: 'lobby' })).toEqual({ status: 'BEACON_STOPPED', reason: 'no_commit', first: true });
    expect(await w.publish.run({ eventId: E, group: 'lobby' })).toEqual({ status: 'BEACON_STOPPED', reason: 'no_commit', first: false });
    expect(w.store.publishedForTest(E, 'lobby')).toBeNull();
  });

  test('Q-T52 공시 라운드가 고정 시각에서 계산한 라운드와 다르면(앞이든 뒤든, 오픈 시각이 커밋 뒤에 바뀜) 멈춘다', async () => {
    for (const round of [ROUND - 3, ROUND + 3]) {
      const w = await lobby({ round, beacon: null });
      expect(await w.publish.run({ eventId: E, group: 'lobby' })).toEqual({ status: 'BEACON_STOPPED', reason: 'stale_round', first: true });
    }
  });

  test('Q-T27 두 리더가 겹쳐 같은 멈춤을 쓰면 first는 먼저 쓴 쪽만 참이다(SEV1은 한 번)', async () => {
    const w = await lobby({ round: ROUND - 3 });
    const before = await w.records.read(E, 'lobby');
    const stale = { read: async () => before, stop: w.records.stop.bind(w.records), recordBeacon: w.records.recordBeacon.bind(w.records), reveal: w.records.reveal.bind(w.records) };
    const a = new PublishBatchResults(w.store, stale, new CommittedSeedSource(w.records, sealer), { round: async () => ({ value: Buffer.alloc(32, 6), signature: 'ab' }), verifyStored: () => true }, w.files, w.clock);
    expect(await a.run({ eventId: E, group: 'lobby' })).toMatchObject({ first: true });
    expect(await a.run({ eventId: E, group: 'lobby' })).toMatchObject({ first: false });
  });

  test('Q-T23 참가자가 0명이면 공시 기록·비콘과 상관없이 빈 게시를 해 회차를 막지 않는다', async () => {
    for (const o of [{ noRecord: true }, { commitOffsetMs: 3_600_000 }, { beacon: null, now: drandRoundTimeMs(ROUND) + BEACON_WAIT_LIMIT_MS + 1 }]) {
      const w = await lobby({ members: [], ...o });
      expect(await w.publish.run({ eventId: E, group: 'lobby' })).toMatchObject({ status: 'PUBLISHED', count: 0 });
      expect(w.store.publishedForTest(E, 'lobby')).not.toBeNull();
    }
  });

  test('Q-T52 커밋 공시가 목록 고정 뒤에 쓰였으면 멈춘다', async () => {
    const w = await lobby({ commitOffsetMs: 600_001 });
    expect(await w.publish.run({ eventId: E, group: 'lobby' })).toEqual({ status: 'BEACON_STOPPED', reason: 'late_commit', first: true });
  });

  test('봉인을 푼 시드가 커밋과 다르면 쓰지 않는다', async () => {
    const records = new MemoryShuffleRecords();
    records.setForTest(E, 'lobby', { commit: '00'.repeat(32), round: ROUND, sealed: await sealer.seal(E, 'lobby', Buffer.alloc(32, 3)), atMs: 1 });
    await expect(new CommittedSeedSource(records, sealer).seed(E, 'lobby')).rejects.toThrow(/커밋/);
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
