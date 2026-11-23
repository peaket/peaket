// 받는 층: 웹훅 공유 토큰 가드(ASVS v5.0.0-16.3.3, V-T53 ⑥). 토큰이 없거나 틀리면 401 Problem으로 답하고 처리기를 부르지 않는다.
// 거절(로그·지표)은 VerifyWebhook이 남긴다.
import { type CanActivate, type ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { VerifyWebhook } from '../application/verify-webhook.js';

interface WebhookRequest {
  headers: { authorization?: string };
}
interface WebhookReply {
  header(name: string, value: string): unknown;
}

@Injectable()
export class WebhookTokenGuard implements CanActivate {
  constructor(@Inject(VerifyWebhook) private readonly verify: VerifyWebhook) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<WebhookRequest>();
    if (this.verify.check(request.headers.authorization)) return true;
    void http.getResponse<WebhookReply>().header('www-authenticate', 'Bearer');
    // 공용 문제 변환이 application/problem+json 401로 바꾼다(계약의 이름 붙은 오류 목록에 새 이름을 더하지 않는다)
    throw new UnauthorizedException('웹훅 토큰을 확인하지 못했습니다');
  }
}
