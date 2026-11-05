// 통합 시험용 Kafka·Valkey 컨테이너(postgres.ts와 같은 방식: 라이브러리 없이 docker 명령). Docker 엔진이 떠 있어야 한다.
// Kafka는 공식 이미지 한 대(KRaft, docs/streaming.md ST-T20과 같은 3.9.2), Valkey는 운영과 같은 8.1(docs/infra.md).
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { createKafkaAdmin } from '../src/stream-worker.js';

export const KAFKA_IMAGE = 'apache/kafka:3.9.2';
export const VALKEY_IMAGE = 'valkey/valkey:8.1-alpine';

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

export interface KafkaContainer {
  brokers: string[];
  /** 브로커를 멈춘다(컨테이너는 남는다, V-T28 ②) */
  pause(): void;
  /** 멈춘 브로커를 다시 띄우고 받을 때까지 기다린다 */
  resume(): Promise<void>;
  createTopic(topic: string, partitions: number): Promise<void>;
  /**
   * 소비자 그룹의 커밋 위치(파티션 → 오프셋, 커밋 없으면 빠진다). 브로커 컨테이너의 kafka-consumer-groups.sh로 읽는다:
   * 같은 프로세스에서 소비자가 도는 동안 Confluent 클라이언트 관리 연결로 fetchOffsets를 거듭 부르면 Windows에서 프로세스가
   * 네이티브 오류로 죽었다(2026-11-01, ST-T18)
   */
  groupOffsets(group: string, topic: string): Promise<Map<number, number>>;
  stop(): void;
  /** startKafka({ oauth: true })일 때만: TLS + OAUTHBEARER(서명 없는 JWT를 믿는 시험 검증기) 리스너 주소와 그 CA 파일 */
  auth?: { brokers: string[]; caFile: string };
}

/**
 * 시험 브로커의 TLS 인증서(127.0.0.1·localhost). openssl로 임시 폴더에 만든다. 브로커는 PEM 키 저장소(개인키 + 인증서)를 읽는다
 */
function brokerCerts(): { dir: string; caFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'peaket-kafka-tls-'));
  const o = { cwd: dir, stdio: 'ignore' as const };
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '2', '-subj', '/CN=peaket-it-ca', '-keyout', 'ca.key', '-out', 'ca.crt'], o);
  writeFileSync(join(dir, 'ext.cnf'), 'subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n');
  execFileSync('openssl', ['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', '/CN=localhost', '-keyout', 'broker.key', '-out', 'broker.csr'], o);
  execFileSync('openssl', ['x509', '-req', '-in', 'broker.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2', '-extfile', 'ext.cnf', '-out', 'broker.crt'], o);
  execFileSync('openssl', ['pkcs8', '-topk8', '-nocrypt', '-in', 'broker.key', '-out', 'broker.pk8'], o);
  writeFileSync(join(dir, 'broker.pem'), readFileSync(join(dir, 'broker.pk8'), 'utf8') + readFileSync(join(dir, 'broker.crt'), 'utf8'));
  // Kafka 이미지는 루트가 아닌 사용자(appuser)로 돈다. mkdtemp의 0700 폴더면 리눅스에서 브로커가 키 저장소를 못 읽어 뜨지 못한다
  // (2026-11-03 첫 원격 CI의 'Broker transport failure'. Windows의 Docker Desktop은 권한을 보지 않아 로컬에서는 안 보였다). 시험용 임시 인증서다
  chmodSync(dir, 0o755);
  chmodSync(join(dir, 'broker.pem'), 0o644);
  return { dir, caFile: join(dir, 'ca.crt') };
}

async function waitKafka(brokers: string[], ms: number): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    const admin = createKafkaAdmin({ brokers, clientId: 'it-wait' });
    try {
      await admin.connect();
      await admin.listTopics();
      await admin.disconnect();
      return;
    } catch (err) {
      await admin.disconnect().catch(() => {});
      if (Date.now() > end) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

export async function startKafka(o: { oauth?: boolean } = {}): Promise<KafkaContainer> {
  const port = await freePort();
  const authPort = o.oauth ? await freePort() : 0;
  const certs = o.oauth ? brokerCerts() : undefined;
  const env: Record<string, string> = {
    KAFKA_NODE_ID: '1',
    KAFKA_PROCESS_ROLES: 'broker,controller',
    // INTERNAL은 컨테이너 안의 브로커 도구(groupOffsets)만 쓴다. PLAINTEXT는 호스트 쪽 포트를 알려 컨테이너 안에서는 닿지 않는다
    KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093,INTERNAL://:9094',
    KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://127.0.0.1:${port},INTERNAL://localhost:9094`,
    KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
    KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
    KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,INTERNAL:PLAINTEXT',
    KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
    KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
    KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
    KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
    KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
    KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'false',
  };
  if (o.oauth) {
    // 리스너 이름을 AUTH로 둔다: 이미지의 시작 스크립트는 광고 주소에 'SSL://'이 있을 때만 JKS 키 저장소 파일 규칙을 강요한다
    env.KAFKA_LISTENERS += ',AUTH://:9095';
    env.KAFKA_ADVERTISED_LISTENERS += `,AUTH://127.0.0.1:${authPort}`;
    env.KAFKA_LISTENER_SECURITY_PROTOCOL_MAP += ',AUTH:SASL_SSL';
    env.KAFKA_SASL_ENABLED_MECHANISMS = 'OAUTHBEARER';
    env.KAFKA_LISTENER_NAME_AUTH_OAUTHBEARER_SASL_JAAS_CONFIG = 'org.apache.kafka.common.security.oauthbearer.OAuthBearerLoginModule required unsecuredLoginStringClaim_sub="broker";';
    env.KAFKA_SSL_KEYSTORE_TYPE = 'PEM';
    env.KAFKA_SSL_KEYSTORE_LOCATION = '/certs/broker.pem';
  }
  const mounts = certs ? ['-v', `${certs.dir.replace(/\\/g, '/')}:/certs:ro`, '-p', `127.0.0.1:${authPort}:9095`] : [];
  const id = docker(['run', '-d', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), '-p', `127.0.0.1:${port}:9092`, ...mounts, KAFKA_IMAGE]);
  const brokers = [`127.0.0.1:${port}`];
  const stop = () => {
    try {
      docker(['rm', '-f', '-v', id]);
    } catch {
      // 이미 없다
    }
  };
  try {
    await waitKafka(brokers, 90_000);
  } catch (err) {
    stop();
    throw err;
  }
  return {
    brokers,
    pause: () => void docker(['stop', '-t', '1', id]),
    resume: async () => {
      docker(['start', id]);
      await waitKafka(brokers, 90_000);
    },
    async createTopic(topic, partitions) {
      const admin = createKafkaAdmin({ brokers, clientId: 'it-admin' });
      await admin.connect();
      try {
        await admin.createTopics({ topics: [{ topic, numPartitions: partitions, replicationFactor: 1 }] });
      } finally {
        await admin.disconnect();
      }
    },
    async groupOffsets(group, topic) {
      const out = new Map<number, number>();
      let text = '';
      try {
        text = (await promisify(execFile)('docker', ['exec', id, '/opt/kafka/bin/kafka-consumer-groups.sh', '--bootstrap-server', 'localhost:9094', '--describe', '--group', group], { encoding: 'utf8' })).stdout;
      } catch {
        return out;
      }
      for (const line of text.split(/\r?\n/)) {
        const f = line.trim().split(/\s+/);
        // GROUP TOPIC PARTITION CURRENT-OFFSET LOG-END-OFFSET LAG CONSUMER-ID HOST CLIENT-ID
        if (f[1] === topic && /^\d+$/.test(f[2] ?? '') && /^\d+$/.test(f[3] ?? '')) out.set(Number(f[2]), Number(f[3]));
      }
      return out;
    },
    stop,
    auth: certs ? { brokers: [`127.0.0.1:${authPort}`], caFile: certs.caFile } : undefined,
  };
}

export interface ValkeyContainer {
  url: string;
  stop(): void;
}

export async function startValkey(): Promise<ValkeyContainer> {
  const id = docker(['run', '-d', '--rm', '-p', '127.0.0.1::6379', VALKEY_IMAGE]);
  const mapped = docker(['port', id, '6379/tcp']).split('\n')[0]!;
  const port = Number(mapped.slice(mapped.lastIndexOf(':') + 1));
  return {
    url: `redis://127.0.0.1:${port}`,
    stop: () => {
      try {
        docker(['rm', '-f', '-v', id]);
      } catch {
        // 이미 없다
      }
    },
  };
}

export interface PasswordCluster {
  port: number;
  stop(): void;
}

/**
 * 비밀번호를 건 1노드 Valkey 클러스터(모든 슬롯을 한 노드에). 클라이언트가 찾아낸 노드 주소로 다시 붙으므로
 * 컨테이너 안팎을 같은 포트로 열고 127.0.0.1로 알린다(핫패스 Redis 연결의 클러스터 인증 시험).
 * 클러스터 통신 포트는 따로 정한다(기본값 '포트 + 10000'이면 55535보다 큰 포트를 받지 않는데, Windows의 빈 포트는 대개 그보다 크다)
 */
export async function startPasswordCluster(password: string): Promise<PasswordCluster> {
  const port = await freePort();
  const id = docker(['run', '-d', '--rm', '-p', `127.0.0.1:${port}:${port}`, VALKEY_IMAGE, 'valkey-server', '--port', String(port), '--cluster-enabled', 'yes', '--cluster-port', '16379', '--cluster-announce-ip', '127.0.0.1', '--requirepass', password, '--masterauth', password, '--save', '', '--appendonly', 'no']);
  const stop = () => {
    try {
      docker(['rm', '-f', '-v', id]);
    } catch {
      // 이미 없다
    }
  };
  const cli = (...args: string[]) => docker(['exec', id, 'valkey-cli', '-p', String(port), '-a', password, '--no-auth-warning', ...args]);
  const until = async (ok: () => boolean, what: string) => {
    for (let i = 0; i < 100; i++) {
      try {
        if (ok()) return;
      } catch {
        // 아직 뜨는 중
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`${what}이(가) 20초 안에 되지 않았다`);
  };
  try {
    await until(() => cli('PING') === 'PONG', '클러스터 노드 시작');
    cli('CLUSTER', 'ADDSLOTSRANGE', '0', '16383');
    await until(() => cli('CLUSTER', 'INFO').includes('cluster_state:ok'), '클러스터 준비');
    return { port, stop };
  } catch (err) {
    stop();
    throw err;
  }
}
