// @peaket/platform: 서비스(NestJS·Fastify) 공용 시작 코드(docs/architecture.md §10, openspec 변경 add-service-template).
export { CLOCK, fakeClock, systemClock, type Clock, type FakeClock } from './clock.js';
export { DEBUG_ERRORS_ALLOWED, HEADLESS_ROUND_ROBIN_ALLOWED, LOG_LEVELS, PEAKET_ENVS, PlatformConfigError, loadPlatformConfig, type LogLevelName, type PeaketEnv, type PlatformConfig } from './config.js';
export { currentDeadline, requestContext, runInRequestContext, type RequestContext } from './context.js';
export { ADMIN_AUTHZ_CACHE_MS, COOKIE_CHALLENGE, CurrentPrincipal, ROLE_VALUES, Roles, TERMINATED_SESSION_TTL_MS, currentPrincipal, type AdminAuthz, type AdminAuthzPort, type Audience, type Principal, type RoleValue, type RolesOptions } from './auth.js';
export { AcceptTextPlain, ContractBody, ContractHeaders, ContractParams, ContractQuery, ContractRouteSchema, RequestValidationError, contractRouteSchema, type ContractRouteSchemaInput } from './request-checks.js';
export { DEADLINE_HEADER, DEFAULT_MAX_DEADLINE_MS, Deadline } from './deadline.js';
export { LATENCY_BUCKETS_SECONDS, PlatformMetrics } from './metrics.js';
export { contractSchema, emitOpenApi, type EmitOpenApiOptions } from './openapi.js';
export { PROBLEM_CONTENT_TYPE, PROBLEM_TYPE_BASE, ProblemError, deadlineExceeded, serverBusy, type ProblemInit } from './problem.js';
export { DATABASE, POOL_DEFAULTS, createDatabase, databaseModule, type Database, type DatabaseOptions, type DatabaseProfile, type DbTransaction, type TransactionOptions } from './database.js';
export { ProblemFilter } from './problem-filter.js';
export { createService, type CreateServiceOptions, type PlatformService } from './service.js';
export { clientFamily } from './client-family.js';
export { LOG_PSEUDONYM_KEY_ENV, LogPseudonymizer, ipPrefix, loadLogPseudonymizer } from './pseudonym.js';
export { sampleKeep, sampleThreshold } from './sampling.js';
export { APP_HEADER, APPS } from './http-hooks.js';
export { NestPinoLogger, PLATFORM_LOGGER, REDACTED_KEYS, createPlatformLogger, kstIso, type PlatformLogger, type PlatformLoggerOptions } from './log.js';
export { LogPolicy, requestLog, type QueuePhase, type RequestLog, type RequestLogFields, type RouteLogPolicy } from './request-log.js';
export { TRACE_PROPAGATION_HEADERS, createExternalHttpClient, type ExternalHttpClient, type ExternalHttpClientOptions, type ExternalRequest } from './http-client.js';
export { BoundaryPropagator, BoundarySpanProcessor, withoutTracePropagation, type InboundTrust } from './trace-boundary.js';
export { rawBodyOf } from './raw-body.js';
export {
  IDEMPOTENCY_RECORD_TABLE,
  IDEMPOTENCY_RETENTION_MS,
  IDEMPOTENCY_WAIT_MS,
  IdempotencyRequest,
  IdempotencyStore,
  Idempotent,
  deleteExpiredIdempotencyRecords,
  idempotencyKeyInvalid,
  idempotencyKeyReused,
  idempotencyRecordTable,
  idempotencyRequestInProgress,
  parseIdempotencyKey,
  requestFingerprint,
  type IdempotencyStoreOptions,
  type IdempotentOptions,
  type IdempotentSteps,
} from './idempotency.js';
export { uuidLowerBound, uuidv7, uuidv7Time } from './uuid.js';
export {
  CONTROL_TOPICS,
  MAINTENANCE_WINDOW_KST,
  OUTBOX_PARTITION_DEFAULTS,
  OUTBOX_TABLE,
  dropExpiredOutboxPartitions,
  ensureOutboxPartitions,
  inMaintenanceWindow,
  kstDayStart,
  outboxHealth,
  outboxPartitionOf,
  writeOutbox,
  type DropResult,
  type OutboxHealth,
  type OutboxMessage,
} from './outbox.js';
export { OUTBOX_RELAY_DEFAULTS, OutboxRelay, OutboxRelayMetrics, type LeaderState, type OutboxPublisher, type OutboxRecord, type OutboxRelayOptions } from './outbox-relay.js';
export { LEASE_DEFAULTS, LeaseElector, inClusterLeaseApi, kubernetesLeaseApi, type KubernetesLeaseApiOptions, type LeaseApi, type LeaseElectorOptions, type LeaseRecord, type LeaseSpec } from './lease.js';
export { RELAY_PROCESS_DEFAULTS, loadOutboxRelayProcessConfig, startOutboxRelayProcess, type OutboxRelayProcess, type OutboxRelayProcessConfig, type OutboxRelayProcessOptions } from './relay-process.js';
export { KAFKA_CONSUMER_LOCKED, KAFKA_PRODUCER_LOCKED, KAFKA_REQUIRED, kafkaConsumerConfig, kafkaProducerConfig, type KafkaClientBase, type KafkaClientConfig, type KafkaProducerKind } from './kafka-config.js';
export {
  KEYED_CONSUMER_DEFAULTS,
  KeyedConsumerMetrics,
  KeyedPartition,
  PauseGate,
  TransientError,
  errorSummary,
  isTransientError,
  type ConsumedMessage,
  type HeldEventInput,
  type HeldEventStore,
  type KeyedHandler,
  type KeyedPartitionOptions,
} from './keyed-consumer.js';
export { HELD_EVENT_KEEP_DAYS, HELD_EVENT_TABLE, deleteReprocessedHeldEvents, drizzleHeldEventStore, heldEventCounts, heldEventTable, reprocessHeldEvents, type ReprocessResult } from './held-events.js';
export { Readiness } from './readiness.js';
export {
  CONTROL_SYNC_DEFAULTS,
  ControlState,
  ControlSyncMetrics,
  SettingsStore,
  startControlSync,
  type BroadcastRecord,
  type BroadcastSource,
  type ControlCodec,
  type ControlEntry,
  type ControlStateSource,
  type ControlSync,
  type ControlSyncHost,
  type ControlSyncOptions,
  type SessionTerminated,
  type SettingChanged,
  type SettingEntry,
} from './control.js';
export {
  MONTHLY_PARTITION_DEFAULTS,
  addKstMonths,
  analyzeTable,
  dropMonthlyPartitions,
  ensureMonthlyPartitions,
  kstMonthStart,
  monthlyPartitionOf,
  monthlyPartitionsAhead,
  type MonthlyPartition,
  type MonthlyPartitionSpec,
} from './partitions.js';
export { STAT_SNAPSHOT_KEEP_DAYS, STAT_SNAPSHOT_TABLE, statSnapshotTable, takeStatSnapshot } from './stat-snapshot.js';
export { REINDEX_DEFAULTS, RETENTION_DEFAULTS, deleteExpiredRows, reindexBloatedIndexes, retentionBoundary, retentionOverdueSeconds, type ReindexResult, type RetentionResult, type RetentionSpec } from './retention.js';
export { STREAM_KEY_TTL_AFTER_SALE_MS, ackAndTrimStream, compareStreamIds, expireStreamAfterSale, nextStreamId, type RedisCommander } from './redis-stream.js';
export {
  MAINTENANCE_DEFAULTS,
  MaintenanceRunner,
  maintenanceMetrics,
  monthlyPartitionTasks,
  platformMaintenanceTasks,
  reindexTask,
  retentionTask,
  type MaintenanceMetrics,
  type MaintenanceRunnerOptions,
  type MaintenanceTask,
} from './maintenance.js';
export {
  CIRCUIT_BREAKER_DEFAULTS,
  CircuitBreaker,
  CircuitBreakerMetrics,
  createCircuitBreaker,
  dependencyUnavailable,
  isBreakerFailure,
  type CircuitBreakerOptions,
  type CircuitState,
} from './circuit-breaker.js';
export {
  CurrentPurchaseSession,
  PURCHASE_KEY_BYTES,
  PURCHASE_KEY_INFO,
  PURCHASE_MAC_HEADER,
  PURCHASE_SEQ_HEADER,
  PurchaseSigned,
  parsePurchaseMac,
  parsePurchaseSeq,
  purchaseMac,
  purchaseMacInput,
  purchaseRequestKey,
  type PurchaseRejection,
  type PurchaseSession,
  type PurchaseSessionPort,
} from './purchase-auth.js';
export {
  GRPC_CHANNEL_LOCKED,
  GRPC_HEADLESS_MAX_CONNECTION_AGE_MS,
  GRPC_LB_PROFILES,
  createGrpcClient,
  grpcChannelOptions,
  grpcServerOptions,
  grpcTarget,
  peaketGrpcInterceptor,
  type GrpcClientOptions,
  type GrpcInterceptorOptions,
  type GrpcLbProfile,
} from './grpc-channel.js';
