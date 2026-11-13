// 예매 취소 모듈 조립(GAT-070·GAT-080). 운영은 purchase DB·ticket-svc·payment-svc 어댑터를, 시험은 같은 포트의 대역을 넘긴다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { CancelTicket } from './application/cancel-ticket.js';
import { QuoteCancellation } from './application/quote-cancellation.js';
import { REAUTH_GATE, type CancellationOrders, type CancellationWrites, type PaymentCancellations, type ReauthGate, type SeatReturns, type TicketCancellations } from './domain/ports.js';
import type { BusinessCalendar } from './domain/refund-policy.js';
import { TicketCancellationController, unavailableReauth } from './inbound/ticket-cancellation.controller.js';

export interface RefundModuleDeps {
  orders: CancellationOrders;
  writes: CancellationWrites;
  tickets: TicketCancellations;
  payments: PaymentCancellations;
  seats?: SeatReturns;
  calendar: BusinessCalendar;
  reauth?: ReauthGate;
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
    ];
    return { module: RefundModule, controllers: [TicketCancellationController], providers };
  }
}
