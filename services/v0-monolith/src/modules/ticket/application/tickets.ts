// 발권 함수 묶음(docs/features/offline-gate.md §13 동작 1). booking 모듈이 결제 확정 안에서 부른다. 포트만 쓴다(조립은 모듈의 ticket-issuer.ts).
import type { TicketStore } from '../domain/ports.js';
import { newTicketCode, type TicketIssuer } from '../domain/ticket.js';

export function ticketIssuerWith(store: TicketStore): TicketIssuer {
  return {
    issue: (r) => store.issue(r, newTicketCode),
    ticketsOf: (orderId) => store.ticketsOf(orderId),
  };
}
