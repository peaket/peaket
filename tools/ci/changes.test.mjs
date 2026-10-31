// changes.mjs를 바깥에서 돌려 보는 시험(D-T47). 실행: node --test "tools/ci/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repo, commit, git } from './git-fixture.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'changes.mjs');

// 기준 커밋을 만들고, 가지를 따서 files를 바꾼 뒤 범위를 읽는다. prep은 커밋 전에 저장소를 더 바꾼다
function scopes(files, baseArg, prep) {
  const dir = repo('changes-');
  const base = commit(dir, { 'README.md': '처음\n', 'infra/a.tf': '\n', 'packages/platform/x.ts': '\n' }, 'base');
  git(dir, 'switch', '-q', '-c', 'feature/x');
  prep?.(dir);
  commit(dir, files);
  const env = { ...process.env };
  delete env.GITHUB_OUTPUT;
  const r = spawnSync(process.execPath, [script, '--base', baseArg ?? base], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  return Object.keys(out.scopes).filter((k) => out.scopes[k]);
}

test('D-T47 ① 문서만 바꾸면 docs만 고른다', () => {
  assert.deepEqual(scopes({ 'docs/a.md': '글\n' }), ['docs']);
});

test('D-T47 ② packages/platform을 바꾸면 화면·서비스 전부(js_all)를 고른다', () => {
  assert.deepEqual(scopes({ 'packages/platform/x.ts': '바꿈\n' }), ['js', 'js_all']);
});

test('D-T47 ③ infra/만 바꾸면 infra만 고른다', () => {
  assert.deepEqual(scopes({ 'infra/a.tf': '# 바꿈\n' }), ['infra']);
});

test('D-T47 ④ 비교 기준을 읽지 못하면 전체를 고른다', () => {
  const s = scopes({ 'docs/a.md': '글\n' }, 'no-such-ref');
  assert.ok(s.includes('docs') && s.includes('js_all') && s.includes('infra') && s.includes('ci'));
});

test('새 가지의 첫 푸시(기준이 0만)는 전체를 고른다', () => {
  assert.ok(scopes({ 'docs/a.md': '글\n' }, '0000000000000000000000000000000000000000').includes('js_all'));
});

test('ci.yml을 바꾸면 전체를 고른다', () => {
  assert.ok(scopes({ '.github/workflows/ci.yml': 'name: ci\n' }).includes('js_all'));
});

test('계약 원본을 바꾸면 계약·문서와 화면·서비스 전부를 고른다', () => {
  assert.deepEqual(scopes({ 'docs/api/openapi.yaml': 'openapi: 3.1.0\n' }), ['docs', 'contracts', 'js', 'js_all']);
});

test('배포 상태·부하 시험·도구·워크플로 밖 .github은 각 범위로 간다', () => {
  assert.deepEqual(scopes({ 'deploy/x.yaml': '\n', 'loadtest/k1.js': '\n', 'tools/ci/x.mjs': '\n', '.github/CODEOWNERS': '*\n' }), ['docs', 'deploy', 'loadtest', 'tools', 'ci']);
});

test('파일을 옮기면 옛 경로의 범위와, 링크가 깨질 수 있어 docs도 고른다', () => {
  const s = scopes({}, undefined, (dir) => git(dir, 'mv', 'packages/platform/x.ts', 'infra/x.ts'));
  assert.deepEqual(s, ['docs', 'js', 'js_all', 'infra']);
});

test('문서 점검이 읽는 파일(.md·.yaml·.json·.csv)은 어디에 있든 docs를 고른다', () => {
  assert.deepEqual(scopes({ 'infra/stacks/global/github/teams.json': '[]\n' }), ['docs', 'infra']);
  assert.deepEqual(scopes({ 'tools/doc-check/check_all.py': '\n' }), ['docs', 'tools']);
  assert.deepEqual(scopes({ 'tools/ci/README.md': '글\n' }), ['tools']);
});

test('파일을 지우면 문서 링크가 깨질 수 있어 docs도 고른다', () => {
  assert.deepEqual(scopes({}, undefined, (dir) => git(dir, 'rm', '-q', 'infra/a.tf')), ['docs', 'infra']);
});

test('GITHUB_OUTPUT이 있으면 범위마다 한 줄씩 쓴다', () => {
  const dir = repo('changes-out-');
  const base = commit(dir, { 'README.md': '처음\n' }, 'base');
  commit(dir, { 'data/m.sql': 'select 1\n' });
  const out = join(dir, 'gh-output.txt');
  const r = spawnSync(process.execPath, [script, '--base', base], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out } });
  assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(out, 'utf8');
  assert.match(text, /^data=true$/m);
  assert.match(text, /^docs=false$/m);
});

test('DT38_서비스와_계약깨짐검사도구를바꾸면_contracts를고른다', () => {
  // 서비스가 openapi:emit을 갖추는 PR에서 계약 잡(서비스 OpenAPI 차이의 자리)이 돌아야 한다(openspec 변경 add-contract-breaking-check)
  assert.deepEqual(scopes({ 'services/queue-svc/src/main.ts': 'x\n' }), ['contracts', 'js']);
  assert.deepEqual(scopes({ 'tools/ci/contract-breaking.mjs': 'x\n' }), ['contracts', 'tools']);
  assert.deepEqual(scopes({ 'tools/ci/release-tags.mjs': 'x\n' }), ['contracts', 'tools']);
  assert.deepEqual(scopes({ '.github/workflows/contract-check.yml': 'x\n' }), ['contracts', 'ci']);
});
