// F-06-8 purchase PostgreSQL 통합: 0039 적용, booking_no_sequence ON CONFLICT·99,999, booking_no UNIQUE, notice-view 조회.
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratePurchase } from '../scripts/migrate.mjs';
import { DrizzleBookingNoticeReader, DrizzleBookingNumbers } from '../src/modules/booking/index.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

let pg: PostgresContainer;
let db: Database;

beforeAll(async () => {
  pg = await startPostgres();
  await migratePurchase(pg.url);
  db = createDatabase({ url: pg.url, applicationName: 'f068-booking-int', max: 3 });
}, 180_000);

afterAll(async () => {
  await db?.close();
  pg?.stop();
});

const order = (o: { id?: string; bookingNo?: string | null; status?: string; eventId?: string; phone?: string | null }) => ({
  id: o.id ?? randomUUID(),
  accountId: randomUUID(),
  eventId: o.eventId ?? randomUUID(),
  status: o.status ?? 'CONFIRMED',
  amount: 220_000,
  eventSeq: 1,
  idempotencyKey: randomUUID(),
  consentVersion: 'v1',
  seatAssignment: 'PICK',
  holdId: randomUUID(),
  purchaseSessionId: randomUUID(),
  bookingNo: o.bookingNo ?? null,
  phone: o.phone ?? '+821012345678',
});

async function insertOrder(o: ReturnType<typeof order>): Promise<void> {
  // order_status_has_event 지연 제약: 주문과 이력을 같은 트랜잭션에서 넣는다.
  await db.db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into purchase_order (id, account_id, event_id, status, amount, event_seq, buyer_phone, idempotency_key, consent_version, seat_assignment, created_at, hold_id, purchase_session_id, booking_no)
      values (${o.id}::uuid, ${o.accountId}::uuid, ${o.eventId}::uuid, ${o.status}, ${o.amount}, ${o.eventSeq}, ${o.phone},
              ${o.idempotencyKey}, ${o.consentVersion}, ${o.seatAssignment}, now(), ${o.holdId}::uuid, ${o.purchaseSessionId}, ${o.bookingNo})`);
    await tx.execute(sql`
      insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at)
      values (${o.id}::uuid, ${o.eventSeq}, null, ${o.status}, 'T18', 'system:f068-int', now())`);
  });
}

describe('F-06-8 purchase PostgreSQL', () => {
  test('N-T27 ①·② booking_no_sequence ON CONFLICT·KST 경계·99,999 상한', async () => {
    const numbers = new DrizzleBookingNumbers(db);
    const first = await numbers.next(Date.parse('2026-10-14T03:00:00.000Z'));
    const second = await numbers.next(Date.parse('2026-10-14T03:00:00.000Z'));
    expect(first).toEqual({ seq: 1 });
    expect(second).toEqual({ seq: 2 });

    const before = await numbers.next(Date.parse('2026-10-14T14:59:59.999Z'));
    const after = await numbers.next(Date.parse('2026-10-14T15:00:00.000Z'));
    expect(before).toEqual({ seq: 3 });
    expect(after).toEqual({ seq: 1 });

    await db.db.execute(sql`update booking_no_sequence set next = 99998 where day = '2026-10-15'::date`);
    expect(await numbers.next(Date.parse('2026-10-15T03:00:00.000Z'))).toEqual({ seq: 99_999 });
    expect(await numbers.next(Date.parse('2026-10-15T03:00:00.000Z'))).toEqual({ exhausted: true });
  });

  test('booking_no UNIQUE와 notice-view(Drizzle)가 실제 표에서 읽힌다', async () => {
    const bookingNo = '2026101400001';
    const first = order({ bookingNo });
    await insertOrder(first);
    const dup = order({ bookingNo });
    let code: string | undefined;
    try {
      await insertOrder(dup);
    } catch (e) {
      const x = e as { code?: string; cause?: { code?: string } };
      code = x.code ?? x.cause?.code;
    }
    expect(code).toBe('23505');

    await db.db.execute(sql`
      insert into order_item (order_id, line_no, seat_id, tier, section_id, unit_price)
      values (${first.id}::uuid, 1, ${randomUUID()}::uuid, 'R', 'A', 110000),
             (${first.id}::uuid, 2, ${randomUUID()}::uuid, 'S', 'B', 88000)`);
    const reader = new DrizzleBookingNoticeReader(db);
    const view = await reader.get(first.id);
    expect(view).toMatchObject({ bookingNo, status: 'CONFIRMED', noticeAllowed: true, phoneE164: '+821012345678', eventId: first.eventId });
    expect(view?.tierIds).toEqual(['R', 'S']);

    await db.db.execute(sql`
      insert into order_cancellation (id, order_id, ticket_id, reason, days_before, within_24h, deduction_bp, deduction_amount, refund_amount, status, created_at, status_changed_at)
      values (${randomUUID()}::uuid, ${first.id}::uuid, ${randomUUID()}::uuid, 'USER', 10, false, 0, 0, 0, 'REQUESTED', now(), now())`);
    expect((await reader.get(first.id))?.noticeAllowed).toBe(false);
  });
});
