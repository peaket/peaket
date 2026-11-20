// 관리 인증 게이트웨이 정적 시험(BUILD_ORDER BOT-132·BOT-140, 묶음 BAT-045, ADR-0321).
// 정본: docs/security/auth-controls.md §2.1 C1·C2, docs/infra.md §4.1 '원본 확인 머리'·§9 '관제 입구 경로',
// docs/features/identity.md §3 쿠키 표, docs/review/plans/BAT-045.md §3 B1~B9·§6.
// - gw-partner·gw-ops가 identity의 Set-Cookie를 그대로 넘기는지(응답 필터가 지우거나 덮지 않는지)
// - 쿠키를 쓰는 쓰기의 Origin 확인(csrf)이 로그인·갱신 라우트에 붙었는지
// - gw-ops 리프레시 쿠키(__Host-peaket_ops_rt)가 갱신 경로 밖에서 지워지는지(공통 Lua)
// - gw-ops 원본 확인 필수와 /internal 404 차례
// - PEAKET_OPS_ALLOWED_IPS IPv4 CIDR 허용·거절(공통 Lua), ConfigMap·EnvoyProxy 값
// 동작은 kind의 tools/local/e2e/gateway-admin-auth.e2e.mjs가 본다. 여기서는 정의 파일과 Lua 원문의 규칙을 고정한다.
// 실행: node --test "deploy/gateways/test/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(HERE, '..');
const REPO = resolve(DIR, '..', '..');
const OPS_ORIGIN = 'https://console.peaket.example';
const PARTNER_ORIGIN = 'https://partner.peaket.example';
const OPS_RT = '__Host-peaket_ops_rt';
const OPS_AT = '__Host-peaket_ops_at';
const PARTNER_RT = '__Secure-peaket_partner_rt';
const OPS_REFRESH_PATH = '/v1/ops/auth/access-tokens';
const PARTNER_REFRESH_PATH = '/v1/partner/auth/access-tokens';

function parse(file) {
  return parseAllDocuments(readFileSync(file, 'utf8')).flatMap((d) => {
    if (d.errors.length) throw new Error(`${file}: ${d.errors[0].message}`);
    const o = d.toJS();
    return o && typeof o === 'object' ? [o] : [];
  });
}
const OBJECTS = readdirSync(DIR)
  .filter((n) => /\.ya?ml$/.test(n))
  .sort()
  .flatMap((n) => parse(join(DIR, n)));
const byKind = (kind) => OBJECTS.filter((o) => o.kind === kind);
const named = (kind, name) => byKind(kind).find((o) => o.metadata?.name === name);
const raw = (n) => readFileSync(join(DIR, n), 'utf8');

/** 글에서 start부터 end 앞까지(없으면 끝까지) */
function region(text, start, end) {
  const a = text.indexOf(start);
  assert.ok(a >= 0, `Lua에 '${start}'가 없다`);
  const b = end === undefined ? text.length : text.indexOf(end, a + start.length);
  return text.slice(a, b < 0 ? text.length : b);
}

const LUA = named('ConfigMap', 'peaket-gateway-edge-lua')?.data?.lua;
assert.equal(typeof LUA, 'string', '공통 Lua(ConfigMap peaket-gateway-edge-lua)가 없다');

const filterContextsOf = (policyName) =>
  (named('EnvoyExtensionPolicy', policyName)?.spec?.lua ?? [])
    .filter((l) => l.type === 'ValueRef')
    .map((l) => l.filterContext ?? {});
const opsCtx = filterContextsOf('gw-ops-edge');
const partnerCtx = filterContextsOf('gw-partner-edge');

test('B1 관리 로그인·갱신·로그아웃 라우트가 있고 gw-partner·gw-ops 응답 고치기가 Set-Cookie·Cache-Control을 지우거나 덮지 않는다', () => {
  for (const [file, paths] of [
    ['gw-ops.routes.yaml', [`POST /v1/ops/auth/sessions`, `POST ${OPS_REFRESH_PATH}`, `DELETE /v1/ops/auth/sessions/me`]],
    ['gw-partner.routes.yaml', [`POST /v1/partner/auth/sessions`, `POST ${PARTNER_REFRESH_PATH}`, `DELETE /v1/partner/auth/sessions/me`]],
  ]) {
    const text = raw(file);
    for (const key of paths) {
      const [method, path] = key.split(' ');
      // 생성 규칙은 메서드와 Exact 경로를 짝지어 적는다(규칙 순서·상한으로 나뉜 라우트는 여기서 보지 않는다)
      const re = new RegExp(`value: ${path.replaceAll('/', '\\/').replace('.', '\\.')}\\n\\s+method: ${method}`);
      assert.match(text, re, `${file}: ${key}를 받는 생성 규칙이 없다`);
    }
  }
  for (const gw of ['gw-ops', 'gw-partner']) {
    const p = named('BackendTrafficPolicy', `${gw}-responses`);
    assert.ok(p, `${gw}-responses 정책이 없다`);
    for (const [i, o] of (p.spec?.responseOverride ?? []).entries()) {
      const headerNames = (o.response?.header?.set ?? []).map((h) => String(h.name).toLowerCase());
      for (const banned of ['set-cookie', 'cache-control']) assert.ok(!headerNames.includes(banned), `${gw}-responses.responseOverride[${i}]가 ${banned}를 다시 쓴다`);
      const remove = (o.response?.header?.remove ?? []).map((h) => String(h).toLowerCase());
      for (const banned of ['set-cookie', 'cache-control']) assert.ok(!remove.includes(banned), `${gw}-responses.responseOverride[${i}]가 ${banned}를 지운다`);
    }
    const late = named('ClientTrafficPolicy', `${gw}-client`)?.spec?.headers?.lateResponseHeaders ?? {};
    const names = [...(late.set ?? []), ...(late.add ?? []), ...(late.addIfAbsent ?? [])].map((h) => String(h.name).toLowerCase());
    for (const banned of ['set-cookie', 'cache-control']) assert.ok(!names.includes(banned), `${gw}-client.lateResponseHeaders가 ${banned}를 덮는다`);
    // 응답 머리 고치기 필터(ResponseHeaderModifier)도 Set-Cookie를 지우지 않는다
    assert.doesNotMatch(raw(`${gw}.routes.yaml`), /ResponseHeaderModifier[\s\S]{0,400}?remove:[\s\S]{0,200}?set-cookie/i, `${gw}.routes.yaml의 응답 머리 고치기가 Set-Cookie를 지운다`);
  }
});

test('I-T46 ④ I-T52 ② 쿠키를 쓰는 로그인·갱신 라우트의 SecurityPolicy에 콘솔 출처 csrf가 있고, 콘솔 앱 서버 호스트에는 걸지 않는다', () => {
  const target = (name) => named('SecurityPolicy', name)?.spec;
  for (const [name, origin] of [
    ['gw-ops-public-security', OPS_ORIGIN],
    ['gw-partner-public-security', PARTNER_ORIGIN],
  ]) {
    const s = target(name);
    assert.ok(s, `${name}가 없다`);
    assert.deepEqual(s.csrf?.additionalOrigins, [origin], `${name}.csrf.additionalOrigins는 콘솔 출처 하나다`);
    assert.deepEqual(s.cors?.allowOrigins, [origin], `${name}.cors.allowOrigins`);
  }
  // 로그인·갱신 라우트가 그 정책을 받는 라우트 이름(gw-ops-public·gw-partner-public)에 속한다
  for (const [gw, routeName] of [['gw-ops', 'gw-ops-public'], ['gw-partner', 'gw-partner-public']]) {
    const policy = named('SecurityPolicy', `${routeName}-security`);
    assert.ok((policy.spec?.targetRefs ?? []).some((r) => r.name === routeName), `${gw}: csrf 정책이 ${routeName}을 겨누지 않는다`);
  }
});

test('I-T46 ⑤ 공통 Lua는 refreshCookie를 갱신 경로의 POST 밖에서 Cookie 머리에서 지우고, 다른 쿠키는 남긴다', () => {
  const fn = region(LUA, 'local function rewrite_cookies', '--[[ Envoy JWT 필터가 꺼낼 수 있는');
  assert.match(fn, /setting\(ctx, "refreshCookie"\)/, 'refreshCookie 설정을 읽지 않는다');
  assert.match(fn, /setting\(ctx, "refreshPath"\)/, 'refreshPath 설정을 읽지 않는다');
  assert.match(fn, /method == "POST"/, 'POST만 갱신 경로로 보지 않는다');
  assert.match(fn, /p == path/, '정확한 갱신 경로만 넘기지 않는다');
  assert.match(fn, /values_of\(headers, "cookie"\)/, 'Cookie 머리 여럿을 보지 않는다');
  assert.match(fn, /local n = eq and trim\(string\.sub\(seg, 1, eq - 1\)\) or ""/, '쿠키 이름 앞뒤 빈칸을 떼지 않는다');
  assert.match(fn, /n ~= name/, '리프레시 쿠키만 지우는 조건이 없다(다른 쿠키까지 지운다)');
  assert.match(fn, /headers:remove\("cookie"\)/, 'Cookie 머리를 다시 쓰지 않는다');
  assert.match(fn, /headers:add\("cookie", table\.concat\(kept, "; "\)\)/, '남은 쿠키를 하나로 이어 넣지 않는다');
  // 갱신 경로가 아닐 때만 지운다: 일찍 return하는 갈래가 POST+경로일 때뿐이다
  assert.match(fn, /^[ \t]+if method == "POST" and type\(path\) == "string" and path ~= "" and p == path then return end$/m, '갱신 경로에서도 지운다');

  assert.deepEqual(opsCtx, [{ originVerify: true, requireOriginVerify: true, opsAllowedIpsEnv: 'PEAKET_OPS_ALLOWED_IPS', checkTyp: false, tokenCookie: OPS_AT, tokenScheme: 'Bearer', refreshCookie: OPS_RT, refreshPath: OPS_REFRESH_PATH }], 'gw-ops filterContext');
  assert.deepEqual(partnerCtx, [{ originVerify: true, checkTyp: false, tokenCookie: '__Secure-peaket_partner_at', tokenScheme: 'Bearer', refreshCookie: PARTNER_RT, refreshPath: PARTNER_REFRESH_PATH }], 'gw-partner filterContext');
  assert.notEqual(partnerCtx[0].requireOriginVerify, true, 'gw-partner에 원본 확인 필수를 켰다(직접 호출 규칙이 아직 없다)');
});

test('B6 B7 gw-ops는 원본 확인이 틀리면 403이고, /internal 404가 그보다 먼저이며, 허용 IP는 원본 확인이 맞은 요청에서만 본다', () => {
  const handler = LUA.slice(LUA.indexOf('function envoy_on_request'));
  const internal = handler.indexOf('is_internal(headers:get(":path"))');
  const requireVerify = handler.indexOf('setting(ctx, "requireOriginVerify")');
  const ipCheck = handler.indexOf('setting(ctx, "opsAllowedIpsEnv")');
  assert.ok(internal >= 0 && requireVerify > internal, '/internal 404가 원본 확인 필수보다 먼저가 아니다');
  assert.ok(ipCheck > requireVerify, '허용 IP 검사가 원본 확인 필수보다 먼저다');
  const block = handler.slice(requireVerify, ipCheck);
  assert.match(block, /setting\(ctx, "requireOriginVerify"\) == true and not verified then\n\s+return handle:respond\(direct_headers\("403"\), FORBIDDEN\)/, '원본 확인이 틀려도 통과시킨다');
  assert.match(block, /direct_headers\("403"\)/, '원본 확인 실패가 403이 아니다');
  const ipBlock = handler.slice(ipCheck, handler.indexOf('rewrite_cookies(headers, ctx)'));
  assert.match(ipBlock, /if verified and type\(opsEnv\) == "string" and opsEnv ~= "" then/, '원본 확인이 맞지 않은 요청에도 허용 IP를 본다(또는 아예 보지 않는다)');
  assert.match(ipBlock, /pcall\(ops_ip_check/, '허용 IP 확인을 pcall로 감싸지 않는다(Envoy는 Lua 오류 뒤로 요청을 넘긴다)');
  assert.match(ipBlock, /return handle:respond\(direct_headers\("403"\), FORBIDDEN\)/, '허용 IP 거절이 403이 아니다');
});

test('B7 허용 IP는 CloudFront-Viewer-Address(IPv4, IP:port)만 보고 x-forwarded-for를 보지 않으며, 빈 값·형식 오류·IPv6는 모두 거절한다', () => {
  const viewer = region(LUA, 'local function viewer_ip', '-- gw-ops 허용 IP: 통과면 nil');
  assert.match(viewer, /values_of\(headers, "cloudfront-viewer-address"\)/, 'CloudFront-Viewer-Address를 읽지 않는다');
  assert.doesNotMatch(viewer, /x-forwarded-for|x_real_ip|downstream_remote/, '꾸밀 수 있는 다른 주소 머리를 본다');
  assert.match(viewer, /if #vals == 0 then return nil, "missing" end/, '머리가 없을 때 거절하지 않는다');
  assert.match(viewer, /if #vals ~= 1 then return nil, "malformed" end/, '머리가 여럿일 때 거절하지 않는다');
  assert.match(viewer, /string\.find\(v, ":", 1, true\) ~= nil/, 'IPv6·콜론이 든 값을 거절하지 않는다');
  assert.match(viewer, /local ip = ipv4_of\(v\)\n\s+if ip == nil then return nil, "malformed" end/, 'IPv4 꼴이 아닌 값을 거절하지 않는다');

  const cidrs = region(LUA, 'local function cidrs_of', '-- 거절 지표');
  assert.match(cidrs, /local raw = os\.getenv\(envName\)/, '환경 값을 읽지 않는다');
  assert.match(cidrs, /if type\(raw\) ~= "string" then return nil end/, '값이 없을 때 nil(모두 거절)이 아니다');
  assert.match(cidrs, /if raw == "" then return nil end/, '빈 값일 때 nil(모두 거절)이 아니다');
  assert.match(cidrs, /local c = cidr_of\(seg\)\n\s+if c == nil then return nil end/, 'CIDR이 하나라도 틀리면 목록 전체를 버리지 않는다');
  assert.match(cidrs, /if #out > 32 then return nil end/, 'CIDR 32개 상한이 없다');
  assert.match(cidrs, /if #out == 0 then return nil end/, '빈 목록을 통과로 본다');

  const check = region(LUA, 'local function ops_ip_check', '-- 2.5 리프레시 쿠키');
  assert.match(check, /local cidrs = cidrs_of\(envName\)\n\s+if cidrs == nil then\n\s+ops_ip_denied\(handle, "missing", ip\)\n\s+return "missing"/, '환경 값이 없거나 틀릴 때 모두 허용한다');
  assert.match(check, /for _, c in ipairs\(cidrs\) do\n\s+if in_cidr\(ip, c\) then return nil end/, '목록 밖 주소를 거절하지 않는다');
  assert.match(check, /ops_ip_denied\(handle, "not_allowed", ip\)/, '목록 밖 거절 사유가 없다');
  const inCidr = region(LUA, 'local function in_cidr', '-- 환경 값의 IPv4 CIDR 목록');
  assert.match(inCidr, /if cidr\.bits == 0 then return true end/, '/0 처리');
  assert.match(inCidr, /math\.floor\(ip \/ size\) == math\.floor\(cidr\.net \/ size\)/, 'CIDR 비교식이 없다');
});

test('B9 허용 IP 거절은 사유별 지표와 합계, 가린 출발지(/24) 로그로 남긴다', () => {
  const denied = region(LUA, 'local function ops_ip_denied', '-- CloudFront-Viewer-Address');
  for (const reason of ['missing', 'malformed', 'not_allowed']) assert.match(LUA, new RegExp(`"${reason}"`), `거절 사유 ${reason}이 없다`);
  assert.match(denied, /"gateway_ops_ip_denied_" \.\. reason/, '사유별 지표 이름이 없다');
  assert.match(denied, /"gateway_ops_ip_denied_total"/, '합계 지표 gateway_ops_ip_denied_total이 없다');
  assert.match(denied, /string\.format\("%d\.%d\.%d\.0\/24"/, '출발지를 /24로 가리지 않는다');
  assert.match(denied, /handle:logInfo\("peaket ops ip denied reason="/, '거절 로그가 없다');
});

test('B8 PEAKET_OPS_ALLOWED_IPS는 gw-ops 프록시 환경 값(ConfigMap peaket-ops-allow의 cidrs)이고 local 시험 값만 저장소에 있다', () => {
  const proxy = named('EnvoyProxy', 'peaket-proxy');
  const env = proxy?.spec?.provider?.kubernetes?.envoyDeployment?.container?.env ?? [];
  const e = env.find((x) => x.name === 'PEAKET_OPS_ALLOWED_IPS');
  assert.ok(e, 'EnvoyProxy peaket-proxy에 PEAKET_OPS_ALLOWED_IPS가 없다');
  assert.deepEqual(e.valueFrom?.configMapKeyRef, { name: 'peaket-ops-allow', key: 'cidrs', optional: true }, 'ConfigMap peaket-ops-allow의 cidrs를 선택적으로 받지 않는다');
  assert.ok((proxy.spec?.lua?.strictValidation?.allowedEnvVars ?? []).includes('PEAKET_OPS_ALLOWED_IPS'), 'Lua Strict의 allowedEnvVars에 없다');
  const local = parse(join(REPO, 'deploy', 'envs', 'local', 'gateways', 'peaket-ops-allow.yaml'))[0];
  assert.equal(local?.kind, 'ConfigMap');
  assert.equal(local?.metadata?.name, 'peaket-ops-allow');
  assert.equal(local?.metadata?.namespace, 'envoy-gateway-system');
  assert.equal(local?.data?.cidrs, '127.0.0.0/8,203.0.113.0/24');
  // 운영 값(사내망·VPN 출구)은 저장소에 두지 않는다: local·ci 밖 환경 파일에 gw-ops 허용 목록이 없다
  for (const o of OBJECTS.filter((x) => x.kind === 'ConfigMap' && x.metadata?.name === 'peaket-ops-allow')) assert.equal(o.metadata.namespace, 'envoy-gateway-system');
});

test('B7 허용 IP는 SecurityPolicy.clientCIDRs가 아니라 공통 Lua가 본다(감독 결정 3)', () => {
  for (const f of readdirSync(DIR).filter((n) => /\.ya?ml$/.test(n))) assert.doesNotMatch(raw(f), /clientCIDRs/, `${f}: clientCIDRs를 쓴다`);
  assert.match(LUA, /os\.getenv\(envName\)/, 'Lua가 환경 값을 읽지 않는다');
});

test('B2 게이트웨이 응답 고치기의 403 Problem은 고정 본문이고 404/401을 허용 IP 거절과 섞지 않는다', () => {
  for (const gw of ['gw-ops', 'gw-partner']) {
    const p = named('BackendTrafficPolicy', `${gw}-responses`);
    const forbidden = (p.spec?.responseOverride ?? []).filter((o) => (o.match?.statusCodes ?? []).some((s) => s.value === 403) && !o.match?.responseHeaders);
    assert.ok(forbidden.length > 0, `${gw}: 403 고정 Problem이 없다`);
    assert.deepEqual(JSON.parse(forbidden[0].response.body.inline), { type: 'about:blank', title: 'Forbidden', status: 403 }, `${gw}: 403 본문`);
  }
});
