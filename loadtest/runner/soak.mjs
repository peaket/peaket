// F-08-5(MSR-050) 장시간 시험 판정·보고서 도구.
//
// 정본: docs/verification.md §3.6(장시간 시험)·V-T10(636행), docs/architecture.md §7 NFR-027,
//       docs/perf-ledger.md §7(표시·이항 상한). 계획: docs/review/plans/F-08-5.md §6·§8.
// 이 파일은 순수 함수만 둔다. Docker·kind·k6 없이 시험한다.
// 숫자를 만들지 않는다. 6시간 측정 전에는 모든 판정이 미측정이다.

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * NFR-027 대상 다섯(정본 순서). rate는 계획 세기이고, rateSource는 그 근거다.
 * 오류 기준·최소 시행 수는 docs/perf-ledger.md §7과 대상 SLO에서 온다.
 */
export const SOAK_TARGETS = Object.freeze([
  Object.freeze({
    id: 'queue-svc',
    load: 'http',
    rate: 500,
    rateSource: 'K1 1,000/s 중 r3 1회 통과의 50%(문서 인용)',
    entryUsers: 5000,
    entrySeconds: 10,
    admitPerSecond: 28,
    errorRateLimit: 0.001,
    minTrials: 2995,
    errorRateSource: 'NFR-001·Q-T2 0.1%',
  }),
  Object.freeze({
    id: 'purchase-svc',
    load: 'http',
    rate: 1000,
    rateSource: 'K2 2,000/s 유효 2회의 50%(문서 인용, S-T1 미달)',
    holdSize: 2,
    release: true,
    errorRateLimit: 0.001,
    minTrials: 2995,
    errorRateSource: '[가정, F-08-5 계획] NFR-003·S-T1에 오류율 기준이 없다',
  }),
  Object.freeze({
    id: 'payment-svc',
    load: 'http',
    rate: 150,
    rateSource: '[가정, F-08-5 계획] K7 ① 300/s 계획의 50%, 유효 실행 0',
    seatsPerOrder: 2,
    errorRateLimit: 0.0005,
    minTrials: 5991,
    errorRateSource: 'NFR-006 완료율 99.95%·P-T5 0.05% 이하',
  }),
  Object.freeze({
    id: 'realtime-gw',
    load: 'ws',
    rate: 63,
    rateSource: 'S-T12 설계 5,000 연결·125/s의 50%(연결 2,500, 홀드 63/s)',
    connections: 2500,
    holdRate: 63,
    errorRateLimit: 0.001,
    minTrials: 2995,
    errorRateSource: '[가정, F-08-5 계획]',
  }),
  Object.freeze({
    id: 'outbox-relay',
    load: 'relay',
    rate: 100,
    rateSource: '[가정, F-08-5 계획] 유효 최대값 없음',
    errorRateLimit: 0.001,
    minTrials: 2995,
    errorRateSource: '[가정, F-08-5 계획]',
  }),
]);

export const SOAK_DEFAULTS = Object.freeze({ durationMin: 360, warmupMin: 30, sampleSec: 60 });

export const NFR027_METRICS = Object.freeze([
  'heapAfterGcMb',
  'rssMb',
  'openFds',
  'activeHandles',
  'dbConns',
  'redisConns',
]);

const TARGET_BY_ID = new Map(SOAK_TARGETS.map((t) => [t.id, t]));
const LABELS = Object.freeze(new Set(['실측(PC)', '미측정', '무효', '판정 못 함', '문서 인용', '설계 목표', '계산']));
const SLOPE_LIMIT = 0.01;
const P99_LIMIT = 0.1;
const EPS = 1e-12;

const int = (v) => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const targetOf = (id) => TARGET_BY_ID.get(id) ?? null;

function takeValue(argv, i, flag) {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} 값이 없다`);
  return v;
}

/**
 * 명령줄을 읽는다. 6시간 미만은 `--rehearsal`일 때만 받고, 누수 판은 purchase-svc의
 * 360분 실행에만 붙는다. `--record`는 실행 ID가 있어야 하고 연습에는 쓰지 않는다.
 */
export function parseSoakArgs(argv = []) {
  const o = {
    target: null,
    rate: null,
    out: null,
    durationMin: SOAK_DEFAULTS.durationMin,
    warmupMin: SOAK_DEFAULTS.warmupMin,
    sampleSec: SOAK_DEFAULTS.sampleSec,
    rehearsal: false,
    record: false,
    runId: null,
    leak: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--target') o.target = takeValue(argv, i++, a);
    else if (a === '--rate') o.rate = Number(takeValue(argv, i++, a));
    else if (a === '--out') o.out = takeValue(argv, i++, a);
    else if (a === '--duration-min') o.durationMin = Number(takeValue(argv, i++, a));
    else if (a === '--warmup-min') o.warmupMin = Number(takeValue(argv, i++, a));
    else if (a === '--sample-sec') o.sampleSec = Number(takeValue(argv, i++, a));
    else if (a === '--rehearsal') o.rehearsal = true;
    else if (a === '--record') o.record = true;
    else if (a === '--run-id') o.runId = takeValue(argv, i++, a);
    else if (a === '--leak') o.leak = takeValue(argv, i++, a);
    else if (a === '--docker-all') throw new UsageError('docker-all은 쓰지 않는다. docker 한 자리만 잡는다');
    else throw new UsageError(`모르는 인자: ${a}`);
  }

  if (!o.target) throw new UsageError('--target이 필요하다(대상 다섯 가운데 하나)');
  if (!targetOf(o.target)) throw new UsageError(`모르는 target: ${o.target}`);
  if (!Number.isInteger(o.rate) || o.rate < 1) throw new UsageError('--rate는 1 이상의 정수다');
  if (!o.out) throw new UsageError('--out이 필요하다');
  if (!Number.isInteger(o.durationMin) || o.durationMin < 1) throw new UsageError('--duration-min은 1 이상의 정수다');
  if (!Number.isInteger(o.warmupMin) || o.warmupMin < 0) throw new UsageError('--warmup-min은 0 이상의 정수다');
  if (!Number.isInteger(o.sampleSec) || o.sampleSec < 1) throw new UsageError('--sample-sec은 1 이상의 정수다');
  if (o.warmupMin < SOAK_DEFAULTS.warmupMin) throw new UsageError('--warmup-min은 30분 이상이어야 한다');
  if (o.durationMin < SOAK_DEFAULTS.durationMin && !o.rehearsal) {
    throw new UsageError('--duration-min은 360분 이상이어야 한다(연습은 --rehearsal)');
  }

  if (o.leak !== null) {
    if (o.target !== 'purchase-svc') throw new UsageError('--leak은 purchase-svc에만 쓸 수 있다');
    if (o.leak !== 'db-conn') throw new UsageError('--leak은 db-conn만 받는다');
    if (o.rehearsal) throw new UsageError('--leak은 연습(rehearsal)에 쓸 수 없다. 6시간 판정 실행만이다');
    if (o.durationMin < SOAK_DEFAULTS.durationMin) throw new UsageError('--leak은 360분 실행에만 쓸 수 있다');
  }
  if (o.record && !o.runId) throw new UsageError('--record에는 --run-id가 필요하다');
  if (o.record && o.rehearsal) throw new UsageError('--record는 연습(rehearsal)에 쓸 수 없다');

  return { ...o, judged: !o.rehearsal };
}

/**
 * (min, value) 표본의 1차 회귀 기울기(시간당). 표본 2개 미만·같은 시각·빠진 값은 null.
 * 균등 간격을 가정하지 않는다.
 */
export function slopePerHour(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const pts = [];
  for (const p of points) {
    const min = num(p?.min);
    const value = num(p?.value);
    if (min === null || value === null) return null;
    pts.push({ min, value });
  }
  pts.sort((a, b) => a.min - b.min);
  for (let i = 1; i < pts.length; i += 1) if (pts[i].min === pts[i - 1].min) return null;

  const hours = pts.map((p) => (p.min - pts[0].min) / 60);
  const meanX = hours.reduce((s, x) => s + x, 0) / hours.length;
  const meanY = pts.reduce((s, p) => s + p.value, 0) / pts.length;
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < pts.length; i += 1) {
    cov += (hours[i] - meanX) * (pts[i].value - meanY);
    varX += (hours[i] - meanX) ** 2;
  }
  if (!(varX > 0)) return null;
  return cov / varX;
}

function invalid(reasons, validity) {
  return { verdict: '무효', reasons, metrics: null, validity, judged: true };
}

function cannotJudge(reasons, metrics = null) {
  return { verdict: '판정 못 함', reasons, metrics, validity: null, judged: true };
}

/**
 * NFR-027 한 실행을 판정한다. 자원 여섯의 시간당 기울기·재시작 0·p99 두 창·오류 상한을 본다.
 * 유효 조건(360분·예열 30분·표본 330·2분 간격·발생기/호스트 포화·의존 저장소 재시작)을
 * 먼저 보고, 근거가 모자라면 `판정 못 함`, 어기면 `무효`다.
 */
export function judgeNFR027(run = {}) {
  const target = targetOf(run.target);
  if (run.rehearsal) return { verdict: '미측정', reasons: ['연습 실행은 판정하지 않는다'], metrics: null, validity: null, judged: false };
  if (!target) return cannotJudge([`모르는 대상: ${run.target}`]);

  const validity = {
    durationMin: run.durationMin,
    warmupMin: run.warmupMin,
    sampleCount: null,
    maxGapMin: null,
    dropped: run.dropped,
    generator: run.generator,
    host: run.host,
    dependencyRestarts: run.dependencyRestarts,
  };
  if (!Number.isFinite(run.durationMin) || run.durationMin < SOAK_DEFAULTS.durationMin) {
    return invalid([`실행 길이 ${run.durationMin}분 < 360분`], validity);
  }
  if (!Number.isFinite(run.warmupMin) || run.warmupMin < SOAK_DEFAULTS.warmupMin) {
    return invalid([`예열 ${run.warmupMin}분 < 30분`], validity);
  }

  const raw = (Array.isArray(run.samples) ? run.samples : [])
    .filter((s) => Number.isFinite(s?.min) && s.min >= run.warmupMin)
    .sort((a, b) => a.min - b.min);
  validity.sampleCount = raw.length;
  if (raw.length < 2) return cannotJudge(['예열 뒤 표본이 2개 미만이라 기울기를 낼 수 없다']);
  if (raw.length < 330) return invalid([`예열 뒤 표본 ${raw.length}개 < 330개`], validity);

  let maxGap = 0;
  for (let i = 1; i < raw.length; i += 1) maxGap = Math.max(maxGap, raw[i].min - raw[i - 1].min);
  validity.maxGapMin = maxGap;
  if (maxGap > 2) return invalid([`표본 간격 ${maxGap}분 > 2분`], validity);

  if (!Number.isFinite(run.dropped) || run.dropped < 0) return invalid(['dropped_iterations를 읽지 못했다'], validity);
  if (run.dropped > 0) return invalid([`dropped_iterations ${run.dropped}건`], validity);
  if (!run.generator || !Number.isFinite(run.generator.cpuPct) || !Number.isFinite(run.generator.memoryPct)) {
    return invalid(['발생기 지표를 읽지 못했다'], validity);
  }
  if (run.generator.cpuPct > 80) return invalid([`발생기 CPU ${run.generator.cpuPct}% > 80%`], validity);
  if (run.generator.memoryPct > 90) return invalid([`발생기 메모리 ${run.generator.memoryPct}% > 90%`], validity);
  if (!run.host || !Number.isFinite(run.host.cpuPct) || !Number.isFinite(run.host.procsRunning) || !Number.isFinite(run.host.logicalCpus)) {
    return invalid(['호스트 지표를 읽지 못했다'], validity);
  }
  if (run.host.cpuPct >= 85) return invalid([`호스트 CPU ${run.host.cpuPct}% >= 85%`], validity);
  if (run.host.procsRunning > run.host.logicalCpus) {
    return invalid([`procs_running ${run.host.procsRunning} > 논리 프로세서 ${run.host.logicalCpus}`], validity);
  }
  if (!Number.isFinite(run.dependencyRestarts) || run.dependencyRestarts < 0) return invalid(['의존 저장소 재시작 수를 읽지 못했다'], validity);
  if (run.dependencyRestarts > 0) return invalid([`의존 저장소 재시작 ${run.dependencyRestarts}회`], validity);

  const metrics = {};
  let missing = false;
  for (const id of NFR027_METRICS) {
    const pts = raw.map((s) => ({ min: s.min, value: s[id] }));
    if (pts.some((p) => num(p.value) === null)) {
      metrics[id] = null;
      missing = true;
      continue;
    }
    const slope = slopePerHour(pts);
    if (slope === null) {
      metrics[id] = null;
      missing = true;
      continue;
    }
    const start = num(pts[0].value);
    if (start === null) {
      metrics[id] = null;
      missing = true;
      continue;
    }
    const limitPerHour = start * SLOPE_LIMIT;
    const verdict = start === 0 ? (slope > EPS ? '미달' : '통과') : slope <= limitPerHour + EPS ? '통과' : '미달';
    metrics[id] = { start, slopePerHour: slope, limitPerHour, verdict };
  }
  if (missing) return cannotJudge(['자원 지표 하나 이상을 읽지 못했다'], metrics);

  const reasons = [];
  const failedMetrics = NFR027_METRICS.filter((id) => metrics[id].verdict === '미달');
  if (failedMetrics.length > 0) reasons.push(`자원 기울기 기준 초과: ${failedMetrics.join(', ')}`);

  if (!Number.isFinite(run.restarts) || run.restarts < 0) return cannotJudge(['재시작 수를 읽지 못했다'], metrics);
  if (run.restarts > 0) reasons.push(`재시작 ${run.restarts}회`);

  const p99 = run.p99;
  const sw = p99?.startWindow;
  const ew = p99?.endWindow;
  if (!sw || !ew || sw.fromMin !== 30 || sw.toMin !== 60 || ew.fromMin !== 330 || ew.toMin !== 360) {
    return cannotJudge(['p99 첫/마지막 30분 창이 정본과 다르다'], metrics);
  }
  const startP99 = num(sw.p99Ms);
  const endP99 = num(ew.p99Ms);
  if (startP99 === null || endP99 === null) return cannotJudge(['p99를 읽지 못했다'], metrics);
  if (startP99 === 0) {
    if (endP99 !== 0) return cannotJudge(['첫 30분 p99가 0이라 변화율을 낼 수 없다'], metrics);
  } else if ((endP99 - startP99) / startP99 > P99_LIMIT + EPS) {
    reasons.push(`p99 변화 ${(((endP99 - startP99) / startP99) * 100).toFixed(1)}% > 10%`);
  }

  const e = run.errors;
  if (!e || num(e.trials) === null || num(e.violations) === null || num(e.cpUpper) === null) {
    return cannotJudge(['오류 시행·위반·이항 상한을 읽지 못했다'], metrics);
  }
  if (e.trials < 0 || e.violations < 0 || e.violations > e.trials) return cannotJudge(['오류 시행·위반 수가 모순이다'], metrics);
  if (e.trials < target.minTrials) reasons.push(`오류 시행 ${e.trials} < 최소 ${target.minTrials}`);
  if (e.cpUpper > target.errorRateLimit + EPS) {
    reasons.push(`오류 이항 상한 ${e.cpUpper} > 허용 ${target.errorRateLimit}`);
  }

  if (reasons.length > 0) return { verdict: '미달', reasons, metrics, validity, judged: true };
  return { verdict: '통과', reasons: [], metrics, validity, judged: true };
}

/**
 * V-T10: purchase-svc의 고친 판(4a)과 DB 연결 누수 판(4c)을 같은 명목 조건에서 대조한다.
 * 누수 판이 DB 연결 수·FD 둘 다 `미달`이고 고친 판이 `통과`일 때만 통과다.
 */
export function judgeVT10({ leak, fixed } = {}) {
  if (!leak || !fixed) return { verdict: '미측정', reasons: ['누수 판·고친 판 중 하나가 없다'], leak: leak ?? null, fixed: fixed ?? null, detected: null };
  const same = ['target', 'rate', 'durationMin', 'warmupMin', 'baseCommit', 'leakIntervalMin'];
  const differs = same.filter((k) => leak[k] !== fixed[k]);
  const bad = [
    ...differs.map((k) => `${k} 다름(${leak[k]} vs ${fixed[k]})`),
    leak.variant !== 'leak' ? `누수 판 variant=${leak.variant}` : '',
    fixed.variant !== 'fixed' ? `고친 판 variant=${fixed.variant}` : '',
    leak.target !== 'purchase-svc' || fixed.target !== 'purchase-svc' ? '대상이 purchase-svc가 아니다' : '',
    leak.leakIntervalMin !== 10 ? `누수율 ${leak.leakIntervalMin}분/1개(10분이 아님)` : '',
  ].filter(Boolean);
  if (bad.length > 0) return { verdict: '판정 못 함', reasons: bad, leak, fixed, detected: null };

  const lv = leak.nfr027?.verdict;
  const fv = fixed.nfr027?.verdict;
  if (fv === '미달') return { verdict: '미달', reasons: ['고친 판이 NFR-027 미달'], leak, fixed, detected: null };
  if (lv === '통과') return { verdict: '판정 못 함', reasons: ['누수 판이 통과해 주입 효과가 없다'], leak, fixed, detected: null };
  if (lv !== '미달' || fv !== '통과') {
    return { verdict: '판정 못 함', reasons: [`누수 판=${lv ?? '없음'}, 고친 판=${fv ?? '없음'}`], leak, fixed, detected: null };
  }

  const detected = {
    dbConns: leak.nfr027?.metrics?.dbConns?.verdict === '미달',
    openFds: leak.nfr027?.metrics?.openFds?.verdict === '미달',
  };
  if (!detected.dbConns || !detected.openFds) {
    return {
      verdict: '판정 못 함',
      reasons: [`누수 판에서 기준 초과 지표: dbConns=${detected.dbConns}, openFds=${detected.openFds}`],
      leak,
      fixed,
      detected,
    };
  }
  return { verdict: '통과', reasons: [], leak, fixed, detected };
}

const labelOf = (v) => (LABELS.has(v) ? v : null);
const isNumberCell = (c) => /^-?\d+(?:\.\d+)?$/.test(String(c).replace(/,/g, ''));
const cellsOf = (line) => {
  const parts = line.split('|').map((s) => s.trim());
  return parts.slice(1, parts.length - 1);
};
const isSeparator = (cells) => cells.every((c) => /^:?-{3,}:?$/.test(c));
const isTableRow = (line) => line.trim().startsWith('|') && line.trim().endsWith('|');

function rowOrNull(cells, n) {
  return cells.length === n ? cells : null;
}

/**
 * 사람이 읽는 보고서를 쓴다. 숫자 줄마다 표시 칸이 있고, 실행 ID가 없으면 `—`다.
 * 이 함수는 값을 만들지 않고 입력만 옮긴다.
 */
export function renderSoakReport(input = {}) {
  const runs = Array.isArray(input.runs) && input.runs.length > 0
    ? input.runs
    : SOAK_TARGETS.map((t) => ({ target: t.id, rate: t.rate, durationMin: SOAK_DEFAULTS.durationMin, verdict: '미측정', label: '미측정', runId: null }));
  const nfr = input.nfr027 ?? '미측정';
  // 종합이 통과면 실행 ID가 붙은 행은 실측(PC)로 본다. ID가 없는 행은 그대로 두어
  // 검증기가 종합 통과와 실행 ID를 따로 거부하게 한다.
  const rows = runs.map((r) => (nfr === '통과' && r.runId ? { ...r, verdict: '통과', label: '실측(PC)' } : r));
  const vt = input.vt10 ?? { verdict: '미측정', leak: null, fixed: null };
  const lines = [];
  lines.push(`# ${input.title ?? 'F-08-5 장시간 시험 보고서'}`);
  lines.push('');
  lines.push('- **상태**: 측정 전에는 모든 수치가 `미측정`이다. 이 문서는 측정 기록이고 정본이 아니다.');
  lines.push('- **계획**: docs/review/plans/F-08-5.md. 정본: docs/verification.md §3.6·V-T10, docs/architecture.md §7 NFR-027.');
  lines.push('');
  lines.push('## 2. 대상·세기');
  lines.push('');
  lines.push('| 대상 | 세기 | 길이(분) | 판정 | 표시 | 실행 ID |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    lines.push(`| ${r.target} | ${r.rate ?? '—'} | ${r.durationMin ?? '—'} | ${r.verdict ?? '미측정'} | ${r.label ?? '미측정'} | ${r.runId ?? '—'} |`);
  }
  lines.push('');
  lines.push(`- NFR-027 종합: ${nfr}`);
  lines.push('');
  lines.push('## 3. 자원 지표');
  lines.push('');
  lines.push('- 지표 여섯의 시작값·시간당 기울기·기준·판정은 측정 뒤 표로 채운다. 표시 없는 숫자를 쓰지 않는다.');
  lines.push('');
  lines.push('## 4. NFR-027 판정');
  lines.push('');
  lines.push('- 재시작 0, p99 첫/마지막 30분 변화 10% 이내, 오류 이항 상한·최소 시행 수를 함께 적는다.');
  lines.push('');
  lines.push('## 5. 누수 주입 대조');
  lines.push('');
  lines.push('| 구분 | 무대 | 대상 | 세기 | 길이(분) | 누수율 | FD 시작 | 판정 | 표시 | 실행 ID |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  const leak = vt.leak;
  const fixed = vt.fixed;
  const leakRate = (v) => (v === 10 ? '10분에 1개' : v === 0 || v === null || v === undefined ? '—' : `${v}분에 1개`);
  if (leak) lines.push(`| 누수 | ${leak.stage ?? '—'} | ${leak.target ?? '—'} | ${leak.rate ?? '—'} | ${leak.durationMin ?? '—'} | ${leakRate(leak.leakIntervalMin)} | ${leak.fdStart ?? '—'} | ${leak.verdict ?? '미측정'} | ${leak.label ?? '미측정'} | ${leak.runId ?? '—'} |`);
  else lines.push('| 누수 | — | purchase-svc | — | — | 10분에 1개 | — | 미측정 | 미측정 | — |');
  if (fixed) lines.push(`| 고친 | ${fixed.stage ?? '—'} | ${fixed.target ?? '—'} | ${fixed.rate ?? '—'} | ${fixed.durationMin ?? '—'} | ${leakRate(fixed.leakIntervalMin)} | ${fixed.fdStart ?? '—'} | ${fixed.verdict ?? '미측정'} | ${fixed.label ?? '미측정'} | ${fixed.runId ?? '—'} |`);
  else lines.push('| 고친 | — | purchase-svc | — | — | — | — | 미측정 | 미측정 | — |');
  lines.push('');
  lines.push(`- V-T10 종합: ${vt.verdict ?? '미측정'}`);
  lines.push('');
  lines.push('## 6. 한계');
  lines.push('');
  lines.push('- 서비스 하나씩이라 클러스터 규모 누수와 6시간보다 긴 주기 누수는 보지 못한다. 세기가 50%가 아니면 그 사실을 적는다.');
  lines.push('');
  lines.push('## 8. 주장하지 않는 것');
  lines.push('');
  lines.push('- 30,000건/초·100만·K1/K2/K7은 주장하지 않는다(문서 인용만).');
  return `${lines.join('\n')}\n`;
}

/**
 * 보고서를 검사한다. 표시 없는 숫자 줄, 실행 ID 없는 실측, 같은 실행 ID의 두 대상,
 * 성급한 종합 통과, 30,000건/초·100만·K1/K2/K7 주장을 거부한다.
 * `runExists(id, target)`가 그 대상의 장부 실행인지 본다.
 */
export function validateSoakReport(markdown, { runExists } = {}) {
  if (typeof markdown !== 'string') throw new Error('보고서가 문자열이 아니다');
  const exists = typeof runExists === 'function' ? runExists : () => false;
  const lines = markdown.split('\n');
  const targetRows = [];
  const vtRows = [];
  let targetVerdict = null;
  let vtVerdict = null;

  for (const line of lines) {
    if (!isTableRow(line)) continue;
    const cells = cellsOf(line);
    if (cells.length === 0 || cells[0] === '대상' || cells[0] === '구분' || isSeparator(cells)) continue;
    const hasNumber = cells.some(isNumberCell);
    const hasLabel = cells.some((c) => LABELS.has(c));
    if (hasNumber && !hasLabel) throw new Error(`표시 없는 숫자 줄: ${line.slice(0, 120)}`);
    if (targetOf(cells[0])) {
      const row = rowOrNull(cells, 6);
      if (!row) throw new Error(`대상 표의 칸이 6개가 아니다: ${line.slice(0, 120)}`);
      const [target, rate, durationMin, verdict, label, runId] = row;
      const safeLabel = labelOf(label);
      if (!safeLabel) throw new Error(`표시 없는 숫자 줄(허용하지 않는 표시 ${label}): ${line.slice(0, 120)}`);
      targetRows.push({ target, rate, durationMin, verdict, label: safeLabel, runId });
    } else if (cells[0] === '누수' || cells[0] === '고친') {
      const row = rowOrNull(cells, 10);
      if (!row) throw new Error(`V-T10 표의 칸이 10개가 아니다: ${line.slice(0, 120)}`);
      const [kind, stage, target, rate, durationMin, leakRate, fdStart, verdict, label, runId] = row;
      const safeLabel = labelOf(label);
      if (!safeLabel) throw new Error(`표시 없는 숫자 줄(허용하지 않는 표시 ${label}): ${line.slice(0, 120)}`);
      vtRows.push({ kind, stage, target, rate, durationMin, leakRate, fdStart, verdict, label: safeLabel, runId });
    }
  }

  const ids = new Map();
  for (const r of targetRows) {
    if (!r.runId || r.runId === '—') continue;
    const prev = ids.get(r.runId);
    if (prev && prev !== r.target) throw new Error(`같은 실행 ID가 두 대상에 쓰였다: ${r.runId} (${prev}, ${r.target})`);
    ids.set(r.runId, r.target);
  }

  for (const r of targetRows) {
    if (r.label !== '실측(PC)') continue;
    if (!r.runId || r.runId === '—') throw new Error(`실측(PC)에 실행 ID가 없다: ${r.target}`);
    if (!exists(r.runId, r.target)) throw new Error(`실행 ID가 장부에 없다: ${r.runId} (${r.target})`);
  }

  for (const line of lines) {
    const m = /NFR-027 종합:\s*(\S+)/.exec(line);
    if (m) targetVerdict = m[1];
    const v = /V-T10 종합:\s*(\S+)/.exec(line);
    if (v) vtVerdict = v[1];
  }

  if (targetVerdict === '통과') {
    if (targetRows.length !== SOAK_TARGETS.length) throw new Error(`NFR-027 종합 통과인데 대상 행이 ${targetRows.length}개다`);
    for (const t of SOAK_TARGETS) {
      const row = targetRows.filter((r) => r.target === t.id);
      if (row.length !== 1) throw new Error(`NFR-027 종합 통과인데 ${t.id} 행이 ${row.length}개다`);
      if (row[0].verdict !== '통과') throw new Error(`NFR-027 종합 통과인데 ${t.id} 판정이 ${row[0].verdict}다`);
      if (row[0].label !== '실측(PC)') throw new Error(`NFR-027 종합 통과인데 ${t.id} 표시가 ${row[0].label}다`);
      if (!row[0].runId || row[0].runId === '—' || !exists(row[0].runId, t.id)) throw new Error(`NFR-027 종합 통과인데 ${t.id} 실행 ID가 없다`);
    }
  }

  if (vtVerdict === '통과') {
    const leak = vtRows.find((r) => r.kind === '누수');
    const fixed = vtRows.find((r) => r.kind === '고친');
    if (!leak || !fixed) throw new Error('V-T10 종합 통과인데 누수·고친 행이 둘 다 있지 않다');
    for (const r of [leak, fixed]) {
      if (r.verdict !== '통과') throw new Error(`V-T10 종합 통과인데 ${r.kind} 판정이 ${r.verdict}다`);
      if (r.label !== '실측(PC)') throw new Error(`V-T10 종합 통과인데 ${r.kind} 표시가 ${r.label}다`);
      if (!r.runId || r.runId === '—' || !exists(r.runId, 'purchase-svc')) throw new Error(`V-T10 종합 통과인데 ${r.kind} 실행 ID가 없다`);
    }
    if (!leak.leakRate.includes('10분에 1개')) throw new Error(`V-T10 누수율이 10분에 1개가 아니다: ${leak.leakRate}`);
    if (!Number.isFinite(Number(leak.fdStart)) || !Number.isFinite(Number(fixed.fdStart))) {
      throw new Error('V-T10 FD 시작값이 숫자가 아니다');
    }
  }

  for (const line of lines) {
    const forbidden = /30,000건\/초|100만|K[127] 통과/.test(line);
    if (forbidden && !/주장하지 않|인용/.test(line)) throw new Error(`금지 주장: ${line.trim().slice(0, 120)}`);
  }

  const pass = targetRows.filter((r) => r.verdict === '통과').length;
  return { targets: targetRows.length, pass, vt10: vtVerdict ?? '미측정' };
}
