// 계좌 입력 요청 훑기의 Drizzle 원천(F-07-15 I-02, purchase 0039).
// 계좌 대기 취소와 배상 대기 행을 읽고, count+1·next_at과 Outbox를 한 트랜잭션에 쓴다.
import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { DATABASE, type Clock, type Database, writeOutbox } from '@peaket/platform';
import { orderCancellation, purchaseOrder } from '../../../booking/index.js';
import type { AccountNoticeRow, AccountNoticeSource } from '../../domain/account-request.js';
import type { EventRefundOutboxMessage } from '../../domain/event-refund-ports.js';
import { compensation } from './schema.js';

export class DrizzleAccountNoticeSource implements AccountNoticeSource {
  constructor(
    private readonly database: Database,
    private readonly clock: Clock,
    private readonly kind: 'REFUND' | 'COMPENSATION',
  ) {}

  async listDue(nowMs: number, limit: number): Promise<readonly AccountNoticeRow[]> {
    const now = new Date(nowMs);
    if (this.kind === 'REFUND') {
      const rows = await this.database.db
        .select({
          id: orderCancellation.id,
          orderId: orderCancellation.orderId,
          eventId: purchaseOrder.eventId,
          accountId: purchaseOrder.accountId,
          amount: orderCancellation.refundAmount,
          requiredAtMs: sql<Date>`${orderCancellation.refundAccountRequiredAt}`,
          sentCount: orderCancellation.refundAccountNoticeCount,
          nextAtMs: orderCancellation.refundAccountNoticeNextAt,
        })
        .from(orderCancellation)
        .innerJoin(purchaseOrder, eq(purchaseOrder.id, orderCancellation.orderId))
        .where(
          and(
            eq(orderCancellation.status, 'REFUND_PENDING'),
            isNull(orderCancellation.refundFailedAt),
            sql`${orderCancellation.refundAccountRequiredAt} is not null`,
            lte(orderCancellation.refundAccountNoticeNextAt, now),
          ),
        )
        .limit(limit);
      return rows.map((r) => {
        const { nextAtMs, ...rest } = r;
        return { ...rest, requiredAtMs: new Date(r.requiredAtMs).getTime(), ...(nextAtMs ? { nextAtMs: new Date(nextAtMs).getTime() } : {}) };
      });
    }
    const rows = await this.database.db
      .select({
        id: compensation.id,
        orderId: compensation.orderId,
        eventId: compensation.eventId,
        accountId: compensation.accountId,
        amount: compensation.amount,
        requiredAtMs: sql<Date>`${compensation.createdAt}`,
        sentCount: compensation.accountNoticeCount,
        nextAtMs: compensation.accountNoticeNextAt,
      })
      .from(compensation)
      .where(and(eq(compensation.status, 'ACCOUNT_PENDING'), lte(compensation.accountNoticeNextAt, now)))
      .limit(limit);
    return rows.map((r) => {
      const { nextAtMs, ...rest } = r;
      return { ...rest, requiredAtMs: new Date(r.requiredAtMs).getTime(), ...(nextAtMs ? { nextAtMs: new Date(nextAtMs).getTime() } : {}) };
    });
  }

  async claim(i: { id: string; expectedCount: number; nextAtMs: number; outbox: EventRefundOutboxMessage; nowMs: number }): Promise<boolean> {
    const nextAt = new Date(i.nextAtMs);
    return this.database.transaction(async (tx) => {
      if (this.kind === 'REFUND') {
        const rows = await tx
          .update(orderCancellation)
          .set({ refundAccountNoticeCount: sql`${orderCancellation.refundAccountNoticeCount} + 1`, refundAccountNoticeNextAt: nextAt })
          .where(
            and(
              eq(orderCancellation.id, i.id),
              eq(orderCancellation.refundAccountNoticeCount, i.expectedCount),
              eq(orderCancellation.status, 'REFUND_PENDING'),
              sql`${orderCancellation.refundAccountRequiredAt} is not null`,
            ),
          )
          .returning({ id: orderCancellation.id });
        if (rows.length === 0) return false;
      } else {
        const rows = await tx
          .update(compensation)
          .set({ accountNoticeCount: sql`${compensation.accountNoticeCount} + 1`, accountNoticeNextAt: nextAt })
          .where(and(eq(compensation.id, i.id), eq(compensation.accountNoticeCount, i.expectedCount), eq(compensation.status, 'ACCOUNT_PENDING')))
          .returning({ id: compensation.id });
        if (rows.length === 0) return false;
      }
      await writeOutbox(tx, this.clock, [{ topic: i.outbox.topic, key: i.outbox.key, payload: i.outbox.payload }]);
      return true;
    });
  }
}
