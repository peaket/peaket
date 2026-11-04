// booking 컨텍스트의 공개 면(다른 모듈·시작 파일은 이 파일로만 들어온다, BUILD_ORDER PRF-160).
import type { MaintenanceTask } from '@peaket/platform';
import { checkOrderHistory } from './adapters/db/drizzle-orders.js';
import { orderHistoryCheckTask as historyTaskOf, type OrderHistoryTaskDeps } from './application/order-history-check.js';

export { DrizzleOrderStore, checkOrderHistory, type DrizzleOrderStoreOptions } from './adapters/db/drizzle-orders.js';
export { orderEvent, orderIdempotency, orderItem, paymentAttempt, purchaseOrder } from './adapters/db/schema.js';
export { jsonOrderEventCodec, TRADE_ORDERS_TOPIC } from './adapters/order-events.js';
export { PromOrderSignals } from './adapters/prom-order-signals.js';
export { ORDER_HISTORY_TASK, type OrderHistoryTaskDeps } from './application/order-history-check.js';

/**
 * 매일 주문 상태·이력 검사 정비 일(application/order-history-check.ts). check를 주지 않으면 checkOrderHistory(purchase DB)로 검사한다.
 * 유스케이스 층은 어댑터를 가져오지 않으므로(architecture §3.1) 기본값은 모듈 공개 면인 여기서 채운다
 */
export function orderHistoryCheckTask(deps: OrderHistoryTaskDeps): MaintenanceTask {
  return historyTaskOf({ ...deps, check: deps.check ?? checkOrderHistory });
}
export {
  ACTOR_PATTERN,
  buildOrderEvent,
  FIRST_IN_STAGE_STATUSES,
  ORDER_HISTORY_BATCH,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  orderEventKey,
  orderEventType,
  PAYMENT_RESULT_TRANSITIONS,
  transitionById,
  type BuildOrderEventInput,
  type CreatedExtras,
  type OrderEventMessage,
  type OrderEventType,
  type OrderItem,
  type OrderRow,
  type OrderStatus,
  type OrderTransition,
  type SeatAssignment,
  type TransitionId,
} from './domain/order.js';
export type {
  NewOrder,
  OrderEventCodec,
  OrderHistoryMismatch,
  OrderHistoryReport,
  OrderSignals,
  TransitionInput,
  TransitionResult,
} from './domain/ports.js';
