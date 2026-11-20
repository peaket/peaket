// Kyverno CEL 정책의 정적 시험(KV-01·KV-04~07, D-T11 ①·D-T18 ②·D-T28·D-T33, ADR-0318, BAT-085).
// 생성 파일(deploy/policies/kyverno/envs/<환경>/policies.yaml)과 설치 값(deploy/platform/kyverno/values.yaml)을 읽고,
// 정본(docs/devops.md §4.2·§4.3, 계획 BAT-085 §6·§12)의 값과 견준다. 원천(policy-values.yaml)에서 기대값을 만들지 않는다.
// 차트 렌더는 Helm을 쓴다(tools/local/tools.mjs가 고정 판을 받는다). 실행: node --test "deploy/policies/test/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments } from 'yaml';
import { ensureTool } from '../../../tools/local/tools.mjs';
import { POLICY_NAMES, WEBHOOK_TIMEOUT_SECONDS } from '../../../tools/ci/kyverno-policies.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICIES = resolve(HERE, '..', 'kyverno');
const REPO = resolve(HERE, '..', '..', '..');
const ENVS = ['demo', 'staging', 'prod'];
const SYSTEM_NAMESPACES = ['kube-system', 'kyverno', 'kube-node-lease', 'kube-public'];
const SERVICE_NAMESPACES = ['queue', 'purchase', 'ticket', 'trust', 'core', 'web', 'platform', 'ops-breakglass'];
const HOT_PATH = ['queue-svc', 'admission-ctrl', 'purchase-svc', 'realtime-gw', 'web'];
const DEMO_IMAGES = ['pg-simulator', 'identity-simulator', 'demo-helper', 'bundle', 'example-svc'];
const ISSUER = 'https://token.actions.githubusercontent.com';
const REKOR = 'https://rekor.sigstore.dev';
const REPOSITORY = 'https://github.com/peaket/peaket';
const WORKFLOW = '.github/workflows/build-image.yml';
const BUILD_TYPE = 'https://actions.github.io/buildtypes/workflow/v1';
const PREDICATE = 'https://slsa.dev/provenance/v1';
const ECR = '000000000000.dkr.ecr.ap-northeast-2.amazonaws.com/';
const CHART = join(REPO, 'deploy', 'charts', 'peaket-service');

const policyFile = (env) => join(POLICIES, 'envs', env, 'policies.yaml');
const load = (env) => {
  assert.ok(existsSync(policyFile(env)), `정책 파일이 없다: deploy/policies/kyverno/envs/${env}/policies.yaml`);
  return parseAllDocuments(readFileSync(policyFile(env), 'utf8')).map((d) => d.toJS()).filter(Boolean);
};
const byName = (docs, name) => {
  const d = docs.find((o) => o.metadata?.name === name);
  assert.ok(d, `정책 ${name}이 없다`);
  return d;
};
const expressions = (spec) => (spec.validations ?? []).map((v) => v.expression).join('\n');
const namespaceList = (spec) => {
  const e = spec.matchConstraints?.matchConditions?.[0]?.expression ?? '';
  const m = /object\.metadata\.namespace in \[(.*)\]/.exec(e);
  assert.ok(m, `네임스페이스 고정 matchConditions가 없다: ${e}`);
  return m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, ''));
};
const helm = await ensureTool('helm');
function render(name) {
  const r = spawnSync(
    helm,
    [
      'template', name, CHART, '--namespace', 'queue',
      '-f', join(REPO, 'deploy', 'workloads', name, 'values.yaml'),
      '--set', `image.repository=ghcr.io/peaket/${name}`, '--set', `image.digest=sha256:${'c'.repeat(64)}`, '--set', 'env.PEAKET_ENV=prod', '--set', 'diagnose.bucket=peaket-diag-test', '--set', 'externalSecret.environment=prod',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  return parseAllDocuments(r.stdout).map((d) => d.toJS()).filter(Boolean);
}
const deploymentOf = (objects, name) => {
  const d = objects.find((o) => o.kind === 'Deployment' && o.metadata?.name === name);
  assert.ok(d, `Deployment ${name}이 없다`);
  return d;
};

// ===================== KV-01 D-T11 ①: 서명·출처·다이제스트 정책 =====================

test('KV-01 D-T11 ① 환경마다 정책 넷이 정해진 이름·종류·API 판으로 있고, 데모는 Audit/Ignore, 스테이징·운영은 Deny/Fail이다', () => {
  for (const env of ENVS) {
    const docs = load(env);
    assert.equal(docs.length, 4, `${env}: 정책이 넷이 아니다(${docs.length})`);
    assert.deepEqual(docs.map((d) => [d.metadata.name, d.kind]).sort(), [
      [POLICY_NAMES.image, 'ImageValidatingPolicy'],
      [POLICY_NAMES.placement, 'ValidatingPolicy'],
      [POLICY_NAMES.pod, 'ValidatingPolicy'],
      [POLICY_NAMES.registry, 'ValidatingPolicy'],
    ].sort());
    const wantMode = env === 'demo' ? 'Audit' : 'Deny';
    const wantFailure = env === 'demo' ? 'Ignore' : 'Fail';
    for (const d of docs) {
      assert.equal(d.apiVersion, 'policies.kyverno.io/v1', `${env}/${d.metadata.name}`);
      assert.deepEqual(d.spec.validationActions, [wantMode], `${env}/${d.metadata.name} validationActions`);
      assert.equal(d.spec.failurePolicy, wantFailure, `${env}/${d.metadata.name} failurePolicy`);
      assert.equal(d.spec.webhookConfiguration?.timeoutSeconds, WEBHOOK_TIMEOUT_SECONDS, `${env}/${d.metadata.name} timeoutSeconds`);
      assert.equal(d.metadata.labels['peaket.io/generated-by'], 'kyverno-policies');
      assert.equal(d.metadata.labels['peaket.io/environment'], env);
      // 파드에만 건다(서비스 네임스페이스를 이름 목록으로 고정)
      assert.deepEqual(d.spec.matchConstraints.resourceRules, [{ apiGroups: [''], apiVersions: ['v1'], operations: ['CREATE', 'UPDATE'], resources: ['pods'] }]);
      assert.deepEqual(namespaceList(d.spec).sort(), [...SERVICE_NAMESPACES].sort(), `${env}/${d.metadata.name} namespaces`);
      for (const system of SYSTEM_NAMESPACES) assert.equal(namespaceList(d.spec).includes(system), false, `${env}/${d.metadata.name}: ${system}`);
      // 넓은 제외(kube-*·*-system)를 쓰지 않는다
      assert.doesNotMatch(JSON.stringify(d.spec.matchConstraints), /kube-\*|\*-system/, `${env}/${d.metadata.name}`);
    }
  }
});

test('KV-01 D-T11 ① 이미지 정책: keyless 신원 둘(release·hotfix)·발급자·Rekor·required/verifyDigest·Deny를 갖춘다', () => {
  for (const env of ENVS) {
    const p = byName(load(env), POLICY_NAMES.image);
    assert.equal(p.kind, 'ImageValidatingPolicy');
    assert.deepEqual(p.spec.matchImageReferences, [{ glob: '*' }]);
    assert.equal(p.spec.validationConfigurations.required, true, `${env}: required`);
    assert.equal(p.spec.validationConfigurations.verifyDigest, true, `${env}: verifyDigest`);
    const cosign = p.spec.attestors?.[0]?.cosign;
    assert.ok(cosign, `${env}: cosign attestor`);
    assert.deepEqual(cosign.keyless?.identities, [
      { subject: `${REPOSITORY}/${WORKFLOW}@refs/heads/release/*`, issuer: ISSUER },
      { subject: `${REPOSITORY}/${WORKFLOW}@refs/heads/hotfix/*`, issuer: ISSUER },
    ]);
    assert.equal(cosign.ctlog?.url, REKOR);
    assert.equal(p.spec.attestations?.[0]?.intoto?.type, PREDICATE);
    assert.deepEqual(p.spec.attestations?.[0]?.attestors, [{ name: 'peaketCosign' }]);
    const e = expressions(p.spec);
    // 컨테이너·초기 컨테이너·임시 컨테이너 모두 서명을 본다(M13)
    for (const list of ['images.containers', 'images.initContainers', 'images.ephemeralContainers']) assert.match(e, new RegExp(`${list}\\.map\\(image, verifyImageSignatures`), `${env}: ${list}`);
    assert.match(e, /verifyAttestationSignatures\(image, attestations\.peaketSlsa/);
    // 출처 증명의 정본 값(B3): 저장소·워크플로·release/hotfix·GitHub 호스트 러너·buildType
    for (const value of [BUILD_TYPE, REPOSITORY, WORKFLOW, 'refs/heads/release/', 'refs/heads/hotfix/', 'runner_environment', 'github-hosted']) assert.ok(e.includes(value), `${env}: ${value}`);
    assert.doesNotMatch(e, /refs\/heads\/develop|refs\/heads\/main/, env);
  }
});

// ===================== KV-05: 파드 기준 =====================

test('KV-05 파드 기준: 자원·PSS Restricted·latest·hostPath·PEAKET_ENV·Node 플래그·디버그 금지를 모두 본다', () => {
  for (const env of ENVS) {
    const p = byName(load(env), POLICY_NAMES.pod);
    const e = expressions(p.spec);
    const variables = (p.spec.variables ?? []).map((v) => v.expression).join('\n');
    const allText = `${variables}\n${e}`;
    const all = p.spec.variables?.find((v) => v.name === 'allContainers')?.expression ?? '';
    for (const value of ['object.spec.containers', 'object.spec.initContainers', 'object.spec.ephemeralContainers']) assert.ok(all.includes(value), `${env}: allContainers ${value}`);
    // 자원
    assert.match(e, /resources\.requests\.size\(\) > 0/);
    assert.match(e, /resources\.limits\.size\(\) > 0/);
    // PSS Restricted
    for (const value of ['runAsNonRoot', 'allowPrivilegeEscalation', 'readOnlyRootFilesystem', 'capabilities', 'RuntimeDefault']) assert.ok(e.includes(value), `${env}: ${value}`);
    // 태그·hostPath
    assert.match(e, /image\.contains\('@sha256:'\)/);
    assert.match(e, /endsWith\(':latest'\)/);
    assert.match(e, /hostPath/);
    // PEAKET_ENV는 env에 직접, 그 환경 값
    assert.match(e, new RegExp(`e\\.name == 'PEAKET_ENV' && e\\.value == '${env}'`), env);
    assert.doesNotMatch(e, /envFrom/, 'envFrom으로 넣은 값을 보는 것처럼 읽히면 안 된다');
    // Node 컨테이너: command/args 또는 NODE_OPTIONS, sh -c "node …"도 놓치지 않는다
    for (const value of ['--disable-sigusr1', 'NODE_OPTIONS', '--inspect', '--no-disable-sigusr1', "a.contains('node ')"]) assert.ok(allText.includes(value), `${env}: ${value}`);
    assert.ok(p.spec.variables.some((v) => v.name === 'nodeContainers' && v.expression.includes('endsWith(\'/node\')')), env);
    // 정상 파드는 통과해야 한다: Node가 아닌 컨테이너는 플래그 검사 대상이 아니다(별도 목록)
    assert.ok(p.spec.variables.some((v) => v.name === 'nodeContainersWithFlag'), env);
    assert.ok(p.spec.variables.some((v) => v.name === 'nodeContainersWithDebug'), env);
  }
});

test('KV-05 데모 전용 이미지는 스테이징·운영에서만 거부하고, 데모 정책에는 그 검사가 없다', () => {
  for (const env of ENVS) {
    const e = expressions(byName(load(env), POLICY_NAMES.pod).spec);
    if (env === 'demo') {
      for (const name of DEMO_IMAGES) assert.equal(e.includes(`'${name}'`), false, `demo: ${name}`);
      // 데모는 감사 모드라 데모 이미지를 허용한다
      assert.equal(byName(load(env), POLICY_NAMES.pod).spec.validations.length, 7);
    } else {
      for (const name of DEMO_IMAGES) assert.ok(e.includes(`'${name}'`), `${env}: ${name}`);
      assert.match(e, /c\.image\.contains\('\/' \+ name \+ ':'\)/);
      assert.match(e, /c\.image\.startsWith\(name \+ '@'\)/);
      assert.equal(byName(load(env), POLICY_NAMES.pod).spec.validations.length, 8);
    }
  }
});

// ===================== KV-06: 노드 배치 =====================

test('KV-06 노드 배치: 핫패스 다섯만 온디맨드를 요구하고 payment-svc는 뺀다, ops-svc는 관제 풀 toleration·peaket-control', () => {
  for (const env of ENVS) {
    const p = byName(load(env), POLICY_NAMES.placement);
    const e = expressions(p.spec);
    for (const name of HOT_PATH) assert.ok(e.includes(`'${name}'`), `${env}: ${name}`);
    assert.equal(e.includes("'payment-svc'"), false, `${env}: payment-svc는 일반 풀이다`);
    assert.ok(e.includes('karpenter.sh/capacity-type'), env);
    assert.ok(e.includes("== 'on-demand'"), env);
    assert.ok(e.includes("t.key == 'peaket.io/pool' && t.value == 'ops' && t.effect == 'NoSchedule'"), env);
    assert.ok(e.includes("priorityClassName == 'peaket-control'"), env);
    assert.ok(p.spec.variables.some((v) => v.name === 'appName' && v.expression.includes("'app.kubernetes.io/name' in object.metadata.labels")), env);
  }
});

test('KV-06 차트 렌더: queue-svc·purchase-svc·realtime-gw는 온디맨드 nodeSelector, payment-svc는 없고, ops-svc는 관제 풀·peaket-control을 파드에 낸다', () => {
  for (const name of ['queue-svc', 'purchase-svc', 'realtime-gw']) {
    const pod = deploymentOf(render(name), name).spec.template.spec;
    assert.deepEqual(pod.nodeSelector, { 'karpenter.sh/capacity-type': 'on-demand' }, name);
    assert.equal(pod.priorityClassName, undefined, name);
  }
  const payment = deploymentOf(render('payment-svc'), 'payment-svc').spec.template.spec;
  assert.equal(payment.nodeSelector, undefined, 'payment-svc는 일반 풀이라 온디맨드 강제에서 뺀다');
  assert.equal(payment.tolerations, undefined, 'payment-svc toleration');
  const ops = deploymentOf(render('ops-svc'), 'ops-svc').spec.template.spec;
  assert.deepEqual(ops.nodeSelector, { 'peaket.io/pool': 'ops' });
  assert.deepEqual(ops.tolerations, [{ key: 'peaket.io/pool', operator: 'Equal', value: 'ops', effect: 'NoSchedule' }]);
  assert.equal(ops.priorityClassName, 'peaket-control');
  // 빈 기본값이면 지금 렌더와 같다: 노드 배치 칸이 없다
  const identity = deploymentOf(render('identity-svc'), 'identity-svc').spec.template.spec;
  assert.equal(identity.nodeSelector, undefined);
  assert.equal(identity.tolerations, undefined);
  assert.equal(identity.priorityClassName, undefined);
});

// ===================== KV-07: Kyverno 설치 값 =====================

test('KV-07 Kyverno 설치 값: 복제 3·PDB 2·peaket-control·관제 풀·failurePolicy Fail·timeout 15·시스템 네임스페이스 제외·이미지 다이제스트', () => {
  const file = join(REPO, 'deploy', 'platform', 'kyverno', 'values.yaml');
  assert.ok(existsSync(file), 'deploy/platform/kyverno/values.yaml가 없다');
  const v = parse(readFileSync(file, 'utf8'));
  assert.equal(v.admissionController.replicas, 3);
  assert.equal(v.admissionController.podDisruptionBudget.enabled, true);
  assert.equal(v.admissionController.podDisruptionBudget.minAvailable, 2, 'minAvailable 3이면 복제 3에서 하나도 비우지 못한다(M15)');
  for (const part of ['admissionController', 'backgroundController', 'cleanupController', 'reportsController']) {
    assert.equal(v[part].priorityClassName, 'peaket-control', part);
    assert.deepEqual(v[part].nodeSelector, { 'peaket.io/pool': 'ops' }, part);
    assert.deepEqual(v[part].tolerations, [{ key: 'peaket.io/pool', operator: 'Equal', value: 'ops', effect: 'NoSchedule' }], part);
  }
  assert.equal(v.admissionController.topologySpreadConstraints?.[0]?.topologyKey, 'kubernetes.io/hostname');
  // 이미지: 판과 다이제스트를 함께 고정한다
  for (const [part, repo] of [
    ['admissionController', 'kyverno/kyverno'],
    ['admissionController', 'kyverno/kyvernopre'],
    ['backgroundController', 'kyverno/background-controller'],
    ['cleanupController', 'kyverno/cleanup-controller'],
    ['reportsController', 'kyverno/reports-controller'],
  ]) {
    const image = part === 'admissionController' && repo.endsWith('kyvernopre') ? v.admissionController.initContainer.image : v[part].container.image;
    assert.equal(image.repository, repo, `${part}/${repo}`);
    assert.match(image.tag, /^v1\.20\.0@sha256:[0-9a-f]{64}$/, `${part}/${repo}`);
  }
  // 웹훅 기본값(스테이징·운영)과 시스템 네임스페이스 제외
  assert.equal(v.policyDefaults.failurePolicy, 'Fail');
  assert.equal(v.policyDefaults.timeoutSeconds, WEBHOOK_TIMEOUT_SECONDS);
  const ns = v.config.webhooks.namespaceSelector.matchExpressions;
  assert.deepEqual(ns, [{ key: 'kubernetes.io/metadata.name', operator: 'NotIn', values: SYSTEM_NAMESPACES }]);
  // 생성 정책의 웹훅 값과 같은지(스테이징·운영)
  for (const env of ['staging', 'prod']) {
    for (const d of load(env)) {
      assert.equal(d.spec.failurePolicy, v.policyDefaults.failurePolicy, `${env}/${d.metadata.name} failurePolicy`);
      assert.equal(d.spec.webhookConfiguration.timeoutSeconds, v.policyDefaults.timeoutSeconds, `${env}/${d.metadata.name} timeoutSeconds`);
    }
  }
});

test('KV-07 ArgoCD Application은 공식 차트와 이 값 파일을 가리킨다', () => {
  const file = join(REPO, 'deploy', 'platform', 'kyverno', 'application.yaml');
  assert.ok(existsSync(file), 'application.yaml이 없다');
  const app = parse(readFileSync(file, 'utf8'));
  assert.equal(app.kind, 'Application');
  assert.equal(app.metadata.namespace, 'argocd');
  assert.equal(app.spec.destination.namespace, 'kyverno');
  assert.equal(app.spec.sources[0].chart, 'kyverno');
  assert.equal(app.spec.sources[0].repoURL, 'https://kyverno.github.io/kyverno/');
  assert.deepEqual(app.spec.sources[0].helm.valueFiles, ['$values/deploy/platform/kyverno/values.yaml']);
  assert.equal(app.spec.sources[1].ref, 'values');
  assert.equal(app.spec.syncPolicy?.automated?.prune, true);
});

// ===================== KV-08 RV-01: kind에서 Kyverno가 실제로 뜨는가 =====================

test('KV-08 RV-01 kind Kyverno는 peaket.io/pool=ops 라벨 없이 스케줄된다(운영 값은 관제 풀 그대로)', () => {
  const values = parse(readFileSync(join(REPO, 'deploy', 'platform', 'kyverno', 'values.yaml'), 'utf8'));
  const controllers = ['admissionController', 'backgroundController', 'cleanupController', 'reportsController'];
  // 운영 값은 관제 풀을 요구한다(이 시험은 kind 쪽만 본다)
  for (const part of controllers) assert.deepEqual(values[part].nodeSelector, { 'peaket.io/pool': 'ops' }, part);

  const cluster = readFileSync(join(REPO, 'tools', 'local', 'cluster.mjs'), 'utf8');
  // (가) kind 덧씌우기 값으로 네 컨트롤러의 nodeSelector·tolerations를 비우고 cluster.mjs가 그 파일을 함께 넘긴다
  const kindValuesFile = join(REPO, 'deploy', 'platform', 'kyverno', 'kind-values.yaml');
  let overlayClears = false;
  if (existsSync(kindValuesFile)) {
    const kindValues = parse(readFileSync(kindValuesFile, 'utf8')) ?? {};
    overlayClears = controllers.every((part) => {
      const selector = kindValues[part]?.nodeSelector;
      const tolerations = kindValues[part]?.tolerations;
      return (selector === undefined || Object.keys(selector).length === 0) && (tolerations === undefined || tolerations.length === 0);
    });
  }
  const overlayUsed = cluster.includes('kind-values');
  // (나) cluster.mjs가 kind 노드에 라벨을 단다(테인트는 없어 toleration은 무해하다)
  const labelsNode = /['"]label['"][\s\S]{0,300}peaket\.io\/pool=ops/.test(cluster);
  // (다) --set으로 컨트롤러의 nodeSelector를 비운다
  const clearsBySet = /--set[^\n]*nodeSelector/.test(cluster);
  assert.ok(
    (overlayClears && overlayUsed) || labelsNode || clearsBySet,
    'kind Kyverno 설치가 peaket.io/pool=ops 라벨을 요구해 네 컨트롤러가 Pending이 된다(RV-01). kind-values.yaml로 nodeSelector·tolerations를 비우고 cluster.mjs가 함께 넘기거나, cluster.mjs가 kind 노드에 라벨을 달거나, --set으로 비워야 한다',
  );
});

// ===================== KV-09 RV-04: 레지스트리 정책 CEL =====================

test('KV-09 D-T33 ①·② 레지스트리 CEL: 데모는 ghcr.io/peaket/와 imagePullSecrets 금지, 스테이징·운영은 ECR 계정 고정', () => {
  for (const env of ENVS) {
    const p = byName(load(env), POLICY_NAMES.registry);
    const e = expressions(p.spec);
    const images = p.spec.variables?.find((v) => v.name === 'images')?.expression ?? '';
    // 레지스트리 CEL은 앱·초기·임시 컨테이너를 모두 본다
    for (const list of ['object.spec.containers', 'object.spec.initContainers', 'object.spec.ephemeralContainers']) assert.ok(images.includes(list), `${env}: ${list}`);
    // 글롭(*)이 아니라 접두사 `startsWith`이고, 접두사 뒤의 `/` 경계를 지킨다(peaket-evil을 받지 않는다)
    assert.match(e, /image\.startsWith\(prefix\)/, env);
    assert.equal(e.includes('*'), false, `${env}: 글롭을 쓰면 안 된다`);
    if (env === 'demo') {
      assert.ok(e.includes("['ghcr.io/peaket/']"), env);
      assert.ok(p.spec.validations.some((v) => v.expression.includes('object.spec.imagePullSecrets') && v.expression.includes('size() > 0')), `${env}: imagePullSecrets 금지`);
    } else {
      assert.ok(e.includes(`['${ECR}']`), `${env}: ${ECR}`);
      assert.equal(e.includes('ghcr.io/peaket/'), false, `${env}: 운영은 GHCR을 허용하지 않는다`);
      assert.equal(e.includes('imagePullSecrets'), false, `${env}: 운영은 ECR 끌어오기 비밀을 쓸 수 있다`);
    }
    // `ghcr.io/peaket`(슬래시 없음) 같은 접두사가 남지 않는다
    assert.doesNotMatch(e, /ghcr\.io\/peaket[^/']/, env);
  }
});

// ===================== KV-04: 생성 파일이 원천과 같다 =====================

test('KV-04 생성 파일 셋은 원천(policy-values.yaml)을 다시 만든 것과 바이트가 같다', async () => {
  const { generateFromRoot } = await import('../../../tools/ci/kyverno-policies.mjs');
  const r = generateFromRoot(REPO);
  assert.deepEqual(r.problems, []);
  for (const env of ENVS) {
    const rel = `deploy/policies/kyverno/envs/${env}/policies.yaml`;
    assert.ok(r.files.has(rel), rel);
    assert.equal(readFileSync(join(REPO, rel), 'utf8'), r.files.get(rel), `${rel}: 손으로 고쳤거나 --write를 잊었다`);
  }
});
