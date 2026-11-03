// 진입 규칙을 메모리 저장소로 돈다(같은 사례를 test-int가 실제 Valkey Lua로 돈다)
import { fakeClock } from '@peaket/platform';
import { expect, test } from 'vitest';
import { MemoryEntryStore, MemoryEventSchedules } from '../src/modules/entry/adapters/memory-entry-store.js';
import { segmentOf } from '../src/modules/entry/domain/queue.js';
import { batchCases } from './batch-cases.js';
import { entryCases } from './entry-cases.js';

const PENDING_TTL_MS = 10_000;

entryCases('메모리', async () => {
  const clock = fakeClock({ now: Date.UTC(2026, 10, 3, 1, 0, 0) });
  const store = new MemoryEntryStore(clock);
  return {
    store,
    schedules: new MemoryEventSchedules(),
    clock,
    pendingTtlMs: PENDING_TTL_MS,
    passPending: async () => clock.advance(PENDING_TTL_MS + 1),
    admit: async (pid, eventId, hash) => store.admitForTest(pid, eventId, hash),
    addSkipped: async (eventId, line) => store.addSkippedForTest(eventId, line),
    removed: async (eventId, seq) => store.isRemoved(eventId, seq),
    verifying: async (eventId, hash) => store.verifyOf(eventId, hash),
    counter: async (eventId) => store.counterOf(eventId),
  };
});

batchCases('메모리', async () => {
  const clock = fakeClock({ now: Date.UTC(2026, 10, 3, 1, 0, 0) });
  const store = new MemoryEntryStore(clock);
  const windowMs = 2_000;
  return {
    store,
    schedules: new MemoryEventSchedules(),
    clock,
    pendingTtlMs: PENDING_TTL_MS,
    windowMs,
    passPending: async () => clock.advance(PENDING_TTL_MS + 1),
    passWindow: async () => clock.advance(windowMs + 1),
    admit: async (pid, eventId, hash) => store.admitForTest(pid, eventId, hash),
    addSkipped: async (eventId, line) => store.addSkippedForTest(eventId, line),
    removed: async (eventId, seq) => store.isRemoved(eventId, seq),
    verifying: async (eventId, hash) => store.verifyOf(eventId, hash),
    counter: async (eventId) => store.counterOf(eventId),
    publishResult: async (eventId, hash, seq, gen) => store.publishForTest(eventId, { [hash]: `${seq}:${gen}` }),
    publishNone: async (eventId) => store.publishForTest(eventId, {}),
    batchMembers: async (eventId) => store.membersOf(eventId),
    marker: async (eventId, field) => store.markerOf(eventId, field),
    addLobby: async (eventId, n) => store.addLobbyForTest(eventId, n),
    dupOf: async (pid, eventId) => store.dupForTest(pid, eventId),
    dropMember: async (eventId, hash) => store.dropMemberForTest(eventId, hash),
  };
});

test('구간은_floor((번호-1)÷1000)이다_구간0이1~1000번', () => {
  expect([1, 1000, 1001, 2000, 2001, 1_000_000].map(segmentOf)).toEqual([0, 0, 1, 1, 2, 999]);
});
