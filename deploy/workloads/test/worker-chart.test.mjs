// 공용 차트의 스트림 작업자 모드(worker.enabled) 렌더 시험(BAT-220 계획 §6 OPS-150 ⑨, ASVS v5.0.0-13.4.5).
// 정본: docs/streaming.md §2.3(들어오는 연결은 지표 수집·상태 확인뿐, 관리 API 없음, Restricted·읽기 전용 루트, 네트워크 정책 표의 '들어옴: 관측
// 네임스페이스의 Prometheus → 지표 포트', '배포 값' 줄: 앱 포트·Service 없음, 정책은 늘 만든다, 앱 포트에 기대는 값·쿠버네티스 API 권한·자동 확장·카나리는
// 멈춘다), §2.2(복제 수 고정·롤링, 작업자 네임스페이스 data·trust), ADR-0285 결정 5(관리 포트 9464), docs/devops.md §5.2(관측 네임스페이스 observability).
// 값은 정본에서 그대로 적는다(차트 values.yaml에서 가져오지 않는다). 끔(기본)의 렌더는 workloads.test.mjs의 배포 단위 시험이 그대로 본다.
// 실행(저장소 뿌리): node --test "deploy/workloads/test/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import { ensureTool } from '../../../tools/local/tools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const CHART = join(REPO, 'deploy', 'charts', 'peaket-service');
const helm = await ensureTool('helm');

// ---- 정본 값 ----
/** 관리 포트(지표·상태 확인, ADR-0285 결정 5) */
const MANAGEMENT_PORT = 9464;
/** 관측 네임스페이스(docs/devops.md §5.2) */
const OBSERVABILITY = 'observability';
const WORKER = 'ops-rt';

/** 작업자 값으로 렌더한다(ops-rt는 data 네임스페이스, streaming §2.2) */
function render(sets = [], jsonSets = []) {
  const r = spawnSync(
    helm,
    [
      'template', WORKER, CHART, '--namespace', 'data',
      '--set', `name=${WORKER}`, '--set', `image.repository=peaket/${WORKER}`, '--set', 'image.tag=local', '--set', 'env.PEAKET_ENV=local',
      ...sets.flatMap((s) => ['--set', s]),
      ...jsonSets.flatMap((s) => ['--set-json', s]),
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) return { error: r.stderr, text: '' };
  return { text: r.stdout, objects: parseAllDocuments(r.stdout).map((d) => d.toJS()).filter(Boolean) };
}
const ok = (r) => {
  assert.equal(r.error, undefined, r.error);
  return r.objects;
};
const kinds = (objs) => objs.map((o) => o.kind).sort();
const deploymentOf = (objs) => {
  const d = objs.filter((o) => o.kind === 'Deployment' && o.metadata?.labels?.['app.kubernetes.io/component'] === 'service');
  assert.equal(d.length, 1, `서비스 Deployment ${d.length}개`);
  return d[0];
};
const policyOf = (objs) => {
  const p = objs.filter((o) => o.kind === 'NetworkPolicy');
  assert.equal(p.length, 1, `NetworkPolicy ${p.length}개`);
  return p[0];
};

test('OPS-150 ⑨ [ASVS v5.0.0-13.4.5] 작업자 모드면 Service·라우트가 없고 컨테이너 포트는 관리 포트 하나, PORT 환경 값이 없다', () => {
  const objs = ok(render(['worker.enabled=true']));
  // 기본 값의 작업자 렌더: 파드·정책·서비스 계정뿐이다(Service 없음)
  assert.deepEqual(kinds(objs), ['Deployment', 'NetworkPolicy', 'ServiceAccount']);
  for (const k of ['Service', 'HTTPRoute', 'GRPCRoute', 'Ingress', 'Role', 'RoleBinding', 'HorizontalPodAutoscaler', 'ScaledObject', 'Rollout']) {
    assert.equal(objs.filter((o) => o.kind === k).length, 0, `작업자 모드에 ${k}가 있다`);
  }
  const c = deploymentOf(objs).spec.template.spec.containers;
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].ports, [{ name: 'management', containerPort: MANAGEMENT_PORT }]);
  assert.equal((c[0].env ?? []).filter((e) => e.name === 'PORT').length, 0, '작업자에 PORT가 있다');
  // 상태 확인은 관리 포트로만 한다
  for (const probe of ['readinessProbe', 'livenessProbe', 'startupProbe']) assert.equal(c[0][probe]?.httpGet?.port, 'management', probe);
});

test('OPS-150 ⑨ [ASVS v5.0.0-13.4.5] 작업자 NetworkPolicy 들어옴은 관측 네임스페이스 → 관리 포트 하나뿐이다(앱 포트 규칙 0, 다른 네임스페이스 0)', () => {
  const p = policyOf(ok(render(['worker.enabled=true'])));
  assert.deepEqual(p.spec.podSelector, { matchLabels: { 'app.kubernetes.io/name': WORKER, 'app.kubernetes.io/component': 'service' } });
  assert.ok(p.spec.policyTypes.includes('Ingress'));
  assert.deepEqual(p.spec.ingress, [
    {
      from: [{ namespaceSelector: { matchExpressions: [{ key: 'kubernetes.io/metadata.name', operator: 'In', values: [OBSERVABILITY] }] } }],
      ports: [{ protocol: 'TCP', port: MANAGEMENT_PORT }],
    },
  ]);
});

test('OPS-150 ⑨ 작업자 모드는 service.networkPolicy.enabled를 꺼도 정책을 내고, 관측 네임스페이스를 비우면 들어옴을 모두 막는다', () => {
  const off = policyOf(ok(render(['worker.enabled=true', 'service.networkPolicy.enabled=false'])));
  assert.equal(off.spec.ingress.length, 1);
  const closed = policyOf(ok(render(['worker.enabled=true'], ['service.networkPolicy.managementFromNamespaces=[]'])));
  assert.deepEqual(closed.spec.ingress, []);
  assert.deepEqual(closed.spec.policyTypes, ['Ingress']);
});

test('OPS-150 ⑨ 작업자 모드의 나감 규칙은 service.networkPolicy.egress 그대로다(ClickHouse 칸)', () => {
  const p = policyOf(ok(render(['worker.enabled=true'], ['service.networkPolicy.egress.internal=[{"namespaces":["data"],"podLabels":{"app":"clickhouse"},"ports":[8443]}]'])));
  assert.deepEqual(p.spec.policyTypes, ['Ingress', 'Egress']);
  const clickhouse = p.spec.egress.find((e) => e.to?.some((t) => t.podSelector?.matchLabels?.app === 'clickhouse'));
  assert.ok(clickhouse, 'ClickHouse 나감 규칙이 없다');
  assert.deepEqual(clickhouse.ports, [{ protocol: 'TCP', port: 8443 }]);
  // 들어옴은 그대로 관리 포트 하나다
  assert.deepEqual(p.spec.ingress.flatMap((r) => r.ports.map((x) => x.port)), [MANAGEMENT_PORT]);
});

test('OPS-150 ⑨ 작업자 파드는 Restricted 기준·읽기 전용 루트이고 서비스 계정 토큰을 붙이지 않는다', () => {
  const objs = ok(render(['worker.enabled=true']));
  const pod = deploymentOf(objs).spec.template.spec;
  assert.equal(pod.automountServiceAccountToken, false);
  const sa = objs.find((o) => o.kind === 'ServiceAccount' && o.metadata.name === pod.serviceAccountName);
  assert.ok(sa, '서비스 계정이 없다');
  assert.equal(sa.automountServiceAccountToken, false);
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.deepEqual(pod.securityContext.seccompProfile, { type: 'RuntimeDefault' });
  for (const c of [...pod.containers, ...(pod.initContainers ?? [])]) {
    assert.equal(c.securityContext.allowPrivilegeEscalation, false, c.name);
    assert.equal(c.securityContext.readOnlyRootFilesystem, true, c.name);
    assert.equal(c.securityContext.runAsNonRoot, true, c.name);
    assert.deepEqual(c.securityContext.capabilities, { drop: ['ALL'] }, c.name);
  }
  // 쿠버네티스 API 권한 없음
  assert.equal(objs.filter((o) => ['Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding'].includes(o.kind)).length, 0);
});

test('OPS-150 ⑨ 작업자 모드가 받지 않는 값(앱 포트에 기대는 값·쿠버네티스 API 권한·자동 확장·카나리)은 각각 렌더를 멈춘다', () => {
  const cases = [
    { sets: [], json: ['service.extraPorts=[{"name":"admin","port":8081}]'], says: 'service.extraPorts' },
    { sets: [], json: ['service.networkPolicy.appFromPodLabels={"app":"gw"}'], says: 'service.networkPolicy.appFromPodLabels' },
    { sets: ['service.leaderLease=ops-rt-leader'], json: [], says: 'service.leaderLease' },
    { sets: ['service.autoscaling.enabled=true'], json: [], says: 'autoscaling' },
    { sets: ['service.keda.enabled=true'], json: [], says: 'keda' },
    { sets: ['service.rollout.enabled=true'], json: [], says: 'rollout' },
  ];
  for (const c of cases) {
    const r = render(['worker.enabled=true', ...c.sets], c.json);
    assert.notEqual(r.error, undefined, `${c.says}: 렌더가 멈추지 않았다`);
    assert.match(r.error, /worker\.enabled/, c.says);
    assert.ok(r.error.includes(c.says), `${c.says}: ${r.error}`);
    // 같은 값이라도 작업자 모드가 아니면 막지 않는다(서비스 렌더는 그대로)
    if (c.says === 'service.networkPolicy.appFromPodLabels') assert.equal(render(c.sets, c.json).error, undefined);
  }
});

test('OPS-150 ⑨ 작업자 모드를 끄면(기본) Service·앱 포트·PORT가 있고, worker.enabled=false를 적은 렌더와 바이트까지 같다', () => {
  const plain = render();
  const explicit = render(['worker.enabled=false']);
  assert.equal(plain.error, undefined, plain.error);
  assert.equal(explicit.text, plain.text);
  const objs = plain.objects;
  assert.equal(objs.filter((o) => o.kind === 'Service').length, 1);
  const c = deploymentOf(objs).spec.template.spec.containers[0];
  assert.deepEqual(c.ports.map((p) => p.name), ['http', 'management']);
  assert.equal(c.env.filter((e) => e.name === 'PORT').length, 1);
});
