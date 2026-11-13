// 환급 실행기(GAT-080·GAT-090): 입장 기록 마감 뒤 REQUESTED와 재시도할 REFUND_PENDING을 결제사 취소로 이어 간다.
import { describe, expect, test } from 'vitest';
import { REFUND_RETRY_MAX_ATTEMPTS, RefundAfterEntry, refundRetryDelayMs } from '../src/modules/refund/index.js';

const NOW = Date.parse('2026-11-21T00:00:00Z');

interface Row {
  cancellationId: string;
  orderId: string;
  amount: number;
  reason: 'USER';
  status: 'REQUESTED' | 'REFUND_PENDING';
  attempts: number;
}

function fixture(rows: Row[], outcomes: Record<string, 'CANCELLED' | 'PENDING' | 'UNKNOWN' | 'REJECTED'>) {
  const updates: { cancellationId: string; status: string }[] = [];
  const retries: { cancellationId: string; attempts: number; nextRetryAtMs: number; lastError: string }[] = [];
  const failures: { cancellationId: string; attempts: number; lastError: string }[] = [];
  const notices: { cancellationId: string; attempts: number; lastError: string }[] = [];
  const calls: { cancellationId: string; amount: number }[] = [];
  const refund = new RefundAfterEntry({
    nowMs: () => NOW,
    writes: {
      dueRefunds: async () => rows,
      updateStatus: async (q: { cancellationId: string; status: string }) => void updates.push({ cancellationId: q.cancellationId, status: q.status }),
      scheduleRefundRetry: async (q: { cancellationId: string; attempts: number; nextRetryAtMs: number; lastError: string }) => void retries.push(q),
      markRefundFailed: async (q: { cancellationId: string; attempts: number; lastError: string }) => void failures.push(q),
    } as never,
    payments: {
      cancel: async (q) => {
        calls.push({ cancellationId: q.cancellationId, amount: q.amount });
        return outcomes[q.cancellationId]!;
      },
    },
    failureNotice: { open: async (q: { cancellationId: string; attempts: number; lastError: string }) => void notices.push(q) },
  });
  return { refund, updates, retries, failures, notices, calls };
}

const row = (id: string, status: Row['status'], attempts = 0, amount = 10_000): Row => ({ cancellationId: id, orderId: `o-${id}`, amount, reason: 'USER', status, attempts });

describe('환급 실행기', () => {
  test('GAT080_환급시각이_지난_REQUESTED를_결제사취소하고_모름은_다음재시도를_적는다', async () => {
    const f = fixture([row('c1', 'REQUESTED'), row('c2', 'REQUESTED', 0, 20_000)], { c1: 'CANCELLED', c2: 'UNKNOWN' });
    await expect(f.refund.run()).resolves.toEqual({ refunded: 1, pending: 1, failed: 0 });
    expect(f.calls).toEqual([
      { cancellationId: 'c1', amount: 10_000 },
      { cancellationId: 'c2', amount: 20_000 },
    ]);
    expect(f.updates).toEqual([{ cancellationId: 'c1', status: 'REFUNDED' }]);
    expect(f.retries[0]).toMatchObject({ cancellationId: 'c2', attempts: 1, nextRetryAtMs: NOW + refundRetryDelayMs(1), lastError: 'UNKNOWN' });
    expect(f.failures).toHaveLength(0);
  });

  test('GAT090_REFUND_PENDING은_재시도하고_시도횟수에_맞는_간격으로_미룬다', async () => {
    const f = fixture([row('c1', 'REFUND_PENDING', 2)], { c1: 'PENDING' });
    await expect(f.refund.run()).resolves.toEqual({ refunded: 0, pending: 1, failed: 0 });
    expect(f.retries[0]).toMatchObject({ cancellationId: 'c1', attempts: 3, nextRetryAtMs: NOW + refundRetryDelayMs(3), lastError: 'PENDING' });
  });

  test('GAT090_업무거절은_바로_CS처리함_대상으로_남긴다', async () => {
    const f = fixture([row('c1', 'REFUND_PENDING', 1)], { c1: 'REJECTED' });
    await expect(f.refund.run()).resolves.toEqual({ refunded: 0, pending: 0, failed: 1 });
    expect(f.failures[0]).toMatchObject({ cancellationId: 'c1', attempts: 2, lastError: 'REJECTED' });
    expect(f.notices[0]).toMatchObject({ cancellationId: 'c1', attempts: 2, lastError: 'REJECTED' });
    expect(f.retries).toHaveLength(0);
  });

  test('GAT090_재시도_상한을_넘으면_CS처리함_대상으로_남긴다', async () => {
    const f = fixture([row('c1', 'REFUND_PENDING', REFUND_RETRY_MAX_ATTEMPTS - 1)], { c1: 'UNKNOWN' });
    await expect(f.refund.run()).resolves.toEqual({ refunded: 0, pending: 0, failed: 1 });
    expect(f.failures[0]).toMatchObject({ cancellationId: 'c1', attempts: REFUND_RETRY_MAX_ATTEMPTS, lastError: 'UNKNOWN' });
    expect(f.notices).toHaveLength(1);
  });

  test('GAT090_재시도_간격은_1분에서_6시간까지_늘고_상한을_넘어도_마지막_간격이다', () => {
    expect([1, 2, 3, 4, 5].map(refundRetryDelayMs)).toEqual([60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000]);
    expect(refundRetryDelayMs(9)).toBe(6 * 60 * 60_000);
    expect(() => refundRetryDelayMs(0)).toThrow(RangeError);
  });
});
