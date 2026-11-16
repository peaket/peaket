// cluster.mjs의 판단 부분(Strimzi 설치 파일 고치기, 고정 판 표) 시험. 실제 클러스터는 띄우지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { X509Certificate, createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import {
  METRICS_SERVER,
  PINNED,
  V0_BASE_NAMESPACE,
  V0_DATABASE_URL,
  V0_NAMESPACE,
  V0_PG_URL,
  V0_REDIS_URL,
  metricsServerInstall,
  selfSignedCertArgs,
  strimziInstall,
  upPlan,
  v0ForwardArgs,
  v0HelmArgs,
  v0Layout,
  v0MigrationJob,
  v0Secrets,
} from './cluster.mjs';
import { V1_PRELOAD_IMAGES } from './v1-objects.mjs';
// 게이트웨이 명령(BUILD_ORDER HOT-400)의 새 이름은 아직 없을 수 있어 이름 공간으로 읽는다(없는 이름을 가져오면 파일 전체가 읽히지 않는다)
import * as clusterModule from './cluster.mjs';

const HERE_DIR = dirname(fileURLToPath(import.meta.url));

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Strimzi 0.47.0 설치 파일의 해당 부분만 줄인 표본(실제 파일은 1MB)
const SAMPLE = `apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: strimzi-cluster-operator
subjects:
  - kind: ServiceAccount
    name: strimzi-cluster-operator
    namespace: myproject
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: strimzi-cluster-operator
spec:
  template:
    spec:
      containers:
        - name: strimzi-cluster-operator
          image: quay.io/strimzi/operator:0.47.0
          env:
            - name: STRIMZI_DEFAULT_TOPIC_OPERATOR_IMAGE
              value: quay.io/strimzi/operator:0.47.0
            - name: STRIMZI_DEFAULT_KAFKA_INIT_IMAGE
              value: quay.io/strimzi/operator:0.47.0
          resources:
            limits:
              cpu: 1000m
              memory: 384Mi
            requests:
              cpu: 200m
              memory: 384Mi
`;

test('FND110_Strimzi설치파일_네임스페이스·운영자메모리를고치고_이미지는로컬태그로둔다', () => {
  const out = strimziInstall(SAMPLE, 'kafka');
  const [rb, dep] = parseAllDocuments(out).map((d) => d.toJS());
  assert.equal(rb.subjects[0].namespace, 'kafka');
  const c = dep.spec.template.spec.containers[0];
  // 새 kind 노드에는 cluster.mjs가 로컬 이미지를 미리 싣는다. 목록 다이제스트 대신 태그로 찾는다(BAT-028)
  assert.equal(c.image, 'quay.io/strimzi/operator:0.47.0');
  // 384Mi에서 운영자가 메모리 초과로 죽었다(2026-11-01 kind 확인)
  assert.equal(c.resources.limits.memory, '512Mi');
  assert.equal(c.resources.requests.memory, '512Mi');
  assert.equal(out.includes('myproject'), false);
  assert.deepEqual(c.env.map((e) => e.value), ['quay.io/strimzi/operator:0.47.0', 'quay.io/strimzi/operator:0.47.0']);
});

test('FND110_Strimzi설치파일_고칠자리가없으면_조용히넘어가지않고실패한다', () => {
  assert.throws(() => strimziInstall(SAMPLE.replace('quay.io/strimzi/operator:0.47.0', 'quay.io/strimzi/operator:0.48.0'), 'kafka'), /운영자 이미지/);
  assert.throws(() => strimziInstall(SAMPLE.replaceAll('memory: 384Mi', 'memory: 1Gi'), 'kafka'), /메모리/);
});

test('FND110_고정판_kind노드는_다이제스트이고_Kafka·PostgreSQL·AWS흉내는_미리실을로컬태그다', () => {
  for (const [k, v] of Object.entries(PINNED)) {
    if (k.endsWith('Digest')) assert.match(v, /^sha256:[0-9a-f]{64}$/, k);
    if (k.endsWith('Sha256')) assert.match(v, /^[0-9a-f]{64}$/, k);
  }
  const kind = readFileSync(join(REPO, 'deploy', 'local', 'kind.yaml'), 'utf8');
  assert.match(kind, /image: kindest\/node:v1\.35\.8@sha256:[0-9a-f]{64}/);
  for (const f of ['kafka.yaml', 'postgres.yaml', 'aws.yaml']) {
    const text = readFileSync(join(REPO, 'deploy', 'local', f), 'utf8');
    for (const m of text.matchAll(/^\s*image: (\S+)/gm)) {
      // 로컬 kind 노드는 한 플랫폼만 실어 목록 다이제스트와 맞지 않는다. 태그로 두고 preloadLocalImages가 미리 싣는다(BAT-028)
      assert.match(m[1], /^[a-z0-9./_-]+:[A-Za-z0-9._-]+$/, `${f}: ${m[1]}`);
      assert.ok(V1_PRELOAD_IMAGES.includes(m[1]), `${f}: ${m[1]}가 V1_PRELOAD_IMAGES에 없다`);
    }
  }
});

// --- v0 배포(docs/infra.md §3 'v0 배포', wbs 1.1.4, BUILD_ORDER BSL-050) ---

const temps = [];
process.on('exit', () => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'cluster-v0-'));
  temps.push(d);
  return d;
};

// metrics-server v0.9.1 components.yaml(설치 파일 해시 METRICS_SERVER.installSha256)의 Service 끝과 Deployment 부분을 그대로 줄인 표본
const METRICS_SAMPLE = `apiVersion: v1
kind: Service
metadata:
  labels:
    k8s-app: metrics-server
  name: metrics-server
  namespace: kube-system
spec:
  ports:
  - name: https
    port: 443
    protocol: TCP
    targetPort: https
  selector:
    k8s-app: metrics-server
---
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    k8s-app: metrics-server
  name: metrics-server
  namespace: kube-system
spec:
  selector:
    matchLabels:
      k8s-app: metrics-server
  strategy:
    rollingUpdate:
      maxUnavailable: 0
  template:
    metadata:
      labels:
        k8s-app: metrics-server
    spec:
      containers:
      - args:
        - --cert-dir=/tmp
        - --secure-port=10250
        - --kubelet-preferred-address-types=InternalIP,ExternalIP,Hostname
        - --kubelet-use-node-status-port
        - --metric-resolution=15s
        image: registry.k8s.io/metrics-server/metrics-server:v0.9.1
        imagePullPolicy: IfNotPresent
        name: metrics-server
        ports:
        - containerPort: 10250
          name: https
          protocol: TCP
        resources:
          requests:
            cpu: 100m
            memory: 200Mi
      serviceAccountName: metrics-server
`;
const METRICS_ARGS = ['--cert-dir=/tmp', '--secure-port=10250', '--kubelet-preferred-address-types=InternalIP,ExternalIP,Hostname', '--kubelet-use-node-status-port', '--metric-resolution=15s'];

test('K9_metrics-server설치파일_이미지를다이제스트로바꾸고_kubelet-insecure-tls를_같은인자목록에더한다', () => {
  assert.equal(METRICS_SERVER.imageDigest, 'sha256:9b0ba1926e1d3089673f45461c3c1416109dea33b3ba3434048defd380df329b');
  const out = metricsServerInstall(METRICS_SAMPLE);
  const docs = parseAllDocuments(out).map((d) => d.toJS());
  const dep = docs.find((d) => d.kind === 'Deployment');
  const c = dep.spec.template.spec.containers[0];
  assert.equal(c.image, 'registry.k8s.io/metrics-server/metrics-server@sha256:9b0ba1926e1d3089673f45461c3c1416109dea33b3ba3434048defd380df329b');
  // 원래 인자는 그대로 두고, kind 노드의 kubelet 인증서가 자체 서명이라 이 인자 하나만 더한다
  assert.deepEqual([...c.args].sort(), [...METRICS_ARGS, '--kubelet-insecure-tls'].sort());
  assert.equal(c.args.filter((a) => a === '--kubelet-insecure-tls').length, 1);
  assert.equal(out.includes('metrics-server:v0.9.1'), false, '태그로 가리키는 이미지가 남지 않는다');
  // 같은 목록의 같은 들여쓰기
  const indentOf = (re) => out.split(/\r?\n/).find((l) => re.test(l))?.match(/^\s*/)[0];
  assert.equal(indentOf(/^\s*- --kubelet-insecure-tls\s*$/), indentOf(/^\s*- --metric-resolution=15s\s*$/));
  // 다른 문서는 바꾸지 않는다
  assert.deepEqual(docs.find((d) => d.kind === 'Service'), parseAllDocuments(METRICS_SAMPLE)[0].toJS());
});

test('K9_metrics-server설치파일_고칠자리가없으면_조용히넘어가지않고실패한다', () => {
  assert.doesNotThrow(() => metricsServerInstall(METRICS_SAMPLE), '표본 그대로면 고친다');
  assert.throws(() => metricsServerInstall(METRICS_SAMPLE.replace('metrics-server:v0.9.1', 'metrics-server:v0.9.2')));
  assert.throws(() => metricsServerInstall(METRICS_SAMPLE.replace('        - --metric-resolution=15s\n', '')));
  assert.throws(() => metricsServerInstall(METRICS_SAMPLE.replace('--metric-resolution=15s', '--metric-resolution=30s')));
});

const hasOpenssl = spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0;

test('BSL050_입구TLS_자체서명인증서는_EC_P256·SAN_localhost·127.0.0.1·입구서비스·30일이내 [ASVS v5.0.0-12.2.1]', { skip: !hasOpenssl && 'openssl이 이 PC의 PATH에 없다' }, () => {
  const dir = tempDir();
  const keyFile = join(dir, 'tls.key');
  const certFile = join(dir, 'tls.crt');
  const args = selfSignedCertArgs(keyFile, certFile);
  assert.ok(Array.isArray(args) && args.every((a) => typeof a === 'string'));
  const r = spawnSync('openssl', args, { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  const cert = new X509Certificate(readFileSync(certFile));
  assert.equal(cert.publicKey.asymmetricKeyType, 'ec');
  assert.equal(cert.publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
  const san = (cert.subjectAltName ?? '').split(/,\s*/);
  for (const name of ['IP Address:127.0.0.1', 'DNS:localhost', 'DNS:v0-gateway.v0.svc.cluster.local']) assert.ok(san.includes(name), `${name} in ${cert.subjectAltName}`);
  const days = (cert.validToDate.getTime() - cert.validFromDate.getTime()) / 86_400_000;
  assert.ok(days <= 30 && days > 1, `유효 기간 ${days}일`);
  assert.equal(cert.verify(cert.publicKey), true, '자체 서명');
  // 키는 암호 없이 읽히는 같은 P-256 키다(입구가 Secret에서 바로 읽는다)
  const key = createPrivateKey(readFileSync(keyFile));
  assert.equal(key.asymmetricKeyType, 'ec');
  assert.equal(key.asymmetricKeyDetails.namedCurve, 'prime256v1');
  assert.equal(cert.checkPrivateKey(key), true);
});

const SIM_KEY = `sim_sk_${'A1b2_c3-'.repeat(3)}`;
function v0Jwks() {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'kid-0123456789ab', alg: 'ES256', use: 'sig' }] };
}
const TLS = { tlsCert: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n', tlsKey: '-----BEGIN PRIVATE KEY-----\nMIGH\n-----END PRIVATE KEY-----\n' };

test('BSL050_v0비밀셋_앱·입구·시뮬레이터가_자기값만받는다 [ASVS v5.0.0-13.3.1]', () => {
  const jwks = v0Jwks();
  const secrets = v0Secrets({ pgSecretKey: SIM_KEY, ...TLS, jwks });
  assert.equal(secrets.length, 3);
  assert.deepEqual(secrets.map((s) => s.metadata.name).sort(), ['pg-simulator', 'v0-gateway', 'v0-monolith']);
  for (const s of secrets) {
    assert.equal(s.apiVersion, 'v1');
    assert.equal(s.kind, 'Secret');
    assert.equal(s.type, 'Opaque');
    assert.equal(s.metadata.namespace, 'v0');
    for (const [k, v] of Object.entries(s.stringData)) assert.equal(typeof v, 'string', `${s.metadata.name}.${k}`);
  }
  const by = Object.fromEntries(secrets.map((s) => [s.metadata.name, s.stringData]));
  assert.deepEqual(by['v0-monolith'], { PEAKET_V0_DATABASE_URL: V0_DATABASE_URL, PEAKET_V0_REDIS_URL: V0_REDIS_URL, PG_SIMULATOR_SECRET_KEY: SIM_KEY });
  // 입구는 DB·Redis 주소와 시뮬레이터 키를 받지 않는다
  assert.deepEqual(Object.keys(by['v0-gateway']).sort(), ['PEAKET_V0_GATEWAY_JWKS', 'PEAKET_V0_TLS_CERT', 'PEAKET_V0_TLS_KEY']);
  assert.equal(by['v0-gateway'].PEAKET_V0_TLS_CERT, TLS.tlsCert);
  assert.equal(by['v0-gateway'].PEAKET_V0_TLS_KEY, TLS.tlsKey);
  assert.deepEqual(JSON.parse(by['v0-gateway'].PEAKET_V0_GATEWAY_JWKS), jwks);
  assert.deepEqual(by['pg-simulator'], { PG_SIMULATOR_SECRET_KEY: SIM_KEY });
});

test('BSL050_비밀에_개인키가_있으면_만들지_않는다 [ASVS v5.0.0-13.3.1]', () => {
  const jwks = v0Jwks();
  assert.equal(v0Secrets({ pgSecretKey: SIM_KEY, ...TLS, jwks }).length, 3);
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const withD = { keys: [{ ...privateKey.export({ format: 'jwk' }), kid: 'kid-0123456789ab', alg: 'ES256', use: 'sig' }] };
  assert.ok('d' in withD.keys[0]);
  assert.throws(() => v0Secrets({ pgSecretKey: SIM_KEY, ...TLS, jwks: withD }));
  // 여러 키 가운데 하나에만 d가 있어도 거절한다
  assert.throws(() => v0Secrets({ pgSecretKey: SIM_KEY, ...TLS, jwks: { keys: [...jwks.keys, ...withD.keys] } }));
});

test('BSL050_시뮬레이터키는_sim_sk_뒤16자이상만받는다', () => {
  const jwks = v0Jwks();
  // 경계: sim_sk_ 뒤 정확히 16자는 받는다(services/pg-simulator/src/config.ts의 SECRET_KEY와 같다)
  assert.equal(v0Secrets({ pgSecretKey: `sim_sk_${'a'.repeat(16)}`, ...TLS, jwks }).length, 3);
  for (const bad of [`sim_sk_${'a'.repeat(15)}`, `test_sk_${'a'.repeat(20)}`, `live_sk_${'a'.repeat(20)}`, `sim_sk_${'a'.repeat(10)} ${'a'.repeat(10)}`, '', `xsim_sk_${'a'.repeat(20)}`]) {
    assert.throws(() => v0Secrets({ pgSecretKey: bad, ...TLS, jwks }), undefined, bad);
  }
});

test('BSL050_마이그레이션잡_같은이미지·한번만·제한파드보안기준·DB주소는Secret으로 [ASVS v5.0.0-13.2.2]', () => {
  const job = v0MigrationJob('peaket/v0-monolith:local');
  assert.equal(job.apiVersion, 'batch/v1');
  assert.equal(job.kind, 'Job');
  assert.equal(job.metadata.name, 'v0-migrate');
  assert.equal(job.metadata.namespace, 'v0');
  assert.equal(job.spec.backoffLimit, 0);
  assert.ok(Number.isInteger(job.spec.ttlSecondsAfterFinished) && job.spec.ttlSecondsAfterFinished > 0);
  const pod = job.spec.template.spec;
  assert.equal(pod.restartPolicy, 'Never');
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.equal(pod.containers.length, 1);
  const c = pod.containers[0];
  assert.equal(c.image, 'peaket/v0-monolith:local');
  assert.equal(c.imagePullPolicy, 'Never');
  assert.deepEqual(c.command, ['node', 'scripts/migrate.mjs']);
  assert.deepEqual(c.envFrom, [{ secretRef: { name: 'v0-monolith' } }]);
  // DB 주소를 값으로 싣지 않는다
  assert.equal(JSON.stringify(job).includes(V0_DATABASE_URL), false);
  assert.equal(c.securityContext.allowPrivilegeEscalation, false);
  assert.equal(c.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(c.securityContext.capabilities, { drop: ['ALL'] });
  const seccomp = c.securityContext.seccompProfile ?? pod.securityContext.seccompProfile;
  assert.deepEqual(seccomp, { type: 'RuntimeDefault' });
  assert.ok(c.resources.requests && Object.keys(c.resources.requests).length > 0, 'requests');
  assert.ok(c.resources.limits?.memory, 'limits.memory');
  // 다른 이미지를 주면 그 이미지다
  assert.equal(v0MigrationJob('peaket/v0-monolith:other').spec.template.spec.containers[0].image, 'peaket/v0-monolith:other');
});

test('BSL050_helm인자_공용차트로_v0네임스페이스에_그릴리스값파일을_기다리며올린다', () => {
  for (const release of ['v0-monolith', 'v0-gateway']) {
    const a = v0HelmArgs(release);
    assert.deepEqual(a.slice(0, 3), ['upgrade', '--install', release]);
    assert.ok(a.some((x) => x.replace(/\\/g, '/').replace(/\/$/, '').endsWith('deploy/charts/peaket-service')), `차트 경로: ${a}`);
    assert.equal(a[a.indexOf('--namespace') + 1], 'v0');
    const i = a.indexOf('-f');
    assert.ok(i > 0, '-f 값 파일');
    const values = resolve(REPO, a[i + 1]);
    assert.equal(values, join(REPO, 'deploy', 'envs', 'local', `${release}.yaml`));
    assert.ok(existsSync(values), values);
    assert.ok(a.includes('--wait'));
    assert.ok(a.some((x) => x === '--timeout' || x.startsWith('--timeout=')));
  }
  for (const bad of ['pg-simulator', 'example-svc', 'v0', '', '../v0-monolith', 'v0-monolith/../../x']) assert.throws(() => v0HelmArgs(bad), undefined, bad);
});

test('BSL050_입구포트전달은_127.0.0.1에만묶는다 [ASVS v5.0.0-13.4.5]', () => {
  assert.deepEqual(v0ForwardArgs(), ['-n', 'v0', 'port-forward', '--address', '127.0.0.1', 'svc/v0-gateway', '8443:8443']);
  // 바꾸는 것은 이 PC 쪽 포트뿐이다
  assert.deepEqual(v0ForwardArgs(18443), ['-n', 'v0', 'port-forward', '--address', '127.0.0.1', 'svc/v0-gateway', '18443:8443']);
});

test('K9_metrics-server고정판_설치파일은그판의주소와SHA-256·이미지는다이제스트다', () => {
  assert.equal(METRICS_SERVER.version, 'v0.9.1');
  assert.equal(METRICS_SERVER.installUrl, `https://github.com/kubernetes-sigs/metrics-server/releases/download/${METRICS_SERVER.version}/components.yaml`);
  assert.match(METRICS_SERVER.installSha256, /^[0-9a-f]{64}$/);
  assert.match(METRICS_SERVER.imageDigest, /^sha256:[0-9a-f]{64}$/);
});

test('BSL050_v0로컬매니페스트_Valkey는peaket-local에서_미리실을태그·디스크에저장하지않고_PG시뮬레이터는v0에서_시험키를Secret으로만받는다 [ASVS v5.0.0-13.3.1]', () => {
  const load = (f) => parseAllDocuments(readFileSync(join(REPO, 'deploy', 'local', f), 'utf8')).map((d) => d.toJS()).filter(Boolean);
  const valkey = load('valkey.yaml');
  const vDep = valkey.find((o) => o.kind === 'Deployment');
  assert.deepEqual(valkey.map((o) => o.metadata.namespace), ['peaket-local', 'peaket-local']);
  assert.equal(valkey.find((o) => o.kind === 'Service').metadata.name, 'valkey');
  const vc = vDep.spec.template.spec.containers[0];
  assert.equal(vc.image, 'valkey/valkey:8.1-alpine');
  assert.ok(V1_PRELOAD_IMAGES.includes(vc.image));
  // 디스크에 저장하지 않는다(RDB 저장 끔, AOF 끔)
  const arg = (name) => vc.args[vc.args.indexOf(name) + 1];
  assert.ok(vc.args.includes('--save') && arg('--save') === '', `--save "": ${vc.args}`);
  assert.equal(arg('--appendonly'), 'no');

  const sim = load('pg-simulator.yaml');
  assert.ok(sim.every((o) => o.metadata.namespace === 'v0'), sim.map((o) => o.metadata.namespace).join(','));
  const sc = sim.find((o) => o.kind === 'Deployment').spec.template.spec.containers[0];
  assert.equal(sc.image, 'peaket/pg-simulator:local');
  assert.equal(sc.imagePullPolicy, 'Never');
  assert.deepEqual(sc.envFrom, [{ secretRef: { name: 'pg-simulator' } }]);
  assert.equal((sc.env ?? []).some((e) => e.name === 'PG_SIMULATOR_SECRET_KEY'), false, '시험 키를 값으로 싣지 않는다');
});

// 2026-11-03: 받기는 다시 받기·curl 대체가 있는 httpsDownload(tools.mjs) 하나로만 한다(첫 원격 CI의 Strimzi 받기 끊김)
test('cluster.mjs는_파일을_httpsDownload로만받는다', () => {
  const text = readFileSync(new URL('./cluster.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /\bfetch\(/);
  assert.match(text, /httpsDownload\(PINNED\.strimziInstallUrl\)/);
  assert.match(text, /httpsDownload\(METRICS_SERVER\.installUrl\)/);
});

// --- BSL-090: 야간 비교의 기준판 자리 v0-base(docs/devops.md §3.3 '준비 명령', D-T40). 새 판·Before 측정은 v0 ---

/** o를 주지 않은 지금의 helm 인자(네임스페이스만 바꿔 볼 수 있게) */
const helmBase = (release, namespace = 'v0') => ['upgrade', '--install', release, join(REPO, 'deploy', 'charts', 'peaket-service'), '--namespace', namespace, '-f', join(REPO, 'deploy', 'envs', 'local', `${release}.yaml`), '--wait', '--timeout', '300s'];
const BASE_IMAGE = ['--set', 'image.repository=peaket/v0-monolith,image.tag=base'];
const BASE_UPSTREAM = ['--set', 'env.PEAKET_V0_UPSTREAM=http://v0-monolith.v0-base.svc.cluster.local:8080'];
/**
 * selfSignedCertArgs로 openssl이 실제로 만든 인증서의 SAN 이름 목록('IP Address:'는 openssl 인자 꼴 'IP:'로 맞춘다).
 * JSDoc은 SAN을 openssl에 어떤 인자 꼴로 넘기는지 정하지 않으므로 만든 인증서를 본다
 */
function certSan() {
  const dir = tempDir();
  const keyFile = join(dir, 'tls.key');
  const certFile = join(dir, 'tls.crt');
  const r = spawnSync('openssl', selfSignedCertArgs(keyFile, certFile), { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  const san = new X509Certificate(readFileSync(certFile)).subjectAltName ?? '';
  return san.split(/,\s*/).filter(Boolean).map((n) => n.replace(/^IP Address:/, 'IP:'));
}
const NO_OPENSSL = !hasOpenssl && 'openssl이 이 PC의 PATH에 없다';

test('BSL090_D-T40_기준판자리_v0Layout_v0는지금의DB·Valkey·시뮬레이터·입구주소다', () => {
  assert.equal(V0_NAMESPACE, 'v0');
  assert.equal(V0_BASE_NAMESPACE, 'v0-base');
  assert.deepEqual(v0Layout('v0'), {
    namespace: 'v0',
    database: 'v0',
    databaseUrl: V0_DATABASE_URL,
    redisUrl: V0_REDIS_URL,
    pgUrl: V0_PG_URL,
    gatewayUrl: 'https://v0-gateway.v0.svc.cluster.local:8443',
  });
  assert.deepEqual(v0Layout(V0_NAMESPACE), v0Layout('v0'));
});

test('BSL090_D-T40_기준판자리_v0-base는DB_v0_base와Valkey_DB1을쓰고_시뮬레이터는v0의하나를함께쓴다', () => {
  assert.ok(V0_DATABASE_URL.endsWith('/v0'), V0_DATABASE_URL);
  const base = v0Layout(V0_BASE_NAMESPACE);
  assert.deepEqual(base, {
    namespace: 'v0-base',
    database: 'v0_base',
    databaseUrl: V0_DATABASE_URL.replace(/\/v0$/, '/v0_base'),
    redisUrl: `${V0_REDIS_URL}/1`,
    pgUrl: V0_PG_URL,
    gatewayUrl: 'https://v0-gateway.v0-base.svc.cluster.local:8443',
  });
  // DB 주소는 DB 이름만 다르다(사용자·비밀번호·호스트·포트는 같은 PostgreSQL)
  const now = new URL(V0_DATABASE_URL);
  const was = new URL(base.databaseUrl);
  for (const k of ['protocol', 'username', 'password', 'host', 'search', 'hash']) assert.equal(was[k], now[k], k);
  assert.equal(was.pathname, '/v0_base');
  // 두 판의 DB·Valkey DB·입구가 겹치지 않는다(회차 목록 같은 공용 키가 섞이지 않게). 시뮬레이터만 함께 쓴다
  const v0 = v0Layout('v0');
  assert.notEqual(base.databaseUrl, v0.databaseUrl);
  assert.notEqual(base.redisUrl, v0.redisUrl);
  assert.notEqual(base.gatewayUrl, v0.gatewayUrl);
  assert.equal(base.pgUrl, v0.pgUrl);
});

test('BSL090_D-T40_v0Layout_v0·v0-base밖의네임스페이스는RangeError [ASVS v5.0.0-2.2.1]', () => {
  for (const bad of ['v1', 'V0', 'v0_base', 'v0base', 'v0-Base', 'V0-BASE', 'v0-base ', ' v0', 'v0/', '../v0', '', 'default', 'kube-system', 'loadtest',
    'peaket-local', 'observability', 'kafka', '__proto__', 'constructor', 'toString', 'hasOwnProperty', undefined, null]) {
    assert.throws(() => v0Layout(bad), RangeError, String(bad));
  }
});

test('BSL090_D-T40_v0-base비밀셋_앱·입구비밀만그네임스페이스에두고_앱은그판의DB·Valkey주소를받는다 [ASVS v5.0.0-13.3.1]', () => {
  const jwks = v0Jwks();
  const secrets = v0Secrets({ pgSecretKey: SIM_KEY, ...TLS, jwks }, v0Layout('v0-base'));
  // 시뮬레이터는 v0 네임스페이스의 하나를 함께 쓰므로 pg-simulator Secret은 만들지 않는다
  assert.deepEqual(secrets.map((s) => s.metadata.name).sort(), ['v0-gateway', 'v0-monolith']);
  for (const s of secrets) {
    for (const [k, v] of Object.entries(s.stringData)) assert.equal(typeof v, 'string', `${s.metadata.name}.${k}`);
  }
  // 돌려주는 꼴(JSDoc @returns) 그대로: 메타데이터는 이름과 그 판의 네임스페이스뿐이다
  const secret = (name, stringData) => ({ apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: 'v0-base' }, type: 'Opaque', stringData });
  const by = Object.fromEntries(secrets.map((s) => [s.metadata.name, s]));
  assert.deepEqual(by['v0-monolith'], secret('v0-monolith', {
    PEAKET_V0_DATABASE_URL: V0_DATABASE_URL.replace(/\/v0$/, '/v0_base'),
    PEAKET_V0_REDIS_URL: `${V0_REDIS_URL}/1`,
    PG_SIMULATOR_SECRET_KEY: SIM_KEY,
  }));
  // 입구는 그대로 TLS·공개키 목록만 받는다(DB·Redis 주소와 시뮬레이터 키 없음)
  assert.deepEqual(by['v0-gateway'], secret('v0-gateway', { PEAKET_V0_TLS_CERT: TLS.tlsCert, PEAKET_V0_TLS_KEY: TLS.tlsKey, PEAKET_V0_GATEWAY_JWKS: JSON.stringify(jwks) }));
});

test('BSL090_D-T40_v0Secrets_layout을주지않으면v0Layout(v0)와같고_앱Secret의DB·Valkey주소는layout의값이다 [ASVS v5.0.0-13.3.1]', () => {
  const o = { pgSecretKey: SIM_KEY, ...TLS, jwks: v0Jwks() };
  const def = v0Secrets(o);
  assert.equal(def.length, 3);
  assert.ok(def.every((s) => s.metadata.namespace === 'v0'));
  assert.deepEqual(v0Secrets(o, v0Layout('v0')), def);
  // 앱 Secret의 주소는 layout에서 읽는다(네임스페이스 이름으로 다시 정하지 않는다)
  const custom = { ...v0Layout('v0'), databaseUrl: `${V0_DATABASE_URL}_other`, redisUrl: `${V0_REDIS_URL}/7` };
  const withCustom = v0Secrets(o, custom);
  const app = withCustom.find((s) => s.metadata.name === 'v0-monolith');
  assert.equal(app.stringData.PEAKET_V0_DATABASE_URL, custom.databaseUrl);
  assert.equal(app.stringData.PEAKET_V0_REDIS_URL, custom.redisUrl);
  // v0-base 판이 아니면 시뮬레이터 Secret도 그대로 그 네임스페이스에 만든다
  assert.deepEqual(withCustom.map((s) => [s.metadata.name, s.metadata.namespace]).sort(), [['pg-simulator', 'v0'], ['v0-gateway', 'v0'], ['v0-monolith', 'v0']]);
  assert.deepEqual(withCustom.find((s) => s.metadata.name === 'pg-simulator').stringData, { PG_SIMULATOR_SECRET_KEY: SIM_KEY });
});

test('BSL090_D-T40_v0-base비밀도_개인키·틀린시험키·빈공개키목록을거절한다 [ASVS v5.0.0-13.3.1]', () => {
  const base = v0Layout('v0-base');
  assert.equal(v0Secrets({ pgSecretKey: SIM_KEY, ...TLS, jwks: v0Jwks() }, base).length, 2);
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const withD = { keys: [{ ...privateKey.export({ format: 'jwk' }), kid: 'kid-0123456789ab', alg: 'ES256', use: 'sig' }] };
  assert.throws(() => v0Secrets({ pgSecretKey: SIM_KEY, ...TLS, jwks: withD }, base));
  // 시뮬레이터 Secret을 만들지 않아도 앱 Secret이 시험 키를 실으므로 꼴을 본다
  assert.throws(() => v0Secrets({ pgSecretKey: `sim_sk_${'a'.repeat(15)}`, ...TLS, jwks: v0Jwks() }, base));
  assert.throws(() => v0Secrets({ pgSecretKey: `live_sk_${'a'.repeat(20)}`, ...TLS, jwks: v0Jwks() }, base));
  assert.throws(() => v0Secrets({ pgSecretKey: SIM_KEY, ...TLS, jwks: { keys: [] } }, base));
});

test('BSL090_D-T40_마이그레이션잡_namespace를주면그네임스페이스에만들고_나머지는같다 [ASVS v5.0.0-13.2.2]', () => {
  const image = 'peaket/v0-monolith:base';
  const def = v0MigrationJob(image);
  assert.equal(def.metadata.namespace, 'v0');
  assert.equal(v0MigrationJob(image, undefined).metadata.namespace, 'v0');
  assert.equal(v0MigrationJob(image, 'v0').metadata.namespace, 'v0');
  const base = v0MigrationJob(image, 'v0-base');
  assert.equal(base.metadata.namespace, 'v0-base');
  // 이름·이미지·DB 주소를 받는 Secret(그 네임스페이스의 v0-monolith)·보안 기준은 같다
  assert.deepEqual({ ...base, metadata: { ...base.metadata, namespace: 'v0' } }, def);
  assert.deepEqual(base.spec.template.spec.containers[0].envFrom, [{ secretRef: { name: 'v0-monolith' } }]);
  assert.equal(JSON.stringify(base).includes('v0_base'), false, 'DB 주소를 잡 정의에 싣지 않는다');
});

test('BSL090_D-T40_helm인자_o가없으면지금과같고_namespace를주면그네임스페이스에올린다', () => {
  for (const release of ['v0-monolith', 'v0-gateway']) {
    assert.deepEqual(v0HelmArgs(release), helmBase(release));
    assert.deepEqual(v0HelmArgs(release, {}), helmBase(release));
    assert.deepEqual(v0HelmArgs(release, { namespace: 'v0' }), helmBase(release));
  }
  // 앱은 네임스페이스만 바뀐다(upstream을 더하지 않는다)
  assert.deepEqual(v0HelmArgs('v0-monolith', { namespace: 'v0-base' }), helmBase('v0-monolith', 'v0-base'));
  // 릴리스 검사는 그대로
  for (const bad of ['pg-simulator', 'v0', '', '../v0-monolith']) assert.throws(() => v0HelmArgs(bad, { namespace: 'v0-base' }), undefined, bad);
});

test('BSL090_D-T40_helm인자_v0-base의입구는그네임스페이스의앱으로보낸다(PEAKET_V0_UPSTREAM)', () => {
  assert.deepEqual(v0HelmArgs('v0-gateway', { namespace: 'v0-base' }), [...helmBase('v0-gateway', 'v0-base'), ...BASE_UPSTREAM]);
  // v0의 입구는 덮지 않는다: 값 파일의 upstream이 v0 앱이다
  assert.equal(v0HelmArgs('v0-gateway', { namespace: 'v0' }).some((a) => a.includes('PEAKET_V0_UPSTREAM')), false);
  assert.equal(v0HelmArgs('v0-gateway').some((a) => a.includes('PEAKET_V0_UPSTREAM')), false);
  const values = parseAllDocuments(readFileSync(join(REPO, 'deploy', 'envs', 'local', 'v0-gateway.yaml'), 'utf8'))[0].toJS();
  assert.equal(values.env.PEAKET_V0_UPSTREAM, 'http://v0-monolith.v0.svc.cluster.local:8080');
});

test('BSL090_D-T40_helm인자_image를주면원래인자뒤에image의--set을_그뒤에upstream의--set을더한다', () => {
  assert.deepEqual(v0HelmArgs('v0-monolith', { image: 'peaket/v0-monolith:base' }), [...helmBase('v0-monolith'), ...BASE_IMAGE]);
  assert.deepEqual(v0HelmArgs('v0-gateway', { image: 'peaket/v0-monolith:base' }), [...helmBase('v0-gateway'), ...BASE_IMAGE]);
  assert.deepEqual(v0HelmArgs('v0-monolith', { namespace: 'v0-base', image: 'peaket/v0-monolith:base' }), [...helmBase('v0-monolith', 'v0-base'), ...BASE_IMAGE]);
  assert.deepEqual(v0HelmArgs('v0-gateway', { namespace: 'v0-base', image: 'peaket/v0-monolith:base' }), [...helmBase('v0-gateway', 'v0-base'), ...BASE_IMAGE, ...BASE_UPSTREAM]);
  // 허용 글자 안의 이름(소문자·숫자·./_-)과 태그(영문 대소문자·숫자·._-)는 그대로 싣는다
  assert.deepEqual(v0HelmArgs('v0-monolith', { image: 'registry.local/peaket/v0_monolith.x:V1.2_rc-3' }).slice(-2), ['--set', 'image.repository=registry.local/peaket/v0_monolith.x,image.tag=V1.2_rc-3']);
  assert.deepEqual(v0HelmArgs('v0-monolith', { image: 'peaket/v0-monolith:local' }).slice(-2), ['--set', 'image.repository=peaket/v0-monolith,image.tag=local']);
});

test('BSL090_D-T40_helm인자_이미지이름·태그가허용글자밖이면RangeError [ASVS v5.0.0-2.2.1]', () => {
  assert.deepEqual(v0HelmArgs('v0-monolith', { image: 'peaket/v0-monolith:base' }), [...helmBase('v0-monolith'), ...BASE_IMAGE]);
  const bad = [
    'peaket/v0-monolith base', // 공백
    'peaket/v0-monolith:ba se',
    'peaket/v0-monolith:base,image.pullPolicy=Always', // --set의 쉼표로 다른 값을 끼워 넣기
    'peaket/v0-monolith,x=y:base',
    'peaket/v0-monolith:base=x', // =
    'peaket/v0-monolith=x:base',
    'Peaket/v0-monolith:base', // 이름은 소문자만
    'peaket/V0-monolith:base',
    'peaket/v0-monolith', // 태그 없음
    'v0-monolith',
    'peaket/v0-monolith:', // 빈 태그
    ':base', // 빈 이름
    'localhost:5000/peaket/v0-monolith:base', // 콜론 둘(이름에 :는 없다)
    'peaket/v0-monolith:ba:se',
    'peaket/v0-monolith:ba/se', // 태그에 /
    'peaket/v0-monolith:base\n',
    'peaket/v0-monolith:base;id',
    'peaket/v0-monolith:$(id)',
    'peaket/v0-monolith:{a,b}',
    'peaket/v0-monolith:[0]',
    'peaket/v0-monolith:base\\',
    `peaket/v0-monolith@sha256:${'a'.repeat(64)}`, // @
  ];
  for (const image of bad) {
    for (const release of ['v0-monolith', 'v0-gateway']) assert.throws(() => v0HelmArgs(release, { image }), RangeError, `${release} ${JSON.stringify(image)}`);
    assert.throws(() => v0HelmArgs('v0-gateway', { namespace: 'v0-base', image }), RangeError, `v0-base ${JSON.stringify(image)}`);
  }
});

test('BSL090_D-T40_입구TLS_SAN은v0와v0-base두판의입구서비스이름을모두담는다 [ASVS v5.0.0-12.2.1]', { skip: NO_OPENSSL }, () => {
  const san = certSan();
  for (const name of ['DNS:localhost', 'IP:127.0.0.1', 'DNS:v0-gateway.v0.svc', 'DNS:v0-gateway.v0.svc.cluster.local', 'DNS:v0-gateway.v0-base.svc',
    'DNS:v0-gateway.v0-base.svc.cluster.local']) {
    assert.ok(san.includes(name), `${name} in ${san.join(',')}`);
  }
  // SAN은 localhost·127.0.0.1·두 네임스페이스의 입구 서비스 이름뿐이다(와일드카드·다른 이름·다른 IP 없음)
  const allowed = /^(?:DNS:localhost|IP:127\.0\.0\.1|DNS:v0-gateway(?:\.(?:v0|v0-base)(?:\.svc(?:\.cluster\.local)?)?)?)$/;
  for (const name of san) assert.match(name, allowed, `SAN에 정하지 않은 이름: ${name} in ${san.join(',')}`);
});

test('BSL090_D-T40_두판의입구주소는입구인증서SAN에있다 [ASVS v5.0.0-12.2.1]', { skip: NO_OPENSSL }, () => {
  const san = certSan();
  for (const ns of [V0_NAMESPACE, V0_BASE_NAMESPACE]) {
    const u = new URL(v0Layout(ns).gatewayUrl);
    assert.equal(u.protocol, 'https:');
    assert.equal(u.port, '8443');
    assert.ok(san.includes(`DNS:${u.hostname}`), `${u.hostname} in ${san.join(',')}`);
  }
});

// ── 야간 비교 클러스터의 CPU 자리(2026-11-03 러너 A/A 실행 실패) ──
// GitHub 호스트 러너(CPU 4개)의 kind 노드 하나에 시스템 파드·두 판(v0·v0-base)·발생기(요청 = 한도)를 함께 놓는다.
// 클러스터의 Kafka(Strimzi)·AWS 흉내 서버까지 올리면 요청 합이 4.35 CPU라 발생기가 자리를 잡지 못하고 300초 대기 끝에 실패했다.
// kind 기본 파드(kind v0.33.0 노드 1.35.8: apiserver 250m·controller-manager 200m·scheduler 100m·etcd 100m·kindnet 100m·coredns 100m × 2,
// 2026-11-03 노드에서 읽음)와 metrics-server(v0.9.1 설치 파일 100m)는 저장소에 없어 값으로 둔다
const KIND_SYSTEM_CPU_M = 250 + 200 + 100 + 100 + 100 + 2 * 100;
const METRICS_SERVER_CPU_M = 100;
const RUNNER_CPU_M = 4000;
const cpuM = (q) => (q === undefined ? 0 : String(q).endsWith('m') ? Number(String(q).slice(0, -1)) : Number(q) * 1000);
/** 파드 하나의 CPU 요청(초기화 컨테이너는 하나씩 먼저 도므로 컨테이너 합과 가장 큰 것 중 큰 쪽) */
const podCpuM = (spec) => Math.max((spec.containers ?? []).reduce((s, c) => s + cpuM(c.resources?.requests?.cpu), 0), ...(spec.initContainers ?? []).map((c) => cpuM(c.resources?.requests?.cpu)));
const localDocs = (f) => parseAllDocuments(readFileSync(join(REPO, 'deploy', 'local', f), 'utf8')).map((d) => d.toJS()).filter(Boolean);
const workloadCpuM = (docs) => docs.filter((d) => ['Deployment', 'StatefulSet'].includes(d.kind)).reduce((s, d) => s + (d.spec.replicas ?? 1) * podCpuM(d.spec.template.spec), 0);

test('BSL090_D-T40_up인자_없으면_Kafka·PostgreSQL·AWS흉내를올리고_--v0-only면_PostgreSQL만올린다', () => {
  assert.deepEqual(upPlan([]), { v0Only: false, manifests: ['kafka.yaml', 'postgres.yaml', 'aws.yaml'] });
  assert.deepEqual(upPlan(['--v0-only']), { v0Only: true, manifests: ['postgres.yaml'] });
  for (const argv of [['--v0'], ['v0-only'], ['--v0-only', '--x'], ['--V0-ONLY'], ['']]) assert.throws(() => upPlan(argv), /up/, JSON.stringify(argv));
});

test('BSL090_D-T40_v0는_Kafka·AWS흉내를쓰지않는다(up --v0-only로충분하다)', () => {
  for (const f of ['deploy/envs/local/v0-monolith.yaml', 'deploy/envs/local/v0-gateway.yaml', 'deploy/local/valkey.yaml', 'deploy/local/pg-simulator.yaml']) {
    assert.doesNotMatch(readFileSync(join(REPO, f), 'utf8'), /kafka|aws\.peaket-local|:9092\b/i, f);
  }
});

test('BSL090_D-T40_야간준비명령은_up --v0-only로올리고_발생기를더한CPU요청합이_GitHub호스트러너CPU4개안에든다', () => {
  const prepare = readFileSync(join(REPO, 'loadtest', 'nightly', 'prepare.mjs'), 'utf8');
  assert.match(prepare, /'tools\/local\/cluster\.mjs', 'up', '--v0-only'\]/);
  // up --v0-only가 올리는 것과 v0()가 올리는 Valkey·PG 시뮬레이터
  const local = [...upPlan(['--v0-only']).manifests, 'valkey.yaml', 'pg-simulator.yaml'].reduce((s, f) => s + workloadCpuM(localDocs(f)), 0);
  // 두 판(v0·v0-base)의 앱(HPA 최소 복제)·입구
  const values = (r) => parseAllDocuments(readFileSync(join(REPO, 'deploy', 'envs', 'local', `${r}.yaml`), 'utf8'))[0].toJS().service;
  const app = values('v0-monolith');
  const gw = values('v0-gateway');
  const perVersion = app.autoscaling.minReplicas * cpuM(app.resources.requests.cpu) + gw.replicas * cpuM(gw.resources.requests.cpu);
  for (const f of ['config.json', 'config-aa.json']) {
    const k6 = JSON.parse(readFileSync(join(REPO, 'loadtest', 'nightly', f), 'utf8')).k6;
    const gen = Number(k6[k6.indexOf('--cpus') + 1]) * 1000;
    const total = KIND_SYSTEM_CPU_M + METRICS_SERVER_CPU_M + local + 2 * perVersion + gen;
    assert.ok(total <= RUNNER_CPU_M, `${f}: 시스템 ${KIND_SYSTEM_CPU_M + METRICS_SERVER_CPU_M}m + 로컬 ${local}m + 두 판 ${2 * perVersion}m + 발생기 ${gen}m = ${total}m > ${RUNNER_CPU_M}m`);
  }
});

// ---- 게이트웨이(BUILD_ORDER HOT-400, docs/infra.md §4.1 'Envoy 게이트웨이의 첫 구현', 묶음 BAT-055 계획 §5) ----

test('HOT-400 cluster.mjs에 gateways 명령이 있고 쓰는 법에 적혀 있다', () => {
  const r = spawnSync(process.execPath, [join(HERE_DIR, 'cluster.mjs'), '--no-such-command'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /\bgateways\b/, '쓰는 법에 gateways가 없다');
  const head = readFileSync(join(HERE_DIR, 'cluster.mjs'), 'utf8').split('\n').slice(0, 40).join('\n');
  assert.match(head, /node tools\/local\/cluster\.mjs gateways/, '파일 머리의 쓰는 법에 gateways가 없다');
});

test('HOT-400 Envoy Gateway 컨트롤러는 판과 다이제스트를 고정하고 README 판 표에 같은 판을 적는다', () => {
  const pinned = clusterModule.PINNED ?? {};
  const version = Object.entries(pinned).filter(([k]) => /^envoyGateway.*Version$/i.test(k));
  assert.equal(version.length, 1, `PINNED에 Envoy Gateway 판이 없다: ${Object.keys(pinned)}`);
  assert.match(String(version[0][1]), /^v?\d+\.\d+\.\d+$/, '판은 정확한 판 번호다(latest·범위 아님)');
  const digests = Object.entries(pinned).filter(([k]) => /^envoyGateway.*(Digest|Sha256)$/i.test(k));
  assert.ok(digests.length > 0, 'Envoy Gateway 설치 파일 해시나 이미지 다이제스트가 없다');
  for (const [k, v] of digests) assert.match(String(v), /^(sha256:)?[0-9a-f]{64}$/, k);
  const readme = readFileSync(join(HERE_DIR, 'README.md'), 'utf8');
  assert.match(readme, /Envoy Gateway/);
  assert.ok(readme.includes(String(version[0][1]).replace(/^v/, '')), `README 판 표에 ${version[0][1]}가 없다`);
});

// ---- 경로별 메서드·한도(BUILD_ORDER HOT-410, docs/infra.md §4.1 '전역 레이트 리밋 걸기', 묶음 BAT-060 계획 §4·§5) ----

/** Envoy Gateway v1.10.0 설치 파일의 컨트롤러 설정 ConfigMap과 컨트롤러 Deployment를 줄인 표본(실제 파일은 6만 줄, 2026-11-16 시험 담당이 읽음) */
const EG_INSTALL_SAMPLE = `---
# Source: gateway-helm/templates/envoy-gateway-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: envoy-gateway-config
  namespace: envoy-gateway-system
data:
  envoy-gateway.yaml: |
    apiVersion: gateway.envoyproxy.io/v1alpha1
    kind: EnvoyGateway
    extensionApis: {}
    gateway:
      controllerName: gateway.envoyproxy.io/gatewayclass-controller
    logging:
      level:
        default: info
    provider:
      kubernetes:
        rateLimitDeployment:
          container:
            image: docker.io/envoyproxy/ratelimit:5ae0682e
          patch:
            type: StrategicMerge
            value:
              spec:
                template:
                  spec:
                    containers:
                    - imagePullPolicy: IfNotPresent
                      name: envoy-ratelimit
        shutdownManager:
          image: envoyproxy/gateway:v1.10.0
      type: Kubernetes
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: envoy-gateway
  namespace: envoy-gateway-system
spec:
  template:
    spec:
      containers:
        - name: envoy-gateway
          image: envoyproxy/gateway:v1.10.0
`;
/** 넣을 컨트롤러 설정 표본(저장소 파일과 다른 값을 골라, 설치 파일의 기본값이 아니라 받은 설정이 들어가는지 본다) */
const EG_CONTROLLER_SAMPLE = `apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyGateway
extensionApis:
  enableLua: true
gateway:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
rateLimit:
  backend:
    type: Redis
    redis:
      url: sample-redis.example.svc.cluster.local:16379
      tls:
        certificateRef:
          name: sample-redis-ca
provider:
  type: Kubernetes
  kubernetes:
    rateLimitDeployment:
      replicas: 3
      container:
        image: docker.io/envoyproxy/ratelimit:5ae0682e
        env:
          - name: CACHE_KEY_PREFIX
            value: "sample:"
`;
/** 설치 파일 글에서 컨트롤러 설정 ConfigMap 안의 EnvoyGateway 객체 */
function installedController(text) {
  const cm = parseAllDocuments(text)
    .map((d) => d.toJS())
    .find((o) => o?.kind === 'ConfigMap' && o.metadata?.name === 'envoy-gateway-config');
  assert.ok(cm, '설치 파일에 envoy-gateway-config가 없다');
  const raw = cm.data?.['envoy-gateway.yaml'];
  assert.equal(typeof raw, 'string', 'envoy-gateway-config에 envoy-gateway.yaml이 없다');
  return parseAllDocuments(raw)[0].toJS();
}

test("HOT-410 infra §4.1 '전역 레이트 리밋 걸기' gatewayInstall은 설치 파일의 컨트롤러 설정 자리(envoy-gateway-config의 envoy-gateway.yaml)에 받은 EnvoyGateway 객체를 그대로 넣고 나머지 문서는 그대로 둔다", async () => {
  const { gatewayInstall } = await import('./gateway-objects.mjs');
  const out = gatewayInstall(EG_INSTALL_SAMPLE, EG_CONTROLLER_SAMPLE);
  assert.deepEqual(installedController(out), parseAllDocuments(EG_CONTROLLER_SAMPLE)[0].toJS(), '넣은 컨트롤러 설정이 받은 객체와 다르다');
  // 설치 파일의 기본 설정(Lua 꺼짐 extensionApis: {})은 남지 않는다
  assert.doesNotMatch(out, /^\s*extensionApis: \{\}\s*$/m);
  // 컨트롤러 Deployment는 그대로다
  const dep = parseAllDocuments(out)
    .map((d) => d.toJS())
    .find((o) => o?.kind === 'Deployment' && o.metadata?.name === 'envoy-gateway');
  assert.equal(dep?.spec?.template?.spec?.containers?.[0]?.image, 'envoyproxy/gateway:v1.10.0');
  // 저장소의 컨트롤러 설정 파일도 같은 법으로 들어간다
  const repoFile = join(REPO, 'deploy', 'gateways', 'controller', 'envoy-gateway.yaml');
  assert.ok(existsSync(repoFile), `컨트롤러 설정 파일이 없다: ${repoFile}`);
  const repoText = readFileSync(repoFile, 'utf8');
  assert.deepEqual(installedController(gatewayInstall(EG_INSTALL_SAMPLE, repoText)), parseAllDocuments(repoText)[0].toJS());
});

test("HOT-410 infra §4.1 '전역 레이트 리밋 걸기' gatewayInstall은 컨트롤러 설정 자리나 컨트롤러 이미지를 찾지 못하면(판이 바뀜) 조용히 넘어가지 않고 던진다", async () => {
  const { gatewayInstall } = await import('./gateway-objects.mjs');
  assert.throws(() => gatewayInstall(EG_INSTALL_SAMPLE.replace('name: envoy-gateway-config', 'name: other-config'), EG_CONTROLLER_SAMPLE), Error, 'ConfigMap 이름이 다르다');
  assert.throws(() => gatewayInstall(EG_INSTALL_SAMPLE.replace('  envoy-gateway.yaml: |', '  other.yaml: |'), EG_CONTROLLER_SAMPLE), Error, '설정 키가 다르다');
  assert.throws(() => gatewayInstall(EG_INSTALL_SAMPLE.replaceAll('envoyproxy/gateway:v1.10.0', 'envoyproxy/gateway:v1.11.0'), EG_CONTROLLER_SAMPLE), Error, '컨트롤러 판이 다르다');
  // 넣을 설정이 EnvoyGateway가 아니면 던진다
  assert.throws(() => gatewayInstall(EG_INSTALL_SAMPLE, 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n'), Error, 'EnvoyGateway가 아닌 설정');
});

test('HOT-410 레이트 리밋 서비스 이미지는 Envoy Gateway v1.10.0 기본 판(5ae0682e)을 다이제스트로 고정하고 README 판 표와 docs/infra.md에 같은 판을 적는다', () => {
  const pinned = clusterModule.PINNED ?? {};
  const images = Object.entries(pinned).filter(([k]) => /ratelimit/i.test(k) && /Image$/.test(k));
  const digests = Object.entries(pinned).filter(([k]) => /ratelimit/i.test(k) && /Digest$/.test(k));
  assert.equal(images.length, 1, `PINNED에 레이트 리밋 서비스 이미지가 하나가 아니다: ${Object.keys(pinned)}`);
  assert.equal(digests.length, 1, `PINNED에 레이트 리밋 서비스 다이제스트가 하나가 아니다: ${Object.keys(pinned)}`);
  // 판은 따로 고르지 않고 이 판 설치 파일의 기본값이다(latest·master 같은 움직이는 태그가 아니다)
  assert.equal(images[0][1], 'docker.io/envoyproxy/ratelimit:5ae0682e', '레이트 리밋 서비스 이미지');
  assert.match(String(digests[0][1]), /^sha256:[0-9a-f]{64}$/, '레이트 리밋 서비스 다이제스트');
  const readme = readFileSync(join(HERE_DIR, 'README.md'), 'utf8');
  assert.match(readme, /ratelimit/i, 'README 판 표에 레이트 리밋 서비스가 없다');
  assert.ok(readme.includes('5ae0682e'), 'README 판 표에 레이트 리밋 서비스 판(5ae0682e)이 없다');
  const infra = readFileSync(join(REPO, 'docs', 'infra.md'), 'utf8');
  assert.ok(infra.includes('ratelimit:5ae0682e'), "docs/infra.md §4.1 '자리'에 레이트 리밋 서비스 판이 없다");
});

// ---- 게이트웨이를 이 PC로 잇는 법(BUILD_ORDER HOT-400, docs/infra.md §4.1 '로컬 kind에서 이 PC로 잇는 법', 계획 docs/review/plans/W8-L1-ci-fix3.md §2 '나'·§3·§5) ----
// 단언 값(노드 포트 30441~30445, 시작 값 18441, 127.0.0.1, Service 이름·고르개·종류, 오류 메시지의 down·up)은 계획 §2의 2~5·§3과 정본 줄에서 가져왔다(W8-L1-ci-fix3 시험 담당).
// 새 이름은 구현 전 트리에 없어서 이름 공간과 늦은 가져오기로 읽는다(없는 이름을 가져오면 파일 전체가 읽히지 않는다)

/** 계획 §2 '나'의 3: 게이트웨이 → 노드 포트(GATEWAY_NAMES 차례) */
const CF3_NODE_PORTS = { 'gw-queue': 30441, 'gw-fan': 30442, 'gw-partner': 30443, 'gw-ops': 30444, 'gw-scanner': 30445 };
const CF3_GATEWAYS = Object.keys(CF3_NODE_PORTS);
/** docker inspect의 HostConfig.PortBindings 꼴. kind control-plane 노드는 API 서버(6443)도 127.0.0.1의 아무 포트로 낸다 */
const cf3Bindings = (hostPorts, hostIp = '127.0.0.1') => ({
  '6443/tcp': [{ HostIp: '127.0.0.1', HostPort: '53211' }],
  ...Object.fromEntries(CF3_GATEWAYS.map((gw, i) => [`${CF3_NODE_PORTS[gw]}/tcp`, [{ HostIp: hostIp, HostPort: String(hostPorts[i]) }]])),
});
const cf3Mapping = (containerPort, hostPort) => ({ containerPort, hostPort, listenAddress: '127.0.0.1', protocol: 'TCP' });

test('CF3-01 HOT-400 kind 클러스터 설정은 게이트웨이 다섯을 127.0.0.1의 시작 포트부터 노드 포트로 잇는다 [ASVS v5.0.0-13.4.5]', async () => {
  assert.equal(typeof clusterModule.kindClusterConfig, 'function', 'cluster.mjs가 kindClusterConfig를 내놓지 않는다');
  const repoKind = parseAllDocuments(readFileSync(join(REPO, 'deploy', 'local', 'kind.yaml'), 'utf8'))[0].toJS();
  for (const base of [18441, 20001]) {
    const cfg = await clusterModule.kindClusterConfig(base);
    // 저장소의 kind 설정의 다른 칸은 그대로다(노드 이미지 다이제스트 고정 포함)
    assert.equal(cfg.kind, repoKind.kind, `${base}: kind`);
    assert.equal(cfg.apiVersion, repoKind.apiVersion, `${base}: apiVersion`);
    assert.equal(cfg.nodes?.length, repoKind.nodes.length, `${base}: 노드 수`);
    const cp = cfg.nodes.filter((n) => n.role === 'control-plane');
    assert.equal(cp.length, 1, `${base}: control-plane 노드가 하나가 아니다`);
    assert.equal(cp[0].image, repoKind.nodes.find((n) => n.role === 'control-plane').image, `${base}: 노드 이미지가 deploy/local/kind.yaml과 다르다`);
    const maps = [...(cp[0].extraPortMappings ?? [])].sort((a, b) => a.containerPort - b.containerPort);
    assert.deepEqual(
      maps,
      CF3_GATEWAYS.map((gw, i) => cf3Mapping(CF3_NODE_PORTS[gw], base + i)),
      `${base}: 매핑이 노드 포트 30441~30445 → 127.0.0.1:${base}~${base + 4}(TCP) 다섯이 아니다`,
    );
  }
  // 매핑 목록 자체도 GATEWAY_NAMES 차례다(계획 §3 gatewayPortMappings)
  const { gatewayPortMappings, GATEWAY_NAMES } = await import('./gateway-objects.mjs');
  assert.deepEqual(GATEWAY_NAMES, CF3_GATEWAYS);
  assert.equal(typeof gatewayPortMappings, 'function', 'gateway-objects.mjs가 gatewayPortMappings를 내놓지 않는다');
  assert.deepEqual(gatewayPortMappings(18441), CF3_GATEWAYS.map((gw, i) => cf3Mapping(CF3_NODE_PORTS[gw], 18441 + i)));
  assert.deepEqual(gatewayPortMappings(20001), CF3_GATEWAYS.map((gw, i) => cf3Mapping(CF3_NODE_PORTS[gw], 20001 + i)));
});

test('CF3-02 HOT-400 로컬 전용 NodePort Service는 게이트웨이마다 고정 노드 포트로 그 게이트웨이 프록시만 고른다', async () => {
  const { GATEWAY_NODE_PORTS, gatewayNodePortService } = await import('./gateway-objects.mjs');
  assert.deepEqual(GATEWAY_NODE_PORTS, CF3_NODE_PORTS, 'GATEWAY_NODE_PORTS');
  assert.ok(Object.isFrozen(GATEWAY_NODE_PORTS), 'GATEWAY_NODE_PORTS가 얼린 객체가 아니다');
  assert.equal(typeof gatewayNodePortService, 'function', 'gateway-objects.mjs가 gatewayNodePortService를 내놓지 않는다');
  const nodePorts = [];
  for (const gw of CF3_GATEWAYS) {
    for (const targetPort of [10443, 8443]) {
      const svc = gatewayNodePortService(gw, targetPort);
      assert.equal(svc.apiVersion, 'v1', gw);
      assert.equal(svc.kind, 'Service', gw);
      assert.equal(svc.metadata?.name, `peaket-local-${gw}`, `${gw}: 이름`);
      assert.equal(svc.metadata?.namespace, 'envoy-gateway-system', `${gw}: 네임스페이스`);
      assert.equal(svc.spec?.type, 'NodePort', `${gw}: 종류`);
      // 고르개는 그 게이트웨이의 프록시 파드 라벨 하나뿐이다(접속 정보 logs.selector와 같은 라벨)
      assert.deepEqual(svc.spec?.selector, { 'gateway.envoyproxy.io/owning-gateway-name': gw }, `${gw}: 고르개`);
      assert.equal(svc.spec?.ports?.length, 1, `${gw}: 포트 수`);
      const [p] = svc.spec.ports;
      assert.equal(p.port, 443, `${gw}: Service 포트`);
      assert.equal(p.targetPort, targetPort, `${gw}: targetPort는 받은 값이다`);
      assert.equal(p.nodePort, CF3_NODE_PORTS[gw], `${gw}: 노드 포트`);
      if (p.protocol !== undefined) assert.equal(p.protocol, 'TCP', `${gw}: 프로토콜`);
      if (targetPort === 10443) nodePorts.push(p.nodePort);
    }
  }
  assert.equal(new Set(nodePorts).size, CF3_GATEWAYS.length, '노드 포트가 겹친다');
  for (const n of nodePorts) assert.ok(n >= 30000 && n <= 32767, `노드 포트 ${n}가 쿠버네티스 NodePort 범위(30000~32767) 밖이다`);
});

test('CF3-04 HOT-400 접속 정보의 포트는 노드 컨테이너의 실제 공개 포트다', async () => {
  const { gatewayHostPorts } = await import('./gateway-objects.mjs');
  assert.equal(typeof gatewayHostPorts, 'function', 'gateway-objects.mjs가 gatewayHostPorts를 내놓지 않는다');
  assert.deepEqual(gatewayHostPorts(cf3Bindings([18441, 18442, 18443, 18444, 18445])), { 'gw-queue': 18441, 'gw-fan': 18442, 'gw-partner': 18443, 'gw-ops': 18444, 'gw-scanner': 18445 });
  // 공개 포트가 차례와 달라도 그 값을 그대로 돌려준다(시작 값 + 차례로 계산하지 않는다)
  assert.deepEqual(gatewayHostPorts(cf3Bindings([18441, 25000, 18443, 18444, 18445])), { 'gw-queue': 18441, 'gw-fan': 25000, 'gw-partner': 18443, 'gw-ops': 18444, 'gw-scanner': 18445 });
  assert.deepEqual(gatewayHostPorts(cf3Bindings([20005, 20001, 20004, 20002, 20003])), { 'gw-queue': 20005, 'gw-fan': 20001, 'gw-partner': 20004, 'gw-ops': 20002, 'gw-scanner': 20003 });
});

test('CF3-05 HOT-400 매핑 없이 만든 클러스터나 127.0.0.1 밖 공개면 gateways가 멈춘다 [ASVS v5.0.0-13.4.5]', async () => {
  const { gatewayHostPorts } = await import('./gateway-objects.mjs');
  assert.equal(typeof gatewayHostPorts, 'function', 'gateway-objects.mjs가 gatewayHostPorts를 내놓지 않는다');
  const ok = [18441, 18442, 18443, 18444, 18445];
  const noScanner = cf3Bindings(ok);
  delete noScanner['30445/tcp'];
  const oneHost = (ip) => {
    const b = cf3Bindings(ok);
    b['30442/tcp'] = [{ HostIp: ip, HostPort: '18442' }];
    return b;
  };
  const cases = [
    ['ⓐ 빈 객체(매핑 없이 만든 클러스터)', {}, false],
    ['ⓑ gw-scanner(30445/tcp)만 없음', noScanner, false],
    ['ⓒ HostIp 0.0.0.0', oneHost('0.0.0.0'), true],
    ['ⓓ HostIp 빈 값(모든 주소)', oneHost(''), true],
    ['ⓒ 다섯 모두 0.0.0.0', cf3Bindings(ok, '0.0.0.0'), true],
  ];
  for (const [what, bindings, mentionsLoopback] of cases) {
    let err;
    try {
      gatewayHostPorts(bindings);
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, `${what}: 던지지 않았다`);
    assert.match(err.message, /\bdown\b/, `${what}: 메시지에 down이 없다: ${err.message}`);
    assert.match(err.message, /\bup\b/, `${what}: 메시지에 up이 없다: ${err.message}`);
    if (mentionsLoopback) assert.ok(err.message.includes('127.0.0.1'), `${what}: 메시지에 127.0.0.1이 없다: ${err.message}`);
  }
});

// 리뷰 RV-3(계획 docs/review/plans/W8-L1-ci-fix3.md '리뷰'): CF3-04는 gatewayHostPorts만 보아, 접속 정보를 만드는 gatewayContract가
// 받은 ports 대신 시작 값 + 차례를 계산하도록 틀려도 잡지 못했다. 단언 값은 계획 §3 '접속 정보의 ports는 실제 공개 포트에서 온다'에서 가져왔다
test('CF3-07 HOT-400 접속 정보(gatewayContract)의 ports는 받은 공개 포트 그대로다', async () => {
  const { gatewayContract, gatewayHostPorts, hostsOf, readGatewayObjects } = await import('./gateway-objects.mjs');
  const hosts = hostsOf(readGatewayObjects(join(REPO, 'deploy', 'gateways')));
  const base = { hosts, originVerify: 'cf3-07-origin-verify', keys: { fan: {}, admin: {}, staff: {}, admission: {} }, caPem: '-----BEGIN CERTIFICATE-----\nCF3-07\n-----END CERTIFICATE-----\n' };
  // 시작 값(18441)으로도, 다른 시작 값으로도 계산할 수 없는 포트 다섯
  const ports = { 'gw-queue': 20005, 'gw-fan': 25000, 'gw-partner': 18449, 'gw-ops': 31001, 'gw-scanner': 20001 };
  assert.deepEqual(gatewayContract({ ...base, ports }).ports, ports, '접속 정보의 ports가 받은 값과 다르다');
  // gateways가 실제로 잇는 길: 노드 컨테이너의 공개 → gatewayHostPorts → gatewayContract
  const published = gatewayHostPorts(cf3Bindings([20005, 25000, 18449, 31001, 20001]));
  assert.deepEqual(gatewayContract({ ...base, ports: published }).ports, ports, '공개에서 읽은 포트가 접속 정보에 그대로 실리지 않는다');
});
