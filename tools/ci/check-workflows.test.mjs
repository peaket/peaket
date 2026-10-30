// check-workflows.mjs를 임시 워크플로 파일로 돌려 보는 시험. 실행: node --test "tools/ci/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './git-fixture.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-workflows.mjs');
const SHA = 'a'.repeat(40);
const GOOD = `name: ci
on:
  pull_request:
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      # uses: actions/checkout@v7 주석은 보지 않는다
      - uses: actions/checkout@${SHA} # v7.0.1
        with:
          persist-credentials: false
      - run: node tools/ci/changes.mjs
        env:
          HEAD_SHA: \${{ github.event.pull_request.head.sha }}
  docs:
    uses: ./.github/workflows/docs-check.yml
`;

function run(text, name = 'ci.yml') {
  const dir = tempDir('check-workflows-');
  const file = join(dir, name);
  writeFileSync(file, text);
  const r = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('규칙을 지킨 워크플로는 통과한다', () => {
  const r = run(GOOD);
  assert.equal(r.code, 0, r.out);
});

test('CRLF 줄바꿈도 같은 결과다', () => {
  assert.equal(run(GOOD.replace(/\n/g, '\r\n')).code, 0);
});

test('태그·가지·짧은 SHA로 부른 액션은 실패한다', () => {
  for (const ref of ['actions/checkout@v7', 'actions/checkout@main', 'actions/checkout@3d3c42e']) {
    const r = run(GOOD.replace(`actions/checkout@${SHA}`, ref));
    assert.equal(r.code, 1, ref);
    assert.match(r.out, /고정하지 않았다/);
  }
});

test('하위 경로 액션과 다이제스트 고정 컨테이너는 통과하고, 태그 컨테이너는 실패한다', () => {
  assert.equal(run(GOOD.replace('- run: node tools/ci/changes.mjs', `- uses: github/codeql-action/init@${SHA}\n      - run: node tools/ci/changes.mjs`)).code, 0);
  assert.equal(run(GOOD.replace('- run: node tools/ci/changes.mjs', `- uses: docker://alpine@sha256:${'b'.repeat(64)}\n      - run: node tools/ci/changes.mjs`)).code, 0);
  assert.equal(run(GOOD.replace('- run: node tools/ci/changes.mjs', '- uses: "docker://alpine:3"\n      - run: node tools/ci/changes.mjs')).code, 1);
});

test('pull_request_target은 실패한다', () => {
  const r = run(GOOD.replace('  pull_request:', '  pull_request_target:'));
  assert.equal(r.code, 1);
  assert.match(r.out, /pull_request_target/);
});

test('맨 위 permissions:가 없으면 실패한다(잡 안의 permissions:는 대신하지 못한다)', () => {
  const r = run(GOOD.replace('permissions:\n  contents: read\n', '').replace('    timeout-minutes: 10', '    timeout-minutes: 10\n    permissions:\n      contents: read'));
  assert.equal(r.code, 1);
  assert.match(r.out, /맨 위에 permissions:가 없다/);
});

test('사용자가 고칠 수 있는 값을 식에 쓰면 실패한다', () => {
  for (const expr of ['github.event.pull_request.title', 'github.event.pull_request.body', 'github.head_ref', 'github.event.pull_request.head.ref', 'github.event.head_commit.message', 'github.event.issue.title', 'github.event.comment.body', 'github.event.commits[0].author.email', 'github.event.pusher.name', 'github.event.ref', "github.event.pull_request['title']", 'github.event.pull_request.head.repo.full_name']) {
    const r = run(GOOD.replace('github.event.pull_request.head.sha', expr));
    assert.equal(r.code, 1, expr);
    assert.match(r.out, /사용자가 고칠 수 있는 값/);
  }
});

test('SHA·번호와 github.ref는 식에 써도 된다', () => {
  // github.event_name은 사건 종류(push·schedule 등)라 사용자가 고칠 수 없다(release.yml에서 찾은 오탐, add-release-workflows)
  for (const expr of ['github.event.pull_request.base.sha', 'github.event.pull_request.number', 'github.event.before', 'github.ref', 'github.sha', 'toJSON(needs)', "github.event_name == 'schedule'"]) {
    assert.equal(run(GOOD.replace('github.event.pull_request.head.sha', expr)).code, 0, expr);
  }
});

test('persist-credentials: false 없는 체크아웃은 실패한다', () => {
  const r = run(GOOD.replace('          persist-credentials: false\n', '          fetch-depth: 0\n'));
  assert.equal(r.code, 1);
  assert.match(r.out, /actions\/checkout에 persist-credentials: false가 없다/);
});

test('persist-credentials는 체크아웃마다 본다', () => {
  assert.equal(run(GOOD.replace('persist-credentials: false', "persist-credentials: 'false'")).code, 0);
  // 첫 체크아웃에서 빼고, 둘째 체크아웃에만 둔다. 개수로 세면 1 대 1로 맞아 놓친다
  const other = GOOD.replace('          persist-credentials: false\n', '          fetch-depth: 0\n').replace(
    '- run: node tools/ci/changes.mjs',
    `- uses: actions/checkout@${SHA}\n        with:\n          persist-credentials: false\n      - run: node tools/ci/changes.mjs`,
  );
  const r = run(other);
  assert.equal(r.code, 1);
  assert.match(r.out, /ci\.yml:12: actions\/checkout에 persist-credentials: false가 없다/);
});

test('줄 끝 주석이 붙은 잡 이름도 잡으로 본다', () => {
  const r = run(GOOD.replace('  docs:\n    uses: ./.github/workflows/docs-check.yml\n', '  lint: # 빠른 검사\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo lint\n'));
  assert.equal(r.code, 1);
  assert.match(r.out, /잡 lint에 timeout-minutes가 없다/);
});

test('timeout-minutes 없는 잡은 실패하고, 재사용 워크플로를 부르는 잡은 예외다', () => {
  const r = run(GOOD.replace('    timeout-minutes: 10\n', ''));
  assert.equal(r.code, 1);
  assert.match(r.out, /잡 build에 timeout-minutes가 없다/);
  assert.doesNotMatch(r.out, /잡 docs/);
});

test('줄 번호와 파일 이름을 함께 낸다', () => {
  const r = run(GOOD.replace(`actions/checkout@${SHA}`, 'actions/checkout@v7'), 'x.yml');
  assert.match(r.out, /x\.yml:12: uses: actions\/checkout@v7/);
});
