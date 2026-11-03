// 발생기 나누기와 합치기, 경로 목표 점검 파일(docs/verification.md §3.10 '발생기 나누기'·'경로 목표 점검'). Node에서만 쓴다.
import { ERROR_TARGETS, ROUTE_TARGETS } from '../lib/targets.mjs';

/** 발생기 하나가 놓침 없이 보낸 도착률(2026-11-03 보정, docs/verification.md §3.9) */
export const GENERATOR_RATE_CAP = 1000;

/**
 * 나눌 발생기 수: ⌈maxRate ÷ cap⌉(1 이상). maxRate는 양의 유한한 수, cap은 1 이상 정수(아니면 RangeError)
 * @param {number} maxRate
 * @param {number} [cap]
 * @returns {number}
 */
export function generatorCount(maxRate, cap = GENERATOR_RATE_CAP) {
  if (typeof maxRate !== 'number' || !Number.isFinite(maxRate) || maxRate <= 0) throw new RangeError(`최고 도착률은 양의 유한한 수다: ${maxRate}`);
  if (!Number.isSafeInteger(cap) || cap < 1) throw new RangeError(`발생기 하나의 도착률은 1 이상 정수다: ${cap}`);
  return Math.max(1, Math.ceil(maxRate / cap));
}

const frac = (i, n) => (i === 0 ? '0' : i === n ? '1' : `${i}/${n}`);

/**
 * k6 실행 구간(K6_EXECUTION_SEGMENT·K6_EXECUTION_SEGMENT_SEQUENCE) n개. n은 1~64 정수(아니면 RangeError).
 * 경계는 0, 1/n, 2/n, …, 1이고 0은 '0', 1은 '1', 그 밖은 '<i>/<n>'(약분하지 않는다)으로 쓴다.
 * 예: n=2 → [{ index: 0, segment: '0:1/2', sequence: '0,1/2,1' }, { index: 1, segment: '1/2:1', sequence: '0,1/2,1' }].
 * n=1 → [{ index: 0, segment: '0:1', sequence: '0,1' }]
 * @param {number} n
 * @returns {Array<{ index: number, segment: string, sequence: string }>}
 */
export function executionSegments(n) {
  if (!Number.isSafeInteger(n) || n < 1 || n > 64) throw new RangeError(`발생기 수는 1~64 정수다: ${n}`);
  const bounds = Array.from({ length: n + 1 }, (_, i) => frac(i, n));
  const sequence = bounds.join(',');
  return Array.from({ length: n }, (_, i) => ({ index: i, segment: `${bounds[i]}:${bounds[i + 1]}`, sequence }));
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * 발생기마다 낸 k6 요약(summary.json, 지표마다 { type, values })을 하나로 합친다. 입력은 바꾸지 않는다. 지표 이름은 모든 요약의 합집합이다.
 * - counter: count와 rate를 더한다.
 * - rate: passes·fails를 더하고 rate = passes ÷ (passes + fails)(둘 다 0이면 0).
 * - gauge: value·max는 더하고(발생기마다 따로 잡은 가상 사용자 수의 합), min은 가장 작은 값.
 * - trend: min은 가장 작은 값, max는 가장 큰 값, 나머지 통계(avg·med·p(..))는 가장 큰 값(위 한계)을 쓰고,
 *   그 통계마다 [가장 작은 값, 가장 큰 값]을 bounds[지표 이름][통계 이름]에 둔다(모든 요청을 합친 백분위는 대개 그 사이에 있다. k6 백분위는
 *   앞뒤 값 사이를 이어 계산해 아주 조금 벗어날 수 있다, docs/verification.md §3.10 '발생기 나누기').
 *   'http_req_duration{…}'은 같은 꼬리표의 'http_reqs{…}'가 있고 그 count가 0인 요약을 빼고 합친다(남는 것이 없으면 빼지 않는다).
 * - 지표 종류(type)는 type이 적힌 첫 요약에서 읽는다(앞 요약에 type 없는 칸이 있어도 뒤 요약의 값을 합친다).
 * - type이 어디에도 없거나 모르는 지표는 첫 요약의 값을 그대로 두고 unmerged에 이름을 더한다.
 * 결과: { ...첫 요약의 지표 밖 키, metrics, merge: { generators: 요약 수, bounds, unmerged } }.
 * 요약이 1개면 metrics는 그 값 그대로이고 bounds는 trend 통계마다 [값, 값]이다. 빈 배열이면 RangeError
 * @param {Array<{ metrics: Record<string, { type?: string, values: Record<string, number> }> }>} summaries
 * @returns {{ metrics: Record<string, { type?: string, values: Record<string, number> }>, merge: { generators: number, bounds: Record<string, Record<string, [number, number]>>, unmerged: string[] } }}
 */
export function mergeSummaries(summaries) {
  if (!Array.isArray(summaries) || summaries.length === 0) throw new RangeError('합칠 요약이 없다');
  for (const s of summaries) if (!isObj(s) || !isObj(s.metrics)) throw new RangeError('요약에 metrics가 없다');
  const names = [];
  const seen = new Set();
  for (const s of summaries) for (const k of Object.keys(s.metrics)) if (!seen.has(k)) (seen.add(k), names.push(k));
  const metrics = {};
  const bounds = {};
  const unmerged = [];
  for (const name of names) {
    const parts = summaries.map((s) => s.metrics[name]).filter((m) => isObj(m) && isObj(m.values));
    const first = summaries.map((s) => s.metrics[name]).find((m) => m !== undefined);
    // 지표 종류는 종류가 적힌 첫 요약에서 읽는다. 앞 요약이 빠진 지표를 종류 없이 채운 칸(lib/model.mjs mainPhaseSummary)이어도
    // 뒤 요약의 값을 잃지 않는다(2026-11-03 시험 검토)
    const typed = parts.find((p) => typeof p.type === 'string');
    const type = typed?.type;
    const copy = (m) => JSON.parse(JSON.stringify(m));
    if (parts.length === 0) {
      metrics[name] = copy(first);
      unmerged.push(name);
      continue;
    }
    const base = copy(typed ?? parts[0]);
    let vals = parts.map((p) => p.values);
    if (type === 'trend') {
      // 요청 시간(http_req_duration{…})은 같은 꼬리표의 요청 수(http_reqs{…})가 있고 0인 발생기를 뺀다(요청 수가 없으면 모르니 뺀다고 보지 않는다). k6는 요청이 없던 꼬리표의 통계를
      // 모두 0으로 내어 합친 min과 아래 한계를 0으로 끌어내린다(2026-11-03 시험 검토). 모두 0이면 그대로 둔다
      const reqs = name.startsWith('http_req_duration') ? `http_reqs${name.slice('http_req_duration'.length)}` : null;
      if (reqs) {
        const live = summaries.filter((s) => isObj(s.metrics[name]) && isObj(s.metrics[name].values) && !(isObj(s.metrics[reqs]) && count(s.metrics[reqs]) === 0)).map((s) => s.metrics[name].values);
        if (live.length > 0) vals = live;
      }
    }
    if (type === 'counter') {
      base.values = { ...base.values, count: vals.reduce((a, v) => a + num(v.count), 0), rate: vals.reduce((a, v) => a + num(v.rate), 0) };
    } else if (type === 'rate') {
      const passes = vals.reduce((a, v) => a + num(v.passes), 0);
      const fails = vals.reduce((a, v) => a + num(v.fails), 0);
      base.values = { ...base.values, passes, fails, rate: passes + fails === 0 ? 0 : passes / (passes + fails) };
    } else if (type === 'gauge') {
      base.values = {
        ...base.values,
        value: vals.reduce((a, v) => a + num(v.value), 0),
        max: vals.reduce((a, v) => a + num(v.max), 0),
        min: Math.min(...vals.map((v) => num(v.min))),
      };
    } else if (type === 'trend') {
      const out = {};
      const b = {};
      const stats = [];
      const sset = new Set();
      for (const v of vals) for (const k of Object.keys(v)) if (!sset.has(k)) (sset.add(k), stats.push(k));
      for (const k of stats) {
        const xs = vals.map((v) => v[k]).filter((x) => typeof x === 'number' && Number.isFinite(x));
        if (xs.length === 0) continue;
        const lo = Math.min(...xs);
        const hi = Math.max(...xs);
        out[k] = k === 'min' ? lo : hi;
        if (k !== 'min' && k !== 'max') b[k] = [lo, hi];
      }
      base.values = out;
      bounds[name] = b;
    } else {
      metrics[name] = copy(first);
      unmerged.push(name);
      continue;
    }
    metrics[name] = base;
  }
  const rest = { ...summaries[0] };
  delete rest.metrics;
  delete rest.merge;
  return { ...JSON.parse(JSON.stringify(rest)), metrics, merge: { generators: summaries.length, bounds, unmerged } };
}

/** 경로 목표 점검의 구간(시나리오 → 경로 → k6 phase 꼬리표, 없으면 main). 대기열 진입은 예열 앞의 진입 구간에서만 나간다(docs/verification.md §3.10). 실행 도구와 e2e가 함께 쓴다 */
export const CHECK_PHASES = Object.freeze({ queue: Object.freeze({ entry: 'prep' }) });

const QUANTILE = { 0.01: '99', 0.001: '999', 0.05: '95' };
const count = (m) => (isObj(m) && isObj(m.values) && Number.isFinite(m.values.count) ? m.values.count : 0);

/**
 * 본구간 요약(합친 것도 됨)에서 collect.py --checks 입력을 만든다(docs/perf-ledger.md §2.2 checks).
 * routes의 경로마다(ROUTE_TARGETS·ERROR_TARGETS에 있는 것만). 구간 <구간>은 phases[경로](없으면 'main')다. 대기열 시나리오의 진입은
 * 예열 앞의 진입 구간(phase:prep)에서만 나가므로 실행 도구가 { entry: 'prep' }을 준다(docs/verification.md §3.10 '경로 목표 점검'):
 * - 시행 수 = 'http_reqs{phase:<구간>,route:<경로>}'의 count. 0이거나 지표가 없으면 그 경로의 점검을 만들지 않는다.
 * - 시간 목표마다 { name: '<경로>_p<분위>_<le>ms', allowed, trials, violations, target }. 분위는 allowed 0.01 → '99', 0.001 → '999', 0.05 → '95'.
 *   violations = 'over_target{phase:<구간>,route:<경로>,le:<le>}'의 count(없으면 0). target은 '<경로> p<분위> ≤ <le>ms'.
 * - 오류율 목표가 있으면 { name: '<경로>_errors', allowed, trials, violations, target: '<경로> 오류율 < <allowed×100>%' }.
 *   violations = 'http_req_failed{phase:<구간>,route:<경로>}'의 passes(없으면 0).
 * phases의 값은 영소문자 이름이고 키는 routes에 있어야 한다(아니면 RangeError). 실행 도구는 CHECK_PHASES[시나리오]를 준다.
 * violations가 trials보다 크면 trials로 자른다(k6 집계 경계 차이). 점검이 하나도 없으면 null.
 * @param {{ metrics: Record<string, { values: Record<string, number> }> }} summary
 * @param {string[]} routes
 * @param {Record<string, string>} [phases]
 * @returns {{ checks: Array<{ name: string, allowed: number, trials: number, violations: number, target: string }> } | null}
 */
export function checksFromSummary(summary, routes, phases = {}) {
  if (!isObj(summary) || !isObj(summary.metrics)) throw new RangeError('요약에 metrics가 없다');
  if (!Array.isArray(routes)) throw new RangeError('경로 목록이 아니다');
  if (!isObj(phases) || !Object.values(phases).every((p) => typeof p === 'string' && /^[a-z]{1,16}$/.test(p))) throw new RangeError('구간 이름이 틀렸다');
  // 키 오타(예: entri)로 진입 점검이 조용히 본구간을 읽지 않게 경로 목록 밖의 키는 거부한다(2차 리뷰)
  for (const k of Object.keys(phases)) if (!routes.includes(k)) throw new RangeError(`구간을 준 경로가 경로 목록에 없다: ${k}`);
  const m = summary.metrics;
  const checks = [];
  for (const r of routes) {
    const ph = Object.hasOwn(phases, r) ? phases[r] : 'main';
    const trials = count(m[`http_reqs{phase:${ph},route:${r}}`]);
    if (!(trials > 0)) continue;
    for (const t of Object.hasOwn(ROUTE_TARGETS, r) ? ROUTE_TARGETS[r] : []) {
      const q = QUANTILE[t.allowed];
      const violations = Math.min(trials, count(m[`over_target{phase:${ph},route:${r},le:${t.le}}`]));
      checks.push({ name: `${r}_p${q}_${t.le}ms`, allowed: t.allowed, trials, violations, target: `${r} p${q} ≤ ${t.le}ms` });
    }
    if (Object.hasOwn(ERROR_TARGETS, r)) {
      const f = m[`http_req_failed{phase:${ph},route:${r}}`];
      const passes = isObj(f) && isObj(f.values) && Number.isFinite(f.values.passes) ? f.values.passes : 0;
      const allowed = ERROR_TARGETS[r];
      checks.push({ name: `${r}_errors`, allowed, trials, violations: Math.min(trials, passes), target: `${r} 오류율 < ${+(allowed * 100).toFixed(6)}%` });
    }
  }
  return checks.length ? { checks } : null;
}

export { ERROR_TARGETS, ROUTE_TARGETS };

/**
 * 서버 히스토그램 점검(histogram이 있는 점검)과 지연 대조(crosscheck)를 뺀 새 점검 묶음(입력은 바꾸지 않는다). 앱 파드를 일부러 끝낸 실행(K7 ②)이나
 * 측정 창 안에서 앱 파드가 다시 시작해 collect.py가 히스토그램을 셀 수 없다고 거부한 실행을 장부에 남길 때 쓴다(2026-11-03 새 맥락 리뷰).
 * 결과: { checks: 남은 점검, dropped: 뺀 점검 이름 목록 }. 남은 점검이 없으면 checks는 null. checks가 null이면 { checks: null, dropped: [] }.
 * 점검 묶음 꼴({ checks: 배열 })이 아니면 RangeError
 * @param {{ checks: Array<Record<string, unknown>>, crosscheck?: unknown } | null} checks
 * @returns {{ checks: { checks: Array<Record<string, unknown>> } | null, dropped: string[] }}
 */
export function withoutHistogramChecks(checks) {
  if (checks === null) return { checks: null, dropped: [] };
  if (!isObj(checks) || !Array.isArray(checks.checks)) throw new RangeError('점검 묶음이 아니다');
  const keep = [];
  const dropped = [];
  for (const c of checks.checks) {
    if (isObj(c) && Object.hasOwn(c, 'histogram')) dropped.push(String(c.name));
    else keep.push(JSON.parse(JSON.stringify(c)));
  }
  return { checks: keep.length ? { checks: keep } : null, dropped };
}
