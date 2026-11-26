// F-06-8 core-svc notify의 purchase-svc notice-view 클라이언트(notify §4.9.1, architecture §3.2).
// 내부 토큰을 붙이고 300ms [가정] 안에 답을 읽는다. 실패·모양 오류는 던져 intake가 재시도·보류한다.
import type { ExternalHttpClient } from '@peaket/platform';
import type { BookingNoticeReader, BookingNoticeView } from '../domain/fan-notify-ports.js';

const TIMEOUT_MS = 300;

export class HttpBookingNoticeReader implements BookingNoticeReader {
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly internalToken?: string,
  ) {}

  async get(orderId: string): Promise<BookingNoticeView | undefined> {
    const res = await this.client.request({
      method: 'GET',
      path: '/internal/v1/orders/{orderId}/notice-view',
      params: { orderId },
      headers: this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {},
      timeoutCapMs: TIMEOUT_MS,
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`purchase-svc notice-view ${res.status}`);
    const body = (await res.json()) as Partial<BookingNoticeView>;
    if (
      typeof body.status !== 'string' ||
      typeof body.noticeAllowed !== 'boolean' ||
      typeof body.eventId !== 'string' ||
      !Array.isArray(body.tierIds) ||
      !(body.bookingNo === null || typeof body.bookingNo === 'string') ||
      !(body.phoneE164 === null || typeof body.phoneE164 === 'string')
    ) {
      throw new Error('purchase-svc notice-view 모양이 다르다');
    }
    return {
      bookingNo: body.bookingNo ?? null,
      status: body.status,
      noticeAllowed: body.noticeAllowed,
      phoneE164: body.phoneE164 ?? null,
      eventId: body.eventId,
      tierIds: body.tierIds,
    };
  }
}
