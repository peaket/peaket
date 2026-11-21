// 받는 층: 배상 목록·상세·계좌 입력과 지연 환급 계좌 다시 받기(BAT-425 GAT-130, openapi listCompensations·getCompensation·
// createCompensationAccount·createCancellationAccount, ADR-0316·0317).
// 팬 쿠키의 신원으로만 본다. 계좌 모양은 재인증 확인 전에 공용 함수(@peaket/validation/refund-account)로 보고 틀리면 400 invalid-body다.
// 계좌 입력은 재인증을 사용 사례가 본다(op REFUND_ACCOUNT·COMPENSATION_ACCOUNT, act FAN_HIGH_RISK, jti 한 번 쓰기).
// 응답은 Cache-Control: private, no-store이고(AppModule의 no-store 미들웨어), 계좌번호 원문은 어디에도 싣지 않는다(끝 4자리만, POL-014).
import { Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { Bulkhead, CLOCK, type Clock, ContractBody, ContractParams, ContractQuery, ContractRouteSchema, CurrentPrincipal, IdempotencyRequest, type IdempotencyRequest as Idem, Idempotent, type Principal, ProblemError, Roles } from '@peaket/platform';
import type { FastifyRequest } from 'fastify';
import { refundAccountShape } from '@peaket/validation/refund-account';
import { z } from 'zod';
import { WRITE_BULKHEAD } from '../../../write-bulkhead.js';
import { Compensations, RequestCompensationAccount } from '../application/compensations.js';
import { InvalidRefundAccount, RequestRefundAccount } from '../application/request-refund-account.js';
import {
  CompensationNotAccountPending,
  CompensationNotFound,
  CompensationTransferRejected,
  CompensationTransferUnavailable,
} from '../domain/compensation.js';
import {
  RefundAccountAttemptsExceeded,
  RefundAccountNotPending,
  RefundAccountNotFound,
  RefundAccountRejected,
  RefundAccountRequiredAgain,
  ReauthRequired,
} from '../domain/cancellation.js';
import { ReauthUnavailable } from '../domain/ports.js';

const CompensationParams = z.object({ compensationId: z.uuid() }).strict();
const CancellationParams = z.object({ cancellationId: z.uuid() }).strict();
// 칸 모양(글자 수·숫자)은 사용 사례의 공용 규칙(refundAccountShape)이 400 invalid-body로 본다. 여기서는 칸 이름과 글 길이 상한만 본다(재인증 앞)
const RefundAccountBody = z.object({ bankCode: z.string().max(20), accountNumber: z.string().max(64), holderName: z.string().max(200) }).strict();
const AccountHeaders = z.object({ 'Idempotency-Key': z.uuid(), 'X-Reauth-Token': z.string().optional() });
const PageQuery = z.object({ cursor: z.string().min(1).max(200).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict();
const CompensationView = z.object({
  compensationId: z.string(),
  orderId: z.string(),
  amount: z.number().int(),
  status: z.enum(['ACCOUNT_PENDING', 'REQUESTED', 'PAID', 'FAILED']),
  accountLast4: z.string().optional(),
  eventId: z.string().optional(),
  reason: z.enum(['ORGANIZER', 'CONTENT_CHANGE']).optional(),
  createdAt: z.string(),
});
const CompensationPage = z.object({ items: z.array(CompensationView), nextCursor: z.string().nullable() });
const CancellationView = z.object({
  cancellationId: z.string(),
  status: z.enum(['REQUESTED', 'REFUND_PENDING', 'REFUNDED', 'VOIDED']),
  refundAmount: z.number().int(),
  refundAccountRequired: z.boolean().optional(),
});

const notFound = () => new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
const invalidBody = () => new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다' });
const reauthRequired = () => new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
/** 재인증 확인기·jti 저장소 장애. Retry-After 5초 [가정](openapi 두 계좌 입력 503) */
const reauthUnavailable = (cause: unknown) => new ProblemError({ type: 'reauth-unavailable', status: 503, title: '재인증 검증기를 쓸 수 없습니다', retryAfterSeconds: 5, cause });
const cancellationNotPending = () => new ProblemError({ type: 'cancellation-not-account-pending', status: 409, title: '환급 계좌를 기다리는 취소가 아닙니다' });
const compensationNotPending = () => new ProblemError({ type: 'compensation-not-account-pending', status: 409, title: '배상 계좌를 기다리는 건이 아닙니다' });
const refundAccountRequired = () => new ProblemError({ type: 'refund-account-required', status: 422, title: '환불받을 계좌를 입력해 주세요' });
const refundRejected = () => new ProblemError({ type: 'refund-rejected', status: 422, title: '결제사가 환급을 거절했습니다. 고객센터가 이어 봅니다' });
/** 지급대행·계정이 없어 지금은 보낼 수 없다. Retry-After 5초 [가정](openapi createCompensationAccount 503) */
const compensationUnavailable = (cause: unknown) => new ProblemError({ type: 'compensation-transfer-unavailable', status: 503, title: '지금은 배상금을 보낼 수 없습니다', retryAfterSeconds: 5, cause });
const compensationFailed = (cause: unknown) => new ProblemError({ type: 'compensation-transfer-failed', status: 422, title: '배상금 송금이 실패했습니다. 고객센터가 이어 봅니다', cause });

const tokenOf = (request: FastifyRequest): string | undefined => (typeof request.headers['x-reauth-token'] === 'string' ? request.headers['x-reauth-token'] : undefined);

@Controller('v1/compensations')
export class CompensationController {
  constructor(
    private readonly compensations: Compensations,
    private readonly requestAccount: RequestCompensationAccount,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  @Roles(['fan'])
  @ContractRouteSchema({ query: PageQuery, responses: { 200: CompensationPage } })
  async list(@ContractQuery(PageQuery) query: z.output<typeof PageQuery>, @CurrentPrincipal() me: Principal): Promise<z.output<typeof CompensationPage>> {
    const page = await this.compensations.list(me.accountId, { ...(query.cursor !== undefined ? { cursor: query.cursor } : {}), ...(query.limit !== undefined ? { limit: query.limit } : {}) });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Get(':compensationId')
  @Roles(['fan'])
  @ContractRouteSchema({ params: CompensationParams, responses: { 200: CompensationView } })
  async get(@ContractParams(CompensationParams) params: z.output<typeof CompensationParams>, @CurrentPrincipal() me: Principal): Promise<z.output<typeof CompensationView>> {
    const view = await this.compensations.get(me.accountId, params.compensationId);
    if (!view) throw notFound();
    return { ...view };
  }

  @Post(':compensationId/account')
  @HttpCode(202)
  @Bulkhead(WRITE_BULKHEAD)
  @Roles(['fan'])
  @Idempotent({ operation: 'COMPENSATION_ACCOUNT' })
  @ContractRouteSchema({ params: CompensationParams, headers: AccountHeaders, body: RefundAccountBody, responses: { 202: CompensationView } })
  async account(
    @ContractParams(CompensationParams) params: z.output<typeof CompensationParams>,
    @ContractBody(RefundAccountBody) body: z.output<typeof RefundAccountBody>,
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() idem: Idem,
    @Req() request: FastifyRequest,
  ): Promise<z.output<typeof CompensationView>> {
    const account = { bankCode: body.bankCode, accountNumber: body.accountNumber, holderName: body.holderName };
    try {
      return { ...(await this.requestAccount.run({ accountId: me.accountId, compensationId: params.compensationId, account, reauthToken: tokenOf(request), idempotencyKey: idem.key, sessionId: me.sessionId, nowMs: this.clock.now() })) };
    } catch (e) {
      if (e instanceof InvalidRefundAccount) throw invalidBody();
      if (e instanceof CompensationNotFound) throw notFound();
      if (e instanceof CompensationNotAccountPending) throw compensationNotPending();
      if (e instanceof ReauthRequired) throw reauthRequired();
      if (e instanceof ReauthUnavailable) throw reauthUnavailable(e);
      if (e instanceof CompensationTransferUnavailable) throw compensationUnavailable(e);
      if (e instanceof CompensationTransferRejected) throw compensationFailed(e);
      throw e;
    }
  }
}

@Controller('v1/cancellations')
export class CancellationAccountController {
  constructor(
    private readonly refundAccount: RequestRefundAccount,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post(':cancellationId/account')
  @HttpCode(202)
  @Bulkhead(WRITE_BULKHEAD)
  @Roles(['fan'])
  @Idempotent({ operation: 'REFUND_ACCOUNT' })
  @ContractRouteSchema({ params: CancellationParams, headers: AccountHeaders, body: RefundAccountBody, responses: { 202: CancellationView } })
  async account(
    @ContractParams(CancellationParams) params: z.output<typeof CancellationParams>,
    @ContractBody(RefundAccountBody) body: z.output<typeof RefundAccountBody>,
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() idem: Idem,
    @Req() request: FastifyRequest,
  ): Promise<z.output<typeof CancellationView>> {
    const account = { bankCode: body.bankCode, accountNumber: body.accountNumber, holderName: body.holderName };
    // 재인증·계좌 모양(공용 함수)은 사용 사례가 400·403을 던지기 전에 본다(사용 사례가 모양을 먼저 본다)
    if (!refundAccountShape(account).ok) throw invalidBody();
    try {
      const r = await this.refundAccount.run({
        accountId: me.accountId,
        cancellationId: params.cancellationId,
        account,
        reauthToken: tokenOf(request),
        idempotencyKey: idem.key,
        requestHash: idem.requestHash,
        sessionId: me.sessionId,
        nowMs: this.clock.now(),
      });
      return { cancellationId: r.cancellationId, status: r.status, refundAmount: r.refundAmount };
    } catch (e) {
      if (e instanceof InvalidRefundAccount) throw invalidBody();
      if (e instanceof RefundAccountNotFound) throw notFound();
      if (e instanceof RefundAccountNotPending || e instanceof RefundAccountAttemptsExceeded) throw cancellationNotPending();
      if (e instanceof ReauthRequired) throw reauthRequired();
      if (e instanceof ReauthUnavailable) throw reauthUnavailable(e);
      if (e instanceof RefundAccountRequiredAgain) throw refundAccountRequired();
      if (e instanceof RefundAccountRejected) throw refundRejected();
      throw e;
    }
  }
}
