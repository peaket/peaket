// 입장용 휴대폰 등록(openapi POST /v1/tickets/{ticketId}/device-keys, FR-012, POL-018, ADR-0025·0050·0051).
// 팬 쿠키 경로(게이트웨이가 x-user-id·x-session-id·x-user-aud:fan을 넘긴다)로 받고, 키는 이 처리기에서만 만든다.
import { Controller, Headers, HttpCode, Post } from '@nestjs/common';
import {
  CreateTicketDeviceKeyBody,
  CreateTicketDeviceKeyHeader,
  CreateTicketDeviceKeyParams,
  CreateTicketDeviceKeyResponse,
} from '@peaket/contracts/openapi/tickets';
import { ContractBody, ContractParams, ContractRouteSchema, CurrentPrincipal, ProblemError, type Principal, Roles } from '@peaket/platform';
import type { z } from 'zod';
import { DeviceKeyError, DeviceKeys } from '../application/device-keys.js';
import { DeviceKeyInputError } from '../domain/device-key.js';

function problem(e: unknown): never {
  if (e instanceof DeviceKeyInputError) throw new ProblemError({ type: 'invalid-device-key', status: 422, title: '기기 공개키가 P-256 곡선 위의 점이 아닙니다' });
  if (e instanceof DeviceKeyError) {
    if (e.code === 'NOT_FOUND' || e.code === 'NOT_HOLDER') throw new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
    if (e.code === 'REAUTH_REQUIRED' || e.code === 'ENTRY_STARTED') throw new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
    if (e.code === 'REISSUE_LIMIT') throw new ProblemError({ type: 'too-many-requests', status: 429, title: '24시간 안에 이미 다시 받았습니다', retryAfterSeconds: 86_400 });
    if (e.code === 'BOOTH_NOT_ALLOWED') throw new ProblemError({ type: 'booth-not-authorized', status: 403, title: '부스 재발급 허용이 없거나 10분이 지났습니다' });
    if (e.code === 'TRANSFER_NOT_ALLOWED') throw new ProblemError({ type: 'transfer-not-allowed', status: 403, title: '양도로 보유자가 바뀐 티켓만 새 기기를 등록할 수 있습니다' });
  }
  throw e;
}

@Controller('v1/tickets')
export class TicketDeviceKeysController {
  constructor(private readonly keys: DeviceKeys) {}

  @Post(':ticketId/device-keys')
  @HttpCode(201)
  @Roles(['fan'])
  @ContractRouteSchema({
    params: CreateTicketDeviceKeyParams,
    headers: CreateTicketDeviceKeyHeader,
    body: CreateTicketDeviceKeyBody,
    responses: { 201: CreateTicketDeviceKeyResponse },
  })
  async create(
    @ContractParams(CreateTicketDeviceKeyParams) params: z.output<typeof CreateTicketDeviceKeyParams>,
    @ContractBody(CreateTicketDeviceKeyBody) body: z.output<typeof CreateTicketDeviceKeyBody>,
    @CurrentPrincipal() me: Principal,
    @Headers('x-reauth-token') reauthToken: string | undefined,
  ): Promise<z.output<typeof CreateTicketDeviceKeyResponse>> {
    try {
      return await this.keys.register({
        ticketId: params.ticketId,
        accountId: me.accountId,
        sessionId: me.sessionId,
        ...(reauthToken !== undefined ? { reauthToken } : {}),
        publicKeyJwk: body.publicKeyJwk,
        reason: body.reason,
        ...(body.boothRequestId !== undefined ? { boothRequestId: body.boothRequestId } : {}),
      });
    } catch (e) {
      problem(e);
    }
  }
}
