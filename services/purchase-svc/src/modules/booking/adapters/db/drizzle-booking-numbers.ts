// F-06-8 예매번호 일련번호 어댑터: purchase DB `booking_no_sequence`(ADR-0388).
// 주문 생성 트랜잭션 안에서 `INSERT … ON CONFLICT (day) DO UPDATE … RETURNING`으로 원자적으로 잡는다.
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { BOOKING_NO_MAX, kstDayOf } from '../../domain/booking-number.js';
import type { BookingNumberAllocation, BookingNumbers } from '../../domain/ports.js';

export class DrizzleBookingNumbers implements BookingNumbers {
  constructor(private readonly db: Database) {}

  async next(nowMs: number): Promise<BookingNumberAllocation> {
    const day = kstDayOf(nowMs);
    const r = await this.db.db.execute(sql`
      insert into booking_no_sequence (day, next) values (${day}::date, 1)
      on conflict (day) do update set next = booking_no_sequence.next + 1
      returning next`);
    const row = (r as unknown as { rows: { next: number | string }[] }).rows[0];
    const next = Number(row?.next);
    if (!Number.isInteger(next)) throw new Error('예매번호 일련번호를 읽지 못했습니다');
    return next > BOOKING_NO_MAX ? { exhausted: true } : { seq: next };
  }
}
