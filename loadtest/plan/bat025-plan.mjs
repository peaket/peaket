#!/usr/bin/env node
// BAT-025 측정 계획(loadtest/plan/bat025-plan.json)을 읽고, 실행 하나씩 끝난 것을 상태 파일에 적어 이어 돌게 하는 도구다.
// 계획의 모양과 쓰는 법은 loadtest/plan/README.md, 정본은 docs/review/plans/BAT-025.md §2.3·§6.2다.
// 이 도구는 명령을 실행하지 않는다. 다음 실행의 명령·조건·판정을 보여 주고, 사람이 끝낸 결과를 적는다(측정은 감독의 '측정 시작' 뒤에만).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PLAN_PATH = join(ROOT, 'loadtest', 'plan', 'bat025-plan.json');
const RESULTS = ['pass', 'fail', 'invalid'];
const STATUSES = ['pending', 'running', 'done', 'failed', 'skipped'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** 계획 파일을 읽고 모양을 확인한다. 틀리면 Error */
export function loadPlan(path = PLAN_PATH) {
  const p = JSON.parse(readFileSync(path, 'utf8'));
  validatePlan(p);
  return p;
}

/** 계획의 모양: runs의 n은 1부터 차례, key는 겹치지 않는 [a-z0-9-], gate는 gates에 있는 이름 또는 null */
export function validatePlan(p) {
  if (!p || typeof p.plan !== 'string' || !p.plan) throw new Error('계획에 plan 이름이 없다');
  if (typeof p.state_file !== 'string' || !p.state_file) throw new Error('계획에 state_file이 없다');
  if (!Array.isArray(p.runs) || p.runs.length === 0) throw new Error('계획에 runs가 없다');
  const gates = p.gates ?? {};
  if (typeof gates !== 'object' || Array.isArray(gates)) throw new Error('gates는 객체다');
  const keys = new Set();
  p.runs.forEach((r, i) => {
    if (r.n !== i + 1) throw new Error(`runs[${i}].n이 ${i + 1}이 아니다`);
    if (typeof r.key !== 'string' || !/^[a-z0-9-]+$/.test(r.key) || keys.has(r.key)) throw new Error(`runs[${i}].key가 틀렸거나 겹친다: ${r.key}`);
    keys.add(r.key);
    for (const k of ['title', 'group', 'stage']) if (typeof r[k] !== 'string' || !r[k]) throw new Error(`${r.key}.${k}가 없다`);
    if (!Number.isFinite(r.estimate_min) || r.estimate_min < 0) throw new Error(`${r.key}.estimate_min이 0 이상의 수가 아니다`);
    if (r.gate !== null && r.gate !== undefined && !Object.hasOwn(gates, r.gate)) throw new Error(`${r.key}의 gate ${r.gate}가 gates에 없다`);
    if (!Array.isArray(r.commands) || r.commands.length === 0) throw new Error(`${r.key}.commands가 비었다`);
    for (const c of r.commands) {
      if (!Array.isArray(c.argv) || c.argv.length === 0 || c.argv.some((a) => typeof a !== 'string' || !a)) throw new Error(`${r.key}의 명령 argv가 틀렸다`);
      if (c.label !== undefined && typeof c.label !== 'string') throw new Error(`${r.key}의 명령 label이 글자가 아니다`);
    }
  });
}

/** {day}·{suffix}를 상태 값으로 바꾼다. argv·경로·설명 모두 같은 규칙이다 */
export const fill = (value, state) => {
  if (typeof value === 'string') return value.replaceAll('{day}', state.day).replaceAll('{suffix}', state.suffix ?? '');
  if (Array.isArray(value)) return value.map((v) => fill(v, state));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, state)]));
  return value;
};

/** 새 상태: 날·묶음 글자를 적고 모든 실행을 pending으로 둔다 */
export function newState(plan, day, suffix = '') {
  if (!DAY.test(day)) throw new Error(`날 꼴이 YYYY-MM-DD가 아니다: ${day}`);
  return {
    plan: plan.plan,
    day,
    suffix,
    createdAt: new Date().toISOString(),
    gates: {},
    runs: Object.fromEntries(plan.runs.map((r) => [r.key, { status: 'pending' }])),
  };
}

/** 상태가 계획과 같은지 본다. 다르면 Error(상태 파일을 지우거나 계획 이름을 맞춘다) */
export function checkState(state, plan) {
  if (state.plan !== plan.plan) throw new Error(`상태 파일의 계획(${state.plan})이 ${plan.plan}이 아니다`);
  if (!DAY.test(state.day)) throw new Error(`상태 파일의 날(${state.day})이 YYYY-MM-DD가 아니다`);
}

/** 게이트가 아직 막혔는가 */
export const blockedBy = (run, state) => (run.gate && !state.gates?.[run.gate] ? run.gate : null);

/** 아직 끝나지 않은 실행(실패·중단도 다시 도는 대상이다). skipped는 끝난 것으로 본다 */
export const pendingRuns = (plan, state) => plan.runs.filter((r) => !['done', 'skipped'].includes(state.runs?.[r.key]?.status ?? 'pending'));

/** 다음에 돌 실행: gate가 풀린 것 가운데 계획 차례의 첫 실행. 없으면 null */
export function nextRun(plan, state) {
  return pendingRuns(plan, state).find((r) => !blockedBy(r, state)) ?? null;
}

/** 실행의 결과(상태와 판정을 함께 본다). 통과는 result='pass'만이다 */
export const isPass = (state, key) => state.runs?.[key]?.status === 'done' && state.runs?.[key]?.result === 'pass';

/** 상태 파일을 통째로 바꿔 쓴다(임시 파일 → 이름 바꾸기) */
export function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, path);
}

export function readState(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

const statePathOf = (plan) => join(ROOT, plan.state_file);
const argAfter = (argv, name) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} 뒤에 값이 없다`);
  return v;
};
const has = (argv, name) => argv.includes(name);
const commandLine = (c) => [c.background ? '(따로 띄움)' : '', c.argv.join(' ')].filter(Boolean).join(' ');

function printRun(run, state) {
  const x = fill(run, state);
  console.log(`\n[${run.n}] ${run.key} — ${run.title}`);
  console.log(`  묶음: ${run.group} · 예상 ${run.estimate_min}분${run.gate ? ` · 게이트: ${run.gate}` : ''}`);
  console.log(`  조건: ${x.conditions}`);
  console.log('  명령:');
  for (const c of x.commands) console.log(`    ${c.label ? `${c.label}: ` : ''}${commandLine(c)}`);
  console.log('  판정:');
  for (const c of x.criteria) console.log(`    - ${c}`);
  console.log(`  장부: ${x.ledger}`);
  console.log(`  산출물: ${x.artifact}`);
  console.log(`  기록: ${x.result_note}`);
}

function status(plan, state) {
  const total = plan.runs.reduce((s, r) => s + r.estimate_min, 0);
  const pending = pendingRuns(plan, state);
  const blocked = pending.filter((r) => blockedBy(r, state));
  const leftMin = pending.reduce((s, r) => s + r.estimate_min, 0);
  console.log(`계획 ${plan.plan} · 날 ${state.day} · 묶음 '${state.suffix || '(없음)'}' · 상태 ${plan.state_file}`);
  console.log('');
  console.log('번호  키                       묶음        상태      판정      게이트       예상  제목');
  for (const r of plan.runs) {
    const s = state.runs[r.key] ?? { status: 'pending' };
    const gate = r.gate ? (state.gates?.[r.gate] ? `${r.gate}(풀림)` : r.gate) : '-';
    console.log(
      `${String(r.n).padStart(2)}    ${r.key.padEnd(24)} ${r.group.padEnd(10)} ${String(s.status).padEnd(9)} ${String(s.result ?? '-').padEnd(9)} ${gate.padEnd(12)} ${String(r.estimate_min).padStart(3)}분  ${r.title}`,
    );
  }
  console.log('');
  const count = (f) => plan.runs.filter(f).length;
  console.log(`통과 ${count((r) => isPass(state, r.key))} · 실패/무효 ${count((r) => state.runs[r.key]?.status === 'done' && ['fail', 'invalid'].includes(state.runs[r.key].result))} · 건너뜀 ${count((r) => state.runs[r.key]?.status === 'skipped')} · 남음 ${pending.length}`);
  console.log(`남은 예상 ${leftMin}분(전체 ${total}분). 막힌 실행 ${blocked.length}개${blocked.length ? `: ${blocked.map((r) => `${r.key}(${blockedBy(r, state)})`).join(', ')}` : ''}`);
  if (pending.length) console.log('다음: node loadtest/plan/bat025-plan.mjs next');
}

function aaSummary(plan, state) {
  const aa = plan.runs.filter((r) => r.group === 'A/A');
  const read = (run) => {
    const x = fill(run, state);
    const i = x.commands.find((c) => c.argv.includes('--out'))?.argv.indexOf('--out');
    const outDir = i === undefined || i < 0 ? null : x.commands.find((c) => c.argv.includes('--out')).argv[i + 1];
    if (!outDir) throw new Error(`${run.key}에 --out이 없다`);
    const dir = join(ROOT, outDir);
    const summaryPath = join(dir, 'summary.json');
    const generatorPath = join(dir, 'generator.json');
    if (!existsSync(summaryPath)) return { key: run.key, out: outDir, missing: true };
    const s = JSON.parse(readFileSync(summaryPath, 'utf8'));
    const g = existsSync(generatorPath) ? JSON.parse(readFileSync(generatorPath, 'utf8')) : null;
    const v = s.metrics?.['http_req_duration{phase:main,route:hold}']?.values ?? {};
    return { key: run.key, out: outDir, p99: v['p(99)'] ?? null, p999: v['p(99.9)'] ?? null, valid: g?.judge?.valid ?? false, reasons: g?.judge?.reasons ?? [] };
  };
  const rows = aa.map(read);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  const pair = (a, b) => (byKey[a]?.p99 && byKey[b]?.p99 ? byKey[b].p99 / byKey[a].p99 : null);
  const quietRatio = pair('aa-quiet-r1', 'aa-quiet-r2');
  const noisyRatio = pair('aa-noisy-r1', 'aa-noisy-r2');
  const band = 0.096; // 2026-11-03 D-T40 A/A 10번, p99 가장 큰 벗어남 9.6%(docs/verification.md §3.10 결과)
  const within = (x) => typeof x === 'number' && x >= 1 / (1 + band) && x <= 1 + band;
  const invalid = rows.filter((r) => r.missing || !r.valid);
  let verdict;
  if (invalid.length) verdict = `판정 불가: 결과 없음 또는 무효(${invalid.map((r) => r.key).join(', ')})`;
  else if (!within(quietRatio) || !within(noisyRatio)) verdict = '잡음 폭 밖: 한 쌍의 p99 비율이 A/A 잡음 폭(±9.6%)을 넘었다';
  else if (Math.abs(noisyRatio - quietRatio) / quietRatio > band) verdict = '잡음 폭 밖: 다른 갈래 함께 쌍의 비율 차이가 ±9.6%를 넘었다';
  else verdict = '잡음 폭 안: 정밀 측정 동안 다른 갈래 시험을 풀 수 있다(감독 확인)';
  const out = {
    plan: plan.plan,
    day: state.day,
    suffix: state.suffix,
    band,
    bandBasis: '2026-11-03 D-T40 A/A 10번, 대기 상태 조회 p99 가장 큰 벗어남 9.6%(docs/verification.md §3.10). 이 측정의 A/A 쌍 비율과 견준다.',
    quietRatio,
    noisyRatio,
    verdict,
    runs: rows,
  };
  const outPath = join(ROOT, '.cache', 'peaket-bat025', 'aa', 'aa-summary.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
  console.log(`\n적었다: ${outPath}`);
}

function main(argv) {
  const plan = loadPlan();
  const path = statePathOf(plan);
  const cmd = argv[0];
  if (cmd === 'init') {
    const current = readState(path);
    if (current && !has(argv, '--force')) throw new Error(`상태 파일이 이미 있다: ${plan.state_file} (다시 만들려면 --force)`);
    const day = argAfter(argv, '--day') ?? new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // KST
    const suffix = argAfter(argv, '--suffix') ?? '';
    const state = newState(plan, day, suffix);
    writeState(path, state);
    console.log(`상태 파일을 만들었다: ${plan.state_file} (날 ${day}, 묶음 '${suffix || '(없음)'}')`);
    status(plan, state);
    return 0;
  }
  const state = readState(path);
  if (!state) throw new Error(`상태 파일이 없다: ${plan.state_file}. 먼저 node loadtest/plan/bat025-plan.mjs init`);
  checkState(state, plan);
  if (cmd === 'status') {
    status(plan, state);
    return 0;
  }
  if (cmd === 'next') {
    const next = nextRun(plan, state);
    const blocked = pendingRuns(plan, state).filter((r) => blockedBy(r, state));
    if (blocked.length) console.log(`막힌 실행 ${blocked.length}개: ${blocked.map((r) => `${r.key}(${blockedBy(r, state)})`).join(', ')}`);
    if (!next) {
      console.log('남은 실행이 없다(막힌 것도 없다).');
      return 0;
    }
    printRun(next, state);
    console.log(`\n끝나면: node loadtest/plan/bat025-plan.mjs done ${next.key} --result pass|fail|invalid --note "..."`);
    return 0;
  }
  if (cmd === 'show') {
    const key = argv[1];
    const run = plan.runs.find((r) => r.key === key);
    if (!run) throw new Error(`모르는 실행: ${key}`);
    printRun(run, state);
    return 0;
  }
  if (cmd === 'done') {
    const key = argv[1];
    const run = plan.runs.find((r) => r.key === key);
    if (!run) throw new Error(`모르는 실행: ${key}`);
    const gate = blockedBy(run, state);
    if (gate) throw new Error(`${key}는 게이트 ${gate}가 아직 막혀 있다. 먼저 unblock ${gate}`);
    const result = argAfter(argv, '--result');
    if (!result || !RESULTS.includes(result)) throw new Error(`done에는 --result ${RESULTS.join('|')}가 필요하다`);
    const note = argAfter(argv, '--note');
    if (result !== 'pass' && !note) throw new Error('fail·invalid에는 --note로 까닭을 적는다');
    state.runs[key] = { ...state.runs[key], status: 'done', result, endedAt: new Date().toISOString(), ...(note ? { note } : {}), ...(argAfter(argv, '--artifact') ? { artifact: argAfter(argv, '--artifact') } : {}) };
    writeState(path, state);
    console.log(`${key}: done · ${result}${note ? ` · ${note}` : ''}`);
    return 0;
  }
  if (cmd === 'fail' || cmd === 'skip') {
    const key = argv[1];
    if (!plan.runs.some((r) => r.key === key)) throw new Error(`모르는 실행: ${key}`);
    const reason = argAfter(argv, '--reason') ?? argAfter(argv, '--note');
    if (!reason) throw new Error(`${cmd}에는 --reason이 필요하다`);
    state.runs[key] = { ...state.runs[key], status: cmd === 'fail' ? 'failed' : 'skipped', result: cmd === 'fail' ? 'fail' : 'skipped', endedAt: new Date().toISOString(), note: reason };
    writeState(path, state);
    console.log(`${key}: ${cmd === 'fail' ? 'failed' : 'skipped'} · ${reason}`);
    return 0;
  }
  if (cmd === 'retry') {
    const key = argv[1];
    if (!plan.runs.some((r) => r.key === key)) throw new Error(`모르는 실행: ${key}`);
    state.runs[key] = { status: 'pending' };
    writeState(path, state);
    console.log(`${key}: pending으로 되돌렸다`);
    return 0;
  }
  if (cmd === 'unblock') {
    const gate = argv[1];
    if (!Object.hasOwn(plan.gates ?? {}, gate)) throw new Error(`모르는 게이트: ${gate}`);
    state.gates[gate] = { clearedAt: new Date().toISOString(), ...(argAfter(argv, '--note') ? { note: argAfter(argv, '--note') } : {}) };
    writeState(path, state);
    console.log(`게이트 ${gate}를 풀었다.`);
    return 0;
  }
  if (cmd === 'aa') {
    aaSummary(plan, state);
    return 0;
  }
  throw new Error('명령: init·status·next·show <key>·done <key> --result pass|fail|invalid [--note]·fail <key> --reason·skip <key> --reason·retry <key>·unblock <gate>·aa');
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 2;
  }
}
