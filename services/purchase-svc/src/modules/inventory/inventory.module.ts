// 모듈 조립 파일: inventory 포트에 어댑터를 묶는다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { CLOCK, type Clock, type HotRedis } from '@peaket/platform';
import type { PurchaseSessionAccess } from './adapters/memory-purchase-sessions.js';
import { MemorySeatMap } from './adapters/memory-seat-map.js';
import { MemorySeatStore } from './adapters/memory-seat-store.js';
import { RecordingHoldAttempts } from './adapters/recording-hold-attempts.js';
import { RedisSeatStore, SEAT_REDIS } from './adapters/redis-seat-store.js';
import { HoldSeats } from './application/hold-seats.js';
import { HOLD_ATTEMPTS, type HoldAttempts, PURCHASE_SESSIONS, SEAT_MAP, SEAT_STORE, type SeatMap, type SeatStore } from './domain/ports.js';
import { HoldsController } from './inbound/holds.controller.js';

export type InventoryModuleOptions = (
  /** 운영: 좌석 Redis. 좌석맵 판과 시도 기록은 꼭 넘긴다(PRF-130 ①에는 운영 어댑터가 없어 main.ts가 빈 메모리 판·버리는 기록을 넘긴다) */
  | { storage: 'redis'; redis: HotRedis; seatMap: SeatMap; attempts: HoldAttempts }
  /** 시험: 넘기지 않은 것은 새로 만든다(저장소 MemorySeatStore(주입 Clock), 좌석맵 MemorySeatMap, 시도 기록 RecordingHoldAttempts) */
  | { storage: 'memory'; store?: SeatStore; seatMap?: SeatMap; attempts?: HoldAttempts }
) & {
  /** 구매 세션. createService의 purchaseSessions에 넘긴 것과 같은 객체여야 한다(요청 서명 확인과 세션 읽기가 같은 세션을 본다) */
  sessions: PurchaseSessionAccess;
};

@Module({})
export class InventoryModule {
  static register(o: InventoryModuleOptions): DynamicModule {
    const storage: Provider[] =
      o.storage === 'redis'
        ? [
            { provide: SEAT_REDIS, useValue: o.redis },
            { provide: SEAT_STORE, useClass: RedisSeatStore },
            { provide: SEAT_MAP, useValue: o.seatMap },
            { provide: HOLD_ATTEMPTS, useValue: o.attempts },
          ]
        : [
            o.store ? { provide: SEAT_STORE, useValue: o.store } : { provide: SEAT_STORE, useFactory: (clock: Clock) => new MemorySeatStore(clock), inject: [CLOCK] },
            { provide: SEAT_MAP, useValue: o.seatMap ?? new MemorySeatMap() },
            { provide: HOLD_ATTEMPTS, useValue: o.attempts ?? new RecordingHoldAttempts() },
          ];
    return {
      module: InventoryModule,
      controllers: [HoldsController],
      providers: [HoldSeats, ...storage, { provide: PURCHASE_SESSIONS, useValue: o.sessions }],
      exports: [HoldSeats],
    };
  }
}
