// 예매 취소·환급 모듈(BUILD_ORDER GAT-070·GAT-080). 도메인·유스케이스만 내보낸다.
// HTTP·gRPC·DB 어댑터는 ticket-svc·purchase-svc 조립 단계에서 잇는다(이 묶음은 계산·Saga 계약과 시험까지다).
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
