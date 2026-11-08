// 첫 게시에서 머클 루트는 공시할 때 한 번만 센다(100만 명이면 동기 계산 약 2.4초, ADR-0232 결정 5)
import { createHash } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { expect, test, vi } from 'vitest';

const counted = vi.hoisted(() => ({ merkle: 0 }));
vi.mock('@peaket/shuffle', async (original) => {
  const real = (await original()) as typeof import('@peaket/shuffle');
  return { ...real, merkleRoot: (leaves: readonly Uint8Array[]) => ((counted.merkle += 1), real.merkleRoot(leaves)) };
});

const { drandRoundAfter } = await import('@peaket/shuffle');
const { MemoryBatchStore, MemoryResultFiles, MemoryShuffleRecords } = await import('../src/modules/batch/adapters/memory-batch-store.js');
const { TestRandomness } = await import('../src/modules/batch/adapters/test-randomness.js');
const { PublishBatchResults } = await import('../src/modules/batch/application/publish-batch-results.js');

test('Q-T6 첫 게시에서 머클 루트 계산은 한 번이다', async () => {
  const E = 'evt-once';
  const clock = fakeClock({ now: Date.parse('2026-11-03T03:00:05Z') });
  const opensAtMs = clock.now() - 3_000;
  const store = new MemoryBatchStore(clock);
  const members = ['a', 'b', 'c'].map((s) => createHash('sha256').update(s).digest('hex'));
  store.setForTest(E, { startsAtMs: Date.parse('2026-11-10T11:00:00Z'), opensAtMs, members, closed: { first: 1, size: 3, gen: 1 } });
  const records = new MemoryShuffleRecords();
  records.setForTest(E, 1, { commit: '00'.repeat(32), round: drandRoundAfter(opensAtMs + 2_000), sealed: 'x', atMs: 0 });
  const randomness = new TestRandomness(Buffer.alloc(32, 9));
  await new PublishBatchResults(store, records, randomness, randomness, new MemoryResultFiles(), clock).run({ eventId: E });
  expect(store.publishedForTest(E)).not.toBeNull();
  expect(counted.merkle).toBe(1);
});
