// 발권·검표 v0(docs/features/offline-gate.md §13). 검표는 온라인 전용이다(K10의 v0).
import { randomBytes } from 'node:crypto';

/** 검표 본문의 코드(영숫자·-·_ 1~64자, §13 동작 2) */
export const TICKET_CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** 티켓 코드의 난수 바이트 수(128비트, ASVS v5.0.0-11.5.1) */
export const TICKET_CODE_BYTES = 16;

/** 티켓 코드를 만든다: CSPRNG 16바이트를 base64url로 쓴 22자(§13 동작 1) */
export function newTicketCode(): string {
  return randomBytes(TICKET_CODE_BYTES).toString('base64url');
}

/** 발권한 티켓(주문 확정 응답·주문 보기에 싣는 모양) */
export interface IssuedTicket {
  ticketId: string;
  seatId: string;
  code: string;
}

export interface IssueRequest {
  orderId: string;
  eventId: string;
  accountId: string;
  /** 주문의 좌석(1개 이상, 중복 없음) */
  seatIds: string[];
  nowMs: number;
}

/** 발권 함수 묶음(booking 모듈이 부른다) */
export interface TicketIssuer {
  /** 좌석마다 티켓 하나. 같은 주문·좌석으로 다시 부르면 있던 티켓을 준다. 결과는 seatIds 순서다 */
  issue(r: IssueRequest): Promise<IssuedTicket[]>;
  /** 그 주문의 티켓(없으면 빈 배열) */
  ticketsOf(orderId: string): Promise<IssuedTicket[]>;
}

/** 검표 판정(§13 동작 2). 시각은 KST ISO */
export type ScanVerdict =
  | { result: 'ADMIT'; ticketId: string; seatId: string; enteredAt: string }
  | { result: 'ALREADY_ENTERED'; ticketId: string; seatId: string; enteredAt: string }
  | { result: 'INVALID' }
  | { result: 'WRONG_EVENT' };
