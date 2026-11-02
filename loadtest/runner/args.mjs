// 실행 도구 인자(docs/verification.md §3.9, loadtest/README.md). 클러스터를 건드리기 전에 모두 검사한다(ASVS v5.0.0-2.2.1).
//   node loadtest/run.mjs cleanup   (강제 종료 뒤 남은 발생기 파드·실행 폴더·시험 키·빈 응답 대역·실행 잠금을 지운다)
//   node loadtest/run.mjs calibrate [--cpus 4] [--memory-mi 4096] [--target-cpus 8] [--rates 1000,2000,4000,8000] [--warm 10] [--main 30] [--record] [--out <폴더>]
//   node loadtest/run.mjs v0 queue --users N --entry-rate R --admit-per-second A [공통]
//   node loadtest/run.mjs v0 seat-hold --users N --rate R [--mode spread|hot|crossed] [--hold-size 2] [--hot-count 1] [--pairs 1] [--release-ms 0] [공통]
//   node loadtest/run.mjs v0 payment --users N --rate R [--seats-per-order 2] [공통]
//   공통: [--warm 30] [--main 60] [--cpus 4] [--memory-mi 4096] [--record --run-id <ID>] [--profile <이름>] [--invariants] [--out <폴더>]

export class UsageError extends Error {
  name = 'UsageError';
}

/** 입구의 IP당 초당 요청 한도(deploy/envs/local/v0-gateway.yaml PEAKET_V0_RATE_PER_SECOND, 시험이 견준다) */
export const GATEWAY_RATE_PER_IP = 10;

/** 시나리오 이름 → 파일 */
export const SCENARIOS = Object.freeze({ queue: 'v0-queue.js', 'seat-hold': 'v0-seat-hold.js', payment: 'v0-payment.js' });

/** 기본값 [가정](docs/verification.md §3.9) */
export const DEFAULTS = Object.freeze({
  warmS: 30,
  mainS: 60,
  cpus: 4,
  memoryMi: 4096,
  mode: 'spread',
  holdSize: 2,
  hotCount: 1,
  pairs: 1,
  releaseMs: 0,
  seatsPerOrder: 2,
  calibrate: Object.freeze({ cpus: 4, memoryMi: 4096, targetCpus: 8, rates: Object.freeze([1000, 2000, 4000, 8000]), warmS: 10, mainS: 30 }),
});

const INTS = {
  '--users': ['users', 1, 131072],
  '--rate': ['rate', 1, 100000],
  '--entry-rate': ['entryRate', 1, 100000],
  '--admit-per-second': ['admitPerSecond', 1, 100000],
  '--warm': ['warmS', 1, 3600],
  '--main': ['mainS', 5, 7200],
  '--cpus': ['cpus', 1, 16],
  '--target-cpus': ['targetCpus', 1, 16],
  '--memory-mi': ['memoryMi', 256, 32768],
  '--hold-size': ['holdSize', 1, 4],
  '--hot-count': ['hotCount', 1, 1000],
  '--pairs': ['pairs', 1, 1000],
  '--release-ms': ['releaseMs', 0, 600000],
  '--seats-per-order': ['seatsPerOrder', 1, 4],
};

const BOOLS = { '--record': 'record', '--invariants': 'invariants' };

const STRINGS = { '--run-id': 'runId', '--profile': 'profile', '--mode': 'mode', '--out': 'out', '--rates': 'rates' };

const COMMON_V0 = ['--users', '--warm', '--main', '--cpus', '--memory-mi', '--record', '--run-id', '--profile', '--invariants', '--out'];

const ALLOWED = {
  calibrate: ['--cpus', '--memory-mi', '--target-cpus', '--rates', '--warm', '--main', '--record', '--out'],
  queue: [...COMMON_V0, '--entry-rate', '--admit-per-second'],
  'seat-hold': [...COMMON_V0, '--rate', '--mode', '--hold-size', '--hot-count', '--pairs', '--release-ms'],
  payment: [...COMMON_V0, '--rate', '--seats-per-order'],
};

const REQUIRED = { queue: ['--users', '--entry-rate', '--admit-per-second'], 'seat-hold': ['--users', '--rate'], payment: ['--users', '--rate'] };

const RUN_ID = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,80}$/;

const PROFILE = /^local-[a-z0-9-]{1,20}$/;

const MODES = ['spread', 'hot', 'crossed'];
/** 토큰 수명 상한(초, docs/verification.md §3.9 '신원') */
const TOKEN_TTL_MAX_S = 3 * 3600;

const fail = (msg) => {
  throw new UsageError(msg);
};

function decimal(flag, raw, lo, hi) {
  if (!/^\d+$/.test(raw)) fail(`${flag}는 10진수 정수다: ${raw}`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < lo || n > hi) fail(`${flag}는 ${lo}~${hi}다: ${raw}`);
  return n;
}

function parseRates(raw) {
  const parts = raw.split(',');
  if (parts.length < 1 || parts.length > 20) fail('--rates는 1~20개다');
  const rates = parts.map((p) => decimal('--rates', p, 1, 100000));
  for (let i = 1; i < rates.length; i++) if (rates[i] <= rates[i - 1]) fail('--rates는 엄격히 오름차순이어야 한다');
  return rates;
}

/**
 * 인자를 읽어 검사한다. 틀리면 UsageError(메시지는 한국어, 무엇이 틀렸는지).
 * 돌려주는 꼴:
 * - cleanup: { command: 'cleanup' }(다른 인자는 받지 않는다)
 * - calibrate: { command: 'calibrate', cpus, memoryMi, targetCpus, rates: number[], warmS, mainS, record: boolean, out?: string }
 * - v0: { command: 'v0', scenario: 'queue'|'seat-hold'|'payment', users, warmS, mainS, cpus, memoryMi, record, runId?, profile?, invariants: boolean, out?,
 *         (queue) entryRate, admitPerSecond, (seat-hold) rate, mode, holdSize, hotCount, pairs, releaseMs, (payment) rate, seatsPerOrder }
 * 규칙:
 * - 인자는 `--이름 값` 꼴만 받는다(`--이름=값`은 모르는 인자). 정수 인자는 10진수 숫자만(부호·소수점·지수·공백 없음, 앞의 0은 받는다) 받는다. 범위: users 1~131,072, rate·entry-rate·admit-per-second 1~100,000,
 *   warm 1~3,600, main 5~7,200(양 끝 1초씩 빼고 발생기 표본이 둘 이상이게), cpus·target-cpus 1~16, memory-mi 256~32,768, hold-size 1~4, hot-count 1~1,000, pairs 1~1,000,
 *   release-ms 0~600,000, seats-per-order 1~4
 * - --rates는 쉼표로 나눈 1~20개 정수(각 1~100,000)이고 엄격히 오름차순이어야 한다
 * - 모르는 인자, 값이 없는 인자(다음 인자가 '--'로 시작하거나 없음), 같은 인자 두 번, 그 시나리오에 없는 인자(예: queue의 --rate)는 거부
 * - queue는 --users·--entry-rate·--admit-per-second, seat-hold·payment는 --users·--rate가 꼭 있어야 한다
 * - --record면 v0는 --run-id가 꼭 있어야 하고(`^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,80}$`), --run-id·--profile은 --record 없이 줄 수 없다.
 *   --profile은 `^local-[a-z0-9-]{1,20}$`이고 --record일 때만 칸이 있으며, 기본은 사용자 수로 정한다(1,000 이하 local-1k, 10,000 이하 local-10k, 그 밖 local-100k).
 *   calibrate의 --record는 실행 ID를 도구가 단계마다 `<KST 날짜>-gen-calib-c<cpus>-r<도착률>-<실행 꼬리표>`로 만든다(--run-id를 받지 않는다. 같은 보정을 여러 번 해도 겹치지 않는다)
 * - --mode는 spread·hot·crossed, hot-count·pairs·release-ms·hold-size는 seat-hold에서만(그 방식이 쓰지 않는 값이어도 받는다)
 * - payment는 users × seats-per-order ≤ 100,000이고, 결제 시작 수의 상한(rate × (warm + main) + 2)이 users 이하여야 한다(가상 사용자 하나가 결제 하나.
 *   도착률 실행기는 구간마다 반복을 '도착률 × 시간 + 1'번까지 시작할 수 있다)
 * - seat-hold는 가상 사용자 한 명(IP 하나)이 받는 몫이 입구의 IP당 한도(초당 GATEWAY_RATE_PER_IP)의 60% 안이어야 한다(무작위로 고른 사람의
 *   요청이 몰려도 입구의 토큰 통이 비지 않게, 2차 새 맥락 리뷰 2026-11-03): rate × 2(홀드 + 해제) ≤ 0.6 × GATEWAY_RATE_PER_IP × users
 * - calibrate는 전체 길이(단계 수 × (warm + main + 30) + 600)가 파드 실행 시간 상한 11,400초 이하여야 한다
 * - v0는 예상 시간(queue: ceil(users ÷ entry-rate), 그 밖: 2 × ceil(users ÷ min(users, 200)) + 3, 여기에 warm + main + 60초)에
 *   10분을 더한 토큰 수명이 3시간(10,800초)을 넘으면 거부한다(본구간 중에 토큰이 끝나 401로 실패하지 않게)
 * - --out은 비지 않은 경로(그대로 둔다)
 * @param {string[]} argv process.argv.slice(2)
 * @returns {Record<string, unknown>}
 */
export function parseArgs(argv) {
  if (!Array.isArray(argv)) fail('인자 목록이 없다');
  const [command, ...rest0] = argv;
  let kind;
  let rest;
  if (command === 'cleanup') {
    if (rest0.length > 0) fail('cleanup은 인자를 받지 않는다');
    return { command: 'cleanup' };
  }
  if (command === 'calibrate') {
    kind = 'calibrate';
    rest = rest0;
  } else if (command === 'v0') {
    const scenario = rest0[0];
    if (!Object.hasOwn(SCENARIOS, scenario ?? '')) fail(`v0 시나리오는 ${Object.keys(SCENARIOS).join('·')} 가운데 하나다: ${scenario ?? '(없음)'}`);
    kind = scenario;
    rest = rest0.slice(1);
  } else fail(`명령은 calibrate·v0·cleanup 가운데 하나다: ${command ?? '(없음)'}`);

  const seen = new Map();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!ALLOWED[kind].includes(flag)) fail(Object.hasOwn(INTS, flag) || Object.hasOwn(BOOLS, flag) || Object.hasOwn(STRINGS, flag) ? `${flag}는 ${kind}에 없는 인자다` : `모르는 인자: ${flag}`);
    if (seen.has(flag)) fail(`${flag}를 두 번 줬다`);
    if (Object.hasOwn(BOOLS, flag)) {
      seen.set(flag, true);
      continue;
    }
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) fail(`${flag}에 값이 없다`);
    seen.set(flag, v);
    i++;
  }

  const o = {};
  for (const [flag, raw] of seen) {
    if (Object.hasOwn(INTS, flag)) {
      const [key, lo, hi] = INTS[flag];
      o[key] = decimal(flag, raw, lo, hi);
    } else if (Object.hasOwn(BOOLS, flag)) o[BOOLS[flag]] = true;
    else if (flag === '--rates') o.rates = parseRates(raw);
    else o[STRINGS[flag]] = raw;
  }
  if (o.out !== undefined && o.out.length === 0) fail('--out은 비지 않은 경로다');

  if (kind === 'calibrate') {
    const d = DEFAULTS.calibrate;
    const nSteps = (o.rates ?? d.rates).length;
    const totalS = nSteps * ((o.warmS ?? d.warmS) + (o.mainS ?? d.mainS) + 30) + 600;
    if (totalS > 11400) fail(`보정 전체 길이(${totalS}초)가 파드 실행 시간 상한 11,400초를 넘는다`);
    return {
      command: 'calibrate',
      cpus: o.cpus ?? d.cpus,
      memoryMi: o.memoryMi ?? d.memoryMi,
      targetCpus: o.targetCpus ?? d.targetCpus,
      rates: o.rates ?? [...d.rates],
      warmS: o.warmS ?? d.warmS,
      mainS: o.mainS ?? d.mainS,
      record: o.record ?? false,
      ...(o.out !== undefined ? { out: o.out } : {}),
    };
  }

  for (const flag of REQUIRED[kind]) if (!seen.has(flag)) fail(`${kind}에는 ${flag}가 꼭 있어야 한다`);
  const record = o.record ?? false;
  if (!record && (o.runId !== undefined || o.profile !== undefined)) fail('--run-id·--profile은 --record와 함께만 준다');
  if (record && o.runId === undefined) fail('--record에는 --run-id가 꼭 있어야 한다');
  if (o.runId !== undefined && !RUN_ID.test(o.runId)) fail(`--run-id 꼴이 틀렸다(YYYY-MM-DD-영소문자·숫자·-): ${o.runId}`);
  if (o.profile !== undefined && !PROFILE.test(o.profile)) fail(`--profile 꼴이 틀렸다(local-…): ${o.profile}`);

  const warmS = o.warmS ?? DEFAULTS.warmS;
  const mainS = o.mainS ?? DEFAULTS.mainS;
  const prepS = kind === 'queue' ? Math.ceil(o.users / o.entryRate) : 2 * Math.ceil(o.users / Math.min(o.users, 200)) + 3;
  if (prepS + warmS + mainS + 60 + 600 > TOKEN_TTL_MAX_S) fail(`예상 시간(${prepS + warmS + mainS + 60}초)에 10분을 더한 토큰 수명이 3시간을 넘는다`);
  // 정수로 견준다: rate × 2 ≤ 0.6 × 한도 × users  ⇔  rate × 20 ≤ 6 × 한도 × users
  if (kind === 'seat-hold' && o.rate * 20 > 6 * GATEWAY_RATE_PER_IP * o.users) fail(`가상 사용자 한 명의 요청(${o.rate} × 2 ÷ ${o.users})이 입구의 IP당 한도(초당 ${GATEWAY_RATE_PER_IP})의 60%를 넘는다`);

  const base = {
    command: 'v0',
    scenario: kind,
    users: o.users,
    warmS: o.warmS ?? DEFAULTS.warmS,
    mainS: o.mainS ?? DEFAULTS.mainS,
    cpus: o.cpus ?? DEFAULTS.cpus,
    memoryMi: o.memoryMi ?? DEFAULTS.memoryMi,
    record,
    invariants: o.invariants ?? false,
    ...(o.runId !== undefined ? { runId: o.runId } : {}),
    ...(record ? { profile: o.profile ?? (o.users <= 1000 ? 'local-1k' : o.users <= 10000 ? 'local-10k' : 'local-100k') } : {}),
    ...(o.out !== undefined ? { out: o.out } : {}),
  };
  if (kind === 'queue') return { ...base, entryRate: o.entryRate, admitPerSecond: o.admitPerSecond };
  if (kind === 'seat-hold') {
    const mode = o.mode ?? DEFAULTS.mode;
    if (!MODES.includes(mode)) fail(`--mode는 ${MODES.join('·')} 가운데 하나다: ${mode}`);
    return {
      ...base,
      rate: o.rate,
      mode,
      holdSize: o.holdSize ?? DEFAULTS.holdSize,
      hotCount: o.hotCount ?? DEFAULTS.hotCount,
      pairs: o.pairs ?? DEFAULTS.pairs,
      releaseMs: o.releaseMs ?? DEFAULTS.releaseMs,
    };
  }
  const seatsPerOrder = o.seatsPerOrder ?? DEFAULTS.seatsPerOrder;
  if (o.users * seatsPerOrder > 100000) fail(`좌석이 모자란다: 사용자 ${o.users} × ${seatsPerOrder}석 > 100,000석`);
  if (o.rate * (base.warmS + base.mainS) + 2 > o.users) fail(`결제 시작 수의 상한(${o.rate} × ${base.warmS + base.mainS}초 + 2)이 가상 사용자 수(${o.users})보다 많다`);
  return { ...base, rate: o.rate, seatsPerOrder };
}
