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
//   node tools/local/cluster.mjs status  파드 목록
//   node tools/local/cluster.mjs down    클러스터를 지운다
// - 도구(kind·kubectl·helm)는 tools.mjs가 고정 판으로 받는다. 사용자의 ~/.kube/config는 건드리지 않고 전용 kubeconfig를 쓴다
// - 이미지는 모두 다이제스트로 고정한다(deploy/local/*.yaml, 아래 PINNED). 계정·인증 토큰이 필요한 것은 없다
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROOT, ensureTool } from './tools.mjs';
import { loadOrCreateV0TokenKey } from './v0-token.mjs';

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
 * Strimzi 설치 파일을 이 클러스터에 맞춘다: 네임스페이스, 운영자 메모리(384Mi에서 메모리 초과로 죽었다), 운영자 이미지 다이제스트.
 * 고칠 자리가 없으면(판이 바뀜) 던진다
 */
export function strimziInstall(text, namespace) {
  const image = 'image: quay.io/strimzi/operator:0.47.0';
  if (!text.includes(image)) throw new Error('Strimzi 설치 파일에서 운영자 이미지 자리를 찾지 못했다(판이 바뀌었나?)');
  if (!/memory: 384Mi/.test(text)) throw new Error('Strimzi 설치 파일에서 운영자 메모리 자리를 찾지 못했다(판이 바뀌었나?)');
  // 운영자 이미지는 운영자 자신(image:)과 그가 띄우는 엔티티 운영자·초기화 컨테이너(환경 변수 값)에 모두 있다. 모두 다이제스트로 바꾼다
  return text
    .replaceAll('namespace: myproject', `namespace: ${namespace}`)
    .replaceAll('quay.io/strimzi/operator:0.47.0', `quay.io/strimzi/operator@${PINNED.strimziOperatorDigest}`)
    .replaceAll('memory: 384Mi', 'memory: 512Mi');
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
  const r = await fetch(PINNED.strimziInstallUrl, { redirect: 'follow' });
  if (!r.ok) throw new Error(`Strimzi 설치 파일 받기 실패: HTTP ${r.status}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== PINNED.strimziInstallSha256) throw new Error('Strimzi 설치 파일 해시가 맞지 않는다');
  mkdirSync(DEFAULT_ROOT, { recursive: true });
  writeFileSync(file, bytes);
  return bytes.toString('utf8');
}

const step = (msg) => console.log(`\n== ${msg}`);

async function up() {
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
  await kubectl(['apply', '-f', '-'], { input: 'apiVersion: v1\nkind: Namespace\nmetadata: { name: kafka }\n---\napiVersion: v1\nkind: Namespace\nmetadata: { name: peaket-local }\n' });
  step(`Strimzi ${PINNED.strimziVersion} 운영자`);
  await kubectl(['apply', '--server-side', '--force-conflicts', '-n', 'kafka', '-f', '-'], { input: strimziInstall(await strimziFile(), 'kafka') });
  await kubectl(['-n', 'kafka', 'rollout', 'status', 'deploy/strimzi-cluster-operator', '--timeout=300s']);
  step('Kafka 3.9.1(KRaft 하나), PostgreSQL 18, AWS 흉내 서버');
  for (const f of ['kafka.yaml', 'postgres.yaml', 'aws.yaml']) await kubectl(['apply', '-f', join(REPO, 'deploy', 'local', f)]);
  await kubectl(['-n', 'peaket-local', 'rollout', 'status', 'deploy/postgres', '--timeout=300s']);
  await kubectl(['-n', 'peaket-local', 'rollout', 'status', 'deploy/aws', '--timeout=300s']);
  await kubectl(['-n', 'kafka', 'wait', 'kafka/peaket', '--for=condition=Ready', '--timeout=600s']);
  step('준비됨');
  console.log(`kubeconfig: ${KUBECONFIG}`);
}

async function image() {
  step(`이미지 ${IMAGE}`);
  execFileSync('docker', ['build', '-f', join(REPO, 'packages', 'platform', 'template', 'Dockerfile'), '-t', IMAGE, REPO], { stdio: 'inherit' });
  await kind(['load', 'docker-image', IMAGE, '--name', CLUSTER]);
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
 * @param {string} keyFile @param {string} certFile
 * @returns {string[]}
 */
export function selfSignedCertArgs(keyFile, certFile) {
  const san = ['DNS:localhost', 'IP:127.0.0.1', 'DNS:v0-gateway', `DNS:v0-gateway.${V0_NAMESPACE}.svc`, `DNS:v0-gateway.${V0_NAMESPACE}.svc.cluster.local`];
  return ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '30', '-subj', '/CN=v0-gateway', '-addext', `subjectAltName=${san.join(',')}`, '-keyout', keyFile, '-out', certFile];
}

/**
 * v0 Secret 셋(네임스페이스 v0): v0-monolith(앱 환경 값), v0-gateway(입구 TLS·공개키 목록), pg-simulator(시험 키).
 * 개인키는 받지 않는다(jwks에 d가 있으면 던진다)
 * @param {{ pgSecretKey: string, tlsCert: string, tlsKey: string, jwks: { keys: Array<Record<string, unknown>> } }} o
 * @returns {Array<{ apiVersion: 'v1', kind: 'Secret', metadata: { name: string, namespace: string }, type: 'Opaque', stringData: Record<string, string> }>}
 */
export function v0Secrets(o) {
  if (!/^sim_sk_[A-Za-z0-9_-]{16,}$/.test(o.pgSecretKey)) throw new Error('시뮬레이터 시험 키는 sim_sk_ 뒤에 16자 이상(영문·숫자·_·-)이어야 한다');
  if (!Array.isArray(o.jwks?.keys) || o.jwks.keys.length === 0) throw new Error('공개키 목록에 키가 없다');
  // 서명 개인키는 클러스터에 두지 않는다(개인키 서버 비저장)
  if (o.jwks.keys.some((k) => k !== null && typeof k === 'object' && 'd' in k)) throw new Error('공개키 목록에 개인키(d)가 있다. 클러스터에는 공개키만 넣는다');
  /** @param {string} name @param {Record<string, string>} stringData */
  const secret = (name, stringData) => ({
    apiVersion: /** @type {'v1'} */ ('v1'),
    kind: /** @type {'Secret'} */ ('Secret'),
    metadata: { name, namespace: V0_NAMESPACE },
    type: /** @type {'Opaque'} */ ('Opaque'),
    stringData,
  });
  return [
    secret('v0-monolith', { PEAKET_V0_DATABASE_URL: V0_DATABASE_URL, PEAKET_V0_REDIS_URL: V0_REDIS_URL, PG_SIMULATOR_SECRET_KEY: o.pgSecretKey }),
    secret('v0-gateway', { PEAKET_V0_TLS_CERT: o.tlsCert, PEAKET_V0_TLS_KEY: o.tlsKey, PEAKET_V0_GATEWAY_JWKS: JSON.stringify(o.jwks) }),
    secret('pg-simulator', { PG_SIMULATOR_SECRET_KEY: o.pgSecretKey }),
  ];
}

/**
 * 시작 전 마이그레이션 잡(같은 이미지, node scripts/migrate.mjs, DB 주소는 Secret v0-monolith). 제한 파드 보안 기준에 맞춘다
 * @param {string} image
 * @returns {Record<string, unknown>}
 */
export function v0MigrationJob(image) {
  const restricted = { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } };
  const labels = { 'app.kubernetes.io/name': 'v0-migrate', 'app.kubernetes.io/part-of': 'peaket' };
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: 'v0-migrate', namespace: V0_NAMESPACE, labels },
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
 * 공용 차트로 v0 릴리스 하나를 올리는 helm 인자(release는 v0-monolith·v0-gateway, 값은 deploy/envs/local/<release>.yaml)
 * @param {string} release
 * @returns {string[]}
 */
export function v0HelmArgs(release) {
  if (release !== 'v0-monolith' && release !== 'v0-gateway') throw new Error(`v0 릴리스는 v0-monolith·v0-gateway뿐이다: ${release}`);
  return ['upgrade', '--install', release, join(REPO, 'deploy', 'charts', 'peaket-service'), '--namespace', V0_NAMESPACE, '-f', join(REPO, 'deploy', 'envs', 'local', `${release}.yaml`), '--wait', '--timeout', '300s'];
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
  const r = await fetch(METRICS_SERVER.installUrl, { redirect: 'follow' });
  if (!r.ok) throw new Error(`metrics-server 설치 파일 받기 실패: HTTP ${r.status}`);
  const bytes = Buffer.from(await r.arrayBuffer());
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

async function v0() {
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

async function down() {
  await kind(['delete', 'cluster', '--name', CLUSTER, '--kubeconfig', KUBECONFIG]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  const cmds = { up, image, observability, grafana, prometheus, v0, 'v0-forward': v0Forward, down, status: async () => console.log(await kubectl(['get', 'pods', '-A', '-o', 'wide'])) };
  if (!cmds[cmd]) {
    console.error('쓰는 법: node tools/local/cluster.mjs up|image|observability|grafana|prometheus|v0|v0-forward|status|down');
    process.exit(2);
  }
  await cmds[cmd]();
}
