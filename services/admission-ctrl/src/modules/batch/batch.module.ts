// 모듈 조립 파일: 묶음 게시 포트에 어댑터를 묶는다. 리더가 부르는 연결과 시작 파일은 BUILD_ORDER PRF-090이 더한다.
import { type DynamicModule, Module } from '@nestjs/common';
import type { HotRedis } from '@peaket/platform';
import { ADMISSION_REDIS, MIN_REPLICAS, RedisBatchStore, RedisShuffleRecords, WAIT_REDIS } from './adapters/redis-batch-store.js';
import { PublishBatchResults } from './application/publish-batch-results.js';
import { RevealShuffleSeeds } from './application/reveal-shuffle-seeds.js';
import { BATCH_STORE, BEACON, type Beacon, denyRunbookAuth, RESULT_FILES, type ResultFiles, RUNBOOK_AUTH, type RunbookAuth, SEED_SOURCE, type SeedSource, SHUFFLE_RECORDS, type ShuffleRecords } from './domain/ports.js';

export interface BatchModuleOptions {
  redis: HotRedis;
  seeds: SeedSource;
  /** 공시 기록(없으면 Redis 기록을 쓴다) */
  records?: ShuffleRecords;
  beacon: Beacon;
  files: ResultFiles;
  /** 게시 전 복제 확인의 최소 복제본 수(없으면 0) */
  minReplicas?: number;
  /** 게시 전 복제 확인(WAIT) 전용 연결. 없으면 공유 연결 */
  waitRedis?: HotRedis;
  /** RB-35 표시의 서명 확인(없으면 표시가 있는 구간을 멈춘다, ADR-0239 결정 15) */
  runbookAuth?: RunbookAuth;
}

@Module({})
export class BatchModule {
  static register(o: BatchModuleOptions): DynamicModule {
    return {
      module: BatchModule,
      providers: [
        PublishBatchResults,
        RevealShuffleSeeds,
        { provide: ADMISSION_REDIS, useValue: o.redis },
        { provide: MIN_REPLICAS, useValue: o.minReplicas ?? 0 },
        ...(o.waitRedis ? [{ provide: WAIT_REDIS, useValue: o.waitRedis }] : []),
        { provide: BATCH_STORE, useClass: RedisBatchStore },
        o.records ? { provide: SHUFFLE_RECORDS, useValue: o.records } : { provide: SHUFFLE_RECORDS, useClass: RedisShuffleRecords },
        { provide: SEED_SOURCE, useValue: o.seeds },
        { provide: BEACON, useValue: o.beacon },
        { provide: RUNBOOK_AUTH, useValue: o.runbookAuth ?? denyRunbookAuth },
        { provide: RESULT_FILES, useValue: o.files },
      ],
      exports: [PublishBatchResults, RevealShuffleSeeds],
    };
  }
}
