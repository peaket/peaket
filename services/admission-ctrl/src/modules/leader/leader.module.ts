// 모듈 조립 파일: 리더 루프 포트에 어댑터를 묶는다. 묶음 게시(BatchModule)를 리더가 부른다.
import { type DynamicModule, Module } from '@nestjs/common';
import type { HotRedis } from '@peaket/platform';
import { ADMISSION_REDIS, BatchModule, type BatchModuleOptions, PublishBatchResults, WAIT_REDIS } from '../batch/index.js';
import { RedisLeaderStore } from './adapters/redis-leader-store.js';
import { AdmissionLeader } from './application/admission-leader.js';
import { LEADER_METRICS, type LeaderMetrics } from './application/leader-metrics.js';
import { ELECTOR, type Elector, LEADER_STORE, PUBLISHER } from './domain/ports.js';

export interface LeaderModuleOptions {
  redis: HotRedis;
  /** Lease 리더(플랫폼 LeaseElector) */
  elector: Elector;
  batch: Omit<BatchModuleOptions, 'redis'>;
  metrics?: LeaderMetrics;
}

@Module({})
export class LeaderModule {
  static register(o: LeaderModuleOptions): DynamicModule {
    return {
      module: LeaderModule,
      imports: [BatchModule.register({ redis: o.redis, ...o.batch })],
      providers: [
        AdmissionLeader,
        { provide: ADMISSION_REDIS, useValue: o.redis },
        // RB-05 복제 확인도 묶음 게시 확인과 같은 WAIT 전용 연결을 쓴다(ADR-0186)
        ...(o.batch.waitRedis ? [{ provide: WAIT_REDIS, useValue: o.batch.waitRedis }] : []),
        { provide: LEADER_STORE, useClass: RedisLeaderStore },
        { provide: ELECTOR, useValue: o.elector },
        { provide: PUBLISHER, useExisting: PublishBatchResults },
        ...(o.metrics ? [{ provide: LEADER_METRICS, useValue: o.metrics }] : []),
      ],
      exports: [AdmissionLeader],
    };
  }
}
