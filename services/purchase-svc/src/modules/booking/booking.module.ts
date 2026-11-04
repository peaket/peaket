// 모듈 조립 파일: booking 포트에 어댑터를 묶는다(층 규칙의 밖. 모든 층을 가져온다, BUILD_ORDER PRF-161).
// 지금은 주문 생성 POST /v1/orders 하나다. purchase DB가 없이 뜬 파드는 이 모듈을 넣지 않는다(주문 경로를 열지 않는다, payment §2 '넘긴 것').
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { LoggerOrderLog } from './adapters/order-log.js';
import { CreateOrder } from './application/create-order.js';
import type { BookingRestrictions, ContactRefs, IdentityRecheck, OrderHolds, OrderLog, OrderSessions, OrderSignals, OrderWrites, SaleConfigs } from './domain/ports.js';
import { CONSENT_VERSION_PATTERN, OrdersController } from './inbound/orders.controller.js';

/**
 * 조립 값. 운영(main.ts)은 writes = DrizzleOrderWrites(purchase DB), holds = inventory RedisOrderHolds, saleConfigs = SeatMapSaleConfigs(LayoutSeatMap),
 * sessions = InventoryOrderSessions(StoredPurchaseSessions·RedisPurchaseSessionStore), identity·contactRefs = identityClientsFromEnv,
 * restrictions = RedisBookingRestrictions(좌석 Redis), signals = PromOrderSignals, log = LoggerOrderLog(서비스 로거)를 넘긴다.
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
  /** 없으면 플랫폼 서비스 로거(PLATFORM_LOGGER)로 LoggerOrderLog를 만든다 */
  log?: OrderLog;
  /** 지금 동의 문안 판(PEAKET_ORDER_CONSENT_VERSION, ^[0-9A-Za-z._-]{1,32}$). 틀리면 register가 던진다(시작 실패) */
  consentVersion: string;
  /** 없으면 플랫폼 CLOCK */
  clock?: Clock;
}

@Module({})
export class BookingModule {
  /**
   * 컨트롤러 OrdersController와 쓰임새 CreateOrder(useFactory: deps + CLOCK + 로그)를 묶는다. 내보내는 것은 없다.
   * @throws Error consentVersion 모양이 틀림(시작 실패)
   */
  static register(deps: BookingModuleDeps): DynamicModule {
    // 시작 때 막는다: 틀린 판으로 뜨면 모든 주문이 422가 된다(빈 글·빈칸·33자 이상·다른 글자)
    if (typeof deps.consentVersion !== 'string' || !CONSENT_VERSION_PATTERN.test(deps.consentVersion)) {
      throw new Error(`동의 문안 판(${CONSENT_VERSION_ENV})은 1~32자의 영문·숫자·._-여야 한다`);
    }
    const { log, clock, ...ports } = deps;
    const createOrder: Provider = {
      provide: CreateOrder,
      useFactory: (platformClock: Clock, logger?: PlatformLogger) => {
        const orderLog = log ?? (logger ? new LoggerOrderLog(logger) : silentOrderLog);
        return new CreateOrder({ ...ports, log: orderLog, clock: clock ?? platformClock });
      },
      inject: [CLOCK, { token: PLATFORM_LOGGER, optional: true }],
    };
    return { module: BookingModule, controllers: [OrdersController], providers: [createOrder], exports: [] };
  }
}

/** 동의 문안 판 환경 값 이름(main.ts가 읽는다) */
export const CONSENT_VERSION_ENV = 'PEAKET_ORDER_CONSENT_VERSION';

/** 서비스 로거도 없을 때(시험 조립)의 로그 대역: 아무것도 남기지 않는다 */
const silentOrderLog: OrderLog = { identityFallback: () => {}, configError: () => {}, payingMarkFailed: () => {} };
