// 월렛 목록 HTTP 처리기(openapi GET /v1/tickets, FR-012, docs/features/offline-gate.md §2 '월렛 목록 서버', FIX-wallet-tickets).
// 팬 쿠키 경로(gw-fan이 x-user-id·x-session-id·x-user-aud:fan을 넘긴다)다. 계정은 세션 신원에서만 읽고 쿼리·커서의 계정 값은 보지 않는다.
// Cache-Control: private, no-store는 TicketModule의 미들웨어가 가드보다 먼저 단다(401·400·500 응답도, ASVS v5.0.0-14.3.2).
import { Controller, Get, Optional, Param } from '@nestjs/common';
import { GetTicketResponse, ListTicketsQueryParams, ListTicketsResponse } from '@peaket/contracts/openapi/tickets';
import { ContractQuery, ContractRouteSchema, CurrentPrincipal, type Principal, ProblemError, Roles } from '@peaket/platform';
import type { z } from 'zod';
import { TicketService } from '../application/ticket-service.js';
import { Transfers, TransferError } from '../application/transfers.js';
import { DEFAULT_WALLET_LIMIT, type WalletListItem, walletListItemOf, WalletCursorError } from '../domain/ticket.js';

interface WalletListBody {
  readonly items: readonly WalletListItem[];
  readonly nextCursor: string | null;
}

@Controller('v1/tickets')
export class WalletTicketsController {
  constructor(
    private readonly tickets: TicketService,
    // 양도 모듈 없이 월렛 목록만 조립하는 시험·배포가 있다. 상세만 이 모듈을 요구한다
    @Optional() private readonly transfers?: Transfers,
  ) {}

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
      return { items: this.transfers ? await this.transfers.walletItems(r.tickets) : r.tickets.map((t) => walletListItemOf(t)), nextCursor: r.nextCursor ?? null };
    } catch (e) {
      if (e instanceof WalletCursorError) throw new ProblemError({ type: 'invalid-query', status: 400, title: '목록 조건이 올바르지 않습니다' });
      throw e;
    }
  }

  /**
   * 티켓 상세(openapi getTicket, F-05-2). 지금 보유자만. 남의 표·없는 표·UUID 아님은 같은 404다.
   * 좌석 이름·예매번호·주문 상세·판매자 정보는 범위 밖이라 싣지 않는다(계획 §1 한다 3).
   */
  @Get(':ticketId')
  @Roles(['fan'])
  @ContractRouteSchema({ responses: { 200: GetTicketResponse } })
  async detail(@Param('ticketId') ticketId: string, @CurrentPrincipal() me: Principal): Promise<z.output<typeof GetTicketResponse>> {
    try {
      if (this.transfers === undefined) throw new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
      return await this.transfers.detail({ ticketId, accountId: me.accountId });
    } catch (e) {
      if (e instanceof TransferError) throw new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
      throw e;
    }
  }
}
