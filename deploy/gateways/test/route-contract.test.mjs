// 생성 라우트와 계약·처리기의 대조 정적 시험(BUILD_ORDER HOT-410, 묶음 BAT-060 계획 15절 'BAT-055가 넘긴 것', 웨이브 끝 리뷰 지적의 재현 시험).
// 정본: docs/infra.md §4.1 '경로별 메서드·한도·게이트웨이 오류'의 '인증 종류 대조'·'백엔드 대조'·'경로별 시간 상한'·'게이트웨이 오류의 Problem',
// docs/security/authz-matrix.md §5.1, docs/frontend.md §4.4 'SSE 경로의 게이트웨이 설정'.
// 읽는 것: deploy/gateways/*.yaml(손으로 쓴 정의와 생성 파일), docs/api/openapi.yaml, services/*/src의 처리기(NestJS 데코레이터).
// 처리기 읽는 법(시험이 정함, 바꾸려면 계획 파일 '시험 이의'): 서비스 폴더 services/<서비스>/src 아래 .ts(시험 파일 뺌)에서 `@Controller('<앞머리>')`를
//   만나면 그 앞머리를, 뒤따르는 `@Get|@Post|@Put|@Patch|@Delete('<뒷머리>')`마다 '/앞머리/뒷머리'를 처리기 경로로 본다(`:이름`은 openapi 틀 `{이름}`).
//   전역 앞머리(setGlobalPrefix·RouterModule)는 2026-11-16 저장소에 없다. 글자가 아닌 인자(상수)는 읽지 못한 것으로 보이고 실패한다.
//   합본(bundle)·v0-monolith·pg-simulator·invariant-checker는 게이트웨이 뒤 서비스가 아니라 뺀다.
// 실행(저장소 뿌리): node --test "deploy/gateways/test/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(HERE, '..');
const REPO = resolve(DIR, '..', '..');

// ---- 정본 값 ----
const GATEWAYS = ['gw-queue', 'gw-fan', 'gw-partner', 'gw-ops', 'gw-scanner'];
const API_HOST = { 'gw-queue': 'queue.peaket.example', 'gw-fan': 'api.peaket.example', 'gw-partner': 'partner-api.peaket.example', 'gw-ops': 'ops-api.peaket.example', 'gw-scanner': 'scanner-api.peaket.example' };
const GATEWAY_OF_HOST = Object.fromEntries(Object.entries(API_HOST).map(([g, h]) => [h, g]));
/** 게이트웨이가 확인하는 액세스 토큰 방식(infra §4.1 '인증 종류 대조') */
const ACCESS = ['fanCookie', 'partnerCookie', 'opsCookie', 'staffToken'];
const AUTH_LABEL = 'peaket.io/auth';
const ROUTE_LABEL = 'peaket.io/route';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const SERVICES = ['core-svc', 'identity-svc', 'ops-svc', 'payment-svc', 'purchase-svc', 'queue-svc', 'ticket-svc', 'trust-svc'];
/**
 * 처리기가 두 서비스에 있어도 정본이 받는 쪽을 정한 작업(infra §4.1 '백엔드 대조'). 키는 '메서드 계약 경로'
 * `/v1/ops/scanner-devices*`: ops-svc가 권한·감사 기록 뒤 ticket-svc gRPC를 부른다(ADR-0148 결정 1). ticket-svc 옛 처리기를 지우면 이 줄도 지운다
 */
const BACKEND_EXCEPTIONS = new Map([
  ['GET /v1/ops/scanner-devices', 'ops-svc'],
  ['POST /v1/ops/scanner-devices', 'ops-svc'],
  ['POST /v1/ops/scanner-devices/{deviceId}/revocation', 'ops-svc'],
  ['POST /v1/ops/scanner-devices/{deviceId}/enrollment-code', 'ops-svc'],
]);
const TITLES = { 403: 'Forbidden', 405: 'Method Not Allowed' };

// ---- 읽기 ----
function loadObjects() {
  const out = [];
  for (const f of readdirSync(DIR).filter((n) => /\.ya?ml$/.test(n)).sort())
    for (const d of parseAllDocuments(readFileSync(join(DIR, f), 'utf8'))) {
      if (d.errors.length) throw new Error(`${f}: ${d.errors[0].message}`);
      const o = d.toJS();
      if (o && typeof o === 'object') out.push(o);
    }
  return out;
}
const OBJECTS = loadObjects();
const OPENAPI = parse(readFileSync(join(REPO, 'docs', 'api', 'openapi.yaml'), 'utf8'));

const lc = (s) => String(s).toLowerCase();
const byKind = (kind) => OBJECTS.filter((o) => o.kind === kind);
const named = (kind, name) => byKind(kind).find((o) => o.metadata?.name === name);
const routesOf = (gw) => byKind('HTTPRoute').filter((r) => (r.spec?.parentRefs ?? []).some((p) => p.name === gw));
const sourceName = (r) => r.metadata?.labels?.[ROUTE_LABEL] ?? r.metadata?.name;
function findKey(obj, key, out = []) {
  if (Array.isArray(obj)) for (const v of obj) findKey(v, key, out);
  else if (obj && typeof obj === 'object')
    for (const [k, v] of Object.entries(obj)) {
      if (lc(k) === lc(key)) out.push(v);
      findKey(v, key, out);
    }
  return out;
}
function targets(p, obj) {
  const refs = [...(p.spec?.targetRefs ?? []), ...(p.spec?.targetRef ? [p.spec.targetRef] : [])];
  if (refs.some((t) => t.kind === obj.kind && t.name === obj.metadata?.name)) return true;
  const labels = obj.metadata?.labels ?? {};
  return (p.spec?.targetSelectors ?? []).some((s) => s.kind === obj.kind && Object.keys(s.matchLabels ?? {}).length > 0 && Object.entries(s.matchLabels).every(([k, v]) => labels[k] === v));
}
const gatewayPolicies = (kind, gw) => byKind(kind).filter((p) => targets(p, { kind: 'Gateway', metadata: { name: gw } }));
function effective(kind, route) {
  const own = byKind(kind).filter((p) => targets(p, route));
  const parents = (route.spec?.parentRefs ?? []).flatMap((x) => gatewayPolicies(kind, x.name));
  if (!own.length) return parents;
  if (own.some((p) => p.spec?.mergeType)) return [...own, ...parents];
  return own;
}
function pathScore(match, method, path) {
  if (match.method && match.method !== method) return -1;
  const p = match.path ?? { type: 'PathPrefix', value: '/' };
  const v = p.value ?? '/';
  if (p.type === 'Exact') return v === path ? 100000 : -1;
  if (p.type === 'RegularExpression') return new RegExp(`^(?:${v})$`).test(path) ? 1000 + v.length : -1;
  const pre = v.endsWith('/') ? v : `${v}/`;
  return path === v || path.startsWith(pre) || v === '/' ? 10 + v.length : -1;
}
/** (호스트, 메서드, 경로)를 받는 라우트 규칙(Exact > 정규식 > 긴 PathPrefix) */
function routeFor(host, method, path) {
  let best = null;
  for (const route of byKind('HTTPRoute')) {
    if (!(route.spec?.hostnames ?? []).includes(host)) continue;
    for (const rule of route.spec?.rules ?? [])
      for (const m of rule.matches ?? [{}]) {
        const s = pathScore(m, method, path);
        if (s >= 0 && (!best || s > best.score)) best = { route, rule, match: m, score: s };
      }
  }
  return best;
}
const fill = (p) => p.replace(/\{[^}]+\}/g, 'a1');
const hostOf = (p) => {
  const url = OPENAPI.paths[p].servers?.[0]?.url ?? (OPENAPI['x-peaket-gateways']?.rules ?? []).find((r) => p.startsWith(r.prefix))?.server;
  return url ? new URL(url).host : undefined;
};
/** 계약 작업 목록: { method, path, host, gw, op, key } */
const OPS = Object.entries(OPENAPI.paths).flatMap(([path, item]) =>
  METHODS.filter((m) => item[m]).map((m) => ({ method: m.toUpperCase(), path, host: hostOf(path), gw: GATEWAY_OF_HOST[hostOf(path)], op: item[m], key: `${m.toUpperCase()} ${path}` })),
);
const apiOps = () => OPS.filter((o) => o.gw);
const opByKey = (key) => {
  const o = OPS.find((x) => x.key === key);
  assert.ok(o, `openapi에 ${key}가 없다`);
  return o;
};

/** 게이트웨이가 요구하는 스코프에 ticket:buy가 있는가(openapi 확장 x-peaket-scopes, infra §4.1 '인증 종류 대조' ①) */
const wantsBuy = (op) => (op['x-peaket-scopes'] ?? []).includes('ticket:buy');
/** 모든 갈래에 입장 토큰이 있는 구매 경로인가(이 작업은 x-peaket-scopes가 꼭 있어야 한다) */
const isPurchase = (op) => {
  const sec = op.security ?? OPENAPI.security ?? [];
  return sec.length > 0 && sec.every((alt) => 'admissionToken' in alt);
};
/** security와 x-peaket-scopes로 정한 인증 종류(infra §4.1 '인증 종류 대조') */
function authKind(op) {
  const sec = op.security ?? OPENAPI.security ?? [];
  if (!sec.length) return 'public';
  const has = sec.map((alt) => ACCESS.some((a) => a in alt));
  if (has.every(Boolean)) return wantsBuy(op) ? 'token-buy' : 'token';
  if (!has.some(Boolean)) return 'public';
  return 'optional';
}
const expectedKind = (o) => authKind(o.op);

/** 작업을 받는 백엔드 규칙(백엔드가 없는 not-found·trace는 '받는 라우트 없음'으로 본다) */
function opRoute(o) {
  const hit = routeFor(o.host, o.method, fill(o.path));
  if (!hit || !(hit.rule.backendRefs ?? []).length) return null;
  return hit;
}
const jwtOf = (route) => effective('SecurityPolicy', route).map((p) => p.spec?.jwt).filter(Boolean);
const authzOf = (route) => effective('SecurityPolicy', route).map((p) => p.spec?.authorization).filter(Boolean);
const requiresBuy = (route) => authzOf(route).some((a) => (a.rules ?? []).filter((r) => r.action === 'Allow').some((r) => findKey(r.principal ?? {}, 'scopes').flat().includes('ticket:buy')));
/** 라우트 정책이 인증 종류와 맞는가: 문제 글(맞으면 null) */
function policyProblem(route, kind) {
  const jwts = jwtOf(route);
  const authz = authzOf(route);
  const name = route.metadata?.name;
  if (kind === 'public') return jwts.length ? `${name}: public인데 jwt가 있다` : null;
  if (kind === 'optional') {
    if (!jwts.length || !jwts.every((j) => j.optional === true)) return `${name}: optional인데 jwt.optional이 참이 아니다`;
    if (authz.some((a) => a.defaultAction === 'Deny')) return `${name}: optional인데 인가가 Deny 기본이다(토큰 없는 요청이 막힌다)`;
    return null;
  }
  if (!jwts.length || jwts.some((j) => j.optional === true)) return `${name}: ${kind}인데 필수 jwt가 없다`;
  if (!authz.length || !authz.every((a) => a.defaultAction === 'Deny')) return `${name}: ${kind}인데 Deny 기본 인가가 없다`;
  if (kind === 'token-buy' && !requiresBuy(route)) return `${name}: token-buy인데 ticket:buy를 요구하지 않는다`;
  if (kind === 'token' && requiresBuy(route)) return `${name}: token인데 ticket:buy를 요구한다`;
  return null;
}

// ---- 처리기 ----
function* walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.ts$/.test(e) && !/\.(test|spec)\.ts$/.test(e)) yield p;
  }
}
const strArg = (s) => {
  const m = /^\s*(?:'([^']*)'|"([^"]*)"|`([^`$]*)`)?\s*$/.exec(s);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
};
/** 처리기 목록과 읽지 못한 데코레이터 */
function readHandlers() {
  const out = [];
  const unread = [];
  for (const svc of SERVICES) {
    const src = join(REPO, 'services', svc, 'src');
    if (!existsSync(src)) continue;
    for (const f of walk(src)) {
      const t = readFileSync(f, 'utf8');
      const re = /@Controller\(([^)]*)\)|@(Get|Post|Put|Patch|Delete)\(([^)]*)\)/g;
      let prefix = null;
      let m;
      while ((m = re.exec(t))) {
        if (m[1] !== undefined) {
          prefix = strArg(m[1]);
          if (prefix === null) unread.push(`${f}: @Controller(${m[1]})`);
          continue;
        }
        if (prefix === null) continue;
        const sub = strArg(m[3]);
        if (sub === null) {
          unread.push(`${f}: @${m[2]}(${m[3]})`);
          continue;
        }
        const path = `/${[prefix, sub].filter(Boolean).join('/')}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1').replace(/:([A-Za-z0-9_]+)/g, '{$1}');
        out.push({ svc, method: m[2].toUpperCase(), path });
      }
    }
  }
  return { handlers: out, unread };
}
const norm = (p) => p.replace(/\{[^}]+\}/g, '{}');
const HANDLERS = readHandlers();
/** '메서드 경로(틀은 {})' → 처리기가 있는 서비스들 */
const HANDLER_SERVICES = (() => {
  const m = new Map();
  for (const h of HANDLERS.handlers) {
    const k = `${h.method} ${norm(h.path)}`;
    if (!m.has(k)) m.set(k, new Set());
    m.get(k).add(h.svc);
  }
  return m;
})();

/** 백엔드 대조 판정: 문제 목록과 처리기 없는 작업 목록 */
function backendProblems(exceptions) {
  const problems = [];
  const noHandler = [];
  for (const o of apiOps()) {
    const svcs = HANDLER_SERVICES.get(`${o.method} ${norm(o.path)}`);
    if (!svcs) {
      noHandler.push(o.key);
      continue;
    }
    const hit = opRoute(o);
    if (!hit) {
      problems.push(`${o.key}: 받는 라우트가 없다`);
      continue;
    }
    const backends = (hit.rule.backendRefs ?? []).map((b) => b.name);
    let want;
    if (svcs.size > 1) {
      want = exceptions.get(o.key);
      if (!want) {
        problems.push(`${o.key}: 처리기가 두 서비스(${[...svcs].join('·')})에 있는데 예외 표에 없다`);
        continue;
      }
    } else want = exceptions.get(o.key) ?? [...svcs][0];
    if (backends.length !== 1 || backends[0] !== want) problems.push(`${o.key}: 백엔드 ${backends.join(',')} ≠ 처리기 ${want}(${hit.route.metadata?.name})`);
  }
  return { problems, noHandler };
}

// ===================== W7-WIR-01 · W7-WIR-02 · W7-WIR-03 백엔드 대조 =====================

test('W7-WIR-01 POST /v1/scanner/token(security: deviceDpop|deviceMtls)은 jwt 없는 라우트에 맞고 백엔드가 identity-svc다', () => {
  const o = opByKey('POST /v1/scanner/token');
  assert.equal(authKind(o.op), 'public', `security ${JSON.stringify(o.op.security)}`);
  const hit = opRoute(o);
  assert.ok(hit, 'POST /v1/scanner/token을 받는 라우트가 없다');
  assert.deepEqual(jwtOf(hit.route), [], `${hit.route.metadata?.name}: 토큰 확인(jwt)이 걸려 기기 DPoP 요청이 401이 된다`);
  assert.deepEqual((hit.rule.backendRefs ?? []).map((b) => b.name), ['identity-svc'], `${hit.route.metadata?.name}: 백엔드`);
});

test('W7-WIR-02 /v1/ops/scanner-devices* 작업의 생성 라우트 백엔드는 ops-svc다(작업 넷 각각)', () => {
  const ops = apiOps().filter((o) => o.path.startsWith('/v1/ops/scanner-devices'));
  assert.equal(ops.length, 4, `scanner-devices 작업 수: ${ops.map((o) => o.key)}`);
  for (const o of ops) {
    const hit = opRoute(o);
    assert.ok(hit, `${o.key}를 받는 라우트가 없다`);
    assert.deepEqual((hit.rule.backendRefs ?? []).map((b) => b.name), ['ops-svc'], `${o.key}(${hit.route.metadata?.name}): 백엔드`);
  }
});

test('F-03-1 T17 FE-T28 관제 SSE 흐름 둘(getOpsLive·getOpsEventLive)과 위젯 조회(getOpsWidget)의 생성 라우트 백엔드는 ops-svc이고 흐름 둘은 timeouts.request 0s다(ADR-0100 결정 2 게이트웨이)', () => {
  const byId = (id) => OPS.find((o) => o.op.operationId === id);
  for (const [id, timeout] of [
    ['getOpsLive', '0s'],
    ['getOpsEventLive', '0s'],
    ['getOpsWidget', undefined],
  ]) {
    const o = byId(id);
    assert.ok(o, `openapi에 ${id}가 없다`);
    const hit = opRoute(o);
    assert.ok(hit, `${o.key}를 받는 라우트가 없다`);
    assert.deepEqual((hit.rule.backendRefs ?? []).map((b) => `${b.namespace}/${b.name}:${b.port}`), ['core/ops-svc:8080'], `${o.key}(${hit.route.metadata?.name}): 백엔드`);
    assert.equal(hit.rule.timeouts?.request, timeout, `${o.key}: timeouts.request`);
  }
});

test('W7-WIR-03 GET /v1/tickets/{ticketId}/cancellation-quote·POST …/cancellation의 백엔드는 purchase-svc다', () => {
  for (const key of ['GET /v1/tickets/{ticketId}/cancellation-quote', 'POST /v1/tickets/{ticketId}/cancellation']) {
    const hit = opRoute(opByKey(key));
    assert.ok(hit, `${key}를 받는 라우트가 없다`);
    assert.deepEqual((hit.rule.backendRefs ?? []).map((b) => b.name), ['purchase-svc'], `${key}(${hit.route.metadata?.name}): 백엔드`);
  }
});

test("W7-WIR-01 W7-WIR-02 W7-WIR-03 infra §4.1 '백엔드 대조' 처리기가 있는 작업마다 생성 라우트의 백엔드가 그 처리기의 서비스다(두 서비스면 예외 표대로)", (t) => {
  assert.deepEqual(HANDLERS.unread, [], '읽지 못한 처리기 데코레이터가 있다(글자 인자만 읽는다)');
  assert.ok(HANDLERS.handlers.length > 100, `처리기를 거의 못 읽었다(${HANDLERS.handlers.length})`);
  const { problems, noHandler } = backendProblems(BACKEND_EXCEPTIONS);
  t.diagnostic(`처리기가 아직 없는 작업 ${noHandler.length}개(라우트 원천의 백엔드를 둔다): ${noHandler.slice(0, 20).join(', ')}${noHandler.length > 20 ? ' …' : ''}`);
  assert.ok(apiOps().length - noHandler.length > 50, '처리기와 견준 작업이 거의 없다');
  assert.deepEqual(problems, [], '백엔드가 처리기의 서비스와 다르다');
});

test('W7-WIR-02 처리기가 두 서비스에 있는 작업은 예외 표에 없으면 백엔드 대조가 실패한다(예외 표에서 그 줄을 뺀 사본으로)', () => {
  for (const key of BACKEND_EXCEPTIONS.keys()) {
    assert.ok((HANDLER_SERVICES.get(`${key.split(' ')[0]} ${norm(key.split(' ')[1])}`)?.size ?? 0) > 1, `${key}: 예외 표에 있는데 처리기가 두 서비스에 있지 않다(그 줄을 지운다)`);
  }
  const without = new Map([...BACKEND_EXCEPTIONS].filter(([k]) => !k.includes('/scanner-devices')));
  const { problems } = backendProblems(without);
  for (const key of BACKEND_EXCEPTIONS.keys()) {
    assert.ok(problems.some((p) => p.startsWith(`${key}:`) && p.includes('예외 표에 없다')), `${key}: 예외 줄을 빼도 대조가 실패하지 않는다 ${JSON.stringify(problems)}`);
  }
});

test('BAT-045 GET /v1/ops/auth/sessions/me의 백엔드는 ops-svc이고 DELETE는 identity-svc다(라우트 원천 표류 0)', () => {
  const get = opByKey('GET /v1/ops/auth/sessions/me');
  assert.match(String(get.op.description ?? ''), /ops-svc/, 'openapi 설명이 백엔드를 ops-svc로 정하지 않는다');
  const getHit = opRoute(get);
  assert.ok(getHit, 'GET /v1/ops/auth/sessions/me를 받는 라우트가 없다');
  assert.deepEqual((getHit.rule.backendRefs ?? []).map((b) => b.name), ['ops-svc'], 'GET의 라우트 백엔드가 ops-svc가 아니다');
  const del = opByKey('DELETE /v1/ops/auth/sessions/me');
  assert.match(String(del.op.description ?? ''), /identity-svc/, 'openapi 설명이 로그아웃을 identity-svc로 정하지 않는다');
  const delHit = opRoute(del);
  assert.ok(delHit, 'DELETE /v1/ops/auth/sessions/me를 받는 라우트가 없다');
  assert.deepEqual((delHit.rule.backendRefs ?? []).map((b) => b.name), ['identity-svc'], 'DELETE의 라우트 백엔드가 identity-svc가 아니다');
});

test('BAT-045 BAT-425 배상·취소 계좌 경로의 생성 라우트 백엔드는 처리기가 있는 purchase-svc다(표류 0)', () => {
  for (const key of [
    'GET /v1/compensations',
    'GET /v1/compensations/{compensationId}',
    'POST /v1/compensations/{compensationId}/account',
    'POST /v1/cancellations/{cancellationId}/account',
  ]) {
    const hit = opRoute(opByKey(key));
    assert.ok(hit, `${key}를 받는 라우트가 없다`);
    assert.deepEqual((hit.rule.backendRefs ?? []).map((b) => b.name), ['purchase-svc'], `${key}(${hit.route.metadata?.name}): 백엔드`);
  }
});

// ===================== 인증 종류 대조(W7-WIR-01 · W7-WIR-05 · W7-COR-04 · RV-04) =====================

test("W7-WIR-05 W7-WIR-01 RV-04 infra §4.1 '인증 종류 대조' 다섯 호스트의 작업마다 security가 비면 jwt 없는 라우트, 섞이면 optional 라우트, 있으면 이름표대로의 라우트에 맞고 원천 이름표 peaket.io/auth가 인증 종류와 같다", () => {
  const problems = [];
  let n = 0;
  for (const o of apiOps()) {
    const hit = opRoute(o);
    if (!hit) {
      problems.push(`${o.key}: 받는 라우트가 없다`);
      continue;
    }
    n++;
    const kind = expectedKind(o);
    const label = hit.route.metadata?.labels?.[AUTH_LABEL];
    if (label !== kind) problems.push(`${o.key}: ${hit.route.metadata?.name}의 이름표 ${AUTH_LABEL}=${label} ≠ 인증 종류 ${kind}`);
    const p = policyProblem(hit.route, kind);
    if (p) problems.push(`${o.key}: ${p}`);
  }
  assert.ok(n > 300, `본 작업이 적다(${n})`);
  assert.deepEqual(problems.slice(0, 40), [], `인증 종류가 맞지 않는 작업 ${problems.length}개(앞 40개)`);
});

/** 관리 계정 초대 수락 흐름 일곱(파트너·관제)과 감사 앵커 공개 조회 둘 */
const INVITATION_STEPS = ['invitation-acceptances', 'invitation-passwords', 'invitation-totp-enrollments', 'invitation-totp-confirmations', 'invitation-passkey-registrations', 'invitation-passkeys', 'invitation-completions'];
const PUBLIC_W7_WIR_05 = [
  ...INVITATION_STEPS.map((s) => `POST /v1/partner/auth/${s}`),
  ...INVITATION_STEPS.map((s) => `POST /v1/ops/auth/${s}`),
  'GET /v1/ops/audit-anchors/{checkpointId}',
  'GET /v1/ops/audit-anchors/{checkpointId}/verification',
];

test('W7-WIR-05 security: []인 열여섯 작업(POST /v1/partner/auth/invitation-* 일곱, POST /v1/ops/auth/invitation-* 일곱, GET /v1/ops/audit-anchors/{checkpointId}·…/verification)은 jwt 없는 라우트에 맞는다', () => {
  assert.equal(PUBLIC_W7_WIR_05.length, 16);
  for (const key of PUBLIC_W7_WIR_05) {
    const o = opByKey(key);
    assert.equal(authKind(o.op), 'public', `${key}: security ${JSON.stringify(o.op.security)}`);
    const hit = opRoute(o);
    assert.ok(hit, `${key}를 받는 라우트가 없다`);
    assert.deepEqual(jwtOf(hit.route), [], `${key}: ${hit.route.metadata?.name}에 토큰 확인이 있다`);
  }
});

test('RV-04 GET /v1/events/{eventId}·review-summary는 jwt 없는 라우트, GET …/reviews는 optional 라우트, www 호스트의 seatmap-layouts·/v1/identity/link-proposals/*는 jwt 없는 라우트에 맞는다', () => {
  for (const key of ['GET /v1/events/{eventId}', 'GET /v1/events/{eventId}/review-summary']) {
    const hit = opRoute(opByKey(key));
    assert.ok(hit, `${key}를 받는 라우트가 없다`);
    assert.equal(policyProblem(hit.route, 'public'), null, `${key}: ${policyProblem(hit.route, 'public')}`);
  }
  const reviews = opByKey('GET /v1/events/{eventId}/reviews');
  assert.equal(authKind(reviews.op), 'optional');
  const hit = opRoute(reviews);
  assert.ok(hit, 'GET /v1/events/{eventId}/reviews를 받는 라우트가 없다');
  assert.equal(policyProblem(hit.route, 'optional'), null, `GET …/reviews: ${policyProblem(hit.route, 'optional')}`);
  // www 호스트(앱 서버·정적 파일) 작업: 게이트웨이 API 라우트가 아니라 www 라우트가 받고, 그 라우트에 토큰 확인이 없다
  const www = OPS.filter((o) => o.host === 'www.peaket.example' && (/\/seatmap-layouts\//.test(o.path) || o.path.startsWith('/v1/identity/link-proposals/')));
  assert.ok(www.length >= 2, `www 작업이 없다: ${www.map((o) => o.key)}`);
  for (const o of www) {
    assert.equal(authKind(o.op), 'public', `${o.key}: security ${JSON.stringify(o.op.security)}`);
    const w = routeFor('www.peaket.example', o.method, fill(o.path));
    assert.ok(w, `${o.key}: www 라우트가 없다`);
    assert.deepEqual(jwtOf(w.route), [], `${o.key}: ${w.route.metadata?.name}에 토큰 확인이 있다`);
    assert.equal(routeFor('api.peaket.example', o.method, fill(o.path))?.rule.backendRefs?.length ?? 0, 0, `${o.key}: api 호스트 라우트가 백엔드로 받는다`);
  }
});

test('W7-COR-04 openapi에서 admissionToken이 없는 갈래가 있는 gw-fan·gw-queue 작업마다 닿는 인가가 ticket:buy를 요구하지 않는다(GET /v1/orders·GET /v1/orders/{orderId}·GET /v1/orders/{orderId}/payment-status 포함)', () => {
  for (const key of ['GET /v1/orders', 'GET /v1/orders/{orderId}', 'GET /v1/orders/{orderId}/payment-status']) assert.equal(authKind(opByKey(key).op), 'token', key);
  const problems = [];
  let n = 0;
  for (const o of apiOps().filter((x) => (x.gw === 'gw-fan' || x.gw === 'gw-queue') && expectedKind(x) !== 'token-buy')) {
    const hit = opRoute(o);
    if (!hit) continue;
    n++;
    if (requiresBuy(hit.route)) problems.push(`${o.key}(${hit.route.metadata?.name})`);
  }
  assert.ok(n > 50, `본 작업이 적다(${n})`);
  assert.deepEqual(problems, [], 'admissionToken 없는 갈래가 있는데 ticket:buy를 요구한다');
  // 반대 방향: 모든 갈래에 admissionToken이 있는 작업은 ticket:buy를 요구한다
  for (const o of apiOps().filter((x) => expectedKind(x) === 'token-buy')) {
    const hit = opRoute(o);
    assert.ok(hit && requiresBuy(hit.route), `${o.key}: ticket:buy를 요구하지 않는다`);
  }
});

test('W7-COR-04 저장소 openapi: 구매 경로(모든 갈래에 admissionToken) 작업은 모두 x-peaket-scopes에 ticket:buy가 있고, 대기열 진입·입장 확정에도 있으며 로비 참가·POST /v1/shop/orders에는 없다', () => {
  const purchase = apiOps().filter((o) => isPurchase(o.op));
  assert.ok(purchase.length >= 9, `구매 경로 작업이 적다(${purchase.length})`);
  for (const o of purchase) assert.ok(wantsBuy(o.op), `${o.key}: 구매 경로인데 x-peaket-scopes에 ticket:buy가 없다`);
  for (const key of ['POST /v1/queues/{eventId}/entries', 'POST /v1/queues/{eventId}/admission']) assert.ok(wantsBuy(opByKey(key).op), `${key}: x-peaket-scopes에 ticket:buy가 없다`);
  for (const key of ['POST /v1/queues/{eventId}/lobby-participants', 'POST /v1/shop/orders', 'GET /v1/orders', 'GET /v1/orders/{orderId}', 'GET /v1/orders/{orderId}/payment-status']) assert.ok(!wantsBuy(opByKey(key).op), `${key}: x-peaket-scopes에 ticket:buy가 있다`);
  // ticket:buy 밖의 스코프 값은 아직 없다(모르는 값을 게이트웨이가 요구하지 않게)
  for (const o of OPS) for (const s of o.op['x-peaket-scopes'] ?? []) assert.equal(s, 'ticket:buy', `${o.key}: 모르는 스코프 ${s}`);
});

// ===================== 경로별 시간 상한(W7-CON-02) =====================

/** 작업 하나만 담은 규칙인가(OPTIONS는 뺌) */
const onlyThat = (rule, o) => (rule.matches ?? []).filter((m) => m.method !== 'OPTIONS').every((m) => pathScore(m, o.method, fill(o.path)) >= 0 && m.method === o.method);

test("W7-CON-02 infra §4.1 '경로별 시간 상한' GET /v1/orders/{orderId}/payment-status 생성 규칙의 timeouts.request가 27s이고 getOpsLive·getOpsEventLive 규칙은 0s이며 그 밖의 규칙은 시간 상한을 바꾸지 않는다", () => {
  const cases = [
    [opByKey('GET /v1/orders/{orderId}/payment-status'), '27s'],
    ...OPS.filter((o) => ['getOpsLive', 'getOpsEventLive'].includes(o.op.operationId)).map((o) => [o, '0s']),
  ];
  assert.equal(cases.length, 3, `시간 상한 작업 셋: ${cases.map(([o]) => o.key)}`);
  const special = new Set();
  for (const [o, want] of cases) {
    const hit = opRoute(o);
    assert.ok(hit, `${o.key}를 받는 라우트가 없다`);
    assert.equal(hit.rule.timeouts?.request, want, `${o.key}(${hit.route.metadata?.name}): timeouts.request`);
    assert.ok(onlyThat(hit.rule, o), `${o.key}: 시간 상한 규칙에 다른 작업이 섞였다(그 작업만 Exact 규칙으로 뗀다)`);
    special.add(hit.rule);
  }
  for (const gw of GATEWAYS)
    for (const r of routesOf(gw)) for (const rule of r.spec?.rules ?? []) if (!special.has(rule)) assert.equal(rule.timeouts?.request, undefined, `${r.metadata?.name}: 다른 규칙에 시간 상한 ${rule.timeouts?.request}`);
});

// ===================== 게이트웨이 오류 403·405(W7-WIR-08 · W7-SEC-04) =====================

function codesOf(entry) {
  return findKey(entry.match ?? {}, 'statusCodes')
    .flat()
    .map((c) => (typeof c === 'number' ? c : Number(c?.value)));
}
function assertOverride(policies, code, where) {
  const list = policies.flatMap((p) => (p.spec?.responseOverride ?? []).map((o) => ({ policy: p.metadata?.name, o })));
  const first = list.find(({ o }) => codesOf(o).includes(code) && !(o.match?.requestHeaders?.length || o.match?.responseHeaders?.length));
  assert.ok(first, `${where}: ${code}의 responseOverride가 없다`);
  assert.deepEqual(findKey(first.o, 'source'), ['Local'], `${where} ${code}: source`);
  assert.equal(first.o.response?.contentType, 'application/problem+json', `${where} ${code}: 형식`);
  const inline = findKey(first.o.response ?? {}, 'inline').find((v) => typeof v === 'string');
  assert.deepEqual(JSON.parse(inline ?? 'null'), { type: 'about:blank', title: TITLES[code], status: code }, `${where} ${code}: 본문`);
}

test('W7-WIR-08 W7-SEC-04 다섯 게이트웨이의 responseOverride에 403(Forbidden)·405(Method Not Allowed)가 있고 라우트마다 닿는다', () => {
  for (const gw of GATEWAYS) {
    for (const code of [403, 405]) {
      assertOverride(gatewayPolicies('BackendTrafficPolicy', gw), code, `${gw}(게이트웨이)`);
      for (const r of routesOf(gw)) assertOverride(effective('BackendTrafficPolicy', r), code, `${gw}/${r.metadata?.name}`);
    }
  }
});

// ===================== 이미 고쳐진 것(W7-COR-06 · RV-05 · RV-11) =====================

test('W7-COR-06 openapi의 api 호스트 작업마다 생성 규칙이 있고 gw-fan-not-found에만 맞는 작업이 없다', () => {
  const ops = OPS.filter((o) => o.gw === 'gw-fan');
  assert.ok(ops.length > 50, `api 호스트 작업이 적다(${ops.length})`);
  for (const o of ops) {
    const hit = routeFor(o.host, o.method, fill(o.path));
    assert.ok(hit, `${o.key}: 맞는 라우트가 없다`);
    assert.notEqual(hit.route.metadata?.name, 'gw-fan-not-found', `${o.key}: gw-fan-not-found에만 맞는다`);
    assert.ok((hit.rule.backendRefs ?? []).length > 0, `${o.key}: ${hit.route.metadata?.name}가 백엔드로 넘기지 않는다`);
    assert.ok(hit.route.metadata?.labels?.[ROUTE_LABEL],`${o.key}: 생성 라우트가 아니다(${hit.route.metadata?.name})`);
  }
});

test('RV-05 POST /v1/queues/{eventId}/verification의 생성 규칙이 있고 백엔드가 queue-svc다', () => {
  const hit = opRoute(opByKey('POST /v1/queues/{eventId}/verification'));
  assert.ok(hit, '받는 라우트가 없다');
  assert.equal(hit.match.method, 'POST');
  assert.deepEqual((hit.rule.backendRefs ?? []).map((b) => b.name), ['queue-svc']);
  assert.ok(hit.route.metadata?.labels?.[ROUTE_LABEL], `${hit.route.metadata?.name}: 생성 라우트가 아니다`);
});

test('RV-11 호스트마다 TRACE가 아닌 모든 생성 규칙의 경로에서 TRACE가 그 호스트의 trace 라우트로 풀린다', () => {
  let n = 0;
  for (const gw of GATEWAYS) {
    const host = API_HOST[gw];
    for (const r of routesOf(gw).filter((x) => x.metadata?.labels?.[ROUTE_LABEL] && (x.spec?.hostnames ?? []).includes(host)))
      for (const rule of r.spec?.rules ?? [])
        for (const m of rule.matches ?? []) {
          if (m.method === 'TRACE') continue;
          const sample = m.path?.type === 'Exact' ? m.path.value : OPS.find((o) => o.host === host && new RegExp(`^(?:${m.path?.value})$`).test(fill(o.path))) ? fill(OPS.find((o) => o.host === host && new RegExp(`^(?:${m.path?.value})$`).test(fill(o.path))).path) : null;
          if (!sample) continue;
          n++;
          const hit = routeFor(host, 'TRACE', sample);
          assert.ok(hit, `${gw} TRACE ${sample}: 맞는 라우트가 없다`);
          assert.equal(hit.route.metadata?.name, `${gw}-trace`, `${gw} TRACE ${sample}: ${hit.route.metadata?.name}에 맞는다`);
          const direct = (hit.rule.filters ?? []).filter((f) => f.type === 'ExtensionRef').map((f) => named('HTTPRouteFilter', f.extensionRef?.name)?.spec?.directResponse?.statusCode);
          assert.deepEqual(direct.map(Number), [405], `${gw} TRACE ${sample}: 직접 응답`);
        }
  }
  assert.ok(n > 300, `본 경로가 적다(${n})`);
});
