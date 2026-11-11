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
//   node tools/local/cluster.mjs status  파드 목록
//   node tools/local/cluster.mjs down    클러스터를 지운다
// - 도구(kind·kubectl·helm)는 tools.mjs가 고정 판으로 받는다. 사용자의 ~/.kube/config는 건드리지 않고 전용 kubeconfig를 쓴다
// - 운영·CI 공급망은 다이제스트로 고정한다. 로컬 kind 무대는 `preloadLocalImages`가 태그 이미지를 노드에 미리 싣고 파드는 태그로 찾는다(BAT-028).
//   관측(Prometheus·Grafana) 매니페스트는 한 플랫폼(amd64) 매니페스트 다이제스트까지 고정하고, 같은 태그 이미지를 미리 실어 IfNotPresent로 찾게 한다
//   (여러 플랫폼 목록 다이제스트는 한 플랫폼만 실은 노드와 맞지 않아 Pulling에 머문다). 계정·인증 토큰이 필요한 것은 없다
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROOT, ensureTool, httpsDownload } from './tools.mjs';
import { loadOrCreateV0TokenKey } from './v0-token.mjs';
import { dockerPlatform, kafkaTopicArgs, nodeImageDigest, OBSERVABILITY_IMAGES, pinnedImagePlan, redisTlsCertArgs, V1_DATABASES, V1_HOST_DIRS, V1_IMAGES, V1_KAFKA_TOPICS, V1_NGINX_IMAGE, V1_PRELOAD_IMAGES, v1HelmArgs, v1Layout, v1MigrationJob, v1Plan, v1PostgresObjects, v1PublicConfigMap, v1ScaleDownArgs, v1Secrets, v1SimulatorObjects, v1StateCacheObjects, v1ValkeyObjects } from './v1-objects.mjs';
import { V1_NAMESPACE, v1Keys } from './v1-stage.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLUSTER = 'peaket';
export const KUBECONFIG = process.env.PEAKET_KUBECONFIG || join(DEFAULT_ROOT, 'kubeconfig-peaket');
export const IMAGE = 'peaket/example-svc:local';

/** 고정 판(2026-11-01 확인). 바꾸면 tools/local/README.md의 판 표도 고친다 */
export const PINNED = {
  // Kafka 3.9를 지원하는 마지막 Strimzi(0.48.0이 3.9.0·3.9.1을 뺐다). 운영 MSK와 같은 3.9.x를 쓰려고 고른다(docs/devops.md §9.4)
  strimziVersion: '0.47.0',
  strimziInstallUrl: 'https://github.com/strimzi/strimzi-kafka-operator/releases/download/0.47.0/strimzi-cluster-operator-0.47.0.yaml',
  strimziInstallSha256: '1eb1e72f3c20b94c8f4d54d255a5570006bd91ec5dc5d954a8a6318e9c392fa6',
  strimziOperatorDigest: 'sha256:a602b696a060a0bbb5618c3adfcb2d9021d5bb6d47d5cf01876ed0588292b84a',
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
  step(`kind 클러스터 ${CLUSTER}`);
  const clusters = (await kind(['get', 'clusters'], { quiet: true })).split(/\s+/);
  if (!clusters.includes(CLUSTER)) {
    await kind(['create', 'cluster', '--config', join(REPO, 'deploy', 'local', 'kind.yaml'), '--kubeconfig', KUBECONFIG, '--wait', '180s']);
  } else if (!existsSync(KUBECONFIG)) {
    await kind(['export', 'kubeconfig', '--name', CLUSTER, '--kubeconfig', KUBECONFIG]);
  }
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

async function image() {
  step(`이미지 ${IMAGE}`);
  execFileSync('docker', ['build', '-f', join(REPO, 'packages', 'platform', 'template', 'Dockerfile'), '-t', IMAGE, REPO], { stdio: 'inherit' });
  await preloadLocalImages([IMAGE]);
}

/**
 * 로컬 Docker 이미지를 새 kind 노드에 미리 넣는다(BAT-028 로컬 수정).
 * `kind load docker-image`는 여러 플랫폼 이미지에서 목록 다이제스트의 내용을 찾지 못해 실패할 수 있다.
 * 그래서 이 PC의 플랫폼 이미지만 `docker save --platform`으로 저장하고 `kind load image-archive`로 넣는다.
 * 로컬에 없으면 받아 온다(CI 러너처럼 처음부터 비어 있는 환경에서도 observability·v1이 서게).
 * 파드는 태그로 찾고(imagePullPolicy IfNotPresent/Never), 고정 다이제스트는 문서·공급망 확인용으로만 남긴다.
 * @param {readonly string[]} tags
 */
async function preloadLocalImages(tags) {
  const unique = [...new Set(tags)];
  step(`로컬 이미지 ${unique.length}개를 kind에 미리 싣기`);
  const platform = dockerPlatform(run('docker', ['info', '--format', '{{.Architecture}}'], { quiet: true }));
  for (const tag of unique) {
    try {
      run('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], { quiet: true });
    } catch {
      step(`로컬에 ${tag}가 없어 받는다`);
      execFileSync('docker', ['pull', '--platform', platform, tag], { stdio: 'inherit' });
    }
    const dir = mkdtempSync(join(tmpdir(), 'peaket-image-'));
    const archive = join(dir, 'image.tar');
    try {
      execFileSync('docker', ['save', '--platform', platform, tag, '-o', archive], { stdio: ['ignore', 'ignore', 'pipe'] });
      await kind(['load', 'image-archive', archive, '--name', CLUSTER]);
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

async function down() {
  await kind(['delete', 'cluster', '--name', CLUSTER, '--kubeconfig', KUBECONFIG]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  const cmds = { up, image, observability, grafana, prometheus, v0, 'v0-forward': v0Forward, v1, 'v1-down': v1Down, down, status: async () => console.log(await kubectl(['get', 'pods', '-A', '-o', 'wide'])) };
  const usage = () => {
    console.error('쓰는 법: node tools/local/cluster.mjs up [--v0-only]|image|observability|grafana|prometheus|v0|v0-forward|v1 [--redis-tls on|off] [--replicas N] [--cpus N] [--memory-mi N]|v1-down|status|down');
    process.exit(2);
  };
  if (!cmds[cmd]) usage();
  if (cmd === 'up' || cmd === 'v1') {
    try {
      (cmd === 'up' ? upPlan : v1Plan)(process.argv.slice(3));
    } catch (e) {
      console.error(e.message);
      usage();
    }
  }
  await (cmd === 'up' ? up(process.argv.slice(3)) : cmd === 'v1' ? v1(process.argv.slice(3)) : cmds[cmd]());
}
