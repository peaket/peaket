// 굿즈 주문 Drizzle 저장소(core_app, BAT-600, ADR-0300 결정 4~9, ADR-0301 결정 2~5, docs/data.md §2·§4 경계 5·§5).
// 결제 접수·만료·결과 반영은 모두 주문 행을 FOR UPDATE로 잠그고 출발 상태일 때만 바꾸는 조건부 UPDATE다(하나만 이긴다).
// 결제 접수의 한정 재고 차감은 상품 ID 차례로 product_stock을 stock >= quantity 조건부로 깎는다(0행이면 저장점으로 되돌리고 주문을 FAILED로 끝낸다).
// 멱등 기록은 플랫폼 IdempotencyStore를 같은 트랜잭션의 첫 쓰기로 쓴다. 결제 참조(payment_ref)는 로그에 싣지 않는다.
import { timingSafeEqual } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { type Clock, type Database, type DbTransaction, IdempotencyStore, type IdempotencyRequest, idempotencyKeyReused } from '@peaket/platform';
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
} from '../../domain/merch-ports.js';
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
  refundAccountRetryTarget,
  REFUND_RETRY_DELAYS_MIN,
  REFUND_RETRY_MAX,
  REFUND_RETRY_MS,
  type RefundAccountRetryTarget,
  type ReleasedOrder,
  reservedUntilAfterAccept,
  resolveCancelItems,
  resolveReturnItems,
  type ShopOrder,
  type ShopOrderDetail,
  type ShopOrderItem,
  type ShopPg,
  UNCLAIMED_REASON,
} from '../../domain/merch-order.js';
import type { Fulfillment, ProductRecord } from '../../domain/product.js';

type Row = Record<string, unknown>;
const d = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));
const n = (v: unknown): number => Number(v);
const rowsOf = (r: { rows: unknown[] }): Row[] => r.rows as Row[];

function orderOf(r: Row): ShopOrder {
  return {
    orderId: String(r.id),
    accountId: String(r.account_id ?? ''),
    promoterId: String(r.promoter_id),
    eventId: (r.event_id as string | null) ?? null,
    fulfillment: (r.fulfillment as Fulfillment | null) ?? 'DELIVERY',
    status: r.status as ShopOrder['status'],
    amount: n(r.amount ?? 0),
    shippingFee: n(r.shipping_fee ?? 0),
    pgStore: r.pg_store as ShopOrder['pgStore'],
    pg: (r.pg as ShopPg | null) ?? null,
    paymentId: (r.payment_id as string | null) ?? null,
    stockReservedUntil: d(r.stock_reserved_until) ?? new Date(0),
    consentVersion: (r.consent_version as string | null) ?? null,
    recipientName: (r.recipient_name as string | null) ?? null,
    recipientPhone: (r.recipient_phone as string | null) ?? null,
    deliveryAddress: (r.delivery_address as string | null) ?? null,
    pickupSlotId: (r.pickup_slot_id as string | null) ?? null,
    escrow: r.escrow === true,
    orderedAt: d(r.ordered_at)!,
    paidAt: d(r.paid_at),
    purchaseConfirmedAt: d(r.purchase_confirmed_at),
  };
}

function itemOf(r: Row): ShopOrderItem {
  const snap = (r.option_snapshot as ShopOrderItem['optionSnapshot'] | null) ?? { options: {}, name: String(r.product_name), type: '', schemaVersion: 1 };
  return {
    itemId: String(r.id),
    orderId: String(r.order_id),
    promoterId: String(r.promoter_id),
    eventId: (r.event_id as string | null) ?? null,
    productId: String(r.product_id),
    productName: String(r.product_name),
    quantity: n(r.quantity),
    unitAmount: n(r.unit_amount),
    commissionRateBp: n(r.commission_rate_bp),
    status: r.status as ShopOrderItem['status'],
    fulfillment: r.fulfillment as Fulfillment,
    ticketLinked: r.ticket_linked === true,
    limited: r.limited === true,
    optionSnapshot: snap,
    linkedTicketId: (r.linked_ticket_id as string | null) ?? null,
    cancelReason: (r.cancel_reason as string | null) ?? null,
    refundedAmount: n(r.refunded_amount ?? 0),
    pickedUpAt: d(r.picked_up_at),
    eventEndsAt: d(r.event_ends_at),
    shippedAt: d(r.shipped_at),
    deliveredAt: d(r.delivered_at),
    returnRequestedAt: d(r.return_requested_at),
    returnReason: (r.return_reason as string | null) ?? null,
    returnTrackingNo: (r.return_tracking_no as string | null) ?? null,
    returnReceivedAt: d(r.return_received_at),
    rejectReason: (r.reject_reason as string | null) ?? null,
    trackingNo: (r.tracking_no as string | null) ?? null,
  };
}

function attemptOf(r: Row): MerchAttempt {
  return {
    attemptId: String(r.id),
    orderId: String(r.order_id),
    attemptNo: n(r.attempt_no),
    pg: r.pg as ShopPg,
    payMethod: (r.pay_method as string | null) ?? null,
    status: r.status as MerchAttempt['status'],
    createdAt: d(r.created_at)!,
    acceptedAt: d(r.accepted_at),
  };
}

function refOf(v: Record<string, string>): PaymentRef {
  return v.kind === 'portone' ? { kind: 'portone', paymentId: v.paymentId ?? '', txId: v.txId ?? '', paymentToken: v.paymentToken ?? '' } : { kind: 'toss', paymentKey: v.paymentKey ?? '' };
}

function jobOf(r: Row): ConfirmJob {
  return {
    orderId: String(r.order_id),
    attemptId: String(r.attempt_id),
    attemptNo: n(r.attempt_no),
    pg: r.pg as ShopPg,
    pgStore: (r.pg_store as ConfirmJob['pgStore'] | undefined) ?? 'STANDARD',
    ref: refOf(r.payment_ref as Record<string, string>),
    amount: n(r.amount),
    authenticatedAtMs: d(r.authenticated_at)!.getTime(),
    sent: r.sent === true,
    tries: n(r.tries),
  };
}

function refundOf(r: Row): RefundRow {
  return {
    refundId: String(r.id),
    orderId: String(r.order_id),
    paymentId: (r.payment_id as string | null) ?? null,
    itemIds: ((r.item_ids as string[] | null) ?? []).map(String),
    amount: n(r.amount),
    reason: String(r.reason),
    status: r.status as RefundRow['status'],
    createdAtMs: d(r.created_at)!.getTime(),
    alerted: r.alerted === true,
    kind: (r.kind as RefundRow['kind'] | undefined) ?? 'UNCLAIMED',
    attempts: n(r.attempts ?? 0),
    nextAtMs: d(r.next_at)?.getTime() ?? null,
    accountRequiredAtMs: d(r.account_required_at)?.getTime() ?? null,
    replacesRefundId: (r.replaces_refund_id as string | null) ?? null,
    // 사슬 깊이(원래 행 0). dueRefunds·dueUserRefunds가 재귀 질의로 `refund_depth`를 싣고, 나머지는 0이다
    refundAttempt: n(r.refund_depth ?? 0),
    failReason: (r.fail_reason as string | null) ?? null,
  };
}

function productOf(r: Row): OrderableProduct {
  const limitedQty = r.limited_qty === null || r.limited_qty === undefined ? null : n(r.limited_qty);
  const record: ProductRecord = {
    productId: String(r.id),
    promoterId: String(r.promoter_id),
    type: String(r.type),
    name: String(r.name),
    status: r.status as ProductRecord['status'],
    price: n(r.price),
    shippingFee: r.shipping_fee === null ? null : n(r.shipping_fee),
    returnShippingFee: r.return_shipping_fee === null ? null : n(r.return_shipping_fee),
    returnAddress: (r.return_address as string | null) ?? null,
    limitedQty,
    stock: limitedQty === null ? null : n(r.stock ?? 0),
    transferable: r.transferable === true,
    ticketLinked: r.ticket_linked === true,
    linkedEventId: (r.linked_event_id as string | null) ?? null,
    fulfillments: (r.fulfillments as Fulfillment[]) ?? [],
    saleStartsAt: d(r.sale_starts_at),
    saleEndsAt: d(r.sale_ends_at),
    commissionRateBp: r.commission_rate_bp === null ? null : n(r.commission_rate_bp),
    attributes: (r.attributes as Record<string, unknown>) ?? {},
    version: n(r.version),
    publishedAt: d(r.published_at),
    updatedAt: d(r.updated_at)!,
  };
  return { ...record, schemaVersion: n(r.schema_version ?? 1) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * PostgreSQL 오류 코드(SQLSTATE). Drizzle 0.44는 드라이버 오류를 `DrizzleQueryError`로 감싸므로
 * 실제 코드가 `cause`에 있다. 직접 `code`와 `cause` 사슬을 차례로 본다(다른 오류는 그대로 던진다).
 */
function isUniqueViolation(e: unknown): boolean {
  let cur: unknown = e;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof cur !== 'object' || cur === null) return false;
    const code = (cur as { code?: unknown }).code;
    if (code === '23505') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** 커서: 주문 시각(ms):주문 ID */
const encodeCursor = (o: ShopOrder): string => Buffer.from(`${o.orderedAt.getTime()}:${o.orderId}`).toString('base64url');
const decodeCursor = (c: string): { at: number; id: string } | undefined => {
  try {
    const [at, id] = Buffer.from(c, 'base64url').toString('utf8').split(':');
    const t = Number(at);
    return Number.isSafeInteger(t) && id && UUID.test(id) ? { at: t, id } : undefined;
  } catch {
    return undefined;
  }
};

class SoldOut extends Error {}

export class DrizzleShopOrderStore implements ShopOrderStore {
  readonly #idem: IdempotencyStore;

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {
    this.#idem = new IdempotencyStore({ clock });
  }

  async products(ids: readonly string[]): Promise<OrderableProduct[]> {
    const valid = ids.filter((id) => UUID.test(id));
    if (valid.length === 0) return [];
    const r = await this.db.db.execute(sql`
      select p.*, s.stock from product p left join product_stock s on s.product_id = p.id
      where p.id = any(${sql.param(valid)}::uuid[])`);
    return rowsOf(r).map(productOf);
  }

  async committedQuantities(accountId: string, productIds: readonly string[]): Promise<Map<string, number>> {
    const r = await this.db.db.execute(sql`
      select i.product_id, sum(i.quantity)::int as qty
      from merch_order o join merch_order_item i on i.order_id = o.id
      where o.account_id = ${accountId} and i.product_id = any(${sql.param([...productIds])}::uuid[])
        and i.status not in ('CANCELLED', 'REFUNDED')
        and (o.status = 'PAID' or (o.status = 'CREATED' and exists (select 1 from merch_payment_attempt a where a.order_id = o.id and a.status = 'ACCEPTED')))
      group by i.product_id`);
    return new Map(rowsOf(r).map((x) => [String(x.product_id), n(x.qty)]));
  }

  async pickupSlot(slotId: string): Promise<PickupSlotRecord | undefined> {
    if (!UUID.test(slotId)) return undefined;
    const r = rowsOf(await this.db.db.execute(sql`select * from pickup_slot where id = ${slotId}`));
    return r[0] ? slotOf(r[0]) : undefined;
  }

  async eventEndsAt(eventId: string): Promise<Date | null> {
    if (!UUID.test(eventId)) return null;
    const r = rowsOf(await this.db.db.execute(sql`select ends_at from event where id = ${eventId}`));
    return r[0] ? d(r[0].ends_at) : null;
  }

  async eventEntryOpensAt(eventId: string): Promise<Date | null> {
    if (!UUID.test(eventId)) return null;
    const r = rowsOf(await this.db.db.execute(sql`select coalesce(entry_opens_at, starts_at) as at from event where id = ${eventId}`));
    return r[0] ? d(r[0].at) : null;
  }

  async pickupSlotsOf(productIds: readonly string[]): Promise<PickupSlotRecord[]> {
    if (productIds.length === 0) return [];
    return rowsOf(await this.db.db.execute(sql`select * from pickup_slot where product_id = any(${sql.param([...productIds])}::uuid[])`)).map(slotOf);
  }

  async orderState(orderId: string): Promise<OrderState | undefined> {
    if (!UUID.test(orderId)) return undefined;
    const r = rowsOf(
      await this.db.db.execute(sql`
        select o.id, o.account_id, o.status, o.stock_reserved_until,
          exists (select 1 from merch_payment_attempt a where a.order_id = o.id and a.status = 'ACCEPTED') as accepted,
          coalesce((select json_agg(json_build_object('productId', i.product_id, 'quantity', i.quantity) order by i.product_id)
             from merch_order_item i join product p on p.id = i.product_id where i.order_id = o.id and p.limited_qty is not null), '[]'::json) as limited
        from merch_order o where o.id = ${orderId}`),
    );
    const x = r[0];
    if (!x) return undefined;
    return {
      orderId: String(x.id),
      accountId: String(x.account_id ?? ''),
      status: x.status as OrderState['status'],
      accepted: x.accepted === true,
      stockReservedUntilMs: d(x.stock_reserved_until)?.getTime() ?? 0,
      limited: x.limited as LimitedLine[],
    };
  }

  async rebuildSource(productId: string, nowMs: number): Promise<{ stock: number; reservations: RebuildReservation[] } | undefined> {
    const s = rowsOf(await this.db.db.execute(sql`select s.stock from product p join product_stock s on s.product_id = p.id where p.id = ${productId} and p.limited_qty is not null`));
    if (!s[0]) return undefined;
    const r = rowsOf(
      await this.db.db.execute(sql`
        select o.id, o.account_id, i.quantity, o.stock_reserved_until
        from merch_order o join merch_order_item i on i.order_id = o.id
        where i.product_id = ${productId} and o.status = 'CREATED' and o.stock_reserved_until > ${new Date(nowMs)}
          and not exists (select 1 from merch_payment_attempt a where a.order_id = o.id and a.status = 'ACCEPTED')`),
    );
    return {
      stock: n(s[0].stock),
      reservations: r.map((x) => ({ orderId: String(x.id), accountId: String(x.account_id), quantity: n(x.quantity), untilMs: d(x.stock_reserved_until)!.getTime() })),
    };
  }

  async replayOf(once: IdempotencyRequest): Promise<string | undefined> {
    const r = rowsOf(
      await this.db.db.execute(sql`
        select request_hash, result_ref from idempotency_record
        where account_ref = ${once.accountRef} and operation = ${once.operation} and idempotency_key = ${once.key}
          and created_at > ${new Date(this.clock.now() - 24 * 60 * 60 * 1000)}`),
    );
    const row = r[0];
    if (!row || row.result_ref === null) return undefined;
    const stored = Buffer.from(row.request_hash as Buffer);
    const hash = Buffer.from(once.requestHash);
    if (stored.length !== hash.length || !timingSafeEqual(stored, hash)) throw idempotencyKeyReused();
    return String(row.result_ref);
  }

  /** 멱등 기록을 첫 쓰기로 잡고 execute를 돈다. 다시 온 요청이면 결과 참조를 돌려준다 */
  async #once<T>(tx: DbTransaction, once: IdempotencyRequest, execute: () => Promise<{ resultRef: string; value: T }>): Promise<{ replay: string } | { value: T }> {
    let replay: string | undefined;
    const value = await this.#idem.run(tx, once, {
      execute: async () => {
        const out = await execute();
        return { resultRef: out.resultRef, value: { value: out.value } as { value: T } | undefined };
      },
      replay: async (ref) => {
        replay = ref;
        return undefined;
      },
    });
    return replay !== undefined ? { replay } : { value: value!.value };
  }

  async insertOrder(once: IdempotencyRequest, o: NewShopOrder): Promise<{ kind: 'created' } | { kind: 'replay'; resultRef: string }> {
    const r = await this.db.transaction((tx) =>
      this.#once(tx, once, async () => {
        const x = o.order;
        await tx.execute(sql`
          insert into merch_order (id, account_id, promoter_id, event_id, fulfillment, status, amount, stock_reserved_until, pg, pg_store, escrow, shipping_fee,
            consent_version, recipient_name, recipient_phone, delivery_address, pickup_slot_id, ordered_at)
          values (${x.orderId}, ${x.accountId}, ${x.promoterId}, ${x.eventId}, ${x.fulfillment}, 'CREATED', ${x.amount}, ${x.stockReservedUntil}, null, ${x.pgStore}, false, ${x.shippingFee},
            ${x.consentVersion}, ${x.recipientName}, ${x.recipientPhone}, ${x.deliveryAddress}, ${x.pickupSlotId}, ${x.orderedAt})`);
        for (const i of o.items) {
          await tx.execute(sql`
            insert into merch_order_item (id, order_id, promoter_id, event_id, product_id, product_name, quantity, unit_amount, commission_rate_bp, status, fulfillment,
              ticket_linked, event_ends_at, option_snapshot, linked_ticket_id)
            values (${i.itemId}, ${i.orderId}, ${i.promoterId}, ${i.eventId}, ${i.productId}, ${i.productName}, ${i.quantity}, ${i.unitAmount}, ${i.commissionRateBp}, 'READY', ${i.fulfillment},
              ${i.ticketLinked}, ${i.eventEndsAt}, ${JSON.stringify(i.optionSnapshot)}::jsonb, ${i.linkedTicketId})`);
        }
        return { resultRef: x.orderId, value: undefined };
      }),
    );
    return 'replay' in r ? { kind: 'replay', resultRef: r.replay } : { kind: 'created' };
  }

  async expireUnpaid(orderId: string, nowMs: number, mode: 'due' | 'superseded'): Promise<ReleasedOrder | undefined> {
    return this.db.transaction(async (tx) => {
      const now = new Date(nowMs);
      // 주문 행을 잠그고 조건부로 바꾼다. 결제 접수(같은 행 잠금)와 하나만 이긴다(P-T42 ③)
      const locked = rowsOf(await tx.execute(sql`select id from merch_order where id = ${orderId} for update`));
      if (!locked[0]) return undefined;
      const changed = rowsOf(
        await tx.execute(sql`
          update merch_order set status = 'EXPIRED'
          where id = ${orderId} and status = 'CREATED'
            and not exists (select 1 from merch_payment_attempt a where a.order_id = ${orderId} and a.status = 'ACCEPTED')
            ${mode === 'due' ? sql`and stock_reserved_until <= ${now}` : sql``}
          returning id, account_id`),
      );
      if (!changed[0]) return undefined;
      await tx.execute(sql`update merch_payment_attempt set status = 'EXPIRED' where order_id = ${orderId} and status = 'READY'`);
      return { orderId, accountId: String(changed[0].account_id ?? ''), limited: await limitedOf(tx, orderId) };
    });
  }

  async dueUnpaidOrders(nowMs: number, limit: number): Promise<string[]> {
    const r = await this.db.db.execute(sql`
      select o.id from merch_order o
      where o.status = 'CREATED' and o.stock_reserved_until <= ${new Date(nowMs)}
        and not exists (select 1 from merch_payment_attempt a where a.order_id = o.id and a.status = 'ACCEPTED')
      order by o.stock_reserved_until limit ${limit}`);
    return rowsOf(r).map((x) => String(x.id));
  }

  async findOrder(orderId: string): Promise<ShopOrderDetail | undefined> {
    if (!UUID.test(orderId)) return undefined;
    const o = rowsOf(await this.db.db.execute(sql`select * from merch_order where id = ${orderId} and account_id is not null`));
    if (!o[0]) return undefined;
    return (await this.#details([o[0]]))[0];
  }

  async paymentAttempt(attemptId: string): Promise<MerchAttempt | undefined> {
    if (!UUID.test(attemptId)) return undefined;
    const r = rowsOf(await this.db.db.execute(sql`select * from merch_payment_attempt where id = ${attemptId}`))[0];
    return r ? attemptOf(r) : undefined;
  }

  async #details(orders: Row[]): Promise<ShopOrderDetail[]> {
    if (orders.length === 0) return [];
    const ids = orders.map((o) => String(o.id));
    const items = rowsOf(
      await this.db.db.execute(sql`
        select i.*, (p.limited_qty is not null) as limited from merch_order_item i left join product p on p.id = i.product_id
        where i.order_id = any(${sql.param(ids)}::uuid[]) order by i.id`),
    );
    const attempts = rowsOf(await this.db.db.execute(sql`select * from merch_payment_attempt where order_id = any(${sql.param(ids)}::uuid[]) order by attempt_no`));
    const slotIds = orders.map((o) => o.pickup_slot_id).filter((x): x is string => typeof x === 'string');
    const slots = slotIds.length ? rowsOf(await this.db.db.execute(sql`select * from pickup_slot where id = any(${sql.param(slotIds)}::uuid[])`)) : [];
    return orders.map((row) => {
      const order = orderOf(row);
      const own = attempts.filter((a) => String(a.order_id) === order.orderId).map(attemptOf);
      const slot = slots.find((s) => String(s.id) === order.pickupSlotId);
      return {
        order,
        items: items.filter((i) => String(i.order_id) === order.orderId).map(itemOf),
        activeAttempt: own.find((a) => a.status === 'ACCEPTED') ?? own.find((a) => a.status === 'READY'),
        attemptCount: own.length,
        pickupWindow: slot ? { startsAt: d(slot.starts_at)!, endsAt: d(slot.ends_at)! } : null,
      };
    });
  }

  async listOrders(accountId: string, limit: number, cursor?: string): Promise<{ items: ShopOrderDetail[]; nextCursor: string | null }> {
    const c = cursor ? decodeCursor(cursor) : undefined;
    const r = rowsOf(
      await this.db.db.execute(sql`
        select * from merch_order
        where account_id = ${accountId} and status not in ('EXPIRED', 'FAILED')
          ${c ? sql`and (ordered_at < ${new Date(c.at)} or (ordered_at = ${new Date(c.at)} and id < ${c.id}))` : sql``}
        order by ordered_at desc, id desc limit ${limit + 1}`),
    );
    const page = await this.#details(r.slice(0, limit));
    return { items: page, nextCursor: r.length > limit && page.length > 0 ? encodeCursor(page[page.length - 1]!.order) : null };
  }

  async saveAttempt(once: IdempotencyRequest, a: NewAttempt): Promise<{ kind: 'saved' } | { kind: 'replay'; resultRef: string }> {
    const r = await this.db.transaction((tx) =>
      this.#once(tx, once, async () => {
        const detail = await this.#lockedDetail(tx, a.orderId, a.accountId);
        const blocked = attemptStartBlocker(detail, a.nowMs);
        if (blocked) throw blocked;
        await tx.execute(sql`update merch_payment_attempt set status = 'SUPERSEDED' where order_id = ${a.orderId} and status = 'READY'`);
        await tx.execute(sql`
          insert into merch_payment_attempt (id, order_id, attempt_no, pg, pay_method, status, created_at)
          values (${a.attemptId}, ${a.orderId}, ${detail.attemptCount + 1}, ${a.pg}, ${a.payMethod}, 'READY', ${new Date(a.nowMs)})`);
        return { resultRef: a.responseJson, value: undefined };
      }),
    );
    return 'replay' in r ? { kind: 'replay', resultRef: r.replay } : { kind: 'saved' };
  }

  /** 주문 행을 FOR UPDATE로 잠그고 시도까지 읽는다. 없거나 남의 주문이면 404 */
  async #lockedDetail(tx: DbTransaction, orderId: string, accountId: string, withItems = false): Promise<ShopOrderDetail> {
    if (!UUID.test(orderId)) throw orderNotFound();
    const o = rowsOf(await tx.execute(sql`select * from merch_order where id = ${orderId} for update`));
    if (!o[0] || o[0].account_id !== accountId) throw orderNotFound();
    const attempts = rowsOf(await tx.execute(sql`select * from merch_payment_attempt where order_id = ${orderId} order by attempt_no`)).map(attemptOf);
    const items = withItems
      ? rowsOf(await tx.execute(sql`select i.*, (p.limited_qty is not null) as limited from merch_order_item i left join product p on p.id = i.product_id where i.order_id = ${orderId} order by i.id`)).map(itemOf)
      : [];
    return {
      order: orderOf(o[0]),
      items,
      activeAttempt: attempts.find((x) => x.status === 'ACCEPTED') ?? attempts.find((x) => x.status === 'READY'),
      attemptCount: attempts.length,
      pickupWindow: null,
    };
  }

  async acceptPayment(once: IdempotencyRequest, i: { orderId: string; accountId: string; nowMs: number; body: AcceptBody; ref: PaymentRef }): Promise<AcceptOutcome> {
    const r = await this.db.transaction((tx) =>
      this.#once<AcceptOutcome>(tx, once, async () => {
        const detail = await this.#lockedDetail(tx, i.orderId, i.accountId);
        const blocked = acceptBlocker(detail, i.body, i.nowMs);
        if (blocked) throw blocked;
        const attempt = detail.activeAttempt!;
        const limited = await limitedOf(tx, i.orderId);
        const now = new Date(i.nowMs);
        // 한정 상품마다 상품 ID 차례로 조건부 차감. 하나라도 0행이면 저장점째 되돌리고 주문을 FAILED(O6)로 끝낸다
        try {
          await tx.transaction(async (sp) => {
            for (const l of limited) {
              const u = rowsOf(
                await sp.execute(sql`update product_stock set stock = stock - ${l.quantity}, updated_at = ${now} where product_id = ${l.productId} and stock >= ${l.quantity} returning product_id`),
              );
              if (!u[0]) throw new SoldOut();
            }
          });
        } catch (e) {
          if (!(e instanceof SoldOut)) throw e;
          await tx.execute(sql`update merch_order set status = 'FAILED' where id = ${i.orderId} and status = 'CREATED'`);
          await tx.execute(sql`update merch_payment_attempt set status = 'FAILED' where order_id = ${i.orderId} and status = 'READY'`);
          return { resultRef: 'sold-out', value: { kind: 'sold-out', limited } };
        }
        const reservedUntil = reservedUntilAfterAccept(detail.order.stockReservedUntil, i.nowMs);
        await tx.execute(sql`update merch_payment_attempt set status = 'ACCEPTED', accepted_at = ${now} where id = ${attempt.attemptId} and status = 'READY'`);
        await tx.execute(sql`update merch_order set pg = ${attempt.pg}, stock_reserved_until = ${reservedUntil} where id = ${i.orderId} and status = 'CREATED'`);
        const job: ConfirmJob = {
          orderId: i.orderId,
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          pg: attempt.pg,
          pgStore: detail.order.pgStore,
          ref: i.ref,
          amount: detail.order.amount,
          authenticatedAtMs: i.nowMs,
          sent: false,
          tries: 0,
        };
        await tx.execute(sql`
          insert into merch_confirm_job (order_id, attempt_id, attempt_no, pg, payment_ref, amount, authenticated_at, sent, tries, next_at)
          values (${job.orderId}, ${job.attemptId}, ${job.attemptNo}, ${job.pg}, ${JSON.stringify(job.ref)}::jsonb, ${job.amount}, ${now}, false, 0, ${now})`);
        return { resultRef: 'accepted', value: { kind: 'accepted', job, limited, reservedUntil } };
      }),
    );
    return 'replay' in r ? { kind: 'replay', resultRef: r.replay } : r.value;
  }

  async markConfirmSent(orderId: string, nextAtMs: number): Promise<void> {
    await this.db.db.execute(sql`update merch_confirm_job set sent = true, tries = tries + 1, next_at = ${new Date(nextAtMs)} where order_id = ${orderId}`);
  }

  async rescheduleJob(orderId: string, nextAtMs: number, o: { tries?: number; sent?: boolean } = {}): Promise<void> {
    await this.db.db.execute(sql`
      update merch_confirm_job set next_at = ${new Date(nextAtMs)}
        ${o.tries !== undefined ? sql`, tries = ${o.tries}` : sql``}
        ${o.sent !== undefined ? sql`, sent = ${o.sent}` : sql``}
      where order_id = ${orderId}`);
  }

  async claimDueJobs(nowMs: number, limit: number, leaseUntilMs: number): Promise<ConfirmJob[]> {
    return this.db.transaction(async (tx) => {
      const r = rowsOf(
        await tx.execute(sql`
          update merch_confirm_job j set next_at = ${new Date(leaseUntilMs)}
          from (select k.order_id, o.pg_store from merch_confirm_job k join merch_order o on o.id = k.order_id
                 where k.next_at <= ${new Date(nowMs)} order by k.next_at limit ${limit} for update of k skip locked) due
          where j.order_id = due.order_id
          returning j.*, due.pg_store`),
      );
      return r.map(jobOf);
    });
  }

  async applyPaid(orderId: string, x: { paymentId: string; pg: ShopPg | undefined; approvedAtMs: number }): Promise<ReleasedOrder | undefined> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select id from merch_order where id = ${orderId} for update`);
      const changed = rowsOf(
        await tx.execute(sql`
          update merch_order set status = 'PAID', payment_id = ${x.paymentId}, paid_at = ${new Date(x.approvedAtMs)} ${x.pg ? sql`, pg = ${x.pg}` : sql``}
          where id = ${orderId} and status in ('CREATED', 'AWAITING_DEPOSIT') returning id, account_id`),
      );
      await tx.execute(sql`delete from merch_confirm_job where order_id = ${orderId}`);
      if (!changed[0]) return undefined;
      return { orderId, accountId: String(changed[0].account_id ?? ''), limited: await limitedOf(tx, orderId) };
    });
  }

  /**
   * 결과 실패 반영. CREATED면 FAILED(O6), 입금 대기면 EXPIRED(입금 기한 + 10분 경과, T17과 같은 끝).
   * 접수한 주문이면 product_stock을 되돌린다(ASVS 2.3.3)
   */
  async applyFailed(orderId: string, nowMs: number): Promise<ReleasedOrder | undefined> {
    return this.db.transaction(async (tx) => {
      const locked = rowsOf(await tx.execute(sql`select status, account_id from merch_order where id = ${orderId} for update`))[0];
      if (!locked) return undefined;
      const from = String(locked.status);
      if (from !== 'CREATED' && from !== 'AWAITING_DEPOSIT') return undefined;
      const accepted = rowsOf(await tx.execute(sql`select 1 from merch_payment_attempt where order_id = ${orderId} and status = 'ACCEPTED'`)).length > 0;
      const to = from === 'AWAITING_DEPOSIT' ? 'EXPIRED' : 'FAILED';
      const changed = rowsOf(await tx.execute(sql`update merch_order set status = ${to} where id = ${orderId} and status = ${from} returning id, account_id`));
      await tx.execute(sql`delete from merch_confirm_job where order_id = ${orderId}`);
      if (!changed[0]) return undefined;
      await tx.execute(sql`update merch_payment_attempt set status = ${from === 'AWAITING_DEPOSIT' ? 'EXPIRED' : 'FAILED'} where order_id = ${orderId} and status in ('READY', 'ACCEPTED')`);
      const limited = await limitedOf(tx, orderId);
      // 접수 때 깎은 product_stock을 같은 트랜잭션에서 되돌린다(ASVS 2.3.3)
      if (accepted) for (const l of limited) await tx.execute(sql`update product_stock set stock = stock + ${l.quantity}, updated_at = ${new Date(nowMs)} where product_id = ${l.productId}`);
      return { orderId, accountId: String(changed[0].account_id ?? ''), limited };
    });
  }

  async applyAwaitingDeposit(orderId: string, x: { paymentId: string; pg: ShopPg | undefined; depositDueAtMs: number | undefined; nowMs: number }): Promise<{ orderId: string; accountId: string; deadline: Date; limited: LimitedLine[] } | undefined> {
    const deadline = new Date(depositDeadlineMs(x.depositDueAtMs, x.nowMs));
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select id from merch_order where id = ${orderId} for update`);
      const changed = rowsOf(
        await tx.execute(sql`
          update merch_order set status = 'AWAITING_DEPOSIT', payment_id = ${x.paymentId}, stock_reserved_until = ${deadline} ${x.pg ? sql`, pg = ${x.pg}` : sql``}
          where id = ${orderId} and status = 'CREATED' returning id, account_id`),
      );
      if (!changed[0]) return undefined;
      return { orderId, accountId: String(changed[0].account_id ?? ''), deadline, limited: await limitedOf(tx, orderId) };
    });
  }

  async dueDepositOrders(nowMs: number, limit: number): Promise<string[]> {
    const r = await this.db.db.execute(sql`
      select id from merch_order where status = 'AWAITING_DEPOSIT' and stock_reserved_until <= ${new Date(nowMs)}
      order by stock_reserved_until limit ${limit}`);
    return rowsOf(r).map((x) => String(x.id));
  }

  async expireDeposit(orderId: string, nowMs: number): Promise<ReleasedOrder | undefined> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select id from merch_order where id = ${orderId} for update`);
      const changed = rowsOf(await tx.execute(sql`update merch_order set status = 'EXPIRED' where id = ${orderId} and status = 'AWAITING_DEPOSIT' returning id, account_id`));
      if (!changed[0]) return undefined;
      await tx.execute(sql`delete from merch_confirm_job where order_id = ${orderId}`);
      await tx.execute(sql`update merch_payment_attempt set status = 'EXPIRED' where order_id = ${orderId} and status in ('READY', 'ACCEPTED')`);
      const limited = await limitedOf(tx, orderId);
      for (const l of limited) await tx.execute(sql`update product_stock set stock = stock + ${l.quantity}, updated_at = ${new Date(nowMs)} where product_id = ${l.productId}`);
      return { orderId, accountId: String(changed[0].account_id ?? ''), limited };
    });
  }

  async limitedProducts(): Promise<{ productId: string; saleEndsAt: Date | null }[]> {
    const r = await this.db.db.execute(sql`select id, sale_ends_at from product where limited_qty is not null and status <> 'DRAFT' order by id`);
    return rowsOf(r).map((x) => ({ productId: String(x.id), saleEndsAt: d(x.sale_ends_at) }));
  }

  async addonItems(ticketId: string): Promise<AddonItemRow[]> {
    if (!UUID.test(ticketId)) return [];
    const r = await this.db.db.execute(sql`
      select o.id as order_id, o.account_id, o.event_id, i.id as item_id, i.product_id, i.product_name, i.quantity, i.status, coalesce(p.transferable, false) as transferable
      from merch_order_item i join merch_order o on o.id = i.order_id left join product p on p.id = i.product_id
      where i.linked_ticket_id = ${ticketId} and o.status = 'PAID' order by i.id`);
    return rowsOf(r).map((x) => ({
      orderId: String(x.order_id),
      accountId: String(x.account_id ?? ''),
      itemId: String(x.item_id),
      productId: String(x.product_id),
      name: String(x.product_name),
      quantity: n(x.quantity),
      status: x.status as AddonItemRow['status'],
      eventId: (x.event_id as string | null) ?? null,
      transferable: x.transferable === true,
    }));
  }

  async unclaimedCandidates(nowMs: number, limit: number): Promise<UnclaimedCandidate[]> {
    const r = rowsOf(
      await this.db.db.execute(sql`
        select o.id as order_id, o.payment_id, i.id as item_id, i.product_id, i.quantity, i.unit_amount, last.ends_at as last_ends_at
        from merch_order o
        join merch_order_item i on i.order_id = o.id
        join lateral (select max(s.ends_at) as ends_at from pickup_slot s where s.product_id = i.product_id and s.event_id = o.event_id) last on true
        where o.status = 'PAID' and o.fulfillment = 'PICKUP' and i.status = 'READY' and last.ends_at is not null and last.ends_at <= ${new Date(nowMs)}
        order by o.id, i.id
        limit ${limit}`),
    );
    const byOrder = new Map<string, UnclaimedCandidate>();
    for (const x of r) {
      const id = String(x.order_id);
      const c = byOrder.get(id) ?? { orderId: id, paymentId: (x.payment_id as string | null) ?? null, items: [] };
      c.items.push({ itemId: String(x.item_id), productId: String(x.product_id), quantity: n(x.quantity), unitAmount: n(x.unit_amount), lastSlotEndsAtMs: d(x.last_ends_at)!.getTime() });
      byOrder.set(id, c);
    }
    return [...byOrder.values()];
  }

  async cancelUnclaimed(orderId: string, itemIds: readonly string[], refundId: string, nowMs: number): Promise<RefundRow | undefined> {
    return this.db.transaction(async (tx) => {
      const now = new Date(nowMs);
      // 구매자 취소(createCancellation)와 같은 주문 행 잠금으로 줄을 세운다(RV-29).
      // 구매자의 미커밋 환급 행·자리는 이 잠금이 풀린 뒤의 문장에서 보인다.
      await tx.execute(sql`select id from merch_order where id = ${orderId} for update`);
      // 교환권 확인(READY → PICKED_UP)과 같은 항목에 겹쳐도 READY일 때만 바꾸므로 하나만 이긴다(docs/data.md §5).
      // 구매자 취소가 진행 중인 항목(활성 merch_refund_item)은 건너뛴다(RV-03, 이중 환급 0)
      const changed = rowsOf(
        await tx.execute(sql`
          update merch_order_item set status = 'CANCELLED', cancel_reason = ${UNCLAIMED_REASON}
          where order_id = ${orderId} and id = any(${sql.param([...itemIds])}::uuid[]) and status = 'READY'
            and not exists (select 1 from merch_refund_item ri where ri.item_id = merch_order_item.id and ri.resolved_at is null)
          returning id, quantity, unit_amount`),
      );
      if (changed.length === 0) return undefined;
      const amount = changed.reduce((s, x) => s + n(x.quantity) * n(x.unit_amount), 0);
      const ids = changed.map((x) => String(x.id));
      await tx.execute(sql`
        insert into merch_refund (id, order_id, item_ids, amount, reason, status, kind, attempts, next_at, alerted, created_at, updated_at)
        values (${refundId}, ${orderId}, ${sql.param(ids)}::uuid[], ${amount}, ${UNCLAIMED_REASON}, 'REQUESTED', 'UNCLAIMED', 0, ${new Date(nowMs + REFUND_RETRY_MS)}, false, ${now}, ${now})`);
      const p = rowsOf(await tx.execute(sql`select payment_id from merch_order where id = ${orderId}`));
      return {
        refundId,
        orderId,
        paymentId: (p[0]?.payment_id as string | null) ?? null,
        itemIds: ids,
        amount,
        reason: UNCLAIMED_REASON,
        status: 'REQUESTED',
        createdAtMs: nowMs,
        alerted: false,
        kind: 'UNCLAIMED',
        attempts: 0,
        nextAtMs: nowMs + REFUND_RETRY_MS,
        accountRequiredAtMs: null,
        replacesRefundId: null,
        refundAttempt: 0,
        failReason: null,
      };
    });
  }

  async dueRefunds(nowMs: number, limit: number): Promise<RefundRow[]> {
    const r = await this.db.db.execute(sql`
      with recursive refund_chain(id, depth) as (
        select id, 0 from merch_refund where replaces_refund_id is null
        union all
        select f.id, c.depth + 1 from merch_refund f join refund_chain c on f.replaces_refund_id = c.id
      )
      select f.*, o.payment_id, coalesce(rc.depth, 0) as refund_depth from merch_refund f join merch_order o on o.id = f.order_id
      left join refund_chain rc on rc.id = f.id
      where f.kind = 'UNCLAIMED' and f.status in ('REQUESTED', 'CANCEL_PENDING') and f.next_at <= ${new Date(nowMs)} order by f.next_at limit ${limit}`);
    return rowsOf(r).map(refundOf);
  }

  async dueUserRefunds(nowMs: number, limit: number): Promise<RefundRow[]> {
    const r = await this.db.db.execute(sql`
      with recursive refund_chain(id, depth) as (
        select id, 0 from merch_refund where replaces_refund_id is null
        union all
        select f.id, c.depth + 1 from merch_refund f join refund_chain c on f.replaces_refund_id = c.id
      )
      select f.*, o.payment_id, coalesce(rc.depth, 0) as refund_depth from merch_refund f join merch_order o on o.id = f.order_id
      left join refund_chain rc on rc.id = f.id
      where f.kind in ('USER_CANCEL', 'RETURN') and f.status in ('REQUESTED', 'CANCEL_PENDING')
        and f.account_required_at is null and f.next_at <= ${new Date(nowMs)} order by f.next_at limit ${limit}`);
    return rowsOf(r).map(refundOf);
  }

  async refundResult(
    refundId: string,
    outcome: CancelOutcome,
    nowMs: number,
    o: { alerted?: boolean; attempts?: number; nextAtMs?: number | null; failReason?: string; accountRequiredAtMs?: number } = {},
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const now = new Date(nowMs);
      const f = rowsOf(await tx.execute(sql`select * from merch_refund where id = ${refundId} for update`))[0];
      if (!f || f.status === 'CANCELLED' || f.status === 'REJECTED') return;
      const kind = (f.kind as RefundRow['kind'] | undefined) ?? 'UNCLAIMED';
      const ids = sql.param(f.item_ids as string[]);
      const attempts = o.attempts === undefined ? sql`` : sql`, attempts = ${o.attempts}`;
      const alerted = o.alerted === undefined ? sql`` : sql`, alerted = ${o.alerted}`;
      if (outcome === 'CANCELLED') {
        if (kind === 'UNCLAIMED') {
          await tx.execute(sql`
            update merch_order_item set status = 'REFUNDED', refunded_amount = quantity * unit_amount
            where id = any(${ids}::uuid[]) and status = 'CANCELLED'`);
        } else {
          await tx.execute(sql`
            update merch_order_item set status = 'REFUNDED', cancel_reason = 'USER_CANCEL', refunded_amount = quantity * unit_amount
            where id = any(${ids}::uuid[]) and status in ('READY', 'CANCELLED')`);
        }
        await tx.execute(sql`update merch_refund set status = 'CANCELLED', next_at = null, fail_reason = null, updated_at = ${now} ${attempts} ${alerted} where id = ${refundId}`);
        await tx.execute(sql`update merch_refund_item set resolved_at = ${now} where refund_id = ${refundId} and resolved_at is null`);
      } else if (outcome === 'REJECTED' || outcome === 'REFUND_ACCOUNT_REQUIRED') {
        const fail = o.failReason ?? (outcome === 'REFUND_ACCOUNT_REQUIRED' ? 'REFUND_ACCOUNT_REQUIRED' : 'PG_REJECTED');
        const account = outcome === 'REFUND_ACCOUNT_REQUIRED' ? sql`, account_required_at = ${new Date(o.accountRequiredAtMs ?? nowMs)}` : sql``;
        // 성공 전 거절이면 취소 효력도 되돌린다(READY, 환급액 0). 새 키로 다시 취소할 수 있다(RV-30)
        if (kind !== 'UNCLAIMED') {
          await tx.execute(sql`
            update merch_order_item set status = 'READY', cancel_reason = null, refunded_amount = 0
            where id = any(${ids}::uuid[]) and status = 'CANCELLED'`);
        }
        await tx.execute(sql`update merch_refund set status = 'REJECTED', next_at = null, fail_reason = ${fail}, updated_at = ${now} ${attempts} ${alerted} ${account} where id = ${refundId}`);
        await tx.execute(sql`update merch_refund_item set resolved_at = ${now} where refund_id = ${refundId} and resolved_at is null`);
      } else {
        if (kind !== 'UNCLAIMED') {
          // 취소 효력은 결제사 답을 받은 즉시다(REFUND_PENDING·UNKNOWN). 항목은 다시 팔지 않는다
          await tx.execute(sql`
            update merch_order_item set status = 'CANCELLED', cancel_reason = 'USER_CANCEL'
            where id = any(${ids}::uuid[]) and status = 'READY'`);
        }
        const next = o.nextAtMs === undefined ? nowMs + REFUND_RETRY_MS : o.nextAtMs;
        await tx.execute(sql`update merch_refund set status = 'CANCEL_PENDING', next_at = ${next === null ? null : new Date(next)}, updated_at = ${now} ${attempts} ${alerted} where id = ${refundId}`);
      }
    });
  }

  async createCancellation(once: IdempotencyRequest, i: NewCancellation): Promise<{ kind: 'created'; refund: RefundRow } | { kind: 'replay'; resultRef: string }> {
    const r = await this.db.transaction((tx) =>
      this.#once(tx, once, async () => {
        const detail = await this.#lockedDetail(tx, i.orderId, i.accountId, true);
        // 입장 시작을 읽지 못한 부가 상품은 닫힌 쪽으로 답한다(RV-04)
        if (detail.order.fulfillment === 'WALLET' && i.entryOpensAtMs === undefined) throw entryStarted();
        const selection = resolveCancelItems(detail, i.itemIds, i.entryOpensAtMs, i.nowMs);
        const ids = selection.items.map((x) => x.itemId);
        const amount = selection.amount;
        const now = new Date(i.nowMs);
        await tx.execute(sql`
          insert into merch_refund (id, order_id, item_ids, amount, reason, status, kind, attempts, next_at, alerted, created_at, updated_at)
          values (${i.refundId}, ${i.orderId}, ${sql.param(ids)}::uuid[], ${amount}, 'USER_CANCEL', 'REQUESTED', 'USER_CANCEL', 0, ${new Date(i.nowMs + REFUND_RETRY_DELAYS_MIN[0] * 60_000)}, false, ${now}, ${now})`);
        // 항목 하나에 진행 중 환급 하나(부분 유일). 같은 항목에 다른 환급이 겹치면 409로 끝난다
        try {
          for (const id of ids) await tx.execute(sql`insert into merch_refund_item (refund_id, item_id) values (${i.refundId}, ${id})`);
        } catch (e) {
          if (isUniqueViolation(e)) throw merchCancelNotAllowed();
          throw e;
        }
        const refund: RefundRow = {
          refundId: i.refundId,
          orderId: i.orderId,
          paymentId: detail.order.paymentId,
          itemIds: ids,
          amount,
          reason: 'USER_CANCEL',
          status: 'REQUESTED',
          createdAtMs: i.nowMs,
          alerted: false,
          kind: 'USER_CANCEL',
          attempts: 0,
          nextAtMs: i.nowMs + REFUND_RETRY_DELAYS_MIN[0] * 60_000,
          accountRequiredAtMs: null,
          replacesRefundId: null,
          refundAttempt: 0,
          failReason: null,
        };
        return { resultRef: `cancel:${i.refundId}`, value: { kind: 'created' as const, refund } };
      }),
    );
    return 'replay' in r ? { kind: 'replay', resultRef: r.replay } : r.value;
  }

  async cancelView(refundId: string): Promise<CancelRowView | undefined> {
    if (!UUID.test(refundId)) return undefined;
    const r = rowsOf(await this.db.db.execute(sql`select * from merch_refund where id = ${refundId}`))[0];
    if (!r) return undefined;
    return {
      cancellationId: refundId,
      orderId: String(r.order_id),
      status: 'REFUND_PENDING',
      refundAmount: n(r.amount),
      refundAccountRequired: r.account_required_at !== null && r.account_required_at !== undefined,
      state: r.status === 'CANCELLED' ? 'CANCELLED' : r.status === 'REJECTED' ? 'REJECTED' : r.status === 'REQUESTED' ? 'REQUESTED' : 'PENDING',
    };
  }

  // ---- 굿즈 지연 환급 계좌 다시 받기(ADR-0316 결정 5, R-T43) ----

  async findRejectedAccountRequired(orderId: string, accountId: string, cancellationId: string): Promise<RefundAccountRetryTarget | undefined> {
    if (!UUID.test(orderId) || !UUID.test(cancellationId)) return undefined;
    const owns = rowsOf(await this.db.db.execute(sql`select id from merch_order where id = ${orderId} and account_id = ${accountId}`));
    if (!owns[0]) return undefined;
    return refundAccountRetryTarget(await this.#refundsOf(this.db.db, orderId), cancellationId);
  }

  async beginAccountRetry(once: IdempotencyRequest, i: BeginRefundAccountRetry): Promise<{ kind: 'created'; refund: RefundRow } | { kind: 'replay'; resultRef: string }> {
    const r = await this.db.transaction((tx) =>
      this.#once(tx, once, async () => {
        // 주문 행 잠금(미수령 자동 취소·구매자 취소와 같은 줄). 소유는 잠근 행에서 다시 본다
        const own = rowsOf(await tx.execute(sql`select id, payment_id from merch_order where id = ${i.orderId} and account_id = ${i.accountId} for update`));
        if (!own[0]) throw orderNotFound();
        const target = refundAccountRetryTarget(await this.#refundsOf(tx, i.orderId), i.cancellationId);
        if (!target) throw orderNotFound();
        // 그사이 다른 요청이 새 행을 만들었으면 끝 행이 REQUESTED라 409다(자격 다시 보기)
        assertRefundAccountRetryable(target);
        const tip = target.row;
        const now = new Date(i.nowMs);
        const paymentId = (own[0].payment_id as string | null) ?? null;
        await tx.execute(sql`
          insert into merch_refund (id, order_id, item_ids, amount, reason, status, kind, attempts, next_at, alerted, created_at, updated_at, replaces_refund_id)
          values (${i.refundId}, ${i.orderId}, ${sql.param(tip.itemIds)}::uuid[], ${tip.amount}, ${tip.reason}, 'REQUESTED', ${tip.kind}, 0,
            ${new Date(i.nowMs + REFUND_ACCOUNT_RETRY_MS)}, false, ${now}, ${now}, ${tip.refundId})`);
        // 항목 하나에 진행 중 환급 하나(부분 유일). 옛 행의 자리는 거절 때 이미 풀렸다
        try {
          for (const id of tip.itemIds) await tx.execute(sql`insert into merch_refund_item (refund_id, item_id) values (${i.refundId}, ${id})`);
        } catch (e) {
          if (isUniqueViolation(e)) throw merchCancelNotAllowed();
          throw e;
        }
        const refund: RefundRow = {
          refundId: i.refundId,
          orderId: i.orderId,
          paymentId,
          itemIds: tip.itemIds,
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
        };
        return { resultRef: `cancel:${i.refundId}`, value: { kind: 'created' as const, refund } };
      }),
    );
    return 'replay' in r ? { kind: 'replay', resultRef: r.replay } : r.value;
  }

  /** 그 주문의 환급 행 전부(사슬 따라가기용). 적은 수라 한 번에 읽는다 */
  async #refundsOf(db: { execute: (q: SQL) => Promise<{ rows: unknown[] }> }, orderId: string): Promise<RefundRow[]> {
    return rowsOf(await db.execute(sql`select * from merch_refund where order_id = ${orderId} order by created_at, id`)).map(refundOf);
  }

  async applyReturn(once: IdempotencyRequest, i: NewReturn): Promise<{ kind: 'created'; orderId: string } | { kind: 'replay'; resultRef: string }> {
    const r = await this.db.transaction((tx) =>
      this.#once(tx, once, async () => {
        const detail = await this.#lockedDetail(tx, i.orderId, i.accountId, true);
        // 입장 시작을 읽지 못한 부가 상품의 단순 변심 반품은 받지 않는다(RV-04). 이상·다름은 입장 뒤에도 받는다
        if (detail.order.fulfillment === 'WALLET' && i.entryOpensAtMs === undefined && i.reason === 'CHANGE_OF_MIND') throw merchReturnNotAllowed();
        const selected = resolveReturnItems(detail, i.itemIds, i.reason, i.entryOpensAtMs, i.nowMs);
        // 구매자 취소가 진행 중인 항목(활성 merch_refund_item)에는 반품을 받지 않는다(RV-02, docs/data.md §5)
        const ids = selected.map((x) => x.itemId);
        const active = rowsOf(
          await tx.execute(sql`
            select 1 from merch_refund_item where item_id = any(${sql.param(ids)}::uuid[]) and resolved_at is null limit 1`),
        );
        if (active.length > 0) throw merchReturnNotAllowed();
        const now = new Date(i.nowMs);
        for (const item of selected) {
          const changed = rowsOf(
            await tx.execute(sql`
              update merch_order_item set status = 'RETURN_REQUESTED', return_reason = ${i.reason}, return_tracking_no = ${i.returnTrackingNo ?? null},
                return_requested_at = ${now}, return_resolved_at = null
              where id = ${item.itemId} and status = ${item.status} returning id`),
          );
          if (!changed[0]) throw merchReturnNotAllowed();
        }
        return { resultRef: `return:${i.orderId}`, value: { kind: 'created' as const, orderId: i.orderId } };
      }),
    );
    return 'replay' in r ? { kind: 'replay', resultRef: r.replay } : r.value;
  }

  async productAttributesPage(afterId: string | undefined, limit: number): Promise<{ productId: string; type: string; schemaVersion: number; attributes: unknown }[]> {
    const r = await this.db.db.execute(sql`
      select id, type, schema_version, attributes from product ${afterId ? sql`where id > ${afterId}` : sql``} order by id limit ${limit}`);
    return rowsOf(r).map((x) => ({ productId: String(x.id), type: String(x.type), schemaVersion: n(x.schema_version), attributes: x.attributes }));
  }
}

/** 그 주문의 한정 상품 항목(상품 ID 차례, 같은 상품이 둘이면 합친다) */
async function limitedOf(tx: DbTransaction, orderId: string): Promise<LimitedLine[]> {
  const r = rowsOf(
    await tx.execute(sql`
      select i.product_id, sum(i.quantity)::int as qty from merch_order_item i join product p on p.id = i.product_id
      where i.order_id = ${orderId} and p.limited_qty is not null group by i.product_id order by i.product_id`),
  );
  return r.map((x) => ({ productId: String(x.product_id), quantity: n(x.qty) }));
}

function slotOf(r: Row): PickupSlotRecord {
  return { slotId: String(r.id), productId: String(r.product_id), eventId: String(r.event_id), startsAt: d(r.starts_at)!, endsAt: d(r.ends_at)!, ticketHoldersOnly: r.ticket_holders_only === true };
}

/** 상품 유형 표(product_type)를 core_app으로 읽는다 */
export class DrizzleProductTypeDirectory {
  constructor(private readonly db: Database) {}
  async find(code: string): Promise<{ code: string; latestSchemaVersion: number; enabled: boolean } | undefined> {
    const r = rowsOf(await this.db.db.execute(sql`select code, latest_schema_version, enabled from product_type where code = ${code}`));
    return r[0] ? { code: String(r[0].code), latestSchemaVersion: n(r[0].latest_schema_version), enabled: r[0].enabled === true } : undefined;
  }
}

