// 수요 예측 원천 어댑터. notify 모듈의 구독 표가 아직 없어 운영은 0과 빈 이력을 돌려준다.
// 구독 표가 생기면 이 파일만 실제 조회로 바꾼다(계획 docs/review/plans/BAT-620.md).
import type { DemandForecastSource } from '../domain/demand-ports.js';
import type { ForecastHistoryRow } from '../domain/demand-forecast.js';

export class EmptyDemandForecastSource implements DemandForecastSource {
  constructor(private readonly subscribersOf: (eventId: string) => Promise<number> = async () => 0) {}

  subscribers(eventId: string): Promise<number> {
    return this.subscribersOf(eventId);
  }

  async history(): Promise<readonly ForecastHistoryRow[]> {
    return [];
  }
}
