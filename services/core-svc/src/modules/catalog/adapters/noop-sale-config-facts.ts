// 좌석맵 판·결제사 상한을 아직 싣지 않는 첫 구현(판매 승인 LCH-080). 값이 없으면 EventSaleConfig의 선택 칸을 뺀다.
import type { EventSaleConfigFacts } from '../domain/event-sale-config.js';
import type { SaleConfigFactsSource } from '../domain/sale-config-ports.js';

export class NoopSaleConfigFacts implements SaleConfigFactsSource {
  async of(_eventIds: readonly string[]): Promise<Map<string, EventSaleConfigFacts>> {
    return new Map();
  }
}
