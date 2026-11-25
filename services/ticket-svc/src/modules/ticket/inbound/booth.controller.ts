// 부스 재발급 요청(openapi createTicketBoothRequest, F-05-12 O-T28 ②).
// 팬 쿠키 경로다. 대조 토큰은 identity 부스 본인확인 결과의 reverificationToken이고, 응답은 8자 코드·10분이다.
import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ContractBody, ContractRouteSchema, CurrentPrincipal, ProblemError, type Principal, Roles } from '@peaket/platform';
import { z } from 'zod';
import { BoothBeforeEntry, BoothLimit, BoothMismatch, BoothNotFound, TicketBooth } from '../application/booth.js';

const BoothRequestBody = z.object({ reverificationToken: z.string() }).strict();
const BoothRequestResult = z.object({ boothRequestId: z.string(), boothCode: z.string(), expiresAt: z.string() });

function problem(e: unknown): never {
  if (e instanceof BoothNotFound) throw new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
  if (e instanceof BoothBeforeEntry) throw new ProblemError({ type: 'booth-before-entry', status: 409, title: '입장 시작 전에는 온라인으로 다시 받으세요' });
  if (e instanceof BoothMismatch) throw new ProblemError({ type: 'booth-mismatch', status: 409, title: '본인확인 결과가 이 티켓의 계정과 다릅니다' });
  if (e instanceof BoothLimit) throw new ProblemError({ type: 'too-many-requests', status: 429, title: '오늘은 부스 재발급을 더 요청할 수 없습니다', retryAfterSeconds: 86_400 });
  throw e;
}

@Controller('v1/tickets')
export class TicketBoothController {
  constructor(private readonly booth: TicketBooth) {}

  @Post(':ticketId/booth-requests')
  @HttpCode(201)
  @ContractRouteSchema({ body: BoothRequestBody, responses: { 201: BoothRequestResult } })
  @Roles(['fan'])
  async create(
    @Param('ticketId') ticketId: string,
    @ContractBody(BoothRequestBody) body: z.output<typeof BoothRequestBody>,
    @CurrentPrincipal() me: Principal,
  ): Promise<{ boothRequestId: string; boothCode: string; expiresAt: string }> {
    try {
      return await this.booth.request({ ticketIdRaw: ticketId, accountId: me.accountId, body });
    } catch (e) {
      problem(e);
    }
  }
}
