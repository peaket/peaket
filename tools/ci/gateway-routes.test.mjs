// openapi → API 호스트 HTTPRoute 생성기 시험(BUILD_ORDER HOT-410, 묶음 BAT-060 계획 §5·§6의 '단'·'정' 층, D-T42·D-T43 ③,
// docs/security/asvs/delivery.md 3.5.3). 정본: docs/infra.md §4.1 '경로별 메서드·한도·게이트웨이 오류'의 '경로별 메서드 생성기'·'생성기가 멈추는 경우'·
// '생성 대조'·'메서드가 맞지 않는 요청'·'추적 머리', docs/api/guidelines.md §9, docs/devops.md §14 D-T42·D-T43.
// 두 길로 본다: 모듈 generateRoutes({ openapi, sources })와 CLI(node tools/ci/gateway-routes.mjs --write|--check --root <임시 폴더>).
// 생성 결과는 글이 아니라 '라우트가 실제로 받는 (호스트, 메서드, 경로)'를 흉내 내어 견준다(바깥 경계). 경로마다 받는 메서드는 계약의 메서드와 OPTIONS뿐이어야 한다.
// 시험이 정한 약속(계획 §5가 정하지 않은 것. 바꾸려면 계획 파일 '시험 이의'에 적는다):
//   - sources는 게이트웨이 이름 → HTTPRoute 객체 목록인 보통 객체다(파일 deploy/gateways/routes/<게이트웨이>.yaml 하나가 한 항목).
//   - TRACE 405 라우트(<게이트웨이>-trace)는 원천에 두지 않고 생성기가 원천 앞부분으로 만든다.
//   - 생성기가 멈추면(끝 코드 2) 생성 파일을 쓰지 않는다. 까닭 줄에는 그 앞부분이나 계약 경로(openapi에 적힌 꼴 그대로)가 든다.
// 실행(저장소 뿌리): node --test tools/ci/gateway-routes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments, stringify } from 'yaml';
import { generateRoutes } from './gateway-routes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'gateway-routes.mjs');
const REPO = resolve(HERE, '..', '..');

// ---- 정본 값(docs/infra.md §4.1 '호스트와 내부 경로', openapi servers) ----
const GATEWAYS = ['gw-queue', 'gw-fan', 'gw-partner', 'gw-ops', 'gw-scanner'];
/** 게이트웨이마다 생성기가 맡는 API 호스트 */
const API_HOST = {
  'gw-queue': 'queue.peaket.example',
  'gw-fan': 'api.peaket.example',
  'gw-partner': 'partner-api.peaket.example',
  'gw-ops': 'ops-api.peaket.example',
  'gw-scanner': 'scanner-api.peaket.example',
};
/** 저장소 openapi 맨 위 x-peaket-gateways 규칙과 같은 차례(위에서부터 처음 맞는 것) */
const RULES = [
  { prefix: '/v1/ops/', server: 'https://ops-api.peaket.example' },
  { prefix: '/v1/partner/', server: 'https://partner-api.peaket.example' },
  { prefix: '/v1/webhooks/', server: 'https://partner-api.peaket.example' },
  { prefix: '/v1/scanner/', server: 'https://scanner-api.peaket.example' },
  { prefix: '/v1/queues/', server: 'https://queue.peaket.example' },
  { prefix: '/v1/', server: 'https://api.peaket.example' },
];
/** 시험이 흉내 내는 메서드(TRACE는 따로 본다) */
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
/**
 * Gateway API 표준 HTTPRoute CRD의 개수 상한(규칙 16, 규칙의 맞춤 조건 64, 라우트 하나의 맞춤 조건 합 128).
 * 구현 담당이 v1.10 CRD에서 읽은 값이 더 작으면 그 값이 이긴다(시험은 '넘지 않는다'만 본다)
 */
const MAX_RULES = 16;
const MAX_MATCHES_PER_RULE = 64;
const MAX_MATCHES_PER_ROUTE = 128;
const ROUTE_LABEL = 'peaket.io/route';
const AUTH_LABEL = 'peaket.io/auth';

const lc = (s) => String(s).toLowerCase();

// ---- 시험 자료 만들기 ----

/** 작업 하나(응답은 꾸밈) */
const op = (extra = {}) => ({ responses: { 200: { description: 'ok' } }, ...extra });

/**
 * 작은 openapi. spec: 경로 → 'GET POST' 같은 메서드 글이나 { GET: { cdn: true }, … }, 또는 { servers, methods }
 * @param {Record<string, string | Record<string, any>>} spec
 */
function openapiOf(spec, { version = '9.8.10-test', rules = RULES, description = '시험 계약' } = {}) {
  const paths = {};
  for (const [p, v] of Object.entries(spec)) {
    const item = {};
    let methods = v;
    if (v && typeof v === 'object' && 'methods' in v) {
      if (v.servers) item.servers = v.servers.map((url) => ({ url }));
      methods = v.methods;
    }
    const entries = typeof methods === 'string' ? methods.split(/\s+/).filter(Boolean).map((m) => [m, {}]) : Object.entries(methods);
    for (const [m, o] of entries) item[lc(m)] = op({ ...(o?.cdn ? { 'x-peaket-cdn-cache': true } : {}), ...(o?.security ? { security: o.security } : {}), ...(o?.scopes ? { 'x-peaket-scopes': o.scopes } : {}) });
    paths[p] = item;
  }
  return {
    openapi: '3.1.0',
    info: { title: 'gateway-routes 시험', version, description },
    servers: [...new Set(Object.values(API_HOST))].map((h) => ({ url: `https://${h}` })),
    'x-peaket-gateways': { description: '시험 규칙', rules },
    // 작업에 security가 없으면 이 기본값(팬 쿠키)이다. 그래서 시험 원천의 이름표 기본은 token이다(infra §4.1 '인증 종류 대조')
    security: [{ fanCookie: [] }],
    paths,
  };
}

/** 원천 규칙에 두는 요청 머리 고치기(생성 규칙에 그대로 옮겨져야 한다) */
const appFilter = (app) => ({ type: 'RequestHeaderModifier', requestHeaderModifier: { set: [{ name: 'x-peaket-app', value: app }], remove: ['x-peaket-browser-traceparent'] } });

/**
 * 라우트 원천 하나(HTTPRoute, 규칙마다 PathPrefix만). 이름표 peaket.io/auth는 인증 종류(기본 token, infra §4.1 '인증 종류 대조')
 * @param {string} gw @param {string} name @param {Array<{ prefixes: string[], backend: string, app?: string, timeouts?: Record<string, string> }>} rules
 */
function sourceRoute(gw, name, rules, { auth = 'token' } = {}) {
  return {
    apiVersion: 'gateway.networking.k8s.io/v1',
    kind: 'HTTPRoute',
    metadata: { name, namespace: 'envoy-gateway-system', labels: { [AUTH_LABEL]: auth } },
    spec: {
      parentRefs: [{ name: gw }],
      hostnames: [API_HOST[gw]],
      rules: rules.map((r) => ({
        matches: r.prefixes.map((value) => ({ path: { type: 'PathPrefix', value } })),
        filters: [appFilter(r.app ?? 'web')],
        backendRefs: [{ name: r.backend, port: 8080 }],
        ...(r.timeouts ? { timeouts: r.timeouts } : {}),
      })),
    },
  };
}

const temps = [];
process.on('exit', () => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** 임시 저장소: docs/api/openapi.yaml과 deploy/gateways/routes/<게이트웨이>.yaml */
function fixture(openapi, sources) {
  const root = mkdtempSync(join(tmpdir(), 'gateway-routes-'));
  temps.push(root);
  mkdirSync(join(root, 'docs', 'api'), { recursive: true });
  mkdirSync(join(root, 'deploy', 'gateways', 'routes'), { recursive: true });
  writeFileSync(join(root, 'docs', 'api', 'openapi.yaml'), stringify(openapi));
  for (const [gw, routes] of Object.entries(sources)) writeFileSync(join(root, 'deploy', 'gateways', 'routes', `${gw}.yaml`), routes.map((r) => stringify(r)).join('---\n'));
  return root;
}

/** CLI 한 번(종료 코드와 표준 출력·오류를 합친 글) */
function cli(root, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, '--root', root], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

const genPath = (gw) => `deploy/gateways/${gw}.routes.yaml`;

// ---- 생성 결과 읽기와 흉내 ----

/** 생성 파일 글 → HTTPRoute 객체들 */
function routesIn(text) {
  const out = [];
  for (const d of parseAllDocuments(text)) {
    assert.equal(d.errors.length, 0, `생성 파일이 YAML로 읽히지 않는다: ${d.errors[0]?.message}`);
    const o = d.toJS();
    if (o && typeof o === 'object') out.push(o);
  }
  return out;
}
/** 생성 결과(Map) → 게이트웨이마다 라우트 */
function routesByGateway(files) {
  const out = {};
  for (const [rel, text] of files) {
    const m = /^deploy\/gateways\/(gw-[a-z]+)\.routes\.yaml$/.exec(rel.replaceAll('\\', '/'));
    assert.ok(m, `생성 파일 경로 꼴이 아니다: ${rel}`);
    out[m[1]] = routesIn(text);
  }
  return out;
}
const isTrace = (r, gw) => r.metadata?.name === `${gw}-trace`;
const apiRoutes = (routes, gw) => routes.filter((r) => !isTrace(r, gw));
const rulesOf = (r) => r.spec?.rules ?? [];
const matchesOf = (rule) => rule.matches ?? [{}];
const allMatches = (routes) => routes.flatMap((r) => rulesOf(r).flatMap((rule) => matchesOf(rule).map((m) => ({ route: r, rule, m }))));

/** 맞춤 조건의 경로가 요청 경로에 맞는가(Envoy: 정규식은 전체 맞춤) */
function pathMatches(m, path) {
  const p = m.path ?? { type: 'PathPrefix', value: '/' };
  const v = p.value ?? '/';
  if (p.type === 'Exact') return v === path;
  if (p.type === 'RegularExpression') return new RegExp(`^(?:${v})$`).test(path);
  const pre = v.endsWith('/') ? v : `${v}/`;
  return v === '/' || path === v || path.startsWith(pre);
}
/** 라우트들이 그 호스트·경로에서 받는 메서드(메서드 조건이 없는 맞춤은 모든 메서드를 받는다) */
function allowedByRoutes(routes, host, path) {
  const out = new Set();
  for (const r of routes) {
    if (!(r.spec?.hostnames ?? []).includes(host)) continue;
    for (const rule of rulesOf(r))
      for (const m of matchesOf(rule)) {
        if (!pathMatches(m, path)) continue;
        if (m.method) out.add(m.method);
        else for (const x of [...METHODS, 'TRACE']) out.add(x);
      }
  }
  return out;
}

/** 계약 경로 틀 → 정규식(틀 {이름}은 빗금 없는 한 마디, 나머지 글자는 그대로) */
const templateRe = (p) => new RegExp(`^${p.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}/]+\\?\}/g, '[^/]+')}$`);
/** 경로를 받는 서버 호스트(경로 servers가 이기고, 없으면 x-peaket-gateways의 위에서 처음 맞는 규칙) */
function hostOf(openapi, path) {
  const item = openapi.paths[path];
  const url = item.servers?.[0]?.url ?? (openapi['x-peaket-gateways']?.rules ?? []).find((r) => path.startsWith(r.prefix))?.server;
  return url ? new URL(url).host : undefined;
}
const opMethods = (item) => METHODS.filter((m) => item[lc(m)]);
/** 계약이 그 호스트·경로에서 받는 메서드(틀이 맞는 계약 경로 모두) */
function allowedByContract(openapi, host, path) {
  const out = new Set();
  for (const [p, item] of Object.entries(openapi.paths)) if (hostOf(openapi, p) === host && templateRe(p).test(path)) for (const m of opMethods(item)) out.add(m);
  return out;
}
/** 흉내 볼 경로: 계약 경로마다 틀을 채운 것, 틀이 있으면 한 마디 더 붙인 것과 빈 마디 */
function samplePaths(openapi, host) {
  const out = new Set();
  for (const p of Object.keys(openapi.paths)) {
    if (hostOf(openapi, p) !== host) continue;
    out.add(p.replace(/\{[^}]+\}/g, 'a1'));
    if (/\{[^}]+\}/.test(p)) {
      out.add(p.replace(/\{[^}]+\}/g, 'a1/zz9'));
      out.add(p.replace(/\{[^}]+\}/g, ''));
    }
  }
  return [...out].sort();
}
const fmt = (s) => [...s].sort().join(',') || '(없음)';

/** 경로마다 받는 메서드가 정확히 계약의 메서드 + OPTIONS(계약이 받는 경로일 때)인지 본다 */
function assertMethodsExact(openapi, routes, gw, label = '') {
  const host = API_HOST[gw];
  const api = apiRoutes(routes, gw);
  const samples = samplePaths(openapi, host);
  assert.ok(samples.length > 0, `${label}${gw}: 흉내 볼 계약 경로가 없다`);
  for (const path of samples) {
    const want = allowedByContract(openapi, host, path);
    if (want.size) want.add('OPTIONS');
    const got = allowedByRoutes(api, host, path);
    for (const m of [...METHODS, 'TRACE']) {
      assert.equal(got.has(m), want.has(m), `${label}${gw} ${m} ${path}: 라우트 ${got.has(m) ? '받음' : '안 받음'}, 계약 ${want.has(m) ? '받음' : '안 받음'}(라우트 ${fmt(got)} / 계약+OPTIONS ${fmt(want)})`);
    }
  }
}

/** 규칙의 응답 머리 고치기 가운데 X-Trace-Id 붙이기 */
const traceIdHeaders = (rule) =>
  (rule.filters ?? [])
    .filter((f) => f.type === 'ResponseHeaderModifier')
    .flatMap((f) => [...(f.responseHeaderModifier?.set ?? []), ...(f.responseHeaderModifier?.add ?? [])])
    .filter((h) => lc(h.name) === 'x-trace-id');
/** 규칙의 글(필터 전부)에 x-trace-id가 나오는가 */
const mentionsTraceId = (rule) => /x-trace-id/i.test(JSON.stringify(rule.filters ?? []));

/** 생성 결과를 받는다(멈춤이 없어야 한다) */
function generated(openapi, sources) {
  const r = generateRoutes({ openapi, sources });
  assert.ok(r && r.files instanceof Map, 'generateRoutes는 { files: Map, problems }를 돌려준다');
  assert.deepEqual(r.problems, [], `멈추지 않아야 한다: ${r.problems.join(' / ')}`);
  return r;
}

// ---- 공통 시험 자료 ----

/** gw-fan·gw-partner 둘의 작은 계약과 원천 */
function smallSpec() {
  const openapi = openapiOf({
    '/v1/events/{eventId}': 'GET',
    '/v1/events/{eventId}/holds': 'POST',
    '/v1/events/{eventId}/subscriptions': 'POST DELETE',
    '/v1/orders/{orderId}': 'GET',
    '/v1/orders/{orderId}/payments': 'POST',
    '/v1/orders/{orderId}/receipt.pdf': 'GET',
    '/v1/partner/events/{eventId}': 'PATCH',
    '/v1/partner/productions/{productionId}/events': 'POST',
    '/v1/webhooks/toss': 'POST',
  });
  const sources = {
    'gw-fan': [sourceRoute('gw-fan', 'gw-fan-api', [{ prefixes: ['/v1/events'], backend: 'core-svc' }]), sourceRoute('gw-fan', 'gw-fan-buy', [{ prefixes: ['/v1/orders'], backend: 'purchase-svc' }])],
    'gw-partner': [
      sourceRoute('gw-partner', 'gw-partner-api', [{ prefixes: ['/v1/partner/events', '/v1/partner/productions'], backend: 'core-svc', app: 'partner' }]),
      sourceRoute('gw-partner', 'gw-partner-webhooks', [{ prefixes: ['/v1/webhooks'], backend: 'payment-svc', app: 'partner' }]),
    ],
  };
  return { openapi, sources };
}

/** 다섯 게이트웨이 모두의 작은 계약과 원천 */
function fiveSpec() {
  const openapi = openapiOf({
    '/v1/queues/{eventId}/entries': 'POST',
    '/v1/queues/{eventId}/verification': 'GET',
    '/v1/events/{eventId}': 'GET',
    '/v1/partner/productions/{productionId}/events': 'POST',
    '/v1/ops/events/{eventId}': 'GET PATCH',
    '/v1/scanner/device-enrollments': 'POST',
  });
  const sources = {
    'gw-queue': [sourceRoute('gw-queue', 'gw-queue-api', [{ prefixes: ['/v1/queues'], backend: 'queue-svc' }])],
    'gw-fan': [sourceRoute('gw-fan', 'gw-fan-api', [{ prefixes: ['/v1/events'], backend: 'core-svc' }])],
    'gw-partner': [sourceRoute('gw-partner', 'gw-partner-api', [{ prefixes: ['/v1/partner/productions'], backend: 'core-svc', app: 'partner' }])],
    'gw-ops': [sourceRoute('gw-ops', 'gw-ops-api', [{ prefixes: ['/v1/ops/events'], backend: 'core-svc', app: 'console' }])],
    'gw-scanner': [sourceRoute('gw-scanner', 'gw-scanner-public', [{ prefixes: ['/v1/scanner/device-enrollments'], backend: 'ticket-svc', app: 'scanner' }])],
  };
  return { openapi, sources };
}

// ===================== 메서드 제한(ASVS 3.5.3) =====================

test('[ASVS v5.0.0-3.5.3] 생성기는 계약의 메서드만 쓴다: POST만 있는 경로에 GET·PUT·DELETE 조건이 없고, 경로 틀은 한 마디만 맞는다(/v1/events/a/b는 /v1/events/{id}에 안 맞는다)', () => {
  const { openapi, sources } = smallSpec();
  const by = routesByGateway(generated(openapi, sources).files);
  // POST만 받는 경로: 허용 밖 메서드마다 따로 본다
  const holds = allowedByRoutes(apiRoutes(by['gw-fan'], 'gw-fan'), 'api.peaket.example', '/v1/events/e1/holds');
  for (const m of ['GET', 'PUT', 'DELETE', 'PATCH', 'HEAD']) assert.ok(!holds.has(m), `POST만 받는 /v1/events/e1/holds에 ${m} 조건이 있다(${fmt(holds)})`);
  assert.deepEqual([...holds].sort(), ['OPTIONS', 'POST']);
  // 경로 틀은 빗금 없는 한 마디
  for (const path of ['/v1/events/a/b', '/v1/events/', '/v1/events', '/v1/events/a1/holds/x']) assert.equal(allowedByRoutes(apiRoutes(by['gw-fan'], 'gw-fan'), 'api.peaket.example', path).size, 0, `${path}가 라우트에 맞는다`);
  assert.deepEqual([...allowedByRoutes(apiRoutes(by['gw-fan'], 'gw-fan'), 'api.peaket.example', '/v1/events/a1')].sort(), ['GET', 'OPTIONS']);
  // 맞춤 조건은 모두 메서드가 있고 경로는 Exact나 정규식이다(앞부분 맞춤은 없다)
  for (const gw of ['gw-fan', 'gw-partner']) {
    const ms = allMatches(apiRoutes(by[gw], gw));
    assert.ok(ms.length > 0, `${gw}: 생성한 맞춤 조건이 없다`);
    for (const { route, m } of ms) {
      assert.ok(typeof m.method === 'string' && m.method !== '', `${gw}/${route.metadata?.name}: 메서드 없는 맞춤 ${JSON.stringify(m)}`);
      assert.ok(['Exact', 'RegularExpression'].includes(m.path?.type), `${gw}/${route.metadata?.name}: 경로 꼴 ${JSON.stringify(m.path)}`);
    }
    assertMethodsExact(openapi, by[gw], gw);
  }
});

test('[ASVS v5.0.0-3.5.3] 같은 틀의 다른 경로(/v1/orders/{id}와 /v1/orders/{id}/payments)의 메서드를 합치지 않고, 틀 밖 글자(점)는 글자 그대로 맞춘다', () => {
  const { openapi, sources } = smallSpec();
  const fan = apiRoutes(routesByGateway(generated(openapi, sources).files)['gw-fan'], 'gw-fan');
  const host = 'api.peaket.example';
  assert.deepEqual([...allowedByRoutes(fan, host, '/v1/orders/o1')].sort(), ['GET', 'OPTIONS'], '/v1/orders/o1');
  assert.deepEqual([...allowedByRoutes(fan, host, '/v1/orders/o1/payments')].sort(), ['OPTIONS', 'POST'], '/v1/orders/o1/payments');
  assert.deepEqual([...allowedByRoutes(fan, host, '/v1/orders/o1/receipt.pdf')].sort(), ['GET', 'OPTIONS'], '/v1/orders/o1/receipt.pdf');
  for (const path of ['/v1/orders/o1/receiptxpdf', '/v1/orders/o1/receipt.pdfx', '/v1/orders/o1/receipt/pdf']) assert.equal(allowedByRoutes(fan, host, path).size, 0, `${path}가 라우트에 맞는다(점을 아무 글자로 읽었다)`);
});

test('D-T42 ③ 생성기는 다섯 게이트웨이 각각 계약 경로마다 OPTIONS 조건을 넣고 HEAD는 넣지 않는다', () => {
  const { openapi, sources } = fiveSpec();
  const by = routesByGateway(generated(openapi, sources).files);
  assert.deepEqual(Object.keys(by).sort(), [...GATEWAYS].sort(), '게이트웨이 다섯의 생성 파일');
  for (const gw of GATEWAYS) {
    const host = API_HOST[gw];
    const paths = Object.keys(openapi.paths).filter((p) => hostOf(openapi, p) === host);
    assert.ok(paths.length > 0, `${gw}: 시험 계약 경로가 없다`);
    for (const p of paths) {
      const got = allowedByRoutes(apiRoutes(by[gw], gw), host, p.replace(/\{[^}]+\}/g, 'a1'));
      assert.ok(got.has('OPTIONS'), `${gw} ${p}: OPTIONS 조건이 없다(${fmt(got)})`);
      assert.ok(!got.has('HEAD'), `${gw} ${p}: HEAD 조건이 있다`);
    }
    assertMethodsExact(openapi, by[gw], gw);
  }
});

// ===================== 받는 게이트웨이 정하기 =====================

test("HOT-410 infra §4.1 '경로별 메서드 생성기' x-peaket-gateways 첫 맞는 규칙과 경로 servers가 받는 게이트웨이를 정한다", () => {
  const openapi = openapiOf({
    '/v1/partner/events/{eventId}': 'GET',
    '/v1/partners-guide': 'GET', // '/v1/partner/' 앞부분(빗금까지)에 맞지 않아 api다
    '/v1/things': 'GET',
    '/v1/partner/legacy-home': { methods: 'GET', servers: ['https://api.peaket.example'] }, // 경로 servers가 이긴다
    '/v1/home/rankings.json': { methods: 'GET', servers: ['https://www.peaket.example'] }, // API 호스트가 아니라 생성기가 맡지 않는다
  });
  const sources = {
    'gw-partner': [sourceRoute('gw-partner', 'gw-partner-api', [{ prefixes: ['/v1/partner/events'], backend: 'core-svc', app: 'partner' }])],
    'gw-fan': [sourceRoute('gw-fan', 'gw-fan-api', [{ prefixes: ['/v1/partners-guide', '/v1/things', '/v1/partner/legacy-home'], backend: 'core-svc' }])],
  };
  const by = routesByGateway(generated(openapi, sources).files);
  const partner = apiRoutes(by['gw-partner'], 'gw-partner');
  const fan = apiRoutes(by['gw-fan'], 'gw-fan');
  assert.ok(allowedByRoutes(partner, 'partner-api.peaket.example', '/v1/partner/events/e1').has('GET'), 'gw-partner가 /v1/partner/events/{eventId}를 받지 않는다');
  for (const p of ['/v1/partners-guide', '/v1/things', '/v1/partner/legacy-home']) {
    assert.ok(allowedByRoutes(fan, 'api.peaket.example', p).has('GET'), `gw-fan이 ${p}를 받지 않는다`);
    assert.equal(allowedByRoutes(partner, 'partner-api.peaket.example', p).size, 0, `gw-partner가 ${p}를 받는다`);
  }
  for (const [gw, rs] of Object.entries(by)) assert.equal(allowedByRoutes(apiRoutes(rs, gw), API_HOST[gw], '/v1/home/rankings.json').size, 0, `${gw}가 www 경로를 받는다`);
  assert.ok(!JSON.stringify([...by['gw-fan'], ...by['gw-partner']]).includes('rankings.json'), 'www 경로가 생성 파일에 있다');
});

test("HOT-410 infra §4.1 '경로별 메서드 생성기' /v1/webhooks/는 저장소 openapi의 규칙 차례로 partner-api(gw-partner)에 가고 api(gw-fan)에 가지 않는다", () => {
  const real = parse(readFileSync(join(REPO, 'docs', 'api', 'openapi.yaml'), 'utf8'));
  const rules = real['x-peaket-gateways']?.rules;
  assert.ok(Array.isArray(rules) && rules.length > 0, '저장소 openapi에 x-peaket-gateways 규칙이 없다');
  const openapi = openapiOf({ '/v1/webhooks/toss': 'POST', '/v1/webhooks/portone': 'POST', '/v1/things': 'GET' }, { rules });
  const sources = {
    'gw-partner': [sourceRoute('gw-partner', 'gw-partner-webhooks', [{ prefixes: ['/v1/webhooks'], backend: 'payment-svc', app: 'partner' }])],
    'gw-fan': [sourceRoute('gw-fan', 'gw-fan-api', [{ prefixes: ['/v1/things'], backend: 'core-svc' }])],
  };
  const by = routesByGateway(generated(openapi, sources).files);
  for (const p of ['/v1/webhooks/toss', '/v1/webhooks/portone']) {
    assert.deepEqual([...allowedByRoutes(apiRoutes(by['gw-partner'], 'gw-partner'), 'partner-api.peaket.example', p)].sort(), ['OPTIONS', 'POST'], `gw-partner ${p}`);
    assert.equal(allowedByRoutes(apiRoutes(by['gw-fan'], 'gw-fan'), 'api.peaket.example', p).size, 0, `gw-fan이 ${p}를 받는다`);
  }
});

// ===================== 멈추는 경우 =====================

/** 멈춤 사례: 모듈 problems와 CLI 종료 2에 그 까닭(글)이 나오고 생성 파일을 쓰지 않는다 */
function assertStops(openapi, sources, needle) {
  const r = generateRoutes({ openapi, sources });
  assert.ok(Array.isArray(r?.problems), 'problems 목록이 없다');
  assert.ok(r.problems.some((p) => p.includes(needle)), `멈춤 까닭에 ${needle}가 없다: ${JSON.stringify(r.problems)}`);
  const root = fixture(openapi, sources);
  const c = cli(root, '--write');
  assert.equal(c.status, 2, `CLI 종료 코드: ${c.status}\n${c.out}`);
  assert.ok(c.out.includes(needle), `CLI 출력에 ${needle}가 없다:\n${c.out}`);
  for (const gw of Object.keys(sources)) assert.ok(!existsSync(join(root, genPath(gw))), `멈췄는데 ${genPath(gw)}를 썼다`);
}

test("HOT-410 infra §4.1 '생성기가 멈추는 경우' 원천 앞부분이 계약 경로를 하나도 맡지 않으면 2로 끝나고 그 앞부분을 보인다", () => {
  const openapi = openapiOf({ '/v1/partner/events/{eventId}': 'PATCH' });
  const sources = { 'gw-partner': [sourceRoute('gw-partner', 'gw-partner-api', [{ prefixes: ['/v1/partner/events', '/v1/partner/nothing-here'], backend: 'core-svc', app: 'partner' }])] };
  assertStops(openapi, sources, '/v1/partner/nothing-here');
});

test("HOT-410 infra §4.1 '생성기가 멈추는 경우' 그 게이트웨이가 받는 계약 경로를 맡는 규칙이 없으면 2로 끝나고 그 경로를 보인다(조용히 버리지 않는다)", () => {
  const openapi = openapiOf({ '/v1/partner/events/{eventId}': 'PATCH', '/v1/partner/orphans': 'GET' });
  const sources = { 'gw-partner': [sourceRoute('gw-partner', 'gw-partner-api', [{ prefixes: ['/v1/partner/events'], backend: 'core-svc', app: 'partner' }])] };
  assertStops(openapi, sources, '/v1/partner/orphans');
});

test("HOT-410 infra §4.1 '생성기가 멈추는 경우' 두 규칙이 한 경로를 함께 맡으면 2로 끝나고 그 경로를 보인다", () => {
  const openapi = openapiOf({ '/v1/partner/events/{eventId}': 'PATCH', '/v1/partner/teams': 'GET' });
  const sources = {
    'gw-partner': [
      sourceRoute('gw-partner', 'gw-partner-api', [
        { prefixes: ['/v1/partner/events'], backend: 'core-svc', app: 'partner' },
        { prefixes: ['/v1/partner'], backend: 'identity-svc', app: 'partner' },
      ]),
    ],
  };
  assertStops(openapi, sources, '/v1/partner/events/{eventId}');
});

/** 원천 규칙 맞춤 하나를 Exact로 바꾼다(경로 값은 openapi 꼴, BAT-060 시험 이의 2 판단) */
function exactSource(route, ruleIndex = 0) {
  const r = structuredClone(route);
  r.spec.rules[ruleIndex].matches = r.spec.rules[ruleIndex].matches.map((m) => ({ path: { type: 'Exact', value: m.path.value } }));
  return r;
}

test("HOT-410 infra §4.1 '경로별 메서드 생성기' Exact 원천 맞춤은 그 계약 경로 하나만 맡고 그 아래 경로는 다른 라우트가 맡는다(openapi 꼴 경로 값)", () => {
  const openapi = openapiOf({
    '/v1/events/{eventId}': 'GET',
    '/v1/events/{eventId}/holds': 'POST',
    '/v1/events/{eventId}/seatmap-snapshot': 'GET',
  });
  const sources = {
    'gw-fan': [
      exactSource(sourceRoute('gw-fan', 'gw-fan-api', [{ prefixes: ['/v1/events/{eventId}'], backend: 'core-svc' }])),
      sourceRoute('gw-fan', 'gw-fan-buy', [{ prefixes: ['/v1/events/{eventId}/holds', '/v1/events/{eventId}/seatmap-snapshot'], backend: 'purchase-svc' }]),
    ],
  };
  const routes = apiRoutes(routesByGateway(generated(openapi, sources).files)['gw-fan'], 'gw-fan');
  const from = (name) => routes.filter((r) => r.metadata?.labels?.[ROUTE_LABEL] === name);
  const host = 'api.peaket.example';
  assert.deepEqual([...allowedByRoutes(from('gw-fan-api'), host, '/v1/events/e1')].sort(), ['GET', 'OPTIONS'], 'gw-fan-api가 /v1/events/{eventId}를 맡는다');
  for (const p of ['/v1/events/e1/holds', '/v1/events/e1/seatmap-snapshot', '/v1/events/e1/x']) assert.equal(allowedByRoutes(from('gw-fan-api'), host, p).size, 0, `Exact 원천(gw-fan-api)이 그 아래 ${p}를 맡는다`);
  assert.deepEqual([...allowedByRoutes(from('gw-fan-buy'), host, '/v1/events/e1/holds')].sort(), ['OPTIONS', 'POST'], 'gw-fan-buy가 holds를 맡는다');
  assert.equal(allowedByRoutes(from('gw-fan-buy'), host, '/v1/events/e1').size, 0, 'gw-fan-buy가 /v1/events/{eventId}를 맡는다');
  for (const r of from('gw-fan-api')) for (const rule of rulesOf(r)) assert.deepEqual(rule.backendRefs, [{ name: 'core-svc', port: 8080 }]);
  for (const r of from('gw-fan-buy')) for (const rule of rulesOf(r)) assert.deepEqual(rule.backendRefs, [{ name: 'purchase-svc', port: 8080 }]);
  assertMethodsExact(openapi, routesByGateway(generated(openapi, sources).files)['gw-fan'], 'gw-fan');
});

test("HOT-410 infra §4.1 '생성기가 멈추는 경우' Exact 원천 맞춤과 PathPrefix 원천 맞춤이 한 경로를 함께 맡으면 2로 끝나고 그 경로를 보인다", () => {
  const openapi = openapiOf({ '/v1/events/{eventId}': 'GET', '/v1/events/{eventId}/holds': 'POST' });
  const sources = {
    'gw-fan': [
      exactSource(sourceRoute('gw-fan', 'gw-fan-api', [{ prefixes: ['/v1/events/{eventId}'], backend: 'core-svc' }])),
      sourceRoute('gw-fan', 'gw-fan-buy', [{ prefixes: ['/v1/events'], backend: 'purchase-svc' }]),
    ],
  };
  assertStops(openapi, sources, '/v1/events/{eventId}');
});

test("HOT-410 infra §4.1 '생성기가 멈추는 경우' Exact 원천 맞춤이 계약 경로가 아니면(맡는 경로가 없으면) 2로 끝나고 그 경로를 보인다", () => {
  const openapi = openapiOf({ '/v1/events/{eventId}': 'GET' });
  const sources = {
    'gw-fan': [
      sourceRoute('gw-fan', 'gw-fan-api', [{ prefixes: ['/v1/events/{eventId}'], backend: 'core-svc' }]),
      exactSource(sourceRoute('gw-fan', 'gw-fan-buy', [{ prefixes: ['/v1/events/{eventId}/no-such'], backend: 'purchase-svc' }])),
    ],
  };
  assertStops(openapi, sources, '/v1/events/{eventId}/no-such');
});

// ===================== 인증 종류 대조·시간 상한(BAT-060 계획 15절, BAT-055 웨이브 끝 리뷰) =====================

const DPOP_OR_MTLS = [{ deviceDpop: [] }, { deviceMtls: [] }];
const BUY = [{ fanCookie: [], admissionToken: [] }];
/** 입장 토큰이 없는 갈래가 하나 있다: token이다(token-buy가 아니다) */
const BUY_OR_PLAIN = [{ fanCookie: [] }, { fanCookie: [], admissionToken: [] }];
const OPTIONAL = [{}, { fanCookie: [] }];
/** 게이트웨이가 요구하는 스코프(openapi 확장 x-peaket-scopes, infra §4.1 '인증 종류 대조' ①, BAT-060 '판단: 인증 종류 대조의 시험 이의 둘' 1) */
const TICKET_BUY = ['ticket:buy'];

test('W7-WIR-01 원천에서 security가 deviceDpop|deviceMtls인 작업(POST /v1/scanner/token)을 토큰 라우트(peaket.io/auth: token)에 두면 생성기가 2로 멈추고 그 작업을 보인다', () => {
  const openapi = openapiOf({ '/v1/scanner/token': { POST: { security: DPOP_OR_MTLS } }, '/v1/scanner/events/{eventId}/package': { GET: { security: [{ staffToken: [] }] } } });
  const sources = { 'gw-scanner': [sourceRoute('gw-scanner', 'gw-scanner-api', [{ prefixes: ['/v1/scanner'], backend: 'ticket-svc', app: 'scanner' }], { auth: 'token' })] };
  assertStops(openapi, sources, '/v1/scanner/token');
});

test("W7-WIR-05 W7-COR-04 RV-04 infra §4.1 '인증 종류 대조' security로 public·optional·token·token-buy를 정하고 원천 이름표가 같으면 멈추지 않으며, 다르면 종류마다 2로 멈춘다", () => {
  const openapi = openapiOf({
    '/v1/scanner/token': { POST: { security: DPOP_OR_MTLS } }, // public: 액세스 토큰 방식이 없는 갈래뿐
    '/v1/partner/auth/invitation-acceptances': { POST: { security: [] } }, // public: security: []
    '/v1/events/{eventId}/reviews': { GET: { security: OPTIONAL } }, // optional: 빈 갈래와 토큰 갈래
    '/v1/holds/{holdId}': { GET: { security: BUY, scopes: TICKET_BUY } }, // token-buy: x-peaket-scopes에 ticket:buy(구매 경로라 칸이 꼭 있다)
    '/v1/orders/{orderId}/payment-status': { GET: { security: BUY_OR_PLAIN } }, // token: 칸이 없고 입장 토큰 없는 갈래가 있다
    '/v1/orders/{orderId}': 'GET', // token: 기본 security
  });
  const sources = {
    'gw-scanner': [sourceRoute('gw-scanner', 'gw-scanner-public', [{ prefixes: ['/v1/scanner/token'], backend: 'identity-svc', app: 'scanner' }], { auth: 'public' })],
    'gw-partner': [sourceRoute('gw-partner', 'gw-partner-public', [{ prefixes: ['/v1/partner/auth/invitation-acceptances'], backend: 'identity-svc', app: 'partner' }], { auth: 'public' })],
    'gw-fan': [
      sourceRoute('gw-fan', 'gw-fan-optional', [{ prefixes: ['/v1/events'], backend: 'core-svc' }], { auth: 'optional' }),
      sourceRoute('gw-fan', 'gw-fan-buy', [{ prefixes: ['/v1/holds'], backend: 'purchase-svc' }], { auth: 'token-buy' }),
      sourceRoute('gw-fan', 'gw-fan-api', [{ prefixes: ['/v1/orders'], backend: 'purchase-svc' }], { auth: 'token' }),
    ],
  };
  generated(openapi, sources);
  // 종류가 다르면 멈춘다(라우트 하나, 작업 하나씩)
  for (const [path, security, gw, auth, scopes] of [
    ['/v1/holds/{holdId}', BUY, 'gw-fan', 'token', TICKET_BUY],
    ['/v1/events/{eventId}/reviews', OPTIONAL, 'gw-fan', 'public'],
    ['/v1/events/{eventId}/reviews', OPTIONAL, 'gw-fan', 'token'],
    ['/v1/orders/{orderId}/payment-status', BUY_OR_PLAIN, 'gw-fan', 'token-buy'],
    ['/v1/orders/{orderId}', undefined, 'gw-fan', 'public'],
    ['/v1/partner/auth/invitation-acceptances', [], 'gw-partner', 'token'],
    ['/v1/partner/auth/invitation-acceptances', [], 'gw-partner', 'optional'],
  ]) {
    const spec = { [path]: { GET: { ...(security === undefined ? {} : { security }), ...(scopes ? { scopes } : {}) } } };
    assertStops(openapiOf(spec), { [gw]: [sourceRoute(gw, `${gw}-x`, [{ prefixes: [path.replace(/\/\{[^}]+\}.*$/, '')], backend: 'core-svc' }], { auth })] }, path);
  }
});

test("W7-WIR-05 infra §4.1 '인증 종류 대조' 원천 라우트에 이름표 peaket.io/auth가 없으면 생성기가 2로 멈추고 그 라우트 이름을 보인다", () => {
  const openapi = openapiOf({ '/v1/events/{eventId}': 'GET' });
  const src = sourceRoute('gw-fan', 'gw-fan-unlabelled', [{ prefixes: ['/v1/events'], backend: 'core-svc' }]);
  delete src.metadata.labels;
  assertStops(openapi, { 'gw-fan': [src] }, 'gw-fan-unlabelled');
});

test("W7-COR-04 infra §4.1 '인증 종류 대조' ① 겹친 가드: 구매 경로(모든 갈래에 admissionToken) 작업에서 x-peaket-scopes를 지운 openapi면 token-buy 라우트에 두어도 생성기가 2로 멈추고 그 작업을 보인다", () => {
  const withScope = openapiOf({ '/v1/holds/{holdId}': { GET: { security: BUY, scopes: TICKET_BUY } } });
  const sources = { 'gw-fan': [sourceRoute('gw-fan', 'gw-fan-buy', [{ prefixes: ['/v1/holds'], backend: 'purchase-svc' }], { auth: 'token-buy' })] };
  generated(withScope, sources);
  const without = openapiOf({ '/v1/holds/{holdId}': { GET: { security: BUY } } });
  assertStops(without, sources, '/v1/holds/{holdId}');
  // token 라우트로 옮겨도 멈춘다(칸이 없다고 token으로 읽지 않는다)
  assertStops(without, { 'gw-fan': [sourceRoute('gw-fan', 'gw-fan-api', [{ prefixes: ['/v1/holds'], backend: 'purchase-svc' }], { auth: 'token' })] }, '/v1/holds/{holdId}');
});

test("W7-COR-04 infra §4.1 '인증 종류 대조' ① fanCookie만인 작업(대기열 진입)에 x-peaket-scopes: [ticket:buy]가 있으면 token-buy 라우트로 가야 하고 token 라우트면 2로 멈춘다", () => {
  const openapi = openapiOf({ '/v1/queues/{eventId}/entries': { POST: { security: [{ fanCookie: [] }], scopes: TICKET_BUY } } });
  const route = (auth) => ({ 'gw-queue': [exactSource(sourceRoute('gw-queue', `gw-queue-${auth}`, [{ prefixes: ['/v1/queues/{eventId}/entries'], backend: 'queue-svc' }], { auth }))] });
  generated(openapi, route('token-buy'));
  assertStops(openapi, route('token'), '/v1/queues/{eventId}/entries');
  // 칸이 없으면 같은 작업은 token이다(token-buy 라우트면 멈춘다)
  assertStops(openapiOf({ '/v1/queues/{eventId}/entries': { POST: { security: [{ fanCookie: [] }] } } }), route('token-buy'), '/v1/queues/{eventId}/entries');
});

/** 원천 맞춤 하나(경로 Exact와 메서드) */
const methodSource = (gw, name, path, method, backend, auth) => {
  const r = sourceRoute(gw, name, [{ prefixes: [path], backend }], { auth });
  r.spec.rules[0].matches = [{ path: { type: 'Exact', value: path }, method }];
  return r;
};

test("W7-COR-04 infra §4.1 '경로별 메서드 생성기' 원천 맞춤에 method가 있으면 그 메서드의 작업만 맡는다(GET /v1/orders는 token 라우트, POST /v1/orders는 token-buy 라우트)", () => {
  const openapi = openapiOf({ '/v1/orders': { GET: {}, POST: { security: BUY, scopes: TICKET_BUY } } });
  const sources = {
    'gw-fan': [methodSource('gw-fan', 'gw-fan-api', '/v1/orders', 'GET', 'purchase-svc', 'token'), methodSource('gw-fan', 'gw-fan-buy', '/v1/orders', 'POST', 'purchase-svc', 'token-buy')],
  };
  const routes = apiRoutes(routesByGateway(generated(openapi, sources).files)['gw-fan'], 'gw-fan');
  const from = (name) => routes.filter((r) => r.metadata?.labels?.[ROUTE_LABEL] === name);
  const host = 'api.peaket.example';
  const api = allowedByRoutes(from('gw-fan-api'), host, '/v1/orders');
  const buy = allowedByRoutes(from('gw-fan-buy'), host, '/v1/orders');
  assert.ok(api.has('GET') && !api.has('POST'), `gw-fan-api가 받는 메서드: ${fmt(api)}`);
  assert.ok(buy.has('POST') && !buy.has('GET'), `gw-fan-buy가 받는 메서드: ${fmt(buy)}`);
  // 한 경로를 두 라우트가 나눠도 OPTIONS는 그 경로에 있다(사전 요청이 CORS 정책에 닿는다)
  assert.ok(allowedByRoutes(routes, host, '/v1/orders').has('OPTIONS'), 'OPTIONS가 없다');
  assertMethodsExact(openapi, routesByGateway(generated(openapi, sources).files)['gw-fan'], 'gw-fan');
});

test("W7-COR-04 infra §4.1 '생성기가 멈추는 경우' 같은 경로·메서드 짝을 두 원천 규칙이 맡으면 2로 멈추고 그 작업을 보인다(method 맞춤과 경로만 맞춤의 겹침 포함)", () => {
  const openapi = openapiOf({ '/v1/orders': { GET: {}, POST: { security: BUY, scopes: TICKET_BUY } } });
  // 바탕: 짝마다 규칙 하나면 멈추지 않는다(method 맞춤 자체를 거부해서 아래 멈춤이 통과로 새지 않게)
  generated(openapi, { 'gw-fan': [methodSource('gw-fan', 'gw-fan-api', '/v1/orders', 'GET', 'purchase-svc', 'token'), methodSource('gw-fan', 'gw-fan-buy', '/v1/orders', 'POST', 'purchase-svc', 'token-buy')] });
  // 같은 짝(POST /v1/orders)을 method 맞춤 둘이 맡는다
  assertStops(openapi, { 'gw-fan': [methodSource('gw-fan', 'gw-fan-api', '/v1/orders', 'GET', 'purchase-svc', 'token'), methodSource('gw-fan', 'gw-fan-buy', '/v1/orders', 'POST', 'purchase-svc', 'token-buy'), methodSource('gw-fan', 'gw-fan-buy-2', '/v1/orders', 'POST', 'purchase-svc', 'token-buy')] }, '/v1/orders');
  // 경로만 맞춤(모든 메서드)과 method 맞춤이 POST /v1/orders를 함께 맡는다
  const pathOnly = exactSource(sourceRoute('gw-fan', 'gw-fan-api', [{ prefixes: ['/v1/orders'], backend: 'purchase-svc' }], { auth: 'token' }));
  assertStops(openapi, { 'gw-fan': [pathOnly, methodSource('gw-fan', 'gw-fan-buy', '/v1/orders', 'POST', 'purchase-svc', 'token-buy')] }, '/v1/orders');
});

test("W7-COR-04 infra §4.1 '경로별 메서드 생성기' 같은 경로의 다른 메서드를 다른 라우트가 맡아도 멈추지 않고, method 맞춤이 계약에 없는 메서드면 2로 멈춘다", () => {
  const openapi = openapiOf({ '/v1/orders': { GET: {}, POST: { security: BUY, scopes: TICKET_BUY } } });
  const r = generateRoutes({ openapi, sources: { 'gw-fan': [methodSource('gw-fan', 'gw-fan-api', '/v1/orders', 'GET', 'purchase-svc', 'token'), methodSource('gw-fan', 'gw-fan-buy', '/v1/orders', 'POST', 'purchase-svc', 'token-buy')] } });
  assert.deepEqual(r.problems, [], `같은 경로의 다른 메서드인데 멈췄다: ${r.problems.join(' / ')}`);
  // 원천 맞춤이 맡는 작업이 없다(DELETE /v1/orders는 계약에 없다) → '원천 앞부분이 계약 경로를 하나도 맡지 않는다'
  assertStops(openapi, { 'gw-fan': [methodSource('gw-fan', 'gw-fan-api', '/v1/orders', 'GET', 'purchase-svc', 'token'), methodSource('gw-fan', 'gw-fan-buy', '/v1/orders', 'POST', 'purchase-svc', 'token-buy'), methodSource('gw-fan', 'gw-fan-x', '/v1/orders', 'DELETE', 'purchase-svc', 'token')] }, '/v1/orders');
});

test("W7-CON-02 infra §4.1 '경로별 시간 상한' 원천 규칙의 timeouts를 그 규칙에서 나온 생성 규칙마다 그대로 옮기고 다른 규칙에는 두지 않는다", () => {
  const openapi = openapiOf({ '/v1/orders/{orderId}/payment-status': 'GET', '/v1/orders/{orderId}': 'GET', '/v1/ops/live': 'GET' });
  const fan = exactSource(
    sourceRoute('gw-fan', 'gw-fan-api', [
      { prefixes: ['/v1/orders/{orderId}/payment-status'], backend: 'purchase-svc', timeouts: { request: '27s' } },
      { prefixes: ['/v1/orders/{orderId}'], backend: 'purchase-svc' },
    ]),
  );
  fan.spec.rules[1].matches = [{ path: { type: 'Exact', value: '/v1/orders/{orderId}' } }];
  const ops = sourceRoute('gw-ops', 'gw-ops-api', [{ prefixes: ['/v1/ops/live'], backend: 'ops-svc', app: 'console', timeouts: { request: '0s' } }]);
  const by = routesByGateway(generated(openapi, { 'gw-fan': [fan], 'gw-ops': [ops] }).files);
  const rulesFor = (gw, path) => apiRoutes(by[gw], gw).flatMap(rulesOf).filter((rule) => matchesOf(rule).some((m) => m.method === 'GET' && pathMatches(m, path)));
  const pay = rulesFor('gw-fan', '/v1/orders/o1/payment-status');
  assert.ok(pay.length > 0, 'payment-status 규칙이 없다');
  for (const rule of pay) assert.deepEqual(rule.timeouts, { request: '27s' }, 'payment-status 규칙의 시간 상한');
  const order = rulesFor('gw-fan', '/v1/orders/o1');
  assert.ok(order.length > 0, '주문 규칙이 없다');
  for (const rule of order) assert.equal(rule.timeouts, undefined, '시간 상한이 없는 원천 규칙에서 나온 규칙에 시간 상한이 있다');
  const live = rulesFor('gw-ops', '/v1/ops/live');
  assert.ok(live.length > 0, '관제 SSE 규칙이 없다');
  for (const rule of live) assert.deepEqual(rule.timeouts, { request: '0s' }, '관제 SSE 규칙의 시간 상한');
});

test("HOT-410 infra §4.1 '생성기가 멈추는 경우' /internal/로 시작하는 경로를 맡으면 2로 끝난다", () => {
  const openapi = openapiOf({ '/v1/partner/events/{eventId}': 'PATCH', '/internal/jwks/admin.json': { methods: 'GET', servers: ['https://partner-api.peaket.example'] } });
  const sources = {
    'gw-partner': [
      sourceRoute('gw-partner', 'gw-partner-api', [
        { prefixes: ['/v1/partner/events'], backend: 'core-svc', app: 'partner' },
        { prefixes: ['/internal'], backend: 'identity-svc', app: 'partner' },
      ]),
    ],
  };
  assertStops(openapi, sources, '/internal/');
});

// ===================== 나누기·TRACE·차례·머리 =====================

test("HOT-410 infra §4.1 '생성기가 멈추는 경우' 개수 상한(규칙 16·맞춤 64·라우트당 128)을 넘으면 규칙·라우트를 나누고(-2부터) 이름표 peaket.io/route를 단다", () => {
  const spec = { '/v1/partner/events/{eventId}': 'PATCH' };
  for (let i = 0; i < 150; i++) spec[`/v1/partner/bulk/p${String(i).padStart(3, '0')}`] = 'GET';
  const openapi = openapiOf(spec);
  const src = sourceRoute('gw-partner', 'gw-partner-api', [
    { prefixes: ['/v1/partner/events'], backend: 'core-svc', app: 'partner' },
    { prefixes: ['/v1/partner/bulk'], backend: 'core-svc', app: 'partner' },
  ]);
  const by = routesByGateway(generated(openapi, { 'gw-partner': [src] }).files);
  const api = apiRoutes(by['gw-partner'], 'gw-partner');
  // 150 × (GET + OPTIONS) + PATCH 경로 2 = 302 맞춤 → 라우트 하나(128)에 들지 않는다
  assert.ok(api.length >= 3, `라우트를 나누지 않았다(${api.length}개)`);
  assert.deepEqual(
    api.map((r) => r.metadata?.name),
    api.map((_, i) => (i === 0 ? 'gw-partner-api' : `gw-partner-api-${i + 1}`)),
    '나뉜 라우트 이름은 원천 이름, -2, -3 …',
  );
  for (const r of api) {
    assert.equal(r.metadata?.labels?.[ROUTE_LABEL], 'gw-partner-api', `${r.metadata?.name}: 이름표 ${ROUTE_LABEL}`);
    const rules = rulesOf(r);
    assert.ok(rules.length <= MAX_RULES, `${r.metadata?.name}: 규칙 ${rules.length}개 > ${MAX_RULES}`);
    for (const rule of rules) assert.ok(matchesOf(rule).length <= MAX_MATCHES_PER_RULE, `${r.metadata?.name}: 규칙의 맞춤 ${matchesOf(rule).length}개 > ${MAX_MATCHES_PER_RULE}`);
    const total = rules.reduce((n, rule) => n + matchesOf(rule).length, 0);
    assert.ok(total <= MAX_MATCHES_PER_ROUTE, `${r.metadata?.name}: 맞춤 합 ${total}개 > ${MAX_MATCHES_PER_ROUTE}`);
    assert.deepEqual(r.spec?.hostnames, ['partner-api.peaket.example'], `${r.metadata?.name}: 호스트`);
    assert.deepEqual(r.spec?.parentRefs, src.spec.parentRefs, `${r.metadata?.name}: 부모`);
  }
  // 나눠도 (경로, 메서드) 짝은 빠짐없이 한 번씩이다
  const pairs = allMatches(api).map(({ m }) => `${m.method} ${m.path?.type}:${m.path?.value}`);
  assert.equal(new Set(pairs).size, pairs.length, '같은 맞춤 조건이 두 번 나온다');
  assertMethodsExact(openapi, by['gw-partner'], 'gw-partner');
});

test("HOT-410 infra §4.1 '호스트와 내부 경로' 생성기는 TRACE 라우트(<게이트웨이>-trace)를 원천 앞부분으로 다시 쓰고 직접 응답 필터로 답한다", () => {
  const { openapi, sources } = smallSpec();
  const by = routesByGateway(generated(openapi, sources).files);
  for (const gw of ['gw-fan', 'gw-partner']) {
    const trace = by[gw].filter((r) => isTrace(r, gw));
    assert.equal(trace.length, 1, `${gw}: ${gw}-trace 라우트가 하나가 아니다(${trace.length})`);
    const t = trace[0];
    assert.deepEqual(t.spec?.hostnames, [API_HOST[gw]], `${gw}-trace: 호스트`);
    assert.deepEqual(t.spec?.parentRefs, [{ name: gw }], `${gw}-trace: 부모`);
    for (const rule of rulesOf(t)) {
      for (const m of matchesOf(rule)) assert.equal(m.method, 'TRACE', `${gw}-trace: TRACE 밖 맞춤 ${JSON.stringify(m)}`);
      assert.equal((rule.backendRefs ?? []).length, 0, `${gw}-trace: 백엔드로 넘긴다`);
      assert.ok((rule.filters ?? []).some((f) => f.type === 'ExtensionRef' && f.extensionRef?.kind === 'HTTPRouteFilter'), `${gw}-trace: 직접 응답 필터(HTTPRouteFilter)가 없다`);
    }
    const prefixes = sources[gw].flatMap((r) => rulesOf(r).flatMap((rule) => matchesOf(rule).map((m) => m.path.value)));
    for (const p of prefixes)
      for (const path of [p, `${p}/x`, `${p}/a1/zz9`])
        assert.ok(allowedByRoutes(trace, API_HOST[gw], path).has('TRACE'), `${gw}-trace: TRACE ${path}를 받지 않는다(원천 앞부분 ${p})`);
    // API 라우트는 TRACE를 받지 않는다
    for (const { m } of allMatches(apiRoutes(by[gw], gw))) assert.notEqual(m.method, 'TRACE');
  }
});

test("HOT-410 infra §4.1 '경로별 메서드 생성기' 원천 규칙의 필터·백엔드·호스트·부모·네임스페이스를 생성 규칙에 그대로 옮긴다", () => {
  const { openapi, sources } = smallSpec();
  const by = routesByGateway(generated(openapi, sources).files);
  for (const [gw, srcs] of Object.entries(sources)) {
    for (const src of srcs) {
      const out = by[gw].filter((r) => r.metadata?.name === src.metadata.name || r.metadata?.labels?.[ROUTE_LABEL] === src.metadata.name);
      assert.ok(out.length > 0, `${gw}: ${src.metadata.name}의 생성 라우트가 없다`);
      for (const r of out) {
        assert.equal(r.metadata?.namespace, src.metadata.namespace, `${r.metadata?.name}: 네임스페이스`);
        assert.equal(r.metadata?.labels?.[ROUTE_LABEL], src.metadata.name, `${r.metadata?.name}: 이름표 ${ROUTE_LABEL}`);
        assert.deepEqual(r.spec?.hostnames, src.spec.hostnames, `${r.metadata?.name}: 호스트`);
        assert.deepEqual(r.spec?.parentRefs, src.spec.parentRefs, `${r.metadata?.name}: 부모`);
        const srcRule = src.spec.rules[0];
        for (const rule of rulesOf(r)) {
          assert.deepEqual(rule.backendRefs, srcRule.backendRefs, `${r.metadata?.name}: 백엔드`);
          const own = (rule.filters ?? []).filter((f) => !(f.type === 'ResponseHeaderModifier' && /x-trace-id/i.test(JSON.stringify(f))));
          assert.deepEqual(own, srcRule.filters, `${r.metadata?.name}: 원천 필터가 그대로가 아니다`);
        }
      }
    }
  }
});

test("HOT-410 infra §4.1 '생성기가 멈추는 경우' 두 번 만들면 글이 같고 경로·메서드 입력 차례가 달라도 같으며 맞춤 조건은 경로 글자 차례다", () => {
  const a = smallSpec();
  const reversed = { ...a.openapi, paths: Object.fromEntries(Object.entries(a.openapi.paths).reverse().map(([p, item]) => [p, Object.fromEntries(Object.entries(item).reverse())])) };
  const first = generated(a.openapi, a.sources).files;
  const again = generated(a.openapi, a.sources).files;
  const other = generated(reversed, { 'gw-partner': [...a.sources['gw-partner']], 'gw-fan': [...a.sources['gw-fan']] }).files;
  assert.deepEqual([...first.keys()].sort(), [...again.keys()].sort());
  for (const [k, v] of first) {
    assert.equal(again.get(k), v, `${k}: 두 번 만든 글이 다르다`);
    // 맨 위 두 줄(판·해시)은 계약 파일의 글을 따를 수 있어 빼고 견준다. 라우트 글은 입력 차례와 상관없이 같다
    const body = (t) => String(t ?? '').split('\n').slice(2).join('\n');
    assert.equal(body(other.get(k)), body(v), `${k}: 입력 차례를 바꾸니 라우트 글이 다르다`);
  }
  for (const [gw, routes] of Object.entries(routesByGateway(first)))
    for (const r of apiRoutes(routes, gw))
      for (const rule of rulesOf(r)) {
        const values = matchesOf(rule).map((m) => m.path?.value ?? '');
        assert.deepEqual(values, [...values].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)), `${r.metadata?.name}: 맞춤 조건이 경로 글자 차례가 아니다`);
      }
});

test("HOT-410 infra §4.1 '경로별 메서드 생성기' 생성 파일 맨 위 두 줄은 생성 파일 표시와 openapi info.version·SHA-256(64자리 16진수)이고 계약이 바뀌면 해시가 바뀐다", () => {
  const { openapi, sources } = smallSpec();
  const files = generated(openapi, sources).files;
  assert.deepEqual([...files.keys()].sort(), [genPath('gw-fan'), genPath('gw-partner')].sort(), '생성 파일 경로');
  const heads = new Map();
  for (const [rel, text] of files) {
    const [l1, l2] = text.split('\n');
    assert.match(l1, /^#.*손으로 고치지/, `${rel}: 첫 줄은 생성 파일 표시다: ${l1}`);
    assert.match(l2, /^#/, `${rel}: 둘째 줄은 주석이다: ${l2}`);
    assert.ok(l2.includes('9.8.10-test'), `${rel}: 둘째 줄에 info.version이 없다: ${l2}`);
    const h = /\b[0-9a-f]{64}\b/.exec(l2);
    assert.ok(h, `${rel}: 둘째 줄에 SHA-256이 없다: ${l2}`);
    heads.set(rel, h[0]);
  }
  const changed = generated({ ...openapi, info: { ...openapi.info, description: '설명만 바꾼 계약' } }, sources).files;
  for (const [rel, text] of changed) assert.ok(!text.split('\n')[1].includes(heads.get(rel)), `${rel}: 계약이 바뀌었는데 해시가 같다`);
});

// ===================== 추적 머리(D-T43 ③) =====================

test('D-T43 ③ x-peaket-cdn-cache 작업의 규칙에는 X-Trace-Id 붙이기가 없고 나머지 규칙에는 X-Trace-Id: %TRACE_ID%가 있다', () => {
  const openapi = openapiOf({
    '/v1/home': { GET: { cdn: true } },
    '/v1/search': { GET: { cdn: true } },
    '/v1/events/{eventId}': { GET: { cdn: true }, PATCH: {} },
    '/v1/identity/me': 'GET',
  });
  const sources = { 'gw-fan': [sourceRoute('gw-fan', 'gw-fan-api', [{ prefixes: ['/v1/home', '/v1/search', '/v1/events', '/v1/identity'], backend: 'core-svc' }])] };
  const routes = apiRoutes(routesByGateway(generated(openapi, sources).files)['gw-fan'], 'gw-fan');
  const cdn = new Set(['GET /v1/home', 'GET /v1/search', 'GET /v1/events/a1']);
  let cdnRules = 0;
  let otherRules = 0;
  for (const r of routes) {
    for (const rule of rulesOf(r)) {
      const kinds = new Set(
        matchesOf(rule)
          .filter((m) => m.method !== 'OPTIONS')
          .map((m) => {
            const sample = m.path.type === 'Exact' ? m.path.value : ['/v1/events/a1'].find((p) => pathMatches(m, p)) ?? m.path.value;
            return cdn.has(`${m.method} ${sample}`) ? 'cdn' : 'other';
          }),
      );
      assert.ok(kinds.size <= 1, `${r.metadata?.name}: CDN 캐시 작업과 다른 작업이 한 규칙에 섞였다 ${JSON.stringify(matchesOf(rule))}`);
      if (kinds.has('cdn')) {
        cdnRules++;
        assert.ok(!mentionsTraceId(rule), `${r.metadata?.name}: CDN 캐시 작업 규칙에 X-Trace-Id 붙이기가 있다`);
      } else if (kinds.has('other')) {
        otherRules++;
        const hs = traceIdHeaders(rule);
        assert.equal(hs.length, 1, `${r.metadata?.name}: X-Trace-Id 붙이기가 하나가 아니다 ${JSON.stringify(rule.filters)}`);
        assert.equal(hs[0].value, '%TRACE_ID%', `${r.metadata?.name}: X-Trace-Id 값`);
      }
    }
  }
  assert.ok(cdnRules > 0, 'CDN 캐시 작업 규칙이 없다');
  assert.ok(otherRules > 0, '나머지 작업 규칙이 없다');
  // 같은 경로의 PATCH(캐시 안 함)는 X-Trace-Id가 붙는 규칙에 있다
  const patchRule = routes.flatMap(rulesOf).find((rule) => matchesOf(rule).some((m) => m.method === 'PATCH' && pathMatches(m, '/v1/events/a1')));
  assert.ok(patchRule && traceIdHeaders(patchRule).length === 1, 'PATCH /v1/events/{eventId} 규칙에 X-Trace-Id가 없다');
});

// ===================== 생성 대조(D-T42 ①②, CLI) =====================

/** 임시 저장소에 쓰고 바로 대조하면 0이다(대조 사례의 바탕) */
function writtenFixture() {
  const { openapi, sources } = smallSpec();
  const root = fixture(openapi, sources);
  const w = cli(root, '--write');
  assert.equal(w.status, 0, `--write: ${w.out}`);
  for (const gw of ['gw-fan', 'gw-partner']) assert.ok(existsSync(join(root, genPath(gw))), `${genPath(gw)}를 쓰지 않았다`);
  const c = cli(root, '--check');
  assert.equal(c.status, 0, `쓴 바로 뒤의 --check: ${c.out}`);
  return { root, openapi, sources };
}

test('D-T42 ① 생성 파일에 메서드 하나를 손으로 더하면 --check가 1로 끝나고 그 파일 이름을 보인다', () => {
  const { root } = writtenFixture();
  const file = join(root, genPath('gw-partner'));
  const before = readFileSync(file, 'utf8');
  // 다시 쓰면 같은 바이트다
  assert.equal(cli(root, '--write').status, 0);
  assert.equal(readFileSync(file, 'utf8'), before, '두 번 쓴 생성 파일이 다르다');
  // 맨 위 주석(판·해시)은 그대로 두고 규칙 하나에 PUT 맞춤을 더한다
  const docs = parseAllDocuments(before);
  const idx = docs.findIndex((d) => {
    const o = d.toJS();
    return o?.kind === 'HTTPRoute' && o.metadata?.name !== 'gw-partner-trace' && (o.spec?.rules ?? []).length > 0;
  });
  assert.ok(idx >= 0, '손볼 API 라우트가 없다');
  const first = docs[idx].toJS().spec.rules[0].matches[0];
  docs[idx].addIn(['spec', 'rules', 0, 'matches'], { path: first.path, method: 'PUT' });
  const edited = docs.map((d) => d.toString()).join('');
  assert.ok(edited.startsWith(before.split('\n')[0]), '손본 파일의 첫 줄이 바뀌었다(시험 준비 잘못)');
  writeFileSync(file, edited);
  const c = cli(root, '--check');
  assert.equal(c.status, 1, `손으로 고친 생성 파일을 --check가 놓쳤다(${c.status}): ${c.out}`);
  assert.ok(c.out.includes('gw-partner.routes.yaml'), `바뀐 파일 이름을 보이지 않는다: ${c.out}`);
  assert.ok(!c.out.includes('gw-fan.routes.yaml'), `바뀌지 않은 파일 이름까지 보인다: ${c.out}`);
  // 생성 파일을 지워도 1이다
  rmSync(join(root, genPath('gw-fan')));
  writeFileSync(file, before);
  const gone = cli(root, '--check');
  assert.equal(gone.status, 1, `지운 생성 파일을 놓쳤다: ${gone.out}`);
  assert.ok(gone.out.includes('gw-fan.routes.yaml'), `지운 파일 이름을 보이지 않는다: ${gone.out}`);
});

test('D-T42 ② openapi에 경로 하나를 더하고 다시 만들지 않으면 --check가 1로 끝난다', () => {
  const { root, openapi } = writtenFixture();
  const next = { ...openapi, paths: { ...openapi.paths, '/v1/partner/events/{eventId}/notes': { post: op() } } };
  writeFileSync(join(root, 'docs', 'api', 'openapi.yaml'), stringify(next));
  const c = cli(root, '--check');
  assert.equal(c.status, 1, `계약에 경로를 더했는데 --check가 ${c.status}: ${c.out}`);
  assert.ok(c.out.includes('gw-partner.routes.yaml'), `바뀐 파일 이름을 보이지 않는다: ${c.out}`);
});

test('D-T42 ② openapi info.version만 올리고 다시 만들지 않으면 --check가 1로 끝나고, 다시 만들면 맨 위 판·해시 줄만 바뀐다', () => {
  const { root, openapi } = writtenFixture();
  const files = ['gw-fan', 'gw-partner'].map((gw) => join(root, genPath(gw)));
  const before = files.map((f) => readFileSync(f, 'utf8'));
  writeFileSync(join(root, 'docs', 'api', 'openapi.yaml'), stringify({ ...openapi, info: { ...openapi.info, version: '9.8.11-test' } }));
  const c = cli(root, '--check');
  assert.equal(c.status, 1, `info.version만 올렸는데 --check가 ${c.status}: ${c.out}`);
  assert.equal(cli(root, '--write').status, 0);
  files.forEach((f, i) => {
    const a = before[i].split('\n');
    const b = readFileSync(f, 'utf8').split('\n');
    assert.equal(b.length, a.length, `${f}: 줄 수가 바뀌었다`);
    const diff = a.map((l, j) => (l === b[j] ? -1 : j)).filter((j) => j >= 0);
    assert.deepEqual(diff, [1], `${f}: 판만 올렸는데 둘째 줄 밖이 바뀌었다(${diff})`);
    assert.ok(b[1].includes('9.8.11-test'), `${f}: 새 판이 없다`);
  });
});

// ===================== 저장소 상태 =====================

const ROUTES_DIR = join(REPO, 'deploy', 'gateways', 'routes');
const repoOpenapi = () => parse(readFileSync(join(REPO, 'docs', 'api', 'openapi.yaml'), 'utf8'));
/** 저장소의 라우트 원천(게이트웨이 다섯) */
function repoSources() {
  assert.ok(existsSync(ROUTES_DIR), `라우트 원천 폴더가 없다: ${ROUTES_DIR}`);
  const out = {};
  for (const f of readdirSync(ROUTES_DIR).filter((n) => /\.ya?ml$/.test(n)).sort()) out[f.replace(/\.ya?ml$/, '')] = routesIn(readFileSync(join(ROUTES_DIR, f), 'utf8'));
  assert.deepEqual(Object.keys(out).sort(), [...GATEWAYS].sort(), '라우트 원천은 게이트웨이 다섯의 파일이다');
  return out;
}
/** 저장소의 생성 파일(게이트웨이 다섯) */
function repoGenerated() {
  const out = new Map();
  for (const gw of GATEWAYS) {
    const f = join(REPO, genPath(gw));
    assert.ok(existsSync(f), `생성 파일이 없다: ${genPath(gw)}`);
    out.set(genPath(gw), readFileSync(f, 'utf8'));
  }
  return out;
}

test('D-T42 ①② 저장소의 생성 파일이 지금 openapi와 원천으로 다시 만든 것과 같다(--check 0, 모듈 결과와 파일이 한 글자도 같다)', () => {
  const disk = repoGenerated();
  const sources = repoSources();
  const r = generateRoutes({ openapi: repoOpenapi(), sources });
  assert.deepEqual(r.problems, [], `저장소 입력으로 생성기가 멈춘다: ${r.problems.join(' / ')}`);
  assert.deepEqual([...r.files.keys()].sort(), [...disk.keys()].sort(), '생성 파일 목록');
  for (const [rel, text] of r.files) assert.equal(disk.get(rel), text, `${rel}: 저장소 파일이 생성 결과와 다르다(다시 만들지 않았거나 손으로 고쳤다)`);
  const c = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8', cwd: REPO });
  assert.equal(c.status, 0, `저장소에서 --check: ${c.stdout}${c.stderr}`);
});

test('[ASVS v5.0.0-3.5.3] 저장소의 생성 라우트에서 계약에 없는 경로·메서드 짝이 하나도 없고 계약 짝은 모두 있다(다섯 게이트웨이 각각)', () => {
  const disk = repoGenerated();
  const openapi = repoOpenapi();
  const by = routesByGateway(disk);
  for (const gw of GATEWAYS) {
    const ms = allMatches(apiRoutes(by[gw], gw));
    assert.ok(ms.length > 0, `${gw}: 생성한 맞춤 조건이 없다`);
    for (const { route, m } of ms) {
      assert.ok(typeof m.method === 'string' && m.method !== '', `${gw}/${route.metadata?.name}: 메서드 없는 맞춤 ${JSON.stringify(m)}`);
      assert.ok(['Exact', 'RegularExpression'].includes(m.path?.type), `${gw}/${route.metadata?.name}: 경로 꼴 ${JSON.stringify(m.path)}`);
      assert.ok(!lc(m.path?.value ?? '').startsWith('/internal'), `${gw}/${route.metadata?.name}: /internal/ 경로`);
    }
    assertMethodsExact(openapi, by[gw], gw, '저장소 ');
  }
});

test('D-T42 ③ 저장소의 생성 라우트(다섯 게이트웨이 각각)에 계약 경로마다 OPTIONS 조건이 있다', () => {
  const by = routesByGateway(repoGenerated());
  const openapi = repoOpenapi();
  for (const gw of GATEWAYS) {
    const host = API_HOST[gw];
    const paths = Object.keys(openapi.paths).filter((p) => hostOf(openapi, p) === host);
    assert.ok(paths.length > 0, `${gw}: 계약 경로가 없다`);
    for (const p of paths) {
      const got = allowedByRoutes(apiRoutes(by[gw], gw), host, p.replace(/\{[^}]+\}/g, 'a1'));
      assert.ok(got.has('OPTIONS'), `${gw} ${p}: OPTIONS 조건이 없다(${fmt(got)})`);
    }
  }
});

/** guidelines §9가 든 CDN 캐시 공개 읽기(이 다섯은 반드시 표시가 있다. 다른 작업을 더 표시해도 된다) */
const CDN_OPS = [
  ['GET', '/v1/home'],
  ['GET', '/v1/search'],
  ['GET', '/v1/search/suggestions'],
  ['GET', '/v1/events/{eventId}/review-summary'],
  ['GET', '/v1/events/{eventId}'],
];

test('D-T43 ③ 저장소: openapi의 CDN 캐시 공개 읽기(홈·검색·자동완성·후기 요약·회차 공개 요약)에 x-peaket-cdn-cache가 있고, 그 규칙에는 X-Trace-Id가 없고 나머지 규칙에는 있다', () => {
  const openapi = repoOpenapi();
  for (const [m, p] of CDN_OPS) assert.equal(openapi.paths[p]?.[lc(m)]?.['x-peaket-cdn-cache'], true, `${m} ${p}에 x-peaket-cdn-cache: true가 없다`);
  // 개인 응답은 표시하지 않는다
  for (const [m, p] of [['GET', '/v1/identity/me'], ['GET', '/v1/tickets']]) assert.notEqual(openapi.paths[p]?.[lc(m)]?.['x-peaket-cdn-cache'], true, `${m} ${p}(개인 응답)에 x-peaket-cdn-cache가 있다`);
  const cdnOps = [];
  for (const [p, item] of Object.entries(openapi.paths)) for (const m of opMethods(item)) if (item[lc(m)]['x-peaket-cdn-cache'] === true) cdnOps.push([m, p]);
  const by = routesByGateway(repoGenerated());
  let other = 0;
  for (const gw of GATEWAYS) {
    for (const r of apiRoutes(by[gw], gw)) {
      for (const rule of rulesOf(r)) {
        const ms = matchesOf(rule).filter((m) => m.method !== 'OPTIONS');
        if (!ms.length) continue;
        // 맞춤 조건이 CDN 캐시 작업의 경로(틀을 채운 것)와 메서드에 맞으면 그 작업의 조건이다
        const isCdn = (m) => cdnOps.some(([cm, cp]) => cm === m.method && hostOf(openapi, cp) === API_HOST[gw] && pathMatches(m, cp.replace(/\{[^}]+\}/g, 'a1')));
        const kinds = new Set(ms.map((m) => (isCdn(m) ? 'cdn' : 'other')));
        assert.ok(kinds.size === 1, `${gw}/${r.metadata?.name}: CDN 캐시 작업과 다른 작업이 한 규칙에 섞였다`);
        if (kinds.has('cdn')) assert.ok(!mentionsTraceId(rule), `${gw}/${r.metadata?.name}: CDN 캐시 작업 규칙에 X-Trace-Id가 있다`);
        else {
          other++;
          const hs = traceIdHeaders(rule);
          assert.equal(hs.length, 1, `${gw}/${r.metadata?.name}: X-Trace-Id 붙이기가 하나가 아니다`);
          assert.equal(hs[0].value, '%TRACE_ID%', `${gw}/${r.metadata?.name}: X-Trace-Id 값`);
        }
      }
    }
  }
  assert.ok(other > 0, 'X-Trace-Id를 붙이는 규칙이 하나도 없다');
});
