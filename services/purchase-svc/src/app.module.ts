// 뿌리 모듈: 컨텍스트 모듈을 모은다. 지금은 inventory(좌석 홀드·1초 만료 반복)만 있다(booking·구매 세션 시작은 뒤 단계).
import { type DynamicModule, Module } from '@nestjs/common';
import type { HotRedis } from '@peaket/platform';
import { type HoldAttempts, InventoryModule, type PurchaseSessionAccess, type SeatMap, type SeatMapIndex, type SeatSignals, type SeatStore } from './modules/inventory/index.js';

@Module({})
export class AppModule {
  /**
   * 운영은 redis, 시험은 memory를 고른다(저장소가 없을 때 조용히 메모리로 가지 않게 둘 중 하나를 꼭 적는다).
   * sessions는 createService의 purchaseSessions에 넘긴 것과 같은 객체를 넘긴다.
   * 운영(redis)은 만료 반복(ExpirySweeper)도 만들어 내보낸다. podId는 만료 임대 값(KEY_PART 모양)이다
   */
  static register(
    o: (
      | { redis: HotRedis; seatMap: SeatMap & SeatMapIndex; attempts: HoldAttempts; podId: string; signals?: SeatSignals }
      | { memory: true; store?: SeatStore; seatMap?: SeatMap; attempts?: HoldAttempts; signals?: SeatSignals }
    ) & {
      sessions: PurchaseSessionAccess;
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
            ...(o.signals ? { signals: o.signals } : {}),
          })
        : InventoryModule.register({
            storage: 'memory',
            sessions: o.sessions,
            ...(o.store ? { store: o.store } : {}),
            ...(o.seatMap ? { seatMap: o.seatMap } : {}),
            ...(o.attempts ? { attempts: o.attempts } : {}),
            ...(o.signals ? { signals: o.signals } : {}),
          });
    return { module: AppModule, imports: [inventory] };
  }
}
