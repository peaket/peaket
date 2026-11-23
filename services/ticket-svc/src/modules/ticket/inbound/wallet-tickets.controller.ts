// 월렛 목록 HTTP 처리기(openapi GET /v1/tickets, FR-012, docs/features/offline-gate.md §2 '월렛 목록 서버', FIX-wallet-tickets).
// 팬 쿠키 경로(gw-fan이 x-user-id·x-session-id·x-user-aud:fan을 넘긴다)다. 계정은 세션 신원에서만 읽고 쿼리·커서의 계정 값은 보지 않는다.
// Cache-Control: private, no-store는 TicketModule의 미들웨어가 가드보다 먼저 단다(401·400·500 응답도, ASVS v5.0.0-14.3.2).
import { Controller, Get } from '@nestjs/common';
import { ListTicketsQueryParams, ListTicketsResponse } from '@peaket/contracts/openapi/tickets';
import { ContractQuery, ContractRouteSchema, CurrentPrincipal, type Principal, ProblemError, Roles } from '@peaket/platform';
import type { z } from 'zod';
import { TicketService } from '../application/ticket-service.js';
import { DEFAULT_WALLET_LIMIT, type WalletListItem, walletListItemOf, WalletCursorError } from '../domain/ticket.js';

interface WalletListBody {
  readonly items: readonly WalletListItem[];
  readonly nextCursor: string | null;
}

@Controller('v1/tickets')
export class WalletTicketsController {
  constructor(private readonly tickets: TicketService) {}

  @Get()
  @Roles(['fan'])
  @ContractRouteSchema({ query: ListTicketsQueryParams, responses: { 200: ListTicketsResponse } })
  async list(@ContractQuery(ListTicketsQueryParams) q: z.output<typeof ListTicketsQueryParams>, @CurrentPrincipal() me: Principal): Promise<WalletListBody> {
    try {
      const r = await this.tickets.list({
        accountId: me.accountId,
        limit: q.limit ?? DEFAULT_WALLET_LIMIT,
        ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
      });
      return { items: r.tickets.map(walletListItemOf), nextCursor: r.nextCursor ?? null };
    } catch (e) {
      if (e instanceof WalletCursorError) throw new ProblemError({ type: 'invalid-query', status: 400, title: '목록 조건이 올바르지 않습니다' });
      throw e;
    }
  }
}
