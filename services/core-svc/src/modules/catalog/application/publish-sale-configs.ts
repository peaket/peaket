// 유스케이스: 승인된 공연의 회차 판매 설정 사본을 만든다(판매 승인 LCH-080, docs/features/seat-hold.md §4, ADR-0327).
// 차례: ① 비취소·판매 종료 전 회차마다 purchase-svc 내부 판매 열기를 시작 시각 오름차순으로 부른다
// ② 열기가 성공(opened·exists)한 회차만, 그리고 이미 판매가 끝난 회차는 사본을 쓴다 ③ 실패한 회차는 쓰지 않아 대기열이 닫힌 채로 남는다.
// queue-svc용 대기열 Redis 사본과 purchase-svc(BAT-051)용 core DB 사본을 함께 쓴다. 정비 일 `sale-config-publish`가 같은 함수로 다시 시도한다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger, ProblemError } from '@peaket/platform';
import { buildEventSaleConfigs } from '../domain/event-sale-config.js';
import { SALE_CONFIG_FACTS, SALE_CONFIG_STORE, type SaleConfigFactsSource, type SaleConfigStore } from '../domain/sale-config-ports.js';
import { SALE_OPEN, type SaleOpen, type SaleOpenResult } from '../domain/sale-open-port.js';
import { saleEndsAt } from '../domain/production.js';
import { SALE_STORE, type SaleState, type SaleStore } from '../domain/sale-ports.js';
import { SALE_CONFIG_METRICS, type SaleConfigMetrics } from './sale-config-metrics.js';
import { notFound } from './problems.js';

@Injectable()
export class PublishSaleConfigs {
  constructor(
    @Inject(SALE_STORE) private readonly sales: SaleStore,
    @Inject(SALE_CONFIG_STORE) private readonly configs: SaleConfigStore,
    @Inject(SALE_CONFIG_FACTS) private readonly facts: SaleConfigFactsSource,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(SALE_OPEN) private readonly saleOpen?: SaleOpen,
    @Optional() @Inject(SALE_CONFIG_METRICS) private readonly metrics?: SaleConfigMetrics,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: Pick<PlatformLogger, 'info' | 'warn'>,
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
    const now = new Date(this.clock.now());
    const live = st.events.filter((e) => e.status !== 'CANCELLED');
    const opening = live.filter((e) => !this.#ended(e, now)).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || (a.eventId < b.eventId ? -1 : 1));
    const opened = new Set<string>();
    for (const e of opening) {
      let result: SaleOpenResult | 'error';
      try {
        // 포트를 잇지 않은 직접 조립(단위 시험)은 예전처럼 열기가 끝난 것으로 본다. 운영 조립은 늘 포트를 넘긴다
        result = this.saleOpen ? await this.saleOpen.open({ eventId: e.eventId, productionId: st.production.id, openAtMs: e.openAt.getTime(), startsAtMs: e.startsAt.getTime() }) : 'opened';
      } catch (err) {
        result = 'error';
        this.logger?.warn({ event: 'sale_open_failed', productionId: st.production.id, eventId: e.eventId, err: (err as Error).name }, '판매 열기를 부르지 못했다(사본을 쓰지 않아 대기열은 닫힌 채로 남는다)');
      }
      this.metrics?.saleOpen(result);
      if (result === 'opened' || result === 'exists') opened.add(e.eventId);
      else if (result === 'no-layout') this.logger?.warn({ event: 'sale_open_no_layout', productionId: st.production.id, eventId: e.eventId }, '좌석맵 판이 없어 판매 열기를 닫았다(409 sale-not-publishable)');
      else if (result === 'unwired') this.logger?.warn({ event: 'sale_open_unwired', productionId: st.production.id, eventId: e.eventId }, 'purchase-svc 주소가 없어 판매 열기와 사본 쓰기를 하지 않는다');
    }
    // 열기가 실패한 회차는 사본을 쓰지 않는다(대기열 404 = 닫힘, B13). 이미 판매가 끝난 회차는 열지 않지만 정산 원천 사본은 쓴다
    const publishable = live.filter((e) => opened.has(e.eventId) || this.#ended(e, now));
    if (publishable.length === 0) return { events: 0, rev: 0 };
    const ids = new Set(publishable.map((e) => e.eventId));
    const facts = await this.facts.of([...ids]);
    const configs = buildEventSaleConfigs(st, facts, now).filter((c) => ids.has(c.eventId));
    try {
      await this.configs.put(
        configs,
        configs.map((c) => ({ eventId: c.eventId, startsAtMs: c.startsAtMs })),
      );
      this.metrics?.publish('ok');
    } catch (err) {
      this.metrics?.publish('failed');
      throw err;
    }
    return { events: configs.length, rev: Math.max(0, ...configs.map((c) => c.rev)) };
  }

  #ended(e: { startsAt: Date }, now: Date): boolean {
    return now.getTime() >= saleEndsAt(e).getTime();
  }
}
