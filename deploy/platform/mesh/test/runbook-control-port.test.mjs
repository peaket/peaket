// F-02-7(A, OPS-310) C-T28 ⑦: 비상 런북 Job의 제어 포트 신원 정적 시험.
// 정본: docs/features/control-tower.md §14 C-T28, ADR-0102(제어 전용 gRPC), docs/infra.md §9 '비상 런북 통제',
// docs/review/plans/F-02-7.md 3·8절. 실제 클러스터·Docker 없이 생성된 메시 정책과 원천만 읽는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const MESH = resolve(HERE, '..');
const REPO = resolve(MESH, '..', '..', '..');
const read = (name) => readFileSync(join(MESH, name), 'utf8');
const docs = (name) => parseAllDocuments(read(name)).map((d) => d.toJSON()).filter(Boolean);

const CONTROL_PORT = '50061';
const OPS_SVC = 'cluster.local/ns/core/sa/ops-svc';
const BREAKGLASS = 'cluster.local/ns/ops-breakglass/sa/ops-breakglass';
const WORKLOADS = ['admission-ctrl', 'purchase-svc', 'queue-svc', 'payment-svc'];

const policyOf = (list, workload) => {
  const p = list.find((x) => x.kind === 'AuthorizationPolicy' && x.metadata?.name === `${workload}-ports`);
  assert.ok(p, `${workload}-ports AuthorizationPolicy가 없다`);
  return p;
};
const networkPolicyOf = (list, workload) => {
  const p = list.find((x) => x.kind === 'NetworkPolicy' && x.metadata?.name === `${workload}-ports`);
  assert.ok(p, `${workload}-ports NetworkPolicy가 없다`);
  return p;
};
const controlRuleOf = (p) => {
  const rule = (p.spec?.rules ?? []).find((r) => (r.to ?? []).some((t) => (t.operation?.ports ?? []).includes(CONTROL_PORT)));
  assert.ok(rule, `${p.metadata.name}에 ${CONTROL_PORT} 규칙이 없다`);
  return rule;
};
const principalsOf = (rule) => [...new Set((rule.from ?? []).flatMap((f) => f.source?.principals ?? []))].sort();

test('C-T28 ⑦ 제어 포트는 ops-svc와 ops-breakglass 신원만 받는다(네 받는 쪽 모두)', () => {
  const policies = docs('policies.yaml');
  for (const w of WORKLOADS) {
    const rule = controlRuleOf(policyOf(policies, w));
    assert.deepEqual(principalsOf(rule), [OPS_SVC, BREAKGLASS].sort(), `${w}: 제어 포트 신원이 다르다`);
  }
});

test('C-T28 ⑦ 메시 없는 로컬에서도 제어 포트는 ops-breakglass 네임스페이스와 ops-svc 파드만 받고 ipBlock은 없다', () => {
  const policies = docs('meshless-networkpolicies.yaml');
  for (const w of WORKLOADS) {
    const np = networkPolicyOf(policies, w);
    const ingress = (np.spec?.ingress ?? []).find((r) => (r.ports ?? []).some((p) => String(p.port) === CONTROL_PORT));
    assert.ok(ingress, `${w}: ${CONTROL_PORT} ingress가 없다`);
    assert.equal(ingress.from?.length, 2, `${w}: 출처가 둘이 아니다`);
    assert.equal(JSON.stringify(ingress).includes('ipBlock'), false, `${w}: ipBlock이 있다`);
    const sources = ingress.from.map((f) => ({
      namespace: f.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'],
      pod: f.podSelector?.matchLabels?.['app.kubernetes.io/name'],
    }));
    assert.deepEqual(
      sources.sort((a, b) => String(a.namespace).localeCompare(String(b.namespace))),
      [
        { namespace: 'core', pod: 'ops-svc' },
        { namespace: 'ops-breakglass', pod: undefined },
      ],
      `${w}: 출처가 ops-breakglass 네임스페이스와 ops-svc 파드가 아니다`,
    );
    for (const f of ingress.from) {
      if (f.namespaceSelector) assert.deepEqual(f.namespaceSelector.matchLabels, { 'kubernetes.io/metadata.name': f.namespaceSelector.matchLabels?.['kubernetes.io/metadata.name'] }, `${w}: 네임스페이스 선택자에 다른 라벨이 있다`);
    }
  }
});

test('C-T28 ⑦ 원천 port-allow.yaml도 제어 포트 호출자를 ops-svc·ops-breakglass로만 둔다', () => {
  const source = parse(readFileSync(join(MESH, 'port-allow.yaml'), 'utf8'));
  for (const w of WORKLOADS) {
    assert.deepEqual(source.workloads[w].ports.control.callers, ['ops-svc', 'ops-breakglass'], `${w}: 원천 호출자가 다르다`);
  }
  assert.deepEqual(source.callers['ops-breakglass'].meshless, { namespace: 'ops-breakglass' }, '비상 런북 Job은 ops-breakglass 네임스페이스만으로 식별되어야 한다');
  const others = Object.entries(source.workloads).filter(([w, v]) => !WORKLOADS.includes(w) && v.ports?.control?.callers?.includes('ops-breakglass'));
  assert.deepEqual(others.map(([w]) => w), [], '제어 포트가 아닌 곳에 ops-breakglass가 있다');
});
