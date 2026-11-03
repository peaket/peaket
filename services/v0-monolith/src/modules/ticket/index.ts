// 이 모듈의 공개 파일. 다른 컨텍스트는 층 폴더가 아니라 이 파일로만 가져온다(층 규칙).
export { TicketModule, type TicketModuleOptions } from './ticket.module.js';
export { createTicketAdmin, type TicketAdmin } from './ticket-admin.js';
export { createTicketIssuer } from './ticket-issuer.js';
export {
  TICKET_CODE_BYTES,
  TICKET_CODE_PATTERN,
  newTicketCode,
  type IssueRequest,
  type IssuedTicket,
  type ScanVerdict,
  type TicketIssuer,
} from './domain/ticket.js';
