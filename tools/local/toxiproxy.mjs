// F-08-9 P-T1 Toxiproxy 로컬 무대(계획 docs/review/plans/F-08-9.md 6.3·7.1, 정본 docs/verification.md §2.5).
// 판은 v2.13.0으로 고정하고, 제어 API(8474)는 kubectl 포트 전달로 127.0.0.1에만 연다. 인증 토큰은 Secret에만 둔다.
// 데이터 프록시(18080)만 payment-svc가 닿는 Service로 연다. 운영 배포가 아니다.
// 쓰는 법: TOXIPROXY_AUTH_TOKEN=<로컬 값> node tools/local/toxiproxy.mjs up|down
import { execFileSync } from 'node:child_process';

export const TOXIPROXY = Object.freeze({
  namespace: 'v1',
  name: 'f089-toxiproxy',
  image: 'ghcr.io/shopify/toxiproxy:2.13.0',
  controlPort: 8474,
  proxyPort: 18080,
  upstream: 'pg-simulator.v1.svc.cluster.local:8080',
  authSecret: 'f089-toxiproxy-auth',
});

/** 로컬 kind에 적용할 객체들. 제어 API는 Service로 열지 않는다(포트 전달만) */
export function toxiproxyObjects({ namespace = TOXIPROXY.namespace, upstream = TOXIPROXY.upstream, authToken } = {}) {
  if (typeof authToken !== 'string' || authToken.length < 16) throw new Error('TOXIPROXY_AUTH_TOKEN이 없거나 너무 짧다');
  return [
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: TOXIPROXY.authSecret, namespace },
      type: 'Opaque',
      stringData: { TOXIPROXY_AUTH_TOKEN: authToken },
    },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: TOXIPROXY.name, namespace, labels: { 'app.kubernetes.io/name': TOXIPROXY.name } },
      spec: {
        replicas: 1,
        selector: { matchLabels: { 'app.kubernetes.io/name': TOXIPROXY.name } },
        template: {
          metadata: { labels: { 'app.kubernetes.io/name': TOXIPROXY.name } },
          spec: {
            containers: [
              {
                name: 'toxiproxy',
                image: TOXIPROXY.image,
                args: ['-host', '0.0.0.0', '-port', String(TOXIPROXY.controlPort)],
                env: [{ name: 'TOXIPROXY_AUTH_TOKEN', valueFrom: { secretKeyRef: { name: TOXIPROXY.authSecret, key: 'TOXIPROXY_AUTH_TOKEN' } } }],
                ports: [
                  { name: 'control', containerPort: TOXIPROXY.controlPort },
                  { name: 'proxy', containerPort: TOXIPROXY.proxyPort },
                ],
                readinessProbe: { tcpSocket: { port: 'control' } },
                securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, capabilities: { drop: ['ALL'] } },
                resources: { requests: { cpu: '100m', memory: '64Mi' }, limits: { cpu: '500m', memory: '256Mi' } },
              },
            ],
          },
        },
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: TOXIPROXY.name, namespace },
      spec: {
        selector: { 'app.kubernetes.io/name': TOXIPROXY.name },
        ports: [{ name: 'proxy', port: TOXIPROXY.proxyPort, targetPort: 'proxy' }],
      },
    },
  ];
}

const KUBECTL = process.env.PEAKET_KUBECTL ?? 'kubectl';
const KUBECONFIG = process.env.PEAKET_KUBECONFIG ?? '.cache/peaket-tools/kubeconfig-lane4-f09';

function kubectl(args, input) {
  return execFileSync(KUBECTL, ['--kubeconfig', KUBECONFIG, ...args], { input, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] });
}

const cmd = process.argv[2];
try {
  if (cmd === 'up') {
    const token = process.env.TOXIPROXY_AUTH_TOKEN;
    const objects = toxiproxyObjects({ authToken: token });
    kubectl(['apply', '-f', '-'], `${objects.map((o) => JSON.stringify(o)).join('\n---\n')}\n`);
    console.log(`toxiproxy: ${TOXIPROXY.image} 적용. 제어 API는 kubectl -n ${TOXIPROXY.namespace} port-forward --address 127.0.0.1 deploy/${TOXIPROXY.name} 8474:8474 로만 연다`);
  } else if (cmd === 'down') {
    kubectl(['-n', TOXIPROXY.namespace, 'delete', 'deploy,svc,secret', '-l', `app.kubernetes.io/name=${TOXIPROXY.name}`, '--ignore-not-found']);
    console.log('toxiproxy: 내렸다');
  } else {
    console.error('쓰는 법: TOXIPROXY_AUTH_TOKEN=<로컬 값> node tools/local/toxiproxy.mjs up|down');
    process.exit(2);
  }
} catch (e) {
  console.error(`toxiproxy: ${e?.message ?? e}`);
  process.exit(1);
}
