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
  V0_DATABASE_URL,
  V0_REDIS_URL,
  metricsServerInstall,
  selfSignedCertArgs,
  strimziInstall,
  v0ForwardArgs,
  v0HelmArgs,
  v0MigrationJob,
  v0Secrets,
} from './cluster.mjs';

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

test('FND110_Strimzi설치파일_네임스페이스·운영자메모리·이미지다이제스트를고친다', () => {
  const out = strimziInstall(SAMPLE, 'kafka');
  const [rb, dep] = parseAllDocuments(out).map((d) => d.toJS());
  assert.equal(rb.subjects[0].namespace, 'kafka');
  const c = dep.spec.template.spec.containers[0];
  assert.equal(c.image, `quay.io/strimzi/operator@${PINNED.strimziOperatorDigest}`);
  // 384Mi에서 운영자가 메모리 초과로 죽었다(2026-11-01 kind 확인)
  assert.equal(c.resources.limits.memory, '512Mi');
  assert.equal(c.resources.requests.memory, '512Mi');
  assert.equal(out.includes('myproject'), false);
  // 운영자가 띄우는 엔티티 운영자·초기화 컨테이너의 이미지(환경 변수 값)도 다이제스트다(코드 리뷰 2026-11-01)
  assert.deepEqual(c.env.map((e) => e.value), [`quay.io/strimzi/operator@${PINNED.strimziOperatorDigest}`, `quay.io/strimzi/operator@${PINNED.strimziOperatorDigest}`]);
  assert.equal(out.includes('operator:0.47.0'), false);
});

test('FND110_Strimzi설치파일_고칠자리가없으면_조용히넘어가지않고실패한다', () => {
  assert.throws(() => strimziInstall(SAMPLE.replace('quay.io/strimzi/operator:0.47.0', 'quay.io/strimzi/operator:0.48.0'), 'kafka'), /운영자 이미지/);
  assert.throws(() => strimziInstall(SAMPLE.replaceAll('memory: 384Mi', 'memory: 1Gi'), 'kafka'), /메모리/);
});

test('FND110_고정판_kind노드·Kafka·PostgreSQL·AWS흉내이미지는_다이제스트로_고정했다', () => {
  for (const [k, v] of Object.entries(PINNED)) {
    if (k.endsWith('Digest')) assert.match(v, /^sha256:[0-9a-f]{64}$/, k);
    if (k.endsWith('Sha256')) assert.match(v, /^[0-9a-f]{64}$/, k);
  }
  const kind = readFileSync(join(REPO, 'deploy', 'local', 'kind.yaml'), 'utf8');
  assert.match(kind, /image: kindest\/node:v1\.35\.8@sha256:[0-9a-f]{64}/);
  for (const f of ['kafka.yaml', 'postgres.yaml', 'aws.yaml']) {
    const text = readFileSync(join(REPO, 'deploy', 'local', f), 'utf8');
    for (const m of text.matchAll(/^\s*image: (\S+)/gm)) assert.match(m[1], /@sha256:[0-9a-f]{64}$/, `${f}: ${m[1]}`);
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

test('BSL050_v0로컬매니페스트_Valkey는peaket-local에서_다이제스트고정·디스크에저장하지않고_PG시뮬레이터는v0에서_시험키를Secret으로만받는다 [ASVS v5.0.0-13.3.1]', () => {
  const load = (f) => parseAllDocuments(readFileSync(join(REPO, 'deploy', 'local', f), 'utf8')).map((d) => d.toJS()).filter(Boolean);
  const valkey = load('valkey.yaml');
  const vDep = valkey.find((o) => o.kind === 'Deployment');
  assert.deepEqual(valkey.map((o) => o.metadata.namespace), ['peaket-local', 'peaket-local']);
  assert.equal(valkey.find((o) => o.kind === 'Service').metadata.name, 'valkey');
  const vc = vDep.spec.template.spec.containers[0];
  assert.match(vc.image, /^valkey\/valkey@sha256:[0-9a-f]{64}$/);
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
