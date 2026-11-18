// 게이트웨이 차단 상한(서킷 브레이커)과 게이트웨이 503의 Retry-After 정적 시험(BUILD_ORDER BAS-090, 묶음 BAT-056 계획 §3의 S1~S5, V-T43 ①②).
// 파일만 읽는다: deploy/gateways/*.yaml(손으로 쓴 정의와 생성 라우트 *.routes.yaml). S5는 deploy/gateways 아래 모든 YAML을 읽는다.
// 정본: docs/infra.md §4.1 '게이트웨이 차단 상한'(자리와 칸·넘치면·지금 값과 잰 값(적용 보류)·길게 쥐는 라우트·걸지 않는 것)과 '게이트웨이 오류의 Problem',
// docs/api/guidelines.md §2(게이트웨이가 과부하로 막으면 503과 Retry-After 필수), ADR-0009 결정 3(게이트웨이는 다시 보내지 않는다), docs/verification.md V-T43.
// 시험 값(Retry-After 2, gw-queue 2,434·2,434·305, 나머지 넷 6,084·6,084·761, 길게 쥐는 규칙 65,536, 429의 60·1, 상태 문구)은 YAML·코드 상수에서 가져오지 않고
// 정본 값을 적는다(docs/architecture.md §8.6 '자주 놓친 결함').
// 묶음 BAT-058(HOT-405) 계획 docs/review/plans/BAT-058.md §7의 WS1~WS4: 프록시 일꾼 수와 파드 CPU(docs/infra.md §4.1 '프록시 일꾼 수와 파드 CPU', ADR-0287 결정 1~3).
// 그 시험 값(일꾼 수 2, CPU 요청 2코어, 메모리 요청 512Mi, 한도 없음, extraArgs의 --concurrency·--cpuset-threads 금지)도 정본에서 적는다.
// 정책이 라우트 규칙에 닿는 법(Envoy Gateway v1.10.0, docs/infra.md §4.1 '길게 쥐는 라우트'의 확인 2026-11-17): 규칙 이름(sectionName)을 겨눈 정책이 있으면
// 그 규칙에서는 라우트 전체를 겨눈 정책을 덮어 쓰고(합치지 않음), mergeType이 있으면 게이트웨이(리스너)를 겨눈 정책하고만 합친다. 규칙을 겨눈 정책이 없으면
// 라우트 전체를 겨눈 정책(mergeType이 있으면 게이트웨이 정책과 합침), 그것도 없으면 게이트웨이 정책이다. 같은 대상(라우트 전체, 또는 한 규칙)을 두 정책이
// 겨누면 Envoy Gateway가 하나를 버리므로(계획 §2 3) 그런 겹침도 실패로 본다. 합칠 때 circuitBreaker는 좁은 정책의 칸이 넓은 정책의 칸을 덮는다.
// 실행(저장소 뿌리): node --test "deploy/gateways/test/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(HERE, '..');

// ---- 정본 값(docs/infra.md §4.1 '게이트웨이 차단 상한') ----
const GATEWAYS = ['gw-queue', 'gw-fan', 'gw-partner', 'gw-ops', 'gw-scanner'];
/**
 * 지금 운영 값(docs/infra.md §4.1 '지금 값과 잰 값(적용 보류)'·'진단 측정으로 정함', 실측(PC) 2026-11-19 BAT-058 진단 측정, ADR-0287 결정 11, k 3.9·R_pod 3,120):
 * gw-queue는 동시·연결 2,434와 보류 305, 나머지 넷은 동시·연결 6,084와 보류 761. 이력: 첫 값(측정 전) 2,400·300·6,000·750, 첫 측정의 잰 값(적용 보류) 3,120·390·7,800·975
 */
const LIMITS = {
  'gw-queue': { maxConnections: 2434, maxParallelRequests: 2434, maxPendingRequests: 305 },
  'gw-fan': { maxConnections: 6084, maxParallelRequests: 6084, maxPendingRequests: 761 },
  'gw-partner': { maxConnections: 6084, maxParallelRequests: 6084, maxPendingRequests: 761 },
  'gw-ops': { maxConnections: 6084, maxParallelRequests: 6084, maxPendingRequests: 761 },
  'gw-scanner': { maxConnections: 6084, maxParallelRequests: 6084, maxPendingRequests: 761 },
};
/** 길게 쥐는 규칙(관제 SSE 두 흐름)은 세 칸 65,536 [가정] */
const LONG_HOLD = { maxConnections: 65536, maxParallelRequests: 65536, maxPendingRequests: 65536 };
/** 차단 상한의 세 칸(같은 칸 묶음의 maxParallelRetries·maxRequestsPerConnection·perEndpoint·retryBudget은 쓰지 않는다) */
const BREAKER_KEYS = ['maxConnections', 'maxParallelRequests', 'maxPendingRequests'];
/** 게이트웨이가 만든 503에 다는 Retry-After [가정] */
const RETRY_AFTER_503 = '2';
/** 429의 두 갈래(토큰으로 센 분 창 60, 그 밖 초 창 1, docs/infra.md §4.1 '게이트웨이 오류의 Problem') */
const RETRY_AFTER_429_ACCOUNT = '60';
const RETRY_AFTER_429_OTHER = '1';
const PROBLEM_503 = { type: 'about:blank', title: 'Service Unavailable', status: 503 };
const API_HOST = { 'gw-queue': 'queue.peaket.example', 'gw-fan': 'api.peaket.example', 'gw-partner': 'partner-api.peaket.example', 'gw-ops': 'ops-api.peaket.example', 'gw-scanner': 'scanner-api.peaket.example' };
/** 관제 SSE 두 흐름(요청 시간 상한을 끈 규칙, docs/infra.md §4.1 '경로별 시간 상한')과 결제 결과 롱 폴링(27초) — 계약 경로로 고른다(규칙 이름에 기대지 않는다) */
const SSE_REQUESTS = [
  ['GET', '/v1/ops/events/e-breaker/live'],
  ['GET', '/v1/ops/live'],
];
const SSE_RULE_NAMES = ['ops-event-live', 'ops-live'];
const PAYMENT_STATUS = ['GET', '/v1/orders/o-breaker/payment-status'];
/** gw-fan-api를 겨눈 계정당 전역 한도 정책(D-T50 ①, 세 라우트 한 버킷) */
const FAN_ACCOUNT_LIMIT = 'gw-fan-account-rate-limit';
const SWEEP_LABEL = 'peaket.io/sweep';

// ---- 읽기 ----
function loadDir(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort())
    for (const d of parseAllDocuments(readFileSync(join(dir, f), 'utf8'))) {
      if (d.errors.length) throw new Error(`${f}: ${d.errors[0].message}`);
      const o = d.toJS();
      if (o && typeof o === 'object') out.push({ ...o, __file: f });
    }
  return out;
}
const OBJECTS = loadDir(DIR);
const requireDefinitions = () => assert.ok(OBJECTS.length > 0, `deploy/gateways/*.yaml에 정의가 없다(${DIR})`);
const byKind = (k) => OBJECTS.filter((o) => o.kind === k);
const BTP = () => byKind('BackendTrafficPolicy');
const routes = () => byKind('HTTPRoute');
const routesOf = (gw) => routes().filter((r) => (r.spec?.parentRefs ?? []).some((p) => p.name === gw));
const lc = (s) => String(s).toLowerCase();
const nameOf = (p) => p.metadata?.name;

function findKey(obj, key, out = []) {
  if (Array.isArray(obj)) for (const v of obj) findKey(v, key, out);
  else if (obj && typeof obj === 'object')
    for (const [k, v] of Object.entries(obj)) {
      if (k === key) out.push(v);
      findKey(v, key, out);
    }
  return out;
}

// ---- 정책이 닿는 법(규칙 단위) ----
const refsOf = (p) => [...(p.spec?.targetRefs ?? []), ...(p.spec?.targetRef ? [p.spec.targetRef] : [])];
/** 라우트 전체를 겨눔: 이름으로 겨눈 HTTPRoute 참조(sectionName 없음) 또는 이름표 고르개 */
function targetsWholeRoute(p, route) {
  if (refsOf(p).some((t) => t.kind === 'HTTPRoute' && t.name === route.metadata?.name && t.sectionName === undefined)) return true;
  const labels = route.metadata?.labels ?? {};
  return (p.spec?.targetSelectors ?? []).some((s) => s.kind === 'HTTPRoute' && Object.keys(s.matchLabels ?? {}).length > 0 && Object.entries(s.matchLabels).every(([k, v]) => labels[k] === v));
}
/** 규칙 하나를 겨눔(sectionName = 규칙 이름) */
const targetsRule = (p, route, rule) => rule.name !== undefined && refsOf(p).some((t) => t.kind === 'HTTPRoute' && t.name === route.metadata?.name && t.sectionName === rule.name);
/** 라우트의 부모 게이트웨이(sectionName이 있으면 그 리스너)를 겨눔 */
const targetsParentGateway = (p, route) =>
  (route.spec?.parentRefs ?? []).some((pr) => refsOf(p).some((t) => t.kind === 'Gateway' && t.name === pr.name && (t.sectionName === undefined || t.sectionName === pr.sectionName)));

/** 규칙 하나에 닿는 정책들(좁은 것부터). 같은 대상을 두 정책이 겨누면 실패 */
function effectiveForRule(route, rule) {
  const where = `${route.metadata?.name}${rule.name ? `/${rule.name}` : ''}`;
  const gw = BTP().filter((p) => targetsParentGateway(p, route));
  const own = BTP().filter((p) => targetsRule(p, route, rule));
  assert.ok(own.length <= 1, `${where}: 규칙을 겨눈 BackendTrafficPolicy가 둘 이상이다(${own.map(nameOf).join(', ')}). Envoy Gateway가 하나를 버린다`);
  if (own.length) return own[0].spec?.mergeType ? [own[0], ...gw] : [own[0]];
  const whole = BTP().filter((p) => targetsWholeRoute(p, route));
  assert.ok(whole.length <= 1, `${where}: 라우트 전체를 겨눈 BackendTrafficPolicy가 둘 이상이다(${whole.map(nameOf).join(', ')}). Envoy Gateway가 하나를 버린다`);
  if (whole.length) return whole[0].spec?.mergeType ? [whole[0], ...gw] : [whole[0]];
  return gw;
}
/** 닿는 정책들의 circuitBreaker를 합친 값(좁은 정책의 칸이 이긴다). 아무도 적지 않은 칸은 없다(Envoy 기본 1024) */
function breakerOf(policies) {
  const out = {};
  for (const p of [...policies].reverse()) Object.assign(out, p.spec?.circuitBreaker ?? {});
  return out;
}
const breakerTriple = (b) => Object.fromEntries(BREAKER_KEYS.map((k) => [k, b[k]]));

/** 경로 맞춤(Exact > 정규식 > 긴 PathPrefix) */
function pathScore(match, method, path) {
  if (match.method && match.method !== method) return -1;
  const p = match.path ?? { type: 'PathPrefix', value: '/' };
  const v = p.value ?? '/';
  if (p.type === 'Exact') return v === path ? 100000 : -1;
  if (p.type === 'RegularExpression') return new RegExp(`^(?:${v})$`).test(path) ? 1000 + v.length : -1;
  const pre = v.endsWith('/') ? v : `${v}/`;
  return path === v || path.startsWith(pre) || v === '/' ? 10 + v.length : -1;
}
/** 그 게이트웨이 API 호스트에서 (메서드, 경로)를 받는 라우트와 규칙 */
function ruleFor(gw, method, path) {
  let best = null;
  for (const route of routesOf(gw)) {
    if (!(route.spec?.hostnames ?? []).includes(API_HOST[gw])) continue;
    for (const rule of route.spec?.rules ?? [])
      for (const m of rule.matches ?? [{}]) {
        const s = pathScore(m, method, path);
        if (s >= 0 && (!best || s > best.score)) best = { route, rule, score: s };
      }
  }
  assert.ok(best, `${gw} ${method} ${path}를 받는 규칙이 없다`);
  assert.ok((best.rule.backendRefs ?? []).length > 0, `${gw} ${method} ${path}가 백엔드로 가지 않는다(${best.route.metadata?.name})`);
  return best;
}

// ---- 응답 고치기 ----
function codesOf(entry) {
  return findKey(entry.match ?? {}, 'statusCodes')
    .flat()
    .flatMap((c) => {
      if (typeof c === 'number') return [c];
      if (c?.range) return Array.from({ length: Number(c.range.end) - Number(c.range.start) + 1 }, (_, i) => Number(c.range.start) + i);
      return [Number(c?.value)];
    });
}
const overrides = (policies) => policies.flatMap((p) => (p.spec?.responseOverride ?? []).map((o) => ({ policy: nameOf(p), o })));
/** 응답 고치기 항목이 다는 머리 name의 값들(set·add 둘 다) */
const headerValues = (o, name) => [...(o.response?.header?.set ?? []), ...(o.response?.header?.add ?? [])].filter((h) => lc(h.name) === lc(name)).map((h) => String(h.value));
const inlineBody = (o) => findKey(o.response ?? {}, 'inline').find((v) => typeof v === 'string');

/** 503 응답 고치기: 항목이 하나 이상이고, 503을 맞추는 항목 모두가 게이트웨이가 만든 응답(Local)에 Problem 본문과 Retry-After: 2 하나를 단다 */
function assert503Override(policies, where) {
  const list = overrides(policies).filter(({ o }) => codesOf(o).includes(503));
  assert.ok(list.length > 0, `${where}: 503 응답 고치기가 없다`);
  for (const { policy, o } of list) {
    const at = `${where} 503(${policy})`;
    assert.deepEqual(findKey(o, 'source'), ['Local'], `${at}: source가 게이트웨이가 만든 응답만(Local)이 아니다`);
    assert.equal(o.response?.contentType, 'application/problem+json', `${at}: 형식`);
    const body = inlineBody(o);
    assert.ok(typeof body === 'string', `${at}: 고정 본문이 없다`);
    assert.deepEqual(JSON.parse(body), PROBLEM_503, `${at}: 본문`);
    assert.deepEqual(headerValues(o, 'Retry-After'), [RETRY_AFTER_503], `${at}: Retry-After가 정확히 '2' 하나가 아니다`);
  }
}

// ===================== S1 =====================

test('V-T43 ② 다섯 게이트웨이의 503 응답 고치기는 Retry-After: 2와 Problem 본문을 단다(게이트웨이·라우트 각각)', () => {
  requireDefinitions();
  let rules = 0;
  for (const gw of GATEWAYS) {
    const gp = BTP().filter((p) => refsOf(p).some((t) => t.kind === 'Gateway' && t.name === gw));
    assert.ok(gp.length > 0, `${gw}: 게이트웨이에 건 BackendTrafficPolicy가 없다`);
    assert503Override(gp, `${gw}(게이트웨이)`);
    const rs = routesOf(gw);
    assert.ok(rs.length > 0, `${gw}: 라우트가 없다`);
    // 라우트·규칙에 따로 건 정책(한도, 길게 쥐는 규칙)이 mergeType 없이 게이트웨이 정책을 가리면 그 규칙에서 503 고치기가 빠진다
    for (const r of rs)
      for (const [i, rule] of (r.spec?.rules ?? []).entries()) {
        assert503Override(effectiveForRule(r, rule), `${gw}/${r.metadata?.name}/rule/${i}`);
        rules++;
      }
  }
  assert.ok(rules > 0, '본 규칙이 0개다');
});

test('V-T43 ② 503에 더한 Retry-After는 429의 두 갈래(토큰으로 센 쪽 60, 그 밖 1)를 바꾸지 않는다(게이트웨이 각각)', () => {
  requireDefinitions();
  for (const gw of GATEWAYS) {
    const gp = BTP().filter((p) => refsOf(p).some((t) => t.kind === 'Gateway' && t.name === gw));
    const list = overrides(gp).filter(({ o }) => codesOf(o).includes(429));
    assert.ok(list.length > 0, `${gw}: 429 응답 고치기가 없다`);
    const values = list.map(({ o }) => headerValues(o, 'Retry-After'));
    for (const v of values) assert.equal(v.length, 1, `${gw}: 429 항목의 Retry-After가 하나가 아니다(${JSON.stringify(values)})`);
    assert.deepEqual([...new Set(values.flat())].sort(), [RETRY_AFTER_429_OTHER, RETRY_AFTER_429_ACCOUNT].sort(), `${gw}: 429 Retry-After 값들`);
  }
});

// ===================== S2 =====================

test('V-T43 ① HOT-405 S2 다섯 게이트웨이 정책의 circuitBreaker가 정본 지금 값(gw-queue 2,434·2,434·305, 나머지 넷 6,084·6,084·761)이다', () => {
  requireDefinitions();
  for (const gw of GATEWAYS) {
    const withBreaker = BTP().filter((p) => p.spec?.circuitBreaker !== undefined && refsOf(p).some((t) => t.kind === 'Gateway' && t.name === gw));
    // 자리: 게이트웨이에 건 gw-<이름>-responses 하나(게이트웨이를 겨눈 다른 정책에 두면 둘이 부딪힌다)
    assert.deepEqual(withBreaker.map(nameOf), [`${gw}-responses`], `${gw}: circuitBreaker를 둔 게이트웨이 정책`);
    const b = withBreaker[0].spec.circuitBreaker;
    assert.deepEqual(Object.keys(b).sort(), [...BREAKER_KEYS].sort(), `${gw}: circuitBreaker 칸은 세 칸뿐이다(${Object.keys(b).join(', ')})`);
    assert.deepEqual(breakerTriple(b), LIMITS[gw], `${gw}: 지금 운영 값`);
    // 값의 식: 연결 = 동시, 보류 = ⌈동시 ÷ 8⌉ ≤ 동시(docs/infra.md §4.1 '값의 식', q = 1/8)
    assert.equal(b.maxConnections, b.maxParallelRequests, `${gw}: 연결 ≠ 동시`);
    assert.ok(b.maxPendingRequests <= b.maxParallelRequests, `${gw}: 보류 ${b.maxPendingRequests} > 동시 ${b.maxParallelRequests}`);
    assert.equal(b.maxPendingRequests, Math.ceil(b.maxParallelRequests / 8), `${gw}: 보류 ${b.maxPendingRequests} ≠ ⌈동시 ${b.maxParallelRequests} ÷ 8⌉`);
  }
});

// ===================== S3 =====================

test('V-T43 ① HOT-405 S3 관제 SSE 두 규칙만 상한을 65,536으로 올리고 결제 결과 롱 폴링 규칙은 게이트웨이 값(gw-fan 6,084·6,084·761)이며 503 응답 고치기는 그대로 닿는다', () => {
  requireDefinitions();
  // 관제 SSE 두 규칙(계약 경로로 고름): 세 칸 65,536, 503 고치기는 S1과 같다
  const sse = SSE_REQUESTS.map(([m, p]) => ({ m, p, ...ruleFor('gw-ops', m, p) }));
  for (const { m, p, route, rule } of sse) {
    const where = `gw-ops ${m} ${p}(${route.metadata?.name}/${rule.name ?? '이름 없음'})`;
    assert.deepEqual(rule.timeouts?.request, '0s', `${where}: 요청 시간 상한을 끈 규칙이 아니다`);
    const eff = effectiveForRule(route, rule);
    assert.deepEqual(breakerTriple(breakerOf(eff)), LONG_HOLD, `${where}: 차단 상한`);
    assert503Override(eff, where);
  }
  assert.notEqual(sse[0].rule, sse[1].rule, '관제 SSE 두 경로가 한 규칙에 있다');
  assert.deepEqual(sse.map((s) => s.rule.name).sort(), [...SSE_RULE_NAMES].sort(), '관제 SSE 규칙 이름(정본 docs/infra.md §4.1 길게 쥐는 라우트)');

  // 결제 결과 롱 폴링(감독 결정, 2026-11-18): 규칙을 겨눈 정책이 없어 계정당 전역 한도 정책이 덮이지 않고, 차단 상한은 gw-fan 게이트웨이 값
  const pay = ruleFor('gw-fan', ...PAYMENT_STATUS);
  const payWhere = `gw-fan ${PAYMENT_STATUS.join(' ')}(${pay.route.metadata?.name})`;
  assert.deepEqual(BTP().filter((p) => targetsRule(p, pay.route, pay.rule)).map(nameOf), [], `${payWhere}: 규칙을 겨눈 정책이 있다`);
  const payEff = effectiveForRule(pay.route, pay.rule);
  assert.ok(payEff.map(nameOf).includes(FAN_ACCOUNT_LIMIT), `${payWhere}: 계정당 전역 한도 ${FAN_ACCOUNT_LIMIT}이 닿지 않는다(${payEff.map(nameOf).join(', ')})`);
  assert.ok(payEff.some((p) => (p.spec?.rateLimit?.global?.rules ?? []).length > 0), `${payWhere}: 전역 한도 규칙이 없다`);
  assert.deepEqual(breakerTriple(breakerOf(payEff)), LIMITS['gw-fan'], `${payWhere}: 차단 상한은 게이트웨이 값 6,084·6,084·761이다`);
  assert503Override(payEff, payWhere);

  // 그 밖의 모든 규칙(다섯 게이트웨이의 모든 라우트): 65,536이 닿지 않고 게이트웨이 지금 값 그대로
  let others = 0;
  for (const gw of GATEWAYS)
    for (const r of routesOf(gw))
      for (const [i, rule] of (r.spec?.rules ?? []).entries()) {
        if (sse.some((s) => s.rule === rule)) continue;
        assert.deepEqual(breakerTriple(breakerOf(effectiveForRule(r, rule))), LIMITS[gw], `${gw}/${r.metadata?.name}/rule/${i}${rule.name ? `(${rule.name})` : ''}: 차단 상한이 게이트웨이 값이 아니다`);
        others++;
      }
  assert.ok(others > 0, '본 다른 규칙이 0개다');
});

// ===================== R4(리뷰 반영) =====================

// 규칙을 겨눈 정책은 그 규칙에서 라우트 전체를 겨눈 정책을 덮어 쓴다(docs/infra.md §4.1 '길게 쥐는 라우트', Envoy Gateway v1.10.0). 그래서 같은 라우트에 둘이 함께 있으면
// 라우트 전체 정책(한도 등)이 그 규칙에서만 조용히 빠진다. 정본의 전제 'gw-ops-api를 겨눈 다른 BackendTrafficPolicy가 없다'를 지킨다(BAT-056 리뷰 R4)
test('V-T43 R4 규칙을 겨눈 BackendTrafficPolicy가 있는 라우트에는 라우트 전체를 겨눈 BackendTrafficPolicy가 없다', () => {
  requireDefinitions();
  let ruled = 0;
  for (const r of routes()) {
    const sectionPolicies = BTP().filter((p) => refsOf(p).some((t) => t.kind === 'HTTPRoute' && t.name === r.metadata?.name && t.sectionName !== undefined));
    if (!sectionPolicies.length) continue;
    ruled++;
    const whole = BTP().filter((p) => targetsWholeRoute(p, r));
    assert.deepEqual(whole.map(nameOf), [], `${r.metadata?.name}: 규칙을 겨눈 정책(${sectionPolicies.map(nameOf).join(', ')})이 있는데 라우트 전체를 겨눈 정책이 있다(그 규칙에서 덮여 빠진다)`);
  }
  assert.ok(ruled > 0, '규칙을 겨눈 정책이 있는 라우트가 0개다(gw-ops-api의 관제 SSE 정책이 있어야 한다)');
});

// ===================== S4 =====================

test('V-T43 ② 어느 BackendTrafficPolicy에도 retry가 없다', () => {
  requireDefinitions();
  const ps = BTP();
  assert.ok(ps.length > 0, 'BackendTrafficPolicy가 없다');
  for (const p of ps) assert.deepEqual(findKey(p.spec ?? {}, 'retry'), [], `${p.__file} ${nameOf(p)}: retry 칸이 있다(ADR-0009 결정 3: 게이트웨이는 다시 보내지 않는다)`);
  // 라우트 규칙의 retry(Gateway API HTTPRoute 칸)도 같은 뜻이다
  for (const r of routes()) for (const [i, rule] of (r.spec?.rules ?? []).entries()) assert.equal(rule.retry, undefined, `${r.__file} ${r.metadata?.name}/rule/${i}: retry가 있다`);
});

// ===================== S5 =====================

function allYaml(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) allYaml(f, out);
    else if (/\.ya?ml$/.test(n)) out.push(f);
  }
  return out;
}

test('V-T43 deploy/gateways에 이름표 peaket.io/sweep 객체가 없다', () => {
  requireDefinitions();
  const files = allYaml(DIR);
  assert.ok(files.length > 0, 'YAML 파일이 없다');
  let seen = 0;
  for (const f of files)
    for (const d of parseAllDocuments(readFileSync(f, 'utf8'))) {
      const o = d.toJS();
      if (!o || typeof o !== 'object') continue;
      seen++;
      const at = `${relative(DIR, f)} ${o.kind}/${o.metadata?.name}`;
      assert.equal(o.metadata?.labels?.[SWEEP_LABEL], undefined, `${at}: 임시 정책 이름표 ${SWEEP_LABEL}가 있다`);
      assert.ok(!String(o.metadata?.name ?? '').startsWith('peaket-sweep-'), `${at}: 임시 정책 이름(peaket-sweep-…)이다`);
    }
  assert.ok(seen > 0, '읽은 객체가 0개다');
});

// ===================== BAT-058 WS1~WS4(HOT-405) =====================
// 정본 docs/infra.md §4.1 '프록시 일꾼 수와 파드 CPU'(추천 적용 2026-11-18, BAT-058 계획, ADR-0287 결정 1~3, 소유자 결정 OPEN[49] (가)):
// EnvoyProxy 두 개(peaket-proxy·peaket-proxy-queue) 모두 spec.concurrency에 일꾼 수를 적고 그 값은 envoy 컨테이너 CPU 요청(코어)과 같다. 지금은 둘 다 2 [가정].
// CPU 요청이 정수 코어가 아니면 일꾼 수는 내린 정수이고 1 이상. envoy 컨테이너 resources는 requests { cpu: "2", memory: 512Mi }이고 한도는 두지 않는다.
// spec.extraArgs로 --concurrency·--cpuset-threads를 겹쳐 걸지 않는다.

/** 정본의 파드 CPU(코어)이자 일꾼 수 */
const POD_CPU_CORES = 2;
const PROXY_WORKERS = 2;
/** 메모리 요청(Envoy Gateway 기본 요청을 다시 적은 값) */
const PROXY_MEMORY_REQUEST = '512Mi';
/** 정본의 EnvoyProxy 두 개 */
const ENVOY_PROXIES = ['peaket-proxy', 'peaket-proxy-queue'];
/** Envoy 명령줄의 일꾼 수 인자(붙여 쓴 --concurrency=2, 한 칸에 값까지 쓴 '--concurrency 2' 포함) */
const WORKER_ARG = /^-{1,2}(?:concurrency|cpuset-threads)(?:$|[=\s])/;

const envoyProxy = (name) => byKind('EnvoyProxy').find((p) => p.metadata?.name === name);
const envoyResources = (p) => p?.spec?.provider?.kubernetes?.envoyDeployment?.container?.resources;
/** Kubernetes CPU 양(`"2"`, `2000m`, `1.5`)을 코어 수로. 모르는 꼴이면 NaN */
function cpuCores(q) {
  const s = String(q ?? '');
  if (/^\d+m$/.test(s)) return Number(s.slice(0, -1)) / 1000;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  return Number.NaN;
}

test('V-T43 ① HOT-405 WS 시험 바탕: CPU 양 읽기("2"·2000m은 2코어, 1500m은 1.5)', () => {
  assert.equal(cpuCores('2'), 2);
  assert.equal(cpuCores('2000m'), 2);
  assert.equal(cpuCores(2), 2);
  assert.equal(cpuCores('1500m'), 1.5);
  assert.ok(Number.isNaN(cpuCores(undefined)));
  assert.ok(Number.isNaN(cpuCores('2Gi')));
});

for (const name of ENVOY_PROXIES) {
  test(`V-T43 ① HOT-405 WS1 EnvoyProxy ${name}의 spec.concurrency(일꾼 수)가 2다`, () => {
    requireDefinitions();
    const p = envoyProxy(name);
    assert.ok(p, `deploy/gateways에 EnvoyProxy ${name}이 없다`);
    assert.equal(p.spec?.concurrency, PROXY_WORKERS, `${p.__file} EnvoyProxy ${name}: spec.concurrency ${JSON.stringify(p.spec?.concurrency)}(정하지 않으면 노드 CPU 수만큼 생긴다)`);
  });

  test(`V-T43 ① HOT-405 WS2 EnvoyProxy ${name}의 envoy 컨테이너는 CPU 요청 2코어(= 일꾼 수)·메모리 요청 512Mi이고 한도가 없다`, () => {
    requireDefinitions();
    const p = envoyProxy(name);
    assert.ok(p, `deploy/gateways에 EnvoyProxy ${name}이 없다`);
    const res = envoyResources(p);
    assert.ok(res && typeof res === 'object', `${name}: spec.provider.kubernetes.envoyDeployment.container.resources가 없다`);
    const cores = cpuCores(res.requests?.cpu);
    assert.equal(cores, POD_CPU_CORES, `${name}: requests.cpu ${JSON.stringify(res.requests?.cpu)}가 ${POD_CPU_CORES}코어가 아니다`);
    // 일꾼 수 = CPU 요청을 내린 정수(1 이상)
    assert.equal(p.spec?.concurrency, Math.max(1, Math.floor(cores)), `${name}: 일꾼 수 ${p.spec?.concurrency}가 CPU 요청 ${res.requests?.cpu}와 맞지 않는다`);
    assert.equal(res.requests?.memory, PROXY_MEMORY_REQUEST, `${name}: requests.memory ${JSON.stringify(res.requests?.memory)}(resources를 적으면 Envoy Gateway 기본 512Mi가 빠진다)`);
    assert.equal(res.limits?.cpu, undefined, `${name}: CPU 한도 ${JSON.stringify(res.limits?.cpu)}가 있다`);
    assert.equal(res.limits?.memory, undefined, `${name}: 메모리 한도 ${JSON.stringify(res.limits?.memory)}가 있다`);
    assert.deepEqual(Object.keys(res.limits ?? {}), [], `${name}: 한도 칸이 있다 ${JSON.stringify(res.limits)}`);
  });
}

test('V-T43 ① HOT-405 WS3 다섯 게이트웨이가 받는 EnvoyProxy(자기 parametersRef, 없으면 GatewayClass의 것)의 일꾼 수가 모두 2다', () => {
  requireDefinitions();
  const seen = [];
  for (const g of byKind('Gateway')) {
    const gw = g.metadata?.name;
    if (!GATEWAYS.includes(gw)) continue;
    const own = g.spec?.infrastructure?.parametersRef;
    let ref;
    if (own?.kind === 'EnvoyProxy') ref = own.name;
    else {
      const cls = byKind('GatewayClass').find((c) => c.metadata?.name === g.spec?.gatewayClassName);
      assert.ok(cls, `${gw}: GatewayClass ${g.spec?.gatewayClassName}가 없다`);
      assert.equal(cls.spec?.parametersRef?.kind, 'EnvoyProxy', `${gw}: GatewayClass ${cls.metadata?.name}에 EnvoyProxy parametersRef가 없다`);
      ref = cls.spec.parametersRef.name;
    }
    const p = envoyProxy(ref);
    assert.ok(p, `${gw}: 받는 EnvoyProxy ${ref}가 deploy/gateways에 없다`);
    assert.equal(p.spec?.concurrency, PROXY_WORKERS, `${gw}: 받는 EnvoyProxy ${ref}의 spec.concurrency ${JSON.stringify(p.spec?.concurrency)}`);
    assert.equal(cpuCores(envoyResources(p)?.requests?.cpu), POD_CPU_CORES, `${gw}: 받는 EnvoyProxy ${ref}의 CPU 요청`);
    seen.push(gw);
  }
  assert.deepEqual(seen.sort(), [...GATEWAYS].sort(), '다섯 게이트웨이를 모두 보지 못했다');
});

test('V-T43 ① HOT-405 WS4 어느 EnvoyProxy의 extraArgs에도 --concurrency·--cpuset-threads가 없다(형식 칸과 겹쳐 걸지 않음)', () => {
  requireDefinitions();
  const files = allYaml(DIR);
  let proxies = 0;
  for (const f of files)
    for (const d of parseAllDocuments(readFileSync(f, 'utf8'))) {
      const o = d.toJS();
      if (!o || typeof o !== 'object' || o.kind !== 'EnvoyProxy') continue;
      proxies++;
      const args = findKey(o, 'extraArgs')
        .flat()
        .map((x) => String(x).trim());
      const bad = args.filter((x) => WORKER_ARG.test(x));
      assert.deepEqual(bad, [], `${relative(DIR, f)} EnvoyProxy/${o.metadata?.name}: extraArgs에 일꾼 수 인자가 있다(${JSON.stringify(args)})`);
    }
  assert.ok(proxies >= ENVOY_PROXIES.length, `본 EnvoyProxy가 ${proxies}개다`);
});

test('V-T43 ① HOT-405 WS4 시험 바탕: 일꾼 수 인자 꼴을 가린다', () => {
  for (const x of ['--concurrency', '--concurrency=32', '--concurrency 2', '--cpuset-threads', '-concurrency']) assert.ok(WORKER_ARG.test(x), x);
  for (const x of ['--component-log-level', '--concurrencyx', '2', '--log-level']) assert.ok(!WORKER_ARG.test(x), x);
});
