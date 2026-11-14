// 받는 층: 다른 서비스·시험이 웹훅 사건을 넣는 내부 경로. outbox 릴레이가 붙기 전의 입구다.
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ContractRouteSchema, InternalTokenGuard, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import { WebhookDispatcher } from '../application/dispatcher.js';
import type { WebhookEventType } from '../domain/webhook.js';

const DeliverySchema = z
  .object({ deliveryId: z.string(), webhookId: z.string(), eventType: z.string(), status: z.string(), attemptCount: z.number() })
  .passthrough();
const EnqueueResponse = z.object({ accepted: z.number(), items: z.array(DeliverySchema) });

@Controller('internal/v1/notify')
@Roles(['public'])
@UseGuards(InternalTokenGuard)
export class InternalWebhookEventController {
  constructor(private readonly dispatcher: WebhookDispatcher) {}

  @Post('webhook-events')
  @HttpCode(202)
  @ContractRouteSchema({ responses: { 202: EnqueueResponse } })
  async enqueue(@Body() body: { promoterId?: unknown; eventType?: unknown; data?: unknown }) {
    if (typeof body.promoterId !== 'string' || typeof body.eventType !== 'string') {
      throw new ProblemError({ type: 'invalid-query', status: 400, title: '목록 조건이 올바르지 않습니다' });
    }
    const items = await this.dispatcher.enqueue({
      promoterId: body.promoterId,
      eventType: body.eventType as WebhookEventType,
      data: (typeof body.data === 'object' && body.data !== null ? body.data : {}) as Record<string, unknown>,
    });
    return { accepted: items.length, items };
  }
}
