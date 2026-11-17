// 게이트웨이 차단 상한 측정 도구(gw sweep·capacity·ip-limit)의 단위 시험(BUILD_ORDER BAS-090, 묶음 BAT-056 계획 §3의 U1~U8, V-T43 ①②·SR-T13 ②).
// 대상: loadtest/runner/gw.mjs(순수 함수)와 gw-run.mjs runGw(클러스터·발생기는 가짜 deps). 각 export의 JSDoc과 계획 '시험 이의' (가)~(라)의 입력 꼴을 명세로 본다.
// 정본: docs/infra.md §4.1 '게이트웨이 차단 상한' '측정(V-T43)'(판정 둘, 무효를 통과로 세지 않음), docs/features/search.md §12 SR-T13 ② '측정 판정'(50 × (본구간 초 + 1) × 복제 수).
// 시험 값(3ms, 초당 50건, 이름표 peaket.io/sweep, 네임스페이스 envoy-gateway-system)은 코드 상수를 가져오지 않고 정본·계획 값을 적는다. 상한 값은 운영 첫 값과 다르게 고른다
// (동시 7·보류 2 등. 값이 같으면 상수를 잘못 쓴 결함이 숨는다). 판정 함수만 보지 않고 부르는 쪽(runGw의 결과 파일·성능 장부 기록·끝 코드)이 판정을 쓰는지 본다.
// 실행: node --test loadtest/test/gw-breaker.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { UsageError } from '../runner/args.mjs';
import { expandSweepSteps, judgeIpLimit, judgeSweepStep, limitsLoaded, parseClusterLimits, parseClusterStats, parseGwArgs, statsWindow, sweepChecks, sweepPolicy } from '../runner/gw.mjs';
import { runGw, waitLimits } from '../runner/gw-run.mjs';
// 리뷰 반영(R1·R6)이 새로 내보낼 함수는 이름으로 찾는다(없으면 그 시험만 실패하고 파일 전체가 읽기에 실패하지 않게)
import * as gwRun from '../runner/gw-run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_MJS = join(HERE, '..', 'run.mjs');

// ---- 정본·계획 값 ----
const FAST_FAIL_MS = 3; // V-T43 ②: 3ms 안에 503
const SEARCH_PER_IP = 50; // SR-T13 ②: 초당 50건
const NS = 'envoy-gateway-system';
const SWEEP_LABEL = 'peaket.io/sweep';
const ROUTE = 'gw-queue-buy';
/** 시험용 생성 라우트: 진입(POST …/entries)이 1번 규칙이다(실제 생성 라우트와 번호를 다르게 둬 '0번 고정' 결함을 잡는다) */
const ROUTE_OBJ = {
  apiVersion: 'gateway.networking.k8s.io/v1',
  kind: 'HTTPRoute',
  metadata: { name: ROUTE, namespace: NS },
  spec: {
    rules: [
      { matches: [{ method: 'POST', path: { type: 'RegularExpression', value: '/v1/queues/[^/]+/admission' } }] },
      { matches: [{ method: 'POST', path: { type: 'RegularExpression', value: '/v1/queues/[^/]+/entries' } }] },
    ],
  },
};
const CLUSTER = `httproute/${NS}/${ROUTE}/rule/1`;

// ---- 가짜 자료 ----
/** Envoy /stats/prometheus 꼴(그 묶음 + 이름이 비슷한 묶음들) */
function statsText(cluster, v = {}) {
  const val = { upstream_rq_active: 6, upstream_rq_pending_active: 1, upstream_rq_pending_overflow: 0, upstream_cx_overflow: 0, upstream_rq_retry_overflow: 0, upstream_cx_pool_overflow: 0, upstream_rq_total: 100, ...v };
  const lines = [];
  const decoys = [`${cluster}0`, cluster.replace('/rule/', '-2/rule/'), cluster.replace('/rule/', '/rule/x')];
  for (const [k, n] of Object.entries(val)) {
    lines.push(`# TYPE envoy_cluster_${k} ${k.endsWith('_active') ? 'gauge' : 'counter'}`);
    for (const d of decoys) lines.push(`envoy_cluster_${k}{envoy_cluster_name="${d}"} 9999`);
    if (n !== undefined) lines.push(`envoy_cluster_${k}{envoy_cluster_name="${cluster}"} ${n}`);
  }
  return `${lines.join('\n')}\n`;
}
/** Envoy 관리 포트 /clusters 꼴(높은 우선순위 줄과 이름이 비슷한 묶음을 앞에 둔다) */
function clustersText(cluster, l) {
  const rows = [];
  for (const d of [`${cluster}0`, cluster.replace('/rule/', '-2/rule/')])
    for (const k of ['max_connections', 'max_pending_requests', 'max_requests', 'max_retries']) rows.push(`${d}::default_priority::${k}::9999`);
  for (const k of ['max_connections', 'max_pending_requests', 'max_requests', 'max_retries']) rows.push(`${cluster}::high_priority::${k}::1024`);
  rows.push(`${cluster}::observability_name::${cluster}`);
  if (l.maxConnections !== undefined) rows.push(`${cluster}::default_priority::max_connections::${l.maxConnections}`);
  if (l.maxPendingRequests !== undefined) rows.push(`${cluster}::default_priority::max_pending_requests::${l.maxPendingRequests}`);
  if (l.maxRequests !== undefined) rows.push(`${cluster}::default_priority::max_requests::${l.maxRequests}`);
  rows.push(`${cluster}::default_priority::max_retries::${l.maxRetries ?? 3}`);
  rows.push(`${cluster}::10.244.0.9:3000::cx_active::2`);
  return `${rows.join('\n')}\n`;
}
/** streamMetrics 결과 꼴(시험 이의 (다)) */
function M({ sent = 1000, n503 = 0, n429 = 0, other = 0, p99 = n503 ? 1.2 : null, overFast = 0, raMissing = 0, raNonnum = 0, bad = 0, ra429Missing = 0, n2xx } = {}) {
  return {
    sent,
    status: { '2xx': n2xx ?? sent - n503 - n429 - other, 503: n503, 429: n429, other },
    latency: { '2xx': { p50: 5, p99: 9, max: 20 }, 503: { p50: n503 ? 0.8 : null, p99, max: n503 ? 4 : null }, 429: { p50: null, p99: null, max: null } },
    overFast,
    retryAfter: { 503: { num: n503 - raMissing - raNonnum, missing: raMissing, nonnum: raNonnum }, 429: { num: n429 - ra429Missing, missing: ra429Missing, nonnum: 0 } },
    problem: { 503: { ok: n503 - bad, bad }, 429: { ok: n429, bad: 0 } },
  };
}
const STEP = { index: 0, maxConnections: 7, maxParallelRequests: 7, maxPendingRequests: 2, rate: 300, delay: { kind: 'normal' }, mix: 'normal', repeat: 1 };
const STATS = { overflow: { upstream_rq_pending_overflow: 0, upstream_cx_overflow: 0 }, overflowTotal: 0, rqActiveMax: 6, rqPendingActiveMax: 1 };
const GEN = { valid: true, reasons: [], dropped: 0 };
const judge = (o = {}) => judgeSweepStep({ step: STEP, overload: false, limitsLoaded: true, stats: STATS, m: M(), generator: GEN, accessLog: null, ...o });
const assertInvalid = (j, label) => {
  assert.equal(j.verdict, 'invalid', `${label}: ${JSON.stringify(j)}`);
  assert.equal(j.valid, false, `${label}: valid`);
  assert.ok(typeof j.invalid_reason === 'string' && j.invalid_reason.length > 0, `${label}: invalid_reason`);
};

// ===================== U1 =====================

test('V-T43 스윕 단계 목록: 동시 × 보류 × 되풀이로 펼치고 연결 same은 동시와 같다', () => {
  const a = parseGwArgs(['sweep', '--max-parallel', '3,7', '--max-pending', '1,3']);
  assert.deepEqual(
    a.steps.map((s) => [s.maxParallelRequests, s.maxPendingRequests, s.maxConnections, s.repeat]),
    [
      [3, 1, 3, 1],
      [3, 3, 3, 1],
      [7, 1, 7, 1],
      [7, 3, 7, 1],
    ],
  );
  assert.deepEqual(a.steps.map((s) => s.index), [0, 1, 2, 3]);
  const c = parseGwArgs(['sweep', '--max-parallel', '3,7', '--max-pending', '2', '--max-connections', '9', '--repeat', '2']);
  assert.deepEqual(
    c.steps.map((s) => [s.maxParallelRequests, s.maxPendingRequests, s.maxConnections, s.repeat]),
    [
      [3, 2, 9, 1],
      [3, 2, 9, 2],
      [7, 2, 9, 1],
      [7, 2, 9, 2],
    ],
  );
  // 경계: 보류 = 동시는 받는다
  assert.deepEqual(parseGwArgs(['sweep', '--max-parallel', '5', '--max-pending', '5']).steps.map((s) => [s.maxParallelRequests, s.maxPendingRequests]), [[5, 5]]);
  // 보류를 주지 않으면 기본 1024(동시보다 커도 막지 않는다, 시험 이의 (가))
  const d = parseGwArgs(['sweep', '--max-parallel', '4']);
  assert.equal(d.pendingDefault, true);
  assert.deepEqual(d.steps.map((s) => s.maxPendingRequests), [1024]);
});

test('V-T43 스윕 단계 목록: 0·음수·소수·빈 목록·빈 값·보류 > 동시·동시 없음은 인자 오류(UsageError)', () => {
  const bad = [
    ['--max-parallel', '0'],
    ['--max-parallel', '-1'],
    ['--max-parallel', '1.5'],
    ['--max-parallel', ''],
    ['--max-parallel', '3,,7'],
    ['--max-parallel', '3,'],
    ['--max-parallel', '4', '--max-pending', '0'],
    ['--max-parallel', '4', '--max-pending', '2.5'],
    ['--max-parallel', '4', '--max-pending', '5'], // 보류 > 동시(경계 + 1)
    ['--max-parallel', '8,4', '--max-pending', '6'], // 목록 가운데 하나만 보류 > 동시
    ['--max-parallel', '4', '--max-connections', '0'],
    ['--max-pending', '2'], // 동시 없음
  ];
  for (const args of bad) assert.throws(() => parseGwArgs(['sweep', ...args]), (e) => e instanceof UsageError, `gw sweep ${args.join(' ')}`);
  // 펼치기 함수에 직접 빈 목록
  assert.throws(() => expandSweepSteps({ maxParallel: [], maxPending: [1], maxConnections: 'same', repeat: 1, rate: 1, delay: { kind: 'normal' }, mix: 'normal' }), (e) => e instanceof UsageError);
  assert.throws(() => expandSweepSteps({ maxParallel: [4], maxPending: [], maxConnections: 'same', repeat: 1, rate: 1, delay: { kind: 'normal' }, mix: 'normal' }), (e) => e instanceof UsageError);
});

test('V-T43 스윕 단계 목록: 실행 도구는 인자 오류에 끝 코드 2로 클러스터를 건드리기 전에 끝난다', () => {
  for (const args of [
    ['--max-parallel', '0'],
    ['--max-parallel', '4', '--max-pending', '5'],
  ]) {
    const r = spawnSync(process.execPath, [RUN_MJS, 'gw', 'sweep', ...args], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, PEAKET_KUBECONFIG: join(HERE, 'no-such-kubeconfig') } });
    assert.equal(r.status, 2, `gw sweep ${args.join(' ')}: 끝 코드 ${r.status} ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /==/, `gw sweep ${args.join(' ')}: 단계를 시작했다 ${r.stdout}`);
  }
});

// ===================== U2 =====================

test('V-T43 임시 정책은 라우트 하나·StrategicMerge·circuitBreaker만', () => {
  const p = sweepPolicy({ route: ROUTE, maxConnections: 5, maxParallelRequests: 5, maxPendingRequests: 2 });
  assert.equal(p.apiVersion, 'gateway.envoyproxy.io/v1alpha1');
  assert.equal(p.kind, 'BackendTrafficPolicy');
  assert.equal(p.metadata.name, `peaket-sweep-${ROUTE}`);
  assert.equal(p.metadata.namespace, NS);
  assert.deepEqual(p.metadata.labels, { [SWEEP_LABEL]: 'true' });
  assert.deepEqual(Object.keys(p.spec).sort(), ['circuitBreaker', 'mergeType', 'targetRefs'], '다른 칸(retry·rateLimit·responseOverride·targetRef·targetSelectors)이 없다');
  assert.deepEqual(p.spec.targetRefs, [{ group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: ROUTE }], '대상은 그 HTTPRoute 하나(규칙·게이트웨이가 아님)');
  assert.equal(p.spec.mergeType, 'StrategicMerge');
  assert.deepEqual(p.spec.circuitBreaker, { maxConnections: 5, maxParallelRequests: 5, maxPendingRequests: 2 });
  for (const bad of [0, -1, 1.5, undefined]) assert.throws(() => sweepPolicy({ route: ROUTE, maxConnections: 5, maxParallelRequests: bad, maxPendingRequests: 2 }), `동시 ${bad}`);
});

// ===================== U3 =====================

test('V-T43 Envoy 통계에서 그 규칙 묶음만 읽는다', () => {
  const s = parseClusterStats(statsText(CLUSTER, { upstream_rq_active: 7, upstream_rq_pending_active: 2, upstream_rq_pending_overflow: 5, upstream_cx_overflow: 3, upstream_rq_retry_overflow: 6, upstream_cx_pool_overflow: 4 }), CLUSTER);
  assert.equal(s.rqActive, 7);
  assert.equal(s.rqPendingActive, 2);
  // *_overflow 카운터 전부(이름이 비슷한 묶음의 9999가 섞이지 않는다)
  assert.deepEqual(s.overflow, { upstream_rq_pending_overflow: 5, upstream_cx_overflow: 3, upstream_rq_retry_overflow: 6, upstream_cx_pool_overflow: 4 });
  // 값이 없으면 0이 아니라 오류
  assert.throws(() => parseClusterStats(statsText(`${CLUSTER}0`), CLUSTER), '그 묶음 줄이 없다');
  assert.throws(() => parseClusterStats(statsText(CLUSTER, { upstream_rq_active: undefined }), CLUSTER), 'upstream_rq_active가 없다');
  assert.throws(() => parseClusterStats(statsText(CLUSTER, { upstream_rq_pending_active: undefined }), CLUSTER), 'upstream_rq_pending_active가 없다');
  assert.throws(() => parseClusterStats(statsText(CLUSTER, { upstream_rq_pending_overflow: undefined }), CLUSTER), 'upstream_rq_pending_overflow가 없다');
  assert.throws(() => parseClusterStats('', CLUSTER), '빈 글');

  // 관리 포트 /clusters: 그 묶음의 기본 우선순위 줄만
  const l = parseClusterLimits(clustersText(CLUSTER, { maxConnections: 7, maxPendingRequests: 2, maxRequests: 7, maxRetries: 3 }), CLUSTER);
  assert.deepEqual(l, { maxConnections: 7, maxPendingRequests: 2, maxRequests: 7, maxRetries: 3 });
  assert.equal(limitsLoaded(l, STEP), true);
  assert.equal(limitsLoaded({ ...l, maxPendingRequests: 1024 }, STEP), false, '보류만 옛 값');
  assert.equal(limitsLoaded({ ...l, maxConnections: 1024 }, STEP), false, '연결만 옛 값');
  assert.equal(limitsLoaded({ ...l, maxRequests: 1024 }, STEP), false, '동시만 옛 값');
  assert.throws(() => parseClusterLimits(clustersText(`${CLUSTER}0`, { maxConnections: 7, maxPendingRequests: 2, maxRequests: 7 }), CLUSTER), '그 묶음이 없다');
  assert.throws(() => parseClusterLimits(clustersText(CLUSTER, { maxConnections: 7, maxRequests: 7 }), CLUSTER), '보류 줄이 없다');

  // 통계 창: 본구간 앞뒤 표본이 없으면 오류(통계를 못 읽음 = 무효)
  const pod = (rqActive, ov) => ({ p1: { overflow: { upstream_rq_pending_overflow: ov, upstream_cx_overflow: 0 }, rqActive, rqPendingActive: 0 } });
  const w = statsWindow(
    [
      { atMs: 100, pods: pod(1, 10) },
      { atMs: 200, pods: pod(9, 12) },
      { atMs: 400, pods: pod(2, 15) },
    ],
    150,
    300,
  );
  assert.equal(w.overflowTotal, 5, '넘침은 앞뒤 표본의 차이');
  assert.equal(w.rqActiveMax, 9);
  assert.throws(() => statsWindow([{ atMs: 200, pods: pod(1, 0) }, { atMs: 400, pods: pod(1, 0) }], 150, 300), '시작 전 표본 없음');
  assert.throws(() => statsWindow([{ atMs: 100, pods: pod(1, 0) }, { atMs: 200, pods: pod(1, 0) }], 150, 300), '끝난 뒤 표본 없음');
  assert.throws(() => statsWindow([], 150, 300), '표본 없음');
});

// ===================== U4 =====================

test('V-T43 ①② 단계 판정: 정상 부하는 503 0건·넘침 0이면 통과, 503 1건·넘침 1이면 실패', () => {
  const ok = judge();
  assert.equal(ok.item, 'V-T43 ①');
  assert.equal(ok.verdict, 'pass', JSON.stringify(ok));
  assert.equal(ok.valid, true);
  const one = judge({ m: M({ n503: 1 }) });
  assert.equal(one.verdict, 'fail', '정상 부하에서 503 1건');
  assert.equal(one.valid, true);
  const ov = judge({ stats: { ...STATS, overflow: { upstream_rq_pending_overflow: 1, upstream_cx_overflow: 0 }, overflowTotal: 1 } });
  assert.equal(ov.verdict, 'fail', '발생기는 503 0건이어도 Envoy 넘침 1');
});

test('V-T43 ①② 단계 판정: 과부하의 503 p99는 3.0ms 통과·3.01ms 실패(정본 3ms, 경계 양쪽)', () => {
  const over = (p99, extra = {}) => judge({ overload: true, m: M({ n503: 400, p99 }), ...extra });
  const at = over(FAST_FAIL_MS);
  assert.equal(at.item, 'V-T43 ②');
  assert.equal(at.verdict, 'pass', JSON.stringify(at));
  assert.equal(over(FAST_FAIL_MS + 0.01).verdict, 'fail');
  assert.equal(over(2.99).verdict, 'pass');
  // 503이 있는데 p99를 모르면 통과가 아니다
  assert.notEqual(over(null).verdict, 'pass');
  // 발생기 쪽만 3ms를 넘고 접근 로그는 안 넘으면 '측정 지점 의심'으로 무효(판정을 미룬다), 둘 다 넘으면 실패
  const suspect = over(3.5, { accessLog: { lines: 400, le: 398, ratio: 0.995, p99: 2 } });
  assertInvalid(suspect, '측정 지점 의심');
  assert.match(suspect.invalid_reason, /측정 지점/);
  assert.equal(over(3.5, { accessLog: { lines: 400, le: 10, ratio: 0.025, p99: 3.4 } }).verdict, 'fail');
});

test('V-T43 ①② 단계 판정: 503 하나라도 Retry-After가 없거나 숫자가 아니거나 Problem 본문이 틀리면 실패', () => {
  for (const [label, m] of [
    ['Retry-After 없음 1건(나머지 399건은 있음)', M({ n503: 400, raMissing: 1 })],
    ['Retry-After 숫자 아님 1건', M({ n503: 400, raNonnum: 1 })],
    ['Problem 본문 틀림 1건', M({ n503: 400, bad: 1 })],
  ]) {
    assert.equal(judge({ overload: true, m }).verdict, 'fail', `과부하 ${label}`);
    assert.equal(judge({ overload: false, m: { ...m } }).verdict, 'fail', `정상 부하 ${label}`);
  }
  // Retry-After를 본 수가 503 수보다 적으면(일부만 봄) 통과가 아니다
  const partial = M({ n503: 400 });
  partial.retryAfter['503'] = { num: 1, missing: 0, nonnum: 0 };
  assert.notEqual(judge({ overload: true, m: partial }).verdict, 'pass', 'Retry-After를 503 하나만 봄');
});

test('V-T43 ①② 단계 판정: 처리 중 최대가 동시 상한을 넘으면 실패(상한과 같으면 통과)', () => {
  assert.equal(judge({ stats: { ...STATS, rqActiveMax: STEP.maxParallelRequests } }).verdict, 'pass');
  assert.equal(judge({ stats: { ...STATS, rqActiveMax: STEP.maxParallelRequests + 1 } }).verdict, 'fail');
  assert.equal(judge({ overload: true, m: M({ n503: 400 }), stats: { ...STATS, rqActiveMax: STEP.maxParallelRequests + 1 } }).verdict, 'fail');
});

test("V-T43 ①② 단계 판정: 보낸 수 0·통계 못 읽음·dropped_iterations ≥ 1·발생기 무효·과부하의 503 0건·상한이 실리지 않음은 '통과'가 아니라 무효", () => {
  assertInvalid(judge({ m: M({ sent: 0, n2xx: 0 }) }), '보낸 수 0');
  assertInvalid(judge({ m: null }), '요약 없음');
  assertInvalid(judge({ stats: null, statsError: '본구간 시작 전 통계 표본이 없다' }), '통계 못 읽음');
  assertInvalid(judge({ stats: null }), '통계 없음');
  assertInvalid(judge({ generator: { ...GEN, dropped: 1 } }), 'dropped_iterations 1');
  assertInvalid(judge({ generator: { ...GEN, dropped: undefined } }), 'dropped_iterations 모름');
  assertInvalid(judge({ generator: { valid: false, reasons: ['CPU 90% 넘음'], dropped: 0 } }), '발생기 무효');
  assertInvalid(judge({ overload: true, m: M({ n503: 0 }) }), '과부하인데 503 0건');
  const notLoaded = judgeSweepStep({ step: STEP, overload: false, limitsLoaded: false });
  assertInvalid(notLoaded, '상한이 실리지 않음');
  assert.equal(notLoaded.invalid_reason, '상한이 실리지 않음');
});

// ===================== U5 =====================

// 정본 docs/perf-ledger.md §2.2 checks(추천 적용, 2026-11-18, BAT-056 R1): '0건' 목표(정상 부하 503, 503의 Retry-After·Problem 빠짐)는 checks에 넣지 않고
// 판정(--verdict)·notes로 넘긴다. checks는 과부하의 '503 응답 시간 p99 ≤ 3ms'(allowed 0.01, 시행 수 = 503 수) 하나이고, 시행 수 0인 점검은 만들지 않는다
test('V-T43 R1 성능 장부 checks: 과부하의 503 p99 3ms 점검 하나만(allowed 0.01·시행 수 503 수), 0건 목표와 시행 수 0 점검은 없다', () => {
  const pick = (r) => r.checks.map(({ name, allowed, trials, violations }) => ({ name, allowed, trials, violations }));
  assert.deepEqual(pick(sweepChecks('entry', false, M({ sent: 1234 }))), [], '정상 부하 503 0건');
  assert.deepEqual(pick(sweepChecks('entry', false, M({ sent: 1234, n503: 2, raMissing: 1 }))), [], '정상 부하 503 2건(판정은 fail, 점검은 없음)');
  assert.deepEqual(pick(sweepChecks('entry', true, M({ sent: 900, n503: 500, overFast: 6, raNonnum: 2, bad: 3 }))), [{ name: `entry_503_p99_${FAST_FAIL_MS}ms`, allowed: 0.01, trials: 500, violations: 6 }]);
  assert.deepEqual(pick(sweepChecks('entry', true, M({ sent: 900, n503: 0 }))), [], '과부하 503 0건(시행 수 0 점검을 만들지 않는다)');
  for (const c of sweepChecks('entry', true, M({ sent: 900, n503: 500 })).checks) {
    assert.ok(c.allowed > 0 && c.allowed < 1, `${c.name}: allowed ${c.allowed}(장부 도구는 0과 1 사이만 받는다)`);
    assert.ok(c.trials >= 1, `${c.name}: 시행 수 ${c.trials}`);
    assert.ok(typeof c.target === 'string' && c.target.length > 0, `${c.name}: target`);
  }
});

// ===================== U6 =====================

test('SR-T13 ② IP 한도 측정 판정: 통과 수 상한 50 × (본구간 초 + 1) × 복제 수, 429 모두 Retry-After, 여러 IP 정상 경우의 429 1건이면 실패', () => {
  const mainS = 30;
  const cap1 = SEARCH_PER_IP * (mainS + 1) * 1; // 1,550
  const cap2 = SEARCH_PER_IP * (mainS + 1) * 2; // 3,100
  const single = (n2xx, replicas, extra = {}) => judgeIpLimit({ case: 'single', mainS, replicas, streams: { one: M({ sent: 4500, n2xx, n429: 4500 - n2xx, ...extra }) }, generator: GEN });
  assert.equal(single(cap1, 1).verdict, 'pass');
  assert.equal(single(cap1 + 1, 1).verdict, 'fail', '복제 1의 상한 + 1');
  // 복제 2면 상한이 두 배(복제 수를 곱하지 않는 결함을 잡는다)
  assert.equal(single(cap2, 2).verdict, 'pass', '복제 2의 상한');
  assert.equal(single(cap2 + 1, 2).verdict, 'fail', '복제 2의 상한 + 1');
  assert.equal(single(cap1, 1, { ra429Missing: 1 }).verdict, 'fail', '429 하나에 Retry-After 없음');
  // mixed도 한 IP 흐름으로 판정한다
  assert.equal(judgeIpLimit({ case: 'mixed', mainS, replicas: 1, streams: { pool: M({ sent: 30000 }), one: M({ sent: 4500, n2xx: cap1 + 1, n429: 4500 - cap1 - 1 }) }, generator: GEN }).verdict, 'fail');
  // 서로 다른 IP가 한도 아래: 429 0건이면 통과, 1건이면 실패
  assert.equal(judgeIpLimit({ case: 'many', mainS, replicas: 1, streams: { many: M({ sent: 30000 }) }, generator: GEN }).verdict, 'pass');
  assert.equal(judgeIpLimit({ case: 'many', mainS, replicas: 1, streams: { many: M({ sent: 30000, n429: 1 }) }, generator: GEN }).verdict, 'fail');
  // 빈 결과가 통과로 새지 않는다
  assertInvalid(judgeIpLimit({ case: 'single', mainS, replicas: 1, streams: { one: M({ sent: 0, n2xx: 0 }) }, generator: GEN }), '보낸 수 0');
  assertInvalid(judgeIpLimit({ case: 'single', mainS, replicas: 1, streams: { one: M({ sent: 4500, n2xx: 4500, n429: 0 }) }, generator: GEN }), '한도를 넘겨 보냈는데 429 0건');
  assertInvalid(judgeIpLimit({ case: 'single', mainS, replicas: 1, streams: {}, generator: GEN }), '흐름 없음');
  assertInvalid(judgeIpLimit({ case: 'single', mainS, replicas: 1, streams: { one: M({ sent: 4500, n2xx: cap1, n429: 4500 - cap1 }) }, generator: { ...GEN, dropped: 1 } }), 'dropped 1');
  assertInvalid(judgeIpLimit({ case: 'many', mainS, replicas: undefined, streams: { many: M({ sent: 30000 }) }, generator: GEN }), '복제 수 모름');
});

// ===================== 가짜 클러스터(U7·U8·부르는 쪽) =====================

/** 흐름 하나의 k6 지표(loadtest/scenarios/gw.js의 지표 이름과 꼬리표 {phase:main,stream,cls,…}) */
function streamMetricsOf(stream, { sent = 1000, n503 = 0, n429 = 0, other = 0, p99 = 1.1, raMissing = 0, ra429Missing = 0, overFast = 0, bad = 0 } = {}) {
  const k = (name, extra = '') => `${name}{phase:main,stream:${stream}${extra}}`;
  const cnt = (n) => ({ type: 'counter', values: { count: n, rate: n / 5 } });
  const trend = (p) => ({ type: 'trend', values: { med: p, 'p(99)': p, max: p, avg: p, min: p } });
  return {
    [k('gw_reqs', ',cls:2xx')]: cnt(sent - n503 - n429 - other),
    [k('gw_reqs', ',cls:503')]: cnt(n503),
    [k('gw_reqs', ',cls:429')]: cnt(n429),
    [k('gw_reqs', ',cls:other')]: cnt(other),
    [k('gw_dur_2xx')]: trend(6),
    ...(n503 ? { [k('gw_dur_503')]: trend(p99) } : {}),
    ...(n429 ? { [k('gw_dur_429')]: trend(p99) } : {}),
    [k('gw_over_fast')]: cnt(overFast),
    [k('gw_ra', ',cls:503,ra:num')]: cnt(n503 - raMissing),
    [k('gw_ra', ',cls:503,ra:missing')]: cnt(raMissing),
    [k('gw_ra', ',cls:503,ra:nonnum')]: cnt(0),
    [k('gw_problem', ',cls:503,ok:yes')]: cnt(n503 - bad),
    [k('gw_problem', ',cls:503,ok:no')]: cnt(bad),
    [k('gw_ra', ',cls:429,ra:num')]: cnt(n429 - ra429Missing),
    [k('gw_ra', ',cls:429,ra:missing')]: cnt(ra429Missing),
    [k('gw_ra', ',cls:429,ra:nonnum')]: cnt(0),
    [k('gw_problem', ',cls:429,ok:yes')]: cnt(n429),
    [k('gw_problem', ',cls:429,ok:no')]: cnt(0),
  };
}
/** k6 요약 꼴(흐름 여럿 + k6 기본 지표. 성능 장부 collect.py가 읽는 http_req_duration·dropped_iterations 포함) */
function summaryMulti(streams) {
  const total = Object.values(streams).reduce((a, x) => a + (x.sent ?? 1000), 0);
  return {
    metrics: {
      http_reqs: { type: 'counter', values: { count: total, rate: total / 5 } },
      http_req_duration: { type: 'trend', values: { avg: 6, min: 1, med: 5, max: 100, 'p(90)': 8, 'p(95)': 9, 'p(99)': 20 } },
      http_req_failed: { type: 'rate', values: { rate: 0, passes: 0, fails: total } },
      dropped_iterations: { type: 'counter', values: { count: 0, rate: 0 } },
      ...Object.assign({}, ...Object.entries(streams).map(([n, x]) => streamMetricsOf(n, x))),
    },
  };
}
/** 정상 부하 꼴(--mix normal): 재는 흐름 하나에 opts, 나머지 진입·홀드·결제 접수는 503 없이 */
function summaryFor(stream, opts = {}) {
  const base = { entry: { sent: 1000 }, hold: { sent: 10 }, pay: { sent: 2 } };
  return summaryMulti(stream in base ? { ...base, [stream]: { sent: 1000, ...opts } } : { [stream]: { sent: 1000, ...opts } });
}

/** RFC 7386 병합 패치 */
function mergePatch(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = target !== null && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}
const EP_RESOURCES = new Set(['envoyproxy', 'envoyproxies', 'envoyproxies.gateway.envoyproxy.io', 'envoyproxy.gateway.envoyproxy.io']);
/** 게이트웨이의 EnvoyProxy(gw-queue는 자기 것, 나머지 넷은 함께 쓰는 peaket-proxy) */
const EP_OF = (gw) => (gw === 'gw-queue' ? 'gw-queue-proxy' : 'peaket-proxy');

/**
 * 가짜 deps. o: { pods, admin(pod, polls) → /clusters 글, load(call, deps) → runLoad 결과, stats(pod) → 통계 글, envoyProxy(gw-queue-proxy의 객체),
 * envoyProxies({ 이름: 객체 }), failAfterBind(CPU를 묶은 뒤 EnvoyProxy 고치기를 실패시켜 강제 종료를 흉내), routeObjs({ 이름: HTTPRoute }), cluster(기본 묶음 이름) }
 * calls에 kubectl 명령을 차례로 남기고, EnvoyProxy는 메모리 상태(eps)에 병합 패치·JSON 패치·주석을 실제로 적용한다
 */
function fakeDeps(o = {}) {
  let t = 1_763_000_000_000;
  const pods = o.pods ?? ['envoy-gw-queue-a'];
  const cluster = o.cluster ?? CLUSTER;
  const calls = [];
  const saved = {};
  const records = [];
  const loads = [];
  const logs = [];
  const cleanups = [];
  const polls = {};
  const eps = structuredClone(o.envoyProxies ?? { 'gw-queue-proxy': o.envoyProxy ?? { spec: {} }, 'peaket-proxy': { spec: {} } });
  for (const [n, e] of Object.entries(eps)) e.metadata = { ...(e.metadata ?? {}), name: n, namespace: NS };
  const state = { bound: false, allowRestore: false };
  const routeObjs = o.routeObjs ?? { [ROUTE]: ROUTE_OBJ };
  const nameAfter = (args, i) => (args[i + 1] !== undefined && !args[i + 1].startsWith('-') ? args[i + 1] : undefined);
  const epCall = (args) => {
    const i = args.findIndex((x) => EP_RESOURCES.has(x));
    return i < 0 ? null : { i, name: nameAfter(args, i) };
  };
  const getEp = (name) => {
    if (!eps[name]) throw new Error(`없는 EnvoyProxy ${name}`);
    return eps[name];
  };
  const deps = {
    kubectl: async (args, opt = {}) => {
      calls.push({ args: [...args], input: opt.input });
      const s = args.join(' ');
      if (args.includes('--raw') && s.includes('/stats/prometheus')) {
        const pod = /pods\/([^:/]+):/.exec(s)?.[1];
        return o.stats ? o.stats(pod) : statsText(cluster);
      }
      if (args.includes('--raw')) throw new Error(`모르는 --raw ${s}`);
      if (s.includes('get backendtrafficpolicies')) return JSON.stringify({ items: o.policies ?? [] });
      if (s.includes('get pods')) return JSON.stringify({ items: pods.map((n) => ({ metadata: { name: n }, status: { phase: 'Running' } })) });
      if (s.includes('get svc')) return '10.96.0.10';
      if (args[0] === 'apply') return 'backendtrafficpolicy.gateway.envoyproxy.io/x configured';
      const ep = epCall(args);
      if (ep && (args.includes('patch') || args.includes('annotate'))) {
        if (o.failAfterBind && state.bound && !state.allowRestore) throw new Error('강제 종료 흉내(가짜): EnvoyProxy를 고치지 못함');
        const obj = getEp(ep.name);
        if (args.includes('patch')) {
          const raw = args[args.indexOf('-p') + 1];
          const type = args.includes('--type') ? args[args.indexOf('--type') + 1] : 'strategic';
          if (type === 'json') {
            for (const op of JSON.parse(raw)) {
              const keys = op.path.split('/').slice(1).map((x) => x.replaceAll('~1', '/').replaceAll('~0', '~'));
              let cur = obj;
              for (const key of keys.slice(0, -1)) cur = cur[key] ??= {};
              if (op.op === 'remove') delete cur[keys.at(-1)];
              else cur[keys.at(-1)] = op.value;
            }
          } else eps[ep.name] = mergePatch(obj, JSON.parse(raw));
          if (/"concurrency":1\b/.test(raw)) state.bound = true;
        } else {
          for (const kv of args.slice(ep.i + 2).filter((x) => !x.startsWith('-'))) {
            obj.metadata.annotations ??= {};
            if (kv.endsWith('-') && !kv.includes('=')) delete obj.metadata.annotations[kv.slice(0, -1)];
            else obj.metadata.annotations[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1);
          }
        }
        return 'patched';
      }
      if (ep && args.includes('get')) return JSON.stringify(ep.name ? getEp(ep.name) : { items: Object.values(eps) });
      if (args.includes('delete')) return 'deleted';
      if (s.includes('get gateway')) {
        const gw = nameAfter(args, args.indexOf('gateway'));
        return JSON.stringify({ metadata: { name: gw }, spec: { infrastructure: { parametersRef: { group: 'gateway.envoyproxy.io', kind: 'EnvoyProxy', name: EP_OF(gw) } } } });
      }
      if (s.includes('get deploy')) return 'envoy-gw-queue-abc';
      if (args.includes('rollout')) return 'rolled out';
      throw new Error(`모르는 kubectl ${s}`);
    },
    readAdmin: async (pod, path) => {
      assert.equal(path, '/clusters');
      polls[pod] = (polls[pod] ?? 0) + 1;
      return o.admin ? o.admin(pod, polls[pod]) : clustersText(cluster, { maxConnections: 7, maxPendingRequests: 2, maxRequests: 7 });
    },
    routeObject: (route) => {
      assert.ok(routeObjs[route], `시험에 없는 라우트 ${route}`);
      return structuredClone(routeObjs[route]);
    },
    runLoad: async (args) => {
      loads.push(args);
      const start = t;
      t += 8_000;
      const r = o.load ? await o.load(args, deps, loads.length) : { summary: summaryFor('entry'), generator: GEN };
      return { retryAfterValues: {}, marks: { main_start: start + 1_000, main_end: start + 7_000 }, ...r };
    },
    readAccessLog: async () => [],
    proxyCpuNs: async (ps) => Object.fromEntries(ps.map((p) => [p, t * 1e3])),
    record: async (r) => records.push(r),
    save: (name, v) => (saved[name] = structuredClone(v)),
    sleep: async (ms) => {
      t += ms;
      await new Promise((r) => setImmediate(r));
    },
    now: () => t,
    log: (m) => logs.push(m),
    onCleanup: (fn) => cleanups.push(fn),
    offCleanup: () => {},
    inputBase: { origin: 'https://www.peaket.example', originVerify: 'v', hostNames: { queue: 'queue.peaket.example', api: 'api.peaket.example' }, eventId: 'e-1' },
    ...(o.signal ? { signal: o.signal } : {}),
  };
  return { deps, calls, saved, records, loads, logs, cleanups, polls, eps, state };
}
/** 정상 부하 단계: 초당 300 × 평균 지연 7.3ms(정본 분포) ≈ 동시 2.2 < 동시 7 + 보류 2 */
const SWEEP_ARGS = ['sweep', '--max-parallel', '7', '--max-pending', '2', '--rate', '300', '--warm', '1', '--main', '5'];
const isSweepDelete = (c) => {
  const a = c.args;
  const l = a.indexOf('-l');
  return a.includes('delete') && a.includes('backendtrafficpolicies') && l >= 0 && a[l + 1] === `${SWEEP_LABEL}=true` && a.includes(NS);
};
const lastIndex = (calls, pred) => calls.reduce((acc, c, i) => (pred(c) ? i : acc), -1);
const applyIdx = (calls) => lastIndex(calls, (c) => c.args[0] === 'apply');
/** 지우기 명령이 마지막 적용 뒤에 나갔는가 */
function assertDeletedAfterApply(calls, label) {
  const ap = applyIdx(calls);
  assert.ok(ap >= 0, `${label}: 임시 정책을 적용하지 않았다`);
  const del = lastIndex(calls, isSweepDelete);
  assert.ok(del > ap, `${label}: 마지막 적용(${ap}) 뒤에 이름표 ${SWEEP_LABEL}=true로 지우는 명령이 없다(${del}) ${JSON.stringify(calls.map((c) => c.args.join(' ')))}`);
}

// ===================== U7 =====================

test('V-T43 스윕은 끝날 때 임시 정책과 CPU 묶음을 되돌린다: 정상 끝', async () => {
  const f = fakeDeps();
  const r = await runGw(parseGwArgs(SWEEP_ARGS), f.deps);
  assert.equal(r.exitCode, 0);
  assertDeletedAfterApply(f.calls, '정상 끝');
  // 적용한 임시 정책은 그 단계 값의 라우트 하나 정책이다(부르는 쪽이 sweepPolicy 꼴을 그대로 쓴다)
  const applied = JSON.parse(f.calls[applyIdx(f.calls)].input);
  assert.deepEqual(applied.spec.targetRefs.map((t) => [t.kind, t.name, t.sectionName]), [['HTTPRoute', ROUTE, undefined]]);
  assert.equal(applied.spec.mergeType, 'StrategicMerge');
  assert.deepEqual(applied.metadata.labels, { [SWEEP_LABEL]: 'true' });
  assert.deepEqual(applied.spec.circuitBreaker, { maxConnections: 7, maxParallelRequests: 7, maxPendingRequests: 2 });
});

test('V-T43 스윕은 끝날 때 임시 정책과 CPU 묶음을 되돌린다: 오류', async () => {
  const f = fakeDeps({
    load: async () => {
      throw new Error('k6가 못 돎(가짜)');
    },
  });
  await assert.rejects(runGw(parseGwArgs(SWEEP_ARGS), f.deps), /k6가 못 돎/);
  assertDeletedAfterApply(f.calls, '오류');
});

test('V-T43 스윕은 끝날 때 임시 정책과 CPU 묶음을 되돌린다: 신호(멈춤 끝 코드, 실행 도구에 맡긴 정리)', async () => {
  // 부하 도중 신호: 멈춤 이유의 끝 코드를 돌려주고 정리한다
  const ctrl = new AbortController();
  const f = fakeDeps({
    signal: ctrl.signal,
    load: async () => {
      ctrl.abort({ exitCode: 143 });
      return { summary: summaryFor('entry'), generator: GEN };
    },
  });
  const r = await runGw(parseGwArgs(['sweep', '--max-parallel', '7,9', '--max-pending', '2', '--warm', '1', '--main', '5']), f.deps);
  assert.equal(r.exitCode, 143);
  assert.equal(f.loads.length, 1, '신호 뒤 다음 단계 부하를 넣었다');
  assertDeletedAfterApply(f.calls, '신호');
  // 이유에 끝 코드가 없으면 130
  const ctrl2 = new AbortController();
  const g = fakeDeps({
    signal: ctrl2.signal,
    load: async () => {
      ctrl2.abort();
      return { summary: summaryFor('entry'), generator: GEN };
    },
  });
  assert.equal((await runGw(parseGwArgs(SWEEP_ARGS), g.deps)).exitCode, 130);
  assertDeletedAfterApply(g.calls, '신호(끝 코드 없음)');
  // 실행 도구의 신호 처리기가 돌리는 정리(onCleanup으로 맡긴 함수)만으로도 지운다(부하 도중 그 함수를 부름)
  const h = fakeDeps({
    load: async (_a, deps) => {
      assert.equal(h.cleanups.length, 1, '정리를 실행 도구에 맡기지 않았다(onCleanup)');
      const before = h.calls.length;
      await h.cleanups[0]();
      assert.ok(h.calls.slice(before).some(isSweepDelete), '맡긴 정리가 임시 정책을 지우지 않는다');
      return { summary: summaryFor('entry'), generator: GEN };
    },
  });
  await runGw(parseGwArgs(SWEEP_ARGS), h.deps);
});

test('V-T43 스윕은 끝날 때 임시 정책과 CPU 묶음을 되돌린다: capacity의 CPU 묶음(정상·오류·신호)', async () => {
  const original = {
    metadata: { name: 'gw-queue-proxy' },
    spec: { concurrency: 3, provider: { type: 'Kubernetes', kubernetes: { envoyDeployment: { container: { resources: { requests: { cpu: '250m' }, limits: { cpu: '1' } } } } } } },
  };
  const CAP_ARGS = ['capacity', '--rates', '500,700', '--warm', '1', '--main', '5'];
  const patches = (calls) => calls.filter((c) => c.args.includes('patch') && c.args.includes('envoyproxy')).map((c) => JSON.parse(c.args[c.args.indexOf('-p') + 1]));
  const assertRestored = (calls, label) => {
    const ps = patches(calls);
    assert.ok(ps.length >= 2, `${label}: 묶기·되돌리기 패치가 둘이 아니다(${ps.length})`);
    const restore = ps[ps.length - 1];
    assert.equal(restore.spec.concurrency, 3, `${label}: 일꾼 수를 원래 값으로 되돌리지 않았다 ${JSON.stringify(restore)}`);
    const res = restore.spec.provider.kubernetes.envoyDeployment.container.resources;
    assert.deepEqual([res.requests?.cpu, res.limits?.cpu], ['250m', '1'], `${label}: CPU를 원래 값으로 되돌리지 않았다 ${JSON.stringify(res)}`);
    // 묶기 패치는 0.5 CPU(500m)로 묶었다
    const bind = ps[0].spec.provider.kubernetes.envoyDeployment.container.resources;
    assert.deepEqual([bind.requests?.cpu, bind.limits?.cpu], ['500m', '500m'], `${label}: 묶기 패치`);
  };
  const capSummary = () => summaryFor('entry', { sent: 2500 });
  const ok = fakeDeps({ envoyProxy: original, load: async () => ({ summary: capSummary(), generator: GEN }) });
  assert.equal((await runGw(parseGwArgs(CAP_ARGS), ok.deps)).exitCode, 0);
  assertRestored(ok.calls, '정상 끝');
  const err = fakeDeps({
    envoyProxy: original,
    load: async () => {
      throw new Error('k6가 못 돎(가짜)');
    },
  });
  await assert.rejects(runGw(parseGwArgs(CAP_ARGS), err.deps), /k6가 못 돎/);
  assertRestored(err.calls, '오류');
  const ctrl = new AbortController();
  const sig = fakeDeps({
    envoyProxy: original,
    signal: ctrl.signal,
    load: async () => {
      ctrl.abort({ exitCode: 130 });
      return { summary: capSummary(), generator: GEN };
    },
  });
  assert.equal((await runGw(parseGwArgs(CAP_ARGS), sig.deps)).exitCode, 130);
  assertRestored(sig.calls, '신호');
});

// ===================== U8 =====================

test('V-T43 새 상한이 /clusters에 보이기 전에는 단계를 시작하지 않는다', async () => {
  // 옛 값(1024)을 계속 준다: 부하를 넣지 않고 무효('상한이 실리지 않음'), 실행은 끝 코드 0으로 결과를 쓴다
  const old = clustersText(CLUSTER, { maxConnections: 1024, maxPendingRequests: 1024, maxRequests: 1024 });
  const f = fakeDeps({ admin: () => old });
  const r = await runGw(parseGwArgs(SWEEP_ARGS), f.deps);
  assert.equal(r.exitCode, 0);
  assert.equal(f.loads.length, 0, '상한이 실리지 않았는데 부하를 넣었다');
  const step = f.saved['sweep.json']?.steps?.[0];
  assert.ok(step, `결과 파일에 단계가 없다 ${JSON.stringify(f.saved)}`);
  assert.equal(step.verdict, 'invalid');
  assert.equal(step.valid, false);
  assert.equal(step.invalid_reason, '상한이 실리지 않음');
  assert.ok(f.polls['envoy-gw-queue-a'] > 1, '기다리며 다시 읽지 않았다');
  assertDeletedAfterApply(f.calls, '상한이 실리지 않음');

  // 파드 둘 가운데 하나만 새 값이어도 시작하지 않는다
  const two = fakeDeps({ pods: ['envoy-gw-queue-a', 'envoy-gw-queue-b'], admin: (pod) => (pod === 'envoy-gw-queue-b' ? old : clustersText(CLUSTER, { maxConnections: 7, maxPendingRequests: 2, maxRequests: 7 })) });
  await runGw(parseGwArgs(SWEEP_ARGS), two.deps);
  assert.equal(two.loads.length, 0, '파드 하나가 옛 값인데 부하를 넣었다');
  assert.equal(two.saved['sweep.json'].steps[0].invalid_reason, '상한이 실리지 않음');

  // 보류 칸만 옛 값이어도 시작하지 않는다
  const partial = fakeDeps({ admin: () => clustersText(CLUSTER, { maxConnections: 7, maxPendingRequests: 1024, maxRequests: 7 }) });
  await runGw(parseGwArgs(SWEEP_ARGS), partial.deps);
  assert.equal(partial.loads.length, 0, '보류가 옛 값인데 부하를 넣었다');

  // 세 번째 읽기에서 새 값이 보이면 그때 부하를 넣는다
  const late = fakeDeps({ admin: (_p, n) => (n < 3 ? old : clustersText(CLUSTER, { maxConnections: 7, maxPendingRequests: 2, maxRequests: 7 })) });
  await runGw(parseGwArgs(SWEEP_ARGS), late.deps);
  assert.equal(late.loads.length, 1);
  assert.equal(late.polls['envoy-gw-queue-a'], 3);
  // 관리 포트를 못 읽어도(오류) 실린 것으로 보지 않는다
  const broken = fakeDeps({
    admin: () => {
      throw new Error('포트 전달 끊김(가짜)');
    },
  });
  await runGw(parseGwArgs(SWEEP_ARGS), broken.deps);
  assert.equal(broken.loads.length, 0, '관리 포트를 못 읽었는데 부하를 넣었다');

  // waitLimits 직접: 시간이 넘으면 loaded false
  const w = fakeDeps({ admin: () => old });
  const res = await waitLimits(w.deps, ['envoy-gw-queue-a'], CLUSTER, STEP, { timeoutMs: 10_000, pollMs: 1_000 });
  assert.equal(res.loaded, false);
});

// ===================== 부르는 쪽이 판정을 쓰는지(U4·U5 바깥 경계) =====================

test('V-T43 ①② 스윕 결과 파일·성능 장부 기록은 단계 판정을 그대로 옮기고 무효를 통과로 남기지 않는다', async () => {
  const REC = [...SWEEP_ARGS, '--record', '--run-id-prefix', '2026-11-18-bat056t'];
  // 정상 부하 통과
  const pass = fakeDeps();
  assert.equal((await runGw(parseGwArgs(REC), pass.deps)).exitCode, 0);
  const ps = pass.saved['sweep.json'].steps[0];
  assert.deepEqual([ps.item, ps.verdict, ps.valid, ps.sent], ['V-T43 ①', 'pass', true, 1000]);
  assert.equal(pass.records.length, 1);
  assert.equal(pass.records[0].invalidReason, undefined);
  // 장부 scenario에 세 상한 값(V-T43 ② '고른 설정값은 성능 장부')
  assert.match(pass.records[0].scenario, /maxConnections=7\b/);
  assert.match(pass.records[0].scenario, /maxParallelRequests=7\b/);
  assert.match(pass.records[0].scenario, /maxPendingRequests=2\b/);

  // 정상 부하에서 503 1건: 실패로 옮긴다(장부의 판정은 아래 R1 시험이 실제 collect.py로 본다)
  const fail = fakeDeps({ load: async () => ({ summary: summaryFor('entry', { n503: 1 }), generator: GEN }) });
  assert.equal((await runGw(parseGwArgs(REC), fail.deps)).exitCode, 0, '판정이 실패여도 실행을 마치면 끝 코드 0');
  assert.equal(fail.saved['sweep.json'].steps[0].verdict, 'fail');

  // 발생기 dropped_iterations 2: 무효로 옮기고 장부에 무효 까닭
  const dropped = fakeDeps({ load: async () => ({ summary: summaryFor('entry'), generator: { ...GEN, dropped: 2 } }) });
  await runGw(parseGwArgs(REC), dropped.deps);
  const ds = dropped.saved['sweep.json'].steps[0];
  assert.deepEqual([ds.verdict, ds.valid], ['invalid', false]);
  assert.ok(ds.invalid_reason, 'invalid_reason이 비었다');
  assert.ok(dropped.records.length === 0 || (typeof dropped.records[0].invalidReason === 'string' && dropped.records[0].invalidReason.length > 0), '장부에 무효 까닭 없이 남겼다');

  // 보낸 수 0(요약은 있으나 0건): 무효
  const empty = fakeDeps({ load: async () => ({ summary: summaryFor('entry', { sent: 0 }), generator: GEN }) });
  await runGw(parseGwArgs(REC), empty.deps);
  assert.equal(empty.saved['sweep.json'].steps[0].verdict, 'invalid', '보낸 수 0');
  assert.ok(empty.records.every((x) => typeof x.invalidReason === 'string'), '보낸 수 0을 무효 까닭 없이 장부에 남겼다');

  // 통계에 그 묶음이 없음(통계를 못 읽음): 무효
  const nostats = fakeDeps({ stats: () => statsText(`${CLUSTER}0`) });
  await runGw(parseGwArgs(REC), nostats.deps);
  assert.equal(nostats.saved['sweep.json'].steps[0].verdict, 'invalid', '통계를 못 읽음');
  assert.ok(nostats.records.every((x) => typeof x.invalidReason === 'string'), '통계를 못 읽은 단계를 무효 까닭 없이 장부에 남겼다');

  // 과부하 단계(평균 동시 > 동시 + 보류)에서 503 0건: 무효
  const OVER = ['sweep', '--max-parallel', '7', '--max-pending', '2', '--delay', 'fixed:500', '--rate', '300', '--warm', '1', '--main', '5'];
  const over0 = fakeDeps();
  await runGw(parseGwArgs(OVER), over0.deps);
  const os = over0.saved['sweep.json'].steps[0];
  assert.deepEqual([os.item, os.verdict], ['V-T43 ②', 'invalid'], `과부하인데 503 0건 ${JSON.stringify(os)}`);
  // 과부하 단계의 503 p99 3.01ms: 실패
  const overSlow = fakeDeps({ load: async () => ({ summary: summaryFor('entry', { n503: 900, p99: FAST_FAIL_MS + 0.01, overFast: 900 }), generator: GEN }) });
  await runGw(parseGwArgs(OVER), overSlow.deps);
  assert.equal(overSlow.saved['sweep.json'].steps[0].verdict, 'fail');
  // 과부하 단계에서 503 하나에 Retry-After 없음: 실패
  const overRa = fakeDeps({ load: async () => ({ summary: summaryFor('entry', { n503: 900, p99: 1.5, raMissing: 1 }), generator: GEN }) });
  await runGw(parseGwArgs(OVER), overRa.deps);
  assert.equal(overRa.saved['sweep.json'].steps[0].verdict, 'fail');
});

test('V-T43 스윕은 재는 라우트를 이미 겨눈 운영 정책이 있으면 시작하지 않는다(임시 정책이 버려진다)', async () => {
  const f = fakeDeps({
    policies: [
      { metadata: { name: 'gw-queue-buy-extra' }, spec: { targetRefs: [{ group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: ROUTE }], circuitBreaker: { maxConnections: 1 } } },
    ],
  });
  await assert.rejects(runGw(parseGwArgs(SWEEP_ARGS), f.deps), /gw-queue-buy-extra/);
  assert.equal(f.loads.length, 0);
  assert.equal(applyIdx(f.calls), -1, '부딪히는 정책이 있는데 임시 정책을 적용했다');
});

// ===================== 리뷰 반영(R1·R2·R6·R7·R8, 계획 '리뷰 반영') =====================
// 정본: docs/perf-ledger.md §2.2 checks(R1), docs/infra.md §4.1 '측정(V-T43)'(R2·R6·R7·R8), docs/features/search.md SR-T13 ② '측정 판정'(R2).
// 리뷰 반영이 새로 내보낼 함수(시험이 기대는 공개 인터페이스, 계획 '리뷰 반영 실패 확인'에 적음):
//   gwCollectArgs(o, ctx) → { args, checks }   o는 runGw가 deps.record에 넘긴 값, ctx = { mainS, warmS, summaryFile, infraFile, checksFile, generator }.
//     args는 collect.py 인자(첫 원소 'tools/perf-ledger/collect.py'), checks는 ctx.checksFile에 쓸 점검 JSON(없으면 null이고 args에 --checks가 없다).
//     loadtest/run.mjs의 gw 장부 기록이 이 함수를 쓴다.
//   cleanupGw(deps) → Promise   node loadtest/run.mjs cleanup의 게이트웨이 몫(임시 정책 지우기, CPU 묶음 주석의 값으로 EnvoyProxy 되돌리기·주석 지우기). deps는 runGw의 꼴.

const REPO = join(HERE, '..', '..');
/** collect.py를 돌릴 Python(loadtest/test/runner.test.mjs와 같은 법: PYTHON 환경 값, 없으면 흔한 이름부터 `--version`이 되는 첫 것) */
function findPython() {
  const candidates = process.env.PYTHON ? [process.env.PYTHON] : process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    if (r.status === 0 && /Python 3\./.test(`${r.stdout}${r.stderr}`)) return c;
  }
  return null;
}
const PY = findPython();
const RESTORE_ANNOTATION = 'peaket.io/sweep-restore';

/** runGw가 장부로 넘긴 값을 gwCollectArgs로 옮겨 실제 collect.py(임시 장부 루트)에 넣는다. 저장소의 docs/perf-ledger/runs는 건드리지 않는다 */
function collectInTemp(rec, summary, label) {
  assert.equal(typeof gwRun.gwCollectArgs, 'function', `${label}: loadtest/runner/gw-run.mjs에 gwCollectArgs(장부로 옮기는 인자 조립)가 없다`);
  assert.ok(PY, 'Python 3을 찾지 못했다(PYTHON 환경 값으로 실행 파일을 줄 수 있다)');
  const root = mkdtempSync(join(tmpdir(), 'gw-collect-'));
  try {
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'perf-ledger.md'), '# 성능 장부\n\n<!-- ledger:begin -->\n<!-- ledger:end -->\n');
    const summaryFile = join(root, 'summary.json');
    writeFileSync(summaryFile, JSON.stringify(summary));
    const infraFile = join(root, 'infra.txt');
    writeFileSync(infraFile, 'generator: kind pod cpu 4 memory 4096Mi\n');
    const checksFile = join(root, 'checks.json');
    const r = gwRun.gwCollectArgs(rec, { mainS: 5, warmS: 1, summaryFile, infraFile, checksFile, generator: 'k6 1.4.2, 발생기 파드 1대(시험)' });
    assert.ok(Array.isArray(r?.args), `${label}: gwCollectArgs가 args를 돌려주지 않는다`);
    assert.equal(r.args[0], 'tools/perf-ledger/collect.py');
    if (r.checks) {
      writeFileSync(checksFile, JSON.stringify(r.checks));
      assert.equal(r.args[r.args.indexOf('--checks') + 1], checksFile, `${label}: 점검이 있는데 --checks가 그 파일이 아니다`);
    } else assert.equal(r.args.includes('--checks'), false, `${label}: 점검이 없는데 --checks를 준다`);
    const p = spawnSync(PY, ['-I', '-X', 'utf8', ...r.args, '--root', root, '--commit', 'gw-breaker-test'], { cwd: REPO, encoding: 'utf8' });
    assert.equal(p.status, 0, `${label}: collect.py가 거부했다(끝 코드 ${p.status}):\n${p.stdout}\n${p.stderr}`);
    const runId = r.args[r.args.indexOf('--run-id') + 1];
    const manifest = JSON.parse(readFileSync(join(root, 'docs', 'perf-ledger', 'runs', runId, 'manifest.json'), 'utf8'));
    assert.equal(existsSync(join(REPO, 'docs', 'perf-ledger', 'runs', runId)), false, '저장소 장부에 쓰지 않는다');
    return manifest;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const OVER_ARGS = ['sweep', '--max-parallel', '7', '--max-pending', '2', '--delay', 'fixed:500', '--rate', '300', '--warm', '1', '--main', '5'];
const recArgs = (argv, prefix) => [...argv, '--record', '--run-id-prefix', prefix];

test('V-T43 R1 스윕 단계 결과를 실제 collect.py가 받는다', async () => {
  const cases = [
    // [이름, 인자, 요약, 장부 verdict, valid, 3ms 점검 결과(없으면 null), notes의 503 수]
    ['정상 부하 통과', SWEEP_ARGS, summaryFor('entry'), 'pass', true, null, 0],
    ['정상 부하 503 1건', SWEEP_ARGS, summaryFor('entry', { n503: 1 }), 'fail', true, null, 1],
    ['과부하 통과(503 900건)', OVER_ARGS, summaryFor('entry', { n503: 900, p99: 1.5 }), 'pass', true, 'pass', null],
    ['과부하 503 10건(최소 시행 수 미달)', OVER_ARGS, summaryFor('entry', { n503: 10, p99: 1.5 }), null, true, 'observed', null],
    ['과부하 503 0건(무효)', OVER_ARGS, summaryFor('entry'), null, false, null, null],
  ];
  for (const [label, argv, summary, verdict, valid, check, notes503] of cases) {
    const f = fakeDeps({ load: async () => ({ summary, generator: GEN }) });
    const r = await runGw(parseGwArgs(recArgs(argv, '2026-11-18-bat056r1')), f.deps);
    assert.equal(r.exitCode, 0, `${label}: 끝 코드`);
    assert.equal(f.records.length, 1, `${label}: 장부 기록 수`);
    const m = collectInTemp(f.records[0], summary, label);
    assert.equal(m.verdict ?? null, verdict, `${label}: 장부 verdict ${m.verdict}`);
    assert.equal(m.valid, valid, `${label}: 장부 valid`);
    if (!valid) assert.ok(typeof m.invalid_reason === 'string' && m.invalid_reason.length > 0, `${label}: 무효 까닭`);
    const p99 = (m.checks ?? []).find((x) => x.name.endsWith(`_503_p99_${FAST_FAIL_MS}ms`));
    if (check === null) assert.deepEqual(m.checks ?? null, null, `${label}: 점검이 있다 ${JSON.stringify(m.checks)}`);
    else {
      assert.ok(p99, `${label}: 503 p99 ${FAST_FAIL_MS}ms 점검이 없다 ${JSON.stringify(m.checks)}`);
      assert.equal(p99.result, check, `${label}: 3ms 점검 결과`);
      assert.equal(p99.allowed, 0.01);
      assert.deepEqual(m.checks.map((x) => x.name), [p99.name], `${label}: 점검은 3ms 하나뿐이다`);
    }
    assert.match(String(m.notes), /보낸[^0-9]{0,6}\d/, `${label}: notes에 보낸 수가 없다 ${m.notes}`);
    if (notes503 !== null) assert.match(String(m.notes), new RegExp(`503[^0-9]{0,6}${notes503}(?!\\d)`), `${label}: notes에 503 ${notes503}건이 없다 ${m.notes}`);
  }
  // 실행 도구의 장부 기록(loadtest/run.mjs)이 같은 조립을 쓴다(시험이 지난 길이 실제 길이다)
  assert.match(readFileSync(join(REPO, 'loadtest', 'run.mjs'), 'utf8'), /gwCollectArgs\(/, 'loadtest/run.mjs가 gwCollectArgs로 장부 인자를 만들지 않는다');
});

test('V-T43 ①② R2 2xx·503 밖의 응답이 있으면 무효', async () => {
  const cases = [
    ['정상 부하 진입 401 1건(other)', SWEEP_ARGS, summaryFor('entry', { other: 1 })],
    ['과부하 진입 연결 실패 1건(other)', OVER_ARGS, summaryFor('entry', { n503: 900, p99: 1.5, other: 1 })],
    ['정상 부하 진입 429 5건(2xx + 503 < 보낸 수)', SWEEP_ARGS, summaryFor('entry', { n429: 5 })],
    ['정상 부하 홀드 403 1건(재지 않는 흐름의 other)', SWEEP_ARGS, summaryMulti({ entry: { sent: 1000 }, hold: { sent: 10, other: 1 }, pay: { sent: 2 } })],
  ];
  for (const [label, argv, summary] of cases) {
    const f = fakeDeps({ load: async () => ({ summary, generator: GEN }) });
    assert.equal((await runGw(parseGwArgs(recArgs(argv, '2026-11-18-bat056r2')), f.deps)).exitCode, 0, label);
    const st = f.saved['sweep.json'].steps[0];
    assert.deepEqual([st.verdict, st.valid], ['invalid', false], `${label}: ${JSON.stringify({ verdict: st.verdict, reasons: st.reasons, invalid_reason: st.invalid_reason })}`);
    assert.ok(typeof st.invalid_reason === 'string' && st.invalid_reason.length > 0, `${label}: 무효 까닭`);
    assert.ok(f.records.every((x) => typeof x.invalidReason === 'string' && x.invalidReason.length > 0), `${label}: 장부에 무효 까닭 없이 남겼다`);
  }
  // 대조: 같은 꼴에서 그 밖 응답이 없으면 무효가 아니다
  const ok = fakeDeps();
  await runGw(parseGwArgs(SWEEP_ARGS), ok.deps);
  assert.equal(ok.saved['sweep.json'].steps[0].verdict, 'pass');
});

test('SR-T13 ② R2 2xx·429 밖의 응답이 있으면 무효', () => {
  const mainS = 30;
  const cap = SEARCH_PER_IP * (mainS + 1);
  assertInvalid(judgeIpLimit({ case: 'many', mainS, replicas: 1, streams: { many: M({ sent: 30000, other: 1 }) }, generator: GEN }), 'many에 403 1건');
  assertInvalid(judgeIpLimit({ case: 'single', mainS, replicas: 1, streams: { one: M({ sent: 4500, n2xx: cap, n429: 4500 - cap - 1, other: 1 }) }, generator: GEN }), 'single에 연결 실패 1건');
  assertInvalid(judgeIpLimit({ case: 'single', mainS, replicas: 1, streams: { one: M({ sent: 4500, n2xx: cap, n429: 4500 - cap - 1, n503: 1 }) }, generator: GEN }), 'single에 503 1건');
  assertInvalid(judgeIpLimit({ case: 'mixed', mainS, replicas: 1, streams: { pool: M({ sent: 30000, other: 1 }), one: M({ sent: 4500, n2xx: cap, n429: 4500 - cap }) }, generator: GEN }), 'mixed의 pool에 404 1건');
  // 대조: 그 밖 응답이 없으면 무효가 아니다
  assert.equal(judgeIpLimit({ case: 'many', mainS, replicas: 1, streams: { many: M({ sent: 30000 }) }, generator: GEN }).verdict, 'pass');
});

/** EnvoyProxy: CPU 요청 375m·한도 1250m, 일꾼 5(운영·시험의 다른 값과 겹치지 않게 고름) */
const EP_SPEC = () => ({ spec: { concurrency: 5, provider: { type: 'Kubernetes', kubernetes: { envoyDeployment: { container: { resources: { requests: { cpu: '375m' }, limits: { cpu: '1250m' } } } } } } } });
const assertProxyText = (text, label) => {
  for (const v of ['375m', '1250m']) assert.ok(String(text).includes(v), `${label}: 프록시 CPU ${v}가 없다 ${text}`);
};

test('V-T43 R6 단계 결과와 장부 notes에 프록시 CPU·일꾼 수가 있다', async () => {
  const f = fakeDeps({ envoyProxies: { 'gw-queue-proxy': EP_SPEC(), 'peaket-proxy': { spec: {} } } });
  await runGw(parseGwArgs(recArgs(SWEEP_ARGS, '2026-11-18-bat056r6')), f.deps);
  const step = f.saved['sweep.json'].steps[0];
  assert.ok(step.proxy && typeof step.proxy === 'object', `sweep 단계 줄에 proxy 칸이 없다 ${JSON.stringify(step)}`);
  assertProxyText(JSON.stringify(step.proxy), 'sweep 단계 proxy');
  assert.match(JSON.stringify(step.proxy), /:5[,}]/, `sweep 단계 proxy에 일꾼 수 5가 없다 ${JSON.stringify(step.proxy)}`);
  assert.equal(f.records.length, 1);
  assertProxyText(f.records[0].notes, 'sweep 장부 notes');
  assert.match(f.records[0].notes, /일꾼[^;]{0,12}\b5\b/, `sweep 장부 notes에 일꾼 수 5가 없다 ${f.records[0].notes}`);

  // ip-limit(gw-fan은 함께 쓰는 EnvoyProxy)
  const g = fakeDeps({
    envoyProxies: { 'gw-queue-proxy': { spec: {} }, 'peaket-proxy': EP_SPEC() },
    load: async () => ({ summary: summaryMulti({ one: { sent: 9000, n429: 8700 } }), generator: GEN }),
  });
  await runGw(parseGwArgs(recArgs(['ip-limit', '--case', 'single', '--warm', '1', '--main', '5'], '2026-11-18-bat056r6')), g.deps);
  assertProxyText(JSON.stringify(g.saved['ip-limit.json']), 'ip-limit 결과 파일');
  assert.equal(g.records.length, 1);
  assertProxyText(g.records[0].notes, 'ip-limit 장부 notes');
  assert.match(g.records[0].notes, /일꾼[^;]{0,12}\b5\b/, `ip-limit 장부 notes에 일꾼 수 5가 없다 ${g.records[0].notes}`);
});

test('V-T43 R6 남은 CPU 묶음 주석이 있으면 재지 않고 멈춘다(sweep·capacity·ip-limit)', async () => {
  for (const [label, argv, epName] of [
    ['sweep', SWEEP_ARGS, 'gw-queue-proxy'],
    ['capacity', ['capacity', '--rates', '500', '--warm', '1', '--main', '5'], 'gw-queue-proxy'],
    ['ip-limit', ['ip-limit', '--case', 'single', '--warm', '1', '--main', '5'], 'peaket-proxy'],
  ]) {
    const eps = { 'gw-queue-proxy': { spec: {} }, 'peaket-proxy': { spec: {} } };
    eps[epName] = { ...EP_SPEC(), metadata: { annotations: { [RESTORE_ANNOTATION]: JSON.stringify({ concurrency: 3 }) } } };
    const f = fakeDeps({ envoyProxies: eps });
    let exitCode = null;
    let err = null;
    try {
      exitCode = (await runGw(parseGwArgs(argv), f.deps)).exitCode;
    } catch (e) {
      err = e;
    }
    assert.ok(err || exitCode === 1, `${label}: 주석이 남았는데 멈추지 않았다(끝 코드 ${exitCode})`);
    assert.match(err ? String(err.message) : f.logs.join('\n'), /cleanup/, `${label}: 'cleanup으로 되돌린 뒤 다시'를 알리지 않는다`);
    assert.equal(f.loads.length, 0, `${label}: 부하를 넣었다`);
    assert.equal(applyIdx(f.calls), -1, `${label}: 임시 정책을 적용했다`);
    assert.ok(!f.calls.some((c) => c.args.includes('patch')), `${label}: EnvoyProxy를 고쳤다`);
  }
});

test('V-T43 R6 cleanup이 주석의 값으로 EnvoyProxy를 되돌리고 주석을 지운다', async () => {
  // capacity가 CPU를 묶은 뒤 강제 종료(taskkill /F)로 되돌리기를 건너뛴 꼴: 묶은 뒤의 EnvoyProxy 고치기를 가짜가 모두 실패시킨다
  const f = fakeDeps({
    envoyProxies: { 'gw-queue-proxy': EP_SPEC(), 'peaket-proxy': { spec: {} } },
    failAfterBind: true,
    load: async () => {
      throw new Error('강제 종료 흉내(가짜)');
    },
  });
  await assert.rejects(runGw(parseGwArgs(['capacity', '--rates', '500', '--warm', '1', '--main', '5']), f.deps));
  const bound = f.eps['gw-queue-proxy'];
  assert.equal(bound.spec.concurrency, 1, '시험 바탕: CPU를 묶지 않았다');
  assert.ok(bound.metadata?.annotations?.[RESTORE_ANNOTATION], `CPU를 묶을 때 원래 값을 주석 ${RESTORE_ANNOTATION}에 남기지 않았다`);
  assert.equal(typeof gwRun.cleanupGw, 'function', 'loadtest/runner/gw-run.mjs에 cleanupGw(node loadtest/run.mjs cleanup의 게이트웨이 몫)가 없다');
  f.state.allowRestore = true;
  const before = f.calls.length;
  await gwRun.cleanupGw(f.deps);
  const back = f.eps['gw-queue-proxy'];
  assert.equal(back.spec.concurrency, 5, '일꾼 수를 원래 값으로 되돌리지 않았다');
  assert.deepEqual(back.spec.provider.kubernetes.envoyDeployment.container.resources, { requests: { cpu: '375m' }, limits: { cpu: '1250m' } }, 'CPU를 원래 값으로 되돌리지 않았다');
  assert.equal(back.metadata?.annotations?.[RESTORE_ANNOTATION], undefined, '주석을 지우지 않았다');
  assert.ok(f.calls.slice(before).some(isSweepDelete), 'cleanup이 임시 정책을 지우지 않는다');
  assert.ok(!f.calls.slice(before).some((c) => (c.args.includes('patch') || c.args.includes('annotate')) && c.args.includes('peaket-proxy')), '주석이 없는 EnvoyProxy를 고쳤다');
  // 실행 도구의 cleanup이 같은 함수를 쓴다
  assert.match(readFileSync(join(REPO, 'loadtest', 'run.mjs'), 'utf8'), /cleanupGw\(/, 'loadtest/run.mjs cleanup이 cleanupGw를 부르지 않는다');
});

test('V-T43 ① R7 정상 부하 판정은 보낸 세 흐름의 503을 모두 본다', async () => {
  for (const [label, streams, verdict] of [
    ['결제 접수에만 503 1건', { entry: { sent: 1000 }, hold: { sent: 10 }, pay: { sent: 2, n503: 1 } }, 'fail'],
    ['홀드에만 503 1건', { entry: { sent: 1000 }, hold: { sent: 10, n503: 1 }, pay: { sent: 2 } }, 'fail'],
    ['세 흐름 모두 503 0건', { entry: { sent: 1000 }, hold: { sent: 10 }, pay: { sent: 2 } }, 'pass'],
  ]) {
    const f = fakeDeps({ load: async () => ({ summary: summaryMulti(streams), generator: GEN }) });
    await runGw(parseGwArgs(SWEEP_ARGS), f.deps);
    const st = f.saved['sweep.json'].steps[0];
    assert.deepEqual([st.item, st.verdict], ['V-T43 ①', verdict], `${label}: ${JSON.stringify(st.reasons)}`);
  }
});

const FAN_ROUTE = 'gw-fan-buy';
const FAN_CLUSTER = `httproute/${NS}/${FAN_ROUTE}/rule/0`;
const FAN_ROUTE_OBJ = {
  apiVersion: 'gateway.networking.k8s.io/v1',
  kind: 'HTTPRoute',
  metadata: { name: FAN_ROUTE, namespace: NS },
  spec: {
    rules: [
      {
        matches: [
          { method: 'POST', path: { type: 'RegularExpression', value: '/v1/events/[^/]+/holds' } },
          { method: 'POST', path: { type: 'RegularExpression', value: '/v1/orders/[^/]+/payment-acceptance' } },
        ],
      },
    ],
  },
};

test('V-T43 ② R7 재는 라우트에 흐름이 둘이면(gw-fan-buy의 홀드·결제 접수) 둘 다 과부하 판정에 넣는다', async () => {
  const argv = ['sweep', '--gateway', 'gw-fan', '--route', FAN_ROUTE, '--max-parallel', '7', '--max-pending', '2', '--delay', 'fixed:500', '--rate', '30000', '--warm', '1', '--main', '5'];
  for (const [label, hold, pay, verdict] of [
    ['결제 접수의 503 하나에 Retry-After 없음', { n503: 900, p99: 1.5 }, { n503: 300, p99: 1.5, raMissing: 1 }, 'fail'],
    ['결제 접수의 503 p99 3.01ms', { n503: 900, p99: 1.5 }, { n503: 300, p99: FAST_FAIL_MS + 0.01, overFast: 300 }, 'fail'],
    ['홀드의 503 Problem 본문 틀림 1건', { n503: 900, p99: 1.5, bad: 1 }, { n503: 300, p99: 1.5 }, 'fail'],
    ['둘 다 맞음', { n503: 900, p99: 1.5 }, { n503: 300, p99: 1.5 }, 'pass'],
  ]) {
    const f = fakeDeps({
      routeObjs: { [FAN_ROUTE]: FAN_ROUTE_OBJ },
      cluster: FAN_CLUSTER,
      load: async () => ({ summary: summaryMulti({ entry: { sent: 30000 }, hold: { sent: 1000, ...hold }, pay: { sent: 400, ...pay } }), generator: GEN }),
    });
    await runGw(parseGwArgs(argv), f.deps);
    const st = f.saved['sweep.json'].steps[0];
    assert.deepEqual([st.item, st.verdict], ['V-T43 ②', verdict], `${label}: ${JSON.stringify({ reasons: st.reasons, invalid_reason: st.invalid_reason })}`);
  }
});

test('V-T43 R8 ①·②는 부하 꼴로 가른다', async () => {
  // 지연 normal이면 평균 동시가 '동시 + 보류'를 넘어도 ①(초당 1,500 × 평균 7.3ms ≈ 11 > 7 + 2)
  for (const [label, rate] of [
    ['평균 동시 ≈ 11 > 동시 7 + 보류 2', '1500'],
    ['평균 동시 ≈ 8 (동시 7과 동시 + 보류 9 사이)', '1100'],
  ]) {
    const f = fakeDeps();
    await runGw(parseGwArgs(['sweep', '--max-parallel', '7', '--max-pending', '2', '--rate', rate, '--warm', '1', '--main', '5']), f.deps);
    const st = f.saved['sweep.json'].steps[0];
    assert.deepEqual([st.item, st.verdict], ['V-T43 ①', 'pass'], `${label}: ${JSON.stringify({ item: st.item, verdict: st.verdict, invalid_reason: st.invalid_reason })}`);
  }
  // 고정 지연(과부하 꼴)인데 도착률 × 지연 ≤ 동시 상한이면 과부하가 아니므로 인자 오류(경계 양쪽: 400 × 50ms = 20 = 동시 20은 오류, 401은 받음)
  const fixed = (parallel, rate, ms) => ['sweep', '--max-parallel', parallel, '--max-pending', '3', '--delay', `fixed:${ms}`, '--rate', rate];
  assert.throws(() => parseGwArgs(fixed('20', '400', '50')), (e) => e instanceof UsageError, '400 × 50ms = 20 ≤ 동시 20');
  assert.doesNotThrow(() => parseGwArgs(fixed('20', '401', '50')), '401 × 50ms = 20.05 > 동시 20');
  assert.throws(() => parseGwArgs(fixed('10,20', '300', '50')), (e) => e instanceof UsageError, '목록의 둘째(동시 20)에서 300 × 50ms = 15 ≤ 20');
  assert.throws(() => parseGwArgs(fixed('20', '40', '500')), (e) => e instanceof UsageError, '40 × 500ms = 20 ≤ 동시 20');
  const r = spawnSync(process.execPath, [RUN_MJS, 'gw', ...fixed('20', '400', '50')], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, PEAKET_KUBECONFIG: join(HERE, 'no-such-kubeconfig') } });
  assert.equal(r.status, 2, `실행 도구 끝 코드 ${r.status} ${r.stderr}`);
});
