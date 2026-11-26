// F-09-10(OPS-430) 플랫폼 애드온 정적 시험. 클러스터·Docker·AWS 없이 YAML만 읽는다.
// 정본: docs/devops.md §5.2(애드온은 관제·시스템 풀)·§6.1·§6.2·§8.2, docs/infra.md §5,
// docs/infra-handover.md §3.1(노드 풀), docs/observability.md §5 '자동 제어 입력 감시',
// deploy/policies/resource-quotas.yaml(할당량은 NodePool 한도의 80% [가정], ADR-0078 결정 8).
// 실행(저장소 뿌리): node --test deploy/platform/test/platform-addons.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const PLATFORM = join(REPO, 'deploy', 'platform');
const OPS_POOL = { key: 'peaket.io/pool', operator: 'Equal', value: 'ops', effect: 'NoSchedule' };
const SEMVER = /^\d+\.\d+\.\d+$/;

function yamlFile(rel) {
  const file = join(REPO, rel);
  assert.ok(existsSync(file), `파일이 없다: ${rel}`);
  return parse(readFileSync(file, 'utf8'));
}
function yamlDocs(rel) {
  const file = join(REPO, rel);
  assert.ok(existsSync(file), `파일이 없다: ${rel}`);
  return parseAllDocuments(readFileSync(file, 'utf8')).map((d) => d.toJS()).filter(Boolean);
}
function textFile(rel) {
  const file = join(REPO, rel);
  assert.ok(existsSync(file), `파일이 없다: ${rel}`);
  return readFileSync(file, 'utf8');
}
function assertOpsPlacement(obj, where) {
  assert.deepEqual(obj.nodeSelector, { 'peaket.io/pool': 'ops' }, `${where}: 관제·시스템 풀 선택자`);
  assert.ok(Array.isArray(obj.tolerations) && obj.tolerations.some((t) => t.key === OPS_POOL.key && t.value === 'ops' && t.effect === 'NoSchedule'), `${where}: ops 테인트 toleration`);
  assert.equal(obj.priorityClassName, 'peaket-control', `${where}: peaket-control`);
}
function assertApplication(rel, { repoURL, chart, namespace }) {
  const app = yamlFile(rel);
  assert.equal(app.apiVersion, 'argoproj.io/v1alpha1', `${rel}: apiVersion`);
  assert.equal(app.kind, 'Application', `${rel}: kind`);
  assert.equal(app.spec.project, 'peaket-platform', `${rel}: project`);
  assert.equal(app.spec.destination.namespace, namespace, `${rel}: destination.namespace`);
  assert.deepEqual(app.spec.syncPolicy?.automated, { prune: true, selfHeal: true }, `${rel}: 자동 동기화`);
  const sources = app.spec.sources ?? [];
  assert.equal(sources.length, 2, `${rel}: source 둘(차트+값)`);
  assert.equal(sources[0].repoURL, repoURL, `${rel}: 차트 저장소`);
  assert.equal(sources[0].chart, chart, `${rel}: 차트 이름`);
  assert.match(String(sources[0].targetRevision), SEMVER, `${rel}: 차트 판을 고정한다`);
  assert.ok(sources[0].helm?.valueFiles?.includes(`$values/${rel.replace(/application\.yaml$/, 'values.yaml')}`), `${rel}: values 파일 참조`);
  assert.equal(sources[1].repoURL, 'https://github.com/peaket/peaket', `${rel}: 값 저장소`);
  assert.equal(sources[1].ref, 'values', `${rel}: values ref`);
}

// --- KEDA ---

test('OPS-430 ④ KEDA_설치값은_관제풀·peaket-control·복제2·PDB·웹훅Fail이고_차트판을_고정한다', () => {
  const v = yamlFile('deploy/platform/keda/values.yaml');
  const where = 'deploy/platform/keda/values.yaml';
  assert.equal(v.operator?.replicaCount, 2, `${where}: operator.replicaCount`);
  assert.equal(v.metricsServer?.replicaCount, 2, `${where}: metricsServer.replicaCount`);
  assert.equal(v.webhooks?.replicaCount, 2, `${where}: webhooks.replicaCount`);
  assert.equal(v.podDisruptionBudget?.operator?.minAvailable, 1, `${where}: operator PDB`);
  assert.equal(v.podDisruptionBudget?.metricServer?.minAvailable, 1, `${where}: metricServer PDB`);
  assert.equal(v.podDisruptionBudget?.webhooks?.minAvailable, 1, `${where}: webhooks PDB`);
  // 애드온은 관제·시스템 풀에서 돈다(docs/devops.md §5.2, docs/infra-handover.md §3.1)
  assertOpsPlacement(v, where);
  // KEDA 웹훅이 잘못된 ScaledObject를 조용히 받지 않는다
  assert.equal(v.webhooks?.failurePolicy, 'Fail', `${where}: 웹훅 실패 정책`);
  assertApplication('deploy/platform/keda/application.yaml', {
    repoURL: 'https://kedacore.github.io/charts',
    chart: 'keda',
    namespace: 'keda',
  });
});

// --- Karpenter ---

const NODE_POOLS = 'deploy/platform/karpenter/nodepools.yaml';
const POOL_NAMES = ['hotpath', 'general', 'data', 'observability'];
const FAMILY = { hotpath: 'c7g', general: 'm7g', data: 'r7g', observability: 'r7g' };
const ZONES = ['ap-northeast-2a', 'ap-northeast-2b', 'ap-northeast-2c'];

function nodePools() {
  const pools = yamlDocs(NODE_POOLS).filter((o) => o.kind === 'NodePool');
  assert.equal(pools.length, POOL_NAMES.length, `${NODE_POOLS}: NodePool 넷`);
  for (const name of POOL_NAMES) assert.ok(pools.some((p) => p.metadata?.name === name), `${NODE_POOLS}: NodePool ${name}`);
  return pools;
}
function requirement(pool, key) {
  const req = pool.spec?.template?.spec?.requirements?.find((r) => r.key === key);
  assert.ok(req, `${pool.metadata?.name}: requirement ${key}`);
  return req;
}

test('OPS-430 ⑤ Karpenter_NodePool_넷은_정본의_구매방식·아키텍처·인스턴스계열·AZ를_갖는다', () => {
  const pools = nodePools();
  for (const pool of pools) {
    const name = pool.metadata.name;
    assert.equal(pool.apiVersion, 'karpenter.sh/v1', `${name}: apiVersion`);
    assert.equal(pool.metadata.labels?.['peaket.io/pool'], name, `${name}: pool 라벨`);
    assert.deepEqual(requirement(pool, 'karpenter.sh/capacity-type').values, ['on-demand'], `${name}: 온디맨드만`);
    assert.deepEqual(requirement(pool, 'kubernetes.io/arch').values, ['arm64'], `${name}: Graviton`);
    assert.equal(requirement(pool, 'karpenter.k8s.aws/instance-family').values.length, 1, `${name}: 인스턴스 계열 하나`);
    assert.equal(requirement(pool, 'karpenter.k8s.aws/instance-family').values[0], FAMILY[name], `${name}: 인스턴스 계열`);
    assert.deepEqual(requirement(pool, 'topology.kubernetes.io/zone').values, ZONES, `${name}: AZ 셋`);
    // Spot은 이 기능에서 켜지 않는다(워크로드의 Spot toleration 배선이 없다). capacity-type 요구 사항이 on-demand 하나뿐이면 된다
    assert.equal(requirement(pool, 'karpenter.sh/capacity-type').values.includes('spot'), false, `${name}: Spot 요구 사항`);
  }
});

test('OPS-430 ⑥ 핫패스_NodePool은_expireAfter_Never이고_모든_NodePool에_정비시간_drift_중단예산이_있다', () => {
  const pools = nodePools();
  const hotpath = pools.find((p) => p.metadata.name === 'hotpath');
  assert.equal(hotpath.spec.template.spec.expireAfter, 'Never', 'hotpath: expireAfter Never');
  for (const pool of pools) {
    const name = pool.metadata.name;
    assert.equal(pool.spec.disruption?.consolidationPolicy, 'WhenEmptyOrUnderutilized', `${name}: 통합 정책`);
    const budgets = pool.spec.disruption?.budgets ?? [];
    assert.ok(
      budgets.some((b) => b.nodes === '0' && b.schedule === '0 21 * * *' && b.duration === '22h' && Array.isArray(b.reasons) && b.reasons.includes('Drift')),
      `${name}: drift 중단 예산(nodes 0, 0 21 * * *, 22h, Drift)`,
    );
  }
});

test('OPS-430 ⑦ data·observability_NodePool_한도는_ResourceQuota의_125%이고_EC2NodeClass_계약을_가리킨다', () => {
  const pools = nodePools();
  for (const pool of pools) {
    assert.deepEqual(pool.spec.template.spec.nodeClassRef, { group: 'karpenter.k8s.aws', kind: 'EC2NodeClass', name: 'default' }, `${pool.metadata.name}: nodeClassRef`);
  }
  const quotas = yamlDocs('deploy/policies/resource-quotas.yaml').filter((o) => o.kind === 'ResourceQuota');
  for (const [poolName, quotaName] of [['data', 'peaket-data'], ['observability', 'peaket-observability']]) {
    const pool = pools.find((p) => p.metadata.name === poolName);
    const quota = quotas.find((q) => q.metadata.name === quotaName);
    assert.ok(quota, `ResourceQuota ${quotaName}`);
    const wantCpu = Number(quota.spec.hard['requests.cpu']) * 1.25;
    const wantMem = Number(String(quota.spec.hard['requests.memory']).replace(/Gi$/, '')) * 1.25;
    assert.equal(Number(pool.spec.limits?.cpu), wantCpu, `${poolName}: CPU 한도는 할당량의 125%`);
    assert.equal(Number(String(pool.spec.limits?.memory).replace(/Gi$/, '')), wantMem, `${poolName}: 메모리 한도는 할당량의 125%`);
  }
  const readme = textFile('deploy/platform/karpenter/README.md');
  assert.match(readme, /EC2NodeClass/, 'README: EC2NodeClass 계약');
  assert.match(readme, /BAT-076/, 'README: Terraform 소유자');
  // 계정 ID·자격 증명을 저장소에 적지 않는다
  assert.equal(/\b\d{12}\b/.test(textFile(NODE_POOLS)), false, '12자리 AWS 계정 ID');
});

// --- Argo Rollouts ---

test('OPS-430 ⑩ Argo_Rollouts_설치값은_관제풀·peaket-control·복제2·PDB이고_차트판을_고정한다', () => {
  const v = yamlFile('deploy/platform/argo-rollouts/values.yaml');
  const where = 'deploy/platform/argo-rollouts/values.yaml';
  assert.equal(v.controller?.replicas, 2, `${where}: controller.replicas`);
  assert.equal(v.controller?.pdb?.enabled, true, `${where}: PDB 켬`);
  assert.equal(v.controller?.pdb?.minAvailable, 1, `${where}: PDB minAvailable`);
  assert.equal(v.controller?.metrics?.enabled, true, `${where}: 컨트롤러 지표`);
  assertOpsPlacement(v.controller, where);
  assertApplication('deploy/platform/argo-rollouts/application.yaml', {
    repoURL: 'https://argoproj.github.io/argo-helm',
    chart: 'argo-rollouts',
    namespace: 'argo-rollouts',
  });
});
