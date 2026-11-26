// F-04-18 후보 모델 시험. 정본: docs/features/forensic-replay.md §2.1·§4.1·§8 FX-T9, d5 §7.17.
// 구현 전에는 candidate.ts가 없어 모든 시험이 단언으로 실패한다(architecture §8.6 4의 3·7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_KIND,
  NO_SEAT,
  RESULT,
  makeColumns,
} from '../forensics/events.ts';
import { defaultParams, generateScenario } from '../forensics/scenario.ts';
import { baselineRows, stageBands } from './table.ts';

async function load() {
  try {
    return await import('./candidate.ts');
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw error;
  }
}

const candidate = await load();

function need(name) {
  assert.ok(candidate, '후보 모델(src/lib/replay/candidate.ts)이 없다');
  assert.equal(typeof candidate[name], 'function', `${name}이 없다`);
  return candidate[name];
}

function build(rows) {
  const columns = makeColumns(rows.length);
  rows.forEach((row, i) => {
    columns.t_ms[i] = row.t_ms ?? 0;
    columns.kind[i] = row.kind ?? 0;
    columns.seat[i] = row.seat ?? NO_SEAT;
    columns.section[i] = row.section ?? 0;
    columns.session[i] = row.session ?? 0;
    columns.result[i] = row.result ?? RESULT.NONE;
    columns.retry[i] = row.retry ?? 0;
    columns.latency_ms[i] = row.latency_ms ?? 0;
    columns.first_hold_ms[i] = row.first_hold_ms ?? 0;
    columns.entropy[i] = row.entropy ?? Number.NaN;
    columns.net_type[i] = row.net_type ?? 0;
    columns.asn[i] = row.asn ?? 0;
    columns.device_group[i] = row.device_group ?? 0;
    columns.bot_tier[i] = row.bot_tier ?? 0;
    columns.member[i] = row.member ?? 0;
    columns.post_seat[i] = row.post_seat ?? 0;
  });
  return columns;
}

function keepAll(length) {
  return new Uint8Array(length).fill(1);
}

function admit(session, firstHold, entropy, extra = {}) {
  return {
    t_ms: 0,
    kind: EVENT_KIND.ADMIT,
    session,
    first_hold_ms: firstHold,
    entropy,
    ...extra,
  };
}

const nearly = (actual, expected, label) => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);
};

test('FX-T9 ① 원천마다 후보 패널의 종류·고정 문구가 다르고 정밀도 경고는 정본과 같다', () => {
  const panelKind = need('candidatePanelKind');
  const notice = need('candidateNotice');
  const precision = need('precisionNotice');

  assert.equal(panelKind('SYNTHETIC'), 'scatter');
  assert.equal(panelKind('RESEARCH'), 'distribution');
  assert.equal(panelKind('INVESTIGATION'), 'baseline');

  const pol046 = '후보 찾기용입니다. 조치는 사건 작업대에서 소명과 승인을 거쳐 합니다(POL-046).';
  const pol006 = '후보 찾기용입니다. 봇 판정은 표본 검토(SCR-067)와 정해진 규칙(POL-006)으로 합니다.';
  assert.equal(notice('INVESTIGATION'), pol046);
  assert.equal(notice('RESEARCH'), pol006);
  assert.equal(notice('SYNTHETIC'), pol006);
  assert.equal(
    precision(),
    '합성 데이터의 정답으로 잰 값입니다. 봇을 이 특징으로 만들었기 때문에 높게 나오며, 실제 봇 탐지 성능을 뜻하지 않습니다.',
  );
});

test('FX-T9 ② 합성 정답 기준 정밀도·재현율을 영역 안 세션과 그려진 전체 봇 세션으로 센다', () => {
  const sessionPoints = need('sessionPoints');
  const candidatePoints = need('candidatePoints');
  const selectPoints = need('selectPoints');
  const selectionStats = need('selectionStats');

  const columns = build([
    admit(1, 50, 0.1, { bot_tier: 3 }),
    admit(2, 80, 0.2, { bot_tier: 1 }),
    admit(3, 900, 0.6),
    admit(4, 1_200, 0.7),
    admit(5, 2_000, 0.3, { bot_tier: 2 }),
    admit(6, 0, 0.5, { bot_tier: 2 }),
    admit(7, 1_500, Number.NaN, { bot_tier: 3 }),
  ]);
  const keep = keepAll(columns.t_ms.length);
  const sessions = sessionPoints(columns, keep);
  const points = candidatePoints(sessions);
  assert.deepEqual(points.map((p) => p.session), [1, 2, 3, 4, 5]);
  const totalBots = points.filter((p) => p.bot).length;
  assert.equal(totalBots, 3);

  const lowerLeft = { x0: 10, x1: 100, y0: 0, y1: 0.5 };
  assert.deepEqual(selectPoints(points, lowerLeft).map((p) => p.session), [1, 2]);
  const first = selectionStats(points, lowerLeft, totalBots);
  assert.equal(first.sessions, 2);
  assert.equal(first.bots, 2);
  assert.equal(first.precision, 1);
  nearly(first.recall, 2 / 3, '재현율');

  const all = { x0: 0, x1: 10_000, y0: 0, y1: 1 };
  const second = selectionStats(points, all, totalBots);
  assert.equal(second.sessions, 5);
  assert.equal(second.bots, 3);
  assert.equal(second.precision, 0.6);
  assert.equal(second.recall, 1);

  // 반열림: x0·y0는 들고 x1·y1은 뺀다.
  const edge = { x0: 50, x1: 80, y0: 0.1, y1: 0.2 };
  assert.deepEqual(selectPoints(points, edge).map((p) => p.session), [1]);

  const empty = selectionStats(points, { x0: 5, x1: 6, y0: 0, y1: 1 }, totalBots);
  assert.deepEqual(empty, { sessions: 0, bots: 0, precision: 0, recall: 0 });
  assert.deepEqual(selectionStats(points, { x0: 100, x1: 10, y0: 0, y1: 1 }, totalBots), empty);

  // keep=0은 점에서 빠지고 재현율 분모에서도 빠진다.
  keep[4] = 0;
  const keptPoints = candidatePoints(sessionPoints(columns, keep));
  assert.deepEqual(keptPoints.map((p) => p.session), [1, 2, 3, 4]);
  const keptBots = keptPoints.filter((p) => p.bot).length;
  assert.equal(keptBots, 2);
  const reduced = selectionStats(keptPoints, all, keptBots);
  assert.equal(reduced.sessions, 4);
  assert.equal(reduced.bots, 2);
  assert.equal(reduced.recall, 1);
});

test('FX-T9 ③ 사람 흉내 봇 프리셋은 1,000세션 이상 영역의 정밀도가 봇 비율+10%p를 넘지 않는다', () => {
  const sessionPoints = need('sessionPoints');
  const candidatePoints = need('candidatePoints');
  const selectionStats = need('selectionStats');
  const limitOf = need('mimicPrecisionLimit');

  const small = { seats: 1_200, sectionCount: 4, queueSize: 3_000, windowMs: 120_000, botRatio: 0.3 };
  const params = {
    ...defaultParams('mimic', 'mimic-seed'),
    ...small,
    preset: 'mimic',
    botRatio: 0.3,
    mimicBots: true,
  };
  const scenario = generateScenario(params);
  const keep = keepAll(scenario.columns.t_ms.length);
  const points = candidatePoints(sessionPoints(scenario.columns, keep));
  assert.ok(points.length >= 1_000, `그려진 세션이 1,000개 미만이다(${points.length})`);
  const totalBots = points.filter((p) => p.bot).length;
  assert.ok(totalBots > 0, '봇 세션이 없다');
  const limit = limitOf(0.3);
  nearly(limit, 0.4, '사람 흉내 봇 상한');

  const quantiles = (values, count) => {
    const sorted = [...values].sort((a, b) => a - b);
    return Array.from({ length: count }, (_, i) => sorted[Math.floor(((i + 1) * (sorted.length - 1)) / count)]);
  };
  const xs = quantiles(points.map((p) => Math.log10(Math.max(1, p.x))), 16);
  const ys = quantiles(points.map((p) => p.y), 16);

  let checked = 0;
  let highest = 0;
  for (let i = 0; i < xs.length; i += 1) {
    for (let j = i + 1; j < xs.length; j += 1) {
      for (let k = 0; k < ys.length; k += 1) {
        for (let l = k + 1; l < ys.length; l += 1) {
          const bounds = { x0: 10 ** xs[i], x1: 10 ** xs[j], y0: ys[k], y1: ys[l] };
          let sessions = 0;
          let bots = 0;
          for (const p of points) {
            if (p.x < bounds.x0 || p.x >= bounds.x1) continue;
            if (p.y < bounds.y0 || p.y >= bounds.y1) continue;
            sessions += 1;
            if (p.bot) bots += 1;
          }
          if (sessions < 1_000) continue;
          checked += 1;
          const stats = selectionStats(points, bounds, totalBots);
          assert.equal(stats.sessions, sessions);
          assert.equal(stats.bots, bots);
          const precision = stats.precision;
          highest = Math.max(highest, precision);
          assert.ok(
            precision <= limit,
            `세션 ${sessions}개 영역의 정밀도 ${precision}가 상한 ${limit}를 넘었다`,
          );
        }
      }
    }
  }
  assert.ok(checked > 0, '세션 1,000개 이상 영역이 하나도 없다');
  assert.ok(highest <= limit, `가장 높은 정밀도 ${highest}가 상한 ${limit}를 넘었다`);
});

test('FX-T9 ④ 조사 원천 기준선의 1·50·99 백분위가 전 행 기준 구현과 같다', () => {
  const rows = [];
  const journey = (session, member, queue, admitAt, holdAt, payAt, saleAt) => {
    rows.push({ t_ms: queue, kind: EVENT_KIND.QUEUE_ENTER, session, member });
    rows.push({ t_ms: admitAt, kind: EVENT_KIND.ADMIT, session, member });
    rows.push({ t_ms: holdAt, kind: EVENT_KIND.HOLD_TRY, session, member });
    rows.push({ t_ms: payAt, kind: EVENT_KIND.PAY_TRY, session, member });
    rows.push({ t_ms: saleAt, kind: EVENT_KIND.SALE, session, member });
  };
  journey(1, 1, 100, 200, 500, 1_000, 2_000);
  journey(2, 0, 50, 150, 250, 750, 1_750);
  journey(3, 0, 300, 500, 900, 1_400, 2_400);
  journey(4, 0, 0, 1_000, 2_000, 3_000, 4_000);
  rows.push({ t_ms: 10, kind: EVENT_KIND.QUEUE_ENTER, session: 5, member: 1 });

  const columns = build(rows);
  const keep = keepAll(columns.t_ms.length);
  const bands = stageBands(columns, keep, 0);
  const table = baselineRows(bands);
  assert.deepEqual(
    table,
    [
      { stage: '판매 시작 → 대기열 진입', p1: 0, p50: 50, p99: 300, n: 3 },
      { stage: '대기열 진입 → 입장 확정', p1: 100, p50: 200, p99: 1_000, n: 3 },
      { stage: '입장 확정 → 첫 홀드', p1: 100, p50: 400, p99: 1_000, n: 3 },
      { stage: '첫 홀드 → 결제 시도', p1: 500, p50: 500, p99: 1_000, n: 3 },
      { stage: '결제 시도 → 판매', p1: 1_000, p50: 1_000, p99: 1_000, n: 3 },
    ],
  );

  // 전 행을 도는 기준 구현: 가장 가까운 순위 ceil(p/100 × n).
  const nearest = (values, p) => {
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
    return sorted[rank - 1];
  };
  const reference = [
    ['saleToQueue', [50, 300, 0]],
    ['queueToAdmit', [100, 200, 1_000]],
    ['admitToHold', [100, 400, 1_000]],
    ['holdToPay', [500, 500, 1_000]],
    ['payToSale', [1_000, 1_000, 1_000]],
  ];
  for (const [stage, values] of reference) {
    const band = bands.find((b) => b.stage === stage);
    assert.ok(band, `${stage} 띠가 없다`);
    assert.equal(band.n, values.length);
    assert.equal(band.p1, nearest(values, 1));
    assert.equal(band.p50, nearest(values, 50));
    assert.equal(band.p99, nearest(values, 99));
  }

  // keep=0으로 입장 확정 한 행을 버리면 그 세션의 두 단계가 빠진다.
  const admitIndex = rows.findIndex((row) => row.session === 2 && row.kind === EVENT_KIND.ADMIT);
  const dropped = keepAll(columns.t_ms.length);
  dropped[admitIndex] = 0;
  const afterDrop = stageBands(columns, dropped, 0);
  assert.equal(afterDrop.find((b) => b.stage === 'queueToAdmit').n, 2);
  assert.equal(afterDrop.find((b) => b.stage === 'admitToHold').n, 2);
  assert.equal(afterDrop.find((b) => b.stage === 'saleToQueue').n, 3);

  // 묶음 계정 기준선은 묶음 안 여정만 센다.
  const members = stageBands(columns, keep, 1);
  assert.equal(members.find((b) => b.stage === 'saleToQueue').n, 2);
  assert.equal(members.find((b) => b.stage === 'admitToHold').n, 1);
});

test('FX-T9 ⑤ 후보 영역의 세션 좌석만 점등하고 기기 묶음은 10ms 안 서로 다른 좌석 시도로 센다', () => {
  const burstsOf = need('deviceBursts');
  const seatsOf = need('seatsOfSessions');

  const rows = [
    { t_ms: 1_000, kind: EVENT_KIND.HOLD_TRY, session: 1, seat: 10, device_group: 7 },
    { t_ms: 1_005, kind: EVENT_KIND.HOLD_TRY, session: 2, seat: 11, device_group: 7 },
    { t_ms: 1_010, kind: EVENT_KIND.HOLD_TRY, session: 3, seat: 10, device_group: 7 },
    { t_ms: 1_001, kind: EVENT_KIND.HOLD_TRY, session: 7, seat: NO_SEAT, device_group: 7 },
    { t_ms: 2_000, kind: EVENT_KIND.HOLD_TRY, session: 4, seat: 20, device_group: 8 },
    { t_ms: 2_010, kind: EVENT_KIND.HOLD_TRY, session: 4, seat: 20, device_group: 8 },
    { t_ms: 3_000, kind: EVENT_KIND.HOLD_TRY, session: 5, seat: 30, device_group: 9 },
    { t_ms: 3_011, kind: EVENT_KIND.HOLD_TRY, session: 5, seat: 31, device_group: 9 },
    { t_ms: 4_000, kind: EVENT_KIND.HOLD_TRY, session: 6, seat: 40, device_group: 10 },
    { t_ms: 4_010, kind: EVENT_KIND.HOLD_TRY, session: 6, seat: 41, device_group: 10 },
    { t_ms: 5_000, kind: EVENT_KIND.HOLD_TRY, session: 8, seat: 50, device_group: 0 },
    { t_ms: 5_005, kind: EVENT_KIND.HOLD_TRY, session: 8, seat: 51, device_group: 0 },
    { t_ms: 1_500, kind: EVENT_KIND.SALE, session: 1, seat: 12, device_group: 7 },
  ];
  const columns = build(rows);
  const keep = keepAll(columns.t_ms.length);
  const bursts = burstsOf(columns, keep, 10);
  assert.deepEqual(
    bursts.map((b) => ({ ...b })),
    [
      { deviceGroup: 7, sessions: 3, attempts: 3, firstAtMs: 1_000, lastAtMs: 1_010 },
      { deviceGroup: 10, sessions: 1, attempts: 2, firstAtMs: 4_000, lastAtMs: 4_010 },
    ],
  );

  // 두 번째 행을 버리면 묶음 10은 짝이 없어 사라진다.
  const dropped = keepAll(columns.t_ms.length);
  dropped[9] = 0;
  assert.deepEqual(burstsOf(columns, dropped, 10).map((b) => b.deviceGroup), [7]);

  assert.deepEqual(seatsOf(columns, keep, new Set([1, 2])), [10, 11, 12]);
  assert.deepEqual(seatsOf(columns, keep, new Set([3])), [10]);
  assert.deepEqual(seatsOf(columns, keep, new Set([99])), []);
});

test('FX-T9 ⑥ 연구 원천은 한 축 24칸 분포로 그리고 첫·마지막 칸에 범위 밖 값을 모은다', () => {
  const histogramOf = need('distributionHistogram');
  const points = [
    { session: 1, firstHoldMs: 5, entropy: null, botTier: 0, deviceGroup: 0, member: false },
    { session: 2, firstHoldMs: 10, entropy: null, botTier: 0, deviceGroup: 0, member: false },
    { session: 3, firstHoldMs: 14, entropy: null, botTier: 0, deviceGroup: 0, member: false },
    { session: 4, firstHoldMs: 100, entropy: null, botTier: 0, deviceGroup: 0, member: false },
    { session: 5, firstHoldMs: 1_000, entropy: null, botTier: 0, deviceGroup: 0, member: false },
    { session: 6, firstHoldMs: 9_999, entropy: null, botTier: 0, deviceGroup: 0, member: false },
    { session: 7, firstHoldMs: 10_000, entropy: null, botTier: 0, deviceGroup: 0, member: false },
    { session: 8, firstHoldMs: 20_000, entropy: null, botTier: 0, deviceGroup: 0, member: false },
    { session: 9, firstHoldMs: 0, entropy: null, botTier: 0, deviceGroup: 0, member: false },
  ];
  const histogram = histogramOf(points, 10, 10_000, 24);
  assert.equal(histogram.bins.length, 24);
  assert.equal(histogram.edges.length, 25);
  assert.equal(histogram.minMs, 10);
  assert.equal(histogram.maxMs, 10_000);
  for (let i = 0; i < histogram.edges.length; i += 1) {
    nearly(histogram.edges[i], 10 ** (1 + i / 8), `edges[${i}]`);
  }
  assert.equal(histogram.bins[0], 2, '5ms·10ms는 첫 칸');
  assert.equal(histogram.bins[1], 1, '14ms는 둘째 칸');
  assert.equal(histogram.bins[8], 1, '100ms는 9번째 칸');
  assert.equal(histogram.bins[16], 1, '1s는 17번째 칸');
  assert.equal(histogram.bins[23], 3, '9999ms·10000ms·20000ms는 마지막 칸');
  assert.equal(histogram.bins.reduce((sum, n) => sum + n, 0), 8);
});

test('FX-T9 ⑦ 후보 모델은 원천별 패널 종류와 세션·봇·기기 묶음 수를 함께 낸다', () => {
  const modelOf = need('candidateModel');
  const syntheticRows = [
    admit(1, 50, 0.1, { bot_tier: 3, device_group: 7 }),
    admit(2, 80, 0.2, { device_group: 7 }),
    { t_ms: 10, kind: EVENT_KIND.HOLD_TRY, session: 1, seat: 1, device_group: 7 },
    { t_ms: 15, kind: EVENT_KIND.HOLD_TRY, session: 2, seat: 2, device_group: 7 },
    admit(3, 0, 0.5, { bot_tier: 1 }),
  ];
  const synthetic = modelOf(build(syntheticRows), keepAll(syntheticRows.length), 'SYNTHETIC');
  assert.equal(synthetic.kind, 'scatter');
  assert.equal(synthetic.points.length, 2);
  assert.equal(synthetic.totalSessions, 2);
  assert.equal(synthetic.totalBots, 1);
  assert.equal(synthetic.histogram, null);
  assert.equal(synthetic.bursts.length, 1);

  const researchRows = [
    admit(1, 50, Number.NaN),
    admit(2, 100, Number.NaN, { bot_tier: 2 }),
    admit(3, 300, Number.NaN),
  ];
  const research = modelOf(build(researchRows), keepAll(researchRows.length), 'RESEARCH');
  assert.equal(research.kind, 'distribution');
  assert.deepEqual(research.points, []);
  assert.equal(research.totalSessions, 3);
  assert.equal(research.totalBots, 1);
  assert.ok(research.histogram);
  assert.equal(research.histogram.bins.reduce((sum, n) => sum + n, 0), 3);
  assert.deepEqual(research.bursts, []);

  const investigationRows = [
    admit(1, 50, Number.NaN, { member: 1, device_group: 4 }),
    { t_ms: 10, kind: EVENT_KIND.HOLD_TRY, session: 1, seat: 1, member: 1, device_group: 4 },
    { t_ms: 15, kind: EVENT_KIND.HOLD_TRY, session: 1, seat: 2, member: 1, device_group: 4 },
  ];
  const investigation = modelOf(build(investigationRows), keepAll(investigationRows.length), 'INVESTIGATION');
  assert.equal(investigation.kind, 'baseline');
  assert.deepEqual(investigation.points, []);
  assert.equal(investigation.histogram, null);
  assert.equal(investigation.totalSessions, 1);
  assert.equal(investigation.totalBots, 0);
  assert.equal(investigation.bursts.length, 1);

  // keep=0은 모델의 어느 값에도 들어가지 않는다.
  const keep = keepAll(investigationRows.length);
  keep[1] = 0;
  const dropped = modelOf(build(investigationRows), keep, 'INVESTIGATION');
  assert.deepEqual(dropped.bursts, []);
});
