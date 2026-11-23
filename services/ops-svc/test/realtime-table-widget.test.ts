// 관제 위젯 원천 rt-sales.summary(F-04-1 KPI 패널, ADR-0360 결정 9의 WidgetSource 포트). 보드의 회차 스냅숏이 위젯 값으로 옮겨지고,
// 위젯 흐름(WidgetFeed)이 Prometheus 원천과 함께 조립되며, 원천 실패 값의 source가 키의 원천 이름인지 본다.
import { describe, expect, test } from 'vitest';
import { PROMETHEUS_WIDGET_KEYS, RtSalesSummary, UnavailableWidgetSource, WidgetFeed, WidgetValue, unavailableValue } from '../src/modules/live/index.js';
import { MemoryRtSource, RT_WIDGET_KEY, RtBoard, RtWidgetSource, type PartitionRef } from '../src/modules/realtime-table/index.js';

const EVENT = '0b8f6f3e-1111-4c2a-9d0e-000000000001';
const EXPECTED: PartitionRef[] = [
  { topic: 'telemetry.queue', partition: 0 },
  { topic: 'telemetry.purchase', partition: 0 },
  { topic: 'telemetry.trust-verdicts', partition: 0 },
];

function setup(nowMs = 1_800_000_000_000) {
  const source = new MemoryRtSource();
  let now = nowMs;
  const board = new RtBoard({ source, seatMaps: source, now: () => now, expected: EXPECTED });
  source.freshnessRows = EXPECTED.map((p) => ({ ...p, lastProducedAtMs: now - 800, pulses2s: 2 }));
  source.cumulativeRows.set(EVENT, [
    { metric: 'sold_seats', dim: '', value: 7 },
    { metric: 'sold_seats_section', dim: 'A', value: 5 },
    { metric: 'sold_seats_section', dim: 'B', value: 2 },
    { metric: 'sales_amount', dim: '', value: 770_000 },
    { metric: 'orders_confirmed', dim: '', value: 4 },
    { metric: 'tickets_issued', dim: '', value: 6 },
    { metric: 'queue_entries', dim: '', value: 120 },
    { metric: 'queue_admissions', dim: '', value: 30 },
    { metric: 'queue_removed', dim: '', value: 10 },
    { metric: 'last_trade_loaded_ms', dim: '', value: now - 2_000 },
  ]);
  source.seatMapRows.set(EVENT, [
    { layoutVersion: 1, sectionId: 'A', tierId: 'R', seatCount: 10 },
    { layoutVersion: 1, sectionId: 'B', tierId: 'S', seatCount: 20 },
    { layoutVersion: 1, sectionId: 'C', tierId: 'S', seatCount: 5 },
  ]);
  return { source, board, rt: new RtWidgetSource(board), at: (ms: number) => (now = ms), now: () => now };
}

describe('F-04-1 KPI 패널 rt-sales.summary', () => {
  test('ST-T1·C-T20 보드의 회차 누적·구역별 잔여석이 위젯 값(계약 모양)으로 옮겨진다', async () => {
    const { rt, now } = setup();
    const v = await rt.read(RT_WIDGET_KEY, { eventId: EVENT, nowMs: now() });
    expect(RtSalesSummary.parse(v)).toEqual(v);
    expect(WidgetValue.parse(v)).toEqual(v);
    expect(v).toMatchObject({
      widgetKey: 'rt-sales.summary',
      source: 'clickhouse',
      eventId: EVENT,
      sold: 7,
      remaining: 28,
      salesAmount: 770_000,
      ordersConfirmed: 4,
      ticketsIssued: 6,
      waiting: 80,
      queueEntries: 120,
      degraded: false,
      tradeGap: false,
    });
    expect(v.sections).toEqual([
      { sectionId: 'A', sold: 5, remaining: 5 },
      { sectionId: 'B', sold: 2, remaining: 18 },
      { sectionId: 'C', sold: 0, remaining: 5 },
    ]);
    expect(v.freshnessSeconds).toBeGreaterThan(0);
    expect(v.freshnessSeconds).toBeLessThan(5);
  });

  test('C-T37 거래 원시 행이 60초 넘게 끊기면 tradeGap이 켜진다', async () => {
    const { source, rt, now } = setup();
    source.cumulativeRows.set(EVENT, [
      { metric: 'sold_seats', dim: '', value: 1 },
      { metric: 'last_trade_loaded_ms', dim: '', value: now() - 61_000 },
    ]);
    expect((await rt.read(RT_WIDGET_KEY, { eventId: EVENT, nowMs: now() })).tradeGap).toBe(true);
  });

  test('회차 기준 자료가 없으면 잔여석은 null이고 판매 좌석은 그대로다', async () => {
    const { source, rt, now } = setup();
    source.seatMapRows.delete(EVENT);
    const v = await rt.read(RT_WIDGET_KEY, { eventId: EVENT, nowMs: now() });
    expect(v.remaining).toBeNull();
    expect(v.sold).toBe(7);
    expect(v.sections).toEqual([
      { sectionId: 'A', sold: 5, remaining: null },
      { sectionId: 'B', sold: 2, remaining: null },
    ]);
  });

  test('회차가 없거나 보드가 한 번도 못 읽었으면 원천 실패다', async () => {
    const { source, rt, now } = setup();
    await expect(rt.read(RT_WIDGET_KEY, { eventId: null, nowMs: now() })).rejects.toThrow(/회차/);
    source.failing.add('cumulative');
    await expect(rt.read(RT_WIDGET_KEY, { eventId: EVENT, nowMs: now() })).rejects.toMatchObject({ name: 'WidgetSourceUnavailable' });
  });

  test('위젯 흐름에 Prometheus 원천과 함께 조립되고, 실패 값의 source는 clickhouse다', async () => {
    expect(PROMETHEUS_WIDGET_KEYS).not.toContain(RT_WIDGET_KEY);
    const { rt, now } = setup();
    const feed = new WidgetFeed([new UnavailableWidgetSource(), rt], { now });
    const ok = await feed.read(RT_WIDGET_KEY, { eventId: EVENT });
    expect(ok).toMatchObject({ widgetKey: RT_WIDGET_KEY, source: 'clickhouse', sold: 7 });
    expect(await feed.read('queue-admission-rate.summary', { eventId: EVENT })).toMatchObject({ error: 'source-unavailable', source: 'prometheus' });
    expect(unavailableValue(RT_WIDGET_KEY, EVENT, now())).toMatchObject({ source: 'clickhouse', error: 'source-unavailable' });
    const fresh = setup();
    fresh.source.failing.add('cumulative');
    const failing = new WidgetFeed([new RtWidgetSource(fresh.board)], { now: fresh.now });
    expect(await failing.read(RT_WIDGET_KEY, { eventId: EVENT })).toEqual(unavailableValue(RT_WIDGET_KEY, EVENT, fresh.now()));
  });
});
