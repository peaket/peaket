// 커밋 공시 일꾼(ADR-0231 결정 6, ASVS v5.0.0-11.5.1): 공시 때가 지난 구간의 시드를 CSPRNG로 만들고 봉인해 기록한다.
import { fakeClock } from '@peaket/platform';
import { commitment, type ShuffleGroup, TestSeedSealer } from '@peaket/shuffle';
import { describe, expect, test } from 'vitest';
import { MemoryEventSchedules, MemoryShuffleCommits } from '../src/modules/entry/adapters/memory-entry-store.js';
import { COMMIT_CACHE_MAX, COMMIT_CACHE_MS, ShuffleCommits, ShuffleCommitWorker } from '../src/modules/entry/application/shuffle-commits.js';
import type { EventSchedule } from '../src/modules/entry/domain/queue.js';

const NOW = Date.UTC(2026, 10, 9, 3, 0, 0);
const sealer = new TestSeedSealer(Buffer.alloc(32, 5));

function world(events: Record<string, Partial<EventSchedule>>) {
  const clock = fakeClock({ now: NOW });
  const store = new MemoryShuffleCommits(clock);
  const schedules = new MemoryEventSchedules();
  const list = async () => Object.keys(events);
  const commits = new ShuffleCommits(store, sealer, schedules, clock);
  const worker = new ShuffleCommitWorker(commits, schedules, list, clock);
  const set = async () => {
    for (const [id, o] of Object.entries(events)) await schedules.set(id, { opensAtMs: NOW + 9 * 60_000, startsAtMs: NOW + 3 * 24 * 3600_000, lobbyShuffle: true, openBatch: true, lobbyMinutes: 10, ...o });
  };
  return { clock, store, schedules, worker, commits, set };
}

describe('커밋 공시 일꾼', () => {
  test('[ASVS v5.0.0-11.5.1] 공시 때가 지난 회차의 로비·묶음 구간마다 다른 시드로 커밋을 쓴다', async () => {
    const w = world({ e1: {} });
    await w.set();
    await w.worker.tickOnce();
    const lobby = await w.store.read('e1', 'lobby');
    const batch = await w.store.read('e1', 1);
    expect(lobby?.commit).toMatch(/^[0-9a-f]{64}$/);
    expect(batch?.commit).not.toBe(lobby?.commit);
    const seed = await sealer.open('e1', 'lobby', lobby!.sealed);
    expect(seed).toHaveLength(32);
    expect(commitment('e1', seed).toString('hex')).toBe(lobby!.commit);
  });

  test('[ASVS v5.0.0-11.5.1] 공시 때 전에는 만들지 않고, 때가 지나면 만든다', async () => {
    const w = world({ soon: { opensAtMs: NOW + 12 * 60_000 }, far: { opensAtMs: NOW + 60 * 60_000 } });
    await w.set();
    await w.worker.tickOnce();
    expect(await w.store.read('far', 'lobby')).toBeNull();
    expect(await w.store.read('soon', 'lobby')).toBeNull();
    w.clock.advance(3 * 60_000);
    await w.worker.tickOnce();
    expect(await w.store.read('soon', 'lobby')).not.toBeNull();
  });

  test('선착순 회차(로비 끔)는 묶음 구간만, 사전 셔플 회차(묶음 끔)는 로비 구간만 만든다', async () => {
    const w = world({ fifo: { lobbyShuffle: false }, pre: { openBatch: false } });
    await w.set();
    await w.worker.tickOnce();
    expect(await w.store.read('fifo', 'lobby')).toBeNull();
    expect(await w.store.read('fifo', 1)).not.toBeNull();
    expect(await w.store.read('pre', 1)).toBeNull();
    expect(await w.store.read('pre', 'lobby')).not.toBeNull();
  });

  test('이미 쓴 구간은 다시 만들지 않는다(봉인을 부르지 않는다)', async () => {
    const w = world({ e1: {} });
    await w.set();
    await w.worker.tickOnce();
    const before = await w.store.read('e1', 'lobby');
    let sealed = 0;
    const counted = new ShuffleCommitWorker(new ShuffleCommits(w.store, { seal: async () => (sealed++, 'x'), open: async () => Buffer.alloc(32) }, w.schedules, w.clock), w.schedules, async () => ['e1'], w.clock);
    await counted.tickOnce();
    expect(sealed).toBe(0);
    expect(await w.store.read('e1', 'lobby')).toEqual(before);
  });

  test('파드 메모리는 잠깐만 두고 Redis 기록을 정본으로 본다: 기록을 잃고 다시 쓰이면 짧은 시간 뒤 새 값을 준다', async () => {
    const w = world({ e1: {} });
    await w.set();
    const first = await w.commits.ensure('e1', 'lobby', (await w.schedules.get('e1'))!);
    const rewritten = { ...first, commit: 'ff'.repeat(32) };
    w.store.replaceForTest('e1', 'lobby', rewritten);
    expect(await w.commits.peek('e1', 'lobby')).toEqual(first);
    w.clock.advance(COMMIT_CACHE_MS + 1);
    expect(await w.commits.peek('e1', 'lobby')).toEqual(rewritten);
  });

  test('파드 메모리에 두는 기록 수에 상한이 있다', async () => {
    const w = world({});
    let reads = 0;
    const read = w.store.read.bind(w.store);
    w.store.read = (e, g) => (reads++, read(e, g));
    for (let i = 0; i <= COMMIT_CACHE_MAX; i++) {
      await w.store.write(`e${i}`, 'lobby', { commit: 'aa'.repeat(32), round: 1, sealed: 's' }, 0);
      await w.commits.peek(`e${i}`, 'lobby');
    }
    const before = reads;
    await w.commits.peek('e0', 'lobby');
    expect(reads).toBe(before + 1);
    await w.commits.peek(`e${COMMIT_CACHE_MAX}`, 'lobby');
    expect(reads).toBe(before + 1);
  });

  test('봉인이 실패해도 다음 회차와 다음 주기를 막지 않는다', async () => {
    const w = world({ a: {}, b: {} });
    await w.set();
    let fail = true;
    const shaky = { seal: (e: string, g: ShuffleGroup, s: Uint8Array) => (e === 'a' && fail ? Promise.reject(new Error('kms')) : sealer.seal(e, g, s)), open: sealer.open.bind(sealer) };
    const worker = new ShuffleCommitWorker(new ShuffleCommits(w.store, shaky, w.schedules, w.clock), w.schedules, async () => ['a', 'b'], w.clock);
    await worker.tickOnce();
    expect(await w.store.read('a', 'lobby')).toBeNull();
    expect(await w.store.read('b', 'lobby')).not.toBeNull();
    fail = false;
    await worker.tickOnce();
    expect(await w.store.read('a', 'lobby')).not.toBeNull();
  });
});
