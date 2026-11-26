// 예매 제한 모듈 공개 파일. 다른 컨텍스트는 이 파일로만 가져온다.
export { RestrictionsModule, RESTRICTION_KIT, type RestrictionKit, type RestrictionKitSeed, type RestrictionsModuleOptions } from './restrictions.module.js';
export { BookingRestrictions, type BookingRestrictionsDeps, type RestrictionExecuteInput } from './application/booking-restrictions.js';
export { MemoryBookingRestrictionStore } from './adapters/memory-restrictions.js';
export { DrizzleBookingRestrictionStore } from './adapters/db/drizzle-restrictions.js';
export { grpcRestrictionCopies, type GrpcRestrictionCopiesOptions } from './adapters/grpc-restriction-copies.js';
export { copyRetryDelayMs, isRestrictionReason, RESTRICTION_REASONS, type RestrictionCopyInput, type RestrictionRow, type RestrictionStatus } from './domain/booking-restriction.js';
export type { AppealHolds, AppealNotifier, AppealSource, AppealSourceRecord, BookingRestrictionStore, FraudCaseDirectory, OpsRestrictionsWiring, RestrictionClock, RestrictionCopies, RestrictionEngine, RestrictionEngineRef } from './domain/ports.js';
