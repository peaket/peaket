// 배포 상태 정적 검사(tools/ci/gitops-check.mjs) 시험(GV-01·GV-04~06, D-T28·D-T32 ③·D-T33 ①·②, ADR-0319, BAT-085).
// 실제 저장소의 오버레이·정책 원천·메시 바탕을 읽되, 값은 정본(docs/devops.md §4.3·§5.1, 계획 BAT-085 §6)에서 시험이 스스로 적는다.
// Helm은 부르지 않는다: 환경 값이 없는 실제 저장소는 합친 배포 값으로 검사하고, 환경 값 픽스처는 run을 흉내 내 Helm 없음(ENOENT)을 본다.
// 실행: node --test tools/ci/gitops-check.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import { tempDir } from './git-fixture.mjs';
import {
  FORBIDDEN_GRPC_LB_PROFILE,
  MESH_NAMESPACES,
  checkDigests,
  checkMeshRequired,
  checkRegistry,
  envOfValues,
  imageOfValues,
  mergeValues,
  parseImageArg,
  readEnvValues,
  registryAllowlist,
  renderOverlay,
  verifyPromotions,
} from './gitops-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const SCRIPT = join(HERE, 'gitops-check.mjs');
const MESH = join(REPO, 'deploy', 'platform', 'mesh');
const DIGEST = `sha256:${'b'.repeat(64)}`;
const ECR_ACCOUNT = '000000000000';
const ECR_PREFIX = `${ECR_ACCOUNT}.dkr.ecr.ap-northeast-2.amazonaws.com/`;

const clone = (v) => JSON.parse(JSON.stringify(v));
const realObjects = () => [
  ...parseAllDocuments(readFileSync(join(MESH, 'namespaces.yaml'), 'utf8')).map((d) => d.toJS()).filter(Boolean),
  ...parseAllDocuments(readFileSync(join(MESH, 'peer-authentication.yaml'), 'utf8')).map((d) => d.toJS()).filter(Boolean),
];
const findNs = (objects, name) => objects.find((o) => o.kind === 'Namespace' && o.metadata?.name === name);
const findPeer = (objects) => objects.find((o) => o.kind === 'PeerAuthentication');
const deployment = (envs, name = 'queue-svc') => ({
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name },
  spec: { template: { spec: { containers: [{ name: 'app', env: envs }] } } },
});

/** 시험용 저장소 뿌리: 메시 바탕·배포 단위 값·(있으면) 환경 값을 갖춘다 */
function fixtureRoot({ workloads = {}, envs = {} } = {}) {
  const dir = tempDir('gitops-check-');
  mkdirSync(join(dir, 'deploy', 'platform', 'mesh'), { recursive: true });
  for (const f of ['namespaces.yaml', 'peer-authentication.yaml']) writeFileSync(join(dir, 'deploy', 'platform', 'mesh', f), readFileSync(join(MESH, f), 'utf8'));
  mkdirSync(join(dir, 'deploy', 'policies', 'kyverno'), { recursive: true });
  writeFileSync(join(dir, 'deploy', 'policies', 'kyverno', 'policy-values.yaml'), readFileSync(join(REPO, 'deploy', 'policies', 'kyverno', 'policy-values.yaml'), 'utf8'));
  for (const [name, value] of Object.entries(workloads)) {
    mkdirSync(join(dir, 'deploy', 'workloads', name), { recursive: true });
    writeFileSync(join(dir, 'deploy', 'workloads', name, 'values.yaml'), value);
  }
  for (const [name, value] of Object.entries(envs)) {
    mkdirSync(join(dir, 'deploy', 'envs', 'prod'), { recursive: true });
    writeFileSync(join(dir, 'deploy', 'envs', 'prod', `${name}.yaml`), value);
  }
  return dir;
}
const noHelm = () => {
  const e = new Error('spawn helm ENOENT');
  e.code = 'ENOENT';
  throw e;
};
const cli = (args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

// ===================== GV-01 D-T28: 운영 오버레이 메시 필수 =====================

test('GV-01 D-T28 실제 운영 오버레이는 앰비언트 라벨 값·STRICT PeerAuthentication 하나·headless-round-robin 없음으로 통과한다', () => {
  const overlay = renderOverlay(REPO, 'prod');
  assert.deepEqual(overlay.problems, []);
  const r = checkMeshRequired({ objects: overlay.objects, env: 'prod' });
  assert.equal(r.checked, true);
  assert.deepEqual(r.problems, []);
  // 서비스·애드온 네임스페이스가 모두 검사 대상이다(넓은 kube-* 제외가 아니다)
  for (const name of MESH_NAMESPACES) assert.ok(findNs(overlay.objects, name), name);
  for (const system of ['kube-system', 'kyverno', 'kube-node-lease', 'kube-public']) assert.equal(findNs(overlay.objects, system)?.metadata?.labels?.['istio.io/dataplane-mode'], undefined, system);
});

test('GV-01 D-T28 local·demo는 메시 없이 도는 환경이라 검사를 받지 않고 통과한다', () => {
  for (const env of ['local', 'ci', 'demo']) {
    const r = checkMeshRequired({ objects: realObjects(), env });
    assert.equal(r.checked, false, env);
    assert.deepEqual(r.problems, [], env);
    assert.match(r.reason, /메시 없이/);
  }
});

test('GV-01 D-T28 네임스페이스가 빠지거나 앰비언트 라벨이 없거나 값이 ambient가 아니면 실패한다', () => {
  const missing = realObjects().filter((o) => o.metadata?.name !== 'queue');
  assert.ok(checkMeshRequired({ objects: missing, env: 'prod' }).problems.some((p) => p.includes('queue')));
  for (const labels of [undefined, {}, { 'istio.io/dataplane-mode': 'sidecar' }, { 'istio.io/dataplane-mode': '' }]) {
    const objects = realObjects();
    const ns = findNs(objects, 'purchase');
    if (labels === undefined) delete ns.metadata.labels;
    else ns.metadata.labels = labels;
    const problems = checkMeshRequired({ objects, env: 'prod' }).problems;
    assert.ok(problems.some((p) => p.includes('purchase')), `${JSON.stringify(labels)}: ${problems.join(' / ')}`);
  }
});

test('GV-01 D-T28 PeerAuthentication은 istio-system/default STRICT 하나뿐이고 다른 것·selector·portLevelMtls가 있으면 실패한다', () => {
  const noPeer = realObjects().filter((o) => o.kind !== 'PeerAuthentication');
  assert.ok(checkMeshRequired({ objects: noPeer, env: 'prod' }).problems.some((p) => p.includes('PeerAuthentication이 하나가 아니다')));
  const two = realObjects();
  two.push({ apiVersion: 'security.istio.io/v1', kind: 'PeerAuthentication', metadata: { name: 'default', namespace: 'queue' }, spec: { mtls: { mode: 'STRICT' } } });
  assert.ok(checkMeshRequired({ objects: two, env: 'prod' }).problems.some((p) => p.includes('하나가 아니다')));
  for (const [what, mutate] of [
    ['mode PERMISSIVE', (p) => (p.spec.mtls.mode = 'PERMISSIVE')],
    ['mode 없음', (p) => delete p.spec.mtls],
    ['selector', (p) => (p.spec.selector = { matchLabels: { app: 'x' } })],
    ['portLevelMtls', (p) => (p.spec.portLevelMtls = { 8080: { mode: 'PERMISSIVE' } })],
    ['다른 이름', (p) => (p.metadata.name = 'queue-default')],
    ['다른 네임스페이스', (p) => (p.metadata.namespace = 'queue')],
  ]) {
    const objects = realObjects();
    mutate(findPeer(objects));
    const problems = checkMeshRequired({ objects, env: 'prod' }).problems;
    assert.ok(problems.length > 0, `${what}: 통과했다`);
  }
});

test('GV-01 D-T28 어떤 파드 env에도 PEAKET_GRPC_LB_PROFILE=headless-round-robin이 없어야 한다(다른 값은 된다)', () => {
  const objects = realObjects();
  objects.push(deployment([{ name: 'PEAKET_GRPC_LB_PROFILE', value: FORBIDDEN_GRPC_LB_PROFILE }]));
  assert.ok(checkMeshRequired({ objects, env: 'prod' }).problems.some((p) => p.includes('headless-round-robin')));
  // initContainer·ephemeralContainer도 본다
  for (const key of ['initContainers', 'ephemeralContainers']) {
    const o = deployment([]);
    o.spec.template.spec[key] = [{ name: key, env: [{ name: 'PEAKET_GRPC_LB_PROFILE', value: FORBIDDEN_GRPC_LB_PROFILE }] }];
    const list = realObjects();
    list.push(o);
    assert.ok(checkMeshRequired({ objects: list, env: 'prod' }).problems.some((p) => p.includes('headless-round-robin')), key);
  }
  const ok = realObjects();
  ok.push(deployment([{ name: 'PEAKET_GRPC_LB_PROFILE', value: 'round-robin' }]));
  assert.deepEqual(checkMeshRequired({ objects: ok, env: 'prod' }).problems, []);
});

// ===================== GV-05·GV-06 D-T33: 환경별 허용 레지스트리 =====================

test('GV-05 D-T33 ① 데모 허용 레지스트리는 ghcr.io/peaket/이고 그 접두사 안의 다이제스트 이미지는 통과한다', () => {
  const allow = registryAllowlist(REPO, 'demo');
  assert.deepEqual(allow.problems, []);
  assert.deepEqual(allow.registries, ['ghcr.io/peaket/']);
  assert.deepEqual(checkRegistry([{ name: 'queue-svc', reference: `ghcr.io/peaket/queue-svc@${DIGEST}` }], allow.registries), []);
  // 로컬·CI도 데모의 허용 목록(GHCR)을 쓴다
  for (const env of ['local', 'ci']) assert.deepEqual(registryAllowlist(REPO, env).registries, ['ghcr.io/peaket/'], env);
  // imagePullSecrets 없이 다이제스트로 참조한다(정적 단언은 정책 시험이 본다)
  assert.equal(`ghcr.io/peaket/queue-svc@${DIGEST}`.includes('@sha256:'), true);
});

test('GV-06 D-T33 ② 운영 허용 레지스트리는 PEAKET ECR 계정 하나이고 GHCR·다른 계정 ECR은 거부한다', () => {
  const allow = registryAllowlist(REPO, 'prod');
  assert.deepEqual(allow.problems, []);
  assert.deepEqual(allow.registries, [ECR_PREFIX]);
  assert.equal(allow.registries[0].includes('{ecr}'), false);
  assert.equal(allow.registries[0].includes('<'), false);
  assert.deepEqual(checkRegistry([{ name: 'queue-svc', reference: `${ECR_PREFIX}queue-svc@${DIGEST}` }], allow.registries), []);
  const denied = [
    `ghcr.io/peaket/queue-svc@${DIGEST}`,
    `ghcr.io/peaket-evil/queue-svc@${DIGEST}`,
    `999999999999.dkr.ecr.ap-northeast-2.amazonaws.com/queue-svc@${DIGEST}`,
    `000000000000.dkr.ecr.us-east-1.amazonaws.com/queue-svc@${DIGEST}`,
    `docker.io/peaket/queue-svc@${DIGEST}`,
  ];
  for (const reference of denied) {
    const problems = checkRegistry([{ name: 'queue-svc', reference }], allow.registries);
    assert.equal(problems.length, 1, `${reference}: ${problems.join(' / ') || '통과했다'}`);
    assert.match(problems[0], /허용 레지스트리/);
  }
  // 접두사 경계: ghcr.io/peaket/는 ghcr.io/peaket-evil/을 받지 않는다
  const demo = registryAllowlist(REPO, 'demo').registries;
  assert.equal(checkRegistry([{ name: 'evil', reference: `ghcr.io/peaket-evil/queue-svc@${DIGEST}` }], demo).length, 1);
  assert.equal(checkRegistry([{ name: 'ok', reference: `ghcr.io/peaket/queue-svc@${DIGEST}` }], demo).length, 0);
});

test('GV-06 D-T33 ② 허용 레지스트리 목록이 비면 이미지가 없어도 실패로 본다(조용한 통과 금지)', () => {
  assert.deepEqual(checkRegistry([], ['ghcr.io/peaket/']), []);
  assert.equal(checkRegistry([], []).length, 1);
});

// ===================== GV-04 D-T32 ③: 승격 값의 다이제스트·서명 =====================

test('GV-04 D-T32 ③ env 값은 image.digest로만 고정한다: tag·짧은 다이제스트·repository 없음은 실패한다', () => {
  const tagOnly = { file: 'deploy/envs/prod/queue-svc.yaml', values: { image: { repository: `${ECR_PREFIX}queue-svc`, tag: '1.5.0' } } };
  const problems = checkDigests([tagOnly]);
  assert.ok(problems.some((p) => p.includes('image.tag')), problems.join(' / '));
  assert.ok(problems.some((p) => p.includes('다이제스트')), problems.join(' / '));
  assert.ok(checkDigests([{ file: 'x.yaml', values: { image: { repository: `${ECR_PREFIX}queue-svc`, digest: 'sha256:abc' } } }]).some((p) => p.includes('다이제스트')));
  assert.ok(checkDigests([{ file: 'x.yaml', values: { image: { digest: DIGEST } } }]).some((p) => p.includes('repository')));
  assert.deepEqual(checkDigests([{ file: 'x.yaml', values: { image: { repository: `${ECR_PREFIX}queue-svc`, digest: DIGEST } } }]), []);
  // image가 없는 값 파일(예: 설정만 있는 파일)은 검사할 것이 없다
  assert.deepEqual(checkDigests([{ file: 'x.yaml', values: { name: 'x' } }]), []);
});

test('GV-04 D-T32 ③ imageOfValues는 다이제스트를 태그보다 먼저 고르고, 환경 덧씌우기는 깊게 합친다', () => {
  assert.deepEqual(imageOfValues('queue-svc', { image: { repository: 'r', digest: DIGEST, tag: 't' } }), { name: 'queue-svc', repository: 'r', digest: DIGEST, reference: `r@${DIGEST}` });
  assert.deepEqual(imageOfValues('queue-svc', { image: { repository: 'r', tag: 't' } }), { name: 'queue-svc', repository: 'r', tag: 't', reference: 'r:t' });
  assert.equal(imageOfValues('queue-svc', { image: { repository: '' } }), undefined);
  assert.equal(imageOfValues('queue-svc', {}), undefined);
  assert.deepEqual(mergeValues({ a: { b: 1, c: [1] }, d: 1 }, { a: { c: [2] }, d: 2 }), { a: { b: 1, c: [2] }, d: 2 });
  assert.deepEqual(envOfValues({ env: { A: '1' }, service: { env: { B: '2' } }, outboxRelay: { env: { C: '3', A: 'x' } } }), { A: 'x', B: '2', C: '3' });
});

test('GV-04 D-T32 ③ 승격 값의 서명·출처 검증은 다이제스트 참조로 cosign을 부르고, 증명이 정본과 다르면 실패한다', () => {
  const file = 'deploy/envs/prod/queue-svc.yaml';
  const values = { name: 'queue-svc', image: { repository: `${ECR_PREFIX}queue-svc`, digest: DIGEST } };
  const calls = [];
  const pass = readFileSync(join(HERE, 'fixtures', 'slsa-provenance-pass.json'), 'utf8');
  const run = (_cmd, args) => {
    calls.push(args);
    return args[0] === 'verify-attestation' ? pass : '';
  };
  assert.deepEqual(verifyPromotions([{ file, name: 'queue-svc', values }], { run }), { problems: [], skip: [] });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'verify');
  assert.equal(calls[0].at(-1), `${ECR_PREFIX}queue-svc@${DIGEST}`);
  assert.equal(calls[1][0], 'verify-attestation');
  assert.equal(calls[1].at(-1), `${ECR_PREFIX}queue-svc@${DIGEST}`);
  // develop 증명이면 실패한다
  const develop = readFileSync(join(HERE, 'fixtures', 'slsa-provenance-develop.json'), 'utf8');
  const bad = verifyPromotions([{ file, name: 'queue-svc', values }], { run: (_c, args) => (args[0] === 'verify-attestation' ? develop : '') });
  assert.ok(bad.problems.some((p) => p.includes('workflow.ref')), bad.problems.join(' / '));
  // 다이제스트가 없으면 cosign을 부르지 않고 까닭을 남긴다(조용한 통과가 아니다)
  const skipped = verifyPromotions([{ file, name: 'queue-svc', values: { image: { repository: 'r', tag: 't' } } }], { run: () => assert.fail('cosign을 불렀다') });
  assert.equal(skipped.problems.length, 0);
  assert.equal(skipped.skip.length, 1);
  assert.match(skipped.skip[0], /다이제스트가 없어/);
});

test('GV-04 D-T32 ③ renderOverlay는 환경 값이 있으면 배포 단위 값과 합성 객체를 만들고, Helm이 없으면 까닭을 남기고 계속한다', () => {
  const dir = fixtureRoot({
    workloads: { 'queue-svc': 'name: queue-svc\nenv:\n  PEAKET_ENV: prod\n' },
    envs: { 'queue-svc': `name: queue-svc\nnamespace: queue\nimage:\n  repository: ${ECR_PREFIX}queue-svc\n  digest: ${DIGEST}\nenv:\n  PEAKET_ENV: prod\n` },
  });
  const overlay = renderOverlay(dir, 'prod', { helm: 'helm', run: noHelm });
  assert.deepEqual(overlay.problems, []);
  assert.equal(overlay.helmUsed, false);
  assert.match(overlay.helmSkip, /Helm을 찾지 못했다/);
  assert.equal(overlay.envs.length, 1);
  const synthetic = overlay.objects.find((o) => o.kind === 'Deployment' && o.metadata?.name === 'queue-svc');
  assert.ok(synthetic, '합친 배포 값 객체가 없다');
  assert.deepEqual(synthetic.spec.template.spec.containers[0].env, [{ name: 'PEAKET_ENV', value: 'prod' }]);
  assert.deepEqual(overlay.images, [{ name: 'queue-svc', repository: `${ECR_PREFIX}queue-svc`, digest: DIGEST, reference: `${ECR_PREFIX}queue-svc@${DIGEST}` }]);
});

test('GV-04 D-T32 ③ renderOverlay는 배포 단위 값이 없는 환경 값·Helm 실행 실패를 문제로 남긴다', () => {
  const missingBase = fixtureRoot({ envs: { 'no-svc': 'name: no-svc\n' } });
  assert.ok(renderOverlay(missingBase, 'prod', { helm: 'helm', run: noHelm }).problems.some((p) => p.includes('배포 단위 값')));
  const dir = fixtureRoot({ workloads: { 'queue-svc': 'name: queue-svc\n' }, envs: { 'queue-svc': 'name: queue-svc\n' } });
  const failed = renderOverlay(dir, 'prod', {
    helm: 'helm',
    run: () => {
      const e = new Error('helm template 실패');
      e.stderr = 'Error: template: bad';
      throw e;
    },
  });
  assert.ok(failed.problems.some((p) => p.includes('Helm 렌더가 실패했다')));
});

test('GV-04 D-T32 ③ readEnvValues는 README·비 YAML을 읽지 않고 name이 없으면 파일 이름을 쓴다', () => {
  const dir = fixtureRoot({ envs: { 'queue-svc': `image:\n  repository: ${ECR_PREFIX}queue-svc\n  digest: ${DIGEST}\n` } });
  writeFileSync(join(dir, 'deploy', 'envs', 'prod', 'README.md'), '설명\n');
  const r = readEnvValues(dir, 'prod');
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].name, 'queue-svc');
  assert.equal(r.files[0].file, 'deploy/envs/prod/queue-svc.yaml');
  // 폴더가 없으면 오류가 아니라 빈 목록이다(아직 승격 없음)
  assert.deepEqual(readEnvValues(dir, 'staging'), { files: [], problems: [] });
});

test('GV-04 D-T32 ③ 명령줄: env 값이 없으면 사유를 남긴 skip으로 성공하고, 값 파일이 생기면 digest 검사가 실패한다', () => {
  const dir = fixtureRoot({ workloads: { 'queue-svc': 'name: queue-svc\nenv:\n  PEAKET_ENV: prod\n' } });
  const empty = cli(['--check', '--root', dir, '--env', 'prod']);
  assert.equal(empty.code, 0, empty.out);
  assert.match(empty.out, /skip digest: 아직 승격 없음/);
  assert.match(empty.out, /skip signature: 아직 승격 없음/);
  assert.match(empty.out, /통과/);
  // 값 파일이 있는데 digest가 없으면 실패한다(조용한 통과가 아니다)
  mkdirSync(join(dir, 'deploy', 'envs', 'prod'), { recursive: true });
  writeFileSync(join(dir, 'deploy', 'envs', 'prod', 'queue-svc.yaml'), `name: queue-svc\nimage:\n  repository: ${ECR_PREFIX}queue-svc\n  tag: 1.5.0\n`);
  const bad = cli(['--check', '--root', dir, '--env', 'prod']);
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /fail digest/);
  assert.match(bad.out, /image\.tag/);
});

test('GV-04 D-T32 ③ 명령줄: --image는 이름=저장소@sha256:<64자리>만 받고 인자 오류는 2다', () => {
  // 실제 저장소는 아직 env 값이 없어 skip이지만 --image가 있으면 D-T33·digest를 검사한다
  const ok = cli(['--check', '--root', REPO, '--env', 'prod', '--image', `queue-svc=${ECR_PREFIX}queue-svc@${DIGEST}`]);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /ok D-T33/);
  assert.match(ok.out, /ok digest/);
  const ghcr = cli(['--check', '--root', REPO, '--env', 'prod', '--image', `queue-svc=ghcr.io/peaket/queue-svc@${DIGEST}`]);
  assert.equal(ghcr.code, 1, ghcr.out);
  assert.match(ghcr.out, /fail D-T33/);
  assert.equal(cli(['--check', '--root', REPO, '--image', 'queue-svc=ghcr.io/peaket/queue-svc:1.5.0']).code, 2);
  assert.equal(cli(['--check', '--root', REPO, '--env', 'nope']).code, 2);
  assert.equal(cli(['--check', '--root']).code, 2);
  assert.deepEqual(parseImageArg(`queue-svc=${ECR_PREFIX}queue-svc@${DIGEST}`), { name: 'queue-svc', repository: `${ECR_PREFIX}queue-svc`, digest: DIGEST, reference: `${ECR_PREFIX}queue-svc@${DIGEST}` });
  assert.equal(parseImageArg(`queue-svc=${ECR_PREFIX}queue-svc@${DIGEST}`).problem, undefined);
  assert.equal(parseImageArg('queue-svc=ghcr.io/peaket/queue-svc:latest').problem !== undefined, true);
  assert.equal(parseImageArg('queue-svc=ghcr.io/peaket/queue-svc@sha256:abc').problem !== undefined, true);
});

// ===================== main의 실제 저장소 검사 =====================

test('GV-04 실제 저장소의 prod·staging·demo 검사는 통과하고(아직 승격 없음 skip 포함), local·ci는 승격 경로가 아니라 검사 대상이 아니다', () => {
  for (const env of ['prod', 'staging', 'demo']) {
    const r = cli(['--check', '--root', REPO, '--env', env]);
    assert.equal(r.code, 0, `${env}: ${r.out}`);
    assert.doesNotMatch(r.out, /^fail /m, `${env}: ${r.out}`);
  }
  // local 값은 로컬 kind용 태그(예: peaket/bundle:local)이고 아직 승격 값이 아니다. 기본 검사(prod)가 그것을 실패로 보지 않는다
  const prod = cli(['--check', '--root', REPO]);
  assert.equal(prod.code, 0, prod.out);
  assert.match(prod.out, /환경 prod/);
});
