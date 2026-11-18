// 굿즈 주문 만들기(POST /v1/shop/orders)와 티켓 연동 부가 상품 주문(POST /v1/tickets/{ticketId}/addons)(BUILD_ORDER LCH-010·LCH-020, ADR-0300 결정 4, ADR-0301 결정 2·4).
// 차례: 같은 멱등 키의 커밋한 결과가 있으면 그대로 → 상품 검사(⑥ 판매 중·수령 방식·티켓 연동, ① 한 판매자·한 수령 방식, ⑤ 옵션)
// → 수령 방식 규칙(택배 동의·문안 판, 현장 수령 시간대, 부가 상품은 지금 보유자 확인) → 계정당 한도(④) → 금액 계산
// → 한정 상품마다 상품 ID 오름차순으로 RESERVE(PREV·NO_COUNTER를 한 번씩 풀고 다시) → 주문·항목을 한 트랜잭션으로(멱등 기록 포함).
// 예약 뒤에 실패하면 잡은 예약을 RELEASE(restore=1)로 푼다. 풀지 못하고 죽으면 만료 작업이 'DB에 없는 주문'으로 돌린다(ADR-0300 결정 7).
import { uuidv7, type Clock, type IdempotencyRequest } from '@peaket/platform';
import {
  checkOrderLines,
  checkPerAccountLimit,
  consentRequired,
  consentVersionOutdated,
  dependencyUnavailable,
  merchOrderInProgress,
  merchProductUnavailable,
  merchSoldOut,
  orderAmount,
  orderNotFound,
  type OrderableProduct,
  type OrderLineInput,
  type OrderPath,
  pickupSlotUnavailable,
  type ShopOrder,
  type ShopOrderItem,
  ShopProblem,
  STOCK_RESERVATION_MS,
  stockKeyTtlSeconds,
} from '../domain/merch-order.js';
import { type HeldTicketsPort, HeldTicketsUnavailable, type MerchStock, type ReserveResult, type ShopOrderStore, StockUnavailable } from '../domain/merch-ports.js';
import type { Fulfillment } from '../domain/product.js';
import { type ShopLogger, type ShopSignals, silentShopLogger } from './shop-signals.js';

export interface MerchOrderDeps {
  store: ShopOrderStore;
  stock: MerchStock;
  held: HeldTicketsPort;
  clock: Clock;
  /** 택배 주문의 동의 문안 판(PEAKET_MERCH_CONSENT_VERSION). 없으면 택배 주문은 503 */
  consentVersion: string | undefined;
  signals?: ShopSignals;
  logger?: ShopLogger;
}

export type CreateShopOrderInput =
  | {
      fulfillment: 'DELIVERY';
      items: OrderLineInput[];
      delivery: { recipientName: string; recipientPhone: string; postalCode: string; address: string; addressDetail?: string | undefined };
      consents?: { provisionToSeller?: boolean | undefined; consentVersion?: string | undefined } | undefined;
    }
  | { fulfillment: 'PICKUP'; items: OrderLineInput[]; pickupSlotId: string };

export interface CreatedOrderView {
  orderId: string;
  fulfillment: Fulfillment;
  paymentStore: 'STANDARD' | 'ESCROW';
  stockReservedUntil?: string;
}

/** 이 요청이 잡은 예약(실패하면 푼다) */
interface Held {
  productId: string;
}

export class CreateMerchOrder {
  readonly #log: ShopLogger;

  constructor(private readonly d: MerchOrderDeps) {
    this.#log = d.logger ?? silentShopLogger;
  }

  /** 굿즈 주문(택배·현장 수령) */
  async shop(accountId: string, input: CreateShopOrderInput, once: IdempotencyRequest): Promise<CreatedOrderView> {
    const replay = await this.d.store.replayOf(once);
    if (replay !== undefined) return this.#replayView(replay);
    const nowMs = this.d.clock.now();
    const lines = input.items.map((i) => ({ productId: i.productId.toLowerCase(), quantity: i.quantity, options: i.options }));
    const products = await this.#products(lines);
    checkOrderLines('shop', input.fulfillment, lines, products, nowMs);
    let eventId: string | null = null;
    let delivery: Pick<ShopOrder, 'consentVersion' | 'recipientName' | 'recipientPhone' | 'deliveryAddress'> = { consentVersion: null, recipientName: null, recipientPhone: null, deliveryAddress: null };
    let pickupSlotId: string | null = null;
    if (input.fulfillment === 'DELIVERY') {
      const c = input.consents;
      if (!c || c.provisionToSeller !== true || !c.consentVersion) throw consentRequired();
      if (this.d.consentVersion === undefined) {
        this.#log.error({ kind: 'merch-consent-version-unset', severity: 'SEV2' }, 'PEAKET_MERCH_CONSENT_VERSION이 없어 택배 주문을 받지 못했다');
        throw dependencyUnavailable();
      }
      if (c.consentVersion !== this.d.consentVersion) throw consentVersionOutdated();
      const a = input.delivery;
      delivery = {
        consentVersion: c.consentVersion,
        recipientName: a.recipientName,
        recipientPhone: a.recipientPhone,
        deliveryAddress: [a.postalCode, a.address, a.addressDetail].filter((x) => x !== undefined && x !== '').join(' '),
      };
    } else {
      const slot = await this.#pickupSlot(accountId, input.pickupSlotId, lines, nowMs);
      eventId = slot.eventId;
      pickupSlotId = slot.slotId;
    }
    return this.#create({ path: 'shop', accountId, fulfillment: input.fulfillment, lines, products, eventId, delivery, pickupSlotId, linkedTicketId: null, once, nowMs });
  }

  /** 티켓 연동 부가 상품 주문(수령 방식 WALLET, ADR-0301 결정 2) */
  async addon(accountId: string, ticketId: string, input: { productId: string; quantity: number; options?: Record<string, string> | undefined }, once: IdempotencyRequest): Promise<CreatedOrderView> {
    const replay = await this.d.store.replayOf(once);
    if (replay !== undefined) return this.#replayView(replay);
    const nowMs = this.d.clock.now();
    const lines = [{ productId: input.productId.toLowerCase(), quantity: input.quantity, options: input.options }];
    const products = await this.#products(lines);
    checkOrderLines('addon', 'WALLET', lines, products, nowMs);
    const product = products.get(lines[0]!.productId)!;
    const eventId = product.linkedEventId!;
    // 없는 티켓과 남의 티켓을 가르지 않는 같은 404(ADR-0301 결정 2). 확인 못 함은 503(주문·예약 0)
    const held = await this.#held(accountId, eventId);
    if (!held.includes(ticketId.toLowerCase())) throw orderNotFound();
    const none = { consentVersion: null, recipientName: null, recipientPhone: null, deliveryAddress: null };
    return this.#create({ path: 'addon', accountId, fulfillment: 'WALLET', lines, products, eventId, delivery: none, pickupSlotId: null, linkedTicketId: ticketId.toLowerCase(), once, nowMs });
  }

  async #products(lines: readonly OrderLineInput[]): Promise<Map<string, OrderableProduct>> {
    const rows = await this.d.store.products([...new Set(lines.map((l) => l.productId))]);
    return new Map(rows.map((p) => [p.productId, p]));
  }

  async #held(accountId: string, eventId: string): Promise<string[]> {
    try {
      return await this.d.held.held(accountId, eventId);
    } catch (e) {
      if (e instanceof HeldTicketsUnavailable) {
        this.#log.warn({ kind: 'merch-held-tickets-unavailable', code: e.code }, 'ticket-svc 보유 확인에 실패해 주문을 만들지 않았다');
        throw dependencyUnavailable();
      }
      throw e;
    }
  }

  /**
   * 현장 수령 시간대(ADR-0301 결정 4): 고른 시간대가 주문 상품 가운데 하나의 시간대이고, 다른 항목 상품에도 같은 회차의 시간대가 있어야 한다.
   * 끝난 시간대(ends_at ≤ 지금)이거나 티켓 소지자 전용인데 그 회차 티켓이 없으면 422 pickup-slot-unavailable(확인 못 함은 503)
   */
  async #pickupSlot(accountId: string, slotId: string, lines: readonly OrderLineInput[], nowMs: number) {
    const slot = await this.d.store.pickupSlot(slotId.toLowerCase());
    const productIds = [...new Set(lines.map((l) => l.productId))];
    if (!slot || !productIds.includes(slot.productId)) throw pickupSlotUnavailable();
    if (slot.endsAt.getTime() <= nowMs) throw pickupSlotUnavailable();
    const others = productIds.filter((id) => id !== slot.productId);
    if (others.length > 0) {
      const slots = await this.d.store.pickupSlotsOf(others);
      for (const id of others) if (!slots.some((s) => s.productId === id && s.eventId === slot.eventId)) throw pickupSlotUnavailable();
    }
    if (slot.ticketHoldersOnly && (await this.#held(accountId, slot.eventId)).length === 0) throw pickupSlotUnavailable();
    return slot;
  }

  async #create(c: {
    path: OrderPath;
    accountId: string;
    fulfillment: Fulfillment;
    lines: OrderLineInput[];
    products: Map<string, OrderableProduct>;
    eventId: string | null;
    delivery: Pick<ShopOrder, 'consentVersion' | 'recipientName' | 'recipientPhone' | 'deliveryAddress'>;
    pickupSlotId: string | null;
    linkedTicketId: string | null;
    once: IdempotencyRequest;
    nowMs: number;
  }): Promise<CreatedOrderView> {
    const committed = await this.d.store.committedQuantities(c.accountId, [...c.products.keys()]);
    checkPerAccountLimit(c.lines, c.products, committed);
    const { amount, shippingFee } = orderAmount(c.fulfillment, c.lines, c.products);
    const orderId = uuidv7(this.d.clock);
    const reservedUntil = new Date(c.nowMs + STOCK_RESERVATION_MS);
    const pgStore = c.fulfillment === 'DELIVERY' ? 'ESCROW' : 'STANDARD';
    const first = c.products.get(c.lines[0]!.productId)!;
    const eventEndsAt = c.path === 'addon' && c.eventId ? await this.d.store.eventEndsAt(c.eventId) : null;
    const order: ShopOrder = {
      orderId,
      accountId: c.accountId,
      promoterId: first.promoterId,
      eventId: c.eventId,
      fulfillment: c.fulfillment,
      status: 'CREATED',
      amount,
      shippingFee,
      pgStore,
      pg: null,
      paymentId: null,
      stockReservedUntil: reservedUntil,
      ...c.delivery,
      pickupSlotId: c.pickupSlotId,
      escrow: false,
      orderedAt: new Date(c.nowMs),
      paidAt: null,
      purchaseConfirmedAt: null,
    };
    const items: ShopOrderItem[] = c.lines.map((l) => {
      const p = c.products.get(l.productId)!;
      return {
        itemId: uuidv7(this.d.clock),
        orderId,
        promoterId: p.promoterId,
        eventId: c.eventId,
        productId: p.productId,
        productName: p.name,
        quantity: l.quantity,
        unitAmount: p.price,
        commissionRateBp: p.commissionRateBp ?? 0,
        status: 'READY',
        fulfillment: c.fulfillment,
        ticketLinked: p.ticketLinked,
        limited: p.limitedQty !== null,
        optionSnapshot: { options: { ...(l.options ?? {}) }, name: p.name, type: p.type, schemaVersion: p.schemaVersion },
        linkedTicketId: c.linkedTicketId,
        cancelReason: null,
        refundedAmount: 0,
        pickedUpAt: null,
        eventEndsAt,
      };
    });
    // 한정 상품은 상품 ID 오름차순으로 하나씩 예약한다(같은 상품이 두 줄이면 합친다)
    const limited = new Map<string, number>();
    for (const l of c.lines) if (c.products.get(l.productId)!.limitedQty !== null) limited.set(l.productId, (limited.get(l.productId) ?? 0) + l.quantity);
    const held: Held[] = [];
    try {
      for (const productId of [...limited.keys()].sort()) {
        const p = c.products.get(productId)!;
        await this.#reserve({ productId, orderId, accountId: c.accountId, quantity: limited.get(productId)!, untilMs: reservedUntil.getTime(), ttlSeconds: stockKeyTtlSeconds(p.saleEndsAt, c.nowMs) }, c.nowMs);
        held.push({ productId });
      }
      const saved = await this.d.store.insertOrder(c.once, { order, items });
      if (saved.kind === 'replay') {
        await this.#undo(held, orderId, c.accountId);
        return this.#replayView(saved.resultRef);
      }
    } catch (e) {
      await this.#undo(held, orderId, c.accountId);
      if (e instanceof StockUnavailable) {
        this.#log.warn({ kind: 'merch-stock-unavailable' }, '재고 Redis를 쓸 수 없어 주문을 만들지 않았다');
        throw dependencyUnavailable();
      }
      if (e instanceof ShopProblem && e.type === 'merch-sold-out') this.d.signals?.order('sold_out');
      if (e instanceof ShopProblem && e.type === 'merch-order-in-progress') this.d.signals?.order('in_progress');
      throw e;
    }
    this.d.signals?.order('created');
    return { orderId, fulfillment: c.fulfillment, paymentStore: pgStore, ...(limited.size > 0 ? { stockReservedUntil: reservedUntil.toISOString() } : {}) };
  }

  /** 예약 하나. NO_COUNTER면 DB로 다시 만들고 한 번 더, PREV면 그 주문 상태로 정한 뒤 한 번 더(ADR-0300 결정 3·4) */
  async #reserve(i: Parameters<MerchStock['reserve']>[0], nowMs: number): Promise<void> {
    let rebuilt = false;
    let prevResolved = false;
    for (;;) {
      const r: ReserveResult = await this.d.stock.reserve(i);
      if (r.kind === 'OK') return;
      if (r.kind === 'SOLD_OUT') throw merchSoldOut();
      if (r.kind === 'NO_COUNTER') {
        if (rebuilt) throw new StockUnavailable(new Error('다시 만든 뒤에도 카운터가 없다'));
        rebuilt = true;
        const src = await this.d.store.rebuildSource(i.productId, nowMs);
        if (!src) throw merchProductUnavailable();
        await this.d.stock.rebuild(i.productId, src.stock, src.reservations, i.ttlSeconds);
        continue;
      }
      if (prevResolved) throw merchOrderInProgress();
      prevResolved = true;
      await this.#resolvePrev(i.productId, i.accountId, r.orderId, nowMs);
    }
  }

  /**
   * 같은 계정·같은 상품의 다른 결제 전 주문(PREV). 결제 접수 전 CREATED면 조건부 EXPIRED(사유 '같은 상품의 새 주문') 뒤 그 주문의 한정 상품을 RELEASE(restore=1),
   * 접수했거나 PAID면 unpaid 칸만 지운다(CLEAR_UNPAID), EXPIRED·FAILED면 RELEASE(restore=1). DB에 없으면(만드는 중·넣기 전에 죽음) 409 merch-order-in-progress
   */
  async #resolvePrev(productId: string, accountId: string, prevId: string, nowMs: number): Promise<void> {
    const st = await this.d.store.orderState(prevId);
    if (!st || st.accountId !== accountId) throw merchOrderInProgress();
    if (st.status === 'CREATED' && !st.accepted) {
      const released = await this.d.store.expireUnpaid(prevId, nowMs, 'superseded');
      if (released) {
        this.d.signals?.order('expired');
        for (const l of released.limited) await this.d.stock.release(l.productId, prevId, true, accountId);
      }
      return;
    }
    if (st.status === 'EXPIRED' || st.status === 'FAILED') {
      const products = st.limited.length > 0 ? st.limited.map((l) => l.productId) : [productId];
      for (const p of products) await this.d.stock.release(p, prevId, true, accountId);
      return;
    }
    await this.d.stock.clearUnpaid(productId, accountId, prevId);
  }

  /** 잡은 예약을 푼다(실패해도 던지지 않는다. 남은 원소는 만료 작업이 'DB에 없는 주문'으로 돌린다) */
  async #undo(held: readonly Held[], orderId: string, accountId: string): Promise<void> {
    for (const h of held) {
      try {
        await this.d.stock.release(h.productId, orderId, true, accountId);
      } catch {
        this.#log.warn({ kind: 'merch-stock-undo-failed', orderId }, '주문을 만들지 못한 뒤 예약을 풀지 못했다(만료 작업이 돌린다)');
      }
    }
  }

  async #replayView(orderId: string): Promise<CreatedOrderView> {
    const d = await this.d.store.findOrder(orderId);
    if (!d) throw orderNotFound();
    const limited = d.items.some((i) => i.limited);
    return { orderId, fulfillment: d.order.fulfillment, paymentStore: d.order.pgStore, ...(limited ? { stockReservedUntil: d.order.stockReservedUntil.toISOString() } : {}) };
  }
}
