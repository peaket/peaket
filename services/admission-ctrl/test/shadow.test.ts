// F-09-11(OPS-440) admission-ctrl 그림자 계산 시험.
// 정본: docs/devops.md §6.3(그림자 계산: Lease에 참여하지 않고 같은 입력으로 목표를 계산만 하고 차이를 admission_shadow_diff로 남긴다).
// 실행: pnpm --filter @peaket/admission-ctrl test test/shadow.test.ts
// 이 시험은 클러스터 없이 가짜 저장소로 본다. 실제 읽기 전용 Redis ACL·그림자 트래픽은 미실행이다.
import { fakeClock } from '@peaket/platform';
import { expect, test } from 'vitest';
import { AdmissionLeader } from '../src/modules/leader/application/admission-leader.js';
import { ALL_JOURNEYS, type EventInputs, type Reading } from '../src/modules/leader/domain/aimd.js';
import type { ControlInputsReader, EventPlan, LeaderStore } from '../src/modules/leader/domain/ports.js';

const T0 = Date.UTC(2026, 10, 3, 3, 0, 0);
const DAY = 86_400_000;
const ok = (value: number, atMs: number): Reading => ({ ok: true, value, atMs });
const healthy = (atMs: number): EventInputs => {
  const budget = new Map<string, Reading>();
  for (const j of ALL_JOURNEYS) for (const k of ['alert', 'burn50']) budget.set(`${j}:${k}`, ok(0, atMs));
  return { latency: ok(0.02, atMs), errors: ok(0, atMs), seatStore: ok(0, atMs), budget, pgCause: false };
};

test('OPS-440 ⑥ 그림자 계산은 쓰기 없이 목표 차이를 admission_shadow_diff로 남긴다', async () => {
  const clock = fakeClock({ now: T0 });
  const plan: EventPlan = { opensAtMs: T0 - 10_000, startsAtMs: T0 + DAY, lobbyShuffle: false, openBatch: true };
  const writes: string[] = [];
  let targetNow: string | undefined;
  const store: LeaderStore = {
    activeEvents: async () => ['e1'],
    schedule: async () => plan,
    control: async () => ({ paused: false, ...(targetNow === undefined ? {} : { memory: { targetNow } }) }),
    platformControl: async () => ({ autoStopped: false }),
    bump: async () => {
      writes.push('bump');
      return 'OK' as const;
    },
    tick: async () => {
      writes.push('tick');
      return { kind: 'FENCED' as const };
    },
    close: async () => {
      writes.push('close');
      return 'NONE' as const;
    },
    rb05: async () => {
      writes.push('rb05');
      return { kind: 'DONE' as const };
    },
    confirmRb05: async () => {
      writes.push('confirm');
      return 'NONE' as const;
    },
    closeArrivalSlots: async () => {
      writes.push('arrival');
      return { kind: 'NONE' as const, slots: 0, returned: 0 };
    },
  };
  const reader: ControlInputsReader = { read: async () => ({ forEvent: () => healthy(T0) }) };
  const seen: { event?: string; diff?: number; target?: number } = {};
  const metrics = {
    shadow: (eventId: string, diff: number, target: number) => {
      seen.event = eventId;
      seen.diff = diff;
      seen.target = target;
    },
    loop: () => undefined,
    leader: () => undefined,
    fenced: () => undefined,
    leaseFailure: () => undefined,
    event: () => undefined,
    control: () => undefined,
    openGaps: () => undefined,
    publish: () => undefined,
    seedReveal: () => undefined,
    beaconStopped: () => undefined,
    forget: () => undefined,
  };
  const leader = new AdmissionLeader(store, { run: async () => ({ status: 'PUBLISHED' }) }, { generation: () => undefined }, clock, undefined, metrics as never, reader);
  const shadowTick = (leader as unknown as { shadowTick?: () => Promise<void> }).shadowTick;
  expect(typeof shadowTick, 'AdmissionLeader.shadowTick이 없다').toBe('function');

  // 리더가 아직 목표를 남기지 않았으면 지표를 내지 않는다
  await shadowTick!.call(leader);
  expect(seen.diff).toBeUndefined();
  expect(writes).toEqual([]);

  // 리더 목표 0과 그림자 목표의 차이를 절댓값으로 낸다
  targetNow = '0';
  await shadowTick!.call(leader);
  expect(seen.event).toBe('e1');
  expect(seen.target).toBeGreaterThan(0);
  expect(seen.diff).toBe(seen.target);
  expect(writes).toEqual([]);

  // 같은 목표면 차이 0
  targetNow = String(seen.target);
  await shadowTick!.call(leader);
  expect(seen.diff).toBe(0);
  expect(writes).toEqual([]);
});
