// 추가 검증 컨텍스트의 공개 면(다른 모듈·시작 파일은 이 파일로만 들어온다).
export { GrpcReverification, REVERIFICATION_DEADLINE_MS } from './adapters/grpc-reverification.js';
export { CASES_REQUESTED_TOPIC, type CaseProducer, caseRequestValue, KafkaCaseRequests } from './adapters/kafka-case-requests.js';
export { LocalCaseRequests } from './adapters/local-case-requests.js';
export { MemoryVerificationStore } from './adapters/memory-verification-store.js';
export { PromVerificationSignals } from './adapters/prom-verification-signals.js';
export { RedisVerificationStore, verificationKeys } from './adapters/redis-verification-store.js';
export { GetVerificationAppeal, ResolveVerificationAppeal } from './application/appeals.js';
export type { CaseRequestPublisher, ReverificationPort, VerificationRiskPort, VerificationSignals, VerificationStore } from './domain/ports.js';
export { DEFAULT_VERIFICATION_OPTIONS, type VerificationOptions } from './domain/verification.js';
export { queuePackage, verificationAppealHandlers } from './inbound/appeal.grpc.js';
export { VerificationModule, type VerificationModuleOptions } from './verification.module.js';
