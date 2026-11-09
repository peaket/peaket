// 받는 층: 허니팟 기록 처리기(docs/features/bot-defense.md §7·§4.8, trust.proto 끝 주석, ADR-0249 결정 3).
// gw-fan이 숨긴 링크의 공개 경로(설정으로 넣는 값)를 이 내부 경로로 잇는다. 공개 경로는 이 저장소에 없다.
// 응답은 조건과 상관없이 204·빈 본문이다. 기록은 응답 뒤로 미룬다.
import { Controller, Get, HttpCode, Inject, Req } from '@nestjs/common';
import { Roles } from '@peaket/platform';
import type { FastifyRequest } from 'fastify';
import { RecordHoneypot } from '../application/record-honeypot.js';

export const HONEYPOT_RECORDER = Symbol('trust.RecordHoneypot');

const header = (h: FastifyRequest['headers'], name: string): string | undefined => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

@Controller('internal')
export class HoneypotController {
  constructor(@Inject(HONEYPOT_RECORDER) private readonly honeypot: RecordHoneypot) {}

  @Get('honeypot-hit')
  @Roles(['public'])
  @HttpCode(204)
  hit(@Req() req: FastifyRequest): void {
    const q = (req.query ?? {}) as Record<string, unknown>;
    this.honeypot.run({
      fetchSite: header(req.headers, 'sec-fetch-site'),
      purpose: header(req.headers, 'sec-purpose'),
      routerPrefetch: header(req.headers, 'next-router-prefetch'),
      // 이 머리는 검증 없이 그대로 믿는다. 바깥의 x-user-*를 지우는 gw-fan과 호출자를 gw-fan으로 줄이는 메시 정책이 아직 없어, 그 전에는 위조할 수 있다(ADR-0249 배포 조건)
      pid: header(req.headers, 'x-user-pid'),
      pidPrev: header(req.headers, 'x-user-pid-prev'),
      eventId: typeof q.e === 'string' ? q.e : undefined,
    });
  }
}
