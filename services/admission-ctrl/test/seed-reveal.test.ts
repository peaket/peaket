// 시드 공개(POL-005, ADR-0232 결정 7): 오픈 60분 뒤, 그 구간을 게시한 뒤에만 봉인을 풀어 커밋과 대조하고 비어 있을 때만 쓴다
import { createHash, randomBytes } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { commitment, SEED_REVEAL_AFTER_MS, TestSeedSealer } from '@peaket/shuffle';
import { describe, expect, test } from 'vitest';
import { CommittedSeedSource } from '../src/modules/batch/adapters/committed-seed-source.js';
import { MemoryBatchStore, MemoryShuffleRecords } from '../src/modules/batch/adapters/memory-batch-store.js';
import { RevealShuffleSeeds } from '../src/modules/batch/application/reveal-shuffle-seeds.js';

const E = 'evt-reveal-1';
const OPEN = Date.parse('2026-11-10T11:00:00Z');
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

async function world(o: { published?: boolean } = {}) {
  const clock = fakeClock({ now: OPEN + SEED_REVEAL_AFTER_MS });
  const store = new MemoryBatchStore();
  store.setForTest(E, { startsAtMs: OPEN + 72 * 3600_000, opensAtMs: OPEN, members: [hash('a')], closed: { first: 1, size: 1, gen: 1 } });
  if (o.published !== false) await store.markPublished(E, 1, OPEN + 7_000, hash('root'));
  const records = new MemoryShuffleRecords();
  const sealer = new TestSeedSealer(Buffer.alloc(32, 3));
  const seed = randomBytes(32);
  records.setForTest(E, 1, { commit: commitment(E, seed).toString('hex'), round: 123, sealed: await sealer.seal(E, 1, seed), atMs: OPEN - 600_000 });
  let opened = 0;
  const counting = { ...sealer, seal: sealer.seal.bind(sealer), open: (e: string, g: number | 'lobby', s: string) => ((opened += 1), sealer.open(e, g, s)) };
  const reveal = new RevealShuffleSeeds(store, records, new CommittedSeedSource(records, counting), clock);
  return { clock, store, records, seed, reveal, opened: () => opened };
}

describe('시드 공개', () => {
  test('[ASVS v5.0.0-13.3.2] POL-005 오픈 60분 전에는 봉인을 풀지 않는다', async () => {
    const w = await world();
    expect(await w.reveal.run({ eventId: E, group: 1, opensAtMs: OPEN + 1, expireAtMs: OPEN + 72 * 3600_000 })).toEqual({ status: 'NOT_YET' });
    expect(w.opened()).toBe(0);
    expect((await w.records.read(E, 1))?.seed).toBeUndefined();
  });

  test('[ASVS v5.0.0-13.3.2] 게시하지 못한 구간은 공개하지 않는다', async () => {
    const w = await world({ published: false });
    expect(await w.reveal.run({ eventId: E, group: 1, opensAtMs: OPEN, expireAtMs: OPEN + 72 * 3600_000 })).toEqual({ status: 'NOT_PUBLISHED' });
    expect(w.opened()).toBe(0);
    expect((await w.records.read(E, 1))?.seed).toBeUndefined();
  });

  test('[ASVS v5.0.0-13.3.2] 멈춘 구간은 게시 표시가 있어도 공개하지 않는다(RB-35 판단 전에 시드가 나가지 않게)', async () => {
    const w = await world();
    await w.records.stop(E, 1, OPEN + 1, 'members_changed', OPEN + 72 * 3600_000);
    expect(await w.reveal.run({ eventId: E, group: 1, opensAtMs: OPEN, expireAtMs: OPEN + 72 * 3600_000 })).toEqual({ status: 'STOPPED' });
    expect(w.opened()).toBe(0);
    expect((await w.records.read(E, 1))?.seed).toBeUndefined();
  });

  test('[ASVS v5.0.0-15.4.2] POL-005 오픈 60분 뒤 게시한 구간의 시드를 커밋과 대조해 공개하고 두 번째 호출은 봉인을 풀지 않는다', async () => {
    const w = await world();
    expect(await w.reveal.run({ eventId: E, group: 1, opensAtMs: OPEN, expireAtMs: OPEN + 72 * 3600_000 })).toEqual({ status: 'REVEALED' });
    const rec = await w.records.read(E, 1);
    expect(rec?.seed).toBe(w.seed.toString('hex'));
    expect(rec?.seedAtMs).toBe(w.clock.now());
    expect(await w.reveal.run({ eventId: E, group: 1, opensAtMs: OPEN, expireAtMs: OPEN + 72 * 3600_000 })).toEqual({ status: 'ALREADY' });
    expect(w.opened()).toBe(1);
  });

  test('[ASVS v5.0.0-16.5.2] 봉인을 푼 시드가 커밋과 다르면 공개하지 않는다', async () => {
    const w = await world();
    const rec = (await w.records.read(E, 1))!;
    w.records.setForTest(E, 1, { ...rec, commit: '00'.repeat(32) });
    await expect(w.reveal.run({ eventId: E, group: 1, opensAtMs: OPEN, expireAtMs: OPEN + 72 * 3600_000 })).rejects.toThrow();
    expect((await w.records.read(E, 1))?.seed).toBeUndefined();
  });

  test('공시 기록이 없으면 NO_RECORD이고 아무것도 풀거나 쓰지 않는다(참가자 0명 구간)', async () => {
    const w = await world();
    await expect(w.reveal.run({ eventId: 'evt-none', group: 1, opensAtMs: OPEN, expireAtMs: OPEN + 72 * 3600_000 })).resolves.toEqual({ status: 'NO_RECORD' });
    expect(w.opened()).toBe(0);
    expect(await w.records.read('evt-none', 1)).toBeNull();
  });
});
