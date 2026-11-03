// check-merge-tree.mjs를 임시 저장소에서 돌려 보는 시험(D-T22). 실행: node --test "tools/ci/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repo, commit, git } from './git-fixture.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-merge-tree.mjs');
const run = (dir, ...args) => {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
};

// main에서 release/1.5.0을 따고 후보 커밋을 만든다. mainChange가 있으면 그 뒤 main에 커밋한다
function setup(mainChange, releaseChange = { 'b.txt': '출시\n' }) {
  const dir = repo('merge-tree-');
  commit(dir, { 'a.txt': '하나\n둘\n' }, 'base');
  git(dir, 'switch', '-q', '-c', 'release/1.5.0');
  const candidate = commit(dir, releaseChange, 'release');
  git(dir, 'switch', '-q', 'main');
  if (mainChange) commit(dir, mainChange, 'hotfix');
  return { dir, candidate };
}

test('후보가 대상을 모두 담으면 통과한다', () => {
  const { dir, candidate } = setup();
  const r = run(dir, '--target', 'main', '--candidate', candidate);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /통과/);
});

test('D-T22 대상에만 있는 핫픽스가 있으면 실패한다', () => {
  const { dir, candidate } = setup({ 'c.txt': '핫픽스\n' });
  const r = run(dir, '--target', 'main', '--candidate', candidate);
  assert.equal(r.code, 1);
  assert.match(r.out, /대상에만 있는 변경: c\.txt/);
});

test('대상을 후보에 병합한 새 후보는 통과한다', () => {
  const { dir } = setup({ 'c.txt': '핫픽스\n' });
  git(dir, 'switch', '-q', 'release/1.5.0');
  git(dir, 'merge', '-q', '--no-ff', '--no-edit', 'main');
  const r = run(dir, '--target', 'main', '--candidate', 'HEAD');
  assert.equal(r.code, 0, r.out);
});

test('충돌하면 실패한다', () => {
  const { dir, candidate } = setup({ 'a.txt': '하나\n핫픽스\n' }, { 'a.txt': '하나\n출시\n' });
  const r = run(dir, '--target', 'main', '--candidate', candidate);
  assert.equal(r.code, 1);
  assert.match(r.out, /충돌한다: a\.txt/);
});

test('없는 커밋이나 인자 누락은 2로 끝난다', () => {
  const { dir } = setup();
  assert.equal(run(dir, '--target', 'main', '--candidate', 'no-such-ref').code, 2);
  assert.equal(run(dir, '--target', 'main').code, 2);
});
