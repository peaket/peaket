// core-svc Kafka 소비자를 건다(W7-audit COV2-06): 플랫폼 키 단위 소비자 하나(runKeyedConsumer, 그룹 peaket.core-svc.<환경>)가 탈퇴 토픽을 읽고
// ReviewAccountWithdrawnHandler가 후기를 익명화한다. 보류는 core DB held_event(pid를 뺀 값, pidFreeHeldEventStore)다.
// 커밋이 없을 때는 가장 이른 곳부터 읽는다(플랫폼 기본, docs/streaming.md §2.6). 서비스 이름 core-svc로 소비자 지표(consumer_*)를 낸다.
// 이 파일만 Kafka 클라이언트(네이티브 모듈, @peaket/platform/stream-worker)를 싣는다.
import { type Clock, type Database, drizzleHeldEventStore, heldEventCounts, type KafkaAuth, type Registry, systemClock } from '@peaket/platform';
import { runKeyedConsumer } from '@peaket/platform/stream-worker';
import type { ReviewAccountWithdrawnHandler } from '../modules/review/index.js';
import { CORE_GROUP, CORE_TOPICS, pidFreeHeldEventStore } from './index.js';

export interface CoreConsumersOptions {
  env: string;
  brokers: string[];
  /** `core-svc-<환경>-<파드>` */
  clientId: string;
  auth?: KafkaAuth;
  /** core_app(held_event·review) */
  database: Database;
  handler: ReviewAccountWithdrawnHandler;
  registry?: Registry;
  logger?: { warn(o: object, msg?: string): void };
  clock?: Clock;
  startAt?: 'earliest' | 'latest';
  /** 시험이 줄인다(기본 1초) */
  commitEveryMs?: number;
  /** 보류 수 재는 주기(기본 30초, 시험이 줄인다) */
  measureHeldEveryMs?: number;
}

export interface CoreConsumers {
  started: Promise<void>;
  stop(): Promise<void>;
}

export function startCoreConsumers(o: CoreConsumersOptions): CoreConsumers {
  const run = runKeyedConsumer({
    service: 'core-svc',
    brokers: o.brokers,
    clientId: o.clientId,
    auth: o.auth,
    groupId: CORE_GROUP(o.env),
    topics: [...CORE_TOPICS],
    handler: o.handler,
    held: pidFreeHeldEventStore(drizzleHeldEventStore(o.database, o.clock ?? systemClock)),
    registry: o.registry,
    ...(o.registry ? { heldCounts: () => heldEventCounts(o.database) } : {}),
    logger: o.logger,
    startAt: o.startAt,
    ...(o.commitEveryMs !== undefined ? { commitEveryMs: o.commitEveryMs } : {}),
    ...(o.measureHeldEveryMs !== undefined ? { measureHeldEveryMs: o.measureHeldEveryMs } : {}),
  });
  // 부른 쪽이 started를 기다리지 않고 stop만 불러도 처리되지 않은 거부가 남지 않게 한다
  run.started.catch(() => undefined);
  return run;
}
