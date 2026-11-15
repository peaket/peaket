// A2-03 회귀: 예매자 명단은 굿즈 주문이 아니라 purchase-svc 원천을 쓰고, 좌석 등급을 원천 값으로 옮긴다.
// 운영(database) 조립에서 purchaseHttp가 없으면 굿즈 대역으로 되돌아가지 않고 503으로 닫힌다.
// W7-audit A2-17: 원천은 { items, nextCursor } 페이지이고, 메모리 조립의 명단 원천도 다음 주문이 있을 때만 nextCursor를 준다.
import { fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { AttendeeExports } from '../src/modules/export/application/attendee-exports.js';
import { ExportModule } from '../src/modules/export/export.module.js';
import { ATTENDEE_SOURCE } from '../src/modules/export/domain/ports.js';
import type { AttendeeSource, BookersReauth } from '../src/modules/export/domain/ports.js';
import { HttpAttendeeSource } from '../src/modules/export/adapters/http-attendee-source.js';
import { MemoryActorNames, MemoryAttendeeExportStore, MemoryPartnerEventLookup } from '../src/modules/export/index.js';
import { MemoryMerchOrderStore, type AttendeeRecord, type MerchOrderItemRecord, type MerchOrderRecord } from '../src/modules/shop/index.js';

const TENANT = randomUUID();
const EVENT = randomUUID();
const ACCOUNT = randomUUID();
const clock = fakeClock({ now: Date.parse('2026-11-15T00:00:00Z') });
const reauth: BookersReauth = { verify: async () => ({ accountId: ACCOUNT, factors: ['passkey'] }) };

const source = (rows: AttendeeRecord[]): AttendeeSource => ({
  list: async () => ({ items: rows, nextCursor: null }),
  count: async () => ({ bookings: rows.length, tickets: rows.reduce((s, r) => s + r.quantity, 0) }),
});

function sourceFactory(mod: ReturnType<typeof ExportModule.register>): AttendeeSource {
  const provider = (mod.providers ?? []).find((p) => typeof p === 'object' && p !== null && 'provide' in p && p.provide === ATTENDEE_SOURCE) as
    | { useFactory: (...args: unknown[]) => AttendeeSource }
    | undefined;
  expect(provider).toBeDefined();
  return provider!.useFactory({}, {});
}

describe('A2-03 예매자 명단 원천', () => {
  test('좌석 등급은 원천의 seats를 쓰고 GOODS로 덮지 않는다', async () => {
    const seats = [
      { seatLabel: 'VIP-1', tier: 'VIP' },
      { seatLabel: 'R-2', tier: 'R' },
    ];
    const events = new MemoryPartnerEventLookup();
    events.add(TENANT, EVENT, 'LUMEN', new Date('2026-12-01T00:00:00Z'));
    const app = new AttendeeExports({
      store: new MemoryAttendeeExportStore(),
      attendees: source([{ orderId: randomUUID(), eventId: EVENT, buyerName: '김민수', buyerPhone: '010-1234-5678', seatLabel: 'VIP-1, R-2', quantity: 2, seats }]),
      events,
      reauth,
      actors: new MemoryActorNames(),
      clock,
    });

    const page = await app.listAttendees(TENANT, EVENT, { limit: 50 }, { accountId: ACCOUNT, sessionId: 's-1', role: 'partner_admin' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ seats, ticketCount: 2, buyerNameMasked: '김*수', buyerPhoneMasked: '010-****-5678' });
    expect(JSON.stringify(page)).not.toContain('GOODS');
  });

  test('운영 조립에서 purchaseHttp가 없으면 굿즈 대역이 아니라 503 dependency-unavailable로 닫힌다', async () => {
    const mod = ExportModule.register({ storage: 'database', database: {} as never, partnerDatabase: {} as never });
    const closed = sourceFactory(mod);
    const closedStatus = async (p: () => Promise<unknown>): Promise<unknown> => {
      try {
        await p();
        return 'OK';
      } catch (e) {
        return e;
      }
    };
    expect(await closedStatus(() => closed.list(TENANT, EVENT, 10))).toMatchObject({ status: 503, type: 'dependency-unavailable' });
    expect(await closedStatus(() => closed.count(TENANT, EVENT))).toMatchObject({ status: 503, type: 'dependency-unavailable' });
  });

  test('purchaseHttp가 있으면 HttpAttendeeSource를 쓰고, limit은 1,000으로 자른다', async () => {
    let seenUrl: URL | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      seenUrl = new URL(url);
      return new Response(JSON.stringify({ items: [], nextCursor: null, bookingCount: 0, ticketCount: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const mod = ExportModule.register({
        storage: 'database',
        database: {} as never,
        partnerDatabase: {} as never,
        purchaseHttp: { url: 'https://purchase.test', token: 'internal-token' },
      });
      const wired = sourceFactory(mod);
      expect(wired).toBeInstanceOf(HttpAttendeeSource);

      await wired.list(TENANT, EVENT, 5_000, 'cursor-1');
      expect(seenUrl?.pathname).toBe(`/internal/v1/events/${EVENT}/attendees`);
      expect(seenUrl?.searchParams.get('limit')).toBe('1000');
      expect(seenUrl?.searchParams.get('cursor')).toBe('cursor-1');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('HttpAttendeeSource는 seats[].tier를 원천 값으로 보존하고 내부 토큰 헤더를 보낸다', async () => {
    const seats = [
      { seatLabel: 'VIP-1', tier: 'VIP' },
      { seatLabel: 'R-2', tier: 'R' },
    ];
    let seen: RequestInit | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response(JSON.stringify({ items: [{ orderId: randomUUID(), eventId: EVENT, buyerName: '김민수', buyerPhone: '010-1234-5678', seats, ticketCount: 2 }], nextCursor: null, bookingCount: 1, ticketCount: 2 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const source = new HttpAttendeeSource({ url: 'https://purchase.test', token: 'secret-internal-token' });
      const got = await source.list(TENANT, EVENT, 500);
      expect(got.items[0]?.seats).toEqual(seats);
      expect(got.items[0]?.seatLabel).toBe('VIP-1, R-2');
      expect(got.items[0]?.quantity).toBe(2);
      expect(new Headers(seen?.headers).get('x-peaket-internal-token')).toBe('secret-internal-token');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('토큰 없이 부른 원천이 503이면 HttpAttendeeSource가 실패를 숨기지 않는다', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('unavailable', { status: 503 })) as typeof fetch;
    try {
      const source = new HttpAttendeeSource({ url: 'https://purchase.test' });
      await expect(source.list(TENANT, EVENT, 100)).rejects.toThrow(/503/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('A2-17 메모리 명단 원천', () => {
  const order = (orderId: string): MerchOrderRecord => ({
    orderId,
    promoterId: TENANT,
    eventId: EVENT,
    buyerName: '김민수',
    buyerPhone: '010-1234-5678',
    status: 'PAID',
    pg: 'TOSS',
    pgStore: 'STANDARD',
    shippingFee: 0,
    purchaseConfirmedAt: null,
    orderedAt: new Date('2026-10-19T00:00:00Z'),
  });
  const item = (orderId: string, seatLabel: string): MerchOrderItemRecord => ({
    itemId: randomUUID(),
    orderId,
    promoterId: TENANT,
    eventId: EVENT,
    productId: randomUUID(),
    productName: '응원봉',
    quantity: 1,
    unitAmount: 15_000,
    commissionRateBp: 1000,
    status: 'DELIVERED',
    fulfillment: 'DELIVERY',
    seatLabel,
    shippedAt: null,
    deliveredAt: null,
    pickedUpAt: null,
    returnRequestedAt: null,
    returnResolvedAt: null,
    refundedAmount: 0,
    eventEndsAt: null,
    ticketLinked: false,
  });

  test('A2-17 메모리 명단 원천은 다음 주문이 있을 때만 nextCursor를 준다', async () => {
    const store = new MemoryMerchOrderStore();
    const ids = ['order-a', 'order-b', 'order-c'];
    for (const [i, id] of ids.entries()) await store.insertOrder(order(id), [item(id, `A-${i + 1}`)]);

    const first = await store.listAttendees(TENANT, EVENT, 2);
    expect(first.items.map((r) => r.orderId)).toEqual(['order-a', 'order-b']);
    expect(first.nextCursor).toBe(Buffer.from('order-b').toString('base64url'));

    const second = await store.listAttendees(TENANT, EVENT, 2, first.nextCursor!);
    expect(second.items.map((r) => r.orderId)).toEqual(['order-c']);
    expect(second.nextCursor).toBeNull();

    // 경계: 남은 주문이 정확히 limit건이면 다음 커서가 없다
    const all = await store.listAttendees(TENANT, EVENT, 3);
    expect(all.items.map((r) => r.orderId)).toEqual(ids);
    expect(all.nextCursor).toBeNull();
  });
});
