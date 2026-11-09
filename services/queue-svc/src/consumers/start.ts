// queue-svc Kafka 소비자를 건다(ADR-0214 결정 1): 플랫폼 키 단위 소비자 하나(runKeyedConsumer, 그룹 peaket.queue-svc.<환경>)가 토픽 셋을 읽고
// QueueEventsHandler가 토픽으로 나눠 맡긴다. 보류는 대기열 Redis(RedisHeldEventStore)다. 커밋이 없을 때는 가장 이른 곳부터 읽는다(플랫폼 기본).
// 이 파일만 Kafka 클라이언트(네이티브 모듈 @confluentinc/kafka-javascript, @peaket/platform/stream-worker)를 싣는다.
// 구현에서 정한 것(정본에 없다): client.id는 queue-svc-<환경>-<파드>(docs/streaming.md §2.6), 서비스 이름 queue-svc로 소비자 지표(consumer_*)를 낸다.
import type { Clock, HotRedis, KafkaAuth, Registry } from '@peaket/platform';
import { runKeyedConsumer } from '@peaket/platform/stream-worker';
import { RedisHeldEventStore, redisHeldCounts } from './held-events.js';
import { QUEUE_GROUP, QUEUE_TOPICS, type QueueEventHandlers, QueueEventsHandler } from './queue-events.js';

export interface QueueConsumersOptions {
  env: string;
  brokers: string[];
  /** `queue-svc-<환경>-<파드>` */
  clientId: string;
  auth?: KafkaAuth;
  /** 대기열 Redis(보류 기록) */
  redis: HotRedis;
  handlers: QueueEventHandlers;
  registry?: Registry;
  logger?: { warn(obj: object, msg?: string): void };
  startAt?: 'earliest' | 'latest';
  clock?: Clock;
  /** 시험이 줄인다(기본 1초) */
  commitEveryMs?: number;
  /** 보류 수 재는 주기(기본 30초, 시험이 줄인다) */
  measureHeldEveryMs?: number;
}

export interface QueueConsumers {
  started: Promise<void>;
  stop(): Promise<void>;
}

export function startQueueConsumers(o: QueueConsumersOptions): QueueConsumers {
  const run = runKeyedConsumer({
    service: 'queue-svc',
    brokers: o.brokers,
    clientId: o.clientId,
    auth: o.auth,
    groupId: QUEUE_GROUP(o.env),
    topics: [...QUEUE_TOPICS],
    handler: new QueueEventsHandler(o.handlers),
    held: new RedisHeldEventStore(o.redis, o.clock),
    registry: o.registry,
    ...(o.registry ? { heldCounts: redisHeldCounts(o.redis, QUEUE_TOPICS) } : {}),
    logger: o.logger,
    startAt: o.startAt,
    ...(o.commitEveryMs !== undefined ? { commitEveryMs: o.commitEveryMs } : {}),
    ...(o.measureHeldEveryMs !== undefined ? { measureHeldEveryMs: o.measureHeldEveryMs } : {}),
  });
  // 부른 쪽이 started를 기다리지 않고 stop만 불러도 처리되지 않은 거부가 남지 않게 한다
  run.started.catch(() => undefined);
  return run;
}
