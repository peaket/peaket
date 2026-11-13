// 예매 취소 Saga의 purchase DB 어댑터(GAT-080, docs/data.md order_cancellation).
// 주문·티켓·좌석은 purchase DB에서 읽고, 취소 행은 한 트랜잭션에 쓴다. 좌석 되돌리기는 inventory의 SeatSales를 쓴다.
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '@peaket/platform';
import { and, eq, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { SeatMap, SeatSales } from '../../../inventory/index.js';
import type { CancellationOrderView, CancellationReason, CancellationRecord, CancellationWriteOutcome, DueRefund } from '../../domain/cancellation.js';
import type { CancellationConfigs, CancellationOrders, CancellationWrites, SeatReturnNotices, SeatReturns } from '../../domain/ports.js';
import { DrizzleOrderStore, orderCancellation, orderItem, purchaseOrder } from '../../../booking/index.js';

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

  async findCancellation(cancellationId: string): Promise<CancellationRecord | undefined> {
    const [row] = await this.database.db
      .select({
        cancellationId: orderCancellation.id,
        orderId: orderCancellation.orderId,
        ticketId: orderCancellation.ticketId,
        refundAmount: orderCancellation.refundAmount,
        state: orderCancellation.status,
        refundAttempts: orderCancellation.refundAttempts,
      })
      .from(orderCancellation)
      .where(eq(orderCancellation.id, cancellationId))
      .limit(1);
    return row ? { ...row, state: row.state as CancellationRecord['state'] } : undefined;
  }
}

/** order_cancellation 쓰기. 같은 취소 ID는 REPLAYED, 같은 티켓의 다른 진행 중 취소는 CONFLICT다 */
@Injectable()
export class DrizzleCancellationWrites implements CancellationWrites {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject('REFUND_ORDER_STORE') private readonly orders: DrizzleOrderStore,
  ) {}

  async create(q: Parameters<CancellationWrites['create']>[0]): Promise<CancellationWriteOutcome> {
    return this.database.transaction(async (tx) => {
      // 주문 행을 잠가 같은 티켓의 두 요청이 겹치지 않게 한다
      const [order] = await tx.select({ id: purchaseOrder.id, status: purchaseOrder.status }).from(purchaseOrder).where(eq(purchaseOrder.id, q.orderId)).for('no key update');
      if (!order) return { status: 'CONFLICT' } as const;
      const [same] = await tx.select().from(orderCancellation).where(eq(orderCancellation.id, q.cancellationId)).limit(1);
      if (same) {
        return {
          status: 'REPLAYED',
          cancellationId: same.id,
          refundAmount: same.refundAmount,
          state: same.status as 'REQUESTED' | 'REFUND_PENDING' | 'REFUNDED' | 'VOIDED',
          refundAfterEntryClose: same.status === 'REQUESTED',
          refundAttempts: same.refundAttempts,
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
      // 부분 환불·전액 환불을 주문 상태(T22~T25)와 이력·Outbox에 남긴다. 아직 환급이 끝나지 않은 취소가 있으면
      // 전액 취소라도 REFUNDED가 아니라 PARTIALLY_REFUNDED다(환급 성공 때 updateStatus가 T23/T24로 마무리한다)
      const counts = await tx.execute(sql`
        select (select count(*)::int from order_item where order_id = ${q.orderId}::uuid) as total,
               (select count(*)::int from order_cancellation where order_id = ${q.orderId}::uuid and status <> 'VOIDED') as cancelled,
               (select count(*)::int from order_cancellation where order_id = ${q.orderId}::uuid and status = 'REFUNDED') as refunded`);
      const total = Number((counts.rows[0] as { total: number | string }).total);
      const cancelled = Number((counts.rows[0] as { cancelled: number | string }).cancelled);
      const refunded = Number((counts.rows[0] as { refunded: number | string }).refunded);
      const transition = orderTransitionAfterCancel(order.status, total, cancelled, refunded);
      if (transition !== undefined) {
        const applied = await this.orders.transition(tx, { orderId: q.orderId, transition, actor: q.actor });
        if (applied.status !== 'APPLIED') throw new Error(`주문 상태 전이에 실패했다: ${transition} ${applied.reason}`);
      }
      return { status: 'CREATED' } as const;
    });
  }

  async updateStatus(q: { readonly cancellationId: string; readonly status: 'REQUESTED' | 'REFUND_PENDING' | 'REFUNDED' | 'VOIDED'; readonly nowMs: number }): Promise<void> {
    await this.database.transaction(async (tx) => {
      const [row] = await tx
        .select({ orderId: orderCancellation.orderId })
        .from(orderCancellation)
        .where(eq(orderCancellation.id, q.cancellationId))
        .limit(1);
      if (!row) return;
      // 잠금 차례는 create와 같게 주문 행을 먼저 잡는다(취소 행 → 주문 행으로 잡으면 create와 엇갈려 교착이 날 수 있다)
      const [order] = await tx.select({ id: purchaseOrder.id, status: purchaseOrder.status }).from(purchaseOrder).where(eq(purchaseOrder.id, row.orderId)).for('no key update');
      if (!order) return;
      await tx
        .update(orderCancellation)
        .set({ status: q.status, statusChangedAt: new Date(q.nowMs), nextRefundAt: null })
        .where(eq(orderCancellation.id, q.cancellationId));
      if (q.status !== 'REFUNDED') return;
      // 모든 항목의 취소가 환급으로 끝났으면 주문을 REFUNDED(T23·T24)로 마무리한다
      const counts = await tx.execute(sql`
        select (select count(*)::int from order_item where order_id = ${row.orderId}::uuid) as total,
               (select count(*)::int from order_cancellation where order_id = ${row.orderId}::uuid and status <> 'VOIDED') as cancelled,
               (select count(*)::int from order_cancellation where order_id = ${row.orderId}::uuid and status = 'REFUNDED') as refunded`);
      const total = Number((counts.rows[0] as { total: number | string }).total);
      const cancelled = Number((counts.rows[0] as { cancelled: number | string }).cancelled);
      const refunded = Number((counts.rows[0] as { refunded: number | string }).refunded);
      const transition = orderTransitionAfterCancel(order.status, total, cancelled, refunded);
      if (transition !== undefined) {
        const applied = await this.orders.transition(tx, { orderId: row.orderId, transition, actor: 'system:cancellation-refund' });
        if (applied.status !== 'APPLIED') throw new Error(`주문 상태 전이에 실패했다: ${transition} ${applied.reason}`);
      }
    });
  }

  async scheduleRefundRetry(q: { readonly cancellationId: string; readonly attempts: number; readonly nextRetryAtMs: number; readonly lastError: string; readonly nowMs: number }): Promise<void> {
    await this.database.db
      .update(orderCancellation)
      .set({
        status: 'REFUND_PENDING',
        refundAttempts: q.attempts,
        nextRefundAt: new Date(q.nextRetryAtMs),
        refundLastError: q.lastError,
        statusChangedAt: new Date(q.nowMs),
      })
      .where(eq(orderCancellation.id, q.cancellationId));
  }

  async markRefundFailed(q: { readonly cancellationId: string; readonly attempts: number; readonly lastError: string; readonly nowMs: number }): Promise<void> {
    await this.database.db
      .update(orderCancellation)
      .set({
        status: 'REFUND_PENDING',
        refundAttempts: q.attempts,
        nextRefundAt: null,
        refundFailedAt: new Date(q.nowMs),
        refundLastError: q.lastError,
        statusChangedAt: new Date(q.nowMs),
      })
      .where(eq(orderCancellation.id, q.cancellationId));
  }

  async dueRefunds(nowMs: number, limit: number): Promise<readonly DueRefund[]> {
    const now = new Date(nowMs);
    const rows = await this.database.db
      .select({
        cancellationId: orderCancellation.id,
        orderId: orderCancellation.orderId,
        amount: orderCancellation.refundAmount,
        reason: orderCancellation.reason,
        status: orderCancellation.status,
        attempts: orderCancellation.refundAttempts,
        refundDueAt: orderCancellation.refundDueAt,
        nextRefundAt: orderCancellation.nextRefundAt,
        createdAt: orderCancellation.createdAt,
      })
      .from(orderCancellation)
      .where(
        and(
          isNull(orderCancellation.refundFailedAt),
          or(
            and(eq(orderCancellation.status, 'REQUESTED'), lte(orderCancellation.refundDueAt, now)),
            and(eq(orderCancellation.status, 'REFUND_PENDING'), or(isNull(orderCancellation.nextRefundAt), lte(orderCancellation.nextRefundAt, now))),
          ),
        ),
      )
      .orderBy(sql`coalesce(${orderCancellation.nextRefundAt}, ${orderCancellation.refundDueAt}, ${orderCancellation.createdAt})`)
      .limit(limit);
    return rows.map((r) => ({
      cancellationId: r.cancellationId,
      orderId: r.orderId,
      amount: r.amount,
      reason: r.reason as CancellationReason,
      status: r.status as 'REQUESTED' | 'REFUND_PENDING',
      attempts: r.attempts,
    }));
  }
}

/** 취소 뒤 주문 상태 전이. 모든 항목이 취소됐으면 REFUNDED, 아니면 PARTIALLY_REFUNDED */
export function orderTransitionAfterCancel(status: string, total: number, cancelled: number, refunded = 0): 'T22' | 'T23' | 'T24' | 'T25' | undefined {
  if (total <= 0) return undefined;
  const all = cancelled >= total;
  const allRefunded = all && refunded >= total;
  if (status === 'CONFIRMED') return allRefunded ? 'T24' : 'T22';
  if (status === 'PARTIALLY_REFUNDED') return allRefunded ? 'T23' : 'T25';
  return undefined;
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
