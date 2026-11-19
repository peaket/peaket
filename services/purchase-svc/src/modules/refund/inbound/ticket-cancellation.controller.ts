// 받는 층: 예매 취소 견적·취소(openapi getTicketCancellationQuote·createTicketCancellation, GAT-070·GAT-080).
// 팬 쿠키와 구매 요청 서명을 쓰고, 취소는 Idempotency-Key를 cancellationId로 쓴다.
// 취소는 구매 요청 서명·본문 검사 뒤에 X-Reauth-Token을 ReauthGate로 본다(docs/features/transfer-refund.md §3.1 '팬 취소의 재인증 확인').
// 작업 묶음·받는 쪽 작업은 본문에 환급 계좌가 있으면 FAN_HIGH_RISK·TICKET_CANCEL_REFUND_ACCOUNT, 없으면 FAN_SENSITIVE·TICKET_CANCEL이다(ADR-0293). 거절은 403 reauth-required, 확인 못 함은 503 reauth-unavailable이다.
// 확인기를 꽂지 않은 조립은 닫힌 대역(unavailableReauth, 늘 403)이다. 견적은 재인증이 필요 없어 연다.
// 환불 계좌 규칙(BUILD_ORDER GAT-090, docs/features/payment.md §6): 견적은 refundAccountRequired를 싣고 결제 수단을 읽지 못하면 503 dependency-unavailable이다.
// 취소는 재인증 뒤 Saga 앞에서 다시 읽어, 계좌가 필요한데 없으면 422 refund-account-required, 읽지 못하면 503 dependency-unavailable이다(둘 다 아무것도 쓰지 않는다).
// 계좌 대기(202 REFUND_PENDING)는 refundAccountRequired 참을 싣는다.
import { Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { Bulkhead, CLOCK, type Clock, ContractBody, dependencyUnavailable, ContractParams, ContractRouteSchema, CurrentPrincipal, IdempotencyRequest, type IdempotencyRequest as Idem, Idempotent, type Principal, ProblemError, PurchaseSigned, Roles } from '@peaket/platform';
import type { FastifyRequest } from 'fastify';
import { refundAccountShape } from '@peaket/validation/refund-account';
import { z } from 'zod';
import { CancelTicket } from '../application/cancel-ticket.js';
import type { CancelTicketResult } from '../domain/cancellation.js';
import { QuoteCancellation, type QuoteCancellationResult } from '../application/quote-cancellation.js';
import { WRITE_BULKHEAD } from '../../../write-bulkhead.js';
import { type FanReauthAct, type FanReauthOp, REAUTH_GATE, type ReauthGate, ReauthUnavailable } from '../domain/ports.js';

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
    refundAccountRequired: z.boolean(),
  })
  .strict();
// 칸 모양(글자 수·숫자)은 여기서 보지 않고 처리기의 공용 규칙(refundAccountShape)이 400 invalid-body로 본다(재인증 앞, RV-04). 여기서는 칸 이름과 글 길이 상한만 본다
const RefundAccountBody = z.object({ bankCode: z.string().max(20), accountNumber: z.string().max(64), holderName: z.string().max(200) }).strict();
const CancelBody = z.object({ refundAccount: RefundAccountBody.optional() }).strict();
const CancelHeaders = z.object({
  'Idempotency-Key': z.uuid(),
  'X-Purchase-Seq': z.int().min(1),
  'X-Purchase-Mac': z.string(),
  'X-Reauth-Token': z.string().optional(),
});
const CancelResponse = z
  .object({ cancellationId: z.string(), status: z.enum(['REQUESTED', 'REFUND_PENDING', 'REFUNDED']), refundAmount: z.int().min(0), refundAccountRequired: z.boolean().optional() })
  .strict();

const notFound = () => new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
const notPayer = () => new ProblemError({ type: 'not-payer', status: 403, title: '결제한 분만 할 수 있습니다' });
const conflict = () => new ProblemError({ type: 'cancellation-conflict', status: 409, title: '지금은 취소할 수 없습니다' });
const entryStarted = () => new ProblemError({ type: 'entry-started', status: 409, title: '입장이 시작되어 할 수 없습니다' });
/** 양도 요청 중이거나 남이 가진 티켓(R-T3, docs/features/transfer-refund.md §9 1번, 돌려받은 뒤 취소한다) */
const transferPending = () => new ProblemError({ type: 'transfer-pending', status: 409, title: '양도 요청을 철회한 뒤 취소할 수 있습니다' });
const reauthRequired = () => new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
/** 재인증 토큰을 확인하지 못함(팬 공개키 묶음을 한 번도 받지 못함, jti 저장소 오류). Retry-After 5초 [가정](openapi createTicketCancellation 503) */
const reauthUnavailable = (cause: unknown) => new ProblemError({ type: 'reauth-unavailable', status: 503, title: '재인증 검증기를 쓸 수 없습니다', retryAfterSeconds: 5, cause });
/** 회차 취소 일괄 환불이 확정된 회차(공제 없이 일괄 환불이 돌려준다, BAT-420 리뷰 D5, openapi 팬 취소·견적 409) */
const eventCancelled = () => new ProblemError({ type: 'event-cancelled', status: 409, title: '취소가 확정된 회차입니다' });
/** 가상계좌 결제이고 지금 환급할 취소인데 본문에 환불 계좌가 없다(openapi createTicketCancellation 422, BUILD_ORDER GAT-090) */
/** 환불 계좌 모양이 틀렸다(400 invalid-body, 공용 규칙 @peaket/validation/refund-account, docs/features/payment.md §6 '구현에서 정한 것' ⑦, BAT-420-rest 리뷰 반영 RV-04) */
const invalidBody = () => new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다' });
const refundAccountRequired = () => new ProblemError({ type: 'refund-account-required', status: 422, title: '환불받을 계좌를 입력해 주세요' });
/** 결제 수단(가상계좌였는지)을 payment-svc에서 읽지 못함. Retry-After 1초 [가정](openapi 견적·취소 503, BUILD_ORDER GAT-090) */
const paymentMethodUnavailable = () => dependencyUnavailable(1);

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
    if (r.status === 'EVENT_CANCELLED') throw eventCancelled();
    if (r.status === 'DEPENDENCY_UNAVAILABLE') throw paymentMethodUnavailable();
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
    // 계좌 모양은 재인증 앞에서 본다(틀리면 토큰을 쓰지 않고 400 invalid-body, 결제 수단 읽기·Saga 0). 맞으면 본문 그대로 넘긴다(payment-svc가 같은 규칙으로 다시 본다)
    const refundAccount = body.refundAccount;
    if (refundAccount !== undefined && !refundAccountShape(refundAccount).ok) throw invalidBody();
    const token = typeof request.headers['x-reauth-token'] === 'string' ? request.headers['x-reauth-token'] : undefined;
    // 환급 계좌를 담은 취소는 '환급 계좌 입력'이라 FAN_HIGH_RISK만 받는다(docs/security/authz-matrix.md §6). 반대 묶음도 거절한다
    // 받는 쪽 작업 op도 본문으로 정한다(토큰에서 읽지 않는다, authz-matrix §6 '받는 쪽 작업 op의 값', ADR-0293 결정 5)
    const withAccount = body.refundAccount !== undefined;
    const act: FanReauthAct = withAccount ? 'FAN_HIGH_RISK' : 'FAN_SENSITIVE';
    const op: FanReauthOp = withAccount ? 'TICKET_CANCEL_REFUND_ACCOUNT' : 'TICKET_CANCEL';
    let passed: boolean;
    try {
      passed = await this.reauth.verify(token, { accountId: me.accountId, sessionId: me.sessionId, act, op });
    } catch (e) {
      if (e instanceof ReauthUnavailable) throw reauthUnavailable(e);
      throw e;
    }
    if (!passed) throw reauthRequired();
    const r: CancelTicketResult = await this.cancel.execute({
      accountId: me.accountId,
      ticketId: params.ticketId,
      cancellationId: idem.key,
      reason: 'USER',
      nowMs: this.clock.now(),
      deadlineMs: 5_000,
      ...(refundAccount !== undefined ? { refundAccount } : {}),
    });
    if (r.status === 'ACCEPTED' || r.status === 'REPLAYED') {
      return { cancellationId: r.cancellationId, status: r.refundAfterEntryClose ? 'REQUESTED' : 'REFUNDED', refundAmount: r.refundAmount };
    }
    if (r.status === 'REFUND_PENDING') {
      return { cancellationId: r.cancellationId, status: 'REFUND_PENDING', refundAmount: r.refundAmount, ...(r.refundAccountRequired ? { refundAccountRequired: true } : {}) };
    }
    if (r.status === 'REFUND_ACCOUNT_REQUIRED') throw refundAccountRequired();
    if (r.status === 'DEPENDENCY_UNAVAILABLE') throw paymentMethodUnavailable();
    if (r.status === 'NOT_FOUND') throw notFound();
    if (r.status === 'NOT_PAYER') throw notPayer();
    if (r.status === 'EVENT_STARTED') throw entryStarted();
    if (r.status === 'TRANSFER_PENDING' || r.status === 'TICKET_NOT_HELD') throw transferPending();
    if (r.status === 'EVENT_CANCELLED') throw eventCancelled();
    throw conflict();
  }
}

/** 확인기를 꽂지 않은 조립의 닫힌 기본값(늘 403). 견적은 이 대역을 쓰지 않는다 */
export const unavailableReauth: ReauthGate = { verify: async () => false };
