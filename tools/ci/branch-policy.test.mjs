// branch-policy.mjs를 사건 파일과 함께 바깥에서 돌려 보는 시험(D-T41). 실행: node --test "tools/ci/*.test.mjs"
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repo, commit, git } from './git-fixture.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'branch-policy.mjs');
const OLD = '2020-01-01T00:00:00Z';
let dir;
const sha = {};

// 기준 하나에 머리 넷: 문서만, 워크플로만, 워크플로와 다른 경로, 오래된 작업 가지
before(() => {
  dir = repo('branch-policy-');
  sha.base = commit(dir, { 'README.md': '처음\n', '.github/workflows/old.yml': 'name: old\n' }, 'base');
  for (const [name, files, date] of [
    ['docs', { 'docs/a.md': '글\n' }],
    ['wf', { '.github/workflows/ci.yml': 'name: ci\n' }],
    ['mixed', { '.github/workflows/ci.yml': 'name: ci\n', 'tools/ci/x.mjs': '\n' }],
    ['old', { 'docs/b.md': '글\n' }, OLD],
  ]) {
    git(dir, 'switch', '-q', '--detach', sha.base);
    sha[name] = commit(dir, files, name, date);
  }
  git(dir, 'switch', '-q', '--detach', sha.base);
  git(dir, 'mv', '.github/workflows/old.yml', 'old.yml');
  sha.moved = commit(dir, {}, 'moved');
});

function run({ head = 'feature/2.5.4-auto-assign', base = 'develop', title = 'feat(queue): 자동 배정', body = '', commit: c = 'docs', event } = {}) {
  const file = join(dir, `event-${Math.random().toString(36).slice(2)}.json`);
  const pr = { title, body, head: { ref: head, sha: sha[c] }, base: { ref: base, sha: sha.base } };
  writeFileSync(file, JSON.stringify(event ?? { pull_request: pr }));
  const env = { ...process.env, GITHUB_EVENT_PATH: file };
  delete env.GITHUB_ACTIONS;
  const r = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8', env });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('허용 쌍은 통과한다', () => {
  for (const [head, base] of [
    ['feature/1-a', 'develop'], ['bugfix/1-a', 'develop'], ['renovate/node-24.x', 'develop'],
    ['promote/demo-1', 'develop'], ['calendar/2026-10-30', 'develop'],
    ['bugfix/1-a', 'release/1.5.0'], ['bugfix/1-a', 'hotfix/1.5.1'],
    ['release/1.5.0', 'main'], ['release/1.5.0', 'develop'],
    ['hotfix/1.5.1', 'main'], ['hotfix/1.5.1', 'develop'], ['hotfix/1.5.1', 'release/1.6.0'],
    ['merge/main-to-develop', 'develop'], ['merge/main-to-release', 'release/1.6.0'],
  ]) {
    const r = run({ head, base });
    assert.equal(r.code, 0, `${head} → ${base}: ${r.out}`);
  }
});

test('허용 밖 쌍은 실패한다', () => {
  for (const [head, base] of [
    ['feature/1-a', 'main'], ['feature/1-a', 'release/1.5.0'], ['release/1.5.0', 'release/1.6.0'],
    ['promote/demo-1', 'main'], ['wip', 'develop'], ['merge/x', 'main'], ['develop', 'main'],
  ]) {
    const r = run({ head, base });
    assert.equal(r.code, 1, `${head} → ${base}`);
    assert.match(r.out, /허용 목록\(§2\.2\.6\)에 없다/);
  }
});

test('D-T41 ① 형식이 틀린 제목은 실패한다', () => {
  const r = run({ title: 'Add login' });
  assert.equal(r.code, 1);
  assert.match(r.out, /형식이 아니다/);
});

test('D-T41 ② 허용 밖 종류는 실패한다', () => {
  const r = run({ title: 'wip: queue' });
  assert.equal(r.code, 1);
  assert.match(r.out, /종류 'wip'/);
});

test('D-T41 ③ 본문에 BREAKING CHANGE가 있는데 제목에 !가 없으면 실패한다', () => {
  const r = run({ title: 'feat(queue): 대기열 응답 바꿈', body: '설명\n\nBREAKING CHANGE: 응답 칸 이름이 바뀐다\n' });
  assert.equal(r.code, 1);
  assert.match(r.out, /!를 붙인다/);
});

test('D-T41 ④ 제목에 !가 있으면 통과한다', () => {
  assert.equal(run({ title: 'feat(queue)!: 대기열 응답 바꿈', body: 'BREAKING CHANGE: 응답 칸 이름이 바뀐다\n' }).code, 0);
});

test('D-T41 ⑤ 제목을 고쳐 다시 돌면 통과한다', () => {
  assert.equal(run({ title: 'Add login' }).code, 1);
  assert.equal(run({ title: 'fix: 로그인 오류' }).code, 0);
});

test('본문 중간의 BREAKING CHANGE 글자는 꼬리말이 아니다', () => {
  assert.equal(run({ title: 'docs: 안내', body: '이 PR은 BREAKING CHANGE: 가 아니다' }).code, 0);
});

test('빈 범위·설명 없는 제목은 실패한다', () => {
  assert.equal(run({ title: 'feat(): 무엇' }).code, 1);
  assert.equal(run({ title: 'feat: ' }).code, 1);
});

test('빌드 절차만 바꾼 PR은 통과한다', () => {
  assert.equal(run({ title: 'ci: 검사 추가', commit: 'wf' }).code, 0);
});

test('빌드 절차와 다른 경로를 함께 바꾸면 실패한다', () => {
  const r = run({ title: 'ci: 검사 추가', commit: 'mixed' });
  assert.equal(r.code, 1);
  assert.match(r.out, /다른 경로가 섞였다.*tools\/ci\/x\.mjs/);
});

test('워크플로를 빌드 절차 밖으로 옮기면 두 경로를 함께 바꾼 것으로 보고 실패한다', () => {
  const r = run({ title: 'ci: 옮김', commit: 'moved' });
  assert.equal(r.code, 1);
  assert.match(r.out, /다른 경로가 섞였다\(ADR-0169\): old\.yml/);
});

test('사건 파일의 머리 커밋을 읽지 못하면 실패한다', () => {
  const r = run({ event: { pull_request: { title: 'fix: x', body: '', head: { ref: 'feature/1-a', sha: 'f'.repeat(40) }, base: { ref: 'develop', sha: sha.base } } } });
  assert.equal(r.code, 1);
  assert.match(r.out, /바뀐 파일을 읽지 못했다/);
});

test('PR 사건이 아니면 2로 끝난다', () => {
  assert.equal(run({ event: { push: {} } }).code, 2);
});

test('3일을 넘긴 작업 가지는 경고만 한다', () => {
  const r = run({ commit: 'old' });
  assert.equal(r.code, 0);
  assert.match(r.out, /경고: 작업 가지가 \d+일째다/);
  assert.doesNotMatch(run({ commit: 'docs' }).out, /경고/);
});

test('GitHub Actions에서는 주석 형식으로 낸다', () => {
  const file = join(dir, 'event-gh.json');
  writeFileSync(file, JSON.stringify({ pull_request: { title: 'Add login', body: '', head: { ref: 'feature/1-a', sha: sha.docs }, base: { ref: 'develop', sha: sha.base } } }));
  const r = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_PATH: file, GITHUB_ACTIONS: 'true' } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^::error::PR 제목/m);
});
