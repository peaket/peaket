// inventory 컨텍스트의 공개 면(다른 모듈·시작 파일은 이 파일로만 들어온다).
export { HOLD_LUA, OPEN_SALE_LUA } from './adapters/hold-lua.js';
export { MemoryPurchaseSessions, type MemoryPurchaseSession, type PurchaseSessionAccess, unavailablePurchaseSessions } from './adapters/memory-purchase-sessions.js';
export { MemorySeatMap, type MemorySeatDef } from './adapters/memory-seat-map.js';
export { MemorySeatDb, MemorySeatEvent, MemorySeatStore, type MemoryHoldHash, type MemoryIdemRecord, type MemoryPublished } from './adapters/memory-seat-store.js';
export { RecordingHoldAttempts, discardHoldAttempts } from './adapters/recording-hold-attempts.js';
export { RedisSeatStore, SEAT_REDIS, seatKeys } from './adapters/redis-seat-store.js';
export { HOLD_PROBLEMS, HoldError, type HoldErrorCode, type HoldErrorDetails, type HoldProblemSpec, type ReplyHeaders, throwHoldProblem } from './application/hold-error.js';
export { HoldSeats, type HoldBody, type HoldCommand, type HoldResponse } from './application/hold-seats.js';
export {
  HOLD_TTL_MS,
  IDEM_TTL_MS,
  KEEP_AFTER_SALE_END_MS,
  KEY_PART,
  MAX_SEATS,
  REHOLD_WAIT_MS,
  SEAT_ID_PATTERN,
  SEAT_STATE_HELD,
  SEAT_STORE_RETRY_AFTER_SEC,
  SeatStoreUnavailable,
  holdFingerprint,
  type HeldHold,
  type HoldInput,
  type HoldResult,
  type SeatRef,
} from './domain/hold.js';
export {
  HOLD_ATTEMPTS,
  PURCHASE_SESSIONS,
  SEAT_MAP,
  SEAT_STORE,
  type EventSeatConfig,
  type HoldAttemptRecord,
  type HoldAttemptResult,
  type HoldAttempts,
  type PurchaseSessionInfo,
  type PurchaseSessions,
  type SeatMap,
  type SeatStore,
} from './domain/ports.js';
export { HOLD_OPERATION, HoldHeaders, HoldParams, HoldRequest, HoldResponseBody, HoldsController } from './inbound/holds.controller.js';
export { InventoryModule, type InventoryModuleOptions } from './inventory.module.js';
