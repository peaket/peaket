// 모듈 조립 파일: 대기 상태 파일 포트에 어댑터를 묶는다.
import { type DynamicModule, Module } from '@nestjs/common';
import { CLOCK, type Clock, type HotRedis } from '@peaket/platform';
import { type EventSchedules, MemoryEventSchedules, QUEUE_REDIS, RedisEventSchedules } from '../entry/index.js';
import { MemoryStateSnapshots } from './adapters/memory-state-snapshots.js';
import { RedisStateSnapshots } from './adapters/redis-state-snapshots.js';
import { StateFiles } from './application/state-files.js';
import { DEFAULT_WEB_ORIGIN, STATE_OPTIONS, STATE_SCHEDULES, STATE_SNAPSHOTS, type StateOptions, type StateSnapshots } from './domain/ports.js';
import { StateFilesController } from './inbound/state-files.controller.js';

export type StateModuleOptions = ({ storage: 'redis'; redis: HotRedis } | { storage: 'memory'; schedules?: EventSchedules; snapshots?: StateSnapshots }) & {
  options?: Partial<StateOptions>;
};

@Module({})
export class StateModule {
  static register(o: StateModuleOptions): DynamicModule {
    const storage =
      o.storage === 'redis'
        ? [
            { provide: QUEUE_REDIS, useValue: o.redis },
            { provide: STATE_SNAPSHOTS, useClass: RedisStateSnapshots },
            { provide: STATE_SCHEDULES, useFactory: (clock: Clock) => new RedisEventSchedules(o.redis, clock), inject: [CLOCK] },
          ]
        : [
            { provide: STATE_SNAPSHOTS, useValue: o.snapshots ?? new MemoryStateSnapshots() },
            { provide: STATE_SCHEDULES, useValue: o.schedules ?? new MemoryEventSchedules() },
          ];
    return {
      module: StateModule,
      controllers: [StateFilesController],
      providers: [StateFiles, ...storage, { provide: STATE_OPTIONS, useValue: { webOrigin: DEFAULT_WEB_ORIGIN, autoTick: true, ...o.options } }],
    };
  }
}
