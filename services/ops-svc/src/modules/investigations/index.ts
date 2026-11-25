// F-04-12 조사 모듈 공개 면. 다른 컨텍스트·시험은 이 파일로만 가져온다.
export { InvestigationsModule, type InvestigationsModuleDeps } from './investigations.module.js';
export { Investigations, etag, type FraudActor, type InvestigationsDeps } from './application/investigations.js';
export { FraudClusterRunService } from './application/run-cluster.js';
export { VerifyDailySnapshots } from './application/verify-daily.js';
export { MemoryInvestigationStore } from './adapters/memory-investigation-store.js';
export { DrizzleInvestigationStore } from './adapters/db/drizzle-investigation-store.js';
export { GrpcTransferLocks, UnavailableTransferLocks } from './adapters/grpc-transfer-locks.js';
export { GrpcFraudTickets } from './adapters/grpc-fraud-tickets.js';
export { GrpcFraudCancellations } from './adapters/grpc-fraud-cancellations.js';
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
  FraudTicketDirectory,
  FraudCancellations,
  FraudIdentityHold,
  FraudRestrictionCopies,
  FraudRestrictionRows,
  FraudCaseNotifier,
  FraudApproverIdentity,
  FraudApproverDirectory,
  FraudAppealCopies,
  FraudApprovalRecord,
  FraudApprovalStore,
} from './domain/ports.js';
export { FraudActions, type FraudActionsDeps, type FraudActionActor } from './application/fraud-actions.js';
export { BareProblemError, bareProblem } from './application/bare-problem.js';
export {
  ACTION_APPROVAL_BUSINESS_DAYS,
  CANCEL_NOTICE_LEADS_MS,
  OBJECTION_WINDOW_MS,
  RESTRICTION_MAX_MS,
  actionRequestDecision,
  approvalDecisionCheck,
  approvalExecutionGuard,
  approvalSummaryAllowed,
  clearanceCase,
  closeActionedCaseIfDue,
  decideObjections,
  objectionWindowEndMs,
  receiveObjection,
  type FraudAction,
  type FraudApprovalStatus,
  type FraudCancelTarget,
  type FraudTicketRef,
} from './domain/fraud-action.js';
export { MemoryFraudApprovalStore } from './adapters/memory-fraud-approval-store.js';
export { DrizzleFraudApprovalStore } from './adapters/db/drizzle-fraud-approval-store.js';
export { DrizzleFraudRestrictions } from './adapters/db/drizzle-fraud-restrictions.js';
export { startFraudActionSweep } from './application/fraud-action-sweep.js';
