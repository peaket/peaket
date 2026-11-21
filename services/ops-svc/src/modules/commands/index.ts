// 운영 명령 모듈의 공개 면(BAT-355 계획 8.3: BAT-365·BAT-360·BAT-370이 기댄다).
export { CommandsModule, COMMAND_STORE, COMMAND_EXECUTOR, COMMAND_REAUTH, COMMAND_SECURITY_EVENTS, COMMAND_SIGNALS, COMMAND_MAINTENANCE_OPTIONS, type CommandsModuleExtras } from './commands.module.js';
export { CreateCommand, PreviewCommand, eventIdOf, problemOfRejection, type CreateCommandInput, type PreparedCommand } from './application/create-command.js';
export { ComputeDryRun, type ComputeDryRunDeps } from './application/compute-dry-run.js';
export {
  CommandEventBody,
  CommandEventResponse,
  HandleCommandEvent,
  commandIdOfEventKey,
  type CommandEvent,
  type HandleCommandEventDeps,
} from './application/handle-command-event.js';
export { DecideCommand } from './application/decide-command.js';
export { ExecuteCommand } from './application/execute-command.js';
export { GetCommand } from './application/get-command.js';
export { ListCommands } from './application/list-commands.js';
export { MaintainCommands, type MaintainCommandsExtras, type MaintainCommandsOptions, type MaintenanceRound } from './application/maintain-commands.js';
export { RetryCommand } from './application/retry-command.js';
export { ExtendCommand, RevertCommand } from './application/revert-command.js';
export {
  ACTOR_MAPPING_RETENTION_MS,
  APPROVAL_TTL_MS,
  AUTO_EXPIRE_TYPES,
  CATALOG_COMMAND_TYPES,
  COMMAND_MAINTENANCE_INTERVAL_MS,
  COMMAND_STATES,
  COMMAND_TRANSITIONS,
  COMMAND_TYPES,
  CREATE_OPS_COMMAND,
  DRY_RUN_COMPARE_DELAY_MS,
  IllegalCommandTransition,
  ONE_SHOT_COMMAND_TYPES,
  REVERT_NEEDS_APPROVAL,
  REVERT_NEEDS_REAUTH,
  SAFETY_LIMITS,
  SYSTEM_ACTOR_REF,
  SYSTEM_ROLE,
  approvalModeOf,
  approverRolesOf,
  blockApprovalOfParams,
  expiryAfterAckMs,
  isCatalogCommand,
  nextCommandState,
  reauthRequiredFor,
  requesterRolesOf,
  rolePolicyOf,
  stateAfterCreate,
  successStateOf,
  transitionOf,
  type ApprovalMode,
  type CommandRolePolicy,
  type Command,
  type CommandExecutionActor,
  type CommandExecutionResult,
  type CommandIdempotency,
  type CommandState,
  type CommandTransition,
  type CommandType,
  type NewCommand,
} from './domain/command.js';
export { CommandInputRejected, checkCommandParams, normalizeReason, BOT_LEVELS, BOT_REASSESS_MODES, KILL_SWITCH_SCOPES } from './domain/command-params.js';
export {
  BLOCK_IPV4_TWO_PERSON_BELOW,
  BLOCK_IPV6_TWO_PERSON_BELOW,
  blockApprovalOf,
  blockListsOf,
  cidrsOverlap,
  parseCidr,
  protectedRangeHits,
  type BlockApproval,
  type ParsedCidr,
  type ProtectedRangeHit,
} from './domain/block-ranges.js';
export { DEFAULT_PROTECTED_RANGES, PROTECTED_RANGES, PROTECTED_RANGES_VERSION, type ProtectedRange, type ProtectedRangeList } from './domain/protected-ranges.js';
export {
  DRY_RUN_KEYS,
  DRY_RUN_VERSION,
  compareDryRun,
  limitsOf,
  predictAdmissionTarget,
  type CommandDryRun,
  type DryRunComparison,
  type DryRunCount,
  type DryRunCountResult,
  type DryRunPrediction,
  type DryRunSource,
  type DryRunTarget,
  type DryRunUnavailable,
} from './domain/dry-run.js';
export { closeIfApprovalExpired, planCreation, recordDigest, writeAutoExpired, writeComparison, writeDecision } from './domain/command-writes.js';
export {
  DuplicateCommandActor,
  noCommandSecurityEvents,
  noCommandSignals,
  type ActorSide,
  type CancelledEventGuard,
  type CommandDecision,
  type CommandDueKind,
  type CommandExecutor,
  type CommandListQuery,
  type CommandPage,
  type CommandSecurityEvents,
  type CommandSendResult,
  type CommandSignals,
  type CommandStore,
  type CommandWriter,
} from './domain/ports.js';
export { MemoryCommandStore, type MemoryCommandActor, type MemoryCommandEvent } from './adapters/memory-command-store.js';
export { DrizzleCommandStore } from './adapters/db/drizzle-command-store.js';
export { UnavailableDryRunSource, DRY_RUN_SOURCE_NOT_WIRED } from './adapters/unavailable-dry-run-source.js';
export { LogCommandSecurityEvents, PromCommandSignals } from './adapters/command-signals.js';
// 명령 12·6 결제 갈래와 설정 사건 일반 내기(BAT-360 OPS-290, ADR-0349 결정 1~6, BAT-360 계획 8.3: BAT-365가 명령 5·7·8·9·온세일 LOG_SAMPLING에 쓴다)
export { PG_ASSIGNMENT_SETTING, pgAssignmentSettingOf, type ExecuteCommandOptions } from './application/execute-command.js';
export { PG_CHECK_TIMEOUT_MS, PgAssignmentGate, onsaleWindowUnavailable, pgCheckUnavailable, type PgAssignmentGateDeps } from './application/pg-assignment-gate.js';
export {
  ASSIGNABLE_PGS,
  PAYMENT_PG_FALLBACK,
  PG_FALLBACK_MAX_EVENTS,
  PG_FALLBACK_SCOPES,
  isPgFallbackParams,
  pgAssignParamsOf,
  pgFallbackParamsOf,
  type AssignablePg,
  type PgAssignParams,
  type PgFallbackParams,
} from './domain/command-params.js';
export { ONSALE_WINDOW_AFTER_MS, ONSALE_WINDOW_BEFORE_MS, ONSALE_WINDOW_READ_TIMEOUT_MS, inOnsaleWindow } from './domain/onsale-window.js';
export { PG_ADMISSION_CAP_INPUTS, PG_CAP_KEYS, PG_TPS_KEYS, pgAdmissionCap, predictPgCaps } from './domain/dry-run.js';
export type { OnsaleStartSource, PgAssignmentCheck, PgAssignmentVerdict, PgName, SettingChange } from './domain/ports.js';
export { SETTING_EVENT_KEY_DOMAIN, SETTING_KINDS, SettingChangeRejected, publishSetting, settingEventKey, settingMessageKey, settingOutboxMessage } from './adapters/settings-outbox.js';
export { GrpcPgAssignmentCheck, PG_CHECK_GRPC_TIMEOUT_MS, pgAssignmentVerdictOf, type GrpcPgAssignmentCheckOptions } from './adapters/grpc-pg-assignment-check.js';
export { HttpCoreSaleStart } from './adapters/http-core-sale-start.js';
export type { MemoryOutboxSetting } from './adapters/memory-command-store.js';
export { CommandsController } from './inbound/commands.controller.js';
export { CommandDryRunsController } from './inbound/command-dry-runs.controller.js';
export { CommandMaintenanceJob, type CommandMaintenanceOptions } from './inbound/command-maintenance.job.js';
export { CommandBody, CommandDryRunView, CommandIdParams, CommandPageView, CommandView, ReasonBody, RejectBody, baseViewOf, canApproveOf, viewOf } from './inbound/command-view.js';
// BAT-360 OPS-290(ADR-0349 결정 7~10): 사후 검토·운영 사건 줄·명령 4 만료 정리
export { PostReviews, type PostReviewActor, type PostReviewView, type PostReviewsDeps } from './application/post-review.js';
export { ExpireWafBlocks, type BlockExpiryView, type ExpirerLog, type WafExpiryFamilyResult, type WafExpiryRun } from './application/expire-waf-blocks.js';
export { blockExpiresAtOf, openPostReviewIn } from './domain/command-writes.js';
export {
  AUTOMATION_STOP_TRIGGERS,
  KILL_SWITCH_TRIGGERS,
  POST_REVIEW_ASSESSMENTS,
  POST_REVIEW_CONFIRM_DUE_MS,
  POST_REVIEW_CONFIRM_OVERDUE_ALERT,
  POST_REVIEW_DUE_MS,
  POST_REVIEW_OVERDUE_ALERT,
  POST_REVIEW_TEXT_MAX,
  POST_REVIEW_TRIGGERS,
  POST_REVIEW_TYPES,
  PostReviewInvalid,
  isOverdue,
  isPostReviewType,
  postReviewConfirmationOf,
  postReviewReportOf,
  postReviewText,
  type PostReviewAlertKind,
  type PostReviewAssessment,
  type PostReviewFollowUp,
  type PostReviewReport,
  type PostReviewRow,
  type PostReviewTrigger,
  type PostReviewWriter,
} from './domain/post-review.js';
export {
  WafLockConflict,
  blockCommandOf,
  blockExpired,
  blockExpiryVerdict,
  blockRemovalOf,
  ipSetKeys,
  liveBlockKeys,
  type BlockExpiryRow,
  type BlockExpiryVerdict,
  type BlockRemoval,
  type ExpiredBlockCommand,
  type IpFamily,
  type IpSetSnapshot,
  type WafIpSets,
} from './domain/block-expiry.js';
export { ActiveCommandersUnavailable, type ActiveCommanders, type BlockIpSetReader, type CommandTimelineEntry } from './domain/ports.js';
export { OPS_EVENT_STAGES, OpsEventLog, OpsEventStore, opsEventLineOf, opsEventNameOf, type OpsEventLine, type OpsEventSink, type OpsEventStage } from './adapters/ops-event-log.js';
export { IdentityActiveCommanders } from './adapters/identity-active-commanders.js';
export {
  AwsWafIpSets,
  MemoryWafIpSets,
  WAF_ENDPOINT_ENV,
  WAF_IPSET_V4_ENV,
  WAF_IPSET_V6_ENV,
  WAF_OPEN_ENVS,
  WAF_SCOPE_ENV,
  wafIpSetsConfigFromEnv,
  type WafIpSetRef,
  type WafIpSetsConfig,
} from './adapters/waf-ip-sets.js';
export { DrizzleWafBlockExpiryView } from './adapters/db/drizzle-waf-block-expiry.js';
export { PostReviewBody, PostReviewConfirmationBody, PostReviewController, PostReviewView as PostReviewResponseView } from './inbound/post-review.controller.js';
export { COMMAND_OPS_EVENTS } from './tokens.js';
