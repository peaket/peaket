// 예매 취소·환급 모듈(BUILD_ORDER GAT-070·GAT-080·GAT-120·GAT-130). 도메인·유스케이스·어댑터를 내보낸다.
export {
  businessHoursBetween,
  calendarDaysBefore,
  deductionBpFor,
  parseHolidayCalendar,
  quoteRefund,
  seoulDateKey,
  WeekendBusinessCalendar,
  type BusinessCalendar,
  type RefundQuote,
  type RefundQuoteInput,
  type RefundQuoteResult,
} from './domain/refund-policy.js';
export {
  CANCELLATION_REASONS,
  CANCELLATION_STATUSES,
  REFUND_RETRY_MAX_ATTEMPTS,
  refundRetryDelayMs,
  type CancellationOrderView,
  type CancellationReason,
  type CancellationRecord,
  type CancellationStatus,
  type CancellationWriteOutcome,
  type CancelTicketResult,
  type DueRefund,
  type PaymentCancelOutcome,
  type RefundAccount,
  type TicketCancelOutcome,
} from './domain/cancellation.js';
export type { CancellationConfigs, CancellationOrders, CancellationWrites, PaymentCancellations, ReauthGate, RefundDeps, RefundFailureNotice, SeatReturnNotices, SeatReturns, TicketCancellations } from './domain/ports.js';
export { DrizzleCancellationOrders, DrizzleCancellationWrites, DrizzleSeatReturns } from './adapters/db/drizzle-cancellation.js';
export { GrpcTicketCancellations, type GrpcTicketCancellationsOptions } from './adapters/grpc-ticket-cancellations.js';
export { GrpcPaymentCancellations, type GrpcPaymentCancellationsOptions } from './adapters/grpc-payment-cancellations.js';
export { RedisSeatReturnNotices } from './adapters/redis-seat-returns.js';
export { CancelTicket, zeroDeductionFor, type CancelTicketInput } from './application/cancel-ticket.js';
export { RefundModule, type RefundModuleDeps } from './refund.module.js';
export { TicketCancellationController, unavailableReauth } from './inbound/ticket-cancellation.controller.js';
export { eventStartsAtOf, QuoteCancellation, type CancellationQuoteView, type QuoteCancellationInput, type QuoteCancellationResult } from './application/quote-cancellation.js';
export { RefundAfterEntry, type RefundAfterEntryDeps, refundAfterEntryTask } from './application/refund-after-entry.js';
export { REFUND_RETRY_TICK_MS, RefundRetryLoop, type RefundRetryLoopDeps, type RefundRetryTick } from './application/refund-retry-loop.js';
export {
  compensationAmount,
  eventRefundCancellationId,
  eventRefundRetryDelayMs,
  progressOf,
  rateBp,
  EVENT_REFUND_ATTEMPT_OUTCOMES,
  EVENT_REFUND_AUTO_STOP,
  EVENT_REFUND_FAULTS,
  EVENT_REFUND_ITEM_STATUSES,
  EVENT_REFUND_KINDS,
  EVENT_REFUND_STATUSES,
  REFUND_JOB_STATES,
  REFUND_PAUSE_REASONS,
  REFUND_PG_PROVIDERS,
  type EventCancellationRequest,
  type EventRefundAttempt,
  type EventRefundAttemptOutcome,
  type EventRefundFault,
  type EventRefundItem,
  type EventRefundItemStatus,
  type EventRefundKind,
  type EventRefundPgProgress,
  type EventRefundPreview,
  type EventRefundProgress,
  type EventRefundStatus,
  type EventRefundTarget,
  type EventRefundWindowStats,
  type RefundJobState,
  type RefundPauseReason,
  type RefundPgProvider,
} from './domain/event-refund.js';
export type {
  EventRefundAlert,
  EventRefundApplyInput,
  EventRefundAttemptStore,
  EventRefundCanceller,
  EventRefundCloseWindowInput,
  EventRefundFailureNotice,
  EventRefundFanNotifier,
  EventRefundOutboxMessage,
  EventRefundPauseInput,
  EventRefundPreviewInput,
  EventRefundResumeInput,
  EventRefundServiceDeps,
  EventRefundStartInput,
  EventRefundStore,
  EventRefundTargets,
} from './domain/event-refund-ports.js';
export { EventRefundError, EventRefundService, type EventRefundErrorCode } from './application/event-refund-service.js';
export { MemoryEventRefundAttemptStore, MemoryEventRefundStore } from './adapters/memory-event-refund-store.js';
export { DrizzleEventRefundStore } from './adapters/db/drizzle-event-refund-store.js';
export { DrizzleEventRefundAttempts } from './adapters/db/drizzle-event-refund-attempts.js';
export { DrizzleEventRefundTargets } from './adapters/db/drizzle-event-refund-targets.js';
export { CancelTicketEventRefund } from './application/cancel-ticket-event-refund.js';
export { HttpRefundFailureNotice } from './adapters/http-refund-failure-notice.js';
export { HttpEventRefundAlert } from './adapters/http-event-refund-alert.js';
export { OutboxEventRefundFanNotifier, TRADE_ORDERS_TOPIC, eventRefundNoticeKey } from './adapters/outbox-event-refund-fan-notifier.js';
export { EVENT_REFUND_TICK_MS, EventRefundLoop, type EventRefundLoopDeps, type EventRefundTick } from './application/event-refund-loop.js';
export { EventRefundController } from './inbound/event-refund.controller.js';
export { EventRefundGrpcController, eventRefundPackage, eventRefundServiceHandlers, type EventRefundGrpcUseCases } from './inbound/event-refund.grpc.js';
