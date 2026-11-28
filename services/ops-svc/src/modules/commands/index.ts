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
export { EdgeCommandExecutor, type EdgeCommandExecutorDeps, type EdgeCommandResult } from './application/edge-command-executor.js';
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
  DEGRADED_SCOPE_PLATFORM,
  ENTRY_DEGRADED,
  ENTRY_DEGRADED_MAX_TTL_MS,
  SOLD_OUT_STATIC,
  STATE_DEGRADED,
  STATE_DEGRADED_MAX_EVENTS,
  STATE_MIRROR_FIXED,
  degradedAuditOf,
  degradedModeOf,
  degradedScopeOf,
  isCdnModeParams,
  isEntryDegradedParams,
  isNewDegradedMode,
  isStateDegradedParams,
  type CdnDegradedParams,
  type DegradedMode,
  type EntryDegradedParams,
  type StateDegradedParams,
} from './domain/degraded-modes.js';
export {
  WafBlockApplyError,
  type CdnEdgeChange,
  type CdnEdgeSettings,
  type CdnEdgeState,
  type CdnOriginGroup,
  type EntryModeStore,
  type EntryModeValue,
  type WafBlockInput,
  type WafBlockPart,
  type WafBlockRemaining,
  type WafBlocks,
} from './domain/edge-ports.js';
export { MemoryCdnEdgeSettings } from './adapters/memory-cdn-edge-settings.js';
export { MemoryEntryMode } from './adapters/memory-entry-mode.js';
export { MemoryWafBlocks } from './adapters/memory-waf-blocks.js';
export { WafAsnWriteOnly, type WafAsnFunction } from './adapters/waf-asn-write-only.js';
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
// 시험이 명령 모듈의 공개 면만으로 메모리 저장소·감사 체인을 함께 세운다(F-02-6 포트·감사 계약 시험)
export { MemoryAuditChain } from '../audit/index.js';
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
// 명령 6 결제 갈래 전송(F-02-2 OPS-310, ADR-0366 결정 1·4·5·7·8)
export { GrpcPgSwitchResolver, PG_SWITCH_RESOLVE_TIMEOUT_MS, pgSwitchRoutesOf, type GrpcPgSwitchResolverOptions } from './adapters/grpc-pg-switch-resolver.js';
export { PgSwitchPlanner, type PgSwitchPlannerDeps } from './application/pg-switch-plan.js';
export { DEGRADED_MODE_SETTING } from './application/dispatch-control.js';
export { admissionPgOf, ENTRY_PAUSE_RELEASE_KIND, entryReleaseStates, missingPgRoutes, PG_FALLBACK_GROUP, PG_FALLBACK_LIMIT_PGS, PG_SWITCH_KIND, pgSwitchDesiredStates, pgSwitchOffStates, pgTpsOf, REVERT_RELEASE_PGS, type PgSwitchRoute, type PgSwitchRoutes } from './domain/pg-switch.js';
export { ENTRY_RELEASE_PGS, entryReleaseParamsOf, type EntryReleasePg, type EntryReleaseParams } from './domain/command-params.js';
export { isEntryReleaseParams, isRevertibleCommand, PAYMENT_ENTRY_RELEASE } from './domain/command.js';
export type { PgSwitchResolver } from './domain/ports.js';
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
  type BlockAsnSets,
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
// 제어 gRPC 판 원장·퍼뜨리기·ack(F-02-1 OPS-300, ADR-0365 결정 1~4. F-02-2가 명령 6·런북 길에 쓴다)
export { CONTROL_ACK_TIMEOUT_MS, CONTROL_RETRY_MS, ControlAwareExecutor, ControlDispatcher, ControlFanout, type ControlDispatcherDeps, type ControlFanoutDeps, type ControlLog } from './application/dispatch-control.js';
export {
  ADMISSION_TARGET_HOLD_MS,
  CONTROL_SCOPE_PLATFORM,
  CONTROL_SERVICES,
  DISPATCHED_CONTROL_TYPES,
  controlDeliveriesOf,
  controlKindOf,
  controlScopesOf,
  isDispatchedControl,
  type ControlDelivery,
  type ControlDeliveryTimes,
  type ControlKindName,
  type ControlPhase,
  type ControlService,
} from './domain/control-kinds.js';
export type { CommandDeliveryView } from './domain/command.js';
export type { ControlDeliverer, ControlDeliverResult, ControlDeliveries, ControlDeliveryRow, ControlTargets, ControlTransport, LobbyBannerTemplates } from './domain/ports.js';
export { noApprovedLobbyBannerTemplates } from './domain/ports.js';
export { LOBBY_BANNER_TEMPLATE_ID } from './domain/control-kinds.js';
export { requestUntilMs } from './application/dispatch-control.js';
export { MemoryControlDeliveries, deliveryViewOf, type DeliveryViewRow } from './adapters/memory-control-deliveries.js';
export { DrizzleControlDeliveries } from './adapters/db/drizzle-control-deliveries.js';
