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
import { parseArgs, doctorChecks, DEMO_CLUSTER } from './demo.mjs';
import { SCENARIOS, SCENARIO_ORDER, REQUIRED_CHECKS, validateScenarios, publicPlan, readD5Scenarios } from './demo/scenarios.mjs';
import { checkCloudPlan, CLOUD_PLAN_FILE, MAX_TTL_HOURS, REQUIRED_CLEANUP } from './demo/cloud-plan.mjs';
import { breakOpenApi, compatPlan, runCompat, DEMO_TAG } from './demo/compat.mjs';
import { measurementText, redact, writeMeasurement } from './demo/measure.mjs';
import { DEMO_WORKLOADS, demoExpectedWorkloads } from './demo-objects.mjs';
import { DEMO_SEED_FILE } from './demo-auth.mjs';
import { checkSeed } from './demo-seed.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEMO_MJS = join(REPO, 'tools', 'local', 'demo.mjs');
const RUNNER_MJS = join(REPO, 'tools', 'local', 'demo', 'runner.mjs');
const MEASUREMENT = join(REPO, 'docs', 'review', 'measurements', 'BAT-086-demo.md');

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
  const env = { ...process.env, PATH: bin, PEAKET_TOOLS_DIR: join(root, '.cache', 'peaket-tools'), PEAKET_FAKE_CALLS: calls };
  return { root, bin, env, calls, text: () => readFileSync(calls, 'utf8') };
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
