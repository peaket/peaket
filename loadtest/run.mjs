#!/usr/bin/env node
// k6 부하 실행 도구(docs/verification.md §3.9, loadtest/README.md). 저장소 뿌리에서 돌린다.
//   node loadtest/run.mjs cleanup   강제로 끝난 실행이 남긴 발생기 파드·실행 폴더·시험 키·빈 응답 대역·실행 잠금을 지운다
//   node loadtest/run.mjs calibrate [--cpus 4] [--memory-mi 4096] [--target-cpus 8] [--rates 1000,2000,4000,8000] [--warm 10] [--main 30] [--record] [--out <폴더>]
//   node loadtest/run.mjs v0 queue --users N --entry-rate R --admit-per-second A [공통]
//   node loadtest/run.mjs v0 seat-hold --users N --rate R [--mode spread|hot|crossed] [--hold-size 2] [--hot-count 1] [--pairs 1] [--release-ms 0] [공통]
//   node loadtest/run.mjs v0 payment --users N --rate R [--seats-per-order 2] [--fault-drop-pct P] [--fault-delay-pct P] [--kill-app-at S] [--db-stats] [공통]
//   node loadtest/run.mjs v0 seat-deltas --users N --rate R --connections C [--listener-pods P] [--hold-size 2] [공통]
//   node loadtest/run.mjs v0 gate --scanners S --rate R [--cut-at 60] [--cut-s 60] [공통]
//   공통: [--warm 30] [--main 60] [--cpus 4] [--memory-mi 4096] [--generators N] [--namespace v0|v0-base] [--settle] [--hpa-timeline]
//         [--record --run-id <ID> [--profile <이름>] [--prom-url http://127.0.0.1:9090]] [--invariants] [--out <폴더>]
// - Before 측정(docs/verification.md §3.10): 최고 도착률이 1,000/s를 넘으면 발생기를 나눈다(k6 실행 구간). 장부는 큰 원본을 보낼 폴더로 옮긴다
// - 먼저 클러스터와 v0를 올린다: node tools/local/cluster.mjs up && node tools/local/cluster.mjs v0
// - k6(다이제스트 고정)를 kind 안의 발생기 파드(네임스페이스 loadtest, CPU·메모리 요청 = 한도)로 띄워 입구의 클러스터 안 주소로 보낸다.
//   포트 전달은 쓰지 않는다(Windows에서 끊김). 파드는 실행이 끝나면(실패해도) 지운다
// - 파드의 입력(시나리오·토큰·인증서·환경 파일)은 kind 노드 컨테이너의 실행 폴더에 docker cp로 넣고 파드가 hostPath로 붙인다.
//   이 PC에서 kubectl exec -i의 표준 입력이 잘리므로(2026-11-03 확인) 파일을 표준 입력으로 넘기지 않는다. 실행 폴더는 끝나면 지운다
// - 가상 사용자 토큰은 이 PC에서 서명해 파드로 넘긴다. 개인키는 PC에만 있고, 토큰은 산출물 폴더에 남기지 않는다
// - 종료 코드: 0 실행을 마치고 산출물을 씀(발생기 판정이 무효여도. generator.json에 남는다), 1 k6가 돌지 못함·보정 단계 실패·불변식 FAIL,
//   2 인자 오류, 128 + 신호 번호(Ctrl+C 130, SIGTERM 143 등) 종료 신호를 받아 정리하고 끝냄
// - 부하 실행은 한 번에 하나다: 네임스페이스 loadtest의 ConfigMap loadtest-lock(실행 꼬리표·마감 시각)을 잡은 실행만 돌고, 남은 것을 쓸어 낸다.
//   강제로 끝난 실행이 남긴 것과 계속 나가는 부하는 node loadtest/run.mjs cleanup으로 지운다
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { cpus as osCpus, totalmem } from 'node:os';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KUBECONFIG, V0_ALLOWED_ORIGINS, V0_BASE_NAMESPACE, V0_IMAGES, V0_NAMESPACE, V0_TOKEN_KEY_FILE, kubectl, v0Layout } from '../tools/local/cluster.mjs';
import { ensureTool } from '../tools/local/tools.mjs';
import { generateV0TokenKey, loadOrCreateV0TokenKey, signV0Token } from '../tools/local/v0-token.mjs';
import { pollStages } from './lib/model.mjs';
import { seatCount } from './lib/seats.mjs';
import { accountRef, pidOf, sidOf } from './lib/users.mjs';
import { DEFAULTS, SCENARIOS, UsageError, parseArgs } from './runner/args.mjs';
import { CHECK_PHASES, checksFromSummary, executionSegments, generatorCount, mergeSummaries, withoutHistogramChecks } from './runner/merge.mjs';
import { dbStatsDelta, deltaJudge, deltaSummary, gateOnlineCheck, gateSummary, hpaTimeline } from './runner/probes.mjs';
import { sideTasks } from './runner/side.mjs';
import {
  K6_IMAGE,
  K6_UID,
  KIND_NODE,
  LOADGEN_NAMESPACE,
  NODE_ROOT,
  NULL_TARGET_IMAGE,
  NULL_TARGET_NAME,
  NULL_TARGET_PORT,
  RUN_SCRIPT,
  RUN_SCRIPT_SPLIT,
  SIM_KEY_NAME,
  SIM_KEY_SECRET,
  deltaClientPod,
  generatorPod,
  nullTargetCertArgs,
  nullTargetManifests,
  nullTargetSecret,
  podNotReadyReason,
  runEnvFile,
  simKeySecret,
} from './runner/manifests.mjs';
import {
  calibrationCapacity,
  collectArgs,
  generatorStats,
  judgeCalibrationStep,
  judgeGenerator,
  parseCgroupLog,
  perVuBytes,
  pgChargeLines,
  servingRecords,
  splitConsole,
  withScenarioErrors,
} from './runner/results.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = join(REPO, '.cache', 'peaket-loadtest');
/** 성능 장부 실행 폴더(collect.py가 만든다) */
const LEDGER_RUNS = join(REPO, 'docs', 'perf-ledger', 'runs');
const NS = LOADGEN_NAMESPACE;
const NULL_TARGET_URL = `https://${NULL_TARGET_NAME}.${NS}.svc.cluster.local:${NULL_TARGET_PORT}`;
const ORIGIN = V0_ALLOWED_ORIGINS.split(',')[0].trim();
const INVARIANT_CLI = join(REPO, 'services', 'invariant-checker', 'dist', 'cli.js');
/** 가상 사용자 하나의 메모리 [가정] — 보정(perVuBytes)으로 바꾼다. maxVUs 상한 계산에 쓴다 */
const ASSUMED_VU_MI = 2;
/** 토큰 수명 상한(초) [가정] */
const TOKEN_TTL_MAX_S = 3 * 3600;
/** 좌석 격자(seat-hold) [가정]: 4구역 × 25열 × 50석 = 5,000석 */
const SEAT_HOLD_GRID = { sections: ['A', 'B', 'C', 'D'], rows: 25, perRow: 50 };
const PER_PERSON_LIMIT = 4;
/** 나눈 발생기 하나의 몫 [가정](docs/verification.md §3.10 '발생기 나누기'). --cpus·--memory-mi를 주면 그 값 */
const SPLIT_CPUS = 2;
const SPLIT_MEMORY_MI = 1024;
/** 장부 원본: 올릴 자리(raw_uri)와 보낼 폴더(docs/perf-ledger.md §2.1·§9). S3로 올리는 일은 소유자 몫 */
const RAW_BUCKET = 's3://peaket-perf-raw';
const RAW_OUTBOX = join(REPO, '.cache', 'perf-raw-outbox');
/** v0 서버 지표 질의(collect.py --queries) */
const QUERIES_V0 = 'loadtest/queries/v0.txt';
/** 검표 스캐너의 판정 대기 상한 [가정](K10) */
const SCAN_TIMEOUT = '3s';
/** 결제사 지연 장애의 길이: v0의 결제사 대기 상한(요청 상한 15초)을 넘긴다(K7 ②, docs/features/payment.md §13) */
const FAULT_DELAY_MS = 16000;
/** 변경분 받는 파드 하나의 몫 [가정](K4) */
const LISTENER_CPUS = 1;
const LISTENER_MEMORY_MI = 512;
/** 준비 구간 뒤 받는 파드가 연결을 맺을 시간(초) [가정](K4) */
const CONNECT_S = 20;

const log = (m) => console.log(m);
/** collect.py를 부를 Python(이 PC는 python, Linux는 python3) */
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
/** 강제 종료(Ctrl+C·kill 신호) 때도 돌릴 정리. 실행마다 등록하고, 끝나면 돌리고 지운다 */
const cleanups = new Set();
async function runCleanups() {
  for (const fn of [...cleanups]) {
    cleanups.delete(fn);
    try {
      await fn();
    } catch {
      // 정리는 끝까지 다 해 본다
    }
  }
}
const step = (m) => console.log(`\n== ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

/** kubectl(전용 kubeconfig, 출력 받기). 시간 한도를 늘 준다 */
const kc = (args, o = {}) => kubectl(args, { quiet: true, timeout: 120_000, maxBuffer: 1 << 30, ...o });
const kcInput = (args, input, o = {}) => kubectl(args, { input, timeout: 120_000, maxBuffer: 1 << 30, ...o });
/** 작은 객체(몇 KB)만 표준 입력으로 넘긴다. 잘리면 JSON을 읽지 못해 아무것도 만들지 않고 실패하므로 세 번까지 다시 한다 */
async function viaStdin(verb, obj) {
  const text = JSON.stringify(obj);
  if (text.length > 16_384) throw new Error('표준 입력으로 넘기는 객체가 너무 크다');
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      return await kcInput([verb, '-f', '-'], text);
    } catch (e) {
      last = e;
      await sleep(500);
    }
  }
  throw new Error(`쿠버네티스 객체 ${obj.kind}/${obj.metadata?.name}을 만들지 못했다: ${String(last?.stderr ?? last?.message ?? '').slice(-300)}`);
}
const createObject = (obj) => viaStdin('create', obj);
const applyObject = (obj) => viaStdin('apply', obj);
/** kind 노드 컨테이너에서 명령(셸 없이) */
const onNode = (args, o = {}) => execFileSync('docker', ['exec', KIND_NODE, ...args], { encoding: 'utf8', maxBuffer: 1 << 30, timeout: 300_000, ...o });
/**
 * 파드가 준비될 때까지(300초) 기다린다. 준비되지 않으면 그 까닭(스케줄러의 자리 없음·이미지 받기 실패 등)을 붙여 던진다.
 * 2026-11-03 러너의 A/A 실행은 'timed out waiting for the condition'만 남아 CPU 자리가 모자란 줄을 몰랐다
 */
async function waitPodReady(pod) {
  try {
    await kc(['-n', NS, 'wait', '--for=condition=Ready', `pod/${pod}`, '--timeout=300s'], { timeout: 320_000 });
  } catch (e) {
    let why;
    try {
      why = podNotReadyReason(JSON.parse(await kc(['-n', NS, 'get', 'pod', pod, '-o', 'json'])));
    } catch {
      why = String(e.stderr ?? e.message ?? '').trim().slice(-300);
    }
    throw new Error(`파드 ${pod}가 300초 안에 준비되지 않았다: ${why}`);
  }
}

// ───────────── 준비 ─────────────

async function preflightV0(namespace = V0_NAMESPACE) {
  try {
    await kc(['-n', namespace, 'get', 'deploy/v0-gateway', 'deploy/v0-monolith', '-o', 'name']);
  } catch {
    throw new Error(`v0(${namespace})가 올라와 있지 않다. 먼저: node tools/local/cluster.mjs up && node tools/local/cluster.mjs v0(기준판은 node loadtest/nightly/prepare.mjs)`);
  }
  if (!existsSync(V0_TOKEN_KEY_FILE)) throw new Error('토큰 서명 키 파일이 없다(.cache/peaket-tools/v0-token-key.json). node tools/local/cluster.mjs v0를 다시 돌린다');
}

/**
 * 이전 실행이 남긴 것(강제로 끊겨 정리하지 못한 발생기 파드·시험 키 Secret·빈 응답 대역·노드 실행 폴더)을 지운다.
 * 부하 실행은 한 번에 하나다(docs/verification.md §3.9). 지운 것이 있으면 알린다
 */
async function sweepLeftovers() {
  // 이 PC에서 꾸리다 끊긴 입력 임시 폴더(토큰이 든다)
  for (const d of readdirSync(tmpdir())) {
    if (/^loadgen-(env-)?[A-Za-z0-9]{6}$/.test(d)) rmSync(join(tmpdir(), d), { recursive: true, force: true });
  }
  const sel = 'app.kubernetes.io/name in (loadgen,loadgen-delta)';
  const pods = (await kc(['-n', NS, 'get', 'pods', '-l', sel, '-o', 'name'])).trim();
  if (pods) {
    log(`이전 실행이 남긴 발생기·받는 파드를 지운다: ${pods.split('\n').join(', ')}`);
    await kc(['-n', NS, 'delete', 'pods', '-l', sel, '--wait=true'], { timeout: 180_000 });
  }
  // K10 실행이 강제로 끝나 입구를 0개로 둔 채 남았으면 되돌린다(입구 복제는 1, deploy/envs/local/v0-gateway.yaml)
  for (const ns of [V0_NAMESPACE, V0_BASE_NAMESPACE]) {
    let replicas;
    try {
      replicas = (await kc(['-n', ns, 'get', 'deploy/v0-gateway', '-o', 'jsonpath={.spec.replicas}'])).trim();
    } catch {
      continue; // 그 판이 없다
    }
    if (replicas === '0') {
      log(`${ns}의 입구가 0개로 남아 있어 1개로 되돌린다`);
      await kc(['-n', ns, 'scale', 'deploy/v0-gateway', '--replicas=1']);
    }
  }
  await kc(['-n', NS, 'delete', 'secret', SIM_KEY_SECRET, '--ignore-not-found']);
  await stopNullTarget();
  try {
    const dirs = onNode(['ls', '-1', NODE_ROOT], { stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (dirs) {
      log(`이전 실행이 남긴 노드 실행 폴더를 지운다: ${dirs.split('\n').join(', ')}`);
      for (const d of dirs.split('\n')) if (/^[a-z0-9]{1,16}$/.test(d)) onNode(['rm', '-rf', `${NODE_ROOT}/${d}`]);
    }
  } catch {
    // 폴더 뿌리가 아직 없다
  }
}

/** 실행 잠금(부하 실행은 한 번에 하나, docs/verification.md §3.9) */
const LOCK = 'loadtest-lock';

/**
 * 잠금을 잡는다. 다른 실행이 마감 전이면 거절하고, 마감이 지난 잠금(강제로 끝난 실행)은 지우고 다시 잡는다.
 * 꼬리표는 영소문자·숫자, 마감은 유닉스 밀리초라 kubectl 인자에 그대로 넣어도 된다
 */
async function acquireLock(runTag, deadlineMs) {
  for (let i = 0; i < 3; i++) {
    try {
      await kc(['-n', NS, 'create', 'configmap', LOCK, `--from-literal=runTag=${runTag}`, `--from-literal=deadlineMs=${deadlineMs}`]);
      return;
    } catch {
      let cur;
      try {
        cur = JSON.parse(await kc(['-n', NS, 'get', 'configmap', LOCK, '-o', 'json'])).data ?? {};
      } catch {
        continue; // 그사이 지워졌다
      }
      const until = Number(cur.deadlineMs);
      if (Number.isFinite(until) && until > Date.now()) {
        throw new Error(`다른 부하 실행(${cur.runTag})이 돌고 있다(잠금 마감 ${new Date(until).toISOString()}). 끝나기를 기다리거나, 강제로 끝난 실행이면 node loadtest/run.mjs cleanup`);
      }
      log(`마감이 지난 실행 잠금(${cur.runTag})을 지운다`);
      await kc(['-n', NS, 'delete', 'configmap', LOCK, '--ignore-not-found']);
    }
  }
  throw new Error('실행 잠금을 잡지 못했다');
}

/** 내 잠금이면 푼다 */
async function releaseLock(runTag) {
  try {
    const cur = JSON.parse(await kc(['-n', NS, 'get', 'configmap', LOCK, '-o', 'json'])).data ?? {};
    if (cur.runTag === runTag) await kc(['-n', NS, 'delete', 'configmap', LOCK, '--ignore-not-found']);
  } catch {
    // 잠금이 없다
  }
}

/** cleanup 명령: 잠금을 풀고 남은 것을 모두 지운다(발생기 파드를 지우면 계속 나가던 부하도 멈춘다) */
async function runCleanup() {
  try {
    await kc(['get', 'namespace', NS, '-o', 'name']);
  } catch {
    log(`네임스페이스 ${NS}가 없다. 지울 것이 없다`);
    return { outDir: '(없음)', exitCode: 0 };
  }
  await kc(['-n', NS, 'delete', 'configmap', LOCK, '--ignore-not-found']);
  await sweepLeftovers();
  log('정리했다');
  return { outDir: '(없음)', exitCode: 0 };
}

async function ensureNamespace() {
  await applyObject({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS, labels: { 'app.kubernetes.io/part-of': 'peaket-loadtest' } } });
}

/** 앱 파드 안에서 Node 스크립트를 돌리고 '@@RESULT <JSON>' 줄을 읽는다 */
export async function inAppPod(script, timeout = 300_000, namespace = V0_NAMESPACE) {
  // 스크립트는 인자 하나로 넘긴다(표준 입력은 이 PC에서 잘릴 수 있다). 몇 KB라 명령줄 한도(32K) 안이다
  const out = await kc(['-n', namespace, 'exec', 'deploy/v0-monolith', '--', 'node', '--input-type=module', '-e', script], { timeout });
  const m = /^@@RESULT (.*)$/m.exec(out);
  if (!m) throw new Error(`앱 파드 안 스크립트에 결과 줄이 없다:\n${out.slice(-1500)}`);
  return JSON.parse(m[1]);
}

const b64json = (v) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');

/** 회차 열기(대기열 부르는 속도)·좌석·가격(모듈 공개 함수, docs/features/*.md의 v0 절) */
export function seedScript(p) {
  return `import { createDatabase } from '@peaket/platform';
import { createBookingAdmin } from './dist/modules/booking/index.js';
import { createSeatAdmin, seatGrid } from './dist/modules/inventory/index.js';
import { createQueueAdmin } from './dist/modules/queue/index.js';
import { createTicketAdmin, createTicketIssuer } from './dist/modules/ticket/index.js';
import { createV0Redis } from './dist/redis.js';
import { randomUUID } from 'node:crypto';
const p = JSON.parse(Buffer.from('${b64json(p)}', 'base64').toString('utf8'));
const redis = await createV0Redis(process.env.PEAKET_V0_REDIS_URL);
const database = createDatabase({ url: process.env.PEAKET_V0_DATABASE_URL, applicationName: 'v0-loadtest-seed' });
try {
  await createQueueAdmin(redis).open(p.eventId, { admitPerSecond: p.admitPerSecond, saleEndsAtMs: p.saleEndsAtMs });
  let seats = 0;
  if (p.grid) {
    const list = seatGrid(p.grid);
    await createSeatAdmin(database).open(p.eventId, { perPersonLimit: p.perPersonLimit }, list);
    await createBookingAdmin(database).setPrices(p.eventId, p.prices);
    seats = list.length;
  }
  // 검표(K10): 그 회차의 합성 티켓(주문마다 한 장)과 검표 스태프(docs/features/offline-gate.md §13 동작 1·3)
  const codes = [];
  if (p.gate) {
    await createTicketAdmin(database).assignStaff(p.eventId, p.gate.staff);
    const issuer = createTicketIssuer(database);
    for (let n = 0; n < p.gate.tickets; n++) {
      const [t] = await issuer.issue({ orderId: randomUUID(), eventId: p.eventId, accountId: 'acc-lt-gate-holder', seatIds: ['G-' + n], nowMs: Date.now() });
      codes.push(t.code);
    }
  }
  process.stdout.write('@@RESULT ' + JSON.stringify({ eventId: p.eventId, seats, codes }) + '\\n');
} finally {
  await redis.close();
  await database.close();
}
setTimeout(() => process.exit(0), 2000).unref();
`;
}

function servingLogScript(eventId) {
  return `import { createQueueAdmin } from './dist/modules/queue/index.js';
import { createV0Redis } from './dist/redis.js';
const redis = await createV0Redis(process.env.PEAKET_V0_REDIS_URL);
try {
  const log = await createQueueAdmin(redis).servingLog(${JSON.stringify(eventId)});
  process.stdout.write('@@RESULT ' + JSON.stringify(log) + '\\n');
} finally {
  await redis.close();
}
setTimeout(() => process.exit(0), 2000).unref();
`;
}

const LEDGER_SCRIPT = `const authorization = 'Basic ' + Buffer.from(process.env.PG_SIMULATOR_SECRET_KEY + ':').toString('base64');
const r = await fetch(process.env.PEAKET_V0_PG_URL + '/sim/ledger', { headers: { authorization }, signal: AbortSignal.timeout(60000) });
const body = await r.text();
process.stdout.write('@@RESULT ' + JSON.stringify({ status: r.status, body: r.status === 200 ? body : '' }) + '\\n');
`;

/** 가상 사용자 토큰(번호 → 토큰) JSON. 개인키는 이 PC에서만 쓴다 */
export function tokensJson(privateJwk, runTag, users, ttlS) {
  const nowMs = Date.now();
  const iat = Math.floor(nowMs / 1000);
  const out = new Array(users);
  for (let i = 0; i < users; i++) {
    out[i] = signV0Token(privateJwk, { sub: accountRef(runTag, i), sid: sidOf(runTag, i), pid: pidOf(runTag, i), scope: 'ticket:buy', exp: iat + ttlS }, { nowMs });
  }
  return JSON.stringify(out);
}

/** 좌석 격자: payment는 가상 사용자마다 seatsPerOrder석이 겹치지 않게 */
function gridFor(a) {
  if (a.scenario === 'seat-hold' || a.scenario === 'seat-deltas') return SEAT_HOLD_GRID;
  if (a.scenario === 'payment') {
    const need = a.users * a.seatsPerOrder;
    const grid = { sections: ['A', 'B', 'C', 'D'], rows: Math.max(1, Math.ceil(need / 200)), perRow: 50 };
    seatCount(grid);
    return grid;
  }
  return undefined;
}

/**
 * 가상 사용자 수 상한(메모리 [가정])과 미리 만들 수. 미리 만든 수가 모자라 k6가 도중에 가상 사용자를 새로 만들면 그동안 반복을 놓친다
 * (2026-11-03 보정: 4,000/s에서 미리 40개면 CPU 31%인데도 83건을 놓쳤다). 그래서 최고 도착률 × perReqS와 floor 가운데 큰 수를 미리 만든다 [가정].
 * 다만 가상 사용자가 많으면 연결과 실행기가 늘어 지연이 커진다(같은 보정에서 8,000/s p99가 미리 40개 2.75ms, 400개 40ms). 보정은 적게 둔다
 */
function vuPlan(maxRate, memoryMi, perReqS, floor = 100) {
  const memCap = Math.max(50, Math.floor((memoryMi * 0.6) / ASSUMED_VU_MI));
  const pre = Math.min(memCap, Math.max(floor, Math.ceil(maxRate * perReqS)));
  const max = Math.min(memCap, Math.max(pre * 4, 400));
  return { pre, max };
}

// ───────────── 발생기 파드 ─────────────

async function startGenerator(name, a, hostDir, { simKey = false, deadlineS } = {}) {
  await kc(['-n', NS, 'delete', 'pod', name, '--ignore-not-found', '--wait=true']);
  await createObject(generatorPod({ name, cpus: a.cpus, memoryMi: a.memoryMi, hostDir, simKey, deadlineS: Math.max(60, Math.min(11400, Math.ceil(deadlineS))) }));
  await waitPodReady(name);
}

/**
 * 파드 입력을 이 PC의 임시 폴더에 꾸려 노드의 실행 폴더로 옮긴다(docker cp). 임시 폴더는 바로 지운다(토큰이 든다).
 * 실행 폴더는 k6 사용자만 읽고 쓴다
 */
function stageInputs(hostDir, { caPem, tokens, codes }) {
  const stage = mkdtempSync(join(tmpdir(), 'loadgen-'));
  try {
    const put = (rel, content) => {
      mkdirSync(dirname(join(stage, rel)), { recursive: true });
      writeFileSync(join(stage, rel), content);
    };
    for (const f of readdirSync(join(REPO, 'loadtest', 'lib')).filter((x) => x.endsWith('.mjs'))) put(`loadtest/lib/${f}`, readFileSync(join(REPO, 'loadtest', 'lib', f)));
    for (const f of readdirSync(join(REPO, 'loadtest', 'scenarios')).filter((x) => x.endsWith('.js'))) put(`loadtest/scenarios/${f}`, readFileSync(join(REPO, 'loadtest', 'scenarios', f)));
    put('tools/perf-ledger/k6-summary.js', readFileSync(join(REPO, 'tools', 'perf-ledger', 'k6-summary.js')));
    put('bin/run.sh', RUN_SCRIPT);
    put('bin/run-split.sh', RUN_SCRIPT_SPLIT);
    // 변경분 받는 파드(K4)의 스크립트와 그 계산(probes.mjs). lib는 위에서 이미 옮겼다
    for (const f of ['delta-client.mjs', 'probes.mjs']) put(`loadtest/runner/${f}`, readFileSync(join(REPO, 'loadtest', 'runner', f)));
    put('ca.pem', caPem);
    put('users.json', tokens);
    if (codes !== undefined) put('codes.json', codes);
    mkdirSync(join(stage, 'out'), { recursive: true });
    onNode(['mkdir', '-p', NODE_ROOT]);
    onNode(['rm', '-rf', hostDir]);
    execFileSync('docker', ['cp', `${stage}${sep}.`, `${KIND_NODE}:${hostDir}`], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 300_000 });
    onNode(['chown', '-R', `${K6_UID}:${K6_UID}`, hostDir]);
    onNode(['chmod', '-R', 'go-rwx', hostDir]);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** 실행 폴더에 파일 하나(환경 파일)를 넣는다 */
function putNodeFile(hostDir, name, content) {
  const stage = mkdtempSync(join(tmpdir(), 'loadgen-env-'));
  try {
    writeFileSync(join(stage, name), content);
    execFileSync('docker', ['cp', join(stage, name), `${KIND_NODE}:${hostDir}/${name}`], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 });
    onNode(['chown', `${K6_UID}:${K6_UID}`, `${hostDir}/${name}`]);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

const removeNodeDir = (hostDir) => {
  try {
    onNode(['rm', '-rf', hostDir]);
  } catch {
    // 노드가 없으면 지울 것도 없다
  }
};

/** k6를 한 번 돌리고 끝날 때까지 기다린다. 끝나면 산출물 글을 돌려준다(보정) */
async function runK6(pod, hostDir, env, expectedS) {
  putNodeFile(hostDir, 'run.env', runEnvFile(env));
  // 앞 단계의 종료 코드 파일을 읽지 않게 시작 전에 지운다
  onNode(['rm', '-f', `${hostDir}/out/exit`, `${hostDir}/out/exit.tmp`]);
  await kc(['-n', NS, 'exec', pod, '--', 'sh', '-c', 'nohup sh /work/bin/run.sh >/dev/null 2>&1 &']);
  return waitK6(pod, hostDir, 'out', expectedS);
}

/** 시작한 k6가 끝날 때까지(종료 코드 파일 <outRel>/exit) 기다려 산출물 글을 돌려준다 */
async function waitK6(pod, hostDir, outRel, expectedS) {
  const until = Date.now() + (expectedS * 2 + 300) * 1000;
  let exit;
  while (Date.now() < until) {
    await sleep(3000);
    try {
      exit = onNode(['cat', `${hostDir}/${outRel}/exit`], { timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      break;
    } catch {
      // 아직 끝나지 않았다(파일 없음)
    }
  }
  if (exit === undefined) {
    await kc(['-n', NS, 'exec', pod, '--', 'pkill', 'k6']).catch(() => {});
    throw new Error(`k6(${pod})가 ${expectedS * 2 + 300}초 안에 끝나지 않았다`);
  }
  const read = async (f) => {
    try {
      return onNode(['cat', `${hostDir}/${outRel}/${f}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return '';
    }
  };
  return {
    exit: Number(exit),
    summary: await read('summary.json'),
    console: await read('console.ndjson'),
    k6log: await read('k6.log'),
    cgroup: await read('cgroup.log'),
    started: Number((await read('started')).trim()),
  };
}

/** 요약·콘솔·cgroup으로 발생기 지표와 판정. 나눈 발생기는 모두의 구간 표시(marksIn)와 미리 나눈 콘솔(splitIn)을 받는다 */
function evaluate(out, a, marksIn, splitIn) {
  if (!out.summary) throw new Error(`k6 요약이 없다(종료 코드 ${out.exit}):\n${out.k6log.slice(-1500)}`);
  const summary = JSON.parse(out.summary);
  const m = summary.metrics;
  const parsed = splitIn ?? splitConsole(out.console);
  const records = parsed.records;
  const marks = marksIn ?? parsed.marks;
  if (marks.main_start === undefined || marks.main_end === undefined) throw new Error('본구간 경계 표시가 없다(k6가 본구간까지 가지 못했다)');
  const stats = generatorStats(parseCgroupLog(out.cgroup), { fromMs: marks.main_start, toMs: marks.main_end, cpus: a.cpus, memLimitBytes: a.memoryMi * 1024 * 1024 });
  const dropped = m.dropped_iterations?.values?.count ?? 0;
  const vusMax = m.vus_max?.values?.max ?? m.vus_max?.values?.value ?? 0;
  return {
    summary,
    records,
    marks,
    generator: {
      cpus: a.cpus,
      memoryMi: a.memoryMi,
      stats,
      judge: withScenarioErrors(judgeGenerator({ dropped, cpuMeanPct: stats.cpuMeanPct, memMaxPct: stats.memMaxPct }), m.scenario_errors?.values?.count ?? 0),
      scenarioErrors: m.scenario_errors?.values?.count ?? 0,
      dropped,
      droppedByScenario: Object.fromEntries(
        Object.entries(m)
          .map(([k, v]) => [/^dropped_iterations\{scenario:([a-z_]+)\}$/.exec(k)?.[1], v?.values?.count ?? 0])
          .filter(([k, n]) => k !== undefined && n > 0),
      ),
      vusMax,
      perVuBytes: vusMax >= 1 ? perVuBytes({ memMaxBytes: stats.memMaxBytes, vusMax }) : null,
      marks,
      ...(Number.isFinite(out.started) ? { startedS: out.started } : {}),
    },
  };
}

function infraText(extra) {
  let docker = '';
  try {
    docker = execFileSync('docker', ['info', '--format', 'Docker {{.ServerVersion}}, CPU {{.NCPU}}, 메모리 {{.MemTotal}} B, 커널 {{.KernelVersion}}, {{.OperatingSystem}}'], { encoding: 'utf8' }).trim();
  } catch {
    docker = '(docker info 실패)';
  }
  let wslconfig = '(없음)';
  const wslFile = join(process.env.USERPROFILE ?? '', '.wslconfig');
  // 공개 장부에 옮기므로 자원 설정 키(구역 이름·memory·processors·swap)만 옮긴다
  if (process.env.USERPROFILE && existsSync(wslFile)) {
    wslconfig = readFileSync(wslFile, 'utf8')
      .split(/\r?\n/)
      .filter((l) => /^\s*(\[[^\]]*\]|(memory|processors|swap)\s*=.*)\s*$/i.test(l))
      .join('; ') || '(자원 설정 없음)';
  }
  const c = osCpus();
  return [
    `측정 환경(${new Date().toISOString()})`,
    `PC: ${c[0]?.model ?? '?'} 논리 프로세서 ${c.length}개, 메모리 ${Math.round(totalmem() / 2 ** 30)} GiB`,
    `Docker 엔진: ${docker}`,
    `WSL 설정(.wslconfig): ${wslconfig}`,
    `클러스터: kind peaket(노드 하나), kubeconfig ${KUBECONFIG}`,
    `발생기: k6 ${K6_IMAGE}, 파드 ${extra.generators ?? 1}대(CPU ${extra.cpus}·메모리 ${extra.memoryMi}Mi씩, 요청 = 한도), GOMAXPROCS ${extra.cpus}${(extra.generators ?? 1) > 1 ? ', k6 실행 구간으로 나눔(docs/verification.md §3.10)' : ''}`,
    ...(extra.targetCpus ? [`빈 응답 대역: ${NULL_TARGET_IMAGE}, CPU ${extra.targetCpus}·메모리 256Mi(요청 = 한도)`] : []),
    '시계: 발생기와 대상이 같은 PC 커널 시계를 쓴다(시계 차이 0, docs/perf-ledger.md §3 3번)',
    `CPU 배치: WSL 안에서 어느 코어에 놓일지 고르지 않는다(docs/verification.md §3.5 6번 '코어 혼합'은 표시만)`,
    `인자: ${JSON.stringify(extra.args)}`,
    '',
  ].join('\n');
}

// ───────────── 불변식 검사(--invariants) ─────────────

async function runInvariants(outDir, recordsFile, database = 'v0') {
  if (!existsSync(INVARIANT_CLI)) throw new Error("불변식 검사기가 빌드되어 있지 않다. 먼저 'pnpm --filter @peaket/invariant-checker build'");
  const k = await ensureTool('kubectl');
  const pf = spawn(k, ['--kubeconfig', KUBECONFIG, '-n', 'peaket-local', 'port-forward', '--address', '127.0.0.1', 'svc/postgres', ':5432'], { stdio: ['ignore', 'pipe', 'pipe'] });
  // 종료 신호를 받아도 포트 전달 자식 프로세스가 남지 않게
  const stopPf = async () => pf.kill();
  cleanups.add(stopPf);
  try {
    const port = await new Promise((ok, no) => {
      let buf = '';
      const t = setTimeout(() => no(new Error('PostgreSQL 포트 전달이 열리지 않았다')), 30_000);
      pf.stdout.on('data', (d) => {
        buf += String(d);
        const m = /127\.0\.0\.1:(\d+) ->/.exec(buf);
        if (m) {
          clearTimeout(t);
          ok(Number(m[1]));
        }
      });
      pf.on('exit', () => no(new Error('PostgreSQL 포트 전달이 끝났다')));
    });
    // 검사 연결은 v0 DB 그대로, 원본 셋은 뷰 묶음 v0_check(docs/features/payment.md §13 '불변식 검사')
    if (!/^v0(_base)?$/.test(database)) throw new Error(`v0 DB 이름이 틀렸다: ${database}`);
    const db = `postgres://postgres:peaket-local@127.0.0.1:${port}/${database}`;
    const source = `${db}?options=-c%20search_path%3Dv0_check`;
    const invDir = join(outDir, 'invariants');
    const env = { ...process.env, INVARIANT_CHECK_DB_URL: db, INVARIANT_PURCHASE_DB_URL: source, INVARIANT_PAYMENT_DB_URL: source, INVARIANT_TICKET_DB_URL: source };
    let code = 0;
    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, [INVARIANT_CLI, '--out', invDir, '--records', recordsFile], { env, encoding: 'utf8', timeout: 300_000 });
    } catch (e) {
      code = e.status ?? 2;
      stdout = String(e.stdout ?? '');
      if (code !== 1) throw new Error(`불변식 검사기가 실패했다(종료 코드 ${code}): ${String(e.stderr ?? '').slice(-500)}`);
    }
    writeFileSync(join(outDir, 'invariants.csv'), readFileSync(join(invDir, 'invariants.csv')));
    log(stdout.trim());
    return code;
  } finally {
    cleanups.delete(stopPf);
    pf.kill();
  }
}

// ───────────── v0 시나리오 ─────────────

/** 시나리오 → K(장부 kpi) */
function kpiOf(a) {
  if (a.scenario === 'queue') return 'K1';
  if (a.scenario === 'payment') return 'K7';
  if (a.scenario === 'seat-deltas') return 'K4';
  if (a.scenario === 'gate') return 'K10';
  return a.mode === 'crossed' ? 'K3' : 'K2';
}

/** 시나리오가 요청에 다는 경로(점검 파일을 만든다) */
const ROUTES = {
  queue: ['entry', 'status', 'admission'],
  'seat-hold': ['hold', 'release'],
  'seat-deltas': ['hold', 'release'],
  payment: ['hold', 'order', 'sim_auth', 'sim_fault', 'payment', 'order_view'],
  gate: ['scan'],
};

/** 서버 히스토그램 점검(경로의 앱 경로 틀, 기준값 칸(초), 허용 비율). 지연 대조의 서버 쪽이다(ADR-0077) */
const SERVER_CHECK = {
  queue: { route: 'status', path: '/v1/queues/{eventId}/entries/me', le: 0.2, allowed: 0.01, label: 'p99', name: 'status_server_p99_200ms' },
  'seat-hold': { route: 'hold', path: '/v1/events/{eventId}/holds', le: 0.05, allowed: 0.01, label: 'p99', name: 'hold_server_p99_50ms' },
  'seat-deltas': { route: 'hold', path: '/v1/events/{eventId}/holds', le: 0.05, allowed: 0.01, label: 'p99', name: 'hold_server_p99_50ms' },
  payment: { route: 'payment', path: '/v0/orders/{orderId}/payment', le: 3, allowed: 0.01, label: 'p99', name: 'payment_server_p99_3000ms' },
  gate: { route: 'scan', path: '/v0/events/{eventId}/scans', le: 0.15, allowed: 0.05, label: 'p95', name: 'scan_server_p95_150ms' },
};

/** 앱 파드 고르기(공용 차트의 이름 꼬리표) */
const APP_SELECTOR = 'app.kubernetes.io/name=v0-monolith';

/**
 * 시작 전 HPA가 앱 복제를 최소로 줄일 때까지 기다린다(--settle, docs/verification.md §3.10 '공통 규칙').
 * 올라와 있는 두 판(v0·v0-base)을 모두 본다. 야간 비교는 두 판을 번갈아 재서 앞 회차가 다른 판이다. 그 판이 늘린 복제가
 * CPU 4개 러너의 남은 자리를 차지하면 이번 발생기가 자리를 잡지 못한다(docs/devops.md §3.3)
 */
async function settleHpa(namespace, timeoutS = 900) {
  const until = Date.now() + timeoutS * 1000;
  let lastLog = 0;
  while (Date.now() < until) {
    const busy = [];
    for (const ns of [V0_NAMESPACE, V0_BASE_NAMESPACE]) {
      const text = (await kc(['-n', ns, 'get', 'hpa', 'v0-monolith', '--ignore-not-found', '-o', 'json'])).trim();
      if (!text) {
        // 다른 판은 올리지 않았으면 없다. 재는 판의 HPA는 있어야 한다
        if (ns !== namespace) continue;
        throw new Error(`${ns}에 HPA v0-monolith가 없다`);
      }
      const h = JSON.parse(text);
      const min = h.spec?.minReplicas ?? 1;
      const pods = JSON.parse(await kc(['-n', ns, 'get', 'pods', '-l', APP_SELECTOR, '-o', 'json'])).items.filter((p) => !p.metadata?.deletionTimestamp);
      if (h.status?.currentReplicas !== min || pods.length !== min) busy.push(`${ns} 최소 ${min}, 지금 ${h.status?.currentReplicas ?? '?'}개, 파드 ${pods.length}개`);
    }
    if (!busy.length) return;
    if (Date.now() - lastLog > 30_000) {
      log(`앱 복제가 최소로 줄기를 기다린다(${busy.join('; ')})`);
      lastLog = Date.now();
    }
    await sleep(10_000);
  }
  throw new Error(`HPA가 ${timeoutS}초 안에 앱 복제를 최소로 줄이지 않았다`);
}

/** DB 통계 한 번(K3, S-T10): pg_stat_database와 v0 표의 pg_stat_user_tables */
const DB_STATS_SCRIPT = `import { createDatabase } from '@peaket/platform';
const database = createDatabase({ url: process.env.PEAKET_V0_DATABASE_URL, applicationName: 'v0-loadtest-stats' });
try {
  const d = (await database.pool.query('select deadlocks, xact_commit, xact_rollback from pg_stat_database where datname = current_database()')).rows[0];
  const t = (await database.pool.query("select relname, n_tup_ins, n_tup_upd, n_tup_hot_upd, n_tup_del, n_live_tup, n_dead_tup from pg_stat_user_tables where relname like 'v0\\\\_%'")).rows;
  const n = (v) => Number(v);
  const out = { atMs: Date.now(), database: { deadlocks: n(d.deadlocks), xact_commit: n(d.xact_commit), xact_rollback: n(d.xact_rollback) }, tables: {} };
  for (const r of t) out.tables[r.relname] = { n_tup_ins: n(r.n_tup_ins), n_tup_upd: n(r.n_tup_upd), n_tup_hot_upd: n(r.n_tup_hot_upd), n_tup_del: n(r.n_tup_del), n_live_tup: n(r.n_live_tup), n_dead_tup: n(r.n_dead_tup) };
  process.stdout.write('@@RESULT ' + JSON.stringify(out) + '\\n');
} finally {
  await database.close();
}
setTimeout(() => process.exit(0), 2000).unref();
`;

/** 결제 실행 뒤 v0 표 상태(K7 ②): 좌석 누수·멈춘 주문(docs/features/payment.md §13). 회차 하나만 센다 */
function paymentStateScript(eventId) {
  return `import { createDatabase } from '@peaket/platform';
const database = createDatabase({ url: process.env.PEAKET_V0_DATABASE_URL, applicationName: 'v0-loadtest-state' });
const ev = ${JSON.stringify(eventId)};
try {
  const q = async (s) => Number((await database.pool.query(s, [ev])).rows[0].n);
  const out = {
    seatLeak: await q("select count(*) as n from v0_seat s where s.event_id = $1 and s.status = 'SOLD' and not exists (select 1 from v0_order o where o.order_id = s.order_id and o.status in ('APPROVED', 'CONFIRMED'))"),
    ordersPaying: await q("select count(*) as n from v0_order where event_id = $1 and status = 'PAYING'"),
    ordersApproved: await q("select count(*) as n from v0_order where event_id = $1 and status = 'APPROVED'"),
    ordersConfirmed: await q("select count(*) as n from v0_order where event_id = $1 and status = 'CONFIRMED'"),
    ordersFailed: await q("select count(*) as n from v0_order where event_id = $1 and status = 'FAILED'"),
    paymentsConfirming: await q("select count(*) as n from v0_payment where event_id = $1 and status = 'CONFIRMING'"),
    paymentsApproved: await q("select count(*) as n from v0_payment where event_id = $1 and status = 'APPROVED'"),
    paymentsFailed: await q("select count(*) as n from v0_payment where event_id = $1 and status = 'FAILED'"),
  };
  process.stdout.write('@@RESULT ' + JSON.stringify(out) + '\\n');
} finally {
  await database.close();
}
setTimeout(() => process.exit(0), 2000).unref();
`;
}

/** 입구 Deployment의 복제 수 */
async function gatewayReplicas(namespace) {
  return Number((await kc(['-n', namespace, 'get', 'deploy/v0-gateway', '-o', 'jsonpath={.spec.replicas}'])).trim());
}

/** 실행 하나를 끝까지: 준비 → 발생기(나눔) → 곁에서 할 일 → 판정·기록 */
async function runV0(a, runTag) {
  const layout = v0Layout(a.namespace);
  const outDir = resolve(a.out ?? join(OUT_ROOT, `${today()}-${a.scenario}-${runTag}`));
  mkdirSync(outDir, { recursive: true });
  const hostDir = `${NODE_ROOT}/${runTag}`;
  const eventId = randomUUID();
  const grid = gridFor(a);
  const startedAt = new Date().toISOString();
  let exitCode = 0;
  let k6Exit = null;
  let locked = false;
  const pods = [];
  const listeners = [];
  /** 끊어 둔 입구(K10). 실패·종료 신호에서도 되돌린다 */
  let cutRestore = null;
  /** 아직 돌지 않은 곁작업 막기(곁작업 모음을 만든 뒤 채운다) */
  let cancelSide = () => {};
  const cleanup = async () => {
    cancelSide();
    if (cutRestore) await cutRestore().catch(() => {});
    for (const p of [...pods, ...listeners]) await kc(['-n', NS, 'delete', 'pod', p, '--ignore-not-found', '--wait=true']).catch(() => {});
    removeNodeDir(hostDir);
    if (!locked) return;
    if (a.scenario === 'payment') await kc(['-n', NS, 'delete', 'secret', SIM_KEY_SECRET, '--ignore-not-found']).catch(() => {});
    await releaseLock(runTag);
  };
  cleanups.add(cleanup);
  try {
    step(`v0(${layout.namespace})와 네임스페이스 확인`);
    await preflightV0(layout.namespace);
    await ensureNamespace();

    // 시나리오 시간과 도착률
    const tokenUsers = a.scenario === 'seat-deltas' ? a.connections + a.users : a.users;
    let maxRate;
    let prepS;
    if (a.scenario === 'queue') {
      const entryS = Math.ceil(a.users / a.entryRate);
      const q = { users: a.users, entryRate: a.entryRate, admitPerSecond: a.admitPerSecond };
      const plan = [pollStages({ ...q, startS: entryS, durationS: a.warmS }), pollStages({ ...q, startS: entryS + a.warmS, durationS: a.mainS })];
      maxRate = Math.max(a.entryRate, ...plan.flatMap((p) => [p.startRate, ...p.stages.map((s) => s.target)]));
      prepS = entryS;
    } else if (a.scenario === 'gate') {
      maxRate = a.rate;
      prepS = 0;
    } else {
      const prepRate = Math.min(tokenUsers, 200);
      prepS = 2 * Math.ceil(tokenUsers / prepRate) + 3 + (a.scenario === 'seat-deltas' ? CONNECT_S : 0);
      maxRate = Math.max(a.rate * (a.scenario === 'seat-hold' && !a.keep ? 2 : a.scenario === 'seat-deltas' ? 2 : 1), prepRate);
    }
    const busyS = prepS + a.warmS + a.mainS + 60;
    // 발생기 수(docs/verification.md §3.10 '발생기 나누기'): 주지 않으면 최고 도착률 ÷ 1,000
    const nGen = a.generators ?? generatorCount(maxRate);
    const split = nGen > 1;
    const gen = split && a.cpus === DEFAULTS.cpus && a.memoryMi === DEFAULTS.memoryMi ? { ...a, cpus: SPLIT_CPUS, memoryMi: SPLIT_MEMORY_MI } : a;
    // 홀드를 잡고 기다리는 동안(--release-ms), 결제 체인, 검표 대기 상한 동안 가상 사용자가 묶인다
    const perReqS = a.scenario === 'payment' ? 0.5 : a.scenario === 'gate' ? 0.1 : a.scenario === 'seat-hold' ? 0.05 + a.releaseMs / 1000 : 0.05;
    const vus = vuPlan(maxRate / nGen, gen.memoryMi, perReqS);
    log(`발생기 ${nGen}대(CPU ${gen.cpus}·메모리 ${gen.memoryMi}Mi씩), 최고 도착률 ${Math.round(maxRate)}/s, 발생기마다 미리 ${vus.pre}·최대 ${vus.max} VU`);

    step('실행 잠금과 남은 것 쓸어 내기');
    await acquireLock(runTag, Date.now() + (busyS * 2 + 600 + (a.settle ? 900 : 0)) * 1000);
    locked = true;
    await sweepLeftovers();
    if (a.settle) {
      step('HPA가 앱 복제를 최소로 줄이기를 기다린다(--settle)');
      await settleHpa(layout.namespace);
    }

    step(`회차 ${eventId} 열기`);
    // 판매 종료 시각을 실행 뒤로 둔다. 끝난 회차는 입장 루프가 불러도 곧바로 돌아와, 실행이 쌓여도 다음 측정의 Redis 부하가 거의 늘지 않는다
    const seeded = await inAppPod(
      seedScript({
        eventId,
        admitPerSecond: a.scenario === 'queue' ? a.admitPerSecond : 100000,
        saleEndsAtMs: Date.now() + (busyS + 600) * 1000,
        ...(grid ? { grid, perPersonLimit: PER_PERSON_LIMIT, prices: { R: 150000 } } : {}),
        ...(a.scenario === 'gate' ? { gate: { tickets: a.tickets, staff: Array.from({ length: a.scanners }, (_, i) => accountRef(runTag, i)) } } : {}),
      }),
      600_000,
      layout.namespace,
    );
    log(`좌석 ${seeded.seats}석${a.scenario === 'gate' ? `, 티켓 ${seeded.codes.length}장, 스태프 ${a.scanners}명` : ''}`);

    const dbBefore = a.dbStats ? await inAppPod(DB_STATS_SCRIPT, 120_000, layout.namespace) : null;

    step(`가상 사용자 ${tokenUsers}명의 토큰 서명(이 PC)`);
    const { privateJwk } = loadOrCreateV0TokenKey(V0_TOKEN_KEY_FILE);
    const tokens = tokensJson(privateJwk, runTag, tokenUsers, Math.min(TOKEN_TTL_MAX_S, busyS + 600));

    if (a.scenario === 'payment') {
      const raw = (await kc(['-n', V0_NAMESPACE, 'get', 'secret', 'pg-simulator', '-o', `jsonpath={.data.${SIM_KEY_NAME}}`])).trim();
      await kc(['-n', NS, 'delete', 'secret', SIM_KEY_SECRET, '--ignore-not-found']);
      await createObject(simKeySecret(Buffer.from(raw, 'base64').toString('utf8')));
    }
    const caPem = Buffer.from((await kc(['-n', layout.namespace, 'get', 'secret', 'v0-gateway', '-o', 'jsonpath={.data.PEAKET_V0_TLS_CERT}'])).trim(), 'base64').toString('utf8');
    stageInputs(hostDir, { caPem, tokens, ...(a.scenario === 'gate' ? { codes: JSON.stringify(seeded.codes) } : {}) });

    // 시나리오 환경 값(발생기마다 같고, 나누면 실행 구간만 다르다). PRE_VUS·MAX_VUS는 모든 발생기의 합이다(k6가 구간 몫으로 나눈다)
    const env = {
      SCENARIO: SCENARIOS[a.scenario],
      BASE: layout.gatewayUrl,
      ORIGIN,
      RUN_TAG: runTag,
      USERS_FILE: '/work/users.json',
      EVENT_ID: eventId,
      WARM_S: a.warmS,
      MAIN_S: a.mainS,
      PRE_VUS: vus.pre * nGen,
      MAX_VUS: vus.max * nGen,
      ...(a.scenario === 'queue' ? { USERS: a.users, ENTRY_RATE: a.entryRate, ADMIT_PER_SECOND: a.admitPerSecond } : {}),
      ...(a.scenario === 'seat-hold' || a.scenario === 'payment' ? { USERS: a.users, RATE: a.rate, PREP_RATE: Math.min(a.users, 200) } : {}),
      ...(a.scenario === 'seat-deltas' ? { USERS: a.users, RATE: a.rate, LISTENERS: a.connections, CONNECT_S, PREP_RATE: Math.min(tokenUsers, 200), MODE: 'spread', HOLD_SIZE: a.holdSize } : {}),
      ...(grid ? { SECTIONS: grid.sections.join(','), ROWS: grid.rows, PER_ROW: grid.perRow } : {}),
      ...(a.scenario === 'seat-hold' ? { MODE: a.mode, HOLD_SIZE: a.holdSize, HOT_COUNT: a.hotCount, PAIRS: a.pairs, RELEASE_MS: a.releaseMs, KEEP: a.keep ? 1 : 0 } : {}),
      ...(a.scenario === 'payment' ? { SEATS_PER_ORDER: a.seatsPerOrder, SIM_URL: `http://pg-simulator.${V0_NAMESPACE}.svc.cluster.local:8790`, FAULT_DROP_PCT: a.faultDropPct, FAULT_DELAY_PCT: a.faultDelayPct, FAULT_DELAY_MS } : {}),
      ...(a.scenario === 'gate' ? { SCANNERS: a.scanners, RATE: a.rate, TICKETS: a.tickets, CODES_FILE: '/work/codes.json', SCAN_TIMEOUT } : {}),
    };
    const segments = executionSegments(nGen);
    for (const sg of segments) {
      const e = split ? { ...env, OUT_DIR: `/work/out/g${sg.index}`, K6_EXECUTION_SEGMENT: sg.segment, K6_EXECUTION_SEGMENT_SEQUENCE: sg.sequence } : { ...env, OUT_DIR: '/work/out' };
      putNodeFile(hostDir, split ? `run-${sg.index}.env` : 'run.env', runEnvFile(e));
    }

    step(`발생기 파드 ${nGen}대`);
    for (const sg of segments) {
      const name = split ? `loadgen-${runTag}-g${sg.index}` : `loadgen-${runTag}`;
      pods.push(name);
      await createObject(generatorPod({ name, cpus: gen.cpus, memoryMi: gen.memoryMi, hostDir, simKey: a.scenario === 'payment', deadlineS: Math.max(60, Math.min(11400, busyS * 2 + 600)), ...(split ? { index: sg.index } : {}) }));
    }
    if (a.scenario === 'seat-deltas') {
      step(`변경분 받는 파드 ${a.listenerPods}대(연결 ${a.connections}개)`);
      const per = Math.ceil(a.connections / a.listenerPods);
      for (let i = 0; i < a.listenerPods; i++) {
        const from = i * per;
        const to = Math.min(a.connections, from + per);
        if (from >= to) break;
        const name = `loadgen-${runTag}-l${i}`;
        listeners.push(name);
        await createObject(deltaClientPod({ name, index: i, cpus: LISTENER_CPUS, memoryMi: LISTENER_MEMORY_MI, hostDir, deadlineS: Math.max(60, Math.min(11400, busyS * 2 + 600)), connsFrom: from, connsTo: to, gateway: layout.gatewayUrl.replace(/^https:/, 'wss:'), eventId, origin: ORIGIN, image: V0_IMAGES.app }));
      }
    }
    for (const p of [...pods, ...listeners]) await waitPodReady(p);

    step(`k6 ${SCENARIOS[a.scenario]}(예상 ${busyS}초)`);
    for (const p of pods) await kc(['-n', NS, 'exec', p, '--', 'sh', '-c', `nohup sh /work/bin/${split ? 'run-split.sh' : 'run.sh'} >/dev/null 2>&1 &`]);
    if (split) {
      // 모든 발생기가 시작 파일을 기다리는 중이다. 한 번에 놓아 함께 시작한다
      await sleep(1000);
      onNode(['sh', '-c', `touch ${hostDir}/go && chown ${K6_UID}:${K6_UID} ${hostDir}/go`]);
    }
    const loadStartMs = Date.now();

    // 곁에서 할 일(시각은 k6 시작 기준): 변경분 연결 시작, 앱 파드 강제 종료, 입구 끊기·되돌리기
    // 곁작업이 실패해도 처리되지 않은 거부로 정리 없이 죽지 않게 모아 두었다가 k6가 끝난 뒤 실패로 끝낸다(정리는 finally가 한다, 2026-11-03 새 맥락 리뷰)
    const side = sideTasks(loadStartMs);
    cancelSide = () => side.cancel();
    const at = (offsetS, fn) => side.at(offsetS, fn);
    let killed = null;
    let cut = null;
    if (a.scenario === 'seat-deltas') at(prepS - CONNECT_S + 1, () => onNode(['sh', '-c', `touch ${hostDir}/connect && chown ${K6_UID}:${K6_UID} ${hostDir}/connect`]));
    if (a.killAppAtS !== undefined) {
      at(prepS + a.warmS + a.killAppAtS, async () => {
        const name = (await kc(['-n', layout.namespace, 'get', 'pods', '-l', APP_SELECTOR, '-o', 'jsonpath={.items[0].metadata.name}'])).trim();
        killed = { name, atMs: Date.now() };
        await kc(['-n', layout.namespace, 'delete', 'pod', name, '--grace-period=0', '--force', '--wait=false']);
        log(`앱 파드 ${name}을 강제로 끝냈다(본구간 ${a.killAppAtS}초)`);
      });
    }
    if (a.scenario === 'gate') {
      const original = await gatewayReplicas(layout.namespace);
      const restore = async () => {
        await kc(['-n', layout.namespace, 'scale', 'deploy/v0-gateway', `--replicas=${original}`]);
        cutRestore = null;
      };
      // 끊기 예약이 정리와 겹쳐도 입구가 0개로 남지 않게, 원래 복제 수를 읽은 직후부터 정리가 되돌리게 한다(2차 리뷰)
      cutRestore = restore;
      at(a.warmS + a.cutAtS, async () => {
        cutRestore = restore;
        const issuedMs = Date.now();
        // 0개로 줄이고 남은 입구 파드를 곧바로 강제로 끝낸다. 점잖게 끄면 끄는 몇 초 동안 판정이 이어져 망 끊김이 아니다(2026-11-03 리허설)
        await kc(['-n', layout.namespace, 'scale', 'deploy/v0-gateway', '--replicas=0']);
        await kc(['-n', layout.namespace, 'delete', 'pod', '-l', 'app.kubernetes.io/name=v0-gateway', '--grace-period=0', '--force', '--wait=false']);
        // 끊긴 시각은 강제 종료 명령이 끝난 때다(명령 두 개가 도는 동안은 아직 판정이 난다)
        cut = { issuedMs, startMs: Date.now(), original };
        log(`입구를 끊었다(입구 파드를 0개로 줄이고 강제로 끝냄, 본구간 ${a.cutAtS}초)`);
      });
      at(a.warmS + a.cutAtS + a.cutS, async () => {
        const endMs = Date.now();
        await restore();
        if (cut) cut.endMs = endMs;
        await kc(['-n', layout.namespace, 'rollout', 'status', 'deploy/v0-gateway', '--timeout=300s'], { timeout: 320_000 });
        if (cut) cut.readyMs = Date.now();
        log('입구를 되돌렸다');
      });
    }

    const outs = await Promise.all(segments.map((sg) => waitK6(pods[sg.index], hostDir, split ? `out/g${sg.index}` : 'out', busyS)));
    const bad = outs.find((o) => o.exit !== 0 && o.exit !== 99);
    // k6가 일찍 실패했으면 남은 곁작업(입구 끊기·앱 파드 끝내기)을 하지 않는다
    if (bad) side.cancel();
    const sideErrors = await side.settle();
    const k6DoneAtMs = Date.now();
    k6Exit = Math.max(...outs.map((o) => o.exit));
    for (const [i, o] of outs.entries()) {
      const suffix = split ? `-g${i}` : '';
      writeFileSync(join(outDir, `k6${suffix}.log`), o.k6log);
      writeFileSync(join(outDir, `cgroup${suffix}.log`), o.cgroup);
      writeFileSync(join(outDir, `console${suffix}.ndjson`), o.console);
    }
    if (sideErrors.length) {
      exitCode = 1;
      throw new Error(`곁작업이 실패했다: ${sideErrors.map((e) => e.message).join('; ')}`);
    }
    if (bad) {
      exitCode = 1;
      throw new Error(`k6가 종료 코드 ${bad.exit}로 끝났다:\n${bad.k6log.slice(-1500)}`);
    }
    // 구간 표시는 표시 시나리오(반복 1번)를 맡은 발생기 하나에만 있다. 모두 함께 시작했으므로 그 시각을 모든 발생기의 창으로 쓴다
    const parts = outs.map((o) => ({ o, split: splitConsole(o.console) }));
    const marks = Object.assign({}, ...parts.map((p) => p.split.marks));
    if (marks.main_start === undefined || marks.main_end === undefined) throw new Error('본구간 경계 표시가 없다(k6가 본구간까지 가지 못했다)');
    const evs = parts.map((p) => evaluate(p.o, gen, marks, p.split));
    const merged = split ? mergeSummaries(evs.map((e) => e.summary)) : evs[0].summary;
    writeFileSync(join(outDir, 'summary.json'), JSON.stringify(merged, null, 2));
    const generator = combineGenerators(evs.map((e) => e.generator), loadStartMs);
    writeFileSync(join(outDir, 'generator.json'), JSON.stringify(generator, null, 2));

    // 곁에서 잰 것
    const probesOut = {};
    let gateCheck = null;
    if (a.dbStats) {
      // pg_stat 누적은 백엔드가 쉬는 동안 10초마다 공유 메모리로 옮긴다(PostgreSQL 15+). 그 뒤에 읽는다
      await sleep(12_000);
      probesOut.db = dbStatsDelta(dbBefore, await inAppPod(DB_STATS_SCRIPT, 120_000, layout.namespace));
      writeFileSync(join(outDir, 'db-stats.json'), JSON.stringify(probesOut.db, null, 2));
    }
    if (a.hpaTimeline) {
      const events = JSON.parse(await kc(['-n', layout.namespace, 'get', 'events', '-o', 'json'])).items;
      const appPods = JSON.parse(await kc(['-n', layout.namespace, 'get', 'pods', '-l', APP_SELECTOR, '-o', 'json'])).items;
      probesOut.hpa = { loadStartMs, ...hpaTimeline({ events, pods: appPods, loadStartMs }) };
      writeFileSync(join(outDir, 'hpa.json'), JSON.stringify(probesOut.hpa, null, 2));
    }
    if (a.scenario === 'gate') {
      if (!cut?.endMs) throw new Error('입구를 끊고 되돌린 시각이 없다');
      const probes = parts.flatMap((p) => p.split.probes);
      const gw = { mainStartMs: marks.main_start, cutStartMs: cut.startMs, cutEndMs: cut.endMs, mainEndMs: marks.main_end };
      probesOut.gate = { cutTimes: cut, ...gateSummary(probes, gw) };
      // 온라인 점검은 끊기 명령을 낸 때(issuedMs)에서 끝낸다. 명령 두 개가 도는 1~2초의 실패를 온라인 시도로 세지 않게(2026-11-03 새 맥락 리뷰)
      gateCheck = gateOnlineCheck(probes, { ...gw, cutStartMs: cut.issuedMs });
      writeFileSync(join(outDir, 'gate.json'), JSON.stringify(probesOut.gate, null, 2));
    }
    if (a.scenario === 'seat-deltas') {
      onNode(['sh', '-c', `touch ${hostDir}/stop && chown ${K6_UID}:${K6_UID} ${hostDir}/stop`]);
      const { lines, done } = await readListenerOutputs(hostDir, listeners.length);
      writeFileSync(join(outDir, 'deltas.ndjson'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      probesOut.deltas = { ...deltaSummary(lines, { fromMs: marks.main_start, toMs: marks.main_end }), clientCpu: listenerCpu(lines, marks, LISTENER_CPUS) };
      writeFileSync(join(outDir, 'deltas.json'), JSON.stringify(probesOut.deltas, null, 2));
      // 일부 결과로 조용히 요약하지 않는다: 계획한 연결 수의 값이 아니면 무효(2026-11-03 새 맥락 리뷰)
      const d = probesOut.deltas;
      const why = deltaJudge({ done, listeners: listeners.length, connected: d.connected, failed: d.failed, closed: d.closed, connections: a.connections, clientCpuPct: d.clientCpu.meanPctMax });
      if (why.length) {
        generator.judge = { valid: false, reasons: [...generator.judge.reasons, ...why.map((r) => `변경분: ${r}`)] };
        writeFileSync(join(outDir, 'generator.json'), JSON.stringify(generator, null, 2));
      }
    }
    if (killed) probesOut.killed = killed;

    step('시험 기록');
    let lines = parts.flatMap((p) => p.split.records);
    if (a.scenario === 'queue') lines = lines.concat(servingRecords(eventId, await inAppPod(servingLogScript(eventId), 300_000, layout.namespace)));
    if (a.scenario === 'payment') {
      const r = await inAppPod(LEDGER_SCRIPT, 300_000, layout.namespace);
      if (r.status !== 200) throw new Error(`시뮬레이터 원장을 받지 못했다(HTTP ${r.status})`);
      lines = lines.concat(pgChargeLines(r.body));
      probesOut.paymentState = await inAppPod(paymentStateScript(eventId), 120_000, layout.namespace);
      writeFileSync(join(outDir, 'payment-state.json'), JSON.stringify(probesOut.paymentState, null, 2));
    }
    const recordsFile = join(outDir, 'records.ndjson');
    writeFileSync(recordsFile, lines.length ? `${lines.join('\n')}\n` : '');
    const infraFile = join(outDir, 'infra.txt');
    writeFileSync(infraFile, infraText({ cpus: gen.cpus, memoryMi: gen.memoryMi, generators: nGen, args: a }));
    const g = generator;
    log(`발생기 ${nGen}대: CPU 평균 최고 ${g.cpuMeanPctMax}%, 메모리 최대 ${g.memMaxPctMax}%, dropped ${g.dropped}, VU 최대 합 ${g.vusMax}, 시작 차이 ${g.startSkewS ?? 0}초 → ${g.judge.valid ? '유효' : `무효(${g.judge.reasons.join('; ')})`}`);

    let invFile;
    if (a.invariants) {
      step('불변식 검사(peaket-invariants)');
      if (a.scenario === 'payment') {
        // P3(승인 뒤 60초 안에 발권 대기·발권)는 승인 뒤 60초가 지난 결제만 센다. k6가 끝난 것을 본 때(이 PC 시계)부터 65초를 기다린다
        const waitMs = k6DoneAtMs + 65_000 - Date.now();
        if (waitMs > 0) {
          log(`마지막 결제 승인 뒤 60초를 기다린다(${Math.ceil(waitMs / 1000)}초)`);
          await sleep(waitMs);
        }
      }
      const code = await runInvariants(outDir, recordsFile, layout.database);
      invFile = join(outDir, 'invariants.csv');
      if (code === 1 && !(a.faultDropPct || a.faultDelayPct || a.killAppAtS !== undefined)) exitCode = 1;
    }

    // 경로 목표 점검 파일(collect.py --checks)
    let checks = checksFromSummary(merged, ROUTES[a.scenario], CHECK_PHASES[a.scenario] ?? {});
    if (a.scenario === 'gate') {
      // 검표 p95는 온라인 구간만 센다(끊긴 동안의 빠른 실패가 목표 안으로 잡히지 않게, §3.10 K10 '온라인 판정 p95')
      const rest = (checks?.checks ?? []).filter((c) => !c.name.startsWith('scan_p95_'));
      checks = gateCheck || rest.length ? { checks: [...rest, ...(gateCheck ? [gateCheck] : [])] } : null;
    }
    // 서버 쪽: 앱 히스토그램의 같은 경로·같은 기준값 칸(docs/perf-ledger.md §2.2 latency_crosscheck, ADR-0077). Prometheus를 줄 때만
    const sc = SERVER_CHECK[a.scenario];
    if (checks && a.promUrl && sc && a.killAppAtS === undefined) {
      checks.checks.push({ name: sc.name, allowed: sc.allowed, target: `서버 ${sc.route} ${sc.label} ≤ ${sc.le * 1000}ms`, histogram: { metric: 'http_server_request_duration_seconds', match: `namespace="${layout.namespace}",app="v0-monolith",route="${sc.path}"`, le: sc.le } });
      if (a.scenario !== 'gate') checks.crosscheck = { check: sc.name, k6_metric: `http_req_duration{phase:main,route:${sc.route}}` };
    }
    const checksFile = checks ? join(outDir, 'checks.json') : undefined;
    if (checksFile) writeFileSync(checksFile, JSON.stringify(checks, null, 2));
    const notes = runNotes(a, { generator: g, merged, probes: probesOut, maxRate, nGen });
    writeFileSync(join(outDir, 'notes.txt'), `${notes}\n`);
    log(notes);

    if (a.record) {
      step(`성능 장부(${a.runId})`);
      const rps = a.scenario === 'queue' ? undefined : a.rate;
      // 불변식 위반 행(invariants/invariants-detail.ndjson)은 장부에서 큰 원본으로 보낼 폴더에 옮겨진다(docs/perf-ledger.md §2.1)
      const extras = ['db-stats.json', 'hpa.json', 'gate.json', 'deltas.json', 'payment-state.json', join('invariants', 'invariants-detail.ndjson')].map((f) => join(outDir, f)).filter((f) => existsSync(f));
      const collectMain = (checksFile, notes) => execFileSync(
        PYTHON,
        [
          '-I',
          '-X',
          'utf8',
          ...collectArgs({
            runId: a.runId,
            kpi: kpiOf(a),
            version: 'v0',
            profile: a.profile,
            users: a.users,
            ...(rps !== undefined ? { rps } : {}),
            durationS: a.mainS,
            warmupS: a.warmS,
            scenario: `loadtest/scenarios/${SCENARIOS[a.scenario]}`,
            summaryFile: join(outDir, 'summary.json'),
            infraFile,
            notes,
            // collect.py는 시작 + 예열부터 센다(docs/perf-ledger.md §2.2 checks·metrics-summary). 그래서 시작은 예열 시작이다
            start: new Date(marks.main_start - a.warmS * 1000).toISOString(),
            end: new Date(marks.main_end).toISOString(),
            ...(g.judge.valid ? {} : { invalidReason: g.judge.reasons.join('; ') }),
            ...(invFile ? { invariants: invFile } : {}),
            ...(extras.length ? { extra: extras } : {}),
            generator: `k6 1.4.2, 발생기 파드 ${nGen}대(CPU ${gen.cpus}·메모리 ${gen.memoryMi}Mi씩, kind 안${split ? ', k6 실행 구간으로 나눔' : ''})`,
            ...(checksFile ? { checks: checksFile } : {}),
            ...(a.promUrl ? { promUrl: a.promUrl, queries: join(REPO, QUERIES_V0) } : {}),
            rawBucket: RAW_BUCKET,
            rawOutbox: RAW_OUTBOX,
          }),
        ],
        { cwd: REPO, stdio: 'inherit' },
      );
      try {
        collectMain(checksFile, notes);
      } catch (e) {
        // 측정 창 안에서 앱 파드가 다시 시작하면 collect.py가 서버 히스토그램을 셀 수 없다고 종료 코드 3으로 실행째 거부한다(측정 폴더를 만들기 전).
        // 그때만 히스토그램 점검과 지연 대조를 빼고 다시 남긴다(2026-11-03 새 맥락 리뷰·2차 리뷰)
        // 종료 신호로 끝났거나 다른 까닭의 거부(종료 코드 3이 아님)면 그대로 실패한다
        const left = withoutHistogramChecks(checks);
        if (e.signal || e.status !== 3 || !left.dropped.length || existsSync(join(LEDGER_RUNS, a.runId))) throw e;
        const retryFile = left.checks ? join(outDir, 'checks-no-histogram.json') : undefined;
        if (retryFile) writeFileSync(retryFile, JSON.stringify(left.checks, null, 2));
        log(`서버 히스토그램 점검(${left.dropped.join(', ')})을 셀 수 없어 빼고 다시 남긴다`);
        collectMain(retryFile, `${notes}; 서버 히스토그램 점검 ${left.dropped.join(', ')}은 측정 창 안의 앱 파드 재시작으로 셀 수 없어 뺐다`);
      }
      if (probesOut.hpa) {
        // K9(v0 HPA 확장 시간)는 같은 실행의 HPA 시간선으로 따로 남긴다(docs/verification.md §3.10 K9)
        const k9Id = `${a.runId}-k9`;
        step(`성능 장부(${k9Id})`);
        const h = probesOut.hpa;
        const k9Notes = `K1 실행 ${a.runId}와 같은 실행의 HPA 시간선(부하 시작 기준): 첫 확장 ${h.firstRescaleS ?? '-'}초, 늘린 파드 첫 준비 ${h.firstNewReadyS ?? '-'}초(목표 60초 미만, K9 ①), 최대 복제 ${h.maxSize ?? '-'}, 새 파드 ${h.newPods.length}개. 앱 CPU HPA 목표 70%·최소 1·최대 4(deploy/envs/local/v0-monolith.yaml), 쿠버네티스 기본 확장 동작`;
        execFileSync(
          PYTHON,
          [
            '-I',
            '-X',
            'utf8',
            ...collectArgs({
              runId: k9Id,
              kpi: 'K9',
              version: 'v0',
              profile: a.profile,
              users: a.users,
              durationS: Math.round((marks.main_end - loadStartMs) / 1000),
              warmupS: 0,
              scenario: `loadtest/scenarios/${SCENARIOS[a.scenario]}`,
              summaryFile: join(outDir, 'summary.json'),
              infraFile,
              notes: k9Notes,
              start: new Date(loadStartMs).toISOString(),
              end: new Date(marks.main_end).toISOString(),
              ...(g.judge.valid ? {} : { invalidReason: g.judge.reasons.join('; ') }),
              extra: [join(outDir, 'hpa.json')],
              generator: `k6 1.4.2, 발생기 파드 ${nGen}대(CPU ${gen.cpus}·메모리 ${gen.memoryMi}Mi씩, kind 안)`,
              rawBucket: RAW_BUCKET,
              rawOutbox: RAW_OUTBOX,
            }),
          ],
          { cwd: REPO, stdio: 'inherit' },
        );
      }
    }
    return { outDir, exitCode, eventId };
  } catch (e) {
    exitCode = 1;
    throw e;
  } finally {
    // 정리를 먼저 한다(기록 쓰기가 실패해도 파드·폴더·Secret은 지우고, 끊은 입구는 되돌린다)
    cleanups.delete(cleanup);
    await cleanup();
    try {
      writeFileSync(join(outDir, 'run.json'), JSON.stringify({ scenario: a.scenario, runTag, eventId, hostDir, namespace: a.namespace, args: a, startedAt, endedAt: new Date().toISOString(), k6Exit, exitCode }, null, 2));
    } catch (e) {
      console.error(`run.json을 쓰지 못했다: ${e.message}`);
    }
  }
}

/** 받는 파드들이 끝날 때까지 기다려(최대 60초) 출력 줄을 읽는다 */
async function readListenerOutputs(hostDir, n) {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    const done = onNode(['sh', '-c', `ls ${hostDir}/out/ 2>/dev/null | grep -c '^delta-.*\\.done$' || true`]).trim();
    if (Number(done) >= n) break;
    await sleep(1000);
  }
  const errs = onNode(['sh', '-c', `cat ${hostDir}/out/delta-*.error 2>/dev/null || true`]).trim();
  if (errs) throw new Error(`변경분 받는 파드가 실패했다: ${errs.slice(0, 500)}`);
  const text = onNode(['sh', '-c', `cat ${hostDir}/out/delta-*.ndjson 2>/dev/null || true`]);
  const done = Number(onNode(['sh', '-c', `ls ${hostDir}/out/ 2>/dev/null | grep -c '^delta-.*\\.done$' || true`]).trim()) || 0;
  return { lines: text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)), done };
}

/** 받는 파드의 본구간 CPU(한도 대비 %): 파드마다 창 양 끝 칸의 cpuUsec 차이 ÷ 창 길이. 가장 높은 파드 */
function listenerCpu(lines, marks, cpus) {
  const byPod = new Map();
  for (const l of lines) {
    if (l.kind !== 'delta_bucket' || l.sec * 1000 < marks.main_start || (l.sec + 1) * 1000 > marks.main_end) continue;
    const arr = byPod.get(l.pod) ?? [];
    arr.push(l);
    byPod.set(l.pod, arr);
  }
  let max = 0;
  for (const arr of byPod.values()) {
    arr.sort((x, y) => x.sec - y.sec);
    const first = arr[0];
    const last = arr[arr.length - 1];
    const s = last.sec - first.sec;
    if (s <= 0) continue;
    max = Math.max(max, Math.round(((last.cpuUsec - first.cpuUsec) / (s * 1e6 * cpus)) * 1000) / 10);
  }
  return { meanPctMax: max };
}

/** 발생기 여럿의 지표를 하나로: 판정은 하나라도 무효면 무효(사유에 발생기 번호) */
function combineGenerators(gens, loadStartMs) {
  const reasons = [];
  gens.forEach((g, i) => {
    for (const r of g.judge.reasons) reasons.push(gens.length > 1 ? `발생기 ${i}: ${r}` : r);
  });
  const starts = gens.map((g) => g.startedS).filter((x) => Number.isFinite(x));
  return {
    // 발생기가 하나면 예전 모양(cpus·stats·judge·marks 등, BSL-060)을 그대로 두고 아래 합친 칸을 더한다(loadtest/e2e/v0-rehearsal.e2e.mjs가 읽는다)
    ...(gens.length === 1 ? gens[0] : {}),
    generators: gens.length,
    loadStartMs,
    startSkewS: starts.length > 1 ? Math.max(...starts) - Math.min(...starts) : 0,
    cpuMeanPctMax: Math.max(...gens.map((g) => g.stats.cpuMeanPct)),
    cpuMaxPctMax: Math.max(...gens.map((g) => g.stats.cpuMaxPct)),
    memMaxPctMax: Math.max(...gens.map((g) => g.stats.memMaxPct)),
    dropped: gens.reduce((s, g) => s + g.dropped, 0),
    scenarioErrors: gens.reduce((s, g) => s + g.scenarioErrors, 0),
    vusMax: gens.reduce((s, g) => s + g.vusMax, 0),
    judge: { valid: reasons.length === 0, reasons },
    each: gens,
  };
}

/** 장부 notes: 발생기, 경로 p99(나눴으면 아래·위 한계), 실패, 곁에서 잰 것 */
function runNotes(a, { generator: g, merged, probes, maxRate, nGen }) {
  const m = merged.metrics;
  const parts = [`발생기 ${nGen}대 CPU 평균 최고 ${g.cpuMeanPctMax}%·메모리 최대 ${g.memMaxPctMax}%, VU 최대 합 ${g.vusMax}, 시나리오 오류 ${g.scenarioErrors}건, 계획 최고 도착률 ${Math.round(maxRate)}/s(docs/verification.md §3.9·§3.10)`];
  for (const r of ROUTES[a.scenario]) {
    const n = m[`http_reqs{phase:main,route:${r}}`]?.values?.count;
    if (!n) continue;
    const d = m[`http_req_duration{phase:main,route:${r}}`]?.values ?? {};
    const f = m[`http_req_failed{phase:main,route:${r}}`]?.values?.passes ?? 0;
    const b = merged.merge?.bounds?.[`http_req_duration{phase:main,route:${r}}`]?.['p(99)'];
    const p99 = b && b[0] !== b[1] ? `${b[0].toFixed(1)}~${b[1].toFixed(1)}ms` : `${(d['p(99)'] ?? NaN).toFixed(1)}ms`;
    parts.push(`${r}: ${n}건, p99 ${p99}, 실패 ${f}건`);
  }
  if (probes.db) {
    // 바뀐 표만 적는다(넣음·갱신·지움이 있는 표)
    const t = Object.entries(probes.db.tables).filter(([, v]) => v.inserts + v.updates + v.deletes > 0).map(([k, v]) => `${k} 넣음 ${v.inserts}·갱신 ${v.updates}·HOT ${v.hotRatio === null ? '-' : `${Math.round(v.hotRatio * 1000) / 10}%`}·지움 ${v.deletes}·죽은 행 ${v.deadRows}`).join(', ') || '바뀐 표 없음';
    parts.push(`DB: 교착 ${probes.db.deadlocks}, 롤백 ${probes.db.rollbacks}, ${t}`);
  }
  if (probes.hpa) parts.push(`HPA: 첫 확장 ${probes.hpa.firstRescaleS ?? '-'}초, 새 파드 첫 준비 ${probes.hpa.firstNewReadyS ?? '-'}초, 최대 복제 ${probes.hpa.maxSize ?? '-'}(부하 시작 기준)`);
  if (probes.gate) {
    const x = probes.gate;
    parts.push(`검표: 온라인 분당 ${x.online.perMinute}건(p95 ${x.online.p95Ms ?? '-'}ms), 끊김 분당 ${x.cut.perMinute}건(실패 ${x.cut.failed}), 복구 분당 ${x.restored.perMinute}건, 판정이 멈춘 가장 긴 시간 ${x.maxGapS}초, 끊김/온라인 ${x.offlineRatio ?? '-'}`);
  }
  if (probes.deltas) {
    const x = probes.deltas;
    parts.push(`변경분: 연결 ${x.connected}(실패 ${x.failed}), 초당 ${x.msgsPerS}건·${x.bytesPerS} B, 종단 p50 ${x.latency.p50Ms ?? '-'}ms·p99 ${x.latency.p99Ms ?? '>30000'}ms(300ms 넘음 ${x.latency.over300}건), 서버가 닫음 ${x.closed}, 받는 파드 CPU 최고 ${x.clientCpu.meanPctMax}%`);
  }
  if (probes.paymentState) {
    const x = probes.paymentState;
    parts.push(`v0 표: 좌석 누수 ${x.seatLeak}, 멈춘 주문 PAYING ${x.ordersPaying}·APPROVED ${x.ordersApproved}, 확정 ${x.ordersConfirmed}, 실패 ${x.ordersFailed}, 결제 CONFIRMING ${x.paymentsConfirming}`);
  }
  if (probes.killed) parts.push(`앱 파드 강제 종료 ${probes.killed.name}`);
  if (a.faultDropPct || a.faultDelayPct) parts.push(`결제사 장애: 응답 버림 ${a.faultDropPct}%·${FAULT_DELAY_MS}ms 지연 ${a.faultDelayPct}%`);
  return parts.join('; ');
}

// ───────────── 발생기 보정 ─────────────

async function startNullTarget(targetCpus) {
  const dir = mkdtempSync(join(tmpdir(), 'null-target-tls-'));
  let cert;
  let key;
  try {
    execFileSync('openssl', nullTargetCertArgs(join(dir, 'tls.key'), join(dir, 'tls.crt')), { stdio: ['ignore', 'ignore', 'pipe'] });
    cert = readFileSync(join(dir, 'tls.crt'), 'utf8');
    key = readFileSync(join(dir, 'tls.key'), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await stopNullTarget();
  await createObject(nullTargetSecret({ cert, key }));
  for (const obj of nullTargetManifests({ cpus: targetCpus })) await createObject(obj);
  await kc(['-n', NS, 'rollout', 'status', `deploy/${NULL_TARGET_NAME}`, '--timeout=300s'], { timeout: 320_000 });
  return cert;
}

async function stopNullTarget() {
  // 디플로이먼트는 파드가 다 지워진 뒤 끝나게 지운다(기본은 파드를 뒤에서 지워 잠깐 남는다)
  await kc(['-n', NS, 'delete', 'deployment', NULL_TARGET_NAME, '--ignore-not-found', '--cascade=foreground', '--wait=true'], { timeout: 180_000 }).catch(() => {});
  for (const kind of ['service', 'configmap', 'secret']) await kc(['-n', NS, 'delete', kind, NULL_TARGET_NAME, '--ignore-not-found']).catch(() => {});
}

/** 대역 파드의 cgroup CPU 사용(µs) */
async function targetUsageUsec() {
  const text = await kc(['-n', NS, 'exec', `deploy/${NULL_TARGET_NAME}`, '--', 'cat', '/sys/fs/cgroup/cpu.stat']);
  const m = /^usage_usec (\d+)$/m.exec(text);
  return m ? Number(m[1]) : NaN;
}

async function runCalibrate(a, runTag) {
  const outDir = resolve(a.out ?? join(OUT_ROOT, `${today()}-calibrate-${runTag}`));
  mkdirSync(outDir, { recursive: true });
  const pod = `loadgen-${runTag}`;
  const hostDir = `${NODE_ROOT}/${runTag}`;
  const steps = [];
  // 잠금을 잡은 뒤에만 공용 객체(빈 응답 대역)를 지운다(다른 실행의 보정을 망가뜨리지 않게)
  let locked = false;
  const cleanup = async () => {
    await kc(['-n', NS, 'delete', 'pod', pod, '--ignore-not-found', '--wait=true']).catch(() => {});
    removeNodeDir(hostDir);
    if (!locked) return;
    await stopNullTarget();
    await releaseLock(runTag);
  };
  cleanups.add(cleanup);
  const save = () => {
    const capacity = calibrationCapacity(steps);
    writeFileSync(join(outDir, 'calibration.json'), JSON.stringify({ runTag, hostDir, cpus: a.cpus, memoryMi: a.memoryMi, targetCpus: a.targetCpus, warmS: a.warmS, mainS: a.mainS, steps, capacity }, null, 2));
    return capacity;
  };
  try {
    step('네임스페이스, 실행 잠금, 빈 응답 대역');
    await ensureNamespace();
    await acquireLock(runTag, Date.now() + (a.rates.length * (a.warmS + a.mainS + 30) * 2 + 600) * 1000);
    locked = true;
    await sweepLeftovers();
    const caPem = await startNullTarget(a.targetCpus);
    step(`발생기 파드 ${pod}(CPU ${a.cpus}, 메모리 ${a.memoryMi}Mi)`);
    // 대역은 토큰을 보지 않는다. 요청 크기만 같게 실행마다 만든 키로 서명한다(v0 키를 쓰지 않는다)
    const tokens = tokensJson(generateV0TokenKey().privateJwk, runTag, 1000, 3600);
    stageInputs(hostDir, { caPem, tokens });
    await startGenerator(pod, a, hostDir, { deadlineS: a.rates.length * (a.warmS + a.mainS + 30) * 2 + 600 });
    writeFileSync(join(outDir, 'infra.txt'), infraText({ cpus: a.cpus, memoryMi: a.memoryMi, targetCpus: a.targetCpus, args: a }));

    for (const rate of a.rates) {
      step(`도착률 ${rate}/s(예열 ${a.warmS}초, 본구간 ${a.mainS}초)`);
      try {
      const vus = vuPlan(rate, a.memoryMi, 0.01, 50);
      const t0 = Date.now();
      const u0 = await targetUsageUsec();
      const out = await runK6(pod, hostDir, { SCENARIO: 'calibrate.js', BASE: NULL_TARGET_URL, RUN_TAG: runTag, OUT_DIR: '/work/out', USERS_FILE: '/work/users.json', RATE: rate, WARM_S: a.warmS, MAIN_S: a.mainS, PRE_VUS: vus.pre, MAX_VUS: vus.max }, a.warmS + a.mainS + 30);
      const u1 = await targetUsageUsec();
      const targetCpuPct = Math.round(((u1 - u0) / ((Date.now() - t0) * 1000 * a.targetCpus)) * 1000) / 10;
      const dir = join(outDir, `step-${rate}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'k6.log'), out.k6log);
      writeFileSync(join(dir, 'cgroup.log'), out.cgroup);
      if (out.exit !== 0 && out.exit !== 99) throw new Error(`k6가 종료 코드 ${out.exit}로 끝났다:\n${out.k6log.slice(-1500)}`);
      const ev = evaluate(out, a);
      writeFileSync(join(dir, 'summary.json'), JSON.stringify(ev.summary, null, 2));
      const m = ev.summary.metrics;
      const p99Ms = m.http_req_duration?.values?.['p(99)'];
      const failedRate = m.http_req_failed?.values?.rate ?? 0;
      const g = ev.generator;
      const verdict = judgeCalibrationStep({ rate, dropped: g.dropped, cpuMeanPct: g.stats.cpuMeanPct, memMaxPct: g.stats.memMaxPct, failedRate, p99Ms });
      const s = { rate, passed: verdict.passed, reasons: verdict.reasons, p99Ms, failedRate, dropped: g.dropped, stats: g.stats, vusMax: g.vusMax, perVuBytes: g.perVuBytes, targetCpuPct, judge: g.judge, marks: g.marks };
      steps.push(s);
      save(); // 단계마다 남긴다(뒤에서 끊겨도 앞 단계 결과가 남게)
      log(`p99 ${p99Ms?.toFixed?.(2)}ms, 실패율 ${failedRate}, dropped ${g.dropped}, 발생기 CPU 평균 ${g.stats.cpuMeanPct}%·최고 ${g.stats.cpuMaxPct}%, 메모리 ${g.stats.memMaxPct}%, VU 최대 ${g.vusMax}, 대역 CPU(k6 실행 전체 평균) ${targetCpuPct}% → ${verdict.passed ? '통과' : `통과 못 함(${verdict.reasons.join('; ')})`}`);
      } catch (e) {
        // 한 단계가 돌지 못해도(k6 메모리 초과 등) 앞 단계 결과는 남긴다. 그 위 단계는 재지 않는다
        const reason = `단계를 재지 못함: ${String(e.message).split('\n')[0]}`;
        steps.push({ rate, passed: false, reasons: [reason], failed: true });
        save();
        log(reason);
        break;
      }
    }
    const capacity = save();
    log(`\n발생기 용량(CPU ${a.cpus}): ${capacity.capacityRps ?? '없음'}/s${capacity.topReached ? '(가장 높은 단계까지 통과 — 더 높은 단계를 잰다)' : ''}${capacity.limitedBy ? `, 막힌 단계 ${capacity.limitedBy.rate}/s: ${capacity.limitedBy.reasons.join('; ')}` : ''}`);

    if (a.record) {
      for (const s of steps.filter((x) => !x.failed)) {
        const runId = `${today()}-gen-calib-c${a.cpus}-r${s.rate}-${runTag}`;
        step(`성능 장부(${runId})`);
        const notes = `발생기 보정(local-gen, docs/verification.md §3.9): CPU ${a.cpus}·메모리 ${a.memoryMi}Mi 발생기 → 빈 응답 대역(CPU ${a.targetCpus}). ${s.passed ? '통과' : `통과 못 함: ${s.reasons.join('; ')}`}. 발생기 CPU 평균 ${s.stats.cpuMeanPct}%·최고 ${s.stats.cpuMaxPct}%, 메모리 최대 ${s.stats.memMaxPct}%, VU 최대 ${s.vusMax}, VU당 메모리 ${s.perVuBytes} B, 대역 CPU ${s.targetCpuPct}%. 이 CPU 몫의 용량 ${capacity.capacityRps ?? '없음'}/s`;
        execFileSync(
          PYTHON,
          [
            '-I',
            '-X',
            'utf8',
            ...collectArgs({
              runId,
              kpi: 'NFR-013',
              version: 'v0',
              profile: 'local-gen',
              rps: s.rate,
              durationS: a.mainS,
              warmupS: a.warmS,
              scenario: 'loadtest/scenarios/calibrate.js',
              summaryFile: join(outDir, `step-${s.rate}`, 'summary.json'),
              infraFile: join(outDir, 'infra.txt'),
              notes,
              start: new Date(s.marks.main_start - a.warmS * 1000).toISOString(),
              end: new Date(s.marks.main_end).toISOString(),
              ...(s.judge.valid ? {} : { invalidReason: s.judge.reasons.join('; ') }),
              generator: `k6 1.4.2, 발생기 파드 1대(CPU ${a.cpus}·메모리 ${a.memoryMi}Mi, kind 안)`,
            }),
          ],
          { cwd: REPO, stdio: 'inherit' },
        );
      }
    }
    return { outDir, exitCode: steps.some((x) => x.failed) ? 1 : 0 };
  } finally {
    cleanups.delete(cleanup);
    await cleanup();
  }
}

// ───────────── 시작 ─────────────

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let a;
  try {
    a = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`loadtest/run.mjs: ${e.message}`);
      console.error('쓰는 법: node loadtest/run.mjs calibrate [...] | v0 queue|seat-hold|payment|seat-deltas|gate [...] | cleanup (loadtest/README.md)');
      process.exit(2);
    }
    throw e;
  }
  const runTag = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`.slice(0, 16);
  // Ctrl+C·kill 신호를 받으면 finally가 돌지 않으므로 여기서 정리하고 끝낸다(발생기 파드가 남아 부하를 계속 보내지 않게)
  let stopping = false;
  // 종료 코드는 관례대로 128 + 신호 번호다
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGBREAK', 149], ['SIGHUP', 129]]) {
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      console.error(`\nloadtest/run.mjs: ${sig}를 받아 발생기 파드·실행 폴더·시험 키·실행 잠금을 지우고 끝낸다`);
      runCleanups().finally(() => process.exit(code));
    });
  }
  // 처리하지 못한 오류로 끝날 때도 정리한다(발생기 파드·끊은 입구·실행 잠금이 남지 않게, 2026-11-03 새 맥락 리뷰)
  for (const ev of ['unhandledRejection', 'uncaughtException']) {
    process.on(ev, (e) => {
      if (stopping) return;
      stopping = true;
      console.error(`\nloadtest/run.mjs: 처리하지 못한 오류(${ev}): ${e?.message ?? e}. 정리하고 끝낸다`);
      runCleanups().finally(() => process.exit(1));
    });
  }
  try {
    const r = a.command === 'cleanup' ? await runCleanup() : a.command === 'calibrate' ? await runCalibrate(a, runTag) : await runV0(a, runTag);
    log(`\n산출물: ${r.outDir}`);
    process.exit(r.exitCode);
  } catch (e) {
    console.error(`loadtest/run.mjs: ${e.message}`);
    process.exit(1);
  }
}
