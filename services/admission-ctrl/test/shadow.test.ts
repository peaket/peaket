// F-09-11(OPS-440) admission-ctrl 그림자 계산 시험.
// 정본: docs/devops.md §6.3(그림자 계산: Lease에 참여하지 않고 같은 입력으로 목표를 계산만 하고 차이를 admission_shadow_diff로 남긴다).
// 실행: pnpm --filter @peaket/admission-ctrl test test/shadow.test.ts
// 이 시험은 클러스터 없이 가짜 저장소·가짜 Redis로 본다. 실제 읽기 전용 Redis ACL·그림자 트래픽은 미실행이다.
import { fakeClock, PlatformMetrics } from '@peaket/platform';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import * as startModule from '../src/start.js';
import { RedisLeaderStore } from '../src/modules/leader/adapters/redis-leader-store.js';
import { AdmissionLeader } from '../src/modules/leader/application/admission-leader.js';
import { LeaderMetrics } from '../src/modules/leader/application/leader-metrics.js';
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

/** Prometheus 텍스트에서 이름표가 붙은 게이지 값을 읽는다 */
function valueOf(text: string, name: string, labels: string): number {
  const m = new RegExp(`^${name}\\{[^}]*${labels}[^}]*\\} (\\S+)$`, 'm').exec(text);
  return m ? Number(m[1]) : Number.NaN;
}

test('OPS-440 ⑥ 그림자 계산은 쓰기 없이 목표 차이를 admission_shadow_diff로 남긴다', async () => {
  // 1) start.ts 분기: 그림자면 선출·리더 루프·제어 gRPC·RB-35·묶음 결과 폴더를 켜지 않는다(RV0911-02)
  const planOf = (startModule as unknown as { startPlanOf?: (env: Record<string, string | undefined>) => Record<string, boolean> }).startPlanOf;
  expect(typeof planOf, 'start.ts의 startPlanOf가 없다').toBe('function');
  expect(planOf!({})).toMatchObject({ elector: true, leader: true, control: true, rb35: true, batch: true, shadow: false });
  expect(planOf!({ PEAKET_ADMISSION_SHADOW: '1' })).toMatchObject({ elector: false, leader: false, control: false, rb35: false, batch: false, shadow: true });
  expect(planOf!({ PEAKET_ADMISSION_SHADOW: '0' }).shadow).toBe(false);
  // start()가 계획을 실제로 쓰는지: 결과 폴더·선출·리더·제어 gRPC·RB-35를 plan으로 가른다(RV0911-02)
  const startSource = readFileSync(new URL('../src/start.ts', import.meta.url), 'utf8');
  expect(startSource).toContain('startPlanOf(env)');
  for (const key of ['elector', 'leader', 'control', 'rb35', 'batch']) {
    expect(startSource, `start()가 plan.${key}를 쓰지 않는다`).toMatch(new RegExp(`plan\\.${key}\\b`));
  }
  expect(startSource).toMatch(/if \(plan\.leader\)[\s\S]{0,300}leader\.start\(\)/);
  expect(startSource).toMatch(/else[\s\S]{0,160}startShadow\(\)/);

  // 2) 그림자가 읽는 activeEvents는 쓰기(만료 정리)를 하지 않는다(RV0911-01)
  const commands: string[] = [];
  const fakeRedis = {
    command: async (a: string[]) => {
      commands.push(a[0]!);
      return a[0] === 'ZRANGE' || a[0] === 'ZRANGEBYSCORE' ? ['e1'] : 0;
    },
    evalScript: async () => [],
    sendCommand: async () => null,
    close: async () => {},
  };
  const realStore = new RedisLeaderStore(fakeRedis as never);
  expect(await realStore.activeEvents(T0)).toEqual(['e1']);
  expect(commands).not.toContain('ZREMRANGEBYSCORE');
  expect(commands.every((c) => c === 'ZRANGE' || c === 'ZRANGEBYSCORE'), `읽기 명령만: ${commands.join(',')}`).toBe(true);

  // 3) LeaderMetrics가 두 지표를 등록하고 차이는 절댓값으로 낸다(RV0911-04)
  const platform = new PlatformMetrics('shadow-test');
  const metrics = new LeaderMetrics().register(platform.registry);
  const shadowMetric = (metrics as unknown as { shadow?: (eventId: string, diff: number, target: number) => void }).shadow;
  expect(typeof shadowMetric, 'LeaderMetrics.shadow가 없다').toBe('function');
  shadowMetric!.call(metrics, 'm1', -5, 9);
  const metricText = await platform.registry.metrics();
  expect(valueOf(metricText, 'admission_shadow_diff', 'event_id="m1"')).toBe(5);
  expect(valueOf(metricText, 'admission_shadow_target', 'event_id="m1"')).toBe(9);

  // 4) shadowTick은 쓰기 없이 리더의 aimdTarget과 그림자 목표를 비교한다(RV0911-03)
  const clock = fakeClock({ now: T0 });
  const plan: EventPlan = { opensAtMs: T0 - 10_000, startsAtMs: T0 + DAY, lobbyShuffle: false, openBatch: true };
  const writes: string[] = [];
  let aimdTarget: string | undefined;
  const store: LeaderStore = {
    activeEvents: async () => ['e1'],
    schedule: async () => plan,
    // 실제 Control은 MEMORY_FIELDS(aimdTarget)를 싣고 targetNow는 싣지 않는다. targetNow를 넣어 무시하는지도 본다
    control: async () => ({ paused: false, ...(aimdTarget === undefined ? {} : { memory: { aimdTarget, targetNow: '999' } }) }),
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
  const leader = new AdmissionLeader(store, { run: async () => ({ status: 'PUBLISHED' }) }, { generation: () => undefined }, clock, undefined, metrics as never, reader);
  const shadowTick = (leader as unknown as { shadowTick?: () => Promise<void> }).shadowTick;
  expect(typeof shadowTick, 'AdmissionLeader.shadowTick이 없다').toBe('function');

  // 리더가 아직 목표를 남기지 않았으면 지표를 내지 않는다
  await shadowTick!.call(leader);
  expect(valueOf(await platform.registry.metrics(), 'admission_shadow_diff', 'event_id="e1"')).toBeNaN();
  expect(writes).toEqual([]);

  // 리더 목표(aimdTarget)와 그림자 목표의 차이를 절댓값으로 낸다. targetNow(999)는 비교에 쓰지 않는다
  aimdTarget = '0';
  await shadowTick!.call(leader);
  const firstText = await platform.registry.metrics();
  const target = valueOf(firstText, 'admission_shadow_target', 'event_id="e1"');
  const diff = valueOf(firstText, 'admission_shadow_diff', 'event_id="e1"');
  expect(target).toBeGreaterThan(0);
  expect(diff).toBe(target);
  expect(diff).not.toBe(Math.abs(target - 999));
  expect(writes).toEqual([]);

  // 리더 목표가 그림자 목표보다 크면 음수 차이가 나지만 지표는 절댓값이다
  aimdTarget = String(target + 5);
  await shadowTick!.call(leader);
  expect(valueOf(await platform.registry.metrics(), 'admission_shadow_diff', 'event_id="e1"')).toBe(5);
  expect(writes).toEqual([]);

  // 같은 목표면 차이 0
  aimdTarget = String(target);
  await shadowTick!.call(leader);
  expect(valueOf(await platform.registry.metrics(), 'admission_shadow_diff', 'event_id="e1"')).toBe(0);
  expect(writes).toEqual([]);
});
