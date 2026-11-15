// 예매자 명단 원천: purchase-svc 내부 HTTP(A2-03). 굿즈 주문이 아니라 결제 완료 주문·SOLD 좌석을 읽는다.
import { createExternalHttpClient } from '@peaket/platform';
import type { AttendeeRecord } from '../../shop/index.js';
import type { AttendeeSource } from '../domain/ports.js';

interface Page {
  items: { orderId: string; eventId: string; buyerName: string; buyerPhone: string; seats: { seatLabel: string; tier: string }[]; ticketCount: number }[];
  nextCursor: string | null;
  bookingCount: number;
  ticketCount: number;
}

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
    return (await res.json()) as Page;
  }

  async list(_promoterId: string, eventId: string, limit: number, cursor?: string): Promise<AttendeeRecord[]> {
    const page = await this.#get(eventId, Math.min(limit, 1_000), cursor);
    return page.items.map((r) => ({
      orderId: r.orderId,
      eventId: r.eventId,
      buyerName: r.buyerName,
      buyerPhone: r.buyerPhone,
      seatLabel: r.seats.map((s) => s.seatLabel).join(', ') || null,
      quantity: r.ticketCount,
      seats: r.seats,
    }));
  }

  async count(_promoterId: string, eventId: string): Promise<{ bookings: number; tickets: number }> {
    const page = await this.#get(eventId, 1);
    return { bookings: page.bookingCount, tickets: page.ticketCount };
  }
}
