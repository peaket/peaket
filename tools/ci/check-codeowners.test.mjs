// check-codeowners.mjs를 바깥에서 돌려 보는 시험. 실행: node --test "tools/ci/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './git-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'check-codeowners.mjs');
const repoRoot = join(here, '..', '..');

const teams = JSON.stringify({ teams: [{ slug: 'platform' }, { slug: 'architecture' }] });

function run(codeowners) {
  const dir = tempDir('codeowners-');
  writeFileSync(join(dir, 'CODEOWNERS'), codeowners);
  writeFileSync(join(dir, 'teams.json'), teams);
  return spawnSync(process.execPath, [script, '--codeowners', join(dir, 'CODEOWNERS'), '--teams', join(dir, 'teams.json')], {
    encoding: 'utf8',
  });
}

test('저장소의 CODEOWNERS는 통과한다', () => {
  const r = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('맞는 파일은 통과한다', () => {
  const r = run('# 주석\n*  @peaket/architecture\n/infra/  @peaket/platform  # 줄 끝 주석\n');
  assert.equal(r.status, 0, r.stderr);
});

test('목록에 없는 팀은 실패한다', () => {
  const r = run('* @peaket/architecture\n/apps/ @peaket/frontend\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /팀 'frontend'/);
});

test('주인이 없는 줄은 실패한다', () => {
  const r = run('* @peaket/architecture\n/apps/\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /주인이 없다/);
});

test('첫 규칙 줄이 *가 아니면 실패한다', () => {
  const r = run('/infra/ @peaket/platform\n* @peaket/architecture\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /첫 규칙 줄/);
});

test('조직이 섞이면 실패한다', () => {
  const r = run('* @peaket/architecture\n/infra/ @other/platform\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /조직 이름이 여럿/);
});

test('같은 경로가 두 번 나오면 실패한다', () => {
  const r = run('* @peaket/architecture\n/infra/ @peaket/platform\n/infra/ @peaket/architecture\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /경로 '\/infra\/'/);
});

test('사람 계정 표기는 실패한다', () => {
  const r = run('* @someone\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /팀 표기/);
});

// 코드 리뷰 반영(2026-10-30): 뜻이 같은 경로를 다른 꼴로 적어도 중복이다
test('뜻이 같은 경로(/x, /x/, /x/**)를 중복으로 잡는다', () => {
  const r = run('* @peaket/architecture\n/infra/ @peaket/platform\n/infra @peaket/architecture\n/infra/** @peaket/platform\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\/infra'가 2줄/);
  assert.match(r.stderr, /\/infra\/\*\*'가 2줄/);
});

test('앞 슬래시가 다른 경로는 뜻이 달라 중복이 아니다', () => {
  const r = run('* @peaket/architecture\n/infra/ @peaket/platform\ninfra/ @peaket/architecture\n');
  assert.equal(r.status, 0, r.stderr);
});
