// SCR-060이 읽을 취소 상세(F-07-15 I-03). GET /v1/cancellations/{cancellationId}의 응용 층.
// 기준 트리에는 get-cancellation-detail 모듈이 없어 실패한다.
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { GetCancellationDetail } from '../src/modules/refund/application/get-cancellation-detail.js';
import type { CancellationRecord } from '../src/modules/refund/domain/cancellation.js';
import type { CancellationOrderView, CancellationOrders } from '../src/modules/refund/domain/ports.js';

const PAYER = randomUUID();
const OTHER = randomUUID();
const EVENT = randomUUID();
const NOW = Date.parse('2026-11-27T03:00:00.000Z');

const record = (over: Partial<CancellationRecord> = {}): CancellationRecord => ({
  cancellationId: randomUUID(),
  orderId: randomUUID(),
  ticketId: randomUUID(),
  refundAmount: 6_600,
  state: 'REFUND_PENDING',
  refundAttempts: 0,
  refundAccountRequired: true,
  ...over,
});

const order = (c: CancellationRecord, over: Partial<CancellationOrderView> = {}): CancellationOrderView => ({
  orderId: c.orderId,
  eventId: EVENT,
  ticketId: c.ticketId,
  seatId: randomUUID(),
  payerAccountId: PAYER,
  ticketPrice: 66_000,
  bookedAtMs: NOW - 10 * 86_400_000,
  saleEndsAtMs: NOW + 86_400_000,
  orderStatus: 'CONFIRMED',
  ...over,
});

const fake = (c: CancellationRecord | undefined, o: CancellationOrderView | undefined): CancellationOrders => ({
  findCancellation: async (id) => (c?.cancellationId === id ? c : undefined),
  findByTicket: async () => o,
});

describe('SCR060 취소 상세', () => {
  test('SCR060_상세 결제자 본인에게 환급액·공제·상태·계좌 대기를 준다', async () => {
    const c = record({ deductionBp: 9000, deductionAmount: 59_400, reason: 'USER', createdAt: new Date(NOW - 3_600_000) });
    const svc = new GetCancellationDetail({ orders: fake(c, order(c)) });
    const d = await svc.run({ cancellationId: c.cancellationId, accountId: PAYER });
    expect(d).toMatchObject({
      cancellationId: c.cancellationId,
      orderId: c.orderId,
      eventId: EVENT,
      refundAmount: 6_600,
      deductionAmount: 59_400,
      deductionBp: 9000,
      reason: 'USER',
      status: 'REFUND_PENDING',
      refundAccountRequired: true,
    });
    expect(d.createdAt).toBe('2026-11-27T02:00:00.000Z');
  });

  test('SCR060_상세 남의 취소와 없는 취소는 같은 404다', async () => {
    const c = record();
    const svc = new GetCancellationDetail({ orders: fake(c, order(c)) });
    await expect(svc.run({ cancellationId: c.cancellationId, accountId: OTHER })).rejects.toMatchObject({ status: 404 });
    await expect(svc.run({ cancellationId: randomUUID(), accountId: PAYER })).rejects.toMatchObject({ status: 404 });
  });

  test('SCR060_상세 계좌 대기 표시가 없으면 refundAccountRequired가 거짓이다', async () => {
    const c = record({ refundAccountRequired: false });
    const svc = new GetCancellationDetail({ orders: fake(c, order(c)) });
    expect(await svc.run({ cancellationId: c.cancellationId, accountId: PAYER })).toMatchObject({ refundAccountRequired: false });
  });

  test('SCR060_상세 읽기는 아무것도 쓰지 않는다', async () => {
    const c = record();
    let writes = 0;
    const orders = fake(c, order(c));
    orders.findCancellation = async (id) => (writes++, c.cancellationId === id ? c : undefined);
    const svc = new GetCancellationDetail({ orders });
    await svc.run({ cancellationId: c.cancellationId, accountId: PAYER });
    expect(writes).toBe(1);
  });
});
