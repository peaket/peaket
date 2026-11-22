// BAT-455 받는 층: 팬 알림 설정·웹 푸시 구독·한 번 누름 수신 거부(openapi identity 태그, GAT-250, N-T17·N-T18·N-T20).
import { Controller, Delete, Get, Header, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  CreateEventSubscriptionBody,
  CreateEventSubscriptionResponse,
  DeleteEventSubscriptionsQueryParams,
  DeleteEventSubscriptionsResponse,
  DeletePushSubscriptionParams,
  DeletePushSubscriptionResponse,
  ListSubscriptionsQueryParams,
  ListSubscriptionsResponse,
  CreatePushSubscriptionBody,
  CreatePushSubscriptionResponse,
  CreateSubscriptionOptOutBody,
  CreateSubscriptionOptOutParams,
} from '@peaket/contracts/openapi/identity';
import { AcceptFormUrlEncoded, ContractBody, ContractParams, ContractQuery, ContractRouteSchema, CurrentPrincipal, ProblemError, Roles, type Principal } from '@peaket/platform';
import { z } from 'zod';
import { FanNotifyProblem } from '../domain/fan-notify.js';
import { FanSubscriptions, PushSubscriptions, SubscriptionOptOuts } from '../application/fan-notify.js';
import type { SubscriptionPage } from '../domain/fan-notify-ports.js';

const EventParams = z.object({ eventId: z.string() }).strict();
const NoBody = z.null();

function asProblem(e: unknown): never {
  if (!(e instanceof FanNotifyProblem)) throw e;
  const map: Record<FanNotifyProblem['code'], { status: number; type: string }> = {
    INVALID: { status: 400, type: 'invalid-query' },
    NOT_FOUND: { status: 404, type: 'not-found' },
    OPEN_PASSED: { status: 410, type: 'open-passed' },
    SALE_ENDED: { status: 410, type: 'sale-ended' },
    SUBSCRIPTION_LIMIT: { status: 422, type: 'subscription-limit' },
    PUSH_SERVICE_NOT_ALLOWED: { status: 422, type: 'push-service-not-allowed' },
    PUSH_KEY_INVALID: { status: 422, type: 'push-key-invalid' },
  };
  const m = map[e.code];
  throw new ProblemError({ type: m.type, status: m.status, title: e.message });
}

@Controller('v1')
export class FanNotifyController {
  constructor(
    private readonly subscriptions: FanSubscriptions,
    private readonly pushSubscriptions: PushSubscriptions,
    private readonly optOuts: SubscriptionOptOuts,
  ) {}

  @Get('subscriptions')
  @ContractRouteSchema({ responses: { 200: ListSubscriptionsResponse } })
  @Roles(['fan'])
  @Header('Cache-Control', 'no-store')
  async list(@ContractQuery(ListSubscriptionsQueryParams) q: z.output<typeof ListSubscriptionsQueryParams>, @CurrentPrincipal() me: Principal): Promise<SubscriptionPage> {
    const eventIds = q.eventIds ? q.eventIds.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    if (eventIds && eventIds.length > 50) throw new ProblemError({ type: 'invalid-query', status: 400, title: '목록 조건이 올바르지 않습니다', detail: 'eventIds는 50개까지입니다' });
    return this.subscriptions.list(me.accountId, eventIds, q.cursor ?? null, q.limit ?? 20);
  }

  @Post('events/:eventId/subscriptions')
  @ContractRouteSchema({ responses: { 200: CreateEventSubscriptionResponse, 201: CreateEventSubscriptionResponse } })
  @Roles(['fan'])
  async create(
    @ContractParams(EventParams) params: z.output<typeof EventParams>,
    @ContractBody(CreateEventSubscriptionBody) body: z.output<typeof CreateEventSubscriptionBody>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    try {
      const r = await this.subscriptions.create(me.accountId, params.eventId, body);
      void reply.code(r.created ? 201 : 200);
      void reply.header('cache-control', 'no-store');
      return r.state;
    } catch (e) {
      return asProblem(e);
    }
  }

  @Delete('events/:eventId/subscriptions')
  @ContractRouteSchema({ responses: { 204: NoBody } })
  @Roles(['fan'])
  @HttpCode(204)
  async remove(
    @ContractParams(EventParams) params: z.output<typeof EventParams>,
    @ContractQuery(DeleteEventSubscriptionsQueryParams) q: z.output<typeof DeleteEventSubscriptionsQueryParams>,
    @CurrentPrincipal() me: Principal,
  ): Promise<void> {
    await this.subscriptions.remove(me.accountId, params.eventId, q.kind);
  }

  @Post('push-subscriptions')
  @ContractRouteSchema({ responses: { 200: CreatePushSubscriptionResponse, 201: CreatePushSubscriptionResponse } })
  @Roles(['fan'])
  async registerPush(
    @ContractBody(CreatePushSubscriptionBody) body: z.output<typeof CreatePushSubscriptionBody>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    try {
      const r = await this.pushSubscriptions.register(me.accountId, body);
      void reply.code(r.created ? 201 : 200);
      void reply.header('cache-control', 'no-store');
      return { subscriptionKey: r.subscriptionKey, service: r.service };
    } catch (e) {
      return asProblem(e);
    }
  }

  @Delete('push-subscriptions/:subscriptionKey')
  @ContractRouteSchema({ responses: { 204: NoBody } })
  @Roles(['fan'])
  @HttpCode(204)
  async removePush(@ContractParams(DeletePushSubscriptionParams) params: z.output<typeof DeletePushSubscriptionParams>, @CurrentPrincipal() me: Principal): Promise<void> {
    await this.pushSubscriptions.remove(me.accountId, params.subscriptionKey);
  }

  @Post('subscription-opt-outs/:optOutToken')
  @AcceptFormUrlEncoded()
  @ContractRouteSchema({ responses: { 200: z.object({}) } })
  @Roles(['public'])
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async optOut(@Param() params: z.output<typeof CreateSubscriptionOptOutParams>, @ContractBody(CreateSubscriptionOptOutBody) body: z.output<typeof CreateSubscriptionOptOutBody>): Promise<unknown> {
    try {
      await this.optOuts.redeem(params.optOutToken, body);
      return {};
    } catch (e) {
      return asProblem(e);
    }
  }
}
