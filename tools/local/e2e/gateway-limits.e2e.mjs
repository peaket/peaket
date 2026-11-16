// 게이트웨이의 경로별 메서드·한도·오류 kind 통합 시험(BUILD_ORDER HOT-410, 묶음 BAT-060 계획 §6의 'K' 층, D-T42 ③④·D-T43 ①~④·D-T50 ①~④·⑥).
// 정본: docs/infra.md §4.1 '경로별 메서드·한도·게이트웨이 오류', docs/devops.md §14 D-T42·D-T43·D-T50, docs/api/guidelines.md §2·§6·§9.
// BAT-055의 손님 쪽 도구(gateway-client.mjs)를 다시 쓴다. 시험 값(60회/분, 웹훅 초당 100건, 65,536바이트, Max-Age 7200, 상태 문구)은 정본 값을 직접 적는다.
//
// 이 묶음이 접속 정보(.cache/peaket-tools/gateways-e2e.json, gateway-client.mjs 머리의 약속)에 더하는 칸(구현 담당이 cluster.mjs gateways로 채운다.
// 이름·모양을 바꾸려면 계획 파일 '시험 이의'에 적는다):
//   "rateLimit":      { "namespace": 레이트 리밋 서비스 네임스페이스, "deployment": 그 Deployment 이름 }      // D-T50 ③이 복제를 0으로 줄였다 되돌린다
//   "rateLimitRedis": { "namespace": …, "target": "deploy/<이름>" 또는 "pod/<이름>", "container": (있으면) 컨테이너 이름,
//                       "cli": TLS로 붙는 명령 앞부분(예: ["valkey-cli","--tls","--cacert","/tls/ca.crt","-p","6379"]),
//                       "plainCli": 같은 포트에 평문으로 붙는 명령 앞부분(예: ["valkey-cli","-p","6379"]) }   // D-T50 ④가 키 접두사·TLS만 받는지 본다
//   "replicas":       { "gw-partner": 로컬 덧씌우기의 프록시 복제 수 }                                     // 없으면 1(웹훅 IP 한도는 파드마다 센다)
//   "stats":          { "port": 프록시 통계 포트, "path": 통계 경로 }                                     // 없으면 19001·/stats/prometheus(Envoy Gateway 기본)
// 대역 백엔드(gateway-echo.mjs)에 더하는 응답 고르기: 요청 머리 `x-e2e-problem-status: <상태>`가 있으면 그 상태와 `application/problem+json` 본문
//   {"type":"https://peaket.example/problems/e2e-backend","title":"E2E Backend","status":<상태>,"traceId":<받은 traceparent의 trace-id>}를 돌려준다
//   (서비스 템플릿 Problem의 traceId와 같은 규칙, docs/api/guidelines.md §2. 경로는 가리지 않는다: 생성 라우트는 계약 경로만 넘기므로 시험만의 경로를 두지 않는다).
// 시험 계정의 토큰은 접속 정보의 시험 키로 시험이 만든다(토큰 칸은 쓰지 않는다).
//
// 차례: 파일의 시험 차례대로 돈다. 1분 창 시험(D-T50 ①②④)은 분의 50초가 지났으면 다음 분까지 기다렸다 시작하고, 창 경계를 넘으면 다시 하지 않고 실패로 본다.
// 레이트 리밋 서비스 복제 0(D-T50 ③)은 맨 끝이고 끝나면 복제를 되돌린다. PoC(D-T43 ④)는 정책을 잠깐 바꿨다 되돌린다.
// 실행(저장소 뿌리, Docker 차례 잠금을 잡고): PEAKET_CLUSTER=lane1-<이름> node tools/local/cluster.mjs gateways, 같은 환경 값으로 gateways-forward를 띄운 채
//   node --test tools/local/e2e/gateway-limits.e2e.mjs
// 끝나면 클러스터를 지우고(kind delete cluster), 시험이 만든 컨테이너는 docker rm -f -v로 지우고 잠금 폴더를 지운다(PROGRESS 턴 규칙 'Docker 차례', R-644).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kubectl } from '../cluster.mjs';
import { accessToken, echoed, edge, loadContract, pool, send } from './gateway-client.mjs';

const RUN = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
let c;
let n = 0;
const nextSub = () => `lim-${RUN}-${++n}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEX32 = /^[0-9a-f]{32}$/;
const NS = () => c.logs?.namespace ?? 'envoy-gateway-system';

// ---- 정본 값 ----
/** 게이트웨이가 만든 응답의 상태 문구(docs/infra.md §4.1 '게이트웨이 오류의 Problem') */
const TITLE = { 404: 'Not Found', 413: 'Content Too Large', 429: 'Too Many Requests', 503: 'Service Unavailable' };
const API_HOST_KEY = { 'gw-queue': 'queue', 'gw-fan': 'api', 'gw-partner': 'partner-api', 'gw-ops': 'ops-api', 'gw-scanner': 'scanner-api' };
const FAN_LIMIT_PER_MINUTE = 60;
const WEBHOOK_PER_SECOND = 100;
const WEBHOOK_BODY_BYTES = 65536;
const MAX_AGE = '7200';
/** partner-api의 POST만 받는 계약 경로(openapi), 그 둘(gw-fan-api·gw-fan-identity)의 GET 경로 */
const PARTNER_POST_ONLY = () => `/v1/partner/productions/p-${RUN}/events`;
const FAN_API_PATH = '/v1/tickets';
const FAN_IDENTITY_PATH = '/v1/identity/me';
const BACKEND_PROBLEM_TYPE = 'https://peaket.example/problems/e2e-backend';

before(() => {
  c = loadContract();
  for (const k of ['rateLimit', 'rateLimitRedis']) if (c[k] === undefined) throw new Error(`접속 정보에 ${k}가 없다(BAT-060 계획 §5, 이 파일 머리의 약속)`);
  for (const k of ['namespace', 'deployment']) if (!c.rateLimit[k]) throw new Error(`접속 정보 rateLimit.${k}가 없다`);
  for (const k of ['namespace', 'target', 'cli', 'plainCli']) if (!c.rateLimitRedis[k]) throw new Error(`접속 정보 rateLimitRedis.${k}가 없다`);
});

const temps = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** 게이트웨이가 만든 Problem 응답을 본다: 형식, 본문 칸, X-Trace-Id, 대역 백엔드에 닿지 않음 */
function assertGatewayProblem(r, status, label) {
  assert.equal(r.status, status, `${label}: 상태 ${r.status} ${r.text.slice(0, 200)}`);
  assert.match(String(r.headers['content-type'] ?? ''), /^application\/problem\+json\b/, `${label}: 형식 ${r.headers['content-type']}`);
  let body;
  assert.doesNotThrow(() => (body = JSON.parse(r.text)), `${label}: 본문이 JSON이 아니다 ${r.text.slice(0, 200)}`);
  assert.deepEqual(body, { type: 'about:blank', title: TITLE[status], status }, `${label}: 본문`);
  assert.match(String(r.headers['x-trace-id'] ?? ''), HEX32, `${label}: X-Trace-Id ${r.headers['x-trace-id']}`);
  assert.throws(() => echoed(r), `${label}: 대역 백엔드에 닿았다`);
}

/** 분의 몇 초인가(레이트 리밋 서비스의 분 창은 시계의 분에 맞춰 열린다) */
const secondOfMinute = () => new Date().getUTCSeconds() + new Date().getUTCMilliseconds() / 1000;
const minuteOf = (t = Date.now()) => Math.floor(t / 60_000);
/** 분의 latest초가 지났으면 다음 분까지 기다린다(기본 50초: 최대 10초 기다림, 계획 §6) */
async function windowStart(latest = 50) {
  const s = secondOfMinute();
  if (s > latest) await sleep((60 - s) * 1000 + 300);
  return minuteOf();
}

const fanHeaders = (sub, ip, extra = {}) => edge(c, ip, { authorization: `Bearer ${accessToken(c, 'gw-fan', sub)}`, ...extra });

// ===================== 경로별 메서드(D-T42 ③④) =====================

test('D-T42 ③ partner-api의 POST만 받는 경로에 화면 출처로 보낸 사전 요청은 Access-Control-Allow-Origin(partner 화면 하나)·Allow-Credentials·Max-Age 7200을 받고 백엔드에 닿지 않는다', async () => {
  const r = await send(c, 'partner-api', {
    method: 'OPTIONS',
    path: PARTNER_POST_ONLY(),
    headers: edge(c, '203.0.113.41', { origin: c.origins.partner, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }),
  });
  // 정본 D-T42 ③은 204다. Envoy CORS 필터는 사전 요청에 200으로 답할 수 있어 BAT-055 Q-T41 ②와 같이 둘을 받는다(리뷰가 판단할 차이)
  assert.ok(r.status === 204 || r.status === 200, `사전 요청: ${r.status} ${r.text.slice(0, 200)}`);
  assert.equal(r.headers['access-control-allow-origin'], c.origins.partner);
  assert.equal(r.headers['access-control-allow-credentials'], 'true');
  assert.equal(r.headers['access-control-max-age'], MAX_AGE);
  assert.match(String(r.headers['access-control-allow-methods'] ?? ''), /\bPOST\b/);
  assert.throws(() => echoed(r), '사전 요청이 대역 백엔드에 닿았다');
});

test('D-T42 ④ 같은 경로에 GET·PUT·DELETE·PATCH를 보내면 게이트웨이가 404 Problem으로 끝내고 대역 백엔드가 요청을 받지 않으며, POST는 닿는다', async () => {
  const sub = nextSub();
  const auth = { authorization: `Bearer ${accessToken(c, 'gw-partner', sub)}`, origin: c.origins.partner, 'content-type': 'application/json' };
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    const r = await send(c, 'partner-api', { method, path: PARTNER_POST_ONLY(), headers: edge(c, '203.0.113.42', auth), body: method === 'GET' || method === 'DELETE' ? undefined : '{}' });
    assertGatewayProblem(r, 404, `${method} ${PARTNER_POST_ONLY()}`);
  }
  const ok = await send(c, 'partner-api', { method: 'POST', path: PARTNER_POST_ONLY(), headers: edge(c, '203.0.113.42', auth), body: '{}' });
  assert.ok(ok.status < 400, `POST: ${ok.status} ${ok.text.slice(0, 200)}`);
  assert.equal(echoed(ok)['x-user-id'], sub, 'POST가 토큰을 확인한 뒤 백엔드에 닿는다');
});

// ===================== 게이트웨이 오류와 추적 머리(D-T43 ①~③) =====================

test('D-T43 ① 없는 경로 404(다섯 게이트웨이 각각)·본문 상한 413·레이트 리밋 429는 application/problem+json이고 type about:blank·status·title(상태 문구)만 있으며 X-Trace-Id가 32자리 16진수다', async () => {
  for (const [gw, host] of Object.entries(API_HOST_KEY)) {
    const r = await send(c, host, { path: `/v1/zz-no-such-${RUN}`, headers: edge(c, '203.0.113.43') });
    assertGatewayProblem(r, 404, `${gw} 없는 경로`);
  }
  // 413: 웹훅 본문 65,536 + 1바이트
  const big = await send(c, 'partner-api', { method: 'POST', path: '/v1/webhooks/portone', headers: edge(c, '203.0.113.44', { 'content-type': 'application/json' }), body: 'a'.repeat(WEBHOOK_BODY_BYTES + 1) });
  assertGatewayProblem(big, 413, '웹훅 65,537바이트');
  // 429: 한 IP로 웹훅에 한도를 넘겨 보낸다
  const flood = await pool(400, 50, () => send(c, 'partner-api', { method: 'POST', path: '/v1/webhooks/toss', headers: edge(c, '198.51.100.93', { 'content-type': 'application/json' }), body: '{}' }));
  const limited = flood.filter((r) => r.status === 429);
  assert.ok(limited.length > 0, '웹훅 400건에 429가 없다');
  assertGatewayProblem(limited[0], 429, '웹훅 IP 한도 429');
  assert.match(String(limited[0].headers['retry-after'] ?? ''), /^\d+$/, '429의 Retry-After');
});

test('D-T43 ② 대역 백엔드가 낸 409는 본문 그대로이고 본문 traceId와 X-Trace-Id가 같으며, 백엔드가 낸 404·429·503 Problem도 게이트웨이 본문으로 덮이지 않는다', async () => {
  for (const status of [409, 404, 429, 503]) {
    const sub = nextSub();
    const r = await send(c, 'api', { path: FAN_IDENTITY_PATH, headers: fanHeaders(sub, '203.0.113.45', { 'x-e2e-problem-status': String(status) }) });
    assert.equal(r.status, status, `백엔드 ${status}: ${r.status} ${r.text.slice(0, 200)}`);
    assert.match(String(r.headers['content-type'] ?? ''), /^application\/problem\+json\b/, `백엔드 ${status}: 형식`);
    const body = JSON.parse(r.text);
    assert.equal(body.type, BACKEND_PROBLEM_TYPE, `백엔드 ${status}: 게이트웨이가 본문을 바꿨다 ${r.text}`);
    assert.equal(body.status, status);
    assert.match(String(body.traceId ?? ''), HEX32, `백엔드 ${status}: 본문 traceId`);
    assert.equal(r.headers['x-trace-id'], body.traceId, `백엔드 ${status}: X-Trace-Id와 본문 traceId가 다르다`);
  }
});

test('D-T43 ③ CDN 캐시 공개 읽기(홈·검색·자동완성)를 두 번 받아도 X-Trace-Id가 없고, 캐시하지 않는 읽기에는 있다', async () => {
  let ip = 60;
  for (const path of ['/v1/home', `/v1/search?q=e2e${RUN}`, `/v1/search/suggestions?q=e2e${RUN}`]) {
    for (let i = 0; i < 2; i++) {
      const r = await send(c, 'api', { path, headers: edge(c, `203.0.113.${ip++}`) });
      assert.ok(r.status < 400, `${path} ${i + 1}번째: ${r.status} ${r.text.slice(0, 200)}`);
      echoed(r);
      assert.equal(r.headers['x-trace-id'], undefined, `${path} ${i + 1}번째: X-Trace-Id ${r.headers['x-trace-id']}`);
    }
  }
  // 비교: 개인 읽기에는 붙는다(아무 응답에도 X-Trace-Id가 없어서 통과하는 일을 막는다)
  const me = await send(c, 'api', { path: FAN_IDENTITY_PATH, headers: fanHeaders(nextSub(), `203.0.113.${ip++}`) });
  assert.ok(me.status < 400, `${FAN_IDENTITY_PATH}: ${me.status}`);
  assert.match(String(me.headers['x-trace-id'] ?? ''), HEX32, `${FAN_IDENTITY_PATH}: X-Trace-Id ${me.headers['x-trace-id']}`);
  assert.equal(me.headers['x-trace-id'], /^00-([0-9a-f]{32})-/.exec(echoed(me).traceparent ?? '')?.[1], 'X-Trace-Id가 백엔드가 받은 trace-id와 다르다');
});

// ===================== 웹훅 출발지 한도(D-T50 ⑥)와 본문 상한 =====================

test('D-T50 ⑥ 한 IP로 /v1/webhooks/toss에 초당 100건을 넘기면 429이고 대역 백엔드는 넘은 요청을 받지 않으며 다른 IP는 통과한다(IPv4·IPv6 각각)', async () => {
  const replicas = Number(c.replicas?.['gw-partner'] ?? 1);
  for (const [ip, other] of [
    ['198.51.100.91', '198.51.100.92'],
    ['2001:db8:91::1', '2001:db8:92::1'],
  ]) {
    const t0 = Date.now();
    const results = await pool(400, 50, () => send(c, 'partner-api', { method: 'POST', path: '/v1/webhooks/toss', headers: edge(c, ip, { 'content-type': 'application/json' }), body: '{}' }));
    const seconds = (Date.now() - t0) / 1000;
    const passed = results.filter((r) => r.status !== 429);
    const limited = results.filter((r) => r.status === 429);
    assert.ok(limited.length > 0, `${ip}: 400건(${seconds.toFixed(1)}초)에 429가 없다`);
    for (const r of limited) assert.throws(() => echoed(r), `${ip}: 429가 대역 백엔드 응답이다`);
    for (const r of passed) {
      assert.ok(r.status < 400, `${ip}: 한도 안 요청이 ${r.status}`);
      assert.equal(echoed(r).path, '/v1/webhooks/toss', `${ip}: 한도 안 요청이 백엔드에 닿지 않았다`);
    }
    // 처음 모아 둔 100건 + 지난 시간만큼 채운 초당 100건(올림)을 파드마다 넘겨 통과하지 않는다
    assert.ok(passed.length <= WEBHOOK_PER_SECOND * (1 + Math.ceil(seconds)) * replicas, `${ip}: 통과 ${passed.length}건 > 100 × (1 + ${Math.ceil(seconds)}) × ${replicas}`);
    assert.ok(passed.length >= WEBHOOK_PER_SECOND, `${ip}: 초당 100건보다 적게 통과했다(${passed.length})`);
    const o = await send(c, 'partner-api', { method: 'POST', path: '/v1/webhooks/toss', headers: edge(c, other, { 'content-type': 'application/json' }), body: '{}' });
    assert.ok(o.status < 400, `${other}: 다른 IP까지 막았다(${o.status})`);
    echoed(o);
  }
});

test("HOT-410 infra §4.1 '웹훅 경로' /v1/webhooks/portone에 64KB(65,536바이트) 본문은 그대로 닿고 65,537바이트는 413 Problem이며, 웹훅은 토큰 없이 닿는다", async () => {
  const ok = await send(c, 'partner-api', { method: 'POST', path: '/v1/webhooks/portone', headers: edge(c, '203.0.113.46', { 'content-type': 'application/json' }), body: 'a'.repeat(WEBHOOK_BODY_BYTES) });
  assert.ok(ok.status < 400, `65,536바이트: ${ok.status} ${ok.text.slice(0, 200)}`);
  assert.equal(JSON.parse(ok.text).bodyBytes, WEBHOOK_BODY_BYTES, '본문이 다 닿지 않았다');
  assert.equal(echoed(ok)['x-user-id'], undefined, '웹훅 요청에 신원 머리가 실렸다');
  const over = await send(c, 'partner-api', { method: 'POST', path: '/v1/webhooks/portone', headers: edge(c, '203.0.113.47', { 'content-type': 'application/json' }), body: 'a'.repeat(WEBHOOK_BODY_BYTES + 1) });
  assertGatewayProblem(over, 413, '65,537바이트');
});

// ===================== 전역 레이트 리밋(D-T50 ①②④) =====================

/** 한 계정이 두 경로를 섞어 count번 부른다(차례대로) */
async function mixed(sub, ip, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(await send(c, 'api', { path: i % 2 ? FAN_IDENTITY_PATH : FAN_API_PATH, headers: fanHeaders(sub, ip) }));
  return out;
}
let blockedSub;
let blockedMinute;
const SHARED_IP = '198.51.100.95';

test('D-T50 ① 한 계정이 gw-fan-api·gw-fan-identity 두 경로를 섞어 1분에 61번 부르면 앞 60번은 통과하고 61번째는 429·Retry-After·about:blank Problem이다', async () => {
  const minute = await windowStart();
  const sub = nextSub();
  const rs = await mixed(sub, SHARED_IP, FAN_LIMIT_PER_MINUTE + 1);
  assert.equal(minuteOf(), minute, '분 창 경계를 넘었다(다시 하지 않고 실패로 본다)');
  rs.slice(0, FAN_LIMIT_PER_MINUTE).forEach((r, i) => {
    assert.ok(r.status < 400, `${i + 1}번째(${i % 2 ? FAN_IDENTITY_PATH : FAN_API_PATH}): ${r.status} ${r.text.slice(0, 200)}`);
    assert.equal(echoed(r)['x-user-id'], sub);
  });
  const last = rs[FAN_LIMIT_PER_MINUTE];
  assertGatewayProblem(last, 429, '61번째');
  assert.match(String(last.headers['retry-after'] ?? ''), /^\d+$/, '61번째의 Retry-After');
  blockedSub = sub;
  blockedMinute = minute;
});

test('D-T50 ② ①로 막힌 창에서 같은 클라이언트 IP의 다른 계정은 통과하고 막힌 계정은 두 경로 모두 막힌다', async () => {
  assert.ok(blockedSub, 'D-T50 ①이 막힌 계정을 남기지 않았다');
  const other = await send(c, 'api', { path: FAN_API_PATH, headers: fanHeaders(nextSub(), SHARED_IP) });
  const again = [];
  for (const path of [FAN_IDENTITY_PATH, FAN_API_PATH]) again.push([path, await send(c, 'api', { path, headers: fanHeaders(blockedSub, SHARED_IP) })]);
  assert.equal(minuteOf(), blockedMinute, '분 창 경계를 넘었다(다시 하지 않고 실패로 본다)');
  assert.ok(other.status < 400, `같은 IP의 다른 계정: ${other.status}`);
  assert.equal(echoed(other)['x-user-id'] === blockedSub, false, '다른 계정의 요청이 막힌 계정으로 닿았다');
  for (const [path, r] of again) assert.equal(r.status, 429, `막힌 계정의 ${path}: ${r.status}`);
});

/** 레이트 리밋 Redis에서 명령 하나(TLS 접속) */
const redis = (args, cli = c.rateLimitRedis.cli) => kubectl(['-n', c.rateLimitRedis.namespace, 'exec', c.rateLimitRedis.target, ...(c.rateLimitRedis.container ? ['-c', c.rateLimitRedis.container] : []), '--', ...cli, ...args], { quiet: true, timeout: 30_000 });

test('D-T50 ④ kind의 레이트 리밋 서비스는 TLS만 받는 Valkey에 붙어 판정하고 카운터 키가 rl:로 시작하며 수명이 분 창(60초) 안이다', async () => {
  assert.ok(blockedSub, 'D-T50 ①이 막힌 계정을 남기지 않았다(판정 기록이 없다)');
  const keys = (await redis(['--scan', '--pattern', '*']))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  assert.ok(keys.length > 0, '레이트 리밋 Redis에 키가 없다(판정이 Redis에 닿지 않았다)');
  for (const k of keys) assert.ok(k.startsWith('rl:'), `접두사 rl: 밖의 키: ${k}`);
  const mine = keys.filter((k) => k.includes(blockedSub));
  assert.ok(mine.length > 0, `막힌 계정(${blockedSub})의 카운터 키가 없다: ${keys.slice(0, 5)}`);
  for (const k of mine) {
    const ttl = Number((await redis(['TTL', k])).trim());
    assert.ok(ttl > 0 && ttl <= 60, `${k}: 수명 ${ttl}초(분 창 밖)`);
  }
  // 평문으로는 붙지 못한다(TLS만 받는다)
  let plain = '';
  try {
    plain = await redis(['PING'], c.rateLimitRedis.plainCli);
  } catch (e) {
    plain = String(e.stdout ?? '');
  }
  assert.doesNotMatch(plain, /PONG/, '평문 접속이 PONG을 받았다');
});

// ===================== 본문 traceId PoC(D-T43 ④) =====================

/** 쿠버네티스 객체를 임시 파일로 적용한다(Windows kubectl 표준 입력 잘림을 피한다) */
async function applyObject(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'gw-limits-'));
  temps.push(dir);
  const f = join(dir, 'obj.json');
  writeFileSync(f, JSON.stringify(obj));
  await kubectl(['apply', '-f', f], { quiet: true, timeout: 60_000 });
}
const clean = (o) => {
  const x = structuredClone(o);
  delete x.status;
  for (const k of ['resourceVersion', 'uid', 'creationTimestamp', 'generation', 'managedFields']) delete x.metadata?.[k];
  if (x.metadata?.annotations) delete x.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
  return x;
};
/** gw-scanner 게이트웨이에 건 responseOverride 정책(PoC는 이 하나만 바꾼다) */
async function scannerOverridePolicy() {
  const list = JSON.parse(await kubectl(['-n', NS(), 'get', 'backendtrafficpolicies', '-o', 'json'], { quiet: true, timeout: 30_000 }));
  const hits = list.items.filter((p) => (p.spec?.responseOverride ?? []).length && [...(p.spec?.targetRefs ?? []), ...(p.spec?.targetRef ? [p.spec.targetRef] : [])].some((t) => t.kind === 'Gateway' && t.name === 'gw-scanner'));
  assert.equal(hits.length, 1, `gw-scanner에 건 responseOverride 정책이 하나가 아니다(${hits.length})`);
  return hits[0];
}
/** 없는 경로 404를 받아 본문 traceId가 X-Trace-Id와 같아질 때까지 기다린다(정책이 퍼지는 데 몇 초 걸린다) */
async function bodyTraceMatches(label, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await send(c, 'scanner-api', { path: `/v1/zz-poc-${RUN}`, headers: { 'x-forwarded-for': '203.0.113.48' } });
    let body = {};
    try {
      body = JSON.parse(last.text);
    } catch {
      // 본문이 JSON이 아니면 다시 본다
    }
    if (HEX32.test(String(body.traceId ?? '')) && body.traceId === last.headers['x-trace-id']) return { ok: true, last };
    if (Date.now() > until) return { ok: false, last, label };
    await sleep(2000);
  }
}

test('D-T43 ④ PoC: responseOverride 본문의 %TRACE_ID%(안 되면 EnvoyPatchPolicy 판)가 그 요청의 X-Trace-Id와 같은 값으로 채워진다', async (t) => {
  const original = clean(await scannerOverridePolicy());
  const results = {};
  // 판 1: responseOverride 404 본문에 %TRACE_ID%
  const v1 = structuredClone(original);
  for (const o of v1.spec.responseOverride) {
    const codes = (o.match?.statusCodes ?? []).map((s) => Number(s.value));
    if (codes.includes(404) && o.response?.body?.inline) o.response.body.inline = JSON.stringify({ ...JSON.parse(o.response.body.inline), traceId: '%TRACE_ID%' });
  }
  try {
    await applyObject(v1);
    const r = await bodyTraceMatches('responseOverride');
    results.responseOverride = r.ok;
    t.diagnostic(`판 1(responseOverride %TRACE_ID%): ${r.ok ? '채워짐' : `안 됨, 마지막 본문 ${r.last.text.slice(0, 200)} / X-Trace-Id ${r.last.headers['x-trace-id']}`}`);
  } finally {
    await applyObject(original);
  }
  if (!results.responseOverride) {
    // 판 2: EnvoyPatchPolicy로 리스너의 local_reply_config에 trace-id를 넣는다(리스너 이름은 Envoy Gateway의 '<네임스페이스>/<게이트웨이>/<리스너>' 꼴 [확인 필요])
    const patch = {
      apiVersion: 'gateway.envoyproxy.io/v1alpha1',
      kind: 'EnvoyPatchPolicy',
      metadata: { name: `zz-poc-trace-${RUN}`, namespace: NS() },
      spec: {
        targetRef: { group: 'gateway.networking.k8s.io', kind: 'Gateway', name: 'gw-scanner' },
        type: 'JSONPatch',
        jsonPatches: [
          {
            type: 'type.googleapis.com/envoy.config.listener.v3.Listener',
            name: `${NS()}/gw-scanner/scanner-api`,
            operation: { op: 'add', path: '/filter_chains/0/filters/0/typed_config/local_reply_config', value: { body_format: { json_format: { type: 'about:blank', title: 'Not Found', status: 404, traceId: '%TRACE_ID%' }, content_type: 'application/problem+json' } } },
          },
        ],
      },
    };
    try {
      await applyObject(patch);
      const r = await bodyTraceMatches('EnvoyPatchPolicy');
      results.envoyPatchPolicy = r.ok;
      t.diagnostic(`판 2(EnvoyPatchPolicy local_reply_config): ${r.ok ? '채워짐' : `안 됨, 마지막 본문 ${r.last.text.slice(0, 200)}`}`);
    } finally {
      await kubectl(['-n', NS(), 'delete', 'envoypatchpolicy', patch.metadata.name, '--ignore-not-found'], { quiet: true, timeout: 60_000 });
    }
  }
  // 되돌린 뒤 기본 본문(traceId 없음)으로 돌아온다
  const back = await send(c, 'scanner-api', { path: `/v1/zz-poc-${RUN}-after`, headers: { 'x-forwarded-for': '203.0.113.49' } });
  t.diagnostic(`되돌린 뒤 본문: ${back.text.slice(0, 200)}`);
  assert.ok(results.responseOverride || results.envoyPatchPolicy, `두 판 모두 본문에 trace-id가 실리지 않았다(${JSON.stringify(results)}). 계획 '시험 이의'에 적는다`);
});

// ===================== 열림(D-T50 ③, 맨 끝) =====================

/** 게이트웨이 프록시 파드들의 통계에서 ratelimit failure_mode_allowed 합 */
async function failureModeAllowed(gw) {
  const selector = (c.logs?.selector ?? 'gateway.envoyproxy.io/owning-gateway-name={gateway}').replaceAll('{gateway}', gw);
  const pods = (await kubectl(['-n', NS(), 'get', 'pods', '-l', selector, '-o', 'jsonpath={.items[*].metadata.name}'], { quiet: true, timeout: 30_000 })).split(/\s+/).filter(Boolean);
  assert.ok(pods.length > 0, `${gw} 프록시 파드가 없다`);
  const port = c.stats?.port ?? 19001;
  const path = c.stats?.path ?? '/stats/prometheus';
  let sum = 0;
  let seen = false;
  for (const pod of pods) {
    const text = await kubectl(['get', '--raw', `/api/v1/namespaces/${NS()}/pods/${pod}:${port}/proxy${path}`], { quiet: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
    for (const line of text.split('\n')) {
      if (line.startsWith('#') || !/ratelimit[._]failure_mode_allowed/.test(line)) continue;
      seen = true;
      sum += Number(line.trim().split(/\s+/).pop()) || 0;
    }
  }
  return { sum, seen };
}
const deploymentReplicas = async () => Number((await kubectl(['-n', c.rateLimit.namespace, 'get', 'deploy', c.rateLimit.deployment, '-o', 'jsonpath={.spec.replicas}'], { quiet: true, timeout: 30_000 })).trim());
const readyReplicas = async () => Number((await kubectl(['-n', c.rateLimit.namespace, 'get', 'deploy', c.rateLimit.deployment, '-o', 'jsonpath={.status.replicas}'], { quiet: true, timeout: 30_000 })).trim() || 0);

test('D-T50 ③ 레이트 리밋 서비스 복제를 0으로 줄이면 같은 창에서 막혔던 계정도 통과하고 게이트웨이 통계 ratelimit.failure_mode_allowed가 는다(끝나면 복제를 되돌린다)', async () => {
  const original = await deploymentReplicas();
  assert.ok(original > 0, `레이트 리밋 서비스 복제가 ${original}이다(이미 멈춰 있다)`);
  // 61번 부르기와 복제 줄이기(파드가 내려가기까지 최대 40초)를 한 분 창에 넣어야 해서 분의 15초 안에 시작한다(계획 §6의 '최대 10초 기다림'보다 길게 기다릴 수 있다)
  const minute = await windowStart(15);
  const sub = nextSub();
  const rs = await mixed(sub, '198.51.100.96', FAN_LIMIT_PER_MINUTE + 1);
  assert.equal(rs[FAN_LIMIT_PER_MINUTE].status, 429, `서비스가 있을 때 61번째: ${rs[FAN_LIMIT_PER_MINUTE].status}`);
  const before = await failureModeAllowed('gw-fan');
  try {
    await kubectl(['-n', c.rateLimit.namespace, 'scale', 'deploy', c.rateLimit.deployment, '--replicas=0'], { quiet: true, timeout: 60_000 });
    const until = Date.now() + 40_000;
    while ((await readyReplicas()) > 0) {
      assert.ok(Date.now() < until, '레이트 리밋 서비스 파드가 40초 안에 내려가지 않았다');
      await sleep(1000);
    }
    // 판정을 받지 못하면 통과한다(열림). 파드가 빠진 뒤 연결이 끊기기까지 몇 번 더 보낸다
    let passed = null;
    for (let i = 0; i < 10 && !passed; i++) {
      const r = await send(c, 'api', { path: FAN_IDENTITY_PATH, headers: fanHeaders(sub, '198.51.100.96') });
      if (r.status < 400) passed = r;
      else await sleep(1000);
    }
    assert.equal(minuteOf(), minute, '분 창 경계를 넘었다(새 창이라 통과한 것과 가를 수 없다. 다시 하지 않고 실패로 본다)');
    assert.ok(passed, '레이트 리밋 서비스가 없는데 막힌 계정이 계속 막힌다(닫힘)');
    assert.equal(echoed(passed)['x-user-id'], sub);
    const afterStats = await failureModeAllowed('gw-fan');
    assert.ok(afterStats.seen, 'gw-fan 통계에 ratelimit failure_mode_allowed가 없다');
    assert.ok(afterStats.sum > before.sum, `failure_mode_allowed가 늘지 않았다(${before.sum} → ${afterStats.sum})`);
  } finally {
    await kubectl(['-n', c.rateLimit.namespace, 'scale', 'deploy', c.rateLimit.deployment, `--replicas=${original}`], { quiet: true, timeout: 60_000 });
    await kubectl(['-n', c.rateLimit.namespace, 'rollout', 'status', `deploy/${c.rateLimit.deployment}`, '--timeout=180s'], { quiet: true, timeout: 200_000 });
  }
});
