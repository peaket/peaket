// F-08-9 검색 측정 도구(계획 docs/review/plans/F-08-9.md 6.4·7.1~7.2).
// 정본: docs/features/search.md SR-T13(307행)·§8(255행)·§10(269행), docs/planning/02-requirements.md NFR-028(189행).
// 계산·계약만 둔다. k6·core-svc 실행은 run.mjs가 측정 창에서 맡는다. 수치를 새로 주장하지 않는다.

export class UsageError extends Error {
  name = 'UsageError';
}

const fail = (m) => {
  throw new UsageError(m);
};

export const SEARCH_RULES = Object.freeze({
  sizes: [10000, 20000],
  reps: 3,
  validReps: 2,
  suggestP95Ms: 50,
  searchP95Ms: 300,
  top1: 0.9,
  top3: 0.98,
  versionLagSeconds: 60,
  unavailableRatio: 0.01,
  poolWaitingRatio: 0.05,
  crowdRate: 20,
  randomRate: 20,
  durationS: 60,
});

const RUN_ID = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,80}$/;
const PROM_URL = /^http:\/\/(127\.0\.0\.1|localhost):(\d{1,5})$/;
const intArg = (name, raw, lo, hi) => {
  if (!/^\d+$/.test(String(raw))) fail(`${name}은 ${lo}~${hi} 정수다: ${raw}`);
  const n = Number(raw);
  if (n < lo || n > hi) fail(`${name}은 ${lo}~${hi} 정수다: ${raw}`);
  return n;
};

/** v1 search 인자. 계획 7.2의 공개 꼴 */
export function parseSearchArgs(argv) {
  if (!Array.isArray(argv)) fail('인자 목록이 없다');
  const seen = new Map();
  const valueFlags = new Set(['--size', '--reps', '--crowd-rate', '--random-rate', '--duration', '--base', '--out', '--run-id', '--prom-url']);
  const boolFlags = new Set(['--golden', '--record']);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!valueFlags.has(flag) && !boolFlags.has(flag)) fail(`모르는 인자: ${flag}`);
    if (seen.has(flag)) fail(`${flag}를 두 번 줬다`);
    if (boolFlags.has(flag)) {
      seen.set(flag, true);
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) fail(`${flag}에 값이 없다`);
    seen.set(flag, v);
    i++;
  }
  const size = intArg('--size', seen.get('--size') ?? 10000, 1, 20000);
  if (!SEARCH_RULES.sizes.includes(size)) fail(`--size는 ${SEARCH_RULES.sizes.join('·')} 가운데 하나다: ${size}`);
  const reps = intArg('--reps', seen.get('--reps') ?? 3, 1, 3);
  const record = seen.get('--record') === true;
  const runId = seen.get('--run-id');
  if (record && runId === undefined) fail('--record에는 --run-id가 꼭 있어야 한다');
  if (!record && runId !== undefined) fail('--run-id는 --record와 함께만 준다');
  if (runId !== undefined && !RUN_ID.test(runId)) fail(`--run-id 꼴이 틀렸다(YYYY-MM-DD-영소문자·숫자·-): ${runId}`);
  const promUrl = seen.get('--prom-url');
  if (promUrl !== undefined && !PROM_URL.test(promUrl)) fail(`--prom-url은 http://127.0.0.1:<포트>나 http://localhost:<포트>다: ${promUrl}`);
  return {
    size,
    reps,
    golden: seen.get('--golden') === true,
    crowdRate: intArg('--crowd-rate', seen.get('--crowd-rate') ?? SEARCH_RULES.crowdRate, 1, 100000),
    randomRate: intArg('--random-rate', seen.get('--random-rate') ?? SEARCH_RULES.randomRate, 1, 100000),
    durationS: intArg('--duration', seen.get('--duration') ?? SEARCH_RULES.durationS, 1, 3600),
    base: seen.get('--base') ?? 'http://host.docker.internal:3001',
    ...(seen.get('--out') !== undefined ? { out: seen.get('--out') } : {}),
    record,
    ...(runId !== undefined ? { runId } : {}),
    ...(promUrl !== undefined ? { promUrl } : {}),
  };
}

const emptyCell = () => ({ count: 0, ok: 0, unavailable: 0, other5xx: 0, p95: null });
const p95 = (values) => {
  if (values.length === 0) return null;
  const a = [...values].sort((x, y) => x - y);
  return a[Math.max(0, Math.ceil(0.95 * a.length) - 1)];
};

/** k6 --out csv 표본을 머리 칸 이름으로 읽어 구간·경로별로 센다 */
export function parseK6Csv(text) {
  const out = {
    requests: 0,
    dropped: 0,
    phases: { crowd: { search: emptyCell(), suggest: emptyCell() }, random: { search: emptyCell(), suggest: emptyCell() } },
  };
  if (typeof text !== 'string' || text.trim() === '') return out;
  const lines = text.trim().split(/\r?\n/);
  const head = lines.shift().split(',');
  const idx = (name) => head.indexOf(name);
  const iName = idx('metric_name');
  const iValue = idx('metric_value');
  const iStatus = idx('status');
  const iRoute = idx('route');
  const iPhase = idx('phase');
  if (iName < 0 || iValue < 0 || iStatus < 0 || iRoute < 0 || iPhase < 0) return out;
  const durations = new Map();
  for (const line of lines) {
    const c = line.split(',');
    const name = c[iName];
    const value = Number(c[iValue]);
    if (name === 'dropped_iterations') {
      if (Number.isFinite(value)) out.dropped += value;
      continue;
    }
    if (name !== 'http_req_duration') continue;
    const phase = c[iPhase];
    const route = c[iRoute];
    if (!out.phases[phase]?.[route]) continue;
    out.requests++;
    const cell = out.phases[phase][route];
    cell.count++;
    const status = Number(c[iStatus]);
    if (status === 200) cell.ok++;
    else if (status === 503) cell.unavailable++;
    else if (status >= 500) cell.other5xx++;
    if (!durations.has(`${phase}.${route}`)) durations.set(`${phase}.${route}`, []);
    if (Number.isFinite(value)) durations.get(`${phase}.${route}`).push(value);
  }
  for (const phase of ['crowd', 'random']) {
    for (const route of ['search', 'suggest']) {
      out.phases[phase][route].p95 = p95(durations.get(`${phase}.${route}`) ?? []);
    }
  }
  return out;
}

/** SR-T13 ① 회차 하나. 빈 결과·놓친 반복·게이지 없음은 invalid */
export function judgeSearchRep({ samples, poolWaiting } = {}) {
  if (!samples || typeof samples !== 'object' || !samples.phases) return { valid: false, verdict: 'invalid', problems: ['표본이 없다'], metrics: null };
  if (!Number.isInteger(samples.dropped) || samples.dropped < 0) return { valid: false, verdict: 'invalid', problems: ['놓친 반복 수가 없다'], metrics: samples };
  const problems = [];
  if (samples.dropped > 0) return { valid: false, verdict: 'invalid', problems: [`놓친 반복 ${samples.dropped}건`], metrics: samples };
  if (!Array.isArray(poolWaiting) || poolWaiting.length === 0) return { valid: false, verdict: 'invalid', problems: ['search_pool_waiting 표본이 없다'], metrics: samples };
  for (const phase of ['crowd', 'random']) {
    for (const route of ['search', 'suggest']) {
      const cell = samples.phases[phase]?.[route];
      if (!cell || !Number.isInteger(cell.count) || cell.count <= 0) return { valid: false, verdict: 'invalid', problems: [`${phase}.${route} 요청이 0건이다`], metrics: samples };
    }
    const search = samples.phases[phase].search;
    const suggest = samples.phases[phase].suggest;
    if (!(search.p95 <= SEARCH_RULES.searchP95Ms)) problems.push(`${phase} 검색 p95 ${search.p95} > ${SEARCH_RULES.searchP95Ms}`);
    if (!(suggest.p95 <= SEARCH_RULES.suggestP95Ms)) problems.push(`${phase} 자동완성 p95 ${suggest.p95} > ${SEARCH_RULES.suggestP95Ms}`);
    const ratio = search.count > 0 ? search.unavailable / search.count : 1;
    if (ratio > SEARCH_RULES.unavailableRatio) problems.push(`${phase} 검색 503 ${(ratio * 100).toFixed(2)}% > 1%`);
    if ((search.other5xx ?? 0) > 0 || (suggest.other5xx ?? 0) > 0) problems.push(`${phase} 그 밖의 5xx`);
  }
  const nonZero = poolWaiting.filter((x) => Number(x) !== 0).length / poolWaiting.length;
  if (nonZero > SEARCH_RULES.poolWaitingRatio) problems.push(`search_pool_waiting 0이 아닌 표본 ${(nonZero * 100).toFixed(1)}% > 5%`);
  return { valid: true, verdict: problems.length > 0 ? 'fail' : 'pass', problems, metrics: samples };
}

/** 크기 하나의 회차들. 유효 2회 미만 invalid, 유효 회차 하나라도 fail이면 fail */
export function judgeSearchRun(reps) {
  const list = Array.isArray(reps) ? reps : [];
  const validReps = list.filter((r) => r?.valid === true).length;
  const worst = { suggestP95: null, searchP95: null };
  for (const r of list) {
    if (r?.valid !== true || !r.metrics?.phases) continue;
    const all = ['crowd', 'random'].flatMap((p) => ['search', 'suggest'].map((route) => r.metrics.phases[p]?.[route]?.p95).filter(Number.isFinite));
    if (all.length === 0) continue;
    const s = Math.max(...['crowd', 'random'].map((p) => r.metrics.phases[p]?.search?.p95).filter(Number.isFinite));
    const g = Math.max(...['crowd', 'random'].map((p) => r.metrics.phases[p]?.suggest?.p95).filter(Number.isFinite));
    if (Number.isFinite(s)) worst.searchP95 = worst.searchP95 === null ? s : Math.max(worst.searchP95, s);
    if (Number.isFinite(g)) worst.suggestP95 = worst.suggestP95 === null ? g : Math.max(worst.suggestP95, g);
  }
  if (validReps < SEARCH_RULES.validReps) return { validReps, verdict: 'invalid', sizes: [], worst };
  const verdict = list.some((r) => r?.valid === true && r.verdict === 'fail') ? 'fail' : 'pass';
  return { validReps, verdict, sizes: [], worst };
}

/** SR-T12 골든 세트 보고. 경우 수·목표가 정본과 다르면 valid=false */
export function parseGoldenReport(json) {
  const cases = json?.cases;
  const top1 = json?.top1;
  const top3 = json?.top3;
  const target = json?.target;
  const valid = cases === 100 && typeof top1 === 'number' && typeof top3 === 'number' && target?.top1 === SEARCH_RULES.top1 && target?.top3 === SEARCH_RULES.top3 && Array.isArray(json?.misses);
  return { cases, top1, top3, rates: { top1, top3 }, valid };
}

/** NFR-028: 다섯 수치 + 판매 승인 취소 반영. 값이 없으면 미측정, 하나라도 fail이면 fail */
export function nfr028Verdict({ search, golden, versionLag, removal } = {}) {
  const worstOf = (key) => {
    const values = ['crowd', 'random'].map((p) => search?.[p]?.[key]).filter((v) => typeof v === 'number' && Number.isFinite(v));
    return values.length === 0 ? null : Math.max(...values);
  };
  const judge = (v, limit) => (v === null ? '미측정' : v <= limit ? 'pass' : 'fail');
  const rates = golden?.valid === true ? golden.rates ?? golden : { top1: null, top3: null };
  const parts = {
    suggest: judge(worstOf('suggestP95'), SEARCH_RULES.suggestP95Ms),
    search: judge(worstOf('searchP95'), SEARCH_RULES.searchP95Ms),
    top1: typeof rates.top1 === 'number' ? (rates.top1 >= SEARCH_RULES.top1 ? 'pass' : 'fail') : '미측정',
    top3: typeof rates.top3 === 'number' ? (rates.top3 >= SEARCH_RULES.top3 ? 'pass' : 'fail') : '미측정',
    versionLag: versionLag === null || versionLag === undefined ? '미측정' : versionLag <= SEARCH_RULES.versionLagSeconds ? 'pass' : 'fail',
    removal: typeof removal === 'string' && removal.trim() !== '' ? 'pass' : '미측정',
  };
  const values = Object.values(parts);
  const verdict = values.includes('fail') ? 'fail' : values.includes('미측정') ? '미측정' : 'pass';
  return { parts, verdict };
}

/** Prometheus 응답(즉시 조회)에서 값 배열. 빈 응답·NaN은 missing에 남긴다 */
export function parsePromSeries(json, name) {
  if (json?.status !== 'success' || !Array.isArray(json?.data?.result) || json.data.result.length === 0) return { values: [], missing: [name] };
  const values = [];
  for (const r of json.data.result) {
    const v = Number(r?.value?.[1]);
    if (Number.isFinite(v)) values.push(v);
  }
  return { values, missing: values.length === 0 ? [name] : [] };
}
