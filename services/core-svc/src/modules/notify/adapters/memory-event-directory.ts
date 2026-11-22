// BAT-455 메모리 회차 정보(단위·HTTP 시험). MemoryCatalogRepository의 events·productions를 읽는다.
import type { MemoryCatalogRepository } from '../../catalog/index.js';
import type { NotificationEventDirectory, NotifyEvent } from '../domain/fan-notify-ports.js';

export class MemoryNotificationEventDirectory implements NotificationEventDirectory {
  constructor(private readonly repo: MemoryCatalogRepository) {}

  async find(eventId: string): Promise<NotifyEvent | undefined> {
    const e = this.repo.events.get(eventId);
    if (!e) return undefined;
    const p = this.repo.productions.get(e.productionId);
    if (!p) return undefined;
    return {
      eventId: e.id,
      productionId: e.productionId,
      openAt: e.openAt,
      startsAt: e.startsAt,
      saleReview: p.saleReview,
      saleApprovedAt: p.saleApprovedAt ?? null,
    };
  }
}
