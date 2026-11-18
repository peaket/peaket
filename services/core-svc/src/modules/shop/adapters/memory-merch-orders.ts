// 굿즈 주문 메모리 저장소(단위·HTTP 시험과 개발). DrizzleShopOrderStore와 같은 규칙을 기다림(await) 없는 한 덩이 처리로 한다
// (자바스크립트는 한 덩이 안에서 끼어들 수 없어 행 잠금과 같은 효과다). 상품은 MemoryProductStore를 함께 쓴다(한정 재고 product_stock은 ProductRecord.stock).
// 멱등 기록은 (계정, 작업, 키) → (지문, 결과 참조)이다. 시험이 상태를 보도록 표를 공개한다.
import { timingSafeEqual } from 'node:crypto';
import { idempotencyKeyReused, type IdempotencyRequest } from '@peaket/platform';
import type {
  AcceptOutcome,
  AddonItemRow,
  CancelOutcome,
  ConfirmJob,
  NewAttempt,
  NewShopOrder,
  RebuildReservation,
  RefundRow,
  ShopOrderStore,
  UnclaimedCandidate,
} from '../domain/merch-ports.js';
import {
  acceptBlocker,
  attemptStartBlocker,
  type AcceptBody,
  type LimitedLine,
  type MerchAttempt,
  type OrderableProduct,
  type OrderState,
  orderNotFound,
  type PaymentRef,
  type PickupSlotRecord,
  REFUND_RETRY_MS,
  type ReleasedOrder,
  reservedUntilAfterAccept,
  type ShopOrder,
  type ShopOrderDetail,
  type ShopOrderItem,
  type ShopPg,
  UNCLAIMED_REASON,
} from '../domain/merch-order.js';
import type { MemoryProductStore } from './memory-product-store.js';

interface JobRow extends ConfirmJob {
  nextAtMs: number;
}
interface RefundState extends RefundRow {
  itemIds: string[];
  nextAtMs: number | null;
}

export class MemoryShopOrderStore implements ShopOrderStore {
  readonly orders = new Map<string, ShopOrder>();
  readonly items = new Map<string, ShopOrderItem>();
  readonly attempts = new Map<string, MerchAttempt>();
  readonly jobs = new Map<string, JobRow>();
  readonly refunds = new Map<string, RefundState>();
  readonly slots = new Map<string, PickupSlotRecord>();
  readonly idempotency = new Map<string, { hash: Buffer; resultRef: string }>();
  /** 회차 → 끝 시각(시험이 넣는다) */
  readonly eventEnds = new Map<string, Date>();
  /** 쓰기 횟수(시험이 '바뀐 행 없음'을 본다) */
  writes = 0;

  constructor(
    readonly productStore: MemoryProductStore,
    readonly schemaVersions: Map<string, number> = new Map(),
  ) {}

  #product(id: string) {
    return this.productStore.rows.get(id);
  }

  #limitedOf(orderId: string): LimitedLine[] {
    const byProduct = new Map<string, number>();
    for (const i of this.items.values()) {
      if (i.orderId !== orderId || this.#product(i.productId)?.limitedQty == null) continue;
      byProduct.set(i.productId, (byProduct.get(i.productId) ?? 0) + i.quantity);
    }
    return [...byProduct.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([productId, quantity]) => ({ productId, quantity }));
  }

  #attemptsOf(orderId: string): MerchAttempt[] {
    return [...this.attempts.values()].filter((a) => a.orderId === orderId).sort((a, b) => a.attemptNo - b.attemptNo);
  }

  #accepted(orderId: string): boolean {
    return this.#attemptsOf(orderId).some((a) => a.status === 'ACCEPTED');
  }

  #detail(order: ShopOrder): ShopOrderDetail {
    const own = this.#attemptsOf(order.orderId);
    const slot = order.pickupSlotId ? this.slots.get(order.pickupSlotId) : undefined;
    return {
      order: { ...order },
      items: [...this.items.values()].filter((i) => i.orderId === order.orderId).sort((a, b) => a.itemId.localeCompare(b.itemId)).map((i) => ({ ...i, limited: this.#product(i.productId)?.limitedQty != null })),
      activeAttempt: own.find((a) => a.status === 'ACCEPTED') ?? own.find((a) => a.status === 'READY'),
      attemptCount: own.length,
      pickupWindow: slot ? { startsAt: slot.startsAt, endsAt: slot.endsAt } : null,
    };
  }

  #idemKey(once: IdempotencyRequest): string {
    return `${once.accountRef}|${once.operation}|${once.key}`;
  }

  /** 다른 지문이면 422, 있으면 결과 참조 */
  #seen(once: IdempotencyRequest): string | undefined {
    const seen = this.idempotency.get(this.#idemKey(once));
    if (!seen) return undefined;
    const hash = Buffer.from(once.requestHash);
    if (seen.hash.length !== hash.length || !timingSafeEqual(seen.hash, hash)) throw idempotencyKeyReused();
    return seen.resultRef;
  }

  #remember(once: IdempotencyRequest, resultRef: string): void {
    this.idempotency.set(this.#idemKey(once), { hash: Buffer.from(once.requestHash), resultRef });
  }

  async products(ids: readonly string[]): Promise<OrderableProduct[]> {
    return ids.flatMap((id) => {
      const p = this.#product(id);
      return p ? [{ ...p, schemaVersion: this.schemaVersions.get(id) ?? p.schemaVersion ?? 1 }] : [];
    });
  }

  async committedQuantities(accountId: string, productIds: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const i of this.items.values()) {
      const o = this.orders.get(i.orderId);
      if (!o || o.accountId !== accountId || !productIds.includes(i.productId)) continue;
      if (i.status === 'CANCELLED' || i.status === 'REFUNDED') continue;
      if (!(o.status === 'PAID' || (o.status === 'CREATED' && this.#accepted(o.orderId)))) continue;
      out.set(i.productId, (out.get(i.productId) ?? 0) + i.quantity);
    }
    return out;
  }

  async pickupSlot(slotId: string): Promise<PickupSlotRecord | undefined> {
    return this.slots.get(slotId);
  }

  async eventEndsAt(eventId: string): Promise<Date | null> {
    return this.eventEnds.get(eventId) ?? null;
  }

  async pickupSlotsOf(productIds: readonly string[]): Promise<PickupSlotRecord[]> {
    return [...this.slots.values()].filter((s) => productIds.includes(s.productId));
  }

  async orderState(orderId: string): Promise<OrderState | undefined> {
    const o = this.orders.get(orderId);
    if (!o) return undefined;
    return { orderId, accountId: o.accountId, status: o.status, accepted: this.#accepted(orderId), stockReservedUntilMs: o.stockReservedUntil.getTime(), limited: this.#limitedOf(orderId) };
  }

  async rebuildSource(productId: string, nowMs: number): Promise<{ stock: number; reservations: RebuildReservation[] } | undefined> {
    const p = this.#product(productId);
    if (!p || p.limitedQty === null) return undefined;
    const reservations: RebuildReservation[] = [];
    for (const i of this.items.values()) {
      if (i.productId !== productId) continue;
      const o = this.orders.get(i.orderId)!;
      if (o.status !== 'CREATED' || o.stockReservedUntil.getTime() <= nowMs || this.#accepted(o.orderId)) continue;
      reservations.push({ orderId: o.orderId, accountId: o.accountId, quantity: i.quantity, untilMs: o.stockReservedUntil.getTime() });
    }
    return { stock: p.stock ?? 0, reservations };
  }

  async replayOf(once: IdempotencyRequest): Promise<string | undefined> {
    return this.#seen(once);
  }

  async insertOrder(once: IdempotencyRequest, o: NewShopOrder): Promise<{ kind: 'created' } | { kind: 'replay'; resultRef: string }> {
    const seen = this.#seen(once);
    if (seen !== undefined) return { kind: 'replay', resultRef: seen };
    this.orders.set(o.order.orderId, { ...o.order, status: 'CREATED' });
    for (const i of o.items) this.items.set(i.itemId, { ...i, status: 'READY' });
    this.#remember(once, o.order.orderId);
    this.writes++;
    return { kind: 'created' };
  }

  async expireUnpaid(orderId: string, nowMs: number, mode: 'due' | 'superseded'): Promise<ReleasedOrder | undefined> {
    const o = this.orders.get(orderId);
    if (!o || o.status !== 'CREATED' || this.#accepted(orderId)) return undefined;
    if (mode === 'due' && o.stockReservedUntil.getTime() > nowMs) return undefined;
    o.status = 'EXPIRED';
    for (const a of this.#attemptsOf(orderId)) if (a.status === 'READY') a.status = 'EXPIRED';
    this.writes++;
    return { orderId, accountId: o.accountId, limited: this.#limitedOf(orderId) };
  }

  async dueUnpaidOrders(nowMs: number, limit: number): Promise<string[]> {
    return [...this.orders.values()]
      .filter((o) => o.status === 'CREATED' && o.stockReservedUntil.getTime() <= nowMs && !this.#accepted(o.orderId))
      .sort((a, b) => a.stockReservedUntil.getTime() - b.stockReservedUntil.getTime())
      .slice(0, limit)
      .map((o) => o.orderId);
  }

  async findOrder(orderId: string): Promise<ShopOrderDetail | undefined> {
    const o = this.orders.get(orderId);
    return o ? this.#detail(o) : undefined;
  }

  async listOrders(accountId: string, limit: number, cursor?: string): Promise<{ items: ShopOrderDetail[]; nextCursor: string | null }> {
    const after = cursor ? Buffer.from(cursor, 'base64url').toString('utf8').split(':') : undefined;
    const rows = [...this.orders.values()]
      .filter((o) => o.accountId === accountId && o.status !== 'EXPIRED' && o.status !== 'FAILED')
      .sort((a, b) => b.orderedAt.getTime() - a.orderedAt.getTime() || b.orderId.localeCompare(a.orderId))
      .filter((o) => !after || o.orderedAt.getTime() < Number(after[0]) || (o.orderedAt.getTime() === Number(after[0]) && o.orderId < (after[1] ?? '')));
    const page = rows.slice(0, limit).map((o) => this.#detail(o));
    const last = page[page.length - 1];
    return { items: page, nextCursor: rows.length > limit && last ? Buffer.from(`${last.order.orderedAt.getTime()}:${last.order.orderId}`).toString('base64url') : null };
  }

  #owned(orderId: string, accountId: string): ShopOrderDetail {
    const o = this.orders.get(orderId);
    if (!o || o.accountId !== accountId) throw orderNotFound();
    return this.#detail(o);
  }

  async saveAttempt(once: IdempotencyRequest, a: NewAttempt): Promise<{ kind: 'saved' } | { kind: 'replay'; resultRef: string }> {
    const seen = this.#seen(once);
    if (seen !== undefined) return { kind: 'replay', resultRef: seen };
    const detail = this.#owned(a.orderId, a.accountId);
    const blocked = attemptStartBlocker(detail, a.nowMs);
    if (blocked) throw blocked;
    for (const x of this.#attemptsOf(a.orderId)) if (x.status === 'READY') x.status = 'SUPERSEDED';
    this.attempts.set(a.attemptId, { attemptId: a.attemptId, orderId: a.orderId, attemptNo: detail.attemptCount + 1, pg: a.pg, payMethod: a.payMethod, status: 'READY', createdAt: new Date(a.nowMs), acceptedAt: null });
    this.#remember(once, a.responseJson);
    this.writes++;
    return { kind: 'saved' };
  }

  async acceptPayment(once: IdempotencyRequest, i: { orderId: string; accountId: string; nowMs: number; body: AcceptBody; ref: PaymentRef }): Promise<AcceptOutcome> {
    const seen = this.#seen(once);
    if (seen !== undefined) return { kind: 'replay', resultRef: seen };
    const detail = this.#owned(i.orderId, i.accountId);
    const blocked = acceptBlocker(detail, i.body, i.nowMs);
    if (blocked) throw blocked;
    const order = this.orders.get(i.orderId)!;
    const attempt = this.attempts.get(detail.activeAttempt!.attemptId)!;
    const limited = this.#limitedOf(i.orderId);
    // 한정 상품마다 stock >= quantity를 모두 본 뒤에만 깎는다(저장점 되돌림과 같은 효과)
    const short = limited.some((l) => (this.#product(l.productId)?.stock ?? 0) < l.quantity);
    this.writes++;
    if (short) {
      order.status = 'FAILED';
      attempt.status = 'FAILED';
      this.#remember(once, 'sold-out');
      return { kind: 'sold-out', limited };
    }
    for (const l of limited) {
      const p = this.#product(l.productId)!;
      p.stock = (p.stock ?? 0) - l.quantity;
    }
    attempt.status = 'ACCEPTED';
    attempt.acceptedAt = new Date(i.nowMs);
    order.pg = attempt.pg;
    order.stockReservedUntil = reservedUntilAfterAccept(order.stockReservedUntil, i.nowMs);
    const job: ConfirmJob = { orderId: i.orderId, attemptId: attempt.attemptId, attemptNo: attempt.attemptNo, pg: attempt.pg, ref: i.ref, amount: order.amount, authenticatedAtMs: i.nowMs, sent: false, tries: 0 };
    this.jobs.set(i.orderId, { ...job, nextAtMs: i.nowMs });
    this.#remember(once, 'accepted');
    return { kind: 'accepted', job, limited, reservedUntil: order.stockReservedUntil };
  }

  async markConfirmSent(orderId: string, nextAtMs: number): Promise<void> {
    const j = this.jobs.get(orderId);
    if (!j) return;
    j.sent = true;
    j.tries += 1;
    j.nextAtMs = nextAtMs;
  }

  async rescheduleJob(orderId: string, nextAtMs: number, o: { tries?: number; sent?: boolean } = {}): Promise<void> {
    const j = this.jobs.get(orderId);
    if (!j) return;
    j.nextAtMs = nextAtMs;
    if (o.tries !== undefined) j.tries = o.tries;
    if (o.sent !== undefined) j.sent = o.sent;
  }

  async claimDueJobs(nowMs: number, limit: number, leaseUntilMs: number): Promise<ConfirmJob[]> {
    const due = [...this.jobs.values()].filter((j) => j.nextAtMs <= nowMs).sort((a, b) => a.nextAtMs - b.nextAtMs).slice(0, limit);
    for (const j of due) j.nextAtMs = leaseUntilMs;
    return due.map(({ nextAtMs: _n, ...j }) => ({ ...j }));
  }

  async applyPaid(orderId: string, r: { paymentId: string; pg: ShopPg | undefined; approvedAtMs: number }): Promise<ReleasedOrder | undefined> {
    this.jobs.delete(orderId);
    const o = this.orders.get(orderId);
    if (!o || o.status !== 'CREATED') return undefined;
    o.status = 'PAID';
    o.paymentId = r.paymentId;
    o.paidAt = new Date(r.approvedAtMs);
    if (r.pg) o.pg = r.pg;
    this.writes++;
    return { orderId, accountId: o.accountId, limited: this.#limitedOf(orderId) };
  }

  async applyFailed(orderId: string, _nowMs: number): Promise<ReleasedOrder | undefined> {
    this.jobs.delete(orderId);
    const o = this.orders.get(orderId);
    if (!o || o.status !== 'CREATED') return undefined;
    const accepted = this.#accepted(orderId);
    o.status = 'FAILED';
    for (const a of this.#attemptsOf(orderId)) if (a.status === 'READY' || a.status === 'ACCEPTED') a.status = 'FAILED';
    const limited = this.#limitedOf(orderId);
    if (accepted)
      for (const l of limited) {
        const p = this.#product(l.productId)!;
        p.stock = (p.stock ?? 0) + l.quantity;
      }
    this.writes++;
    return { orderId, accountId: o.accountId, limited };
  }

  async limitedProducts(): Promise<{ productId: string; saleEndsAt: Date | null }[]> {
    return [...this.productStore.rows.values()]
      .filter((p) => p.limitedQty !== null && p.status !== 'DRAFT')
      .sort((a, b) => a.productId.localeCompare(b.productId))
      .map((p) => ({ productId: p.productId, saleEndsAt: p.saleEndsAt }));
  }

  async addonItems(ticketId: string): Promise<AddonItemRow[]> {
    return [...this.items.values()]
      .filter((i) => i.linkedTicketId === ticketId && this.orders.get(i.orderId)?.status === 'PAID')
      .sort((a, b) => a.itemId.localeCompare(b.itemId))
      .map((i) => {
        const o = this.orders.get(i.orderId)!;
        return { orderId: o.orderId, accountId: o.accountId, itemId: i.itemId, productId: i.productId, name: i.productName, quantity: i.quantity, status: i.status, eventId: o.eventId, transferable: this.#product(i.productId)?.transferable === true };
      });
  }

  async unclaimedCandidates(nowMs: number, limit: number): Promise<UnclaimedCandidate[]> {
    const byOrder = new Map<string, UnclaimedCandidate>();
    let count = 0;
    for (const i of [...this.items.values()].sort((a, b) => a.orderId.localeCompare(b.orderId) || a.itemId.localeCompare(b.itemId))) {
      const o = this.orders.get(i.orderId)!;
      if (o.status !== 'PAID' || o.fulfillment !== 'PICKUP' || i.status !== 'READY') continue;
      const ends = [...this.slots.values()].filter((s) => s.productId === i.productId && s.eventId === o.eventId).map((s) => s.endsAt.getTime());
      if (ends.length === 0) continue;
      const last = Math.max(...ends);
      if (last > nowMs || count >= limit) continue;
      count++;
      const c = byOrder.get(o.orderId) ?? { orderId: o.orderId, paymentId: o.paymentId, items: [] };
      c.items.push({ itemId: i.itemId, productId: i.productId, quantity: i.quantity, unitAmount: i.unitAmount, lastSlotEndsAtMs: last });
      byOrder.set(o.orderId, c);
    }
    return [...byOrder.values()];
  }

  async cancelUnclaimed(orderId: string, itemIds: readonly string[], refundId: string, nowMs: number): Promise<RefundRow | undefined> {
    const changed = [...this.items.values()].filter((i) => i.orderId === orderId && itemIds.includes(i.itemId) && i.status === 'READY');
    if (changed.length === 0) return undefined;
    for (const i of changed) {
      i.status = 'CANCELLED';
      i.cancelReason = UNCLAIMED_REASON;
    }
    const amount = changed.reduce((s, i) => s + i.quantity * i.unitAmount, 0);
    const row: RefundState = {
      refundId,
      orderId,
      paymentId: this.orders.get(orderId)?.paymentId ?? null,
      amount,
      reason: UNCLAIMED_REASON,
      status: 'REQUESTED',
      createdAtMs: nowMs,
      alerted: false,
      itemIds: changed.map((i) => i.itemId),
      nextAtMs: nowMs + REFUND_RETRY_MS,
    };
    this.refunds.set(refundId, row);
    this.writes++;
    const { itemIds: _i, nextAtMs: _n, ...out } = row;
    return { ...out };
  }

  async dueRefunds(nowMs: number, limit: number): Promise<RefundRow[]> {
    return [...this.refunds.values()]
      .filter((r) => (r.status === 'REQUESTED' || r.status === 'CANCEL_PENDING') && r.nextAtMs !== null && r.nextAtMs <= nowMs)
      .sort((a, b) => (a.nextAtMs ?? 0) - (b.nextAtMs ?? 0))
      .slice(0, limit)
      .map(({ itemIds: _i, nextAtMs: _n, ...r }) => ({ ...r }));
  }

  async refundResult(refundId: string, outcome: CancelOutcome, nowMs: number, o: { alerted?: boolean } = {}): Promise<void> {
    const r = this.refunds.get(refundId);
    if (!r || r.status === 'CANCELLED' || r.status === 'REJECTED') return;
    if (o.alerted !== undefined) r.alerted = o.alerted;
    if (outcome === 'CANCELLED') {
      for (const id of r.itemIds) {
        const i = this.items.get(id);
        if (i && i.status === 'CANCELLED') {
          i.status = 'REFUNDED';
          i.refundedAmount = i.quantity * i.unitAmount;
        }
      }
      r.status = 'CANCELLED';
      r.nextAtMs = null;
    } else if (outcome === 'REJECTED') {
      r.status = 'REJECTED';
      r.nextAtMs = null;
    } else {
      r.status = 'CANCEL_PENDING';
      r.nextAtMs = nowMs + REFUND_RETRY_MS;
    }
  }

  async productAttributesPage(afterId: string | undefined, limit: number): Promise<{ productId: string; type: string; schemaVersion: number; attributes: unknown }[]> {
    return [...this.productStore.rows.values()]
      .filter((p) => afterId === undefined || p.productId > afterId)
      .sort((a, b) => a.productId.localeCompare(b.productId))
      .slice(0, limit)
      .map((p) => ({ productId: p.productId, type: p.type, schemaVersion: this.schemaVersions.get(p.productId) ?? p.schemaVersion ?? 1, attributes: p.attributes }));
  }
}

/** 시험·개발용 상품 유형 표(기본 MERCH·PARKING 판 1, 켜짐) */
export class MemoryProductTypeDirectory {
  readonly rows = new Map<string, { code: string; latestSchemaVersion: number; enabled: boolean }>([
    ['MERCH', { code: 'MERCH', latestSchemaVersion: 1, enabled: true }],
    ['PARKING', { code: 'PARKING', latestSchemaVersion: 1, enabled: true }],
  ]);
  async find(code: string) {
    return this.rows.get(code);
  }
}
