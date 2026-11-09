// check-trust-exceptions.mjs를 바깥에서 돌려 보는 시험(docs/devops.md §4.4 '예외를 둘 수 있는 조건', ADR-0191). 실행: node --test "tools/ci/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './git-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'check-trust-exceptions.mjs');
const repoRoot = join(here, '..', '..');

const DEVOPS = [
  '# devops',
  '### 4.4 의존성과 취약점',
  '- 신뢰 증거가 약해진 판을 만나면',
  '',
  '| 판 | 푼 방법 | 까닭 | 지울 조건 |',
  '| --- | --- | --- | --- |',
  '| `semver@6.3.1`(2023-07-10) | `trustPolicyExclude` | 까닭 | 조건 |',
  '',
  '### 4.5 다음 절',
  '- `left-pad@1.3.0`은 다른 절에만 있다',
].join('\n');

function run(files) {
  const root = tempDir('trust-exceptions-');
  for (const [path, body] of Object.entries({ 'docs/devops.md': DEVOPS, ...files })) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['add', '-A'], { cwd: root });
  return spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
}

const ws = (extra = '') => `packages:\n  - apps/*\nminimumReleaseAge: 4320\ntrustPolicy: no-downgrade\n${extra}`;

test('[ASVS v5.0.0-15.2.4] 저장소는 통과한다', () => {
  const r = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('[ASVS v5.0.0-15.2.4] §4.4 예외 표에 있는 이름@정확한 판은 통과한다', () => {
  const r = run({ 'pnpm-workspace.yaml': ws("trustPolicyExclude:\n  - 'semver@6.3.1'\n") });
  assert.equal(r.status, 0, r.stderr);
});

test('[ASVS v5.0.0-15.2.4] 판 없이 이름만 적은 예외는 막는다(그 패키지의 모든 판이 풀린다)', () => {
  const r = run({ 'pnpm-workspace.yaml': ws('trustPolicyExclude:\n  - semver\n') });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /semver.*정확한 판/);
});

test('[ASVS v5.0.0-15.2.4] 범위·여러 판·꼬리표로 적은 예외는 막는다', () => {
  for (const entry of ['semver@^6.3.1', 'semver@6.3.1 || 7.0.0', 'semver@6.x', 'semver@latest', '@seed-design/*']) {
    const r = run({ 'pnpm-workspace.yaml': ws(`trustPolicyExclude:\n  - '${entry}'\n`) });
    assert.equal(r.status, 1, entry);
    assert.match(r.stderr, /정확한 판/, entry);
  }
});

test('[ASVS v5.0.0-15.2.4] §4.4 예외 표에 없는 판은 막는다(다른 절에만 적힌 것도)', () => {
  for (const entry of ['semver@6.3.0', 'left-pad@1.3.0']) {
    const r = run({ 'pnpm-workspace.yaml': ws(`trustPolicyExclude:\n  - '${entry}'\n`) });
    assert.equal(r.status, 1, entry);
    assert.match(r.stderr, /§4\.4 예외 표/, entry);
  }
});

test('[ASVS v5.0.0-15.2.4] 범위 있는 패키지 이름(@범위/이름@판)도 같은 규칙이다', () => {
  const devops = DEVOPS.replace('| `semver@6.3.1`', '| `@seed-design/react-dialog@2.0.3`');
  const ok = run({ 'docs/devops.md': devops, 'pnpm-workspace.yaml': ws("trustPolicyExclude:\n  - '@seed-design/react-dialog@2.0.3'\n") });
  assert.equal(ok.status, 0, ok.stderr);
  const bad = run({ 'docs/devops.md': devops, 'pnpm-workspace.yaml': ws("trustPolicyExclude:\n  - '@seed-design/react-dialog'\n") });
  assert.equal(bad.status, 1);
});

test('[ASVS v5.0.0-15.2.4] 작업 공간 파일마다 trustPolicy: no-downgrade가 있어야 한다(끄거나 빼면 막는다)', () => {
  const off = run({ 'pnpm-workspace.yaml': 'packages:\n  - apps/*\ntrustPolicy: off\n' });
  assert.equal(off.status, 1);
  assert.match(off.stderr, /trustPolicy/);
  const missing = run({ 'tools/x/pnpm-workspace.yaml': 'packages: []\nminimumReleaseAge: 4320\n', 'pnpm-workspace.yaml': ws() });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /tools\/x\/pnpm-workspace\.yaml/);
});

test('[ASVS v5.0.0-15.2.4] trustPolicyExclude가 목록이 아니면 막는다', () => {
  const r = run({ 'pnpm-workspace.yaml': ws("trustPolicyExclude: 'semver@6.3.1'\n") });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /목록/);
});

test('[ASVS v5.0.0-15.2.4] §4.4 안의 코드 울타리 속 # 주석은 절 끝으로 보지 않는다', () => {
  const devops = DEVOPS.replace('- 신뢰 증거가 약해진 판을 만나면', '```yaml\n# pnpm-workspace.yaml 공통 설정\ntrustPolicy: no-downgrade\n```\n- 신뢰 증거가 약해진 판을 만나면');
  const r = run({ 'docs/devops.md': devops, 'pnpm-workspace.yaml': ws("trustPolicyExclude:\n  - 'semver@6.3.1'\n") });
  assert.equal(r.status, 0, r.stderr);
});

test('[ASVS v5.0.0-15.2.4] trustPolicyIgnoreAfter는 막는다(오래된 판의 신뢰 검사를 건너뛴다)', () => {
  const r = run({ 'pnpm-workspace.yaml': ws('trustPolicyIgnoreAfter: 1\n') });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /trustPolicyIgnoreAfter/);
});
