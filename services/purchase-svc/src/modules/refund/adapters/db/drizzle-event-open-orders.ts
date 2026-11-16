// 회차의 끝나지 않은 주문 수(BAT-420 GAT-110 H, R-T37 ⑥, ADR-0280 결정 5, 빈 뼈대).
import type { Database } from '@peaket/platform';
import type { EventOpenOrders } from '../../domain/event-refund-ports.js';

export class DrizzleEventOpenOrders implements EventOpenOrders {
  constructor(private readonly database: Database) {}

  async count(_eventId: string): Promise<number> {
    void this.database;
    throw new Error('아직 없음');
  }
}
