// F-04-12 조사 모듈 공개 면. 다른 컨텍스트·시험은 이 파일로만 가져온다.
export { InvestigationsModule, type InvestigationsModuleDeps } from './investigations.module.js';
export { Investigations, etag, type FraudActor, type InvestigationsDeps } from './application/investigations.js';
export { FraudClusterRunService } from './application/run-cluster.js';
export { VerifyDailySnapshots } from './application/verify-daily.js';
export { MemoryInvestigationStore } from './adapters/memory-investigation-store.js';
export { DrizzleInvestigationStore } from './adapters/db/drizzle-investigation-store.js';
export { GrpcTransferLocks, UnavailableTransferLocks } from './adapters/grpc-transfer-locks.js';
export {
  LoggingFraudAlerts,
  LoggingFraudLabels,
  LoggingFraudNotifier,
  LoggingFraudOpsEvent,
  LoggingInvestigationAccess,
  UnavailableFraudForensicsRunner,
  UnavailableSnapshotVerifier,
} from './adapters/logging-ports.js';
export { snapshotFromForensics, clustersFromForensics } from './domain/investigation.js';
export {
  APPEAL_CANCEL_MARGIN_MS,
  APPEAL_DEFAULT_LEAD_MS,
  APPEAL_MIN_LEAD_MS,
  AUTO_RETRY_LIMIT,
  CANCEL_DEADLINE_BEFORE_SHOW_MS,
  LOCK_MAX_MS,
  addMembers,
  assertAppealDue,
  assertInvestigator,
  autoRetriesLeftOf,
  cancelDeadlineAtMs,
  classifyRunFailure,
  decideAppeals,
  defaultAppealDueAt,
  lockExpiryOf,
  removeMembers,
  rerunDecision,
  verifySnapshotDecision,
  problem,
  type FraudAppealResult,
  type FraudCaseEventRecord,
  type FraudCaseRecord,
  type FraudCaseStatus,
  type FraudClusterMemberRecord,
  type FraudClusterRecord,
  type FraudObjectionResult,
  type FraudReasonCategory,
  type FraudRunFailure,
  type FraudRunRecord,
  type FraudRunStatus,
  type FraudRunTrigger,
  type FraudScoreBand,
  type FraudSignal,
  type FraudSnapshotRecord,
} from './domain/investigation.js';
export type {
  FraudAlerts,
  FraudForensicsRunner,
  FraudLabels,
  FraudNotifier,
  FraudOpsEventSink,
  InvestigationAccessLog,
  InvestigationStore,
  SnapshotVerifier,
  TransferLocks,
} from './domain/ports.js';
