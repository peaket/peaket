#!/usr/bin/env node
// 규칙 모델 검사 실행기(wbs 0.9.1, docs/verification.md §2.2·§2.6, V-T1). 목록은 specs/specs.json이다.
// - pr: 형식 검사 + 검사마다 시뮬레이션(quint run, 고정 시드). 명세·도구가 바뀌는 PR마다 돈다
// - full: 형식 검사 + 검사마다 TLC 전수 검사(quint verify --backend=tlc). 주 1회와 관련 ADR이 바뀔 때 돈다.
//   --write면 결과를 specs/results/<명세>.json에, 반례 경로를 specs/results/<명세>/<모듈>.itf.json에 남긴다
// - 지켜짐(hold)을 기대한 검사는 위반이 없어야, 반례(violate)를 기대한 변형은 그 불변식의 반례가 나와야 통과한다(검사가 살아 있는지)
// - 명세가 모델 기반 시험과 이어져 있으면(specs.json의 mbt, wbs 2.3.4·V-T40) 형식 검사 때 명세 step의 동작 이름과 시험 명령 이름(SPEC_ACTIONS)을 견주고,
//   재생용 동작 기록이 지금 명세로 만든 것인지 본다. traces는 그 기록을 다시 만든다(quint run --mbt --out-itf)
// 쓰는 법: node tools/spec-check/spec-check.mjs <typecheck|pr|full|traces|matrix> [--spec 이름] [--write]
//   일부만 돌릴 때: --shard 묶음 --check 모듈(검사 목록에서 shard가 같은 검사끼리 한 묶음이고, 적지 않으면 default). 이때는 --write 대신 --out 폴더(저장소 안)에 쓴다
//   CI는 오래 걸리는 검사를 묶음별 잡으로 나눈다(ADR-0187): matrix --mode pr|full [--only 명세[:묶음]]이 그 잡 목록(JSON)을 낸다
//   Quint는 QUINT_BIN(cli.js 경로) 또는 tools/spec-check/node_modules의 것을 쓴다. TLC는 java가 PATH에 있어야 한다
//   이 PC(Windows)에서는 컨테이너로 돌린다: node tools/spec-check/run-local.mjs <같은 인자>
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PINS, ensureQuintTools } from './fetch-tools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

// ---- 목록 ----
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---- 모델 기반 시험과 잇기(wbs 2.3.4, docs/verification.md §2.4, V-T40) ----
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** 명세 `action step`이 고르는 동작 이름(선언된 action 가운데 step 본문에 나오는 것, 이름순) */
export function stepActions(text) {
  // 주석 안의 중괄호를 세지 않게 줄 주석부터 지운다
  const src = text.replace(/\/\/.*$/gm, '');
  const at = src.search(/^\s*action\s+step\s*=/m);
  if (at < 0) throw new Error('action step이 없다');
  const open = src.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i >= 0 && i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('action step의 중괄호가 닫히지 않는다');
  const body = src.slice(open, end + 1);
  const declared = new Set([...src.matchAll(/^\s*action\s+([A-Za-z_][A-Za-z0-9_]*)/gm)].map((x) => x[1]).filter((n) => n !== 'step' && n !== 'init'));
  return [...new Set([...body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)].map((x) => x[1]).filter((n) => declared.has(n)))].sort();
}

/** 모델 기반 시험 파일의 `export const SPEC_ACTIONS = [...]` 이름 목록(적힌 순서 그대로) */
export function mbtActions(src) {
  const m = src.match(/export const SPEC_ACTIONS\s*=\s*\[([^\]]*)\]/);
  if (!m) throw new Error('SPEC_ACTIONS가 없다');
  return [...m[1].replace(/\/\/.*$/gm, '').matchAll(/'([^']+)'|"([^"]+)"/g)].map((x) => x[1] ?? x[2]);
}

// mbt: { actions: 시험 명령 이름 파일, traces: 재생용 동작 기록 폴더, modules: [{ main, traces: 기록 수 }] }.
// 이름 목록이 다르면 명세가 바뀌었는데 시험이 따라가지 않은 것이라 병합을 막는다(이름만 같고 뜻이 다른 것은 재생 시험이 잡는다)
function checkMbt(s, src, readFile, fail, { traceHash = true } = {}) {
  const mb = s.mbt;
  if (typeof mb?.actions !== 'string' || typeof mb?.traces !== 'string' || !Array.isArray(mb.modules) || mb.modules.length === 0) {
    fail(`${s.name}: mbt는 { actions, traces, modules } 다`);
  }
  for (const x of mb.modules) {
    if (!NAME.test(x?.main ?? '') || !Number.isInteger(x.traces) || x.traces <= 0) fail(`${s.name}: mbt.modules는 { main: 모듈, traces: 양의 정수 } 목록이다`);
    if (!new RegExp(`^\\s*module\\s+${x.main}\\s*\\{`, 'm').test(src)) fail(`${s.name}: mbt 모듈 ${x.main}가 ${s.file}에 없다`);
  }
  let have;
  try {
    have = mbtActions(readFile(mb.actions));
  } catch (e) {
    fail(`${s.name}: 모델 기반 시험 명령 이름(${mb.actions})을 읽지 못했다: ${e.message}`);
  }
  const want = stepActions(src);
  const dup = have.filter((n, i) => have.indexOf(n) !== i);
  const onlySpec = want.filter((n) => !have.includes(n));
  const onlyTest = have.filter((n) => !want.includes(n));
  if (dup.length || onlySpec.length || onlyTest.length) {
    fail(`${s.name}: 명세 step의 동작 이름과 모델 기반 시험 명령 이름(${mb.actions})이 다르다(V-T40). 명세에만: ${onlySpec.join(', ') || '없음'}, 시험에만: ${onlyTest.join(', ') || '없음'}${dup.length ? `, 두 번: ${dup.join(', ')}` : ''}`);
  }
  // traces 명령은 기록을 다시 만들므로 지금 기록이 낡았는지 보지 않는다
  if (!traceHash) return;
  let man;
  try {
    man = JSON.parse(readFile(`${mb.traces}/manifest.json`));
  } catch {
    fail(`${s.name}: 재생용 동작 기록 목록(${mb.traces}/manifest.json)이 없다. node tools/spec-check/run-local.mjs traces --spec ${s.name}로 만든다`);
  }
  const again = `node tools/spec-check/run-local.mjs traces --spec ${s.name}로 다시 만든다`;
  if (man.specSha256 !== sha256(src)) fail(`${s.name}: 재생용 동작 기록(${mb.traces})이 지금 명세로 만든 것이 아니다. ${again}`);
  // 기록 형식(mbt::)은 Quint의 실험 기능이라 판이 바뀌면 다시 만들고 재생이 읽는지 본다(docs/verification.md §2.4)
  if (man.quint !== PINS.quint) fail(`${s.name}: 재생용 동작 기록을 Quint ${man.quint}로 만들었다(지금 ${PINS.quint}). ${again}`);
  if (JSON.stringify(man.modules) !== JSON.stringify(mb.modules.map(({ main, traces }) => ({ main, traces })))) fail(`${s.name}: 재생용 동작 기록의 모듈 목록이 specs.json의 mbt.modules와 다르다. ${again}`);
}

/** specs/specs.json을 읽고 명세 파일과 맞는지 본다. readFile(경로)는 저장소 기준 경로를 받는다. traceHash가 거짓이면 재생용 기록의 명세 해시를 보지 않는다 */
export function loadManifest(text, readFile, { traceHash = true } = {}) {
  const m = JSON.parse(text);
  const fail = (msg) => {
    throw new Error(`specs/specs.json: ${msg}`);
  };
  const sim = m.simulation ?? fail('simulation이 없다');
  for (const k of ['samples', 'maxSteps']) if (!Number.isInteger(sim[k]) || sim[k] <= 0) fail(`simulation.${k}는 양의 정수다`);
  if (typeof sim.seed !== 'string' || !sim.seed) fail('simulation.seed가 없다');
  if (!Array.isArray(m.specs) || m.specs.length === 0) fail('specs가 비었다');
  const names = new Set();
  for (const s of m.specs) {
    for (const k of ['name', 'file', 'title', 'scope']) if (typeof s[k] !== 'string' || !s[k]) fail(`${s.name ?? '?'}: ${k}가 없다`);
    // 이름은 결과 파일·반례 폴더 이름(specs/results/<이름>)이 된다: 식별자 모양만 받고, 겹치면 결과가 서로 덮인다(wbs 0.9.2)
    if (!NAME.test(s.name)) fail(`${s.name}: name은 영문자·숫자·밑줄로 된 식별자다`);
    // 대소문자만 다른 이름도 겹친다(NTFS와 그 위의 바인드 마운트는 대소문자를 가리지 않는다, 코드 리뷰 2026-11-02)
    if (names.has(s.name.toLowerCase())) fail(`명세 이름 ${s.name}를 두 번 적었다(대소문자는 가리지 않는다)`);
    names.add(s.name.toLowerCase());
    if (!Array.isArray(s.adrs) || s.adrs.some((a) => !/^\d{4}$/.test(a))) fail(`${s.name}: adrs는 네 자리 ADR 번호 목록이다`);
    const src = readFile(s.file);
    const modules = new Set([...src.matchAll(/^\s*module\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm)].map((x) => x[1]));
    const vals = new Set([...src.matchAll(/^\s*val\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((x) => x[1]));
    if (!Array.isArray(s.invariants) || s.invariants.length === 0) fail(`${s.name}: invariants가 비었다`);
    for (const i of s.invariants) if (!NAME.test(i) || !vals.has(i)) fail(`${s.name}: 불변식 ${i}가 ${s.file}에 없다`);
    // temporal은 진행성(결국 일어남)을 보는 시간 논리 속성 이름 목록이다(wbs 0.9.3). 명세 파일에 `temporal 이름 =`으로 있어야 한다
    const temporals = new Set([...src.matchAll(/^\s*temporal\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((x) => x[1]));
    if ('temporal' in s) {
      if (!Array.isArray(s.temporal) || s.temporal.length === 0 || s.temporal.some((t) => !NAME.test(t))) fail(`${s.name}: temporal은 시간 논리 속성 이름(식별자) 목록이다`);
      for (const t of s.temporal) if (!temporals.has(t)) fail(`${s.name}: 진행성 속성 ${t}가 ${s.file}에 없다`);
    }
    if ('mbt' in s) checkMbt(s, src, readFile, fail, { traceHash });
    if (!Array.isArray(s.checks) || s.checks.length === 0) fail(`${s.name}: checks가 비었다`);
    const seen = new Set();
    for (const c of s.checks) {
      if (!NAME.test(c.main ?? '') || !modules.has(c.main)) fail(`${s.name}: 모듈 ${c.main}가 ${s.file}에 없다`);
      // 반례 파일(specs/results/<명세>/<모듈>.tlc.txt)도 대소문자를 가리지 않는 곳에 쓰이므로 소문자로 견준다(코드 리뷰 2026-11-02)
      if (seen.has(c.main.toLowerCase())) fail(`${s.name}: 모듈 ${c.main}를 두 번 적었다(대소문자는 가리지 않는다)`);
      seen.add(c.main.toLowerCase());
      if (c.expect !== 'hold' && c.expect !== 'violate') fail(`${s.name}/${c.main}: expect는 hold 또는 violate다`);
      if (typeof c.why !== 'string' || !c.why) fail(`${s.name}/${c.main}: why(까닭)가 없다`);
      // shard는 CI가 전수 검사를 잡 여럿으로 나눌 때 같은 잡에서 차례로 돌 검사끼리 붙이는 이름이다(적지 않으면 default). 오래 걸리는 검사를 따로 둘 때 적는다(ADR-0187)
      if ('shard' in c && (typeof c.shard !== 'string' || !NAME.test(c.shard))) fail(`${s.name}/${c.main}: shard는 영문자·숫자·밑줄로 된 식별자다`);
      // 진행성 검사는 그 속성 하나만 TLC로 본다. 시뮬레이션(quint run)은 시간 논리를 보지 않아 tlc: false·samples가 뜻이 없고,
      // 불변식과 섞으면 어느 쪽 반례인지 갈리지 않는다(wbs 0.9.3)
      if ('temporal' in c) {
        if (!Array.isArray(s.temporal) || !s.temporal.includes(c.temporal)) fail(`${s.name}/${c.main}: 진행성 속성 ${c.temporal}는 이 명세의 temporal에 없다`);
        for (const k of ['tlc', 'samples', 'simulate', 'invariant', 'invariants']) {
          if (k in c && !(k === 'tlc' && c.tlc === true)) fail(`${s.name}/${c.main}: 진행성(temporal) 검사에는 ${k}를 적지 않는다(TLC로 그 속성 하나만 본다)`);
        }
        continue;
      }
      // tlc: false는 전수 검사가 너무 큰 범위(정본 범위 전체 등)라 시뮬레이션으로만 보는 검사다
      if ('tlc' in c && typeof c.tlc !== 'boolean') fail(`${s.name}/${c.main}: tlc는 true 또는 false다`);
      // samples는 반례가 드문 변형의 시뮬레이션 횟수를 늘릴 때만 적는다(wbs 0.9.2)
      if ('samples' in c && (!Number.isInteger(c.samples) || c.samples <= 0)) fail(`${s.name}/${c.main}: samples는 양의 정수다`);
      // simulate: false는 반례 경로가 길어 PR 시뮬레이션이 닿지 않는 검사를 전수 검사(주 1회·관련 ADR 변경)에서만 보게 한다(wbs 0.9.3).
      // tlc: false와 함께면 아무 검사도 돌지 않고, samples와 함께면 뜻이 없다
      if ('simulate' in c) {
        if (c.simulate !== false) fail(`${s.name}/${c.main}: simulate는 false만 적는다(적지 않으면 시뮬레이션도 돈다)`);
        if (c.tlc === false || 'samples' in c) fail(`${s.name}/${c.main}: simulate false는 tlc false·samples와 함께 쓰지 않는다`);
      }
      // invariants는 지켜짐 검사가 일부만 볼 때 적는다(모형에 전제로 넣어 늘 참인 불변식을 '검사해서 지켜짐'으로 남기지 않게, 코드 리뷰 2026-11-02)
      if ('invariants' in c) {
        if (c.expect !== 'hold') fail(`${s.name}/${c.main}: invariants는 지켜짐 검사에만 적는다(반례 검사는 invariant 하나)`);
        if (!Array.isArray(c.invariants) || c.invariants.length === 0 || c.invariants.some((i) => !s.invariants.includes(i))) {
          fail(`${s.name}/${c.main}: invariants는 이 명세의 invariants 가운데 하나 이상이다`);
        }
      }
      if (c.expect === 'violate') {
        if (!c.invariant) fail(`${s.name}/${c.main}: 반례를 기대하면 invariant(깨질 불변식)를 적는다`);
        if (!s.invariants.includes(c.invariant)) fail(`${s.name}/${c.main}: ${c.invariant}는 이 명세의 invariants에 없다`);
      }
    }
    if (!s.checks.some((c) => c.expect === 'hold')) fail(`${s.name}: expect hold인 검사가 하나는 있어야 한다`);
    // 진행성 검사는 불변식을 보지 않으므로 세지 않는다(코드 리뷰 2026-11-02)
    if (!s.checks.some((c) => c.expect === 'hold' && c.tlc !== false && !c.temporal)) fail(`${s.name}: 지켜짐을 기대하는 불변식 전수 검사(tlc가 false가 아니고 진행성이 아닌 hold)가 하나는 있어야 한다`);
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
  // 맨 끝 요약 줄만 본다. 'Progress(17) …: 1,341 states generated, 180 distinct …' 같은 진행 줄의 쉼표 숫자 뒤쪽을 읽지 않게(코드 리뷰 2026-11-02)
  const states = [...text.matchAll(/^(\d+) states generated, (\d+) distinct states found, (\d+) states left on queue\./gm)].at(-1);
  return {
    tlc: text.match(/^(TLC2 Version .*)$/m)?.[1].trim() ?? null,
    statesGenerated: states ? Number(states[1]) : null,
    distinctStates: states ? Number(states[2]) : null,
    statesLeft: states ? Number(states[3]) : null,
    depth: num(/The depth of the complete state graph search is (\d+)\./, text),
    fingerprintCollision: text.match(/calculated \(optimistic\):\s+val = (\S+)/)?.[1] ?? null,
    completed: /Model checking completed\. No error has been found\./.test(text),
    // 진행성 위반은 'Error: Temporal property … was violated.'로 찍힌다(wbs 0.9.3, 2026-11-02 실행에서 확인)
    violated: /Error: Invariant \S+ is violated/.test(text) || /Error: Temporal propert(y|ies) .*(was|were) violated/.test(text),
  };
}

/** TLC 출력에서 반례 경로(위반 알림과 상태 목록)만 잘라 낸다. 반례가 없으면 null */
export function extractTlcTrace(text) {
  const start = text.search(/Error: (Invariant |Temporal propert)/);
  if (start < 0) return null;
  const rest = text.slice(start);
  // 진행성 반례는 상태 목록 뒤에 'Finished checking temporal properties'가 먼저 온다
  const end = rest.search(/^(\d+ states generated, |Finished checking temporal properties)/m);
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
  // 노린 것: 불변식 검사는 invariant, 진행성 검사는 temporal(시간 논리 속성 이름)
  const target = check.temporal ?? check.invariant;
  if (check.expect === 'hold') {
    if (outcome.violated) return { ok: false, message: `${check.main}: 지켜져야 하는데 반례가 나왔다(${outcome.failing.join(', ') || '불변식'})` };
    if (mode === 'verify' && !outcome.completed) return { ok: false, message: `${check.main}: TLC가 끝까지 돌지 않았다(전수 검사 아님)` };
    return { ok: true, message: `${check.main}: 위반 없음` };
  }
  if (!outcome.violated) return { ok: false, message: `${check.main}: ${target}의 반례가 나와야 하는데 없다(검사가 살아 있지 않다)` };
  if (outcome.failing.length > 0 && !outcome.failing.includes(target)) {
    return { ok: false, message: `${check.main}: 노린 ${target}가 아니라 ${outcome.failing.join(', ')}가 깨졌다` };
  }
  return { ok: true, message: `${check.main}: 기대한 반례(${target})` };
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
export function resultRecord({ spec, specSha256, commit, tools, now, checks, subset }) {
  return {
    spec: spec.name,
    file: spec.file,
    specSha256,
    commit,
    date: kstTimestamp(now),
    scope: spec.scope,
    ...(subset && (subset.shard || subset.check) ? { subset } : {}),
    adrs: spec.adrs,
    tools,
    ok: checks.every((c) => c.verdict.ok),
    checks: checks.map((c) => ({
      main: c.check.main,
      expect: c.check.expect,
      ...(c.check.invariant ? { targetInvariant: c.check.invariant } : {}),
      ...(c.check.temporal ? { temporal: c.check.temporal } : {}),
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

/** 검사 하나가 보는 불변식: 반례 검사는 노린 것 하나, 지켜짐 검사는 검사의 invariants(없으면 명세의 전부) */
export function invariantsFor(s, c) {
  if (c.temporal) return [];
  return c.expect === 'violate' ? [c.invariant] : (c.invariants ?? s.invariants);
}

/** PR 시뮬레이션이 도는 검사인지: 진행성 검사는 TLC로만 본다(quint run은 시간 논리를 보지 않는다), simulate false도 전수 검사에서만(wbs 0.9.3) */
export function runsInSimulation(c) {
  return !c.temporal && c.simulate !== false;
}
const invariantsOf = invariantsFor;

export const DEFAULT_SHARD = 'default';

/** 검사가 속한 묶음 이름: 같은 묶음끼리 CI 잡 하나에서 차례로 돈다(ADR-0187) */
export function shardOf(c) {
  return c.shard ?? DEFAULT_SHARD;
}

/**
 * CI 잡 목록(GitHub 행렬). pr은 명세마다 잡 하나다(시뮬레이션은 짧다). full은 묶음이 둘 이상인 명세만 묶음마다 잡 하나이고,
 * 묶음이 하나뿐인 명세는 나누지 않고(shard '') 통째로 돈다. only는 '명세' 또는 '명세:묶음' 하나만 남긴다(수동 실행으로 한 묶음만 다시 돌릴 때)
 */
export function matrixFor(m, mode, only = '') {
  if (mode !== 'pr' && mode !== 'full') throw new Error(`mode는 pr 또는 full이다: ${mode}`);
  const [onlySpec, onlyShard] = only ? only.split(':') : [];
  const include = [];
  for (const s of m.specs) {
    if (onlySpec && s.name !== onlySpec) continue;
    const shards = [...new Set(s.checks.map(shardOf))];
    for (const shard of mode === 'full' && shards.length > 1 ? shards : ['']) {
      if (onlyShard && shard !== onlyShard) continue;
      include.push({ spec: s.name, shard });
    }
  }
  if (include.length === 0) throw new Error(`맞는 잡이 없다(only=${only})`);
  return { include };
}

export const OUT_DEFAULT = 'specs/results';

/** --out은 저장소 안의 상대 폴더여야 한다(경로 밖으로 쓰지 않게) */
export function safeOut(out) {
  if (out.trim() === '' || isAbsolute(out) || /^[A-Za-z]:/.test(out) || out.split(/[\\/]/).includes('..')) throw new Error(`--out은 저장소 안의 상대 폴더다: ${out}`);
  return out.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * 명령줄 값을 확인한다. 일부만 돌리면(--shard·--check) 저장소의 결과 파일(specs/results)을 일부만 덮지 않도록 --write를 막고 --out 폴더를 쓰게 한다.
 * part는 일부 결과 파일 이름(<명세>.<part>.json)이 된다
 */
export function resolveRun(values) {
  const partial = Boolean(values.shard || values.check);
  if (values.write && values.out) throw new Error('--write와 --out은 함께 쓰지 않는다(--write는 specs/results에 쓴다)');
  if (values.write && partial) throw new Error('--write는 명세 전체의 결과를 갱신한다. 일부만 돌릴 때는 --shard·--check와 함께 --out 폴더를 쓴다');
  const out = values.out ? safeOut(values.out) : values.write ? OUT_DEFAULT : null;
  if (partial && out === OUT_DEFAULT) throw new Error(`일부만 돌린 결과를 ${OUT_DEFAULT}에 쓰지 않는다(저장소의 결과 파일이 일부만 바뀐다). 다른 폴더를 --out으로 준다`);
  return {
    out,
    partial,
    part: [values.shard, values.check].filter(Boolean).join('.'),
    subset: { ...(values.shard ? { shard: values.shard } : {}), ...(values.check ? { check: values.check } : {}) },
  };
}

/** 검사 하나의 시뮬레이션 설정: 목록의 simulation에 검사별 samples를 덮어쓴다 */
export function simulationFor(m, c) {
  return { samples: c.samples ?? m.simulation.samples, maxSteps: m.simulation.maxSteps, seed: m.simulation.seed };
}

// 검사 하나를 시뮬레이션으로(고정 시드, 스레드 하나라 같은 커밋은 같은 결과)
function simulateOne(m, s, c) {
  const invs = invariantsOf(s, c);
  const cfg = simulationFor(m, c);
  const t0 = Date.now();
  const { out } = quint(['run', s.file, `--main=${c.main}`, '--invariants', ...invs, `--max-samples=${cfg.samples}`,
    `--max-steps=${cfg.maxSteps}`, `--seed=${cfg.seed}`, '--n-threads=1', '--verbosity=2'], { allowFail: true });
  const seconds = (Date.now() - t0) / 1000;
  const sim = { ...parseSimulation(out), ...cfg };
  const verdict = judge(c, sim, 'simulate');
  console.log(`${verdict.ok ? 'ok  ' : 'FAIL'} ${s.name} 시뮬레이션 ${cfg.samples}회 ${verdict.message} (${seconds.toFixed(1)}초)`);
  return { check: c, invariants: invs, sim, seconds, verdict };
}

// 검사 하나를 TLC 전수 검사로. 반례를 기대하는 변형은 노린 불변식 하나만 본다(너비 우선이라 가장 짧은 반례가 나온다)
function tlcOne(m, s, c, { staging, dir }) {
  const invs = invariantsOf(s, c);
  const t0 = Date.now();
  const what = c.temporal ? [`--temporal=${c.temporal}`] : ['--invariants', ...invs];
  const { out } = quint(['verify', s.file, '--backend=tlc', `--main=${c.main}`, ...what, '--verbosity=3'], { allowFail: true });
  const seconds = (Date.now() - t0) / 1000;
  const tlc = parseTlc(out);
  if (!tlc.completed && !tlc.violated) throw new Error(`${s.name}/${c.main}: TLC가 끝나지 않았다:
${out.slice(-4000)}`);
  const failing = !tlc.violated ? [] : c.temporal ? [c.temporal] : invs.length === 1 ? invs : invs.filter((i) => out.includes(`❌ ${i}`));
  const verdict = judge(c, { violated: tlc.violated, failing, completed: tlc.completed });
  let counterexample;
  let tlcTrace;
  if (tlc.violated && staging) {
    // TLC가 찾은 가장 짧은 반례(너비 우선)는 TLC 출력 그대로 <모듈>.tlc.txt에 남긴다. Quint의 TLC 연결은 --out-itf를 쓰지 않아,
    // 기계가 읽는 동작 기록(ITF, 모델 기반 시험 재생용)은 같은 불변식의 반례를 고정 시드 시뮬레이션으로 다시 찾아 남긴다(더 길 수 있다)
    // 파일은 준비 폴더(staging)에 쓰고, 모든 검사가 끝나 명세 해시가 같을 때만 verify가 결과 폴더로 옮긴다(코드 리뷰 2026-11-02).
    // 결과 파일에 적는 경로는 옮긴 뒤의 자리다
    const trace = extractTlcTrace(out);
    if (trace) {
      tlcTrace = `${dir}/${c.main}.tlc.txt`;
      writeFileSync(join(staging, `${c.main}.tlc.txt`), trace);
    }
    // 진행성 반례는 시뮬레이션이 다시 찾지 못한다(시간 논리를 보지 않는다). TLC 경로만 남긴다
    if (c.temporal) {
      console.log(`${verdict.ok ? 'ok  ' : 'FAIL'} ${s.name} TLC ${verdict.message} (진행성, 상태 ${tlc.distinctStates ?? '?'}개, ${seconds.toFixed(1)}초)`);
      return { check: c, invariants: invs, tlc, seconds, verdict, tlcTrace };
    }
    const itfStage = relative(REPO, join(staging, `${c.main}.itf.json`)).split(sep).join('/');
    // --out-itf는 위반이 없어도 기록을 쓴다. 출력으로 실제 반례인지 보고 아니면 지운다(코드 리뷰 2026-11-02)
    const cfg = simulationFor(m, c);
    const re = quint(['run', s.file, `--main=${c.main}`, '--invariants', ...invs, `--max-samples=${cfg.samples}`, `--max-steps=${cfg.maxSteps}`,
      `--seed=${cfg.seed}`, '--n-threads=1', '--mbt', `--out-itf=${itfStage}`, '--verbosity=2'], { allowFail: true });
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

/**
 * 검사들(todo)을 돌려 결과를 낸다. out(저장소 기준 폴더)을 주면 결과 파일과 반례 경로를 거기에 쓴다. 명세 전체(part 없음)는 지난 반례 폴더를 이번 것으로 통째로 바꾸고,
 * 일부(part: --shard·--check)는 <명세>.<part>.json에 쓰고 반례는 폴더에 더한다(다른 묶음의 반례를 지우지 않는다)
 */
function verify(m, s, { checks: todo, out, part, subset }) {
  // 커밋과 명세 해시는 검사 전에 읽는다(검사가 쓰는 파일이 '고친 채'로 보이지 않게). 검사 도중 명세가 바뀌면 실패한다(코드 리뷰 2026-11-02)
  const commit = gitCommit();
  const specHash = () => createHash('sha256').update(readFileSync(join(REPO, s.file))).digest('hex');
  const specSha256 = specHash();
  const dir = out ? `${out}/${s.name}` : null;
  const staging = out ? join(REPO, out, `.staging-${s.name}${part ? `-${part}` : ''}`) : null;
  if (staging) {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
  }
  let checks;
  try {
    checks = todo.map((c) => (c.tlc === false ? simulateOne(m, s, c) : tlcOne(m, s, c, { staging, dir })));
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
    subset,
  });
  if (out) {
    const file = join(REPO, out, part ? `${s.name}.${part}.json` : `${s.name}.json`);
    const final = join(REPO, out, s.name);
    if (!part) {
      // 반례 폴더를 이번 실행의 것으로 통째로 바꾼다(지난 실행의 반례가 섞이지 않게)
      rmSync(final, { recursive: true, force: true });
      renameSync(staging, final);
    } else {
      // 일부만 돌렸으므로 다른 묶음의 반례는 그대로 두고 이번 것만 더한다
      mkdirSync(final, { recursive: true });
      for (const f of readdirSync(staging)) renameSync(join(staging, f), join(final, f));
      rmSync(staging, { recursive: true, force: true });
    }
    writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
    console.log(`기록: ${relative(REPO, file)}`);
  }
  return rec;
}

// 재생용 동작 기록(wbs 2.3.4, V-T40): mbt.modules마다 지켜짐 시뮬레이션의 동작 기록(--mbt가 걸음마다 고른 동작과 nondet 값을 더한다)을
// 고정 시드로 내고, 명세 해시와 Quint 판을 목록(manifest.json)에 적는다. Quint가 --mbt를 실험 기능으로 두므로 판을 올려 형식이 바뀌면
// 재생 시험을 멈추고 이름 목록 검사만 남긴다(docs/verification.md §2.4)
function writeTraces(m, s) {
  const mb = s.mbt;
  const dir = join(REPO, mb.traces);
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (f.endsWith('.itf.json')) rmSync(join(dir, f));
  const files = [];
  for (const x of mb.modules) {
    const out = `${mb.traces}/${x.main}_{seq}.itf.json`;
    const r = quint(['run', s.file, `--main=${x.main}`, '--invariants', ...s.invariants, `--max-samples=${x.traces}`, `--n-traces=${x.traces}`,
      `--max-steps=${m.simulation.maxSteps}`, `--seed=${m.simulation.seed}`, '--n-threads=1', '--mbt', `--out-itf=${out}`, '--verbosity=2'], { allowFail: true });
    if (!/No violation found/.test(r.out)) throw new Error(`${s.name}/${x.main}: 지켜짐 시뮬레이션이 아니다(기록을 남기지 않는다):\n${r.out.slice(-2000)}`);
    // queue_proposed_가 queue_proposed_full_*까지 잡지 않게 번호만 붙은 이름으로 고른다
    const own = new RegExp(`^${x.main}_\\d+\\.itf\\.json$`);
    const made = readdirSync(dir).filter((f) => own.test(f)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    if (made.length !== x.traces) throw new Error(`${s.name}/${x.main}: 동작 기록이 ${x.traces}개가 아니라 ${made.length}개 생겼다`);
    files.push(...made);
    console.log(`기록 ${s.name} ${x.main}: ${made.length}개`);
  }
  const manifest = {
    $comment: `재생용 동작 기록(wbs 2.3.4, V-T40). node tools/spec-check/run-local.mjs traces --spec ${s.name}가 만든다. 손으로 고치지 않는다`,
    spec: s.file,
    specSha256: createHash('sha256').update(readFileSync(join(REPO, s.file))).digest('hex'),
    quint: PINS.quint,
    modules: mb.modules.map(({ main, traces }) => ({ main, traces })),
    seed: m.simulation.seed,
    maxSteps: m.simulation.maxSteps,
    files,
  };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      spec: { type: 'string' },
      write: { type: 'boolean', default: false },
      shard: { type: 'string' },
      check: { type: 'string' },
      out: { type: 'string' },
      mode: { type: 'string' },
      only: { type: 'string' },
    },
  });
  const cmd = positionals[0];
  if (!['typecheck', 'pr', 'full', 'traces', 'matrix'].includes(cmd)) {
    console.error('명령: typecheck | pr | full | traces | matrix [--spec 이름] [--shard 묶음] [--check 모듈] [--write | --out 폴더]');
    process.exit(2);
  }
  const run = resolveRun(values);
  // traces는 기록을 다시 만드는 명령이라 지금 기록의 명세 해시는 보지 않는다. matrix는 목록만 읽는다
  const m = loadManifest(readFileSync(join(REPO, 'specs', 'specs.json'), 'utf8'), (f) => readFileSync(join(REPO, f), 'utf8'), { traceHash: cmd !== 'traces' && cmd !== 'matrix' });
  if (cmd === 'matrix') {
    console.log(JSON.stringify(matrixFor(m, values.mode ?? 'full', values.only ?? '')));
    return;
  }
  const specs = m.specs.filter((s) => !values.spec || s.name === values.spec);
  if (specs.length === 0) throw new Error(`명세 ${values.spec}가 목록에 없다`);
  // Quint가 해시 확인 없이 받지 않게, 검사 전에 도구 해시를 매번 다시 본다(맞으면 받지 않는다, 코드 리뷰 2026-11-02)
  if (cmd !== 'typecheck') await ensureQuintTools();
  const pick = (s) => s.checks.filter((c) => (!values.shard || shardOf(c) === values.shard) && (!values.check || c.main === values.check));
  let ok = true;
  let ran = 0;
  for (const s of specs) {
    const mine = pick(s);
    if (run.partial && (cmd === 'pr' || cmd === 'full') && mine.length === 0) {
      console.log(`건너뜀 ${s.name}: 고른 묶음·검사가 없다`);
      continue;
    }
    quint(['typecheck', s.file]);
    console.log(`ok   ${s.name} 형식 검사`);
    if (cmd === 'pr') {
      for (const c of mine.filter((x) => !runsInSimulation(x))) {
        console.log(`건너뜀 ${s.name} ${c.main}: ${c.temporal ? `진행성(${c.temporal})은` : '시뮬레이션이 닿지 않는 반례(simulate false)는'} 전수 검사(full)에서만 본다`);
      }
      ok = mine.filter(runsInSimulation).map((c) => simulateOne(m, s, c)).every((r) => r.verdict.ok) && ok;
      ran += mine.length;
    }
    if (cmd === 'full') {
      if (run.partial) console.log(`묶음 ${s.name}: 검사 ${mine.length}개(${mine.map((c) => c.main).join(', ')})`);
      ok = verify(m, s, { checks: mine, ...run }).ok && ok;
      ran += mine.length;
    }
    if (cmd === 'traces') {
      if (!s.mbt) console.log(`건너뜀 ${s.name}: 모델 기반 시험(mbt)이 없다`);
      else writeTraces(m, s);
    }
  }
  if (run.partial && (cmd === 'pr' || cmd === 'full') && ran === 0) throw new Error('--shard·--check에 맞는 검사가 없다');
  if (!ok) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
