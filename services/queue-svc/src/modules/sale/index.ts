// 회차 판매 상태 받기 컨텍스트의 공개 면(HOT-010, ADR-0214). Kafka 구독(src/consumers)과 시험은 이 파일로만 들어온다.
export { MemorySaleStates } from './adapters/memory-sale-states.js';
export { RedisSaleStates, SALE_STATE_LUA } from './adapters/redis-sale-states.js';
export { ApplySaleChange } from './application/apply-sale-change.js';
export { type EventSaleStatus, type QueueSaleState, SALE_STATE_FALLBACK_TTL_MS, SALE_STATES, type SaleApplyResult, type SaleChange, type SaleChangedEvent, type SaleStates } from './domain/sale.js';
export { EventSaleChangedHandler, jsonSaleChangedCodec, type SaleChangedCodec, type SaleRecord, SEATS_TOPIC } from './inbound/event-sale-changed.handler.js';
