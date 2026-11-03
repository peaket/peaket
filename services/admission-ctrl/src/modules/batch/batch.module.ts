// 모듈 조립 파일: 묶음 게시 포트에 어댑터를 묶는다. 리더가 부르는 연결과 시작 파일은 BUILD_ORDER PRF-090이 더한다.
import { type DynamicModule, Module } from '@nestjs/common';
import type { HotRedis } from '@peaket/platform';
import { ADMISSION_REDIS, RedisBatchStore } from './adapters/redis-batch-store.js';
import { PublishBatchResults } from './application/publish-batch-results.js';
import { BATCH_STORE, BEACON, type Beacon, RESULT_FILES, type ResultFiles, SEED_SOURCE, type SeedSource } from './domain/ports.js';

export interface BatchModuleOptions {
  redis: HotRedis;
  seeds: SeedSource;
  beacon: Beacon;
  files: ResultFiles;
}

@Module({})
export class BatchModule {
  static register(o: BatchModuleOptions): DynamicModule {
    return {
      module: BatchModule,
      providers: [
        PublishBatchResults,
        { provide: ADMISSION_REDIS, useValue: o.redis },
        { provide: BATCH_STORE, useClass: RedisBatchStore },
        { provide: SEED_SOURCE, useValue: o.seeds },
        { provide: BEACON, useValue: o.beacon },
        { provide: RESULT_FILES, useValue: o.files },
      ],
      exports: [PublishBatchResults],
    };
  }
}
