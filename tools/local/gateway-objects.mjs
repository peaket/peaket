// 로컬 kind의 게이트웨이 다섯(BUILD_ORDER HOT-400, docs/infra.md §4.1 'Envoy 게이트웨이의 첫 구현', 묶음 BAT-055 계획 §5).
// cluster.mjs gateways가 쓰는 순수 함수들: Envoy Gateway 설치 파일 맞추기, deploy/gateways 정의의 로컬 덧씌우기(백엔드·프록시 서비스·이미지·프록시 CPU 요청만 바꿈),
// 대역 백엔드(echo)·인증서·원본 확인 Secret, 시험이 읽는 접속 정보(tools/local/e2e/gateway-client.mjs 머리 주석의 약속).
// 호스트와 출처는 운영 값(*.peaket.example) 그대로 쓴다. 시험 클라이언트가 Host·SNI로 이름을 보내고 브라우저는 시험 프록시가 포트로 잇는다.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseAllDocuments, parseDocument } from 'yaml';

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
/**
 * 로컬·CI kind에서 프록시 envoy 컨테이너의 CPU 요청(Envoy Gateway 기본 요청과 같은 값, ADR-0287 결정 4). 정의의 CPU 요청 2 [가정] × 다섯 파드는
 * CI kind 잡의 vCPU 4 러너(ubuntu-24.04 표준)에 들어가지 않아 파드가 뜨지 않는다. 일꾼 수·메모리 요청은 정의 그대로다
 */
export const LOCAL_PROXY_CPU_REQUEST = '100m';
/**
 * 이 PC 포트(127.0.0.1)의 기본 시작 값. 게이트웨이마다 1씩 더한다(PEAKET_GATEWAY_BASE_PORT로 바꾼다). 클러스터를 만들 때(cluster.mjs up)
 * kind 포트 매핑으로 정해지므로, 바꾸려면 down 뒤 up을 다시 한다(docs/infra.md §4.1 '로컬 kind에서 이 PC로 잇는 법')
 */
export const GATEWAY_BASE_PORT = 18441;
/**
 * 게이트웨이마다 로컬 전용 NodePort Service가 받는 노드의 고정 포트(쿠버네티스 NodePort 범위 30000~32767 안, GATEWAY_NAMES 차례).
 * kind 노드의 포트 매핑이 이 PC의 127.0.0.1:<시작 값 + 차례>를 이 포트로 넘긴다. kubectl 포트 전달은 쓰지 않는다: Envoy가 연결 하나를 RST로 끊으면
 * 전달 전체가 'lost connection to pod'로 끝났다(2026-11-16 develop CI kind 잡, 계획 docs/review/plans/W8-L1-ci-fix3.md)
 */
export const GATEWAY_NODE_PORTS = Object.freeze({ 'gw-queue': 30441, 'gw-fan': 30442, 'gw-partner': 30443, 'gw-ops': 30444, 'gw-scanner': 30445 });
/** 시험 발급자(정의의 issuer와 같다) */
export const GATEWAY_ISSUER = 'https://identity.peaket.example';
/**
 * 접속 정보의 확인 경로: 그 게이트웨이의 토큰을 단 요청이 대역 백엔드에 닿는 경로. 생성 라우트는 계약의 (경로, 메서드)만 넘기므로 계약의 GET 경로다(BAT-060).
 * 한도 경로는 쓰지 않는다: 검색 IP 한도와 전역 한도(gw-fan-api·gw-fan-identity 계정당 60회/분. V-T31 ①이 한 계정으로 1,000건을 보낸다).
 * 그래서 gw-fan은 구매 경로(gw-fan-buy, 한도 없음)의 좌석 스냅샷이다
 */
export const GATEWAY_PROBES = {
  'gw-queue': { host: 'queue', method: 'GET', path: '/v1/queues/{event}/verification', scope: 'ticket:buy', scheme: 'Bearer' },
  // 구매 경로라 입장 토큰도 요구한다(admission: true면 손님이 그 회차의 입장 토큰을 X-Admission-Token에 붙인다, docs/infra.md §4.1 '입장 토큰 확인', BAT-057)
  'gw-fan': { host: 'api', method: 'GET', path: '/v1/events/{event}/seatmap-snapshot', scope: 'ticket:buy', scheme: 'Bearer', admission: true },
  'gw-partner': { host: 'partner-api', method: 'GET', path: '/v1/partner/events/{event}/attendees', scope: '', scheme: 'Bearer' },
  'gw-ops': { host: 'ops-api', method: 'GET', path: '/v1/ops/events/{event}/live', scope: '', scheme: 'Bearer' },
  'gw-scanner': { host: 'scanner-api', method: 'GET', path: '/v1/scanner/events/{event}/package', scope: '', scheme: 'DPoP' },
};
export const GATEWAY_APP_PATHS = { 'gw-fan': '/e2e-app', 'gw-partner': '/e2e-app' };

/**
 * 입장 토큰 키 목록 ConfigMap(EnvoyProxy peaket-proxy가 키 jwks를 PEAKET_ADMISSION_JWKS로 받는다, optional: true).
 * docs/infra.md §4.1 '입장 토큰 확인', ADR-0288 결정 5. 운영은 배포 때 queue-svc 묶음과 같은 값을 넣고, 로컬 kind는 cluster.mjs gateways가 시험 키로 만든다
 */
export const ADMISSION_JWKS_CONFIGMAP = Object.freeze({ name: 'peaket-admission-jwks', key: 'jwks' });
/** 시험 입장 토큰 발급자(deploy/gateways/gw-fan.yaml gw-fan-buy-edge의 admissionIssuer와 같다, ADR-0288 결정 8) */
export const GATEWAY_ADMISSION_ISSUER = 'https://queue.peaket.example';
/** 시험 옛 키 둘의 끝 시각 거리(초): 끝 시각이 남은 옛 키는 지금 + 1시간, 끝 시각이 지난 옛 키는 지금 − 1시간 */
export const ADMISSION_PREVIOUS_UNTIL_SECONDS = 3600;
/** kind 명령 gateways-admission의 방식: restore(처음 값), empty(빈 묶음 {"keys":[]}), remove(ConfigMap 지움) */
export const GATEWAYS_ADMISSION_MODES = Object.freeze(['restore', 'empty', 'remove']);

/** 개인 JWK의 공개 부분(queue-svc 묶음 원소와 같은 칸: kty·crv·x·y·kid·alg·use). 개인키 칸 d는 싣지 않는다 */
const publicAdmissionJwk = (jwk) => ({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid: jwk.kid, alg: 'ES256', use: 'sig' });

/**
 * 시험 입장 토큰 키 넷(접속 정보의 admission 칸): 지금 키·다음 키·끝 시각이 남은 옛 키·끝 시각이 지난 옛 키. kid가 겹치면 던진다
 * @param {{ current: { kid: string }, next: { kid: string }, previous: { kid: string }, expired: { kid: string } }} keys 개인 JWK 넷
 * @param {number} nowSeconds 지금(초)
 */
export function admissionKeySet(keys, nowSeconds) {
  const kids = [keys.current, keys.next, keys.previous, keys.expired].map((k) => k?.kid);
  if (kids.some((k) => typeof k !== 'string' || k === '') || new Set(kids).size !== kids.length) throw new Error('시험 입장 토큰 키 넷의 kid가 없거나 겹친다');
  if (!Number.isInteger(nowSeconds)) throw new Error('지금(초)은 정수다');
  return {
    issuer: GATEWAY_ADMISSION_ISSUER,
    current: keys.current,
    next: keys.next,
    previous: { jwk: keys.previous, until: nowSeconds + ADMISSION_PREVIOUS_UNTIL_SECONDS },
    expired: { jwk: keys.expired, until: nowSeconds - ADMISSION_PREVIOUS_UNTIL_SECONDS },
  };
}

/**
 * 키 넷의 공개 묶음(queue-svc GET /internal/jwks/admission.json과 같은 꼴, 옛 키 원소에 peaket_until). 개인키 칸 d는 싣지 않는다
 * @param {ReturnType<typeof admissionKeySet>} set
 */
export function admissionJwks(set) {
  return {
    keys: [
      publicAdmissionJwk(set.current),
      publicAdmissionJwk(set.next),
      { ...publicAdmissionJwk(set.previous.jwk), peaket_until: set.previous.until },
      { ...publicAdmissionJwk(set.expired.jwk), peaket_until: set.expired.until },
    ],
  };
}

/**
 * 게이트웨이 키 목록 ConfigMap(ADMISSION_JWKS_CONFIGMAP). 값은 JSON 글 하나다. 원소에 개인키 칸 d가 있으면 던진다
 * @param {{ keys: unknown[] }} jwks
 */
export function admissionJwksConfigMap(jwks) {
  if (!jwks || !Array.isArray(jwks.keys)) throw new Error('입장 토큰 키 목록은 { keys: [...] }다');
  for (const k of jwks.keys) if (k && typeof k === 'object' && 'd' in k) throw new Error('입장 토큰 키 목록에 개인키 칸 d가 있다');
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: ADMISSION_JWKS_CONFIGMAP.name, namespace: GATEWAY_NAMESPACE, labels: { 'app.kubernetes.io/part-of': 'peaket-local' } },
    data: { [ADMISSION_JWKS_CONFIGMAP.key]: JSON.stringify(jwks) },
  };
}

/**
 * gateways-admission 명령 인자에서 방식 하나(GATEWAYS_ADMISSION_MODES). 없거나 모르는 값이거나 인자가 더 있으면 던진다
 * @param {readonly string[]} argv
 */
export function gatewaysAdmissionMode(argv) {
  if (argv.length !== 1 || !GATEWAYS_ADMISSION_MODES.includes(argv[0])) throw new Error(`쓰는 법: node tools/local/cluster.mjs gateways-admission ${GATEWAYS_ADMISSION_MODES.join('|')}`);
  return argv[0];
}
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

/** 레이트 리밋 서비스(Envoy Gateway가 컨트롤러 네임스페이스에 만드는 Deployment, internal/infrastructure/kubernetes/ratelimit InfraName, v1.10.0) */
export const GATEWAY_RATELIMIT = { deployment: 'envoy-ratelimit' };
/**
 * 레이트 리밋 서비스의 카운터 저장소(로컬 kind는 TLS만 받는 Valkey 하나). 이름은 컨트롤러 설정(deploy/gateways/controller/envoy-gateway.yaml)의
 * rateLimit.backend.redis.url·tls.certificateRef와 같다(로컬 덧씌우기 없이 같은 이름을 쓴다)
 */
export const RATELIMIT_REDIS = { name: 'peaket-ratelimit-redis', secret: 'peaket-ratelimit-redis-tls', port: 6379 };
/** 카운터 저장소의 Valkey 이미지(v0 배포 deploy/local/valkey.yaml과 같은 판) */
export const RATELIMIT_REDIS_IMAGE = 'valkey/valkey:8.1-alpine';

/**
 * Envoy Gateway 설치 파일을 맞춘다: 설치 파일의 컨트롤러 설정 자리(ConfigMap envoy-gateway-config의 envoy-gateway.yaml)를 받은 EnvoyGateway 설정 글로 바꾼다
 * (Lua 확장·전역 레이트 리밋 백엔드·레이트 리밋 서비스 배치, docs/infra.md §4.1 '전역 레이트 리밋 걸기'). 다른 문서는 글자 그대로 둔다.
 * 자리나 컨트롤러 이미지를 찾지 못하거나(판이 바뀜) 받은 설정이 EnvoyGateway가 아니면 던진다
 * @param {string} text 설치 파일 글 @param {string} controller 컨트롤러 설정 글(EnvoyGateway 객체 하나)
 */
export function gatewayInstall(text, controller) {
  if (!text.includes(`image: ${GATEWAY_CONTROLLER_IMAGE}`)) throw new Error(`Envoy Gateway 설치 파일에 ${GATEWAY_CONTROLLER_IMAGE}가 없다(판이 바뀌었나?)`);
  const cfg = parseAllDocuments(String(controller ?? ''))
    .map((d) => d.toJS())
    .filter(Boolean);
  if (cfg.length !== 1 || cfg[0]?.kind !== 'EnvoyGateway') throw new Error('컨트롤러 설정은 EnvoyGateway 객체 하나다');
  const body = String(controller).endsWith('\n') ? String(controller) : `${controller}\n`;
  let found = 0;
  const parts = text.split(/^---[ \t]*\r?\n/m).map((part) => {
    if (!/^kind: ConfigMap\r?$/m.test(part) || !/^ {2}name: envoy-gateway-config\r?$/m.test(part)) return part;
    const doc = parseDocument(part);
    if (doc.errors.length) throw new Error(`envoy-gateway-config를 읽지 못했다: ${doc.errors[0].message}`);
    if (typeof doc.getIn(['data', 'envoy-gateway.yaml']) !== 'string') throw new Error('envoy-gateway-config에 envoy-gateway.yaml 자리가 없다(판이 바뀌었나?)');
    found++;
    doc.setIn(['data', 'envoy-gateway.yaml'], body);
    return doc.toString({ lineWidth: 0 });
  });
  if (found !== 1) throw new Error(`Envoy Gateway 설치 파일에서 컨트롤러 설정 자리(envoy-gateway-config)를 ${found}곳 찾았다(하나여야 한다, 판이 바뀌었나?)`);
  return parts.join('---\n');
}

/**
 * 컨트롤러 설정이 로컬 카운터 저장소 이름과 맞는지(같은 이름을 쓰므로 덧씌우지 않는다). 다르면 던진다
 * @param {string} controller
 */
export function assertRatelimitBackend(controller) {
  const redis = parseAllDocuments(controller)[0]?.toJS()?.rateLimit?.backend?.redis;
  const want = `${RATELIMIT_REDIS.name}.${GATEWAY_NAMESPACE}.svc.cluster.local:${RATELIMIT_REDIS.port}`;
  if (redis?.url !== want) throw new Error(`컨트롤러 설정의 rateLimit.backend.redis.url(${redis?.url})이 로컬 저장소 ${want}와 다르다`);
  if (redis?.tls?.certificateRef?.name !== RATELIMIT_REDIS.secret) throw new Error(`컨트롤러 설정의 Redis 인증서 Secret(${redis?.tls?.certificateRef?.name})이 ${RATELIMIT_REDIS.secret}가 아니다`);
}

/** 카운터 저장소 인증서의 SAN(Service 이름 꼴 넷과 kubectl exec로 붙는 localhost) */
export function ratelimitRedisTlsNames() {
  const n = RATELIMIT_REDIS.name;
  return [n, `${n}.${GATEWAY_NAMESPACE}`, `${n}.${GATEWAY_NAMESPACE}.svc`, `${n}.${GATEWAY_NAMESPACE}.svc.cluster.local`, 'localhost'];
}

/**
 * 레이트 리밋 서비스의 카운터 저장소: TLS 포트 6379만 여는 Valkey 하나(평문 포트는 닫는다, 클라이언트 인증서는 받지 않는다)와 그 Service.
 * 서버 인증서는 Secret RATELIMIT_REDIS.secret(tls.crt·tls.key·ca.crt)이고, 레이트 리밋 서비스도 같은 Secret의 ca.crt로 서버를 믿는다
 */
export function ratelimitRedisObjects() {
  const { name, secret: secretName, port } = RATELIMIT_REDIS;
  const labels = { 'app.kubernetes.io/name': name, 'app.kubernetes.io/part-of': 'peaket' };
  return [
    { apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: GATEWAY_NAMESPACE, labels }, spec: { selector: labels, ports: [{ name: 'redis', port, targetPort: port }] } },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace: GATEWAY_NAMESPACE, labels },
      spec: {
        replicas: 1,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            automountServiceAccountToken: false,
            securityContext: { runAsNonRoot: true, runAsUser: 999, runAsGroup: 999, seccompProfile: { type: 'RuntimeDefault' } },
            containers: [
              {
                name: 'valkey',
                image: RATELIMIT_REDIS_IMAGE,
                imagePullPolicy: 'IfNotPresent',
                args: ['valkey-server', '--save', '', '--appendonly', 'no', '--protected-mode', 'no', '--port', '0', '--tls-port', String(port), '--tls-cert-file', '/tls/tls.crt', '--tls-key-file', '/tls/tls.key', '--tls-ca-cert-file', '/tls/ca.crt', '--tls-auth-clients', 'no'],
                ports: [{ name: 'redis', containerPort: port }],
                readinessProbe: { tcpSocket: { port }, periodSeconds: 2 },
                resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { memory: '256Mi' } },
                securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, capabilities: { drop: ['ALL'] } },
                volumeMounts: [
                  { name: 'data', mountPath: '/data' },
                  { name: 'tls', mountPath: '/tls', readOnly: true },
                ],
              },
            ],
            volumes: [
              { name: 'data', emptyDir: {} },
              { name: 'tls', secret: { secretName } },
            ],
          },
        },
      },
    },
  ];
}

/**
 * 카운터 저장소 인증서 Secret(tls.crt·tls.key·ca.crt). 레이트 리밋 서비스는 이 Secret을 /redis-certs에 붙인다(Envoy Gateway가 tls.crt·tls.key를 클라이언트 인증서로 넘기고,
 * 컨트롤러 설정의 REDIS_TLS_CACERT가 ca.crt를 가리킨다). Valkey는 클라이언트 인증서를 받지 않으므로 서버 키 쌍을 함께 넣어도 된다
 * @param {{ ca: string, cert: string, key: string }} tls
 */
export function ratelimitRedisSecret(tls) {
  return secret(RATELIMIT_REDIS.secret, 'kubernetes.io/tls', { 'tls.crt': tls.cert, 'tls.key': tls.key, 'ca.crt': tls.ca });
}

const echoRef = () => ({ group: '', kind: 'Service', name: GATEWAY_ECHO.name, port: GATEWAY_ECHO.port });
const echoUrl = (path) => `http://${GATEWAY_ECHO.name}.${GATEWAY_NAMESPACE}.svc.cluster.local:${GATEWAY_ECHO.port}${path}`;

/**
 * 로컬 덧씌우기: 정의는 그대로 두고 로컬에 없는 것만 바꾼다.
 * - 라우트·공개키 묶음·추적의 백엔드 → 대역 백엔드(공개키 묶음 주소의 경로는 그대로)
 * - ReferenceGrant는 뺀다(대역 백엔드가 같은 네임스페이스이고, 운영 네임스페이스가 로컬에 없다)
 * - EnvoyProxy: 프록시 Service는 ClusterIP(kind에 부하 분산기가 없다. 이 PC로는 게이트웨이마다 따로 만드는 gatewayNodePortService와 kind 포트 매핑이 잇는다.
 *   EnvoyProxy는 게이트웨이 넷이 함께 쓰므로 여기서 NodePort로 바꾸면 노드 포트를 게이트웨이마다 고정할 수 없다), 이미지는 미리 실은 태그,
 *   envoy 컨테이너의 CPU 요청은 정의에 있을 때만 LOCAL_PROXY_CPU_REQUEST(100m)로 낮춘다(다섯 파드 × CPU 2가 CI의 vCPU 4 러너에 들어가지 않는다,
 *   docs/infra.md §4.1 '프록시 일꾼 수와 파드 CPU', ADR-0287 결정 4). 일꾼 수(spec.concurrency)·메모리 요청은 그대로 두고, 한도·일꾼 수 칸을 새로 만들지 않는다
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
      const req = c.resources?.requests;
      if (req && req.cpu !== undefined) req.cpu = LOCAL_PROXY_CPU_REQUEST;
      const tracing = o.spec?.telemetry?.tracing?.provider;
      if (tracing?.backendRefs) tracing.backendRefs = [{ name: GATEWAY_ECHO.name, port: GATEWAY_ECHO.port }];
    }
    out.push(o);
  }
  return out;
}

/**
 * 데모 전용 교차 출처 덧붙이기(계획 리뷰 반영 RV-01). 공용 deploy/gateways 정의는 게이트웨이마다 화면 출처 하나만
 * 허용한다(ASVS 3.4.2·3.5.1). 로컬 데모는 대기실(queue)·스캐너(scanner) 앱을 같은 API 호스트(gw-fan) 뒤 다른
 * 포트로 두므로, 그 두 화면 출처가 gw-fan 정책에만 더 있어야 한다. 다른 게이트웨이의 출처는 넓히지 않는다.
 * 입력 객체는 바꾸지 않고, 이미 있는 출처는 다시 넣지 않는다(두 번 적용해도 안전).
 * @param {Array<Record<string, any>>} objects deploy/gateways 객체 @param {Record<string, string>} origins demoOrigins()
 */
export function demoOriginSecurityPatch(objects, origins) {
  if (!origins || typeof origins !== 'object') throw new Error('데모 출처 목록이 필요하다(demoOrigins())');
  const extra = [origins.queue, origins.scanner].filter((v) => typeof v === 'string' && v !== '');
  if (extra.length !== 2) throw new Error('데모 출처에 대기실(queue)·스캐너(scanner)가 모두 있어야 한다');
  // SecurityPolicy의 targetRef는 HTTPRoute 이름이다. 그 라우트의 parentRef로 게이트웨이를 찾는다
  const gatewayOfRoute = new Map();
  for (const o of objects) {
    if (o.kind !== 'HTTPRoute') continue;
    const name = o.metadata?.name;
    const gateway = (o.spec?.parentRefs ?? []).map((p) => p?.name).find(Boolean);
    if (name && gateway) gatewayOfRoute.set(name, gateway);
  }
  const out = JSON.parse(JSON.stringify(objects));
  for (const o of out) {
    if (o.kind !== 'SecurityPolicy') continue;
    const gateways = (o.spec?.targetRefs ?? []).map((t) => gatewayOfRoute.get(t?.name)).filter(Boolean);
    if (!gateways.includes('gw-fan')) continue;
    const add = (list) => {
      if (!Array.isArray(list)) return list;
      const values = list.map((v) => (typeof v === 'string' ? v : v?.value)).filter(Boolean);
      for (const origin of extra) if (!values.includes(origin)) list.push(origin);
      return list;
    };
    if (o.spec?.cors) o.spec.cors.allowOrigins = add(o.spec.cors.allowOrigins);
    if (o.spec?.csrf) o.spec.csrf.additionalOrigins = add(o.spec.csrf.additionalOrigins);
  }
  return out;
}

/** 리스너마다의 인증서 Secret 이름과 호스트(Gateway의 certificateRefs에서) */export function listenerCertificates(objects) {
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
 * 시험이 읽는 접속 정보(tools/local/e2e/gateway-client.mjs 머리 주석의 약속. 레이트 리밋 칸 rateLimit·rateLimitRedis·stats와 replicas의 gw-partner는
 * tools/local/e2e/gateway-limits.e2e.mjs 머리 주석의 약속, BAT-060). 개인키가 들어 있어 이 PC의 .cache에만 둔다
 * ports는 kind 노드의 실제 포트 공개에서 읽은 값이다(gatewayHostPorts. 시작 값으로 계산하지 않는다)
 * admission은 입장 토큰 시험 키 넷(admissionKeySet, BAT-057 계획 §5): { issuer, current, next, previous: { jwk, until }, expired: { jwk, until } }(개인 JWK, until은 초)
 * @param {{ ports: Record<string, number>, hosts: Record<string, string>, originVerify: string, keys: Record<string, unknown>, caPem: string, replicas?: Record<string, number>, admission?: ReturnType<typeof admissionKeySet> }} o
 */
export function gatewayContract(o) {
  return {
    ports: Object.fromEntries(GATEWAY_NAMES.map((gw) => [gw, o.ports[gw]])),
    hosts: o.hosts,
    origins: GATEWAY_ORIGINS,
    originVerify: o.originVerify,
    issuer: GATEWAY_ISSUER,
    keys: o.keys,
    probes: GATEWAY_PROBES,
    ...(o.admission ? { admission: o.admission } : {}),
    appPaths: GATEWAY_APP_PATHS,
    logs: { namespace: GATEWAY_NAMESPACE, container: 'envoy', selector: 'gateway.envoyproxy.io/owning-gateway-name={gateway}' },
    caPem: o.caPem,
    replicas: { 'gw-fan': 1, 'gw-partner': 1, ...(o.replicas ?? {}) },
    rateLimit: { namespace: GATEWAY_NAMESPACE, deployment: GATEWAY_RATELIMIT.deployment },
    rateLimitRedis: {
      namespace: GATEWAY_NAMESPACE,
      target: `deploy/${RATELIMIT_REDIS.name}`,
      container: 'valkey',
      cli: ['valkey-cli', '--tls', '--cacert', '/tls/ca.crt', '-h', 'localhost', '-p', String(RATELIMIT_REDIS.port)],
      plainCli: ['valkey-cli', '-h', 'localhost', '-p', String(RATELIMIT_REDIS.port)],
    },
    stats: { port: 19001, path: '/stats/prometheus' },
  };
}

/**
 * kind 노드의 포트 매핑 다섯(GATEWAY_NAMES 차례): 이 PC의 127.0.0.1:<시작 값 + 차례> → 노드의 GATEWAY_NODE_PORTS. 이 PC 밖에는 열지 않는다
 * @param {number} basePort
 * @returns {Array<{ containerPort: number, hostPort: number, listenAddress: '127.0.0.1', protocol: 'TCP' }>}
 */
export function gatewayPortMappings(basePort) {
  if (!Number.isInteger(basePort) || basePort < 1 || basePort + GATEWAY_NAMES.length - 1 > 65535) throw new Error(`게이트웨이 시작 포트가 맞지 않다: ${basePort}(PEAKET_GATEWAY_BASE_PORT, 1~${65536 - GATEWAY_NAMES.length})`);
  return GATEWAY_NAMES.map((gw, i) => ({ containerPort: GATEWAY_NODE_PORTS[gw], hostPort: basePort + i, listenAddress: '127.0.0.1', protocol: 'TCP' }));
}

/**
 * 게이트웨이 하나의 로컬 전용 NodePort Service(peaket-local-<게이트웨이>). 그 게이트웨이의 프록시 파드만 고르고(접속 정보 logs.selector와 같은 라벨),
 * 443을 프록시 컨테이너의 HTTPS 포트(targetPort: Envoy Gateway가 만든 그 게이트웨이 Service의 443 포트 targetPort)로 넘기며, 노드 포트는 GATEWAY_NODE_PORTS로 고정한다
 * @param {string} gw @param {number} targetPort
 */
export function gatewayNodePortService(gw, targetPort) {
  if (!(gw in GATEWAY_NODE_PORTS)) throw new Error(`모르는 게이트웨이: ${gw}`);
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: `peaket-local-${gw}`, namespace: GATEWAY_NAMESPACE, labels: { 'app.kubernetes.io/part-of': 'peaket-local', 'app.kubernetes.io/component': 'gateway-node-port' } },
    spec: {
      type: 'NodePort',
      selector: { 'gateway.envoyproxy.io/owning-gateway-name': gw },
      ports: [{ name: 'https', protocol: 'TCP', port: 443, targetPort, nodePort: GATEWAY_NODE_PORTS[gw] }],
    },
  };
}

/**
 * kind 노드 컨테이너의 포트 공개(docker inspect의 HostConfig.PortBindings)에서 게이트웨이마다 이 PC 포트를 읽는다(접속 정보의 ports).
 * 하나라도 없으면(포트 매핑 없이 만든 클러스터) 또는 127.0.0.1 밖(0.0.0.0·빈 값 = 모든 주소)에 열렸으면 다시 만들라는 말과 함께 던진다
 * @param {Record<string, Array<{ HostIp?: string, HostPort?: string }> | null> | null | undefined} portBindings
 * @param {{ again?: string }} [o] 다시 만드는 안내. 데모는 다른 클러스터를 지우지 않는 명령을 넘긴다(RV-04)
 * @returns {Record<string, number>}
 */
export function gatewayHostPorts(portBindings, o = {}) {
  const again = o.again ?? '`node tools/local/cluster.mjs down` 뒤 `up`으로 클러스터를 다시 만든다';
  const out = {};
  for (const gw of GATEWAY_NAMES) {
    const key = `${GATEWAY_NODE_PORTS[gw]}/tcp`;
    const bindings = portBindings?.[key];
    if (!Array.isArray(bindings) || bindings.length === 0) throw new Error(`${gw}의 노드 포트 ${key}가 이 PC에 공개되지 않았다: 이 클러스터는 게이트웨이 포트 매핑 없이 만들었다. ${again}`);
    for (const b of bindings) {
      if (b?.HostIp !== '127.0.0.1') throw new Error(`${gw}의 노드 포트 ${key}가 127.0.0.1이 아닌 주소(${b?.HostIp || '모든 주소'})에 공개되었다: 이 PC 밖에 열지 않는다. ${again}`);
    }
    const port = Number(bindings[0].HostPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${gw}의 노드 포트 ${key}의 이 PC 포트가 맞지 않다: ${bindings[0].HostPort}. ${again}`);
    out[gw] = port;
  }
  return out;
}
