// 유스케이스: 판매 승인 반려(openapi POST /v1/ops/sale-reviews/{productionId}/rejections, 판매 승인 LCH-080).
// 공연 행 잠금 안에서 상태만 REJECTED로 바꾼다. pending_revision은 다음 수정·재요청에 남긴다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger, ProblemError } from '@peaket/platform';
import { OPS_SALE_STORE, type SaleStore } from '../domain/sale-ports.js';
import { notFound } from './problems.js';

@Injectable()
export class RejectSaleReview {
  constructor(
    @Inject(OPS_SALE_STORE) private readonly store: SaleStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: Pick<PlatformLogger, 'info' | 'warn'>,
  ) {}

  async run(q: { productionId: string; reason: string }): Promise<{ applied: true }> {
    const tenantId = await this.store.promoterOf(q.productionId);
    if (!tenantId) throw notFound();
    const out = await this.store.withLockedProduction(q.productionId, tenantId, async (tx) => {
      const st = await tx.state();
      if (st.production.saleReview !== 'SUBMITTED' && st.production.saleReview !== 'REJECTED') {
        throw new ProblemError({ type: 'sale-review-not-submitted', status: 409, title: '판매 승인 대기 중인 공연이 아닙니다' });
      }
      await tx.reject(q.reason, new Date(this.clock.now()));
    });
    if (out === 'not-found') throw notFound();
    this.logger?.info({ event: 'sale_review_rejected', productionId: q.productionId }, '판매 승인을 반려했다');
    return { applied: true };
  }
}
