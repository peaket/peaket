// core-svc Kafka 소비자를 건다(W7-audit COV2-06): 플랫폼 키 단위 소비자 하나(runKeyedConsumer, 그룹 peaket.core-svc.<환경>)가 탈퇴 토픽을 읽고
// ReviewAccountWithdrawnHandler가 후기를 익명화한다. 보류는 core DB held_event(pid를 뺀 값, pidFreeHeldEventStore)다.
// 이 파일만 Kafka 클라이언트(네이티브 모듈, @peaket/platform/stream-worker)를 싣는다.
// 뼈대(W7-audit 시험 단계): 모양만 두었고 동작은 구현 담당이 채운다.
import type { Clock, Database, KafkaAuth, Registry } from '@peaket/platform';
import type { ReviewAccountWithdrawnHandler } from '../modules/review/index.js';

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

/** runKeyedConsumer({ service: 'core-svc', groupId: CORE_GROUP(env), topics: [...CORE_TOPICS], held: pidFreeHeldEventStore(drizzleHeldEventStore(database, clock)), … }). 뼈대: 구현 담당이 채운다 */
export function startCoreConsumers(_o: CoreConsumersOptions): CoreConsumers {
  throw new Error('아직 없음');
}
