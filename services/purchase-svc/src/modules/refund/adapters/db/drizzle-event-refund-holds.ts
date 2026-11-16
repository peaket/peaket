// 회차 취소 요청 중 보류 취소의 환급 미룸 저장소(BAT-420 몫 D, docs/data.md event_refund_hold, 빈 뼈대).
import type { Database } from '@peaket/platform';
import type { EventRefundHoldInput, EventRefundHoldState } from '../../domain/event-refund-hold.js';
import type { EventRefundHolds } from '../../domain/event-refund-ports.js';

export class DrizzleEventRefundHolds implements EventRefundHolds {
  constructor(private readonly database: Database) {}

  async set(_i: EventRefundHoldInput): Promise<EventRefundHoldState> {
    void this.database;
    throw new Error('아직 없음');
  }

  async releaseExpired(_nowMs: number, _limit: number): Promise<readonly { eventId: string; cancellationRequestId: string }[]> {
    throw new Error('아직 없음');
  }
}
