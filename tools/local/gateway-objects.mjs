// 로컬 kind의 게이트웨이 다섯(BUILD_ORDER HOT-400, docs/infra.md §4.1 'Envoy 게이트웨이의 첫 구현', 묶음 BAT-055 계획 §5).
// cluster.mjs gateways가 쓰는 순수 함수들: Envoy Gateway 설치 파일 맞추기, deploy/gateways 정의의 로컬 덧씌우기(백엔드·프록시 서비스·이미지만 바꿈),
// 대역 백엔드(echo)·인증서·원본 확인 Secret, 시험이 읽는 접속 정보(tools/local/e2e/gateway-client.mjs 머리 주석의 약속).
// 호스트와 출처는 운영 값(*.peaket.example) 그대로 쓴다. 시험 클라이언트가 Host·SNI로 이름을 보내고 브라우저는 시험 프록시가 포트로 잇는다.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseAllDocuments } from 'yaml';

export const GATEWAY_NAMESPACE = 'envoy-gateway-system';
export const GATEWAY_NAMES = ['gw-queue', 'gw-fan', 'gw-partner', 'gw-ops', 'gw-scanner'];
/** 대역 백엔드(이 네임스페이스에 둔다: 라우트와 같은 곳이라 ReferenceGrant가 없어도 된다) */
export const GATEWAY_ECHO = { name: 'gateway-echo', port: 8080 };
/** 대역 백엔드를 띄우는 Node 이미지(서비스 Dockerfile과 같은 고정 판) */
export const GATEWAY_ECHO_IMAGE = 'node:24.18.0-bookworm-slim';
/** 로컬 kind에서 프록시가 쓰는 태그(이 판의 기본 이미지와 같은 판. 노드에 미리 싣고 다이제스트 대신 태그로 찾는다, BAT-028) */
export const GATEWAY_PROXY_IMAGE = 'docker.io/envoyproxy/envoy:distroless-v1.40.2';
/** 설치 파일의 컨트롤러·인증서 잡 이미지 */
export const GATEWAY_CONTROLLER_IMAGE = 'envoyproxy/gateway:v1.10.0';
/** 이 PC 포트(127.0.0.1)의 기본 시작 값. 게이트웨이마다 1씩 더한다(PEAKET_GATEWAY_BASE_PORT로 바꾼다) */
export const GATEWAY_BASE_PORT = 18441;
/** 시험 발급자(정의의 issuer와 같다) */
export const GATEWAY_ISSUER = 'https://identity.peaket.example';
/** 접속 정보의 확인 경로: 그 게이트웨이의 토큰을 단 요청이 대역 백엔드에 닿는 경로(검색 한도 경로는 쓰지 않는다) */
export const GATEWAY_PROBES = {
  'gw-queue': { host: 'queue', method: 'GET', path: '/v1/queues/{event}/verification', scope: 'ticket:buy', scheme: 'Bearer' },
  'gw-fan': { host: 'api', method: 'GET', path: '/v1/events/{event}', scope: 'ticket:buy', scheme: 'Bearer' },
  'gw-partner': { host: 'partner-api', method: 'GET', path: '/v1/partner/events/{event}', scope: '', scheme: 'Bearer' },
  'gw-ops': { host: 'ops-api', method: 'GET', path: '/v1/ops/events/{event}', scope: '', scheme: 'Bearer' },
  'gw-scanner': { host: 'scanner-api', method: 'GET', path: '/v1/scanner/events/{event}/package', scope: '', scheme: 'DPoP' },
};
export const GATEWAY_APP_PATHS = { 'gw-fan': '/e2e-app', 'gw-partner': '/e2e-app' };
export const GATEWAY_ORIGINS = { www: 'https://www.peaket.example', partner: 'https://partner.peaket.example', console: 'https://console.peaket.example', scanner: 'https://scanner.peaket.example' };

/** deploy/gateways/*.yaml의 객체(파일 이름 차례, 문서 차례) */
export function readGatewayObjects(dir) {
  const out = [];
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    for (const d of parseAllDocuments(readFileSync(join(dir, f), 'utf8'))) {
      if (d.errors.length) throw new Error(`${f}: ${d.errors[0].message}`);
      const o = d.toJS();
      if (o && typeof o === 'object') out.push(o);
    }
  }
  return out;
}

/**
 * Envoy Gateway 설치 파일을 맞춘다: Lua 확장을 켠다(v1.10 기본은 꺼짐, docs/infra.md §4.1 '자리'). 고칠 자리가 없으면(판이 바뀜) 던진다
 * @param {string} text
 */
export function gatewayInstall(text) {
  const anchor = /^( {4})extensionApis: \{\}\r?$/m;
  if (!anchor.test(text)) throw new Error('Envoy Gateway 설치 파일에서 extensionApis 자리를 찾지 못했다(판이 바뀌었나?)');
  if (!text.includes(`image: ${GATEWAY_CONTROLLER_IMAGE}`)) throw new Error(`Envoy Gateway 설치 파일에 ${GATEWAY_CONTROLLER_IMAGE}가 없다(판이 바뀌었나?)`);
  return text.replace(anchor, (_l, indent) => `${indent}extensionApis:\n${indent}  enableLua: true`);
}

const echoRef = () => ({ group: '', kind: 'Service', name: GATEWAY_ECHO.name, port: GATEWAY_ECHO.port });
const echoUrl = (path) => `http://${GATEWAY_ECHO.name}.${GATEWAY_NAMESPACE}.svc.cluster.local:${GATEWAY_ECHO.port}${path}`;

/**
 * 로컬 덧씌우기: 정의는 그대로 두고 로컬에 없는 것만 바꾼다.
 * - 라우트·공개키 묶음·추적의 백엔드 → 대역 백엔드(공개키 묶음 주소의 경로는 그대로)
 * - ReferenceGrant는 뺀다(대역 백엔드가 같은 네임스페이스이고, 운영 네임스페이스가 로컬에 없다)
 * - EnvoyProxy: 프록시 Service는 ClusterIP(kind에 부하 분산기가 없다. 이 PC로는 gateways-forward가 잇는다), 이미지는 미리 실은 태그
 * @param {Array<Record<string, any>>} objects
 */
export function localGatewayObjects(objects) {
  const copy = JSON.parse(JSON.stringify(objects));
  const out = [];
  for (const o of copy) {
    if (o.kind === 'ReferenceGrant') continue;
    if (o.kind === 'HTTPRoute') for (const rule of o.spec?.rules ?? []) if (rule.backendRefs) rule.backendRefs = rule.backendRefs.map(echoRef);
    if (o.kind === 'SecurityPolicy') {
      for (const p of o.spec?.jwt?.providers ?? []) {
        if (!p.remoteJWKS) continue;
        p.remoteJWKS.uri = echoUrl(new URL(p.remoteJWKS.uri).pathname);
        p.remoteJWKS.backendRefs = [echoRef()];
      }
    }
    if (o.kind === 'EnvoyProxy') {
      const k = (o.spec.provider ??= { type: 'Kubernetes' }).kubernetes ??= {};
      k.envoyService = { ...(k.envoyService ?? {}), type: 'ClusterIP' };
      const c = ((k.envoyDeployment ??= {}).container ??= {});
      c.image = GATEWAY_PROXY_IMAGE;
      const tracing = o.spec?.telemetry?.tracing?.provider;
      if (tracing?.backendRefs) tracing.backendRefs = [{ name: GATEWAY_ECHO.name, port: GATEWAY_ECHO.port }];
    }
    out.push(o);
  }
  return out;
}

/** 리스너마다의 인증서 Secret 이름과 호스트(Gateway의 certificateRefs에서) */
export function listenerCertificates(objects) {
  const out = [];
  for (const g of objects.filter((o) => o.kind === 'Gateway')) {
    for (const l of g.spec?.listeners ?? []) for (const ref of l.tls?.certificateRefs ?? []) out.push({ gateway: g.metadata.name, listener: l.name, host: l.hostname, secret: ref.name });
  }
  return out;
}

/** 호스트 키(queue·api…) → 호스트 이름(리스너 이름이 호스트 키다) */
export function hostsOf(objects) {
  return Object.fromEntries(listenerCertificates(objects).map((c) => [c.listener, c.host]));
}

/**
 * 자체 서명 인증서 하나(SAN에 게이트웨이 호스트 전부)를 만드는 openssl 인자(EC P-256, 30일). 시험은 이 인증서를 신뢰 앵커(caPem)로 쓴다
 * @param {string} keyFile @param {string} certFile @param {string[]} hosts
 */
export function gatewayCertArgs(keyFile, certFile, hosts) {
  const san = hosts.map((h) => `DNS:${h}`).join(',');
  return ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '30', '-subj', '/CN=peaket-gateways-e2e', '-addext', `subjectAltName=${san}`, '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', keyFile, '-out', certFile];
}

const secret = (name, type, stringData) => ({ apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: GATEWAY_NAMESPACE }, type, stringData });

/**
 * 이 PC에서 만든 비밀(저장소에 두지 않는다): 리스너 인증서 Secret들과 원본 확인 값 Secret(peaket-origin-verify, 교체 중 두 값 가운데 current만)
 * @param {Array<{ secret: string }>} certs @param {{ cert: string, key: string }} tls @param {string} originVerify
 */
export function gatewaySecrets(certs, tls, originVerify) {
  const names = [...new Set(certs.map((c) => c.secret))];
  return [...names.map((n) => secret(n, 'kubernetes.io/tls', { 'tls.crt': tls.cert, 'tls.key': tls.key })), secret('peaket-origin-verify', 'Opaque', { current: originVerify })];
}

/**
 * 대역 백엔드: 스크립트 ConfigMap, Deployment(복제 1), Service. 공개키 묶음은 환경 값으로 넣는다(공개 부분만)
 * @param {{ script: string, jwks: Record<string, { keys: unknown[] }> }} o
 */
export function echoObjects(o) {
  const labels = { 'app.kubernetes.io/name': GATEWAY_ECHO.name, 'app.kubernetes.io/part-of': 'peaket' };
  for (const [k, v] of Object.entries(o.jwks)) for (const key of v.keys) if (key && typeof key === 'object' && 'd' in key) throw new Error(`공개키 묶음 ${k}에 개인키 칸 d가 있다`);
  return [
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: `${GATEWAY_ECHO.name}-script`, namespace: GATEWAY_NAMESPACE, labels }, data: { 'echo.mjs': o.script } },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: GATEWAY_ECHO.name, namespace: GATEWAY_NAMESPACE, labels },
      spec: {
        replicas: 1,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            automountServiceAccountToken: false,
            containers: [
              {
                name: 'echo',
                image: GATEWAY_ECHO_IMAGE,
                imagePullPolicy: 'IfNotPresent',
                command: ['node', '/app/echo.mjs'],
                env: [
                  { name: 'PORT', value: String(GATEWAY_ECHO.port) },
                  { name: 'PEAKET_E2E_JWKS', value: JSON.stringify(o.jwks) },
                ],
                ports: [{ containerPort: GATEWAY_ECHO.port, name: 'http' }],
                readinessProbe: { tcpSocket: { port: GATEWAY_ECHO.port }, periodSeconds: 2 },
                resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { memory: '128Mi' } },
                securityContext: { runAsNonRoot: true, runAsUser: 1000, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
                volumeMounts: [{ name: 'script', mountPath: '/app', readOnly: true }],
              },
            ],
            volumes: [{ name: 'script', configMap: { name: `${GATEWAY_ECHO.name}-script` } }],
          },
        },
      },
    },
    { apiVersion: 'v1', kind: 'Service', metadata: { name: GATEWAY_ECHO.name, namespace: GATEWAY_NAMESPACE, labels }, spec: { selector: labels, ports: [{ name: 'http', port: GATEWAY_ECHO.port, targetPort: GATEWAY_ECHO.port }] } },
  ];
}

/**
 * 시험이 읽는 접속 정보(tools/local/e2e/gateway-client.mjs 머리 주석의 약속). 개인키가 들어 있어 이 PC의 .cache에만 둔다
 * @param {{ basePort: number, hosts: Record<string, string>, originVerify: string, keys: Record<string, unknown>, caPem: string, replicas?: Record<string, number> }} o
 */
export function gatewayContract(o) {
  return {
    ports: Object.fromEntries(GATEWAY_NAMES.map((gw, i) => [gw, o.basePort + i])),
    hosts: o.hosts,
    origins: GATEWAY_ORIGINS,
    originVerify: o.originVerify,
    issuer: GATEWAY_ISSUER,
    keys: o.keys,
    probes: GATEWAY_PROBES,
    appPaths: GATEWAY_APP_PATHS,
    logs: { namespace: GATEWAY_NAMESPACE, container: 'envoy', selector: 'gateway.envoyproxy.io/owning-gateway-name={gateway}' },
    caPem: o.caPem,
    replicas: { 'gw-fan': 1, ...(o.replicas ?? {}) },
  };
}

/** 게이트웨이 프록시 Service를 이 PC 포트로 잇는 kubectl 인자(서비스 이름은 Envoy Gateway가 만든다) */
export function gatewayForwardArgs(service, port) {
  return ['-n', GATEWAY_NAMESPACE, 'port-forward', '--address', '127.0.0.1', `svc/${service}`, `${port}:443`];
}
