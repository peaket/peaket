// 진입 규칙을 메모리 저장소로 돈다(같은 사례를 test-int가 실제 Valkey Lua로 돈다)
import { fakeClock } from '@peaket/platform';
import { expect, test } from 'vitest';
import { MemoryEntryStore, MemoryEventSchedules, MemoryShuffleCommits } from '../src/modules/entry/adapters/memory-entry-store.js';
import { EnterQueue } from '../src/modules/entry/application/enter-queue.js';
import { ARRIVAL_CARVE_WINDOW_MS, segmentOf } from '../src/modules/entry/domain/queue.js';
import { arrivalSlotCases } from './arrival-slot-cases.js';
import { batchCases } from './batch-cases.js';
import { leaveCases } from './leave-cases.js';
import { lobbyCases } from './lobby-cases.js';
import { entryCases } from './entry-cases.js';
import { type PidWorld, pidTransitionEntryCases } from './pid-transition-cases.js';
import { DEVICE, ACCOUNT, newEvent, newRequest, openSchedule, preverifyToken, tokens } from './support.js';

const PENDING_TTL_MS = 10_000;

const memoryWorld = async (): Promise<PidWorld> => {
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
    setSaleState: async (eventId, state) => store.setSaleStateForTest(eventId, state),
    dupValue: async (pid, eventId) => store.dupForTest(pid, eventId).value,
    dupOf: async (pid: string, eventId: string) => store.dupForTest(pid, eventId),
    setDup: async (pid: string, eventId: string, value: string | null, expireAtMs?: number) => store.setDupForTest(pid, eventId, value, expireAtMs),
  };
};

entryCases('메모리', memoryWorld);
arrivalSlotCases('메모리', async () => {
  const clock = fakeClock({ now: Date.UTC(2026, 10, 9, 1, 0, 0) });
  const store = new MemoryEntryStore(clock);
  return { store, now: () => clock.now(), counter: async (e) => store.counterOf(e), failover: async (e) => store.failoverForTest(e), setUsed: async (e, slot, used) => store.setArrivalUsedForTest(e, slot, used), alignCarveWindow: async () => undefined, nextCarveWindow: async () => void clock.advance(ARRIVAL_CARVE_WINDOW_MS) };
});
pidTransitionEntryCases('메모리', memoryWorld);
lobbyCases('메모리', async () => {
  const clock = fakeClock({ now: Date.UTC(2026, 10, 9, 3, 0, 0) });
  const store = new MemoryEntryStore(clock);
  return {
    store,
    commits: new MemoryShuffleCommits(clock),
    schedules: new MemoryEventSchedules(),
    clock,
    admit: async (pid, eventId, hash) => store.admitForTest(pid, eventId, hash),
    closeLobby: async (eventId) => store.closeLobbyForTest(eventId),
    members: async (eventId) => store.lobbyMembersForTest(eventId),
    dupValue: async (pid, eventId) => store.dupForTest(pid, eventId).value,
    verifying: async (eventId, hash) => store.verifyOf(eventId, hash),
  };
});

leaveCases('메모리', async () => {
  const clock = fakeClock({ now: Date.UTC(2026, 10, 9, 4, 0, 0) });
  const store = new MemoryEntryStore(clock);
  return {
    store,
    commits: new MemoryShuffleCommits(clock),
    schedules: new MemoryEventSchedules(),
    clock,
    admit: async (pid, eventId, hash) => store.admitForTest(pid, eventId, hash),
    closeList: async (eventId, field, marker) => store.closeListForTest(eventId, field, marker),
    lobbyMembers: async (eventId) => store.lobbyMembersForTest(eventId),
    batchMembers: async (eventId) => store.membersOf(eventId),
    dupValue: async (pid, eventId) => store.dupForTest(pid, eventId).value,
    setDup: async (pid, eventId, value) => store.setDupForTest(pid, eventId, value),
    verifyOf: async (eventId, hash) => store.verifyOf(eventId, hash),
    setVerify: async (eventId, hash, value) => store.setVerifyForTest(eventId, hash, value),
    removed: async (eventId, seq) => store.isRemoved(eventId, seq),
    setResult: async (tokenHash, _group, seq, gen) => store.setResultForTest(tokenHash, seq, gen),
    addSoon: async (eventId, hash, seq) => store.addSoonForTest(eventId, hash, seq),
    soonOf: async (eventId) => store.soonForTest(eventId),
    markerOf: async (eventId, field) => store.markerOf(eventId, field),
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

test('[Q-T13] RB05가건너뛴뒤_복제를확인하기전에는번호를내지않고_확인되면건너뛴구간뒤번호를낸다(ADR-0186)', async () => {
  const clock = fakeClock({ now: Date.UTC(2026, 10, 3, 1, 0, 0) });
  const store = new MemoryEntryStore(clock);
  const schedules = new MemoryEventSchedules();
  const eventId = newEvent();
  await schedules.set(eventId, openSchedule(clock.now()));
  const enter = new EnterQueue(store, schedules, tokens, clock, { pendingTtlMs: PENDING_TTL_MS, rb05SkipBase: 50 });
  const go = (i: number, b = { preverifyToken: preverifyToken(clock, eventId), deviceId: DEVICE, entryRequestId: newRequest() }) =>
    enter.run({ accountId: ACCOUNT, pid: `pid-confirm-${i}-${eventId}`.slice(0, 64), eventId, body: b });
  for (let i = 0; i < 3; i++) await go(i);
  store.failoverForTest(eventId);
  // 복제본이 RB-05의 쓰기를 아직 받지 못했다: 건너뛰기는 했지만 확인 전이라 번호를 내지 않는다
  store.blockConfirmForTest(true);
  const b = { preverifyToken: preverifyToken(clock, eventId), deviceId: DEVICE, entryRequestId: newRequest() };
  await expect(go(3, b)).rejects.toMatchObject({ code: 'QUEUE_RECOVERING' });
  expect(store.skippedOf(eventId)).toEqual(['4:53:1']);
  await expect(go(3, b)).rejects.toMatchObject({ code: 'QUEUE_RECOVERING' });
  expect(store.skippedOf(eventId)).toEqual(['4:53:1']);
  // 복제본이 받았다: 다음 진입이 뒤에서 확인을 마치고, 그다음 진입이 건너뛴 구간 뒤 번호와 올라간 세대를 받는다
  store.blockConfirmForTest(false);
  await expect(go(3, b)).rejects.toMatchObject({ code: 'QUEUE_RECOVERING' });
  await enter.confirmsSettled();
  const t = await go(3, b);
  expect(t.kind === 'TICKET' && [t.seq, t.generation]).toEqual([54, 2]);
});

test('[Q-T13] 첫RB05의쓰기를두번째장애전환으로잃는것은_확인전이라그뒤번호가없을때뿐이고_두번째RB05가바탕값만건너뛰어도겹치지않는다(ADR-0186)', async () => {
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
  // 주 노드 B가 올라서 RB-05(4~53)를 했지만 복제 확인 전에 B도 죽었다. 그 사이 번호는 하나도 나가지 않았다
  store.failoverForTest(eventId);
  store.blockConfirmForTest(true);
  await expect(go(3)).rejects.toMatchObject({ code: 'QUEUE_RECOVERING' });
  await expect(go(4)).rejects.toMatchObject({ code: 'QUEUE_RECOVERING' });
  store.rollbackForTest(eventId, before);
  store.failoverForTest(eventId);
  store.blockConfirmForTest(false);
  // 설정 세대가 둘 올랐지만 곱하지 않는다: 바탕 값만 건너뛰어도 잃은 RB-05 뒤에 나간 번호가 없다
  await expect(go(5)).rejects.toMatchObject({ code: 'QUEUE_RECOVERING' });
  await enter.confirmsSettled();
  expect(store.skippedOf(eventId)).toEqual(['4:53:1']);
  const seqs: number[] = [];
  for (let i = 5; i < 8; i++) {
    const t = await go(i);
    if (t.kind === 'TICKET') seqs.push(t.seq);
  }
  expect(seqs).toEqual([54, 55, 56]);
});

test('[Q-T13] 복제확인이끝나지않아도_진입은WAIT를기다리지않고바로503이고_확인은회차마다하나만뒤에서돈다(ADR-0186)', async () => {
  const clock = fakeClock({ now: Date.UTC(2026, 10, 3, 1, 0, 0) });
  const inner = new MemoryEntryStore(clock);
  let confirms = 0;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  // 확인(WAIT)이 끝나지 않는 저장소: 확인 호출만 붙잡는다
  const store = new Proxy(inner, {
    get: (t, k) => {
      if (k === 'confirmRb05') {
        return async (i: { eventId: string }) => {
          confirms++;
          await held;
          return t.confirmRb05(i);
        };
      }
      const v = Reflect.get(t, k) as unknown;
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  const schedules = new MemoryEventSchedules();
  const eventId = newEvent();
  await schedules.set(eventId, openSchedule(clock.now()));
  const enter = new EnterQueue(store, schedules, tokens, clock, { pendingTtlMs: PENDING_TTL_MS, rb05SkipBase: 50 });
  const go = (i: number) =>
    enter.run({ accountId: ACCOUNT, pid: `pid-bg-${i}-${eventId}`.slice(0, 64), eventId, body: { preverifyToken: preverifyToken(clock, eventId), deviceId: DEVICE, entryRequestId: newRequest() } });
  await go(0);
  inner.failoverForTest(eventId);
  // 두 요청 모두 확인을 기다리지 않고 바로 503이다(확인은 아직 붙잡혀 있다)
  await expect(go(1)).rejects.toMatchObject({ code: 'QUEUE_RECOVERING' });
  await expect(go(2)).rejects.toMatchObject({ code: 'QUEUE_RECOVERING' });
  expect(confirms).toBe(1);
  release();
  await enter.confirmsSettled();
  const t = await go(3);
  expect(t.kind === 'TICKET' && [t.seq, t.generation]).toEqual([52, 2]);
});

test('설정세대가여럿올라도_곱하지않고바탕값만건너뛴다(메모리저장소가Lua와같다, ADR-0186)', async () => {
  const clock = fakeClock({ now: Date.UTC(2026, 10, 3, 1, 0, 0) });
  const store = new MemoryEntryStore(clock);
  const eventId = newEvent();
  // 세대 키는 지금 노드(node-1:1)가 썼고, 그 뒤 다섯 번 승격해 설정 세대가 6이 됐다
  store.rollbackForTest(eventId, { seq: 3, skipped: [], epoch: 'node-1:1' });
  for (let i = 0; i < 5; i++) store.failoverForTest();
  const input = { eventId, expireAtMs: clock.now() + 1, skippedExpireAtMs: clock.now() + 1, skipBase: 10, opensAtMs: clock.now() - 1, lobbyShuffle: false, openBatch: false };
  expect(await store.rb05(input)).toEqual({ kind: 'SKIPPED', start: 4, end: 3 + 10, gen: 2 });
  // 건너뛰었고 확인 전이다
  expect(await store.rb05(input)).toEqual({ kind: 'PENDING' });
  expect(await store.confirmRb05({ eventId })).toBe('CONFIRMED');
  expect(await store.rb05(input)).toEqual({ kind: 'DONE' });
});

test('구간은_floor((번호-1)÷1000)이다_구간0이1~1000번', () => {
  expect([1, 1000, 1001, 2000, 2001, 1_000_000].map(segmentOf)).toEqual([0, 0, 1, 1, 2, 999]);
});
