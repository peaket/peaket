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

// files: { '상대 경로/package.json': { ...manifest } }
function run(files) {
  const root = mkdtempSync(join(tmpdir(), 'workspace-protocol-'));
  for (const [path, manifest] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  }
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
