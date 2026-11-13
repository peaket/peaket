// 예매 취소 모듈 조립(GAT-070·GAT-080). 운영은 purchase DB·ticket-svc·payment-svc 어댑터를, 시험은 같은 포트의 대역을 넘긴다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { INTERNAL_TOKEN, InternalTokenGuard } from '@peaket/platform';
import { CancelTicket } from './application/cancel-ticket.js';
import { EventRefundService } from './application/event-refund-service.js';
import { QuoteCancellation } from './application/quote-cancellation.js';
import { REAUTH_GATE, type CancellationOrders, type CancellationWrites, type PaymentCancellations, type ReauthGate, type SeatReturns, type TicketCancellations } from './domain/ports.js';
import type { BusinessCalendar } from './domain/refund-policy.js';
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
}

@Module({})
export class RefundModule {
  static register(deps: RefundModuleDeps): DynamicModule {
    const providers: Provider[] = [
      { provide: QuoteCancellation, useFactory: () => new QuoteCancellation({ orders: deps.orders, calendar: deps.calendar }) },
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
          }),
      },
      { provide: REAUTH_GATE, useValue: deps.reauth ?? unavailableReauth },
      { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
      InternalTokenGuard,
      ...(deps.eventRefund ? [{ provide: EventRefundService, useValue: deps.eventRefund }] : []),
    ];
    return { module: RefundModule, controllers: [TicketCancellationController, ...(deps.eventRefund ? [EventRefundController] : [])], providers };
  }
}
