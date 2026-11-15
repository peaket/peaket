// A2-03: core가 purchase-svc 내부 HTTP에서 결제 완료 주문·SOLD 좌석만 받아 AttendeeRecord로 옮기는지 본다.
import { describe, expect, test } from 'vitest';
import { HttpAttendeeSource } from '../src/modules/export/adapters/http-attendee-source.js';

const page = {
  items: [
    { orderId: '0190f3a1-7c2e-7a00-8000-000000000101', eventId: '0190f3a1-7c2e-7a00-8000-000000000201', buyerName: '김민수', buyerPhone: '010-1234-5678', seats: [{ seatLabel: 'A-1', tier: 'VIP' }, { seatLabel: 'A-2', tier: 'VIP' }], ticketCount: 2 },
  ],
  nextCursor: null,
  bookingCount: 1,
  ticketCount: 2,
};

describe('A2-03 예매자 명단 원천', () => {
  test('purchase-svc 응답의 좌석 등급·매수를 AttendeeRecord로 옮기고 내부 토큰을 보낸다', async () => {
    let seen: { url: string; init: RequestInit | undefined } | undefined;
    const fetch = (async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    // 생성자는 fetch를 받지 않으므로 전역 fetch를 잠시 바꾼 뒤 만든다
    const original = globalThis.fetch;
    globalThis.fetch = fetch;
    try {
      const source = new HttpAttendeeSource({ url: 'https://purchase.test', token: 'int-token' });
      const rows = await source.list('tenant', page.items[0]!.eventId, 100);
      expect(rows).toEqual([
        {
          orderId: page.items[0]!.orderId,
          eventId: page.items[0]!.eventId,
          buyerName: '김민수',
          buyerPhone: '010-1234-5678',
          seatLabel: 'A-1, A-2',
          quantity: 2,
          seats: page.items[0]!.seats,
        },
      ]);
      expect(new Headers(seen!.init!.headers).get('x-peaket-internal-token')).toBe('int-token');
      expect(await source.count('tenant', page.items[0]!.eventId)).toEqual({ bookings: 1, tickets: 2 });
    } finally {
      globalThis.fetch = original;
    }
  });
});
