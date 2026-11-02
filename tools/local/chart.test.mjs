// 공용 서비스 차트(deploy/charts/peaket-service) 렌더 시험. helm은 tools.mjs가 고정 판으로 받는다.
// 실행: node --test "tools/local/*.test.mjs"  (실제 클러스터에 올려 보는 것은 tools/local/e2e/relay-takeover.e2e.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import { V0_ALLOWED_ORIGINS, V0_PG_URL } from './cluster.mjs';
import { ensureTool } from './tools.mjs';
import { V0_TOKEN_ISSUER } from './v0-token.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHART = join(REPO, 'deploy', 'charts', 'peaket-service');
const helm = await ensureTool('helm');

const BASE = ['name=example-svc', 'image.repository=peaket/example-svc', 'image.tag=local', 'env.PEAKET_ENV=local'];

function render(sets, ns = 'example') {
  const r = spawnSync(helm, ['template', 'rel', CHART, '--namespace', ns, ...sets.flatMap((s) => ['--set', s])], { encoding: 'utf8' });
  if (r.status !== 0) return { error: r.stderr };
  return { objects: parseAllDocuments(r.stdout).map((d) => d.toJS()).filter(Boolean) };
}
const find = (objs, kind, name) => objs.find((o) => o.kind === kind && o.metadata.name === name);
const envOf = (c) => Object.fromEntries(c.env.map((e) => [e.name, e.value ?? e.valueFrom]));

test('FND110_차트_이름·이미지가_없거나_틀리면_렌더하지_않는다', () => {
  assert.match(render(BASE.filter((s) => !s.startsWith('name='))).error, /name/);
  assert.match(render([...BASE, 'image.digest=sha256:abc']).error, /sha256/);
  // 태그는 로컬·CI 시험에서만. 다른 환경은 다이제스트로 고정한다
  assert.match(render([...BASE.filter((s) => !s.startsWith('env.')), 'env.PEAKET_ENV=prod']).error, /digest/);
  const d = render([...BASE.filter((s) => !s.startsWith('image.tag') && !s.startsWith('env.')), 'env.PEAKET_ENV=prod', `image.digest=sha256:${'a'.repeat(64)}`]);
  assert.equal(find(d.objects, 'Deployment', 'example-svc').spec.template.spec.containers[0].image, `peaket/example-svc@sha256:${'a'.repeat(64)}`);
});

test('FND110_서비스파드_준비는_관리포트ready·생존은livez_10초5초6번·파드이름PEAKET_POD·토큰없음', () => {
  const { objects } = render(BASE);
  const dep = find(objects, 'Deployment', 'example-svc');
  const spec = dep.spec.template.spec;
  const c = spec.containers[0];
  assert.equal(spec.automountServiceAccountToken, false);
  assert.deepEqual(c.readinessProbe.httpGet, { path: '/ready', port: 'management' });
  assert.deepEqual({ ...c.livenessProbe.httpGet, p: c.livenessProbe.periodSeconds, t: c.livenessProbe.timeoutSeconds, f: c.livenessProbe.failureThreshold }, { path: '/livez', port: 'management', p: 10, t: 5, f: 6 });
  assert.equal(c.startupProbe.periodSeconds * c.startupProbe.failureThreshold, 60);
  assert.deepEqual(c.ports.find((p) => p.name === 'management'), { name: 'management', containerPort: 9464 });
  const env = envOf(c);
  assert.deepEqual(env.PEAKET_POD, { fieldRef: { fieldPath: 'metadata.name' } });
  assert.equal(env.OTEL_SERVICE_NAME, 'example-svc');
  assert.equal(env.PORT, '8080');
  assert.deepEqual(c.lifecycle.preStop, { sleep: { seconds: 5 } });
  assert.equal(c.securityContext.readOnlyRootFilesystem, true);
  assert.equal(find(objects, 'ServiceAccount', 'example-svc').automountServiceAccountToken, false);
  // 릴레이는 켜지 않으면 없다
  assert.equal(objects.some((o) => o.metadata.name.startsWith('example-svc-outbox-relay')), false);
});

test('FND110_릴레이_서비스-outbox-relay_복제2·같은이미지·다른명령·Lease권한은그Lease하나', () => {
  const { objects } = render([...BASE, 'outboxRelay.enabled=true'], 'purchase');
  const dep = find(objects, 'Deployment', 'example-svc-outbox-relay');
  const svc = find(objects, 'Deployment', 'example-svc');
  assert.equal(dep.spec.replicas, 2);
  assert.deepEqual(dep.spec.strategy.rollingUpdate, { maxUnavailable: 1, maxSurge: 0 });
  const c = dep.spec.template.spec.containers[0];
  assert.equal(c.image, svc.spec.template.spec.containers[0].image);
  assert.deepEqual(c.command, ['node', '--import', '@peaket/platform/telemetry/register', 'template/dist/relay.js']);
  assert.deepEqual(c.ports, [{ name: 'management', containerPort: 9464 }]);
  assert.deepEqual(c.readinessProbe.httpGet, { path: '/ready', port: 'management' });
  assert.deepEqual(envOf(c).PEAKET_POD, { fieldRef: { fieldPath: 'metadata.name' } });
  assert.equal(dep.spec.template.spec.serviceAccountName, 'example-svc-outbox-relay');
  assert.equal(dep.spec.template.spec.automountServiceAccountToken, true);
  // 서비스와 릴레이의 파드 선택이 겹치지 않는다
  assert.notDeepEqual(dep.spec.selector.matchLabels, svc.spec.selector.matchLabels);

  const role = find(objects, 'Role', 'example-svc-outbox-relay-lease');
  // 만들기는 RBAC가 이름으로 좁히지 못해(다른 서비스의 Lease를 먼저 만들어 막을 수 있다) 주지 않고, 차트가 그 Lease를 미리 만든다(코드 리뷰 2026-11-01)
  assert.deepEqual(role.rules, [{ apiGroups: ['coordination.k8s.io'], resources: ['leases'], resourceNames: ['example-svc-outbox-relay'], verbs: ['get', 'update'] }]);
  const lease = find(objects, 'Lease', 'example-svc-outbox-relay');
  assert.equal(lease.apiVersion, 'coordination.k8s.io/v1');
  assert.equal(lease.spec?.holderIdentity, undefined);
  const rb = find(objects, 'RoleBinding', 'example-svc-outbox-relay-lease');
  assert.deepEqual(rb.roleRef, { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'example-svc-outbox-relay-lease' });
  assert.deepEqual(rb.subjects, [{ kind: 'ServiceAccount', name: 'example-svc-outbox-relay', namespace: 'purchase' }]);
  // 클러스터 범위 권한은 만들지 않는다
  assert.equal(objects.some((o) => o.kind === 'ClusterRole' || o.kind === 'ClusterRoleBinding'), false);
});

test('FND110_비밀은_값이아니라Secret이름으로만받는다', () => {
  const { objects } = render([...BASE, 'outboxRelay.enabled=true', 'secretEnvFrom=example-svc-env', 'outboxRelay.secretEnvFrom=example-svc-relay-env']);
  const relay = find(objects, 'Deployment', 'example-svc-outbox-relay').spec.template.spec.containers[0];
  const svc = find(objects, 'Deployment', 'example-svc').spec.template.spec.containers[0];
  assert.deepEqual(relay.envFrom, [{ secretRef: { name: 'example-svc-env' } }, { secretRef: { name: 'example-svc-relay-env' } }]);
  assert.deepEqual(svc.envFrom, [{ secretRef: { name: 'example-svc-env' } }]);
});

// --- v0 배포: CPU HPA(K9의 v0)와 앱 포트 막기 NetworkPolicy, 로컬 환경 값(docs/infra.md §3 'v0 배포', BUILD_ORDER BSL-050) ---

const ENVS = join(REPO, 'deploy', 'envs', 'local');
const temps = [];
process.on('exit', () => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** 값 파일(-f)을 차례로 주고 --set을 덧붙여 렌더한다 */
function renderFiles(files, sets = [], ns = 'v0') {
  const r = spawnSync(helm, ['template', 'rel', CHART, '--namespace', ns, ...files.flatMap((f) => ['-f', f]), ...sets.flatMap((s) => ['--set', s])], { encoding: 'utf8' });
  if (r.status !== 0) return { error: r.stderr };
  return { objects: parseAllDocuments(r.stdout).map((d) => d.toJS()).filter(Boolean) };
}
/** 임시 값 파일 */
function valuesFile(text) {
  const dir = mkdtempSync(join(tmpdir(), 'chart-values-'));
  temps.push(dir);
  const file = join(dir, 'values.yaml');
  writeFileSync(file, text);
  return file;
}
const all = (objs, kind) => objs.filter((o) => o.kind === kind);
const CPU_METRIC = (n) => [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: n } } }];
const SERVICE_PODS = (name) => ({ 'app.kubernetes.io/name': name, 'app.kubernetes.io/component': 'service' });
const mgmtRule = (namespaces, port = 9464) => ({
  from: [{ namespaceSelector: { matchExpressions: [{ key: 'kubernetes.io/metadata.name', operator: 'In', values: namespaces }] } }],
  ports: [{ protocol: 'TCP', port }],
});
const appRule = (labels, port) => ({ from: [{ podSelector: { matchLabels: labels } }], ports: [{ protocol: 'TCP', port }] });
const ruleFrom = (np, key) => np.spec.ingress.filter((r) => r.from?.some((f) => key in f));

test('K9_HPA를켜면_autoscaling/v2_CPU사용률하나·확장동작은기본값·Deployment에복제수를적지않는다', () => {
  const { objects, error } = render([...BASE, 'service.autoscaling.enabled=true']);
  assert.equal(error, undefined, error);
  const hpas = all(objects, 'HorizontalPodAutoscaler');
  assert.equal(hpas.length, 1);
  const hpa = hpas[0];
  assert.equal(hpa.apiVersion, 'autoscaling/v2');
  assert.equal(hpa.metadata.name, 'example-svc');
  assert.deepEqual(hpa.spec.scaleTargetRef, { apiVersion: 'apps/v1', kind: 'Deployment', name: 'example-svc' });
  assert.equal(hpa.spec.minReplicas, 1);
  assert.equal(hpa.spec.maxReplicas, 4);
  assert.deepEqual(hpa.spec.metrics, CPU_METRIC(70));
  // 확장 동작은 쿠버네티스 기본값 그대로(K9의 v0 한계를 그대로 잰다)
  assert.equal('behavior' in hpa.spec, false);
  // HPA가 정한 복제 수를 다시 올릴 때 되돌리지 않게
  assert.equal('replicas' in find(objects, 'Deployment', 'example-svc').spec, false);

  const custom = render([...BASE, 'service.autoscaling.enabled=true', 'service.autoscaling.minReplicas=2', 'service.autoscaling.maxReplicas=6', 'service.autoscaling.targetCPUUtilizationPercentage=55']);
  const h2 = find(custom.objects, 'HorizontalPodAutoscaler', 'example-svc');
  assert.deepEqual([h2.spec.minReplicas, h2.spec.maxReplicas, h2.spec.metrics], [2, 6, CPU_METRIC(55)]);
});

test('K9_HPA는_서비스Deployment만늘리고_릴레이복제수는그대로다', () => {
  const { objects, error } = render([...BASE, 'service.autoscaling.enabled=true', 'outboxRelay.enabled=true']);
  assert.equal(error, undefined, error);
  const hpas = all(objects, 'HorizontalPodAutoscaler');
  assert.equal(hpas.length, 1);
  assert.equal(hpas[0].spec.scaleTargetRef.name, 'example-svc');
  assert.equal(find(objects, 'Deployment', 'example-svc-outbox-relay').spec.replicas, 2);
});

test('K9_HPA값이틀리면_렌더하지않는다', () => {
  const on = [...BASE, 'service.autoscaling.enabled=true'];
  // 경계는 받는다: 최소=최대=1, 목표 1·100
  for (const ok of [['service.autoscaling.maxReplicas=1'], ['service.autoscaling.targetCPUUtilizationPercentage=1'], ['service.autoscaling.targetCPUUtilizationPercentage=100']]) {
    assert.equal(render([...on, ...ok]).error, undefined, ok.join(' '));
  }
  for (const bad of [
    ['service.autoscaling.minReplicas=0'],
    ['service.autoscaling.minReplicas=3', 'service.autoscaling.maxReplicas=2'],
    ['service.autoscaling.targetCPUUtilizationPercentage=0'],
    ['service.autoscaling.targetCPUUtilizationPercentage=101'],
    // 사용률의 분모(요청 CPU)가 없으면 HPA가 판단하지 못한다
    ['service.resources.requests.cpu=null'],
    ['service.resources.requests=null'],
  ]) {
    assert.match(render([...on, ...bad]).error ?? '(렌더됨)', /autoscaling/, bad.join(' '));
  }
});

test('K9_HPA를끄면_HPA가없고_Deployment가복제수를둔다', () => {
  const { objects } = render(BASE);
  assert.equal(all(objects, 'HorizontalPodAutoscaler').length, 0);
  assert.equal(find(objects, 'Deployment', 'example-svc').spec.replicas, 2);
  // 끈 채로는 요청 CPU가 없어도 렌더한다
  assert.equal(render([...BASE, 'service.resources.requests.cpu=null']).error, undefined);
});

test('BSL050_NetworkPolicy를켜면_앱포트는지정한파드만·관리포트는지정한네임스페이스만닿는다 [ASVS v5.0.0-4.1.3]', () => {
  const file = valuesFile(
    'service:\n  networkPolicy:\n    enabled: true\n    appFromPodLabels:\n      app.kubernetes.io/name: gw\n      app.kubernetes.io/component: service\n    managementFromNamespaces: [observability, monitoring]\n',
  );
  const { objects, error } = renderFiles([file], BASE, 'example');
  assert.equal(error, undefined, error);
  const nps = all(objects, 'NetworkPolicy');
  assert.equal(nps.length, 1);
  const np = nps[0];
  assert.equal(np.apiVersion, 'networking.k8s.io/v1');
  assert.equal(np.metadata.name, 'example-svc');
  // 서비스 파드만 고른다(릴레이 파드는 고르지 않는다)
  assert.deepEqual(np.spec.podSelector, { matchLabels: SERVICE_PODS('example-svc') });
  assert.deepEqual(np.spec.policyTypes, ['Ingress']);
  assert.equal(np.spec.ingress.length, 2);
  assert.deepEqual(ruleFrom(np, 'podSelector'), [appRule({ 'app.kubernetes.io/name': 'gw', 'app.kubernetes.io/component': 'service' }, 8080)]);
  assert.deepEqual(ruleFrom(np, 'namespaceSelector'), [mgmtRule(['observability', 'monitoring'])]);

  // 포트는 이름이 아니라 그 값(service.port·managementPort)이다
  const moved = renderFiles([file], [...BASE, 'service.port=9090', 'managementPort=9999'], 'example');
  const np2 = find(moved.objects, 'NetworkPolicy', 'example-svc');
  assert.deepEqual(ruleFrom(np2, 'podSelector')[0].ports, [{ protocol: 'TCP', port: 9090 }]);
  assert.deepEqual(ruleFrom(np2, 'namespaceSelector')[0].ports, [{ protocol: 'TCP', port: 9999 }]);
});

test('BSL050_앱포트허용파드가비면_아무도앱포트에닿지못한다 [ASVS v5.0.0-4.1.3]', () => {
  const { objects, error } = render([...BASE, 'service.networkPolicy.enabled=true']);
  assert.equal(error, undefined, error);
  const np = find(objects, 'NetworkPolicy', 'example-svc');
  assert.ok(np, 'NetworkPolicy가 있다');
  assert.deepEqual(np.spec.policyTypes, ['Ingress']);
  // 관리 포트 규칙 하나뿐이다. 빈 podSelector({}: 같은 네임스페이스 전부)나 from 없는 규칙(모두 허용)을 만들지 않는다
  assert.deepEqual(np.spec.ingress, [mgmtRule(['observability'])]);
});

test('BSL050_NetworkPolicy를끄면_만들지않는다', () => {
  assert.equal(all(render(BASE).objects, 'NetworkPolicy').length, 0);
});

test('K9_v0-monolith값_HPA는1~4복제·CPU70%·요청CPU500m이고_복제수를적지않는다', () => {
  const { objects, error } = renderFiles([join(ENVS, 'v0-monolith.yaml')]);
  assert.equal(error, undefined, error);
  const hpa = find(objects, 'HorizontalPodAutoscaler', 'v0-monolith');
  assert.ok(hpa, 'HPA v0-monolith');
  assert.equal(hpa.apiVersion, 'autoscaling/v2');
  assert.deepEqual(hpa.spec.scaleTargetRef, { apiVersion: 'apps/v1', kind: 'Deployment', name: 'v0-monolith' });
  assert.deepEqual([hpa.spec.minReplicas, hpa.spec.maxReplicas, hpa.spec.metrics], [1, 4, CPU_METRIC(70)]);
  assert.equal('behavior' in hpa.spec, false);
  const dep = find(objects, 'Deployment', 'v0-monolith');
  assert.equal('replicas' in dep.spec, false);
  assert.equal(dep.spec.template.spec.containers[0].resources.requests.cpu, '500m');
});

test('BSL050_v0-monolith값_앱포트8080은입구파드만·관리포트9464는observability만닿는다 [ASVS v5.0.0-4.1.3]', () => {
  const { objects, error } = renderFiles([join(ENVS, 'v0-monolith.yaml')]);
  assert.equal(error, undefined, error);
  const np = find(objects, 'NetworkPolicy', 'v0-monolith');
  assert.ok(np, 'NetworkPolicy v0-monolith');
  assert.deepEqual(np.spec.podSelector, { matchLabels: SERVICE_PODS('v0-monolith') });
  assert.deepEqual(np.spec.policyTypes, ['Ingress']);
  assert.equal(np.spec.ingress.length, 2);
  assert.deepEqual(ruleFrom(np, 'podSelector'), [appRule({ 'app.kubernetes.io/name': 'v0-gateway' }, 8080)]);
  assert.deepEqual(ruleFrom(np, 'namespaceSelector'), [mgmtRule(['observability'])]);
});

test('BSL050_v0-monolith값_앱시작명령·Secret_v0-monolith·로컬이미지', () => {
  const { objects, error } = renderFiles([join(ENVS, 'v0-monolith.yaml')]);
  assert.equal(error, undefined, error);
  const c = find(objects, 'Deployment', 'v0-monolith').spec.template.spec.containers[0];
  assert.deepEqual(c.command, ['node', '--import', '@peaket/platform/telemetry/register', 'dist/main.js']);
  assert.deepEqual(c.envFrom, [{ secretRef: { name: 'v0-monolith' } }]);
  assert.equal(c.image, 'peaket/v0-monolith:local');
  assert.equal(c.imagePullPolicy, 'Never');
});

test('K6_v0-gateway값_클라이언트IP마다_초당10개·최대20개·앞단프록시1겹', () => {
  const { objects, error } = renderFiles([join(ENVS, 'v0-gateway.yaml')]);
  assert.equal(error, undefined, error);
  const env = envOf(find(objects, 'Deployment', 'v0-gateway').spec.template.spec.containers[0]);
  assert.equal(env.PEAKET_V0_RATE_PER_SECOND, '10');
  assert.equal(env.PEAKET_V0_RATE_BURST, '20');
  assert.equal(env.PEAKET_V0_TRUSTED_PROXY_HOPS, '1');
});

test('BSL050_v0-gateway값_복제1·HTTPS포트8443·입구명령·Secret_v0-gateway·HPA와NetworkPolicy없음', () => {
  const { objects, error } = renderFiles([join(ENVS, 'v0-gateway.yaml')]);
  assert.equal(error, undefined, error);
  const dep = find(objects, 'Deployment', 'v0-gateway');
  assert.equal(dep.spec.replicas, 1);
  const c = dep.spec.template.spec.containers[0];
  assert.deepEqual(c.ports.find((p) => p.name === 'http'), { name: 'http', containerPort: 8443 });
  assert.equal(find(objects, 'Service', 'v0-gateway').spec.ports[0].port, 8443);
  assert.deepEqual(c.command, ['node', 'dist/gateway/main.js']);
  assert.deepEqual(c.envFrom, [{ secretRef: { name: 'v0-gateway' } }]);
  // 입구는 앱의 요청 마감(PEAKET_MAX_DEADLINE_MS 기본 15초)보다 길게, 20초 [가정] 기다린다(동기 결제 체인이 입구에서 먼저 끊기지 않게)
  assert.equal(envOf(c).PEAKET_V0_UPSTREAM_TIMEOUT_MS, '20000');
  assert.equal(all(objects, 'HorizontalPodAutoscaler').length, 0);
  assert.equal(all(objects, 'NetworkPolicy').length, 0);
});

test('BSL050_v0값서로맞음_입구파드라벨이앱NetworkPolicy허용라벨을갖고_입구는앱서비스포트로보내며_발급자·출처·결제사주소가도구값과같다 [ASVS v5.0.0-4.1.3]', () => {
  const gw = renderFiles([join(ENVS, 'v0-gateway.yaml')]);
  const app = renderFiles([join(ENVS, 'v0-monolith.yaml')]);
  assert.equal(gw.error, undefined, gw.error);
  assert.equal(app.error, undefined, app.error);
  // 앱 포트를 여는 라벨을 입구 파드가 실제로 단다(아니면 입구도 앱에 닿지 못한다)
  const np = find(app.objects, 'NetworkPolicy', 'v0-monolith');
  assert.ok(np, 'NetworkPolicy v0-monolith');
  const allow = ruleFrom(np, 'podSelector')[0]?.from[0].podSelector.matchLabels;
  assert.ok(allow && Object.keys(allow).length > 0, '앱 포트 허용 파드 라벨');
  const gwDep = find(gw.objects, 'Deployment', 'v0-gateway');
  const gwLabels = gwDep.spec.template.metadata.labels;
  for (const [k, v] of Object.entries(allow)) assert.equal(gwLabels[k], v, `입구 파드 라벨 ${k}`);
  // 앱 파드는 그 라벨을 달지 않는다(앱끼리 서로 앱 포트를 여는 꼴이 아니다)
  const appLabels = find(app.objects, 'Deployment', 'v0-monolith').spec.template.metadata.labels;
  assert.equal(Object.entries(allow).every(([k, v]) => appLabels[k] === v), false);

  const gwEnv = envOf(gwDep.spec.template.spec.containers[0]);
  const appEnv = envOf(find(app.objects, 'Deployment', 'v0-monolith').spec.template.spec.containers[0]);
  const appSvc = find(app.objects, 'Service', 'v0-monolith');
  assert.equal(gwEnv.PEAKET_V0_UPSTREAM, `http://${appSvc.metadata.name}.v0.svc.cluster.local:${appSvc.spec.ports[0].port}`);
  // 시험 토큰(v0-token.mjs)의 발급자, 포트 전달 주소(cluster.mjs)의 출처, 시뮬레이터 주소와 같다
  assert.equal(gwEnv.PEAKET_V0_TOKEN_ISSUER, V0_TOKEN_ISSUER);
  assert.equal(gwEnv.PEAKET_V0_ALLOWED_ORIGINS, V0_ALLOWED_ORIGINS);
  assert.equal(appEnv.PEAKET_V0_ALLOWED_ORIGINS, V0_ALLOWED_ORIGINS);
  assert.equal(appEnv.PEAKET_V0_PG_URL, V0_PG_URL);
  // 비밀은 값 파일에 없다(Secret 이름으로만)
  for (const k of ['PEAKET_V0_DATABASE_URL', 'PEAKET_V0_REDIS_URL', 'PG_SIMULATOR_SECRET_KEY', 'PEAKET_V0_TLS_KEY', 'PEAKET_V0_TLS_CERT', 'PEAKET_V0_GATEWAY_JWKS']) {
    assert.equal(k in gwEnv || k in appEnv, false, k);
  }
});
