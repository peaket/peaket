// 공용 서비스 차트(deploy/charts/peaket-service) 렌더 시험. helm은 tools.mjs가 고정 판으로 받는다.
// 실행: node --test "tools/local/*.test.mjs"  (실제 클러스터에 올려 보는 것은 tools/local/e2e/relay-takeover.e2e.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import { ensureTool } from './tools.mjs';

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
