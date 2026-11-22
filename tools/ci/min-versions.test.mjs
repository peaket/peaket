// 최소 판 검사의 명령줄 시험(V-T39 ③, docs/verification.md V-T39, docs/devops.md §4.4 '설정이 기대는 최소 판', ADR-0356 결정 5, ASVS v5.0.0-15.2.1).
// 검사를 모듈 함수로만 보지 않고 바깥에서 돌린다: node tools/ci/min-versions.mjs --root <임시 저장소>.
// 임시 저장소에는 저장소의 docs/devops.md를 그대로 복사하고(최소 판은 정본 줄에서 읽는다), 잠금 파일·이미지 파일은 사례마다 만든다.
// 판 값은 정본(devops §4.4: Sentry 10.57.0 이상·같은 판, PgBouncer 1.26.1 이상)에 맞춰 고르고, 두 자리 마디(9 → 57 → 100)를 넣어 글자 비교를 잡는다.
// 실행(저장소 뿌리): node --test tools/ci/min-versions.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './git-fixture.mjs';
import { compareVersions } from './min-versions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'min-versions.mjs');
const REPO = resolve(HERE, '..', '..');
const DEVOPS = 'docs/devops.md';

function cli(...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: REPO });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const blocked = (out) => out.split('\n').filter((l) => l.startsWith('막음:'));
const writeIn = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

/** pnpm 9 잠금 파일 꼴(packages·snapshots 절). pkgs: { '@sentry/node': '10.9.0', … } */
function lockfile(pkgs) {
  const entries = Object.entries(pkgs);
  const pkgLines = entries.map(([n, v]) => `  '${n}@${v}':\n    resolution: {integrity: sha512-AAAA}\n    engines: {node: '>=18'}\n`).join('\n');
  const snapLines = entries.map(([n, v]) => `  '${n}@${v}': {}\n`).join('\n');
  return `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n\nimporters:\n\n  .: {}\n\npackages:\n\n${pkgLines}\nsnapshots:\n\n${snapLines}`;
}

/** 임시 저장소: 정본 devops.md 그대로, 잠금 파일과 PgBouncer 이미지 하나 */
function fixture({ sentry = { '@sentry/node': '10.57.0' }, pgbouncer = '1.26.1' } = {}) {
  const root = tempDir('min-versions-');
  writeIn(root, DEVOPS, readFileSync(join(REPO, DEVOPS), 'utf8'));
  writeIn(root, 'pnpm-lock.yaml', lockfile({ 'left-pad': '1.3.0', ...sentry }));
  if (pgbouncer) writeIn(root, 'deploy/charts/pgbouncer/values.yaml', `pgbouncer:\n  image: docker.io/edoburu/pgbouncer:${pgbouncer}@sha256:${'a'.repeat(64)}\n  port: 6432\n`);
  return root;
}

test('V-T39 ③ [ASVS v5.0.0-15.2.1] @sentry 판이 최소 판보다 낮으면 1로 끝난다', () => {
  const low = cli('--root', fixture({ sentry: { '@sentry/node': '10.9.0' } }));
  assert.equal(low.status, 1, low.out);
  const lines = blocked(low.out);
  assert.equal(lines.length, 1, low.out);
  assert.match(lines[0], /@sentry\/node 10\.9\.0/);
  assert.match(lines[0], /10\.57\.0/);
  // 같은 판과 두 자리 마디가 더 큰 판은 통과(글자 비교면 10.100.0 < 10.57.0으로 막힌다)
  for (const v of ['10.57.0', '10.100.0', '11.15.0']) {
    const ok = cli('--root', fixture({ sentry: { '@sentry/node': v, '@sentry/core': v } }));
    assert.equal(ok.status, 0, `${v}: ${ok.out}`);
    assert.deepEqual(blocked(ok.out), []);
  }
});

test('V-T39 ③ 브라우저·서버 @sentry 판이 다르면 1이다', () => {
  const r = cli('--root', fixture({ sentry: { '@sentry/node': '10.60.0', '@sentry/browser': '10.58.0' } }));
  assert.equal(r.status, 1, r.out);
  const lines = blocked(r.out);
  assert.equal(lines.length, 1, r.out);
  assert.match(lines[0], /@sentry\/node 10\.60\.0/);
  assert.match(lines[0], /@sentry\/browser 10\.58\.0/);
  // 같은 판이면 통과
  const same = cli('--root', fixture({ sentry: { '@sentry/node': '10.60.0', '@sentry/browser': '10.60.0' } }));
  assert.equal(same.status, 0, same.out);
});

test('V-T39 ③ PgBouncer 이미지 이름표가 최소 판보다 낮으면 1이다', () => {
  const low = cli('--root', fixture({ pgbouncer: '1.26.0' }));
  assert.equal(low.status, 1, low.out);
  assert.equal(blocked(low.out).length, 1, low.out);
  assert.match(blocked(low.out)[0], /deploy\/charts\/pgbouncer\/values\.yaml:2: .*pgbouncer:1\.26\.0/);
  // v 앞머리 이름표와 두 자리 마디
  for (const [tag, want] of [['1.26.1', 0], ['v1.26.1', 0], ['1.100.0', 0], ['v1.9.9', 1]]) {
    const r = cli('--root', fixture({ pgbouncer: tag }));
    assert.equal(r.status, want, `${tag}: ${r.out}`);
  }
});

test('V-T39 ③ 최소 판 줄이나 잠금 파일을 읽지 못하면 2이고 통과로 보지 않는다', () => {
  // 정본의 '설정이 기대는 최소 판' 줄이 없다
  const noSection = fixture();
  writeIn(noSection, DEVOPS, readFileSync(join(noSection, DEVOPS), 'utf8').replace('**설정이 기대는 최소 판', '**설정이 기대는 판'));
  const a = cli('--root', noSection);
  assert.equal(a.status, 2, a.out);
  assert.doesNotMatch(a.out, /min-versions: 통과/);
  // Sentry 항목에서 '<판> 이상'을 읽지 못한다
  const noMin = fixture();
  writeIn(noMin, DEVOPS, readFileSync(join(noMin, DEVOPS), 'utf8').replace('10.57.0 이상', '최신 판'));
  const b = cli('--root', noMin);
  assert.equal(b.status, 2, b.out);
  assert.match(b.out, /Sentry/);
  // 잠금 파일이 없다
  const noLock = fixture();
  rmSync(join(noLock, 'pnpm-lock.yaml'));
  const c = cli('--root', noLock);
  assert.equal(c.status, 2, c.out);
  assert.match(c.out, /pnpm-lock\.yaml/);
  // 잠금 파일에 패키지가 하나도 없다(읽은 줄 0은 통과가 아니다)
  for (const text of ["lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n", "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\npackages:\n\nsnapshots:\n"]) {
    const emptyLock = fixture();
    writeIn(emptyLock, 'pnpm-lock.yaml', text);
    const d = cli('--root', emptyLock);
    assert.equal(d.status, 2, d.out);
    assert.match(d.out, /pnpm-lock\.yaml/);
  }
  // 모르는 인자·값 없는 --root
  assert.equal(cli('--strict').status, 2);
  assert.equal(cli('--root').status, 2);
  // 실제 저장소는 통과한다
  const real = cli();
  assert.equal(real.status, 0, real.out);
  assert.match(real.out, /Sentry JavaScript SDK 10\.57\.0 이상: @sentry\/core@/);
});

test('V-T39 ③ 판은 숫자 마디로 견주고 CI tools-check가 이 검사를 돌린다', () => {
  assert.equal(compareVersions('10.9.0', '10.57.0'), -1);
  assert.equal(compareVersions('10.100.0', '10.57.0'), 1);
  assert.equal(compareVersions('v1.26.1', '1.26.1'), 0);
  assert.equal(compareVersions('10.57', '10.57.0'), 0);
  assert.throws(() => compareVersions('latest', '10.57.0'));
  const workflow = readFileSync(join(REPO, '.github/workflows/tools-check.yml'), 'utf8');
  assert.match(workflow, /^\s+- run: node tools\/ci\/min-versions\.mjs\s*$/m);
});
