// booking 컨텍스트의 공개 면(다른 모듈·시작 파일은 이 파일로만 들어온다, BUILD_ORDER PRF-160·PRF-161·PRF-162).
import type { MaintenanceTask } from '@peaket/platform';
import { checkOrderHistory } from './adapters/db/drizzle-orders.js';
import { orderHistoryCheckTask as historyTaskOf, type OrderHistoryTaskDeps } from './application/order-history-check.js';

export { DrizzleOrderStore, checkOrderHistory, type DrizzleOrderStoreOptions } from './adapters/db/drizzle-orders.js';
export { DrizzleOrderAccepts, type DrizzleOrderAcceptsOptions } from './adapters/db/drizzle-order-accepts.js';
export { DrizzleOrderWrites, ORDER_HOLD_KEY, type DrizzleOrderWritesOptions } from './adapters/db/drizzle-order-writes.js';
export { orderEvent, orderIdempotency, orderItem, orderSagaJob, paymentAttempt, purchaseOrder } from './adapters/db/schema.js';
export {
  GrpcContactRefs,
  GrpcIdentityRecheck,
  IDENTITY_GRPC_ADDR_ENV,
  identityClientsFromEnv,
  missingContactRefs,
  RECHECK_RETRY_CODES,
  recheckFailureOf,
  unavailableIdentityRecheck,
  type GrpcIdentityOptions,
} from './adapters/grpc-identity.js';
export {
  InventoryOrderSessions,
  InventorySeatSlots,
  SeatMapSaleConfigs,
  type PurchaseSessionSource,
  type SaleConfigSource,
  type SeatSlotSource,
} from './adapters/inventory-bridges.js';
export { jsonOrderEventCodec, TRADE_ORDERS_TOPIC } from './adapters/order-events.js';
export { LoggerOrderLog } from './adapters/order-log.js';
export { PromOrderSignals } from './adapters/prom-order-signals.js';
export { bookingRestrictionKey, MemoryBookingRestrictions, RedisBookingRestrictions } from './adapters/redis-booking-restrictions.js';
export {
  ACCEPT_PAYMENT_OPERATION,
  AcceptPayment,
  ATTEMPT_ACCEPT_WINDOW_MS,
  SAGA_FIRST_STEP,
  type AcceptPaymentCommand,
  type AcceptPaymentDeps,
  type AcceptPaymentRejection,
  type AcceptPaymentResult,
} from './application/accept-payment.js';
export {
  CONTACT_REF_DEADLINE_MS,
  CREATE_ORDER_OPERATION,
  CreateOrder,
  IDENTITY_RECHECK_DEADLINE_MS,
  type CreateOrderBody,
  type CreateOrderCommand,
  type CreateOrderDeps,
  type CreateOrderRejection,
  type CreateOrderResult,
} from './application/create-order.js';
export { ORDER_HISTORY_TASK, type OrderHistoryTaskDeps } from './application/order-history-check.js';
export { BookingModule, CONSENT_VERSION_ENV, type BookingModuleDeps } from './booking.module.js';
export {
  BUYER_TEXT_MAX,
  ORDER_AMOUNT_MAX,
  buyerOf,
  consentVerdict,
  priceSeats,
  type OrderBuyer,
  type OrderBuyerInput,
  type OrderConsents,
  type OrderPricing,
} from './domain/order-request.js';
export { toE164 } from './domain/phone.js';
export {
  FALLBACK_REASONS,
  judgeRecheck,
  TICKET_BUY_SCOPE,
  type FallbackReason,
  type MisconfiguredReason,
  type RecheckAnswer,
  type RecheckFailure,
  type RecheckToken,
  type RecheckVerdict,
} from './domain/recheck.js';
export {
  ACCEPT_PROBLEMS,
  AcceptParams,
  CONSENT_VERSION_PATTERN,
  CreateOrderRequest,
  ORDER_PROBLEMS,
  OrderHeaders,
  OrderResponseBody,
  OrdersController,
  orderResponseOf,
  PaymentAcceptRequest,
  throwAcceptProblem,
  throwOrderProblem,
  type OrderProblemSpec,
  type OrderResponse,
} from './inbound/orders.controller.js';

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
export { OrderSeatStoreUnavailable } from './domain/ports.js';
export type {
  AcceptInput,
  AcceptLog,
  AcceptOrderView,
  AcceptOutcome,
  ActiveAttemptView,
  AttemptMismatchReason,
  BookingRestriction,
  BookingRestrictions,
  CommittedAcceptLookup,
  CommittedOrderLookup,
  ContactRefs,
  HeldSeat,
  IdentityRecheck,
  IdentityRecheckQuery,
  NewOrder,
  OrderAcceptReads,
  OrderAcceptWrites,
  OrderCreateOutcome,
  OrderEventCodec,
  OrderHistoryMismatch,
  OrderHistoryReport,
  OrderHoldCheck,
  OrderHoldQuery,
  OrderHolds,
  OrderLog,
  OrderRequestOnce,
  OrderSessions,
  OrderSessionView,
  OrderSignals,
  OrderView,
  OrderWrites,
  PaymentAcceptBody,
  PaymentPg,
  PaymentRefs,
  SaleConfig,
  SaleConfigs,
  SeatSlotRead,
  SeatSlotReads,
  TransactionCallOptions,
  TransitionInput,
  TransitionResult,
} from './domain/ports.js';
