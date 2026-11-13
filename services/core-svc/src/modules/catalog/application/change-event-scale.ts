// 유스케이스: 판매 승인 뒤 회차 규모 올리기(openapi POST /v1/ops/events/{eventId}/scale-changes, ADR-0078 결정 1).
// 공연 행 잠금 안에서 판매 승인·T-30분·올리기 방향·대형 간격을 다시 보고, 규모와 판을 쓴다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock, ProblemError } from '@peaket/platform';
import { checkScaleChange, LARGE_INTERVAL_MS } from '../domain/scale-change.js';
import { OPS_SALE_STORE, type SaleStore } from '../domain/sale-ports.js';
import { notFound } from './problems.js';

export interface ScaleChangeInput {
  eventId: string;
  scale: 'LARGE' | 'MEDIUM';
  reason: string;
  intervalException: boolean;
  role: string | undefined;
}

@Injectable()
export class ChangeEventScale {
  constructor(
    @Inject(OPS_SALE_STORE) private readonly sales: SaleStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(input: ScaleChangeInput): Promise<{ applied: true }> {
    const id = input.eventId.toLowerCase();
    const owner = await this.sales.eventOwner(id);
    if (!owner) throw notFound();
    const now = new Date(this.clock.now());
    const out = await this.sales.withScaleChangeLock(owner.tenantId, () =>
      this.sales.withLockedProduction(owner.productionId, owner.tenantId, async (tx) => {
        const state = await tx.state();
        const event = state.events.find((e) => e.eventId === id);
        if (!event) throw notFound();
        const otherLargeOpenAt = await tx.largeOpenTimes(new Date(event.openAt.getTime() - LARGE_INTERVAL_MS), new Date(event.openAt.getTime() + LARGE_INTERVAL_MS), owner.productionId);
        const check = checkScaleChange({
          saleReview: state.production.saleReview,
          currentScale: event.scale,
          openAt: event.openAt,
          now,
          newScale: input.scale,
          intervalException: input.intervalException,
          role: input.role,
          otherLargeOpenAt,
        });
        if (!check.ok) throw new ProblemError(check.problem);
        await tx.setEventScale(event.eventId, input.scale, event.version + 1);
        return { applied: true as const };
      }),
    );
    if (out === 'not-found') throw notFound();
    return out;
  }
}
