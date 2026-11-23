// 예매 취소 Saga의 purchase DB 어댑터(GAT-080, docs/data.md order_cancellation).
// 주문·티켓·좌석은 purchase DB에서 읽고, 취소 행은 한 트랜잭션에 쓴다. 좌석 되돌리기는 inventory의 SeatSales를 쓴다.
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database, type DbTransaction, IdempotencyStore } from '@peaket/platform';
import { and, eq, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { SeatMap, SeatSales } from '../../../inventory/index.js';
import type { CancellationOrderView, CancellationReason, CancellationRecord, CancellationWriteOutcome, DueRefund, RefundAccountAnswer } from '../../domain/cancellation.js';
import { REFUND_ACCOUNT_MAX_ATTEMPTS } from '../../domain/cancellation.js';
import type { CancellationClaims, CancellationConfigs, CancellationOrders, CancellationWrites, RefundAccountWrites, SeatReturnNotices, SeatReturns } from '../../domain/ports.js';
import { DrizzleOrderStore, orderCancellation, orderItem, purchaseOrder } from '../../../booking/index.js';

/** 같은 트랜잭션의 시도 올리기가 0행일 때 멱등 키 행까지 되돌리는 표지 */
class BeginAttemptNotApplied extends Error {}

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
        refundAttempt: orderCancellation.refundAttempt,
        accountRequiredAt: orderCancellation.refundAccountRequiredAt,
        refundAccountIdemKey: orderCancellation.refundAccountIdemKey,
        refundAccountAnswer: orderCancellation.refundAccountAnswer,
      })
      .from(orderCancellation)
      .where(eq(orderCancellation.id, cancellationId))
      .limit(1);
    if (!row) return undefined;
    const { accountRequiredAt, refundAccountIdemKey, refundAccountAnswer, ...rest } = row;
    return {
      ...rest,
      state: row.state as CancellationRecord['state'],
      ...(accountRequiredAt ? { refundAccountRequired: true } : {}),
      ...(refundAccountIdemKey !== null ? { refundAccountIdemKey } : {}),
      ...(refundAccountAnswer !== null ? { refundAccountAnswer: refundAccountAnswer as RefundAccountAnswer } : {}),
    };
  }
}

/** order_cancellation 쓰기. 같은 취소 ID는 REPLAYED, 같은 티켓의 다른 진행 중 취소는 CONFLICT다 */
@Injectable()
export class DrizzleCancellationWrites implements CancellationWrites, CancellationClaims, RefundAccountWrites {
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
        ...(q.eventCancellationRequestId !== undefined ? { eventCancellationRequestId: q.eventCancellationRequestId } : {}),
        // 부정 예매 운영자 취소(사유 FRAUD)의 사건·승인(BAT-415 몫 F, ADR-0171)
        ...(q.fraudCaseId !== undefined ? { fraudCaseId: q.fraudCaseId } : {}),
        ...(q.approvalId !== undefined ? { approvalId: q.approvalId } : {}),
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
        // 주문을 REFUNDED로 끝내는 전이(T23·T24)는 그 취소의 환급액을 사건에 싣는다(OrderEvent.refundAmount, F-04-2)
        const applied = await this.orders.transition(tx, { orderId: q.orderId, transition, actor: q.actor, ...(endsRefunded(transition) ? { refundAmount: q.refundAmount } : {}) });
        if (applied.status !== 'APPLIED') throw new Error(`주문 상태 전이에 실패했다: ${transition} ${applied.reason}`);
      }
      return { status: 'CREATED' } as const;
    });
  }

  async updateStatus(q: { readonly cancellationId: string; readonly status: 'REQUESTED' | 'REFUND_PENDING' | 'REFUNDED' | 'VOIDED'; readonly nowMs: number; readonly answer?: { readonly idempotencyKey: string; readonly answer: RefundAccountAnswer } }): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const [row] = await tx
        .select({ orderId: orderCancellation.orderId, refundAmount: orderCancellation.refundAmount })
        .from(orderCancellation)
        .where(eq(orderCancellation.id, q.cancellationId))
        .limit(1);
      if (!row) return false;
      // 잠금 차례는 create와 같게 주문 행을 먼저 잡는다(취소 행 → 주문 행으로 잡으면 create와 엇갈려 교착이 날 수 있다)
      const [order] = await tx.select({ id: purchaseOrder.id, status: purchaseOrder.status }).from(purchaseOrder).where(eq(purchaseOrder.id, row.orderId)).for('no key update');
      if (!order) return false;
      // REFUNDED는 결제사 취소를 보낸 REFUND_PENDING만 바꾼다. 그사이 CS가 무효(VOIDED)로 끝낸 취소를 덮지 않고, 주문 전이(T23·T24)도 하지 않는다(BAT-420 A3).
      // REFUND_PENDING·REQUESTED로는 끝난(환급·무효) 행을 되돌리지 않는다. VOIDED는 CS 몫이라 조건 없이 쓴다
      const guard =
        q.status === 'REFUNDED'
          ? eq(orderCancellation.status, 'REFUND_PENDING')
          : q.status === 'VOIDED'
            ? undefined
            : and(ne(orderCancellation.status, 'REFUNDED'), ne(orderCancellation.status, 'VOIDED'));
      const updated = await tx
        .update(orderCancellation)
        .set({
          status: q.status,
          statusChangedAt: new Date(q.nowMs),
          nextRefundAt: null,
          // 답은 상태 전이와 같은 문장에서 쓴다(재시작·다른 파드 재생, RV-24)
          ...(q.answer === undefined ? {} : { refundAccountAnswer: q.answer.answer }),
        })
        .where(guard ? and(eq(orderCancellation.id, q.cancellationId), guard) : eq(orderCancellation.id, q.cancellationId))
        .returning({ id: orderCancellation.id });
      if (updated.length === 0) return false;
      if (q.status !== 'REFUNDED') return true;
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
        // 이 환급 완료가 주문을 REFUNDED로 끝내면 그 취소의 환급액을 사건에 싣는다(OrderEvent.refundAmount, F-04-2)
        const applied = await this.orders.transition(tx, { orderId: row.orderId, transition, actor: 'system:cancellation-refund', ...(endsRefunded(transition) ? { refundAmount: row.refundAmount } : {}) });
        if (applied.status !== 'APPLIED') throw new Error(`주문 상태 전이에 실패했다: ${transition} ${applied.reason}`);
      }
      return true;
    });
  }

  /** REFUND_PENDING 행에만 다음 재시도를 적는다(그사이 무효·환급으로 끝난 행을 되돌리지 않는다, BAT-420 A3) */
  async scheduleRefundRetry(q: { readonly cancellationId: string; readonly attempts: number; readonly nextRetryAtMs: number; readonly lastError: string; readonly nowMs: number }): Promise<boolean> {
    const updated = await this.database.db
      .update(orderCancellation)
      .set({
        status: 'REFUND_PENDING',
        refundAttempts: q.attempts,
        nextRefundAt: new Date(q.nextRetryAtMs),
        refundLastError: q.lastError,
        statusChangedAt: new Date(q.nowMs),
      })
      .where(and(eq(orderCancellation.id, q.cancellationId), eq(orderCancellation.status, 'REFUND_PENDING')))
      .returning({ id: orderCancellation.id });
    return updated.length > 0;
  }

  /** REFUND_PENDING 행에만 CS 처리함 대상 표시를 남긴다(BAT-420 A3). 계좌 대기 표시와 답은 같은 문장에서 쓴다(RV-24) */
  async markRefundFailed(q: { readonly cancellationId: string; readonly attempts: number; readonly lastError: string; readonly nowMs: number; readonly answer?: { readonly idempotencyKey: string; readonly answer: RefundAccountAnswer } }): Promise<boolean> {
    const updated = await this.database.db
      .update(orderCancellation)
      .set({
        status: 'REFUND_PENDING',
        refundAttempts: q.attempts,
        nextRefundAt: null,
        // 계좌 거절 뒤의 업무 거절은 계좌 대기를 풀고 CS '환급 실패'로 넘긴다
        refundAccountRequiredAt: null,
        refundFailedAt: new Date(q.nowMs),
        refundLastError: q.lastError,
        statusChangedAt: new Date(q.nowMs),
        ...(q.answer === undefined ? {} : { refundAccountAnswer: q.answer.answer }),
      })
      .where(and(eq(orderCancellation.id, q.cancellationId), eq(orderCancellation.status, 'REFUND_PENDING')))
      .returning({ id: orderCancellation.id });
    return updated.length > 0;
  }

  /**
   * 계좌 대기(BUILD_ORDER GAT-090): REFUND_PENDING 행에만 refund_account_required_at을 쓰고(이미 있으면 그대로) next_refund_at을 비운다.
   * 재시도 횟수·실패 표시는 그대로다(재시도·자동 정지 셈 밖, docs/features/payment.md §6 '계좌 대기')
   */
  async markRefundAccountRequired(q: { readonly cancellationId: string; readonly nowMs: number }): Promise<boolean> {
    const updated = await this.database.db
      .update(orderCancellation)
      .set({
        nextRefundAt: null,
        refundAccountRequiredAt: sql`coalesce(${orderCancellation.refundAccountRequiredAt}, ${new Date(q.nowMs)}::timestamptz)`,
        refundLastError: 'REFUND_ACCOUNT_REQUIRED',
        statusChangedAt: new Date(q.nowMs),
      })
      .where(and(eq(orderCancellation.id, q.cancellationId), eq(orderCancellation.status, 'REFUND_PENDING')))
      .returning({ id: orderCancellation.id });
    return updated.length > 0;
  }

  /**
   * 지연 환급 계좌 다시 받기 시도(0030, BAT-425, ADR-0316 결정 4): 취소 행을 잠그고 REFUND_PENDING·계좌 대기·refund_attempt = oldAttempt·
   * 3회 [가정] 미만일 때만 1 올린다. 커밋한 뒤에 부르는 쪽이 결제사를 부른다(결제사를 트랜잭션 안에서 부르지 않는다).
   * 그사이 다른 요청이 올렸으면(조건부 0행) undefined라 동시 두 요청에서 하나만 오른다
   */
  async beginAttempt(q: {
    readonly cancellationId: string;
    readonly oldAttempt: number;
    readonly nowMs: number;
    readonly idempotency?: { readonly accountRef: string; readonly key: string; readonly requestHash: Uint8Array; readonly operation: 'REFUND_ACCOUNT' };
  }): Promise<
    | { readonly attempt: number; readonly orderId: string; readonly ticketId: string; readonly refundAmount: number; readonly reason: CancellationReason; readonly retryAttempts: number }
    | undefined
  > {
    return this.database.transaction(async (tx) => {
      if (q.idempotency === undefined) return this.#beginAttemptTx(tx, q);
      // 같은 계정·작업·키를 같은 트랜잭션의 첫 쓰기로 잡는다(플랫폼 IdempotencyStore, BAT-425 RV-03).
      // 같은 키의 다시 부름은 시도를 올리지 않고 그 시도의 값으로 조회·정산 길을 이어 간다
      const idempotency = new IdempotencyStore({ clock: { now: () => q.nowMs, monotonicMs: () => q.nowMs }, table: 'order_idempotency' });
      try {
        return await idempotency.run(
          tx,
          { accountRef: q.idempotency.accountRef, operation: q.idempotency.operation, key: q.idempotency.key, requestHash: q.idempotency.requestHash },
          {
            execute: async () => {
              const value = await this.#beginAttemptTx(tx, q, q.idempotency!.key);
              // 다른 요청이 먼저 시도를 올렸다: 키 행도 남기지 않고 되돌린다(다음 요청이 처음부터 다시 본다)
              if (value === undefined) throw new BeginAttemptNotApplied();
              return { resultRef: q.cancellationId, value };
            },
            replay: async () => this.#replayAttempt(tx, q.cancellationId),
          },
        );
      } catch (err) {
        if (err instanceof BeginAttemptNotApplied) return undefined;
        throw err;
      }
    });
  }

  /** 시도를 1 올린다. idemKey가 있으면 그 키도 같은 행에 적는다(같은 키 재요청은 이 시도를 그대로 쓴다) */
  async #beginAttemptTx(
    tx: DbTransaction,
    q: { readonly cancellationId: string; readonly oldAttempt: number; readonly nowMs: number },
    idemKey?: string,
  ): Promise<
    | { readonly attempt: number; readonly orderId: string; readonly ticketId: string; readonly refundAmount: number; readonly reason: CancellationReason; readonly retryAttempts: number }
    | undefined
  > {
    const [row] = await tx
      .select({
        orderId: orderCancellation.orderId,
        ticketId: orderCancellation.ticketId,
        refundAmount: orderCancellation.refundAmount,
        reason: orderCancellation.reason,
        status: orderCancellation.status,
        refundAttempts: orderCancellation.refundAttempts,
        refundAttempt: orderCancellation.refundAttempt,
        accountRequiredAt: orderCancellation.refundAccountRequiredAt,
      })
      .from(orderCancellation)
      .where(eq(orderCancellation.id, q.cancellationId))
      .for('update');
    if (!row || row.status !== 'REFUND_PENDING' || row.accountRequiredAt === null) return undefined;
    if (row.refundAttempt !== q.oldAttempt || row.refundAttempt >= REFUND_ACCOUNT_MAX_ATTEMPTS) return undefined;
    const attempt = row.refundAttempt + 1;
    const updated = await tx
      .update(orderCancellation)
      .set({
        refundAttempt: attempt,
        nextRefundAt: null,
        statusChangedAt: new Date(q.nowMs),
        ...(idemKey === undefined ? {} : { refundAccountIdemKey: idemKey }),
      })
      .where(and(eq(orderCancellation.id, q.cancellationId), eq(orderCancellation.refundAttempt, q.oldAttempt), eq(orderCancellation.status, 'REFUND_PENDING')))
      .returning({ id: orderCancellation.id });
    if (updated.length === 0) return undefined;
    return { attempt, orderId: row.orderId, ticketId: row.ticketId, refundAmount: row.refundAmount, reason: row.reason as CancellationReason, retryAttempts: row.refundAttempts };
  }

  /** 같은 키의 다시 부름: 시도를 올리지 않고 그 행의 시도 값으로 결제사 조회·정산을 이어 간다 */
  async #replayAttempt(
    tx: DbTransaction,
    cancellationId: string,
  ): Promise<{ readonly attempt: number; readonly orderId: string; readonly ticketId: string; readonly refundAmount: number; readonly reason: CancellationReason; readonly retryAttempts: number } | undefined> {
    const [row] = await tx
      .select({
        orderId: orderCancellation.orderId,
        ticketId: orderCancellation.ticketId,
        refundAmount: orderCancellation.refundAmount,
        reason: orderCancellation.reason,
        status: orderCancellation.status,
        refundAttempts: orderCancellation.refundAttempts,
        refundAttempt: orderCancellation.refundAttempt,
      })
      .from(orderCancellation)
      .where(eq(orderCancellation.id, cancellationId))
      .for('update');
    if (row === undefined || row.status !== 'REFUND_PENDING') return undefined;
    return { attempt: row.refundAttempt, orderId: row.orderId, ticketId: row.ticketId, refundAmount: row.refundAmount, reason: row.reason as CancellationReason, retryAttempts: row.refundAttempts };
  }

  /** 같은 키의 첫 답을 취소 행에 적는다(0031, BAT-425 RV-03). 그 사이 다른 키가 덮었으면 쓰지 않는다 */
  async saveAnswer(q: { readonly cancellationId: string; readonly idempotencyKey: string; readonly answer: RefundAccountAnswer; readonly nowMs: number }): Promise<void> {
    await this.database.db
      .update(orderCancellation)
      .set({ refundAccountAnswer: q.answer, statusChangedAt: new Date(q.nowMs) })
      .where(and(eq(orderCancellation.id, q.cancellationId), eq(orderCancellation.refundAccountIdemKey, q.idempotencyKey)));
  }

  /** 계좌 대기 표시를 지운다(REFUND_PENDING만). 결과 모름이면 다음 재시도 시각을 함께 쓰고, 답도 같은 문장에서 쓴다(BAT-425 RV-24) */
  async clearWaiting(q: {
    readonly cancellationId: string;
    readonly nextRefundAtMs?: number;
    readonly lastError?: string;
    readonly nowMs: number;
    readonly answer?: { readonly idempotencyKey: string; readonly answer: RefundAccountAnswer };
    readonly refundAttempt?: number;
    readonly onlyIfAttempt?: number;
  }): Promise<void> {
    await this.database.db
      .update(orderCancellation)
      .set({
        refundAccountRequiredAt: null,
        nextRefundAt: q.nextRefundAtMs === undefined ? null : new Date(q.nextRefundAtMs),
        ...(q.lastError !== undefined ? { refundLastError: q.lastError } : {}),
        // payment가 새 시도 행을 만들지 않았으면 시도 번호를 되돌린다(RV-28). 다음 재시도가 앞 시도(a0)를 계속 조회한다
        ...(q.refundAttempt === undefined ? {} : { refundAttempt: q.refundAttempt }),
        statusChangedAt: new Date(q.nowMs),
        ...(q.answer === undefined ? {} : { refundAccountAnswer: q.answer.answer }),
      })
      .where(
        and(
          eq(orderCancellation.id, q.cancellationId),
          eq(orderCancellation.status, 'REFUND_PENDING'),
          // 그사이 다른 요청이 시도를 더 올렸으면 이 요청의 되돌리기를 덮어쓰지 않는다
          q.onlyIfAttempt === undefined ? undefined : eq(orderCancellation.refundAttempt, q.onlyIfAttempt),
        ),
      );
  }

  /** RefundAccountWrites.markFailed: 계좌 다시 받기의 업무 거절을 기존 CS '환급 실패' 표시로 잇는다(답도 같은 문장) */
  async markFailed(q: { readonly cancellationId: string; readonly attempts: number; readonly lastError: string; readonly nowMs: number; readonly answer?: { readonly idempotencyKey: string; readonly answer: RefundAccountAnswer } }): Promise<boolean> {
    return this.markRefundFailed(q);
  }

  /**
   * 같은 계정·작업·키의 멱등 기록 지문(플랫폼 IdempotencyStore, order_idempotency). 없으면 undefined.
   * 같은 키의 답을 재생하기 전에 현재 지문과 견주어 다르면 422 idempotency-key-reused다(RV-24)
   */
  async requestHashOf(q: { readonly accountRef: string; readonly key: string; readonly operation: 'REFUND_ACCOUNT' }): Promise<Uint8Array | undefined> {
    const r = await this.database.db.execute(sql`
      select request_hash from order_idempotency
      where account_ref = ${q.accountRef} and operation = ${q.operation} and idempotency_key = ${q.key}::uuid
      limit 1`);
    return (r.rows[0] as { request_hash: Buffer } | undefined)?.request_hash;
  }

  async dueRefunds(nowMs: number, limit: number): Promise<readonly DueRefund[]> {
    const now = new Date(nowMs);
    const held = holdOpenFor(now);
    const running = eventRefundRunning();
    const rows = await this.database.db
      .select({
        cancellationId: orderCancellation.id,
        orderId: orderCancellation.orderId,
        ticketId: orderCancellation.ticketId,
        amount: orderCancellation.refundAmount,
        reason: orderCancellation.reason,
        status: orderCancellation.status,
        attempts: orderCancellation.refundAttempts,
        refundAttempt: orderCancellation.refundAttempt,
        refundDueAt: orderCancellation.refundDueAt,
        nextRefundAt: orderCancellation.nextRefundAt,
        createdAt: orderCancellation.createdAt,
      })
      .from(orderCancellation)
      .where(
        and(
          isNull(orderCancellation.refundFailedAt),
          // 계좌 대기 행은 계좌를 다시 받기 전까지 집지 않는다(BUILD_ORDER GAT-090, next_refund_at이 비어 있어도)
          isNull(orderCancellation.refundAccountRequiredAt),
          or(
            // 입장 기록이 나온 보류 취소(entry_recorded_at)는 CS 처리함 '이상 표시'가 처리하므로 더 집지 않는다(BAT-420 P-T19 ①)
            // 회차 취소 요청의 미룸이 걸렸거나(BAT-420 몫 D) 그 회차의 일괄 환불이 진행 중(RUNNING·PAUSED)이면 집지 않는다. 결과 모름 재시도(REFUND_PENDING)는 미루지 않는다
            and(eq(orderCancellation.status, 'REQUESTED'), lte(orderCancellation.refundDueAt, now), isNull(orderCancellation.entryRecordedAt), sql`not ${held}`, sql`not ${running}`),
            // 회차 취소 요청이 만들거나 전환한 행(연기 신청 환급 행 포함)은 일괄 환불 실행기만 결제사로 보낸다(웨이브 끝 리뷰 K1·C1,
            // transfer-refund §5 '일괄 환불 항목의 주인과 겹침 막기'). 요청의 진행 상태와 관계없이 뺀다. 부정 예매·팬 행(요청 ID 없음)은 지금처럼 집는다
            and(
              eq(orderCancellation.status, 'REFUND_PENDING'),
              isNull(orderCancellation.eventCancellationRequestId),
              or(isNull(orderCancellation.nextRefundAt), lte(orderCancellation.nextRefundAt, now)),
            ),
          ),
        ),
      )
      .orderBy(sql`coalesce(${orderCancellation.nextRefundAt}, ${orderCancellation.refundDueAt}, ${orderCancellation.createdAt})`)
      .limit(limit);
    const due: DueRefund[] = rows.map((r) => ({
      cancellationId: r.cancellationId,
      orderId: r.orderId,
      ticketId: r.ticketId,
      amount: r.amount,
      reason: r.reason as CancellationReason,
      status: r.status as 'REQUESTED' | 'REFUND_PENDING',
      attempts: r.attempts,
      refundAttempt: r.refundAttempt,
    }));
    // 미룸 때문에 집지 않은 마감 지난 보류 취소는 따로 읽어 held로 싣는다(실행기가 세기만 한다). 따로 읽어 위 묶음 자리를 차지하지 않는다
    const heldRows = await this.database.db
      .select({ cancellationId: orderCancellation.id, orderId: orderCancellation.orderId, ticketId: orderCancellation.ticketId, amount: orderCancellation.refundAmount, reason: orderCancellation.reason })
      .from(orderCancellation)
      .where(
        and(
          isNull(orderCancellation.refundFailedAt),
          eq(orderCancellation.status, 'REQUESTED'),
          lte(orderCancellation.refundDueAt, now),
          isNull(orderCancellation.entryRecordedAt),
          sql`${held}`,
        ),
      )
      .orderBy(orderCancellation.refundDueAt)
      .limit(limit);
    for (const r of heldRows) {
      due.push({ cancellationId: r.cancellationId, orderId: r.orderId, ticketId: r.ticketId, amount: r.amount, reason: r.reason as CancellationReason, status: 'REQUESTED', attempts: 0, held: true });
    }
    return due;
  }

  /**
   * 보류 취소 조건부 집기(BAT-420 GAT-090 A2, docs/data.md §5): REQUESTED이고 입장 기록이 없는 행만 REFUND_PENDING(다음 재시도 시각 빔)으로 바꾼다.
   * 실행기 둘이 겹쳐도 한쪽만 true라 결제사 호출은 한 번이다
   */
  async claimDue(cancellationId: string, nowMs: number): Promise<boolean> {
    const now = new Date(nowMs);
    // 조회와 집기 사이에 걸린 미룸·시작된 일괄 환불도 이 한 문장이 막는다(BAT-420 몫 D, GAT-090 D4)
    const updated = await this.database.db
      .update(orderCancellation)
      .set({ status: 'REFUND_PENDING', nextRefundAt: null, statusChangedAt: now })
      .where(
        and(
          eq(orderCancellation.id, cancellationId),
          eq(orderCancellation.status, 'REQUESTED'),
          isNull(orderCancellation.entryRecordedAt),
          sql`not ${holdOpenFor(now)}`,
          sql`not ${eventRefundRunning()}`,
        ),
      )
      .returning({ id: orderCancellation.id });
    return updated.length > 0;
  }

  /**
   * 입장 기록이 나온 보류 취소(REQUESTED)에 가장 이른 입장 시각을 쓰고 refund_due_at을 비운다(BAT-420 P-T19 ①). 상태는 그대로다.
   * entry_flag_opened_at은 비운 채 둔다. CS '이상 표시' 건을 ops-svc가 2xx로 받은 뒤에 CsCaseOutbox.markFlagOpened가 쓴다(웨이브 끝 리뷰 S1)
   */
  async markEntryRecorded(cancellationId: string, enteredAtMs: number, _nowMs: number): Promise<boolean> {
    const updated = await this.database.db
      .update(orderCancellation)
      .set({ entryRecordedAt: new Date(enteredAtMs), refundDueAt: null })
      .where(and(eq(orderCancellation.id, cancellationId), eq(orderCancellation.status, 'REQUESTED'), isNull(orderCancellation.entryRecordedAt)))
      .returning({ id: orderCancellation.id });
    return updated.length > 0;
  }
}

/** 그 취소의 회차에 풀리지 않고 기한 안인 환급 미룸이 있는가(BAT-420 몫 D, event_refund_hold) */
function holdOpenFor(now: Date) {
  return sql`exists (
    select 1 from purchase_order ho join event_refund_hold h on h.event_id = ho.event_id
     where ho.id = ${orderCancellation.orderId} and h.released_at is null and h.expires_at > ${now}::timestamptz)`;
}

/** 그 취소의 회차에 진행 중(RUNNING·PAUSED)인 회차 취소 일괄 환불이 있는가(그 실행기가 보류 취소를 전환한다, BAT-420 몫 D) */
function eventRefundRunning() {
  return sql`exists (
    select 1 from purchase_order ro join event_cancellation_request r on r.event_id = ro.event_id
     where ro.id = ${orderCancellation.orderId} and r.kind = 'CANCEL' and r.status in ('RUNNING', 'PAUSED'))`;
}

/** 도착이 REFUNDED인 취소 뒤 전이(T23·T24) */
const endsRefunded = (t: string): boolean => t === 'T23' || t === 'T24';

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
