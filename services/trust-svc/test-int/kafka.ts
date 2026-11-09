// 통합 시험용 Kafka 컨테이너와 토픽 읽기(queue-svc test-int/kafka.ts와 같다).
// 공식 이미지 한 대(KRaft, apache/kafka:3.9.2), 무작위 포트, 라이브러리 없이 docker 명령). Docker 엔진이 떠 있어야 한다.
// 토픽 자동 생성은 끈다(운영과 같다, asyncapi '토픽은 이 계약에 적힌 대로만 만든다'). 시험이 createTopic으로 먼저 만든다.
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { createKafkaAdmin, createKafkaConsumer, type KafkaConsumer } from '@peaket/platform/stream-worker';

export const KAFKA_IMAGE = 'apache/kafka:3.9.2';

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
  /** 브로커를 멈춘다(컨테이너는 남고 호스트 포트는 그대로라 resume 뒤 같은 주소로 닿는다) */
  pause(): void;
  /** 멈춘 브로커를 다시 띄우고 받을 때까지 기다린다 */
  resume(): Promise<void>;
  createTopic(topic: string, partitions: number): Promise<void>;
  /** 토픽의 파티션마다 끝 위치(high watermark) */
  endOffsets(topic: string): Promise<Map<number, number>>;
  /**
   * 소비자 그룹의 커밋 위치(파티션 → 오프셋, 커밋 없으면 빠진다). 브로커 컨테이너의 kafka-consumer-groups.sh로 읽는다
   * (같은 프로세스에서 소비자가 도는 동안 관리 연결의 fetchOffsets를 거듭 부르면 Windows에서 네이티브 오류로 죽었다, platform containers.ts와 같다)
   */
  groupOffsets(group: string, topic: string): Promise<Map<number, number>>;
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
    async endOffsets(topic) {
      const admin = createKafkaAdmin({ brokers, clientId: 'it-offsets' });
      await admin.connect();
      try {
        const rows = await admin.fetchTopicOffsets(topic);
        return new Map(rows.map((r) => [r.partition, Number(r.high)]));
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
  };
}

/** 읽은 레코드 하나 */
export interface TopicRecord {
  topic: string;
  partition: number;
  offset: number;
  key: string | null;
  /** 값 바이트를 UTF-8 글로(JSON 대역이라 글이다) */
  value: string | null;
  headers: Record<string, string>;
}

/**
 * 토픽들을 처음부터 끝없이 읽어 모으는 읽기 하나(시험 쪽 눈). 새 소비자 그룹을 쓰고 커밋하지 않는다.
 * 시험마다 새 회차 ID를 키로 쓰므로 records를 키로 걸러 본다
 */
export interface TopicCollector {
  readonly records: TopicRecord[];
  /** pred를 만족하는 레코드가 n개 이상 모일 때까지 기다린다(ms 안에 안 되면 던진다). 만족하는 레코드들을 받은 차례로 돌려준다 */
  waitFor(pred: (r: TopicRecord) => boolean, n?: number, ms?: number): Promise<TopicRecord[]>;
  close(): Promise<void>;
}

export async function collectTopics(brokers: string[], topics: string[], group: string): Promise<TopicCollector> {
  const records: TopicRecord[] = [];
  const consumer: KafkaConsumer = createKafkaConsumer({ brokers, clientId: `${group}-reader`, groupId: group, extra: { 'auto.offset.reset': 'earliest' } });
  await consumer.connect();
  await consumer.subscribe({ topics });
  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((message.headers ?? {}) as Record<string, unknown>)) {
        const one = Array.isArray(v) ? v[0] : v;
        if (one !== undefined && one !== null) headers[k] = Buffer.isBuffer(one) ? one.toString('utf8') : String(one);
      }
      records.push({
        topic,
        partition,
        offset: Number(message.offset),
        key: message.key ? message.key.toString('utf8') : null,
        value: message.value ? message.value.toString('utf8') : null,
        headers,
      });
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

/** cond가 참이 될 때까지 0.1초(every)마다 다시 본다. ms 안에 안 되면 what을 담아 던진다 */
export async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 30_000, every = 100): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`기다린 ${what}이(가) ${ms}ms 안에 오지 않았다`);
    await new Promise((r) => setTimeout(r, every));
  }
}
