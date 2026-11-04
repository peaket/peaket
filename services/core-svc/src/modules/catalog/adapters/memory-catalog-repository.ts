// 메모리 저장소(시험·로컬). 운영은 Drizzle 저장소다.
import type { CatalogRepository, EventSummaryRow } from '../domain/ports.js';
import type { CatalogEvent, Production } from '../domain/production.js';

export class MemoryCatalogRepository implements CatalogRepository {
  readonly productions = new Map<string, Production>();
  readonly events = new Map<string, CatalogEvent>();
  readonly sellerNames = new Map<string, string>();

  async findEventSummary(eventId: string): Promise<EventSummaryRow | undefined> {
    const event = this.events.get(eventId);
    const production = event && this.productions.get(event.productionId);
    const sellerName = production && this.sellerNames.get(production.promoterId);
    return event && production && sellerName !== undefined ? { event, production, sellerName } : undefined;
  }
}
