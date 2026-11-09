// 통합 시험용 Kafka 컨테이너와 토픽 읽기(services/purchase-svc/test-int/kafka.ts에서 릴레이 시험에 필요한 부분만 옮김:
// 공식 이미지 한 대(KRaft, apache/kafka:3.9.2), 무작위 포트, 라이브러리 없이 docker 명령). Docker 엔진이 떠 있어야 한다.
// 토픽 자동 생성은 끈다(운영과 같다). 시험이 createTopic으로 먼저 만든다.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createKafkaAdmin, createKafkaConsumer, type KafkaConsumer } from '@peaket/platform/stream-worker';

export const KAFKA_IMAGE = 'apache/kafka:3.9.2';

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** 빈 포트 하나(잡았다 바로 놓는다) */
export async function freePort(): Promise<number> {
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
  const env: Record<string, string> = {
    KAFKA_NODE_ID: '1',
    KAFKA_PROCESS_ROLES: 'broker,controller',
    KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093',
    KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://127.0.0.1:${port}`,
    KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
    KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
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

/** 읽은 레코드 하나 */
export interface TopicRecord {
  topic: string;
  key: string | null;
  /** 값 바이트를 UTF-8 글로(시험이 넣은 JSON 글이다) */
  value: string | null;
  headers: Record<string, string>;
}

/** 토픽을 처음부터 끝없이 읽어 모으는 읽기 하나(시험 쪽 눈). 새 소비자 그룹을 쓰고 records를 키로 걸러 본다 */
export interface TopicCollector {
  readonly records: TopicRecord[];
  /** pred를 만족하는 레코드가 n개 이상 모일 때까지 기다린다(ms 안에 안 되면 던진다) */
  waitFor(pred: (r: TopicRecord) => boolean, n?: number, ms?: number): Promise<TopicRecord[]>;
  close(): Promise<void>;
}

export async function collectTopics(brokers: string[], topics: string[], group: string): Promise<TopicCollector> {
  const records: TopicRecord[] = [];
  const consumer: KafkaConsumer = createKafkaConsumer({ brokers, clientId: `${group}-reader`, groupId: group, extra: { 'auto.offset.reset': 'earliest' } });
  await consumer.connect();
  await consumer.subscribe({ topics });
  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((message.headers ?? {}) as Record<string, unknown>)) {
        const one = Array.isArray(v) ? v[0] : v;
        if (one !== undefined && one !== null) headers[k] = Buffer.isBuffer(one) ? one.toString('utf8') : String(one);
      }
      records.push({ topic, key: message.key ? message.key.toString('utf8') : null, value: message.value ? message.value.toString('utf8') : null, headers });
    },
  });
  return {
    records,
    async waitFor(pred, n = 1, ms = 30_000) {
      const end = Date.now() + ms;
      for (;;) {
        const got = records.filter(pred);
        if (got.length >= n) return got;
        if (Date.now() > end) throw new Error(`기다린 레코드 ${n}개가 ${ms}ms 안에 오지 않았다(받은 것 ${got.length}개)`);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    close: async () => {
      await consumer.disconnect().catch(() => {});
    },
  };
}
