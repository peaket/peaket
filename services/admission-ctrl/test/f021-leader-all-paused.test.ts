// F-02-1(OPS-300) 리더 루프의 전체 범위 판매 일시정지(B11): q:{admission}:ctl의 allPaused가 '1'이면 모든 회차의 serving 전진이 0이다
// (ADR-0365 결정 6 '리더는 allPaused가 1이면 모든 회차의 serving 전진을 0으로 둔다', queue-admission.md 446행 일시정지).
// 저장소 포트(LeaderStore)는 짝 가짜(타입으로 묶은 객체)이고 리더 루프(AdmissionLeader)는 진짜다. 전체 정지 읽기는 platformControl()의
// allPaused 칸이다(F-02-1 계획 14절 1: autoStopped와 같은 캐시 주기). 저장소 Lua의 뜻은 test-int/f021-leader-control.int.test.ts가 본다.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { AdmissionLeader } from '../src/modules/leader/index.js';
import type { Control, EventPlan, LeaderStore, TickInput, TickResult } from '../src/modules/leader/domain/ports.js';

const T0 = Date.UTC(2026, 10, 23, 3, 0, 0);
const DAY = 86_400_000;
const OK: TickResult = { kind: 'OK', serving: 0, advanced: 0, slots: 0, soon: 0, inFlight: 0, waiting: 0, dropped: 0, lobbyMarked: 1, batchMarked: 1, batchPublished: 1, repair: 0, ratio: 1, saleState: 'ON_SALE' };

function world(o: { allPaused: boolean; ctl?: Control }) {
  const clock = fakeClock({ now: T0 });
  const ticks: TickInput[] = [];
  const plan: EventPlan = { opensAtMs: T0 - 10_000, startsAtMs: T0 + 3 * DAY, lobbyShuffle: false, openBatch: true };
  const store: LeaderStore = {
    activeEvents: async () => ['e1', 'e2'],
    schedule: async () => plan,
    control: async () => o.ctl ?? { paused: false },
    platformControl: async () => ({ autoStopped: false, allPaused: o.allPaused }),
    bump: async () => 'OK',
    tick: async (i) => {
      ticks.push(i);
      return OK;
    },
    close: async () => 'OK',
    closeArrivalSlots: async () => ({ kind: 'NONE', slots: 0, returned: 0 }),
    rb05: async () => ({ kind: 'DONE' }),
    confirmRb05: async () => 'CONFIRMED',
  };
  const publish = { run: async () => ({ status: 'PUBLISHED' }) };
  const elector = { generation: () => 4 };
  return { ticks, leader: new AdmissionLeader(store, publish, elector, clock), clock };
}

describe('F021-LDR 리더 루프의 전체 범위 판매 일시정지 (B11)', () => {
  test('F021-LDR ① allPaused가 참이면 회차 범위 paused가 거짓이어도 모든 회차의 이번 주기 최대 전진이 0이다', async () => {
    const w = world({ allPaused: true });
    await w.leader.tick();
    expect(w.ticks.map((t) => ({ eventId: t.eventId, maxAdvance: t.maxAdvance }))).toEqual([
      { eventId: 'e1', maxAdvance: 0 },
      { eventId: 'e2', maxAdvance: 0 },
    ]);
  });

  test('F021-LDR ② allPaused가 거짓이면 같은 회차가 전진한다(전체 정지만이 0을 만든다는 대조)', async () => {
    const w = world({ allPaused: false });
    await w.leader.tick();
    expect(w.ticks).toHaveLength(2);
    for (const t of w.ticks) expect(t.maxAdvance, t.eventId).toBeGreaterThan(0);
  });
});
