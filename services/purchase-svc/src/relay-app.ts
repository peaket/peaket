// purchase-svc 릴레이 프로세스의 조립(BUILD_ORDER PRF-164, docs/features/seat-hold.md §6 '릴레이 프로세스와 조립의 첫 구현', ADR-0116).
// `purchase-svc-outbox-relay` 배포(복제 2)의 Lease 리더 하나가 Outbox 릴레이·좌석 Stream 릴레이·다시 만들기 반복·세대 올리기 감시(PRF-168)·정비 일을 함께 돈다.
// 연결(DB 셋·좌석 Redis·Kafka 생산자·Lease API)은 relay.ts가 만들어 넘기고 끝낸 뒤 닫는다. 이 파일은 시험(test-int)이 실제 의존성으로 그대로 부른다.
// 구현에서 정한 것(정본에 없다):
// - 지표: 좌석 지표(PromSeatSignals 하나, 좌석 Stream 릴레이·다시 만들기·세대 올리기 감시가 함께 쓴다)와 주문 지표(PromOrderSignals, 주문 이력 검사)를 leaderLoops가 불릴 때
//   프로세스 레지스트리에 붙인다(반복·정비 일이 돌기 전이다). 두 묶음의 다른 지표(구매 세션·재확인 대체 등)도 함께 붙어 이 프로세스에서는 0으로 보인다
// - 정비 일의 로거·좌석 저장소는 프로세스 로거가 생기는 leaderLoops에서 묶는다(정비 일은 그 전에 만들어 넘겨야 해서 위임으로 둔다)
// - 좌석맵 판 다시 읽기는 리더가 아니어도 돈다(리더가 되는 순간 판이 새것이게. 파일 상태 확인만이라 싸다)
// - 주문 만료 안전망(OrderExpirySweep, PRF-172)과 하루 넘은 주문 정비 일(orderExpiryStaleTask, 2026-11-09 코드 리뷰)의 판정기 하나는 이 둘만 부른다(고리 줄을 쓰지 않아 따로 멈추지 않는다). 구매 세션은 RedisPurchaseSessionStore.read로 읽는다(이 프로세스에는 서버 ECDH 키가 없다)
import {
  type Clock,
  type Database,
  type DatabaseOptions,
  type HotRedis,
  type LeaseApi,
  type OutboxPublisher,
  type OutboxRelayProcess,
  type OutboxRelayProcessOptions,
  type PlatformLogger,
  platformMaintenanceTasks,
  startOutboxRelayProcess,
  systemClock,
} from '@peaket/platform';
import {
  DrizzleOrderExpiry,
  DrizzleOrderStore,
  DrizzleRebuildOrders,
  InventoryOrderExpiry,
  OrderExpiry,
  orderExpiryStaleTask,
  OrderExpirySweep,
  orderHistoryCheckTask,
  PromOrderExpirySignals,
  PromOrderSignals,
} from './modules/booking/index.js';
import {
  DrizzleCancellationWrites,
  GrpcPaymentCancellations,
  RefundAfterEntry,
  refundAfterEntryTask,
} from './modules/refund/index.js';
import {
  DrizzleSeatRebuildSource,
  jsonTradeEventCodec,
  PromSeatSignals,
  RedisOrderHolds,
  RedisPurchaseSessionStore,
  RedisSeatStore,
  RedisSeatStreamSource,
  retireSeatEventsTask,
  type SaleEventCatalog,
  SeatEpochWatch,
  type SeatMap,
  SeatRebuilder,
  SeatRebuildLoop,
  SeatStreamRelay,
  type TradeEventPublisher,
} from './modules/inventory/index.js';

/** 릴레이 프로세스에서 좌석맵 판 파일을 다시 읽는 주기 30초 [가정](main.ts SEATMAP_REFRESH_MS와 같다) */
export const RELAY_SEATMAP_REFRESH_MS = 30_000;

const SERVICE = 'purchase-svc';

/** 다시 만들기 반복이 쓰는 서비스 역할 DB 풀의 연결 수 4개 [가정](docs/features/seat-hold.md §6 '릴레이 프로세스와 조립의 첫 구현' DB 역할) */
const RELAY_SERVICE_DB_MAX = 4;

/**
 * 다시 만들기 반복의 서비스 역할 DB(PEAKET_DATABASE_URL) 풀 설정(relay.ts가 createDatabase에 넘긴다, PRF-164 리뷰 고침 H1).
 * 일반 풀 모양(연결을 기다린다)·연결 RELAY_SERVICE_DB_MAX개다: 다시 만들기는 판매·원장 홀드·판매 좌석 원장 행 세 읽기를 함께 보내므로,
 * 핫패스 모양(풀 대기 100ms)·연결 2개면 큰 회차에서 하나가 늘 풀 대기 초과로 실패한다(2026-11-05 코드 리뷰)
 */
export function relayServiceDatabaseOptions(url: string): DatabaseOptions {
  return { url, profile: 'general', max: RELAY_SERVICE_DB_MAX, applicationName: `${SERVICE}-rebuild` };
}

export interface PurchaseRelayOptions {
  /** 환경 값(기본 process.env). loadOutboxRelayProcessConfig·loadPlatformConfig가 읽는다(PEAKET_POD 등) */
  env?: Record<string, string | undefined>;
  /** 프로세스·반복·정비의 시계(기본 systemClock) */
  clock?: Clock;
  /** 릴레이 역할 DB(PEAKET_OUTBOX_DATABASE_URL, Outbox 읽기·sent_at 고치기만) */
  database: Database;
  /** 정비 역할 DB(PEAKET_MAINTENANCE_DATABASE_URL, 공용 정비 일과 주문 이력 검사) */
  maintenanceDatabase: Database;
  /**
   * 서비스 역할 DB(PEAKET_DATABASE_URL, relayServiceDatabaseOptions: 일반 풀 모양·연결 4개). 다시 만들기(seat_rebuild·seat_sale·seat_hold·주문 표),
   * 다시 만들기 반복의 판매를 연 기록(seat_rebuild 행) 읽기, 주문 만료 안전망(주문·결제 시도 표)이 쓴다
   */
  serviceDatabase: Database;
  /** 좌석 Redis(API와 같은 환경 값). Stream 읽기·다시 만들기·회차 목록 빼기·주문 만료 안전망이 쓴다 */
  redis: HotRedis;
  /** 운영 좌석맵 판(LayoutSeatMap). 다시 만들기의 좌석 색인·회차 목록 빼기의 판매 종료. refresh()를 RELAY_SEATMAP_REFRESH_MS마다 부른다(멈출 때 끈다) */
  seatMap: SeatMap & { refresh(): Promise<void> };
  /** 다시 만들기 반복이 볼 회차 목록(운영은 SeatMapEventCatalog(FileSeatMapSource(PEAKET_SEATMAP_DIR), seatMap)) */
  catalog: SaleEventCatalog;
  /** Outbox 보내기(kafkaOutboxPublisher(producer)) */
  outboxPublisher: OutboxPublisher;
  /** 좌석 Stream 릴레이의 거래 토픽 보내기(KafkaTradeEventPublisher(producer), Outbox와 같은 생산자) */
  tradePublisher: TradeEventPublisher;
  /** 파드 안에서는 inClusterLeaseApi(config.leaseName) */
  leaseApi: LeaseApi;
  /** Lease 기간·갱신 한도·다시 시도(시험에서 줄인다) */
  lease?: OutboxRelayProcessOptions['lease'];
  /** 다시 만들기 임대의 holder(relay.ts는 config.pod). 세대 키 node는 좌석 Redis Lua가 구한 노드 표지다(BUILD_ORDER PRF-168) */
  holder: string;
  /** 다시 만들기 반복 틱(기본 REBUILD_LOOP_TICK_MS 5초) */
  rebuildTickMs?: number;
  /** 세대 올리기 감시 틱(기본 EPOCH_WATCH_TICK_MS 1초, 시험이 줄인다. BUILD_ORDER PRF-168) */
  epochWatchTickMs?: number;
  /** 주문 만료 안전망 틱(기본 ORDER_EXPIRY_SWEEP_INTERVAL_MS 10분 [가정], 시험이 줄인다. BUILD_ORDER PRF-172) */
  orderExpirySweepTickMs?: number;
  /** 좌석 Stream 릴레이의 쉬기(시험이 줄인다. 기본 setTimeout) */
  streamSleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** 좌석맵 판 다시 읽기 주기(기본 RELAY_SEATMAP_REFRESH_MS) */
  seatMapRefreshMs?: number;
  /** 끝낼 때 정비 일·반복을 기다리는 한도(기본 RELAY_PROCESS_DEFAULTS.stopTimeoutMs) */
  stopTimeoutMs?: number;
  logDestination?: NodeJS.WritableStream;
}

/**
 * 릴레이 프로세스를 띄운다: startOutboxRelayProcess({ service: 'purchase-svc', … })에
 * - maintenanceTasks: [...platformMaintenanceTasks(maintenanceDatabase, clock), orderHistoryCheckTask({ database: maintenanceDatabase, clock, signals: PromOrderSignals, logger }),
 *   retireSeatEventsTask({ store: new RedisSeatStore(redis, logger, clock), seatMap, logger }), orderExpiryStaleTask({ store: DrizzleOrderExpiry(serviceDatabase), expiry: OrderExpiry, clock, signals: PromOrderExpirySignals, logger })]
 * - leaderLoops: (ctx) => [new SeatStreamRelay({ source: new RedisSeatStreamSource(redis), publisher: tradePublisher, codec: jsonTradeEventCodec, signals: PromSeatSignals(ctx.registry),
 *   logger: ctx.logger, leader: ctx.leader, sleep: streamSleep }), new SeatRebuildLoop({ catalog, marks: rebuildSource, store: RedisSeatStore, rebuilder: new SeatRebuilder({ source: rebuildSource,
 *   target: RedisSeatStore, orders: new DrizzleRebuildOrders(serviceDatabase), seatMap, holder, clock, signals: PromSeatSignals }), leader: ctx.leader, clock, logger: ctx.logger, tickMs: rebuildTickMs }),
 *   new SeatEpochWatch({ store: RedisSeatStore, leader: ctx.leader, logger: ctx.logger, signals: PromSeatSignals, tickMs: epochWatchTickMs }),
 *   new OrderExpirySweep({ store: DrizzleOrderExpiry(serviceDatabase), expiry: OrderExpiry(같은 저장소, InventoryOrderExpiry(RedisPurchaseSessionStore, RedisOrderHolds(redis, seatMap))), leader: ctx.leader, clock, signals: PromOrderExpirySignals, logger: ctx.logger })]
 *   (rebuildSource = new DrizzleSeatRebuildSource(serviceDatabase): 다시 만들기의 DB 쪽이자 판매를 연 기록, 리뷰 고침 M3. 세대 올리기 감시는 PRF-168, 주문 만료 안전망은 PRF-172)
 * 를 넘긴다. 지표(seat_stream_relay_*·seat_rebuild_total·seat_epoch_bumps_total·order_history_mismatch·purchase_order_expir*·purchase_order_open_stale 등)는 프로세스 레지스트리(relay.registry, 관리 포트 /metrics)에 붙는다.
 * 돌려준 프로세스의 stop()은 좌석맵 판 다시 읽기도 끈다. 연결은 닫지 않는다(relay.ts의 몫)
 * @throws PlatformConfigError 릴레이 설정이 빠짐(loadOutboxRelayProcessConfig) · Error 반복 이름 겹침(설정 실수)
 */
export async function startPurchaseRelay(o: PurchaseRelayOptions): Promise<OutboxRelayProcess> {
  const clock = o.clock ?? systemClock;
  const seatSignals = new PromSeatSignals();
  const orderSignals = new PromOrderSignals();
  const orderExpirySignals = new PromOrderExpirySignals();

  // 프로세스 로거와 그 로거를 쓰는 좌석 저장소·주문 만료 판정기는 leaderLoops가 불릴 때 생긴다(startOutboxRelayProcess가 정비 실행기를 켜기 전에 한 번 부른다)
  type LateBound = { logger: PlatformLogger; store: RedisSeatStore; orderExpiryStore: DrizzleOrderExpiry; orderExpiry: OrderExpiry };
  let late: LateBound | undefined;
  const bound = (): LateBound => {
    if (!late) throw new Error('purchase-svc 릴레이: 프로세스 로거가 아직 없다(leaderLoops 전에 정비 일이 불렸다)');
    return late;
  };
  const taskLogger = {
    warn: (obj: object, msg?: string) => bound().logger.warn(obj, msg),
    info: (obj: object, msg?: string) => bound().logger.info(obj, msg),
  };

  // 입장 기록 마감 뒤 환급(GAT-080). 결제사 주소가 없으면(로컬·CI) 이 일을 띄우지 않는다
  const paymentCancelAddress = o.env?.PEAKET_PAYMENT_GRPC_ADDR;
  const paymentCancels = paymentCancelAddress ? new GrpcPaymentCancellations({ address: paymentCancelAddress }) : undefined;
  const refundAfterEntry = paymentCancels
    ? new RefundAfterEntry({ writes: new DrizzleCancellationWrites(o.serviceDatabase), payments: paymentCancels, nowMs: () => clock.now() })
    : undefined;
  const relay = await startOutboxRelayProcess({
    service: SERVICE,
    env: o.env,
    clock,
    database: o.database,
    maintenanceDatabase: o.maintenanceDatabase,
    publisher: o.outboxPublisher,
    leaseApi: o.leaseApi,
    lease: o.lease,
    stopTimeoutMs: o.stopTimeoutMs,
    logDestination: o.logDestination,
    // 공용 정비 일, 매일 주문 상태·이력 검사(정비 시간 창, docs/features/payment.md §3), 회차 목록 빼기(하루 한 번), 하루 넘은 열린 주문 다시 판정(정비 시간 창, payment §2 안전망 ③)
    maintenanceTasks: [
      ...platformMaintenanceTasks(o.maintenanceDatabase, clock),
      orderHistoryCheckTask({ database: o.maintenanceDatabase, clock, signals: orderSignals, logger: taskLogger }),
      retireSeatEventsTask({
        store: { saleEvents: () => bound().store.saleEvents(), retireEvent: (i) => bound().store.retireEvent(i) },
        seatMap: o.seatMap,
        logger: taskLogger,
      }),
      orderExpiryStaleTask({
        store: { staleOrderBatch: (r) => bound().orderExpiryStore.staleOrderBatch(r) },
        expiry: { check: (orderId, trigger) => bound().orderExpiry.check(orderId, trigger) },
        clock,
        signals: orderExpirySignals,
        logger: taskLogger,
      }),
      ...(refundAfterEntry ? [refundAfterEntryTask(refundAfterEntry, taskLogger)] : []),
    ],
    leaderLoops: (ctx) => {
      seatSignals.register(ctx.registry);
      orderSignals.register(ctx.registry);
      orderExpirySignals.register(ctx.registry);
      const store = new RedisSeatStore(o.redis, ctx.logger, ctx.clock);
      // 다시 만들기의 DB 쪽(임대·판 번호·읽기)이자 판매를 연 기록(seat_rebuild 행). 기록이 있는 회차만 다시 만든다(리뷰 고침 M3)
      const rebuildSource = new DrizzleSeatRebuildSource(o.serviceDatabase);
      // 주문 만료 안전망·하루 넘은 주문 정비 일(PRF-172, ADR-0107 결정 2): 서비스 역할 DB·좌석 Redis·좌석맵 판
      const orderExpiryStore = new DrizzleOrderExpiry({ database: o.serviceDatabase, store: new DrizzleOrderStore({ clock: ctx.clock }), clock: ctx.clock });
      const orderExpiry = new OrderExpiry({
        store: orderExpiryStore,
        inventory: new InventoryOrderExpiry({ sessions: new RedisPurchaseSessionStore(o.redis), holds: new RedisOrderHolds(o.redis, o.seatMap), clock: ctx.clock }),
        signals: orderExpirySignals,
        clock: ctx.clock,
        logger: ctx.logger,
      });
      late = { logger: ctx.logger, store, orderExpiryStore, orderExpiry };
      return [
        new SeatStreamRelay({
          source: new RedisSeatStreamSource(o.redis),
          publisher: o.tradePublisher,
          codec: jsonTradeEventCodec,
          signals: seatSignals,
          logger: ctx.logger,
          leader: ctx.leader,
          ...(o.streamSleep ? { sleep: o.streamSleep } : {}),
        }),
        new SeatRebuildLoop({
          catalog: o.catalog,
          marks: rebuildSource,
          store,
          rebuilder: new SeatRebuilder({
            source: rebuildSource,
            target: store,
            orders: new DrizzleRebuildOrders(o.serviceDatabase),
            seatMap: o.seatMap,
            holder: o.holder,
            clock: ctx.clock,
            signals: seatSignals,
          }),
          leader: ctx.leader,
          clock: ctx.clock,
          logger: ctx.logger,
          ...(o.rebuildTickMs !== undefined ? { tickMs: o.rebuildTickMs } : {}),
        }),
        // 세대 올리기 감시(PRF-168): 회차 목록의 회차마다 세대 올리기 Lua를 불러, 그 슬롯의 주 노드가 바뀌었으면(장애 조치) 세대를 올린다
        new SeatEpochWatch({
          store,
          leader: ctx.leader,
          logger: ctx.logger,
          signals: seatSignals,
          ...(o.epochWatchTickMs !== undefined ? { tickMs: o.epochWatchTickMs } : {}),
        }),
        new OrderExpirySweep({
          store: orderExpiryStore,
          expiry: orderExpiry,
          leader: ctx.leader,
          clock: ctx.clock,
          signals: orderExpirySignals,
          logger: ctx.logger,
          ...(o.orderExpirySweepTickMs !== undefined ? { tickMs: o.orderExpirySweepTickMs } : {}),
        }),
      ];
    },
  });

  // 좌석맵 판 다시 읽기(실패는 LayoutSeatMap이 경고 한 줄로 남기고 이전 판을 둔다). 프로세스 종료를 붙잡지 않게 unref
  const refresh = setInterval(() => void o.seatMap.refresh().catch(() => undefined), o.seatMapRefreshMs ?? RELAY_SEATMAP_REFRESH_MS);
  refresh.unref();

  return {
    config: relay.config,
    registry: relay.registry,
    isLeader: () => relay.isLeader(),
    listen: (host) => relay.listen(host),
    stop: () => {
      clearInterval(refresh);
      paymentCancels?.close();
      return relay.stop();
    },
  };
}
