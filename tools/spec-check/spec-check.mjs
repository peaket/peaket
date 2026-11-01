#!/usr/bin/env node
// 규칙 모델 검사 실행기(wbs 0.9.1, docs/verification.md §2.2·§2.6, V-T1). 목록은 specs/specs.json이다.
// - pr: 형식 검사 + 검사마다 시뮬레이션(quint run, 고정 시드). 명세·도구가 바뀌는 PR마다 돈다
// - full: 형식 검사 + 검사마다 TLC 전수 검사(quint verify --backend=tlc). 주 1회와 관련 ADR이 바뀔 때 돈다.
//   --write면 결과를 specs/results/<명세>.json에, 반례 경로를 specs/results/<명세>/<모듈>.itf.json에 남긴다
// - 지켜짐(hold)을 기대한 검사는 위반이 없어야, 반례(violate)를 기대한 변형은 그 불변식의 반례가 나와야 통과한다(검사가 살아 있는지)
// 쓰는 법: node tools/spec-check/spec-check.mjs <typecheck|pr|full> [--spec 이름] [--write]
//   Quint는 QUINT_BIN(cli.js 경로) 또는 tools/spec-check/node_modules의 것을 쓴다. TLC는 java가 PATH에 있어야 한다
//   이 PC(Windows)에서는 컨테이너로 돌린다: node tools/spec-check/run-local.mjs <같은 인자>
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PINS, ensureQuintTools } from './fetch-tools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

// ---- 목록 ----
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** specs/specs.json을 읽고 명세 파일과 맞는지 본다. readFile(경로)는 저장소 기준 경로를 받는다 */
export function loadManifest(text, readFile) {
  const m = JSON.parse(text);
  const fail = (msg) => {
    throw new Error(`specs/specs.json: ${msg}`);
  };
  const sim = m.simulation ?? fail('simulation이 없다');
  for (const k of ['samples', 'maxSteps']) if (!Number.isInteger(sim[k]) || sim[k] <= 0) fail(`simulation.${k}는 양의 정수다`);
  if (typeof sim.seed !== 'string' || !sim.seed) fail('simulation.seed가 없다');
  if (!Array.isArray(m.specs) || m.specs.length === 0) fail('specs가 비었다');
  for (const s of m.specs) {
    for (const k of ['name', 'file', 'title', 'scope']) if (typeof s[k] !== 'string' || !s[k]) fail(`${s.name ?? '?'}: ${k}가 없다`);
    if (!Array.isArray(s.adrs) || s.adrs.some((a) => !/^\d{4}$/.test(a))) fail(`${s.name}: adrs는 네 자리 ADR 번호 목록이다`);
    const src = readFile(s.file);
    const modules = new Set([...src.matchAll(/^\s*module\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm)].map((x) => x[1]));
    const vals = new Set([...src.matchAll(/^\s*val\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((x) => x[1]));
    if (!Array.isArray(s.invariants) || s.invariants.length === 0) fail(`${s.name}: invariants가 비었다`);
    for (const i of s.invariants) if (!NAME.test(i) || !vals.has(i)) fail(`${s.name}: 불변식 ${i}가 ${s.file}에 없다`);
    if (!Array.isArray(s.checks) || s.checks.length === 0) fail(`${s.name}: checks가 비었다`);
    const seen = new Set();
    for (const c of s.checks) {
      if (!NAME.test(c.main ?? '') || !modules.has(c.main)) fail(`${s.name}: 모듈 ${c.main}가 ${s.file}에 없다`);
      if (seen.has(c.main)) fail(`${s.name}: 모듈 ${c.main}를 두 번 적었다`);
      seen.add(c.main);
      if (c.expect !== 'hold' && c.expect !== 'violate') fail(`${s.name}/${c.main}: expect는 hold 또는 violate다`);
      if (typeof c.why !== 'string' || !c.why) fail(`${s.name}/${c.main}: why(까닭)가 없다`);
      // tlc: false는 전수 검사가 너무 큰 범위(정본 범위 전체 등)라 시뮬레이션으로만 보는 검사다
      if ('tlc' in c && typeof c.tlc !== 'boolean') fail(`${s.name}/${c.main}: tlc는 true 또는 false다`);
      if (c.expect === 'violate') {
        if (!c.invariant) fail(`${s.name}/${c.main}: 반례를 기대하면 invariant(깨질 불변식)를 적는다`);
        if (!s.invariants.includes(c.invariant)) fail(`${s.name}/${c.main}: ${c.invariant}는 이 명세의 invariants에 없다`);
      }
    }
    if (!s.checks.some((c) => c.expect === 'hold')) fail(`${s.name}: expect hold인 검사가 하나는 있어야 한다`);
    if (!s.checks.some((c) => c.expect === 'hold' && c.tlc !== false)) fail(`${s.name}: 지켜짐을 기대하는 전수 검사(tlc가 false가 아닌 hold)가 하나는 있어야 한다`);
  }
  return m;
}

// ---- 출력 읽기 ----
const num = (re, text) => {
  const x = text.match(re);
  return x ? Number(x[1]) : null;
};

/** TLC 출력(Quint verbosity 3이 그대로 찍는 것)에서 판·상태 수·깊이·지문 충돌 확률·위반 여부를 읽는다 */
export function parseTlc(text) {
  const states = text.match(/(\d+) states generated, (\d+) distinct states found, (\d+) states left on queue\./);
  return {
    tlc: text.match(/^(TLC2 Version .*)$/m)?.[1].trim() ?? null,
    statesGenerated: states ? Number(states[1]) : null,
    distinctStates: states ? Number(states[2]) : null,
    statesLeft: states ? Number(states[3]) : null,
    depth: num(/The depth of the complete state graph search is (\d+)\./, text),
    fingerprintCollision: text.match(/calculated \(optimistic\):\s+val = (\S+)/)?.[1] ?? null,
    completed: /Model checking completed\. No error has been found\./.test(text),
    violated: /Error: Invariant \S+ is violated/.test(text),
  };
}

/** TLC 출력에서 반례 경로(위반 알림과 상태 목록)만 잘라 낸다. 반례가 없으면 null */
export function extractTlcTrace(text) {
  const start = text.indexOf('Error: Invariant ');
  if (start < 0) return null;
  const rest = text.slice(start);
  const end = rest.search(/^\d+ states generated, /m);
  return `${(end < 0 ? rest : rest.slice(0, end)).trimEnd()}\n`;
}

/** quint run 출력에서 위반 여부와 깨진 불변식 이름을 읽는다(--invariants로 하나씩 보고하게 부른다) */
export function parseSimulation(text) {
  if (/\[ok\] No violation found/.test(text)) return { violated: false, failing: [] };
  if (/\[violation\] Found an issue/.test(text)) return { violated: true, failing: [...text.matchAll(/❌\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((x) => x[1]) };
  throw new Error(`시뮬레이션 결과를 읽지 못했다:\n${text.slice(-2000)}`);
}

/** 검사 하나의 판정. mode가 'verify'면 지켜짐은 TLC가 끝까지 돌았어야 한다 */
export function judge(check, outcome, mode = 'verify') {
  if (check.expect === 'hold') {
    if (outcome.violated) return { ok: false, message: `${check.main}: 지켜져야 하는데 반례가 나왔다(${outcome.failing.join(', ') || '불변식'})` };
    if (mode === 'verify' && !outcome.completed) return { ok: false, message: `${check.main}: TLC가 끝까지 돌지 않았다(전수 검사 아님)` };
    return { ok: true, message: `${check.main}: 위반 없음` };
  }
  if (!outcome.violated) return { ok: false, message: `${check.main}: ${check.invariant}의 반례가 나와야 하는데 없다(검사가 살아 있지 않다)` };
  if (outcome.failing.length > 0 && !outcome.failing.includes(check.invariant)) {
    return { ok: false, message: `${check.main}: 노린 ${check.invariant}가 아니라 ${outcome.failing.join(', ')}가 깨졌다` };
  }
  return { ok: true, message: `${check.main}: 기대한 반례(${check.invariant})` };
}

/** 시뮬레이션으로 다시 찾은 동작 기록이 반례인지: 반례 변형은 노린 불변식이, 지켜져야 할 검사는 어느 불변식이든 깨져야 한다 */
// 불변식 하나로 돌리면 Quint는 깨진 이름을 찍지 않으므로(2026-11-02 실행에서 확인), 노린 불변식 하나만 넘겼으면 위반만으로 본다(judge와 같은 규칙)
export function refoundIsCounterexample(check, sim, invs) {
  if (!sim.violated) return false;
  if (check.expect !== 'violate') return true;
  return sim.failing.includes(check.invariant) || (sim.failing.length === 0 && invs.length === 1 && invs[0] === check.invariant);
}

// ---- 기록 ----
/** 한국 시각(+09:00) ISO 문자열. 시스템 시간대를 보지 않는다 */
export function kstTimestamp(now) {
  const k = new Date(now.getTime() + 9 * 3600_000);
  return `${k.toISOString().slice(0, 19)}+09:00`;
}

/** specs/results/<명세>.json 내용(docs/verification.md §2.2 '결과 파일') */
export function resultRecord({ spec, specSha256, commit, tools, now, checks }) {
  return {
    spec: spec.name,
    file: spec.file,
    specSha256,
    commit,
    date: kstTimestamp(now),
    scope: spec.scope,
    adrs: spec.adrs,
    tools,
    ok: checks.every((c) => c.verdict.ok),
    checks: checks.map((c) => ({
      main: c.check.main,
      expect: c.check.expect,
      ...(c.check.invariant ? { targetInvariant: c.check.invariant } : {}),
      why: c.check.why,
      invariants: c.invariants,
      method: c.sim ? 'simulate' : 'tlc',
      result: c.sim ? (c.sim.violated ? 'violate' : 'hold') : c.tlc.violated ? 'violate' : c.tlc.completed ? 'hold' : 'incomplete',
      ok: c.verdict.ok,
      ...(c.sim ? { samples: c.sim.samples, maxSteps: c.sim.maxSteps, seed: c.sim.seed } : {}),
      statesGenerated: c.tlc?.statesGenerated ?? null,
      distinctStates: c.tlc?.distinctStates ?? null,
      depth: c.tlc?.depth ?? null,
      fingerprintCollision: c.tlc?.fingerprintCollision ?? null,
      seconds: c.seconds,
      ...(c.tlcTrace ? { tlcTrace: c.tlcTrace } : {}),
      ...(c.counterexample ? { counterexample: c.counterexample } : {}),
    })),
  };
}

// ---- 실행 ----
const quintCli = () => process.env.QUINT_BIN ?? join(HERE, 'node_modules', '@informalsystems', 'quint', 'dist', 'src', 'cli.js');

function quint(args, { allowFail = false } = {}) {
  const r = spawnSync(process.execPath, [quintCli(), ...args], { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) throw new Error(`quint ${args.join(' ')} 실패(${r.status}):\n${out.slice(-4000)}`);
  return { status: r.status, out };
}

function gitCommit() {
  // 컨테이너(run-local.mjs)에는 git이 없어 바깥에서 읽은 값을 받는다
  if (process.env.PEAKET_SPEC_COMMIT) return { sha: process.env.PEAKET_SPEC_COMMIT, dirty: process.env.PEAKET_SPEC_DIRTY === '1' };
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
    // 결과 파일(specs/results)은 이 실행이 쓰는 것이라 뺀다(코드 리뷰 2026-11-02)
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'specs', 'tools/spec-check', ':(exclude)specs/results'], { cwd: REPO, encoding: 'utf8' }).trim() !== '';
    return { sha, dirty };
  } catch {
    return { sha: null, dirty: null };
  }
}

function javaVersion() {
  const r = spawnSync('java', ['-version'], { encoding: 'utf8' });
  return (r.stderr || r.stdout || '').match(/version "([^"]+)"/)?.[1] ?? null;
}

const invariantsOf = (s, c) => (c.expect === 'violate' ? [c.invariant] : s.invariants);

// 검사 하나를 시뮬레이션으로(고정 시드, 스레드 하나라 같은 커밋은 같은 결과)
function simulateOne(m, s, c) {
  const invs = invariantsOf(s, c);
  const t0 = Date.now();
  const { out } = quint(['run', s.file, `--main=${c.main}`, '--invariants', ...invs, `--max-samples=${m.simulation.samples}`,
    `--max-steps=${m.simulation.maxSteps}`, `--seed=${m.simulation.seed}`, '--n-threads=1', '--verbosity=2'], { allowFail: true });
  const seconds = (Date.now() - t0) / 1000;
  const sim = { ...parseSimulation(out), samples: m.simulation.samples, maxSteps: m.simulation.maxSteps, seed: m.simulation.seed };
  const verdict = judge(c, sim, 'simulate');
  console.log(`${verdict.ok ? 'ok  ' : 'FAIL'} ${s.name} 시뮬레이션 ${m.simulation.samples}회 ${verdict.message} (${seconds.toFixed(1)}초)`);
  return { check: c, invariants: invs, sim, seconds, verdict };
}

// 검사 하나를 TLC 전수 검사로. 반례를 기대하는 변형은 노린 불변식 하나만 본다(너비 우선이라 가장 짧은 반례가 나온다)
function tlcOne(m, s, c, { staging }) {
  const invs = invariantsOf(s, c);
  const t0 = Date.now();
  const { out } = quint(['verify', s.file, '--backend=tlc', `--main=${c.main}`, '--invariants', ...invs, '--verbosity=3'], { allowFail: true });
  const seconds = (Date.now() - t0) / 1000;
  const tlc = parseTlc(out);
  if (!tlc.completed && !tlc.violated) throw new Error(`${s.name}/${c.main}: TLC가 끝나지 않았다:
${out.slice(-4000)}`);
  const failing = !tlc.violated ? [] : invs.length === 1 ? invs : invs.filter((i) => out.includes(`❌ ${i}`));
  const verdict = judge(c, { violated: tlc.violated, failing, completed: tlc.completed });
  let counterexample;
  let tlcTrace;
  if (tlc.violated && staging) {
    // TLC가 찾은 가장 짧은 반례(너비 우선)는 TLC 출력 그대로 <모듈>.tlc.txt에 남긴다. Quint의 TLC 연결은 --out-itf를 쓰지 않아,
    // 기계가 읽는 동작 기록(ITF, 모델 기반 시험 재생용)은 같은 불변식의 반례를 고정 시드 시뮬레이션으로 다시 찾아 남긴다(더 길 수 있다)
    // 파일은 준비 폴더(staging)에 쓰고, 모든 검사가 끝나 명세 해시가 같을 때만 verify가 결과 폴더로 옮긴다(코드 리뷰 2026-11-02).
    // 결과 파일에 적는 경로는 옮긴 뒤의 자리다
    const dir = `specs/results/${s.name}`;
    const trace = extractTlcTrace(out);
    if (trace) {
      tlcTrace = `${dir}/${c.main}.tlc.txt`;
      writeFileSync(join(staging, `${c.main}.tlc.txt`), trace);
    }
    const itfStage = relative(REPO, join(staging, `${c.main}.itf.json`)).split(sep).join('/');
    // --out-itf는 위반이 없어도 기록을 쓴다. 출력으로 실제 반례인지 보고 아니면 지운다(코드 리뷰 2026-11-02)
    const re = quint(['run', s.file, `--main=${c.main}`, '--invariants', ...invs, `--max-samples=${m.simulation.samples}`, `--max-steps=${m.simulation.maxSteps}`,
      `--seed=${m.simulation.seed}`, '--n-threads=1', '--mbt', `--out-itf=${itfStage}`, '--verbosity=2'], { allowFail: true });
    let refound = false;
    try {
      refound = refoundIsCounterexample(c, parseSimulation(re.out), invs);
    } catch {
      refound = false;
    }
    if (refound && existsSync(join(REPO, itfStage))) counterexample = `${dir}/${c.main}.itf.json`;
    else {
      rmSync(join(REPO, itfStage), { force: true });
      console.log(`경고: ${s.name}/${c.main}의 반례를 시뮬레이션으로 다시 찾지 못해 동작 기록은 남기지 않는다(TLC 반례는 ${tlcTrace ?? '없음'})`);
    }
  }
  console.log(`${verdict.ok ? 'ok  ' : 'FAIL'} ${s.name} TLC ${verdict.message} (상태 ${tlc.distinctStates ?? '?'}개, 깊이 ${tlc.depth ?? '?'}, ${seconds.toFixed(1)}초)`);
  return { check: c, invariants: invs, tlc, seconds, verdict, counterexample, tlcTrace };
}

function verify(m, s, { write }) {
  // 커밋과 명세 해시는 검사 전에 읽는다(검사가 쓰는 파일이 '고친 채'로 보이지 않게). 검사 도중 명세가 바뀌면 실패한다(코드 리뷰 2026-11-02)
  const commit = gitCommit();
  const specHash = () => createHash('sha256').update(readFileSync(join(REPO, s.file))).digest('hex');
  const specSha256 = specHash();
  const staging = write ? join(REPO, 'specs', 'results', `.staging-${s.name}`) : null;
  if (staging) {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
  }
  let checks;
  try {
    checks = s.checks.map((c) => (c.tlc === false ? simulateOne(m, s, c) : tlcOne(m, s, c, { staging })));
    if (specHash() !== specSha256) throw new Error(`${s.file}가 검사 도중 바뀌었다. 다시 돌린다`);
  } catch (e) {
    if (staging) rmSync(staging, { recursive: true, force: true });
    throw e;
  }
  const rec = resultRecord({
    spec: s,
    specSha256,
    commit,
    // Apalache 묶음 안 TLC는 판 번호 대신 실행 시각을 첫 줄에 찍어(예: 'TLC2 Version 2026.11.01.162232') 판은 묶음 판으로 적는다
    tools: { quint: PINS.quint, apalache: PINS.apalache.version, tlc: `Apalache ${PINS.apalache.version} 묶음(apalache.jar)`, java: javaVersion() },
    now: new Date(),
    checks,
  });
  if (write) {
    const file = join(REPO, 'specs', 'results', `${s.name}.json`);
    // 반례 폴더를 이번 실행의 것으로 통째로 바꾼다(지난 실행의 반례가 섞이지 않게)
    const final = join(REPO, 'specs', 'results', s.name);
    rmSync(final, { recursive: true, force: true });
    renameSync(staging, final);
    writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
    console.log(`기록: ${relative(REPO, file)}`);
  }
  return rec;
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { spec: { type: 'string' }, write: { type: 'boolean', default: false } } });
  const cmd = positionals[0];
  if (!['typecheck', 'pr', 'full'].includes(cmd)) {
    console.error('명령: typecheck | pr | full [--spec 이름] [--write]');
    process.exit(2);
  }
  const m = loadManifest(readFileSync(join(REPO, 'specs', 'specs.json'), 'utf8'), (f) => readFileSync(join(REPO, f), 'utf8'));
  const specs = m.specs.filter((s) => !values.spec || s.name === values.spec);
  if (specs.length === 0) throw new Error(`명세 ${values.spec}가 목록에 없다`);
  // Quint가 해시 확인 없이 받지 않게, 검사 전에 도구 해시를 매번 다시 본다(맞으면 받지 않는다, 코드 리뷰 2026-11-02)
  if (cmd !== 'typecheck') await ensureQuintTools();
  let ok = true;
  for (const s of specs) {
    quint(['typecheck', s.file]);
    console.log(`ok   ${s.name} 형식 검사`);
    if (cmd === 'pr') ok = s.checks.map((c) => simulateOne(m, s, c)).every((r) => r.verdict.ok) && ok;
    if (cmd === 'full') ok = verify(m, s, { write: values.write }).ok && ok;
  }
  if (!ok) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
