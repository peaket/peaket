// 봇 저장소 비공개 검사(tools/ci/check-repo-visibility.mjs) 시험(docs/devops.md §4.4 '리뷰 뒤 더한 규칙' ②, ADR-0263 결정 13, POL-026, ADR-0169).
// 공개 저장소(GIT-0001)를 '받아들인 결과'로 두는 대신, 공개하면 안 되는 봇 시뮬레이터 저장소가 비공개인지는 따로 막는다. 실행: node --test "tools/ci/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './git-fixture.mjs';
import { repositoryVisibility } from './check-repo-visibility.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'check-repo-visibility.mjs');
const REAL = resolve(HERE, '..', '..', 'infra', 'stacks', 'global', 'github', 'repositories.tf');
const run = (text) => {
  const f = join(tempDir('repo-visibility-'), 'repositories.tf');
  if (text !== null) writeFileSync(f, text);
  const r = spawnSync(process.execPath, [SCRIPT, '--file', f], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
};

test('봇 저장소(peaket-bots)는 비공개여야 하고 public이거나 값을 못 읽으면 검사가 실패한다(리뷰 H2 재현)', () => {
  const real = readFileSync(REAL, 'utf8');
  assert.equal(repositoryVisibility(real, 'peaket-bots'), 'private');
  assert.equal(repositoryVisibility(real, 'peaket'), 'public');
  const ok = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  // 봇 저장소를 공개로 바꾸면 실패한다
  const pub = real.replace(/("peaket-bots"\s*=\s*\{[\s\S]*?visibility\s*=\s*)"private"/, '$1"public"');
  assert.notEqual(pub, real);
  const r = run(pub);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /peaket-bots.*public/);
  // 값을 글자로 적지 않았거나(변수), 칸이 없거나, 저장소가 없거나, 파일이 없으면 판정하지 못해 실패한다
  for (const [what, text] of [
    ['변수', real.replace(/("peaket-bots"\s*=\s*\{[\s\S]*?visibility\s*=\s*)"private"/, '$1var.bots_visibility')],
    ['칸 없음', real.replace(/("peaket-bots"\s*=\s*\{[\s\S]*?)\n\s*visibility\s*=\s*"private"/, '$1')],
    ['저장소 없음', real.replace(/"peaket-bots"/g, '"peaket-other"')],
    ['internal', real.replace(/("peaket-bots"\s*=\s*\{[\s\S]*?visibility\s*=\s*)"private"/, '$1"internal"')],
    ['파일 없음', null],
  ]) {
    const x = run(text);
    assert.equal(x.code, 1, `${what}: ${x.out}`);
  }
});

test('저장소 리소스의 visibility가 맵 값(each.value.visibility)을 그대로 쓰지 않으면(다른 값·조건식·없음) 검사가 실패한다(다시 보기 4)', () => {
  const real = readFileSync(REAL, 'utf8');
  assert.match(real, /resource "github_repository" "this" \{[\s\S]*?\n\s*visibility\s*=\s*each\.value\.visibility\s*\n/);
  const line = /(resource "github_repository" "this" \{[\s\S]*?\n\s*visibility\s*=\s*)each\.value\.visibility/;
  for (const [what, text] of [
    ['글자', real.replace(line, '$1"public"')],
    ['조건식', real.replace(line, '$1each.key == "peaket-bots" ? "public" : each.value.visibility')],
    ['다른 칸', real.replace(line, '$1each.value.description')],
    ['줄 없음', real.replace(/(resource "github_repository" "this" \{[\s\S]*?)\n\s*visibility\s*=\s*each\.value\.visibility/, '$1')],
    ['다른 리소스', `${real}\nresource "github_repository" "extra" {\n  name       = "x"\n  visibility = "public"\n}\n`],
  ]) {
    assert.notEqual(text, real, what);
    const r = run(text);
    assert.equal(r.code, 1, `${what}: ${r.out}`);
    assert.match(r.out, /visibility/, what);
  }
});
