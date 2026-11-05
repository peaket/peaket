// 주문 Saga 1단계의 순수 규칙(booking domain/saga.ts, docs/features/payment.md §2 'Saga 1단계의 첫 구현', BUILD_ORDER PRF-165).
// 다시 하기 간격(1초에서 두 배씩 최대 10초 [가정]), 승인 기한(인증 + 10분, 경계는 넘긴 것), 회차 키 수명(판매 종료 + 1일, 경계는 지운 것).
// 상수 값은 함수 시험 안에서 함께 본다(함수가 아직 없으면 같이 실패하게).
import { describe, expect, test } from 'vitest';
import {
  CONFIRM_WINDOW_MS,
  confirmDeadlineAtMs,
  isPastConfirmDeadline,
  isSeatStoreGone,
  SAGA_RETRY_BASE_MS,
  SAGA_RETRY_MAX_MS,
  sagaRetryDelayMs,
  SEAT_KEYS_KEEP_AFTER_SALE_END_MS,
} from '../src/modules/booking/index.js';
import { DAY, NOW } from './order-cases.js';

const MIN = 60_000;

describe('sagaRetryDelayMs: 다시 하기 간격', () => {
  test.each([
    [1, 1000],
    [2, 2000],
    [3, 4000],
    [4, 8000],
    [5, 10_000],
    [6, 10_000],
    [10, 10_000],
    [1000, 10_000],
  ])('FR011_이미 %i번 해 봤으면 %ims 뒤에 다시 한다(1초에서 두 배씩, 최대 10초 [가정])', (attempts, ms) => {
    expect(sagaRetryDelayMs(attempts)).toBe(ms);
  });

  test('FR011_아주 큰 횟수(안전한 정수의 끝)도 넘침 없이 상한 10초다. 첫 간격·상한 상수는 1초·10초다', () => {
    expect(sagaRetryDelayMs(Number.MAX_SAFE_INTEGER)).toBe(10_000);
    expect(sagaRetryDelayMs(1024)).toBe(10_000);
    expect([SAGA_RETRY_BASE_MS, SAGA_RETRY_MAX_MS]).toEqual([1000, 10_000]);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])('FR011_횟수가 1 이상의 안전한 정수가 아니면(%s) RangeError다', (attempts) => {
    expect(() => sagaRetryDelayMs(attempts)).toThrow(RangeError);
  });
});

describe('승인 기한(인증 + 10분, ADR-0107)', () => {
  const AUTH = NOW - 3 * MIN;

  test('FR011_ADR0107_승인 기한 시각은 인증 시각 + 10분이다', () => {
    expect(confirmDeadlineAtMs(AUTH)).toBe(AUTH + 10 * MIN);
    expect(CONFIRM_WINDOW_MS).toBe(10 * MIN);
  });

  test('FR011_ADR0107_정확히 인증 + 10분이면 넘긴 것이다(경계 시각은 넘긴 쪽)', () => {
    expect(isPastConfirmDeadline(AUTH, AUTH + 10 * MIN)).toBe(true);
  });

  test('FR011_ADR0107_그 1ms 전이면 넘기지 않았다', () => {
    expect(isPastConfirmDeadline(AUTH, AUTH + 10 * MIN - 1)).toBe(false);
  });

  test('FR011_ADR0107_인증 직후·한참 뒤', () => {
    expect(isPastConfirmDeadline(AUTH, AUTH)).toBe(false);
    expect(isPastConfirmDeadline(AUTH, AUTH + 2 * MIN)).toBe(false);
    expect(isPastConfirmDeadline(AUTH, AUTH + 60 * MIN)).toBe(true);
  });

  test('FR011_ADR0107_인증 시각이 없으면 넘긴 것으로 본다(승인을 보내지 않는 쪽이 안전하다)', () => {
    expect(isPastConfirmDeadline(undefined, NOW)).toBe(true);
    expect(isPastConfirmDeadline(undefined, 0)).toBe(true);
  });
});

describe('isSeatStoreGone: 회차 키 수명(판매 종료 + 1일)', () => {
  const SALE_END = NOW - 5 * DAY;

  test('FR011_정확히 판매 종료 + 1일이면 지워진 것이다(이때의 NOT_READY는 STORE_GONE). 수명 상수는 1일이다', () => {
    expect(isSeatStoreGone(SALE_END, SALE_END + DAY)).toBe(true);
    expect(SEAT_KEYS_KEEP_AFTER_SALE_END_MS).toBe(DAY);
  });

  test('FR011_그 1ms 전이면 아직 수명 안이다(NOT_READY는 다시 한다)', () => {
    expect(isSeatStoreGone(SALE_END, SALE_END + DAY - 1)).toBe(false);
  });

  test('FR011_판매 중·판매 종료 직후는 수명 안이고, 이틀 뒤는 지워졌다', () => {
    expect(isSeatStoreGone(NOW + DAY, NOW)).toBe(false);
    expect(isSeatStoreGone(SALE_END, SALE_END)).toBe(false);
    expect(isSeatStoreGone(SALE_END, SALE_END + 2 * DAY)).toBe(true);
  });
});
