// F-08-14 K8/K9·관측 백엔드 비교 시험(F0814-1~6): 카탈로그·판정 계약·비용 계산·계획/보고서.
// 정본: docs/observability.md §4·§5·§9·§12, docs/verification.md §3.10·§5.2,
//       docs/perf-ledger.md §7·§8·§11, ADR-0067·0068·0073·0077.
// 단언 값은 정본에서 가져와 이 파일에 적는다(구현 상수를 가져오지 않는다).
// Docker·kind·k6·브라우저를 쓰지 않는다. 실행: node --test loadtest/test/f0814-observe.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNNER = path.join(ROOT, 'loadtest', 'runner', 'observability-compare.mjs');
const PLAN_JSON = path.join(ROOT, 'loadtest', 'plan', 'f0814-plan.json');
const REPORT = path.join(ROOT, 'docs', 'review', 'measurements', 'F-08-14.md');
const PLAN_DOC = path.join(ROOT, 'docs', 'review', 'plans', 'F-08-14.md');

const K8_IDS = Array.from({ length: 10 }, (_, i) => `G-${String(i + 1).padStart(2, '0')}`);
const K8_EXPECTED = [
  { id: 'G-01', name: /대기열 Redis/, alert: /대기열 진입 번 레이트/ },
  { id: 'G-02', name: /좌석 Redis/, alert: /좌석 홀드|seat_store_unavailable|페일오버/ },
  { id: 'G-03', name: /CDN 엣지/, alert: /대기 순번 조회|가용성 저하/ },
  { id: 'G-04', name: /공연 상세/, alert: /공연 정보 페이지|에러 버짓/ },
  { id: 'G-05', name: /결제 승인 API|결제사|PG/, alert: /결제 확정 임박|RB-07|SEV1/ },
  { id: 'G-06', name: /realtime-gw|소켓 송신 버퍼/, alert: /버퍼|realtime_gw_degraded/ },
  { id: 'G-07', name: /ops-rt|스트림 작업자/, alert: /신선도|경고 색/ },
  { id: 'G-08', name: /ops-svc/, alert: /가용성 상실|SEV1/ },
  { id: 'G-09', name: /admission-ctrl/, alert: /리더 부재|SEV2/ },
  { id: 'G-10', name: /MSK|브로커/, alert: /브로커 오프라인|소비 지연/ },
];
const PRIOR = [
  { id: 'F-08-5', status: /무효·미측정/ },
  { id: 'F-08-9', status: /판정 못 함\(무효·부분\)/ },
  { id: 'F-08-10', status: /미측정/ },
  { id: 'F-08-12', status: /미측정/ },
  { id: 'F-08-13', status: /설계만·판정 못 함/ },
  { id: 'F-08-6', status: /미측정/ },
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

const usage = (fn) => assert.throws(fn, (e) => e?.name === 'UsageError', 'UsageError로 거부해야 한다');

/** K8 입력 한 행. 값은 시험이 손으로 정한 합성값이고 측정값이 아니다. */
function k8Row(id, overrides = {}) {
  return {
    id,
    verdict: '통과',
    detectionSec: 10,
    propagationSec: 1,
    evidence: 'Alertmanager 웹훅 수신 로그',
    valid: true,
    stageReady: true,
    source: 'F-08-6',
    ...overrides,
  };
}
const k8Rows = (detectionSec = 10, propagationSec = 1) =>
  K8_IDS.map((id) => k8Row(id, { detectionSec, propagationSec }));

/** K9 입력 한 실행. 값은 시험이 손으로 정한 합성값이고 측정값이 아니다. */
function k9Run(readyMs, overrides = {}) {
  return {
    runId: '2026-11-24-k1-1k-r1-f0814',
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
const backendInput = (overrides = {}) => ({
  metrics: { ...METRICS, ...(overrides.metrics ?? {}) },
  opsHoursPerYear: { self: 100, aws: 100, datadog: 50, ...(overrides.opsHoursPerYear ?? {}) },
  krwPerUsd: 1_400,
  r3: { datadog: false, ...(overrides.r3 ?? {}) },
  priceDate: '2026-11-28',
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
        name: K8_EXPECTED.find((s) => s.id === id).name.source,
        source: 'F-08-6',
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
    prior: PRIOR.map((p) => ({ id: p.id, status: p.id === 'F-08-13' ? '설계만·판정 못 함' : p.id === 'F-08-9' ? '판정 못 함(무효·부분)' : p.id === 'F-08-5' ? '무효·미측정' : '미측정' })),
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
    assert.match(s.name, expected.name);
    assert.match(s.expectedAlert, expected.alert);
    assert.ok(String(s.source).includes('F-08-6'), `${expected.id}의 입력에 F-08-6이 없다`);
  }
  for (const s of m.F0814_SCENARIOS) assert.ok(K8_IDS.includes(s.id), `${s.id}는 K8 10종이 아니다`);
  assert.equal(m.F0814_SCENARIOS.some((s) => /^G-(1[1-9]|2[0-9]|3[0-3])$/.test(s.id)), false);
});

test('F0814-1 ② 입력 표: F-08-6 10행·F-08-12 2행(G-02·G-10)·F-08-13 0행, 선행 인용 다섯 + F-08-6 미측정', async () => {
  const m = need(await load());
  const f6 = m.F0814_INPUTS.find((x) => x.id === 'F-08-6');
  const f12 = m.F0814_INPUTS.find((x) => x.id === 'F-08-12');
  const f13 = m.F0814_INPUTS.find((x) => x.id === 'F-08-13');
  assert.ok(f6 && f12 && f13, 'F-08-6·F-08-12·F-08-13 입력이 모두 있어야 한다');
  assert.deepEqual(f6.k8Ids, K8_IDS);
  assert.deepEqual(f12.k8Ids, ['G-02', 'G-10']);
  assert.deepEqual(f13.k8Ids, []);
  assert.equal(f6.status, '미측정');
  assert.equal(f12.status, '미측정');
  assert.equal(f13.status, '설계만·판정 못 함');
  assert.deepEqual(m.F0814_PRIOR_MEASUREMENTS.map((x) => x.id), PRIOR.map((x) => x.id));
  for (const p of PRIOR) {
    const got = m.F0814_PRIOR_MEASUREMENTS.find((x) => x.id === p.id);
    assert.ok(got, `${p.id} 선행 인용이 없다`);
    assert.match(got.status, p.status);
  }
  assert.ok(m.F0814_PRIOR_MEASUREMENTS.some((x) => x.id === 'F-08-6' && x.status === '미측정'), 'F-08-6 미측정 인용이 없다');
});

test('F0814-1 ③ K8 경계: 탐지 60.000/60.001초, 전파 3.000/3.001초, 분모 10, 입력 없음 null', async () => {
  const m = need(await load());
  assert.deepEqual(m.F0814_K8_LIMITS, { detectionSec: 60, propagationSec: 3, detectionRate: 1 });
  assert.deepEqual(m.F0814_K9_LIMITS, { readySec: 60 });
  assert.deepEqual(m.F0814_VERDICTS, ['통과', '미달', '판정 못 함', '무효', '미측정']);
  assert.equal(m.F0814_K8_LIMITS.detectionSec * 1000, 60_000);
  assert.equal(m.F0814_K8_LIMITS.propagationSec * 1000, 3_000);
  assert.equal(m.F0814_K9_LIMITS.readySec * 1000, 60_000);
});

test('F0814-2 ① judgeK8 기록 없음 → 미측정, detectionRate null, 빠진 ID 10', async () => {
  const m = need(await load());
  const r = m.judgeK8({ rows: [] });
  assert.equal(r.verdict, '미측정');
  assert.equal(r.detectionRate, null);
  assert.equal(r.measured, 0);
  assert.equal(r.detected, 0);
  assert.equal(r.missing.length, 10);
  assert.ok(r.reasons.length > 0);
});

test('F0814-2 ② judgeK8 10행 모두 60.000초·3.000초 → 통과, 탐지율 1, 최댓값 60', async () => {
  const m = need(await load());
  const r = m.judgeK8({ rows: k8Rows(60, 3) });
  assert.equal(r.verdict, '통과');
  assert.equal(r.detectionRate, 1);
  assert.equal(r.measured, 10);
  assert.equal(r.detected, 10);
  assert.equal(r.within60, 10);
  assert.equal(r.maxDetectionSec, 60);
  assert.equal(r.propagationMaxSec, 3);
  assert.equal(r.propagationVerdict, '통과');
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.invalid, []);
});

test('F0814-2 ③ judgeK8 60.001초·3.001초·한 행 미탐지 → 미달, 탐지율 0.9', async () => {
  const m = need(await load());
  const over = k8Rows();
  over[0].detectionSec = 60.001;
  const r1 = m.judgeK8({ rows: over });
  assert.equal(r1.verdict, '미달');
  assert.equal(r1.detectionRate, 0.9);
  assert.equal(r1.within60, 9);

  const overCmd = k8Rows();
  overCmd[1].propagationSec = 3.001;
  const r2 = m.judgeK8({ rows: overCmd });
  assert.equal(r2.verdict, '미달');
  assert.equal(r2.propagationVerdict, '미달');

  const missed = k8Rows();
  missed[2] = { ...missed[2], verdict: '미달', detectionSec: null };
  const r3 = m.judgeK8({ rows: missed });
  assert.equal(r3.verdict, '미달');
  assert.equal(r3.detectionRate, 0.9);
  assert.equal(r3.maxDetectionSec, 10);
});

test('F0814-2 ④ judgeK8 일부 행 → 판정 못 함, 무효 행 → 무효, 중복·모르는 ID·증거 없음 거부', async () => {
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
  noEvidence[0] = { ...noEvidence[0], evidence: '' };
  assert.equal(m.judgeK8({ rows: noEvidence }).verdict, '판정 못 함');

  const notReady = k8Rows();
  notReady[0] = { ...notReady[0], stageReady: false };
  assert.equal(m.judgeK8({ rows: notReady }).verdict, '판정 못 함');
});

test('F0814-2 ⑤ judgeK8 미측정·null 입력을 0으로 바꾸지 않고 0%를 만들지 않는다', async () => {
  const m = need(await load());
  const rows = K8_IDS.map((id) => k8Row(id, { verdict: '미측정', detectionSec: null, propagationSec: null, evidence: '' }));
  const r = m.judgeK8({ rows });
  assert.equal(r.verdict, '미측정');
  assert.equal(r.detectionRate, null);
  assert.equal(r.measuredRate, null);
  assert.equal(r.measured, 0);
  assert.notEqual(r.detectionRate, 0);

  const fakePass = k8Rows();
  fakePass[0] = { ...fakePass[0], verdict: '통과', detectionSec: null };
  assert.notEqual(m.judgeK8({ rows: fakePass }).verdict, '통과');
});

test('F0814-3 ① K9 정의: HPA, 복제 1→N, --hpa-timeline, 준비 60초, v0 인용과 v1 판정 분리', async () => {
  const m = need(await load());
  assert.equal(m.F0814_K9_LIMITS.readySec, 60);
  assert.equal(m.F0814_K9.name, 'hpa-pod-ready');
  assert.equal(m.F0814_K9.replicasBefore, 1);
  assert.match(m.F0814_K9.flag, /--hpa-timeline/);
  assert.match(m.F0814_K9.source, /docs\/verification\.md/);
  assert.match(m.F0814_K9.v0Note, /v0|baseline/);
  assert.equal(m.F0814_K9.v0IsV1Pass, false);
});

test('F0814-3 ② judgeK9 실행 없음 → 미측정, maxReadySec null', async () => {
  const m = need(await load());
  const r = m.judgeK9({ runs: [] });
  assert.equal(r.verdict, '미측정');
  assert.equal(r.maxReadySec, null);
  assert.equal(r.medianReadySec, null);
  assert.equal(r.count, 0);
  assert.ok(r.reasons.length > 0);
});

test('F0814-3 ③ judgeK9 60.000/60.001초, 시각 뒤집힘·복제 미증가·누락 → 무효', async () => {
  const m = need(await load());
  assert.equal(m.judgeK9({ runs: [k9Run(60_000)] }).verdict, '통과');
  assert.equal(m.judgeK9({ runs: [k9Run(60_001)] }).verdict, '미달');
  assert.equal(m.judgeK9({ runs: [k9Run(5_000)] }).verdict, '무효');
  assert.equal(m.judgeK9({ runs: [k9Run(60_000, { replicasAfter: 1 })] }).verdict, '무효');
  assert.equal(m.judgeK9({ runs: [k9Run(60_000, { scaledAtMs: null })] }).verdict, '무효');
  assert.equal(m.judgeK9({ runs: [k9Run(60_000, { valid: false })] }).verdict, '무효');
});

test('F0814-3 ④ judgeK9 여러 실행의 최댓값·중앙값, 하나라도 60.001초면 미달', async () => {
  const m = need(await load());
  const ok = m.judgeK9({ runs: [k9Run(60_000, { runId: 'a' }), k9Run(30_000, { runId: 'b' }), k9Run(45_000, { runId: 'c' })] });
  assert.equal(ok.verdict, '통과');
  assert.equal(ok.maxReadySec, 60);
  assert.equal(ok.medianReadySec, 45);
  const bad = m.judgeK9({ runs: [k9Run(60_000, { runId: 'a' }), k9Run(60_001, { runId: 'b' })] });
  assert.equal(bad.verdict, '미달');
  assert.equal(bad.maxReadySec, 60.001);
});

test('F0814-4 ① OPS-510 가격표·조회 날짜·샘플 예산 4천만·민감도 0.5/1/1.5·10% 유지·시간 단가 49,538원', async () => {
  const m = need(await load());
  const p = m.F0814_PRICES;
  assert.equal(p.amp.freeSamples, 40_000_000);
  assert.equal(p.amp.ingestTiers[0].upToSamples, 2_000_000_000);
  assert.equal(p.amp.ingestTiers[0].perSamples, 10_000_000);
  assert.equal(p.amp.ingestTiers[0].unitPriceUsd, 0.9);
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
  assert.equal(p.s3.perGBMonthUsd, 0.025);
  assert.equal(p.timeRateKrw, 49_538);
  for (const key of ['amp', 'amg', 'datadog', 'xray', 's3']) assert.match(String(p[key].priceDate), /2026-/, `${key} 가격 조회 날짜가 없다`);
  assert.deepEqual(m.F0814_SENSITIVITY, [0.5, 1, 1.5]);
  assert.equal(m.F0814_DEFAULTS.sampleBudget, 40_000_000);
  assert.equal(m.F0814_DEFAULTS.tieRatio, 0.1);
  assert.equal(m.F0814_DEFAULTS.timeRateKrw, 49_538);
  assert.equal(m.F0814_DEFAULTS.postmortemHours, 48);
});

test('F0814-4 ② backendCosts 입력 없음 → 미측정, 빠진 입력 목록, 후보 합계 없음', async () => {
  const m = need(await load());
  const r = m.backendCosts({ metrics: {}, opsHoursPerYear: {}, krwPerUsd: null, r3: { datadog: false } });
  assert.equal(r.verdict, '미측정');
  assert.ok(r.missing.includes('activeSeries'));
  assert.ok(r.missing.includes('samplesPerSecond'));
  assert.ok(r.missing.includes('krwPerUsd'));
  assert.equal(r.chosen, null);
  assert.equal(r.candidates.length, 0);

  const partial = m.backendCosts({ metrics: { ...METRICS, nodes: null }, opsHoursPerYear: { self: 100, aws: 100, datadog: 50 }, krwPerUsd: 1_400, r3: { datadog: false } });
  assert.notEqual(partial.verdict, '통과');
});

test('F0814-4 ③ backendCosts 합성 입력의 AMP·AMG·Datadog·S3·운영 시간 계산', async () => {
  const m = need(await load());
  const r = m.backendCosts(backendInput());
  assert.equal(r.verdict, '통과');
  assert.equal(r.chosen, 'self');
  assert.equal(r.tie, false);
  assert.equal(r.opsSensitive, false);
  const self = r.candidates.find((c) => c.id === 'self');
  const aws = r.candidates.find((c) => c.id === 'aws');
  const dd = r.candidates.find((c) => c.id === 'datadog');
  assert.ok(self && aws && dd, '세 후보가 있어야 한다');
  assert.ok(Math.abs(aws.annualUsd - 6_595.37) < 0.02, `aws ${aws.annualUsd}`);
  assert.ok(Math.abs(self.annualUsd - 3_699.53) < 0.02, `self ${self.annualUsd}`);
  assert.ok(Math.abs(dd.annualUsd - 68_129.21) < 0.02, `datadog ${dd.annualUsd}`);
  assert.equal(dd.eligible, false, 'R3 기본값은 Datadog 제외다');
  for (const c of r.candidates) {
    const sum = c.items.reduce((acc, it) => acc + it.annualUsd, 0);
    assert.ok(Math.abs(sum - c.annualUsd) < 0.02, `${c.id} 항목 합계와 총액이 다르다`);
    assert.ok(c.items.every((it) => it.priceDate && it.source), `${c.id} 항목에 가격 날짜·출처가 없다`);
  }
  const ampIngest = aws.items.find((it) => it.item === 'amp-ingest');
  assert.ok(Math.abs(ampIngest.quantity - 2_592_000_000) < 1, 'AMP 수집 샘플/월');
  assert.ok(Math.abs(ampIngest.annualUsd - 2_391.84) < 0.02, `AMP 수집 ${ampIngest.annualUsd}`);

  const comp = m.componentCosts({ metrics: METRICS });
  assert.equal(comp.verdict, '통과');
  const rows = Object.fromEntries(comp.rows.map((r) => [r.id, r]));
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
});

test('F0814-4 ④ 민감도 순위·1.5배 1위 규칙·10% 유지·R3 Datadog 제외/허용·R1 AMP 95일 표시', async () => {
  const m = need(await load());
  const base = m.backendCosts(backendInput());
  assert.deepEqual(base.sensitivity.map((s) => s.factor), [0.5, 1, 1.5]);
  assert.equal(base.sensitivity.every((s) => s.ranking[0] === 'self'), true);

  const tied = m.backendCosts(backendInput({ opsHoursPerYear: { self: 190, aws: 100, datadog: 50 } }));
  assert.equal(tied.tie, true);
  assert.equal(tied.opsSensitive, true);
  assert.equal(tied.chosen, 'aws', '1.5배에서 1위가 바뀌면 1.5배 1위를 고른다');

  const r3 = m.backendCosts(backendInput({ r3: { datadog: true } }));
  const dd = r3.candidates.find((c) => c.id === 'datadog');
  assert.equal(dd.eligible, true);
  assert.equal(r3.candidates.length, 3);
  assert.equal(r3.chosen, 'self');

  const aws = base.candidates.find((c) => c.id === 'aws');
  assert.equal(aws.limits.ampQueryDays, 95);
  assert.equal(aws.limits.ampQueryRps, 300);
  assert.equal(aws.limits.longTermConditional, true);
});

test('F0814-4 ⑤ sampleBudget 식과 4천만 초과 거부, 보내지 않음(sent:false)', async () => {
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
});

test('F0814-5 ① parseF0814Args: --window 3g 필수, 입력 인자, 금지 인자 거부, UsageError만', async () => {
  const m = need(await load());
  const a = m.parseF0814Args(['--window', '3g', '--k8', 'k8.md', '--k9', 'k9.md', '--metrics', 'm.json', '--ops-hours', 'ops.csv', '--fx', '1400', '--out', 'out', '--judge', 'j.json']);
  assert.equal(a.window, '3g');
  assert.equal(a.k8, 'k8.md');
  assert.equal(a.k9, 'k9.md');
  assert.equal(a.metrics, 'm.json');
  assert.equal(a.opsHours, 'ops.csv');
  assert.equal(a.fx, 1_400);
  assert.equal(a.out, 'out');
  assert.equal(a.judge, 'j.json');
  assert.throws(() => m.parseF0814Args([]), (e) => e?.name === 'UsageError');
  usage(() => m.parseF0814Args(['--window', '3f']));
  usage(() => m.parseF0814Args(['--window', '3g', '--fx', 'abc']));
  for (const flag of ['--docker', '--kind', '--k6', '--browser', '--inject']) usage(() => m.parseF0814Args(['--window', '3g', flag]));
  assert.throws(() => m.parseF0814Args(['--window', '3g', '--unknown']), (e) => e?.name === 'UsageError');
});

test('F0814-5 ② f0814-plan.json: batch·feature·창 3g·K8 10종·K9·후보 3·구성 요소 5·중단 규칙·경계·notIncluded, 주입 명령 없음', async () => {
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
  assert.deepEqual(p.components.map((x) => x.id), ['prometheus', 'mimir', 'loki', 'tempo', 'pyroscope']);
  assert.equal(p.stopRules.length, 10);
  assert.ok(p.notIncluded.includes('K1'));
  assert.ok(p.notIncluded.includes('V-T18'));
  assert.ok(p.notIncluded.includes('V-T27'));
  assert.ok(p.notIncluded.includes('Q-T2'));
  const text = JSON.stringify(p);
  assert.doesNotMatch(text, /--inject|--docker|--kind|--k6|--browser/);
});

test('F0814-5 ③ renderF0814Report: K8 10행·K9 표·후보 3행·구성 요소 5행·선행 인용 5개·0통과·실측(PC) 없음', async () => {
  const m = need(await load());
  const md = m.renderF0814Report(reportInput());
  for (const id of K8_IDS) assert.match(md, new RegExp(`\\| ${id} \\|`), `${id} 행이 없다`);
  for (const heading of ['## 1. K8', '## 2. K9', '## 3. OPS-510', '## 4. 구성 요소', '## 5. 요청 기록', '## 6. 선행 측정 인용', '## 7. 한계', '## 8. 장부·게이트', '## 9. 주장하지 않는 것']) assert.ok(md.includes(heading), `${heading}이 없다`);
  for (const p of PRIOR) assert.ok(md.includes(p.id), `${p.id} 인용이 없다`);
  assert.ok(md.includes('미측정'));
  assert.doesNotMatch(md, /실측\(PC\)/);
  assert.match(md, /0통과|통과 0/);
  const v = m.validateF0814Report(md, { runExists: () => false });
  assert.equal(v.ok, true, v.reasons.join(' / '));
});

test('F0814-5 ④ validateF0814Report: 실행 증거 없는 통과·선행 인용 누락·금지 수치·PII·실측(PC) 거부', async () => {
  const m = need(await load());
  const good = m.renderF0814Report(reportInput());
  assert.equal(m.validateF0814Report(good, { runExists: () => false }).ok, true);

  const fakePass = good.split('미측정').join('통과');
  assert.equal(m.validateF0814Report(fakePass, { runExists: () => false }).ok, false);

  const missingPrior = good.replace(/F-08-13/g, 'F-08-99');
  assert.equal(m.validateF0814Report(missingPrior, { runExists: () => false }).ok, false);

  const badNumber = `${good}\n30,000건/초를 달성했다.\n`;
  assert.equal(m.validateF0814Report(badNumber, { runExists: () => false }).ok, false);

  const pii = `${good}\n연락처 010-1234-5678\n`;
  assert.equal(m.validateF0814Report(pii, { runExists: () => false }).ok, false);

  const measured = `${good}\n실측(PC)\n`;
  assert.equal(m.validateF0814Report(measured, { runExists: () => false }).ok, false);

  const text = read(REPORT);
  const v = m.validateF0814Report(text, { runExists: () => false });
  assert.equal(v.ok, true, v.reasons.join(' / '));
});

test('F0814-5 ⑤ validateF0814Plan: 창·batch·notIncluded·금지 인자 변조를 거부한다', async () => {
  const m = need(await load());
  const p = readJson(PLAN_JSON);
  assert.equal(m.validateF0814Plan(p).ok, true);
  assert.equal(m.validateF0814Plan({ ...p, window: { id: '3f' } }).ok, false);
  assert.equal(m.validateF0814Plan({ ...p, batch: 'F-08-13' }).ok, false);
  assert.equal(m.validateF0814Plan({ ...p, notIncluded: [] }).ok, false);
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

test('F0814-6 ② 계획 문서의 정직성: K8/K9/OPS-510 모두 미측정·판정 못 함, 새 측정·Docker 없음, F-08-13 설계만 인용', async () => {
  const md = read(PLAN_DOC);
  assert.match(md, /미측정/);
  assert.match(md, /판정 못 함/);
  assert.match(md, /설계만·판정 못 함/);
  assert.match(md, /Docker·kind·k6·브라우저를 쓰지 않았다/);
  assert.match(md, /미실행/);
  assert.match(md, /F-08-6/);
  assert.match(md, /참고/);
  assert.match(md, /gameday\.mjs/);
  assert.match(md, /OPS-520|F-08-15/);
  assert.match(md, /장부 항목은 \*\*0개\*\*|항목 0/);
});
