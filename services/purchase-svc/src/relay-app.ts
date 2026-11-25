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
  Counter,
  type Database,
  type DatabaseOptions,
  type HotRedis,
  type LeaseApi,
  type OutboxPublisher,
  type OutboxRelayProcess,
  type OutboxRelayProcessOptions,
  type PlatformLogger,
  platformMaintenanceTasks,
  createExternalHttpClient,
  internalGrpcTokenFromEnv,
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
  SeatMapSaleConfigs,
  CancelCompensation,
  CompensationLoop,
  CompensationRunner,
  DrizzleCompensation,
  EventCompensationQueue,
  FenceCompensation,
  GrpcPaymentCompensator,
  GrpcTicketFence,
  LoggerCompensationLog,
  PromCompensationSignals,
  StartCompensation,
  type AvroOrderEventCodec,
} from './modules/booking/index.js';
import {
  CancelTicket,
  CancelTicketEventRefund,
  DrizzleCancellationOrders,
  DrizzleCancellationWrites,
  DrizzleCsCaseOutbox,
  DrizzleDeductionGapCancellations,
  DrizzleEventOpenOrders,
  DrizzleEventRefundAttempts,
  DrizzleEventRefundClaims,
  DrizzleEventRefundHolds,
  DrizzleEventRefundStore,
  DrizzleEventRefundTargets,
  DrizzlePendingCancellationConversions,
  DrizzleSeatReturns,
  EVENT_REFUND_TICKET_DEADLINE_MS,
  EntryCloseDueLoop,
  EntryCloseDueTick,
  EventRefundCancellerRouter,
  EventRefundLoop,
  EventRefundService,
  EventTicketCanceller,
  GrpcPaymentCancellations,
  GrpcTicketCancellations,
  GrpcTransferWithdrawals,
  HttpCoreEntryCloseTimes,
  HttpDeductionGapNotice,
  HttpEntryFlagNotice,
  HttpEventRefundAlert,
  HttpPgCircuits,
  DrizzleCompensations,
  eventRefundPgRateOf,
  GrpcCompensationTransfer,
  HttpCompensationCaseNotice,
  HttpSettlementRecalculation,
  PgTokenBuckets,
  RefreshCompensationTransfers,
  unsentSettlementRecalculation,
  HttpRefundAccountNotice,
  HttpRefundFailureNotice,
  OutboxEventRefundFanNotifier,
  PromCsCaseSignals,
  PromRefundAccountSignals,
  RedisSeatReturnNotices,
  RefundAfterEntry,
  RefundRetryLoop,
  WeekendBusinessCalendar,
} from './modules/refund/index.js';
import { entryRecordsFromEnv, requireOpsInternalToken } from './refund-wiring.js';
import {
  DrizzleSeatRebuildSource,
  DrizzleSeatSales,
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
  /**
   * 주문 사건 값의 코덱(relay.ts는 공용 Avro 인코더의 avroOrderEventCodec, ADR-0357). 주문 만료 안전망·보상·환불 쓰기와 회차 환급 팬 알림이 trade.orders Outbox에 넣는 값이다.
   * 주지 않으면 저장소 기본값(JSON 대역, 시험 조립)이다
   */
  orderEventCodec?: AvroOrderEventCodec;
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
  /** 환급 재시도 반복 틱(기본 REFUND_RETRY_TICK_MS 1분, 시험이 줄인다. GAT-090) */
  refundRetryTickMs?: number;
  /** 회차 취소 일괄 환불 실행기 틱(기본 EVENT_REFUND_TICK_MS 10초, 시험이 줄인다. GAT-130) */
  eventRefundTickMs?: number;
  /** 입장 기록 마감 환급 잇기 틱(기본 ENTRY_CLOSE_DUE_EVERY_MS 1분, 시험이 줄인다. GAT-180) */
  entryCloseDueEveryMs?: number;
  /** 보상 세 걸음 실행기 틱(기본 COMPENSATION_LOOP_TICK_MS 1초, 시험이 줄인다. BAT-011) */
  compensationTickMs?: number;
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
  const opsUrl = o.env?.PEAKET_OPS_HTTP_URL;
  // ops 주소가 있는데 내부 토큰이 없으면 운영은 시작하지 않는다(모든 CS 건이 401로 막힘, 웨이브 끝 리뷰 S1). local·ci는 경고(로거가 생기면 남긴다)
  const startupWarnings: string[] = [];
  requireOpsInternalToken({ env: o.env ?? {}, warn: (m) => void startupWarnings.push(m) });
  // 환급 실패 CS 건은 2xx를 받아야 연 것이고 내부 토큰은 생성자로 넘긴다(다시 보기 2 N2). 다시 열기 포트가 꽂히면 틱 끝에서만 연다(N1)
  const refundFailureNotice = opsUrl
    ? new HttpRefundFailureNotice(createExternalHttpClient({ provider: 'ops-svc', baseUrl: opsUrl, timeoutCapMs: 5_000 }), o.env?.PEAKET_INTERNAL_TOKEN)
    : {
        open: async (q: { cancellationId: string; attempts: number; lastError: string }) =>
          taskLogger.warn({ event: 'cancellation_refund_failed', cancellationId: q.cancellationId, attempts: q.attempts, error: q.lastError }, '환급 재시도 소진·업무 거절(CS 처리함 주소 없음)'),
      };
  // ticket-svc는 마감 뒤 환급 전 입장 기록 대조(GAT-090)와 회차 취소 일괄 환불(GAT-130·GAT-110)이 함께 쓴다
  const ticketGrpcAddr = o.env?.PEAKET_TICKET_GRPC_ADDR;
  // EventCancelTickets·GetEntryRecords는 내부 토큰·호출자 purchase-svc로 묶인다(BAT-420 리뷰 D4). 운영에서 토큰이 없으면 시작 실패다(local·ci는 없음)
  const ticketGrpcToken = ticketGrpcAddr ? internalGrpcTokenFromEnv(o.env ?? {}) : undefined;
  const refundTicketCancels = ticketGrpcAddr ? new GrpcTicketCancellations({ address: ticketGrpcAddr, ...(ticketGrpcToken ? { internalToken: ticketGrpcToken } : {}) }) : undefined;
  const refundTransfers = ticketGrpcAddr ? new GrpcTransferWithdrawals({ address: ticketGrpcAddr, ...(ticketGrpcToken ? { internalToken: ticketGrpcToken } : {}) }) : undefined;
  const opsClient = opsUrl ? createExternalHttpClient({ provider: 'ops-svc', baseUrl: opsUrl, timeoutCapMs: 5_000 }) : undefined;
  const refundWrites = new DrizzleCancellationWrites(o.serviceDatabase, new DrizzleOrderStore({ clock, ...(o.orderEventCodec ? { codec: o.orderEventCodec } : {}) }));
  // 열지 못한 이상 표시·공제 차액 CS 건 다시 열기(웨이브 끝 리뷰 C2·S1). ops 주소가 있을 때만 꽂는다(로그 대역이 '연 것'으로 남지 않게, 주소가 생기면 그때 연다)
  const csOutbox = opsClient ? new DrizzleCsCaseOutbox(o.serviceDatabase) : undefined;
  // CS 건 열기 실패·다시 열기 멈춤 지표(purchase_cs_case_open_failures_total{kind}·purchase_cs_case_reopen_cut_total{reason}, 다시 보기 2 N1).
  // 두 실행기의 틱 끝 다시 열기가 함께 쓰고, leaderLoops에서 프로세스 레지스트리에 붙인다
  const csCaseSignals = new PromCsCaseSignals();
  const refundSignals = new PromRefundAccountSignals();
  // BAT-425 GAT-120: 결제사 서킷 읽기(payment-svc 내부 HTTP). 주소가 없으면 local·ci는 늘 거짓이고 그 밖은 시작 실패다
  const paymentHttpUrl = o.env?.PEAKET_PAYMENT_HTTP_URL;
  const pgCircuits = paymentHttpUrl
    ? new HttpPgCircuits({
        client: createExternalHttpClient({ provider: 'payment-svc', baseUrl: paymentHttpUrl, timeoutCapMs: 3_000 }),
        ...(o.env?.PEAKET_INTERNAL_TOKEN ? { internalToken: o.env.PEAKET_INTERNAL_TOKEN } : {}),
        nowMs: () => clock.now(),
        log: { warn: (obj: object, msg: string) => bound().logger.warn(obj, msg) },
      })
    : undefined;
  if (!paymentHttpUrl && o.env?.PEAKET_ENV !== 'local' && o.env?.PEAKET_ENV !== 'ci' && o.env?.PEAKET_ENV !== 'demo') {
    throw new Error('PEAKET_PAYMENT_HTTP_URL이 없다(회차 취소 서킷 읽기, 운영 필수)');
  }
  // F-07-8(ADR-0380 결정 2): 정산 다시 계산 알리기(payment-svc 내부 HTTP, 한도 3초 [가정]). 주소가 없으면 local·ci·test·demo만 '보내지 않음' 대역이고 그 밖은 시작 실패다
  const settlementRecalculation = paymentHttpUrl
    ? new HttpSettlementRecalculation(createExternalHttpClient({ provider: 'payment-svc', baseUrl: paymentHttpUrl, timeoutCapMs: 3_000 }), o.env?.PEAKET_INTERNAL_TOKEN)
    : unsentSettlementRecalculation(o.env?.PEAKET_ENV, (obj, msg) => bound().logger.warn(obj, msg));
  // F-07-8 I-07(R-T52): 결제사 몫마다 토큰 버킷(초당·최대 PEAKET_EVENT_REFUND_PG_RATE, 기본 300 [가정]). 버킷은 이 프로세스 것이다(C-01)
  const eventRefundPgRate = eventRefundPgRateOf(o.env?.PEAKET_EVENT_REFUND_PG_RATE);
  const eventRefundBuckets = new PgTokenBuckets({ ratePerSecond: eventRefundPgRate, burst: eventRefundPgRate, clock });
  // F-07-8 I-06(R-T47 ③): 틱 끝의 배상 송금 결과 확정. payment-svc 배상 송금 gRPC(GetCompensationTransfer)가 있을 때만 만든다
  const compensationLookup = paymentCancelAddress ? new GrpcCompensationTransfer({ address: paymentCancelAddress }) : undefined;
  // 입장 기록이 나온 취소의 CS '이상 표시'. ops-svc 주소가 없으면 로그 대역이다
  const entryFlagNotice = opsClient
    ? new HttpEntryFlagNotice(opsClient, o.env?.PEAKET_INTERNAL_TOKEN)
    : {
        open: async (q: { cancellationId: string; enteredAtMs: number }) =>
          taskLogger.warn({ event: 'cancellation_entry_recorded', cancellationId: q.cancellationId, enteredAtMs: q.enteredAtMs }, '취소한 표에 입장 기록이 있다(CS 처리함 주소 없음)'),
      };
  // 마감 뒤 환급 전 입장 기록 대조(BAT-420 GAT-090 A6): ticket-svc 주소가 없으면 local·ci만 대역이고 그 밖은 시작 실패다
  const refundAfterEntry = paymentCancels
    ? new RefundAfterEntry({
        writes: refundWrites,
        payments: paymentCancels,
        nowMs: () => clock.now(),
        failureNotice: refundFailureNotice,
        entries: entryRecordsFromEnv({ env: o.env ?? {}, ...(refundTicketCancels ? { tickets: refundTicketCancels } : {}) }),
        claims: refundWrites,
        flags: entryFlagNotice,
        ...(csOutbox ? { csOutbox } : {}),
        csCaseOpenFailures: csCaseSignals,
        // 기한 지난 환급 미룸 풀기와 SEV2(BAT-420 몫 D), 0행 쓰기 뒤 다시 읽기(VOIDED만 SEV1, BAT-420 리뷰 D1)
        holds: new DrizzleEventRefundHolds(o.serviceDatabase),
        orders: new DrizzleCancellationOrders(o.serviceDatabase, new SeatMapSaleConfigs(o.seatMap)),
        log: { warn: (obj: object, msg: string) => bound().logger.warn(obj, msg), error: (obj: object, msg: string) => bound().logger.error(obj, msg) },
        // 가상계좌 계좌 대기의 CS '환불 대기' 건(BUILD_ORDER GAT-090). ops 주소가 있을 때만 틱 끝 다시 열기가 연다
        ...(opsClient ? { accountNotice: new HttpRefundAccountNotice(opsClient, o.env?.PEAKET_INTERNAL_TOKEN) } : {}),
      })
    : undefined;
  // 확정 때 남는 공제 차액 CS 건(BAT-420 몫 D). ops-svc 주소가 없으면 로그 대역이다
  const deductionGapNotice = opsClient
    ? new HttpDeductionGapNotice(opsClient, o.env?.PEAKET_INTERNAL_TOKEN)
    : {
        open: async (q: { cancellationId: string; requestId: string }) =>
          taskLogger.warn({ event: 'event_refund_deduction_gap', cancellationId: q.cancellationId, requestId: q.requestId }, '회차 취소 확정 때 남는 공제 차액(CS 처리함 주소 없음)'),
      };
  // 보상 세 걸음(BAT-011, PRF-173, ADR-0354): 발권 대기(APPROVED) 주문을 회차 취소 실행기가 쓸어 담는다.
  // 보상 저장소·큐는 API 파드와 같은 표(order_compensation)를 쓰고, 실행기는 릴레이 리더만 돈다(CompensationLoop).
  const compensationSignals = new PromCompensationSignals();
  const compensationJobs = new DrizzleCompensation({ database: o.serviceDatabase, store: new DrizzleOrderStore({ clock, ...(o.orderEventCodec ? { codec: o.orderEventCodec } : {}) }), clock });
  const compensationStart = new StartCompensation({ store: compensationJobs, clock, signals: compensationSignals });
  const compensationQueue = new EventCompensationQueue({ jobs: compensationJobs, start: compensationStart });
  // 발권 막기·결제 취소는 주소가 있을 때만 만든다(없으면 eventRefund도 만들지 않는다)
  const compensationFence = ticketGrpcAddr ? new GrpcTicketFence({ address: ticketGrpcAddr, ...(ticketGrpcToken ? { internalToken: ticketGrpcToken } : {}) }) : undefined;
  const compensationPayment = paymentCancelAddress ? new GrpcPaymentCompensator({ address: paymentCancelAddress }) : undefined;
  // 회차 취소 일괄 환불 실행기(BAT-425 GAT-130, BAT-420 GAT-110). ticket-svc·payment-svc 주소가 있을 때만 만든다.
  // API 파드의 Start가 첫 묶음만 처리하고, 나머지와 재시도·신청 창 닫기·확정 뒤 끝난 주문 쓸어 담기를 이 릴레이 리더가 이어 간다.
  // 회차 취소(CANCEL)는 전용 취소기(견적·좌석 되돌림 없음, 보류 취소 전환), 연기(POSTPONE) 신청 환급은 예매 취소 Saga로 간다(ADR-0280 결정 3).
  const eventRefund =
    refundTicketCancels && paymentCancels && compensationLookup
      ? new EventRefundService({
          store: new DrizzleEventRefundStore(o.serviceDatabase, clock),
          targets: new DrizzleEventRefundTargets(o.serviceDatabase, new SeatMapSaleConfigs(o.seatMap)),
          items: new DrizzleEventRefundStore(o.serviceDatabase, clock),
          openOrders: new DrizzleEventOpenOrders(o.serviceDatabase),
          // 확정 때 남는 공제 차액 CS 건(BAT-420 몫 D, OPEN[45]): 입장 시작은 회차 판매 설정에서 읽는다
          gaps: new DrizzleDeductionGapCancellations(o.serviceDatabase),
          gapNotice: deductionGapNotice,
          configs: new SeatMapSaleConfigs(o.seatMap),
          ...(refundTransfers ? { transfers: refundTransfers } : {}),
          // API 파드의 Start·Resume·Apply·CloseWindow와 겹쳐도 주문 단위 잡기를 거친 쪽만 처리한다(웨이브 끝 리뷰 K2)
          claims: new DrizzleEventRefundClaims(o.serviceDatabase, clock),
          // 확정·항목 끝내기 때 표시한 차액 건은 이 실행기 틱이 행마다 연다(C2·S1). ops 주소가 없으면 꽂지 않아 차액 건은 표시와 함께 로그 대역으로 간다
          ...(csOutbox ? { csOutbox } : {}),
          csCaseOpenFailures: csCaseSignals,
          log: { warn: (obj: object, msg: string) => bound().logger.warn(obj, msg) },
          ...(pgCircuits ? { circuitOpen: (pg) => pgCircuits!.circuitOpen(pg) } : {}),
          circuitPauses: { inc: (pg) => refundSignals.circuitPause(pg) },
          canceller: new EventRefundCancellerRouter({
            cancel: new EventTicketCanceller({
              tickets: refundTicketCancels,
              conversions: new DrizzlePendingCancellationConversions(o.serviceDatabase),
              orders: new DrizzleCancellationOrders(o.serviceDatabase, new SeatMapSaleConfigs(o.seatMap)),
              writes: refundWrites,
              payments: paymentCancels,
              calendar: new WeekendBusinessCalendar(),
            }),
            postpone: new CancelTicketEventRefund(
              new CancelTicket({
                orders: new DrizzleCancellationOrders(o.serviceDatabase, new SeatMapSaleConfigs(o.seatMap)),
                writes: refundWrites,
                tickets: refundTicketCancels,
                payments: paymentCancels,
                seats: new DrizzleSeatReturns(new DrizzleSeatSales(o.serviceDatabase), o.seatMap, new RedisSeatReturnNotices(o.redis)),
                calendar: new WeekendBusinessCalendar(),
              }),
            ),
          }),
          attempts: new DrizzleEventRefundAttempts(o.serviceDatabase),
          fanNotifier: new OutboxEventRefundFanNotifier(o.orderEventCodec),
          ...(opsClient ? { notice: new HttpRefundFailureNotice(opsClient, o.env?.PEAKET_INTERNAL_TOKEN), alert: new HttpEventRefundAlert(opsClient) } : {}),
          nowMs: () => clock.now(),
          deadlineMs: () => clock.now() + EVENT_REFUND_TICKET_DEADLINE_MS,
          concurrency: 8,
          batchSize: 200,
          // 발권 대기(APPROVED) 주문은 보상 세 걸음으로 끝낸다(BAT-011, PRF-173). 보상이 끝날 때까지 요청은 RUNNING이다
          ...(compensationFence && compensationPayment ? { compensation: compensationQueue } : {}),
          // F-07-8: 정산 알리기 다시 하기·결제사별 토큰 버킷·틱 끝 배상 송금 결과 확정
          settlement: settlementRecalculation,
          buckets: eventRefundBuckets,
          compensationRefresh: new RefreshCompensationTransfers({
            store: new DrizzleCompensations(o.serviceDatabase),
            transfer: compensationLookup,
            ...(opsClient ? { cases: new HttpCompensationCaseNotice(opsClient, o.env?.PEAKET_INTERNAL_TOKEN) } : {}),
            clock,
            log: { warn: (obj: object, msg: string) => bound().logger.warn(obj, msg) },
          }),
        })
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
    ],
    leaderLoops: (ctx) => {
      seatSignals.register(ctx.registry);
      orderSignals.register(ctx.registry);
      orderExpirySignals.register(ctx.registry);
      csCaseSignals.register(ctx.registry);
      refundSignals.register(ctx.registry);
      compensationSignals.register(ctx.registry);
      if (pgCircuits) void pgCircuits.refresh();
      // 보상 실행기는 프로세스 로거가 생긴 뒤(리더 반복 안)에 만든다. 발권 막기·결제 취소 클라이언트가 둘 다 있을 때만 돈다
      const compensationLoop =
        compensationFence && compensationPayment
          ? new CompensationLoop({
              runner: new CompensationRunner({
                jobs: compensationJobs,
                fence: new FenceCompensation({ store: compensationJobs, fence: compensationFence, clock: ctx.clock, log: new LoggerCompensationLog(ctx.logger), signals: compensationSignals }),
                cancel: new CancelCompensation({ store: compensationJobs, payments: compensationPayment, clock: ctx.clock, log: new LoggerCompensationLog(ctx.logger), signals: compensationSignals }),
                log: new LoggerCompensationLog(ctx.logger),
                signals: compensationSignals,
                clock: ctx.clock,
              }),
              leader: ctx.leader,
              logger: ctx.logger,
              ...(o.compensationTickMs !== undefined ? { tickMs: o.compensationTickMs } : {}),
            })
          : undefined;
      const store = new RedisSeatStore(o.redis, ctx.logger, ctx.clock);
      // 다시 만들기의 DB 쪽(임대·판 번호·읽기)이자 판매를 연 기록(seat_rebuild 행). 기록이 있는 회차만 다시 만든다(리뷰 고침 M3)
      const rebuildSource = new DrizzleSeatRebuildSource(o.serviceDatabase);
      // 주문 만료 안전망·하루 넘은 주문 정비 일(PRF-172, ADR-0107 결정 2): 서비스 역할 DB·좌석 Redis·좌석맵 판
      const orderExpiryStore = new DrizzleOrderExpiry({ database: o.serviceDatabase, store: new DrizzleOrderStore({ clock: ctx.clock, ...(o.orderEventCodec ? { codec: o.orderEventCodec } : {}) }), clock: ctx.clock });
      const orderExpiry = new OrderExpiry({
        store: orderExpiryStore,
        inventory: new InventoryOrderExpiry({ sessions: new RedisPurchaseSessionStore(o.redis), holds: new RedisOrderHolds(o.redis, o.seatMap), clock: ctx.clock }),
        signals: orderExpirySignals,
        clock: ctx.clock,
        logger: ctx.logger,
      });
      late = { logger: ctx.logger, store, orderExpiryStore, orderExpiry };
      for (const m of startupWarnings.splice(0)) ctx.logger.warn({ event: 'purchase-ops-internal-token-missing' }, m);
      // 입장 기록 마감 환급 잇기(offline-gate §7.3 '환급 잇기'). core 주소가 없으면 local·ci에서 이 일을 켜지 않는다
      const coreHttpUrl = o.env?.PEAKET_CORE_HTTP_URL;
      const entryCloseDue = coreHttpUrl
        ? (() => {
            const counter = new Counter({
              name: 'purchase_entry_close_due_total',
              help: '입장 기록 마감 환급 잇기 결과 수(result: moved·not_closed·unavailable, offline-gate §7.4)',
              labelNames: ['result'],
              registers: [ctx.registry],
            });
            for (const result of ['moved', 'not_closed', 'unavailable'] as const) counter.inc({ result }, 0);
            return new EntryCloseDueLoop({
              tick: new EntryCloseDueTick({
                store: refundWrites,
                closes: new HttpCoreEntryCloseTimes({
                  client: createExternalHttpClient({ provider: 'core-svc', baseUrl: coreHttpUrl, timeoutCapMs: 2_000, clock: ctx.clock }),
                  ...(o.env?.PEAKET_INTERNAL_TOKEN ? { internalToken: o.env.PEAKET_INTERNAL_TOKEN } : {}),
                }),
                nowMs: () => ctx.clock.now(),
                metrics: { inc: ({ result }) => counter.inc({ result }) },
              }),
              leader: ctx.leader,
              logger: ctx.logger,
              ...(o.entryCloseDueEveryMs !== undefined ? { tickMs: o.entryCloseDueEveryMs } : {}),
            });
          })()
        : undefined;
      if (!entryCloseDue) ctx.logger.warn({ kind: 'entry-close-due-off' }, 'PEAKET_CORE_HTTP_URL이 없어 입장 기록 마감 환급 잇기를 켜지 않는다(GAT-180)');
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
        ...(refundAfterEntry
          ? [
              new RefundRetryLoop({
                refund: refundAfterEntry,
                leader: ctx.leader,
                logger: ctx.logger,
                ...(o.refundRetryTickMs !== undefined ? { tickMs: o.refundRetryTickMs } : {}),
              }),
            ]
          : []),
        ...(eventRefund
          ? [
              new EventRefundLoop({
                refund: eventRefund,
                leader: ctx.leader,
                logger: ctx.logger,
                ...(o.eventRefundTickMs !== undefined ? { tickMs: o.eventRefundTickMs } : {}),
              }),
            ]
          : []),
        ...(compensationLoop ? [compensationLoop] : []),
        ...(entryCloseDue ? [entryCloseDue] : []),
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
      refundTicketCancels?.close();
      refundTransfers?.close();
      compensationFence?.close();
      compensationPayment?.close();
      compensationLookup?.close();
      return relay.stop();
    },
  };
}
