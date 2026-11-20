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
// 실행(저장소 뿌리, Docker 차례 잠금을 잡고): PEAKET_CLUSTER=lane1-<이름> node tools/local/cluster.mjs up(포트 매핑을 거는 새 클러스터) 뒤 같은 환경 값으로
//   node tools/local/cluster.mjs gateways, 그다음 node --test tools/local/e2e/gateway-limits.e2e.mjs. 포트 전달은 띄우지 않는다(kind 포트 매핑과 로컬 전용
//   NodePort Service로 127.0.0.1에 잇는다, docs/infra.md §4.1 '로컬 kind에서 이 PC로 잇는 법')
// 끝나면 클러스터를 지우고(kind delete cluster), 시험이 만든 컨테이너는 docker rm -f -v로 지우고 잠금 폴더를 지운다(PROGRESS 턴 규칙 'Docker 차례', R-644).
// 차단 상한(V-T43, 묶음 BAT-056 계획 §3의 K1~K3)은 D-T43 ④ 뒤·D-T50 ③ 앞에 둔다. K3은 운영 정의의 상한을 프록시 관리 포트 /clusters에서 읽고(관리 포트는 파드 안
//   127.0.0.1에만 열려 있어 그 읽기만 kubectl 포트 전달을 잠깐 연다. 부하는 거치지 않는다), K1·K2는 gw-queue-buy에 임시 정책(이름표 peaket.io/sweep)을 잠깐 걸고
//   대역 백엔드 파드 안에서 gw-queue 프록시 Service로 2초 지연 요청을 보낸 뒤 임시 정책을 지운다. 시험 값(Retry-After 2, 지금 운영 값 2,434·305·6,084·761, 65,536)은 정본
//   docs/infra.md §4.1 '게이트웨이 차단 상한' 값을 적고, 임시 상한(1·4)은 운영 값과 다르게 고른다.
// 프록시 일꾼 수(V-T43 ①, 묶음 BAT-058 계획 §7의 WK1, HOT-405)는 K3 앞에 둔다: 다섯 게이트웨이 프록시 파드마다 관리 포트 통계(19001 /stats/prometheus, API 서버 프록시)의
//   server.concurrency가 2이고 envoy 컨테이너 CPU 요청이 로컬 덧씌우기의 100m·CPU 한도 없음이다(docs/infra.md §4.1 '프록시 일꾼 수와 파드 CPU', ADR-0287 결정 1~4).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import { KUBECONFIG, kubectl } from '../cluster.mjs';
import { ensureTool } from '../tools.mjs';
import { API_CSP, HSTS, accessToken, echoed, edge, loadContract, send, token } from './gateway-client.mjs';

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
  const one = (ip, path) =>
    new Promise((resolve) => {
      const req = https.request(
        {
          host: o.service,
          port: o.port,
          servername: o.host,
          method: 'POST',
          path,
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
  for (const { ip, count, paths } of o.batches) {
    // paths가 있으면 요청마다 차례로 돌려 섞는다(두 웹훅 경로를 한 버킷으로 세는지, RV-14)
    const pathOf = (i) => (paths && paths.length ? paths[i % paths.length] : o.path);
    const rs = new Array(count);
    let next = 0;
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: Math.min(o.width, count) }, async () => {
        while (next < count) {
          const i = next++;
          rs[i] = await one(ip, pathOf(i));
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

test('RV-14 D-T50 ⑥ 한 IP로 두 웹훅 경로(/v1/webhooks/toss·/portone)를 섞어 보내도 대역이 받은 수는 100 × (1 + ceil(초)) × 복제 수 이하다(두 경로가 한 버킷, 클러스터 안에서 보냄)', async () => {
  const replicas = Number(c.replicas?.['gw-partner'] ?? 1);
  for (const ip of ['198.51.100.89', '2001:db8:89::1']) {
    const [flood] = await floodInCluster([{ ip, count: 400, paths: ['/v1/webhooks/toss', '/v1/webhooks/portone'] }]);
    const seconds = flood.ms / 1000;
    const rate = flood.sent / Math.max(seconds, 0.001);
    assert.equal(flood.errors, 0, `${ip}: 시험 바탕 모자람(연결 오류 ${flood.errors}건, ${JSON.stringify(flood.statuses)})`);
    assert.ok(rate > WEBHOOK_PER_SECOND, `${ip}: 시험 바탕 모자람(보낸 속도 초당 ${rate.toFixed(0)}건, ${flood.sent}건 ${seconds.toFixed(2)}초)`);
    assert.ok(flood.s429 > 0, `${ip}: 섞어 보낸 ${flood.sent}건에 429가 없다 ${JSON.stringify(flood.statuses)}`);
    assert.equal(flood.s429 + flood.echo, flood.sent, `${ip}: 429도 대역 응답도 아닌 것이 있다 ${JSON.stringify(flood.statuses)}`);
    // 경로마다 버킷이 따로면 통과가 두 배(경로당 100 × …)까지 늘어 이 단언에 걸린다
    assert.ok(flood.echo <= WEBHOOK_PER_SECOND * (1 + Math.ceil(seconds)) * replicas, `${ip}: 두 경로를 섞어 대역이 받은 ${flood.echo}건 > 100 × (1 + ${Math.ceil(seconds)}) × ${replicas}(경로마다 센다)`);
    assert.ok(flood.echo >= WEBHOOK_PER_SECOND, `${ip}: 초당 100건보다 적게 통과했다(${flood.echo})`);
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
/**
 * gw-fan 게이트웨이에 건 응답 고치기 정책(PoC는 이 하나만 잠깐 바꾼다). 대상은 토큰으로 센 429 갈래(요청 머리 X-User-Id 조건이 있는 429 항목,
 * 계정당 60회/분 전역 한도가 낸다). 404는 직접 응답 필터로 옮겨 응답 고치기를 지나지 않는다(계획 '판단: 둘째 보기의 RV-15·RV-17·RV-18').
 * 토큰 없는 쪽 429(검색 IP 한도)는 쓰지 않는다: 검색은 CDN 캐시 작업이라 라우트가 X-Trace-Id를 붙이지 않아(D-T43 ③) 견줄 머리가 없다
 * (2026-11-16 kind lane1-b060p 실측: 검색 429·200 모두 X-Trace-Id 없음, 전역 한도 429는 있음)
 */
async function fanOverridePolicy() {
  const list = JSON.parse(await kubectl(['-n', NS(), 'get', 'backendtrafficpolicies', '-o', 'json'], { quiet: true, timeout: 30_000 }));
  const hits = list.items.filter((p) => (p.spec?.responseOverride ?? []).length && [...(p.spec?.targetRefs ?? []), ...(p.spec?.targetRef ? [p.spec.targetRef] : [])].some((t) => t.kind === 'Gateway' && t.name === 'gw-fan'));
  assert.equal(hits.length, 1, `gw-fan에 건 responseOverride 정책이 하나가 아니다(${hits.length})`);
  return hits[0];
}
/** 토큰으로 센 쪽 429 항목(요청 머리 X-User-Id 조건이 있는 429) */
const account429 = (policy) => {
  const es = (policy.spec?.responseOverride ?? []).filter((o) => (o.match?.statusCodes ?? []).some((s) => Number(s.value) === 429) && (o.match?.requestHeaders ?? []).some((h) => String(h.name).toLowerCase() === 'x-user-id'));
  assert.equal(es.length, 1, `토큰으로 센 쪽 429 응답 고치기 항목이 하나가 아니다(${es.length})`);
  return es[0];
};
/**
 * 새 계정 하나로 gw-fan-api를 61번 불러 61번째 429를 받는다(계정당 60회/분). accept가 참인 429가 올 때까지 계정을 바꿔 되풀이한다.
 * 정책을 바꾸면 Windows kubectl 포트 전달이 끊길 수 있어(2026-11-16 kind 실측) 연결 오류는 '아직'으로 보고 기다린다. 연결 오류는 결과가 되지 않는다
 */
async function account429Response(accept, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    await windowStart();
    const sub = nextSub();
    let r = null;
    for (let i = 0; i <= FAN_LIMIT_PER_MINUTE; i++) {
      r = await sendOrConnError('api', { path: FAN_API_PATH, headers: fanHeaders(sub, '198.51.100.84') });
      if (r.connError) break;
    }
    if (r && !r.connError && r.status === 429) {
      last = r;
      if (accept(r)) return { ok: true, last: r };
    }
    if (Date.now() > until) return { ok: false, last };
    await sleep(2000);
  }
}
const bodyTraceId = (r) => {
  try {
    return JSON.parse(r.text).traceId;
  } catch {
    return undefined;
  }
};

test('D-T43 ④ RV-15 PoC: 계정당 전역 한도 429의 응답 고치기 본문에 %TRACE_ID%를 넣은 사본을 걸면 본문 traceId가 32자리 16진수이고 같은 응답의 X-Trace-Id와 같다(끝에 되돌린다)', async (t) => {
  const original = clean(await fanOverridePolicy());
  const originalInline = account429(original).response?.body?.inline;
  assert.ok(typeof originalInline === 'string', '429 항목에 고정 본문이 없다');
  // 바탕: 지금 정책에서 계정당 한도 429에 X-Trace-Id 머리가 붙는다(없으면 견줄 값이 없어 PoC 바탕 모자람)
  const base = await account429Response(() => true);
  assert.ok(base.ok, `PoC 바탕 모자람: 계정당 한도 429를 받지 못했다(${base.last?.status ?? '응답 없음'})`);
  assert.match(String(base.last.headers['x-trace-id'] ?? ''), HEX32, `PoC 바탕 모자람: 429에 X-Trace-Id 머리가 없다(${base.last.headers['x-trace-id']})`);
  assert.equal(bodyTraceId(base.last), undefined, '바꾸기 전 429 본문에 이미 traceId가 있다');
  const poc = structuredClone(original);
  const entry = account429(poc);
  entry.response.body.inline = JSON.stringify({ ...JSON.parse(entry.response.body.inline), traceId: '%TRACE_ID%' });
  let result;
  try {
    await applyObject(poc);
    result = await account429Response((r) => bodyTraceId(r) !== undefined);
    t.diagnostic(`PoC 429: 본문 ${result.last?.text?.slice(0, 200) ?? '(없음)'} / X-Trace-Id ${result.last?.headers?.['x-trace-id']}`);
  } finally {
    await applyObject(original);
  }
  // 되돌린 것을 단언한다: 정책의 429 본문이 원래 글이고, 받은 429 본문에 traceId가 다시 없다
  assert.equal(account429(clean(await fanOverridePolicy())).response?.body?.inline, originalInline, '정책을 되돌리지 못했다');
  const back = await account429Response((r) => bodyTraceId(r) === undefined);
  assert.ok(back.ok, `되돌린 뒤에도 429 본문에 traceId가 남았다: ${back.last?.text?.slice(0, 200)}`);
  t.diagnostic(`되돌린 뒤 429: 본문 ${back.last?.text?.slice(0, 200)} / X-Trace-Id ${back.last?.headers?.['x-trace-id']}`);
  // 판정(마지막에 둬 되돌리기가 먼저 끝나게 한다)
  assert.ok(result?.ok, `PoC 사본의 429 본문에 traceId가 실리지 않았다: ${result?.last?.text?.slice(0, 200)}`);
  const traceId = bodyTraceId(result.last);
  assert.match(String(traceId), HEX32, `본문 traceId가 32자리 16진수가 아니다: ${traceId}`);
  assert.equal(traceId, result.last.headers['x-trace-id'], '본문 traceId와 X-Trace-Id 머리가 다르다');
});

// ===================== 차단 상한(V-T43 ①②, BAT-056 K1~K3) =====================

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/**
 * 정본 지금 운영 값(docs/infra.md §4.1 '게이트웨이 차단 상한' '지금 값과 잰 값(적용 보류)'·'진단 측정으로 정함', 2026-11-19 BAT-058 진단 측정, ADR-0287 결정 11):
 * Envoy /clusters 칸 이름(max_requests = 동시 처리). gw-queue 2,434·보류 305, 나머지 넷 6,084·761(이력: 첫 값 2,400·300·6,000·750, 첫 측정의 잰 값(적용 보류) 3,120·390·7,800·975)
 */
const OPS_LIMITS = {
  'gw-queue': { max_connections: 2434, max_requests: 2434, max_pending_requests: 305 },
  'gw-fan': { max_connections: 6084, max_requests: 6084, max_pending_requests: 761 },
  'gw-ops': { max_connections: 6084, max_requests: 6084, max_pending_requests: 761 },
};
/** 프록시 일꾼 수(= 파드 CPU 2)와 로컬·CI kind 덧씌우기의 envoy 컨테이너 CPU 요청(docs/infra.md §4.1 '프록시 일꾼 수와 파드 CPU', ADR-0287 결정 2·4) */
const PROXY_WORKERS = 2;
const LOCAL_PROXY_CPU = '100m';
const GATEWAY_NAMES5 = ['gw-queue', 'gw-fan', 'gw-partner', 'gw-ops', 'gw-scanner'];
/** 길게 쥐는 규칙(관제 SSE 두 흐름)의 세 칸 65,536 [가정] */
const LONG_HOLD_LIMITS = { max_connections: 65536, max_requests: 65536, max_pending_requests: 65536 };
/** 게이트웨이가 만든 503의 Retry-After [가정] */
const RETRY_AFTER_503 = '2';
/** K의 느슨한 시간 값(3ms 판정은 측정 몫, 계획 §3 K1) */
const K_FAST_MS = 100;
const SWEEP_LABEL = 'peaket.io/sweep';
const K_POLICY = 'peaket-e2e-breaker-gw-queue-buy';

/** 생성 라우트(deploy/gateways/*.routes.yaml, 읽기만)에서 (메서드, 경로)가 맞는 규칙 번호 */
function ruleIndexOf(routeName, method, path) {
  const dir = join(REPO, 'deploy', 'gateways');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.routes.yaml')))
    for (const d of parseAllDocuments(readFileSync(join(dir, f), 'utf8'))) {
      const o = d.toJS();
      if (o?.kind !== 'HTTPRoute' || o.metadata?.name !== routeName) continue;
      for (const [i, rule] of (o.spec?.rules ?? []).entries())
        for (const m of rule.matches ?? []) {
          if (m.method && m.method !== method) continue;
          const p = m.path ?? { type: 'PathPrefix', value: '/' };
          if (p.type === 'Exact' ? p.value === path : p.type === 'RegularExpression' ? new RegExp(`^(?:${p.value})$`).test(path) : path === p.value || path.startsWith(`${p.value.replace(/\/$/, '')}/`)) return i;
        }
      throw new Error(`${routeName}에 ${method} ${path} 규칙이 없다`);
    }
  throw new Error(`생성 라우트 ${routeName}가 없다`);
}
/** Envoy Gateway v1.10.0의 규칙 묶음(cluster) 이름 */
const clusterOf = (routeName, method, path) => `httproute/${NS()}/${routeName}/rule/${ruleIndexOf(routeName, method, path)}`;

async function proxyPodsOf(gw) {
  const items = JSON.parse(await kubectl(['-n', NS(), 'get', 'pods', '-l', `gateway.envoyproxy.io/owning-gateway-name=${gw}`, '-o', 'json'], { quiet: true, timeout: 30_000 })).items ?? [];
  const pods = items.filter((p) => p.status?.phase === 'Running' && !p.metadata?.deletionTimestamp).map((p) => p.metadata.name);
  assert.ok(pods.length > 0, `${gw} 프록시 파드가 없다`);
  return pods;
}
/** 프록시 파드 관리 포트(127.0.0.1:19000)의 /clusters 글. 포트 전달을 이 읽기 동안만 연다(띄운 kubectl 하나만 끝낸다) */
async function adminClusters(pod) {
  const k = await ensureTool('kubectl');
  const pf = spawn(k, ['--kubeconfig', KUBECONFIG, '-n', NS(), 'port-forward', '--address', '127.0.0.1', `pod/${pod}`, ':19000'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((ok, no) => {
      let buf = '';
      const t = setTimeout(() => no(new Error(`${pod} 관리 포트 전달이 30초 안에 열리지 않았다`)), 30_000);
      pf.stdout.on('data', (d) => {
        buf += String(d);
        const m = /127\.0\.0\.1:(\d+) ->/.exec(buf);
        if (m) {
          clearTimeout(t);
          ok(Number(m[1]));
        }
      });
      pf.on('exit', (code) => {
        clearTimeout(t);
        no(new Error(`${pod} 관리 포트 전달이 끝났다(${code})`));
      });
    });
    const r = await fetch(`http://127.0.0.1:${port}/clusters`, { signal: AbortSignal.timeout(30_000) });
    assert.equal(r.status, 200, `${pod} /clusters`);
    return await r.text();
  } finally {
    pf.kill();
  }
}
/** /clusters 글에서 그 묶음의 기본 우선순위 상한(없는 칸은 빠진다) */
function limitsIn(text, cluster) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.startsWith(`${cluster}::default_priority::`)) continue;
    const [k, v] = line.slice(`${cluster}::default_priority::`.length).split('::');
    if (['max_connections', 'max_requests', 'max_pending_requests'].includes(k)) out[k] = Number(v);
  }
  return out;
}
/** 칸 차례에 기대지 않고 견준다 */
const sameLimits = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const near = (text, cluster) => [...new Set(text.split('\n').map((l) => l.split('::')[0]).filter((n) => n.startsWith(cluster.replace(/\/rule\/\d+$/, ''))))].join(', ');
/** 그 게이트웨이의 모든 프록시 파드에서 묶음들의 상한이 want일 때까지 기다린다(시간이 넘으면 마지막에 본 값과 함께 실패) */
async function waitLimits(gw, wants, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const seen = [];
    let ok = true;
    for (const pod of await proxyPodsOf(gw)) {
      let text = '';
      try {
        text = await adminClusters(pod);
      } catch (e) {
        ok = false;
        seen.push(`${pod}: ${e.message}`);
        continue;
      }
      for (const [cluster, want] of wants) {
        const got = limitsIn(text, cluster);
        if (!sameLimits(got, want)) {
          ok = false;
          seen.push(`${pod} ${cluster}: ${JSON.stringify(got)}(비슷한 묶음: ${near(text, cluster) || '없음'})`);
        }
      }
    }
    if (ok) return;
    if (Date.now() > until) assert.fail(`${gw} 프록시에 상한이 실리지 않았다(${timeoutMs}ms): ${seen.join(' / ')}`);
    await sleep(3000);
  }
}
/** 그 게이트웨이 프록시 파드들의 통계(19001 /stats/prometheus, API 서버 프록시)에서 그 묶음 카운터 합 */
async function clusterCounter(gw, cluster, stat) {
  let sum = 0;
  let seen = false;
  for (const pod of await proxyPodsOf(gw)) {
    const text = await kubectl(['get', '--raw', `/api/v1/namespaces/${NS()}/pods/${pod}:${c.stats?.port ?? 19001}/proxy${c.stats?.path ?? '/stats/prometheus'}`], { quiet: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
    for (const line of text.split('\n'))
      if (line.startsWith(`envoy_cluster_${stat}{`) && line.includes(`envoy_cluster_name="${cluster}"`)) {
        seen = true;
        sum += Number(line.trim().split(/\s+/).pop()) || 0;
      }
  }
  assert.ok(seen, `${gw} 통계에 ${cluster}의 ${stat}가 없다`);
  return sum;
}
/** gw-queue-buy를 라우트 전체로 겨눈 다른 BackendTrafficPolicy(있으면 임시 정책이 버려진다) */
async function otherBuyPolicies() {
  const list = JSON.parse(await kubectl(['-n', NS(), 'get', 'backendtrafficpolicies', '-o', 'json'], { quiet: true, timeout: 30_000 })).items ?? [];
  return list.filter((p) => p.metadata?.name !== K_POLICY && (p.spec?.targetRefs ?? []).some((t) => t.kind === 'HTTPRoute' && t.name === 'gw-queue-buy' && t.sectionName === undefined)).map((p) => p.metadata.name);
}
/** 시험의 임시 정책(라우트 하나, StrategicMerge로 게이트웨이 정책의 503 응답 고치기를 그대로 받는다) */
const kPolicy = (limit, pending) => ({
  apiVersion: 'gateway.envoyproxy.io/v1alpha1',
  kind: 'BackendTrafficPolicy',
  metadata: { name: K_POLICY, namespace: NS(), labels: { [SWEEP_LABEL]: 'true' } },
  spec: {
    targetRefs: [{ group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: 'gw-queue-buy' }],
    mergeType: 'StrategicMerge',
    circuitBreaker: { maxConnections: limit, maxParallelRequests: limit, maxPendingRequests: pending },
  },
});
async function removeKPolicy(cluster, limits) {
  await kubectl(['-n', NS(), 'delete', 'backendtrafficpolicies', K_POLICY, '--ignore-not-found'], { quiet: true, timeout: 60_000 });
  // 다음 시험이 임시 상한을 물려받지 않게, 그 묶음의 상한이 임시 값이 아닐 때까지 기다린다(값 단언은 K3)
  const until = Date.now() + 90_000;
  for (;;) {
    let still = false;
    for (const pod of await proxyPodsOf('gw-queue')) {
      try {
        if (sameLimits(limitsIn(await adminClusters(pod), cluster), limits)) still = true;
      } catch {
        still = true;
      }
    }
    if (!still) return;
    if (Date.now() > until) throw new Error(`임시 상한 ${JSON.stringify(limits)}이 90초 안에 빠지지 않았다`);
    await sleep(3000);
  }
}

/**
 * 클러스터 안 보내기(대역 백엔드 파드의 Node, 원문을 kubectl exec … node -e로 넘김. 바깥 이름을 쓰지 않는다):
 * gw-queue 프록시 Service로 진입 POST를 count개, staggerMs 간격으로 보낸다(0이면 한꺼번에). 요청마다 새 연결이고 응답 시간은 TLS 연결이 선 뒤부터 잰다.
 * 결과: [{ status, echo, retryAfter, contentType, body, ms, totalMs, error }]
 */
async function inClusterQueueBurst(o) {
  const https = require('node:https');
  const one = () =>
    new Promise((resolve) => {
      const t0 = performance.now();
      let t1 = null;
      const req = https.request(
        { host: o.service, port: o.port, servername: o.host, method: 'POST', path: o.path, agent: false, ...(o.ca ? { ca: o.ca } : { rejectUnauthorized: false }), timeout: 20000, headers: { host: o.host, 'content-length': Buffer.byteLength(o.body), ...o.headers } },
        (res) => {
          let b = '';
          res.on('data', (d) => (b += d));
          res.on('end', () => {
            const end = performance.now();
            let echo = false;
            try {
              const j = JSON.parse(b);
              echo = j !== null && typeof j === 'object' && typeof j.method === 'string' && typeof j.path === 'string' && j.headers !== null && typeof j.headers === 'object';
            } catch {
              echo = false;
            }
            resolve({ status: res.statusCode, echo, retryAfter: res.headers['retry-after'] ?? null, contentType: res.headers['content-type'] ?? null, body: echo ? '' : b.slice(0, 300), ms: end - (t1 ?? t0), totalMs: end - t0 });
          });
        },
      );
      req.on('socket', (s) => s.once('secureConnect', () => (t1 = performance.now())));
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => resolve({ status: 0, error: String(e.code || e.message) }));
      req.end(o.body);
    });
  const ps = [];
  for (let i = 0; i < o.count; i++) {
    ps.push(one());
    if (o.staggerMs > 0) await new Promise((r) => setTimeout(r, o.staggerMs));
  }
  console.log(JSON.stringify(await Promise.all(ps)));
}
async function queueBurst(count, staggerMs, delayMs = 2000) {
  const echoPod = (await kubectl(['-n', NS(), 'get', 'pods', '-l', 'app.kubernetes.io/name=gateway-echo', '-o', 'jsonpath={.items[0].metadata.name}'], { quiet: true, timeout: 30_000 })).trim();
  assert.ok(echoPod, '대역 백엔드 파드가 없다');
  const svc = (await kubectl(['-n', NS(), 'get', 'svc', '-l', 'gateway.envoyproxy.io/owning-gateway-name=gw-queue', '-o', 'jsonpath={.items[0].metadata.name}'], { quiet: true, timeout: 30_000 })).trim();
  assert.ok(svc, 'gw-queue 프록시 Service가 없다');
  const sub = nextSub();
  const tv = accessToken(c, 'gw-queue', sub);
  const args = {
    service: `${svc}.${NS()}.svc.cluster.local`,
    port: 443,
    host: c.hosts.queue,
    path: `/v1/queues/e-${RUN}/entries`,
    ca: c.caPem,
    count,
    staggerMs,
    body: '{}',
    headers: { ...edge(c, '198.51.100.56', { origin: c.origins.www, 'content-type': 'text/plain;charset=UTF-8', cookie: `__Secure-peaket_at=${tv}` }), 'x-e2e-delay-ms': String(delayMs) },
  };
  const script = `(${inClusterQueueBurst.toString()})(${JSON.stringify(args)}).catch((e) => { console.error(e); process.exit(1); })`;
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const out = await kubectl(['-n', NS(), 'exec', echoPod, '-c', 'echo', '--', 'node', '-e', `eval(Buffer.from('${b64}', 'base64').toString('utf8'))`], { quiet: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(out.trim().split('\n').pop());
}
const statusCounts = (rs) => rs.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});

/** 관리 포트 통계 글의 실제 일꾼 수(Envoy 통계 server.concurrency, Prometheus 이름 envoy_server_concurrency, 꼬리표 없는 줄). 없으면 null */
function serverConcurrencyIn(text) {
  const vals = String(text)
    .split('\n')
    .map((l) => /^envoy_server_concurrency(?:\{\})?\s+(\S+)\s*$/.exec(l.replace(/\r$/, ''))?.[1])
    .filter((v) => v !== undefined);
  return vals.length === 1 && /^\d+$/.test(vals[0]) ? Number(vals[0]) : vals.length ? `읽을 수 없는 값 ${JSON.stringify(vals)}` : null;
}

test('V-T43 ① HOT-405 WK1 다섯 게이트웨이 프록시 파드의 실제 일꾼 수(server.concurrency)가 2이고 envoy 컨테이너 CPU 요청이 100m·CPU 한도 없음이다', async () => {
  const seen = [];
  for (const gw of GATEWAY_NAMES5) {
    for (const pod of await proxyPodsOf(gw)) {
      const text = await kubectl(['get', '--raw', `/api/v1/namespaces/${NS()}/pods/${pod}:${c.stats?.port ?? 19001}/proxy${c.stats?.path ?? '/stats/prometheus'}`], { quiet: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
      assert.equal(serverConcurrencyIn(text), PROXY_WORKERS, `${gw} ${pod}: 관리 포트의 envoy_server_concurrency(정하지 않으면 노드 CPU 수만큼 생긴다)`);
      const spec = JSON.parse(await kubectl(['-n', NS(), 'get', 'pod', pod, '-o', 'json'], { quiet: true, timeout: 30_000 })).spec ?? {};
      const envoy = (spec.containers ?? []).find((x) => x.name === 'envoy');
      assert.ok(envoy, `${gw} ${pod}: envoy 컨테이너가 없다(${(spec.containers ?? []).map((x) => x.name).join(', ')})`);
      assert.equal(envoy.resources?.requests?.cpu, LOCAL_PROXY_CPU, `${gw} ${pod}: envoy CPU 요청 ${JSON.stringify(envoy.resources?.requests?.cpu)}(로컬 덧씌우기는 100m)`);
      assert.equal(envoy.resources?.limits?.cpu, undefined, `${gw} ${pod}: envoy CPU 한도 ${JSON.stringify(envoy.resources?.limits?.cpu)}가 있다`);
      seen.push(`${gw}/${pod}`);
    }
  }
  assert.ok(seen.length >= GATEWAY_NAMES5.length, `본 프록시 파드 ${seen.join(', ')}`);
});

test('V-T43 ② 운영 정의의 상한이 프록시 설정에 실린다', async () => {
  // HOT-405 K3: gw-queue 진입·gw-fan 홀드(정본 지금 값), gw-fan 결제 결과 롱 폴링(게이트웨이 값, 감독 결정 2026-11-18), gw-ops 관제 SSE 두 규칙(65,536)과 gw-ops의 다른 규칙(게이트웨이 값)
  await waitLimits('gw-queue', [[clusterOf('gw-queue-buy', 'POST', '/v1/queues/e1/entries'), OPS_LIMITS['gw-queue']]], 10_000);
  await waitLimits(
    'gw-fan',
    [
      [clusterOf('gw-fan-buy', 'POST', '/v1/events/e1/holds'), OPS_LIMITS['gw-fan']],
      [clusterOf('gw-fan-api', 'GET', '/v1/orders/o1/payment-status'), OPS_LIMITS['gw-fan']],
    ],
    10_000,
  );
  await waitLimits(
    'gw-ops',
    [
      [clusterOf('gw-ops-api', 'GET', '/v1/ops/events/e1/live'), LONG_HOLD_LIMITS],
      [clusterOf('gw-ops-api', 'GET', '/v1/ops/live'), LONG_HOLD_LIMITS],
      [clusterOf('gw-ops-api', 'GET', '/v1/ops/events/e1/bot-review'), OPS_LIMITS['gw-ops']],
    ],
    10_000,
  );
});

test('V-T43 ② 상한을 넘은 요청은 바로 503·Retry-After: 2·Problem이고 백엔드에 닿지 않는다', async () => {
  const cluster = clusterOf('gw-queue-buy', 'POST', '/v1/queues/e1/entries');
  const temp = { max_connections: 1, max_requests: 1, max_pending_requests: 1 };
  assert.deepEqual(await otherBuyPolicies(), [], 'gw-queue-buy를 겨눈 다른 정책이 있어 임시 정책이 버려진다');
  const pods = (await proxyPodsOf('gw-queue')).length;
  let rs;
  let delta;
  try {
    await applyObject(kPolicy(1, 1));
    await waitLimits('gw-queue', [[cluster, temp]]);
    // 그 묶음 통계 줄은 첫 요청 뒤에 생긴다(2026-11-18 kind 실측): 지연 없는 요청 하나로 줄을 만든 뒤 바탕 값을 읽는다
    const warm = await queueBurst(1, 0, 0);
    assert.ok(warm[0]?.echo, `시험 바탕: 첫 요청이 대역에 닿지 않았다 ${JSON.stringify(warm)}`);
    const before = await clusterCounter('gw-queue', cluster, 'upstream_rq_total');
    rs = await queueBurst(20, 0);
    delta = (await clusterCounter('gw-queue', cluster, 'upstream_rq_total')) - before;
  } finally {
    await removeKPolicy(cluster, temp);
  }
  const counts = statusCounts(rs);
  assert.equal(rs.filter((r) => r.status === 0).length, 0, `시험 바탕 모자람(연결 오류) ${JSON.stringify(counts)}`);
  const s503 = rs.filter((r) => r.status === 503);
  const echo = rs.filter((r) => r.echo && r.status < 400);
  // 동시 1 + 보류 1 = 2(프록시 파드마다)를 넘는 요청은 503
  assert.ok(s503.length >= 20 - 2 * pods, `503 ${s503.length}건 < ${20 - 2 * pods} ${JSON.stringify(counts)}`);
  assert.equal(s503.length + echo.length, rs.length, `503도 대역 응답도 아닌 것이 있다 ${JSON.stringify(counts)}`);
  assert.ok(echo.length >= 1 && echo.length <= 2 * pods, `대역에 닿은 수 ${echo.length}(1~${2 * pods})`);
  assert.ok(delta <= 2 * pods, `그 묶음의 업스트림 요청 수가 ${delta} 늘었다(≤ ${2 * pods})`);
  for (const [i, r] of s503.entries()) {
    assert.equal(r.echo, false, `503 #${i}: 대역 백엔드 응답이다`);
    assert.equal(r.retryAfter, RETRY_AFTER_503, `503 #${i}: Retry-After ${r.retryAfter}`);
    assert.match(String(r.contentType ?? ''), /^application\/problem\+json\b/, `503 #${i}: 형식 ${r.contentType}`);
    assert.deepEqual(JSON.parse(r.body || 'null'), { type: 'about:blank', title: TITLE[503], status: 503 }, `503 #${i}: 본문 ${r.body}`);
    assert.ok(r.ms < K_FAST_MS, `503 #${i}: ${r.ms.toFixed(1)}ms(연결 뒤) ≥ ${K_FAST_MS}ms`);
  }
});

// 계획 §3 K2는 '동시 + 보류(5개)까지 503 0건, 6개에 정확히 1건'이었으나, 보류 자리로 받을 5번째 요청을 Envoy가 늘 받아 주지 않는다(2026-11-18 kind lane1-b056t-pre,
// 구현 전 트리, 같은 임시 상한 동시 4·연결 4·보류 1: 5개 묶음 일곱 번에 503 0건 한 번·1건 여섯 번(5번째가 upstream_rq_active_overflow나 upstream_rq_pending_overflow로 503),
// 6개 묶음 세 번에 200·503 꼴 '4·2'·'5·1(5번째가 503, 6번째가 닿음)'). 그래서 결정적인 쪽만 단언한다: 동시 상한(4개)까지는 503 0건, 동시 + 보류(5)를 넘는 6개에는
// 503이 1건 이상이고 대역에 닿은 수가 5 이하다. 5개 묶음은 결과를 진단으로만 남긴다(계획 '시험 결과' 참고).
test('V-T43 ① 동시 상한까지는 503이 없고 동시 + 보류 상한을 넘은 요청은 503이다(보류 경계의 5번째는 관찰)', async (t) => {
  const cluster = clusterOf('gw-queue-buy', 'POST', '/v1/queues/e1/entries');
  const temp = { max_connections: 4, max_requests: 4, max_pending_requests: 1 };
  assert.deepEqual(await otherBuyPolicies(), [], 'gw-queue-buy를 겨눈 다른 정책이 있어 임시 정책이 버려진다');
  // 경계가 파드마다라 파드 하나일 때만 정확히 센다(로컬 덧씌우기는 복제 1)
  assert.equal((await proxyPodsOf('gw-queue')).length, 1, '시험 바탕: gw-queue 프록시 파드가 하나가 아니다');
  let four;
  let five;
  let six;
  try {
    await applyObject(kPolicy(4, 1));
    await waitLimits('gw-queue', [[cluster, temp]]);
    // 150ms 간격으로 보낸다(앞 요청의 업스트림 연결이 선 뒤 다음 요청이 온다). 묶음마다 빈 연결 묶음에서 시작한다: 대역 백엔드(Node http)는 쉬는 연결을
    // 5초 뒤 닫으므로 7초 기다린다(앞 묶음의 쉬는 연결이 남으면 넘침 꼴이 바뀌었다, 2026-11-18 실측)
    await sleep(7000);
    four = await queueBurst(4, 150);
    await sleep(7000);
    five = await queueBurst(5, 150);
    await sleep(7000);
    six = await queueBurst(6, 150);
  } finally {
    await removeKPolicy(cluster, temp);
  }
  for (const [label, rs] of [
    ['4개', four],
    ['5개', five],
    ['6개', six],
  ])
    assert.equal(rs.filter((r) => r.status === 0).length, 0, `${label}: 시험 바탕 모자람(연결 오류) ${JSON.stringify(statusCounts(rs))}`);
  t.diagnostic(`보류 경계 5개: ${five.map((r) => r.status).join(',')} / 6개: ${six.map((r) => r.status).join(',')}`);
  assert.equal(four.filter((r) => r.status === 503).length, 0, `동시 상한 4개에 503이 있다 ${JSON.stringify(statusCounts(four))}`);
  assert.equal(four.filter((r) => r.echo && r.status < 400).length, 4, `4개가 모두 대역에 닿지 않았다 ${JSON.stringify(statusCounts(four))}`);
  // 6개: 앞 4개는 동시 상한 안이라 닿고, 동시 + 보류(5)를 넘으므로 503이 1건 이상이며 대역에 닿은 수는 5 이하다(503도 대역 응답도 아닌 것은 없다)
  const order = six.map((r) => r.status).join(',');
  assert.deepEqual(six.slice(0, 4).map((r) => r.echo && r.status < 400), [true, true, true, true], `6개의 앞 4개 ${order}`);
  const six503 = six.filter((r) => r.status === 503 && !r.echo).length;
  const sixEcho = six.filter((r) => r.echo && r.status < 400).length;
  assert.ok(six503 >= 1, `동시 + 보류를 넘는 6개에 503이 없다 ${order}`);
  assert.ok(sixEcho <= 5, `6개 가운데 대역에 닿은 수 ${sixEcho} > 동시 + 보류 5 ${order}`);
  assert.equal(six503 + sixEcho, 6, `503도 대역 응답도 아닌 것이 있다 ${order}`);
});

// 리뷰 반영 R3(BAT-056): 관제 SSE 두 규칙은 규칙을 겨눈 정책 gw-ops-long-hold(mergeType: StrategicMerge)가 상한만 덮는다. 게이트웨이 정책 gw-ops-responses의 응답 고치기
// (대상 거절 403 → 401·WWW-Authenticate, 오류 응답의 보안 머리, 503 Problem·Retry-After: 2)가 그 규칙에도 닿는지를 소스 읽기가 아니라 kind에서 본다.
// 값(401 Unauthorized, WWW-Authenticate Bearer error="invalid_token", HSTS, nosniff, CSP, Retry-After 2)은 정본 docs/infra.md §4.1 '게이트웨이 오류의 Problem'·'게이트웨이 차단 상한'.
test('V-T43 ② R3 관제 SSE 두 규칙에도 게이트웨이 응답 고치기가 닿는다', async () => {
  const sub = nextSub();
  const wrongAud = token(c, 'admin', { sub, sid: `s-${sub}`, aud: 'partner', scope: c.probes['gw-ops'].scope ?? '' });
  for (const path of ['/v1/ops/live', `/v1/ops/events/e-${RUN}/live`]) {
    const r = await send(c, 'ops-api', { path, headers: edge(c, '203.0.113.57', { authorization: `Bearer ${wrongAud}` }) });
    const at = `대상이 다른 토큰 GET ${path}`;
    assert.equal(r.status, 401, `${at}: ${r.status} ${r.text.slice(0, 200)}`);
    assert.match(String(r.headers['content-type'] ?? ''), /^application\/problem\+json\b/, `${at}: 형식`);
    assert.deepEqual(JSON.parse(r.text), { type: 'about:blank', title: 'Unauthorized', status: 401 }, `${at}: 본문`);
    assert.equal(r.headers['www-authenticate'], 'Bearer error="invalid_token"', `${at}: WWW-Authenticate`);
    assert.equal(r.headers['strict-transport-security'], HSTS, `${at}: HSTS`);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', `${at}: nosniff`);
    assert.equal(r.headers['content-security-policy'], API_CSP, `${at}: CSP`);
    assert.throws(() => echoed(r), `${at}: 대역 백엔드에 닿았다`);
  }
  // 상한을 넘은 SSE 요청: gw-ops-long-hold의 세 칸을 잠깐 1로 고쳐 같은 규칙에 2초 넘게 쥐는 요청 셋을 200ms 간격으로 연다(끝나면 되돌리고 65,536으로 돌아올 때까지 기다린다)
  const live = clusterOf('gw-ops-api', 'GET', '/v1/ops/live');
  const eventLive = clusterOf('gw-ops-api', 'GET', '/v1/ops/events/e1/live');
  const original = clean(JSON.parse(await kubectl(['-n', NS(), 'get', 'backendtrafficpolicies', 'gw-ops-long-hold', '-o', 'json'], { quiet: true, timeout: 30_000 })));
  let rs;
  try {
    const one = structuredClone(original);
    one.spec.circuitBreaker = { maxConnections: 1, maxParallelRequests: 1, maxPendingRequests: 1 };
    await applyObject(one);
    await waitLimits('gw-ops', [[live, { max_connections: 1, max_requests: 1, max_pending_requests: 1 }]]);
    await sleep(7000);
    const tv = accessToken(c, 'gw-ops', nextSub());
    rs = await Promise.all(
      [0, 1, 2].map(async (i) => {
        await sleep(i * 200);
        return send(c, 'ops-api', { path: '/v1/ops/live', headers: edge(c, '203.0.113.58', { authorization: `Bearer ${tv}`, 'x-e2e-delay-ms': '4000' }), timeoutMs: 30_000 });
      }),
    );
  } finally {
    await applyObject(original);
    await waitLimits('gw-ops', [
      [live, LONG_HOLD_LIMITS],
      [eventLive, LONG_HOLD_LIMITS],
    ]);
  }
  const order = rs.map((r) => r.status).join(',');
  assert.equal(rs[0].status, 200, `첫 요청: ${order}`);
  echoed(rs[0]);
  const s503 = rs.filter((r) => r.status === 503);
  assert.ok(s503.length >= 1, `상한 1을 넘은 SSE 요청에 503이 없다 ${order}`);
  for (const [i, r] of s503.entries()) {
    assert.equal(r.headers['retry-after'], RETRY_AFTER_503, `SSE 503 #${i}: Retry-After ${r.headers['retry-after']}`);
    assert.match(String(r.headers['content-type'] ?? ''), /^application\/problem\+json\b/, `SSE 503 #${i}: 형식`);
    assert.deepEqual(JSON.parse(r.text), { type: 'about:blank', title: TITLE[503], status: 503 }, `SSE 503 #${i}: 본문`);
    assert.equal(r.headers['strict-transport-security'], HSTS, `SSE 503 #${i}: HSTS`);
    assert.throws(() => echoed(r), `SSE 503 #${i}: 대역 백엔드에 닿았다`);
  }
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
