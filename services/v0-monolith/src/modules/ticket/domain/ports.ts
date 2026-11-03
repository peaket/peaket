// 발권·검표 v0 포트: 저장소(PostgreSQL).
import type { IssueRequest, IssuedTicket } from './ticket.js';

export const TICKET_STORE = Symbol.for('peaket.v0.ticket.store');

/** 저장소가 보는 검표 결과(시각은 유닉스 밀리초) */
export type ScanOutcome =
  | { kind: 'not-assigned' }
  | { kind: 'invalid' }
  | { kind: 'wrong-event' }
  | { kind: 'admitted'; ticketId: string; seatId: string; enteredAtMs: number }
  | { kind: 'already-entered'; ticketId: string; seatId: string; enteredAtMs: number }
  | { kind: 'busy' };

export interface TicketStore {
  issue(r: IssueRequest, codes: () => string): Promise<IssuedTicket[]>;
  ticketsOf(orderId: string): Promise<IssuedTicket[]>;
  /** 요청마다 그 계정이 그 회차의 검표 스태프인지 보고, 맞으면 코드를 판정한다 */
  scan(eventId: string, staffAccountId: string, code: string, nowMs: number): Promise<ScanOutcome>;
  assignStaff(eventId: string, accountIds: string[]): Promise<void>;
}
