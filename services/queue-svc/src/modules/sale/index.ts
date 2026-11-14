// 회차 판매 상태 받기 컨텍스트의 공개 면(HOT-010, ADR-0214). Kafka 구독(src/consumers)과 시험은 이 파일로만 들어온다.
// 엣지 매진 표시 포트와 시험 대역(HOT-011, ADR-0219)도 여기서 낸다. 실제 KeyValueStore 어댑터는 HOT-012다.
export { MemoryEdgeSaleFlags } from './adapters/memory-edge-sale-flags.js';
export { MemorySaleStates } from './adapters/memory-sale-states.js';
export { RedisSaleStates, SALE_STATE_LUA } from './adapters/redis-sale-states.js';
export { ApplySaleChange, type ApplySaleChangeOptions } from './application/apply-sale-change.js';
export { EdgeFlagSync, type EdgeFlagSyncOptions, edgeSyncPausedFromEnv } from './application/edge-flag-sync.js';
export {
  EDGE_FLAG_BREAKER,
  EDGE_FLAG_CACHE_MAX,
  EDGE_FLAG_KEY_PREFIX,
  EDGE_FLAG_PUT_DEADLINE_MS,
  EDGE_FLAG_RESYNC_BATCH,
  EDGE_FLAG_RESYNC_EVERY_MS,
  EDGE_FLAG_RESYNC_MS,
  type EdgeFlagEntry,
  type EdgeFlagSignals,
  EdgeFlagsUnavailable,
  type EdgePutResult,
  type EdgeSaleFlag,
  type EdgeSaleFlags,
  edgeFlagEntry,
} from './domain/edge.js';
export {
  AVG_TICKETS_MAX,
  AVG_TICKETS_MIN,
  type EventSaleStatus,
  type QueueSaleState,
  SALE_STATE_FALLBACK_TTL_MS,
  SALE_STATES,
  type SaleApplyOutcome,
  type SaleApplyResult,
  type SaleChange,
  type SaleChangedEvent,
  type SaleStates,
  SEAT_COUNT_CLOCK_SKEW_MS,
  type SeatCounts,
} from './domain/sale.js';
export { EventSaleChangedHandler, jsonSaleChangedCodec, type SaleChangedCodec, type SaleRecord, SEATS_TOPIC } from './inbound/event-sale-changed.handler.js';
export { SetSaleSuspensionCopy, type SaleSuspensionCopyResult, type SetSaleSuspensionCopyInput } from './application/set-sale-suspension-copy.js';
export { MemorySaleSuspensionCopies } from './adapters/memory-sale-suspension-copies.js';
export { RedisSaleSuspensionCopies, SALE_SUSPENSION_COPY_TTL_MS } from './adapters/redis-sale-suspension-copies.js';
export { SALE_SUSPENSION_ACTIONS, SALE_SUSPENSION_COPIES, type SaleSuspensionAction, type SaleSuspensionCopies, type SaleSuspensionCopyWrite } from './domain/sale-suspension.js';
export { SaleSuspensionCopyController } from './inbound/sale-suspension-copy.controller.js';
export { SaleSuspensionModule } from './sale-suspension.module.js';
