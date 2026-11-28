// core-svc Kafka 소비자를 건다(W7-audit COV2-06): 플랫폼 키 단위 소비자 하나(runKeyedConsumer, 그룹 peaket.core-svc.<환경>)가 탈퇴 토픽을 읽고
// ReviewAccountWithdrawnHandler가 후기를 파기하며 다시 정리를 예약한다. 보류는 core DB held_event(pid를 뺀 값, pidFreeHeldEventStore)다.
// 소비자와 함께 탈퇴 후기 다시 정리 반복(review-recheck.ts, 소유자 결정 2026-11-16 OPEN[44], ADR-0278)을 켜고, 멈출 때는 반복을 먼저 멈춘다.
// 커밋이 없을 때는 가장 이른 곳부터 읽는다(플랫폼 기본, docs/streaming.md §2.6). 서비스 이름 core-svc로 소비자 지표(consumer_*)를 낸다.
// 이 파일만 Kafka 클라이언트(네이티브 모듈, @peaket/platform/stream-worker)를 싣는다.
import { type Clock, type ConsumedMessage, type Database, drizzleHeldEventStore, heldEventCounts, type KafkaAuth, type KeyedHandler, type Registry, systemClock } from '@peaket/platform';
import { runKeyedConsumer } from '@peaket/platform/stream-worker';
import { ACCOUNTS_WITHDRAWN_TOPIC, type ReviewAccountWithdrawnHandler, type ReviewWithdrawnEvent } from '../modules/review/index.js';
import type { NotifyEventHandler, NotifyKafkaEvent } from '../modules/notify/index.js';
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
  handler: ReviewAccountWithdrawnHandler;
  /** F-06-1 notify 사건(병합·로그인 수단·주문)을 같은 그룹에서 처리한다. 시험 조립은 없이 후기만 볼 수 있다 */
  notify?: NotifyEventHandler;
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

type CoreEvent = { kind: 'review'; event: ReviewWithdrawnEvent } | { kind: 'notify'; event: NotifyKafkaEvent };

/** 한 소비자 그룹이 후기 탈퇴와 notify 사건을 함께 읽도록 주제로 갈라 처리한다 */
class CoreEventRouter implements KeyedHandler<CoreEvent> {
  constructor(
    private readonly review: ReviewAccountWithdrawnHandler,
    private readonly notify: NotifyEventHandler | undefined,
  ) {}

  decode(m: ConsumedMessage): CoreEvent {
    if (m.topic === ACCOUNTS_WITHDRAWN_TOPIC) return { kind: 'review', event: this.review.decode(m) };
    if (!this.notify) throw new Error(`알림 처리기가 조립되지 않았다: ${m.topic}`);
    return { kind: 'notify', event: this.notify.decode(m) };
  }

  keyOf(e: CoreEvent): string {
    return e.kind === 'review' ? this.review.keyOf(e.event) : this.notify!.keyOf(e.event);
  }

  handle(e: CoreEvent): Promise<void> {
    return e.kind === 'review' ? this.review.handle(e.event) : this.notify!.handle(e.event);
  }
}

export function startCoreConsumers(o: CoreConsumersOptions): CoreConsumers {
  // notify 처리기가 없으면(시험 조립·후기만) 예전처럼 탈퇴 토픽 하나와 후기 처리기만 쓴다.
  // main은 F-06-1 notify 처리기를 넘겨 네 토픽을 라우터로 함께 읽는다.
  const common = {
    service: 'core-svc',
    brokers: o.brokers,
    clientId: o.clientId,
    auth: o.auth,
    groupId: CORE_GROUP(o.env),
    held: pidFreeHeldEventStore(drizzleHeldEventStore(o.database, o.clock ?? systemClock)),
    registry: o.registry,
    ...(o.registry ? { heldCounts: () => heldEventCounts(o.database) } : {}),
    logger: o.logger,
    maxKeys: CORE_CONSUMER_MAX_KEYS,
    partitionsConcurrently: CORE_CONSUMER_PARTITIONS,
    startAt: o.startAt,
    ...(o.commitEveryMs !== undefined ? { commitEveryMs: o.commitEveryMs } : {}),
    ...(o.measureHeldEveryMs !== undefined ? { measureHeldEveryMs: o.measureHeldEveryMs } : {}),
  } as const;
  const run = o.notify
    ? runKeyedConsumer({ ...common, topics: [...CORE_TOPICS], handler: new CoreEventRouter(o.handler, o.notify) })
    : runKeyedConsumer({ ...common, topics: [ACCOUNTS_WITHDRAWN_TOPIC], handler: o.handler });
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
