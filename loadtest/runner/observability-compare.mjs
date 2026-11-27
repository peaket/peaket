// F-08-14 K8/K9·관측 백엔드 비교의 순수 함수. 계획 docs/review/plans/F-08-14.md §6~§10.
// - K8은 G-01~G-10의 T0·T1·T1p·T2·T3에서 탐지·전파를 계산한다. G-07만 T1 대신 T1p를 쓴다.
// - K9는 HPA 파드 확장 시간(복제 1→N, --settle)이다. 관측 백엔드 비교는 OPS-510이다.
// - OPS-510은 로컬 양을 외삽해 후보·구성 요소·요청 기록 저장소 세 안의 연간 비용을 계산한다.
// - 이 파일은 측정 결과를 주장하지 않는다. 입력이 없으면 미측정/판정 못 함이다.
// - Docker·kind·k6·브라우저를 쓰지 않는다.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const PII_PATH = join(ROOT, 'packages', 'platform', 'src', 'pii-patterns.json');

/** 잘못된 인자·금지 인자 */
export class UsageError extends Error {
  name = 'UsageError';
}

export const F0814_WINDOW = '3g';
export const F0814_K8_IDS = Object.freeze(Array.from({ length: 10 }, (_, i) => `G-${String(i + 1).padStart(2, '0')}`));
export const F0814_VERDICTS = Object.freeze(['통과', '미달', '판정 못 함', '무효', '미측정']);
export const F0814_K8_LIMITS = Object.freeze({ detectionSec: 60, propagationSec: 3, detectionRate: 1 });
export const F0814_K9_LIMITS = Object.freeze({ readySec: 60 });
export const F0814_SENSITIVITY = Object.freeze([0.5, 1, 1.5]);
export const F0814_DEFAULTS = Object.freeze({
  sampleBudget: 40_000_000,
  tieRatio: 0.1,
  timeRateKrw: 49_538,
  postmortemHours: 48,
});

const fast = { scrapeSec: 5, evalSec: 5, groupWaitSec: 5, forSec: 0 };
const slow = { scrapeSec: 15, evalSec: 5, groupWaitSec: 5, forSec: 0 };
const cause = { scrapeSec: 15, evalSec: 5, groupWaitSec: 5, forSec: 30 };
export const F0814_K8_INTERVALS = Object.freeze({
  'G-01': fast,
  'G-02': fast,
  'G-03': fast,
  'G-04': fast,
  'G-05': fast,
  'G-06': fast,
  'G-07': slow,
  'G-08': cause,
  'G-09': cause,
  'G-10': cause,
});

/** docs/observability.md §12:736~747의 이름·기대 경보. 시험과 같은 전체 문자열이다. */
export const F0814_SCENARIOS = Object.freeze([
  ['G-01', '대기열 Redis 클러스터 CPU 사용률 > 75% 강제 주입', '대기열 진입 번 레이트 가속 경보 발령'],
  ['G-02', '좌석 Redis 클러스터 프라이머리 마스터 노드 강제 페일오버(고장 난 쪽 대신 예비 쪽으로 넘기는 것)', '좌석 홀드 503(`seat-store-unavailable`) 급증, `seat_store_unavailable{event_id}` = 1, 페일오버 감지 이벤트 수신'],
  ['G-03', 'CDN 엣지의 대기열 상태 조회 파일 응답 오류율 > 1% 주입', '대기 순번 조회 가용성 저하 경보'],
  ['G-04', '공연 상세 페이지 오리진 서버 에러율 > 1% 주입', '공연 정보 페이지 에러 버짓 소진 경보'],
  ['G-05', 'PG사(토스형 시뮬레이터) 결제 승인 API에 지연시간 p99 > 5초인 지연을 일부러 주입', 'SEV2 결제 확정 임박(승인 호출 p99 2초 초과, 호출은 끊지 않는다), 결제 확정 소요 p99 5초 초과로 RB-07 전환 검토, 결제 확정 SLO 소진이 10배에 닿으면 SEV1(ADR-0069)'],
  ['G-06', 'realtime-gw 파드의 소켓 송신 버퍼 큐 포화 상태 유발', '버퍼로 1초 간격이 된 연결 비율 경보(`realtime_gw_buffer_slow_connections` ÷ `realtime_gw_connections` 5% [가정] 30초, SEV2)와 `realtime_gw_degraded` 경보(ADR-0298)'],
  ['G-07', '스트림 작업자 `ops-rt` 밀림 주입(ClickHouse 삽입 지연, ADR-0099)', '판매 중 탭 머리의 신선도가 경고 색(1분 p95 5초 넘음)으로 바뀌는 것이 K8의 탐지다. 3분 넘게 이어지면 SEV3(hygiene, ADR-0071)(추천 적용 2026-10-20, ADR-0073)'],
  ['G-08', 'ops-svc 관제 백엔드 파드 모두 강제 종료 (CrashLoopBackOff)', 'ops-svc 가용성 상실 SEV1(§5 관제 자체·기반 신호, 30초 [가정])'],
  ['G-09', 'admission-ctrl 리더 파드의 프로세스 강제 종료 (SIGKILL)', 'admission-ctrl 리더 부재 30초 [가정] 초과 SEV2(§5)'],
  ['G-10', 'MSK Kafka 브로커 노드 1대 강제 오프라인 격리', '브로커 오프라인 SEV2, 거래 토픽 소비 지연 30초 [가정]·1분이면 같은 SEV2(§5)'],
].map(([id, name, expectedAlert], index) => Object.freeze({
  id,
  order: index + 1,
  name,
  expectedAlert,
  canonical: 'docs/observability.md §12',
  source: id === 'G-02' || id === 'G-10' ? 'F-08-6·F-08-12' : 'F-08-6',
})));

export const F0814_K9 = Object.freeze({
  name: 'hpa-pod-ready',
  source: 'docs/verification.md §3.10',
  flag: '--hpa-timeline',
  replicasBefore: 1,
  v0Note: 'v0 19~51초는 version: v0, verdict: baseline 인용이다',
  v0IsV1Pass: false,
  inputStatus: '미측정',
  reason: 'F-08-8 계획은 K9/HPA를 범위 밖으로 두고 HPA를 껐고, K1 실행도 §3.10의 1만·10만 --settle 실행이 아니다',
});

export const F0814_PRIOR_MEASUREMENTS = Object.freeze([
  Object.freeze({ id: 'F-08-5', status: '무효·미측정', evidence: '측정' }),
  Object.freeze({ id: 'F-08-9', status: '판정 못 함(무효·부분)', evidence: '측정' }),
  Object.freeze({ id: 'F-08-10', status: '미측정', evidence: '뼈대' }),
  Object.freeze({ id: 'F-08-12', status: '미측정', evidence: '뼈대' }),
  Object.freeze({ id: 'F-08-13', status: '미측정', evidence: '설계만' }),
  Object.freeze({ id: 'F-08-6', status: '미측정', evidence: '뼈대' }),
]);

export const F0814_INPUTS = Object.freeze([
  Object.freeze({ id: 'F-08-6', path: 'docs/review/measurements/F-08-6-gameday.md', k8Ids: F0814_K8_IDS, status: '미측정', evidence: '뼈대', k9: false }),
  Object.freeze({ id: 'F-08-12', path: 'docs/review/measurements/F-08-12-gameday-local.md', k8Ids: ['G-02', 'G-10'], status: '미측정', evidence: '뼈대', k9: false }),
  Object.freeze({ id: 'F-08-13', path: 'docs/review/measurements/F-08-13-recovery.md', k8Ids: [], status: '미측정', evidence: '설계만', k9: false }),
  Object.freeze({ id: 'F-08-8', path: 'docs/review/measurements/F-08-8-after.md', k8Ids: [], status: '미측정', evidence: '측정', k9: true }),
  Object.freeze({ id: 'ops-hours', path: 'docs/perf-ledger/ops-hours.csv', k8Ids: [], status: '미측정', evidence: '0행', k9: false }),
]);

export const F0814_BACKENDS = Object.freeze(['self', 'aws', 'datadog']);
export const F0814_TRACE_STORES = Object.freeze(['tempo-msk', 'tempo-monolith', 'xray']);
export const F0814_COMPONENTS = Object.freeze([
  Object.freeze({ id: 'prometheus', retentionDays: 15, query: 'PromQL', ops: '직접' }),
  Object.freeze({ id: 'mimir', retentionDays: 395, query: 'PromQL', ops: '직접' }),
  Object.freeze({ id: 'loki', retentionDays: 30, query: 'LogQL', ops: '직접' }),
  Object.freeze({ id: 'tempo', retentionDays: 14, query: 'TraceQL', ops: '직접' }),
  Object.freeze({ id: 'pyroscope', retentionDays: 7, query: 'Pyroscope', ops: '직접' }),
]);

export const F0814_PRICES = Object.freeze({
  amp: Object.freeze({
    freeSamples: 40_000_000,
    ingestTiers: Object.freeze([
      Object.freeze({ upToSamples: 2_000_000_000, perSamples: 10_000_000, unitPriceUsd: 0.9 }),
      Object.freeze({ upToSamples: 250_000_000_000, perSamples: 10_000_000, unitPriceUsd: 0.35 }),
    ]),
    storageFreeGB: 10,
    storagePerGBMonthUsd: 0.03,
    queryFreeSamples: 200_000_000_000,
    queryPerBillionUsd: 0.1,
    priceDate: '2026-10-14',
  }),
  amg: Object.freeze({ editorUsd: 9, viewerUsd: 5, priceDate: '2026-10-20' }),
  datadog: Object.freeze({
    infraProPerServerUsd: 15,
    apmPerServerUsd: 40,
    metricsIncludedPerServer: 100,
    extraMetricsPer100Usd: 5,
    logsPerGBUsd: 0.1,
    priceDate: '2026-10-19',
  }),
  xray: Object.freeze({
    perMillionStoredUsd: 5,
    perMillionQueriedUsd: 0.5,
    freeTracesPerMonth: 100_000,
    freeQueriesPerMonth: 1_000_000,
    priceDate: '2026-09-11',
  }),
  s3: Object.freeze({ perGBMonthUsd: 0.025, priceDate: '2026-10-15' }),
  timeRateKrw: 49_538,
});

export const F0814_STOP_RULES = Object.freeze([
  Object.freeze({ id: 'STOP-01', rule: '입력이 없다고 새 측정·새 무대를 만들려 한다' }),
  Object.freeze({ id: 'STOP-02', rule: 'Docker·kind·k6·브라우저를 쓰려 한다' }),
  Object.freeze({ id: 'STOP-03', rule: '입력이 없는데 측정함·통과로 적는다' }),
  Object.freeze({ id: 'STOP-04', rule: 'K8 간격을 줄인 시험 설정으로 잰 값을 쓴다' }),
  Object.freeze({ id: 'STOP-05', rule: '탐지율 분모를 10이 아닌 측정 행 수로 바꿔 100퍼센트를 만든다' }),
  Object.freeze({ id: 'STOP-06', rule: 'K9를 --hpa-timeline·--settle·복제 1→N·실행 증거 없이 통과로 적는다' }),
  Object.freeze({ id: 'STOP-07', rule: 'OPS-510 가격 조회 날짜·환율 값·출처·기준일·운영 시간 없이 후보 1위를 낸다' }),
  Object.freeze({ id: 'STOP-08', rule: 'AWS·Datadog에 자료를 보내거나 유료 등급을 쓴다' }),
  Object.freeze({ id: 'STOP-09', rule: 'F-08-6·F-08-12·F-08-13 파일을 고친다' }),
  Object.freeze({ id: 'STOP-10', rule: '30,000건/초·100만·K1/K2/K7 0을 주장하거나 release·develop에 합치려 한다' }),
]);

export const F0814_OUTSIDE = Object.freeze([
  'Q-T2', 'S-T1', 'P-T1', 'V-T4', 'V-T5', 'V-T17', 'V-T18', 'V-T27', 'V-T28', 'NFR-027', 'NFR-028',
  'K1', 'K2', 'K7', 'OPS-520', 'OPS-530',
  ...Array.from({ length: 23 }, (_, i) => `G-${String(i + 11).padStart(2, '0')}`),
]);

export const F0814_ARTIFACTS = Object.freeze({
  k8Csv: Object.freeze({ file: 'k8.csv', columns: Object.freeze(['scenario', 'source', 'run_id', 't0', 't1', 't1p', 't2', 't3', 'detection_sec', 'propagation_sec', 'verdict', 'evidence']) }),
  k9Csv: Object.freeze({ file: 'k9.csv', columns: Object.freeze(['run_id', 'load_start_ms', 'scaled_at_ms', 'pod_ready_at_ms', 'scale_sec', 'ready_sec', 'verdict']) }),
  backendCostCsv: Object.freeze({ file: 'backend_cost.csv', columns: Object.freeze(['candidate', 'item', 'quantity', 'unit', 'unit_price_usd', 'price_date', 'annual_usd', 'source']) }),
  componentsCsv: Object.freeze({ file: 'components.csv', columns: Object.freeze(['component', 'retention_days', 'storage_gb', 'annual_usd', 'query', 'ops']) }),
  traceStoresCsv: Object.freeze({ file: 'trace_stores.csv', columns: Object.freeze(['store', 'storage', 'retention_days', 'annual_usd', 'durable3', 'open_peak', 'verdict']) }),
  manifest: 'manifest.json',
});

const number = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round6 = (v) => (v === null ? null : Math.round(v * 1_000_000) / 1_000_000);
const text = (v) => (typeof v === 'string' ? v.trim() : '');

function sameIntervals(a, b) {
  if (!a || typeof a !== 'object') return false;
  return ['scrapeSec', 'evalSec', 'groupWaitSec', 'forSec'].every((key) => a[key] === b[key]);
}

function rateOf(krwPerUsd) {
  return F0814_PRICES.timeRateKrw / krwPerUsd;
}

// ───────────── 입력 읽기 ─────────────

/** K8 보고서(JSON {rows} 또는 F-08-6 Markdown 표)를 읽는다. 파일 없음·행 0개는 ok:false. */
export function readK8Report(file) {
  const path = resolve(file);
  if (!existsSync(path)) return { ok: false, rows: [], missing: true, reason: `보고서가 없다: ${path}` };
  let body;
  try {
    body = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    return { ok: false, rows: [], reason: `보고서를 읽지 못했다: ${error.message}` };
  }
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
      return rows.length ? { ok: true, rows } : { ok: false, rows: [], reason: '행이 0개다' };
    } catch (error) {
      return { ok: false, rows: [], reason: `JSON을 읽지 못했다: ${error.message}` };
    }
  }
  const lines = body.split(/\r?\n/);
  const headerAt = lines.findIndex((line) => line.trim().startsWith('|') && line.includes('시나리오') && line.includes('탐지'));
  if (headerAt < 0) return { ok: false, rows: [], reason: 'K8 표 머리글을 찾지 못했다' };
  const headers = lines[headerAt].split('|').slice(1, -1).map((x) => x.trim());
  const col = (name) => headers.findIndex((h) => h === name || h.startsWith(name));
  const idx = {
    id: col('시나리오'),
    detectionSec: col('탐지'),
    propagationSec: col('전파'),
    verdict: col('판정'),
    evidence: headers.findIndex((h) => h === '증거' || h === '표시'),
  };
  const rows = [];
  for (let i = headerAt + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) break;
    if (/^\|\s*-/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((x) => x.trim());
    const id = idx.id >= 0 ? cells[idx.id] : null;
    if (!id || !/^G-\d\d$/.test(id)) continue;
    const value = (k) => {
      const v = idx[k] >= 0 ? cells[idx[k]] : null;
      if (v === undefined || v === null) return null;
      const s = v.trim();
      if (s === '' || s === '—' || s === '-' || s === '미측정' || s === 'null') return null;
      const n = Number(s);
      return Number.isFinite(n) && /^-?\d/.test(s) ? n : s;
    };
    rows.push({
      id,
      detectionSec: value('detectionSec'),
      propagationSec: value('propagationSec'),
      verdict: value('verdict') ?? '미측정',
      evidence: value('evidence') ?? '',
    });
  }
  return rows.length ? { ok: true, rows } : { ok: false, rows: [], reason: '행이 0개다' };
}

/** K9 요약(JSON {runs})을 읽는다. 파일 없음·실행 0개는 ok:false. */
export function readK9Summary(file) {
  const path = resolve(file);
  if (!existsSync(path)) return { ok: false, runs: [], missing: true, reason: `K9 요약이 없다: ${path}` };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    const runs = Array.isArray(parsed.runs) ? parsed.runs : [];
    return runs.length ? { ok: true, runs } : { ok: false, runs: [], reason: '실행이 0개다' };
  } catch (error) {
    return { ok: false, runs: [], reason: `K9 요약을 읽지 못했다: ${error.message}` };
  }
}

/** 운영 시간 CSV(머리글 + 행)를 읽는다. 파일 없음·0행은 ok:false. */
export function readOpsHours(file) {
  const path = resolve(file);
  if (!existsSync(path)) return { ok: false, rows: 0, hours: null, missing: true, reason: `운영 시간 기록이 없다: ${path}` };
  try {
    const lines = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim() !== '');
    const rows = Math.max(0, lines.length - 1);
    return rows > 0 ? { ok: true, rows, hours: null } : { ok: false, rows: 0, hours: null, reason: '운영 시간 행이 0개다' };
  } catch (error) {
    return { ok: false, rows: 0, hours: null, reason: `운영 시간 기록을 읽지 못했다: ${error.message}` };
  }
}

// ───────────── K8 ─────────────

export function judgeK8(input = {}) {
  const inputRows = Array.isArray(input.rows) ? input.rows : [];
  const reasons = [];
  const missing = [];
  const invalid = [];
  const perScenario = [];
  const seen = new Set();
  let duplicateOrUnknown = false;

  const byId = new Map();
  for (const row of inputRows) {
    const id = text(row?.id);
    if (!F0814_K8_IDS.includes(id)) {
      duplicateOrUnknown = true;
      continue;
    }
    if (seen.has(id)) {
      duplicateOrUnknown = true;
      continue;
    }
    seen.add(id);
    byId.set(id, row);
  }

  let measured = 0;
  let detected = 0;
  let within60 = 0;
  let maxDetectionSec = null;
  let propagationMeasured = 0;
  let propagationMaxSec = null;
  let propagationOver = false;
  let evidenceMissing = false;
  let unknown = false;

  for (const spec of F0814_SCENARIOS) {
    const row = byId.get(spec.id);
    const base = {
      id: spec.id,
      name: spec.name,
      source: row?.source ?? spec.source,
      t0: row?.t0 ?? null,
      t1: row?.t1 ?? null,
      t1p: row?.t1p ?? null,
      t2: row?.t2 ?? null,
      t3: row?.t3 ?? null,
      runId: row?.runId ?? '',
      usedT1p: false,
      detectionSec: null,
      propagationSec: null,
      verdict: '미측정',
      evidence: row?.evidence ?? '',
    };
    if (!row) {
      missing.push(spec.id);
      perScenario.push(base);
      continue;
    }
    if (row.valid === false || row.stageReady === false) {
      invalid.push(spec.id);
      perScenario.push({ ...base, verdict: '무효' });
      continue;
    }
    if (row.verdict === '미측정') {
      missing.push(spec.id);
      perScenario.push(base);
      continue;
    }
    if (!sameIntervals(row.intervals, F0814_K8_INTERVALS[spec.id])) {
      invalid.push(spec.id);
      perScenario.push({ ...base, verdict: '무효' });
      continue;
    }
    if (!text(row.runId) || row.runExists === false || row.manifest === false || row.timeline === false) {
      evidenceMissing = true;
      perScenario.push({ ...base, verdict: '판정 못 함' });
      continue;
    }
    if (row.verdict === '무효') {
      invalid.push(spec.id);
      perScenario.push({ ...base, verdict: '무효' });
      continue;
    }
    if (row.verdict === '판정 못 함') {
      unknown = true;
      perScenario.push({ ...base, verdict: '판정 못 함' });
      continue;
    }
    let t1 = number(row.t1);
    let usedT1p = false;
    if (t1 === null && spec.id === 'G-07') {
      t1 = number(row.t1p);
      usedT1p = t1 !== null;
    }
    const t0 = number(row.t0);
    let detectionSec = t0 !== null && t1 !== null ? round6((t1 - t0) / 1000) : null;
    if (detectionSec === null && number(row.detectionSec) !== null) detectionSec = round6(number(row.detectionSec));
    const t2 = number(row.t2);
    const t3 = number(row.t3);
    let propagationSec = t2 !== null && t3 !== null ? round6((t3 - t2) / 1000) : null;
    if (propagationSec === null && number(row.propagationSec) !== null) propagationSec = round6(number(row.propagationSec));

    if (detectionSec === null) {
      if (row.verdict === '미달') {
        measured += 1;
        perScenario.push({ ...base, verdict: '미달' });
      } else {
        unknown = true;
        perScenario.push({ ...base, verdict: '판정 못 함' });
      }
      continue;
    }
    if (detectionSec < 0 || (propagationSec !== null && propagationSec < 0)) {
      invalid.push(spec.id);
      perScenario.push({ ...base, detectionSec, propagationSec, verdict: '무효' });
      continue;
    }
    measured += 1;
    if (detectionSec <= F0814_K8_LIMITS.detectionSec) {
      detected += 1;
      within60 += 1;
    }
    maxDetectionSec = maxDetectionSec === null ? detectionSec : Math.max(maxDetectionSec, detectionSec);
    if (propagationSec !== null) {
      propagationMeasured += 1;
      propagationMaxSec = propagationMaxSec === null ? propagationSec : Math.max(propagationMaxSec, propagationSec);
      if (propagationSec > F0814_K8_LIMITS.propagationSec) propagationOver = true;
    }
    const verdict = detectionSec <= F0814_K8_LIMITS.detectionSec && (propagationSec === null || propagationSec <= F0814_K8_LIMITS.propagationSec)
      ? '통과'
      : '미달';
    perScenario.push({ ...base, t0, t1, t2, t3, usedT1p, detectionSec, propagationSec, verdict });
  }

  for (const id of F0814_K8_IDS) if (!seen.has(id) && !missing.includes(id)) missing.push(id);

  let verdict;
  if (duplicateOrUnknown || invalid.length > 0) verdict = '무효';
  else if (evidenceMissing || unknown) verdict = '판정 못 함';
  else if (measured === 0) verdict = '미측정';
  else if (measured < F0814_K8_IDS.length) verdict = '판정 못 함';
  else if (detected < F0814_K8_IDS.length || propagationOver) verdict = '미달';
  else if (propagationMeasured === 0) verdict = '판정 못 함';
  else verdict = '통과';

  if (verdict === '무효') reasons.push('중복·모르는 ID·무효 실행·간격 불일치가 있다');
  if (verdict === '판정 못 함') reasons.push('일부 행이 없거나 실행 증거·시각이 모자란다');
  if (verdict === '미측정') reasons.push('K8 입력 행이 없다');
  if (verdict === '미달') reasons.push('60초·3초 경계를 넘었거나 탐지하지 못한 행이 있다');

  return {
    verdict,
    reasons,
    detectionRate: measured === 0 ? null : detected / F0814_K8_IDS.length,
    measuredRate: measured / F0814_K8_IDS.length,
    measured,
    detected,
    within60,
    maxDetectionSec,
    propagationMeasured,
    propagationMaxSec,
    propagationVerdict: propagationMeasured === 0 ? '미측정' : propagationOver ? '미달' : '통과',
    missing: [...new Set(missing)],
    invalid: [...new Set(invalid)],
    perScenario,
  };
}

// ───────────── K9 ─────────────

export function judgeK9(input = {}) {
  const runs = Array.isArray(input.runs) ? input.runs : [];
  if (runs.length === 0) {
    return { verdict: '미측정', reasons: ['K9 유효 실행이 없다'], runs: [], maxReadySec: null, medianReadySec: null, count: 0 };
  }
  const reasons = [];
  const evaluated = [];
  let unknown = false;
  let invalid = false;
  for (const run of runs) {
    const id = text(run?.runId);
    const evidenceMissing = !id || run.runExists === false || run.manifest === false || run.timeline === false;
    const loadStart = number(run?.loadStartMs);
    const scaledAt = number(run?.scaledAtMs);
    const podReady = number(run?.podReadyAtMs);
    const badData = run.valid === false
      || run.settle === false
      || run.replicasBefore !== 1
      || !(Number.isFinite(run.replicasAfter) && run.replicasAfter > 1)
      || loadStart === null || scaledAt === null || podReady === null
      || scaledAt < loadStart || podReady < scaledAt;
    if (evidenceMissing) {
      unknown = true;
      evaluated.push({ runId: id, verdict: '판정 못 함' });
      continue;
    }
    if (badData) {
      invalid = true;
      evaluated.push({ runId: id, verdict: '무효' });
      continue;
    }
    const scaleSec = round6((scaledAt - loadStart) / 1000);
    const readySec = round6((podReady - loadStart) / 1000);
    evaluated.push({ runId: id, scaleSec, readySec, within60: readySec <= F0814_K9_LIMITS.readySec, verdict: readySec <= F0814_K9_LIMITS.readySec ? '통과' : '미달' });
  }
  const valid = evaluated.filter((x) => x.verdict === '통과' || x.verdict === '미달');
  const ready = valid.map((x) => x.readySec).sort((a, b) => a - b);
  let verdict;
  if (unknown) verdict = '판정 못 함';
  else if (invalid) verdict = '무효';
  else if (valid.some((x) => x.verdict === '미달')) verdict = '미달';
  else verdict = '통과';
  if (verdict === '판정 못 함') reasons.push('실행 ID·manifest·timeline·runExists 증거가 모자란다');
  if (verdict === '무효') reasons.push('복제 1→N·--settle·시각 순서가 맞지 않는다');
  if (verdict === '미달') reasons.push('파드 준비가 60초를 넘었다');
  return {
    verdict,
    reasons,
    runs: evaluated,
    maxReadySec: ready.length ? ready[ready.length - 1] : null,
    medianReadySec: ready.length ? (ready.length % 2 ? ready[(ready.length - 1) / 2] : (ready[ready.length / 2 - 1] + ready[ready.length / 2]) / 2) : null,
    count: runs.length,
  };
}

// ───────────── OPS-510 ─────────────

const METRIC_KEYS = ['activeSeries', 'samplesPerSecond', 'metricStorageGB', 'aggStorageGB', 'logGBPerDay', 'traceGBPerDay', 'profileGBPerDay', 'spansPerSecond', 'querySamplesPerYear', 'nodes', 'editors', 'viewers'];

function missingFields(obj, keys) {
  return keys.filter((key) => !Number.isFinite(obj?.[key]));
}

export function componentCosts(input = {}) {
  const metrics = input.metrics ?? {};
  const missing = missingFields(metrics, METRIC_KEYS);
  if (missing.length) return { verdict: '미측정', reasons: ['구성 요소 입력이 모자란다'], rows: [], missing };
  const s3 = (gb) => gb * F0814_PRICES.s3.perGBMonthUsd * 12;
  const rows = [
    { id: 'prometheus', retentionDays: 15, storageGB: metrics.metricStorageGB, annualUsd: 0, query: 'PromQL', ops: '직접', missing: [] },
    { id: 'mimir', retentionDays: 395, storageGB: metrics.metricStorageGB + metrics.aggStorageGB, annualUsd: s3(metrics.metricStorageGB + metrics.aggStorageGB), query: 'PromQL', ops: '직접', missing: [] },
    { id: 'loki', retentionDays: 30, storageGB: metrics.logGBPerDay * 30, annualUsd: s3(metrics.logGBPerDay * 30), query: 'LogQL', ops: '직접', missing: [] },
    { id: 'tempo', retentionDays: 14, storageGB: metrics.traceGBPerDay * 14, annualUsd: s3(metrics.traceGBPerDay * 14), query: 'TraceQL', ops: '직접', missing: [] },
    { id: 'pyroscope', retentionDays: 7, storageGB: metrics.profileGBPerDay * 7, annualUsd: s3(metrics.profileGBPerDay * 7), query: 'Pyroscope', ops: '직접', missing: [] },
  ];
  return { verdict: '통과', reasons: [], rows, missing: [] };
}

export function traceStoreCosts(input = {}) {
  const missing = [];
  for (const key of ['krwPerUsd', 'fxSource', 'fxDate', 'priceDate']) {
    if (key === 'krwPerUsd' ? !Number.isFinite(input[key]) : !text(input[key])) missing.push(key);
  }
  if (!input.metrics || !input.traceStore) missing.push('metrics/traceStore');
  const rate = Number.isFinite(input.krwPerUsd) ? rateOf(input.krwPerUsd) : null;
  const metrics = input.metrics ?? {};
  const store = input.traceStore ?? {};
  const s3tempo = Number.isFinite(metrics.traceGBPerDay) ? metrics.traceGBPerDay * 14 * F0814_PRICES.s3.perGBMonthUsd * 12 : null;
  const ops = (hours) => (rate !== null && Number.isFinite(hours) ? hours * rate : null);
  const row = (id, extra) => ({ id, storage: 'Tempo S3', retentionDays: 14, durable3: true, openPeak: null, verdict: '미측정', missing: [], ...extra });
  const rows = [];
  rows.push(row('tempo-msk', {
    annualUsd: Number.isFinite(store.obsKafkaMonthlyUsd) && Number.isFinite(s3tempo) && Number.isFinite(ops(store.opsHoursPerYear?.tempoMsk))
      ? s3tempo + store.obsKafkaMonthlyUsd * 12 + ops(store.opsHoursPerYear.tempoMsk) : null,
    openPeak: store.openPeakOk?.tempoMsk ?? null,
    missing: Number.isFinite(store.obsKafkaMonthlyUsd) ? [] : ['obsKafkaMonthlyUsd'],
  }));
  rows.push(row('tempo-monolith', {
    annualUsd: Number.isFinite(s3tempo) && Number.isFinite(ops(store.opsHoursPerYear?.tempoMonolith))
      ? s3tempo + ops(store.opsHoursPerYear.tempoMonolith) : null,
    openPeak: store.openPeakOk?.tempoMonolith ?? null,
  }));
  const xrayMonthly = Number.isFinite(store.xrayTracesPerMonth) && Number.isFinite(store.xrayQueriesPerMonth)
    ? Math.max(0, store.xrayTracesPerMonth - F0814_PRICES.xray.freeTracesPerMonth) / 1_000_000 * F0814_PRICES.xray.perMillionStoredUsd
      + Math.max(0, store.xrayQueriesPerMonth - F0814_PRICES.xray.freeQueriesPerMonth) / 1_000_000 * F0814_PRICES.xray.perMillionQueriedUsd
    : null;
  rows.push(row('xray', {
    storage: 'X-Ray',
    retentionDays: 30,
    annualUsd: Number.isFinite(xrayMonthly) && Number.isFinite(ops(store.opsHoursPerYear?.xray))
      ? xrayMonthly * 12 + ops(store.opsHoursPerYear.xray) : null,
    openPeak: store.openPeakOk?.xray ?? null,
    missing: Number.isFinite(store.xrayTracesPerMonth) && Number.isFinite(store.xrayQueriesPerMonth) ? [] : ['xrayTracesPerMonth/xrayQueriesPerMonth'],
  }));
  for (const r of rows) {
    if (r.annualUsd === null) r.verdict = '미측정';
    else if (r.openPeak === false) r.verdict = '판정 못 함';
    else if (r.openPeak === null) r.verdict = '판정 못 함';
    else r.verdict = '통과';
  }
  const eligible = rows.filter((r) => r.verdict === '통과' && r.durable3 === true && r.openPeak === true);
  eligible.sort((a, b) => a.annualUsd - b.annualUsd);
  const chosen = eligible[0]?.id ?? null;
  const verdict = missing.length ? '미측정' : rows.some((r) => r.verdict === '미측정') ? '판정 못 함' : chosen ? '통과' : '판정 못 함';
  return { verdict, reasons: verdict === '미측정' ? ['필수 입력이 모자란다'] : [], rows, chosen, missing };
}

function ampIngestAnnual(samplesPerMonth) {
  let billable = Math.max(0, samplesPerMonth - F0814_PRICES.amp.freeSamples);
  let cost = 0;
  let previous = 0;
  for (const tier of F0814_PRICES.amp.ingestTiers) {
    const capacity = tier.upToSamples - previous;
    const used = Math.min(billable, capacity);
    cost += used / tier.perSamples * tier.unitPriceUsd;
    billable -= used;
    previous = tier.upToSamples;
    if (billable <= 0) break;
  }
  return cost * 12;
}

export function backendCosts(input = {}) {
  const metrics = input.metrics ?? {};
  const missing = missingFields(metrics, METRIC_KEYS);
  const ops = input.opsHoursPerYear ?? {};
  missing.push(...missingFields(ops, ['self', 'aws', 'datadog']).map((key) => `ops.${key}`));
  for (const key of ['krwPerUsd']) if (!Number.isFinite(input[key])) missing.push(key);
  for (const key of ['fxSource', 'fxDate', 'priceDate']) if (!text(input[key])) missing.push(key);
  if (missing.length) return { verdict: '미측정', reasons: ['OPS-510 입력이 모자란다'], missing: [...new Set(missing)], candidates: [], sensitivity: [], chosen: null, tie: false, opsSensitive: false, sampleBudget: { samples: null, max: F0814_DEFAULTS.sampleBudget, sent: false }, traceStores: [] };

  const rate = rateOf(input.krwPerUsd);
  const r3 = input.r3 ?? {};
  const s3 = (gb) => gb * F0814_PRICES.s3.perGBMonthUsd * 12;
  const selfItems = [
    { item: 'self-s3', quantity: metrics.metricStorageGB + metrics.aggStorageGB + metrics.logGBPerDay * 30 + metrics.traceGBPerDay * 14 + metrics.profileGBPerDay * 7, unit: 'GB-month', unitPriceUsd: F0814_PRICES.s3.perGBMonthUsd, annualUsd: s3(metrics.metricStorageGB + metrics.aggStorageGB + metrics.logGBPerDay * 30 + metrics.traceGBPerDay * 14 + metrics.profileGBPerDay * 7) },
    { item: 'self-ops', quantity: ops.self, unit: 'hour', unitPriceUsd: F0814_PRICES.timeRateKrw / input.krwPerUsd, annualUsd: ops.self * rate },
  ];
  const samplesMonth = metrics.samplesPerSecond * 2_592_000;
  const awsItems = [
    { item: 'amp-ingest', quantity: samplesMonth, unit: 'sample-month', unitPriceUsd: null, annualUsd: ampIngestAnnual(samplesMonth) },
    { item: 'amp-storage', quantity: metrics.metricStorageGB + metrics.aggStorageGB, unit: 'GB', unitPriceUsd: F0814_PRICES.amp.storagePerGBMonthUsd, annualUsd: Math.max(0, metrics.metricStorageGB + metrics.aggStorageGB - F0814_PRICES.amp.storageFreeGB) * F0814_PRICES.amp.storagePerGBMonthUsd * 12 },
    { item: 'amp-query', quantity: metrics.querySamplesPerYear, unit: 'sample-year', unitPriceUsd: F0814_PRICES.amp.queryPerBillionUsd, annualUsd: Math.max(0, metrics.querySamplesPerYear - F0814_PRICES.amp.queryFreeSamples) / 1_000_000_000 * F0814_PRICES.amp.queryPerBillionUsd },
    { item: 'amg', quantity: metrics.editors + metrics.viewers, unit: 'user', unitPriceUsd: null, annualUsd: (metrics.editors * F0814_PRICES.amg.editorUsd + metrics.viewers * F0814_PRICES.amg.viewerUsd) * 12 },
    { item: 'aws-s3', quantity: metrics.logGBPerDay * 30 + metrics.traceGBPerDay * 14 + metrics.profileGBPerDay * 7, unit: 'GB-month', unitPriceUsd: F0814_PRICES.s3.perGBMonthUsd, annualUsd: s3(metrics.logGBPerDay * 30 + metrics.traceGBPerDay * 14 + metrics.profileGBPerDay * 7) },
    { item: 'aws-ops', quantity: ops.aws, unit: 'hour', unitPriceUsd: F0814_PRICES.timeRateKrw / input.krwPerUsd, annualUsd: ops.aws * rate },
  ];
  const ddItems = [
    { item: 'datadog-infra', quantity: metrics.nodes, unit: 'server', unitPriceUsd: F0814_PRICES.datadog.infraProPerServerUsd, annualUsd: metrics.nodes * F0814_PRICES.datadog.infraProPerServerUsd * 12 },
    { item: 'datadog-apm', quantity: metrics.nodes, unit: 'server', unitPriceUsd: F0814_PRICES.datadog.apmPerServerUsd, annualUsd: metrics.nodes * F0814_PRICES.datadog.apmPerServerUsd * 12 },
    { item: 'datadog-metrics', quantity: Math.max(0, metrics.activeSeries - metrics.nodes * F0814_PRICES.datadog.metricsIncludedPerServer), unit: 'series', unitPriceUsd: F0814_PRICES.datadog.extraMetricsPer100Usd, annualUsd: Math.max(0, metrics.activeSeries - metrics.nodes * F0814_PRICES.datadog.metricsIncludedPerServer) / 100 * F0814_PRICES.datadog.extraMetricsPer100Usd * 12 },
    { item: 'datadog-logs', quantity: metrics.logGBPerDay * 30, unit: 'GB-month', unitPriceUsd: F0814_PRICES.datadog.logsPerGBUsd, annualUsd: metrics.logGBPerDay * 30 * F0814_PRICES.datadog.logsPerGBUsd * 12 },
    { item: 'datadog-ops', quantity: ops.datadog, unit: 'hour', unitPriceUsd: F0814_PRICES.timeRateKrw / input.krwPerUsd, annualUsd: ops.datadog * rate },
  ];
  const withMeta = (candidate, items) => ({ candidate, items: items.map((it) => ({ ...it, priceDate: input.priceDate, source: 'docs/perf-ledger.md §11.3' })) });
  const base = [];
  base.push({ id: 'self', eligible: true, ...withMeta('self', selfItems) });
  base.push({ id: 'aws', eligible: true, ...withMeta('aws', awsItems), limits: { ampQueryDays: 95, ampQueryRps: 300, longTermConditional: true } });
  if (r3.datadog === true) base.push({ id: 'datadog', eligible: true, ...withMeta('datadog', ddItems) });
  for (const c of base) c.annualUsd = c.items.reduce((acc, it) => acc + it.annualUsd, 0);

  const scaled = (factor) => base.map((c) => {
    const annual = c.items.reduce((acc, it) => acc + (it.item.endsWith('-ops') ? it.annualUsd * factor : it.annualUsd), 0);
    return { id: c.id, annualUsd: annual };
  }).sort((a, b) => a.annualUsd - b.annualUsd);
  const sensitivity = F0814_SENSITIVITY.map((factor) => ({ factor, ranking: scaled(factor).map((x) => x.id) }));
  const one = scaled(1);
  const oneAndHalf = scaled(1.5);
  const selfAnnual = base.find((c) => c.id === 'self').annualUsd;
  const first = one[0];
  let tie = false;
  let opsSensitive = false;
  let chosen;
  if (first.id === 'self') {
    if (oneAndHalf[0].id !== 'self') {
      opsSensitive = true;
      chosen = oneAndHalf[0].id;
    } else chosen = 'self';
  } else {
    const firstAnnual = first.annualUsd;
    tie = Math.abs(selfAnnual - firstAnnual) / firstAnnual <= F0814_DEFAULTS.tieRatio;
    if (tie && oneAndHalf[0].id === 'self') chosen = 'self';
    else chosen = oneAndHalf[0].id;
  }

  const samples = metrics.activeSeries * 86_400 / 15;
  const traceStores = traceStoreCosts({ metrics, traceStore: input.traceStore, krwPerUsd: input.krwPerUsd, fxSource: input.fxSource, fxDate: input.fxDate, priceDate: input.priceDate }).rows;
  return {
    verdict: '통과',
    reasons: [],
    missing: [],
    candidates: base,
    sensitivity,
    chosen,
    tie,
    opsSensitive,
    sampleBudget: { samples, max: F0814_DEFAULTS.sampleBudget, over: samples > F0814_DEFAULTS.sampleBudget, sent: false },
    traceStores,
  };
}

export function sampleBudget(series, intervalSec, days) {
  const samples = series * 86_400 / intervalSec * days;
  return { samples, max: F0814_DEFAULTS.sampleBudget, over: samples > F0814_DEFAULTS.sampleBudget };
}

let piiCache = null;
export function containsPii(value) {
  if (!piiCache) {
    try {
      piiCache = JSON.parse(readFileSync(PII_PATH, 'utf8')).patterns.map((p) => new RegExp(p.pattern));
    } catch {
      piiCache = [];
    }
  }
  return piiCache.some((re) => re.test(String(value ?? '')));
}

// ───────────── 보고서 ─────────────

const fmt = (v) => (v === null || v === undefined ? '—' : typeof v === 'number' ? String(v) : String(v));
const pctFree = (s) => String(s).split('0%').join('0 퍼센트');

function k8Rows(input) {
  const rows = input.k8?.rows;
  if (Array.isArray(rows) && rows.length) return rows;
  return F0814_SCENARIOS.map((s) => ({ id: s.id, name: s.name, source: s.source, t0: null, t1: null, t1p: null, t2: null, t3: null, detectionSec: null, propagationSec: null, verdict: '미측정', evidence: '—' }));
}

function candidateRows(input) {
  const list = input.backends?.candidates;
  return F0814_BACKENDS.map((id) => {
    const c = Array.isArray(list) ? list.find((x) => x.id === id) : null;
    return {
      id,
      annualUsd: c?.annualUsd ?? null,
      ranking: c?.ranking ?? '—',
      r1: c?.limits?.longTermConditional ? '조건부(95일)' : '—',
      r3: c ? (id === 'datadog' ? '제외' : '통과') : id === 'datadog' ? '제외' : '—',
      verdict: c ? '통과' : id === 'datadog' ? 'R3 제외' : '미측정',
    };
  });
}

function componentRows(input) {
  const list = input.components;
  return F0814_COMPONENTS.map((spec) => {
    const r = Array.isArray(list) ? list.find((x) => x.id === spec.id) : null;
    return { ...spec, storageGB: r?.storageGB ?? null, annualUsd: r?.annualUsd ?? null, verdict: r ? '통과' : '미측정' };
  });
}

function traceRows(input) {
  const list = input.traceStores;
  return F0814_TRACE_STORES.map((id) => {
    const r = Array.isArray(list) ? list.find((x) => x.id === id) : null;
    return { id, storage: r?.storage ?? '—', retentionDays: r?.retentionDays ?? null, annualUsd: r?.annualUsd ?? null, durable3: r?.durable3 ?? null, openPeak: r?.openPeak ?? null, verdict: r?.verdict ?? '미측정', missing: r?.missing ?? [] };
  });
}

export function renderF0814Report(input = {}) {
  const k8 = k8Rows(input);
  const runs = Array.isArray(input.k9?.runs) ? input.k9.runs : [];
  const candidates = candidateRows(input);
  const components = componentRows(input);
  const trace = traceRows(input);
  const prior = Array.isArray(input.prior) && input.prior.length ? input.prior : F0814_PRIOR_MEASUREMENTS;
  const lines = [];
  lines.push('# F-08-14 K8/K9·관측 백엔드 비교 보고서');
  lines.push('');
  lines.push(`- **상태**: ${input.status ?? '미실행'}. 창 ${input.window ?? F0814_WINDOW}. 실제 측정·비용 계산은 미실행이다.`);
  lines.push('- **정본**: `docs/observability.md` §12, `docs/verification.md` §3.10, `docs/perf-ledger.md` §8·§11.');
  lines.push('- **한 줄 결론**: 입력이 없어 K8·K9·OPS-510은 미측정 또는 판정 못 함이다. 통과 0.');
  lines.push('');
  lines.push('## 0. 계획과 다르게 간 것');
  lines.push('');
  lines.push('- 새 측정·Docker·kind·k6·브라우저를 쓰지 않았다. 입력 산출물만 읽었다.');
  lines.push('');
  lines.push('## 1. K8 탐지·전파');
  lines.push('');
  lines.push('| 시나리오 | 이름 | 입력 | T0 | T1 | T1p | T2 | T3 | 탐지(초) | 전파(초) | 판정 | 증거 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of k8) lines.push(`| ${r.id} | ${r.name ?? '—'} | ${r.source ?? '—'} | ${fmt(r.t0)} | ${fmt(r.t1)} | ${fmt(r.t1p)} | ${fmt(r.t2)} | ${fmt(r.t3)} | ${fmt(r.detectionSec)} | ${fmt(r.propagationSec)} | ${r.verdict ?? '미측정'} | ${r.evidence ?? '—'} |`);
  lines.push('');
  lines.push('## 2. K9 확장');
  lines.push('');
  lines.push('| 실행 ID | 시작 | 첫 확장 | 파드 준비 | 확장(초) | 준비(초) | 판정 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  if (runs.length) for (const r of runs) lines.push(`| ${r.runId ?? '—'} | ${fmt(r.loadStartMs)} | ${fmt(r.scaledAtMs)} | ${fmt(r.podReadyAtMs)} | ${fmt(r.scaleSec)} | ${fmt(r.readySec)} | ${r.verdict ?? '미측정'} |`);
  else lines.push('| — | — | — | — | — | — | 미측정 |');
  lines.push('');
  lines.push('## 3. OPS-510 후보 비용');
  lines.push('');
  lines.push('| 후보 | 연간 USD | 순위(0.5/1/1.5) | R1 | R3 | 판정 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const c of candidates) lines.push(`| ${c.id} | ${fmt(c.annualUsd)} | ${fmt(c.ranking)} | ${c.r1} | ${c.r3} | ${c.verdict} |`);
  lines.push('');
  lines.push('## 4. 구성 요소');
  lines.push('');
  lines.push('| 구성 요소 | 보존 | 저장량(GB) | 연간 USD | 쿼리 | 운영 부담 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const c of components) lines.push(`| ${c.id} | ${fmt(c.retentionDays)} | ${fmt(c.storageGB)} | ${fmt(c.annualUsd)} | ${c.query} | ${c.ops} |`);
  lines.push('');
  lines.push('## 5. 요청 기록');
  lines.push('');
  lines.push('| 안 | 저장 | 보존 | 연간 USD | 3등급 | 오픈 피크 | 판정 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const t of trace) lines.push(`| ${t.id} | ${t.storage} | ${fmt(t.retentionDays)} | ${fmt(t.annualUsd)} | ${t.durable3 === true ? '통과' : '—'} | ${t.openPeak === true ? '통과' : '—'} | ${t.verdict} |`);
  lines.push('');
  lines.push('## 6. 선행 측정 인용');
  lines.push('');
  lines.push('| 기능 | 판정 | 증거 |');
  lines.push('| --- | --- | --- |');
  for (const p of prior) lines.push(`| ${p.id} | ${p.status ?? '미측정'} | ${p.evidence ?? '—'} |`);
  lines.push('');
  lines.push('## 7. 한계');
  lines.push('');
  lines.push('- 입력 산출물이 없거나 일부만 있어 실제 탐지·확장·비용을 계산하지 못했다.');
  lines.push('- 이 기능은 새 `실측(PC)` 줄을 만들지 않는다.');
  lines.push('');
  lines.push('## 8. 장부·게이트');
  lines.push('');
  lines.push('- ledger `--batch F-08-14 --require`: 항목 0.');
  lines.push('- K8·K9·OPS-510의 통과는 이 보고서가 뜻하지 않는다.');
  lines.push('');
  lines.push('## 9. 주장하지 않는 것');
  lines.push('');
  lines.push('- K8 탐지율 1.0·60초, K9 60초, 백엔드 1위를 주장하지 않는다.');
  lines.push('- `30k/s`·`30,000건/초`·`100만`·K1/K2/K7 0을 주장하지 않는다.');
  lines.push('- F-08-5 `무효·미측정`, F-08-9 `판정 못 함(무효·부분)`, F-08-10 `미측정`, F-08-12 `미측정`, F-08-13 `미측정`(증거 `설계만`)을 통과로 바꾸지 않는다.');
  lines.push('');
  lines.push('## 10. 인시던트와 포스트모템');
  lines.push('');
  lines.push('| 인시던트 | 시나리오 | 선언 시각 | 끝 시각 | 완료 시각 | 예산 비율 | P0 | 포스트모템 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  lines.push('포스트모템 기한은 48시간이다. 이 기능은 새 인시던트를 선언하지 않는다.');
  lines.push('');
  return pctFree(lines.join('\n'));
}

const FORBIDDEN = [
  { token: '30k/s', claim: () => true },
  { token: '30,000건/초', claim: () => true },
  { token: '100만', claim: (line) => /100만[^\n]*(달성|처리|건\/초|통과)/.test(line) },
  { token: 'K1', claim: (line) => /\bK[127]\b(?:\s*[/·,]\s*K[127]\b)*\s*0/.test(line) },
  { token: 'K2', claim: (line) => /\bK[127]\b(?:\s*[/·,]\s*K[127]\b)*\s*0/.test(line) },
  { token: 'K7', claim: (line) => /\bK[127]\b(?:\s*[/·,]\s*K[127]\b)*\s*0/.test(line) },
];
const NEGATIONS = ['주장하지 않', '금지', '범위 밖', '위반', '쓰지 않', '하지 않는다', '바꾸지 않', '닫지 않', '미실행', '미측정', '인용만', 'STOP-'];

function forbiddenClaim(md) {
  for (const line of md.split(/\r?\n/)) {
    for (const f of FORBIDDEN) {
      if (!line.includes(f.token) || !f.claim(line)) continue;
      if (!NEGATIONS.some((n) => line.includes(n))) return `${f.token} 주장이 부정문 밖에 있다`;
    }
  }
  return null;
}

export function validateF0814Report(markdown, options = {}) {
  const reasons = [];
  const md = String(markdown ?? '');
  for (const heading of ['## 1. K8', '## 2. K9', '## 3. OPS-510', '## 4. 구성 요소', '## 5. 요청 기록', '## 6. 선행 측정 인용', '## 7. 한계', '## 8. 장부·게이트', '## 9. 주장하지 않는 것']) {
    if (!md.includes(heading)) reasons.push(`${heading}이 없다`);
  }
  const k8 = md.split(/\r?\n/).filter((line) => /^\| G-\d\d \|/.test(line));
  if (k8.length !== 10) reasons.push(`K8 행이 10개가 아니다: ${k8.length}`);
  for (const id of F0814_K8_IDS) if (!k8.some((line) => line.startsWith(`| ${id} |`))) reasons.push(`${id} K8 행이 없다`);
  for (const line of k8) {
    const cells = line.split('|').slice(1, -1).map((x) => x.trim());
    const verdict = cells[10];
    if (verdict === '통과') {
      const detection = Number(cells[8]);
      const propagation = Number(cells[9]);
      if (!Number.isFinite(detection) || detection > 60 || !Number.isFinite(propagation) || propagation > 3) reasons.push(`K8 통과 행에 시각 증거가 없다: ${cells[0]}`);
    }
  }
  const k9Header = '| 실행 ID | 시작 | 첫 확장 | 파드 준비 | 확장(초) | 준비(초) | 판정 |';
  if (!md.includes(k9Header)) reasons.push('K9 표 머리글이 없다');
  for (const id of ['self', 'aws', 'datadog']) if (!md.includes(`| ${id} |`)) reasons.push(`${id} 후보 행이 없다`);
  for (const c of F0814_COMPONENTS) if (!md.includes(`| ${c.id} |`)) reasons.push(`${c.id} 구성 요소 행이 없다`);
  for (const id of F0814_TRACE_STORES) if (!md.includes(`| ${id} |`)) reasons.push(`${id} 요청 기록 행이 없다`);
  for (const p of F0814_PRIOR_MEASUREMENTS) {
    if (!md.includes(p.id)) reasons.push(`${p.id} 선행 인용이 없다`);
    if (!md.includes(p.status)) reasons.push(`${p.id} 상태 ${p.status}가 없다`);
  }
  if (!md.includes('48시간')) reasons.push('48시간이 없다');
  if (!md.includes('P0')) reasons.push('P0가 없다');
  if (md.includes('0%')) reasons.push('0% 표기가 있다');
  if (!/새 `?실측\(PC\)`? 줄을 만들지 않는다/.test(md)) reasons.push('실측(PC) 새 줄 없음 문장이 없다');
  for (const line of md.split(/\r?\n/)) {
    if (!/^\|.*실측\(PC\).*\|/.test(line)) continue;
    const runId = line.split('|').slice(1, -1).map((x) => x.trim())[0];
    if (!runId || runId === '—' || !options.runExists?.(runId)) reasons.push('실측(PC) 행에 실행 증거가 없다');
  }
  if (containsPii(md)) reasons.push('개인정보 꼴이 있다');
  const forbidden = forbiddenClaim(md);
  if (forbidden) reasons.push(forbidden);
  return { ok: reasons.length === 0, reasons, passed: k8.filter((line) => line.split('|').slice(1, -1).map((x) => x.trim())[10] === '통과').length };
}

export function validateF0814Plan(plan) {
  const reasons = [];
  if (plan?.batch !== 'F-08-14') reasons.push('batch가 F-08-14가 아니다');
  if (plan?.feature !== 'F-08-14') reasons.push('feature가 F-08-14가 아니다');
  if (plan?.window?.id !== '3g') reasons.push('창이 3g가 아니다');
  if (JSON.stringify(plan?.k8?.ids) !== JSON.stringify(F0814_K8_IDS)) reasons.push('K8 10종이 아니다');
  if (plan?.k9?.metric !== 'hpa-pod-ready' || plan?.k9?.limitSec !== 60) reasons.push('K9 계약이 다르다');
  if (JSON.stringify(plan?.backends?.map((x) => x.id)) !== JSON.stringify(F0814_BACKENDS)) reasons.push('후보 3이 아니다');
  if (JSON.stringify(plan?.traceStores?.map((x) => x.id)) !== JSON.stringify(F0814_TRACE_STORES)) reasons.push('요청 기록 3안이 아니다');
  if (JSON.stringify(plan?.components?.map((x) => x.id)) !== JSON.stringify(F0814_COMPONENTS.map((x) => x.id))) reasons.push('구성 요소 5가 아니다');
  if (plan?.prices?.amp?.priceDate !== '2026-10-14' || plan?.prices?.amp?.ingestTiers?.[1]?.upToSamples !== 250_000_000_000 || plan?.prices?.xray?.freeTracesPerMonth !== 100_000 || plan?.prices?.timeRateKrw !== 49_538) reasons.push('가격표가 다르다');
  if (!Array.isArray(plan?.boundaries) || plan.boundaries.length < 4 || !plan.boundaries.some((b) => b.feature === 'F-08-13')) reasons.push('경계가 모자라다');
  if (!Array.isArray(plan?.commands) || plan.commands.length < 1 || JSON.stringify(plan.commands).match(/--inject|--docker|--kind|--k6|--browser/)) reasons.push('명령이 잘못됐다');
  if (!Array.isArray(plan?.stopRules) || plan.stopRules.length !== 10) reasons.push('STOP 10개가 아니다');
  for (const id of F0814_OUTSIDE) if (!plan?.notIncluded?.includes(id)) reasons.push(`${id}가 notIncluded에 없다`);
  return { ok: reasons.length === 0, reasons };
}

export function parseF0814Args(argv = []) {
  const out = { window: null, k8: null, k9: null, metrics: null, opsHours: null, fx: null, out: null, judge: null };
  const value = (i, flag) => {
    const v = argv[i];
    if (v === undefined || String(v).startsWith('--')) throw new UsageError(`${flag} 값이 필요하다`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--window') out.window = value(++i, a);
    else if (a === '--k8') out.k8 = value(++i, a);
    else if (a === '--k9') out.k9 = value(++i, a);
    else if (a === '--metrics') out.metrics = value(++i, a);
    else if (a === '--ops-hours') out.opsHours = value(++i, a);
    else if (a === '--fx') {
      const v = value(++i, a);
      if (!Number.isFinite(Number(v))) throw new UsageError('--fx는 숫자여야 한다');
      out.fx = Number(v);
    } else if (a === '--out') out.out = value(++i, a);
    else if (a === '--judge') out.judge = value(++i, a);
    else throw new UsageError(`모르는 인자다: ${a}`);
  }
  if (!out.window) throw new UsageError('--window가 필요하다(3g)');
  if (out.window !== F0814_WINDOW) throw new UsageError('창은 3g만 된다');
  return out;
}
