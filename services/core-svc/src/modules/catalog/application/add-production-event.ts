// 유스케이스: 회차 더하기(openapi POST /v1/partner/productions/{productionId}/events, ADR-0198 결정 3, BUILD_ORDER HOT-171).
// 판정 순서: 그 테넌트의 공연인가(아니면 없는 공연과 같은 404) → 판매 중지(409) → 승인 이력이 있으면 파트너 관리자만(403) →
// 일정·정렬(422) → 정비 창·오픈 간격(409). 승인 이력이 없으면 event 행으로 바로 넣고(배치본은 그 공연의 다른 회차와 같은 값),
// 있으면 변경분(pending_revision.addedEvents)에만 두고 APPROVED는 SUBMITTED로 바꾼다(planning/03 §2.14 T7). 공개본은 늘 마지막 승인 내용이다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock, uuidv7 } from '@peaket/platform';
import { CATALOG_REPOSITORY, type CatalogRepository, type RequestOnce } from '../domain/ports.js';
import type { EventDraft } from '../domain/registration.js';
import type { OpenWarning } from './create-production.js';
import { notFound, partnerAdminRequired, productionSuspended } from './problems.js';
import { assertDraft, assertOpenSlot } from './schedule-checks.js';

export interface EventAdded {
  eventId: string;
  pending: boolean;
  warnings: OpenWarning[];
}

@Injectable()
export class AddProductionEvent {
  constructor(
    @Inject(CATALOG_REPOSITORY) private readonly repo: CatalogRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(c: { tenantId: string; role: string; productionId: string; input: EventDraft; once: RequestOnce }): Promise<EventAdded> {
    return this.repo.registerOnce(c.once, c.tenantId, async (tx) => {
      const p = await tx.productionForUpdate(c.productionId, c.tenantId);
      if (!p) throw notFound();
      if (p.saleReview === 'SUSPENDED') throw productionSuspended();
      const approvedBefore = p.saleApprovedAt !== null;
      if (approvedBefore && c.role !== 'partner_admin') throw partnerAdminRequired();
      const now = new Date(this.clock.now());
      assertDraft(c.input, 0, now);
      await assertOpenSlot(tx, c.input, 0, p.id);
      const eventId = uuidv7(this.clock);
      if (!approvedBefore) {
        await tx.insertEvent(p.id, p.promoterId, p.venueId, { ...c.input, id: eventId });
        return { eventId, pending: false, warnings: [] };
      }
      await tx.savePending(p.id, [...p.pendingEvents, { ...c.input, eventId, addedAt: now }], p.saleReview === 'APPROVED' ? 'SUBMITTED' : p.saleReview);
      return { eventId, pending: true, warnings: [] };
    });
  }
}
