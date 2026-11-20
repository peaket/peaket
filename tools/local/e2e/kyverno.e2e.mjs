// Kyverno CEL 입장 정책의 kind 시험(D-T11 ②·D-T18 ②·D-T33 ①·②와 오프라인 검증 PoC, BUILD_ORDER BAS-150·BAT-085, ADR-0318).
// 차례: `node tools/local/cluster.mjs kyverno --env demo`가 Kyverno 3.10.0(appVersion v1.20.0)과 데모 정책(감사)을 올린 뒤
//       `node --test --test-timeout=900000 tools/local/e2e/kyverno.e2e.mjs`를 돈다.
// - D-T11 ②: 로컬 레지스트리(HTTP)에 시험 이미지를 밀고 테스트 키로 서명한다. 서명한 이미지만 입장하고,
//   서명 없음·다른 키·초기 컨테이너 서명 없음은 거부된다(까닭이 admission 오류에 남는다).
// - D-T18 ②: 스테이징 파드 기준(Deny) 사본을 임시 이름으로 걸고 Node 플래그 유무·`sh -c "node …"`·비-Node를 본다.
// - D-T33 ①: 데모 정책(감사)이 허용 GHCR 이미지를 막지 않는다.
// - D-T33 ②: 운영 레지스트리 정책(Deny) 사본이 GHCR·다른 계정 ECR을 거부하고 PEAKET ECR은 통과시킨다.
// - 오프라인 PoC: Kyverno admission의 egress를 로컬 레지스트리·DNS만 남기고 막은 뒤 같은 다이제스트와 새 다이제스트를 다시 띄워
//   결과를 docs/review/measurements/BAT-085-offline-verify.md에 적는다(시험이 아니라 측정이다. 통과/실패를 단언하지 않는다).
// 테스트 서명 키는 임시 폴더에 만들고 지운다(저장소에 비밀 키를 두지 않는다). 정책 이름은 임시 사본에만 -e2e를 붙인다.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import { CLUSTER, kubectl } from '../cluster.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const NS = 'queue';
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const E2E_LABEL = { 'peaket.io/kyverno-e2e': 'true' };
const E2E_POLICY = 'peaket-image-admission-e2e';
const E2E_BASELINE = 'peaket-pod-baseline-e2e';
const E2E_REGISTRY = 'peaket-registry-allowlist-e2e';
const LOCAL_PREFIX = 'peaket-registry.default:5000/peaket-e2e/';
const REGISTRY_CONTAINER = `peaket-kyverno-registry-${RUN}`;
const REGISTRY_SERVICE = 'peaket-registry';
const HOST_REGISTRY = '127.0.0.1:5001';
const COSIGN_IMAGE = 'ghcr.io/sigstore/cosign/cosign:v2.4.1';
const REGISTRY_IMAGE = 'registry:2.8.3';
const BUSYBOX_IMAGE = 'busybox:1.36';
const POD_IMAGE = 'registry.k8s.io/pause:3.10';
const DIGEST = `sha256:${'d'.repeat(64)}`;
const ECR = '000000000000.dkr.ecr.ap-northeast-2.amazonaws.com/';
const TIMEOUT = 120_000;
const kc = (args, o = {}) => kubectl(args, { timeout: TIMEOUT, quiet: true, ...o });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (args, o = {}) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000, ...o });

let keyDir;
let registryNetwork;
let registryIp;
let signedImage;
let unsignedImage;
let wrongKeyImage;
let publicKey;
let createdNamespace = false;

/** 파드 기준(PSS Restricted·자원·PEAKET_ENV)을 채운 시험 파드. command/args/env만 사례마다 바꾼다 */
function pod(name, o) {
  const env = [{ name: 'PEAKET_ENV', value: o.env ?? 'demo' }, ...(o.envs ?? [])];
  const container = {
    name: 'app',
    image: o.image ?? `${POD_IMAGE}`,
    command: o.command ?? ['node', 'dist/main.js'],
    ...(o.args ? { args: o.args } : {}),
    env,
    resources: { requests: { cpu: '10m', memory: '16Mi' }, limits: { memory: '32Mi' } },
    securityContext: {
      runAsNonRoot: true,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
      seccompProfile: { type: 'RuntimeDefault' },
    },
  };
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: NS, labels: E2E_LABEL },
    spec: {
      restartPolicy: 'Never',
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [container],
      ...(o.initContainers ? { initContainers: o.initContainers } : {}),
    },
  };
}

async function createPod(spec) {
  return kc(['create', '-f', '-'], { input: JSON.stringify(spec) });
}
async function deletePod(name) {
  await kc(['delete', 'pod', name, '--ignore-not-found', '--wait=false']).catch(() => {});
}
/** 입장을 기대한다: 만들어진 뒤 지운다(이미지 끌어오기는 보지 않는다) */
async function admitted(spec) {
  await createPod(spec);
  await deletePod(spec.metadata.name);
}
/** 거부를 기대한다: admission 오류에 그 까닭이 있어야 한다. 만들어졌으면 실패다 */
async function denied(spec, pattern) {
  let made = false;
  try {
    await createPod(spec);
    made = true;
    assert.fail(`입장했다: ${spec.metadata.name}`);
  } catch (e) {
    const text = String(e.stderr ?? e.message);
    if (made) throw e;
    assert.match(text, pattern, `${spec.metadata.name}: ${text}`);
  } finally {
    if (made) await deletePod(spec.metadata.name);
  }
}

async function applyDoc(doc) {
  await kc(['apply', '-f', '-'], { input: JSON.stringify(doc) });
}
async function deletePolicy(kind, name) {
  await kc(['delete', kind, name, '--ignore-not-found']).catch(() => {});
}
const policiesOf = (env) => parseAllDocuments(readFileSync(join(REPO, 'deploy', 'policies', 'kyverno', 'envs', env, 'policies.yaml'), 'utf8')).map((d) => d.toJS()).filter(Boolean);
const policyOf = (env, name) => {
  const doc = policiesOf(env).find((d) => d.metadata?.name === name);
  assert.ok(doc, `${env}/${name} 정책이 없다`);
  return structuredClone(doc);
};
/** 사본 정책은 이름을 바꾸고 Deny/Fail로 둔다(데모 정책은 감사 모드라 거부를 볼 수 없다) */
function copyPolicy(env, name, newName) {
  const doc = policyOf(env, name);
  doc.metadata.name = newName;
  doc.metadata.labels = { ...(doc.metadata.labels ?? {}), ...E2E_LABEL };
  doc.spec.validationActions = ['Deny'];
  doc.spec.failurePolicy = 'Fail';
  return doc;
}
async function waitPolicy(kind, name) {
  // Kyverno CEL 정책은 status.conditions의 Ready로 준비를 알린다. 그 칸이 없으면 잠깐 뒤 진행한다(정책 적용 자체는 이미 끝났다)
  const until = Date.now() + 120_000;
  for (;;) {
    try {
      const out = await kc(['get', kind, name, '-o', 'json'], { quiet: true });
      const status = JSON.parse(out).status ?? {};
      const ready = status.ready === true || (status.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');
      if (ready) return;
    } catch {
      // 아직 없다
    }
    if (Date.now() > until) {
      await sleep(5000);
      return;
    }
    await sleep(1000);
  }
}
function cosign(args) {
  return docker(['run', '--rm', '--network', 'host', '-v', `${keyDir}:/keys`, '-w', '/keys', '-e', 'COSIGN_PASSWORD=', COSIGN_IMAGE, ...args]);
}
/** 로컬 레지스트리 컨테이너를 kind 네트워크에 붙이고, 클러스터 안에서 이름이 풀리게 Service·Endpoints를 만든다 */
async function startRegistry() {
  try {
    docker(['inspect', REGISTRY_CONTAINER]);
  } catch {
    docker(['run', '-d', '--name', REGISTRY_CONTAINER, '-p', `${HOST_REGISTRY}:5000`, REGISTRY_IMAGE]);
  }
  // kind 노드와 같은 도커 네트워크에 붙인다(kind는 기본 'kind' 네트워크를 쓴다)
  const control = `${CLUSTER}-control-plane`;
  registryNetwork = docker(['inspect', '-f', '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}\n{{end}}', control]).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  assert.ok(registryNetwork, `${control}의 도커 네트워크를 찾지 못했다`);
  try {
    docker(['network', 'connect', registryNetwork, REGISTRY_CONTAINER]);
  } catch {
    // 이미 붙어 있다
  }
  registryIp = docker(['inspect', '-f', `{{(index .NetworkSettings.Networks "${registryNetwork}").IPAddress}}`, REGISTRY_CONTAINER]).trim();
  assert.match(registryIp, /^\d+\.\d+\.\d+\.\d+$/, `레지스트리 컨테이너 IP: ${registryIp}`);
  const objects = [
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: REGISTRY_SERVICE, namespace: 'default', labels: E2E_LABEL },
      spec: { ports: [{ name: 'http', port: 5000, targetPort: 5000 }] },
    },
    {
      apiVersion: 'v1',
      kind: 'Endpoints',
      metadata: { name: REGISTRY_SERVICE, namespace: 'default', labels: E2E_LABEL },
      subsets: [{ addresses: [{ ip: registryIp }], ports: [{ name: 'http', port: 5000 }] }],
    },
  ];
  for (const o of objects) await applyDoc(o);
}
/** 이미지 셋을 밀고 서명한다. 서명은 registry 저장소 경로(peaket-e2e/...)에 붙어 클러스터 참조와 같다 */
function pushAndSign() {
  for (const image of [BUSYBOX_IMAGE, COSIGN_IMAGE]) {
    try {
      docker(['image', 'inspect', image]);
    } catch {
      docker(['pull', image]);
    }
  }
  mkdirSync(keyDir, { recursive: true });
  cosign(['generate-key-pair', '--output-key-prefix', '/keys/cosign']);
  cosign(['generate-key-pair', '--output-key-prefix', '/keys/wrong']);
  publicKey = readFileSync(join(keyDir, 'cosign.pub'), 'utf8');
  const digestOf = (name) => {
    const ref = `${HOST_REGISTRY}/peaket-e2e/${name}:v1`;
    docker(['tag', BUSYBOX_IMAGE, ref]);
    docker(['push', ref]);
    const repo = docker(['inspect', '-f', '{{index .RepoDigests 0}}', ref]).trim();
    const m = /@(sha256:[0-9a-f]{64})$/.exec(repo);
    assert.ok(m, `${name}: 푸시한 다이제스트를 읽지 못했다(${repo})`);
    return m[1];
  };
  const signedDigest = digestOf('signed');
  const unsignedDigest = digestOf('unsigned');
  const wrongDigest = digestOf('wrongkey');
  // 서명(signed)과 다른 키 서명(wrongkey). unsigned는 서명하지 않는다
  for (const [name, key, digest] of [
    ['signed', 'cosign', signedDigest],
    ['wrongkey', 'wrong', wrongDigest],
  ]) {
    cosign(['sign', '--yes', '--tlog-upload=false', '--allow-insecure-registry', '--key', `/keys/${key}.key`, `${HOST_REGISTRY}/peaket-e2e/${name}@${digest}`]);
  }
  signedImage = `${LOCAL_PREFIX}signed@${signedDigest}`;
  unsignedImage = `${LOCAL_PREFIX}unsigned@${unsignedDigest}`;
  wrongKeyImage = `${LOCAL_PREFIX}wrongkey@${wrongDigest}`;
}

/** 오프라인 측정 결과를 측정 파일에 덧붙인다(커밋하는 문서다. 실행할 때만 바뀐다) */
function recordMeasurement(results) {
  const file = join(REPO, 'docs', 'review', 'measurements', 'BAT-085-offline-verify.md');
  const at = new Date().toISOString();
  const lines = [
    '',
    `## 실행 결과(${at}, kind ${CLUSTER}, Kyverno 3.10.0/appVersion v1.20.0)`,
    '',
    ...results.map((r) => `- ${r}`),
    '',
    '한계: 키 없는(keyless) 서명의 오프라인 번들은 첫 출시 이미지가 생긴 뒤 G-20에서 다시 잰다. 이 실행은 키 기반 시험 서명만 본다.',
    '',
  ];
  writeFileSync(file, `${readFileSync(file, 'utf8').trimEnd()}\n${lines.join('\n')}`);
}

before(async () => {
  keyDir = mkdtempSync(join(tmpdir(), 'peaket-kyverno-'));
  await kc(['get', 'namespace', NS]).catch(async () => {
    await kc(['create', 'namespace', NS]);
    createdNamespace = true;
  });
  await startRegistry();
  pushAndSign();
});

after(async () => {
  await kc(['delete', 'pods', '-A', '-l', Object.entries(E2E_LABEL).map(([k, v]) => `${k}=${v}`).join(','), '--ignore-not-found', '--wait=false']).catch(() => {});
  for (const [kind, name] of [
    ['imagevalidatingpolicies', E2E_POLICY],
    ['validatingpolicies', E2E_BASELINE],
    ['validatingpolicies', E2E_REGISTRY],
  ]) await deletePolicy(kind, name);
  await kc(['delete', 'networkpolicy', 'kyverno-egress-offline-e2e', '-n', 'kyverno', '--ignore-not-found']).catch(() => {});
  await kc(['delete', 'service,endpoints', REGISTRY_SERVICE, '-n', 'default', '--ignore-not-found']).catch(() => {});
  docker(['rm', '-f', REGISTRY_CONTAINER], { stdio: 'ignore' });
  rmSync(keyDir, { recursive: true, force: true });
  if (createdNamespace) await kc(['delete', 'namespace', NS, '--ignore-not-found', '--wait=false']).catch(() => {});
});

// ===================== D-T11 ②: 서명 있는 이미지만 입장 =====================

test('D-T11 ② 서명한 이미지는 입장하고, 서명 없음·다른 키·초기 컨테이너 서명 없음은 거부된다', async () => {
  const policy = {
    apiVersion: 'policies.kyverno.io/v1',
    kind: 'ImageValidatingPolicy',
    metadata: { name: E2E_POLICY, labels: E2E_LABEL },
    spec: {
      validationActions: ['Deny'],
      failurePolicy: 'Fail',
      webhookConfiguration: { timeoutSeconds: 15 },
      matchConstraints: {
        resourceRules: [{ apiGroups: [''], apiVersions: ['v1'], operations: ['CREATE', 'UPDATE'], resources: ['pods'] }],
        matchConditions: [{ name: 'e2e-namespace', expression: `object.metadata.namespace == '${NS}'` }],
      },
      matchImageReferences: [{ glob: `${LOCAL_PREFIX}*` }],
      credentials: { allowInsecureRegistry: true },
      validationConfigurations: { required: true, verifyDigest: true },
      attestors: [{ name: 'e2eKey', cosign: { key: { data: publicKey } } }],
      validations: [
        { expression: 'images.containers.map(image, verifyImageSignatures(image, [attestors.e2eKey])).all(result, result > 0)', message: 'E2E 이미지 서명을 확인하지 못했다' },
        { expression: 'images.initContainers.map(image, verifyImageSignatures(image, [attestors.e2eKey])).all(result, result > 0)', message: 'E2E 초기 컨테이너 이미지 서명을 확인하지 못했다' },
      ],
    },
  };
  await applyDoc(policy);
  await waitPolicy('imagevalidatingpolicies', E2E_POLICY);
  await admitted(pod(`kyverno-dt11-signed-${RUN}`, { image: signedImage }));
  await denied(pod(`kyverno-dt11-unsigned-${RUN}`, { image: unsignedImage }), /E2E 이미지 서명/);
  await denied(pod(`kyverno-dt11-wrongkey-${RUN}`, { image: wrongKeyImage }), /E2E 이미지 서명/);
  await denied(
    pod(`kyverno-dt11-init-${RUN}`, {
      image: signedImage,
      initContainers: [
        {
          name: 'init',
          image: unsignedImage,
          resources: { requests: { cpu: '10m', memory: '16Mi' }, limits: { memory: '32Mi' } },
          securityContext: { runAsNonRoot: true, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } },
        },
      ],
    }),
    /E2E 초기 컨테이너 이미지 서명/,
  );
  // 시험 정책을 지워 다음 시험이 이미지 서명에 막히지 않게 한다
  await deletePolicy('imagevalidatingpolicies', E2E_POLICY);
});

// ===================== D-T18 ②: --disable-sigusr1 없는 Node 파드 거부 =====================

test('D-T18 ② Node 파드는 command/args 또는 NODE_OPTIONS에 --disable-sigusr1이 있어야 하고, 디버그 옵션은 거부된다', async () => {
  await applyDoc(copyPolicy('staging', 'peaket-pod-baseline', E2E_BASELINE));
  await waitPolicy('validatingpolicies', E2E_BASELINE);
  const image = `${POD_IMAGE}`;
  // command에 플래그 없음 → 거부
  await denied(pod(`kyverno-dt18-missing-${RUN}`, { image, env: 'staging' }), /--disable-sigusr1/);
  // NODE_OPTIONS에 있음 → 통과
  await admitted(pod(`kyverno-dt18-nodeoptions-${RUN}`, { image, env: 'staging', envs: [{ name: 'NODE_OPTIONS', value: '--disable-sigusr1' }] }));
  // sh -c "node …"에 없음 → 거부(판정을 피하지 못한다)
  await denied(pod(`kyverno-dt18-shell-${RUN}`, { image, env: 'staging', command: ['/bin/sh', '-c', 'node dist/main.js'] }), /--disable-sigusr1/);
  // 비-Node 파드(플래그 없음) → 통과
  await admitted(pod(`kyverno-dt18-nonnode-${RUN}`, { image, env: 'staging', command: ['/bin/sh', '-c', 'sleep 1'] }));
  // --inspect가 있으면 거부(플래그가 함께 있어도 디버그는 안 된다)
  await denied(pod(`kyverno-dt18-inspect-${RUN}`, { image, env: 'staging', command: ['node', '--inspect', '--disable-sigusr1', 'dist/main.js'] }), /--inspect|디버그/);
  // 정책 사본을 지운다
  await deletePolicy('validatingpolicies', E2E_BASELINE);
});

// ===================== D-T33 ①·②: 환경별 허용 레지스트리 =====================

test('D-T33 ① GV-05 데모 정책(감사)은 허용 GHCR 다이제스트 이미지를 막지 않는다', async () => {
  // cluster.mjs kyverno --env demo가 적용한 정책을 그대로 쓴다. 다른 Deny 정책이 없어야 감사 모드를 볼 수 있다
  await admitted(pod(`kyverno-dt33-demo-ok-${RUN}`, { image: `ghcr.io/peaket/queue-svc@${DIGEST}`, env: 'demo' }));
  // 허용 밖(GHCR evil)도 데모는 감사라 막지 않는다(거부는 운영 정책 시험의 몫이다)
  await admitted(pod(`kyverno-dt33-demo-evil-${RUN}`, { image: `ghcr.io/peaket-evil/queue-svc@${DIGEST}`, env: 'demo' }));
});

test('D-T33 ② GV-06 운영 정책(Deny)은 GHCR·다른 계정 ECR을 거부하고 PEAKET ECR은 통과시킨다', async () => {
  await applyDoc(copyPolicy('prod', 'peaket-registry-allowlist', E2E_REGISTRY));
  await waitPolicy('validatingpolicies', E2E_REGISTRY);
  const name = (what) => `kyverno-dt33-prod-${what}-${RUN}`;
  await denied(pod(name('ghcr'), { image: `ghcr.io/peaket/queue-svc@${DIGEST}`, env: 'prod' }), /허용 레지스트리/);
  await denied(pod(name('evil'), { image: `ghcr.io/peaket-evil/queue-svc@${DIGEST}`, env: 'prod' }), /허용 레지스트리/);
  await denied(pod(name('otheracct'), { image: `999999999999.dkr.ecr.ap-northeast-2.amazonaws.com/queue-svc@${DIGEST}`, env: 'prod' }), /허용 레지스트리/);
  await admitted(pod(name('ecr'), { image: `${ECR}queue-svc@${DIGEST}`, env: 'prod' }));
  await deletePolicy('validatingpolicies', E2E_REGISTRY);
});

// ===================== 오프라인 검증 PoC(측정) =====================

test('BAT-085 오프라인 PoC: Kyverno egress를 로컬 레지스트리·DNS만 남기고 막은 뒤 같은·새 다이제스트를 다시 띄워 결과를 기록한다', async () => {
  const policy = {
    apiVersion: 'policies.kyverno.io/v1',
    kind: 'ImageValidatingPolicy',
    metadata: { name: E2E_POLICY, labels: E2E_LABEL },
    spec: {
      validationActions: ['Deny'],
      failurePolicy: 'Fail',
      webhookConfiguration: { timeoutSeconds: 15 },
      matchConstraints: {
        resourceRules: [{ apiGroups: [''], apiVersions: ['v1'], operations: ['CREATE', 'UPDATE'], resources: ['pods'] }],
        matchConditions: [{ name: 'e2e-namespace', expression: `object.metadata.namespace == '${NS}'` }],
      },
      matchImageReferences: [{ glob: `${LOCAL_PREFIX}*` }],
      credentials: { allowInsecureRegistry: true },
      validationConfigurations: { required: true, verifyDigest: true },
      attestors: [{ name: 'e2eKey', cosign: { key: { data: publicKey } } }],
      validations: [{ expression: 'images.containers.map(image, verifyImageSignatures(image, [attestors.e2eKey])).all(result, result > 0)', message: 'E2E 이미지 서명을 확인하지 못했다' }],
    },
  };
  await applyDoc(policy);
  await waitPolicy('imagevalidatingpolicies', E2E_POLICY);
  // ① 같은 다이제스트를 한 번 온라인으로 통과시킨다(검증 결과가 캐시되는지 본다)
  await admitted(pod(`kyverno-offline-warm-${RUN}`, { image: signedImage }));
  await sleep(2000);
  // ② 새 다이제스트를 하나 더 밀고 서명한다(아직 Kyverno가 본 적 없는 이미지)
  const freshRef = `${HOST_REGISTRY}/peaket-e2e/fresh-${RUN}:v1`;
  docker(['tag', BUSYBOX_IMAGE, freshRef]);
  docker(['push', freshRef]);
  const freshDigest = /@(sha256:[0-9a-f]{64})$/.exec(docker(['inspect', '-f', '{{index .RepoDigests 0}}', freshRef]).trim())?.[1];
  assert.ok(freshDigest, '새 다이제스트를 읽지 못했다');
  cosign(['sign', '--yes', '--tlog-upload=false', '--allow-insecure-registry', '--key', '/keys/cosign.key', `${HOST_REGISTRY}/peaket-e2e/fresh-${RUN}@${freshDigest}`]);
  const freshImage = `${LOCAL_PREFIX}fresh-${RUN}@${freshDigest}`;
  const egress = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: 'kyverno-egress-offline-e2e', namespace: 'kyverno', labels: E2E_LABEL },
    spec: {
      podSelector: { matchLabels: { 'app.kubernetes.io/component': 'admission-controller' } },
      policyTypes: ['Egress'],
      egress: [
        { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }], ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
        // 로컬 레지스트리는 default의 Service 끝점(파드가 아닌 컨테이너 IP)이라 ipBlock으로 연다
        { to: [{ ipBlock: { cidr: `${registryIp}/32` } }], ports: [{ protocol: 'TCP', port: 5000 }] },
      ],
    },
  };
  await applyDoc(egress);
  const result = [];
  const attempt = async (label, image) => {
    try {
      await createPod(pod(`kyverno-offline-${label}-${RUN}`, { image }));
      await deletePod(`kyverno-offline-${label}-${RUN}`);
      return '입장(통과)';
    } catch (e) {
      return `거부(${String(e.stderr ?? e.message).trim().split(/\r?\n/).at(-1) ?? '까닭 없음'})`;
    }
  };
  result.push(`같은 다이제스트(온라인 선통과): ${await attempt('same', signedImage)}`);
  result.push(`새 다이제스트(오프라인 번들 없음): ${await attempt('fresh', freshImage)}`);
  recordMeasurement(result);
  await kc(['delete', 'networkpolicy', 'kyverno-egress-offline-e2e', '-n', 'kyverno', '--ignore-not-found']).catch(() => {});
  await deletePolicy('imagevalidatingpolicies', E2E_POLICY);
  // 측정 파일에 결과 줄이 있어야 한다(통과/실패를 단언하지 않는다)
  const text = readFileSync(join(REPO, 'docs', 'review', 'measurements', 'BAT-085-offline-verify.md'), 'utf8');
  assert.match(text, /같은 다이제스트\(온라인 선통과\): /);
});
