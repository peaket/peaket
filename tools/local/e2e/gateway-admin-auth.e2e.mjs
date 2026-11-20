// 관리 인증 게이트웨이 kind 시험(BUILD_ORDER BOT-132·BOT-140, 묶음 BAT-045, ADR-0321).
// 판정: I-T46 ④⑤, I-T52 ①②, gw-ops 원본 확인·허용 IP(장부 ID 없음).
// - ④ 쿠키를 쓰는 로그인·갱신 쓰기의 Origin이 콘솔 출처와 다르거나 없으면 403이고 대역 백엔드에 닿지 않는다.
// - ⑤ gw-ops 리프레시 쿠키(__Host-peaket_ops_rt)는 갱신 경로(/v1/ops/auth/access-tokens POST) 밖에서 Cookie 머리에서 빠지고,
//      갱신 경로에서는 남는다. Cookie 머리 둘·큰따옴표·앞뒤 빈칸도 같다. 파트너 rt도 갱신 경로 밖에서 빠진다.
// - ① 파트너 로그인 응답의 Set-Cookie 둘이 게이트웨이를 지나 그대로 오고 본문에 토큰이 없으며 Cache-Control: no-store다.
// - gw-ops 허용 IP: 목록 안은 통과, 목록 밖·머리 없음·형식 오류·IPv6는 403, x-forwarded-for를 꾸며도 통과하지 못한다.
// 실행(저장소 뿌리, Docker 차례 잠금): node tools/local/cluster.mjs up && node tools/local/cluster.mjs gateways
//   && node --test tools/local/e2e/gateway-admin-auth.e2e.mjs
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { accessToken, echoed, edge, loadContract, send } from './gateway-client.mjs';

const RUN = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const OPS_AT = '__Host-peaket_ops_at';
const OPS_RT = '__Host-peaket_ops_rt';
const PARTNER_AT = '__Secure-peaket_partner_at';
const PARTNER_RT = '__Secure-peaket_partner_rt';
const OPS_REFRESH = '/v1/ops/auth/access-tokens';
const PARTNER_REFRESH = '/v1/partner/auth/access-tokens';
const ALLOWED = '203.0.113.10';
const DENIED = '198.51.100.7';
let c;
let n = 0;
const nextSub = () => `aa-${RUN}-${++n}`;
const nextIp = () => `203.0.113.${20 + (n++ % 200)}`;

before(() => {
  c = loadContract();
});

/** 게이트웨이가 만든 Problem 403(대역에 닿지 않음) */
function assertForbidden(r, label) {
  assert.equal(r.status, 403, `${label}: 상태 ${r.status} ${r.text.slice(0, 300)}`);
  assert.match(String(r.headers['content-type'] ?? ''), /^application\/problem\+json\b/, `${label}: 형식`);
  assert.deepEqual(JSON.parse(r.text), { type: 'about:blank', title: 'Forbidden', status: 403 }, `${label}: 본문`);
  assert.throws(() => echoed(r), `${label}: 대역 백엔드에 닿았다`);
}

const opsToken = () => accessToken(c, 'gw-ops', nextSub());
const opsHeaders = (extra = {}, viewer = nextIp()) => edge(c, viewer, { authorization: `Bearer ${opsToken()}`, ...extra }, viewer);
const partnerHeaders = (extra = {}, ip = nextIp()) => edge(c, ip, { authorization: `Bearer ${accessToken(c, 'gw-partner', nextSub())}`, ...extra }, ip);

test('I-T46 ⑤ gw-ops 리프레시 쿠키는 갱신 경로 밖에서 빠지고 액세스 쿠키는 남는다(갱신 경로 POST에서는 남는다)', async () => {
  const at = opsToken();
  const ip = nextIp();
  const cookie = `${OPS_AT}=${at}; ${OPS_RT}=refresh-${RUN}`;
  const outside = await send(c, 'ops-api', { method: 'GET', path: '/v1/ops/commands', headers: edge(c, ip, { cookie }, ip) });
  const h = echoed(outside);
  assert.ok(h.cookie.includes(`${OPS_AT}=`), '액세스 쿠키까지 지웠다');
  assert.ok(!h.cookie.includes(OPS_RT), `리프레시 쿠키가 갱신 경로 밖으로 나갔다: ${h.cookie}`);
  assert.equal(h['cloudfront-viewer-address'], `${ip}:443`, '원본 확인이 맞으면 Viewer 주소는 안쪽으로 남는다(끝단 머리 지우기는 확인이 틀릴 때만)');

  const inside = await send(c, 'ops-api', { method: 'POST', path: OPS_REFRESH, headers: edge(c, ip, { cookie, origin: c.origins.console }, ip), body: '' });
  const hi = echoed(inside);
  assert.ok(hi.cookie.includes(`${OPS_AT}=`), '갱신 경로에서 액세스 쿠키를 지웠다');
  assert.ok(hi.cookie.includes(`${OPS_RT}=`), '갱신 경로에서 리프레시 쿠키를 지웠다');

  // 라우트 수준 filterContext(gw-ops-api-edge)가 게이트웨이 설정을 덮어도 지워지는지: 다른 API 경로에서도 같다
  const me = await send(c, 'ops-api', { method: 'GET', path: '/v1/ops/auth/sessions/me', headers: edge(c, ip, { cookie }, ip) });
  const hme = echoed(me);
  assert.ok(!hme.cookie.includes(OPS_RT), `sessions/me에서 리프레시 쿠키가 남았다: ${hme.cookie}`);
  assert.ok(hme.cookie.includes(`${OPS_AT}=`), 'sessions/me에서 액세스 쿠키를 지웠다');
});

test('I-T46 ⑤ Cookie 머리 둘·큰따옴표·앞뒤 빈칸이어도 리프레시 쿠키만 빠진다', async () => {
  const at = opsToken();
  const ip = nextIp();
  const headers = edge(c, ip, { cookie: [`${OPS_AT}=${at};  ${OPS_RT} = "refresh with spaces-${RUN}"`, `${OPS_RT}="other-${RUN}"; kept=1`] }, ip);
  const r = await send(c, 'ops-api', { method: 'GET', path: '/v1/ops/commands', headers });
  const h = echoed(r);
  assert.ok(!h.cookie.includes(OPS_RT), `큰따옴표·머리 둘·빈칸 경우에 리프레시 쿠키가 남았다: ${h.cookie}`);
  assert.ok(h.cookie.includes(`${OPS_AT}=`), '액세스 쿠키를 지웠다');
  assert.ok(h.cookie.includes('kept=1'), '다른 쿠키를 지웠다');
});

test('I-T46 ⑤ 파트너 리프레시 쿠키도 갱신 경로 밖에서 빠진다(깊은 방어)', async () => {
  const ip = nextIp();
  const cookie = `${PARTNER_AT}=${accessToken(c, 'gw-partner', nextSub())}; ${PARTNER_RT}=partner-refresh-${RUN}`;
  const outside = await send(c, 'partner-api', { method: 'GET', path: '/v1/partner/events/e2e/attendees', headers: partnerHeaders({ cookie }, ip) });
  const h = echoed(outside);
  assert.ok(!h.cookie.includes(PARTNER_RT), `파트너 리프레시 쿠키가 갱신 경로 밖으로 나갔다: ${h.cookie}`);
  assert.ok(h.cookie.includes(`${PARTNER_AT}=`), '파트너 액세스 쿠키를 지웠다');
  const inside = await send(c, 'partner-api', { method: 'POST', path: PARTNER_REFRESH, headers: partnerHeaders({ cookie, origin: c.origins.partner }, ip), body: '' });
  assert.ok(echoed(inside).cookie.includes(`${PARTNER_RT}=`), '갱신 경로에서 파트너 리프레시 쿠키를 지웠다');
});

test('I-T46 ④ [ASVS v5.0.0-3.5.1] 운영자 갱신을 다른/빈 Origin으로 보내면 403이고 콘솔 출처면 대역에 닿는다', async () => {
  const ip = nextIp();
  const cookie = `${OPS_RT}=refresh-${RUN}`;
  for (const [label, origin] of [['다른 출처', 'https://evil.example'], ['없음', undefined], ['빈 값', ''], ['null', 'null'], ['다른 콘솔', 'https://partner.peaket.example'], ['끝 슬래시', `${c.origins.console}/`]]) {
    const r = await send(c, 'ops-api', { method: 'POST', path: OPS_REFRESH, headers: edge(c, ip, { cookie, ...(origin === undefined ? {} : { origin }) }, ip), body: '' });
    assertForbidden(r, `운영자 갱신 ${label}`);
  }
  const ok = await send(c, 'ops-api', { method: 'POST', path: OPS_REFRESH, headers: edge(c, ip, { cookie, origin: c.origins.console }, ip), body: '' });
  assert.equal(ok.status, 200, `콘솔 출처가 막혔다: ${ok.status} ${ok.text.slice(0, 200)}`);
  assert.ok(echoed(ok).cookie.includes(OPS_RT));
});

test('I-T52 ② 운영자·파트너 로그인을 다른/빈 Origin으로 보내면 403이고 콘솔 출처면 대역에 닿는다', async () => {
  for (const [host, path, good] of [
    ['ops-api', '/v1/ops/auth/sessions', c.origins.console],
    ['partner-api', '/v1/partner/auth/sessions', c.origins.partner],
  ]) {
    const ip = nextIp();
    for (const [label, origin] of [['다른 출처', 'https://evil.example'], ['없음', undefined], ['빈 값', ''], ['null', 'null'], ['끝 슬래시', `${good}/`]]) {
      const r = await send(c, host, { method: 'POST', path, headers: edge(c, ip, { 'content-type': 'application/json', ...(origin === undefined ? {} : { origin }) }, ip), body: '{}' });
      assertForbidden(r, `${host} 로그인 ${label}`);
    }
    const ok = await send(c, host, { method: 'POST', path, headers: edge(c, ip, { 'content-type': 'application/json', origin: good }, ip), body: '{}' });
    assert.equal(ok.status, 200, `${host} 콘솔 출처가 막혔다: ${ok.status} ${ok.text.slice(0, 200)}`);
    const h = echoed(ok);
    assert.equal(h.origin, good);
  }
});

test('I-T52 ① [ASVS v5.0.0-3.5.1] 파트너 로그인 응답의 Set-Cookie 둘이 그대로 오고 본문에 토큰이 없으며 Cache-Control: no-store다', async () => {
  const ip = nextIp();
  const r = await send(c, 'partner-api', {
    method: 'POST',
    path: '/v1/partner/auth/sessions',
    headers: edge(c, ip, { origin: c.origins.partner, 'content-type': 'application/json', 'x-e2e-set-cookie': JSON.stringify([`${PARTNER_AT}=e2e-access; Path=/; HttpOnly; Secure; SameSite=Lax`, `${PARTNER_RT}=e2e-refresh; Path=/v1/partner/auth/access-tokens; HttpOnly; Secure; SameSite=Lax`]), 'x-e2e-response-headers': JSON.stringify({ 'cache-control': 'no-store' }) }, ip),
    body: '{}',
  });
  assert.equal(r.status, 200, `상태 ${r.status} ${r.text.slice(0, 300)}`);
  const cookies = [].concat(r.headers['set-cookie'] ?? []);
  assert.equal(cookies.length, 2, `Set-Cookie가 둘이 아니다: ${JSON.stringify(cookies)}`);
  assert.ok(cookies.some((v) => v.startsWith(`${PARTNER_AT}=`)), '액세스 쿠키가 없다');
  assert.ok(cookies.some((v) => v.startsWith(`${PARTNER_RT}=`)), '리프레시 쿠키가 없다');
  for (const v of cookies) assert.match(v, /HttpOnly/i, `HttpOnly가 없다: ${v}`);
  assert.equal(r.headers['cache-control'], 'no-store', 'Cache-Control: no-store가 아니다');
  // 본문은 대역 echo의 method·path·headers뿐이고 토큰이 없다
  const body = JSON.parse(r.text);
  assert.equal(body.accessToken, undefined);
  assert.equal(body.refreshToken, undefined);
  assert.ok(!/accessToken|refreshToken|__Host-peaket_ops_at/.test(r.text));
});

test('BOT-140 gw-ops 원본 확인이 없거나 틀리면 허용 IP여도 403이고, /internal 404가 먼저다', async () => {
  const ip = ALLOWED;
  const viewer = ALLOWED;
  const bearer = { authorization: `Bearer ${opsToken()}` };
  const missing = await send(c, 'ops-api', { method: 'GET', path: '/v1/ops/commands', headers: { 'x-forwarded-for': ip, 'cloudfront-viewer-address': `${viewer}:443`, ...bearer } });
  assertForbidden(missing, '원본 확인 없음');
  const wrong = await send(c, 'ops-api', { method: 'GET', path: '/v1/ops/commands', headers: { 'x-peaket-origin-verify': 'wrong', 'x-forwarded-for': ip, 'cloudfront-viewer-address': `${viewer}:443`, ...bearer } });
  assertForbidden(wrong, '원본 확인 틀림');
  const internal = await send(c, 'ops-api', { method: 'GET', path: '/internal/e2e-admin-auth', headers: { 'x-forwarded-for': ip, 'cloudfront-viewer-address': `${viewer}:443`, ...bearer } });
  assert.equal(internal.status, 404, `원본 확인보다 /internal 404가 먼저가 아니다: ${internal.status}`);
  assert.deepEqual(JSON.parse(internal.text), { type: 'about:blank', title: 'Not Found', status: 404 });
});

test('BOT-140 허용 IP 목록 안이면 통과하고, 목록 밖·머리 없음·형식 오류·IPv6는 403이며 x-forwarded-for를 꾸며도 통과하지 못한다', async () => {
  const path = '/v1/ops/commands';
  const bearer = () => ({ authorization: `Bearer ${opsToken()}` });
  const allowed = await send(c, 'ops-api', { method: 'GET', path, headers: edge(c, ALLOWED, bearer(), ALLOWED) });
  assert.equal(allowed.status, 200, `목록 안 주소가 막혔다: ${allowed.status} ${allowed.text.slice(0, 200)}`);
  assert.equal(echoed(allowed)['x-user-id'].length > 0, true);

  const denied = await send(c, 'ops-api', { method: 'GET', path, headers: edge(c, DENIED, bearer(), DENIED) });
  assertForbidden(denied, '목록 밖');
  const manual = (viewer, xff) => ({ 'x-peaket-origin-verify': c.originVerify, 'x-forwarded-for': xff, ...(viewer === undefined ? {} : { 'cloudfront-viewer-address': viewer }), ...bearer() });
  assertForbidden(await send(c, 'ops-api', { method: 'GET', path, headers: manual(undefined, ALLOWED) }), 'Viewer 머리 없음');
  assertForbidden(await send(c, 'ops-api', { method: 'GET', path, headers: manual('not-an-ip:443', ALLOWED) }), '형식 오류');
  assertForbidden(await send(c, 'ops-api', { method: 'GET', path, headers: manual('[2001:db8::1]:443', ALLOWED) }), 'IPv6');
  assertForbidden(await send(c, 'ops-api', { method: 'GET', path, headers: manual(`${DENIED}:443`, ALLOWED) }), 'x-forwarded-for만 목록 안');
});
