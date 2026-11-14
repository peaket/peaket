// 판매 중지·재개 모듈의 공개 면(BAT-465 R-584, ADR-0123). AppModule/start와 시험이 이 파일로만 들어온다.
export { SetSaleSuspension } from './application/set-sale-suspension.js';
export { MemorySaleControlCopies } from './adapters/memory-sale-control-copies.js';
export { MemorySaleControlStore } from './adapters/memory-sale-control-store.js';
export { DrizzleSaleControlStore } from './adapters/db/drizzle-sale-control-store.js';
export { RedisSaleControlCopies, SALE_CONTROL_COPY_TTL_MS } from './adapters/redis-sale-control-copies.js';
export {
  SALE_SUSPENSION_ACTIONS,
  type SaleControl,
  type SaleControlScope,
  type SaleSuspensionAction,
  type SaleSuspensionApplied,
  type SaleSuspensionInput,
  type SaleSuspensionResult,
  type SaleSuspensionWrite,
} from './domain/sale-control.js';
export { SALE_CONTROL_COPIES, SALE_CONTROL_STORE, type SaleControlCopies, type SaleControlStore } from './domain/ports.js';
export { SaleSuspensionController } from './inbound/sale-suspension.controller.js';
export { SaleControlModule, type SaleControlModuleDeps } from './sale-control.module.js';
