// Kyverno 정책 생성기(tools/ci/kyverno-policies.mjs) 시험(KV-04, ADR-0318·ADR-0285 결정 2, BAT-085).
// 값 검증(환경 누락·미해결 자리 표시·접두사 경계·글롭·시스템 네임스페이스)과 생성 대조(같은 입력 두 번 = 같은 바이트, 손 고침 거부)를 본다.
// 실제 저장소의 원천은 읽되, 고친 값은 임시 폴더에서만 만든다. 실행: node --test tools/ci/kyverno-policies.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { tempDir } from './git-fixture.mjs';
import { ENVS, ENV_ROOT, POLICY_NAMES, SOURCE_FILE, checkValues, generate, generateFromRoot, main, normalizeAccount, policiesFor } from './kyverno-policies.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const SCRIPT = join(HERE, 'kyverno-policies.mjs');
const SOURCE = readFileSync(join(REPO, SOURCE_FILE), 'utf8');
const ACCOUNT = '000000000000';
const ECR = `${ACCOUNT}.dkr.ecr.ap-northeast-2.amazonaws.com/`;

/** 시험용 저장소 뿌리(원천 하나). 원천을 고쳐 넣을 수 있다 */
function rootWith(source = SOURCE) {
  const dir = tempDir('kyverno-policies-');
  mkdirSync(join(dir, dirname(SOURCE_FILE)), { recursive: true });
  writeFileSync(join(dir, SOURCE_FILE), source);
  return dir;
}
/** YAML을 고친 원천 글 */
function withSource(change) {
  const raw = parse(SOURCE);
  change(raw);
  return stringify(raw);
}
const cli = (args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const problemsOf = (source) => checkValues(parse(source)).problems;

// ===================== KV-04: 값 검증 =====================

test('KV-04 실제 원천 값은 검사를 통과하고 ECR 계정을 12자리로 풀어 넣는다', () => {
  const r = checkValues(parse(SOURCE));
  assert.deepEqual(r.problems, []);
  assert.equal(normalizeAccount('0000-0000-0000'), ACCOUNT);
  assert.deepEqual(r.values.environments.demo.registries, ['ghcr.io/peaket/']);
  assert.deepEqual(r.values.environments.staging.registries, [ECR]);
  assert.deepEqual(r.values.environments.prod.registries, [ECR]);
  assert.deepEqual(r.values.namespaces, ['queue', 'purchase', 'ticket', 'trust', 'core', 'web', 'platform', 'ops-breakglass']);
  assert.deepEqual(Object.keys(r.values.environments).sort(), [...ENVS].sort());
});

test('KV-04 환경이 빠지거나 모르는 환경이면 거부한다', () => {
  for (const env of ENVS) {
    const problems = problemsOf(withSource((raw) => delete raw.environments[env]));
    assert.ok(problems.some((p) => p.includes(`environments.${env}`) && p.includes('빠졌다')), `${env}: ${problems.join(' / ')}`);
  }
  assert.ok(problemsOf(withSource((raw) => (raw.environments.qa = { mode: 'Audit', failurePolicy: 'Ignore', registries: ['ghcr.io/peaket/'] }))).some((p) => p.includes('모르는 환경')));
});

test('KV-04 모드·failurePolicy: 데모는 Audit/Ignore, 스테이징·운영은 Deny/Fail만 받는다', () => {
  for (const env of ENVS) {
    const want = env === 'demo' ? { mode: 'Audit', failurePolicy: 'Ignore' } : { mode: 'Deny', failurePolicy: 'Fail' };
    const wrongMode = env === 'demo' ? 'Deny' : 'Audit';
    const wrongPolicy = env === 'demo' ? 'Fail' : 'Ignore';
    assert.ok(problemsOf(withSource((raw) => (raw.environments[env].mode = wrongMode))).some((p) => p.includes(`environments.${env}.mode`)), `${env} mode`);
    assert.ok(problemsOf(withSource((raw) => (raw.environments[env].failurePolicy = wrongPolicy))).some((p) => p.includes(`environments.${env}.failurePolicy`)), `${env} failurePolicy`);
    assert.equal(want.mode === 'Audit', env === 'demo');
  }
});

test('KV-04 미해결 자리 표시(<ECR_ACCOUNT>·{ecr}가 남은 꺾쇠·모르는 계정)는 거부한다', () => {
  for (const account of ['<ECR_ACCOUNT>', '', '0000-0000', '0000000000000', '00000000000a']) {
    const problems = problemsOf(withSource((raw) => (raw.ecr.account = account)));
    assert.ok(problems.some((p) => p.includes('ecr.account')), `${account}: ${problems.join(' / ')}`);
  }
  // 환경 레지스트리에 꺾쇠가 남아도 된다
  const bracket = withSource((raw) => (raw.environments.prod.registries = ['<ECR_ACCOUNT>.dkr.ecr.ap-northeast-2.amazonaws.com/']));
  assert.ok(problemsOf(bracket).some((p) => p.includes('미해결 자리 표시')), problemsOf(bracket).join(' / '));
  // 모르는 ECR 계정(다른 계정 고정)은 D-T33 ② 위반이다
  const other = withSource((raw) => (raw.environments.prod.registries = ['999999999999.dkr.ecr.ap-northeast-2.amazonaws.com/']));
  assert.ok(problemsOf(other).some((p) => p.includes('ECR 허용 레지스트리')), problemsOf(other).join(' / '));
});

test('KV-04 레지스트리 접두사 경계: 끝의 /가 없거나 글롭·http·공백이 있으면 거부한다', () => {
  for (const registries of [
    ['ghcr.io/peaket'],
    ['ghcr.io/peaket/*'],
    ['https://ghcr.io/peaket/'],
    ['ghcr.io/peaket/ '],
    ['ghcr.io/peaket-evil/'],
    [],
  ]) {
    const problems = problemsOf(withSource((raw) => (raw.environments.demo.registries = registries)));
    assert.ok(problems.length > 0, `${JSON.stringify(registries)}: 통과했다`);
  }
  // 데모는 GHCR만, 스테이징·운영은 ECR 하나만 받는다
  assert.ok(problemsOf(withSource((raw) => (raw.environments.demo.registries = [ECR]))).some((p) => p.includes('ghcr.io/peaket/')));
  assert.ok(problemsOf(withSource((raw) => (raw.environments.staging.registries = ['ghcr.io/peaket/']))).some((p) => p.includes('ECR 허용 레지스트리')));
  assert.ok(problemsOf(withSource((raw) => (raw.environments.prod.registries = [ECR, 'ghcr.io/peaket/']))).some((p) => p.includes('하나다')));
});

test('KV-04 시스템 네임스페이스 혼입·중복·모르는 칸·목록 아님은 거부한다', () => {
  assert.ok(problemsOf(withSource((raw) => raw.namespaces.push('kube-system'))).some((p) => p.includes('시스템 네임스페이스')));
  assert.ok(problemsOf(withSource((raw) => raw.namespaces.push('queue'))).some((p) => p.includes('두 번')));
  assert.ok(problemsOf(withSource((raw) => (raw.extra = 1))).some((p) => p.includes('모르는 칸')));
  assert.ok(problemsOf(withSource((raw) => (raw.environments.demo.mode = 'audit'))).some((p) => p.includes('Audit')));
  assert.ok(problemsOf(withSource((raw) => (raw.namespaces = 'queue'))).some((p) => p.includes('목록이 아니다')));
  assert.ok(problemsOf(withSource((raw) => (raw.demoImages = ['pg-simulator', 'pg-simulator']))).some((p) => p.includes('두 번')));
  assert.ok(problemsOf(withSource((raw) => (raw.image.runnerEnvironment = 'self-hosted'))).some((p) => p.includes('github-hosted')));
  assert.ok(problemsOf(withSource((raw) => (raw.image.workflowRefs = ['refs/heads/develop']))).some((p) => p.includes('workflowRefs')));
  assert.ok(problemsOf(withSource((raw) => (raw.ecr.region = 'ap-northeast-2-evil'))).some((p) => p.includes('ecr.region')));
});

test('KV-04 같은 입력을 두 번 만들면 같은 바이트이고, 세 환경의 정책은 정해진 이름·종류이며 라벨이 같다', () => {
  const checked = checkValues(parse(SOURCE));
  const one = generate(parse(SOURCE));
  const two = generate(parse(SOURCE));
  assert.deepEqual(one.problems, []);
  assert.deepEqual([...one.files.keys()], [...two.files.keys()]);
  for (const [file, text] of one.files) assert.equal(two.files.get(file), text, file);
  assert.deepEqual([...one.files.keys()].sort(), ENVS.map((env) => `${ENV_ROOT}/${env}/policies.yaml`).sort());
  for (const env of ENVS) {
    const docs = policiesFor(checked.values, env);
    assert.deepEqual(docs.map((d) => d.metadata.name), [POLICY_NAMES.image, POLICY_NAMES.registry, POLICY_NAMES.pod, POLICY_NAMES.placement]);
    assert.deepEqual(docs.map((d) => d.kind), ['ImageValidatingPolicy', 'ValidatingPolicy', 'ValidatingPolicy', 'ValidatingPolicy']);
    for (const d of docs) {
      assert.equal(d.apiVersion, 'policies.kyverno.io/v1');
      assert.equal(d.metadata.labels['peaket.io/generated-by'], 'kyverno-policies');
      assert.equal(d.metadata.labels['peaket.io/environment'], env);
    }
  }
});

// ===================== KV-04: 생성기 CLI =====================

test('KV-04 --write 뒤 --check는 0이고, 손 고침·원천 없음·인자 오류는 까닭과 함께 1·2다', () => {
  const dir = rootWith();
  assert.equal(main(['--write', '--root', dir]), 0);
  for (const env of ENVS) assert.ok(existsSync(join(dir, ENV_ROOT, env, 'policies.yaml')), env);
  assert.equal(main(['--check', '--root', dir]), 0);
  // 같은 원천으로 다시 쓰면 바이트가 같다
  const first = ENVS.map((env) => readFileSync(join(dir, ENV_ROOT, env, 'policies.yaml'), 'utf8'));
  assert.equal(main(['--write', '--root', dir]), 0);
  assert.deepEqual(ENVS.map((env) => readFileSync(join(dir, ENV_ROOT, env, 'policies.yaml'), 'utf8')), first);
  // 손 고침
  const file = join(dir, ENV_ROOT, 'prod', 'policies.yaml');
  writeFileSync(file, readFileSync(file, 'utf8').replace('- Deny', '- Audit'));
  const edited = cli(['--check', '--root', dir]);
  assert.equal(edited.code, 1, edited.out);
  assert.match(edited.out, /손으로 고치지 않고/);
  assert.match(edited.out, /줄 \d+/);
  // 원천이 없으면 1
  const empty = tempDir('kyverno-policies-empty-');
  const none = cli(['--check', '--root', empty]);
  assert.equal(none.code, 1, none.out);
  assert.match(none.out, /원천 파일이 없다/);
  // 인자 오류
  assert.equal(cli([]).code, 2);
  assert.equal(cli(['--check', '--write']).code, 2);
  assert.equal(cli(['--check', '--root']).code, 2);
  assert.equal(cli(['--nope']).code, 2);
});

test('KV-04 값이 틀리면 --write도 생성 파일을 하나도 쓰지 않는다', () => {
  const dir = rootWith(withSource((raw) => (raw.ecr.account = '<ECR_ACCOUNT>')));
  const r = cli(['--write', '--root', dir]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ecr\.account/);
  for (const env of ENVS) assert.equal(existsSync(join(dir, ENV_ROOT, env, 'policies.yaml')), false, env);
  const checked = generateFromRoot(dir);
  assert.ok(checked.problems.length > 0);
  assert.equal(checked.files.size, 0);
});

test('KV-04 손 고침·빠진 환경·접두사 경계는 CLI가 1로 끝나고 까닭을 찍는다', () => {
  for (const [what, source, pattern] of [
    ['빠진 환경', withSource((raw) => delete raw.environments.staging), /environments\.staging/],
    ['접두사 / 없음', withSource((raw) => (raw.environments.demo.registries = ['ghcr.io/peaket'])), /접두사/],
    ['글롭', withSource((raw) => (raw.environments.demo.registries = ['ghcr.io/peaket/*'])), /글롭/],
    ['시스템 네임스페이스', withSource((raw) => raw.namespaces.push('kube-system')), /시스템 네임스페이스/],
  ]) {
    const dir = rootWith(source);
    const r = cli(['--check', '--root', dir]);
    assert.equal(r.code, 1, `${what}: ${r.out}`);
    assert.match(r.out, pattern, what);
    assert.match(r.out, /원천 값 오류/, what);
  }
});
