// core-svc support 모듈 공개 파일.
export { SupportModule, SUPPORT_KIT, type SupportKit, type SupportModuleOptions, type SupportWiring } from './support.module.js';
export { Appeals } from './application/appeals.js';
export { MemoryAppealStore, MemoryFraudAppealViewStore, MemoryRestrictionViewStore } from './adapters/memory-support.js';
export { DrizzleAppealStore } from './adapters/db/drizzle-appeals.js';
export { RedisFraudAppealViewStore, RedisRestrictionViewStore } from './adapters/redis-views.js';
export { HttpFraudAppealClient } from './adapters/http-fraud-appeals.js';
export { HttpAppealCaseSink } from './adapters/http-appeal-case-sink.js';
export { supportGrpcHandlers } from './inbound/support.grpc.js';
export type { AppealRow, AppealStatus, AppealKind, CaseRequestedRow, FraudAppealViewRow, RestrictionViewRow } from './domain/appeal.js';export type { AppealStore, FanNotifier, FraudAppealClient, FraudAppealViewStore, RestrictionViewStore, AppealCaseSink } from './domain/ports.js';
