// 통합 시험용 Kafka·Valkey 컨테이너(postgres.ts와 같은 방식: 라이브러리 없이 docker 명령). Docker 엔진이 떠 있어야 한다.
// Kafka는 공식 이미지 한 대(KRaft, docs/streaming.md ST-T20과 같은 3.9.2), Valkey는 운영과 같은 8.1(docs/infra.md).
import { execFileSync } from 'node:child_process';
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
  stop(): void;
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

export async function startKafka(): Promise<KafkaContainer> {
  const port = await freePort();
  const env = {
    KAFKA_NODE_ID: '1',
    KAFKA_PROCESS_ROLES: 'broker,controller',
    KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093',
    KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://127.0.0.1:${port}`,
    KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
    KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
    KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
    KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
    KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
    KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
    KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
    KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'false',
  };
  const id = docker(['run', '-d', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), '-p', `127.0.0.1:${port}:9092`, KAFKA_IMAGE]);
  const brokers = [`127.0.0.1:${port}`];
  const stop = () => {
    try {
      docker(['rm', '-f', id]);
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
    stop,
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
        docker(['rm', '-f', id]);
      } catch {
        // 이미 없다
      }
    },
  };
}
