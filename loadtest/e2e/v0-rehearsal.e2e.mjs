// v0 부하 리허설 e2e(docs/verification.md §3.9 'k6 시나리오와 부하 발생기', docs/perf-ledger.md §3 1·2번, wbs 1.2.1).
// 실행 도구 `node loadtest/run.mjs`를 셸 없이 불러 작은 규모로 끝까지 돌리고 산출물과 v0 DB를 본다:
// - 사용 오류는 클러스터를 건드리기 전에 종료 코드 2로 끝나고 아무것도 만들지 않는다
// - v0 queue·seat-hold(hot·crossed)·payment 리허설: 산출물 파일, 시험 기록(검사기의 parseRecords로 읽는다), invariants.csv,
//   요약의 본구간·경로 지표(준비 구간 요청이 본구간에 섞이지 않음, 본구간 요청 수 = 도착률 계획), 발생기 지표와 판정(generator.json),
//   v0 DB의 이 회차 행(결제는 주문마다 CONFIRMED·승인·티켓·결제사 승인 하나, 홀드는 고른 방식의 좌석)
// - calibrate: 단계별 결과와 용량(calibration.json), 빈 응답 대역·발생기 파드 정리, --record 없이 성능 장부를 건드리지 않음
// - 끝으로 모든 산출물과 실행 도구 출력에 토큰·시험 키·서명 개인키가 없고, 네임스페이스 loadtest에 파드·Secret·빈 응답 대역이, kind 노드에
//   이 시험이 만든 실행 폴더(/var/local/peaket-loadtest/<실행>, 토큰이 든다)가 남지 않음
//
// 실행(저장소 뿌리. 이 파일 하나만 돌려도 된다):
//   node tools/local/cluster.mjs up && node tools/local/cluster.mjs v0
//   pnpm --filter @peaket/invariant-checker build
//   node --test loadtest/e2e/v0-rehearsal.e2e.mjs
// 전제(어기면 before 훅이 까닭과 할 일을 적고 모든 시험이 실패한다. 건너뛰지 않는다):
// 1. 클러스터 peaket에 v0(v0-gateway·v0-monolith·pg-simulator)가 준비돼 있다. --invariants는 v0 DB 전체와 시뮬레이터 원장 전체(시뮬레이터가
//    뜬 뒤의 모든 승인)를 보므로, 장애를 넣거나 불변식을 일부러 깨뜨린 시험을 돌린 클러스터가 아니라 새로 올린 클러스터에서 돌린다(loadtest/README.md)
// 2. 검사기 빌드(services/invariant-checker/dist)가 src보다 새것이다. 검사기의 src/records.ts는 생성자 매개변수 속성 때문에 Node 타입 지우기로
//    읽지 못해(2026-11-03) 이 시험도 dist를 읽는다
// 3. 네임스페이스 loadtest에 파드·Secret·빈 응답 대역이 없다. 이 시험은 그 네임스페이스를 혼자 쓴다고 보고 다른 부하 실행과 함께 돌리지 않는다(시험도 하나씩 돈다)
// 4. 시험 토큰 서명 키(.cache/peaket-tools/v0-token-key.json, cluster.mjs v0가 만든다)와 실행 도구가 쓰는 Docker 엔진·openssl이 있고,
//    kind 노드 컨테이너 peaket-control-plane에 docker exec로 닿는다(실행 도구가 발생기 입력을 그 안 실행 폴더에 docker cp로 넣는다)
// 그 밖:
// - 실행 폴더는 OS 임시 폴더 아래 peaket-lt-e2e-*에 남긴다(토큰이 없어야 하므로 남겨도 된다. 마지막 시험이 그것을 본다)
// - 시각은 같은 시계끼리만 견준다: 시험 기록·구간 표시·cgroup 표본은 kind 노드 시계, run.json 시각은 이 PC 시계다(WSL2 시계는 잠자기 뒤 어긋날 수 있다)
// - 실행 도구가 한도(RUN_KILL_MS)를 넘으면 끊는다. Windows의 kill은 곧바로 끝내서 실행 도구의 정리(finally)가 돌지 않으므로 이 시험이 발생기 파드·
//   빈 응답 대역·시험 키 Secret과 이 시험 동안 생긴 노드 실행 폴더를 지운다. 모든 시험이 끝난 뒤(after)에도 남은 것을 지운다
//   (before가 네임스페이스 loadtest에서 미리 있던 객체를 찾으면 지우지 않고 멈춘다. 미리 있던 노드 실행 폴더는 적기만 하고 건드리지 않는다)
// - kubectl은 동기로 돌아 멈추면 시험 한도가 끼어들지 못하므로 부를 때마다 시간 한도를 준다
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KUBECONFIG, V0_NAMESPACE, V0_TOKEN_KEY_FILE, kubectl } from '../../tools/local/cluster.mjs';
import { pollStages } from '../lib/model.mjs';
import { accountRef } from '../lib/users.mjs';
import { UsageError, parseArgs } from '../runner/args.mjs';
import { KIND_NODE, LOADGEN_NAMESPACE, NODE_ROOT, NULL_TARGET_NAME, SIM_KEY_SECRET } from '../runner/manifests.mjs';
import { calibrationCapacity, judgeCalibrationStep, judgeGenerator, perVuBytes as perVuBytesOf } from '../runner/results.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO, 'loadtest', 'run.mjs');
const CHECKER = join(REPO, 'services', 'invariant-checker');
const LT = LOADGEN_NAMESPACE;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 발생기 몫(기본 CPU 4·4GiB는 이 PC의 kind 노드에서 v0와 함께 자리를 못 잡을 수 있어 작게 준다) */
const GEN = { cpus: 2, memoryMi: 1024 };
const GEN_ARGS = ['--cpus', String(GEN.cpus), '--memory-mi', String(GEN.memoryMi)];
/** v0 실행 산출물(docs/verification.md §3.9 '기록과 산출물') */
const V0_FILES = ['run.json', 'summary.json', 'console.ndjson', 'records.ndjson', 'generator.json', 'cgroup.log', 'k6.log', 'infra.txt'];
/** 본구간에 나올 수 있는 경로(docs/verification.md §3.9 '시나리오'). 진입(entry)과 좌석·결제의 준비 구간 입장 확정(admission)은 본구간에 없어야 한다 */
const MAIN_ROUTES = Object.freeze({ queue: ['status', 'admission'], 'seat-hold': ['hold', 'release'], payment: ['hold', 'order', 'sim_auth', 'payment', 'order_view'] });
/** 검사기 불변식(services/invariant-checker/src/invariants.ts) 가운데 원본 DB만 보는 것과 시험 기록이 있어야 하는 것. M1~M5는 v0에 정산 표가 없어 SKIPPED다 */
const DB_IDS = ['S1', 'S2', 'S3', 'S4', 'P1', 'P3', 'P4', 'P5'];
const RECORD_IDS = ['Q1', 'Q2', 'P2', 'P6'];
const S_IDS = ['S1', 'S2', 'S3', 'S4'];
/** 산출물에 있으면 안 되는 비밀의 꼴(ASVS v5.0.0-13.3.1·14.2.4). 맞은 글은 메시지에 싣지 않는다 */
const SECRET_PATTERNS = [
  ['JWT 꼴 토큰', /eyJ[\w-]{4,}\.eyJ[\w-]{4,}/],
  ['액세스 토큰 쿠키 값', /__Secure-peaket_at=[^;\s"']{8,}/],
  ['시뮬레이터 시험 키', /sim_sk_/],
  ['개인키 PEM', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['JWK 개인키 칸(d)', /"d"\s*:\s*"[\w-]{40,}"/],
];

/** 실행 도구 강제 종료 한도(시험 한도보다 짧게 둬서 끊고 정리할 틈을 남기고 다음 시험과 겹쳐 돌지 않게 한다) */
const RUN_KILL_MS = 25 * 60_000;
/** 사용 오류 실행의 강제 종료 한도(15초 안에 끝나야 한다. 클러스터를 건드려 멈춘 실행이 시험 한도를 넘기지 않게) */
const USAGE_KILL_MS = 20_000;
const QUICK = { concurrency: false, timeout: 8 * 60_000 };
const SLOW = { concurrency: false, timeout: 30 * 60_000 };

// ---- 공유 상태(before에서 채운다) ----
let ready = false;
let TMP = '';
/** 이 파일이 부른 실행 도구의 표준 출력·오류 전부(마지막 시험이 비밀을 찾는다) */
let cliOutput = '';
/** 돌고 있는 실행 도구(after가 끈다) */
const children = new Set();
/** 산출물에서 글자 그대로 찾을 비밀 값 [이름, 값](시뮬레이터 시험 키, 시험 토큰 서명 개인키 d). 값은 어디에도 찍지 않는다 */
const literalSecrets = [];
/** 검사기 dist의 parseRecords와 불변식 ID 목록(INVARIANTS 차례) */
let parseRecords;
let invariantIds = [];
/** 시험 전에 kind 노드에 이미 있던 실행 폴더(이 시험이 만들지 않았으므로 남은 객체로 세지도 지우지도 않는다) */
let nodeDirsBefore = new Set();

// ───────────── 작은 도구 ─────────────

const kc = (args, o = {}) => kubectl(args, { quiet: true, timeout: 90_000, ...o });
const readJson = (dir, file) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
const tail = (s, n = 3000) => String(s).slice(-n);
const firstLine = (err) => String(err?.stderr || err?.message || err).trim().split('\n')[0];
/** 요약 지표의 값 묶음(없으면 undefined) */
const metric = (summary, key) => summary.metrics?.[key]?.values;
/** 좌석·결제의 준비 구간 길이(초): 모두 진입·입장시키는 데 2 × ceil(users ÷ min(users, 200)) + 3초(실행 도구 계약) */
const prepSeconds = (users) => 2 * Math.ceil(users / Math.min(users, 200)) + 3;

/** 실행 도구를 셸 없이 부른다. 출력은 그대로 시험 로그로 흘리고 모아 둔다. 한도를 넘으면 끊고 네임스페이스 loadtest를 정리한다 */
function runCli(args, killAfterMs = RUN_KILL_MS) {
  return new Promise((done, fail) => {
    const started = Date.now();
    const child = spawn(process.execPath, [CLI, ...args], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    children.add(child);
    let stdout = '';
    let stderr = '';
    let killed = false;
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
      child.kill();
    }, killAfterMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      children.delete(child);
      fail(err);
    });
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      cliOutput += stdout + stderr;
      // 끊긴 실행 도구는 발생기 파드를 지우지 못한다. 그 파드가 다음 시험의 부하에 섞이지 않게 여기서 지운다
      if (killed && ready) await cleanupLoadtest(`실행 도구를 ${killAfterMs / 1000}초 한도에서 끊음`);
      done({ code: code ?? -1, signal, killed, stdout, stderr, ms: Date.now() - started });
    });
  });
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
/** 이 시험 동안 생긴 노드 실행 폴더 이름 */
const newNodeDirs = () => nodeRunDirs().filter((d) => !nodeDirsBefore.has(d));

/**
 * 실행이 남기면 안 되는 객체: 네임스페이스 loadtest의 모든 파드(발생기·빈 응답 대역)와 모든 Secret(시험 키·빈 응답 대역 TLS 키·토큰이 들 수 있다),
 * 빈 응답 대역의 Deployment·Service·ConfigMap, 이 시험 동안 생긴 kind 노드의 실행 폴더(토큰이 든다)
 */
async function leftovers() {
  const dirs = newNodeDirs().map((d) => `${KIND_NODE}:${NODE_ROOT}/${d}`);
  if (!(await kc(['get', 'namespace', LT, '--ignore-not-found', '-o', 'name'])).trim()) return dirs;
  const all = await kc(['-n', LT, 'get', 'pods,secrets', '-o', 'name']);
  const named = await kc(['-n', LT, 'get', `deployment/${NULL_TARGET_NAME}`, `service/${NULL_TARGET_NAME}`, `configmap/${NULL_TARGET_NAME}`, '--ignore-not-found', '-o', 'name']);
  return [...new Set(`${all}\n${named}`.split(/\s+/).filter(Boolean)), ...dirs].sort();
}

/** 지우는 중(Terminating)인 파드가 사라질 때까지 2분 기다린 뒤에도 남은 객체가 있으면 실패 */
async function assertCleanedUp(what) {
  const end = Date.now() + 120_000;
  let left = await leftovers();
  while (left.length && Date.now() < end) {
    await sleep(3000);
    left = await leftovers();
  }
  assert.deepEqual(left, [], `${what}: 네임스페이스 ${LT}에 남은 객체`);
}

/**
 * 실행 도구가 만드는 객체(발생기 파드, 빈 응답 대역 넷, 시험 키 Secret)와 이 시험 동안 생긴 노드 실행 폴더(이름이 실행 꼬리표 꼴인 것만)를 지운다.
 * 실패는 적기만 한다
 */
async function cleanupLoadtest(why) {
  const steps = [
    ['-n', LT, 'delete', 'pod', '-l', 'app.kubernetes.io/name=loadgen', '--ignore-not-found', '--grace-period=5', '--timeout=60s'],
    ['-n', LT, 'delete', `deployment/${NULL_TARGET_NAME}`, `service/${NULL_TARGET_NAME}`, `configmap/${NULL_TARGET_NAME}`, `secret/${NULL_TARGET_NAME}`, `secret/${SIM_KEY_SECRET}`, '--ignore-not-found', '--timeout=60s'],
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

/** v0 DB의 교착 누적 수(pg_stat_database.deadlocks) */
async function v0Deadlocks() {
  const out = await v0Sql("select deadlocks from pg_stat_database where datname = 'v0'");
  assert.match(out, /^\d+$/, `pg_stat_database.deadlocks(v0)를 읽지 못했다: ${out}`);
  return Number(out);
}

/** 이 회차의 홀드(v0_hold): 수, 아직 HELD인 수, 홀드 하나의 좌석 수 최소·최대, 홀드한 서로 다른 좌석 수 */
async function eventHolds(eventId) {
  const e = eventLiteral(eventId);
  return JSON.parse(
    await v0Sql(
      `select json_build_object('holds', count(*), 'held', count(*) filter (where status = 'HELD'), 'minSize', min(cardinality(seat_ids)), 'maxSize', max(cardinality(seat_ids)), ` +
        `'seats', (select count(distinct u.s) from v0_hold h2 cross join lateral unnest(h2.seat_ids) as u(s) where lower(h2.event_id) = ${e})) from v0_hold where lower(event_id) = ${e}`,
    ),
  );
}

/** 따옴표 칸을 아는 작은 CSV 읽기(검사기 report.ts의 cell 규칙) */
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

/**
 * invariants.csv: 검사기 형식(머리, 불변식 목록과 차례 = INVARIANTS, as_of는 KST, PASS ⇔ 위반 0, SKIPPED는 건수 칸이 빔)이고,
 * FAIL이 하나도 없고, mustPass는 모두 PASS다(SKIPPED면 실행 도구가 검사기에 그 원본 DB나 시험 기록을 주지 않은 것이다)
 */
function assertInvariants(dir, mustPass) {
  const [header, ...rows] = parseCsv(readFileSync(join(dir, 'invariants.csv'), 'utf8'));
  assert.equal(header.join(','), 'id,name,sources,violations,unknown,result,as_of');
  const list = rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
  assert.deepEqual(
    list.map((r) => r.id),
    invariantIds,
    'invariants.csv의 불변식 목록·차례가 검사기(INVARIANTS)와 다르다',
  );
  for (const r of list) {
    assert.ok(['PASS', 'FAIL', 'SKIPPED'].includes(r.result), `${r.id}의 result: ${r.result}`);
    assert.match(r.as_of, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+09:00$/, `${r.id}의 as_of`);
    if (r.result === 'SKIPPED') {
      assert.ok(r.violations === '' && r.unknown === '', `${r.id}: SKIPPED인데 건수 칸이 있다`);
    } else {
      assert.match(`${r.violations} ${r.unknown}`, /^\d+ \d+$/, `${r.id}의 violations·unknown`);
      assert.equal(r.result === 'FAIL', Number(r.violations) > 0, `${r.id}: 결과 ${r.result}와 위반 ${r.violations}건이 맞지 않는다`);
    }
  }
  console.log(`# ${basename(dir)} 불변식: ${list.map((r) => `${r.id}=${r.result}${Number(r.unknown) > 0 ? `(모름 ${r.unknown})` : ''}`).join(' ')}`);
  const failed = list.filter((r) => r.result === 'FAIL').map((r) => `${r.id}(위반 ${r.violations})`);
  assert.deepEqual(failed, [], 'FAIL인 불변식이 있다(위반 행은 같은 폴더의 invariants-detail.ndjson)');
  const notPassed = mustPass.filter((id) => list.find((r) => r.id === id)?.result !== 'PASS');
  assert.deepEqual(notPassed, [], 'PASS여야 하는 불변식(SKIPPED면 검사기가 원본 DB나 시험 기록을 받지 못했다)');
}

/**
 * ramping-arrival-rate가 단계 동안 시작하는 반복 수. 도착률은 단계마다 앞 목표에서 이번 목표로 곧게 바뀌므로
 * 단계마다 사다리꼴 넓이((앞 목표 + 이번 목표) ÷ 2 × 단계 길이)를 더한다
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
 * 일정 도착률 구간의 요청 수. 도착률 실행기는 구간마다 반복을 도착률 × 길이번, 경계에서 한 번 더(+1)까지 시작하고(실행 도구 계약,
 * docs/verification.md §3.9 'v0-payment.js'), 놓친 반복(dropped)은 빠지며, 반복 하나가 그 경로 요청을 하나 보낸다.
 * 그래서 [계획 − 1 − dropped, 계획 + 구간 수]다(아래 1건은 경계 반올림 몫). 예열이나 준비 구간이 섞이면 수십~수백 건 넘친다
 */
function assertArrivalCount(at, got, expected, dropped, phases = 1) {
  assert.ok(
    Number.isSafeInteger(got) && got <= expected + phases && got >= expected - 1 - dropped,
    `${at}: ${got}건(계획 ${expected}건, 허용 ${expected - 1 - dropped}~${expected + phases}건, 놓친 반복 ${dropped}건)`,
  );
}

/**
 * 본구간 경로 지표: 경로별 본구간 요청 수의 합이 본구간 요청 수와 같고(모든 본구간 요청이 요약에 남은 경로 꼬리표를 달았다),
 * 요청이 있는 경로는 allowed 안이다(준비 구간의 진입·입장 확정이 본구간 꼬리표를 달지 않았다). 경로 → 본구간 요청 수를 돌려준다
 */
function assertMainRoutes(at, summary, allowed) {
  const main = metric(summary, 'http_reqs')?.count;
  const byRoute = {};
  for (const [k, v] of Object.entries(summary.metrics)) {
    const m = /^http_reqs\{phase:main,route:([a-z][a-z_]{0,31})\}$/.exec(k);
    if (m) byRoute[m[1]] = v.values?.count ?? 0;
  }
  const sum = Object.values(byRoute).reduce((a, b) => a + b, 0);
  assert.equal(sum, main, `${at}: 경로별 본구간 요청 수의 합(${JSON.stringify(byRoute)})이 본구간 요청 수 ${main}와 다르다(경로 꼬리표가 없거나 요약에 없는 경로가 본구간에 있다)`);
  const extra = Object.entries(byRoute)
    .filter(([r, n]) => n > 0 && !allowed.includes(r))
    .map(([r, n]) => `${r}:${n}`);
  assert.deepEqual(extra, [], `${at}: 본구간에 있으면 안 되는 경로(준비 구간 요청이 섞였다)`);
  return byRoute;
}

/**
 * 발생기 지표(generator.json·calibration.json 단계 하나)가 계약대로 지어졌는지: 구간 표시가 본구간 길이와 맞고, cgroup 표본은 본구간에서
 * 양 끝 1초씩 뺀 창의 1초 표본이며(창보다 많으면 다른 구간 표본이 섞였다), 메모리 %는 한도(memoryMi MiB) 대비이고, CPU 평균 ≤ 최대,
 * 가상 사용자당 메모리 = perVuBytes(lib)
 */
function assertGeneratorStats(at, { stats, marks, vusMax, perVuBytes }, { memoryMi, mainS }) {
  for (const k of ['cpuMeanPct', 'cpuMaxPct', 'memMaxPct', 'memMaxBytes', 'samples']) assert.ok(Number.isFinite(stats?.[k]), `${at} stats.${k}: ${stats?.[k]}`);
  assert.ok(Number.isSafeInteger(marks?.main_start) && Number.isSafeInteger(marks?.main_end), `${at} 구간 표시: ${JSON.stringify(marks)}`);
  const windowMs = marks.main_end - marks.main_start;
  // 표시는 본구간 경계에서 낸다(계약). 끝 표시는 진행 중인 반복을 기다린 뒤일 수 있어 뒤쪽을 넉넉히 둔다
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

/** 성능 장부 폴더의 파일 목록(이름·크기·수정 시각). --record 없는 실행 앞뒤로 같아야 한다 */
function ledgerSnapshot() {
  const root = join(REPO, 'docs', 'perf-ledger');
  if (!existsSync(root)) return '';
  return readdirSync(root, { recursive: true })
    .map(String)
    .sort()
    .map((p) => {
      const s = statSync(join(root, p));
      return s.isFile() ? `${p} ${s.size} ${s.mtimeMs}` : `${p}/`;
    })
    .join('\n');
}

const filesUnder = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name));

/**
 * v0 리허설 하나를 돌리고 모든 시나리오에 같은 것을 본다: 인자가 계약상 맞음, 종료 코드 0, 산출물 파일, run.json·summary.json·generator.json의
 * 꼴과 서로 맞음(발생기 판정 = judgeGenerator, dropped = 요약의 dropped_iterations), 요약은 본구간 값(http_reqs = http_reqs{phase:main})이고
 * 준비 구간 요청은 전체(_all)에만 있음, 발생기 지표
 * @param {{ users: number, prepS: number, warmS: number, mainS: number, prepMinReqs: number }} P
 */
async function rehearse(name, scenario, args, P) {
  const out = join(TMP, name);
  const withInvariants = args.includes('--invariants');
  const argv = ['v0', scenario, ...args, '--out', out];
  // 시험이 고른 인자가 계약(args.mjs)으로 맞는지 먼저 본다(틀리면 실행 도구가 아니라 시험이 틀렸다)
  assert.doesNotThrow(() => parseArgs(argv), `${name}: 시험 인자가 parseArgs를 통과하지 못한다`);
  const r = await runCli(argv);
  assert.equal(r.code, 0, exitMessage(name, r, 0));
  for (const f of [...V0_FILES, ...(withInvariants ? ['invariants.csv'] : [])]) assert.ok(existsSync(join(out, f)), `${name}: ${f}가 없다`);
  for (const f of ['infra.txt', 'cgroup.log']) assert.ok(readFileSync(join(out, f), 'utf8').trim().length > 0, `${name}: ${f}가 비었다`);

  const run = readJson(out, 'run.json');
  assert.equal(run.scenario, scenario, 'run.json scenario');
  assert.match(run.eventId, UUID);
  assert.match(run.runTag, /^[a-z0-9]{1,16}$/);
  assert.ok(run.args !== null && typeof run.args === 'object', 'run.json args');
  assert.ok([0, 99].includes(run.k6Exit), `run.json k6Exit: ${run.k6Exit}`);
  assert.equal(run.exitCode, r.code, 'run.json exitCode가 실행 도구 종료 코드와 다르다');
  const startedMs = Date.parse(run.startedAt);
  const endedMs = Date.parse(run.endedAt);
  assert.ok(typeof run.startedAt === 'string' && typeof run.endedAt === 'string' && Number.isFinite(startedMs) && Number.isFinite(endedMs), `run.json 시각: ${run.startedAt} → ${run.endedAt}`);
  // 같은 시계(이 PC). 실행은 준비 + 예열 + 본구간보다 짧을 수 없다
  const minRunMs = (P.prepS + P.warmS + P.mainS) * 1000;
  assert.ok(endedMs - startedMs >= minRunMs, `run.json 시각 사이 ${endedMs - startedMs}ms가 준비·예열·본구간 합 ${minRunMs}ms보다 짧다`);

  const summary = readJson(out, 'summary.json');
  for (const k of ['generated_at', 'metrics', 'root_group', 'options', 'state']) assert.ok(k in summary, `summary.json에 ${k}가 없다`);
  const mainReqs = metric(summary, 'http_reqs')?.count;
  assert.ok(mainReqs > 0, `본구간 요청 수: ${mainReqs}`);
  assert.equal(metric(summary, 'http_reqs{phase:main}')?.count, mainReqs, 'summary.json http_reqs가 본구간 값(http_reqs{phase:main})으로 바뀌지 않았다');
  for (const k of ['http_req_duration_all', 'http_req_failed_all', 'dropped_iterations']) assert.ok(summary.metrics[k], `summary.json에 ${k}가 없다`);
  // 준비 구간 요청(진입, 좌석·결제는 진입 + 입장 확정)은 전체에만 있다
  const allReqs = metric(summary, 'http_reqs_all')?.count;
  assert.ok(allReqs - mainReqs >= P.prepMinReqs, `전체 요청 ${allReqs} − 본구간 ${mainReqs}가 준비 구간 최소 ${P.prepMinReqs}건보다 적다(준비 구간 요청이 본구간에 섞였거나 전체 값이 없다)`);

  const gen = readJson(out, 'generator.json');
  assert.equal(gen.cpus, GEN.cpus);
  assert.equal(gen.memoryMi, GEN.memoryMi);
  assert.equal(gen.dropped, metric(summary, 'dropped_iterations')?.count ?? 0, 'generator.json dropped ≠ 요약의 dropped_iterations');
  assert.deepEqual(gen.judge, judgeGenerator({ dropped: gen.dropped, cpuMeanPct: gen.stats?.cpuMeanPct, memMaxPct: gen.stats?.memMaxPct }));
  assertGeneratorStats(name, gen, { memoryMi: GEN.memoryMi, mainS: P.mainS });
  console.log(`# ${name}: ${Math.round(r.ms / 1000)}초, 본구간 요청 ${mainReqs}(전체 ${allReqs}), 발생기 CPU 평균 ${gen.stats.cpuMeanPct}%·메모리 최대 ${gen.stats.memMaxPct}%, 판정 ${JSON.stringify(gen.judge)}`);
  return { out, run, summary, gen, records: readFileSync(join(out, 'records.ndjson'), 'utf8') };
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
    // 검사기 빌드(--invariants가 쓰고, 이 시험이 parseRecords·INVARIANTS를 읽는다)
    const src = join(CHECKER, 'src');
    const srcNewest = Math.max(...readdirSync(src).filter((f) => f.endsWith('.ts')).map((f) => statSync(join(src, f)).mtimeMs));
    for (const f of ['cli.js', 'records.js', 'invariants.js']) {
      const p = join(CHECKER, 'dist', f);
      if (!existsSync(p) || statSync(p).mtimeMs < srcNewest) throw new Error(`검사기 빌드 ${p}가 없거나 src보다 오래됐다. 먼저 pnpm --filter @peaket/invariant-checker build`);
    }
    parseRecords = (await import(pathToFileURL(join(CHECKER, 'dist', 'records.js')).href)).parseRecords;
    invariantIds = (await import(pathToFileURL(join(CHECKER, 'dist', 'invariants.js')).href)).INVARIANTS.map((d) => d.id);
    assert.equal(typeof parseRecords, 'function', '검사기 dist/records.js에 parseRecords가 없다');
    assert.ok(invariantIds.length > 0, '검사기 dist/invariants.js에 INVARIANTS가 없다');
    // kind 노드의 실행 폴더: 지금 있는 것은 이 시험이 만들지 않았다(남은 객체로 세지 않는다). 토큰이 들어 있을 수 있어 이름만 적는다
    try {
      nodeDirsBefore = new Set(nodeRunDirs());
    } catch (err) {
      throw new Error(`kind 노드 컨테이너 ${KIND_NODE}에 docker exec로 닿지 못했다(${firstLine(err)}). Docker 엔진과 클러스터 peaket을 먼저 올린다`);
    }
    if (nodeDirsBefore.size) console.log(`# 알림: ${KIND_NODE}:${NODE_ROOT}에 지난 실행 폴더가 있다(토큰이 들 수 있다. 이 시험은 지우지 않는다): ${[...nodeDirsBefore].join(', ')}`);
    // 다른 부하 실행이 돌고 있거나 지난 실행이 남긴 객체가 있으면 지우지 않고 멈춘다(누구 것인지 모른다)
    const left = await leftovers();
    if (left.length) {
      throw new Error(
        `네임스페이스 ${LT}에 이미 객체가 있다: ${left.join(', ')}. 다른 부하 실행이 돌고 있으면 끝난 뒤에, 아니면 지난 실행이 남긴 것이므로 ` +
          `kubectl --kubeconfig ${KUBECONFIG} -n ${LT} delete ${left.join(' ')} 뒤에 다시 돌린다`,
      );
    }
    // 산출물에서 글자 그대로 찾을 비밀 값. 읽지 못해도 값이나 그 일부를 메시지에 싣지 않는다(JSON.parse 오류는 입력 일부를 싣는다)
    const simB64 = (await kc(['-n', V0_NAMESPACE, 'get', 'secret', 'pg-simulator', '-o', 'jsonpath={.data.PG_SIMULATOR_SECRET_KEY}'])).trim();
    const simKey = Buffer.from(simB64, 'base64').toString('utf8');
    if (!/^sim_sk_[A-Za-z0-9_-]{16,}$/.test(simKey)) throw new Error('Secret v0/pg-simulator에서 시뮬레이터 시험 키를 읽지 못했다(node tools/local/cluster.mjs v0를 다시 돌린다)');
    if (!existsSync(V0_TOKEN_KEY_FILE)) throw new Error(`시험 토큰 서명 키 파일이 없다: ${V0_TOKEN_KEY_FILE} (node tools/local/cluster.mjs v0가 만든다)`);
    let d;
    try {
      d = JSON.parse(readFileSync(V0_TOKEN_KEY_FILE, 'utf8')).d;
    } catch {
      throw new Error(`시험 토큰 서명 키 파일을 JSON으로 읽지 못했다: ${V0_TOKEN_KEY_FILE}`);
    }
    if (typeof d !== 'string' || d.length < 40) throw new Error(`시험 토큰 서명 키 파일에 개인키 칸(d)이 없다: ${V0_TOKEN_KEY_FILE}`);
    literalSecrets.push(['시뮬레이터 시험 키(Secret v0/pg-simulator의 값)', simKey], ['시험 토큰 서명 개인키(d)', d]);

    TMP = mkdtempSync(join(tmpdir(), 'peaket-lt-e2e-'));
    console.log(`# 실행 폴더: ${TMP}`);
    ready = true;
  },
  { timeout: 10 * 60_000 },
);

after(
  async () => {
    for (const c of children) c.kill();
    if (!ready) return;
    const left = await leftovers().catch(() => []);
    if (!left.length) return;
    console.log(`# 끝 정리: 남은 객체 ${left.join(', ')}`);
    await cleanupLoadtest('끝 정리');
  },
  { timeout: 5 * 60_000 },
);

// ───────────── 시험 ─────────────

test('ASVS v5.0.0-2.2.1 사용 오류(범위 밖 값·지수 표기·음수·--이름=값 꼴·모르는 인자·겹친 인자·시나리오에 없는 인자·값 없는 인자·사용자보다 많은 결제·run-id 없는 기록·기록 없는 profile·모르는 시나리오·오름차순 아닌 단계·명령 없음)는 클러스터를 건드리기 전에 종료 코드 2로 끝나고 아무것도 만들지 않는다', QUICK, async () => {
  const cases = [
    ['사용자 0명', ['v0', 'queue', '--users', '0', '--entry-rate', '100', '--admit-per-second', '30']],
    ['지수 표기 숫자', ['v0', 'queue', '--users', '1e3', '--entry-rate', '100', '--admit-per-second', '30']],
    ['음수', ['v0', 'seat-hold', '--users', '10', '--rate', '-5']],
    ['--이름=값 꼴', ['v0', 'queue', '--users=10', '--entry-rate', '10', '--admit-per-second', '5']],
    ['모르는 인자', ['v0', 'queue', '--users', '10', '--entry-rate', '10', '--admit-per-second', '5', '--bogus', '1']],
    ['같은 인자 두 번', ['v0', 'queue', '--users', '10', '--users', '20', '--entry-rate', '10', '--admit-per-second', '5']],
    ['시나리오에 없는 인자', ['v0', 'seat-hold', '--users', '10', '--rate', '5', '--entry-rate', '5']],
    ['값이 없는 인자(다음이 --out)', ['v0', 'seat-hold', '--users', '10', '--rate']],
    // 경계: 5 × (2 + 10) = 60 ≤ 61이지만 구간마다 한 번 더 시작할 수 있어 상한 62 > 61
    ['결제 시작 수 상한(5 × 12초 + 2 = 62)이 사용자 61명보다 많음', ['v0', 'payment', '--users', '61', '--rate', '5', '--warm', '2', '--main', '10']],
    ['--record인데 --run-id 없음', ['v0', 'payment', '--users', '100', '--rate', '1', '--warm', '2', '--main', '10', '--record']],
    ['--record 없는 --profile', ['v0', 'payment', '--users', '100', '--rate', '1', '--warm', '2', '--main', '10', '--profile', 'local-1k']],
    ['모르는 시나리오', ['v0', 'nope', '--users', '10', '--rate', '5']],
    ['오름차순이 아닌 보정 단계', ['calibrate', '--rates', '100,50']],
    ['명령 없음', []],
  ];
  const left = await leftovers();
  for (const [i, [what, args]] of cases.entries()) {
    const out = join(TMP, `usage-${i}`);
    const argv = [...args, '--out', out];
    // 시험이 고른 경우가 계약(args.mjs)으로도 사용 오류인지 먼저 본다
    assert.throws(() => parseArgs(argv), UsageError, `${what}: parseArgs가 UsageError를 던져야 한다`);
    const r = await runCli(argv, USAGE_KILL_MS);
    assert.equal(r.code, 2, exitMessage(what, r, 2));
    assert.ok(r.ms < 15_000, `${what}: ${r.ms}ms 걸렸다(클러스터를 건드리기 전에 끝나야 한다)`);
    assert.ok(r.stderr.trim().length > 0, `${what}: 무엇이 틀렸는지 표준 오류에 적어야 한다`);
    assert.equal(existsSync(out), false, `${what}: 실행 폴더를 만들었다`);
  }
  assert.deepEqual(await leftovers(), left, `사용 오류가 네임스페이스 ${LT}에 객체를 만들었다`);
});

test('K1 Q-T2 NFR-013 v0 대기열 리허설: 진입 300건이 모두 성공해 순번 1~300(세대 0, 계정마다 하나)을 받고, 입장 확정은 모두 성공하며 자기 순번으로 serving 안에서만 되고, Q1·Q2와 DB 불변식이 PASS이며, 본구간 조회 수가 모델(pollStages) 계획의 ±5% 안이고 본구간 실패가 0건이며 발생기 판정이 유효하다', SLOW, async () => {
  // 부르는 속도 2명/초: 예상 대기 60초 이하(앞 120명)는 0.5초, 그 뒤는 5초 묶음이라 본구간 내내 두 묶음이 함께 있고, 모두 불리기(150초) 훨씬 전이라
  // 0.5초 묶음이 비지 않는다. 30명/초로 두면 10초에 모두 불려 15초부터 묶음이 비어(차례가 온 지 5초가 지남) 본구간 20초 가운데 13초는 조회가 없고,
  // 칸 끝 값 사이를 곧게 이은 단계에는 도착률이 남는데 고를 사람이 없는 반복이 생긴다(그 반복이 요청을 보내는지는 계약에 없다)
  const P = { users: 300, entryRate: 100, admitPerSecond: 2, warmS: 5, mainS: 20 };
  const entryS = Math.ceil(P.users / P.entryRate);
  const args = ['--users', P.users, '--entry-rate', P.entryRate, '--admit-per-second', P.admitPerSecond, '--warm', P.warmS, '--main', P.mainS].map(String);
  const { out, run, summary, gen, records } = await rehearse('queue', 'queue', [...args, ...GEN_ARGS, '--invariants'], {
    users: P.users,
    prepS: entryS,
    warmS: P.warmS,
    mainS: P.mainS,
    prepMinReqs: P.users,
  });
  const rec = parseRecords(records);
  const ev = run.eventId.toLowerCase();

  // 진입(queue_entry): 새 회차라 순번은 1부터 빈틈없이(Redis INCR), 세대 0, 가상 사용자 i마다 accountRef(runTag, i) 하나
  const entries = rec.queue_entry;
  assert.equal(entries.length, P.users, 'queue_entry 줄 수');
  assert.deepEqual(entries.filter((e) => e.result !== 'ok').map((e) => `${e.account_ref}:${e.result}`), [], '성공하지 않은 진입');
  assert.deepEqual(
    entries.map((e) => e.seq).sort((a, b) => a - b),
    Array.from({ length: P.users }, (_, i) => i + 1),
    '진입 순번이 1~300이 아니다',
  );
  assert.ok(entries.every((e) => e.generation === 0), '진입 세대가 0이 아닌 줄이 있다');
  assert.deepEqual(
    entries.map((e) => e.account_ref).sort(),
    Array.from({ length: P.users }, (_, i) => accountRef(run.runTag, i)).sort(),
    '진입한 계정이 가상 사용자 0~299의 accountRef(runTag, i)와 다르다',
  );
  assert.ok([...entries, ...rec.queue_admit, ...rec.queue_serving].every((x) => x.event_id === ev), '다른 회차의 기록이 섞였다');
  assert.equal(rec.pg_charge.length, 0, '대기열 실행에 pg_charge 기록이 있다');

  // serving(queue_serving): 서버 serving_log에서 왔고 오래된 것부터라 값도 시각도 줄지 않는다
  const servings = rec.queue_serving;
  assert.ok(servings.length > 0, 'queue_serving 기록이 없다');
  servings.forEach((v, i) => {
    if (i === 0) return;
    assert.ok(v.serving >= servings[i - 1].serving, `serving이 줄었다: ${i}번째 ${servings[i - 1].serving} → ${v.serving}`);
    assert.ok(Date.parse(v.observed_at) >= Date.parse(servings[i - 1].observed_at), `serving 기록이 오래된 것부터가 아니다: ${i}번째`);
  });
  const maxServing = servings.reduce((a, b) => Math.max(a, b.serving), 0);

  // 입장 확정(queue_admit): CALLED를 본 사람만 보내므로(입장 유예 15분, 다시 보내도 ADMITTED) 모두 성공이고, 자기 진입 순번을 들고, serving이 닿은 순번까지만
  const seqOf = new Map(entries.map((e) => [e.account_ref, e.seq]));
  assert.ok(rec.queue_admit.length > 0, '입장 확정 기록이 없다');
  assert.deepEqual(rec.queue_admit.filter((a) => a.result !== 'ok').map((a) => `${a.account_ref}:${a.result}`), [], '성공하지 않은 입장 확정(fail: CALLED가 아닌 사람에게 보냄, unknown: 5xx·시간 초과)');
  for (const a of rec.queue_admit) {
    assert.equal(a.seq, seqOf.get(a.account_ref), `${a.account_ref}의 입장 확정 순번이 진입 순번과 다르다`);
    assert.ok(a.seq <= maxServing, `순번 ${a.seq}가 serving 최대 ${maxServing}보다 크다(차례 전 입장)`);
  }
  console.log(`# queue: 입장 확정 ${rec.queue_admit.length}건(사람 ${new Set(rec.queue_admit.map((a) => a.account_ref)).size}), serving 기록 ${servings.length}줄(최대 ${maxServing})`);

  assertInvariants(out, [...RECORD_IDS, ...DB_IDS]);

  // 발생기: 반복을 놓치지 않았고(dropped 0) CPU·메모리 한도 안이다(아래 계획 비교의 전제)
  assert.equal(gen.dropped, 0, 'dropped_iterations');
  assert.equal(gen.judge.valid, true, `발생기 판정 무효: ${gen.judge.reasons.join(', ')}`);

  // 요약: 본구간은 조회(status)와 입장 확정(admission)뿐이고(진입은 준비 구간), 모두 성공했다
  const routes = assertMainRoutes('queue', summary, MAIN_ROUTES.queue);
  assert.ok(summary.metrics['http_req_duration{phase:main,route:status}'], 'http_req_duration{phase:main,route:status}가 없다');
  assert.equal(metric(summary, 'http_req_failed')?.rate, 0, `본구간 실패율(http_req_failed{phase:main}): ${JSON.stringify(metric(summary, 'http_req_failed'))}`);

  // 구간 표시: 모델 시각 원점은 진입 시작이고(enteredAt·servingAt의 tS), 조회는 진입이 끝나는 entryS초에 예열로 시작해 본구간은 entryS + warmS초에
  // 시작한다(실행 도구 계약). 첫 진입 요청과 본구간 시작 표시는 둘 다 발생기 시계다. 2.5초는 표시를 내는 반복의 시작 지연을 덮는다
  const mainStartS = entryS + P.warmS;
  const firstEntryMs = entries.reduce((m, e) => Math.min(m, Date.parse(e.started_at)), Infinity);
  const offsetMs = gen.marks.main_start - firstEntryMs;
  assert.ok(Math.abs(offsetMs - mainStartS * 1000) <= 2500, `본구간 시작 표시가 첫 진입 뒤 ${offsetMs}ms다(${mainStartS}초여야 한다)`);

  // 본구간 조회 계획 수: 시나리오와 같은 인자로 pollStages(lib)를 지어 ramping-arrival-rate가 도는 그대로 적분(사다리꼴)한다. 반복 하나가 조회
  // (route:status) 하나다. 이 설정이면 시작 295/초 → 18초 291/초 → 28초 287/초라 (295+291)/2×10 + (291+287)/2×10 = 5,820건이다(설명용 값, 계산은 lib).
  // 허용 ±5%: dropped 0이면 k6는 단계의 넓이만큼 반복을 시작하므로(단계마다 ±1) 어긋남은 몇 건이다. 5%는 그 반올림을 넉넉히 덮으면서
  // 5초 묶음을 빼먹는 모델 이탈(이 설정에서 −10%)과 조회 주기 단위 실수(0.5초를 1초로: 약 −45%)를 잡는다
  const planned = plannedIterations(pollStages({ users: P.users, entryRate: P.entryRate, admitPerSecond: P.admitPerSecond, startS: mainStartS, durationS: P.mainS }));
  const got = routes.status ?? 0;
  console.log(`# queue: 본구간 조회 ${got}건, 계획 ${planned}건(모델 시각 ${mainStartS}초부터 ${P.mainS}초), 본구간 입장 확정 ${routes.admission ?? 0}건, 구간 표시 ${gen.marks.main_end - gen.marks.main_start}ms`);
  assert.ok(planned > 0, '계획 조회 수가 0이다');
  assert.ok(Math.abs(got - planned) <= 0.05 * planned, `본구간 조회 ${got}건이 계획 ${planned}건의 ±5% 밖이다`);
});

test('K2 S-T1 v0 인기 좌석 홀드 리허설: 한 좌석에 몰린 홀드가 본구간 경로 지표로 도착률 × 본구간만큼 남고(준비 구간 요청은 섞이지 않음), 홀드는 모두 그 한 좌석이며 시험 기록은 비고 S1~S4와 DB 불변식이 PASS이고 FAIL이 없다', SLOW, async () => {
  const P = { users: 200, rate: 50, warmS: 3, mainS: 10 };
  const args = ['--users', P.users, '--rate', P.rate, '--mode', 'hot', '--hot-count', '1', '--warm', P.warmS, '--main', P.mainS].map(String);
  const { out, run, summary, gen, records } = await rehearse('seat-hot', 'seat-hold', [...args, ...GEN_ARGS, '--invariants'], {
    users: P.users,
    prepS: prepSeconds(P.users),
    warmS: P.warmS,
    mainS: P.mainS,
    prepMinReqs: 2 * P.users,
  });
  assert.equal(records.trim(), '', 'seat-hold의 records.ndjson는 비어야 한다');
  const routes = assertMainRoutes('seat-hot', summary, MAIN_ROUTES['seat-hold']);
  assert.ok(summary.metrics['http_req_duration{phase:main,route:hold}'], 'http_req_duration{phase:main,route:hold}가 없다');
  assertArrivalCount('seat-hot 본구간 홀드', routes.hold ?? 0, P.rate * P.mainS, gen.dropped);
  // v0 DB: 홀드가 실제로 잡혔고(S1~S4는 주문에서 오므로 홀드만으로는 비어 있다), 모두 첫 좌석 한 석이다(--mode hot --hot-count 1이 시나리오에 닿았다)
  const h = await eventHolds(run.eventId);
  console.log(`# seat-hot: 본구간 홀드 ${routes.hold}건, 실패율 ${metric(summary, 'http_req_failed{phase:main,route:hold}')?.rate}, DB 홀드 ${JSON.stringify(h)}`);
  assert.ok(h.holds > 0, 'v0 DB에 이 회차의 홀드가 없다(홀드가 한 번도 성공하지 않았다)');
  assert.deepEqual({ seats: h.seats, minSize: h.minSize, maxSize: h.maxSize }, { seats: 1, minSize: 1, maxSize: 1 }, '인기 좌석 1석 방식이 아니다');
  assertInvariants(out, [...S_IDS, ...DB_IDS]);
});

test('K3 S-T10 v0 엇갈린 좌석 홀드 리허설: 같은 두 좌석을 반대 순서로 잡아도 불변식 FAIL이 없고, 홀드는 모두 그 두 좌석이며, v0 DB의 교착 수 변화(0 이상 정수)를 남긴다', SLOW, async () => {
  const P = { users: 200, rate: 50, warmS: 3, mainS: 10 };
  const deadlocksBefore = await v0Deadlocks();
  const args = ['--users', P.users, '--rate', P.rate, '--mode', 'crossed', '--pairs', '1', '--hold-size', '2', '--warm', P.warmS, '--main', P.mainS].map(String);
  const { out, run, summary, gen, records } = await rehearse('seat-crossed', 'seat-hold', [...args, ...GEN_ARGS, '--invariants'], {
    users: P.users,
    prepS: prepSeconds(P.users),
    warmS: P.warmS,
    mainS: P.mainS,
    prepMinReqs: 2 * P.users,
  });
  const deadlocksAfter = await v0Deadlocks();
  assert.equal(records.trim(), '', 'seat-hold의 records.ndjson는 비어야 한다');
  const routes = assertMainRoutes('seat-crossed', summary, MAIN_ROUTES['seat-hold']);
  assertArrivalCount('seat-crossed 본구간 홀드', routes.hold ?? 0, P.rate * P.mainS, gen.dropped);
  const h = await eventHolds(run.eventId);
  assert.ok(h.holds > 0, 'v0 DB에 이 회차의 홀드가 없다(홀드가 한 번도 성공하지 않았다)');
  assert.deepEqual({ seats: h.seats, minSize: h.minSize, maxSize: h.maxSize }, { seats: 2, minSize: 2, maxSize: 2 }, '엇갈린 한 쌍(두 좌석을 함께) 방식이 아니다');
  assertInvariants(out, [...S_IDS, ...DB_IDS]);
  // 짧은 실행에서 v0가 교착을 낼지는 정해지지 않아 0 초과를 요구하지 않는다(K3의 판정은 Before 측정, wbs 1.4.1 ②)
  const delta = deadlocksAfter - deadlocksBefore;
  console.log(`# K3 v0 교착 수 변화: ${delta}(전 ${deadlocksBefore} → 뒤 ${deadlocksAfter}), 본구간 홀드 ${routes.hold}건·실패율 ${metric(summary, 'http_req_failed{phase:main,route:hold}')?.rate}, DB 홀드 ${JSON.stringify(h)}`);
  assert.ok(Number.isSafeInteger(delta) && delta >= 0, `교착 수 변화: ${delta}`);
});

test('K7 v0 결제 리허설: 결제 경로(홀드·주문·시험 인증·결제·주문 보기)가 본구간 지표로 남고 본구간 결제가 도착률 × 본구간(+1)만큼이며 실패가 0건이고, 이 회차 주문이 모두 CONFIRMED(결제 승인·티켓 좌석 수, 사용자마다 하나)이며 결제사 원장의 승인이 주문마다 하나(금액 같음)이고, P1~P6·S1~S4가 PASS다', SLOW, async () => {
  // 사용자 100명 ≥ 5 × (2 + 10) + 2 = 62(구간마다 한 번 더 시작할 수 있다)
  const P = { users: 100, rate: 5, warmS: 2, mainS: 10, seatsPerOrder: 2 };
  const args = ['--users', P.users, '--rate', P.rate, '--warm', P.warmS, '--main', P.mainS, '--seats-per-order', P.seatsPerOrder].map(String);
  const { out, run, summary, gen, records } = await rehearse('payment', 'payment', [...args, ...GEN_ARGS, '--invariants'], {
    users: P.users,
    prepS: prepSeconds(P.users),
    warmS: P.warmS,
    mainS: P.mainS,
    prepMinReqs: 2 * P.users,
  });
  const routes = assertMainRoutes('payment', summary, MAIN_ROUTES.payment);
  for (const route of MAIN_ROUTES.payment) {
    assert.ok(summary.metrics[`http_req_duration{phase:main,route:${route}}`], `http_req_duration{phase:main,route:${route}}가 없다`);
  }
  // 결제 하나 = 반복 하나이고 사용자마다 자기 좌석이라 다툼이 없다: 본구간 결제 확정 수는 도착률 × 본구간, 실패(기대 밖 상태·5xx·연결 실패)는 0건
  assertArrivalCount('payment 본구간 결제 확정', routes.payment ?? 0, P.rate * P.mainS, gen.dropped);
  assert.ok((routes.order_view ?? 0) >= (routes.payment ?? 0), `본구간 주문 보기 ${routes.order_view}건이 결제 확정 ${routes.payment}건보다 적다`);
  assert.equal(metric(summary, 'http_req_failed')?.rate, 0, `본구간 실패율(http_req_failed{phase:main}): ${JSON.stringify(metric(summary, 'http_req_failed'))}`);

  // parseRecords가 모든 줄을 읽어야 한다(모르는 종류·칸은 줄 번호와 함께 던진다). 원장은 시뮬레이터가 뜬 뒤 전부라 이 회차 것만 골라 본다
  const rec = parseRecords(records);
  assert.equal(rec.queue_entry.length + rec.queue_admit.length + rec.queue_serving.length, 0, '결제 실행에 대기열 기록이 있다');

  // v0 DB의 이 회차 주문(예열 + 본구간 결제마다 하나. 두 구간이 각각 한 번 더 시작할 수 있어 정확히 rate × 12가 아니라 60~62건):
  // 모두 CONFIRMED, 결제 APPROVED, 티켓 = 주문 좌석 수, 사용자마다 하나(본구간은 앞 번호부터, 예열은 뒤 번호부터라 겹치지 않는다).
  // P3·P6은 승인 뒤 60초가 지난 것만 세므로 방금 끝난 이 회차 결제에는 아직 닿지 않는다. 그 몫을 여기서 이 회차에 대해 바로 본다
  const orders = JSON.parse(
    await v0Sql(
      `select coalesce(json_agg(json_build_object('id', o.order_id::text, 'status', o.status, 'amount', o.amount, 'account', o.account_id, 'payment', p.status, ` +
        `'tickets', (select count(*) from v0_ticket t where t.order_id = o.order_id))), '[]'::json) ` +
        `from v0_order o left join v0_payment p on p.order_id = o.order_id where lower(o.event_id) = ${eventLiteral(run.eventId)}`,
    ),
  );
  assertArrivalCount('payment 이 회차 주문(예열 + 본구간)', orders.length, P.rate * (P.warmS + P.mainS), gen.dropped, 2);
  const bad = orders.filter((o) => o.status !== 'CONFIRMED' || o.payment !== 'APPROVED' || o.tickets !== P.seatsPerOrder).map((o) => `${o.id}:${o.status}/${o.payment}/티켓 ${o.tickets}`);
  assert.deepEqual(bad, [], `CONFIRMED·결제 APPROVED·티켓 ${P.seatsPerOrder}장이 아닌 주문`);
  assert.equal(new Set(orders.map((o) => o.account)).size, orders.length, '한 사용자가 주문을 둘 이상 했다(사용자마다 결제 하나여야 한다)');

  // 결제사 원장(pg_charge): 이 회차 주문마다 승인 하나, 금액이 주문과 같고 취소 없음
  const charges = new Map();
  for (const c of rec.pg_charge) charges.set(c.order_ref, [...(charges.get(c.order_ref) ?? []), c]);
  const ledgerBad = orders.flatMap((o) => {
    const cs = charges.get(o.id) ?? [];
    if (cs.length !== 1) return [`${o.id}: 원장 ${cs.length}건`];
    const [c] = cs;
    return c.approved_at !== null && c.amount === o.amount && c.canceled_amount === 0 ? [] : [`${o.id}: 승인 ${c.approved_at}, 금액 ${c.amount}(주문 ${o.amount}), 취소 ${c.canceled_amount}`];
  });
  assert.deepEqual(ledgerBad, [], '결제사 원장의 이 회차 승인이 주문마다 하나(같은 금액, 취소 없음)가 아니다');
  console.log(`# payment: 이 회차 주문 ${orders.length}건 모두 CONFIRMED, 원장 전체 ${rec.pg_charge.length}건, 본구간 ${JSON.stringify(routes)}`);
  assertInvariants(out, [...RECORD_IDS, ...DB_IDS]);
});

test('NFR-013 ADR-0057 V-T3 발생기 보정: 단계 둘의 p99·발생기 지표와 판정, 단계 요청 수(도착률 × 본구간), 용량이 calibration.json에 남고 단계 폴더가 생기며, 빈 응답 대역과 발생기 파드는 지워지고 --record 없이 성능 장부에 쓰지 않는다', SLOW, async () => {
  const CAL = { cpus: 1, memoryMi: 512, targetCpus: 1, rates: [50, 100], warmS: 2, mainS: 5 };
  const out = join(TMP, 'calibrate');
  const argv = ['calibrate', '--cpus', CAL.cpus, '--memory-mi', CAL.memoryMi, '--target-cpus', CAL.targetCpus, '--rates', CAL.rates.join(','), '--warm', CAL.warmS, '--main', CAL.mainS, '--out', out].map(String);
  assert.doesNotThrow(() => parseArgs(argv), '보정 시험 인자가 parseArgs를 통과하지 못한다');
  const ledgerBefore = ledgerSnapshot();
  const r = await runCli(argv);
  assert.equal(r.code, 0, exitMessage('calibrate', r, 0));

  const cal = readJson(out, 'calibration.json');
  assert.deepEqual(
    { cpus: cal.cpus, memoryMi: cal.memoryMi, targetCpus: cal.targetCpus, warmS: cal.warmS, mainS: cal.mainS },
    { cpus: CAL.cpus, memoryMi: CAL.memoryMi, targetCpus: CAL.targetCpus, warmS: CAL.warmS, mainS: CAL.mainS },
  );
  assert.deepEqual(
    cal.steps.map((s) => s.rate),
    CAL.rates,
  );
  for (const s of cal.steps) {
    const at = `단계 ${s.rate}`;
    assert.ok(Number.isFinite(s.p99Ms), `${at} p99Ms: ${s.p99Ms}`);
    assert.equal(typeof s.passed, 'boolean', `${at} passed`);
    assert.ok(Array.isArray(s.reasons) && s.reasons.every((x) => typeof x === 'string'), `${at} reasons`);
    assert.ok(Number.isFinite(s.failedRate) && s.failedRate >= 0 && s.failedRate <= 1, `${at} failedRate: ${s.failedRate}`);
    assert.ok(Number.isSafeInteger(s.dropped) && s.dropped >= 0, `${at} dropped: ${s.dropped}`);
    assert.ok(s.targetCpuPct === null || Number.isFinite(s.targetCpuPct), `${at} targetCpuPct: ${s.targetCpuPct}`);
    assertGeneratorStats(at, s, { memoryMi: CAL.memoryMi, mainS: CAL.mainS });
    // 판정은 적힌 숫자로 judgeGenerator·judgeCalibrationStep을 부른 결과와 같다
    assert.deepEqual(s.judge, judgeGenerator({ dropped: s.dropped, cpuMeanPct: s.stats.cpuMeanPct, memMaxPct: s.stats.memMaxPct }), `${at} 발생기 판정`);
    const judged = judgeCalibrationStep({ rate: s.rate, dropped: s.dropped, cpuMeanPct: s.stats.cpuMeanPct, memMaxPct: s.stats.memMaxPct, failedRate: s.failedRate, p99Ms: s.p99Ms });
    assert.deepEqual({ rate: s.rate, passed: s.passed, reasons: s.reasons }, judged, `${at} 판정`);
    const dir = join(out, `step-${s.rate}`);
    for (const f of ['summary.json', 'cgroup.log', 'k6.log']) assert.ok(existsSync(join(dir, f)), `step-${s.rate}/${f}가 없다`);
    // 단계 요약은 본구간 값이고 그 단계의 도착률로 보냈다(예열이 섞이면 rate × warm만큼 넘친다)
    const stepSummary = readJson(dir, 'summary.json');
    assert.equal(s.dropped, metric(stepSummary, 'dropped_iterations')?.count ?? 0, `${at}: dropped ≠ 단계 요약의 dropped_iterations`);
    assertArrivalCount(`${at} 본구간 요청`, metric(stepSummary, 'http_reqs')?.count, s.rate * CAL.mainS, s.dropped);
  }
  const c = cal.capacity;
  assert.ok(c.capacityRps === null || Number.isSafeInteger(c.capacityRps), `capacityRps: ${c.capacityRps}`);
  assert.equal(typeof c.topReached, 'boolean');
  assert.ok(c.limitedBy === null || (Number.isSafeInteger(c.limitedBy.rate) && Array.isArray(c.limitedBy.reasons)), `limitedBy: ${JSON.stringify(c.limitedBy)}`);
  assert.deepEqual(c, calibrationCapacity(cal.steps.map(({ rate, passed, reasons }) => ({ rate, passed, reasons }))), '용량이 단계 판정과 맞지 않는다');
  console.log(`# calibrate: ${cal.steps.map((s) => `${s.rate}/초 p99 ${s.p99Ms}ms CPU ${s.stats.cpuMeanPct}% ${s.passed ? '통과' : s.reasons.join('·')}`).join(' | ')} → 용량 ${JSON.stringify(c)}`);

  await assertCleanedUp('보정이 끝난 뒤');
  assert.equal(ledgerSnapshot(), ledgerBefore, '--record 없이 docs/perf-ledger 아래가 바뀌었다');
});

test('ASVS v5.0.0-13.3.1 ASVS v5.0.0-14.2.4 모든 실행 폴더와 실행 도구 출력에 토큰 파일(users.json)·JWT·토큰 쿠키·시뮬레이터 시험 키·서명 개인키가 없고, 네임스페이스 loadtest에 파드·Secret·빈 응답 대역이, kind 노드에 이 시험이 만든 실행 폴더가 남지 않는다', QUICK, async () => {
  // 앞 시험이 실패했어도 남은 산출물과 출력은 본다. 산출물이 없으면(앞 시험이 돌지 않음) 출력과 남은 객체만 본다
  const files = existsSync(TMP) ? filesUnder(TMP) : [];
  assert.deepEqual(
    files.filter((f) => basename(f).toLowerCase() === 'users.json'),
    [],
    'users.json이 실행 폴더에 있다',
  );
  for (const f of files) {
    const text = readFileSync(f, 'latin1');
    for (const [what, re] of SECRET_PATTERNS) assert.ok(!re.test(text), `${f}에 ${what}가 있다`);
    for (const [what, value] of literalSecrets) assert.ok(!text.includes(value), `${f}에 ${what}가 있다`);
  }
  for (const [what, re] of SECRET_PATTERNS) assert.ok(!re.test(cliOutput), `실행 도구 출력에 ${what}가 있다`);
  for (const [what, value] of literalSecrets) assert.ok(!cliOutput.includes(value), `실행 도구 출력에 ${what}가 있다`);
  console.log(`# 비밀 검사: 파일 ${files.length}개, 실행 도구 출력 ${cliOutput.length}자`);
  await assertCleanedUp('모든 실행이 끝난 뒤');
});
