// 받는 층: 웹훅 공유 토큰 가드(docs/observability.md §5 '진단 증거' 받는 길, ASVS v5.0.0-16.3.3, 시험 D-T51 ④).
// 토큰이 없거나 틀리면 401 Problem(application/problem+json, UnauthorizedException을 공용 문제 변환이 바꾼다)으로 답하고 처리기(수집)를 부르지 않는다. 거절은 유스케이스가 남긴다.
import { type CanActivate, type ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { VerifyWebhook } from '../application/verify-webhook.js';

/** 이 가드가 읽는 요청·쓰는 응답의 칸(Fastify 요청·응답이 이 모양이다) */
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
    // 공용 문제 변환이 application/problem+json 401로 바꾼다(core-svc 내부 경로의 401과 같은 꼴. 계약의 이름 붙은 오류 목록에 새 이름을 더하지 않는다)
    throw new UnauthorizedException('웹훅 토큰을 확인하지 못했습니다');
  }
}
