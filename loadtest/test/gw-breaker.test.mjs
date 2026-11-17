// 게이트웨이 차단 상한 측정 도구(gw sweep·capacity·ip-limit)의 단위 시험(BUILD_ORDER BAS-090, 묶음 BAT-056 계획 §3의 U1~U8, V-T43 ①②·SR-T13 ②).
// 대상: loadtest/runner/gw.mjs(순수 함수)와 gw-run.mjs runGw(클러스터·발생기는 가짜 deps). 각 export의 JSDoc과 계획 '시험 이의' (가)~(라)의 입력 꼴을 명세로 본다.
// 정본: docs/infra.md §4.1 '게이트웨이 차단 상한' '측정(V-T43)'(판정 둘, 무효를 통과로 세지 않음), docs/features/search.md §12 SR-T13 ② '측정 판정'(50 × (본구간 초 + 1) × 복제 수).
// 시험 값(3ms, 초당 50건, 이름표 peaket.io/sweep, 네임스페이스 envoy-gateway-system)은 코드 상수를 가져오지 않고 정본·계획 값을 적는다. 상한 값은 운영 첫 값과 다르게 고른다
// (동시 7·보류 2 등. 값이 같으면 상수를 잘못 쓴 결함이 숨는다). 판정 함수만 보지 않고 부르는 쪽(runGw의 결과 파일·성능 장부 기록·끝 코드)이 판정을 쓰는지 본다.
// 실행: node --test loadtest/test/gw-breaker.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { UsageError } from '../runner/args.mjs';
import { expandSweepSteps, judgeIpLimit, judgeSweepStep, limitsLoaded, parseClusterLimits, parseClusterStats, parseGwArgs, statsWindow, sweepChecks, sweepPolicy } from '../runner/gw.mjs';
import { runGw, waitLimits } from '../runner/gw-run.mjs';

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
  const decoys = [`${cluster}0`, cluster.replace(`/${ROUTE}/`, `/${ROUTE}-2/`), cluster.replace('/rule/', '/rule/x')];
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
  for (const d of [`${cluster}0`, cluster.replace(`/${ROUTE}/`, `/${ROUTE}-2/`)])
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
function M({ sent = 1000, n503 = 0, n429 = 0, p99 = n503 ? 1.2 : null, overFast = 0, raMissing = 0, raNonnum = 0, bad = 0, ra429Missing = 0, n2xx } = {}) {
  return {
    sent,
    status: { '2xx': n2xx ?? sent - n503 - n429, 503: n503, 429: n429, other: 0 },
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

test('V-T43 성능 장부 checks: 이름·허용 비율·시행 수·어긴 수가 판정과 같은 값', () => {
  assert.deepEqual(
    sweepChecks('entry', false, M({ sent: 1234 })).checks.map(({ name, allowed, trials, violations }) => ({ name, allowed, trials, violations })),
    [{ name: 'entry_503', allowed: 0, trials: 1234, violations: 0 }],
  );
  const normal503 = sweepChecks('entry', false, M({ sent: 1234, n503: 2, raMissing: 1 })).checks;
  assert.deepEqual(
    normal503.map(({ name, allowed, trials, violations }) => ({ name, allowed, trials, violations })),
    [
      { name: 'entry_503', allowed: 0, trials: 1234, violations: 2 },
      { name: 'entry_503_retry_after', allowed: 0, trials: 2, violations: 1 },
      { name: 'entry_503_problem', allowed: 0, trials: 2, violations: 0 },
    ],
  );
  const over = sweepChecks('entry', true, M({ sent: 900, n503: 500, overFast: 6, raNonnum: 2, bad: 3 })).checks;
  assert.deepEqual(
    over.map(({ name, allowed, trials, violations }) => ({ name, allowed, trials, violations })),
    [
      { name: `entry_503_p99_${FAST_FAIL_MS}ms`, allowed: 0.01, trials: 500, violations: 6 },
      { name: 'entry_503_retry_after', allowed: 0, trials: 500, violations: 2 },
      { name: 'entry_503_problem', allowed: 0, trials: 500, violations: 3 },
    ],
  );
  for (const c of [...normal503, ...over]) assert.ok(typeof c.target === 'string' && c.target.length > 0, `${c.name}: target`);
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

/** k6 요약 꼴(loadtest/scenarios/gw.js의 지표 이름과 꼬리표 {phase:main,stream,cls,…}) */
function summaryFor(stream, { sent = 1000, n503 = 0, p99 = 1.1, raMissing = 0, overFast = 0 } = {}) {
  const k = (name, extra = '') => `${name}{phase:main,stream:${stream}${extra}}`;
  const cnt = (n) => ({ type: 'counter', values: { count: n, rate: n / 5 } });
  const trend = (p) => ({ type: 'trend', values: { med: p, 'p(99)': p, max: p, avg: p, min: p } });
  return {
    metrics: {
      [k('gw_reqs', ',cls:2xx')]: cnt(sent - n503),
      [k('gw_reqs', ',cls:503')]: cnt(n503),
      [k('gw_reqs', ',cls:429')]: cnt(0),
      [k('gw_reqs', ',cls:other')]: cnt(0),
      [k('gw_dur_2xx')]: trend(6),
      ...(n503 ? { [k('gw_dur_503')]: trend(p99) } : {}),
      [k('gw_over_fast')]: cnt(overFast),
      [k('gw_ra', ',cls:503,ra:num')]: cnt(n503 - raMissing),
      [k('gw_ra', ',cls:503,ra:missing')]: cnt(raMissing),
      [k('gw_ra', ',cls:503,ra:nonnum')]: cnt(0),
      [k('gw_problem', ',cls:503,ok:yes')]: cnt(n503),
      [k('gw_problem', ',cls:503,ok:no')]: cnt(0),
    },
  };
}

/**
 * 가짜 deps. o: { pods, admin(pod, polls) → /clusters 글, load(call, deps) → runLoad 결과, stats(pod) → 통계 글, envoyProxy }
 * calls에 kubectl 명령을 차례로 남긴다
 */
function fakeDeps(o = {}) {
  let t = 1_763_000_000_000;
  const pods = o.pods ?? ['envoy-gw-queue-a'];
  const calls = [];
  const saved = {};
  const records = [];
  const loads = [];
  const logs = [];
  const cleanups = [];
  const polls = {};
  const deps = {
    kubectl: async (args, opt = {}) => {
      calls.push({ args: [...args], input: opt.input });
      const s = args.join(' ');
      if (args.includes('--raw') && s.includes('/stats/prometheus')) {
        const pod = /pods\/([^:/]+):/.exec(s)?.[1];
        return o.stats ? o.stats(pod) : statsText(CLUSTER);
      }
      if (args.includes('--raw')) throw new Error(`모르는 --raw ${s}`);
      if (s.includes('get backendtrafficpolicies')) return JSON.stringify({ items: o.policies ?? [] });
      if (s.includes('get pods')) return JSON.stringify({ items: pods.map((n) => ({ metadata: { name: n }, status: { phase: 'Running' } })) });
      if (s.includes('get svc')) return '10.96.0.10';
      if (args[0] === 'apply') return 'backendtrafficpolicy.gateway.envoyproxy.io/x configured';
      if (args.includes('delete')) return 'deleted';
      if (s.includes('get gateway')) return JSON.stringify({ spec: { infrastructure: { parametersRef: { name: 'gw-queue-proxy' } } } });
      if (s.includes('get envoyproxy')) return JSON.stringify(o.envoyProxy ?? { metadata: { name: 'gw-queue-proxy' }, spec: {} });
      if (args.includes('patch')) return 'patched';
      if (s.includes('get deploy')) return 'envoy-gw-queue-abc';
      if (args.includes('rollout')) return 'rolled out';
      throw new Error(`모르는 kubectl ${s}`);
    },
    readAdmin: async (pod, path) => {
      assert.equal(path, '/clusters');
      polls[pod] = (polls[pod] ?? 0) + 1;
      return o.admin ? o.admin(pod, polls[pod]) : clustersText(CLUSTER, { maxConnections: 7, maxPendingRequests: 2, maxRequests: 7 });
    },
    routeObject: (route) => {
      assert.equal(route, ROUTE);
      return structuredClone(ROUTE_OBJ);
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
  return { deps, calls, saved, records, loads, logs, cleanups, polls };
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
  assert.deepEqual(
    pass.records[0].checks.checks.map(({ name, allowed, trials, violations }) => ({ name, allowed, trials, violations })),
    [{ name: 'entry_503', allowed: 0, trials: 1000, violations: 0 }],
  );
  // 장부 scenario에 세 상한 값(V-T43 ② '고른 설정값은 성능 장부')
  assert.match(pass.records[0].scenario, /maxConnections=7\b/);
  assert.match(pass.records[0].scenario, /maxParallelRequests=7\b/);
  assert.match(pass.records[0].scenario, /maxPendingRequests=2\b/);

  // 정상 부하에서 503 1건: 실패로 옮기고 장부 checks의 어김 1
  const fail = fakeDeps({ load: async () => ({ summary: summaryFor('entry', { n503: 1 }), generator: GEN }) });
  assert.equal((await runGw(parseGwArgs(REC), fail.deps)).exitCode, 0, '판정이 실패여도 실행을 마치면 끝 코드 0');
  assert.equal(fail.saved['sweep.json'].steps[0].verdict, 'fail');
  assert.equal(fail.records[0].checks.checks.find((c) => c.name === 'entry_503').violations, 1);

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
