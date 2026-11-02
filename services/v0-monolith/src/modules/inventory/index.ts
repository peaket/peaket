// 이 모듈의 공개 파일. 다른 컨텍스트는 층 폴더가 아니라 이 파일로만 가져온다(층 규칙).
export { InventoryModule, type InventoryModuleOptions } from './inventory.module.js';
export { createSeatAdmin, type SeatAdmin } from './inventory-admin.js';
export { createSeatSales } from './inventory-sales.js';
export type { SaleHold, SaleHoldResult, SaleSeat, SeatSales, SellResult, UnsellResult } from './domain/sales.js';
export { createPgDeltaFeed, DELTA_CHANNEL, type PgDeltaFeed } from './adapters/db/pg-delta-feed.js';
export {
  DEFAULT_EXTEND_MS,
  DEFAULT_HOLD_TTL_MS,
  EVENT_ID_PATTERN,
  MAX_SEATS_PER_HOLD,
  SEAT_ID_PATTERN,
  kstIso,
  seatGrid,
  type HoldView,
  type SeatDefinition,
  type SeatDelta,
  type SeatEventConfig,
  type SeatGridOptions,
  type SeatStatus,
  type SeatView,
} from './domain/inventory.js';
export type { AdmissionCheck, DeltaFeed } from './domain/ports.js';
