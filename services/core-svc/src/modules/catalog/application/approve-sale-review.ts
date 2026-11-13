// 유스케이스: 판매 승인 실행(openapi POST /v1/ops/sale-reviews/{productionId}/approvals, 판매 승인 LCH-080).
// 공연 행 잠금 안에서 pending_revision의 규칙·회차 고침·더한 회차를 공개본으로 옮기고, 규모·결제사 칸을 정한다.
// 커밋 뒤 회차 판매 설정 사본을 쓴다. 사본 쓰기가 실패해도 승인은 남고, 정비 일 sale-config-publish가 다시 쓴다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger, ProblemError } from '@peaket/platform';
import type { SaleApprovalInput, ShowScale } from '../domain/sale-approval.js';
import { eligibleListKeys } from '../domain/event-sale-config.js';
import { OPS_SALE_STORE, type SaleStore } from '../domain/sale-ports.js';
import { PublishSaleConfigs } from './publish-sale-configs.js';
import { notFound, productionSuspended } from './problems.js';

export interface ApproveSaleReviewInput {
  productionId: string;
  scales: { eventId: string; scale: ShowScale }[];
  placeId?: string;
  accessibleSeatingCheck?: boolean;
}

@Injectable()
export class ApproveSaleReview {
  constructor(
    @Inject(OPS_SALE_STORE) private readonly store: SaleStore,
    private readonly publish: PublishSaleConfigs,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: Pick<PlatformLogger, 'info' | 'warn'>,
  ) {}

  async run(q: ApproveSaleReviewInput): Promise<{ applied: true; events: number }> {
    const tenantId = await this.store.promoterOf(q.productionId);
    if (!tenantId) throw notFound();
    const input: SaleApprovalInput = { now: new Date(this.clock.now()), scales: q.scales, ...(q.placeId !== undefined ? { placeId: q.placeId } : {}), ...(q.accessibleSeatingCheck !== undefined ? { accessibleSeatingCheck: q.accessibleSeatingCheck } : {}) };
    const out = await this.store.withScaleChangeLock(tenantId, () =>
      this.store.withLockedProduction(q.productionId, tenantId, async (tx) => {
        const st = await tx.state();
        if (st.production.saleReview === 'SUSPENDED') throw productionSuspended();
        if (st.production.saleReview !== 'SUBMITTED' && st.production.saleReview !== 'REJECTED') {
          throw new ProblemError({ type: 'sale-review-not-submitted', status: 409, title: '판매 승인 대기 중인 공연이 아닙니다' });
        }
        const targets = new Set([...st.events.map((e) => e.eventId), ...st.addedEvents.map((e) => e.eventId)]);
        const given = new Set(q.scales.map((s) => s.eventId));
        if (given.size !== targets.size || [...targets].some((id) => !given.has(id))) {
          throw new ProblemError({ type: 'sale-review-scales-missing', status: 422, title: '모든 회차의 공연 규모를 정해 주세요' });
        }
        const rules = st.production.pendingRules ?? st.production.rules;
        const available = new Set(st.lists.map((l) => l.key));
        for (const e of targets) {
          for (const key of eligibleListKeys(rules, e)) {
            if (!available.has(key)) throw new ProblemError({ type: 'sale-review-list-missing', status: 422, title: '판매 정책이 쓰는 명단이 없습니다' });
          }
        }
        return tx.approve(input);
      }),
    );
    if (out === 'not-found') throw notFound();
    try {
      await this.publish.publishState(out, tenantId);
    } catch (err) {
      // 승인은 커밋됐다. 사본은 정비 일이 다시 쓰므로 응답을 실패로 바꾸지 않는다(로그만 남긴다)
      this.logger?.warn({ event: 'sale_config_publish_failed', productionId: q.productionId, err: (err as Error).name }, '판매 승인 뒤 회차 판매 설정 사본을 쓰지 못했다(정비 일이 다시 쓴다)');
    }
    this.logger?.info({ event: 'sale_review_approved', productionId: q.productionId, events: out.events.length }, '판매 승인을 적용했다');
    return { applied: true, events: out.events.length };
  }
}
