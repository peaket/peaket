// 게이트웨이 한도·오류 본문·웹훅 경로·컨트롤러 설정의 정적 시험(BUILD_ORDER HOT-410, 묶음 BAT-060 계획 §6의 '정' 층, D-T43 ①·D-T50 ①~⑥,
// docs/security/asvs/delivery.md 16.5.1). 파일만 읽는다: deploy/gateways/*.yaml(손으로 쓴 정의와 생성 파일 *.routes.yaml)과
// 컨트롤러 설정 deploy/gateways/controller/envoy-gateway.yaml.
// 정본: docs/infra.md §4.1 '경로별 메서드·한도·게이트웨이 오류'('웹훅 경로'·'전역 레이트 리밋 걸기'·'열림 경보'·'게이트웨이 오류의 Problem'),
// docs/api/guidelines.md §2 '게이트웨이 Problem의 요청별 값'·§6, docs/architecture.md §4 '전역 레이트 리밋 서비스', docs/devops.md §14 D-T43·D-T50,
// docs/features/payment.md §5 '웹훅 받기의 첫 구현'(본문 상한은 payment-svc와 같은 64KB = 65,536바이트).
// 시험 값(60·600·30회/분, 웹훅 초당 100건, 65,536바이트, 복제 2, 키 접두사 rl:, 판정 시간 상한 20ms, 상태 문구)은 코드·YAML에서 가져오지 않고 정본 값을 적는다.
// 정책이 라우트에 닿는 법은 Envoy Gateway v1.10의 차례를 따른다: 라우트에 건 정책이 있으면 그것(mergeType이 있으면 게이트웨이 정책과 합침),
// 없으면 부모 게이트웨이에 건 정책. 대상은 targetRefs(이름)나 targetSelectors(이름표)로 고른다(나뉜 생성 라우트 <이름>-2에도 닿는지 본다).
// 실행(저장소 뿌리): node --test "deploy/gateways/test/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(HERE, '..');
const REPO = resolve(DIR, '..', '..');
const CONTROLLER_FILE = join(DIR, 'controller', 'envoy-gateway.yaml');

// ---- 정본 값 ----
const GATEWAYS = ['gw-queue', 'gw-fan', 'gw-partner', 'gw-ops', 'gw-scanner'];
const API_HOST = { 'gw-queue': 'queue.peaket.example', 'gw-fan': 'api.peaket.example', 'gw-partner': 'partner-api.peaket.example', 'gw-ops': 'ops-api.peaket.example', 'gw-scanner': 'scanner-api.peaket.example' };
/** 게이트웨이가 만든 응답의 상태와 HTTP 상태 문구(docs/infra.md §4.1 '게이트웨이 오류의 Problem') */
const PROBLEM_TITLES = { 404: 'Not Found', 413: 'Content Too Large', 429: 'Too Many Requests', 503: 'Service Unavailable' };
/** 전역 한도를 거는 원천 라우트(그 밖의 라우트에는 걸지 않는다, infra §4.1 '전역 레이트 리밋 걸기') */
const GLOBAL_ROUTES = ['gw-fan-api', 'gw-fan-identity', 'gw-partner-api'];
const WEBHOOK_ROUTE = 'gw-partner-webhooks';
const WEBHOOK_PATHS = ['/v1/webhooks/toss', '/v1/webhooks/portone'];
const WEBHOOK_BODY_BYTES = 65536;
const ROUTE_LABEL = 'peaket.io/route';
const USER_HEADER = 'x-user-id';

// ---- 읽기 ----
function loadObjects() {
  if (!existsSync(DIR)) return [];
  const out = [];
  for (const f of readdirSync(DIR).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    for (const d of parseAllDocuments(readFileSync(join(DIR, f), 'utf8'))) {
      if (d.errors.length) throw new Error(`${f}: ${d.errors[0].message}`);
      const o = d.toJS();
      if (o && typeof o === 'object') out.push({ ...o, __file: f });
    }
  }
  return out;
}
const OBJECTS = loadObjects();

function requireDefinitions() {
  assert.ok(OBJECTS.length > 0, `deploy/gateways/*.yaml에 게이트웨이 정의가 없다(${DIR})`);
}
/** 컨트롤러 설정(EnvoyGateway 객체 하나) */
function controller() {
  assert.ok(existsSync(CONTROLLER_FILE), `컨트롤러 설정 파일이 없다: ${CONTROLLER_FILE}`);
  const docs = parseAllDocuments(readFileSync(CONTROLLER_FILE, 'utf8')).map((d) => d.toJS()).filter(Boolean);
  assert.equal(docs.length, 1, `컨트롤러 설정은 객체 하나다(${docs.length}개)`);
  return docs[0];
}

const lc = (s) => String(s).toLowerCase();
const byKind = (kind) => OBJECTS.filter((o) => o.kind === kind);
const named = (kind, name) => byKind(kind).find((o) => o.metadata?.name === name);
const routes = () => byKind('HTTPRoute');
const routesOf = (gw) => routes().filter((r) => (r.spec?.parentRefs ?? []).some((p) => p.name === gw));
/** 원천 이름(생성 라우트는 이름표, 손으로 쓴 라우트는 이름) */
const sourceName = (r) => r.metadata?.labels?.[ROUTE_LABEL] ?? r.metadata?.name;
const routesFrom = (name) => routes().filter((r) => sourceName(r) === name);
const normKey = (k) => lc(k).replaceAll('_', '');
function findKey(obj, key, out = []) {
  if (Array.isArray(obj)) for (const v of obj) findKey(v, key, out);
  else if (obj && typeof obj === 'object')
    for (const [k, v] of Object.entries(obj)) {
      if (normKey(k) === normKey(key)) out.push(v);
      findKey(v, key, out);
    }
  return out;
}

/** 정책이 객체(라우트·게이트웨이)를 고르는가: targetRefs·targetRef의 이름, targetSelectors의 종류·이름표 */
function targets(p, obj) {
  const refs = [...(p.spec?.targetRefs ?? []), ...(p.spec?.targetRef ? [p.spec.targetRef] : [])];
  if (refs.some((t) => t.kind === obj.kind && t.name === obj.metadata?.name)) return true;
  const labels = obj.metadata?.labels ?? {};
  return (p.spec?.targetSelectors ?? []).some((s) => s.kind === obj.kind && Object.entries(s.matchLabels ?? {}).every(([k, v]) => labels[k] === v) && Object.keys(s.matchLabels ?? {}).length > 0);
}
const gatewayPolicies = (kind, gw) => byKind(kind).filter((p) => targets(p, { kind: 'Gateway', metadata: { name: gw } }));
/** 라우트에 닿는 정책(라우트 정책이 있으면 그것, mergeType이 있으면 게이트웨이 정책과 함께, 없으면 게이트웨이 정책) */
function effective(kind, route) {
  const own = byKind(kind).filter((p) => targets(p, route));
  const parents = (route.spec?.parentRefs ?? []).flatMap((x) => gatewayPolicies(kind, x.name));
  if (!own.length) return parents;
  if (own.some((p) => p.spec?.mergeType)) return [...own, ...parents];
  return own;
}

/** 경로 맞춤(Exact > 긴 PathPrefix > 정규식) */
function pathScore(match, method, path) {
  if (match.method && match.method !== method) return -1;
  const p = match.path ?? { type: 'PathPrefix', value: '/' };
  const v = p.value ?? '/';
  if (p.type === 'Exact') return v === path ? 100000 : -1;
  if (p.type === 'RegularExpression') return new RegExp(`^(?:${v})$`).test(path) ? 1 : -1;
  const pre = v.endsWith('/') ? v : `${v}/`;
  return path === v || path.startsWith(pre) || v === '/' ? 10 + v.length : -1;
}
function routeFor(gw, host, method, path) {
  let best = null;
  for (const route of routesOf(gw)) {
    if (!(route.spec?.hostnames ?? []).includes(host)) continue;
    for (const rule of route.spec?.rules ?? [])
      for (const m of rule.matches ?? [{}]) {
        const s = pathScore(m, method, path);
        if (s >= 0 && (!best || s > best.score)) best = { route, rule, match: m, score: s };
      }
  }
  return best;
}
/** 그 (메서드, 경로)를 받는 원천 라우트가 name인지 보고 라우트를 돌려준다 */
function routeOf(gw, method, path, name) {
  const hit = routeFor(gw, API_HOST[gw], method, path);
  assert.ok(hit, `${gw} ${method} ${path}를 받는 라우트가 없다`);
  assert.equal(sourceName(hit.route), name, `${gw} ${method} ${path}는 ${name}(원천)이 받아야 한다(받는 것: ${hit.route.metadata?.name})`);
  return hit;
}

// ---- 한도 규칙 ----

/** 정책들의 전역 규칙(정책 이름·차례를 붙여 같은 버킷인지 견줄 수 있게) */
const globalRules = (policies) => policies.flatMap((p) => (p.spec?.rateLimit?.global?.rules ?? []).map((rule, i) => ({ policy: p.metadata?.name, index: i, rule })));
const localRules = (policies) => policies.flatMap((p) => (p.spec?.rateLimit?.local?.rules ?? []).map((rule, i) => ({ policy: p.metadata?.name, index: i, rule })));
const selectors = (rule) => rule.clientSelectors ?? [];
/** 판정 키가 X-User-Id 머리의 Distinct인가 */
const byUser = (rule) => selectors(rule).some((s) => (s.headers ?? []).some((h) => lc(h.name) === USER_HEADER && h.type === 'Distinct' && !h.invert));
function selectorPathMatches(p, path) {
  const v = p.value ?? '/';
  let ok;
  if (p.type === 'Exact') ok = v === path;
  else if (p.type === 'RegularExpression') ok = new RegExp(`^(?:${v})$`).test(path);
  else ok = v === '/' || path === v || path.startsWith(v.endsWith('/') ? v : `${v}/`);
  return p.invert ? !ok : ok;
}
/** 규칙이 그 요청(토큰 있음)에 닿는가: 고르개마다 경로·메서드 조건을 본다(나머지 머리·주소 조건은 맞는다고 본다) */
function ruleApplies(rule, method, path) {
  return selectors(rule).every((s) => {
    if (s.path && !selectorPathMatches(s.path, path)) return false;
    if (s.methods?.length) {
      const hit = s.methods.some((m) => (typeof m === 'string' ? m : m.value) === method);
      const inverted = s.methods.every((m) => typeof m === 'object' && m.invert);
      if (inverted ? hit : !hit) return false;
    }
    return true;
  });
}
/** 그 (게이트웨이, 메서드, 경로)에 닿는 전역 규칙 */
function applyingGlobal(gw, method, path, name) {
  const { route } = routeOf(gw, method, path, name);
  return globalRules(effective('BackendTrafficPolicy', route)).filter((g) => ruleApplies(g.rule, method, path));
}
const ruleId = (g) => `${g.policy}#${g.index}`;

// ===================== 게이트웨이 오류의 Problem(D-T43 ①, ASVS 16.5.1) =====================

/** 상태 코드 목록(Value·Range) */
function codesOf(entry) {
  return findKey(entry.match ?? {}, 'statusCodes')
    .flat()
    .flatMap((c) => {
      if (typeof c === 'number') return [c];
      if (c?.range) return Array.from({ length: Number(c.range.end) - Number(c.range.start) + 1 }, (_, i) => Number(c.range.start) + i);
      return [Number(c?.value)];
    });
}
const overrides = (policies) => policies.flatMap((p) => (p.spec?.responseOverride ?? []).map((o) => ({ policy: p.metadata?.name, o })));
const inlineBody = (o) => findKey(o.response ?? {}, 'inline').find((v) => typeof v === 'string');

/** 정책들의 responseOverride가 네 상태마다 고정 Problem 본문을 게이트웨이가 만든 응답에만 내는지 */
function assertProblemOverrides(policies, where) {
  const list = overrides(policies);
  assert.ok(list.length > 0, `${where}: responseOverride가 없다`);
  for (const [code, title] of Object.entries(PROBLEM_TITLES)) {
    const first = list.find(({ o }) => codesOf(o).includes(Number(code)));
    assert.ok(first, `${where}: ${code}의 responseOverride가 없다`);
    const { o, policy } = first;
    assert.deepEqual(findKey(o, 'source'), ['Local'], `${where} ${code}(${policy}): source가 게이트웨이가 만든 응답만(Local)이 아니다`);
    assert.equal(o.response?.contentType, 'application/problem+json', `${where} ${code}(${policy}): 형식`);
    const body = inlineBody(o);
    assert.ok(typeof body === 'string', `${where} ${code}(${policy}): 고정 본문(inline)이 없다`);
    let parsed;
    assert.doesNotThrow(() => (parsed = JSON.parse(body)), `${where} ${code}: 본문이 JSON이 아니다 ${body}`);
    assert.deepEqual(parsed, { type: 'about:blank', title, status: Number(code) }, `${where} ${code}: 본문`);
  }
}

test('D-T43 ① 다섯 게이트웨이 모두 404·413·429·503에 같은 고정 본문의 responseOverride가 있고 source가 게이트웨이가 만든 응답만(Local)이다(게이트웨이 각각, 라우트 각각)', () => {
  requireDefinitions();
  for (const gw of GATEWAYS) {
    // 라우트에 맞지 않은 요청(없는 경로)에도 닿도록 게이트웨이에 건다
    assertProblemOverrides(gatewayPolicies('BackendTrafficPolicy', gw), `${gw}(게이트웨이)`);
    const rs = routesOf(gw);
    assert.ok(rs.length > 0, `${gw}: 라우트가 없다`);
    // 라우트에 따로 건 BackendTrafficPolicy(한도 등)가 게이트웨이 정책을 가리면 그 라우트에서 빠진다
    for (const r of rs) assertProblemOverrides(effective('BackendTrafficPolicy', r), `${gw}/${r.metadata?.name}`);
  }
});

test('[ASVS v5.0.0-16.5.1] 게이트웨이가 만든 Problem 본문에 detail·instance·경로·서비스 이름·치환 명령이 없고 type·title·status만 있다', () => {
  requireDefinitions();
  const all = overrides(byKind('BackendTrafficPolicy'));
  assert.ok(all.length > 0, 'responseOverride가 하나도 없다');
  for (const { policy, o } of all) {
    const body = inlineBody(o);
    assert.ok(typeof body === 'string', `${policy}: 고정 본문이 없다`);
    const parsed = JSON.parse(body);
    assert.deepEqual(Object.keys(parsed).sort(), ['status', 'title', 'type'], `${policy}: 본문 칸 ${Object.keys(parsed)}`);
    for (const bad of [/detail/i, /instance/i, /\/v1\//, /\/internal/, /-svc\b/, /envoy/i, /upstream/i, /%[A-Z_()]+%/, /traceId/i]) assert.doesNotMatch(body, bad, `${policy}: 본문 ${body}`);
  }
});

// ===================== 전역 레이트 리밋(D-T50 ①~⑤) =====================

test('D-T50 ① gw-fan-api·gw-fan-identity 두 라우트의 전역 한도는 X-User-Id Distinct·60·Minute·shared 한 버킷이고 다른 전역 규칙이 닿지 않는다', () => {
  requireDefinitions();
  const cases = [
    ['GET', '/v1/tickets', 'gw-fan-api'],
    ['GET', '/v1/events/e1/review-eligibility', 'gw-fan-api'],
    ['GET', '/v1/identity/me', 'gw-fan-identity'],
    ['GET', '/v1/identity/sessions', 'gw-fan-identity'],
  ];
  const ids = new Set();
  for (const [method, path, name] of cases) {
    const gs = applyingGlobal('gw-fan', method, path, name);
    assert.equal(gs.length, 1, `${method} ${path}: 닿는 전역 규칙이 하나가 아니다(${gs.length})`);
    const { rule } = gs[0];
    assert.ok(byUser(rule), `${method} ${path}: 판정 키가 X-User-Id Distinct가 아니다 ${JSON.stringify(rule.clientSelectors)}`);
    assert.equal(rule.limit?.requests, 60, `${method} ${path}: 한도 건수`);
    assert.equal(rule.limit?.unit, 'Minute', `${method} ${path}: 단위`);
    assert.equal(rule.shared, true, `${method} ${path}: shared가 아니다(경로마다 버킷)`);
    ids.add(ruleId(gs[0]));
  }
  assert.equal(ids.size, 1, `두 라우트가 한 정책의 한 규칙(한 버킷)을 쓰지 않는다: ${[...ids]}`);
  // 나뉜 생성 라우트(<이름>-2 …)에도 같은 정책이 닿는다
  for (const name of ['gw-fan-api', 'gw-fan-identity']) {
    const rs = routesFrom(name);
    assert.ok(rs.length > 0, `${name} 라우트가 없다`);
    for (const r of rs) assert.ok(globalRules(effective('BackendTrafficPolicy', r)).some((g) => ids.has(ruleId(g))), `${r.metadata?.name}: 60회 버킷 정책이 닿지 않는다`);
  }
});

test('D-T50 ① gw-partner-api의 전역 한도는 X-User-Id Distinct·600·Minute·shared 한 버킷이고 리포트 조회만 30·Minute가 더 닿는다', () => {
  requireDefinitions();
  const report = applyingGlobal('gw-partner', 'GET', '/v1/partner/events/e1/report', 'gw-partner-api');
  const other = applyingGlobal('gw-partner', 'PATCH', '/v1/partner/events/e1', 'gw-partner-api');
  const team = applyingGlobal('gw-partner', 'POST', '/v1/partner/productions/p1/events', 'gw-partner-api');
  for (const [label, gs] of [['리포트', report], ['회차 고치기', other], ['회차 만들기', team]]) {
    const g600 = gs.filter((g) => g.rule.limit?.requests === 600);
    assert.equal(g600.length, 1, `${label}: 600회 규칙이 하나가 아니다 ${JSON.stringify(gs.map((g) => g.rule.limit))}`);
    assert.equal(g600[0].rule.limit?.unit, 'Minute', `${label}: 600회 단위`);
    assert.ok(byUser(g600[0].rule), `${label}: 600회 판정 키가 X-User-Id Distinct가 아니다`);
    assert.equal(g600[0].rule.shared, true, `${label}: 600회가 shared가 아니다(경로마다 버킷)`);
  }
  assert.equal(new Set([report, other, team].map((gs) => ruleId(gs.find((g) => g.rule.limit?.requests === 600)))).size, 1, '파트너 경로들이 한 600회 버킷을 쓰지 않는다');
  const g30 = report.filter((g) => g.rule.limit?.requests === 30);
  assert.equal(g30.length, 1, `리포트 조회에 30회 규칙이 없다 ${JSON.stringify(report.map((g) => g.rule.limit))}`);
  assert.equal(g30[0].rule.limit?.unit, 'Minute', '리포트 30회 단위');
  assert.ok(byUser(g30[0].rule), '리포트 30회 판정 키가 X-User-Id Distinct가 아니다');
  assert.equal(report.length, 2, `리포트 조회에 닿는 전역 규칙은 600·30 둘이다(${report.length})`);
  for (const [label, gs] of [['회차 고치기', other], ['회차 만들기', team]]) assert.equal(gs.length, 1, `${label}: 리포트 30회가 다른 경로에도 닿는다`);
});

test('D-T50 ⑤ gw-queue·gw-fan-buy·gw-fan-search·gw-ops·gw-scanner·gw-partner-webhooks 라우트에는 전역 한도가 붙지 않는다(라우트 각각, 그 밖의 라우트도)', () => {
  requireDefinitions();
  for (const name of ['gw-fan-buy', 'gw-fan-search', WEBHOOK_ROUTE]) assert.ok(routesFrom(name).length > 0, `${name} 라우트가 없다`);
  for (const gw of ['gw-queue', 'gw-ops', 'gw-scanner']) {
    assert.ok(routesOf(gw).length > 0, `${gw}: 라우트가 없다`);
    assert.deepEqual(globalRules(gatewayPolicies('BackendTrafficPolicy', gw)), [], `${gw}: 게이트웨이에 전역 한도를 걸었다`);
  }
  let checked = 0;
  for (const r of routes()) {
    if (GLOBAL_ROUTES.includes(sourceName(r))) continue;
    const gs = globalRules(effective('BackendTrafficPolicy', r));
    assert.deepEqual(gs, [], `${r.metadata?.name}(원천 ${sourceName(r)}): 전역 한도가 닿는다`);
    checked++;
  }
  assert.ok(checked > 0, '본 라우트가 없다');
});

test('D-T50 ⑤ 전역 한도 규칙은 모두 X-User-Id Distinct로 골라 토큰 없는 요청(머리 없음)은 세지 않는다', () => {
  requireDefinitions();
  const all = globalRules(byKind('BackendTrafficPolicy'));
  assert.ok(all.length > 0, '전역 한도 규칙이 하나도 없다');
  for (const g of all) {
    assert.ok(byUser(g.rule), `${ruleId(g)}: X-User-Id Distinct 고르개가 없다 ${JSON.stringify(g.rule.clientSelectors)}`);
    // 계정을 모아 세는 고르개(머리 없음 뒤집기, Exact 값 하나로 모두 묶기)를 두지 않는다
    for (const s of selectors(g.rule)) for (const h of s.headers ?? []) if (lc(h.name) === USER_HEADER) assert.ok(h.type === 'Distinct' && !h.invert, `${ruleId(g)}: ${JSON.stringify(h)}`);
  }
});

test('D-T50 ③ failClosed가 켜져 있지 않고 판정 시간 상한을 기본 20ms에서 바꾸지 않는다(열림)', () => {
  requireDefinitions();
  assert.ok(globalRules(byKind('BackendTrafficPolicy')).length > 0, '전역 한도 규칙이 하나도 없다(열림을 볼 것이 없다)');
  const cfg = controller();
  for (const o of [...OBJECTS, cfg]) for (const v of findKey(o.spec ?? o, 'failClosed')) assert.notEqual(v, true, `${o.metadata?.name ?? 'EnvoyGateway'}: failClosed가 켜져 있다`);
  for (const v of findKey(cfg.rateLimit ?? {}, 'timeout')) assert.equal(String(v), '20ms', `컨트롤러 rateLimit.timeout: ${v}`);
});

/** 컨트롤러 설정의 레이트 리밋 Redis 접속 판정: 문제 목록(비면 TLS로 붙는다) */
function redisTlsProblems(cfg) {
  const out = [];
  if (cfg?.kind !== 'EnvoyGateway') out.push(`kind가 EnvoyGateway가 아니다: ${cfg?.kind}`);
  const backend = cfg?.rateLimit?.backend;
  if (backend?.type !== 'Redis') out.push(`rateLimit.backend.type이 Redis가 아니다: ${backend?.type}`);
  const redis = backend?.redis;
  if (!redis || typeof redis.url !== 'string' || redis.url === '') out.push('rateLimit.backend.redis.url이 없다');
  else if (/^redis:\/\//i.test(redis.url)) out.push(`평문 주소(redis://): ${redis.url}`);
  const tls = redis?.tls;
  if (!tls || typeof tls !== 'object' || !(tls.certificateRef?.name || Object.keys(tls).length)) out.push('rateLimit.backend.redis.tls가 없다(평문 접속)');
  return out;
}

test('D-T50 ④ 컨트롤러 설정의 Redis 접속에 TLS가 없으면 정적 시험이 실패한다(TLS를 뺀 사본은 거부, 저장소 설정은 TLS)', () => {
  const cfg = controller();
  assert.deepEqual(redisTlsProblems(cfg), [], '저장소 컨트롤러 설정');
  const noTls = structuredClone(cfg);
  delete noTls.rateLimit.backend.redis.tls;
  assert.ok(redisTlsProblems(noTls).length > 0, 'TLS를 뺀 설정을 받아들였다');
  const plain = structuredClone(noTls);
  plain.rateLimit.backend.redis.url = 'redis://peaket-ratelimit-redis.envoy-gateway-system.svc.cluster.local:6379';
  assert.ok(redisTlsProblems(plain).length > 0, '평문 주소를 받아들였다');
  const emptyTls = structuredClone(cfg);
  emptyTls.rateLimit.backend.redis.tls = {};
  assert.ok(redisTlsProblems(emptyTls).length > 0, '빈 tls를 받아들였다');
  const noBackend = structuredClone(cfg);
  delete noBackend.rateLimit;
  assert.ok(redisTlsProblems(noBackend).length > 0, '레이트 리밋 백엔드가 없는 설정을 받아들였다');
});

test("HOT-410 infra §4.1 '전역 레이트 리밋 걸기' 컨트롤러 설정은 EnvoyGateway 하나이고 Lua를 켜며 GatewayClass의 컨트롤러 이름과 같고 레이트 리밋 서비스는 복제 2·키 접두사 rl:이다", () => {
  requireDefinitions();
  const cfg = controller();
  assert.equal(cfg.kind, 'EnvoyGateway');
  assert.equal(cfg.extensionApis?.enableLua, true, 'Lua 확장을 켜지 않았다(원본 확인·typ 검사 Lua가 서지 않는다)');
  const classes = byKind('GatewayClass');
  assert.ok(classes.length > 0, 'GatewayClass가 없다');
  for (const c of classes) assert.equal(cfg.gateway?.controllerName, c.spec?.controllerName, `${c.metadata?.name}: 컨트롤러 이름`);
  const deployment = cfg.provider?.kubernetes?.rateLimitDeployment;
  assert.ok(deployment, '레이트 리밋 서비스 배치(provider.kubernetes.rateLimitDeployment)가 없다');
  assert.ok(findKey(deployment, 'replicas').includes(2), `레이트 리밋 서비스 복제가 2가 아니다: ${JSON.stringify(findKey(deployment, 'replicas'))}`);
  const strings = [];
  (function walk(v) {
    if (typeof v === 'string') strings.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  })(cfg);
  assert.ok(strings.includes('rl:'), '카운터 키 접두사 rl:을 주지 않는다(docs/data.md §3)');
});

// ===================== 웹훅 경로(D-T50 ⑥) =====================

test("HOT-410 infra §4.1 '웹훅 경로' 웹훅 두 경로는 gw-partner partner-api의 gw-partner-webhooks에서 payment-svc 앱 포트(8080)로 가고 Exact·POST 맞춤이며, 토큰 확인은 /v1/partner/… 라우트에 그대로다", () => {
  requireDefinitions();
  for (const path of WEBHOOK_PATHS) {
    const hit = routeOf('gw-partner', 'POST', path, WEBHOOK_ROUTE);
    assert.deepEqual(hit.match.path, { type: 'Exact', value: path }, `${path}: Exact 맞춤이 아니다`);
    assert.equal(hit.match.method, 'POST', `${path}: 메서드`);
    assert.deepEqual((hit.rule.backendRefs ?? []).map((b) => [b.name, b.port]), [['payment-svc', 8080]], `${path}: 백엔드`);
    assert.deepEqual(hit.route.spec?.hostnames, ['partner-api.peaket.example'], `${path}: 호스트`);
    // 계약 밖 메서드(GET·PUT·DELETE 각각)는 서비스에 닿지 않고 게이트웨이 404로 끝난다(infra §4.1 '메서드가 맞지 않는 요청', '호스트와 내부 경로'의
    // <게이트웨이>-not-found, BAT-060 시험 이의 1 판단): 맞는 규칙이 없거나, 맞은 규칙에 백엔드가 없고 그 필터가 404 Problem 직접 응답이다
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const other = routeFor('gw-partner', 'partner-api.peaket.example', method, path);
      if (!other) continue;
      const where = `${method} ${path}(${other.route.metadata?.name})`;
      assert.deepEqual(other.rule.backendRefs ?? [], [], `${where}: 계약 밖 메서드가 백엔드로 간다`);
      const direct = (other.rule.filters ?? []).filter((f) => f.type === 'ExtensionRef' && f.extensionRef?.kind === 'HTTPRouteFilter').map((f) => named('HTTPRouteFilter', f.extensionRef.name)?.spec?.directResponse);
      assert.equal(direct.length, 1, `${where}: 직접 응답 필터가 하나가 아니다(${direct.length})`);
      assert.equal(Number(direct[0]?.statusCode), 404, `${where}: 직접 응답 상태`);
      assert.equal(direct[0]?.contentType, 'application/problem+json', `${where}: 직접 응답 형식`);
      assert.deepEqual(JSON.parse(findKey(direct[0]?.body ?? {}, 'inline')[0] ?? 'null'), { type: 'about:blank', title: 'Not Found', status: 404 }, `${where}: 직접 응답 본문`);
    }
  }
  // 웹훅 라우트는 웹훅 두 경로만 받는다
  for (const r of routesFrom(WEBHOOK_ROUTE))
    for (const rule of r.spec?.rules ?? []) for (const m of rule.matches ?? [{}]) assert.ok(WEBHOOK_PATHS.includes(m.path?.value), `${r.metadata?.name}: 웹훅 밖 경로 ${JSON.stringify(m.path)}`);
  // 파트너 API의 토큰 확인은 그대로다(웹훅 앞부분까지 넓히거나 /v1/partner/…를 열지 않는다)
  const partner = routeOf('gw-partner', 'POST', '/v1/partner/productions/p1/events', 'gw-partner-api');
  const sp = effective('SecurityPolicy', partner.route);
  assert.ok(sp.some((p) => (p.spec?.jwt?.providers ?? []).length > 0), 'gw-partner-api에 토큰 확인이 없다');
});

test('D-T50 ⑥ 웹훅 라우트의 로컬 한도는 sourceCIDR Distinct IPv4·IPv6 두 규칙이고 둘 다 100·Second, 전역 한도·토큰 확인·출처 확인·CORS가 없다', () => {
  requireDefinitions();
  const rs = routesFrom(WEBHOOK_ROUTE);
  assert.ok(rs.length > 0, `${WEBHOOK_ROUTE} 라우트가 없다`);
  for (const r of rs) {
    const btp = effective('BackendTrafficPolicy', r);
    const local = localRules(btp);
    const perIp = local.filter((g) => selectors(g.rule).some((s) => s.sourceCIDR?.type === 'Distinct'));
    assert.equal(perIp.length, 2, `${r.metadata?.name}: IP마다 세는 규칙은 IPv4·IPv6 둘이다(${perIp.length})`);
    assert.equal(local.length, 2, `${r.metadata?.name}: IP 한도 밖의 로컬 규칙이 있다`);
    assert.deepEqual(perIp.map((g) => selectors(g.rule).find((s) => s.sourceCIDR?.type === 'Distinct').sourceCIDR.value).sort(), ['0.0.0.0/0', '::/0'], `${r.metadata?.name}: 덮는 주소`);
    for (const g of perIp) {
      assert.equal(g.rule.limit?.requests, 100, `${r.metadata?.name} ${ruleId(g)}: 초당 건수`);
      assert.equal(g.rule.limit?.unit, 'Second', `${r.metadata?.name} ${ruleId(g)}: 단위`);
    }
    assert.deepEqual(globalRules(btp), [], `${r.metadata?.name}: 전역 한도가 닿는다`);
    for (const p of effective('SecurityPolicy', r)) {
      assert.equal(p.spec?.jwt, undefined, `${r.metadata?.name}(${p.metadata?.name}): 토큰 확인이 있다`);
      assert.equal(p.spec?.csrf, undefined, `${r.metadata?.name}(${p.metadata?.name}): 출처 확인이 있다`);
      assert.equal(p.spec?.cors, undefined, `${r.metadata?.name}(${p.metadata?.name}): CORS가 있다`);
      assert.deepEqual(findKey(p.spec?.authorization ?? {}, 'jwt'), [], `${r.metadata?.name}(${p.metadata?.name}): 토큰 주체를 요구하는 인가`);
    }
  }
});

/** 쿠버네티스 수량(65536·64Ki·64k)을 바이트로 */
function bytes(q) {
  if (typeof q === 'number') return q;
  const m = /^(\d+)(Ki|Mi|Gi|k|M|G)?$/.exec(String(q).trim());
  assert.ok(m, `수량 꼴을 읽지 못했다: ${q}`);
  const unit = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, k: 1000, M: 1000 ** 2, G: 1000 ** 3 }[m[2]] ?? 1;
  return Number(m[1]) * unit;
}

test("HOT-410 infra §4.1 '웹훅 경로' 웹훅 라우트의 게이트웨이 본문 상한은 payment-svc와 같은 64KB(65,536바이트)이고 본문 전체를 받아 상한을 지킨다", () => {
  requireDefinitions();
  const rs = routesFrom(WEBHOOK_ROUTE);
  assert.ok(rs.length > 0, `${WEBHOOK_ROUTE} 라우트가 없다`);
  for (const r of rs) {
    const buffers = effective('BackendTrafficPolicy', r)
      .map((p) => p.spec?.requestBuffer)
      .filter(Boolean);
    assert.equal(buffers.length, 1, `${r.metadata?.name}: requestBuffer가 하나가 아니다(${buffers.length})`);
    assert.equal(bytes(buffers[0].limit), WEBHOOK_BODY_BYTES, `${r.metadata?.name}: 본문 상한`);
    assert.notEqual(bytes(buffers[0].limit), WEBHOOK_BODY_BYTES - 1);
    // LimitOnly는 흘려보내는 본문을 막지 못한다(CRD 설명). 기본(BufferAndLimit)이어야 상한이 된다
    assert.ok(buffers[0].mode === undefined || buffers[0].mode === 'BufferAndLimit', `${r.metadata?.name}: requestBuffer.mode ${buffers[0].mode}`);
  }
});

test('HOT-410 저장소 openapi의 웹훅 두 경로는 POST만 있고 인증 없는(security: []) 작업이다(게이트웨이가 토큰을 묻지 않는 근거)', () => {
  const openapi = parse(readFileSync(join(REPO, 'docs', 'api', 'openapi.yaml'), 'utf8'));
  for (const p of WEBHOOK_PATHS) {
    const item = openapi.paths?.[p];
    assert.ok(item, `openapi에 ${p}가 없다`);
    assert.deepEqual(Object.keys(item).filter((k) => ['get', 'put', 'post', 'delete', 'patch', 'options', 'head'].includes(k)), ['post'], `${p}: 메서드`);
    assert.deepEqual(item.post.security, [], `${p}: security`);
  }
});
