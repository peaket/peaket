// 매일 주문 상태·이력 검사의 정비 일 orderHistoryCheckTask(BUILD_ORDER PRF-160, ADR-0113 결정 2, docs/features/payment.md §3 '주문 저장소의 첫 구현',
// docs/observability.md '주문 상태와 상태 이력이 어긋나지 않는다'). DB 검사(checkOrderHistory)는 가짜 check로 바꿔 끼우고, 실제 PostgreSQL 검사는 통합 시험이 본다.
// 정비 일 모양은 packages/platform MaintenanceTask(name·when·run(signal)), 한국 시각 날은 kstDayStart다.
// run이 던지면 정비 실행기(MaintenanceRunner)가 실패로 세고 다음 깨어남에 다시 한다.
import { type Database, fakeClock, kstDayStart } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import {
  ORDER_HISTORY_TASK,
  type OrderHistoryMismatch,
  type OrderHistoryReport,
  type OrderHistoryTaskDeps,
  orderHistoryCheckTask,
  type OrderSignals,
} from '../src/modules/booking/index.js';

const DAY = 24 * 60 * 60 * 1000;
const ORDER_1 = '0190f3a1-7c2e-7a00-8000-0000000000d1';
const ORDER_2 = '0190f3a1-7c2e-7a00-8000-0000000000d2';

type CheckArgs = Parameters<NonNullable<OrderHistoryTaskDeps['check']>>[1];

/** 가짜 DB(검사는 가짜 check가 하므로 쓰지 않는다. 같은 객체를 넘기는지만 본다) */
const DATABASE = { fake: 'purchase-db' } as unknown as Database;

interface World {
  deps: OrderHistoryTaskDeps;
  calls: { database: Database; o: CheckArgs }[];
  mismatchCounts: number[];
  warns: { o: object; msg?: string }[];
  clock: ReturnType<typeof fakeClock>;
}

function world(o: { now: string; report?: OrderHistoryReport; fail?: unknown; batchSize?: number }): World {
  const calls: World['calls'] = [];
  const mismatchCounts: number[] = [];
  const warns: World['warns'] = [];
  const clock = fakeClock({ now: Date.parse(o.now) });
  const signals: OrderSignals = { historyMismatch: (n) => void mismatchCounts.push(n) };
  const deps: OrderHistoryTaskDeps = {
    database: DATABASE,
    clock,
    signals,
    logger: { warn: (obj, msg) => void warns.push({ o: obj, msg }) },
    check: async (database, args) => {
      calls.push({ database, o: args });
      if (o.fail !== undefined) throw o.fail;
      return o.report ?? { checked: 0, mismatched: [] };
    },
  };
  if (o.batchSize !== undefined) deps.batchSize = o.batchSize;
  return { deps, calls, mismatchCounts, warns, clock };
}

const mismatch = (orderId: string, over: Partial<OrderHistoryMismatch> = {}): OrderHistoryMismatch => ({
  orderId,
  status: 'CONFIRMED',
  eventSeq: 6,
  lastSeq: 5,
  rows: 5,
  lastTo: 'APPROVED',
  ...over,
});

describe('orderHistoryCheckTask: 정비 일 모양', () => {
  test('ADR0113_이름은 order-history-check, 정비 시간(04:00~06:00 KST) 안에서 하루 한 번(window)이다', () => {
    expect(ORDER_HISTORY_TASK).toBe('order-history-check');
    const task = orderHistoryCheckTask(world({ now: '2026-11-05T15:30:00.000Z' }).deps);
    expect(task.name).toBe('order-history-check');
    expect(task.when).toBe('window');
    expect(typeof task.run).toBe('function');
  });
});

describe('orderHistoryCheckTask.run: 어제(한국 시각) 범위로 검사한다', () => {
  test.each([
    // UTC 15:30 = 한국 시각 다음 날 00:30 → 어제는 한국 시각 11-05 하루
    ['2026-11-05T15:30:00.000Z', '2026-11-04T15:00:00.000Z', '2026-11-05T15:00:00.000Z'],
    // UTC 14:59:59.999 = 한국 시각 같은 날 23:59:59.999 → 어제는 한국 시각 11-04 하루
    ['2026-11-05T14:59:59.999Z', '2026-11-03T15:00:00.000Z', '2026-11-04T15:00:00.000Z'],
    // 한국 시각 0시 정각(UTC 15:00)은 새 날이다
    ['2026-11-05T15:00:00.000Z', '2026-11-04T15:00:00.000Z', '2026-11-05T15:00:00.000Z'],
    // 달이 바뀌는 날(한국 시각 12-01 09:00 → 어제는 11-30)
    ['2026-12-01T00:00:00.000Z', '2026-11-29T15:00:00.000Z', '2026-11-30T15:00:00.000Z'],
  ])('ADR0113_지금 %s이면 check를 [%s, %s) 범위로 한 번 부른다(어제 한국 시각 0시 ~ 오늘 0시)', async (now, from, to) => {
    const w = world({ now });
    await orderHistoryCheckTask(w.deps).run();
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.database).toBe(DATABASE);
    expect({ fromMs: w.calls[0]!.o.fromMs, toMs: w.calls[0]!.o.toMs }).toEqual({ fromMs: Date.parse(from), toMs: Date.parse(to) });
    // platform kstDayStart와 같은 경계다
    expect(w.calls[0]!.o.toMs).toBe(kstDayStart(Date.parse(now)));
    expect(w.calls[0]!.o.fromMs).toBe(kstDayStart(Date.parse(now)) - DAY);
  });

  test('ADR0113_시각은 run 때 시계에서 읽는다(정비 일을 한 번 만들어 날마다 돌리면 날마다 다른 범위다)', async () => {
    const w = world({ now: '2026-11-05T15:30:00.000Z' });
    const task = orderHistoryCheckTask(w.deps);
    await task.run();
    w.clock.advance(DAY);
    await task.run();
    expect(w.calls.map((c) => [c.o.fromMs, c.o.toMs])).toEqual([
      [Date.parse('2026-11-04T15:00:00.000Z'), Date.parse('2026-11-05T15:00:00.000Z')],
      [Date.parse('2026-11-05T15:00:00.000Z'), Date.parse('2026-11-06T15:00:00.000Z')],
    ]);
  });

  test('ADR0113_준 batchSize를 check에 넘긴다', async () => {
    const w = world({ now: '2026-11-05T15:30:00.000Z', batchSize: 250 });
    await orderHistoryCheckTask(w.deps).run();
    expect(w.calls[0]!.o.batchSize).toBe(250);
  });

  test('ADR0113_batchSize를 주지 않으면 기본(1,000 [가정])이다: 1000을 넘기거나 비워 checkOrderHistory의 기본을 쓴다', async () => {
    // 정본 모호: 정비 일이 기본 1,000을 직접 넘기는지, 비워서 checkOrderHistory의 기본(1,000)에 맡기는지 정하지 않았다. 둘 다 받는다
    const w = world({ now: '2026-11-05T15:30:00.000Z' });
    await orderHistoryCheckTask(w.deps).run();
    expect([undefined, 1000]).toContain(w.calls[0]!.o.batchSize);
  });

  test('ADR0113_run(signal)의 signal을 check에 그대로 넘긴다(signal 없이 부르면 없다)', async () => {
    const w = world({ now: '2026-11-05T15:30:00.000Z' });
    const task = orderHistoryCheckTask(w.deps);
    const stop = new AbortController();
    await task.run(stop.signal);
    await task.run();
    expect(w.calls[0]!.o.signal).toBe(stop.signal);
    expect(w.calls[1]!.o.signal).toBeUndefined();
  });
});

describe('orderHistoryCheckTask.run: 결과를 지표와 정비 로그로 낸다', () => {
  test('ADR0113_어긋난 주문 수로 signals.historyMismatch를 한 번 부르고, 어긋난 주문마다 logger.warn을 한 번 부른다(kind order-history, 주문 ID)', async () => {
    const report: OrderHistoryReport = { checked: 1_234, mismatched: [mismatch(ORDER_1), mismatch(ORDER_2, { status: 'FAILED', lastTo: 'RESERVED', eventSeq: 3, lastSeq: 3, rows: 3 })] };
    const w = world({ now: '2026-11-05T15:30:00.000Z', report });
    await orderHistoryCheckTask(w.deps).run();
    expect(w.mismatchCounts).toEqual([2]);
    expect(w.warns).toHaveLength(2);
    expect(w.warns.map((x) => x.o)).toEqual([
      expect.objectContaining({ kind: 'order-history', orderId: ORDER_1 }),
      expect.objectContaining({ kind: 'order-history', orderId: ORDER_2 }),
    ]);
  });

  test('ADR0113_어긋난 주문이 없어도 historyMismatch(0)을 부르고(지난 경보를 내린다) 경고 로그는 남기지 않는다', async () => {
    const w = world({ now: '2026-11-05T15:30:00.000Z', report: { checked: 300_000, mismatched: [] } });
    await orderHistoryCheckTask(w.deps).run();
    expect(w.mismatchCounts).toEqual([0]);
    expect(w.warns).toEqual([]);
  });

  test('ADR0113_검사 도중 signal이 끊겨 일부만 본 보고면(run 뒤 signal.aborted) historyMismatch·경고 로그를 부르지 않는다(지난 값을 덮지 않고, 정비 실행기가 다시 돌린다)', async () => {
    const stop = new AbortController();
    const w = world({ now: '2026-11-05T15:30:00.000Z' });
    const report: OrderHistoryReport = { checked: 2, mismatched: [mismatch(ORDER_1)] };
    w.deps.check = async (database, args) => {
      w.calls.push({ database, o: args });
      stop.abort();
      return report;
    };
    await expect(orderHistoryCheckTask(w.deps).run(stop.signal)).resolves.toEqual(report);
    expect(w.calls).toHaveLength(1);
    expect(w.mismatchCounts).toEqual([]);
    expect(w.warns).toEqual([]);
  });

  test('ADR0113_check가 던지면 run도 그 오류로 던지고(정비 실행기가 실패로 센다) historyMismatch·경고 로그를 부르지 않는다', async () => {
    const boom = Object.assign(new Error('connection terminated'), { code: '57P01' });
    const w = world({ now: '2026-11-05T15:30:00.000Z', fail: boom });
    await expect(orderHistoryCheckTask(w.deps).run()).rejects.toBe(boom);
    expect(w.mismatchCounts).toEqual([]);
    expect(w.warns).toEqual([]);
  });
});
