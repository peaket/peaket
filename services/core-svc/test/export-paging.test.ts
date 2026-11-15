// A2-17: 내보내기가 1,000행 페이지를 커서로 이어 읽고 페이지 경계에서 행을 잃지 않는지 본다.
import { fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { AttendeeExports } from '../src/modules/export/application/attendee-exports.js';
import { MemoryActorNames, MemoryAttendeeExportStore, MemoryPartnerEventLookup } from '../src/modules/export/index.js';
import type { AttendeeSource, BookersReauth } from '../src/modules/export/domain/ports.js';
import type { AttendeeRecord } from '../src/modules/shop/index.js';

const TENANT = randomUUID();
const EVENT = randomUUID();
const ACCOUNT = randomUUID();
const clock = fakeClock({ now: Date.parse('2026-11-15T00:00:00Z') });

const rows: AttendeeRecord[] = Array.from({ length: 1_500 }, (_, i) => ({
  orderId: `order-${String(i).padStart(6, '0')}`,
  eventId: EVENT,
  buyerName: `구매자${i}`,
  buyerPhone: '010-1234-5678',
  seatLabel: `A-${i}`,
  quantity: 1,
}));

const source = (): AttendeeSource & { calls: (string | undefined)[] } => {
  const calls: (string | undefined)[] = [];
  return {
    calls,
    async list(_p, _e, limit, cursor) {
      calls.push(cursor);
      const start = cursor ? Number(Buffer.from(cursor, 'base64url').toString().replace('order-', '')) + 1 : 0;
      return rows.slice(start, start + limit);
    },
    async count() {
      return { bookings: rows.length, tickets: rows.length };
    },
  };
};

const reauth: BookersReauth = { verify: async () => ({ accountId: ACCOUNT, factors: ['passkey'] }) };

describe('A2-17 내보내기 페이지 경계', () => {
  test('1,500행을 1,000+500으로 이어 읽고 건수를 잃지 않는다', async () => {
    const s = source();
    const events = new MemoryPartnerEventLookup();
    events.add(TENANT, EVENT, 'LUMEN', new Date('2026-12-01T00:00:00Z'));
    const app = new AttendeeExports({ store: new MemoryAttendeeExportStore(), attendees: s, events, reauth, actors: new MemoryActorNames(), clock });
    const out = await app.create(TENANT, EVENT, { accountId: ACCOUNT, sessionId: 's-1', role: 'partner_admin' }, 'token', { reason: '페이지 경계', format: 'CSV' });
    expect(s.calls).toEqual([undefined, Buffer.from(rows[999]!.orderId).toString('base64url')]);
    expect(out.record.count).toBe(1_500);
    expect(out.file.body.byteLength).toBeGreaterThan(0);
  });
});
