// 굿즈 주문 조회(GET /v1/shop/orders, GET /v1/shop/orders/{orderId}, GET …/payment-status)(ADR-0300 결정 8).
// 주문의 account_id가 세션 계정과 같을 때만 답하고, 다르거나 없으면 같은 404 not-found다(없는 주문과 같은 본문).
// 결제 상태는 결과가 정해지면 바로, 아니면 최대 25초 [가정] 동안 DB를 1초 [가정]마다 다시 읽고 그때의 상태로 답한다.
import type { Clock } from '@peaket/platform';
import { maskPhone } from '../domain/merch.js';
import { orderExpired, orderNotFound, orderNumberOf, PAYMENT_STATUS_POLL_MS, PAYMENT_STATUS_WAIT_MS, paymentNotAccepted, type ShopOrderDetail } from '../domain/merch-order.js';
import type { ShopOrderStore } from '../domain/merch-ports.js';

export interface MerchReadDeps {
  store: ShopOrderStore;
  clock: Clock;
  /** 기다리기(시험은 바꿔 끼운다) */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export type PaymentStatusView = {
  status: 'ACCEPTED' | 'AWAITING_DEPOSIT' | 'PAID' | 'FAILED' | 'UNKNOWN';
  stockReservedUntil: string | null;
  pg?: 'TOSS' | 'PORTONE' | 'SIMULATOR';
  reason?: string;
};

const realSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

function summaryOf(d: ShopOrderDetail) {
  return {
    orderId: d.order.orderId,
    orderNumber: orderNumberOf(d.order.orderId),
    fulfillment: d.order.fulfillment,
    status: d.order.status,
    paymentStore: d.order.pgStore,
    escrow: d.order.escrow,
    totalAmount: d.order.amount,
    items: d.items.map((i) => ({ itemId: i.itemId, productId: i.productId, name: i.productName, quantity: i.quantity, status: i.status })),
    pickupWindow: d.pickupWindow ? { startsAt: d.pickupWindow.startsAt.toISOString(), endsAt: d.pickupWindow.endsAt.toISOString() } : null,
    createdAt: d.order.orderedAt.toISOString(),
  };
}

export class MerchOrdersRead {
  constructor(private readonly d: MerchReadDeps) {}

  async #owned(accountId: string, orderId: string): Promise<ShopOrderDetail> {
    const detail = await this.d.store.findOrder(orderId.toLowerCase());
    if (!detail || detail.order.accountId !== accountId) throw orderNotFound();
    return detail;
  }

  async get(accountId: string, orderId: string) {
    const d = await this.#owned(accountId, orderId);
    return {
      ...summaryOf(d),
      items: d.items.map((i) => ({
        itemId: i.itemId,
        productId: i.productId,
        name: i.productName,
        quantity: i.quantity,
        status: i.status,
        unitPrice: i.unitAmount,
        options: i.optionSnapshot.options,
        pickedUpAt: i.pickedUpAt?.toISOString() ?? null,
      })),
      shippingFee: d.order.shippingFee,
      stockReservedUntil: d.order.status === 'CREATED' ? d.order.stockReservedUntil.toISOString() : null,
      purchaseConfirmedAt: d.order.purchaseConfirmedAt?.toISOString() ?? null,
      delivery:
        d.order.fulfillment === 'DELIVERY'
          ? { recipientName: d.order.recipientName ?? '', recipientPhoneMasked: maskPhone(d.order.recipientPhone ?? ''), address: d.order.deliveryAddress ?? '' }
          : null,
    };
  }

  async list(accountId: string, limit: number, cursor?: string) {
    const page = await this.d.store.listOrders(accountId, limit, cursor);
    return { items: page.items.map(summaryOf), nextCursor: page.nextCursor };
  }

  /** 결제 상태(long polling). 접수 전이면 409 payment-not-accepted, 만료면 409 order-expired */
  async paymentStatus(accountId: string, orderId: string, signal?: AbortSignal): Promise<PaymentStatusView> {
    const sleep = this.d.sleep ?? realSleep;
    let view = this.#judge(await this.#owned(accountId, orderId));
    for (let waited = 0; view.status === 'ACCEPTED' && waited < PAYMENT_STATUS_WAIT_MS && !signal?.aborted; waited += PAYMENT_STATUS_POLL_MS) {
      await sleep(PAYMENT_STATUS_POLL_MS, signal);
      view = this.#judge(await this.#owned(accountId, orderId));
    }
    return view;
  }

  #judge(d: ShopOrderDetail): PaymentStatusView {
    const limited = d.items.some((i) => i.limited);
    const until = limited && d.order.status === 'CREATED' ? d.order.stockReservedUntil.toISOString() : null;
    const pg = d.order.pg ?? d.activeAttempt?.pg;
    const withPg = pg ? { pg } : {};
    if (d.order.status === 'PAID') return { status: 'PAID', stockReservedUntil: null, ...withPg };
    if (d.order.status === 'AWAITING_DEPOSIT') return { status: 'AWAITING_DEPOSIT', stockReservedUntil: until, ...withPg };
    if (d.order.status === 'FAILED') return { status: 'FAILED', stockReservedUntil: null, reason: 'PAYMENT_FAILED', ...withPg };
    if (d.order.status === 'EXPIRED') throw orderExpired();
    if (d.activeAttempt?.status !== 'ACCEPTED') {
      if (d.order.stockReservedUntil.getTime() <= this.d.clock.now()) throw orderExpired();
      throw paymentNotAccepted();
    }
    return { status: 'ACCEPTED', stockReservedUntil: until, ...withPg };
  }
}
