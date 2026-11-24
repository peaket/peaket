#!/usr/bin/env node
// k6 부하 실행 도구(docs/verification.md §3.9, loadtest/README.md). 저장소 뿌리에서 돌린다.
//   node loadtest/run.mjs cleanup   강제로 끝난 실행이 남긴 발생기 파드·실행 폴더·시험 키·빈 응답 대역·실행 잠금을 지운다
//   node loadtest/run.mjs calibrate [--cpus 4] [--memory-mi 4096] [--target-cpus 8] [--rates 1000,2000,4000,8000] [--warm 10] [--main 30] [--record] [--out <폴더>]
//   node loadtest/run.mjs v0 queue --users N --entry-rate R --admit-per-second A [공통]
//   node loadtest/run.mjs v0 seat-hold --users N --rate R [--mode spread|hot|crossed] [--hold-size 2] [--hot-count 1] [--pairs 1] [--release-ms 0] [공통]
//   node loadtest/run.mjs v0 payment --users N --rate R [--seats-per-order 2] [--fault-drop-pct P] [--fault-delay-pct P] [--kill-app-at S] [--db-stats] [공통]
//   node loadtest/run.mjs v0 seat-deltas --users N --rate R --connections C [--listener-pods P] [--hold-size 2] [공통]
//   node loadtest/run.mjs v0 gate --scanners S --rate R [--cut-at 60] [--cut-s 60] [공통]
//   node loadtest/run.mjs gw sweep|capacity|ip-limit …(게이트웨이 차단 상한·검색 IP 한도, V-T43·SR-T13 ②. 인자는 loadtest/runner/gw.mjs 머리, 결과 sweep.json·capacity.json·ip-limit.json)
//   node loadtest/run.mjs gw limits --from <sweep.json,…> --saturation <수> --pod-cpus <수> [--out <폴더>](k와 운영 차단 상한 셈, 클러스터를 쓰지 않음, 결과 limits.json, BAT-058)
//   공통: [--warm 30] [--main 60] [--cpus 4] [--memory-mi 4096] [--target-cpus N] [--generators N] [--namespace v0|v0-base] [--settle] [--hpa-timeline]
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
import { V1_DATABASES, V1_HOST_DIRS, V1_NGINX_TAG, v1Layout } from '../tools/local/v1-objects.mjs';
import { V1_CONSENT_VERSION, V1_NAMESPACE, v1ClientKey } from '../tools/local/v1-stage.mjs';
import { v1SeatMap } from './lib/v1.mjs';
import { activeEventsProblem, entryTrials, pausedDelta, pauseReasons, readLeaseHolders, servingLogFromZset, skippedProblem, stagePgKey, V1_EXPECTED_SKIPPED, v1LedgerJudge, v1PaymentDbUrl, v1RecordProblem, withEntryRecords } from './runner/v1.mjs';
import { generateV0TokenKey, loadOrCreateV0TokenKey, signV0Token } from '../tools/local/v0-token.mjs';
import { pollStages } from './lib/model.mjs';
import { seatCount } from './lib/seats.mjs';
import { accountRef, pidOf, sidOf } from './lib/users.mjs';
import { DEFAULTS, SCENARIOS, UsageError, V1_ENTRY_SCENARIO, V1_SCENARIOS, parseArgs } from './runner/args.mjs';
import { GENERATOR_RATE as ENTRY_GENERATOR_RATE, hostTags, runEntrySteps } from './runner/entry-scale.mjs';
import { hostBetween, hostSnapshot } from './runner/host-metrics.mjs';
import { CHECK_PHASES, checksFromSummary, executionSegments, generatorCount, mergeSummaries, withoutHistogramChecks } from './runner/merge.mjs';
import { dbStatsDelta, deltaJudge, deltaSummary, gateOnlineCheck, gateSummary, hpaTimeline, V1_DB_STATS_SQL, v1Stats, v1StatsJudge } from './runner/probes.mjs';
import { sideTasks } from './runner/side.mjs';
import { ADMIN_PORT, GW_NAMESPACE, PROXY_SELECTOR, STEP_OVERHEAD_S, SWEEP_LABEL, gwConsole } from './runner/gw.mjs';
import { cleanupGw, gwCollectArgs, runGw, runLimits } from './runner/gw-run.mjs';
import { loadContract, token } from '../tools/local/e2e/gateway-client.mjs';
import { parseAllDocuments } from 'yaml';
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
    // v1 무대의 TLS 키·노드 파일·이미지 묶음 임시 폴더도(tools/local/cluster.mjs v1, 코드 리뷰 낮음)
    if (/^(loadgen-(env-)?|v1-(redis-tls|host|image)-)[A-Za-z0-9]{6}$/.test(d)) rmSync(join(tmpdir(), d), { recursive: true, force: true });
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
  // 게이트웨이 측정이 남긴 것(이름표 peaket.io/sweep 임시 정책, capacity가 되돌리지 못한 EnvoyProxy CPU 묶음 주석, BAT-056 R6).
  // 게이트웨이가 없는 클러스터면 건너뛴다
  try {
    await cleanupGw({ kubectl: (args, o = {}) => kubectl(args, { quiet: true, timeout: 120_000, maxBuffer: 1 << 30, ...(o.input !== undefined ? { input: o.input } : {}) }), log });
  } catch (e) {
    log(`게이트웨이 몫 정리를 건너뛴다: ${String(e.message ?? e).split('\n')[0]}`);
  }
  // 강제로 끝난 v1 실행이 남긴 진행 중 회차를 끝낸다(같은 무대의 다음 실행과 입장 제어를 나눠 쓰지 않게, 코드 리뷰 H1)
  let v1Up = false;
  try {
    await kc(['-n', V1_NAMESPACE, 'get', 'deploy/bundle', '-o', 'name']);
    v1Up = true;
  } catch {
    // v1 무대가 없다
  }
  if (v1Up) for (const e of await bundleSeed(['active'])) log(`남은 v1 회차 ${e}를 끝냈다: ${JSON.stringify(await bundleSeed(['close', e]))}`);
  log('정리했다');
  return { outDir: '(없음)', exitCode: 0 };
}

async function ensureNamespace() {
  await applyObject({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS, labels: { 'app.kubernetes.io/part-of': 'peaket-loadtest' } } });
}

/**
 * 앱 파드 안 관리 스크립트가 대기열 Redis에 붙기까지 기다리는 시간(밀리초). 앱 시작 마감(5초, services/v0-monolith/src/redis.ts)은 핫패스용이라
 * 관리 스크립트에는 길게 준다. 2026-11-03 러너 A/A 4회째에 측정 뒤 기록 읽기가 5초 안에 붙지 못해 몇 시간짜리 실행이 멈췄다
 */
const ADMIN_REDIS_STARTUP_MS = 30_000;
/** 대기열 Redis(Valkey) 파드 [네임스페이스, 꼬리표](deploy/local/valkey.yaml) */
const VALKEY_SELECTOR = ['peaket-local', 'app=valkey'];

/** [네임스페이스, 꼬리표]로 고른 파드마다 상태 한 줄(다시 시작·직전 종료 까닭 포함). 읽지 못하면 그 까닭을 적는다 */
async function podsNote(targets) {
  const lines = [];
  for (const [ns, selector] of targets) {
    try {
      for (const p of JSON.parse(await kc(['-n', ns, 'get', 'pods', '-l', selector, '-o', 'json'])).items) lines.push(`${ns}/${p.metadata?.name}: ${podNotReadyReason(p)}`);
    } catch (e) {
      lines.push(`${ns} ${selector}: 읽지 못했다(${String(e.message ?? e).slice(0, 200)})`);
    }
  }
  return lines.join('\n') || '파드가 없다';
}

/** 앱 파드 안에서 Node 스크립트를 돌리고 '@@RESULT <JSON>' 줄을 읽는다. 실패하면 앱·대기열 Redis 파드의 상태를 오류 끝에 붙인다 */
export async function inAppPod(script, timeout = 300_000, namespace = V0_NAMESPACE) {
  // 스크립트는 인자 하나로 넘긴다(표준 입력은 이 PC에서 잘릴 수 있다). 몇 KB라 명령줄 한도(32K) 안이다
  let out;
  try {
    out = await kc(['-n', namespace, 'exec', 'deploy/v0-monolith', '--', 'node', '--input-type=module', '-e', script], { timeout });
  } catch (e) {
    e.message = `${e.message}\n파드 상태:\n${await podsNote([[namespace, APP_SELECTOR], VALKEY_SELECTOR])}`;
    throw e;
  }
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
const redis = await createV0Redis(process.env.PEAKET_V0_REDIS_URL, { startupTimeoutMs: ${ADMIN_REDIS_STARTUP_MS} });
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
const redis = await createV0Redis(process.env.PEAKET_V0_REDIS_URL, { startupTimeoutMs: ${ADMIN_REDIS_STARTUP_MS} });
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
  // 진입 서버 비례 확인의 단계 하나(MSR-020): 진입 SLO(NFR-001)
  if (a.scenario === 'entry') return 'NFR-001';
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

// ───────────── v1 시나리오(docs/verification.md §3.9 'v1 경로', BUILD_ORDER PRF-215) ─────────────

/** v1 시나리오가 요청에 다는 경로 가운데 점검·요약에 쓰는 것 */
const ROUTES_V1 = {
  queue: ['preverify', 'entry', 'status', 'admission'],
  'seat-hold': ['hold', 'release'],
  // payment은 결제 접수 요청 하나(시행 수·오류)이고 목표는 접수 시작부터 끝 상태까지로 센다(scenarios/v1-payment.js, 코드 리뷰 M6)
  payment: ['hold', 'order', 'pay_start', 'sim_auth', 'sim_fault', 'payment', 'payment_status'],
  // 진입 비례 확인 단계(MSR-020): 준비의 사전 검증은 점검에서 뺀다
  entry: ['preverify', 'entry'],
};
/** v1 실행의 시나리오 파일(진입 단계는 V1_SCENARIOS 밖이다) */
const v1ScenarioFile = (a) => (a.scenario === 'entry' ? V1_ENTRY_SCENARIO : V1_SCENARIOS[a.scenario]);
/** 서버 히스토그램 점검(합본의 서비스 꼬리표로 고른다). 대기 상태 파일은 캐시 앞이라 원본 히스토그램으로 보지 않는다 */
const SERVER_CHECK_V1 = {
  'seat-hold': { route: 'hold', service: 'purchase-svc', path: '/v1/events/{eventId}/holds', le: 0.05, allowed: 0.01, label: 'p99', name: 'hold_server_p99_50ms' },
  // 결제는 서버 요청 하나가 결제 확정 시간을 담지 않아(접수 → 롱 폴링) 서버 히스토그램 점검을 두지 않는다(코드 리뷰 M6)
};
const QUERIES_V1 = 'loadtest/queries/v1.txt';
/** 무대의 공개 값 ConfigMap(tools/local/cluster.mjs v1) */
const V1_PUBLIC_CONFIGMAP = 'v1-stage-public';
/** 클러스터 Prometheus(합본 파드 안에서 부른다) */
const V1_PROMETHEUS = 'http://prometheus.observability.svc.cluster.local:9090';
/** 불변식 검사 뷰(v1 결제 DB): 취소 표가 아직 없어 빈 뷰(docs/verification.md §3.10 'v1 합본 측정 규칙') */
const V1_CHECK_VIEWS_SQL = 'create schema if not exists v1_check; create or replace view v1_check.payment_cancel as select null::uuid as id, null::uuid as payment_id, null::bigint as amount, null::text as status, null::timestamptz as canceled_at where false;';
/** 합본 파드 고르기(공용 차트의 이름·구성 꼬리표) */
const BUNDLE_SELECTOR = 'app.kubernetes.io/name=bundle,app.kubernetes.io/component=service';
/** 오픈 직후 묶음 구간(1.5초 [가정]). 가상 사용자는 첫 묶음 구간과 흩음(8초)이 지난 뒤 진입한다(§3.9 'K1의 로비 없음') */
const V1_BATCH_WINDOW_MS = 1_500;
const V1_DISPERSAL_WAIT_MS = 12_000;
/** 시드한 때부터 오픈까지 [가정](리더가 200ms마다 회차 목록을 보고, 오픈 전 60초부터 그 회차를 본다) */
const V1_OPEN_LEAD_MS = 5_000;
/** K2 좌석 홀드: 발생기가 준비를 마치고 모두 같은 시각에 예열을 시작할 때까지의 여유(초, BAT-028 D) */
const V1_WARM_LEAD_S = 180;
/** v1 좌석 가격·한 사람 상한(시드 좌석맵 판) */
const V1_PRICE = 150_000;
const V1_PER_ACCOUNT = 4;

async function preflightV1() {
  const deploys = ['bundle', 'valkey-queue', 'valkey-seat', 'queue-state-cache', 'pg-simulator', 'purchase-svc-outbox-relay', 'payment-svc-outbox-relay'];
  try {
    await kc(['-n', V1_NAMESPACE, 'get', ...deploys.map((d) => `deploy/${d}`), '-o', 'name']);
  } catch {
    throw new Error('v1 무대가 올라와 있지 않다. 먼저: node tools/local/cluster.mjs up && node tools/local/cluster.mjs observability && node tools/local/cluster.mjs v1');
  }
  for (const d of deploys) await kc(['-n', V1_NAMESPACE, 'rollout', 'status', `deploy/${d}`, '--timeout=120s'], { timeout: 140_000 });
}

/** 합본 파드 안에서 node 스크립트 하나(결과 줄 @@RESULT <JSON>) */
async function inBundlePod(script, timeout = 300_000) {
  const out = await kc(['-n', V1_NAMESPACE, 'exec', 'deploy/bundle', '--', 'node', '--input-type=module', '-e', script], { timeout });
  const m = /^@@RESULT (.*)$/m.exec(out);
  if (!m) throw new Error(`합본 파드 안 스크립트에 결과 줄이 없다:\n${out.slice(-1500)}`);
  return JSON.parse(m[1]);
}

/** 무대의 공개 값(ConfigMap v1-stage-public, tools/local/cluster.mjs v1이 쓴다): 구매 세션 서버 공개키·동의 판·Redis TLS·nginx 이미지. 개인키 든 Secret은 읽지 않는다(코드 리뷰 낮음) */
async function stagePublic() {
  const cm = JSON.parse(await kc(['-n', V1_NAMESPACE, 'get', 'configmap', V1_PUBLIC_CONFIGMAP, '-o', 'json'])).data ?? {};
  return { ...cm, ecdhPublicJwk: JSON.parse(cm.ecdhPublicJwk ?? 'null'), redisTls: cm.redisTls === 'true' };
}

/** 합본 파드 안 시드 명령(dist/seed-cli.js open|close|active). 결과 줄 JSON */
async function bundleSeed(args) {
  const out = await kc(['-n', V1_NAMESPACE, 'exec', 'deploy/bundle', '--', 'node', 'dist/seed-cli.js', ...args], { timeout: 120_000 });
  return JSON.parse(out.trim().split('\n').pop());
}

/** 지금 시각의 UUIDv7(seat_hold 파티션이 회차 ID 범위로 나뉜다) */
function uuidv7Now() {
  const ms = Date.now().toString(16).padStart(12, '0');
  const r = randomBytes(10).toString('hex');
  return `${ms.slice(0, 8)}-${ms.slice(8, 12)}-7${r.slice(0, 3)}-${((parseInt(r[3], 16) & 3) | 8).toString(16)}${r.slice(4, 7)}-${r.slice(7, 19)}`;
}

/** v1 격자: 좌석 홀드는 v0와 같은 격자, 결제는 사람마다 좌석 수 몫, 대기열은 좌석이 필요 없지만 판을 둔다(최소 격자) */
function gridForV1(a) {
  return gridFor(a) ?? { sections: ['A'], rows: 1, perRow: 10 };
}

async function runV1(a, runTag) {
  const outDir = resolve(a.out ?? join(OUT_ROOT, `${today()}-v1-${a.scenario}-${runTag}`));
  mkdirSync(outDir, { recursive: true });
  const hostDir = `${NODE_ROOT}/${runTag}`;
  const eventId = uuidv7Now();
  const grid = gridForV1(a);
  const startedAt = new Date().toISOString();
  let exitCode = 0;
  let k6Exit = null;
  let locked = false;
  const pods = [];
  let cancelSide = () => {};
  const cleanup = async () => {
    cancelSide();
    for (const p of pods) await kc(['-n', NS, 'delete', 'pod', p, '--ignore-not-found', '--wait=true']).catch(() => {});
    removeNodeDir(hostDir);
    if (!locked) return;
    if (a.scenario === 'payment') await kc(['-n', NS, 'delete', 'secret', SIM_KEY_SECRET, '--ignore-not-found']).catch(() => {});
    // 이 실행의 회차를 끝낸다(입장 제어 회차 목록·좌석 판매 목록에서 뺀다, 코드 리뷰 H1)
    if (seeded) await bundleSeed(['close', eventId]).catch((e) => console.error(`회차 ${eventId}를 끝내지 못했다(node loadtest/run.mjs cleanup으로 끝낸다): ${e.message}`));
    await releaseLock(runTag);
  };
  let seeded = false;
  cleanups.add(cleanup);
  try {
    step('v1 무대와 네임스페이스 확인');
    await preflightV1();
    await ensureNamespace();
    const pub = await stagePublic();
    const redisTls = pub.redisTls;
    const ecdhPublic = pub.ecdhPublicJwk;
    if (!ecdhPublic?.x) throw new Error(`무대 공개 값(${V1_PUBLIC_CONFIGMAP})에 구매 세션 서버 공개키가 없다`);
    const recordProblem = v1RecordProblem(a, { redisTls });
    if (recordProblem) throw new Error(recordProblem);
    const bundle = JSON.parse(await kc(['-n', V1_NAMESPACE, 'get', 'deploy/bundle', '-o', 'json']));
    const replicas = bundle.spec.replicas;
    const res = bundle.spec.template.spec.containers[0].resources;
    const bundleMode = (bundle.spec.template.spec.containers[0].env ?? []).find((e) => e.name === 'PEAKET_BUNDLE_MODE')?.value ?? 'single';
    // 측정 조건의 합본 CPU(요청=한도)를 실제 배포에서 확인한다(BAT-031). 값 파일 기본은 CPU 1이라 손으로 패치한 무대를 조용히 재지 않게 한다
    if (a.targetCpus !== undefined) {
      const want = String(a.targetCpus);
      const req = res?.requests?.cpu;
      const lim = res?.limits?.cpu;
      if (req !== want || lim !== want) {
        throw new Error(`v1 합본 CPU가 목표 ${want}와 다르다(요청 ${req ?? '-'}·한도 ${lim ?? '-'}). node tools/local/cluster.mjs v1 --cpus ${want}로 무대를 만든 뒤 다시 실행한다`);
      }
    }

    // 시나리오 시간과 도착률(v0와 같은 셈. 좌석 홀드의 준비는 setup()이라 k6 시간 밖이다)
    let maxRate;
    let prepS;
    if (a.scenario === 'queue') {
      const entryS = Math.ceil(a.users / a.entryRate);
      const q = { users: a.users, entryRate: a.entryRate, admitPerSecond: a.admitPerSecond };
      const plan = [pollStages({ ...q, startS: entryS, durationS: a.warmS }), pollStages({ ...q, startS: entryS + a.warmS, durationS: a.mainS })];
      maxRate = Math.max(a.entryRate, ...plan.flatMap((p) => [p.startRate, ...p.stages.map((s) => s.target)]));
      prepS = entryS;
    } else if (a.scenario === 'seat-hold') {
      maxRate = a.rate * (a.keep ? 1 : 2);
      prepS = Math.ceil(a.users / 20) + 60;
    } else if (a.scenario === 'entry') {
      // 준비(사전 검증)는 k6 시간표의 앞 prepS초 + 여유 1초다(scenarios/v1-entry.js)
      maxRate = a.rate;
      prepS = a.prepS + 1;
    } else {
      maxRate = a.rate;
      prepS = 0;
    }
    const warmLeadS = a.scenario === 'seat-hold' ? V1_WARM_LEAD_S : 0;
    const busyS = prepS + a.warmS + a.mainS + 60 + warmLeadS;
    // 진입 단계는 발생기 하나에 800/s로 나눈다(계획 F-08-8 2절 4, 계획 F-08-2 6.4와 같은 몫)
    const nGen = a.generators ?? (a.scenario === 'entry' ? generatorCount(maxRate, ENTRY_GENERATOR_RATE) : generatorCount(maxRate));
    const split = nGen > 1;
    const gen = split && a.cpus === DEFAULTS.cpus && a.memoryMi === DEFAULTS.memoryMi ? { ...a, cpus: SPLIT_CPUS, memoryMi: SPLIT_MEMORY_MI } : a;
    // 결제는 반복 안에서 입장·결제 확정을 기다려 가상 사용자가 오래 묶인다(입장 기다림 몇 초 + 확정)
    const perReqS = a.scenario === 'payment' ? 6 : a.scenario === 'seat-hold' ? 0.05 + a.releaseMs / 1000 : 0.05;
    const vus = vuPlan(maxRate / nGen, gen.memoryMi, perReqS);
    // 진입 단계: 진입 VU는 처음부터 다 만든다(미리 = 최대). 준비 VU는 그보다 크게 두어 진입 VU가 모두 토큰을 쌓은 VU가 되게 한다(scenarios/v1-entry.js)
    const entryPlan = a.scenario === 'entry' ? entryVuPlan(a.users, vus.max * nGen, nGen) : undefined;
    log(`발생기 ${nGen}대(CPU ${gen.cpus}·메모리 ${gen.memoryMi}Mi씩), 최고 도착률 ${Math.round(maxRate)}/s, 발생기마다 미리 ${vus.pre}·최대 ${vus.max} VU${entryPlan ? `, 진입 VU ${entryPlan.entryVus}·사전 검증 토큰은 측정 전에 파일로 만든다` : ''}`);

    step('실행 잠금과 남은 것 쓸어 내기');
    await acquireLock(runTag, Date.now() + (busyS * 2 + 900) * 1000);
    locked = true;
    await sweepLeftovers();

    // 같은 무대에 다른 실행의 진행 중 회차가 남아 있으면 시작하지 않는다(입장 제어가 회차끼리 입장 자리·속도를 나눈다, 코드 리뷰 H1)
    const others = activeEventsProblem(await bundleSeed(['active']), eventId);
    if (others) throw new Error(others);
    step(`회차 ${eventId} 열기(좌석 ${seatCount(grid)}석, 로비 없음, Redis TLS ${redisTls ? '켬' : '끔'})`);
    const now = Date.now();
    // 오픈은 조금 뒤로 둔다: 입장 제어 리더가 오픈 전에 회차를 보고 첫 묶음을 제때 게시해야 흩음 8초만 기다린다(이미 지난 오픈이면 늦은 게시라 20초를 더 막는다,
    // admission-ctrl leader-lua.ts '첫 전진 문'). 가상 사용자는 첫 묶음 구간과 흩음이 지난 뒤(readyAt) 사전 검증·진입한다(§3.9 'K1의 로비 없음')
    const opensAtMs = now + V1_OPEN_LEAD_MS;
    // 판매 종료(공연 시작 − 24시간)를 실행 예상 끝 + 10분 뒤로 둔다
    const startsAtMs = now + 24 * 3600_000 + (busyS + 600) * 1000;
    const seatMap = v1SeatMap(grid, { perAccountLimit: V1_PER_ACCOUNT, saleEndsAtMs: startsAtMs - 24 * 3600_000, price: V1_PRICE, layoutVersion: 1 });
    putHostFile(V1_HOST_DIRS.seatmaps, `${eventId}.json`, JSON.stringify(seatMap), 1000);
    // K1은 v0의 '입장 초당 N명'을 시험 회차의 결제사 승인 상한으로 시드해 v1 입장 제어가 같은 속도로 부르게 한다(§3.9 'K1의 입장 속도')
    // 결제사 묶음 이름은 실행마다 다르다(코드 리뷰 H1)
    const seedReq = { eventId, opensAtMs, startsAtMs, seatCount: seatCount(grid), batchWindowMs: V1_BATCH_WINDOW_MS, layoutVersion: 1, ...(a.scenario === 'queue' ? { pgTps: a.admitPerSecond, pgKey: stagePgKey(runTag) } : {}) };
    if (a.scenario === 'entry') {
      // 진입 서버 비례 확인은 진입 서버 수·CPU 몫을 실제 배포에서 확인한다(계획 F-08-2 6.1, 손으로 바꾼 무대를 조용히 재지 않게)
      const problem = entryStageProblem(a, { replicas, cpu: res?.requests?.cpu, cpuLimit: res?.limits?.cpu, redisTls });
      if (problem) throw new Error(problem);
    }
    seeded = true;
    const opened = await bundleSeed(['open', JSON.stringify(seedReq)]);
    log(`좌석 판매 열기 ${opened.created ? '새로' : '이미'}(세대 ${opened.seatEpoch})`);
    const readyAt = opensAtMs + V1_BATCH_WINDOW_MS + V1_DISPERSAL_WAIT_MS;
    if (readyAt > Date.now()) await sleep(readyAt - Date.now());

    // 구매 세션 클라이언트 키(이 PC에서 계산, k6에는 ECDH가 없다). 시험 값이고 실행 폴더에만 넣는다(산출물에 싣지 않는다)
    const client = v1ClientKey(ecdhPublic);
    if (a.scenario === 'payment') {
      const raw = (await kc(['-n', V1_NAMESPACE, 'get', 'secret', 'pg-simulator', '-o', `jsonpath={.data.${SIM_KEY_NAME}}`])).trim();
      await kc(['-n', NS, 'delete', 'secret', SIM_KEY_SECRET, '--ignore-not-found']);
      await createObject(simKeySecret(Buffer.from(raw, 'base64').toString('utf8')));
    }
    // v1은 계정 토큰이 없다(신원 머리). 공통 시나리오 부분이 읽는 사용자 파일 자리만 채운다
    stageInputs(hostDir, { caPem: '', tokens: JSON.stringify(['v1']) });
    const L = v1Layout({ redisTls });
    // K2 좌석 홀드는 모든 발생기가 준비를 마친 뒤 같은 시각에 예열을 시작한다(BAT-028 D). 준비가 이 시각을 넘기면 그 발생기만 늦게 시작한다
    const warmStartAtMs = a.scenario === 'seat-hold' ? Date.now() + V1_WARM_LEAD_S * 1000 : undefined;
    const env = {
      SCENARIO: v1ScenarioFile(a),
      QUEUE_BASE: L.queueUrl,
      STATE_BASE: L.stateUrl,
      PURCHASE_BASE: L.purchaseUrl,
      HOLD_BASE: L.holdUrl,
      RUN_TAG: runTag,
      USERS_FILE: '/work/users.json',
      EVENT_ID: eventId,
      WARM_S: a.warmS,
      MAIN_S: a.mainS,
      ...(warmStartAtMs !== undefined ? { WARM_START_AT_MS: String(warmStartAtMs) } : {}),
      PRE_VUS: vus.pre * nGen,
      MAX_VUS: vus.max * nGen,
      USERS: a.users,
      CLIENT_KEY: client.clientPublicKey,
      SHARED_SECRET_HEX: client.sharedSecretHex,
      CONSENT_VERSION: pub.consentVersion ?? V1_CONSENT_VERSION,
      SECTIONS: grid.sections.join(','),
      ROWS: grid.rows,
      PER_ROW: grid.perRow,
      ...(a.scenario === 'queue' ? { ENTRY_RATE: a.entryRate, ADMIT_PER_SECOND: a.admitPerSecond } : {}),
      ...(a.scenario === 'seat-hold' ? { RATE: a.rate, MODE: a.mode, HOLD_SIZE: a.holdSize, HOT_COUNT: a.hotCount, PAIRS: a.pairs, RELEASE_MS: a.releaseMs, KEEP: a.keep ? 1 : 0, PREP_TIMEOUT_S: Math.max(300, prepS * 3) } : {}),
      ...(a.scenario === 'payment' ? { RATE: a.rate, SEATS_PER_ORDER: a.seatsPerOrder, SIM_URL: L.pgSimUrl, FAULT_DROP_PCT: String(a.faultDropPct), FAULT_DELAY_PCT: String(a.faultDelayPct), FAULT_DELAY_MS } : {}),
      ...(entryPlan ? { RATE: a.rate, ENTRY_VUS: entryPlan.entryVus } : {}),
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
    for (const p of pods) await waitPodReady(p);

    // 진입 단계의 사전 검증 토큰은 측정 전에 한 번 만든다(2026-11-24 리허설 고침: k6가 준비 시나리오 VU의 상태를 진입 시나리오 VU로 잇지 못했다)
    let prep = null;
    if (a.scenario === 'entry') {
      step('사전 검증 토큰 파일(측정 전 한 번)');
      prep = await prepareEntryTokens({ pod: pods[0], hostDir, envFile: split ? 'run-0.env' : 'run.env', a, outDir });
    }

    // v1 DB 통계(실행 전, --db-stats, 계획 F-08-8 7.1)
    const statsDeps = v1StatsDeps(redisTls);
    const statsBefore = await v1Stats.before(a, statsDeps);
    step(`k6 ${v1ScenarioFile(a)}(예상 ${busyS}초)`);
    for (const p of pods) await kc(['-n', NS, 'exec', p, '--', 'sh', '-c', `nohup sh /work/bin/${split ? 'run-split.sh' : 'run.sh'} >/dev/null 2>&1 &`]);
    if (split) {
      await sleep(1000);
      onNode(['sh', '-c', `touch ${hostDir}/go && chown ${K6_UID}:${K6_UID} ${hostDir}/go`]);
    }
    // 발생기가 준비를 마치고 예열을 시작할 시각까지 기다린다(그 시각을 부하 시작으로 센다, BAT-028 D)
    if (warmStartAtMs !== undefined) {
      const waitMs = warmStartAtMs - Date.now();
      if (waitMs > 0) await sleep(waitMs);
    }
    const loadStartMs = Date.now();
    const side = sideTasks(loadStartMs);
    cancelSide = () => side.cancel();
    let killed = null;
    if (a.killAppAtS !== undefined) {
      // 강제로 끝내는 '앱 파드'는 합본 복제 하나다(BAT-025 계획 §2.3 K7 ②). 좌석 홀드의 준비는 setup이라 k6 시작부터 센다
      side.at(prepS + a.warmS + a.killAppAtS, async () => {
        const name = (await kc(['-n', V1_NAMESPACE, 'get', 'pods', '-l', BUNDLE_SELECTOR, '-o', 'jsonpath={.items[0].metadata.name}'])).trim();
        // 끝내는 파드가 그때 잡고 있던 리더 임대(입장 제어·정지 판정자)를 함께 적는다(코드 리뷰 M1)
        // 못 읽은 임대는 null이고 그 까닭을 leaseErrors에 적는다(재확인 리뷰 8)
        const { holders, errors: leaseErrors } = await readLeaseHolders(['admission-ctrl', 'payment-entry-pause'], (lease) => kc(['-n', V1_NAMESPACE, 'get', 'lease', lease, '-o', 'jsonpath={.spec.holderIdentity}']));
        killed = { name, atMs: Date.now(), leaseHolders: holders, heldLeases: Object.entries(holders).filter(([, h]) => h === name).map(([l]) => l), leaseErrors };
        await kc(['-n', V1_NAMESPACE, 'delete', 'pod', name, '--grace-period=0', '--force', '--wait=false']);
        log(`합본 파드 ${name}을 강제로 끝냈다(본구간 ${a.killAppAtS}초)`);
      });
    }
    // 호스트 지표(진입 단계, docs/verification.md §3.5 6·8번): 본구간 시작·끝 표시를 보고 표본을 둘 읽는다. 읽기 실패는 errors에 남고 곁작업은 던지지 않는다
    let hostPair = null;
    if (a.hostMetrics) side.at(Math.max(0, prepS - 5), async () => (hostPair = await hostPairAtMarks({ hostDir, split, nGen, pods, podCpus: a.podCpus, genCpus: gen.cpus, untilMs: Date.now() + (busyS * 2 + 300) * 1000 })));
    // PostgreSQL 클라이언트 연결 수(합본 풀 합계가 한도 안인지, 코드 리뷰 M2): 준비부터 본구간 끝까지 5초마다 재고 최대를 적는다
    const dbConnections = [];
    for (let t = prepS; t <= prepS + a.warmS + a.mainS; t += 5) side.at(t, async () => dbConnections.push(await pgConnections()));
    const outs = await Promise.all(segments.map((sg) => waitK6(pods[sg.index], hostDir, split ? `out/g${sg.index}` : 'out', busyS)));
    const bad = outs.find((o) => o.exit !== 0 && o.exit !== 99);
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
    const parts = outs.map((o) => ({ o, split: splitConsole(o.console) }));
    const marks = Object.assign({}, ...parts.map((p) => p.split.marks));
    if (marks.main_start === undefined || marks.main_end === undefined) throw new Error('본구간 경계 표시가 없다(k6가 본구간까지 가지 못했다)');
    const evs = parts.map((p) => evaluate(p.o, gen, marks, p.split));
    const merged = split ? mergeSummaries(evs.map((e) => e.summary)) : evs[0].summary;
    writeFileSync(join(outDir, 'summary.json'), JSON.stringify(merged, null, 2));
    const generator = combineGenerators(evs.map((e) => e.generator), loadStartMs);
    writeFileSync(join(outDir, 'generator.json'), JSON.stringify(generator, null, 2));

    const probesOut = {};
    // v1 통계(실행 뒤): 못 읽었으면 까닭을 남기고 장부 판정을 무효로 둔다(계획 F-08-8 11절)
    let statsOut = null;
    if (a.dbStats || a.redisStats) {
      statsOut = await v1Stats.after(a, statsDeps, statsBefore);
      if (a.dbStats) writeFileSync(join(outDir, 'db-stats.json'), JSON.stringify(statsOut.db === null ? { purchase: null, payment: null, errors: statsOut.errors } : statsOut.db, null, 2));
      if (a.redisStats) writeFileSync(join(outDir, 'redis-stats.json'), JSON.stringify(statsOut.redis ?? { queue: null, seat: null }, null, 2));
      if (statsOut.errors.length) {
        console.error(`loadtest/run.mjs: 통계를 다 읽지 못했다: ${statsOut.errors.join('; ')}`);
        generator.judge = v1StatsJudge(generator.judge, statsOut);
      }
    }
    // 호스트 지표(진입 단계): host.json = 장부 host 칸의 재료와 표시(collect.py --host)
    let hostFile;
    if (a.hostMetrics) {
      const h = hostPair ? hostBetween(hostPair.before, hostPair.after) : { cpuUtil: null, procsRunning: null, logicalCpus: null, throttle: {}, cpuAssigned: null, kernel: { listenOverflows: null, listenDrops: null }, errors: ['본구간 표시를 보지 못해 호스트 표본을 읽지 않았다'] };
      const host = { ...h, tags: hostTags(h) };
      hostFile = join(outDir, 'host.json');
      writeFileSync(hostFile, JSON.stringify(host, null, 2));
      probesOut.host = host;
    }
    if (killed) {
      probesOut.killed = killed;
      // 끝낸 파드와 그때의 리더 임대 보유자(코드 리뷰 M1)
      writeFileSync(join(outDir, 'killed.json'), JSON.stringify(killed, null, 2));
    }
    step('시험 기록');
    let lines = parts.flatMap((p) => p.split.records);
    // 대기열은 serving 전진 기록(q:{event:E}:serving_log, 1초 칸마다 마지막 serving)을 시험 기록으로 옮긴다(불변식 Q1 차례 전 입장, docs/data.md §3)
    if (a.scenario === 'queue') lines = lines.concat(servingRecords(eventId, servingLogFromZset(await inBundlePod(servingLogScriptV1(eventId), 300_000))));
    // K1 진입 시행: 사전 검증 실패도 실패한 진입으로 기록된다. 시행이 사용자 수보다 적으면 무효(코드 리뷰 H3)
    const entry = a.scenario === 'queue' ? entryTrials(lines, a.users) : undefined;
    if (entry?.reasons.length) generator.judge = { valid: false, reasons: [...generator.judge.reasons, ...entry.reasons] };
    if (a.scenario === 'payment') {
      const r = await inBundlePod(V1_LEDGER_SCRIPT(), 300_000);
      if (r.status !== 200) throw new Error(`시뮬레이터 원장을 받지 못했다(HTTP ${r.status})`);
      lines = lines.concat(pgChargeLines(r.body));
      // 정지 판정자의 정지 시작·해제(로그 kind payment-entry-pause-transition)와 정지 503 수(docs/verification.md §3.10 'v1 합본의 K7 ② 조건')
      probesOut.pause = await pauseProbe(loadStartMs);
      writeFileSync(join(outDir, 'pause-transitions.json'), JSON.stringify(probesOut.pause, null, 2));
      const why = pauseReasons(probesOut.pause);
      if (why.length) generator.judge = { valid: false, reasons: [...generator.judge.reasons, ...why] };
    }
    writeFileSync(join(outDir, 'generator.json'), JSON.stringify(generator, null, 2));
    const recordsFile = join(outDir, 'records.ndjson');
    writeFileSync(recordsFile, lines.length ? `${lines.join('\n')}\n` : '');
    const infraFile = join(outDir, 'infra.txt');
    writeFileSync(
      infraFile,
      `${infraText({ cpus: gen.cpus, memoryMi: gen.memoryMi, generators: nGen, args: a })}\n${[
        `v1 합본(docs/verification.md §3.8 '합본의 v1 무대'): 복제 ${replicas}, CPU 요청 ${res?.requests?.cpu ?? '-'}·한도 ${res?.limits?.cpu ?? '-'}(목표 ${a.targetCpus ?? '-'}), 메모리 요청 ${res?.requests?.memory ?? '-'}·한도 ${res?.limits?.memory ?? '-'}, 모드 ${bundleMode}, HPA 끔`,
        `대기열·좌석 Redis TLS ${redisTls ? '켬' : '끔'}, 릴레이 purchase·payment 각 2, 대기 상태 파일 앞 nginx 캐시(${V1_NGINX_TAG}, 실은 이미지 ${pub.nginxImageId ?? '-'}, ${pub.nginxPlatform ?? '-'} 매니페스트 ${pub.nginxManifest ?? '-'})`,
        `PostgreSQL(v1 무대 전용, max_connections ${pub.pgMaxConnections ?? '-'}) 클라이언트 연결 최대 ${dbConnections.some((c) => c !== null) ? Math.max(...dbConnections.filter((c) => c !== null)) : '-'}(5초마다 ${dbConnections.length}번 잼, 못 읽음 ${dbConnections.filter((c) => c === null).length})`,
      ].join('\n')}\n`,
    );
    const g = generator;
    log(`발생기 ${nGen}대: CPU 평균 최고 ${g.cpuMeanPctMax}%, 메모리 최대 ${g.memMaxPctMax}%, dropped ${g.dropped}, VU 최대 합 ${g.vusMax} → ${g.judge.valid ? '유효' : `무효(${g.judge.reasons.join('; ')})`}`);

    let invFile;
    if (a.invariants) {
      step('불변식 검사(peaket-invariants, v1 purchase·payment DB)');
      if (a.scenario === 'payment') {
        const waitMs = k6DoneAtMs + 65_000 - Date.now();
        if (waitMs > 0) await sleep(waitMs);
      }
      const code = await runInvariantsV1(outDir, recordsFile);
      invFile = join(outDir, 'invariants.csv');
      if (code === 1 && !(a.faultDropPct || a.faultDelayPct || a.killAppAtS !== undefined)) exitCode = 1;
      // SKIPPED가 정본의 기대 목록과 다르면 실패이고, 장부에도 무효로 남긴다(검사를 조용히 잃지 않게, 코드 리뷰 H2·재확인 리뷰 1)
      const sk = skippedProblem(readFileSync(invFile, 'utf8'));
      probesOut.skipped = sk.skipped;
      if (sk.problem) {
        exitCode = 1;
        console.error(`loadtest/run.mjs: ${sk.problem}`);
        generator.judge = v1LedgerJudge(generator.judge, { skipped: sk });
        writeFileSync(join(outDir, 'generator.json'), JSON.stringify(generator, null, 2));
      }
    }

    let checks = checksFromSummary(merged, ROUTES_V1[a.scenario].filter((r) => r !== 'preverify'), CHECK_PHASES[a.scenario] ?? {});
    if (entry) checks = withEntryRecords(checks, entry);
    const sc = SERVER_CHECK_V1[a.scenario];
    if (checks && a.promUrl && sc && a.killAppAtS === undefined) {
      checks.checks.push({ name: sc.name, allowed: sc.allowed, target: `서버 ${sc.route} ${sc.label} ≤ ${sc.le * 1000}ms`, histogram: { metric: 'http_server_request_duration_seconds', match: `namespace="${V1_NAMESPACE}",app="bundle",service="${sc.service}",route="${sc.path}"`, le: sc.le } });
      checks.crosscheck = { check: sc.name, k6_metric: `http_req_duration{phase:main,route:${sc.route}}` };
    }
    const checksFile = checks ? join(outDir, 'checks.json') : undefined;
    if (checksFile) writeFileSync(checksFile, JSON.stringify(checks, null, 2));
    const notes = [
      runNotesV1(a, { generator: g, merged, probes: probesOut, maxRate, nGen }),
      ...v1StageNotes(a, { redisTls, skipped: probesOut.skipped, pause: probesOut.pause, entry }),
      ...(a.scenario === 'entry' ? [entryStageNote(a, { replicas, bundleMode, services: bundleServicesOf(bundle), entryPlan, prep, merged, host: probesOut.host })] : []),
      ...(statsOut ? [statsNote(statsOut)] : []),
    ].join('; ');
    writeFileSync(join(outDir, 'notes.txt'), `${notes}\n`);
    log(notes);

    if (a.record) {
      step(`성능 장부(${a.runId})`);
      const extras = ['pause-transitions.json', 'killed.json', 'db-stats.json', 'redis-stats.json', join('invariants', 'invariants-detail.ndjson')].map((f) => join(outDir, f)).filter((f) => existsSync(f));
      execFileSync(
        PYTHON,
        [
          '-I',
          '-X',
          'utf8',
          ...collectArgs({
            runId: a.runId,
            kpi: kpiOf(a),
            version: 'v1',
            profile: a.profile,
            users: a.users,
            ...(a.scenario === 'queue' ? {} : { rps: a.rate }),
            durationS: a.mainS,
            warmupS: a.warmS,
            scenario: `loadtest/scenarios/${v1ScenarioFile(a)}`,
            summaryFile: join(outDir, 'summary.json'),
            infraFile,
            notes,
            start: new Date(marks.main_start - a.warmS * 1000).toISOString(),
            end: new Date(marks.main_end).toISOString(),
            ...(g.judge.valid ? {} : { invalidReason: g.judge.reasons.join('; ') }),
            ...(invFile ? { invariants: invFile } : {}),
            ...(extras.length ? { extra: extras } : {}),
            generator: `k6 1.4.2, 발생기 파드 ${nGen}대(CPU ${gen.cpus}·메모리 ${gen.memoryMi}Mi씩, kind 안${split ? ', k6 실행 구간으로 나눔' : ''})`,
            ...(checksFile ? { checks: checksFile } : {}),
            ...(a.promUrl ? { promUrl: a.promUrl, queries: join(REPO, QUERIES_V1) } : {}),
            redisTls,
            ...(a.pairedRun ? { pairedRun: a.pairedRun } : {}),
            rawBucket: RAW_BUCKET,
            rawOutbox: RAW_OUTBOX,
            ...(hostFile ? { host: hostFile } : {}),
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
    cleanups.delete(cleanup);
    await cleanup();
    try {
      writeFileSync(join(outDir, 'run.json'), JSON.stringify({ version: 'v1', scenario: a.scenario, runTag, eventId, hostDir, namespace: V1_NAMESPACE, args: a, startedAt, endedAt: new Date().toISOString(), k6Exit, exitCode }, null, 2));
    } catch (e) {
      console.error(`run.json을 쓰지 못했다: ${e.message}`);
    }
  }
}

// ───────────── v1 진입 서버 비례 확인(MSR-020, docs/review/plans/F-08-2.md 6.3) ─────────────

/** 진입 단계의 VU 배치: 진입 VU(미리 = 최대), 준비 VU(진입 VU + 구간 표시 VU 여유 4 × 발생기 수), VU마다 쌓을 토큰(사람 수 × 1.5 ÷ 진입 VU + 2) */
export function entryVuPlan(users, entryVus, nGen) {
  if (!Number.isSafeInteger(users) || users < 1 || !Number.isSafeInteger(entryVus) || entryVus < 1 || !Number.isSafeInteger(nGen) || nGen < 1) throw new RangeError('진입 VU 배치 입력은 1 이상 정수다');
  return { entryVus, prepVus: entryVus + 4 * nGen, tokensPerVu: Math.ceil((users * 1.5) / entryVus) + 2 };
}

/** 쿠버네티스 CPU 양('1', '0.5', '500m') → 코어 수. 못 읽으면 null */
export function cpuQuantity(q) {
  const m = /^(\d+(?:\.\d+)?)(m?)$/.exec(String(q ?? ''));
  if (!m) return null;
  return m[2] ? Number(m[1]) / 1000 : Number(m[1]);
}

/** 진입 단계 무대 확인: 합본 복제 수·CPU 요청·한도가 인자와 같고, 장부 기록이면 Redis TLS 켬(진입 서버 사이에서 나눠 쓰는 대기열 한 키는 운영처럼 TLS로 잰다, §3.5 7번) */
export function entryStageProblem(a, o) {
  const problems = [];
  if (o.replicas !== a.replicas) problems.push(`합본 복제가 ${o.replicas}개다(인자 --replicas ${a.replicas})`);
  const req = cpuQuantity(o.cpu);
  const lim = cpuQuantity(o.cpuLimit);
  if (req === null || lim === null || Math.abs(req - a.podCpus) > 1e-9 || Math.abs(lim - a.podCpus) > 1e-9) problems.push(`합본 CPU 요청 ${o.cpu ?? '-'}·한도 ${o.cpuLimit ?? '-'}가 --pod-cpus ${a.podCpus}와 다르다`);
  if (a.record && !o.redisTls) problems.push('진입 비례 확인은 Redis TLS 켬 무대로만 장부에 남긴다');
  return problems.length ? `${problems.join('; ')}. node tools/local/cluster.mjs v1 --redis-tls on --replicas ${a.replicas} --cpus ${a.podCpus} --services queue-svc로 무대를 다시 올린다` : null;
}

/** 합본 Deployment의 켠 서비스 목록과 모드(환경 값 PEAKET_BUNDLE_SERVICES·PEAKET_BUNDLE_MODE) */
function bundleServicesOf(bundle) {
  const env = bundle.spec.template.spec.containers[0].env ?? [];
  return (env.find((e) => e.name === 'PEAKET_BUNDLE_SERVICES')?.value ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}

/** 진입 단계의 notes 한 줄(무대 사실과 준비·호스트 지표) */
function entryStageNote(a, o) {
  const m = o.merged.metrics;
  const pvFailed = m['preverify_failed']?.values?.count ?? 0;
  const noToken = m['entry_no_token']?.values?.count ?? 0;
  const prep = o.prep;
  const h = o.host;
  const pct = (x) => (typeof x === 'number' ? `${Math.round(x * 10) / 10}%` : '-');
  const prepText = prep
    ? `${Math.round(prep.elapsed_ms / 100) / 10}초, 요청 ${prep.requested}·만듦 ${prep.made}·실패 ${prep.failed}`
    : `기록 없음(사전 검증 실패 ${pvFailed}건)`;
  return [
    `MSR-020 진입 단계: 진입 서버(합본 복제) ${o.replicas}대 × CPU ${a.podCpus}, 합본 서비스 ${o.services.join('·') || '-'}(모드 ${o.bundleMode}), 도착률 ${a.rate}/s, 사람마다 진입 한 번(가상 대기자 ${a.users}명)`,
    `사전 검증 토큰 파일(측정 전 한 번) ${prepText}, 토큰 없어 못 보냄 ${noToken}건(진입 VU ${o.entryPlan.entryVus}개)`,
    h ? `호스트 CPU ${pct(h.cpuUtil)}, procs_running ${h.procsRunning ?? '-'}/논리 ${h.logicalCpus ?? '-'}, 준 CPU 합 ${h.cpuAssigned ?? '-'}, 커널 ListenOverflows +${h.kernel?.listenOverflows ?? '-'}·ListenDrops +${h.kernel?.listenDrops ?? '-'}, 표시 ${h.tags.join('·') || '없음'}${h.errors?.length ? `, 못 읽음 ${h.errors.length}건` : ''}` : '호스트 지표 없음',
  ].join(', ');
}

/** 통계 notes 한 줄 */
function statsNote(st) {
  const parts = [];
  if (st.db) for (const n of ['purchase', 'payment']) {
    const d = st.db[n];
    const per = (x) => (typeof x === 'number' && d.seconds > 0 ? `${Math.round((x / d.seconds) * 10) / 10}/s` : '-');
    parts.push(`DB ${n}: 커밋 ${per(d.xactCommit)}, 넣음 ${per(d.tupInserted)}·갱신 ${per(d.tupUpdated)}·지움 ${per(d.tupDeleted)}, 교착 ${d.deadlocks ?? '-'}`);
  }
  if (st.db) parts.push(`WAL(무대 PostgreSQL 전체) ${st.db.purchase.walBytes ?? '-'} B / ${st.db.purchase.seconds}초`);
  if (st.redis) for (const [k, v] of Object.entries(st.redis)) parts.push(`Valkey ${k}: used_memory ${v?.usedMemory ?? '-'} B·peak ${v?.usedMemoryPeak ?? '-'} B·maxmemory ${v?.maxmemory ?? '-'}`);
  if (st.errors.length) parts.push(`통계 못 읽음: ${st.errors.join(' / ')}`);
  return `통계(계획 F-08-8 7.1): ${parts.join(', ') || '-'}`;
}

/** v1 통계를 읽는 실제 함수(probes.mjs v1Stats에 넘긴다). Valkey는 같은 파드 안 루프백이라 TLS 인증서 확인을 하지 않는다(INFO만 읽는다) */
function v1StatsDeps(redisTls) {
  return {
    dbText: () => kc(['-n', V1_NAMESPACE, 'exec', 'deploy/postgres', '--', 'psql', '-U', 'postgres', '-At', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-c', V1_DB_STATS_SQL]),
    redisInfo: (name) => kc(['-n', V1_NAMESPACE, 'exec', `deploy/${name}`, '--', 'valkey-cli', ...(redisTls ? ['--tls', '--insecure'] : []), '-h', '127.0.0.1', '-p', '6379', 'INFO', 'memory']),
  };
}

/**
 * 본구간 시작·끝 표시(발생기 콘솔의 main_start·main_end 줄)를 노드 폴더에서 1초마다 보고, 보이면 호스트 표본을 읽는다(docs/verification.md §3.5 6·8번).
 * 표본: 노드 /proc/stat, 합본·대기열 Valkey·발생기 파드의 cgroup cpu.stat, 합본 파드의 /proc/net/netstat. 시간 안에 표시를 못 보면 null(곁작업은 던지지 않는다)
 */
async function hostPairAtMarks(o) {
  const consoles = o.split ? Array.from({ length: o.nGen }, (_, i) => `${o.hostDir}/out/g${i}/console.ndjson`) : [`${o.hostDir}/out/console.ndjson`];
  const seen = (name) => {
    try {
      return onNode(['sh', '-c', `cat ${consoles.join(' ')} 2>/dev/null | grep -c '"name":"${name}"' || true`], { timeout: 30_000 }).trim() !== '0';
    } catch {
      return false;
    }
  };
  const until = async (name) => {
    while (Date.now() < o.untilMs) {
      if (seen(name)) return true;
      await sleep(1000);
    }
    return false;
  };
  const targets = async () => {
    const names = async (ns, sel) => (await kc(['-n', ns, 'get', 'pods', '-l', sel, '-o', 'jsonpath={.items[*].metadata.name}']).catch(() => '')).trim().split(/\s+/).filter(Boolean);
    return [
      ...(await names(V1_NAMESPACE, BUNDLE_SELECTOR)).map((pod) => ({ namespace: V1_NAMESPACE, pod, role: 'bundle', cpus: o.podCpus, netstat: true })),
      // Valkey는 CPU 한도가 없다. 준 몫은 계획 F-08-2 6.1의 2 CPU [가정]으로 센다
      ...(await names(V1_NAMESPACE, 'app.kubernetes.io/name=valkey-queue')).map((pod) => ({ namespace: V1_NAMESPACE, pod, role: 'valkey', cpus: 2 })),
      ...o.pods.map((pod) => ({ namespace: NS, pod, role: 'generator', cpus: o.genCpus })),
    ];
  };
  const deps = { nodeText: async (path) => onNode(['cat', path], { timeout: 30_000 }), podText: (ns, pod, path) => kc(['-n', ns, 'exec', pod, '--', 'cat', path], { timeout: 30_000 }) };
  if (!(await until('main_start'))) return null;
  const t = await targets();
  const before = await hostSnapshot(deps, t);
  if (!(await until('main_end'))) return null;
  const after = await hostSnapshot(deps, t);
  return { before, after };
}

/**
 * 진입 단계의 사전 검증 토큰을 측정 전에 한 번 만들어 /work/out/prep.ndjson에 남긴다(v1-entry-tokens.js).
 * k6 준비 시나리오와 진입 시나리오 사이에 VU 상태가 이어진다고 보장되지 않아(2026-11-24 리허설), 토큰을 파일로 떼어 냈다.
 * 만든 토큰이 진입 시나리오가 쓰는 최대 번호보다 적으면 시작하지 않는다(부족한 채로 재면 그 단계가 조용히 무효가 된다).
 */
async function prepareEntryTokens({ pod, hostDir, envFile, a, outDir }) {
  const timeout = Math.max(120_000, (a.prepS + 600) * 1000);
  await kc(
    ['-n', NS, 'exec', pod, '--', 'sh', '-c', `cd /work && set -a && . ./${envFile} && set +a && rm -f out/prep.ndjson out/prep-k6.log && k6 run --quiet --no-usage-report --log-format=raw --console-output=out/prep.ndjson loadtest/scenarios/v1-entry-tokens.js > out/prep-k6.log 2>&1`],
    { timeout },
  );
  const last = onNode(['sh', '-c', `tail -n 1 ${hostDir}/out/prep.ndjson`]).trim();
  let summary;
  try {
    summary = JSON.parse(last);
  } catch {
    summary = null;
  }
  if (!summary || summary.kind !== 'prep') throw new Error(`사전 검증 토큰 준비의 마지막 줄을 읽지 못했다: ${last.slice(0, 200)}`);
  const need = a.rate * (a.warmS + a.mainS + 7) + 2;
  const made = Number(summary.made);
  if (!Number.isSafeInteger(made) || made < need) throw new Error(`사전 검증 토큰이 모자란다: ${made} < ${need}(실패 ${summary.failed})`);
  const prep = { ...summary, need, path: '/work/out/prep.ndjson' };
  writeFileSync(join(outDir, 'prep.json'), JSON.stringify(prep, null, 2));
  return prep;
}

/** 단계 하나의 결과(runner/entry-scale.mjs runEntrySteps가 판정한다): 산출물 폴더의 summary.json·generator.json·host.json에서 */
function entryStepResult(outDir, rate) {
  const read = (f) => (existsSync(join(outDir, f)) ? JSON.parse(readFileSync(join(outDir, f), 'utf8')) : null);
  const summary = read('summary.json');
  const gen = read('generator.json');
  const host = read('host.json');
  const prep = read('prep.json');
  const m = summary?.metrics ?? {};
  const v = (k, stat) => (typeof m[k]?.values?.[stat] === 'number' ? m[k].values[stat] : null);
  const sent = v('http_reqs{phase:main,route:entry}', 'count');
  const over = v('over_target{phase:main,route:entry,le:200}', 'count') ?? (sent !== null ? 0 : null);
  const prepMs = v('prep_elapsed_ms', 'max');
  return {
    rate,
    valid: gen?.judge?.valid === true,
    invalidReason: gen?.judge?.reasons?.length ? gen.judge.reasons.join('; ') : gen ? null : 'generator.json 없음',
    entryP99Ms: v('http_req_duration{phase:main,route:entry}', 'p(99)'),
    // 발생기를 나누면 합친 p99는 위 한계라, 200ms 넘은 요청의 비율로도 판정한다(runner/entry-scale.mjs judgeStep)
    entryOverRatio: sent ? Math.min(1, over / sent) : null,
    errorRate: v('http_req_failed{phase:main,route:entry}', 'rate'),
    sent,
    dropped: Number.isSafeInteger(gen?.dropped) ? gen.dropped : null,
    kernel: host?.kernel ?? null,
    host: host ? { cpuUtil: host.cpuUtil, procsRunning: host.procsRunning, logicalCpus: host.logicalCpus, throttle: host.throttle, cpuAssigned: host.cpuAssigned, tags: host.tags ?? [] } : null,
    prepElapsedS: typeof prep?.elapsed_ms === 'number' ? prep.elapsed_ms / 1000 : typeof prepMs === 'number' ? prepMs / 1000 : null,
    prepMade: Number.isSafeInteger(prep?.made) ? prep.made : null,
    prepFailed: Number.isSafeInteger(prep?.failed) ? prep.failed : null,
    outDir,
  };
}

/** node loadtest/run.mjs v1 entry-steps(단계 올리기 한 번, 계획 F-08-2 6.3·7.2). 단계마다 runV1(시나리오 entry)을 부른다 */
async function runEntryStepsCommand(a, runTag) {
  const outDir = resolve(a.out ?? join(OUT_ROOT, `${today()}-v1-entry-n${a.replicas}-c${String(a.podCpus).replace('.', '')}-${runTag}`));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'args.json'), JSON.stringify(a, null, 2));
  const profileOf = (users) => a.profile ?? (users <= 1000 ? 'local-1k' : users <= 10000 ? 'local-10k' : 'local-100k');
  const r = await runEntrySteps(a, {
    runStep: async (s) => {
      const stepDir = join(outDir, `step-${s.index + 1}${s.attempt ? `-b${s.attempt}` : ''}`);
      const stepArgs = {
        command: 'v1',
        scenario: 'entry',
        users: s.users,
        rate: s.rate,
        warmS: s.warmS,
        mainS: s.mainS,
        prepS: s.prepS,
        cpus: a.cpus,
        memoryMi: a.memoryMi,
        record: a.record,
        invariants: a.invariants,
        namespace: 'v1',
        settle: false,
        hpaTimeline: false,
        dbStats: false,
        redisStats: false,
        hostMetrics: true,
        replicas: a.replicas,
        podCpus: a.podCpus,
        ...(a.generators !== undefined ? { generators: a.generators } : {}),
        ...(s.runId ? { runId: s.runId, profile: profileOf(s.users) } : {}),
        ...(a.promUrl ? { promUrl: a.promUrl } : {}),
        out: stepDir,
      };
      const res = await runV1(stepArgs, `${runTag.slice(0, 12)}s${s.index}${s.attempt}`);
      return entryStepResult(res.outDir, s.rate);
    },
    rest: (ms) => sleep(ms),
    log,
    writeJson: (name, v) => writeFileSync(join(outDir, name), JSON.stringify(v, null, 2)),
  });
  log(`\nX(N=${r.n}, CPU ${r.podCpus}) = ${r.x ?? '찾지 못함'}${r.saturated ? '(호스트 포화)' : ''}${r.topReached ? '(상한 단계까지 지킴: 더 높은 단계를 잰다)' : ''}${r.limitedBy ? `, 멈춘 단계 ${r.limitedBy.rate}/s: ${r.limitedBy.reasons.join('; ')}` : ''}`);
  return { outDir, exitCode: r.x === null ? 1 : 0 };
}

/** kind 노드 폴더(합본 파드가 hostPath로 붙인 곳)에 파일 하나를 둔다(docker cp, 임시 파일은 바로 지운다) */
function putHostFile(dir, name, content, uid) {
  const stage = mkdtempSync(join(tmpdir(), 'v1-host-'));
  try {
    writeFileSync(join(stage, name), content);
    execFileSync('docker', ['cp', join(stage, name), `${KIND_NODE}:${dir}/${name}`], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 });
    onNode(['chown', `${uid}:${uid}`, `${dir}/${name}`]);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** v1 serving 전진 기록의 원본 응답(합본 파드 안, queue-svc 환경 파일의 대기열 Redis). 시험 기록 꼴로 바꾸기는 servingLogFromZset이 한다 */
export function servingLogScriptV1(eventId) {
  return `import { createHotRedis } from '@peaket/platform'; import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync(process.env.PEAKET_BUNDLE_ENV_DIR + '/queue-svc.env', 'utf8').split('\\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const redis = await createHotRedis({ url: env.PEAKET_QUEUE_REDIS_URL, startupTimeoutMs: ${ADMIN_REDIS_STARTUP_MS} });
const key = ${JSON.stringify(`q:{event:${eventId}}:serving_log`)};
try {
  // 바꾸기는 이 PC에서 한다(runner/v1.mjs servingLogFromZset)
  console.log('@@RESULT ' + JSON.stringify(await redis.command(['ZRANGE', key, '0', '-1', 'WITHSCORES'], { key })));
} finally {
  await redis.close();
}`;
}

/** 시뮬레이터 원장(v0 LEDGER_SCRIPT와 같은 꼴). 주소·시험 키는 합본 파드의 payment-svc 환경 파일에서 읽는다(이 PC로 옮기지 않는다) */
export const V1_LEDGER_SCRIPT = () => `import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync(process.env.PEAKET_BUNDLE_ENV_DIR + '/payment-svc.env', 'utf8').split('\\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const authorization = 'Basic ' + Buffer.from(env.PEAKET_PG_SIM_SECRET_KEY + ':').toString('base64');
const r = await fetch(env.PEAKET_PG_SIM_URL + '/sim/ledger', { headers: { authorization }, signal: AbortSignal.timeout(60000) });
const body = await r.text();
process.stdout.write('@@RESULT ' + JSON.stringify({ status: r.status, body: r.status === 200 ? body : '' }) + '\\n');
`;

/**
 * 정지 판정 기록(코드 리뷰 M1·M8). 실패를 삼키지 않고 error 칸에 남긴다(그 실행은 무효, runner/v1.mjs pauseReasons).
 * - transitions: 살아 있는 합본 파드 로그의 kind payment-entry-pause-transition 줄(강제로 끝낸 파드의 로그는 남지 않는다)
 * - pauseRows: 결제 DB payment_entry_pause의 마지막 상태(결제사·단계·판 번호·시각, 끝낸 파드가 쓴 전이까지 담는다)
 * - newPaymentPaused503: 클러스터 Prometheus의 purchase_payment_attempts_total{outcome="new_payment_paused"}를 파드마다 실행 동안의 최댓값으로 더한 합(끝낸 파드 포함)
 * - inputs: 판정자가 읽는 kube_pod_status_ready가 Prometheus에 있는가(로컬 관측 묶음에는 kube-state-metrics가 없어 보통 absent다, docs/verification.md §3.10)
 */
async function pauseProbe(loadStartMs) {
  const errors = [];
  const sinceS = Math.max(60, Math.ceil((Date.now() - loadStartMs) / 1000) + 60);
  let text = '';
  try {
    text = await kc(['-n', V1_NAMESPACE, 'logs', '-l', BUNDLE_SELECTOR, '--tail=-1', `--since=${sinceS}s`, '--max-log-requests=8'], { timeout: 180_000 });
  } catch (e) {
    errors.push(`합본 로그: ${String(e.message ?? e).slice(0, 200)}`);
  }
  const transitions = text
    .split('\n')
    .filter((l) => l.includes('payment-entry-pause-transition'))
    .flatMap((l) => {
      try {
        const o = JSON.parse(l);
        return [{ ts: o.ts, pod: o.pod, pg: o.pg, from: o.from, to: o.to, reason: o.reason }];
      } catch {
        return [];
      }
    });
  let pauseRows = [];
  try {
    const out = await kc(['-n', V1_NAMESPACE, 'exec', 'deploy/postgres', '--', 'psql', '-U', 'postgres', '-d', V1_DATABASES.payment, '-At', '-F', '\t', '-c', 'select pg, channel, stage, reason, version, since from payment_entry_pause order by pg, channel']);
    pauseRows = out.trim() ? out.trim().split('\n').map((l) => { const [pg, channel, stage, reason, version, since] = l.split('\t'); return { pg, channel, stage, reason, version: Number(version), since }; }) : [];
  } catch (e) {
    errors.push(`정지 행: ${String(e.message ?? e).slice(0, 200)}`);
  }
  const prom = async (q, timeS) => {
    const at = timeS === undefined ? '' : `&time=${timeS}`;
    const r = await inBundlePod(`const r = await fetch('${V1_PROMETHEUS}/api/v1/query?query=' + encodeURIComponent(${JSON.stringify(q)}) + '${at}', { signal: AbortSignal.timeout(20000) }); const b = await r.json(); console.log('@@RESULT ' + JSON.stringify({ status: r.status, result: b?.data?.result ?? null }));`, 60_000);
    if (r.status !== 200 || !Array.isArray(r.result)) throw new Error(`Prometheus 질의 실패(HTTP ${r.status})`);
    return r.result;
  };
  let newPaymentPaused503 = 0;
  let inputs = 'unknown';
  try {
    // 누적 카운터라 실행 시작 때 값을 시계열마다 빼 이 실행 몫만 센다(같은 파드의 앞 실행 수를 넣지 않는다, 끝낸 파드 포함, 재확인 리뷰 4)
    const series = `purchase_payment_attempts_total{namespace="${V1_NAMESPACE}",outcome="new_payment_paused"}`;
    const baseline = await prom(series, (loadStartMs / 1000).toFixed(3));
    newPaymentPaused503 = pausedDelta(baseline, await prom(`max_over_time(${series}[${sinceS}s])`));
    inputs = (await prom('count(kube_pod_status_ready)')).length ? 'present' : 'absent';
  } catch (e) {
    errors.push(`Prometheus: ${String(e.message ?? e).slice(0, 200)}`);
  }
  return { transitions, pauseRows, newPaymentPaused503, inputs, error: errors.length ? errors.join('; ') : null };
}

/** 무대 PostgreSQL의 지금 연결 수(DB별 합). 못 읽으면 null(그 표본만 빈다) */
async function pgConnections() {
  try {
    return Number((await kc(['-n', V1_NAMESPACE, 'exec', 'deploy/postgres', '--', 'psql', '-U', 'postgres', '-At', '-c', "select count(*) from pg_stat_activity where backend_type = 'client backend'"])).trim());
  } catch {
    return null;
  }
}

/** v1 불변식 검사: 검사 연결·purchase 원본은 v1_purchase, payment 원본은 v1_payment. ticket 원본이 없어 P5·S3은 SKIPPED다 */
async function runInvariantsV1(outDir, recordsFile) {
  if (!existsSync(INVARIANT_CLI)) throw new Error("불변식 검사기가 빌드되어 있지 않다. 먼저 'pnpm --filter @peaket/invariant-checker build'");
  const k = await ensureTool('kubectl');
  // 검사 뷰(v1_check): v1 결제 DB에는 취소 표가 아직 없어 빈 payment_cancel 뷰를 둔다(P3이 표 없음으로 SKIPPED되지 않게, 코드 리뷰 H2)
  await kc(['-n', V1_NAMESPACE, 'exec', 'deploy/postgres', '--', 'psql', '-U', 'postgres', '-d', V1_DATABASES.payment, '-v', 'ON_ERROR_STOP=1', '-c', V1_CHECK_VIEWS_SQL]);
  const pf = spawn(k, ['--kubeconfig', KUBECONFIG, '-n', V1_NAMESPACE, 'port-forward', '--address', '127.0.0.1', 'svc/postgres', ':5432'], { stdio: ['ignore', 'pipe', 'pipe'] });
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
    // 무대 전용 PostgreSQL의 비밀번호는 무대마다 새로 만든 Secret v1-postgres에만 있다(검사기 환경 값으로만 넘기고 산출물에 적지 않는다)
    const password = Buffer.from((await kc(['-n', V1_NAMESPACE, 'get', 'secret', 'v1-postgres', '-o', 'jsonpath={.data.POSTGRES_PASSWORD}'])).trim(), 'base64').toString('utf8');
    const db = (name) => `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/${name}`;
    const invDir = join(outDir, 'invariants');
    const env = { ...process.env, INVARIANT_CHECK_DB_URL: db(V1_DATABASES.purchase), INVARIANT_PURCHASE_DB_URL: db(V1_DATABASES.purchase), INVARIANT_PAYMENT_DB_URL: v1PaymentDbUrl(db(V1_DATABASES.payment)) };
    delete env.INVARIANT_TICKET_DB_URL;
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

/** v1 실행의 요약 notes(경로는 v1 경로 이름) */
function runNotesV1(a, o) {
  const saved = ROUTES[a.scenario];
  ROUTES[a.scenario] = ROUTES_V1[a.scenario];
  try {
    const base = runNotes(a, o);
    const c = o.merged.metrics['payment_confirm_ms{phase:main}']?.values;
    return c ? `${base}; 결제 확정(접수 시작 → 끝 상태) p99 ${(c['p(99)'] ?? NaN).toFixed(1)}ms·최대 ${(c.max ?? NaN).toFixed(1)}ms` : base;
  } finally {
    ROUTES[a.scenario] = saved;
  }
}

/**
 * v1 합본 실행의 notes에 적는 무대 사실(docs/verification.md §3.10 'v1 합본 측정 규칙'). 규칙 모델 검사 한 줄은 측정 뒤 기록 단계가 더한다(BUILD_ORDER PRF-220)
 * @param {Record<string, unknown>} a
 * @param {{ redisTls: boolean, skipped?: string[], pause?: { inputs: string, newPaymentPaused503: number }, entry?: { trials: number, failed: number } }} o
 * @returns {string[]}
 */
export function v1StageNotes(a, o) {
  return [
    `v1 한 프로세스 합본(queue-svc·admission-ctrl·purchase-svc·payment-svc, OTel 서비스 이름 bundle 하나), Redis TLS ${o.redisTls ? '켬' : '끔'}`,
    '넣지 않은 서비스의 대역: trust-svc 위험 판정 늘 축소 운영, identity-svc 재확인 토큰 판정, ticket-svc 늘 발권, core-svc 대신 시드(회차 일정·좌석 판매·좌석맵 판)',
    '게이트웨이 없음: k6가 합본 Service와 대기 상태 파일 앞 nginx 캐시로 바로 보내고 신원 머리를 넣는다(입구 IP 한도 없음)',
    ...(o.skipped ? [`불변식 SKIPPED: ${o.skipped.join('·') || '없음'}(기대 ${V1_EXPECTED_SKIPPED.join('·')}, 티켓 원본 없음, 결제 취소는 빈 검사 뷰)`] : []),
    ...(a.scenario === 'payment' ? ['K7: 가상 사용자마다 반복 안에서 진입·입장 뒤 결제(phase:prep 요청은 본구간 판정에서 뺌, 동시 입장 목표 5,000명), 결제 확정 시간은 결제 접수 시작부터 끝 상태까지'] : []),
    ...(o.pause ? [`정지 판정 입력(kube_pod_status_ready) ${o.pause.inputs === 'present' ? '있음' : o.pause.inputs === 'absent' ? '없음: 로컬 무대에서는 K7 ②의 정지 전이를 판정하지 못한다(측정 조건)' : '확인 못 함'}, 새 결제 정지 503 ${o.pause.newPaymentPaused503}건(끝낸 파드 포함)`] : []),
    ...(a.scenario === 'queue'
      ? [
          `K1: 로비 없이 오픈 뒤 진입, 입장 속도는 시험 회차의 결제사 승인 상한 ${a.admitPerSecond}/s로 시드(실행마다 다른 묶음 이름, 동시 입장 목표 상한 ${a.admitPerSecond * 90}명, docs/verification.md §3.9 'K1의 입장 속도')`,
          ...(o.entry ? [`진입 시행 ${o.entry.trials}건(사전 검증 실패 포함 실패 ${o.entry.failed}건)`] : []),
          'Q1은 서버의 1초 칸 serving 기록으로 견준다(같은 초 안에서 차례보다 이른 입장은 놓친다, v0보다 약하다)',
        ]
      : []),
  ];
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

// ───────────── 게이트웨이 차단 상한·검색 IP 한도(gw, V-T43·SR-T13 ②, BAT-056) ─────────────

/** 시나리오가 쓰는 회차 ID(대역 백엔드는 보지 않는다) */
const GW_EVENT_ID = '00000000-0000-4000-8000-000000000056';
/** 시나리오의 가상 사용자 토큰 수(토큰을 쓰는 흐름이 돌려 쓴다) */
const GW_TOKENS = 1000;

/** 프록시 관리 포트(파드 안 127.0.0.1:19000)의 글. 부하가 아니므로 포트 전달로 잠깐 열고 닫는다 */
async function adminGet(pod, path) {
  const k = await ensureTool('kubectl');
  const pf = spawn(k, ['--kubeconfig', KUBECONFIG, '-n', GW_NAMESPACE, 'port-forward', '--address', '127.0.0.1', `pod/${pod}`, `:${ADMIN_PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stop = async () => pf.kill();
  cleanups.add(stop);
  try {
    const port = await new Promise((ok, no) => {
      let buf = '';
      const t = setTimeout(() => no(new Error(`${pod} 관리 포트 전달이 열리지 않았다`)), 30_000);
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
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`${pod} 관리 포트 ${path}: ${r.status}`);
    return await r.text();
  } finally {
    cleanups.delete(stop);
    pf.kill();
  }
}

/** 생성 라우트(deploy/gateways/*.routes.yaml, 읽기만)에서 이름으로 HTTPRoute 객체 */
function gwRouteObject(route) {
  const dir = join(REPO, 'deploy', 'gateways');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.routes.yaml')))
    for (const d of parseAllDocuments(readFileSync(join(dir, f), 'utf8'))) {
      const o = d.toJS();
      if (o?.kind === 'HTTPRoute' && o.metadata?.name === route) return o;
    }
  throw new Error(`생성 라우트 ${route}가 deploy/gateways/*.routes.yaml에 없다`);
}

/** 프록시 envoy 컨테이너의 누적 CPU(나노초, kubelet 요약 통계) */
async function gwProxyCpuNs(pods) {
  const s = JSON.parse(await kc(['get', '--raw', `/api/v1/nodes/${KIND_NODE}/proxy/stats/summary`]));
  const out = {};
  for (const p of pods) {
    const pod = (s.pods ?? []).find((x) => x.podRef?.namespace === GW_NAMESPACE && x.podRef?.name === p);
    const c = pod?.containers?.find((x) => x.name === 'envoy');
    const ns = c?.cpu?.usageCoreNanoSeconds;
    if (!Number.isFinite(ns)) throw new Error(`${p} envoy 컨테이너의 CPU 누적값이 없다`);
    out[p] = ns;
  }
  return out;
}

/** 프록시 접근 로그 JSON 줄 */
async function gwAccessLog(gateway, sinceS) {
  const out = await kc(['-n', GW_NAMESPACE, 'logs', '-l', PROXY_SELECTOR(gateway), '-c', 'envoy', `--since=${Math.max(1, sinceS)}s`, '--tail=-1', '--prefix=false'], { timeout: 180_000 });
  const lines = [];
  for (const l of out.split('\n')) {
    try {
      const o = JSON.parse(l);
      if (o && typeof o === 'object') lines.push(o);
    } catch {
      // JSON이 아닌 줄(Envoy 자체 로그)은 버린다
    }
  }
  return lines;
}

async function runGwCommand(a, runTag) {
  const c = loadContract();
  if (!c.caPem) throw new Error('게이트웨이 접속 정보에 caPem이 없다(클러스터 안 발생기가 게이트웨이 인증서를 확인하지 못한다)');
  const outDir = resolve(a.out ?? join(OUT_ROOT, `${today()}-gw-${a.sub}-${runTag}`));
  mkdirSync(outDir, { recursive: true });
  const hostDir = `${NODE_ROOT}/${runTag}`;
  const nSteps = a.sub === 'sweep' ? a.steps.length : a.sub === 'capacity' ? a.rates.length : 1;
  const totalS = nSteps * (a.warmS + a.mainS + STEP_OVERHEAD_S) + 600;
  const segments = executionSegments(a.generators);
  const pods = segments.map((sg) => `loadgen-${runTag}-g${sg.index}`);
  const gen = { cpus: a.cpus, memoryMi: a.memoryMi };
  let locked = false;
  let started = false;
  const cleanup = async () => {
    for (const p of pods) await kc(['-n', NS, 'delete', 'pod', p, '--ignore-not-found', '--wait=true']).catch(() => {});
    removeNodeDir(hostDir);
    if (locked) await releaseLock(runTag);
  };
  cleanups.add(cleanup);
  const startGenerators = async () => {
    step(`발생기 파드 ${pods.length}대(CPU ${a.cpus}, 메모리 ${a.memoryMi}Mi씩)`);
    const iat = Math.floor(Date.now() / 1000);
    const tokens = JSON.stringify(Array.from({ length: GW_TOKENS }, (_, i) => token(c, 'fan', { sub: accountRef(runTag, i), sid: sidOf(runTag, i), pid: pidOf(runTag, i), aud: 'fan', scope: 'ticket:buy', iat, exp: iat + totalS + 600 })));
    stageInputs(hostDir, { caPem: c.caPem, tokens });
    for (const [i, p] of pods.entries()) await createObject(generatorPod({ name: p, cpus: a.cpus, memoryMi: a.memoryMi, hostDir, deadlineS: Math.min(11400, totalS), index: segments[i].index }));
    for (const p of pods) await waitPodReady(p);
    writeFileSync(join(outDir, 'infra.txt'), infraText({ cpus: a.cpus, memoryMi: a.memoryMi, generators: pods.length, args: a }));
    started = true;
  };
  const runLoad = async ({ index, input, rate, warmS, mainS }) => {
    if (!started) await startGenerators();
    const dir = join(outDir, `step-${String(index + 1).padStart(2, '0')}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'gw.json'), JSON.stringify({ ...input, originVerify: '(지움)' }, null, 2));
    putNodeFile(hostDir, 'gw.json', JSON.stringify(input));
    for (const sg of segments) {
      putNodeFile(hostDir, `run-${sg.index}.env`, runEnvFile({ SCENARIO: 'gw.js', RUN_TAG: runTag, OUT_DIR: `/work/out/g${sg.index}`, USERS_FILE: '/work/users.json', GW_FILE: '/work/gw.json', RATE: rate, WARM_S: warmS, MAIN_S: mainS, K6_EXECUTION_SEGMENT: sg.segment, K6_EXECUTION_SEGMENT_SEQUENCE: sg.sequence }));
      onNode(['rm', '-f', `${hostDir}/out/g${sg.index}/exit`, `${hostDir}/out/g${sg.index}/exit.tmp`]);
    }
    onNode(['rm', '-f', `${hostDir}/go`]);
    for (const p of pods) await kc(['-n', NS, 'exec', p, '--', 'sh', '-c', 'nohup sh /work/bin/run-split.sh >/dev/null 2>&1 &']);
    await sleep(1000);
    onNode(['sh', '-c', `touch ${hostDir}/go && chown ${K6_UID}:${K6_UID} ${hostDir}/go`]);
    const loadStartMs = Date.now();
    const outs = await Promise.all(segments.map((sg) => waitK6(pods[sg.index], hostDir, `out/g${sg.index}`, warmS + mainS + 30)));
    onNode(['rm', '-f', `${hostDir}/go`]);
    for (const [i, o] of outs.entries()) {
      writeFileSync(join(dir, `k6-g${i}.log`), o.k6log);
      writeFileSync(join(dir, `cgroup-g${i}.log`), o.cgroup);
      writeFileSync(join(dir, `console-g${i}.ndjson`), o.console);
    }
    const bad = outs.find((o) => o.exit !== 0 && o.exit !== 99);
    if (bad) throw new Error(`k6가 종료 코드 ${bad.exit}로 끝났다:\n${bad.k6log.slice(-1500)}`);
    const parsed = outs.map((o) => gwConsole(o.console));
    const marks = Object.assign({}, ...parsed.map((p) => p.marks));
    if (marks.main_start === undefined || marks.main_end === undefined) throw new Error('본구간 경계 표시가 없다(k6가 본구간까지 가지 못했다)');
    const retryAfterValues = {};
    for (const p of parsed) for (const [cls, set] of Object.entries(p.retryAfterValues)) for (const v of set) (retryAfterValues[cls] ??= new Set()).add(v);
    const evs = outs.map((o) => evaluate(o, gen, marks, { records: [], marks, probes: [] }));
    const summary = mergeSummaries(evs.map((e) => e.summary));
    writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
    const g = combineGenerators(evs.map((e) => e.generator), loadStartMs);
    writeFileSync(join(dir, 'generator.json'), JSON.stringify(g, null, 2));
    // summaries는 발생기마다의 요약(합치기 전): 2xx 평균을 발생기 2xx 수로 가중하는 데 쓴다(ADR-0287 결정 6, gw.mjs weightedMean2xx)
    return { summary, summaries: evs.map((e) => e.summary), marks, retryAfterValues, generator: { valid: g.judge.valid, reasons: g.judge.reasons, dropped: g.dropped, cpuMeanPct: g.cpuMeanPctMax, cpuMaxPct: g.cpuMaxPctMax }, dir };
  };
  // 장부 인자는 gw-run.mjs gwCollectArgs가 만든다(0건 판정은 --verdict·notes, 점검은 과부하 3ms 하나, 무효는 --invalid-reason, BAT-056 R1)
  const record = async (o) => {
    const dir = join(outDir, `step-${String(o.index + 1).padStart(2, '0')}`);
    const checksFile = join(dir, 'checks.json');
    const { args, checks } = gwCollectArgs(o, {
      mainS: a.mainS,
      warmS: a.warmS,
      summaryFile: join(dir, 'summary.json'),
      infraFile: join(outDir, 'infra.txt'),
      checksFile,
      generator: `k6 1.4.2, 발생기 파드 ${pods.length}대(CPU ${a.cpus}·메모리 ${a.memoryMi}Mi씩, kind 안, 게이트웨이 프록시 Service로 바로)`,
    });
    if (checks) writeFileSync(checksFile, JSON.stringify(checks, null, 2));
    step(`성능 장부(${o.runId})`);
    execFileSync(PYTHON, ['-I', '-X', 'utf8', ...args], { cwd: REPO, stdio: 'inherit' });
  };
  try {
    step('네임스페이스, 실행 잠금');
    await ensureNamespace();
    await acquireLock(runTag, Date.now() + totalS * 1000 * 2);
    locked = true;
    await sweepLeftovers();
    await kc(['-n', GW_NAMESPACE, 'delete', 'backendtrafficpolicies', '-l', `${SWEEP_LABEL}=true`, '--ignore-not-found']);
    const r = await runGw(a, {
      kubectl: (args, o = {}) => kubectl(args, { quiet: true, timeout: 330_000, maxBuffer: 1 << 30, ...(o.input !== undefined ? { input: o.input } : {}) }),
      readAdmin: adminGet,
      routeObject: gwRouteObject,
      runLoad,
      readAccessLog: gwAccessLog,
      proxyCpuNs: gwProxyCpuNs,
      record,
      save: (name, v) => writeFileSync(join(outDir, name), JSON.stringify(v, null, 2)),
      sleep,
      now: () => Date.now(),
      log,
      onCleanup: (fn) => cleanups.add(fn),
      offCleanup: (fn) => cleanups.delete(fn),
      inputBase: { origin: c.origins.www, originVerify: c.originVerify, hostNames: c.hosts, eventId: GW_EVENT_ID },
    });
    return { outDir, exitCode: r.exitCode };
  } finally {
    cleanups.delete(cleanup);
    await cleanup();
  }
}

/** gw limits: 측정 결과 sweep.json들로 k와 운영 차단 상한을 센다(클러스터·잠금을 쓰지 않는다, ADR-0287 결정 7). 끝 코드는 runLimits(0·1) */
async function runGwLimits(a, runTag) {
  const outDir = resolve(a.out ?? join(OUT_ROOT, `${today()}-gw-limits-${runTag}`));
  mkdirSync(outDir, { recursive: true });
  const r = await runLimits(a, {
    readFile: (p) => readFileSync(resolve(p), 'utf8'),
    save: (name, v) => writeFileSync(join(outDir, name), JSON.stringify(v, null, 2)),
    log,
  });
  return { outDir, exitCode: r.exitCode };
}

// ───────────── 시작 ─────────────

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let a;
  try {
    a = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`loadtest/run.mjs: ${e.message}`);
      console.error('쓰는 법: node loadtest/run.mjs calibrate [...] | v0 queue|seat-hold|payment|seat-deltas|gate [...] | v1 queue|seat-hold|payment|entry-steps [...] | gw sweep|capacity|ip-limit|limits [...] | cleanup (loadtest/README.md)');
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
    const r = a.command === 'cleanup' ? await runCleanup() : a.command === 'calibrate' ? await runCalibrate(a, runTag) : a.command === 'gw' ? (a.sub === 'limits' ? await runGwLimits(a, runTag) : await runGwCommand(a, runTag)) : a.command === 'v1' ? (a.scenario === 'entry-steps' ? await runEntryStepsCommand(a, runTag) : await runV1(a, runTag)) : await runV0(a, runTag);
    log(`\n산출물: ${r.outDir}`);
    process.exit(r.exitCode);
  } catch (e) {
    console.error(`loadtest/run.mjs: ${e.message}`);
    process.exit(1);
  }
}
