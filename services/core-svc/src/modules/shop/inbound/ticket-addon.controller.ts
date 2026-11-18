// 받는 층: 티켓 연동 부가 상품(openapi tickets 태그 createTicketAddon·listTicketAddons, BUILD_ORDER LCH-020, ADR-0301 결정 2·3, FR-014).
// 티켓의 지금 보유자 확인은 ticket-svc ListHeldTickets로 하고, 없는 티켓과 남의 티켓은 같은 404다. 확인 못 함은 503이다.
import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { CreateTicketAddonBody, CreateTicketAddonParams, CreateTicketAddonResponse, ListTicketAddonsParams, ListTicketAddonsQueryParams, ListTicketAddonsResponse } from '@peaket/contracts/openapi/tickets';
import { ContractBody, ContractParams, ContractQuery, ContractRouteSchema, CurrentPrincipal, IdempotencyRequest, Idempotent, type Principal, Roles } from '@peaket/platform';
import type { z } from 'zod';
import type { CreatedOrderView } from '../application/create-merch-order.js';
import { TicketAddons } from '../application/ticket-addons.js';
import { shopGuard } from '../application/shop-problems.js';

@Controller('v1/tickets/:ticketId/addons')
export class TicketAddonController {
  constructor(private readonly addons: TicketAddons) {}

  @Post()
  @ContractRouteSchema({ responses: { 201: CreateTicketAddonResponse } })
  @Roles(['fan'])
  @HttpCode(201)
  @Idempotent({ operation: 'CREATE_TICKET_ADDON' })
  async create(
    @ContractParams(CreateTicketAddonParams) p: z.output<typeof CreateTicketAddonParams>,
    @ContractBody(CreateTicketAddonBody) body: z.output<typeof CreateTicketAddonBody>,
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() once: IdempotencyRequest,
  ): Promise<CreatedOrderView> {
    return shopGuard(() => this.addons.create(me.accountId, p.ticketId, body, once));
  }

  @Get()
  @ContractRouteSchema({ responses: { 200: ListTicketAddonsResponse } })
  @Roles(['fan'])
  async list(@ContractParams(ListTicketAddonsParams) p: z.output<typeof ListTicketAddonsParams>, @ContractQuery(ListTicketAddonsQueryParams) q: z.output<typeof ListTicketAddonsQueryParams>, @CurrentPrincipal() me: Principal) {
    return shopGuard(() => this.addons.list(me.accountId, p.ticketId, q.limit ?? 20, q.cursor));
  }
}
