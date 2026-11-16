// 일괄 환불 항목의 주문 단위 잡기·조건부 끝내기(웨이브 끝 리뷰 K2, transfer-refund §5 '일괄 환불 항목의 주인과 겹침 막기', 빈 뼈대).
// event_refund_item.claim_token·claimed_until(0025)을 쓴다.
import type { Database } from '@peaket/platform';
import type { EventRefundClaims } from '../../domain/event-refund-ports.js';

export class DrizzleEventRefundClaims implements EventRefundClaims {
  constructor(private readonly database: Database) {}

  async claimOrders(_requestId: string, _nowMs: number, _limitOrders: number): ReturnType<EventRefundClaims['claimOrders']> {
    void this.database;
    throw new Error('아직 없음');
  }

  async finish(_q: Parameters<EventRefundClaims['finish']>[0]): Promise<boolean> {
    throw new Error('아직 없음');
  }

  async release(_requestId: string, _claimToken: string): Promise<void> {
    throw new Error('아직 없음');
  }
}
