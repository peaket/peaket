// 굿즈 환급 다시 부르기 단위 시험(P-T64 ②, ADR-0315, payment §4.1 '취소 건 기록과 기대 잔액').
// 정본: 1분 [가정]마다 다음 시각이 된 환급을 같은 취소 ID로 다시 부른다. 간격은 1→5→15→60→360분, 5회 [가정]다.
// CANCELLED면 항목 REFUNDED, REJECTED면 항목 그대로·CS 경보 한 줄(SEV2), 두 번 돌려도 결제사 취소는 1건이다.
import { fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  MemoryMerchPayments,
  MemoryProductStore,
  MemoryShopOrderStore,
  MerchRefundRetry,
  type ShopLogger,
  type ShopOrder,
  type ShopOrderItem,
} from '../src/modules/shop/index.js';

const MIN = 60_000;
/** 기준 시각. 초 단위가 아닌 값을 골라 경계 계산이 시각을 버리지 않는지 본다 */
const CREATED = Date.parse('2026-11-19T10:07:13.417+09:00');
const UNIT = 27_500;

interface LogLine {
  level: string;
  o: Record<string, unknown>;
  msg: string;
}

function fixture(nowMs = CREATED + MIN) {
  const clock = fakeClock({ now: nowMs });
  const products = new MemoryProductStore();
  const orders = new MemoryShopOrderStore(products);
  const payments = new MemoryMerchPayments();
  const logs: LogLine[] = [];
  const logger: ShopLogger = {
    info: (x, msg) => logs.push({ level: 'info', o: x as Record<string, unknown>, msg }),
    warn: (x, msg) => logs.push({ level: 'warn', o: x as Record<string, unknown>, msg }),
    error: (x, msg) => logs.push({ level: 'error', o: x as Record<string, unknown>, msg }),
  };
  const orderId = randomUUID();
  const paymentId = randomUUID();
  const refundId = randomUUID();
  const itemId = randomUUID();
  const order: ShopOrder = {
    orderId,
    accountId: randomUUID(),
    promoterId: randomUUID(),
    eventId: null,
    fulfillment: 'DELIVERY',
    status: 'PAID',
    amount: UNIT,
    shippingFee: 0,
    pgStore: 'ESCROW',
    pg: 'TOSS',
    paymentId,
    stockReservedUntil: new Date(CREATED),
    consentVersion: 'v2026.11-10',
    recipientName: '김피켓',
    recipientPhone: '01012345678',
    deliveryAddress: '04001 서울특별시 마포구 월드컵로 1',
    pickupSlotId: null,
    escrow: false,
    orderedAt: new Date(CREATED - 3_600_000),
    paidAt: new Date(CREATED - 3_600_000),
    purchaseConfirmedAt: null,
  };
  orders.orders.set(orderId, order);
  const item: ShopOrderItem = {
    itemId,
    orderId,
    promoterId: order.promoterId,
    eventId: null,
    productId: randomUUID(),
    productName: 'P-T64 ② 상품',
    quantity: 1,
    unitAmount: UNIT,
    commissionRateBp: 1000,
    status: 'READY',
    fulfillment: 'DELIVERY',
    ticketLinked: false,
    limited: false,
    optionSnapshot: { options: {}, name: 'P-T64 ② 상품', type: 'MERCH', schemaVersion: 1 },
    linkedTicketId: null,
    cancelReason: null,
    refundedAmount: 0,
    pickedUpAt: null,
    eventEndsAt: null,
  };
  orders.items.set(itemId, item);
  const retry = new MerchRefundRetry({ store: orders, payments, clock, logger });
  /** 취소 요청이 이미 결제사를 한 번 불렀고 다음 다시 부르기 시각이 된 상태를 만든다 */
  const setRefund = (o: { nextAtMs?: number; createdAtMs?: number; attempts?: number } = {}) =>
    orders.refunds.set(refundId, {
      refundId,
      orderId,
      paymentId,
      amount: UNIT,
      reason: 'USER_CANCEL',
      status: 'REQUESTED',
      createdAtMs: o.createdAtMs ?? CREATED,
      alerted: false,
      kind: 'USER_CANCEL',
      attempts: o.attempts ?? 0,
      nextAtMs: o.nextAtMs ?? CREATED + MIN,
      accountRequiredAtMs: null,
      itemIds: [itemId],
      failReason: null,
      resolvedAtMs: null,
    });
  return { clock, orders, payments, logs, retry, orderId, refundId, itemId, setRefund };
}

const itemOf = (f: ReturnType<typeof fixture>) => f.orders.items.get(f.itemId)!;
const refundOf = (f: ReturnType<typeof fixture>) => f.orders.refunds.get(f.refundId)!;

describe('굿즈 환급 다시 부르기(P-T64 ②)', () => {
  test('P-T64 ② 1분 − 1ms에는 다시 부르지 않고 정각에 같은 취소 ID로 1건 부른다', async () => {
    const f = fixture(CREATED + MIN - 1);
    f.setRefund();
    f.payments.cancelOutcomes = ['CANCEL_PENDING'];
    expect(await f.retry.tick()).toEqual({ picked: 0, cancelled: 0, pending: 0, rejected: 0 });
    expect(f.payments.calls.cancel).toEqual([]);
    f.clock.advance(1);
    expect(await f.retry.tick()).toEqual({ picked: 1, cancelled: 0, pending: 1, rejected: 0 });
    expect(f.payments.calls.cancel).toHaveLength(1);
    expect(f.payments.calls.cancel[0]).toMatchObject({ cancellationId: f.refundId, paymentId: refundOf(f).paymentId, amount: UNIT, reason: 'USER_CANCEL' });
    expect(refundOf(f)).toMatchObject({ attempts: 1, status: 'CANCEL_PENDING', nextAtMs: CREATED + MIN + 5 * MIN });
    // 취소 효력은 즉시다(항목은 CANCELLED, 환급은 아직)
    expect(itemOf(f)).toMatchObject({ status: 'CANCELLED', refundedAmount: 0 });
  });

  test('P-T64 ② 간격은 1→5→15→60→360분이고 5회를 넘기면 REJECTED·CS 경보 한 줄로 멈춘다', async () => {
    const f = fixture(CREATED + MIN);
    f.setRefund();
    const expected = [
      ['첫 다시 부르기', CREATED + MIN, CREATED + MIN + 5 * MIN],
      ['둘째', CREATED + MIN + 5 * MIN, CREATED + MIN + 5 * MIN + 15 * MIN],
      ['셋째', CREATED + MIN + 5 * MIN + 15 * MIN, CREATED + MIN + 5 * MIN + 15 * MIN + 60 * MIN],
      ['넷째', CREATED + MIN + 5 * MIN + 15 * MIN + 60 * MIN, CREATED + MIN + 5 * MIN + 15 * MIN + 60 * MIN + 360 * MIN],
    ] as const;
    f.payments.cancelOutcomes = ['CANCEL_PENDING', 'CANCEL_PENDING', 'CANCEL_PENDING', 'CANCEL_PENDING', 'CANCEL_PENDING'];
    for (const [what, at, next] of expected) {
      f.clock.advance(at - f.clock.now());
      expect((await f.retry.tick()).picked, what).toBe(1);
      expect(f.payments.calls.cancel.at(-1)!.cancellationId, what).toBe(f.refundId);
      expect(refundOf(f).nextAtMs, what).toBe(next);
    }
    // 5회째 다시 부르기가 CANCEL_PENDING이면 다음 간격이 없어 REJECTED(RETRY_EXHAUSTED)로 CS에 넘긴다
    f.clock.advance(CREATED + MIN + 5 * MIN + 15 * MIN + 60 * MIN + 360 * MIN - f.clock.now());
    expect(await f.retry.tick()).toEqual({ picked: 1, cancelled: 0, pending: 0, rejected: 1 });
    expect(f.payments.calls.cancel).toHaveLength(5);
    expect(f.payments.calls.cancel.map((c) => c.cancellationId)).toEqual(Array(5).fill(f.refundId));
    expect(refundOf(f)).toMatchObject({ status: 'REJECTED', attempts: 5, nextAtMs: null, failReason: 'RETRY_EXHAUSTED' });
    expect(f.logs.filter((l) => l.level === 'error')).toHaveLength(1);
    expect(f.logs.filter((l) => l.level === 'error')[0]).toMatchObject({ level: 'error', o: { kind: 'merch-refund-retry-exhausted', severity: 'SEV2', orderId: f.orderId } });
    // 더 돌려도 부르지 않는다
    f.clock.advance(6 * 60 * MIN);
    expect(await f.retry.tick()).toEqual({ picked: 0, cancelled: 0, pending: 0, rejected: 0 });
    expect(f.payments.calls.cancel).toHaveLength(5);
  });

  test('P-T64 ② CANCELLED면 환급이 끝나고 항목은 CANCELLED·환급액이 남으며 두 번 돌려도 결제사 취소는 1건이다', async () => {
    const f = fixture(CREATED + MIN);
    f.setRefund();
    f.payments.cancelOutcomes = ['CANCELLED'];
    expect(await f.retry.tick()).toEqual({ picked: 1, cancelled: 1, pending: 0, rejected: 0 });
    expect(refundOf(f)).toMatchObject({ status: 'CANCELLED', attempts: 1, nextAtMs: null, resolvedAtMs: f.clock.now() });
    // 취소 효력은 항목 CANCELLED이고 환급액이 적힌다(정본 P-T61 ①: 모든 항목 CANCELLED)
    expect(itemOf(f)).toMatchObject({ status: 'CANCELLED', cancelReason: 'USER_CANCEL', refundedAmount: UNIT });
    expect(f.payments.calls.cancel).toHaveLength(1);
    expect(f.payments.calls.cancel[0]!.cancellationId).toBe(f.refundId);
    // 같은 시각에 한 번 더 돌려도 끝난 행은 집히지 않는다
    expect(await f.retry.tick()).toEqual({ picked: 0, cancelled: 0, pending: 0, rejected: 0 });
    expect(f.payments.calls.cancel).toHaveLength(1);
  });

  test('P-T64 ② REJECTED면 항목을 그대로 두고 REJECTED·CS 경보 한 줄을 남기며 다시 부르지 않는다', async () => {
    const f = fixture(CREATED + MIN);
    f.setRefund();
    f.payments.cancelOutcomes = ['REJECTED'];
    expect(await f.retry.tick()).toEqual({ picked: 1, cancelled: 0, pending: 0, rejected: 1 });
    expect(refundOf(f)).toMatchObject({ status: 'REJECTED', attempts: 1, nextAtMs: null, failReason: 'PG_REJECTED' });
    expect(itemOf(f)).toMatchObject({ status: 'READY', refundedAmount: 0 });
    const alerts = f.logs.filter((l) => l.level === 'error');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ o: { kind: 'merch-refund-rejected', severity: 'SEV2', orderId: f.orderId } });
    f.clock.advance(6 * 60 * MIN);
    expect(await f.retry.tick()).toEqual({ picked: 0, cancelled: 0, pending: 0, rejected: 0 });
    expect(f.payments.calls.cancel).toHaveLength(1);
  });
});
