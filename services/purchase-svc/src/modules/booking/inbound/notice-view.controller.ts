// F-06-8 purchase-svc 내부 HTTP: 예매 확정 알림의 notice-view(notify §4.9.1, architecture §3.2).
// 내부 토큰이 없거나 틀리면 401, 주문이 없으면 404, 있으면 예매번호·상태·알림 허용·번호·회차·등급 ID를 준다.
import { CanActivate, Controller, ExecutionContext, Get, Inject, Injectable, Optional, Param, UnauthorizedException, UseGuards } from '@nestjs/common';
import { constantTimeEqual, ContractRouteSchema, INTERNAL_TOKEN, INTERNAL_TOKEN_REQUIRED, ProblemError, Roles } from '@peaket/platform';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { BookingNoticeReader, BookingNoticeView } from '../domain/ports.js';

const NoticeView = z.object({
  bookingNo: z.string().nullable(),
  status: z.string(),
  noticeAllowed: z.boolean(),
  phoneE164: z.string().nullable(),
  eventId: z.string().uuid(),
  tierIds: z.array(z.string()),
});

export const BOOKING_NOTICE_READER = Symbol.for('peaket.booking.notice-reader');

/** 내부 토큰이 없거나 틀리면 403이 아니라 401로 답한다(notify §4.9.1 시험 계약) */
@Injectable()
export class NoticeViewTokenGuard implements CanActivate {
  constructor(
    @Optional() @Inject(INTERNAL_TOKEN) private readonly expected?: string,
    @Optional() @Inject(INTERNAL_TOKEN_REQUIRED) private readonly required = false,
  ) {}

  /** 플랫폼 InternalTokenGuard와 같이 운영에서 토큰이 없으면 시작을 막는다(fail-closed) */
  onModuleInit(): void {
    if (this.required && !this.expected) throw new Error('PEAKET_INTERNAL_TOKEN이 없다(notice-view 내부 HTTP 공유 토큰이 운영에서 꼭 필요하다)');
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.expected) return !this.required;
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const got = request.headers['x-peaket-internal-token'];
    const value = Array.isArray(got) ? got[0] : got;
    if (typeof value !== 'string' || !constantTimeEqual(value, this.expected)) throw new UnauthorizedException();
    return true;
  }
}

@Controller('internal/v1/orders')
@UseGuards(NoticeViewTokenGuard)
export class NoticeViewController {
  constructor(@Optional() @Inject(BOOKING_NOTICE_READER) private readonly reader?: BookingNoticeReader) {}

  @Get(':orderId/notice-view')
  @Roles(['public'])
  @ContractRouteSchema({ responses: { 200: NoticeView } })
  async get(@Param('orderId') orderId: string): Promise<BookingNoticeView> {
    const view = await this.reader?.get(orderId);
    if (!view) throw new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
    return view;
  }
}
