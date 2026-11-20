#!/usr/bin/env node
// 배포 상태(GitOps) 정적 검사(docs/devops.md §3.2 '배포 상태', §4.3, D-T28·D-T32 ③·D-T33, ADR-0319).
// 쓰는 법: node tools/ci/gitops-check.mjs --check [--root <폴더>] [--env <demo|staging|prod|local|ci>] [--image <이름>=<저장소>@sha256:<64자리>]
//   --check  검사만 한다. 문제가 있으면 1, 인자 오류는 2
//   --root   저장소 뿌리(기본은 이 파일의 두 단계 위)
//   --env    검사할 환경(기본 prod). local·ci는 데모의 허용 레지스트리(GHCR)를 쓴다
//   --image  값 파일과 별개로 확인할 이미지(여러 번 쓸 수 있다). 이름=저장소@다이제스트 꼴
// 출력: 검사마다 `ok <검사>`·`skip <검사>: <까닭>`·`fail <검사>: <까닭>` 한 줄, 마지막에 요약.
// 검사: render(최종 오버레이) · D-T28(운영 메시 필수) · D-T33(환경별 허용 레지스트리) · digest(태그 금지) · signature(서명·출처).
// Helm 렌더는 ArgoCD ApplicationSet과 같은 값 파일(환경 값 하나)로 한다(deploy/projects/applicationsets.yaml, docs/devops.md §5.2).
// 값 파일(deploy/envs/<환경>)이 아직 없으면 '아직 승격 없음'을 남기고 건너뛴다(조용한 통과가 아니다).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments } from 'yaml';
import { runIfMain } from './entry.mjs';
import { digestProblem, imageReference, verifyImage } from './supply-chain-verify.mjs';

export const WORKLOAD_VALUES_DIR = 'deploy/workloads';
export const ENV_VALUES_DIR = 'deploy/envs';
export const CHART_DIR = 'deploy/charts/peaket-service';
export const MESH_DIR = 'deploy/platform/mesh';
export const POLICY_VALUES_FILE = 'deploy/policies/kyverno/policy-values.yaml';
export const ENVS = ['local', 'ci', 'demo', 'staging', 'prod'];
/** 운영 오버레이 메시 필수 검사를 받는 환경(D-T28). local·demo는 메시 없이 돈다 */
export const MESH_ENVS = ['prod'];
/** 앰비언트 등록 라벨이 있어야 하는 네임스페이스(deploy/platform/mesh/namespaces.yaml) */
export const MESH_NAMESPACES = ['queue', 'purchase', 'ticket', 'trust', 'core', 'web', 'data', 'observability', 'ops-breakglass', 'envoy-gateway-system'];
/** 금지하는 gRPC 부하 분산 프로필(D-T28 ③) */
export const FORBIDDEN_GRPC_LB_PROFILE = 'headless-round-robin';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** YAML 파일 하나의 객체 목록(없으면 빈 목록) */
export function readYamlDocuments(root, rel) {
  const file = join(root, rel);
  if (!existsSync(file)) return { objects: [], problems: [`${rel}: 파일이 없다`] };
  try {
    const objects = [];
    for (const doc of parseAllDocuments(readFileSync(file, 'utf8'))) {
      if (doc.errors.length) return { objects: [], problems: [`${rel}: YAML을 읽지 못했다: ${doc.errors[0].message}`] };
      const value = doc.toJS();
      if (isObject(value)) objects.push(value);
    }
    return { objects, problems: [] };
  } catch (e) {
    return { objects: [], problems: [`${rel}: YAML을 읽지 못했다: ${e.message}`] };
  }
}

/** 묶음 깊은 합치기(환경 값이 배포 단위 값을 덮는다). 목록은 통째로 바꾼다 */
export function mergeValues(base, over) {
  if (!isObject(base) || !isObject(over)) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObject(v) && isObject(base[k]) ? mergeValues(base[k], v) : v;
  return out;
}

/** deploy/workloads/<이름>/values.yaml */
export function readWorkloadValues(root) {
  const dir = join(root, WORKLOAD_VALUES_DIR);
  const values = new Map();
  const problems = [];
  if (!existsSync(dir)) return { values, problems: [`${WORKLOAD_VALUES_DIR}: 폴더가 없다`] };
  for (const name of readdirSync(dir).sort(byText)) {
    const rel = `${WORKLOAD_VALUES_DIR}/${name}/values.yaml`;
    if (!existsSync(join(root, rel))) continue;
    try {
      values.set(name, parse(readFileSync(join(root, rel), 'utf8')) ?? {});
    } catch (e) {
      problems.push(`${rel}: YAML을 읽지 못했다: ${e.message}`);
    }
  }
  return { values, problems };
}

/** deploy/envs/<환경>/*.yaml(README는 읽지 않는다). 파일마다 이름·값을 돌려준다 */
export function readEnvValues(root, env) {
  const relDir = `${ENV_VALUES_DIR}/${env}`;
  const dir = join(root, relDir);
  if (!existsSync(dir)) return { files: [], problems: [] };
  const files = [];
  const problems = [];
  for (const name of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort(byText)) {
    const rel = `${relDir}/${name}`;
    try {
      const value = parse(readFileSync(join(root, rel), 'utf8')) ?? {};
      if (isObject(value)) files.push({ file: rel, name: value.name ?? name.replace(/\.ya?ml$/, ''), values: value });
    } catch (e) {
      problems.push(`${rel}: YAML을 읽지 못했다: ${e.message}`);
    }
  }
  return { files, problems };
}

/** env 값 묶음의 컨테이너 환경 변수 목록(env·service.env·outboxRelay.env) */
export function envOfValues(values) {
  const out = {};
  for (const at of ['env', 'service.env', 'outboxRelay.env']) {
    const v = at.split('.').reduce((o, k) => (isObject(o) ? o[k] : undefined), values);
    if (isObject(v)) for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x;
  }
  return out;
}

/** 환경 값 하나에서 이미지 참조를 만든다(다이제스트 우선) */
export function imageOfValues(name, values) {
  const repo = values?.image?.repository;
  if (typeof repo !== 'string' || repo === '') return undefined;
  if (values?.image?.digest) return { name, repository: repo, digest: values.image.digest, reference: `${repo}@${values.image.digest}` };
  if (values?.image?.tag) return { name, repository: repo, tag: values.image.tag, reference: `${repo}:${values.image.tag}` };
  return { name, repository: repo, reference: repo };
}

/**
 * 최종 오버레이를 읽는다. 메시 객체는 늘 읽고, 환경 값이 있으면 ArgoCD와 같은 값 파일(환경 값 하나)로 Helm 렌더한다.
 * ArgoCD ApplicationSet도 valueFiles에 `{{ .path.path }}`(deploy/envs/<환경>/<서비스>.yaml) 하나만 쓴다(docs/devops.md §5.2, RV-02).
 * 환경 값이 없으면 배포 단위 값으로 만든 가벼운 Deployment(환경 변수만)를 쓴다. Helm이 없거나 실패하면 문제로 돌려준다.
 * @param {string} root
 * @param {string} env
 * @param {{ helm?: string, run?: (cmd: string, args: string[]) => string }} [o]
 */
export function renderOverlay(root, env, o = {}) {
  const problems = [];
  const objects = [];
  for (const rel of [`${MESH_DIR}/namespaces.yaml`, `${MESH_DIR}/peer-authentication.yaml`]) {
    const r = readYamlDocuments(root, rel);
    objects.push(...r.objects);
    problems.push(...r.problems);
  }
  const workloads = readWorkloadValues(root);
  problems.push(...workloads.problems);
  const envs = readEnvValues(root, env);
  problems.push(...envs.problems);

  // 환경 값이 없더라도 배포 단위 값의 환경 변수는 본다(차트가 값을 그대로 파드 env에 넣는다).
  // 환경 값이 있으면 배포 단위 값과 합친 가벼운 Deployment도 함께 만든다(Helm이 없어도 검사할 수 있게).
  const synthesise = (name, values) => ({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, labels: { 'app.kubernetes.io/name': name, 'app.kubernetes.io/component': 'service' } },
    spec: { template: { spec: { containers: [{ name: 'app', env: Object.entries(envOfValues(values)).map(([k, v]) => ({ name: k, value: v })) }] } } },
  });
  for (const [name, values] of workloads.values) objects.push(synthesise(name, values));
  for (const e of envs.files) {
    const base = workloads.values.get(e.name);
    if (!base) {
      problems.push(`${e.file}: 배포 단위 값 ${WORKLOAD_VALUES_DIR}/${e.name}/values.yaml이 없다`);
      continue;
    }
    objects.push(synthesise(e.name, mergeValues(base, e.values)));
  }

  let helmUsed = false;
  let helmSkip;
  if (envs.files.length > 0) {
    const helm = o.helm ?? 'helm';
    const run = o.run ?? ((cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    for (const e of envs.files) {
      const base = workloads.values.get(e.name);
      if (!base) continue; // 위에서 문제로 남겼다
      const namespace = e.values.namespace ?? 'platform';
      // ArgoCD와 같은 값 파일 하나. 배포 단위 값(deploy/workloads/<서비스>/values.yaml)의 배치 값은
      // 승격 값 파일이 이미 이어받았다(tools/ci/promote-plan.mjs, RV-02). 둘을 함께 넘기면 ArgoCD가 보는 것과 달라진다
      const args = ['template', e.name, join(root, CHART_DIR), '--namespace', namespace, '-f', join(root, e.file)];
      try {
        const text = run(helm, args);
        for (const d of text.split(/^---$/m)) {
          if (!d.trim()) continue;
          const value = parse(d);
          if (isObject(value)) objects.push(value);
        }
        helmUsed = true;
      } catch (err) {
        // Helm이 없으면 합친 값으로 만든 가벼운 객체로 계속 본다(까닭을 낸다). 렌더 자체가 실패하면 문제다
        if (err?.code === 'ENOENT') helmSkip = `Helm을 찾지 못했다(${helm}). 합친 배포 값으로 검사했다`;
        else problems.push(`${e.file}: Helm 렌더가 실패했다: ${String(err.stderr ?? err.message).trim().split(/\r?\n/).at(-1) ?? '까닭 없음'}`);
      }
    }
  }

  const images = [
    ...[...envs.files].map((e) => imageOfValues(e.name, e.values)).filter(Boolean),
    ...[...workloads.values].map(([name, v]) => imageOfValues(name, v)).filter(Boolean),
  ];
  const uniqueImages = [...new Map(images.map((i) => [i.reference, i])).values()].sort((a, b) => byText(a.reference, b.reference));
  return { objects, workloads, envs: envs.files, images: uniqueImages, helmUsed, helmSkip, problems };
}

/** 정책 원천에서 환경의 허용 레지스트리를 읽는다(local·ci는 demo) */
export function registryAllowlist(root, env) {
  const policyEnv = env === 'local' || env === 'ci' ? 'demo' : env;
  const file = join(root, POLICY_VALUES_FILE);
  if (!existsSync(file)) return { registries: [], problems: [`${POLICY_VALUES_FILE}: 파일이 없다`] };
  try {
    const raw = parse(readFileSync(file, 'utf8'));
    const registries = raw?.environments?.[policyEnv]?.registries;
    if (!Array.isArray(registries) || registries.length === 0) return { registries: [], problems: [`${POLICY_VALUES_FILE}: environments.${policyEnv}.registries가 없다`] };
    const account = typeof raw?.ecr?.account === 'string' ? raw.ecr.account.replaceAll('-', '') : '';
    return { registries: registries.map((r) => (typeof r === 'string' ? r.replaceAll('{ecr}', account) : r)), problems: [] };
  } catch (e) {
    return { registries: [], problems: [`${POLICY_VALUES_FILE}: YAML을 읽지 못했다: ${e.message}`] };
  }
}

/**
 * D-T28: 운영 오버레이 메시 필수(앰비언트 라벨 값, STRICT PeerAuthentication 하나, headless-round-robin 금지).
 * prod가 아니면 검사하지 않는다(로컬·데모는 메시 없이 돈다).
 * @param {{ objects: any[], env: string }} o
 */
export function checkMeshRequired({ objects, env }) {
  if (!MESH_ENVS.includes(env)) return { checked: false, reason: `${env}는 메시 없이 돈다(운영만 검사한다)`, problems: [] };
  const problems = [];
  const namespaces = objects.filter((o) => o.kind === 'Namespace');
  for (const name of MESH_NAMESPACES) {
    const ns = namespaces.find((o) => o.metadata?.name === name);
    if (!ns) problems.push(`네임스페이스 ${name}가 오버레이에 없다`);
    else if (ns.metadata?.labels?.['istio.io/dataplane-mode'] !== 'ambient') problems.push(`네임스페이스 ${name}의 istio.io/dataplane-mode가 ambient가 아니다(${JSON.stringify(ns.metadata?.labels?.['istio.io/dataplane-mode'])})`);
  }
  const peers = objects.filter((o) => o.kind === 'PeerAuthentication');
  if (peers.length !== 1) problems.push(`PeerAuthentication이 하나가 아니다(${peers.length}개). 메시 전체 STRICT 하나만 둔다`);
  const peer = peers.find((o) => o.metadata?.namespace === 'istio-system' && o.metadata?.name === 'default');
  if (!peer) problems.push('istio-system/default PeerAuthentication이 없다');
  else {
    if (peer.spec?.mtls?.mode !== 'STRICT') problems.push(`PeerAuthentication의 mtls.mode가 STRICT가 아니다(${JSON.stringify(peer.spec?.mtls?.mode)})`);
    if (peer.spec?.selector) problems.push('PeerAuthentication에 selector(워크로드별)가 있다');
    if (peer.spec?.portLevelMtls) problems.push('PeerAuthentication에 portLevelMtls(포트별)가 있다');
  }
  for (const o of objects) {
    for (const envEntry of envsOfObjects(o)) {
      if (envEntry.name === 'PEAKET_GRPC_LB_PROFILE' && envEntry.value === FORBIDDEN_GRPC_LB_PROFILE) problems.push(`${o.kind}/${o.metadata?.name}: PEAKET_GRPC_LB_PROFILE=${FORBIDDEN_GRPC_LB_PROFILE}은 쓸 수 없다(D-T28 ③)`);
    }
  }
  return { checked: true, problems };
}

/** 객체 안의 컨테이너 env 목록(초기·임시 포함) */
function envsOfObjects(o) {
  const specs = [];
  const pod = o?.spec?.template?.spec;
  if (pod) specs.push(pod);
  if (o?.kind === 'Pod') specs.push(o.spec);
  const out = [];
  for (const s of specs) for (const key of ['containers', 'initContainers', 'ephemeralContainers']) for (const c of s?.[key] ?? []) for (const e of c?.env ?? []) if (isObject(e)) out.push(e);
  return out;
}

/**
 * D-T33: 허용 레지스트리 접두사. 접두사 뒤의 `/`까지 견준다(ghcr.io/peaket-evil/을 받지 않는다).
 * @param {Array<{ reference: string }>} images
 * @param {string[]} registries
 */
export function checkRegistry(images, registries) {
  const problems = [];
  if (registries.length === 0) problems.push('허용 레지스트리 목록이 비었다');
  for (const i of images) {
    if (!registries.some((prefix) => i.reference.startsWith(prefix))) problems.push(`${i.name}: ${i.reference}가 허용 레지스트리(${registries.join(', ')}) 밖이다(D-T33)`);
  }
  return problems;
}

/**
 * 배포 값의 이미지 다이제스트(태그 금지). 값 파일이 하나도 없으면 건너뛴다.
 * @param {Array<{ file: string, values: any }>} files
 */
export function checkDigests(files) {
  const problems = [];
  for (const { file, values } of files) {
    if (!isObject(values.image)) continue;
    if (values.image.tag) problems.push(`${file}: image.tag를 쓸 수 없다. 승격 값은 image.digest로만 고정한다(D-T32 ③)`);
    const d = digestProblem(values.image.digest);
    if (d) problems.push(`${file}: ${d}`);
    if (typeof values.image.repository !== 'string' || values.image.repository === '') problems.push(`${file}: image.repository가 없다`);
  }
  return problems;
}

/**
 * 승격 값의 서명·출처 검증(D-T32 ③). 값 파일이 없으면 부르지 않는다.
 * @param {Array<{ file: string, values: any }>} files
 * @param {{ run?: (cmd: string, args: string[]) => string }} [o]
 */
export function verifyPromotions(files, o = {}) {
  const problems = [];
  const skip = [];
  for (const { file, name, values } of files) {
    const image = imageOfValues(name, values);
    if (!image?.digest) {
      skip.push(`${file}: 이미지 다이제스트가 없어 서명 검증을 건너뛴다`);
      continue;
    }
    const r = verifyImage({ image: image.repository, digest: image.digest, run: o.run });
    for (const p of r.problems) problems.push(`${file}: ${p}`);
  }
  return { problems, skip };
}

/** `--image` 인자: 이름=저장소@다이제스트(이름은 생략할 수 있다) */
export function parseImageArg(text) {
  const eq = text.indexOf('=');
  const name = eq >= 0 ? text.slice(0, eq) : '';
  const ref = eq >= 0 ? text.slice(eq + 1) : text;
  const m = /^([a-z0-9][a-z0-9._/-]*)@(sha256:[0-9a-f]{64})$/.exec(ref);
  if (!m) return { problem: `--image는 <이름>=<저장소>@sha256:<64자리> 꼴이다(${text})` };
  return { name: name || m[1], repository: m[1], digest: m[2], reference: imageReference(m[1], m[2]) };
}

const USAGE = '쓰는 법: node tools/ci/gitops-check.mjs --check [--root <폴더>] [--env <demo|staging|prod|local|ci>] [--image <이름>=<저장소>@sha256:<64자리>]';

/** @param {string[]} argv */
export function main(argv) {
  let check = false;
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  let env = 'prod';
  const images = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') check = true;
    else if (a === '--root') {
      if (!argv[i + 1]) {
        console.error(`gitops-check: --root 뒤에 폴더가 없다\n${USAGE}`);
        return 2;
      }
      root = resolve(argv[++i]);
    } else if (a === '--env') {
      if (!argv[i + 1] || !ENVS.includes(argv[i + 1])) {
        console.error(`gitops-check: --env는 ${ENVS.join('·')} 가운데 하나다\n${USAGE}`);
        return 2;
      }
      env = argv[++i];
    } else if (a === '--image') {
      if (!argv[i + 1]) {
        console.error(`gitops-check: --image 뒤에 값이 없다\n${USAGE}`);
        return 2;
      }
      const parsed = parseImageArg(argv[++i]);
      if (parsed.problem) {
        console.error(`gitops-check: ${parsed.problem}\n${USAGE}`);
        return 2;
      }
      images.push(parsed);
    } else {
      console.error(`gitops-check: 모르는 인자 ${a}\n${USAGE}`);
      return 2;
    }
  }
  if (!check) {
    console.error(USAGE);
    return 2;
  }
  const lines = [];
  let failures = 0;
  let skips = 0;
  const ok = (name, msg) => lines.push(`ok ${name}: ${msg}`);
  const skip = (name, msg) => {
    skips++;
    lines.push(`skip ${name}: ${msg}`);
  };
  const fail = (name, problems) => {
    failures++;
    lines.push(`fail ${name}: ${problems.join(' / ')}`);
  };

  const overlay = renderOverlay(root, env);
  if (overlay.problems.length) fail('render', overlay.problems);
  else {
    ok('render', `객체 ${overlay.objects.length}개(${overlay.helmUsed ? 'Helm 렌더함' : '합친 배포 값으로 검사'})`);
    if (overlay.helmSkip) skip('render(Helm)', overlay.helmSkip);
  }

  const mesh = checkMeshRequired({ objects: overlay.objects, env });
  if (!mesh.checked) skip('D-T28', mesh.reason);
  else if (mesh.problems.length) fail('D-T28', mesh.problems);
  else ok('D-T28', '운영 오버레이의 앰비언트 라벨·STRICT PeerAuthentication·headless-round-robin 금지');

  const allow = registryAllowlist(root, env);
  const allImages = [...overlay.images, ...images];
  if (allow.problems.length) fail('D-T33', allow.problems);
  else if (allImages.length === 0) skip('D-T33', `이미지가 없다(${ENV_VALUES_DIR}/${env}에 승격 값이 아직 없다)`);
  else {
    const p = checkRegistry(allImages, allow.registries);
    if (p.length) fail('D-T33', p);
    else ok('D-T33', `이미지 ${allImages.length}개가 허용 레지스트리 안이다`);
  }

  const digestProblems = [
    ...checkDigests(overlay.envs),
    ...images.flatMap((i) => (digestProblem(i.digest) ? [`${i.name}: ${digestProblem(i.digest)}`] : [])),
  ];
  if (overlay.envs.length === 0 && images.length === 0) skip('digest', `아직 승격 없음(${ENV_VALUES_DIR}/${env} 값 파일이 없다)`);
  else if (digestProblems.length) fail('digest', digestProblems);
  else ok('digest', '배포 값의 이미지가 다이제스트로 고정됐다(태그 없음)');

  const sig = verifyPromotions(overlay.envs);
  for (const s of sig.skip) skip('signature', s);
  if (sig.problems.length) fail('signature', sig.problems);
  else if (sig.skip.length === 0 && overlay.envs.length === 0) skip('signature', `아직 승격 없음(${ENV_VALUES_DIR}/${env} 값 파일이 없다)`);
  else if (sig.skip.length === 0) ok('signature', '서명·출처 증명이 정본과 같다');

  for (const line of lines) console.log(line);
  console.log(`요약: 통과 ${lines.filter((l) => l.startsWith('ok ')).length}, 건너뜀 ${skips}, 실패 ${failures}(환경 ${env})`);
  return failures ? 1 : 0;
}

await runIfMain(import.meta.url, () => main(process.argv.slice(2)));
