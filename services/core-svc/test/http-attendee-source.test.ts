// A2-03: core가 purchase-svc 내부 HTTP에서 결제 완료 주문·SOLD 좌석만 받아 AttendeeRecord로 옮기는지 본다.
// W7-audit A2-17: 원천의 nextCursor를 그대로 넘기고, 응답 모양이 틀리면 조용히 끝으로 보지 않고 실패한다(docs/api/guidelines.md §3).
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
const EVENT = page.items[0]!.eventId;

/** 전역 fetch를 잠시 바꿔 응답 본문을 정하고 받은 요청을 모은다(생성자는 fetch를 받지 않는다) */
async function withFetch<T>(body: unknown, run: (seen: { url: URL; init: RequestInit | undefined }[]) => Promise<T>): Promise<T> {
  const seen: { url: URL; init: RequestInit | undefined }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url: new URL(url), init });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  try {
    return await run(seen);
  } finally {
    globalThis.fetch = original;
  }
}

describe('A2-03 예매자 명단 원천', () => {
  test('purchase-svc 응답의 좌석 등급·매수를 AttendeeRecord로 옮기고 내부 토큰을 보낸다', async () => {
    await withFetch(page, async (seen) => {
      const source = new HttpAttendeeSource({ url: 'https://purchase.test', token: 'int-token' });
      const got = await source.list('tenant', EVENT, 100);
      expect(got.items).toEqual([
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
      expect(new Headers(seen[0]!.init!.headers).get('x-peaket-internal-token')).toBe('int-token');
      expect(await source.count('tenant', EVENT)).toEqual({ bookings: 1, tickets: 2 });
    });
  });
});

describe('A2-17 원천 커서 넘기기', () => {
  test('A2-17 HttpAttendeeSource는 원천의 nextCursor를 넘기고 다음 요청에 그 커서를 싣는다', async () => {
    await withFetch({ ...page, nextCursor: 'abc' }, async (seen) => {
      const source = new HttpAttendeeSource({ url: 'https://purchase.test', token: 'int-token' });
      const first = await source.list('tenant', EVENT, 100);
      expect(first.nextCursor).toBe('abc');
      expect(first.items).toHaveLength(1);
      expect(seen[0]!.url.searchParams.get('cursor')).toBeNull();

      await source.list('tenant', EVENT, 100, 'abc');
      expect(seen[1]!.url.pathname).toBe(`/internal/v1/events/${EVENT}/attendees`);
      expect(seen[1]!.url.searchParams.get('cursor')).toBe('abc');
      expect(seen[1]!.url.searchParams.get('limit')).toBe('100');
      expect(new Headers(seen[1]!.init!.headers).get('x-peaket-internal-token')).toBe('int-token');
    });
    // 끝 페이지: 원천의 null을 그대로 준다
    await withFetch({ ...page, nextCursor: null }, async () => {
      const source = new HttpAttendeeSource({ url: 'https://purchase.test', token: 'int-token' });
      expect((await source.list('tenant', EVENT, 100, 'abc')).nextCursor).toBeNull();
    });
    // 거른 뒤 0건인 페이지에도 다음 커서가 있으면 그대로 준다
    await withFetch({ ...page, items: [], nextCursor: 'after-filter' }, async () => {
      const source = new HttpAttendeeSource({ url: 'https://purchase.test', token: 'int-token' });
      expect(await source.list('tenant', EVENT, 100)).toEqual({ items: [], nextCursor: 'after-filter' });
    });
  });

  test('A2-17 HttpAttendeeSource는 응답 모양이 틀리면 실패한다', async () => {
    const { nextCursor: _drop, ...noCursor } = page;
    const bad: unknown[] = [noCursor, { ...page, nextCursor: 5 }, { ...page, items: {} }];
    for (const body of bad) {
      await withFetch(body, async () => {
        const source = new HttpAttendeeSource({ url: 'https://purchase.test', token: 'int-token' });
        await expect(source.list('tenant', EVENT, 100), JSON.stringify(body)).rejects.toThrow('예매자 명단 원천 응답 모양이 틀렸다');
      });
    }
  });
});
