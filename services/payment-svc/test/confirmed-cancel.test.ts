// 결제 후 일반 취소(부분·전액)의 쓰임새(GAT-080, docs/features/payment.md §4.1). DB 없이 돈다.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import {
  CancelConfirmedPayment,
  type ConfirmedCancelBegin,
  type ConfirmedCancelTarget,
  PaymentCancelStateError,
  PaymentInputError,
  PaymentNotFoundError,
} from '../src/modules/payment/server.js';
import type { CancelResult, PaymentGatewayPort } from '../src/modules/payment/domain/payment-gateway.js';

const NOW = Date.parse('2026-11-13T01:00:00.000Z');
const PAYMENT = '0193a000-0000-7000-8000-000000000002';
const ORDER = '0193a000-0000-7000-8000-000000000001';
const EVENT = '0193a000-0000-7000-8000-000000000003';
const CANCEL = 'cancel_01';
const TARGET: ConfirmedCancelTarget = {
  paymentId: PAYMENT,
  orderId: ORDER,
  eventId: EVENT,
  pg: 'TOSS',
  paymentRef: 'tgen_1',
  amount: 10_000,
  cancelledAmount: 0,
  status: 'APPROVED',
};

function fixture(o: { target?: ConfirmedCancelTarget | null; begin?: ConfirmedCancelBegin; finish?: { status: 'APPLIED' | 'STALE'; cancelledAmount: number }; cancel?: CancelResult } = {}) {
  const calls: string[] = [];
  const cancels: Parameters<PaymentGatewayPort['cancel']>[0][] = [];
  const finishes: number[] = [];
  const gateway = {
    pg: 'TOSS',
    cancel: async (c: Parameters<PaymentGatewayPort['cancel']>[0]) => {
      calls.push('cancel');
      cancels.push(c);
      return o.cancel ?? { outcome: 'CANCELLED' };
    },
  } as unknown as PaymentGatewayPort;
  const uc = new CancelConfirmedPayment({
    store: {
      readConfirmedCancelTarget: async () => {
        calls.push('read');
        return o.target === null ? undefined : (o.target ?? TARGET);
      },
      beginConfirmedCancel: async (_t, _id) => {
        calls.push('begin');
        return o.begin ?? 'BEGUN';
      },
      finishConfirmedCancel: async (_t, _id, amount) => {
        calls.push('finish');
        finishes.push(amount);
        return o.finish ?? { status: 'APPLIED', cancelledAmount: (o.target ?? TARGET).cancelledAmount + amount };
      },
    },
    gateways: { of: () => gateway },
    guards: { of: () => ({ tryTakeToken: () => true, circuitClosed: () => true }) as never },
    clock: fakeClock({ now: NOW }),
  });
  return { uc, calls, cancels, finishes };
}

describe('결제 후 일반 취소', () => {
  test('GAT080_부분_취소는_요청액만_결제사에_넘기고_누적액을_더한다', async () => {
    const f = fixture();
    await expect(f.uc.execute({ paymentId: PAYMENT, cancellationId: CANCEL, reason: '관객 취소', amount: 3_000 })).resolves.toEqual({ result: 'CANCELLED', cancelledAmount: 3_000 });
    expect(f.cancels[0]).toMatchObject({ paymentRef: 'tgen_1', amount: 3_000, reason: '관객 취소', idemKey: `cancel-${CANCEL}` });
    expect(f.finishes).toEqual([3_000]);
    expect(f.calls).toEqual(['read', 'begin', 'cancel', 'finish']);
  });

  test('GAT080_금액을_비우면_남은_전액을_ALL로_취소한다', async () => {
    const f = fixture({ target: { ...TARGET, cancelledAmount: 2_000, status: 'PARTIAL_CANCELED' } });
    await expect(f.uc.execute({ paymentId: PAYMENT, cancellationId: CANCEL, reason: '관객 취소' })).resolves.toEqual({ result: 'CANCELLED', cancelledAmount: 10_000 });
    expect(f.cancels[0]).toMatchObject({ amount: 'ALL' });
    expect(f.finishes).toEqual([8_000]);
  });

  test('GAT080_같은_취소_ID로_이미_끝났으면_결제사를_부르지_않는다', async () => {
    const f = fixture({ begin: 'DONE', target: { ...TARGET, cancelledAmount: 10_000, status: 'CANCELED' } });
    await expect(f.uc.execute({ paymentId: PAYMENT, cancellationId: CANCEL, reason: '관객 취소' })).resolves.toEqual({ result: 'CANCELLED', cancelledAmount: 10_000 });
    expect(f.cancels).toHaveLength(0);
    expect(f.finishes).toHaveLength(0);
  });

  test('GAT080_승인_전_상태이거나_남은_금액이_없으면_결제사를_부르지_않는다', async () => {
    await expect(fixture({ target: { ...TARGET, status: 'FAILED' } }).uc.execute({ paymentId: PAYMENT, cancellationId: CANCEL, reason: '관객 취소' })).rejects.toThrow(PaymentCancelStateError);
    await expect(fixture({ target: { ...TARGET, cancelledAmount: 10_000, status: 'CANCELED' } }).uc.execute({ paymentId: PAYMENT, cancellationId: CANCEL, reason: '관객 취소' })).rejects.toThrow(PaymentCancelStateError);
    await expect(fixture({ target: null }).uc.execute({ paymentId: PAYMENT, cancellationId: CANCEL, reason: '관객 취소' })).rejects.toThrow(PaymentNotFoundError);
  });

  test('GAT080_남은_금액보다_큰_요청은_입력_오류다', async () => {
    const f = fixture({ target: { ...TARGET, cancelledAmount: 8_000, status: 'PARTIAL_CANCELED' } });
    await expect(f.uc.execute({ paymentId: PAYMENT, cancellationId: CANCEL, reason: '관객 취소', amount: 3_000 })).rejects.toThrow(PaymentInputError);
    expect(f.cancels).toHaveLength(0);
  });

  test.each(['REJECTED', 'UNKNOWN', 'CANCEL_PENDING'] as const)('GAT080_결제사_%s는_원장을_바꾸지_않는다', async (outcome) => {
    const f = fixture({ cancel: { outcome } });
    await expect(f.uc.execute({ paymentId: PAYMENT, cancellationId: CANCEL, reason: '관객 취소' })).resolves.toEqual({ result: outcome, cancelledAmount: 0 });
    expect(f.finishes).toHaveLength(0);
  });

  test('GAT080_결제사가_취소했다는데_원장이_그사이_바뀌었으면_UNKNOWN이다', async () => {
    const f = fixture({ finish: { status: 'STALE', cancelledAmount: 0 } });
    await expect(f.uc.execute({ paymentId: PAYMENT, cancellationId: CANCEL, reason: '관객 취소' })).resolves.toEqual({ result: 'UNKNOWN', cancelledAmount: 0 });
  });
});
