// 받는 층: 검표 v0 HTTP(docs/features/offline-gate.md §13 동작 2). 스태프는 게이트웨이가 넘긴 팬 대상 계정으로만 고른다.
import { Controller, Header, HttpCode, Post } from '@nestjs/common';
import { ContractBody, ContractParams, CurrentPrincipal, type Principal, Roles } from '@peaket/platform';
import { z } from 'zod';
import { EVENT_ID_PATTERN } from '../../inventory/index.js';
import { TicketService } from '../application/ticket-service.js';
import { TICKET_CODE_PATTERN } from '../domain/ticket.js';

const EventParams = z.object({ eventId: z.string().regex(EVENT_ID_PATTERN) }).strict();
type EventParams = z.output<typeof EventParams>;
const ScanBody = z.object({ code: z.string().regex(TICKET_CODE_PATTERN) }).strict();
type ScanBody = z.output<typeof ScanBody>;

/** 검표는 v0에만 있어 /v0/ 아래에 둔다(/v1/은 openapi 계약의 경로만) */
@Controller('v0/events/:eventId/scans')
export class ScanController {
  constructor(private readonly tickets: TicketService) {}

  @Post()
  @HttpCode(200)
  // 인증이 필요한 경로는 Cache-Control: no-store다(docs/api/guidelines.md §9)
  @Header('Cache-Control', 'no-store')
  // 스캐너 대상 역할은 기기 증명(GAT-170) 전에는 플랫폼이 막는다. v0는 팬 대상 신원으로 받고 요청마다 배정 표로 판정한다(offline-gate §13 동작 2)
  @Roles(['fan'])
  async scan(@ContractParams(EventParams) p: EventParams, @ContractBody(ScanBody) body: ScanBody, @CurrentPrincipal() me: Principal) {
    return this.tickets.scan(p.eventId, me.accountId, body.code);
  }
}
