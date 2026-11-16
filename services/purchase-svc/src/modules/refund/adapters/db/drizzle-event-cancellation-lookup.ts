// 확정된 회차 취소 찾기(BAT-420 리뷰 D5, docs/features/transfer-refund.md §5 '확정 뒤 팬 취소', 빈 뼈대).
// 그 회차에 kind CANCEL·status RUNNING·PAUSED·COMPLETED인 event_cancellation_request가 있으면 참이다.
import type { Database } from '@peaket/platform';
import type { EventCancellationLookup } from '../../domain/ports.js';

export class DrizzleEventCancellationLookup implements EventCancellationLookup {
  constructor(private readonly database: Database) {}

  async confirmed(_eventId: string): Promise<boolean> {
    void this.database;
    throw new Error('아직 없음');
  }
}
