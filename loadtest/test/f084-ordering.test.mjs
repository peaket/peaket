// F-08-4(MSR-040) 정렬 설정 켬/끔 10만 비교 도구·판정·보고서 시험.
//
// 정본: docs/features/queue-admission.md Q-T1(653행)·Q-T23(675행), ADR-0012·ADR-0118,
//       docs/verification.md §3.5(측정 정직성). 계획: docs/review/plans/F-08-4.md §6·§9.
// 이 시험은 Docker·kind·k6를 쓰지 않는다. 새 모듈은 시험마다 동적 import로 불러
// 구현 전 트리에서 시험마다 따로 실패하게 한다.
// 실행(저장소 뿌리): node --test loadtest/test/f084-ordering.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const P = (...parts) => join(ROOT, ...parts);

/** 새 측정 도구(구현 몫). 구현 전 트리에는 없다 */
const ordering = () => import('../runner/ordering.mjs');

function read(rel, what) {
  const path = P(rel);
  assert.ok(existsSync(path), `${what}가 없다: ${rel} (구현 전 기준 실패면 이 실패가 맞다)`);
  return readFileSync(path, 'utf8');
}

/** UsageError(이름으로 본다)로 거부하는지. 메시지는 한국어이고 문제의 인자 이름을 담는다 */
function expectUsage(fn, flagRe) {
  assert.throws(fn, (e) => {
    assert.equal(e?.name, 'UsageError', `UsageError가 아니다: ${e?.name}: ${e?.message}`);
    assert.match(e.message, /[가-힣]/);
    if (flagRe) assert.match(e.message, flagRe);
    return true;
  });
}

/** Q-T1의 진입 p99 기준(≤ 200ms). 코드 상수가 아니라 정본 글에서 옮긴 값이다 */
const QT1_P99_MS = 200;
/** Q-T1 'T=0 최고 RPS가 뚜렷이 낮아야'의 이 계획 값([가정, F-08-4 계획] §6.4) */
const QT1_PEAK_RATIO = 0.5;
/** Q-T2/NFR-001의 진입 오류율 기준(< 0.1%)을 Q-T1의 준수 조건으로 쓴다 */
const ENTRY_ERROR_RATE = 0.001;
/** Q-T23의 스피어만 절댓값 기준(≤ 0.05) */
const QT23_RHO = 0.05;
/** Q-T23/ADR-0041의 묶음 구간 2초([가정]) */
const QT23_BATCH_WINDOW_MS = 2000;
/** Q-T23의 결과 파일 게시 기준(5초 이내) */
const QT23_PUBLISH_MS = 5000;
/** ADR-0118 되돌릴 조건의 '뚜렷이'를 이 계획이 10%p로 정했다([가정, F-08-4 계획] §7) */
const BOT_DELTA = 0.1;

/** 셀 요약 하나(§6.3 산출물 꼴). 바꿀 칸만 덮어 쓴다 */
function cell(over = {}) {
  return {
    id: 'hybrid',
    lobbyShuffle: true,
    openBatch: true,
    operating: true,
    valid: true,
    runs: 3,
    t0PeakRps: 400,
    entryP99Ms: 150,
    errorRate: 0.0005,
    dropped: 0,
    ...over,
  };
}

function close(actual, expected, eps = 1e-12) {
  assert.equal(typeof actual, 'number', `숫자가 아니다: ${actual}`);
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} ≠ ${expected}`);
}

test('MSR-040 ① 정렬 셀과 인자: 운영 셋과 시험 기준선 하나, 둘 다 끈 조합은 운영이 아니다', async () => {
  const m = await ordering();
  assert.ok(Array.isArray(m.ORDERING_CELLS), 'ORDERING_CELLS 배열이 없다');
  const byId = new Map(m.ORDERING_CELLS.map((c) => [c.id, c]));
  assert.deepEqual([...byId.keys()].sort(), ['fifo', 'hybrid', 'none', 'prequeue']);
  assert.deepEqual(
    [byId.get('hybrid').lobbyShuffle, byId.get('hybrid').openBatch, byId.get('hybrid').operating],
    [true, true, true],
  );
  assert.deepEqual(
    [byId.get('fifo').lobbyShuffle, byId.get('fifo').openBatch, byId.get('fifo').operating],
    [false, true, true],
  );
  assert.deepEqual(
    [byId.get('prequeue').lobbyShuffle, byId.get('prequeue').openBatch, byId.get('prequeue').operating],
    [true, false, true],
  );
  assert.deepEqual(
    [byId.get('none').lobbyShuffle, byId.get('none').openBatch, byId.get('none').operating],
    [false, false, false],
  );
  for (const c of m.ORDERING_CELLS) {
    assert.ok(!(c.lobbyShuffle === false && c.openBatch === false && c.operating === true), `둘 다 끈 조합을 운영으로 표시했다: ${c.id}`);
  }

  const a = m.parseOrderingArgs(['--users', '100000', '--cells', 'hybrid,fifo,prequeue', '--out', '.cache/f084']);
  assert.equal(a.users, 100000);
  assert.deepEqual(a.cells, ['hybrid', 'fifo', 'prequeue']);
  assert.equal(a.baseline, false);
  assert.equal(a.out, '.cache/f084');

  const b = m.parseOrderingArgs(['--users', '10000', '--cells', 'hybrid', '--baseline', '--out', 'x']);
  assert.equal(b.baseline, true);
  assert.deepEqual(b.cells, ['hybrid']);

  expectUsage(() => m.parseOrderingArgs(['--users', '0', '--out', 'x']), /users/);
  expectUsage(() => m.parseOrderingArgs(['--users', '100000', '--cells', 'none', '--out', 'x']), /기준선|none/);
  expectUsage(() => m.parseOrderingArgs(['--users', '100000', '--cells', 'hybrid,none', '--out', 'x']), /기준선|none/);
  expectUsage(() => m.parseOrderingArgs(['--users', '100000', '--bot-rate', '1.1', '--out', 'x']), /bot-rate/);
  expectUsage(() => m.parseOrderingArgs(['--users', '100000']), /out/);
});

test('MSR-040 ② 스피어만: 순위 상관, 동점 평균 순위, 분산 0, 작은 표본', async () => {
  const { spearman } = await ordering();
  close(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  close(spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1);
  close(spearman([1, 2, 2, 3], [1, 2, 3, 4]), 0.95);
  assert.equal(spearman([1, 2], [2, 1]), null, 'n<3은 null이어야 한다');
  assert.equal(spearman([1, 2, 3], [1, 2, 3, 4]), null, '길이가 다르면 null이어야 한다');
  assert.equal(spearman([1, 1, 1, 1], [1, 2, 3, 4]), 0, '도착 시각이 모두 같으면 속도 차이가 없으므로 0이다');
});

test('MSR-040 ③ 로비 셔플 켬·끔: T=0 최고 RPS·진입 p99, 무효·회차 부족은 통과가 아니다', async () => {
  const { judgeQT1 } = await ordering();
  const on = cell({ id: 'hybrid', t0PeakRps: 400 });
  const off = cell({ id: 'fifo', lobbyShuffle: false, t0PeakRps: 1000 });

  assert.equal(judgeQT1({ on, off }).verdict, '통과');
  assert.equal(judgeQT1({ on: cell({ t0PeakRps: 600 }), off }).verdict, '미달');
  assert.equal(judgeQT1({ on: cell({ t0PeakRps: 1000 }), off }).verdict, '미달');
  assert.equal(judgeQT1({ on: cell({ entryP99Ms: QT1_P99_MS }), off }).verdict, '통과');
  assert.equal(judgeQT1({ on: cell({ entryP99Ms: QT1_P99_MS + 0.1 }), off }).verdict, '미달');
  assert.equal(judgeQT1({ on: cell({ errorRate: ENTRY_ERROR_RATE }), off }).verdict, '미달');
  assert.equal(judgeQT1({ on: cell({ errorRate: ENTRY_ERROR_RATE - 0.0001 }), off }).verdict, '통과');
  assert.equal(judgeQT1({ on: cell({ dropped: 1 }), off }).verdict, '판정 못 함');
  assert.equal(judgeQT1({ on: cell({ valid: false }), off }).verdict, '판정 못 함');
  assert.equal(judgeQT1({ on: null, off }).verdict, '판정 못 함');
  assert.equal(judgeQT1({ on: cell({ runs: 2 }), off }).verdict, '판정 못 함');
  assert.equal(judgeQT1({ on: cell({ t0PeakRps: 500 }), off }).verdict, '통과', '50% 정각은 통과다');
  assert.equal(judgeQT1({ on: cell({ t0PeakRps: 500.1 }), off }).verdict, '미달');
  assert.equal(QT1_PEAK_RATIO, 0.5);
});

test('MSR-040 ④ 오픈 직후 묶음 켬·끔: 스피어만·p90·게시 시간, 둘 다 끈 기준선은 운영이 아니다', async () => {
  const { judgeQT23 } = await ordering();
  const good = {
    cell: { id: 'hybrid', operating: true },
    rho: 0.02,
    p90ArrivalMs: QT23_BATCH_WINDOW_MS - 100,
    publishMs: QT23_PUBLISH_MS - 200,
    batchShare: 0.4,
    botSuccess: { hybrid: 0.1, prequeue: 0.2 },
  };

  assert.equal(judgeQT23(good).verdict, '통과');
  assert.equal(judgeQT23({ ...good, rho: QT23_RHO }).verdict, '통과', '0.05 정각은 통과다');
  assert.equal(judgeQT23({ ...good, rho: QT23_RHO + 0.0001 }).verdict, '미달');
  assert.equal(judgeQT23({ ...good, rho: -QT23_RHO - 0.0001 }).verdict, '미달');
  assert.equal(judgeQT23({ ...good, p90ArrivalMs: QT23_BATCH_WINDOW_MS }).verdict, '통과');
  assert.equal(judgeQT23({ ...good, p90ArrivalMs: QT23_BATCH_WINDOW_MS + 1 }).verdict, '미달');
  assert.equal(judgeQT23({ ...good, publishMs: QT23_PUBLISH_MS }).verdict, '통과');
  assert.equal(judgeQT23({ ...good, publishMs: QT23_PUBLISH_MS + 1 }).verdict, '미달');
  assert.equal(judgeQT23({ ...good, rho: null }).verdict, '판정 못 함');

  const baseline = judgeQT23({ ...good, cell: { id: 'none', operating: false } });
  assert.notEqual(baseline.verdict, '통과');
  assert.match(baseline.verdict, /기준선/);
  assert.equal(BOT_DELTA, 0.1);
});

test('MSR-040 ⑤ 봇 성공률과 10만 상태: 순번으로 세고, 10만은 정해진 상태만 쓴다', async () => {
  const { botSuccess, tenKStatus } = await ordering();
  const people = [
    { kind: 'human', sequence: 1 },
    { kind: 'human', sequence: 2 },
    { kind: 'speed', sequence: 3 },
    { kind: 'speed', sequence: 30 },
    { kind: 'volume', sequence: 4 },
    { kind: 'volume', sequence: 40 },
    { kind: 'volume', sequence: 50 },
  ];
  const rates = botSuccess(people, 10);
  close(rates.human, 1);
  close(rates.speed, 0.5);
  close(rates.volume, 1 / 3);
  assert.equal(botSuccess(people, null), null);

  for (const status of ['실측(PC)', '무효', '미측정', '판정 못 함', '부분']) {
    assert.equal(tenKStatus({ status }), status);
  }
  assert.equal(tenKStatus({ status: '실측(PC)', runIds: ['2026-11-30-f084-hybrid-r1'] }), '실측(PC)');
  assert.throws(() => tenKStatus({ status: '통과' }), /상태|허용/);
  assert.throws(() => tenKStatus({ status: '실측(PC)', runIds: [] }), /실행 ID/);
});

test('MSR-040 ⑥ 보고서: 숫자마다 표시, 10만 미측정을 실측으로 바꾸면 실패, 금지 주장', async () => {
  const real = read('docs/review/measurements/F-08-4-ordering.md', 'F-08-4 측정 보고서');
  const { renderReport, validateReport } = await ordering();
  const md = renderReport({
    title: 'F-08-4 정렬 비교',
    rows: [
      { section: 'Q-T1', item: 'hybrid T=0 최고 RPS', value: '미측정', status: '미측정', runId: null },
      { section: 'Q-T23', item: 'hybrid 스피어만', value: '미측정', status: '미측정', runId: null },
    ],
    tenK: { status: '미측정', reason: '10만 부하 유효 실행 없음' },
    adr: { conclusion: '판단 보류' },
  });
  assert.match(md, /10만[^\n]*미측정/);
  assert.doesNotMatch(md, /10만[^\n]*실측\(PC\)/);
  assert.doesNotThrow(() => validateReport(md));

  const bad = md.replace('미측정', '실측(PC)');
  assert.throws(() => validateReport(bad), /실측|실행 ID|미측정/);
  assert.throws(
    () => validateReport(`${md}\n| Q-T1 | 초당 30,000건을 달성했다 | 30,000 | 실측(PC) | 2026-11-30-f084-x |\n`),
    /30,000|금지/,
  );

  assert.doesNotThrow(() => validateReport(real));
  const measuredRows = real
    .split(/\r?\n/)
    .filter((line) => line.trimStart().startsWith('|') && line.includes('실측(PC)'));
  for (const row of measuredRows) {
    const ids = [...row.matchAll(/(20\d{2}-\d{2}-\d{2}-[A-Za-z0-9][A-Za-z0-9-]*)/g)].map((m) => m[1]);
    assert.ok(ids.length >= 1, '실측(PC) 표 줄마다 실행 ID가 있어야 한다');
    for (const id of ids) {
      assert.ok(existsSync(P('docs', 'perf-ledger', 'runs', id)), `실행 ID가 장부에 없다: ${id}`);
    }
  }
});

test('MSR-040 ⑦ ADR 재검토: 측정 전 판단 보류, ADR 상태를 바꾸지 않는다', async () => {
  const adr = read('docs/review/measurements/F-08-4-adr-review.md', 'F-08-4 ADR 재검토');
  const { reviewAdrs } = await ordering();
  const hold = reviewAdrs({
    q1: { verdict: '판정 못 함' },
    q23: { verdict: '판정 못 함' },
    tenK: { status: '미측정' },
    partnerChoice: null,
  });
  assert.equal(hold.conclusion, '판단 보류');
  assert.deepEqual(hold.adrChanges, []);
  assert.match(hold.reasons.join(' '), /측정|판단/);

  const rec = reviewAdrs({
    q1: { verdict: '통과', peakRatio: 0.4 },
    q23: { verdict: '미달', botSuccess: { hybrid: 0.1, prequeue: 0.5 } },
    tenK: { status: '실측(PC)' },
    partnerChoice: null,
  });
  assert.equal(rec.conclusion, 'openBatch 고정 검토');
  assert.deepEqual(rec.adrChanges, []);
  assert.match(rec.next, /새 ADR|소유자/);

  assert.match(adr, /ADR-0012/);
  assert.match(adr, /ADR-0118/);
  assert.match(adr, /ADR 변경[^\n]*없음|adrChanges[^\n]*\[\]|판단 보류|현행 유지/);
  assert.doesNotMatch(adr, /새 ADR[^\n]*채택/);
});

test('MSR-040 ⑧ 시나리오·계획 경계: 셀·도착 시각·순번, 측정 창 4, F-08-3/F-08-5를 침범하지 않는다', async () => {
  const scenario = read('loadtest/scenarios/v1-ordering.js', '정렬 측정 시나리오');
  for (const needle of ['ORDERING_CELL', 'lobbyShuffle', 'openBatch', 'arrivalMs', 'sequence']) {
    assert.match(scenario, new RegExp(needle), `시나리오에 ${needle}가 없다`);
  }
  const plan = read('docs/review/plans/F-08-4.md', 'F-08-4 계획');
  for (const needle of ['측정 창 4', 'docker lane4-F-08-4', 'F-08-3', 'F-08-5', '미측정', 'Q-T1', 'Q-T23']) {
    assert.match(plan, new RegExp(needle), `계획에 ${needle}가 없다`);
  }
  const build = read('docs/BUILD_ORDER.md', 'BUILD_ORDER');
  assert.match(build, /\| F-08-4 \|[^\n]*\| Q-T1, Q-T23 \|/, 'F-08-4 장부 범위가 Q-T1·Q-T23으로 좁혀지지 않았다');
});
