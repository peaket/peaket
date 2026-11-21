// BAT-087 데모 무대의 객체·값(로컬 kind). 클러스터를 부르지 않는 순수 함수다(시험: demo-objects.test.mjs).
// - 워크로드: 서비스 5(새 이미지) + bundle·ops-svc·pg-simulator(기존 이미지) + 앱 5 + mock-idv
// - 저장소: PostgreSQL 하나(purchase)에 논리 DB 셋, Valkey 하나(대기열·좌석·세션), Kafka 토픽 여섯
// - 게이트웨이: deploy/gateways의 실제 HTTPRoute·ReferenceGrant를 그대로 올리고, 데모에만 필요한 것(앱 리스너·대기실 라우트·
//   포트 붙은 출처·bundle이 사는 purchase 네임스페이스로의 backendRef)만 더한다. 대역 백엔드(gateway-echo)는 쓰지 않는다
// - 로컬 데모의 PEAKET_ENV는 local이다(demo가 아니다). 합본은 local·ci에서만 시작한다(감독 결정 2026-11-20)
// - 비밀 값은 여기서 만들지 않는다. cluster.mjs가 이 PC에서 만들어 Secret으로만 넣고 `.cache/peaket-tools/demo-secrets/`에 둔다
import { V1_PORTS, v1EnvFiles } from './v1-stage.mjs';
import { V1_KAFKA_TOPICS, V1_POSTGRES_TAG, V1_VALKEY_TAG } from './v1-objects.mjs';
import { demoOriginSecurityPatch, GATEWAY_PROXY_IMAGE, LOCAL_PROXY_CPU_REQUEST } from './gateway-objects.mjs';

export const DEMO_ENV = 'local';
export const DEMO_CLUSTER = 'lane4-demo';
export const DEMO_SEED_FILE = 'deploy/envs/demo/seed/base.yaml';
export const DEMO_OVERLAY_DIR = 'deploy/envs/local/demo';
export const DEMO_SECRETS_DIR = '.cache/peaket-tools/demo-secrets';
/** 데모 네임스페이스 여섯(deploy/gateways의 ReferenceGrant와 같은 이름) */
export const DEMO_NAMESPACES = Object.freeze(['queue', 'purchase', 'ticket', 'trust', 'core', 'web']);
/** 이 PC 포트의 시작 값과 워크로드별 포트(deploy/gateways 리스너 이름 차례와 같다) */
export const DEMO_GATEWAY_BASE_PORT = 18441;
export const DEMO_GATEWAY_PORTS = Object.freeze({ www: 18441, api: 18441, queue: 18442, 'queue-files': 18442, partner: 18443, 'partner-api': 18443, 'ops-api': 18444, console: 18444, 'scanner-api': 18445, scanner: 18445 });
/** 업무 gRPC(identity)와 모의 기관의 kind 노드 포트·이 PC 포트 */
export const DEMO_PORTS = Object.freeze({ grpc: 19051, grpcNodePort: 30051, idv: 18920, idvNodePort: 30189 });
/** 정본 호스트 이름(deploy/gateways의 리스너 그대로) */
export const DEMO_HOSTS = Object.freeze({
  www: 'www.peaket.example',
  api: 'api.peaket.example',
  queue: 'queue.peaket.example',
  'queue-files': 'queue-files.peaket.example',
  partner: 'partner.peaket.example',
  'partner-api': 'partner-api.peaket.example',
  'ops-api': 'ops-api.peaket.example',
  console: 'console.peaket.example',
  'scanner-api': 'scanner-api.peaket.example',
  scanner: 'scanner.peaket.example',
});
/** 포트를 붙인 출처(브라우저 Origin·CORS·PEAKET_WEB_ORIGIN이 같아야 한다) */
export function demoOrigins(ports = DEMO_GATEWAY_PORTS) {
  return Object.fromEntries(Object.entries(DEMO_HOSTS).map(([k, host]) => [k, `https://${host}:${ports[k]}`]));
}
/** 호스트 키별 origin. 포트 없는 정본 이름을 포트 붙은 값으로 바꿀 때 쓴다 */
const BASE_ORIGINS = Object.fromEntries(Object.entries(DEMO_HOSTS).map(([k, host]) => [`https://${host}`, `https://${host}:${DEMO_GATEWAY_PORTS[k]}`]));

/** 데모 이미지 이름(기존 셋은 재사용, 새 열은 demo-images.mjs가 만든다) */
export const DEMO_IMAGES = Object.freeze({
  'identity-svc': 'peaket/identity-svc:demo',
  'ticket-svc': 'peaket/ticket-svc:demo',
  'trust-svc': 'peaket/trust-svc:demo',
  'core-svc': 'peaket/core-svc:demo',
  'realtime-gw': 'peaket/realtime-gw:demo',
  bundle: 'peaket/bundle:demo',
  'ops-svc': 'peaket/ops-svc:demo',
  'pg-simulator': 'peaket/pg-simulator:demo',
  web: 'peaket/web:demo',
  partner: 'peaket/partner:demo',
  'console-host': 'peaket/console-host:demo',
  scanner: 'peaket/scanner:demo',
  'queue-room': 'peaket/queue-room:demo',
});

/**
 * 데모 워크로드와 기대 복제 수. demo-status가 readyReplicas를 이 표와 견준다.
 * bundle은 queue·admission·purchase·payment를 한 파드로 덮는다(감독 결정 2). 운영 모양(서비스별 1복제)과 다르다.
 */
export const DEMO_WORKLOADS = Object.freeze([
  { name: 'identity-svc', namespace: 'core', port: 8080, extraPorts: [{ name: 'grpc', port: 50051 }], replicas: 1 },
  { name: 'core-svc', namespace: 'core', port: 8080, replicas: 1 },
  { name: 'ops-svc', namespace: 'core', port: 8080, replicas: 1, reused: true },
  { name: 'ticket-svc', namespace: 'ticket', port: 8080, extraPorts: [{ name: 'grpc', port: 50051 }], replicas: 1 },
  { name: 'trust-svc', namespace: 'trust', port: 8080, extraPorts: [{ name: 'grpc', port: 50051 }], replicas: 1 },
  // purchase-grpc는 회차 취소 환불·판정 미리보기(ops-svc → purchase-svc gRPC)를 위한 포트다. payment·queue와 겹치지 않게 50053
  { name: 'bundle', namespace: 'purchase', port: 8080, extraPorts: [{ name: 'purchase', port: 8081 }, { name: 'admission', port: 8082 }, { name: 'payment', port: 8084 }, { name: 'purchase-grpc', port: 50053 }], replicas: 1, reused: true },
  { name: 'pg-simulator', namespace: 'purchase', port: 8790, replicas: 1, reused: true },
  { name: 'realtime-gw', namespace: 'purchase', port: 8080, replicas: 1 },
  { name: 'web', namespace: 'web', port: 3000, replicas: 1 },
  { name: 'partner', namespace: 'web', port: 3001, replicas: 1 },
  { name: 'console-host', namespace: 'web', port: 8080, replicas: 1 },
  { name: 'scanner', namespace: 'web', port: 8080, replicas: 1 },
  { name: 'queue-room', namespace: 'web', port: 8080, replicas: 1 },
]);

/** 데모가 만드는 논리 DB 여섯(한 PostgreSQL) */
export const DEMO_DATABASES = Object.freeze({ identity: 'peaket_demo_identity', core: 'peaket_demo_core', ticket: 'peaket_demo_ticket', ops: 'peaket_demo_ops', purchase: 'peaket_demo_purchase', payment: 'peaket_demo_payment' });
/** 데모 DB 로그인 사용자(비밀번호는 무대마다 새로 만든 keys.dbPassword 하나) */
export const DEMO_DB_USERS = Object.freeze({
  identity: 'identity_app',
  ticket: 'ticket_app',
  ops: 'ops_app_login',
  opsPartner: 'ops_partner_login',
  purchase: 'purchase_app',
  payment: 'payment_app',
  core: ['core_app_login', 'core_partner_login', 'core_ops_login', 'core_search_login'],
});

/** 데모 네임스페이스 객체 */
export function demoNamespaces() {
  return DEMO_NAMESPACES.map((name) => ({ apiVersion: 'v1', kind: 'Namespace', metadata: { name, labels: { 'app.kubernetes.io/part-of': 'peaket-demo' } } }));
}

const labels = (name) => ({ 'app.kubernetes.io/name': name, 'app.kubernetes.io/part-of': 'peaket-demo' });
const secret = (name, namespace, stringData) => ({ apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace }, type: 'Opaque', stringData });

/** 서비스 하나의 클러스터 안 주소(네임스페이스·이름은 DEMO_WORKLOADS) */
export function demoServiceUrl(workload, port, namespace = DEMO_WORKLOADS.find((w) => w.name === workload)?.namespace) {
  if (!namespace) throw new Error(`모르는 워크로드: ${workload}`);
  return `http://${workload}.${namespace}.svc.cluster.local:${port}`;
}

/** DB 주소(로그인 사용자·DB마다). 비밀번호가 16자 이상 base64url이 아니면 던진다 */
export function demoDatabaseUrls(password) {
  if (typeof password !== 'string' || !/^[A-Za-z0-9_-]{16,}$/.test(password)) throw new RangeError('DB 비밀번호는 16자 이상의 base64url이다');
  const base = `postgres://`;
  const host = 'demo-postgres.purchase.svc.cluster.local:5432';
  const url = (user, db) => `${base}${user}:${password}@${host}/${db}`;
  return {
    identity: url(DEMO_DB_USERS.identity, DEMO_DATABASES.identity),
    ticket: url(DEMO_DB_USERS.ticket, DEMO_DATABASES.ticket),
    ops: url(DEMO_DB_USERS.ops, DEMO_DATABASES.ops),
    opsPartner: url(DEMO_DB_USERS.opsPartner, DEMO_DATABASES.ops),
    purchase: url(DEMO_DB_USERS.purchase, DEMO_DATABASES.purchase),
    payment: url(DEMO_DB_USERS.payment, DEMO_DATABASES.payment),
    core: url(DEMO_DB_USERS.core[0], DEMO_DATABASES.core),
    corePartner: url(DEMO_DB_USERS.core[1], DEMO_DATABASES.core),
    coreOps: url(DEMO_DB_USERS.core[2], DEMO_DATABASES.core),
    coreSearch: url(DEMO_DB_USERS.core[3], DEMO_DATABASES.core),
  };
}

/** PostgreSQL 하나(데모 DB 셋). 임시 저장소(emptyDir)라 다시 올리면 새 비밀번호로 처음부터 만든다 */
export function demoPostgresObjects() {
  const name = 'demo-postgres';
  const l = labels(name);
  return [
    { apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: 'purchase', labels: l }, spec: { selector: l, ports: [{ name: 'pg', port: 5432, targetPort: 5432 }] } },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace: 'purchase', labels: l },
      spec: {
        replicas: 1,
        strategy: { type: 'Recreate' },
        selector: { matchLabels: l },
        template: {
          metadata: { labels: l },
          spec: {
            automountServiceAccountToken: false,
            securityContext: { runAsNonRoot: true, runAsUser: 70, runAsGroup: 70, fsGroup: 70, seccompProfile: { type: 'RuntimeDefault' } },
            containers: [
              {
                name: 'postgres',
                image: V1_POSTGRES_TAG,
                imagePullPolicy: 'IfNotPresent',
                args: ['-c', 'max_connections=300'],
                envFrom: [{ secretRef: { name: 'demo-postgres' } }],
                ports: [{ name: 'pg', containerPort: 5432 }],
                readinessProbe: { exec: { command: ['pg_isready', '-U', 'postgres'] }, periodSeconds: 2 },
                resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { memory: '1Gi' } },
                securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } },
                volumeMounts: [
                  { name: 'data', mountPath: '/var/lib/postgresql' },
                  { name: 'run', mountPath: '/var/run/postgresql' },
                  { name: 'tmp', mountPath: '/tmp' },
                ],
              },
            ],
            volumes: [{ name: 'data', emptyDir: {} }, { name: 'run', emptyDir: {} }, { name: 'tmp', emptyDir: {} }],
          },
        },
      },
    },
  ];
}

/** Valkey 하나(대기열·좌석·세션·샵). 로컬 데모는 TLS를 끈다(운영은 TLS·클러스터) */
export function demoValkeyObjects() {
  const name = 'demo-valkey';
  const l = labels(name);
  return [
    { apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: 'purchase', labels: l }, spec: { selector: l, ports: [{ name: 'redis', port: 6379, targetPort: 6379 }] } },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace: 'purchase', labels: l },
      spec: {
        replicas: 1,
        selector: { matchLabels: l },
        template: {
          metadata: { labels: l },
          spec: {
            automountServiceAccountToken: false,
            securityContext: { runAsNonRoot: true, runAsUser: 999, runAsGroup: 999, seccompProfile: { type: 'RuntimeDefault' } },
            containers: [
              {
                name: 'valkey',
                image: V1_VALKEY_TAG,
                imagePullPolicy: 'IfNotPresent',
                args: ['valkey-server', '--save', '', '--appendonly', 'no', '--protected-mode', 'no'],
                ports: [{ name: 'redis', containerPort: 6379 }],
                readinessProbe: { tcpSocket: { port: 6379 }, periodSeconds: 2 },
                resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { memory: '256Mi' } },
                securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } },
                volumeMounts: [{ name: 'data', mountPath: '/data' }],
              },
            ],
            volumes: [{ name: 'data', emptyDir: {} }],
          },
        },
      },
    },
  ];
}

/** 데모의 Kafka 토픽(v1 무대와 같은 목록). 로컬 Kafka는 자동 생성을 끄므로 미리 만든다 */
export function demoTopics() {
  return [...V1_KAFKA_TOPICS];
}

/**
 * bundle 한 파드가 덮는 서비스의 Service 별칭(데모 전용). 게이트웨이 HTTPRoute는 이름을 그대로 두고
 * 네임스페이스만 purchase로 바꾸므로, 같은 이름·포트(8080)의 Service가 bundle 파드를 가리켜야 한다.
 * targetPort는 합본 안 각 서비스의 앱 포트다(V1_PORTS: queue 8080·purchase 8081·admission 8082·payment 8084).
 */
export function bundleServiceAliases() {
  return [
    ['queue-svc', 'queue'],
    ['purchase-svc', 'purchase'],
    ['payment-svc', 'payment'],
    ['admission-ctrl', 'admission'],
  ].map(([name, key]) => ({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace: 'purchase', labels: { 'app.kubernetes.io/name': name, 'app.kubernetes.io/part-of': 'peaket-demo' } },
    spec: { selector: { 'app.kubernetes.io/name': 'bundle' }, ports: [{ name: 'http', port: 8080, targetPort: V1_PORTS[key === 'admission' ? 'admission-ctrl' : `${key}-svc`].app }] },
  }));
}

/** 데모 무대의 클러스터 안 주소 묶음(env 파일·Secret이 쓴다) */
export function demoLayout() {
  return {
    postgresHost: 'demo-postgres.purchase.svc.cluster.local:5432',
    redisUrl: 'redis://demo-valkey.purchase.svc.cluster.local:6379',
    kafkaBrokers: 'peaket-kafka-bootstrap.kafka.svc.cluster.local:9092',
    pgSimUrl: 'http://pg-simulator.purchase.svc.cluster.local:8790',
    identityHttp: demoServiceUrl('identity-svc', 8080),
    identityGrpc: 'identity-svc.core.svc.cluster.local:50051',
    coreHttp: demoServiceUrl('core-svc', 8080),
    ticketGrpc: 'ticket-svc.ticket.svc.cluster.local:50051',
    trustGrpc: 'trust-svc.trust.svc.cluster.local:50051',
    purchaseGrpc: 'bundle.purchase.svc.cluster.local:50053',
    bundleServiceUrls: {
      'queue-svc': demoServiceUrl('bundle', V1_PORTS['queue-svc'].app),
      'purchase-svc': demoServiceUrl('bundle', V1_PORTS['purchase-svc'].app),
      'admission-ctrl': demoServiceUrl('bundle', V1_PORTS['admission-ctrl'].app),
      'payment-svc': demoServiceUrl('bundle', V1_PORTS['payment-svc'].app),
    },
  };
}

/**
 * 데모 Secret들. keys는 cluster.mjs가 이 PC에서 새로 만든 시험 값이고 여기서 만들지 않는다.
 * - demo-postgres: PostgreSQL 비밀번호
 * - demo-identity·demo-core·demo-ticket·demo-trust·demo-realtime: 서비스 환경 값(DB 주소·Redis·토큰 키·TOTP/페퍼 키)
 * - demo-bundle-env: 합본의 서비스별 환경 파일 넷(`<서비스>.env`)
 * - demo-pg-simulator·demo-idv: 결제 시뮬레이터·모의 기관 시험 키
 * - demo-bootstrap: 첫 관리자·패스키·promoter 부트스트랩 값(감사 기록 없음, 로컬 데모 전용)
 * - demo-bootstrap-core: 첫 promoter 부트스트랩 Job 전용 슈퍼유저 DSN(실행 파드는 받지 않는다)
 * - demo-web·demo-partner: Next 서버 액션 암호화 키(keys.serverActionsKey, 두 앱이 같은 값)
 * @param {{ keys: { dbPassword: string, idvSecret: string, pgSim: { secretKey: string, clientKey: string }, tokenKeys: Record<string, { privateJwk: unknown }>, pepperKey: string, totpKey: string, internalToken: string, serverActionsKey?: string, queueTokenKey?: string, admission?: any, ecdh?: any, batchRandomness?: string }, bootstrap: unknown }} o
 */
export function demoSecrets(o) {
  const k = o.keys;
  const urls = demoDatabaseUrls(k.dbPassword);
  const L = demoLayout();
  const token = (name) => JSON.stringify(k.tokenKeys[name].privateJwk);
  const admissionKeys = k.admission ?? { privateJwk: (k.tokenKeys.admission ?? k.tokenKeys.fan).privateJwk, jwks: { keys: [] } };
  const ecdh = k.ecdh ?? { privateJwk: (k.tokenKeys.ecdh ?? k.tokenKeys.fan).privateJwk, publicJwk: (k.tokenKeys.ecdh ?? k.tokenKeys.fan).privateJwk };
  const bundleKeys = {
    admission: { privateJwk: admissionKeys.privateJwk, jwks: admissionKeys.jwks ?? { keys: [] } },
    ecdh,
    batchRandomness: k.batchRandomness ?? 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    pgSim: k.pgSim,
    queueTokenKey: k.queueTokenKey ?? `demoq:${k.dbPassword}`,
  };
  const files = v1EnvFiles({
    keys: bundleKeys,
    queueRedisUrl: L.redisUrl,
    seatRedisUrl: L.redisUrl,
    purchaseDatabaseUrl: urls.purchase,
    paymentDatabaseUrl: urls.payment,
    seatmapDir: '/etc/peaket/seatmaps',
    batchResultDir: '/var/peaket/batch-results',
    pgSimUrl: L.pgSimUrl,
    kafkaBrokers: L.kafkaBrokers,
    paymentPodCount: 1,
  });
  // 결제창 복귀(payment-svc)와 대기열 파일 CORS(queue-svc)가 브라우저 Origin(포트 포함)을 쓰게 한다(RV-02).
  // 포트 없는 기본값(https://www.peaket.example)·http://localhost:3000은 브라우저 출처와 달라 막힌다
  const webOrigin = demoOrigins().www;
  files['queue-svc'].PEAKET_WEB_ORIGIN = webOrigin;
  files['payment-svc'].PEAKET_WEB_ORIGIN = webOrigin;
  // 팬 취소의 재인증 확인기(purchase-svc)가 identity 팬 공개키를 읽게 한다. 없으면 local·ci는 닫힌 대역(늘 403)이라
  // BAT-086의 S5(팬 재인증 → 티켓 취소)가 끝나지 않는다. 발급자는 identity-svc의 PEAKET_TOKEN_ISSUER와 같다
  files['purchase-svc'].PEAKET_IDENTITY_FAN_JWKS_URL = 'http://identity-svc.core.svc.cluster.local:8080/internal/jwks/fan.json';
  files['purchase-svc'].PEAKET_IDENTITY_ISSUER = 'https://identity.peaket.example';
  // 회차 취소 환불 gRPC(ops-svc가 부른다). payment-svc(50051)·queue-svc(50052)와 겹치지 않게 50053을 쓴다
  files['purchase-svc'].PEAKET_GRPC_PORT = '50053';
  // 발권·본인확인 재확인은 같은 무대의 ticket-svc·identity-svc gRPC를 쓴다. 없으면 purchase-svc가 '늘 발권' 대역을 써
  // ticket 원장에 티켓이 생기지 않아 S5·S8·S9가 빈 껍데기가 된다
  files['purchase-svc'].PEAKET_TICKET_GRPC_ADDR = 'ticket-svc.ticket.svc.cluster.local:50051';
  files['purchase-svc'].PEAKET_IDENTITY_GRPC_ADDR = 'identity-svc.core.svc.cluster.local:50051';
  // 합본의 purchase-relay 자식(회차 취소 환불 반복)이 쓰는 값. 릴레이는 아웃박스·정비 DB를 따로 받고,
  // 결제 HTTP는 같은 파드의 payment-svc(8084)를 본다. 없으면 relay-app이 시작하지 않는다
  files['purchase-svc'].PEAKET_OUTBOX_DATABASE_URL = urls.purchase;
  files['purchase-svc'].PEAKET_MAINTENANCE_DATABASE_URL = urls.purchase;
  files['purchase-svc'].PEAKET_PAYMENT_HTTP_URL = 'http://127.0.0.1:8084';
  // 좌석맵 판 파일은 데모 재생기가 회차마다 /tmp/seatmaps/{eventId}.json으로 쓴다(읽기 전용 마운트를 피한다).
  // 시드가 좌석맵을 만든 뒤 재생기가 파일을 쓰지 않으면 purchase-svc 홀드가 503 seat-store-unavailable이다
  files['purchase-svc'].PEAKET_SEATMAP_DIR = '/tmp/seatmaps';
  // gw-fan-buy의 Lua admissionIssuer는 데모에서 포트 붙은 queue 출처로 바뀐다(demo-objects의 출처 바꾸기).
  // 발급자도 같은 값으로 맞춘다. v1 기본값(https://queue.v1.peaket.local)과 다르면 게이트웨이가 입장 토큰을 401로 막는다
  const queueOrigin = demoOrigins().queue;
  files['queue-svc'].PEAKET_ADMISSION_TOKEN_ISSUER = queueOrigin;
  files['purchase-svc'].PEAKET_ADMISSION_ISSUER = queueOrigin;
  return [
    secret('demo-postgres', 'purchase', { POSTGRES_PASSWORD: k.dbPassword }),
    secret('demo-identity', 'core', {
      PEAKET_DATABASE_URL: urls.identity,
      PEAKET_IDENTITY_REDIS_URL: L.redisUrl,
      PEAKET_FAN_TOKEN_KEY: token('fan'),
      ...(k.tokenKeys.admin ? { PEAKET_ADMIN_TOKEN_KEY: token('admin') } : {}),
      ...(k.tokenKeys.staff ? { PEAKET_STAFF_TOKEN_KEY: token('staff') } : {}),
      PEAKET_ADMIN_PEPPER_KEY: k.pepperKey,
      PEAKET_ADMIN_TOTP_KEY: k.totpKey,
      PEAKET_INTERNAL_GRPC_TOKEN: k.internalToken,
      PEAKET_INTERNAL_TOKEN: k.internalToken,
      PEAKET_TEST_VERIFICATION_SECRET: k.idvSecret,
      // 연계정보·pid HMAC 키(local 전용 설정값 키, 운영은 KMS)
      PEAKET_PID_HMAC_KEY: k.pidHmacKey,
      PEAKET_CI_HMAC_KEY: k.ciHmacKey,
    }),
    secret('demo-core', 'core', {
      PEAKET_DATABASE_URL: urls.core,
      PEAKET_PARTNER_DATABASE_URL: urls.corePartner,
      PEAKET_OPS_DATABASE_URL: urls.coreOps,
      PEAKET_SEARCH_DATABASE_URL: urls.coreSearch,
      PEAKET_INTERNAL_TOKEN: k.internalToken,
      // 서비스 사이 gRPC 공유 토큰(identity AdminAuthzService가 요구한다)
      PEAKET_INTERNAL_GRPC_TOKEN: k.internalToken,
    }),
    // 첫 promoter 부트스트랩 Job만 슈퍼유저 주소를 받는다(core-svc 실행 파드는 demo-core의 역할 주소만 받는다, RV-03)
    secret('demo-bootstrap-core', 'core', {
      PEAKET_BOOTSTRAP_DATABASE_URL: `postgres://postgres:${k.dbPassword}@${L.postgresHost}/${DEMO_DATABASES.core}`,
    }),
    secret('demo-ops', 'core', {
      PEAKET_DATABASE_URL: urls.ops,
      // 파트너 회차 취소 경로는 ops_partner 역할 사용자로 따로 접속한다(ops_app을 겸하지 않는다, 행 보안 2차 방어)
      PEAKET_PARTNER_DATABASE_URL: urls.opsPartner,
      PEAKET_INTERNAL_TOKEN: k.internalToken,
      PEAKET_INTERNAL_GRPC_TOKEN: k.internalToken,
    }),
    // Next 서버 액션 암호화 키. 무대마다 데모 비밀 파일에서 만든 값을 web·partner가 같은 값으로 Secret으로만 받는다
    // (이미지·오버레이 값 파일에는 굽지 않는다. 실행 때 받은 키가 빌드가 만든 키를 이긴다, docs/infra.md '로컬 데모의 비밀')
    secret('demo-web', 'web', { NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: k.serverActionsKey }),
    secret('demo-partner', 'web', { NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: k.serverActionsKey }),
    secret('demo-ticket', 'ticket', { PEAKET_DATABASE_URL: urls.ticket, PEAKET_TICKET_REDIS_URL: L.redisUrl, PEAKET_INTERNAL_GRPC_TOKEN: k.internalToken, PEAKET_INTERNAL_TOKEN: k.internalToken }),
    secret('demo-trust', 'trust', { PEAKET_TRUST_REDIS_URL: L.redisUrl, PEAKET_INTERNAL_GRPC_TOKEN: k.internalToken }),
    secret('demo-bundle-env', 'purchase', Object.fromEntries(Object.entries(files).map(([svc, values]) => [`${svc}.env`, `${Object.entries({ ...values, PEAKET_INTERNAL_GRPC_TOKEN: k.internalToken }).sort(([a], [b]) => a.localeCompare(b)).map(([n, v]) => `${n}=${v}`).join('\n')}\n`]))),
    secret('demo-pg-simulator', 'purchase', { PG_SIMULATOR_SECRET_KEY: k.pgSim.secretKey }),
    secret('demo-realtime', 'purchase', { PEAKET_SEAT_REDIS_URL: L.redisUrl, PEAKET_ADMISSION_JWKS: JSON.stringify(admissionKeys.jwks ?? { keys: [] }), PEAKET_INTERNAL_GRPC_TOKEN: k.internalToken }),
    secret('demo-idv', 'core', { PEAKET_TEST_VERIFICATION_SECRET: k.idvSecret }),
    secret('demo-bootstrap', 'core', { 'bootstrap.json': JSON.stringify(o.bootstrap) }),
  ];
}

/** 모의 본인확인기관(identity 이미지 + 스크립트). 파드 18920·NodePort 30189·이 PC 18920 */
export function demoAppObjects() {
  const name = 'mock-idv';
  const l = labels(name);
  return [
    // bundle 한 파드가 덮는 네 서비스를 게이트웨이 HTTPRoute가 쓰는 이름(purchase-svc·payment-svc·queue-svc)으로도 연다.
    // HTTPRoute backendRef는 이름을 그대로 두고 네임스페이스만 purchase로 바꾸므로(계획 B7), 같은 이름의 Service가 필요하다
    ...bundleServiceAliases(),
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'demo-trust-rules', namespace: 'trust', labels: labels('trust-rules') }, data: { 'rules.json': JSON.stringify(DEMO_TRUST_RULES) } },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace: 'core', labels: l },
      spec: {
        replicas: 1,
        selector: { matchLabels: l },
        template: {
          metadata: { labels: l },
          spec: {
            automountServiceAccountToken: false,
            securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
            containers: [
              {
                name: 'mock-idv',
                image: DEMO_IMAGES['identity-svc'],
                imagePullPolicy: 'Never',
                command: ['node', 'scripts/mock-idv.mjs', '18920'],
                env: [
                  { name: 'PEAKET_ENV', value: DEMO_ENV },
                  { name: 'PEAKET_MOCK_IDV_HOST', value: '0.0.0.0' },
                  { name: 'PEAKET_TEST_VERIFICATION_RETURN_URL', value: `${demoOrigins().www}/verify/return` },
                ],
                envFrom: [{ secretRef: { name: 'demo-idv' } }],
                ports: [{ name: 'http', containerPort: 18920 }],
                readinessProbe: { tcpSocket: { port: 18920 }, periodSeconds: 2 },
                resources: { requests: { cpu: '20m', memory: '32Mi' }, limits: { memory: '64Mi' } },
                securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } },
              },
            ],
          },
        },
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name, namespace: 'core', labels: l },
      spec: { type: 'NodePort', selector: l, ports: [{ name: 'http', port: 18920, targetPort: 18920, nodePort: DEMO_PORTS.idvNodePort }] },
    },
    // core-svc의 좌석맵 가져오기(SeatmapImportService) 대역. DB·Kafka 자격 증명을 받지 않는 별도 프로세스다
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'core-seatmap-worker', namespace: 'core', labels: labels('core-seatmap-worker') },
      spec: {
        replicas: 1,
        selector: { matchLabels: labels('core-seatmap-worker') },
        template: {
          metadata: { labels: labels('core-seatmap-worker') },
          spec: {
            automountServiceAccountToken: false,
            securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
            containers: [
              {
                name: 'seatmap-worker',
                image: DEMO_IMAGES['core-svc'],
                imagePullPolicy: 'Never',
                command: ['node', 'dist/seatmap-worker/main.js'],
                env: [
                  { name: 'PEAKET_ENV', value: DEMO_ENV },
                  { name: 'PEAKET_GRPC_PORT', value: '50051' },
                ],
                ports: [{ name: 'grpc', containerPort: 50051 }],
                readinessProbe: { tcpSocket: { port: 50051 }, periodSeconds: 2 },
                resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { memory: '512Mi' } },
                securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } },
              },
            ],
          },
        },
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'core-seatmap-worker', namespace: 'core', labels: labels('core-seatmap-worker') },
      spec: { selector: labels('core-seatmap-worker'), ports: [{ name: 'grpc', port: 50051, targetPort: 50051 }] },
    },
  ];
}

/** identity gRPC를 이 PC 19051로 잇는 NodePort Service(파드 50051) */
export function demoGrpcNodePortService() {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: 'identity-grpc-local', namespace: 'core', labels: labels('identity-grpc-local') },
    spec: { type: 'NodePort', selector: { 'app.kubernetes.io/name': 'identity-svc' }, ports: [{ name: 'grpc', port: 50051, targetPort: 'grpc', nodePort: DEMO_PORTS.grpcNodePort }] },
  };
}

/** 비공개 판정 규칙(합성, 데모 전용). 운영 규칙이 아니다(services/trust-svc/test/support.ts와 같은 꼴) */
export const DEMO_TRUST_RULES = Object.freeze({
  version: 7,
  intensities: {
    RELAXED: { ON: { threshold: 2, weights: profile() }, OFF: { threshold: 2, weights: profile() }, NONE: { threshold: 2, weights: profile() } },
    BASE: { ON: { threshold: 1, weights: profile() }, OFF: { threshold: 1, weights: profile() }, NONE: { threshold: 1, weights: profile() } },
    STRICT: { ON: { threshold: 0.5, weights: profile() }, OFF: { threshold: 0.5, weights: profile() }, NONE: { threshold: 0.5, weights: profile() } },
  },
  params: {
    device: { accountsFrom: 1, accountsAt: 3, sharedFrom: 1, sharedAt: 3, failuresFrom: 0, failuresAt: 2, newDevicesPerDay: 2 },
    behavior: { entropyLow: 0.1, entropyHigh: 1, intervalStdLow: 10, intervalStdHigh: 100, minPointerMoves: 5, minWindowMs: 1000 },
    network: { hosting: 1, proxy: 0.8, entriesFrom: 1, entriesAt: 3 },
    age: { cookieYoungMs: 1000, cookieOldMs: 2000, sessionYoungMs: 1000, sessionOldMs: 2000 },
    consistency: { mismatch: 1 },
  },
});

/** 점수기 여섯의 가중치(모두 1). 위에서 함께 쓴다 */
function profile() {
  return { HumanCheck: 1, DeviceTrust: 1, BehaviorScore: 1, NetworkScore: 1, AgeScore: 1, ConsistencyScore: 1 };
}

const BUNDLE_SERVICES = new Set(['queue-svc', 'purchase-svc', 'payment-svc', 'admission-ctrl']);

/** 객체 트리의 문자열을 포트 붙은 출처로 바꾼다(출처·corsOrigin·allowOrigins가 모두 같은 값을 쓴다) */
function rewriteOrigins(value) {
  if (typeof value === 'string') return BASE_ORIGINS[value] ?? value;
  if (Array.isArray(value)) return value.map(rewriteOrigins);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteOrigins(v)]));
  return value;
}

/**
 * 데모 게이트웨이 객체: deploy/gateways의 실제 정의를 그대로 쓰되 다음만 바꾼다.
 * ① 모든 출처 문자열을 포트 붙은 값으로(브라우저 Origin은 포트를 포함한다)
 * ② bundle이 덮는 네 서비스의 backendRef 네임스페이스를 purchase로(한 파드 재사용. 운영 모양과 다름)
 * ③ 앱 리스너 둘(console·scanner)과 그 라우트, 대기실 라우트 셋
 * ④ trust 네임스페이스 ReferenceGrant(게이트웨이가 gRPC 백엔드를 가리키지 않아도, 정리·확인용으로 여섯을 맞춘다)
 * 대역 백엔드(gateway-echo)와 localGatewayObjects는 쓰지 않는다(DS-03).
 * @param {Array<Record<string, any>>} objects deploy/gateways의 객체
 * @param {Record<string, string>} [origins] demoOrigins() 결과
 */
export function demoGatewayObjects(objects, origins = demoOrigins()) {
  const copy = rewriteOrigins(JSON.parse(JSON.stringify(objects)));
  const out = [];
  for (const o of copy) {
    // 로컬 데모에는 OTel 수집기가 없다(추적을 끈다). otel 네임스페이스의 ReferenceGrant는 대상이 없어 싣지 않는다
    if (o.metadata?.namespace === 'otel') continue;
    if (o.kind === 'HTTPRoute') {
      for (const rule of o.spec?.rules ?? []) {
        for (const ref of rule.backendRefs ?? []) if (BUNDLE_SERVICES.has(ref.name)) ref.namespace = 'purchase';
      }
    }
    if (o.kind === 'Gateway') {
      const listeners = o.spec?.listeners ?? [];
      if (o.metadata.name === 'gw-ops' && !listeners.some((l) => l.name === 'console')) {
        listeners.push({ name: 'console', hostname: DEMO_HOSTS.console, port: 443, protocol: 'HTTPS', tls: { mode: 'Terminate', certificateRefs: [{ kind: 'Secret', name: 'gw-ops-console-tls' }] }, allowedRoutes: { namespaces: { from: 'Same' } } });
      }
      if (o.metadata.name === 'gw-scanner' && !listeners.some((l) => l.name === 'scanner')) {
        listeners.push({ name: 'scanner', hostname: DEMO_HOSTS.scanner, port: 443, protocol: 'HTTPS', tls: { mode: 'Terminate', certificateRefs: [{ kind: 'Secret', name: 'gw-scanner-scanner-tls' }] }, allowedRoutes: { namespaces: { from: 'Same' } } });
      }
    }
    if (o.kind === 'EnvoyProxy') {
      // 로컬 kind: 프록시 Service는 ClusterIP(이 PC로는 게이트웨이마다 만드는 NodePort Service와 포트 매핑이 잇는다),
      // 이미지는 미리 실은 태그, envoy CPU 요청은 100m(다섯 파드가 CI vCPU 4에 들어가게, BAT-055와 같은 이유)
      const k = (o.spec.provider ??= { type: 'Kubernetes' }).kubernetes ??= {};
      k.envoyService = { ...(k.envoyService ?? {}), type: 'ClusterIP' };
      const container = ((k.envoyDeployment ??= {}).container ??= {});
      container.image = GATEWAY_PROXY_IMAGE;
      const req = container.resources?.requests;
      if (req && req.cpu !== undefined) req.cpu = LOCAL_PROXY_CPU_REQUEST;
      // otel-gateway-collector는 로컬 데모에 없다. 추적을 끄지 않으면 프록시 설정이 Programmed되지 않는다
      if (o.spec.telemetry) delete o.spec.telemetry.tracing;
    }
    out.push(o);
  }
  const hasGrant = out.some((o) => o.kind === 'ReferenceGrant' && o.metadata?.namespace === 'trust');
  if (!hasGrant) out.push(referenceGrant('trust'));
  out.push(appRoute('demo-console', 'gw-ops', 'console', DEMO_HOSTS.console, 'console-host', 8080, [{ type: 'PathPrefix', value: '/' }]));
  // 정적 콘솔 문서는 브라우저가 원본 확인 머리를 보낼 수 없다. gw-ops 게이트웨이의 requireOriginVerify·허용 IP를
  // 이 라우트에서만 끈다(라우트 정책이 게이트웨이 정책을 덮는다). 운영·클라우드에는 없다
  out.push(demoConsoleEdge());
  out.push(appRoute('demo-scanner', 'gw-scanner', 'scanner', DEMO_HOSTS.scanner, 'scanner', 8080, [{ type: 'PathPrefix', value: '/' }]));
  out.push(
    appRoute('demo-queue-room', 'gw-queue', 'queue', DEMO_HOSTS.queue, 'queue-room', 8080, [
      // 정적 자산은 정규식으로 잡는다. PathPrefix /_q/는 같은 게이트웨이의 not-found 정규식(/.*)보다
      // Envoy 라우트 차례에서 밀려 404가 났다(데모 확인). 더 구체적인 정규식은 그 앞에 놓인다
      { type: 'RegularExpression', value: '^/_q/.*' },
      { type: 'RegularExpression', value: '^/queue/[^/]+/?$' },
      { type: 'RegularExpression', value: '^/(en|ja|zh)/queue/[^/]+/?$' },
      { type: 'RegularExpression', value: '^/shop/[^/]+/queue$' },
    ]),
  );
  // 추가 검증(/queue/{id}/verify)은 소비자 웹 화면이다. 대기실 정규식에 들지 않게 따로 웹 앱 서버로 보낸다
  out.push(appRoute('demo-queue-verify', 'gw-queue', 'queue', DEMO_HOSTS.queue, 'web', 3000, [{ type: 'RegularExpression', value: '^/(?:en|ja|zh)/queue/[^/]+/verify/?$|^/queue/[^/]+/verify/?$' }]));
  // 데모에서만 필요한 출처는 공용 deploy/gateways에 두지 않고 여기서 더한다(리뷰 RV-01). gw-fan 정책만 넓힌다
  return demoOriginSecurityPatch(out, origins);
}

/** 게이트웨이 다섯이 가리킬 수 있게 trust 네임스페이스 Service를 허락한다 */
function referenceGrant(namespace) {
  return {
    apiVersion: 'gateway.networking.k8s.io/v1beta1',
    kind: 'ReferenceGrant',
    metadata: { name: 'peaket-gateways', namespace },
    spec: {
      from: [
        { group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', namespace: 'envoy-gateway-system' },
        { group: 'gateway.envoyproxy.io', kind: 'SecurityPolicy', namespace: 'envoy-gateway-system' },
        { group: 'gateway.envoyproxy.io', kind: 'EnvoyProxy', namespace: 'envoy-gateway-system' },
      ],
      to: [{ group: '', kind: 'Service' }],
    },
  };
}

/**
 * 로컬 데모 콘솔 문서 라우트의 원본 확인·허용 IP 예외. gw-ops 게이트웨이 정책은 `requireOriginVerify: true`라
 * 브라우저가 콘솔 문서를 열 때 403이 난다(2026-11-21 리뷰 반영에서 확인). 화면은 정적 콘솔 호스트라 예외로 두고,
 * API 라우트(gw-ops-api·gw-ops-public)의 정책은 그대로 둔다. 운영·클라우드에는 이 객체가 없다.
 */
function demoConsoleEdge() {
  return {
    apiVersion: 'gateway.envoyproxy.io/v1alpha1',
    kind: 'EnvoyExtensionPolicy',
    metadata: { name: 'demo-console-edge', namespace: 'envoy-gateway-system', labels: { 'app.kubernetes.io/part-of': 'peaket-demo' } },
    spec: {
      targetRefs: [{ group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: 'demo-console' }],
      lua: [
        {
          type: 'ValueRef',
          valueRef: { group: '', kind: 'ConfigMap', name: 'peaket-gateway-edge-lua' },
          filterContext: { originVerify: true, requireOriginVerify: false, checkTyp: false, tokenCookie: '__Host-peaket_ops_at', tokenScheme: 'Bearer' },
        },
      ],
    },
  };
}

/** 앱 호스트 하나의 HTTPRoute(web 네임스페이스의 앱 Service로) */
function appRoute(name, gateway, section, hostname, service, port, matches) {  return {
    apiVersion: 'gateway.networking.k8s.io/v1',
    kind: 'HTTPRoute',
    metadata: { name, namespace: 'envoy-gateway-system', labels: { 'app.kubernetes.io/part-of': 'peaket-demo' } },
    spec: {
      parentRefs: [{ name: gateway, sectionName: section }],
      hostnames: [hostname],
      rules: [{ matches: matches.map((m) => ({ path: { type: m.type, value: m.value } })), backendRefs: [{ group: '', kind: 'Service', name: service, namespace: 'web', port }] }],
    },
  };
}

/** 호스트 키 → 정본 호스트 이름(포트 없음). 게이트웨이 리스너 이름이 키다 */
export function demoHosts() {
  return { ...DEMO_HOSTS };
}

/** 데모 워크로드의 기대 준비 상태(이름·네임스페이스·복제 수). demo-status가 이 표를 읽는다 */
export function demoExpectedWorkloads() {
  return [
    ...DEMO_WORKLOADS.map(({ name, namespace, replicas }) => ({ name, namespace, expected: replicas })),
    // 차트 밖에서 raw 객체로 띄우는 둘(모의 기관·좌석맵 작업자)
    { name: 'mock-idv', namespace: 'core', expected: 1 },
    { name: 'core-seatmap-worker', namespace: 'core', expected: 1 },
  ];
}

/**
 * 데모 DB 초기화 SQL(PostgreSQL 슈퍼유저로 한 번). PostgreSQL 자체는 demoPostgresObjects가 만들고,
 * 이 SQL은 논리 DB 셋·로그인 사용자·core 그룹 역할 부여를 만든다. core 그룹 역할은 마이그레이션이 만든 뒤 `demoCoreRolesSql`로 붙인다.
 * @param {string} password
 */
export function demoDatabaseInitSql(password) {
  const p = String(password).replaceAll("'", "''");
  return [
    `CREATE USER ${DEMO_DB_USERS.identity} PASSWORD '${p}';`,
    `CREATE DATABASE ${DEMO_DATABASES.identity} OWNER ${DEMO_DB_USERS.identity};`,
    `CREATE USER ${DEMO_DB_USERS.ticket} PASSWORD '${p}';`,
    `CREATE DATABASE ${DEMO_DATABASES.ticket} OWNER ${DEMO_DB_USERS.ticket};`,
    // ops 로그인 사용자 둘: 관제(ops_app)와 파트너 회차 취소(ops_partner). 그룹 역할 둘은 마이그레이션이 만든다
    `CREATE USER ${DEMO_DB_USERS.ops} PASSWORD '${p}';`,
    `CREATE USER ${DEMO_DB_USERS.opsPartner} PASSWORD '${p}';`,
    `CREATE DATABASE ${DEMO_DATABASES.ops} OWNER ${DEMO_DB_USERS.ops};`,
    `CREATE USER ${DEMO_DB_USERS.purchase} PASSWORD '${p}';`,
    `CREATE DATABASE ${DEMO_DATABASES.purchase} OWNER ${DEMO_DB_USERS.purchase};`,
    `CREATE USER ${DEMO_DB_USERS.payment} PASSWORD '${p}';`,
    `CREATE DATABASE ${DEMO_DATABASES.payment} OWNER ${DEMO_DB_USERS.payment};`,
    `CREATE DATABASE ${DEMO_DATABASES.core};`,
  ].join('\n');
}

/** ops 마이그레이션 뒤 로그인 사용자를 그룹 역할에 넣는다(행 보안 정책은 그룹 역할에 걸린다) */
export function demoOpsRolesSql() {
  return [`GRANT ops_app TO ${DEMO_DB_USERS.ops};`, `GRANT ops_partner TO ${DEMO_DB_USERS.opsPartner};`].join('\n');
}

/** core 마이그레이션 뒤 로그인 사용자를 그룹 역할에 넣는다(통합 시험 roles.ts와 같은 꼴) */
export function demoCoreRolesSql(password) {
  const p = String(password).replaceAll("'", "''");
  return DEMO_DB_USERS.core
    .map((user, i) => `CREATE USER ${user} PASSWORD '${p}' NOBYPASSRLS NOSUPERUSER; GRANT ${['core_app', 'core_partner', 'core_ops', 'core_search'][i]} TO ${user};`)
    .join('\n');
}
