// 판매 중지·재개 모듈의 공개 면(BAT-465 R-584, ADR-0123). AppModule/start와 시험이 이 파일로만 들어온다.
export { SetSaleSuspension } from './application/set-sale-suspension.js';
// 명령 3(판매 일시정지)·파드 메모리·시작 작업과 2초 다시 맞춤(F-02-1 OPS-300, ADR-0365 결정 6~8)
export { SetSalePause, type SetSalePauseInput, type SetSalePauseResult } from './application/set-sale-pause.js';
export { SaleControlMemory } from './application/sale-control-memory.js';
export { SALE_CONTROL_READINESS_TASK, SaleControlReconciler, type ReconcileTimer, type SaleControlReconcilerDeps } from './application/reconcile-sale-control.js';
export { MemorySaleControlCopies } from './adapters/memory-sale-control-copies.js';
export { MemorySaleControlStore } from './adapters/memory-sale-control-store.js';
export { DrizzleSaleControlStore } from './adapters/db/drizzle-sale-control-store.js';
export { RedisSaleControlCopies, SALE_CONTROL_COPY_TTL_MS } from './adapters/redis-sale-control-copies.js';
export {
  SALE_SUSPENSION_ACTIONS,
  type SaleControl,
  type PlatformSalePause,
  type SaleControlScope,
  type SaleControlSnapshot,
  type SalePauseApplied,
  type SalePauseScope,
  type SalePauseWrite,
  type SaleSuspensionAction,
  type SaleSuspensionApplied,
  type SaleSuspensionInput,
  type SaleSuspensionResult,
  type SaleSuspensionWrite,
} from './domain/sale-control.js';
export { SALE_CONTROL_COPIES, SALE_CONTROL_STORE, type SaleControlCopies, type SaleControlStore, type SalePauseView } from './domain/ports.js';
export { SaleSuspensionController } from './inbound/sale-suspension.controller.js';
export { SaleControlModule, type SaleControlModuleDeps } from './sale-control.module.js';
