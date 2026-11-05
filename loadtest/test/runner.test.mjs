// 부하 실행 도구의 순수 모듈 시험(docs/verification.md §3.5 2·3번, §3.9, docs/security/asvs/verification-tools.md `loadgen`).
// 대상: loadtest/runner/args.mjs·manifests.mjs·results.mjs. 각 export의 JSDoc을 명세로 보고 계약만 시험한다.
// 클러스터·Docker는 건드리지 않는다. collect.py 통합 시험은 OS 임시 폴더를 --root로 주고 끝나면 지운다.
// 실행: node --test loadtest/test/runner.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEFAULTS, SCENARIOS, UsageError, parseArgs } from '../runner/args.mjs';
import {
  K6_IMAGE,
  K6_UID,
  KIND_NODE,
  LOADGEN_NAMESPACE,
  NODE_ROOT,
  NULL_TARGET_BODY,
  NULL_TARGET_IMAGE,
  NULL_TARGET_NAME,
  NULL_TARGET_PORT,
  RUN_SCRIPT,
  SAMPLER_COMMAND,
  SIM_KEY_NAME,
  SIM_KEY_SECRET,
  generatorPod,
  nullTargetCertArgs,
  nullTargetManifests,
  nullTargetSecret,
  runEnvFile,
  simKeySecret,
} from '../runner/manifests.mjs';
import {
  CALIBRATION_P99_MAX_MS,
  GENERATOR_CPU_MAX_PCT,
  GENERATOR_MEM_MAX_PCT,
  RECORD_KINDS,
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
} from '../runner/results.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..');
/**
 * collect.py를 돌릴 Python. PYTHON 환경 값이 있으면 그것만, 없으면 이 OS에서 흔한 이름부터(Windows는 python, 그 밖은 python3) 차례로
 * `--version`이 성공하는 첫 이름을 쓴다(Windows의 python3는 스토어 안내 가짜 실행 파일이라 종료 코드 49로 실패한다)
 */
function findPython() {
  const candidates = process.env.PYTHON ? [process.env.PYTHON] : process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    if (r.status === 0 && /Python 3\./.test(`${r.stdout}${r.stderr}`)) return c;
  }
  return null;
}
const PY = findPython();
const GiB = 1024 ** 3;

// ---------------------------------------------------------------------------------------------
// 공통 도우미
// ---------------------------------------------------------------------------------------------

/** 값이 undefined인 칸을 뺀다. JSDoc의 `out?`·`runId?`·`profile?`·`marks.main_start?`는 없거나 undefined면 같은 뜻으로 본다 */
const norm = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** 메시지에 줄 번호 n이 독립된 수로 있는지(다른 수의 한 자리로 들어간 것은 세지 않는다) */
const mentionsNumber = (msg, n) => new RegExp(`(^|\\D)${n}(\\D|$)`).test(msg);

/** 인자 목록을 만든다. 값이 true면 값 없는 인자, undefined·false면 뺀다 */
function argvOf(head, flags) {
  const out = [...head];
  for (const [k, v] of Object.entries(flags)) {
    if (v === undefined || v === false) continue;
    out.push(`--${k}`);
    if (v !== true) out.push(String(v));
  }
  return out;
}
const QUEUE = { users: 1000, 'entry-rate': 500, 'admit-per-second': 28 };
const SEAT = { users: 2000, rate: 200 };
const PAY = { users: 9002, rate: 100 }; // 결제 시작 수의 상한 100 × (30 + 60) + 2 = 9,002 = users(같으면 받는다)
const q = (o = {}) => argvOf(['v0', 'queue'], { ...QUEUE, ...o });
const sh = (o = {}) => argvOf(['v0', 'seat-hold'], { ...SEAT, ...o });
const pay = (o = {}) => argvOf(['v0', 'payment'], { ...PAY, ...o });
const cal = (o = {}) => argvOf(['calibrate'], o);

/** UsageError(한국어 메시지)로 거부하는지 */
function expectUsage(argv, re) {
  assert.throws(
    () => parseArgs(argv),
    (e) => {
      assert.ok(e instanceof UsageError, `UsageError가 아니다(${e?.name}: ${e?.message}) argv=${JSON.stringify(argv)}`);
      assert.equal(e.name, 'UsageError');
      assert.match(e.message, /[가-힣]/, '메시지는 한국어');
      if (re) assert.match(e.message, re);
      return true;
    },
    `거부해야 한다: ${JSON.stringify(argv)}`,
  );
}

/** 기록하지 않는 v0 결과: profile 칸은 --record일 때만 있다(JSDoc '--profile은 … --record일 때만 칸이 있으며') */
function assertV0(argv, expected) {
  const raw = parseArgs(argv);
  assert.equal(Object.hasOwn(raw, 'profile'), false, `--record 없이 profile 칸이 있다: ${raw.profile}`);
  assert.deepStrictEqual(norm(raw), expected);
}

const UUID_A = '0b5a3f9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';

// ---------------------------------------------------------------------------------------------
// args.mjs: parseArgs
// ---------------------------------------------------------------------------------------------

test('[ASVS v5.0.0-2.2.1] UsageError는 Error이고 이름이 UsageError, SCENARIOS는 시나리오 다섯의 파일이다', () => {
  const e = new UsageError('틀림');
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'UsageError');
  assert.deepStrictEqual({ ...SCENARIOS }, {
    queue: 'v0-queue.js',
    'seat-hold': 'v0-seat-hold.js',
    payment: 'v0-payment.js',
    'seat-deltas': 'v0-seat-hold.js',
    gate: 'v0-gate.js',
  });
  assert.ok(Object.isFrozen(SCENARIOS) && Object.isFrozen(DEFAULTS) && Object.isFrozen(DEFAULTS.calibrate));
});

test('NFR-013 ADR-0057 parseArgs calibrate만 주면 보정 기본값(CPU 4·메모리 4096Mi·대역 CPU 8·단계 1000~8000·예열 10·본 30)을 채운다', () => {
  assert.deepStrictEqual(norm(parseArgs(['calibrate'])), {
    command: 'calibrate',
    cpus: 4,
    memoryMi: 4096,
    targetCpus: 8,
    rates: [1000, 2000, 4000, 8000],
    warmS: 10,
    mainS: 30,
    record: false,
  });
});

test('NFR-013 ADR-0057 parseArgs calibrate의 모든 인자를 바꾸면 그 값을 돌려주고 --out은 그대로 둔다', () => {
  const out = 'D:\\cache\\peaket loadtest\\cal 1';
  const a = cal({ cpus: 8, 'memory-mi': 8192, 'target-cpus': 12, rates: '500,1500,1501', warm: 5, main: 20, record: true, out });
  assert.deepStrictEqual(norm(parseArgs(a)), {
    command: 'calibrate',
    cpus: 8,
    memoryMi: 8192,
    targetCpus: 12,
    rates: [500, 1500, 1501],
    warmS: 5,
    mainS: 20,
    record: true,
    out,
  });
});

test('NFR-013 ADR-0057 parseArgs calibrate --record는 --run-id 없이 받고(실행 ID는 도구가 단계마다 만든다) runId·profile 칸이 없다', () => {
  const r = parseArgs(cal({ record: true }));
  assert.equal(r.record, true);
  assert.equal(r.runId, undefined);
  assert.equal(r.profile, undefined);
  assert.equal(parseArgs(['calibrate']).runId, undefined);
});

test('[ASVS v5.0.0-2.2.1] parseArgs calibrate는 --run-id를 --record와 함께든 홀로든 받지 않는다', () => {
  expectUsage(cal({ record: true, 'run-id': '2026-11-03-gen-calib-c4-r1000' }));
  expectUsage(cal({ 'run-id': '2026-11-03-gen-calib-c4-r1000' }));
  expectUsage(cal({ profile: 'local-gen' }));
});

test('[ASVS v5.0.0-2.2.1] parseArgs는 --이름=값 꼴을 모르는 인자로 거부한다', () => {
  expectUsage(['v0', 'queue', '--users=1000', '--entry-rate', '500', '--admit-per-second', '28']);
  expectUsage([...q(), '--warm=10']);
  expectUsage([...q(), '--invariants=true']);
  expectUsage([...q(), '--out=x']);
  expectUsage([...q({ 'run-id': undefined }), '--record=true']);
  expectUsage(['calibrate', '--cpus=4']);
  expectUsage(['calibrate', '--rates=1000,2000']);
  expectUsage([...sh(), '--mode=hot']);
});

test('[ASVS v5.0.0-2.2.1] parseArgs 정수 인자와 --rates의 각 수는 앞의 0을 받는다(값은 10진수로 읽는다)', () => {
  assert.deepStrictEqual(parseArgs(cal({ rates: '0100,0200,08000' })).rates, [100, 200, 8000]);
  assert.equal(parseArgs(cal({ cpus: '04' })).cpus, 4);
  assert.equal(parseArgs(sh({ 'release-ms': '000' })).releaseMs, 0);
  assert.equal(parseArgs(sh({ 'hold-size': '0004' })).holdSize, 4);
  assert.equal(parseArgs(q({ 'entry-rate': '0500' })).entryRate, 500); // 8진수로 읽으면 320
  assert.equal(parseArgs(q({ users: '010' })).users, 10);
  // 앞의 0을 떼면 범위 밖인 값은 거부한다
  expectUsage(q({ users: '00' }));
  expectUsage(sh({ 'hold-size': '05' }));
  expectUsage(cal({ rates: '0,1000' }));
  expectUsage(cal({ rates: '0100,100' })); // 같은 수(엄격한 오름차순 아님)
});

test('[ASVS v5.0.0-2.2.1] parseArgs --rates는 1~20개·각 1~100,000·엄격한 오름차순만 받는다', () => {
  assert.deepStrictEqual(parseArgs(cal({ rates: '1000' })).rates, [1000]);
  assert.deepStrictEqual(parseArgs(cal({ rates: '1,100000' })).rates, [1, 100000]);
  const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.deepStrictEqual(parseArgs(cal({ rates: twenty.join(',') })).rates, twenty);
  const bad = [
    Array.from({ length: 21 }, (_, i) => i + 1).join(','), // 21개
    '1000,1000', // 같은 이웃
    '2000,1000', // 내림차순
    '1000,2000,1500',
    '1000,,2000', // 빈 칸
    '1000,',
    ',1000',
    ',',
    '0,1000', // 범위 밖
    '1,100001',
    '1000, 2000', // 공백
    '1e3,2000', // 10진수 숫자만
    '+1000,2000',
    '1000.0,2000',
    '1000;2000',
  ];
  for (const rates of bad) expectUsage(cal({ rates }));
  expectUsage(['calibrate', '--rates', '']);
});

test('[ASVS v5.0.0-2.2.1] parseArgs calibrate의 범위: cpus·target-cpus 1~16, memory-mi 256~32,768, warm 1~3,600, main 5~7,200', () => {
  const ok = [
    ['cpus', 1, 'cpus'], ['cpus', 16, 'cpus'], ['target-cpus', 1, 'targetCpus'], ['target-cpus', 16, 'targetCpus'],
    ['memory-mi', 256, 'memoryMi'], ['memory-mi', 32768, 'memoryMi'], ['warm', 1, 'warmS'], ['warm', 3600, 'warmS'],
    ['main', 5, 'mainS'], ['main', 7200, 'mainS'],
  ];
  // 예열·본구간 최댓값은 단계 하나로 본다(보정 전체 길이 상한 11,400초, 2차 새 맥락 리뷰)
  for (const [flag, v, key] of ok) assert.equal(parseArgs(cal({ rates: '1000', [flag]: v }))[key], v, `--${flag} ${v}`);
  const bad = [['cpus', 0], ['cpus', 17], ['target-cpus', 0], ['target-cpus', 17], ['memory-mi', 255], ['memory-mi', 32769],
    ['memory-mi', 0], ['warm', 0], ['warm', 3601], ['main', 0], ['main', 4], ['main', 7201]];
  for (const [flag, v] of bad) expectUsage(cal({ [flag]: v }));
});

test('[ASVS v5.0.0-2.2.1] parseArgs calibrate에 없는 인자(v0 전용·기록 ID·불변식)는 거부한다', () => {
  for (const extra of [{ users: 10 }, { rate: 5 }, { 'entry-rate': 5 }, { 'admit-per-second': 5 }, { mode: 'hot' },
    { 'seats-per-order': 2 }, { 'hold-size': 2 }, { invariants: true }, { record: true, 'run-id': '2026-11-03-cal' },
    { record: true, profile: 'local-gen' }]) {
    expectUsage(cal(extra));
  }
});

test('NFR-013 ADR-0057 parseArgs v0 queue 기본값: 예열 30·본 60·CPU 4·메모리 4096, 기록·불변식 끔', () => {
  assertV0(q(), {
    command: 'v0',
    scenario: 'queue',
    users: 1000,
    warmS: 30,
    mainS: 60,
    cpus: 4,
    memoryMi: 4096,
    record: false,
    invariants: false,
    namespace: 'v0',
    settle: false,
    hpaTimeline: false,
    entryRate: 500,
    admitPerSecond: 28,
  });
});

test('NFR-013 ADR-0057 parseArgs v0 queue 공통 인자를 모두 주면 그 값(runId·profile·invariants·out)을 돌려준다', () => {
  const a = q({ users: 100000, 'entry-rate': 20000, 'admit-per-second': 28, warm: 10, main: 120, cpus: 8, 'memory-mi': 8192,
    record: true, 'run-id': '2026-11-03-k1-v0-local-100k', profile: 'local-gen', invariants: true, out: '.cache/x y' });
  assert.deepStrictEqual(norm(parseArgs(a)), {
    command: 'v0',
    scenario: 'queue',
    users: 100000,
    warmS: 10,
    mainS: 120,
    cpus: 8,
    memoryMi: 8192,
    record: true,
    runId: '2026-11-03-k1-v0-local-100k',
    profile: 'local-gen',
    invariants: true,
    out: '.cache/x y',
    namespace: 'v0',
    settle: false,
    hpaTimeline: false,
    entryRate: 20000,
    admitPerSecond: 28,
  });
});

test('NFR-013 ADR-0057 parseArgs 인자 순서가 달라도 결과가 같다', () => {
  const a = ['v0', 'queue', '--record', '--admit-per-second', '28', '--run-id', '2026-11-03-k1', '--entry-rate', '500', '--users', '1000'];
  const b = q({ record: true, 'run-id': '2026-11-03-k1' });
  assert.deepStrictEqual(norm(parseArgs(a)), norm(parseArgs(b)));
});

test('NFR-013 ADR-0057 parseArgs v0 seat-hold 기본값: spread·hold-size 2·hot-count 1·pairs 1·release-ms 0', () => {
  assertV0(sh(), {
    command: 'v0',
    scenario: 'seat-hold',
    users: 2000,
    warmS: 30,
    mainS: 60,
    cpus: 4,
    memoryMi: 4096,
    record: false,
    invariants: false,
    namespace: 'v0',
    settle: false,
    hpaTimeline: false,
    rate: 200,
    mode: 'spread',
    holdSize: 2,
    hotCount: 1,
    pairs: 1,
    releaseMs: 0,
    keep: false,
    dbStats: false,
  });
});

test('NFR-013 ADR-0057 parseArgs v0 seat-hold 좌석 고르기 인자를 모두 바꾼다', () => {
  assertV0(sh({ mode: 'hot', 'hold-size': 4, 'hot-count': 7, pairs: 3, 'release-ms': 1500 }), {
    command: 'v0',
    scenario: 'seat-hold',
    users: 2000,
    warmS: 30,
    mainS: 60,
    cpus: 4,
    memoryMi: 4096,
    record: false,
    invariants: false,
    namespace: 'v0',
    settle: false,
    hpaTimeline: false,
    rate: 200,
    mode: 'hot',
    holdSize: 4,
    hotCount: 7,
    pairs: 3,
    releaseMs: 1500,
    keep: false,
    dbStats: false,
  });
  for (const mode of ['spread', 'hot', 'crossed']) assert.equal(parseArgs(sh({ mode })).mode, mode);
});

test('NFR-013 ADR-0057 parseArgs seat-hold는 그 방식이 쓰지 않는 좌석 인자도 받아 값을 그대로 돌려준다', () => {
  const spread = parseArgs(sh({ mode: 'spread', 'hot-count': 5, pairs: 9 }));
  assert.deepStrictEqual([spread.mode, spread.holdSize, spread.hotCount, spread.pairs], ['spread', 2, 5, 9]);
  const hot = parseArgs(sh({ mode: 'hot', 'hold-size': 3, pairs: 4, 'release-ms': 10 }));
  assert.deepStrictEqual([hot.mode, hot.holdSize, hot.hotCount, hot.pairs, hot.releaseMs], ['hot', 3, 1, 4, 10]);
  const crossed = parseArgs(sh({ mode: 'crossed', 'hold-size': 4, 'hot-count': 3 }));
  assert.deepStrictEqual([crossed.mode, crossed.holdSize, crossed.hotCount, crossed.pairs], ['crossed', 4, 3, 1]);
  // 그래도 범위는 본다
  expectUsage(sh({ mode: 'spread', 'hot-count': 1001 }));
  expectUsage(sh({ mode: 'hot', 'hold-size': 5 }));
});

test('NFR-013 ADR-0057 parseArgs v0 --record면 profile 칸이 있고, 없으면 칸이 없다', () => {
  const rec = parseArgs(q({ record: true, 'run-id': '2026-11-03-k1' }));
  assert.equal(Object.hasOwn(rec, 'profile'), true);
  assert.equal(rec.profile, 'local-1k');
  for (const a of [q(), sh(), pay(), q({ invariants: true, out: 'x' })]) {
    assert.equal(Object.hasOwn(parseArgs(a), 'profile'), false, JSON.stringify(a));
  }
});

test('NFR-013 ADR-0057 parseArgs v0 payment 기본값: seats-per-order 2, 결제 시작 수의 상한(rate × (warm + main) + 2)이 users와 같으면 받는다', () => {
  assertV0(pay(), {
    command: 'v0',
    scenario: 'payment',
    users: 9002,
    warmS: 30,
    mainS: 60,
    cpus: 4,
    memoryMi: 4096,
    record: false,
    invariants: false,
    namespace: 'v0',
    settle: false,
    hpaTimeline: false,
    rate: 100,
    seatsPerOrder: 2,
    faultDropPct: 0,
    faultDelayPct: 0,
    dbStats: false,
  });
});

test('[ASVS v5.0.0-2.2.1] parseArgs v0 범위 경계: users 1~131,072, 도착률 1~100,000, warm 1~3,600, main 5~7,200, cpus 1~16, memory-mi 256~32,768', () => {
  const ok = [
    [q, 'users', 1, 'users'], [q, 'users', 131072, 'users'],
    [q, 'entry-rate', 1, 'entryRate'], [q, 'entry-rate', 100000, 'entryRate'],
    [q, 'admit-per-second', 1, 'admitPerSecond'], [q, 'admit-per-second', 100000, 'admitPerSecond'],
    // 도착률 최댓값은 IP당 한도의 60%(rate × 2 ≤ 6 × users)를 지키는 사용자 수와 함께 본다
    [sh, 'rate', 1, 'rate'], [(o) => sh({ users: 34000, ...o }), 'rate', 100000, 'rate'],
    [q, 'warm', 1, 'warmS'], [q, 'warm', 3600, 'warmS'], [q, 'main', 5, 'mainS'], [q, 'main', 7200, 'mainS'],
    [q, 'cpus', 1, 'cpus'], [q, 'cpus', 16, 'cpus'], [q, 'memory-mi', 256, 'memoryMi'], [q, 'memory-mi', 32768, 'memoryMi'],
  ];
  for (const [mk, flag, v, key] of ok) assert.equal(parseArgs(mk({ [flag]: v }))[key], v, `--${flag} ${v}`);
  const bad = [
    [q, 'users', 0], [q, 'users', 131073], [q, 'entry-rate', 0], [q, 'entry-rate', 100001],
    [q, 'admit-per-second', 0], [q, 'admit-per-second', 100001], [sh, 'rate', 0], [sh, 'rate', 100001],
    [q, 'warm', 0], [q, 'warm', 3601], [q, 'main', 0], [q, 'main', 4], [q, 'main', 7201], [q, 'cpus', 0], [q, 'cpus', 17],
    [q, 'memory-mi', 255], [q, 'memory-mi', 32769], [q, 'users', '99999999999999999999'],
  ];
  for (const [mk, flag, v] of bad) expectUsage(mk({ [flag]: v }));
});

test('[ASVS v5.0.0-2.2.1] parseArgs 범위 오류 메시지는 어느 인자가 틀렸는지 적는다', () => {
  expectUsage(q({ users: 0 }), /users/);
  expectUsage(q({ 'entry-rate': 100001 }), /entry-rate/);
});

test('[ASVS v5.0.0-2.2.1] parseArgs seat-hold 범위: hold-size 1~4, hot-count 1~1,000, pairs 1~1,000, release-ms 0~600,000', () => {
  const ok = [['hold-size', 1, 'holdSize'], ['hold-size', 4, 'holdSize'], ['hot-count', 1, 'hotCount'], ['hot-count', 1000, 'hotCount'],
    ['pairs', 1, 'pairs'], ['pairs', 1000, 'pairs'], ['release-ms', 0, 'releaseMs'], ['release-ms', 600000, 'releaseMs']];
  for (const [flag, v, key] of ok) assert.equal(parseArgs(sh({ [flag]: v }))[key], v, `--${flag} ${v}`);
  const bad = [['hold-size', 0], ['hold-size', 5], ['hot-count', 0], ['hot-count', 1001], ['pairs', 0], ['pairs', 1001],
    ['release-ms', 600001], ['release-ms', '-1']];
  for (const [flag, v] of bad) expectUsage(sh({ [flag]: v }));
});

test('[ASVS v5.0.0-2.2.1] parseArgs payment seats-per-order는 1~4', () => {
  assert.equal(parseArgs(pay({ 'seats-per-order': 1 })).seatsPerOrder, 1);
  assert.equal(parseArgs(pay({ 'seats-per-order': 4 })).seatsPerOrder, 4);
  expectUsage(pay({ 'seats-per-order': 0 }));
  expectUsage(pay({ 'seats-per-order': 5 }));
});

test('[ASVS v5.0.0-2.2.1] parseArgs 정수는 10진수 숫자만 받는다(부호·소수점·지수·공백·16진·자리 구분 거부, 앞의 0은 숫자라 받음)', () => {
  for (const v of ['1e3', '+5', '-1', '1.0', '1.', '.5', ' 5', '5 ', '\t5', '', '0x10', '0b11', '1_000', '1,000', 'Infinity', 'NaN',
    '٥', '５', '5\n']) {
    expectUsage(q({ users: v }));
  }
  assert.equal(parseArgs(q({ users: '05' })).users, 5);
  assert.equal(parseArgs(q({ users: '0100' })).users, 100);
});

test('[ASVS v5.0.0-2.2.1] parseArgs --mode는 spread·hot·crossed만', () => {
  for (const mode of ['HOT', 'Spread', 'random', 'hot ', '']) expectUsage(sh({ mode }));
});

test('[ASVS v5.0.0-2.2.1] parseArgs 그 시나리오에 없는 인자는 거부한다(queue의 --rate, payment의 --mode, seat-hold의 --entry-rate 등)', () => {
  const cases = [
    q({ rate: 100 }), q({ mode: 'hot' }), q({ 'seats-per-order': 2 }), q({ 'hold-size': 2 }), q({ 'hot-count': 2 }),
    q({ pairs: 2 }), q({ 'release-ms': 5 }),
    sh({ 'entry-rate': 100 }), sh({ 'admit-per-second': 28 }), sh({ 'seats-per-order': 2 }),
    pay({ mode: 'spread' }), pay({ 'hot-count': 1 }), pay({ pairs: 1 }), pay({ 'release-ms': 0 }), pay({ 'hold-size': 2 }),
    pay({ 'entry-rate': 100 }), pay({ 'admit-per-second': 28 }),
    q({ rates: '1000,2000' }), q({ 'target-cpus': 8 }), sh({ rates: '1000' }), pay({ 'target-cpus': 8 }),
  ];
  for (const a of cases) expectUsage(a);
});

test('[ASVS v5.0.0-2.2.1] parseArgs 시나리오의 필수 인자가 없으면 거부한다', () => {
  for (const a of [q({ users: undefined }), q({ 'entry-rate': undefined }), q({ 'admit-per-second': undefined }),
    sh({ users: undefined }), sh({ rate: undefined }), pay({ users: undefined }), pay({ rate: undefined }),
    ['v0', 'queue'], ['v0', 'seat-hold'], ['v0', 'payment']]) {
    expectUsage(a);
  }
});

test('[ASVS v5.0.0-2.2.1] parseArgs 모르는 인자·남는 위치 인자·객체 원형 이름 인자는 거부한다', () => {
  for (const a of [
    q({ bogus: 1 }),
    [...q(), '-users', '5'],
    [...q(), 'extra'],
    [...q(), '--record', 'yes', '--run-id', '2026-11-03-k1'],
    [...q(), '--__proto__', '1'],
    [...q(), '--constructor', '1'],
    [...q(), '--toString', '1'],
    [...q(), '--hasOwnProperty', '1'],
    [...cal(), 'queue'],
    [...cal(), '--bogus', '1'],
  ]) {
    expectUsage(a);
  }
});

test('[ASVS v5.0.0-2.2.1] parseArgs 같은 인자를 두 번 주면 거부한다(값이 같아도, 값 없는 인자도)', () => {
  expectUsage([...q(), '--users', '1000']);
  expectUsage([...q(), '--users', '2000']);
  expectUsage([...q({ invariants: true }), '--invariants']);
  expectUsage([...q({ record: true, 'run-id': '2026-11-03-k1' }), '--record']);
  expectUsage([...cal({ rates: '1,2' }), '--rates', '1,2']);
  expectUsage([...cal({ record: true }), '--record']);
});

test('[ASVS v5.0.0-2.2.1] parseArgs 값이 없는 인자(다음이 --로 시작하거나 끝)는 거부한다', () => {
  expectUsage(['v0', 'queue', '--users', '--entry-rate', '500', '--admit-per-second', '28']);
  expectUsage(['v0', 'queue', '--users', '1000', '--entry-rate', '500', '--admit-per-second']);
  expectUsage([...q(), '--out']);
  expectUsage([...q(), '--out', '--invariants']);
  expectUsage(['calibrate', '--rates']);
  expectUsage(['calibrate', '--cpus', '--record']);
  expectUsage([...sh(), '--mode', '--pairs', '2']);
});

test('[ASVS v5.0.0-2.2.1] parseArgs 모르는 명령·시나리오는 거부한다(객체 원형 이름 포함)', () => {
  for (const a of [[], ['v1', 'queue'], ['V0', 'queue'], ['Calibrate'], ['run'], ['v0'], ['v0', 'queues'], ['v0', 'Queue'],
    ['v0', 'v0-queue.js'], ['v0', 'toString'], ['v0', '__proto__'], ['v0', 'constructor'], ['v0', 'hasOwnProperty'],
    ['v0', '--users', '5'], ['v0', 'calibrate'], ['--users', '5']]) {
    expectUsage(a);
  }
});

test('[ASVS v5.0.0-2.2.1] parseArgs v0 --record는 --run-id가 있어야 하고 --run-id·--profile은 --record 없이 줄 수 없다', () => {
  expectUsage(q({ record: true }));
  expectUsage(q({ 'run-id': '2026-11-03-k1' }));
  expectUsage(q({ profile: 'local-gen' }));
  expectUsage(q({ 'run-id': '2026-11-03-k1', profile: 'local-gen' }));
  const r = parseArgs(q({ record: true, 'run-id': '2026-11-03-k1' }));
  assert.equal(r.record, true);
  assert.equal(r.runId, '2026-11-03-k1');
});

test('[ASVS v5.0.0-2.2.1] parseArgs --run-id는 YYYY-MM-DD- 뒤 소문자·숫자로 시작하는 1~81자만 받는다', () => {
  const rid = (id) => q({ record: true, 'run-id': id });
  for (const id of ['2026-11-03-k1', '2026-11-03-0', '2026-11-03-k1-v0-local-10k', `2026-11-03-a${'b'.repeat(80)}`]) {
    assert.equal(parseArgs(rid(id)).runId, id);
  }
  for (const id of [`2026-11-03-a${'b'.repeat(81)}`, '2026-11-3-k1', '26-11-03-k1', '2026-11-03', '2026-11-03-', '2026-11-03--k1',
    '2026-11-03-K1', '2026-11-03-k_1', '2026-11-03-k1/..', '../2026-11-03-k1', '2026-11-03-k1 ', ' 2026-11-03-k1',
    '2026-11-03-k1\n', '2026-11-03-k1;rm', '2026-11-03-k1.json', '２026-11-03-k1']) {
    expectUsage(rid(id));
  }
});

test('[ASVS v5.0.0-2.2.1] parseArgs --profile은 local- 뒤 소문자·숫자·- 1~20자만 받는다', () => {
  const prof = (p) => q({ record: true, 'run-id': '2026-11-03-k1', profile: p });
  for (const p of ['local-gen', 'local-1k', `local-${'a'.repeat(20)}`, 'local--']) assert.equal(parseArgs(prof(p)).profile, p);
  for (const p of ['local-', `local-${'a'.repeat(21)}`, 'cloud-1k', 'local-1K', 'local_1k', 'local-1k\n', 'local-1k/..', 'Local-1k',
    ' local-1k', 'local-1.k']) {
    expectUsage(prof(p));
  }
});

test('NFR-013 ADR-0057 parseArgs --record에서 --profile 기본은 사용자 수로 정한다(1,000 이하 local-1k, 10,000 이하 local-10k, 그 밖 local-100k)', () => {
  const cases = [[1, 'local-1k'], [1000, 'local-1k'], [1001, 'local-10k'], [10000, 'local-10k'], [10001, 'local-100k'],
    [131072, 'local-100k']];
  for (const [users, profile] of cases) {
    assert.equal(parseArgs(q({ users, record: true, 'run-id': '2026-11-03-k1' })).profile, profile, `users=${users}`);
  }
  // 결제 시나리오도 같은 규칙(9,002명 → local-10k)
  assert.equal(parseArgs(pay({ record: true, 'run-id': '2026-11-03-k7' })).profile, 'local-10k');
});

test('[ASVS v5.0.0-2.2.1] parseArgs payment는 users × seats-per-order ≤ 100,000이어야 한다', () => {
  assert.equal(parseArgs(pay({ users: 50000, rate: 1 })).users, 50000); // 50,000 × 2 = 100,000
  expectUsage(pay({ users: 50001, rate: 1 }));
  assert.equal(parseArgs(pay({ users: 25000, rate: 1, 'seats-per-order': 4 })).users, 25000);
  expectUsage(pay({ users: 25001, rate: 1, 'seats-per-order': 4 }));
  assert.equal(parseArgs(pay({ users: 100000, rate: 1, 'seats-per-order': 1 })).users, 100000);
  expectUsage(pay({ users: 100001, rate: 1, 'seats-per-order': 1 }));
  expectUsage(pay({ users: 131072, rate: 1, 'seats-per-order': 1 }));
});

test('[ASVS v5.0.0-2.2.1] parseArgs payment는 결제 시작 수의 상한 rate × (warm + main) + 2가 users 이하여야 한다(같으면 받고 하나 모자라면 거부)', () => {
  // 도착률 실행기는 구간(예열·본구간)마다 '도착률 × 시간 + 1'번까지 시작할 수 있어 두 구간이면 + 2다
  const small = { rate: 5, warm: 2, main: 10 }; // 5 × 12 + 2 = 62
  assert.equal(parseArgs(pay({ ...small, users: 62 })).users, 62);
  assert.equal(parseArgs(pay({ ...small, users: 100 })).users, 100);
  expectUsage(pay({ ...small, users: 61 }));
  expectUsage(pay({ ...small, users: 60 })); // 옛 규칙(rate × (warm + main) ≤ users)이면 받았을 값
  assert.equal(parseArgs(pay()).users, 9002); // 100 × 90 + 2
  expectUsage(pay({ users: 9001 }));
  expectUsage(pay({ rate: 101 })); // 101 × 90 + 2 = 9,092 > 9,002
  assert.equal(parseArgs(pay({ warm: 10, main: 20, rate: 300 })).rate, 300); // 300 × 30 + 2 = 9,002
  expectUsage(pay({ warm: 10, main: 20, rate: 301 })); // 9,032
  assert.equal(parseArgs(pay({ users: 92, rate: 1 })).users, 92); // 1 × 90 + 2
  expectUsage(pay({ users: 91, rate: 1 }));
  expectUsage(pay({ users: 90, rate: 1 }));
  // 가장 작은 실행(본구간 최소 5초): 1 × (1 + 5) + 2 = 8명
  assert.equal(parseArgs(pay({ users: 8, rate: 1, warm: 1, main: 5 })).users, 8);
  expectUsage(pay({ users: 7, rate: 1, warm: 1, main: 5 }));
});

test('[ASVS v5.0.0-2.2.1] parseArgs --out은 비지 않은 경로만 받고 그대로 둔다', () => {
  expectUsage(q({ out: '' }));
  expectUsage(cal({ out: '' }));
  for (const out of ['out', '.cache/peaket-loadtest/r1', 'C:\\Users\\x\\My Runs\\r 1', '/tmp/a b/c']) {
    assert.equal(parseArgs(q({ out })).out, out);
  }
});

// ---------------------------------------------------------------------------------------------
// manifests.mjs: 상수와 고정 스크립트
// ---------------------------------------------------------------------------------------------

test('[ASVS v5.0.0-13.2.2] 이미지는 태그와 sha256 다이제스트로 고정하고 k6는 PoC 스택과 같은 다이제스트다', () => {
  assert.match(K6_IMAGE, /^grafana\/k6:1\.4\.2@sha256:[0-9a-f]{64}$/);
  assert.match(NULL_TARGET_IMAGE, /^nginxinc\/nginx-unprivileged:[^@\s]+@sha256:[0-9a-f]{64}$/);
  assert.ok(readFileSync(join(REPO, 'loadtest', 'poc', 'stack.mjs'), 'utf8').includes(K6_IMAGE));
  assert.equal(LOADGEN_NAMESPACE, 'loadtest');
  assert.equal(K6_UID, 12345);
});

test('NFR-013 ADR-0057 빈 응답 대역 본문은 JSON 객체이고 nginx 작은따옴표 문자열에 넣어도 해석될 글자($·작은따옴표·역슬래시)가 없다', () => {
  const body = JSON.parse(NULL_TARGET_BODY);
  assert.equal(body.status, 'WAITING');
  assert.doesNotMatch(NULL_TARGET_BODY, /['$\\\n]/);
});

test('NFR-013 ADR-0057 SAMPLER_COMMAND는 1초마다 유닉스 초·가동 초·cgroup CPU 사용 µs·메모리 바이트를 cgroup.log에 덧붙인다', () => {
  assert.ok(Object.isFrozen(SAMPLER_COMMAND));
  assert.equal(SAMPLER_COMMAND.length, 3);
  assert.deepStrictEqual(SAMPLER_COMMAND.slice(0, 2), ['sh', '-c']);
  const s = SAMPLER_COMMAND[2];
  for (const part of ['mkdir -p /work/out', '/proc/uptime', '/sys/fs/cgroup/cpu.stat', 'usage_usec', '/sys/fs/cgroup/memory.current',
    'date +%s', 'sleep 1', '>> /work/out/cgroup.log']) {
    assert.ok(s.includes(part), `빠짐: ${part}`);
  }
  // 표본 한 줄은 네 칸: date, uptime 첫 칸, usage_usec, memory.current
  assert.match(s, /echo "\$\(date \+%s\) \$up \$\(awk [^)]*usage_usec[^)]*\) \$\(cat \/sys\/fs\/cgroup\/memory\.current\)"/);
});

test('[ASVS v5.0.0-1.2.5] RUN_SCRIPT는 고정 글로 /work/run.env를 내보내기 변수로 읽고 k6를 돌린 뒤 종료 코드를 out/exit에 쓴다', () => {
  assert.ok(RUN_SCRIPT.startsWith('#!/bin/sh\n'));
  const at = (s) => {
    const i = RUN_SCRIPT.indexOf(s);
    assert.ok(i >= 0, `빠짐: ${s}`);
    return i;
  };
  assert.ok(at('set -a') < at('. /work/run.env') && at('. /work/run.env') < at('set +a') && at('set +a') < at('k6 run'));
  assert.ok(at('cd /work') < at('k6 run'));
  assert.ok(at('rm -f out/exit') < at('k6 run'), '앞 실행의 out/exit를 지운 뒤 돌린다');
  assert.ok(at('k6 run') < at('echo $? > out/exit'));
  const k6Line = RUN_SCRIPT.split('\n').find((l) => l.startsWith('k6 run'));
  for (const flag of ['--no-usage-report', '--console-output=out/console.ndjson', '--log-format=raw']) {
    assert.ok(k6Line.split(/\s+/).includes(flag), `k6 인자 빠짐: ${flag}`);
  }
  assert.ok(k6Line.includes('"loadtest/scenarios/$SCENARIO"'), '시나리오 경로는 따옴표로 감싼다');
});

test('[ASVS v5.0.0-16.2.5] RUN_SCRIPT·SAMPLER_COMMAND는 환경 값(시험 키)을 로그에 펼치지 않는다(set -x·env·printenv 없음)', () => {
  for (const s of [RUN_SCRIPT, SAMPLER_COMMAND[2]]) {
    assert.doesNotMatch(s, /set\s+-[a-z]*x/);
    assert.doesNotMatch(s, /(^|[;&|(]\s*)(env|printenv)\b/m);
    assert.doesNotMatch(s, /PG_SIMULATOR_SECRET_KEY/);
  }
});

// ---------------------------------------------------------------------------------------------
// manifests.mjs: generatorPod
// ---------------------------------------------------------------------------------------------

const envByName = (c) => Object.fromEntries((c.env ?? []).map((e) => [e.name, e]));
/** 바른 입력 폴더(노드의 <NODE_ROOT>/<실행 꼬리표>). 다른 칸의 거절 시험이 hostDir 때문에 거절되지 않도록 늘 싣는다 */
const HOST_DIR = `${NODE_ROOT}/r1`;
const gpod = (o) => generatorPod({ hostDir: HOST_DIR, ...o });

test('NFR-013 ADR-0057 generatorPod 요청과 한도가 같아 CPU·메모리 몫을 보장받는다(Guaranteed)', () => {
  const pod = gpod({ name: 'loadgen-r1', cpus: 4, memoryMi: 4096 });
  assert.equal(pod.apiVersion, 'v1');
  assert.equal(pod.kind, 'Pod');
  assert.equal(pod.spec.containers.length, 1);
  const c = pod.spec.containers[0];
  assert.deepStrictEqual(c.resources.requests, { cpu: '4', memory: '4096Mi' });
  assert.deepStrictEqual(c.resources.limits, { cpu: '4', memory: '4096Mi' });
  const big = gpod({ name: 'g', cpus: 16, memoryMi: 32768 }).spec.containers[0];
  assert.deepStrictEqual(big.resources, { requests: { cpu: '16', memory: '32768Mi' }, limits: { cpu: '16', memory: '32768Mi' } });
  const small = gpod({ name: 'g', cpus: 1, memoryMi: 256 }).spec.containers[0];
  assert.deepStrictEqual(small.resources, { requests: { cpu: '1', memory: '256Mi' }, limits: { cpu: '1', memory: '256Mi' } });
  assert.equal(envByName(big).GOMAXPROCS.value, '16');
  assert.equal(envByName(small).GOMAXPROCS.value, '1');
});

test('NFR-013 ADR-0057 generatorPod 메타데이터·재시작·컨테이너·명령·마운트·볼륨이 JSDoc 그대로다', () => {
  const pod = gpod({ name: 'loadgen-r1', cpus: 4, memoryMi: 4096 });
  assert.equal(pod.metadata.name, 'loadgen-r1');
  assert.equal(pod.metadata.namespace, LOADGEN_NAMESPACE);
  assert.deepStrictEqual(pod.metadata.labels, { 'app.kubernetes.io/name': 'loadgen', 'app.kubernetes.io/part-of': 'peaket-loadtest' });
  assert.equal(pod.spec.restartPolicy, 'Never');
  assert.equal(pod.spec.terminationGracePeriodSeconds, 5);
  const c = pod.spec.containers[0];
  assert.equal(c.name, 'k6');
  assert.equal(c.image, K6_IMAGE);
  assert.equal(c.imagePullPolicy, 'IfNotPresent');
  assert.deepStrictEqual([...c.command], [...SAMPLER_COMMAND]);
  const env = envByName(c);
  assert.deepStrictEqual(Object.keys(env).sort(), ['GOMAXPROCS', 'K6_NO_USAGE_REPORT', 'SSL_CERT_FILE']);
  assert.equal(env.GOMAXPROCS.value, '4');
  assert.equal(env.K6_NO_USAGE_REPORT.value, 'true');
  assert.equal(env.SSL_CERT_FILE.value, '/work/ca.pem');
  for (const e of c.env) assert.equal(typeof e.value, 'string', `${e.name} 값은 문자열`);
  const mounts = Object.fromEntries(c.volumeMounts.map((m) => [m.name, m]));
  assert.deepStrictEqual(Object.keys(mounts).sort(), ['tmp', 'work']);
  assert.equal(mounts.work.mountPath, '/work');
  assert.equal(mounts.tmp.mountPath, '/tmp');
  assert.notEqual(mounts.work.readOnly, true);
  const vols = Object.fromEntries(pod.spec.volumes.map((v) => [v.name, v]));
  assert.deepStrictEqual(Object.keys(vols).sort(), ['tmp', 'work']);
  // 입력은 노드 폴더를 hostPath로 붙인다(kubectl exec -i의 표준 입력이 잘려서). 폴더가 없으면 파드가 뜨지 않게 type Directory
  assert.deepStrictEqual(vols.work.hostPath, { path: HOST_DIR, type: 'Directory' });
  assert.equal(vols.work.emptyDir, undefined, 'work는 emptyDir이 아니다');
  assert.deepStrictEqual(vols.tmp.emptyDir, { sizeLimit: '64Mi' });
  assert.equal(vols.tmp.hostPath, undefined);
  // 입력 폴더가 있는 노드에 놓는다
  assert.deepStrictEqual(pod.spec.nodeSelector, { 'kubernetes.io/hostname': KIND_NODE });
  // 다른 꼬리표의 폴더는 그 경로 그대로
  const other = gpod({ name: 'g', cpus: 1, memoryMi: 256, hostDir: `${NODE_ROOT}/abcdefghij012345` });
  assert.deepStrictEqual(other.spec.volumes.find((v) => v.name === 'work').hostPath, { path: `${NODE_ROOT}/abcdefghij012345`, type: 'Directory' });
});

test('NFR-013 ADR-0057 KIND_NODE는 kind 클러스터(deploy/local/kind.yaml)의 유일한 control-plane 노드 이름이고 NODE_ROOT는 고정 경로다', () => {
  assert.equal(NODE_ROOT, '/var/local/peaket-loadtest');
  const kindYaml = readFileSync(join(REPO, 'deploy', 'local', 'kind.yaml'), 'utf8');
  const cluster = /^name:\s*(\S+)\s*$/m.exec(kindYaml)?.[1];
  assert.equal(cluster, 'peaket');
  assert.equal(KIND_NODE, `${cluster}-control-plane`);
  // 노드가 하나(control-plane)뿐이어야 kind가 control-plane 테인트를 떼어 nodeSelector만으로 자리를 잡는다
  assert.deepStrictEqual([...kindYaml.matchAll(/^\s*-\s*role:\s*(\S+)/gm)].map((m) => m[1]), ['control-plane']);
});

test('[ASVS v5.0.0-13.2.2] generatorPod 최소 권한: 토큰·서비스 링크 없음, 루트 아닌 12345, seccomp RuntimeDefault, 권한 상승 금지·읽기 전용 루트·모든 권한 버림', () => {
  const pod = gpod({ name: 'loadgen-r1', cpus: 4, memoryMi: 4096, simKey: true });
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.enableServiceLinks, false);
  assert.deepStrictEqual(pod.spec.securityContext, {
    runAsNonRoot: true,
    runAsUser: K6_UID,
    runAsGroup: K6_UID,
    fsGroup: K6_UID,
    seccompProfile: { type: 'RuntimeDefault' },
  });
  const c = pod.spec.containers[0];
  assert.deepStrictEqual(c.securityContext, {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ['ALL'] },
  });
  for (const k of ['hostNetwork', 'hostPID', 'hostIPC']) assert.notEqual(pod.spec[k], true, k);
  // hostPath는 work 하나뿐이고 그 경로는 NODE_ROOT 아래 실행 폴더다(노드의 다른 곳을 붙이지 않는다)
  const hostPaths = pod.spec.volumes.filter((v) => v.hostPath);
  assert.deepStrictEqual(hostPaths.map((v) => [v.name, v.hostPath.path, v.hostPath.type]), [['work', HOST_DIR, 'Directory']]);
  assert.ok(pod.spec.containers.every((c) => (c.volumeMounts ?? []).every((m) => !m.subPath && !m.subPathExpr)), 'hostPath를 subPath로 넓히지 않는다');
});

test('[ASVS v5.0.0-13.3.1] generatorPod simKey면 PG_SIMULATOR_SECRET_KEY를 Secret 참조로만 싣고, 아니면 싣지 않는다', () => {
  const withKey = gpod({ name: 'loadgen-r1', cpus: 4, memoryMi: 4096, simKey: true });
  const env = envByName(withKey.spec.containers[0]);
  assert.deepStrictEqual(Object.keys(env).sort(), ['GOMAXPROCS', 'K6_NO_USAGE_REPORT', 'PG_SIMULATOR_SECRET_KEY', 'SSL_CERT_FILE']);
  const k = env.PG_SIMULATOR_SECRET_KEY;
  assert.equal(Object.hasOwn(k, 'value'), false, '글자 값으로 싣지 않는다');
  assert.equal(k.valueFrom.secretKeyRef.name, SIM_KEY_SECRET);
  assert.equal(k.valueFrom.secretKeyRef.key, SIM_KEY_NAME);
  assert.equal(SIM_KEY_SECRET, 'loadgen-sim');
  assert.equal(SIM_KEY_NAME, 'PG_SIMULATOR_SECRET_KEY');
  assert.doesNotMatch(JSON.stringify(withKey), /sim_sk_/);
  for (const simKey of [undefined, false]) {
    const pod = gpod({ name: 'loadgen-r1', cpus: 4, memoryMi: 4096, simKey });
    assert.equal(envByName(pod.spec.containers[0]).PG_SIMULATOR_SECRET_KEY, undefined);
    assert.doesNotMatch(JSON.stringify(pod), /secretKeyRef|PG_SIMULATOR_SECRET_KEY/);
  }
});

test('[ASVS v5.0.0-2.2.1] generatorPod 이름·CPU·메모리가 규칙 밖이면 RangeError', () => {
  for (const name of ['a', '0', 'ab', 'loadgen-r1', `a${'b'.repeat(40)}c`]) {
    assert.equal(gpod({ name, cpus: 4, memoryMi: 4096 }).metadata.name, name);
  }
  for (const name of ['', 'A', 'Loadgen', '-a', 'a-', 'a_b', 'a.b', 'a b', `a${'b'.repeat(41)}c`, 'loadgen\n', '../x']) {
    assert.throws(() => gpod({ name, cpus: 4, memoryMi: 4096 }), RangeError, `name=${JSON.stringify(name)}`);
  }
  for (const cpus of [0, 17, 1.5, -1, NaN, Infinity, '4', null, undefined]) {
    assert.throws(() => gpod({ name: 'g', cpus, memoryMi: 4096 }), RangeError, `cpus=${String(cpus)}`);
  }
  for (const memoryMi of [255, 32769, 256.5, 0, NaN, '4096', null, undefined]) {
    assert.throws(() => gpod({ name: 'g', cpus: 4, memoryMi }), RangeError, `memoryMi=${String(memoryMi)}`);
  }
});

test('[ASVS v5.0.0-2.2.1] [ASVS v5.0.0-13.2.2] generatorPod hostDir는 <NODE_ROOT>/<영소문자·숫자 1~16자>만 받는다(노드의 다른 경로 거절)', () => {
  for (const tag of ['a', '0', 'r1', 'abcdefghij012345']) {
    const hostDir = `${NODE_ROOT}/${tag}`;
    assert.equal(generatorPod({ name: 'g', cpus: 1, memoryMi: 256, hostDir }).spec.volumes.find((v) => v.name === 'work').hostPath.path, hostDir);
  }
  for (const hostDir of [
    undefined,
    null,
    '',
    42,
    [`${NODE_ROOT}/r1`],
    NODE_ROOT, // 뿌리 자체
    `${NODE_ROOT}/`,
    `${NODE_ROOT}/r1/`, // 끝 빗금
    `${NODE_ROOT}/ABC`, // 대문자
    `${NODE_ROOT}/abcdefghij0123456`, // 17자
    `${NODE_ROOT}/a/..`,
    `${NODE_ROOT}/..`,
    `${NODE_ROOT}/../etc`,
    `${NODE_ROOT}/r1/out`, // 한 단계 더 깊음
    `${NODE_ROOT}//r1`,
    `${NODE_ROOT}/r-1`,
    `${NODE_ROOT}/r_1`,
    `${NODE_ROOT}/r1\n`,
    `${NODE_ROOT}/ r1`,
    `${NODE_ROOT}x/r1`, // 뿌리 이름 앞머리만 같음
    `/var/local/peaket/r1`,
    '/etc',
    '/',
    'r1',
    `.${NODE_ROOT}/r1`,
    `${NODE_ROOT}\\r1`,
    `C:${NODE_ROOT}/r1`,
  ]) {
    assert.throws(() => generatorPod({ name: 'g', cpus: 1, memoryMi: 256, hostDir }), RangeError, `hostDir=${JSON.stringify(hostDir)}`);
  }
  // hostDir 칸이 아예 없어도 거절한다
  assert.throws(() => generatorPod({ name: 'g', cpus: 1, memoryMi: 256 }), RangeError);
});

// ---------------------------------------------------------------------------------------------
// manifests.mjs: 빈 응답 대역
// ---------------------------------------------------------------------------------------------

function nullTarget(cpus = 4) {
  const objs = nullTargetManifests({ cpus });
  assert.ok(Array.isArray(objs));
  assert.equal(objs.length, 3);
  const [cm, dep, svc] = objs;
  return { objs, cm, dep, svc, conf: cm.data['nginx.conf'], pod: dep.spec.template.spec, c: dep.spec.template.spec.containers[0] };
}

test('NFR-013 ADR-0057 nullTargetManifests ConfigMap·Deployment·Service 순서로 loadtest 네임스페이스의 null-target이다', () => {
  const { objs, cm, dep, svc } = nullTarget();
  assert.deepStrictEqual(objs.map((o) => o.kind), ['ConfigMap', 'Deployment', 'Service']);
  assert.deepStrictEqual([cm.apiVersion, dep.apiVersion, svc.apiVersion], ['v1', 'apps/v1', 'v1']);
  for (const o of objs) {
    assert.equal(o.metadata.name, NULL_TARGET_NAME);
    assert.equal(o.metadata.namespace, LOADGEN_NAMESPACE);
  }
  assert.equal(NULL_TARGET_NAME, 'null-target');
  assert.equal(NULL_TARGET_PORT, 8443);
});

test('NFR-013 ADR-0057 nullTargetManifests nginx.conf: 작업자 수 = cpus, TLS 8443, 고정 JSON 200, 접근 로그 끔, pid·임시 경로는 /tmp', () => {
  const { conf } = nullTarget(4);
  assert.equal(typeof conf, 'string');
  assert.match(conf, /^\s*worker_processes\s+4;/m);
  assert.match(conf, /^\s*pid\s+\/tmp\/nginx\.pid;/m);
  assert.match(conf, /^\s*access_log\s+off;/m);
  assert.match(conf, /^\s*listen\s+8443\s+ssl\b[^;]*;/m);
  assert.match(conf, /^\s*ssl_certificate\s+\/etc\/null-target\/tls\.crt;/m);
  assert.match(conf, /^\s*ssl_certificate_key\s+\/etc\/null-target\/tls\.key;/m);
  assert.match(conf, /^\s*keepalive_requests\s+1000000;/m);
  assert.match(conf, /^\s*default_type\s+application\/json;/m);
  assert.ok(conf.includes(`return 200 '${NULL_TARGET_BODY}';`), '고정 JSON을 그대로 돌려준다');
  // 읽기 전용 루트 파일 시스템에서는 nginx가 시작할 때 만드는 임시 폴더 다섯이 모두 /tmp 아래여야 한다
  for (const d of ['client_body_temp_path', 'proxy_temp_path', 'fastcgi_temp_path', 'uwsgi_temp_path', 'scgi_temp_path']) {
    assert.match(conf, new RegExp(`^\\s*${d}\\s+/tmp/[^;\\s]+;`, 'm'), d);
  }
  const temps = [...conf.matchAll(/^\s*\w+_temp_path\s+(\S+)/gm)].map((m) => m[1]);
  assert.ok(temps.every((p) => p.startsWith('/tmp/')), temps.join(','));
  assert.match(nullTarget(1).conf, /^\s*worker_processes\s+1;/m);
  assert.match(nullTarget(16).conf, /^\s*worker_processes\s+16;/m);
});

test('[ASVS v5.0.0-13.2.2] nullTargetManifests Deployment: 복제 1, 토큰 없음, 사용자 101, 읽기 전용 루트, 모든 권한 버림, 요청=한도, 이미지 고정', () => {
  const { dep, pod, c } = nullTarget(4);
  assert.equal(dep.spec.replicas, 1);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.containers.length, 1);
  const runAsUser = c.securityContext?.runAsUser ?? pod.securityContext?.runAsUser;
  assert.equal(runAsUser, 101);
  assert.notEqual(c.securityContext?.runAsNonRoot ?? pod.securityContext?.runAsNonRoot, false);
  assert.equal(c.securityContext.readOnlyRootFilesystem, true);
  assert.deepStrictEqual(c.securityContext.capabilities.drop, ['ALL']);
  assert.notEqual(c.securityContext.privileged, true);
  assert.notEqual(c.securityContext.allowPrivilegeEscalation, true);
  assert.equal(c.image, NULL_TARGET_IMAGE);
  assert.deepStrictEqual(c.resources, { requests: { cpu: '4', memory: '256Mi' }, limits: { cpu: '4', memory: '256Mi' } });
  assert.deepStrictEqual(nullTarget(1).c.resources, { requests: { cpu: '1', memory: '256Mi' }, limits: { cpu: '1', memory: '256Mi' } });
  for (const k of ['hostNetwork', 'hostPID', 'hostIPC']) assert.notEqual(pod[k], true, k);
  // 선택자가 파드 꼬리표와 맞아야 Deployment가 성립한다
  const sel = dep.spec.selector.matchLabels;
  assert.ok(Object.keys(sel).length > 0);
  for (const [k, v] of Object.entries(sel)) assert.equal(dep.spec.template.metadata.labels[k], v);
});

test('NFR-013 ADR-0057 nullTargetManifests 마운트: 설정은 subPath로 /etc/nginx/nginx.conf, TLS Secret은 /etc/null-target, /tmp는 emptyDir, 준비 확인은 TCP 8443', () => {
  const { pod, c } = nullTarget(4);
  const vols = Object.fromEntries(pod.volumes.map((v) => [v.name, v]));
  const mountAt = (p) => {
    const m = c.volumeMounts.find((x) => x.mountPath === p);
    assert.ok(m, `마운트 없음: ${p}`);
    assert.ok(vols[m.name], `볼륨 없음: ${m.name}`);
    return { m, v: vols[m.name] };
  };
  const conf = mountAt('/etc/nginx/nginx.conf');
  assert.equal(conf.m.subPath, 'nginx.conf');
  assert.equal(conf.v.configMap.name, NULL_TARGET_NAME);
  const tls = mountAt('/etc/null-target');
  assert.equal(tls.v.secret.secretName, NULL_TARGET_NAME);
  if (tls.v.secret.items) assert.deepStrictEqual(tls.v.secret.items.map((i) => i.key).sort(), ['tls.crt', 'tls.key']);
  const tmp = mountAt('/tmp');
  assert.ok(tmp.v.emptyDir, '/tmp는 emptyDir');
  assert.equal(c.readinessProbe.tcpSocket.port, NULL_TARGET_PORT);
  assert.ok(pod.volumes.every((v) => !v.hostPath));
});

test('NFR-013 ADR-0057 nullTargetManifests Service: 8443 → 8443이고 선택자가 대역 파드를 가리킨다', () => {
  const { dep, svc } = nullTarget(4);
  assert.equal(svc.spec.ports.length, 1);
  assert.equal(svc.spec.ports[0].port, NULL_TARGET_PORT);
  assert.equal(svc.spec.ports[0].targetPort, NULL_TARGET_PORT);
  assert.ok(Object.keys(svc.spec.selector).length > 0);
  for (const [k, v] of Object.entries(svc.spec.selector)) assert.equal(dep.spec.template.metadata.labels[k], v);
});

test('[ASVS v5.0.0-2.2.1] nullTargetManifests cpus가 1~16 정수가 아니면 RangeError', () => {
  for (const cpus of [0, 17, 2.5, -4, NaN, '2', null, undefined]) {
    assert.throws(() => nullTargetManifests({ cpus }), RangeError, `cpus=${String(cpus)}`);
  }
});

const PEM_CERT = rootCertificates[0];
const { privateKey: EC_KEY } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM_KEY_PKCS8 = EC_KEY.export({ type: 'pkcs8', format: 'pem' });
const PEM_KEY_SEC1 = EC_KEY.export({ type: 'sec1', format: 'pem' });

test('[ASVS v5.0.0-13.3.1] nullTargetSecret TLS Secret(kubernetes.io/tls)에 인증서와 키를 그대로 담는다', () => {
  for (const key of [PEM_KEY_PKCS8, PEM_KEY_SEC1]) {
    const s = nullTargetSecret({ cert: PEM_CERT, key });
    assert.equal(s.apiVersion, 'v1');
    assert.equal(s.kind, 'Secret');
    assert.equal(s.metadata.name, NULL_TARGET_NAME);
    assert.equal(s.metadata.namespace, LOADGEN_NAMESPACE);
    assert.equal(s.type, 'kubernetes.io/tls');
    assert.deepStrictEqual(s.stringData, { 'tls.crt': PEM_CERT, 'tls.key': key });
  }
});

test('[ASVS v5.0.0-2.2.1] nullTargetSecret PEM 꼴이 아니면 Error', () => {
  assert.equal(nullTargetSecret({ cert: PEM_CERT, key: PEM_KEY_PKCS8 }).type, 'kubernetes.io/tls'); // 기준: 바른 PEM은 받는다
  const bad = [
    { cert: 'not a cert', key: PEM_KEY_PKCS8 },
    { cert: '', key: PEM_KEY_PKCS8 },
    { cert: PEM_CERT, key: 'not a key' },
    { cert: PEM_CERT, key: '' },
    { cert: '-----BEGIN CERTIFICATE-----\nMIIB\n', key: PEM_KEY_PKCS8 }, // 끝 줄 없음
    { cert: PEM_CERT, key: undefined },
    { cert: undefined, key: PEM_KEY_PKCS8 },
    { cert: 42, key: PEM_KEY_PKCS8 },
  ];
  for (const o of bad) assert.throws(() => nullTargetSecret(o), Error, JSON.stringify(o).slice(0, 80));
});

test('[ASVS v5.0.0-16.2.5] nullTargetSecret 오류 메시지에 키 글을 싣지 않는다', () => {
  assert.equal(nullTargetSecret({ cert: PEM_CERT, key: PEM_KEY_SEC1 }).stringData['tls.key'], PEM_KEY_SEC1);
  const key = 'PRIVATE-MATERIAL-7f3a9c2e1b';
  assert.throws(
    () => nullTargetSecret({ cert: PEM_CERT, key }),
    (e) => e instanceof Error && !e.message.includes('PRIVATE-MATERIAL') && !e.message.includes('7f3a9c2e1b'),
  );
});

test('NFR-013 ADR-0057 nullTargetCertArgs: 자체 서명 EC P-256, 1일, SAN 세 이름, 키·인증서 파일 위치', () => {
  const args = nullTargetCertArgs('/tmp/k.pem', '/tmp/c.pem');
  assert.ok(Array.isArray(args) && args.length > 0);
  assert.ok(args.every((a) => typeof a === 'string'));
  assert.ok(args.includes('req') && args.includes('-x509'), '자체 서명 인증서(req -x509)');
  assert.equal(args[args.indexOf('-keyout') + 1], '/tmp/k.pem');
  assert.equal(args[args.indexOf('-out') + 1], '/tmp/c.pem');
  assert.equal(args[args.indexOf('-days') + 1], '1');
  assert.match(args[args.indexOf('-newkey') + 1], /^ec\b/);
  assert.match(args.join(' '), /ec_paramgen_curve:(P-256|prime256v1)\b/);
  const sans = new Set([...args.join(' ').matchAll(/DNS:([A-Za-z0-9.-]+)/g)].map((m) => m[1]));
  assert.deepStrictEqual([...sans].sort(), ['null-target', 'null-target.loadtest.svc', 'null-target.loadtest.svc.cluster.local']);
  // 셸 없이 부르므로 묻는 창이 뜨면 멈춘다: 키 암호와 이름을 묻지 않게 한다
  assert.ok(args.includes('-nodes') || args.includes('-noenc'), '키를 암호화하지 않는다(-nodes/-noenc)');
  assert.ok(args.includes('-subj') || args.includes('-batch'), '이름을 묻지 않는다(-subj/-batch)');
});

test('[ASVS v5.0.0-1.2.5] nullTargetCertArgs 파일 경로는 공백·셸 글자가 있어도 인자 하나로 그대로 들어간다', () => {
  const key = 'C:\\Users\\me\\My Temp\\$(id);k.pem';
  const cert = "/tmp/a b/`c`'.pem";
  const args = nullTargetCertArgs(key, cert);
  assert.equal(args[args.indexOf('-keyout') + 1], key);
  assert.equal(args[args.indexOf('-out') + 1], cert);
  assert.equal(args.filter((a) => a.includes('$(id)')).length, 1);
});

const SIM_KEY = 'sim_sk_test_0000000000000000';

test('[ASVS v5.0.0-13.3.1] simKeySecret loadtest 네임스페이스의 loadgen-sim Secret에 PG_SIMULATOR_SECRET_KEY로 담는다', () => {
  const s = simKeySecret(SIM_KEY);
  assert.equal(s.apiVersion, 'v1');
  assert.equal(s.kind, 'Secret');
  assert.equal(s.metadata.name, SIM_KEY_SECRET);
  assert.equal(s.metadata.namespace, LOADGEN_NAMESPACE);
  assert.ok(s.type === undefined || s.type === 'Opaque', String(s.type));
  assert.deepStrictEqual(s.stringData, { [SIM_KEY_NAME]: SIM_KEY });
  const min = `sim_sk_${'A1b-_'.repeat(3)}x`; // 뒤 16자
  assert.equal(simKeySecret(min).stringData[SIM_KEY_NAME], min);
  const long = `sim_sk_${'Z9'.repeat(100)}`;
  assert.equal(simKeySecret(long).stringData[SIM_KEY_NAME], long);
});

test('[ASVS v5.0.0-13.3.1] simKeySecret 키가 sim_sk_ + [A-Za-z0-9_-] 16자 이상이 아니면 Error', () => {
  const k16 = `sim_sk_${'a'.repeat(16)}`;
  assert.equal(simKeySecret(k16).stringData[SIM_KEY_NAME], k16); // 기준: 정확히 16자는 받는다
  for (const key of [`sim_sk_${'a'.repeat(15)}`, 'sk_live_0000000000000000', 'sk_test_0000000000000000', `SIM_SK_${'a'.repeat(16)}`,
    ` ${SIM_KEY}`, `${SIM_KEY} `, `${SIM_KEY}\n`, `${SIM_KEY}$`, `${SIM_KEY};id`, `${SIM_KEY}=`, `${SIM_KEY}.x`, 'sim_sk_', '',
    undefined, null, 1234]) {
    assert.throws(() => simKeySecret(key), Error, JSON.stringify(key));
  }
});

test('[ASVS v5.0.0-16.2.5] simKeySecret 오류 메시지에 키(일부도)를 싣지 않는다', () => {
  assert.equal(simKeySecret(SIM_KEY).kind, 'Secret');
  for (const key of ['sim_sk_TOPSECRETvalue12345!', 'sim_sk_short9Q', 'sk_live_REALSECRET0123456789']) {
    assert.throws(
      () => simKeySecret(key),
      (e) => {
        assert.ok(e instanceof Error);
        for (const part of [key, key.slice(7), 'TOPSECRET', 'REALSECRET', 'short9Q']) {
          assert.ok(!e.message.includes(part), `메시지에 키가 있다: ${part}`);
        }
        return true;
      },
    );
  }
});

// ---------------------------------------------------------------------------------------------
// manifests.mjs: runEnvFile
// ---------------------------------------------------------------------------------------------

const SAFE_LINE = /^[A-Z][A-Z0-9_]{0,63}=[A-Za-z0-9_.:/,-]{0,512}$/;

test('[ASVS v5.0.0-1.2.5] runEnvFile 한 줄에 KEY=VALUE, 끝에 줄바꿈, 정수는 10진 글로 쓴다', () => {
  const text = runEnvFile({
    ADMIT_PER_SECOND: 28,
    BASE_URL: 'https://v0-gateway.v0.svc.cluster.local:8443',
    EMPTY: '',
    ENTRY_RATE: 0,
    RATES: '1000,2000',
    SCENARIO: 'v0-queue.js',
    TOKENS: '/work/tokens.ndjson',
  });
  assert.equal(
    text,
    'ADMIT_PER_SECOND=28\nBASE_URL=https://v0-gateway.v0.svc.cluster.local:8443\nEMPTY=\nENTRY_RATE=0\nRATES=1000,2000\n' +
      'SCENARIO=v0-queue.js\nTOKENS=/work/tokens.ndjson\n',
  );
});

test('[ASVS v5.0.0-1.2.5] runEnvFile 줄은 넣은 차례대로(이름순이 아니다)이고 SCENARIO 하나만 있어도 된다', () => {
  assert.equal(runEnvFile({ SCENARIO: 'calibrate.js' }), 'SCENARIO=calibrate.js\n');
  assert.equal(
    runEnvFile({ USERS: 131072, SCENARIO: 'v0-seat-hold.js', MODE: 'crossed', RUN: '2026-11-03-k2', NEG: -5 }),
    'USERS=131072\nSCENARIO=v0-seat-hold.js\nMODE=crossed\nRUN=2026-11-03-k2\nNEG=-5\n',
  );
  assert.equal(runEnvFile({ Z: 1, A: 2, SCENARIO: 'v0-queue.js', M: '' }), 'Z=1\nA=2\nSCENARIO=v0-queue.js\nM=\n');
});

/** 시나리오가 읽는 환경 이름(docs/verification.md §3.9, loadtest/README.md). 실행 도구가 run.env로 넘길 수 있어야 한다 */
const SCENARIO_ENV = {
  BASE: 'https://v0-gateway.v0.svc.cluster.local:8443',
  ORIGIN: 'https://127.0.0.1:8443',
  RUN_TAG: 'r1',
  OUT_DIR: '/work/out',
  USERS_FILE: '/work/users.json',
  EVENT_ID: '0b5a3f9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
  USERS: 1000,
  RATE: 200,
  ENTRY_RATE: 500,
  ADMIT_PER_SECOND: 28,
  WARM_S: 30,
  MAIN_S: 60,
  PRE_VUS: 50,
  MAX_VUS: 1200,
  MODE: 'spread',
  HOLD_SIZE: 2,
  HOT_COUNT: 1,
  PAIRS: 1,
  RELEASE_MS: 0,
  SECTIONS: 'A,B,C',
  ROWS: 20,
  PER_ROW: 25,
  SEATS_PER_ORDER: 2,
  SIM_URL: 'http://pg-simulator.v0.svc.cluster.local:8790',
  PREP_RATE: 200,
};

test('[ASVS v5.0.0-1.2.5] runEnvFile 시나리오가 읽는 환경 이름과 값은 모두 쓸 수 있다', () => {
  const text = runEnvFile({ SCENARIO: 'v0-payment.js', ...SCENARIO_ENV });
  const lines = text.slice(0, -1).split('\n');
  assert.deepStrictEqual(lines, ['SCENARIO=v0-payment.js', ...Object.entries(SCENARIO_ENV).map(([k, v]) => `${k}=${v}`)]);
  for (const l of lines) assert.match(l, SAFE_LINE);
});

test('[ASVS v5.0.0-13.3.1] [ASVS v5.0.0-1.2.5] runEnvFile 파드가 정한 환경을 덮는 키(PATH·HOME·SHELL·IFS·ENV·발생기 파드 env·LD_*)는 거부한다', () => {
  assert.equal(runEnvFile({ SCENARIO: 'v0-queue.js', LDX: 1, PATHS: 'x' }), 'SCENARIO=v0-queue.js\nLDX=1\nPATHS=x\n'); // 기준: 이름이 같지 않으면 받는다
  // 발생기 파드가 env로 정하는 이름 전부(시험 키 포함)
  const podEnv = generatorPod({ name: 'g', cpus: 4, memoryMi: 4096, hostDir: `${NODE_ROOT}/r1`, simKey: true }).spec.containers[0].env.map((e) => e.name);
  assert.deepStrictEqual([...podEnv].sort(), ['GOMAXPROCS', 'K6_NO_USAGE_REPORT', 'PG_SIMULATOR_SECRET_KEY', 'SSL_CERT_FILE']);
  const keys = ['PATH', 'HOME', 'SHELL', 'IFS', 'ENV', ...podEnv, 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LD_', 'LD_X1'];
  for (const k of keys) {
    // 앞이든 뒤든, 값이 무엇이든 거부한다
    assert.throws(() => runEnvFile({ SCENARIO: 'v0-queue.js', [k]: '/tmp/x' }), Error, k);
    assert.throws(() => runEnvFile({ [k]: 1, SCENARIO: 'v0-queue.js' }), Error, k);
  }
  // 시험 키는 값이 바른 꼴이어도 run.env로 넘기지 않는다(파드가 Secret에서 읽는다)
  assert.throws(() => runEnvFile({ SCENARIO: 'v0-payment.js', PG_SIMULATOR_SECRET_KEY: 'sim_sk_test_0000000000000000' }), Error);
});

test('[ASVS v5.0.0-1.2.5] runEnvFile 셸이 해석할 글자가 든 값은 거부한다', () => {
  const bad = ['$HOME', '${X}', '`id`', '$(id)', 'a;b', 'a b', "a'b", 'a"b', 'a\nb', 'a\rb', 'a\tb', '*', 'a?', '[a]', 'a|b', 'a&b',
    'a<b', 'a>b', 'a\\b', '~', '#x', 'a=b', '!x', '%x', '{a,b}', '(a)', 'a+b', 'ä', '가', 'a\u0000b', 'x'.repeat(513)];
  for (const v of bad) assert.throws(() => runEnvFile({ SCENARIO: 'v0-queue.js', X: v }), Error, JSON.stringify(v));
  assert.equal(runEnvFile({ SCENARIO: 'v0-queue.js', X: 'x'.repeat(512) }), `SCENARIO=v0-queue.js\nX=${'x'.repeat(512)}\n`);
});

test('[ASVS v5.0.0-1.2.5] runEnvFile 키는 대문자로 시작하는 A-Z0-9_ 64자까지', () => {
  const k64 = `A${'B'.repeat(63)}`;
  assert.equal(runEnvFile({ SCENARIO: 'v0-queue.js', [k64]: 1 }), `SCENARIO=v0-queue.js\n${k64}=1\n`);
  for (const k of [`A${'B'.repeat(64)}`, 'a', 'Abc', '1A', '_A', 'A-B', 'A B', 'A.B', 'A$', 'A=B', 'A\nB', '']) {
    assert.throws(() => runEnvFile({ SCENARIO: 'v0-queue.js', [k]: 1 }), Error, JSON.stringify(k));
  }
});

test('[ASVS v5.0.0-1.2.5] runEnvFile 값은 문자열·정수만(소수·NaN·Infinity·불·null·객체 거부)', () => {
  assert.equal(runEnvFile({ SCENARIO: 'v0-queue.js', X: 7 }), 'SCENARIO=v0-queue.js\nX=7\n');
  assert.equal(runEnvFile({ SCENARIO: 'v0-queue.js', X: '7.5' }), 'SCENARIO=v0-queue.js\nX=7.5\n'); // 소수는 문자열로 넘긴다
  for (const v of [1.5, NaN, Infinity, -Infinity, true, false, null, undefined, {}, [], ['a']]) {
    assert.throws(() => runEnvFile({ SCENARIO: 'v0-queue.js', X: v }), Error, String(v));
  }
});

test('[ASVS v5.0.0-1.2.5] runEnvFile SCENARIO는 꼭 있고 소문자·숫자·- 이름의 .js 파일이어야 한다', () => {
  for (const vars of [{}, { USERS: 5 }]) assert.throws(() => runEnvFile(vars), Error);
  for (const s of ['v0-queue', 'V0-queue.js', 'v0_queue.js', '../v0-queue.js', 'a/b.js', '.js', 'v0-queue.js.bak', 'v0-queue.mjs',
    'v0-queue.JS', 5]) {
    assert.throws(() => runEnvFile({ SCENARIO: s }), Error, String(s));
  }
  for (const s of ['v0-queue.js', 'calibrate.js', 'v0-seat-hold.js', '1.js']) assert.equal(runEnvFile({ SCENARIO: s }), `SCENARIO=${s}\n`);
});

test('[ASVS v5.0.0-1.2.5] runEnvFile 결과를 POSIX 셸이 읽어도 실행할 것이 없다(모든 줄이 허용 글자뿐인 KEY=VALUE)', () => {
  const text = runEnvFile({
    SCENARIO: 'v0-payment.js',
    BASE_URL: 'https://v0-gateway.v0.svc.cluster.local:8443',
    SIM_URL: 'http://pg-simulator.v0.svc.cluster.local:8080',
    USERS: 9000,
    RATE: 100,
    WARM_S: 30,
    MAIN_S: 60,
    ORIGIN: 'https://peaket.local',
    IP_BASE: '198.18.0.0/15',
  });
  assert.ok(text.endsWith('\n'));
  assert.ok(!text.includes('\r'));
  const lines = text.slice(0, -1).split('\n');
  assert.equal(lines.length, 9);
  for (const l of lines) assert.match(l, SAFE_LINE);
});

// ---------------------------------------------------------------------------------------------
// results.mjs: cgroup 표본과 발생기 지표
// ---------------------------------------------------------------------------------------------

const cg = (wallS, upS, usageUsec, memBytes) => `${wallS} ${upS} ${usageUsec} ${memBytes}`;
const goodLines = (n) => Array.from({ length: n }, (_, i) => cg(1793649470 + i, `${1000 + i}.00`, i * 1000000, 1048576));

test('NFR-013 ADR-0057 parseCgroupLog 네 칸 줄을 { wallS, upS, usageUsec, memBytes }로 읽는다', () => {
  const text = `${cg(1793649471, '1234.56', 1000, 2048)}\n${cg(1793649472, '1235.56', 2000, 4096)}\n`;
  assert.deepStrictEqual(parseCgroupLog(text), [
    { wallS: 1793649471, upS: 1234.56, usageUsec: 1000, memBytes: 2048 },
    { wallS: 1793649472, upS: 1235.56, usageUsec: 2000, memBytes: 4096 },
  ]);
  assert.deepStrictEqual(parseCgroupLog(''), []);
});

test('NFR-013 ADR-0057 parseCgroupLog 빈 줄은 건너뛰고 줄바꿈으로 끝나지 않은 마지막 줄(쓰는 중)은 버린다', () => {
  const [a, b] = goodLines(2);
  assert.equal(parseCgroupLog(`\n${a}\n\n${b}\n1793649473 1002.0 20`).length, 2);
  assert.equal(parseCgroupLog(`${a}\n${b}`).length, 1);
  assert.deepStrictEqual(parseCgroupLog(a), []);
  // 쓰는 중인 줄은 꼴이 틀려도 오류가 아니다
  assert.equal(parseCgroupLog(`${a}\n${b}\nxx yy`).length, 2);
});

test('NFR-013 ADR-0057 parseCgroupLog 가동 초·사용 시간이 같으면 받고 메모리는 줄어도 된다', () => {
  const text = `${cg(10, '5.00', 100, 900)}\n${cg(11, '5.00', 100, 500)}\n${cg(12, '6.00', 100, 100)}\n`;
  assert.deepStrictEqual(parseCgroupLog(text).map((s) => s.memBytes), [900, 500, 100]);
});

test('[ASVS v5.0.0-2.2.1] parseCgroupLog 꼴이 틀린 줄(칸 수·숫자 아님·가동 초나 사용 시간 감소)은 줄 번호와 함께 Error', () => {
  const six = goodLines(6).join('\n');
  const bad = [
    '1793649476 1006.00 6000000', // 세 칸
    '1793649476 1006.00 6000000 1048576 9', // 다섯 칸
    '1793649476 abc 6000000 1048576',
    '1793649476 1006.00 NaN 1048576',
    '1793649476 1006.00 6000000 lots',
    '1793649476 1004.00 6000000 1048576', // 가동 초 감소(앞 줄 1005)
    '1793649476 1006.00 4000000 1048576', // 사용 시간 감소(앞 줄 5,000,000)
  ];
  for (const line of bad) {
    assert.throws(
      () => parseCgroupLog(`${six}\n${line}\n${goodLines(8)[7]}\n`),
      (e) => {
        assert.ok(e instanceof Error);
        assert.ok(mentionsNumber(e.message, 7), `줄 번호 7이 없다: ${e.message}`);
        return true;
      },
      line,
    );
  }
});

// fromMs 1,000,000 · toMs 1,010,000 → 쓰는 표본은 wallS 1001~1009(양 끝 1초씩 뺌, 경계 포함)
const WIN_SAMPLES = Object.freeze([
  { wallS: 1000, upS: 50, usageUsec: 0, memBytes: 3 * GiB }, // 뺌
  { wallS: 1001, upS: 51, usageUsec: 1_000_000, memBytes: 1 * GiB },
  { wallS: 1002, upS: 52, usageUsec: 3_000_000, memBytes: 2 * GiB }, // 쌍 2,000,000 / (1 s × 4) = 50%
  { wallS: 1003, upS: 53, usageUsec: 5_400_000, memBytes: 1.5 * GiB }, // 60%
  { wallS: 1004, upS: 54, usageUsec: 6_400_000, memBytes: 1 * GiB }, // 25%
  { wallS: 1009, upS: 59, usageUsec: 11_400_000, memBytes: 1 * GiB }, // 5,000,000 / (5 s × 4) = 25%
  { wallS: 1010, upS: 60, usageUsec: 30_000_000, memBytes: 4 * GiB }, // 뺌(넣으면 465%)
]);

test('NFR-013 ADR-0057 generatorStats 손 계산: 4 CPU, 평균 32.5%·최대 60%·메모리 50%, 양 끝 1초를 빼고 경계 표본은 넣는다', () => {
  const r = generatorStats(WIN_SAMPLES, { fromMs: 1_000_000, toMs: 1_010_000, cpus: 4, memLimitBytes: 4 * GiB });
  // 평균 = (11,400,000 − 1,000,000) ÷ ((59 − 51) × 1e6 × 4) × 100 = 32.5
  assert.deepStrictEqual(r, { cpuMeanPct: 32.5, cpuMaxPct: 60, memMaxPct: 50, memMaxBytes: 2 * GiB, samples: 5 });
});

test('NFR-013 ADR-0057 generatorStats 창 경계가 1ms만 안쪽이어도 그 경계 표본은 뺀다', () => {
  const r = generatorStats(WIN_SAMPLES, { fromMs: 1_000_001, toMs: 1_009_999, cpus: 4, memLimitBytes: 4 * GiB });
  // 1002~1004만: 평균 (6,400,000 − 3,000,000) ÷ (2 × 4e6) × 100 = 42.5, 쌍 60·25
  assert.deepStrictEqual(r, { cpuMeanPct: 42.5, cpuMaxPct: 60, memMaxPct: 50, memMaxBytes: 2 * GiB, samples: 3 });
});

test('NFR-013 ADR-0057 generatorStats 2 CPU, 사용 +2,000,000µs·가동 +1.0초 → 100%, 4 CPU면 50%', () => {
  const s = [{ wallS: 2, upS: 10, usageUsec: 0, memBytes: 0 }, { wallS: 3, upS: 11, usageUsec: 2_000_000, memBytes: 0 }];
  const o = { fromMs: 1000, toMs: 4000, memLimitBytes: GiB };
  assert.deepStrictEqual(generatorStats(s, { ...o, cpus: 4 }), { cpuMeanPct: 50, cpuMaxPct: 50, memMaxPct: 0, memMaxBytes: 0, samples: 2 });
  assert.deepStrictEqual(generatorStats(s, { ...o, cpus: 2 }), { cpuMeanPct: 100, cpuMaxPct: 100, memMaxPct: 0, memMaxBytes: 0, samples: 2 });
});

test('NFR-013 ADR-0057 generatorStats 백분율은 소수 첫째 자리로 반올림한다', () => {
  const o = { fromMs: 1000, toMs: 4000, cpus: 3, memLimitBytes: 3_000_000 };
  const s = [{ wallS: 2, upS: 10, usageUsec: 0, memBytes: 1_000_000 }, { wallS: 3, upS: 11, usageUsec: 1_000_000, memBytes: 2_000_000 }];
  // 33.333… → 33.3, 66.666… → 66.7
  assert.deepStrictEqual(generatorStats(s, o), { cpuMeanPct: 33.3, cpuMaxPct: 33.3, memMaxPct: 66.7, memMaxBytes: 2_000_000, samples: 2 });
  // 가동 초 차가 1.0100000000000051처럼 떠도 99.99999…가 100으로
  const f = [{ wallS: 2, upS: 100.25, usageUsec: 0, memBytes: 1 }, { wallS: 3, upS: 101.26, usageUsec: 2_020_000, memBytes: 1 }];
  const r = generatorStats(f, { fromMs: 1000, toMs: 4000, cpus: 2, memLimitBytes: 3 });
  assert.equal(r.cpuMeanPct, 100);
  assert.equal(r.cpuMaxPct, 100);
  assert.equal(r.memMaxPct, 33.3);
});

test('NFR-013 ADR-0057 generatorStats 가동 초가 같은 쌍은 최댓값 계산에서 건너뛴다', () => {
  const s = [
    { wallS: 2, upS: 10, usageUsec: 0, memBytes: 1 },
    { wallS: 3, upS: 10, usageUsec: 100_000, memBytes: 1 }, // 앞 쌍은 0초라 건너뜀(넣으면 무한대)
    { wallS: 4, upS: 11, usageUsec: 600_000, memBytes: 1 }, // 500,000 / 1e6 = 50%
  ];
  const r = generatorStats(s, { fromMs: 1000, toMs: 5000, cpus: 1, memLimitBytes: 10 });
  assert.deepStrictEqual(r, { cpuMeanPct: 60, cpuMaxPct: 50, memMaxPct: 10, memMaxBytes: 1, samples: 3 });
  assert.ok(Number.isFinite(r.cpuMaxPct));
});

test('NFR-013 ADR-0057 generatorStats 창 안 표본이 둘보다 적으면 Error', () => {
  const o = { cpus: 4, memLimitBytes: 4 * GiB };
  // 기준: 창 [1003 s, 1004 s]의 표본 둘이면 계산한다((6,400,000 − 5,400,000) ÷ (1 × 1e6 × 4) × 100 = 25%)
  assert.deepStrictEqual(generatorStats(WIN_SAMPLES, { ...o, fromMs: 1_002_000, toMs: 1_005_000 }),
    { cpuMeanPct: 25, cpuMaxPct: 25, memMaxPct: 37.5, memMaxBytes: 1.5 * GiB, samples: 2 });
  assert.throws(() => generatorStats([], { ...o, fromMs: 0, toMs: 1e12 }), Error);
  assert.throws(() => generatorStats(WIN_SAMPLES, { ...o, fromMs: 1_003_000, toMs: 1_006_000 }), Error); // 1004 하나
  assert.throws(() => generatorStats(WIN_SAMPLES, { ...o, fromMs: 2_000_000, toMs: 3_000_000 }), Error); // 없음
  assert.throws(() => generatorStats(WIN_SAMPLES, { ...o, fromMs: 1_010_000, toMs: 1_000_000 }), Error); // 거꾸로 된 창
  assert.throws(() => generatorStats(WIN_SAMPLES.slice(0, 2), { ...o, fromMs: 1_000_000, toMs: 1_010_000 }), Error); // 1001 하나
});

test('NFR-013 ADR-0057 generatorStats 창 안 처음과 마지막 표본의 가동 초가 같으면(평균을 낼 시간이 0) Error', () => {
  const o = { fromMs: 1000, toMs: 6000, cpus: 1, memLimitBytes: 10 };
  // 기준: 가운데 쌍만 가동 초가 같으면 건너뛰고 계산한다
  assert.equal(generatorStats([
    { wallS: 2, upS: 10, usageUsec: 0, memBytes: 1 },
    { wallS: 3, upS: 11, usageUsec: 100_000, memBytes: 1 },
    { wallS: 4, upS: 11, usageUsec: 100_000, memBytes: 1 },
  ], o).cpuMeanPct, 10);
  assert.throws(() => generatorStats([
    { wallS: 2, upS: 10, usageUsec: 0, memBytes: 1 },
    { wallS: 3, upS: 10, usageUsec: 0, memBytes: 1 },
  ], o), Error);
  assert.throws(() => generatorStats([
    { wallS: 2, upS: 10, usageUsec: 0, memBytes: 1 },
    { wallS: 3, upS: 10, usageUsec: 5, memBytes: 1 },
    { wallS: 4, upS: 10, usageUsec: 9, memBytes: 1 },
  ], o), Error);
  // 창 밖 표본의 가동 초가 달라도 창 안 처음·마지막이 같으면 Error
  assert.throws(() => generatorStats([
    { wallS: 0, upS: 5, usageUsec: 0, memBytes: 1 },
    { wallS: 2, upS: 10, usageUsec: 0, memBytes: 1 },
    { wallS: 3, upS: 10, usageUsec: 0, memBytes: 1 },
    { wallS: 9, upS: 20, usageUsec: 0, memBytes: 1 },
  ], { ...o, toMs: 5000 }), Error);
});

test('NFR-013 ADR-0057 parseCgroupLog → generatorStats 이어서 쓰면 손 계산과 같다', () => {
  const text = `${WIN_SAMPLES.map((s) => cg(s.wallS, s.upS.toFixed(2), s.usageUsec, s.memBytes)).join('\n')}\n`;
  const r = generatorStats(parseCgroupLog(text), { fromMs: 1_000_000, toMs: 1_010_000, cpus: 4, memLimitBytes: 4 * GiB });
  assert.deepStrictEqual(r, { cpuMeanPct: 32.5, cpuMaxPct: 60, memMaxPct: 50, memMaxBytes: 2 * GiB, samples: 5 });
});

// ---------------------------------------------------------------------------------------------
// results.mjs: 무효 판정과 보정
// ---------------------------------------------------------------------------------------------

test('NFR-013 ADR-0057 판정 상한은 CPU 평균 80%·메모리 최대 90%·보정 p99 5ms다', () => {
  assert.equal(GENERATOR_CPU_MAX_PCT, 80);
  assert.equal(GENERATOR_MEM_MAX_PCT, 90);
  assert.equal(CALIBRATION_P99_MAX_MS, 5);
  assert.deepStrictEqual([...RECORD_KINDS], ['queue_entry', 'queue_admit']);
});

test('NFR-013 ADR-0057 judgeGenerator CPU 80.0·메모리 90.0과 같으면 통과다', () => {
  assert.deepStrictEqual(judgeGenerator({ dropped: 0, cpuMeanPct: 80, memMaxPct: 90 }), { valid: true, reasons: [] });
  assert.deepStrictEqual(judgeGenerator({ dropped: 0, cpuMeanPct: 0, memMaxPct: 0 }), { valid: true, reasons: [] });
});

test('NFR-013 ADR-0057 judgeGenerator CPU 80.1%·메모리 90.1%는 넘은 것으로 사유를 남긴다', () => {
  assert.deepStrictEqual(judgeGenerator({ dropped: 0, cpuMeanPct: 80.1, memMaxPct: 10 }), {
    valid: false,
    reasons: ['발생기 CPU 평균 80.1%(80% 초과)'],
  });
  assert.deepStrictEqual(judgeGenerator({ dropped: 0, cpuMeanPct: 10, memMaxPct: 90.1 }), {
    valid: false,
    reasons: ['발생기 메모리 최대 90.1%(90% 초과)'],
  });
});

test('V-T3 judgeGenerator 발생기가 반복을 시작하지 못하면(dropped 1) 무효이고 사유를 남긴다, 0이면 유효', () => {
  assert.deepStrictEqual(judgeGenerator({ dropped: 1, cpuMeanPct: 0, memMaxPct: 0 }), {
    valid: false,
    reasons: ['발생기가 반복을 시작하지 못함(dropped_iterations 1)'],
  });
  assert.deepStrictEqual(judgeGenerator({ dropped: 3, cpuMeanPct: 32.5, memMaxPct: 50 }), {
    valid: false,
    reasons: ['발생기가 반복을 시작하지 못함(dropped_iterations 3)'],
  });
  assert.equal(judgeGenerator({ dropped: 0, cpuMeanPct: 32.5, memMaxPct: 50 }).valid, true);
});

test('V-T3 judgeGenerator 사유 순서는 dropped → CPU → 메모리다', () => {
  assert.deepStrictEqual(judgeGenerator({ dropped: 12, cpuMeanPct: 95.5, memMaxPct: 97.2 }), {
    valid: false,
    reasons: ['발생기가 반복을 시작하지 못함(dropped_iterations 12)', '발생기 CPU 평균 95.5%(80% 초과)', '발생기 메모리 최대 97.2%(90% 초과)'],
  });
});

test('V-T3 judgeGenerator 사유의 수는 String()으로 쓴다(자리 구분·고정 소수 자리 없음)', () => {
  assert.deepStrictEqual(judgeGenerator({ dropped: 1234567, cpuMeanPct: 95, memMaxPct: 100 }).reasons, [
    '발생기가 반복을 시작하지 못함(dropped_iterations 1234567)',
    '발생기 CPU 평균 95%(80% 초과)',
    '발생기 메모리 최대 100%(90% 초과)',
  ]);
  assert.deepStrictEqual(judgeGenerator({ dropped: 0, cpuMeanPct: 80.25, memMaxPct: 90.05 }).reasons, [
    '발생기 CPU 평균 80.25%(80% 초과)',
    '발생기 메모리 최대 90.05%(90% 초과)',
  ]);
  assert.deepStrictEqual(judgeGenerator({ dropped: 0, cpuMeanPct: 80.00001, memMaxPct: 0 }).reasons, ['발생기 CPU 평균 80.00001%(80% 초과)']);
});

test('V-T3 judgeGenerator 지표가 없거나 틀리면 사유 `발생기 지표 없음` 하나만 내고 무효다', () => {
  const none = { valid: false, reasons: ['발생기 지표 없음'] };
  const ok = { dropped: 0, cpuMeanPct: 50, memMaxPct: 50 };
  assert.deepStrictEqual(judgeGenerator(ok), { valid: true, reasons: [] }); // 기준
  for (const dropped of [undefined, null, -1, 1.5, NaN, Infinity, '3', '0']) {
    assert.deepStrictEqual(judgeGenerator({ ...ok, dropped }), none, `dropped=${String(dropped)}`);
  }
  for (const v of [undefined, null, NaN, Infinity, -Infinity, '50']) {
    assert.deepStrictEqual(judgeGenerator({ ...ok, cpuMeanPct: v }), none, `cpuMeanPct=${String(v)}`);
    assert.deepStrictEqual(judgeGenerator({ ...ok, memMaxPct: v }), none, `memMaxPct=${String(v)}`);
  }
  // 다른 칸이 상한을 넘어도 사유는 하나뿐이다
  assert.deepStrictEqual(judgeGenerator({ dropped: 5, cpuMeanPct: 99, memMaxPct: NaN }), none);
  assert.deepStrictEqual(judgeGenerator({ dropped: undefined, cpuMeanPct: 99, memMaxPct: 99 }), none);
  const { dropped: _d, ...noDropped } = ok;
  assert.deepStrictEqual(judgeGenerator(noDropped), none);
});

const STEP_OK = { rate: 1000, dropped: 0, cpuMeanPct: 50, memMaxPct: 20, failedRate: 0, p99Ms: 5 };

test('NFR-013 ADR-0057 judgeCalibrationStep p99 5ms와 같으면 통과, 5.01ms는 넘음', () => {
  assert.deepStrictEqual(judgeCalibrationStep(STEP_OK), { rate: 1000, passed: true, reasons: [] });
  assert.deepStrictEqual(judgeCalibrationStep({ ...STEP_OK, p99Ms: 0.4 }), { rate: 1000, passed: true, reasons: [] });
  assert.deepStrictEqual(judgeCalibrationStep({ ...STEP_OK, p99Ms: 5.01 }), { rate: 1000, passed: false, reasons: ['k6 p99 5.01ms(5ms 초과)'] });
  assert.deepStrictEqual(judgeCalibrationStep({ ...STEP_OK, p99Ms: 12 }).reasons, ['k6 p99 12ms(5ms 초과)']);
  assert.deepStrictEqual(judgeCalibrationStep({ ...STEP_OK, rate: 4000, p99Ms: 7.5 }), {
    rate: 4000,
    passed: false,
    reasons: ['k6 p99 7.5ms(5ms 초과)'],
  });
});

test('NFR-013 ADR-0057 judgeCalibrationStep p99가 수가 아니면 k6 p99 없음', () => {
  for (const p99Ms of [NaN, undefined, null, '3']) {
    assert.deepStrictEqual(judgeCalibrationStep({ ...STEP_OK, p99Ms }), { rate: 1000, passed: false, reasons: ['k6 p99 없음'] }, String(p99Ms));
  }
  const { p99Ms: _omit, ...noP99 } = STEP_OK;
  assert.deepStrictEqual(judgeCalibrationStep(noP99), { rate: 1000, passed: false, reasons: ['k6 p99 없음'] });
});

test('NFR-013 ADR-0057 judgeCalibrationStep 실패한 요청이 하나라도 있으면(failedRate > 0) 사유를 남긴다', () => {
  // <비율>은 0~1 값을 String()으로 쓴다(백분율로 바꾸지 않는다)
  assert.deepStrictEqual(judgeCalibrationStep({ ...STEP_OK, failedRate: 0.25 }), { rate: 1000, passed: false, reasons: ['실패한 요청 0.25'] });
  assert.deepStrictEqual(judgeCalibrationStep({ ...STEP_OK, failedRate: 1 }).reasons, ['실패한 요청 1']);
  assert.deepStrictEqual(judgeCalibrationStep({ ...STEP_OK, failedRate: 1e-9 }), { rate: 1000, passed: false, reasons: ['실패한 요청 1e-9'] });
  assert.deepStrictEqual(judgeCalibrationStep({ ...STEP_OK, failedRate: 0.000123 }).reasons, ['실패한 요청 0.000123']);
});

test('NFR-013 ADR-0057 judgeCalibrationStep 발생기 지표가 없으면 그 사유(`발생기 지표 없음`) 뒤에 실패·p99 사유를 붙인다', () => {
  assert.deepStrictEqual(judgeCalibrationStep({ ...STEP_OK, dropped: undefined }), { rate: 1000, passed: false, reasons: ['발생기 지표 없음'] });
  assert.deepStrictEqual(judgeCalibrationStep({ ...STEP_OK, cpuMeanPct: NaN, failedRate: 0.5, p99Ms: 6 }), {
    rate: 1000,
    passed: false,
    reasons: ['발생기 지표 없음', '실패한 요청 0.5', 'k6 p99 6ms(5ms 초과)'],
  });
});

test('V-T3 judgeCalibrationStep 발생기 사유 뒤에 실패·p99 사유가 이 순서로 붙는다', () => {
  const r = judgeCalibrationStep({ rate: 8000, dropped: 2, cpuMeanPct: 88.8, memMaxPct: 91.5, failedRate: 0.25, p99Ms: 12.5 });
  assert.equal(r.rate, 8000);
  assert.equal(r.passed, false);
  assert.equal(r.reasons.length, 5);
  assert.deepStrictEqual(r.reasons.slice(0, 3), [
    '발생기가 반복을 시작하지 못함(dropped_iterations 2)',
    '발생기 CPU 평균 88.8%(80% 초과)',
    '발생기 메모리 최대 91.5%(90% 초과)',
  ]);
  assert.equal(r.reasons[3], '실패한 요청 0.25');
  assert.equal(r.reasons[4], 'k6 p99 12.5ms(5ms 초과)');
  const d = judgeCalibrationStep({ ...STEP_OK, dropped: 1 });
  assert.deepStrictEqual(d, { rate: 1000, passed: false, reasons: ['발생기가 반복을 시작하지 못함(dropped_iterations 1)'] });
});

const pass = (rate) => ({ rate, passed: true, reasons: [] });
const fail = (rate, reasons = [`k6 p99 ${rate / 1000}ms(5ms 초과)`]) => ({ rate, passed: false, reasons });

test('NFR-013 ADR-0057 calibrationCapacity 모두 통과하면 마지막 단계 rate이고 topReached', () => {
  assert.deepStrictEqual(calibrationCapacity([pass(1000), pass(2000), pass(4000)]), { capacityRps: 4000, topReached: true, limitedBy: null });
  assert.deepStrictEqual(calibrationCapacity([pass(500)]), { capacityRps: 500, topReached: true, limitedBy: null });
});

test('NFR-013 ADR-0057 calibrationCapacity 첫 단계부터 통과하지 못하면 용량 null', () => {
  const reasons = ['발생기 CPU 평균 91.2%(80% 초과)', 'k6 p99 9.5ms(5ms 초과)'];
  assert.deepStrictEqual(calibrationCapacity([fail(1000, reasons), pass(2000)]), {
    capacityRps: null,
    topReached: false,
    limitedBy: { rate: 1000, reasons },
  });
});

test('NFR-013 ADR-0057 calibrationCapacity 처음 통과하지 못한 단계 바로 아래가 용량이고 뒤에 통과한 단계는 올리지 않는다', () => {
  const reasons = ['발생기가 반복을 시작하지 못함(dropped_iterations 4)'];
  assert.deepStrictEqual(calibrationCapacity([pass(1000), pass(2000), fail(4000, reasons), pass(8000), fail(16000)]), {
    capacityRps: 2000,
    topReached: false,
    limitedBy: { rate: 4000, reasons },
  });
  assert.deepStrictEqual(calibrationCapacity([pass(1000), fail(2000, ['k6 p99 없음'])]), {
    capacityRps: 1000,
    topReached: false,
    limitedBy: { rate: 2000, reasons: ['k6 p99 없음'] },
  });
});

test('NFR-013 ADR-0057 calibrationCapacity 빈 목록은 용량 null·topReached false·limitedBy null', () => {
  assert.deepStrictEqual(calibrationCapacity([]), { capacityRps: null, topReached: false, limitedBy: null });
});

test('[ASVS v5.0.0-2.2.1] calibrationCapacity 단계가 오름차순이 아니거나 겹치면 Error', () => {
  assert.equal(calibrationCapacity([pass(1000), pass(1001)]).capacityRps, 1001); // 기준: 1 차이도 오름차순
  assert.throws(() => calibrationCapacity([pass(2000), pass(1000)]), Error);
  assert.throws(() => calibrationCapacity([pass(1000), pass(1000)]), Error);
  assert.throws(() => calibrationCapacity([pass(1000), pass(4000), pass(2000)]), Error);
  assert.throws(() => calibrationCapacity([pass(1000), fail(1000)]), Error);
});

test('NFR-013 ADR-0057 perVuBytes = memMaxBytes ÷ vusMax를 정수로 올림', () => {
  assert.equal(perVuBytes({ memMaxBytes: 1000, vusMax: 3 }), 334);
  assert.equal(perVuBytes({ memMaxBytes: 1000, vusMax: 4 }), 250);
  assert.equal(perVuBytes({ memMaxBytes: 2 * GiB, vusMax: 3000 }), 715828);
  assert.equal(perVuBytes({ memMaxBytes: 1001, vusMax: 1 }), 1001);
  assert.equal(perVuBytes({ memMaxBytes: 0, vusMax: 7 }), 0);
});

test('[ASVS v5.0.0-2.2.1] perVuBytes vusMax가 1 이상 정수가 아니면 RangeError', () => {
  for (const vusMax of [0, -1, 1.5, NaN, Infinity, '3', null, undefined]) {
    assert.throws(() => perVuBytes({ memMaxBytes: 1000, vusMax }), RangeError, String(vusMax));
  }
});

// ---------------------------------------------------------------------------------------------
// results.mjs: 콘솔 나누기·서버 기록·결제사 원장
// ---------------------------------------------------------------------------------------------

const ENTRY = JSON.stringify({ kind: 'queue_entry', event_id: UUID_A, account_ref: 'acc-lt-r1-1', request_id: 'req-1', result: 'ok', seq: 1,
  generation: 1, started_at: '2026-11-03T04:57:51.000+09:00', ended_at: '2026-11-03T04:57:51.005+09:00' });
// 띄어 쓴 줄: 다시 직렬화하지 않고 그대로 옮기는지 본다
const ADMIT_SPACED = `{ "kind": "queue_admit", "event_id": "${UUID_A}", "account_ref": "acc-lt-r1-1", "request_id": "req-2", "result": "unknown", ` +
  '"seq": null, "generation": null, "started_at": "2026-11-03T04:57:52.000+09:00", "ended_at": "2026-11-03T04:57:52.123+09:00" }';
const ENTRY2 = ENTRY.replace('"req-1"', '"req-3"').replace('acc-lt-r1-1', 'acc-lt-r1-2');
const mark = (name, atMs) => JSON.stringify({ kind: 'mark', name, at_ms: atMs });

test('K1 Q-T2 splitConsole 시험 기록 줄은 입력 순서 그대로 옮기고 구간 표시는 marks로 뽑는다', () => {
  const text = [ENTRY, mark('main_start', 1793649471000), '', ADMIT_SPACED, mark('main_end', 1793649531000), ENTRY2].join('\n') + '\n';
  const r = splitConsole(text);
  assert.deepStrictEqual(r.records, [ENTRY, ADMIT_SPACED, ENTRY2]);
  assert.deepStrictEqual(norm(r.marks), { main_start: 1793649471000, main_end: 1793649531000 });
});

test('K1 Q-T2 splitConsole 빈 글·표시 없음·한쪽 표시·줄바꿈 없는 마지막 줄', () => {
  assert.deepStrictEqual(norm(splitConsole('').marks), {});
  assert.deepStrictEqual(splitConsole('').records, []);
  assert.deepStrictEqual(splitConsole('\n\n').records, []);
  const r = splitConsole(`${ENTRY}\n${mark('main_start', 5)}\n${ENTRY2}`);
  assert.deepStrictEqual(r.records, [ENTRY, ENTRY2]);
  assert.deepStrictEqual(norm(r.marks), { main_start: 5 });
  // 끝과 시작이 같은 시각이면 앞이 아니다
  assert.deepStrictEqual(norm(splitConsole(`${mark('main_start', 7)}\n${mark('main_end', 7)}\n`).marks), { main_start: 7, main_end: 7 });
  // 끝 표시만 있어도 된다(줄바꿈 없는 마지막 줄)
  const endOnly = splitConsole(`${ENTRY}\n\n${mark('main_end', 9)}`);
  assert.deepStrictEqual(endOnly.records, [ENTRY]);
  assert.deepStrictEqual(norm(endOnly.marks), { main_end: 9 });
  // 줄바꿈 없는 마지막 줄이 기록이어도 옮긴다
  assert.deepStrictEqual(splitConsole(`${mark('main_start', 0)}\n${ENTRY2}`).records, [ENTRY2]);
  assert.deepStrictEqual(norm(splitConsole(`${mark('main_start', 0)}\n${ENTRY2}`).marks), { main_start: 0 });
  // at_ms 0과 가장 큰 안전한 정수도 받는다
  assert.deepStrictEqual(norm(splitConsole(mark('main_end', Number.MAX_SAFE_INTEGER)).marks), { main_end: Number.MAX_SAFE_INTEGER });
});

test('[ASVS v5.0.0-2.2.1] splitConsole 모르는 표시 이름·at_ms가 0 이상 안전한 정수가 아닌 표시는 줄 번호(빈 줄 포함 1부터)와 함께 Error', () => {
  assert.deepStrictEqual(norm(splitConsole(`${ENTRY}\n\n${mark('main_start', 1)}\n`).marks), { main_start: 1 }); // 기준
  const bad = [
    mark('warm_start', 1),
    mark('prep_start', 1),
    mark('MAIN_START', 1),
    mark('', 1),
    JSON.stringify({ kind: 'mark', at_ms: 1 }), // 이름 없음
    JSON.stringify({ kind: 'mark', name: 'toString', at_ms: 1 }),
    JSON.stringify({ kind: 'mark', name: '__proto__', at_ms: 1 }),
    mark('main_start', -1),
    mark('main_start', 1.5),
    mark('main_start', '1000'),
    mark('main_start', null),
    JSON.stringify({ kind: 'mark', name: 'main_start' }), // at_ms 없음
    `{"kind":"mark","name":"main_start","at_ms":${2 ** 53}}`,
    `{"kind":"mark","name":"main_start","at_ms":1e300}`,
  ];
  for (const line of bad) {
    // 줄 1 기록, 줄 2 빈 줄, 줄 3 기록, 줄 4 빈 줄, 줄 5 틀린 표시
    assert.throws(
      () => splitConsole(`${ENTRY}\n\n${ENTRY2}\n\n${line}\n${ENTRY}\n`),
      (e) => {
        assert.ok(e instanceof Error);
        assert.ok(mentionsNumber(e.message, 5), `줄 번호 5가 없다: ${e.message}`);
        return true;
      },
      line,
    );
  }
});

test('[ASVS v5.0.0-2.2.1] splitConsole main_end가 main_start보다 작으면 줄 차례와 상관없이 Error', () => {
  assert.throws(() => splitConsole(`${mark('main_start', 1000)}\n${mark('main_end', 999)}\n`), Error);
  // 끝 표시가 먼저 나와도 값으로 견준다
  assert.throws(() => splitConsole(`${mark('main_end', 999)}\n${mark('main_start', 1000)}\n`), Error);
  assert.deepStrictEqual(norm(splitConsole(`${mark('main_end', 1000)}\n${mark('main_start', 999)}\n`).marks), { main_start: 999, main_end: 1000 });
});

test('[ASVS v5.0.0-2.2.1] splitConsole JSON 객체가 아닌 줄·모르는 kind·같은 표시 두 번·끝이 시작보다 앞이면 줄 번호와 함께 Error', () => {
  const four = [ENTRY, mark('main_start', 1000), ADMIT_SPACED, ENTRY2];
  const bad = [
    'not json',
    '{"kind":"queue_entry"',
    '[1,2]',
    '[]',
    'null',
    '42',
    '"queue_entry"',
    'true',
    '{"kind":"queue_serving","event_id":"x"}', // 기록 종류지만 콘솔에서 옮기는 종류가 아님
    '{"kind":"pg_charge"}',
    '{"kind":"other"}',
    '{"event_id":"x"}', // kind 없음
    '{"kind":5}',
    '{"kind":"toString"}',
    '{"kind":"constructor"}',
    '{"kind":"__proto__"}',
    '{"kind":"QUEUE_ENTRY"}',
    mark('main_start', 2000), // 같은 표시 두 번
    mark('main_end', 999), // 시작(1000)보다 앞
  ];
  for (const line of bad) {
    assert.throws(
      () => splitConsole([...four, line, ENTRY].join('\n') + '\n'),
      (e) => {
        assert.ok(e instanceof Error);
        assert.ok(mentionsNumber(e.message, 5), `줄 번호 5가 없다: ${e.message}`);
        return true;
      },
      line,
    );
  }
  // 끝 표시 두 번
  assert.throws(() => splitConsole([mark('main_start', 1), mark('main_end', 2), mark('main_end', 3)].join('\n')), Error);
});

test('[ASVS v5.0.0-2.2.1] splitConsole 줄 번호는 빈 줄을 포함한 실제 줄 번호다', () => {
  assert.throws(
    () => splitConsole(`${ENTRY}\n\n\n\n\n\nnot json\n`),
    (e) => e instanceof Error && mentionsNumber(e.message, 7),
  );
});

test('[ASVS v5.0.0-16.2.5] splitConsole 오류 메시지에 그 줄의 내용(토큰처럼 보이는 글)을 싣지 않는다', () => {
  const secret = 'tok_SECRET_9f8e7d6c5b4a3921';
  assert.deepStrictEqual(splitConsole(`${ENTRY}\n`).records, [ENTRY]); // 기준: 바른 줄은 받는다
  const lines = [
    `{"kind":"queue_entry","authorization":"Bearer ${secret}"`, // JSON 아님
    `{"kind":"debug","authorization":"Bearer ${secret}"}`, // 모르는 kind
    `{"kind":"Bearer ${secret}"}`, // kind 값 자체
    `[${JSON.stringify(secret)}]`, // 배열
    `Bearer ${secret}`,
  ];
  for (const line of lines) {
    assert.throws(
      () => splitConsole(`${ENTRY}\n${line}\n`),
      (e) => {
        assert.ok(e instanceof Error);
        assert.ok(!e.message.includes(secret) && !e.message.includes('SECRET') && !e.message.includes('Bearer'), e.message);
        return true;
      },
    );
  }
});

let parseRecordsCache;
/** 검사기의 실제 기록 읽기(parseRecords). 매개변수 속성(constructor(readonly line…))이 있어 형식만 지우는 기본 모드로는
 *  읽히지 않으면, node:module의 stripTypeScriptTypes(transform)로 바꿔 읽는다(파일 안에 import가 없다) */
async function realParseRecords() {
  if (parseRecordsCache) return parseRecordsCache;
  const file = join(REPO, 'services', 'invariant-checker', 'src', 'records.ts');
  try {
    parseRecordsCache = (await import(pathToFileURL(file).href)).parseRecords;
  } catch (e) {
    if (e?.code !== 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') throw e;
    const { stripTypeScriptTypes } = await import('node:module');
    const js = stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'transform' });
    parseRecordsCache = (await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)).parseRecords;
  }
  assert.equal(typeof parseRecordsCache, 'function');
  return parseRecordsCache;
}

test('K1 Q-T2 splitConsole이 옮긴 기록 줄은 검사기가 그대로 읽는다', async () => {
  const parseRecords = await realParseRecords();
  const { records } = splitConsole([ENTRY, mark('main_start', 1), ADMIT_SPACED, mark('main_end', 2), ENTRY2].join('\n'));
  const r = parseRecords(records.join('\n'));
  assert.equal(r.queue_entry.length, 2);
  assert.equal(r.queue_admit.length, 1);
});

test('K1 Q-T2 servingRecords serving_log를 queue_serving 줄(KST 시각)로 바꾸고 검사기가 읽는다', async () => {
  const parseRecords = await realParseRecords();
  const log = [
    { serving: 0, called: 0, atMs: 0 },
    { serving: 28, called: 30, atMs: 1793649471000 },
    { serving: 56, called: 60, atMs: 1793649472123 },
  ];
  const lines = servingRecords(UUID_A, log);
  assert.equal(lines.length, 3);
  for (const l of lines) {
    assert.equal(typeof l, 'string');
    assert.ok(!l.includes('\n'));
  }
  const expected = [
    { kind: 'queue_serving', event_id: UUID_A, serving: 0, observed_at: '1970-01-01T09:00:00.000+09:00' },
    { kind: 'queue_serving', event_id: UUID_A, serving: 28, observed_at: '2026-11-03T04:57:51.000+09:00' },
    { kind: 'queue_serving', event_id: UUID_A, serving: 56, observed_at: '2026-11-03T04:57:52.123+09:00' },
  ];
  assert.deepStrictEqual(lines.map((l) => JSON.parse(l)), expected);
  const parsed = parseRecords(lines.join('\n') + '\n');
  assert.deepStrictEqual(parsed.queue_serving, expected.map(({ kind: _k, ...rest }) => rest));
  assert.deepStrictEqual(servingRecords(UUID_A, []), []);
  // 줄 글은 queueServingRecord 객체를 JSON 한 줄로 쓴 것이다(칸 순서 kind·event_id·serving·observed_at)
  assert.equal(lines[1], `{"kind":"queue_serving","event_id":"${UUID_A}","serving":28,"observed_at":"2026-11-03T04:57:51.000+09:00"}`);
});

test('K1 Q-T2 servingRecords eventId는 대문자 UUID도 받고 검사기가 그 줄을 읽는다', async () => {
  const upper = UUID_A.toUpperCase();
  const lines = servingRecords(upper, [{ serving: 3, called: 3, atMs: 1793649471000 }]);
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.event_id.toLowerCase(), UUID_A);
  assert.equal(rec.serving, 3);
  const parseRecords = await realParseRecords();
  assert.equal(parseRecords(`${lines[0]}\n`).queue_serving[0].event_id, UUID_A);
  assert.equal(servingRecords('0B5A3F9E-1c2d-4E5F-8a9b-0C1D2E3F4A5B', [{ serving: 1, called: 1, atMs: 1 }]).length, 1); // 섞인 대소문자
});

test('[ASVS v5.0.0-2.2.1] servingRecords eventId가 UUID가 아니면 Error, serving·시각이 틀려도 Error', () => {
  const log = [{ serving: 1, called: 1, atMs: 1 }];
  assert.equal(servingRecords(UUID_A, log).length, 1); // 기준: 바른 UUID는 받는다
  for (const id of ['not-a-uuid', '', `${UUID_A}\n`, ` ${UUID_A}`, `${UUID_A}0`, UUID_A.replaceAll('-', ''),
    '0b5a3f9e-1c2d-4e5f-8a9b-0c1d2e3f4a5g', undefined, null, 123]) {
    assert.throws(() => servingRecords(id, log), Error, String(id));
  }
  assert.throws(() => servingRecords(UUID_A, [{ serving: -1, called: 0, atMs: 1 }]), Error);
  assert.throws(() => servingRecords(UUID_A, [{ serving: 1.5, called: 0, atMs: 1 }]), Error);
  assert.throws(() => servingRecords(UUID_A, [{ serving: 1, called: 0, atMs: -1 }]), Error);
});

const PG1 = JSON.stringify({ kind: 'pg_charge', pg: 'SIMULATOR', payment_ref: 'sim_pay_1', order_ref: 'ord_1', amount: 110000, status: 'DONE',
  approved_at: '2026-11-03T04:57:51.000+09:00', canceled_amount: 0 });
const PG2 = JSON.stringify({ kind: 'pg_charge', pg: 'SIMULATOR', payment_ref: 'sim_pay_2', order_ref: 'ord_2', amount: 220000, status: 'CANCELED',
  approved_at: null, canceled_amount: 220000 });

test('K7 pgChargeLines 시뮬레이터 원장의 pg_charge 줄을 순서대로 그대로 돌려주고 빈 줄은 건너뛴다', async () => {
  assert.deepStrictEqual(pgChargeLines(`${PG1}\n\n${PG2}\n`), [PG1, PG2]);
  assert.deepStrictEqual(pgChargeLines(`${PG2}\n${PG1}`), [PG2, PG1]); // 줄바꿈 없는 마지막 줄도 읽는다(HTTP 응답 전체)
  assert.deepStrictEqual(pgChargeLines(''), []);
  const parseRecords = await realParseRecords();
  assert.equal(parseRecords(pgChargeLines(`${PG1}\n${PG2}\n`).join('\n')).pg_charge.length, 2);
});

test('K7 pgChargeLines JSON 객체가 아니거나 kind가 pg_charge가 아니면 Error', () => {
  assert.deepStrictEqual(pgChargeLines(`${PG1}\n`), [PG1]); // 기준: 바른 줄은 받는다
  for (const line of ['not json', '[]', 'null', '7', '{"kind":"queue_entry"}', '{"kind":"PG_CHARGE"}', '{"pg":"SIMULATOR"}',
    '{"kind":"toString"}', ENTRY, '{"kind":"pg_charge"']) {
    assert.throws(() => pgChargeLines(`${PG1}\n${line}\n`), Error, line);
  }
});

// ---------------------------------------------------------------------------------------------
// results.mjs: collectArgs와 collect.py
// ---------------------------------------------------------------------------------------------

const FULL = Object.freeze({
  runId: '2026-11-03-k1-v0-local-1k-runner',
  kpi: 'K1',
  version: 'v0',
  profile: 'local-1k',
  users: 1000,
  rps: 100,
  durationS: 60,
  warmupS: 30,
  scenario: 'loadtest/scenarios/v0-queue.js',
  summaryFile: '/tmp/r/summary.json',
  infraFile: '/tmp/r/infra.txt',
  notes: '발생기 CPU 평균 32.5%, 최대 60%; 메모리 최대 50% "q" $(id)',
  start: '2026-11-03T01:00:00Z',
  end: '2026-11-03T01:01:30Z',
  invalidReason: '발생기가 반복을 시작하지 못함(dropped_iterations 3)',
  invariants: '/tmp/r/invariants.csv',
  extra: ['/tmp/r/generator.json', '/tmp/r/records.ndjson'],
});
const MINIMAL = Object.freeze({
  runId: '2026-11-03-gen-local-gen-cal',
  kpi: 'NFR-013',
  version: 'v0',
  profile: 'local-gen',
  durationS: 30,
  warmupS: 10,
  scenario: 'loadtest/scenarios/calibrate.js',
  summaryFile: 'C:\\run dir\\summary.json',
  infraFile: 'C:\\run dir\\infra.txt',
  notes: '보정',
});

test('[ASVS v5.0.0-1.2.5] collectArgs 모든 칸을 주면 늘 쓰는 인자 뒤에 users·rps·start·end·invalid-reason·invariants·extra를 붙인다', () => {
  assert.deepStrictEqual(collectArgs(FULL), [
    'tools/perf-ledger/collect.py',
    '--run-id', FULL.runId,
    '--kpi', 'K1',
    '--version', 'v0',
    '--profile', 'local-1k',
    '--duration', '60',
    '--warmup', '30',
    '--scenario', 'loadtest/scenarios/v0-queue.js',
    '--k6-summary', '/tmp/r/summary.json',
    '--infra-file', '/tmp/r/infra.txt',
    '--notes', FULL.notes,
    '--verdict', 'baseline',
    '--users', '1000',
    '--rps', '100',
    '--start', '2026-11-03T01:00:00Z',
    '--end', '2026-11-03T01:01:30Z',
    '--invalid-reason', FULL.invalidReason,
    '--invariants', '/tmp/r/invariants.csv',
    '--extra', '/tmp/r/generator.json',
    '--extra', '/tmp/r/records.ndjson',
  ]);
});

test('[ASVS v5.0.0-1.2.5] collectArgs 선택 칸이 없으면 늘 쓰는 인자만, 빈 extra는 아무것도 붙이지 않는다', () => {
  const expected = [
    'tools/perf-ledger/collect.py',
    '--run-id', MINIMAL.runId,
    '--kpi', 'NFR-013',
    '--version', 'v0',
    '--profile', 'local-gen',
    '--duration', '30',
    '--warmup', '10',
    '--scenario', 'loadtest/scenarios/calibrate.js',
    '--k6-summary', 'C:\\run dir\\summary.json',
    '--infra-file', 'C:\\run dir\\infra.txt',
    '--notes', '보정',
    '--verdict', 'baseline',
  ];
  assert.deepStrictEqual(collectArgs(MINIMAL), expected);
  assert.deepStrictEqual(collectArgs({ ...MINIMAL, extra: [] }), expected);
});

test('[ASVS v5.0.0-1.2.5] collectArgs 셸 없이 부르는 인자 목록: 모든 원소가 문자열이고 공백·따옴표·$( )가 든 값도 원소 하나다', () => {
  const args = collectArgs(FULL);
  assert.ok(args.every((a) => typeof a === 'string'));
  assert.equal(args.filter((a) => a === FULL.notes).length, 1);
  assert.equal(args[args.indexOf('--notes') + 1], FULL.notes);
  assert.equal(args[args.indexOf('--rps') + 1], '100');
  assert.equal(collectArgs({ ...FULL, rps: 28.3 })[args.indexOf('--rps') + 1], '28.3');
});

test('[ASVS v5.0.0-1.2.5] collectArgs start·end는 둘 다 있을 때만 싣는다', () => {
  const base = collectArgs(MINIMAL);
  assert.deepStrictEqual(collectArgs({ ...MINIMAL, start: '2026-11-03T01:00:00Z' }), base);
  assert.deepStrictEqual(collectArgs({ ...MINIMAL, end: '2026-11-03T01:01:30Z' }), base);
  assert.deepStrictEqual(collectArgs({ ...MINIMAL, start: '2026-11-03T01:00:00Z', end: '2026-11-03T01:01:30Z' }),
    [...base, '--start', '2026-11-03T01:00:00Z', '--end', '2026-11-03T01:01:30Z']);
  // 한쪽만 있어도 뒤의 칸 차례는 그대로다
  assert.deepStrictEqual(collectArgs({ ...MINIMAL, users: 5, start: '2026-11-03T01:00:00Z', invariants: '/tmp/i.csv' }),
    [...base, '--users', '5', '--invariants', '/tmp/i.csv']);
});

test('[ASVS v5.0.0-1.2.5] collectArgs 문자열 값이 비었거나 -로 시작하면(argparse가 인자로 읽는다) Error', () => {
  assert.equal(collectArgs({ ...MINIMAL, notes: 'a -b --c' })[collectArgs(MINIMAL).indexOf('--notes') + 1], 'a -b --c'); // 기준: 가운데의 -는 된다
  const bad = [
    { notes: '' },
    { notes: '-x' },
    { notes: '--force' },
    { runId: '' },
    { runId: '--root' },
    { kpi: '-K1' },
    { version: '' },
    { profile: '-local' },
    { scenario: '--scenario' },
    { summaryFile: '-summary.json' },
    { infraFile: '' },
    { invalidReason: '-발생기' },
    { invariants: '--x' },
    { extra: ['/tmp/a', '-b'] },
    { extra: [''] },
    { start: '-2026-11-03T01:00:00Z', end: '2026-11-03T01:01:30Z' },
    { start: '2026-11-03T01:00:00Z', end: '--end' },
  ];
  for (const over of bad) assert.throws(() => collectArgs({ ...MINIMAL, ...over }), Error, JSON.stringify(over));
});

test('[ASVS v5.0.0-1.2.5] collectArgs가 내는 인자는 모두 collect.py가 선언한 인자다', () => {
  const src = readFileSync(join(REPO, 'tools', 'perf-ledger', 'collect.py'), 'utf8');
  const declared = new Set([...src.matchAll(/add_argument\('(--[a-z0-9-]+)'/g)].map((m) => m[1]));
  assert.ok(declared.has('--run-id') && declared.has('--invalid-reason'));
  for (const o of [FULL, MINIMAL]) {
    for (const a of collectArgs(o).filter((x) => x.startsWith('--'))) {
      assert.ok(declared.has(a), `collect.py에 없는 인자: ${a}`);
    }
  }
});

/** collect.py를 OS 임시 폴더 루트(--root)로 부른다. 저장소의 docs/perf-ledger/runs는 건드리지 않는다 */
function runCollect(o, files) {
  assert.ok(PY, 'Python 3을 찾지 못했다(PYTHON 환경 값으로 실행 파일을 줄 수 있다)');
  const root = mkdtempSync(join(tmpdir(), 'runner-collect-'));
  try {
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'perf-ledger.md'), '# 성능 장부\n\n<!-- ledger:begin -->\n<!-- ledger:end -->\n');
    const paths = {};
    for (const [name, body] of Object.entries(files)) {
      paths[name] = join(root, name);
      writeFileSync(paths[name], typeof body === 'string' ? body : JSON.stringify(body));
    }
    const args = collectArgs(o(paths));
    assert.equal(args[0], 'tools/perf-ledger/collect.py');
    // --root·--commit은 시험 하네스가 붙인다(임시 루트, git 호출 없음)
    const r = spawnSync(PY, ['-I', '-X', 'utf8', ...args, '--root', root, '--commit', 'runner-test'], { cwd: REPO, encoding: 'utf8' });
    assert.equal(r.status, 0, `collect.py 실패(${r.error?.message ?? ''}):\n${r.stdout}\n${r.stderr}`);
    const runId = args[args.indexOf('--run-id') + 1];
    const manifest = JSON.parse(readFileSync(join(root, 'docs', 'perf-ledger', 'runs', runId, 'manifest.json'), 'utf8'));
    assert.equal(existsSync(join(REPO, 'docs', 'perf-ledger', 'runs', runId)), false, '저장소 장부에 쓰지 않는다');
    return manifest;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const k6Summary = (dropped) => ({
  metrics: {
    http_req_duration: { values: { avg: 2.1, med: 1.8, 'p(95)': 3.2, 'p(99)': 4.4 } },
    http_req_failed: { values: { rate: 0 } },
    http_reqs: { values: { count: 6000, rate: 100 } },
    dropped_iterations: { values: { count: dropped } },
  },
});

test('V-T3 반복을 시작하지 못한 실행을 collectArgs로 collect.py에 넘기면 manifest가 valid false와 무효 사유를 남긴다', () => {
  const reason = judgeGenerator({ dropped: 3, cpuMeanPct: 32.5, memMaxPct: 50 }).reasons.join('; ');
  assert.equal(reason, '발생기가 반복을 시작하지 못함(dropped_iterations 3)');
  const m = runCollect(
    (p) => ({
      ...FULL,
      runId: '2026-11-03-k1-v0-local-1k-vt3',
      summaryFile: p['summary.json'],
      infraFile: p['infra.txt'],
      invariants: p['invariants.csv'],
      extra: [p['generator.json'], p['records.ndjson']],
      invalidReason: reason,
    }),
    {
      'summary.json': k6Summary(3),
      'infra.txt': 'generator: kind pod cpu 4 memory 4096Mi\n',
      'invariants.csv': 'invariant,violations\nadmit_before_turn,0\n',
      'generator.json': { cpuMeanPct: 32.5, cpuMaxPct: 60, memMaxPct: 50 },
      'records.ndjson': `${ENTRY}\n`,
    },
  );
  assert.equal(m.valid, false);
  assert.equal(m.invalid_reason, reason);
  assert.equal(m.k6.dropped_iterations, 3);
  assert.equal(m.generator.dropped_iterations, 3);
  assert.equal(m.run_id, '2026-11-03-k1-v0-local-1k-vt3');
  assert.deepStrictEqual([m.kpi, m.version, m.profile, m.verdict], ['K1', 'v0', 'local-1k', 'baseline']);
  assert.deepStrictEqual(m.scale, { users: 1000, arrival_rps: 100, duration_s: 60, warmup_s: 30 });
  assert.equal(m.scenario.path, 'loadtest/scenarios/v0-queue.js');
  assert.equal(m.notes, FULL.notes);
  assert.equal(m.started_at, '2026-11-03T01:00:00Z');
  assert.equal(m.ended_at, '2026-11-03T01:01:30Z');
  assert.deepStrictEqual(m.attachments, { infra: 'infra.txt', invariants: 'invariants.csv', extra: ['generator.json', 'records.ndjson'] });
});

test('V-T3 늘 쓰는 인자만으로 collect.py가 받아들이고 반복을 다 시작한 실행은 valid true다', () => {
  const m = runCollect(
    (p) => ({ ...MINIMAL, summaryFile: p['summary.json'], infraFile: p['infra.txt'] }),
    { 'summary.json': k6Summary(0), 'infra.txt': 'generator: kind pod cpu 4\n' },
  );
  assert.equal(m.valid, true);
  assert.equal(m.invalid_reason, null);
  assert.equal(m.k6.dropped_iterations, 0);
  assert.deepStrictEqual(m.scale, { users: null, arrival_rps: null, duration_s: 30, warmup_s: 10 });
  assert.deepStrictEqual([m.kpi, m.profile, m.verdict, m.notes], ['NFR-013', 'local-gen', 'baseline', '보정']);
});
