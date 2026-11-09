// 받는 층: 결제사 웹훅(openapi POST /v1/webhooks/toss·/v1/webhooks/portone, docs/features/payment.md §5 '웹훅 받기의 첫 구현', BUILD_ORDER HOT-150).
// 인증이 없는 경로다(앞단 gw-partner, 신원 머리를 보지 않는다). 서명 검증과 본문 읽기는 어댑터가 원문 바이트를 UTF-8로 되돌린 글로 한다.
// 응답 본문은 쓰지 않는다. 400은 이름 없는 Problem(about:blank)이고 사유는 로그에만 남긴다(떠보기를 돕지 않게). 413은 @BodyLimit으로 플랫폼 본문 해석기가 읽기 전에 낸다.
import { BadRequestException, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { BodyLimit, ProblemError, rawBodyOf, Roles } from '@peaket/platform';
import { ReceivePaymentWebhook } from '../application/receive-payment-webhook.js';
import { WEBHOOK_MAX_BODY_BYTES, type WebhookRoute } from '../domain/webhook-receipt.js';

type HttpRequest = Parameters<typeof rawBodyOf>[0];

/** 저장 실패의 Retry-After 1초 [가정] */
const STORE_RETRY_AFTER_SECONDS = 1;

@Controller('v1/webhooks')
export class PaymentWebhookController {
  constructor(@Inject(ReceivePaymentWebhook) private readonly webhooks: ReceivePaymentWebhook) {}

  @Post('toss')
  @HttpCode(200)
  @Roles(['public'])
  @BodyLimit(WEBHOOK_MAX_BODY_BYTES)
  toss(@Req() request: HttpRequest): Promise<void> {
    return this.#handle('toss', request);
  }

  @Post('portone')
  @HttpCode(200)
  @Roles(['public'])
  @BodyLimit(WEBHOOK_MAX_BODY_BYTES)
  portone(@Req() request: HttpRequest): Promise<void> {
    return this.#handle('portone', request);
  }

  async #handle(route: WebhookRoute, request: HttpRequest): Promise<void> {
    const answer = await this.webhooks.receive(route, request.headers, rawBodyOf(request));
    if (answer === 'ACCEPTED') return;
    if (answer === 'REJECTED') throw new BadRequestException();
    throw new ProblemError({ type: 'dependency-unavailable', status: 503, title: '의존 서비스를 잠시 쓸 수 없습니다', retryAfterSeconds: STORE_RETRY_AFTER_SECONDS });
  }
}
