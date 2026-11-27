// F-08-10 서비스 분리 효과 비교 준비 시험(F0810-1~5): V-T18 판정기·인자·비교 규칙·M2 초안 계약.
// 정본: docs/verification.md §3.8(260~284행)·V-T18(644행), docs/perf-ledger.md §2.2 experiment(65행),
// docs/planning/02-requirements.md NFR-001(162행)·NFR-005(166행), 계획 docs/review/plans/F-08-10.md 6~7절.
// 단언 값은 정본에서 가져와 이 파일에 적는다(구현 상수를 가져오지 않는다).
// Docker·kind·브라우저·k6를 쓰지 않는다. 실행: node --test loadtest/test/f0810-split-compare.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** 새 모듈을 읽고 공개 이름이 있는지 먼저 본다. 기준 트리에서는 모듈이 없어 여기서 실패한다(계획 9절). */
async function split() {
  let m;
  try {
    m = await import('../runner/split-compare.mjs');
  } catch (e) {
    assert.fail(`runner/split-compare.mjs를 읽지 못했다: ${e?.message ?? e}`);
  }
  for (const name of [
    'parseCompareArgs', 'assertLocalConfig', 'experimentFor', 'manifestNotes', 'judgeCompareRun',
    'compareSamples', 'judgeNoDifference', 'compareExperiment', 'renderComparison', 'validateDrafts',
  ]) assert.equal(typeof m[name], 'function', `${name} 공개 함수가 없다`);
  for (const name of ['SPLIT_RULES', 'M2_DRAFTS', 'UsageError']) assert.ok(m[name], `${name} 공개 이름이 없다`);
  return m;
}

const usage = (fn) =>
  assert.throws(fn, (e) => e?.name === 'UsageError', 'UsageError로 거부해야 한다');

const metrics = (paymentP99Ms, paymentErrorRate, entryP99Ms, entryErrorRate, cpuThrottleRatio) => ({
  paymentP99Ms,
  paymentErrorRate,
  entryP99Ms,
  entryErrorRate,
  cpuThrottleRatio,
});

/** 실행 하나(계획 7.2의 compareExperiment 입력) */
const run = (config, entry, rep, m = metrics(100, 0.0001, 50, 0.0001, 0.01), valid = true) => ({ config, entry, rep, valid, metrics: m });

/** (가)·(나) 두 구성 × 세 단계 × 세 회차. 값은 시험이 손으로 정한 합성값이고 측정값이 아니다. */
function localRuns() {
  const out = [];
  for (const config of ['bundle', 'by-role']) {
    for (const entry of ['none', '100', '120']) {
      for (const rep of [1, 2, 3]) out.push(run(config, entry, rep, metrics(100 + rep, 0.0001, 50 + rep, 0.0001, 0.01)));
    }
  }
  return out;
}

test('F0810-1 ① SPLIT_RULES: 세 구성·로컬 두 구성·진입 0/100/120%·3회·결제 300 TPS·NFR-005/NFR-001 값·비교 규칙이 정본과 같다', async () => {
  const { SPLIT_RULES } = await split();
  assert.equal(SPLIT_RULES.experiment, 'split-3way');
  assert.deepEqual(SPLIT_RULES.configs, ['bundle', 'by-role', 'services']);
  assert.deepEqual(SPLIT_RULES.localConfigs, ['bundle', 'by-role']);
  assert.deepEqual(SPLIT_RULES.entryLevels, [
    { key: 'none', ratio: 0 },
    { key: '100', ratio: 1 },
    { key: '120', ratio: 1.2 },
  ]);
  assert.equal(SPLIT_RULES.reps, 3);
  assert.equal(SPLIT_RULES.paymentTps, 300);
  // NFR-005: 결제 접수 p99 150ms 미만, 가용성 99.95% 이상 → 오류율 0.0005 이하
  assert.equal(SPLIT_RULES.paymentP99Ms, 150);
  assert.equal(SPLIT_RULES.paymentAvailability, 0.9995);
  // NFR-001: 진입 p99 200ms 이하, 오류율 0.1% 미만
  assert.equal(SPLIT_RULES.entryP99Ms, 200);
  assert.equal(SPLIT_RULES.entryErrorRate, 0.001);
  assert.equal(SPLIT_RULES.noDifference, 'max-spread');
});

test('F0810-1 ② parseCompareArgs: 300 TPS·진입 도착률·회차·기록 인자를 읽고, 100/120%는 --entry-max-rate가 필수이며 services는 로컬에서 거부한다', async () => {
  const { parseCompareArgs, assertLocalConfig } = await split();
  const base = parseCompareArgs(['--config', 'bundle', '--entry', 'none', '--rep', '1']);
  assert.equal(base.config, 'bundle');
  assert.equal(base.entry, 'none');
  assert.equal(base.rep, 1);
  assert.equal(base.paymentTps, 300);
  assert.equal(base.entryMaxRate, null);
  assert.equal(base.entryRate, 0);
  assert.equal(base.warmupSeconds, 30);
  assert.equal(base.mainSeconds, 120);
  assert.equal(base.drainSeconds, 20);

  const hundred = parseCompareArgs(['--config', 'by-role', '--entry', '100', '--rep', '2', '--entry-max-rate', '1000', '--payment-tps', '300', '--record', '--run-id', 'r1-f0810', '--out', 'x', '--prom-url', 'http://127.0.0.1:9090']);
  assert.equal(hundred.entryRate, 1000);
  assert.equal(hundred.record, true);
  assert.equal(hundred.runId, 'r1-f0810');
  assert.equal(hundred.out, 'x');
  assert.equal(hundred.promUrl, 'http://127.0.0.1:9090');

  const over = parseCompareArgs(['--config', 'bundle', '--entry', '120', '--entry-max-rate', '1234']);
  assert.equal(over.entryRate, 1481, '120%는 반올림한다');

  usage(() => parseCompareArgs(['--config', 'bundle', '--entry', '100']));
  usage(() => parseCompareArgs(['--config', 'bundle', '--entry', 'none', '--entry-max-rate', '1000']));
  usage(() => parseCompareArgs(['--config', 'bundle', '--entry', 'none', '--rep', '4']));
  usage(() => parseCompareArgs(['--config', 'bundle', '--entry', 'none', '--payment-tps', '0']));
  usage(() => parseCompareArgs(['--config', 'bundle', '--entry', 'none', '--main', '29']));
  usage(() => parseCompareArgs(['--config', 'bundle', '--unknown', '1']));

  const services = parseCompareArgs(['--config', 'services']);
  assert.equal(services.config, 'services');
  usage(() => assertLocalConfig('services'));
  assert.doesNotThrow(() => assertLocalConfig('bundle'));
  assert.doesNotThrow(() => assertLocalConfig('by-role'));
});

test('F0810-2 ① experimentFor·manifestNotes: 실험 묶음 ID와 구성만 쓰고, notes에 구성·단계·회차·실행이 있으며 KPI ID가 없다', async () => {
  const { experimentFor, manifestNotes } = await split();
  assert.deepEqual(experimentFor({ config: 'by-role', runId: 'r1-f0810' }), { id: 'split-3way', config: 'by-role' });
  const notes = manifestNotes({ config: 'bundle', entry: '100', rep: 2, runId: 'r2-f0810' });
  for (const s of ['bundle', '100', '2', 'r2-f0810']) assert.ok(notes.includes(s), `notes에 ${s}가 없다: ${notes}`);
  assert.doesNotMatch(notes, /K[127]/, 'notes에 KPI ID를 쓰지 않는다');
});

test('F0810-2 ② compareSamples: 홀수·짝수 중앙값과 최솟값·최댓값·편차를 내고, 빈 표본은 count 0·null이다', async () => {
  const { compareSamples } = await split();
  assert.deepEqual(compareSamples([100, 120, 110]), { count: 3, median: 110, min: 100, max: 120, spread: 20 });
  assert.deepEqual(compareSamples([100, 120, 110, 130]), { count: 4, median: 115, min: 100, max: 130, spread: 30 });
  assert.deepEqual(compareSamples([5]), { count: 1, median: 5, min: 5, max: 5, spread: 0 });
  assert.deepEqual(compareSamples([]), { count: 0, median: null, min: null, max: null, spread: null });
});

test('F0810-3 ① judgeNoDifference: 3회 미만은 무효, 중앙값 차이가 두 구성 편차의 최댓값 이하면 차이 없음, 경계값은 차이 없음이다', async () => {
  const { judgeNoDifference } = await split();
  const no = judgeNoDifference([100, 110, 120], [105, 115, 125]);
  assert.equal(no.valid, true);
  assert.equal(no.diff, 5);
  assert.equal(no.spread, 20);
  assert.equal(no.noDifference, true);

  const yes = judgeNoDifference([100, 110, 120], [200, 210, 220]);
  assert.equal(yes.valid, true);
  assert.equal(yes.diff, 100);
  assert.equal(yes.spread, 20);
  assert.equal(yes.noDifference, false);

  const boundary = judgeNoDifference([100, 110, 120], [130, 130, 130]);
  assert.equal(boundary.diff, 20);
  assert.equal(boundary.spread, 20);
  assert.equal(boundary.noDifference, true, '경계값(같음)은 차이 없음이다');

  const short1 = judgeNoDifference([100], [105, 115, 125]);
  assert.equal(short1.valid, false);
  assert.equal(short1.noDifference, null, '1회 표본은 차이 없음이 아니다');
  const short2 = judgeNoDifference([100, 110], [105, 115, 125]);
  assert.equal(short2.valid, false);
  assert.equal(short2.noDifference, null, '2회 표본은 차이 없음이 아니다');
  const empty = judgeNoDifference([], []);
  assert.equal(empty.valid, false);
  assert.equal(empty.noDifference, null, '빈 표본은 차이 없음이 아니다');
  assert.equal(judgeNoDifference([100, 110, 120], [105, 115, 125]).noDifference, true);
});

test('F0810-3 ② compareExperiment: (가)·(나) 3회씩이면 partial·(다) 미측정, 회차가 빠지거나 빈 실행이면 invalid다', async () => {
  const { compareExperiment } = await split();
  const result = compareExperiment(localRuns());
  assert.equal(result.verdict, 'partial');
  assert.equal(result.services, '미측정');
  assert.equal(result.adr0007, '미측정');
  assert.deepEqual(result.missing, []);
  assert.equal(result.comparisons.length, 15, '5지표 × 3단계 비교가 있어야 한다');
  for (const metric of ['paymentP99Ms', 'paymentErrorRate', 'entryP99Ms', 'entryErrorRate', 'cpuThrottleRatio']) {
    for (const entry of ['none', '100', '120']) {
      const c = result.comparisons.find((x) => x.metric === metric && x.entry === entry);
      assert.ok(c, `${metric}/${entry} 비교가 없다`);
      assert.equal(typeof c.a.median, 'number', `${metric}/${entry} a.median`);
      assert.equal(typeof c.a.spread, 'number', `${metric}/${entry} a.spread`);
      assert.equal(typeof c.b.median, 'number', `${metric}/${entry} b.median`);
      assert.equal(typeof c.b.spread, 'number', `${metric}/${entry} b.spread`);
      assert.equal(typeof c.noDifference, 'boolean', `${metric}/${entry} noDifference`);
    }
  }
  const p99 = result.comparisons.find((c) => c.metric === 'paymentP99Ms' && c.entry === 'none');
  assert.equal(p99.noDifference, true);

  const missing = localRuns().filter((r) => !(r.config === 'bundle' && r.entry === 'none' && r.rep === 3));
  const bad = compareExperiment(missing);
  assert.equal(bad.verdict, 'invalid');
  assert.ok(bad.missing.some((m) => m.config === 'bundle' && m.entry === 'none' && m.rep === 3), JSON.stringify(bad.missing));
  assert.equal(bad.comparisons.some((c) => c.metric === 'paymentP99Ms' && c.entry === 'none'), false, '3회 미만 조건은 비교에 쓰지 않는다');

  assert.equal(compareExperiment([]).verdict, 'invalid');

  const invalidRun = localRuns().map((r) => (r.config === 'by-role' && r.entry === '100' && r.rep === 2 ? { ...r, valid: false } : r));
  assert.equal(compareExperiment(invalidRun).verdict, 'invalid');
});

test('F0810-3 ③ compareExperiment: (다)가 있으면 complete, (다)의 진입 100% 결제 p99/오류율이 NFR-005 밖이면 adr0007 fail이며, 편차 밖 차이는 fail이 아니다', async () => {
  const { compareExperiment } = await split();
  const withServices = (m = metrics(100, 0.0001, 50, 0.0001, 0.01)) => {
    const out = localRuns();
    for (const entry of ['none', '100', '120']) for (const rep of [1, 2, 3]) out.push(run('services', entry, rep, m));
    return out;
  };
  const complete = compareExperiment(withServices());
  assert.equal(complete.verdict, 'complete');
  assert.equal(complete.services, 'measured');
  assert.equal(complete.adr0007, 'pass');
  assert.equal(complete.comparisons.length, 30, '(가)-(나) 15 + (나)-(다) 15');

  const slow = compareExperiment(withServices(metrics(150, 0.0001, 50, 0.0001, 0.01)));
  assert.equal(slow.adr0007, 'fail', 'NFR-005은 150ms 미만이라 경계 150ms는 실패다');
  assert.equal(slow.verdict, 'fail');

  const edge = compareExperiment(withServices(metrics(149.9, 0.0005, 50, 0.0001, 0.01)));
  assert.equal(edge.adr0007, 'pass', '149.9ms·오류율 0.0005는 기준 안이다');
  assert.equal(edge.verdict, 'complete');

  const errors = compareExperiment(withServices(metrics(100, 0.0006, 50, 0.0001, 0.01)));
  assert.equal(errors.adr0007, 'fail');
  assert.equal(errors.verdict, 'fail');

  const difference = localRuns().map((r) => (r.config === 'by-role' && r.entry === 'none' ? { ...r, metrics: metrics(300, 0.0001, 50, 0.0001, 0.01) } : r));
  for (const entry of ['none', '100', '120']) for (const rep of [1, 2, 3]) difference.push(run('services', entry, rep));
  const different = compareExperiment(difference);
  assert.equal(different.verdict, 'complete', '편차 밖 차이는 실패가 아니다');
  const diff = different.comparisons.find((c) => c.metric === 'paymentP99Ms' && c.entry === 'none');
  assert.equal(diff.noDifference, false);
});

test('F0810-4 ① judgeCompareRun: 300 TPS 아님·services·진입 도착률 불일치·발생기/시나리오/호스트 무효를 invalid로 내고 깨끗한 실행을 pass로 낸다', async () => {
  const { judgeCompareRun } = await split();
  const good = {
    config: 'bundle',
    entry: '100',
    rep: 1,
    paymentTps: 300,
    entryMaxRate: 1000,
    entryRate: 1000,
    generator: { valid: true, dropped: 0, cpuAvgPct: 50, memMaxPct: 60 },
    scenarioErrors: 0,
    hostSaturated: false,
    metrics: metrics(100, 0.0001, 50, 0.0001, 0.01),
  };
  assert.equal(judgeCompareRun(good).verdict, 'pass');
  assert.equal(judgeCompareRun(good).valid, true);

  const bad = [
    { ...good, paymentTps: 299 },
    { ...good, config: 'services' },
    { ...good, entryRate: 999 },
    { ...good, generator: { ...good.generator, valid: false } },
    { ...good, generator: { ...good.generator, dropped: 1 } },
    { ...good, generator: { ...good.generator, cpuAvgPct: 81 } },
    { ...good, generator: { ...good.generator, memMaxPct: 91 } },
    { ...good, scenarioErrors: 1 },
    { ...good, hostSaturated: true },
    { ...good, metrics: null },
  ];
  for (const o of bad) assert.equal(judgeCompareRun(o).verdict, 'invalid', JSON.stringify(o));

  const none = { ...good, entry: 'none', entryMaxRate: null, entryRate: 0 };
  assert.equal(judgeCompareRun(none).verdict, 'pass');
});

test('F0810-4 ② renderComparison: 5지표×3단계 줄을 적고 partial은 모두 차이 없음, different는 noDifference:false 줄만 차이다', async () => {
  const { compareExperiment, renderComparison } = await split();
  const labels = ['결제 접수 p99', '결제 접수 오류율', '진입 p99', '진입 오류율', 'CPU 스로틀'];
  const rows = (text) => text.split('\n').filter((l) => labels.some((x) => l.includes(x)) && l.includes('차이'));
  const partial = compareExperiment(localRuns());
  const text = renderComparison(partial);
  assert.ok(rows(text).length >= 15, `지표 줄이 15개보다 적다: ${rows(text).length}`);
  for (const label of labels) assert.ok(rows(text).filter((l) => l.includes(label)).length >= 3, `${label} 줄이 3단계보다 적다`);
  assert.ok(rows(text).every((l) => l.includes('차이 없음')), 'partial의 모든 줄은 차이 없음이어야 한다');
  assert.equal(rows(text).some((l) => l.includes('차이') && !l.includes('차이 없음')), false, 'partial에 차이 줄이 있으면 안 된다');
  assert.ok(text.includes('미측정'), text);
  assert.doesNotMatch(text, /K1|K2|K7/, 'KPI ID를 비교 글에 쓰지 않는다');
  assert.doesNotMatch(text, /30,000|100만/, '정본 규모 목표를 이 기능 결과로 쓰지 않는다');

  const withDifference = localRuns().map((r) => (r.config === 'by-role' && r.entry === 'none' ? { ...r, metrics: metrics(300, 0.0001, 50, 0.0001, 0.01) } : r));
  const differentResult = compareExperiment(withDifference);
  const different = renderComparison(differentResult);
  const diffRows = rows(different).filter((l) => l.includes('차이') && !l.includes('차이 없음'));
  assert.ok(diffRows.length >= 1, '편차 밖 차이는 차이 줄로 적어야 한다');
  assert.ok(diffRows.some((l) => l.includes('결제 접수 p99') && l.includes('0%')), '결제 p99 0% 줄이 차이여야 한다');
  assert.ok(rows(different).some((l) => l.includes('차이 없음')), '다른 지표 줄은 차이 없음이어야 한다');
  const diff = differentResult.comparisons.find((c) => c.metric === 'paymentP99Ms' && c.entry === 'none');
  assert.equal(diff.noDifference, false);
});

test('F0810-5 ① M2_DRAFTS: 세 편의 ID·주제·측정/설계 구분·근거·상태·게시자가 HOT-510 범위와 맞는다', async () => {
  const { M2_DRAFTS } = await split();
  assert.equal(M2_DRAFTS.length, 3);
  assert.deepEqual(M2_DRAFTS.map((d) => d.id), ['m2-entry-wait-state', 'm2-seat-hold-delta', 'm2-payment-idempotency']);
  assert.deepEqual(M2_DRAFTS.map((d) => d.kpis), [['K1'], ['K2', 'K4', 'K5'], ['K7']]);
  assert.deepEqual(M2_DRAFTS.map((d) => d.evidence), [['F-08-2', 'F-08-8'], ['F-08-8'], ['F-08-8']]);
  assert.deepEqual(M2_DRAFTS.map((d) => d.measuredKpis), [['K1'], ['K2'], ['K7']]);
  assert.deepEqual(M2_DRAFTS.map((d) => d.designOnlyKpis), [[], ['K4', 'K5'], []]);
  for (const d of M2_DRAFTS) {
    assert.equal(d.status, 'draft');
    assert.equal(d.publish, 'owner');
    assert.ok(d.evidence.length > 0, `${d.id}: 근거가 없다`);
    for (const e of d.evidence) assert.ok(['F-08-2', 'F-08-8'].includes(e), `${d.id}: 근거 ${e}`);
    for (const e of d.evidence) assert.equal(e.startsWith('F-08-9'), false, `${d.id}: F-08-9 근거 금지`);
    assert.ok(d.claims === undefined || (Array.isArray(d.claims) && d.claims.length === 0), `${d.id}: 수치 주장이 없어야 한다`);
  }
});

test('F0810-5 ② validateDrafts: 세 편 아님·ID 겹침·F-08-9/SR-T13/V-T27 근거·대리 게시·새 수치·K4/K5 측정 주장을 거부한다', async () => {
  const { M2_DRAFTS, validateDrafts } = await split();
  assert.equal(validateDrafts(M2_DRAFTS).ok, true);
  const base = M2_DRAFTS.map((d) => ({ ...d, evidence: [...d.evidence], kpis: [...d.kpis], measuredKpis: [...d.measuredKpis], designOnlyKpis: [...d.designOnlyKpis] }));
  const cases = [
    base.slice(0, 2),
    [base[0], base[0], base[2]],
    base.map((d, i) => (i === 0 ? { ...d, evidence: ['V-T18'] } : d)),
    base.map((d, i) => (i === 0 ? { ...d, evidence: ['F-08-9'] } : d)),
    base.map((d, i) => (i === 0 ? { ...d, evidence: ['SR-T13 ①'] } : d)),
    base.map((d, i) => (i === 0 ? { ...d, evidence: ['V-T27'] } : d)),
    base.map((d, i) => (i === 0 ? { ...d, publish: 'agent' } : d)),
    base.map((d, i) => (i === 0 ? { ...d, claims: ['30,000/s'] } : d)),
    base.map((d, i) => (i === 0 ? { ...d, claims: ['결제 확정 p99 93.947초'] } : d)),
    base.map((d, i) => (i === 0 ? { ...d, status: 'published' } : d)),
    base.map((d, i) => (i === 1 ? { ...d, measuredKpis: ['K2', 'K4'] } : d)),
    base.map((d, i) => (i === 1 ? { ...d, designOnlyKpis: [] } : d)),
  ];
  for (const c of cases) assert.equal(validateDrafts(c).ok, false, JSON.stringify(c));
});
