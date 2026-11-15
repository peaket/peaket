// A2-17 회귀: 내보내기는 한 번에 500,001행을 요청하지 않고 1,000행 페이지를 커서로 이어 읽는다.
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
const reauth: BookersReauth = { verify: async () => ({ accountId: ACCOUNT, factors: ['passkey'] }) };

const makeRows = (n: number): AttendeeRecord[] =>
  Array.from({ length: n }, (_, i) => ({
    orderId: `order-${String(i).padStart(7, '0')}`,
    eventId: EVENT,
    buyerName: `구매자${i}`,
    buyerPhone: '010-1234-5678',
    seatLabel: `A-${i}`,
    quantity: 1,
  }));

function pagingSource(all: AttendeeRecord[]): AttendeeSource & { limits: number[]; cursors: (string | undefined)[] } {
  const limits: number[] = [];
  const cursors: (string | undefined)[] = [];
  return {
    limits,
    cursors,
    async list(_p, _e, limit, cursor) {
      limits.push(limit);
      cursors.push(cursor);
      const start = cursor ? Number(Buffer.from(cursor, 'base64url').toString().replace('order-', '')) + 1 : 0;
      return all.slice(start, start + limit);
    },
    async count() {
      return { bookings: all.length, tickets: all.length };
    },
  };
}

const app = (s: AttendeeSource): AttendeeExports => {
  const events = new MemoryPartnerEventLookup();
  events.add(TENANT, EVENT, 'LUMEN', new Date('2026-12-01T00:00:00Z'));
  return new AttendeeExports({ store: new MemoryAttendeeExportStore(), attendees: s, events, reauth, actors: new MemoryActorNames(), clock });
};

const actor = { accountId: ACCOUNT, sessionId: 's-1', role: 'partner_admin' };

describe('A2-17 내보내기 페이지 상한', () => {
  test('2,500행도 1,000행 이하 페이지로만 읽고 건수를 잃지 않는다', async () => {
    const s = pagingSource(makeRows(2_500));
    const out = await app(s).create(TENANT, EVENT, actor, 'token', { reason: '페이지 상한', format: 'CSV' });
    expect(s.limits).toEqual([1_000, 1_000, 1_000]);
    expect(s.limits.every((n) => n <= 1_000)).toBe(true);
    expect(s.cursors).toEqual([undefined, Buffer.from('order-0000999').toString('base64url'), Buffer.from('order-0001999').toString('base64url')]);
    expect(out.record.count).toBe(2_500);
  });

  test('정확히 1,000행이면 다음 빈 페이지로 끝내고 중복을 만들지 않는다', async () => {
    const s = pagingSource(makeRows(1_000));
    const out = await app(s).create(TENANT, EVENT, actor, 'token', { reason: '경계', format: 'CSV' });
    expect(s.limits).toEqual([1_000, 1_000]);
    expect(out.record.count).toBe(1_000);
    const text = new TextDecoder().decode(out.file.body);
    expect(text.match(/order-/g)).toHaveLength(1_000);
  });
});
