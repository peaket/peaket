// BSL-090 Before 측정 리허설 e2e(docs/verification.md §3.9·§3.10, loadtest/README.md, wbs 1.4.1 ②, BUILD_ORDER BSL-090).
// Before 측정에 더한 길을 실제 kind에서 작은 규모로 끝까지 돌려(시험마다 몇 분, 본구간 10~40초) 산출물의 꼴과 뜻을 본다:
//  1. NFR-013 발생기 나누기(v0 queue --generators 2): 발생기 파드 둘(나눈 몫 CPU 2·1GiB), 시작 차이 2초 미만, 합친 요약(merge.generators,
//     경로 p99의 아래·위 한계, 요청 수는 더함 = 계획한 조회 수), 진입을 두 발생기가 반씩 겹치지 않게 나눠 보냄, checks.json = 합친 요약의 점검
//  2. S-T1 인기 좌석 놓지 않기(--mode hot --hot-count 1 --keep --db-stats): 회차 전체에서 홀드 201은 첫 한 건뿐(v0 DB), 해제 요청 없음, db-stats.json
//  3. S-T10 엇갈린 좌석 두 쌍(--mode crossed --pairs 2 --db-stats): db-stats.json의 교착 수(0 이상 정수, 0 초과는 요구하지 않음)와 시험이 잰 전후 차이
//  4. S-T12 변경분 연결(v0 seat-deltas): 연결 100개를 받는 파드 둘이 나눠 맺음, deltas.json·deltas.ndjson, 받는 파드가 남지 않음
//  5. O-T1 망 끊김(v0 gate): 끊긴 뒤 짧은 여유(입구 파드가 실제로 죽기까지·두 시계 차이) 뒤로는 되돌릴 때까지 판정 0(끊긴 동안 처리량 ≈ 0),
//     되돌린 뒤 판정, 판정이 멈춘 시간 ≥ 끊긴 길이, 입구가 원래 복제로 준비됨, gate.json의 구간 요약 = 콘솔의 검표 시도 줄과 끊은 시각(cutTimes)으로 다시 센 값
//  6. K9 --settle --hpa-timeline: --settle 단계가 돌았고 부하 시작 때 앱 파드가 HPA 최소였음, hpa.json의 꼴과 계산
//  7. 낮음-056 --record --prom-url(--settle과 함께): 장부 실행 폴더(manifest raw_uri·checks, metrics-summary.json), 큰 원본은 보낼 폴더로(stdout.log.gz).
//     시험이 지운다
//  8. S-T15 K5 랩(seatmap-lab.mjs --reps 2): lab.json·rows.json, 입구 포트 전달(8443)·Chrome 프로필이 남지 않음
//  9. D-T40 야간 비교 한 판(nightly.py run, A/A 설정을 rounds 1로): 결과 JSON, v0-base 준비
// 10. P-T1 결제사 응답 버림(v0 payment --fault-drop-pct 20 --invariants --settle): P6 위반, 종료 코드 0. 불변식을 일부러 깨므로 마지막 시험이다
//
// 실행(저장소 뿌리. 이 파일 하나를 차례대로 돌린다):
//   node tools/local/cluster.mjs up && node tools/local/cluster.mjs observability && node tools/local/cluster.mjs v0
//   node tools/local/cluster.mjs prometheus          # 다른 창에 열어 둔다(7번. 닿지 않으면 그 시험만 건너뛴다)
//   pnpm --filter @peaket/invariant-checker build    # 10번
//   node --test --test-concurrency=1 loadtest/e2e/before090.e2e.mjs
// 예상 시간: 모두 합쳐 약 40~65분(시험마다 대개 2~4분, 9번 야간 비교가 이미지를 다시 빌드해 15~20분). 1·6·7·10번은 --settle로 앞 부하가 늘린
// 앱 복제를 HPA가 줄이기를 각각 최대 15분(늘었으면 대개 5~6분, 아니면 0분) 기다린다. 시험 한도의 합은 약 3시간 50분이다(MINUTES)
//
// 전제(어기면 before 훅이 까닭과 할 일을 적고 모든 시험이 실패한다. 건너뛰지 않는다):
// 1. 클러스터 peaket에 v0(v0-gateway·v0-monolith·pg-simulator)가 준비돼 있고 입구 복제가 1 이상이다
// 2. 이 파일은 클러스터를 혼자 쓴다. Before 측정 실행이나 다른 부하 실행과 함께 돌리지 않는다. 실행 잠금(네임스페이스 loadtest의
//    ConfigMap loadtest-lock)이 살아 있거나 네임스페이스 loadtest에 파드·Secret·빈 응답 대역이 있으면 before 훅이 지우지 않고 멈춘다
//    (실행 잠금을 잡지 않는 K5 랩·야간 비교 준비 명령이 돌고 있는 측정을 망가뜨리지 않게)
// 3. 시험 토큰 서명 키(.cache/peaket-tools/v0-token-key.json)가 있고 kind 노드 컨테이너 peaket-control-plane에 docker exec로 닿는다
// 시험마다 갖춰야 하는 것(없으면 그 시험만 까닭을 적고 건너뛴다): 7번 Prometheus(127.0.0.1:9090)와 Python, 8번 Chrome(이 PC의 Playwright
// Chromium 또는 환경 값 PEAKET_K5_CHROME)과 비어 있는 127.0.0.1:8443, 9번 Python. 10번은 검사기 빌드가 없으면 실패한다
// 그 밖:
// - 9번은 node loadtest/nightly/prepare.mjs --aa로 v0 이미지를 다시 빌드해 다시 배포한다. 그때 시뮬레이터 시험 키가 새로 되고 시뮬레이터가
//   다시 떠 결제사 원장이 비워진다(tools/local/cluster.mjs v0). 시험 전에 v0-base가 없었으면 그 시험 끝에 네임스페이스 v0-base를 지운다
// - 10번(마지막)은 결제사가 승인한 뒤 응답을 버리게 해 불변식 P6을 일부러 깬다. 이 뒤에 같은 클러스터에서 돈 --invariants 실행은 그 위반을
//   본다. 새로 올린 클러스터에서 돌리거나 그것을 받아들인다(docs/verification.md §3.10 '공통 규칙': 장애를 넣는 실행은 다른 측정을 모두 마친 뒤)
// - 실행 폴더는 OS 임시 폴더 아래 peaket-bsl090-e2e-*에 둔다. 시험마다 산출물에 토큰·시험 키·서명 개인키가 없음을 먼저 보고, 통과하면 지우고
//   실패하면 원인을 보도록 남긴다. 7번이 장부에 만든 실행 폴더(docs/perf-ledger/runs/<ID>)와 보낼 폴더의 원본은 통과·실패와 상관없이 지운다
// - 실행 도구가 한도를 넘으면 프로세스 나무째 끊고(Windows taskkill /T /F, 실행 도구의 정리가 돌지 않는다) node loadtest/run.mjs cleanup으로
//   실행 잠금·발생기·받는 파드·실행 폴더·시험 키를 지우고 끊긴 입구를 되돌린다(loadtest/README.md). 모든 시험이 끝난 뒤(after)에도 남은 것을 지운다
// - 시각은 되도록 같은 시계끼리 견준다: 구간 표시·검표 시도·변경분 칸·cgroup 표본은 kind 노드 시계, run.json·loadStartMs·끊은 시각(cutTimes)은
//   이 PC 시계다. 검표의 구간 나누기만 실행 도구(gateSummary)와 같이 두 시계를 섞는다. 5번은 실행 앞뒤로 두 시계 차이를 docker exec로 재어
//   끊긴 구간의 여유에 더하고, 2초를 넘으면 K10 구간 나누기를 믿을 수 없어 실패한다(Docker Desktop을 다시 띄워 시계를 맞춘 뒤 다시 돌린다)
// - kubectl은 동기로 돌아 멈추면 시험 한도가 끼어들지 못하므로 부를 때마다 시간 한도를 준다
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { KUBECONFIG, V0_BASE_NAMESPACE, V0_FORWARD_PORT, V0_IMAGES, V0_NAMESPACE, V0_TOKEN_KEY_FILE, kubectl } from '../../tools/local/cluster.mjs';
import { summarizeLab } from '../k5/lab-summary.mjs';
import { pollStages } from '../lib/model.mjs';
import { faultFor } from '../lib/targets.mjs';
import { accountRef } from '../lib/users.mjs';
import { DEFAULTS, parseArgs } from '../runner/args.mjs';
import { KIND_NODE, LOADGEN_NAMESPACE, NODE_ROOT, NULL_TARGET_NAME, SIM_KEY_SECRET } from '../runner/manifests.mjs';
import { CHECK_PHASES, checksFromSummary } from '../runner/merge.mjs';
import { deltaSummary, gateOnlineCheck, gateSummary } from '../runner/probes.mjs';
import { judgeGenerator, perVuBytes as perVuBytesOf, splitConsole, withScenarioErrors } from '../runner/results.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO, 'loadtest', 'run.mjs');
const K5_LAB = join(REPO, 'loadtest', 'k5', 'seatmap-lab.mjs');
const NIGHTLY = join(REPO, 'tools', 'perf-ledger', 'nightly.py');
const NIGHTLY_AA_CONFIG = join(REPO, 'loadtest', 'nightly', 'config-aa.json');
/** nightly.py가 판마다 받은 요약을 두는 자리(작업 폴더 기준 .cache/nightly, 접두 없는 run은 <회차>-<판>.json) */
const NIGHTLY_SUMMARY_DIR = join(REPO, '.cache', 'nightly');
const CHECKER = join(REPO, 'services', 'invariant-checker');
const LEDGER_RUNS = join(REPO, 'docs', 'perf-ledger', 'runs');
/** 장부 원본: 올릴 자리와 보낼 폴더(docs/verification.md §3.10 '원본 보관') */
const RAW_BUCKET = 's3://peaket-perf-raw';
const RAW_OUTBOX = join(REPO, '.cache', 'perf-raw-outbox');
const QUERIES_V0 = join(REPO, 'loadtest', 'queries', 'v0.txt');
const PROM_URL = 'http://127.0.0.1:9090';
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const LT = LOADGEN_NAMESPACE;
/** 실행 잠금(docs/verification.md §3.9 '발생기 배치') */
const LOCK = 'loadtest-lock';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 실행 도구가 이 PC 임시 폴더에 꾸리는 발생기 입력(토큰이 든다, run.mjs stageInputs·putNodeFile) */
const STAGING = /^loadgen-(env-)?[A-Za-z0-9]{6}$/;
/** K5 랩의 Chrome 프로필 폴더(seatmap-lab.mjs) */
const K5_PROFILE = /^k5-chrome-/;
/** 야간 비교 도구의 임시 폴더(k6-run.mjs nightly-run-*, prepare.mjs nightly-src-*) */
const NIGHTLY_TMP = /^nightly-(run|src)-/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN = 60_000;

/** 나눈 발생기 하나의 몫(docs/verification.md §3.10 '발생기 나누기': CPU 2개·메모리 1GiB [가정]). --cpus·--memory-mi를 주지 않을 때 */
const SPLIT_GEN = Object.freeze({ cpus: 2, memoryMi: 1024 });
/** 나누지 않는 실행의 발생기 몫(기본 CPU 4·4GiB는 이 PC의 kind 노드에서 v0와 함께 자리를 못 잡을 수 있어 작게 준다. v0-rehearsal과 같다) */
const SMALL_GEN = Object.freeze({ cpus: 2, memoryMi: 1024 });
const SMALL_GEN_ARGS = ['--cpus', String(SMALL_GEN.cpus), '--memory-mi', String(SMALL_GEN.memoryMi)];
/** 시나리오가 요청에 다는 경로(점검 파일을 만드는 경로, run.mjs ROUTES)와 본구간에 나올 수 있는 경로(docs/verification.md §3.9 '시나리오') */
const ROUTES = Object.freeze({
  queue: ['entry', 'status', 'admission'],
  'seat-hold': ['hold', 'release'],
  'seat-deltas': ['hold', 'release'],
  payment: ['hold', 'order', 'sim_auth', 'sim_fault', 'payment', 'order_view'],
  gate: ['scan'],
});
const MAIN_ROUTES = Object.freeze({ ...ROUTES, queue: ['status', 'admission'] });
/** 대기열의 서버 히스토그램 점검과 지연 대조(--prom-url, docs/verification.md §3.10 '서버 지표') */
const QUEUE_SERVER_CHECK = Object.freeze({ name: 'status_server_p99_200ms', k6Metric: 'http_req_duration{phase:main,route:status}', targetMs: 200 });
/** 산출물에 있으면 안 되는 비밀의 꼴(ASVS v5.0.0-13.3.1·14.2.4, v0-rehearsal과 같다). 맞은 글은 메시지에 싣지 않는다 */
const SECRET_PATTERNS = [
  ['JWT 꼴 토큰', /eyJ[\w-]{4,}\.eyJ[\w-]{4,}/],
  ['액세스 토큰 쿠키 값', /__Secure-peaket_at=[^;\s"']{8,}/],
  ['시뮬레이터 시험 키', /sim_sk_/],
  ['개인키 PEM', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['JWK 개인키 칸(d)', /"d"\s*:\s*"[\w-]{40,}"/],
];

/** 작은 대기열 실행(K1 꼴): 진입 3초 + 예열 5초 + 본구간 20초. 부르는 속도 2명/초라 본구간 내내 0.5초·5초 묶음이 함께 있다(v0-rehearsal과 같은 까닭) */
const Q = Object.freeze({ users: 300, entryRate: 100, admitPerSecond: 2, warmS: 5, mainS: 20 });
const queueArgs = (q = Q) => ['--users', q.users, '--entry-rate', q.entryRate, '--admit-per-second', q.admitPerSecond, '--warm', q.warmS, '--main', q.mainS].map(String);
/** 앱 파드 고르기(run.mjs APP_SELECTOR와 같다) */
const APP_SELECTOR = 'app.kubernetes.io/name=v0-monolith';
/**
 * K10 끊김의 여유(ms): 입구를 0개로 줄이고 강제로 끝내는 명령이 돌아온 뒤에도 kubelet이 컨테이너를 실제로 죽이기까지는 판정이 이어진다
 * (2026-11-03 리허설: 명령이 돌아온 뒤 0.1~0.7초에 시작한 시도 4건이 판정을 받음). 그 두 배 남짓을 두고, 두 시계 차이는 따로 더한다
 */
const CUT_GRACE_MS = 1500;
/** 이 PC와 kind 노드의 시계 차이 상한(ms). 넘으면 K10 구간 나누기(두 시계를 섞는다)를 믿을 수 없다 */
const CLOCK_MAX_OFFSET_MS = 2000;
/** 끊김/온라인 분당 판정 비율 상한: 끊긴 약 10초 가운데 여유 2초 안팎만 판정이 날 수 있다 */
const OFFLINE_RATIO_MAX = 0.25;

/**
 * 시험 한도(분)와 실행 도구를 끊는 한도(시험 한도 − 6분). 끊은 뒤의 정리(node loadtest/run.mjs cleanup 최대 3분 + 직접 지우기)가 시험 한도 안에 끝나
 * 다음 시험과 겹쳐 돌지 않게 한다
 */
const opts = (min) => ({ concurrency: false, timeout: min * MIN });
const killAfter = (min) => (min - 6) * MIN;
/**
 * 시험마다의 한도(분). 실행 자체는 대개 2~4분(파드 준비·회차 열기·k6·정리)이고, --settle을 주는 시험(나눈 발생기·K9·장부 기록·결제사 장애)은
 * HPA가 복제를 줄이기를 최대 15분(run.mjs settleHpa) 더 기다릴 수 있다. D-T40은 준비 명령이 이미지를 다시 빌드해 10~15분 걸린다
 */
const MINUTES = Object.freeze({ split: 28, hotKeep: 11, crossed: 11, deltas: 12, gate: 12, hpa: 28, record: 28, k5: 16, nightly: 55, payment: 28 });

// ---- 공유 상태(before에서 채운다) ----
let ready = false;
let TMP = '';
/** 돌고 있는 자식 프로세스(after가 끈다) */
const children = new Set();
/** 산출물에서 글자 그대로 찾을 비밀 값 [이름, 값](before에서 읽은 시뮬레이터 시험 키, 시험 토큰 서명 개인키 d). 값은 어디에도 찍지 않는다 */
const literalSecrets = [];
/** 시험 전에 kind 노드에 이미 있던 실행 폴더와 이 PC 임시 폴더의 입력 폴더(이 시험이 만들지 않았으므로 남은 객체로 세지 않는다) */
let nodeDirsBefore = new Set();
let stagingBefore = new Set();

// ───────────── 작은 도구 ─────────────

const kc = (args, o = {}) => kubectl(args, { quiet: true, timeout: 90_000, ...o });
const readJson = (dir, file) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
const tail = (s, n = 3000) => String(s).slice(-n);
const firstLine = (err) => String(err?.stderr || err?.message || err).trim().split('\n')[0];
/** 요약 지표의 값 묶음(없으면 undefined) */
const metric = (summary, key) => summary.metrics?.[key]?.values;
/** 좌석·결제의 준비 구간 길이(초): 모두 진입·입장시키는 데 2 × ceil(users ÷ min(users, 200)) + 3초(실행 도구 계약) */
const prepSeconds = (users) => 2 * Math.ceil(users / Math.min(users, 200)) + 3;
/** KST 날짜(실행 ID 앞머리, run.mjs today와 같다) */
const kstDate = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const rmrf = (p) => rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
const filesUnder = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name));

/**
 * 프로세스 나무째 끝낸다. Windows는 taskkill /T /F(실행 도구가 띄운 kubectl 포트 전달·Chrome까지), 그 밖은 프로세스 묶음에 SIGKILL.
 * 어느 쪽이든 끊긴 프로세스의 정리(finally·신호 처리)는 돌지 않으므로 부른 쪽이 정리한다
 */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 30_000, windowsHide: true });
      return;
    } catch {
      // 이미 끝났거나 taskkill을 부르지 못했다. 그 프로세스만이라도 끝낸다
    }
    child.kill();
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * 명령 하나를 셸 없이 부른다. 출력은 그대로 시험 로그로 흘리고 모아 둔다. 한도를 넘으면 나무째 끊는다(정리는 부른 쪽이 한다).
 * 손자 프로세스가 출력 관을 쥐고 남아도 끝나게, 프로세스가 끝난 뒤 15초 안에 관이 닫히지 않으면 그대로 돌려준다
 */
function runProc(cmd, args, { killAfterMs, cwd = REPO } = {}) {
  return new Promise((done, fail) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    children.add(child);
    let stdout = '';
    let stderr = '';
    let killed = false;
    let settled = false;
    child.stdout.setEncoding('utf8').on('data', (c) => {
      stdout += c;
      process.stderr.write(c);
    });
    child.stderr.setEncoding('utf8').on('data', (c) => {
      stderr += c;
      process.stderr.write(c);
    });
    const timer = setTimeout(() => {
      killed = true;
      killTree(child);
    }, killAfterMs);
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      children.delete(child);
      done({ code: code ?? -1, signal, killed, stdout, stderr, ms: Date.now() - started });
    };
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      children.delete(child);
      fail(err);
    });
    child.on('exit', (code, signal) => setTimeout(() => finish(code, signal), 15_000).unref());
    child.on('close', (code, signal) => finish(code, signal));
  });
}

/** 실행 도구(node loadtest/run.mjs …). 한도에서 끊었으면 남은 것을 지운다 */
async function runCli(args, killAfterMs) {
  const r = await runProc(process.execPath, [CLI, ...args], { killAfterMs });
  if (r.killed && ready) await recover(`실행 도구를 ${Math.round(killAfterMs / 1000)}초 한도에서 끊음`);
  return r;
}

const exitMessage = (what, r, want) =>
  `${what}: 종료 코드 ${r.code}${r.killed ? `(한도에서 끊음, ${Math.round(r.ms / 1000)}초)` : ''}(${want}이어야 한다)\n${tail(r.stderr || r.stdout)}`;

/**
 * kind 노드 컨테이너 안 실행 폴더 뿌리(NODE_ROOT)의 항목. 뿌리가 없으면 빈 목록. docker는 셸 없이 부르고(이 PC의 셸 경로 변환을 타지 않는다),
 * 컨테이너 안 sh -c의 글은 고정 상수뿐이다
 */
function nodeRunDirs() {
  const out = execFileSync('docker', ['exec', KIND_NODE, 'sh', '-c', `if [ -d ${NODE_ROOT} ]; then ls -1A ${NODE_ROOT}; fi`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    windowsHide: true,
  });
  return out.split(/\r?\n/).filter(Boolean).sort();
}
const newNodeDirs = () => nodeRunDirs().filter((d) => !nodeDirsBefore.has(d));

/**
 * kind 노드 시계 − 이 PC 시계(ms)와 그 불확실성. 노드의 date(밀리초)를 docker exec로 세 번 읽어 왕복이 가장 짧은 것을 쓴다(왕복의 가운데 시각과
 * 견주고, 왕복의 절반을 불확실성으로 둔다). 셋 다 읽지 못하면 null. 검표 구간처럼 두 시계를 섞는 판정의 여유에 쓴다
 * @returns {{ offsetMs: number, uncertaintyMs: number } | null}
 */
function nodeClockOffset() {
  let best = null;
  for (let i = 0; i < 3; i++) {
    try {
      const t0 = Date.now();
      const out = execFileSync('docker', ['exec', KIND_NODE, 'date', '+%s%3N'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, windowsHide: true }).trim();
      const t1 = Date.now();
      if (!/^\d{13}$/.test(out)) continue;
      const s = { offsetMs: Math.round(Number(out) - (t0 + t1) / 2), uncertaintyMs: Math.ceil((t1 - t0) / 2) };
      if (best === null || s.uncertaintyMs < best.uncertaintyMs) best = s;
    } catch {
      // 다음 번에 다시 읽는다
    }
  }
  return best;
}
const tmpEntries = (re) => readdirSync(tmpdir()).filter((d) => re.test(d));
const newStagingDirs = () => tmpEntries(STAGING).filter((d) => !stagingBefore.has(d));

async function namespaceExists(ns) {
  return Boolean((await kc(['get', 'namespace', ns, '--ignore-not-found', '-o', 'name'])).trim());
}

/** 실행 잠금(ConfigMap loadtest-lock)의 { runTag, deadlineMs }. 없으면 null */
async function lockState() {
  if (!(await namespaceExists(LT))) return null;
  const text = (await kc(['-n', LT, 'get', 'configmap', LOCK, '--ignore-not-found', '-o', 'json'])).trim();
  if (!text) return null;
  const data = JSON.parse(text).data ?? {};
  return { runTag: String(data.runTag ?? ''), deadlineMs: Number(data.deadlineMs) };
}

/**
 * 실행이 남기면 안 되는 것: 네임스페이스 loadtest의 모든 파드(발생기·받는 파드·빈 응답 대역)와 Secret(시험 키·대역 TLS 키), 빈 응답 대역의
 * Deployment·Service·ConfigMap, 이 시험 동안 생긴 kind 노드 실행 폴더와 이 PC 임시 폴더의 발생기 입력 폴더(둘 다 토큰이 든다). 실행 잠금은 따로 본다
 */
async function leftovers() {
  const local = [...newNodeDirs().map((d) => `${KIND_NODE}:${NODE_ROOT}/${d}`), ...newStagingDirs().map((d) => join(tmpdir(), d))];
  if (!(await namespaceExists(LT))) return local.sort();
  const all = await kc(['-n', LT, 'get', 'pods,secrets', '-o', 'name']);
  const named = await kc(['-n', LT, 'get', `deployment/${NULL_TARGET_NAME}`, `service/${NULL_TARGET_NAME}`, `configmap/${NULL_TARGET_NAME}`, '--ignore-not-found', '-o', 'name']);
  return [...new Set(`${all}\n${named}`.split(/\s+/).filter(Boolean)), ...local].sort();
}

/** 지우는 중(Terminating)인 파드가 사라질 때까지 2분 기다린 뒤에도 남은 것이 있거나 실행 잠금이 풀리지 않았으면 실패 */
async function assertCleanedUp(what) {
  const end = Date.now() + 120_000;
  let left = await leftovers();
  let lock = await lockState();
  while ((left.length || lock) && Date.now() < end) {
    await sleep(3000);
    left = await leftovers();
    lock = await lockState();
  }
  assert.deepEqual(left, [], `${what}: 남은 것(네임스페이스 ${LT}의 객체, kind 노드 실행 폴더, 이 PC의 발생기 입력 폴더)`);
  assert.equal(lock, null, `${what}: 실행 잠금 ${LOCK}이 풀리지 않았다: ${JSON.stringify(lock)}`);
}

/** 실행 도구가 만드는 것(발생기·받는 파드, 빈 응답 대역, 시험 키 Secret, 실행 잠금)과 이 시험 동안 생긴 노드 실행 폴더·입력 폴더를 지운다. 실패는 적기만 한다 */
async function cleanupLoadtest(why) {
  const steps = [
    ['-n', LT, 'delete', 'pod', '-l', 'app.kubernetes.io/name in (loadgen,loadgen-delta)', '--ignore-not-found', '--grace-period=5', '--timeout=60s'],
    ['-n', LT, 'delete', `deployment/${NULL_TARGET_NAME}`, `service/${NULL_TARGET_NAME}`, `configmap/${NULL_TARGET_NAME}`, `secret/${NULL_TARGET_NAME}`, `secret/${SIM_KEY_SECRET}`, `configmap/${LOCK}`, '--ignore-not-found', '--timeout=60s'],
  ];
  for (const args of steps) {
    try {
      await kc(args);
    } catch (err) {
      console.log(`# ${why}: 정리 실패(${firstLine(err)})`);
    }
  }
  try {
    for (const d of newNodeDirs().filter((x) => /^[a-z0-9]{1,16}$/.test(x))) {
      execFileSync('docker', ['exec', KIND_NODE, 'rm', '-rf', '--', `${NODE_ROOT}/${d}`], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, windowsHide: true });
    }
  } catch (err) {
    console.log(`# ${why}: 노드 실행 폴더 정리 실패(${firstLine(err)})`);
  }
  for (const d of newStagingDirs()) rmrf(join(tmpdir(), d));
}

/** 끊긴 실행이 남긴 것을 실행 도구의 정리 명령(loadtest/README.md)으로 지우고(끊긴 입구도 되돌린다), 그 명령이 못 지운 것을 직접 지운다 */
async function recover(why) {
  console.log(`# ${why}: node loadtest/run.mjs cleanup으로 실행 잠금·발생기·받는 파드·실행 폴더·시험 키를 지우고 끊긴 입구를 되돌린다`);
  try {
    const r = await runProc(process.execPath, [CLI, 'cleanup'], { killAfterMs: 3 * MIN });
    if (r.code !== 0) console.log(`# ${why}: cleanup 종료 코드 ${r.code}`);
  } catch (err) {
    console.log(`# ${why}: cleanup을 부르지 못했다(${firstLine(err)})`);
  }
  await cleanupLoadtest(why);
}

/** 지금 Secret v0/pg-simulator의 시험 키(9번 시험이 v0를 다시 올리면 바뀐다). 읽지 못하면 null */
async function currentSimKey() {
  try {
    const key = Buffer.from((await kc(['-n', V0_NAMESPACE, 'get', 'secret', 'pg-simulator', '-o', 'jsonpath={.data.PG_SIMULATOR_SECRET_KEY}'])).trim(), 'base64').toString('utf8');
    return /^sim_sk_[A-Za-z0-9_-]{16,}$/.test(key) ? key : null;
  } catch {
    return null;
  }
}

/**
 * 산출물(폴더 아래 모든 파일과 따로 준 파일, .gz는 풀어서)과 실행 출력에 토큰 파일(users.json)·JWT·토큰 쿠키·시뮬레이터 시험 키·서명 개인키가 없다
 * (ASVS v5.0.0-13.3.1·14.2.4). 시험 키는 before에서 읽은 값과 지금 값 둘 다 찾는다
 */
async function assertNoSecrets(what, { dirs = [], files = [], texts = [] }) {
  const secrets = [...literalSecrets];
  const now = await currentSimKey();
  if (now && !secrets.some(([, v]) => v === now)) secrets.push(['시뮬레이터 시험 키(지금 값)', now]);
  const all = [...files.filter((f) => existsSync(f)), ...dirs.filter((d) => existsSync(d)).flatMap(filesUnder)];
  assert.deepEqual(
    all.filter((f) => basename(f).toLowerCase() === 'users.json'),
    [],
    `${what}: 토큰 파일 users.json이 산출물에 있다`,
  );
  const look = (where, text) => {
    for (const [name, re] of SECRET_PATTERNS) assert.ok(!re.test(text), `${what}: ${where}에 ${name}가 있다`);
    for (const [name, value] of secrets) assert.ok(!text.includes(value), `${what}: ${where}에 ${name}가 있다`);
  };
  for (const f of all) look(f, (f.endsWith('.gz') ? gunzipSync(readFileSync(f)) : readFileSync(f)).toString('latin1'));
  texts.forEach((text, i) => look(`실행 출력 ${i + 1}`, text));
}

/** 이 시험의 실행 폴더(아직 없어야 한다) */
function outDir(name) {
  const out = join(TMP, name);
  assert.equal(existsSync(out), false, `실행 폴더가 이미 있다: ${out}`);
  return out;
}

/** 실행 폴더 하나를 쓰는 시험 몸통. 통과하면 폴더를 지우고, 실패하면 원인을 보도록 남긴다(토큰이 없음은 몸통이 먼저 본다) */
async function withOut(name, body) {
  const out = outDir(name);
  let passed = false;
  try {
    const v = await body(out);
    passed = true;
    return v;
  } finally {
    if (passed) rmrf(out);
    else if (existsSync(out)) console.log(`# 실패한 시험의 실행 폴더를 남긴다: ${out}`);
  }
}

/** v0 DB(peaket-local의 PostgreSQL, DB v0)에 SQL 하나. 결과 한 칸을 글로 돌려준다. SQL에는 큰따옴표를 쓰지 않는다(Windows 인자 따옴표) */
async function v0Sql(sql) {
  return (await kc(['-n', 'peaket-local', 'exec', 'deploy/postgres', '--', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'v0', '-tAc', sql])).trim();
}

/** SQL 글자로 넣을 회차 ID(UUID만 받으므로 따옴표 탈출이 필요 없다). v0 표의 event_id는 글이라 소문자로 맞춰 견준다 */
function eventLiteral(eventId) {
  assert.match(eventId, UUID);
  return `'${eventId.toLowerCase()}'`;
}

/** v0 DB 누적 교착·롤백 수(pg_stat_database, DB v0) */
async function v0DbCounters() {
  const out = await v0Sql("select deadlocks || ',' || xact_rollback from pg_stat_database where datname = 'v0'");
  const m = /^(\d+),(\d+)$/.exec(out);
  assert.ok(m, `pg_stat_database(v0)의 deadlocks·xact_rollback을 읽지 못했다: ${out}`);
  return { deadlocks: Number(m[1]), rollbacks: Number(m[2]) };
}

/** 이 회차의 홀드(v0_hold): 수, 아직 HELD인 수, 홀드 하나의 좌석 수 최소·최대, 홀드한 좌석 ID(겹침 없이, 이 PC에서 정렬. DB 정렬 규칙에 기대지 않는다) */
async function eventHolds(eventId) {
  const e = eventLiteral(eventId);
  const h = JSON.parse(
    await v0Sql(
      `select json_build_object('holds', count(*), 'held', count(*) filter (where status = 'HELD'), 'minSize', min(cardinality(seat_ids)), 'maxSize', max(cardinality(seat_ids)), ` +
        `'seats', (select coalesce(json_agg(distinct u.s), '[]'::json) from v0_hold h2 cross join lateral unnest(h2.seat_ids) as u(s) where lower(h2.event_id) = ${e})) ` +
        `from v0_hold where lower(event_id) = ${e}`,
    ),
  );
  return { ...h, seats: [...h.seats].sort() };
}

/** 이 회차의 주문(v0_order): [{ id(소문자), status }] */
async function eventOrders(eventId) {
  return JSON.parse(
    await v0Sql(`select coalesce(json_agg(json_build_object('id', lower(o.order_id::text), 'status', o.status)), '[]'::json) from v0_order o where lower(o.event_id) = ${eventLiteral(eventId)}`),
  );
}

/** 입구 Deployment의 복제 수와 준비된 수 */
async function gatewayState(ns = V0_NAMESPACE) {
  const d = JSON.parse(await kc(['-n', ns, 'get', 'deploy/v0-gateway', '-o', 'json']));
  return { replicas: d.spec?.replicas ?? 0, ready: d.status?.readyReplicas ?? 0 };
}

/** 따옴표 칸을 아는 작은 CSV 읽기(검사기 report.ts의 cell 규칙, v0-rehearsal과 같다) */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const endRow = () => {
    row.push(cell);
    rows.push(row);
    row = [];
    cell = '';
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') {
        cell += c;
      } else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = false;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      endRow();
    } else if (c !== '\r') {
      cell += c;
    }
  }
  if (cell || row.length) endRow();
  return rows;
}

/** invariants.csv(검사기 형식) → { 불변식 ID: { result, violations(SKIPPED면 null) } } */
function invariantRows(dir) {
  const [header, ...rows] = parseCsv(readFileSync(join(dir, 'invariants.csv'), 'utf8'));
  assert.equal(header.join(','), 'id,name,sources,violations,unknown,result,as_of', 'invariants.csv 머리');
  const out = {};
  for (const r of rows) {
    const o = Object.fromEntries(header.map((h, i) => [h, r[i]]));
    assert.ok(['PASS', 'FAIL', 'SKIPPED'].includes(o.result), `${o.id}의 result: ${o.result}`);
    out[o.id] = { result: o.result, violations: o.result === 'SKIPPED' ? null : Number(o.violations) };
  }
  return out;
}

/** 줄마다 JSON 하나인 글 → 객체 목록(빈 줄은 건너뛴다). 읽지 못하는 줄이 있으면 실패(줄 번호) */
function parseNdjson(what, text) {
  const out = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) return;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      assert.fail(`${what} ${i + 1}번째 줄이 JSON이 아니다`);
    }
    assert.ok(o !== null && typeof o === 'object' && !Array.isArray(o), `${what} ${i + 1}번째 줄이 JSON 객체가 아니다`);
    out.push(o);
  });
  return out;
}

/** SHA256SUMS(`<sha256>  <상대 경로>` 줄) → Map(경로 → 해시) */
function readSums(runDir) {
  const sums = new Map();
  for (const line of readFileSync(join(runDir, 'SHA256SUMS'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    assert.ok(m, `SHA256SUMS 줄 꼴이 틀렸다: ${line.slice(0, 120)}`);
    sums.set(m[2], m[1]);
  }
  return sums;
}

/** loadtest/queries/v0.txt의 질의 이름(# 줄과 빈 줄을 뺀 `이름=질의`의 이름) */
function queryNames() {
  return readFileSync(QUERIES_V0, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => l.slice(0, l.indexOf('=')).trim());
}

/** 127.0.0.1:port에 TCP로 닿는가(무엇이 듣고 있는가) */
function portOpen(port) {
  return new Promise((done) => {
    const s = connect({ host: '127.0.0.1', port });
    let t;
    const finish = (v) => {
      clearTimeout(t);
      s.destroy();
      done(v);
    };
    t = setTimeout(() => finish(false), 3000);
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
  });
}

/** HTTP GET의 상태 코드(닿지 않으면 0) */
function httpStatus(url, timeoutMs = 3000) {
  return new Promise((done) => {
    const req = httpGet(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      done(res.statusCode ?? 0);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => done(0));
  });
}

/** Python 3를 부를 수 있는가(collect.py·nightly.py) */
function pythonOk() {
  try {
    return execFileSync(PYTHON, ['-I', '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', timeout: 30_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim() === '3';
  } catch {
    return false;
  }
}

/** 이 PC의 Playwright Chromium(seatmap-lab.mjs findChrome과 같은 자리, 가장 높은 판). 없으면 null */
function playwrightChrome() {
  const root = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  if (!process.env.LOCALAPPDATA || !existsSync(root)) return null;
  const dirs = readdirSync(root)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) {
    const exe = join(root, d, 'chrome-win64', 'chrome.exe');
    if (existsSync(exe)) return exe;
  }
  return null;
}

/**
 * 명령줄에 pattern(이 파일의 고정 글)이 든 프로세스 [{ pid, cmd }](이 PowerShell 자신은 뺀다). Windows가 아니거나 PowerShell을 부르지 못하면 null.
 * 명령줄에 줄바꿈이 있을 수 있어 PowerShell이 JSON 한 줄로 낸다
 */
function processesLike(pattern) {
  if (process.platform !== 'win32') return null;
  if (!/^[A-Za-z0-9:/._-]{1,64}$/.test(pattern)) throw new RangeError(`프로세스를 찾는 글이 틀렸다: ${pattern}`);
  const script = `@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${pattern}*' } | Select-Object ProcessId, CommandLine) | ConvertTo-Json -Compress -Depth 2`;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!out) return [];
    const v = JSON.parse(out);
    return (Array.isArray(v) ? v : [v]).map((p) => ({ pid: Number(p.ProcessId), cmd: String(p.CommandLine ?? '') }));
  } catch {
    return null;
  }
}

/** before에 없던 프로세스 가운데 needles를 모두 명령줄에 가진 것의 PID(목록을 못 읽으면 null) */
function newProcesses(beforeList, pattern, needles = []) {
  const now = processesLike(pattern);
  if (now === null || beforeList === null) return null;
  const old = new Set(beforeList.map((p) => p.pid));
  return now.filter((p) => !old.has(p.pid) && needles.every((n) => p.cmd.includes(n))).map((p) => p.pid);
}

/**
 * 일정 도착률 구간의 요청 수(v0-rehearsal과 같은 규칙): 도착률 실행기는 구간마다 반복을 도착률 × 길이번, 경계에서 한 번 더(+1)까지 시작하고
 * 놓친 반복(dropped)은 빠진다. 그래서 [계획 − 1 − dropped, 계획 + 구간 수]다
 */
function assertArrivalCount(at, got, expected, dropped, phases = 1) {
  assert.ok(
    Number.isSafeInteger(got) && got <= expected + phases && got >= expected - 1 - dropped,
    `${at}: ${got}건(계획 ${expected}건, 허용 ${expected - 1 - dropped}~${expected + phases}건, 놓친 반복 ${dropped}건)`,
  );
}

/**
 * ramping-arrival-rate가 단계 동안 시작하는 반복 수(사다리꼴 넓이의 합, v0-rehearsal과 같다)
 */
function plannedIterations({ startRate, stages }) {
  let prev = startRate;
  let sum = 0;
  for (const { target, duration } of stages) {
    const s = Number(/^(\d+)s$/.exec(duration)?.[1]);
    assert.ok(s > 0, `pollStages 단계 길이 꼴: ${duration}`);
    sum += ((prev + target) / 2) * s;
    prev = target;
  }
  return sum;
}

/**
 * 본구간 경로 지표: 경로별 본구간 요청 수의 합이 본구간 요청 수와 같고, 요청이 있는 경로는 allowed 안이다(준비 구간 요청이 섞이지 않았다).
 * 경로 → 본구간 요청 수를 돌려준다(v0-rehearsal과 같다)
 */
function assertMainRoutes(at, summary, allowed) {
  const main = metric(summary, 'http_reqs')?.count;
  const byRoute = {};
  for (const [k, v] of Object.entries(summary.metrics)) {
    const m = /^http_reqs\{phase:main,route:([a-z][a-z_]{0,31})\}$/.exec(k);
    if (m) byRoute[m[1]] = v.values?.count ?? 0;
  }
  const sum = Object.values(byRoute).reduce((a, b) => a + b, 0);
  assert.equal(sum, main, `${at}: 경로별 본구간 요청 수의 합(${JSON.stringify(byRoute)})이 본구간 요청 수 ${main}와 다르다`);
  const extra = Object.entries(byRoute)
    .filter(([r, n]) => n > 0 && !allowed.includes(r))
    .map(([r, n]) => `${r}:${n}`);
  assert.deepEqual(extra, [], `${at}: 본구간에 있으면 안 되는 경로(준비 구간 요청이 섞였다)`);
  return byRoute;
}

/**
 * 발생기 하나의 지표(generator.json each[i])가 계약대로 지어졌는지(v0-rehearsal과 같다): 구간 표시가 본구간 길이와 맞고, cgroup 표본은 본구간에서
 * 양 끝 1초씩 뺀 창의 1초 표본이며, 메모리 %는 한도(memoryMi MiB) 대비이고, CPU 평균 ≤ 최대, 가상 사용자당 메모리 = perVuBytes(lib)
 */
function assertGeneratorStats(at, { stats, marks, vusMax, perVuBytes }, { memoryMi, mainS }) {
  for (const k of ['cpuMeanPct', 'cpuMaxPct', 'memMaxPct', 'memMaxBytes', 'samples']) assert.ok(Number.isFinite(stats?.[k]), `${at} stats.${k}: ${stats?.[k]}`);
  assert.ok(Number.isSafeInteger(marks?.main_start) && Number.isSafeInteger(marks?.main_end), `${at} 구간 표시: ${JSON.stringify(marks)}`);
  const windowMs = marks.main_end - marks.main_start;
  assert.ok(windowMs >= mainS * 1000 - 1500 && windowMs <= mainS * 1000 + 10_000, `${at}: 구간 표시 사이 ${windowMs}ms가 본구간 ${mainS}초와 맞지 않는다`);
  const windowS = windowMs / 1000;
  assert.ok(stats.samples >= Math.max(2, Math.floor((windowS - 2) / 2)), `${at}: 발생기 표본 ${stats.samples}개가 본구간 ${windowS}초에 비해 너무 적다(1초마다 하나)`);
  assert.ok(stats.samples <= Math.ceil(windowS), `${at}: 발생기 표본 ${stats.samples}개가 본구간 ${windowS}초보다 많다(본구간 밖 표본이 섞였다)`);
  assert.ok(stats.cpuMeanPct >= 0 && stats.cpuMeanPct <= stats.cpuMaxPct + 0.1, `${at}: CPU 평균 ${stats.cpuMeanPct}%가 0 이상 최대 ${stats.cpuMaxPct}% 이하가 아니다`);
  assert.ok(stats.memMaxBytes > 0, `${at} memMaxBytes: ${stats.memMaxBytes}`);
  const memPct = Math.round((stats.memMaxBytes / (memoryMi * 1024 * 1024)) * 1000) / 10;
  assert.ok(Math.abs(stats.memMaxPct - memPct) <= 0.1, `${at}: memMaxPct ${stats.memMaxPct}가 memMaxBytes ÷ 한도 ${memoryMi}Mi = ${memPct}%가 아니다`);
  assert.ok(Number.isSafeInteger(vusMax) && vusMax >= 1, `${at} vusMax: ${vusMax}`);
  assert.equal(perVuBytes, perVuBytesOf({ memMaxBytes: stats.memMaxBytes, vusMax }), `${at}: perVuBytes가 memMaxBytes ÷ vusMax(올림)가 아니다`);
}

/**
 * generator.json(발생기 여럿을 합친 꼴, docs/verification.md §3.10 '발생기 나누기'): 발생기마다 몫·지표·판정(each), 놓친 반복·시나리오 오류·
 * 가상 사용자는 더하고 CPU·메모리는 가장 높은 값, 판정은 하나라도 무효면 무효(사유에 발생기 번호), 시작 차이 = 발생기 시작 초의 최대 − 최소,
 * 모든 발생기가 같은 본구간 창(구간 표시)을 쓴다. loadStartMs는 실행 시각(run.json, 이 PC 시계) 사이다
 */
function assertCombinedGenerator(at, gen, summary, run, { generators, cpus, memoryMi, mainS }) {
  assert.equal(gen.generators, generators, `${at}: generator.json generators`);
  assert.ok(Array.isArray(gen.each) && gen.each.length === generators, `${at}: generator.json each가 발생기마다 하나(${generators}개)가 아니다: ${gen.each?.length}`);
  const marks = gen.each[0].marks;
  gen.each.forEach((g, i) => {
    const gi = `${at} 발생기 ${i}`;
    assert.equal(g.cpus, cpus, `${gi} cpus`);
    assert.equal(g.memoryMi, memoryMi, `${gi} memoryMi`);
    assertGeneratorStats(gi, g, { memoryMi, mainS });
    assert.deepEqual(g.marks, marks, `${gi}: 구간 표시가 다른 발생기와 다르다(모든 발생기가 같은 본구간 창을 써야 한다)`);
    assert.ok(isCount(g.dropped) && isCount(g.scenarioErrors), `${gi}: dropped ${g.dropped}·scenarioErrors ${g.scenarioErrors}`);
    assert.deepEqual(
      g.judge,
      withScenarioErrors(judgeGenerator({ dropped: g.dropped, cpuMeanPct: g.stats.cpuMeanPct, memMaxPct: g.stats.memMaxPct }), g.scenarioErrors),
      `${gi}: 판정이 적힌 숫자(놓친 반복·CPU·메모리·시나리오 오류)와 맞지 않는다`,
    );
  });
  const sum = (k) => gen.each.reduce((s, g) => s + g[k], 0);
  const max = (f) => Math.max(...gen.each.map(f));
  assert.equal(gen.dropped, sum('dropped'), `${at}: dropped가 발생기마다의 합이 아니다`);
  assert.equal(gen.dropped, metric(summary, 'dropped_iterations')?.count ?? 0, `${at}: generator.json dropped ≠ 요약의 dropped_iterations`);
  assert.equal(gen.scenarioErrors, sum('scenarioErrors'), `${at}: scenarioErrors가 발생기마다의 합이 아니다`);
  assert.equal(gen.vusMax, sum('vusMax'), `${at}: vusMax가 발생기마다의 합이 아니다`);
  assert.equal(gen.cpuMeanPctMax, max((g) => g.stats.cpuMeanPct), `${at}: cpuMeanPctMax`);
  assert.equal(gen.cpuMaxPctMax, max((g) => g.stats.cpuMaxPct), `${at}: cpuMaxPctMax`);
  assert.equal(gen.memMaxPctMax, max((g) => g.stats.memMaxPct), `${at}: memMaxPctMax`);
  const reasons = gen.each.flatMap((g, i) => g.judge.reasons.map((r) => (generators > 1 ? `발생기 ${i}: ${r}` : r)));
  // 변경분 연결 측정(K4)은 받는 파드 쪽 무효 사유('변경분: …', runner/probes.mjs deltaJudge)를 합친 판정 끝에 더한다(발생기마다의 판정에는 없다)
  const deltaReasons = gen.judge.reasons.filter((r) => r.startsWith('변경분: '));
  const all = [...reasons, ...deltaReasons];
  assert.deepEqual(gen.judge, { valid: all.length === 0, reasons: all }, `${at}: 합친 판정은 발생기마다의 판정을 모은 것(과 변경분 사유)이어야 한다`);
  const ownJudge = { valid: reasons.length === 0, reasons };
  if (generators > 1) {
    const starts = gen.each.map((g) => g.startedS);
    assert.ok(starts.every((s) => Number.isSafeInteger(s) && s > 0), `${at}: 발생기마다 시작 시각(startedS, 유닉스 초)이 있어야 한다: ${JSON.stringify(starts)}`);
    assert.equal(gen.startSkewS, Math.max(...starts) - Math.min(...starts), `${at}: startSkewS가 발생기 시작 초의 최대 − 최소가 아니다`);
  } else {
    assert.equal(gen.startSkewS, 0, `${at}: 발생기 하나면 시작 차이는 0이다`);
    // 발생기가 하나면 예전 모양(BSL-060)의 칸을 맨 위에 그대로 둔다(loadtest/e2e/v0-rehearsal.e2e.mjs·nightly/k6-run.mjs가 읽는다, run.mjs combineGenerators)
    const legacy = ['cpus', 'memoryMi', 'stats', 'marks', 'vusMax', 'perVuBytes', 'dropped', 'scenarioErrors', 'judge'];
    assert.deepEqual(
      Object.fromEntries(legacy.map((k) => [k, k === 'judge' ? ownJudge : gen[k]])),
      Object.fromEntries(legacy.map((k) => [k, gen.each[0][k]])),
      `${at}: 발생기 하나인데 generator.json 맨 위의 예전 칸(${legacy.join('·')})이 each[0]과 다르다(v0-rehearsal이 읽는 꼴)`,
    );
  }
  const startedMs = Date.parse(run.startedAt);
  const endedMs = Date.parse(run.endedAt);
  assert.ok(Number.isSafeInteger(gen.loadStartMs) && gen.loadStartMs >= startedMs && gen.loadStartMs <= endedMs, `${at}: loadStartMs ${gen.loadStartMs}가 실행 시각 ${run.startedAt} ~ ${run.endedAt} 사이가 아니다`);
}

/**
 * 경로 목표 점검 파일(checks.json, docs/verification.md §3.10 '경로 목표 점검'): 본구간 요약(합친 것)으로 checksFromSummary가 만든 점검과 같고
 * (발생기를 나눠도 시행·어긴 수는 더한 값이다), --prom-url이면 끝에 대기 상태의 서버 히스토그램 점검과 지연 대조가 붙는다. 점검이 없으면 파일도 없다
 */
function assertChecksFile(at, out, summary, scenario, { promUrl = false } = {}) {
  // 대기열 진입은 예열 앞 진입 구간(phase:prep)을 센다. 검표 p95는 실행 도구가 검표 시도 줄로 온라인 구간만 세므로(5번 시험이 따로 본다)
  // 요약으로 다시 세는 대조에서 뺀다(docs/verification.md §3.10 '경로 목표 점검', 2026-11-03 시험 검토·새 맥락 리뷰)
  const fromSummary = checksFromSummary(summary, ROUTES[scenario], CHECK_PHASES[scenario] ?? {});
  const isScan = (c) => scenario === 'gate' && c.name.startsWith('scan_p95_');
  const kept = (fromSummary?.checks ?? []).filter((c) => !isScan(c));
  const want = kept.length || (scenario === 'gate' && fromSummary) ? { checks: kept } : null;
  const file = join(out, 'checks.json');
  if (want === null) {
    assert.equal(existsSync(file), false, `${at}: 점검할 경로 요청이 없는데 checks.json이 있다`);
    return null;
  }
  assert.ok(existsSync(file), `${at}: checks.json이 없다`);
  const got = readJson(out, 'checks.json');
  assert.deepEqual(
    got.checks.filter((c) => !c.histogram && !isScan(c)),
    want.checks,
    `${at}: checks.json의 경로 점검(시행·어긴 수)이 본구간 요약과 맞지 않는다`,
  );
  const server = got.checks.filter((c) => c.histogram);
  if (promUrl) {
    assert.deepEqual(
      server.map((c) => c.name),
      [QUEUE_SERVER_CHECK.name],
      `${at}: --prom-url이면 서버 히스토그램 점검 ${QUEUE_SERVER_CHECK.name}이 붙어야 한다`,
    );
    assert.equal(server[0].histogram.le, QUEUE_SERVER_CHECK.targetMs / 1000, `${at}: 서버 점검의 칸 경계는 목표 시간(초)이다`);
    assert.deepEqual(got.crosscheck, { check: QUEUE_SERVER_CHECK.name, k6_metric: QUEUE_SERVER_CHECK.k6Metric }, `${at}: 지연 대조(crosscheck)`);
  } else {
    assert.deepEqual(server, [], `${at}: --prom-url 없이 서버 점검이 있다`);
    assert.equal(got.crosscheck, undefined, `${at}: --prom-url 없이 지연 대조가 있다`);
  }
  return got;
}

/**
 * v0 실행 하나의 공통 산출물: 종료 코드 0, 파일(나눴으면 발생기마다 k6-g<i>.log·cgroup-g<i>.log·console-g<i>.ndjson), run.json·summary.json·
 * generator.json의 꼴과 서로 맞음(요약은 본구간 값이고 준비 구간 요청은 전체 값에만 있음), notes.txt·infra.txt의 발생기 대수, checks.json
 * @param {{ scenario: string, generators: number, cpus: number, memoryMi: number, prepS: number, warmS: number, mainS: number, prepMinReqs: number, requireValid?: boolean, promUrl?: boolean }} P
 */
function assertRunCommon(name, out, r, P) {
  assert.equal(r.code, 0, exitMessage(name, r, 0));
  const suffixes = P.generators > 1 ? Array.from({ length: P.generators }, (_, i) => `-g${i}`) : [''];
  const files = ['run.json', 'summary.json', 'generator.json', 'records.ndjson', 'infra.txt', 'notes.txt', ...suffixes.flatMap((s) => [`k6${s}.log`, `cgroup${s}.log`, `console${s}.ndjson`])];
  for (const f of files) assert.ok(existsSync(join(out, f)), `${name}: ${f}가 없다`);
  for (const f of ['infra.txt', 'notes.txt', ...suffixes.map((s) => `cgroup${s}.log`)]) assert.ok(readFileSync(join(out, f), 'utf8').trim().length > 0, `${name}: ${f}가 비었다`);

  const run = readJson(out, 'run.json');
  assert.equal(run.scenario, P.scenario, `${name}: run.json scenario`);
  assert.match(run.eventId, UUID);
  assert.match(run.runTag, /^[a-z0-9]{1,16}$/);
  assert.equal(run.namespace, V0_NAMESPACE, `${name}: run.json namespace`);
  assert.ok([0, 99].includes(run.k6Exit), `${name}: run.json k6Exit ${run.k6Exit}`);
  assert.equal(run.exitCode, r.code, `${name}: run.json exitCode가 실행 도구 종료 코드와 다르다`);
  const runMs = Date.parse(run.endedAt) - Date.parse(run.startedAt);
  assert.ok(runMs >= (P.prepS + P.warmS + P.mainS) * 1000, `${name}: 실행 시각 사이 ${runMs}ms가 준비·예열·본구간 합 ${(P.prepS + P.warmS + P.mainS) * 1000}ms보다 짧다`);

  const summary = readJson(out, 'summary.json');
  for (const k of ['metrics', 'root_group', 'options', 'state']) assert.ok(k in summary, `${name}: summary.json에 ${k}가 없다`);
  const mainReqs = metric(summary, 'http_reqs')?.count;
  assert.ok(mainReqs > 0, `${name}: 본구간 요청 수 ${mainReqs}`);
  assert.equal(metric(summary, 'http_reqs{phase:main}')?.count, mainReqs, `${name}: summary.json http_reqs가 본구간 값(http_reqs{phase:main})이 아니다`);
  for (const k of ['http_req_duration_all', 'http_req_failed_all', 'http_reqs_all', 'dropped_iterations']) assert.ok(summary.metrics[k], `${name}: summary.json에 ${k}가 없다`);
  const allReqs = metric(summary, 'http_reqs_all')?.count;
  assert.ok(allReqs - mainReqs >= P.prepMinReqs, `${name}: 전체 요청 ${allReqs} − 본구간 ${mainReqs}가 준비 구간 최소 ${P.prepMinReqs}건보다 적다`);
  if (P.generators > 1) {
    assert.equal(summary.merge?.generators, P.generators, `${name}: 합친 요약의 merge.generators`);
    assert.ok(summary.merge.bounds !== null && typeof summary.merge.bounds === 'object' && Array.isArray(summary.merge.unmerged), `${name}: merge.bounds·unmerged`);
  } else {
    assert.equal(summary.merge, undefined, `${name}: 발생기 하나인데 합친 요약(merge)이 있다`);
  }

  const gen = readJson(out, 'generator.json');
  assertCombinedGenerator(name, gen, summary, run, P);
  if (P.requireValid !== false) assert.equal(gen.judge.valid, true, `${name}: 작은 실행인데 발생기 판정이 무효다: ${gen.judge.reasons.join('; ')}`);

  const notes = readFileSync(join(out, 'notes.txt'), 'utf8');
  assert.ok(notes.includes(`발생기 ${P.generators}대`), `${name}: notes.txt에 발생기 대수가 없다: ${notes.slice(0, 200)}`);
  const infra = readFileSync(join(out, 'infra.txt'), 'utf8');
  assert.ok(infra.includes(`파드 ${P.generators}대(CPU ${P.cpus}·메모리 ${P.memoryMi}Mi씩`), `${name}: infra.txt에 발생기 파드 대수·몫이 없다`);
  assertChecksFile(name, out, summary, P.scenario, { promUrl: P.promUrl });
  console.log(`# ${name}: ${Math.round(r.ms / 1000)}초, 본구간 요청 ${mainReqs}(전체 ${allReqs}), 발생기 ${gen.generators}대 CPU 평균 최고 ${gen.cpuMeanPctMax}%·메모리 최대 ${gen.memMaxPctMax}%, 시작 차이 ${gen.startSkewS}초, 판정 ${JSON.stringify(gen.judge)}`);
  return { run, summary, gen, notes };
}

/**
 * K10 끊김(O-T1의 v0 한계)을 검표 시도 줄(kind 노드 시계)과 gate.json으로 본다. 입구를 0개로 줄이고 강제로 끝내는 명령이 돌아온 뒤(cutTimes.startMs,
 * 이 PC 시계)에도 입구 파드가 실제로 죽기까지와 두 시계 차이 동안은 판정이 몇 건 날 수 있어 graceMs를 둔다:
 * ① 온라인 동안 판정이 있고 끊긴 동안 시도가 있다 ② 끊긴 때 + graceMs 뒤에 시작해 되돌리기 전까지 판정받은 시도가 없다(끊긴 동안 처리량 ≈ 0)
 * ③ 끊긴 동안 판정 수 ≤ 그 여유 동안 시작할 수 있는 수(⌈도착률 × 여유⌉ + 1), 끊김/온라인 분당 판정 비율 ≤ OFFLINE_RATIO_MAX
 * ④ 되돌린 뒤 판정이 있다 ⑤ 판정이 멈춘 가장 긴 시간 ≥ 끊긴 길이(복구는 입구가 준비될 때까지라 멈춘 시간에 든다)
 * 돌려주는 값: 끊긴 동안 판정받은 시도의 시작(끊긴 때 기준 ms, 로그용)
 */
function assertGateCut(at, gate, probes, marks, { rate, cutS, graceMs }) {
  const ct = gate.cutTimes;
  const inWin = probes.filter((p) => p.startedMs >= marks.main_start && p.startedMs < marks.main_end);
  const judgedInCut = inWin.filter((p) => p.ok && p.startedMs >= ct.startMs && p.startedMs < ct.endMs).map((p) => p.startedMs - ct.startMs);
  const fmt = (ms) => `${(ms / 1000).toFixed(2)}초`;
  const ctx = `끊긴 동안 판정 ${gate.cut.judged}건/시도 ${gate.cut.attempts}건, 판정받은 시도의 시작(끊긴 때 기준) ${judgedInCut.map(fmt).join(', ') || '없음'}, 끊는 명령 → 끊김 ${ct.startMs - ct.issuedMs}ms, 여유 ${graceMs}ms`;
  assert.ok(gate.online.judged > 0, `${at}: 온라인 동안 판정이 없다: ${JSON.stringify(gate.online)}`);
  assert.ok(gate.cut.attempts > 0, `${at}: 끊긴 동안 검표 시도가 없다(끊긴 구간이 본구간 안이 아니다): ${JSON.stringify(gate.cut)}`);
  assert.deepEqual(
    judgedInCut.filter((d) => d >= graceMs).map(fmt),
    [],
    `${at}: 끊긴 때 ${graceMs}ms 뒤에 시작한 시도가 되돌리기 전에 판정을 받았다(입구를 끊지 못했다). ${ctx}`,
  );
  const maxJudged = Math.ceil((rate * graceMs) / 1000) + 1;
  assert.ok(gate.cut.judged <= maxJudged, `${at}: 끊긴 동안 판정 ${gate.cut.judged}건이 여유 동안 시작할 수 있는 ${maxJudged}건보다 많다. ${ctx}`);
  assert.ok(
    Number.isFinite(gate.offlineRatio) && gate.offlineRatio >= 0 && gate.offlineRatio <= OFFLINE_RATIO_MAX,
    `${at}: 끊김/온라인 분당 판정 비율 ${gate.offlineRatio}가 0~${OFFLINE_RATIO_MAX}가 아니다(끊긴 동안 처리량 ≈ 0이어야 한다). ${ctx}`,
  );
  assert.ok(gate.restored.judged > 0, `${at}: 되돌린 뒤 판정이 없다(입구가 본구간 안에 준비되지 않았다): ${JSON.stringify(gate.restored)}`);
  assert.ok(gate.maxGapS >= cutS, `${at}: 판정이 멈춘 가장 긴 시간 ${gate.maxGapS}초가 끊긴 길이 ${cutS}초보다 짧다(끊긴 동안 판정이 이어졌다). ${ctx}`);
  return judgedInCut;
}

/** db-stats.json(K3 '재는 것': 교착·롤백·표별 갱신 수와 HOT 갱신 비율·죽은 행, runner/probes.mjs dbStatsDelta의 꼴) */
function assertDbStats(at, db, { mainS }) {
  assert.ok(db !== null && typeof db === 'object', `${at}: db-stats.json이 객체가 아니다`);
  for (const k of ['durationS', 'deadlocks', 'commits', 'rollbacks', 'tables']) assert.ok(k in db, `${at}: db-stats.json에 ${k}가 없다`);
  assert.ok(Number.isFinite(db.durationS) && db.durationS >= mainS, `${at}: 실행 전·후 통계 사이 ${db.durationS}초가 본구간 ${mainS}초보다 짧다`);
  for (const k of ['deadlocks', 'commits', 'rollbacks']) assert.ok(isCount(db[k]), `${at}: ${k}는 0 이상 정수다: ${db[k]}`);
  assert.ok(db.commits > 0, `${at}: 실행 동안 커밋이 없다(통계를 같은 DB에서 읽지 않았다)`);
  const names = Object.keys(db.tables ?? {});
  assert.deepEqual(names, [...names].sort(), `${at}: 표는 이름 순이다`);
  assert.ok(
    names.every((n) => /^v0_[a-z0-9_]+$/.test(n)),
    `${at}: v0 표(v0_…)만 있어야 한다: ${names.join(', ')}`,
  );
  for (const t of ['v0_hold', 'v0_seat']) assert.ok(names.includes(t), `${at}: 표 ${t}가 없다: ${names.join(', ')}`);
  for (const [t, v] of Object.entries(db.tables)) {
    for (const k of ['inserts', 'updates', 'hotUpdates', 'deletes', 'liveRows', 'deadRows']) assert.ok(isCount(v?.[k]), `${at}: ${t}.${k}는 0 이상 정수다: ${v?.[k]}`);
    assert.ok('hotRatio' in v, `${at}: ${t}에 hotRatio가 없다`);
    assert.ok(v.hotUpdates <= v.updates, `${at}: ${t}의 HOT 갱신 ${v.hotUpdates}이 갱신 ${v.updates}보다 많다`);
    assert.equal(v.hotRatio, v.updates === 0 ? null : Math.round((v.hotUpdates / v.updates) * 10000) / 10000, `${at}: ${t}.hotRatio는 HOT 갱신 ÷ 갱신(소수 넷째 자리, 갱신 0이면 null)이다`);
  }
}

// ───────────── 준비·정리 ─────────────

before(
  async () => {
    for (const d of ['v0-gateway', 'v0-monolith', 'pg-simulator']) {
      try {
        await kc(['-n', V0_NAMESPACE, 'rollout', 'status', `deploy/${d}`, '--timeout=120s'], { timeout: 150_000 });
      } catch (err) {
        throw new Error(`클러스터 peaket에 v0가 준비되지 않았다(deploy/${d}: ${firstLine(err)}). 먼저 node tools/local/cluster.mjs up && node tools/local/cluster.mjs v0`);
      }
    }
    const gw = await gatewayState();
    if (gw.replicas < 1 || gw.ready !== gw.replicas) {
      throw new Error(`v0 입구가 복제 ${gw.replicas}개(준비 ${gw.ready}개)다. 끊긴 K10 실행이 남긴 것이면 node loadtest/run.mjs cleanup으로 되돌린 뒤 다시 돌린다`);
    }
    // kind 노드의 실행 폴더와 이 PC의 입력 폴더: 지금 있는 것은 이 시험이 만들지 않았다(토큰이 들 수 있어 이름만 적는다)
    try {
      nodeDirsBefore = new Set(nodeRunDirs());
    } catch (err) {
      throw new Error(`kind 노드 컨테이너 ${KIND_NODE}에 docker exec로 닿지 못했다(${firstLine(err)}). Docker 엔진과 클러스터 peaket을 먼저 올린다`);
    }
    stagingBefore = new Set(tmpEntries(STAGING));
    if (nodeDirsBefore.size) console.log(`# 알림: ${KIND_NODE}:${NODE_ROOT}에 지난 실행 폴더가 있다(첫 실행의 쓸어 내기가 지운다): ${[...nodeDirsBefore].join(', ')}`);
    // 다른 부하 실행(측정)이 돌고 있으면 멈춘다. 이 파일의 K5 랩·야간 비교 준비 명령은 실행 잠금을 잡지 않아 돌고 있는 측정을 망가뜨린다
    const lock = await lockState();
    if (lock && Number.isFinite(lock.deadlineMs) && lock.deadlineMs > Date.now()) {
      throw new Error(`다른 부하 실행(${lock.runTag})이 실행 잠금 ${LOCK}을 쥐고 있다(마감 ${new Date(lock.deadlineMs).toISOString()}). 끝난 뒤에, 강제로 끝난 실행이면 node loadtest/run.mjs cleanup 뒤에 다시 돌린다`);
    }
    if (lock) console.log(`# 알림: 마감이 지난 실행 잠금(${lock.runTag})이 있다(첫 실행이 지운다)`);
    const left = await leftovers();
    if (left.length) {
      throw new Error(
        `네임스페이스 ${LT}에 이미 객체가 있다: ${left.join(', ')}. 다른 부하 실행이 돌고 있으면 끝난 뒤에, 아니면 지난 실행이 남긴 것이므로 ` +
          `node loadtest/run.mjs cleanup(또는 kubectl --kubeconfig ${KUBECONFIG} -n ${LT} delete …) 뒤에 다시 돌린다`,
      );
    }
    // 산출물에서 글자 그대로 찾을 비밀 값. 읽지 못해도 값이나 그 일부를 메시지에 싣지 않는다
    const simKey = await currentSimKey();
    if (!simKey) throw new Error('Secret v0/pg-simulator에서 시뮬레이터 시험 키를 읽지 못했다(node tools/local/cluster.mjs v0를 다시 돌린다)');
    if (!existsSync(V0_TOKEN_KEY_FILE)) throw new Error(`시험 토큰 서명 키 파일이 없다: ${V0_TOKEN_KEY_FILE} (node tools/local/cluster.mjs v0가 만든다)`);
    let d;
    try {
      d = JSON.parse(readFileSync(V0_TOKEN_KEY_FILE, 'utf8')).d;
    } catch {
      throw new Error(`시험 토큰 서명 키 파일을 JSON으로 읽지 못했다: ${V0_TOKEN_KEY_FILE}`);
    }
    if (typeof d !== 'string' || d.length < 40) throw new Error(`시험 토큰 서명 키 파일에 개인키 칸(d)이 없다: ${V0_TOKEN_KEY_FILE}`);
    literalSecrets.push(['시뮬레이터 시험 키(시험 시작 때 값)', simKey], ['시험 토큰 서명 개인키(d)', d]);

    TMP = mkdtempSync(join(tmpdir(), 'peaket-bsl090-e2e-'));
    console.log(`# 실행 폴더: ${TMP}`);
    ready = true;
  },
  { timeout: 10 * MIN },
);

after(
  async () => {
    for (const c of children) killTree(c);
    if (!ready) return;
    const left = await leftovers().catch(() => []);
    const lock = await lockState().catch(() => null);
    const gw = await gatewayState().catch(() => null);
    if (left.length || lock || (gw && gw.replicas === 0)) {
      console.log(`# 끝 정리: 남은 것 ${left.join(', ') || '없음'}, 실행 잠금 ${lock ? lock.runTag : '없음'}, 입구 복제 ${gw?.replicas ?? '?'}`);
      await recover('끝 정리');
    }
    if (existsSync(TMP) && readdirSync(TMP).length === 0) rmrf(TMP);
    else if (existsSync(TMP)) console.log(`# 실패한 시험의 실행 폴더가 남았다: ${TMP}`);
  },
  { timeout: 8 * MIN },
);

// ───────────── 시험 ─────────────

test('BSL090_NFR-013_나눈발생기_v0대기열을발생기둘로나눠_두파드가시작파일로함께시작하고(시작차이2초미만)_요청수·놓친반복은더하고p99는아래·위한계로합치며_진입을겹치지않게나눠보내고_점검파일은합친요약으로만든다', opts(MINUTES.split), async () => {
  await withOut('split', async (out) => {
    // --settle: 이 파일 앞에 돈 부하로 HPA가 앱 복제를 늘렸으면 본구간 동안 줄이며 앱 파드를 끝내 조회가 실패할 수 있다(아래 실패율 0을 본다)
    const argv = ['v0', 'queue', ...queueArgs(), '--generators', '2', '--settle', '--out', out];
    // 시험이 고른 인자가 계약(args.mjs)으로 맞는지 먼저 본다. --cpus·--memory-mi를 주지 않아 나눈 발생기의 기본 몫(CPU 2·1GiB)을 쓴다
    const a = parseArgs(argv);
    assert.deepEqual({ generators: a.generators, cpus: a.cpus, memoryMi: a.memoryMi, settle: a.settle }, { generators: 2, cpus: DEFAULTS.cpus, memoryMi: DEFAULTS.memoryMi, settle: true }, '시험 인자');
    const r = await runCli(argv, killAfter(MINUTES.split));
    const entryS = Math.ceil(Q.users / Q.entryRate);
    const { run, summary, gen } = assertRunCommon('split', out, r, { scenario: 'queue', generators: 2, ...SPLIT_GEN, prepS: entryS, warmS: Q.warmS, mainS: Q.mainS, prepMinReqs: Q.users });

    // 함께 시작: 모든 파드가 준비된 뒤 시작 파일을 한 번 놓는다(시작 시각은 유닉스 초라 차이는 0이나 1이다)
    assert.ok(gen.startSkewS < 2, `발생기 사이 시작 차이 ${gen.startSkewS}초가 2초 이상이다(시작 파일로 함께 시작하지 않았다)`);
    assert.equal(gen.dropped, 0, '이 작은 도착률에서 놓친 반복이 있다');

    // 합친 요약: trend는 발생기별 값의 [아래, 위] 한계를 bounds에 두고 값은 위 한계(나쁜 쪽)다
    for (const key of ['http_req_duration{phase:main,route:status}', 'http_req_duration']) {
      const b = summary.merge.bounds[key]?.['p(99)'];
      assert.ok(Array.isArray(b) && b.length === 2 && b.every(Number.isFinite) && b[0] <= b[1], `merge.bounds['${key}']['p(99)']가 [아래, 위] 한계가 아니다: ${JSON.stringify(b)}`);
      assert.equal(metric(summary, key)?.['p(99)'], b[1], `${key}의 p(99)는 위 한계(나쁜 쪽)여야 한다`);
    }

    // 요청 수는 더한다: 경로별 본구간 요청의 합 = 본구간 요청, 본구간 조회 수 = 모델(pollStages) 계획의 ±5%(발생기 하나 몫만 남으면 약 −50%)
    const routes = assertMainRoutes('split', summary, MAIN_ROUTES.queue);
    assert.equal(metric(summary, 'http_req_failed')?.rate, 0, `본구간 실패율: ${JSON.stringify(metric(summary, 'http_req_failed'))}`);
    const planned = plannedIterations(pollStages({ users: Q.users, entryRate: Q.entryRate, admitPerSecond: Q.admitPerSecond, startS: entryS + Q.warmS, durationS: Q.mainS }));
    const got = routes.status ?? 0;
    console.log(`# split: 본구간 조회 ${got}건(계획 ${planned}건), 입장 확정 ${routes.admission ?? 0}건, status p99 한계 ${JSON.stringify(summary.merge.bounds['http_req_duration{phase:main,route:status}']['p(99)'])}`);
    assert.ok(Math.abs(got - planned) <= 0.05 * planned, `합친 본구간 조회 ${got}건이 계획 ${planned}건의 ±5% 밖이다(발생기마다의 수를 더하지 않았다)`);

    // 진입(준비 구간)은 두 발생기가 나눠 보냈고(k6 실행 구간), 겹치거나 빠진 사람이 없다: 순번 1~300, 계정마다 하나
    const perGen = [0, 1].map((i) =>
      splitConsole(readFileSync(join(out, `console-g${i}.ndjson`), 'utf8'))
        .records.map((l) => JSON.parse(l))
        .filter((o) => o.kind === 'queue_entry'),
    );
    // 실행 구간 0:1/2·1/2:1이라 도착률 실행기의 반복을 반씩 맡는다(k6가 정한 대로 나뉘어 흔들림이 없다). ±10%는 경계의 한 번을 덮는다
    assert.ok(
      perGen.every((xs) => Math.abs(xs.length - Q.users / 2) <= Q.users * 0.1),
      `두 발생기가 진입을 반씩(${Q.users / 2}건 ±10%) 보내야 한다(발생기마다 ${perGen.map((xs) => xs.length).join('·')}건, 실행 구간을 나누지 못했다)`,
    );
    assert.equal(perGen[0].length + perGen[1].length, Q.users, `발생기마다의 진입 수 합이 ${Q.users}이 아니다(실행 구간이 겹치거나 빠졌다)`);
    const entries = parseNdjson('records.ndjson', readFileSync(join(out, 'records.ndjson'), 'utf8')).filter((o) => o.kind === 'queue_entry');
    assert.deepEqual(entries.filter((e) => e.result !== 'ok').map((e) => `${e.account_ref}:${e.result}`), [], '성공하지 않은 진입');
    assert.deepEqual(
      entries.map((e) => e.account_ref).sort(),
      Array.from({ length: Q.users }, (_, i) => accountRef(run.runTag, i)).sort(),
      '진입한 계정이 가상 사용자 0~299의 accountRef(runTag, i)와 다르다(두 발생기가 같은 사람을 보냈거나 빠졌다)',
    );
    assert.deepEqual(
      entries.map((e) => e.seq).sort((x, y) => x - y),
      Array.from({ length: Q.users }, (_, i) => i + 1),
      '진입 순번이 1~300이 아니다',
    );

    // 점검 파일: 합친 요약의 시행·어긴 수(p99 200ms와 오류율). 대기 상태·입장 확정은 본구간, 진입은 예열 앞의 진입 구간 전체를 센다
    // (docs/verification.md §3.10 '경로 목표 점검', 2026-11-03 시험 검토: 진입이 본구간에 없어 K1 진입 점검이 빠지던 결함)
    const checks = readJson(out, 'checks.json').checks;
    for (const n of ['status_p99_200ms', 'status_errors', 'entry_p99_200ms', 'entry_errors']) assert.ok(checks.some((c) => c.name === n), `checks.json에 ${n}이 없다: ${checks.map((c) => c.name).join(', ')}`);
    assert.equal(checks.find((c) => c.name === 'entry_p99_200ms').trials, Q.users, '진입 점검의 시행 수는 두 발생기가 나눠 보낸 진입 수의 합(사용자 수)이다');
    assert.equal(checks.find((c) => c.name === 'status_p99_200ms').trials, got, 'status 점검의 시행 수가 합친 본구간 조회 수가 아니다');

    await assertCleanedUp('split');
    await assertNoSecrets('split', { dirs: [out], texts: [r.stdout + r.stderr] });
  });
});

test('BSL090_S-T1_인기좌석한석을놓지않으면(--keep)_회차전체에서홀드201은첫한건뿐이고_본구간에해제요청이없으며_db-stats.json에교착·롤백·표별갱신과HOT비율이남는다', opts(MINUTES.hotKeep), async () => {
  await withOut('hot-keep', async (out) => {
    const P = { users: 200, rate: 50, warmS: 3, mainS: 10 };
    const argv = ['v0', 'seat-hold', ...['--users', P.users, '--rate', P.rate, '--mode', 'hot', '--hot-count', '1', '--warm', P.warmS, '--main', P.mainS].map(String), '--keep', '--db-stats', ...SMALL_GEN_ARGS, '--out', out];
    const a = parseArgs(argv);
    assert.deepEqual({ keep: a.keep, dbStats: a.dbStats, mode: a.mode, hotCount: a.hotCount }, { keep: true, dbStats: true, mode: 'hot', hotCount: 1 }, '시험 인자');
    const r = await runCli(argv, killAfter(MINUTES.hotKeep));
    const { run, summary, gen, notes } = assertRunCommon('hot-keep', out, r, { scenario: 'seat-hold', generators: 1, ...SMALL_GEN, prepS: prepSeconds(P.users), warmS: P.warmS, mainS: P.mainS, prepMinReqs: 2 * P.users });
    assert.ok(existsSync(join(out, 'db-stats.json')), 'db-stats.json이 없다');
    assert.equal(readFileSync(join(out, 'records.ndjson'), 'utf8').trim(), '', 'seat-hold의 records.ndjson는 비어야 한다');

    const routes = assertMainRoutes('hot-keep', summary, MAIN_ROUTES['seat-hold']);
    assertArrivalCount('hot-keep 본구간 홀드', routes.hold ?? 0, P.rate * P.mainS, gen.dropped);
    assert.equal(routes.release ?? 0, 0, '--keep인데 본구간에 해제(route:release) 요청이 있다');

    // 첫 한 명만 201, 나머지는 409(K2 S-T1 행): 첫 201은 예열 구간에서 날 수 있어 본구간 지표가 아니라 회차 전체의 v0 DB로 센다
    const h = await eventHolds(run.eventId);
    console.log(`# hot-keep: 본구간 홀드 ${routes.hold}건, 실패율 ${metric(summary, 'http_req_failed{phase:main,route:hold}')?.rate}, DB 홀드 ${JSON.stringify(h)}`);
    assert.deepEqual(h, { holds: 1, held: 1, minSize: 1, maxSize: 1, seats: ['A-1-1'] }, '회차 전체에서 첫 좌석 A-1-1 한 석의 홀드 한 건만 잡히고 놓이지 않아야 한다');

    const db = readJson(out, 'db-stats.json');
    assertDbStats('hot-keep', db, P);
    assert.ok(db.tables.v0_hold.inserts >= 1, `v0_hold에 넣은 행이 없다: ${JSON.stringify(db.tables.v0_hold)}`);
    assert.ok(notes.includes(`DB: 교착 ${db.deadlocks}, 롤백 ${db.rollbacks}`), 'notes.txt에 DB 통계(교착·롤백)가 없다');
    console.log(`# hot-keep DB 통계: 교착 ${db.deadlocks}, 롤백 ${db.rollbacks}, ${Object.entries(db.tables).map(([t, v]) => `${t} 갱신 ${v.updates}·HOT ${v.hotRatio}`).join(', ')}`);

    await assertCleanedUp('hot-keep');
    await assertNoSecrets('hot-keep', { dirs: [out], texts: [r.stdout + r.stderr] });
  });
});

test('BSL090_S-T10_엇갈린좌석두쌍(--pairs 2 --db-stats)_홀드는그네좌석을둘씩잡고_db-stats.json의교착수는0이상정수이며_실행도구가센교착·롤백은시험이잰실행전후차이를넘지않는다', opts(MINUTES.crossed), async () => {
  await withOut('crossed', async (out) => {
    // 두 쌍에 초당 100건(쌍마다 50건, v0-rehearsal의 한 쌍 50건과 같은 다툼): 홀드 + 해제 = 100 × 2 ≤ 0.6 × 10 × 200
    const P = { users: 200, rate: 100, warmS: 3, mainS: 10, pairs: 2 };
    const argv = ['v0', 'seat-hold', ...['--users', P.users, '--rate', P.rate, '--mode', 'crossed', '--pairs', P.pairs, '--warm', P.warmS, '--main', P.mainS].map(String), '--db-stats', ...SMALL_GEN_ARGS, '--out', out];
    const a = parseArgs(argv);
    assert.deepEqual({ mode: a.mode, pairs: a.pairs, dbStats: a.dbStats, keep: a.keep }, { mode: 'crossed', pairs: 2, dbStats: true, keep: false }, '시험 인자');
    const before0 = await v0DbCounters();
    const r = await runCli(argv, killAfter(MINUTES.crossed));
    const after0 = await v0DbCounters();
    // 잠금 대기가 길면 가상 사용자가 모자라 반복을 놓칠 수 있다. 이 시험은 DB 통계 길을 보므로 발생기 판정은 적기만 한다
    const { run, summary, gen } = assertRunCommon('crossed', out, r, { scenario: 'seat-hold', generators: 1, ...SMALL_GEN, prepS: prepSeconds(P.users), warmS: P.warmS, mainS: P.mainS, prepMinReqs: 2 * P.users, requireValid: false });
    const routes = assertMainRoutes('crossed', summary, MAIN_ROUTES['seat-hold']);
    assertArrivalCount('crossed 본구간 홀드', routes.hold ?? 0, P.rate * P.mainS, gen.dropped);

    // 쌍 p의 두 좌석(2p번째·2p+1번째)을 함께: A-1-1·A-1-2와 A-1-3·A-1-4
    const h = await eventHolds(run.eventId);
    assert.ok(h.holds > 0, 'v0 DB에 이 회차의 홀드가 없다(홀드가 한 번도 성공하지 않았다)');
    assert.deepEqual({ minSize: h.minSize, maxSize: h.maxSize, seats: h.seats }, { minSize: 2, maxSize: 2, seats: ['A-1-1', 'A-1-2', 'A-1-3', 'A-1-4'] }, '엇갈린 두 쌍(두 좌석을 함께) 방식이 아니다');

    const db = readJson(out, 'db-stats.json');
    assertDbStats('crossed', db, P);
    // 짧은 실행에서 v0가 교착을 낼지는 정해지지 않아 0 초과를 요구하지 않는다(K3의 판정은 Before 측정). 실행 도구의 창(회차를 연 뒤 ~ k6 끝 + 12초)은
    // 시험이 잰 창(실행 도구를 부르기 전 ~ 끝난 뒤) 안이라 그 차이를 넘을 수 없다
    const delta = { deadlocks: after0.deadlocks - before0.deadlocks, rollbacks: after0.rollbacks - before0.rollbacks };
    console.log(`# K3 v0 교착 ${db.deadlocks}건·롤백 ${db.rollbacks}건(시험이 잰 전후 차이 교착 ${delta.deadlocks}·롤백 ${delta.rollbacks}), 본구간 홀드 ${routes.hold}건·실패율 ${metric(summary, 'http_req_failed{phase:main,route:hold}')?.rate}, 발생기 ${JSON.stringify(gen.judge)}, DB 홀드 ${JSON.stringify(h)}`);
    assert.ok(isCount(db.deadlocks), `교착 수: ${db.deadlocks}`);
    assert.ok(db.deadlocks <= delta.deadlocks, `실행 도구가 센 교착 ${db.deadlocks}건이 시험이 잰 실행 전후 차이 ${delta.deadlocks}건보다 많다`);
    assert.ok(db.rollbacks <= delta.rollbacks, `실행 도구가 센 롤백 ${db.rollbacks}건이 시험이 잰 실행 전후 차이 ${delta.rollbacks}건보다 많다`);

    await assertCleanedUp('crossed');
    await assertNoSecrets('crossed', { dirs: [out], texts: [r.stdout + r.stderr] });
  });
});

test('BSL090_S-T12_변경분연결100개를받는파드둘이50개씩나눠맺고_모두연결·실패0이며_초당메시지·바이트·종단지연칸이남고_deltas.json은deltas.ndjson으로다시센값과같으며_받는파드가남지않는다', opts(MINUTES.deltas), async () => {
  await withOut('deltas', async (out) => {
    const P = { users: 50, rate: 5, connections: 100, listenerPods: 2, warmS: 5, mainS: 20 };
    const argv = ['v0', 'seat-deltas', ...['--users', P.users, '--rate', P.rate, '--connections', P.connections, '--listener-pods', P.listenerPods, '--warm', P.warmS, '--main', P.mainS].map(String), ...SMALL_GEN_ARGS, '--out', out];
    const a = parseArgs(argv);
    assert.deepEqual({ connections: a.connections, listenerPods: a.listenerPods, holdSize: a.holdSize }, { connections: 100, listenerPods: 2, holdSize: 2 }, '시험 인자');
    const r = await runCli(argv, killAfter(MINUTES.deltas));
    // 준비 구간: 연결 쪽 100명 + 홀드 쪽 50명을 진입·입장시키고(2 × ⌈150 ÷ 150⌉ + 3초), 받는 파드가 연결을 맺을 20초를 비운다
    const tokenUsers = P.connections + P.users;
    const { notes, summary, gen } = assertRunCommon('deltas', out, r, { scenario: 'seat-deltas', generators: 1, ...SMALL_GEN, prepS: prepSeconds(tokenUsers) + 20, warmS: P.warmS, mainS: P.mainS, prepMinReqs: 2 * tokenUsers });
    for (const f of ['deltas.json', 'deltas.ndjson']) assert.ok(existsSync(join(out, f)), `${f}가 없다`);
    const routes = assertMainRoutes('deltas', summary, MAIN_ROUTES['seat-deltas']);
    assertArrivalCount('deltas 본구간 홀드', routes.hold ?? 0, P.rate * P.mainS, gen.dropped);

    const deltas = readJson(out, 'deltas.json');
    console.log(`# deltas: ${JSON.stringify(deltas)}`);
    assert.equal(deltas.connected, P.connections, '맺은 변경분 연결 수');
    assert.equal(deltas.failed, 0, '맺지 못한 변경분 연결');
    assert.ok(deltas.msgsPerS > 0, `초당 받은 메시지: ${deltas.msgsPerS}`);
    assert.ok(deltas.bytesPerS > 0, `초당 받은 바이트: ${deltas.bytesPerS}`);
    assert.ok(Number.isSafeInteger(deltas.latency?.count) && deltas.latency.count > 0, `종단 지연을 잰 메시지 수: ${deltas.latency?.count}`);
    for (const k of ['p50Ms', 'p99Ms']) assert.ok(deltas.latency[k] === null || Number.isFinite(deltas.latency[k]), `latency.${k}: ${deltas.latency[k]}`);
    assert.ok(Number.isSafeInteger(deltas.seconds) && deltas.seconds >= 1 && deltas.seconds <= P.mainS, `본구간에 든 초: ${deltas.seconds}`);
    // 받는 파드 CPU(한도 대비 %, 가장 높은 파드)는 받는 파드가 낸 줄의 cpuUsec에서 실행 도구가 따로 센다. 나머지 칸은 아래에서 다시 센다
    const { clientCpu, ...rest } = deltas;
    assert.ok(Number.isFinite(clientCpu?.meanPctMax) && clientCpu.meanPctMax >= 0, `받는 파드 CPU: ${JSON.stringify(clientCpu)}`);

    // 받는 파드가 낸 줄은 모두 JSON이고, 파드마다 연결을 50개씩 맺었으며, 요약은 그 줄을 본구간 창(구간 표시)으로 다시 센 값과 같다
    const lines = parseNdjson('deltas.ndjson', readFileSync(join(out, 'deltas.ndjson'), 'utf8'));
    assert.deepEqual([...new Set(lines.map((l) => l.kind))].sort(), ['delta_bucket', 'delta_conn'], 'deltas.ndjson의 줄 종류');
    const conns = lines.filter((l) => l.kind === 'delta_conn').sort((x, y) => x.pod - y.pod);
    assert.deepEqual(
      conns.map((c) => ({ pod: c.pod, connected: c.connected, failed: c.failed })),
      [
        { pod: 0, connected: 50, failed: 0 },
        { pod: 1, connected: 50, failed: 0 },
      ],
      '받는 파드 둘이 연결을 50개씩 나눠 맺어야 한다',
    );
    const marks = gen.each[0].marks;
    assert.deepEqual(rest, deltaSummary(lines, { fromMs: marks.main_start, toMs: marks.main_end }), 'deltas.json이 deltas.ndjson을 본구간 창으로 다시 센 값과 다르다');
    assert.ok(notes.includes(`변경분: 연결 ${P.connections}(실패 0)`), 'notes.txt에 변경분 연결 요약이 없다');

    // 받는 파드(loadgen-delta)가 남지 않는다
    assert.equal((await kc(['-n', LT, 'get', 'pods', '-l', 'app.kubernetes.io/name=loadgen-delta', '-o', 'name'])).trim(), '', '변경분 받는 파드가 남았다');
    await assertCleanedUp('deltas');
    await assertNoSecrets('deltas', { dirs: [out], texts: [r.stdout + r.stderr] });
  });
});

test('BSL090_O-T1_입구를0개로줄이면짧은여유뒤로판정이멈추고(처리량≈0)_되돌린뒤판정이이어지며_판정이멈춘시간이끊긴길이이상이고_실행도구가입구를원래복제로되돌려준비시킨다', opts(MINUTES.gate), async () => {
  await withOut('gate', async (out) => {
    // 스캐너 5대·초당 5장, 본구간 40초: 10초에 끊고 10초 뒤 되돌린다(되돌려 준비될 때까지도 멈춘 시간에 든다).
    // 실행 도구를 끊긴 동안 강제로 끝냈을 때 입구를 되돌리는지(실패 안전 검사)는 이 시험 범위 밖이다
    const G = { scanners: 5, rate: 5, warmS: 5, mainS: 40, cutAtS: 10, cutS: 10 };
    const argv = ['v0', 'gate', ...['--scanners', G.scanners, '--rate', G.rate, '--warm', G.warmS, '--main', G.mainS, '--cut-at', G.cutAtS, '--cut-s', G.cutS].map(String), ...SMALL_GEN_ARGS, '--out', out];
    const a = parseArgs(argv);
    assert.deepEqual({ cutAtS: a.cutAtS, cutS: a.cutS, tickets: a.tickets }, { cutAtS: G.cutAtS, cutS: G.cutS, tickets: G.rate * (G.warmS + G.mainS) + 2 }, '시험 인자');
    const gw0 = await gatewayState();
    // 두 시계 차이(노드 − PC)를 실행 앞뒤로 잰다. 끊긴 구간 경계(PC 시계)와 검표 시도(노드 시계)를 섞으므로 그 차이를 여유에 더한다
    const clocks = [nodeClockOffset()];
    let gw1;
    let r;
    try {
      r = await runCli(argv, killAfter(MINUTES.gate));
    } finally {
      // 판정과 따로, 다음 시험을 위해 입구를 원래대로 둔다(실행 도구가 되돌렸는지는 아래에서 본다)
      gw1 = await gatewayState().catch(() => ({ replicas: -1, ready: -1 }));
      if (gw1.replicas !== gw0.replicas) {
        console.log(`# gate: 입구 복제가 ${gw1.replicas}개로 남아 ${gw0.replicas}개로 되돌린다`);
        await kc(['-n', V0_NAMESPACE, 'scale', 'deploy/v0-gateway', `--replicas=${gw0.replicas}`]).catch((err) => console.log(`# gate: 입구 되돌리기 실패(${firstLine(err)})`));
      }
      await kc(['-n', V0_NAMESPACE, 'rollout', 'status', 'deploy/v0-gateway', '--timeout=300s'], { timeout: 320_000 }).catch((err) => console.log(`# gate: 입구 준비 기다리기 실패(${firstLine(err)})`));
    }
    clocks.push(nodeClockOffset());
    const { gen } = assertRunCommon('gate', out, r, { scenario: 'gate', generators: 1, ...SMALL_GEN, prepS: 0, warmS: G.warmS, mainS: G.mainS, prepMinReqs: 0 });
    assert.deepEqual(gw1, gw0, `실행 도구가 끝난 뒤 입구가 원래 복제 ${gw0.replicas}개로 돌아와 준비되지 않았다`);
    assert.ok(existsSync(join(out, 'gate.json')), 'gate.json이 없다');
    const gate = readJson(out, 'gate.json');
    console.log(`# gate: ${JSON.stringify(gate)}`);
    for (const k of ['online', 'cut', 'restored', 'maxGapS', 'offlineRatio', 'results']) assert.ok(k in gate, `gate.json에 ${k}가 없다`);
    for (const p of ['online', 'cut', 'restored']) {
      for (const k of ['attempts', 'judged', 'failed']) assert.ok(isCount(gate[p][k]), `gate.json ${p}.${k}: ${gate[p][k]}`);
      assert.equal(gate[p].attempts, gate[p].judged + gate[p].failed, `gate.json ${p}: 시도 = 판정 + 실패`);
      assert.ok(Number.isFinite(gate[p].perMinute) && gate[p].perMinute >= 0, `gate.json ${p}.perMinute: ${gate[p].perMinute}`);
    }

    // 끊은 시각(cutTimes, 이 PC 시계): 명령을 낸 때(issuedMs) ≤ 끊긴 때(startMs, 0개로 줄이고 강제로 끝내는 명령이 끝난 때) < 되돌린 때(endMs)
    // ≤ 준비된 때(readyMs). 명령은 부하 시작(loadStartMs, 같은 시계) + 예열 + --cut-at, 되돌리기는 거기에 + --cut-s에 낸다(타이머라 늦을 수만 있다)
    const ct = gate.cutTimes;
    assert.ok(ct !== null && typeof ct === 'object', `gate.json에 끊은 시각(cutTimes)이 없다(구간 나누기를 다시 셀 수 없다): ${JSON.stringify(ct)}`);
    for (const k of ['issuedMs', 'startMs', 'endMs', 'readyMs']) assert.ok(Number.isSafeInteger(ct[k]), `cutTimes.${k}: ${ct[k]}`);
    assert.equal(ct.original, gw0.replicas, 'cutTimes.original이 실행 전 입구 복제 수와 다르다');
    assert.ok(ct.issuedMs <= ct.startMs && ct.startMs < ct.endMs && ct.endMs <= ct.readyMs, `끊은 시각의 차례가 틀렸다: ${JSON.stringify(ct)}`);
    const planCut = gen.loadStartMs + (G.warmS + G.cutAtS) * 1000;
    const planRestore = planCut + G.cutS * 1000;
    assert.ok(ct.issuedMs >= planCut - 100 && ct.issuedMs <= planCut + 3000, `끊는 명령 시각이 부하 시작 + 예열 + --cut-at에서 ${ct.issuedMs - planCut}ms 떨어졌다`);
    assert.ok(ct.endMs >= planRestore - 100 && ct.endMs <= planRestore + 3000, `되돌리는 명령 시각이 끊는 예정 + --cut-s에서 ${ct.endMs - planRestore}ms 떨어졌다`);
    assert.ok(ct.readyMs - ct.endMs <= 300_000, `되돌린 입구가 준비되기까지 ${ct.readyMs - ct.endMs}ms`);

    // 구간 요약은 콘솔의 검표 시도 줄(kind 노드 시계)·구간 표시와 끊은 시각으로 다시 센 값과 같다(runner/probes.mjs gateSummary)
    const { probes } = splitConsole(readFileSync(join(out, 'console.ndjson'), 'utf8'));
    const marks = gen.each[0].marks;
    // 검표 p95 점검은 끊기 명령을 낸 때(issuedMs) 앞의 온라인 시도만 센다(runner/probes.mjs gateOnlineCheck, §3.10 K10 '온라인 판정 p95')
    const scanChecks = readJson(out, 'checks.json').checks.filter((c) => c.name.startsWith('scan_p95_'));
    assert.deepEqual(
      scanChecks,
      [gateOnlineCheck(probes, { mainStartMs: marks.main_start, cutStartMs: ct.issuedMs, cutEndMs: ct.endMs, mainEndMs: marks.main_end })],
      'checks.json의 검표 p95 점검이 끊기 명령 앞의 온라인 시도로 다시 센 값과 다르다',
    );
    const inWin = probes.filter((p) => p.startedMs >= marks.main_start && p.startedMs < marks.main_end);
    const { cutTimes, ...phases } = gate;
    assert.deepEqual(
      phases,
      gateSummary(probes, { mainStartMs: marks.main_start, cutStartMs: cutTimes.startMs, cutEndMs: cutTimes.endMs, mainEndMs: marks.main_end }),
      'gate.json의 구간 요약이 검표 시도 줄·구간 표시·끊은 시각으로 다시 센 값과 다르다',
    );
    const total = (k) => gate.online[k] + gate.cut[k] + gate.restored[k];
    assert.equal(total('attempts'), inWin.length, '세 구간 시도 수의 합이 본구간 검표 시도 줄 수와 다르다');
    // 티켓은 한 장에 한 번씩 찍는다(본구간은 앞 번호부터, 예열은 뒤 번호부터): 판정은 모두 입장(ADMIT)이다
    assert.deepEqual(gate.results, total('judged') ? { ADMIT: total('judged') } : {}, '본구간 판정이 모두 ADMIT이 아니다(같은 티켓을 두 번 찍었거나 다른 회차의 코드를 보냈다)');

    // K10: 온라인 동안 판정, 끊긴 동안(입구 파드 0개, 맺어 둔 연결도 끊긴다) 짧은 여유 뒤로 판정 0, 되돌린 뒤 판정. 멈춘 시간은 끊긴 길이 이상이다.
    // 여유 = 입구 파드가 실제로 죽기까지(CUT_GRACE_MS) + 두 시계 차이(재지 못했으면 1초)
    const measured = clocks.filter(Boolean);
    console.log(`# gate: 노드 − PC 시계 ${measured.map((c) => `${c.offsetMs}ms(±${c.uncertaintyMs})`).join(', ') || '재지 못함'}`);
    assert.ok(
      measured.every((c) => Math.abs(c.offsetMs) - c.uncertaintyMs <= CLOCK_MAX_OFFSET_MS),
      `이 PC와 kind 노드의 시계가 ${CLOCK_MAX_OFFSET_MS}ms 넘게 어긋났다(${JSON.stringify(measured)}). K10 구간 나누기를 믿을 수 없다. Docker Desktop을 다시 띄워 시계를 맞춘 뒤 다시 돌린다`,
    );
    const clockSlackMs = measured.length ? Math.max(...measured.map((c) => Math.abs(c.offsetMs) + c.uncertaintyMs)) : 1000;
    const judgedInCut = assertGateCut('gate', gate, probes, marks, { rate: G.rate, cutS: G.cutS, graceMs: CUT_GRACE_MS + clockSlackMs });
    console.log(`# gate: 끊긴 동안 판정 ${judgedInCut.length}건(끊긴 때 기준 ${judgedInCut.map((ms) => `${ms}ms`).join(', ') || '-'}), 끊김/온라인 ${gate.offlineRatio}, 멈춘 시간 ${gate.maxGapS}초`);
    assert.ok(Number.isFinite(gate.online.p95Ms), `온라인 판정 p95: ${gate.online.p95Ms}`);

    await assertCleanedUp('gate');
    await assertNoSecrets('gate', { dirs: [out], texts: [r.stdout + r.stderr] });
  });
});

test('BSL090_K9_--settle로HPA가앱복제를최소로줄인뒤시작하고_--hpa-timeline이부하시작기준의늘리기사건·새파드준비시각을hpa.json에남긴다', opts(MINUTES.hpa), async () => {
  await withOut('hpa', async (out) => {
    const argv = ['v0', 'queue', ...queueArgs(), ...SMALL_GEN_ARGS, '--settle', '--hpa-timeline', '--out', out];
    const a = parseArgs(argv);
    assert.deepEqual({ settle: a.settle, hpaTimeline: a.hpaTimeline }, { settle: true, hpaTimeline: true }, '시험 인자');
    // --settle은 HPA가 복제를 줄일 때까지 최대 15분 기다린다(run.mjs settleHpa)
    const r = await runCli(argv, killAfter(MINUTES.hpa));
    const { run, gen, notes } = assertRunCommon('hpa', out, r, { scenario: 'queue', generators: 1, ...SMALL_GEN, prepS: Math.ceil(Q.users / Q.entryRate), warmS: Q.warmS, mainS: Q.mainS, prepMinReqs: Q.users });
    assert.deepEqual({ settle: run.args.settle, hpaTimeline: run.args.hpaTimeline }, { settle: true, hpaTimeline: true }, 'run.json args');
    // --settle이 실제로 돌았다: 실행 도구가 그 단계를 알렸고, 부하 시작 앞에 만든 앱 파드(지금 남은 것)가 HPA 최소 복제 이하다
    // (늘린 파드는 부하 시작 뒤에 생기고, 줄이기는 안정화 창 5분 동안 일어나지 않는다. 5초는 두 시계와 초 단위로 잘린 시각을 덮는다)
    assert.ok(r.stdout.includes('HPA가 앱 복제를 최소로 줄이기를 기다린다(--settle)'), '실행 도구 출력에 --settle 단계가 없다');
    const minReplicas = JSON.parse(await kc(['-n', V0_NAMESPACE, 'get', 'hpa', 'v0-monolith', '-o', 'json'])).spec?.minReplicas ?? 1;
    const oldPods = JSON.parse(await kc(['-n', V0_NAMESPACE, 'get', 'pods', '-l', APP_SELECTOR, '-o', 'json']))
      .items.filter((p) => !p.metadata?.deletionTimestamp && Date.parse(p.metadata?.creationTimestamp) < gen.loadStartMs - 5000)
      .map((p) => p.metadata.name);
    assert.ok(oldPods.length <= minReplicas, `부하 시작 앞에 만든 앱 파드 ${oldPods.length}개(${oldPods.join(', ')})가 HPA 최소 ${minReplicas}개보다 많다(--settle이 기다리지 않았다)`);
    assert.ok(existsSync(join(out, 'hpa.json')), 'hpa.json이 없다');
    const h = readJson(out, 'hpa.json');
    console.log(`# hpa: ${JSON.stringify(h)}`);
    for (const k of ['loadStartMs', 'rescales', 'firstRescaleS', 'newPods', 'firstNewReadyS', 'maxSize']) assert.ok(k in h, `hpa.json에 ${k}가 없다`);
    assert.equal(h.loadStartMs, gen.loadStartMs, 'hpa.json loadStartMs가 generator.json의 부하 시작 시각과 다르다');
    // 쿠버네티스 시각은 초로 잘려 부하 시작 직전 1초 안의 사건도 '뒤'로 센다(probes.mjs hpaTimeline)
    assert.ok(Array.isArray(h.rescales), 'rescales는 목록이다');
    h.rescales.forEach((e, i) => {
      assert.ok(Number.isFinite(e.atS) && e.atS >= -1 && Number.isSafeInteger(e.size) && e.size >= 1, `rescales[${i}]: ${JSON.stringify(e)}`);
      if (i > 0) assert.ok(e.atS >= h.rescales[i - 1].atS, 'rescales는 시각 순이다');
    });
    assert.equal(h.firstRescaleS, h.rescales.length ? h.rescales[0].atS : null, 'firstRescaleS는 첫 늘리기 사건의 시각이고 없으면 null');
    assert.equal(h.maxSize, h.rescales.length ? Math.max(...h.rescales.map((e) => e.size)) : null, 'maxSize는 늘리기 사건의 가장 큰 크기이고 없으면 null');
    assert.ok(Array.isArray(h.newPods), 'newPods는 목록이다');
    h.newPods.forEach((p, i) => {
      assert.ok(typeof p.name === 'string' && p.name.startsWith('v0-monolith-'), `newPods[${i}].name: ${p.name}`);
      assert.ok(Number.isFinite(p.createdS) && p.createdS >= -1, `newPods[${i}].createdS: ${p.createdS}`);
      assert.ok(p.readyS === null || (Number.isFinite(p.readyS) && p.readyS >= p.createdS - 1), `newPods[${i}].readyS: ${p.readyS}`);
      if (i > 0) assert.ok(p.createdS >= h.newPods[i - 1].createdS, 'newPods는 만든 시각 순이다');
    });
    const readies = h.newPods.filter((p) => p.readyS !== null).map((p) => p.readyS);
    assert.equal(h.firstNewReadyS, readies.length ? Math.min(...readies) : null, 'firstNewReadyS는 준비된 새 파드 중 가장 이른 시각이고 없으면 null');
    assert.ok(notes.includes('HPA: 첫 확장'), 'notes.txt에 HPA 시간선 요약이 없다');

    await assertCleanedUp('hpa');
    await assertNoSecrets('hpa', { dirs: [out], texts: [r.stdout + r.stderr] });
  });
});

test('BSL090_낮음-056_--record--prom-url(--settle)은장부실행폴더에raw_uri·점검·지연대조·metrics-summary.json을남기고_큰원본(stdout.log·metrics)은SHA256SUMS에해시를남긴뒤보낼폴더의gzip으로옮기며_시험은장부행과원본을지운다', opts(MINUTES.record), async (t) => {
  if ((await httpStatus(`${PROM_URL}/-/ready`)) !== 200) {
    t.skip(`Prometheus(${PROM_URL})에 닿지 않는다. node tools/local/cluster.mjs observability 뒤 다른 창에서 node tools/local/cluster.mjs prometheus를 열고 다시 돌린다`);
    return;
  }
  if (!pythonOk()) {
    t.skip(`Python 3(${PYTHON})를 부르지 못한다(collect.py)`);
    return;
  }
  const runId = `${kstDate()}-bsl090-e2e-rec-${randomBytes(4).toString('hex')}`;
  const runDir = join(LEDGER_RUNS, runId);
  const outbox = join(RAW_OUTBOX, 'runs', runId);
  // --hpa-timeline이 없으니 K9 실행(<ID>-k9)은 생기지 않아야 하지만 생겼으면 함께 지운다
  const mine = [runDir, outbox, join(LEDGER_RUNS, `${runId}-k9`), join(RAW_OUTBOX, 'runs', `${runId}-k9`)];
  const outboxExisted = { root: existsSync(RAW_OUTBOX), runs: existsSync(join(RAW_OUTBOX, 'runs')) };
  for (const d of mine) assert.equal(existsSync(d), false, `시험 실행 ID의 폴더가 이미 있다: ${d}`);
  try {
    await withOut('record', async (out) => {
      // --settle: 앞 시험(K9 등)의 부하로 HPA가 앱 복제를 늘렸으면 측정 창 동안 줄이며 앱 파드가 사라질 수 있다. 그러면 collect.py가 서버 히스토그램을
      // '창 안에서 사라진 시계열'로 셀 수 없다며 거부한다(docs/verification.md §3.10 '공통 규칙'도 반복 사이에 --settle을 쓴다)
      const argv = ['v0', 'queue', ...queueArgs(), ...SMALL_GEN_ARGS, '--settle', '--record', '--run-id', runId, '--prom-url', PROM_URL, '--out', out];
      const a = parseArgs(argv);
      assert.deepEqual({ record: a.record, runId: a.runId, promUrl: a.promUrl, profile: a.profile, settle: a.settle }, { record: true, runId, promUrl: PROM_URL, profile: 'local-1k', settle: true }, '시험 인자');
      const r = await runCli(argv, killAfter(MINUTES.record));
      const { summary, gen } = assertRunCommon('record', out, r, { scenario: 'queue', generators: 1, ...SMALL_GEN, prepS: Math.ceil(Q.users / Q.entryRate), warmS: Q.warmS, mainS: Q.mainS, prepMinReqs: Q.users, promUrl: true });
      const localChecks = readJson(out, 'checks.json').checks.filter((c) => !c.histogram);

      // manifest: 올릴 자리(raw_uri), 점검(경로 점검 + 서버 히스토그램 점검), 지연 대조, 판정 baseline
      assert.ok(existsSync(join(runDir, 'manifest.json')), `장부 실행 폴더가 없다: ${runDir}`);
      const man = readJson(runDir, 'manifest.json');
      assert.deepEqual(
        { run_id: man.run_id, kpi: man.kpi, version: man.version, profile: man.profile, verdict: man.verdict, raw_uri: man.raw_uri },
        { run_id: runId, kpi: 'K1', version: 'v0', profile: 'local-1k', verdict: 'baseline', raw_uri: `${RAW_BUCKET}/runs/${runId}/` },
        'manifest 머리 칸',
      );
      assert.deepEqual({ users: man.scale?.users, duration_s: man.scale?.duration_s, warmup_s: man.scale?.warmup_s }, { users: Q.users, duration_s: Q.mainS, warmup_s: Q.warmS }, 'manifest scale');
      assert.equal(man.valid, gen.judge.valid, 'manifest valid가 발생기 판정과 다르다');
      assert.ok(String(man.generator?.description ?? '').includes('발생기 파드 1대'), `manifest generator: ${JSON.stringify(man.generator)}`);
      assert.ok(Array.isArray(man.checks) && man.checks.length > 0, `manifest에 점검이 없다: ${JSON.stringify(man.checks)}`);
      for (const c of man.checks) {
        assert.ok(['pass', 'fail', 'observed'].includes(c.result), `점검 ${c.name}의 result: ${c.result}`);
        assert.ok(Number.isSafeInteger(c.trials) && c.trials >= 1 && isCount(c.violations) && c.violations <= c.trials, `점검 ${c.name}의 시행·어긴 수: ${c.trials}·${c.violations}`);
        assert.ok(Number.isFinite(c.cp_upper) && Number.isSafeInteger(c.min_trials), `점검 ${c.name}의 cp_upper·min_trials`);
      }
      assert.deepEqual(
        man.checks.map((c) => c.name),
        [...localChecks.map((c) => c.name), QUEUE_SERVER_CHECK.name],
        'manifest 점검은 checks.json의 점검(경로 점검 + 서버 점검) 그대로다',
      );
      for (const c of localChecks) {
        const m = man.checks.find((x) => x.name === c.name);
        assert.deepEqual({ allowed: m.allowed, trials: m.trials, violations: m.violations }, { allowed: c.allowed, trials: c.trials, violations: c.violations }, `manifest 점검 ${c.name}이 checks.json과 다르다`);
      }
      const x = man.latency_crosscheck;
      assert.ok(x && x.check === QUEUE_SERVER_CHECK.name && x.k6_metric === QUEUE_SERVER_CHECK.k6Metric && x.target_ms === QUEUE_SERVER_CHECK.targetMs, `지연 대조: ${JSON.stringify(x)}`);
      assert.ok(Number.isFinite(x.k6_p99_ms) && Number.isFinite(x.server_p99_ms) && typeof x.suspect === 'boolean', `지연 대조 값: ${JSON.stringify(x)}`);
      assert.equal(x.k6_p99_ms, metric(summary, QUEUE_SERVER_CHECK.k6Metric)?.['p(99)'], '지연 대조의 k6 p99가 요약의 경로 p99와 다르다');

      // 서버 지표 요약: v0 질의마다 하나(예열 뺀 p50·p99·최대·평균)
      assert.ok(existsSync(join(runDir, 'metrics-summary.json')), 'metrics-summary.json이 없다');
      const msum = readJson(runDir, 'metrics-summary.json');
      const names = queryNames();
      assert.deepEqual(Object.keys(msum).sort(), [...names].sort(), 'metrics-summary.json의 질의 이름이 loadtest/queries/v0.txt와 다르다');
      for (const [n, v] of Object.entries(msum)) {
        assert.ok(isCount(v.points) && isCount(v.series), `metrics-summary ${n}의 points·series: ${JSON.stringify(v)}`);
        for (const k of ['p50', 'p99', 'max', 'mean']) assert.ok(v[k] === null || Number.isFinite(v[k]), `metrics-summary ${n}.${k}: ${v[k]}`);
      }

      // 큰 원본: 실행 폴더에서 지우고(SHA256SUMS에 해시만), 보낼 폴더의 버킷과 같은 경로(runs/<ID>/…)에 gzip으로. 작은 파일은 해시가 맞는다
      assert.equal(existsSync(join(runDir, 'stdout.log')), false, '실행 폴더에 stdout.log가 남았다');
      assert.equal(existsSync(join(runDir, 'metrics')), false, '실행 폴더에 metrics/가 남았다');
      const sums = readSums(runDir);
      const isRaw = (rel) => rel === 'stdout.log' || rel.startsWith('metrics/') || rel.startsWith('traces/') || rel.startsWith('grafana/');
      for (const rel of ['manifest.json', 'k6-summary.json', 'infra.txt', 'metrics-summary.json', 'stdout.log', ...names.map((n) => `metrics/${n}.csv`)]) {
        assert.ok(sums.has(rel), `SHA256SUMS에 ${rel}가 없다`);
      }
      assert.ok(existsSync(join(outbox, 'stdout.log.gz')), `보낼 폴더에 stdout.log.gz가 없다: ${outbox}`);
      for (const [rel, hash] of sums) {
        if (isRaw(rel)) {
          const gz = join(outbox, ...rel.split('/')) + '.gz';
          assert.ok(existsSync(gz), `보낼 폴더에 ${rel}.gz가 없다`);
          assert.equal(sha256(gunzipSync(readFileSync(gz))), hash, `보낼 폴더의 ${rel}.gz를 푼 해시가 SHA256SUMS와 다르다`);
        } else {
          assert.ok(existsSync(join(runDir, ...rel.split('/'))), `실행 폴더에 ${rel}가 없다`);
          assert.equal(sha256(readFileSync(join(runDir, ...rel.split('/')))), hash, `실행 폴더 ${rel}의 해시가 SHA256SUMS와 다르다`);
        }
      }
      const inOutbox = filesUnder(outbox).map((f) => relative(outbox, f).split('\\').join('/')).sort();
      assert.deepEqual(inOutbox, [...sums.keys()].filter(isRaw).map((rel) => `${rel}.gz`).sort(), '보낼 폴더에 SHA256SUMS의 큰 원본 밖의 파일이 있거나 빠졌다');
      const inRunDir = filesUnder(runDir).map((f) => relative(runDir, f).split('\\').join('/')).filter((f) => f !== 'SHA256SUMS').sort();
      assert.deepEqual(inRunDir, [...sums.keys()].filter((rel) => !isRaw(rel)).sort(), '장부 실행 폴더의 파일이 SHA256SUMS의 작은 파일과 다르다');

      await assertCleanedUp('record');
      await assertNoSecrets('record', { dirs: [out, runDir, outbox], texts: [r.stdout + r.stderr] });
    });
  } finally {
    // 시험 행을 진짜 장부에 남기지 않는다(통과·실패와 상관없이)
    for (const d of mine) rmrf(d);
    for (const [dir, existed] of [
      [join(RAW_OUTBOX, 'runs'), outboxExisted.runs],
      [RAW_OUTBOX, outboxExisted.root],
    ]) {
      if (!existed && existsSync(dir) && readdirSync(dir).length === 0) rmrf(dir);
    }
  }
  for (const d of mine) assert.equal(existsSync(d), false, `시험이 장부 행·원본을 남겼다: ${d}`);
});

test('BSL090_S-T15_K5랩2회(seatmap-lab.mjs --reps 2)_lab.json·rows.json·infra.txt를남기고_요약은회마다의줄로다시낸값과같으며_입구포트전달8443·Chrome프로필·Chrome프로세스를남기지않는다', opts(MINUTES.k5), async (t) => {
  const chrome = process.env.PEAKET_K5_CHROME || playwrightChrome();
  if (!chrome || !existsSync(chrome)) {
    t.skip('Chrome을 찾지 못했다(이 PC의 %LOCALAPPDATA%\\ms-playwright\\chromium-*\\chrome-win64\\chrome.exe 또는 환경 값 PEAKET_K5_CHROME)');
    return;
  }
  if (await portOpen(V0_FORWARD_PORT)) {
    t.skip(`127.0.0.1:${V0_FORWARD_PORT}을 이미 다른 프로그램이 쓰고 있다(입구 포트 전달 node tools/local/cluster.mjs v0-forward 등). 닫은 뒤 다시 돌린다`);
    return;
  }
  const profilesBefore = new Set(tmpEntries(K5_PROFILE));
  const pfBefore = processesLike('port-forward');
  const chromeBefore = processesLike('k5-chrome-');
  await withOut('k5', async (out) => {
    const args = ['--reps', '2', '--out', out, ...(process.env.PEAKET_K5_CHROME ? ['--chrome', chrome] : [])];
    const r = await runProc(process.execPath, [K5_LAB, ...args], { killAfterMs: killAfter(MINUTES.k5) });

    // 끝나고 10초 안에 포트 전달·Chrome 프로필이 사라져야 한다. 남은 것은 다음 시험에 섞이지 않게 지우고(끝내고) 아래에서 판정한다
    const until = Date.now() + 10_000;
    let open = await portOpen(V0_FORWARD_PORT);
    let profiles = tmpEntries(K5_PROFILE).filter((d) => !profilesBefore.has(d));
    while ((open || profiles.length) && Date.now() < until) {
      await sleep(500);
      open = await portOpen(V0_FORWARD_PORT);
      profiles = tmpEntries(K5_PROFILE).filter((d) => !profilesBefore.has(d));
    }
    const pfLeft = newProcesses(pfBefore, 'port-forward', ['svc/v0-gateway', `${V0_FORWARD_PORT}:8443`]);
    const chromeLeft = newProcesses(chromeBefore, 'k5-chrome-');
    for (const pid of [...(pfLeft ?? []), ...(chromeLeft ?? [])]) {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 30_000, windowsHide: true });
      } catch {
        // 그사이 끝났다
      }
    }
    for (const d of profiles) rmrf(join(tmpdir(), d));
    if (pfLeft === null || chromeLeft === null) console.log('# k5: 프로세스 목록(PowerShell)을 읽지 못해 남은 포트 전달·Chrome 프로세스는 포트와 프로필 폴더로만 본다');

    assert.equal(r.code, 0, exitMessage('seatmap-lab', r, 0));
    assert.equal(open, false, `입구 포트 전달(127.0.0.1:${V0_FORWARD_PORT})이 남았다${pfLeft?.length ? `(kubectl PID ${pfLeft.join(', ')})` : ''}`);
    assert.deepEqual(profiles, [], 'Chrome 프로필 폴더(k5-chrome-*)가 남았다');
    if (pfLeft) assert.deepEqual(pfLeft, [], '입구 포트 전달 kubectl 프로세스가 남았다');
    if (chromeLeft) assert.deepEqual(chromeLeft, [], '이 랩이 띄운 Chrome 프로세스가 남았다');

    for (const f of ['lab.json', 'rows.json', 'infra.txt']) assert.ok(existsSync(join(out, f)), `${f}가 없다`);
    assert.ok(readFileSync(join(out, 'infra.txt'), 'utf8').trim().length > 0, 'infra.txt가 비었다');
    const lab = readJson(out, 'lab.json');
    const rows = readJson(out, 'rows.json');
    console.log(`# k5: ${JSON.stringify(lab.summary)}, 홀드 못 한 회 ${lab.notHeld}`);
    assert.ok(Array.isArray(rows) && rows.length === 2, `rows.json은 회마다 한 줄(2줄)이다: ${rows?.length}`);
    assert.deepEqual(
      rows.map((x) => x.rep),
      [1, 2],
      'rows.json의 회 번호',
    );
    for (const x of rows) {
      assert.ok(Number.isFinite(x.drawMs) && x.drawMs >= 0, `회 ${x.rep} drawMs: ${x.drawMs}`);
      for (const k of ['inpMs', 'lcpMs', 'cls']) assert.ok(x[k] === null || (Number.isFinite(x[k]) && x[k] >= 0), `회 ${x.rep} ${k}: ${x[k]}`);
      for (const k of ['loafCount', 'longTasks']) assert.ok(isCount(x[k]), `회 ${x.rep} ${k}: ${x[k]}`);
      assert.ok(Number.isFinite(x.heapMb) && x.heapMb > 0, `회 ${x.rep} heapMb: ${x.heapMb}`);
      assert.ok(typeof x.picked === 'boolean' && typeof x.held === 'boolean', `회 ${x.rep} picked·held`);
    }
    assert.equal(lab.reps, 2, 'lab.json reps');
    assert.equal(lab.summary?.reps, 2, 'lab.json summary.reps');
    assert.ok(Number.isFinite(lab.summary.drawMs?.p75), `좌석맵 그리기 p75: ${lab.summary.drawMs?.p75}`);
    const pick = ({ rep, drawMs, inpMs, lcpMs, cls, loafCount, loafMs, longTasks, heapMb }) => ({ rep, drawMs, inpMs, lcpMs, cls, loafCount, loafMs, longTasks, heapMb });
    assert.deepEqual(lab.summary, summarizeLab(rows.map(pick)), 'lab.json 요약이 rows.json으로 다시 낸 요약(summarizeLab)과 다르다');
    assert.deepEqual(
      { seats: lab.seats, throttle: lab.throttle, viewport: lab.viewport, notHeld: lab.notHeld },
      { seats: 50000, throttle: 4, viewport: { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true }, notHeld: rows.filter((x) => !x.held).length },
      'K5 조건(5만 석, CPU 4배 느리게, 중급 모바일 화면)과 홀드 못 한 회 수',
    );
    assert.match(lab.eventId, UUID);
    assert.ok(typeof lab.chrome === 'string' && lab.chrome.length > 0, `lab.json chrome: ${lab.chrome}`);

    await assertNoSecrets('k5', { dirs: [out], texts: [r.stdout + r.stderr] });
  });
});

test('BSL090_D-T40_야간비교한판(config-aa.json을rounds1로)_nightly.py run이기준·새판p99와비율을결과JSON에남기고_판마다본구간요약을견주며_A/A라두판이같은이미지이고_v0-base의앱·입구가준비된다(이미지를다시빌드해10~15분)', opts(MINUTES.nightly), async (t) => {
  // 준비 명령(prepare.mjs --aa)이 cluster.mjs v0로 v0 이미지를 다시 빌드·배포하고(시뮬레이터 시험 키·원장이 새로 된다) v0-base를 올린다
  if (!pythonOk()) {
    t.skip(`Python 3(${PYTHON})를 부르지 못한다(nightly.py)`);
    return;
  }
  const hadBase = await namespaceExists(V0_BASE_NAMESPACE);
  const summaryFiles = ['00-base.json', '00-new.json'].map((f) => join(NIGHTLY_SUMMARY_DIR, f));
  // nightly.py는 같은 이름의 지난 요약을 먼저 지우고 새로 쓴다. 시험 전 요약(지난 야간 비교 몫)은 끝에 그대로 되돌린다
  const summaryDirExisted = existsSync(NIGHTLY_SUMMARY_DIR);
  const summaryBackup = summaryFiles.map((f) => (existsSync(f) ? readFileSync(f) : null));
  const nightlyTmpBefore = new Set(tmpEntries(NIGHTLY_TMP));
  try {
    await withOut('nightly', async (out) => {
      mkdirSync(out, { recursive: true });
      const config = { ...JSON.parse(readFileSync(NIGHTLY_AA_CONFIG, 'utf8')), rounds: 1 };
      assert.deepEqual(config.prepare, ['node', 'loadtest/nightly/prepare.mjs', '--aa'], 'config-aa.json의 준비 명령이 A/A(--aa)가 아니다');
      const cfgFile = join(out, 'config-aa-r1.json');
      writeFileSync(cfgFile, JSON.stringify(config, null, 2));
      const resultsFile = join(out, 'results.json');
      const r = await runProc(PYTHON, ['-I', '-X', 'utf8', NIGHTLY, 'run', '--config', cfgFile, '--out', resultsFile], { killAfterMs: killAfter(MINUTES.nightly) });
      if (r.killed && ready) await recover('야간 비교를 한도에서 끊음');
      assert.equal(r.code, 0, exitMessage('nightly.py run', r, 0));

      const res = readJson(out, 'results.json');
      console.log(`# nightly: ${JSON.stringify(res)}`);
      assert.equal(res.scenario, config.scenario, '결과 scenario');
      assert.equal(res.rounds, 1, '결과 rounds');
      assert.ok(Number.isFinite(Date.parse(res.started_at)) && Number.isFinite(Date.parse(res.ended_at)), `결과 시각: ${res.started_at} ~ ${res.ended_at}`);
      assert.deepEqual(
        res.runs.map((x) => `${x.round}:${x.side}`),
        ['1:base', '1:new'],
        '기준·새를 번갈아 한 번씩 재야 한다',
      );
      for (const x of res.runs) assert.ok(Number.isFinite(x.p99_ms) && x.p99_ms > 0, `${x.side} p99: ${x.p99_ms}`);
      assert.ok(Number.isFinite(res.base_p99_ms) && res.base_p99_ms > 0 && Number.isFinite(res.new_p99_ms) && res.new_p99_ms > 0, `판별 p99: 기준 ${res.base_p99_ms}, 새 ${res.new_p99_ms}`);
      assert.equal(res.base_p99_ms, res.runs[0].p99_ms, '한 판이면 기준 p99 중앙값은 그 판의 값이다');
      assert.equal(res.new_p99_ms, res.runs[1].p99_ms, '한 판이면 새 p99 중앙값은 그 판의 값이다');
      assert.ok(Number.isFinite(res.ratio) && res.ratio > 0, `비율: ${res.ratio}`);
      assert.equal(res.ratio, Math.round((res.new_p99_ms / res.base_p99_ms) * 1e6) / 1e6, '비율은 새 ÷ 기준(소수 여섯째 자리)이다');

      // 판마다 실행 도구가 쓴 본구간 요약(http_req_duration = 본구간 값)을 옮겨 견준다
      summaryFiles.forEach((f, i) => {
        assert.ok(existsSync(f), `야간 비교 요약이 없다: ${f}`);
        const s = JSON.parse(readFileSync(f, 'utf8'));
        assert.deepEqual(s.metrics?.http_req_duration, s.metrics?.['http_req_duration{phase:main}'], `${basename(f)}: http_req_duration이 본구간 값이 아니다(실행 도구의 summary.json을 옮기지 않았다)`);
        assert.equal(s.metrics.http_req_duration.values['p(99)'], res.runs[i].p99_ms, `${basename(f)}의 p99가 결과의 ${res.runs[i].side} p99와 다르다`);
      });

      // 두 판 모두 준비됐고, A/A라 같은 이미지다(D-T40 ①)
      for (const ns of [V0_BASE_NAMESPACE, V0_NAMESPACE]) {
        for (const d of ['v0-monolith', 'v0-gateway']) {
          await kc(['-n', ns, 'rollout', 'status', `deploy/${d}`, '--timeout=120s'], { timeout: 150_000 });
          const image = (await kc(['-n', ns, 'get', `deploy/${d}`, '-o', 'jsonpath={.spec.template.spec.containers[0].image}'])).trim();
          assert.equal(image, V0_IMAGES.app, `${ns}/${d}의 이미지가 A/A 기준(${V0_IMAGES.app})이 아니다`);
        }
        const gw = await gatewayState(ns);
        assert.ok(gw.replicas >= 1 && gw.ready === gw.replicas, `${ns}/v0-gateway가 준비되지 않았다: ${JSON.stringify(gw)}`);
      }
      assert.deepEqual(
        tmpEntries(NIGHTLY_TMP).filter((d) => !nightlyTmpBefore.has(d)),
        [],
        '야간 비교 도구의 임시 폴더(nightly-run-*·nightly-src-*)가 남았다',
      );

      await assertCleanedUp('nightly');
      await assertNoSecrets('nightly', { dirs: [out], files: summaryFiles, texts: [r.stdout + r.stderr] });
    });
  } finally {
    summaryFiles.forEach((f, i) => {
      if (summaryBackup[i] === null) rmSync(f, { force: true });
      else writeFileSync(f, summaryBackup[i]);
    });
    if (!summaryDirExisted && existsSync(NIGHTLY_SUMMARY_DIR) && readdirSync(NIGHTLY_SUMMARY_DIR).length === 0) rmrf(NIGHTLY_SUMMARY_DIR);
    if (!hadBase) {
      // 시험 전 클러스터로 되돌린다(이 판의 앱·입구가 다음 측정의 자원을 쓰지 않게). 다음 야간 비교의 준비 명령이 다시 올린다
      console.log(`# nightly: 시험 전에 없던 네임스페이스 ${V0_BASE_NAMESPACE}를 지운다`);
      await kc(['delete', 'namespace', V0_BASE_NAMESPACE, '--ignore-not-found', '--wait=true', '--timeout=300s'], { timeout: 320_000 }).catch((err) => console.log(`# nightly: ${V0_BASE_NAMESPACE} 지우기 실패(${firstLine(err)})`));
    }
  }
});

// ⚠ 이 시험은 결제사가 승인한 뒤 응답을 버리게 해(--fault-drop-pct) 불변식 P6을 일부러 깬다. 그래서 이 파일의 마지막 시험이다.
// 이 뒤에 같은 클러스터에서 돈 --invariants 실행은 이 위반을 본다(검사기는 v0 DB 전체와 시뮬레이터 원장 전체를 본다). 새로 올린 클러스터에서
// 돌리거나 그것을 받아들인다(docs/verification.md §3.10 '공통 규칙': 결제사 장애를 넣는 실행은 다른 측정을 모두 마친 뒤)
test('BSL090_P-T1_결제사가승인뒤응답을버리면(--fault-drop-pct 20)_v0는주문을실패로끝내고_결제사승인만남아불변식P6위반으로잡히며_장애를넣은실행은불변식FAIL이어도종료코드0이고_payment-state.json을남긴다(불변식을깨는마지막시험)', opts(MINUTES.payment), async () => {
  const srcNewest = Math.max(...readdirSync(join(CHECKER, 'src')).filter((f) => f.endsWith('.ts')).map((f) => statSync(join(CHECKER, 'src', f)).mtimeMs));
  for (const f of ['cli.js', 'invariants.js']) {
    const p = join(CHECKER, 'dist', f);
    assert.ok(existsSync(p) && statSync(p).mtimeMs >= srcNewest, `검사기 빌드 ${p}가 없거나 src보다 오래됐다. 먼저 pnpm --filter @peaket/invariant-checker build`);
  }
  await withOut('payment-fault', async (out) => {
    // 사용자 100명 ≥ 5 × (2 + 10) + 2. 본구간은 사용자 0번부터, 예열은 99번부터 쓰므로 응답 버림(번호 % 100 < 20)은 본구간 앞 20명에만 걸린다
    const P = { users: 100, rate: 5, warmS: 2, mainS: 10, seatsPerOrder: 2, dropPct: 20 };
    const argv = [
      'v0',
      'payment',
      ...['--users', P.users, '--rate', P.rate, '--warm', P.warmS, '--main', P.mainS, '--seats-per-order', P.seatsPerOrder, '--fault-drop-pct', P.dropPct, '--fault-delay-pct', 0].map(String),
      '--invariants',
      // --settle: 바로 앞 야간 비교(조회 약 760/s)가 늘린 앱 복제를 HPA가 이 실행 도중에 줄이면 결제 중인 앱 파드가 끝나 멈춘 주문·좌석 누수 0을 볼 수 없다
      '--settle',
      ...SMALL_GEN_ARGS,
      '--out',
      out,
    ];
    const a = parseArgs(argv);
    assert.deepEqual(
      { faultDropPct: a.faultDropPct, faultDelayPct: a.faultDelayPct, killAppAtS: a.killAppAtS, invariants: a.invariants, settle: a.settle },
      { faultDropPct: 20, faultDelayPct: 0, killAppAtS: undefined, invariants: true, settle: true },
      '시험 인자',
    );
    const r = await runCli(argv, killAfter(MINUTES.payment));
    // 종료 코드 0: 장애를 넣은 실행은 불변식이 FAIL이어도 실행을 마치고 산출물을 썼으면 0이다(loadtest/README.md '종료 코드', run.mjs)
    const { run, summary, notes } = assertRunCommon('payment-fault', out, r, { scenario: 'payment', generators: 1, ...SMALL_GEN, prepS: prepSeconds(P.users), warmS: P.warmS, mainS: P.mainS, prepMinReqs: 2 * P.users });
    for (const f of ['payment-state.json', 'invariants.csv', join('invariants', 'invariants-detail.ndjson')]) assert.ok(existsSync(join(out, f)), `${f}가 없다`);
    assert.ok(notes.includes(`결제사 장애: 응답 버림 ${P.dropPct}%`), 'notes.txt에 결제사 장애가 없다');

    // 장애를 건 결제(번호 % 100 < 20이고 결제 확정 앞까지 간 사람): 본구간의 sim_fault 요청이 모두 204였다
    const routes = assertMainRoutes('payment-fault', summary, MAIN_ROUTES.payment);
    const armed = routes.sim_fault ?? 0;
    assert.equal(metric(summary, 'http_req_failed{phase:main,route:sim_fault}')?.passes ?? 0, 0, '결제사 장애를 걸지 못한 요청이 있다(POST /sim/faults가 204가 아님)');
    const mainIters = routes.hold ?? 0;
    const mayDrop = Array.from({ length: mainIters + 1 }, (_, i) => i).filter((i) => faultFor(i, P.dropPct, 0) === 'drop').length;
    const paymentFailed = metric(summary, 'http_req_failed{phase:main,route:payment}')?.passes ?? 0;
    console.log(`# payment-fault: 본구간 결제 ${mainIters}건, 응답 버림을 건 결제 ${armed}건(걸 수 있던 ${mayDrop}건), 결제 확정 실패 ${paymentFailed}건`);
    assert.ok(armed >= 1 && armed <= mayDrop, `응답 버림을 건 결제 ${armed}건이 1~${mayDrop}건(본구간 번호 % 100 < ${P.dropPct})이 아니다`);
    assert.ok(paymentFailed >= 1, '응답을 버린 결제가 있는데 결제 확정 실패가 없다');

    // 결제 실행 뒤 v0 표 상태(이 회차): 응답을 잃은 결제는 실패로 끝나고 좌석을 돌려준다(docs/features/payment.md §13 v0). 앱을 끝내지 않았으니 누수·멈춘 주문이 없다
    const st = readJson(out, 'payment-state.json');
    console.log(`# payment-fault 표 상태: ${JSON.stringify(st)}`);
    for (const k of ['seatLeak', 'ordersPaying', 'ordersApproved', 'ordersConfirmed', 'ordersFailed', 'paymentsConfirming', 'paymentsApproved', 'paymentsFailed']) assert.ok(isCount(st[k]), `payment-state.json ${k}: ${st[k]}`);
    assert.ok(st.ordersFailed >= 1, '응답을 버린 결제가 있는데 실패로 끝난 주문이 없다');
    assert.deepEqual(
      { seatLeak: st.seatLeak, ordersPaying: st.ordersPaying, ordersApproved: st.ordersApproved, paymentsConfirming: st.paymentsConfirming },
      { seatLeak: 0, ordersPaying: 0, ordersApproved: 0, paymentsConfirming: 0 },
      '앱을 끝내지 않은 실행인데 좌석 누수나 멈춘 주문·결제가 있다',
    );

    // 불변식: P6(결제사 승인인데 결제 원장에 없음)이 FAIL이고 위반 1건 이상(v0 한계). 이중 결제는 없다(K7 ② 목표, P1·P2)
    const inv = invariantRows(out);
    console.log(`# payment-fault 불변식: ${Object.entries(inv).map(([id, v]) => `${id}=${v.result}${v.violations ? `(${v.violations})` : ''}`).join(' ')}`);
    assert.equal(inv.P6?.result, 'FAIL', `P6이 FAIL이 아니다(응답을 버린 결제 ${armed}건): ${JSON.stringify(inv.P6)}`);
    assert.ok(inv.P6.violations >= 1, `P6 위반: ${inv.P6.violations}`);
    for (const id of ['P1', 'P2']) assert.equal(inv[id]?.result, 'PASS', `${id}(이중 결제)가 PASS가 아니다: ${JSON.stringify(inv[id])}`);
    assert.equal(run.exitCode, 0, '불변식 FAIL이 있어도 장애를 넣은 실행의 종료 코드는 0이다');

    // 이 회차의 P6 위반(위반 행의 order=…): 1건 이상이고, 장애를 건 결제 수 이하이며, 모두 실패로 끝난 이 회차 주문이다
    const orders = await eventOrders(run.eventId);
    const statusOf = new Map(orders.map((o) => [o.id, o.status]));
    const detail = parseNdjson('invariants-detail.ndjson', readFileSync(join(out, 'invariants', 'invariants-detail.ndjson'), 'utf8')).filter((d) => d.id === 'P6');
    if (detail.some((d) => d.truncated)) {
      console.log(`# payment-fault: P6 위반 행이 1,000줄을 넘어 잘렸다(지난 실행의 위반이 쌓인 클러스터). 이 회차 몫은 세지 않는다`);
    } else {
      const mineP6 = detail.map((d) => /order=(\S+)/.exec(String(d.detail))?.[1]?.toLowerCase()).filter((id) => statusOf.has(id));
      console.log(`# payment-fault: P6 위반 전체 ${inv.P6.violations}건, 이 회차 ${mineP6.length}건`);
      assert.ok(mineP6.length >= 1, `이 회차의 P6 위반이 없다(응답을 버린 결제 ${armed}건)`);
      assert.ok(mineP6.length <= armed, `이 회차의 P6 위반 ${mineP6.length}건이 응답을 버린 결제 ${armed}건보다 많다(장애 없는 결제가 결제 원장에서 빠졌다)`);
      assert.deepEqual(
        mineP6.filter((id) => statusOf.get(id) !== 'FAILED').map((id) => `${id}:${statusOf.get(id)}`),
        [],
        'P6 위반인 이 회차 주문이 실패(FAILED)로 끝나지 않았다',
      );
    }

    await assertCleanedUp('payment-fault');
    await assertNoSecrets('payment-fault', { dirs: [out], texts: [r.stdout + r.stderr] });
  });
});
