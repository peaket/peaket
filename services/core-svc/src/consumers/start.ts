// core-svc Kafka 소비자를 건다(W7-audit COV2-06, F-07-12 RV-02): 플랫폼 키 단위 소비자 하나(runKeyedConsumer, 그룹 peaket.core-svc.<환경>)가
// 탈퇴 토픽과 회차 판매 상태가 실린 trade.seats를 읽는다. 토픽별 처리기는 CoreEventsHandler가 맡긴다. 보류는 core DB held_event(pid를 뺀 값)다.
// 소비자와 함께 탈퇴 후기 다시 정리 반복(review-recheck.ts, 소유자 결정 2026-11-16 OPEN[44], ADR-0278)을 켜고, 멈출 때는 반복을 먼저 멈춘다.
// 커밋이 없을 때는 가장 이른 곳부터 읽는다(플랫폼 기본, docs/streaming.md §2.6). 서비스 이름 core-svc로 소비자 지표(consumer_*)를 낸다.
// 이 파일만 Kafka 클라이언트(네이티브 모듈, @peaket/platform/stream-worker)를 싣는다.
import { type Clock, type Database, drizzleHeldEventStore, heldEventCounts, type KafkaAuth, type KeyedHandler, type Registry, systemClock } from '@peaket/platform';
import { runKeyedConsumer } from '@peaket/platform/stream-worker';
import { CORE_GROUP, CORE_TOPICS, pidFreeHeldEventStore } from './index.js';
import { type ReviewRecheckLoopOptions, startReviewRecheckLoop } from './review-recheck.js';

export interface CoreConsumersOptions {
  env: string;
  brokers: string[];
  /** `core-svc-<환경>-<파드>` */
  clientId: string;
  auth?: KafkaAuth;
  /** 소비자 전용 core_app 풀(held_event 보류·보류 수 세기). API 경로의 풀과 따로 둔다(docs/streaming.md §2.6, 리뷰 K2) */
  database: Database;
  /** topic 별 처리기를 맡기는 CoreEventsHandler(탈퇴 사건·회차 판매 상태) */
  handler: KeyedHandler<unknown>;
  registry?: Registry;
  logger?: { warn(o: object, msg?: string): void; info?(o: object, msg?: string): void };
  clock?: Clock;
  startAt?: 'earliest' | 'latest';
  /** 시험이 줄인다(기본 1초) */
  commitEveryMs?: number;
  /** 보류 수 재는 주기(기본 30초, 시험이 줄인다) */
  measureHeldEveryMs?: number;
  /** 탈퇴 후기 다시 정리 반복이 쓰는 유스케이스(처리기와 같은 소비자 전용 풀의 Reviews, docs/streaming.md §2.6). 소비자를 켜면 반복도 늘 켠다 */
  recheck: ReviewRecheckLoopOptions['reviews'];
  /** 다시 정리 반복 간격(기본 60초 [가정], 시험이 줄인다) */
  recheckEveryMs?: number;
}

export interface CoreConsumers {
  started: Promise<void>;
  stop(): Promise<void>;
}

/** 동시 처리: 파티션 1개·업무 키 2개 [가정](docs/streaming.md §2.6 'core-svc 소비자'). 사건이 몰려도 API 요청의 DB 연결을 빼앗지 않게 작게 둔다 */
const CORE_CONSUMER_MAX_KEYS = 2;
const CORE_CONSUMER_PARTITIONS = 1;

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
    maxKeys: CORE_CONSUMER_MAX_KEYS,
    partitionsConcurrently: CORE_CONSUMER_PARTITIONS,
    startAt: o.startAt,
    ...(o.commitEveryMs !== undefined ? { commitEveryMs: o.commitEveryMs } : {}),
    ...(o.measureHeldEveryMs !== undefined ? { measureHeldEveryMs: o.measureHeldEveryMs } : {}),
  });
  // 부른 쪽이 started를 기다리지 않고 stop만 불러도 처리되지 않은 거부가 남지 않게 한다
  run.started.catch(() => undefined);
  // 탈퇴 + 16분 다시 정리 반복(소비자를 켠 파드마다, 60초 [가정]). 지표는 소비자와 같은 저장소에 낸다
  const recheck = startReviewRecheckLoop({
    reviews: o.recheck,
    ...(o.recheckEveryMs !== undefined ? { everyMs: o.recheckEveryMs } : {}),
    ...(o.registry ? { registry: o.registry } : {}),
    ...(o.logger ? { logger: o.logger } : {}),
  });
  return {
    started: run.started,
    // 반복을 먼저 멈춘다(돌던 한 번이 끝날 때까지 기다린다). 그 뒤 소비자를 멈춰 처리 중인 키를 마치고 커밋한다
    stop: async () => {
      await recheck.stop();
      await run.stop();
    },
  };
}
