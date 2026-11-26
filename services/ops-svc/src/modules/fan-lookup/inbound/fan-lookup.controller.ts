// ops-svc 팬 조회 REST(F-06-5, openapi /v1/ops/fan-lookups·/v1/ops/fans*).
import { Body, Controller, Get, Header, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ContractRouteSchema, CurrentPrincipal, ProblemError, Roles, type Principal } from '@peaket/platform';
import { z } from 'zod';
import { FanLookup } from '../application/fan-lookup.js';

const LookupBody = z.object({ orderNo: z.string().min(1).max(40).optional(), reservationNo: z.string().min(1).max(40).optional(), memberCode: z.string().min(1).max(40).optional() }).strict();
const UnmaskBody = z.object({ fields: z.array(z.string()).min(1).max(3), reason: z.string().min(5).max(500), orderId: z.string().min(1).max(64).optional() }).strict();
const NOWHERE = z.record(z.string(), z.unknown());
const ROLES = ['operator', 'commander', 'cs_agent', 'cs_lead'] as const;
const CS_ROLES = ['cs_agent', 'cs_lead'] as const;

@Controller('v1/ops')
export class FanLookupController {
  constructor(private readonly lookup: FanLookup) {}

  @Post('fan-lookups')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @Roles([...ROLES])
  @ContractRouteSchema({ responses: { 200: NOWHERE } })
  async find(@Body() raw: unknown) {
    const parsed = LookupBody.safeParse(raw ?? {});
    if (!parsed.success) throw new ProblemError({ type: 'invalid-body', status: 400, title: '찾는 값을 하나만 보내야 합니다' });
    return this.lookup.lookup(parsed.data);
  }

  @Get('fans/:accountId')
  @Header('Cache-Control', 'private, no-store')
  @Roles([...ROLES])
  @ContractRouteSchema({ responses: { 200: NOWHERE } })
  async detail(@Param('accountId') accountId: string) {
    return this.lookup.detail(accountId);
  }

  @Post('fans/:accountId/unmaskings')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @Roles([...ROLES])
  @ContractRouteSchema({ responses: { 200: NOWHERE } })
  async unmask(@Param('accountId') accountId: string, @Body() raw: unknown, @CurrentPrincipal() me: Principal, @Headers() headers: Record<string, string | string[] | undefined>) {
    const parsed = UnmaskBody.safeParse(raw ?? {});
    if (!parsed.success) throw new ProblemError({ type: 'invalid-body', status: 422, title: '열람 요청이 올바르지 않습니다' });
    const xff = typeof headers['x-forwarded-for'] === 'string' ? headers['x-forwarded-for'].split(',')[0]!.trim() : '';
    return this.lookup.unmask(accountId, parsed.data, { accountId: me.accountId, role: me.role ?? 'viewer' }, xff || '127.0.0.1');
  }

  @Get('fans/:accountId/orders')
  @Header('Cache-Control', 'private, no-store')
  @Roles([...CS_ROLES])
  @ContractRouteSchema({ responses: { 200: NOWHERE } })
  async orders(@Param('accountId') accountId: string, @Query('limit') limitRaw: string | undefined) {
    return this.lookup.orders(accountId, this.limit(limitRaw));
  }

  @Get('fans/:accountId/tickets')
  @Header('Cache-Control', 'private, no-store')
  @Roles([...CS_ROLES])
  @ContractRouteSchema({ responses: { 200: NOWHERE } })
  async tickets(@Param('accountId') accountId: string, @Query('limit') limitRaw: string | undefined) {
    return this.lookup.tickets(accountId, this.limit(limitRaw));
  }

  @Get('fans/:accountId/transfers')
  @Header('Cache-Control', 'private, no-store')
  @Roles([...CS_ROLES])
  @ContractRouteSchema({ responses: { 200: NOWHERE } })
  async transfers(@Param('accountId') accountId: string, @Query('limit') limitRaw: string | undefined) {
    return this.lookup.transfers(accountId, this.limit(limitRaw));
  }

  @Get('fans/:accountId/queue-entries')
  @Header('Cache-Control', 'private, no-store')
  @Roles([...CS_ROLES])
  @ContractRouteSchema({ responses: { 200: NOWHERE } })
  async queueEntries(@Param('accountId') accountId: string, @Query('caseId') caseId: string | undefined, @Query('limit') limitRaw: string | undefined) {
    return this.lookup.queueEntries(accountId, caseId, this.limit(limitRaw));
  }

  @Get('fans/:accountId/cases')
  @Header('Cache-Control', 'private, no-store')
  @Roles([...ROLES])
  @ContractRouteSchema({ responses: { 200: NOWHERE } })
  async cases(@Param('accountId') accountId: string, @Query('limit') limitRaw: string | undefined) {
    return this.lookup.cases(accountId, this.limit(limitRaw));
  }

  private limit(v: string | undefined): number {
    if (v === undefined) return 20;
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 1 || n > 100) throw new ProblemError({ type: 'invalid-query', status: 400, title: 'limit은 1~100입니다' });
    return n;
  }
}
