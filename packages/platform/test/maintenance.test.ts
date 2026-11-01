// 정비 반복과 경계 계산(openspec 변경 add-maintenance-control-and-consumers 결정 11·15·16, ADR-0086·0114, data.md §2).
// DB·Redis가 드는 부분은 maintenance.int.test.ts가 본다.
import { Registry } from '@prometheus-io/client';
import { describe, expect, test } from 'vitest';
import {
  MAINTENANCE_DEFAULTS,
  MONTHLY_PARTITION_DEFAULTS,
  MaintenanceRunner,
  addKstMonths,
  compareStreamIds,
  fakeClock,
  kstMonthStart,
  monthlyPartitionOf,
  nextStreamId,
  uuidLowerBound,
  type MaintenanceTask,
} from '../src/index.js';

const KST = (iso: string) => Date.parse(`${iso}+09:00`);

describe('ADR0086 월 파티션 경계(KST)', () => {
  test('그달 1일 0시(KST)와 달 더하기', () => {
    expect(kstMonthStart(KST('2026-11-30T23:59:59.999'))).toBe(KST('2026-11-01T00:00:00'));
    // 한국 시각으로는 12월 1일 0시 5분이다
    expect(kstMonthStart(Date.parse('2026-11-30T15:05:00Z'))).toBe(KST('2026-12-01T00:00:00'));
    expect(addKstMonths(KST('2026-11-01T00:00:00'), 2)).toBe(KST('2027-01-01T00:00:00'));
    expect(MONTHLY_PARTITION_DEFAULTS).toEqual({ monthsAhead: 3, minAheadMonths: 2 });
  });

  test('UUIDv7 열은 그달 밀리초의 아래 경계 UUID, timestamptz 열은 +09:00 시각이다', () => {
    const m = KST('2026-11-01T00:00:00');
    const u = monthlyPartitionOf({ table: 'scan_event', key: 'uuidv7' }, m);
    expect(u.name).toBe('scan_event_p202611');
    expect(u).toMatchObject({ name: 'scan_event_p202611', from: uuidLowerBound(m), to: uuidLowerBound(KST('2026-12-01T00:00:00')) });
    const t = monthlyPartitionOf({ table: 'notification_delivery', key: 'timestamptz' }, m);
    expect(t).toMatchObject({ name: 'notification_delivery_p202611', from: '2026-11-01T00:00:00+09:00', to: '2026-12-01T00:00:00+09:00' });
    expect(() => monthlyPartitionOf({ table: 'Bad-Name', key: 'uuidv7' }, m)).toThrow();
    expect(() => monthlyPartitionOf({ table: 'scan_event', key: 'uuidv7' }, m + 1)).toThrow();
  });
});

describe('ADR0070 Redis Stream ID', () => {
  test('다음 ID와 비교', () => {
    expect(nextStreamId('1700000000000-0')).toBe('1700000000000-1');
    expect(nextStreamId('1700000000000-41')).toBe('1700000000000-42');
    expect(compareStreamIds('1-10', '1-9')).toBe(1);
    expect(compareStreamIds('2-0', '10-0')).toBe(-1);
    expect(compareStreamIds('5-5', '5-5')).toBe(0);
  });
});

function harness(tasks: MaintenanceTask[], o: { leader?: () => boolean; at?: string } = {}) {
  const clock = fakeClock({ now: KST(o.at ?? '2026-11-02T03:00:00') });
  const registry = new Registry();
  const runner = new MaintenanceRunner({ service: 'purchase-svc', clock, leader: { isLeader: o.leader ?? (() => true) }, tasks, registry });
  return { clock, runner, metrics: () => registry.metrics() };
}

describe('결정16 정비 반복', () => {
  test('리더가 아니면 아무 일도 하지 않는다', async () => {
    let runs = 0;
    const h = harness([{ name: 'snapshot', when: 'daily', run: async () => void runs++ }], { leader: () => false });
    expect((await h.runner.tick()).ran).toEqual([]);
    expect(runs).toBe(0);
    expect(MAINTENANCE_DEFAULTS.everyMs).toBe(600_000);
  });

  test('매일 일은 한국 시각 하루에 한 번 성공할 때까지, 정비 시간 일은 04:00~06:00 안에서만 한다', async () => {
    const log: string[] = [];
    let failOnce = true;
    const h = harness([
      { name: 'ensure', when: 'daily', run: async () => void log.push('ensure') },
      {
        name: 'drop',
        when: 'window',
        run: async () => {
          log.push('drop');
          if (failOnce) {
            failOnce = false;
            throw new Error('잠금 기다림 초과');
          }
        },
      },
    ]);
    // 03:00: 매일 일만
    expect((await h.runner.tick()).ran).toEqual(['ensure']);
    h.clock.advance(10 * 60_000);
    expect((await h.runner.tick()).ran).toEqual([]); // 오늘 이미 성공
    h.clock.advance(60 * 60_000); // 04:10
    const t = await h.runner.tick();
    expect(t.ran).toEqual([]);
    expect(t.failed).toEqual(['drop']);
    h.clock.advance(10 * 60_000); // 04:20 실패 뒤 다시
    expect((await h.runner.tick()).ran).toEqual(['drop']);
    h.clock.advance(10 * 60_000);
    expect((await h.runner.tick()).ran).toEqual([]);
    h.clock.advance(20 * 60 * 60_000); // 다음 날 00:30
    expect((await h.runner.tick()).ran).toEqual(['ensure']);
    expect(log).toEqual(['ensure', 'drop', 'drop', 'ensure']);
    const m = await h.metrics();
    expect(m).toContain('maintenance_task_failures_total{service="purchase-svc",task="drop"} 1');
    expect(m).toMatch(/maintenance_task_last_success_timestamp_seconds\{service="purchase-svc",task="ensure"\} \d+/);
  });

  test('한 일이 실패해도 다른 일은 한다', async () => {
    const h = harness(
      [
        { name: 'a', when: 'daily', run: async () => Promise.reject(new Error('x')) },
        { name: 'b', when: 'daily', run: async () => undefined },
      ],
      { at: '2026-11-02T04:30:00' },
    );
    const t = await h.runner.tick();
    expect(t).toEqual({ ran: ['b'], failed: ['a'] });
  });
});
