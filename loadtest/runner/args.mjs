// 실행 도구 인자(docs/verification.md §3.9, loadtest/README.md). 클러스터를 건드리기 전에 모두 검사한다(ASVS v5.0.0-2.2.1).
//   node loadtest/run.mjs cleanup   (강제 종료 뒤 남은 발생기 파드·실행 폴더·시험 키·빈 응답 대역·실행 잠금을 지운다)
//   node loadtest/run.mjs calibrate [--cpus 4] [--memory-mi 4096] [--target-cpus 8] [--rates 1000,2000,4000,8000] [--warm 10] [--main 30] [--record] [--out <폴더>]
//   node loadtest/run.mjs v0 queue --users N --entry-rate R --admit-per-second A [공통]
//   node loadtest/run.mjs v0 seat-hold --users N --rate R [--mode spread|hot|crossed] [--hold-size 2] [--hot-count 1] [--pairs 1] [--release-ms 0] [공통]
//   node loadtest/run.mjs v0 payment --users N --rate R [--seats-per-order 2] [--fault-drop-pct 0] [--fault-delay-pct 0] [--kill-app-at S] [공통]
//   node loadtest/run.mjs v0 seat-deltas --users N --rate R --connections C [--listener-pods P] [--hold-size 2] [공통]
//   node loadtest/run.mjs v0 gate --scanners S --rate R [--cut-at 60] [--cut-s 60] [공통, --main 기본 180]
//   공통: [--warm 30] [--main 60] [--cpus 4] [--memory-mi 4096] [--generators N] [--namespace v0|v0-base] [--settle] [--hpa-timeline]
//         [--record --run-id <ID> [--profile <이름>] [--prom-url http://127.0.0.1:9090]] [--invariants] [--out <폴더>]
//   seat-hold만: [--keep] [--db-stats], payment만: [--db-stats]

export class UsageError extends Error {
  name = 'UsageError';
}

/** 입구의 IP당 초당 요청 한도(deploy/envs/local/v0-gateway.yaml PEAKET_V0_RATE_PER_SECOND, 시험이 견준다) */
export const GATEWAY_RATE_PER_IP = 10;

/** 시나리오 이름 → 파일 */
export const SCENARIOS = Object.freeze({ queue: 'v0-queue.js', 'seat-hold': 'v0-seat-hold.js', payment: 'v0-payment.js', 'seat-deltas': 'v0-seat-hold.js', gate: 'v0-gate.js' });

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
  namespace: 'v0',
  cutAtS: 60,
  cutS: 60,
  gateMainS: 180,
  connectionsPerPod: 500,
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
  '--generators': ['generators', 1, 64],
  '--fault-drop-pct': ['faultDropPct', 0, 100],
  '--fault-delay-pct': ['faultDelayPct', 0, 100],
  '--kill-app-at': ['killAppAtS', 1, 7200],
  '--connections': ['connections', 1, 20000],
  '--listener-pods': ['listenerPods', 1, 64],
  '--scanners': ['scanners', 1, 1000],
  '--cut-at': ['cutAtS', 1, 7200],
  '--cut-s': ['cutS', 1, 7200],
};

const BOOLS = { '--record': 'record', '--invariants': 'invariants', '--settle': 'settle', '--hpa-timeline': 'hpaTimeline', '--keep': 'keep', '--db-stats': 'dbStats' };

const STRINGS = { '--run-id': 'runId', '--profile': 'profile', '--mode': 'mode', '--out': 'out', '--rates': 'rates', '--namespace': 'namespace', '--prom-url': 'promUrl' };

const COMMON_RUN = ['--warm', '--main', '--cpus', '--memory-mi', '--record', '--run-id', '--profile', '--invariants', '--out', '--generators', '--namespace', '--settle', '--hpa-timeline', '--prom-url'];
const COMMON_V0 = ['--users', ...COMMON_RUN];

const ALLOWED = {
  calibrate: ['--cpus', '--memory-mi', '--target-cpus', '--rates', '--warm', '--main', '--record', '--out'],
  queue: [...COMMON_V0, '--entry-rate', '--admit-per-second'],
  'seat-hold': [...COMMON_V0, '--rate', '--mode', '--hold-size', '--hot-count', '--pairs', '--release-ms', '--keep', '--db-stats'],
  payment: [...COMMON_V0, '--rate', '--seats-per-order', '--fault-drop-pct', '--fault-delay-pct', '--kill-app-at', '--db-stats'],
  'seat-deltas': [...COMMON_V0, '--rate', '--connections', '--listener-pods', '--hold-size'],
  gate: [...COMMON_RUN, '--scanners', '--rate', '--cut-at', '--cut-s'],
};

const REQUIRED = {
  queue: ['--users', '--entry-rate', '--admit-per-second'],
  'seat-hold': ['--users', '--rate'],
  payment: ['--users', '--rate'],
  'seat-deltas': ['--users', '--rate', '--connections'],
  gate: ['--scanners', '--rate'],
};

const NAMESPACES = ['v0', 'v0-base'];
const PROM_URL = /^http:\/\/(127\.0\.0\.1|localhost):(\d{1,5})$/;

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
 * BSL-090(docs/verification.md §3.10)에서 더한 것:
 * - 모든 v0 시나리오: --generators N(1~64, 주면 그 수로 나누고 주지 않으면 실행 도구가 최고 도착률로 정한다. 돌려주는 꼴에는 줬을 때만 generators),
 *   --namespace(v0·v0-base, 기본 v0. 야간 비교의 기준판은 v0-base), --settle(시작 전 HPA가 올라와 있는 두 판의 앱 복제를 모두 최소로 줄일 때까지 기다림),
 *   --hpa-timeline(실행 동안의 HPA 사건·앱 파드 시각을 남김). --prom-url은 --record와 함께만 주고 'http://127.0.0.1:<포트>'나
 *   'http://localhost:<포트>' 꼴만 받는다(포트 1~65,535). 돌려주는 꼴: generators?, namespace, settle, hpaTimeline, promUrl?
 * - seat-hold: --keep(잡은 홀드를 놓지 않는다. 그때 IP 몫 규칙은 rate × 1 ≤ 0.6 × 한도 × users, 즉 rate × 10 ≤ 6 × 한도 × users이고
 *   --release-ms와 함께 줄 수 없다), --db-stats(실행 전후 DB 통계). 돌려주는 꼴: keep, dbStats
 * - payment: --fault-drop-pct·--fault-delay-pct(각 0~100, 합 100 이하, 기본 0), --kill-app-at(1~main 이하 정수, 본구간 시작부터 초),
 *   --db-stats. 돌려주는 꼴: faultDropPct, faultDelayPct, killAppAtS?(줬을 때만), dbStats
 * - seat-deltas(K4): --users(홀드를 보내는 가상 사용자)·--rate(홀드 도착률)·--connections(변경분 연결 1~20,000)가 꼭 있어야 하고,
 *   --listener-pods(1~64, 기본 ⌈connections ÷ 500⌉), --hold-size(기본 2)를 받는다. users + connections ≤ 131,072이고 listener-pods ≤ connections.
 *   홀드는 잡자마자 놓으므로 IP 몫 규칙은 seat-hold와 같다(rate × 20 ≤ 6 × 한도 × users). 토큰 수명 규칙의 준비 시간은
 *   2 × ceil((users + connections) ÷ min(users + connections, 200)) + 3이다.
 *   돌려주는 꼴: { …공통, scenario: 'seat-deltas', users, rate, connections, listenerPods, holdSize }
 * - gate(K10): --scanners(검표 스태프 계정 수 1~1,000)·--rate(초당 검표 1~1,000)가 꼭 있어야 하고 --users는 받지 않는다.
 *   --cut-at(본구간 시작부터 망을 끊는 초, 기본 60)·--cut-s(끊는 길이, 기본 60)이고 cut-at ≥ 1, cut-at + cut-s < main이어야 한다(main 기본 180).
 *   티켓 수 = rate × (warm + main) + 2 ≤ 100,000. IP 몫: rate × 10 ≤ 6 × 한도 × scanners. 준비 시간은 2 × ceil(scanners ÷ min(scanners, 200)) + 3.
 *   프로파일 기본은 scanners로 정한다. 돌려주는 꼴: { …공통(users 칸은 scanners와 같은 값), scenario: 'gate', scanners, rate, cutAtS, cutS, tickets }
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
  if (o.namespace !== undefined && !NAMESPACES.includes(o.namespace)) fail(`--namespace는 ${NAMESPACES.join('·')} 가운데 하나다: ${o.namespace}`);
  if (o.promUrl !== undefined) {
    const m = PROM_URL.exec(o.promUrl);
    const port = m ? Number(m[2]) : 0;
    if (!m || port < 1 || port > 65535) fail(`--prom-url은 http://127.0.0.1:<포트>나 http://localhost:<포트>다: ${o.promUrl}`);
  }

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
  if (!record && (o.runId !== undefined || o.profile !== undefined || o.promUrl !== undefined)) fail('--run-id·--profile·--prom-url은 --record와 함께만 준다');
  if (record && o.runId === undefined) fail('--record에는 --run-id가 꼭 있어야 한다');
  if (o.runId !== undefined && !RUN_ID.test(o.runId)) fail(`--run-id 꼴이 틀렸다(YYYY-MM-DD-영소문자·숫자·-): ${o.runId}`);
  if (o.profile !== undefined && !PROFILE.test(o.profile)) fail(`--profile 꼴이 틀렸다(local-…): ${o.profile}`);

  const warmS = o.warmS ?? DEFAULTS.warmS;
  const mainS = o.mainS ?? (kind === 'gate' ? DEFAULTS.gateMainS : DEFAULTS.mainS);
  // 준비 구간에서 진입·입장시키는 가상 사용자 수(seat-deltas는 연결 쪽까지, gate는 스캐너 계정)
  const prepUsers = kind === 'seat-deltas' ? o.users + o.connections : kind === 'gate' ? o.scanners : o.users;
  const prepS = kind === 'queue' ? Math.ceil(o.users / o.entryRate) : 2 * Math.ceil(prepUsers / Math.min(prepUsers, 200)) + 3;
  if (prepS + warmS + mainS + 60 + 600 > TOKEN_TTL_MAX_S) fail(`예상 시간(${prepS + warmS + mainS + 60}초)에 10분을 더한 토큰 수명이 3시간을 넘는다`);
  if (o.keep && seen.has('--release-ms')) fail('--keep(놓지 않음)과 --release-ms는 함께 줄 수 없다');
  // 정수로 견준다: rate × 2 ≤ 0.6 × 한도 × users  ⇔  rate × 20 ≤ 6 × 한도 × users(놓지 않으면 rate × 10 ≤ 6 × 한도 × users)
  if ((kind === 'seat-hold' || kind === 'seat-deltas') && o.rate * (o.keep ? 10 : 20) > 6 * GATEWAY_RATE_PER_IP * o.users) {
    fail(`가상 사용자 한 명의 요청(${o.rate} × ${o.keep ? 1 : 2} ÷ ${o.users})이 입구의 IP당 한도(초당 ${GATEWAY_RATE_PER_IP})의 60%를 넘는다`);
  }
  if (kind === 'gate' && o.rate > 1000) fail(`gate의 --rate는 1~1,000이다: ${o.rate}`);
  if (kind === 'gate' && o.rate * 10 > 6 * GATEWAY_RATE_PER_IP * o.scanners) fail(`스캐너 한 대의 요청(${o.rate} ÷ ${o.scanners})이 입구의 IP당 한도(초당 ${GATEWAY_RATE_PER_IP})의 60%를 넘는다`);
  if (o.killAppAtS !== undefined && o.killAppAtS > mainS) fail(`--kill-app-at(${o.killAppAtS})은 본구간(${mainS}초) 안이어야 한다`);
  if ((o.faultDropPct ?? 0) + (o.faultDelayPct ?? 0) > 100) fail('--fault-drop-pct와 --fault-delay-pct의 합은 100 이하다');

  const users = kind === 'gate' ? o.scanners : o.users;
  const base = {
    command: 'v0',
    scenario: kind,
    users,
    warmS,
    mainS,
    cpus: o.cpus ?? DEFAULTS.cpus,
    memoryMi: o.memoryMi ?? DEFAULTS.memoryMi,
    record,
    invariants: o.invariants ?? false,
    namespace: o.namespace ?? DEFAULTS.namespace,
    settle: o.settle ?? false,
    hpaTimeline: o.hpaTimeline ?? false,
    ...(o.generators !== undefined ? { generators: o.generators } : {}),
    ...(o.runId !== undefined ? { runId: o.runId } : {}),
    ...(record ? { profile: o.profile ?? (users <= 1000 ? 'local-1k' : users <= 10000 ? 'local-10k' : 'local-100k') } : {}),
    ...(o.promUrl !== undefined ? { promUrl: o.promUrl } : {}),
    ...(o.out !== undefined ? { out: o.out } : {}),
  };
  if (kind === 'queue') return { ...base, entryRate: o.entryRate, admitPerSecond: o.admitPerSecond };
  if (kind === 'seat-deltas') {
    if (o.users + o.connections > 131072) fail(`가상 사용자(${o.users}) + 연결(${o.connections})이 131,072명을 넘는다`);
    const listenerPods = o.listenerPods ?? Math.ceil(o.connections / DEFAULTS.connectionsPerPod);
    if (listenerPods > o.connections) fail(`받는 파드(${listenerPods})가 연결(${o.connections})보다 많다`);
    return { ...base, rate: o.rate, connections: o.connections, listenerPods, holdSize: o.holdSize ?? DEFAULTS.holdSize };
  }
  if (kind === 'gate') {
    const cutAtS = o.cutAtS ?? DEFAULTS.cutAtS;
    const cutS = o.cutS ?? DEFAULTS.cutS;
    if (cutAtS + cutS >= mainS) fail(`망 끊김(${cutAtS}초부터 ${cutS}초)은 본구간(${mainS}초) 안에서 끝나야 한다`);
    const tickets = o.rate * (warmS + mainS) + 2;
    if (tickets > 100000) fail(`티켓(${tickets}장)이 100,000장을 넘는다`);
    return { ...base, scanners: o.scanners, rate: o.rate, cutAtS, cutS, tickets };
  }
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
      keep: o.keep ?? false,
      dbStats: o.dbStats ?? false,
    };
  }
  const seatsPerOrder = o.seatsPerOrder ?? DEFAULTS.seatsPerOrder;
  if (o.users * seatsPerOrder > 100000) fail(`좌석이 모자란다: 사용자 ${o.users} × ${seatsPerOrder}석 > 100,000석`);
  if (o.rate * (base.warmS + base.mainS) + 2 > o.users) fail(`결제 시작 수의 상한(${o.rate} × ${base.warmS + base.mainS}초 + 2)이 가상 사용자 수(${o.users})보다 많다`);
  return {
    ...base,
    rate: o.rate,
    seatsPerOrder,
    faultDropPct: o.faultDropPct ?? 0,
    faultDelayPct: o.faultDelayPct ?? 0,
    ...(o.killAppAtS !== undefined ? { killAppAtS: o.killAppAtS } : {}),
    dbStats: o.dbStats ?? false,
  };
}
