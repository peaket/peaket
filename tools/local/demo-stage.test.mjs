// BAT-087 데모 무대 명령의 닫힌 실패(DS-11)와 정리 범위(DS-10)를 가짜 kubectl로 본다.
// 정본: docs/review/plans/BAT-087.md §6 DS-10·DS-11, §9 M9·M10.
// - demo-status는 기대 15개를 모두 읽고, 파드 0개·목록 빈 것을 통과로 세지 않는다(exit 1)
// - demo-down은 데모 네임스페이스 여섯만 지우고 kind 클러스터·다른 갈래는 건드리지 않는다
// 실행(저장소 뿌리): node --test "tools/local/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEMO_NAMESPACES, demoExpectedWorkloads } from './demo-objects.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLUSTER_MJS = join(REPO, 'tools', 'local', 'cluster.mjs');
const DEMO_OBJECTS = join(REPO, 'tools', 'local', 'demo-objects.mjs');

/** 가짜 child_process·tools·demo-objects와 실행기를 임시 폴더에 만든다 */
function fakeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'peaket-bat087-stage-'));
  writeFileSync(
    join(dir, 'fake-child-process.mjs'),
    `import { appendFileSync } from 'node:fs';
const record = (exe, args) => appendFileSync(process.env.PEAKET_FAKE_CALLS, JSON.stringify({ exe, args: args.map(String) }) + '\\n');
export function execFileSync(exe, args = []) {
  const name = String(exe).split(/[\\\\/]/).pop().replace(/\\.exe$/i, '');
  record(name, args);
  if (name === 'kubectl') {
    const a = args.map(String);
    const mode = process.env.PEAKET_FAKE_MODE ?? 'ready';
    const i = a.indexOf('get');
    if (i >= 0 && a[i + 1] === 'deploy' && a[i + 3] === '-o') {
      const ns = a[a.indexOf('-n') + 1];
      const dep = a[i + 2];
      if (mode === 'missing' && dep === 'identity-svc') {
        const e = new Error('Error from server (NotFound)');
        e.stderr = 'Error from server (NotFound)';
        throw e;
      }
      const ready = mode === 'zero' ? 0 : mode === 'one-zero' && dep === 'identity-svc' ? 0 : 1;
      const replicas = mode === 'zero' ? 0 : 1;
      return JSON.stringify({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: dep, namespace: ns }, status: { replicas, readyReplicas: ready, availableReplicas: ready } });
    }
    return '';
  }
  if (name === 'kind') return process.env.PEAKET_FAKE_KIND_OUT ?? '';
  return '';
}
export function spawnSync() { return { status: 0, stdout: '', stderr: '' }; }
export function spawn() { throw new Error('spawn은 이 시험에서 쓰지 않는다'); }
export function execSync() { throw new Error('execSync는 이 시험에서 쓰지 않는다'); }
`,
  );
  writeFileSync(
    join(dir, 'fake-tools.mjs'),
    `export const DEFAULT_ROOT = process.env.PEAKET_FAKE_TOOLS_ROOT ?? process.cwd();
export async function ensureTool(name) { return name; }
export async function httpsDownload() { throw new Error('이 시험은 내려받지 않는다'); }
`,
  );
  writeFileSync(
    join(dir, 'fake-demo-objects.mjs'),
    `import * as real from ${JSON.stringify(new URL(`file:///${DEMO_OBJECTS.replaceAll('\\', '/')}`).href)};
export * from ${JSON.stringify(new URL(`file:///${DEMO_OBJECTS.replaceAll('\\', '/')}`).href)};
export function demoExpectedWorkloads() {
  return process.env.PEAKET_FAKE_EMPTY_WORKLOADS === '1' ? [] : real.demoExpectedWorkloads();
}
`,
  );
  writeFileSync(
    join(dir, 'run.mjs'),
    `// 실제 명령줄처럼 demo 계열 이름을 argv[2]에 둔다(cluster.mjs가 데모 클러스터 기본값을 잡는다)
const cmd = process.argv[2];
process.argv[2] = cmd === 'status' ? 'demo-status' : cmd === 'down' ? 'demo-down' : 'demo';
const cluster = await import(${JSON.stringify(new URL(`file:///${CLUSTER_MJS.replaceAll('\\', '/')}`).href)});
if (cmd === 'status') await cluster.demoStatus(process.argv.slice(3));
else if (cmd === 'down') { await cluster.demoDown(); await cluster.demoDown(); }
else if (cmd === 'ports') { try { cluster.demoHostPorts(); } catch (e) { console.error(e.message); process.exit(1); } }
else { console.error('unknown'); process.exit(64); }
`,
  );
  writeFileSync(
    join(dir, 'hook.mjs'),
    `import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const dir = process.env.PEAKET_FAKE_DIR;
const fake = (name) => pathToFileURL(join(dir, name)).href;
const fakeRoot = pathToFileURL(dir + '/').href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    // 가짜 모듈이 진짜 모듈을 다시 부를 때는 가로채지 않는다(스스로를 가리키는 고리를 막는다)
    if (context.parentURL && context.parentURL.startsWith(fakeRoot)) return nextResolve(specifier, context);
    if (specifier === 'node:child_process') return { url: fake('fake-child-process.mjs'), shortCircuit: true };
    if (specifier === './tools.mjs' || specifier.endsWith('/tools.mjs')) return { url: fake('fake-tools.mjs'), shortCircuit: true };
    if (specifier === './demo-objects.mjs' || specifier.endsWith('/demo-objects.mjs')) return { url: fake('fake-demo-objects.mjs'), shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
`,
  );
  return dir;
}

/** 가짜 환경으로 cluster.mjs의 demo-status/demo-down을 부른다 */
function runStage(dir, cmd, env = {}) {
  const calls = join(dir, `calls-${cmd}-${Math.random().toString(16).slice(2)}.jsonl`);
  writeFileSync(calls, '');
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(join(dir, 'hook.mjs')).href, join(dir, 'run.mjs'), cmd, '--json'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, PEAKET_FAKE_DIR: dir, PEAKET_FAKE_CALLS: calls, PEAKET_FAKE_TOOLS_ROOT: dir, PEAKET_CLUSTER: 'lane4-test', ...env },
  });
  const recorded = readFileSync(calls, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { ...r, calls: recorded };
}

test('DS-11 demo-status가 견줄 기대는 15개이고 빈 목록은 통과가 아니다', () => {
  const expected = demoExpectedWorkloads();
  assert.equal(expected.length, 15, `기대 워크로드 수 ${expected.length}`);
  const dir = fakeDir();
  const r = runStage(dir, 'status', { PEAKET_FAKE_EMPTY_WORKLOADS: '1' });
  assert.equal(r.status, 1, `빈 목록인데 exit ${r.status}다(0건을 통과로 셌다)`);
  assert.match(r.stderr + r.stdout, /no-workloads/, `no-workloads가 없다: ${r.stderr}${r.stdout}`);
  assert.equal(r.calls.length, 0, '빈 목록인데 kubectl을 불렀다');
});

test('DS-11 모든 워크로드가 준비되면 demo-status가 exit 0이고 15개를 찍는다', () => {
  const dir = fakeDir();
  const r = runStage(dir, 'status', { PEAKET_FAKE_MODE: 'ready' });
  assert.equal(r.status, 0, `demo-status 실패: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.workloads.length, 15, `읽은 워크로드 수 ${out.workloads.length}`);
  for (const w of out.workloads) assert.equal(w.ready, w.expected, `${w.namespace}/${w.name} ready ${w.ready}/${w.expected}`);
  assert.deepEqual(out.problems, []);
  // deployment 하나를 실제로 읽는다(이름·네임스페이스)
  assert.ok(r.calls.some((c) => c.args.includes('deploy') && c.args.includes('identity-svc')), 'identity-svc Deployment를 읽지 않았다');
});

test('DS-11 파드가 0개(readyReplicas 0)면 demo-status가 exit 1이고 pods-not-ready를 찍는다', () => {
  const dir = fakeDir();
  const r = runStage(dir, 'status', { PEAKET_FAKE_MODE: 'zero' });
  assert.equal(r.status, 1, `파드 0개인데 exit ${r.status}다(0건을 통과로 셌다)`);
  assert.match(r.stderr + r.stdout, /pods-not-ready/, `pods-not-ready가 없다: ${r.stderr}${r.stdout}`);
  assert.match(r.stderr + r.stdout, /identity-svc/, '준비 안 된 워크로드 이름이 없다');
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.workloads.length, 15);
});

test('DS-11 하나만 미준비여도 exit 1이고 그 이름을 찍는다', () => {
  const dir = fakeDir();
  const r = runStage(dir, 'status', { PEAKET_FAKE_MODE: 'one-zero' });
  assert.equal(r.status, 1, `하나가 미준비인데 exit ${r.status}다`);
  assert.match(r.stderr + r.stdout, /pods-not-ready core\/identity-svc/, `미준비 워크로드 이름이 없다: ${r.stderr}${r.stdout}`);
  // 다른 워크로드는 통과로 읽혔다
  const out = JSON.parse(r.stdout);
  assert.equal(out.workloads.find((w) => w.name === 'core-svc')?.ready, 1);
});

test('DS-11 Deployment가 없어도 exit 1이고 missing을 찍는다', () => {
  const dir = fakeDir();
  const r = runStage(dir, 'status', { PEAKET_FAKE_MODE: 'missing' });
  assert.equal(r.status, 1, `Deployment가 없는데 exit ${r.status}다`);
  assert.match(r.stderr + r.stdout, /missing core\/identity-svc/, `missing이 없다: ${r.stderr}${r.stdout}`);
});

test('DS-10 demo-down은 데모 네임스페이스 여섯만 지우고 kind 클러스터를 건드리지 않는다', () => {
  const dir = fakeDir();
  const r = runStage(dir, 'down');
  assert.equal(r.status, 0, `demo-down 두 번이 실패했다: ${r.stderr}`);
  assert.deepEqual([...DEMO_NAMESPACES].sort(), ['core', 'purchase', 'queue', 'ticket', 'trust', 'web'].sort(), '데모 네임스페이스 목록');
  assert.equal(r.calls.filter((c) => c.exe === 'kind').length, 0, `demo-down이 kind를 불렀다: ${JSON.stringify(r.calls.filter((c) => c.exe === 'kind'))}`);
  const deletes = r.calls.filter((c) => c.exe === 'kubectl' && c.args.includes('delete') && c.args.includes('namespace'));
  assert.equal(deletes.length, DEMO_NAMESPACES.length * 2, `demo-down 두 번의 네임스페이스 삭제 수 ${deletes.length}`);
  for (const c of deletes) {
    const ns = c.args[c.args.indexOf('namespace') + 1];
    assert.ok(DEMO_NAMESPACES.includes(ns), `데모 밖 네임스페이스 ${ns}를 지웠다`);
    assert.ok(c.args.includes('--ignore-not-found'), `${ns} 삭제에 --ignore-not-found가 없다(두 번 불러도 exit 0이어야 한다)`);
  }
  assert.match(r.stdout, /클러스터 .*는 그대로/, `클러스터를 남긴다는 안내가 없다: ${r.stdout}`);
});

test('DS-10 demo-down은 클러스터 이름·kubeconfig 기본값을 lane4-demo로 잡는다', () => {
  const source = readFileSync(CLUSTER_MJS, 'utf8');
  assert.match(source, /kubeconfig-\$\{CLUSTER\}/, 'kubeconfig 이름이 클러스터를 따라가지 않는다');
  // demo 명령일 때만 lane4-demo를 기본으로 잡는다(다른 갈래의 peaket 클러스터를 건드리지 않게)
  assert.match(source, /demo\(\?:-\|\$\)|demoCommand/, 'demo 명령 판별이 없다');
  const demoDown = source.slice(source.indexOf('export async function demoDown'));
  assert.doesNotMatch(demoDown.slice(0, demoDown.indexOf('\n}\n') + 1), /await down\(\)|kind\(\[/, 'demo-down이 클러스터 삭제(down)를 부른다');
});

test('RV-04 데모 포트가 없을 때 안내는 lane4-demo를 명시하고 기본 peaket을 지우지 않는다', () => {
  const dir = fakeDir();
  const r = runStage(dir, 'ports', { PEAKET_DEMO_CLUSTER: 'lane4-demo' });
  assert.equal(r.status, 1, `포트가 없는데 exit ${r.status}다`);
  assert.match(r.stderr, /PEAKET_CLUSTER=lane4-demo node tools\/local\/cluster\.mjs down/, `클러스터를 명시한 안내가 없다: ${r.stderr}`);
  assert.match(r.stderr, /node tools\/local\/cluster\.mjs demo/, `demo로 다시 만들라는 안내가 없다: ${r.stderr}`);
  // README의 복구 안내도 같은 명령을 쓴다(기본 peaket을 지우지 않는다)
  const readme = readFileSync(join(REPO, 'deploy', 'envs', 'local', 'demo', 'README.md'), 'utf8');
  assert.match(readme, /PEAKET_CLUSTER=lane4-demo node tools\/local\/cluster\.mjs down/, 'README 26행의 복구 안내');
  assert.doesNotMatch(readme, /`node tools\/local\/cluster\.mjs down` 뒤 `up`/, 'README가 기본 peaket을 지우는 안내를 그대로 쓴다');
});

test('RV-05 demo 계열 명령은 PEAKET_DEMO_CLUSTER를 따르고 다른 명령과 클러스터를 가른다', () => {
  const dir = fakeDir();
  const env = { PEAKET_DEMO_CLUSTER: 'lane4-alt', PEAKET_CLUSTER: 'lane4-test' };
  const r = runStage(dir, 'status', env);
  assert.equal(r.status, 0, `demo-status 실패: ${r.stderr}`);
  const args = r.calls[0]?.args ?? [];
  const i = args.indexOf('--kubeconfig');
  assert.ok(i >= 0, 'kubectl에 --kubeconfig가 없다');
  assert.match(String(args[i + 1]).replaceAll('\\', '/'), /kubeconfig-lane4-alt$/, `kubeconfig가 PEAKET_DEMO_CLUSTER를 따르지 않는다: ${args[i + 1]}`);
  const down = runStage(dir, 'down', env);
  assert.match(down.stdout, /클러스터 lane4-alt는 그대로/, `demo-down이 PEAKET_DEMO_CLUSTER를 따르지 않는다: ${down.stdout}`);
});

test('DS-12 demo-status·demo-down 콘솔 출력에 비밀·개인정보가 없다', () => {
  const dir = fakeDir();
  const ok = runStage(dir, 'status', { PEAKET_FAKE_MODE: 'ready' });
  const down = runStage(dir, 'down');
  for (const r of [ok, down]) {
    const text = r.stdout + r.stderr;
    assert.doesNotMatch(text, /password|totp|Bearer|PRIVATE KEY|postgres:\/\//i, `데모 명령 출력에 비밀 낱말·값이 있다: ${text}`);
  }
});
