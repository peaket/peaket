// 유스케이스: 회차 수요 예측 조회(openapi GET /v1/ops/events/{eventId}/demand-forecast, ADR-0078 결정 1).
// 원천(구독 수·지난 회차)은 포트로 분리한다. notify 모듈이 구독 표를 쓰기 전에는 0·빈 이력이라 기본 비율을 쓴다.
// 판매 승인 전 화면에서도 보여야 하므로 공개 카탈로그가 아니라 관제 저장소에서 회차의 공연·판매자를 찾는다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { DEMAND_FORECAST_SOURCE, type DemandForecastSource } from '../domain/demand-ports.js';
import { forecastDemand, type DemandForecast, type ForecastTrigger } from '../domain/demand-forecast.js';
import { OPS_SALE_STORE, type SaleStore } from '../domain/sale-ports.js';
import { notFound } from './problems.js';

@Injectable()
export class GetDemandForecast {
  constructor(
    @Inject(OPS_SALE_STORE) private readonly sales: SaleStore,
    @Inject(DEMAND_FORECAST_SOURCE) private readonly source: DemandForecastSource,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async get(eventId: string, trigger: ForecastTrigger = 'SALE_REVIEW'): Promise<DemandForecast> {
    const id = eventId.toLowerCase();
    const owner = await this.sales.eventOwner(id);
    if (!owner) throw notFound();
    const state = await this.sales.read(owner.productionId, owner.tenantId);
    const event = state?.events.find((e) => e.eventId === id);
    const added = state?.addedEvents.find((e) => e.eventId === id);
    if (!event && !added) throw notFound();
    const currentScale = event?.scale;
    const [subscribers, history] = await Promise.all([this.source.subscribers(id), this.source.history(id)]);
    return forecastDemand({ eventId: id, now: new Date(this.clock.now()), trigger, subscribers, history, ...(currentScale ? { currentScale } : {}) });
  }
}
