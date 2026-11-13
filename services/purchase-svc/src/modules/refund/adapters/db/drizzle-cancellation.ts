// 예매 취소 Saga의 purchase DB 어댑터(GAT-080, docs/data.md order_cancellation).
// 주문·티켓·좌석은 purchase DB에서 읽고, 취소 행은 한 트랜잭션에 쓴다. 좌석 되돌리기는 inventory의 SeatSales를 쓴다.
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '@peaket/platform';
import { and, eq, lte, ne } from 'drizzle-orm';
import type { SeatMap, SeatSales } from '../../../inventory/index.js';
import type { CancellationOrderView, CancellationReason, CancellationWriteOutcome } from '../../domain/cancellation.js';
import type { CancellationConfigs, CancellationOrders, CancellationWrites, SeatReturnNotices, SeatReturns } from '../../domain/ports.js';
import { orderCancellation, orderItem, purchaseOrder } from '../../../booking/index.js';

/** 주문·항목·회차 설정을 읽는 어댑터. 티켓 ID로 주문 한 장을 찾는다 */
@Injectable()
export class DrizzleCancellationOrders implements CancellationOrders {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject('REFUND_CANCELLATION_CONFIGS') private readonly configs: CancellationConfigs,
  ) {}

  async findByTicket(ticketId: string): Promise<CancellationOrderView | undefined> {
    const [row] = await this.database.db
      .select({
        orderId: purchaseOrder.id,
        eventId: purchaseOrder.eventId,
        accountId: purchaseOrder.accountId,
        status: purchaseOrder.status,
        createdAt: purchaseOrder.createdAt,
        ticketId: orderItem.ticketId,
        seatId: orderItem.seatId,
        unitPrice: orderItem.unitPrice,
      })
      .from(orderItem)
      .innerJoin(purchaseOrder, eq(orderItem.orderId, purchaseOrder.id))
      .where(eq(orderItem.ticketId, ticketId))
      .limit(1);
    if (!row || row.ticketId === null) return undefined;
    const config = await this.configs.config(row.eventId);
    if (!config) return undefined;
    return {
      orderId: row.orderId,
      eventId: row.eventId,
      ticketId: row.ticketId,
      seatId: row.seatId,
      payerAccountId: row.accountId,
      ticketPrice: row.unitPrice,
      bookedAtMs: row.createdAt.getTime(),
      saleEndsAtMs: config.saleEndsAtMs,
      ...(config.entryOpensAtMs !== undefined ? { entryOpensAtMs: config.entryOpensAtMs } : {}),
      orderStatus: row.status,
    };
  }
}

/** order_cancellation 쓰기. 같은 취소 ID는 REPLAYED, 같은 티켓의 다른 진행 중 취소는 CONFLICT다 */
@Injectable()
export class DrizzleCancellationWrites implements CancellationWrites {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async create(q: Parameters<CancellationWrites['create']>[0]): Promise<CancellationWriteOutcome> {
    return this.database.transaction(async (tx) => {
      // 주문 행을 잠가 같은 티켓의 두 요청이 겹치지 않게 한다
      const [order] = await tx.select({ id: purchaseOrder.id }).from(purchaseOrder).where(eq(purchaseOrder.id, q.orderId)).for('no key update');
      if (!order) return { status: 'CONFLICT' } as const;
      const [same] = await tx.select().from(orderCancellation).where(eq(orderCancellation.id, q.cancellationId)).limit(1);
      if (same) {
        return {
          status: 'REPLAYED',
          cancellationId: same.id,
          refundAmount: same.refundAmount,
          state: same.status as 'REQUESTED' | 'REFUND_PENDING' | 'REFUNDED' | 'VOIDED',
          refundAfterEntryClose: same.status === 'REQUESTED',
        } as const;
      }
      const [active] = await tx
        .select({ id: orderCancellation.id })
        .from(orderCancellation)
        .where(and(eq(orderCancellation.orderId, q.orderId), eq(orderCancellation.ticketId, q.ticketId), ne(orderCancellation.status, 'VOIDED')))
        .limit(1);
      if (active) return { status: 'CONFLICT' } as const;
      const now = new Date(q.nowMs);
      await tx.insert(orderCancellation).values({
        id: q.cancellationId,
        orderId: q.orderId,
        ticketId: q.ticketId,
        reason: q.reason,
        daysBefore: q.daysBefore,
        within24h: q.within24h,
        deductionBp: q.deductionBp,
        deductionAmount: q.deductionAmount,
        refundAmount: q.refundAmount,
        status: q.status,
        ...(q.refundDueAtMs !== undefined ? { refundDueAt: new Date(q.refundDueAtMs) } : {}),
        createdAt: now,
        statusChangedAt: now,
      });
      return { status: 'CREATED' } as const;
    });
  }

  async updateStatus(q: { readonly cancellationId: string; readonly status: 'REQUESTED' | 'REFUND_PENDING' | 'REFUNDED' | 'VOIDED'; readonly nowMs: number }): Promise<void> {
    await this.database.db
      .update(orderCancellation)
      .set({ status: q.status, statusChangedAt: new Date(q.nowMs) })
      .where(eq(orderCancellation.id, q.cancellationId));
  }

  async dueRefunds(nowMs: number, limit: number): Promise<readonly { cancellationId: string; orderId: string; amount: number; reason: CancellationReason }[]> {
    const rows = await this.database.db
      .select({ cancellationId: orderCancellation.id, orderId: orderCancellation.orderId, amount: orderCancellation.refundAmount, reason: orderCancellation.reason })
      .from(orderCancellation)
      .where(and(eq(orderCancellation.status, 'REQUESTED'), lte(orderCancellation.refundDueAt, new Date(nowMs))))
      .limit(limit);
    return rows.map((r) => ({ ...r, reason: r.reason as CancellationReason }));
  }
}

/** 좌석 DB 되돌리기. inventory SeatSales.returnSold가 seat_sale RETURNED·purchase_quota 감소를 한 트랜잭션에 한다 */
@Injectable()
export class DrizzleSeatReturns implements SeatReturns {
  constructor(
    @Inject('REFUND_SEAT_SALES') private readonly sales: SeatSales,
    @Inject('REFUND_SEAT_MAP') private readonly seatMap: SeatMap,
    @Inject('REFUND_SEAT_NOTICES') private readonly notices?: SeatReturnNotices,
  ) {}

  async returnSold(q: { readonly eventId: string; readonly orderId: string; readonly seatId: string; readonly accountId: string; readonly saleEndsAtMs: number }): Promise<number> {
    const [seat] = await this.seatMap.resolve(q.eventId, [q.seatId]);
    if (!seat) throw new Error('좌석맵에서 취소 좌석을 찾지 못했다');
    const changed = await this.sales.returnSold({ eventId: q.eventId, orderId: q.orderId, seatIds: [q.seatId], accountId: q.accountId });
    // 비트맵·델타는 DB가 RETURNED로 바뀐 뒤에만 한다. Redis가 실패하면 취소 행을 만들지 않아 같은 취소 ID의 재시도가 둘을 다시 한다
    if (this.notices) await this.notices.returnSold({ eventId: q.eventId, seats: [seat], keepUntilMs: q.saleEndsAtMs + 24 * 60 * 60_000 });
    return changed;
  }
}
