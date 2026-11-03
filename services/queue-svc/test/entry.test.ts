// 진입 규칙을 메모리 저장소로 돈다(같은 사례를 test-int가 실제 Valkey Lua로 돈다)
import { fakeClock } from '@peaket/platform';
import { expect, test } from 'vitest';
import { MemoryEntryStore, MemoryEventSchedules } from '../src/modules/entry/adapters/memory-entry-store.js';
import { EnterQueue } from '../src/modules/entry/application/enter-queue.js';
import { segmentOf } from '../src/modules/entry/domain/queue.js';
import { batchCases } from './batch-cases.js';
import { entryCases } from './entry-cases.js';
import { DEVICE, ACCOUNT, newEvent, newRequest, openSchedule, preverifyToken, tokens } from './support.js';

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
    failover: async (eventId) => store.failoverForTest(eventId),
    lose: async (eventId, seq) => store.rollbackForTest(eventId, { seq, skipped: store.skippedOf(eventId), epoch: store.epochOf(eventId)! }),
    skipped: async (eventId) => store.skippedOf(eventId),
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
    failover: async (eventId) => store.failoverForTest(eventId),
    lose: async (eventId, seq) => store.rollbackForTest(eventId, { seq, skipped: store.skippedOf(eventId), epoch: store.epochOf(eventId)! }),
    skipped: async (eventId) => store.skippedOf(eventId),
    publishResult: async (eventId, hash, seq, gen) => store.publishForTest(eventId, { [hash]: `${seq}:${gen}` }),
    publishNone: async (eventId) => store.publishForTest(eventId, {}),
    batchMembers: async (eventId) => store.membersOf(eventId),
    marker: async (eventId, field) => store.markerOf(eventId, field),
    addLobby: async (eventId, n) => store.addLobbyForTest(eventId, n),
    dupOf: async (pid, eventId) => store.dupForTest(pid, eventId),
    dropMember: async (eventId, hash) => store.dropMemberForTest(eventId, hash),
  };
});

test('[Q-T13] 첫RB05와그뒤번호를두번째장애전환으로잃어도_설정세대가오른만큼더건너뛰어_사라진주노드가낸번호와겹치지않는다', async () => {
  const clock = fakeClock({ now: Date.UTC(2026, 10, 3, 1, 0, 0) });
  const store = new MemoryEntryStore(clock);
  const schedules = new MemoryEventSchedules();
  const eventId = newEvent();
  await schedules.set(eventId, openSchedule(clock.now()));
  const enter = new EnterQueue(store, schedules, tokens, clock, { pendingTtlMs: PENDING_TTL_MS, rb05SkipBase: 50 });
  const go = (i: number, b = { preverifyToken: preverifyToken(clock, eventId), deviceId: DEVICE, entryRequestId: newRequest() }) =>
    enter.run({ accountId: ACCOUNT, pid: `pid-twice-${i}-${eventId}`.slice(0, 64), eventId, body: b });
  for (let i = 0; i < 3; i++) await go(i);
  const before = { seq: 3, skipped: store.skippedOf(eventId), epoch: store.epochOf(eventId)! };
  // 주 노드 B가 올라서 RB-05(4~53 건너뜀)를 하고 54번(세대 2)을 냈다
  store.failoverForTest(eventId);
  const b = { preverifyToken: preverifyToken(clock, eventId), deviceId: DEVICE, entryRequestId: newRequest() };
  await expect(go(3, b)).rejects.toMatchObject({ code: 'QUEUE_RECOVERING' });
  const t1 = await go(3, b);
  expect(t1.kind === 'TICKET' && [t1.seq, t1.generation]).toEqual([54, 2]);
  // 그 쓰기가 복제되기 전에 B도 죽고 C가 더 큰 설정 세대로 올라섰다: C의 기록은 장애 전과 같다
  store.rollbackForTest(eventId, before);
  store.failoverForTest(eventId);
  await expect(go(4)).rejects.toMatchObject({ code: 'QUEUE_RECOVERING' });
  // 설정 세대가 둘 올랐으니 바탕 값의 두 배를 건너뛴다(B가 냈을 수 있는 번호까지)
  expect(store.skippedOf(eventId)).toEqual(['4:103:1']);
  const t2 = await go(4);
  expect(t2.kind === 'TICKET' && [t2.seq, t2.generation]).toEqual([104, 2]);
});

test('설정세대가셋넘게올라도_곱하는수는3에서자른다(메모리저장소가Lua와같다)', async () => {
  const clock = fakeClock({ now: Date.UTC(2026, 10, 3, 1, 0, 0) });
  const store = new MemoryEntryStore(clock);
  const eventId = newEvent();
  // 세대 키는 지금 노드(node-1:1)가 썼고, 그 뒤 다섯 번 승격해 설정 세대가 6이 됐다
  store.rollbackForTest(eventId, { seq: 3, skipped: [], epoch: 'node-1:1' });
  for (let i = 0; i < 5; i++) store.failoverForTest();
  const input = { eventId, expireAtMs: clock.now() + 1, skippedExpireAtMs: clock.now() + 1, skipBase: 10, opensAtMs: clock.now() - 1, lobbyShuffle: false, openBatch: false };
  expect(await store.rb05(input)).toEqual({ kind: 'SKIPPED', start: 4, end: 3 + 30, gen: 2 });
});

test('구간은_floor((번호-1)÷1000)이다_구간0이1~1000번', () => {
  expect([1, 1000, 1001, 2000, 2001, 1_000_000].map(segmentOf)).toEqual([0, 0, 1, 1, 2, 999]);
});
