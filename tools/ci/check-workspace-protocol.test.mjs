// check-workspace-protocol.mjs를 바깥에서 돌려 보는 시험. 실행: node --test "tools/ci/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'check-workspace-protocol.mjs');
const repoRoot = join(here, '..', '..');

function write(root, files) {
  for (const [path, manifest] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  }
}

// files: { '상대 경로/package.json': { ...manifest } }. git으로 추적하는 저장소를 만들고 돌린다.
// untracked: 추적하지 않은 채 두는 파일(검사가 보지 않아야 한다)
function run(files, untracked = {}) {
  const root = mkdtempSync(join(tmpdir(), 'workspace-protocol-'));
  write(root, files);
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['add', '-A'], { cwd: root });
  write(root, untracked);
  return spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
}

test('저장소는 통과한다', () => {
  const r = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('workspace: 판은 통과한다', () => {
  const r = run({
    'package.json': { name: 'peaket', private: true },
    'apps/web/package.json': { dependencies: { '@peaket/ds': 'workspace:*' }, devDependencies: { '@peaket/config': 'workspace:^' } },
  });
  assert.equal(r.status, 0, r.stderr);
});

test('레지스트리 판으로 적은 @peaket/*은 실패한다', () => {
  const r = run({ 'apps/web/package.json': { dependencies: { '@peaket/ds': '^1.0.0' } } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /dependencies\.@peaket\/ds/);
});

test('네 의존성 칸을 모두 본다', () => {
  const r = run({
    'a/package.json': { peerDependencies: { '@peaket/platform': '1.0.0' } },
    'b/package.json': { optionalDependencies: { '@peaket/telemetry': 'latest' } },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /peerDependencies\.@peaket\/platform/);
  assert.match(r.stderr, /optionalDependencies\.@peaket\/telemetry/);
});

test('다른 범위의 패키지는 보지 않는다', () => {
  const r = run({ 'package.json': { dependencies: { '@other/ds': '^1.0.0', react: '19.3.0' } } });
  assert.equal(r.status, 0, r.stderr);
});

test('node_modules 안은 건너뛴다', () => {
  const r = run({
    'package.json': { name: 'peaket' },
    'node_modules/@peaket/ds/package.json': { dependencies: { '@peaket/config': '^1.0.0' } },
  });
  assert.equal(r.status, 0, r.stderr);
});

test('읽을 수 없는 package.json은 실패한다', () => {
  const r = run({ 'package.json': '{ 깨진 JSON' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /JSON으로 읽을 수 없다/);
});

// 코드 리뷰 반영(2026-10-30): 내부 패키지를 레지스트리로 돌리는 다른 길들
test('overrides로 @peaket/*을 바꾸면 실패한다', () => {
  const r = run({ 'package.json': { name: 'peaket', overrides: { '@peaket/ds': '1.0.0' } } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /overrides/);
});

test('pnpm.overrides와 resolutions도 본다', () => {
  const r = run({
    'package.json': { name: 'peaket', pnpm: { overrides: { 'foo>@peaket/ds': '^1' } }, resolutions: { '@peaket/config': '2.0.0' } },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /pnpm\.overrides/);
  assert.match(r.stderr, /resolutions/);
});

test('npm: 별칭으로 @peaket/*을 받으면 실패한다', () => {
  const r = run({ 'apps/web/package.json': { dependencies: { ds: 'npm:@peaket/ds@^1.0.0' } } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /npm: 별칭/);
});

test('pnpm-workspace.yaml에 @peaket/ 이름이 있으면 실패한다', () => {
  const r = run({
    'package.json': { name: 'peaket' },
    'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\noverrides:\n  '@peaket/ds': 1.0.0\n",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /pnpm-workspace\.yaml/);
});

test('pnpm-workspace.yaml의 주석에 쓴 @peaket/ 이름은 괜찮다', () => {
  const r = run({ 'package.json': { name: 'peaket' }, 'pnpm-workspace.yaml': "# @peaket/* 패키지는 workspace:로만 잇는다\npackages:\n  - 'apps/*'\n" });
  assert.equal(r.status, 0, r.stderr);
});

test('git이 추적하지 않는 package.json은 보지 않는다', () => {
  const r = run({ 'package.json': { name: 'peaket' } }, { 'scratch/package.json': { dependencies: { '@peaket/ds': '^1.0.0' } } });
  assert.equal(r.status, 0, r.stderr);
});
