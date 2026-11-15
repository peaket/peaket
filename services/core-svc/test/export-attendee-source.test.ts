// A2-03 회귀: 예매자 명단은 굿즈 주문이 아니라 purchase-svc 원천을 쓰고, 좌석 등급을 원천 값으로 옮긴다.
// 운영(database) 조립에서 purchaseHttp가 없으면 굿즈 대역으로 되돌아가지 않고 503으로 닫힌다.
import { fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { AttendeeExports } from '../src/modules/export/application/attendee-exports.js';
import { ExportModule } from '../src/modules/export/export.module.js';
import { ATTENDEE_SOURCE } from '../src/modules/export/domain/ports.js';
import type { AttendeeSource, BookersReauth } from '../src/modules/export/domain/ports.js';
import { HttpAttendeeSource } from '../src/modules/export/adapters/http-attendee-source.js';
import { MemoryActorNames, MemoryAttendeeExportStore, MemoryPartnerEventLookup } from '../src/modules/export/index.js';
import type { AttendeeRecord } from '../src/modules/shop/index.js';

const TENANT = randomUUID();
const EVENT = randomUUID();
const ACCOUNT = randomUUID();
const clock = fakeClock({ now: Date.parse('2026-11-15T00:00:00Z') });
const reauth: BookersReauth = { verify: async () => ({ accountId: ACCOUNT, factors: ['passkey'] }) };

const source = (rows: AttendeeRecord[]): AttendeeSource => ({
  list: async () => rows,
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

    const page = await app.listAttendees(TENANT, EVENT, { limit: 50 });
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
      const rows = await source.list(TENANT, EVENT, 500);
      expect(rows[0]?.seats).toEqual(seats);
      expect(rows[0]?.seatLabel).toBe('VIP-1, R-2');
      expect(rows[0]?.quantity).toBe(2);
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
