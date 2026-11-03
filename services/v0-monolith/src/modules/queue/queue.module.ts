// 모듈 조립 파일: 대기열 v0 포트에 Redis 어댑터를 묶는다(층 규칙의 밖).
import { type DynamicModule, Module } from '@nestjs/common';
import type { RedisCommander } from '@peaket/platform';
import { RedisQueueStore } from './adapters/redis/redis-queue-store.js';
import { QueueService } from './application/queue-service.js';
import { QUEUE_STORE } from './domain/queue-store.js';
import { AdmissionTicker, TICK_INTERVAL_MS } from './inbound/admission-ticker.js';
import { QueueController } from './inbound/queue.controller.js';

export interface QueueModuleOptions {
  /** 대기열 Redis(Valkey) 명령 보내기 포트 */
  redis: RedisCommander;
  /** 입장 루프 간격(밀리초). v0 실행은 250 [가정](1초 칸보다 짧게, src/main.ts). 시험은 false로 끄고 공개 함수 tick으로 돌린다 */
  tickIntervalMs: number | false;
}

@Module({})
export class QueueModule {
  static register(o: QueueModuleOptions): DynamicModule {
    if (o.tickIntervalMs !== false && !(Number.isInteger(o.tickIntervalMs) && o.tickIntervalMs >= 10)) {
      throw new Error(`입장 루프 간격은 10ms 이상 정수이거나 false다: ${String(o.tickIntervalMs)}`);
    }
    return {
      module: QueueModule,
      controllers: [QueueController],
      providers: [
        QueueService,
        AdmissionTicker,
        { provide: QUEUE_STORE, useValue: new RedisQueueStore(o.redis) },
        { provide: TICK_INTERVAL_MS, useValue: o.tickIntervalMs },
      ],
    };
  }
}
