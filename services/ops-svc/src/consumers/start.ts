// ops-svc Kafka 소비자를 건다(BAT-465 R-584): 플랫폼 키 단위 소비자 하나(runKeyedConsumer, 그룹 peaket.ops-svc.<환경>)가
// ops.command-events를 읽고 OpsCommandEventsHandler가 HTTP와 같은 처리기를 부른다. 보류는 ops DB held_event다.
// 이 파일만 Kafka 클라이언트(네이티브 모듈 @confluentinc/kafka-javascript, @peaket/platform/stream-worker)를 싣는다.
import { type Clock, type Database, drizzleHeldEventStore, type KafkaAuth, type Registry, systemClock } from '@peaket/platform';
import { runKeyedConsumer } from '@peaket/platform/stream-worker';
import { OPS_COMMAND_EVENTS_TOPIC, type OpsCommandRecord, OpsCommandEventsHandler } from './command-events.js';
import type { HandleCommandEvent } from '../modules/commands/index.js';

/** 서비스 소비자 그룹 이름(docs/streaming.md §2.6) */
export const OPS_GROUP = (env: string): string => `peaket.ops-svc.${env}`;

export interface OpsConsumersOptions {
  env: string;
  brokers: string[];
  /** `ops-svc-<환경>-<파드>` */
  clientId: string;
  auth?: KafkaAuth;
  database: Database;
  handler: HandleCommandEvent;
  clock?: Clock;
  registry?: Registry;
  logger?: { warn(obj: object, msg?: string): void };
  startAt?: 'earliest' | 'latest';
  /** 시험이 줄인다(기본 1초) */
  commitEveryMs?: number;
}

export interface OpsConsumers {
  started: Promise<void>;
  stop(): Promise<void>;
}

export function startOpsConsumers(o: OpsConsumersOptions): OpsConsumers {
  const clock = o.clock ?? systemClock;
  const run = runKeyedConsumer({
    service: 'ops-svc',
    brokers: o.brokers,
    clientId: o.clientId,
    auth: o.auth,
    groupId: OPS_GROUP(o.env),
    topics: [OPS_COMMAND_EVENTS_TOPIC],
    handler: new OpsCommandEventsHandler(o.handler, clock),
    held: drizzleHeldEventStore(o.database, clock),
    registry: o.registry,
    logger: o.logger,
    startAt: o.startAt,
    ...(o.commitEveryMs !== undefined ? { commitEveryMs: o.commitEveryMs } : {}),
  });
  run.started.catch(() => undefined);
  return run;
}
