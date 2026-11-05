// 모듈 조립 파일: booking 포트에 어댑터를 묶는다(층 규칙의 밖. 모든 층을 가져온다, BUILD_ORDER PRF-161·PRF-162).
// 주문 생성 POST /v1/orders와 결제 접수 POST /v1/orders/{orderId}/payment-acceptance다. purchase DB가 없이 뜬 파드는 이 모듈을 넣지 않는다
// (주문 경로를 열지 않는다, payment §2 '넘긴 것').
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { LoggerOrderLog } from './adapters/order-log.js';
import { AcceptPayment } from './application/accept-payment.js';
import { CreateOrder } from './application/create-order.js';
import { GetPaymentStatus } from './application/get-payment-status.js';
import type {
  AcceptLog,
  BookingRestrictions,
  ContactRefs,
  IdentityRecheck,
  OrderAcceptReads,
  OrderAcceptWrites,
  OrderHolds,
  OrderLog,
  OrderSessions,
  OrderSignals,
  OrderWrites,
  PaymentStatusReads,
  PaymentStatusWaiters,
  SaleConfigs,
  SeatSlotReads,
} from './domain/ports.js';
import { CONSENT_VERSION_PATTERN, OrdersController } from './inbound/orders.controller.js';

/**
 * 조립 값. 운영(main.ts)은 writes = DrizzleOrderWrites(purchase DB), holds = inventory RedisOrderHolds, saleConfigs = SeatMapSaleConfigs(LayoutSeatMap),
 * sessions = InventoryOrderSessions(StoredPurchaseSessions·RedisPurchaseSessionStore), identity·contactRefs = identityClientsFromEnv,
 * restrictions = RedisBookingRestrictions(좌석 Redis), signals = PromOrderSignals, log = LoggerOrderLog(서비스 로거)를 넘긴다.
 * 결제 접수(PRF-162)는 accepts = DrizzleOrderAccepts(purchase DB), slots = InventorySeatSlots(inventory RedisSeatSlots)를 더 넘긴다(sessions는 같이 쓴다).
 * 시험은 같은 포트의 대역을 넘긴다
 */
export interface BookingModuleDeps {
  writes: OrderWrites;
  holds: OrderHolds;
  saleConfigs: SaleConfigs;
  sessions: OrderSessions;
  identity: IdentityRecheck;
  contactRefs: ContactRefs;
  restrictions: BookingRestrictions;
  signals: OrderSignals;
  /** 결제 접수의 purchase DB 읽기·쓰기(운영은 DrizzleOrderAccepts 하나가 둘을 구현한다, PRF-162) */
  accepts: OrderAcceptReads & OrderAcceptWrites;
  /** 결제 접수의 회차 슬롯 읽기(세대 키 gen·판매 정지 사본, PRF-162) */
  slots: SeatSlotReads;
  /** 없으면 플랫폼 서비스 로거(PLATFORM_LOGGER)로 LoggerOrderLog를 만든다 */
  log?: OrderLog;
  /** 결제 접수의 보안 로그. 없으면 log가 AcceptLog도 구현하면 그것을, 아니면 서비스 로거로 만든 LoggerOrderLog를 쓴다(PRF-162) */
  acceptLog?: AcceptLog;
  /** 지금 동의 문안 판(PEAKET_ORDER_CONSENT_VERSION, ^[0-9A-Za-z._-]{1,32}$). 틀리면 register가 던진다(시작 실패) */
  consentVersion: string;
  /** 없으면 플랫폼 CLOCK */
  clock?: Clock;
  /**
   * 결제 접수를 커밋한 직후 부를 것(AcceptPaymentDeps.onAccepted, PRF-165). 운영은 Saga 실행기의 kick(OrderSagaRunner.kick)을 넘긴다.
   * 없으면 부르지 않는다(지금 동작 그대로. 실행기가 켜지면 1초 폴링이 줍는다)
   */
  onAccepted?: (orderId: string) => void;
  /**
   * 결제 결과 long polling GET /v1/orders/{orderId}/payment-status(PRF-166). 운영(main.ts)은 reads = DrizzlePaymentStatus(purchase DB 쓰기 인스턴스),
   * waiters = PaymentStatusWaitTable(시작 파일이 만들어 켜고 끈다. Saga 실행기·결제 결과 처리기의 onOrderChanged에도 그 notify를 넘긴다)을 넘긴다.
   * 없으면 GetPaymentStatus를 조립하지 않는다(처리기가 404 not-found로 답한다 [정함])
   */
  paymentStatus?: { reads: PaymentStatusReads; waiters: PaymentStatusWaiters };
}

@Module({})
export class BookingModule {
  /**
   * 컨트롤러 OrdersController와 쓰임새 CreateOrder·AcceptPayment(useFactory: deps + CLOCK + 로그)를 묶는다. 내보내는 것은 없다.
   * AcceptPayment에는 { sessions, reads = accepts, writes = accepts, slots, log = acceptLog(위 기본값 규칙), clock, onAccepted(있을 때만) }을 넘긴다.
   * Saga 실행기(OrderSagaRunner, PRF-165)는 이 모듈이 만들지 않는다: main.ts가 만들어 시작·정지하고 kick을 onAccepted로 넘긴다(Nest 수명과 따로).
   * 결제 결과 long polling의 GetPaymentStatus(PRF-166)는 paymentStatus가 있을 때만 { reads, waiters, clock }으로 만든다. 기다림 표(PaymentStatusWaitTable)도
   * Saga 실행기처럼 main.ts가 만들어 시작·정지한다.
   * @throws Error consentVersion 모양이 틀림(시작 실패)
   */
  static register(deps: BookingModuleDeps): DynamicModule {
    // 시작 때 막는다: 틀린 판으로 뜨면 모든 주문이 422가 된다(빈 글·빈칸·33자 이상·다른 글자)
    if (typeof deps.consentVersion !== 'string' || !CONSENT_VERSION_PATTERN.test(deps.consentVersion)) {
      throw new Error(`동의 문안 판(${CONSENT_VERSION_ENV})은 1~32자의 영문·숫자·._-여야 한다`);
    }
    const { log, acceptLog, clock, accepts, slots, onAccepted, paymentStatus, ...ports } = deps;
    const createOrder: Provider = {
      provide: CreateOrder,
      useFactory: (platformClock: Clock, logger?: PlatformLogger) => {
        const orderLog = log ?? (logger ? new LoggerOrderLog(logger) : silentOrderLog);
        return new CreateOrder({ ...ports, log: orderLog, clock: clock ?? platformClock });
      },
      inject: [CLOCK, { token: PLATFORM_LOGGER, optional: true }],
    };
    // 결제 접수(PRF-162). 보안 로그 기본값: acceptLog → log가 AcceptLog이면 그것 → 서비스 로거의 LoggerOrderLog → 아무것도 남기지 않는 대역
    const acceptPayment: Provider = {
      provide: AcceptPayment,
      useFactory: (platformClock: Clock, logger?: PlatformLogger) => {
        const securityLog = acceptLog ?? (isAcceptLog(log) ? log : logger ? new LoggerOrderLog(logger) : silentAcceptLog);
        return new AcceptPayment({
          sessions: ports.sessions,
          reads: accepts,
          writes: accepts,
          slots,
          log: securityLog,
          clock: clock ?? platformClock,
          ...(onAccepted ? { onAccepted } : {}),
        });
      },
      inject: [CLOCK, { token: PLATFORM_LOGGER, optional: true }],
    };
    // 결제 결과 long polling(PRF-166). 넘긴 것이 있을 때만 조립한다(처리기는 @Optional로 받는다)
    const getPaymentStatus: Provider[] = paymentStatus
      ? [
          {
            provide: GetPaymentStatus,
            useFactory: (platformClock: Clock) => new GetPaymentStatus({ reads: paymentStatus.reads, waiters: paymentStatus.waiters, clock: clock ?? platformClock }),
            inject: [CLOCK],
          },
        ]
      : [];
    return { module: BookingModule, controllers: [OrdersController], providers: [createOrder, acceptPayment, ...getPaymentStatus], exports: [] };
  }
}

/** 동의 문안 판 환경 값 이름(main.ts가 읽는다) */
export const CONSENT_VERSION_ENV = 'PEAKET_ORDER_CONSENT_VERSION';

/** 서비스 로거도 없을 때(시험 조립)의 로그 대역: 아무것도 남기지 않는다 */
const silentOrderLog: OrderLog = { identityFallback: () => {}, configError: () => {}, payingMarkFailed: () => {} };
/** 결제 접수 보안 로그의 같은 대역 */
const silentAcceptLog: AcceptLog = { attemptMismatch: () => {} };

/** 넘긴 주문 로그가 결제 접수 보안 로그도 구현하는가(LoggerOrderLog·시험 기록 대역) */
const isAcceptLog = (l: OrderLog | undefined): l is OrderLog & AcceptLog => typeof (l as Partial<AcceptLog> | undefined)?.attemptMismatch === 'function';
