// 굿즈 주문 메모리 저장소(단위·HTTP 시험과 개발). DrizzleShopOrderStore와 같은 규칙을 기다림(await) 없는 한 덩이 처리로 한다
// (자바스크립트는 한 덩이 안에서 끼어들 수 없어 행 잠금과 같은 효과다). 상품은 MemoryProductStore를 함께 쓴다(한정 재고 product_stock은 ProductRecord.stock).
// 멱등 기록은 (계정, 작업, 키) → (지문, 결과 참조)이다. 시험이 상태를 보도록 표를 공개한다.
import { timingSafeEqual } from 'node:crypto';
import { idempotencyKeyReused, type IdempotencyRequest } from '@peaket/platform';
import type {
  AcceptOutcome,
  AddonItemRow,
  BeginRefundAccountRetry,
  CancelOutcome,
  CancelRowView,
  ConfirmJob,
  NewAttempt,
  NewCancellation,
  NewReturn,
  NewShopOrder,
  RebuildReservation,
  RefundRow,
  ShopOrderStore,
  UnclaimedCandidate,
} from '../domain/merch-ports.js';
import {
  acceptBlocker,
  assertRefundAccountRetryable,
  attemptStartBlocker,
  type AcceptBody,
  depositDeadlineMs,
  entryStarted,
  type LimitedLine,
  type MerchAttempt,
  merchCancelNotAllowed,
  merchReturnNotAllowed,
  type OrderableProduct,
  type OrderState,
  orderNotFound,
  type PaymentRef,
  type PickupSlotRecord,
  REFUND_ACCOUNT_RETRY_MS,
  type RefundAccountRetryTarget,
  refundAccountRetryTarget,
  REFUND_RETRY_DELAYS_MIN,
  REFUND_RETRY_MS,
  type ReleasedOrder,
  reservedUntilAfterAccept,
  resolveCancelItems,
  resolveReturnItems,
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
  failReason: string | null;
  resolvedAtMs: number | null;
}
/** 항목 하나에 진행 중인 환급 하나(merch_refund_item) */
interface RefundItemState {
  refundId: string;
  itemId: string;
  resolvedAtMs: number | null;
}

export class MemoryShopOrderStore implements ShopOrderStore {
  readonly orders = new Map<string, ShopOrder>();
  readonly items = new Map<string, ShopOrderItem>();
  readonly attempts = new Map<string, MerchAttempt>();
  readonly jobs = new Map<string, JobRow>();
  readonly refunds = new Map<string, RefundState>();
  /** 진행 중·끝난 항목 환급 자리. 키 `${refundId}|${itemId}` */
  readonly refundItems = new Map<string, RefundItemState>();
  readonly slots = new Map<string, PickupSlotRecord>();
  readonly idempotency = new Map<string, { hash: Buffer; resultRef: string }>();
  /** 회차 → 끝 시각(시험이 넣는다) */
  readonly eventEnds = new Map<string, Date>();
  /** 회차 → 입장 시작 시각(시험이 넣는다) */
  readonly eventEntries = new Map<string, Date>();
  /** 쓰기 횟수(시험이 '바뀐 행 없음'을 본다) */
  writes = 0;
  /** 주문별 쓰기 차례(미커밋 구매자 취소와 미수령 자동 취소를 직렬화한다, RV-29) */
  readonly #orderLocks = new Map<string, Promise<unknown>>();

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

  /** 계좌 다시 받기 사슬의 깊이(원래 행 0). `replaces_refund_id`를 거꾸로 따라 센다 */
  #refundDepthOf(refundId: string): number {
    let depth = 0;
    let cur = this.refunds.get(refundId);
    while (cur?.replacesRefundId && depth < 100) {
      depth++;
      cur = this.refunds.get(cur.replacesRefundId);
    }
    return depth;
  }

  /** 그 주문의 환급 행 전부(사슬 따라가기용). 시각 차례 */
  #refundsOf(orderId: string): RefundRow[] {
    return [...this.refunds.values()]
      .filter((r) => r.orderId === orderId)
      .sort((a, b) => a.createdAtMs - b.createdAtMs || a.refundId.localeCompare(b.refundId))
      .map((r) => ({ ...r, refundAttempt: this.#refundDepthOf(r.refundId) }));
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

  /**
   * 주문 하나의 쓰기를 차례대로 실행한다(메모리 어댑터의 행 잠금). 구매자 취소와 미수령 자동 취소가
   * 겹쳐도 앞선 쓰기가 끝난 뒤 다음 쓰기가 상태를 다시 본다(RV-29).
   */
  async #withOrderLock<T>(orderId: string, run: () => Promise<T> | T): Promise<T> {
    const prev = this.#orderLocks.get(orderId) ?? Promise.resolve();
    const next = prev.then(run, run);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.#orderLocks.set(orderId, tail);
    try {
      return await next;
    } finally {
      if (this.#orderLocks.get(orderId) === tail) this.#orderLocks.delete(orderId);
    }
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

  async eventEntryOpensAt(eventId: string): Promise<Date | null> {
    return this.eventEntries.get(eventId) ?? null;
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

  async paymentAttempt(attemptId: string): Promise<MerchAttempt | undefined> {
    const a = this.attempts.get(attemptId);
    return a ? { ...a } : undefined;
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
    const job: ConfirmJob = { orderId: i.orderId, attemptId: attempt.attemptId, attemptNo: attempt.attemptNo, pg: attempt.pg, pgStore: order.pgStore, ref: i.ref, amount: order.amount, authenticatedAtMs: i.nowMs, sent: false, tries: 0 };
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
    if (!o || (o.status !== 'CREATED' && o.status !== 'AWAITING_DEPOSIT')) return undefined;
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
    if (!o || (o.status !== 'CREATED' && o.status !== 'AWAITING_DEPOSIT')) return undefined;
    const accepted = this.#accepted(orderId);
    const from = o.status;
    o.status = from === 'AWAITING_DEPOSIT' ? 'EXPIRED' : 'FAILED';
    for (const a of this.#attemptsOf(orderId)) if (a.status === 'READY' || a.status === 'ACCEPTED') a.status = from === 'AWAITING_DEPOSIT' ? 'EXPIRED' : 'FAILED';
    const limited = this.#limitedOf(orderId);
    if (accepted)
      for (const l of limited) {
        const p = this.#product(l.productId)!;
        p.stock = (p.stock ?? 0) + l.quantity;
      }
    this.writes++;
    return { orderId, accountId: o.accountId, limited };
  }

  async applyAwaitingDeposit(orderId: string, x: { paymentId: string; pg: ShopPg | undefined; depositDueAtMs: number | undefined; nowMs: number }): Promise<{ orderId: string; accountId: string; deadline: Date; limited: LimitedLine[] } | undefined> {
    const o = this.orders.get(orderId);
    if (!o || o.status !== 'CREATED') return undefined;
    o.status = 'AWAITING_DEPOSIT';
    o.paymentId = x.paymentId;
    if (x.pg) o.pg = x.pg;
    const deadline = new Date(depositDeadlineMs(x.depositDueAtMs, x.nowMs));
    o.stockReservedUntil = deadline;
    this.writes++;
    return { orderId, accountId: o.accountId, deadline, limited: this.#limitedOf(orderId) };
  }

  async dueDepositOrders(nowMs: number, limit: number): Promise<string[]> {
    return [...this.orders.values()]
      .filter((o) => o.status === 'AWAITING_DEPOSIT' && o.stockReservedUntil.getTime() <= nowMs)
      .sort((a, b) => a.stockReservedUntil.getTime() - b.stockReservedUntil.getTime())
      .slice(0, limit)
      .map((o) => o.orderId);
  }

  async expireDeposit(orderId: string, _nowMs: number): Promise<ReleasedOrder | undefined> {
    const o = this.orders.get(orderId);
    if (!o || o.status !== 'AWAITING_DEPOSIT') return undefined;
    o.status = 'EXPIRED';
    this.jobs.delete(orderId);
    for (const a of this.#attemptsOf(orderId)) if (a.status === 'READY' || a.status === 'ACCEPTED') a.status = 'EXPIRED';
    const limited = this.#limitedOf(orderId);
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
    // 구매자 취소(createCancellation)와 같은 주문 잠금 차례를 지킨다(RV-29)
    return this.#withOrderLock(orderId, () => {
      // 구매자 취소가 진행 중인 항목(활성 환급 자리)은 건너뛴다(RV-03, 이중 환급 0)
      const busy = new Set([...this.refundItems.values()].filter((c) => c.resolvedAtMs === null).map((c) => c.itemId));
      const changed = [...this.items.values()].filter((i) => i.orderId === orderId && itemIds.includes(i.itemId) && i.status === 'READY' && !busy.has(i.itemId));
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
        kind: 'UNCLAIMED',
        attempts: 0,
        nextAtMs: nowMs + REFUND_RETRY_MS,
        accountRequiredAtMs: null,
        itemIds: changed.map((i) => i.itemId),
        failReason: null,
        resolvedAtMs: null,
        replacesRefundId: null,
        refundAttempt: 0,
      };
      this.refunds.set(refundId, row);
      this.writes++;
      const { resolvedAtMs: _r, ...out } = row;
      return { ...out };
    });
  }

  async dueRefunds(nowMs: number, limit: number): Promise<RefundRow[]> {
    return [...this.refunds.values()]
      .filter((r) => r.kind === 'UNCLAIMED' && (r.status === 'REQUESTED' || r.status === 'CANCEL_PENDING') && r.nextAtMs !== null && r.nextAtMs <= nowMs)
      .sort((a, b) => (a.nextAtMs ?? 0) - (b.nextAtMs ?? 0))
      .slice(0, limit)
      .map(({ resolvedAtMs: _r, ...r }) => ({ ...r, refundAttempt: this.#refundDepthOf(r.refundId) }));
  }

  async dueUserRefunds(nowMs: number, limit: number): Promise<RefundRow[]> {
    return [...this.refunds.values()]
      .filter((r) => r.kind !== 'UNCLAIMED' && (r.status === 'REQUESTED' || r.status === 'CANCEL_PENDING') && r.accountRequiredAtMs === null && r.nextAtMs !== null && r.nextAtMs <= nowMs)
      .sort((a, b) => (a.nextAtMs ?? 0) - (b.nextAtMs ?? 0))
      .slice(0, limit)
      .map(({ resolvedAtMs: _r, ...r }) => ({ ...r, refundAttempt: this.#refundDepthOf(r.refundId) }));
  }

  async refundResult(
    refundId: string,
    outcome: CancelOutcome,
    nowMs: number,
    o: { alerted?: boolean; attempts?: number; nextAtMs?: number | null; failReason?: string; accountRequiredAtMs?: number } = {},
  ): Promise<void> {
    const r = this.refunds.get(refundId);
    if (!r || r.status === 'CANCELLED' || r.status === 'REJECTED') return;
    if (o.alerted !== undefined) r.alerted = o.alerted;
    if (o.attempts !== undefined) r.attempts = o.attempts;
    if (outcome === 'CANCELLED') {
      for (const id of r.itemIds) {
        const i = this.items.get(id);
        if (!i) continue;
        if (r.kind === 'UNCLAIMED' && i.status === 'CANCELLED') {
          i.status = 'REFUNDED';
          i.refundedAmount = i.quantity * i.unitAmount;
        } else if (r.kind !== 'UNCLAIMED' && (i.status === 'READY' || i.status === 'CANCELLED')) {
          i.status = 'REFUNDED';
          i.cancelReason = 'USER_CANCEL';
          i.refundedAmount = i.quantity * i.unitAmount;
        }
      }
      r.status = 'CANCELLED';
      r.nextAtMs = null;
      r.failReason = null;
      r.resolvedAtMs = nowMs;
      for (const c of this.refundItems.values()) if (c.refundId === refundId) c.resolvedAtMs = nowMs;
    } else if (outcome === 'REJECTED' || outcome === 'REFUND_ACCOUNT_REQUIRED') {
      // 성공 전 거절이면 취소 효력도 되돌린다(READY, 환급액 0). 새 키로 다시 취소할 수 있다(RV-30)
      if (r.kind !== 'UNCLAIMED') {
        for (const id of r.itemIds) {
          const i = this.items.get(id);
          if (i && i.status === 'CANCELLED') {
            i.status = 'READY';
            i.cancelReason = null;
            i.refundedAmount = 0;
          }
        }
      }
      r.status = 'REJECTED';
      r.nextAtMs = null;
      r.failReason = o.failReason ?? (outcome === 'REFUND_ACCOUNT_REQUIRED' ? 'REFUND_ACCOUNT_REQUIRED' : 'PG_REJECTED');
      if (outcome === 'REFUND_ACCOUNT_REQUIRED') r.accountRequiredAtMs = o.accountRequiredAtMs ?? nowMs;
      r.resolvedAtMs = nowMs;
      for (const c of this.refundItems.values()) if (c.refundId === refundId) c.resolvedAtMs = nowMs;
    } else {
      if (r.kind !== 'UNCLAIMED') {
        for (const id of r.itemIds) {
          const i = this.items.get(id);
          if (i && i.status === 'READY') {
            i.status = 'CANCELLED';
            i.cancelReason = 'USER_CANCEL';
          }
        }
      }
      r.status = 'CANCEL_PENDING';
      r.nextAtMs = o.nextAtMs === undefined ? nowMs + REFUND_RETRY_MS : o.nextAtMs;
    }
  }

  async createCancellation(once: IdempotencyRequest, i: NewCancellation): Promise<{ kind: 'created'; refund: RefundRow } | { kind: 'replay'; resultRef: string }> {
    return this.#withOrderLock(i.orderId, async () => {
      const seen = this.#seen(once);
      if (seen !== undefined) return { kind: 'replay', resultRef: seen };
      const detail = this.#owned(i.orderId, i.accountId);
      if (detail.order.fulfillment === 'WALLET' && i.entryOpensAtMs === undefined) throw entryStarted();
      const selection = resolveCancelItems(detail, i.itemIds, i.entryOpensAtMs, i.nowMs);
      for (const item of selection.items) {
        if ([...this.refundItems.values()].some((c) => c.itemId === item.itemId && c.resolvedAtMs === null)) throw merchCancelNotAllowed();
      }
      const row: RefundState = {
        refundId: i.refundId,
        orderId: i.orderId,
        paymentId: detail.order.paymentId,
        amount: selection.amount,
        reason: 'USER_CANCEL',
        status: 'REQUESTED',
        createdAtMs: i.nowMs,
        alerted: false,
        kind: 'USER_CANCEL',
        attempts: 0,
        nextAtMs: i.nowMs + REFUND_RETRY_DELAYS_MIN[0] * 60_000,
        accountRequiredAtMs: null,
        itemIds: selection.items.map((x) => x.itemId),
        failReason: null,
        resolvedAtMs: null,
        replacesRefundId: null,
        refundAttempt: 0,
      };
      this.refunds.set(i.refundId, row);
      for (const id of row.itemIds) this.refundItems.set(`${i.refundId}|${id}`, { refundId: i.refundId, itemId: id, resolvedAtMs: null });
      this.#remember(once, `cancel:${i.refundId}`);
      this.writes++;
      const { resolvedAtMs: _r, ...out } = row;
      return { kind: 'created' as const, refund: { ...out } };
    });
  }

  async cancelView(refundId: string): Promise<CancelRowView | undefined> {
    const r = this.refunds.get(refundId);
    if (!r) return undefined;
    return {
      cancellationId: refundId,
      orderId: r.orderId,
      status: 'REFUND_PENDING',
      refundAmount: r.amount,
      refundAccountRequired: r.accountRequiredAtMs !== null,
      state: r.status === 'CANCELLED' ? 'CANCELLED' : r.status === 'REJECTED' ? 'REJECTED' : r.status === 'REQUESTED' ? 'REQUESTED' : 'PENDING',
    };
  }

  // ---- 굿즈 지연 환급 계좌 다시 받기(ADR-0316 결정 5, R-T43) ----

  async findRejectedAccountRequired(orderId: string, accountId: string, cancellationId: string): Promise<RefundAccountRetryTarget | undefined> {
    const o = this.orders.get(orderId);
    if (!o || o.accountId !== accountId) return undefined;
    return refundAccountRetryTarget(this.#refundsOf(orderId), cancellationId);
  }

  async beginAccountRetry(once: IdempotencyRequest, i: BeginRefundAccountRetry): Promise<{ kind: 'created'; refund: RefundRow } | { kind: 'replay'; resultRef: string }> {
    return this.#withOrderLock(i.orderId, () => {
      const seen = this.#seen(once);
      if (seen !== undefined) return { kind: 'replay', resultRef: seen };
      const o = this.orders.get(i.orderId);
      if (!o || o.accountId !== i.accountId) throw orderNotFound();
      const target = refundAccountRetryTarget(this.#refundsOf(i.orderId), i.cancellationId);
      if (!target) throw orderNotFound();
      assertRefundAccountRetryable(target);
      const tip = target.row;
      // 항목 하나에 진행 중 환급 하나(부분 유일 인덱스와 같은 규칙)
      const busy = new Set([...this.refundItems.values()].filter((c) => c.resolvedAtMs === null).map((c) => c.itemId));
      if (tip.itemIds.some((id) => busy.has(id))) throw merchCancelNotAllowed();
      const row: RefundState = {
        refundId: i.refundId,
        orderId: i.orderId,
        paymentId: o.paymentId,
        itemIds: [...tip.itemIds],
        amount: tip.amount,
        reason: tip.reason,
        status: 'REQUESTED',
        createdAtMs: i.nowMs,
        alerted: false,
        kind: tip.kind,
        attempts: 0,
        nextAtMs: i.nowMs + REFUND_ACCOUNT_RETRY_MS,
        accountRequiredAtMs: null,
        replacesRefundId: tip.refundId,
        refundAttempt: target.attemptNo + 1,
        failReason: null,
        resolvedAtMs: null,
      };
      this.refunds.set(i.refundId, row);
      for (const id of row.itemIds) this.refundItems.set(`${i.refundId}|${id}`, { refundId: i.refundId, itemId: id, resolvedAtMs: null });
      this.#remember(once, `cancel:${i.refundId}`);
      this.writes++;
      const { resolvedAtMs: _r, ...out } = row;
      return { kind: 'created' as const, refund: { ...out } };
    });
  }

  async applyReturn(once: IdempotencyRequest, i: NewReturn): Promise<{ kind: 'created'; orderId: string } | { kind: 'replay'; resultRef: string }> {
    const seen = this.#seen(once);
    if (seen !== undefined) return { kind: 'replay', resultRef: seen };
    const detail = this.#owned(i.orderId, i.accountId);
    if (detail.order.fulfillment === 'WALLET' && i.entryOpensAtMs === undefined && i.reason === 'CHANGE_OF_MIND') throw merchReturnNotAllowed();
    const selected = resolveReturnItems(detail, i.itemIds, i.reason, i.entryOpensAtMs, i.nowMs);
    if (selected.some((item) => [...this.refundItems.values()].some((c) => c.itemId === item.itemId && c.resolvedAtMs === null))) throw merchReturnNotAllowed();
    for (const item of selected) {
      const stored = this.items.get(item.itemId)!;
      stored.status = 'RETURN_REQUESTED';
      stored.returnReason = i.reason;
      stored.returnTrackingNo = i.returnTrackingNo ?? null;
      stored.returnRequestedAt = new Date(i.nowMs);
    }
    this.#remember(once, `return:${i.orderId}`);
    this.writes++;
    return { kind: 'created', orderId: i.orderId };
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
