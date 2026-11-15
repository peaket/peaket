// 받는 층: 회차 취소 요청·판정·2인 확정(openapi /v1/ops/event-cancellations, BAT-425 GAT-130 잔여).
import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ContractBody, ContractParams, ContractRouteSchema, CurrentPrincipal, type Principal, ProblemError, Roles } from '@peaket/platform';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { EventCancellationProblem } from '../domain/event-cancellation.js';
import { EventCancellations, type OpsActor } from '../application/event-cancellations.js';

const RequestBody = z.object({ eventId: z.uuid(), kind: z.literal('CANCEL').optional(), reason: z.string().min(1) }).strict();
const JudgeBody = z.object({ fault: z.enum(['ORGANIZER', 'FORCE_MAJEURE', 'CONTENT_CHANGE']), reason: z.string().min(1), fanNoticeReason: z.string().min(1).max(200) }).strict();
const RejectBody = z.object({ reason: z.string().min(1) }).strict();
const PauseBody = z.object({ pg: z.enum(['TOSS', 'PORTONE', 'SIMULATOR']).optional(), reason: z.string().min(1) }).strict();
const Params = z.object({ requestId: z.string().min(1) });
const View = z
  .object({
    requestId: z.string(),
    eventId: z.string(),
    kind: z.enum(['CANCEL', 'POSTPONE']),
    status: z.enum(['REQUESTED', 'JUDGED', 'PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'PAUSED', 'REFUND_WINDOW', 'COMPLETED', 'REJECTED']),
    reason: z.string(),
    fault: z.enum(['ORGANIZER', 'FORCE_MAJEURE', 'CONTENT_CHANGE']).optional(),
    fanNoticeReason: z.string().optional(),
    requestedAt: z.string(),
    judgedBy: z.string().optional(),
    progress: z.object({ state: z.string() }).optional(),
  })
  .passthrough();
const Page = z.object({ items: z.array(View), nextCursor: z.string().nullable() });

const actorOf = (me: Principal): OpsActor => ({ accountId: me.accountId, sessionId: me.sessionId, role: me.role ?? 'operator' });
const fail = (err: unknown): never => {
  if (err instanceof EventCancellationProblem) throw new ProblemError({ type: err.type, status: err.status, title: err.title });
  throw err;
};
const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1 || n > 100) throw new ProblemError({ type: 'invalid-query', status: 400, title: '목록 조건이 올바르지 않습니다' });
  return n;
};

@Controller('v1/ops/event-cancellations')
export class EventCancellationsController {
  constructor(private readonly cancellations: EventCancellations) {}

  @Post()
  @HttpCode(201)
  @Roles(['commander'])
  @ContractRouteSchema({ body: RequestBody, responses: { 201: View } })
  async request(@ContractBody(RequestBody) body: z.output<typeof RequestBody>, @CurrentPrincipal() me: Principal) {
    try {
      return await this.cancellations.request(body, actorOf(me));
    } catch (err) {
      return fail(err);
    }
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @Roles(['viewer', 'operator', 'commander', 'cs_agent', 'cs_lead'])
  @ContractRouteSchema({ responses: { 200: Page } })
  async list(@Query() q: Record<string, string | undefined>) {
    return this.cancellations.list({ ...(q.eventId ? { eventId: q.eventId } : {}), ...(q.status ? { status: q.status.split(',') as never } : {}), limit: num(q.limit, 50) });
  }

  @Get(':requestId')
  @Header('Cache-Control', 'no-store')
  @Roles(['viewer', 'operator', 'commander', 'cs_agent', 'cs_lead'])
  @ContractRouteSchema({ params: Params, responses: { 200: View } })
  async get(@ContractParams(Params) params: z.output<typeof Params>) {
    try {
      return await this.cancellations.get(params.requestId);
    } catch (err) {
      return fail(err);
    }
  }

  @Post(':requestId/judgement')
  @HttpCode(200)
  @Roles(['commander'])
  @ContractRouteSchema({ params: Params, body: JudgeBody, responses: { 200: View } })
  async judge(@ContractParams(Params) params: z.output<typeof Params>, @ContractBody(JudgeBody) body: z.output<typeof JudgeBody>, @CurrentPrincipal() me: Principal) {
    try {
      return await this.cancellations.judge(params.requestId, body, actorOf(me));
    } catch (err) {
      return fail(err);
    }
  }

  @Post(':requestId/approvals')
  @HttpCode(200)
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ params: Params, responses: { 200: View } })
  async approve(@ContractParams(Params) params: z.output<typeof Params>, @CurrentPrincipal() me: Principal, @Req() request: FastifyRequest) {
    try {
      const token = request.headers['x-reauth-token'];
      return await this.cancellations.approve(params.requestId, actorOf(me), typeof token === 'string' ? token : undefined);
    } catch (err) {
      return fail(err);
    }
  }

  @Post(':requestId/rejections')
  @HttpCode(200)
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ params: Params, body: RejectBody, responses: { 200: View } })
  async reject(@ContractParams(Params) params: z.output<typeof Params>, @ContractBody(RejectBody) body: z.output<typeof RejectBody>, @CurrentPrincipal() me: Principal) {
    try {
      return await this.cancellations.reject(params.requestId, actorOf(me), body.reason);
    } catch (err) {
      return fail(err);
    }
  }

  @Post(':requestId/pauses')
  @HttpCode(200)
  @Roles(['commander'])
  @ContractRouteSchema({ params: Params, body: PauseBody, responses: { 200: View } })
  async pause(@ContractParams(Params) params: z.output<typeof Params>, @ContractBody(PauseBody) body: z.output<typeof PauseBody>, @CurrentPrincipal() me: Principal) {
    try {
      return await this.cancellations.pause(params.requestId, actorOf(me), body);
    } catch (err) {
      return fail(err);
    }
  }

  @Post(':requestId/resumptions')
  @HttpCode(200)
  @Roles(['commander'])
  @ContractRouteSchema({ params: Params, body: PauseBody, responses: { 200: View } })
  async resume(@ContractParams(Params) params: z.output<typeof Params>, @ContractBody(PauseBody) body: z.output<typeof PauseBody>, @CurrentPrincipal() me: Principal) {
    try {
      return await this.cancellations.resume(params.requestId, actorOf(me), body);
    } catch (err) {
      return fail(err);
    }
  }
}
