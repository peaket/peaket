// v1 측정 무대의 kind 객체(node tools/local/cluster.mjs v1, docs/verification.md §3.8 '합본의 v1 무대', BUILD_ORDER PRF-215): 주소, Valkey(TLS 켬·끔), 전용 PostgreSQL,
// Secret, 무대 공개 값 ConfigMap, DB 마이그레이션 잡, Kafka 토픽, 대기 상태 파일 앞 nginx 캐시, 결제 시뮬레이터, 고정 이미지 싣기 점검, helm 인자.
// 클러스터를 부르지 않는 순수 함수다(시험: v1-stage.test.mjs).
import { envFileText, V1_CONSENT_VERSION, V1_NAMESPACE, V1_PATHS, V1_PORTS, V1_SERVICES, v1EnvFiles } from './v1-stage.mjs';

export const V1_IMAGES = Object.freeze({ bundle: 'peaket/bundle:local', simulator: 'peaket/pg-simulator:local' });
/** deploy/local/valkey.yaml과 같은 Valkey 8.1 다이제스트(v0와 같은 판) */
export const V1_VALKEY_IMAGE = 'valkey/valkey@sha256:2602ace2be6569bc2bbb06f873776516ab9089821525be34f4305c67eb9db02a';
/**
 * 파드가 쓰는 Valkey 태그. kind는 `docker save --platform`으로 한 플랫폼만 싣기 때문에 목록 다이제스트와 노드의 매니페스트 다이제스트가 다르다.
 * 그래서 로컬 무대는 태그와 imagePullPolicy Never/IfNotPresent로 싣고, `cluster.mjs`가 시작 전에 이미지를 미리 넣는다(BAT-028 로컬 수정).
 */
export const V1_VALKEY_TAG = 'valkey/valkey:8.1-alpine';
/** 대기 상태 파일 앞 로컬 캐시(루트가 아닌 nginx, loadtest/runner/manifests.mjs의 NULL_TARGET_IMAGE와 같은 판). 실을 때 이 다이제스트와 견준다 */
export const V1_NGINX_IMAGE = 'nginxinc/nginx-unprivileged:1.29.3-alpine@sha256:5aea7cc516b419e3526f47dd1531be31a56a046cfe44754d94f9383e13e2ee99';
/**
 * 파드가 쓰는 이름(태그, 받지 않음). 여러 플랫폼 이미지는 kind에 한 플랫폼만 실어(docker save --platform) 노드의 다이제스트가 고정 판의 목록 다이제스트와 달라진다.
 * 그래서 실을 때 로컬 이미지의 다이제스트를 고정 판과 견주고, 파드는 태그와 imagePullPolicy Never로 그 이미지만 쓴다
 */
export const V1_NGINX_TAG = V1_NGINX_IMAGE.split('@')[0];
/** kind 노드 폴더(합본·릴레이 파드가 hostPath로 붙인다): 실행마다 쓰는 좌석맵 판, admission-ctrl 리더가 쓰는 묶음 결과 */
export const V1_HOST_DIRS = Object.freeze({ seatmaps: '/var/local/peaket-v1/seatmaps', batchResults: '/var/local/peaket-v1/batch-results' });
/** 무대의 Kafka 토픽(소비·생산 모두. 로컬 Kafka는 auto.create.topics.enable이 꺼져 있다, deploy/local/kafka.yaml) */
export const V1_KAFKA_TOPICS = Object.freeze(['trade.seats', 'trade.payments', 'trade.orders', 'trade.purchase-sessions', 'identity.accounts-withdrawn', 'telemetry.behavior']);
/** v1 무대 전용 PostgreSQL(네임스페이스 v1)의 DB 둘 */
export const V1_DATABASES = Object.freeze({ purchase: 'v1_purchase', payment: 'v1_payment' });
/** deploy/local/postgres.yaml과 같은 PostgreSQL 18 다이제스트(통합 시험과 같은 판) */
export const V1_POSTGRES_IMAGE = 'postgres@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5';
/** 파드가 쓰는 PostgreSQL 태그(위와 같은 이유로 로컬 무대는 태그를 쓴다) */
export const V1_POSTGRES_TAG = 'postgres:18-alpine';

/**
 * 새 kind 클러스터에 미리 넣을 로컬 이미지 태그(BAT-028 로컬 수정). deploy/local/*.yaml의 태그와 같아야 한다.
 * `cluster.mjs`가 `docker save --platform linux/amd64`→`kind load image-archive`로 싣고, 파드는 태그로 찾는다.
 * 고정 다이제스트는 문서·공급망 확인용으로 남기고, 로컬 kind 무대의 파드 참조에는 쓰지 않는다.
 */
export const V1_PRELOAD_IMAGES = Object.freeze([
  'quay.io/strimzi/operator:0.47.0',
  'quay.io/strimzi/kafka:0.47.0-kafka-3.9.1',
  'prom/prometheus:latest',
  'grafana/grafana:latest',
  'postgres:18-alpine',
  'valkey/valkey:8.1-alpine',
  'motoserver/moto:5.2.5',
]);
/**
 * 전용 PostgreSQL의 연결 한도(코드 리뷰 M2). 합본 파드 하나의 풀 최대 58 × 복제 최대 8(v1Plan) + 릴레이 넷 약 28 = 492에 검사·psql·마이그레이션 여유를 더한다.
 * 로컬 PostgreSQL(peaket-local)의 기본 100은 복제 3에서도 넘는다
 */
export const V1_PG_MAX_CONNECTIONS = 600;
/** 다시 올릴 때 먼저 0개로 줄이는 앱 Deployment(DB·Valkey를 새로 만드는 동안 옛 키·옛 DB로 돌지 않게) */
export const V1_APP_DEPLOYS = Object.freeze(['bundle', 'purchase-svc-outbox-relay', 'payment-svc-outbox-relay']);
const RESTRICTED = Object.freeze({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } });
const POD_SECURITY = Object.freeze({ runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } });

/**
 * 무대의 클러스터 안 주소. redisTls가 참이면 대기열·좌석 Redis 주소가 rediss://다(두 Valkey가 TLS 포트만 연다)
 * @param {{ redisTls: boolean }} o
 */
export function v1Layout(o) {
  if (typeof o?.redisTls !== 'boolean') throw new TypeError('redisTls는 참·거짓이다');
  const scheme = o.redisTls ? 'rediss' : 'redis';
  const ns = V1_NAMESPACE;
  return {
    namespace: ns,
    redisTls: o.redisTls,
    queueRedisUrl: `${scheme}://valkey-queue.${ns}.svc.cluster.local:6379`,
    seatRedisUrl: `${scheme}://valkey-seat.${ns}.svc.cluster.local:6379`,
    kafkaBrokers: 'peaket-kafka-bootstrap.kafka.svc.cluster.local:9092',
    pgSimUrl: `http://pg-simulator.${ns}.svc.cluster.local:8790`,
    prometheusUrl: 'http://prometheus.observability.svc.cluster.local:9090',
    /** k6가 부르는 곳: queue-svc(대기 상태 파일은 캐시 앞으로), purchase-svc */
    queueUrl: `http://bundle.${ns}.svc.cluster.local:${V1_PORTS['queue-svc'].app}`,
    stateUrl: `http://queue-state-cache.${ns}.svc.cluster.local:8080`,
    purchaseUrl: `http://bundle.${ns}.svc.cluster.local:${V1_PORTS['purchase-svc'].app}`,
  };
}

/**
 * 전용 PostgreSQL의 DB 주소 둘(비밀번호는 무대마다 새로 만든 v1Keys().dbPassword. Secret에만 싣는다)
 * @param {string} password
 */
export function v1DatabaseUrls(password) {
  if (typeof password !== 'string' || !/^[A-Za-z0-9_-]{16,}$/.test(password)) throw new RangeError('DB 비밀번호는 16자 이상의 base64url이다');
  const base = `postgres://postgres:${password}@postgres.${V1_NAMESPACE}.svc.cluster.local:5432`;
  return { purchase: `${base}/${V1_DATABASES.purchase}`, payment: `${base}/${V1_DATABASES.payment}` };
}

/** Valkey TLS 인증서의 SAN(두 Valkey Service 이름) */
export function redisTlsNames() {
  return ['valkey-queue', 'valkey-seat'].flatMap((n) => [n, `${n}.${V1_NAMESPACE}.svc`, `${n}.${V1_NAMESPACE}.svc.cluster.local`]);
}

/**
 * Valkey TLS 시험 인증서를 만드는 openssl 인자 셋(인증 기관 → 서버 키·요청 → 서명). 파일은 임시 폴더에만 두고 바로 지운다(cluster.mjs)
 * @param {string} dir
 * @returns {string[][]}
 */
export function redisTlsCertArgs(dir) {
  /** @param {string} f */
  const p = (f) => `${dir}/${f}`;
  const san = redisTlsNames().map((n) => `DNS:${n}`).join(',');
  return [
    ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '30', '-subj', '/CN=peaket-v1-redis-ca', '-keyout', p('ca.key'), '-out', p('ca.crt')],
    ['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-subj', '/CN=valkey', '-addext', `subjectAltName=${san}`, '-keyout', p('tls.key'), '-out', p('tls.csr')],
    ['x509', '-req', '-in', p('tls.csr'), '-CA', p('ca.crt'), '-CAkey', p('ca.key'), '-CAcreateserial', '-days', '30', '-copy_extensions', 'copyall', '-out', p('tls.crt')],
  ];
}

/**
 * Valkey 하나(대기열 또는 좌석)의 Service와 Deployment. tls면 TLS 포트 6379만 열고 평문 포트를 닫는다(서버 인증서는 Secret v1-redis-tls, 클라이언트 인증서는 받지 않는다).
 * 영속화는 끈다(측정 무대는 반복마다 새로 올린다)
 * @param {'valkey-queue'|'valkey-seat'} name @param {{ tls: boolean }} o
 */
export function v1ValkeyObjects(name, o) {
  if (name !== 'valkey-queue' && name !== 'valkey-seat') throw new RangeError(`Valkey 이름은 valkey-queue·valkey-seat다: ${name}`);
  if (typeof o?.tls !== 'boolean') throw new TypeError('tls는 참·거짓이다');
  const labels = { 'app.kubernetes.io/name': name, 'app.kubernetes.io/part-of': 'peaket' };
  const portArgs = o.tls ? ['--port', '0', '--tls-port', '6379', '--tls-cert-file', '/tls/tls.crt', '--tls-key-file', '/tls/tls.key', '--tls-ca-cert-file', '/tls/ca.crt', '--tls-auth-clients', 'no'] : ['--port', '6379'];
  return [
    { apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: V1_NAMESPACE, labels }, spec: { selector: labels, ports: [{ name: 'redis', port: 6379, targetPort: 6379 }] } },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace: V1_NAMESPACE, labels },
      spec: {
        replicas: 1,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            automountServiceAccountToken: false,
            securityContext: { ...POD_SECURITY, runAsUser: 999, runAsGroup: 999 },
            containers: [
              {
                name: 'valkey',
                image: V1_VALKEY_TAG,
                args: ['valkey-server', '--save', '', '--appendonly', 'no', '--protected-mode', 'no', ...portArgs],
                ports: [{ name: 'redis', containerPort: 6379 }],
                readinessProbe: { tcpSocket: { port: 6379 }, periodSeconds: 2 },
                resources: { requests: { cpu: '500m', memory: '512Mi' }, limits: { memory: '1Gi' } },
                securityContext: RESTRICTED,
                volumeMounts: [{ name: 'data', mountPath: '/data' }, ...(o.tls ? [{ name: 'tls', mountPath: '/tls', readOnly: true }] : [])],
              },
            ],
            volumes: [{ name: 'data', emptyDir: {} }, ...(o.tls ? [{ name: 'tls', secret: { secretName: 'v1-redis-tls' } }] : [])],
          },
        },
      },
    },
  ];
}

/**
 * v1 무대 전용 PostgreSQL(네임스페이스 v1, 코드 리뷰 M2): Service postgres와 Deployment. 연결 한도는 V1_PG_MAX_CONNECTIONS, 저장소는 임시(emptyDir, 다시 띄우면 비고
 * Secret v1-postgres의 새 비밀번호로 처음부터 만든다). 비밀번호는 Secret으로만 잇는다
 */
export function v1PostgresObjects() {
  const name = 'postgres';
  const labels = { 'app.kubernetes.io/name': name, 'app.kubernetes.io/part-of': 'peaket' };
  return [
    { apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: V1_NAMESPACE, labels }, spec: { selector: labels, ports: [{ name: 'pg', port: 5432, targetPort: 5432 }] } },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace: V1_NAMESPACE, labels },
      spec: {
        replicas: 1,
        strategy: { type: 'Recreate' },
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            automountServiceAccountToken: false,
            // 공식 이미지의 postgres 사용자(alpine uid 70)로 바로 띄운다
            securityContext: { runAsNonRoot: true, runAsUser: 70, runAsGroup: 70, fsGroup: 70, seccompProfile: { type: 'RuntimeDefault' } },
            containers: [
              {
                name: 'postgres',
                image: V1_POSTGRES_TAG,
                args: ['-c', `max_connections=${V1_PG_MAX_CONNECTIONS}`],
                envFrom: [{ secretRef: { name: 'v1-postgres' } }],
                ports: [{ name: 'pg', containerPort: 5432 }],
                readinessProbe: { exec: { command: ['pg_isready', '-U', 'postgres'] }, periodSeconds: 2 },
                resources: { requests: { cpu: '500m', memory: '1Gi' }, limits: { memory: '2Gi' } },
                securityContext: RESTRICTED,
                volumeMounts: [
                  { name: 'data', mountPath: '/var/lib/postgresql' },
                  { name: 'run', mountPath: '/var/run/postgresql' },
                  { name: 'tmp', mountPath: '/tmp' },
                ],
              },
            ],
            volumes: [
              { name: 'data', emptyDir: {} },
              { name: 'run', emptyDir: {} },
              { name: 'tmp', emptyDir: {} },
            ],
          },
        },
      },
    },
  ];
}

/**
 * 무대의 Secret(네임스페이스 v1). 개인 성분은 여기에만 있다.
 * - v1-bundle-env: 합본의 서비스별 환경 파일 넷(`<서비스>.env`)
 * - v1-relay-purchase·v1-relay-payment: 릴레이와 마이그레이션 잡의 환경 값(서비스·릴레이·정비 역할 DB 주소는 전용 PostgreSQL 슈퍼유저 하나, Kafka, purchase는 좌석 Redis, payment는 시뮬레이터)
 * - v1-postgres: 전용 PostgreSQL의 비밀번호(무대마다 새로)
 * - v1-redis-tls: Valkey TLS 시험 인증 기관과 서버 인증서(TLS를 끈 무대에도 만든다. 합본·릴레이가 인증 기관 파일을 붙인다)
 * - pg-simulator: 결제 시뮬레이터 시험 키
 * @param {{ keys: ReturnType<typeof import('./v1-stage.mjs').v1Keys>, layout: ReturnType<typeof v1Layout>, tls: { ca: string, cert: string, key: string }, replicas: number }} o
 */
export function v1Secrets(o) {
  const L = o.layout;
  if (!Number.isInteger(o.replicas) || o.replicas < 1) throw new RangeError('합본 복제 수는 1 이상 정수다');
  const db = v1DatabaseUrls(o.keys.dbPassword);
  const files = v1EnvFiles({
    keys: o.keys,
    queueRedisUrl: L.queueRedisUrl,
    seatRedisUrl: L.seatRedisUrl,
    purchaseDatabaseUrl: db.purchase,
    paymentDatabaseUrl: db.payment,
    seatmapDir: V1_PATHS.seatmapDir,
    batchResultDir: V1_PATHS.batchResultDir,
    pgSimUrl: L.pgSimUrl,
    kafkaBrokers: L.kafkaBrokers,
    prometheusUrl: L.prometheusUrl,
    paymentPodCount: o.replicas,
  });
  /** @param {string} name @param {Record<string, string>} stringData */
  const secret = (name, stringData) => ({ apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: V1_NAMESPACE }, type: 'Opaque', stringData });
  /** @param {string} url */
  const relayDb = (url) => ({ PEAKET_DATABASE_URL: url, PEAKET_OUTBOX_DATABASE_URL: url, PEAKET_MAINTENANCE_DATABASE_URL: url, PEAKET_KAFKA_BROKERS: L.kafkaBrokers });
  return [
    secret('v1-bundle-env', Object.fromEntries(V1_SERVICES.map((s) => [`${s}.env`, envFileText(files[/** @type {keyof typeof files} */ (s)])]))),
    secret('v1-relay-purchase', { ...relayDb(db.purchase), PEAKET_SEAT_REDIS_URL: L.seatRedisUrl }),
    secret('v1-relay-payment', { ...relayDb(db.payment), PEAKET_PG_SIM_URL: L.pgSimUrl, PEAKET_PG_SIM_SECRET_KEY: o.keys.pgSim.secretKey, PEAKET_PG_SIM_CLIENT_KEY: o.keys.pgSim.clientKey }),
    secret('v1-redis-tls', { 'ca.crt': o.tls.ca, 'tls.crt': o.tls.cert, 'tls.key': o.tls.key }),
    secret('pg-simulator', { PG_SIMULATOR_SECRET_KEY: o.keys.pgSim.secretKey }),
    secret('v1-postgres', { POSTGRES_PASSWORD: o.keys.dbPassword }),
  ];
}

/**
 * 무대 공개 값(ConfigMap v1-stage-public, 코드 리뷰): 실행 도구가 개인 성분이 든 환경 파일을 읽지 않고 쓰는 값. 구매 세션 서버 ECDH 공개키(JWK), 주문 동의 판,
 * Redis TLS, 합본 복제 수, 실은 nginx 이미지(ID·플랫폼·매니페스트), PostgreSQL 연결 한도
 * @param {{ keys: ReturnType<typeof import('./v1-stage.mjs').v1Keys>, redisTls: boolean, replicas: number, nginx: { imageId: string, platform: string, manifest: string } }} o
 */
export function v1PublicConfigMap(o) {
  const { kty, crv, x, y, kid } = /** @type {Record<string, string>} */ (o.keys.ecdh.publicJwk);
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'v1-stage-public', namespace: V1_NAMESPACE, labels: { 'app.kubernetes.io/part-of': 'peaket' } },
    data: {
      ecdhPublicJwk: JSON.stringify({ kty, crv, x, y, ...(kid ? { kid } : {}) }),
      consentVersion: V1_CONSENT_VERSION,
      redisTls: String(o.redisTls),
      replicas: String(o.replicas),
      nginxImageId: o.nginx.imageId,
      nginxPlatform: o.nginx.platform,
      nginxManifest: o.nginx.manifest,
      pgMaxConnections: String(V1_PG_MAX_CONNECTIONS),
    },
  };
}

/**
 * docker info의 Architecture를 이미지 플랫폼으로(이 PC의 Docker 엔진이 kind 노드를 돌린다. node의 process.arch는 에뮬레이션이면 다를 수 있다)
 * @param {string} architecture
 */
export function dockerPlatform(architecture) {
  const a = String(architecture).trim();
  if (a === 'x86_64' || a === 'amd64') return 'linux/amd64';
  if (a === 'aarch64' || a === 'arm64') return 'linux/arm64';
  throw new RangeError(`Docker 엔진 아키텍처를 모른다: ${a}`);
}

/**
 * 고정 판 이미지를 kind에 싣기 전 점검(코드 리뷰): 로컬 태그의 이미지 ID가 고정 다이제스트(목록)와 같고, 이 플랫폼의 매니페스트가 로컬에 있어야 한다.
 * 실을 것(태그·플랫폼)과 실은 뒤 노드에서 견줄 매니페스트 다이제스트를 돌려준다
 * @param {{ pinned: string, imageId: string, descriptor: { mediaType?: string, digest?: string, platform?: { architecture?: string, os?: string } } | null, platform: string }} o
 */
export function pinnedImagePlan(o) {
  const [tag, digest] = o.pinned.split('@');
  if (!tag || !/^sha256:[0-9a-f]{64}$/.test(digest ?? '')) throw new RangeError(`고정 판은 <이름>:<태그>@sha256:<다이제스트>다: ${o.pinned}`);
  if (o.imageId !== digest) throw new Error(`${tag}의 이미지 ID(${o.imageId})가 고정 판(${digest})과 다르다`);
  const [os, architecture] = o.platform.split('/');
  const d = o.descriptor;
  if (!d || !/manifest/.test(d.mediaType ?? '') || /index|list/.test(d.mediaType ?? '') || !/^sha256:[0-9a-f]+$/.test(d.digest ?? '')) throw new Error(`${tag}에 ${o.platform} 매니페스트가 없다`);
  if (d.platform?.os !== os || d.platform?.architecture !== architecture) throw new Error(`${tag}의 매니페스트 플랫폼(${d.platform?.os}/${d.platform?.architecture})이 ${o.platform}이 아니다`);
  return { tag, imageId: o.imageId, manifest: /** @type {string} */ (d.digest), platform: o.platform };
}

/**
 * kind 노드의 `ctr -n k8s.io images ls` 출력에서 태그의 다이제스트(없으면 undefined). 도커 허브 이름은 docker.io/를 붙여 찾는다
 * @param {string} listing @param {string} tag
 */
export function nodeImageDigest(listing, tag) {
  const ref = tag.split('/')[0].includes('.') ? tag : `docker.io/${tag.includes('/') ? tag : `library/${tag}`}`;
  for (const line of listing.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] === ref) return cols.find((c) => /^sha256:[0-9a-f]+$/.test(c));
  }
  return undefined;
}

/**
 * 다시 올릴 때 먼저 0개로 줄이는 kubectl 인자(있는 앱 Deployment만, 없으면 undefined)
 * @param {string[]} existing `kubectl get deploy -o name` 줄들
 */
export function v1ScaleDownArgs(existing) {
  const names = V1_APP_DEPLOYS.map((d) => `deployment.apps/${d}`).filter((d) => existing.includes(d));
  return names.length ? ['-n', V1_NAMESPACE, 'scale', ...names, '--replicas=0'] : undefined;
}

/**
 * DB 마이그레이션 잡(합본 이미지, 그 서비스 패키지의 scripts/migrate.mjs). DB 주소는 Secret v1-relay-<서비스>에서만 받는다.
 * 스크립트는 시작 파일로 불렸는지를 실제 경로로 견주므로, 패키지의 실제 경로로 옮겨 부른다(node_modules 연결 경로로 부르면 아무 일 없이 끝난다)
 * @param {'purchase'|'payment'} service
 */
export function v1MigrationJob(service) {
  if (service !== 'purchase' && service !== 'payment') throw new RangeError(`마이그레이션 대상은 purchase·payment다: ${service}`);
  const name = `v1-migrate-${service}`;
  const labels = { 'app.kubernetes.io/name': name, 'app.kubernetes.io/part-of': 'peaket' };
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace: V1_NAMESPACE, labels },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          securityContext: POD_SECURITY,
          containers: [
            {
              name: 'migrate',
              image: V1_IMAGES.bundle,
              imagePullPolicy: 'Never',
              command: ['sh', '-c', `cd "$(readlink -f node_modules/@peaket/${service}-svc)" && exec node scripts/migrate.mjs`],
              env: [{ name: 'PEAKET_ENV', value: 'local' }],
              envFrom: [{ secretRef: { name: `v1-relay-${service}` } }],
              resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { memory: '256Mi' } },
              securityContext: RESTRICTED,
            },
          ],
        },
      },
    },
  };
}

/**
 * Kafka 토픽 하나를 없을 때만 만드는 kubectl 인자(Strimzi 브로커 파드 안의 kafka-topics.sh, 파티션 3·복제 1 [가정])
 * @param {string} topic
 */
export function kafkaTopicArgs(topic) {
  if (!V1_KAFKA_TOPICS.includes(topic)) throw new RangeError(`무대 토픽이 아니다: ${topic}`);
  // 도구 JVM은 브로커 컨테이너의 메모리 한도(1Gi)를 함께 쓴다. 기본 힙(256MiB 이상)이면 브로커째 OOMKilled될 수 있어 작게 준다(2026-11-10 v1 무대 올리기에서 겪음)
  return ['-n', 'kafka', 'exec', 'peaket-dual-0', '-c', 'kafka', '--', 'env', 'KAFKA_HEAP_OPTS=-Xms32m -Xmx96m', 'bin/kafka-topics.sh', '--bootstrap-server', 'localhost:9092', '--create', '--if-not-exists', '--topic', topic, '--partitions', '3', '--replication-factor', '1'];
}

/**
 * 대기 상태 파일 앞의 로컬 nginx 캐시 설정(docs/verification.md §3.4 '로컬 캐시 설정'): 대기 상태 파일 GET만 캐시하고(원본의 Expires·Cache-Control로 시간을 정한다),
 * 새 항목은 한 요청만 채운다(proxy_cache_lock). 입장 임박 구간 경로라 낡은 값 허용(use_stale updating·background_update)은 끈다. 다른 경로는 캐시 없이 넘긴다
 * @param {string} [upstream]
 */
export function v1StateCacheConf(upstream = `bundle.${V1_NAMESPACE}.svc.cluster.local:${V1_PORTS['queue-svc'].app}`) {
  return [
    'worker_processes 2;',
    'pid /tmp/nginx.pid;',
    'events { worker_connections 8192; }',
    'http {',
    '  access_log off;',
    '  client_body_temp_path /tmp/client_body; proxy_temp_path /tmp/proxy; fastcgi_temp_path /tmp/fastcgi; uwsgi_temp_path /tmp/uwsgi; scgi_temp_path /tmp/scgi;',
    '  proxy_cache_path /tmp/cache levels=1:2 keys_zone=state:16m max_size=256m inactive=60s use_temp_path=off;',
    `  upstream origin { server ${upstream}; keepalive 64; }`,
    '  server {',
    '    listen 8080;',
    '    location ~ ^/v1/queues/[^/]+/segment-states/[0-9]+[.]json$ {',
    '      proxy_pass http://origin; proxy_http_version 1.1; proxy_set_header Connection "";',
    '      proxy_cache state; proxy_cache_lock on; proxy_cache_use_stale off; proxy_cache_background_update off;',
    '      add_header X-Cache $upstream_cache_status always;',
    '    }',
    '    location / { proxy_pass http://origin; proxy_http_version 1.1; proxy_set_header Connection ""; }',
    '  }',
    '}',
    '',
  ].join('\n');
}

/** 로컬 캐시의 ConfigMap·Service(queue-state-cache:8080)·Deployment */
export function v1StateCacheObjects() {
  const name = 'queue-state-cache';
  const labels = { 'app.kubernetes.io/name': name, 'app.kubernetes.io/part-of': 'peaket' };
  return [
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace: V1_NAMESPACE, labels }, data: { 'nginx.conf': v1StateCacheConf() } },
    { apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: V1_NAMESPACE, labels }, spec: { selector: labels, ports: [{ name: 'http', port: 8080, targetPort: 8080 }] } },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace: V1_NAMESPACE, labels },
      spec: {
        replicas: 1,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            automountServiceAccountToken: false,
            securityContext: { ...POD_SECURITY, runAsUser: 101, runAsGroup: 101 },
            containers: [
              {
                name: 'nginx',
                image: V1_NGINX_TAG,
                imagePullPolicy: 'Never',
                args: ['nginx', '-c', '/etc/nginx-conf/nginx.conf', '-g', 'daemon off;'],
                ports: [{ name: 'http', containerPort: 8080 }],
                readinessProbe: { tcpSocket: { port: 8080 }, periodSeconds: 2 },
                resources: { requests: { cpu: '500m', memory: '128Mi' }, limits: { memory: '256Mi' } },
                securityContext: RESTRICTED,
                volumeMounts: [
                  { name: 'conf', mountPath: '/etc/nginx-conf', readOnly: true },
                  { name: 'tmp', mountPath: '/tmp' },
                ],
              },
            ],
            volumes: [
              { name: 'conf', configMap: { name } },
              { name: 'tmp', emptyDir: { sizeLimit: '512Mi' } },
            ],
          },
        },
      },
    },
  ];
}

/** 무대의 결제 시뮬레이터(deploy/local/pg-simulator.yaml과 같은 꼴, 네임스페이스 v1) */
export function v1SimulatorObjects() {
  const name = 'pg-simulator';
  const labels = { 'app.kubernetes.io/name': name, 'app.kubernetes.io/part-of': 'peaket' };
  return [
    { apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: V1_NAMESPACE, labels }, spec: { selector: labels, ports: [{ name: 'http', port: 8790, targetPort: 8790 }] } },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace: V1_NAMESPACE, labels },
      spec: {
        replicas: 1,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            automountServiceAccountToken: false,
            securityContext: POD_SECURITY,
            containers: [
              {
                name: 'simulator',
                image: V1_IMAGES.simulator,
                imagePullPolicy: 'Never',
                env: [
                  { name: 'PEAKET_ENV', value: 'local' },
                  { name: 'PG_SIMULATOR_HOST', value: '0.0.0.0' },
                  { name: 'PG_SIMULATOR_PORT', value: '8790' },
                ],
                envFrom: [{ secretRef: { name } }],
                ports: [{ name: 'http', containerPort: 8790 }],
                readinessProbe: { tcpSocket: { port: 'http' }, periodSeconds: 2 },
                resources: { requests: { cpu: '500m', memory: '256Mi' }, limits: { memory: '512Mi' } },
                securityContext: RESTRICTED,
              },
            ],
          },
        },
      },
    },
  ];
}

const RELEASES = Object.freeze({ 'v1-bundle': 'bundle', 'v1-purchase-relay': 'purchase-svc-relay', 'v1-payment-relay': 'payment-svc-relay' });

/**
 * 공용 차트로 v1 릴리스 하나를 올리는 helm 인자(값은 deploy/envs/local/<값 파일>.yaml). 합본은 복제 수·CPU·메모리를 바꿀 수 있다
 * (리허설은 1, 측정은 값 파일의 3·CPU 1). `--cpus`·`--memory-mi`는 합본에만 준다.
 * @param {'v1-bundle'|'v1-purchase-relay'|'v1-payment-relay'} values @param {string} repo 저장소 뿌리 @param {{ replicas?: number, cpus?: number, memoryMi?: number }} [o]
 */
export function v1HelmArgs(values, repo, o = {}) {
  if (!Object.hasOwn(RELEASES, values)) throw new RangeError(`v1 값 파일은 ${Object.keys(RELEASES).join('·')}다: ${values}`);
  const args = ['upgrade', '--install', RELEASES[values], `${repo}/deploy/charts/peaket-service`, '--namespace', V1_NAMESPACE, '-f', `${repo}/deploy/envs/local/${values}.yaml`, '--wait', '--timeout', '600s'];
  if (o.replicas !== undefined) {
    if (values !== 'v1-bundle' || !Number.isInteger(o.replicas) || o.replicas < 1 || o.replicas > 8) throw new RangeError('복제 수는 합본에만 1~8로 준다');
    args.push('--set', `service.replicas=${o.replicas}`);
  }
  if (o.cpus !== undefined) {
    if (values !== 'v1-bundle' || !Number.isInteger(o.cpus) || o.cpus < 1 || o.cpus > 16) throw new RangeError('CPU 수는 합본에만 1~16으로 준다');
    args.push('--set', `service.resources.requests.cpu=${o.cpus}`, '--set', `service.resources.limits.cpu=${o.cpus}`);
  }
  if (o.memoryMi !== undefined) {
    if (values !== 'v1-bundle' || !Number.isInteger(o.memoryMi) || o.memoryMi < 256 || o.memoryMi > 32768) throw new RangeError('메모리는 합본에만 256~32768Mi로 준다');
    args.push('--set', `service.resources.requests.memory=${o.memoryMi}Mi`, '--set', `service.resources.limits.memory=${o.memoryMi}Mi`);
  }
  return args;
}

/**
 * v1 명령의 인자: [--redis-tls on|off](기본 on, 운영과 같다) [--replicas N](기본 값 파일의 3)
 * [--cpus N](합본 CPU 요청·한도, 1~16) [--memory-mi N](합본 메모리 요청·한도, 256~32768). 모르는 인자는 Error
 * @param {string[]} argv
 * @returns {{ redisTls: boolean, replicas: number | undefined, cpus: number | undefined, memoryMi: number | undefined }}
 */
export function v1Plan(argv) {
  let redisTls = true;
  /** @type {number | undefined} */
  let replicas;
  /** @type {number | undefined} */
  let cpus;
  /** @type {number | undefined} */
  let memoryMi;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--redis-tls') {
      const v = argv[++i];
      if (v !== 'on' && v !== 'off') throw new Error('--redis-tls는 on·off다');
      redisTls = v === 'on';
    } else if (a === '--replicas') {
      const v = argv[++i] ?? '';
      if (!/^[1-8]$/.test(v)) throw new Error('--replicas는 1~8이다');
      replicas = Number(v);
    } else if (a === '--cpus') {
      const v = argv[++i] ?? '';
      if (!/^(?:[1-9]|1[0-6])$/.test(v)) throw new Error('--cpus는 1~16이다');
      cpus = Number(v);
    } else if (a === '--memory-mi') {
      const v = argv[++i] ?? '';
      if (!/^\d+$/.test(v) || Number(v) < 256 || Number(v) > 32768) throw new Error('--memory-mi는 256~32768이다');
      memoryMi = Number(v);
    } else throw new Error(`v1의 모르는 인자: ${a}(쓰는 법: v1 [--redis-tls on|off] [--replicas N] [--cpus N] [--memory-mi N])`);
  }
  return { redisTls, replicas, cpus, memoryMi };
}
