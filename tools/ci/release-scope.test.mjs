// release-scope.mjs를 바깥에서 돌려 보는 시험. 실행: node --test "tools/ci/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './git-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'release-scope.mjs');
const repoRoot = join(here, '..', '..');

// 시험 무대는 기능 105개를 만든다. 도구가 v1 범위의 105개를 요구하므로 작은 무대로는 검사기를 시험할 수 없다.
// 앞 32개 release, 다음 6개 gate, 나머지 67개 frozen-local이다.
const IDS = Array.from({ length: 105 }, (_, i) => `F-01-${i + 1}`);
const RELEASE = IDS.slice(0, 32);
const GATE = IDS.slice(32, 38);
const FROZEN = IDS.slice(38);
const STATUS = new Map([
  ...RELEASE.map((id) => [id, '완료']),
  ...GATE.map((id) => [id, '진행']),
  ...FROZEN.map((id) => [id, '동결']),
]);
const CLASS = new Map([
  ...RELEASE.map((id) => [id, 'release']),
  ...GATE.map((id) => [id, 'gate']),
  ...FROZEN.map((id) => [id, 'frozen-local']),
]);

function buildOrderRows() {
  return IDS.map((id) => `| ${id} | 시험 | B | T-1 | 1.00 | - | 한다 | - | ${STATUS.get(id)} | - |`);
}

function tableRows() {
  return IDS.map((id) => `| ${id} | 시험 | 기능 ${id} | ${STATUS.get(id)} | ${CLASS.get(id)} | ${id} 근거 | - | 없음 | - | 없음 |`);
}

function manifest() {
  return {
    version: 'v1',
    features: Object.fromEntries(IDS.map((id) => [id, { class: CLASS.get(id), reason: `${id} 근거` }])),
    gates: [...GATE],
    frozen: [...FROZEN],
  };
}

function writeFixture(mutate = () => {}) {
  const dir = tempDir('release-scope-');
  const data = {
    build: buildOrderRows(),
    table: tableRows(),
    manifest: manifest(),
  };
  mutate(data, dir);
  mkdirSync(join(dir, 'docs/release'), { recursive: true });
  writeFileSync(join(dir, 'docs/BUILD_ORDER.md'), ['# 빌드 순서', '', '| 묶음 | 영역 | 등급 | 단계 | WBS 일 | 장부 범위 | 완료 정의 | 선행 | 상태 | 비고 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |', ...data.build, ''].join('\n'));
  writeFileSync(join(dir, 'docs/release/v1-scope.md'), ['# v1 범위', '', '| ID | 영역 | 기능 | BUILD_ORDER 상태 | 분류 | 출시 근거·게이트 | 배포 단위 | 플래그 | 마이그레이션 | 남은 일 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |', ...data.table, ''].join('\n'));
  writeFileSync(join(dir, 'docs/release/v1-scope.json'), typeof data.manifest === 'string' ? data.manifest : JSON.stringify(data.manifest, null, 2));
  return dir;
}

function run(dir, ...args) {
  return spawnSync(process.execPath, [script, '--root', dir, ...args], { encoding: 'utf8' });
}

test('맞는 무대는 --check를 통과한다', () => {
  const r = run(writeFixture(), '--check');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /release 32, gate 6, frozen-local 67/);
});

test('manifest에 없는 기능은 실패한다', () => {
  const dir = writeFixture((d) => {
    delete d.manifest.features['F-01-5'];
  });
  const r = run(dir, '--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /F-01-5가 빠졌다/);
});

test('manifest에만 있는 기능은 실패한다', () => {
  const dir = writeFixture((d) => {
    d.manifest.features['F-09-99'] = { class: 'release', reason: '없는 기능' };
  });
  const r = run(dir, '--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /F-09-99/);
});

test('manifest의 중복 키는 실패한다', () => {
  const dir = writeFixture((d) => {
    d.manifest = JSON.stringify(d.manifest, null, 2).replace('"F-01-1": {', '"F-01-1": {},\n    "F-01-1": {');
  });
  const r = run(dir, '--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /F-01-1가 2번 나온다/);
});

test('분류 표의 중복 줄은 실패한다', () => {
  const dir = writeFixture((d) => {
    d.table.push(d.table[0]);
  });
  const r = run(dir, '--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /줄에도 있다/);
});

test('표와 manifest의 분류가 다르면 실패한다', () => {
  const dir = writeFixture((d) => {
    d.table[0] = d.table[0].replace('| release |', '| gate |');
  });
  const r = run(dir, '--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /분류 'gate'가 manifest 'release'와 다르다/);
});

test('표의 근거 칸이 manifest와 다르면 실패한다', () => {
  const dir = writeFixture((d) => {
    d.table[0] = d.table[0].replace('| F-01-1 근거 |', '| 다른 근거 |');
  });
  const r = run(dir, '--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /출시 근거·게이트 칸이 manifest와 다르다/);
});

test('gates 배열이 분류와 다르면 실패한다', () => {
  const dir = writeFixture((d) => {
    d.manifest.gates = d.manifest.gates.slice(1);
  });
  const r = run(dir, '--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gates:.*빠졌다/);
});

test('frozen 배열에 분류가 다른 기능이 있으면 실패한다', () => {
  const dir = writeFixture((d) => {
    d.manifest.frozen.push('F-01-1');
  });
  const r = run(dir, '--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /frozen:.*F-01-1/);
});

test('동결 기능을 release로 분류하면 실패한다', () => {
  const dir = writeFixture((d) => {
    d.manifest.features['F-01-40'].class = 'release';
    d.manifest.frozen = d.manifest.frozen.filter((id) => id !== 'F-01-40');
  });
  const r = run(dir, '--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /F-01-40는 release인데 BUILD_ORDER 상태 '동결'는 쓸 수 없다/);
});

test('표의 BUILD_ORDER 상태가 실제와 다르면 실패한다', () => {
  const dir = writeFixture((d) => {
    d.table[0] = d.table[0].replace('| 완료 | release |', '| 진행 | release |');
  });
  const r = run(dir, '--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /BUILD_ORDER 상태 '진행'가 실제 '완료'와 다르다/);
});

test('--release는 릴리스 가지에서 맞는 무대를 통과한다', () => {
  const r = run(writeFixture(), '--release', '--branch', 'release/1.0.0');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /플래그 0개/);
  assert.match(r.stdout, /한계: 마이그레이션/);
});

test('--release는 릴리스 가지가 아니면 실패한다', () => {
  const r = run(writeFixture(), '--release', '--branch', 'feature/x');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /release\/\* 또는 main이 아니다/);
});

test('--release는 릴리스 플래그에 섞인 동결 기능을 잡는다', () => {
  const dir = writeFixture((d, dir) => {
    mkdirSync(join(dir, 'deploy/envs/demo/flags'), { recursive: true });
    writeFileSync(join(dir, 'deploy/envs/demo/flags/demo.yaml'), 'flags:\n  someFlag:\n    feature: F-01-40\n');
  });
  const r = run(dir, '--release', '--branch', 'release/1.0.0');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /동결 기능 F-01-40가 릴리스 플래그에 있다/);
});

test('--release는 마이그레이션 주석에 섞인 동결 기능을 잡는다', () => {
  const dir = writeFixture((d, dir) => {
    mkdirSync(join(dir, 'services/ticket-svc/migrations'), { recursive: true });
    writeFileSync(join(dir, 'services/ticket-svc/migrations/0001_test.sql'), '-- F-01-40 동결 몫\nCREATE TABLE x (id int);\n');
  });
  const r = run(dir, '--release', '--branch', 'release/1.0.0');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /동결 기능 F-01-40가 마이그레이션에 있다/);
});

test('저장소의 v1 범위는 38·0·67이고 gate가 없다', () => {
  const r = spawnSync(process.execPath, [script, '--check'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'docs/release/v1-scope.json'), 'utf8'));
  assert.deepEqual(manifest.gates, []);
  const counts = { release: 0, gate: 0, 'frozen-local': 0 };
  for (const value of Object.values(manifest.features)) counts[value.class] += 1;
  assert.deepEqual(counts, { release: 38, gate: 0, 'frozen-local': 67 });
});

test('--help는 사용법을 찍고 통과한다', () => {
  const r = spawnSync(process.execPath, [script, '--help'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /사용법/);
});
