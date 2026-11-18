// 메시 없는 실행의 포트별 허용 NetworkPolicy kind 시험(D-T36 ①~⑦ kind, BUILD_ORDER HOT-420, 묶음 BAT-061 계획 6의 MK-01~08, ADR-0285 결정 13).
// node tools/local/cluster.mjs mesh-netpol이 올린 받는 쪽 대역(원천 워크로드마다, 모든 포트에서 TCP 연결을 받아 'ok\n'을 쓰고 닫는다)과
// 생성 NetworkPolicy(deploy/platform/mesh/meshless-networkpolicies.yaml, kind 기본 네트워크 kindnet이 지킨다)에, 부르는 쪽 네임스페이스·라벨로 띄운
// 짧은 시험 파드에서 TCP로 붙어 본다. 'ok'를 받으면 '연결', 시간 한도 안에 못 붙거나 끊기면 '거부'다.
// - 허용과 거부를 짝으로 본다: 거부를 단언하는 (워크로드, 포트)마다 같은 실행에서 그 대상에 '연결'된 사례가 있어야 한다(대역이 죽어서 거부로 보이는 것을 막는다).
// - 시험 파드가 뜨지 못했거나 결과 줄이 없으면 실패다('거부'로 세지 않는다). 이름 풀이 실패도 거부가 아니다.
// - 대상의 호스트(<워크로드>.<네임스페이스>.svc.cluster.local)와 포트는 정본(ADR-0285 결정 6, docs/devops.md §5.2)에서 적는다. 접속 정보 파일에서는 시험 파드 이미지만 읽는다.
// - 게이트웨이 REST 허용은 deploy/gateways 맨 위 YAML의 라우트 backendRefs·remoteJWKS(2026-11-18 저장소)와 ADR-0285 결정 9 끝의 trust-svc 예외다.
//   라우트가 바뀌면 정적 시험(deploy/platform/mesh/test, MS-01)이 생성 정책과 라우트를 견주고, 이 표는 그때 함께 고친다.
// - 연결 시간 한도 3초 [가정]는 대역·생성기 상수와 상관없이 정했다(계획 10). 새로 뜬 파드의 정책 반영이 늦어 '연결'이 거부로 보이지 않게 대상마다 3번까지 다시 붙는다
//   ('거부'는 세 번 모두 못 붙어야 한다).
// - 게이트웨이 라벨을 단 시험 파드는 로컬 NodePort Service의 끝점이 될 수 있어 게이트웨이 kind 시험이 끝난 뒤에 짧게 띄운다(ci-kind 차례).
// 실행(저장소 뿌리, Docker 차례 잠금을 잡고): node tools/local/cluster.mjs up && node tools/local/cluster.mjs gateways && node tools/local/cluster.mjs mesh-netpol &&
//   node --test --test-timeout=300000 tools/local/e2e/mesh-netpol.e2e.mjs
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import { MESH_NETPOL_CONTRACT_FILE, kubectl } from '../cluster.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const PROBE_LABEL = 'peaket.io/mesh-netpol-probe';
/** 연결 시간 한도 3초 [가정](계획 6 MK 머리)와 다시 붙는 횟수 */
const CONNECT_TIMEOUT_MS = 3000;
const ATTEMPTS = 3;
/** '거부'로 세는 끝(시간 초과·끊김·거절·닿지 않음). 이름 풀이 실패·답 없는 연결은 무대 결함이다 */
const DENY_CODES = new Set(['timeout', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH']);
const KUBECTL_TIMEOUT_MS = 90_000;
const kc = (args, o = {}) => kubectl(args, { timeout: KUBECTL_TIMEOUT_MS, quiet: true, ...o });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===================== 정본 값 =====================

const GW_NS = 'envoy-gateway-system';
const GATEWAYS = ['gw-fan', 'gw-ops', 'gw-partner', 'gw-queue', 'gw-scanner'];
const GW_NAME_LABEL = 'gateway.envoyproxy.io/owning-gateway-name';
const GW_NS_LABEL = 'gateway.envoyproxy.io/owning-gateway-namespace';
/** docs/devops.md §5.2 '네임스페이스 지도' */
const NAMESPACE_OF = {
  'admission-ctrl': 'queue',
  'queue-svc': 'queue',
  'purchase-svc': 'purchase',
  'payment-svc': 'purchase',
  'ticket-svc': 'ticket',
  'trust-svc': 'trust',
  'core-svc': 'core',
  'identity-svc': 'core',
  'ops-svc': 'core',
  'image-worker': 'core',
  'seatmap-worker': 'core',
  web: 'web',
  partner: 'web',
};
/** ADR-0285 결정 6: REST 8080(web 3000·partner 3001), 업무 gRPC 50051(ticket-svc 50052), 제어 50061 */
const PORT = {
  rest: (w) => ({ web: 3000, partner: 3001 })[w] ?? 8080,
  grpc: (w) => (w === 'ticket-svc' ? 50052 : 50051),
  control: () => 50061,
};
const GRPC_RECEIVERS = ['core-svc', 'identity-svc', 'image-worker', 'payment-svc', 'purchase-svc', 'queue-svc', 'seatmap-worker', 'ticket-svc', 'trust-svc'];
const CONTROL_RECEIVERS = ['admission-ctrl', 'payment-svc', 'purchase-svc', 'queue-svc'];
/** 게이트웨이 → REST 포트(라우트 backendRefs·remoteJWKS, 2026-11-18 저장소. trust-svc는 ADR-0285 결정 9 끝의 gw-fan 예외라 MK-06이 본다) */
const REST_GATEWAYS = {
  'core-svc': ['gw-fan', 'gw-ops', 'gw-partner'],
  'identity-svc': ['gw-fan', 'gw-ops', 'gw-partner', 'gw-queue', 'gw-scanner'],
  'ops-svc': ['gw-ops', 'gw-partner'],
  partner: ['gw-partner'],
  'payment-svc': ['gw-fan', 'gw-partner'],
  'purchase-svc': ['gw-fan'],
  'queue-svc': ['gw-queue'],
  'ticket-svc': ['gw-fan', 'gw-partner', 'gw-scanner'],
  web: ['gw-fan'],
};
/** 업무 gRPC 포트마다 정본 부르는 쪽 하나(대조군. docs/api/proto/README.md §3) */
const GRPC_CONTROL_CALLER = {
  'core-svc': 'ops-svc',
  'identity-svc': 'purchase-svc',
  'image-worker': 'core-svc',
  'payment-svc': 'purchase-svc',
  'purchase-svc': 'ops-svc',
  'queue-svc': 'trust-svc',
  'seatmap-worker': 'core-svc',
  'ticket-svc': 'purchase-svc',
  'trust-svc': 'queue-svc',
};
/** 관리 경로를 처리하는 여덟 서비스와 제어 명령의 admission-ctrl(docs/architecture.md:290, D-T36 ⑦) */
const ADMIN_CALLERS = ['core-svc', 'identity-svc', 'ticket-svc', 'payment-svc', 'purchase-svc', 'queue-svc', 'trust-svc', 'ops-svc', 'admission-ctrl'];
/** docs/infra.md §9 '메시 포트별 허용 정책의 첫 구현': Envoy Gateway v1.10 프록시 서비스 계정 이름 */
const gatewayServiceAccount = (gw, ns = GW_NS) => `envoy-${ns}-${gw}-${createHash('sha256').update(`${ns}/${gw}`).digest('hex').slice(0, 8)}`;

const serviceLabels = (n) => ({ 'app.kubernetes.io/name': n, 'app.kubernetes.io/component': 'service' });
const gatewayLabels = (g) => ({ [GW_NAME_LABEL]: g, [GW_NS_LABEL]: GW_NS });

/** 시험 파드(부르는 쪽 신원)마다 네임스페이스·라벨 */
const CALLERS = {
  ...Object.fromEntries(GATEWAYS.map((g) => [g, { namespace: GW_NS, labels: gatewayLabels(g) }])),
  ...Object.fromEntries(Object.entries(NAMESPACE_OF).map(([n, ns]) => [n, { namespace: ns, labels: serviceLabels(n) }])),
  'gw-fan@core': { namespace: 'core', labels: gatewayLabels('gw-fan') },
  'stranger@core': { namespace: 'core', labels: serviceLabels('mesh-e2e-stranger') },
  'bare@core': { namespace: 'core', labels: {} },
  'stranger@trust': { namespace: 'trust', labels: serviceLabels('mesh-e2e-stranger') },
  'purchase-svc@core': { namespace: 'core', labels: serviceLabels('purchase-svc') },
  // 비상 런북 Job: ops-breakglass 네임스페이스면 라벨과 상관없이 받는다(docs/infra.md §9 '비상 런북 통제')
  'ops-breakglass': { namespace: 'ops-breakglass', labels: { 'app.kubernetes.io/name': 'mesh-e2e-runbook' } },
};

// ===================== 사례 =====================

/** { id, from, to, kind, expect: 'connect'|'deny' } */
const CASES = [];
const c = (id, from, to, kind, expect) => CASES.push({ id, from, to, kind, expect });
// MK-01 ① 게이트웨이 → 서비스 REST: 워크로드마다 게이트웨이 다섯 각각(그 경로의 게이트웨이만 연결), gw-fan 라벨을 단 다른 네임스페이스 파드는 거부
for (const [w, gws] of Object.entries(REST_GATEWAYS)) for (const g of GATEWAYS) c('MK-01', g, w, 'rest', gws.includes(g) ? 'connect' : 'deny');
for (const w of ['core-svc', 'identity-svc', 'purchase-svc']) c('MK-01', 'gw-fan@core', w, 'rest', 'deny');
// MK-02 ② 표에 없는 파드 → 업무 gRPC 아홉: 표에 없는 라벨·라벨 없음·라벨은 같고 네임스페이스가 다른 파드는 거부, 정본 부르는 쪽 하나는 연결(대조군)
for (const w of GRPC_RECEIVERS) {
  c('MK-02', 'stranger@core', w, 'grpc', 'deny');
  c('MK-02', 'bare@core', w, 'grpc', 'deny');
  c('MK-02', 'stranger@trust', w, 'grpc', 'deny');
  c('MK-02', GRPC_CONTROL_CALLER[w], w, 'grpc', 'connect');
}
for (const w of ['payment-svc', 'ticket-svc', 'identity-svc']) c('MK-02', 'purchase-svc@core', w, 'grpc', 'deny');
// MK-03 ③ 웹 앱 서버 → identity-svc 업무 gRPC는 연결, web이 부르지 않는 업무 gRPC(payment-svc 등)는 거부. ticket-svc는 ListTickets를 부른다(메시 없는 포트는 합)
c('MK-03', 'web', 'identity-svc', 'grpc', 'connect');
c('MK-03', 'web', 'ticket-svc', 'grpc', 'connect');
for (const w of GRPC_RECEIVERS.filter((x) => x !== 'identity-svc' && x !== 'ticket-svc')) c('MK-03', 'web', w, 'grpc', 'deny');
// MK-04 ④ 게이트웨이 다섯 → 제어 포트 넷: 모두 거부
for (const g of GATEWAYS) for (const w of CONTROL_RECEIVERS) c('MK-04', g, w, 'control', 'deny');
// MK-05 ⑤ 비상 런북 Job·ops-svc → 제어 포트 넷: 연결. 다른 서비스(같은 네임스페이스의 queue-svc 포함)·표에 없는 파드는 거부
for (const w of CONTROL_RECEIVERS) {
  c('MK-05', 'ops-breakglass', w, 'control', 'connect');
  c('MK-05', 'ops-svc', w, 'control', 'connect');
  c('MK-05', 'stranger@core', w, 'control', 'deny');
}
for (const n of ['purchase-svc', 'queue-svc', 'core-svc']) c('MK-05', n, 'admission-ctrl', 'control', 'deny');
// MK-06 ⑥ gw-fan → trust-svc REST는 연결, 다른 게이트웨이·identity-svc·queue-svc·표에 없는 파드는 거부
c('MK-06', 'gw-fan', 'trust-svc', 'rest', 'connect');
for (const n of ['gw-partner', 'gw-ops', 'gw-queue', 'gw-scanner', 'identity-svc', 'queue-svc', 'stranger@trust', 'stranger@core']) c('MK-06', n, 'trust-svc', 'rest', 'deny');
// MK-07 ⑦ 여덟 서비스와 admission-ctrl → identity-svc 업무 gRPC는 연결, 이미지·좌석맵 작업자·표에 없는 파드·게이트웨이는 거부
for (const n of ADMIN_CALLERS) c('MK-07', n, 'identity-svc', 'grpc', 'connect');
for (const n of ['image-worker', 'seatmap-worker', 'stranger@core', 'bare@core', 'partner', ...GATEWAYS]) c('MK-07', n, 'identity-svc', 'grpc', 'deny');

const targetKey = (to, kind) => `${to}:${kind}`;
const hostOf = (w) => `${w}.${NAMESPACE_OF[w]}.svc.cluster.local`;

// ===================== 시험 파드 =====================

/** 시험 파드 안 스크립트: 대상마다 함께 붙어 보고 '@@RESULT <JSON>'을 찍는다(대상마다 시도 결과 목록) */
const PROBE_SCRIPT = `const net = require('node:net');
const targets = JSON.parse(process.env.PEAKET_PROBE_TARGETS);
const LIMIT = Number(process.env.PEAKET_PROBE_TIMEOUT_MS);
const ATTEMPTS = Number(process.env.PEAKET_PROBE_ATTEMPTS);
function once(t) {
  return new Promise((resolve) => {
    let got = '';
    let connected = false;
    let done = false;
    const s = net.connect({ host: t.host, port: t.port });
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); s.destroy(); resolve(r); };
    const timer = setTimeout(() => finish(connected ? 'no-reply' : 'timeout'), LIMIT);
    s.on('connect', () => { connected = true; });
    s.on('data', (d) => { got += d; if (got.startsWith('ok')) finish('connected'); });
    s.on('end', () => finish(got.startsWith('ok') ? 'connected' : 'closed-without-reply'));
    s.on('error', (e) => finish(String((e && e.code) || e)));
  });
}
(async () => {
  await new Promise((r) => setTimeout(r, 1000));
  const out = {};
  await Promise.all(targets.map(async (t) => {
    const tries = [];
    for (let i = 0; i < ATTEMPTS; i++) {
      const r = await once(t);
      tries.push(r);
      if (r === 'connected') break;
      await new Promise((x) => setTimeout(x, 300));
    }
    out[t.key] = tries;
  }));
  console.log('@@RESULT ' + JSON.stringify(out));
})();`;

function probePod(name, caller, targets, image) {
  const security = { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } };
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: caller.namespace, labels: { ...caller.labels, [PROBE_LABEL]: RUN } },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      terminationGracePeriodSeconds: 1,
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [
        {
          name: 'probe',
          image,
          imagePullPolicy: 'IfNotPresent',
          command: ['node', '-e', PROBE_SCRIPT],
          env: [
            { name: 'PEAKET_PROBE_TARGETS', value: JSON.stringify(targets) },
            { name: 'PEAKET_PROBE_TIMEOUT_MS', value: String(CONNECT_TIMEOUT_MS) },
            { name: 'PEAKET_PROBE_ATTEMPTS', value: String(ATTEMPTS) },
          ],
          resources: { requests: { cpu: '10m', memory: '48Mi' }, limits: { memory: '96Mi' } },
          securityContext: security,
        },
      ],
    },
  };
}

/** 부르는 쪽 → { pod, results: { 대상: 시도 목록 } | undefined, error } */
const PROBES = new Map();
const namespacesUsed = () => [...new Set([...PROBES.values()].map((p) => p.caller.namespace))];
let contract;

before(
  async () => {
    assert.ok(existsSync(MESH_NETPOL_CONTRACT_FILE), `접속 정보 ${MESH_NETPOL_CONTRACT_FILE}가 없다(node tools/local/cluster.mjs mesh-netpol을 먼저 돌린다)`);
    contract = JSON.parse(readFileSync(MESH_NETPOL_CONTRACT_FILE, 'utf8'));
    assert.ok(typeof contract.image === 'string' && contract.image, '접속 정보에 시험 파드 이미지가 없다');
    // 생성 NetworkPolicy가 클러스터에 실제로 있다(워크로드마다 <워크로드>-ports)
    const nps = JSON.parse(await kc(['get', 'networkpolicies', '-A', '-l', 'peaket.io/generated-by=mesh-policies', '-o', 'json'])).items ?? [];
    const have = new Set(nps.map((o) => `${o.metadata.namespace}/${o.metadata.name}`));
    for (const [w, ns] of Object.entries(NAMESPACE_OF)) assert.ok(have.has(`${ns}/${w}-ports`), `클러스터에 NetworkPolicy ${ns}/${w}-ports가 없다(무대가 생성 정책을 올리지 않았다)`);
    // 부르는 쪽마다 시험 파드 하나(대상 여럿을 함께 본다)
    let i = 0;
    for (const cs of CASES) {
      assert.ok(CALLERS[cs.from], `시험 표에 없는 부르는 쪽 ${cs.from}`);
      assert.ok(NAMESPACE_OF[cs.to], `시험 표에 없는 대상 ${cs.to}`);
      if (!PROBES.has(cs.from)) PROBES.set(cs.from, { caller: CALLERS[cs.from], name: `mesh-np-${RUN}-${i++}`, targets: new Map() });
      const key = targetKey(cs.to, cs.kind);
      PROBES.get(cs.from).targets.set(key, { key, host: hostOf(cs.to), port: PORT[cs.kind](cs.to) });
    }
    for (const p of PROBES.values()) await kc(['create', '-f', '-'], { input: JSON.stringify(probePod(p.name, p.caller, [...p.targets.values()], contract.image)) });
    // 끝나기를 기다린다(한 번에 목록으로 읽는다)
    const end = Date.now() + 180_000;
    const phases = new Map();
    for (;;) {
      const list = JSON.parse(await kc(['get', 'pods', '-A', '-l', `${PROBE_LABEL}=${RUN}`, '-o', 'json'])).items ?? [];
      for (const o of list) phases.set(o.metadata.name, o.status?.phase);
      const pending = [...PROBES.values()].filter((p) => !['Succeeded', 'Failed'].includes(phases.get(p.name)));
      if (!pending.length) break;
      if (Date.now() > end) {
        for (const p of pending) p.error = `시험 파드가 끝나지 않았다(상태 ${phases.get(p.name) ?? '없음'})`;
        break;
      }
      await sleep(2000);
    }
    for (const [from, p] of PROBES) {
      if (p.error) continue;
      const logs = await kc(['-n', p.caller.namespace, 'logs', p.name]).catch((e) => `(로그 없음: ${e.message})`);
      const m = /^@@RESULT (.*)$/m.exec(logs);
      if (!m) p.error = `${from} 시험 파드(${phases.get(p.name)})에 결과 줄이 없다: ${logs.slice(-800)}`;
      else p.results = JSON.parse(m[1]);
      console.log(`# ${from}(${p.caller.namespace} ${JSON.stringify(p.caller.labels)}): ${p.results ? JSON.stringify(p.results) : p.error}`);
    }
  },
  { timeout: 280_000 },
);

after(async () => {
  for (const ns of namespacesUsed()) await kc(['-n', ns, 'delete', 'pod', '-l', `${PROBE_LABEL}=${RUN}`, '--ignore-not-found', '--wait=false']).catch(() => {});
});

/** 사례 하나의 결과: 'connect' | 'deny' | 무대 결함 글 */
function outcome(cs) {
  const p = PROBES.get(cs.from);
  if (!p) return '시험 파드를 띄우지 않았다';
  if (p.error) return p.error;
  const tries = p.results?.[targetKey(cs.to, cs.kind)];
  if (!Array.isArray(tries) || tries.length === 0) return '결과가 없다';
  if (tries.includes('connected')) return 'connect';
  if (tries.every((t) => DENY_CODES.has(t))) return 'deny';
  return `알 수 없는 끝 ${JSON.stringify(tries)}(이름 풀이 실패·답 없는 연결은 거부가 아니다)`;
}
/** 같은 실행에서 '연결'된 대상(대조군) */
const connectedTargets = () => new Set(CASES.filter((cs) => outcome(cs) === 'connect').map((cs) => targetKey(cs.to, cs.kind)));

/** 그 ID의 사례를 모두 본다: 연결·거부가 정본과 같고, 거부한 대상마다 같은 실행에 연결된 대조군이 있다 */
function check(id) {
  const cases = CASES.filter((cs) => cs.id === id);
  assert.ok(cases.length > 0, `${id} 사례가 없다`);
  const wrong = [];
  const live = connectedTargets();
  for (const cs of cases) {
    const got = outcome(cs);
    const where = `${cs.from} → ${cs.to} ${cs.kind}(${PORT[cs.kind](cs.to)})`;
    if (got !== cs.expect) wrong.push(`${where}: 정본 ${cs.expect === 'connect' ? '연결' : '거부'}, 결과 ${got}`);
    else if (cs.expect === 'deny' && !live.has(targetKey(cs.to, cs.kind))) wrong.push(`${where}: 거부지만 같은 실행에 그 대상으로 연결된 대조군이 없다(대역이 살아 있는지 알 수 없다)`);
  }
  assert.ok(cases.some((cs) => cs.expect === 'connect') || cases.every((cs) => live.has(targetKey(cs.to, cs.kind))), `${id}: 연결 사례·대조군이 없다`);
  assert.deepEqual(wrong, [], `${id}:\n${wrong.join('\n')}`);
}

// ===================== 시험 =====================

test('MK-01 D-T36 ① kind 게이트웨이 → 서비스 REST 포트: 그 서비스로 경로를 보내는 게이트웨이(gw-fan → core·identity·payment·purchase·ticket, gw-queue → queue 등)만 연결되고, 경로를 보내지 않는 게이트웨이(gw-queue → core-svc 등)와 gw-fan 라벨을 단 다른 네임스페이스 파드는 거부된다', () => check('MK-01'));

test('MK-02 D-T36 ② kind 표에 없는 파드 → 업무 gRPC 포트: 표에 없는 라벨·라벨 없는 파드·라벨은 같고 네임스페이스가 다른 파드는 아홉 워크로드 모두에서 거부되고, 같은 실행에서 정본 부르는 쪽(purchase-svc → payment-svc 등)은 연결된다', () => check('MK-02'));

test('MK-03 D-T36 ③ kind 웹 앱 서버 → identity-svc 업무 gRPC는 연결되고, web이 부르지 않는 업무 gRPC(payment-svc 등)는 거부된다', () => check('MK-03'));

test('MK-04 D-T36 ④ kind 게이트웨이 다섯 → 제어 gRPC 포트 넷(admission-ctrl·purchase-svc·queue-svc·payment-svc): 모두 거부된다', () => check('MK-04'));

test('MK-05 D-T36 ⑤ kind 비상 런북 Job(ops-breakglass 네임스페이스)·ops-svc → 제어 gRPC 포트 넷은 연결되고, purchase-svc·queue-svc·core-svc → admission-ctrl 제어 포트와 표에 없는 파드는 거부된다', () => check('MK-05'));

test('MK-06 D-T36 ⑥ kind gw-fan → trust-svc REST 포트는 연결되고, 다른 게이트웨이 넷·identity-svc·queue-svc·표에 없는 파드는 거부된다', () => check('MK-06'));

test('MK-07 D-T36 ⑦ kind 여덟 서비스와 admission-ctrl → identity-svc 업무 gRPC(GetAdminAuthz)는 연결되고, image-worker·seatmap-worker·partner·표에 없는 파드·게이트웨이는 거부된다', () => check('MK-07'));

test('MK-08 게이트웨이 신원 표: cluster.mjs gateways가 올린 실제 프록시 파드(게이트웨이 다섯)의 서비스 계정이 docs/infra.md §9의 이름 규칙과 같고, policies.yaml이 그 주체를 쓴다', async () => {
  const policies = readFileSync(join(REPO, 'deploy', 'platform', 'mesh', 'policies.yaml'), 'utf8');
  const principals = new Set();
  for (const d of parseAllDocuments(policies)) {
    const o = d.toJS();
    for (const r of o?.spec?.rules ?? []) for (const f of r.from ?? []) for (const p of f.source?.principals ?? []) principals.add(p);
  }
  assert.ok(principals.size > 0, 'policies.yaml에서 주체를 하나도 읽지 못했다');
  for (const g of GATEWAYS) {
    const pods = JSON.parse(await kc(['-n', GW_NS, 'get', 'pods', '-l', `${GW_NAME_LABEL}=${g},${GW_NS_LABEL}=${GW_NS},!${PROBE_LABEL}`, '-o', 'json'])).items ?? [];
    assert.ok(pods.length > 0, `${g}: ${GW_NAME_LABEL}·${GW_NS_LABEL} 라벨을 단 프록시 파드가 없다(cluster.mjs gateways 뒤에 돈다)`);
    const want = gatewayServiceAccount(g);
    for (const p of pods) assert.equal(p.spec?.serviceAccountName, want, `${g} 프록시 파드 ${p.metadata?.name}의 서비스 계정`);
    assert.ok(principals.has(`cluster.local/ns/${GW_NS}/sa/${want}`), `policies.yaml에 ${g}의 주체 cluster.local/ns/${GW_NS}/sa/${want}가 없다`);
  }
});
