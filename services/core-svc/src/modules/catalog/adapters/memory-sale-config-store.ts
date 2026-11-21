// 시험·로컬용 회차 판매 설정 저장소. 운영은 대기열 Redis와 core DB 두 곳에 쓴다.
import type { EventSaleConfig } from '../domain/event-sale-config.js';
import { ONSALE_WINDOW_END_MS, type DueEventConfig, type OnsaleClosedEvent, type SaleConfigStore } from '../domain/sale-config-ports.js';

export class MemorySaleConfigStore implements SaleConfigStore {
  readonly configs = new Map<string, EventSaleConfig>();
  readonly admission = new Map<string, number>();

  async put(configs: readonly EventSaleConfig[], admission: readonly { eventId: string; startsAtMs: number }[]): Promise<void> {
    for (const c of configs) this.configs.set(c.eventId, structuredClone(c));
    for (const a of admission) this.admission.set(a.eventId, a.startsAtMs);
  }

  async get(eventId: string): Promise<EventSaleConfig | undefined> {
    const c = this.configs.get(eventId);
    return c ? structuredClone(c) : undefined;
  }

  async listEndedBefore(through: Date, limit: number): Promise<DueEventConfig[]> {
    return [...this.configs.values()]
      .filter((c): c is EventSaleConfig & { endsAtMs: number } => typeof c.endsAtMs === 'number' && c.endsAtMs <= through.getTime())
      .sort((a, b) => a.eventId.localeCompare(b.eventId))
      .slice(0, limit)
      .map((c) => ({ eventId: c.eventId, promoterId: c.promoterId, endsAt: new Date(c.endsAtMs) }));
  }

  async listOnsaleClosed(from: Date, to: Date, limit: number): Promise<OnsaleClosedEvent[]> {
    return [...this.configs.values()]
      .map((c) => ({ eventId: c.eventId, closedAtMs: c.opensAtMs + ONSALE_WINDOW_END_MS }))
      .filter((c) => c.closedAtMs >= from.getTime() && c.closedAtMs < to.getTime())
      .sort((a, b) => a.closedAtMs - b.closedAtMs || a.eventId.localeCompare(b.eventId))
      .slice(0, limit)
      .map((c) => ({ eventId: c.eventId, closedAt: new Date(c.closedAtMs) }));
  }

  async commissionRateBp(eventId: string): Promise<number | undefined> {
    return this.configs.get(eventId)?.commissionRateBp;
  }
}
