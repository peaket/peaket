// 발생기 파드와 빈 응답 대역의 쿠버네티스 객체(docs/verification.md §3.9 '발생기 배치'·'발생기 보정', ASVS v5.0.0-13.2.2).

export const LOADGEN_NAMESPACE = 'loadtest';
/** k6 1.4.2(loadtest/poc/stack.mjs와 같은 다이제스트) */
export const K6_IMAGE = 'grafana/k6:1.4.2@sha256:3656673de3f30424e8ebcfa46acd9558d83b6a43612d0f668ffeac953950c6c7';
/** 빈 응답 대역(루트가 아닌 nginx, 2026-11-03 받음) */
export const NULL_TARGET_IMAGE = 'nginxinc/nginx-unprivileged:1.29.3-alpine@sha256:5aea7cc516b419e3526f47dd1531be31a56a046cfe44754d94f9383e13e2ee99';
export const NULL_TARGET_NAME = 'null-target';
export const NULL_TARGET_PORT = 8443;
/** 시뮬레이터 시험 키를 담는 이 네임스페이스의 Secret 이름과 키 */
export const SIM_KEY_SECRET = 'loadgen-sim';
export const SIM_KEY_NAME = 'PG_SIMULATOR_SECRET_KEY';
/** k6 이미지 사용자(12345) */
export const K6_UID = 12345;
/**
 * kind 노드 컨테이너(클러스터 peaket의 노드 하나)와 그 안의 실행 폴더 뿌리. 발생기 파드의 입력(시나리오·토큰·인증서·환경 파일)은
 * `docker cp`로 노드의 `<NODE_ROOT>/<실행 꼬리표>`에 넣고 파드가 hostPath로 /work에 붙인다. 이 PC에서 `kubectl exec -i`의 표준 입력이
 * 3만~10만 바이트 언저리에서 잘려(2026-11-03 확인, WebSocket·SPDY 둘 다) 파일을 표준 입력으로 넘기지 않는다
 */
export const KIND_NODE = 'peaket-control-plane';
export const NODE_ROOT = '/var/local/peaket-loadtest';
/** 대기 상태 응답과 비슷한 크기의 고정 JSON(빈 응답 대역이 GET마다 준다) */
export const NULL_TARGET_BODY = '{"status":"WAITING","seq":123456,"ahead":4321,"serving":119135,"servingRate":28.3,"etaSeconds":153,"pollAfterMs":5000,"saleStatus":"ON_SALE","serverTimeMs":1793649471000}';
/**
 * 발생기 파드의 주 프로세스: /work/out을 만들고, 1초마다 cgroup 표본 한 줄
 * `<유닉스 초> <커널 가동 초> <CPU 사용 µs> <메모리 바이트>`를 /work/out/cgroup.log에 덧붙이는 반복을 뒤에서 돌리고, 잠들어 기다린다
 */
export const SAMPLER_COMMAND = Object.freeze(['sh', '-c', 'mkdir -p /work/out; (while :; do read up _ < /proc/uptime; echo "$(date +%s) $up $(awk \'/^usage_usec/{print $2}\' /sys/fs/cgroup/cpu.stat) $(cat /sys/fs/cgroup/memory.current)"; sleep 1; done) >> /work/out/cgroup.log & while :; do sleep 3600; done']);
/**
 * 발생기 파드 안의 실행 스크립트(/work/bin/run.sh, 저장소의 고정 글). /work/run.env를 읽고 k6를 돌린 뒤 종료 코드를 /work/out/exit에 쓴다
 * (다 쓴 뒤 이름을 바꿔 넣어 실행 도구가 반쯤 쓴 파일을 읽지 않게)
 */
export const RUN_SCRIPT = `#!/bin/sh
set -a
. /work/run.env
set +a
cd /work
rm -f out/exit out/exit.tmp out/console.ndjson out/summary.json out/k6.log
date +%s > out/started
k6 run --quiet --no-usage-report --log-format=raw --console-output=out/console.ndjson "loadtest/scenarios/$SCENARIO" > out/k6.log 2>&1
echo $? > out/exit.tmp
mv out/exit.tmp out/exit
`;

const NAME = /^[a-z0-9]([-a-z0-9]{0,40}[a-z0-9])?$/;

const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

const PEM_CERT = /^-----BEGIN CERTIFICATE-----\r?\n[\s\S]+\r?\n-----END CERTIFICATE-----\s*$/;

const PEM_KEY = /^-----BEGIN (EC |RSA )?PRIVATE KEY-----\r?\n[\s\S]+\r?\n-----END (EC |RSA )?PRIVATE KEY-----\s*$/;

const labels = (name) => ({ 'app.kubernetes.io/name': name, 'app.kubernetes.io/part-of': 'peaket-loadtest' });

const containerSecurity = () => ({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } });

function nginxConf(cpus) {
  return [
    `worker_processes ${cpus};`,
    'pid /tmp/nginx.pid;',
    'error_log /dev/stderr warn;',
    'events { worker_connections 16384; }',
    'http {',
    '  client_body_temp_path /tmp/client_temp;',
    '  proxy_temp_path /tmp/proxy_temp;',
    '  fastcgi_temp_path /tmp/fastcgi_temp;',
    '  uwsgi_temp_path /tmp/uwsgi_temp;',
    '  scgi_temp_path /tmp/scgi_temp;',
    '  access_log off;',
    '  keepalive_requests 1000000;',
    '  keepalive_timeout 65s;',
    '  server {',
    `    listen ${NULL_TARGET_PORT} ssl;`,
    '    ssl_certificate /etc/null-target/tls.crt;',
    '    ssl_certificate_key /etc/null-target/tls.key;',
    '    ssl_protocols TLSv1.3;',
    '    location / {',
    '      default_type application/json;',
    `      return 200 '${NULL_TARGET_BODY}';`,
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
}

const RESERVED_ENV = new Set(['PATH', 'HOME', 'SHELL', 'IFS', 'ENV', 'SSL_CERT_FILE', 'GOMAXPROCS', 'K6_NO_USAGE_REPORT', 'PG_SIMULATOR_SECRET_KEY']);

/**
 * 발생기 파드(네임스페이스 LOADGEN_NAMESPACE).
 * - metadata: name, labels { 'app.kubernetes.io/name': 'loadgen', 'app.kubernetes.io/part-of': 'peaket-loadtest' }
 * - spec: restartPolicy Never, automountServiceAccountToken false, enableServiceLinks false, terminationGracePeriodSeconds 5,
 *   nodeSelector { 'kubernetes.io/hostname': KIND_NODE }(입력 폴더가 있는 노드), activeDeadlineSeconds: deadlineS(기본 11,400초 = 토큰 수명 상한 3시간 + 10분.
 *   실행 도구가 강제로 끝나도 쿠버네티스가 파드를 끝낸다),
 *   securityContext { runAsNonRoot: true, runAsUser: K6_UID, runAsGroup: K6_UID, fsGroup: K6_UID, seccompProfile: { type: 'RuntimeDefault' } }
 * - 컨테이너 하나(name 'k6', image K6_IMAGE, imagePullPolicy IfNotPresent, command SAMPLER_COMMAND):
 *   resources의 requests와 limits가 같다({ cpu: '<cpus>', memory: '<memoryMi>Mi' }, 쿠버네티스가 그 몫을 보장하는 등급),
 *   securityContext { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
 *   env: GOMAXPROCS='<cpus>', K6_NO_USAGE_REPORT='true', SSL_CERT_FILE='/work/ca.pem', 그리고 simKey가 참이면
 *   PG_SIMULATOR_SECRET_KEY를 Secret SIM_KEY_SECRET의 키 SIM_KEY_NAME에서(secretKeyRef)
 *   volumeMounts: work → /work, tmp → /tmp
 * - volumes: work(hostPath { path: hostDir, type: 'Directory' }), tmp(emptyDir, sizeLimit '64Mi')
 * name은 `^[a-z0-9]([-a-z0-9]{0,40}[a-z0-9])?$`, cpus 1~16 정수, memoryMi 256~32,768 정수, hostDir는 `<NODE_ROOT>/<영소문자·숫자 1~16자>`
 * (그 밖의 경로·`..`·끝 빗금 없음), deadlineS가 60~11,400 정수가 아니면 RangeError
 * @param {{ name: string, cpus: number, memoryMi: number, hostDir: string, simKey?: boolean, deadlineS?: number }} o
 * @returns {Record<string, any>}
 */
export function generatorPod(o) {
  if (typeof o?.name !== 'string' || !NAME.test(o.name)) throw new RangeError(`파드 이름 꼴이 틀렸다: ${o?.name}`);
  if (!intIn(o.cpus, 1, 16)) throw new RangeError(`CPU는 1~16 정수다: ${o.cpus}`);
  if (!intIn(o.memoryMi, 256, 32768)) throw new RangeError(`메모리는 256~32,768Mi 정수다: ${o.memoryMi}`);
  if (typeof o.hostDir !== 'string' || !o.hostDir.startsWith(`${NODE_ROOT}/`) || !/^[a-z0-9]{1,16}$/.test(o.hostDir.slice(NODE_ROOT.length + 1))) {
    throw new RangeError(`입력 폴더는 ${NODE_ROOT}/<영소문자·숫자 1~16자>다: ${o.hostDir}`);
  }
  const deadlineS = o.deadlineS ?? 11400;
  if (!intIn(deadlineS, 60, 11400)) throw new RangeError(`파드 실행 시간 상한은 60~11,400초 정수다: ${o.deadlineS}`);
  const resources = { cpu: String(o.cpus), memory: `${o.memoryMi}Mi` };
  const env = [
    { name: 'GOMAXPROCS', value: String(o.cpus) },
    { name: 'K6_NO_USAGE_REPORT', value: 'true' },
    { name: 'SSL_CERT_FILE', value: '/work/ca.pem' },
  ];
  if (o.simKey) env.push({ name: SIM_KEY_NAME, valueFrom: { secretKeyRef: { name: SIM_KEY_SECRET, key: SIM_KEY_NAME } } });
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: o.name, namespace: LOADGEN_NAMESPACE, labels: labels('loadgen') },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      terminationGracePeriodSeconds: 5,
      activeDeadlineSeconds: deadlineS,
      nodeSelector: { 'kubernetes.io/hostname': KIND_NODE },
      securityContext: { runAsNonRoot: true, runAsUser: K6_UID, runAsGroup: K6_UID, fsGroup: K6_UID, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [
        {
          name: 'k6',
          image: K6_IMAGE,
          imagePullPolicy: 'IfNotPresent',
          command: [...SAMPLER_COMMAND],
          env,
          resources: { requests: { ...resources }, limits: { ...resources } },
          securityContext: containerSecurity(),
          volumeMounts: [
            { name: 'work', mountPath: '/work' },
            { name: 'tmp', mountPath: '/tmp' },
          ],
        },
      ],
      volumes: [
        { name: 'work', hostPath: { path: o.hostDir, type: 'Directory' } },
        { name: 'tmp', emptyDir: { sizeLimit: '64Mi' } },
      ],
    },
  };
}

/**
 * 빈 응답 대역 객체 셋 [ConfigMap, Deployment, Service](네임스페이스 LOADGEN_NAMESPACE, 이름 NULL_TARGET_NAME).
 * - ConfigMap data['nginx.conf']: worker_processes <cpus>, pid /tmp/nginx.pid, 임시 경로는 /tmp 아래, access_log off,
 *   listen NULL_TARGET_PORT ssl, 인증서 /etc/null-target/tls.crt·키 /etc/null-target/tls.key, keepalive_requests 1000000,
 *   모든 경로에 default_type application/json으로 `return 200 '<NULL_TARGET_BODY>'`
 * - Deployment: replicas 1, 파드는 서비스 계정 토큰을 싣지 않고, 루트가 아닌 사용자(101)·읽기 전용 루트 파일 시스템·모든 권한 버림,
 *   requests와 limits가 같은 CPU <cpus>·메모리 256Mi, 이미지 NULL_TARGET_IMAGE, ConfigMap을 /etc/nginx/nginx.conf(subPath)에,
 *   Secret NULL_TARGET_NAME(tls.crt·tls.key)을 /etc/null-target에, /tmp는 emptyDir, 준비 확인은 TCP NULL_TARGET_PORT
 * - Service: 포트 NULL_TARGET_PORT → 같은 포트
 * cpus가 1~16 정수가 아니면 RangeError
 * @param {{ cpus: number }} o
 * @returns {Array<Record<string, any>>}
 */
export function nullTargetManifests(o) {
  if (!intIn(o?.cpus, 1, 16)) throw new RangeError(`대역 CPU는 1~16 정수다: ${o?.cpus}`);
  const resources = { cpu: String(o.cpus), memory: '256Mi' };
  const meta = { name: NULL_TARGET_NAME, namespace: LOADGEN_NAMESPACE, labels: labels(NULL_TARGET_NAME) };
  return [
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: meta, data: { 'nginx.conf': nginxConf(o.cpus) } },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: meta,
      spec: {
        replicas: 1,
        selector: { matchLabels: { 'app.kubernetes.io/name': NULL_TARGET_NAME } },
        template: {
          metadata: { labels: labels(NULL_TARGET_NAME) },
          spec: {
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            securityContext: { runAsNonRoot: true, runAsUser: 101, runAsGroup: 101, seccompProfile: { type: 'RuntimeDefault' } },
            containers: [
              {
                name: 'nginx',
                image: NULL_TARGET_IMAGE,
                imagePullPolicy: 'IfNotPresent',
                ports: [{ name: 'https', containerPort: NULL_TARGET_PORT }],
                resources: { requests: { ...resources }, limits: { ...resources } },
                securityContext: containerSecurity(),
                readinessProbe: { tcpSocket: { port: NULL_TARGET_PORT }, periodSeconds: 2 },
                volumeMounts: [
                  { name: 'conf', mountPath: '/etc/nginx/nginx.conf', subPath: 'nginx.conf', readOnly: true },
                  { name: 'tls', mountPath: '/etc/null-target', readOnly: true },
                  { name: 'tmp', mountPath: '/tmp' },
                ],
              },
            ],
            volumes: [
              { name: 'conf', configMap: { name: NULL_TARGET_NAME } },
              { name: 'tls', secret: { secretName: NULL_TARGET_NAME } },
              { name: 'tmp', emptyDir: { sizeLimit: '64Mi' } },
            ],
          },
        },
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: meta,
      spec: { selector: { 'app.kubernetes.io/name': NULL_TARGET_NAME }, ports: [{ name: 'https', port: NULL_TARGET_PORT, targetPort: NULL_TARGET_PORT }] },
    },
  ];
}

/**
 * 빈 응답 대역 TLS Secret(type kubernetes.io/tls, stringData tls.crt·tls.key). PEM 꼴이 아니면 Error
 * @param {{ cert: string, key: string }} o
 */
export function nullTargetSecret(o) {
  if (typeof o?.cert !== 'string' || !PEM_CERT.test(o.cert)) throw new Error('대역 인증서가 PEM 꼴이 아니다');
  if (typeof o?.key !== 'string' || !PEM_KEY.test(o.key)) throw new Error('대역 키가 PEM 꼴이 아니다');
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: NULL_TARGET_NAME, namespace: LOADGEN_NAMESPACE, labels: labels(NULL_TARGET_NAME) },
    type: 'kubernetes.io/tls',
    stringData: { 'tls.crt': o.cert, 'tls.key': o.key },
  };
}

/**
 * 빈 응답 대역의 자체 서명 인증서를 만드는 openssl 인자(EC P-256, 1일, SAN은 null-target·null-target.loadtest.svc·null-target.loadtest.svc.cluster.local)
 * @param {string} keyFile
 * @param {string} certFile
 * @returns {string[]}
 */
export function nullTargetCertArgs(keyFile, certFile) {
  const san = [`DNS:${NULL_TARGET_NAME}`, `DNS:${NULL_TARGET_NAME}.${LOADGEN_NAMESPACE}.svc`, `DNS:${NULL_TARGET_NAME}.${LOADGEN_NAMESPACE}.svc.cluster.local`];
  return ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', `/CN=${NULL_TARGET_NAME}`, '-addext', `subjectAltName=${san.join(',')}`, '-keyout', keyFile, '-out', certFile];
}

/**
 * 시뮬레이터 시험 키 Secret(네임스페이스 LOADGEN_NAMESPACE, 이름 SIM_KEY_SECRET, stringData { [SIM_KEY_NAME]: key }).
 * key가 `^sim_sk_[A-Za-z0-9_-]{16,}$`가 아니면 Error(메시지에 키를 싣지 않는다)
 * @param {string} key
 */
export function simKeySecret(key) {
  if (typeof key !== 'string' || !/^sim_sk_[A-Za-z0-9_-]{16,}$/.test(key)) throw new Error('시뮬레이터 시험 키 꼴이 틀렸다(sim_sk_ 뒤 16자 이상)');
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: SIM_KEY_SECRET, namespace: LOADGEN_NAMESPACE, labels: labels('loadgen') },
    type: 'Opaque',
    stringData: { [SIM_KEY_NAME]: key },
  };
}

/**
 * /work/run.env 글: 한 줄에 `KEY=VALUE`, 끝에 줄바꿈. 키는 `^[A-Z][A-Z0-9_]{0,63}$`, 값은 `^[A-Za-z0-9_.:/,-]{0,512}$`
 * (셸이 읽어도 해석할 글자가 없게)가 아니면 Error. 값은 문자열·정수로 받는다. 키 SCENARIO는 꼭 있어야 하고 `^[a-z0-9-]+\.js$`여야 한다.
 * 줄은 넣은 차례대로 쓴다. 파드가 정한 환경을 덮는 키(PATH·HOME·SHELL·IFS·ENV·SSL_CERT_FILE·GOMAXPROCS·K6_NO_USAGE_REPORT·
 * PG_SIMULATOR_SECRET_KEY, `LD_`로 시작하는 이름)는 Error
 * @param {Record<string, string | number>} vars
 * @returns {string}
 */
export function runEnvFile(vars) {
  if (vars === null || typeof vars !== 'object') throw new Error('환경 값 묶음이 없다');
  if (typeof vars.SCENARIO !== 'string' || !/^[a-z0-9-]+\.js$/.test(vars.SCENARIO)) throw new Error('SCENARIO는 시나리오 파일 이름(영소문자·숫자·-, .js)이다');
  let out = '';
  for (const [k, v] of Object.entries(vars)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(k)) throw new Error(`환경 값 이름이 틀렸다: ${k}`);
    if (RESERVED_ENV.has(k) || k.startsWith('LD_')) throw new Error(`파드가 정한 환경 값은 덮지 않는다: ${k}`);
    // 수는 정수만(소수·NaN·Infinity는 거부). 그 밖의 형(불·null·객체)도 거부한다
    const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : v;
    if (typeof s !== 'string' || !/^[A-Za-z0-9_.:/,-]{0,512}$/.test(s)) throw new Error(`환경 값 ${k}에 허용하지 않는 글자가 있다`);
    out += `${k}=${s}\n`;
  }
  return out;
}
