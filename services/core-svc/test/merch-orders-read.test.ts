// 굿즈 결제 상태 조회 단위 시험(P-T60 ⑤, ADR-0314, payment §6 '결제 상태 응답').
// 정본: AWAITING_DEPOSIT일 때만 `virtualAccount`(은행·계좌번호·입금 기한)를 싣고, PAID·EXPIRED면 칸이 없다.
// GetPayment를 읽지 못하면 계좌 없는 ACCEPTED로 답하고 화면이 계속 묻는다(B6). 계좌번호는 응답 밖으로 나가지 않는다.
import { fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  MerchOrdersRead,
  MemoryMerchPayments,
  MemoryProductStore,
  MemoryShopOrderStore,
  ShopProblem,
  type ShopOrder,
  type ShopOrderItem,
} from '../src/modules/shop/index.js';

const NOW = Date.parse('2026-11-19T10:00:00+09:00');
/** 입금 기한. 코드 상수와 다른 값(다음 날 23:59 KST가 아닌 시각)을 고른다 */
const DUE = Date.parse('2026-11-20T21:17:00+09:00');

function fixture(status: ShopOrder['status']) {
  const clock = fakeClock({ now: NOW });
  const products = new MemoryProductStore();
  const orders = new MemoryShopOrderStore(products);
  const payments = new MemoryMerchPayments(() => clock.now());
  const orderId = randomUUID();
  const accountId = randomUUID();
  const productId = randomUUID();
  const itemId = randomUUID();
  const order: ShopOrder = {
    orderId,
    accountId,
    promoterId: randomUUID(),
    eventId: null,
    fulfillment: 'DELIVERY',
    status,
    amount: 27_500,
    shippingFee: 3_000,
    pgStore: 'ESCROW',
    pg: 'TOSS',
    paymentId: randomUUID(),
    stockReservedUntil: new Date(NOW + 60 * 60_000),
    consentVersion: 'v2026.11-10',
    recipientName: '김피켓',
    recipientPhone: '01012345678',
    deliveryAddress: '04001 서울특별시 마포구 월드컵로 1',
    pickupSlotId: null,
    escrow: false,
    orderedAt: new Date(NOW - 3_600_000),
    paidAt: status === 'PAID' ? new Date(NOW - 3_000_000) : null,
    purchaseConfirmedAt: null,
  };
  orders.orders.set(orderId, order);
  const item: ShopOrderItem = {
    itemId,
    orderId,
    promoterId: order.promoterId,
    eventId: null,
    productId,
    productName: 'P-T60 ⑤ 상품',
    quantity: 1,
    unitAmount: 24_500,
    commissionRateBp: 1000,
    status: status === 'PAID' ? 'SHIPPED' : 'READY',
    fulfillment: 'DELIVERY',
    ticketLinked: false,
    limited: false,
    optionSnapshot: { options: {}, name: 'P-T60 ⑤ 상품', type: 'MERCH', schemaVersion: 1 },
    linkedTicketId: null,
    cancelReason: null,
    refundedAmount: 0,
    pickedUpAt: null,
    eventEndsAt: null,
  };
  orders.items.set(itemId, item);
  const read = new MerchOrdersRead({ store: orders, payments, clock, sleep: async () => {} });
  return { clock, orders, payments, read, orderId, accountId };
}

const statusOf = async (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe('굿즈 결제 상태의 가상계좌 안내(P-T60 ⑤)', () => {
  test('P-T60 ⑤ AWAITING_DEPOSIT이면 GetPayment 답의 은행·계좌번호·기한을 virtualAccount에 싣는다', async () => {
    const f = fixture('AWAITING_DEPOSIT');
    f.payments.details.set(f.orderId, { status: 'AWAITING_DEPOSIT', pg: 'TOSS', virtualAccount: { bank: '신한', accountNumber: '110-987-6543', dueAtMs: DUE } });
    const view = await f.read.paymentStatus(f.accountId, f.orderId);
    expect(view).toEqual({
      status: 'AWAITING_DEPOSIT',
      stockReservedUntil: null,
      pg: 'TOSS',
      virtualAccount: { bank: '신한', accountNumber: '110-987-6543', dueAt: new Date(DUE).toISOString() },
    });
    expect(f.payments.calls.getPayment).toEqual([f.orderId]);
  });

  test('P-T60 ⑤ PAID면 GetPayment를 부르지 않고 계좌 칸이 없다', async () => {
    const f = fixture('PAID');
    f.payments.details.set(f.orderId, { status: 'APPROVED', pg: 'TOSS', virtualAccount: { bank: '신한', accountNumber: '110-987-6543', dueAtMs: DUE } });
    const view = await f.read.paymentStatus(f.accountId, f.orderId);
    expect(view).toEqual({ status: 'PAID', stockReservedUntil: null, pg: 'TOSS' });
    expect(view).not.toHaveProperty('virtualAccount');
    expect(f.payments.calls.getPayment).toEqual([]);
  });

  test('P-T60 ⑤ EXPIRED면 409 order-expired이고 계좌 칸을 만들지 않는다', async () => {
    const f = fixture('EXPIRED');
    f.payments.details.set(f.orderId, { status: 'APPROVED', pg: 'TOSS', virtualAccount: { bank: '신한', accountNumber: '110-987-6543', dueAtMs: DUE } });
    const err = await statusOf(f.read.paymentStatus(f.accountId, f.orderId));
    expect(err).toBeInstanceOf(ShopProblem);
    expect((err as ShopProblem).type).toBe('order-expired');
    expect((err as ShopProblem).status).toBe(409);
    expect(err).not.toHaveProperty('virtualAccount');
  });

  test('P-T60 ⑤ GetPayment가 실패하면 계좌 없이 ACCEPTED로 답한다', async () => {
    const f = fixture('AWAITING_DEPOSIT');
    f.payments.getPaymentFails = true;
    const view = await f.read.paymentStatus(f.accountId, f.orderId);
    expect(view).toEqual({ status: 'ACCEPTED', stockReservedUntil: null, pg: 'TOSS' });
    expect(view).not.toHaveProperty('virtualAccount');
    expect(f.payments.calls.getPayment).toEqual([f.orderId]);
  });

  test('P-T60 ⑤ GetPayment 답에 계좌가 없으면 계좌 칸 없이 AWAITING_DEPOSIT 그대로다', async () => {
    const f = fixture('AWAITING_DEPOSIT');
    f.payments.details.set(f.orderId, { status: 'AWAITING_DEPOSIT', pg: 'TOSS' });
    const view = await f.read.paymentStatus(f.accountId, f.orderId);
    expect(view).toEqual({ status: 'AWAITING_DEPOSIT', stockReservedUntil: null, pg: 'TOSS' });
    expect(view).not.toHaveProperty('virtualAccount');
  });
});
