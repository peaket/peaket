// 생성 라우트의 인증 종류·백엔드·시간 상한·게이트웨이 오류 kind 시험(BUILD_ORDER HOT-410, 묶음 BAT-060 계획 15절 'BAT-055가 넘긴 것'의 K 재현 시험).
// 정본: docs/infra.md §4.1 '경로별 메서드·한도·게이트웨이 오류'의 '인증 종류 대조'·'경로별 시간 상한'·'게이트웨이 오류의 Problem', docs/security/authz-matrix.md §5.1.
// BAT-055의 손님 쪽 도구(gateway-client.mjs)와 접속 정보를 그대로 쓴다(이 파일이 더하는 접속 정보 칸은 없다).
// 대역 백엔드(gateway-echo.mjs)에 더하는 응답 고르기(시험이 정한 약속, 바꾸려면 계획 파일 '시험 이의'): 요청 머리 `x-e2e-delay-ms: <밀리초>`가 있으면
//   그만큼 기다린 뒤 답한다(W7-CON-02 경로별 시간 상한. 없으면 구현 담당이 더한다).
// 차례: W7-WIR-01(합치기 조건, 높음)이 맨 앞이다. 시간 상한 시험(W7-CON-02)은 요청 하나에 20~28초가 걸려 맨 끝이다.
// 실행(저장소 뿌리, Docker 차례 잠금을 잡고): PEAKET_CLUSTER=lane1-<이름> node tools/local/cluster.mjs up(포트 매핑을 거는 새 클러스터) 뒤 같은 환경 값으로
//   node tools/local/cluster.mjs gateways, 그다음 node --test tools/local/e2e/gateway-routes.e2e.mjs. 포트 전달은 띄우지 않고 Windows에서도 파일을 통째로 돈다
//   (kind 포트 매핑과 로컬 전용 NodePort Service로 127.0.0.1에 잇는다, docs/infra.md §4.1 '로컬 kind에서 이 PC로 잇는 법')
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { API_CSP, GATEWAYS, HSTS, accessToken, admissionToken, echoed, edge, loadContract, send, token } from './gateway-client.mjs';

const RUN = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const EVENT = `e2e-${RUN}`;
let c;
let n = 0;
const nextSub = () => `rt-${RUN}-${++n}`;
const nextIp = () => `203.0.113.${100 + (n++ % 100)}`;
const HEX32 = /^[0-9a-f]{32}$/;
const API_HOST_KEY = { 'gw-queue': 'queue', 'gw-fan': 'api', 'gw-partner': 'partner-api', 'gw-ops': 'ops-api', 'gw-scanner': 'scanner-api' };

before(() => {
  c = loadContract();
});

/** 게이트웨이가 만든 Problem(형식·본문·대역에 닿지 않음) */
function assertGatewayProblem(r, status, title, label) {
  assert.equal(r.status, status, `${label}: 상태 ${r.status} ${r.text.slice(0, 200)}`);
  assert.match(String(r.headers['content-type'] ?? ''), /^application\/problem\+json\b/, `${label}: 형식 ${r.headers['content-type']}`);
  assert.deepEqual(JSON.parse(r.text), { type: 'about:blank', title, status }, `${label}: 본문`);
  assert.throws(() => echoed(r), `${label}: 대역 백엔드에 닿았다`);
}

// ===================== W7-WIR-01(맨 앞) =====================

test('W7-WIR-01 Authorization 없이 DPoP 머리만 단 POST /v1/scanner/token은 401이 아니고 대역(identity-svc 자리)에 닿는다', async () => {
  const dpop = `eyJ0eXAiOiJkcG9wK2p3dCJ9.${RUN}.sig`;
  const r = await send(c, 'scanner-api', { method: 'POST', path: '/v1/scanner/token', headers: { 'x-forwarded-for': nextIp(), dpop, 'content-type': 'application/json', origin: c.origins.scanner }, body: '{}' });
  assert.notEqual(r.status, 401, `게이트웨이가 토큰을 요구했다: ${r.text.slice(0, 200)}`);
  const h = echoed(r);
  assert.equal(h.dpop, dpop, 'DPoP 머리가 백엔드에 그대로 닿지 않았다');
  assert.equal(h['x-user-id'], undefined, '토큰 없는 요청에 신원 머리가 실렸다');
});

// ===================== 대조 리뷰 RV-03·RV-04(W7-WIR-01 바로 다음) =====================

test('RV-03 OPTIONS /v1/webhooks/toss(화면 출처의 사전 요청 꼴)는 게이트웨이 404 Problem이고 대역에 닿지 않으며 CORS 허용 머리가 없다', async () => {
  const r = await send(c, 'partner-api', { method: 'OPTIONS', path: '/v1/webhooks/toss', headers: edge(c, nextIp(), { origin: c.origins.partner, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }) });
  assertGatewayProblem(r, 404, 'Not Found', 'OPTIONS /v1/webhooks/toss');
  assert.equal(r.headers['access-control-allow-origin'], undefined, '외부 수신 경로가 CORS 허용을 낸다');
});

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const minuteOf = (t = Date.now()) => Math.floor(t / 60_000);
/** 분의 50초가 지났으면 다음 분까지 기다린다(계정당 60회/분 창, BAT-060 계획 §6) */
async function windowStart() {
  const s = new Date().getUTCSeconds() + new Date().getUTCMilliseconds() / 1000;
  if (s > 50) await sleep((60 - s) * 1000 + 300);
  return minuteOf();
}

test('RV-04 D-T50 ① 한 계정의 후기 읽기(GET /v1/reviews/{reviewId}, optional 라우트)도 같은 버킷에 세어 gw-fan-api(GET /v1/tickets)와 섞은 61번째가 429다', async () => {
  const minute = await windowStart();
  const sub = nextSub();
  const ip = '198.51.100.97';
  const rs = [];
  for (let i = 0; i <= 60; i++) rs.push(await send(c, 'api', { path: i % 2 ? `/v1/reviews/r-${RUN}` : '/v1/tickets', headers: edge(c, ip, { authorization: `Bearer ${accessToken(c, 'gw-fan', sub)}` }) }));
  assert.equal(minuteOf(), minute, '분 창 경계를 넘었다(다시 하지 않고 실패로 본다)');
  rs.slice(0, 60).forEach((r, i) => assert.ok(r.status < 400, `${i + 1}번째: ${r.status} ${r.text.slice(0, 200)}`));
  assertGatewayProblem(rs[60], 429, 'Too Many Requests', '61번째');
});

test('RV-04 토큰 없는 후기 읽기(GET /v1/reviews/{reviewId}) 61번은 모두 통과한다(X-User-Id가 없어 세지 않는다)', async () => {
  const minute = await windowStart();
  const rs = [];
  for (let i = 0; i <= 60; i++) rs.push(await send(c, 'api', { path: `/v1/reviews/r-${RUN}-${i}`, headers: edge(c, '198.51.100.98') }));
  assert.equal(minuteOf(), minute, '분 창 경계를 넘었다(다시 하지 않고 실패로 본다)');
  rs.forEach((r, i) => {
    assert.ok(r.status < 400, `${i + 1}번째: ${r.status} ${r.text.slice(0, 200)}`);
    assert.equal(echoed(r)['x-user-id'], undefined, `${i + 1}번째: 신원 머리가 실렸다`);
  });
});

// ===================== 인증 종류(W7-COR-04 · W7-WIR-05 · RV-04) =====================

test('W7-COR-04 ticket:buy 없는 토큰의 GET /v1/orders·GET /v1/orders/{orderId}·GET …/payment-status는 대역에 닿고, 같은 토큰의 POST /v1/orders는 403이다', async () => {
  const sub = nextSub();
  const tv = token(c, 'fan', { sub, sid: `s-${sub}`, aud: 'fan', scope: 'profile', pid: `p-${sub}` });
  for (const path of ['/v1/orders', `/v1/orders/o-${RUN}`, `/v1/orders/o-${RUN}/payment-status`]) {
    const r = await send(c, 'api', { path, headers: edge(c, nextIp(), { authorization: `Bearer ${tv}` }) });
    assert.ok(r.status < 400, `GET ${path}: ${r.status} ${r.text.slice(0, 200)}`);
    assert.equal(echoed(r)['x-user-id'], sub);
  }
  // 구매 경로라 맞는 입장 토큰을 싣는다(BAT-057, docs/infra.md §4.1 '입장 토큰 확인'): 없으면 인가(ticket:buy)보다 앞의 입장 토큰 확인이 401로 끊는다
  const buy = await send(c, 'api', { method: 'POST', path: '/v1/orders', headers: edge(c, nextIp(), { authorization: `Bearer ${tv}`, origin: c.origins.www, 'content-type': 'application/json', 'x-admission-token': admissionToken(c, { event: EVENT }) }), body: '{}' });
  assert.equal(buy.status, 403, `ticket:buy 없는 POST /v1/orders: ${buy.status}`);
});

test('W7-WIR-05 토큰 없이 POST /v1/partner/auth/invitation-acceptances는 대역에 닿는다', async () => {
  const r = await send(c, 'partner-api', { method: 'POST', path: '/v1/partner/auth/invitation-acceptances', headers: edge(c, nextIp(), { origin: c.origins.partner, 'content-type': 'application/json' }), body: '{}' });
  assert.ok(r.status < 400, `토큰 없는 초대 수락: ${r.status} ${r.text.slice(0, 200)}`);
  // echoed()는 대역이 받은 머리만 돌려준다. 경로는 대역 응답 본문(JSON)의 path로 본다(BAT-060 '판단: 구현 kind 확인 둘째' 2 (가))
  echoed(r);
  assert.equal(JSON.parse(r.text).path, '/v1/partner/auth/invitation-acceptances');
  assert.equal(echoed(r)['x-user-id'], undefined, '토큰 없는 요청에 신원 머리가 실렸다');
});

test('RV-04 토큰 없는 GET /v1/events/{event}·review-summary는 401이 아니고 대역에 닿으며, GET …/reviews는 토큰이 없으면 닿고 틀린 토큰이면 401이다', async () => {
  for (const path of [`/v1/events/${EVENT}`, `/v1/events/${EVENT}/review-summary`, `/v1/events/${EVENT}/reviews`]) {
    const r = await send(c, 'api', { path, headers: edge(c, nextIp()) });
    assert.ok(r.status < 400, `토큰 없는 GET ${path}: ${r.status} ${r.text.slice(0, 200)}`);
    echoed(r);
  }
  // optional: 토큰이 오면 확인한다
  const bad = await send(c, 'api', { path: `/v1/events/${EVENT}/reviews`, headers: edge(c, nextIp(), { authorization: 'Bearer not-a-jwt' }) });
  assert.equal(bad.status, 401, `틀린 토큰의 GET …/reviews: ${bad.status}`);
  const ok = await send(c, 'api', { path: `/v1/events/${EVENT}/reviews`, headers: edge(c, nextIp(), { authorization: `Bearer ${accessToken(c, 'gw-fan', nextSub())}` }) });
  assert.ok(ok.status < 400, `맞는 토큰의 GET …/reviews: ${ok.status}`);
  assert.ok(echoed(ok)['x-user-id'], '맞는 토큰인데 신원 머리가 없다');
});

// ===================== 게이트웨이 오류 403·405(W7-WIR-08 · W7-SEC-04) =====================

test('W7-WIR-08 ticket:buy 없는 토큰의 입장 확정 403 본문은 application/problem+json·about:blank·Forbidden이다', async () => {
  const sub = nextSub();
  const tv = token(c, 'fan', { sub, sid: `s-${sub}`, aud: 'fan', scope: 'profile', pid: `p-${sub}` });
  const r = await send(c, 'queue', { method: 'POST', path: `/v1/queues/${EVENT}/admission`, body: '{}', headers: edge(c, nextIp(), { origin: c.origins.www, 'content-type': 'text/plain;charset=UTF-8', cookie: `__Secure-peaket_at=${tv}` }) });
  assertGatewayProblem(r, 403, 'Forbidden', '입장 확정 403');
});

test('[ASVS v5.0.0-3.4.1] [ASVS v5.0.0-3.4.4] W7-SEC-04 다섯 게이트웨이의 TRACE 405와 없는 경로 404에 HSTS·nosniff·기본 CSP가 있고 본문이 about:blank Problem이다', async () => {
  for (const gw of GATEWAYS) {
    const host = API_HOST_KEY[gw];
    const p = c.probes[gw];
    const cases = [
      [await send(c, host, { method: 'TRACE', path: p.path.replaceAll('{event}', EVENT), headers: edge(c, nextIp()) }), 405, 'Method Not Allowed', 'TRACE'],
      [await send(c, host, { path: `/v1/zz-no-such-${RUN}`, headers: edge(c, nextIp()) }), 404, 'Not Found', '없는 경로'],
    ];
    for (const [r, status, title, what] of cases) {
      const label = `${gw} ${what}`;
      assertGatewayProblem(r, status, title, label);
      assert.equal(r.headers['strict-transport-security'], HSTS, `${label}: HSTS`);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', `${label}: nosniff`);
      assert.equal(r.headers['content-security-policy'], API_CSP, `${label}: 기본 CSP`);
    }
  }
});

// ===================== 경로별 시간 상한(W7-CON-02, 맨 끝) =====================

/** 손님 쪽 시간 한도: 게이트웨이 상한(27초)보다 긴 응답을 기다린다(BAT-060 '판단: 구현 kind 확인 둘째' 2 (나), 60초 [가정]) */
const LONG_WAIT_MS = 60_000;

test('W7-CON-02 대역이 20초 뒤 답하는 GET /v1/orders/{orderId}/payment-status는 504 없이 200이고, 28초 뒤면 504다(27초 경계 양쪽). 관제 SSE 둘은 20초에도 200, 상한을 바꾸지 않은 경로는 15초 기본으로 504다', async () => {
  const sub = nextSub();
  const path = `/v1/orders/o-${RUN}/payment-status`;
  const hdr = (ms) => edge(c, nextIp(), { authorization: `Bearer ${accessToken(c, 'gw-fan', sub)}`, 'x-e2e-delay-ms': String(ms) });
  const t0 = Date.now();
  const slow = await send(c, 'api', { path, headers: hdr(20_000), timeoutMs: LONG_WAIT_MS });
  const took = Date.now() - t0;
  // 상태를 먼저 본다: 504면 시간 상한 탓이고(실패 글이 바탕 탓으로 읽히지 않게, 검증 VF-D17), 200인데 19초 전에 끝났으면 대역 지연 고르기 탓이다
  assert.equal(slow.status, 200, `20초 지연: 상태 ${slow.status}(${took}ms 만에 끝남, 27초 상한이 걸리지 않았다) ${slow.text.slice(0, 200)}`);
  assert.ok(took >= 19_000, `대역 지연 고르기(x-e2e-delay-ms)가 듣지 않는다(상태 ${slow.status}, ${took}ms 만에 끝남)`);
  echoed(slow);
  const over = await send(c, 'api', { path, headers: hdr(28_000), timeoutMs: LONG_WAIT_MS });
  assert.equal(over.status, 504, `28초: ${over.status}(27초 상한이 걸리지 않았다)`);
  // 시간 상한을 바꾸지 않은 경로는 Envoy 기본(15초)이다: 같은 20초 지연이 504다(상한을 모든 규칙에 넓힌 결함을 잡는다)
  const other = await send(c, 'api', { path: `/v1/orders/o-${RUN}`, headers: hdr(20_000), timeoutMs: LONG_WAIT_MS });
  assert.equal(other.status, 504, `GET /v1/orders/{orderId} 20초: ${other.status}(기본 상한 15초가 아니다)`);
  // 관제 SSE 두 흐름(getOpsLive·getOpsEventLive)은 상한을 끈다(0s): 20초 지연도 200이다(구현 담당이 kind에서 본 결과를 사례로 둔다)
  const ops = (ms) => edge(c, nextIp(), { authorization: `Bearer ${accessToken(c, 'gw-ops', nextSub())}`, 'x-e2e-delay-ms': String(ms) });
  for (const p of ['/v1/ops/live', `/v1/ops/events/${EVENT}/live`]) {
    const r = await send(c, 'ops-api', { path: p, headers: ops(20_000), timeoutMs: LONG_WAIT_MS });
    assert.equal(r.status, 200, `${p} 20초: ${r.status} ${r.text.slice(0, 200)}(SSE 상한이 꺼지지 않았다)`);
    echoed(r);
  }
});
