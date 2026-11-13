// changes.mjs를 바깥에서 돌려 보는 시험(D-T47). 실행: node --test "tools/ci/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

test('D-T47 ② packages/platform을 바꾸면 화면·서비스 전부(js_all)와, 서비스 문서를 뽑는 곳이라 계약 잡을, 서비스 이미지에 드는 곳이라 kind와 이미지 빌드 시험(image)을 고른다', () => {
  // 범위 순서는 changes.mjs의 SCOPES 순서다(image는 kind 바로 뒤, BSL-050)
  assert.deepEqual(scopes({ 'packages/platform/x.ts': '바꿈\n' }), ['contracts', 'js', 'js_all', 'kind', 'image']);
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
  assert.deepEqual(s, ['docs', 'contracts', 'js', 'js_all', 'infra', 'kind', 'image']);
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
  assert.deepEqual(scopes({ 'services/trust-svc/src/main.ts': 'x\n' }), ['contracts', 'js']);
  // 한 프로세스 합본 이미지에 드는 서비스는 이미지 빌드 시험도 고른다(BUILD_ORDER PRF-215)
  assert.deepEqual(scopes({ 'services/queue-svc/src/main.ts': 'x\n' }), ['contracts', 'js', 'image']);
  assert.deepEqual(scopes({ 'tools/ci/contract-breaking.mjs': 'x\n' }), ['contracts', 'tools']);
  assert.deepEqual(scopes({ 'tools/ci/release-tags.mjs': 'x\n' }), ['contracts', 'tools']);
  assert.deepEqual(scopes({ '.github/workflows/contract-check.yml': 'x\n' }), ['contracts', 'ci']);
});

test('DT38_서비스템플릿과_서비스문서비교본체를바꾸면_contracts를고른다', () => {
  // emitOpenApi·contractSchema(packages/platform)나 비교 본체를 고치면 서비스 OpenAPI 차이를 다시 돌린다(코드 리뷰, add-service-template)
  assert.deepEqual(scopes({ 'packages/platform/src/openapi.ts': 'x\n' }), ['contracts', 'js', 'js_all', 'kind', 'image']);
  // 비교 본체는 서비스 템플릿의 계약 전체 대조 시험(contract-sweep.test.ts, node 잡)도 쓰므로 js도 켠다(다시 본 리뷰)
  assert.deepEqual(scopes({ 'tools/ci/service-openapi.mjs': 'x\n' }), ['contracts', 'js', 'tools']);
});

test('자바스크립트검사방식을바꾸면_전체js를고르고_서비스템플릿이읽는정본문서를바꾸면_js를고른다', () => {
  // ci-node.yml·turbo.json·.nvmrc는 모든 자바스크립트 검사가 도는 방식이다. observability.md는 서비스 템플릿 시험이 칸 목록을 견준다
  assert.deepEqual(scopes({ '.github/workflows/ci-node.yml': 'x\n' }), ['js', 'js_all', 'ci']);
  // turbo.json·.nvmrc는 화면 잡(web)이 도는 방식이기도 하다(BAS-170)
  assert.deepEqual(scopes({ 'turbo.json': '{}\n' }), ['docs', 'js', 'js_all', 'web']);
  // .nvmrc는 이미지 빌드 시험(image)의 작업 공간 파일에도 든다(BSL-050)
  assert.deepEqual(scopes({ '.nvmrc': '24\n' }), ['js', 'js_all', 'image', 'web']);
  assert.deepEqual(scopes({ 'docs/observability.md': '글\n' }), ['docs', 'js']);
});

test('낮음008_뿌리ESLint설정과_공용설정패키지를바꾸면_전체js를고른다', () => {
  // 뿌리 eslint.config.mjs와 @peaket/config(ESLint·TypeScript 설정)는 모든 서비스·패키지의 린트와 형 검사 방식이다(add-service-structure-and-request-checks)
  assert.deepEqual(scopes({ 'eslint.config.mjs': 'export default [];\n' }), ['js', 'js_all']);
  // @peaket/config는 이미지가 담는 패키지라 이미지 빌드 시험(image)도 고른다(BSL-050)
  // 화면 앱도 같은 설정을 쓰므로 화면 잡(web)도 고른다(BAS-170)
  assert.deepEqual(scopes({ 'packages/config/eslint/service-layers.mjs': 'x\n' }), ['js', 'js_all', 'kind', 'image', 'web']);
});

test('FND110_로컬클러스터·공용차트·릴레이·Lease코드·이미지파일을바꾸면_kind를고른다', () => {
  for (const f of [
    'deploy/local/kind.yaml',
    'deploy/charts/peaket-service/values.yaml',
    'tools/local/cluster.mjs',
    'packages/platform/template/Dockerfile',
    'packages/platform/template/src/relay.ts',
    'packages/platform/src/lease.ts',
    'packages/platform/src/outbox-relay.ts',
    'packages/platform/src/relay-process.ts',
    'packages/platform/src/maintenance.ts',
    '.github/workflows/ci-kind.yml',
    '.dockerignore',
    // 코드 리뷰 2026-11-01: kind 시험이 직접 쓰는 마이그레이션·서비스 시작·준비 프로브와 이미지에 드는 잠금 파일
    'packages/platform/template/migrations/0002_outbox.sql',
    'packages/platform/template/src/main.ts',
    'packages/platform/src/service.ts',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    // 확인 리뷰 2026-11-01: 이미지와 시작 명령이 기대는 플랫폼 패키지 전부(내보내기·설정·로그·OTel 등록)와 공용 설정
    'packages/platform/package.json',
    'packages/platform/src/telemetry-register.ts',
    'packages/platform/src/config.ts',
    'packages/platform/tsconfig.build.json',
    'packages/config/tsconfig/base.json',
  ]) {
    assert.ok(scopes({ [f]: '바꿈\n' }).includes('kind'), f);
  }
  // 플랫폼 밖 화면과 문서만 바꾸면 kind를 고르지 않는다(무거운 잡)
  assert.equal(scopes({ 'apps/web/src/a.ts': '바꿈\n' }).includes('kind'), false);
  assert.equal(scopes({ 'docs/infra.md': '글\n' }).includes('kind'), false);
});

// 규칙 모델 검사(wbs 0.9.1, docs/verification.md §2.2): 명세·검사 도구가 바뀌면 PR 검사(시뮬레이션), 명세 목록이 적은 관련 ADR이 바뀌면 전수 검사
test('V-T1 명세와_검사도구를바꾸면_specs를고르고_전수검사는고르지않는다', () => {
  assert.deepEqual(scopes({ 'specs/queue.qnt': 'module queue {}\n' }), ['specs']);
  assert.deepEqual(scopes({ 'tools/spec-check/spec-check.mjs': '\n' }), ['tools', 'specs']);
  assert.ok(scopes({ '.github/workflows/spec-check.yml': 'name: spec-check\n' }).includes('specs'));
  assert.equal(scopes({ 'specs/queue.qnt': 'module queue {}\n' }).includes('specs_full'), false);
});

test('V-T40 모델기반시험의_명령이름목록·재생기록을바꾸면_이름목록검사(specs)도고른다', () => {
  assert.ok(scopes({ 'services/admission-ctrl/test-int/queue-model/actions.ts': 'export const SPEC_ACTIONS = [];\n' }).includes('specs'));
  assert.ok(scopes({ 'services/admission-ctrl/test-int/queue-model/traces/manifest.json': '{}\n' }).includes('specs'));
  assert.ok(scopes({ 'services/purchase-svc/test-int/seat-hold-model/actions.ts': 'export const SPEC_ACTIONS = [];\n' }).includes('specs'));
  // 시험 파일 자체는 서비스 검사(js)만 돈다
  const own = scopes({ 'services/admission-ctrl/test-int/queue-model.int.test.ts': '\n' });
  assert.ok(own.includes('js') && !own.includes('specs'));
});

test('V-T1 명세목록이적은_관련ADR을바꾸면_전수검사(specs_full)를고르고_다른ADR은고르지않는다', () => {
  const manifest = JSON.stringify({ specs: [{ name: 'queue', adrs: ['0056', '0002'] }] });
  const withManifest = (dir) => {
    mkdirSync(join(dir, 'specs'), { recursive: true });
    writeFileSync(join(dir, 'specs', 'specs.json'), manifest);
  };
  assert.ok(scopes({ 'docs/adr/0056-admission-leader-fencing.md': '바꿈\n' }, undefined, withManifest).includes('specs_full'));
  assert.ok(!scopes({ 'docs/adr/0099-other.md': '바꿈\n' }, undefined, withManifest).includes('specs_full'));
  // 명세 목록이 없으면 ADR로 전수 검사를 고르지 않는다(주 1회 검사가 남는다)
  assert.ok(!scopes({ 'docs/adr/0056-admission-leader-fencing.md': '바꿈\n' }).includes('specs_full'));
});

// 이미지 빌드 시험(ci.yml 잡 image → build-image.yml ①, docs/devops.md §3.1, BUILD_ORDER BSL-050): 이미지가 있는 배포 단위와
// 그 Dockerfile이 담는 패키지, 작업 공간 파일, .dockerignore, 이 워크플로와 그 스크립트가 바뀌면 이미지 셋을 푸시 없이 빌드한다
test('BSL050_범위image가_출력에있다', () => {
  const dir = repo('changes-image-');
  const base = commit(dir, { 'README.md': '처음\n' }, 'base');
  commit(dir, { 'data/m.sql': 'select 1\n' });
  const out = join(dir, 'gh-output.txt');
  const r = spawnSync(process.execPath, [script, '--base', base], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(out, 'utf8'), /^image=false$/m);
  const env = { ...process.env };
  delete env.GITHUB_OUTPUT;
  const j = spawnSync(process.execPath, [script, '--base', base], { cwd: dir, encoding: 'utf8', env });
  assert.equal(JSON.parse(j.stdout).scopes.image, false);
});

test('BSL050_이미지에드는곳·작업공간파일·이미지워크플로와스크립트를바꾸면_image를고른다', () => {
  for (const f of [
    'services/v0-monolith/src/main.ts',
    'services/v0-monolith/Dockerfile',
    'services/pg-simulator/src/server.ts',
    'services/pg-simulator/Dockerfile',
    // v0 모놀리스 이미지가 담는 결제 모듈
    'services/payment-svc/src/payment.ts',
    'services/ops-svc/Dockerfile',
    'services/ops-svc/src/main.ts',
    // 서비스 뼈대 이미지(packages/platform/template/Dockerfile)와 이미지가 담는 공용 패키지
    'packages/platform/template/Dockerfile',
    'packages/platform/src/service.ts',
    'packages/config/tsconfig/base.json',
    'packages/contracts/package.json',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.dockerignore',
    '.nvmrc',
    '.github/workflows/build-image.yml',
    'tools/ci/image-build.mjs',
    'tools/ci/image-smoke.mjs',
    'tools/ci/verify-native-binding.mjs',
    // 한 프로세스 합본 이미지(services/bundle/Dockerfile, BUILD_ORDER PRF-215)와 그것이 담는 서비스·패키지
    'services/bundle/Dockerfile',
    'services/bundle/src/bundle.ts',
    'services/queue-svc/src/main.ts',
    'services/admission-ctrl/src/start.ts',
    'services/purchase-svc/src/start.ts',
    'packages/shuffle/src/index.ts',
    // 빌드 잡의 이미지 비밀 검사(BAS-011 ②)
    'tools/ci/scan-tools.mjs',
    'tools/ci/scan-gate.mjs',
    'tools/ci/vuln-deadline.mjs',
    'tools/ci/trivy-secret.yaml',
    'tools/ci/scan-exceptions.json',
    'tools/ci/entry.mjs',
  ]) {
    assert.ok(scopes({ [f]: '바꿈\n' }).includes('image'), f);
  }
});

// 범위 전체(true·false)를 읽는다. 칸이 없으면(undefined) false와 구별된다
function scopeMap(files) {
  const dir = repo('changes-map-');
  const base = commit(dir, { 'README.md': '처음\n', 'infra/a.tf': '\n', 'packages/platform/x.ts': '\n' }, 'base');
  git(dir, 'switch', '-q', '-c', 'feature/x');
  commit(dir, files);
  const env = { ...process.env };
  delete env.GITHUB_OUTPUT;
  const r = spawnSync(process.execPath, [script, '--base', base], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).scopes;
}

test('BSL050_문서·화면·이미지없는서비스·로컬도구만바꾸면_image를고르지않는다', () => {
  for (const f of [
    'docs/devops.md',
    'docs/a.md',
    'apps/web/x',
    'apps/web/src/a.ts',
    'services/invariant-checker/x',
    'services/trust-svc/src/main.ts',
    // 이름 앞머리만 같은 다른 서비스·패키지
    'services/bundle2/x',
    'services/v0-monolith-next/x',
    'services/payment-svc2/x',
    'packages/platformx/x',
    'packages/ui/x',
    'tools/local/x',
    'tools/local/cluster.mjs',
    'infra/a.tf',
    'tools/ci/changes.test.mjs',
    'tools/ci/image-build.test.mjs',
    'tools/ci/check-workflows.mjs',
    'tools/ci/scan-tools.test.mjs',
    'tools/ci/gitleaks.toml',
    'tools/ci/codeql-config.yml',
    // 이미지 빌드 맥락이 담지 않는 뿌리 파일과 다른 워크플로, 배포 값
    'turbo.json',
    'eslint.config.mjs',
    '.github/workflows/ci-kind.yml',
    '.github/workflows/ci-node.yml',
    'deploy/envs/local/v0-monolith.yaml',
    'deploy/charts/peaket-service/values.yaml',
  ]) {
    assert.equal(scopeMap({ [f]: '바꿈\n' }).image, false, f);
  }
});

test('BSL050_v0이미지에드는서비스·로컬환경값·바인딩대조를바꾸면_kind를고른다', () => {
  for (const f of ['services/v0-monolith/x', 'services/pg-simulator/x', 'services/payment-svc/x', 'deploy/envs/local/x', 'deploy/envs/local/v0-gateway.yaml', 'tools/ci/verify-native-binding.mjs']) {
    assert.ok(scopes({ [f]: '바꿈\n' }).includes('kind'), f);
  }
  // 이미지 밖 서비스는 kind를 고르지 않는다(무거운 잡)
  assert.equal(scopes({ 'services/invariant-checker/x': '바꿈\n' }).includes('kind'), false);
});

test('BSL050_비교기준을읽지못하면_image도고른다', () => {
  assert.ok(scopes({ 'docs/a.md': '글\n' }, 'no-such-ref').includes('image'));
  assert.ok(scopes({ 'docs/a.md': '글\n' }, '0000000000000000000000000000000000000000').includes('image'));
});

// 부하 시험 점검(loadtest-check.yml, docs/verification.md §3.9, BUILD_ORDER BSL-060): 시나리오·실행 도구와, 그 시험이 견주는 것
// (서버의 조회 간격·좌석 ID, 검사기 기록 형식, 장부 요약 파일, 토큰 서명·클러스터 도구), 이 워크플로가 바뀌면 loadtest를 고른다
test('BSL060_부하시험·그시험이견주는서버·검사기·장부·로컬도구·워크플로를바꾸면_loadtest를고른다', () => {
  for (const f of [
    'loadtest/scenarios/v0-queue.js',
    'loadtest/scenarios/common.js',
    'loadtest/lib/model.mjs',
    'loadtest/runner/args.mjs',
    'loadtest/run.mjs',
    'loadtest/test/scenarios.test.mjs',
    'loadtest/README.md',
    'services/v0-monolith/src/modules/queue/domain/polling.ts',
    'services/v0-monolith/src/modules/inventory/domain/inventory.ts',
    'services/invariant-checker/src/records.ts',
    'tools/perf-ledger/k6-summary.js',
    'tools/perf-ledger/collect.py',
    // 쿠키 이름을 견주는 입구 토큰 코드와 collect.py가 쓰는 장부 라이브러리(새 맥락 리뷰 2026-11-03)
    'services/v0-monolith/src/gateway/token.ts',
    'tools/perf-ledger/ledgerlib.py',
    // IP당 한도를 견주는 입구 설정(2차 새 맥락 리뷰 2026-11-03)
    'deploy/envs/local/v0-gateway.yaml',
    'tools/local/cluster.mjs',
    'tools/local/tools.mjs',
    'tools/local/v0-token.mjs',
    '.github/workflows/loadtest-check.yml',
  ]) {
    assert.ok(scopes({ [f]: '바꿈\n' }).includes('loadtest'), f);
  }
});

test('BSL060_loadtest가함께고르는범위는_그파일의다른규칙그대로다', () => {
  // 범위 순서는 changes.mjs의 SCOPES 순서다(loadtest는 deploy 뒤, tools 앞)
  assert.deepEqual(scopes({ 'loadtest/runner/args.mjs': 'x\n' }), ['loadtest']);
  assert.deepEqual(scopes({ 'services/v0-monolith/src/modules/queue/domain/polling.ts': 'x\n' }), ['contracts', 'js', 'loadtest', 'kind', 'image']);
  assert.deepEqual(scopes({ 'services/invariant-checker/src/records.ts': 'x\n' }), ['contracts', 'js', 'loadtest']);
  assert.deepEqual(scopes({ 'tools/perf-ledger/collect.py': 'x\n' }), ['loadtest', 'tools']);
  assert.deepEqual(scopes({ 'tools/local/v0-token.mjs': 'x\n' }), ['loadtest', 'tools', 'kind']);
  assert.deepEqual(scopes({ '.github/workflows/loadtest-check.yml': 'x\n' }), ['loadtest', 'ci']);
});

test('BSL060_부하시험이견주지않는서비스·도구·이름만비슷한파일은_loadtest를고르지않는다', () => {
  for (const f of [
    'services/v0-monolith/src/main.ts',
    // 견주는 파일과 이름 앞머리만 같은 파일(경로 끝까지 맞아야 한다)
    'services/v0-monolith/src/modules/queue/domain/polling.test.ts',
    'services/v0-monolith/src/modules/queue/domain/admission.ts',
    'services/v0-monolith/src/modules/inventory/domain/inventory.test.ts',
    'services/invariant-checker/src/main.ts',
    'services/invariant-checker/src/records.test.ts',
    'tools/perf-ledger/index.py',
    'tools/perf-ledger/collect_test.py',
    'tools/local/v0-token.test.mjs',
    'tools/local/README.md',
    '.github/workflows/perf-nightly.yml',
    // 뿌리의 loadtest/만 부하 시험 폴더다
    'apps/loadtest/x.js',
    'docs/loadtest/a.md',
  ]) {
    assert.equal(scopeMap({ [f]: '바꿈\n' }).loadtest, false, f);
  }
});

test('BSL060_범위loadtest가_출력에있고_비교기준을읽지못하면_고른다', () => {
  assert.equal(scopeMap({ 'docs/a.md': '글\n' }).loadtest, false);
  assert.ok(scopes({ 'docs/a.md': '글\n' }, 'no-such-ref').includes('loadtest'));
});

// 화면 잡(ci-web.yml, docs/devops.md §3.1, BUILD_ORDER BAS-170): 화면 앱·화면용 패키지·그 검사가 읽는 정본·화면 검사 도구·워크플로·작업 공간 파일
test('BAS170_화면앱·화면용패키지·토큰과대비표·화면예산표·화면검사도구·화면워크플로·작업공간파일을바꾸면_web을고른다', () => {
  for (const f of [
    'apps/web/app/(cached)/page.tsx',
    'apps/web/queue-room/src/main.ts',
    'packages/ds/src/styles/index.css',
    'packages/config/eslint/index.mjs',
    'packages/seatmap/src/engine.ts',
    'docs/design/tokens.json',
    'docs/design/d2-design-system.md',
    'docs/frontend.md',
    'tools/web-checks/seed-css/check-css.mjs',
    'services/core-svc/test-int/fixtures/seatmap-editor/fan-file.json',
    'tools/storybook/.storybook/main.ts',
    '.github/workflows/ci-web.yml',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'package.json',
    'turbo.json',
    '.nvmrc',
  ]) {
    assert.ok(scopes({ [f]: '바꿈\n' }).includes('web'), f);
  }
});

// 구매 세션 서명기 세 엔진 검사(purchase 잡, HOT-360 ①, ADR-0221 결정 7): 서명기 원본과 서버와 같은 시험 벡터가 바뀌면 화면 잡을 돌린다
test('HOT360_구매세션서명기원본이나시험벡터를바꾸면_web을고르고_api-client의다른곳은_고르지않는다', () => {
  for (const f of ['packages/api-client/src/purchase/signer.ts', 'docs/api/vectors/purchase-request-mac.v1.json']) {
    assert.ok(scopes({ [f]: '바꿈\n' }).includes('web'), f);
  }
  assert.ok(!scopes({ 'packages/api-client/src/client.ts': '바꿈\n' }).includes('web'));
});

test('BAS170_서비스·플랫폼·다른문서·다른도구만바꾸면_web을고르지않는다', () => {
  for (const f of ['services/queue-svc/src/main.ts', 'packages/platform/x.ts', 'docs/design/d5-screen-blueprint.md', 'docs/a.md', 'tools/ci/x.mjs', 'tools/poc/login-compare/x.mjs']) {
    assert.ok(!scopes({ [f]: '바꿈\n' }).includes('web'), f);
  }
});

// 신뢰 정책 예외 검사(tools-check의 check-trust-exceptions.mjs, ADR-0191): 어느 작업 공간 파일이나 그 예외 표(devops §4.4)가 바뀌어도 돈다
test('BAS180_작업공간파일이나devops문서를바꾸면_tools를고른다', () => {
  for (const f of ['pnpm-workspace.yaml', 'tools/storybook/pnpm-workspace.yaml', 'loadtest/poc/bench/pnpm-workspace.yaml', 'docs/devops.md']) {
    assert.ok(scopes({ [f]: '바꿈\n' }).includes('tools'), f);
  }
  for (const f of ['docs/a.md', 'packages/ds/src/x.ts']) {
    assert.ok(!scopes({ [f]: '바꿈\n' }).includes('tools'), f);
  }
});

test('BAS170_비교기준을읽지못하면_web도고른다', () => {
  assert.ok(scopes({ 'docs/a.md': '글\n' }, 'no-such-ref').includes('web'));
});

// v1 경로(BUILD_ORDER PRF-215, 코드 리뷰): loadtest 시험이 견주는 v1 무대 도구(키·환경 파일·객체)와 구매 요청 서명 시험 벡터가 바뀌어도 loadtest를 고른다
test('PRF215_코드리뷰_v1무대도구와_구매요청서명벡터를바꾸면_loadtest를고르고_이름만비슷한파일은_고르지않는다', () => {
  for (const f of ['tools/local/v1-stage.mjs', 'tools/local/v1-objects.mjs', 'docs/api/vectors/purchase-request-mac.v1.json']) assert.ok(scopes({ [f]: 'x\n' }).includes('loadtest'), f);
  for (const f of ['tools/local/v1-stage.test.mjs', 'docs/api/vectors/purchase-request-mac.v2.json', 'docs/api/vectors/other.v1.json']) assert.ok(!scopes({ [f]: 'x\n' }).includes('loadtest'), f);
});
