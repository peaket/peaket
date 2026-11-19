// check-workflows.mjs를 임시 워크플로 파일로 돌려 보는 시험. 실행: node --test "tools/ci/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './git-fixture.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-workflows.mjs');
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// 실제 build-image.yml·ci.yml을 읽는 데 쓴다. 로컬에서 pnpm install 전이면 없다(그 시험만 건너뛴다). CI의 tools-check는 설치한 뒤 돈다(맨 아래 시험)
const YAML = await import('yaml').catch(() => null);
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

/** GOOD가 부르는 재사용 워크플로의 자리 채움(규칙 10이 부른 워크플로의 잡 권한을 읽는다) */
const CALLED_STUB = `name: docs-check
on:
  workflow_call:
permissions:
  contents: read
jobs:
  docs:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - run: echo ok
`;

function run(text, name = 'ci.yml', { allowlist, called = {} } = {}) {
  const dir = tempDir('check-workflows-');
  const wf = join(dir, '.github', 'workflows');
  mkdirSync(wf, { recursive: true });
  for (const [n, t] of Object.entries({ 'docs-check.yml': CALLED_STUB, ...called })) writeFileSync(join(wf, n), t);
  const file = join(wf, name);
  writeFileSync(file, text);
  const extra = [];
  if (allowlist !== undefined) {
    const tf = join(dir, 'variables.tf');
    if (allowlist !== null) writeFileSync(tf, allowlist);
    extra.push('--allowlist', tf);
  }
  const r = spawnSync(process.execPath, [script, ...extra, file], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('규칙을 지킨 워크플로는 통과한다', () => {
  const r = run(GOOD);
  assert.equal(r.code, 0, r.out);
});

test('CRLF 줄바꿈도 같은 결과다', () => {
  assert.equal(run(GOOD.replace(/\n/g, '\r\n')).code, 0);
});

test('D-T12 ① 태그·가지·짧은 SHA로 부른 액션은 실패한다', () => {
  for (const ref of ['actions/checkout@v7', 'actions/checkout@main', 'actions/checkout@3d3c42e']) {
    const r = run(GOOD.replace(`actions/checkout@${SHA}`, ref));
    assert.equal(r.code, 1, ref);
    assert.match(r.out, /고정하지 않았다/);
  }
  // 허용 목록에 든 서드파티 액션도 태그로 부르면 실패한다(허용 목록은 판을 묶지 않는다)
  const tf = allowlistTf(['ossf/scorecard-action@*']);
  for (const ref of ['ossf/scorecard-action@v2.5.0', 'ossf/scorecard-action@main', `ossf/scorecard-action@${'f'.repeat(39)}`]) {
    const r = run(withCiStep(`- uses: ${ref}`), 'ci.yml', { allowlist: tf });
    assert.equal(r.code, 1, ref);
    assert.match(r.out, /고정하지 않았다/);
  }
  assert.equal(run(withCiStep(`- uses: ossf/scorecard-action@${SHA} # v2.5.0`), 'ci.yml', { allowlist: tf }).code, 0);
});

/** 조직 허용 목록 스택의 variables.tf(actions_patterns_allowed 기본값) */
const allowlistTf = (patterns, { multiline = false } = {}) => `variable "owner_login" {
  type = string
}

variable "actions_patterns_allowed" {
  description = "허용할 제3자 액션 패턴. 판은 조직 정책의 SHA 고정 요구가 따로 막는다"
  type        = list(string)
  default     = [${multiline ? `\n    ${patterns.map((p) => `"${p}", # 까닭`).join('\n    ')}\n  ` : patterns.map((p) => `"${p}"`).join(', ')}]
}
`;
const withCiStep = (step) => GOOD.replace('      - run: node tools/ci/changes.mjs', `      ${step}\n      - run: node tools/ci/changes.mjs`);

test('D-T12 ① GitHub 소유(actions/·github/)가 아닌데 actions_patterns_allowed에 없는 액션은 실패하고, 목록의 꼴(소유자/저장소@*)에 맞으면 통과한다(github-x/ 같은 이름은 GitHub 소유가 아니다)', () => {
  const tf = allowlistTf(['hashicorp/setup-terraform@*', 'ossf/scorecard-action@*', 'example-org/*']);
  const ok = [`actions/setup-node@${SHA}`, `github/codeql-action/init@${SHA}`, `GitHub/codeql-action/analyze@${SHA}`, `hashicorp/setup-terraform@${SHA}`, `ossf/scorecard-action@${SHA}`, `example-org/any-action@${SHA}`];
  for (const ref of ok) {
    const r = run(withCiStep(`- uses: ${ref}`), 'ci.yml', { allowlist: tf });
    assert.equal(r.code, 0, `${ref}: ${r.out}`);
  }
  const blocked = [
    `docker/login-action@${SHA}`,
    `github-x/tool@${SHA}`,
    `githubactions/tool@${SHA}`,
    `actions-x/checkout@${SHA}`,
    `hashicorp/other-action@${SHA}`,
    `ossf/scorecard-action-fork@${SHA}`,
    `other-org/repo/.github/workflows/reuse.yml@${SHA}`,
  ];
  for (const ref of blocked) {
    const r = run(withCiStep(`- uses: ${ref}`), 'ci.yml', { allowlist: tf });
    assert.equal(r.code, 1, ref);
    assert.match(r.out, /actions_patterns_allowed/, ref);
    assert.match(r.out, /ci\.yml:\d+:/, '줄 번호를 낸다');
  }
  // 여러 줄 목록(줄 끝 주석 포함)도 읽는다
  assert.equal(run(withCiStep(`- uses: ossf/scorecard-action@${SHA}`), 'ci.yml', { allowlist: allowlistTf(['ossf/scorecard-action@*'], { multiline: true }) }).code, 0);
  // 같은 저장소 경로(./)와 다이제스트 고정 컨테이너는 허용 목록과 상관없다
  assert.equal(run(withCiStep('- uses: ./.github/actions/local'), 'ci.yml', { allowlist: allowlistTf([]) }).code, 0);
  assert.equal(run(withCiStep(`- uses: docker://alpine@sha256:${'b'.repeat(64)}`), 'ci.yml', { allowlist: allowlistTf([]) }).code, 0);
});

test('D-T12 ① variables.tf를 읽지 못하거나 기본값 목록이 없으면 실패한다', () => {
  // GitHub 소유 액션만 쓰는 워크플로라도 허용 목록을 읽지 못하면 통과로 보지 않는다
  const cases = [
    ['파일 없음', null],
    ['변수 없음', 'variable "owner_login" {\n  type = string\n}\n'],
    ['기본값 없음', 'variable "actions_patterns_allowed" {\n  type = list(string)\n}\n'],
    ['목록 아님', 'variable "actions_patterns_allowed" {\n  type    = list(string)\n  default = "ossf/scorecard-action@*"\n}\n'],
    ['글자 아닌 항목', 'variable "actions_patterns_allowed" {\n  type    = list(string)\n  default = [var.extra]\n}\n'],
    ['닫히지 않음', 'variable "actions_patterns_allowed" {\n  default = ["a/b@*"\n'],
  ];
  for (const [what, tf] of cases) {
    const r = run(GOOD, 'ci.yml', { allowlist: tf });
    assert.equal(r.code, 1, `${what}: ${r.out}`);
    assert.match(r.out, /허용 목록/, what);
  }
  // 빈 목록은 읽힌다(GitHub 소유 액션만 쓰면 통과)
  assert.equal(run(GOOD, 'ci.yml', { allowlist: allowlistTf([]) }).code, 0);
});

test('D-T12 ① 실제 저장소 워크플로가 실제 조직 허용 목록(infra/stacks/global/github/variables.tf)으로 검사를 통과하고, 거기서 Scorecard 액션을 빼면 scorecard.yml이 실패한다', () => {
  const all = spawnSync(process.execPath, [script], { encoding: 'utf8', cwd: REPO });
  assert.equal(all.status, 0, all.stdout + all.stderr);
  const real = readFileSync(join(REPO, 'infra', 'stacks', 'global', 'github', 'variables.tf'), 'utf8');
  assert.match(real, /"ossf\/scorecard-action@\*"/);
  const dir = tempDir('check-workflows-real-');
  const tf = join(dir, 'variables.tf');
  writeFileSync(tf, real.replace(/\s*"ossf\/scorecard-action@\*",?/, ''));
  const r = spawnSync(process.execPath, [script, '--allowlist', tf, join(REPO, '.github', 'workflows', 'scorecard.yml')], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /scorecard\.yml.*ossf\/scorecard-action/);
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

// --- 규칙 8(D-T49, FND-160): `branch-watch.mjs count` 단계는 continue-on-error: true와 timeout-minutes를 둔다 ---
// 경고만 하는 점검이 넘어지거나 API가 느려도 필수 검사(branch-policy)를 막지 않게 한다

const COUNT_STEP = `      # 작업 가지 수 경고
      - run: node tools/ci/branch-watch.mjs count
        continue-on-error: true
        timeout-minutes: 2
        env:
          GITHUB_TOKEN: \${{ github.token }}
`;
/** GOOD의 잡 build 끝(잡 docs 앞)에 단계를 넣는다 */
const withCountStep = (step = COUNT_STEP) => GOOD.replace('  docs:\n', `${step}  docs:\n`);

test('FND160_DT49_규칙8 branch-watch count 단계에 continue-on-error: true와 timeout-minutes가 있으면 통과한다', () => {
  const r = run(withCountStep());
  assert.equal(r.code, 0, r.out);
  assert.equal(run(withCountStep().replace(/\n/g, '\r\n')).code, 0, 'CRLF');
  // 단계 안 키의 차례는 뜻이 없다(name이 먼저, run이 맨 뒤)
  const nameFirst = run(
    withCountStep('      - name: 작업 가지 수 경고\n        continue-on-error: true\n        timeout-minutes: 2\n        run: node tools/ci/branch-watch.mjs count\n'),
  );
  assert.equal(nameFirst.code, 0, nameFirst.out);
});

test('FND160_DT49_규칙8 branch-watch count 단계에 continue-on-error: true가 없으면 실패한다', () => {
  for (const [what, step] of [
    ['continue-on-error 없음', COUNT_STEP.replace('        continue-on-error: true\n', '')],
    ['continue-on-error: false', COUNT_STEP.replace('continue-on-error: true', 'continue-on-error: false')],
    ['run 블록 안에서 부름', '      - name: 작업 가지 수 경고\n        run: |\n          node tools/ci/branch-watch.mjs count\n        timeout-minutes: 2\n'],
  ]) {
    const r = run(withCountStep(step));
    assert.equal(r.code, 1, `${what}: ${r.out}`);
    assert.match(r.out, /continue-on-error/, what);
  }
});

test('FND160_DT49_규칙8 branch-watch count 단계에 timeout-minutes가 없으면 실패한다(잡의 timeout-minutes는 대신하지 못한다)', () => {
  // GOOD의 잡 build에는 timeout-minutes: 10이 있다
  const r = run(withCountStep(COUNT_STEP.replace('        timeout-minutes: 2\n', '')));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /timeout-minutes/);
  assert.doesNotMatch(r.out, /잡 build에 timeout-minutes가 없다/);
});

test('FND160_DT49_규칙8은 branch-watch count를 부르지 않는 단계의 run에는 걸리지 않는다', () => {
  for (const [what, text] of [
    ['weekly 단계', withCountStep('      - run: node tools/ci/branch-watch.mjs weekly\n')],
    ['count 단계 뒤의 다른 단계', withCountStep(`${COUNT_STEP}      - run: echo 끝\n`)],
    ['count 단계 앞의 다른 단계', withCountStep(`      - run: node tools/ci/branch-policy.mjs\n${COUNT_STEP}`)],
    ['주석 속 명령', withCountStep('      # node tools/ci/branch-watch.mjs count는 다른 워크플로가 부른다\n      - run: echo 다른 점검\n')],
  ]) {
    const r = run(text);
    assert.equal(r.code, 0, `${what}: ${r.out}`);
  }
});

const KEYS = '        continue-on-error: true\n        timeout-minutes: 2\n';

test('FND160_DT49_규칙8은 인자가 붙거나 ./로 부른 branch-watch count 단계에도 걸린다', () => {
  for (const cmd of ['node tools/ci/branch-watch.mjs count --codeowners .github/CODEOWNERS', 'node ./tools/ci/branch-watch.mjs count']) {
    const r = run(withCountStep(`      - run: ${cmd}\n`));
    assert.equal(r.code, 1, `${cmd}: ${r.out}`);
    assert.match(r.out, /continue-on-error/, cmd);
    const ok = run(withCountStep(`      - run: ${cmd}\n${KEYS}`));
    assert.equal(ok.code, 0, `${cmd}: ${ok.out}`);
  }
});

test('FND160_DT49_규칙8에서 잡 수준 continue-on-error는 단계의 것을 대신하지 못한다', () => {
  const text = withCountStep('      - run: node tools/ci/branch-watch.mjs count\n        timeout-minutes: 2\n').replace(
    '    timeout-minutes: 10\n',
    '    timeout-minutes: 10\n    continue-on-error: true\n',
  );
  const r = run(text);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /continue-on-error/);
});

test('FND160_DT49_규칙8에서 이웃 단계의 키는 count 단계의 것이 아니다', () => {
  for (const [what, step] of [
    ['앞 단계', `      - run: echo 앞\n${KEYS}      - run: node tools/ci/branch-watch.mjs count\n`],
    ['뒤 단계', `      - run: node tools/ci/branch-watch.mjs count\n      - run: echo 뒤\n${KEYS}`],
  ]) {
    const r = run(withCountStep(step));
    assert.equal(r.code, 1, `${what}: ${r.out}`);
  }
});

test('FND160_DT49_규칙8에서 env: 아래의 같은 이름 키는 단계 키가 아니다', () => {
  const r = run(withCountStep('      - run: node tools/ci/branch-watch.mjs count\n        timeout-minutes: 2\n        env:\n          continue-on-error: true\n'));
  assert.equal(r.code, 1, r.out);
});

test('FND160_DT49_규칙8은 run 블록 뒤에 키가 있거나 키 줄 끝에 주석이 붙어도 통과한다', () => {
  const block = run(withCountStep(`      - name: 경고\n        run: |\n          node tools/ci/branch-watch.mjs count\n${KEYS}`));
  assert.equal(block.code, 0, block.out);
  const comment = run(withCountStep('      - run: node tools/ci/branch-watch.mjs count\n        continue-on-error: true # 경고만 한다\n        timeout-minutes: 2\n'));
  assert.equal(comment.code, 0, comment.out);
});

test('FND160_DT49_저장소 branch-policy.yml에 branch-watch count 단계가 있고 branch-policy.yml·branch-weekly.yml이 검사를 통과한다', () => {
  const dir = join(REPO, '.github', 'workflows');
  const policy = join(dir, 'branch-policy.yml');
  assert.match(readFileSync(policy, 'utf8'), /^\s*-\s+run:\s*node tools\/ci\/branch-watch\.mjs count\s*$/m);
  const r = spawnSync(process.execPath, [script, policy, join(dir, 'branch-weekly.yml')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// --- D-T32 ①: build-image.yml 빌드 잡의 권한(docs/devops.md §3.1 build-image.yml ①, BUILD_ORDER BSL-050) ---
// 빌드 잡은 그 잡의 permissions가 contents: read뿐이고, 레지스트리 로그인·푸시·cosign·출처 증명 단계가 없어야 한다.
// 서명 신원(OIDC 토큰)과 레지스트리 쓰기는 저장소 코드를 돌리지 않는 게시 잡(publish, wbs 0.1.5)만 받는다

const BUILD_GOOD = `name: build-image
on:
  workflow_call:
    inputs:
      dockerfile:
        type: string
        required: true
      image:
        type: string
        required: true
permissions:
  contents: read
jobs:
  build:
    strategy:
      matrix:
        include:
          - platform: linux/amd64
            runner: ubuntu-24.04
          - platform: linux/arm64
            runner: ubuntu-24.04-arm
    runs-on: \${{ matrix.runner }}
    timeout-minutes: 30
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@${SHA} # v7.0.1
        with:
          persist-credentials: false
      - run: node tools/ci/image-build.mjs --dockerfile "$DOCKERFILE" --image "$IMAGE" --platform "$PLATFORM" --out out
        env:
          DOCKERFILE: \${{ inputs.dockerfile }}
          IMAGE: \${{ inputs.image }}
          PLATFORM: \${{ matrix.platform }}
      - uses: actions/upload-artifact@${SHA} # v5
        with:
          name: image-\${{ strategy.job-index }}
          path: out/
`;
// 게시 잡: 서명 신원·레지스트리 쓰기·출처 증명 권한을 받고 그 단계를 둔다(규칙 11이 본다)
const PUBLISH_JOB = `  publish:
    needs: build
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    permissions:
      contents: read
      id-token: write
      packages: write
      attestations: write
    steps:
      - uses: docker/login-action@${SHA}
      - uses: sigstore/cosign-installer@${SHA}
      - run: docker push ghcr.io/peaket/v0-monolith
      - run: docker buildx imagetools create --push -t ghcr.io/peaket/v0-monolith:x a b
      - run: cosign sign --yes --recursive "ghcr.io/peaket/v0-monolith@$DIGEST"
      - uses: actions/attest-build-provenance@${SHA}
      - uses: actions/attest@${SHA}
`;
/** 게시 잡 표본이 쓰는 서드파티 액션을 든 조직 허용 목록(D-T12 ①이 이 표본을 막지 않게 한다. 게시 잡을 만들 때 실제 목록에도 더한다) */
const PUBLISH_ALLOWLIST = allowlistTf(['docker/login-action@*', 'sigstore/cosign-installer@*']);
const UPLOAD = '      - uses: actions/upload-artifact@';
/** 빌드 잡의 업로드 단계 앞에 단계를 넣는다 */
const withStep = (step) => BUILD_GOOD.replace(UPLOAD, `${step}\n${UPLOAD}`);
/** 빌드 잡의 permissions 블록을 바꾼다(null이면 없앤다) */
const JOB_PERMS = '    permissions:\n      contents: read\n';
const withPerms = (block) => BUILD_GOOD.replace(JOB_PERMS, block ?? '');

test('DT32_규칙을지킨build-image.yml은통과한다', () => {
  const r = run(BUILD_GOOD, 'build-image.yml');
  assert.equal(r.code, 0, r.out);
  assert.equal(run(BUILD_GOOD.replace(/\n/g, '\r\n'), 'build-image.yml').code, 0, 'CRLF');
});

test('DT32_빌드잡권한이_contents_read뿐이아니면실패한다', () => {
  for (const [what, block] of [
    ['id-token 쓰기', `${JOB_PERMS}      id-token: write\n`],
    ['packages 쓰기', `${JOB_PERMS}      packages: write\n`],
    ['attestations 쓰기', `${JOB_PERMS}      attestations: write\n`],
    ['다른 권한(actions 읽기)', `${JOB_PERMS}      actions: read\n`],
    ['contents 쓰기', '    permissions:\n      contents: write\n'],
    ['read-all', '    permissions: read-all\n'],
    ['write-all', '    permissions: write-all\n'],
    // 잡에 권한 블록이 없으면 맨 위 권한을 물려받는다. 빌드 잡은 자기 블록으로 좁혀 둔다
    ['잡 권한 블록 없음', null],
  ]) {
    const r = run(withPerms(block), 'build-image.yml');
    assert.equal(r.code, 1, `${what}: ${r.out}`);
    assert.match(r.out, /D-T32/, what);
  }
});

test('DT32_빌드잡에_레지스트리로그인·푸시·cosign·출처증명단계가있으면실패한다', () => {
  for (const step of [
    '      - run: echo "$TOKEN" | docker login ghcr.io -u peaket --password-stdin',
    '      - run: docker push ghcr.io/peaket/v0-monolith:x',
    '      - run: docker buildx build --push -t ghcr.io/peaket/v0-monolith:x .',
    '      - run: |\n          echo 빌드\n          docker push ghcr.io/peaket/v0-monolith:x',
    '      - run: cosign sign --yes ghcr.io/peaket/v0-monolith@sha256:abc',
    `      - uses: sigstore/cosign-installer@${SHA}`,
    `      - uses: docker/login-action@${SHA} # v3`,
    `      - uses: actions/attest-build-provenance@${SHA}`,
    `      - uses: actions/attest@${SHA}`,
  ]) {
    const r = run(withStep(step), 'build-image.yml');
    assert.equal(r.code, 1, `${step}\n${r.out}`);
    assert.match(r.out, /D-T32/, step);
  }
  // CRLF 줄바꿈이어도 같다
  const crlf = run(withStep('      - run: docker push ghcr.io/peaket/v0-monolith:x').replace(/\n/g, '\r\n'), 'build-image.yml');
  assert.equal(crlf.code, 1);
  assert.match(crlf.out, /D-T32/);
});

test('DT32_build-image.yml에_빌드잡build가없으면실패한다', () => {
  const r = run(BUILD_GOOD.replace('\n  build:\n', '\n  compile:\n'), 'build-image.yml');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /D-T32/);
});

test('D-T32 ① BAS-020 게시잡은 체크아웃·비밀 없이 서명신원·레지스트리쓰기·출처증명 권한과 cosign·attest를 갖춘다', () => {
  const ok = run(`${BUILD_GOOD}${PUBLISH_JOB}`, 'build-image.yml', { allowlist: PUBLISH_ALLOWLIST });
  assert.equal(ok.code, 0, ok.out);
  for (const [what, job] of [
    ['id-token 권한 없음', PUBLISH_JOB.replace('      id-token: write\n', '')],
    ['checkout', PUBLISH_JOB.replace('    steps:\n', `    steps:\n      - uses: actions/checkout@${SHA}\n`)],
    ['비밀 값', PUBLISH_JOB.replace('    steps:\n', '    steps:\n      - run: echo ${{ secrets.X }}\n')],
    ['cosign 없음', PUBLISH_JOB.replace(/      - run: cosign[^\n]*\n/, '')],
  ]) {
    const r = run(`${BUILD_GOOD}${job}`, 'build-image.yml', { allowlist: PUBLISH_ALLOWLIST });
    assert.notEqual(r.code, 0, what);
    assert.match(r.out, /BAS-020/, what);
  }
});

test('DT32_같은파일의_다른잡(게시잡)은_서명신원·푸시·서명·출처증명을둘수있다', () => {
  // 게시 잡이 빌드 잡 뒤에 있든 앞에 있든 빌드 잡만 본다
  const after = run(`${BUILD_GOOD}${PUBLISH_JOB}`, 'build-image.yml', { allowlist: PUBLISH_ALLOWLIST });
  assert.equal(after.code, 0, after.out);
  const before = run(BUILD_GOOD.replace('jobs:\n', `jobs:\n${PUBLISH_JOB}`), 'build-image.yml', { allowlist: PUBLISH_ALLOWLIST });
  assert.equal(before.code, 0, before.out);
  // 게시 잡이 있어도 빌드 잡의 위반은 잡는다
  const bad = run(`${withStep('      - run: docker push ghcr.io/peaket/v0-monolith:x')}${PUBLISH_JOB}`, 'build-image.yml', { allowlist: PUBLISH_ALLOWLIST });
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /D-T32/);
});

test('DT32_빌드잡의_주석줄은보지않는다', () => {
  const r = run(withStep('      # 레지스트리 docker login·docker push·cosign·id-token: write·actions/attest는 게시 잡(publish)만 한다'), 'build-image.yml');
  assert.equal(r.code, 0, r.out);
  // 주석이 아니면 잡는다
  const live = run(withStep('      - run: docker login ghcr.io && docker push ghcr.io/x/y'), 'build-image.yml');
  assert.equal(live.code, 1, live.out);
  assert.match(live.out, /D-T32/);
});

test('DT32_빌드잡규칙은_build-image.yml에만건다', () => {
  for (const text of [withPerms(`${JOB_PERMS}      id-token: write\n`), withStep('      - run: docker push ghcr.io/x/y'), BUILD_GOOD.replace('\n  build:\n', '\n  compile:\n')]) {
    const r = run(text, 'ci.yml');
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /D-T32/);
    // 같은 내용이 build-image.yml이면 실패한다
    const same = run(text, 'build-image.yml', { allowlist: PUBLISH_ALLOWLIST });
    assert.equal(same.code, 1, same.out);
    assert.match(same.out, /D-T32/);
  }
});

/** GitHub Actions 행렬 펼치기(축의 곱 + include 합치기) */
function matrixCombos(matrix) {
  const { include = [], exclude = [], ...axes } = matrix;
  assert.deepEqual(exclude, [], 'exclude는 쓰지 않는다');
  const keys = Object.keys(axes);
  let combos = keys.length ? [{}] : [];
  for (const k of keys) combos = combos.flatMap((c) => axes[k].map((v) => ({ ...c, [k]: v })));
  for (const inc of include) {
    const hits = combos.filter((c) => keys.every((k) => !(k in inc) || JSON.stringify(inc[k]) === JSON.stringify(c[k])));
    if (keys.length && hits.length) for (const c of hits) Object.assign(c, inc);
    else combos.push({ ...inc });
  }
  return combos;
}
const strings = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);

test('DT32_실제build-image.yml은_검사를통과한다', () => {
  const file = join(REPO, '.github', 'workflows', 'build-image.yml');
  assert.ok(existsSync(file), `${file}가 없다`);
  const r = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('DT32_실제build-image.yml은_재사용워크플로이고_빌드잡은플랫폼마다그아키텍처의호스트러너에서돈다', { skip: !YAML && 'yaml 패키지가 없다(pnpm install 전)' }, () => {
  const file = join(REPO, '.github', 'workflows', 'build-image.yml');
  assert.ok(existsSync(file), `${file}가 없다`);
  const doc = YAML.parse(readFileSync(file, 'utf8'));
  assert.ok(doc.on && typeof doc.on === 'object' && 'workflow_call' in doc.on, 'on.workflow_call');
  const inputs = Object.keys(doc.on.workflow_call?.inputs ?? {});
  assert.ok(inputs.some((k) => /dockerfile/i.test(k)) && inputs.some((k) => /image/i.test(k)), `입력은 Dockerfile 경로와 이미지 이름: ${inputs}`);
  const build = doc.jobs?.build;
  assert.ok(build, '잡 build');
  assert.deepEqual(build.permissions, { contents: 'read' });
  const combos = matrixCombos(build.strategy?.matrix ?? {});
  assert.equal(combos.length, 2, JSON.stringify(combos));
  const pairs = combos.map((c) => {
    const s = strings(c);
    return [s.find((x) => /^linux\/(amd64|arm64)$/.test(x)), s.find((x) => /^ubuntu-/.test(x))];
  });
  // 에뮬레이션 없이 그 아키텍처의 GitHub 호스트 러너에서 빌드한다
  assert.deepEqual(pairs.sort(), [['linux/amd64', 'ubuntu-24.04'], ['linux/arm64', 'ubuntu-24.04-arm']]);
  assert.match(String(build['runs-on']), /\$\{\{\s*matrix\./, 'runs-on은 행렬의 러너다');
  const steps = build.steps ?? [];
  assert.ok(steps.some((s) => /tools\/ci\/image-build\.mjs/.test(s.run ?? '')), '저장소 안 스크립트로 빌드한다');
  assert.ok(steps.some((s) => /^actions\/upload-artifact@/.test(s.uses ?? '')), '묶음과 다이제스트를 잡 산출물로 남긴다');
});

test('DT32_빌드잡이_다른잡뒤에있어도_그위반을잡는다', () => {
  // 게시 잡을 앞에, 위반이 있는 빌드 잡을 뒤에 둔다(첫 잡만 보는 검사를 잡는다)
  const publishFirst = (text) => text.replace('jobs:\n', `jobs:\n${PUBLISH_JOB}`);
  const good = run(publishFirst(BUILD_GOOD), 'build-image.yml', { allowlist: PUBLISH_ALLOWLIST });
  assert.equal(good.code, 0, good.out);
  for (const text of [publishFirst(withStep('      - run: docker push ghcr.io/peaket/v0-monolith:x')), publishFirst(withPerms(`${JOB_PERMS}      id-token: write\n`))]) {
    const r = run(text, 'build-image.yml', { allowlist: PUBLISH_ALLOWLIST });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /D-T32/);
  }
});

test('DT32_빌드잡권한블록은_단계뒤에있어도읽는다', () => {
  // YAML에서 잡의 키 순서는 뜻이 없다: permissions가 steps 뒤에 와도 같은 잡의 권한이다
  const after = (block) => `${withPerms(null)}${block}`;
  const ok = run(after(JOB_PERMS), 'build-image.yml');
  assert.equal(ok.code, 0, ok.out);
  const bad = run(after(`${JOB_PERMS}      id-token: write\n`), 'build-image.yml');
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /D-T32/);
  // 한 줄 모양(흐름 표기)의 쓰기 권한도 잡는다
  const flow = run(withPerms('    permissions: { contents: read, id-token: write }\n'), 'build-image.yml');
  assert.equal(flow.code, 1, flow.out);
  assert.match(flow.out, /D-T32/);
});

test('DT32_빌드잡에_--push없이레지스트리로올리는단계도실패한다', () => {
  for (const step of [
    `      - uses: docker/build-push-action@${SHA} # v6\n        with:\n          push: true`,
    '      - run: docker buildx build --output type=registry -t ghcr.io/peaket/v0-monolith:x .',
    '      - run: docker buildx build -o type=image,name=ghcr.io/peaket/v0-monolith:x,push=true .',
  ]) {
    const r = run(withStep(step), 'build-image.yml');
    assert.equal(r.code, 1, `${step}\n${r.out}`);
    assert.match(r.out, /D-T32/, step);
  }
});

/** 행렬 조합 하나로 ${{ matrix.x }}를 채운다 */
const fillMatrix = (v, combo) => (typeof v === 'string' ? v.replace(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g, (_, k) => String(combo[k] ?? `<없는 칸 ${k}>`)) : v);

test('BSL050_실제ci.yml_잡image는_범위image일때_이미지넷을build-image.yml로_푸시없이빌드한다', { skip: !YAML && 'yaml 패키지가 없다(pnpm install 전)' }, () => {
  const doc = YAML.parse(readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8'));
  // 범위 image를 changes 잡의 출력으로 낸다
  assert.match(String(doc.jobs.changes.outputs?.image ?? ''), /steps\.scope\.outputs\.image/, 'changes.outputs.image');
  const job = doc.jobs.image;
  assert.ok(job, '잡 image');
  assert.deepEqual([job.needs].flat(), ['changes']);
  // 범위를 고르지 못하면 전체를 돈다(D-T47 ④)는 다른 범위 잡과 같은 모양이다
  const cond = String(job.if ?? '');
  assert.match(cond, /needs\.changes\.outputs\.image\s*==\s*'true'/, cond);
  assert.match(cond, /needs\.changes\.result\s*!=\s*'success'/, cond);
  assert.equal(job.uses, './.github/workflows/build-image.yml');
  // 부르는 잡은 게시 잡이 요구하는 권한을 그대로 덮는다. 게시 잡은 출시·핫픽스 ref에서만 돌고, 빌드 잡은 자기 권한(contents: read)만 쓴다(BAS-020)
  assert.deepEqual(job.permissions, { contents: 'read', 'id-token': 'write', packages: 'write', attestations: 'write' });
  assert.equal(JSON.stringify(job.secrets ?? null).includes('inherit'), false, '비밀을 물려주지 않는다');
  // 이미지 넷(한 프로세스 합본은 BUILD_ORDER PRF-215, docs/devops.md §3.1): 행렬 조합마다 build-image.yml의 Dockerfile 입력을 채워 본다
  const combos = job.strategy?.matrix ? matrixCombos(job.strategy.matrix) : [{}];
  const dockerKey = Object.keys(job.with ?? {}).find((k) => /dockerfile/i.test(k));
  assert.ok(dockerKey, `with에 Dockerfile 입력이 없다: ${Object.keys(job.with ?? {})}`);
  const dockerfiles = combos.map((c) => fillMatrix(job.with[dockerKey], c)).sort();
  assert.deepEqual(dockerfiles, ['packages/platform/template/Dockerfile', 'services/bundle/Dockerfile', 'services/ops-svc/Dockerfile', 'services/pg-simulator/Dockerfile', 'services/v0-monolith/Dockerfile']);
  // 올리기를 켜는 입력이 없다
  assert.equal(Object.entries(job.with).some(([k, v]) => /push|publish|registry/i.test(k) && String(v) !== 'false'), false, JSON.stringify(job.with));
  // 필수 검사(ci-summary)가 이 잡을 기다린다
  assert.ok([doc.jobs['ci-summary'].needs].flat().includes('image'), 'ci-summary.needs에 image');
});

// 재현 시험(2026-11-03, 새 맥락 코드 리뷰 낮음-3): 빌드 잡이 비밀 값(레지스트리 자격 증명)을 받거나 다른 푸시 도구를 써도 통과했다
test('DT32_빌드잡이_비밀값을받거나_다른푸시도구를쓰면_실패한다(재현)', () => {
  for (const [what, step] of [
    ['비밀 값 환경 변수', '      - run: echo ok\n        env:\n          REG_TOKEN: ${{ secrets.REG_TOKEN }}'],
    ['비밀 값 입력', '      - uses: ./.github/actions/x\n        with:\n          token: ${{ secrets.GITHUB_TOKEN }}'],
    ['crane push', '      - run: crane push image.tar ghcr.io/peaket/v0-monolith:x'],
    ['skopeo copy', '      - run: skopeo copy oci-archive:image.tar docker://ghcr.io/peaket/v0-monolith:x'],
    ['docker image push', '      - run: docker image push ghcr.io/peaket/v0-monolith:x'],
    ['oras push', '      - run: oras push ghcr.io/peaket/v0-monolith:x image.tar'],
  ]) {
    const r = run(withStep(step), 'build-image.yml');
    assert.equal(r.code, 1, `${what}: ${r.out}`);
    assert.match(r.out, /D-T32/, what);
  }
});

// 2026-11-03 첫 원격 CI에서 찾음: tools-check가 설치 없이 돌아 yaml을 읽는 시험이 실패하거나(D-T40) 건너뛰었다(D-T32·BSL-050)
test('tools-check는_잠금파일대로_의존성을설치한뒤에_시험을돈다', () => {
  const text = readFileSync(join(REPO, '.github', 'workflows', 'tools-check.yml'), 'utf8');
  const install = text.indexOf('pnpm install --frozen-lockfile');
  assert.ok(install > 0, 'pnpm install --frozen-lockfile 단계가 없다');
  assert.ok(install < text.indexOf('node --test'), '설치가 시험보다 뒤에 있다');
});

/**
 * 워크플로 글자에서 첫 steps 목록의 단계를 차례대로 읽는다(yaml 패키지 없이. 설치 없는 잡을 막는 시험이라 yaml이 없을 때도 건너뛰지 않는다).
 * 주석 줄과 줄 끝 주석은 뺀다. 단계마다 { uses, run, keys }: run은 한 줄 값이거나 `|` 아래 줄들을 다듬어 줄바꿈으로 이은 것
 */
function workflowSteps(text) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/^\s*#.*$/, '').replace(/\s+#.*$/, ''));
  const start = lines.findIndex((l) => /^\s*steps:\s*$/.test(l));
  assert.ok(start >= 0, 'steps 목록이 없다');
  const blocks = [];
  let indent = null;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const ind = line.length - line.trimStart().length;
    indent ??= ind;
    if (ind < indent || (ind === indent && !line.trimStart().startsWith('- '))) break;
    if (ind === indent) blocks.push([`${' '.repeat(ind + 2)}${line.trimStart().slice(2)}`]);
    else blocks.at(-1).push(line);
  }
  return blocks.map((block) => {
    const step = { keys: new Set() };
    let key = null;
    for (const line of block) {
      const ind = line.length - line.trimStart().length;
      const kv = ind === indent + 2 && /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trimStart());
      if (kv) {
        key = kv[1];
        step.keys.add(key);
        step[key] = /^[|>][-+]?$/.test(kv[2]) ? '' : kv[2];
      } else if (key) step[key] = step[key] ? `${step[key]}\n${line.trim()}` : line.trim();
    }
    return step;
  });
}

// 2026-11-16 develop CI에서 찾음: loadtest-check가 설치 없이 돌아 실행 도구가 가져오는 yaml(tools/local/gateway-objects.mjs)을 찾지 못했다.
// 단언 값은 docs/devops.md §3 loadtest-check.yml 행과 계획 docs/review/plans/W8-L1-ci-fix2.md §2의 2·§3에서 가져왔다(W8-L1-ci-fix2 시험 담당)
test('CF2-03 BSL-060 loadtest-check는 잠금 파일대로 의존성을 설치한 뒤에 시험을 돈다', () => {
  const text = readFileSync(join(REPO, '.github', 'workflows', 'loadtest-check.yml'), 'utf8');
  const steps = workflowSteps(text);
  // ⓐ package.json의 packageManager 판으로 pnpm을 받는 단계(tools-check.yml과 같은 꼴, 또는 그 값을 읽는 pnpm 받기 액션)
  const getPnpm = steps.findIndex(
    (s) => (/packageManager/.test(s.run ?? '') && /npm (install|i) (--global|-g)|corepack/.test(s.run ?? '')) || /^pnpm\/action-setup@/.test(s.uses ?? ''),
  );
  // ⓑ 뿌리에서 도는 잠금 파일대로의 설치(--dir·--filter·working-directory 없음. 뿌리 개발 의존성 yaml이 필요하다)
  const install = steps.findIndex((s) => (s.run ?? '').trim() === 'pnpm install --frozen-lockfile');
  // ⓒ 부하 시험 점검의 시험 명령(글자 그대로)
  const run = steps.findIndex((s) => (s.run ?? '').trim() === 'node --test "loadtest/test/*.test.mjs"');
  assert.ok(getPnpm >= 0, 'packageManager 판으로 pnpm을 받는 단계가 없다');
  assert.ok(install >= 0, '뿌리에서 도는 `pnpm install --frozen-lockfile` 단계가 없다');
  assert.ok(run >= 0, '`node --test "loadtest/test/*.test.mjs"` 단계가 없다');
  assert.ok(!steps[install].keys.has('working-directory'), '설치 단계가 뿌리가 아닌 폴더에서 돈다');
  // 세 단계는 늘 돌고 실패하면 잡을 멈춘다(리뷰 RV-2, 검증 M-30 `if: false`·M-31 `continue-on-error: true`)
  for (const [what, i] of [['pnpm 받기', getPnpm], ['설치', install], ['시험', run]])
    for (const key of ['if', 'continue-on-error']) assert.ok(!steps[i].keys.has(key), `${what} 단계에 ${key}가 있다(건너뛰거나 실패를 넘길 수 있다)`);
  assert.doesNotMatch(text, /^\s*defaults:/m, '잡·워크플로 기본값(defaults)이 설치 폴더를 바꿀 수 있다');
  assert.ok(getPnpm < install, 'pnpm 받기가 설치보다 뒤에 있다');
  assert.ok(install < run, '설치가 시험보다 뒤에 있다');
});

test('CI에서는_yaml패키지가있어_YAML시험을건너뛰지않는다', { skip: !process.env.CI && 'CI 밖(로컬은 pnpm install 전이면 건너뛴다)' }, () => {
  assert.ok(YAML, 'CI에서 yaml 패키지를 읽지 못했다');
});

// ---------- 규칙 10: 부른 워크플로의 잡 권한은 부르는 잡 권한 안(docs/devops.md §4.4 '리뷰 뒤 더한 규칙' ①, ADR-0263 결정 13) ----------
// 부른 워크플로의 잡이 부르는 잡보다 넓은 권한을 달라고 하면 GitHub은 그 실행을 시작하지 않는다(리뷰 H1: scorecard 잡의 actions: read)

const caller = (perms) => `name: ci
on:
  pull_request:
permissions:
  contents: read
jobs:
  scan:
${perms ? `    permissions:\n${perms}` : ''}    uses: ./.github/workflows/called.yml
`;
const called = (top, jobPerms) => `name: called
on:
  workflow_call:
${top === null ? '' : `permissions:${/^ \S/.test(top) ? top : `\n${top}`}\n`}jobs:
  a:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
${jobPerms ? `    permissions:\n${jobPerms}` : ''}    steps:
      - run: echo ok
`;
const perm = (o) => Object.entries(o).map(([k, v]) => `      ${k}: ${v}\n`).join('');

test('BAS011_규칙10 부른 워크플로의 모든 잡 권한은 부르는 잡 권한 안이다(적지 않은 것은 none, 읽기 < 쓰기)', () => {
  const check = (callerPerms, top, jobPerms) => run(caller(callerPerms), 'ci.yml', { called: { 'called.yml': called(top, jobPerms) } });
  // 부르는 잡이 권한을 적지 않으면 그 워크플로 맨 위 권한(contents: read)이다
  assert.equal(check(null, '  contents: read', null).code, 0);
  const actions = check(null, '  contents: read', perm({ contents: 'read', actions: 'read' }));
  assert.equal(actions.code, 1, actions.out);
  assert.match(actions.out, /called\.yml.*잡 a.*actions: read.*none/);
  // 부르는 잡이 준 쓰기 안에서 읽기·쓰기는 받는다
  const cw = perm({ contents: 'read', 'security-events': 'write' });
  assert.equal(check(cw, '  contents: read', perm({ contents: 'read', 'security-events': 'write' })).code, 0);
  assert.equal(check(cw, '  contents: read', perm({ 'security-events': 'read' })).code, 0);
  const up = check(cw, '  contents: read', perm({ contents: 'write' }));
  assert.equal(up.code, 1);
  assert.match(up.out, /contents: write.*read/);
  // 잡 권한이 없으면 부른 워크플로 맨 위 권한을 본다
  assert.equal(check(cw, '  contents: write', null).code, 1);
  assert.equal(check(cw, ' write-all', null).code, 1);
  assert.equal(check(cw, ' {}', null).code, 0);
  // read-all을 준 부르는 잡은 읽기는 모두 받고 쓰기는 받지 않는다
  assert.equal(check(null, '  actions: read', null).code, 1, '맨 위 contents: read만 준다');
  const readAll = (top, job) => run(caller(null).replace('    uses:', '    permissions: read-all\n    uses:'), 'ci.yml', { called: { 'called.yml': called(top, job) } });
  assert.equal(readAll('  actions: read', perm({ actions: 'read', checks: 'read' })).code, 0);
  assert.equal(readAll('  contents: read', perm({ issues: 'write' })).code, 1);
  // 빈 권한({})을 준 부르는 잡에는 읽기도 넘지 못한다
  assert.equal(run(caller(null).replace('    uses:', '    permissions: {}\n    uses:'), 'ci.yml', { called: { 'called.yml': called('  contents: read', null) } }).code, 1);
  // 부른 워크플로 파일이 없으면 실패한다
  const missing = run(caller(null), 'ci.yml', { called: {} });
  assert.equal(missing.code, 1);
  assert.match(missing.out, /called\.yml/);
});

test('BAS011_규칙10 실제 ci.yml이 부르는 워크플로는 모두 부르는 잡 권한 안이고, security-scan.yml에 actions: read 잡을 더하면 실패한다(리뷰 H1 재현)', () => {
  const ci = join(REPO, '.github', 'workflows', 'ci.yml');
  const ok = spawnSync(process.execPath, [script, ci], { encoding: 'utf8', cwd: REPO });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const dir = tempDir('check-workflows-h1-');
  const wf = join(dir, '.github', 'workflows');
  mkdirSync(wf, { recursive: true });
  const sources = readFileSync(ci, 'utf8').match(/\.\/\.github\/workflows\/[\w.-]+\.ya?ml/g).map((p) => p.split('/').pop());
  for (const f of new Set(sources)) writeFileSync(join(wf, f), readFileSync(join(REPO, '.github', 'workflows', f), 'utf8'));
  writeFileSync(join(wf, 'ci.yml'), readFileSync(ci, 'utf8'));
  const scan = readFileSync(join(wf, 'security-scan.yml'), 'utf8');
  writeFileSync(join(wf, 'security-scan.yml'), `${scan.trimEnd()}\n\n  scorecard:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 15\n    permissions:\n      contents: read\n      actions: read\n    steps:\n      - run: echo scorecard\n`);
  const r = spawnSync(process.execPath, [script, join(wf, 'ci.yml')], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /security-scan\.yml.*잡 scorecard.*actions: read/);
});

// 2026-11-16 develop CI kind 잡에서 찾음: kubectl 포트 전달이 Envoy의 RST 하나에 통째로 끝나 게이트웨이 시험 43개 가운데 21개가 연결 거절로 실패했다.
// 단언 값은 docs/devops.md §3 ci-kind.yml 행, docs/infra.md §4.1 '로컬 kind에서 이 PC로 잇는 법', 계획 docs/review/plans/W8-L1-ci-fix3.md §2 '나'의 8에서 가져왔다(W8-L1-ci-fix3 시험 담당)
test('CF3-03 HOT-400 ci-kind는 포트 전달 없이 게이트웨이 시험 넷을 그 차례로 돈다', () => {
  const text = readFileSync(join(REPO, '.github', 'workflows', 'ci-kind.yml'), 'utf8');
  // 주석까지 포함해 글자가 없다(포트 전달 명령·로그 파일로 돌아가지 않는다)
  assert.ok(!text.includes('gateways-forward'), 'ci-kind.yml에 gateways-forward가 있다');
  assert.ok(!text.includes('port-forward'), 'ci-kind.yml에 port-forward가 있다');
  const steps = workflowSteps(text);
  const gateways = steps.findIndex((s) => (s.run ?? '').trim() === 'node tools/local/cluster.mjs gateways');
  assert.ok(gateways >= 0, '`node tools/local/cluster.mjs gateways` 단계가 없다');
  const FILES = ['gateways', 'queue-cors', 'gateway-limits', 'gateway-routes'];
  const at = FILES.map((f) => {
    const re = new RegExp(String.raw`^node --test\b[^\n]*\stools/local/e2e/${f}\.e2e\.mjs\s*$`);
    const found = [];
    steps.forEach((s, i) =>
      (s.run ?? '').split('\n').forEach((line, j) => {
        if (re.test(line.trim())) found.push({ step: i, line: j, text: line.trim() });
      }),
    );
    assert.equal(found.length, 1, `${f}.e2e.mjs를 도는 줄이 하나가 아니다: ${found.map((x) => x.text).join(' | ') || '없음'}`);
    assert.match(found[0].text, /\s--test-timeout=300000\s/, `${f}.e2e.mjs에 --test-timeout=300000이 없다`);
    return found[0];
  });
  for (const [i, x] of at.entries()) assert.ok(x.step > gateways, `${FILES[i]}.e2e.mjs가 cluster.mjs gateways 단계보다 앞이다`);
  // gateways 단계와 e2e 줄이 든 단계는 늘 돌고 실패하면 잡을 멈춘다(검증 V-20, W8-L1-ci-fix2 CF2-03과 같은 꼴)
  for (const i of new Set([gateways, ...at.map((x) => x.step)])) {
    const what = i === gateways ? 'cluster.mjs gateways 단계' : 'e2e 단계';
    for (const key of ['if', 'continue-on-error']) assert.ok(!steps[i].keys.has(key), `${what}에 ${key}가 있다(건너뛰거나 실패를 넘길 수 있다)`);
    assert.doesNotMatch(steps[i].run ?? '', /\bset\s+\+e\b/, `${what}의 run에 set +e가 있다`);
    assert.doesNotMatch(steps[i].run ?? '', /\|\|\s*true\b/, `${what}의 run에 || true가 있다`);
  }
  for (let i = 1; i < at.length; i++) {
    const [a, b] = [at[i - 1], at[i]];
    assert.ok(a.step < b.step || (a.step === b.step && a.line < b.line), `${FILES[i - 1]} → ${FILES[i]} 차례가 아니다`);
  }
});

// W11-ci-conc: 정본 docs/devops.md §3.4 'CI 속도와 신뢰' — 앞 실행 취소는 PR에서만 하고, develop·main·릴리스·핫픽스 푸시는 끝까지 돈다.
// YAML 패키지 없이 줄로 읽어 로컬에서도 건너뛰지 않는다. 주석 줄과 줄 끝 주석은 보지 않는다
function ciLines() {
  return readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*#.*$/, '').replace(/\s+#.*$/, ''));
}

test('CC-01 실제 ci.yml 맨 위 concurrency 블록은 PR 번호(없으면 ref) 그룹이고, 취소는 PR 사건일 때만 한다', () => {
  const lines = ciLines();
  const start = lines.findIndex((l) => /^concurrency:\s*$/.test(l));
  assert.ok(start >= 0, '맨 위(들여쓰기 없는) concurrency: 블록이 없다');
  const body = {};
  for (let i = start + 1; i < lines.length && (lines[i] === '' || /^\s/.test(lines[i])); i++) {
    const m = lines[i].match(/^\s+([\w-]+):\s*(.*?)\s*$/);
    if (m) body[m[1]] = m[2];
  }
  assert.equal(body.group, 'ci-${{ github.event.pull_request.number || github.ref }}', 'concurrency.group 값');
  assert.equal(body['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}", 'concurrency.cancel-in-progress 값');
});

test('CC-02 실제 ci.yml에 concurrency:와 cancel-in-progress: 줄이 각각 하나뿐이다(잡에 따로 두어 맨 위 규칙을 덮지 않는다)', () => {
  const lines = ciLines();
  for (const key of ['concurrency', 'cancel-in-progress']) {
    const at = lines.flatMap((l, i) => (new RegExp(String.raw`^\s*${key}:`).test(l) ? [i + 1] : []));
    assert.equal(at.length, 1, `${key}: 줄이 ${at.length}개다(줄 ${at.join(', ') || '없음'})`);
  }
});

test("CC-03 규칙 4: github.event_name == 'pull_request'는 사용자가 고칠 수 없는 값이라 식에 써도 된다(맨 위 concurrency 블록에 두어도 끝 코드 0)", () => {
  const expr = "github.event_name == 'pull_request'";
  assert.equal(run(GOOD.replace('github.event.pull_request.head.sha', expr)).code, 0, '단계 env');
  const withConc = GOOD.replace('jobs:\n', `concurrency:\n  group: ci-\${{ github.event.pull_request.number || github.ref }}\n  cancel-in-progress: \${{ ${expr} }}\n\njobs:\n`);
  assert.notEqual(withConc, GOOD, '표본에 concurrency 블록을 넣지 못했다');
  const r = run(withConc);
  assert.equal(r.code, 0, r.out);
  // 대조(검증 VF-A5, 리뷰 RV-03): 같은 블록에 사용자가 고칠 수 있는 값을 넣으면 실패해야, 규칙 4가 맨 위 concurrency 블록도 본다는 것이 지켜진다
  const bad = withConc.replace(`cancel-in-progress: \${{ ${expr} }}`, "cancel-in-progress: ${{ github.head_ref == 'x' }}");
  assert.notEqual(bad, withConc, '대조 표본을 만들지 못했다');
  const rb = run(bad);
  assert.equal(rb.code, 1, rb.out);
  assert.match(rb.out, /사용자가 고칠 수 있는 값/);
});

// CC-04(검증 VF-A3·A4): 잡 단위 concurrency가 있으면 develop 푸시가 이어질 때 다음 실행의 그 잡이 앞 실행의 잡을 취소한다.
// 따옴표 키("concurrency":)도 YAML로는 같은 키라 줄이 아니라 YAML로 읽는다. CI에서는 'CI에서는_yaml패키지가있어_YAML시험을건너뛰지않는다'가 건너뛰지 않음을 지킨다
test('CC-04 ci.yml과 ci.yml이 부르는 워크플로(./.github/workflows/*.yml, 부른 것이 부르는 것까지)의 어느 잡에도 concurrency가 없고, concurrency는 ci.yml 맨 위에만 있다', { skip: !YAML && 'yaml 패키지가 없다(pnpm install 전)' }, () => {
  const dir = join(REPO, '.github', 'workflows');
  const seen = new Set();
  const queue = ['ci.yml'];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const doc = YAML.parse(readFileSync(join(dir, name), 'utf8'));
    if (name === 'ci.yml') assert.ok(doc.concurrency, 'ci.yml 맨 위 concurrency가 없다');
    else assert.equal(doc.concurrency, undefined, `${name} 맨 위에 concurrency가 있다`);
    for (const [job, def] of Object.entries(doc.jobs ?? {})) {
      assert.ok(!Object.hasOwn(def ?? {}, 'concurrency'), `${name}의 잡 ${job}에 concurrency가 있다`);
      const m = typeof def?.uses === 'string' && def.uses.match(/^\.\/\.github\/workflows\/([\w.-]+\.ya?ml)$/);
      if (m) queue.push(m[1]);
    }
  }
  assert.ok(seen.size > 1, `ci.yml이 부르는 워크플로를 찾지 못했다: ${[...seen].join(', ')}`);
});

/**
 * GitHub 식(${{ }})의 작은 평가기(CC-05). 문맥 이름은 ctx의 값으로 바꾸고, &&·||·==·!=·!·괄호·작은따옴표 글자·true/false/null·cancelled()만 받는다.
 * ctx에 없는 이름이나 모르는 꼴이면 던진다(식이 바뀌어 시험이 모르는 값에 기대면 조용히 통과하지 않게).
 * &&·||는 GitHub처럼 피연산자 값을 낸다. ==는 같은 꼴이면 글자는 대소문자 없이 견주고, 다른 꼴이면 수로 바꿔 견준다(null·false는 0, true는 1)
 */
function evalExpr(src, ctx) {
  const body = src.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1');
  const toks = body.match(/\s+|&&|\|\||==|!=|!|\(|\)|'(?:[^']|'')*'|[A-Za-z_][\w.-]*\(\)|[A-Za-z_][\w.-]*|./g).filter((t) => !/^\s+$/.test(t));
  let p = 0;
  const peek = () => toks[p];
  const eat = (t) => {
    if (toks[p] !== t) throw new Error(`식 '${body}'에서 ${t}가 와야 하는데 ${toks[p]}이다`);
    p++;
  };
  const truthy = (v) => !(v === false || v === null || v === 0 || v === '' || v === undefined);
  const num = (v) => (v === null ? 0 : Number(v));
  const eq = (a, b) => (typeof a === typeof b && a !== null && b !== null ? (typeof a === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b) : num(a) === num(b));
  const primary = () => {
    const t = toks[p++];
    if (t === undefined) throw new Error(`식 '${body}'이 중간에 끝났다`);
    if (t === '(') {
      const v = or();
      eat(')');
      return v;
    }
    if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    if (t === 'true' || t === 'false') return t === 'true';
    if (t === 'null') return null;
    if (t === 'cancelled()') return false;
    if (/^[A-Za-z_][\w.-]*$/.test(t)) {
      if (!Object.hasOwn(ctx, t)) throw new Error(`식 '${body}'의 모르는 이름: ${t}`);
      return ctx[t];
    }
    throw new Error(`식 '${body}'의 모르는 꼴: ${t}`);
  };
  const unary = () => {
    if (peek() === '!') {
      p++;
      return !truthy(unary());
    }
    return primary();
  };
  const cmp = () => {
    let v = unary();
    while (peek() === '==' || peek() === '!=') {
      const op = toks[p++];
      const r = unary();
      v = op === '==' ? eq(v, r) : !eq(v, r);
    }
    return v;
  };
  const and = () => {
    let v = cmp();
    while (peek() === '&&') {
      p++;
      const r = cmp();
      v = truthy(v) ? r : v;
    }
    return v;
  };
  function or() {
    let v = and();
    while (peek() === '||') {
      p++;
      const r = and();
      v = truthy(v) ? v : r;
    }
    return v;
  }
  const v = or();
  if (p !== toks.length) throw new Error(`식 '${body}'의 ${toks[p]}부터를 읽지 못했다`);
  return v;
}

// CC-05 ★(리뷰 RV-02, 소유자 결정 (다) 2026-11-19): 가지 푸시는 spec-check 전수 검사(full)와 큰 러너를 띄우지 않는다. 전수 검사는 PR과 일정 실행이 맡는다.
// 큰 러너 변수는 peaket-runner2, 큰 러너 묶음(matrix.large)은 참으로 둔다
test('CC-05 가지 푸시는 spec-check를 full·큰 러너로 돌리지 않고, PR은 changes 실패나 specs_full 참일 때 full·큰 러너, 일정 실행은 full·큰 러너다', { skip: !YAML && 'yaml 패키지가 없다(pnpm install 전)' }, () => {
  const wf = (n) => YAML.parse(readFileSync(join(REPO, '.github', 'workflows', n), 'utf8'));
  const ci = wf('ci.yml');
  const sc = wf('spec-check.yml');
  const job = ci.jobs['spec-check'];
  assert.equal(job.uses, './.github/workflows/spec-check.yml', 'ci.yml 잡 spec-check가 spec-check.yml을 부르지 않는다');
  const listMode = sc.jobs.list.steps.map((s) => s.env?.MODE).filter(Boolean);
  assert.equal(listMode.length, 1, 'spec-check.yml list 잡에서 MODE를 두는 단계가 하나가 아니다');
  const LARGE = 'peaket-runner2';
  const base = (event, ref, fork) => ({ 'github.event_name': event, 'github.ref': ref, 'github.event.pull_request.head.repo.fork': fork, 'vars.PEAKET_LARGE_RUNNER': LARGE, 'matrix.large': true });
  const runsOn = (ctx, mode) => evalExpr(sc.jobs.spec['runs-on'], { ...ctx, 'inputs.mode': mode });
  const cases = [];
  for (const event of ['push', 'pull_request'])
    for (const result of ['success', 'failure'])
      for (const specsFull of ['true', 'false'])
        for (const specs of ['true', 'false'])
          for (const ref of event === 'push' ? ['refs/heads/develop', 'refs/heads/main', 'refs/heads/release/x', 'refs/heads/hotfix/x'] : ['refs/pull/1/merge'])
            cases.push({ event, result, specsFull, specs, ref });
  for (const c of cases) {
    const ctx = { ...base(c.event, c.ref, c.event === 'push' ? null : false), 'needs.changes.result': c.result, 'needs.changes.outputs.specs': c.specs, 'needs.changes.outputs.specs_full': c.specsFull };
    const what = `${c.event} ${c.ref} changes=${c.result} specs=${c.specs} specs_full=${c.specsFull}`;
    const runs = evalExpr(job.if, ctx);
    const mode = evalExpr(job.with.mode, ctx);
    const listed = evalExpr(listMode[0], { 'inputs.mode': mode });
    if (c.event === 'push') {
      if (!runs) continue;
      assert.equal(mode, 'pr', `${what}: mode`);
      assert.equal(listed, 'pr', `${what}: list MODE`);
      assert.equal(runsOn(ctx, mode), 'ubuntu-24.04', `${what}: runs-on`);
    } else {
      const full = c.result !== 'success' || c.specsFull === 'true';
      if (full) assert.ok(runs, `${what}: 잡이 불리지 않는다`);
      if (!runs) continue;
      assert.equal(mode, full ? 'full' : 'pr', `${what}: mode`);
      assert.equal(listed, mode, `${what}: list MODE`);
      assert.equal(runsOn(ctx, mode), full ? LARGE : 'ubuntu-24.04', `${what}: runs-on`);
    }
  }
  // 일정 실행: spec-check.yml을 직접 돌리고 inputs.mode가 비어 있다
  assert.ok(Array.isArray(sc.on?.schedule) && sc.on.schedule.length > 0, 'spec-check.yml에 on.schedule이 없다');
  const sched = base('schedule', 'refs/heads/develop', null);
  assert.equal(evalExpr(listMode[0], { 'inputs.mode': '' }), 'full', '일정 실행 list MODE');
  assert.equal(runsOn(sched, ''), LARGE, '일정 실행 runs-on');
});

// --- BAT-080 KE-01·KE-02(D-T18 ①, BAT-075 TO-2·TO-5): ci-kind.yml의 진단 e2e 복귀와 실패 수집(정적 시험) ---
// 실제 판정은 kind에서 diagnose.e2e.mjs가 도는 것이다. 여기서는 워크플로가 그 시험을 빼먹지 않았는지,
// 실패 때 파드(전·현재 컨테이너)·moto·/diag·버킷 전체를 남기는 단계가 있는지만 지킨다.
const ciKind = () => YAML.parse(readFileSync(join(REPO, '.github', 'workflows', 'ci-kind.yml'), 'utf8'));

test('KE-01 ci-kind.yml이_cluster_up·image뒤에_diagnose.e2e.mjs를_15분상한으로_돈다', { skip: !YAML && 'yaml 패키지가 없다(pnpm install 전)' }, () => {
  const steps = ciKind().jobs.kind.steps;
  const runs = steps.map((s) => (typeof s.run === 'string' ? s.run : '')).filter(Boolean);
  const at = (needle) => runs.findIndex((t) => t.includes(needle));
  const up = at('tools/local/cluster.mjs up');
  const image = at('tools/local/cluster.mjs image');
  const probes = at('tools/local/e2e/probes.e2e.mjs');
  const diagnose = at('tools/local/e2e/diagnose.e2e.mjs');
  assert.ok(up >= 0, 'cluster up 단계');
  assert.ok(image > up, 'cluster up 뒤 image 단계');
  assert.ok(probes > image, 'image 뒤 probes e2e');
  // diagnose는 이미지·moto·버킷을 만드는 앞 단계 뒤에 돈다(앞에 두면 무대가 없다)
  assert.ok(diagnose > probes, `diagnose e2e가 probes 뒤에 없다(probes ${probes}, diagnose ${diagnose})`);
  assert.match(runs[diagnose], /--test-timeout=900000/, 'diagnose e2e 시험 상한 15분');
  // 넘겨 둔 줄이 아니다(주석으로 빼 두지 않는다)
  assert.doesNotMatch(readFileSync(join(REPO, '.github', 'workflows', 'ci-kind.yml'), 'utf8'), /diagnose\.e2e\.mjs.*넘김/, 'diagnose e2e가 아직 주석이다');
});

test('KE-02 ci-kind.yml의_실패수집이_diagnose-e2e파드전·현재로그_이벤트_/diag목록_helm값_버킷전체_moto로그를남긴다', { skip: !YAML && 'yaml 패키지가 없다(pnpm install 전)' }, () => {
  const steps = ciKind().jobs.kind.steps;
  const failure = steps.findIndex((s) => typeof s.if === 'string' && s.if.includes('failure()'));
  assert.ok(failure >= 0, 'if: failure() 수집 단계');
  const runs = steps.map((s) => (typeof s.run === 'string' ? s.run : ''));
  const diagnose = runs.findIndex((t) => t.includes('tools/local/e2e/diagnose.e2e.mjs'));
  assert.ok(failure > diagnose, '실패 수집이 diagnose e2e 뒤에 있다');
  const collect = runs[failure];
  for (const want of [
    '-n diagnose-e2e get pods,events',
    'describe pods',
    'get values diag',
    'get manifest diag',
    '--previous',
    'app.kubernetes.io/component=service',
    'ls -la /diag',
    'peaket-diag-e2e?list-type=2',
    '-n peaket-local logs deploy/aws',
    '-n peaket-local exec deploy/aws',
    'cluster.mjs status',
  ]) {
    assert.ok(collect.includes(want), `실패 수집에 "${want}"가 없다`);
  }
  // 릴리스가 지워졌어도 무엇으로 떴는지 남긴다
  assert.match(collect, /helm/);
  assert.match(collect, /status diag/);
  // 마지막 내리기는 실패해도 돈다
  const down = steps.findIndex((s) => typeof s.run === 'string' && s.run.includes('cluster.mjs down'));
  assert.ok(down >= 0, 'cluster down 단계');
  assert.match(String(steps[down].if), /always\(\)/, 'cluster down은 always()');
  // 측정 파일은 커밋하지 않고 산출물로 올린다
  const artifact = steps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/upload-artifact@'));
  assert.ok(artifact, '산출물 단계');
  assert.equal(artifact.with.name, 'kind-bat075-measurements');
  for (const p of ['docs/review/measurements/BAT-075-probes.md', 'docs/review/measurements/BAT-075-diagnose.md']) {
    assert.ok(artifact.with.path.includes(p), `산출물에 ${p}가 없다`);
  }
});

