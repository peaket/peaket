// 진입 서버 비례 확인(MSR-020) 판정 함수 시험: loadtest/runner/entry-scale.mjs와 run.mjs v1 entry-steps 인자.
// 계획 docs/review/plans/F-08-2.md 6.3·6.4·7.2·7.3(F082-1~5·F082-9, V-T17 ①②). 정본 값은 docs/verification.md §3.3·§3.5다.
// 단언 값은 정본·계획의 식으로 손으로 셈했다. 코드 상수를 가져오지 않는다.
// 클러스터·Docker를 건드리지 않는다. run.mjs를 띄우는 시험은 인자 오류만 주고(클러스터 앞에서 끝나야 한다) PATH를 비워 kubectl을 못 찾게 한다.
// 실행: node --test loadtest/test/entry-scale.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const RUN = join(here, '..', 'run.mjs');

/** 새 모듈은 시험마다 불러 구현 전 트리에서 시험마다 따로 실패하게 한다 */
const scale = () => import('../runner/entry-scale.mjs');
const metrics = () => import('../runner/host-metrics.mjs');

/** 정본 값(docs/verification.md §3.3·§3.5). 코드 상수가 아니라 정본 글에서 옮긴 값이다 */
const NFR001_P99_MS = 200; // §3.3: p99 200ms 이하
const NFR001_ERROR_RATE = 0.001; // §3.3: 오류율 0.1% 미만
// §3.5 6번: 호스트 CPU 85% 이상이거나 procs_running이 논리 프로세서 수를 넘으면 '호스트 포화'(아래 85%·84.9% 표본)
// §3.3 '비례 확인': 포화 안 된 가장 큰 N에서 E(N) 0.9 이상이면 확인(아래 E(6) = 0.9 정각·0.8998 표본)
const SATURATED = '호스트 포화';
const MIXED = '코어 혼합';

/** /proc/stat 글: 앞 표본은 고정, 뒤 표본은 cpu 줄의 busy·idle만 늘린다(iowait·steal·guest는 0이라 셈 방식이 갈리지 않는다) */
function procStatPair({ busyDelta, idleDelta, procsRunning, cpus }) {
  const lines = (user, idle) => [
    `cpu  ${user} 0 0 ${idle} 0 0 0 0 0 0`,
    ...Array.from({ length: cpus }, (_, i) => `cpu${i} 0 0 0 0 0 0 0 0 0 0`),
    'ctxt 1000',
    `procs_running ${procsRunning}`,
    'procs_blocked 0',
    '',
  ].join('\n');
  return [lines(100000, 900000), lines(100000 + busyDelta, 900000 + idleDelta)];
}

/** 호스트 지표(steps.json의 host 꼴, 계획 7.2). CPU 사용률은 host-metrics의 셈으로 만들어 단위(비율·백분율)를 hostTags와 맞춘다 */
async function hostOf({ busyDelta, idleDelta, procsRunning, cpus, cpuAssigned = 6 }) {
  const m = await metrics();
  const [a, b] = procStatPair({ busyDelta, idleDelta, procsRunning, cpus });
  const pa = m.parseProcStat(a);
  const pb = m.parseProcStat(b);
  return { cpuUtil: m.cpuUtilBetween(pa, pb), procsRunning: pb.procsRunning, logicalCpus: pb.logicalCpus, throttle: {}, cpuAssigned, tags: [] };
}

/** 지키는 단계 하나(steps.json의 단계 꼴). 바꿀 칸만 덮어 쓴다 */
async function goodStep(over = {}) {
  return {
    rate: 1200,
    valid: true,
    invalidReason: null,
    entryP99Ms: 120,
    errorRate: 0,
    sent: 36000,
    dropped: 0,
    kernel: { listenOverflows: 0, listenDrops: 0 },
    host: await hostOf({ busyDelta: 400, idleDelta: 600, procsRunning: 4, cpus: 32 }),
    ...over,
  };
}

/** judgeStep 결과에서 '지킴'을 꺼낸다. 계획 7.2는 반환 꼴을 정하지 않아 참·거짓 또는 { kept }를 받는다(그 밖의 꼴은 실패) */
function keptOf(r) {
  if (typeof r === 'boolean') return r;
  assert.ok(r && typeof r === 'object' && typeof r.kept === 'boolean', `judgeStep 결과에 kept(참·거짓)가 없다: ${JSON.stringify(r)}`);
  return r.kept;
}

/** UsageError(이름으로 본다)로 거부하는지. 메시지는 한국어이고 문제의 인자 이름을 담는다 */
function expectUsage(fn, flagRe) {
  assert.throws(fn, (e) => {
    assert.equal(e?.name, 'UsageError', `UsageError가 아니다: ${e?.name}: ${e?.message}`);
    assert.match(e.message, /[가-힣]/);
    if (flagRe) assert.match(e.message, flagRe);
    return true;
  });
}

const ENTRY_OK = ['--replicas', '4', '--pod-cpus', '0.5', '--start-rate', '1400', '--step-rate', '280'];

// ─────────────── F082-1 인자 검사와 단계 목록 ───────────────

test('F082-1 ① parseEntryStepsArgs는 기본값이 계획 12절 4(단계 상한 8·예열 10초·본구간 30초·쉼 20초)이고 준 값을 그대로 돌려준다', async () => {
  const { parseEntryStepsArgs } = await scale();
  const a = parseEntryStepsArgs([...ENTRY_OK]);
  assert.equal(a.replicas, 4);
  assert.equal(a.podCpus, 0.5);
  assert.equal(a.startRate, 1400);
  assert.equal(a.stepRate, 280);
  assert.equal(a.maxSteps, 8);
  assert.equal(a.warmS, 10);
  assert.equal(a.mainS, 30);
  assert.equal(a.restS, 20);
  assert.equal(a.record, false);
  const b = parseEntryStepsArgs([...ENTRY_OK, '--max-steps', '5', '--warm', '15', '--main', '40', '--rest', '25', '--record', '--run-id-prefix', '2026-11-26-msr020-n4-c05-r1', '--out', '.cache/x']);
  assert.deepEqual([b.maxSteps, b.warmS, b.mainS, b.restS, b.record, b.runIdPrefix, b.out], [5, 15, 40, 25, true, '2026-11-26-msr020-n4-c05-r1', '.cache/x']);
  // 계획 6.4가 고르는 CPU 몫 셋
  for (const c of ['1', '0.5', '0.25']) assert.equal(parseEntryStepsArgs(['--replicas', '1', '--pod-cpus', c, '--start-rate', '500', '--step-rate', '100']).podCpus, Number(c));
});

test('F082-1 ② parseEntryStepsArgs는 빠진 값·빈 값·0·음수·수가 아닌 값·단계 상한 넘음·--record 없는 접두를 거부한다', async () => {
  const { parseEntryStepsArgs } = await scale();
  const without = (flag) => {
    const i = ENTRY_OK.indexOf(flag);
    return [...ENTRY_OK.slice(0, i), ...ENTRY_OK.slice(i + 2)];
  };
  const set = (flag, v) => ENTRY_OK.map((x, i) => (ENTRY_OK[i - 1] === flag ? v : x));
  for (const f of ['--replicas', '--pod-cpus', '--start-rate', '--step-rate']) expectUsage(() => parseEntryStepsArgs(without(f)), new RegExp(f));
  for (const [f, v] of [
    ['--replicas', '0'],
    ['--replicas', '9'],
    ['--replicas', '-2'],
    ['--replicas', '2.5'],
    ['--pod-cpus', '0'],
    ['--pod-cpus', '-0.5'],
    ['--pod-cpus', 'abc'],
    ['--start-rate', '0'],
    ['--start-rate', '-100'],
    ['--start-rate', ''],
    ['--step-rate', '0'],
    ['--step-rate', 'x1'],
  ]) expectUsage(() => parseEntryStepsArgs(set(f, v)), new RegExp(f));
  // 값 자리에 다음 인자가 온 것(순서 틀림)
  expectUsage(() => parseEntryStepsArgs(['--replicas', '4', '--pod-cpus', '--start-rate', '1400', '--step-rate', '280']), /--pod-cpus/);
  expectUsage(() => parseEntryStepsArgs([...ENTRY_OK, '--max-steps', '9']), /--max-steps/);
  expectUsage(() => parseEntryStepsArgs([...ENTRY_OK, '--max-steps', '0']), /--max-steps/);
  expectUsage(() => parseEntryStepsArgs([...ENTRY_OK, '--run-id-prefix', '2026-11-26-msr020-n4']), /--record|--run-id-prefix/);
  expectUsage(() => parseEntryStepsArgs([...ENTRY_OK, '--replicas', '3']), /--replicas/);
  expectUsage(() => parseEntryStepsArgs([...ENTRY_OK, '--users', '1000']), /--users/);
});

test('F082-1 ③ planSteps는 첫 단계 startFactor × N × X̂₁, 그다음 stepFactor × N × X̂₁씩 올리고 maxSteps개에서 멈춘다', async () => {
  const { planSteps } = await scale();
  const rates = (r) => r.map((s) => (typeof s === 'number' ? s : s.rate));
  // 계획 6.3: 0.5 × 3 × 700 = 1,050, 0.1 × 3 × 700 = 210씩
  assert.deepEqual(rates(planSteps({ n: 3, x1Estimate: 700, startFactor: 0.5, stepFactor: 0.1, maxSteps: 5 })), [1050, 1260, 1470, 1680, 1890]);
  // 상한 8(계획 6.3 '단계 수 상한 8'): 0.5 × 1 × 900 = 450, 90씩
  assert.deepEqual(rates(planSteps({ n: 1, x1Estimate: 900, startFactor: 0.5, stepFactor: 0.1, maxSteps: 8 })), [450, 540, 630, 720, 810, 900, 990, 1080]);
  for (const bad of [{ maxSteps: 9 }, { maxSteps: 0 }, { n: 0 }, { x1Estimate: 0 }, { x1Estimate: -5 }, { stepFactor: 0 }, { startFactor: -0.5 }]) {
    assert.throws(() => planSteps({ n: 2, x1Estimate: 800, startFactor: 0.5, stepFactor: 0.1, maxSteps: 4, ...bad }), RangeError, JSON.stringify(bad));
  }
});

// ─────────────── F082-2 단계 판정 ───────────────

test('F082-2 ① judgeStep: 진입 p99가 정본 200ms 정각이면 지키고 조금 넘으면 지키지 않는다', async () => {
  const { judgeStep } = await scale();
  assert.equal(keptOf(judgeStep(await goodStep({ entryP99Ms: NFR001_P99_MS }))), true);
  assert.equal(keptOf(judgeStep(await goodStep({ entryP99Ms: NFR001_P99_MS + 0.5 }))), false);
});

test('F082-2 ② judgeStep: 오류율은 0.1% 바로 아래면 지키고 0.1% 정각이면 지키지 않는다(정본은 "0.1% 미만")', async () => {
  const { judgeStep } = await scale();
  assert.equal(keptOf(judgeStep(await goodStep({ errorRate: NFR001_ERROR_RATE - 0.00001 }))), true);
  assert.equal(keptOf(judgeStep(await goodStep({ errorRate: NFR001_ERROR_RATE }))), false);
});

test('F082-2 ③ judgeStep: 놓친 반복 1건·발생기 무효·커널 연결 버림 1건 증가면 지키지 않는다(§3.5 2·3·8번)', async () => {
  const { judgeStep } = await scale();
  assert.equal(keptOf(judgeStep(await goodStep({ dropped: 1 }))), false, 'dropped 1');
  assert.equal(keptOf(judgeStep(await goodStep({ valid: false, invalidReason: '발생기 CPU 80% 넘음' }))), false, 'valid false');
  assert.equal(keptOf(judgeStep(await goodStep({ kernel: { listenOverflows: 1, listenDrops: 0 } }))), false, 'ListenOverflows +1');
  assert.equal(keptOf(judgeStep(await goodStep({ kernel: { listenOverflows: 0, listenDrops: 1 } }))), false, 'ListenDrops +1');
});

test('F082-2 ④ judgeStep: 결과가 없으면(p99·오류율·커널 카운터 모름) 지킴으로 세지 않는다(빈 결과가 통과로 새지 않는다)', async () => {
  const { judgeStep } = await scale();
  assert.equal(keptOf(judgeStep(await goodStep({ entryP99Ms: null }))), false, 'p99 null');
  assert.equal(keptOf(judgeStep(await goodStep({ errorRate: null }))), false, 'errorRate null');
  assert.equal(keptOf(judgeStep(await goodStep({ sent: 0 }))), false, 'sent 0');
  assert.equal(keptOf(judgeStep(await goodStep({ kernel: { listenOverflows: null, listenDrops: null } }))), false, '커널 카운터 모름');
});

test('V-T17 ① judgeStep: 호스트 포화인 단계는 SLO를 지켰어도 지킴으로 세지 않는다(계획 6.3 포화 표시)', async () => {
  const { judgeStep } = await scale();
  const host = await hostOf({ busyDelta: 950, idleDelta: 50, procsRunning: 4, cpus: 32 });
  assert.equal(keptOf(judgeStep(await goodStep({ host: { ...host, tags: [SATURATED] } }))), false);
});

// ─────────────── V-T17 ① 호스트 포화·코어 혼합 표시 ───────────────

test('V-T17 ① hostTags: 호스트 CPU가 정본 문턱 85% 정각이면 호스트 포화, 84.9%면 붙이지 않는다', async () => {
  const { hostTags } = await scale();
  const at = await hostOf({ busyDelta: 850, idleDelta: 150, procsRunning: 4, cpus: 32 });
  const below = await hostOf({ busyDelta: 849, idleDelta: 151, procsRunning: 4, cpus: 32 });
  assert.ok(hostTags(at).includes(SATURATED), `85%: ${JSON.stringify(hostTags(at))}`);
  assert.ok(!hostTags(below).includes(SATURATED), `84.9%: ${JSON.stringify(hostTags(below))}`);
});

test('V-T17 ① hostTags: 실행을 기다리는 프로세스가 논리 프로세서 수와 같으면 붙이지 않고 하나 넘으면 호스트 포화다', async () => {
  const { hostTags } = await scale();
  const equal = await hostOf({ busyDelta: 300, idleDelta: 700, procsRunning: 16, cpus: 16 });
  const over = await hostOf({ busyDelta: 300, idleDelta: 700, procsRunning: 17, cpus: 16 });
  assert.equal(equal.logicalCpus, 16);
  assert.ok(!hostTags(equal).includes(SATURATED), JSON.stringify(hostTags(equal)));
  assert.ok(hostTags(over).includes(SATURATED), JSON.stringify(hostTags(over)));
});

test('V-T17 ① hostTags: 준 CPU 합이 고성능 코어 수를 넘으면 코어 혼합, 넘지 않으면 붙이지 않는다(코어 혼합은 포화가 아니다)', async () => {
  const { hostTags } = await scale();
  const mixed = await hostOf({ busyDelta: 300, idleDelta: 700, procsRunning: 4, cpus: 32, cpuAssigned: 20 });
  const fits = await hostOf({ busyDelta: 300, idleDelta: 700, procsRunning: 4, cpus: 32, cpuAssigned: 6 });
  assert.deepEqual(hostTags(mixed), [MIXED]);
  assert.deepEqual(hostTags(fits), []);
});

// ─────────────── F082-3 X(N) 고르기 ───────────────

/** 단계 하나: kept와 그에 맞는 지표를 함께 적는다(pickX가 kept를 읽든 다시 판정하든 같은 답이 나오게) */
const st = (rate, kept) => ({ rate, kept, valid: true, invalidReason: null, entryP99Ms: kept ? 140 : 260, errorRate: 0, sent: rate * 30, dropped: 0, kernel: { listenOverflows: 0, listenDrops: 0 }, host: { tags: [] } });

test('F082-3 ① pickX: 모두 지키면 가장 높은 단계, 중간 단계가 어기면 그 아래 단계까지만 본다(위에서 다시 지켜도 세지 않는다)', async () => {
  const { pickX } = await scale();
  assert.equal(pickX([st(500, true), st(600, true), st(700, true), st(800, true)]), 800);
  assert.equal(pickX([st(500, true), st(600, true), st(700, false), st(800, true)]), 600);
  assert.equal(pickX([st(500, true), st(600, false)]), 500);
});

test('F082-3 ② pickX: 첫 단계부터 어기거나 단계가 없으면 null이다(0이 아니다)', async () => {
  const { pickX } = await scale();
  assert.strictEqual(pickX([st(500, false), st(600, true)]), null);
  assert.strictEqual(pickX([]), null);
});

// ─────────────── F082-4 N마다 3회 중앙값 ───────────────

const sweep = (x) => ({ n: 4, podCpus: 0.5, steps: [], x });

test('F082-4 ① summarizeN: 세 값의 중앙값과 편차(최댓값 − 최솟값)를 낸다', async () => {
  const { summarizeN } = await scale();
  const s = summarizeN([sweep(2100), sweep(1900), sweep(2350)]);
  assert.equal(s.median, 2100);
  assert.equal(s.spread, 450);
  assert.equal(s.valid, true);
});

test('F082-4 ② summarizeN: 셋 가운데 하나라도 찾지 못함(null)이면 그 N은 무효이고 중앙값을 내지 않는다(0으로 세지 않는다)', async () => {
  const { summarizeN } = await scale();
  const s = summarizeN([sweep(2100), sweep(null), sweep(2350)]);
  assert.equal(s.valid, false);
  assert.strictEqual(s.median, null);
});

// ─────────────── F082-5 CPU 몫 고르기 ───────────────
// 계획 6.4: G = ⌈8 × X₁ ÷ 발생기 몫⌉, 필요 CPU = 8 × 몫 + 2 × G + Valkey 2 + 무대 나머지 4, Docker CPU의 85% '안'(85% 이상은 호스트 포화, §3.5 6번)

/** choosePodCpus 결과에서 몫을 꺼낸다. (나)로 가면 null. 계획 7.2는 반환 꼴을 정하지 않아 수 또는 { podCpus }를 받는다 */
function podOf(r) {
  if (r === null || typeof r === 'number') return r;
  assert.ok(r && typeof r === 'object' && Object.hasOwn(r, 'podCpus'), `choosePodCpus 결과에 podCpus가 없다: ${JSON.stringify(r)}`);
  return r.podCpus;
}

test('F082-5 ① choosePodCpus: 필요 CPU가 문턱 바로 아래면 1, 문턱 위면 0.5, 그다음 0.25, 0.25도 넘으면 (나)(null)', async () => {
  const { choosePodCpus } = await scale();
  // X₁ = 50, 발생기 몫 800 → G = ⌈400 ÷ 800⌉ = 1. 필요 CPU = 8 × 몫 + 2 + 2 + 4 → 1: 16, 0.5: 12, 0.25: 10
  const pick = (dockerCpus) => podOf(choosePodCpus({ x1: 50, generatorRate: 800, dockerCpus }));
  assert.equal(pick(19), 1); // 문턱 16.15 > 16
  assert.equal(pick(18), 0.5); // 문턱 15.3 < 16, 12 < 15.3
  assert.equal(pick(15), 0.5); // 문턱 12.75 > 12
  assert.equal(pick(14), 0.25); // 문턱 11.9 < 12, 10 < 11.9
  assert.equal(pick(12), 0.25); // 문턱 10.2 > 10
  assert.strictEqual(pick(11), null); // 문턱 9.35 < 10 → (나)
});

test('F082-5 ② choosePodCpus: 발생기 CPU(2 × G)를 넣어 셈하고, 필요 CPU가 문턱 정각이면 들어가지 않는다', async () => {
  const { choosePodCpus } = await scale();
  // X₁ = 1,000, 발생기 몫 800 → G = 10. 1 vCPU 필요 CPU = 8 + 20 + 2 + 4 = 34
  const pick = (dockerCpus) => podOf(choosePodCpus({ x1: 1000, generatorRate: 800, dockerCpus }));
  assert.equal(pick(41), 1); // 문턱 34.85 > 34
  assert.equal(pick(40), 0.5); // 문턱 34 = 34 → 85% 정각은 포화라 들어가지 않는다
});

// ─────────────── V-T17 ② 포화 점 빼기(E(N)·비례 판정·USL 표) ───────────────

// X₁ = 900. E(2)=0.98, E(3)=0.95, E(4)=0.93, E(6)=4,860 ÷ 5,400 = 0.9(정각), E(8)=5,000 ÷ 7,200 ≈ 0.694(포화 점)
const pt = (n, x, saturated = false) => ({ n, x, tags: saturated ? [SATURATED] : [] });
const POINTS = [pt(1, 900), pt(2, 1764), pt(3, 2565), pt(4, 3348), pt(6, 4860), pt(8, 5000, true)];

test('V-T17 ② efficiency: 포화한 8대 점은 E(N)에서 빠지고 뺀 점과 까닭(호스트 포화)이 결과에 남는다', async () => {
  const { efficiency } = await scale();
  const r = efficiency(POINTS, 900);
  const byN = Object.fromEntries(r.points.map((p) => [p.n, p.e]));
  assert.deepEqual(Object.keys(byN).map(Number).sort((a, b) => a - b), [1, 2, 3, 4, 6]);
  assert.equal(byN[1], 1);
  assert.ok(Math.abs(byN[2] - 0.98) < 1e-9, String(byN[2]));
  assert.ok(Math.abs(byN[6] - 0.9) < 1e-9, String(byN[6]));
  assert.equal(r.excluded.length, 1);
  assert.equal(r.excluded[0].n, 8);
  assert.match(String(r.excluded[0].reason), /호스트 포화/);
});

test('V-T17 ② proportionality: 포화 점을 뺀 가장 큰 N(6)에서 E가 0.9 정각이면 "비례 전제는 6대까지 확인"이다(포화 점을 넣으면 0.69라 확인되지 않는다)', async () => {
  const { proportionality } = await scale();
  const r = proportionality(POINTS);
  assert.match(r.verdict, /비례 전제는 6대까지 확인/);
  assert.equal(r.nMax, 6);
  assert.deepEqual(r.excluded.map((e) => e.n), [8]);
});

test('V-T17 ② proportionality: 가장 큰 N의 E가 0.9 바로 아래면 확인이 아니다', async () => {
  const { proportionality } = await scale();
  const low = POINTS.map((p) => (p.n === 6 ? pt(6, 4859) : p)); // 4,859 ÷ 5,400 ≈ 0.8998
  const r = proportionality(low);
  assert.equal(r.nMax, 6);
  assert.doesNotMatch(r.verdict, /확인$|까지 확인/);
  assert.doesNotMatch(r.verdict, /확인 못 함/);
});

test('V-T17 ② proportionality: 포화 점을 빼고 남은 점이 3개 미만이면 "비례 전제 확인 못 함"이다', async () => {
  const { proportionality } = await scale();
  const r = proportionality([pt(1, 900), pt(2, 1764), pt(3, 2565, true), pt(4, 3348, true), pt(6, 4860, true), pt(8, 5000, true)]);
  assert.match(r.verdict, /비례 전제 확인 못 함/);
  assert.deepEqual(r.excluded.map((e) => e.n).sort((a, b) => a - b), [3, 4, 6, 8]);
});

test('V-T17 ② uslCsv: charts.py usl 표(n,throughput)에 포화 점이 맞춤 대상으로 들어가지 않는다(빼거나 saturated=true로 적는다)', async () => {
  const { uslCsv } = await scale();
  const text = uslCsv(POINTS);
  const [head, ...rows] = text.trim().split(/\r?\n/);
  const cols = head.split(',');
  assert.ok(cols.includes('n') && cols.includes('throughput'), head);
  const recs = rows.map((r) => Object.fromEntries(r.split(',').map((v, i) => [cols[i], v])));
  const fit = recs.filter((r) => String(r.saturated ?? 'false').toLowerCase() !== 'true');
  assert.deepEqual(fit.map((r) => [Number(r.n), Number(r.throughput)]), [[1, 900], [2, 1764], [3, 2565], [4, 3348], [6, 4860]]);
  for (const r of recs.filter((x) => Number(x.n) === 8)) assert.equal(String(r.saturated).toLowerCase(), 'true', '8대 줄이 남으면 saturated=true여야 한다');
});

// ─────────────── F082-9 run.mjs v1 entry-steps ───────────────

/** run.mjs를 인자만 바꿔 띄운다. PATH를 비우고 KUBECONFIG를 없는 파일로 둬 인자 검사보다 먼저 클러스터를 건드리면 종료 코드 2가 아니게 한다 */
function runCli(args) {
  const dir = mkdtempSync(join(tmpdir(), 'f082-cli-'));
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^path$/i.test(k)));
    env.KUBECONFIG = join(dir, 'none');
    const r = spawnSync(process.execPath, [RUN, ...args], { encoding: 'utf8', env, timeout: 60_000, windowsHide: true });
    return { code: r.status, err: `${r.stderr ?? ''}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('F082-9 ① run.mjs v1 entry-steps의 인자 오류는 클러스터를 건드리기 전에 종료 코드 2와 그 인자 이름으로 끝난다', () => {
  for (const [args, re] of [
    [['v1', 'entry-steps', '--replicas', '0', '--pod-cpus', '1', '--start-rate', '500', '--step-rate', '100'], /--replicas/],
    [['v1', 'entry-steps', '--replicas', '2', '--pod-cpus', '1', '--start-rate', '-1', '--step-rate', '100'], /--start-rate/],
    [['v1', 'entry-steps', '--replicas', '2', '--pod-cpus', '1', '--start-rate', '500'], /--step-rate/],
    [['v1', 'entry-steps', '--replicas', '2', '--pod-cpus', '1', '--start-rate', '500', '--step-rate', '100', '--max-steps', '12'], /--max-steps/],
  ]) {
    const r = runCli(args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.err}`);
    assert.match(r.err, re, r.err);
    assert.doesNotMatch(r.err, /kubectl|ENOENT/);
  }
});

// 계획 7.2에 이름이 없어 가정한 꼴: entry-scale.mjs의 runSweep({ rates, runStep }) → { steps(kept 포함), x }.
// runStep(rate, index)는 단계 하나를 보내고 그 결과(steps.json 단계 꼴)를 돌려주는 주입 함수다(계획 7.3 F082-9 '실행 함수 주입').
test('F082-9 ② runSweep: 단계가 어기면 다음 단계를 보내지 않고 X는 그 아래 단계다(가정한 이름)', async () => {
  const { runSweep } = await scale();
  const sent = [];
  const results = { 500: await goodStep({ rate: 500 }), 600: await goodStep({ rate: 600, entryP99Ms: 260 }), 700: await goodStep({ rate: 700 }) };
  const r = await runSweep({
    rates: [500, 600, 700],
    runStep: async (rate) => {
      sent.push(rate);
      return results[rate];
    },
  });
  assert.deepEqual(sent, [500, 600]);
  assert.equal(r.x, 500);
  assert.deepEqual(r.steps.map((s) => [s.rate, s.kept]), [[500, true], [600, false]]);
});

test('F082-9 ③ runSweep: 첫 단계부터 어기면 한 단계만 보내고 X는 null이다(가정한 이름)', async () => {
  const { runSweep } = await scale();
  const sent = [];
  const r = await runSweep({
    rates: [500, 600],
    runStep: async (rate) => {
      sent.push(rate);
      return goodStep({ rate, dropped: 3 });
    },
  });
  assert.deepEqual(sent, [500]);
  assert.strictEqual(r.x, null);
});
