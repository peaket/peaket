// 뿌리 모듈: 컨텍스트 모듈을 모은다. inventory(좌석 홀드·1초 만료 반복·구매 세션)와, 조립 값을 넘겼을 때만 booking(주문 생성 POST /v1/orders, BUILD_ORDER PRF-161)이다.
import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import type { HotPathMetrics, HotRedis } from '@peaket/platform';
import { BookingModule, type BookingModuleDeps } from './modules/booking/index.js';
import {
  type AdmissionOptions,
  type ExpirySweeperDeps,
  type HoldAttempts,
  type SeatBehaviorReporter,
  InventoryModule,
  type PurchaseSessionAccess,
  type SeatMap,
  type SeatMapAuto,
  type SeatMapIndex,
  type SeatMapSections,
  type SeatSales,
  type SeatSignals,
  type SeatStore,
} from './modules/inventory/index.js';

/**
 * 이 서비스의 응답은 모두 사용자 단위 정보라 캐시하지 않는다(ASVS v5.0.0-14.3.2). 처리기 앞의 인증 가드가 내는 거절(401·400)도 포함해 요청이 처리기에 닿기 전에
 * 머리를 단다(처리기도 오류 응답에 같은 머리를 단다). 관리 포트(/metrics·/ready)는 다른 서버라 영향이 없다
 */
const noStore = (_req: unknown, res: { setHeader(name: string, value: string): unknown }, next: () => void): void => {
  res.setHeader('cache-control', 'no-store');
  next();
};

@Module({})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(noStore).forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }

  /**
   * 운영은 redis, 시험은 memory를 고른다(저장소가 없을 때 조용히 메모리로 가지 않게 둘 중 하나를 꼭 적는다).
   * sessions는 createService의 purchaseSessions에 넘긴 것과 같은 객체를 넘긴다.
   * 운영(redis)은 만료 반복(ExpirySweeper)도 만들어 내보낸다. podId는 만료 임대 값(KEY_PART 모양)이다
   */
  static register(
    o: (
      | { redis: HotRedis; seatMap: SeatMap & SeatMapIndex & SeatMapSections & SeatMapAuto; attempts: HoldAttempts; podId: string; signals?: SeatSignals; seatBehavior?: SeatBehaviorReporter; onHoldsExpired?: ExpirySweeperDeps['onHoldsExpired']; holdFreeze?: { pauseView: NonNullable<ExpirySweeperDeps['pauseView']>; lifecycle: NonNullable<ExpirySweeperDeps['lifecycle']> } }
      | { memory: true; store?: SeatStore; seatMap?: SeatMap & SeatMapSections & SeatMapAuto; attempts?: HoldAttempts; signals?: SeatSignals; seatBehavior?: SeatBehaviorReporter }
    ) & {
      sessions: PurchaseSessionAccess;
      /** 스냅샷 API·홀드 기록(BUILD_ORDER PRF-137). 없으면 스냅샷 경로를 열지 않는다 */
      admission?: AdmissionOptions;
      /** 판매 확정(Hard Sale) 저장소(BUILD_ORDER PRF-140 ①). 운영은 purchase DB가 있을 때만 넘긴다 */
      seatSales?: SeatSales;
      /**
       * 주문 생성(booking, BUILD_ORDER PRF-161). 넘기면 BookingModule.register(booking)을 함께 넣고, 없으면 주문 경로를 열지 않는다.
       * 운영은 purchase DB가 있을 때만 넘긴다(main.ts)
       */
      booking?: BookingModuleDeps;
      /** 핫패스 구간 진단(BAT-027). 없으면 계측하지 않는다 */
      hotPath?: HotPathMetrics;
    },
  ): DynamicModule {
    const inventory =
      'redis' in o
        ? InventoryModule.register({
            storage: 'redis',
            redis: o.redis,
            seatMap: o.seatMap,
            attempts: o.attempts,
            podId: o.podId,
            sessions: o.sessions,
            ...(o.admission ? { admission: o.admission } : {}),
            ...(o.seatSales ? { seatSales: o.seatSales } : {}),
            ...(o.signals ? { signals: o.signals } : {}),
            ...(o.seatBehavior ? { seatBehavior: o.seatBehavior } : {}),
            ...(o.onHoldsExpired ? { onHoldsExpired: o.onHoldsExpired } : {}),
            ...(o.holdFreeze ? { holdFreeze: o.holdFreeze } : {}),
            ...(o.hotPath ? { hotPath: o.hotPath } : {}),
          })
        : InventoryModule.register({
            storage: 'memory',
            sessions: o.sessions,
            ...(o.admission ? { admission: o.admission } : {}),
            ...(o.seatSales ? { seatSales: o.seatSales } : {}),
            ...(o.store ? { store: o.store } : {}),
            ...(o.seatMap ? { seatMap: o.seatMap } : {}),
            ...(o.attempts ? { attempts: o.attempts } : {}),
            ...(o.signals ? { signals: o.signals } : {}),
            ...(o.seatBehavior ? { seatBehavior: o.seatBehavior } : {}),
            ...(o.hotPath ? { hotPath: o.hotPath } : {}),
          });
    return { module: AppModule, imports: [inventory, ...(o.booking ? [BookingModule.register(o.booking)] : [])] };
  }
}
