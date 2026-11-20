#!/usr/bin/env node
// Kyverno CEL 정책 생성기(BUILD_ORDER BAS-150·BAT-085, ADR-0318, docs/devops.md §4.3).
// 쓰는 법: node tools/ci/kyverno-policies.mjs --write | --check [--root <폴더>]
//   --write  환경별 정책 파일(deploy/policies/kyverno/envs/<환경>/policies.yaml)을 쓴다. 값이 틀리면 쓰지 않는다
//   --check  쓰지 않고 다시 만든 결과와 견준다. 다르거나 값이 틀리면 1로 끝난다
//   --root   저장소 뿌리(기본은 이 파일의 두 단계 위). 시험이 임시 폴더를 가리킬 때 쓴다
// 끝 코드: 0 같음(또는 씀), 1 다름·값 오류, 2 인자 오류
// 규칙: 생성 파일은 손으로 고치지 않는다. 미해결 자리 표시(<ECR_ACCOUNT> 같은 꺾쇠), 환경 누락·중복,
//       접두사 끝의 `/` 누락, 글롭(*), 시스템 네임스페이스 혼입을 모두 거부한다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { runIfMain } from './entry.mjs';

export const SOURCE_FILE = 'deploy/policies/kyverno/policy-values.yaml';
export const ENV_ROOT = 'deploy/policies/kyverno/envs';
export const ENVS = ['demo', 'staging', 'prod'];
export const POLICY_NAMES = {
  image: 'peaket-image-admission',
  registry: 'peaket-registry-allowlist',
  pod: 'peaket-pod-baseline',
  placement: 'peaket-hotpath-placement',
};
/** 생성 객체가 다는 라벨(시험이 생성물과 손 고침을 가른다) */
export const GENERATED_BY_LABEL = 'peaket.io/generated-by';
export const GENERATED_BY = 'kyverno-policies';
/** 정책 웹훅 상한(초) [가정]. 정본 docs/devops.md §4.3·계획 BAT-085 §12 */
export const WEBHOOK_TIMEOUT_SECONDS = 15;
/** 시스템 네임스페이스. 정책 대상 목록에 들어가면 거부한다 */
export const SYSTEM_NAMESPACES = ['kube-system', 'kyverno', 'kube-node-lease', 'kube-public'];
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const IMAGE_TOKEN = /^[a-z0-9][a-z0-9._-]*$/;
/** AWS 계정 ID: 12자리 숫자. 원천에서는 읽기 쉽게 4-4-4로 적어도 된다(하이픈은 지운다) */
const ECR_ACCOUNT = /^(?:[0-9]{12}|[0-9]{4}-[0-9]{4}-[0-9]{4})$/;
const ECR_TOKEN = '{ecr}';
const REGION = /^[a-z]{2}-[a-z]+-[0-9]$/;
const REF_PREFIX = /^refs\/heads\/(release|hotfix)\/\*$/;
const REPO_PREFIX = /^[a-z0-9.-]+(\/[a-z0-9._-]+)*\/$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** 4-4-4 표기의 계정 ID를 12자리로 */
export const normalizeAccount = (account) => (typeof account === 'string' ? account.replaceAll('-', '') : account);

/** 모르는 칸이 있으면 까닭 */
function unknownKeys(obj, allowed, where) {
  return Object.keys(obj)
    .filter((k) => !allowed.includes(k))
    .map((k) => `${where}: 모르는 칸 ${k}(아는 칸 ${allowed.join('·')})`);
}

/** 글자 목록인가(비어 있으면 거부, 중복 거부) */
function stringList(value, where, { dns = false, imageToken = false } = {}) {
  const problems = [];
  if (!Array.isArray(value) || value.length === 0) return { problems: [`${where}: 비었거나 목록이 아니다`], list: [] };
  const seen = new Set();
  for (const x of value) {
    if (typeof x !== 'string' || x === '') problems.push(`${where}: 값이 비었거나 글이 아니다(${JSON.stringify(x)})`);
    else if (dns && !DNS_LABEL.test(x)) problems.push(`${where}: DNS 이름이 아니다(${x})`);
    else if (imageToken && !IMAGE_TOKEN.test(x)) problems.push(`${where}: 이미지 이름 조각이 아니다(${x})`);
    else if (seen.has(x)) problems.push(`${where}: ${x}가 두 번 있다`);
    else seen.add(x);
  }
  return { problems, list: [...new Set(value.filter((x) => typeof x === 'string'))] };
}

/**
 * 원천 값을 검사한다. 문제가 없으면 정리한 값을 돌려준다.
 * @param {any} raw policy-values.yaml을 읽은 것
 * @returns {{ problems: string[], values?: any }}
 */
export function checkValues(raw) {
  const problems = [];
  const at = (msg) => problems.push(msg);
  if (!isObject(raw)) return { problems: ['원천이 YAML 묶음(키: 값)이 아니다'] };
  for (const p of unknownKeys(raw, ['version', 'namespaces', 'demoImages', 'hotPathWorkloads', 'image', 'ecr', 'environments'], '맨 위')) at(p);
  if (raw.version !== 1) at(`version이 1이 아니다(${JSON.stringify(raw.version)})`);

  const ns = stringList(raw.namespaces, 'namespaces', { dns: true });
  problems.push(...ns.problems);
  for (const n of ns.list) if (SYSTEM_NAMESPACES.includes(n)) at(`namespaces: 시스템 네임스페이스 ${n}를 정책 대상에 넣을 수 없다(이름 목록으로 고정, kube-* 넓은 제외 금지)`);
  const demo = stringList(raw.demoImages, 'demoImages', { imageToken: true });
  problems.push(...demo.problems);
  const hot = stringList(raw.hotPathWorkloads, 'hotPathWorkloads', { dns: true });
  problems.push(...hot.problems);

  if (!isObject(raw.ecr)) at('ecr: 묶음이 아니다');
  else {
    for (const p of unknownKeys(raw.ecr, ['account', 'region'], 'ecr')) at(p);
    if (typeof raw.ecr.account !== 'string' || !ECR_ACCOUNT.test(raw.ecr.account)) at(`ecr.account: 12자리 숫자(4-4-4 표기 허용)가 아니다(${JSON.stringify(raw.ecr.account)}). 미해결 자리 표시(<ECR_ACCOUNT>)는 쓸 수 없다`);
    if (typeof raw.ecr.region !== 'string' || !REGION.test(raw.ecr.region)) at(`ecr.region: AWS 리전 꼴이 아니다(${JSON.stringify(raw.ecr.region)})`);
  }

  const image = raw.image;
  if (!isObject(image)) at('image: 묶음이 아니다');
  else {
    for (const p of unknownKeys(image, ['issuer', 'rekor', 'workflowRepository', 'workflowPath', 'workflowRefs', 'provenanceType', 'buildType', 'runnerEnvironment'], 'image')) at(p);
    for (const k of ['issuer', 'rekor', 'workflowRepository', 'workflowPath', 'provenanceType', 'buildType', 'runnerEnvironment']) {
      if (typeof image[k] !== 'string' || image[k] === '') at(`image.${k}: 비었거나 글이 아니다`);
      else if (/[<>]/.test(image[k])) at(`image.${k}: 미해결 자리 표시(<…>)가 남았다(${image[k]})`);
    }
    if (typeof image.issuer === 'string' && !/^https:\/\//.test(image.issuer)) at('image.issuer: https 주소가 아니다');
    if (typeof image.rekor === 'string' && !/^https:\/\//.test(image.rekor)) at('image.rekor: https 주소가 아니다');
    if (typeof image.workflowRepository === 'string' && !/^https:\/\/github\.com\/[a-z0-9-]+\/[a-z0-9-]+$/.test(image.workflowRepository)) at(`image.workflowRepository: https://github.com/<조직>/<저장소> 꼴이 아니다(${image.workflowRepository})`);
    if (typeof image.workflowPath === 'string' && !/^\.github\/workflows\/[a-z0-9.-]+\.ya?ml$/.test(image.workflowPath)) at(`image.workflowPath: .github/workflows/<파일>.yml 꼴이 아니다(${image.workflowPath})`);
    const refs = stringList(image.workflowRefs, 'image.workflowRefs');
    problems.push(...refs.problems);
    for (const r of refs.list) if (!REF_PREFIX.test(r)) at(`image.workflowRefs: 출시·핫픽스 refs/heads/{release,hotfix}/*만 받는다(${r})`);
    for (const r of ['refs/heads/release/*', 'refs/heads/hotfix/*']) if (!refs.list.includes(r)) at(`image.workflowRefs: ${r}가 없다`);
    if (typeof image.provenanceType === 'string' && !/^https:\/\//.test(image.provenanceType)) at('image.provenanceType: https 주소가 아니다');
    if (typeof image.buildType === 'string' && !/^https:\/\//.test(image.buildType)) at('image.buildType: https 주소가 아니다');
    if (typeof image.runnerEnvironment === 'string' && image.runnerEnvironment !== 'github-hosted') at(`image.runnerEnvironment: github-hosted만 받는다(${image.runnerEnvironment})`);
  }

  const envs = raw.environments;
  const normalized = {};
  if (!isObject(envs)) at('environments: 묶음이 아니다');
  else {
    const names = Object.keys(envs);
    for (const n of names) if (!ENVS.includes(n)) at(`environments.${n}: 모르는 환경이다(아는 환경 ${ENVS.join('·')})`);
    for (const n of ENVS) if (!names.includes(n)) at(`environments.${n}: 환경이 빠졌다`);
    for (const n of ENVS) {
      const e = envs[n];
      if (!isObject(e)) {
        at(`environments.${n}: 묶음이 아니다`);
        continue;
      }
      for (const p of unknownKeys(e, ['mode', 'failurePolicy', 'registries'], `environments.${n}`)) at(p);
      const want = n === 'demo' ? { mode: 'Audit', failurePolicy: 'Ignore' } : { mode: 'Deny', failurePolicy: 'Fail' };
      if (e.mode !== want.mode) at(`environments.${n}.mode: ${want.mode}이어야 한다(${JSON.stringify(e.mode)}). 데모는 감사, 스테이징·운영은 거부다`);
      if (e.failurePolicy !== want.failurePolicy) at(`environments.${n}.failurePolicy: ${want.failurePolicy}이어야 한다(${JSON.stringify(e.failurePolicy)})`);
      const regs = stringList(e.registries, `environments.${n}.registries`);
      problems.push(...regs.problems);
      const account = isObject(raw.ecr) ? normalizeAccount(raw.ecr.account) : '';
      const ecrPrefix = typeof raw.ecr?.region === 'string' && typeof account === 'string' && /^[0-9]{12}$/.test(account) ? `${account}.dkr.ecr.${raw.ecr.region}.amazonaws.com/` : '';
      const resolved = regs.list.map((r) => (typeof r === 'string' ? r.replaceAll(ECR_TOKEN, account ?? '') : r));
      for (const r of resolved) {
        if (/[<>]/.test(r)) at(`environments.${n}.registries: 미해결 자리 표시(<…>)가 남았다(${r})`);
        else if (/\s/.test(r)) at(`environments.${n}.registries: 공백이 있다(${JSON.stringify(r)})`);
        else if (r.includes('*')) at(`environments.${n}.registries: 글롭(*)은 쓰지 않는다(${r}). 접두사 뒤에 /를 둔다`);
        else if (!REPO_PREFIX.test(r)) at(`environments.${n}.registries: 레지스트리 접두사가 아니다(${r}). 접두사 끝에 /가 있어야 ghcr.io/peaket-evil/을 받지 않는다`);
        if (r.startsWith('http')) at(`environments.${n}.registries: 레지스트리 주소에 http(s)를 쓰지 않는다(${r})`);
      }
      if (n === 'demo') {
        if (resolved.some((r) => !r.startsWith('ghcr.io/peaket/'))) at('environments.demo.registries: ghcr.io/peaket/만 받는다');
      } else if (ecrPrefix) {
        if (resolved.some((r) => r !== ecrPrefix)) at(`environments.${n}.registries: ECR 허용 레지스트리는 ${ecrPrefix} 하나다(계정 ID 고정, D-T33 ②)`);
      }
      normalized[n] = { mode: e.mode, failurePolicy: e.failurePolicy, registries: resolved };
    }
  }
  if (problems.length) return { problems };
  return { problems: [], values: { namespaces: ns.list, demoImages: demo.list, hotPathWorkloads: hot.list, image, ecr: { ...raw.ecr, account: normalizeAccount(raw.ecr.account) }, environments: normalized } };
}

/** 정책 파일의 머리 주석 */
const header = (env) => [
  `# 생성 파일이다. 손으로 고치지 않는다(원천 ${SOURCE_FILE}에서 node tools/ci/kyverno-policies.mjs --write가 만든다, ADR-0318).`,
  `# 환경: ${env}. 모드·허용 레지스트리·데모 이미지 목록은 원천이 정한다.`,
  '# 정책 넷: peaket-image-admission(서명·출처·다이제스트), peaket-registry-allowlist(환경별 허용 레지스트리),',
  '#           peaket-pod-baseline(자원·PSS Restricted·latest·hostPath·데모 이미지·PEAKET_ENV·--disable-sigusr1),',
  '#           peaket-hotpath-placement(핫패스 온디맨드·ops-svc 관제 풀)',
  '',
].join('\n');

/** 정책 하나의 공통 metadata */
function meta(name, env) {
  return { name, labels: { [GENERATED_BY_LABEL]: GENERATED_BY, 'peaket.io/environment': env } };
}

/** 파드에 거는 정책의 matchConstraints(서비스 네임스페이스 이름 목록으로 고정) */
function podMatch(namespaces) {
  return {
    resourceRules: [{ apiGroups: [''], apiVersions: ['v1'], operations: ['CREATE', 'UPDATE'], resources: ['pods'] }],
  };
}

/**
 * 파드에 거는 정책의 matchConditions. Kyverno v1.20의 CEL 정책 CRD는 matchConditions를 matchConstraints의 칸이 아니라
 * spec 바로 아래에 둔다. matchConstraints 안에 넣으면 strict decoding이 모르는 칸이라며 정책 전체를 거부한다(BAT-085 V-01).
 * kube-* 같은 넓은 제외를 쓰지 않고 이름 목록으로 고정한다. 시스템·애드온 네임스페이스는 목록에 없다
 */
function podMatchConditions(namespaces) {
  return [{ name: 'peaket-service-namespace', expression: `object.metadata.namespace in ${celList(namespaces)}` }];
}

/** 정책 공통 모드 값 */
function common(spec, env, failurePolicy) {
  return { validationActions: [spec.mode], failurePolicy, webhookConfiguration: { timeoutSeconds: WEBHOOK_TIMEOUT_SECONDS } };
}

/** CEL 목록 글자(작은따옴표) */
const celList = (list) => `[${list.map((x) => `'${x.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`).join(', ')}]`;

/**
 * 환경 하나의 정책 넷
 * @param {any} values checkValues가 돌려준 값
 * @param {'demo'|'staging'|'prod'} env
 */
export function policiesFor(values, env) {
  const { namespaces, demoImages, hotPathWorkloads, image, environments } = values;
  const e = environments[env];
  const match = podMatch(namespaces);
  const matchConditions = podMatchConditions(namespaces);
  const identitySubjects = image.workflowRefs.map((ref) => `${image.workflowRepository}/${image.workflowPath}@${ref}`);

  const imagePolicy = {
    apiVersion: 'policies.kyverno.io/v1',
    kind: 'ImageValidatingPolicy',
    metadata: meta(POLICY_NAMES.image, env),
    spec: {
      ...common(e, env, e.failurePolicy),
      matchConstraints: match,
      matchConditions,
      // 서명·출처 검증은 이 정책이 맡고, 허용 레지스트리는 peaket-registry-allowlist가 본다(D-T33 ⑤와 분리)
      matchImageReferences: [{ glob: '*' }],
      // required: 검증을 한 번도 하지 않은 이미지를 통과시키지 않는다. verifyDigest: 태그가 아니라 다이제스트로 검증한다
      validationConfigurations: { required: true, verifyDigest: true },
      attestors: [
        {
          name: 'peaketCosign',
          cosign: {
            keyless: {
              identities: identitySubjects.map((subject) => ({ subject, issuer: image.issuer })),
            },
            ctlog: { url: image.rekor },
          },
        },
      ],
      attestations: [
        {
          name: 'peaketSlsa',
          // attestations[] 항목은 name·intoto·referrer만 받는다. 서명자는 spec.attestors에 있고 검증식이 이름으로 부른다(V-01)
          intoto: { type: image.provenanceType },
        },
      ],
      validations: [
        {
          expression: 'images.containers.map(image, verifyImageSignatures(image, [attestors.peaketCosign])).all(result, result > 0)',
          message: 'PEAKET 이미지 서명을 확인하지 못했다(출시·핫픽스 빌드만 서명한다, docs/devops.md §4.2)',
        },
        {
          expression: 'images.initContainers.map(image, verifyImageSignatures(image, [attestors.peaketCosign])).all(result, result > 0)',
          message: '초기 컨테이너 이미지의 PEAKET 서명을 확인하지 못했다',
        },
        {
          expression: 'images.ephemeralContainers.map(image, verifyImageSignatures(image, [attestors.peaketCosign])).all(result, result > 0)',
          message: '임시 컨테이너 이미지의 PEAKET 서명을 확인하지 못했다',
        },
        {
          expression: 'images.containers.map(image, verifyAttestationSignatures(image, attestations.peaketSlsa, [attestors.peaketCosign])).all(result, result > 0)',
          message: 'SLSA 출처 증명을 확인하지 못했다',
        },
        {
          expression:
            'images.containers.map(image, ' +
            `extractPayload(image, attestations.peaketSlsa).predicate.buildDefinition.buildType == '${image.buildType}' && ` +
            `extractPayload(image, attestations.peaketSlsa).predicate.buildDefinition.externalParameters.workflow.repository == '${image.workflowRepository}' && ` +
            `extractPayload(image, attestations.peaketSlsa).predicate.buildDefinition.externalParameters.workflow.path == '${image.workflowPath}' && ` +
            "(extractPayload(image, attestations.peaketSlsa).predicate.buildDefinition.externalParameters.workflow.ref.startsWith('refs/heads/release/') || " +
            "extractPayload(image, attestations.peaketSlsa).predicate.buildDefinition.externalParameters.workflow.ref.startsWith('refs/heads/hotfix/')) && " +
            "extractPayload(image, attestations.peaketSlsa).predicate.buildDefinition.internalParameters.github.runner_environment == 'github-hosted'" +
            ').all(result, result)',
          message: '출처 증명이 release/hotfix ref와 GitHub 호스트 러너를 말하지 않는다(D-T32 ③)',
        },
      ],
    },
  };

  const registryValidations = [
    {
      expression: `variables.images.all(image, ${celList(e.registries)}.exists(prefix, image.startsWith(prefix)))`,
      message: `허용 레지스트리 밖의 이미지다(${e.registries.join(', ')}, D-T33)`,
    },
  ];
  // 로컬·데모는 끌어오기 비밀 없이 공개 GHCR에서 받는다(D-T33 ①·③, docs/devops.md §5.1)
  if (env === 'demo') {
    registryValidations.push({
      expression: '!(has(object.spec.imagePullSecrets) && object.spec.imagePullSecrets.size() > 0)',
      message: '데모 오버레이는 imagePullSecrets 없이 공개 GHCR에서 받는다(D-T33 ③)',
    });
  }
  const registryPolicy = {
    apiVersion: 'policies.kyverno.io/v1',
    kind: 'ValidatingPolicy',
    metadata: meta(POLICY_NAMES.registry, env),
    spec: {
      ...common(e, env, e.failurePolicy),
      matchConstraints: match,
      matchConditions,
      variables: [
        {
          name: 'images',
          expression:
            'object.spec.containers.map(c, c.image) + ' +
            '(has(object.spec.initContainers) ? object.spec.initContainers.map(c, c.image) : []) + ' +
            '(has(object.spec.ephemeralContainers) ? object.spec.ephemeralContainers.map(c, c.image) : [])',
        },
      ],
      validations: registryValidations,
    },
  };

  const allContainers =
    'object.spec.containers + ' +
    '(has(object.spec.initContainers) ? object.spec.initContainers : []) + ' +
    '(has(object.spec.ephemeralContainers) ? object.spec.ephemeralContainers : [])';
  const command = (c) => `(has(${c}.command) ? ${c}.command : [])`;
  const args = (c) => `(has(${c}.args) ? ${c}.args : [])`;
  const nodeFilter =
    `variables.allContainers.filter(c, ` +
    `(${command('c')}.size() > 0 && (${command('c')}[0] == 'node' || ${command('c')}[0].endsWith('/node'))) || ` +
    `${args('c')}.exists(a, a == 'node' || a.endsWith('/node') || a.contains('node ')) || ` +
    `${command('c')}.exists(x, x.contains('node '))` +
    ')';
  const hasFlag =
    `(${command('c')} + ${args('c')}).exists(x, x.contains('--disable-sigusr1')) || ` +
    `(has(c.env) && c.env.exists(e, e.name == 'NODE_OPTIONS' && has(e.value) && e.value.contains('--disable-sigusr1')))`;
  const hasDebug =
    `(${command('c')} + ${args('c')}).exists(x, x.contains('--inspect') || x.contains('--no-disable-sigusr1')) || ` +
    `(has(c.env) && c.env.exists(e, e.name == 'NODE_OPTIONS' && has(e.value) && (e.value.contains('--inspect') || e.value.contains('--no-disable-sigusr1'))))`;

  const podBaseline = {
    apiVersion: 'policies.kyverno.io/v1',
    kind: 'ValidatingPolicy',
    metadata: meta(POLICY_NAMES.pod, env),
    spec: {
      ...common(e, env, e.failurePolicy),
      matchConstraints: match,
      matchConditions,
      variables: [
        { name: 'allContainers', expression: allContainers },
        { name: 'nodeContainers', expression: nodeFilter },
        { name: 'nodeContainersWithFlag', expression: `variables.nodeContainers.filter(c, ${hasFlag})` },
        { name: 'nodeContainersWithDebug', expression: `variables.nodeContainers.filter(c, ${hasDebug})` },
      ],
      validations: [
        {
          expression: 'variables.allContainers.all(c, has(c.resources) && has(c.resources.requests) && c.resources.requests.size() > 0 && has(c.resources.limits) && c.resources.limits.size() > 0)',
          message: '모든 컨테이너(초기·임시 포함)에 자원 requests와 limits가 있어야 한다(docs/devops.md §4.3)',
        },
        {
          expression:
            'variables.allContainers.all(c, ' +
            '(has(c.securityContext) && has(c.securityContext.runAsNonRoot) && c.securityContext.runAsNonRoot == true || ' +
            ' (has(object.spec.securityContext) && has(object.spec.securityContext.runAsNonRoot) && object.spec.securityContext.runAsNonRoot == true)) && ' +
            'has(c.securityContext) && has(c.securityContext.allowPrivilegeEscalation) && c.securityContext.allowPrivilegeEscalation == false && ' +
            'has(c.securityContext) && has(c.securityContext.readOnlyRootFilesystem) && c.securityContext.readOnlyRootFilesystem == true && ' +
            'has(c.securityContext) && has(c.securityContext.capabilities) && has(c.securityContext.capabilities.drop) && c.securityContext.capabilities.drop.exists(d, d == "ALL") && ' +
            '((has(c.securityContext) && has(c.securityContext.seccompProfile) && has(c.securityContext.seccompProfile.type) && c.securityContext.seccompProfile.type == "RuntimeDefault") || ' +
            ' (has(object.spec.securityContext) && has(object.spec.securityContext.seccompProfile) && object.spec.securityContext.seccompProfile.type == "RuntimeDefault"))' +
            ')',
          message: 'Pod Security Standards Restricted(비루트·읽기 전용 루트·capability drop ALL·seccomp RuntimeDefault)를 지켜야 한다',
        },
        {
          expression: "variables.allContainers.all(c, c.image.contains('@sha256:') || (c.image.contains(':') && !c.image.endsWith(':latest')))",
          message: '이미지는 다이제스트나 latest가 아닌 태그로 고정한다',
        },
        {
          expression: '!(has(object.spec.volumes) && object.spec.volumes.exists(v, has(v.hostPath)))',
          message: 'hostPath 볼륨은 쓸 수 없다',
        },
        {
          expression: `object.spec.containers.all(c, has(c.env) && c.env.exists(e, e.name == 'PEAKET_ENV' && e.value == '${env}'))`,
          message: `PEAKET_ENV를 env에 직접 두고 ${env}로 맞춘다(envFrom Secret으로 넣으면 정책이 값을 보지 못한다)`,
        },
        {
          expression: 'variables.nodeContainers.size() == variables.nodeContainersWithFlag.size()',
          message: 'Node 컨테이너는 command/args 또는 NODE_OPTIONS에 --disable-sigusr1이 있어야 한다(D-T18 ②)',
        },
        {
          expression: 'variables.nodeContainersWithDebug.size() == 0',
          message: 'Node 디버그 옵션(--inspect·--no-disable-sigusr1)은 쓸 수 없다(D-T18 ②, ASVS 13.4.2)',
        },
      ],
    },
  };
  // 데모 전용 이미지는 스테이징·운영에서 거부한다(ADR-0095). 데모 정책에는 이 검사를 넣지 않는다
  if (env !== 'demo') {
    podBaseline.spec.validations.splice(4, 0, {
      expression:
        'variables.allContainers.all(c, ' +
        celList(demoImages) +
        ".all(name, !c.image.contains('/' + name + ':') && !c.image.contains('/' + name + '@') && !c.image.startsWith(name + ':') && !c.image.startsWith(name + '@')))",
      message: '스테이징·운영에는 데모 전용 이미지(pg-simulator·identity-simulator·demo-helper·bundle·example-svc)를 쓸 수 없다(ADR-0095)',
    });
  }

  const hotpathValidation =
    '!(variables.appName in ' +
    celList(hotPathWorkloads) +
    ") || (has(object.spec.nodeSelector) && 'karpenter.sh/capacity-type' in object.spec.nodeSelector && object.spec.nodeSelector['karpenter.sh/capacity-type'] == 'on-demand')";
  const placementPolicy = {
    apiVersion: 'policies.kyverno.io/v1',
    kind: 'ValidatingPolicy',
    metadata: meta(POLICY_NAMES.placement, env),
    spec: {
      ...common(e, env, e.failurePolicy),
      matchConstraints: match,
      matchConditions,
      variables: [
        {
          name: 'appName',
          expression: "has(object.metadata.labels) && 'app.kubernetes.io/name' in object.metadata.labels ? object.metadata.labels['app.kubernetes.io/name'] : ''",
        },
      ],
      validations: [
        { expression: hotpathValidation, message: '핫패스 워크로드는 온디맨드 노드(nodeSelector karpenter.sh/capacity-type: on-demand)에 둔다(ADR-0102)' },
        {
          expression:
            "variables.appName != 'ops-svc' || " +
            "(has(object.spec.priorityClassName) && object.spec.priorityClassName == 'peaket-control' && " +
            "has(object.spec.tolerations) && object.spec.tolerations.exists(t, t.key == 'peaket.io/pool' && t.value == 'ops' && t.effect == 'NoSchedule'))",
          message: 'ops-svc는 관제 풀(peaket.io/pool=ops:NoSchedule) toleration과 priorityClassName peaket-control을 받아야 한다(ADR-0102 결정 3)',
        },
      ],
    },
  };

  return [imagePolicy, registryPolicy, podBaseline, placementPolicy];
}

/**
 * 원천 값으로 환경별 정책 파일을 만든다
 * @param {any} raw policy-values.yaml을 읽은 것
 * @returns {{ files: Map<string, string>, problems: string[] }}
 */
export function generate(raw) {
  const checked = checkValues(raw);
  if (checked.problems.length) return { files: new Map(), problems: checked.problems };
  const files = new Map();
  for (const env of ENVS) {
    const docs = policiesFor(checked.values, env);
    const body = docs.map((d) => `---\n${stringify(d, { lineWidth: 0 })}`).join('');
    files.set(`${ENV_ROOT}/${env}/policies.yaml`, header(env) + body);
  }
  return { files, problems: [] };
}

/** 첫 차이 줄(1부터) */
function firstDiff(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return { line: i + 1, disk: x[i], want: y[i] };
  return null;
}

const USAGE = '쓰는 법: node tools/ci/kyverno-policies.mjs --write | --check [--root <폴더>]';

/**
 * 저장소 뿌리에서 원천을 읽어 만든다(읽기 오류도 막음으로 돌려준다)
 * @param {string} root
 */
export function generateFromRoot(root) {
  const file = join(root, SOURCE_FILE);
  if (!existsSync(file)) return { files: new Map(), problems: [`${SOURCE_FILE}: 원천 파일이 없다`] };
  let raw;
  try {
    raw = parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { files: new Map(), problems: [`${SOURCE_FILE}: YAML을 읽지 못했다: ${e.message}`] };
  }
  return generate(raw);
}

/** @param {string[]} argv @returns {number} */
export function main(argv) {
  let mode;
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write' || a === '--check') {
      if (mode) {
        console.error(`kyverno-policies: --write와 --check는 하나만 쓴다\n${USAGE}`);
        return 2;
      }
      mode = a;
    } else if (a === '--root') {
      if (!argv[i + 1]) {
        console.error(`kyverno-policies: --root 뒤에 폴더가 없다\n${USAGE}`);
        return 2;
      }
      root = resolve(argv[++i]);
    } else {
      console.error(`kyverno-policies: 모르는 인자 ${a}\n${USAGE}`);
      return 2;
    }
  }
  if (!mode) {
    console.error(USAGE);
    return 2;
  }
  const { files, problems } = generateFromRoot(root);
  if (problems.length) {
    console.error(`kyverno-policies: 원천 값 오류 ${problems.length}건(생성 파일을 쓰지 않았다)`);
    for (const p of problems) console.error(`막음: ${p}`);
    return 1;
  }
  if (mode === '--write') {
    for (const [rel, text] of files) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    console.log(`kyverno-policies: ${files.size}개를 썼다(${[...files.keys()].join(', ')})`);
    return 0;
  }
  const diffs = [];
  for (const [rel, text] of files) {
    const file = join(root, rel);
    if (!existsSync(file)) {
      diffs.push([rel, '생성 파일이 없다(node tools/ci/kyverno-policies.mjs --write)']);
      continue;
    }
    const disk = readFileSync(file, 'utf8');
    if (disk === text) continue;
    const d = firstDiff(disk, text);
    diffs.push([rel, `다시 만든 결과와 다르다(줄 ${d?.line}: 저장소 ${JSON.stringify(d?.disk ?? '(없음)')} / 생성 ${JSON.stringify(d?.want ?? '(없음)')}). 손으로 고치지 않고 원천을 고쳐 --write로 다시 만든다`]);
  }
  if (diffs.length) {
    console.error(`kyverno-policies: 생성 대조 실패(${diffs.length}건)`);
    for (const [file, why] of diffs) console.error(`막음: ${file}: ${why}`);
    return 1;
  }
  console.log(`kyverno-policies: 생성 파일 ${files.size}개가 원천과 같다(${ENVS.join('·')})`);
  return 0;
}

await runIfMain(import.meta.url, () => main(process.argv.slice(2)));
