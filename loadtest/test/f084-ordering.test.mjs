// F-08-4(MSR-040) 정렬 설정 켬/끔 10만 비교 도구·판정·보고서 시험.
//
// 정본: docs/features/queue-admission.md Q-T1(653행)·Q-T23(675행), ADR-0012·ADR-0118,
//       docs/verification.md §3.5(측정 정직성). 계획: docs/review/plans/F-08-4.md §6·§7·§9.
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

/** 실제 장부에 있는 실행 ID. 금지 주장 시험에서 '실행 ID 때문이 아닌' 실패를 가르려고 쓴다 */
const REAL_RUN = '2026-11-01-incr-batch-tls-r1-local-poc';

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
/** Q-T1의 대기 시간 분산이 도착 시각과 무관함을 보는 스피어만 기준([가정, F-08-4 계획] §6.4) */
const QT1_WAIT_RHO = 0.05;
/** Q-T1의 일반 사용자 오탐률 기준(≤ 0.5%) */
const QT1_FALSE_POSITIVE = 0.005;
/** Q-T2/NFR-001의 진입 오류율 기준(< 0.1%)을 Q-T1의 준수 조건으로 쓴다 */
const ENTRY_ERROR_RATE = 0.001;
/** Q-T23의 스피어만 절댓값 기준(≤ 0.05) */
const QT23_RHO = 0.05;
/** Q-T23/ADR-0041의 묶음 구간 2초([가정])와 T=0~T+2초 표본 크기 */
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
    waitRho: 0.02,
    falsePositiveRate: 0.001,
    originalSeqGuarantee: 1,
    botPenetration: { speed: 0.1, volume: 0.2 },
    rho: 0.02,
    p90ArrivalMs: QT23_BATCH_WINDOW_MS - 100,
    publishMs: QT23_PUBLISH_MS - 200,
    proofMatches: true,
    batchShare: 0.4,
    botSuccess: 0.1,
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
  assert.equal(m.ORDERING_CELLS.filter((c) => c.operating).length, 3, '운영 셀은 셋이다');
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

  const d = m.parseOrderingArgs(['--users', '100000', '--out', 'x']);
  assert.deepEqual(d.cells, ['hybrid', 'fifo', 'prequeue'], '기본 셀은 운영 셋뿐이다');
  assert.equal(d.baseline, false);

  const a = m.parseOrderingArgs(['--users', '100000', '--cells', 'hybrid,fifo,prequeue', '--out', '.cache/f084']);
  assert.equal(a.users, 100000);
  assert.deepEqual(a.cells, ['hybrid', 'fifo', 'prequeue']);
  assert.equal(a.baseline, false);
  assert.equal(a.out, '.cache/f084');

  const b = m.parseOrderingArgs(['--users', '10000', '--cells', 'hybrid', '--baseline', '--out', 'x']);
  assert.equal(b.baseline, true);
  assert.deepEqual(b.cells, ['hybrid'], '기준선은 --baseline으로만 더하고 기본 셀에 넣지 않는다');

  expectUsage(() => m.parseOrderingArgs(['--users', '0', '--out', 'x']), /users/);
  expectUsage(() => m.parseOrderingArgs(['--users', '100000', '--cells', 'none', '--out', 'x']), /기준선|none/);
  expectUsage(() => m.parseOrderingArgs(['--users', '100000', '--cells', 'hybrid,none', '--out', 'x']), /기준선|none/);
  expectUsage(() => m.parseOrderingArgs(['--users', '100000', '--bot-rate', '1.1', '--out', 'x']), /bot-rate/);
  expectUsage(() => m.parseOrderingArgs(['--users', '100000']), /out/);
});

test('MSR-040 ② 스피어만: 동점 평균 순위의 표준 순위 피어슨, 분산 0, 작은 표본', async () => {
  const { spearman } = await ordering();
  close(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  close(spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1);
  // 동점은 평균 순위(2, 2.5, 2.5, 4)로 바꾼 뒤 순위 피어슨을 쓴다. 단순식 1−6Σd²/(n(n²−1))는 동점이 없을 때만 같다.
  close(spearman([1, 2, 2, 3], [1, 2, 3, 4]), 0.9486832980505138);
  assert.equal(spearman([1, 2], [2, 1]), null, 'n<3은 null이어야 한다');
  assert.equal(spearman([1, 2, 3], [1, 2, 3, 4]), null, '길이가 다르면 null이어야 한다');
  assert.equal(spearman([1, 1, 1, 1], [1, 2, 3, 4]), 0, '도착 시각이 모두 같으면 속도 차이가 없으므로 0이다');
});

test('MSR-040 ③ 로비 셔플 켬·끔: T=0 RPS·p99·오류율·대기 분산·오탐·원순번, 여섯 조건', async () => {
  const { judgeQT1 } = await ordering();
  const on = cell({ id: 'hybrid', t0PeakRps: 400 });
  const off = cell({ id: 'fifo', lobbyShuffle: false, t0PeakRps: 1000 });

  assert.equal(judgeQT1({ on, off }).verdict, '통과');
  assert.equal(judgeQT1({ on: cell({ t0PeakRps: 600 }), off }).verdict, '미달');
  assert.equal(judgeQT1({ on: cell({ t0PeakRps: 500 }), off }).verdict, '통과', '50% 정각은 통과다');
  assert.equal(judgeQT1({ on: cell({ t0PeakRps: 500.1 }), off }).verdict, '미달');
  assert.equal(judgeQT1({ on: cell({ t0PeakRps: 1000 }), off }).verdict, '미달');

  assert.equal(judgeQT1({ on: cell({ entryP99Ms: QT1_P99_MS }), off }).verdict, '통과');
  assert.equal(judgeQT1({ on: cell({ entryP99Ms: QT1_P99_MS + 0.1 }), off }).verdict, '미달');
  assert.equal(judgeQT1({ on, off: cell({ ...off, entryP99Ms: QT1_P99_MS }) }).verdict, '통과', 'off도 p99 200ms 정각은 통과다');
  assert.equal(judgeQT1({ on, off: cell({ ...off, entryP99Ms: QT1_P99_MS + 0.1 }) }).verdict, '미달');
  assert.equal(judgeQT1({ on: cell({ errorRate: ENTRY_ERROR_RATE }), off }).verdict, '미달');
  assert.equal(judgeQT1({ on: cell({ errorRate: ENTRY_ERROR_RATE - 0.0001 }), off }).verdict, '통과');
  assert.equal(judgeQT1({ on, off: cell({ ...off, errorRate: ENTRY_ERROR_RATE }) }).verdict, '미달');
  assert.equal(judgeQT1({ on, off: cell({ ...off, errorRate: ENTRY_ERROR_RATE - 0.0001 }) }).verdict, '통과');

  assert.equal(judgeQT1({ on: cell({ dropped: 1 }), off }).verdict, '판정 못 함');
  assert.equal(judgeQT1({ on, off: cell({ ...off, dropped: 1 }) }).verdict, '판정 못 함');
  assert.equal(judgeQT1({ on: cell({ runs: 2 }), off }).verdict, '판정 못 함');
  assert.equal(judgeQT1({ on, off: cell({ ...off, runs: 2 }) }).verdict, '판정 못 함');
  assert.equal(judgeQT1({ on: cell({ valid: false }), off }).verdict, '판정 못 함');
  assert.equal(judgeQT1({ on, off: cell({ ...off, valid: false }) }).verdict, '판정 못 함');
  assert.equal(judgeQT1({ on: null, off }).verdict, '판정 못 함');
  assert.equal(judgeQT1({ on, off: null }).verdict, '판정 못 함');

  assert.equal(judgeQT1({ on: cell({ waitRho: QT1_WAIT_RHO }), off }).verdict, '통과');
  assert.equal(judgeQT1({ on: cell({ waitRho: QT1_WAIT_RHO + 0.0001 }), off }).verdict, '미달');
  assert.equal(judgeQT1({ on: cell({ falsePositiveRate: QT1_FALSE_POSITIVE }), off }).verdict, '통과');
  assert.equal(judgeQT1({ on: cell({ falsePositiveRate: QT1_FALSE_POSITIVE + 0.0001 }), off }).verdict, '미달');
  assert.equal(judgeQT1({ on: cell({ originalSeqGuarantee: 1 }), off }).verdict, '통과');
  assert.equal(judgeQT1({ on: cell({ originalSeqGuarantee: 0.999 }), off }).verdict, '미달');
  assert.equal(judgeQT1({ on: cell({ botPenetration: null }), off }).verdict, '미측정');
  assert.equal(judgeQT1({ on: cell({ waitRho: null }), off }).verdict, '미측정');
  assert.equal(judgeQT1({ on: cell({ falsePositiveRate: null }), off }).verdict, '미측정');
  assert.equal(judgeQT1({ on: cell({ originalSeqGuarantee: null }), off }).verdict, '미측정');
  assert.equal(QT1_WAIT_RHO, 0.05);
  assert.equal(QT1_FALSE_POSITIVE, 0.005);
});

test('MSR-040 ④ 오픈 직후 묶음 켬·끔: 두 쌍, 스피어만·p90·게시·재계산, 기준선 표시', async () => {
  const { judgeQT23 } = await ordering();
  const hybrid = cell({ id: 'hybrid', botSuccess: 0.1 });
  const prequeue = cell({ id: 'prequeue', openBatch: false, rho: 0.03, p90ArrivalMs: 1800, publishMs: 4700, botSuccess: 0.2 });
  const fifo = cell({ id: 'fifo', lobbyShuffle: false, rho: 0.01, p90ArrivalMs: 1900, publishMs: 4800, botSuccess: 0.1 });
  const none = cell({ id: 'none', lobbyShuffle: false, openBatch: false, operating: false, rho: 0.02, p90ArrivalMs: 1900, publishMs: 4800, botSuccess: 0.1 });

  const first = judgeQT23({ on: hybrid, off: prequeue });
  assert.equal(first.verdict, '통과');
  assert.equal(first.baseline, false);
  close(first.botDelta, BOT_DELTA);

  const second = judgeQT23({ on: fifo, off: none });
  assert.equal(second.verdict, '통과', '로비 끔·묶음 끔 기준선 쌍도 판정한다');
  assert.equal(second.baseline, true, 'none은 기준선(운영 아님)이다');

  assert.equal(judgeQT23({ on: cell({ ...hybrid, rho: QT23_RHO }), off: prequeue }).verdict, '통과', '0.05 정각은 통과다');
  assert.equal(judgeQT23({ on: cell({ ...hybrid, rho: QT23_RHO + 0.0001 }), off: prequeue }).verdict, '미달');
  assert.equal(judgeQT23({ on: hybrid, off: cell({ ...prequeue, rho: -QT23_RHO - 0.0001 }) }).verdict, '미달');
  assert.equal(judgeQT23({ on: cell({ ...hybrid, p90ArrivalMs: QT23_BATCH_WINDOW_MS }), off: prequeue }).verdict, '통과');
  assert.equal(judgeQT23({ on: cell({ ...hybrid, p90ArrivalMs: QT23_BATCH_WINDOW_MS + 1 }), off: prequeue }).verdict, '미달');
  assert.equal(judgeQT23({ on: cell({ ...hybrid, publishMs: QT23_PUBLISH_MS }), off: prequeue }).verdict, '통과');
  assert.equal(judgeQT23({ on: cell({ ...hybrid, publishMs: QT23_PUBLISH_MS + 1 }), off: prequeue }).verdict, '미달');
  assert.equal(judgeQT23({ on: cell({ ...hybrid, proofMatches: true }), off: prequeue }).verdict, '통과');
  assert.equal(judgeQT23({ on: cell({ ...hybrid, proofMatches: false }), off: prequeue }).verdict, '미달');
  assert.equal(judgeQT23({ on: cell({ ...hybrid, proofMatches: null }), off: prequeue }).verdict, '판정 못 함');
  assert.equal(judgeQT23({ on: cell({ ...hybrid, rho: null }), off: prequeue }).verdict, '판정 못 함');
  assert.equal(judgeQT23({ on: null, off: prequeue }).verdict, '판정 못 함');
  assert.equal(judgeQT23({ on: hybrid, off: null }).verdict, '판정 못 함');
  assert.equal(QT23_RHO, 0.05);
  assert.equal(QT23_BATCH_WINDOW_MS, 2000);
  assert.equal(QT23_PUBLISH_MS, 5000);
});

test('MSR-040 ⑤ 봇 성공률과 10만 상태: 순번·표본률·세 회차 방향으로 센다', async () => {
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

  for (const status of ['무효', '미측정', '판정 못 함', '부분']) {
    assert.equal(tenKStatus({ status }), status);
  }
  const ok = { status: '실측(PC)', runIds: ['2026-11-30-f084-hybrid-r1'], sampleRate: 0.99, runVerdicts: ['실측(PC)', '실측(PC)', '실측(PC)'] };
  assert.equal(tenKStatus(ok), '실측(PC)');
  assert.equal(tenKStatus({ ...ok, sampleRate: 0.989 }), '부분', '99% 미만은 부분이다');
  assert.equal(tenKStatus({ ...ok, runVerdicts: ['실측(PC)', '미달', '실측(PC)'] }), '부분', '세 회차 방향이 섞이면 부분이다');
  assert.throws(() => tenKStatus({ status: '통과' }), /상태|허용/);
  assert.throws(() => tenKStatus({ ...ok, runIds: [] }), /실행 ID/);
  assert.throws(() => tenKStatus({ ...ok, sampleRate: undefined }), /표본|sampleRate/);
  assert.throws(() => tenKStatus({ ...ok, runVerdicts: undefined }), /회차|runVerdicts/);
});

test('MSR-040 ⑥ 보고서: 표시·10만·금지 주장·실행 ID를 각각 가른다', async () => {
  const real = read('docs/review/measurements/F-08-4-ordering.md', 'F-08-4 측정 보고서');
  const { renderReport, validateReport } = await ordering();
  const runExists = (id) => existsSync(P('docs', 'perf-ledger', 'runs', id));
  const md = renderReport({
    title: 'F-08-4 정렬 비교',
    cells: [
      { id: 'hybrid', lobbyShuffle: true, openBatch: true, operating: true, status: '미측정' },
      { id: 'fifo', lobbyShuffle: false, openBatch: true, operating: true, status: '미측정' },
      { id: 'prequeue', lobbyShuffle: true, openBatch: false, operating: true, status: '미측정' },
      { id: 'none', lobbyShuffle: false, openBatch: false, operating: false, status: '기준선(운영 아님)' },
    ],
    rows: [
      { section: 'Q-T1', item: 'hybrid T=0 최고 RPS', value: '미측정', status: '미측정', runId: null },
      { section: 'Q-T23', item: 'hybrid 스피어만', value: '미측정', status: '미측정', runId: null },
      { section: 'Q-T23', item: 'none 기준선', value: '기준선', status: '기준선(운영 아님)', runId: null },
    ],
    tenK: { status: '미측정', reason: '10만 부하 유효 실행 없음' },
    adr: { conclusion: '판단 보류' },
  });
  assert.match(md, /10만[^\n]*미측정/);
  assert.doesNotMatch(md, /10만[^\n]*실측\(PC\)/);
  assert.match(md, /운영 셀: 3/);
  const checked = validateReport(md);
  assert.equal(checked.operatingCells, 3, '보고서 운영 셀 수는 3이다');
  assert.equal(checked.baselineCells, 1, '보고서 기준선 셀 수는 1이다');
  assert.equal(validateReport(md, { runExists: () => true }).operatingCells, 3);

  assert.throws(() => validateReport(md.replace('미측정', '실측(PC)')), /실측|실행 ID|미측정/);
  const claim = (row) => `${md}\n| Q-T1 | ${row} | 1 | 실측(PC) | ${REAL_RUN} |\n`;
  assert.throws(() => validateReport(claim('초당 30,000건을 달성했다')), /30,000|금지/);
  assert.throws(() => validateReport(claim('100만을 달성했다')), /100만|금지/);
  assert.throws(() => validateReport(claim('K1 통과')), /K1|금지/);
  assert.throws(() => validateReport(claim('K2 통과')), /K2|금지/);
  assert.throws(() => validateReport(claim('K7 통과')), /K7|금지/);
  assert.throws(() => validateReport(`${md}\n| Q-T1 | 초당 1,000건 | 1,000 | | |\n`), /표시/);
  assert.throws(
    () => validateReport(`${md}\n| Q-T1 | 값 | 1 | 실측(PC) | 2026-11-30-f084-fake |\n`, { runExists: () => false }),
    /실행 ID|장부/,
  );
  assert.throws(() => validateReport(md.replace('기준선(운영 아님)', '통과')), /기준선|none/);
  assert.throws(() => validateReport(md.replace('기준선(운영 아님)', '운영')), /기준선|운영|none/);
  assert.throws(() => validateReport(md.replace('운영 셀: 3', '운영 셀: 4')), /운영 셀|3/);
  const noneOperating = md.replace(/^(\| none \|[^\n]*\| )아니오( \| 기준선\(운영 아님\) \|)$/m, '$1예$2');
  assert.notEqual(noneOperating, md, 'none 행의 운영 칸을 찾지 못했다');
  assert.throws(() => validateReport(noneOperating), /운영|기준선|none/);

  const realChecked = validateReport(real, { runExists });
  assert.equal(realChecked.operatingCells, 3, '실제 보고서의 운영 셀 수는 3이다');
  const measuredRows = real
    .split(/\r?\n/)
    .filter((line) => line.trimStart().startsWith('|') && line.includes('실측(PC)'));
  for (const row of measuredRows) {
    const ids = [...row.matchAll(/(20\d{2}-\d{2}-\d{2}-[A-Za-z0-9][A-Za-z0-9-]*)/g)].map((m) => m[1]);
    assert.ok(ids.length >= 1, '실측(PC) 표 줄마다 실행 ID가 있어야 한다');
    for (const id of ids) assert.ok(runExists(id), `실행 ID가 장부에 없다: ${id}`);
  }
  const tenKLine = real.split(/\r?\n/).find((line) => line.includes('10만'));
  assert.ok(tenKLine, '10만 줄이 있어야 한다');
  if (/10만[^\n]*실측\(PC\)/.test(tenKLine)) assert.match(tenKLine, /순번 표본/, '10만 실측(PC)는 순번 표본일 때만이다');
  else assert.match(tenKLine, /미측정|무효|부분|판정 못 함/);
});

test('MSR-040 ⑦ ADR 재검토: 상태 줄·10%p 경계·분기, ADR을 고치지 않는다', async () => {
  const adr12 = read('docs/adr/0012-queue-ordering-hybrid-shuffle-default.md', 'ADR-0012');
  const adr118 = read('docs/adr/0118-queue-ordering-two-settings-lobby-shuffle-open-batch.md', 'ADR-0118');
  const adr = read('docs/review/measurements/F-08-4-adr-review.md', 'F-08-4 ADR 재검토');
  const { reviewAdrs } = await ordering();

  assert.match(adr12, /^- \*\*상태\*\*: 채택/m, 'ADR-0012 상태 줄이 채택이어야 한다');
  assert.match(adr118, /^- \*\*상태\*\*: 채택/m, 'ADR-0118 상태 줄이 채택이어야 한다');
  assert.doesNotMatch(adr12, /RV084|F-08-4/, 'ADR-0012를 이 기능이 고치지 않았다');
  assert.doesNotMatch(adr118, /RV084|F-08-4/, 'ADR-0118을 이 기능이 고치지 않았다');

  const base = { q1: { verdict: '판정 못 함' }, q23: { verdict: '판정 못 함' }, tenK: { status: '미측정' }, partnerChoice: null };
  const hold = reviewAdrs(base);
  assert.equal(hold.conclusion, '판단 보류');
  assert.deepEqual(hold.adrChanges, []);
  assert.match(hold.reasons.join(' '), /측정|판단/);

  const measured = { q1: { verdict: '통과', peakRatio: 0.4 }, q23: { verdict: '통과' }, tenK: { status: '실측(PC)' }, partnerChoice: null };
  const exact = reviewAdrs({ ...measured, q23: { verdict: '통과', botSuccess: { hybrid: 0.2, prequeue: 0.3 } } });
  assert.equal(exact.conclusion, 'openBatch 고정 검토', '10%p 정각은 검토 조건이다');
  assert.deepEqual(exact.adrChanges, []);
  assert.match(exact.next, /새 ADR|소유자/);

  assert.equal(
    reviewAdrs({ ...measured, q23: { verdict: '통과', botSuccess: { hybrid: 0.2, prequeue: 0.299 } } }).conclusion,
    '현행 유지',
    '9.9%p는 검토 조건이 아니다',
  );
  assert.equal(
    reviewAdrs({ ...measured, q23: { verdict: '미달', botSuccess: { hybrid: 0.1, prequeue: 0.5 } } }).conclusion,
    'openBatch 고정 검토',
    'Q-T23 판정과 봇 성공률 조건을 섞지 않는다',
  );
  assert.equal(
    reviewAdrs({ ...measured, q1: { verdict: '미달', peakRatio: 0.6 }, q23: { verdict: '통과', botSuccess: { hybrid: 0.2, prequeue: 0.2 } } }).conclusion,
    '로비 셔플 재검토',
  );
  assert.equal(
    reviewAdrs({ ...measured, q23: { verdict: '통과', botSuccess: { hybrid: 0.2, prequeue: 0.25 } } }).conclusion,
    '현행 유지',
  );
  assert.equal(reviewAdrs({ ...measured, q23: { verdict: '통과' } }).conclusion, '판단 보류', '봇 성공률이 없으면 판단하지 않는다');

  assert.match(adr, /ADR-0012/);
  assert.match(adr, /ADR-0118/);
  assert.match(adr, /adrChanges[^\n]*\[\]|ADR 변경[^\n]*없음/, 'ADR 변경 없음을 적어야 한다');
});

test('MSR-040 ⑧ 시나리오·계획 파일·계획 경계: 네 셀, 측정 창 4, F-08-3/F-08-5를 침범하지 않는다', async () => {
  const scenario = read('loadtest/scenarios/v1-ordering.js', '정렬 측정 시나리오');
  for (const needle of ['ORDERING_CELL', 'lobbyShuffle', 'openBatch', 'arrivalMs', 'sequence', 'batch', 'BATCHING', 'batch-results']) {
    assert.match(scenario, new RegExp(needle), `시나리오에 ${needle}가 없다`);
  }
  const planFile = JSON.parse(read('loadtest/plan/f084-plan.json', 'F-08-4 실행 계획'));
  const planText = JSON.stringify(planFile);
  for (const needle of ['hybrid', 'fifo', 'prequeue', 'none', 'lane4-F-08-4', 'records.ndjson', 'shuffle-proof']) {
    assert.ok(planText.includes(needle), `실행 계획에 ${needle}가 없다`);
  }
  assert.match(planText, /"window"\s*:\s*4/, '실행 계획은 측정 창 4다');

  const plan = read('docs/review/plans/F-08-4.md', 'F-08-4 계획');
  for (const needle of ['측정 창 4', 'docker lane4-F-08-4', 'F-08-3', 'F-08-5', '미측정', 'Q-T1', 'Q-T23', 'T=0~T+2초', 'proofMatches', 'sampleRate']) {
    assert.match(plan, new RegExp(needle), `계획에 ${needle}가 없다`);
  }
  const build = read('docs/BUILD_ORDER.md', 'BUILD_ORDER');
  assert.match(build, /\| F-08-4 \|[^\n]*\| Q-T1, Q-T23 \|/, 'F-08-4 장부 범위가 Q-T1·Q-T23으로 좁혀지지 않았다');
});
