// 진입 서버 비례 확인(MSR-020, docs/verification.md §3.3 '비례 확인'·§3.5, 계획 docs/review/plans/F-08-2.md 6.3·6.4)의 계산과 단계 올리기 실행기.
// - 순수 함수: 인자 검사, 단계 목록, 단계 판정, X(N)·중앙값·편차, 호스트 표시, E(N)·비례 판정, CPU 몫 고르기, usl.csv.
// - runEntrySteps: 단계 올리기 한 번(실행 함수는 부르는 쪽이 넘긴다. loadtest/run.mjs v1 entry-steps가 실제 실행을 잇는다).
// - 명령: node loadtest/runner/entry-scale.mjs report|choose …(측정 뒤 계산, 아래 main).
// 정본 값은 상수로 두고 그 자리를 주석으로 단다(값을 바꾸려면 정본부터 고친다). 빈 결과(찾지 못함·무효·값 없음)는 null이고 0이나 통과로 바꾸지 않는다.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError } from './args.mjs';

/** 진입 SLO: p99 200ms 이하, 오류율 0.1% 미만(docs/verification.md §3.3 X₁ 정의, NFR-001, lib/targets.mjs entry와 같은 값) */
export const ENTRY_RULES = Object.freeze({ p99MaxMs: 200, errorRateBelow: 0.001, p99Allowed: 0.01 });
/** 호스트 포화: 호스트 CPU 85% 이상이거나 procs_running이 논리 프로세서 수를 넘음. 코어 혼합: 준 CPU 합이 고성능 코어 스레드 16개를 넘음(docs/verification.md §3.5 6번) */
export const HOST_RULES = Object.freeze({ cpuUtilMaxPct: 85, performanceThreads: 16 });
/** 비례 판정: 가장 큰 포화 안 된 N의 E(N) ≥ 0.9, 남은 점 3개 미만이면 확인 못 함(docs/verification.md §3.3) */
export const PROPORTION_RULES = Object.freeze({ eMin: 0.9, minPoints: 3 });
/**
 * CPU 몫 고르기(계획 F-08-2 6.4): 1 → 0.5 → 0.25 vCPU, 8대 점, 발생기 CPU 2, Valkey 2·무대 나머지 4 [가정, 이 계획], 호스트 포화 문턱 85%와 같은 값.
 * 발생기 하나 몫은 800/s(계획 F-08-8 2절 4)
 */
export const POD_CPU_RULES = Object.freeze({ shares: Object.freeze([1, 0.5, 0.25]), nMax: 8, generatorCpus: 2, valkeyCpus: 2, stageCpus: 4, hostCpuMaxPct: 85 });
export const GENERATOR_RATE = 800;
/** 단계 올리기 기본(계획 F-08-2 6.3·12절 4, [가정, 이 계획]): 첫 단계 0.5 × N × X̂₁, 증가 0.1 × N × X̂₁, 상한 8단계, 예열 10초·본구간 30초·쉼 20초 */
export const STEP_DEFAULTS = Object.freeze({ startFactor: 0.5, stepFactor: 0.1, maxSteps: 8, warmS: 10, mainS: 30, restS: 20 });
/** 포화 표시 이름(정본 §3.5 6번의 말 그대로) */
export const TAG_SATURATED = '호스트 포화';
export const TAG_MIXED = '코어 혼합';
export const TAG_NO_HOST = '호스트 지표 없음';

const fail = (msg) => {
  throw new UsageError(msg);
};
const isPosInt = (v) => Number.isSafeInteger(v) && v >= 1;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** 진입 서버 한 대의 CPU 몫: 0.25·0.5 또는 1~16 정수(tools/local/v1-objects.mjs v1Plan과 같은 규칙) */
export const POD_CPUS = /^(?:0\.25|0\.5|[1-9]|1[0-6])$/;
const RUN_ID_PREFIX = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,60}$/;
const PROFILE = /^local-[a-z0-9-]{1,20}$/;
const PROM_URL = /^http:\/\/(127\.0\.0\.1|localhost):(\d{1,5})$/;

const INTS = {
  '--replicas': ['replicas', 1, 8],
  '--start-rate': ['startRate', 1, 100000],
  '--step-rate': ['stepRate', 1, 100000],
  '--x1-estimate': ['x1Estimate', 1, 100000],
  '--max-steps': ['maxSteps', 1, 8],
  '--warm': ['warmS', 1, 600],
  '--main': ['mainS', 5, 600],
  '--rest': ['restS', 0, 600],
  '--generators': ['generators', 1, 64],
  '--cpus': ['cpus', 1, 16],
  '--memory-mi': ['memoryMi', 256, 32768],
};
const STRINGS = { '--pod-cpus': 'podCpus', '--run-id-prefix': 'runIdPrefix', '--profile': 'profile', '--prom-url': 'promUrl', '--out': 'out' };
const BOOLS = { '--record': 'record', '--invariants': 'invariants' };

/**
 * `v1 entry-steps` 인자(계획 F-08-2 7.2). argv는 'v1'·'entry-steps' 뒤의 인자다(앞에 둘이 붙어 와도 떼고 읽는다). 틀리면 UsageError(run.mjs가 종료 코드 2로 끝낸다).
 * 꼭: --replicas N(1~8), --pod-cpus <몫>(POD_CPUS), 그리고 (--start-rate r --step-rate d) 또는 --x1-estimate X̂₁ 가운데 하나.
 * 선택: --max-steps(1~8, 기본 8) --warm(1~600, 기본 10) --main(5~600, 기본 30) --rest(0~600, 기본 20) --generators(1~64) --cpus·--memory-mi(발생기, 기본 2·1024)
 *       --record --run-id-prefix <YYYY-MM-DD-…>(둘은 함께) [--profile local-…] [--prom-url http://127.0.0.1:<포트>](--record와 함께) --invariants --out <폴더>.
 * 마지막 단계의 도착률은 100,000/s 이하여야 한다.
 * @param {string[]} argv
 */
export function parseEntryStepsArgs(argv) {
  if (!Array.isArray(argv)) fail('인자 목록이 없다');
  let rest = argv;
  if (rest[0] === 'v1') rest = rest.slice(1);
  if (rest[0] === 'entry-steps') rest = rest.slice(1);
  const seen = new Map();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!Object.hasOwn(INTS, flag) && !Object.hasOwn(STRINGS, flag) && !Object.hasOwn(BOOLS, flag)) fail(`entry-steps의 모르는 인자: ${flag}`);
    if (seen.has(flag)) fail(`${flag}를 두 번 줬다`);
    if (Object.hasOwn(BOOLS, flag)) {
      seen.set(flag, true);
      continue;
    }
    const v = rest[i + 1];
    if (v === undefined || v === '' || v.startsWith('--')) fail(`${flag}에 값이 없다`);
    seen.set(flag, v);
    i++;
  }
  const o = {};
  for (const [flag, raw] of seen) {
    if (Object.hasOwn(INTS, flag)) {
      const [key, lo, hi] = INTS[flag];
      if (!/^\d+$/.test(raw)) fail(`${flag}는 10진수 정수다: ${raw}`);
      const n = Number(raw);
      if (!Number.isSafeInteger(n) || n < lo || n > hi) fail(`${flag}는 ${lo}~${hi}다: ${raw}`);
      o[key] = n;
    } else if (Object.hasOwn(BOOLS, flag)) o[BOOLS[flag]] = true;
    else o[STRINGS[flag]] = raw;
  }
  if (o.replicas === undefined) fail('entry-steps에는 --replicas가 꼭 있어야 한다');
  if (o.podCpus === undefined) fail('entry-steps에는 --pod-cpus가 꼭 있어야 한다');
  if (!POD_CPUS.test(o.podCpus)) fail(`--pod-cpus는 0.25·0.5 또는 1~16이다: ${o.podCpus}`);
  const explicit = o.startRate !== undefined || o.stepRate !== undefined;
  if (explicit && o.x1Estimate !== undefined) fail('--x1-estimate와 --start-rate·--step-rate는 함께 줄 수 없다');
  if (!explicit && o.x1Estimate === undefined) fail('entry-steps에는 --start-rate·--step-rate나 --x1-estimate가 꼭 있어야 한다');
  if (explicit && (o.startRate === undefined || o.stepRate === undefined)) fail('--start-rate와 --step-rate는 함께 준다');
  const record = o.record ?? false;
  if (!record && (o.runIdPrefix !== undefined || o.profile !== undefined || o.promUrl !== undefined)) fail('--run-id-prefix·--profile·--prom-url은 --record와 함께만 준다');
  if (record && o.runIdPrefix === undefined) fail('--record에는 --run-id-prefix가 꼭 있어야 한다');
  if (o.runIdPrefix !== undefined && !RUN_ID_PREFIX.test(o.runIdPrefix)) fail(`--run-id-prefix 꼴이 틀렸다(YYYY-MM-DD-영소문자·숫자·-): ${o.runIdPrefix}`);
  if (o.profile !== undefined && !PROFILE.test(o.profile)) fail(`--profile 꼴이 틀렸다(local-…): ${o.profile}`);
  if (o.promUrl !== undefined) {
    const m = PROM_URL.exec(o.promUrl);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) fail(`--prom-url은 http://127.0.0.1:<포트>나 http://localhost:<포트>다: ${o.promUrl}`);
  }
  if (o.out !== undefined && o.out.length === 0) fail('--out은 비지 않은 경로다');
  const n = o.replicas;
  const maxSteps = o.maxSteps ?? STEP_DEFAULTS.maxSteps;
  const rates = explicit ? planSteps({ n, startRate: o.startRate, stepRate: o.stepRate, maxSteps }) : planSteps({ n, x1Estimate: o.x1Estimate, maxSteps });
  if (rates[rates.length - 1] > 100000) fail(`마지막 단계 도착률(${rates[rates.length - 1]}/s)이 100,000/s를 넘는다`);
  return {
    command: 'v1',
    scenario: 'entry-steps',
    replicas: n,
    podCpus: Number(o.podCpus),
    rates,
    ...(explicit ? { startRate: o.startRate, stepRate: o.stepRate } : { x1Estimate: o.x1Estimate }),
    maxSteps,
    warmS: o.warmS ?? STEP_DEFAULTS.warmS,
    mainS: o.mainS ?? STEP_DEFAULTS.mainS,
    restS: o.restS ?? STEP_DEFAULTS.restS,
    cpus: o.cpus ?? 2,
    memoryMi: o.memoryMi ?? 1024,
    record,
    invariants: o.invariants ?? false,
    ...(o.generators !== undefined ? { generators: o.generators } : {}),
    ...(o.runIdPrefix !== undefined ? { runIdPrefix: o.runIdPrefix } : {}),
    ...(o.profile !== undefined ? { profile: o.profile } : {}),
    ...(o.promUrl !== undefined ? { promUrl: o.promUrl } : {}),
    ...(o.out !== undefined ? { out: o.out } : {}),
  };
}

/**
 * 단계 도착률 목록(계획 F-08-2 6.3). 두 꼴:
 * - { n, x1Estimate, startFactor?, stepFactor?, maxSteps? }: 첫 단계 round(startFactor × n × X̂₁), 증가 round(stepFactor × n × X̂₁)(1 미만이면 1)
 * - { n, startRate, stepRate, maxSteps? }: 첫 단계 startRate, 증가 stepRate
 * rates[k] = 첫 단계 + k × 증가(k = 0 … maxSteps − 1, 엄격히 오름차순). n은 1~8 정수, X̂₁·계수는 양의 유한수, startRate·stepRate는 1 이상 정수,
 * maxSteps는 1~8 정수(기본 8)가 아니거나 두 꼴을 섞으면 RangeError
 * @param {{ n: number, x1Estimate?: number, startFactor?: number, stepFactor?: number, startRate?: number, stepRate?: number, maxSteps?: number }} o
 * @returns {number[]}
 */
export function planSteps(o) {
  if (o === null || typeof o !== 'object') throw new RangeError('단계 계획 입력이 없다');
  if (!Number.isSafeInteger(o.n) || o.n < 1 || o.n > 8) throw new RangeError(`진입 서버 수 N은 1~8 정수다: ${o.n}`);
  const maxSteps = o.maxSteps ?? STEP_DEFAULTS.maxSteps;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 8) throw new RangeError(`단계 수 상한은 1~8 정수다: ${maxSteps}`);
  const byRate = o.startRate !== undefined || o.stepRate !== undefined;
  let start;
  let step;
  if (byRate) {
    if (o.x1Estimate !== undefined) throw new RangeError('x1Estimate와 startRate·stepRate를 함께 줄 수 없다');
    if (!isPosInt(o.startRate) || !isPosInt(o.stepRate)) throw new RangeError('startRate·stepRate는 1 이상 정수다');
    start = o.startRate;
    step = o.stepRate;
  } else {
    const sf = o.startFactor ?? STEP_DEFAULTS.startFactor;
    const df = o.stepFactor ?? STEP_DEFAULTS.stepFactor;
    if (!isNum(o.x1Estimate) || o.x1Estimate <= 0) throw new RangeError(`X̂₁은 양의 유한수다: ${o.x1Estimate}`);
    if (!isNum(sf) || sf <= 0 || !isNum(df) || df <= 0) throw new RangeError('startFactor·stepFactor는 양의 유한수다');
    start = Math.max(1, Math.round(sf * o.n * o.x1Estimate));
    step = Math.max(1, Math.round(df * o.n * o.x1Estimate));
  }
  return Array.from({ length: maxSteps }, (_, k) => start + k * step);
}

/**
 * 단계 하나의 판정(계획 F-08-2 6.3 '단계 판정'): 지키려면 모두 참이어야 한다.
 * 발생기 판정 유효(valid가 true), dropped가 0, 보낸 진입 sent가 1 이상, entryP99Ms ≤ p99MaxMs, errorRate < errorRateBelow,
 * 커널 카운터 kernel.listenOverflows·listenDrops가 둘 다 0(늘지 않음, §3.5 8번). 값이 없으면(null·undefined) 지키지 않은 것이다(그 까닭을 적는다).
 * entryOverRatio(본구간 진입 가운데 p99MaxMs를 넘은 요청의 비율, k6 over_target)가 있으면 p99 조건은 그 비율 ≤ p99Allowed로 본다(같은 뜻이고,
 * 발생기를 나누면 합친 p99는 발생기별 p99의 위 한계라 쓰지 않는다. entryP99Ms는 그대로 적는다).
 * 호스트: hostTags(step.host)에 '호스트 포화'나 '호스트 지표 없음'이 있으면 SLO를 지켰어도 지킴으로 세지 않는다(계획 6.3 '포화 표시').
 * @param {{ valid?: boolean, invalidReason?: string|null, entryP99Ms?: number|null, entryOverRatio?: number|null, errorRate?: number|null, sent?: number|null, dropped?: number|null, kernel?: { listenOverflows: number|null, listenDrops: number|null } | null }} step
 * @param {{ p99MaxMs: number, errorRateBelow: number, p99Allowed?: number }} [rules]
 * @returns {{ kept: boolean, reasons: string[] }}
 */
export function judgeStep(step, rules = ENTRY_RULES) {
  const reasons = [];
  if (step === null || typeof step !== 'object') return { kept: false, reasons: ['단계 결과가 없다'] };
  if (step.valid !== true) reasons.push(`무효${step.invalidReason ? `(${step.invalidReason})` : ''}`);
  if (!Number.isSafeInteger(step.dropped)) reasons.push('dropped_iterations 값 없음');
  else if (step.dropped > 0) reasons.push(`발생기가 반복을 시작하지 못함(dropped ${step.dropped})`);
  if (!Number.isSafeInteger(step.sent) || step.sent < 1) reasons.push('보낸 진입이 없다');
  if (isNum(step.entryOverRatio)) {
    const allowed = rules.p99Allowed ?? ENTRY_RULES.p99Allowed;
    if (step.entryOverRatio > allowed) reasons.push(`진입 ${rules.p99MaxMs}ms 넘은 요청 ${step.entryOverRatio}(${allowed} 초과, p99 ${isNum(step.entryP99Ms) ? `${step.entryP99Ms}ms` : '-'})`);
  } else if (!isNum(step.entryP99Ms)) reasons.push('진입 p99 값 없음');
  else if (step.entryP99Ms > rules.p99MaxMs) reasons.push(`진입 p99 ${step.entryP99Ms}ms(${rules.p99MaxMs}ms 초과)`);
  if (!isNum(step.errorRate)) reasons.push('진입 오류율 값 없음');
  else if (!(step.errorRate < rules.errorRateBelow)) reasons.push(`진입 오류율 ${step.errorRate}(${rules.errorRateBelow} 이상)`);
  const k = step.kernel;
  if (!k || !Number.isSafeInteger(k.listenOverflows) || !Number.isSafeInteger(k.listenDrops)) reasons.push('커널 카운터 값 없음');
  else if (k.listenOverflows > 0 || k.listenDrops > 0) reasons.push(`커널 연결 버림(ListenOverflows +${k.listenOverflows}, ListenDrops +${k.listenDrops})`);
  const tags = hostTags(step.host);
  if (tags.includes(TAG_SATURATED)) reasons.push(TAG_SATURATED);
  else if (tags.includes(TAG_NO_HOST)) reasons.push(TAG_NO_HOST);
  return { kept: reasons.length === 0, reasons, tags };
}

/**
 * 호스트 표시(docs/verification.md §3.5 6번): host.cpuUtil(%) ≥ cpuUtilMaxPct이거나 procsRunning > logicalCpus면 '호스트 포화',
 * cpuAssigned > performanceThreads면 '코어 혼합'. 판정에 쓸 값(cpuUtil·procsRunning·logicalCpus)이 하나라도 없으면 '호스트 지표 없음'(포화가 아니라고 보지 않는다).
 * host.tags에 이미 있는 표시는 남긴다. 결과는 겹치지 않는 표시 목록
 * @param {{ cpuUtil?: number|null, procsRunning?: number|null, logicalCpus?: number|null, cpuAssigned?: number|null, tags?: string[] } | null | undefined} host
 * @param {{ cpuUtilMaxPct: number, performanceThreads: number }} [rules]
 * @returns {string[]}
 */
export function hostTags(host, rules = HOST_RULES) {
  const tags = new Set(Array.isArray(host?.tags) ? host.tags : []);
  const cpu = host?.cpuUtil;
  const pr = host?.procsRunning;
  const lc = host?.logicalCpus;
  if (!isNum(cpu) || !Number.isSafeInteger(pr) || !Number.isSafeInteger(lc)) tags.add(TAG_NO_HOST);
  if ((isNum(cpu) && cpu >= rules.cpuUtilMaxPct) || (Number.isSafeInteger(pr) && Number.isSafeInteger(lc) && pr > lc)) tags.add(TAG_SATURATED);
  if (isNum(host?.cpuAssigned) && host.cpuAssigned > rules.performanceThreads) tags.add(TAG_MIXED);
  return [...tags];
}

/** 계산에서 빼야 하는 표시인가(호스트 포화이거나 호스트 지표가 없음) */
const excludingTag = (tags) => (tags ?? []).find((t) => t === TAG_SATURATED || t === TAG_NO_HOST) ?? null;

/**
 * X(N) 한 번(단계 올리기 하나): 첫 단계부터 이어서 지킨(kept가 true) 단계 가운데 가장 높은 도착률. 중간 단계가 어기면 그 아래까지만 본다.
 * 첫 단계부터 어기면 null(0이 아니다). 단계는 도착률 오름차순이어야 한다(아니면 RangeError)
 * @param {Array<{ rate: number, kept: boolean }>} steps
 * @returns {number | null}
 */
export function pickX(steps) {
  if (!Array.isArray(steps)) throw new RangeError('단계 목록이 아니다');
  for (let i = 1; i < steps.length; i++) if (!(steps[i].rate > steps[i - 1].rate)) throw new RangeError('단계는 도착률 오름차순이어야 한다');
  let x = null;
  for (const s of steps) {
    if (s?.kept !== true) break;
    x = s.rate;
  }
  return x;
}

/**
 * 단계 올리기 하나의 요약: x(pickX), limitedBy(처음 지키지 않은 단계의 { index, rate, reasons, tags }, 끝까지 지켰으면 null),
 * saturated(X(N)을 정한 단계, 곧 처음 지키지 않은 단계에 호스트 포화·호스트 지표 없음 표시가 있으면 참. SLO를 함께 어겼어도 그 어김이 호스트 탓일 수 있어 X(N)을 쓰지 않는다),
 * topReached(상한 단계까지 모두 지킴: 더 높은 단계를 재야 X(N)이다)
 * @param {Array<{ rate: number, kept: boolean, reasons?: string[], host?: { tags?: string[] } }>} steps
 */
export function summarizeSweep(steps) {
  const x = pickX(steps);
  const i = steps.findIndex((s) => s?.kept !== true);
  const first = i >= 0 ? steps[i] : null;
  const tags = first?.host?.tags ?? [];
  return {
    x,
    limitedBy: first ? { index: i, rate: first.rate, reasons: [...(first.reasons ?? [])], tags: [...tags] } : null,
    saturated: Boolean(first && excludingTag(tags)),
    topReached: steps.length > 0 && i < 0,
  };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * N 하나의 점(계획 F-08-2 6.3 '반복'): sweeps는 단계 올리기 결과 목록이다(원소는 X(N) 수·null, 또는 { x, saturated?, topReached? }).
 * - 하나라도 x가 null(찾지 못함)이면 valid false('찾지 못함 k회'), 중앙값·편차는 null(통과로 세지 않는다)
 * - 아니면 x = 중앙값, spread = 최댓값 − 최솟값. 3회가 아니면 tags에 '3회 아님'
 * - 하나라도 saturated면 saturated 참과 tags에 '호스트 포화'(그 점은 E(N)·설계 식·USL에서 뺀다), topReached가 있으면 tags에 '상한 단계까지 지킴'
 * 빈 목록은 valid false
 * @param {Array<number | null | { x: number | null, saturated?: boolean, topReached?: boolean }>} sweeps
 * 결과의 median과 x는 같은 값이다(x는 점 꼴 { n, x }에 그대로 쓰려고 둔다)
 * @returns {{ median: number | null, x: number | null, spread: number | null, values: Array<number | null>, valid: boolean, saturated: boolean, tags: string[], reasons: string[] }}
 */
export function summarizeN(sweeps) {
  if (!Array.isArray(sweeps)) throw new RangeError('단계 올리기 목록이 아니다');
  const items = sweeps.map((s) => (s !== null && typeof s === 'object' ? s : { x: s }));
  const values = items.map((s) => (isNum(s.x) ? s.x : null));
  const reasons = [];
  const tags = [];
  if (items.length === 0) reasons.push('단계 올리기가 없다');
  const missing = values.filter((v) => v === null).length;
  if (missing) reasons.push(`찾지 못함 ${missing}회`);
  const saturated = items.some((s) => s.saturated === true);
  if (saturated) tags.push(TAG_SATURATED);
  if (items.some((s) => s.topReached === true)) tags.push('상한 단계까지 지킴');
  if (items.length !== 3) tags.push('3회 아님');
  const valid = reasons.length === 0;
  const xs = values.filter((v) => v !== null);
  const mid = valid ? median(xs) : null;
  return { median: mid, x: mid, spread: valid ? Math.max(...xs) - Math.min(...xs) : null, values, valid, saturated, tags, reasons };
}

/** 점이 계산에서 빠지는 까닭(없으면 null): 무효·X 없음·호스트 포화·호스트 지표 없음 */
function exclusionOf(p) {
  if (!Number.isSafeInteger(p?.n) || p.n < 1) return 'N이 없다';
  if (p.valid === false) return '무효';
  if (!isNum(p.x)) return 'X(N) 없음';
  if (p.saturated === true) return TAG_SATURATED;
  const t = excludingTag(p.tags);
  return t;
}

/** 점마다 E(N)과 빠지는 까닭(efficiency·proportionality·buildReport가 함께 쓴다). N 오름차순 */
function efficiencyRows(points, x1) {
  if (!isNum(x1) || x1 <= 0) throw new RangeError(`X₁은 양의 유한수다: ${x1}`);
  if (!Array.isArray(points)) throw new RangeError('점 목록이 아니다');
  return [...points]
    .sort((a, b) => a.n - b.n)
    .map((p) => {
      const excluded = exclusionOf(p);
      return { n: p.n, x: isNum(p.x) ? p.x : null, e: excluded ? null : p.x / (p.n * x1), excluded };
    });
}

/**
 * 비례 효율 E(N) = X(N) ÷ (N × X₁)(docs/verification.md §3.3). points = [{ n, x, valid?, saturated?, tags? }].
 * 빠지는 점(무효·X 없음·호스트 포화·호스트 지표 없음)은 points에 넣지 않고 excluded에 N과 까닭을 남긴다(장부 행은 지우지 않는다, V-T17).
 * x1이 양의 유한수가 아니면 RangeError. 결과는 N 오름차순
 * @param {Array<{ n: number, x: number | null, valid?: boolean, saturated?: boolean, tags?: string[] }>} points
 * @param {number} x1
 * @returns {{ points: Array<{ n: number, x: number, e: number }>, excluded: Array<{ n: number, reason: string }> }}
 */
export function efficiency(points, x1) {
  const rows = efficiencyRows(points, x1);
  return { points: rows.filter((r) => r.excluded === null).map((r) => ({ n: r.n, x: r.x, e: r.e })), excluded: rows.filter((r) => r.excluded !== null).map((r) => ({ n: r.n, reason: r.excluded })) };
}

/**
 * 비례 판정(docs/verification.md §3.3 '비례 확인'). x1은 rules.x1 또는 N=1 점의 x다(둘 다 없으면 RangeError).
 * 남은 점(efficiency에서 빠지지 않은 점, N=1 포함)이 rules.minPoints 미만이면 '비례 전제 확인 못 함'.
 * 아니면 가장 큰 남은 N의 E(N) ≥ rules.eMin이면 '비례 전제는 N대까지 확인', 낮으면 'E(N) 기준 미달'(USL 값을 외삽에 쓰고 원인을 찾는다).
 * 결과: { verdict(위 한국어 판정), code('confirmed'|'below'|'unconfirmed'), nMax, eAtNMax, x1, used: [{ n, x, e }], excluded: [{ n, reason }] }
 * @param {Array<{ n: number, x: number | null, valid?: boolean, saturated?: boolean, tags?: string[] }>} points
 * @param {{ eMin?: number, minPoints?: number, x1?: number }} [rules]
 */
export function proportionality(points, rules = {}) {
  const eMin = rules.eMin ?? PROPORTION_RULES.eMin;
  const minPoints = rules.minPoints ?? PROPORTION_RULES.minPoints;
  const one = (points ?? []).find((p) => p?.n === 1 && !exclusionOf(p));
  const x1 = rules.x1 ?? one?.x;
  if (!isNum(x1) || x1 <= 0) throw new RangeError('X₁(rules.x1 또는 빠지지 않은 N=1 점)이 없다');
  const { points: used, excluded } = efficiency(points, x1);
  if (used.length < minPoints) return { verdict: '비례 전제 확인 못 함', code: 'unconfirmed', nMax: used.length ? used[used.length - 1].n : null, eAtNMax: used.length ? used[used.length - 1].e : null, x1, used, excluded };
  const top = used[used.length - 1];
  const ok = top.e >= eMin;
  return { verdict: ok ? `비례 전제는 ${top.n}대까지 확인` : 'E(N) 기준 미달', code: ok ? 'confirmed' : 'below', nMax: top.n, eAtNMax: top.e, x1, used, excluded };
}

/**
 * 진입 서버 CPU 몫 고르기(계획 F-08-2 6.4, 2절 2 (가)): shares 차례(1 → 0.5 → 0.25)로, 몫 s의 X₁ 어림 = x1 × s일 때
 * 8대 점 최고 도착률 nMax × x1 × s, 발생기 G = ⌈그 값 ÷ generatorRate⌉, 필요 CPU = nMax × s + generatorCpus × G + valkeyCpus + stageCpus.
 * 필요 CPU가 dockerCpus × hostCpuMaxPct% 안(미만, 호스트 포화 문턱과 같은 값)이면 그 몫을 고른다. 어느 몫도 안 되면 podCpus null·fallback '(나)'.
 * x1·generatorRate·dockerCpus가 양의 유한수가 아니면 RangeError
 * @param {{ x1: number, generatorRate?: number, dockerCpus: number, rules?: Partial<typeof POD_CPU_RULES> }} o
 * @returns {{ podCpus: number | null, fallback: string | null, rows: Array<{ share: number, x1: number, peakRate: number, generators: number, needCpus: number, limitCpus: number, fits: boolean }> }}
 */
export function choosePodCpus(o) {
  const r = { ...POD_CPU_RULES, ...(o?.rules ?? {}) };
  const generatorRate = o?.generatorRate ?? GENERATOR_RATE;
  if (!isNum(o?.x1) || o.x1 <= 0) throw new RangeError(`X₁은 양의 유한수다: ${o?.x1}`);
  if (!isNum(generatorRate) || generatorRate <= 0) throw new RangeError(`발생기 하나 몫은 양의 유한수다: ${generatorRate}`);
  if (!isNum(o?.dockerCpus) || o.dockerCpus <= 0) throw new RangeError(`Docker CPU는 양의 유한수다: ${o?.dockerCpus}`);
  const rows = [];
  for (const share of r.shares) {
    const x1 = o.x1 * share;
    const peakRate = r.nMax * x1;
    const generators = Math.max(1, Math.ceil(peakRate / generatorRate - 1e-9));
    const needCpus = r.nMax * share + r.generatorCpus * generators + r.valkeyCpus + r.stageCpus;
    const limitCpus = (o.dockerCpus * r.hostCpuMaxPct) / 100;
    // 정수 100배로 견준다(0.85 × 32 같은 소수 오차 없이)
    const fits = Math.round(needCpus * 100) * 100 < Math.round(o.dockerCpus * 100) * r.hostCpuMaxPct;
    rows.push({ share, x1, peakRate, generators, needCpus, limitCpus, fits });
    if (fits) return { podCpus: share, fallback: null, rows };
  }
  return { podCpus: null, fallback: '(나)', rows };
}

/**
 * charts.py usl 입력 표(열 n,throughput,saturated). 빠지는 점(무효·X 없음·호스트 포화·호스트 지표 없음)은 넣지 않는다(USL 적합에서 뺀다,
 * 뺀 점과 까닭은 proportionality·efficiency 결과에 남는다). 줄은 N 오름차순, 끝에 줄바꿈
 * @param {Array<{ n: number, x: number | null, valid?: boolean, saturated?: boolean, tags?: string[] }>} points
 * @returns {string}
 */
export function uslCsv(points) {
  if (!Array.isArray(points)) throw new RangeError('점 목록이 아니다');
  const rows = [...points].sort((a, b) => a.n - b.n).filter((p) => !exclusionOf(p));
  return `n,throughput,saturated\n${rows.map((p) => `${p.n},${p.x},false`).join('\n')}${rows.length ? '\n' : ''}`;
}

/**
 * 한 단계에 쓰는 가상 대기자 수(사람마다 진입 한 번): ⌈도착률 × (예열 + 본구간)⌉ + 2(도착률 실행기는 구간마다 '도착률 × 시간 + 1'번까지 시작할 수 있다)
 * @param {number} rate @param {number} warmS @param {number} mainS
 */
export function entryUsers(rate, warmS, mainS) {
  if (!isPosInt(rate) || !isPosInt(warmS) || !isPosInt(mainS)) throw new RangeError('도착률·예열·본구간은 1 이상 정수다');
  return rate * (warmS + mainS) + 2;
}

/**
 * 준비 구간(사전 검증) 길이(초). 앞 단계의 실제 준비 시간이 있으면 도착률 비로 늘려 1.3배 + 10초, 없으면 3 × (예열 + 본구간) + 30초.
 * 20~900초로 자른다(계획 F-08-2 6.3 '준비 구간', 구현 메모 참고)
 * @param {{ rate: number, warmS: number, mainS: number, prev?: { rate: number, prepElapsedS: number | null } | null }} o
 */
export function prepSeconds(o) {
  const base = 3 * (o.warmS + o.mainS) + 30;
  const p = o.prev;
  const s = p && isNum(p.prepElapsedS) && p.prepElapsedS > 0 && isPosInt(p.rate) ? Math.ceil(p.prepElapsedS * (o.rate / p.rate) * 1.3) + 10 : base;
  return Math.min(900, Math.max(20, s));
}

/**
 * 단계 올리기의 핵심(실행 함수 주입, 계획 F-08-2 6.3·7.3 F082-9): rates를 차례로 runStep(rate, index)으로 보내고, 단계마다 judgeStep으로 kept를 정해
 * 지키지 않은 단계에서 멈춘다(다음 단계를 보내지 않는다). rest(ms)가 있으면 단계 사이에 restMs만큼 쉰다. onStep(step, index)은 단계마다 부른다.
 * 결과: { steps: [{ …runStep 결과, rate, kept, reasons, host: { …, tags } }], x(pickX), saturated, limitedBy, topReached }
 * @param {{ rates: number[], runStep: (rate: number, index: number) => Promise<Record<string, any>>, rest?: (ms: number) => Promise<void>, restMs?: number, onStep?: (step: Record<string, any>, index: number) => void }} o
 */
export async function runSweep(o) {
  if (!Array.isArray(o?.rates) || typeof o.runStep !== 'function') throw new RangeError('runSweep에는 rates와 runStep이 있어야 한다');
  const steps = [];
  for (let i = 0; i < o.rates.length; i++) {
    if (i > 0 && o.rest) await o.rest(o.restMs ?? 0);
    const rate = o.rates[i];
    const r = (await o.runStep(rate, i)) ?? {};
    const j = judgeStep({ ...r, rate });
    const step = { ...r, rate, host: { ...(r.host ?? {}), tags: j.tags }, reasons: j.reasons, kept: j.kept };
    steps.push(step);
    o.onStep?.(step, i);
    if (!step.kept) break;
  }
  return { steps, ...summarizeSweep(steps) };
}

/**
 * 단계 올리기 한 번(계획 F-08-2 6.3). a는 parseEntryStepsArgs 결과. deps:
 * - runStep({ index, attempt(0, 다시 돌면 1), rate, users, warmS, mainS, prepS, replicas, podCpus, runId? }) → 단계 결과
 *   { rate, valid, invalidReason, entryP99Ms, entryOverRatio?, errorRate, sent, dropped, kernel, host, prepElapsedS?, outDir? }(던지면 실행 전체가 실패한다)
 * - rest(ms): 단계 사이 쉼, log?(글), writeJson?(이름, 값): 실행 폴더에 쓰기
 * 판정과 멈춤은 runSweep이 한다. 준비 구간 길이는 앞 단계의 실제 준비 시간으로 정한다(prepSeconds).
 * 첫 단계부터 어기고 그 까닭이 호스트가 아니면 첫 단계를 절반으로 낮춰 한 번만 다시 돈다(계획 6.3 '찾지 못함').
 * 결과(steps.json): { n, podCpus, rates, steps, x, saturated, limitedBy, topReached, retried, firstAttempt? }
 * @param {ReturnType<typeof parseEntryStepsArgs>} a
 * @param {{ runStep: (s: Record<string, unknown>) => Promise<Record<string, any>>, rest: (ms: number) => Promise<void>, log?: (m: string) => void, writeJson?: (name: string, v: unknown) => void }} deps
 */
export async function runEntrySteps(a, deps) {
  const log = deps.log ?? (() => {});
  const sweep = async (rates, attempt) => {
    let prev = null;
    return runSweep({
      rates,
      rest: deps.rest,
      restMs: a.restS * 1000,
      runStep: async (rate, i) => {
        const prepS = prepSeconds({ rate, warmS: a.warmS, mainS: a.mainS, prev });
        const runId = a.record ? `${a.runIdPrefix}-s${i + 1}${attempt ? `-b${attempt}` : ''}` : undefined;
        log(`단계 ${i + 1}/${rates.length}: 도착률 ${rate}/s(진입 서버 ${a.replicas}대 × CPU ${a.podCpus}), 준비 ${prepS}초`);
        const r = await deps.runStep({ index: i, attempt, rate, users: entryUsers(rate, a.warmS, a.mainS), warmS: a.warmS, mainS: a.mainS, prepS, replicas: a.replicas, podCpus: a.podCpus, ...(runId ? { runId } : {}) });
        prev = { rate, prepElapsedS: isNum(r?.prepElapsedS) ? r.prepElapsedS : null };
        return r;
      },
      onStep: (step, i) => {
        deps.writeJson?.(`step-${i + 1}${attempt ? `-b${attempt}` : ''}.json`, step);
        log(`  → ${step.kept ? '지킴' : `지키지 않음(${step.reasons.join('; ')})`}`);
      },
    });
  };
  let res = await sweep(a.rates, 0);
  let first;
  let retried = false;
  const s0 = res.steps[0];
  if (s0 && !s0.kept && !s0.reasons.some((x) => x === TAG_SATURATED || x === TAG_NO_HOST) && a.rates[0] > 1) {
    const lowered = a.rates.map((r, k) => (k === 0 ? Math.max(1, Math.floor(a.rates[0] / 2)) : r)).filter((r, k, xs) => k === 0 || r > xs[k - 1]);
    log(`첫 단계부터 지키지 않았다. 첫 단계를 ${lowered[0]}/s로 낮춰 한 번만 다시 돈다`);
    first = res.steps;
    retried = true;
    await deps.rest(a.restS * 1000);
    res = await sweep(lowered, 1);
  }
  const out = { n: a.replicas, podCpus: a.podCpus, rates: a.rates, steps: res.steps, x: res.x, saturated: res.saturated, limitedBy: res.limitedBy, topReached: res.topReached, retried, ...(first ? { firstAttempt: first } : {}) };
  deps.writeJson?.('steps.json', out);
  return out;
}

// ───────────── 측정 뒤 계산(명령) ─────────────

const readSweep = (dir) => JSON.parse(readFileSync(join(resolve(dir), 'steps.json'), 'utf8'));
const sweepItem = (j) => ({ x: isNum(j.x) ? j.x : null, saturated: j.saturated === true, topReached: j.topReached === true });

/**
 * entry-scale.json 만들기: groups = [{ n, dirs }](N마다 단계 올리기 폴더들), design = 1 vCPU X₁ 폴더들(선택).
 * 결과 { podCpus, x1, x1Design, points: [{ n, …summarizeN, e, excluded, dirs }], proportionality, nMeasuredMax, generatedAt }
 * @param {{ groups: Array<{ n: number, dirs: string[] }>, design?: string[] }} o
 */
export function buildReport(o) {
  const points = o.groups.map((g) => {
    const sweeps = g.dirs.map(readSweep);
    const pods = [...new Set(sweeps.map((s) => s.podCpus))];
    if (pods.length !== 1) throw new Error(`N=${g.n}의 단계 올리기가 서로 다른 CPU 몫을 쓴다: ${pods.join(',')}`);
    if (sweeps.some((s) => s.n !== g.n)) throw new Error(`N=${g.n} 폴더에 다른 N의 결과가 있다`);
    return { n: g.n, podCpus: pods[0], ...summarizeN(sweeps.map(sweepItem)), dirs: g.dirs };
  });
  const pods = [...new Set(points.map((p) => p.podCpus))];
  if (pods.length > 1) throw new Error(`점마다 CPU 몫이 다르다: ${pods.join(',')}`);
  const design = o.design?.length ? summarizeN(o.design.map(readSweep).map(sweepItem)) : null;
  let prop = null;
  let rows = points.map((p) => ({ ...p, e: null, excluded: exclusionOf(p) }));
  try {
    prop = proportionality(points);
    const eff = efficiencyRows(points, prop.x1);
    rows = points.map((p) => ({ ...p, ...(({ e, excluded }) => ({ e, excluded }))(eff.find((r) => r.n === p.n)) }));
  } catch (e) {
    prop = { verdict: '비례 전제 확인 못 함', code: 'unconfirmed', reason: e.message, used: [], excluded: points.map((p) => ({ n: p.n, reason: exclusionOf(p) ?? 'X₁ 없음' })) };
  }
  const used = rows.filter((r) => r.excluded === null);
  return {
    podCpus: pods[0] ?? null,
    x1: prop.x1 ?? null,
    x1Design: design?.valid ? design.x : null,
    design,
    points: rows,
    proportionality: prop,
    nMeasuredMax: used.length ? Math.max(...used.map((r) => r.n)) : null,
    generatedAt: new Date().toISOString(),
  };
}

function cliValue(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new UsageError(`${name} 뒤에 값이 없다`);
  return v;
}

const USAGE = [
  '쓰는 법:',
  '  node loadtest/runner/entry-scale.mjs choose --x1 <X₁(1 vCPU 중앙값)> --docker-cpus <Docker CPU> [--generator-rate 800]',
  '  node loadtest/runner/entry-scale.mjs report --point <N>=<폴더>,<폴더>,<폴더> [--point …] [--design <폴더>,…] --out <폴더>',
  '    (폴더마다 run.mjs v1 entry-steps의 steps.json. 결과 <폴더>/entry-scale.json·usl.csv)',
].join('\n');

export function main(argv) {
  const cmd = argv[0];
  if (cmd === 'choose') {
    const x1 = Number(cliValue(argv, '--x1'));
    const dockerCpus = Number(cliValue(argv, '--docker-cpus'));
    const g = cliValue(argv, '--generator-rate');
    const r = choosePodCpus({ x1, dockerCpus, ...(g !== undefined ? { generatorRate: Number(g) } : {}) });
    console.log(JSON.stringify(r, null, 2));
    return 0;
  }
  if (cmd === 'report') {
    const groups = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] !== '--point') continue;
      const m = /^([1-8])=(.+)$/.exec(argv[i + 1] ?? '');
      if (!m) throw new UsageError(`--point는 <N>=<폴더>,…다: ${argv[i + 1] ?? '(없음)'}`);
      groups.push({ n: Number(m[1]), dirs: m[2].split(',').filter(Boolean) });
    }
    if (!groups.length) throw new UsageError('report에는 --point가 하나 이상 있어야 한다');
    const out = cliValue(argv, '--out');
    if (!out) throw new UsageError('report에는 --out이 꼭 있어야 한다');
    const design = cliValue(argv, '--design');
    const rep = buildReport({ groups, ...(design ? { design: design.split(',').filter(Boolean) } : {}) });
    mkdirSync(resolve(out), { recursive: true });
    writeFileSync(join(resolve(out), 'entry-scale.json'), `${JSON.stringify(rep, null, 2)}\n`);
    writeFileSync(join(resolve(out), 'usl.csv'), uslCsv(rep.points));
    console.log(`비례 판정: ${rep.proportionality.verdict}(X₁ ${rep.x1 ?? '-'}, 뺀 점 ${rep.proportionality.excluded.map((e) => `N=${e.n} ${e.reason}`).join(', ') || '없음'})`);
    console.log(`적었다: ${join(resolve(out), 'entry-scale.json')}, usl.csv`);
    return 0;
  }
  throw new UsageError(`명령은 choose·report다: ${cmd ?? '(없음)'}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`loadtest/runner/entry-scale.mjs: ${e.message}`);
    if (e instanceof UsageError) console.error(USAGE);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  }
}
