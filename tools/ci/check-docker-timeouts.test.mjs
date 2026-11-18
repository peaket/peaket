// tools/ci/check-docker-timeouts.mjs 시험(ADR-0283 결정 4, 계획 docs/review/plans/W10-guards.md G2·G3 시험 DT-01~14)
// 단언 값(상한 300,000ms, 보는 폴더·시험 파일 정의, 출력 줄 꼴)은 정본과 계획에서 숫자·글로 적는다(스크립트의 상수를 가져오지 않는다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inScope, dockerCalls } from './check-docker-timeouts.mjs';
import { repo, commit, tempDir } from './git-fixture.mjs';

const SCRIPT = join(import.meta.dirname, 'check-docker-timeouts.mjs');
const ROOT = join(import.meta.dirname, '..', '..');
const HEAD = "import { execFileSync, execFile, spawnSync, spawn, execSync, exec } from 'node:child_process';\n";
const OK_CALL = "execFileSync('docker', ['ps'], { encoding: 'utf8', timeout: 300_000 });\n";
const OK_FILE = 'services/ok/test-int/ok.ts';

// CI(GITHUB_ACTIONS=true)에서 돌아도 '막음: ' 꼴을 보게 환경 변수를 뗀다. 빈 폴더가 바깥 git 저장소로 읽히지 않게 위로 찾지 않는다
function run(args, { github = false, ceiling } = {}) {
  const env = { ...process.env };
  delete env.GITHUB_ACTIONS;
  if (github) env.GITHUB_ACTIONS = 'true';
  if (ceiling) env.GIT_CEILING_DIRECTORIES = ceiling;
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
  return { ...r, lines: r.stdout.split(/\r?\n/).filter(Boolean) };
}

// files는 git add까지 하고 untracked는 쓰기만 한다(점검은 git ls-files를 본다)
function check(files, { untracked = {}, github = false } = {}) {
  const dir = repo('docker-timeouts-');
  commit(dir, { 'README.md': '# 시험 저장소\n', ...files }, 'test: 처음');
  for (const [path, text] of Object.entries(untracked)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return run(['--root', dir], { github });
}

const blocked = (r, path, line) => r.lines.find((l) => l.startsWith(`막음: ${path}:${line} `));
const show = (r) => `끝 코드 ${r.status}\n${r.stdout}${r.stderr}`;

test('DT-01 시간 제한이 있으면 통과한다', () => {
  const r = check({ 'services/a/test-int/pg.ts': `${HEAD}export const docker = (args: string[]) =>\n  execFileSync('docker', args, { encoding: 'utf8', timeout: 300_000 });\n` });
  assert.equal(r.status, 0, show(r));
  assert.equal(r.lines.at(-1), '통과: 시험 파일 1개, Docker 호출 1곳');
});

test('DT-02 시간 제한이 없으면 그 파일:줄을 막는다', () => {
  const r = check({ 'services/a/test-int/pg.ts': `${HEAD}export const docker = (args: string[]) =>\n  execFileSync('docker', args, { encoding: 'utf8' });\n` });
  assert.equal(r.status, 1, show(r));
  const l = blocked(r, 'services/a/test-int/pg.ts', 3);
  assert.ok(l, show(r));
  assert.match(l, /timeout/);
  assert.equal(r.lines.at(-1), '막음: 시험 파일 1개, Docker 호출 1곳, 문제 1건');
});

test('DT-03 호출 꼴마다 찾는다', () => {
  const cases = {
    'exec-file.ts': ["execFile('docker', ['ps'], () => {});", 2],
    'spawn-sync.ts': ["spawnSync('docker', ['ps'], { stdio: 'inherit' });", 2],
    'spawn.ts': ["spawn('docker', ['ps'], { stdio: 'inherit' });", 2],
    'exec-sync.ts': ["execSync('docker rm -f x');", 2],
    'exec.ts': ['exec("docker ps", () => {});', 2],
    'backtick.ts': ["execFileSync(`docker`, ['ps'], { encoding: 'utf8' });", 2],
    'promisify.ts': ["await promisify(execFile)('docker', ['ps'], { encoding: 'utf8' });", 2],
    'dotted.ts': ["child_process.execFileSync('docker', ['ps'], { encoding: 'utf8' });", 2],
    'newline.ts': ["const out = execFileSync(\n  'docker',\n  ['ps'],\n  { encoding: 'utf8' },\n);", 2],
  };
  const files = {};
  for (const [name, [code]] of Object.entries(cases)) files[`services/a/test-int/${name}`] = `${HEAD}${code}\n`;
  const r = check(files);
  assert.equal(r.status, 1, show(r));
  for (const [name, [, line]] of Object.entries(cases)) {
    const l = blocked(r, `services/a/test-int/${name}`, line);
    assert.ok(l, `${name}: ${show(r)}`);
    assert.match(l, /timeout/);
  }
  assert.equal(r.lines.at(-1), `막음: 시험 파일 9개, Docker 호출 9곳, 문제 9건`);
  // 함수로도 같은 꼴을 찾는다(호출마다 ok가 false, 까닭에 timeout)
  for (const [name, [code, line]] of Object.entries(cases)) {
    const calls = dockerCalls(`${HEAD}${code}\n`);
    assert.equal(calls.length, 1, name);
    assert.equal(calls[0].line, line, name);
    assert.equal(calls[0].ok, false, name);
    assert.match(calls[0].reason, /timeout/, name);
  }
});

test('DT-04 여러 줄 호출과 글 조각 속 괄호', () => {
  const multiOk = `${HEAD}const out = execFileSync('docker',\n  ['ps'],\n  { encoding: 'utf8', timeout: 300_000 });\n`;
  const multiNo = `${HEAD}const out = execFileSync('docker',\n  ['ps'],\n  { encoding: 'utf8' });\n`;
  const parenOk = `${HEAD}execFileSync('docker', ['exec', 'x', ')', '({'], { encoding: 'utf8', timeout: 300_000 });\n`;
  const parenNo = `${HEAD}execFileSync('docker', ['exec', 'x', ')', '({'], { encoding: 'utf8' });\n`;

  for (const [name, text] of [['multi-ok.ts', multiOk], ['paren-ok.ts', parenOk]]) {
    const r = check({ [`services/a/test-int/${name}`]: text });
    assert.equal(r.status, 0, `${name}: ${show(r)}`);
    assert.equal(r.lines.at(-1), '통과: 시험 파일 1개, Docker 호출 1곳', name);
  }
  for (const [name, text] of [['multi-no.ts', multiNo], ['paren-no.ts', parenNo]]) {
    const r = check({ [`services/a/test-int/${name}`]: text });
    assert.equal(r.status, 1, `${name}: ${show(r)}`);
    assert.ok(blocked(r, `services/a/test-int/${name}`, 2), `${name}: ${show(r)}`);
  }
});

test('DT-05 시간 제한 값의 경계(1~300,000 정수 숫자만 통과)', () => {
  const pass = { '300_000': '300_000', '300000': '300000', '1': '1', '30_000': '30_000' };
  const passFiles = {};
  for (const [name, v] of Object.entries(pass)) {
    passFiles[`services/a/test-int/ok-${name}.ts`] = `${HEAD}execFileSync('docker', ['ps'], { encoding: 'utf8', timeout: ${v} });\n`;
  }
  const ok = check(passFiles);
  assert.equal(ok.status, 0, show(ok));
  assert.equal(ok.lines.at(-1), '통과: 시험 파일 4개, Docker 호출 4곳');

  const bad = {
    over: ['{ encoding: \'utf8\', timeout: 300_001 }', /300_?001/],
    zero: ['{ encoding: \'utf8\', timeout: 0 }', /timeout.*\b0\b|\b0\b.*timeout/],
    variable: ['{ encoding: \'utf8\', timeout: T }', /timeout/],
    shorthand: ['{ timeout }', /timeout/],
    expression: ['{ encoding: \'utf8\', timeout: 5 * 60_000 }', /timeout/],
    exponent: ['{ encoding: \'utf8\', timeout: 3e5 }', /timeout/],
  };
  const badFiles = {};
  for (const [name, [opts]] of Object.entries(bad)) {
    badFiles[`services/a/test-int/bad-${name}.ts`] = `${HEAD}const T = 1000;\nconst timeout = 1000;\nexecFileSync('docker', ['ps'], ${opts});\n`;
  }
  const r = check(badFiles);
  assert.equal(r.status, 1, show(r));
  for (const [name, [, want]] of Object.entries(bad)) {
    const l = blocked(r, `services/a/test-int/bad-${name}.ts`, 4);
    assert.ok(l, `${name}: ${show(r)}`);
    assert.match(l.slice(`막음: services/a/test-int/bad-${name}.ts:4 `.length), want, name);
  }
  assert.equal(r.lines.at(-1), '막음: 시험 파일 6개, Docker 호출 6곳, 문제 6건');

  // 함수로도: 통과 값은 ok, 막는 값은 ok가 아니다
  for (const v of Object.values(pass)) {
    const [c] = dockerCalls(`execFileSync('docker', [], { timeout: ${v} });`);
    assert.equal(c.ok, true, v);
    assert.equal(c.reason, null, v);
  }
  for (const [name, [opts]] of Object.entries(bad)) {
    const [c] = dockerCalls(`execFileSync('docker', [], ${opts});`);
    assert.equal(c.ok, false, name);
  }
});

test('DT-06 문제를 모두 찍는다(첫 문제에서 멈추지 않는다)', () => {
  const r = check({
    'services/a/test-int/one.ts': `${HEAD}execFileSync('docker', ['ps']);\nexecFileSync('docker', ['rm', '-f', 'x']);\n`,
    'services/b/test-int/two.ts': `${HEAD}\nspawnSync('docker', ['ps']);\n`,
  });
  assert.equal(r.status, 1, show(r));
  assert.ok(blocked(r, 'services/a/test-int/one.ts', 2), show(r));
  assert.ok(blocked(r, 'services/a/test-int/one.ts', 3), show(r));
  assert.ok(blocked(r, 'services/b/test-int/two.ts', 3), show(r));
  assert.equal(r.lines.filter((l) => /^막음: [^ ]+:\d+ /.test(l)).length, 3, show(r));
  assert.equal(r.lines.at(-1), '막음: 시험 파일 2개, Docker 호출 3곳, 문제 3건');
});

test('DT-07 보는 곳: apps·packages·services의 시험 폴더와 시험 이름 꼴', () => {
  const paths = [
    'apps/w/test-int/a.mjs',
    'packages/p/test-int/b.ts',
    'services/s/test-sim/c.ts',
    'services/s/test/d.ts',
    'services/s/src/e.int.test.ts',
    'services/s/src/f.spec.ts',
    'services/s/__tests__/g.ts',
    'apps/w/e2e/h.ts',
  ];
  const files = { [OK_FILE]: HEAD + OK_CALL };
  for (const p of paths) files[p] = `${HEAD}execFileSync('docker', ['ps'], { encoding: 'utf8' });\n`;
  const r = check(files);
  assert.equal(r.status, 1, show(r));
  for (const p of paths) {
    assert.ok(blocked(r, p, 2), `${p}: ${show(r)}`);
    assert.equal(inScope(p), true, p);
  }
  assert.equal(r.lines.at(-1), `막음: 시험 파일 ${paths.length + 1}개, Docker 호출 ${paths.length + 1}곳, 문제 ${paths.length}건`);
});

test('DT-08 보지 않는 곳: 제품 코드, 비슷한 폴더 이름, tools·loadtest·deploy, git이 추적하지 않는 파일, .md', () => {
  const outside = [
    'services/s/src/x.ts',
    'services/contest/a.ts',
    'services/s/test-intx/a.ts',
    'services/s/testing/a.ts',
    'loadtest/test/a.test.mjs',
    'tools/local/cluster.mjs',
    'deploy/a.test.mjs',
    'services/s/test-int/README.md',
  ];
  const bad = `${HEAD}execFileSync('docker', ['ps'], { encoding: 'utf8' });\n`;
  const files = { [OK_FILE]: HEAD + OK_CALL };
  for (const p of outside) files[p] = bad;
  const r = check(files, { untracked: { 'services/s/test-int/new.ts': bad } });
  assert.equal(r.status, 0, show(r));
  for (const p of [...outside, 'services/s/test-int/new.ts']) assert.equal(r.stdout.includes(p), false, `${p}: ${show(r)}`);
  assert.equal(r.lines.at(-1), '통과: 시험 파일 1개, Docker 호출 1곳');
  for (const p of outside) assert.equal(inScope(p), false, p);
});

test('DT-09 Docker가 아닌 명령은 보지 않는다', () => {
  const r = check({
    [OK_FILE]: HEAD + OK_CALL,
    'services/a/test-int/other.ts': `${HEAD}execFileSync('kubectl', ['get', 'pods']);\nexecFileSync('dockerd', ['--version']);\nexecFileSync('docker-compose', ['up']);\nexecFileSync('node', ['docker']);\n`,
  });
  assert.equal(r.status, 0, show(r));
  assert.match(r.lines.at(-1), /Docker 호출 1곳$/);
});

test('DT-10 Docker 호출을 하나도 찾지 못하면 막는다', () => {
  const noCalls = check({ 'services/a/test-int/plain.ts': "export const x = 1;\n" });
  assert.equal(noCalls.status, 1, show(noCalls));
  assert.ok(noCalls.lines.some((l) => l.includes('Docker 호출을 찾지 못했다')), show(noCalls));

  const noFiles = check({ 'services/a/src/main.ts': "export const x = 1;\n" });
  assert.equal(noFiles.status, 1, show(noFiles));
  assert.ok(noFiles.lines.some((l) => l.includes('Docker 호출을 찾지 못했다')), show(noFiles));
});

test('DT-11 GitHub Actions에서는 문제 줄이 ::error::로 시작한다', () => {
  const r = check(
    { 'services/a/test-int/pg.ts': `${HEAD}export const docker = (args: string[]) =>\n  execFileSync('docker', args, { encoding: 'utf8' });\n` },
    { github: true },
  );
  assert.equal(r.status, 1, show(r));
  assert.ok(r.lines.some((l) => l.startsWith('::error::services/a/test-int/pg.ts:3 ')), show(r));
});

test('DT-12 인자 오류와 저장소 오류는 2로 끝나고 표준 오류에 까닭을 찍는다', () => {
  const empty = tempDir('docker-timeouts-nogit-');
  const noGit = run(['--root', empty], { ceiling: dirname(empty) });
  assert.equal(noGit.status, 2, show(noGit));
  assert.notEqual(noGit.stderr.trim(), '', show(noGit));

  const dir = repo('docker-timeouts-');
  commit(dir, { [OK_FILE]: HEAD + OK_CALL }, 'test: 처음');
  const bogus = run(['--root', dir, '--bogus']);
  assert.equal(bogus.status, 2, show(bogus));
  assert.notEqual(bogus.stderr.trim(), '', show(bogus));
});

test('DT-13 실제 저장소의 시험 도우미가 모두 통과한다(Docker 호출 48곳 이상)', () => {
  const env = { ...process.env };
  delete env.GITHUB_ACTIONS;
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env, cwd: ROOT });
  assert.equal(r.status, 0, `끝 코드 ${r.status}\n${r.stdout}${r.stderr}`);
  const last = r.stdout.split(/\r?\n/).filter(Boolean).at(-1);
  const m = /^통과: 시험 파일 (\d+)개, Docker 호출 (\d+)곳$/.exec(last);
  assert.ok(m, last);
  // 2026-11-18 지금 수(계획 3의 목록 41개 파일 48곳). 도우미를 지워 줄면 이 수를 고친다
  assert.ok(Number(m[2]) >= 48, last);
});

test('DT-14 CI(tools-check 잡)가 점검을 돌린다', () => {
  const yml = readFileSync(join(ROOT, '.github', 'workflows', 'tools-check.yml'), 'utf8');
  const runs = yml.split(/\r?\n/).filter((l) => !l.trim().startsWith('#') && /^\s*(?:-\s+)?run:\s*node tools\/ci\/check-docker-timeouts\.mjs\s*$/.test(l));
  assert.equal(runs.length, 1, yml);
});
