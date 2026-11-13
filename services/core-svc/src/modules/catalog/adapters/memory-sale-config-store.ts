// 시험·로컬용 회차 판매 설정 저장소. 운영은 대기열 Redis와 core DB 두 곳에 쓴다.
import type { EventSaleConfig } from '../domain/event-sale-config.js';
import type { SaleConfigStore } from '../domain/sale-config-ports.js';

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
}
