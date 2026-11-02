// check-workflows.mjs를 임시 워크플로 파일로 돌려 보는 시험. 실행: node --test "tools/ci/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './git-fixture.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-workflows.mjs');
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// 실제 build-image.yml의 행렬을 읽는 데 쓴다. tools-check 잡처럼 pnpm install 없이 돌면 없다(그 시험만 건너뛴다)
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
// 미래의 게시 잡: 서명 신원·레지스트리 쓰기·출처 증명 권한을 받고 그 단계를 둔다(이 잡은 규칙 밖이다)
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

test('DT32_같은파일의_다른잡(게시잡)은_서명신원·푸시·서명·출처증명을둘수있다', () => {
  // 게시 잡이 빌드 잡 뒤에 있든 앞에 있든 빌드 잡만 본다
  const after = run(`${BUILD_GOOD}${PUBLISH_JOB}`, 'build-image.yml');
  assert.equal(after.code, 0, after.out);
  const before = run(BUILD_GOOD.replace('jobs:\n', `jobs:\n${PUBLISH_JOB.replace('    needs: build\n', '')}`), 'build-image.yml');
  assert.equal(before.code, 0, before.out);
  // 게시 잡이 있어도 빌드 잡의 위반은 잡는다
  const bad = run(`${withStep('      - run: docker push ghcr.io/peaket/v0-monolith:x')}${PUBLISH_JOB}`, 'build-image.yml');
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
    const same = run(text, 'build-image.yml');
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
  const publishFirst = (text) => text.replace('jobs:\n', `jobs:\n${PUBLISH_JOB.replace('    needs: build\n', '')}`);
  const good = run(publishFirst(BUILD_GOOD), 'build-image.yml');
  assert.equal(good.code, 0, good.out);
  for (const text of [publishFirst(withStep('      - run: docker push ghcr.io/peaket/v0-monolith:x')), publishFirst(withPerms(`${JOB_PERMS}      id-token: write\n`))]) {
    const r = run(text, 'build-image.yml');
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

test('BSL050_실제ci.yml_잡image는_범위image일때_이미지셋을build-image.yml로_푸시없이빌드한다', { skip: !YAML && 'yaml 패키지가 없다(pnpm install 전)' }, () => {
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
  // 부르는 잡이 권한을 넓히지 않는다(맨 위 contents: read를 물려준다)
  assert.ok(job.permissions === undefined || JSON.stringify(job.permissions) === JSON.stringify({ contents: 'read' }), JSON.stringify(job.permissions));
  assert.equal(JSON.stringify(job.secrets ?? null).includes('inherit'), false, '비밀을 물려주지 않는다');
  // 이미지 셋: 행렬 조합마다 build-image.yml의 Dockerfile 입력을 채워 본다
  const combos = job.strategy?.matrix ? matrixCombos(job.strategy.matrix) : [{}];
  const dockerKey = Object.keys(job.with ?? {}).find((k) => /dockerfile/i.test(k));
  assert.ok(dockerKey, `with에 Dockerfile 입력이 없다: ${Object.keys(job.with ?? {})}`);
  const dockerfiles = combos.map((c) => fillMatrix(job.with[dockerKey], c)).sort();
  assert.deepEqual(dockerfiles, ['packages/platform/template/Dockerfile', 'services/pg-simulator/Dockerfile', 'services/v0-monolith/Dockerfile']);
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
