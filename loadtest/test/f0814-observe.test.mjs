// F-08-14 K8/K9·관측 백엔드 비교 시험(F0814-1~6): 카탈로그·판정 계약·비용 계산·계획/보고서.
// 정본: docs/observability.md §4·§5·§9·§12, docs/verification.md §3.10·§5.2,
//       docs/perf-ledger.md §7·§8·§11, ADR-0067·0068·0073·0077.
// 단언 값은 정본에서 가져와 이 파일에 적는다(구현 상수를 가져오지 않는다).
// Docker·kind·k6·브라우저를 쓰지 않는다. 실행: node --test loadtest/test/f0814-observe.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNNER = path.join(ROOT, 'loadtest', 'runner', 'observability-compare.mjs');
const PLAN_JSON = path.join(ROOT, 'loadtest', 'plan', 'f0814-plan.json');
const REPORT = path.join(ROOT, 'docs', 'review', 'measurements', 'F-08-14.md');
const PLAN_DOC = path.join(ROOT, 'docs', 'review', 'plans', 'F-08-14.md');

const K8_IDS = Array.from({ length: 10 }, (_, i) => `G-${String(i + 1).padStart(2, '0')}`);
/** docs/observability.md §12:736~747의 이름과 기대 경보. 느슨한 조각이 아니라 전체 문자열이다. */
const K8_EXPECTED = [
  {
    id: 'G-01',
    name: '대기열 Redis 클러스터 CPU 사용률 > 75% 강제 주입',
    alert: '대기열 진입 번 레이트 가속 경보 발령',
  },
  {
    id: 'G-02',
    name: '좌석 Redis 클러스터 프라이머리 마스터 노드 강제 페일오버(고장 난 쪽 대신 예비 쪽으로 넘기는 것)',
    alert: '좌석 홀드 503(`seat-store-unavailable`) 급증, `seat_store_unavailable{event_id}` = 1, 페일오버 감지 이벤트 수신',
  },
  {
    id: 'G-03',
    name: 'CDN 엣지의 대기열 상태 조회 파일 응답 오류율 > 1% 주입',
    alert: '대기 순번 조회 가용성 저하 경보',
  },
  {
    id: 'G-04',
    name: '공연 상세 페이지 오리진 서버 에러율 > 1% 주입',
    alert: '공연 정보 페이지 에러 버짓 소진 경보',
  },
  {
    id: 'G-05',
    name: 'PG사(토스형 시뮬레이터) 결제 승인 API에 지연시간 p99 > 5초인 지연을 일부러 주입',
    alert: 'SEV2 결제 확정 임박(승인 호출 p99 2초 초과, 호출은 끊지 않는다), 결제 확정 소요 p99 5초 초과로 RB-07 전환 검토, 결제 확정 SLO 소진이 10배에 닿으면 SEV1(ADR-0069)',
  },
  {
    id: 'G-06',
    name: 'realtime-gw 파드의 소켓 송신 버퍼 큐 포화 상태 유발',
    alert: '버퍼로 1초 간격이 된 연결 비율 경보(`realtime_gw_buffer_slow_connections` ÷ `realtime_gw_connections` 5% [가정] 30초, SEV2)와 `realtime_gw_degraded` 경보(ADR-0298)',
  },
  {
    id: 'G-07',
    name: '스트림 작업자 `ops-rt` 밀림 주입(ClickHouse 삽입 지연, ADR-0099)',
    alert: '판매 중 탭 머리의 신선도가 경고 색(1분 p95 5초 넘음)으로 바뀌는 것이 K8의 탐지다. 3분 넘게 이어지면 SEV3(hygiene, ADR-0071)(추천 적용 2026-10-20, ADR-0073)',
  },
  {
    id: 'G-08',
    name: 'ops-svc 관제 백엔드 파드 모두 강제 종료 (CrashLoopBackOff)',
    alert: 'ops-svc 가용성 상실 SEV1(§5 관제 자체·기반 신호, 30초 [가정])',
  },
  {
    id: 'G-09',
    name: 'admission-ctrl 리더 파드의 프로세스 강제 종료 (SIGKILL)',
    alert: 'admission-ctrl 리더 부재 30초 [가정] 초과 SEV2(§5)',
  },
  {
    id: 'G-10',
    name: 'MSK Kafka 브로커 노드 1대 강제 오프라인 격리',
    alert: '브로커 오프라인 SEV2, 거래 토픽 소비 지연 30초 [가정]·1분이면 같은 SEV2(§5)',
  },
];
const K8_INTERVALS = Object.fromEntries([
  ...['G-01', 'G-02', 'G-03', 'G-04', 'G-05', 'G-06'].map((id) => [id, { scrapeSec: 5, evalSec: 5, groupWaitSec: 5, forSec: 0 }]),
  ['G-07', { scrapeSec: 15, evalSec: 5, groupWaitSec: 5, forSec: 0 }],
  ...['G-08', 'G-09', 'G-10'].map((id) => [id, { scrapeSec: 15, evalSec: 5, groupWaitSec: 5, forSec: 30 }]),
]);
const PRIOR = [
  { id: 'F-08-5', status: '무효·미측정', evidence: '측정' },
  { id: 'F-08-9', status: '판정 못 함(무효·부분)', evidence: '측정' },
  { id: 'F-08-10', status: '미측정', evidence: '뼈대' },
  { id: 'F-08-12', status: '미측정', evidence: '뼈대' },
  { id: 'F-08-13', status: '미측정', evidence: '설계만' },
  { id: 'F-08-6', status: '미측정', evidence: '뼈대' },
];
const FORBIDDEN = [
  { token: '30k/s', claim: () => true },
  { token: '30,000건/초', claim: () => true },
  { token: '100만', claim: (line) => /100만[^\n]*(달성|처리|건\/초|통과)/.test(line) },
  { token: 'K1', claim: (line) => /\bK[127]\b(?:\s*[/·,]\s*K[127]\b)*\s*0/.test(line) },
  { token: 'K2', claim: (line) => /\bK[127]\b(?:\s*[/·,]\s*K[127]\b)*\s*0/.test(line) },
  { token: 'K7', claim: (line) => /\bK[127]\b(?:\s*[/·,]\s*K[127]\b)*\s*0/.test(line) },
];
const NEGATIONS = ['주장하지 않', '금지', '범위 밖', '위반', '쓰지 않', '하지 않는다', '바꾸지 않', '닫지 않', '미실행', '미측정', '인용만', 'STOP-'];
const PLAN_SECTIONS = ['## 1. 정본 자리', '## 2. 감독에게', '## 3. 범위', '## 4. 현재 상태', '## 5. 장부 범위', '## 6. 측정 설계', '## 7. 경계 표', '## 8. 시험', '## 9. 실패 확인', '## 10. 리뷰', '## 검증'];

async function load() {
  if (!fs.existsSync(RUNNER)) return { missing: 'loadtest/runner/observability-compare.mjs' };
  try {
    return await import(pathToFileURL(RUNNER).href);
  } catch (error) {
    return { error };
  }
}

function need(mod) {
  if (mod.missing) assert.fail(`${mod.missing}가 없다`);
  if (mod.error) assert.fail(`loadtest/runner/observability-compare.mjs를 읽지 못했다: ${mod.error.message}`);
  return mod;
}

function read(rel) {
  const file = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  if (!fs.existsSync(file)) assert.fail(`${path.relative(ROOT, file)}가 없다`);
  return fs.readFileSync(file, 'utf8');
}

function readJson(file) {
  if (!fs.existsSync(file)) assert.fail(`${path.relative(ROOT, file)}가 없다`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    assert.fail(`${path.relative(ROOT, file)} JSON을 읽지 못했다: ${error.message}`);
  }
}

function withTemp(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f0814-'));
  try {
    const paths = {};
    for (const [name, text] of Object.entries(files)) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, text, 'utf8');
      paths[name] = file;
    }
    return fn(paths, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** K8 입력 한 행. 값은 시험이 손으로 정한 합성값이고 측정값이 아니다. */
function k8Row(id, overrides = {}) {
  return {
    id,
    t0: 0,
    t1: 10_000,
    t1p: 9_000,
    t2: 20_000,
    t3: 21_000,
    runId: `run-${id}`,
    runExists: true,
    manifest: true,
    timeline: true,
    intervals: { ...K8_INTERVALS[id] },
    evidence: 'Alertmanager 웹훅 수신 로그',
    valid: true,
    stageReady: true,
    source: id === 'G-02' || id === 'G-10' ? 'F-08-6·F-08-12' : 'F-08-6',
    ...overrides,
  };
}
const k8Rows = (overrides = {}) => K8_IDS.map((id) => k8Row(id, overrides));

/** K9 입력 한 실행. 값은 시험이 손으로 정한 합성값이고 측정값이 아니다. */
function k9Run(readyMs, overrides = {}) {
  return {
    runId: '2026-11-24-k1-1k-r1-f0814',
    runExists: true,
    manifest: true,
    timeline: true,
    settle: true,
    valid: true,
    loadStartMs: 0,
    scaledAtMs: 10_000,
    podReadyAtMs: readyMs,
    replicasBefore: 1,
    replicasAfter: 3,
    ...overrides,
  };
}

/** OPS-510 계산 입력. 값은 시험이 손으로 정한 합성값이고 측정값이 아니다. */
const METRICS = {
  activeSeries: 100_000,
  samplesPerSecond: 1_000,
  metricStorageGB: 110,
  aggStorageGB: 50,
  logGBPerDay: 10,
  traceGBPerDay: 5,
  profileGBPerDay: 1,
  spansPerSecond: 100,
  querySamplesPerYear: 1_000_000_000,
  nodes: 10,
  editors: 2,
  viewers: 5,
};
const TRACE_STORE = {
  obsKafkaMonthlyUsd: 100,
  xrayTracesPerMonth: 2_000_000,
  xrayQueriesPerMonth: 5_000_000,
  openPeakOk: { tempoMsk: true, tempoMonolith: true, xray: true },
  opsHoursPerYear: { tempoMsk: 100, tempoMonolith: 100, xray: 50 },
};
const backendInput = (overrides = {}) => ({
  metrics: { ...METRICS, ...(overrides.metrics ?? {}) },
  opsHoursPerYear: { self: 100, aws: 100, datadog: 50, ...(overrides.opsHoursPerYear ?? {}) },
  krwPerUsd: 1_400,
  fxSource: '한국은행 기준환율',
  fxDate: '2026-11-28',
  priceDate: '2026-11-28',
  r3: { datadog: false, ...(overrides.r3 ?? {}) },
  traceStore: { ...TRACE_STORE, ...(overrides.traceStore ?? {}) },
  ...overrides,
});

/** 보고서 렌더 입력. 모든 값은 미측정 뼈대다. */
function reportInput(overrides = {}) {
  return {
    window: '3g',
    status: '미실행',
    k8: {
      rows: K8_IDS.map((id) => ({
        id,
        name: K8_EXPECTED.find((s) => s.id === id).name,
        source: 'F-08-6',
        t0: null,
        t1: null,
        t1p: null,
        t2: null,
        t3: null,
        detectionSec: null,
        propagationSec: null,
        verdict: '미측정',
        evidence: '—',
      })),
    },
    k9: { runs: [] },
    backends: { candidates: [], sensitivity: null, chosen: null },
    components: [],
    traceStores: [],
    prior: PRIOR.map((p) => ({ ...p })),
    ...overrides,
  };
}

test('F0814-1 ① K8 10종 ID·차례·이름·기대 경보가 docs/observability.md §12와 같고 G-11~G-33이 없다', async () => {
  const m = need(await load());
  assert.equal(m.F0814_WINDOW, '3g');
  assert.deepEqual(m.F0814_K8_IDS, K8_IDS);
  assert.equal(m.F0814_SCENARIOS.length, 10);
  for (const [i, expected] of K8_EXPECTED.entries()) {
    const s = m.F0814_SCENARIOS.find((x) => x.id === expected.id);
    assert.ok(s, `${expected.id}가 카탈로그에 없다`);
    assert.equal(s.order, i + 1);
    assert.equal(s.id, expected.id);
    assert.equal(s.name, expected.name);
    assert.equal(s.expectedAlert, expected.alert);
    assert.equal(s.canonical, 'docs/observability.md §12');
    assert.ok(String(s.source).includes('F-08-6'), `${expected.id}의 입력에 F-08-6이 없다`);
  }
  for (const s of m.F0814_SCENARIOS) assert.ok(K8_IDS.includes(s.id), `${s.id}는 K8 10종이 아니다`);
  assert.equal(m.F0814_SCENARIOS.some((s) => /^G-(1[1-9]|2[0-9]|3[0-3])$/.test(s.id)), false);
});

test('F0814-1 ② 입력 표·선행 인용·입력 읽기: F-08-13은 미측정(설계만), 파일 없음/0행은 미측정', async () => {
  const m = need(await load());
  const f6 = m.F0814_INPUTS.find((x) => x.id === 'F-08-6');
  const f12 = m.F0814_INPUTS.find((x) => x.id === 'F-08-12');
  const f13 = m.F0814_INPUTS.find((x) => x.id === 'F-08-13');
  const f8 = m.F0814_INPUTS.find((x) => x.id === 'F-08-8');
  const ops = m.F0814_INPUTS.find((x) => x.id === 'ops-hours');
  assert.ok(f6 && f12 && f13 && f8 && ops, 'F-08-6·F-08-12·F-08-13·F-08-8·ops-hours 입력이 모두 있어야 한다');
  assert.deepEqual(f6.k8Ids, K8_IDS);
  assert.deepEqual(f12.k8Ids, ['G-02', 'G-10']);
  assert.deepEqual(f13.k8Ids, []);
  assert.equal(f6.status, '미측정');
  assert.equal(f12.status, '미측정');
  assert.equal(f13.status, '미측정');
  assert.equal(f13.evidence, '설계만');
  assert.equal(f8.status, '미측정');
  assert.equal(f8.k9, true);
  assert.equal(ops.status, '미측정');
  assert.deepEqual(m.F0814_PRIOR_MEASUREMENTS.map((x) => x.id), PRIOR.map((x) => x.id));
  for (const p of PRIOR) {
    const got = m.F0814_PRIOR_MEASUREMENTS.find((x) => x.id === p.id);
    assert.ok(got, `${p.id} 선행 인용이 없다`);
    assert.equal(got.status, p.status);
    assert.equal(got.evidence, p.evidence);
  }

  const missing = m.readK8Report(path.join(os.tmpdir(), 'f0814-no-such-report.md'));
  assert.equal(missing.ok, false);
  assert.equal(missing.missing, true);
  withTemp({ 'k8.json': JSON.stringify({ rows: [k8Row('G-01')] }) }, (p) => {
    const got = m.readK8Report(p['k8.json']);
    assert.equal(got.ok, true);
    assert.equal(got.rows.length, 1);
    assert.equal(got.rows[0].id, 'G-01');
  });

  const md = [
    '## 2. K8 탐지·전파',
    '',
    '| 시나리오 | 탐지(초) | 전파(초) | 판정 | 증거 |',
    '| --- | --- | --- | --- | --- |',
    ...K8_IDS.map((id) => `| ${id} | 미측정 | 미측정 | 미측정 | 미측정 |`),
    '',
  ].join('\n');
  withTemp({ 'F-08-6-gameday.md': md, 'empty.md': '| 시나리오 | 탐지(초) | 전파(초) | 판정 | 증거 |\n| --- | --- | --- | --- | --- |\n' }, (p) => {
    const got = m.readK8Report(p['F-08-6-gameday.md']);
    assert.equal(got.ok, true);
    assert.equal(got.rows.length, 10);
    assert.deepEqual(got.rows.map((r) => r.id), K8_IDS);
    assert.equal(m.readK8Report(p['empty.md']).ok, false);
  });
});

test('F0814-1 ③ K8 경계·간격·k8.csv 시각 칸: 60.000/60.001초, 3.000/3.001초, 분모 10', async () => {
  const m = need(await load());
  assert.deepEqual(m.F0814_K8_LIMITS, { detectionSec: 60, propagationSec: 3, detectionRate: 1 });
  assert.deepEqual(m.F0814_K9_LIMITS, { readySec: 60 });
  assert.deepEqual(m.F0814_VERDICTS, ['통과', '미달', '판정 못 함', '무효', '미측정']);
  assert.equal(m.F0814_K8_LIMITS.detectionSec * 1000, 60_000);
  assert.equal(m.F0814_K8_LIMITS.propagationSec * 1000, 3_000);
  assert.equal(m.F0814_K9_LIMITS.readySec * 1000, 60_000);
  assert.deepEqual(Object.keys(m.F0814_K8_INTERVALS), K8_IDS);
  assert.deepEqual(m.F0814_K8_INTERVALS['G-01'], { scrapeSec: 5, evalSec: 5, groupWaitSec: 5, forSec: 0 });
  assert.deepEqual(m.F0814_K8_INTERVALS['G-07'], { scrapeSec: 15, evalSec: 5, groupWaitSec: 5, forSec: 0 });
  assert.deepEqual(m.F0814_K8_INTERVALS['G-08'], { scrapeSec: 15, evalSec: 5, groupWaitSec: 5, forSec: 30 });
  assert.deepEqual(m.F0814_ARTIFACTS.k8Csv.columns, ['scenario', 'source', 'run_id', 't0', 't1', 't1p', 't2', 't3', 'detection_sec', 'propagation_sec', 'verdict', 'evidence']);
});

test('F0814-2 ① judgeK8 기록 없음 → 미측정, detectionRate null, measuredRate 0', async () => {
  const m = need(await load());
  const r = m.judgeK8({ rows: [] });
  assert.equal(r.verdict, '미측정');
  assert.equal(r.detectionRate, null);
  assert.equal(r.measuredRate, 0);
  assert.equal(r.measured, 0);
  assert.equal(r.detected, 0);
  assert.equal(r.missing.length, 10);
  assert.ok(r.reasons.length > 0);
});

test('F0814-2 ② judgeK8 10행 모두 60.000초·3.000초와 실행 증거·운영 간격 → 통과, 탐지율 1', async () => {
  const m = need(await load());
  const rows = K8_IDS.map((id) => k8Row(id, { t1: 60_000, t1p: 59_000, t2: 70_000, t3: 73_000 }));
  const r = m.judgeK8({ rows });
  assert.equal(r.verdict, '통과');
  assert.equal(r.detectionRate, 1);
  assert.equal(r.measuredRate, 1);
  assert.equal(r.measured, 10);
  assert.equal(r.detected, 10);
  assert.equal(r.within60, 10);
  assert.equal(r.maxDetectionSec, 60);
  assert.equal(r.propagationMaxSec, 3);
  assert.equal(r.propagationVerdict, '통과');
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.invalid, []);
  assert.equal(r.perScenario[0].runId, 'run-G-01');
  assert.equal(r.perScenario[0].detectionSec, 60);
  assert.equal(r.perScenario[0].propagationSec, 3);
});

test('F0814-2 ③ judgeK8 60.0005·3.0005·59.9999·2.9999 경계와 미탐지 → 미달, 탐지율 0.9', async () => {
  const m = need(await load());
  const over = k8Rows();
  over[0] = { ...over[0], t1: 60_000.5, t1p: 59_000 };
  const r1 = m.judgeK8({ rows: over });
  assert.equal(r1.verdict, '미달');
  assert.equal(r1.detectionRate, 0.9);
  assert.equal(r1.maxDetectionSec, 60.0005);

  const under = K8_IDS.map((id) => k8Row(id, { t1: 59_999.9, t1p: 59_000, t2: 70_000, t3: 72_999.9 }));
  const r2 = m.judgeK8({ rows: under });
  assert.equal(r2.verdict, '통과');
  assert.equal(r2.maxDetectionSec, 59.9999);
  assert.equal(r2.propagationMaxSec, 2.9999);

  const overCmd = K8_IDS.map((id) => k8Row(id, { t1: 10_000, t2: 70_000, t3: 73_000.5 }));
  const r3 = m.judgeK8({ rows: overCmd });
  assert.equal(r3.verdict, '미달');
  assert.equal(r3.propagationVerdict, '미달');

  const missed = k8Rows();
  missed[2] = { ...missed[2], t1: 120_000, t1p: 119_000 };
  const r4 = m.judgeK8({ rows: missed });
  assert.equal(r4.verdict, '미달');
  assert.equal(r4.detectionRate, 0.9);
  assert.equal(r4.maxDetectionSec, 120);
});

test('F0814-2 ④ judgeK8 일부 행 → 판정 못 함, 무효·증거 없음·간격 축소·G-07 T1 대체 규칙', async () => {
  const m = need(await load());
  assert.equal(m.judgeK8({ rows: k8Rows().slice(0, 5) }).verdict, '판정 못 함');

  const invalid = k8Rows();
  invalid[0] = { ...invalid[0], valid: false };
  assert.equal(m.judgeK8({ rows: invalid }).verdict, '무효');

  const duplicate = [...k8Rows(), k8Row('G-01')];
  assert.equal(m.judgeK8({ rows: duplicate }).verdict, '무효');

  const unknown = [...k8Rows().slice(0, 9), k8Row('G-99')];
  assert.equal(m.judgeK8({ rows: unknown }).verdict, '무효');

  const noEvidence = k8Rows();
  noEvidence[0] = { ...noEvidence[0], manifest: false };
  assert.equal(m.judgeK8({ rows: noEvidence }).verdict, '판정 못 함');

  const noRun = k8Rows();
  noRun[0] = { ...noRun[0], runId: '' };
  assert.equal(m.judgeK8({ rows: noRun }).verdict, '판정 못 함');

  const noRunExists = k8Rows();
  noRunExists[0] = { ...noRunExists[0], runExists: false };
  assert.equal(m.judgeK8({ rows: noRunExists }).verdict, '판정 못 함');

  const noTimeline = k8Rows();
  noTimeline[0] = { ...noTimeline[0], timeline: false };
  assert.equal(m.judgeK8({ rows: noTimeline }).verdict, '판정 못 함');

  const narrow = k8Rows();
  narrow[0] = { ...narrow[0], intervals: { ...narrow[0].intervals, scrapeSec: 1 } };
  assert.equal(m.judgeK8({ rows: narrow }).verdict, '무효');

  const g7 = k8Rows();
  g7[6] = { ...g7[6], t1: null, t1p: 12_000 };
  const r = m.judgeK8({ rows: g7 });
  assert.equal(r.verdict, '통과');
  assert.equal(r.perScenario[6].usedT1p, true);
  assert.equal(r.perScenario[6].detectionSec, 12);

  const g1 = k8Rows();
  g1[0] = { ...g1[0], t1: null, t1p: 12_000 };
  assert.equal(m.judgeK8({ rows: g1 }).verdict, '판정 못 함');
});

test('F0814-2 ⑤ judgeK8 미측정·null 입력을 0으로 바꾸지 않고 0%를 만들지 않는다', async () => {
  const m = need(await load());
  const rows = K8_IDS.map((id) => k8Row(id, { t0: null, t1: null, t1p: null, t2: null, t3: null, verdict: '미측정', evidence: '' }));
  const r = m.judgeK8({ rows });
  assert.equal(r.verdict, '미측정');
  assert.equal(r.detectionRate, null);
  assert.equal(r.measuredRate, 0);
  assert.equal(r.measured, 0);
  assert.notEqual(r.detectionRate, 0);

  const fakePass = k8Rows();
  fakePass[0] = { ...fakePass[0], manifest: false };
  assert.notEqual(m.judgeK8({ rows: fakePass }).verdict, '통과');
});

test('F0814-3 ① K9 정의: HPA, 복제 1→N, --hpa-timeline, 준비 60초, 입력 없음 이유', async () => {
  const m = need(await load());
  assert.equal(m.F0814_K9_LIMITS.readySec, 60);
  assert.equal(m.F0814_K9.name, 'hpa-pod-ready');
  assert.equal(m.F0814_K9.replicasBefore, 1);
  assert.match(m.F0814_K9.flag, /--hpa-timeline/);
  assert.match(m.F0814_K9.source, /docs\/verification\.md/);
  assert.match(m.F0814_K9.v0Note, /v0|baseline/);
  assert.equal(m.F0814_K9.v0IsV1Pass, false);
  assert.equal(m.F0814_K9.inputStatus, '미측정');
  assert.match(m.F0814_K9.reason, /HPA|범위 밖|끔/);
});

test('F0814-3 ② judgeK9 실행 없음·K9 요약 없음/빈 목록 → 미측정, maxReadySec null', async () => {
  const m = need(await load());
  const r = m.judgeK9({ runs: [] });
  assert.equal(r.verdict, '미측정');
  assert.equal(r.maxReadySec, null);
  assert.equal(r.medianReadySec, null);
  assert.equal(r.count, 0);
  assert.ok(r.reasons.length > 0);

  const missing = m.readK9Summary(path.join(os.tmpdir(), 'f0814-no-such-k9.json'));
  assert.equal(missing.ok, false);
  assert.equal(missing.missing, true);
  withTemp({ 'k9.json': JSON.stringify({ runs: [] }) }, (p) => {
    const empty = m.readK9Summary(p['k9.json']);
    assert.equal(empty.ok, false);
    assert.equal(empty.runs.length, 0);
  });
});

test('F0814-3 ③ judgeK9 60.000/60.001·등호 경계·replicasBefore≠1·runId/증거/--settle 없음', async () => {
  const m = need(await load());
  assert.equal(m.judgeK9({ runs: [k9Run(60_000)] }).verdict, '통과');
  assert.equal(m.judgeK9({ runs: [k9Run(60_001)] }).verdict, '미달');
  assert.equal(m.judgeK9({ runs: [k9Run(60_000.5)] }).verdict, '미달');
  assert.equal(m.judgeK9({ runs: [k9Run(59_999.9)] }).verdict, '통과');
  assert.equal(m.judgeK9({ runs: [k9Run(0, { scaledAtMs: 0, podReadyAtMs: 0 })] }).verdict, '통과');
  assert.equal(m.judgeK9({ runs: [k9Run(5_000)] }).verdict, '무효');
  assert.equal(m.judgeK9({ runs: [k9Run(60_000, { replicasBefore: 2 })] }).verdict, '무효');
  assert.equal(m.judgeK9({ runs: [k9Run(60_000, { replicasAfter: 1 })] }).verdict, '무효');
  assert.equal(m.judgeK9({ runs: [k9Run(60_000, { runId: '' })] }).verdict, '판정 못 함');
  assert.equal(m.judgeK9({ runs: [k9Run(60_000, { manifest: false })] }).verdict, '판정 못 함');
  assert.equal(m.judgeK9({ runs: [k9Run(60_000, { runExists: false })] }).verdict, '판정 못 함');
  assert.equal(m.judgeK9({ runs: [k9Run(60_000, { timeline: false })] }).verdict, '판정 못 함');
  assert.equal(m.judgeK9({ runs: [k9Run(60_000, { scaledAtMs: null })] }).verdict, '무효');
  assert.equal(m.judgeK9({ runs: [k9Run(60_000, { podReadyAtMs: null })] }).verdict, '무효');
  assert.equal(m.judgeK9({ runs: [k9Run(60_000, { settle: false })] }).verdict, '무효');
  assert.equal(m.judgeK9({ runs: [k9Run(60_000, { valid: false })] }).verdict, '무효');
});

test('F0814-3 ④ judgeK9 여러 실행의 최댓값·중앙값, 유효/무효 혼합은 무효', async () => {
  const m = need(await load());
  const ok = m.judgeK9({ runs: [k9Run(60_000, { runId: 'a' }), k9Run(30_000, { runId: 'b' }), k9Run(45_000, { runId: 'c' })] });
  assert.equal(ok.verdict, '통과');
  assert.equal(ok.maxReadySec, 60);
  assert.equal(ok.medianReadySec, 45);
  const bad = m.judgeK9({ runs: [k9Run(60_000, { runId: 'a' }), k9Run(60_001, { runId: 'b' })] });
  assert.equal(bad.verdict, '미달');
  assert.equal(bad.maxReadySec, 60.001);
  const mixed = m.judgeK9({ runs: [k9Run(60_000, { runId: 'a' }), k9Run(60_000, { runId: 'b', valid: false })] });
  assert.equal(mixed.verdict, '무효');
});

test('F0814-4 ① OPS-510 가격표·조회 날짜·AMP 2단계·X-Ray 무료 범위·시간 단가 49,538원', async () => {
  const m = need(await load());
  const p = m.F0814_PRICES;
  assert.equal(p.amp.freeSamples, 40_000_000);
  assert.equal(p.amp.ingestTiers[0].upToSamples, 2_000_000_000);
  assert.equal(p.amp.ingestTiers[0].perSamples, 10_000_000);
  assert.equal(p.amp.ingestTiers[0].unitPriceUsd, 0.9);
  assert.equal(p.amp.ingestTiers[1].upToSamples, 250_000_000_000);
  assert.equal(p.amp.ingestTiers[1].perSamples, 10_000_000);
  assert.equal(p.amp.ingestTiers[1].unitPriceUsd, 0.35);
  assert.equal(p.amp.storageFreeGB, 10);
  assert.equal(p.amp.storagePerGBMonthUsd, 0.03);
  assert.equal(p.amp.queryFreeSamples, 200_000_000_000);
  assert.equal(p.amp.queryPerBillionUsd, 0.1);
  assert.equal(p.amg.editorUsd, 9);
  assert.equal(p.amg.viewerUsd, 5);
  assert.equal(p.datadog.infraProPerServerUsd, 15);
  assert.equal(p.datadog.apmPerServerUsd, 40);
  assert.equal(p.datadog.metricsIncludedPerServer, 100);
  assert.equal(p.datadog.extraMetricsPer100Usd, 5);
  assert.equal(p.datadog.logsPerGBUsd, 0.1);
  assert.equal(p.xray.perMillionStoredUsd, 5);
  assert.equal(p.xray.perMillionQueriedUsd, 0.5);
  assert.equal(p.xray.freeTracesPerMonth, 100_000);
  assert.equal(p.xray.freeQueriesPerMonth, 1_000_000);
  assert.equal(p.s3.perGBMonthUsd, 0.025);
  assert.equal(p.timeRateKrw, 49_538);
  assert.equal(p.amp.priceDate, '2026-10-14');
  assert.equal(p.amg.priceDate, '2026-10-20');
  assert.equal(p.datadog.priceDate, '2026-10-19');
  assert.equal(p.xray.priceDate, '2026-09-11');
  assert.equal(p.s3.priceDate, '2026-10-15');
  assert.deepEqual(m.F0814_SENSITIVITY, [0.5, 1, 1.5]);
  assert.equal(m.F0814_DEFAULTS.sampleBudget, 40_000_000);
  assert.equal(m.F0814_DEFAULTS.tieRatio, 0.1);
  assert.equal(m.F0814_DEFAULTS.timeRateKrw, 49_538);
  assert.equal(m.F0814_DEFAULTS.postmortemHours, 48);
});

test('F0814-4 ② backendCosts 입력 없음·환율 출처/기준일/가격일 없음·ops-hours 0행 → 미측정', async () => {
  const m = need(await load());
  const r = m.backendCosts({ metrics: {}, opsHoursPerYear: {}, krwPerUsd: null, r3: { datadog: false } });
  assert.equal(r.verdict, '미측정');
  assert.ok(r.missing.includes('activeSeries'));
  assert.ok(r.missing.includes('samplesPerSecond'));
  assert.ok(r.missing.includes('krwPerUsd'));
  assert.ok(r.missing.includes('fxSource'));
  assert.ok(r.missing.includes('fxDate'));
  assert.ok(r.missing.includes('priceDate'));
  assert.equal(r.chosen, null);
  assert.equal(r.candidates.length, 0);

  for (const field of ['fxSource', 'fxDate', 'priceDate']) {
    const bad = m.backendCosts({ ...backendInput(), [field]: '' });
    assert.equal(bad.verdict, '미측정', `${field} 없이 통과하면 안 된다`);
    assert.ok(bad.missing.includes(field), `${field}가 missing에 없다`);
  }

  const partial = m.backendCosts({ ...backendInput(), metrics: { ...METRICS, nodes: null } });
  assert.notEqual(partial.verdict, '통과');

  const missing = m.readOpsHours(path.join(os.tmpdir(), 'f0814-no-such-ops.csv'));
  assert.equal(missing.ok, false);
  assert.equal(missing.rows, 0);
  withTemp({ 'ops.csv': 'date,component,activity,minutes,version_from,version_to,environment,ref,note\n' }, (p) => {
    const empty = m.readOpsHours(p['ops.csv']);
    assert.equal(empty.ok, false);
    assert.equal(empty.rows, 0);
  });
});

test('F0814-4 ③ backendCosts 합성 입력의 AMP(agg 포함)·AMG·Datadog·S3·운영 시간, 구성 요소·요청 기록 저장소', async () => {
  const m = need(await load());
  const r = m.backendCosts(backendInput());
  assert.equal(r.verdict, '통과');
  assert.equal(r.chosen, 'self');
  assert.equal(r.tie, false);
  assert.equal(r.opsSensitive, false);
  assert.deepEqual(r.candidates.map((c) => c.id), ['self', 'aws']);
  const self = r.candidates.find((c) => c.id === 'self');
  const aws = r.candidates.find((c) => c.id === 'aws');
  assert.ok(self && aws, 'R3 기본 제외 뒤 self·aws 후보가 있어야 한다');
  assert.equal(r.candidates.some((c) => c.id === 'datadog'), false);
  assert.ok(Math.abs(aws.annualUsd - 6_613.37) < 0.02, `aws ${aws.annualUsd}`);
  assert.ok(Math.abs(self.annualUsd - 3_699.53) < 0.02, `self ${self.annualUsd}`);
  for (const c of r.candidates) {
    const sum = c.items.reduce((acc, it) => acc + it.annualUsd, 0);
    assert.ok(Math.abs(sum - c.annualUsd) < 0.02, `${c.id} 항목 합계와 총액이 다르다`);
    assert.ok(c.items.every((it) => it.priceDate && it.source), `${c.id} 항목에 가격 날짜·출처가 없다`);
  }
  const ampIngest = aws.items.find((it) => it.item === 'amp-ingest');
  const ampStorage = aws.items.find((it) => it.item === 'amp-storage');
  assert.ok(Math.abs(ampIngest.quantity - 2_592_000_000) < 1, 'AMP 수집 샘플/월');
  assert.ok(Math.abs(ampIngest.annualUsd - 2_391.84) < 0.02, `AMP 수집 ${ampIngest.annualUsd}`);
  assert.equal(ampStorage.quantity, 160);
  assert.ok(Math.abs(ampStorage.annualUsd - 54) < 0.02, `AMP 저장 ${ampStorage.annualUsd}`);

  const comp = m.componentCosts({ metrics: METRICS });
  assert.equal(comp.verdict, '통과');
  const rows = Object.fromEntries(comp.rows.map((x) => [x.id, x]));
  assert.deepEqual(Object.keys(rows), ['prometheus', 'mimir', 'loki', 'tempo', 'pyroscope']);
  assert.equal(rows.prometheus.retentionDays, 15);
  assert.equal(rows.prometheus.storageGB, 110);
  assert.equal(rows.mimir.retentionDays, 395);
  assert.equal(rows.mimir.storageGB, 160);
  assert.equal(rows.loki.retentionDays, 30);
  assert.equal(rows.loki.storageGB, 300);
  assert.equal(rows.tempo.retentionDays, 14);
  assert.equal(rows.tempo.storageGB, 70);
  assert.equal(rows.pyroscope.retentionDays, 7);
  assert.equal(rows.pyroscope.storageGB, 7);
  assert.ok(Math.abs(rows.loki.annualUsd - 90) < 0.01, `loki ${rows.loki.annualUsd}`);
  assert.ok(Math.abs(rows.tempo.annualUsd - 21) < 0.01, `tempo ${rows.tempo.annualUsd}`);
  assert.ok(Math.abs(rows.pyroscope.annualUsd - 2.1) < 0.01, `pyroscope ${rows.pyroscope.annualUsd}`);
  assert.ok(Math.abs(rows.mimir.annualUsd - 48) < 0.01, `mimir ${rows.mimir.annualUsd}`);
  assert.equal(rows.loki.query, 'LogQL');
  assert.equal(rows.tempo.query, 'TraceQL');

  const stores = m.traceStoreCosts({ metrics: METRICS, traceStore: TRACE_STORE, krwPerUsd: 1_400, fxSource: '한국은행 기준환율', fxDate: '2026-11-28', priceDate: '2026-11-28' });
  assert.equal(stores.verdict, '통과');
  const byId = Object.fromEntries(stores.rows.map((x) => [x.id, x]));
  assert.deepEqual(Object.keys(byId), ['tempo-msk', 'tempo-monolith', 'xray']);
  assert.ok(Math.abs(byId['tempo-msk'].annualUsd - 4_759.43) < 0.02, `tempo-msk ${byId['tempo-msk'].annualUsd}`);
  assert.ok(Math.abs(byId['tempo-monolith'].annualUsd - 3_559.43) < 0.02, `tempo-monolith ${byId['tempo-monolith'].annualUsd}`);
  assert.ok(Math.abs(byId.xray.annualUsd - 1_907.21) < 0.02, `xray ${byId.xray.annualUsd}`);
  assert.equal(stores.rows.every((x) => x.durable3 === true), true);
  assert.equal(stores.rows.every((x) => x.openPeak === true), true);
  assert.equal(stores.chosen, 'xray');
  assert.equal(r.traceStores.length, 3);
});

test('F0814-4 ④ 민감도 순위 변화(self 1배 → aws 1.5배)·R3 기본 제외·R1 AMP 95일·10% 유지', async () => {
  const m = need(await load());
  const base = m.backendCosts(backendInput());
  assert.deepEqual(base.sensitivity.map((s) => s.factor), [0.5, 1, 1.5]);
  assert.equal(base.sensitivity.every((s) => s.ranking[0] === 'self'), true);
  assert.equal(base.sensitivity.every((s) => !s.ranking.includes('datadog')), true);
  assert.equal(base.tie, false);
  assert.equal(base.opsSensitive, false);

  const changed = m.backendCosts(backendInput({ opsHoursPerYear: { self: 170, aws: 100, datadog: 50 } }));
  assert.equal(changed.tie, false);
  assert.equal(changed.opsSensitive, true);
  assert.equal(changed.chosen, 'aws');
  assert.equal(changed.sensitivity[1].ranking[0], 'self');
  assert.equal(changed.sensitivity[2].ranking[0], 'aws');

  const r3 = m.backendCosts(backendInput({ r3: { datadog: true } }));
  assert.equal(r3.candidates.length, 3);
  assert.equal(r3.candidates.find((c) => c.id === 'datadog').eligible, true);
  assert.equal(r3.chosen, 'self');

  const aws = base.candidates.find((c) => c.id === 'aws');
  assert.equal(aws.limits.ampQueryDays, 95);
  assert.equal(aws.limits.ampQueryRps, 300);
  assert.equal(aws.limits.longTermConditional, true);

  const tieMetrics = { activeSeries: 0, samplesPerSecond: 0, metricStorageGB: 40, aggStorageGB: 10, logGBPerDay: 0, traceGBPerDay: 0, profileGBPerDay: 0, spansPerSecond: 0, querySamplesPerYear: 0, nodes: 0, editors: 0, viewers: 0 };
  const tied = m.backendCosts(backendInput({ metrics: tieMetrics, opsHoursPerYear: { self: 100, aws: 100.014, datadog: 0 } }));
  assert.equal(tied.tie, true);
  assert.equal(tied.chosen, 'self');
  assert.equal(tied.opsSensitive, false);
  assert.equal(tied.sensitivity[1].ranking[0], 'aws');
  assert.equal(tied.sensitivity[2].ranking[0], 'self');
});

test('F0814-4 ⑤ sampleBudget 식·4천만 초과·보내지 않음, 요청 기록 저장소 입력 없음은 미측정', async () => {
  const m = need(await load());
  const ok = m.sampleBudget(2_000, 15, 3);
  assert.equal(ok.samples, 34_560_000);
  assert.equal(ok.max, 40_000_000);
  assert.equal(ok.over, false);
  const over = m.sampleBudget(100_000, 15, 1);
  assert.equal(over.samples, 576_000_000);
  assert.equal(over.over, true);
  const r = m.backendCosts(backendInput());
  assert.equal(r.sampleBudget.sent, false);
  assert.equal(r.sampleBudget.max, 40_000_000);

  const traceBase = { metrics: METRICS, traceStore: TRACE_STORE, krwPerUsd: 1_400, fxSource: '한국은행 기준환율', fxDate: '2026-11-28', priceDate: '2026-11-28' };
  const noKafka = m.traceStoreCosts({ ...traceBase, traceStore: { ...TRACE_STORE, obsKafkaMonthlyUsd: null } });
  assert.equal(noKafka.rows.find((x) => x.id === 'tempo-msk').verdict, '미측정');
  const noXray = m.traceStoreCosts({ ...traceBase, traceStore: { ...TRACE_STORE, xrayTracesPerMonth: null } });
  assert.equal(noXray.rows.find((x) => x.id === 'xray').verdict, '미측정');
  for (const [field, value] of [['krwPerUsd', null], ['fxSource', ''], ['fxDate', ''], ['priceDate', '']]) {
    const bad = m.traceStoreCosts({ ...traceBase, [field]: value });
    assert.notEqual(bad.verdict, '통과', `${field} 없이 통과하면 안 된다`);
    assert.ok(bad.missing.includes(field), `${field}가 missing에 없다`);
  }
});

test('F0814-5 ① parseF0814Args: --window 3g 필수, 입력 인자, 금지 인자 거부, UsageError만', async () => {
  const m = need(await load());
  const a = m.parseF0814Args(['--window', '3g', '--k8', 'k8.md', '--k9', 'k9.json', '--metrics', 'm.json', '--ops-hours', 'ops.csv', '--fx', '1400', '--out', 'out', '--judge', 'j.json']);
  assert.equal(a.window, '3g');
  assert.equal(a.k8, 'k8.md');
  assert.equal(a.k9, 'k9.json');
  assert.equal(a.metrics, 'm.json');
  assert.equal(a.opsHours, 'ops.csv');
  assert.equal(a.fx, 1_400);
  assert.equal(a.out, 'out');
  assert.equal(a.judge, 'j.json');
  assert.throws(() => m.parseF0814Args([]), (e) => e?.name === 'UsageError');
  assert.throws(() => m.parseF0814Args(['--window', '3f']), (e) => e?.name === 'UsageError');
  assert.throws(() => m.parseF0814Args(['--window', '3g', '--fx', 'abc']), (e) => e?.name === 'UsageError');
  for (const flag of ['--docker', '--kind', '--k6', '--browser', '--inject']) {
    assert.throws(() => m.parseF0814Args(['--window', '3g', flag]), (e) => e?.name === 'UsageError');
  }
  assert.throws(() => m.parseF0814Args(['--window', '3g', '--unknown']), (e) => e?.name === 'UsageError');
});

test('F0814-5 ② f0814-plan.json: prices·boundaries·commands·notIncluded 전체·traceStores·K8 10종', async () => {
  const m = need(await load());
  const p = readJson(PLAN_JSON);
  assert.equal(m.validateF0814Plan(p).ok, true);
  assert.equal(p.batch, 'F-08-14');
  assert.equal(p.feature, 'F-08-14');
  assert.equal(p.window.id, '3g');
  assert.deepEqual(p.k8.ids, K8_IDS);
  assert.equal(p.k9.metric, 'hpa-pod-ready');
  assert.equal(p.k9.limitSec, 60);
  assert.deepEqual(p.backends.map((x) => x.id), ['self', 'aws', 'datadog']);
  assert.deepEqual(p.traceStores.map((x) => x.id), ['tempo-msk', 'tempo-monolith', 'xray']);
  assert.deepEqual(p.components.map((x) => x.id), ['prometheus', 'mimir', 'loki', 'tempo', 'pyroscope']);
  assert.equal(p.prices.amp.priceDate, '2026-10-14');
  assert.equal(p.prices.amp.ingestTiers[1].upToSamples, 250_000_000_000);
  assert.equal(p.prices.xray.freeTracesPerMonth, 100_000);
  assert.equal(p.prices.timeRateKrw, 49_538);
  assert.ok(Array.isArray(p.boundaries) && p.boundaries.length >= 4);
  assert.ok(p.boundaries.some((b) => b.feature === 'F-08-13'));
  assert.ok(Array.isArray(p.commands) && p.commands.length >= 1);
  assert.equal(p.stopRules.length, 10);
  for (const id of ['K1', 'K2', 'K7', 'Q-T2', 'S-T1', 'P-T1', 'V-T4', 'V-T5', 'V-T17', 'V-T18', 'V-T27', 'V-T28', 'NFR-027', 'NFR-028', 'OPS-520', 'OPS-530', 'G-11', 'G-33']) {
    assert.ok(p.notIncluded.includes(id), `${id}가 notIncluded에 없다`);
  }
  const text = JSON.stringify(p);
  assert.doesNotMatch(text, /--inject|--docker|--kind|--k6|--browser/);
});

test('F0814-5 ③ renderF0814Report: K8 10행·K9 표·후보 3·구성 요소 5·요청 기록 3·선행 상태·0% 없음·48시간/P0', async () => {
  const m = need(await load());
  const md = m.renderF0814Report(reportInput());
  for (const id of K8_IDS) assert.match(md, new RegExp(`\\| ${id} \\|`), `${id} 행이 없다`);
  assert.equal((md.match(/^\| G-\d\d \|/gm) ?? []).length, 10);
  for (const heading of ['## 1. K8', '## 2. K9', '## 3. OPS-510', '## 4. 구성 요소', '## 5. 요청 기록', '## 6. 선행 측정 인용', '## 7. 한계', '## 8. 장부·게이트', '## 9. 주장하지 않는 것']) assert.ok(md.includes(heading), `${heading}이 없다`);
  assert.match(md, /\| 실행 ID \| 시작 \| 첫 확장 \| 파드 준비 \| 확장\(초\) \| 준비\(초\) \| 판정 \|/);
  for (const id of ['self', 'aws', 'datadog']) assert.match(md, new RegExp(`\\| ${id} \\|`), `${id} 후보 행이 없다`);
  for (const id of ['prometheus', 'mimir', 'loki', 'tempo', 'pyroscope']) assert.match(md, new RegExp(`\\| ${id} \\|`), `${id} 구성 요소 행이 없다`);
  for (const id of ['tempo-msk', 'tempo-monolith', 'xray']) assert.match(md, new RegExp(`\\| ${id} \\|`), `${id} 요청 기록 행이 없다`);
  for (const p of PRIOR) {
    assert.ok(md.includes(p.id), `${p.id} 인용이 없다`);
    assert.ok(md.includes(p.status), `${p.id} 상태 ${p.status}가 없다`);
  }
  assert.ok(md.includes('48시간'));
  assert.ok(md.includes('P0'));
  assert.equal(md.includes('0%'), false);
  assert.match(md, /새 `?실측\(PC\)`? 줄을 만들지 않는다/);
  assert.doesNotMatch(md, /^\|.*실측\(PC\).*\|/m);
  const v = m.validateF0814Report(md, { runExists: () => false });
  assert.equal(v.ok, true, v.reasons.join(' / '));
});

test('F0814-5 ④ validateF0814Report: 실행 증거 없는 통과·선행 인용 누락·금지 수치·PII(이메일/카드)·실측(PC) 거부', async () => {
  const m = need(await load());
  const good = m.renderF0814Report(reportInput());
  assert.equal(m.validateF0814Report(good, { runExists: () => false }).ok, true);

  const fakePass = good.split('미측정').join('통과');
  assert.equal(m.validateF0814Report(fakePass, { runExists: () => false }).ok, false);

  const missingPrior = good.replace(/F-08-13/g, 'F-08-99');
  assert.equal(m.validateF0814Report(missingPrior, { runExists: () => false }).ok, false);

  for (const text of [`${good}\n30,000건/초를 달성했다.\n`, `${good}\n문의 a@b.co\n`, `${good}\n카드 1234-5678-9012-3456\n`, `${good}\n연락처 010-1234-5678\n`]) {
    assert.equal(m.validateF0814Report(text, { runExists: () => false }).ok, false);
  }

  const measured = `${good}\n| 실행 | 실측(PC) |\n`;
  assert.equal(m.validateF0814Report(measured, { runExists: () => false }).ok, false);

  const text = read(REPORT);
  const v = m.validateF0814Report(text, { runExists: () => false });
  assert.equal(v.ok, true, v.reasons.join(' / '));
});

test('F0814-5 ⑤ validateF0814Plan: 창·batch·notIncluded·prices·boundaries·commands 변조를 거부한다', async () => {
  const m = need(await load());
  const p = readJson(PLAN_JSON);
  assert.equal(m.validateF0814Plan(p).ok, true);
  assert.equal(m.validateF0814Plan({ ...p, window: { id: '3f' } }).ok, false);
  assert.equal(m.validateF0814Plan({ ...p, batch: 'F-08-13' }).ok, false);
  assert.equal(m.validateF0814Plan({ ...p, notIncluded: [] }).ok, false);
  assert.equal(m.validateF0814Plan({ ...p, prices: {} }).ok, false);
  assert.equal(m.validateF0814Plan({ ...p, boundaries: [] }).ok, false);
  assert.equal(m.validateF0814Plan({ ...p, commands: [{ cmd: 'run --inject' }] }).ok, false);
});

test('F0814-6 ① 계획 문서: 정본 자리·범위·측정 설계·경계·검증, K8 10종·K9·OPS-510, 금지 수치가 좁은 부정문 밖에 없음', async () => {
  const md = read(PLAN_DOC);
  for (const heading of PLAN_SECTIONS) assert.ok(md.includes(heading), `${heading}이 없다`);
  for (const id of K8_IDS) assert.ok(md.includes(id), `${id}가 계획에 없다`);
  assert.match(md, /K9/);
  assert.match(md, /OPS-510/);
  assert.match(md, /60\.000/);
  assert.match(md, /60\.001/);
  assert.match(md, /3\.000/);
  assert.match(md, /3\.001/);
  for (const line of md.split(/\r?\n/)) {
    for (const f of FORBIDDEN) {
      if (!line.includes(f.token)) continue;
      if (!f.claim(line)) continue;
      assert.ok(NEGATIONS.some((n) => line.includes(n)), `금지 수치가 부정문 밖에 있다: ${line.slice(0, 120)}`);
    }
  }
});

test('F0814-6 ② 계획 문서의 정직성: K8/K9/OPS-510 모두 미측정·판정 못 함, 새 측정·Docker 없음, F-08-13 미측정 인용', async () => {
  const md = read(PLAN_DOC);
  assert.match(md, /미측정/);
  assert.match(md, /판정 못 함/);
  assert.match(md, /F-08-13[^\n]*미측정|미측정[^\n]*F-08-13/);
  assert.match(md, /Docker·kind·k6·브라우저를 쓰지 않았다/);
  assert.match(md, /미실행/);
  assert.match(md, /F-08-6/);
  assert.match(md, /참고/);
  assert.match(md, /gameday\.mjs/);
  assert.match(md, /OPS-520|F-08-15/);
  assert.match(md, /장부 항목은 \*\*0개\*\*|항목 0/);
  assert.match(md, /RV0814-01/);
});
