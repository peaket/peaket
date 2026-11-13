// 수요 예측과 규모 올리기 규칙(ADR-0078 결정 1, POL-030). 순수 함수만 시험한다.
import { describe, expect, test } from 'vitest';
import { forecastDemand, medianAndUpper, suggestedScaleOf } from '../src/modules/catalog/domain/demand-forecast.js';
import { checkScaleChange } from '../src/modules/catalog/domain/scale-change.js';

const NOW = new Date('2026-11-01T00:00:00.000Z');
const OPEN = new Date('2026-11-20T11:00:00.000Z');

const history = (ratios: number[], subscribers30m = 100) => ratios.map((r) => ({ subscribers30m, entrants: subscribers30m * r }));

describe('수요 예측(POL-030)', () => {
  test('C-T43 medianAndUpper는 짝수·홀수 중앙값과 75번째 백분위를 낸다', () => {
    expect(medianAndUpper([3, 1, 4])).toEqual({ median: 3, upper: 4 });
    expect(medianAndUpper([1, 2, 3, 4])).toEqual({ median: 2.5, upper: 3 });
    expect(medianAndUpper([10])).toEqual({ median: 10, upper: 10 });
  });

  test('C-T43 표본이 10개 미만이면 기본 비율(중앙 2.0·상단 3.0)을 쓴다', () => {
    const f = forecastDemand({
      eventId: 'ev-1',
      now: NOW,
      trigger: 'SALE_REVIEW',
      subscribers: 200_000,
      history: history([1, 2, 3], 200_000),
      currentScale: 'MEDIUM',
    });
    expect(f).toMatchObject({
      subscribers: 200_000,
      ratioMedian: 2,
      ratioUpper: 3,
      sampleCount: 3,
      defaultRatioUsed: true,
      expectedMedian: 400_000,
      expectedUpper: 600_000,
      suggestedScale: 'LARGE',
      currentScale: 'MEDIUM',
      raiseSuggested: true,
    });
    expect(f.computedAt).toBe(NOW.toISOString());
  });

  test('C-T43 표본이 10개 이상이면 지난 회차 비율의 중앙값·75번째 백분위를 쓴다', () => {
    const f = forecastDemand({
      eventId: 'ev-1',
      now: NOW,
      trigger: 'DAILY',
      subscribers: 100,
      history: history([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      currentScale: 'SMALL',
    });
    expect(f).toMatchObject({
      ratioMedian: 5.5,
      ratioUpper: 8,
      sampleCount: 10,
      defaultRatioUsed: false,
      expectedMedian: 550,
      expectedUpper: 800,
      suggestedScale: 'SMALL',
      raiseSuggested: false,
    });
  });

  test('C-T43 구독 수 0.5~2배 밖의 지난 회차는 비율에서 뺀다', () => {
    const inRange = Array.from({ length: 10 }, (_, i) => ({ subscribers30m: 100, entrants: 100 * (i + 1) }));
    const f = forecastDemand({
      eventId: 'ev-1',
      now: NOW,
      trigger: 'DAILY',
      subscribers: 100,
      history: [...inRange, { subscribers30m: 49, entrants: 999 }, { subscribers30m: 201, entrants: 999 }],
    });
    expect(f).toMatchObject({ sampleCount: 10, defaultRatioUsed: false, ratioMedian: 5.5, ratioUpper: 8 });
  });

  test('C-T43 구독자가 0이거나 이력이 비어도 기본 비율로 계산한다', () => {
    const f = forecastDemand({ eventId: 'ev-1', now: NOW, trigger: 'T_MINUS_30', subscribers: 0, history: [] });
    expect(f).toMatchObject({ subscribers: 0, expectedMedian: 0, expectedUpper: 0, suggestedScale: 'SMALL', currentScale: null, raiseSuggested: false });
  });

  test('C-T43 규모 경계는 10만·50만이다', () => {
    expect(suggestedScaleOf(99_999)).toBe('SMALL');
    expect(suggestedScaleOf(100_000)).toBe('MEDIUM');
    expect(suggestedScaleOf(499_999)).toBe('MEDIUM');
    expect(suggestedScaleOf(500_000)).toBe('LARGE');
  });
});

describe('규모 올리기(ADR-0078 결정 1)', () => {
  const base = {
    saleReview: 'APPROVED',
    currentScale: 'SMALL' as const,
    openAt: OPEN,
    now: NOW,
    newScale: 'MEDIUM' as const,
    intervalException: false,
    role: 'operator',
    otherLargeOpenAt: [] as Date[],
  };

  test('C-T43 판매 승인 뒤 더 큰 규모로는 올릴 수 있다', () => {
    expect(checkScaleChange(base)).toEqual({ ok: true });
  });

  test('C-T43 판매 승인 전이면 422다', () => {
    expect(checkScaleChange({ ...base, saleReview: 'SUBMITTED' })).toMatchObject({ ok: false, problem: { type: 'scale-change-not-approved', status: 422 } });
  });

  test('C-T43 T-30분 점검이 시작되면 409다', () => {
    const now = new Date(OPEN.getTime() - 30 * 60_000);
    expect(checkScaleChange({ ...base, now })).toMatchObject({ ok: false, problem: { type: 'scale-change-closed', status: 409 } });
    expect(checkScaleChange({ ...base, now: new Date(now.getTime() - 1) })).toEqual({ ok: true });
  });

  test('C-T43 같거나 낮은 규모, 규모가 없는 회차는 올릴 수 없다', () => {
    expect(checkScaleChange({ ...base, newScale: 'SMALL' })).toMatchObject({ ok: false, problem: { type: 'scale-change-not-up', status: 422 } });
    expect(checkScaleChange({ ...base, newScale: 'LARGE', currentScale: 'LARGE' })).toMatchObject({ ok: false, problem: { type: 'scale-change-not-up' } });
    expect(checkScaleChange({ ...base, currentScale: undefined })).toMatchObject({ ok: false, problem: { type: 'scale-change-not-up' } });
  });

  test('C-T43 간격 예외는 commander만 쓴다', () => {
    expect(checkScaleChange({ ...base, intervalException: true })).toMatchObject({ ok: false, problem: { type: 'commander-required', status: 403 } });
    expect(checkScaleChange({ ...base, intervalException: true, role: 'commander' })).toEqual({ ok: true });
  });

  test('C-T43 LARGE로 올릴 때 다른 LARGE와 30분 안이면 409이고 commander 예외로만 통과한다', () => {
    const otherLargeOpenAt = [new Date(OPEN.getTime() + 30 * 60_000 - 1)];
    expect(checkScaleChange({ ...base, newScale: 'LARGE', otherLargeOpenAt })).toMatchObject({ ok: false, problem: { type: 'open-interval-conflict', status: 409 } });
    expect(checkScaleChange({ ...base, newScale: 'LARGE', otherLargeOpenAt: [new Date(OPEN.getTime() + 30 * 60_000)] })).toEqual({ ok: true });
    expect(checkScaleChange({ ...base, newScale: 'LARGE', otherLargeOpenAt, intervalException: true, role: 'commander' })).toEqual({ ok: true });
    expect(checkScaleChange({ ...base, newScale: 'MEDIUM', otherLargeOpenAt })).toEqual({ ok: true });
  });
});
