// 게이트웨이 차단 상한(서킷 브레이커)과 게이트웨이 503의 Retry-After 정적 시험(BUILD_ORDER BAS-090, 묶음 BAT-056 계획 §3의 S1~S5, V-T43 ①②).
// 파일만 읽는다: deploy/gateways/*.yaml(손으로 쓴 정의와 생성 라우트 *.routes.yaml). S5는 deploy/gateways 아래 모든 YAML을 읽는다.
// 정본: docs/infra.md §4.1 '게이트웨이 차단 상한'(자리와 칸·넘치면·첫 값·길게 쥐는 라우트·걸지 않는 것)과 '게이트웨이 오류의 Problem',
// docs/api/guidelines.md §2(게이트웨이가 과부하로 막으면 503과 Retry-After 필수), ADR-0009 결정 3(게이트웨이는 다시 보내지 않는다), docs/verification.md V-T43.
// 시험 값(Retry-After 2, gw-queue 2,400·2,400·300, 나머지 넷 6,000·6,000·750, 길게 쥐는 규칙 65,536, 429의 60·1, 상태 문구)은 YAML·코드 상수에서 가져오지 않고
// 정본 값을 적는다(docs/architecture.md §8.6 '자주 놓친 결함').
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
/** 첫 값(측정 전): gw-queue는 동시·연결 2,400과 보류 300, 나머지 넷은 동시·연결 6,000과 보류 750 */
const FIRST = {
  'gw-queue': { maxConnections: 2400, maxParallelRequests: 2400, maxPendingRequests: 300 },
  'gw-fan': { maxConnections: 6000, maxParallelRequests: 6000, maxPendingRequests: 750 },
  'gw-partner': { maxConnections: 6000, maxParallelRequests: 6000, maxPendingRequests: 750 },
  'gw-ops': { maxConnections: 6000, maxParallelRequests: 6000, maxPendingRequests: 750 },
  'gw-scanner': { maxConnections: 6000, maxParallelRequests: 6000, maxPendingRequests: 750 },
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

test('V-T43 ① 다섯 게이트웨이 정책의 circuitBreaker가 정본 첫 값이다', () => {
  requireDefinitions();
  for (const gw of GATEWAYS) {
    const withBreaker = BTP().filter((p) => p.spec?.circuitBreaker !== undefined && refsOf(p).some((t) => t.kind === 'Gateway' && t.name === gw));
    // 자리: 게이트웨이에 건 gw-<이름>-responses 하나(게이트웨이를 겨눈 다른 정책에 두면 둘이 부딪힌다)
    assert.deepEqual(withBreaker.map(nameOf), [`${gw}-responses`], `${gw}: circuitBreaker를 둔 게이트웨이 정책`);
    const b = withBreaker[0].spec.circuitBreaker;
    assert.deepEqual(Object.keys(b).sort(), [...BREAKER_KEYS].sort(), `${gw}: circuitBreaker 칸은 세 칸뿐이다(${Object.keys(b).join(', ')})`);
    assert.deepEqual(breakerTriple(b), FIRST[gw], `${gw}: 첫 값`);
    // 값의 식: 연결 = 동시, 보류 = ⌈동시 × q⌉ ≤ 동시
    assert.equal(b.maxConnections, b.maxParallelRequests, `${gw}: 연결 ≠ 동시`);
    assert.ok(b.maxPendingRequests <= b.maxParallelRequests, `${gw}: 보류 ${b.maxPendingRequests} > 동시 ${b.maxParallelRequests}`);
  }
});

// ===================== S3 =====================

test('V-T43 ① 관제 SSE 두 규칙만 상한을 65,536으로 올리고 결제 결과 롱 폴링 규칙은 게이트웨이 값이며 503 응답 고치기는 그대로 닿는다', () => {
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
  assert.deepEqual(breakerTriple(breakerOf(payEff)), FIRST['gw-fan'], `${payWhere}: 차단 상한은 게이트웨이 값 6,000·6,000·750이다`);
  assert503Override(payEff, payWhere);

  // 그 밖의 모든 규칙(다섯 게이트웨이의 모든 라우트): 65,536이 닿지 않고 게이트웨이 첫 값 그대로
  let others = 0;
  for (const gw of GATEWAYS)
    for (const r of routesOf(gw))
      for (const [i, rule] of (r.spec?.rules ?? []).entries()) {
        if (sse.some((s) => s.rule === rule)) continue;
        assert.deepEqual(breakerTriple(breakerOf(effectiveForRule(r, rule))), FIRST[gw], `${gw}/${r.metadata?.name}/rule/${i}${rule.name ? `(${rule.name})` : ''}: 차단 상한이 게이트웨이 값이 아니다`);
        others++;
      }
  assert.ok(others > 0, '본 다른 규칙이 0개다');
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
