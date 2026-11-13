// 수요 예측 원천(오픈 알림 구독 수·지난 회차 진입 비율). notify 모듈이 구독 표를 쓰기 전에는
// 운영 어댑터가 0과 빈 이력을 돌려주고, 화면은 기본 비율로 계산한다(ADR-0078).
import type { ForecastHistoryRow } from './demand-forecast.js';

export interface DemandForecastSource {
  subscribers(eventId: string): Promise<number>;
  history(eventId: string): Promise<readonly ForecastHistoryRow[]>;
}

export const DEMAND_FORECAST_SOURCE = Symbol('DEMAND_FORECAST_SOURCE');
