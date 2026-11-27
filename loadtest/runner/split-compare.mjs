// F-08-10 서비스 분리 효과 비교(V-T18)의 순수 함수. 계획 docs/review/plans/F-08-10.md 6~7절.
// - (가) 한 프로세스 합본과 축소 (나) 네 역할 배포만 로컬에서 잰다. (다) 10개 서비스는 미측정이다.
// - 측정 창 전에는 실행하지 않는다. 이 모듈은 계획·판정·표시만 만들고 Docker·kind·k6를 쓰지 않는다.
// - 값은 정본(docs/verification.md §3.8·V-T18, docs/planning/02-requirements.md NFR-001·NFR-005)에서 온다.
//   이 파일은 측정 결과를 주장하지 않는다. 측정 전 결과는 모두 미측정이다.

/** 잘못된 인자·로컬에서 할 수 없는 구성 */
export class UsageError extends Error {
  name = 'UsageError';
}

const CONFIGS = ['bundle', 'by-role', 'services'];
const LOCAL_CONFIGS = ['bundle', 'by-role'];
const ENTRIES = ['none', '100', '120'];
const REPS = 3;
const PAYMENT_TPS = 300;
// NFR-005: 결제 접수 p99 150ms 미만, 가용성 99.95% 이상
const PAYMENT_P99_MS = 150;
const PAYMENT_AVAILABILITY = 0.9995;
// NFR-001: 진입 p99 200ms 이하, 오류율 0.1% 미만
const ENTRY_P99_MS = 200;
const ENTRY_ERROR_RATE = 0.001;

/** 계획 7.2의 공개 규칙. 값은 정본에서 가져온다. */
export const SPLIT_RULES = Object.freeze({
  experiment: 'split-3way',
  configs: Object.freeze(CONFIGS),
  localConfigs: Object.freeze(LOCAL_CONFIGS),
  entryLevels: Object.freeze([
    Object.freeze({ key: 'none', ratio: 0 }),
    Object.freeze({ key: '100', ratio: 1 }),
    Object.freeze({ key: '120', ratio: 1.2 }),
  ]),
  reps: REPS,
  paymentTps: PAYMENT_TPS,
  paymentP99Ms: PAYMENT_P99_MS,
  paymentAvailability: PAYMENT_AVAILABILITY,
  entryP99Ms: ENTRY_P99_MS,
  entryErrorRate: ENTRY_ERROR_RATE,
  noDifference: 'max-spread',
});

/** 비교하는 다섯 지표(정본 §3.8 '재는 것'). 라벨은 renderComparison이 쓴다. */
export const METRICS = Object.freeze([
  Object.freeze({ key: 'paymentP99Ms', label: '결제 접수 p99' }),
  Object.freeze({ key: 'paymentErrorRate', label: '결제 접수 오류율' }),
  Object.freeze({ key: 'entryP99Ms', label: '진입 p99' }),
  Object.freeze({ key: 'entryErrorRate', label: '진입 오류율' }),
  Object.freeze({ key: 'cpuThrottleRatio', label: 'CPU 스로틀' }),
]);

/** HOT-510 M2 초안 3편의 계약. K4·K5는 F-08-8이 재지 않았으므로 designOnlyKpis에만 둔다. */
export const M2_DRAFTS = Object.freeze([
  Object.freeze({
    id: 'm2-entry-wait-state',
    title: '진입과 대기 상태 파일',
    kpis: Object.freeze(['K1']),
    measuredKpis: Object.freeze(['K1']),
    designOnlyKpis: Object.freeze([]),
    evidence: Object.freeze(['F-08-2', 'F-08-8']),
    status: 'draft',
    publish: 'owner',
  }),
  Object.freeze({
    id: 'm2-seat-hold-delta',
    title: '좌석 홀드와 변경 방송',
    kpis: Object.freeze(['K2', 'K4', 'K5']),
    measuredKpis: Object.freeze(['K2']),
    designOnlyKpis: Object.freeze(['K4', 'K5']),
    evidence: Object.freeze(['F-08-8']),
    status: 'draft',
    publish: 'owner',
  }),
  Object.freeze({
    id: 'm2-payment-idempotency',
    title: '결제 멱등과 결과 모름',
    kpis: Object.freeze(['K7']),
    measuredKpis: Object.freeze(['K7']),
    designOnlyKpis: Object.freeze([]),
    evidence: Object.freeze(['F-08-8']),
    status: 'draft',
    publish: 'owner',
  }),
]);

const isInt = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
const isFiniteNumber = (n) => typeof n === 'number' && Number.isFinite(n);

/** 계획 7.2의 로컬 구성 검사. (다)는 로컬 무대에 배포가 없어 거부한다. */
export function assertLocalConfig(config) {
  if (!LOCAL_CONFIGS.includes(config)) throw new UsageError(`로컬 v1 무대에 10개 서비스 배포가 없다: ${config}((가) bundle·축소 (나) by-role만 잰다)`);
  return true;
}

const needValue = (argv, i, flag) => {
  const v = argv[i];
  if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag}에 값이 없다`);
  return v;
};

/**
 * `v1 compare` 인자. 계획 7.2.
 * @param {string[]} argv
 */
export function parseCompareArgs(argv) {
  if (!Array.isArray(argv)) throw new UsageError('인자 목록이 없다');
  let config;
  let entry = 'none';
  let rep = 1;
  let paymentTps = PAYMENT_TPS;
  let entryMaxRate = null;
  let warmupSeconds = 30;
  let mainSeconds = 120;
  let drainSeconds = 20;
  let out;
  let record = false;
  let runId;
  let promUrl;
  let commit;
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (seen.has(flag)) throw new UsageError(`${flag}를 두 번 줬다`);
    seen.add(flag);
    if (flag === '--record') {
      record = true;
      continue;
    }
    const raw = needValue(argv, i + 1, flag);
    i += 1;
    if (flag === '--config') {
      if (!CONFIGS.includes(raw)) throw new UsageError(`--config는 ${CONFIGS.join('·')} 가운데 하나다: ${raw}`);
      config = raw;
    } else if (flag === '--entry') {
      if (!ENTRIES.includes(raw)) throw new UsageError(`--entry는 ${ENTRIES.join('·')} 가운데 하나다: ${raw}`);
      entry = raw;
    } else if (flag === '--rep') {
      if (!/^[1-3]$/.test(raw)) throw new UsageError(`--rep은 1~3이다: ${raw}`);
      rep = Number(raw);
    } else if (flag === '--payment-tps') {
      if (!/^\d+$/.test(raw) || !isInt(Number(raw), 1, 100000)) throw new UsageError(`--payment-tps는 1~100,000이다: ${raw}`);
      paymentTps = Number(raw);
    } else if (flag === '--entry-max-rate') {
      if (!/^\d+$/.test(raw) || !isInt(Number(raw), 1, 100000)) throw new UsageError(`--entry-max-rate는 1~100,000이다: ${raw}`);
      entryMaxRate = Number(raw);
    } else if (flag === '--warm') {
      if (!/^\d+$/.test(raw) || !isInt(Number(raw), 0, 600)) throw new UsageError(`--warm은 0~600이다: ${raw}`);
      warmupSeconds = Number(raw);
    } else if (flag === '--main') {
      if (!/^\d+$/.test(raw) || !isInt(Number(raw), 30, 600)) throw new UsageError(`--main은 30~600이다: ${raw}`);
      mainSeconds = Number(raw);
    } else if (flag === '--drain') {
      if (!/^\d+$/.test(raw) || !isInt(Number(raw), 0, 120)) throw new UsageError(`--drain은 0~120이다: ${raw}`);
      drainSeconds = Number(raw);
    } else if (flag === '--out') {
      if (raw.length === 0) throw new UsageError('--out은 비지 않은 경로다');
      out = raw;
    } else if (flag === '--run-id') runId = raw;
    else if (flag === '--prom-url') promUrl = raw;
    else if (flag === '--commit') commit = raw;
    else throw new UsageError(`모르는 인자: ${flag}`);
  }
  if (config === undefined) throw new UsageError('--config가 꼭 있어야 한다(bundle·by-role·services)');
  if (entry === 'none' && entryMaxRate !== null) throw new UsageError('진입 없음(none)에는 --entry-max-rate를 주지 않는다');
  if (entry !== 'none' && entryMaxRate === null) throw new UsageError(`진입 ${entry}%에는 --entry-max-rate가 꼭 있어야 한다`);
  const ratio = SPLIT_RULES.entryLevels.find((x) => x.key === entry)?.ratio ?? 0;
  const entryRate = entry === 'none' ? 0 : Math.round(entryMaxRate * ratio);
  return {
    config,
    entry,
    rep,
    paymentTps,
    entryMaxRate,
    entryRate,
    warmupSeconds,
    mainSeconds,
    drainSeconds,
    out,
    record,
    runId,
    promUrl,
    commit,
  };
}

/**
 * `v1 compare-report` 인자. 실행 폴더와 출력 경로만 읽는다.
 * @param {string[]} argv
 */
export function parseCompareReportArgs(argv) {
  let experiment = SPLIT_RULES.experiment;
  let runs = '.cache/peaket-f10/runs';
  let out = '.cache/peaket-f10/comparison.json';
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--experiment') {
      const v = needValue(argv, i + 1, flag);
      if (!/^[a-z0-9-]+$/.test(v)) throw new UsageError(`--experiment는 영소문자·숫자·-다: ${v}`);
      experiment = v;
      i += 1;
    } else if (flag === '--runs') {
      runs = needValue(argv, i + 1, flag);
      i += 1;
    } else if (flag === '--out') {
      out = needValue(argv, i + 1, flag);
      i += 1;
    } else throw new UsageError(`모르는 인자: ${flag}`);
  }
  return { experiment, runs, out };
}

/** manifest experiment 칸. 정본 docs/perf-ledger.md §2.2. */
export function experimentFor({ config }) {
  return { id: SPLIT_RULES.experiment, config };
}

/** manifest notes 한 줄. KPI ID를 쓰지 않는다. */
export function manifestNotes({ config, entry, rep, runId }) {
  return `V-T18 비교: 구성 ${config}, 진입 ${entry}%, 회차 ${rep}, 실행 ${runId ?? '(없음)'}`;
}

/**
 * 실행 하나의 유효 판정. 계획 7.2.
 * @param {Record<string, any>} o
 */
export function judgeCompareRun(o) {
  const reasons = [];
  if (!o || typeof o !== 'object') return { valid: false, verdict: 'invalid', reasons: ['실행 정보가 없다'], summary: null };
  if (!LOCAL_CONFIGS.includes(o.config)) reasons.push(`로컬에서 잴 수 없는 구성: ${o.config}`);
  if (o.paymentTps !== PAYMENT_TPS) reasons.push(`결제 300 TPS가 아니다: ${o.paymentTps}`);
  if (!isInt(o.rep, 1, 3)) reasons.push(`회차가 1~3이 아니다: ${o.rep}`);
  if (!ENTRIES.includes(o.entry)) reasons.push(`진입 단계가 틀렸다: ${o.entry}`);
  if (o.entry === 'none') {
    if (o.entryRate !== 0) reasons.push(`진입 없음인데 entryRate가 0이 아니다: ${o.entryRate}`);
  } else {
    const ratio = SPLIT_RULES.entryLevels.find((x) => x.key === o.entry)?.ratio ?? 0;
    if (!isInt(o.entryMaxRate, 1, 100000)) reasons.push(`entryMaxRate가 1~100,000이 아니다: ${o.entryMaxRate}`);
    else if (o.entryRate !== Math.round(o.entryMaxRate * ratio)) reasons.push(`entryRate가 진입 ${o.entry}%와 맞지 않는다: ${o.entryRate}`);
  }
  const g = o.generator;
  if (!g || g.valid !== true) reasons.push('발생기가 유효하지 않다');
  else {
    if (g.dropped !== 0) reasons.push(`발생기 dropped: ${g.dropped}`);
    if (!(g.cpuAvgPct <= 80)) reasons.push(`발생기 CPU 평균 ${g.cpuAvgPct}% > 80%`);
    if (!(g.memMaxPct <= 90)) reasons.push(`발생기 메모리 최대 ${g.memMaxPct}% > 90%`);
  }
  if (o.scenarioErrors !== 0) reasons.push(`시나리오 오류: ${o.scenarioErrors}`);
  if (o.hostSaturated === true) reasons.push('호스트 포화');
  if (!o.metrics || typeof o.metrics !== 'object') reasons.push('지표가 없다');
  else {
    for (const { key } of METRICS) if (!isFiniteNumber(o.metrics[key])) reasons.push(`지표 ${key}가 없다`);
  }
  if (reasons.length) return { valid: false, verdict: 'invalid', reasons, summary: null };
  return { valid: true, verdict: 'pass', reasons: [], summary: { config: o.config, entry: o.entry, rep: o.rep, metrics: o.metrics } };
}

/** 표본의 중앙값·최솟값·최댓값·편차. 빈 표본은 count 0, 나머지 null(0이 아니다). */
export function compareSamples(values) {
  if (!Array.isArray(values)) throw new TypeError('표본은 배열이다');
  if (values.length === 0) return { count: 0, median: null, min: null, max: null, spread: null };
  const nums = values.map((v) => {
    if (!isFiniteNumber(v)) throw new TypeError(`표본 값이 유한한 수가 아니다: ${v}`);
    return v;
  });
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  return { count: sorted.length, median, min, max, spread: max - min };
}

/** 두 구성의 중앙값 차이와 두 편차의 최댓값. 3회 미만은 noDifference:null. */
export function judgeNoDifference(a, b) {
  const sa = compareSamples(a);
  const sb = compareSamples(b);
  if (sa.count < REPS || sb.count < REPS) {
    return { valid: false, noDifference: null, diff: null, spread: null, reason: `3회 미만 표본(${sa.count}, ${sb.count})` };
  }
  const diff = Math.abs(sa.median - sb.median);
  const spread = Math.max(sa.spread, sb.spread);
  return { valid: true, noDifference: diff <= spread, diff, spread, reason: null };
}

const isRunValid = (r) => r && r.valid === true && LOCAL_CONFIGS.concat('services').includes(r.config) && ENTRIES.includes(r.entry) && isInt(r.rep, 1, 3) && r.metrics && METRICS.every(({ key }) => isFiniteNumber(r.metrics[key]));

/**
 * 실험 묶음 판정. (가)·(나) 15개 비교, (다)가 있으면 30개.
 * 3회 미만·무효 회차가 있는 조건은 comparisons에 넣지 않고 verdict를 invalid로 낸다.
 */
export function compareExperiment(runs) {
  const problems = [];
  const missing = [];
  if (!Array.isArray(runs)) return { verdict: 'invalid', problems: ['실행 목록이 배열이 아니다'], missing, comparisons: [], services: '미측정', adr0007: '미측정' };
  const servicesPresent = runs.some((r) => r?.config === 'services');
  const expectedConfigs = servicesPresent ? CONFIGS : LOCAL_CONFIGS;
  const byKey = new Map();
  for (const r of runs) {
    if (!isRunValid(r)) continue;
    const key = `${r.config}|${r.entry}|${r.rep}`;
    if (byKey.has(key)) problems.push(`같은 조건·회차가 두 번 있다: ${key}`);
    else byKey.set(key, r);
  }
  for (const config of expectedConfigs) {
    for (const entry of ENTRIES) {
      for (const rep of [1, 2, 3]) {
        if (!byKey.has(`${config}|${entry}|${rep}`)) missing.push({ config, entry, rep });
      }
    }
  }
  const samples = new Map(); // `${config}|${entry}|${metric}` → number[]
  for (const [key, r] of byKey) {
    const [config, entry] = key.split('|');
    for (const { key: metric } of METRICS) {
      const k = `${config}|${entry}|${metric}`;
      if (!samples.has(k)) samples.set(k, []);
      samples.get(k).push(r.metrics[metric]);
    }
  }
  const complete = (config, entry) => METRICS.every(({ key: metric }) => (samples.get(`${config}|${entry}|${metric}`) ?? []).length === REPS);
  const comparisons = [];
  for (const entry of ENTRIES) {
    if (complete('bundle', entry) && complete('by-role', entry)) {
      for (const { key: metric } of METRICS) {
        const a = compareSamples(samples.get(`bundle|${entry}|${metric}`));
        const b = compareSamples(samples.get(`by-role|${entry}|${metric}`));
        const j = judgeNoDifference(samples.get(`bundle|${entry}|${metric}`), samples.get(`by-role|${entry}|${metric}`));
        comparisons.push({ metric, entry, aConfig: 'bundle', bConfig: 'by-role', a, b, diff: j.diff, spread: j.spread, noDifference: j.noDifference, valid: j.valid });
      }
    }
    if (complete('by-role', entry) && complete('services', entry)) {
      for (const { key: metric } of METRICS) {
        const a = compareSamples(samples.get(`by-role|${entry}|${metric}`));
        const b = compareSamples(samples.get(`services|${entry}|${metric}`));
        const j = judgeNoDifference(samples.get(`by-role|${entry}|${metric}`), samples.get(`services|${entry}|${metric}`));
        comparisons.push({ metric, entry, aConfig: 'by-role', bConfig: 'services', a, b, diff: j.diff, spread: j.spread, noDifference: j.noDifference, valid: j.valid });
      }
    }
  }
  const services = !servicesPresent ? '미측정' : ENTRIES.every((entry) => complete('services', entry)) ? 'measured' : 'invalid';
  let adr0007 = '미측정';
  if (services === 'measured') {
    const p99 = samples.get('services|100|paymentP99Ms') ?? [];
    const err = samples.get('services|100|paymentErrorRate') ?? [];
    adr0007 = p99.some((v) => v >= PAYMENT_P99_MS) || err.some((v) => v > 0.0005) ? 'fail' : 'pass';
  }
  const verdict = problems.length || missing.length ? 'invalid' : adr0007 === 'fail' ? 'fail' : services === '미측정' ? 'partial' : 'complete';
  return { verdict, problems, missing, comparisons, services, adr0007 };
}

const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));
const CONFIG_LABEL = { bundle: '(가)', 'by-role': '(나)', services: '(다)' };
const ENTRY_LABEL = { none: '0%', 100: '100%', 120: '120%' };

/** 비교 결과를 조건별 한 줄씩 적는다. 줄 단위 '차이'·'차이 없음'을 지킨다. */
export function renderComparison(result) {
  const lines = ['F-08-10 V-T18 서비스 분리 효과 비교(측정 전 결과는 미측정, 실측(PC) 표시는 측정 창에서)'];
  for (const c of result.comparisons ?? []) {
    const label = METRICS.find((m) => m.key === c.metric)?.label ?? c.metric;
    const a = CONFIG_LABEL[c.aConfig] ?? c.aConfig;
    const b = CONFIG_LABEL[c.bConfig] ?? c.bConfig;
    const diff = c.noDifference ? '차이 없음' : `차이 ${fmt(c.diff)}`;
    lines.push(`${label} ${ENTRY_LABEL[c.entry] ?? c.entry}: ${a} 중앙값 ${fmt(c.a.median)} (편차 ${fmt(c.a.spread)}), ${b} 중앙값 ${fmt(c.b.median)} (편차 ${fmt(c.b.spread)}) — ${diff}`);
  }
  lines.push(`(다) 10개 서비스: ${result.services === '미측정' ? '미측정' : result.services === 'measured' ? '측정' : '무효'}`);
  lines.push('이 글은 V-T18 비교이며 KPI 판정이 아니다.');
  return `${lines.join('\n')}\n`;
}

/** M2 초안 계약 검사. F-08-9·SR-T13·V-T27·V-T28·P-T1은 근거로 쓰지 못한다. */
export function validateDrafts(drafts) {
  const problems = [];
  if (!Array.isArray(drafts) || drafts.length !== 3) problems.push('초안은 정확히 3편이다');
  const list = Array.isArray(drafts) ? drafts : [];
  const ids = new Set();
  for (const d of list) {
    if (!d || typeof d.id !== 'string' || !d.id) problems.push('초안 ID가 없다');
    else if (ids.has(d.id)) problems.push(`초안 ID가 겹친다: ${d.id}`);
    else ids.add(d.id);
    if (d?.status !== 'draft') problems.push(`${d?.id}: 상태가 draft가 아니다`);
    if (d?.publish !== 'owner') problems.push(`${d?.id}: 게시자가 owner가 아니다`);
    if (!Array.isArray(d?.evidence) || d.evidence.length === 0) problems.push(`${d?.id}: 근거가 없다`);
    for (const e of d?.evidence ?? []) if (!['F-08-2', 'F-08-8'].includes(e)) problems.push(`${d?.id}: 근거로 쓸 수 없다: ${e}`);
    if (d?.claims !== undefined && (!Array.isArray(d.claims) || d.claims.length > 0)) problems.push(`${d?.id}: 수치 주장이 있다`);
    const kpis = Array.isArray(d?.kpis) ? d.kpis : [];
    const measured = Array.isArray(d?.measuredKpis) ? d.measuredKpis : [];
    const design = Array.isArray(d?.designOnlyKpis) ? d.designOnlyKpis : [];
    if (measured.some((k) => !['K1', 'K2', 'K7'].includes(k))) problems.push(`${d?.id}: measuredKpis는 K1·K2·K7만이다`);
    if (design.some((k) => !['K4', 'K5'].includes(k))) problems.push(`${d?.id}: designOnlyKpis는 K4·K5만이다`);
    if (measured.some((k) => design.includes(k))) problems.push(`${d?.id}: 측정·설계 KPI가 겹친다`);
    const union = [...new Set([...measured, ...design])].sort();
    if (JSON.stringify(union) !== JSON.stringify([...kpis].sort())) problems.push(`${d?.id}: kpis와 measured+design이 다르다`);
  }
  return { ok: problems.length === 0, problems };
}
