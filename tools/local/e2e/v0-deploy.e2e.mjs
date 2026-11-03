// v0 배포의 kind 확인(docs/infra.md §3 'v0 배포'의 '확인', wbs 1.1.4, K6·K9의 v0, BUILD_ORDER BSL-050).
// 실제 kind에 올린 v0(입구 v0-gateway → 앱 v0-monolith, PG 시뮬레이터, peaket-local의 Valkey·PostgreSQL)에
// 이 PC에서 입구 포트 전달(https://127.0.0.1:8443)로 닿아 본다:
// - 입구를 거친 v0 흐름(진입 → 입장 → 좌석 → 홀드 → 주문 → 결제 → 검표)과 변경분 wss
// - 입구가 하는 일: TLS, 신원 머리 지우기, 토큰 검증, 쿠키 쓰기의 Origin, IP 레이트 리밋(K6, wss 업그레이드 포함), 응답 보안 머리, 관리 포트 지표
// - 앱 포트 막기(NetworkPolicy): 입구 라벨을 단 다른 네임스페이스 파드와 같은 네임스페이스의 입구가 아닌 파드는 앱 포트·관리 포트에 못 닿고,
//   입구 파드는 앱 포트에, observability 네임스페이스(있을 때)는 관리 포트에만 닿는다
// - kubectl은 동기로 불러 멈추면 시험 한도가 끼어들지 못하므로 부를 때마다 시간 한도(kc)를 준다
// - CPU HPA(K9의 v0): CPU 부하에 복제본이 늘고 새 파드가 준비되기까지의 시간선을 찍는다(복제 수를 바꾸므로 마지막에 둔다)
// 앱 포트는 입구만 닿으므로 준비(회차 열기·가격·스태프 배정)와 결제창 인증(시뮬레이터 시험용 인증)은 앱 파드 안에서 kubectl exec로 한다.
// 회차는 실행마다 새로 만들고 지우지 않는다(다른 실행과 섞이지 않는다). 토큰은 cluster.mjs v0가 쓰는 시험 키 파일로 만든다.
// 가상 사용자마다 X-Forwarded-For에 다른 IP를 붙인다(입구는 앞단 프록시 한 겹을 믿는다). 레이트 리밋 시험만 한 IP로 몰아 보낸다.
// 실행(저장소 뿌리): node tools/local/cluster.mjs up && node tools/local/cluster.mjs v0 && node --test tools/local/e2e/v0-deploy.e2e.mjs
// (cluster.mjs v0-forward가 이미 8443을 쓰고 있으면 그 포트 전달을 쓴다. 다른 로컬 포트는 PEAKET_V0_E2E_PORT로 고른다)
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { X509Certificate, createHash, createHmac, createPrivateKey, randomBytes, sign as cryptoSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { KUBECONFIG, V0_ALLOWED_ORIGINS, V0_FORWARD_PORT, V0_NAMESPACE, kubectl, v0ForwardArgs } from '../cluster.mjs';
import { DEFAULT_ROOT, ensureTool } from '../tools.mjs';
import { generateV0TokenKey, loadOrCreateV0TokenKey, signV0Token } from '../v0-token.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const NS = V0_NAMESPACE;
const PORT = Number(process.env.PEAKET_V0_E2E_PORT || V0_FORWARD_PORT);
const KEY_FILE = join(DEFAULT_ROOT, 'v0-token-key.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 배포 값(deploy/envs/local/*.yaml)에서 읽는 기준 ----
const GATEWAY_VALUES = parseYaml(readFileSync(join(REPO, 'deploy', 'envs', 'local', 'v0-gateway.yaml'), 'utf8'));
const MONOLITH_VALUES = parseYaml(readFileSync(join(REPO, 'deploy', 'envs', 'local', 'v0-monolith.yaml'), 'utf8'));
const RATE = Number(GATEWAY_VALUES.env.PEAKET_V0_RATE_PER_SECOND);
const BURST = Number(GATEWAY_VALUES.env.PEAKET_V0_RATE_BURST);
const TRUSTED_HOPS = Number(GATEWAY_VALUES.env.PEAKET_V0_TRUSTED_PROXY_HOPS);
const AUTOSCALING = MONOLITH_VALUES.service.autoscaling;
const [ORIGIN, ORIGIN_2] = V0_ALLOWED_ORIGINS.split(',').map((s) => s.trim());

/** 입구 규칙 값(docs/infra.md §3 'v0 배포' 입구가 하는 일 3·6) */
const ACCESS_COOKIE = '__Secure-peaket_at';
const HSTS = 'max-age=31536000; includeSubDomains';
const PROBLEM = /^application\/problem\+json/;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** 자기 서명 인증서를 신뢰 앵커로 받지 못할 때의 오류(이때는 Secret의 인증서 지문으로 고정한다) */
const TRUST_ERRORS = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_UNTRUSTED', 'INVALID_CA']);

// ---- 실행마다 새 값 ----
const RUN_ID = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const EVENT = `e2e-${RUN_ID}`;
const IP_OCTET = 1 + (randomBytes(1)[0] % 250);
let ipCounter = 0;
/** 가상 사용자 IP(10.x.y.z). 실행마다 둘째 자리를 바꾼다 */
const nextIp = () => {
  ipCounter += 1;
  return `10.${IP_OCTET}.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
};
const IP_PROBE = nextIp();
const PRICES = { VIP: 170000, R: 150000, S: 130000 };
const GRID = { sections: ['A', 'B', 'C'], rows: 4, perRow: 10, grades: { A: 'VIP', B: 'R', C: 'S' } };
const PER_PERSON_LIMIT = 4;
const STAFF_SUB = `acc-e2e-${RUN_ID}-staff`;
const BURN_MARK = 'peaket-e2e-cpu-burn';
const BURN_MS = 150_000;

// ---- 공유 상태(before에서 채운다) ----
let KEY; // { privateJwk, jwks }
const TLS_INFO = { certPem: '', fingerprint256: '' };
let tlsMode = 'ca'; // 'ca': Secret의 인증서를 신뢰 앵커로, 'pin': 지문 고정
let forward;
let forwardLog = '';
let lastProbeError;
// 시험마다 새로 만든다(beforeEach): kubectl 포트 전달이 끊긴 통로를 탄 옛 연결을 다음 시험이 다시 쓰지 않게(2026-11-03, Windows kubectl의 'error forwarding port')
let agent = new https.Agent({ keepAlive: true, maxSockets: 16 });
const burners = new Set();
let burnPod;
const probePods = new Set();

// ───────────── 작은 도구 ─────────────

async function until(what, cond, ms, every = 500) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try {
      const v = await cond();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() > end) throw new Error(`기다림 한도(${ms}ms): ${what}${last ? ` (마지막 오류: ${last.message})` : ''}`);
    await sleep(every);
  }
}

/**
 * kubectl은 동기(execFileSync)로 돌아, 멈추면 node:test의 시간 한도가 끼어들지 못하고 시험 전체가 멈춘다.
 * 그래서 부를 때마다 시간 한도를 준다(넘으면 kubectl을 끝내고 던진다)
 */
const KUBECTL_TIMEOUT_MS = 90_000;
const kc = (args, o = {}) => kubectl(args, { timeout: KUBECTL_TIMEOUT_MS, ...o });

const getJson = async (args) => JSON.parse(await kc([...args, '-o', 'json'], { quiet: true }));
const b64json = (v) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');
const b64u = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v), 'utf8').toString('base64url');
const show = (r) => `${r.status} ${String(r.text ?? '').slice(0, 600)}`;

/** 파드 안에서 Node 스크립트를 표준 입력으로 돌리고 '@@RESULT <JSON>' 줄을 읽는다(인자 따옴표 문제를 피한다) */
async function inPod(target, script, { module = true, namespace = NS, timeoutMs = KUBECTL_TIMEOUT_MS } = {}) {
  const out = await kc(['-n', namespace, 'exec', '-i', target, '--', 'node', ...(module ? ['--input-type=module'] : [])], { input: script, quiet: true, timeout: timeoutMs });
  const m = /^@@RESULT (.*)$/m.exec(out);
  if (!m) throw new Error(`${target} 안 스크립트에 결과 줄이 없다:\n${out.slice(-2000)}`);
  return JSON.parse(m[1]);
}

/** 입구 관리 포트의 /metrics 본문(입구 파드 안에서 읽는다) */
const gatewayMetrics = () =>
  kc(['-n', NS, 'exec', 'deploy/v0-gateway', '--', 'node', '-e', "fetch('http://127.0.0.1:9464/metrics').then(r=>r.text()).then(t=>process.stdout.write(t))"], { quiet: true });

/** Prometheus 글 형식에서 이름과 라벨이 맞는 줄의 합(없으면 0) */
function metricSum(text, name, labels = {}) {
  let sum = 0;
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_:][\w:]*)(?:\{([^}]*)\})?\s+(\S+)/.exec(line);
    if (!m || m[1] !== name) continue;
    const got = Object.fromEntries([...(m[2] ?? '').matchAll(/([A-Za-z_]\w*)="((?:[^"\\]|\\.)*)"/g)].map((x) => [x[1], x[2]]));
    if (Object.entries(labels).every(([k, v]) => got[k] === v)) sum += Number(m[3]);
  }
  return sum;
}

async function diagnostics(label) {
  console.log(`# ---- 진단: ${label} ----`);
  const showCmd = async (title, args, tail = 4000) => {
    try {
      console.log(`# ${title}\n${(await kc(args, { quiet: true, timeout: 20_000 })).slice(-tail)}`);
    } catch (err) {
      console.log(`# ${title}: 읽지 못함 (${String(err.message).slice(0, 300)})`);
    }
  };
  await showCmd('v0 자원', ['-n', NS, 'get', 'deploy,pods,svc,hpa,networkpolicy', '-o', 'wide']);
  await showCmd('v0 사건(최근)', ['-n', NS, 'get', 'events', '--sort-by=.lastTimestamp']);
  await showCmd('입구 로그(끝)', ['-n', NS, 'logs', 'deploy/v0-gateway', '--tail=40']);
  await showCmd('앱 로그(끝)', ['-n', NS, 'logs', 'deploy/v0-monolith', '--tail=40']);
  console.log(`# 포트 전달 출력(끝):\n${forwardLog.slice(-2000)}`);
  if (lastProbeError) console.log(`# 마지막 연결 확인 오류: ${lastProbeError.code ?? ''} ${lastProbeError.message}`);
}

/** 실패하면 클러스터 상태를 찍고 다시 던진다 */
function e2e(name, options, fn) {
  test(name, options, async (t) => {
    try {
      await fn(t);
    } catch (err) {
      await diagnostics(name).catch(() => {});
      throw err;
    }
  });
}

// ───────────── HTTPS(입구) ─────────────

const tlsOptions = () => (tlsMode === 'ca' ? { ca: TLS_INFO.certPem, servername: 'localhost' } : { rejectUnauthorized: false, servername: 'localhost' });

/** 지문 고정 방식일 때 새 TLS 연결마다 입구 인증서가 Secret의 것인지 본다 */
function pin(socket) {
  if (tlsMode !== 'pin' || socket.peaketPinned) return;
  socket.peaketPinned = true;
  socket.once('secureConnect', () => {
    const fp = socket.getPeerCertificate()?.fingerprint256;
    if (fp !== TLS_INFO.fingerprint256) socket.destroy(new Error(`입구 인증서 지문이 Secret v0-gateway의 것과 다르다: ${fp}`));
  });
}

/**
 * 입구에 HTTPS 요청 하나. user가 있으면 그 토큰을 액세스 쿠키로 싣고 그 사람의 IP를 X-Forwarded-For로 붙인다
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, text: string, json: any }>}
 */
function call(method, path, o = {}) {
  const headers = { accept: 'application/json', 'x-forwarded-for': o.ip ?? o.user?.ip ?? IP_PROBE, ...(o.headers ?? {}) };
  const token = 'token' in o ? o.token : o.user?.token;
  if (token) headers.cookie = `${ACCESS_COOKIE}=${token}`;
  if (o.origin) headers.origin = o.origin;
  let payload;
  if (o.body !== undefined) {
    payload = Buffer.from(JSON.stringify(o.body), 'utf8');
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(payload.length);
  } else if (method !== 'GET' && method !== 'HEAD') {
    headers['content-length'] = '0';
  }
  return new Promise((resolveCall, reject) => {
    const req = https.request(
      { host: '127.0.0.1', port: PORT, method, path, headers, agent: o.agent ?? agent, timeout: o.timeoutMs ?? 30_000, ...tlsOptions() },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          if (/json/.test(res.headers['content-type'] ?? '')) {
            try {
              json = JSON.parse(text);
            } catch {
              json = undefined;
            }
          }
          resolveCall({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on('socket', pin);
    req.on('timeout', () => req.destroy(Object.assign(new Error(`${method} ${path}: 응답 기다림 한도`), { code: 'E2E_TIMEOUT' })));
    req.on('error', (err) => {
      // 다시 쓴 연결이 그 사이 닫혔으면(포트 전달·유휴 닫힘) 안전한 읽기만 새 연결로 한 번 더 보낸다(Node 문서 request.reusedSocket의 권고).
      // 쓰기는 다시 보내지 않는다(두 번 적용될 수 있다)
      if (req.reusedSocket && err.code === 'ECONNRESET' && (method === 'GET' || method === 'HEAD') && !o.retried) {
        resolveCall(call(method, path, { ...o, agent: new https.Agent({ keepAlive: false }), retried: true }));
        return;
      }
      reject(err);
    });
    req.end(payload);
  });
}

/** 입구가 HTTP로 답하는지(아무 상태든) */
async function probe() {
  try {
    const r = await call('GET', '/v0/e2e-ping', { ip: IP_PROBE, timeoutMs: 5_000 });
    lastProbeError = undefined;
    return r.status > 0;
  } catch (err) {
    lastProbeError = err;
    if (tlsMode === 'ca' && TRUST_ERRORS.has(err.code)) {
      // 자체 서명 인증서를 신뢰 앵커로 받지 못하는 꼴(예: keyUsage에 keyCertSign이 없음). 같은 인증서인지는 지문으로 본다
      console.log(`# 알림: Secret의 인증서를 신뢰 앵커로 검증하지 못했다(${err.code}). 이후 연결은 그 인증서의 지문으로 고정한다`);
      tlsMode = 'pin';
    }
    return false;
  }
}

async function startForward() {
  const k = await ensureTool('kubectl');
  const child = spawn(k, ['--kubeconfig', KUBECONFIG, ...v0ForwardArgs(PORT)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  forward = child;
  const keep = (b) => {
    forwardLog = (forwardLog + b.toString()).slice(-8000);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.on('error', (err) => keep(Buffer.from(`포트 전달을 띄우지 못했다: ${err.message}\n`)));
  const end = Date.now() + 60_000;
  for (;;) {
    if (await probe()) break;
    if (child.exitCode !== null && !(await probe())) {
      throw new Error(`입구 포트 전달이 끝났고 https://127.0.0.1:${PORT}가 답하지 않는다(이미 다른 프로그램이 그 포트를 쓰면 PEAKET_V0_E2E_PORT로 바꾼다):\n${forwardLog.slice(-1500)}`);
    }
    if (Date.now() > end) throw new Error(`입구 포트 전달 기다림 한도: ${lastProbeError?.code ?? ''} ${lastProbeError?.message ?? ''}\n${forwardLog.slice(-1500)}`);
    await sleep(500);
  }
  if (child.exitCode !== null) console.log(`# 알림: 이 시험의 포트 전달은 끝났지만 ${PORT}가 답한다. 이미 떠 있는 포트 전달(cluster.mjs v0-forward)을 쓴다`);
}

/** 포트 전달이 살아 있고 입구가 답하는지 본다. 끊겼으면 다시 띄운다(연결 재설정 뒤 kubectl port-forward가 끝나는 일이 있다) */
async function ensureForward() {
  if (await probe()) return;
  if (forward && forward.exitCode === null) forward.kill();
  forward = undefined;
  await startForward();
}

// ───────────── 사람·토큰 ─────────────

/**
 * 시험 사람 하나: 계정(sub)·세션(sid)·사람(pid)과 그 IP, 팬 액세스 토큰
 * @param {string} name @param {{ pid?: boolean, scope?: string }} [o]
 */
function newUser(name, o = {}) {
  const u = { name, sub: `acc-e2e-${RUN_ID}-${name}`, sid: `s-e2e-${RUN_ID}-${name}`, pid: o.pid === false ? undefined : `pid-e2e-${RUN_ID}-${name}`, ip: nextIp() };
  u.token = signV0Token(KEY.privateJwk, { sub: u.sub, sid: u.sid, scope: o.scope ?? 'ticket:buy', ...(u.pid ? { pid: u.pid } : {}) });
  return u;
}

/** 머리·본문을 그대로 쓴 ES256 토큰(틀린 토큰을 만들 때) */
function rawToken(header, payload, privateJwk = KEY.privateJwk) {
  const input = `${b64u(header)}.${b64u(payload)}`;
  const { kty, crv, x, y, d } = privateJwk;
  const sig = cryptoSign('sha256', Buffer.from(input), { key: createPrivateKey({ key: { kty, crv, x, y, d }, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64url')}`;
}

const decodePart = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

// ───────────── v0 흐름 도우미 ─────────────

const seatsPath = () => `/v0/events/${EVENT}/seats`;

/** 진입(201)부터 입장 확정 ADMITTED까지 */
async function admit(user) {
  const entry = await call('POST', `/v1/queues/${EVENT}/entries`, { user, origin: ORIGIN });
  assert.equal(entry.status, 201, `진입 ${user.name}: ${show(entry)}`);
  return waitAdmitted(user);
}

/** 입장 확정을 ADMITTED가 될 때까지 다시 부른다(입장 루프가 0.25초마다 돈다) */
async function waitAdmitted(user) {
  let last;
  const started = Date.now();
  await until(
    `입장 ${user.name}`,
    async () => {
      last = await call('POST', `/v1/queues/${EVENT}/admission`, { user, origin: ORIGIN });
      assert.equal(last.status, 200, `입장 확정 ${user.name}: ${show(last)}`);
      assert.ok(['ADMITTED', 'NOT_YET'].includes(last.json?.status), show(last));
      return last.json.status === 'ADMITTED';
    },
    20_000,
    300,
  ).catch((err) => {
    throw new Error(`${err.message} / 마지막 응답 ${last ? show(last) : '(없음)'}`);
  });
  return { ms: Date.now() - started, body: last.json };
}

/** 좌석 목록에서 고른 구역·열의 빈 좌석 n개 */
async function availableSeats(user, section, row, n) {
  const r = await call('GET', seatsPath(), { user });
  assert.equal(r.status, 200, `좌석 목록 ${user.name}: ${show(r)}`);
  const seats = r.json.seats.filter((s) => s.section === section && s.row === row && s.status === 'AVAILABLE').slice(0, n);
  assert.equal(seats.length, n, `${section}구역 ${row}열에 빈 좌석이 ${n}개 없다`);
  return seats;
}

/** 시뮬레이터 시험용 결제창 인증(POST /sim/authenticate, 시험 키 기본 인증). 시뮬레이터는 네임스페이스 v0 안에만 있어 앱 파드 안에서 부른다 */
async function simAuthenticate(order) {
  const p = { orderId: order.orderId, amount: order.amount, orderName: order.orderName };
  const r = await inPod(
    'deploy/v0-monolith',
    `const p = JSON.parse(Buffer.from('${b64json(p)}', 'base64').toString('utf8'));
const authorization = 'Basic ' + Buffer.from(process.env.PG_SIMULATOR_SECRET_KEY + ':').toString('base64');
const r = await fetch(process.env.PEAKET_V0_PG_URL + '/sim/authenticate', {
  method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(p), signal: AbortSignal.timeout(10000),
});
process.stdout.write('@@RESULT ' + JSON.stringify({ status: r.status, body: await r.text() }) + '\\n');
`,
  );
  assert.equal(r.status, 200, `시뮬레이터 결제창 인증: ${r.status} ${r.body}`);
  const { paymentKey } = JSON.parse(r.body);
  assert.equal(typeof paymentKey, 'string');
  return paymentKey;
}

/** 회차 열기·좌석·가격·검표 스태프 배정(모듈 공개 함수, 앱 파드 안에서. docs/features/*.md의 v0 절 '모듈 공개 함수') */
function seedScript() {
  const p = { eventId: EVENT, staff: [STAFF_SUB], prices: PRICES, grid: GRID, perPersonLimit: PER_PERSON_LIMIT, admitPerSecond: 1000 };
  return `import { createDatabase } from '@peaket/platform';
import { createBookingAdmin } from './dist/modules/booking/index.js';
import { createSeatAdmin, seatGrid } from './dist/modules/inventory/index.js';
import { createQueueAdmin } from './dist/modules/queue/index.js';
import { createTicketAdmin } from './dist/modules/ticket/index.js';
import { createV0Redis } from './dist/redis.js';
const p = JSON.parse(Buffer.from('${b64json(p)}', 'base64').toString('utf8'));
const redis = await createV0Redis(process.env.PEAKET_V0_REDIS_URL);
const database = createDatabase({ url: process.env.PEAKET_V0_DATABASE_URL, applicationName: 'v0-e2e-seed' });
try {
  await createQueueAdmin(redis).open(p.eventId, { admitPerSecond: p.admitPerSecond });
  const seats = seatGrid(p.grid);
  await createSeatAdmin(database).open(p.eventId, { perPersonLimit: p.perPersonLimit }, seats);
  await createBookingAdmin(database).setPrices(p.eventId, p.prices);
  await createTicketAdmin(database).assignStaff(p.eventId, p.staff);
  process.stdout.write('@@RESULT ' + JSON.stringify({ eventId: p.eventId, seats: seats.length }) + '\\n');
} finally {
  await redis.close();
  await database.close();
}
setTimeout(() => process.exit(0), 2000).unref();
`;
}

// ───────────── WebSocket(wss, RFC 6455 최소 클라이언트) ─────────────

class WsReader {
  constructor(socket, initial) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.messages = [];
    this.waiters = [];
    this.closed = false;
    socket.on('data', (c) => this.push(c));
    socket.on('error', () => {});
    socket.on('close', () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w.reject(new Error('WebSocket 연결이 닫혔다'));
    });
    if (initial.length > 0) this.push(initial);
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      const masked = (b1 & 0x80) !== 0;
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) return;
      const payload = Buffer.from(this.buf.subarray(off + maskLen, off + maskLen + len));
      if (masked) for (let i = 0; i < payload.length; i += 1) payload[i] ^= this.buf[off + (i % 4)];
      this.buf = this.buf.subarray(off + maskLen + len);
      this.frame((b0 & 0x80) !== 0, b0 & 0x0f, payload);
    }
  }

  frame(fin, opcode, payload) {
    if (opcode === 0x9) return this.send(0xa, payload); // ping → pong
    if (opcode === 0xa) return undefined;
    if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : undefined;
      this.deliver({ close: code });
      try {
        this.send(0x8, payload.subarray(0, 2));
      } catch {
        // 이미 닫힘
      }
      this.socket.end();
      return undefined;
    }
    this.fragments.push(payload);
    if (!fin) return undefined;
    const data = Buffer.concat(this.fragments);
    this.fragments = [];
    this.deliver({ text: data.toString('utf8') });
    return undefined;
  }

  deliver(m) {
    const w = this.waiters.shift();
    if (w) w.resolve(m);
    else this.messages.push(m);
  }

  /** 다음 메시지(글이나 닫힘) */
  next(timeoutMs) {
    if (this.messages.length > 0) return Promise.resolve(this.messages.shift());
    if (this.closed) return Promise.reject(new Error('WebSocket 연결이 닫혔다'));
    return new Promise((res, rej) => {
      const w = {
        resolve: (m) => {
          clearTimeout(timer);
          res(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          rej(e);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        rej(new Error(`WebSocket 메시지 기다림 한도(${timeoutMs}ms)`));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  /** 클라이언트 프레임은 가린다(RFC 6455 §5.3) */
  send(opcode, payload = Buffer.alloc(0)) {
    const mask = randomBytes(4);
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | opcode, 0x80 | len]);
    else {
      head = Buffer.alloc(4);
      head[0] = 0x80 | opcode;
      head[1] = 0x80 | 126;
      head.writeUInt16BE(len, 2);
    }
    const body = Buffer.from(payload);
    for (let i = 0; i < len; i += 1) body[i] ^= mask[i % 4];
    this.socket.write(Buffer.concat([head, mask, body]));
  }

  close() {
    if (this.socket.destroyed) return;
    try {
      const p = Buffer.alloc(2);
      p.writeUInt16BE(1000, 0);
      this.send(0x8, p);
    } catch {
      // 이미 닫힘
    }
    setTimeout(() => this.socket.destroy(), 500).unref();
  }
}

/**
 * 입구에 wss 업그레이드 요청을 보낸다. 101이면 ws(WsReader)가 함께 온다
 * @returns {Promise<{ status: number, headers: Record<string, string>, ws?: WsReader }>}
 */
function wsOpen(path, o = {}) {
  return new Promise((resolveOpen, reject) => {
    const key = randomBytes(16).toString('base64');
    const socket = tls.connect({ host: '127.0.0.1', port: PORT, ALPNProtocols: ['http/1.1'], ...tlsOptions() });
    pin(socket);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`wss 핸드셰이크 기다림 한도: ${path}`));
    }, 15_000);
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      clearTimeout(timer);
      const lines = buf.subarray(0, end).toString('latin1').split('\r\n');
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? '')?.[1] ?? 0);
      const headers = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      if (status !== 101) {
        socket.destroy();
        resolveOpen({ status, headers });
        return;
      }
      const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
      if (headers['sec-websocket-accept'] !== accept) {
        socket.destroy();
        reject(new Error(`Sec-WebSocket-Accept가 맞지 않는다: ${headers['sec-websocket-accept']}`));
        return;
      }
      resolveOpen({ status, headers, ws: new WsReader(socket, buf.subarray(end + 4)) });
    };
    socket.on('data', onData);
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.once('secureConnect', () => {
      const h = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${PORT}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        `X-Forwarded-For: ${o.ip ?? o.user?.ip ?? IP_PROBE}`,
      ];
      if (o.origin) h.push(`Origin: ${o.origin}`);
      const token = 'token' in o ? o.token : o.user?.token;
      if (token) h.push(`Cookie: ${ACCESS_COOKIE}=${token}`);
      socket.write(`${h.join('\r\n')}\r\n\r\n`);
    });
  });
}

/** 조건에 맞는 변경분이 올 때까지 읽는다(다른 변경분은 건너뛴다) */
async function waitDelta(ws, match, ms) {
  const end = Date.now() + ms;
  const seen = [];
  for (;;) {
    const left = end - Date.now();
    if (left <= 0) throw new Error(`기다린 변경분이 오지 않았다. 받은 것: ${JSON.stringify(seen).slice(0, 800)}`);
    const m = await ws.next(left);
    if (m.close !== undefined) throw new Error(`변경분 연결이 닫혔다(코드 ${m.close}). 받은 것: ${JSON.stringify(seen).slice(0, 800)}`);
    const d = JSON.parse(m.text);
    seen.push(d);
    if (match(d)) return d;
  }
}

// ───────────── 준비·정리 ─────────────

before(
  async () => {
    await ensureTool('kubectl');
    assert.equal(TRUSTED_HOPS, 1, '이 시험은 입구가 X-Forwarded-For 한 겹을 믿을 때(PEAKET_V0_TRUSTED_PROXY_HOPS=1) 가상 사용자마다 IP를 붙인다');
    for (const d of ['v0-gateway', 'v0-monolith', 'pg-simulator']) {
      await kc(['-n', NS, 'rollout', 'status', `deploy/${d}`, '--timeout=180s'], { quiet: true, timeout: 200_000 }).catch(async (err) => {
        await diagnostics(`${d} 준비 안 됨`).catch(() => {});
        throw new Error(`deploy/${d}가 준비되지 않았다(node tools/local/cluster.mjs v0를 먼저): ${err.message}`);
      });
    }
    // 입구 인증서(Secret v0-gateway의 PEAKET_V0_TLS_CERT). 개인키는 읽지 않는다
    const certB64 = (await kc(['-n', NS, 'get', 'secret', 'v0-gateway', '-o', 'jsonpath={.data.PEAKET_V0_TLS_CERT}'], { quiet: true })).trim();
    TLS_INFO.certPem = Buffer.from(certB64, 'base64').toString('utf8');
    TLS_INFO.fingerprint256 = new X509Certificate(TLS_INFO.certPem).fingerprint256;
    // 토큰 서명 키: cluster.mjs v0가 만든 이 PC의 키 파일. 입구의 공개키 목록에 그 kid가 있어야 한다
    assert.ok(existsSync(KEY_FILE), `시험 토큰 키 파일이 없다: ${KEY_FILE} (node tools/local/cluster.mjs v0가 만든다)`);
    KEY = loadOrCreateV0TokenKey(KEY_FILE);
    const jwksB64 = (await kc(['-n', NS, 'get', 'secret', 'v0-gateway', '-o', 'jsonpath={.data.PEAKET_V0_GATEWAY_JWKS}'], { quiet: true })).trim();
    const clusterJwks = JSON.parse(Buffer.from(jwksB64, 'base64').toString('utf8'));
    assert.ok(
      clusterJwks.keys.some((k) => k.kid === KEY.privateJwk.kid),
      `이 PC의 시험 키(kid ${KEY.privateJwk.kid})가 입구 공개키 목록(${clusterJwks.keys.map((k) => k.kid).join(', ')})에 없다. node tools/local/cluster.mjs v0를 다시 돌린다`,
    );
    assert.ok(clusterJwks.keys.every((k) => !('d' in k)), '입구 공개키 목록에 개인키 칸(d)이 있다');
    // 포트 전달
    await startForward();
    // 회차 준비
    const seeded = await inPod('deploy/v0-monolith', seedScript(), { timeoutMs: 180_000 });
    assert.equal(seeded.eventId, EVENT);
    console.log(`# 준비: 회차 ${EVENT}, 좌석 ${seeded.seats}석, 검표 스태프 ${STAFF_SUB}, 입구 https://127.0.0.1:${PORT} (TLS ${tlsMode === 'ca' ? 'Secret 인증서로 검증' : '지문 고정'})`);
  },
  { timeout: 600_000 },
);

beforeEach(
  async () => {
    agent.destroy();
    agent = new https.Agent({ keepAlive: true, maxSockets: 16 });
    await ensureForward();
  },
  { timeout: 90_000 },
);

async function stopBurners() {
  for (const c of burners) if (c.exitCode === null) c.kill();
  burners.clear();
  if (!burnPod) return;
  // 원격 프로세스는 kubectl을 끊어도 남을 수 있어 표시 인자로 찾아 끈다(표시 문자열은 이 스크립트에 이어 붙여 쓰지 않는다)
  await kc(['-n', NS, 'exec', '-i', burnPod, '--', 'node'], {
    quiet: true,
    input: `const m = 'peaket-e2e-' + 'cpu-burn'; const fs = require('fs');
for (const p of fs.readdirSync('/proc')) {
  if (!/^[0-9]+$/.test(p) || Number(p) === process.pid) continue;
  try { if (fs.readFileSync('/proc/' + p + '/cmdline', 'utf8').includes(m)) process.kill(Number(p), 'SIGKILL'); } catch {}
}`,
  }).catch((err) => console.log(`# CPU 부하 프로세스 정리 실패(스스로 ${BURN_MS / 1000}초 뒤 끝난다): ${err.message}`));
  burnPod = undefined;
}

after(async () => {
  await stopBurners().catch(() => {});
  // 시험 파드는 '<네임스페이스>/<이름>'으로 남겨 둔다
  for (const key of probePods) {
    const [namespace, name] = key.split('/');
    await kc(['-n', namespace, 'delete', 'pod', name, '--ignore-not-found', '--wait=false'], { quiet: true }).catch(() => {});
  }
  if (forward && forward.exitCode === null) forward.kill();
  agent.destroy();
});

// ───────────── 시험 ─────────────

e2e('BSL050_kind_TLS_입구는HTTPS포트하나만열고_TLS1.2이상과클러스터마다만든EC_P-256자체서명인증서로받으며_평문은받지않는다 [ASVS v5.0.0-12.1.1][ASVS v5.0.0-12.2.1]', { timeout: 90_000 }, async () => {
  // 서비스는 HTTPS 포트 하나(8443)만 연다(관리 포트 9464는 서비스로 내지 않는다)
  const svc = await getJson(['-n', NS, 'get', 'svc', 'v0-gateway']);
  assert.deepEqual(svc.spec.ports.map((p) => p.port), [8443]);
  assert.equal(svc.spec.type ?? 'ClusterIP', 'ClusterIP', '입구 서비스는 클러스터 밖에 직접 열지 않는다(포트 전달로만 닿는다)');

  // 인증서: EC P-256, 30일 [가정], SAN은 localhost·127.0.0.1·입구 서비스 이름
  const cert = new X509Certificate(TLS_INFO.certPem);
  assert.equal(cert.publicKey.asymmetricKeyType, 'ec');
  assert.equal(cert.publicKey.asymmetricKeyDetails?.namedCurve, 'prime256v1');
  const san = (cert.subjectAltName ?? '').split(/,\s*/);
  for (const name of ['DNS:localhost', 'IP Address:127.0.0.1']) assert.ok(san.includes(name), `${name}이 SAN(${cert.subjectAltName})에 없다`);
  const days = (cert.validToDate.getTime() - cert.validFromDate.getTime()) / 86_400_000;
  assert.ok(days > 1 && days <= 30.01, `유효 기간 ${days}일`);
  assert.ok(cert.validToDate.getTime() > Date.now(), `입구 인증서가 만료됐다(${cert.validTo}). cluster.mjs v0로 다시 만든다`);

  const handshake = (extra) =>
    new Promise((res, rej) => {
      const s = tls.connect({ host: '127.0.0.1', port: PORT, ...tlsOptions(), ...extra });
      const timer = setTimeout(() => {
        s.destroy();
        rej(new Error('TLS 핸드셰이크 기다림 한도'));
      }, 10_000);
      s.once('secureConnect', () => {
        clearTimeout(timer);
        const out = { protocol: s.getProtocol(), authorized: s.authorized, fingerprint256: s.getPeerCertificate().fingerprint256 };
        s.end();
        res(out);
      });
      s.once('error', (err) => {
        clearTimeout(timer);
        rej(err);
      });
    });

  // 기본: TLS 1.3을 먼저 고르고, Secret의 그 인증서를 낸다
  const def = await handshake({});
  assert.equal(def.protocol, 'TLSv1.3');
  assert.equal(def.fingerprint256, TLS_INFO.fingerprint256, '입구가 Secret v0-gateway의 인증서가 아닌 것을 냈다');
  if (tlsMode === 'ca') assert.equal(def.authorized, true);
  // TLS 1.2만 아는 클라이언트도 받는다
  const v12 = await handshake({ maxVersion: 'TLSv1.2' });
  assert.equal(v12.protocol, 'TLSv1.2');

  // 거절 시험은 포트 전달이 끊겨 생긴 연결 거부(ECONNREFUSED)를 입구의 거절로 잘못 세지 않게, 포트 전달을 살린 뒤 한 번 더 해 본다
  const decisive = async (attempt) => {
    await ensureForward();
    let r = await attempt();
    if (r.code === 'ECONNREFUSED') {
      await ensureForward();
      r = await attempt();
    }
    assert.notEqual(r.code, 'ECONNREFUSED', `포트 전달이 끊겨 판정하지 못했다:\n${forwardLog.slice(-800)}`);
    return r;
  };

  // TLS 1.1 이하는 맺지 않는다(클라이언트가 1.1을 보낼 수 있게 보안 수준을 낮춰 시도한다)
  const v11 = await decisive(() =>
    handshake({ minVersion: 'TLSv1', maxVersion: 'TLSv1.1', ciphers: 'DEFAULT@SECLEVEL=0', rejectUnauthorized: false, ca: undefined }).then(
      (r) => ({ ok: true, protocol: r.protocol }),
      (err) => ({ ok: false, code: err.code, message: err.message }),
    ),
  );
  if (!v11.ok && (v11.code === 'ERR_SSL_NO_PROTOCOLS_AVAILABLE' || /no protocols available/i.test(v11.message))) {
    console.log('# 알림: 이 Node(OpenSSL)는 TLS 1.1 클라이언트 인사를 보내지 못해 입구 쪽 거절은 보지 못했다');
  } else {
    assert.equal(v11.ok, false, `TLS 1.1로 맺어졌다: ${v11.protocol}`);
    console.log(`# TLS 1.1 시도: 거절(${v11.code ?? v11.message})`);
  }

  // 평문 HTTP는 같은 포트에서도 답을 받지 못한다(평문으로 돌아가는 길이 없다)
  const plain = await decisive(
    () =>
      new Promise((res) => {
        const req = http.request({ host: '127.0.0.1', port: PORT, path: seatsPath(), method: 'GET', timeout: 5_000, headers: { 'x-forwarded-for': nextIp() } }, (r) => {
          r.resume();
          res({ status: r.statusCode });
        });
        req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'E2E_TIMEOUT' })));
        req.on('error', (err) => res({ code: err.code ?? err.message }));
        req.end();
      }),
  );
  assert.equal(plain.status, undefined, `평문 HTTP가 응답을 받았다: ${plain.status}`);
  console.log(`# 평문 HTTP 시도: ${plain.code}`);
});

e2e('BSL050_kind_입구를거친v0흐름_진입입장좌석홀드주문결제검표가HTTPS로끝까지되고_다시찍으면이미입장이다', { timeout: 180_000 }, async () => {
  const buyer = newUser('buyer');
  const staff = newUser('staff', { pid: false });
  assert.equal(staff.sub, STAFF_SUB);
  const t0 = Date.now();

  // ① 진입(queue-admission §13): 201 {seq, generation, serverTimeMs}
  const entry = await call('POST', `/v1/queues/${EVENT}/entries`, { user: buyer, origin: ORIGIN });
  assert.equal(entry.status, 201, show(entry));
  assert.ok(Number.isSafeInteger(entry.json.seq) && entry.json.seq >= 1, show(entry));
  assert.equal(entry.json.generation, 0);
  assert.ok(Number.isSafeInteger(entry.json.serverTimeMs));
  // 같은 사람이 다시 진입하면 409 already-in-queue(같은 사람의 번호는 하나)
  const again = await call('POST', `/v1/queues/${EVENT}/entries`, { user: buyer, origin: ORIGIN });
  assert.equal(again.status, 409, show(again));
  assert.ok(String(again.json?.type).endsWith('/already-in-queue'), show(again));

  // ② 입장 확정: 200 {status: ADMITTED, seq}
  const admitted = await waitAdmitted(buyer);
  assert.equal(admitted.body.seq, entry.json.seq);

  // ③ 좌석 목록(seat-hold §14 동작 1): 200 {eventId, seats}
  const list = await call('GET', seatsPath(), { user: buyer });
  assert.equal(list.status, 200, show(list));
  assert.equal(list.json.eventId, EVENT);
  assert.equal(list.json.seats.length, GRID.sections.length * GRID.rows * GRID.perRow);
  const chosen = list.json.seats.filter((s) => s.section === 'A' && s.row === '1' && s.status === 'AVAILABLE').slice(0, 2);
  assert.equal(chosen.length, 2);
  const seatIds = chosen.map((s) => s.id);

  // ④ 홀드(seat-hold §14 동작 2): 201 {holdId, seatIds, expiresAt(KST), extendable}
  const hold = await call('POST', `/v1/events/${EVENT}/holds`, { user: buyer, origin: ORIGIN, body: { seatIds } });
  assert.equal(hold.status, 201, show(hold));
  assert.deepEqual(hold.json.seatIds, seatIds);
  assert.match(hold.json.expiresAt, /\+09:00$/);
  assert.equal(hold.json.extendable, true);

  // ⑤ 주문(payment §13 동작 1): 201, 금액은 서버가 등급 가격으로 계산한다
  const order = await call('POST', '/v0/orders', { user: buyer, origin: ORIGIN, body: { holdId: hold.json.holdId } });
  assert.equal(order.status, 201, show(order));
  assert.equal(order.json.status, 'CREATED');
  assert.equal(order.json.eventId, EVENT);
  assert.equal(order.json.holdId, hold.json.holdId);
  assert.deepEqual(order.json.seatIds, seatIds);
  assert.equal(order.json.amount, chosen.reduce((sum, s) => sum + PRICES[s.grade], 0));
  assert.deepEqual(order.json.tickets, []);

  // ⑥ 결제창 인증(시뮬레이터 시험용 인증) → paymentKey
  const paymentKey = await simAuthenticate(order.json);

  // ⑦ 결제 확정(payment §13 동작 2, 동기 결제 체인): 200 CONFIRMED와 티켓 코드
  const payStarted = Date.now();
  const paid = await call('POST', `/v0/orders/${order.json.orderId}/payment`, { user: buyer, origin: ORIGIN, body: { paymentKey, amount: order.json.amount } });
  const payMs = Date.now() - payStarted;
  assert.equal(paid.status, 200, show(paid));
  assert.equal(paid.json.status, 'CONFIRMED');
  assert.equal(paid.json.orderId, order.json.orderId);
  assert.deepEqual(paid.json.tickets.map((t) => t.seatId), seatIds);
  for (const t of paid.json.tickets) {
    assert.equal(typeof t.ticketId, 'string');
    assert.match(t.code, /^[A-Za-z0-9_-]{22}$/, '티켓 코드는 128비트 난수의 base64url 22자다');
  }
  // 주문 보기(동작 3)도 같다
  const view = await call('GET', `/v0/orders/${order.json.orderId}`, { user: buyer });
  assert.equal(view.status, 200, show(view));
  assert.equal(view.json.status, 'CONFIRMED');
  assert.deepEqual(view.json.tickets, paid.json.tickets);
  // 판 좌석은 SOLD로 보인다
  const sold = await call('GET', seatsPath(), { user: buyer });
  assert.deepEqual(sold.json.seats.filter((s) => seatIds.includes(s.id)).map((s) => s.status), ['SOLD', 'SOLD']);

  // ⑧ 검표(offline-gate §13 동작 2): 배정된 스태프 계정이 찍는다
  const [ticket] = paid.json.tickets;
  const scanPath = `/v0/events/${EVENT}/scans`;
  const first = await call('POST', scanPath, { user: staff, origin: ORIGIN, body: { code: ticket.code } });
  assert.equal(first.status, 200, show(first));
  assert.equal(first.json.result, 'ADMIT');
  assert.equal(first.json.ticketId, ticket.ticketId);
  assert.equal(first.json.seatId, ticket.seatId);
  assert.match(first.json.enteredAt, /\+09:00$/);
  const second = await call('POST', scanPath, { user: staff, origin: ORIGIN, body: { code: ticket.code } });
  assert.equal(second.status, 200, show(second));
  assert.equal(second.json.result, 'ALREADY_ENTERED');
  assert.equal(second.json.ticketId, ticket.ticketId);
  assert.equal(second.json.enteredAt, first.json.enteredAt);
  // 없는 코드는 INVALID, 배정되지 않은 계정은 403 not-assigned
  const unknown = await call('POST', scanPath, { user: staff, origin: ORIGIN, body: { code: `nope${randomBytes(9).toString('hex')}` } });
  assert.equal(unknown.status, 200, show(unknown));
  assert.equal(unknown.json.result, 'INVALID');
  const notStaff = await call('POST', scanPath, { user: buyer, origin: ORIGIN, body: { code: paid.json.tickets[1].code } });
  assert.equal(notStaff.status, 403, show(notStaff));
  assert.ok(String(notStaff.json?.type).endsWith('/not-assigned'), show(notStaff));

  console.log(`# BSL050 v0 흐름: 진입 seq=${entry.json.seq}, 입장까지 ${admitted.ms}ms, 결제 확정(동기 결제 체인) ${payMs}ms, 전체 ${Date.now() - t0}ms`);
});

e2e('BSL050_kind_변경분wss_입구를거친WebSocket이다른사람의홀드와해제를받고_쿠키가없으면401_출처가없거나틀리거나입장전이면403 [ASVS v5.0.0-4.4.1][ASVS v5.0.0-4.4.2]', { timeout: 120_000 }, async () => {
  const watcher = newUser('ws-watch');
  const holder = newUser('ws-hold');
  const outsider = newUser('ws-outsider'); // 대기열에 들어오지 않았다
  await admit(watcher);
  await admit(holder);
  const path = `/v0/events/${EVENT}/seat-deltas`;

  // 거절: 쿠키 없음 401, Origin 없음·다름 403, 입장 전 403
  assert.equal((await wsOpen(path, { ip: watcher.ip, origin: ORIGIN })).status, 401);
  assert.equal((await wsOpen(path, { user: watcher })).status, 403);
  assert.equal((await wsOpen(path, { user: watcher, origin: 'https://evil.example' })).status, 403);
  assert.equal((await wsOpen(path, { user: outsider, origin: ORIGIN })).status, 403);

  // 받기: wss로 열고(101), 다른 사람의 홀드·해제 변경분이 온다(seat-hold §14 동작 6: {eventId, changes, atMs})
  const opened = await wsOpen(path, { user: watcher, origin: ORIGIN });
  assert.equal(opened.status, 101);
  const { ws } = opened;
  try {
    const [seat] = await availableSeats(holder, 'B', '1', 1);
    const held = await call('POST', `/v1/events/${EVENT}/holds`, { user: holder, origin: ORIGIN, body: { seatIds: [seat.id] } });
    assert.equal(held.status, 201, show(held));
    const sentAt = Date.now();
    const d1 = await waitDelta(ws, (d) => d.eventId === EVENT && d.changes?.some((c) => c.seatId === seat.id && c.status === 'HELD'), 15_000);
    const heldMs = Date.now() - sentAt;
    assert.ok(Number.isSafeInteger(d1.atMs));
    const released = await call('DELETE', `/v1/holds/${held.json.holdId}`, { user: holder, origin: ORIGIN });
    assert.equal(released.status, 204, show(released));
    await waitDelta(ws, (d) => d.eventId === EVENT && d.changes?.some((c) => c.seatId === seat.id && c.status === 'AVAILABLE'), 15_000);
    console.log(`# BSL050 변경분 wss: 홀드 응답 뒤 변경분까지 ${heldMs}ms`);
  } finally {
    ws.close();
  }
});

e2e('BSL050_kind_신원머리위조_쿠키없이x-user-머리를실으면입구가지워401이고_토큰에없는pid머리도지워진다 [ASVS v5.0.0-4.1.3]', { timeout: 120_000 }, async () => {
  const a = newUser('forge-a');
  await admit(a);
  const control = await call('GET', seatsPath(), { user: a });
  assert.equal(control.status, 200, `대조군(맞는 토큰): ${show(control)}`);

  // 입장한 사람의 신원 머리를 그대로 실어도 쿠키가 없으면 신원이 없다
  const forged = { 'x-user-id': a.sub, 'x-session-id': a.sid, 'x-user-aud': 'fan', 'x-user-scope': 'ticket:buy', 'x-user-pid': a.pid, 'x-user-pid-prev': a.pid };
  const lower = await call('GET', seatsPath(), { ip: a.ip, token: undefined, headers: forged });
  assert.equal(lower.status, 401, show(lower));
  assert.match(lower.headers['content-type'] ?? '', PROBLEM);
  const mixed = Object.fromEntries(Object.entries(forged).map(([k, v]) => [k.toUpperCase(), v]));
  const upper = await call('GET', seatsPath(), { ip: a.ip, token: undefined, headers: mixed });
  assert.equal(upper.status, 401, show(upper));
  // 위조 머리의 쓰기(홀드)도 401이고 좌석은 그대로다
  const [seat] = await availableSeats(a, 'C', '1', 1);
  const write = await call('POST', `/v1/events/${EVENT}/holds`, { ip: a.ip, token: undefined, headers: forged, body: { seatIds: [seat.id] } });
  assert.equal(write.status, 401, show(write));
  const still = await call('GET', seatsPath(), { user: a });
  assert.equal(still.json.seats.find((s) => s.id === seat.id).status, 'AVAILABLE');

  // 맞는 토큰이라도 토큰에 pid가 없으면 실어 보낸 x-user-pid는 지워진다(지우지 않으면 a의 입장으로 200이 된다)
  const noPid = newUser('forge-nopid', { pid: false });
  const smuggled = await call('GET', seatsPath(), { user: noPid, headers: { 'x-user-pid': a.pid } });
  assert.equal(smuggled.status, 403, `토큰에 없는 pid 머리가 앱까지 갔다: ${show(smuggled)}`);
});

e2e('BSL050_kind_토큰검증_서명변조·다른키·alg_none·HS256·유형·kid·발급자·대상·만료·nbf·칸이틀리면401이고_까닭을지표로센다 [ASVS v5.0.0-9.1.1][ASVS v5.0.0-9.1.2][ASVS v5.0.0-9.2.1][ASVS v5.0.0-9.2.3]', { timeout: 120_000 }, async () => {
  const a = newUser('token-a');
  await admit(a);
  const control = await call('GET', seatsPath(), { user: a });
  assert.equal(control.status, 200, `대조군(맞는 토큰): ${show(control)}`);

  const claims = { sub: a.sub, sid: a.sid, scope: 'ticket:buy', pid: a.pid };
  const [h, p, s] = a.token.split('.');
  const header = decodePart(h);
  const payload = decodePart(p);
  assert.deepEqual({ alg: header.alg, typ: header.typ, kid: header.kid }, { alg: 'ES256', typ: 'at+jwt', kid: KEY.privateJwk.kid });
  const nowS = Math.floor(Date.now() / 1000);
  const { kty, crv, x, y, kid } = KEY.privateJwk;
  const hsInput = `${b64u({ ...header, alg: 'HS256' })}.${p}`;
  const cases = [
    ['모양이 아님', 'malformed', 'not-a-jwt.at-all'],
    ['본문 바꿔치기', 'signature', `${h}.${b64u({ ...payload, sub: `acc-e2e-${RUN_ID}-someone-else` })}.${s}`],
    ['서명 한 글자 바꿈', 'signature', `${h}.${p}.${s[0] === 'A' ? 'B' : 'A'}${s.slice(1)}`],
    ['같은 kid의 다른 키', 'signature', signV0Token(generateV0TokenKey().privateJwk, claims, { header: { kid } })],
    ['alg none', 'alg', `${b64u({ ...header, alg: 'none' })}.${p}.`],
    // 공개키를 HMAC 비밀로 쓰는 키 혼동
    ['alg HS256(공개키로 HMAC)', 'alg', `${hsInput}.${createHmac('sha256', JSON.stringify({ kty, crv, x, y })).update(hsInput).digest('base64url')}`],
    ['typ JWT', 'typ', signV0Token(KEY.privateJwk, claims, { header: { typ: 'JWT' } })],
    ['목록에 없는 kid', 'kid', signV0Token(KEY.privateJwk, claims, { header: { kid: `unknown-${RUN_ID}` } })],
    ['다른 발급자', 'issuer', signV0Token(KEY.privateJwk, { ...claims, iss: 'https://evil.example' })],
    ['다른 대상(ops)', 'audience', signV0Token(KEY.privateJwk, { ...claims, aud: 'ops' })],
    ['만료(5분 전)', 'expired', signV0Token(KEY.privateJwk, claims, { nowMs: Date.now() - 20 * 60_000 })],
    ['nbf가 10분 뒤', 'not_yet_valid', signV0Token(KEY.privateJwk, { ...claims, nbf: nowS + 600 })],
    ['sub 1025자', 'claims', rawToken(header, { ...payload, sub: 'x'.repeat(1025) })],
  ];
  const metricsBefore = await gatewayMetrics();
  const badIp = nextIp(); // 거절 요청 13개가 a의 버킷(진입·입장 확정에 쓴)과 섞여 429가 나지 않게
  for (const [what, , token] of cases) {
    const r = await call('GET', seatsPath(), { ip: badIp, token });
    assert.equal(r.status, 401, `${what}: ${show(r)}`);
  }
  const afterText = await gatewayMetrics();
  const name = 'v0_gateway_token_rejections_total';
  const deltas = Object.fromEntries([...new Set(cases.map((c) => c[1]))].map((reason) => [reason, metricSum(afterText, name, { reason }) - metricSum(metricsBefore, name, { reason })]));
  console.log(`# BSL050 토큰 거절 까닭(이번 시험 동안 늘어난 수): ${JSON.stringify(deltas)}`);
  for (const [reason, n] of Object.entries(deltas)) assert.ok(n >= 1, `${name}{reason="${reason}"}가 늘지 않았다`);
});

e2e('BSL050_kind_출처확인_쿠키를실은쓰기의Origin이없거나다르면입구가403_about:blank이고_앱에닿지않는다 [ASVS v5.0.0-3.5.1]', { timeout: 120_000 }, async () => {
  const o = newUser('origin');
  const entries = `/v1/queues/${EVENT}/entries`;
  const metricsBefore = await gatewayMetrics();
  const bad = [undefined, 'https://evil.example', 'null', `${ORIGIN}.evil.example`, ORIGIN.replace('https:', 'http:')];
  for (const origin of bad) {
    const r = await call('POST', entries, { user: o, origin });
    assert.equal(r.status, 403, `Origin ${origin ?? '(없음)'}: ${show(r)}`);
    assert.match(r.headers['content-type'] ?? '', PROBLEM);
    assert.equal(r.json.type, 'about:blank');
    assert.equal(r.json.status, 403);
    assert.equal(r.json.title, 'Forbidden');
    assert.ok(typeof r.json.traceId === 'string' && r.json.traceId.length > 0, show(r));
  }
  // 막힌 쓰기는 앱에 닿지 않았다: 아직 대기 중이 아니다
  const status = await call('GET', `${entries}/me`, { user: o });
  assert.equal(status.status, 404, show(status));
  assert.ok(String(status.json?.type).endsWith('/not-in-queue'), show(status));
  // 허용 목록의 다른 출처는 받는다
  const ok = await call('POST', entries, { user: o, origin: ORIGIN_2 });
  assert.equal(ok.status, 201, show(ok));
  // 출처 확인은 쿠키를 실은 쓰기에만 건다: 쿠키가 없는 쓰기는 입구를 지나 앱이 401로 답한다
  const noCookie = await call('POST', entries, { ip: o.ip, token: undefined });
  assert.equal(noCookie.status, 401, show(noCookie));
  const afterText = await gatewayMetrics();
  const name = 'v0_gateway_requests_total';
  const delta = metricSum(afterText, name, { outcome: 'origin_rejected' }) - metricSum(metricsBefore, name, { outcome: 'origin_rejected' });
  assert.ok(delta >= bad.length, `${name}{outcome="origin_rejected"}가 ${delta}만 늘었다(기대 ${bad.length} 이상)`);
});

e2e('K6_BSL050_kind_IP레이트리밋_한IP가몰아보내면묶음20개뒤429와RetryAfter이고_다른IP는그때도200이며_기다리면다시통과한다 [ASVS v5.0.0-2.4.1]', { timeout: 120_000 }, async () => {
  const gw = await getJson(['-n', NS, 'get', 'deploy', 'v0-gateway']);
  assert.equal(gw.spec.replicas, 1, '입구는 복제 1 [가정]: 버킷을 입구 파드마다 따로 센다');
  const rl = newUser('ratelimit');
  const entered = await call('POST', `/v1/queues/${EVENT}/entries`, { user: rl, origin: ORIGIN });
  assert.equal(entered.status, 201, show(entered));
  const path = `/v1/queues/${EVENT}/entries/me`;
  const floodIp = nextIp();
  const otherIp = nextIp();
  const FLOOD = 50;
  const metricsBefore = await gatewayMetrics();
  const floodAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });
  let res;
  let others;
  let elapsedS;
  try {
    const started = Date.now();
    const flood = Promise.all(Array.from({ length: FLOOD }, () => call('GET', path, { user: rl, ip: floodIp, agent: floodAgent })));
    const other = (async () => {
      const out = [];
      for (let i = 0; i < 3; i += 1) out.push(await call('GET', path, { user: rl, ip: otherIp }));
      return out;
    })();
    [res, others] = await Promise.all([flood, other]);
    elapsedS = (Date.now() - started) / 1000;
  } finally {
    floodAgent.destroy();
  }
  const okN = res.filter((r) => r.status === 200).length;
  const limited = res.filter((r) => r.status === 429);
  console.log(`# K6 v0 레이트 리밋: 한 IP에서 ${FLOOD}개를 ${elapsedS.toFixed(2)}초에 보냄 → 200 ${okN}개, 429 ${limited.length}개(초당 ${RATE}·묶음 ${BURST} [가정])`);
  assert.deepEqual([...new Set(res.map((r) => r.status))].filter((st) => st !== 200 && st !== 429), [], `200·429 말고 다른 상태가 있다: ${res.map((r) => r.status).join(',')}`);
  assert.ok(limited.length >= 1, '429가 하나도 없다');
  // 새 IP는 가득 찬 버킷(묶음)으로 시작하고, 그 뒤로는 초당 RATE개만 찬다
  assert.ok(okN >= BURST, `처음 묶음 ${BURST}개도 통과하지 못했다: ${okN}`);
  assert.ok(okN <= BURST + Math.ceil(RATE * elapsedS) + 1, `통과 ${okN}개가 한도(묶음 ${BURST} + 초당 ${RATE} × ${elapsedS.toFixed(2)}초)를 넘었다`);
  const maxRetry = Math.ceil(1 / RATE);
  for (const r of limited) {
    const retry = Number(r.headers['retry-after']);
    assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= maxRetry, `Retry-After ${r.headers['retry-after']}(다음 토큰까지의 초를 올림, 1~${maxRetry})`);
    assert.match(r.headers['content-type'] ?? '', PROBLEM);
    assert.equal(r.json.type, 'about:blank');
    assert.equal(r.json.status, 429);
    assert.equal(r.json.title, 'Too Many Requests');
    assert.ok(typeof r.json.traceId === 'string' && r.json.traceId.length > 0);
  }
  // 같은 때 다른 IP는 막히지 않는다(IP마다 버킷 하나)
  assert.deepEqual(others.map((r) => r.status), [200, 200, 200], `다른 IP: ${others.map(show).join(' | ')}`);
  // Retry-After만큼 기다리면 다시 통과한다
  await sleep(Number(limited[0].headers['retry-after']) * 1000 + 300);
  const retried = await call('GET', path, { user: rl, ip: floodIp });
  assert.equal(retried.status, 200, show(retried));
  const afterText = await gatewayMetrics();
  const name = 'v0_gateway_requests_total';
  const delta = metricSum(afterText, name, { outcome: 'rate_limited' }) - metricSum(metricsBefore, name, { outcome: 'rate_limited' });
  assert.ok(delta >= limited.length, `${name}{outcome="rate_limited"}가 ${delta}만 늘었다(429 ${limited.length}개)`);
});

e2e('K6_BSL050_kind_IP레이트리밋은_WebSocket업그레이드에도건다_한IP의업그레이드가묶음을넘으면429와RetryAfter다 [ASVS v5.0.0-2.4.1]', { timeout: 120_000 }, async () => {
  // 쿠키 없는 업그레이드: 입구를 지나면 앱이 401, 입구가 막으면 429다. 입구가 업그레이드를 세지 않으면 모두 401이 된다
  const path = `/v0/events/${EVENT}/seat-deltas`;
  const ip = nextIp();
  const N = BURST * 2 + 10;
  const started = Date.now();
  const res = await Promise.all(
    Array.from({ length: N }, () =>
      wsOpen(path, { ip, origin: ORIGIN }).then((r) => {
        r.ws?.close();
        return r;
      }),
    ),
  );
  const elapsedS = (Date.now() - started) / 1000;
  const statuses = res.map((r) => r.status);
  const passed = statuses.filter((st) => st === 401).length;
  const limited = res.filter((r) => r.status === 429);
  // 그동안 찰 수 있는 토큰까지 넉넉히 센 상한(묶음 + 초당 RATE × 걸린 시간 + 1). 보내는 데 오래 걸렸으면 상한이 N을 넘어 판정이 느슨해진다
  const cap = BURST + Math.ceil(RATE * elapsedS) + 1;
  console.log(`# K6 v0 레이트 리밋(wss 업그레이드): 한 IP에서 ${N}개를 ${elapsedS.toFixed(2)}초에 보냄 → 401 ${passed}개, 429 ${limited.length}개, 통과 상한 ${cap}`);
  assert.deepEqual([...new Set(statuses)].filter((st) => st !== 401 && st !== 429), [], `401·429 말고 다른 상태가 있다: ${statuses.join(',')}`);
  assert.ok(passed <= cap, `업그레이드 ${passed}개가 통과해 한도(묶음 ${BURST} + 초당 ${RATE} × ${elapsedS.toFixed(2)}초)를 넘었다: 입구가 업그레이드를 세지 않는다`);
  if (cap >= N) console.log(`# 알림: 업그레이드 ${N}개를 보내는 데 ${elapsedS.toFixed(2)}초가 걸려 429가 꼭 나와야 하는 조건이 아니었다(상한 ${cap})`);
  for (const r of limited) {
    const retry = Number(r.headers['retry-after']);
    assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= Math.ceil(1 / RATE), `Retry-After ${r.headers['retry-after']}`);
    assert.match(r.headers['content-type'] ?? '', PROBLEM);
  }
});

e2e('BSL050_kind_응답머리_200·401·403·404·429모두HSTS와nosniff이고_인증JSON과앱이캐시를정하지않은응답은no-store다 [ASVS v5.0.0-3.4.1][ASVS v5.0.0-3.4.4]', { timeout: 120_000 }, async () => {
  const u = newUser('headers');
  await admit(u);
  const got = {};
  got['200 대기 상태'] = await call('GET', `/v1/queues/${EVENT}/entries/me`, { user: u });
  got['200 좌석 목록'] = await call('GET', seatsPath(), { user: u });
  got['401 쿠키 없음'] = await call('GET', seatsPath(), { ip: u.ip, token: undefined });
  got['404 없는 경로'] = await call('GET', `/v0/no-such-route-${RUN_ID}`, { user: u });
  got['403 출처 거절(입구)'] = await call('POST', `/v1/queues/${EVENT}/entries`, { user: u, origin: 'https://evil.example' });
  // 429: 새 IP 하나로 묶음을 넘게 보낸다. 이 시험은 머리를 보므로, 보내는 데 오래 걸려 토큰이 다시 차면 새 IP로 한 번 더 한다
  for (let attempt = 0; attempt < 3 && !got['429 레이트 리밋(입구)']; attempt += 1) {
    const ip = nextIp();
    const floodAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });
    try {
      const flood = await Promise.all(Array.from({ length: BURST * 2 + 10 }, () => call('GET', seatsPath(), { user: u, ip, agent: floodAgent })));
      got['429 레이트 리밋(입구)'] = flood.find((r) => r.status === 429);
    } finally {
      floodAgent.destroy();
    }
  }
  assert.ok(got['429 레이트 리밋(입구)'], '429를 만들지 못했다(세 번)');
  for (const [what, r] of Object.entries(got)) {
    assert.equal(r.status, Number(what.slice(0, 3)), `${what}: ${show(r)}`);
    assert.equal(r.headers['strict-transport-security'], HSTS, `${what}: HSTS`);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', `${what}: nosniff`);
  }
  // 인증이 필요한 JSON(대기열·좌석 v0는 앱이 Cache-Control을 주지 않는다)과 앱의 401·404는 입구가 no-store를 붙인다
  for (const what of ['200 대기 상태', '200 좌석 목록', '401 쿠키 없음', '404 없는 경로']) {
    assert.match(got[what].headers['cache-control'] ?? '', /(^|,\s*)no-store(\s*,|$)/, `${what}: Cache-Control ${got[what].headers['cache-control']}`);
  }
  console.log(`# BSL050 응답 머리: ${Object.entries(got).map(([w, r]) => `${w} cache-control=${r.headers['cache-control'] ?? '(없음)'}`).join(' / ')}`);
});

e2e('BSL050_kind_입구관리포트_/ready·/livez가200이고_/metrics에넘긴요청수와결과이름이있다', { timeout: 60_000 }, async () => {
  const r = await inPod(
    'deploy/v0-gateway',
    `const out = {};
for (const p of ['/ready', '/livez', '/metrics']) {
  const r = await fetch('http://127.0.0.1:9464' + p, { signal: AbortSignal.timeout(5000) });
  out[p] = { status: r.status, body: p === '/metrics' ? await r.text() : '' };
}
process.stdout.write('@@RESULT ' + JSON.stringify(out) + '\\n');
`,
  );
  assert.equal(r['/ready'].status, 200);
  assert.equal(r['/livez'].status, 200);
  assert.equal(r['/metrics'].status, 200);
  const text = r['/metrics'].body;
  // 앞선 시험들이 입구를 거쳐 넘긴 요청이 있다
  assert.ok(metricSum(text, 'v0_gateway_requests_total', { outcome: 'forwarded' }) > 0, 'v0_gateway_requests_total{outcome="forwarded"}가 0이다');
  assert.ok(text.includes('v0_gateway_token_rejections_total'), '/metrics에 v0_gateway_token_rejections_total이 없다');
});

/**
 * 시험 파드 하나를 그 네임스페이스·라벨로 띄워 targets에 차례로 fetch해 보고 결과를 돌려준다(끝나면 지운다).
 * 이미지는 v0 모놀리스(노드에 실려 있고 node가 있다). 제한 파드 보안 기준에 맞춘다
 * @param {string} namespace @param {Record<string, string>} labels @param {Array<{ name: string, url: string, headers: Record<string, string> }>} targets
 */
async function probeFrom(namespace, labels, targets) {
  const script = `const targets = ${JSON.stringify(targets)};
(async () => {
  const out = {};
  for (const t of targets) {
    const started = Date.now();
    try {
      const r = await fetch(t.url, { headers: t.headers, signal: AbortSignal.timeout(5000) });
      out[t.name] = { ok: true, status: r.status, ms: Date.now() - started };
    } catch (e) {
      out[t.name] = { ok: false, error: String((e && e.cause && e.cause.code) || (e && e.name) || e), ms: Date.now() - started };
    }
  }
  console.log('@@RESULT ' + JSON.stringify(out));
})();`;
  const name = `v0-e2e-np-${RUN_ID}-${randomBytes(3).toString('hex')}`;
  const security = { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } };
  const pod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace, labels: { ...labels, 'app.kubernetes.io/part-of': 'peaket-e2e' } },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [
        {
          name: 'probe',
          image: 'peaket/v0-monolith:local',
          imagePullPolicy: 'Never',
          command: ['node', '-e', script],
          resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { memory: '128Mi' } },
          securityContext: security,
        },
      ],
    },
  };
  const key = `${namespace}/${name}`;
  probePods.add(key);
  try {
    await kc(['create', '-f', '-'], { input: JSON.stringify(pod), quiet: true });
    const phase = await until(
      `시험 파드 ${key} 끝남`,
      async () => {
        const ph = (await kc(['-n', namespace, 'get', 'pod', name, '-o', 'jsonpath={.status.phase}'], { quiet: true })).trim();
        return ph === 'Succeeded' || ph === 'Failed' ? ph : undefined;
      },
      150_000,
      1_000,
    );
    const logs = await kc(['-n', namespace, 'logs', name], { quiet: true });
    const m = /^@@RESULT (.*)$/m.exec(logs);
    assert.ok(m, `시험 파드 ${key}(${phase}) 결과가 없다:\n${logs.slice(-1500)}`);
    return JSON.parse(m[1]);
  } finally {
    await kc(['-n', namespace, 'delete', 'pod', name, '--ignore-not-found', '--wait=false'], { quiet: true }).catch(() => {});
    probePods.delete(key);
  }
}

e2e('BSL050_kind_앱포트막기_입구라벨을단다른네임스페이스파드·입구가아닌같은네임스페이스파드는앱포트와관리포트에못닿고_입구파드는앱포트·observability는관리포트에닿는다 [ASVS v5.0.0-4.1.3]', { timeout: 300_000 }, async () => {
  const a = newUser('np-a');
  await admit(a);
  // 정책: 앱 파드를 고르는 NetworkPolicy가 있다
  const nps = await getJson(['-n', NS, 'get', 'networkpolicy']);
  const np = nps.items.find((n) => n.spec?.podSelector?.matchLabels?.['app.kubernetes.io/name'] === 'v0-monolith');
  assert.ok(np, `v0-monolith 파드를 고르는 NetworkPolicy가 없다: ${nps.items.map((n) => n.metadata.name).join(', ')}`);

  const pods = await getJson(['-n', NS, 'get', 'pods', '-l', 'app.kubernetes.io/name=v0-monolith,app.kubernetes.io/component=service']);
  const appPod = pods.items.find((pd) => !pd.metadata.deletionTimestamp && pd.status.podIP);
  assert.ok(appPod, '앱 파드가 없다');
  const upstream = `http://v0-monolith.${NS}.svc.cluster.local:8080${seatsPath()}`;
  const forged = { 'x-user-id': a.sub, 'x-session-id': a.sid, 'x-user-aud': 'fan', 'x-user-scope': 'ticket:buy', 'x-user-pid': a.pid };
  const targets = [
    { name: 'app', url: upstream, headers: forged },
    { name: 'management', url: `http://${appPod.status.podIP}:9464/ready`, headers: {} },
    // 대조군: 같은 시험 파드에서 네임스페이스 v0의 다른 서비스(정책 없음)에는 닿는다(시험 파드의 망·이름 풀이가 산다)
    { name: 'control', url: `http://pg-simulator.${NS}.svc.cluster.local:8790/sim/ledger`, headers: {} },
  ];
  // ① 다른 네임스페이스(peaket-local)의 파드가 입구와 같은 라벨을 단다: 정책은 같은 네임스페이스의 입구 파드만 허용해야 한다
  // ② 같은 네임스페이스(v0)의 입구가 아닌 파드: 네임스페이스 안 파드 전부(podSelector {})를 허용하는 정책을 잡는다
  // ③ observability 네임스페이스의 파드(로컬 관측 최소의 Prometheus 자리): 관리 포트에만 닿는다(그 네임스페이스가 있을 때만)
  const hasObservability = (await kc(['get', 'namespace', 'observability', '--ignore-not-found', '-o', 'name'], { quiet: true })).trim() !== '';
  const [otherNs, sameNs, observability] = await Promise.all([
    probeFrom('peaket-local', { 'app.kubernetes.io/name': 'v0-gateway' }, targets),
    probeFrom(NS, { 'app.kubernetes.io/name': 'v0-e2e-probe' }, targets),
    hasObservability ? probeFrom('observability', { 'app.kubernetes.io/name': 'v0-e2e-probe' }, targets) : Promise.resolve(undefined),
  ]);
  console.log(`# BSL050 앱 포트 막기: peaket-local(입구 라벨) ${JSON.stringify(otherNs)} / v0(입구 아님) ${JSON.stringify(sameNs)} / observability ${JSON.stringify(observability ?? '(네임스페이스 없음)')}`);
  for (const [where, r] of [['peaket-local의 입구 라벨 파드', otherNs], ['v0의 입구가 아닌 파드', sameNs]]) {
    assert.equal(r.control.ok, true, `${where}: 대조군(pg-simulator)에도 닿지 않아 정책 탓인지 알 수 없다: ${JSON.stringify(r.control)}`);
    assert.equal(r.app.ok, false, `${where}가 위조 신원 머리로 앱 포트에 닿았다: ${JSON.stringify(r.app)}`);
    assert.equal(r.management.ok, false, `${where}가 관리 포트에 닿았다: ${JSON.stringify(r.management)}`);
  }
  if (observability) {
    assert.equal(observability.control.ok, true, `observability 파드: 대조군에도 닿지 않는다: ${JSON.stringify(observability.control)}`);
    // 관리 포트까지 막아 버린 정책(지표 수집이 끊긴다)을 잡는다
    assert.equal(observability.management.ok, true, `observability 파드가 관리 포트에 닿지 못했다: ${JSON.stringify(observability.management)}`);
    assert.equal(observability.management.status, 200);
    assert.equal(observability.app.ok, false, `observability 파드가 앱 포트에 닿았다: ${JSON.stringify(observability.app)}`);
  } else {
    console.log('# 알림: observability 네임스페이스가 없어(node tools/local/cluster.mjs observability 전) 그곳에서 관리 포트에 닿는지는 보지 못했다');
  }

  // 입구 파드에서는 같은 앱 포트에 닿는다(앱이 죽어서가 아니라 정책 때문이다). 신원 머리가 없으니 앱은 401이다
  const fromGateway = await inPod(
    'deploy/v0-gateway',
    `const started = Date.now();
try {
  const r = await fetch(${JSON.stringify(upstream)}, { signal: AbortSignal.timeout(5000) });
  process.stdout.write('@@RESULT ' + JSON.stringify({ ok: true, status: r.status, ms: Date.now() - started }) + '\\n');
} catch (e) {
  process.stdout.write('@@RESULT ' + JSON.stringify({ ok: false, error: String(e?.cause?.code ?? e?.name ?? e) }) + '\\n');
}
`,
  );
  console.log(`# BSL050 입구 파드 → 앱 포트: ${JSON.stringify(fromGateway)}`);
  assert.equal(fromGateway.ok, true, `입구 파드가 앱 포트에 닿지 못했다: ${JSON.stringify(fromGateway)}`);
  assert.equal(fromGateway.status, 401);
});

e2e('K9_BSL050_kind_CPU부하에HPA가복제본을늘리고_새파드가준비된다_v0시간선을남긴다', { timeout: 1_200_000 }, async () => {
  // HPA: autoscaling/v2, CPU 사용률 하나, 최소 1·최대 4·목표 70% [가정], 확장 동작은 쿠버네티스 기본값
  const hpa = await getJson(['-n', NS, 'get', 'horizontalpodautoscalers.v2.autoscaling', 'v0-monolith']);
  assert.deepEqual({ kind: hpa.spec.scaleTargetRef.kind, name: hpa.spec.scaleTargetRef.name }, { kind: 'Deployment', name: 'v0-monolith' });
  assert.equal(hpa.spec.minReplicas, AUTOSCALING.minReplicas);
  assert.equal(hpa.spec.maxReplicas, AUTOSCALING.maxReplicas);
  assert.deepEqual([hpa.spec.minReplicas, hpa.spec.maxReplicas], [1, 4]);
  assert.deepEqual(hpa.spec.metrics, [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } } }]);
  if (hpa.spec.behavior !== undefined) {
    // API가 기본값을 채워 보여 주는 경우에도 쿠버네티스 기본값과 같아야 한다
    const pol = (r) => (r?.policies ?? []).map((x) => `${x.type}:${x.value}/${x.periodSeconds}`).sort();
    const b = hpa.spec.behavior;
    assert.deepEqual(
      { up: [b.scaleUp?.stabilizationWindowSeconds, b.scaleUp?.selectPolicy, pol(b.scaleUp)], down: [b.scaleDown?.stabilizationWindowSeconds, b.scaleDown?.selectPolicy, pol(b.scaleDown)] },
      { up: [0, 'Max', ['Percent:100/15', 'Pods:4/15']], down: [300, 'Max', ['Percent:100/15']] },
      `확장 동작이 쿠버네티스 기본값이 아니다: ${JSON.stringify(b)}`,
    );
  }
  const deploy = await getJson(['-n', NS, 'get', 'deploy', 'v0-monolith']);
  const cpuRequest = deploy.spec.template.spec.containers[0].resources?.requests?.cpu;
  assert.equal(cpuRequest, '500m', '사용률의 분모(요청 CPU)');
  await kc(['-n', 'kube-system', 'rollout', 'status', 'deploy/metrics-server', '--timeout=180s'], { quiet: true, timeout: 200_000 });

  const hpaNow = async () => {
    const h = await getJson(['-n', NS, 'get', 'horizontalpodautoscalers.v2.autoscaling', 'v0-monolith']);
    const cpu = h.status?.currentMetrics?.find((m) => m.type === 'Resource' && m.resource?.name === 'cpu')?.resource?.current?.averageUtilization;
    return { cpu, desired: h.status?.desiredReplicas, current: h.status?.currentReplicas };
  };
  const deployNow = async () => {
    const d = await getJson(['-n', NS, 'get', 'deploy', 'v0-monolith']);
    return { spec: d.spec.replicas, replicas: d.status.replicas ?? 0, ready: d.status.readyReplicas ?? 0 };
  };

  // 시작 상태: 복제 1(앞선 실행이 늘렸으면 줄이기 안정화 5분이 지나 1로 돌아올 때까지 기다린다)과 CPU 지표가 읽힘
  const d0 = await deployNow();
  if (d0.spec !== 1 || d0.ready !== 1) console.log(`# K9: 지금 복제 ${d0.spec}(준비 ${d0.ready}). 1로 돌아올 때까지 기다린다(줄이기 안정화 5분)`);
  await until('v0-monolith 복제 1', async () => {
    const d = await deployNow();
    return d.spec === 1 && d.replicas === 1 && d.ready === 1;
  }, 480_000, 5_000);
  const base = await until('HPA가 CPU 사용률을 읽음(metrics-server)', async () => {
    const h = await hpaNow();
    return typeof h.cpu === 'number' ? h : undefined;
  }, 180_000, 5_000);
  const pods = await getJson(['-n', NS, 'get', 'pods', '-l', 'app.kubernetes.io/name=v0-monolith,app.kubernetes.io/component=service']);
  const live = pods.items.filter((pd) => !pd.metadata.deletionTimestamp);
  assert.equal(live.length, 1);
  burnPod = live[0].metadata.name;
  const podsBefore = new Set(live.map((pd) => pd.metadata.name));

  // 부하: 앱 컨테이너 안에서 CPU를 바쁘게 쓰는 Node 프로세스 둘(각각 BURN_MS 뒤 스스로 끝난다)
  const k = await ensureTool('kubectl');
  const burn = `const end=Date.now()+${BURN_MS};let x=0;console.log('@@START '+Date.now());while(Date.now()<end){for(let i=0;i<1e6;i+=1)x+=Math.sqrt(i)}console.log('@@END '+Date.now())`;
  let podStartMs;
  const t0 = Date.now();
  for (let i = 0; i < 2; i += 1) {
    const c = spawn(k, ['--kubeconfig', KUBECONFIG, '-n', NS, 'exec', burnPod, '--', 'node', '-e', burn, BURN_MARK], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    c.stdout.on('data', (b) => {
      const m = /@@START (\d+)/.exec(b.toString());
      if (m && podStartMs === undefined) podStartMs = Number(m[1]);
    });
    c.stderr.on('data', (b) => console.log(`# CPU 부하 kubectl: ${b.toString().trim()}`));
    burners.add(c);
  }
  console.log(`# K9 v0: 부하 시작(파드 ${burnPod}, 바쁜 프로세스 2개, ${BURN_MS / 1000}초). 시작 CPU 사용률 ${base.cpu}%`);

  const tl = {};
  const rows = [];
  let last;
  try {
    await until(
      '늘린 파드가 준비됨(readyReplicas > 1)',
      async () => {
        const [h, d] = await Promise.all([hpaNow(), deployNow()]);
        const s = Math.round((Date.now() - t0) / 1000);
        last = { s, ...h, ...d };
        rows.push(last);
        console.log(`# K9 t+${s}s CPU ${h.cpu ?? '?'}% 원하는복제 ${h.desired ?? '?'} 지금복제 ${h.current ?? '?'} | Deployment 복제 ${d.spec}/${d.replicas} 준비 ${d.ready}`);
        if (tl.cpuSeen === undefined && typeof h.cpu === 'number' && h.cpu >= 70) tl.cpuSeen = s;
        if (tl.desired === undefined && (h.desired ?? 0) > 1) tl.desired = s;
        if (tl.scaled === undefined && Math.max(d.spec ?? 0, d.replicas) > 1) tl.scaled = s;
        if (tl.ready === undefined && d.ready > 1) tl.ready = s;
        return tl.ready !== undefined;
      },
      240_000,
      5_000,
    );
  } catch (err) {
    // 늘렸는데 파드가 못 뜨면(노드 CPU 부족 등) 까닭을 붙인다
    const pend = await getJson(['-n', NS, 'get', 'pods', '-l', 'app.kubernetes.io/name=v0-monolith,app.kubernetes.io/component=service']).catch(() => ({ items: [] }));
    const why = pend.items
      .filter((pd) => !podsBefore.has(pd.metadata.name))
      .map((pd) => `${pd.metadata.name} ${pd.status.phase} ${(pd.status.conditions ?? []).map((c) => `${c.type}=${c.status}${c.reason ? `(${c.reason}: ${c.message ?? ''})` : ''}`).join(' ')}`);
    throw new Error(`${err.message}. 시간선 ${JSON.stringify(tl)}, 마지막 ${JSON.stringify(last)}, 새 파드: ${why.join(' | ') || '(없음)'}`);
  } finally {
    await stopBurners();
  }

  // 클러스터 시계로 본 시간선: 부하 시작(파드 안 Date.now) → HPA 늘리기 사건 → 새 파드 생성 → 준비
  const iso = (v) => (v ? Date.parse(v) : NaN);
  const rel = (ms) => (podStartMs && Number.isFinite(ms) ? `+${((ms - podStartMs) / 1000).toFixed(0)}s` : '?');
  const events = await getJson(['-n', NS, 'get', 'events', '--field-selector', 'involvedObject.kind=HorizontalPodAutoscaler,involvedObject.name=v0-monolith']).catch(() => ({ items: [] }));
  const rescales = events.items
    .filter((e) => e.reason === 'SuccessfulRescale' && (!podStartMs || iso(e.lastTimestamp ?? e.eventTime) >= podStartMs - 2_000))
    .map((e) => `${rel(iso(e.lastTimestamp ?? e.eventTime))} ${e.message}`);
  const podsAfter = await getJson(['-n', NS, 'get', 'pods', '-l', 'app.kubernetes.io/name=v0-monolith,app.kubernetes.io/component=service']);
  const fresh = podsAfter.items
    .filter((pd) => !podsBefore.has(pd.metadata.name))
    .map((pd) => {
      const created = iso(pd.metadata.creationTimestamp);
      const ready = iso(pd.status.conditions?.find((c) => c.type === 'Ready' && c.status === 'True')?.lastTransitionTime);
      return `${pd.metadata.name} 생성 ${rel(created)} 준비 ${Number.isFinite(ready) ? `${rel(ready)}(생성 뒤 ${((ready - created) / 1000).toFixed(0)}s)` : '아직'}`;
    });
  console.log(
    `# K9 v0 관찰(이 PC 시계, 5초마다 봄): 부하 시작 0s → HPA가 CPU ${AUTOSCALING.targetCPUUtilizationPercentage}% 넘음을 봄 +${tl.cpuSeen ?? '?'}s → 원하는 복제 > 1 +${tl.desired ?? '?'}s → Deployment 복제 > 1 +${tl.scaled ?? '?'}s → 새 파드 준비 +${tl.ready}s`,
  );
  console.log(`# K9 v0 관찰(클러스터 시계, 부하 시작 기준): HPA 늘리기 ${rescales.join(' / ') || '(사건 없음)'}; 새 파드 ${fresh.join(' / ') || '(없음)'}`);
  console.log(`# K9 v0 표: ${JSON.stringify(rows)}`);

  assert.ok(tl.desired !== undefined, 'HPA가 원하는 복제 수를 늘리지 않았다');
  assert.ok(Math.max(...rows.map((r) => r.desired ?? 0)) <= AUTOSCALING.maxReplicas, '원하는 복제 수가 최대를 넘었다');
  assert.ok(last.ready > 1, '늘린 파드가 준비되지 않았다');
});
