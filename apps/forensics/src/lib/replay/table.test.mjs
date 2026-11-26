// F-04-17 표 보기·조사 원천 기준선 시험. 정본: docs/features/forensic-replay.md §2.1·§2.3·§8 FX-T8.
// 표 값은 그림과 같은 집계를 써야 하고, 시험은 전 행을 도는 기준 구현과 견준다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_KIND,
  NO_SEAT,
  RESULT,
  SEAT_STATE,
  columnsFromRows,
} from '../forensics/events.ts';

async function loadTable() {
  try {
    return await import('./table.ts');
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  }
}
async function loadCrossfilter() {
  try {
    return await import('./crossfilter.ts');
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
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
    { t_ms: -2000, kind: EVENT_KIND.QUEUE_ENTER, session: 1, section: 1, bot_tier: 0, net_type: 0, device_group: 0, member: 0 },
    { t_ms: -1500, kind: EVENT_KIND.HOLD_TRY, seat: 1, section: 1, session: 1, result: RESULT.HELD, bot_tier: 1, net_type: 2, device_group: 1, member: 1 },
    { t_ms: -1000, kind: EVENT_KIND.HOLD_TRY, seat: 2, section: 2, session: 2, result: RESULT.CONFLICT, bot_tier: 2, net_type: 3, device_group: 2, member: 1 },
    { t_ms: 0, kind: EVENT_KIND.SALE, seat: 1, section: 1, session: 1, bot_tier: 1, net_type: 2, device_group: 1, member: 1 },
    { t_ms: 2999, kind: EVENT_KIND.QUEUE_ENTER, session: 3, section: 2, bot_tier: 0, net_type: 1, device_group: 0, member: 0 },
    { t_ms: 3000, kind: EVENT_KIND.QUEUE_ENTER, session: 4, section: 2, bot_tier: 0, net_type: 1, device_group: 0, member: 0 },
  ];
}

function passFilter(columns, i, filter) {
  if (filter.sections !== undefined && !filter.sections.includes(columns.section[i])) return false;
  if (filter.results !== undefined && !filter.results.includes(columns.result[i])) return false;
  if (filter.kinds !== undefined && !filter.kinds.includes(columns.kind[i])) return false;
  if (filter.botTiers !== undefined && !filter.botTiers.includes(columns.bot_tier[i])) return false;
  if (filter.netTypes !== undefined && !filter.netTypes.includes(columns.net_type[i])) return false;
  if (filter.deviceGroups !== undefined && !filter.deviceGroups.includes(columns.device_group[i])) return false;
  if (filter.member !== undefined && columns.member[i] !== filter.member) return false;
  return true;
}

/** 전 행을 도는 초당 막대 기준 구현. 여덟 차원과 시간 범위를 모두 본다(RV0417-05). */
function referenceSeries(columns, keep, bounds, filter = {}) {
  const count = Math.ceil((bounds.toMs - bounds.fromMs) / 1000);
  const out = [];
  for (let i = 0; i < count; i += 1) out.push({ atMs: bounds.fromMs + i * 1000, queueEnter: 0, holdTry: 0, conflict: 0, sale: 0 });
  for (let i = 0; i < columns.t_ms.length; i += 1) {
    if (keep[i] === 0) continue;
    const t = columns.t_ms[i];
    if (t < bounds.fromMs || t >= bounds.toMs) continue;
    if (filter.fromMs !== undefined && t < filter.fromMs) continue;
    if (filter.toMs !== undefined && t >= filter.toMs) continue;
    if (!passFilter(columns, i, filter)) continue;
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

  const filters = [
    { sections: [1] },
    { results: [RESULT.CONFLICT] },
    { kinds: [EVENT_KIND.SALE] },
    { botTiers: [1] },
    { netTypes: [2] },
    { deviceGroups: [1] },
    { member: 1 },
    { fromMs: -1500, toMs: 100 },
    { sections: [1], results: [RESULT.HELD], botTiers: [1], member: 1 },
  ];
  for (const f of filters) {
    const got = crossfilter.timelineSeries(columns, keep, BOUNDS, f);
    assert.deepEqual(got, referenceSeries(columns, keep, BOUNDS, f), JSON.stringify(f));
  }
  assert.deepEqual(crossfilter.timelineSeries(columns, keep, BOUNDS, { sections: [1] }).map((b) => b.holdTry), [1, 0, 0, 0, 0]);
  assert.deepEqual(crossfilter.timelineSeries(columns, keep, BOUNDS, { botTiers: [1] }).map((b) => [b.holdTry, b.sale]), [[1, 0], [0, 0], [0, 1], [0, 0], [0, 0]]);

  const narrow = crossfilter.timelineSeries(columns, keep, { fromMs: 0, toMs: 2000 });
  assert.deepEqual(narrow, referenceSeries(columns, keep, { fromMs: 0, toMs: 2000 }));
  assert.deepEqual(narrow.map((b) => b.atMs), [0, 1000]);
});

test('FX-T8 ② 요약 표가 교차 필터 요약과 같은 값을 낸다', () => {
  need(table, 'summaryRows', 'src/lib/replay/table.ts');
  need(crossfilter, 'summarize', 'src/lib/replay/crossfilter.ts');
  const rows = [
    { t_ms: 0, kind: EVENT_KIND.HOLD_TRY, seat: 1, section: 1, session: 1, result: RESULT.CONFLICT, bot_tier: 2 },
    { t_ms: 10, kind: EVENT_KIND.HOLD_TRY, seat: 2, section: 1, session: 1, result: RESULT.HELD, bot_tier: 2 },
    { t_ms: 20, kind: EVENT_KIND.SALE, seat: 2, section: 1, session: 1, bot_tier: 2 },
    { t_ms: 30, kind: EVENT_KIND.HOLD_TRY, seat: 3, section: 2, session: 2, result: RESULT.HELD, bot_tier: 0 },
  ];
  const columns = columnsFromRows(rows);
  const summary = crossfilter.summarize(columns, new Uint8Array(4).fill(1), {});
  assert.deepEqual(summary, {
    rows: 4,
    sessions: 2,
    holdTries: 3,
    conflictRate: 1 / 3,
    holdToSaleRate: 1 / 2,
    candidateRate: 1 / 2,
    memberSessions: 0,
  });
  assert.deepEqual(table.summaryRows(summary, 'SYNTHETIC'), [
    { label: '홀드 시도', value: 3 },
    { label: '경합 패배율', value: 0.3333 },
    { label: '홀드 → 판매 전환', value: 0.5 },
    { label: '후보 비율', value: 0.5 },
  ]);
  assert.deepEqual(table.summaryRows(summary, 'RESEARCH'), [
    { label: '홀드 시도', value: 3 },
    { label: '경합 패배율', value: 0.3333 },
    { label: '홀드 → 판매 전환', value: 0.5 },
    { label: '후보 비율', value: 0.5 },
  ]);
  assert.deepEqual(table.summaryRows(summary, 'INVESTIGATION'), [
    { label: '홀드 시도', value: 3 },
    { label: '경합 패배율', value: 0.3333 },
    { label: '홀드 → 판매 전환', value: 0.5 },
    { label: '묶음 계정 수', value: 0 },
  ]);
});

/** 5세션 모두 다섯 단계가 있고, 입장 확정 → 첫 홀드만 10·20·30·40·50ms로 다르다. 6번째는 묶음 계정이다. */
function allStageRows() {
  const rows = [];
  for (let i = 1; i <= 5; i += 1) rows.push({ t_ms: 1000, kind: EVENT_KIND.QUEUE_ENTER, session: i, member: 0 });
  rows.push({ t_ms: 1000, kind: EVENT_KIND.QUEUE_ENTER, session: 6, member: 1 });
  for (let i = 1; i <= 5; i += 1) rows.push({ t_ms: 1000 + 10 * i, kind: EVENT_KIND.ADMIT, session: i, member: 0 });
  rows.push({ t_ms: 1999, kind: EVENT_KIND.ADMIT, session: 6, member: 1 });
  for (let i = 1; i <= 5; i += 1) rows.push({ t_ms: 2000 + 10 * i, kind: EVENT_KIND.HOLD_TRY, seat: i, section: 1, session: i, member: 0, result: RESULT.HELD });
  for (let i = 1; i <= 5; i += 1) rows.push({ t_ms: 3000 + 10 * i, kind: EVENT_KIND.PAY_TRY, seat: i, section: 1, session: i, member: 0 });
  for (let i = 1; i <= 5; i += 1) rows.push({ t_ms: 4000 + 10 * i, kind: EVENT_KIND.SALE, seat: i, section: 1, session: i, member: 0 });
  return rows;
}

test('FX-T8 ② 조사 원천 기준선의 1·50·99 백분위는 가장 가까운 순위로 고른다', () => {
  need(table, 'stageBands', 'src/lib/replay/table.ts');
  need(table, 'journeys', 'src/lib/replay/table.ts');
  need(table, 'stageDurations', 'src/lib/replay/table.ts');
  need(table, 'percentile', 'src/lib/replay/table.ts');
  need(table, 'baselineRows', 'src/lib/replay/table.ts');
  assert.equal(table.percentile([10, 20, 30, 40, 50], 1), 10);
  assert.equal(table.percentile([10, 20, 30, 40, 50], 50), 30);
  assert.equal(table.percentile([10, 20, 30, 40, 50], 99), 50);
  assert.equal(table.percentile([10, 20, 30, 40, 50], 0), 10);
  assert.equal(table.percentile([10, 20, 30, 40, 50], 100), 50);
  assert.ok(Number.isNaN(table.percentile([], 50)));

  const columns = columnsFromRows(allStageRows());
  const keep = new Uint8Array(columns.t_ms.length).fill(1);
  const journeys = table.journeys(columns, keep);
  assert.deepEqual(journeys.map((j) => j.session), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(journeys.map((j) => j.admitMs), [1010, 1020, 1030, 1040, 1050, 1999]);
  assert.deepEqual(table.stageDurations(journeys[0]), {
    saleToQueue: 1000,
    queueToAdmit: 10,
    admitToHold: 1000,
    holdToPay: 1000,
    payToSale: 1000,
  });

  const outside = table.stageBands(columns, keep, 0);
  assert.equal(outside.length, 5, '다섯 단계가 모두 있다');
  assert.deepEqual(outside.find((b) => b.stage === 'queueToAdmit'), { stage: 'queueToAdmit', p1: 10, p50: 30, p99: 50, n: 5 });
  for (const stage of ['saleToQueue', 'admitToHold', 'holdToPay', 'payToSale']) {
    assert.deepEqual(outside.find((b) => b.stage === stage), { stage, p1: 1000, p50: 1000, p99: 1000, n: 5 }, stage);
  }
  const rows = table.baselineRows(outside);
  assert.deepEqual(rows.find((r) => r.stage === '대기열 진입 → 입장 확정'), { stage: '대기열 진입 → 입장 확정', p1: 10, p50: 30, p99: 50, n: 5 });
  assert.deepEqual(rows.find((r) => r.stage === '판매 시작 → 대기열 진입'), { stage: '판매 시작 → 대기열 진입', p1: 1000, p50: 1000, p99: 1000, n: 5 });

  const inside = table.stageBands(columns, keep, 1);
  assert.deepEqual(inside.find((b) => b.stage === 'queueToAdmit'), { stage: 'queueToAdmit', p1: 999, p50: 999, p99: 999, n: 1 });

  const dropped = new Uint8Array(keep);
  const admitIndex = columns.kind.findIndex((k) => k === EVENT_KIND.ADMIT);
  assert.ok(admitIndex >= 0);
  dropped[admitIndex] = 0;
  const afterDrop = table.journeys(columns, dropped);
  assert.equal(afterDrop[0].admitMs, null, '버린 입장 확정은 여정에 없다');
  assert.equal(table.stageDurations(afterDrop[0]).queueToAdmit, undefined);
  const droppedBands = table.stageBands(columns, dropped, 0);
  assert.deepEqual(droppedBands.find((b) => b.stage === 'queueToAdmit'), { stage: 'queueToAdmit', p1: 20, p50: 30, p99: 50, n: 4 });

  const missing = table.stageDurations({ session: 6, queueEnterMs: 1000, admitMs: null, firstHoldMs: null, payTryMs: null, saleMs: null });
  assert.deepEqual(missing, { saleToQueue: 1000 }, '없는 단계는 넣지 않는다');
  const negative = table.stageDurations({ session: 7, queueEnterMs: 1000, admitMs: 500, firstHoldMs: null, payTryMs: null, saleMs: null });
  assert.deepEqual(negative, { saleToQueue: 1000 }, '음수 단계는 넣지 않는다');
});

test('FX-T8 ② 거른 뒤에도 그림과 표가 같은 행을 센다', () => {
  need(table, 'timelineRows', 'src/lib/replay/table.ts');
  need(table, 'seatLegend', 'src/lib/replay/table.ts');
  need(crossfilter, 'timelineSeries', 'src/lib/replay/crossfilter.ts');
  const columns = columnsFromRows(seriesRows());
  const keep = new Uint8Array(columns.t_ms.length);
  for (let i = 0; i < keep.length; i += 1) keep[i] = i === 3 ? 0 : 1;
  const buckets = crossfilter.timelineSeries(columns, keep, BOUNDS, { sections: [1] });
  assert.deepEqual(buckets, referenceSeries(columns, keep, BOUNDS, { sections: [1] }));
  const rows = table.timelineRows(buckets);
  const total = rows.reduce((s, r) => s + r.queueEnter + r.holdTry + r.sale, 0);
  assert.equal(total, 2, '버린 판매와 다른 구역 행은 표에 들어가지 않는다');

  assert.deepEqual(table.seatLegend(), [
    { state: SEAT_STATE.EMPTY, label: '빈 좌석', pattern: 'solid' },
    { state: SEAT_STATE.HELD, label: '홀드', pattern: 'diagonal-hatch' },
    { state: SEAT_STATE.PAYING, label: '결제 중', pattern: 'solid-with-check' },
    { state: SEAT_STATE.SOLD, label: '판매', pattern: 'cross-hatch' },
  ]);
});
