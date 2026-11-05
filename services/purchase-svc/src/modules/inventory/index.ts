// inventory 컨텍스트의 공개 면(다른 모듈·시작 파일은 이 파일로만 들어온다).
export { EXPIRE_LUA, SWEEP_LEASE_LUA } from './adapters/expire-lua.js';
export { HOLD_LUA, OPEN_SALE_LUA } from './adapters/hold-lua.js';
export { ORDER_HOLD_LUA } from './adapters/order-hold-lua.js';
export { MemoryOrderHolds, type MemoryOrderHoldsDeps } from './adapters/memory-order-holds.js';
export { RedisOrderHolds } from './adapters/redis-order-holds.js';
export { SEAT_SLOT_READ_LUA } from './adapters/seat-slot-lua.js';
export { MemorySeatSlots, type MemorySeatSlotsDeps } from './adapters/memory-seat-slots.js';
export { RedisSeatSlots } from './adapters/redis-seat-slots.js';
export { PIN_LUA, RELEASE_FAILED_LUA } from './adapters/pin-lua.js';
export { BEGIN_REBUILD_LUA, BUMP_EPOCH_LUA, FINISH_REBUILD_LUA, REBUILD_QUOTAS_LUA, REBUILD_SEATS_LUA } from './adapters/rebuild-lua.js';
export { DrizzleSeatRebuildSource } from './adapters/db/drizzle-seat-rebuild.js';
export { SeatRebuilder, type SeatRebuilderDeps, type SeatRebuilderSignals } from './application/seat-rebuilder.js';
export {
  REBUILD_LOOK_AFTER_SALE_END_MS,
  REBUILD_LOOP_TICK_MS,
  SeatRebuildLoop,
  type RebuildLoopReport,
  type SeatRebuildLoopDeps,
  type SeatRebuildLoopLogger,
} from './application/seat-rebuild-loop.js';
export {
  RETIRE_SEAT_EVENTS_TASK,
  retireSeatEventsTask,
  type RetireSeatEventsDeps,
  type RetireSeatEventsReport,
  type RetireSeatEventsTask,
} from './application/retire-seat-events.js';
export { SeatMapEventCatalog, type SeatMapEventCatalogDeps } from './adapters/seat-map-event-catalog.js';
export {
  maxTokenOf,
  REBUILD_BATCH,
  REBUILD_LEASE_MS,
  planRebuild,
  quotasOf,
  type RebuildFinishInput,
  type RebuildHold,
  type RebuildLedgerRow,
  type RebuildOrderInputs,
  type RebuildPinnedOrder,
  type RebuildReport,
  type RebuildSale,
  type RebuildSaleOrder,
  type RebuildSeat,
  type RebuildStep,
} from './domain/rebuild.js';
export { MemoryPurchaseSessionStore, RecordingSessionStartedLog } from './adapters/memory-purchase-session-store.js';
export { MemoryPurchaseSessions, type MemoryPurchaseSession, type PurchaseSessionAccess } from './adapters/memory-purchase-sessions.js';
export { DrizzleSeatHoldLedger } from './adapters/db/drizzle-seat-hold-ledger.js';
export { DrizzleSeatSales } from './adapters/db/drizzle-seat-sales.js';
export { purchaseQuota, seatHold, seatRebuild, seatSale } from './adapters/db/schema.js';
export { FileSeatMapSource, LayoutSeatMap, type LayoutSeatMapOptions, type SeatMapSource } from './adapters/layout-seat-map.js';
export { MemorySeatMap, type MemorySeatDef } from './adapters/memory-seat-map.js';
export { MemorySeatDb, MemorySeatEvent, MemorySeatStore, type MemoryHoldHash, type MemoryIdemRecord, type MemoryPublished } from './adapters/memory-seat-store.js';
export { MemorySweepLeases } from './adapters/memory-sweep-leases.js';
export { PromSeatSignals } from './adapters/prom-seat-signals.js';
export {
  ADVANCE_SESSION_LUA,
  APPEND_SESSION_ENDED_LUA,
  APPEND_SESSION_STARTED_LUA,
  END_SESSION_LUA,
  MARK_SESSION_STARTED_LUA,
  OPEN_SESSION_LUA,
  PAY_SESSION_LUA,
  RECORD_HOLD_LUA,
  SWEEP_SESSION_LUA,
} from './adapters/purchase-session-lua.js';
export { RecordingHoldAttempts, discardHoldAttempts } from './adapters/recording-hold-attempts.js';
export { RedisPurchaseSessionStore, RedisSessionEndedLog, RedisSessionIndex, RedisSessionStartedLog, sessionKeys } from './adapters/redis-purchase-sessions.js';
export { RedisSeatStore, SEAT_REDIS, seatKeys } from './adapters/redis-seat-store.js';
export { RedisSeatStreamSource } from './adapters/redis-seat-stream.js';
export { KafkaTradeEventPublisher, jsonTradeEventCodec } from './adapters/trade-events.js';
export {
  SeatStreamRelay,
  type RelayEventReport,
  type RelayTickReport,
  type SeatStreamRelayDeps,
  type SeatStreamRelayLogger,
  type SeatStreamTickGuard,
} from './application/seat-stream-relay.js';
export { SNAPSHOT_LUA } from './adapters/snapshot-lua.js';
export { RedisSweepLeases } from './adapters/redis-sweep-leases.js';
export { PURCHASE_ECDH_KEY_ENV, ServerEcdhKey, type ServerEcdhJwk } from './adapters/server-ecdh.js';
export { ADMISSION_TOKEN_HEADER, admissionJtiOf, StoredPurchaseSessions, type StoredPurchaseSessionsDeps } from './adapters/stored-purchase-sessions.js';
export {
  ExpirySweeper,
  systemSweepTimer,
  type ExpirySweeperDeps,
  type SweepEventReport,
  type SweepLogFields,
  type SweepOutcome,
  type SweepTickReport,
  type SweepTimer,
} from './application/expiry-sweeper.js';
export { LogGate, OOM_WARN_GATE } from './application/log-gate.js';
export {
  OpenPurchaseSession,
  OpenSessionError,
  type OpenPurchaseSessionDeps,
  type OpenSessionCommand,
  type OpenSessionErrorCode,
  type OpenSessionLogger,
  type OpenSessionOutcome,
} from './application/open-purchase-session.js';
export { EndPurchaseSession, EndSessionError, type EndPurchaseSessionDeps, type EndSessionLogger } from './application/end-purchase-session.js';
export { podIdFrom } from './application/pod-id.js';
export {
  SESSION_SWEEP_BACKOFF_MS,
  SESSION_SWEEP_BATCH,
  SESSION_SWEEP_LEASE_TTL_MS,
  SESSION_SWEEP_MAX_BATCHES,
  SESSION_SWEEP_POISON_RETRY_MS,
  SESSION_SWEEP_TICK_MS,
  SessionSweeper,
  type SessionSweepEventReport,
  type SessionSweeperDeps,
  type SessionSweepOutcome,
  type SessionSweepTickReport,
} from './application/session-sweeper.js';
export { ReadSeatSnapshot, SnapshotError, type ReadSeatSnapshotDeps, type SnapshotCommand, type SnapshotErrorCode } from './application/read-seat-snapshot.js';
export {
  HOLD_PROBLEMS,
  HoldError,
  type HoldErrorCode,
  type HoldErrorDetails,
  type HoldProblemSpec,
  type ReplyHeaders,
  storeUnavailableError,
  throwHoldProblem,
} from './application/hold-error.js';
export { HoldSeats, type HoldBody, type HoldCommand, type HoldResponse } from './application/hold-seats.js';
export {
  ADMISSION_TOKEN_MAX_CHARS,
  AdmissionTokenRejected,
  FIRST_USE_MS,
  IAT_SKEW_MS,
  parseAdmissionJwks,
  verifyAdmissionToken,
  type AdmissionClaims,
  type AdmissionKeys,
  type AdmissionRejectReason,
} from './domain/admission-token.js';
export {
  FAILED_HOLD_MARK_TTL_MS,
  INITIAL_SEAT_GEN,
  RETIRE_AFTER_SALE_END_MS,
  assertPinInput,
  assertReleaseFailedInput,
  type PinInput,
  type PinResult,
  type ReleaseFailedInput,
  type ReleaseFailedResult,
  type RetireResult,
} from './domain/pin.js';
export {
  HOLD_EVENT_TYPES,
  PURCHASE_SESSION_TOPIC,
  SEAT_TOPIC,
  STREAM_RELAY_BACKOFF_MAX_MS,
  STREAM_RELAY_BACKOFF_MIN_MS,
  STREAM_RELAY_BATCH,
  STREAM_RELAY_CONSUMER,
  STREAM_RELAY_GROUP,
  STREAM_RELAY_MAX_BATCHES,
  STREAM_RELAY_TICK_MS,
  routeStreamEntry,
  seatEventKey,
  toLedgerHoldEvent,
  toSeatEvent,
  type HoldEventType,
  type LedgerHoldEvent,
  type SeatEventMessage,
  type SeatStreamEntry,
  type StreamDropReason,
  type StreamRoute,
  type TradeTopic,
} from './domain/seat-event.js';
export {
  MAX_SALE_SEATS,
  SALE_UUID_PATTERN,
  SEAT_SALE_STATUSES,
  assertReserveInput,
  assertSeatSaleOrder,
  assertSeatSaleRelease,
  sortedSeatIds,
  type ReserveInput,
  type ReserveResult,
  type SeatSaleOrder,
  type SeatSaleRelease,
  type SeatSaleStatus,
} from './domain/seat-sale.js';
export { parseClientEphemeralKey, type ClientEphemeralKey } from './domain/client-key.js';
export { parseEventSeatMapFile, parseTierPrices, SeatMapFileError, type ParsedSeatMap, type SeatMapFileErrorCode, type SectionRange } from './domain/seat-layout.js';
export { decodeSnapshot, encodeSnapshot, lsbFirstBits, SNAPSHOT_FLAG_SECTION_ONLY, SNAPSHOT_VERSION, U16_MAX, U32_MAX, type SnapshotBody } from './domain/snapshot.js';
export {
  EXPIRY_BACKOFF_MS,
  EXPIRY_BATCH_SIZE,
  EXPIRY_CONCURRENCY,
  EXPIRY_MAX_BATCHES_PER_TICK,
  EXPIRY_TICK_MS,
  OOM_WARN_INTERVAL_MS,
  POD_ID_HOST_CHARS,
  SWEEP_LEASE_TTL_MS,
  type DueExpiriesInput,
  type DueExpiry,
  type DueHold,
  type ExpiredHold,
  type ExpireInput,
  type ExpireResult,
  type ExpireSeat,
} from './domain/expiry.js';
export {
  HOLD_TTL_MS,
  IDEM_TTL_MS,
  KEEP_AFTER_SALE_END_MS,
  KEY_PART,
  MAX_SEATS,
  REHOLD_WAIT_MS,
  SEAT_CALL_CAP_MS,
  SEAT_CALL_MIN_REMAINING_MS,
  SEAT_ID_PATTERN,
  SEAT_STATE_AVAILABLE,
  SEAT_STATE_HELD,
  SEAT_STORE_RETRY_AFTER_SEC,
  SeatStoreUnavailable,
  holdFingerprint,
  type HeldHold,
  type HoldInput,
  type HoldResult,
  type ReplayInput,
  type ReplayResult,
  type SeatRef,
  type SeatStoreUnavailableReason,
} from './domain/hold.js';
export {
  CLIENT_KEY_PATTERN,
  SESSION_IDLE_MS,
  SESSION_KEY_GRACE_MS,
  SESSION_STARTED_GRACE_MS,
  SESSION_STARTED_KEEP_MS,
  SESSION_END_REASONS,
  SESSION_ENDED_TYPE,
  SESSION_STARTED_TYPE,
  SessionStoreFailure,
  UUID_PATTERN,
  assertJti,
  assertEndedEntry,
  assertIndexArgs,
  assertOpenInput,
  assertSeq,
  assertStartedEntry,
  sessionCheckAt,
  sessionEndedEventKey,
  sessionEndedFields,
  sessionStartedEventKey,
  sessionStartedFields,
  sessionStoreErrorOf,
  toPurchaseSessionEnded,
  toPurchaseSessionStarted,
  type EndedSession,
  type OpenSessionInput,
  type OpenSessionResult,
  type PurchaseSessionEndedMessage,
  type PurchaseSessionStartedMessage,
  type SessionEndedEntry,
  type SessionEndReason,
  type SessionStartedEntry,
  type StoredSession,
  type SweepSessionResult,
} from './domain/purchase-session.js';
export { seatLuaErrorOf, type SeatKeyKind, type SeatLuaError, type SeatLuaErrorCode, type SeatLuaScript } from './domain/lua-errors.js';
export {
  HASH_SLOTS,
  LARGE_EVENT_SEATS,
  MEDIUM_EVENT_SEATS,
  MEDIUM_EVENTS_PER_PRIMARY,
  PLACEMENT_TAG_MAX_K,
  checkPlacement,
  placementTag,
  slotOf,
  type PlacementConflict,
  type PlacementEvent,
  type SlotRange,
} from './domain/placement.js';
export {
  HOLD_ATTEMPTS,
  ORDER_HOLDS,
  PURCHASE_SESSION_STORE,
  PURCHASE_SESSIONS,
  SEAT_EXPIRIES,
  SEAT_MAP,
  SEAT_MAP_SECTIONS,
  SEAT_PINS,
  SEAT_SALES,
  SEAT_SNAPSHOTS,
  SESSION_ENDED_LOG,
  SESSION_HOLDS,
  SESSION_INDEX,
  SEAT_SIGNALS,
  SEAT_STORE,
  SESSION_STARTED_LOG,
  SWEEP_LEASES,
  noSeatSignals,
  type EventSeatConfig,
  type HoldAttemptRecord,
  type HoldAttemptResult,
  type HoldAttempts,
  type OrderHoldCheck,
  type OrderHoldQuery,
  type OrderHoldReader,
  type PurchaseSessionInfo,
  type PurchaseSessionStore,
  type PurchaseSessions,
  type SeatCallOptions,
  type SeatExpiries,
  type SeatMap,
  type SeatMapIndex,
  type SeatMapSections,
  type SeatEventRetire,
  type SeatHoldLedger,
  type SeatPins,
  type RebuildOrderSource,
  type SaleEvent,
  type SaleEventCatalog,
  type SeatRebuildMarks,
  type SeatRebuildSource,
  type SeatRebuildTarget,
  type SeatSales,
  type SeatSignals,
  type SeatStreamRelaySignals,
  type SeatStreamSource,
  type TradeEventCodec,
  type TradeEventPublisher,
  type TradeRecord,
  type SeatSnapshots,
  type SeatSlotRead,
  type SeatSlotReader,
  type SessionEndedLog,
  type SessionHolds,
  type SessionIndex,
  type SweepLane,
  type SnapshotReadInput,
  type SnapshotReadResult,
  type SeatStore,
  type SessionStartedLog,
  type SweepLeases,
} from './domain/ports.js';
export { PurchaseSessionController } from './inbound/purchase-session.controller.js';
export { SeatHoldLedgerHandler, type LedgerRecord } from './inbound/seat-hold-ledger.handler.js';
export { SnapshotController } from './inbound/snapshot.controller.js';
export { HOLD_OPERATION, HoldHeaders, HoldParams, HoldRequest, HoldResponseBody, HoldsController, SeatLuaFailure, sanitizedStoreError } from './inbound/holds.controller.js';
export { InventoryModule, type AdmissionOptions, type InventoryModuleOptions } from './inventory.module.js';
