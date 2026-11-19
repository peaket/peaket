// 굿즈 주문 조회(GET /v1/shop/orders, GET /v1/shop/orders/{orderId}, GET …/payment-status)(ADR-0300 결정 8).
// 주문의 account_id가 세션 계정과 같을 때만 답하고, 다르거나 없으면 같은 404 not-found다(없는 주문과 같은 본문).
// 결제 상태는 결과가 정해지면 바로, 아니면 최대 25초 [가정] 동안 DB를 1초 [가정]마다 다시 읽고 그때의 상태로 답한다.
import type { Clock } from '@peaket/platform';
import { maskPhone } from '../domain/merch.js';
import {
  defectReturnDueAtMs,
  GET_PAYMENT_DEADLINE_MS,
  orderExpired,
  orderNotFound,
  orderNumberOf,
  PAYMENT_STATUS_POLL_MS,
  PAYMENT_STATUS_WAIT_MS,
  paymentNotAccepted,
  returnDueAtMs,
  returnableOf,
  type ShopOrderDetail,
} from '../domain/merch-order.js';
import type { MerchPayments, ShopOrderStore } from '../domain/merch-ports.js';

export interface MerchReadDeps {
  store: ShopOrderStore;
  payments: MerchPayments;
  clock: Clock;
  /** 기다리기(시험은 바꿔 끼운다) */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export type PaymentStatusView = {
  status: 'ACCEPTED' | 'AWAITING_DEPOSIT' | 'PAID' | 'FAILED' | 'UNKNOWN';
  stockReservedUntil: string | null;
  pg?: 'TOSS' | 'PORTONE' | 'SIMULATOR';
  reason?: string;
  /** 입금 대기일 때만. 입금처 번호라 구매자 계좌가 아니고, 로그·사건·지표에 싣지 않는다 */
  virtualAccount?: { bank?: string; accountNumber?: string; dueAt?: string };
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
    const nowMs = this.d.clock.now();
    const entry = d.order.eventId === null ? null : await this.d.store.eventEntryOpensAt(d.order.eventId);
    const entryMs = entry?.getTime();
    const products = await this.d.store.products([...new Set(d.items.map((i) => i.productId))]);
    const returnFees = products.map((p) => p.returnShippingFee).filter((x): x is number => x !== null && x !== undefined);
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
        shipment: i.shippedAt === null || i.shippedAt === undefined ? null : { trackingNo: i.trackingNo ?? '', ...(i.deliveredAt ? { deliveredAt: i.deliveredAt.toISOString() } : {}) },
        pickedUpAt: i.pickedUpAt?.toISOString() ?? null,
        cancellable: i.status === 'READY' && (i.fulfillment !== 'WALLET' || entryMs === undefined || nowMs < entryMs),
        returnable: returnableOf(i, i.eventEndsAt, nowMs),
        returnDueAt: returnDueAtMs(i) === null ? null : new Date(returnDueAtMs(i)!).toISOString(),
        defectReturnDueAt: defectReturnDueAtMs(i) === null ? null : new Date(defectReturnDueAtMs(i)!).toISOString(),
        returnReason: i.returnReason ?? null,
        returnTrackingNo: i.returnTrackingNo ?? null,
      })),
      shippingFee: d.order.shippingFee,
      stockReservedUntil: d.order.status === 'CREATED' ? d.order.stockReservedUntil.toISOString() : null,
      purchaseConfirmedAt: d.order.purchaseConfirmedAt?.toISOString() ?? null,
      delivery:
        d.order.fulfillment === 'DELIVERY'
          ? { recipientName: d.order.recipientName ?? '', recipientPhoneMasked: maskPhone(d.order.recipientPhone ?? ''), address: d.order.deliveryAddress ?? '' }
          : null,
      ...(d.order.fulfillment === 'DELIVERY'
        ? { returnPolicy: { returnShippingFee: Math.max(0, ...returnFees), returnAddress: products.find((p) => p.returnAddress !== null)?.returnAddress ?? '' } }
        : {}),
    };
  }

  async list(accountId: string, limit: number, cursor?: string) {
    const page = await this.d.store.listOrders(accountId, limit, cursor);
    return { items: page.items.map(summaryOf), nextCursor: page.nextCursor };
  }

  /** 결제 상태(long polling). 접수 전이면 409 payment-not-accepted, 만료면 409 order-expired. 입금 대기면 GetPayment로 입금 안내를 읽는다 */
  async paymentStatus(accountId: string, orderId: string, signal?: AbortSignal): Promise<PaymentStatusView> {
    const sleep = this.d.sleep ?? realSleep;
    let view = this.#judge(await this.#owned(accountId, orderId));
    for (let waited = 0; view.status === 'ACCEPTED' && waited < PAYMENT_STATUS_WAIT_MS && !signal?.aborted; waited += PAYMENT_STATUS_POLL_MS) {
      await sleep(PAYMENT_STATUS_POLL_MS, signal);
      view = this.#judge(await this.#owned(accountId, orderId));
    }
    if (view.status !== 'AWAITING_DEPOSIT') return view;
    // B6: 읽지 못하면 계좌 없는 ACCEPTED로 답하고 화면이 계속 묻는다(모르는 채 입금 대기로 끝내지 않는다)
    try {
      const getPayment = this.d.payments.getPayment;
      if (getPayment === undefined) throw new Error('결제 원장 읽기 포트가 없다');
      const p = await getPayment.call(this.d.payments, orderId.toLowerCase(), GET_PAYMENT_DEADLINE_MS);
      // 다른 주문의 원장 답이면 계좌를 싣지 않는다(다른 주문 계좌 노출 금지, RV-11)
      if (p?.orderId !== undefined && p.orderId !== orderId.toLowerCase()) return view;
      const va = p?.virtualAccount;
      if (va === undefined) return view;
      return {
        ...view,
        virtualAccount: {
          ...(va.bank === undefined ? {} : { bank: va.bank }),
          ...(va.accountNumber === undefined ? {} : { accountNumber: va.accountNumber }),
          ...(va.dueAtMs === undefined ? {} : { dueAt: new Date(va.dueAtMs).toISOString() }),
        },
      };
    } catch {
      return { status: 'ACCEPTED', stockReservedUntil: view.stockReservedUntil, ...(view.pg === undefined ? {} : { pg: view.pg }) };
    }
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
