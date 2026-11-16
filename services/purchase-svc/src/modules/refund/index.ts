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
  type TicketCancelAnswer,
  type TicketCancelOutcome,
} from './domain/cancellation.js';
export type {
  CancellationConfigs,
  CancellationOrders,
  CancellationWrites,
  FraudCancellationRequestRecord,
  FraudCancellationStore,
  OperatorTicketCancellations,
  OperatorTicketOutcome,
  OperatorTicketResult,
  PaymentCancellations,
  ReauthGate,
  RefundDeps,
  RefundFailureNotice,
  SeatReturnNotices,
  SeatReturns,
  TicketCancellations,
} from './domain/ports.js';
export {
  FRAUD_CANCEL_MAX_TARGETS,
  FRAUD_CANCEL_RESALE_PREP_MS,
  FRAUD_FAILURE_CODES,
  FRAUD_TICKET_OUTCOMES,
  FraudCancellationError,
  fraudCancelDeadlineMs,
  fraudCancellationId,
  fraudTargetsFingerprint,
  parseCancelFraudTickets,
  type CancelFraudTicketsInput,
  type FraudCancelTarget,
  type FraudFailureCode,
  type FraudRefundProgress,
  type FraudRefundState,
  type FraudTicketOutcome,
  type FraudTicketResult,
} from './domain/fraud-cancellation.js';
export { CancelFraudTickets, type CancelFraudTicketsDeps } from './application/cancel-fraud-tickets.js';
export { GetFraudCancellation } from './application/get-fraud-cancellation.js';
export { DrizzleFraudCancellationStore } from './adapters/db/drizzle-fraud-cancellation.js';
export { fraudCancellationHandlers, fraudCancellationPackage, type FraudCancellationPackage } from './inbound/fraud-cancellation.grpc.js';
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
// BAT-420 GAT-090 A·GAT-110 E·H(빈 뼈대)
export { ENTRY_LOOKUP_DEADLINE_MS, type CancellationClaims, type EntryFlagNotice, type EntryRecords, type EntryRecordView } from './domain/ports.js';
export { EVENT_REFUND_ESTIMATE_TPS, eventRefundPreviewOf, isEventOrderOpen } from './domain/event-refund.js';
export type { EventOpenOrders, EventRefundItemAdder, EventTicketCancellations, PendingCancellationConversions } from './domain/event-refund-ports.js';
export { EventTicketCanceller, type EventTicketCancellerDeps } from './application/event-ticket-canceller.js';
export { EventRefundCancellerRouter } from './application/event-refund-canceller-router.js';
export { HttpEntryFlagNotice } from './adapters/http-entry-flag-notice.js';
export { DrizzlePendingCancellationConversions } from './adapters/db/drizzle-pending-cancellation-conversions.js';
export { DrizzleEventOpenOrders } from './adapters/db/drizzle-event-open-orders.js';
// BAT-420 몫 D(OPEN[45] 결정, 빈 뼈대)
export { EVENT_REFUND_HOLD_MAX_MS, EventRefundHoldError, parseEventRefundHold, type EventRefundHoldInput, type EventRefundHoldState } from './domain/event-refund-hold.js';
export type { DeductionGapCancellations, DeductionGapNotice, EventRefundHolds } from './domain/event-refund-ports.js';
export { DrizzleEventRefundHolds } from './adapters/db/drizzle-event-refund-holds.js';
export { DrizzleDeductionGapCancellations } from './adapters/db/drizzle-deduction-gap-cancellations.js';
export { HttpDeductionGapNotice } from './adapters/http-deduction-gap-notice.js';
export type { EventRefundGrpcOptions } from './inbound/event-refund.grpc.js';
