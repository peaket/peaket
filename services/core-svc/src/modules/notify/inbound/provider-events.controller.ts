// F-06-6 GAT-250 대행사 결과 웹훅 내부 HTTP 입구(SNS·Solapi). 서명이 인증이고 내부 토큰을 쓰지 않는다.
// 받으면 202, 서명 불일치 401, 토픽·인증서·구독 확인·모양·상한 위반 403. 게이트웨이에 공개하지 않는다(/internal/*).
import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ContractRouteSchema, ProblemError, Roles, rawBodyOf } from '@peaket/platform';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ProviderEvents } from '../application/provider-events.js';
import { ProviderWebhookError } from '../domain/provider-webhook.js';

const Response = z.object({ accepted: z.literal(true), kind: z.string().nullable() });

@Controller('internal/v1/notify/provider-events')
@Roles(['public'])
export class ProviderEventsController {
  constructor(private readonly events: ProviderEvents) {}

  @Post('ses')
  @HttpCode(202)
  @ContractRouteSchema({ responses: { 202: Response } })
  async ses(@Req() req: FastifyRequest): Promise<{ accepted: true; kind: string | null }> {
    try {
      return await this.events.ses(rawBodyOf(req).toString('utf8'), req.headers as Record<string, string | string[] | undefined>);
    } catch (e) {
      throw problemOf(e);
    }
  }

  @Post('sms')
  @HttpCode(202)
  @ContractRouteSchema({ responses: { 202: Response } })
  receiveSms(@Req() req: FastifyRequest): { accepted: true; kind: string | null } {
    try {
      return this.events.sms(rawBodyOf(req).toString('utf8'), req.headers as Record<string, string | string[] | undefined>);
    } catch (e) {
      throw problemOf(e);
    }
  }
}

function problemOf(e: unknown): unknown {
  if (!(e instanceof ProviderWebhookError)) return e;
  const status = e.code === 'SIGNATURE' ? 401 : 403;
  return new ProblemError({
    type: 'provider-webhook-rejected',
    status,
    title: status === 401 ? '대행사 웹훅 서명이 맞지 않습니다' : '대행사 웹훅을 받을 수 없습니다',
    detail: e.code,
  });
}
