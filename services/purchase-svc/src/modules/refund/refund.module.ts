// 예매 취소 모듈 조립(GAT-070·GAT-080·GAT-120·GAT-130). 운영은 purchase DB·ticket-svc·payment-svc 어댑터를, 시험은 같은 포트의 대역을 넘긴다.
// BAT-425: 지연 환급 계좌 다시 받기(RequestRefundAccount)와 배상 목록·계좌 입력(CompensationService)은 그 포트가 꽂혔을 때만 경로를 연다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { INTERNAL_TOKEN, InternalTokenGuard } from '@peaket/platform';
import { CancelTicket } from './application/cancel-ticket.js';
import { Compensations, RequestCompensationAccount } from './application/compensations.js';
import { EventRefundService } from './application/event-refund-service.js';
import { QuoteCancellation } from './application/quote-cancellation.js';
import { RequestRefundAccount } from './application/request-refund-account.js';
import { REAUTH_GATE, type CancellationOrders, type CancellationWrites, type CompensationCaseNotice, type CompensationStore, type CompensationTransfer, type EventCancellationLookup, type PaymentCancellations, type PaymentMethodLookup, type ReauthGate, type RefundAccountWrites, type SeatReturns, type TicketCancellations } from './domain/ports.js';
import type { BusinessCalendar } from './domain/refund-policy.js';
import { CancellationAccountController, CompensationController } from './inbound/compensation.controller.js';
import { EventRefundController } from './inbound/event-refund.controller.js';
import { TicketCancellationController, unavailableReauth } from './inbound/ticket-cancellation.controller.js';

export interface RefundModuleDeps {
  orders: CancellationOrders;
  writes: CancellationWrites;
  tickets: TicketCancellations;
  payments: PaymentCancellations;
  seats?: SeatReturns;
  calendar: BusinessCalendar;
  reauth?: ReauthGate;
  /** 회차 취소 일괄 환불(BAT-425). 없으면 내부 HTTP 경로를 열지 않는다 */
  eventRefund?: EventRefundService;
  /** 확정된 회차의 팬 취소·견적은 409 event-cancelled(BAT-420 리뷰 D5). 없으면 확인하지 않는다 */
  eventCancellations?: EventCancellationLookup;
  /** 견적·팬 취소의 가상계좌 판정(BUILD_ORDER GAT-090). 없으면 판정하지 않는다(시험 조립). 시작 조립은 payment-svc gRPC 어댑터를 꽂는다 */
  paymentMethods?: PaymentMethodLookup;
  /** 지연 환급 계좌 다시 받기(BAT-425, ADR-0316). 운영은 같은 DrizzleCancellationWrites다. 없으면 그 경로를 열지 않는다 */
  refundAccountWrites?: RefundAccountWrites;
  /** 배상 행 저장소(compensation 표). 없으면 배상 경로를 열지 않는다 */
  compensationStore?: CompensationStore;
  /** payment-svc 배상 송금(ADR-0317). compensationStore와 함께 있어야 배상 경로를 연다 */
  compensationTransfer?: CompensationTransfer;
  /** 송금 FAILED일 때 CS '배상 대기' 건. 없으면 건을 열지 않는다(로그 대역) */
  compensationNotice?: CompensationCaseNotice;
  /** purchase_refund_account_total{result} */
  refundAccountSignals?: { readonly inc: (result: 'accepted' | 'refunded' | 'pending' | 'rejected' | 'invalid') => void };
  /** purchase_compensation_total{result} */
  compensationSignals?: { readonly inc: (result: 'account_pending' | 'requested' | 'paid' | 'failed' | 'unavailable') => void };
}

@Module({})
export class RefundModule {
  static register(deps: RefundModuleDeps): DynamicModule {
    const providers: Provider[] = [
      {
        provide: QuoteCancellation,
        useFactory: () =>
          new QuoteCancellation({
            orders: deps.orders,
            calendar: deps.calendar,
            ...(deps.eventCancellations ? { eventCancellations: deps.eventCancellations } : {}),
            ...(deps.paymentMethods ? { paymentMethods: deps.paymentMethods } : {}),
          }),
      },
      {
        provide: CancelTicket,
        useFactory: () =>
          new CancelTicket({
            orders: deps.orders,
            calendar: deps.calendar,
            tickets: deps.tickets,
            payments: deps.payments,
            writes: deps.writes,
            ...(deps.seats ? { seats: deps.seats } : {}),
            ...(deps.eventCancellations ? { eventCancellations: deps.eventCancellations } : {}),
            ...(deps.paymentMethods ? { paymentMethods: deps.paymentMethods } : {}),
          }),
      },
      { provide: REAUTH_GATE, useValue: deps.reauth ?? unavailableReauth },
      { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
      InternalTokenGuard,
      ...(deps.eventRefund ? [{ provide: EventRefundService, useValue: deps.eventRefund }] : []),
      ...(deps.refundAccountWrites
        ? [
            {
              provide: RequestRefundAccount,
              useFactory: () =>
                new RequestRefundAccount({
                  orders: deps.orders,
                  writes: deps.refundAccountWrites!,
                  payments: deps.payments,
                  ...(deps.reauth ? { reauth: deps.reauth } : {}),
                  ...(deps.refundAccountSignals ? { signals: deps.refundAccountSignals } : {}),
                }),
            },
          ]
        : []),
      ...(deps.compensationStore && deps.compensationTransfer
        ? [
            { provide: Compensations, useFactory: () => new Compensations(deps.compensationStore!) },
            {
              provide: RequestCompensationAccount,
              useFactory: () =>
                new RequestCompensationAccount({
                  store: deps.compensationStore!,
                  transfer: deps.compensationTransfer!,
                  ...(deps.compensationNotice ? { notice: deps.compensationNotice } : {}),
                  ...(deps.reauth ? { reauth: deps.reauth } : {}),
                  ...(deps.compensationSignals ? { signals: deps.compensationSignals } : {}),
                }),
            },
          ]
        : []),
    ];
    const controllers = [
      TicketCancellationController,
      ...(deps.eventRefund ? [EventRefundController] : []),
      ...(deps.refundAccountWrites ? [CancellationAccountController] : []),
      ...(deps.compensationStore && deps.compensationTransfer ? [CompensationController] : []),
    ];
    return { module: RefundModule, controllers, providers };
  }
}
