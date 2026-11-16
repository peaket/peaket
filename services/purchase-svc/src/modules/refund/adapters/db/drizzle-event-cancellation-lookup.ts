// 확정된 회차 취소 찾기(BAT-420 리뷰 D5, docs/features/transfer-refund.md §5 '확정 뒤 팬 취소').
// 그 회차에 kind CANCEL·status RUNNING·PAUSED·COMPLETED인 event_cancellation_request가 하나라도 있으면 참이다.
// 판정 중(REQUESTED·JUDGED·PENDING_APPROVAL)·APPROVED·반려(REJECTED)·연기(POSTPONE)는 거짓이다(판정 중 보류 취소는 지금처럼 남고, 연기는 팬 취소를 막지 않는다).
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { EventCancellationLookup } from '../../domain/ports.js';

export class DrizzleEventCancellationLookup implements EventCancellationLookup {
  constructor(private readonly database: Database) {}

  async confirmed(eventId: string): Promise<boolean> {
    const r = await this.database.db.execute(sql`
      select 1 from event_cancellation_request
       where event_id = ${eventId}::uuid and kind = 'CANCEL' and status in ('RUNNING', 'PAUSED', 'COMPLETED')
       limit 1`);
    return r.rows.length > 0;
  }
}
