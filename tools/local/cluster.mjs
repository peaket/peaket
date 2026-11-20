#!/usr/bin/env node
// 로컬·CI kind 클러스터(docs/infra.md §3 '로컬', openspec 변경 add-local-cluster-and-relay-deployment).
// 쓰는 법(저장소 뿌리에서):
//   node tools/local/cluster.mjs up      클러스터 peaket + Strimzi Kafka 3.9.1 + PostgreSQL 18 + AWS 흉내 서버(moto)
//   node tools/local/cluster.mjs image   서비스 뼈대 이미지를 만들어 클러스터에 싣는다(peaket/example-svc:local)
//   node tools/local/cluster.mjs observability  로컬 관측 최소(Prometheus·Grafana와 템플릿 대시보드, docs/observability.md §3)
//   node tools/local/cluster.mjs grafana  Grafana를 127.0.0.1:3000으로 연다(포트 전달)
//   node tools/local/cluster.mjs prometheus  Prometheus를 127.0.0.1:9090으로 연다(collect.py --prom-url)
//   node tools/local/cluster.mjs v0      v0 배포(이미지 둘·Valkey·metrics-server·Secret·마이그레이션·앱(CPU HPA)·입구, docs/infra.md §3 'v0 배포')
//   node tools/local/cluster.mjs v0-forward  v0 입구를 127.0.0.1:8443으로 연다(포트 전달)
//   node tools/local/cluster.mjs v1 [--redis-tls on|off] [--replicas N] [--cpus N] [--memory-mi N]  v1 측정 무대(한 프로세스 합본·릴레이·Valkey 둘·전용 PostgreSQL·DB 마이그레이션·Kafka 토픽·nginx 캐시, docs/verification.md §3.8 '합본의 v1 무대')
//   node tools/local/cluster.mjs v1-down   v1 측정 무대를 내린다(네임스페이스 v1과 kind 노드 폴더. 클러스터는 그대로)
//   node tools/local/cluster.mjs gateways  게이트웨이 다섯(Envoy Gateway 고정 판·deploy/gateways 로컬 덧씌우기·대역 백엔드·시험 키, docs/infra.md §4.1)과 시험 접속 정보 .cache/peaket-tools/gateways-e2e.json.
//                                         다섯은 kind 포트 매핑과 로컬 전용 NodePort Service로 127.0.0.1:18441~18445에 바로 열린다(포트 전달 없음)
//   node tools/local/cluster.mjs gateways-admission restore|empty|remove  gw-fan의 입장 토큰 키 목록 ConfigMap peaket-admission-jwks를 처음 값·빈 묶음·지움으로
//                                         바꾸고 gw-fan 프록시를 다시 띄워 기다린다(복구 경로 장애 주입 시험, docs/infra.md §4.1 '입장 토큰 확인', BAT-057)
//   node tools/local/cluster.mjs mesh-netpol  메시 없는 실행의 포트별 허용 NetworkPolicy 무대(BUILD_ORDER HOT-420, D-T36, ADR-0285): 원천
//                                         deploy/platform/mesh/port-allow.yaml의 워크로드마다 받는 쪽 대역 파드와 생성 NetworkPolicy를 올리고 시험 접속 정보
//                                         .cache/peaket-tools/mesh-netpol-e2e.json을 쓴다. 다시 돌려도 된다(덮어쓰기). 내리는 명령은 없다(down이 클러스터를 지운다)
//   node tools/local/cluster.mjs realtime-gw [--image <이름:태그>]  realtime-gw를 kind에 올린다(좌석 Redis·입장 토큰 공개키 묶음은 Secret, BUILD_ORDER BAS-140)
//   node tools/local/cluster.mjs status  파드 목록
//   node tools/local/cluster.mjs down    클러스터를 지운다
// - 클러스터 이름은 PEAKET_CLUSTER(기본 peaket)다. 여러 작업 폴더가 한 PC에서 따로 띄울 때 바꾼다(kubeconfig 기본 이름도 따라 바뀐다)
// - 클러스터를 만들 때 게이트웨이 포트 매핑(이 PC 127.0.0.1:<PEAKET_GATEWAY_BASE_PORT, 기본 18441>부터 다섯)을 건다. 시작 값을 바꾸거나 매핑 없이 만든
//   옛 클러스터를 쓰려면 down 뒤 up을 다시 한다(docs/infra.md §4.1 '로컬 kind에서 이 PC로 잇는 법')
// - 도구(kind·kubectl·helm)는 tools.mjs가 고정 판으로 받는다. 사용자의 ~/.kube/config는 건드리지 않고 전용 kubeconfig를 쓴다
// - 운영·CI 공급망은 다이제스트로 고정한다. 로컬 kind 무대는 `preloadLocalImages`가 태그 이미지를 노드에 미리 싣고 파드는 태그로 찾는다(BAT-028).
//   관측(Prometheus·Grafana) 매니페스트는 한 플랫폼(amd64) 매니페스트 다이제스트까지 고정하고, 같은 태그 이미지를 미리 실어 IfNotPresent로 찾게 한다
//   (여러 플랫폼 목록 다이제스트는 한 플랫폼만 실은 노드와 맞지 않아 Pulling에 머문다). 계정·인증 토큰이 필요한 것은 없다
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { connect as tlsConnect } from 'node:tls';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { DEFAULT_ROOT, ensureTool, httpsDownload } from './tools.mjs';
import { admissionJwks, admissionJwksConfigMap, admissionKeySet, ADMISSION_JWKS_CONFIGMAP, assertRatelimitBackend, echoObjects, GATEWAY_BASE_PORT, GATEWAY_CONTROLLER_IMAGE, GATEWAY_ECHO, GATEWAY_ECHO_IMAGE, GATEWAY_NAMES, GATEWAY_NAMESPACE, GATEWAY_PROXY_IMAGE, GATEWAY_RATELIMIT, gatewayCertArgs, gatewayContract, gatewayHostPorts, gatewayInstall, gatewayNodePortService, gatewayPortMappings, gatewaysAdmissionMode, gatewaySecrets, hostsOf, listenerCertificates, localGatewayObjects, RATELIMIT_REDIS, RATELIMIT_REDIS_IMAGE, ratelimitRedisObjects, ratelimitRedisSecret, ratelimitRedisTlsNames, readGatewayObjects } from './gateway-objects.mjs';
import { MESH_NETPOL_POLICIES, MESH_NETPOL_SOURCE, meshNetpolContract, meshNetpolLayout, meshNetpolStandIns } from './mesh-netpol-objects.mjs';
import { DEMO_CLUSTER, DEMO_DATABASES, DEMO_IMAGES as DEMO_WORKLOAD_IMAGES, DEMO_NAMESPACES, DEMO_PORTS, DEMO_WORKLOADS, demoAppObjects, demoCoreRolesSql, demoDatabaseInitSql, demoDatabaseUrls, demoExpectedWorkloads, demoGatewayObjects, demoGrpcNodePortService, demoNamespaces, demoOrigins, demoPostgresObjects, demoSecrets, demoTopics, demoValkeyObjects } from './demo-objects.mjs';
import { DEMO_IMAGES as DEMO_NEW_IMAGES, buildImage as buildDemoImage } from './demo-images.mjs';
import { DEMO_CONTRACT_FILE, prepareDemoSecrets } from './demo-auth.mjs';
import { applySeed, checkSeed } from './demo-seed.mjs';
import { generateV0TokenKey, loadOrCreateV0TokenKey } from './v0-token.mjs';
import { dockerPlatform, kafkaTopicArgs, nodeImageDigest, OBSERVABILITY_IMAGES, pinnedImagePlan, redisTlsCertArgs, V1_DATABASES, V1_HOST_DIRS, V1_IMAGES, V1_KAFKA_TOPICS, V1_NGINX_IMAGE, V1_PRELOAD_IMAGES, v1HelmArgs, v1Layout, v1MigrationJob, v1Plan, v1PostgresObjects, v1PublicConfigMap, v1ScaleDownArgs, v1Secrets, v1SimulatorObjects, v1StateCacheObjects, v1ValkeyObjects } from './v1-objects.mjs';
import { V1_NAMESPACE, v1Keys } from './v1-stage.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** demo 계열 명령은 기본 클러스터를 lane4-demo로 쓴다(다른 갈래의 peaket·lane4-* 클러스터를 건드리지 않는다) */
const demoCommand = /^demo(?:-|$)/.test(process.argv[2] ?? '');
export const CLUSTER = process.env.PEAKET_CLUSTER || (demoCommand ? DEMO_CLUSTER : 'peaket');
export const KUBECONFIG = process.env.PEAKET_KUBECONFIG || join(DEFAULT_ROOT, `kubeconfig-${CLUSTER}`);
export const IMAGE = 'peaket/example-svc:local';

/** 고정 판(2026-11-01 확인). 바꾸면 tools/local/README.md의 판 표도 고친다 */
export const PINNED = {
  // Kafka 3.9를 지원하는 마지막 Strimzi(0.48.0이 3.9.0·3.9.1을 뺐다). 운영 MSK와 같은 3.9.x를 쓰려고 고른다(docs/devops.md §9.4)
  strimziVersion: '0.47.0',
  strimziInstallUrl: 'https://github.com/strimzi/strimzi-kafka-operator/releases/download/0.47.0/strimzi-cluster-operator-0.47.0.yaml',
  strimziInstallSha256: '1eb1e72f3c20b94c8f4d54d255a5570006bd91ec5dc5d954a8a6318e9c392fa6',
  strimziOperatorDigest: 'sha256:a602b696a060a0bbb5618c3adfcb2d9021d5bb6d47d5cf01876ed0588292b84a',
  // 게이트웨이 다섯의 컨트롤러(docs/infra.md §4.1 'Envoy 게이트웨이의 첫 구현', BUILD_ORDER HOT-400). 2026-11-16에 공식 릴리스의 최신 안정판을 골랐다.
  // 설치 파일 해시는 GitHub 릴리스 자산의 sha256, 이미지 다이제스트는 docker.io/envoyproxy 레지스트리의 목록(index) 다이제스트다(받지 않고 조회).
  // 프록시 Envoy 이미지는 이 판의 기본값(api/v1alpha1/shared_types.go DefaultEnvoyProxyImage)을 그대로 쓴다
  envoyGatewayVersion: 'v1.10.0',
  envoyGatewayInstallUrl: 'https://github.com/envoyproxy/gateway/releases/download/v1.10.0/install.yaml',
  envoyGatewayInstallSha256: 'f87f4d59b983aa760da52a2a0002c612028106fe69beefdf3d30cfb03905944e',
  envoyGatewayControllerDigest: 'sha256:c2243d43518bed91d3ed8c2db849a4b7a14ac9b96eb019f2ab104bb1ca8572b1',
  envoyGatewayProxyImage: 'docker.io/envoyproxy/envoy:distroless-v1.40.2',
  envoyGatewayProxyDigest: 'sha256:09ca6f2140a61ad8df11779a4a30d52b48433d444466328494f9188c9c35eded',
  // 전역 레이트 리밋 서비스(docs/infra.md §4.1 '전역 레이트 리밋 걸기', BUILD_ORDER HOT-410). 판을 따로 고르지 않고 v1.10.0 설치 파일의 기본값
  // (envoy-gateway-config의 rateLimitDeployment.container.image)을 쓴다. 다이제스트는 docker.io/envoyproxy/ratelimit 레지스트리의 목록(index) 다이제스트다
  // (2026-11-16 받지 않고 조회, 감독 승인: 공식 레지스트리·다이제스트 고정·판 기록)
  envoyGatewayRatelimitImage: 'docker.io/envoyproxy/ratelimit:5ae0682e',
  envoyGatewayRatelimitDigest: 'sha256:b95206e32b1a5f824fb06062fbb85bbdfb7f5de54135e92afe8462f22c979681',
  // Kyverno CEL 입장 정책(BUILD_ORDER BAS-150·BAT-085, ADR-0318). 차트 3.10.0(appVersion v1.20.0)과 이미지 다이제스트를 고정한다.
  // 다이제스트는 2026-11-20 GHCR의 여러 플랫폼 목록(index) 다이제스트다. 차트 파일 자체는 helm repo가 판으로 받는다
  kyvernoVersion: 'v1.20.0',
  kyvernoChartVersion: '3.10.0',
  kyvernoChartRepo: 'https://kyverno.github.io/kyverno/',
  kyvernoImages: [
    'reg.kyverno.io/kyverno/kyverno:v1.20.0@sha256:9de49c5416ea536f00a205527197ac048abdf32c5a75d633cd9afff8928f359d',
    'reg.kyverno.io/kyverno/kyvernopre:v1.20.0@sha256:339067e083430e0c97007541bef9cfdbac89bee13f7228772c77ae8aead14b8b',
    'reg.kyverno.io/kyverno/background-controller:v1.20.0@sha256:c72df38320a48fc9de10f9d23d087a117853bb08207b7f60f6d1e8457fb3ddb7',
    'reg.kyverno.io/kyverno/cleanup-controller:v1.20.0@sha256:0f9ce0c203561c52499e871a987ff987371f57385fcafe7af1a01dfd6db1feee',
    'reg.kyverno.io/kyverno/reports-controller:v1.20.0@sha256:f54e3cc106fadb1a615d0ec11c42f741f51d3580a5f70dfbe7bd7ec58864ef03',
  ],
};

/**
 * Strimzi 설치 파일을 이 클러스터에 맞춘다: 네임스페이스, 운영자 메모리(384Mi에서 메모리 초과로 죽었다).
 * 운영자 이미지는 로컬 태그로 두고 `preloadLocalImages`가 kind 노드에 미리 싣는다(BAT-028 로컬 수정).
 * 고칠 자리가 없으면(판이 바뀜) 던진다
 */
export function strimziInstall(text, namespace) {
  const image = 'image: quay.io/strimzi/operator:0.47.0';
  if (!text.includes(image)) throw new Error('Strimzi 설치 파일에서 운영자 이미지 자리를 찾지 못했다(판이 바뀌었나?)');
  if (!/memory: 384Mi/.test(text)) throw new Error('Strimzi 설치 파일에서 운영자 메모리 자리를 찾지 못했다(판이 바뀌었나?)');
  // 운영자 이미지는 로컬 태그로 둔다. 새 kind 노드에는 `preloadLocalImages`가 `docker save --platform`으로 미리 넣는다.
  // 고정 다이제스트는 PINNED에 남겨 두지만, 로컬 무대의 파드 참조에는 쓰지 않는다(목록 다이제스트와 한 플랫폼 매니페스트가 달라 Pulling에 머문다).
  return text.replaceAll('namespace: myproject', `namespace: ${namespace}`).replaceAll('memory: 384Mi', 'memory: 512Mi');
}

const run = (cmd, args, o = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: o.input !== undefined ? ['pipe', 'pipe', 'inherit'] : o.quiet ? 'pipe' : ['ignore', 'pipe', 'inherit'], ...o });

/** 전용 kubeconfig로 kubectl을 부른다(표준 출력을 돌려준다) */
export async function kubectl(args, o = {}) {
  const k = await ensureTool('kubectl');
  return run(k, ['--kubeconfig', KUBECONFIG, ...args], o);
}

async function kind(args, o = {}) {
  return run(await ensureTool('kind'), args, o);
}

async function strimziFile() {
  const file = join(DEFAULT_ROOT, `strimzi-cluster-operator-${PINNED.strimziVersion}.yaml`);
  if (existsSync(file) && createHash('sha256').update(readFileSync(file)).digest('hex') === PINNED.strimziInstallSha256) return readFileSync(file, 'utf8');
  const bytes = await httpsDownload(PINNED.strimziInstallUrl);
  if (createHash('sha256').update(bytes).digest('hex') !== PINNED.strimziInstallSha256) throw new Error('Strimzi 설치 파일 해시가 맞지 않는다');
  mkdirSync(DEFAULT_ROOT, { recursive: true });
  writeFileSync(file, bytes);
  return bytes.toString('utf8');
}

const step = (msg) => console.log(`\n== ${msg}`);

/**
 * up의 인자. 없으면 Kafka(Strimzi)·PostgreSQL·AWS 흉내 서버를 올린다. --v0-only면 v0(Before 모놀리스)가 쓰는 PostgreSQL만 올린다.
 * 야간 비교가 CPU 4개 러너에 시스템 파드·두 판·발생기를 함께 놓으려고 쓴다(docs/devops.md §3.3). 모르는 인자는 Error
 * @param {string[]} argv
 * @returns {{ v0Only: boolean, manifests: string[] }} manifests는 deploy/local 아래 파일 이름(올리는 차례)
 */
export function upPlan(argv) {
  for (const x of argv) if (x !== '--v0-only') throw new Error(`up의 모르는 인자: ${x}(쓰는 법: up [--v0-only])`);
  const v0Only = argv.includes('--v0-only');
  return { v0Only, manifests: v0Only ? ['postgres.yaml'] : ['kafka.yaml', 'postgres.yaml', 'aws.yaml'] };
}

async function up(argv = []) {
  const plan = upPlan(argv);
  step('Docker 엔진');
  run('docker', ['info', '--format', '{{.ServerVersion}}'], { quiet: true });
  step('도구(kind·kubectl·helm, 고정 판)');
  for (const t of ['kind', 'kubectl', 'helm']) await ensureTool(t);
  await ensureCluster();
  await kubectl(['apply', '-f', '-'], { input: `${plan.v0Only ? '' : 'apiVersion: v1\nkind: Namespace\nmetadata: { name: kafka }\n---\n'}apiVersion: v1\nkind: Namespace\nmetadata: { name: peaket-local }\n` });
  await preloadLocalImages(plan.v0Only ? ['postgres:18-alpine'] : ['quay.io/strimzi/operator:0.47.0', 'quay.io/strimzi/kafka:0.47.0-kafka-3.9.1', 'postgres:18-alpine', 'motoserver/moto:5.2.5']);
  if (!plan.v0Only) {
    step(`Strimzi ${PINNED.strimziVersion} 운영자`);
    await kubectl(['apply', '--server-side', '--force-conflicts', '-n', 'kafka', '-f', '-'], { input: strimziInstall(await strimziFile(), 'kafka') });
    await kubectl(['-n', 'kafka', 'rollout', 'status', 'deploy/strimzi-cluster-operator', '--timeout=300s']);
  }
  step(plan.v0Only ? 'PostgreSQL 18(--v0-only: Kafka·AWS 흉내 서버는 올리지 않는다)' : 'Kafka 3.9.1(KRaft 하나), PostgreSQL 18, AWS 흉내 서버');
  for (const f of plan.manifests) await kubectl(['apply', '-f', join(REPO, 'deploy', 'local', f)]);
  await kubectl(['-n', 'peaket-local', 'rollout', 'status', 'deploy/postgres', '--timeout=300s']);
  if (!plan.v0Only) {
    await kubectl(['-n', 'peaket-local', 'rollout', 'status', 'deploy/aws', '--timeout=300s']);
    await kubectl(['-n', 'kafka', 'wait', 'kafka/peaket', '--for=condition=Ready', '--timeout=600s']);
  }
  step('준비됨');
  console.log(`kubeconfig: ${KUBECONFIG}`);
}

/** 게이트웨이 이 PC 포트의 시작 값(PEAKET_GATEWAY_BASE_PORT, 없으면 18441). 클러스터를 만들 때만 쓴다 */
const gatewayBasePort = () => Number(process.env.PEAKET_GATEWAY_BASE_PORT || GATEWAY_BASE_PORT);

/**
 * kind 클러스터 설정: deploy/local/kind.yaml을 그대로 두고 control-plane 노드에 게이트웨이 포트 매핑 다섯(gatewayPortMappings)만 더한다
 * (docs/infra.md §4.1 '로컬 kind에서 이 PC로 잇는 법'). up(--v0-only 포함)·v0·v1·gateways 어느 것이 클러스터를 만들어도 같은 설정이다
 * @param {number} basePort 이 PC 포트의 시작 값
 */
export function kindClusterConfig(basePort, o = {}) {
  const config = parseYaml(readFileSync(join(REPO, 'deploy', 'local', 'kind.yaml'), 'utf8'));
  const node = (config.nodes ?? []).find((n) => n.role === 'control-plane');
  if (!node) throw new Error('deploy/local/kind.yaml에 control-plane 노드가 없다');
  node.extraPortMappings = [...(node.extraPortMappings ?? []), ...gatewayPortMappings(basePort)];
  if (o.demo) {
    // identity gRPC 19051 → 노드 30051, 모의 기관 18920 → 노드 30189(127.0.0.1만)
    node.extraPortMappings.push(
      { containerPort: DEMO_PORTS.grpcNodePort, hostPort: DEMO_PORTS.grpc, listenAddress: '127.0.0.1', protocol: 'TCP' },
      { containerPort: DEMO_PORTS.idvNodePort, hostPort: DEMO_PORTS.idv, listenAddress: '127.0.0.1', protocol: 'TCP' },
    );
  }
  return config;
}

/** kind 클러스터가 없으면 만들고(게이트웨이 포트 매핑을 건 설정, .cache 아래 파일), kubeconfig가 없으면 내보낸다 */
async function ensureCluster() {
  step(`kind 클러스터 ${CLUSTER}`);
  const clusters = (await kind(['get', 'clusters'], { quiet: true })).split(/\s+/);
  if (!clusters.includes(CLUSTER)) {
    const configFile = join(DEFAULT_ROOT, `kind-${CLUSTER}.yaml`);
    mkdirSync(DEFAULT_ROOT, { recursive: true });
    writeFileSync(configFile, `# cluster.mjs가 deploy/local/kind.yaml에 게이트웨이 포트 매핑을 더해 만든 파일(커밋하지 않는다)\n${stringifyYaml(kindClusterConfig(gatewayBasePort(), { demo: CLUSTER === DEMO_CLUSTER }))}`);
    await kind(['create', 'cluster', '--config', configFile, '--name', CLUSTER, '--kubeconfig', KUBECONFIG, '--wait', '180s']);
  } else if (!existsSync(KUBECONFIG)) {
    await kind(['export', 'kubeconfig', '--name', CLUSTER, '--kubeconfig', KUBECONFIG]);
  }
}

async function image() {
  step(`이미지 ${IMAGE}`);
  execFileSync('docker', ['build', '-f', join(REPO, 'packages', 'platform', 'template', 'Dockerfile'), '-t', IMAGE, REPO], { stdio: 'inherit' });
  await preloadLocalImages([IMAGE]);
}

/**
 * 이미지 참조를 저장소와 태그로 가른다(레지스트리 포트의 `:`는 저장소 쪽이다)
 * @param {string} ref
 * @returns {{ repo: string, tag: string }}
 */
export function splitImageRef(ref) {
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  return colon > slash ? { repo: ref.slice(0, colon), tag: ref.slice(colon + 1) } : { repo: ref, tag: 'latest' };
}

/**
 * `이름:태그@sha256:…`에서 노드에 붙일 태그(`이름:태그`)를 고른다. 태그 없이 다이제스트만 있는 참조는 null이다(노드에 태그로 실을 수 없다)
 * @param {string} ref
 * @returns {string|null}
 */
export function tagOf(ref) {
  const at = ref.indexOf('@');
  const name = at < 0 ? ref : ref.slice(0, at);
  const slash = name.lastIndexOf('/');
  const colon = name.lastIndexOf(':');
  if (colon > slash) return name;
  return at < 0 ? name : null;
}

/**
 * containerd가 붙이는 정규화 이름까지 함께 돌려준다(`postgres:18-alpine` → `docker.io/library/postgres:18-alpine`).
 * 짧은 이름으로 실어도 노드에는 정규화된 이름으로 남으므로 두 꼴을 모두 본다(BAT-085 V-03)
 * @param {string} ref
 * @returns {string[]}
 */
export function normalizedImageNames(ref) {
  const { repo, tag } = splitImageRef(ref);
  const first = repo.split('/')[0];
  const isRegistry = repo.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
  const qualified = isRegistry ? repo : repo.includes('/') ? `docker.io/${repo}` : `docker.io/library/${repo}`;
  return [`${repo}:${tag}`, `${qualified}:${tag}`];
}

/**
 * 노드(containerd)에 태그가 없을 때 `ctr images tag`에 쓸 원본 이름을 고른다(BAT-085 V-03).
 * 예전 kind 적재 경로는 여러 플랫폼 목록을 가져오며 태그를 잃어 `import-<날짜>@sha256:…` 꼴로만 남겼다.
 * 이번에 새로 생긴 이름(added)에서 같은 저장소의 다이제스트 이름을 먼저 고르고, 다이제스트 이름이 하나뿐이면 그것을 쓴다.
 * 붙일 원본을 고르지 못하면 null이다(부르는 쪽이 시작을 멈춘다)
 * @param {string[]} names 지금 노드의 이미지 이름
 * @param {string[]} added 이번 가져오기로 새로 생긴 이름
 * @param {string} tag 붙이려는 태그
 * @returns {string|null}
 */
export function nodeTagSource(names, added, tag) {
  const aliases = normalizedImageNames(tag);
  if (aliases.some((a) => names.includes(a))) return null;
  const repos = [...new Set(aliases.map((a) => splitImageRef(a).repo))];
  const sameRepo = added.find((n) => aliases.includes(n) || repos.some((r) => n.startsWith(`${r}@`)));
  if (sameRepo) return sameRepo;
  const digests = added.filter((n) => n.includes('@sha256:'));
  if (digests.length === 1) return digests[0];
  return added.length === 1 ? added[0] : null;
}

/** 노드(containerd의 k8s.io 네임스페이스) 이미지 이름 목록 */
function nodeImages(node) {
  return run('docker', ['exec', node, 'ctr', '-n', 'k8s.io', 'images', 'ls', '-q'], { quiet: true })
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 노드에 그 태그가 있는가(containerd 정규화 이름 포함) */
function nodeHasTag(node, tag) {
  const names = nodeImages(node);
  return normalizedImageNames(tag).some((a) => names.includes(a));
}

/**
 * docker 보관 파일을 kind 노드에 넣고 태그가 있는지 확인한다(BAT-085 V-03).
 * docker cp → `ctr -n k8s.io images import --platform`으로 넣고, containerd가 태그를 잃었으면
 * `ctr images tag`로 붙인다. 끝내 태그가 없으면 던진다(파드가 이미지를 풀지 못한 채 helm --wait가 600초를 기다리게 두지 않는다).
 * 이 PC의 Docker Desktop에서 노드 `/tmp`로는 docker cp가 들어가지 않아 `/var/tmp`를 쓴다.
 * 짧은 이름(postgres:18-alpine)은 노드에서 docker.io/library/…로 정규화되므로 두 꼴을 모두 보고 태그를 확인한다.
 * @param {string} node 노드 컨테이너 이름(`${CLUSTER}-control-plane`)
 * @param {string} archive 이 PC의 docker 보관 파일
 * @param {string} tag 노드에 있어야 하는 태그
 * @param {string} platform `linux/amd64` 같은 플랫폼
 */
function importImageToNode(node, archive, tag, platform) {
  const before = new Set(nodeImages(node));
  run('docker', ['cp', archive, `${node}:/var/tmp/peaket-image.tar`], { quiet: true });
  try {
    run('docker', ['exec', node, 'ctr', '-n', 'k8s.io', 'images', 'import', '--platform', platform, '/var/tmp/peaket-image.tar']);
  } finally {
    try {
      run('docker', ['exec', node, 'rm', '-f', '/var/tmp/peaket-image.tar'], { quiet: true });
    } catch {
      // 임시 파일을 지우지 못해도 시작을 막지 않는다
    }
  }
  if (nodeHasTag(node, tag)) return;
  const names = nodeImages(node);
  const source = nodeTagSource(names, names.filter((n) => !before.has(n)), tag);
  if (source) run('docker', ['exec', node, 'ctr', '-n', 'k8s.io', 'images', 'tag', source, tag], { quiet: true });
  if (!nodeHasTag(node, tag)) {
    throw new Error(`${node}에 ${tag} 태그가 없다(containerd가 태그를 잃었고 붙일 원본도 찾지 못했다). 파드가 이미지를 찾지 못하므로 시작을 멈춘다`);
  }
}

/**
 * 로컬 Docker 이미지를 새 kind 노드에 미리 넣는다(BAT-028 로컬 수정, BAT-085 V-03).
 * 예전 적재 경로는 여러 플랫폼 이미지에서 목록 다이제스트의 내용을 찾지 못하고, 한 플랫폼만 실으면서
 * 태그를 잃는다(`docker.io/library/import-2026-11-20@sha256:…`). 그래서 이 PC의 플랫폼 이미지만 `docker save --platform`으로
 * 저장하고 `docker cp` → `ctr images import --platform` → 태그 확인·복구 순서로 넣는다.
 * 로컬에 없으면 받아 온다(CI 러너처럼 처음부터 비어 있는 환경에서도 observability·v1이 서게).
 * 파드는 태그로 찾고(imagePullPolicy IfNotPresent/Never), 고정 다이제스트는 문서·공급망 확인용으로만 남긴다.
 * @param {readonly string[]} refs 태그(또는 `이름:태그@sha256:…`)
 */
async function preloadLocalImages(refs) {
  const unique = [...new Set(refs)];
  step(`로컬 이미지 ${unique.length}개를 kind에 미리 싣기`);
  const platform = dockerPlatform(run('docker', ['info', '--format', '{{.Architecture}}'], { quiet: true }));
  const node = `${CLUSTER}-control-plane`;
  for (const ref of unique) {
    const tag = tagOf(ref);
    if (!tag) throw new Error(`${ref}: 태그 없는 다이제스트 참조는 노드에 태그로 실을 수 없다(이름:태그로 준다)`);
    try {
      run('docker', ['image', 'inspect', '--format', '{{.Id}}', ref], { quiet: true });
    } catch {
      step(`로컬에 ${ref}가 없어 받는다`);
      execFileSync('docker', ['pull', '--platform', platform, ref], { stdio: 'inherit' });
    }
    // 다이제스트로만 받은 이미지는 로컬 RepoTags가 비어 docker save가 태그를 잃는다. 실을 태그를 먼저 붙인다(V-03)
    try {
      run('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], { quiet: true });
    } catch {
      run('docker', ['tag', ref, tag], { quiet: true });
    }
    const dir = mkdtempSync(join(tmpdir(), 'peaket-image-'));
    const archive = join(dir, 'image.tar');
    try {
      execFileSync('docker', ['save', '--platform', platform, tag, '-o', archive], { stdio: ['ignore', 'ignore', 'pipe'] });
      importImageToNode(node, archive, tag, platform);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// --- 로컬 관측 최소(docs/observability.md §3 '로컬 관측 최소와 템플릿 대시보드', wbs 1.3.1) ---

/** Grafana 관리자 Secret. 비밀번호는 저장소에 두지 않고 처음 올릴 때 무작위로 만든다(ASVS v5.0.0-13.3.1) */
export function grafanaAdminSecret() {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'grafana-admin', namespace: 'observability' },
    type: 'Opaque',
    stringData: { password: randomBytes(32).toString('base64url') },
  };
}

/** Grafana를 이 PC에서만 보도록 127.0.0.1에 묶은 포트 전달 인자(ASVS v5.0.0-13.4.5) */
export function grafanaForwardArgs(port = 3000) {
  return ['-n', 'observability', 'port-forward', '--address', '127.0.0.1', 'svc/grafana', `${port}:3000`];
}

/** Prometheus를 이 PC에서만 읽도록 127.0.0.1에 묶은 포트 전달 인자(collect.py --prom-url http://127.0.0.1:9090) */
export function prometheusForwardArgs(port = 9090) {
  return ['-n', 'observability', 'port-forward', '--address', '127.0.0.1', 'svc/prometheus', `${port}:9090`];
}

/** 대시보드 ConfigMap: deploy/local/dashboards/*.json(tools/local/dashboards.mjs가 만든 파일) */
function dashboardsConfigMap() {
  const dir = join(REPO, 'deploy', 'local', 'dashboards');
  const data = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
  return { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'grafana-dashboards', namespace: 'observability' }, data };
}

async function observability() {
  step('로컬 관측 최소(Prometheus·Grafana, deploy/local/observability.yaml)');
  await preloadLocalImages(OBSERVABILITY_IMAGES);
  await kubectl(['apply', '-f', join(REPO, 'deploy', 'local', 'observability.yaml')]);
  // 관리자 Secret은 없을 때만 만든다(다시 올려도 비밀번호를 바꾸지 않는다)
  const has = await kubectl(['-n', 'observability', 'get', 'secret', 'grafana-admin', '--ignore-not-found', '-o', 'name'], { quiet: true });
  // create는 last-applied 주석을 남기지 않는다(일반 apply는 비밀번호를 주석에 평문으로 남긴다)
  if (!has.trim()) await kubectl(['create', '-f', '-'], { input: JSON.stringify(grafanaAdminSecret()) });
  // 서버 쪽 적용은 주석에 내용을 한 번 더 넣지 않는다(주석 한도 256KiB에 대시보드가 걸리지 않게)
  await kubectl(['apply', '--server-side', '--force-conflicts', '-f', '-'], { input: JSON.stringify(dashboardsConfigMap()) });
  await kubectl(['-n', 'observability', 'rollout', 'restart', 'deploy/grafana']);
  for (const d of ['prometheus', 'grafana']) await kubectl(['-n', 'observability', 'rollout', 'status', `deploy/${d}`, '--timeout=300s']);
  step('준비됨');
  console.log('Grafana 보기: node tools/local/cluster.mjs grafana (http://127.0.0.1:3000, 익명 보기)');
}

// --- v0 배포(docs/infra.md §3 'v0 배포', wbs 1.1.4, K6·K9의 v0) ---

export const V0_NAMESPACE = 'v0';
export const V0_IMAGES = { app: 'peaket/v0-monolith:local', simulator: 'peaket/pg-simulator:local' };
/** v0 DB(로컬 PostgreSQL 18 안의 DB v0). 비밀번호는 deploy/local/postgres.yaml의 합성 시험 값이다 */
export const V0_DATABASE_URL = 'postgres://postgres:peaket-local@postgres.peaket-local.svc.cluster.local:5432/v0';
export const V0_REDIS_URL = 'redis://valkey.peaket-local.svc.cluster.local:6379';
export const V0_PG_URL = 'http://pg-simulator.v0.svc.cluster.local:8790';
/** 입구가 받는 쓰기 출처(포트 전달 주소) */
export const V0_ALLOWED_ORIGINS = 'https://127.0.0.1:8443,https://localhost:8443';
/** 입구 포트 전달 주소 */
export const V0_FORWARD_PORT = 8443;

/** 야간 비교의 기준판 네임스페이스(docs/devops.md §3.3, BSL-090). 새 판은 V0_NAMESPACE */
export const V0_BASE_NAMESPACE = 'v0-base';

/**
 * v0 판 하나의 자리(docs/devops.md §3.3 '준비 명령'). namespace는 'v0'(새 판·Before 측정) 또는 'v0-base'(야간 비교 기준판)이고 그 밖은 RangeError.
 * - v0: database 'v0', databaseUrl V0_DATABASE_URL, redisUrl V0_REDIS_URL
 * - v0-base: database 'v0_base', databaseUrl은 V0_DATABASE_URL의 DB 이름만 v0_base로 바꾼 것, redisUrl은 V0_REDIS_URL + '/1'(Valkey DB 1.
 *   회차 목록 같은 공용 키가 두 판 사이에 섞이지 않게)
 * - 둘 다 pgUrl은 V0_PG_URL(시뮬레이터는 v0 네임스페이스의 하나를 함께 쓴다), gatewayUrl은 'https://v0-gateway.<namespace>.svc.cluster.local:8443'
 * @param {string} namespace
 * @returns {{ namespace: string, database: string, databaseUrl: string, redisUrl: string, pgUrl: string, gatewayUrl: string }}
 */
export function v0Layout(namespace) {
  if (namespace === V0_NAMESPACE) {
    return { namespace, database: 'v0', databaseUrl: V0_DATABASE_URL, redisUrl: V0_REDIS_URL, pgUrl: V0_PG_URL, gatewayUrl: `https://v0-gateway.${namespace}.svc.cluster.local:8443` };
  }
  if (namespace === V0_BASE_NAMESPACE) {
    const databaseUrl = V0_DATABASE_URL.replace(/\/v0$/, '/v0_base');
    if (databaseUrl === V0_DATABASE_URL) throw new Error('v0 DB 주소의 DB 이름 자리를 찾지 못했다');
    return { namespace, database: 'v0_base', databaseUrl, redisUrl: `${V0_REDIS_URL}/1`, pgUrl: V0_PG_URL, gatewayUrl: `https://v0-gateway.${namespace}.svc.cluster.local:8443` };
  }
  throw new RangeError(`v0 판의 네임스페이스는 ${V0_NAMESPACE}·${V0_BASE_NAMESPACE}다: ${namespace}`);
}

/** metrics-server(CPU HPA의 지표, 2026-11-03 확인). 설치 파일 해시와 이미지 다이제스트(여러 플랫폼 목록)로 고정한다 */
export const METRICS_SERVER = {
  version: 'v0.9.1',
  installUrl: 'https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.9.1/components.yaml',
  installSha256: '3c7f57cdbee0f57fb0259a150e8f6d6cb4f29d72d1aa5dce8803151dd6d4c2a1',
  imageDigest: 'sha256:9b0ba1926e1d3089673f45461c3c1416109dea33b3ba3434048defd380df329b',
};

/**
 * metrics-server 설치 파일을 kind에 맞춘다: 이미지를 다이제스트로 바꾸고, kind 노드의 kubelet 인증서가 자체 서명이라
 * --kubelet-insecure-tls 인자를 더한다. 고칠 자리가 없으면(판이 바뀜) 던진다
 * @param {string} text
 * @returns {string}
 */
export function metricsServerInstall(text) {
  const image = 'image: registry.k8s.io/metrics-server/metrics-server:v0.9.1';
  if (!text.includes(image)) throw new Error('metrics-server 설치 파일에서 이미지 자리를 찾지 못했다(판이 바뀌었나?)');
  const arg = /^([ \t]*)- --metric-resolution=15s[ \t]*\r?$/m;
  if (!arg.test(text)) throw new Error('metrics-server 설치 파일에서 인자 자리(--metric-resolution=15s)를 찾지 못했다(판이 바뀌었나?)');
  // kind 노드의 kubelet 인증서는 자체 서명이다. 같은 인자 목록에 같은 들여쓰기로 더한다
  return text
    .replace(image, `image: registry.k8s.io/metrics-server/metrics-server@${METRICS_SERVER.imageDigest}`)
    .replace(arg, (line, indent) => `${line.replace(/\r$/, '')}\n${indent}- --kubelet-insecure-tls`);
}

/**
 * 입구 TLS용 자체 서명 인증서(EC P-256, 30일)를 만드는 openssl 인자. SAN은 localhost·127.0.0.1·입구 서비스 이름
 * (v0와 v0-base 두 네임스페이스의 'v0-gateway.<ns>.svc'·'v0-gateway.<ns>.svc.cluster.local'. 야간 비교의 두 판이 같은 인증서를 쓴다)
 * @param {string} keyFile @param {string} certFile
 * @returns {string[]}
 */
export function selfSignedCertArgs(keyFile, certFile) {
  const san = ['DNS:localhost', 'IP:127.0.0.1', 'DNS:v0-gateway'];
  for (const ns of [V0_NAMESPACE, V0_BASE_NAMESPACE]) san.push(`DNS:v0-gateway.${ns}.svc`, `DNS:v0-gateway.${ns}.svc.cluster.local`);
  return ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '30', '-subj', '/CN=v0-gateway', '-addext', `subjectAltName=${san.join(',')}`, '-keyout', keyFile, '-out', certFile];
}

/**
 * v0 Secret 셋(네임스페이스 v0): v0-monolith(앱 환경 값), v0-gateway(입구 TLS·공개키 목록), pg-simulator(시험 키).
 * 개인키는 받지 않는다(jwks에 d가 있으면 던진다). layout(기본 v0Layout('v0'))의 네임스페이스에 두고, 앱 Secret의 DB·Redis 주소는 layout의 값이다.
 * layout이 v0-base면 시뮬레이터 Secret(pg-simulator)은 만들지 않는다(시뮬레이터는 v0 네임스페이스의 하나를 쓴다)
 * @param {{ pgSecretKey: string, tlsCert: string, tlsKey: string, jwks: { keys: Array<Record<string, unknown>> } }} o
 * @param {ReturnType<typeof v0Layout>} [layout]
 * @returns {Array<{ apiVersion: 'v1', kind: 'Secret', metadata: { name: string, namespace: string }, type: 'Opaque', stringData: Record<string, string> }>}
 */
export function v0Secrets(o, layout = v0Layout(V0_NAMESPACE)) {
  if (!/^sim_sk_[A-Za-z0-9_-]{16,}$/.test(o.pgSecretKey)) throw new Error('시뮬레이터 시험 키는 sim_sk_ 뒤에 16자 이상(영문·숫자·_·-)이어야 한다');
  if (!Array.isArray(o.jwks?.keys) || o.jwks.keys.length === 0) throw new Error('공개키 목록에 키가 없다');
  // 서명 개인키는 클러스터에 두지 않는다(개인키 서버 비저장)
  if (o.jwks.keys.some((k) => k !== null && typeof k === 'object' && 'd' in k)) throw new Error('공개키 목록에 개인키(d)가 있다. 클러스터에는 공개키만 넣는다');
  /** @param {string} name @param {Record<string, string>} stringData */
  const secret = (name, stringData) => ({
    apiVersion: /** @type {'v1'} */ ('v1'),
    kind: /** @type {'Secret'} */ ('Secret'),
    metadata: { name, namespace: layout.namespace },
    type: /** @type {'Opaque'} */ ('Opaque'),
    stringData,
  });
  const out = [
    secret('v0-monolith', { PEAKET_V0_DATABASE_URL: layout.databaseUrl, PEAKET_V0_REDIS_URL: layout.redisUrl, PG_SIMULATOR_SECRET_KEY: o.pgSecretKey }),
    secret('v0-gateway', { PEAKET_V0_TLS_CERT: o.tlsCert, PEAKET_V0_TLS_KEY: o.tlsKey, PEAKET_V0_GATEWAY_JWKS: JSON.stringify(o.jwks) }),
  ];
  // 기준판(v0-base)은 v0 네임스페이스의 시뮬레이터를 함께 쓴다
  if (layout.namespace === V0_NAMESPACE) out.push(secret('pg-simulator', { PG_SIMULATOR_SECRET_KEY: o.pgSecretKey }));
  return out;
}

/**
 * 시작 전 마이그레이션 잡(같은 이미지, node scripts/migrate.mjs, DB 주소는 Secret v0-monolith). 제한 파드 보안 기준에 맞춘다.
 * namespace(기본 V0_NAMESPACE)에 만든다
 * @param {string} image
 * @param {string} [namespace]
 * @returns {Record<string, unknown>}
 */
export function v0MigrationJob(image, namespace = V0_NAMESPACE) {
  const restricted = { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } };
  const labels = { 'app.kubernetes.io/name': 'v0-migrate', 'app.kubernetes.io/part-of': 'peaket' };
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: 'v0-migrate', namespace, labels },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
          containers: [
            {
              name: 'migrate',
              image,
              imagePullPolicy: 'Never',
              command: ['node', 'scripts/migrate.mjs'],
              env: [{ name: 'PEAKET_ENV', value: 'local' }],
              // DB 주소는 Secret에서만 받는다(잡 정의에 싣지 않는다)
              envFrom: [{ secretRef: { name: 'v0-monolith' } }],
              resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { memory: '256Mi' } },
              securityContext: restricted,
            },
          ],
        },
      },
    },
  };
}

/**
 * 공용 차트로 v0 릴리스 하나를 올리는 helm 인자(release는 v0-monolith·v0-gateway, 값은 deploy/envs/local/<release>.yaml).
 * o.namespace(기본 V0_NAMESPACE)에 올린다. o.image(예: 'peaket/v0-monolith:base')를 주면 '--set image.repository=<이름>,image.tag=<태그>'를
 * 더한다(이름과 태그는 [a-z0-9./_-]와 [A-Za-z0-9._-]만, 아니면 RangeError). 네임스페이스가 v0가 아니고 release가 v0-gateway면
 * 입구가 그 네임스페이스의 앱으로 보내도록 '--set env.PEAKET_V0_UPSTREAM=http://v0-monolith.<ns>.svc.cluster.local:8080'을 더한다.
 * 인자 순서: 원래 인자(네임스페이스만 바뀜) 뒤에 image의 --set, 그 뒤에 upstream의 --set. o를 주지 않으면 지금과 같은 인자다
 * @param {string} release
 * @param {{ namespace?: string, image?: string }} [o]
 * @returns {string[]}
 */
export function v0HelmArgs(release, o = {}) {
  if (release !== 'v0-monolith' && release !== 'v0-gateway') throw new Error(`v0 릴리스는 v0-monolith·v0-gateway뿐이다: ${release}`);
  const namespace = o.namespace ?? V0_NAMESPACE;
  if (namespace !== V0_NAMESPACE && namespace !== V0_BASE_NAMESPACE) throw new RangeError(`v0 판의 네임스페이스는 ${V0_NAMESPACE}·${V0_BASE_NAMESPACE}다: ${namespace}`);
  const args = ['upgrade', '--install', release, join(REPO, 'deploy', 'charts', 'peaket-service'), '--namespace', namespace, '-f', join(REPO, 'deploy', 'envs', 'local', `${release}.yaml`), '--wait', '--timeout', '300s'];
  if (o.image !== undefined) {
    const m = typeof o.image === 'string' ? /^([a-z0-9./_-]+):([A-Za-z0-9._-]+)$/.exec(o.image) : null;
    if (!m) throw new RangeError(`이미지는 <이름>:<태그>(이름 [a-z0-9./_-], 태그 [A-Za-z0-9._-])다: ${String(o.image)}`);
    args.push('--set', `image.repository=${m[1]},image.tag=${m[2]}`);
  }
  if (namespace !== V0_NAMESPACE && release === 'v0-gateway') args.push('--set', `env.PEAKET_V0_UPSTREAM=http://v0-monolith.${namespace}.svc.cluster.local:8080`);
  return args;
}

/** 입구를 이 PC에서만 닿게 127.0.0.1에 묶은 포트 전달 인자 */
export function v0ForwardArgs(port = V0_FORWARD_PORT) {
  return ['-n', V0_NAMESPACE, 'port-forward', '--address', '127.0.0.1', 'svc/v0-gateway', `${port}:8443`];
}

/** 시험 토큰 서명 키(이 PC에만 둔다, tools/local/v0-token.mjs) */
export const V0_TOKEN_KEY_FILE = join(DEFAULT_ROOT, 'v0-token-key.json');

async function metricsServerFile() {
  const file = join(DEFAULT_ROOT, `metrics-server-${METRICS_SERVER.version}.yaml`);
  if (existsSync(file) && createHash('sha256').update(readFileSync(file)).digest('hex') === METRICS_SERVER.installSha256) return readFileSync(file, 'utf8');
  const bytes = await httpsDownload(METRICS_SERVER.installUrl);
  if (createHash('sha256').update(bytes).digest('hex') !== METRICS_SERVER.installSha256) throw new Error('metrics-server 설치 파일 해시가 맞지 않는다');
  mkdirSync(DEFAULT_ROOT, { recursive: true });
  writeFileSync(file, bytes);
  return bytes.toString('utf8');
}

/** 전용 kubeconfig로 helm을 부른다 */
async function helm(args, o = {}) {
  return run(await ensureTool('helm'), ['--kubeconfig', KUBECONFIG, ...args], o);
}

/** 잡이 끝날 때까지 본다(성공이면 돌아오고 실패면 그 로그와 함께 던진다) */
async function waitJob(namespace, name, timeoutMs = 300_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const status = JSON.parse(await kubectl(['-n', namespace, 'get', 'job', name, '-o', 'json'], { quiet: true })).status ?? {};
    if (status.succeeded >= 1) return;
    if (status.failed >= 1) {
      let logs = '';
      try {
        logs = await kubectl(['-n', namespace, 'logs', `job/${name}`, '--tail=50'], { quiet: true });
      } catch {
        // 로그가 없어도 실패는 알린다
      }
      throw new Error(`잡 ${name}이 실패했다\n${logs}`);
    }
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  throw new Error(`잡 ${name}이 ${timeoutMs / 1000}초 안에 끝나지 않았다`);
}

/** 입구 TLS 인증서(자체 서명)를 만든다. 키 파일은 임시 폴더에만 두고 바로 지운다 */
function gatewayCertificate() {
  const dir = mkdtempSync(join(tmpdir(), 'v0-gateway-tls-'));
  try {
    const keyFile = join(dir, 'tls.key');
    const certFile = join(dir, 'tls.crt');
    execFileSync('openssl', selfSignedCertArgs(keyFile, certFile), { stdio: ['ignore', 'ignore', 'pipe'] });
    return { tlsCert: readFileSync(certFile, 'utf8'), tlsKey: readFileSync(keyFile, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 기준판(v0-base)을 올린다(야간 비교, docs/devops.md §3.3). v0가 먼저 올라와 있어야 한다(TLS·공개키·시뮬레이터 키를 v0의 Secret에서 옮긴다).
 * appImage는 kind에 실린 이미지(예: peaket/v0-monolith:base)
 * @param {string} appImage
 */
export async function deployV0Base(appImage) {
  const layout = v0Layout(V0_BASE_NAMESPACE);
  const secretOf = async (name) => {
    const data = JSON.parse(await kubectl(['-n', V0_NAMESPACE, 'get', 'secret', name, '-o', 'json'], { quiet: true })).data ?? {};
    return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Buffer.from(String(v), 'base64').toString('utf8')]));
  };
  step(`기준판 ${layout.namespace}: DB ${layout.database}·Valkey DB 1·Secret`);
  const hasDb = await kubectl(['-n', 'peaket-local', 'exec', 'deploy/postgres', '--', 'psql', '-U', 'postgres', '-tAc', `select 1 from pg_database where datname = '${layout.database}'`], { quiet: true });
  if (hasDb.trim() !== '1') await kubectl(['-n', 'peaket-local', 'exec', 'deploy/postgres', '--', 'psql', '-U', 'postgres', '-c', `create database ${layout.database}`]);
  await kubectl(['apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: layout.namespace } }) });
  const gw = await secretOf('v0-gateway');
  const app = await secretOf('v0-monolith');
  const secrets = v0Secrets({ pgSecretKey: app.PG_SIMULATOR_SECRET_KEY, tlsCert: gw.PEAKET_V0_TLS_CERT, tlsKey: gw.PEAKET_V0_TLS_KEY, jwks: JSON.parse(gw.PEAKET_V0_GATEWAY_JWKS) }, layout);
  for (const secret of secrets) {
    await kubectl(['-n', layout.namespace, 'delete', 'secret', secret.metadata.name, '--ignore-not-found']);
    await kubectl(['create', '-f', '-'], { input: JSON.stringify(secret) });
  }
  step('기준판 마이그레이션 잡');
  await kubectl(['-n', layout.namespace, 'delete', 'job', 'v0-migrate', '--ignore-not-found', '--wait=true']);
  await kubectl(['create', '-f', '-'], { input: JSON.stringify(v0MigrationJob(appImage, layout.namespace)) });
  await waitJob(layout.namespace, 'v0-migrate');
  step('기준판 앱·입구');
  for (const release of ['v0-monolith', 'v0-gateway']) await helm(v0HelmArgs(release, { namespace: layout.namespace, image: appImage }));
  await kubectl(['-n', layout.namespace, 'rollout', 'restart', 'deploy/v0-monolith', 'deploy/v0-gateway']);
  for (const d of ['v0-monolith', 'v0-gateway']) await kubectl(['-n', layout.namespace, 'rollout', 'status', `deploy/${d}`, '--timeout=300s']);
}

/**
 * 새 판의 앱 이미지를 바꿔 다시 띄운다(야간 비교의 새 판을 다른 커밋·패치로 만들 때). v0가 먼저 올라와 있어야 한다
 * @param {string} appImage
 */
export async function redeployV0App(appImage) {
  step(`새 판(${V0_NAMESPACE}) 앱 이미지 ${appImage}`);
  await kubectl(['-n', V0_NAMESPACE, 'delete', 'job', 'v0-migrate', '--ignore-not-found', '--wait=true']);
  await kubectl(['create', '-f', '-'], { input: JSON.stringify(v0MigrationJob(appImage)) });
  await waitJob(V0_NAMESPACE, 'v0-migrate');
  for (const release of ['v0-monolith', 'v0-gateway']) await helm(v0HelmArgs(release, { image: appImage }));
  await kubectl(['-n', V0_NAMESPACE, 'rollout', 'restart', 'deploy/v0-monolith', 'deploy/v0-gateway']);
  for (const d of ['v0-monolith', 'v0-gateway']) await kubectl(['-n', V0_NAMESPACE, 'rollout', 'status', `deploy/${d}`, '--timeout=300s']);
}

/** kind 노드에 이미지를 싣는다 */
export async function loadImage(image) {
  await kind(['load', 'docker-image', image, '--name', CLUSTER]);
}

export async function v0() {
  step('Docker 엔진과 도구');
  run('docker', ['info', '--format', '{{.ServerVersion}}'], { quiet: true });
  for (const t of ['kind', 'kubectl', 'helm']) await ensureTool(t);
  step(`이미지 ${V0_IMAGES.app}·${V0_IMAGES.simulator}`);
  execFileSync('docker', ['build', '-f', join(REPO, 'services', 'v0-monolith', 'Dockerfile'), '-t', V0_IMAGES.app, REPO], { stdio: 'inherit' });
  execFileSync('docker', ['build', '-f', join(REPO, 'services', 'pg-simulator', 'Dockerfile'), '-t', V0_IMAGES.simulator, REPO], { stdio: 'inherit' });
  for (const img of Object.values(V0_IMAGES)) await kind(['load', 'docker-image', img, '--name', CLUSTER]);
  step(`metrics-server ${METRICS_SERVER.version}(CPU HPA의 지표)`);
  await kubectl(['apply', '--server-side', '--force-conflicts', '-f', '-'], { input: metricsServerInstall(await metricsServerFile()) });
  step('Valkey 8.1과 DB v0(peaket-local)');
  await kubectl(['apply', '-f', join(REPO, 'deploy', 'local', 'valkey.yaml')]);
  await kubectl(['-n', 'peaket-local', 'rollout', 'status', 'deploy/valkey', '--timeout=300s']);
  await kubectl(['-n', 'peaket-local', 'rollout', 'status', 'deploy/postgres', '--timeout=300s']);
  const hasDb = await kubectl(['-n', 'peaket-local', 'exec', 'deploy/postgres', '--', 'psql', '-U', 'postgres', '-tAc', "select 1 from pg_database where datname = 'v0'"], { quiet: true });
  if (hasDb.trim() !== '1') await kubectl(['-n', 'peaket-local', 'exec', 'deploy/postgres', '--', 'psql', '-U', 'postgres', '-c', 'create database v0']);
  step(`네임스페이스 ${V0_NAMESPACE}와 Secret(시험 키·입구 TLS·공개키 목록)`);
  await kubectl(['apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: V0_NAMESPACE } }) });
  // 서명 개인키는 이 PC에만 둔다. 클러스터에는 공개키 목록만 넣는다
  const { jwks } = loadOrCreateV0TokenKey(V0_TOKEN_KEY_FILE);
  const secrets = v0Secrets({ pgSecretKey: `sim_sk_${randomBytes(18).toString('hex')}`, ...gatewayCertificate(), jwks });
  for (const secret of secrets) {
    await kubectl(['-n', V0_NAMESPACE, 'delete', 'secret', secret.metadata.name, '--ignore-not-found']);
    // create는 last-applied 주석을 남기지 않는다(apply는 비밀 값을 주석에 평문으로 남긴다)
    await kubectl(['create', '-f', '-'], { input: JSON.stringify(secret) });
  }
  step('PG 시뮬레이터');
  await kubectl(['apply', '-f', join(REPO, 'deploy', 'local', 'pg-simulator.yaml')]);
  await kubectl(['-n', V0_NAMESPACE, 'rollout', 'restart', 'deploy/pg-simulator']);
  await kubectl(['-n', V0_NAMESPACE, 'rollout', 'status', 'deploy/pg-simulator', '--timeout=300s']);
  step('마이그레이션 잡(node scripts/migrate.mjs)');
  await kubectl(['-n', V0_NAMESPACE, 'delete', 'job', 'v0-migrate', '--ignore-not-found', '--wait=true']);
  await kubectl(['create', '-f', '-'], { input: JSON.stringify(v0MigrationJob(V0_IMAGES.app)) });
  await waitJob(V0_NAMESPACE, 'v0-migrate');
  step('앱 v0-monolith(CPU HPA)·입구 v0-gateway(공용 차트)');
  for (const release of ['v0-monolith', 'v0-gateway']) await helm(v0HelmArgs(release));
  // 새 Secret 값(시험 키·인증서)과 새 이미지를 읽게 다시 띄운다
  await kubectl(['-n', V0_NAMESPACE, 'rollout', 'restart', 'deploy/v0-monolith', 'deploy/v0-gateway']);
  for (const d of ['v0-monolith', 'v0-gateway']) await kubectl(['-n', V0_NAMESPACE, 'rollout', 'status', `deploy/${d}`, '--timeout=300s']);
  step('준비됨');
  console.log('입구 열기: node tools/local/cluster.mjs v0-forward (https://127.0.0.1:8443, 자체 서명 인증서)');
  console.log('시험 토큰: node tools/local/v0-token.mjs sign <계정> [pid]');
}

// --- v1 측정 무대(docs/verification.md §3.8 '합본의 v1 무대', BUILD_ORDER PRF-215, ADR-0262 결정 4) ---

/** Valkey TLS 시험 인증서(인증 기관·서버). 키 파일은 임시 폴더에만 두고 바로 지운다 */
function redisTlsCertificate() {
  const dir = mkdtempSync(join(tmpdir(), 'v1-redis-tls-'));
  try {
    for (const args of redisTlsCertArgs(dir.split(sep).join('/'))) execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    return { ca: readFileSync(join(dir, 'ca.crt'), 'utf8'), cert: readFileSync(join(dir, 'tls.crt'), 'utf8'), key: readFileSync(join(dir, 'tls.key'), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * kind 노드에서 명령 하나(경로를 Git Bash가 Windows 경로로 바꾸지 않게 MSYS_NO_PATHCONV)
 * @param {string[]} args
 */
const onKindNode = (args) => execFileSync('docker', ['exec', `${CLUSTER}-control-plane`, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MSYS_NO_PATHCONV: '1' } });

/**
 * 로컬 Docker에 있는 고정 판 이미지를 kind에 싣는다(새로 받지 않는다, 코드 리뷰). 태그의 이미지 ID가 고정 다이제스트와 같고 Docker 엔진 아키텍처(docker info)의
 * 플랫폼 매니페스트가 로컬에 있어야 한다(pinnedImagePlan). 여러 플랫폼 이미지는 그 플랫폼 하나만 묶음으로 내보내 싣고, 실은 뒤 노드의 다이제스트가 그 매니페스트인지 본다.
 * 실은 것(ID·플랫폼·매니페스트)은 무대 공개 값에 적는다(실행 도구가 infra.txt에 옮긴다)
 * @param {string} pinned <이름>:<태그>@sha256:<다이제스트>
 */
async function loadPinnedImage(pinned) {
  const tag = pinned.split('@')[0];
  const platform = dockerPlatform(run('docker', ['info', '--format', '{{.Architecture}}'], { quiet: true }));
  /** @type {string} */
  let imageId;
  /** @type {Parameters<typeof pinnedImagePlan>[0]['descriptor']} */
  let descriptor;
  try {
    imageId = run('docker', ['image', 'inspect', tag, '--format', '{{.Id}}'], { quiet: true }).trim();
    descriptor = JSON.parse(run('docker', ['image', 'inspect', '--platform', platform, tag, '--format', '{{json .Descriptor}}'], { quiet: true }));
  } catch {
    throw new Error(`로컬 Docker에 ${tag}(${platform})이 없다. 이 명령은 이미지를 받지 않는다: 먼저 docker pull ${pinned}(tools/local/README.md)`);
  }
  const plan = pinnedImagePlan({ pinned, imageId, descriptor, platform });
  const dir = mkdtempSync(join(tmpdir(), 'v1-image-'));
  try {
    const archive = join(dir, 'image.tar');
    execFileSync('docker', ['save', '--platform', platform, tag, '-o', archive], { stdio: ['ignore', 'ignore', 'pipe'] });
    await kind(['load', 'image-archive', archive, '--name', CLUSTER]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const onNode = nodeImageDigest(onKindNode(['ctr', '-n', 'k8s.io', 'images', 'ls']), tag);
  if (onNode !== plan.manifest) throw new Error(`kind 노드의 ${tag}(${onNode ?? '없음'})가 실은 매니페스트(${plan.manifest})가 아니다`);
  return plan;
}

/**
 * v1 측정 무대를 올린다(같은 클러스터에 다시 올리면 DB·Valkey·키를 새로 만든다. 측정은 새 클러스터에서 한다, docs/verification.md §3.10 공통 규칙).
 * 클러스터(up)와 관측 최소(observability)가 먼저 올라와 있어야 한다
 * @param {string[]} [argv]
 */
export async function v1(argv = []) {
  const plan = v1Plan(argv);
  const layout = v1Layout({ redisTls: plan.redisTls });
  step('Docker 엔진과 도구');
  run('docker', ['info', '--format', '{{.ServerVersion}}'], { quiet: true });
  for (const t of ['kind', 'kubectl', 'helm']) await ensureTool(t);
  if (!existsSync(KUBECONFIG)) await kind(['export', 'kubeconfig', '--name', CLUSTER, '--kubeconfig', KUBECONFIG]);
  step(`이미지 ${V1_IMAGES.bundle}·${V1_IMAGES.simulator}`);
  execFileSync('docker', ['build', '-f', join(REPO, 'services', 'bundle', 'Dockerfile'), '-t', V1_IMAGES.bundle, REPO], { stdio: 'inherit' });
  execFileSync('docker', ['build', '-f', join(REPO, 'services', 'pg-simulator', 'Dockerfile'), '-t', V1_IMAGES.simulator, REPO], { stdio: 'inherit' });
  await preloadLocalImages([...V1_PRELOAD_IMAGES, ...Object.values(V1_IMAGES)]);
  const nginx = await loadPinnedImage(V1_NGINX_IMAGE);
  step(`네임스페이스 ${V1_NAMESPACE}와 노드 폴더`);
  await kubectl(['apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: V1_NAMESPACE } }) });
  // 다시 올리면 합본·릴레이를 먼저 0개로 줄인다(DB·Valkey·키를 새로 만드는 동안 옛 키·옛 DB로 돌며 다시 시작하지 않게, 코드 리뷰)
  const scaleDown = v1ScaleDownArgs((await kubectl(['-n', V1_NAMESPACE, 'get', 'deploy', '-o', 'name'], { quiet: true })).split(/\s+/).filter(Boolean));
  if (scaleDown) {
    await kubectl(scaleDown);
    await kubectl(['-n', V1_NAMESPACE, 'wait', '--for=delete', 'pod', '-l', 'app.kubernetes.io/name in (bundle,purchase-svc,payment-svc)', '--timeout=180s'], { quiet: true }).catch((e) => {
      if (!/no matching resources/i.test(String(e.stderr ?? e.message))) throw e;
    });
  }
  for (const dir of Object.values(V1_HOST_DIRS)) onKindNode(['sh', '-c', `mkdir -p ${dir} && rm -rf ${dir}/* && chown 1000:1000 ${dir} && chmod 0755 ${dir}`]);
  const replicas = plan.replicas ?? 3;
  step(`시험 키와 Secret·무대 공개 값(Redis TLS ${plan.redisTls ? '켬' : '끔'}, 합본 복제 ${replicas})`);
  // 시험 키는 무대를 올릴 때마다 새로 만든다. 개인 성분은 Secret에만 넣는다(이 PC에 파일로 두지 않는다)
  const keys = v1Keys();
  const secrets = v1Secrets({ keys, layout, tls: redisTlsCertificate(), replicas });
  for (const secret of secrets) {
    await kubectl(['-n', V1_NAMESPACE, 'delete', 'secret', secret.metadata.name, '--ignore-not-found']);
    // create는 last-applied 주석을 남기지 않는다(apply는 비밀 값을 주석에 평문으로 남긴다)
    await kubectl(['create', '-f', '-'], { input: JSON.stringify(secret) });
  }
  // 실행 도구가 읽는 공개 값(개인 성분 없음). 실행 도구는 환경 파일 Secret을 읽지 않는다
  await kubectl(['apply', '-f', '-'], { input: JSON.stringify(v1PublicConfigMap({ keys, redisTls: plan.redisTls, replicas, nginx })) });
  step(`전용 PostgreSQL과 DB ${V1_DATABASES.purchase}·${V1_DATABASES.payment}(새로 만든다)`);
  await kubectl(['apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items: v1PostgresObjects() }) });
  // 임시 저장소라 다시 띄우면 새 비밀번호로 처음부터 만든다
  await kubectl(['-n', V1_NAMESPACE, 'rollout', 'restart', 'deploy/postgres']);
  await kubectl(['-n', V1_NAMESPACE, 'rollout', 'status', 'deploy/postgres', '--timeout=300s']);
  for (const db of Object.values(V1_DATABASES)) await kubectl(['-n', V1_NAMESPACE, 'exec', 'deploy/postgres', '--', 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', `create database ${db}`]);
  step('Valkey 둘(대기열·좌석)과 결제 시뮬레이터');
  const objs = [...v1ValkeyObjects('valkey-queue', { tls: plan.redisTls }), ...v1ValkeyObjects('valkey-seat', { tls: plan.redisTls }), ...v1SimulatorObjects()];
  await kubectl(['apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items: objs }) });
  for (const d of ['valkey-queue', 'valkey-seat', 'pg-simulator']) {
    await kubectl(['-n', V1_NAMESPACE, 'rollout', 'restart', `deploy/${d}`]);
    await kubectl(['-n', V1_NAMESPACE, 'rollout', 'status', `deploy/${d}`, '--timeout=300s']);
  }
  step(`Kafka 토픽 ${V1_KAFKA_TOPICS.length}개`);
  await kubectl(['-n', 'kafka', 'wait', 'kafka/peaket', '--for=condition=Ready', '--timeout=600s']);
  for (const topic of V1_KAFKA_TOPICS) await kubectl(kafkaTopicArgs(topic));
  step('마이그레이션 잡(purchase·payment)');
  for (const svc of /** @type {const} */ (['purchase', 'payment'])) {
    const job = v1MigrationJob(svc);
    await kubectl(['-n', V1_NAMESPACE, 'delete', 'job', job.metadata.name, '--ignore-not-found', '--wait=true']);
    await kubectl(['create', '-f', '-'], { input: JSON.stringify(job) });
    await waitJob(V1_NAMESPACE, job.metadata.name);
  }
  step('합본·릴레이(공용 차트)');
  // K7/K2 측정은 합본 CPU 4가 조건이다(BAT-031). 값 파일 기본은 CPU 1이라 CLI가 준 값을 helm --set으로 덮는다
  await helm(v1HelmArgs('v1-bundle', REPO, {
    ...(plan.replicas !== undefined ? { replicas: plan.replicas } : {}),
    ...(plan.cpus !== undefined ? { cpus: plan.cpus } : {}),
    ...(plan.memoryMi !== undefined ? { memoryMi: plan.memoryMi } : {}),
  }));
  for (const r of /** @type {const} */ (['v1-purchase-relay', 'v1-payment-relay'])) await helm(v1HelmArgs(r, REPO));
  // 새 Secret 값(키·주소)과 새 이미지를 읽게 다시 띄운다
  const deploys = ['bundle', 'purchase-svc-outbox-relay', 'payment-svc-outbox-relay'];
  await kubectl(['-n', V1_NAMESPACE, 'rollout', 'restart', ...deploys.map((d) => `deploy/${d}`)]);
  for (const d of deploys) await kubectl(['-n', V1_NAMESPACE, 'rollout', 'status', `deploy/${d}`, '--timeout=600s']);
  step('대기 상태 파일 앞 nginx 캐시');
  await kubectl(['apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items: v1StateCacheObjects() }) });
  await kubectl(['-n', V1_NAMESPACE, 'rollout', 'restart', 'deploy/queue-state-cache']);
  await kubectl(['-n', V1_NAMESPACE, 'rollout', 'status', 'deploy/queue-state-cache', '--timeout=300s']);
  step('준비됨');
  console.log(`v1 무대: 합본 ${layout.queueUrl}·${layout.purchaseUrl}, 대기 상태 캐시 ${layout.stateUrl}, Redis TLS ${plan.redisTls ? '켬' : '끔'}, 합본 복제 ${replicas}`);
  console.log("측정: node loadtest/run.mjs v1 queue|seat-hold|payment …(docs/verification.md §3.9 'v1 경로')");
}

async function v0Forward() {
  const k = await ensureTool('kubectl');
  execFileSync(k, ['--kubeconfig', KUBECONFIG, ...v0ForwardArgs()], { stdio: 'inherit' });
}

async function prometheus() {
  const k = await ensureTool('kubectl');
  execFileSync(k, ['--kubeconfig', KUBECONFIG, ...prometheusForwardArgs()], { stdio: 'inherit' });
}

async function grafana() {
  const k = await ensureTool('kubectl');
  execFileSync(k, ['--kubeconfig', KUBECONFIG, ...grafanaForwardArgs()], { stdio: 'inherit' });
}

/** v1 측정 무대를 내린다(네임스페이스 v1과 kind 노드 폴더, 코드 리뷰). 클러스터·관측·Kafka는 그대로 둔다 */
async function v1Down() {
  await kubectl(['delete', 'namespace', V1_NAMESPACE, '--ignore-not-found', '--wait=true', '--timeout=300s']);
  // 노드 폴더 둘과 그 부모(/var/local/peaket-v1)
  for (const dir of new Set(Object.values(V1_HOST_DIRS).map((d) => d.slice(0, d.lastIndexOf('/'))))) onKindNode(['sh', '-c', `rm -rf ${dir}`]);
  console.log(`v1 무대를 내렸다(네임스페이스 ${V1_NAMESPACE})`);
}

// --- 게이트웨이 다섯(docs/infra.md §4.1 'Envoy 게이트웨이의 첫 구현', BUILD_ORDER HOT-400, 묶음 BAT-055) ---

/** 시험 접속 정보 파일(개인키가 들어 있어 이 PC에만 둔다) */
export const GATEWAYS_CONTRACT_FILE = process.env.PEAKET_GATEWAYS_E2E || join(DEFAULT_ROOT, 'gateways-e2e.json');

async function gatewayInstallFile() {
  const file = join(DEFAULT_ROOT, `envoy-gateway-install-${PINNED.envoyGatewayVersion}.yaml`);
  if (existsSync(file) && createHash('sha256').update(readFileSync(file)).digest('hex') === PINNED.envoyGatewayInstallSha256) return readFileSync(file, 'utf8');
  const bytes = await httpsDownload(PINNED.envoyGatewayInstallUrl);
  if (createHash('sha256').update(bytes).digest('hex') !== PINNED.envoyGatewayInstallSha256) throw new Error('Envoy Gateway 설치 파일 해시가 맞지 않는다');
  mkdirSync(DEFAULT_ROOT, { recursive: true });
  writeFileSync(file, bytes);
  return bytes.toString('utf8');
}

/** 레이트 리밋 저장소(Valkey) TLS 시험 인증서(인증 기관·서버). v1 무대의 법(redisTlsCertArgs)에 이름만 바꾼다. 키 파일은 임시 폴더에만 두고 바로 지운다 */
function ratelimitRedisTls() {
  const dir = mkdtempSync(join(tmpdir(), 'peaket-ratelimit-redis-tls-'));
  try {
    for (const args of redisTlsCertArgs(dir.split(sep).join('/'), ratelimitRedisTlsNames())) execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    return { ca: readFileSync(join(dir, 'ca.crt'), 'utf8'), cert: readFileSync(join(dir, 'tls.crt'), 'utf8'), key: readFileSync(join(dir, 'tls.key'), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 리스너 인증서 하나(자체 서명, 게이트웨이 호스트 전부). 키 파일은 임시 폴더에만 두고 바로 지운다 */
function gatewayTls(hosts) {
  const dir = mkdtempSync(join(tmpdir(), 'peaket-gateways-tls-'));
  try {
    const keyFile = join(dir, 'tls.key');
    const certFile = join(dir, 'tls.crt');
    execFileSync('openssl', gatewayCertArgs(keyFile, certFile, hosts), { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    return { cert: readFileSync(certFile, 'utf8'), key: readFileSync(keyFile, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 정책·라우트·게이트웨이의 조건 가운데 참이 아닌 것(Accepted·Programmed·ResolvedRefs 등). 컨트롤러가 정의를 받았는지 본다 */
async function gatewayConditionProblems() {
  const kinds = ['gateways.gateway.networking.k8s.io', 'httproutes.gateway.networking.k8s.io', 'securitypolicies.gateway.envoyproxy.io', 'clienttrafficpolicies.gateway.envoyproxy.io', 'backendtrafficpolicies.gateway.envoyproxy.io', 'envoyextensionpolicies.gateway.envoyproxy.io'];
  const out = [];
  for (const k of kinds) {
    const items = JSON.parse(await kubectl(['-n', GATEWAY_NAMESPACE, 'get', k, '-o', 'json'], { quiet: true, maxBuffer: 64 * 1024 * 1024 })).items ?? [];
    for (const o of items) {
      const conds = [...(o.status?.conditions ?? []), ...(o.status?.parents ?? []).flatMap((p) => p.conditions ?? []), ...(o.status?.ancestors ?? []).flatMap((a) => a.conditions ?? [])];
      for (const c of conds) if (c.status !== 'True') out.push(`${o.kind}/${o.metadata.name}: ${c.type}=${c.status} ${c.reason}: ${c.message}`);
      if (conds.length === 0) out.push(`${o.kind}/${o.metadata.name}: 조건이 아직 없다`);
    }
  }
  return out;
}

async function gateways() {
  step('Docker 엔진과 도구');
  run('docker', ['info', '--format', '{{.ServerVersion}}'], { quiet: true });
  for (const t of ['kind', 'kubectl']) await ensureTool(t);
  await ensureCluster();
  step('게이트웨이 포트 매핑(kind 노드의 127.0.0.1 공개)');
  const ports = gatewayHostPorts(nodePortBindings());
  console.log(GATEWAY_NAMES.map((gw) => `${gw} 127.0.0.1:${ports[gw]}`).join(', '));
  await preloadLocalImages([GATEWAY_CONTROLLER_IMAGE, GATEWAY_PROXY_IMAGE, GATEWAY_ECHO_IMAGE, PINNED.envoyGatewayRatelimitImage, RATELIMIT_REDIS_IMAGE]);
  step(`Envoy Gateway ${PINNED.envoyGatewayVersion}(설치 파일 해시 고정, 컨트롤러 설정 deploy/gateways/controller/envoy-gateway.yaml: Lua 확장·전역 레이트 리밋)`);
  const controller = readFileSync(join(REPO, 'deploy', 'gateways', 'controller', 'envoy-gateway.yaml'), 'utf8');
  assertRatelimitBackend(controller);
  await kubectl(['apply', '--server-side', '--force-conflicts', '-f', '-'], { input: gatewayInstall(await gatewayInstallFile(), controller), maxBuffer: 64 * 1024 * 1024 });
  // 레이트 리밋 서비스가 뜨기 전에 카운터 저장소와 그 인증서 Secret을 둔다(컨트롤러가 첫 전역 한도 정책을 받으면 envoy-ratelimit을 만든다)
  step(`레이트 리밋 저장소 ${RATELIMIT_REDIS.name}(TLS만 받는 Valkey, 시험 인증서는 이 PC에서 새로 만든다)`);
  await kubectl(['-n', GATEWAY_NAMESPACE, 'delete', 'secret', RATELIMIT_REDIS.secret, '--ignore-not-found']);
  await kubectl(['create', '-f', '-'], { input: JSON.stringify(ratelimitRedisSecret(ratelimitRedisTls())) });
  await kubectl(['apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items: ratelimitRedisObjects() }) });
  await kubectl(['-n', GATEWAY_NAMESPACE, 'rollout', 'restart', `deploy/${RATELIMIT_REDIS.name}`]);
  await kubectl(['-n', GATEWAY_NAMESPACE, 'rollout', 'status', `deploy/${RATELIMIT_REDIS.name}`, '--timeout=300s']);
  // 설정 ConfigMap(컨트롤러 설정)을 다시 읽게 한다
  await kubectl(['-n', GATEWAY_NAMESPACE, 'rollout', 'restart', 'deploy/envoy-gateway']);
  await kubectl(['-n', GATEWAY_NAMESPACE, 'rollout', 'status', 'deploy/envoy-gateway', '--timeout=300s']);

  step('시험 키·원본 확인 값·인증서(이 PC에서 새로 만든다)');
  const defs = readGatewayObjects(join(REPO, 'deploy', 'gateways'));
  const certs = listenerCertificates(defs);
  const hosts = hostsOf(defs);
  const tls = gatewayTls([...new Set(certs.map((c) => c.host))]);
  const keys = Object.fromEntries(['fan', 'admin', 'staff', 'admission'].map((k) => [k, generateV0TokenKey()]));
  // 입장 토큰 시험 키 넷(지금 키 = keys.admission, 다음 키, 끝 시각이 남은 옛 키, 끝 시각이 지난 옛 키)과 게이트웨이 키 목록 ConfigMap(docs/infra.md §4.1 '입장 토큰 확인', BAT-057)
  const admission = admissionKeySet({ current: keys.admission.privateJwk, next: generateV0TokenKey().privateJwk, previous: generateV0TokenKey().privateJwk, expired: generateV0TokenKey().privateJwk }, Math.floor(Date.now() / 1000));
  const originVerify = randomBytes(32).toString('base64url');
  for (const o of gatewaySecrets(certs, tls, originVerify)) {
    await kubectl(['-n', GATEWAY_NAMESPACE, 'delete', 'secret', o.metadata.name, '--ignore-not-found']);
    await kubectl(['create', '-f', '-'], { input: JSON.stringify(o) });
  }
  await kubectl(['apply', '-f', '-'], { input: JSON.stringify(admissionJwksConfigMap(admissionJwks(admission))) });
  // gw-ops 허용 IP 시험 값(배포/envs/local/gateways/peaket-ops-allow.yaml, ADR-0321 결정 3). 프록시를 다시 띄울 때 환경 값으로 읽는다
  await kubectl(['apply', '-f', join(REPO, 'deploy', 'envs', 'local', 'gateways', 'peaket-ops-allow.yaml')]);
  step(`대역 백엔드 ${GATEWAY_ECHO.name}(받은 요청을 돌려주고 시험 공개키 묶음을 낸다)`);
  const script = readFileSync(join(REPO, 'tools', 'local', 'gateway-echo.mjs'), 'utf8');
  const jwks = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v.jwks]));
  await kubectl(['apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items: echoObjects({ script, jwks }) }) });
  await kubectl(['-n', GATEWAY_NAMESPACE, 'rollout', 'restart', `deploy/${GATEWAY_ECHO.name}`]);
  await kubectl(['-n', GATEWAY_NAMESPACE, 'rollout', 'status', `deploy/${GATEWAY_ECHO.name}`, '--timeout=300s']);

  step('게이트웨이 정의(deploy/gateways + 로컬 덧씌우기: 백엔드·프록시 Service·이미지만 바꿈)');
  await kubectl(['apply', '--server-side', '--force-conflicts', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items: localGatewayObjects(defs) }) });
  for (const gw of GATEWAY_NAMES) await kubectl(['-n', GATEWAY_NAMESPACE, 'wait', `gateway/${gw}`, '--for=condition=Programmed', '--timeout=300s']);
  // 원본 확인 값·공개키 묶음이 새로 생겼으므로 프록시를 다시 띄워 환경 값과 묶음을 새로 읽게 한다
  const proxies = (await kubectl(['-n', GATEWAY_NAMESPACE, 'get', 'deploy', '-l', 'app.kubernetes.io/managed-by=envoy-gateway', '-o', 'name'], { quiet: true })).split('\n').filter(Boolean);
  if (proxies.length) {
    await kubectl(['-n', GATEWAY_NAMESPACE, 'rollout', 'restart', ...proxies]);
    for (const d of proxies) await kubectl(['-n', GATEWAY_NAMESPACE, 'rollout', 'status', d, '--timeout=300s']);
  }
  // 전역 한도 정책을 받은 컨트롤러가 만든 레이트 리밋 서비스(복제 2)가 저장소에 붙어 준비되기를 기다린다
  await kubectl(['-n', GATEWAY_NAMESPACE, 'wait', `deploy/${GATEWAY_RATELIMIT.deployment}`, '--for=create', '--timeout=120s']);
  await kubectl(['-n', GATEWAY_NAMESPACE, 'rollout', 'status', `deploy/${GATEWAY_RATELIMIT.deployment}`, '--timeout=300s']);

  step('로컬 전용 NodePort Service(게이트웨이마다 하나, 노드 포트 고정)');
  const nodePortServices = [];
  for (const gw of GATEWAY_NAMES) nodePortServices.push(gatewayNodePortService(gw, await gatewayHttpsTargetPort(gw)));
  await kubectl(['apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items: nodePortServices }) });

  const contract = gatewayContract({ ports, hosts, originVerify, keys: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v.privateJwk])), caPem: tls.cert, admission });
  mkdirSync(dirname(GATEWAYS_CONTRACT_FILE), { recursive: true });
  writeFileSync(GATEWAYS_CONTRACT_FILE, `${JSON.stringify(contract, null, 2)}\n`, { mode: 0o600 });

  step('컨트롤러가 받지 않은 정의(조건이 참이 아닌 것)');
  const problems = await gatewayConditionProblems();
  console.log(problems.length ? problems.join('\n') : '없음');
  step('이 PC 포트 다섯의 TLS 손 맞잡기(60초까지)');
  await waitGatewayTls(contract);
  step('준비됨');
  console.log(`접속 정보: ${GATEWAYS_CONTRACT_FILE}`);
  console.log(`게이트웨이: ${GATEWAY_NAMES.map((gw) => `${gw} https://127.0.0.1:${ports[gw]}`).join(', ')}`);
}

/**
 * 게이트웨이 입장 토큰 키 목록을 바꾸고 gw-fan 프록시를 다시 띄운다(복구 경로 장애 주입, BAT-057 계획 §5 K13). 프록시는 환경 값을 시작 때 읽는다.
 * restore: 접속 정보의 admission 키 넷으로 처음 값을 다시 만든다. empty: 빈 묶음 {"keys":[]}. remove: ConfigMap을 지운다(optional: true라 프록시는 뜬다)
 * @param {readonly string[]} argv
 */
async function gatewaysAdmission(argv = []) {
  const mode = gatewaysAdmissionMode(argv);
  if (!existsSync(GATEWAYS_CONTRACT_FILE)) throw new Error(`게이트웨이 접속 정보가 없다: ${GATEWAYS_CONTRACT_FILE}. 먼저 node tools/local/cluster.mjs gateways`);
  const contract = JSON.parse(readFileSync(GATEWAYS_CONTRACT_FILE, 'utf8'));
  if (!contract.admission) throw new Error('접속 정보에 admission 칸이 없다: node tools/local/cluster.mjs gateways를 다시 돌린다');
  step(`입장 토큰 키 목록 ${ADMISSION_JWKS_CONFIGMAP.name}: ${mode}`);
  if (mode === 'remove') await kubectl(['-n', GATEWAY_NAMESPACE, 'delete', 'configmap', ADMISSION_JWKS_CONFIGMAP.name, '--ignore-not-found']);
  else await kubectl(['apply', '-f', '-'], { input: JSON.stringify(admissionJwksConfigMap(mode === 'empty' ? { keys: [] } : admissionJwks(contract.admission))) });
  step('gw-fan 프록시 다시 띄우기(환경 값을 새로 읽게)');
  const selector = 'gateway.envoyproxy.io/owning-gateway-name=gw-fan';
  const proxies = (await kubectl(['-n', GATEWAY_NAMESPACE, 'get', 'deploy', '-l', selector, '-o', 'name'], { quiet: true })).split('\n').filter(Boolean);
  if (proxies.length === 0) throw new Error('gw-fan 프록시 Deployment가 없다');
  const oldPods = (await kubectl(['-n', GATEWAY_NAMESPACE, 'get', 'pods', '-l', selector, '-o', 'name'], { quiet: true })).split('\n').filter(Boolean);
  await kubectl(['-n', GATEWAY_NAMESPACE, 'rollout', 'restart', ...proxies]);
  for (const d of proxies) await kubectl(['-n', GATEWAY_NAMESPACE, 'rollout', 'status', d, '--timeout=300s']);
  // 옛 파드는 연결을 비우는 동안(Terminating) 옛 환경 값으로 요청을 받는다. 다 사라진 뒤에 준비로 본다(2026-11-19 kind에서 옛 파드가 답한 것을 봤다)
  if (oldPods.length) await kubectl(['-n', GATEWAY_NAMESPACE, 'wait', '--for=delete', ...oldPods, '--timeout=300s']);
  await waitGatewayTls(contract);
  step('준비됨');
}

/** kind 노드 컨테이너의 포트 공개(docker inspect의 HostConfig.PortBindings) */
function nodePortBindings() {
  const out = execFileSync('docker', ['inspect', '--format', '{{json .HostConfig.PortBindings}}', `${CLUSTER}-control-plane`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out.trim() || 'null');
}

/** 게이트웨이 프록시 컨테이너의 HTTPS 포트: Envoy Gateway가 만든 그 게이트웨이 Service의 443 포트 targetPort(로컬 전용 NodePort Service가 그대로 쓴다) */
async function gatewayHttpsTargetPort(gw) {
  const items = JSON.parse(await kubectl(['-n', GATEWAY_NAMESPACE, 'get', 'svc', '-l', `gateway.envoyproxy.io/owning-gateway-name=${gw}`, '-o', 'json'], { quiet: true })).items ?? [];
  if (items.length !== 1) throw new Error(`${gw}의 프록시 Service를 하나로 찾지 못했다: ${items.map((o) => o.metadata.name).join(', ') || '없음'}`);
  const port = (items[0].spec?.ports ?? []).find((p) => p.port === 443);
  if (!port || port.targetPort === undefined) throw new Error(`${gw}의 프록시 Service ${items[0].metadata.name}에 443 포트가 없다`);
  return port.targetPort;
}

/** 이 PC 포트 하나에 TLS 손 맞잡기를 한 번 해 본다(SNI는 그 게이트웨이 확인 경로의 호스트, 신뢰는 접속 정보의 caPem) */
function tlsHandshake(port, servername, ca) {
  return new Promise((ok, fail) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, servername, ca });
    socket.setTimeout(5000, () => socket.destroy(new Error('5초 안에 답이 없다')));
    socket.once('secureConnect', () => {
      socket.end();
      ok();
    });
    socket.once('error', fail);
  });
}

/** 다섯 포트가 TLS 손 맞잡기를 마칠 때까지 기다린다(60초까지). 못 마친 게이트웨이와 마지막 오류를 적고 던진다 */
async function waitGatewayTls(contract, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  const left = new Map(GATEWAY_NAMES.map((gw) => [gw, '아직 시도하지 않았다']));
  for (;;) {
    for (const gw of [...left.keys()]) {
      try {
        await tlsHandshake(contract.ports[gw], contract.hosts[contract.probes[gw].host], contract.caPem);
        left.delete(gw);
        console.log(`${gw} 127.0.0.1:${contract.ports[gw]} TLS 됨`);
      } catch (e) {
        left.set(gw, e.message);
      }
    }
    if (!left.size) return;
    if (Date.now() >= deadline) throw new Error(`게이트웨이 포트가 ${timeoutMs / 1000}초 안에 TLS로 답하지 않았다: ${[...left].map(([gw, m]) => `${gw} 127.0.0.1:${contract.ports[gw]}(${m})`).join(', ')}`);
    await new Promise((ok) => setTimeout(ok, 1000));
  }
}

// --- 메시 없는 실행의 포트별 허용 NetworkPolicy(BUILD_ORDER HOT-420, D-T36, ADR-0285 결정 13, 묶음 BAT-061 계획 4.4) ---

/** 시험 접속 정보 파일(비밀 없음) */
export const MESH_NETPOL_CONTRACT_FILE = process.env.PEAKET_MESH_NETPOL_E2E || join(DEFAULT_ROOT, 'mesh-netpol-e2e.json');

async function meshNetpol() {
  step('Docker 엔진과 도구');
  run('docker', ['info', '--format', '{{.ServerVersion}}'], { quiet: true });
  for (const t of ['kind', 'kubectl']) await ensureTool(t);
  await ensureCluster();
  step(`고정 Node 이미지 ${GATEWAY_ECHO_IMAGE}(대역·시험 파드, 게이트웨이 대역 백엔드와 같은 것)`);
  if (nodeImageDigest(onKindNode(['ctr', '-n', 'k8s.io', 'images', 'ls']), GATEWAY_ECHO_IMAGE)) console.log('kind 노드에 이미 있다');
  else await preloadLocalImages([GATEWAY_ECHO_IMAGE]);
  const layout = meshNetpolLayout(readFileSync(join(REPO, MESH_NETPOL_SOURCE), 'utf8'));
  step(`네임스페이스 ${layout.namespaces.join(', ')}(없는 것만 만든다)`);
  const existing = new Set((JSON.parse(await kubectl(['get', 'namespaces', '-o', 'json'], { quiet: true })).items ?? []).map((o) => o.metadata.name));
  for (const ns of layout.namespaces) if (!existing.has(ns)) await kubectl(['create', 'namespace', ns]);
  step(`받는 쪽 대역 ${layout.workloads.length}개(워크로드마다 Deployment·Service, 모든 포트에서 연결을 받아 답하고 닫는다)`);
  await kubectl(['apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items: meshNetpolStandIns(layout, GATEWAY_ECHO_IMAGE) }) });
  step(`생성 NetworkPolicy ${MESH_NETPOL_POLICIES}(그대로 적용)`);
  await kubectl(['apply', '-f', join(REPO, MESH_NETPOL_POLICIES)]);
  step('대역이 준비되기를 기다린다');
  for (const w of layout.workloads) await kubectl(['-n', w.namespace, 'rollout', 'status', `deploy/${w.name}`, '--timeout=300s']);
  const contract = meshNetpolContract(layout, GATEWAY_ECHO_IMAGE);
  mkdirSync(dirname(MESH_NETPOL_CONTRACT_FILE), { recursive: true });
  writeFileSync(MESH_NETPOL_CONTRACT_FILE, `${JSON.stringify(contract, null, 2)}\n`);
  step('준비됨');
  console.log(`접속 정보: ${MESH_NETPOL_CONTRACT_FILE}`);
}

/**
 * Kyverno CEL 정책을 kind에 설치하고 그 환경의 정책을 적용한다(BUILD_ORDER BAS-150·BAT-085, ADR-0318).
 * 배포 값은 deploy/platform/kyverno/values.yaml(복제 3·PDB·관제 풀·이미지 다이제스트)이고, 정책은
 * deploy/policies/kyverno/envs/<환경>/policies.yaml(생성 파일)이다. e2e 시험은 이 명령 뒤에 파드를 만들어 입장을 본다.
 * kind 노드에는 운영의 관제 풀 라벨(peaket.io/pool=ops)이 없어 네 컨트롤러가 Pending이 된다. 운영 값을 그대로 두고
 * 노드에 같은 라벨을 달고 우선순위 클래스(peaket-control)를 적용해 스케줄되게 한다(BAT-085 RV-01. kind 노드는 테인트가 없어
 * toleration은 무해하다).
 * `--env demo|staging|prod`(기본 demo). 데모는 감사 모드라 위반을 기록하고, 스테이징·운영은 거부한다.
 * @param {string[]} argv
 */
export function kyvernoPlan(argv = []) {
  let env = 'demo';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--env') throw new Error(`kyverno의 모르는 인자: ${argv[i]}(쓰는 법: kyverno [--env demo|staging|prod])`);
    const value = argv[++i];
    if (!['demo', 'staging', 'prod'].includes(value)) throw new Error(`kyverno --env는 demo·staging·prod 가운데 하나다(${value})`);
    env = value;
  }
  return { env };
}

async function kyverno(argv = []) {
  const { env } = kyvernoPlan(argv);
  step('Docker 엔진과 도구');
  run('docker', ['info', '--format', '{{.ServerVersion}}'], { quiet: true });
  for (const t of ['kind', 'kubectl', 'helm']) await ensureTool(t);
  if (!existsSync(KUBECONFIG)) await kind(['export', 'kubeconfig', '--name', CLUSTER, '--kubeconfig', KUBECONFIG]);
  // 운영 values.yaml의 nodeSelector(peaket.io/pool: ops)·priorityClassName(peaket-control)을 그대로 쓰기 위해
  // kind 노드에 같은 라벨을 달고 우선순위 클래스를 적용한다(운영 값은 고치지 않는다, BAT-085 RV-01)
  step('kind 노드에 관제 풀 라벨(peaket.io/pool=ops)과 우선순위 클래스(peaket-control)');
  await kubectl(['label', 'nodes', '--all', 'peaket.io/pool=ops', '--overwrite']);
  await kubectl(['apply', '-f', join(REPO, 'deploy', 'policies', 'priority-classes.yaml')]);
  await preloadLocalImages(PINNED.kyvernoImages);
  step(`Kyverno 차트 ${PINNED.kyvernoChartVersion}(appVersion ${PINNED.kyvernoVersion}) 설치: 복제 3·PDB minAvailable 2·관제 풀·이미지 다이제스트 고정`);
  await helm(['repo', 'add', 'kyverno', PINNED.kyvernoChartRepo, '--force-update']);
  await helm(['upgrade', '--install', 'kyverno', 'kyverno/kyverno', '--version', PINNED.kyvernoChartVersion, '-n', 'kyverno', '--create-namespace', '-f', join(REPO, 'deploy', 'platform', 'kyverno', 'values.yaml'), '--wait', '--timeout', '600s']);
  await kubectl(['-n', 'kyverno', 'rollout', 'status', 'deploy/kyverno-admission-controller', '--timeout=300s']);
  step(`정책 적용: deploy/policies/kyverno/envs/${env}/policies.yaml(${env === 'demo' ? 'Audit' : 'Deny'})`);
  await kubectl(['apply', '-f', join(REPO, 'deploy', 'policies', 'kyverno', 'envs', env, 'policies.yaml')]);
  const policies = await kubectl(['get', 'imagevalidatingpolicies,validatingpolicies', '-o', 'custom-columns=KIND:.kind,NAME:.metadata.name,MODE:.spec.validationActions[*]'], { quiet: true });
  console.log(policies.trim());
  step('준비됨');
}

async function down() {
  await kind(['delete', 'cluster', '--name', CLUSTER, '--kubeconfig', KUBECONFIG]);
}

/**
 * realtime-gw를 kind에 올린다(BUILD_ORDER BAS-140, BAT-080 G5). 좌석 Redis는 로컬 Valkey(peaket-local)를 쓰고,
 * 좌석 Redis 주소와 입장 토큰 공개키 묶음(시험용 키)은 Secret v1-realtime-gw에만 넣는다(deploy/envs/local/v1-realtime-gw.yaml).
 * 이미지는 `--image <이름:태그>`나 `PEAKET_REALTIME_GW_IMAGE`로 받는다. 서비스 Dockerfile이 아직 없어 여기서 빌드하지 않는다
 * @param {string[]} [argv]
 */
async function realtimeGw(argv = []) {
  let image = process.env.PEAKET_REALTIME_GW_IMAGE || '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--image') image = argv[++i] ?? '';
    else throw new Error(`realtime-gw의 모르는 인자: ${argv[i]}(쓰는 법: realtime-gw [--image <이름:태그>])`);
  }
  if (!/^[a-z0-9./_-]+:[A-Za-z0-9._-]+$/.test(image)) throw new RangeError('realtime-gw 이미지는 <이름>:<태그>로 준다(--image나 PEAKET_REALTIME_GW_IMAGE)');
  step('Docker 엔진과 도구');
  run('docker', ['info', '--format', '{{.ServerVersion}}'], { quiet: true });
  for (const t of ['kind', 'kubectl', 'helm']) await ensureTool(t);
  if (!existsSync(KUBECONFIG)) await kind(['export', 'kubeconfig', '--name', CLUSTER, '--kubeconfig', KUBECONFIG]);
  await preloadLocalImages([image]);
  step('네임스페이스 realtime-gw·로컬 Valkey·시험용 Secret');
  await kubectl(['apply', '-f', join(REPO, 'deploy', 'local', 'valkey.yaml')]);
  await kubectl(['-n', 'peaket-local', 'rollout', 'status', 'deploy/valkey', '--timeout=300s']);
  await kubectl(['apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'realtime-gw' } }) });
  const secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'v1-realtime-gw', namespace: 'realtime-gw' },
    type: 'Opaque',
    stringData: {
      PEAKET_SEAT_REDIS_URL: 'redis://valkey.peaket-local.svc.cluster.local:6379',
      PEAKET_ADMISSION_JWKS: JSON.stringify(generateV0TokenKey().jwks),
    },
  };
  await kubectl(['-n', 'realtime-gw', 'delete', 'secret', 'v1-realtime-gw', '--ignore-not-found']);
  await kubectl(['create', '-f', '-'], { input: JSON.stringify(secret) });
  step('realtime-gw(공용 차트, deploy/envs/local/v1-realtime-gw.yaml)');
  const at = image.lastIndexOf(':');
  await helm(['upgrade', '--install', 'realtime-gw', join(REPO, 'deploy', 'charts', 'peaket-service'), '-n', 'realtime-gw', '-f', join(REPO, 'deploy', 'envs', 'local', 'v1-realtime-gw.yaml'), '--set', `image.repository=${image.slice(0, at)},image.tag=${image.slice(at + 1)}`, '--wait', '--timeout', '300s']);
  await kubectl(['-n', 'realtime-gw', 'rollout', 'status', 'deploy/realtime-gw', '--timeout=300s']);
  step('준비됨');
}

// --- BAT-087 데모 무대(서비스·앱 이미지·로컬 오버레이·기본 시드) ---

/** demo 인자: --skip-build(이미지 빌드 건너뜀), --only <쉼표 목록>(워크로드 일부만 올림), --json */
export function demoPlan(argv = []) {
  let skipBuild = false;
  let only;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--skip-build') skipBuild = true;
    else if (a === '--json') continue;
    else if (a === '--only') {
      const v = argv[++i] ?? '';
      const names = v.split(',').map((s) => s.trim()).filter(Boolean);
      if (names.length === 0) throw new Error('--only에는 워크로드 이름을 쉼표로 준다');
      only = names;
    } else throw new Error(`demo의 모르는 인자: ${a}(쓰는 법: demo [--skip-build] [--only <목록>] [--json])`);
  }
  return { skipBuild, only };
}

/** kind 노드의 포트 공개에서 demo 포트(19051·18920)를 확인한다. 매핑 없이 만든 클러스터면 다시 만들라고 멈춘다 */
function demoHostPorts() {
  const bindings = nodePortBindings();
  const check = (nodePort, hostPort, what) => {
    const b = bindings?.[`${nodePort}/tcp`];
    if (!Array.isArray(b) || b.length === 0) throw new Error(`${what}의 노드 포트 ${nodePort}가 이 PC에 공개되지 않았다: 이 클러스터는 데모 포트 매핑 없이 만들었다. \`node tools/local/cluster.mjs down\` 뒤 \`up\`으로 다시 만든다`);
    for (const x of b) if (x?.HostIp !== '127.0.0.1') throw new Error(`${what}의 노드 포트 ${nodePort}가 127.0.0.1이 아닌 주소(${x?.HostIp || '모든 주소'})에 공개되었다`);
    const got = Number(b[0].HostPort);
    if (got !== hostPort) throw new Error(`${what}의 이 PC 포트가 ${hostPort}가 아니다: ${got}`);
  };
  check(DEMO_PORTS.grpcNodePort, DEMO_PORTS.grpc, 'identity gRPC');
  check(DEMO_PORTS.idvNodePort, DEMO_PORTS.idv, '모의 기관');
  return gatewayHostPorts(bindings);
}

/** 객체 목록을 apply(목록은 List 하나) */
async function applyList(items) {
  await kubectl(['apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items }) });
}

/** Secret은 create로만 만든다(apply는 last-applied 주석에 비밀 값을 남긴다) */
async function createSecret(o) {
  await kubectl(['-n', o.metadata.namespace, 'delete', 'secret', o.metadata.name, '--ignore-not-found']);
  await kubectl(['create', '-f', '-'], { input: JSON.stringify(o) });
}

/** demo PostgreSQL에서 SQL 문 하나(이미 있으면 넘긴다) */
async function psqlDemo(statement) {
  try {
    await kubectl(['-n', 'purchase', 'exec', 'deploy/demo-postgres', '--', 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', statement]);
  } catch (e) {
    const text = String(e.stderr ?? e.message ?? '');
    if (/already exists/i.test(text)) return;
    throw new Error(`SQL 실패: ${statement}\n${text}`);
  }
}

/** 마이그레이션·부트스트랩 잡 하나를 만들고 기다린다 */
async function demoJob(o) {
  const job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: o.name, namespace: o.namespace, labels: { 'app.kubernetes.io/part-of': 'peaket-demo' } },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': o.name, 'app.kubernetes.io/part-of': 'peaket-demo' } },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
          containers: [
            {
              name: 'job',
              image: o.image,
              imagePullPolicy: 'Never',
              command: o.command,
              env: [{ name: 'PEAKET_ENV', value: 'local' }, ...(o.env ?? [])],
              ...(o.secret ? { envFrom: [{ secretRef: { name: o.secret } }] } : {}),
              resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { memory: '768Mi' } },
              securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } },
            },
          ],
        },
      },
    },
  };
  await kubectl(['-n', o.namespace, 'delete', 'job', o.name, '--ignore-not-found', '--wait=true']);
  await kubectl(['-n', o.namespace, 'create', '-f', '-'], { input: JSON.stringify(job) });
  await waitJob(o.namespace, o.name, 600_000);
}

/** demo Kafka(Strimzi)와 토픽. 이미 있으면 그대로 쓴다 */
async function demoKafka() {
  step('Kafka 3.9.1(Strimzi)와 토픽');
  await kubectl(['apply', '-f', '-'], { input: 'apiVersion: v1\nkind: Namespace\nmetadata: { name: kafka }\n' });
  await preloadLocalImages(['quay.io/strimzi/operator:0.47.0', 'quay.io/strimzi/kafka:0.47.0-kafka-3.9.1']);
  await kubectl(['apply', '--server-side', '--force-conflicts', '-n', 'kafka', '-f', '-'], { input: strimziInstall(await strimziFile(), 'kafka') });
  await kubectl(['-n', 'kafka', 'rollout', 'status', 'deploy/strimzi-cluster-operator', '--timeout=300s']);
  await kubectl(['apply', '-f', join(REPO, 'deploy', 'local', 'kafka.yaml')]);
  await kubectl(['-n', 'kafka', 'wait', 'kafka/peaket', '--for=condition=Ready', '--timeout=600s']);
  for (const topic of demoTopics()) await kubectl(kafkaTopicArgs(topic));
}

/** 게이트웨이 다섯(실제 백엔드)과 데모 접속 정보. Envoy Gateway가 없으면 설치하고, 부하 분산은 로컬 전용 NodePort로 잇는다 */
async function demoGateways() {
  step('게이트웨이 다섯(실제 백엔드, deploy/gateways의 정의)');
  await preloadLocalImages([GATEWAY_CONTROLLER_IMAGE, GATEWAY_PROXY_IMAGE, PINNED.envoyGatewayRatelimitImage, RATELIMIT_REDIS_IMAGE]);
  const controller = readFileSync(join(REPO, 'deploy', 'gateways', 'controller', 'envoy-gateway.yaml'), 'utf8');
  assertRatelimitBackend(controller);
  await kubectl(['apply', '--server-side', '--force-conflicts', '-f', '-'], { input: gatewayInstall(await gatewayInstallFile(), controller), maxBuffer: 64 * 1024 * 1024 });
  await kubectl(['-n', GATEWAY_NAMESPACE, 'delete', 'secret', RATELIMIT_REDIS.secret, '--ignore-not-found']);
  await kubectl(['create', '-f', '-'], { input: JSON.stringify(ratelimitRedisSecret(ratelimitRedisTls())) });
  await kubectl(['apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items: ratelimitRedisObjects() }) });
  await kubectl(['-n', GATEWAY_NAMESPACE, 'rollout', 'restart', `deploy/${RATELIMIT_REDIS.name}`]);
  await kubectl(['-n', GATEWAY_NAMESPACE, 'rollout', 'status', `deploy/${RATELIMIT_REDIS.name}`, '--timeout=300s']);
  await kubectl(['-n', GATEWAY_NAMESPACE, 'rollout', 'restart', 'deploy/envoy-gateway']);
  await kubectl(['-n', GATEWAY_NAMESPACE, 'rollout', 'status', 'deploy/envoy-gateway', '--timeout=300s']);

  const defs = remoteDemoGatewayObjects();
  const certs = listenerCertificates(defs);
  const tls = gatewayTls([...new Set(certs.map((c) => c.host))]);
  const keys = Object.fromEntries(['fan', 'admin', 'staff', 'admission'].map((k) => [k, generateV0TokenKey()]));
  const admission = admissionKeySet({ current: keys.admission.privateJwk, next: generateV0TokenKey().privateJwk, previous: generateV0TokenKey().privateJwk, expired: generateV0TokenKey().privateJwk }, Math.floor(Date.now() / 1000));
  const originVerify = randomBytes(32).toString('base64url');
  for (const o of gatewaySecrets(certs, tls, originVerify)) await createSecret(o);
  await kubectl(['apply', '-f', '-'], { input: JSON.stringify(admissionJwksConfigMap(admissionJwks(admission))) });
  await kubectl(['apply', '--server-side', '--force-conflicts', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items: defs }) });
  for (const gw of GATEWAY_NAMES) await kubectl(['-n', GATEWAY_NAMESPACE, 'wait', `gateway/${gw}`, '--for=condition=Programmed', '--timeout=300s']);
  const proxies = (await kubectl(['-n', GATEWAY_NAMESPACE, 'get', 'deploy', '-l', 'app.kubernetes.io/managed-by=envoy-gateway', '-o', 'name'], { quiet: true })).split('\n').filter(Boolean);
  if (proxies.length) {
    await kubectl(['-n', GATEWAY_NAMESPACE, 'rollout', 'restart', ...proxies]);
    for (const d of proxies) await kubectl(['-n', GATEWAY_NAMESPACE, 'rollout', 'status', d, '--timeout=300s']);
  }
  await kubectl(['-n', GATEWAY_NAMESPACE, 'wait', `deploy/${GATEWAY_RATELIMIT.deployment}`, '--for=create', '--timeout=120s']);
  await kubectl(['-n', GATEWAY_NAMESPACE, 'rollout', 'status', `deploy/${GATEWAY_RATELIMIT.deployment}`, '--timeout=300s']);
  for (const gw of GATEWAY_NAMES) await kubectl(['apply', '-f', '-'], { input: JSON.stringify(gatewayNodePortService(gw, await gatewayHttpsTargetPort(gw))) });

  const gwPorts = gatewayHostPorts(nodePortBindings());
  const hosts = Object.fromEntries(listenerCertificates(defs).map((c) => [c.listener, c.host]));
  const listeners = Object.fromEntries(listenerCertificates(defs).map((c) => [c.listener, c.gateway]));
  const ports = Object.fromEntries(Object.entries(listeners).map(([key, gw]) => [key, gwPorts[gw]]));
  const contract = { cluster: CLUSTER, hosts, ports, origins: demoOrigins(ports), grpcPort: DEMO_PORTS.grpc, idvPort: DEMO_PORTS.idv, caPem: tls.cert, originVerify };
  mkdirSync(dirname(DEMO_CONTRACT_FILE), { recursive: true });
  writeFileSync(DEMO_CONTRACT_FILE, `${JSON.stringify(contract, null, 2)}\n`, { mode: 0o600 });
  const deadline = Date.now() + 60_000;
  const left = new Map(Object.entries(hosts).map(([k, host]) => [k, { host, why: '아직 시도하지 않았다' }]));
  while (Date.now() < deadline && left.size) {
    for (const [key, v] of [...left]) {
      try {
        await tlsHandshake(ports[key], v.host, tls.cert);
        left.delete(key);
      } catch (e) {
        v.why = e.message;
      }
    }
    if (left.size) await new Promise((r) => setTimeout(r, 2000));
  }
  if (left.size) throw new Error(`게이트웨이 TLS 손 맞잡기가 끝나지 않았다: ${[...left].map(([k, v]) => `${k}=${v.why}`).join(', ')}`);
  const problems = await gatewayConditionProblems();
  console.log(problems.length ? problems.join('\n') : '게이트웨이 조건: 모두 참');
  console.log(`접속 정보: ${DEMO_CONTRACT_FILE}`);
  return contract;
}

/** deploy/gateways를 읽어 데모 객체로 바꾼다(demo-objects가 순수 함수로 만든다) */
function remoteDemoGatewayObjects() {
  return demoGatewayObjects(readGatewayObjects(join(REPO, 'deploy', 'gateways')));
}

/** demo 명령: 이미지 → 네임스페이스·저장소·Secret → 마이그레이션 → 차트 → 게이트웨이 → 준비 대기 */
export async function demo(argv = []) {
  const plan = demoPlan(argv);
  step('Docker 엔진과 도구');
  run('docker', ['info', '--format', '{{.ServerVersion}}'], { quiet: true });
  for (const t of ['kind', 'kubectl', 'helm']) await ensureTool(t);
  await ensureCluster();
  const gwPorts = demoHostPorts();
  const only = plan.only ? new Set(plan.only) : undefined;
  const workloads = DEMO_WORKLOADS.filter((w) => !only || only.has(w.name));

  if (!plan.skipBuild) {
    step(`이미지 ${DEMO_NEW_IMAGES.length + 3}개 빌드(${DEMO_NEW_IMAGES.map((i) => i.workload).join('·')}·bundle·ops-svc·pg-simulator)`);
    for (const i of DEMO_NEW_IMAGES) buildDemoImage(i);
    for (const [file, image] of [
      ['services/bundle/Dockerfile', DEMO_WORKLOAD_IMAGES.bundle],
      ['services/ops-svc/Dockerfile', DEMO_WORKLOAD_IMAGES['ops-svc']],
      ['services/pg-simulator/Dockerfile', DEMO_WORKLOAD_IMAGES['pg-simulator']],
    ]) {
      console.log(`\n== ${image}`);
      execFileSync('docker', ['build', '-f', join(REPO, file), '-t', image, REPO], { stdio: 'inherit' });
    }
  }
  step('이미지 미리 싣기(kind 노드)');
  await preloadLocalImages([...DEMO_NEW_IMAGES.map((i) => i.image), ...Object.values(DEMO_WORKLOAD_IMAGES), ...V1_PRELOAD_IMAGES]);

  step('네임스페이스 여섯과 Secret');
  await applyList(demoNamespaces());
  const { secrets, bootstrap } = prepareDemoSecrets();
  for (const o of demoSecrets({ keys: secrets, bootstrap })) await createSecret(o);

  step('PostgreSQL 하나(논리 DB 넷)·Valkey 하나·모의 기관·좌석맵 작업자');
  await applyList([...demoPostgresObjects(), ...demoValkeyObjects(), ...demoAppObjects(), demoGrpcNodePortService()]);
  for (const [ns, d] of [['purchase', 'demo-postgres'], ['purchase', 'demo-valkey'], ['core', 'mock-idv'], ['core', 'core-seatmap-worker']]) {
    await kubectl(['-n', ns, 'rollout', 'restart', `deploy/${d}`]);
    await kubectl(['-n', ns, 'rollout', 'status', `deploy/${d}`, '--timeout=300s']);
  }
  step(`DB ${Object.keys(DEMO_DATABASES).length}개와 로그인 사용자`);
  for (const stmt of demoDatabaseInitSql(secrets.dbPassword).split('\n')) if (stmt.trim()) await psqlDemo(stmt);
  await demoKafka();
  step('마이그레이션 잡(identity·ticket·core·ops·purchase·payment)');
  const su = `postgres://postgres:${secrets.dbPassword}@demo-postgres.purchase.svc.cluster.local:5432/${DEMO_DATABASES.core}`;
  const dbUrls = demoDatabaseUrls(secrets.dbPassword);
  await demoJob({ name: 'demo-migrate-identity', namespace: 'core', image: DEMO_WORKLOAD_IMAGES['identity-svc'], secret: 'demo-identity', command: ['node', 'scripts/migrate.mjs'] });
  await demoJob({ name: 'demo-migrate-ticket', namespace: 'ticket', image: DEMO_WORKLOAD_IMAGES['ticket-svc'], secret: 'demo-ticket', command: ['node', 'scripts/migrate.mjs'] });
  await demoJob({ name: 'demo-migrate-core', namespace: 'core', image: DEMO_WORKLOAD_IMAGES['core-svc'], env: [{ name: 'PEAKET_DATABASE_URL', value: su }], command: ['node', 'scripts/migrate.mjs'] });
  await demoJob({ name: 'demo-migrate-ops', namespace: 'core', image: DEMO_WORKLOAD_IMAGES['ops-svc'], secret: 'demo-ops', command: ['node', 'scripts/migrate.mjs'] });
  for (const svc of ['purchase', 'payment']) {
    await demoJob({
      name: `demo-migrate-${svc}`,
      namespace: 'purchase',
      image: DEMO_WORKLOAD_IMAGES.bundle,
      env: [{ name: 'PEAKET_DATABASE_URL', value: dbUrls[svc] }],
      command: ['sh', '-c', `cd "$(readlink -f node_modules/@peaket/${svc}-svc)" && exec node scripts/migrate.mjs`],
    });
  }
  for (const stmt of demoCoreRolesSqlExport(secrets.dbPassword).split('\n')) if (stmt.trim()) await psqlDemo(stmt);

  step(`워크로드 ${workloads.length}개(공용 차트, deploy/envs/local/demo)`);
  for (const w of workloads) {
    const args = ['upgrade', '--install', w.name, join(REPO, 'deploy', 'charts', 'peaket-service'), '-n', w.namespace];
    const unit = join(REPO, 'deploy', 'workloads', w.name, 'values.yaml');
    if (existsSync(unit)) args.push('-f', unit);
    args.push('-f', join(REPO, 'deploy', 'envs', 'local', 'demo', `${w.name}.yaml`), '--wait', '--timeout', '300s');
    await helm(args);
  }
  for (const w of workloads) await kubectl(['-n', w.namespace, 'rollout', 'status', `deploy/${w.name}`, '--timeout=300s']);

  await demoGateways();
  step('준비됨');
  const contract = JSON.parse(readFileSync(DEMO_CONTRACT_FILE, 'utf8'));
  const hosts = Object.entries(contract.origins).map(([k, v]) => `${k} ${v}`).join('\n  ');
  console.log(`데모 무대(${CLUSTER}):\n  ${hosts}`);
  console.log(`identity gRPC 127.0.0.1:${DEMO_PORTS.grpc}, 모의 기관 127.0.0.1:${DEMO_PORTS.idv}, kubeconfig ${KUBECONFIG}`);
  console.log('다음: node tools/local/cluster.mjs demo-seed --apply');
}

/** demo-seed 명령(--check 기본, --apply) */
export async function demoSeed(argv = []) {
  const json = argv.includes('--json');
  const apply = argv.includes('--apply');
  const check = argv.includes('--check') || !apply;
  const unknown = argv.filter((a) => !['--check', '--apply', '--json'].includes(a));
  if (unknown.length) {
    console.error(`demo-seed의 모르는 인자: ${unknown.join(', ')}`);
    process.exit(2);
  }
  if (check) {
    const result = checkSeed();
    if (json) console.log(JSON.stringify(result, null, 2));
    else if (result.ok) console.log(`시드가 맞다: ${JSON.stringify(result.counts)}`);
    else console.error(result.problems.join('\n'));
    if (!result.ok) process.exit(1);
    if (!apply) return;
  }
  const result = await applySeed();
  console.log(json ? JSON.stringify(result, null, 2) : `시드를 적용했다: ${JSON.stringify(result.counts)}`);
}

/** demoCoreRolesSql은 demo-objects의 export를 그대로 쓴다(위에서 import 이름을 줄이지 않았다) */
function demoCoreRolesSqlExport(password) {
  return demoCoreRolesSql(password);
}

/** demo 상태: 기대 워크로드와 readyReplicas를 견준다. 0건은 통과가 아니다(DS-11) */
export async function demoStatus(argv = []) {
  const json = argv.includes('--json');
  const expected = demoExpectedWorkloads();
  if (expected.length === 0) {
    if (json) console.log(JSON.stringify({ ok: false, reason: 'no-workloads' }));
    else console.error('no-workloads: 기대 워크로드 목록이 비었다');
    process.exit(1);
  }
  const missing = [];
  const rows = [];
  for (const e of expected) {
    let deploy;
    try {
      deploy = JSON.parse(await kubectl(['-n', e.namespace, 'get', 'deploy', e.name, '-o', 'json'], { quiet: true }));
    } catch {
      missing.push(`missing ${e.namespace}/${e.name}`);
      rows.push({ ...e, ready: 0, total: 0 });
      continue;
    }
    const ready = Number(deploy.status?.readyReplicas ?? 0);
    const total = Number(deploy.status?.replicas ?? 0);
    rows.push({ ...e, ready, total });
    if (ready < e.expected) missing.push(`pods-not-ready ${e.namespace}/${e.name} ready ${ready}/${e.expected}`);
  }
  if (json) console.log(JSON.stringify({ ok: missing.length === 0, workloads: rows, problems: missing }, null, 2));
  else if (missing.length === 0) console.log(`데모 워크로드 ${rows.length}개가 준비됐다`);
  else console.error(missing.join('\n'));
  process.exit(missing.length === 0 ? 0 : 1);
}

/** 데모 네임스페이스만 지운다(클러스터·다른 갈래는 그대로). 두 번 불러도 exit 0 */
export async function demoDown() {
  step(`데모 네임스페이스 ${DEMO_NAMESPACES.length}개 삭제(클러스터 ${CLUSTER}는 남긴다)`);
  for (const ns of DEMO_NAMESPACES) await kubectl(['delete', 'namespace', ns, '--ignore-not-found', '--wait=true', '--timeout=300s']);
  console.log(`데모 무대를 내렸다(네임스페이스 ${DEMO_NAMESPACES.join(', ')}). 클러스터 ${CLUSTER}는 그대로다`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  const cmds = { up, image, observability, grafana, prometheus, v0, 'v0-forward': v0Forward, v1, 'v1-down': v1Down, gateways, 'gateways-admission': gatewaysAdmission, 'mesh-netpol': meshNetpol, kyverno, 'realtime-gw': realtimeGw, demo, 'demo-seed': demoSeed, 'demo-status': demoStatus, 'demo-down': demoDown, down, status: async () => console.log(await kubectl(['get', 'pods', '-A', '-o', 'wide'])) };
  const usage = () => {
    console.error('쓰는 법: node tools/local/cluster.mjs up [--v0-only]|image|observability|grafana|prometheus|v0|v0-forward|v1 [--redis-tls on|off] [--replicas N] [--cpus N] [--memory-mi N]|v1-down|gateways|gateways-admission restore|empty|remove|mesh-netpol|kyverno [--env demo|staging|prod]|realtime-gw [--image <이름:태그>]|demo [--skip-build] [--only <목록>]|demo-seed [--check|--apply]|demo-status|demo-down|status|down');
    process.exit(2);
  };
  if (!cmds[cmd]) usage();
  const withArgs = { up: upPlan, v1: v1Plan, 'gateways-admission': gatewaysAdmissionMode, kyverno: kyvernoPlan, demo: demoPlan };
  if (withArgs[cmd]) {
    try {
      withArgs[cmd](process.argv.slice(3));
    } catch (e) {
      console.error(e.message);
      usage();
    }
  }
  await cmds[cmd](process.argv.slice(3));
}
