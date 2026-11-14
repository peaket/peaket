// 시험·로컬용 예매 제한 사본. RedisBookingRestrictions와 같은 판정을 메모리에서 한다.
import type { BookingRestrictionApply, BookingRestrictionCopy } from '../domain/booking-restriction.js';
import type { BookingRestrictions } from '../domain/ports.js';

export class MemoryBookingRestrictions implements BookingRestrictions {
  readonly rows = new Map<string, BookingRestrictionCopy>();
  failWith: unknown;

  async apply(i: BookingRestrictionApply): Promise<{ changed: boolean }> {
    if (this.failWith !== undefined) throw this.failWith;
    const current = this.rows.get(i.accountId);
    if (current?.ver !== undefined && current.ver >= i.version) return { changed: false };
    this.rows.set(i.accountId, {
      st: i.state,
      ...(i.untilMs !== undefined ? { untilMs: i.untilMs } : {}),
      rid: i.restrictionId,
      ver: i.version,
    });
    return { changed: true };
  }

  async read(accountId: string): Promise<BookingRestrictionCopy | undefined> {
    if (this.failWith !== undefined) throw this.failWith;
    const r = this.rows.get(accountId);
    return r ? { ...r } : undefined;
  }
}
