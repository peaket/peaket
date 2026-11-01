#!/usr/bin/env node
// 로컬·CI kind 클러스터(docs/infra.md §3 '로컬', openspec 변경 add-local-cluster-and-relay-deployment).
// 쓰는 법(저장소 뿌리에서):
//   node tools/local/cluster.mjs up      클러스터 peaket + Strimzi Kafka 3.9.1 + PostgreSQL 18 + AWS 흉내 서버(moto)
//   node tools/local/cluster.mjs image   서비스 뼈대 이미지를 만들어 클러스터에 싣는다(peaket/example-svc:local)
//   node tools/local/cluster.mjs status  파드 목록
//   node tools/local/cluster.mjs down    클러스터를 지운다
// - 도구(kind·kubectl·helm)는 tools.mjs가 고정 판으로 받는다. 사용자의 ~/.kube/config는 건드리지 않고 전용 kubeconfig를 쓴다
// - 이미지는 모두 다이제스트로 고정한다(deploy/local/*.yaml, 아래 PINNED). 계정·인증 토큰이 필요한 것은 없다
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROOT, ensureTool } from './tools.mjs';

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

async function down() {
  await kind(['delete', 'cluster', '--name', CLUSTER, '--kubeconfig', KUBECONFIG]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  const cmds = { up, image, down, status: async () => console.log(await kubectl(['get', 'pods', '-A', '-o', 'wide'])) };
  if (!cmds[cmd]) {
    console.error('쓰는 법: node tools/local/cluster.mjs up|image|status|down');
    process.exit(2);
  }
  await cmds[cmd]();
}
