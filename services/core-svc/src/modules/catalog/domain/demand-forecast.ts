// 수요 예측(ADR-0078 결정 1, POL-030): 예상 진입 인원 = 오픈 알림 구독 수 × 구독 대비 진입 비율.
// 비율은 구독 수가 이 회차의 0.5~2배인 지난 회차의 실제 진입 ÷ 오픈 30분 전 구독 수의 중앙값·75번째 백분위다.
// 그런 회차가 10개 미만이면 기본 비율(중앙 2.0·상단 3.0 [가정])을 쓴다. 머신러닝이 아니다.
export type ShowScale = 'LARGE' | 'MEDIUM' | 'SMALL';
export type ForecastTrigger = 'SALE_REVIEW' | 'DAILY' | 'T_MINUS_30';

export interface ForecastHistoryRow {
  /** 그 회차의 오픈 30분 전 오픈 알림 구독 수 */
  readonly subscribers30m: number;
  /** 그 회차의 실제 진입 인원 */
  readonly entrants: number;
}

export interface DemandForecast {
  readonly eventId: string;
  readonly computedAt: string;
  readonly trigger: ForecastTrigger;
  readonly subscribers: number;
  readonly ratioMedian: number;
  readonly ratioUpper: number;
  readonly sampleCount: number;
  readonly defaultRatioUsed: boolean;
  readonly expectedMedian: number;
  readonly expectedUpper: number;
  readonly suggestedScale: ShowScale;
  readonly currentScale: ShowScale | null;
  readonly raiseSuggested: boolean;
}

export const DEFAULT_RATIO_MEDIAN = 2.0;
export const DEFAULT_RATIO_UPPER = 3.0;
export const MIN_FORECAST_SAMPLE = 10;
export const LARGE_THRESHOLD = 500_000;
export const MEDIUM_THRESHOLD = 100_000;

const rank: Record<ShowScale, number> = { SMALL: 0, MEDIUM: 1, LARGE: 2 };
export const scaleRank = (s: ShowScale): number => rank[s];

/** 중앙값(짝수면 가운데 둘의 평균)과 75번째 백분위(가까운 차례) */
export function medianAndUpper(values: readonly number[]): { median: number; upper: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const median = n % 2 === 1 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
  const upper = sorted[Math.min(n - 1, Math.ceil(n * 0.75) - 1)]!;
  return { median, upper };
}

export function suggestedScaleOf(expectedUpper: number): ShowScale {
  return expectedUpper >= LARGE_THRESHOLD ? 'LARGE' : expectedUpper >= MEDIUM_THRESHOLD ? 'MEDIUM' : 'SMALL';
}

export function forecastDemand(input: {
  eventId: string;
  now: Date;
  trigger: ForecastTrigger;
  subscribers: number;
  history: readonly ForecastHistoryRow[];
  currentScale?: ShowScale;
}): DemandForecast {
  // ADR-0078: 구독 수가 이 회차의 0.5~2배인 지난 회차만 비율에 쓴다(원천이 넓게 줘도 도메인에서 거른다)
  const usable = input.history.filter(
    (h) => h.subscribers30m > 0 && h.entrants >= 0 && h.subscribers30m >= input.subscribers * 0.5 && h.subscribers30m <= input.subscribers * 2,
  );
  const defaultRatioUsed = usable.length < MIN_FORECAST_SAMPLE;
  const ratios = usable.map((h) => h.entrants / h.subscribers30m);
  const { median, upper } = defaultRatioUsed ? { median: DEFAULT_RATIO_MEDIAN, upper: DEFAULT_RATIO_UPPER } : medianAndUpper(ratios);
  const expectedMedian = Math.round(input.subscribers * median);
  const expectedUpper = Math.round(input.subscribers * upper);
  const suggestedScale = suggestedScaleOf(expectedUpper);
  const currentScale = input.currentScale ?? null;
  return {
    eventId: input.eventId,
    computedAt: input.now.toISOString(),
    trigger: input.trigger,
    subscribers: input.subscribers,
    ratioMedian: median,
    ratioUpper: upper,
    sampleCount: usable.length,
    defaultRatioUsed,
    expectedMedian,
    expectedUpper,
    suggestedScale,
    currentScale,
    raiseSuggested: currentScale !== null && scaleRank(suggestedScale) > scaleRank(currentScale),
  };
}
