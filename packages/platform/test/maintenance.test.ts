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
  deleteExpiredIdempotencyRecords,
  deleteExpiredRows,
  type Database,
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
  test('HOT153_리뷰 고침 H1: 일이 도는 동안 리더를 잃으면 멈춤 신호를 주고 성공으로 적지 않는다', async () => {
    let leader = true;
    let seen: AbortSignal | undefined;
    const task: MaintenanceTask = {
      name: 'long',
      when: 'daily',
      run: (signal) =>
        new Promise((resolve) => {
          seen = signal;
          signal?.addEventListener('abort', () => resolve('stopped'));
          setTimeout(() => (leader = false), 5);
        }),
    };
    const clock = fakeClock({ now: KST('2026-11-02T03:00:00') });
    const registry = new Registry();
    const runner = new MaintenanceRunner({ service: 'purchase-svc', clock, leader: { isLeader: () => leader }, tasks: [task], registry, leaderPollMs: 2 });
    expect(await runner.tick()).toEqual({ ran: [], failed: [] });
    expect(seen?.aborted).toBe(true);
    expect(await registry.metrics()).not.toContain('maintenance_task_last_success_timestamp_seconds{service="purchase-svc",task="long"}');
  });

  test('HOT153_일이 deferred로 돌아오면 성공으로 적지도 실패로 세지도 않고 같은 날 다시 깨어난다(시간 규칙으로 미룬 정비 일)', async () => {
    let runs = 0;
    const h = harness([{ name: 'recon', when: 'daily', run: async () => (runs += 1, { deferred: true as const }) }]);
    expect(await h.runner.tick()).toEqual({ ran: [], failed: [] });
    expect(await h.runner.tick()).toEqual({ ran: [], failed: [] });
    expect(runs).toBe(2);
    const text = await h.metrics();
    expect(text).not.toContain('maintenance_task_last_success_timestamp_seconds{service="purchase-svc",task="recon"}');
    expect(text).not.toContain('maintenance_task_failures_total{service="purchase-svc",task="recon"}');
  });

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

describe('FND110 리더가 되면 정비를 바로 깨운다', () => {
  test('FND110_wake는_쉬는반복을바로깨우고_도는중이면_끝난뒤한번더돈다', async () => {
    let leader = false;
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let first = true;
    const h = harness(
      [
        {
          name: 'snapshot',
          when: 'daily',
          run: async () => {
            order.push('run');
            if (first) {
              first = false;
              await held;
            }
          },
        },
        { name: 'other', when: 'daily', run: async () => void order.push('other') },
      ],
      { leader: () => leader },
    );
    h.runner.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]); // 시작 때는 리더가 아니었다. 10분을 쉰다
    leader = true;
    h.runner.wake();
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['run']); // 쉬던 반복이 바로 깨어났다
    h.runner.wake(); // 도는 중에 깨우면 끝난 뒤 한 번 더 돈다(겹쳐 돌지 않는다)
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['run', 'other']);
    await h.runner.stop();
  });
});

describe('FND110 끝낼 때 정비 일을 멈춘다', () => {
  test('FND110_stop은_도는일에멈춤신호를주고_남은일은돌지않으며_성공으로적지않는다', async () => {
    const order: string[] = [];
    let seen: AbortSignal | undefined;
    const h = harness([
      {
        name: 'long',
        when: 'daily',
        run: (signal) =>
          new Promise<void>((resolve) => {
            seen = signal;
            order.push('long');
            signal?.addEventListener('abort', () => resolve());
          }),
      },
      { name: 'next', when: 'daily', run: async () => void order.push('next') },
    ]);
    h.runner.start();
    await new Promise((r) => setTimeout(r, 20));
    await h.runner.stop();
    expect(seen?.aborted).toBe(true);
    expect(order).toEqual(['long']);
    expect(await h.metrics()).not.toMatch(/maintenance_task_last_success_timestamp_seconds\{[^}]*task="long"/);
  });

  test('FND110_stop의한도를넘기면_일이끝나지않아도돌아온다', async () => {
    const h = harness([{ name: 'stuck', when: 'daily', run: () => new Promise<void>(() => {}) }]);
    h.runner.start();
    await new Promise((r) => setTimeout(r, 20));
    const t0 = Date.now();
    await h.runner.stop({ timeoutMs: 100 });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  test('FND110_멱등기록지우기는_멈춤신호를받으면_다음묶음을시작하지않는다', async () => {
    const ctl = new AbortController();
    let batches = 0;
    const db = { db: { execute: async () => { batches += 1; if (batches === 2) ctl.abort(); return { rowCount: 10 }; } } };
    const n = await deleteExpiredIdempotencyRecords(db, { clock: fakeClock(), batchSize: 10, signal: ctl.signal });
    expect(batches).toBe(2);
    expect(n).toBe(20);
  });

  test('FND110_보존지우기는_멈춤신호를받으면_aborted로멈춘다', async () => {
    const ctl = new AbortController();
    let batches = 0;
    const ids = Array.from({ length: 5 }, (_, i) => ({ id: `00000000-0000-7000-8000-00000000000${i}` }));
    const database = {
      // 트랜잭션마다 첫 질의가 지울 ID 고르기다(그다음은 지우기)
      transaction: async (fn: (tx: unknown) => Promise<number>) => {
        let calls = 0;
        return fn({ execute: async () => (calls++ === 0 ? { rows: ids } : { rows: [] }) }).then((n) => {
          batches += 1;
          if (batches === 1) ctl.abort();
          return n;
        });
      },
    } as unknown as Database;
    const r = await deleteExpiredRows(database, fakeClock({ now: KST('2026-11-02T04:30:00') }), { table: 'audit_log', retentionMs: 1 }, { batchSize: 5, pauseMs: 0, signal: ctl.signal });
    expect(r).toMatchObject({ stopped: 'aborted', batches: 1, deleted: 5 });
  });
});
