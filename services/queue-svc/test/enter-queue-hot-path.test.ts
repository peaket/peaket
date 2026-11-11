// 진입 핫패스 구간 진단(BAT-027, HOT-462, docs/observability.md §3·§8).
// 메모리 저장소로 한 번 진입하고, 같은 사람이 다시 진입해 거절되는 결과까지 지표에 남는지 본다.
import { fakeClock, HotPathMetrics, PlatformMetrics } from '@peaket/platform';
import { expect, test } from 'vitest';
import { MemoryEntryStore, MemoryEventSchedules } from '../src/modules/entry/adapters/memory-entry-store.js';
import { EnterQueue } from '../src/modules/entry/application/enter-queue.js';
import { ACCOUNT, DEVICE, newEvent, newRequest, openSchedule, PID, preverifyToken, tokens } from './support.js';

test('BAT027_ 진입 성공과 거절을 outcome으로 세고 preempt·number·record 구간을 남긴다', async () => {
  const clock = fakeClock({ now: Date.UTC(2026, 10, 3, 1, 0, 0) });
  const store = new MemoryEntryStore(clock);
  const schedules = new MemoryEventSchedules();
  const eventId = newEvent();
  await schedules.set(eventId, openSchedule(clock.now()));
  const registry = new PlatformMetrics('queue-svc').registry;
  const hotPath = new HotPathMetrics('queue-svc').register(registry);
  const enter = new EnterQueue(store, schedules, tokens, clock, { pendingTtlMs: 10_000 }, undefined, undefined, undefined, undefined, undefined, undefined, hotPath);
  const input = () => ({
    accountId: ACCOUNT,
    pid: PID,
    eventId,
    body: { preverifyToken: preverifyToken(clock, eventId), deviceId: DEVICE, entryRequestId: newRequest() },
  });

  const first = await enter.run(input());
  expect(first.kind).toBe('TICKET');
  await expect(enter.run(input())).rejects.toMatchObject({ code: 'ALREADY_WAITING' });

  const text = await registry.metrics();
  expect(text).toContain('hot_path_outcomes_total{service="queue-svc",outcome="ticket"} 1');
  expect(text).toContain('hot_path_outcomes_total{service="queue-svc",outcome="already_waiting"} 1');
  expect(text).toContain('hot_path_stage_seconds_count{service="queue-svc",stage="queue.entry.total"} 2');
  expect(text).toContain('hot_path_stage_seconds_count{service="queue-svc",stage="queue.entry.preempt"} 2');
  expect(text).toContain('hot_path_stage_seconds_count{service="queue-svc",stage="queue.entry.number"} 1');
  expect(text).toContain('hot_path_stage_seconds_count{service="queue-svc",stage="queue.entry.record"} 1');
  expect(text).not.toContain(eventId);
  expect(text).not.toContain(ACCOUNT);
  expect(text).not.toContain(PID);
});
