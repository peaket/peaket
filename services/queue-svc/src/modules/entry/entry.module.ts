// 모듈 조립 파일: 진입 포트에 어댑터를 묶는다.
import { type DynamicModule, Module } from '@nestjs/common';
import { CLOCK, type Clock, type HotRedis } from '@peaket/platform';
import { MemoryEntryStore, MemoryEventSchedules } from './adapters/memory-entry-store.js';
import { QUEUE_REDIS, QUEUE_WAIT_REDIS, RedisEntryStore } from './adapters/redis-entry-store.js';
import { RedisEventSchedules } from './adapters/redis-event-schedules.js';
import { DEFAULT_ENTRY_OPTIONS, ENTRY_OPTIONS, EnterQueue, type EntryOptions } from './application/enter-queue.js';
import { IssuePreverification } from './application/issue-preverification.js';
import { ENTRY_STORE, EVENT_SCHEDULES, type EventSchedules, QUEUE_TOKENS, type QueueTokens, RISK, type RiskPort } from './domain/ports.js';
import { QueueController } from './inbound/queue.controller.js';

/** waitRedis: RB-05 복제 확인(WAIT) 전용 연결(ADR-0186). 없으면 공유 연결 */
export type EntryModuleOptions = ({ storage: 'redis'; redis: HotRedis; waitRedis?: HotRedis } | { storage: 'memory'; schedules?: EventSchedules }) & {
  tokens: QueueTokens;
  risk: RiskPort;
  options?: Partial<EntryOptions>;
};

@Module({})
export class EntryModule {
  static register(o: EntryModuleOptions): DynamicModule {
    const storage =
      o.storage === 'redis'
        ? [
            { provide: QUEUE_REDIS, useValue: o.redis },
            ...(o.waitRedis ? [{ provide: QUEUE_WAIT_REDIS, useValue: o.waitRedis }] : []),
            { provide: ENTRY_STORE, useClass: RedisEntryStore },
            { provide: EVENT_SCHEDULES, useClass: RedisEventSchedules },
          ]
        : [
            { provide: ENTRY_STORE, useFactory: (clock: Clock) => new MemoryEntryStore(clock), inject: [CLOCK] },
            { provide: EVENT_SCHEDULES, useValue: o.schedules ?? new MemoryEventSchedules() },
          ];
    return {
      module: EntryModule,
      controllers: [QueueController],
      providers: [
        IssuePreverification,
        EnterQueue,
        ...storage,
        { provide: QUEUE_TOKENS, useValue: o.tokens },
        { provide: RISK, useValue: o.risk },
        { provide: ENTRY_OPTIONS, useValue: { ...DEFAULT_ENTRY_OPTIONS, ...o.options } },
      ],
    };
  }
}
