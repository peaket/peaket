// BAT-086 데모 재현 스크립트의 단위 시험(V-T7 ①~③·⑤~⑦, DM-08·DM-09, CP-01).
// 정본: docs/review/plans/BAT-086.md §5(공개 인터페이스)·§6(판정 항목별 시험)·§9(틀린 구현), docs/verification.md V-T7.
// - 실제 kind 클러스터·Docker는 부르지 않는다. V-T7 ④의 실제 실행은 `node tools/local/demo.mjs all`이 맡고,
//   이 파일은 그 실행이 남긴 측정 파일과 재생기 구조를 본다. kind e2e는 CI에 넣지 않는다(계획 §10).
// - 닫힌 실패(선행 없음·파드 미준비·모르는 시나리오)는 가짜 뿌리·가짜 kubectl로 본다. 클러스터 명령 기록 0을 함께 확인한다.
// 실행(저장소 뿌리): node --test "tools/local/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { parseArgs, doctorChecks, DEMO_CLUSTER, allResult, measurementHistoryPath, playMeasurementPath, findChromium, lastOutputLine } from './demo.mjs';
import { SCENARIOS, SCENARIO_ORDER, REQUIRED_CHECKS, validateScenarios, publicPlan, readD5Scenarios } from './demo/scenarios.mjs';
import { runScenarios } from './demo/runner.mjs';
import { checkCloudPlan, CLOUD_PLAN_FILE, MAX_TTL_HOURS, REQUIRED_CLEANUP } from './demo/cloud-plan.mjs';
import { breakOpenApi, compatPlan, runCompat, DEMO_TAG } from './demo/compat.mjs';
import { measurementText, redact, writeMeasurement } from './demo/measure.mjs';
import { DEMO_WORKLOADS, demoExpectedWorkloads, demoGatewayObjects, demoOrigins } from './demo-objects.mjs';
import { demoOriginSecurityPatch, readGatewayObjects } from './gateway-objects.mjs';
import { DEMO_BUILD_ARGS, DEMO_IMAGES, dockerBuildArgs } from './demo-images.mjs';
import { DEMO_SEED_FILE } from './demo-auth.mjs';
import { checkSeed } from './demo-seed.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEMO_MJS = join(REPO, 'tools', 'local', 'demo.mjs');
const RUNNER_MJS = join(REPO, 'tools', 'local', 'demo', 'runner.mjs');
const MEASUREMENT = join(REPO, 'docs', 'review', 'measurements', 'BAT-086-demo.md');
const GATEWAY_DIR = join(REPO, 'deploy', 'gateways');

const tempDir = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const runDemo = (args, env = {}) =>
  spawnSync(process.execPath, [DEMO_MJS, ...args], { cwd: REPO, encoding: 'utf8', timeout: 180_000, env: { ...process.env, ...env } });

/** 러너의 시나리오 함수 본문(S7 등)을 꺼낸다. 다음 `  },` 줄까지다 */
function runnerBlock(source, name) {
  const start = source.indexOf(`  async ${name}(ctx) {`);
  assert.ok(start >= 0, `runner.mjs에서 ${name} 흐름을 찾지 못했다`);
  const end = source.indexOf('\n  },\n', start);
  assert.ok(end > start, `${name} 흐름의 끝을 찾지 못했다`);
  // 주석 처리로 통과하지 않게 주석 줄은 뺀다(틀린 구현 주입 확인)
  return source
    .slice(start, end)
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

/** 최상위 함수 하나의 본문(중괄호 대신 다음 줄머리 `}`로 끊는다). */
function functionBlock(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `runner.mjs에서 ${signature}를 찾지 못했다`);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, `${signature}의 끝을 찾지 못했다`);
  return source.slice(start, end);
}

/**
 * doctor가 보는 가짜 뿌리. `without`에 넣은 선행만 뺀다.
 * kubectl은 기록만 하는 가짜다(doctor가 부르면 기록이 남는다). 다른 도구는 빈 파일이면 충분하다.
 */
function fakeRoot(without = new Set()) {
  const root = tempDir('peaket-bat086-doctor-');
  const put = (rel, text = '') => {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  if (!without.has('seed')) put('deploy/envs/demo/seed/base.yaml', 'version: 1\n');
  for (const w of DEMO_WORKLOADS) {
    if (without.has('overlay') || without.has(`overlay:${w.name}`)) continue;
    put(`deploy/envs/local/demo/${w.name}.yaml`, 'name: demo\n');
  }
  if (!without.has('images')) put('tools/local/demo-images.mjs', 'export const DEMO_IMAGES = [];\n');
  if (!without.has('stage')) put('tools/local/cluster.mjs', '');
  if (!without.has('seed-script')) put('tools/local/demo-seed.mjs', '');
  if (!without.has('playwright')) put('tools/web-checks/node_modules/@playwright/test/package.json', '{}\n');
  // Playwright 브라우저 캐시(계획 리뷰 RV-09). 패키지만 있고 chromium이 없는 경우를 따로 만들 수 있게 한다
  const browsers = join(root, 'ms-playwright');
  if (!without.has('chromium')) put(`ms-playwright/chromium-1234/${process.platform === 'win32' ? 'chrome-win64/chrome.exe' : 'chrome-linux/chrome'}`);
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const t of ['docker', 'kind', 'helm']) {
    if (!without.has(`tool:${t}`)) writeFileSync(join(bin, t), '');
  }
  const calls = join(root, 'calls.txt');
  writeFileSync(calls, '');
  if (process.platform === 'win32') {
    // bare `kubectl`를 두지 않는다. findOnPath가 .CMD를 찾고, 실행되면 이 파일에 한 줄이 남는다
    if (!without.has('tool:kubectl')) writeFileSync(join(bin, 'kubectl.cmd'), '@echo off\r\necho %*>>"%PEAKET_FAKE_CALLS%"\r\n');
  } else {
    if (!without.has('tool:kubectl')) {
      writeFileSync(join(bin, 'kubectl'), '#!/bin/sh\necho "$@" >> "$PEAKET_FAKE_CALLS"\n', { mode: 0o755 });
    }
  }
  const env = { ...process.env, PATH: bin, PEAKET_TOOLS_DIR: join(root, '.cache', 'peaket-tools'), PEAKET_FAKE_CALLS: calls, PLAYWRIGHT_BROWSERS_PATH: browsers };
  return { root, bin, browsers, env, calls, text: () => readFileSync(calls, 'utf8') };
}

/**
 * `kubectl get deploy -A -o json`을 가로채는 `node:child_process` 가짜 모듈과 --import 훅.
 * 윈도우 .cmd 인용 문제를 피하고, 어떤 명령을 불렀는지 기록한다(클러스터는 부르지 않는다).
 */
function fakeKubectlHook(ready) {
  const dir = tempDir('peaket-bat086-kubectl-');
  const items = demoExpectedWorkloads().map((w) => ({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: w.name, namespace: w.namespace },
    status: { replicas: w.expected, readyReplicas: ready ? w.expected : 0, availableReplicas: ready ? w.expected : 0 },
  }));
  const jsonFile = join(dir, 'deployments.json');
  const calls = join(dir, 'calls.jsonl');
  writeFileSync(jsonFile, JSON.stringify({ apiVersion: 'v1', kind: 'List', items }));
  writeFileSync(calls, '');
  writeFileSync(
    join(dir, 'fake-child-process.mjs'),
    `import { appendFileSync, readFileSync } from 'node:fs';
const record = (exe, args) => appendFileSync(process.env.PEAKET_FAKE_KUBECTL_CALLS, JSON.stringify({ exe: String(exe), args: args.map(String) }) + '\\n');
export function spawnSync(exe, args = []) {
  const list = args.map(String);
  record(exe, list);
  if (list.includes('get') && list.includes('deploy')) {
    return { status: 0, signal: null, stdout: readFileSync(process.env.PEAKET_FAKE_KUBECTL_JSON, 'utf8'), stderr: '' };
  }
  return { status: 0, signal: null, stdout: '', stderr: '' };
}
export function execFileSync() { return ''; }
export function execSync() { return ''; }
export function spawn() { throw new Error('이 시험은 spawn을 쓰지 않는다'); }
`,
  );
  writeFileSync(
    join(dir, 'hook.mjs'),
    `import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const dir = process.env.PEAKET_FAKE_KUBECTL_DIR;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node:child_process') return { url: pathToFileURL(join(dir, 'fake-child-process.mjs')).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
`,
  );
  return {
    dir,
    env: { PEAKET_FAKE_KUBECTL_DIR: dir, PEAKET_FAKE_KUBECTL_JSON: jsonFile, PEAKET_FAKE_KUBECTL_CALLS: calls },
    calls: () => readFileSync(calls, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)),
    run: (args, env = {}) =>
      spawnSync(process.execPath, ['--import', pathToFileURL(join(dir, 'hook.mjs')).href, DEMO_MJS, ...args], {
        cwd: REPO,
        encoding: 'utf8',
        timeout: 180_000,
        env: { ...process.env, ...env },
      }),
  };
}

/** git 저장소 하나(작은 openapi.yaml만). compat 시험은 실제 저장소를 복제하지 않는다 */
function makeGitRepo() {
  const dir = tempDir('peaket-bat086-compat-repo-');
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')} → ${r.status}\n${r.stderr}`);
    return r.stdout;
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'test@peaket.test']);
  git(['config', 'user.name', 'BAT-086 test']);
  const file = join(dir, 'docs', 'api', 'openapi.yaml');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `openapi: 3.1.0
info: { title: BAT-086 compat, version: 1.0.0 }
paths: {}
components:
  schemas:
    Problem:
      type: object
      properties:
        type:
          type: string
        traceId:
          type: string
`,
  );
  git(['add', 'docs/api/openapi.yaml']);
  git(['commit', '-q', '-m', 'contract']);
  return { dir, git };
}

// ---------- V-T7 ① 시나리오 정의 ----------

test('V-T7 ① 시나리오 정의가 정본 d5 §10.6과 같고 필수 checks를 갖는다', () => {
  const d5 = readD5Scenarios();
  assert.ok(d5.size >= SCENARIO_ORDER.length, `d5 §10.6에서 읽은 시나리오 ${d5.size}개`);
  const r = validateScenarios(SCENARIOS, { d5 });
  assert.deepEqual(r.problems, [], r.problems.join('\n'));
  assert.equal(r.ok, true);
  // 정의가 정본을 그대로 읽는다(화면 번호·순서)
  for (const s of SCENARIOS) assert.deepEqual(s.screens, d5.get(s.id), `${s.id} 화면 순서`);
  // 시나리오마다 결과 확인이 하나 이상이고, 계획 §6이 요구한 이름이 있다
  for (const s of SCENARIOS) {
    assert.ok(s.checks.length >= 1, `${s.id}에 checks가 없다`);
    assert.ok(s.accounts.length >= 1, `${s.id}에 계정이 없다`);
    assert.ok(s.needs.length >= 1, `${s.id}에 needs가 없다`);
    // 증거로만 여는 화면은 시나리오 정의에 따로 적는다(리뷰 RV-05). screens 밖의 이름은 잡는다
    assert.ok(Array.isArray(s.evidenceOnlyScreens), `${s.id}에 evidenceOnlyScreens가 없다`);
    for (const screen of s.evidenceOnlyScreens) assert.ok(s.screens.includes(screen), `${s.id}의 evidenceOnlyScreens ${screen}이 screens에 없다`);
    for (const c of REQUIRED_CHECKS[s.id] ?? []) assert.ok(s.checks.includes(c), `${s.id}에 ${c}가 없다`);
  }
  // S8 판정 넷은 이름이 모두 다르다
  assert.deepEqual(SCENARIOS.find((s) => s.id === 'S8').checks, ['verdict-pass', 'verdict-reject', 'verdict-needs-check', 'verdict-anomaly']);
});

test('V-T7 ① 시나리오 하나가 빠지거나 화면 순서가 다르면 plan --check가 exit 1이다', () => {
  const missing = validateScenarios(SCENARIOS.filter((s) => s.id !== 'S3'));
  assert.equal(missing.ok, false);
  assert.ok(missing.problems.some((p) => p.includes('시나리오 S3가 없다')), missing.problems.join('\n'));

  const reordered = SCENARIOS.map((s) => (s.id === 'S1' ? { ...s, screens: [...s.screens].reverse() } : s));
  const wrong = validateScenarios(reordered);
  assert.equal(wrong.ok, false);
  assert.ok(wrong.problems.some((p) => p.includes('S1의 화면 순서가 정본과 다르다')), wrong.problems.join('\n'));

  const weak = SCENARIOS.map((s) => (s.id === 'S1' ? { ...s, checks: s.checks.filter((c) => c !== 'ticket-qr') } : s));
  const weakResult = validateScenarios(weak);
  assert.equal(weakResult.ok, false, 'S1에서 ticket-qr를 빼도 통과했다');
  assert.ok(weakResult.problems.some((p) => p.includes("'ticket-qr'가 없다")), weakResult.problems.join('\n'));

  const duplicated = SCENARIOS.map((s) => (s.id === 'S9' ? { ...s, checks: [...s.checks, 'refunded'] } : s));
  const dup = validateScenarios(duplicated);
  assert.equal(dup.ok, false, '같은 check 이름을 두 번 넣어도 통과했다');

  // 증거 전용 화면이 시나리오 화면 목록 밖이면 잡는다
  const badEvidence = SCENARIOS.map((s) => (s.id === 'S1' ? { ...s, evidenceOnlyScreens: ['SCR-999'] } : s));
  const badEvidenceResult = validateScenarios(badEvidence);
  assert.equal(badEvidenceResult.ok, false, 'screens 밖의 evidenceOnlyScreens를 통과시켰다');
  assert.ok(badEvidenceResult.problems.some((p) => p.includes('evidenceOnlyScreens') && p.includes('SCR-999')), badEvidenceResult.problems.join('\n'));
});

test('V-T7 ① plan --check·plan --json이 S1~S9와 화면·계정·needs·checks를 낸다', () => {
  const check = runDemo(['plan', '--check']);
  assert.equal(check.status, 0, `plan --check exit ${check.status}\n${check.stderr}`);
  assert.match(check.stdout, /시나리오 9개가 정본 d5 §10\.6과 같다/);

  const json = runDemo(['plan', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const plan = JSON.parse(json.stdout);
  assert.deepEqual(plan.scenarios.map((s) => s.id), SCENARIO_ORDER);
  for (const s of plan.scenarios) {
    assert.ok(Array.isArray(s.screens) && s.screens.length > 0, `${s.id} screens`);
    assert.ok(Array.isArray(s.accounts) && s.accounts.length > 0, `${s.id} accounts`);
    assert.ok(Array.isArray(s.needs) && s.needs.length > 0, `${s.id} needs`);
    assert.ok(Array.isArray(s.checks) && s.checks.length > 0, `${s.id} checks`);
  }
  // publicPlan도 같은 모양이다(시험이 읽는 칸)
  assert.deepEqual(publicPlan().scenarios.map((s) => s.id), SCENARIO_ORDER);
});

// ---------- V-T7 ② 선행 없으면 닫힌 실패 ----------

test('V-T7 ② 선행이 하나라도 없으면 doctor가 exit 1이고 빠진 것을 모두 나열한다', () => {
  const cases = [
    ['seed', '데모 시드', join('deploy', 'envs', 'demo', 'seed', 'base.yaml')],
    ['images', '데모 이미지 목록', join('tools', 'local', 'demo-images.mjs')],
    ['overlay', '로컬 데모 오버레이', join('deploy', 'envs', 'local', 'demo')],
    ['overlay:identity-svc', '데모 오버레이의 identity-svc', join('deploy', 'envs', 'local', 'demo', 'identity-svc.yaml')],
    ['playwright', 'Playwright', join('tools', 'web-checks', 'node_modules', '@playwright', 'test', 'package.json')],
    ['tool:docker', '도구 docker', 'docker'],
    ['tool:kubectl', '도구 kubectl', 'kubectl'],
  ];
  for (const [key, what, path] of cases) {
    const f = fakeRoot(new Set([key]));
    const r = doctorChecks(f.root, f.env);
    assert.equal(r.ok, false, `${key}가 없는데 doctor가 통과했다`);
    const problem = r.problems.find((p) => p.what === what);
    assert.ok(problem, `${key}: '${what}'가 문제 목록에 없다: ${JSON.stringify(r.problems)}`);
    assert.ok(String(problem.path).includes(path), `${key}: 빠진 경로·이름(${path})이 없다: ${problem.path}`);
  }
  // 하나만 빠져도 다른 선행을 조용히 건너뛰지 않는다: 빠진 것과 있는 것이 함께 읽힌다
  const f = fakeRoot(new Set(['seed', 'playwright']));
  const r = doctorChecks(f.root, f.env);
  assert.equal(r.ok, false);
  assert.equal(r.problems.filter((p) => p.what === '데모 시드' || p.what === 'Playwright').length, 2);
  assert.ok(r.tools.docker && r.tools.kind && r.tools.kubectl && r.tools.helm, `있는 도구를 읽지 못했다: ${JSON.stringify(r.tools)}`);
});

test('V-T7 ② 가짜 뿌리의 doctor는 클러스터 명령을 부르지 않고, 모두 있으면 exit 0이다', () => {
  const bad = fakeRoot(new Set(['seed']));
  const fail = runDemo(['doctor', '--root', bad.root, '--json'], bad.env);
  assert.equal(fail.status, 1, `선행이 없는데 doctor exit ${fail.status}`);
  const out = JSON.parse(fail.stdout);
  assert.equal(out.ok, false);
  assert.ok(out.problems.some((p) => p.what === '데모 시드'), JSON.stringify(out.problems));
  assert.equal(bad.text(), '', `선행이 없는데 클러스터 명령을 불렀다: ${bad.text()}`);

  const good = fakeRoot();
  const ok = runDemo(['doctor', '--root', good.root, '--json'], good.env);
  assert.equal(ok.status, 0, `모두 있는데 doctor exit ${ok.status}\n${ok.stderr}`);
  const okOut = JSON.parse(ok.stdout);
  assert.equal(okOut.ok, true);
  assert.deepEqual(okOut.problems, []);
  assert.equal(good.text(), '', `doctor가 클러스터 명령을 불렀다: ${good.text()}`);
});

test('V-T7 ② doctor가 Playwright chromium 실행 파일을 본다(RV-09)', () => {
  // 패키지는 있는데 브라우저 캐시가 없는 빈 PC: play에서야 브라우저 실행이 실패하면 닫힌 실패가 아니다
  const missing = fakeRoot(new Set(['chromium']));
  const r = doctorChecks(missing.root, missing.env);
  assert.equal(r.ok, false, 'chromium이 없는데 doctor가 통과했다');
  const problem = r.problems.find((p) => p.what === 'Playwright chromium');
  assert.ok(problem, `chromium 문제가 목록에 없다: ${JSON.stringify(r.problems)}`);
  assert.ok(String(problem.path).includes('ms-playwright'), `브라우저 캐시 경로가 없다: ${problem.path}`);
  const cli = runDemo(['doctor', '--root', missing.root, '--json'], missing.env);
  assert.equal(cli.status, 1, `chromium이 없는데 doctor exit ${cli.status}`);

  // 캐시에 chromium 실행 파일이 있으면 통과하고, 찾은 경로를 돌려준다
  const good = fakeRoot();
  assert.ok(findChromium(good.browsers), `${good.browsers}에서 chromium 실행 파일을 찾지 못했다`);
  assert.equal(doctorChecks(good.root, good.env).ok, true, JSON.stringify(doctorChecks(good.root, good.env).problems));
});

// ---------- V-T7 ③ 조용한 건너뛰기 없음 ----------

test('V-T7 ③ 파드가 준비되지 않으면 play는 exit 1이고 어떤 시나리오도 통과로 세지 않는다', () => {
  const kubectl = fakeKubectlHook(false);
  const r = kubectl.run(['play', '--scenarios', 'S1', '--json'], { PEAKET_DEMO_CONTRACT: join(tempDir('peaket-bat086-contract-'), 'none.json'), ...kubectl.env });
  assert.equal(r.status, 1, `파드 미준비인데 play exit ${r.status}\n${r.stderr}`);
  assert.notEqual(r.stdout.trim(), '', `자식 표준 출력이 비었다(exit ${r.status}): ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'pods-not-ready', JSON.stringify(out));
  assert.ok(out.problems.some((p) => p.startsWith('pods-not-ready')), JSON.stringify(out.problems));
  assert.ok(out.problems.some((p) => p.includes('identity-svc')), `준비 안 된 워크로드 이름이 없다: ${JSON.stringify(out.problems)}`);
  assert.equal(out.scenarios, undefined, '파드 미준비인데 시나리오 결과를 통과로 셌다');
  assert.equal(out.ok, false);
  // 준비 상태를 확인하려고 Deployment 목록만 읽었다(다른 클러스터 명령 0)
  const calls = kubectl.calls();
  assert.equal(calls.length, 1, `클러스터 명령 ${calls.length}회: ${JSON.stringify(calls)}`);
  assert.ok(calls[0].args.includes('get') && calls[0].args.includes('deploy'));
  assert.ok(calls[0].args.includes('--kubeconfig'), '전용 kubeconfig를 넘기지 않았다');
});

test('V-T7 ③ 모르는 시나리오·인자는 exit 2다', () => {
  const scenario = runDemo(['play', '--scenarios', 'S99']);
  assert.equal(scenario.status, 2, `모르는 시나리오인데 exit ${scenario.status}`);
  assert.match(scenario.stderr, /모르는 시나리오: S99/);
  assert.match(scenario.stderr, /쓸 수 있는 것: S1, S2, S3, S4, S5, S6, S7, S8, S9/);

  const arg = runDemo(['all', '--nope']);
  assert.equal(arg.status, 2, `모르는 인자인데 exit ${arg.status}`);
  assert.match(arg.stderr, /모르는 인자: --nope/);

  const command = runDemo(['what']);
  assert.equal(command.status, 2, `모르는 명령인데 exit ${command.status}`);
  assert.match(command.stderr, /모르는 명령: what/);
});

// ---------- V-T7 ④ 빈 PC 한 명령 재생(실행 기록·재생기 구조) ----------

test('V-T7 ④ 실제 실행 기록(BAT-086-demo.md)이 S1~S9 9/9·콜드 스타트·정리를 남긴다', () => {
  const text = readFileSync(MEASUREMENT, 'utf8');
  assert.match(text, /- \*\*커밋\*\*: [0-9a-f]{7,40}/, '측정 파일에 커밋이 없다');
  assert.match(text, /- \*\*콜드 스타트\*\*: \d+초 \(명령 시작 ~ 첫 화면\)/, '측정 파일에 콜드 스타트가 없다');
  assert.match(text, /- \*\*정리\*\*: 지움/, '측정 파일에 정리 결과가 없다');
  assert.match(text, /- \*\*결과\*\*: 통과/, '측정 파일의 결과가 통과가 아니다');
  const rows = text.split(/\r?\n/).filter((l) => /^\| S[1-9] \|/.test(l));
  assert.equal(rows.length, SCENARIO_ORDER.length, `측정 파일의 시나리오 행 ${rows.length}개`);
  for (let i = 0; i < SCENARIO_ORDER.length; i += 1) {
    assert.match(rows[i], new RegExp(`^\\| ${SCENARIO_ORDER[i]} \\|`), `${i + 1}번째 행이 ${SCENARIO_ORDER[i]}가 아니다: ${rows[i]}`);
    assert.match(rows[i], /\| 통과 \|/, `${SCENARIO_ORDER[i]}가 통과가 아니다: ${rows[i]}`);
    assert.match(rows[i], /\| \d+초 \|/, `${SCENARIO_ORDER[i]}의 걸린 시간이 없다: ${rows[i]}`);
  }
});

test('V-T7 ④ 재생기는 S2 매진 픽스처를 실제로 적용한다', () => {
  const body = runnerBlock(readFileSync(RUNNER_MJS, 'utf8'), 'S2');
  assert.match(body, /redis\(ctx, \['HSET'/, 'S2가 대기열 Redis notice를 쓰지 않는다(매진 픽스처 미적용)');
  assert.match(body, /saleState', 'SOLD_OUT'/, 'S2가 판매 상태를 SOLD_OUT으로 두지 않는다');
  assert.match(body, /addCheck\('sold-out'/, 'S2가 sold-out 확인을 만들지 않는다');
  assert.match(body, /addCheck\('retry-message'/, 'S2가 다시 시도 문구를 확인하지 않는다');
});

test('V-T7 ④ S7은 요청자·승인자 맥락 둘을 쓴다', () => {
  const body = runnerBlock(readFileSync(RUNNER_MJS, 'utf8'), 'S7');
  assert.match(body, /adminReauth\(ctx, 'sujin', 'OPS_COMMAND'\)/, 'S7이 요청자(수진) 재인증을 쓰지 않는다');
  assert.match(body, /addCheck\('self-approval-403'/, 'S7이 요청자 자기 승인 403을 확인하지 않는다');
  assert.match(body, /adminReauth\(ctx, 'second-commander', 'OPS_COMMAND'\)/, 'S7이 두 번째 commander 맥락을 쓰지 않는다(맥락 하나)');
  assert.match(body, /addCheck\('second-approval-ok'/, 'S7이 두 번째 승인 성공을 확인하지 않는다');
  assert.match(body, /addCheck\('audit-entry'/, 'S7이 감사 기록의 두 계정을 확인하지 않는다');
});

test('V-T7 ④ S8은 기기 키를 보존해 재실행에도 같은 기기를 쓴다', () => {
  const source = readFileSync(RUNNER_MJS, 'utf8');
  const body = runnerBlock(source, 'S8');
  const key = functionBlock(source, 'function deviceKey(ctx) {');
  assert.match(key, /\.cache/, 'deviceKey가 .cache에 키를 보존하지 않는다');
  assert.match(key, /existsSync\(file\)/, 'deviceKey가 저장한 키를 다시 읽지 않는다');
  assert.match(body, /const key = deviceKey\(ctx\)/, 'S8이 보존한 기기 키를 쓰지 않는다');
  assert.match(body, /d\.thumb === keyHex/, 'S8이 같은 키에 묶인 기기를 찾지 않는다');
  assert.match(body, /if \(device\.thumb !== keyHex\)/, 'S8이 이미 묶인 기기에 등록 코드를 다시 발급한다(키 재사용 실패)');
  // 스캔 3건은 같은 key로 올린다(기기 키를 매번 새로 만들면 DPoP 지문이 달라진다)
  assert.match(body, /accessToken: grant\.access_token, key \}/, 'S8이 스캔 업로드에 보존한 기기 키를 쓰지 않는다');
});

test('V-T7 ④ S9는 판정자 아닌 두 번째 commander가 확정한다', () => {
  const body = runnerBlock(readFileSync(RUNNER_MJS, 'utf8'), 'S9');
  assert.match(body, /status === 'PENDING_APPROVAL'/, 'S9가 2인 승인 대기 상태를 보지 않는다');
  assert.match(body, /const token = await adminReauth\(ctx, 'second-commander', 'APPROVAL'\);/, 'S9가 두 번째 commander 재인증을 쓰지 않는다(2인 승인 생략)');
  assert.match(body, /const approved = await api\(ctx, 'second-commander', \{/, 'S9가 두 번째 commander로 확정하지 않는다');
  assert.match(body, /againToken = await adminReauth\(ctx, 'second-commander', 'APPROVAL'\)/, 'S9의 다시 확정 확인도 두 번째 commander가 아니다');
  assert.match(body, /addCheck\('refunded'/, 'S9가 환불 결과를 확인하지 않는다');
});

test('V-T7 ④ 깨끗한 빌드(--skip-build 없이) 계획에 데모 출처 VITE build-arg가 있다', () => {
  const source = readFileSync(DEMO_MJS, 'utf8');
  // all·up은 --skip-build를 줬을 때만 건너뛴다(기본은 새로 빌드한다)
  assert.match(source, /\['demo', \.\.\.\(o\.skipBuild \? \['--skip-build'\] : \[\]\)\]/, 'all·up의 무대 호출이 --skip-build를 조건 없이 붙인다');
  const cluster = readFileSync(join(REPO, 'tools', 'local', 'cluster.mjs'), 'utf8');
  // 새 이미지 열은 buildImage(데모 build-arg를 붙이는 함수)로 빌드한다(직접 docker build가 아니다)
  assert.match(cluster, /for \(const i of DEMO_NEW_IMAGES\) buildDemoImage\(i\)/, 'cluster.mjs의 demo가 demo-images의 buildImage로 빌드하지 않는다');
  const queueRoom = DEMO_IMAGES.find((i) => i.workload === 'queue-room');
  const args = dockerBuildArgs(queueRoom);
  assert.ok(args.includes(`VITE_PEAKET_QUEUE_FILES_ORIGIN=${demoOrigins()['queue-files']}`), `깨끗한 빌드에 queue-files 출처가 없다: ${args.join(' ')}`);
  assert.match(demoOrigins()['queue-files'], /:18442$/, '데모 queue-files 출처에 포트가 없다');
  // demo-images --check도 같은 build-arg를 보고한다(사람이 읽는 --json)
  const cli = spawnSync(process.execPath, [join(REPO, 'tools', 'local', 'demo-images.mjs'), '--check', '--json'], { cwd: REPO, encoding: 'utf8', timeout: 60_000 });
  assert.equal(cli.status, 0, `demo-images --check exit ${cli.status}: ${cli.stderr}`);
  const json = JSON.parse(cli.stdout);
  assert.deepEqual(json.images.find((i) => i.workload === 'queue-room').buildArgs, DEMO_BUILD_ARGS['queue-room'], '--check --json에 queue-room build-arg가 없다');
});

// ---------- V-T7 ⑤ 두 번 돌리기·정리 ----------

test('V-T7 ⑤ up 재사용·down 두 번·다른 클러스터 보존을 지킨다', () => {
  const source = readFileSync(DEMO_MJS, 'utf8');
  const up = source.slice(source.indexOf("if (o.cmd === 'up')"));
  assert.match(up, /const ready = stageProblems\(\{ env: demoEnv\(o\) \}\)/, 'up이 기존 무대를 먼저 보지 않는다(중복 클러스터)');
  assert.match(up, /if \(ready\.ok\)/, 'up이 준비된 무대를 재사용하지 않는다');
  assert.match(up, /다시 올리지 않는다/, 'up이 재사용을 알리지 않는다');
  const down = source.slice(source.indexOf("if (o.cmd === 'down')"));
  assert.match(down, /runNodeSoft\('cluster\.mjs', \['demo-down'\]/, 'down이 데모 네임스페이스를 지우지 않는다');
  assert.match(down, /runNode\('cluster\.mjs', \['down'\]/, 'down이 kind 클러스터를 지우지 않는다(정리 누락)');
  assert.match(down, /if \(o\.keepCluster\)/, 'down에 --keep-cluster가 없다');
  // all의 정리도 같은 두 단계를 부른다
  const cleanup = source.slice(source.indexOf('function cleanupStage'), source.indexOf('/** all: 무대'));
  assert.match(cleanup, /runNodeSoft\('cluster\.mjs', \['demo-down'\]/);
  assert.match(cleanup, /runNodeSoft\('cluster\.mjs', \['down'\]/);
  // 기본 클러스터 이름은 lane4-demo이고 다른 갈래의 이름을 쓰지 않는다
  assert.equal(DEMO_CLUSTER, 'lane4-demo');
  const parsed = parseArgs(['down']);
  assert.equal(parsed.cluster, process.env.PEAKET_DEMO_CLUSTER || 'lane4-demo');
  // 시드 멱등(두 번 적용해도 개수가 같다)은 demo-seed.test.mjs의 DS-06이 실제 DB 대역으로 본다
  assert.match(readFileSync(join(REPO, 'tools', 'local', 'demo-seed.test.mjs'), 'utf8'), /DS-06/);
});

// ---------- V-T7 ⑥ 비밀·개인정보 없음 ----------

test('V-T7 ⑥ 시드·측정·출력에 비밀·개인정보가 없다', () => {
  const seed = checkSeed(DEMO_SEED_FILE);
  assert.deepEqual(seed.problems, [], seed.problems.join('\n'));
  assert.equal(seed.ok, true);

  const secret = 'Authorization: Bearer abc.def.ghi password: hunter2 totp=123456 __Secure-peaket_at=session-value';
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const red = redact(`${secret} ${jwt}`);
  assert.doesNotMatch(red, /hunter2|123456|session-value/, `가리지 않은 비밀 값이 있다: ${red}`);
  assert.doesNotMatch(red, /abc\.def\.ghi/, `Bearer 값을 가리지 않았다: ${red}`);
  assert.doesNotMatch(red, /eyJhbGciOiJIUzI1NiJ9/, `JWT를 가리지 않았다: ${red}`);
  assert.match(red, /Bearer <가림>/);
  assert.match(red, /password.*<가림>/);
  assert.match(red, /<JWT 가림>/);

  // 측정 파일에 비밀을 넣어도 결과 파일에는 이름만 남는다
  const text = measurementText({
    commit: 'a'.repeat(40),
    date: '2026-11-21T00:00:00.000Z',
    pc: 'test',
    tools: { node: process.version },
    coldStartSeconds: 3,
    scenarios: [{ id: 'S1', title: 'x', result: '통과', seconds: 1 }],
    cleanup: '지움',
    outcome: '통과',
    notes: [secret, `데모 계정 비밀번호는 환경 값 DEMO_SUJIN_PASSWORD에만 있다`],
  });
  assert.doesNotMatch(text, /hunter2|123456|session-value/);
  assert.match(text, /DEMO_SUJIN_PASSWORD/);

  // 사람이 읽는 명령 출력에도 Bearer·password·totp 값이 없다
  for (const args of [['plan', '--json'], ['doctor', '--json']]) {
    const r = runDemo(args);
    assert.doesNotMatch(r.stdout + r.stderr, /Bearer\s+[A-Za-z0-9._~+/-]{8,}|password\s*[:=]\s*\S+|totp\s*[:=]\s*\S+/i, `${args.join(' ')} 출력에 비밀 값이 있다`);
  }
});

// ---------- V-T7 ⑦ 측정 기록 ----------

test('V-T7 ⑦ 측정 기록은 성공·실패를 그대로 남긴다', () => {
  const ok = measurementText({
    commit: 'b'.repeat(40),
    date: '2026-11-21T00:00:00.000Z',
    pc: 'win32 · CPU · Node v24 · Playwright tools/web-checks 1.64.1',
    tools: { node: 'v24', docker: '29.8.1', kind: 'v0.33.0', kubectl: 'v1.35.8', playwright: '1.64.1' },
    coldStartSeconds: 7,
    scenarios: [
      { id: 'S1', title: '지민', startedAt: '2026-11-21T00:00:01.000Z', endedAt: '2026-11-21T00:00:10.000Z', seconds: 9, result: '통과' },
      { id: 'S2', title: '매진', startedAt: '2026-11-21T00:00:10.000Z', endedAt: '2026-11-21T00:00:12.000Z', seconds: 2, result: '통과' },
    ],
    cleanup: '지움(데모 네임스페이스+kind 클러스터)',
    command: 'node tools/local/demo.mjs all',
    outcome: '통과',
  });
  assert.match(ok, /- \*\*커밋\*\*: b{40}/);
  assert.match(ok, /- \*\*콜드 스타트\*\*: 7초/);
  assert.match(ok, /- \*\*결과\*\*: 통과/);
  assert.match(ok, /\| S1 \| 지민 \| .* \| 9초 \| 통과 \| — \|/);
  assert.match(ok, /\| S2 \| 매진 \| .* \| 2초 \| 통과 \| — \|/);

  // 실패한 실행은 '실패'와 실패 단계를 남기고 성공으로 덮지 않는다
  const fail = measurementText({
    commit: 'c'.repeat(40),
    date: '2026-11-21T00:00:00.000Z',
    pc: 'test',
    tools: { node: process.version },
    coldStartSeconds: undefined,
    scenarios: [
      { id: 'S1', title: '지민', result: '통과', seconds: 9 },
      { id: 'S2', title: '매진', result: '실패', failedStep: 'check sold-out', reason: 'HTTP 500', seconds: 2 },
    ],
    cleanup: '실패(demo-down 1, kind down 1)',
    outcome: '실패',
  });
  assert.match(fail, /- \*\*결과\*\*: 실패/);
  assert.match(fail, /- \*\*콜드 스타트\*\*: —/);
  assert.match(fail, /\| S2 \| 매진 \| .* \| 2초 \| 실패 \| 단계 check sold-out · HTTP 500 \|/);
  assert.match(fail, /- \*\*정리\*\*: 실패/);

  const file = join(tempDir('peaket-bat086-measure-'), 'BAT-086-demo.md');
  const written = writeMeasurement(file, {
    commit: 'd'.repeat(40),
    date: '2026-11-21T00:00:00.000Z',
    pc: 'test',
    tools: { node: process.version },
    coldStartSeconds: 1,
    scenarios: [{ id: 'S1', title: '지민', result: '통과', seconds: 1 }],
    cleanup: '지움',
    outcome: '통과',
  });
  assert.equal(written.file, file);
  assert.match(readFileSync(file, 'utf8'), /- \*\*결과\*\*: 통과/);
});

test('V-T7 ⑦ 시드 실패는 자식 명령과 마지막 출력 줄을 측정에 남긴다(Finding: V-T7-seed-seatmap)', () => {
  // runNodeJson은 stdout과 stderr를 이어 붙인다. 마지막 비어 있지 않은 줄이 실패 까닭이다
  assert.equal(lastOutputLine('준비\n시드 적용 실패: 기기 배치 동문-01 → 503\n\n'), '시드 적용 실패: 기기 배치 동문-01 → 503');
  assert.equal(lastOutputLine(''), '');
  assert.equal(lastOutputLine(undefined), '');

  const fail = measurementText({
    commit: 'e'.repeat(40),
    date: '2026-11-21T00:00:00.000Z',
    pc: 'test',
    tools: { node: process.version },
    scenarios: SCENARIO_ORDER.map((id) => ({ id, title: id, result: '미실행', reason: '시드 실패' })),
    cleanup: '지움',
    outcome: '실패(시드 exit 1)',
    failure: '명령 `node tools/local/cluster.mjs demo-seed --apply --json` · 마지막 출력: 시드 적용 실패: 기기 배치 동문-01 → 503',
  });
  assert.match(fail, /- \*\*결과\*\*: 실패\(시드 exit 1\)/);
  assert.match(fail, /- \*\*실패 내용\*\*: 명령 `node tools\/local\/cluster\.mjs demo-seed --apply --json`/);
  assert.match(fail, /마지막 출력: 시드 적용 실패: 기기 배치 동문-01 → 503/);

  // all의 시드 실패 갈래가 자식 출력의 마지막 줄을 실제로 쓰는지(문구만 있는 시험이 아니다)
  const source = readFileSync(DEMO_MJS, 'utf8');
  const start = source.indexOf('if (seed.status !== 0) {');
  assert.ok(start > 0, 'runAll의 시드 실패 갈래를 찾지 못했다');
  const branch = source.slice(start, source.indexOf('if (o.seedOnly)', start));
  assert.match(branch, /lastOutputLine\(seed\.text\)/, '시드 실패 갈래가 자식 출력을 버린다');
  assert.match(branch, /cluster\.mjs demo-seed --apply --json/, '시드 실패 갈래가 자식 명령을 남기지 않는다');
  assert.match(branch, /failure(?:\s*:\s*failure)?\s*,/, '시드 실패 갈래가 측정에 실패 내용을 넘기지 않는다');
});

test('V-T7 ⑦ all은 선행이 없으면 실패 측정을 남기고 시나리오를 통과로 세지 않는다', () => {
  const f = fakeRoot(new Set(['seed']));
  const file = join(tempDir('peaket-bat086-all-'), 'BAT-086-demo.md');
  const r = runDemo(['all', '--root', f.root, '--measure', file], f.env);
  assert.equal(r.status, 1, `선행이 없는데 all exit ${r.status}\n${r.stderr}`);
  const text = readFileSync(file, 'utf8');
  assert.match(text, /- \*\*결과\*\*: 실패\(선행 없음\)/);
  const rows = text.split(/\r?\n/).filter((l) => /^\| S[1-9] \|/.test(l));
  assert.equal(rows.length, SCENARIO_ORDER.length);
  for (const row of rows) {
    assert.match(row, /\| 미실행 \|/, `선행이 없는데 통과로 셌다: ${row}`);
  }
  assert.equal(f.text(), '', `선행이 없는데 클러스터 명령을 불렀다: ${f.text()}`);
});

// ---------- DM-08·DM-09 운영 판 호환 검사 시연(D-T48) ----------

test('DM-08 같은 커밋끼리는 compat가 통과하고, 임시 복제본 밖 태그는 그대로다', async () => {
  const { dir, git } = makeGitRepo();
  const work = join(tempDir('peaket-bat086-compat-work-'), 'demo-compat');
  const calls = [];
  const run = (cwd) => {
    const tag = spawnSync('git', ['tag', '--list', DEMO_TAG], { cwd, encoding: 'utf8' }).stdout.trim();
    calls.push({ cwd, tag });
    if (!tag) return { status: 0, out: '같은 커밋: 계약 변화 없음' };
    return { status: 1, out: 'response-property-removed: type' };
  };
  const r = await runCompat({ repo: dir, work, run, docker: () => true });
  assert.equal(r.code, 0, `compat exit ${r.code}: ${r.reason}`);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.steps.map((s) => [s.name, s.exit, s.pass]), [
    ['same-commit', 0, true],
    ['release-tag-diff', 1, true],
  ]);
  assert.equal(r.field, 'type');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].tag, '', '첫 검사에 이미 출시 태그가 있었다');
  assert.equal(calls[1].tag, DEMO_TAG, '둘째 검사에 출시 태그가 없었다(같은 커밋끼리만 견줬다)');
  // 복제본 밖(원래 저장소)의 태그는 그대로다
  assert.equal(git(['tag', '--list']).trim(), '');
});

test('DM-09 마지막 출시 태그와 견주면 필드 삭제를 잡고, 도구 오류를 통과로 세지 않는다', async () => {
  const { dir } = makeGitRepo();
  const work = join(tempDir('peaket-bat086-compat-work-'), 'demo-compat');
  // M8 틀린 구현: HEAD와 HEAD를 견주어 항상 통과
  const alwaysPass = async () => {
    const r = await runCompat({ repo: dir, work, run: () => ({ status: 0, out: '통과' }), docker: () => true });
    assert.equal(r.ok, false, '항상 통과하는 compat를 통과로 읽었다');
    assert.equal(r.code, 1);
    assert.match(r.reason, /마지막 출시 태그.*통과했다|깨짐을 못 봤다/);
  };
  await alwaysPass();
  // M9 틀린 구현: 도구 오류(exit 2)를 통과로 읽음
  const toolError = await runCompat({ repo: dir, work, run: () => ({ status: 2, out: 'docker: 이미지 없음' }), docker: () => true });
  assert.equal(toolError.ok, false, '도구 오류(exit 2)를 통과로 셌다');
  assert.equal(toolError.code, 1);
  assert.match(toolError.reason, /같은 커밋끼리의 검사가 통과하지 못했다/);
  // Docker가 없으면 exit 2(오류)이고 검사를 시작하지 않는다
  const noDocker = await runCompat({ repo: dir, work, run: () => ({ status: 0, out: '' }), docker: () => false });
  assert.equal(noDocker.ok, false);
  assert.equal(noDocker.code, 2);
  assert.deepEqual(noDocker.steps, []);
  // 필드를 지우는 변경은 실제 Problem 스키마에서 이름을 꺼낸다
  const original = readFileSync(join(REPO, 'docs', 'api', 'openapi.yaml'), 'utf8');
  const broken = breakOpenApi(original);
  assert.match(broken.field, /^[A-Za-z0-9_]+$/);
  const removed = original.split('\n').find((l) => l.startsWith(`        ${broken.field}:`));
  assert.ok(removed, `지울 필드 ${broken.field}의 줄을 찾지 못했다`);
  const count = (text) => text.split('\n').filter((l) => l === removed).length;
  assert.equal(count(broken.text), count(original) - 1, `지운 필드 ${broken.field} 줄이 하나 줄지 않았다`);
  assert.throws(() => compatPlan(['--work']), /--work에는 폴더를 준다/);
  assert.throws(() => compatPlan(['--nope']), /모르는 인자/);
});

// ---------- CP-01 클라우드 절차 값 ----------

test('CP-01 cloud-plan --check가 TTL·예산 경계·정리 누락을 잡는다', () => {
  const plan = parseYaml(readFileSync(CLOUD_PLAN_FILE, 'utf8'));
  const base = checkCloudPlan(plan);
  assert.equal(base.ok, true, base.problems.join('\n'));
  assert.equal(base.ttlHours, MAX_TTL_HOURS);
  assert.ok(base.estimatedKrw <= base.budgetKrw);

  // 딱 예산과 같으면 통과(≤)
  const exact = { ...plan, budgetKrw: base.estimatedKrw };
  const exactResult = checkCloudPlan(exact);
  assert.equal(exactResult.ok, true, `예산과 딱 같으면 통과여야 한다: ${exactResult.problems.join('\n')}`);
  // 1원 모자라면 실패
  const short = { ...plan, budgetKrw: base.estimatedKrw - 1 };
  const shortResult = checkCloudPlan(short);
  assert.equal(shortResult.ok, false, '예산을 1원 넘겼는데 통과했다');
  assert.ok(shortResult.problems.some((p) => p.includes('예산') && p.includes('넘었다')), shortResult.problems.join('\n'));
  // TTL 7시간은 상한 6시간을 넘는다
  const ttl7 = { ...plan, ttlHours: MAX_TTL_HOURS + 1 };
  const ttlResult = checkCloudPlan(ttl7);
  assert.equal(ttlResult.ok, false, 'TTL 7시간인데 통과했다');
  assert.ok(ttlResult.problems.some((p) => p.includes('상한') && p.includes(`${MAX_TTL_HOURS}시간`)), ttlResult.problems.join('\n'));
  // 정리 항목 하나를 빼면 실패
  for (const key of REQUIRED_CLEANUP) {
    const missing = { ...plan, cleanup: plan.cleanup.filter((x) => (typeof x === 'string' ? x : x.key) !== key) };
    const r = checkCloudPlan(missing);
    assert.equal(r.ok, false, `정리 항목 ${key}가 없는데 통과했다`);
    assert.ok(r.problems.some((p) => p.includes(key)), `${key}를 문제로 말하지 않는다: ${r.problems.join('\n')}`);
  }
  // 구성이 비면 실패
  assert.equal(checkCloudPlan({ ...plan, components: [] }).ok, false);

  const cli = runDemo(['cloud-plan', '--check']);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /클라우드 계획이 맞다/);
  const json = runDemo(['cloud-plan', '--check', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const out = JSON.parse(json.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.ttlHours, MAX_TTL_HOURS);
  assert.ok(out.estimatedKrw <= out.budgetKrw);
});

// ---------- 리뷰 반영 RV-01~RV-05·RV-09~RV-11 ----------

test('V-T7 ① 공용 게이트웨이 출처는 화면 하나이고 데모 패치만 queue·scanner 출처를 더한다(RV-01)', () => {
  const shared = readGatewayObjects(GATEWAY_DIR);
  const routeGateway = new Map();
  for (const o of shared) if (o.kind === 'HTTPRoute') for (const p of o.spec?.parentRefs ?? []) if (p.name) routeGateway.set(o.metadata.name, p.name);
  const isFanPolicy = (o) => o.kind === 'SecurityPolicy' && (o.spec?.targetRefs ?? []).some((t) => routeGateway.get(t.name) === 'gw-fan');
  const listsOf = (o) => [o.spec?.cors?.allowOrigins, o.spec?.csrf?.additionalOrigins].filter(Array.isArray);

  // 공용 deploy/gateways: 화면 출처 하나(ASVS 3.4.2·3.5.1). 데모 포트 출처가 새면 여기서 잡는다
  for (const o of shared.filter((x) => x.kind === 'SecurityPolicy')) {
    for (const list of listsOf(o)) {
      assert.equal(list.length, 1, `${o.metadata.name}의 출처가 ${list.length}개다(공용 정의는 하나): ${list.join(', ')}`);
      assert.doesNotMatch(String(list[0]), /:1844[1-5]$/, `${o.metadata.name}에 데모 포트 출처가 있다: ${list[0]}`);
    }
  }

  // 데모 객체: gw-fan 정책에만 대기실(queue)·스캐너(scanner) 앱 출처가 더해진다
  const origins = demoOrigins();
  const demo = demoGatewayObjects(shared, origins);
  const fan = demo.filter(isFanPolicy);
  assert.ok(fan.length > 0, 'gw-fan 정책을 찾지 못했다');
  for (const o of fan) {
    for (const list of listsOf(o)) {
      assert.ok(list.includes(origins.www), `${o.metadata.name}에 www 데모 출처가 없다: ${list.join(', ')}`);
      assert.ok(list.includes(origins.queue), `${o.metadata.name}에 대기실 데모 출처가 없다: ${list.join(', ')}`);
      assert.ok(list.includes(origins.scanner), `${o.metadata.name}에 스캐너 데모 출처가 없다: ${list.join(', ')}`);
    }
  }
  for (const o of demo.filter((x) => x.kind === 'SecurityPolicy' && !isFanPolicy(x))) {
    const all = listsOf(o).flat();
    const gateways = (o.spec?.targetRefs ?? []).map((t) => routeGateway.get(t.name));
    if (!gateways.includes('gw-scanner')) assert.ok(!all.includes(origins.scanner), `${o.metadata.name}에 데모 스캐너 출처가 샜다: ${origins.scanner}`);
    assert.ok(!all.includes(origins.queue), `${o.metadata.name}에 데모 대기실 출처가 샜다: ${origins.queue}`);
  }

  // 패치는 입력을 바꾸지 않고, 두 번 적용해도 같은 값이 겹치지 않는다
  const before = JSON.stringify(shared);
  const patched = demoOriginSecurityPatch(shared, origins);
  assert.equal(JSON.stringify(shared), before, 'demoOriginSecurityPatch가 입력 객체를 바꿨다');
  const twice = demoOriginSecurityPatch(patched, origins);
  for (const o of twice.filter(isFanPolicy)) for (const list of listsOf(o)) assert.equal(list.length, new Set(list).size, `${o.metadata.name}의 출처가 겹친다: ${list.join(', ')}`);
});

test('V-T7 ④ 콜드 스타트는 명령 시작~첫 화면이다(RV-02)', async () => {
  const dir = tempDir('peaket-bat086-run-');
  const report = await runScenarios({
    repo: REPO,
    scenarios: [{ id: 'S1', title: '주입', checks: [] }],
    contract: {},
    artifactsDir: join(dir, 'artifacts'),
    pw: { chromium: { launch: async () => ({ close: async () => undefined }) } },
    flows: { S1: async (ctx) => { ctx.firstScreenAt = ctx.now(); } },
    now: () => 5_000,
    startedAt: 2_000,
    log: () => undefined,
  });
  assert.equal(report.startedAt, new Date(2_000).toISOString(), '보고서 시작이 all 시작이 아니다(브라우저 시작~첫 화면만 쟀다)');
  assert.equal(report.coldStartSeconds, 3, `콜드 스타트 ${report.coldStartSeconds}초(기대 3초: 2,000ms → 5,000ms)`);
  assert.equal(report.totalSeconds, 3, `전체 ${report.totalSeconds}초(기대 3초)`);

  // 측정 파일은 콜드 스타트와 전체 시간을 따로 적는다
  const text = measurementText({
    commit: 'e'.repeat(40),
    date: '2026-11-21T00:00:00.000Z',
    pc: 'test',
    tools: { node: process.version },
    coldStartSeconds: 3,
    totalSeconds: 1_380,
    scenarios: [{ id: 'S1', title: '지민', result: '통과', seconds: 9 }],
    cleanup: '지움',
    outcome: '통과',
  });
  assert.match(text, /- \*\*콜드 스타트\*\*: 3초 \(명령 시작 ~ 첫 화면\)/);
  assert.match(text, /- \*\*전체 시간\*\*: 1380초 \(명령 시작 ~ 재생 끝\)/);
});

test('V-T7 ⑤ all --keep은 exit 0이고 정리 실패는 실패로 남는다(RV-03)', () => {
  assert.deepEqual(allResult({ keep: true, report: { ok: true }, cleanup: '남김(--keep)' }), { outcome: '통과', exit: 0 }, '--keep 성공이 exit 1이면 안 된다');
  assert.deepEqual(allResult({ report: { ok: true }, cleanup: '지움(데모 네임스페이스+kind 클러스터)' }), { outcome: '통과', exit: 0 });
  assert.deepEqual(allResult({ report: { ok: true }, cleanup: '실패(demo-down 1, kind down 1)' }), { outcome: '통과(정리 실패)', exit: 1 }, '정리 실패를 성공으로 덮었다');
  assert.deepEqual(allResult({ report: { ok: false }, cleanup: '지움(데모 네임스페이스+kind 클러스터)' }), { outcome: '실패', exit: 1 });

  // 무대 준비 단계가 실패한 뒤의 정리도 demo-down·down의 끝 코드를 확인해 적는다
  const source = readFileSync(DEMO_MJS, 'utf8');
  const start = source.indexOf('const stage = stageProblems');
  const block = source.slice(start, source.indexOf('report = o.skipPlay', start));
  assert.match(block, /cleanupStage\(o\.cluster\)/, 'stageProblems 실패 정리가 두 명령의 결과를 확인하지 않는다');
});

test('V-T7 ④ 필수 화면 방문 실패는 시나리오 실패이고 ticket-qr은 화면 QR을 본다(RV-05)', () => {
  const source = readFileSync(RUNNER_MJS, 'utf8');
  for (const s of SCENARIOS) {
    const body = runnerBlock(source, s.id);
    const evidence = new Set(s.evidenceOnlyScreens ?? []);
    for (const screen of new Set(s.screens)) {
      const lines = body.split(/\r?\n/).filter((l) => l.includes(`screen: '${screen}'`));
      assert.ok(lines.length > 0, `${s.id}가 ${screen}을 방문하지 않는다`);
      const required = lines.some((l) => !/\.catch\(/.test(l));
      assert.equal(required, !evidence.has(screen), `${s.id} ${screen}: ${evidence.has(screen) ? 'evidenceOnlyScreens인데 실패를 삼키지 않는다' : '필수 화면인데 실패를 .catch로 삼킨다'}`);
    }
  }
  // 티켓 QR은 원장 UUID만 보지 않고 화면의 QR 요소·값(aria-label)을 본다
  const s1 = runnerBlock(source, 'S1');
  const qr = functionBlock(source, 'async function ticketQrOf(page) {');
  assert.match(qr, /role="img"|aria-label/, 'ticketQrOf가 화면의 QR 요소를 보지 않는다');
  assert.match(s1, /ticketQrOf\(ticketPage\)/, 'S1이 티켓 화면의 QR을 확인하지 않는다');
  assert.match(s1, /addCheck\('ticket-qr',\s*[a-zA-Z]/, 'ticket-qr이 상수 true다');
});

test('V-T7 ⑦ 0건 실행은 통과가 아니라 건너뜀이다(RV-10)', () => {
  assert.deepEqual(allResult({ seedOnly: true, cleanup: '남김(--seed-only)' }), { outcome: '건너뜀(시드만)', exit: 0 });
  assert.deepEqual(
    allResult({ skipPlay: true, report: { ok: false, scenarios: [] }, cleanup: '지움(데모 네임스페이스+kind 클러스터)' }),
    { outcome: '건너뜀(--skip-play: 재생 안 함)', exit: 0 },
    '--skip-play 0건을 통과로 적었다',
  );
  const source = readFileSync(DEMO_MJS, 'utf8');
  assert.doesNotMatch(source, /통과\(시드만\)/, "0건 실행을 '통과(시드만)'로 적는다");
  // 측정 파일도 결과 칸에 건너뜀을 그대로 쓴다
  const text = measurementText({
    commit: 'f'.repeat(40),
    date: '2026-11-21T00:00:00.000Z',
    pc: 'test',
    tools: { node: process.version },
    coldStartSeconds: undefined,
    scenarios: [{ id: 'S1', title: '지민', result: '미실행' }],
    cleanup: '남김(--seed-only)',
    outcome: '건너뜀(시드만)',
  });
  assert.match(text, /- \*\*결과\*\*: 건너뜀\(시드만\)/);
  assert.doesNotMatch(text, /- \*\*결과\*\*: 통과/);
});

test('V-T7 ⑦ 측정은 실행별 파일을 따로 쓴다(RV-11)', () => {
  const canonical = join(REPO, 'docs', 'review', 'measurements', 'BAT-086-demo.md');
  assert.equal(measurementHistoryPath(canonical, 'run-1'), join(REPO, 'docs', 'review', 'measurements', 'BAT-086-demo-run-1.md'));
  assert.equal(playMeasurementPath(canonical, 'run-1'), join(REPO, 'docs', 'review', 'measurements', 'play', 'BAT-086-demo-run-1.md'));

  const source = readFileSync(DEMO_MJS, 'utf8');
  const all = source.slice(source.indexOf('async function runAll'), source.indexOf('/** 재생 한 번'));
  assert.match(all, /writeMeasurement\(measurementHistoryPath\(/, 'all이 실행별 측정 파일을 쓰지 않는다(정본을 덮개로 쓴다)');
  const play = source.slice(source.indexOf('async function play'), source.indexOf('async function main'));
  assert.match(play, /playMeasurementPath\(/, 'play의 기본 측정이 정본 파일을 덮는다');
});

// ---------- 명령줄 옵션 ----------

test('BAT-086 all 옵션을 읽고 모르는 인자·명령은 exit 2로 닫는다', () => {
  const measure = join(tempDir('peaket-bat086-args-'), 'm.md');
  const all = parseArgs(['all', '--scenarios', 'all', '--keep', '--headed', '--video', '--skip-build', '--measure', measure]);
  assert.equal(all.cmd, 'all');
  assert.deepEqual(all.scenarios, ['all']);
  assert.equal(all.keep, true);
  assert.equal(all.headed, true);
  assert.equal(all.video, true);
  assert.equal(all.skipBuild, true);
  assert.equal(all.measure, resolve(measure));
  assert.equal(all.cluster, process.env.PEAKET_DEMO_CLUSTER || 'lane4-demo');

  const some = parseArgs(['play', '--scenarios', 'S1,S9']);
  assert.deepEqual(some.scenarios, ['S1', 'S9']);
  const seed = parseArgs(['seed', '--reset', '--json']);
  assert.equal(seed.reset, true);
  assert.equal(seed.json, true);
  const down = parseArgs(['down', '--keep-cluster', '--cluster', 'lane4-alt']);
  assert.equal(down.keepCluster, true);
  assert.equal(down.cluster, 'lane4-alt');
  const root = parseArgs(['doctor', '--root', 'D:/x', '--json']);
  assert.equal(root.root, resolve('D:/x'));
  const help = parseArgs(['help']);
  assert.equal(help.cmd, 'help');

  assert.throws(() => parseArgs(['play', '--scenarios', 'S1,S99']), /모르는 시나리오: S99/);
  assert.throws(() => parseArgs(['all', '--nope']), /모르는 인자: --nope/);
  assert.throws(() => parseArgs(['what']), /모르는 명령: what/);
  assert.throws(() => parseArgs(['--scenarios']), /모르는 명령: --scenarios/);

  const usage = runDemo([]);
  assert.equal(usage.status, 2, `명령이 없는데 exit ${usage.status}`);
  assert.match(usage.stdout, /쓰는 법: node tools\/local\/demo\.mjs/);
});
