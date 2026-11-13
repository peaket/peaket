// 취소 뒤 주문 상태 전이(GAT-090): 부분 환불 T22·T25, 전액 환불 T23·T24.
import { describe, expect, test } from 'vitest';
import { orderTransitionAfterCancel } from '../src/modules/refund/adapters/db/drizzle-cancellation.js';

describe('취소 뒤 주문 상태 전이', () => {
  test('GAT090_일부만_취소하거나_환급이_끝나지_않았으면_PARTIALLY_REFUNDED로_간다', () => {
    expect(orderTransitionAfterCancel('CONFIRMED', 2, 1)).toBe('T22');
    expect(orderTransitionAfterCancel('PARTIALLY_REFUNDED', 2, 1)).toBe('T25');
    expect(orderTransitionAfterCancel('CONFIRMED', 1, 1, 0)).toBe('T22');
  });

  test('GAT090_모든_항목이_취소되고_환급까지_끝나면_REFUNDED로_간다', () => {
    expect(orderTransitionAfterCancel('CONFIRMED', 1, 1, 1)).toBe('T24');
    expect(orderTransitionAfterCancel('PARTIALLY_REFUNDED', 2, 2, 2)).toBe('T23');
  });

  test('GAT090_이미_끝난_주문이나_항목이_없으면_전이하지_않는다', () => {
    expect(orderTransitionAfterCancel('REFUNDED', 1, 1, 1)).toBeUndefined();
    expect(orderTransitionAfterCancel('FAILED', 1, 1)).toBeUndefined();
    expect(orderTransitionAfterCancel('CONFIRMED', 0, 0)).toBeUndefined();
  });
});
