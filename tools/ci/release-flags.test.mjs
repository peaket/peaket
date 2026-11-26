// 릴리스 플래그 정의 검사 계약 시험(docs/devops.md §5.4, ADR-0386 결정 5, F-09-2 계획 §5).
// 플래그 파일은 flagd 파일 모드 꼴이고, 소유자·만료일·기본 꺼짐이 있어야 한다. 출시 환경에는 두지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO, 'tools', 'ci', 'release-flags.mjs');
const dirs = [];

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'peaket-release-flags-'));
  dirs.push(root);
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, 'deploy', 'envs', path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof body === 'string' ? body : JSON.stringify(body, null, 2), 'utf8');
  }
  return root;
}

function flag(overrides = {}) {
  return {
    state: 'ENABLED',
    variants: { on: true, off: false },
    defaultVariant: 'off',
    metadata: { owner: 'lane1', expiresAt: '2026-12-31' },
    ...overrides,
  };
}

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd ?? REPO,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test.after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test('BAS-060 정상 플래그 정의는 통과한다', () => {
  const root = fixture({ 'local/flags/peaket.json': { flags: { 'checkout.new': flag() } } });
  const result = run(['--check', '--root', root, '--now', '2026-11-27']);
  assert.equal(result.status, 0, result.stderr);
});

test('BAS-060 소유자·만료일이 없으면 막는다', () => {
  const root = fixture({ 'local/flags/peaket.json': { flags: { a: flag({ metadata: {} }) } } });
  const result = run(['--check', '--root', root, '--now', '2026-11-27']);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /owner|expiresAt|소유자|만료/);
});

test('BAS-060 기본 변형이 꺼짐이 아니면 막는다', () => {
  const root = fixture({ 'local/flags/peaket.json': { flags: { a: flag({ defaultVariant: 'on' }) } } });
  const result = run(['--check', '--root', root, '--now', '2026-11-27']);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /defaultVariant|꺼짐|off/);
});

test('BAS-060 같은 환경에서 플래그 이름이 겹치면 막는다', () => {
  const root = fixture({
    'local/flags/a.json': { flags: { same: flag() } },
    'local/flags/b.json': { flags: { same: flag() } },
  });
  const result = run(['--check', '--root', root, '--now', '2026-11-27']);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /중복|duplicate|same/);
});

test('BAS-060 만료된 플래그는 경고하되 막지 않는다', () => {
  const root = fixture({
    'local/flags/peaket.json': { flags: { old: flag({ metadata: { owner: 'lane1', expiresAt: '2026-11-01' } }) } },
  });
  const result = run(['--check', '--root', root, '--now', '2026-11-27']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /만료|old/);
});

test('BAS-060 출시 환경(demo·staging·prod)에는 플래그 파일을 두지 않는다', () => {
  const root = fixture({
    'local/flags/peaket.json': { flags: {} },
    'prod/flags/peaket.json': { flags: { a: flag() } },
  });
  const free = run(['--check', '--root', root, '--now', '2026-11-27']);
  assert.equal(free.status, 0, free.stderr);
  const localOnly = run(['--local-only', '--root', root, '--now', '2026-11-27']);
  assert.equal(localOnly.status, 1);
  assert.match(localOnly.stdout + localOnly.stderr, /prod|local/);
});

test('BAS-060 플래그 파일을 읽지 못하면 통과로 보지 않는다', () => {
  const root = fixture({ 'local/flags/peaket.json': '{ broken' });
  const result = run(['--check', '--root', root, '--now', '2026-11-27']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
});

test('BAS-060 저장소의 로컬 플래그 파일이 실제로 있다', () => {
  const path = join(REPO, 'deploy', 'envs', 'local', 'flags', 'peaket.json');
  assert.ok(existsSync(path), `로컬 플래그 정의가 없다: ${path}`);
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(typeof parsed.flags, 'object');
  const result = run(['--check', '--local-only', '--now', '2026-11-27']);
  assert.equal(result.status, 0, result.stderr);
});
