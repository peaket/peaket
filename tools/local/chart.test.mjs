// 공용 서비스 차트(deploy/charts/peaket-service) 렌더 시험. helm은 tools.mjs가 고정 판으로 받는다.
// 실행: node --test "tools/local/*.test.mjs"  (실제 클러스터에 올려 보는 것은 tools/local/e2e/relay-takeover.e2e.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.deepEqual(role.rules, [{ apiGroups: ['coordination.k8s.io'], resources: ['leases'], resourceNames: ['payment-entry-pause'], verbs: ['get', 'update'] }]);
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
