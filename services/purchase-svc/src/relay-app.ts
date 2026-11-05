// purchase-svc 릴레이 프로세스의 조립(BUILD_ORDER PRF-164, docs/features/seat-hold.md §6 '릴레이 프로세스와 조립의 첫 구현', ADR-0116).
// `purchase-svc-outbox-relay` 배포(복제 2)의 Lease 리더 하나가 Outbox 릴레이·좌석 Stream 릴레이·다시 만들기 반복·정비 일을 함께 돈다.
// 연결(DB 셋·좌석 Redis·Kafka 생산자·Lease API)은 relay.ts가 만들어 넘기고 끝낸 뒤 닫는다. 이 파일은 시험(test-int)이 실제 의존성으로 그대로 부른다.
// 구현에서 정한 것(정본에 없다):
// - 지표: 좌석 지표(PromSeatSignals 하나, 좌석 Stream 릴레이와 다시 만들기가 함께 쓴다)와 주문 지표(PromOrderSignals, 주문 이력 검사)를 leaderLoops가 불릴 때
//   프로세스 레지스트리에 붙인다(반복·정비 일이 돌기 전이다). 두 묶음의 다른 지표(구매 세션·재확인 대체 등)도 함께 붙어 이 프로세스에서는 0으로 보인다
// - 정비 일의 로거·좌석 저장소는 프로세스 로거가 생기는 leaderLoops에서 묶는다(정비 일은 그 전에 만들어 넘겨야 해서 위임으로 둔다)
// - 좌석맵 판 다시 읽기는 리더가 아니어도 돈다(리더가 되는 순간 판이 새것이게. 파일 상태 확인만이라 싸다)
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
import { DrizzleRebuildOrders, orderHistoryCheckTask, PromOrderSignals } from './modules/booking/index.js';
import {
  DrizzleSeatRebuildSource,
  jsonTradeEventCodec,
  PromSeatSignals,
  RedisSeatStore,
  RedisSeatStreamSource,
  retireSeatEventsTask,
  type SaleEventCatalog,
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
   * 서비스 역할 DB(PEAKET_DATABASE_URL, relayServiceDatabaseOptions: 일반 풀 모양·연결 4개). 다시 만들기(seat_rebuild·seat_sale·seat_hold·주문 표)와
   * 다시 만들기 반복의 판매를 연 기록(seat_rebuild 행) 읽기가 쓴다
   */
  serviceDatabase: Database;
  /** 좌석 Redis(API와 같은 환경 값). Stream 읽기·다시 만들기·회차 목록 빼기가 쓴다 */
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
  /** 다시 만들기 임대의 holder이자 세대 키 node(relay.ts는 config.pod) */
  holder: string;
  /** 다시 만들기 반복 틱(기본 REBUILD_LOOP_TICK_MS 5초) */
  rebuildTickMs?: number;
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
 *   retireSeatEventsTask({ store: new RedisSeatStore(redis, logger, clock), seatMap, logger })]
 * - leaderLoops: (ctx) => [new SeatStreamRelay({ source: new RedisSeatStreamSource(redis), publisher: tradePublisher, codec: jsonTradeEventCodec, signals: PromSeatSignals(ctx.registry),
 *   logger: ctx.logger, leader: ctx.leader, sleep: streamSleep }), new SeatRebuildLoop({ catalog, marks: rebuildSource, store: RedisSeatStore, rebuilder: new SeatRebuilder({ source: rebuildSource,
 *   target: RedisSeatStore, orders: new DrizzleRebuildOrders(serviceDatabase), seatMap, holder, clock, signals: PromSeatSignals }), leader: ctx.leader, clock, logger: ctx.logger, tickMs: rebuildTickMs })]
 *   (rebuildSource = new DrizzleSeatRebuildSource(serviceDatabase): 다시 만들기의 DB 쪽이자 판매를 연 기록, 리뷰 고침 M3)
 * 를 넘긴다. 지표(seat_stream_relay_*·seat_rebuild_total·order_history_mismatch 등)는 프로세스 레지스트리(relay.registry, 관리 포트 /metrics)에 붙는다.
 * 돌려준 프로세스의 stop()은 좌석맵 판 다시 읽기도 끈다. 연결은 닫지 않는다(relay.ts의 몫)
 * @throws PlatformConfigError 릴레이 설정이 빠짐(loadOutboxRelayProcessConfig) · Error 반복 이름 겹침(설정 실수)
 */
export async function startPurchaseRelay(o: PurchaseRelayOptions): Promise<OutboxRelayProcess> {
  const clock = o.clock ?? systemClock;
  const seatSignals = new PromSeatSignals();
  const orderSignals = new PromOrderSignals();

  // 프로세스 로거와 그 로거를 쓰는 좌석 저장소는 leaderLoops가 불릴 때 생긴다(startOutboxRelayProcess가 정비 실행기를 켜기 전에 한 번 부른다)
  let late: { logger: PlatformLogger; store: RedisSeatStore } | undefined;
  const bound = (): { logger: PlatformLogger; store: RedisSeatStore } => {
    if (!late) throw new Error('purchase-svc 릴레이: 프로세스 로거가 아직 없다(leaderLoops 전에 정비 일이 불렸다)');
    return late;
  };
  const taskLogger = {
    warn: (obj: object, msg?: string) => bound().logger.warn(obj, msg),
    info: (obj: object, msg?: string) => bound().logger.info(obj, msg),
  };

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
    // 공용 정비 일, 매일 주문 상태·이력 검사(정비 시간 창, docs/features/payment.md §3), 회차 목록 빼기(하루 한 번)
    maintenanceTasks: [
      ...platformMaintenanceTasks(o.maintenanceDatabase, clock),
      orderHistoryCheckTask({ database: o.maintenanceDatabase, clock, signals: orderSignals, logger: taskLogger }),
      retireSeatEventsTask({
        store: { saleEvents: () => bound().store.saleEvents(), retireEvent: (i) => bound().store.retireEvent(i) },
        seatMap: o.seatMap,
        logger: taskLogger,
      }),
    ],
    leaderLoops: (ctx) => {
      seatSignals.register(ctx.registry);
      orderSignals.register(ctx.registry);
      const store = new RedisSeatStore(o.redis, ctx.logger, ctx.clock);
      late = { logger: ctx.logger, store };
      // 다시 만들기의 DB 쪽(임대·판 번호·읽기)이자 판매를 연 기록(seat_rebuild 행). 기록이 있는 회차만 다시 만든다(리뷰 고침 M3)
      const rebuildSource = new DrizzleSeatRebuildSource(o.serviceDatabase);
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
      return relay.stop();
    },
  };
}
