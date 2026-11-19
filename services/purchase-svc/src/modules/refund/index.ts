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
  REFUND_ACCOUNT_MAX_ATTEMPTS,
  REFUND_RETRY_MAX_ATTEMPTS,
  RefundAccountAttemptsExceeded,
  RefundAccountNotPending,
  RefundAccountNotFound,
  RefundAccountRejected,
  RefundAccountRequiredAgain,
  ReauthRequired,
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
  type RequestRefundAccountResult,
  type TicketCancelAnswer,
  type TicketCancelOutcome,
} from './domain/cancellation.js';
export type {
  CancellationConfigs,
  CancellationOrders,
  CompensationCaseNotice,
  CompensationStore,
  CompensationTransfer,
  CompensationTransferResult,
  EventCancellationLookup,
  CancellationWrites,
  FraudCancellationRequestRecord,
  FraudCancellationStore,
  OperatorTicketCancellations,
  OperatorTicketOutcome,
  OperatorTicketResult,
  FanReauthAct,
  FanReauthOp,
  PaymentCancellations,
  PgCircuits,
  ReauthGate,
  RefundAccountWrites,
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
export { GrpcCompensationTransfer, type GrpcCompensationTransferOptions } from './adapters/grpc-compensation-transfer.js';
export { HttpPgCircuits, PG_CIRCUIT_CACHE_MS, type HttpPgCircuitsOptions } from './adapters/http-pg-circuits.js';
export { HttpCompensationCaseNotice, compensationCaseEventKey } from './adapters/http-compensation-case-notice.js';
export { DrizzleCompensations } from './adapters/db/drizzle-compensations.js';
export {
  accountLast4Of,
  COMPENSATION_REASONS,
  COMPENSATION_STATUSES,
  CompensationNotAccountPending,
  CompensationNotFound,
  CompensationTransferRejected,
  CompensationTransferUnavailable,
  compensationRowsOf,
  type CompensationPage,
  type CompensationReason,
  type CompensationRecord,
  type CompensationRow,
  type CompensationStatus,
  type CompensationView,
} from './domain/compensation.js';
export { Compensations, RequestCompensationAccount, type RequestCompensationAccountDeps, type RequestCompensationAccountInput } from './application/compensations.js';
export { InvalidRefundAccount, REFUND_ACCOUNT_RETRY_DELAY_MS, RequestRefundAccount, type RequestRefundAccountInput } from './application/request-refund-account.js';
export { CancellationAccountController, CompensationController } from './inbound/compensation.controller.js';
export { RedisSeatReturnNotices } from './adapters/redis-seat-returns.js';
export { CancelTicket, zeroDeductionFor, type CancelTicketInput } from './application/cancel-ticket.js';
// 탈퇴 참여자의 결제한 미사용 티켓(BAT-013, I-T26, payment §4.1 '미사용 티켓 견적'·'미사용 티켓 취소')
export { TRANSFER_CLOSE_BEFORE_START_MS, withdrawalTicketCancellationId, type WithdrawalTicket, type WithdrawalTicketStore } from './domain/account-withdrawal-tickets.js';
export { AccountWithdrawalTickets, type AccountWithdrawalTicketsDeps } from './application/account-withdrawal-tickets.js';
export { DrizzleWithdrawalTickets } from './adapters/db/drizzle-account-withdrawal-tickets.js';
export { RefundModule, type RefundModuleDeps } from './refund.module.js';
export { TicketCancellationController, unavailableReauth } from './inbound/ticket-cancellation.controller.js';
// BAT-415-reauth(팬 취소의 재인증 확인, docs/features/transfer-refund.md §3.1)
export { ReauthUnavailable } from './domain/ports.js';
export { JwksFanReauthGate, type FanReauthResult, type ReauthRejectReason } from './adapters/jwks-fan-reauth-gate.js';
export { eventStartsAtOf, QuoteCancellation, type CancellationQuoteView, type QuoteCancellationInput, type QuoteCancellationResult } from './application/quote-cancellation.js';
export { RefundAfterEntry, type RefundAfterEntryDeps, refundAfterEntryTask } from './application/refund-after-entry.js';
export { REFUND_RETRY_TICK_MS, RefundRetryLoop, type RefundRetryLoopDeps, type RefundRetryTick } from './application/refund-retry-loop.js';
export {
  compensationAmount,
  compensationOrdersOf,
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
  type CompensationOrder,
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
export { HttpRefundAccountNotice } from './adapters/http-refund-account-notice.js';
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
export { DrizzleEventCancellationLookup } from './adapters/db/drizzle-event-cancellation-lookup.js';
export { DrizzleEventRefundClaims } from './adapters/db/drizzle-event-refund-claims.js';
export { EVENT_REFUND_CLAIM_MS, type CsCaseOutbox, type EventRefundClaims } from './domain/event-refund-ports.js';
// W9-fix1 N3·N8(빈 뼈대)
export { EVENT_REFUND_CLAIM_EXTEND_BELOW_MS, EVENT_REFUND_TICKET_DEADLINE_MS } from './domain/event-refund-ports.js';
export { mergePauses } from './domain/event-refund.js';
export { DrizzleCsCaseOutbox } from './adapters/db/drizzle-cs-case-outbox.js';
export { PromCsCaseSignals } from './adapters/prom-cs-case-signals.js';
export { PromRefundAccountSignals } from './adapters/prom-refund-signals.js';
export { CS_CASE_REOPEN_BUDGET_MS, CS_CASE_REOPEN_MAX_UNREACHABLE, CsCaseReopenBudget } from './application/cs-case-reopen.js';
export { CsCaseRejected } from './adapters/cs-case-response.js';
export { HttpDeductionGapNotice } from './adapters/http-deduction-gap-notice.js';
export type { EventRefundGrpcOptions } from './inbound/event-refund.grpc.js';
