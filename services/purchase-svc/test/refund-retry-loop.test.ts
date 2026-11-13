// 환급 재시도 반복(GAT-090): 리더만 1분마다 실행기를 부른다.
import { describe, expect, test } from 'vitest';
import { RefundRetryLoop } from '../src/modules/refund/index.js';

describe('환급 재시도 반복', () => {
  test('GAT090_리더가_아니면_실행기를_부르지_않는다', async () => {
    let calls = 0;
    const loop = new RefundRetryLoop({
      refund: { run: async () => (calls++, { refunded: 1, pending: 0, failed: 0 }) },
      leader: { isLeader: () => false },
    });
    await expect(loop.tick()).resolves.toEqual({ skipped: 'not_leader' });
    expect(calls).toBe(0);
  });

  test('GAT090_리더면_실행기를_불러_환급·대기·실패 수를_돌려준다', async () => {
    const loop = new RefundRetryLoop({
      refund: { run: async () => ({ refunded: 2, pending: 1, failed: 1 }) },
      leader: { isLeader: () => true },
    });
    await expect(loop.tick()).resolves.toEqual({ refunded: 2, pending: 1, failed: 1 });
  });

  test('GAT090_실행기가_던지면_tick이_던지고_반복은_다음_틱에_다시_본다', async () => {
    let calls = 0;
    const loop = new RefundRetryLoop({
      refund: {
        run: async () => {
          calls++;
          throw new Error('일시 실패');
        },
      },
      leader: { isLeader: () => true },
    });
    await expect(loop.tick()).rejects.toThrow('일시 실패');
    expect(calls).toBe(1);
  });
});
