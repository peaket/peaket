// 유스케이스: 승인된 공연의 회차 판매 설정 사본을 만든다(판매 승인 LCH-080, docs/features/seat-hold.md §4).
// 판매 승인은 이 유스케이스를 승인 트랜잭션 뒤에 부르고, 정비 일 `sale-config-publish`가 승인 공연을 다시 훑어 복구한다.
// queue-svc용 대기열 Redis 사본과 purchase-svc(BAT-051)용 core DB 사본을 함께 쓴다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock, ProblemError } from '@peaket/platform';
import { buildEventSaleConfigs } from '../domain/event-sale-config.js';
import { SALE_CONFIG_FACTS, SALE_CONFIG_STORE, type SaleConfigFactsSource, type SaleConfigStore } from '../domain/sale-config-ports.js';
import { SALE_STORE, type SaleState, type SaleStore } from '../domain/sale-ports.js';
import { notFound } from './problems.js';

@Injectable()
export class PublishSaleConfigs {
  constructor(
    @Inject(SALE_STORE) private readonly sales: SaleStore,
    @Inject(SALE_CONFIG_STORE) private readonly configs: SaleConfigStore,
    @Inject(SALE_CONFIG_FACTS) private readonly facts: SaleConfigFactsSource,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** 승인된 공연 하나의 모든 회차를 쓴다. 승인 전이면 409다 */
  async run(q: { productionId: string; tenantId: string }): Promise<{ events: number; rev: number }> {
    const st = await this.sales.read(q.productionId, q.tenantId);
    if (!st) throw notFound();
    return this.publishState(st, q.tenantId);
  }

  /** 이미 읽은 승인 상태로 쓴다(승인 트랜잭션 직후, 다시 읽지 않는다) */
  async publishState(st: SaleState, _tenantId: string): Promise<{ events: number; rev: number }> {
    if (st.production.saleReview !== 'APPROVED' || st.production.saleApprovedAt === null) {
      throw new ProblemError({ type: 'sale-review-not-approved', status: 409, title: '판매 승인된 공연만 회차 설정을 쓸 수 있습니다' });
    }
    const eventIds = st.events.filter((e) => e.status !== 'CANCELLED').map((e) => e.eventId);
    const facts = await this.facts.of(eventIds);
    const configs = buildEventSaleConfigs(st, facts, new Date(this.clock.now()));
    await this.configs.put(
      configs,
      configs.map((c) => ({ eventId: c.eventId, startsAtMs: c.startsAtMs })),
    );
    return { events: configs.length, rev: Math.max(0, ...configs.map((c) => c.rev)) };
  }
}
