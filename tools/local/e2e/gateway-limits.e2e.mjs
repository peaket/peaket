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
// D-T50 ⑥은 대역 백엔드 파드(이름표 app.kubernetes.io/name=gateway-echo, 컨테이너 echo, Node 있음) 안에서 `kubectl exec … node -e`로
//   gw-partner 프록시 Service(이름표 gateway.envoyproxy.io/owning-gateway-name=gw-partner, 포트 443)에 보낸다(포트 전달을 거치지 않는다).
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
import { accessToken, echoed, edge, loadContract, send } from './gateway-client.mjs';

const RUN = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
let c;
let n = 0;
const nextSub = () => `lim-${RUN}-${++n}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 포트 전달이 끊긴 꼴의 연결 오류(Windows kubectl 포트 전달, 2026-11-16 kind 실측) */
const CONN_ERROR = /ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|시간 넘김/;
/**
 * 시험이 설정을 바꾼 뒤(정책 적용·복제 줄이기)에만 쓴다: 연결 오류를 던지지 않고 { connError }로 돌려준다.
 * 부르는 쪽은 연결 오류를 통과로 세지 않고 '아직'으로 보고 기다린다. 판정 요청(한도 넘기기 등)에는 쓰지 않는다(BAT-055 시험 이의 (라) 판단)
 */
async function sendOrConnError(hostKey, req) {
  try {
    return await send(c, hostKey, req);
  } catch (e) {
    if (CONN_ERROR.test(`${e?.code ?? ''} ${e?.message ?? ''}`)) return { connError: e };
    throw e;
  }
}
// 웹훅 IP 한도를 넘기는 몰아 보내기는 포트 전달을 거치지 않고 클러스터 안에서 한다(아래 inClusterFlood, BAT-060 '판단: 구현 kind 확인의 남은 것' 2).
// 포트 전달로는 동시 20에서 초당 약 93건이라 초당 100건을 넘기지 못했고, 동시 50에서는 끊겼다(2026-11-16 kind 실측)
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
  // 429: 한 계정이 분 창에 61번 부른다(전역 한도). 포트 전달로는 웹훅 IP 한도(초당 100건)를 넘길 만큼 빨리 보내지 못한다
  // (2026-11-16 kind 실측 초당 약 93건, BAT-060 '판단: 구현 kind 확인의 남은 것' 2). 웹훅 IP 한도의 429 본문은 D-T50 ⑥이 클러스터 안에서 본다
  const minute = await windowStart();
  const sub = nextSub();
  let last;
  for (let i = 0; i <= FAN_LIMIT_PER_MINUTE; i++) last = await send(c, 'api', { path: i % 2 ? FAN_IDENTITY_PATH : FAN_API_PATH, headers: fanHeaders(sub, '203.0.113.50') });
  assert.equal(minuteOf(), minute, '분 창 경계를 넘었다(다시 하지 않고 실패로 본다)');
  assertGatewayProblem(last, 429, '전역 한도 429(61번째)');
  assert.match(String(last.headers['retry-after'] ?? ''), /^\d+$/, '429의 Retry-After');
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

/**
 * 클러스터 안 보내기(BAT-060 '판단: 구현 kind 확인의 남은 것' 2): 대역 백엔드 파드(Node가 있다) 안에서 gw-partner 프록시 Service로 보낸다.
 * 이 함수의 원문을 `kubectl exec … -- node -e`의 인자로 넘긴다(파일을 싣지 않으므로 kubectl cp·표준 입력이 필요 없다. 대역 파드는 읽기 전용 루트라
 * cp할 자리도 없다). 그래서 이 함수는 바깥 이름을 쓰지 않는다. 배치마다 { ip, sent, ms, s429, echo, errors, statuses, retryAfterOk, problem429 }를 JSON 한 줄로 찍는다.
 */
async function inClusterFlood(o) {
  const https = require('node:https');
  const agent = new https.Agent({ keepAlive: true, maxSockets: o.width });
  const one = (ip) =>
    new Promise((resolve) => {
      const req = https.request(
        {
          host: o.service,
          port: o.port,
          servername: o.host,
          method: 'POST',
          path: o.path,
          agent,
          ...(o.ca ? { ca: o.ca } : { rejectUnauthorized: false }),
          timeout: 10000,
          headers: { host: o.host, 'content-type': 'application/json', 'content-length': '2', 'x-forwarded-for': ip, 'x-peaket-origin-verify': o.originVerify },
        },
        (res) => {
          let b = '';
          res.on('data', (d) => (b += d));
          res.on('end', () => {
            let echo = false;
            try {
              const j = JSON.parse(b);
              echo = j !== null && typeof j === 'object' && typeof j.method === 'string' && typeof j.path === 'string' && j.headers !== null && typeof j.headers === 'object';
            } catch {
              echo = false;
            }
            resolve({ status: res.statusCode, echo, retryAfter: res.headers['retry-after'], contentType: res.headers['content-type'], body: echo ? '' : b.slice(0, 200) });
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => resolve({ status: 0, error: String(e.code || e.message) }));
      req.end('{}');
    });
  const out = [];
  for (const { ip, count } of o.batches) {
    const rs = new Array(count);
    let next = 0;
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: Math.min(o.width, count) }, async () => {
        while (next < count) {
          const i = next++;
          rs[i] = await one(ip);
        }
      }),
    );
    const ms = Date.now() - t0;
    const statuses = {};
    for (const r of rs) statuses[r.status] = (statuses[r.status] || 0) + 1;
    const limited = rs.filter((r) => r.status === 429);
    out.push({
      ip,
      sent: count,
      ms,
      s429: limited.length,
      echo: rs.filter((r) => r.echo && r.status < 400).length,
      echo429: limited.filter((r) => r.echo).length,
      errors: rs.filter((r) => r.status === 0).length,
      statuses,
      retryAfterOk: limited.every((r) => /^\d+$/.test(String(r.retryAfter || ''))),
      problem429: limited.length ? { contentType: limited[0].contentType, body: limited[0].body } : null,
    });
  }
  agent.destroy();
  console.log(JSON.stringify(out));
}

/** 클러스터 안에서 보낸다: 대역 파드 이름·gw-partner 프록시 Service를 찾아 inClusterFlood를 돌린다 */
async function floodInCluster(batches) {
  const echoPod = (await kubectl(['-n', NS(), 'get', 'pods', '-l', 'app.kubernetes.io/name=gateway-echo', '-o', 'jsonpath={.items[0].metadata.name}'], { quiet: true, timeout: 30_000 })).trim();
  assert.ok(echoPod, '대역 백엔드 파드가 없다');
  const svc = (await kubectl(['-n', NS(), 'get', 'svc', '-l', 'gateway.envoyproxy.io/owning-gateway-name=gw-partner', '-o', 'jsonpath={.items[0].metadata.name}'], { quiet: true, timeout: 30_000 })).trim();
  assert.ok(svc, 'gw-partner 프록시 Service가 없다');
  const args = { service: `${svc}.${NS()}.svc.cluster.local`, port: 443, host: c.hosts['partner-api'], path: '/v1/webhooks/toss', originVerify: c.originVerify, ca: c.caPem, width: 50, batches };
  // 원문을 base64로 싸서 넘긴다(Windows 명령줄의 따옴표·역슬래시 바꿈을 피한다). eval은 -e 모듈 안이라 require를 쓴다
  const script = `(${inClusterFlood.toString()})(${JSON.stringify(args)}).catch((e) => { console.error(e); process.exit(1); })`;
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const out = await kubectl(['-n', NS(), 'exec', echoPod, '-c', 'echo', '--', 'node', '-e', `eval(Buffer.from('${b64}', 'base64').toString('utf8'))`], { quiet: true, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(out.trim().split('\n').pop());
}

test('D-T50 ⑥ 한 IP로 /v1/webhooks/toss에 초당 100건을 넘기면 429이고 대역 백엔드는 넘은 요청을 받지 않으며 다른 IP는 통과한다(IPv4·IPv6 각각, 클러스터 안에서 보냄)', async () => {
  const replicas = Number(c.replicas?.['gw-partner'] ?? 1);
  for (const [ip, other] of [
    ['198.51.100.91', '198.51.100.92'],
    ['2001:db8:91::1', '2001:db8:92::1'],
  ]) {
    // 한 IP에 400건(동시 50, 1초 창에 300건 이상을 노린다 [가정]), 이어 같은 창에서 다른 IP로 한 건
    const [flood, o] = await floodInCluster([
      { ip, count: 400 },
      { ip: other, count: 1 },
    ]);
    const seconds = flood.ms / 1000;
    const rate = flood.sent / Math.max(seconds, 0.001);
    // 시험 바탕이 판정 조건을 만들지 못한 경우를 한도 단언 실패와 가른다(빈 결과가 통과로 새지 않게)
    assert.equal(flood.errors, 0, `${ip}: 시험 바탕 모자람(연결 오류 ${flood.errors}건, ${JSON.stringify(flood.statuses)})`);
    assert.ok(rate > WEBHOOK_PER_SECOND, `${ip}: 시험 바탕 모자람(보낸 속도 초당 ${rate.toFixed(0)}건, ${flood.sent}건 ${seconds.toFixed(2)}초)`);
    assert.ok(flood.s429 > 0, `${ip}: ${flood.sent}건(${seconds.toFixed(2)}초, 초당 ${rate.toFixed(0)}건)에 429가 없다 ${JSON.stringify(flood.statuses)}`);
    assert.equal(flood.echo429, 0, `${ip}: 429가 대역 백엔드 응답이다`);
    assert.ok(flood.retryAfterOk, `${ip}: 429에 Retry-After가 없다`);
    assert.match(String(flood.problem429?.contentType ?? ''), /^application\/problem\+json\b/, `${ip}: 429 형식`);
    assert.deepEqual(JSON.parse(flood.problem429?.body || 'null'), { type: 'about:blank', title: 'Too Many Requests', status: 429 }, `${ip}: 429 본문`);
    // 429가 아닌 응답은 모두 대역 백엔드가 받은 것이다(다른 상태가 섞이지 않는다)
    assert.equal(flood.s429 + flood.echo, flood.sent, `${ip}: 429도 대역 응답도 아닌 것이 있다 ${JSON.stringify(flood.statuses)}`);
    // 처음 모아 둔 100건 + 지난 시간만큼 채운 초당 100건(올림)을 파드마다 넘겨 대역 백엔드가 받지 않는다
    assert.ok(flood.echo <= WEBHOOK_PER_SECOND * (1 + Math.ceil(seconds)) * replicas, `${ip}: 대역이 받은 ${flood.echo}건 > 100 × (1 + ${Math.ceil(seconds)}) × ${replicas}`);
    assert.ok(flood.echo >= WEBHOOK_PER_SECOND, `${ip}: 초당 100건보다 적게 통과했다(${flood.echo})`);
    assert.equal(o.errors, 0, `${other}: 시험 바탕 모자람(연결 오류)`);
    assert.equal(o.echo, 1, `${other}: 다른 IP까지 막았다 ${JSON.stringify(o.statuses)}`);
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
async function bodyTraceMatches(label, timeoutMs = 45_000) {
  const until = Date.now() + timeoutMs;
  let last = { status: 0, headers: {}, text: '(응답 없음)' };
  for (;;) {
    // 정책을 바꾸면 Envoy 설정이 바뀌어 Windows kubectl 포트 전달이 끊기고 포트 전달 도구가 1초 뒤 다시 띄운다(2026-11-16 kind 실측).
    // 그동안의 연결 오류는 '아직'으로 보고 기다린다. 연결 오류는 통과가 되지 않는다(본문이 맞아야만 통과)
    const r = await sendOrConnError('scanner-api', { path: `/v1/zz-poc-${RUN}`, headers: { 'x-forwarded-for': '203.0.113.48' } });
    if (r.connError) {
      last = { status: 0, headers: {}, text: `(연결 오류 ${r.connError.code ?? r.connError.message})` };
      if (Date.now() > until) return { ok: false, last, label };
      await sleep(2000);
      continue;
    }
    last = r;
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
  // 되돌린 적용도 포트 전달을 끊을 수 있어 연결 오류면 잠깐 기다려 다시 본다(기록만 한다)
  let back = { connError: true };
  for (let i = 0; i < 15 && back.connError; i++) {
    back = await sendOrConnError('scanner-api', { path: `/v1/zz-poc-${RUN}-after`, headers: { 'x-forwarded-for': '203.0.113.49' } });
    if (back.connError) await sleep(2000);
  }
  t.diagnostic(`되돌린 뒤 본문: ${back.connError ? '(연결 오류가 이어졌다)' : back.text.slice(0, 200)}`);
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
    // 판정을 받지 못하면 통과한다(열림). 파드가 빠진 뒤 연결이 끊기기까지 몇 번 더 보낸다.
    // 이 사이 포트 전달 연결 오류는 '아직'으로 보고 다시 보낸다(연결 오류는 통과로 세지 않는다. 통과는 대역 백엔드 응답일 때만)
    let passed = null;
    for (let i = 0; i < 10 && !passed; i++) {
      const r = await sendOrConnError('api', { path: FAN_IDENTITY_PATH, headers: fanHeaders(sub, '198.51.100.96') });
      if (!r.connError && r.status < 400) passed = r;
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
