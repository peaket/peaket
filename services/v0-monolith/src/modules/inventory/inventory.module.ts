// 모듈 조립 파일: 좌석 v0 포트에 어댑터를 묶는다(층 규칙의 밖).
import { type DynamicModule, Module } from '@nestjs/common';
import type { Database } from '@peaket/platform';
import { DrizzleSeatStore } from './adapters/db/drizzle-seat-store.js';
import { InventoryService } from './application/inventory-service.js';
import { ADMISSION_CHECK, DELTA_FEED, SEAT_STORE, type AdmissionCheck, type DeltaFeed } from './domain/ports.js';
import { ALLOWED_ORIGINS, DeltaSocket } from './inbound/delta-socket.js';
import { EXPIRY_INTERVAL_MS, ExpiryTicker } from './inbound/expiry-ticker.js';
import { SeatPageController } from './inbound/seat-page.controller.js';
import { HoldController, SeatController, SeatListController } from './inbound/seat.controller.js';

export interface InventoryModuleOptions {
  /** 좌석 v0 DB(v0_seat·v0_hold·v0_quota·v0_seat_event) */
  database: Database;
  /** queue 모듈의 입장 확인(createAdmissionReader) */
  admission: AdmissionCheck;
  /** 커밋된 변경분 받기(createPgDeltaFeed) */
  deltaFeed: DeltaFeed;
  /** 변경분 WebSocket의 허용 출처(정확히 같은 문자열, 예 http://127.0.0.1:8088) */
  allowedOrigins: readonly string[];
  /** 만료 루프 간격(밀리초). v0 실행은 1,000 [가정]. 시험은 false로 끄고 공개 함수 expire로 돌린다 */
  expiryIntervalMs: number | false;
}

@Module({})
export class InventoryModule {
  static register(o: InventoryModuleOptions): DynamicModule {
    if (o.expiryIntervalMs !== false && !(Number.isInteger(o.expiryIntervalMs) && o.expiryIntervalMs >= 10)) {
      throw new Error(`만료 루프 간격은 10ms 이상 정수이거나 false다: ${String(o.expiryIntervalMs)}`);
    }
    for (const origin of o.allowedOrigins) {
      if (!/^https?:\/\/[^/\s]+$/.test(origin)) throw new Error(`허용 출처는 scheme://host[:port] 꼴이다: ${origin}`);
    }
    return {
      module: InventoryModule,
      controllers: [SeatListController, SeatController, HoldController, SeatPageController],
      providers: [
        InventoryService,
        DeltaSocket,
        ExpiryTicker,
        { provide: SEAT_STORE, useValue: new DrizzleSeatStore(o.database) },
        { provide: ADMISSION_CHECK, useValue: o.admission },
        { provide: DELTA_FEED, useValue: o.deltaFeed },
        { provide: ALLOWED_ORIGINS, useValue: [...o.allowedOrigins] },
        { provide: EXPIRY_INTERVAL_MS, useValue: o.expiryIntervalMs },
      ],
    };
  }
}
