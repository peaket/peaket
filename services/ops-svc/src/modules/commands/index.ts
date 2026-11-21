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
export { MaintainCommands, type MaintainCommandsOptions, type MaintenanceRound } from './application/maintain-commands.js';
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
export { CommandsController } from './inbound/commands.controller.js';
export { CommandDryRunsController } from './inbound/command-dry-runs.controller.js';
export { CommandMaintenanceJob, type CommandMaintenanceOptions } from './inbound/command-maintenance.job.js';
export { CommandBody, CommandDryRunView, CommandIdParams, CommandPageView, CommandView, ReasonBody, RejectBody, baseViewOf, canApproveOf, viewOf } from './inbound/command-view.js';
