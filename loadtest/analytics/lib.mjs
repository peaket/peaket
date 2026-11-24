// F-04-8 측정 하네스의 순수 계산·판정(docs/review/plans/F-04-8.md §3·§7).
// 이 파일은 Docker·Kafka·ClickHouse를 모른다. 발생기·실행기·집계기가 같은 판정을 쓰게 한 곳에 둔다.
// 원칙: 빈 결과·0건·작은 표본·발생기 실패를 절대 pass로 세지 않는다(invalid). 경계값은 엄격 미만이다.

export const FRESHNESS_LIMIT_MS = 5_000;
export const LOSS_LIMIT = 0.001;
export const HOT_LAG_LIMIT_MS = 5_000;
/** 누락률을 0.1%로 판정하기에 너무 작은 모집단. 이보다 작으면 0건만 통과다 */
export const LOSS_MIN_POPULATION = 10_000;
/** 1분 창(60,000ms)의 p95가 NFR-009 판정값이다 */
export const FRESHNESS_WINDOW_MS = 60_000;
/** 예열 [가정](docs/verification.md §3.7의 30분 측정에서 첫 1분) */
export const FRESHNESS_WARMUP_MS = 60_000;

/** 입력 비율(100칸). docs/features/analytics.md §11의 피크 비율을 줄인 값이다 */
export const MIX = Object.freeze({
  seat: 29,
  order: 15,
  payment: 10,
  ticket: 8,
  hold: 20,
  verdict: 16,
  queue: 2,
});

/** 레코드가 가는 Kafka 토픽 */
export const TOPIC_OF = Object.freeze({
  seat: 'trade.seats',
  order: 'trade.orders',
  payment: 'trade.payments',
  ticket: 'trade.tickets',
  hold: 'telemetry.purchase',
  verdict: 'telemetry.trust-verdicts',
  queue: 'telemetry.queue',
});

/** ops-rt가 rt 표에 싣는 레코드인가. queue는 관제 표에 싣지 않는다(docs/streaming.md §4.2) */
export const RT_LOADS = Object.freeze({
  seat: true,
  order: true,
  payment: true,
  ticket: true,
  hold: true,
  verdict: true,
  queue: false,
});

export const RECORD_KINDS = Object.freeze(Object.keys(MIX));
export const TOPICS = Object.freeze([...new Set(Object.values(TOPIC_OF))]);
/** 하네스가 만드는 토픽의 기본 파티션 수(스모크 6, 전체 12) */
export const DEFAULT_PARTITIONS = 6;
export const FULL_PARTITIONS = 12;

/** @param {unknown} v @param {string} what */
function positiveNumber(v, what) {
  if (!Number.isFinite(v) || v <= 0) throw new Error(`${what}는 0보다 큰 수여야 한다: ${String(v)}`);
  return v;
}

/**
 * 가장 가까운 순위(nearest-rank) 백분위. 정렬한 값의 ceil(q × n)번째다.
 * q는 0보다 크고 1 이하다. 빈 배열은 null이다(0으로 바꾸지 않는다).
 * @param {readonly number[]} values
 * @param {number} q
 * @returns {number | null}
 */
export function percentile(values, q) {
  if (!Array.isArray(values)) throw new TypeError('percentile values는 배열이어야 한다');
  if (!(q > 0 && q <= 1)) throw new RangeError(`percentile q는 (0, 1]이어야 한다: ${String(q)}`);
  const nums = values.filter((v) => Number.isFinite(v));
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * total을 weights 비율로 나눈다(largest remainder). 합은 정확히 total이다.
 * @param {number} total
 * @param {Readonly<Record<string, number>>} weights
 * @returns {Record<string, number>}
 */
export function allocCounts(total, weights) {
  if (!Number.isInteger(total) || total < 0) throw new RangeError(`total은 0 이상의 정수여야 한다: ${String(total)}`);
  const entries = Object.entries(weights);
  if (entries.length === 0) throw new Error('weights가 비었다');
  for (const [k, w] of entries) positiveNumber(w, `weights.${k}`);
  const weightSum = entries.reduce((a, [, w]) => a + w, 0);
  const raw = entries.map(([k, w], index) => ({ k, index, exact: (total * w) / weightSum, n: Math.floor((total * w) / weightSum) }));
  let left = total - raw.reduce((a, r) => a + r.n, 0);
  const order = [...raw].sort((a, b) => b.exact - b.n - (a.exact - a.n) || a.index - b.index);
  for (let i = 0; left > 0; i = (i + 1) % order.length, left--) order[i].n += 1;
  return Object.fromEntries(raw.map((r) => [r.k, r.n]));
}

/** 0..n-1의 i % m 합(주문·결제 금액의 결정적 합계) */
function sumMod(n, m) {
  const full = Math.floor(n / m);
  const rest = n % m;
  return full * ((m * (m - 1)) / 2) + (rest * (rest - 1)) / 2;
}

/** 0..n-1 가운데 i % 10 < 8인 수(홀드 HELD) */
function countModBelow(n, mod, below) {
  const full = Math.floor(n / mod);
  const rest = n % mod;
  return full * below + Math.min(rest, below);
}

/**
 * 발생 계획. 발생기는 이 값을 그대로 따르지 않고 자기가 성공한 수를 manifest에 적지만,
 * 실행 전에 규모·기대 합계·토픽 분포를 검산하는 데 쓴다.
 * @param {{rate:number,durationMs:number,partitions?:number,hot?:boolean,backgroundEvents?:number}} o
 */
export function buildPlan(o) {
  const rate = positiveNumber(o.rate, 'rate');
  const durationMs = positiveNumber(o.durationMs, 'durationMs');
  const partitions = Math.trunc(o.partitions ?? DEFAULT_PARTITIONS);
  if (!Number.isInteger(partitions) || partitions < 1) throw new Error(`partitions는 1 이상의 정수여야 한다: ${String(o.partitions)}`);
  const total = Math.round((rate * durationMs) / 1000);
  const byRecord = allocCounts(total, MIX);
  const orderAmount = byRecord.order * 10_000 + 1_000 * sumMod(byRecord.order, 7);
  const paymentAmount = byRecord.payment * 30_000 + 1_000 * sumMod(byRecord.payment, 5);
  const holdHelped = countModBelow(byRecord.hold, 10, 8);
  const byTopic = {};
  for (const [k, n] of Object.entries(byRecord)) byTopic[TOPIC_OF[k]] = (byTopic[TOPIC_OF[k]] ?? 0) + n;
  return {
    rate,
    durationMs,
    total,
    partitions,
    hot: o.hot === true,
    hotPartition: o.hot === true ? 0 : null,
    backgroundEvents: Math.max(1, Math.trunc(o.backgroundEvents ?? 11)),
    byRecord,
    byTopic,
    expected: {
      seatSold: byRecord.seat,
      orderConfirmed: byRecord.order,
      orderAmount,
      paymentApproved: byRecord.payment,
      paymentAmount,
      ticketIssued: byRecord.ticket,
      holdHelped,
      holdConflict: byRecord.hold - holdHelped,
      verdictPass: byRecord.verdict,
      queueEntries: byRecord.queue,
      pulseTopics: 3,
    },
  };
}

/**
 * ST-T17 인기 회차 계획. 핫 회차의 좌석·주문이 `hotRate`(건/초)이고, 배경 11회차는 각각 그 1/10이다.
 * 핫은 파티션 0, 배경은 나머지 파티션을 돌려 쓴다. 다른 레코드 종류는 넣지 않는다(정본 시나리오가 좌석·주문만 말한다).
 * @param {{hotRate:number,durationMs:number,partitions?:number,backgroundEvents?:number}} o
 */
export function buildHotPlan(o) {
  const hotRate = positiveNumber(o.hotRate, 'hotRate');
  const durationMs = positiveNumber(o.durationMs, 'durationMs');
  const partitions = Math.trunc(o.partitions ?? DEFAULT_PARTITIONS);
  const backgroundEvents = Math.max(1, Math.trunc(o.backgroundEvents ?? 11));
  if (!Number.isInteger(partitions) || partitions < 2) throw new Error(`hot 모드의 partitions는 2 이상이어야 한다: ${String(o.partitions)}`);
  const seconds = durationMs / 1000;
  const hotSeatRate = Math.round((hotRate * 2) / 3);
  const hotOrderRate = hotRate - hotSeatRate;
  const bgSeatRate = Math.round(hotSeatRate / 10);
  const bgOrderRate = Math.round(hotOrderRate / 10);
  const hotSeatTotal = Math.round(hotSeatRate * seconds);
  const hotOrderTotal = Math.round(hotOrderRate * seconds);
  const bgSeatTotal = Math.round(bgSeatRate * seconds) * backgroundEvents;
  const bgOrderTotal = Math.round(bgOrderRate * seconds) * backgroundEvents;
  const byRecord = { seat: hotSeatTotal + bgSeatTotal, order: hotOrderTotal + bgOrderTotal };
  const orderAmount = byRecord.order * 10_000 + 1_000 * sumMod(byRecord.order, 7);
  return {
    hot: true,
    hotRate,
    durationMs,
    total: byRecord.seat + byRecord.order,
    partitions,
    hotPartition: 0,
    backgroundEvents,
    byRecord,
    byTopic: { 'trade.seats': byRecord.seat, 'trade.orders': byRecord.order },
    expected: {
      seatSold: byRecord.seat,
      orderConfirmed: byRecord.order,
      orderAmount,
      paymentApproved: 0,
      paymentAmount: 0,
      ticketIssued: 0,
      holdHelped: 0,
      holdConflict: 0,
      verdictPass: 0,
      queueEntries: 0,
      pulseTopics: 3,
    },
  };
}

/**
 * 누락률 = (못 읽음 + 거절 + 발생기 버린 수) ÷ (전체 + 발생기 버린 수).
 * covered는 거절·건너뜀을 포함해 '처리한 오프셋' 수다. covered가 expected보다 크면 도구 오류다.
 * @param {{expected:number,covered:number,rejected?:number,producerFailures?:number}} o
 */
export function lossRatio(o) {
  const expected = Number(o.expected);
  const covered = Number(o.covered);
  const rejected = Number(o.rejected ?? 0);
  const producerFailures = Number(o.producerFailures ?? 0);
  for (const [k, v] of Object.entries({ expected, covered, rejected, producerFailures })) {
    if (!Number.isFinite(v) || v < 0) throw new Error(`lossRatio ${k}는 0 이상의 수여야 한다: ${String(v)}`);
  }
  const denominator = expected + producerFailures;
  const missing = Math.max(0, expected - covered);
  const numerator = missing + rejected + producerFailures;
  return { denominator, missing, numerator, ratio: denominator === 0 ? null : numerator / denominator };
}

/** @param {{expected:number,covered:number,rejected?:number,producerFailures?:number}} o */
export function judgeLoss(o) {
  const r = lossRatio(o);
  const reasons = [];
  const producerFailures = Number(o.producerFailures ?? 0);
  let valid = true;
  if (r.denominator === 0) {
    valid = false;
    reasons.push('모집단이 0건이다(발생 전 오프셋을 읽지 못했거나 발생이 없었다)');
  }
  if (Number(o.covered) > Number(o.expected)) {
    valid = false;
    reasons.push(`덮은 오프셋 ${o.covered}가 전체 ${o.expected}보다 크다(도구 오류)`);
  }
  if (producerFailures > 0) {
    valid = false;
    reasons.push(`발생기 최종 실패 ${producerFailures}건: 누락률에 더하지 않고 이 실행을 무효로 둔다`);
  }
  if (r.ratio === null) reasons.push('누락률을 낼 수 없다');
  const small = Number(o.expected) < LOSS_MIN_POPULATION;
  const pass = valid && r.ratio !== null && (small ? r.numerator === 0 : r.ratio < LOSS_LIMIT);
  if (valid && !pass) reasons.push(`누락률 ${((r.ratio ?? 0) * 100).toFixed(4)}%가 ${(LOSS_LIMIT * 100).toFixed(1)}% 미만이 아니다${small ? `(모집단 ${o.expected}건은 0건만 통과)` : ''}`);
  return { ...r, valid, pass, small, reasons };
}

/** 샘플을 {at,ms}로 정규화한다. 숫자 배열은 1초 간격으로 본다 */
function normalizeSamples(samples) {
  if (!Array.isArray(samples)) throw new TypeError('samples는 배열이어야 한다');
  return samples
    .map((s, i) => (typeof s === 'number' ? { at: i * 1_000, ms: s } : { at: Number(s?.at), ms: Number(s?.ms) }))
    .filter((s) => Number.isFinite(s.ms) && s.ms >= 0);
}

/**
 * 신선도 판정. 전 구간 p95와 1분 창마다 p95를 본다(창마다 5초 미만).
 * 샘플이 minSamples보다 적거나 비면 valid=false다. warmupMs만큼 앞 구간은 뺀다.
 * @param {readonly (number|{at:number,ms:number})[]} samples
 * @param {{limitMs?:number,minSamples?:number,windowMs?:number,warmupMs?:number}} [o]
 */
export function judgeFreshness(samples, o = {}) {
  const limitMs = o.limitMs ?? FRESHNESS_LIMIT_MS;
  const minSamples = o.minSamples ?? 10;
  const windowMs = o.windowMs ?? FRESHNESS_WINDOW_MS;
  const warmupMs = o.warmupMs ?? 0;
  const all = normalizeSamples(samples);
  const t0 = all.length ? Math.min(...all.map((s) => s.at)) : 0;
  const kept = all.filter((s) => s.at >= t0 + warmupMs);
  const values = kept.map((s) => s.ms);
  const p95 = percentile(values, 0.95);
  const reasons = [];
  const valid = values.length >= minSamples && p95 !== null;
  if (!valid) reasons.push(`신선도 샘플이 ${values.length}개다(최소 ${minSamples}개, 빈 결과는 통과가 아니다)`);

  const byWindow = new Map();
  for (const s of kept) {
    const w = Math.floor((s.at - t0) / windowMs);
    const list = byWindow.get(w) ?? [];
    list.push(s.ms);
    byWindow.set(w, list);
  }
  const windows = [...byWindow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([w, list]) => ({ index: w, from: t0 + w * windowMs, to: t0 + (w + 1) * windowMs, count: list.length, p95: percentile(list, 0.95) }));
  // 1분 창은 '그 창이 끝날 때까지 샘플이 이어진' 창이다. 샘플이 5개 미만인 창은 판정하지 않는다(빈 창을 통과로 세지 않는다).
  const lastAt = kept.length ? Math.max(...kept.map((s) => s.at)) : t0;
  const full = windows.filter((w) => w.to - 1_000 <= lastAt && w.count >= 5);
  const badWindows = full.filter((w) => w.p95 !== null && w.p95 >= limitMs);
  if (valid && p95 >= limitMs) reasons.push(`전 구간 신선도 p95 ${Math.round(p95)}ms가 ${limitMs}ms 미만이 아니다`);
  for (const w of badWindows) reasons.push(`신선도 1분 창 ${w.index} p95 ${Math.round(w.p95)}ms가 ${limitMs}ms 미만이 아니다(${w.count}샘플)`);
  const pass = valid && p95 < limitMs && badWindows.length === 0;
  return { valid, pass, p95, limitMs, count: values.length, windows, fullWindows: full.length, reasons };
}

/**
 * 정확성 비교. 숫자는 정확히 같아야 하고, 기대에 있는 키가 실제에 없으면 실패다.
 * rawRows 같은 진단용 키는 비교에서 뺀다(원시 행 중복은 정상).
 * @param {{expected:unknown,actual:unknown}} o
 */
export function judgeAccuracy(o) {
  const reasons = [];
  const compared = [];
  const IGNORE = new Set(['rawRows', 'manifest', 'capturedAt', 'elapsedMs']);
  const walk = (expected, actual, path) => {
    if (expected === null || expected === undefined) return;
    if (typeof expected === 'number') {
      if (typeof actual !== 'number' || !Number.isFinite(actual)) {
        reasons.push(`${path}: 실제 값이 수가 아니다(${String(actual)})`);
      } else if (actual !== expected) {
        reasons.push(`${path}: 기대 ${expected}, 실제 ${actual}(차이 ${actual - expected})`);
      } else {
        compared.push(path);
      }
      return;
    }
    if (typeof expected === 'string' || typeof expected === 'boolean') {
      if (actual !== expected) reasons.push(`${path}: 기대 ${String(expected)}, 실제 ${String(actual)}`);
      else compared.push(path);
      return;
    }
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual) || actual.length !== expected.length) {
        reasons.push(`${path}: 배열 길이 기대 ${expected.length}, 실제 ${Array.isArray(actual) ? actual.length : String(actual)}`);
        return;
      }
      expected.forEach((v, i) => walk(v, actual[i], `${path}[${i}]`));
      return;
    }
    if (typeof expected === 'object') {
      if (!actual || typeof actual !== 'object') {
        reasons.push(`${path}: 실제 값이 객체가 아니다`);
        return;
      }
      for (const [k, v] of Object.entries(expected)) {
        if (IGNORE.has(k)) continue;
        walk(v, actual[k], path ? `${path}.${k}` : k);
      }
      return;
    }
    reasons.push(`${path}: 비교할 수 없는 기대 값 ${String(expected)}`);
  };
  walk(o.expected, o.actual, '');
  const empty = compared.length === 0 && reasons.length === 0;
  if (empty) reasons.push('비교할 값이 없다(빈 기대·빈 실제는 통과가 아니다)');
  return { pass: !empty && reasons.length === 0, compared: compared.length, reasons };
}

/**
 * ST-T17 인기 회차 파티션의 소비 밀림 p95.
 * @param {readonly number[]} samples
 * @param {{limitMs?:number,minSamples?:number}} [o]
 */
export function judgeHotLag(samples, o = {}) {
  const limitMs = o.limitMs ?? HOT_LAG_LIMIT_MS;
  const minSamples = o.minSamples ?? 5;
  const values = (samples ?? []).filter((v) => Number.isFinite(v));
  const p95 = percentile(values, 0.95);
  const valid = values.length >= minSamples && p95 !== null;
  const reasons = [];
  if (!valid) reasons.push(`파티션 밀림 샘플이 ${values.length}개다(최소 ${minSamples}개)`);
  if (valid && p95 >= limitMs) reasons.push(`파티션 밀림 p95 ${Math.round(p95)}ms가 ${limitMs}ms 미만이 아니다`);
  return { valid, pass: valid && p95 < limitMs, p95, limitMs, count: values.length, reasons };
}

/**
 * 실행 하나의 최종 판정. 무효가 하나라도 있으면 invalid, 아니면 하나라도 실패면 fail, 모두 통과면 pass.
 * @param {{freshness?:{samples:unknown[]},loss?:object,accuracy?:object,hot?:{samples:number[]},mode?:string}} report
 */
export function judgeRun(report) {
  const parts = [];
  const invalid = [];
  const failed = [];
  if (!report || typeof report !== 'object') return { verdict: 'invalid', pass: false, reasons: ['보고서가 없다'], parts: [] };
  if (report.freshness) {
    const f = judgeFreshness(report.freshness.samples ?? [], report.freshness.options ?? {});
    parts.push({ name: 'freshness', ...f });
    if (!f.valid) invalid.push(...f.reasons);
    else if (!f.pass) failed.push(...f.reasons);
  } else invalid.push('신선도 결과가 없다');
  if (report.loss) {
    const l = report.loss.valid !== undefined && report.loss.ratio !== undefined ? report.loss : judgeLoss(report.loss);
    parts.push({ name: 'loss', ...l });
    if (!l.valid) invalid.push(...(l.reasons ?? []));
    else if (!l.pass) failed.push(...(l.reasons ?? []));
  } else invalid.push('누락률 결과가 없다');
  if (report.accuracy) {
    const a = report.accuracy.pass !== undefined && report.accuracy.compared !== undefined ? report.accuracy : judgeAccuracy(report.accuracy);
    parts.push({ name: 'accuracy', ...a });
    if (!a.pass) failed.push(...(a.reasons ?? []).map((r) => `정확성: ${r}`));
  } else invalid.push('정확성 결과가 없다');
  if (report.hot) {
    const h = judgeHotLag(report.hot.samples ?? [], report.hot.options ?? {});
    parts.push({ name: 'hot', ...h });
    if (!h.valid) invalid.push(...h.reasons);
    else if (!h.pass) failed.push(...h.reasons);
  }
  const verdict = invalid.length > 0 ? 'invalid' : failed.length > 0 ? 'fail' : 'pass';
  return { verdict, pass: verdict === 'pass', reasons: [...invalid, ...failed], invalid, failed, parts };
}

/** 성능 장부 `collect.py --bench-summary`가 읽는 모양 */
export function benchOf(report) {
  const total = Number(report?.total ?? 0);
  const dropped = Number(report?.producerFailures ?? 0);
  const p95 = Number(report?.freshness?.p95 ?? 0);
  const ratio = Number(report?.loss?.ratio ?? 0);
  return { requests: total, dropped, p99_ms: p95, error_rate: ratio };
}

/** 사람이 읽는 ms 표기 */
export function ms(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  return n >= 1_000 ? `${(n / 1_000).toFixed(2)}s` : `${Math.round(n)}ms`;
}

/** 쉼표 목록 인자 */
export function listOf(v) {
  return String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
