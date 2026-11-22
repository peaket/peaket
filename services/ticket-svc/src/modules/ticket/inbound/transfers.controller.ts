// 양도·돌려주기·받는 사람 찾기 HTTP 처리기(BUILD_ORDER GAT-050·GAT-055, openapi `/v1/tickets/{ticketId}/transfers`·`/v1/transfers/*`·`/v1/tickets/{ticketId}/returns`).
// 팬 쿠키 경로(gw-fan이 x-user-id·x-session-id·x-user-aud:fan을 넘긴다)다. 재인증 토큰은 X-Reauth-Token 머리로만 받는다.
import { Controller, Get, Headers, HttpCode, Post } from '@nestjs/common';
import {
  CreateTicketReturnParams,
  CreateTicketTransferBody,
  CreateTicketTransferParams,
  CreateTicketTransferResponse,
  CreateTransferAcceptanceParams,
  CreateTransferRecipientLookupBody,
  CreateTransferRecipientLookupResponse,
  CreateTransferRejectionParams,
  CreateTransferWithdrawalParams,
  GetTransferParams,
  GetTransferResponse,
} from '@peaket/contracts/openapi/tickets';
import { ContractBody, ContractParams, ContractRouteSchema, CurrentPrincipal, IdempotencyRequest, type IdempotencyRequest as Idem, Idempotent, type Principal, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import { type TransferErrorCode, TransferError, Transfers } from '../application/transfers.js';

/** 재인증 토큰은 없어도 처리기까지 간다(없으면 403 reauth-required). 두 머리 모두 필수 모양만 본다 */
const IdempotentHeaders = z.object({ 'Idempotency-Key': z.uuid() });
const IdempotentReauthHeaders = z.object({ 'Idempotency-Key': z.uuid(), 'X-Reauth-Token': z.string().optional() });
/** 양도 요청 한 건의 응답(openapi TransferOffer의 필수 칸만). 받는 사람에게 결제 금액·연락처를 싣지 않는다 */
const OfferResponse = z.object({
  offerId: z.string(),
  ticketId: z.string(),
  role: z.enum(['SENDER', 'RECIPIENT']),
  status: z.enum(['OFFERED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED', 'RECLAIMED']),
  expiresAt: z.iso.datetime({ offset: true }),
});
const ReturnResponse = z.object({ ticketId: z.string(), status: z.literal('RETURNED') });

function problem(e: unknown): never {
  if (e instanceof TransferError) {
    switch (e.code) {
      case 'NOT_FOUND':
        throw new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
      case 'RECIPIENT_NOT_FOUND':
        throw new ProblemError({ type: 'recipient-not-found', status: 404, title: '받을 수 있는 회원을 찾지 못했습니다' });
      case 'REAUTH_REQUIRED':
        throw new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
      case 'REAUTH_UNAVAILABLE':
        throw new ProblemError({ type: 'reauth-unavailable', status: 503, title: '재인증 검증기를 쓸 수 없습니다', retryAfterSeconds: 5 });
      case 'TRANSFER_LOCKED':
        throw new ProblemError({ type: 'transfer-locked', status: 409, title: '지금은 양도할 수 없는 티켓입니다', detail: '부정 예매 조사가 끝날 때까지 이 표는 양도할 수 없습니다' });
      case 'ENTRY_STARTED':
        throw new ProblemError({ type: 'entry-started', status: 409, title: '입장이 시작되어 할 수 없습니다' });
      case 'TRANSFER_CLOSED':
        throw new ProblemError({ type: 'transfer-closed', status: 409, title: '양도 마감(공연 시작 2시간 전)이 지났습니다' });
      case 'REOFFER':
        throw new ProblemError({ type: 'reoffer-not-allowed', status: 409, title: '받은 티켓은 다시 양도할 수 없습니다. 결제자에게 돌려주세요' });
      case 'TRANSFER_PENDING':
        throw new ProblemError({ type: 'transfer-pending', status: 409, title: '양도 요청을 철회한 뒤 취소할 수 있습니다', detail: '이미 진행 중인 양도 요청이 있습니다' });
      case 'ALREADY_ENDED':
        throw new ProblemError({ type: 'ticket-ended', status: 409, title: '이미 끝난 티켓입니다' });
      case 'EXPIRED':
        throw new ProblemError({ type: 'transfer-expired', status: 409, title: '양도 요청 기한이 지났습니다' });
      case 'NOT_OFFERED':
        throw new ProblemError({ type: 'transfer-not-offered', status: 409, title: '진행 중인 양도 요청이 아닙니다' });
      case 'PAYER_HOLDS':
        throw new ProblemError({ type: 'payer-holds', status: 409, title: '이미 결제자가 보유한 티켓입니다' });
      case 'ENTRY_RECORDED':
        throw new ProblemError({ type: 'entry-recorded', status: 409, title: '입장 기록이 있어 돌려줄 수 없습니다' });
      case 'UNAVAILABLE':
        throw new ProblemError({ type: 'dependency-unavailable', status: 503, title: '의존 서비스를 잠시 쓸 수 없습니다', retryAfterSeconds: 1 });
      case 'INVALID_INPUT':
        throw new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다' });
    }
  }
  throw e;
}

const codeOnly = (e: unknown): e is TransferError => e instanceof TransferError;

@Controller('v1')
export class TransfersController {
  constructor(private readonly transfers: Transfers) {}

  @Post('transfer-recipient-lookups')
  @HttpCode(200)
  @Roles(['fan'])
  @ContractRouteSchema({
    body: CreateTransferRecipientLookupBody,
    responses: { 200: CreateTransferRecipientLookupResponse },
  })
  async lookup(
    @ContractBody(CreateTransferRecipientLookupBody) body: z.output<typeof CreateTransferRecipientLookupBody>,
  ): Promise<z.output<typeof CreateTransferRecipientLookupResponse>> {
    try {
      return await this.transfers.lookupRecipient({
        ...(body.memberCode === undefined ? {} : { memberCode: body.memberCode }),
        ...(body.phoneNumber === undefined ? {} : { phoneNumber: body.phoneNumber }),
      });
    } catch (e) {
      if (codeOnly(e)) problem(e);
      throw e;
    }
  }

  @Post('tickets/:ticketId/transfers')
  @HttpCode(201)
  @Roles(['fan'])
  @Idempotent({ operation: 'TRANSFER_CREATE' })
  @ContractRouteSchema({
    params: CreateTicketTransferParams,
    headers: IdempotentReauthHeaders,
    body: CreateTicketTransferBody,
    responses: { 201: CreateTicketTransferResponse },
  })
  async create(
    @ContractParams(CreateTicketTransferParams) params: z.output<typeof CreateTicketTransferParams>,
    @ContractBody(CreateTicketTransferBody) body: z.output<typeof CreateTicketTransferBody>,
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() idem: Idem,
    @Headers('x-reauth-token') reauthToken: string | undefined,
  ): Promise<z.output<typeof CreateTicketTransferResponse>> {
    try {
      const v = await this.transfers.createOffer({
        ticketId: params.ticketId,
        accountId: me.accountId,
        sessionId: me.sessionId,
        recipientRef: body.recipientRef,
        idempotencyKey: idem.key,
        ...(reauthToken === undefined ? {} : { reauthToken }),
      });
      return { offerId: v.offerId, ticketId: v.ticketId, role: v.role, status: v.status, expiresAt: v.expiresAt };
    } catch (e) {
      if (codeOnly(e)) problem(e);
      throw e;
    }
  }

  @Get('transfers/:offerId')
  @Roles(['fan'])
  @ContractRouteSchema({ params: GetTransferParams, responses: { 200: GetTransferResponse } })
  async get(
    @ContractParams(GetTransferParams) params: z.output<typeof GetTransferParams>,
    @CurrentPrincipal() me: Principal,
  ): Promise<z.output<typeof GetTransferResponse>> {
    try {
      const v = await this.transfers.getOffer({ offerId: params.offerId, accountId: me.accountId });
      return { offerId: v.offerId, ticketId: v.ticketId, role: v.role, status: v.status, expiresAt: v.expiresAt };
    } catch (e) {
      if (codeOnly(e)) problem(e);
      throw e;
    }
  }

  @Post('transfers/:offerId/acceptance')
  @HttpCode(200)
  @Roles(['fan'])
  @Idempotent({ operation: 'TRANSFER_ACCEPT' })
  @ContractRouteSchema({ params: CreateTransferAcceptanceParams, headers: IdempotentHeaders, responses: { 200: OfferResponse } })
  async accept(@ContractParams(CreateTransferAcceptanceParams) params: z.output<typeof CreateTransferAcceptanceParams>, @CurrentPrincipal() me: Principal): Promise<z.output<typeof OfferResponse>> {
    try {
      return await this.transfers.accept({ offerId: params.offerId, accountId: me.accountId });
    } catch (e) {
      if (codeOnly(e)) problem(e);
      throw e;
    }
  }

  @Post('transfers/:offerId/rejection')
  @HttpCode(200)
  @Roles(['fan'])
  @Idempotent({ operation: 'TRANSFER_REJECT' })
  @ContractRouteSchema({ params: CreateTransferRejectionParams, headers: IdempotentHeaders, responses: { 200: OfferResponse } })
  async reject(@ContractParams(CreateTransferRejectionParams) params: z.output<typeof CreateTransferRejectionParams>, @CurrentPrincipal() me: Principal): Promise<z.output<typeof OfferResponse>> {
    try {
      return await this.transfers.reject({ offerId: params.offerId, accountId: me.accountId });
    } catch (e) {
      if (codeOnly(e)) problem(e);
      throw e;
    }
  }

  @Post('transfers/:offerId/withdrawal')
  @HttpCode(200)
  @Roles(['fan'])
  @Idempotent({ operation: 'TRANSFER_WITHDRAW' })
  @ContractRouteSchema({ params: CreateTransferWithdrawalParams, headers: IdempotentHeaders, responses: { 200: OfferResponse } })
  async withdraw(@ContractParams(CreateTransferWithdrawalParams) params: z.output<typeof CreateTransferWithdrawalParams>, @CurrentPrincipal() me: Principal): Promise<z.output<typeof OfferResponse>> {
    try {
      return await this.transfers.withdraw({ offerId: params.offerId, accountId: me.accountId });
    } catch (e) {
      if (codeOnly(e)) problem(e);
      throw e;
    }
  }

  @Post('tickets/:ticketId/returns')
  @HttpCode(200)
  @Roles(['fan'])
  @Idempotent({ operation: 'TICKET_RETURN' })
  @ContractRouteSchema({
    params: CreateTicketReturnParams,
    headers: IdempotentReauthHeaders,
    responses: { 200: ReturnResponse },
  })
  async returnToPayer(
    @ContractParams(CreateTicketReturnParams) params: z.output<typeof CreateTicketReturnParams>,
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() idem: Idem,
    @Headers('x-reauth-token') reauthToken: string | undefined,
  ): Promise<z.output<typeof ReturnResponse>> {
    try {
      return await this.transfers.returnToPayer({
        ticketId: params.ticketId,
        accountId: me.accountId,
        sessionId: me.sessionId,
        idempotencyKey: idem.key,
        ...(reauthToken === undefined ? {} : { reauthToken }),
      });
    } catch (e) {
      if (codeOnly(e)) problem(e);
      throw e;
    }
  }
}

export type { TransferErrorCode };
