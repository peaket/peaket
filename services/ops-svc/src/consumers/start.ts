// ops-svc Kafka 소비자를 건다(BAT-465 R-584, F-06-2 GAT-280): 플랫폼 키 단위 소비자 하나(runKeyedConsumer, 그룹 peaket.ops-svc.<환경>)가
// ops.command-events(HTTP와 같은 명령 사건 처리기)와 support.cases-requested(내부 HTTP와 같은 CS 건 처리기, ADR-0364 결정 4)를 읽는다. 보류는 ops DB held_event다.
// 이 파일만 Kafka 클라이언트(네이티브 모듈 @confluentinc/kafka-javascript, @peaket/platform/stream-worker)를 싣는다.
import { type Clock, type Database, drizzleHeldEventStore, type KafkaAuth, type Registry, systemClock } from '@peaket/platform';
import { runKeyedConsumer } from '@peaket/platform/stream-worker';
import { OPS_COMMAND_EVENTS_TOPIC, OpsCommandEventsHandler } from './command-events.js';
import { CS_CASES_REQUESTED_TOPIC, CaseRequestsHandler } from './case-requests.js';
import { OpsTopicsHandler } from './topics.js';
import type { HandleCommandEvent } from '../modules/commands/index.js';
import type { ReceiveCaseRequested } from '../modules/cases/index.js';

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
  /** CS 처리함 건 요청 처리기(support.cases-requested). 없으면 그 토픽을 읽지 않는다 */
  cases?: Pick<ReceiveCaseRequested, 'handle' | 'ignored'>;
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
  const cases = o.cases ? new CaseRequestsHandler(o.cases, clock) : undefined;
  const run = runKeyedConsumer({
    service: 'ops-svc',
    brokers: o.brokers,
    clientId: o.clientId,
    auth: o.auth,
    groupId: OPS_GROUP(o.env),
    topics: cases ? [OPS_COMMAND_EVENTS_TOPIC, CS_CASES_REQUESTED_TOPIC] : [OPS_COMMAND_EVENTS_TOPIC],
    handler: new OpsTopicsHandler(new OpsCommandEventsHandler(o.handler, clock), cases),
    held: drizzleHeldEventStore(o.database, clock),
    registry: o.registry,
    logger: o.logger,
    startAt: o.startAt,
    ...(o.commitEveryMs !== undefined ? { commitEveryMs: o.commitEveryMs } : {}),
  });
  run.started.catch(() => undefined);
  return run;
}
