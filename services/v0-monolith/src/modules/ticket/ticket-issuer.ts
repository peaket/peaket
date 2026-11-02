// 모듈 공개 함수: 발권(docs/features/offline-gate.md §13 동작 1). 조립 파일이라 층 규칙의 밖이다.
import type { Database } from '@peaket/platform';
import { DrizzleTicketStore } from './adapters/db/drizzle-ticket-store.js';
import { ticketIssuerWith } from './application/tickets.js';
import type { TicketIssuer } from './domain/ticket.js';

export function createTicketIssuer(database: Database): TicketIssuer {
  return ticketIssuerWith(new DrizzleTicketStore(database));
}
