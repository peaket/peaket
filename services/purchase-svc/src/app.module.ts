// 뿌리 모듈: 컨텍스트 모듈을 모은다. 지금은 inventory(좌석 홀드·1초 만료 반복)만 있다(booking·구매 세션 시작은 뒤 단계).
import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import type { HotRedis } from '@peaket/platform';
import {
  type AdmissionOptions,
  type HoldAttempts,
  InventoryModule,
  type PurchaseSessionAccess,
  type SeatMap,
  type SeatMapIndex,
  type SeatMapSections,
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
      | { redis: HotRedis; seatMap: SeatMap & SeatMapIndex & SeatMapSections; attempts: HoldAttempts; podId: string; signals?: SeatSignals }
      | { memory: true; store?: SeatStore; seatMap?: SeatMap & SeatMapSections; attempts?: HoldAttempts; signals?: SeatSignals }
    ) & {
      sessions: PurchaseSessionAccess;
      /** 스냅샷 API·홀드 기록(BUILD_ORDER PRF-137). 없으면 스냅샷 경로를 열지 않는다 */
      admission?: AdmissionOptions;
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
            ...(o.signals ? { signals: o.signals } : {}),
          })
        : InventoryModule.register({
            storage: 'memory',
            sessions: o.sessions,
            ...(o.admission ? { admission: o.admission } : {}),
            ...(o.store ? { store: o.store } : {}),
            ...(o.seatMap ? { seatMap: o.seatMap } : {}),
            ...(o.attempts ? { attempts: o.attempts } : {}),
            ...(o.signals ? { signals: o.signals } : {}),
          });
    return { module: AppModule, imports: [inventory] };
  }
}
