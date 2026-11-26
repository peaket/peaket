// 공용 서비스 차트(deploy/charts/peaket-service) 렌더 시험. helm은 tools.mjs가 고정 판으로 받는다.
// 실행: node --test "tools/local/*.test.mjs"  (실제 클러스터에 올려 보는 것은 tools/local/e2e/relay-takeover.e2e.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments, parse } from 'yaml';
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
  assert.match(render([...BASE.filter((s) => !s.startsWith('env.')), 'env.PEAKET_ENV=prod', 'diagnose.bucket=peaket-diag']).error, /digest/);
  const d = render([...BASE.filter((s) => !s.startsWith('image.tag') && !s.startsWith('env.')), 'env.PEAKET_ENV=prod', 'diagnose.bucket=peaket-diag', `image.digest=sha256:${'a'.repeat(64)}`]);
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
  // create는 resourceNames로 좁힐 수 없어 이름 없는 별도 규칙으로 주고, 읽기·고치기·패치는 미리 만든 Lease 이름으로 좁힌다(OPS-08)
  assert.deepEqual(role.rules, [
    { apiGroups: ['coordination.k8s.io'], resources: ['leases'], verbs: ['create'] },
    { apiGroups: ['coordination.k8s.io'], resources: ['leases'], resourceNames: ['example-svc-outbox-relay'], verbs: ['get', 'update', 'patch'] },
  ]);
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
  return { objects: parseAllDocuments(r.stdout).map((d) => d.toJS()).filter(Boolean), text: r.stdout };
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

// --- 나가는 연결 허용 목록(docs/infra.md §9 '나가는 연결 허용 목록의 첫 구현', BUILD_ORDER PRF-192) ---

const NP_ON = [...BASE, 'service.networkPolicy.enabled=true'];
const egressValues = (yamlLines) => valuesFile(['service:', '  networkPolicy:', '    egress:', ...yamlLines.map((l) => `      ${l}`), ''].join('\n'));
const egressOf = (yamlLines, extraSets = []) => renderFiles([egressValues(yamlLines)], [...NP_ON, ...extraSets], 'example');
const DNS_EGRESS = {
  to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }, podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }],
  ports: [
    { protocol: 'UDP', port: 53 },
    { protocol: 'TCP', port: 53 },
  ],
};
const assertPublicHttpsRule = (rule) => {
  assert.deepEqual(rule.ports, [{ protocol: 'TCP', port: 443 }]);
  assert.deepEqual(rule.to.map((t) => t.ipBlock.cidr), ['0.0.0.0/0', '::/0']);
  const [v4, v6] = rule.to.map((t) => t.ipBlock.except);
  // 사설·루프백·링크 로컬(메타데이터 169.254.169.254 포함)·CGNAT·멀티캐스트·예약 대역
  for (const c of ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4']) assert.ok(v4.includes(c), c);
  for (const c of ['::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8']) assert.ok(v6.includes(c), c);
  // IPv4 사상 대역은 API 서버가 ::/0의 부분 대역으로 보지 않아 정책 전체를 거절한다(서버 드라이런 2026-11-09)
  assert.equal(v6.includes('::ffff:0:0/96'), false);
};

test('PRF192_이그레스값이없으면_Egress를넣지않아_다른서비스는나가는쪽이그대로다 [ASVS v5.0.0-13.2.4]', () => {
  const { objects, error } = render(NP_ON);
  assert.equal(error, undefined, error);
  const np = find(objects, 'NetworkPolicy', 'example-svc');
  assert.deepEqual(np.spec.policyTypes, ['Ingress']);
  assert.equal('egress' in np.spec, false);
});

test('PRF192_공인대역을켜면_클러스터DNS53과공인주소443만나가고_사설·메타데이터대역은뺀다 [ASVS v5.0.0-13.2.4] [ASVS v5.0.0-13.2.5]', () => {
  const { objects, error } = egressOf(['publicHttps: true']);
  assert.equal(error, undefined, error);
  const np = find(objects, 'NetworkPolicy', 'example-svc');
  assert.deepEqual(np.spec.policyTypes, ['Ingress', 'Egress']);
  assert.equal(np.spec.egress.length, 2);
  assert.deepEqual(np.spec.egress[0], DNS_EGRESS);
  assertPublicHttpsRule(np.spec.egress[1]);
  // 들어오는 쪽 규칙은 그대로다
  assert.deepEqual(np.spec.ingress, [mgmtRule(['observability'])]);
});

test('PRF192_공인대역규칙의_제외대역은_NAT64·문서·폐기대역까지_하나도빠지지않는다 [ASVS v5.0.0-13.2.5]', () => {
  const { objects, error } = egressOf(['publicHttps: true']);
  assert.equal(error, undefined, error);
  const [v4, v6] = find(objects, 'NetworkPolicy', 'example-svc').spec.egress[1].to.map((t) => t.ipBlock.except);
  // docs/infra.md §9 대역 정책의 '예약 대역' 전부다. NAT64(64:ff9b::/96)가 빠지면 IPv6로 사설 IPv4에 닿는 길이 열린다
  assert.deepEqual([...v4].sort(), ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4'].sort());
  assert.deepEqual([...v6].sort(), ['::1/128', '64:ff9b::/96', '64:ff9b:1::/48', '100::/64', '2001::/32', '2001:db8::/32', '2002::/16', 'fc00::/7', 'fe80::/10', 'ff00::/8'].sort());
});

test('PRF192_리뷰 고침_IPv6제외대역에_IPv4를싣는전환대역(6to4·Teredo·지역NAT64)이있다 [ASVS v5.0.0-13.2.5]', () => {
  const { objects, error } = egressOf(['publicHttps: true']);
  assert.equal(error, undefined, error);
  const v6 = find(objects, 'NetworkPolicy', 'example-svc').spec.egress[1].to[1].ipBlock.except;
  // 이 대역의 주소에는 IPv4 주소가 실려 있어, 빠지면 IPv6로 사설 IPv4에 닿는 길이 된다
  for (const c of ['2002::/16', '2001::/32', '64:ff9b:1::/48']) assert.ok(v6.includes(c), c);
});

const RELAY_NAME = 'example-svc-outbox-relay';
const RELAY_ON = ['outboxRelay.enabled=true'];

test('PRF192_리뷰 고침_릴레이파드도_서비스와같은이그레스값을받고_들어오는쪽은건드리지않는다 [ASVS v5.0.0-13.2.4] [ASVS v5.0.0-13.2.5]', () => {
  const { objects, error } = egressOf(['publicHttps: true', 'internal:', '  - cidrs: [10.20.0.0/16]', '    ports: [5432]'], RELAY_ON);
  assert.equal(error, undefined, error);
  const svc = find(objects, 'NetworkPolicy', 'example-svc');
  const relay = find(objects, 'NetworkPolicy', RELAY_NAME);
  assert.ok(relay, '릴레이 NetworkPolicy');
  assert.deepEqual(relay.spec.podSelector, { matchLabels: { 'app.kubernetes.io/name': 'example-svc', 'app.kubernetes.io/component': 'outbox-relay' } });
  // 고른 라벨을 릴레이 파드가 실제로 단다
  const labels = find(objects, 'Deployment', RELAY_NAME).spec.template.metadata.labels;
  for (const [k, v] of Object.entries(relay.spec.podSelector.matchLabels)) assert.equal(labels[k], v, k);
  assert.deepEqual(relay.spec.policyTypes, ['Egress']);
  assert.equal('ingress' in relay.spec, false);
  assert.deepEqual(relay.spec.egress, svc.spec.egress);
  // 서비스 정책은 여전히 서비스 파드만 고른다
  assert.deepEqual(svc.spec.podSelector, { matchLabels: SERVICE_PODS('example-svc') });
});

test('PRF192_리뷰 고침_릴레이정책은_서비스이그레스와같은스위치로켜진다 [ASVS v5.0.0-13.2.4]', () => {
  const relayPolicy = (r) => {
    assert.equal(r.error, undefined, r.error);
    return find(r.objects, 'NetworkPolicy', RELAY_NAME);
  };
  // 켜짐: 릴레이 + 정책 + 이그레스 값. 서비스 Deployment를 꺼도 릴레이만 열린 채 남지 않는다
  assert.ok(relayPolicy(egressOf(['publicHttps: true'], RELAY_ON)));
  assert.ok(relayPolicy(egressOf(['publicHttps: true'], [...RELAY_ON, 'service.enabled=false'])));
  // 꺼짐: 릴레이가 없거나, 이그레스 값이 없거나, 정책을 껐을 때
  assert.equal(relayPolicy(egressOf(['publicHttps: true'])), undefined);
  assert.equal(relayPolicy(render([...NP_ON, ...RELAY_ON])), undefined);
  assert.equal(relayPolicy(renderFiles([egressValues(['publicHttps: true'])], [...BASE, ...RELAY_ON], 'example')), undefined);
});

test('PRF192_리뷰 고침_안쪽대상cidrs가_전체나너무넓은대역이면_렌더하지않는다 [ASVS v5.0.0-13.2.5]', () => {
  for (const c of ['0.0.0.0/0', '::/0', '0:0:0:0:0:0:0:0/0', '1.2.3.4/0', '0.0.0.0/1', '128.0.0.0/1', '::/1', '8000::/1']) {
    assert.match(egressOf(['internal:', `  - { cidrs: ["${c}"], ports: [443] }`]).error ?? '(렌더됨)', /cidrs/, c);
  }
  // 경계: 가장 넓은 사설 대역은 받는다
  for (const c of ['10.0.0.0/8', 'fc00::/7']) assert.equal(egressOf(['internal:', `  - { cidrs: ["${c}"], ports: [5432] }`]).error, undefined, c);
});

test('PRF192_리뷰 고침_안쪽대상cidrs가_링크로컬에겹치면_렌더하지않는다(메타데이터길) [ASVS v5.0.0-13.2.5]', () => {
  for (const c of ['169.254.0.0/16', '169.254.169.254/32', '169.254.170.23/32', '169.254.169.0/24', '169.0.0.0/8']) {
    assert.match(egressOf(['internal:', `  - { cidrs: ["${c}"], ports: [80] }`]).error ?? '(렌더됨)', /allowLinkLocalCidrs/, c);
  }
  for (const c of ['fe80::/10', 'FE80::1/128', '::ffff:169.254.169.254/128']) {
    assert.match(egressOf(['internal:', `  - { cidrs: ["${c}"], ports: [80] }`]).error ?? '(렌더됨)', /cidrs/, c);
  }
  // 대역 표기가 아니면 검사를 건너뛰지 않고 멈춘다
  assert.match(egressOf(['internal:', '  - { cidrs: ["169.254.169.254"], ports: [80] }']).error ?? '(렌더됨)', /cidrs/);
});

test('PRF192_리뷰 고침_allowLinkLocalCidrs는_링크로컬호스트하나씩만받고_메타데이터주소는받지않는다 [ASVS v5.0.0-13.2.5]', () => {
  const { objects, error } = egressOf(['internal:', '  - allowLinkLocalCidrs: [169.254.170.23/32]', '    ports: [80]']);
  assert.equal(error, undefined, error);
  assert.deepEqual(find(objects, 'NetworkPolicy', 'example-svc').spec.egress, [DNS_EGRESS, { to: [{ ipBlock: { cidr: '169.254.170.23/32' } }], ports: [{ protocol: 'TCP', port: 80 }] }]);
  for (const bad of [
    '  - { allowLinkLocalCidrs: [169.254.169.254/32], ports: [80] }',
    '  - { allowLinkLocalCidrs: [169.254.0.0/16], ports: [80] }',
    '  - { allowLinkLocalCidrs: [10.0.0.1/32], ports: [80] }',
    '  - { allowLinkLocalCidrs: [169.254.170.23/32] }',
    '  - { allowLinkLocalCidrs: [169.254.170.23/32], cidrs: [10.0.0.0/8], ports: [80] }',
    '  - { allowLinkLocalCidrs: [169.254.170.23/32], namespaces: [data], ports: [80] }',
    '  - { allowLinkLocalCidrs: [169.254.170.23/32], podLabels: { app: x }, ports: [80] }',
  ]) {
    assert.match(egressOf(['internal:', bad]).error ?? '(렌더됨)', /egress/, bad);
  }
});

const repoText = (...p) => readFileSync(join(REPO, ...p), 'utf8');
const asvsRow = (text, id) => text.split(/\r?\n/).find((l) => l.startsWith(`| v5.0.0-${id} |`)).split(' | ');

test('PRF192_리뷰 고침_payment-svc값의주석이_켜는환경값이허용할안쪽대상을적는다', () => {
  const text = repoText('deploy', 'workloads', 'payment-svc', 'values.yaml');
  for (const want of ['169.254.170.23', 'allowLinkLocalCidrs', '15008', 'DB', '수집기', 'Kafka', 'API 서버']) assert.ok(text.includes(want), want);
});

test('PRF192_리뷰 고침_payment의13.2.4·13.2.5는_부분적용이고_까닭을적는다', () => {
  const text = repoText('docs', 'security', 'asvs', 'payment.md');
  for (const id of ['13.2.4', '13.2.5']) {
    const [, , , verdict, where] = asvsRow(text, id);
    assert.equal(verdict, '부분 적용', id);
    for (const want of ['환경 값', '공인', 'wbs 0.4.2', 'BUILD_ORDER PRF-192, 코드 리뷰']) assert.ok(where.includes(want), `${id}: ${want}`);
  }
});

test('PRF192_리뷰 고침_문서가_IPv4사상대역을_except로뺀다고적지않고_infra와같이적는다', () => {
  const guidelines = repoText('docs', 'api', 'guidelines.md');
  const settlement = repoText('docs', 'security', 'asvs', 'settlement.md');
  assert.equal(guidelines.includes('IPv4 사상 주소(::ffff:0:0/96)는 `ipBlock`의 `except`로 뺀다'), false);
  assert.equal(asvsRow(settlement, '13.2.4')[4].includes('IPv4 사상 대역 제외'), false);
  const webhookRow = guidelines.split(/\r?\n/).find((l) => l.startsWith('| 파트너 웹훅 (발송) |'));
  for (const [where, line] of [['guidelines', webhookRow], ['1.3.6', asvsRow(settlement, '1.3.6')[4]], ['13.2.4', asvsRow(settlement, '13.2.4')[4]]]) {
    assert.ok(line.includes('IPv4로 나가 IPv4 규칙을 받는다'), where);
  }
});

test('PRF192_리뷰 고침_ADR-0153상태줄이_공개검사허용목록변경을적는다', () => {
  const status = repoText('docs', 'adr', '0153-public-docs-scope-no-click-demo-session-canonical-browse-pages.md').split(/\r?\n/)[2];
  for (const want of ['BUILD_ORDER PRF-192', '0.0.0.0/8', '192.0.0.0/24', '224.0.0.0/4', '240.0.0.0/4']) assert.ok(status.includes(want), want);
});

test('PRF192_내부대상은_값으로받은네임스페이스·파드·대역의그포트만열고_공인대역은열지않는다 [ASVS v5.0.0-13.2.5]', () => {
  const { objects, error } = egressOf([
    'internal:',
    '  - namespaces: [data]',
    '    podLabels: { app: pgbouncer }',
    '    ports: [6432]',
    '  - podLabels: { app: cache }',
    '    ports: [6379, 6380]',
    '  - cidrs: [10.20.0.0/16]',
    '    ports: [5432]',
  ]);
  assert.equal(error, undefined, error);
  const np = find(objects, 'NetworkPolicy', 'example-svc');
  assert.deepEqual(np.spec.policyTypes, ['Ingress', 'Egress']);
  const tcp = (...ports) => ports.map((port) => ({ protocol: 'TCP', port }));
  assert.deepEqual(np.spec.egress, [
    DNS_EGRESS,
    { to: [{ namespaceSelector: { matchExpressions: [{ key: 'kubernetes.io/metadata.name', operator: 'In', values: ['data'] }] }, podSelector: { matchLabels: { app: 'pgbouncer' } } }], ports: tcp(6432) },
    { to: [{ podSelector: { matchLabels: { app: 'cache' } } }], ports: tcp(6379, 6380) },
    { to: [{ ipBlock: { cidr: '10.20.0.0/16' } }], ports: tcp(5432) },
  ]);
});

test('PRF192_대상이나포트가없는내부대상은_렌더하지않는다(빈칸은모두허용이된다) [ASVS v5.0.0-13.2.5]', () => {
  for (const bad of [
    ['internal:', '  - { podLabels: { app: x } }'],
    ['internal:', '  - { ports: [443] }'],
    ['internal:', '  - { namespaces: [], podLabels: {}, ports: [443] }'],
    ['internal:', '  - { cidrs: [10.0.0.0/8], podLabels: { app: x }, ports: [443] }'],
    ['internal:', '  - { cidrs: [10.0.0.0/8], namespaces: [data], ports: [443] }'],
  ]) {
    assert.match(egressOf(bad).error ?? '(렌더됨)', /egress/, bad.join(' '));
  }
});

test('PRF202_leaderLease를주면_그Lease하나의권한과토큰만_서비스파드에붙는다(만들기없음) [ASVS v5.0.0-13.2.2]', () => {
  const { objects, error } = render([...BASE, 'service.leaderLease=payment-entry-pause'], 'payment');
  assert.equal(error, undefined, error);
  const lease = find(objects, 'Lease', 'payment-entry-pause');
  assert.ok(lease, 'Lease');
  // spec을 차트에 적지 않아 배포가 보유자를 지우지 않는다(릴레이와 같다)
  assert.deepEqual(lease.spec, {});
  const role = find(objects, 'Role', 'example-svc-leader-lease');
  assert.deepEqual(role.rules, [
    { apiGroups: ['coordination.k8s.io'], resources: ['leases'], verbs: ['create'] },
    { apiGroups: ['coordination.k8s.io'], resources: ['leases'], resourceNames: ['payment-entry-pause'], verbs: ['get', 'update', 'patch'] },
  ]);
  const binding = find(objects, 'RoleBinding', 'example-svc-leader-lease');
  assert.deepEqual(binding.subjects, [{ kind: 'ServiceAccount', name: 'example-svc', namespace: 'payment' }]);
  const dep = find(objects, 'Deployment', 'example-svc');
  assert.equal(dep.spec.template.spec.automountServiceAccountToken, true);
  assert.equal(find(objects, 'ServiceAccount', 'example-svc').automountServiceAccountToken, false);
});

test('PRF202_leaderLease가없으면_Lease·권한이없고_토큰도없다(다른서비스출력불변) [ASVS v5.0.0-13.2.2]', () => {
  const { objects, error } = render(BASE, 'example');
  assert.equal(error, undefined, error);
  assert.equal(all(objects, 'Lease').length, 0);
  assert.equal(all(objects, 'Role').length, 0);
  assert.equal(all(objects, 'RoleBinding').length, 0);
  assert.equal(find(objects, 'Deployment', 'example-svc').spec.template.spec.automountServiceAccountToken, false);
});

test('PRF202_payment-svc값_정지판정자Lease이름과_정책을켤때적을API서버·Prometheus를값파일이알린다 [ASVS v5.0.0-13.2.4]', () => {
  const file = join(REPO, 'deploy', 'workloads', 'payment-svc', 'values.yaml');
  const sets = ['image.repository=peaket/payment-svc', 'image.tag=local', 'env.PEAKET_ENV=local'];
  const { objects, error } = renderFiles([file], sets, 'payment');
  assert.equal(error, undefined, error);
  assert.ok(find(objects, 'Lease', 'payment-entry-pause'), 'Lease');
  assert.equal(find(objects, 'Deployment', 'payment-svc').spec.template.spec.automountServiceAccountToken, true);
  const text = repoText('deploy', 'workloads', 'payment-svc', 'values.yaml');
  for (const want of ['PEAKET_PROMETHEUS_URL', 'Prometheus', 'API 서버']) assert.ok(text.includes(want), want);
  const internal = 'service.networkPolicy.egress.internal[0].namespaces[0]=observability,service.networkPolicy.egress.internal[0].ports[0]=9090,service.networkPolicy.egress.internal[1].cidrs[0]=10.0.0.1/32,service.networkPolicy.egress.internal[1].ports[0]=443';
  const on = renderFiles([file], [...sets, 'service.networkPolicy.enabled=true', internal], 'payment');
  assert.equal(on.error, undefined, on.error);
  const peers = find(on.objects, 'NetworkPolicy', 'payment-svc').spec.egress.flatMap((r) => (r.ports ?? []).map((p) => p.port));
  for (const port of [9090, 443]) assert.ok(peers.includes(port), String(port));
});

test('PRF192_payment-svc값_결제사출구는DNS와공인주소443이고_정책을켜는것은환경값이다 [ASVS v5.0.0-13.2.4]', () => {
  const file = join(REPO, 'deploy', 'workloads', 'payment-svc', 'values.yaml');
  const sets = ['image.repository=peaket/payment-svc', 'image.tag=local', 'env.PEAKET_ENV=local'];
  const off = renderFiles([file], sets, 'payment');
  assert.equal(off.error, undefined, off.error);
  assert.ok(find(off.objects, 'Deployment', 'payment-svc'), 'Deployment payment-svc');
  assert.equal(all(off.objects, 'NetworkPolicy').length, 0);
  const on = renderFiles([file], [...sets, 'service.networkPolicy.enabled=true'], 'payment');
  assert.equal(on.error, undefined, on.error);
  const np = find(on.objects, 'NetworkPolicy', 'payment-svc');
  assert.deepEqual(np.spec.policyTypes, ['Ingress', 'Egress']);
  assert.deepEqual(np.spec.egress[0], DNS_EGRESS);
  assertPublicHttpsRule(np.spec.egress[1]);
});

/**
 * 승인 실행기가 돌던 호출을 끝내는 최악(ms)을 payment-svc 코드 상수로 센다(W9-fix2 계획 §9, 리뷰 R1):
 * 호출 한도 CONFIRM_CALL_GUARD_MS + 결과 쓰기 (다시 하기 수 + 1)번 × 문장 한도 CONFIRM_RUNNER_STATEMENT_TIMEOUT_MS + 다시 하기 쉬기 합.
 * 숫자를 박지 않고 소스 글에서 읽는다(상수를 바꾸면 이 시험이 따라 깨진다). 못 찾으면 실패한다
 */
function confirmRunnerWorstMs() {
  const src = repoText('services', 'payment-svc', 'src', 'modules', 'payment', 'domain', 'confirm-runner.ts');
  const num = (name) => {
    const m = new RegExp(`export const ${name}\\s*=\\s*([\\d_]+)\\s*;`).exec(src);
    assert.ok(m, `confirm-runner.ts에 ${name}이 없다`);
    return Number(m[1].replaceAll('_', ''));
  };
  const delays = /export const CONFIRM_FINISH_RETRY_DELAYS_MS[^=]*=\s*Object\.freeze\(\[([\d_,\s]+)\]\)/.exec(src);
  assert.ok(delays, 'confirm-runner.ts에 CONFIRM_FINISH_RETRY_DELAYS_MS가 없다');
  const waits = delays[1].split(',').map((x) => Number(x.trim().replaceAll('_', ''))).filter((x) => Number.isFinite(x));
  return num('CONFIRM_CALL_GUARD_MS') + (waits.length + 1) * num('CONFIRM_RUNNER_STATEMENT_TIMEOUT_MS') + waits.reduce((a, b) => a + b, 0);
}
/** 합본 자식 대기 상수(ms)를 services/bundle/src/stop-child.ts 소스 글에서 읽는다(못 찾으면 실패) */
function bundleChildStopMs(name) {
  const src = repoText('services', 'bundle', 'src', 'stop-child.ts');
  const m = new RegExp(`export const ${name}\\s*=\\s*([\\d_]+)\\s*;`).exec(src);
  assert.ok(m, `stop-child.ts에 ${name}이 없다`);
  return Number(m[1].replaceAll('_', ''));
}

test('PRF181_payment-svc 종료 유예는 코드 상수로 센 실행기 최악 + preStop + 여유 이상이고 릴레이는 30초다', () => {
  // 정본: docs/devops.md §6.4 '일반 서비스', docs/features/payment.md §2 '잡기'(W9-fix2 §9 보충): 105초 [가정] = preStop 5 + 실행기 최악 87.5 + 닫기 여유 약 12.5
  const worstMs = confirmRunnerWorstMs();
  const file = join(REPO, 'deploy', 'workloads', 'payment-svc', 'values.yaml');
  const sets = ['image.repository=peaket/payment-svc', 'image.tag=local', 'env.PEAKET_ENV=local', 'outboxRelay.enabled=true'];
  const { objects, error } = renderFiles([file], sets, 'payment');
  assert.equal(error, undefined, error);
  const svc = find(objects, 'Deployment', 'payment-svc');
  assert.ok(svc, 'Deployment payment-svc');
  const spec = svc.spec.template.spec;
  const preStop = spec.containers[0].lifecycle.preStop.sleep.seconds;
  assert.ok(spec.terminationGracePeriodSeconds >= preStop + worstMs / 1000 + 10, `종료 유예 ${spec.terminationGracePeriodSeconds} < preStop ${preStop} + 실행기 최악 ${worstMs / 1000} + 10`);
  assert.equal(spec.terminationGracePeriodSeconds, 105);
  // 릴레이는 승인 호출을 하지 않아 차트 기본 30초 그대로다
  const relay = find(objects, 'Deployment', 'payment-svc-outbox-relay');
  assert.ok(relay, 'Deployment payment-svc-outbox-relay');
  assert.equal(relay.spec.template.spec.terminationGracePeriodSeconds, 30);
  const relayOnly = renderFiles([join(ENVS, 'v1-payment-relay.yaml')], [], 'v1');
  assert.equal(relayOnly.error, undefined, relayOnly.error);
  assert.equal(find(relayOnly.objects, 'Deployment', 'payment-svc-outbox-relay').spec.template.spec.terminationGracePeriodSeconds, 30);
});

test('PRF181_합본 종료 유예는 자식 대기 합과 preStop보다 길다', () => {
  // 정본: W9-fix2 계획 §9 보충, docs/devops.md §6.4. 125초 [가정] = preStop 5 + 같은 프로세스 서비스 닫기 약 10 + 자식 차례대로(purchase-svc 5 + payment-svc 95 + 홀드 작업자 5) + 여유 5
  const SAME_PROCESS_CLOSE_S = 10;
  /** payment-svc 밖의 자식 수(split 합본: purchase-svc·hold-worker, services/bundle/src/main.ts spawnChild) */
  const OTHER_CHILDREN = 2;
  const otherMs = bundleChildStopMs('BUNDLE_CHILD_STOP_MS');
  const paymentMs = bundleChildStopMs('BUNDLE_PAYMENT_CHILD_STOP_MS');
  const worstMs = confirmRunnerWorstMs();
  const bundle = renderFiles([join(ENVS, 'v1-bundle.yaml')], [], 'v1');
  assert.equal(bundle.error, undefined, bundle.error);
  const dep = find(bundle.objects, 'Deployment', 'bundle');
  const c = dep.spec.template.spec.containers[0];
  assert.match(envOf(c).PEAKET_BUNDLE_SERVICES, /(^|,)payment-svc(,|$)/);
  assert.equal(envOf(c).PEAKET_BUNDLE_MODE, 'split');
  const grace = dep.spec.template.spec.terminationGracePeriodSeconds;
  const preStop = c.lifecycle.preStop.sleep.seconds;
  const need = preStop + SAME_PROCESS_CLOSE_S + (OTHER_CHILDREN * otherMs + paymentMs) / 1000;
  assert.ok(grace >= need, `합본 종료 유예 ${grace} < ${need}`);
  assert.equal(grace, 125);
  // payment-svc 자식 대기는 실행기 최악 + 5초 이상이고 파드 유예보다 짧다(유예 안에 SIGKILL까지 끝난다)
  assert.ok(paymentMs >= worstMs + 5_000, `payment-svc 자식 대기 ${paymentMs} < 실행기 최악 ${worstMs} + 5,000`);
  assert.ok(paymentMs / 1000 < grace, `payment-svc 자식 대기 ${paymentMs} ≥ 합본 유예 ${grace}초`);
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

test('PRF215_leaderLease에_목록을주면_Lease마다_만들고_Role이_그이름들만_읽고고친다(합본은 둘을 잡는다) [ASVS v5.0.0-13.2.2]', () => {
  const { objects, error } = render([...BASE, 'service.leaderLease={admission-ctrl,payment-entry-pause}'], 'v1');
  assert.equal(error, undefined, error);
  assert.deepEqual(all(objects, 'Lease').map((l) => l.metadata.name).sort(), ['admission-ctrl', 'payment-entry-pause']);
  for (const l of all(objects, 'Lease')) assert.deepEqual(l.spec, {});
  assert.equal(all(objects, 'Role').length, 1);
  assert.deepEqual(find(objects, 'Role', 'example-svc-leader-lease').rules, [
    { apiGroups: ['coordination.k8s.io'], resources: ['leases'], verbs: ['create'] },
    { apiGroups: ['coordination.k8s.io'], resources: ['leases'], resourceNames: ['admission-ctrl', 'payment-entry-pause'], verbs: ['get', 'update', 'patch'] },
  ]);
  assert.equal(find(objects, 'Deployment', 'example-svc').spec.template.spec.automountServiceAccountToken, true);
});

test('PRF215_leaderLease_빈목록은_없는것과같고_겹친이름·틀린이름은_렌더하지_않는다 [ASVS v5.0.0-13.2.2]', () => {
  const empty = render([...BASE, 'service.leaderLease=null'], 'v1');
  assert.equal(empty.error, undefined, empty.error);
  assert.equal(all(empty.objects, 'Lease').length, 0);
  assert.equal(find(empty.objects, 'Deployment', 'example-svc').spec.template.spec.automountServiceAccountToken, false);
  assert.match(render([...BASE, 'service.leaderLease={a-lease,a-lease}']).error ?? '(렌더됨)', /두 번/);
  assert.match(render([...BASE, 'service.leaderLease={Bad_Name}']).error ?? '(렌더됨)', /DNS-1123/);
});

test('PRF215_extraPorts는_컨테이너포트와_Service포트를_함께열고_앱·관리포트나_서로와_겹치면_렌더하지_않는다', () => {
  const { objects, error } = render([...BASE, 'service.extraPorts[0].name=purchase', 'service.extraPorts[0].port=8081', 'service.extraPorts[1].name=admission', 'service.extraPorts[1].port=8082']);
  assert.equal(error, undefined, error);
  const c = find(objects, 'Deployment', 'example-svc').spec.template.spec.containers[0];
  assert.deepEqual(c.ports, [{ name: 'http', containerPort: 8080 }, { name: 'management', containerPort: 9464 }, { name: 'purchase', containerPort: 8081 }, { name: 'admission', containerPort: 8082 }]);
  assert.deepEqual(find(objects, 'Service', 'example-svc').spec.ports, [{ name: 'http', port: 8080, targetPort: 'http' }, { name: 'purchase', port: 8081, targetPort: 'purchase' }, { name: 'admission', port: 8082, targetPort: 'admission' }]);
  assert.match(render([...BASE, 'service.extraPorts[0].name=dup', 'service.extraPorts[0].port=8080']).error ?? '(렌더됨)', /service\.port와 겹친다/);
  assert.match(render([...BASE, 'service.extraPorts[0].name=dup', 'service.extraPorts[0].port=9464']).error ?? '(렌더됨)', /managementPort와 겹친다/);
  assert.match(render([...BASE, 'service.extraPorts[0].name=a', 'service.extraPorts[0].port=8090', 'service.extraPorts[1].name=b', 'service.extraPorts[1].port=8090']).error ?? '(렌더됨)', /a와 겹친다/);
  assert.match(render([...BASE, 'service.extraPorts[0].name=a', 'service.extraPorts[0].port=8090', 'service.extraPorts[1].name=a', 'service.extraPorts[1].port=8091']).error ?? '(렌더됨)', /name a가 겹친다/);
  assert.match(render([...BASE, 'service.extraPorts[0].name=management', 'service.extraPorts[0].port=8090']).error ?? '(렌더됨)', /name management가 겹친다/);
  assert.match(render([...BASE, 'service.extraPorts[0].name=a', 'service.extraPorts[0].port=0']).error ?? '(렌더됨)', /1~65535/);
  assert.match(render([...BASE, 'service.extraPorts[0].name=Upper', 'service.extraPorts[0].port=8090']).error ?? '(렌더됨)', /소문자/);
  // 주지 않으면 지금과 같다
  assert.deepEqual(find(render(BASE).objects, 'Service', 'example-svc').spec.ports, [{ name: 'http', port: 8080, targetPort: 'http' }]);
});

test('PRF215_volumes·volumeMounts를_주면_tmp뒤에_그대로붙이고_주지않으면_tmp하나다', () => {
  const { objects, error } = render([...BASE, 'service.volumes[0].name=envs', 'service.volumes[0].secret.secretName=v1-bundle-env', 'service.volumeMounts[0].name=envs', 'service.volumeMounts[0].mountPath=/etc/peaket/bundle', 'service.volumeMounts[0].readOnly=true']);
  assert.equal(error, undefined, error);
  const spec = find(objects, 'Deployment', 'example-svc').spec.template.spec;
  // 진단 수집 볼륨 둘(/diag·주석 파일)은 늘 tmp 바로 뒤에 붙는다(ADR-0070 결정 1, ADR-0303 결정 3, BAT-075 시험 이의 TO-1)
  assert.deepEqual(spec.volumes, [{ name: 'tmp', emptyDir: { sizeLimit: '64Mi' } }, { name: 'diag', emptyDir: { sizeLimit: '1024Mi' } }, { name: 'podinfo', downwardAPI: { items: [{ path: 'annotations', fieldRef: { fieldPath: 'metadata.annotations' } }] } }, { name: 'envs', secret: { secretName: 'v1-bundle-env' } }]);
  assert.deepEqual(spec.containers[0].volumeMounts, [{ name: 'tmp', mountPath: '/tmp' }, { name: 'diag', mountPath: '/diag' }, { name: 'podinfo', mountPath: '/etc/podinfo', readOnly: true }, { name: 'envs', mountPath: '/etc/peaket/bundle', readOnly: true }]);
  const plain = find(render(BASE).objects, 'Deployment', 'example-svc').spec.template.spec;
  assert.deepEqual(plain.volumes, [{ name: 'tmp', emptyDir: { sizeLimit: '64Mi' } }, { name: 'diag', emptyDir: { sizeLimit: '1024Mi' } }, { name: 'podinfo', downwardAPI: { items: [{ path: 'annotations', fieldRef: { fieldPath: 'metadata.annotations' } }] } }]);
});

test('PRF215_outboxRelay.volumes·volumeMounts를_주면_릴레이파드에만_tmp뒤로붙인다', () => {
  const sets = [...BASE, 'outboxRelay.enabled=true', 'outboxRelay.volumes[0].name=seatmaps', 'outboxRelay.volumes[0].hostPath.path=/var/local/x', 'outboxRelay.volumeMounts[0].name=seatmaps', 'outboxRelay.volumeMounts[0].mountPath=/etc/peaket/seatmaps'];
  const { objects, error } = render(sets, 'v1');
  assert.equal(error, undefined, error);
  const relay = find(objects, 'Deployment', 'example-svc-outbox-relay').spec.template.spec;
  // 릴레이 메모리 한도 384Mi → /diag 768Mi(BAT-075 시험 이의 TO-1)
  assert.deepEqual(relay.volumes, [{ name: 'tmp', emptyDir: { sizeLimit: '64Mi' } }, { name: 'diag', emptyDir: { sizeLimit: '768Mi' } }, { name: 'podinfo', downwardAPI: { items: [{ path: 'annotations', fieldRef: { fieldPath: 'metadata.annotations' } }] } }, { name: 'seatmaps', hostPath: { path: '/var/local/x' } }]);
  assert.deepEqual(relay.containers[0].volumeMounts, [{ name: 'tmp', mountPath: '/tmp' }, { name: 'diag', mountPath: '/diag' }, { name: 'podinfo', mountPath: '/etc/podinfo', readOnly: true }, { name: 'seatmaps', mountPath: '/etc/peaket/seatmaps' }]);
  assert.deepEqual(find(objects, 'Deployment', 'example-svc').spec.template.spec.volumes, [{ name: 'tmp', emptyDir: { sizeLimit: '64Mi' } }, { name: 'diag', emptyDir: { sizeLimit: '1024Mi' } }, { name: 'podinfo', downwardAPI: { items: [{ path: 'annotations', fieldRef: { fieldPath: 'metadata.annotations' } }] } }]);
});

test('PRF215_코드리뷰S1_볼륨은_secret·configMap·emptyDir만받고_hostPath는_PEAKET_ENV_local·ci에서만이며_projected·그밖의종류는_렌더하지_않는다 [ASVS v5.0.0-13.2.2]', () => {
  const PROD = ['name=example-svc', 'image.repository=peaket/example-svc', `image.digest=sha256:${'a'.repeat(64)}`, 'env.PEAKET_ENV=staging', 'diagnose.bucket=peaket-diag'];
  const vol = (where, i, kind, field, value) => [`${where}[${i}].name=v${i}`, `${where}[${i}].${kind}.${field}=${value}`];
  for (const where of ['service.volumes', 'outboxRelay.volumes']) {
    const relay = where.startsWith('outboxRelay') ? ['outboxRelay.enabled=true'] : [];
    // 받는 종류: secret·configMap·emptyDir(운영 환경 값에서도)
    const ok = render([...PROD, ...relay, ...vol(where, 0, 'secret', 'secretName', 's'), ...vol(where, 1, 'configMap', 'name', 'c'), ...vol(where, 2, 'emptyDir', 'sizeLimit', '1Mi')]);
    assert.equal(ok.error, undefined, ok.error);
    // hostPath는 local·ci에서만
    assert.equal(render([...BASE, ...relay, ...vol(where, 0, 'hostPath', 'path', '/var/local/x')]).error, undefined, `${where} local hostPath`);
    // local·ci 밖은 모두 거부한다(staging 하나만 보면 prod·demo를 허용 목록에 더한 결함을 놓친다, 변이 검토 PRF-215)
    for (const env of ['staging', 'prod', 'demo', 'dev']) {
      const sets = [...PROD.filter((s) => !s.startsWith('env.PEAKET_ENV=')), `env.PEAKET_ENV=${env}`, ...relay, ...vol(where, 0, 'hostPath', 'path', '/var/local/x')];
      assert.match(render(sets).error ?? '(렌더됨)', /hostPath.*local·ci/, `${where} ${env} hostPath`);
    }
    // 받지 않는 종류: projected(서비스 계정 토큰을 붙일 수 있다)·PVC·그밖
    assert.match(render([...BASE, ...relay, `${where}[0].name=p`, `${where}[0].projected.sources[0].serviceAccountToken.path=token`]).error ?? '(렌더됨)', /projected/, `${where} projected`);
    assert.match(render([...BASE, ...relay, ...vol(where, 0, 'persistentVolumeClaim', 'claimName', 'x')]).error ?? '(렌더됨)', /persistentVolumeClaim/, `${where} pvc`);
    // 종류 둘을 한 칸에 적거나 이름이 없으면 렌더하지 않는다
    assert.match(render([...BASE, ...relay, ...vol(where, 0, 'secret', 'secretName', 's'), `${where}[0].emptyDir.sizeLimit=1Mi`]).error ?? '(렌더됨)', /종류 하나/, `${where} 둘`);
    assert.match(render([...BASE, ...relay, `${where}[0].secret.secretName=s`]).error ?? '(렌더됨)', /name/, `${where} 이름 없음`);
  }
});

// --- BAS-080 프로브 값과 진단 실행 옵션(docs/architecture.md §5 '프로브 규칙', docs/devops.md D-T19 ③·D-T18 ①, ADR-0070 결정 1, ADR-0303) ---

const containersOf = (objects) => [
  ['service', find(objects, 'Deployment', 'example-svc').spec.template.spec],
  ['relay', find(objects, 'Deployment', 'example-svc-outbox-relay').spec.template.spec],
];
const probeValues = (p) => ({ path: p.httpGet.path, port: p.httpGet.port, period: p.periodSeconds, timeout: p.timeoutSeconds ?? 1, failure: p.failureThreshold });

test('D-T19 ③_서비스·릴레이파드의_준비프로브는ready_5초·3초·6번_생존은livez_10초·5초·6번_시작은livez_2초·30번이다', () => {
  const { objects, error } = render([...BASE, 'outboxRelay.enabled=true']);
  assert.equal(error, undefined, error);
  for (const [where, spec] of containersOf(objects)) {
    const c = spec.containers[0];
    assert.deepEqual(probeValues(c.readinessProbe), { path: '/ready', port: 'management', period: 5, timeout: 3, failure: 6 }, `${where} 준비`);
    assert.deepEqual(probeValues(c.livenessProbe), { path: '/livez', port: 'management', period: 10, timeout: 5, failure: 6 }, `${where} 생존`);
    assert.deepEqual({ path: c.startupProbe.httpGet.path, period: c.startupProbe.periodSeconds, failure: c.startupProbe.failureThreshold }, { path: '/livez', period: 2, failure: 30 }, `${where} 시작`);
  }
});

const DIAG_FLAGS = ['--disable-sigusr1', '--report-on-fatalerror', '--report-exclude-env', '--report-exclude-network', '--report-directory=/diag'];

test('D-T18 ①_서비스·릴레이컨테이너는_진단실행옵션다섯과_힙상한(한도512Mi면384)·diag한도1024Mi·주석DownwardAPI파일·메모리한도값을받는다', () => {
  const { objects, error } = render([...BASE, 'outboxRelay.enabled=true', 'service.resources.limits.memory=512Mi', 'outboxRelay.resources.limits.memory=1Gi']);
  assert.equal(error, undefined, error);
  for (const [where, spec] of containersOf(objects)) {
    // 서비스 512Mi → 힙 384·/diag 1024Mi, 릴레이 1Gi → 힙 768·/diag 2048Mi
    const [heapMi, diagMi] = where === 'service' ? [384, '1024Mi'] : [768, '2048Mi'];
    const c = spec.containers[0];
    const nodeOptions = c.env.filter((e) => e.name === 'NODE_OPTIONS');
    assert.equal(nodeOptions.length, 1, `${where} NODE_OPTIONS 하나`);
    const flags = nodeOptions[0].value.split(/\s+/);
    for (const f of DIAG_FLAGS) assert.ok(flags.includes(f), `${where} ${f}`);
    assert.deepEqual(flags.filter((f) => f.startsWith('--max-old-space-size=')), [`--max-old-space-size=${heapMi}`], `${where} 힙 상한`);
    const env = envOf(c);
    assert.deepEqual(env.PEAKET_MEMORY_LIMIT_BYTES, { resourceFieldRef: { resource: 'limits.memory', divisor: '1' } }, `${where} 메모리 한도 값`);
    assert.equal(env.PEAKET_DIAG_DIR, '/diag', where);
    // /diag emptyDir(한도는 메모리 한도의 두 배)와 주석 파일(Downward API)이 붙고, 환경 값이 그 파일을 가리킨다
    const diag = spec.volumes.find((v) => v.name === c.volumeMounts.find((m) => m.mountPath === '/diag')?.name);
    assert.deepEqual(diag, { name: 'diag', emptyDir: { sizeLimit: diagMi } }, `${where} /diag`);
    const file = env.PEAKET_DIAG_ANNOTATIONS_FILE;
    const mount = c.volumeMounts.find((m) => typeof file === 'string' && file.startsWith(`${m.mountPath}/`));
    assert.ok(mount, `${where} 주석 파일 자리`);
    assert.equal(mount.readOnly, true, `${where} 주석 파일은 읽기 전용`);
    const podinfo = spec.volumes.find((v) => v.name === mount.name);
    assert.deepEqual(podinfo.downwardAPI.items, [{ path: file.slice(mount.mountPath.length + 1), fieldRef: { fieldPath: 'metadata.annotations' } }], `${where} Downward API`);
  }
});

test('D-T18 ①_값으로준NODE_OPTIONS는_안전옵션앞에붙고_틀린메모리한도글이나없는한도는렌더하지않는다(SEC-02)', () => {
  const { objects, error } = render([...BASE, 'outboxRelay.enabled=true', 'env.NODE_OPTIONS=--enable-source-maps', 'service.env.NODE_OPTIONS=--trace-warnings']);
  assert.equal(error, undefined, error);
  for (const [where, spec] of containersOf(objects)) {
    const values = spec.containers[0].env.filter((e) => e.name === 'NODE_OPTIONS');
    assert.equal(values.length, 1, where);
    const flags = values[0].value.split(/\s+/);
    // 안전 옵션 다섯은 값으로 준 옵션보다 뒤에 온다(같은 옵션은 뒤의 것이 이긴다, ADR-0303 결정 3)
    const lastUser = Math.max(flags.indexOf('--enable-source-maps'), flags.indexOf('--trace-warnings'));
    for (const f of DIAG_FLAGS) assert.ok(flags.indexOf(f) > lastUser, `${where} ${f}는 값 뒤`);
    assert.ok(flags.includes('--enable-source-maps'), where);
    assert.equal(flags.includes('--trace-warnings'), where === 'service', where);
  }
  assert.match(render([...BASE, 'service.resources.limits.memory=0.5G']).error ?? '(렌더됨)', /memory/);
  assert.match(render([...BASE, 'service.resources.limits.memory=null']).error ?? '(렌더됨)', /memory/);
});

// --- BAT-075 리뷰 반영(SEC-01·SEC-02·SEC-06, ADR-0303 결정 3·'남는 것') ---

const STAGING = ['name=example-svc', 'image.repository=peaket/example-svc', `image.digest=sha256:${'a'.repeat(64)}`];

test('D-T18 ①_local·ci밖에서는_증거버킷diagnose.bucket이없으면_렌더하지않는다(SEC-06, demo포함)', () => {
  for (const env of ['staging', 'prod', 'demo']) {
    assert.match(render([...STAGING, `env.PEAKET_ENV=${env}`]).error ?? '(렌더됨)', /diagnose\.bucket/, `${env} 버킷 없음`);
    const ok = render([...STAGING, `env.PEAKET_ENV=${env}`, 'diagnose.bucket=peaket-diag']);
    assert.equal(ok.error, undefined, `${env} 버킷 있음: ${ok.error}`);
    assert.equal(envOf(find(ok.objects, 'Deployment', 'example-svc').spec.template.spec.containers[0]).PEAKET_DIAG_BUCKET, 'peaket-diag');
  }
  // local·ci는 버킷 없이도 렌더한다(서비스가 경고 한 줄과 함께 수집을 끈다)
  for (const env of ['local', 'ci']) assert.equal(render([...BASE.filter((s) => !s.startsWith('env.')), `env.PEAKET_ENV=${env}`]).error, undefined, env);
});

test('D-T18 ①_흉내S3주소diagnose.s3Endpoint는_local·ci에서만받고_그밖에서는렌더하지않는다(SEC-01) [ASVS v5.0.0-14.2.1]', () => {
  for (const env of ['staging', 'prod', 'demo']) {
    const r = render([...STAGING, `env.PEAKET_ENV=${env}`, 'diagnose.bucket=peaket-diag', 'diagnose.s3Endpoint=http://aws.peaket-local.svc.cluster.local:5000']);
    assert.match(r.error ?? '(렌더됨)', /s3Endpoint/, env);
  }
  const local = render([...BASE, 'diagnose.bucket=peaket-diag', 'diagnose.s3Endpoint=http://aws.peaket-local.svc.cluster.local:5000']);
  assert.equal(local.error, undefined, local.error);
  assert.equal(envOf(find(local.objects, 'Deployment', 'example-svc').spec.template.spec.containers[0]).PEAKET_DIAG_S3_ENDPOINT, 'http://aws.peaket-local.svc.cluster.local:5000');
});

test('D-T18 ①_값으로준NODE_OPTIONS에_안전옵션을끄는값이있으면_밑줄꼴도_렌더하지않는다(SEC-02, SR-01) [ASVS v5.0.0-14.2.1]', () => {
  const unsafe = [
    '--no-disable-sigusr1', '--no-report-exclude-env', '--no-report-exclude-network', '--no-report-on-fatalerror', '--inspect', '--inspect=0.0.0.0:9229', '--inspect-brk', '--inspect-wait',
    // Node는 옵션 이름의 '_'를 '-'로 읽는다: 밑줄 꼴도 같은 옵션이다(보안 다시 보기 SR-01)
    '--inspect_brk=0.0.0.0:9229', '--inspect_wait', '--no_report_exclude_env', '--no_disable_sigusr1', '--no-report_exclude_network', '--no_report_on_fatalerror',
  ];
  for (const flag of unsafe) {
    for (const [where, sets] of [
      ['env', [`env.NODE_OPTIONS=${flag}`]],
      ['service.env', [`service.env.NODE_OPTIONS=--enable-source-maps ${flag}`]],
      ['outboxRelay.env', ['outboxRelay.enabled=true', `outboxRelay.env.NODE_OPTIONS=${flag}`]],
    ]) {
      assert.notEqual(render([...BASE, ...sets]).error, undefined, `${where} ${flag}가 렌더됐다`);
    }
  }
  // 안전 옵션을 끄지 않는 값은 받는다
  assert.equal(render([...BASE, 'service.env.NODE_OPTIONS=--enable-source-maps --trace-warnings']).error, undefined);
});

test('D-T18 ①_local·ci밖에서는_S3주소를바꾸는AWS_ENDPOINT_URL*·AWS_CONFIG_FILE값이있으면_렌더하지않는다(SR-02) [ASVS v5.0.0-14.2.1]', () => {
  const names = ['AWS_ENDPOINT_URL_S3', 'AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_KMS', 'AWS_CONFIG_FILE'];
  for (const env of ['staging', 'prod', 'demo']) {
    const base = [...STAGING, `env.PEAKET_ENV=${env}`, 'diagnose.bucket=peaket-diag'];
    assert.equal(render(base).error, undefined, `${env} 기본`);
    for (const name of names) {
      const value = name === 'AWS_CONFIG_FILE' ? '/etc/peaket/aws-config' : 'http://evil.example:9000';
      for (const [where, sets] of [
        ['env', [`env.${name}=${value}`]],
        ['service.env', [`service.env.${name}=${value}`]],
        ['outboxRelay.env', ['outboxRelay.enabled=true', `outboxRelay.env.${name}=${value}`]],
      ]) {
        assert.notEqual(render([...base, ...sets]).error, undefined, `${env} ${where}.${name}가 렌더됐다`);
      }
    }
  }
  // local·ci는 흉내 서버 주소로 쓸 수 있다
  assert.equal(render([...BASE, 'service.env.AWS_ENDPOINT_URL_S3=http://aws.peaket-local.svc.cluster.local:5000']).error, undefined);
});

// --- BAS-140 공용 차트 확장: Rollout·PDB·KEDA·ExternalSecret·우선순위(묶음 BAT-080 G3, ADR-0311) ---
// 정본: docs/devops.md §5.2·§6.2, docs/infra.md §4, docs/observability.md §5 G-21, 계획 BAT-080 B8·B9·12.
// 값은 정본에서 적는다(롤아웃 10%·50%·100%, 일시 정지 60·120초 [가정], revisionHistoryLimit 5, rollbackWindow.revisions 3,
// PDB maxUnavailable 1, KEDA fallback.failureThreshold 3·replicas -1, ExternalSecret external-secrets.io/v1 [가정]).

const ROLLOUT_ON = [...BASE, 'service.rollout.enabled=true'];

test('CH-01 Rollout을켜면_Deployment없이Rollout하나이고_카나리5·25·50·100%·일시정지300초·revisionHistoryLimit5·rollbackWindow3이다', () => {
  const { objects, error } = render(ROLLOUT_ON);
  assert.equal(error, undefined, error);
  assert.equal(all(objects, 'Deployment').filter((o) => o.metadata.name === 'example-svc').length, 0, 'Rollout과 Deployment가 함께 렌더됐다');
  const rollouts = all(objects, 'Rollout');
  assert.equal(rollouts.length, 1, 'Rollout 하나');
  const r = rollouts[0];
  assert.equal(r.apiVersion, 'argoproj.io/v1alpha1');
  assert.equal(r.metadata.name, 'example-svc');
  assert.equal(r.spec.revisionHistoryLimit, 5);
  assert.deepEqual(r.spec.strategy.canary.steps, [
    { setWeight: 5, pause: { duration: '300s' } },
    { setWeight: 25, pause: { duration: '300s' } },
    { setWeight: 50, pause: { duration: '300s' } },
    { setWeight: 100 },
  ]);
  assert.equal(r.spec.strategy.canary.rollbackWindow.revisions, 3);
  // 파드 템플릿(프로브·진단·포트·계정)은 Deployment와 같다
  const dep = find(render(BASE).objects, 'Deployment', 'example-svc');
  assert.deepEqual(r.spec.template.spec, dep.spec.template.spec);
  assert.deepEqual(r.spec.template.metadata.labels, dep.spec.template.metadata.labels);
  assert.deepEqual(r.spec.selector.matchLabels, dep.spec.selector.matchLabels);
  // 단계 순서와 값의 경계: 0%는 받지 않고, 일시 정지 없이 100%로 끝난다(마지막 단계에 pause가 붙으면 끝나지 않는다)
  assert.equal(r.spec.strategy.canary.steps.at(-1).setWeight, 100);
  assert.equal('pause' in r.spec.strategy.canary.steps.at(-1), false);
});

test('CH-02 Rollout기본값(false)은_지금처럼Deployment하나이고_HPA·NetworkPolicy·릴레이렌더가그대로다', () => {
  for (const sets of [BASE, [...BASE, 'service.rollout.enabled=false']]) {
    const { objects, error } = render(sets);
    assert.equal(error, undefined, error);
    assert.equal(all(objects, 'Rollout').length, 0, '기본값에서 Rollout을 렌더했다(local·CI는 CRD가 없다)');
    assert.ok(find(objects, 'Deployment', 'example-svc'), 'Deployment example-svc');
  }
  const on = render([...BASE, 'outboxRelay.enabled=true', 'service.autoscaling.enabled=true', 'service.networkPolicy.enabled=true']);
  assert.equal(on.error, undefined, on.error);
  assert.equal(all(on.objects, 'Rollout').length, 0);
  assert.ok(find(on.objects, 'Deployment', 'example-svc'));
  assert.ok(find(on.objects, 'Deployment', 'example-svc-outbox-relay'));
  assert.equal(all(on.objects, 'HorizontalPodAutoscaler').length, 1);
  assert.equal(all(on.objects, 'NetworkPolicy').length, 1);
});

test('CH-03 PDB를켜면_PodDisruptionBudget하나_maxUnavailable1·unhealthyPodEvictionPolicyAlwaysAllow이고_서비스파드만고른다', () => {
  const { objects, error } = render([...BASE, 'service.pdb.enabled=true']);
  assert.equal(error, undefined, error);
  const pdbs = all(objects, 'PodDisruptionBudget');
  assert.equal(pdbs.length, 1);
  const p = pdbs[0];
  assert.equal(p.apiVersion, 'policy/v1');
  assert.equal(p.metadata.name, 'example-svc');
  assert.equal(p.spec.maxUnavailable, 1);
  assert.equal(p.spec.unhealthyPodEvictionPolicy, 'AlwaysAllow');
  assert.deepEqual(p.spec.selector.matchLabels, SERVICE_PODS('example-svc'));
  // 기본값은 꺼짐
  assert.equal(all(render(BASE).objects, 'PodDisruptionBudget').length, 0);
  // 경계: 복제 2에서 maxUnavailable 2(모두 축출)는 정본 값이 아니다
  assert.notEqual(p.spec.maxUnavailable, 2);
});

test('OPS-430 ① KEDA ScaledObject는_최소·최대복제수와_폴링·쿨다운을_값에서받고_fallback은_currentReplicas다', () => {
  const file = valuesFile(
    [
      'service:',
      '  keda:',
      '    enabled: true',
      '    minReplicaCount: 2',
      '    maxReplicaCount: 12',
      '    pollingInterval: 15',
      '    cooldownPeriod: 600',
      '    triggers:',
      '      - type: prometheus',
      '        metadata:',
      '          serverAddress: http://prom.observability.svc:9090',
      '          query: sum(peaket_realtime_gw_connections)',
      '          threshold: "100"',
      '',
    ].join('\n'),
  );
  const { objects, error } = renderFiles([file], BASE);
  assert.equal(error, undefined, error);
  const scaled = all(objects, 'ScaledObject');
  assert.equal(scaled.length, 1);
  const s = scaled[0];
  assert.equal(s.apiVersion, 'keda.sh/v1alpha1');
  assert.deepEqual(s.spec.scaleTargetRef, { name: 'example-svc' });
  assert.equal(s.spec.minReplicaCount, 2);
  assert.equal(s.spec.maxReplicaCount, 12);
  assert.equal(s.spec.pollingInterval, 15);
  assert.equal(s.spec.cooldownPeriod, 600);
  assert.deepEqual(s.spec.triggers, [{ type: 'prometheus', metadata: { serverAddress: 'http://prom.observability.svc:9090', query: 'sum(peaket_realtime_gw_connections)', threshold: '100' } }]);
  // 지표를 못 읽으면 0이나 -1로 줄이지 않고 지금 복제 수를 유지한다(docs/observability.md §5 '자동 제어 입력 감시')
  assert.deepEqual(s.spec.fallback, { failureThreshold: 3, replicas: 0, behavior: 'currentReplicas' });
  assert.equal(all(render(BASE).objects, 'ScaledObject').length, 0);

  // RV0910-01: 켤 때 min/max를 값으로 받아야 한다. 생략하면 KEDA 기본값 0/100이 남고, min 0·max<min도 받지 않는다
  const trigger = ['- type: prometheus', '  metadata:', '    serverAddress: http://prom.observability.svc:9090', '    query: sum(peaket_realtime_gw_connections)', '    threshold: "100"'];
  const badReplicas = [
    ['min/max 생략', []],
    ['min 0', ['minReplicaCount: 0', 'maxReplicaCount: 12']],
    ['max<min', ['minReplicaCount: 5', 'maxReplicaCount: 2']],
    ['max 0', ['minReplicaCount: 1', 'maxReplicaCount: 0']],
  ];
  for (const [label, configLines] of badReplicas) {
    const r = renderFiles([kedaValuesWith(configLines, trigger)], BASE);
    assert.notEqual(r.error, undefined, `${label}: 렌더됐다`);
    assert.match(r.error, /KEDA|keda|minReplica|maxReplica|autoscaling/, `${label}: 오류 문구`);
  }
});

test('CH-05 ExternalSecret을켜면_remoteRef만낸다_값(kty·PEM·value)은렌더에없다 [ASVS v5.0.0-13.1.4] [ASVS v5.0.0-13.3.4]', () => {
  const file = valuesFile(
    [
      'externalSecret:',
      '  enabled: true',
      '  environment: local',
      '  secretStoreRef: { name: peaket-secrets, kind: ClusterSecretStore }',
      '  target: { name: example-svc-secrets }',
      '  data:',
      '    - { secretKey: PEAKET_FAN_TOKEN_KEY, remoteRef: { key: identity/fan-token-key } }',
      '    - { secretKey: PEAKET_FAN_TOKEN_KEY_PREVIOUS, remoteRef: { key: identity/fan-token-key-previous } }',
      '',
    ].join('\n'),
  );
  const { objects, error, text } = renderFiles([file], BASE);
  assert.equal(error, undefined, error);
  const es = all(objects, 'ExternalSecret');
  assert.equal(es.length, 1);
  const e = es[0];
  assert.equal(e.apiVersion, 'external-secrets.io/v1');
  assert.equal(e.metadata.name, 'example-svc');
  assert.deepEqual(e.spec.secretStoreRef, { name: 'peaket-secrets', kind: 'ClusterSecretStore' });
  assert.equal(e.spec.target.name, 'example-svc-secrets');
  // RV-06: refreshInterval이 없으면 External Secrets가 한 번만 만들고 갱신하지 않아 90일 토큰 키 교체가 Secret에 닿지 않는다.
  // RV-22: creationPolicy는 External Secrets 스키마에서 spec.target 아래에만 있다. top-level에 두면 알 수 없는 필드다.
  // Owner면 ExternalSecret을 지울 때 Secret도 함께 지운다(docs/security/asvs/delivery.md 13.3.4)
  assert.equal(e.spec.refreshInterval, '1h', 'refreshInterval(1h)');
  assert.equal(e.spec.target.creationPolicy, 'Owner', 'target.creationPolicy: Owner');
  assert.equal('creationPolicy' in e.spec, false, 'spec 최상위 creationPolicy를 냈다(External Secrets 스키마에 없는 칸이다)');
  assert.equal(parse(readFileSync(join(CHART, 'values.yaml'), 'utf8')).externalSecret?.refreshInterval, '1h', '차트 기본값 externalSecret.refreshInterval');
  // RV-01: data의 remoteRef.key는 환경 안쪽 경로만이고, 차트가 peaket/<externalSecret.environment>/를 붙여 만든다
  assert.deepEqual(e.spec.data, [
    { secretKey: 'PEAKET_FAN_TOKEN_KEY', remoteRef: { key: 'peaket/local/identity/fan-token-key' } },
    { secretKey: 'PEAKET_FAN_TOKEN_KEY_PREVIOUS', remoteRef: { key: 'peaket/local/identity/fan-token-key-previous' } },
  ]);
  // 값이 들어갈 수 있는 칸(value·valueFrom·dataFrom)과 키 본문이 없다
  for (const d of e.spec.data) assert.deepEqual(Object.keys(d).sort(), ['remoteRef', 'secretKey']);
  assert.equal('dataFrom' in e.spec, false);
  assert.doesNotMatch(text ?? '', /"kty"|BEGIN [A-Z ]*PRIVATE KEY/);
  // 이름이 없으면 렌더를 멈춘다(빈 저장소·빈 Secret을 만들지 않는다)
  assert.match(
    renderFiles([valuesFile('externalSecret:\n  enabled: true\n  data: []\n')], BASE).error ?? '(렌더됨)',
    /externalSecret/,
  );
  assert.equal(all(render(BASE).objects, 'ExternalSecret').length, 0);
});

test('CH-06 priorityClassName을주면_서비스와릴레이파드에그이름이붙고_비우면칸이없다', () => {
  const on = render([...BASE, 'outboxRelay.enabled=true', 'service.priorityClassName=peaket-control'], 'purchase');
  assert.equal(on.error, undefined, on.error);
  assert.equal(find(on.objects, 'Deployment', 'example-svc').spec.template.spec.priorityClassName, 'peaket-control');
  assert.equal(find(on.objects, 'Deployment', 'example-svc-outbox-relay').spec.template.spec.priorityClassName, 'peaket-control');
  const off = render([...BASE, 'outboxRelay.enabled=true'], 'purchase');
  assert.equal(off.error, undefined, off.error);
  assert.equal('priorityClassName' in find(off.objects, 'Deployment', 'example-svc').spec.template.spec, false);
  assert.equal('priorityClassName' in find(off.objects, 'Deployment', 'example-svc-outbox-relay').spec.template.spec, false);
});

test('CH-07 local·ci밖에서는_태그만으로렌더하지않고_다이제스트를요구한다', () => {
  const release = (env) => ['name=example-svc', 'image.repository=peaket/example-svc', `env.PEAKET_ENV=${env}`, 'diagnose.bucket=peaket-diag'];
  for (const env of ['staging', 'demo', 'prod']) {
    assert.match(render([...release(env), 'image.tag=v1.2.3']).error ?? '(렌더됨)', /digest/, `${env} 태그만`);
    const ok = render([...release(env), `image.digest=sha256:${'b'.repeat(64)}`]);
    assert.equal(ok.error, undefined, `${env}: ${ok.error}`);
    assert.equal(find(ok.objects, 'Deployment', 'example-svc').spec.template.spec.containers[0].image, `peaket/example-svc@sha256:${'b'.repeat(64)}`);
  }
  // local·ci는 태그로 고정한다
  for (const env of ['local', 'ci']) {
    const r = render(['name=example-svc', 'image.repository=peaket/example-svc', `env.PEAKET_ENV=${env}`, 'image.tag=local']);
    assert.equal(r.error, undefined, `${env}: ${r.error}`);
    assert.match(find(r.objects, 'Deployment', 'example-svc').spec.template.spec.containers[0].image, /:local$/);
  }
});

// --- RV-03: Rollout+HPA/KEDA의 scaleTargetRef(계획 BAT-080 G3, 리뷰 RV-03) ---
// Rollout을 켜면 Deployment를 내지 않으므로(rollout.yaml), 오토스케일러가 없는 Deployment를 가리키면 복제 수가 조절되지 않는다.
// local·CI는 지금처럼 Deployment라 scaleTargetRef도 그대로다.

test('CH-08 Rollout과HPA를함께켜면_scaleTargetRef가argoproj.io/v1alpha1_Rollout이고_Deployment때는apps/v1_Deployment다', () => {
  const on = render([...ROLLOUT_ON, 'service.autoscaling.enabled=true']);
  assert.equal(on.error, undefined, on.error);
  assert.equal(all(on.objects, 'Deployment').filter((o) => o.metadata.name === 'example-svc').length, 0, 'Rollout과 Deployment가 함께 렌더됐다');
  assert.equal(all(on.objects, 'Rollout').length, 1);
  const hpa = find(on.objects, 'HorizontalPodAutoscaler', 'example-svc');
  assert.ok(hpa, 'HorizontalPodAutoscaler example-svc');
  assert.deepEqual(hpa.spec.scaleTargetRef, { apiVersion: 'argoproj.io/v1alpha1', kind: 'Rollout', name: 'example-svc' });
  // Deployment일 때는 지금 그대로다
  const off = render([...BASE, 'service.autoscaling.enabled=true']);
  assert.equal(off.error, undefined, off.error);
  assert.deepEqual(find(off.objects, 'HorizontalPodAutoscaler', 'example-svc').spec.scaleTargetRef, { apiVersion: 'apps/v1', kind: 'Deployment', name: 'example-svc' });
});

test('CH-09 Rollout과KEDA를함께켜면_scaleTargetRef가argoproj.io/v1alpha1_Rollout이고_Deployment때는지금처럼이름만이다', () => {
  const file = valuesFile(
    ['service:', '  keda:', '    enabled: true', '    minReplicaCount: 2', '    maxReplicaCount: 12', '    triggers:', '      - type: prometheus', '        metadata:', '          serverAddress: http://prom.observability.svc:9090', '          query: sum(peaket_realtime_gw_connections)', '          threshold: "100"', ''].join('\n'),
  );
  const on = renderFiles([file], [...BASE, 'service.rollout.enabled=true']);
  assert.equal(on.error, undefined, on.error);
  assert.equal(all(on.objects, 'Deployment').filter((o) => o.metadata.name === 'example-svc').length, 0, 'Rollout과 Deployment가 함께 렌더됐다');
  assert.equal(all(on.objects, 'Rollout').length, 1);
  const scaled = find(on.objects, 'ScaledObject', 'example-svc');
  assert.ok(scaled, 'ScaledObject example-svc');
  assert.deepEqual(scaled.spec.scaleTargetRef, { apiVersion: 'argoproj.io/v1alpha1', kind: 'Rollout', name: 'example-svc' });
  // Deployment일 때는 지금처럼 이름만 적는다(KEDA 기본값이 apps/v1 Deployment다)
  const off = renderFiles([file], BASE);
  assert.equal(off.error, undefined, off.error);
  assert.deepEqual(find(off.objects, 'ScaledObject', 'example-svc').spec.scaleTargetRef, { name: 'example-svc' });
});

// --- F-09-10(OPS-430): KEDA 트리거·HPA 충돌·카나리 단계 검증(계획 docs/review/plans/F-09-10.md §5·§6) ---
// 정본: docs/infra.md §5, docs/devops.md §6.1·§6.2·§6.7, docs/observability.md §5 '자동 제어 입력 감시',
// KEDA v2.21 ScaledObject 스펙(fallback behavior currentReplicas, 2026-11-27 확인).

function kedaValuesWith(configLines, triggerLines) {
  return valuesFile(
    [
      'service:',
      '  keda:',
      '    enabled: true',
      ...configLines.map((l) => `    ${l}`),
      '    triggers:',
      ...triggerLines.map((l) => `      ${l}`),
      '',
    ].join('\n'),
  );
}

function kedaValues(triggerLines) {
  return kedaValuesWith(['minReplicaCount: 2', 'maxReplicaCount: 12'], triggerLines);
}

/** KEDA 트리거 하나의 YAML 줄. kedaValues가 6칸을 더한다 */
function trigger(type, metadataLines) {
  return [`- type: ${type}`, '  metadata:', ...metadataLines.map((l) => `    ${l}`)];
}

test('OPS-430 ② HPA와_KEDA를_같은대상에_함께켜면_렌더를_멈춘다', () => {
  const file = kedaValues([
    '- type: prometheus',
    '  metadata:',
    '    serverAddress: http://prom.observability.svc:9090',
    '    query: sum(peaket_realtime_gw_connections)',
    '    threshold: "100"',
  ]);
  const both = renderFiles([file], [...BASE, 'service.autoscaling.enabled=true']);
  assert.notEqual(both.error, undefined, 'HPA와 KEDA를 함께 켰는데 렌더됐다');
  assert.match(both.error, /KEDA|keda|HPA|autoscaling/);
  // 하나만 켜면 지금처럼 렌더된다
  const kedaOnly = renderFiles([file], BASE);
  assert.equal(kedaOnly.error, undefined, kedaOnly.error);
  assert.equal(all(kedaOnly.objects, 'ScaledObject').length, 1);
  assert.equal(all(kedaOnly.objects, 'HorizontalPodAutoscaler').length, 0);
  const hpaOnly = render([...BASE, 'service.autoscaling.enabled=true']);
  assert.equal(hpaOnly.error, undefined, hpaOnly.error);
  assert.equal(all(hpaOnly.objects, 'HorizontalPodAutoscaler').length, 1);
  assert.equal(all(hpaOnly.objects, 'ScaledObject').length, 0);
});

test('OPS-430 ③ KEDA_트리거는_cron·prometheus·kafka·redis만_받고_종류마다_필수metadata가_없으면_렌더를_멈춘다', () => {
  // 네 종류를 한 ScaledObject에 넣어도 각 metadata가 그대로 남는다
  const valid = kedaValues([
    '- type: cron',
    '  metadata:',
    '    start: "0 20 * * *"',
    '    end: "0 22 * * *"',
    '    desiredReplicas: "6"',
    '    timezone: Asia/Seoul',
    '- type: prometheus',
    '  metadata:',
    '    serverAddress: http://prom.observability.svc:9090',
    '    query: sum(peaket_queue_waiting)',
    '    threshold: "1000"',
    '- type: kafka',
    '  metadata:',
    '    bootstrapServers: kafka:9092',
    '    consumerGroup: purchase-svc',
    '    topic: trade.orders',
    '    lagThreshold: "1000"',
    '- type: redis',
    '  metadata:',
    '    addressFrom:',
    '      secretKeyRef:',
    '        name: queue-redis',
    '        key: host',
    '    listName: "q:{event:*}:wait"',
    '    listLength: "1000"',
  ]);
  const ok = renderFiles([valid], BASE);
  assert.equal(ok.error, undefined, ok.error);
  const s = find(ok.objects, 'ScaledObject', 'example-svc');
  assert.ok(s, 'ScaledObject example-svc');
  assert.deepEqual(s.spec.triggers.map((t) => t.type), ['cron', 'prometheus', 'kafka', 'redis']);
  assert.equal(s.spec.triggers[0].metadata.timezone, 'Asia/Seoul');

  // RV0910-03: 종류마다 요구하는 metadata 키를 하나씩 빼 본다(구현이 일부만 검사하면 여기서 걸린다)
  const redisAddress = ['addressFrom:', '  secretKeyRef:', '    name: queue-redis', '    key: host'];
  const badCases = [
    ['모르는 종류', ['- type: sqs', '  metadata: {}']],
    ['CPU 트리거', ['- type: cpu', '  metadata:', '    type: Utilization', '    value: "70"']],
    ['cron.start 없음', trigger('cron', ['end: "0 22 * * *"', 'desiredReplicas: "6"', 'timezone: Asia/Seoul'])],
    ['cron.end 없음', trigger('cron', ['start: "0 20 * * *"', 'desiredReplicas: "6"', 'timezone: Asia/Seoul'])],
    ['cron.timezone 없음', trigger('cron', ['start: "0 20 * * *"', 'end: "0 22 * * *"', 'desiredReplicas: "6"'])],
    ['cron.desiredReplicas 없음', trigger('cron', ['start: "0 20 * * *"', 'end: "0 22 * * *"', 'timezone: Asia/Seoul'])],
    ['prometheus.serverAddress 없음', trigger('prometheus', ['query: sum(x)', 'threshold: "1000"'])],
    ['prometheus.query 없음', trigger('prometheus', ['serverAddress: http://prom.observability.svc:9090', 'threshold: "1000"'])],
    ['prometheus.threshold 없음', trigger('prometheus', ['serverAddress: http://prom.observability.svc:9090', 'query: sum(x)'])],
    ['kafka.bootstrapServers 없음', trigger('kafka', ['consumerGroup: purchase-svc', 'topic: trade.orders', 'lagThreshold: "1000"'])],
    ['kafka.consumerGroup 없음', trigger('kafka', ['bootstrapServers: kafka:9092', 'topic: trade.orders', 'lagThreshold: "1000"'])],
    ['kafka.topic 없음', trigger('kafka', ['bootstrapServers: kafka:9092', 'consumerGroup: purchase-svc', 'lagThreshold: "1000"'])],
    ['kafka.lagThreshold 없음', trigger('kafka', ['bootstrapServers: kafka:9092', 'consumerGroup: purchase-svc', 'topic: trade.orders'])],
    ['redis.listName 없음', trigger('redis', [...redisAddress, 'listLength: "1000"'])],
    ['redis.addressFrom 없음', trigger('redis', ['listName: "q:{event:*}:wait"', 'listLength: "1000"'])],
    ['redis.listLength 없음', trigger('redis', [...redisAddress, 'listName: "q:{event:*}:wait"'])],
  ];
  for (const [label, lines] of badCases) {
    const r = renderFiles([kedaValues(lines)], BASE);
    assert.notEqual(r.error, undefined, `${label}: 렌더됐다`);
    assert.match(r.error, /KEDA|keda|trigger|트리거/, `${label}: 오류 문구`);
  }
});

test('OPS-430 ⑧ Argo_Rollouts_카나리_단계는_5·25·50·100%와_5분대기이고_rollbackWindow3·revisionHistoryLimit5다', () => {
  const { objects, error } = render(ROLLOUT_ON);
  assert.equal(error, undefined, error);
  const r = find(objects, 'Rollout', 'example-svc');
  assert.ok(r, 'Rollout example-svc');
  assert.equal(r.spec.revisionHistoryLimit, 5);
  assert.deepEqual(r.spec.strategy.canary.steps, [
    { setWeight: 5, pause: { duration: '300s' } },
    { setWeight: 25, pause: { duration: '300s' } },
    { setWeight: 50, pause: { duration: '300s' } },
    { setWeight: 100 },
  ]);
  assert.equal(r.spec.strategy.canary.rollbackWindow.revisions, 3);
  assert.equal('pause' in r.spec.strategy.canary.steps.at(-1), false, '마지막 100% 단계에 pause가 있으면 롤아웃이 끝나지 않는다');
});

test('OPS-430 ⑨ Argo_Rollouts_단계가_100%로_끝나지않거나_줄어들면_렌더를_멈춘다', () => {
  const badSteps = [
    ['마지막 90', ['- { weight: 50, pauseSeconds: 300 }', '- { weight: 90 }']],
    ['가중치 감소', ['- { weight: 50, pauseSeconds: 300 }', '- { weight: 25, pauseSeconds: 300 }', '- { weight: 100 }']],
    ['가중치 0', ['- { weight: 0 }', '- { weight: 100 }']],
    ['가중치 101', ['- { weight: 101 }']],
    ['마지막에 pause', ['- { weight: 50, pauseSeconds: 300 }', '- { weight: 100, pauseSeconds: 300 }']],
  ];
  for (const [label, lines] of badSteps) {
    const file = valuesFile(['service:', '  rollout:', '    enabled: true', '    steps:', ...lines.map((l) => `      ${l}`), ''].join('\n'));
    const r = renderFiles([file], BASE);
    assert.notEqual(r.error, undefined, `${label}: 렌더됐다`);
    assert.match(r.error, /rollout|Rollout|카나리|steps|weight/, `${label}: 오류 문구`);
  }
});
