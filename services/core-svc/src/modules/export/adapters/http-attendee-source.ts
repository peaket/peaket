// 예매자 명단 원천: purchase-svc 내부 HTTP(A2-03). 굿즈 주문이 아니라 결제 완료 주문·SOLD 좌석을 읽는다.
import { createExternalHttpClient } from '@peaket/platform';
import { z } from 'zod';
import type { AttendeeRecord } from '../../shop/index.js';
import type { AttendeeSource, AttendeeSourcePage } from '../domain/ports.js';

/**
 * purchase-svc 내부 응답 모양(services/purchase-svc booking attendee-export.controller.ts의 Page와 같다).
 * 모양이 틀리면(nextCursor 없음·형이 다름, items가 배열이 아님) 조용히 끝으로 보지 않고 실패한다(W7-audit A2-17, docs/api/guidelines.md §3)
 */
const Page = z.object({
  items: z.array(
    z.object({
      orderId: z.string(),
      eventId: z.string(),
      buyerName: z.string(),
      buyerPhone: z.string(),
      seats: z.array(z.object({ seatLabel: z.string(), tier: z.string() })),
      ticketCount: z.number().int(),
    }),
  ),
  nextCursor: z.string().nullable(),
  bookingCount: z.number().int(),
  ticketCount: z.number().int(),
});
type Page = z.output<typeof Page>;

export class HttpAttendeeSource implements AttendeeSource {
  readonly #client: ReturnType<typeof createExternalHttpClient>;
  readonly #token: string | undefined;

  constructor(o: { url: string; token?: string }) {
    this.#client = createExternalHttpClient({ provider: 'purchase-attendees', baseUrl: o.url, timeoutCapMs: 5_000 });
    this.#token = o.token;
  }

  async #get(eventId: string, limit: number, cursor?: string): Promise<Page> {
    const res = await this.#client.request({
      method: 'GET',
      path: '/internal/v1/events/{eventId}/attendees',
      params: { eventId },
      query: { limit, ...(cursor ? { cursor } : {}) },
      headers: this.#token ? { 'x-peaket-internal-token': this.#token } : {},
    });
    if (!res.ok) throw new Error(`예매자 명단 원천이 ${res.status}로 답했다`);
    const parsed = Page.safeParse(await res.json());
    if (!parsed.success) throw new Error('예매자 명단 원천 응답 모양이 틀렸다');
    return parsed.data;
  }

  async list(_promoterId: string, eventId: string, limit: number, cursor?: string): Promise<AttendeeSourcePage> {
    const page = await this.#get(eventId, Math.min(limit, 1_000), cursor);
    const items: AttendeeRecord[] = page.items.map((r) => ({
      orderId: r.orderId,
      eventId: r.eventId,
      buyerName: r.buyerName,
      buyerPhone: r.buyerPhone,
      seatLabel: r.seats.map((s) => s.seatLabel).join(', ') || null,
      quantity: r.ticketCount,
      seats: r.seats,
    }));
    // 원천의 nextCursor를 그대로 넘긴다. 원천은 SOLD 좌석이 없는 주문을 걸러 items가 limit보다 적거나 0건이어도 커서를 줄 수 있다(A2-17)
    return { items, nextCursor: page.nextCursor };
  }

  async count(_promoterId: string, eventId: string): Promise<{ bookings: number; tickets: number }> {
    const page = await this.#get(eventId, 1);
    return { bookings: page.bookingCount, tickets: page.ticketCount };
  }
}
