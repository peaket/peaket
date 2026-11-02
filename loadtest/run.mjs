#!/usr/bin/env node
// k6 부하 실행 도구(docs/verification.md §3.9, loadtest/README.md). 저장소 뿌리에서 돌린다.
//   node loadtest/run.mjs cleanup   강제로 끝난 실행이 남긴 발생기 파드·실행 폴더·시험 키·빈 응답 대역·실행 잠금을 지운다
//   node loadtest/run.mjs calibrate [--cpus 4] [--memory-mi 4096] [--target-cpus 8] [--rates 1000,2000,4000,8000] [--warm 10] [--main 30] [--record] [--out <폴더>]
//   node loadtest/run.mjs v0 queue --users N --entry-rate R --admit-per-second A [공통]
//   node loadtest/run.mjs v0 seat-hold --users N --rate R [--mode spread|hot|crossed] [--hold-size 2] [--hot-count 1] [--pairs 1] [--release-ms 0] [공통]
//   node loadtest/run.mjs v0 payment --users N --rate R [--seats-per-order 2] [공통]
//   공통: [--warm 30] [--main 60] [--cpus 4] [--memory-mi 4096] [--record --run-id <ID> [--profile <이름>]] [--invariants] [--out <폴더>]
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
import { KUBECONFIG, V0_ALLOWED_ORIGINS, V0_NAMESPACE, V0_TOKEN_KEY_FILE, kubectl } from '../tools/local/cluster.mjs';
import { ensureTool } from '../tools/local/tools.mjs';
import { generateV0TokenKey, loadOrCreateV0TokenKey, signV0Token } from '../tools/local/v0-token.mjs';
import { pollStages } from './lib/model.mjs';
import { seatCount } from './lib/seats.mjs';
import { accountRef, pidOf, sidOf } from './lib/users.mjs';
import { SCENARIOS, UsageError, parseArgs } from './runner/args.mjs';
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
  SIM_KEY_NAME,
  SIM_KEY_SECRET,
  generatorPod,
  nullTargetCertArgs,
  nullTargetManifests,
  nullTargetSecret,
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
const NS = LOADGEN_NAMESPACE;
const GATEWAY_URL = `https://v0-gateway.${V0_NAMESPACE}.svc.cluster.local:8443`;
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

// ───────────── 준비 ─────────────

async function preflightV0() {
  try {
    await kc(['-n', V0_NAMESPACE, 'get', 'deploy/v0-gateway', 'deploy/v0-monolith', '-o', 'name']);
  } catch {
    throw new Error('v0가 올라와 있지 않다. 먼저: node tools/local/cluster.mjs up && node tools/local/cluster.mjs v0');
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
  const pods = (await kc(['-n', NS, 'get', 'pods', '-l', 'app.kubernetes.io/name=loadgen', '-o', 'name'])).trim();
  if (pods) {
    log(`이전 실행이 남긴 발생기 파드를 지운다: ${pods.split('\n').join(', ')}`);
    await kc(['-n', NS, 'delete', 'pods', '-l', 'app.kubernetes.io/name=loadgen', '--wait=true'], { timeout: 180_000 });
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
async function inAppPod(script, timeout = 300_000) {
  // 스크립트는 인자 하나로 넘긴다(표준 입력은 이 PC에서 잘릴 수 있다). 몇 KB라 명령줄 한도(32K) 안이다
  const out = await kc(['-n', V0_NAMESPACE, 'exec', 'deploy/v0-monolith', '--', 'node', '--input-type=module', '-e', script], { timeout });
  const m = /^@@RESULT (.*)$/m.exec(out);
  if (!m) throw new Error(`앱 파드 안 스크립트에 결과 줄이 없다:\n${out.slice(-1500)}`);
  return JSON.parse(m[1]);
}

const b64json = (v) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');

/** 회차 열기(대기열 부르는 속도)·좌석·가격(모듈 공개 함수, docs/features/*.md의 v0 절) */
function seedScript(p) {
  return `import { createDatabase } from '@peaket/platform';
import { createBookingAdmin } from './dist/modules/booking/index.js';
import { createSeatAdmin, seatGrid } from './dist/modules/inventory/index.js';
import { createQueueAdmin } from './dist/modules/queue/index.js';
import { createV0Redis } from './dist/redis.js';
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
  process.stdout.write('@@RESULT ' + JSON.stringify({ eventId: p.eventId, seats }) + '\\n');
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
function tokensJson(privateJwk, runTag, users, ttlS) {
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
  if (a.scenario === 'seat-hold') return SEAT_HOLD_GRID;
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
  await kc(['-n', NS, 'wait', '--for=condition=Ready', `pod/${name}`, '--timeout=300s'], { timeout: 320_000 });
}

/**
 * 파드 입력을 이 PC의 임시 폴더에 꾸려 노드의 실행 폴더로 옮긴다(docker cp). 임시 폴더는 바로 지운다(토큰이 든다).
 * 실행 폴더는 k6 사용자만 읽고 쓴다
 */
function stageInputs(hostDir, { caPem, tokens }) {
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
    put('ca.pem', caPem);
    put('users.json', tokens);
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

/** k6를 한 번 돌리고 끝날 때까지 기다린다. 끝나면 산출물 글을 돌려준다 */
async function runK6(pod, hostDir, env, expectedS) {
  putNodeFile(hostDir, 'run.env', runEnvFile(env));
  // 앞 단계의 종료 코드 파일을 읽지 않게 시작 전에 지운다
  onNode(['rm', '-f', `${hostDir}/out/exit`, `${hostDir}/out/exit.tmp`]);
  await kc(['-n', NS, 'exec', pod, '--', 'sh', '-c', 'nohup sh /work/bin/run.sh >/dev/null 2>&1 &']);
  const until = Date.now() + (expectedS * 2 + 300) * 1000;
  let exit;
  while (Date.now() < until) {
    await sleep(3000);
    try {
      exit = onNode(['cat', `${hostDir}/out/exit`], { timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      break;
    } catch {
      // 아직 끝나지 않았다(파일 없음)
    }
  }
  if (exit === undefined) {
    await kc(['-n', NS, 'exec', pod, '--', 'pkill', 'k6']).catch(() => {});
    throw new Error(`k6가 ${expectedS * 2 + 300}초 안에 끝나지 않았다`);
  }
  const read = async (f) => {
    try {
      return onNode(['cat', `${hostDir}/out/${f}`], { stdio: ['ignore', 'pipe', 'ignore'] });
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
  };
}

/** 요약·콘솔·cgroup으로 발생기 지표와 판정 */
function evaluate(out, a) {
  if (!out.summary) throw new Error(`k6 요약이 없다(종료 코드 ${out.exit}):\n${out.k6log.slice(-1500)}`);
  const summary = JSON.parse(out.summary);
  const m = summary.metrics;
  const { records, marks } = splitConsole(out.console);
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
    `발생기: k6 ${K6_IMAGE}, 파드 CPU ${extra.cpus}·메모리 ${extra.memoryMi}Mi(요청 = 한도), GOMAXPROCS ${extra.cpus}`,
    ...(extra.targetCpus ? [`빈 응답 대역: ${NULL_TARGET_IMAGE}, CPU ${extra.targetCpus}·메모리 256Mi(요청 = 한도)`] : []),
    '시계: 발생기와 대상이 같은 PC 커널 시계를 쓴다(시계 차이 0, docs/perf-ledger.md §3 3번)',
    `CPU 배치: WSL 안에서 어느 코어에 놓일지 고르지 않는다(docs/verification.md §3.5 6번 '코어 혼합'은 표시만)`,
    `인자: ${JSON.stringify(extra.args)}`,
    '',
  ].join('\n');
}

// ───────────── 불변식 검사(--invariants) ─────────────

async function runInvariants(outDir, recordsFile) {
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
    const db = `postgres://postgres:peaket-local@127.0.0.1:${port}/v0`;
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

async function runV0(a, runTag) {
  const outDir = resolve(a.out ?? join(OUT_ROOT, `${today()}-${a.scenario}-${runTag}`));
  mkdirSync(outDir, { recursive: true });
  const pod = `loadgen-${runTag}`;
  const hostDir = `${NODE_ROOT}/${runTag}`;
  const eventId = randomUUID();
  const grid = gridFor(a);
  const startedAt = new Date().toISOString();
  let exitCode = 0;
  let k6Exit = null;
  // 잠금을 잡기 전에 끝나면(다른 실행이 돌고 있음) 이 실행 이름의 파드·폴더만 지우고 공용 객체(시험 키 Secret)는 건드리지 않는다
  let locked = false;
  const cleanup = async () => {
    await kc(['-n', NS, 'delete', 'pod', pod, '--ignore-not-found', '--wait=true']).catch(() => {});
    removeNodeDir(hostDir);
    if (!locked) return;
    if (a.scenario === 'payment') await kc(['-n', NS, 'delete', 'secret', SIM_KEY_SECRET, '--ignore-not-found']).catch(() => {});
    await releaseLock(runTag);
  };
  cleanups.add(cleanup);
  try {
    step('v0와 네임스페이스 확인');
    await preflightV0();
    await ensureNamespace();

    // 시나리오 시간과 가상 사용자 수
    let maxRate;
    let busyS;
    let prepS;
    if (a.scenario === 'queue') {
      const entryS = Math.ceil(a.users / a.entryRate);
      const q = { users: a.users, entryRate: a.entryRate, admitPerSecond: a.admitPerSecond };
      const plan = [pollStages({ ...q, startS: entryS, durationS: a.warmS }), pollStages({ ...q, startS: entryS + a.warmS, durationS: a.mainS })];
      maxRate = Math.max(a.entryRate, ...plan.flatMap((p) => [p.startRate, ...p.stages.map((s) => s.target)]));
      prepS = entryS;
    } else {
      const prepRate = Math.min(a.users, 200);
      prepS = 2 * Math.ceil(a.users / prepRate) + 3;
      maxRate = Math.max(a.rate, prepRate);
    }
    busyS = prepS + a.warmS + a.mainS + 60;
    // 홀드를 잡고 기다리는 동안(--release-ms) 가상 사용자가 묶인다
    const perReqS = a.scenario === 'payment' ? 0.5 : a.scenario === 'seat-hold' ? 0.05 + a.releaseMs / 1000 : 0.05;
    const vus = vuPlan(maxRate, a.memoryMi, perReqS);

    step('실행 잠금과 남은 것 쓸어 내기');
    await acquireLock(runTag, Date.now() + (busyS * 2 + 600) * 1000);
    locked = true;
    await sweepLeftovers();

    step(`회차 ${eventId} 열기`);
    // 판매 종료 시각을 실행 뒤로 둔다. 끝난 회차는 입장 루프가 부르지 않아, 실행이 쌓여도 다음 측정의 Redis 부하가 늘지 않는다
    const seeded = await inAppPod(
      seedScript({
        eventId,
        admitPerSecond: a.scenario === 'queue' ? a.admitPerSecond : 100000,
        saleEndsAtMs: Date.now() + (busyS + 600) * 1000,
        ...(grid ? { grid, perPersonLimit: PER_PERSON_LIMIT, prices: { R: 150000 } } : {}),
      }),
    );
    log(`좌석 ${seeded.seats}석`);

    step(`가상 사용자 ${a.users}명의 토큰 서명(이 PC)`);
    const { privateJwk } = loadOrCreateV0TokenKey(V0_TOKEN_KEY_FILE);
    const tokens = tokensJson(privateJwk, runTag, a.users, Math.min(TOKEN_TTL_MAX_S, busyS + 600));

    step(`발생기 파드 ${pod}(CPU ${a.cpus}, 메모리 ${a.memoryMi}Mi)`);
    if (a.scenario === 'payment') {
      const raw = (await kc(['-n', V0_NAMESPACE, 'get', 'secret', 'pg-simulator', '-o', `jsonpath={.data.${SIM_KEY_NAME}}`])).trim();
      await kc(['-n', NS, 'delete', 'secret', SIM_KEY_SECRET, '--ignore-not-found']);
      await createObject(simKeySecret(Buffer.from(raw, 'base64').toString('utf8')));
    }
    const caPem = Buffer.from((await kc(['-n', V0_NAMESPACE, 'get', 'secret', 'v0-gateway', '-o', 'jsonpath={.data.PEAKET_V0_TLS_CERT}'])).trim(), 'base64').toString('utf8');
    stageInputs(hostDir, { caPem, tokens });
    await startGenerator(pod, a, hostDir, { simKey: a.scenario === 'payment', deadlineS: busyS * 2 + 600 });

    step(`k6 ${SCENARIOS[a.scenario]}(예상 ${busyS}초)`);
    const env = {
      SCENARIO: SCENARIOS[a.scenario],
      BASE: GATEWAY_URL,
      ORIGIN,
      RUN_TAG: runTag,
      OUT_DIR: '/work/out',
      USERS_FILE: '/work/users.json',
      EVENT_ID: eventId,
      USERS: a.users,
      WARM_S: a.warmS,
      MAIN_S: a.mainS,
      PRE_VUS: vus.pre,
      MAX_VUS: vus.max,
      ...(a.scenario === 'queue' ? { ENTRY_RATE: a.entryRate, ADMIT_PER_SECOND: a.admitPerSecond } : { RATE: a.rate, PREP_RATE: Math.min(a.users, 200) }),
      ...(grid ? { SECTIONS: grid.sections.join(','), ROWS: grid.rows, PER_ROW: grid.perRow } : {}),
      ...(a.scenario === 'seat-hold' ? { MODE: a.mode, HOLD_SIZE: a.holdSize, HOT_COUNT: a.hotCount, PAIRS: a.pairs, RELEASE_MS: a.releaseMs } : {}),
      ...(a.scenario === 'payment' ? { SEATS_PER_ORDER: a.seatsPerOrder, SIM_URL: `http://pg-simulator.${V0_NAMESPACE}.svc.cluster.local:8790` } : {}),
    };
    const out = await runK6(pod, hostDir, env, busyS);
    const k6DoneAtMs = Date.now();
    k6Exit = out.exit;
    writeFileSync(join(outDir, 'k6.log'), out.k6log);
    writeFileSync(join(outDir, 'cgroup.log'), out.cgroup);
    writeFileSync(join(outDir, 'console.ndjson'), out.console);
    if (out.exit !== 0 && out.exit !== 99) {
      exitCode = 1;
      throw new Error(`k6가 종료 코드 ${out.exit}로 끝났다:\n${out.k6log.slice(-1500)}`);
    }
    const ev = evaluate(out, a);
    writeFileSync(join(outDir, 'summary.json'), JSON.stringify(ev.summary, null, 2));
    writeFileSync(join(outDir, 'generator.json'), JSON.stringify(ev.generator, null, 2));

    step('시험 기록');
    let lines = [...ev.records];
    if (a.scenario === 'queue') lines = lines.concat(servingRecords(eventId, await inAppPod(servingLogScript(eventId))));
    if (a.scenario === 'payment') {
      const r = await inAppPod(LEDGER_SCRIPT);
      if (r.status !== 200) throw new Error(`시뮬레이터 원장을 받지 못했다(HTTP ${r.status})`);
      lines = lines.concat(pgChargeLines(r.body));
    }
    const recordsFile = join(outDir, 'records.ndjson');
    writeFileSync(recordsFile, lines.length ? `${lines.join('\n')}\n` : '');
    const infraFile = join(outDir, 'infra.txt');
    writeFileSync(infraFile, infraText({ cpus: a.cpus, memoryMi: a.memoryMi, args: a }));
    const g = ev.generator;
    log(`발생기: CPU 평균 ${g.stats.cpuMeanPct}%·최고 ${g.stats.cpuMaxPct}%, 메모리 최대 ${g.stats.memMaxPct}%, dropped ${g.dropped}, VU 최대 ${g.vusMax} → ${g.judge.valid ? '유효' : `무효(${g.judge.reasons.join('; ')})`}`);

    let invFile;
    if (a.invariants) {
      step('불변식 검사(peaket-invariants)');
      if (a.scenario === 'payment') {
        // P3(승인 뒤 60초 안에 발권 대기·발권)는 승인 뒤 60초가 지난 결제만 센다. 마지막 승인은 k6가 끝나기 전이므로
        // k6가 끝난 것을 본 때(이 PC 시계, 검사기의 기준 시각도 이 PC 시계)부터 65초를 기다린다
        const waitMs = k6DoneAtMs + 65_000 - Date.now();
        if (waitMs > 0) {
          log(`마지막 결제 승인 뒤 60초를 기다린다(${Math.ceil(waitMs / 1000)}초)`);
          await sleep(waitMs);
        }
      }
      const code = await runInvariants(outDir, recordsFile);
      invFile = join(outDir, 'invariants.csv');
      if (code === 1) exitCode = 1;
    }

    if (a.record) {
      step(`성능 장부(${a.runId})`);
      const kpi = a.scenario === 'queue' ? 'K1' : a.scenario === 'payment' ? 'K7' : a.mode === 'crossed' ? 'K3' : 'K2';
      const notes = `발생기 CPU 평균 ${g.stats.cpuMeanPct}%·최고 ${g.stats.cpuMaxPct}%, 메모리 최대 ${g.stats.memMaxPct}%, VU 최대 ${g.vusMax}, 시나리오 오류 ${g.scenarioErrors}건(docs/verification.md §3.9)`;
      const rps = a.scenario === 'queue' ? undefined : a.rate;
      execFileSync(
        PYTHON,
        [
          '-I',
          '-X',
          'utf8',
          ...collectArgs({
            runId: a.runId,
            kpi,
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
            start: new Date(ev.marks.main_start).toISOString(),
            end: new Date(ev.marks.main_end).toISOString(),
            ...(g.judge.valid ? {} : { invalidReason: g.judge.reasons.join('; ') }),
            ...(invFile ? { invariants: invFile } : {}),
            generator: `k6 1.4.2, 발생기 파드 1대(CPU ${a.cpus}·메모리 ${a.memoryMi}Mi, kind 안)`,
          }),
        ],
        { cwd: REPO, stdio: 'inherit' },
      );
    }
    return { outDir, exitCode, eventId };
  } catch (e) {
    exitCode = 1;
    throw e;
  } finally {
    // 정리를 먼저 한다(기록 쓰기가 실패해도 파드·폴더·Secret은 지운다)
    cleanups.delete(cleanup);
    await cleanup();
    try {
      writeFileSync(join(outDir, 'run.json'), JSON.stringify({ scenario: a.scenario, runTag, eventId, hostDir, args: a, startedAt, endedAt: new Date().toISOString(), k6Exit, exitCode }, null, 2));
    } catch (e) {
      console.error(`run.json을 쓰지 못했다: ${e.message}`);
    }
  }
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
              start: new Date(s.marks.main_start).toISOString(),
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
      console.error('쓰는 법: node loadtest/run.mjs calibrate [...] | v0 queue|seat-hold|payment [...] | cleanup (loadtest/README.md)');
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
  try {
    const r = a.command === 'cleanup' ? await runCleanup() : a.command === 'calibrate' ? await runCalibrate(a, runTag) : await runV0(a, runTag);
    log(`\n산출물: ${r.outDir}`);
    process.exit(r.exitCode);
  } catch (e) {
    console.error(`loadtest/run.mjs: ${e.message}`);
    process.exit(1);
  }
}
