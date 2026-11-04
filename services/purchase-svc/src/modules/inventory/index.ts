// inventory 컨텍스트의 공개 면(다른 모듈·시작 파일은 이 파일로만 들어온다).
export { EXPIRE_LUA, SWEEP_LEASE_LUA } from './adapters/expire-lua.js';
export { HOLD_LUA, OPEN_SALE_LUA } from './adapters/hold-lua.js';
export { MemoryPurchaseSessions, type MemoryPurchaseSession, type PurchaseSessionAccess, unavailablePurchaseSessions } from './adapters/memory-purchase-sessions.js';
export { MemorySeatMap, type MemorySeatDef } from './adapters/memory-seat-map.js';
export { MemorySeatDb, MemorySeatEvent, MemorySeatStore, type MemoryHoldHash, type MemoryIdemRecord, type MemoryPublished } from './adapters/memory-seat-store.js';
export { MemorySweepLeases } from './adapters/memory-sweep-leases.js';
export { PromSeatSignals } from './adapters/prom-seat-signals.js';
export { RecordingHoldAttempts, discardHoldAttempts } from './adapters/recording-hold-attempts.js';
export { RedisSeatStore, SEAT_REDIS, seatKeys } from './adapters/redis-seat-store.js';
export { RedisSweepLeases } from './adapters/redis-sweep-leases.js';
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
export { podIdFrom } from './application/pod-id.js';
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
  PURCHASE_SESSIONS,
  SEAT_EXPIRIES,
  SEAT_MAP,
  SEAT_SIGNALS,
  SEAT_STORE,
  SWEEP_LEASES,
  noSeatSignals,
  type EventSeatConfig,
  type HoldAttemptRecord,
  type HoldAttemptResult,
  type HoldAttempts,
  type PurchaseSessionInfo,
  type PurchaseSessions,
  type SeatCallOptions,
  type SeatExpiries,
  type SeatMap,
  type SeatMapIndex,
  type SeatSignals,
  type SeatStore,
  type SweepLeases,
} from './domain/ports.js';
export { HOLD_OPERATION, HoldHeaders, HoldParams, HoldRequest, HoldResponseBody, HoldsController, SeatLuaFailure, sanitizedStoreError } from './inbound/holds.controller.js';
export { InventoryModule, type InventoryModuleOptions } from './inventory.module.js';
