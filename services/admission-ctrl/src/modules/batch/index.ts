// 묶음 게시 컨텍스트의 공개 면(다른 모듈·시작 파일은 이 파일로만 들어온다).
export { LocalResultFiles } from './adapters/local-result-files.js';
export { RedisBatchStore } from './adapters/redis-batch-store.js';
export { TEST_RANDOMNESS_ENV, TestRandomness } from './adapters/test-randomness.js';
export { type PublishResult, PublishBatchResults } from './application/publish-batch-results.js';
export type { Beacon, ResultFiles, SeedSource } from './domain/ports.js';
export { BatchModule, type BatchModuleOptions } from './batch.module.js';
