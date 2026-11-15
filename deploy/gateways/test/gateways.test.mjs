// 게이트웨이 다섯(gw-queue·gw-fan·gw-partner·gw-ops·gw-scanner)의 정의 파일 정적 시험(BUILD_ORDER HOT-400, 묶음 BAT-055 계획 §6의 '정' 층).
// deploy/gateways/*.yaml(쿠버네티스 객체, 여러 문서를 ---로 이음)을 읽어 kind·metadata.name·spec만 본다(계획 §5).
// 정본: docs/infra.md §4.1 'Envoy 게이트웨이의 첫 구현'·§9 '응답 보안 헤더'·'접근 로그의 복귀 경로 쿼리', docs/architecture.md §4 'CSRF 확인 규칙',
// docs/features/identity.md §3 '발급자와 검증 규칙'·'공개키 배포', docs/observability.md §6 '신뢰 경계의 추적 문맥', docs/features/search.md §8 '첫 값',
// docs/security/authz-matrix.md §5.1, docs/features/queue-admission.md §3 '응답 헤더'.
// 시험 값(호스트·출처·HSTS·Max-Age 7200·캐시 300초·한도 50/100)은 코드에서 가져오지 않고 정본 값을 그대로 적는다(docs/architecture.md §8.6 '자주 놓친 결함').
// 같은 규칙은 다섯 게이트웨이 각각을 단언한다(한 곳만 빠진 결함). 정의 파일이 하나도 없으면 모든 시험이 실패한다(빈 결과가 통과로 새지 않게).
// 실행(저장소 뿌리): node --test "deploy/gateways/test/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(HERE, '..');
const REPO = resolve(DIR, '..', '..');

// ---- 정본 값(docs/infra.md §4.1·§9, docs/features/identity.md §3) ----
const GATEWAYS = ['gw-queue', 'gw-fan', 'gw-partner', 'gw-ops', 'gw-scanner'];
/** CloudFront를 거치는 넷(gw-scanner는 거치지 않는다) */
const BEHIND_CLOUDFRONT = ['gw-queue', 'gw-fan', 'gw-partner', 'gw-ops'];
const HOSTS = {
  'gw-queue': ['queue.peaket.example', 'queue-files.peaket.example'],
  'gw-fan': ['api.peaket.example', 'www.peaket.example'],
  'gw-partner': ['partner-api.peaket.example', 'partner.peaket.example'],
  'gw-ops': ['ops-api.peaket.example'],
  'gw-scanner': ['scanner-api.peaket.example'],
};
/** 게이트웨이마다 허용 출처는 화면 호스트 하나(docs/infra.md §9 'CORS') */
const SCREEN = {
  'gw-queue': 'https://www.peaket.example',
  'gw-fan': 'https://www.peaket.example',
  'gw-partner': 'https://partner.peaket.example',
  'gw-ops': 'https://console.peaket.example',
  'gw-scanner': 'https://scanner.peaket.example',
};
const ALL_SCREENS = ['https://www.peaket.example', 'https://partner.peaket.example', 'https://console.peaket.example', 'https://scanner.peaket.example'];
/** 허용 목록 밖 출처(목록 밖 값마다 거부를 본다): 다른 화면 넷 + 비슷한 꼴 */
const outsideOrigins = (gw) => [...ALL_SCREENS.filter((o) => o !== SCREEN[gw]), 'http://www.peaket.example', 'https://evil.example', 'null', '*'];
/** 게이트웨이마다 믿는 키 셋과 대상(identity §3 '발급자와 검증 규칙': 팬 키 셋은 fan, 관리는 partner·ops, 스태프는 scanner) */
const KEYSET = { 'gw-queue': 'fan', 'gw-fan': 'fan', 'gw-partner': 'admin', 'gw-ops': 'admin', 'gw-scanner': 'staff' };
const AUDIENCE = { 'gw-queue': 'fan', 'gw-fan': 'fan', 'gw-partner': 'partner', 'gw-ops': 'ops', 'gw-scanner': 'scanner' };
/** 라우트마다 넣는 x-peaket-app(infra §4.1 '들어올 때 지우고 넣는 머리') */
const APP = { 'gw-queue': 'web', 'gw-fan': 'web', 'gw-partner': 'partner', 'gw-ops': 'console', 'gw-scanner': 'scanner' };
/** 같은 출처 앱 서버 경로를 두는 게이트웨이와 그 화면 호스트(observability §6 '앱 서버가 브라우저 값을 받는 길') */
const APP_SERVER = { 'gw-fan': 'www.peaket.example', 'gw-partner': 'partner.peaket.example' };
const HSTS = 'max-age=31536000; includeSubDomains';
const API_CSP = "default-src 'none'; frame-ancestors 'none'";
const MAX_AGE_SECONDS = 7200;
const JWKS_CACHE_SECONDS = 300;
const ACCESS_COOKIE = '__Secure-peaket_at';
const BROWSER_TRACEPARENT = 'x-peaket-browser-traceparent';
const ORIGIN_VERIFY = 'x-peaket-origin-verify';
const TRACE_HEADERS = ['traceparent', 'tracestate', 'baggage'];
const IDENTITY_HEADERS = ['x-user-id', 'x-session-id', 'x-user-aud', 'x-user-scope', 'x-user-pid', 'x-user-pid-prev', 'x-user-role', 'x-tenant-id'];

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
const RAW = existsSync(DIR)
  ? readdirSync(DIR)
      .filter((n) => /\.ya?ml$/.test(n))
      .map((n) => readFileSync(join(DIR, n), 'utf8'))
      .join('\n')
  : '';

/** 정의가 있어야 나머지 단언이 뜻이 있다(빈 폴더가 통과로 새지 않게) */
function requireDefinitions() {
  assert.ok(OBJECTS.length > 0, `deploy/gateways/*.yaml에 게이트웨이 정의가 없다(${DIR})`);
}

const lc = (s) => String(s).toLowerCase();
const byKind = (kind) => OBJECTS.filter((o) => o.kind === kind);
const named = (kind, name) => byKind(kind).find((o) => o.metadata?.name === name);
const gatewayOf = (gw) => named('Gateway', gw);
const targetsOf = (p) => [...(p.spec?.targetRefs ?? []), ...(p.spec?.targetRef ? [p.spec.targetRef] : [])];
const routesOf = (gw) => byKind('HTTPRoute').filter((r) => (r.spec?.parentRefs ?? []).some((p) => p.name === gw));
const targetsGateway = (p, gw) => targetsOf(p).some((t) => t.kind === 'Gateway' && t.name === gw);
const targetsRoute = (p, route) => targetsOf(p).some((t) => t.kind === 'HTTPRoute' && t.name === route.metadata?.name);
/** 게이트웨이에 직접 건 정책 */
const gatewayPolicies = (kind, gw) => byKind(kind).filter((p) => targetsGateway(p, gw));
/** 라우트에 닿는 정책: 라우트에 건 것이 있으면 그것, 없으면 부모 게이트웨이에 건 것(Envoy Gateway의 덮어쓰기 차례) */
function routePolicies(kind, route) {
  const own = byKind(kind).filter((p) => targetsRoute(p, route));
  if (own.length) return own;
  return (route.spec?.parentRefs ?? []).flatMap((p) => gatewayPolicies(kind, p.name));
}
/** 게이트웨이에 닿는 모든 정책(게이트웨이와 그 라우트에 건 것) */
const policiesOf = (kind, gw) => byKind(kind).filter((p) => targetsGateway(p, gw) || routesOf(gw).some((r) => targetsRoute(p, r)));

/** 키 이름을 밑줄 없이 소문자로(Envoy Gateway의 camelCase와 EnvoyPatchPolicy의 snake_case를 함께 찾는다) */
const normKey = (k) => lc(k).replaceAll('_', '');
/** 객체 안에서 키 이름이 맞는 값을 모두 찾는다 */
function findKey(obj, key, out = []) {
  if (Array.isArray(obj)) for (const v of obj) findKey(v, key, out);
  else if (obj && typeof obj === 'object')
    for (const [k, v] of Object.entries(obj)) {
      if (normKey(k) === normKey(key)) out.push(v);
      findKey(v, key, out);
    }
  return out;
}
/** 문자열 매처({exact}·{prefix})나 문자열을 글로 */
const matcherText = (m) => (typeof m === 'string' ? m : (m?.exact ?? m?.value ?? m?.prefix ?? JSON.stringify(m)));

/** EnvoyExtensionPolicy의 Lua 원문(인라인이나 같은 폴더의 ConfigMap 값) */
function luaOf(policy) {
  const out = [];
  for (const l of policy.spec?.lua ?? []) {
    if (typeof l.inline === 'string') out.push(l.inline);
    const ref = l.valueRef;
    if (ref?.kind === 'ConfigMap') {
      const cm = named('ConfigMap', ref.name);
      for (const v of Object.values(cm?.data ?? {})) out.push(String(v));
    }
  }
  return out.join('\n');
}
/** 게이트웨이에 걸린 Lua 전부(게이트웨이·라우트) */
const luaFor = (gw) => policiesOf('EnvoyExtensionPolicy', gw).map(luaOf).join('\n');

/** 게이트웨이 수준 ClientTrafficPolicy 하나 */
function clientPolicy(gw) {
  const ps = gatewayPolicies('ClientTrafficPolicy', gw);
  assert.equal(ps.length, 1, `${gw}: 게이트웨이에 건 ClientTrafficPolicy가 하나여야 한다(${ps.length}개)`);
  return ps[0];
}
const early = (gw) => clientPolicy(gw).spec?.headers?.earlyRequestHeaders ?? {};
/** earlyRequestHeaders가 그 머리를 지우는가(이름 그대로, 또는 앞부분 매처) */
function earlyRemoves(gw, name) {
  const e = early(gw);
  if ((e.remove ?? []).some((h) => lc(h) === lc(name))) return true;
  return findKey(e, 'prefix').some((p) => typeof p === 'string' && lc(name).startsWith(lc(p)));
}
const earlySet = (gw, name) => [...(early(gw).set ?? []), ...(early(gw).add ?? [])].find((h) => lc(h.name) === lc(name));

/** 라우트 규칙의 필터에서 머리 고치기(요청·응답) */
const filtersOf = (rule) => rule.filters ?? [];
const routeRules = (route) => route.spec?.rules ?? [];
const requestModifiers = (route) => routeRules(route).flatMap((r) => filtersOf(r).filter((f) => f.type === 'RequestHeaderModifier').map((f) => f.requestHeaderModifier ?? {}));
/** 백엔드로 넘기는 규칙마다 그 요청 머리를 지우는가(직접 답하는 규칙은 넘기지 않으므로 뺀다) */
const routeRemovesRequest = (route, name) => routeRules(route).filter((rule) => (rule.backendRefs ?? []).length > 0).every((rule) => filtersOf(rule).some((f) => f.type === 'RequestHeaderModifier' && (f.requestHeaderModifier?.remove ?? []).some((h) => lc(h) === lc(name))));
const routeTouchesRequest = (route, name) => requestModifiers(route).some((m) => (m.remove ?? []).some((h) => lc(h) === lc(name)));

/** 라우트·게이트웨이에 닿는 객체 전부의 글(응답 머리 정책은 HTTPRoute 필터, 확장 필터, Lua, 정책 어디에든 둘 수 있다) */
function boundText(route) {
  const parents = (route.spec?.parentRefs ?? []).map((p) => p.name);
  const ext = routeRules(route)
    .flatMap(filtersOf)
    .filter((f) => f.type === 'ExtensionRef')
    .map((f) => OBJECTS.find((o) => o.kind === f.extensionRef?.kind && o.metadata?.name === f.extensionRef?.name));
  const policies = OBJECTS.filter((o) => targetsRoute(o, route) || parents.some((g) => targetsGateway(o, g)));
  const lua = policies.filter((p) => p.kind === 'EnvoyExtensionPolicy').map(luaOf);
  return JSON.stringify([route.spec, ...ext.map((x) => x?.spec), ...policies.map((p) => p.spec)]) + '\n' + lua.join('\n');
}

/** 경로 하나가 라우트 규칙의 어느 match에 맞는가(Exact > 긴 PathPrefix > 정규식) */
function pathScore(match, method, path) {
  if (match.method && match.method !== method) return -1;
  const p = match.path ?? { type: 'PathPrefix', value: '/' };
  const v = p.value ?? '/';
  if (p.type === 'Exact') return v === path ? 100000 : -1;
  if (p.type === 'RegularExpression') return new RegExp(`^${v}$`).test(path) ? 1 : -1;
  const pre = v.endsWith('/') ? v : `${v}/`;
  return path === v || path.startsWith(pre) || v === '/' ? 10 + v.length : -1;
}
/** (게이트웨이, 호스트, 메서드, 경로)를 받는 라우트 규칙 */
function routeFor(gw, host, method, path) {
  let best = null;
  for (const route of routesOf(gw)) {
    const hosts = route.spec?.hostnames ?? [];
    if (hosts.length && !hosts.includes(host)) continue;
    for (const rule of routeRules(route)) {
      for (const m of rule.matches ?? [{}]) {
        const s = pathScore(m, method, path);
        if (s >= 0 && (!best || s > best.score)) best = { route, rule, score: s };
      }
    }
  }
  return best;
}
const backendNames = (rule) => (rule.backendRefs ?? []).map((b) => b.name);

/** Duration 글(7200s·2h·120m·2h0m0s)을 초로 */
function seconds(d) {
  if (typeof d === 'number') return d;
  const m = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+)s)?$/.exec(String(d).trim());
  assert.ok(m && String(d).trim() !== '', `기간 꼴을 읽지 못했다: ${d}`);
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/** 라우트에 닿는 CORS 설정(라우트에 건 SecurityPolicy가 먼저) */
const corsFor = (route) => routePolicies('SecurityPolicy', route).map((p) => p.spec?.cors).filter(Boolean);
/** 게이트웨이의 라우트 가운데 그 호스트를 받는 것 */
const routesOnHost = (gw, host) => routesOf(gw).filter((r) => (r.spec?.hostnames ?? []).includes(host));

// ===================== 호스트·내부 경로·TRACE =====================

test('[ASVS v5.0.0-3.5.4] 게이트웨이 다섯이 호스트를 나눠 듣고 한 호스트를 두 게이트웨이가 함께 듣지 않는다', () => {
  requireDefinitions();
  assert.deepEqual(byKind('Gateway').map((g) => g.metadata?.name).sort(), [...GATEWAYS].sort(), 'Gateway는 다섯뿐이다');
  const owner = new Map();
  for (const gw of GATEWAYS) {
    const listeners = gatewayOf(gw)?.spec?.listeners ?? [];
    assert.ok(listeners.length > 0, `${gw}: 리스너가 없다`);
    for (const l of listeners) {
      assert.ok(typeof l.hostname === 'string' && l.hostname !== '' && !l.hostname.includes('*'), `${gw}/${l.name}: 리스너는 호스트 하나를 정확히 적는다(${l.hostname})`);
      assert.ok(!owner.has(l.hostname) || owner.get(l.hostname) === gw, `${l.hostname}를 ${owner.get(l.hostname)}와 ${gw}가 함께 듣는다`);
      owner.set(l.hostname, gw);
    }
    assert.deepEqual([...new Set(listeners.map((l) => l.hostname))].sort(), [...HOSTS[gw]].sort(), `${gw}: 듣는 호스트`);
    for (const r of routesOf(gw)) {
      const hs = r.spec?.hostnames ?? [];
      assert.ok(hs.length > 0, `${gw}/${r.metadata?.name}: 라우트는 호스트를 적는다`);
      for (const h of hs) assert.ok(HOSTS[gw].includes(h), `${gw}/${r.metadata?.name}: 남의 호스트 ${h}`);
    }
  }
});

test('[ASVS v5.0.0-13.4.4] 다섯 게이트웨이 모두 TRACE를 405로 거절한다(규칙이 붙어 있다)', () => {
  requireDefinitions();
  for (const gw of GATEWAYS) {
    // ① 라우트 규칙: method TRACE에 맞는 규칙이 HTTPRouteFilter directResponse 405로 답하고, 그 게이트웨이의 모든 호스트를 덮는다
    const byRoute = HOSTS[gw].every((host) => {
      const hit = routeFor(gw, host, 'TRACE', '/v1/anything');
      if (!hit || !(hit.rule.matches ?? []).every((m) => m.method === 'TRACE')) return false;
      return filtersOf(hit.rule).some((f) => {
        if (f.type !== 'ExtensionRef') return false;
        const x = named(f.extensionRef?.kind, f.extensionRef?.name);
        return Number(x?.spec?.directResponse?.statusCode) === 405;
      });
    });
    // ② 게이트웨이에 건 Lua가 TRACE를 405로
    const lua = gatewayPolicies('EnvoyExtensionPolicy', gw).map(luaOf).join('\n');
    const byLua = /TRACE/.test(lua) && /405/.test(lua);
    assert.ok(byRoute || byLua, `${gw}: TRACE를 405로 거절하는 규칙이 없다`);
  }
});

test('HOT-400 어느 게이트웨이 라우트도 /internal/ 경로를 내지 않는다(identity §3 공개키 배포)', () => {
  requireDefinitions();
  assert.ok(byKind('HTTPRoute').length > 0, 'HTTPRoute가 없다');
  for (const r of byKind('HTTPRoute')) {
    for (const rule of routeRules(r)) {
      for (const m of rule.matches ?? [{}]) {
        const v = m.path?.value ?? '/';
        assert.ok(!lc(v).startsWith('/internal'), `${r.metadata?.name}: ${v}`);
        if (m.path?.type === 'RegularExpression') assert.ok(!/internal/i.test(v), `${r.metadata?.name}: 정규식 ${v}`);
        // 뿌리 전체를 identity로 넘기면 /internal/도 나간다
        if ((m.path?.type ?? 'PathPrefix') === 'PathPrefix' && (v === '/' || v === '')) assert.ok(!backendNames(rule).some((b) => /identity/.test(b)), `${r.metadata?.name}: / 전체를 identity로 넘긴다`);
      }
      for (const f of filtersOf(rule).filter((x) => x.type === 'URLRewrite')) {
        const p = f.urlRewrite?.path ?? {};
        for (const v of [p.replacePrefixMatch, p.replaceFullPath].filter(Boolean)) assert.ok(!lc(v).startsWith('/internal'), `${r.metadata?.name}: ${v}로 다시 쓴다`);
      }
    }
  }
  for (const host of HOSTS['gw-fan']) {
    const hit = routeFor('gw-fan', host, 'GET', '/internal/jwks/fan.json');
    assert.ok(!hit || !backendNames(hit.rule).some((b) => /identity/.test(b)), `gw-fan ${host}/internal/jwks/fan.json이 identity로 간다`);
  }
});

// ===================== 들어올 때 지우고 넣는 머리 =====================

test('V-T31 ① 다섯 게이트웨이의 earlyRequestHeaders가 traceparent·tracestate·baggage·x-peaket-app·x-peaket-browser-traceparent를 지운다', () => {
  requireDefinitions();
  for (const gw of GATEWAYS) {
    for (const h of [...TRACE_HEADERS, 'x-peaket-app']) assert.ok(earlyRemoves(gw, h), `${gw}: ${h}를 지우지 않는다`);
    const copied = earlySet(gw, BROWSER_TRACEPARENT);
    if (APP_SERVER[gw]) {
      // 바깥에서 온 값은 지우거나, 받은 traceparent로 덮어쓴다(바깥 값이 그대로 남지 않는다)
      assert.ok(earlyRemoves(gw, BROWSER_TRACEPARENT) || (copied && /traceparent/i.test(copied.value)), `${gw}: 바깥 ${BROWSER_TRACEPARENT}가 그대로 남는다`);
    } else {
      assert.ok(earlyRemoves(gw, BROWSER_TRACEPARENT), `${gw}: ${BROWSER_TRACEPARENT}를 지우지 않는다`);
      assert.equal(copied, undefined, `${gw}: 앱 서버 경로가 없는 게이트웨이는 ${BROWSER_TRACEPARENT}를 넣지 않는다`);
    }
    // 추적 머리를 다시 넣지 않는다
    for (const h of TRACE_HEADERS) assert.equal(earlySet(gw, h), undefined, `${gw}: ${h}를 넣는다`);
  }
});

test('HOT-400 identity §3 다섯 게이트웨이의 earlyRequestHeaders가 바깥에서 온 신원 머리(X-User-*·X-Session-Id·X-Tenant-Id)를 지우고 밑줄 머리를 버린다', () => {
  requireDefinitions();
  for (const gw of GATEWAYS) {
    for (const h of IDENTITY_HEADERS) assert.ok(earlyRemoves(gw, h), `${gw}: ${h}를 지우지 않는다`);
    const drop = [...findKey(clientPolicy(gw).spec, 'withUnderscoresAction'), ...findKey(clientPolicy(gw).spec, 'headersWithUnderscoresAction')];
    assert.ok(drop.includes('DropHeader'), `${gw}: 이름에 밑줄이 든 머리를 버리지 않는다(${JSON.stringify(drop)})`);
  }
});

test('HOT-400 다섯 게이트웨이가 라우트마다 x-peaket-app을 web·web·partner·console·scanner로 넣는다(infra §4.1)', () => {
  requireDefinitions();
  for (const gw of GATEWAYS) {
    const routes = routesOf(gw);
    assert.ok(routes.length > 0, `${gw}: 라우트가 없다`);
    const atGateway = earlySet(gw, 'x-peaket-app');
    for (const r of routes) {
      const set = requestModifiers(r).flatMap((m) => m.set ?? []).filter((h) => lc(h.name) === 'x-peaket-app');
      const values = set.length ? set.map((h) => h.value) : atGateway ? [atGateway.value] : [];
      assert.deepEqual([...new Set(values)], [APP[gw]], `${gw}/${r.metadata?.name}: x-peaket-app`);
    }
  }
});

test('V-T31 ② gw-fan·gw-partner의 앱 서버 라우트만 x-peaket-browser-traceparent를 넘기고 다른 라우트는 지운다', () => {
  requireDefinitions();
  for (const [gw, host] of Object.entries(APP_SERVER)) {
    const app = named('HTTPRoute', `${gw}-app`);
    assert.ok(app, `${gw}-app 라우트가 없다`);
    assert.deepEqual(app.spec?.hostnames, [host], `${gw}-app: 화면 호스트 하나`);
    assert.ok(!routeTouchesRequest(app, BROWSER_TRACEPARENT), `${gw}-app: ${BROWSER_TRACEPARENT}를 지운다`);
    const others = routesOf(gw).filter((r) => r !== app);
    assert.ok(others.length > 0, `${gw}: 앱 서버 밖 라우트가 없다`);
    for (const r of others) assert.ok(routeRemovesRequest(r, BROWSER_TRACEPARENT), `${gw}/${r.metadata?.name}: ${BROWSER_TRACEPARENT}를 규칙마다 지우지 않는다`);
  }
});

// ===================== 원본 확인과 끝단 신호 머리 =====================

test('B-T18 ④ CloudFront 뒤 넷은 Lua가 x-peaket-origin-verify를 견주어 끝단 신호 머리(CloudFront-Viewer-*·x-amzn-waf-*·x-peaket-arrival)를 지우고, gw-scanner는 늘 지운다', () => {
  requireDefinitions();
  for (const gw of BEHIND_CLOUDFRONT) {
    const lua = gatewayPolicies('EnvoyExtensionPolicy', gw).map(luaOf).join('\n');
    assert.ok(lua !== '', `${gw}: 게이트웨이에 건 Lua가 없다`);
    for (const s of [ORIGIN_VERIFY, 'cloudfront-viewer-', 'x-amzn-waf-', 'x-peaket-arrival']) assert.ok(lc(lua).includes(s), `${gw}: Lua에 ${s}가 없다`);
  }
  // gw-scanner: 원본 확인 없이 늘 지운다(earlyRequestHeaders나 Lua)
  const gw = 'gw-scanner';
  const lua = lc(gatewayPolicies('EnvoyExtensionPolicy', gw).map(luaOf).join('\n'));
  for (const h of ['cloudfront-viewer-ja4-fingerprint', 'cloudfront-viewer-asn', 'x-amzn-waf-bot-labels', 'x-peaket-arrival']) {
    const prefix = h.startsWith('cloudfront-viewer-') ? 'cloudfront-viewer-' : h.startsWith('x-amzn-waf-') ? 'x-amzn-waf-' : h;
    assert.ok(earlyRemoves(gw, h) || lua.includes(prefix), `${gw}: ${h}를 지우지 않는다`);
  }
  // 원본 확인 값은 저장소에 두지 않는다(정의에 값 칸이 없다)
  for (const o of OBJECTS) for (const v of findKey(o, 'name')) if (lc(v) === ORIGIN_VERIFY) assert.fail(`${o.__file}: ${ORIGIN_VERIFY} 값을 정의에 적었다`);
});

test('B-T18 ⑤ ScoreRiskRequest에 JA4·끝단 라벨 칸이 없고 게이트웨이 정의 어디에도 awswaf:managed:token이 없다', () => {
  requireDefinitions();
  const proto = readFileSync(join(REPO, 'docs', 'api', 'proto', 'peaket', 'trust', 'v1', 'trust.proto'), 'utf8');
  const message = (name) => {
    const m = new RegExp(`message ${name} \\{([\\s\\S]*?)\\n\\}`).exec(proto);
    assert.ok(m, `trust.proto에 ${name}가 없다`);
    return m[1]
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
  };
  const body = message('ScoreRiskRequest');
  const nested = [...body.matchAll(/^\s*([A-Z]\w+)\s+\w+\s*=\s*\d+;/gm)].map((m) => m[1]).filter((t) => new RegExp(`message ${t} \\{`).test(proto));
  for (const text of [body, ...nested.map(message)]) {
    assert.doesNotMatch(text, /ja4|bot_?label|edge_?bot|waf/i);
  }
  assert.doesNotMatch(RAW, /awswaf:managed:token/i);
});

// ===================== 클라이언트 IP·TLS =====================

test('[ASVS v5.0.0-15.3.4] CloudFront 뒤 넷은 numTrustedHops 1, gw-scanner는 연결 상대 주소(0)를 쓴다', () => {
  requireDefinitions();
  for (const gw of BEHIND_CLOUDFRONT) {
    const hops = clientPolicy(gw).spec?.clientIPDetection?.xForwardedFor?.numTrustedHops;
    assert.equal(hops, 1, `${gw}: numTrustedHops`);
  }
  const xff = clientPolicy('gw-scanner').spec?.clientIPDetection?.xForwardedFor;
  assert.ok(xff === undefined || xff.numTrustedHops === 0, `gw-scanner: x-forwarded-for를 믿는다(${JSON.stringify(xff)})`);
});

test('[ASVS v5.0.0-12.1.1] 게이트웨이 TLS는 1.2 이상이고 1.2 스위트가 ECDHE+AEAD뿐이다', () => {
  requireDefinitions();
  const AEAD = /^ECDHE-(ECDSA|RSA)-(AES128-GCM-SHA256|AES256-GCM-SHA384|CHACHA20-POLY1305)$/;
  for (const gw of GATEWAYS) {
    for (const l of gatewayOf(gw)?.spec?.listeners ?? []) assert.equal(l.protocol, 'HTTPS', `${gw}/${l.name}: 평문 리스너`);
    const t = clientPolicy(gw).spec?.tls ?? {};
    assert.ok(['1.2', '1.3'].includes(String(t.minVersion)), `${gw}: minVersion ${t.minVersion}`);
    if (t.maxVersion !== undefined) assert.equal(String(t.maxVersion), '1.3', `${gw}: maxVersion`);
    if (String(t.minVersion) === '1.2') {
      const suites = (t.ciphers ?? []).flatMap((c) => String(c).replace(/^\[|\]$/g, '').split('|'));
      assert.ok(suites.length > 0, `${gw}: 1.2 스위트를 고르지 않았다(기본 목록에는 CBC가 든다)`);
      for (const s of suites) assert.match(s, AEAD, `${gw}: ${s}`);
    }
  }
});

// ===================== 토큰 확인과 인가 =====================

/** 게이트웨이에 닿는 jwt 제공자 전부 */
const providersOf = (gw) => policiesOf('SecurityPolicy', gw).flatMap((p) => p.spec?.jwt?.providers ?? []);

test('I-T36 게이트웨이마다 jwt 제공자가 자기 키 셋의 공개키 묶음 하나뿐이고 캐시는 300초다', () => {
  requireDefinitions();
  for (const gw of GATEWAYS) {
    const ps = providersOf(gw);
    assert.ok(ps.length > 0, `${gw}: jwt 제공자가 없다`);
    const uris = new Set(ps.map((p) => p.remoteJWKS?.uri));
    assert.equal(uris.size, 1, `${gw}: 공개키 묶음이 여럿이다 ${[...uris]}`);
    const uri = [...uris][0] ?? '';
    assert.match(uri, new RegExp(`/internal/jwks/${KEYSET[gw]}\\.json$`), `${gw}: ${uri}`);
    for (const other of ['fan', 'admin', 'staff'].filter((k) => k !== KEYSET[gw])) assert.ok(!uri.includes(`/${other}.json`), `${gw}: ${other} 키 셋을 믿는다`);
    for (const p of ps) {
      const cache = findKey(p.remoteJWKS ?? {}, 'cacheDuration');
      assert.equal(cache.length, 1, `${gw}/${p.name}: 공개키 묶음 캐시 기간이 없다`);
      assert.equal(seconds(cache[0]), JWKS_CACHE_SECONDS, `${gw}/${p.name}: 캐시 기간`);
    }
  }
});

test('I-T36 게이트웨이마다 issuer를 확인하고 Lua가 토큰 머리의 typ at+jwt만 받는다(reauth+jwt·admission+jwt 거부)', () => {
  requireDefinitions();
  const issuers = new Set();
  for (const gw of GATEWAYS) {
    for (const p of providersOf(gw)) {
      assert.ok(typeof p.issuer === 'string' && p.issuer !== '', `${gw}/${p.name}: issuer가 없다`);
      issuers.add(p.issuer);
    }
    const lua = luaFor(gw);
    assert.ok(lua.includes('at+jwt'), `${gw}: Lua가 typ at+jwt를 보지 않는다`);
    // 받는 typ 목록에 다른 값을 더하지 않는다
    for (const other of ['reauth+jwt', 'admission+jwt']) assert.ok(!lua.includes(other), `${gw}: Lua가 ${other}를 다룬다`);
  }
  assert.equal(issuers.size, 1, `identity 토큰의 iss는 하나다: ${[...issuers]}`);
});

test('[ASVS v5.0.0-9.2.4] gw-partner는 aud partner만, gw-ops는 aud ops만 받고 다섯 게이트웨이가 자기 대상 하나만 받는다', () => {
  requireDefinitions();
  for (const gw of GATEWAYS) {
    const ps = providersOf(gw);
    assert.ok(ps.length > 0, `${gw}: jwt 제공자가 없다`);
    for (const p of ps) assert.deepEqual(p.audiences, [AUDIENCE[gw]], `${gw}/${p.name}: audiences`);
  }
});

test('HOT-400 identity §3 토큰 자리(액세스 쿠키·Bearer)와 검증한 클레임을 내부 신원 머리에 넣는다', () => {
  requireDefinitions();
  for (const gw of GATEWAYS) {
    for (const p of providersOf(gw)) {
      const map = Object.fromEntries((p.claimToHeaders ?? []).map((c) => [c.claim, lc(c.header)]));
      for (const [claim, header] of [['sub', 'x-user-id'], ['sid', 'x-session-id'], ['aud', 'x-user-aud'], ['scope', 'x-user-scope']]) assert.equal(map[claim], header, `${gw}/${p.name}: ${claim}`);
      if (KEYSET[gw] === 'fan') {
        assert.equal(map.pid, 'x-user-pid', `${gw}/${p.name}: pid`);
        assert.ok(Object.values(map).includes('x-user-pid-prev'), `${gw}/${p.name}: 옛 pid 머리`);
        const cookies = (p.extractFrom?.cookies ?? []).map(String);
        assert.ok(cookies.includes(ACCESS_COOKIE), `${gw}/${p.name}: ${ACCESS_COOKIE}를 읽지 않는다`);
        const headers = p.extractFrom?.headers ?? [];
        assert.ok(headers.some((h) => lc(h.name) === 'authorization' && /bearer/i.test(h.valuePrefix ?? '')), `${gw}/${p.name}: Authorization Bearer를 읽지 않는다`);
      }
    }
  }
});

test('HOT-400 authz-matrix §5.1 인가는 defaultAction Deny이고 대기열 진입·입장 확정은 ticket:buy를 요구한다', () => {
  requireDefinitions();
  const auths = byKind('SecurityPolicy').map((p) => p.spec?.authorization).filter(Boolean);
  assert.ok(auths.length > 0, 'authorization이 없다');
  for (const a of auths) assert.equal(a.defaultAction, 'Deny');
  for (const path of ['/v1/queues/e2e-event-10/entries', '/v1/queues/e2e-event-10/admission']) {
    const hit = routeFor('gw-queue', 'queue.peaket.example', 'POST', path);
    assert.ok(hit, `gw-queue POST ${path}를 받는 라우트가 없다`);
    const a = routePolicies('SecurityPolicy', hit.route)
      .map((p) => p.spec?.authorization)
      .filter(Boolean);
    assert.equal(a.length, 1, `${path}: 인가 규칙`);
    assert.equal(a[0].defaultAction, 'Deny');
    const allow = (a[0].rules ?? []).filter((r) => r.action === 'Allow');
    assert.ok(allow.length > 0 && allow.every((r) => findKey(r.principal ?? {}, 'scopes').flat().includes('ticket:buy')), `${path}: Allow 규칙마다 ticket:buy`);
  }
});

// ===================== 교차 출처·출처 확인 =====================

test('[ASVS v5.0.0-3.4.2] 게이트웨이마다 허용 출처가 화면 호스트 하나이고 *·목록 밖 출처가 없다', () => {
  requireDefinitions();
  for (const gw of GATEWAYS) {
    const all = policiesOf('SecurityPolicy', gw).map((p) => p.spec?.cors).filter(Boolean);
    assert.ok(all.length > 0, `${gw}: CORS 설정이 없다`);
    for (const c of all) {
      const origins = (c.allowOrigins ?? []).map(matcherText);
      assert.deepEqual(origins, [SCREEN[gw]], `${gw}: allowOrigins`);
      for (const bad of outsideOrigins(gw)) assert.ok(!origins.includes(bad), `${gw}: ${bad}를 허용한다`);
    }
  }
});

test('Q-T41 ② gw-queue queue 호스트의 CORS는 Allow-Credentials·Retry-After·Date를 내고 사전 요청 응답 Max-Age가 7200초다', () => {
  requireDefinitions();
  const routes = routesOnHost('gw-queue', 'queue.peaket.example');
  assert.ok(routes.length > 0, 'queue 호스트 라우트가 없다');
  for (const r of routes) {
    const cs = corsFor(r);
    assert.equal(cs.length, 1, `${r.metadata?.name}: CORS 설정 하나`);
    const c = cs[0];
    assert.equal(seconds(c.maxAge), MAX_AGE_SECONDS, `${r.metadata?.name}: maxAge`);
    assert.notEqual(seconds(c.maxAge), MAX_AGE_SECONDS - 1);
    assert.equal(c.allowCredentials, true, `${r.metadata?.name}: allowCredentials`);
    const expose = (c.exposeHeaders ?? []).map(lc);
    for (const h of ['retry-after', 'date', 'x-trace-id']) assert.ok(expose.includes(h), `${r.metadata?.name}: Expose-Headers에 ${h}`);
  }
});

test('Q-T41 ⑦ queue-files 라우트의 CORS는 www 하나, Expose-Headers Retry-After만이고 Allow-Credentials가 없다', () => {
  requireDefinitions();
  const routes = routesOnHost('gw-queue', 'queue-files.peaket.example');
  assert.ok(routes.length > 0, 'queue-files 호스트 라우트가 없다');
  for (const r of routes) {
    const cs = corsFor(r);
    assert.equal(cs.length, 1, `${r.metadata?.name}: CORS 설정 하나`);
    const c = cs[0];
    assert.deepEqual((c.allowOrigins ?? []).map(matcherText), ['https://www.peaket.example']);
    assert.notEqual(c.allowCredentials, true, `${r.metadata?.name}: 쿠키를 받지 않는 파일에 Allow-Credentials`);
    assert.deepEqual((c.exposeHeaders ?? []).map(lc), ['retry-after'], `${r.metadata?.name}: 캐시 응답의 Date는 노출하지 않는다`);
  }
});

test('HOT-400 gw-fan api의 CORS는 Allow-Credentials와 Date·X-Trace-Id·ETag 노출, 사전 요청 Max-Age 7200초다', () => {
  requireDefinitions();
  const routes = routesOnHost('gw-fan', 'api.peaket.example');
  assert.ok(routes.length > 0, 'api 호스트 라우트가 없다');
  for (const r of routes) {
    const cs = corsFor(r);
    assert.equal(cs.length, 1, `${r.metadata?.name}: CORS 설정 하나`);
    assert.equal(seconds(cs[0].maxAge), MAX_AGE_SECONDS);
    assert.equal(cs[0].allowCredentials, true);
    const expose = (cs[0].exposeHeaders ?? []).map(lc);
    for (const h of ['date', 'x-trace-id', 'etag']) assert.ok(expose.includes(h), `${r.metadata?.name}: Expose-Headers에 ${h}`);
  }
});

/** 게이트웨이에 닿는 CSRF 설정의 허용 출처(SecurityPolicy·EnvoyPatchPolicy 어디에 두든) */
function csrfOrigins(gw) {
  const objs = OBJECTS.filter((o) => targetsGateway(o, gw) || routesOf(gw).some((r) => targetsRoute(o, r)));
  const csrf = objs.flatMap((o) => findKey(o.spec ?? {}, 'csrf'));
  return csrf.map((c) => findKey(c, 'additionalOrigins').flat().map(matcherText));
}

test('[ASVS v5.0.0-3.5.1] 쿠키로 인증하는 쓰기 라우트에 출처 확인(csrf)이 붙고 additionalOrigins가 그 게이트웨이의 화면 호스트 하나다', () => {
  requireDefinitions();
  for (const gw of ['gw-queue', 'gw-fan', 'gw-partner']) {
    const sets = csrfOrigins(gw);
    assert.ok(sets.length > 0, `${gw}: 출처 확인이 없다`);
    for (const origins of sets) {
      assert.deepEqual(origins, [SCREEN[gw]], `${gw}: additionalOrigins`);
      for (const bad of outsideOrigins(gw)) assert.ok(!origins.includes(bad), `${gw}: ${bad}를 허용한다`);
    }
  }
  // gw-ops에 두면 관제 콘솔 하나만
  for (const origins of csrfOrigins('gw-ops')) assert.deepEqual(origins, [SCREEN['gw-ops']]);
});

test('HOT-400 gw-fan identity 경로(PRF-030·BOT-044·BOT-047): 토큰 갱신·로그인한 기기·계정 요약·가입 마무리가 identity-svc 앱 포트로 간다', () => {
  requireDefinitions();
  for (const [method, path] of [
    ['POST', '/v1/identity/access-tokens'],
    ['GET', '/v1/identity/sessions'],
    ['DELETE', '/v1/identity/sessions/0190a8f2-0000-7000-8000-000000000010'],
    ['GET', '/v1/identity/me'],
    ['POST', '/v1/identity/signup-completions'],
    ['POST', '/v1/identity/nickname-checks'],
    ['POST', '/v1/identity/signup-cancellations'],
  ]) {
    const hit = routeFor('gw-fan', 'api.peaket.example', method, path);
    assert.ok(hit, `gw-fan ${method} ${path}를 받는 라우트가 없다`);
    assert.ok(backendNames(hit.rule).some((b) => /identity/.test(b)), `${method} ${path}: ${backendNames(hit.rule)}`);
  }
});

// ===================== 응답 머리 =====================

test('[ASVS v5.0.0-3.4.1] 다섯 게이트웨이 응답에 HSTS max-age=31536000; includeSubDomains를 덮어 붙인다', () => {
  requireDefinitions();
  for (const gw of GATEWAYS) {
    const routes = routesOf(gw);
    assert.ok(routes.length > 0, `${gw}: 라우트가 없다`);
    for (const r of routes) {
      const t = boundText(r);
      assert.match(t, /strict-transport-security/i, `${gw}/${r.metadata?.name}: HSTS가 없다`);
      assert.ok(t.includes(HSTS), `${gw}/${r.metadata?.name}: HSTS 값이 ${HSTS}가 아니다`);
      assert.doesNotMatch(t, /max-age=(?!31536000\b)\d+;\s*includeSubDomains/, `${gw}/${r.metadata?.name}: 다른 HSTS 값`);
    }
  }
});

test('[ASVS v5.0.0-3.4.4] 다섯 게이트웨이 응답에 X-Content-Type-Options nosniff를 붙인다', () => {
  requireDefinitions();
  for (const gw of GATEWAYS) {
    const routes = routesOf(gw);
    assert.ok(routes.length > 0, `${gw}: 라우트가 없다`);
    for (const r of routes) {
      const t = boundText(r);
      assert.match(t, /x-content-type-options/i, `${gw}/${r.metadata?.name}`);
      assert.match(t, /nosniff/, `${gw}/${r.metadata?.name}`);
    }
  }
});

test("[ASVS v5.0.0-3.4.3] [ASVS v5.0.0-3.4.6] API 응답에 기본 CSP default-src 'none'; frame-ancestors 'none'을 붙이고 앱 서버 라우트의 CSP는 덮어쓰지 않는다", () => {
  requireDefinitions();
  for (const gw of GATEWAYS) {
    const api = routesOf(gw).filter((r) => r.metadata?.name !== `${gw}-app`);
    assert.ok(api.length > 0, `${gw}: API 라우트가 없다`);
    for (const r of api) assert.ok(boundText(r).includes(API_CSP), `${gw}/${r.metadata?.name}: 기본 CSP가 없다`);
  }
  for (const gw of Object.keys(APP_SERVER)) {
    const app = named('HTTPRoute', `${gw}-app`);
    assert.ok(app, `${gw}-app 라우트가 없다`);
    // 앱 서버 라우트는 응답 CSP를 set(덮어쓰기)하지 않는다
    for (const rule of routeRules(app))
      for (const f of filtersOf(rule).filter((x) => x.type === 'ResponseHeaderModifier'))
        for (const h of f.responseHeaderModifier?.set ?? []) assert.notEqual(lc(h.name), 'content-security-policy', `${gw}-app: CSP를 덮어쓴다`);
    // 앱 서버 라우트에 건 정책·필터는 기본 CSP 값을 싣지 않는다(앱 값을 그대로 둔다)
    const own = OBJECTS.filter((o) => targetsRoute(o, app));
    assert.ok(!JSON.stringify([app.spec, ...own.map((o) => o.spec)]).includes(API_CSP), `${gw}-app: 기본 CSP를 싣는다`);
  }
});

// ===================== 접근 로그 =====================

/** EnvoyProxy 접근 로그의 JSON 형식들 */
const accessLogFormats = () => byKind('EnvoyProxy').flatMap((p) => (p.spec?.telemetry?.accessLog?.settings ?? []).map((s) => s.format).filter((f) => f?.type === 'JSON'));

test('B-T18 ① 접근 로그 JSON의 조사 칸 ja4·asn·edgeBotLabels가 끝단 머리를 읽고 x-peaket-app 칸이 있다', () => {
  requireDefinitions();
  const formats = accessLogFormats();
  assert.ok(formats.length > 0, 'EnvoyProxy JSON 접근 로그가 없다');
  for (const f of formats) {
    const j = Object.fromEntries(Object.entries(f.json ?? {}).map(([k, v]) => [k, lc(v)]));
    assert.equal(j.ja4, '%req(cloudfront-viewer-ja4-fingerprint)%');
    assert.equal(j.asn, '%req(cloudfront-viewer-asn)%');
    assert.equal(j.edgeBotLabels, '%req(x-amzn-waf-bot-labels)%');
    assert.ok(Object.values(j).includes('%req(x-peaket-app)%'), 'x-peaket-app 칸');
  }
  // 다섯 게이트웨이가 모두 이 EnvoyProxy를 쓴다(GatewayClass나 Gateway의 parametersRef)
  const proxies = new Set(byKind('EnvoyProxy').map((p) => p.metadata?.name));
  const viaClass = new Set(byKind('GatewayClass').filter((c) => proxies.has(c.spec?.parametersRef?.name)).map((c) => c.metadata?.name));
  for (const gw of GATEWAYS) {
    const g = gatewayOf(gw);
    assert.ok(viaClass.has(g?.spec?.gatewayClassName) || proxies.has(g?.spec?.infrastructure?.parametersRef?.name), `${gw}: 접근 로그 EnvoyProxy를 쓰지 않는다`);
  }
});

test('HOT-400 BOT-010 접근 로그의 경로 칸은 쿼리를 뗀 %REQ_WITHOUT_QUERY(:PATH)%이고 쿼리를 싣는 칸이 없다(infra §9)', () => {
  requireDefinitions();
  const formats = accessLogFormats();
  assert.ok(formats.length > 0, 'EnvoyProxy JSON 접근 로그가 없다');
  for (const f of formats) {
    const values = Object.values(f.json ?? {}).map(String);
    assert.ok(values.some((v) => v.toUpperCase() === '%REQ_WITHOUT_QUERY(:PATH)%'), '쿼리를 뗀 경로 칸이 없다');
    for (const v of values) assert.doesNotMatch(v.toUpperCase(), /%REQ\((X-ENVOY-ORIGINAL-PATH\?)?:PATH\)%|%REQ\(:PATH\)%|%PATH%|:QUERY|%QUERY/, `쿼리를 싣는 칸: ${v}`);
  }
});

// ===================== 검색 IP 한도 =====================

test('SR-T13 ② gw-fan /v1/search* 라우트에 IP마다 초당 50건·모아 두기 100건 한도가 붙는다', () => {
  requireDefinitions();
  for (const path of ['/v1/search', '/v1/search/suggestions']) {
    const hit = routeFor('gw-fan', 'api.peaket.example', 'GET', path);
    assert.ok(hit, `gw-fan GET ${path}를 받는 라우트가 없다`);
    const ps = routePolicies('BackendTrafficPolicy', hit.route).filter((p) => p.spec?.rateLimit);
    assert.ok(ps.length > 0, `${path}: 한도 정책이 없다`);
    const rules = ps.flatMap((p) => p.spec.rateLimit.local?.rules ?? []);
    assert.ok(rules.length > 0, `${path}: 로컬 한도 규칙이 없다`);
    const perIp = rules.filter((r) => (r.clientSelectors ?? []).some((s) => s.sourceCIDR?.type === 'Distinct'));
    assert.equal(perIp.length, 1, `${path}: IP마다 따로 세는 규칙(sourceCIDR Distinct) 하나`);
    assert.equal(perIp[0].limit?.requests, 50, `${path}: 초당 건수`);
    assert.equal(perIp[0].limit?.unit, 'Second', `${path}: 단위`);
    const bucket = [...findKey(ps.map((p) => p.spec), 'maxTokens'), ...findKey(ps.map((p) => p.spec), 'burst')].map(Number);
    assert.deepEqual(bucket, [100], `${path}: 모아 두기 건수`);
  }
  // 두 경로는 한 한도를 함께 쓴다(같은 정책)
  const a = routeFor('gw-fan', 'api.peaket.example', 'GET', '/v1/search');
  const b = routeFor('gw-fan', 'api.peaket.example', 'GET', '/v1/search/suggestions');
  assert.deepEqual(routePolicies('BackendTrafficPolicy', a.route).map((p) => p.metadata?.name), routePolicies('BackendTrafficPolicy', b.route).map((p) => p.metadata?.name));
});
