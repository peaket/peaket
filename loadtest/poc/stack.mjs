#!/usr/bin/env node
// wbs 0.5.1 PoC 측정 무대(loadtest/poc/README.md). PC의 Docker 엔진에 측정용 망 하나를 만들고, 그 안에 Valkey 클러스터(주 노드 셋·
// 복제 셋, TLS 켬·끔)와 측정 도구 컨테이너를 띄운다. 측정 도구가 같은 망 안에 있어 Docker Desktop의 포트 전달을 거치지 않는다.
// 쓰는 법(저장소 뿌리에서):
//   node loadtest/poc/stack.mjs build                 측정 도구 이미지(peaket/poc-bench:local)
//   node loadtest/poc/stack.mjs valkey-up [--tls]     클러스터를 새로 만든다(있으면 지우고)
//   node loadtest/poc/stack.mjs bench <이름> --cpus 4 [--docker] -- src/rate.mjs --op incr ...   측정 하나(결과는 .cache/peaket-poc/out/<이름>.json)
//   node loadtest/poc/stack.mjs down
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE = join(ROOT, '.cache', 'peaket-poc');
const TLS_DIR = join(CACHE, 'tls');
const OUT = join(CACHE, 'out');
export const NET = 'peaket-poc';
export const SUBNET = '172.28.0.0/24';
export const IMAGES = {
  // 통합 시험과 같은 Valkey 8.1(test-int/containers.ts). 다이제스트는 2026-11-01에 받은 8.1.11
  valkey: 'valkey/valkey:8.1-alpine@sha256:2602ace2be6569bc2bbb06f873776516ab9089821525be34f4305c67eb9db02a',
  k6: 'grafana/k6:1.4.2@sha256:3656673de3f30424e8ebcfa46acd9558d83b6a43612d0f668ffeac953950c6c7',
  kafka: 'apache/kafka:3.9.2@sha256:05b4616e0702ef2729327705d54ad6b50ea70b271c4b730fabd2320789fb7b02',
  bench: 'peaket/poc-bench:local',
};
export const VALKEY = [1, 2, 3, 4, 5, 6].map((i) => ({ name: `valkey-${i}`, ip: `172.28.0.${10 + i}` }));
/** 주 노드는 엔진 스레드 하나 + 백그라운드, 복제는 한 코어. 합이 고성능 코어 수(16 스레드)를 넘지 않게 둔다(docs/verification.md §3.5 6번) */
const VALKEY_CPUS = { primary: '2', replica: '1' };

const sh = (cmd, args, o = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...o }).trim();
const docker = (...args) => sh('docker', args);
const tryDocker = (...args) => {
  try {
    return docker(...args);
  } catch {
    return null;
  }
};
const hostPath = (p) => p.replace(/\\/g, '/');

export function ensureCerts() {
  if (existsSync(join(TLS_DIR, 'server.crt'))) return;
  mkdirSync(TLS_DIR, { recursive: true });
  const o = { cwd: TLS_DIR };
  sh('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '30', '-subj', '/CN=peaket-poc-ca', '-keyout', 'ca.key', '-out', 'ca.crt'], o);
  const san = [...VALKEY.flatMap((v) => [`DNS:${v.name}`, `IP:${v.ip}`]), 'DNS:kafka-1', 'DNS:kafka-2', 'DNS:kafka-3'].join(',');
  writeFileSync(join(TLS_DIR, 'ext.cnf'), `subjectAltName=${san}\nextendedKeyUsage=serverAuth,clientAuth\n`);
  sh('openssl', ['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', '/CN=peaket-poc', '-keyout', 'server.key', '-out', 'server.csr'], o);
  sh('openssl', ['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '30', '-extfile', 'ext.cnf', '-out', 'server.crt'], o);
}

export function ensureNet() {
  if (tryDocker('network', 'inspect', NET) === null) docker('network', 'create', '--subnet', SUBNET, NET);
}

export function valkeyDown() {
  for (const v of VALKEY) tryDocker('rm', '-f', v.name);
}

/** 클러스터를 새로 만든다. TLS를 켜면 평문 포트를 닫고 클러스터 버스·복제도 TLS로 한다(운영 대기열·좌석 클러스터와 같다, docs/infra-handover.md §3.2) */
export async function valkeyUp({ tls }) {
  ensureCerts();
  ensureNet();
  valkeyDown();
  const tlsArgs = tls
    ? ['--port', '0', '--tls-port', '6379', '--tls-cert-file', '/tls/server.crt', '--tls-key-file', '/tls/server.key', '--tls-ca-cert-file', '/tls/ca.crt', '--tls-cluster', 'yes', '--tls-replication', 'yes', '--tls-auth-clients', 'no']
    : ['--port', '6379'];
  VALKEY.forEach((v, i) => {
    docker('run', '-d', '--name', v.name, '--hostname', v.name, '--network', NET, '--ip', v.ip, '--cpus', i < 3 ? VALKEY_CPUS.primary : VALKEY_CPUS.replica,
      '-v', `${hostPath(TLS_DIR)}:/tls:ro`, IMAGES.valkey, 'valkey-server',
      '--cluster-enabled', 'yes', '--cluster-config-file', 'nodes.conf', '--cluster-node-timeout', '5000',
      '--cluster-announce-hostname', v.name, '--cluster-preferred-endpoint-type', 'hostname',
      '--appendonly', 'no', '--save', '', '--latency-tracking', 'yes', '--slowlog-log-slower-than', '10000', '--slowlog-max-len', '1024',
      '--protected-mode', 'no', ...tlsArgs);
  });
  const cli = tls ? ['valkey-cli', '--tls', '--cacert', '/tls/ca.crt'] : ['valkey-cli'];
  for (let i = 0; i < 50; i += 1) {
    if (VALKEY.every((v) => tryDocker('exec', v.name, ...cli, 'PING') === 'PONG')) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  docker('exec', VALKEY[0].name, ...cli, '--cluster', 'create', ...VALKEY.map((v) => `${v.ip}:6379`), '--cluster-replicas', '1', '--cluster-yes');
  let ok = false;
  for (let i = 0; i < 100 && !ok; i += 1) {
    ok = VALKEY.every((v) => /cluster_state:ok/.test(tryDocker('exec', v.name, ...cli, 'CLUSTER', 'INFO') ?? ''));
    if (!ok) await new Promise((r) => setTimeout(r, 300));
  }
  if (!ok) throw new Error('valkey 클러스터가 ok가 되지 않았다');
  // 주 노드가 valkey-1·2·3인지 확인한다(CPU 한도를 그렇게 나눴다, 코드 리뷰 2026-11-01: 출력만 하지 않고 실패시킨다)
  const roles = VALKEY.map((v) => `${v.name}:${(tryDocker('exec', v.name, ...cli, 'ROLE') ?? '').split(/\r?\n/)[0]}`);
  console.log(`valkey 클러스터(tls=${tls}): ${roles.join(' ')}`);
  if (!roles.every((r, i) => r.endsWith(i < 3 ? ':master' : ':slave'))) throw new Error(`주 노드 배치가 다르다: ${roles.join(' ')}`);
  return roles;
}

/** Kafka 3.9.2 셋(KRaft, 브로커 겸 컨트롤러). 운영 MSK처럼 복제 3·min.insync.replicas 2. 평문이다(TLS는 PoC 범위 밖) */
export const KAFKA = [1, 2, 3].map((i) => ({ name: `kafka-${i}`, ip: `172.28.0.${30 + i}`, id: i }));
export async function kafkaUp() {
  ensureNet();
  kafkaDown();
  const voters = KAFKA.map((k) => `${k.id}@${k.name}:9093`).join(',');
  for (const k of KAFKA) {
    const env = {
      CLUSTER_ID: 'cGVha2V0LXBvYy1rYWZrYQ', KAFKA_NODE_ID: String(k.id), KAFKA_PROCESS_ROLES: 'broker,controller',
      KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093', KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://${k.name}:9092`,
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER', KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
      KAFKA_CONTROLLER_QUORUM_VOTERS: voters, KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '3', KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '3',
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '2', KAFKA_MIN_INSYNC_REPLICAS: '2', KAFKA_DEFAULT_REPLICATION_FACTOR: '3',
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'false', KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0', KAFKA_HEAP_OPTS: '-Xmx1g -Xms1g',
    };
    docker('run', '-d', '--name', k.name, '--hostname', k.name, '--network', NET, '--ip', k.ip, '--cpus', '2',
      ...Object.entries(env).flatMap(([n, v]) => ['-e', `${n}=${v}`]), IMAGES.kafka);
  }
  for (let i = 0; i < 120; i += 1) {
    const out = tryDocker('exec', KAFKA[0].name, '/opt/kafka/bin/kafka-broker-api-versions.sh', '--bootstrap-server', 'kafka-1:9092,kafka-2:9092,kafka-3:9092');
    if (out && KAFKA.every((k) => out.includes(`${k.name}:9092`))) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('kafka 셋 준비');
}
export function kafkaDown() {
  for (const k of KAFKA) tryDocker('rm', '-f', k.name);
}

export function nodesArg() {
  return VALKEY.slice(0, 3).map((v) => `${v.name}:6379`).join(',');
}

/** 측정 도구 컨테이너 하나를 돌린다. 결과 JSON 경로를 돌려준다 */
export function bench(name, { cpus = '4', withDocker = false, image = IMAGES.bench, args }) {
  mkdirSync(OUT, { recursive: true });
  const outFile = join(OUT, `${name}.json`);
  const run = ['run', '--rm', '--name', `bench-${name}`.slice(0, 60), '--network', NET, '--cpus', String(cpus),
    '-v', `${hostPath(TLS_DIR)}:/tls:ro`, '-v', `${hostPath(OUT)}:/out`];
  if (withDocker) run.push('-v', '/var/run/docker.sock:/var/run/docker.sock');
  run.push(image, ...args, '--out', `/out/${name}.json`);
  const r = spawnSync('docker', run, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
  writeFileSync(join(OUT, `${name}.log`), `${r.stdout ?? ''}\n${r.stderr ?? ''}`);
  if (r.status !== 0) throw new Error(`측정 ${name} 실패(종료 코드 ${r.status}): ${(r.stderr ?? '').slice(-2000)}`);
  return outFile;
}

export function build() {
  execFileSync('docker', ['build', '-t', IMAGES.bench, join(ROOT, 'loadtest', 'poc', 'bench')], { stdio: 'inherit' });
}

export function down() {
  valkeyDown();
  kafkaDown();
  tryDocker('network', 'rm', NET);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'build') build();
  else if (cmd === 'valkey-up') await valkeyUp({ tls: rest.includes('--tls') });
  else if (cmd === 'down') down();
  else if (cmd === 'kafka-up') await kafkaUp();
  else if (cmd === 'bench') {
    const name = rest[0];
    const sep = rest.indexOf('--');
    const opts = rest.slice(1, sep);
    const cpus = opts.includes('--cpus') ? opts[opts.indexOf('--cpus') + 1] : '4';
    console.log(bench(name, { cpus, withDocker: opts.includes('--docker'), args: rest.slice(sep + 1) }));
  } else {
    console.error('명령: build | valkey-up [--tls] | bench <이름> [--cpus N] [--docker] -- <스크립트와 인자> | down');
    process.exit(2);
  }
}
