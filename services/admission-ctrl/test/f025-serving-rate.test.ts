// IR-07: servingRate는 전진 상한(share.rate)이 아니라 최근 10초 serving 증가 속도다(ADR-0365 결정 11, C-T6 ①).
import { describe, expect, test } from 'vitest';
import { servingRateOf } from '../src/modules/leader/index.js';

describe('IR-07 servingRate 계산', () => {
  test('최근 10초 창의 serving 차이를 지난 시간(초)으로 나눈다', () => {
    expect(
      servingRateOf(
        [
          { atMs: 0, serving: 100 },
          { atMs: 10_000, serving: 300 },
        ],
        10_000,
      ),
    ).toBe(20);
  });

  test('표본이 2개 미만이거나 창 안에 남은 표본이 하나면 no-source(undefined)다', () => {
    expect(servingRateOf([], 10_000)).toBeUndefined();
    expect(servingRateOf([{ atMs: 10_000, serving: 300 }], 10_000)).toBeUndefined();
    expect(
      servingRateOf(
        [
          { atMs: 0, serving: 100 },
          { atMs: 5_000, serving: 200 },
        ],
        12_000,
      ),
    ).toBeUndefined();
  });
});
