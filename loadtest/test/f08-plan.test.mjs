// F-08 측정 창 실행 계획 시험(F088-1~4): loadtest/plan/f08-plan.json과 bat025-plan.mjs --plan.
// 계획 docs/review/plans/F-08-8.md 6.1~6.3·7.1~7.3, 조건의 정본은 docs/verification.md §3.10 'K별 실행' 표와 'v1 합본의 K7 ② 조건'이다.
// 정본 값은 이 파일에 적고 계획 파일과 견준다(계획 파일·코드 상수를 가져오지 않는다). 발생기 수의 최고 도착률만 계획 7.3대로 lib/model.mjs로 셈한다.
// 이 시험은 아무 측정도 돌리지 않는다. --plan 시험은 저장소 .cache 아래 고유 폴더에 상태 파일을 쓰고 끝나면 지운다.
// 실행: node --test loadtest/test/f08-plan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from '../runner/args.mjs';
import { pollStages } from '../lib/model.mjs';
import { fill, loadPlan, validatePlan } from '../plan/bat025-plan.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const PLAN_FILE = join(ROOT, 'loadtest', 'plan', 'f08-plan.json');
const TOOL = join(ROOT, 'loadtest', 'plan', 'bat025-plan.mjs');
const STATE = { day: '2026-11-26', suffix: '' };

/** 발생기 하나에 800/s(F-08-8 계획 2절 4, 추천 적용 2026-11-23) */
const PER_GENERATOR = 800;
/** run.mjs가 --generators 없이 나누는 기준(§3.10 '발생기 나누기' 1,000/s) */
const DEFAULT_PER_GENERATOR = 1000;

const readPlan = () => JSON.parse(readFileSync(PLAN_FILE, 'utf8'));

/** 실행 하나의 명령을 {day}·{suffix}를 채워 꺼낸다 */
const cmds = (run) => fill(run, STATE).commands.map((c) => c.argv);
const isRunMjs = (argv) => argv[0] === 'node' && argv[1] === 'loadtest/run.mjs';
const isCluster = (argv, sub) => argv[0] === 'node' && argv[1] === 'tools/local/cluster.mjs' && (sub === undefined || argv[2] === sub);

/** 측정 실행을 나눈다: K1·K2·K7 ①·K7 ②·MSR-020. 한 실행에 측정 명령은 하나라고 본다(둘이면 실패) */
function classify(plan) {
  const out = { k1: [], k2hot: [], k2spread: [], k7a: [], k7b: [], entry: [], other: [] };
  plan.runs.forEach((run, index) => {
    const argvs = cmds(run);
    const meas = argvs.filter((a) => isRunMjs(a) && a[2] === 'v1');
    assert.ok(meas.length <= 1, `${run.key}: v1 측정 명령이 ${meas.length}개다`);
    if (meas.length === 0) {
      out.other.push({ run, index });
      return;
    }
    const argv = meas[0];
    if (argv[3] === 'entry-steps') {
      out.entry.push({ run, index, argv });
      return;
    }
    const a = parseArgs(argv.slice(2));
    const i = argvs.indexOf(argv);
    const before = argvs.slice(0, i);
    const after = argvs.slice(i + 1);
    const tlsOff = before.some((c) => isCluster(c, 'v1') && c.join(' ').includes('--redis-tls off'));
    const item = { run, index, argv, a, before, after, tlsOff };
    if (a.scenario === 'queue') out.k1.push(item);
    else if (a.scenario === 'seat-hold') (a.mode === 'hot' ? out.k2hot : out.k2spread).push(item);
    else if (a.scenario === 'payment') (a.killAppAtS !== undefined ? out.k7b : out.k7a).push(item);
  });
  return out;
}

/** run.mjs v1과 같은 최고 도착률(계획 7.3 F088-3: lib/model.mjs의 같은 계산). queue는 진입과 조회 단계 가운데 가장 큰 값 */
function peakRate(a) {
  if (a.scenario === 'queue') {
    const entryS = Math.ceil(a.users / a.entryRate);
    const q = { users: a.users, entryRate: a.entryRate, admitPerSecond: a.admitPerSecond };
    const plan = [pollStages({ ...q, startS: entryS, durationS: a.warmS }), pollStages({ ...q, startS: entryS + a.warmS, durationS: a.mainS })];
    return Math.max(a.entryRate, ...plan.flatMap((p) => [p.startRate, ...p.stages.map((s) => s.target)]));
  }
  if (a.scenario === 'seat-hold') return a.rate * (a.keep ? 1 : 2);
  return a.rate;
}

// ─────────────── F088-1 계획 파일 꼴 ───────────────

test('F088-1 ① f08-plan.json은 계획 도구의 모양 검사를 지나고, 상태 파일은 .cache/peaket-f08/state.json이며 실행마다 명령·판정 자리·예상 시간이 있다', () => {
  const plan = readPlan();
  validatePlan(plan);
  assert.equal(plan.state_file, '.cache/peaket-f08/state.json');
  for (const r of plan.runs) {
    assert.ok(Array.isArray(r.criteria) && r.criteria.length > 0 && r.criteria.every((c) => typeof c === 'string' && c.trim()), `${r.key}: criteria(판정 자리)가 없다`);
    assert.ok(r.estimate_min > 0, `${r.key}: 예상 시간이 0이다`);
    for (const k of ['conditions', 'ledger', 'artifact']) assert.ok(typeof r[k] === 'string' && r[k].trim(), `${r.key}: ${k}가 없다`);
  }
});

test('F088-1 ② 측정 실행의 판정 자리는 정본의 시험 ID를 가리킨다(K1 Q-T2, K2 S-T1, K7 ① NFR-006, K7 ② P-T1, MSR-020 F-08-2 6.3)', () => {
  const c = classify(readPlan());
  const crit = (x) => x.run.criteria.join(' ');
  for (const x of c.k1) assert.match(crit(x), /Q-T2/, x.run.key);
  for (const x of [...c.k2hot, ...c.k2spread]) assert.match(crit(x), /S-T1/, x.run.key);
  for (const x of c.k7a) assert.match(crit(x), /NFR-006/, x.run.key);
  for (const x of c.k7b) assert.match(crit(x), /P-T1/, x.run.key);
  assert.ok(c.entry.length > 0, 'MSR-020 단계 올리기 실행(run.mjs v1 entry-steps)이 계획에 없다');
  for (const x of c.entry) assert.match(crit(x), /F-08-2|MSR-020/, x.run.key);
});

test('F088-1 ③ K7 ②는 3회이고 회마다 클러스터를 내렸다 올린 뒤(새 클러스터) 재며, 같은 stage를 쓰고, 창 맨 끝에 있다', () => {
  const plan = readPlan();
  const c = classify(plan);
  assert.equal(c.k7b.length, 3);
  const stages = new Set(c.k7b.map((x) => x.run.stage));
  assert.equal(stages.size, 1, `K7 ② stage가 갈린다: ${[...stages]}`);
  const [stage] = stages;
  for (const r of plan.runs) if (!c.k7b.some((x) => x.run === r)) assert.notEqual(r.stage, stage, `${r.key}가 K7 ②의 새 클러스터 stage를 쓴다`);
  for (const x of c.k7b) {
    const down = x.before.findIndex((a) => isCluster(a, 'down'));
    const up = x.before.findIndex((a) => isCluster(a, 'up'));
    const v1 = x.before.findIndex((a) => isCluster(a, 'v1'));
    assert.ok(down >= 0 && up > down && v1 > up, `${x.run.key}: 측정 앞에 cluster.mjs down → up → v1이 없다`);
  }
  // 창 맨 끝: 클러스터·측정 명령이 있는 실행 가운데 K7 ②가 마지막 셋이다
  const staged = plan.runs.map((r, i) => ({ r, i })).filter(({ r }) => cmds(r).some((a) => isRunMjs(a) || isCluster(a)));
  assert.deepEqual(staged.slice(-3).map(({ r }) => r.key), c.k7b.map((x) => x.run.key));
});

test('F088-1 ④ K2 TLS 끔 짝은 1회이고 판정에 쓰지 않는다고 적혀 있으며, 끝나면 무대를 TLS 켬으로 되돌린다', () => {
  const c = classify(readPlan());
  const off = c.k2hot.filter((x) => x.tlsOff);
  assert.equal(off.length, 1);
  const [x] = off;
  assert.match(`${x.run.conditions} ${x.run.criteria.join(' ')}`, /판정에 쓰지 않/);
  assert.ok(x.after.some((a) => isCluster(a, 'v1') && a.join(' ').includes('--redis-tls on')), `${x.run.key}: TLS 켬으로 되돌리는 명령이 없다`);
});

/** 창 1 맨 앞의 리허설 실행(감독 결정, 키 `w1-` 또는 묶음 '리허설'). 본 측정이 아니라 MSR-020 자리 판정에서 뺀다(시험 이의 TO-1) */
const isRehearsal = (run) => run.key.startsWith('w1-') || run.group === '리허설';

test('F088-1 ⑤ MSR-020 단계 올리기(리허설 뺀 본 측정)는 K7 ① 뒤·K7 ② 앞에 있다(F-08-8 6.2 차례)', () => {
  const c = classify(readPlan());
  const lastK7a = Math.max(...c.k7a.map((x) => x.index));
  const firstK7b = Math.min(...c.k7b.map((x) => x.index));
  const main = c.entry.filter((x) => !isRehearsal(x.run));
  assert.ok(main.length > 0, '리허설을 빼면 MSR-020 본 측정 실행이 없다');
  // 리허설은 창 맨 앞(K 측정보다 앞)에만 둔다
  const firstK = Math.min(...[...c.k1, ...c.k2hot, ...c.k2spread, ...c.k7a].map((x) => x.index));
  for (const x of c.entry.filter((y) => isRehearsal(y.run))) assert.ok(x.index < firstK, `리허설 ${x.run.key}(${x.index})가 첫 K 측정(${firstK})보다 뒤에 있다`);
  for (const x of main) assert.ok(x.index > lastK7a && x.index < firstK7b, `${x.run.key}(${x.index})가 K7 ①(${lastK7a})과 K7 ②(${firstK7b}) 사이가 아니다`);
});

test('F088-1 ⑥ K1·K2·K7 실행은 모두 불변식 검사와 장부 기록을 하고 실행 ID 끝에 -f088 표시가 있다(F-08-8 6.1)', () => {
  const c = classify(readPlan());
  for (const x of [...c.k1, ...c.k2hot, ...c.k2spread, ...c.k7a, ...c.k7b]) {
    assert.equal(x.a.invariants, true, `${x.run.key}: --invariants 없음`);
    assert.equal(x.a.record, true, `${x.run.key}: --record 없음`);
    assert.match(x.a.runId, /-f088/, `${x.run.key}: 실행 ID ${x.a.runId}`);
  }
});

// ─────────────── F088-2 조건이 정본 표와 같다 ───────────────

test('F088-2 ① K1은 대기자 1천·1만 3회씩·10만 최대 3회이고 모두 진입 1,000/s·입장 28명/s·예열 30초·본구간 120초다(§3.10 K1 행)', () => {
  const c = classify(readPlan());
  const count = (u) => c.k1.filter((x) => x.a.users === u).length;
  assert.equal(count(1000), 3);
  assert.equal(count(10000), 3);
  assert.ok(count(100000) >= 1 && count(100000) <= 3, `10만 ${count(100000)}회`);
  for (const x of c.k1) {
    assert.deepEqual([x.a.entryRate, x.a.admitPerSecond, x.a.warmS, x.a.mainS], [1000, 28, 30, 120], x.run.key);
    assert.equal(x.tlsOff, false, `${x.run.key}: K1은 TLS 켬 하나로 잰다`);
  }
});

test('F088-2 ② K2 인기 좌석은 1,000명·2,000/s·hot 1석·놓지 않음으로 TLS 켬 3회·끔 1회, 흩음은 2석 1회다(§3.10 K2 행)', () => {
  const c = classify(readPlan());
  for (const x of c.k2hot) assert.deepEqual([x.a.users, x.a.rate, x.a.mode, x.a.hotCount, x.a.keep], [1000, 2000, 'hot', 1, true], x.run.key);
  assert.equal(c.k2hot.filter((x) => !x.tlsOff).length, 3);
  assert.equal(c.k2spread.length, 1);
  for (const x of c.k2spread) assert.deepEqual([x.a.users, x.a.rate, x.a.mode, x.a.holdSize, x.a.keep, x.tlsOff], [1000, 2000, 'spread', 2, false, false], x.run.key);
});

test('F088-2 ③ K7 ①은 300/s·예열 10초·본구간 50초·2석·장애 없음 3회다(§3.10 K7 ① 행)', () => {
  const c = classify(readPlan());
  assert.equal(c.k7a.length, 3);
  for (const x of c.k7a) assert.deepEqual([x.a.rate, x.a.warmS, x.a.mainS, x.a.seatsPerOrder, x.a.faultDropPct, x.a.faultDelayPct], [300, 10, 50, 2, 0, 0], x.run.key);
});

test('F088-2 ④ K7 ②는 100/s × 본구간 100초(1만 건)·응답 버림 5%·늦춤 0.5%(v1 합본 조건)·본구간 50초에 파드 강제 종료다', () => {
  const c = classify(readPlan());
  for (const x of c.k7b) {
    assert.deepEqual([x.a.rate, x.a.mainS, x.a.faultDropPct, x.a.faultDelayPct, x.a.killAppAtS], [100, 100, 5, 0.5, 50], x.run.key);
    assert.equal(x.a.rate * x.a.mainS, 10000);
  }
});

test('F088-2 ⑤ K1 10만·K2·K7은 DB 통계를, K1 10만과 K2는 Valkey 메모리 통계를 붙인다(F-08-8 6.2)', () => {
  const c = classify(readPlan());
  const has = (x, f) => x.argv.includes(f);
  for (const x of [...c.k1.filter((y) => y.a.users === 100000), ...c.k2hot, ...c.k2spread, ...c.k7a, ...c.k7b]) assert.ok(has(x, '--db-stats'), `${x.run.key}: --db-stats 없음`);
  for (const x of c.k1.filter((y) => y.a.users === 100000)) assert.ok(has(x, '--redis-stats'), `${x.run.key}: --redis-stats 없음`);
  assert.ok([...c.k2hot, ...c.k2spread].some((x) => has(x, '--redis-stats')), 'K2 끝의 Valkey 메모리(--redis-stats)가 없다');
});

// ─────────────── F088-3 발생기 나누기 ───────────────

test('F088-3 ① 측정 실행마다 실제로 나뉘는 발생기 수가 ⌈최고 도착률 ÷ 800⌉이다(--generators를 주지 않으면 run.mjs의 ÷ 1,000과 같아야 한다)', () => {
  const c = classify(readPlan());
  const all = [...c.k1, ...c.k2hot, ...c.k2spread, ...c.k7a, ...c.k7b];
  assert.ok(all.length >= 18, `측정 실행이 ${all.length}개뿐이다`);
  for (const x of all) {
    const peak = peakRate(x.a);
    const want = Math.ceil(peak / PER_GENERATOR);
    const got = x.a.generators ?? Math.max(1, Math.ceil(peak / DEFAULT_PER_GENERATOR));
    assert.equal(got, want, `${x.run.key}: 최고 도착률 ${peak}/s → 발생기 ${want}대여야 하는데 ${got}대`);
  }
  // 800 기준이 1,000 기준과 갈리는 실행(K2 인기 2,000/s: 800 기준 3대, 1,000 기준 2대)이 있어 --generators를 빼면 위 단언이 걸린다
});

test('F088-3 ② K1 10만 명 실행은 발생기 CPU 2·메모리 512Mi로 잰다(F-08-8 2절 5)', () => {
  const c = classify(readPlan());
  const big = c.k1.filter((x) => x.a.users === 100000);
  assert.ok(big.length >= 1);
  for (const x of big) assert.deepEqual([x.a.cpus, x.a.memoryMi], [2, 512], x.run.key);
  for (const x of c.k1.filter((y) => y.a.users !== 100000)) assert.notEqual(x.a.memoryMi, 512, `${x.run.key}: 10만 밖은 512Mi로 줄이지 않는다`);
});

// ─────────────── F088-4 bat025-plan.mjs --plan ───────────────

function tool(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function tempPlan(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'f088-plan-'));
  const cacheDir = `.cache/peaket-f088-test-${randomBytes(4).toString('hex')}`;
  const run = (n, key) => ({ n, key, title: `시험 실행 ${n}`, group: 'T', stage: 'none', estimate_min: 1, gate: null, conditions: '-', commands: [{ argv: ['node', '-e', '0'] }], criteria: ['F088-4 시험'], ledger: '-', artifact: '-', result_note: '-' });
  const plan = { plan: `f088-test-${randomBytes(3).toString('hex')}`, state_file: `${cacheDir}/state.json`, runs: [run(1, 'r1'), run(2, 'r2'), run(3, 'r3')], ...over };
  const path = join(dir, 'plan.json');
  writeFileSync(path, JSON.stringify(plan));
  return { dir, path, plan, cacheAbs: join(ROOT, cacheDir), stateAbs: join(ROOT, plan.state_file ?? 'none') };
}

const BAT025_STATE = join(ROOT, '.cache', 'peaket-bat025', 'state.json');
const stamp = () => (existsSync(BAT025_STATE) ? statSync(BAT025_STATE).mtimeMs : null);

test('F088-4 ① --plan <계획>이면 그 계획의 state_file을 쓰고 BAT-025 상태 파일은 건드리지 않는다', () => {
  const t = tempPlan();
  const before = stamp();
  try {
    const r = tool(['--plan', t.path, 'init', '--day', '2026-11-24']);
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(t.stateAbs), `상태 파일이 없다: ${t.stateAbs}`);
    assert.equal(JSON.parse(readFileSync(t.stateAbs, 'utf8')).plan, t.plan.plan);
    assert.equal(stamp(), before, 'BAT-025 상태 파일이 바뀌었다');
  } finally {
    rmSync(t.cacheAbs, { recursive: true, force: true });
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test('F088-4 ② done은 pass만 통과로 센다: invalid·fail·skip은 status의 통과 수에 들지 않는다', () => {
  const t = tempPlan();
  try {
    assert.equal(tool(['--plan', t.path, 'init', '--day', '2026-11-24']).code, 0);
    assert.equal(tool(['--plan', t.path, 'done', 'r1', '--result', 'invalid', '--note', '발생기 놓침 1건']).code, 0);
    assert.equal(tool(['--plan', t.path, 'skip', 'r2', '--reason', '측정 못 함']).code, 0);
    let s = tool(['--plan', t.path, 'status']);
    assert.equal(s.code, 0, s.out);
    assert.match(s.out, /통과 0 · 실패\/무효 1 · 건너뜀 1 · 남음 1/);
    assert.equal(tool(['--plan', t.path, 'done', 'r3', '--result', 'pass']).code, 0);
    s = tool(['--plan', t.path, 'status']);
    assert.match(s.out, /통과 1 · 실패\/무효 1 · 건너뜀 1 · 남음 0/);
  } finally {
    rmSync(t.cacheAbs, { recursive: true, force: true });
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test('F088-4 ③ 없는 계획 파일과 state_file 없는 계획은 오류(종료 코드 0 아님)로 끝나고 까닭을 적는다', () => {
  const missing = join(tmpdir(), `f088-none-${randomBytes(4).toString('hex')}.json`);
  const r1 = tool(['--plan', missing, 'status']);
  assert.notEqual(r1.code, 0, r1.out);
  assert.ok(r1.out.includes(missing) || r1.out.includes(missing.split(/[\\/]/).pop()), `없는 경로를 적지 않았다: ${r1.out}`);
  const t = tempPlan({ state_file: undefined });
  try {
    const r2 = tool(['--plan', t.path, 'status']);
    assert.notEqual(r2.code, 0, r2.out);
    assert.match(r2.out, /state_file/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test('F088-4 ④ --plan이 없으면 BAT-025 계획을 읽는다(기본 동작 그대로)', () => {
  assert.equal(loadPlan().plan, 'bat025-window-1');
  const before = stamp();
  const r = tool(['status']);
  assert.match(r.out, /bat025/);
  assert.equal(stamp(), before);
});
