// F-04-1 KPI 패널: 관제 실시간 표 위젯 값 → 판매 중 탭 '구역별 잔여석' 칸 글자(rt-sales-value.ts). Node 내장 시험 실행기가 TS를 그대로 읽는다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heatOf, isUnavailable, rtSalesViewOf } from './rt-sales-value.ts';

const value = {
  widgetKey: 'rt-sales.summary',
  source: 'clickhouse',
  at: '2026-11-23T11:00:00.000Z',
  eventId: 'e1',
  sold: 1204,
  remaining: 1196,
  salesAmount: 180_600_000,
  ordersConfirmed: 610,
  ticketsIssued: 1200,
  waiting: 9214,
  queueEntries: 48000,
  sections: [
    { sectionId: 'R1', sold: 96, remaining: 4 },
    { sectionId: 'S1', sold: 80, remaining: 120 },
    { sectionId: 'A1', sold: 100, remaining: 300 },
  ],
  freshnessSeconds: 1.4,
  degraded: false,
  tradeGap: false,
};

test('F-04-1 C-T20 판매·잔여·금액·대기 타일과 구역별 잔여석·색 칸', () => {
  const v = rtSalesViewOf(value);
  assert.deepEqual(v.tiles, [
    { label: '판매', value: '1,204석' },
    { label: '잔여', value: '1,196석' },
    { label: '판매 금액', value: '180,600,000원' },
    { label: '지금 대기', value: '9,214명' },
  ]);
  assert.deepEqual(v.sections, [
    { sectionId: 'R1', remaining: '4석', heat: 'h3' },
    { sectionId: 'S1', remaining: '120석', heat: 'h1' },
    { sectionId: 'A1', remaining: '300석', heat: 'h1' },
  ]);
  assert.equal(v.summary, '구역별 남은 좌석. R1 4석, S1 120석, A1 300석.');
  assert.deepEqual(v.freshness, { text: '1.4초 전', late: false });
  assert.equal(v.remainingUnknown, false);
});

test('F-04-1 C-T36·C-T37 신선도 5초 이상은 늦음, Degraded·거래 사건 끊김 표시', () => {
  const v = rtSalesViewOf({ ...value, freshnessSeconds: 7.25, degraded: true, tradeGap: true });
  assert.deepEqual(v.freshness, { text: '7.3초 전', late: true });
  assert.equal(v.degraded, true);
  assert.equal(v.tradeGap, true);
});

test('잔여석을 모르면 대시이고 색 칸이 없다', () => {
  const v = rtSalesViewOf({ ...value, remaining: null, sections: [{ sectionId: 'A', sold: 3, remaining: null }] });
  assert.equal(v.tiles[1].value, '—');
  assert.deepEqual(v.sections, [{ sectionId: 'A', remaining: '—', heat: null }]);
  assert.equal(v.remainingUnknown, true);
});

test('범례 경계: 50%·10%는 위 칸, 판매·잔여가 모두 0이면 없음', () => {
  assert.equal(heatOf(50, 50), 'h1');
  assert.equal(heatOf(90, 10), 'h2');
  assert.equal(heatOf(91, 9), 'h3');
  assert.equal(heatOf(10, 0), 'h3');
  assert.equal(heatOf(0, 0), null);
  assert.equal(isUnavailable({ error: 'source-unavailable' }), true);
  assert.equal(isUnavailable(value), false);
  assert.equal(isUnavailable(null), true);
});
