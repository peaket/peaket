// 입장 기록 마감 뒤 환급 실행기(GAT-080): 환급 시각이 지난 REQUESTED만 결제사 취소로 이어 간다.
import { describe, expect, test } from 'vitest';
import { RefundAfterEntry } from '../src/modules/refund/index.js';

const NOW = Date.parse('2026-11-21T00:00:00Z');

describe('입장 기록 마감 뒤 환급', () => {
  test('GAT080_환급시각이_지난_REQUESTED만_결제사취소하고_CANCELLED면_REFUNDED로_바꾼다', async () => {
    const updates: { cancellationId: string; status: string }[] = [];
    const calls: { cancellationId: string; amount: number }[] = [];
    const refund = new RefundAfterEntry({
      nowMs: () => NOW,
      writes: {
        dueRefunds: async () => [
          { cancellationId: 'c1', orderId: 'o1', amount: 10_000, reason: 'USER' },
          { cancellationId: 'c2', orderId: 'o2', amount: 20_000, reason: 'USER' },
        ],
        updateStatus: async (q: { cancellationId: string; status: string }) => void updates.push({ cancellationId: q.cancellationId, status: q.status }),
      } as never,
      payments: {
        cancel: async (q) => {
          calls.push({ cancellationId: q.cancellationId, amount: q.amount });
          return q.cancellationId === 'c1' ? 'CANCELLED' : 'UNKNOWN';
        },
      },
    });
    await expect(refund.run()).resolves.toEqual({ refunded: 1, pending: 1 });
    expect(calls).toEqual([
      { cancellationId: 'c1', amount: 10_000 },
      { cancellationId: 'c2', amount: 20_000 },
    ]);
    expect(updates).toEqual([{ cancellationId: 'c1', status: 'REFUNDED' }]);
  });
});
