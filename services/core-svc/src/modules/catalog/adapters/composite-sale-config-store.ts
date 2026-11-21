// 회차 판매 설정을 core DB와 대기열 Redis 두 곳에 함께 쓰는 어댑터(판매 승인 LCH-080).
// 둘 중 하나가 실패하면 던져 승인 쪽이 다시 하게 한다. 같은 값을 다시 써도 결과가 같다.
import type { EventSaleConfig } from '../domain/event-sale-config.js';
import type { DueEventConfig, OnsaleClosedEvent, SaleConfigStore } from '../domain/sale-config-ports.js';

export class CompositeSaleConfigStore implements SaleConfigStore {
  constructor(
    private readonly db: SaleConfigStore,
    private readonly queue: SaleConfigStore,
  ) {}

  async put(configs: readonly EventSaleConfig[], admission: readonly { eventId: string; startsAtMs: number }[]): Promise<void> {
    await this.db.put(configs, admission);
    await this.queue.put(configs, admission);
  }

  get(eventId: string): Promise<EventSaleConfig | undefined> {
    return this.db.get(eventId);
  }

  listEndedBefore(through: Date, limit: number): Promise<DueEventConfig[]> {
    return this.db.listEndedBefore(through, limit);
  }

  commissionRateBp(eventId: string): Promise<number | undefined> {
    return this.db.commissionRateBp(eventId);
  }

  /** 끝난 회차 목록은 core DB 사본이 원천이다(대기열 사본은 보지 않는다) */
  async listOnsaleClosed(from: Date, to: Date, limit: number): Promise<OnsaleClosedEvent[]> {
    if (!this.db.listOnsaleClosed) throw new Error('core DB 판매 설정 사본이 끝난 회차 목록을 주지 않는다');
    return this.db.listOnsaleClosed(from, to, limit);
  }
}
