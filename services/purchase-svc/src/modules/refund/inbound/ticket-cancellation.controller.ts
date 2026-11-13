// 받는 층: 예매 취소 견적·취소(openapi getTicketCancellationQuote·createTicketCancellation, GAT-070·GAT-080).
// 팬 쿠키와 구매 요청 서명을 쓰고, 취소는 Idempotency-Key를 cancellationId로 쓴다.
// X-Reauth-Token 확인 계약이 아직 없어 ReauthGate 기본값은 늘 false다. 그동안 취소는 403 reauth-required로 닫고,
// 견적은 재인증이 필요 없어 연다(known gap: identity 재인증 토큰 확인 어댑터).
import { Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { Bulkhead, CLOCK, type Clock, ContractBody, ContractParams, ContractRouteSchema, CurrentPrincipal, IdempotencyRequest, type IdempotencyRequest as Idem, Idempotent, type Principal, ProblemError, PurchaseSigned, Roles } from '@peaket/platform';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CancelTicket } from '../application/cancel-ticket.js';
import type { CancelTicketResult } from '../domain/cancellation.js';
import { QuoteCancellation, type QuoteCancellationResult } from '../application/quote-cancellation.js';
import { WRITE_BULKHEAD } from '../../../write-bulkhead.js';
import { REAUTH_GATE, type ReauthGate } from '../domain/ports.js';

const TicketParams = z.object({ ticketId: z.uuid() }).strict();
const QuoteResponse = z
  .object({
    ticketId: z.string(),
    daysBefore: z.int().min(0),
    within24h: z.boolean(),
    deductionRate: z.number(),
    basis: z.string(),
    ticketPrice: z.int().min(0),
    deductionAmount: z.int().min(0),
    refundAmount: z.int().min(0),
    refundAfterEntryClose: z.boolean(),
  })
  .strict();
const RefundAccountBody = z.object({ bankCode: z.string().min(1).max(20), accountNumber: z.string().min(1).max(40), holderName: z.string().min(1).max(100) }).strict();
const CancelBody = z.object({ refundAccount: RefundAccountBody.optional() }).strict();
const CancelHeaders = z.object({
  'Idempotency-Key': z.uuid(),
  'X-Purchase-Seq': z.int().min(1),
  'X-Purchase-Mac': z.string(),
  'X-Reauth-Token': z.string().optional(),
});
const CancelResponse = z.object({ cancellationId: z.string(), status: z.enum(['REQUESTED', 'REFUND_PENDING', 'REFUNDED']), refundAmount: z.int().min(0) }).strict();

const notFound = () => new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
const notPayer = () => new ProblemError({ type: 'not-payer', status: 403, title: '결제한 분만 할 수 있습니다' });
const conflict = () => new ProblemError({ type: 'cancellation-conflict', status: 409, title: '지금은 취소할 수 없습니다' });
const entryStarted = () => new ProblemError({ type: 'entry-started', status: 409, title: '입장이 시작되어 할 수 없습니다' });
const reauthRequired = () => new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });

@Controller('v1/tickets')
export class TicketCancellationController {
  constructor(
    private readonly quote: QuoteCancellation,
    private readonly cancel: CancelTicket,
    @Inject(REAUTH_GATE) private readonly reauth: ReauthGate,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get(':ticketId/cancellation-quote')
  @Roles(['fan'])
  @ContractRouteSchema({ params: TicketParams, responses: { 200: QuoteResponse } })
  async quoteOf(@ContractParams(TicketParams) params: z.output<typeof TicketParams>, @CurrentPrincipal() me: Principal): Promise<z.output<typeof QuoteResponse>> {
    const r: QuoteCancellationResult = await this.quote.execute({ accountId: me.accountId, ticketId: params.ticketId, nowMs: this.clock.now() });
    if (r.status === 'OK') return r.quote;
    if (r.status === 'NOT_FOUND') throw notFound();
    if (r.status === 'NOT_PAYER') throw notPayer();
    if (r.status === 'EVENT_STARTED') throw entryStarted();
    throw conflict();
  }

  @Post(':ticketId/cancellation')
  @HttpCode(202)
  @Bulkhead(WRITE_BULKHEAD)
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  @Idempotent({ operation: 'CANCEL_TICKET' })
  @PurchaseSigned()
  @ContractRouteSchema({ params: TicketParams, headers: CancelHeaders, body: CancelBody, responses: { 202: CancelResponse } })
  async cancelOf(
    @ContractParams(TicketParams) params: z.output<typeof TicketParams>,
    @ContractBody(CancelBody) body: z.output<typeof CancelBody>,
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() idem: Idem,
    @Req() request: FastifyRequest,
  ): Promise<z.output<typeof CancelResponse>> {
    const token = typeof request.headers['x-reauth-token'] === 'string' ? request.headers['x-reauth-token'] : undefined;
    if (!(await this.reauth.verify(token, { accountId: me.accountId, sessionId: me.sessionId }))) throw reauthRequired();
    const r: CancelTicketResult = await this.cancel.execute({
      accountId: me.accountId,
      ticketId: params.ticketId,
      cancellationId: idem.key,
      reason: 'USER',
      nowMs: this.clock.now(),
      deadlineMs: 5_000,
      ...(body.refundAccount !== undefined ? { refundAccount: body.refundAccount } : {}),
    });
    if (r.status === 'ACCEPTED' || r.status === 'REPLAYED') {
      return { cancellationId: r.cancellationId, status: r.refundAfterEntryClose ? 'REQUESTED' : 'REFUNDED', refundAmount: r.refundAmount };
    }
    if (r.status === 'REFUND_PENDING') return { cancellationId: r.cancellationId, status: 'REFUND_PENDING', refundAmount: r.refundAmount };
    if (r.status === 'NOT_FOUND') throw notFound();
    if (r.status === 'NOT_PAYER') throw notPayer();
    if (r.status === 'EVENT_STARTED') throw entryStarted();
    throw conflict();
  }
}

/** 재인증 계약이 생기기 전의 닫힌 대역. 견적은 이 대역을 쓰지 않는다 */
export const unavailableReauth: ReauthGate = { verify: async () => false };
