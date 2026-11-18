// 메시 없는 실행의 포트별 허용 NetworkPolicy를 kind에서 보는 무대(BUILD_ORDER HOT-420, D-T36, ADR-0285 결정 13, 묶음 BAT-061 계획 4.4).
// node tools/local/cluster.mjs mesh-netpol이 쓴다: 원천(deploy/platform/mesh/port-allow.yaml)의 워크로드마다 받는 쪽 대역 파드를 띄우고
// 생성 파일 deploy/platform/mesh/meshless-networkpolicies.yaml을 그대로 적용한다. 대역은 그 워크로드의 모든 포트에서 TCP 연결을 받아
// 'ok\n'을 쓰고 닫는다. 시험(tools/local/e2e/mesh-netpol.e2e.mjs)은 부르는 쪽 네임스페이스·라벨로 짧은 시험 파드를 띄워 붙어 본다.
// 새 이미지는 없다: 게이트웨이 대역 백엔드와 같은 고정 Node 이미지(GATEWAY_ECHO_IMAGE)를 쓴다.
import { parse } from 'yaml';

export const MESH_NETPOL_SOURCE = 'deploy/platform/mesh/port-allow.yaml';
export const MESH_NETPOL_POLICIES = 'deploy/platform/mesh/meshless-networkpolicies.yaml';
/** 대역이 연결마다 쓰는 답 */
export const MESH_NETPOL_REPLY = 'ok\n';
/**
 * 대역 파드·Service에만 다는 라벨. Service·Deployment 고르개에 넣어, 부르는 쪽 라벨(원천 podLabels)을 단 시험 파드가 같은 네임스페이스에 떠도
 * 대역 Service의 끝점이 되지 않게 한다. NetworkPolicy는 원천 podLabels만 본다
 */
export const MESH_NETPOL_STANDIN_LABEL = { 'peaket.io/mesh-netpol': 'stand-in' };
const PORT_KINDS = ['rest', 'grpc', 'control', 'metrics'];

/** 대역 스크립트(node -e). PEAKET_STANDIN_PORTS(쉼표로 나눈 포트)마다 듣고, 연결마다 답을 쓰고 닫는다 */
export const MESH_NETPOL_STANDIN_SCRIPT = [
  "const net = require('node:net');",
  "const ports = String(process.env.PEAKET_STANDIN_PORTS).split(',').map(Number);",
  'for (const p of ports) {',
  "  net.createServer((s) => { s.on('error', () => {}); s.end(" + JSON.stringify(MESH_NETPOL_REPLY) + '); })',
  "    .on('error', (e) => { console.error(`listen ${p}: ${e.message}`); process.exit(1); })",
  "    .listen(p, '0.0.0.0', () => console.log(`listening ${p}`));",
  '}',
  "process.on('SIGTERM', () => process.exit(0));",
].join('\n');

/**
 * 원천 글 → 무대 배치: 워크로드마다 네임스페이스·파드 라벨·포트, 만들 네임스페이스(워크로드와 부르는 쪽의 메시 없는 네임스페이스)
 * @param {string} sourceText port-allow.yaml 글
 * @returns {{ namespaces: string[], workloads: Array<{ name: string, namespace: string, podLabels: Record<string, string>, ports: Record<string, number> }> }}
 */
export function meshNetpolLayout(sourceText) {
  const src = parse(sourceText);
  if (!src || typeof src.workloads !== 'object' || !Object.keys(src.workloads ?? {}).length) throw new Error(`${MESH_NETPOL_SOURCE}에 워크로드가 없다`);
  const namespaces = new Set();
  const workloads = [];
  for (const [name, w] of Object.entries(src.workloads).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const ports = {};
    for (const kind of PORT_KINDS) if (w.ports?.[kind]?.port) ports[kind] = w.ports[kind].port;
    if (!Object.keys(ports).length) throw new Error(`${MESH_NETPOL_SOURCE}: ${name}에 받는 포트가 없어 대역이 들을 곳이 없다`);
    if (!w.podLabels || !Object.keys(w.podLabels).length) throw new Error(`${MESH_NETPOL_SOURCE}: ${name}의 podLabels가 비었다`);
    namespaces.add(w.namespace);
    workloads.push({ name, namespace: w.namespace, podLabels: { ...w.podLabels }, ports });
  }
  for (const c of Object.values(src.callers ?? {})) if (c?.meshless?.namespace) namespaces.add(c.meshless.namespace);
  return { namespaces: [...namespaces].sort(), workloads };
}

/**
 * 받는 쪽 대역: 워크로드마다 Deployment(복제 1, 라벨 = 원천 podLabels + 대역 라벨, 제한 파드 보안 기준, 서비스 계정 토큰 없음)와 같은 이름의 Service(ClusterIP, 그 포트들)
 * @param {ReturnType<typeof meshNetpolLayout>} layout
 * @param {string} image 고정 Node 이미지
 */
export function meshNetpolStandIns(layout, image) {
  const out = [];
  for (const w of layout.workloads) {
    const labels = { ...w.podLabels, ...MESH_NETPOL_STANDIN_LABEL };
    const ports = Object.entries(w.ports).sort((a, b) => a[1] - b[1]);
    out.push({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: w.name, namespace: w.namespace, labels },
      spec: {
        replicas: 1,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            terminationGracePeriodSeconds: 5,
            securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
            containers: [
              {
                name: 'stand-in',
                image,
                imagePullPolicy: 'IfNotPresent',
                command: ['node', '-e', MESH_NETPOL_STANDIN_SCRIPT],
                env: [{ name: 'PEAKET_STANDIN_PORTS', value: ports.map(([, p]) => String(p)).join(',') }],
                ports: ports.map(([kind, p]) => ({ name: kind, containerPort: p })),
                readinessProbe: { tcpSocket: { port: ports[0][1] }, periodSeconds: 2 },
                resources: { requests: { cpu: '10m', memory: '48Mi' }, limits: { memory: '96Mi' } },
                securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } },
              },
            ],
          },
        },
      },
    });
    out.push({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: w.name, namespace: w.namespace, labels },
      spec: { type: 'ClusterIP', selector: labels, ports: ports.map(([kind, p]) => ({ name: kind, port: p, targetPort: p, protocol: 'TCP' })) },
    });
  }
  return out;
}

/**
 * 시험 접속 정보(.cache/peaket-tools/mesh-netpol-e2e.json, 비밀 없음). 워크로드마다 네임스페이스·호스트·포트, 시험 파드 이미지, 대역의 답
 * @param {ReturnType<typeof meshNetpolLayout>} layout
 * @param {string} image
 */
export function meshNetpolContract(layout, image) {
  return {
    image,
    reply: MESH_NETPOL_REPLY,
    policies: MESH_NETPOL_POLICIES,
    namespaces: layout.namespaces,
    standInLabel: MESH_NETPOL_STANDIN_LABEL,
    workloads: Object.fromEntries(layout.workloads.map((w) => [w.name, { namespace: w.namespace, host: `${w.name}.${w.namespace}.svc.cluster.local`, ports: w.ports }])),
  };
}
