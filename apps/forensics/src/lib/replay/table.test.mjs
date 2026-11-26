// F-04-17 표 보기·조사 원천 기준선 시험. 정본: docs/features/forensic-replay.md §2.1·§2.3·§8 FX-T8.
// 표 값은 그림과 같은 집계를 써야 하고, 시험은 전 행을 도는 기준 구현과 견준다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_KIND,
  NO_SEAT,
  RESULT,
  columnsFromRows,
} from '../forensics/events.ts';

async function loadTable() {
  try {
    return await import('./table.ts');
  } catch {
    return null;
  }
}
async function loadCrossfilter() {
  try {
    return await import('./crossfilter.ts');
  } catch {
    return null;
  }
}

const table = await loadTable();
const crossfilter = await loadCrossfilter();

function need(mod, name, path) {
  assert.ok(mod, `${path}가 없다`);
  assert.equal(typeof mod[name], 'function', `${path}의 ${name}이 없다`);
}

const BOUNDS = { fromMs: -2000, toMs: 3000 };

function seriesRows() {
  return [
    { t_ms: -2000, kind: EVENT_KIND.QUEUE_ENTER, session: 1, section: 1 },
    { t_ms: -1500, kind: EVENT_KIND.HOLD_TRY, seat: 1, section: 1, session: 1, result: RESULT.HELD },
    { t_ms: -1000, kind: EVENT_KIND.HOLD_TRY, seat: 2, section: 2, session: 2, result: RESULT.CONFLICT },
    { t_ms: 0, kind: EVENT_KIND.SALE, seat: 1, section: 1, session: 1 },
    { t_ms: 2999, kind: EVENT_KIND.QUEUE_ENTER, session: 3, section: 2 },
    { t_ms: 3000, kind: EVENT_KIND.QUEUE_ENTER, session: 4, section: 2 },
  ];
}

/** 전 행을 도는 초당 막대 기준 구현. */
function referenceSeries(columns, keep, bounds, filter = {}) {
  const count = Math.ceil((bounds.toMs - bounds.fromMs) / 1000);
  const out = [];
  for (let i = 0; i < count; i += 1) out.push({ atMs: bounds.fromMs + i * 1000, queueEnter: 0, holdTry: 0, conflict: 0, sale: 0 });
  for (let i = 0; i < columns.t_ms.length; i += 1) {
    if (keep[i] === 0) continue;
    const t = columns.t_ms[i];
    if (t < bounds.fromMs || t >= bounds.toMs) continue;
    if (filter.sections !== undefined && !filter.sections.includes(columns.section[i])) continue;
    const bucket = out[Math.floor((t - bounds.fromMs) / 1000)];
    if (columns.kind[i] === EVENT_KIND.QUEUE_ENTER) bucket.queueEnter += 1;
    if (columns.kind[i] === EVENT_KIND.HOLD_TRY) {
      bucket.holdTry += 1;
      if (columns.result[i] === RESULT.CONFLICT) bucket.conflict += 1;
    }
    if (columns.kind[i] === EVENT_KIND.SALE) bucket.sale += 1;
  }
  return out;
}

test('FX-T8 ② 초당 막대 표가 그림 집계와 같은 값을 낸다', () => {
  need(table, 'timelineRows', 'src/lib/replay/table.ts');
  need(crossfilter, 'timelineSeries', 'src/lib/replay/crossfilter.ts');
  const columns = columnsFromRows(seriesRows());
  const keep = new Uint8Array(columns.t_ms.length).fill(1);
  const buckets = crossfilter.timelineSeries(columns, keep, BOUNDS);
  assert.deepEqual(buckets, referenceSeries(columns, keep, BOUNDS));
  assert.equal(buckets.length, 5);
  assert.deepEqual(buckets.map((b) => b.atMs), [-2000, -1000, 0, 1000, 2000]);
  const rows = table.timelineRows(buckets);
  assert.deepEqual(rows, [
    { second: 'T−00:02', queueEnter: 1, holdTry: 1, conflict: 0, sale: 0 },
    { second: 'T−00:01', queueEnter: 0, holdTry: 1, conflict: 1, sale: 0 },
    { second: 'T+00:00', queueEnter: 0, holdTry: 0, conflict: 0, sale: 1 },
    { second: 'T+00:01', queueEnter: 0, holdTry: 0, conflict: 0, sale: 0 },
    { second: 'T+00:02', queueEnter: 1, holdTry: 0, conflict: 0, sale: 0 },
  ]);

  const section1 = crossfilter.timelineSeries(columns, keep, BOUNDS, { sections: [1] });
  assert.deepEqual(section1, referenceSeries(columns, keep, BOUNDS, { sections: [1] }));
  assert.deepEqual(section1.map((b) => b.holdTry), [1, 0, 0, 0, 0]);
});

test('FX-T8 ② 요약 표가 교차 필터 요약과 같은 값을 낸다', () => {
  need(table, 'summaryRows', 'src/lib/replay/table.ts');
  const summary = {
    rows: 7,
    sessions: 4,
    holdTries: 7,
    conflictRate: 2 / 7,
    holdToSaleRate: 0.5,
    candidateRate: 3 / 7,
    memberSessions: 2,
  };
  assert.deepEqual(table.summaryRows(summary, 'SYNTHETIC'), [
    { label: '홀드 시도', value: 7 },
    { label: '경합 패배율', value: 0.2857 },
    { label: '홀드 → 판매 전환', value: 0.5 },
    { label: '후보 비율', value: 0.4286 },
  ]);
  assert.deepEqual(table.summaryRows(summary, 'RESEARCH'), [
    { label: '홀드 시도', value: 7 },
    { label: '경합 패배율', value: 0.2857 },
    { label: '홀드 → 판매 전환', value: 0.5 },
    { label: '후보 비율', value: 0.4286 },
  ]);
  assert.deepEqual(table.summaryRows(summary, 'INVESTIGATION'), [
    { label: '홀드 시도', value: 7 },
    { label: '경합 패배율', value: 0.2857 },
    { label: '홀드 → 판매 전환', value: 0.5 },
    { label: '묶음 계정 수', value: 2 },
  ]);
});

test('FX-T8 ② 조사 원천 기준선의 1·50·99 백분위는 가장 가까운 순위로 고른다', () => {
  need(table, 'stageBands', 'src/lib/replay/table.ts');
  need(table, 'journeys', 'src/lib/replay/table.ts');
  need(table, 'percentile', 'src/lib/replay/table.ts');
  need(table, 'baselineRows', 'src/lib/replay/table.ts');
  assert.equal(table.percentile([10, 20, 30, 40, 50], 1), 10);
  assert.equal(table.percentile([10, 20, 30, 40, 50], 50), 30);
  assert.equal(table.percentile([10, 20, 30, 40, 50], 99), 50);
  assert.equal(table.percentile([10, 20, 30, 40, 50], 0), 10);
  assert.equal(table.percentile([10, 20, 30, 40, 50], 100), 50);
  assert.ok(Number.isNaN(table.percentile([], 50)));

  const rows = [
    ...Array.from({ length: 5 }, (_, i) => ({ t_ms: 0, kind: EVENT_KIND.QUEUE_ENTER, session: i + 1, member: 0 })),
    { t_ms: 0, kind: EVENT_KIND.QUEUE_ENTER, session: 6, member: 1 },
    ...Array.from({ length: 5 }, (_, i) => ({ t_ms: 10 * (i + 1), kind: EVENT_KIND.ADMIT, session: i + 1, member: 0 })),
    { t_ms: 999, kind: EVENT_KIND.ADMIT, session: 6, member: 1 },
  ];
  const columns = columnsFromRows(rows);
  const keep = new Uint8Array(columns.t_ms.length).fill(1);
  const journeys = table.journeys(columns, keep);
  assert.equal(journeys.length, 6);
  assert.deepEqual(journeys.map((j) => j.session), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(journeys.map((j) => j.admitMs), [10, 20, 30, 40, 50, 999]);

  const outside = table.stageBands(columns, keep, 0);
  const band = outside.find((b) => b.stage === 'queueToAdmit');
  assert.deepEqual(band, { stage: 'queueToAdmit', p1: 10, p50: 30, p99: 50, n: 5 });
  assert.deepEqual(table.baselineRows(outside).find((r) => r.stage === '대기열 진입 → 입장 확정'), {
    stage: '대기열 진입 → 입장 확정',
    p1: 10,
    p50: 30,
    p99: 50,
    n: 5,
  });
  const inside = table.stageBands(columns, keep, 1);
  assert.deepEqual(inside.find((b) => b.stage === 'queueToAdmit'), { stage: 'queueToAdmit', p1: 999, p50: 999, p99: 999, n: 1 });
});

test('FX-T8 ② 거른 뒤에도 그림과 표가 같은 행을 센다', () => {
  need(table, 'timelineRows', 'src/lib/replay/table.ts');
  need(crossfilter, 'timelineSeries', 'src/lib/replay/crossfilter.ts');
  const columns = columnsFromRows(seriesRows());
  const keep = new Uint8Array(columns.t_ms.length);
  for (let i = 0; i < keep.length; i += 1) keep[i] = i === 3 ? 0 : 1;
  const buckets = crossfilter.timelineSeries(columns, keep, BOUNDS, { sections: [1] });
  assert.deepEqual(buckets, referenceSeries(columns, keep, BOUNDS, { sections: [1] }));
  const rows = table.timelineRows(buckets);
  const total = rows.reduce((s, r) => s + r.queueEnter + r.holdTry + r.sale, 0);
  assert.equal(total, 2, '버린 판매와 다른 구역 행은 표에 들어가지 않는다');
});
